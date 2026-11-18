const { createHash, randomBytes } = require("node:crypto");
const { statfs } = require("node:fs/promises");
const { homedir } = require("node:os");
const { OpenClawManagementError } = require("./shared.cjs");
const { agentJobIds } = require("./jobs.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const MODEL_ID = /^[A-Za-z0-9_.:/@+ -]{1,160}$/;

const SAFE_RESTART_DRAIN_SECONDS = 300;
const RECEIPT_LIMIT = 16;
const CRON_RUNS_PAGE = 200;
const CRON_RUNS_PAGES = 5;

const STORE_KEY = Symbol.for("ocuclaw.openclaw-management.restart");

function processStore() {
  const holder      = globalThis;
  if (!holder[STORE_KEY]) {
    holder[STORE_KEY] = { gatewayId: randomBytes(16).toString("base64url"), receipts: new Map() };
  }
  return holder[STORE_KEY];
}

function count(value     ) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function shortHash(value     ) {
  return createHash("sha256").update(value).digest("base64url").slice(0, 32);
}

function safeName(value     ) {
  return typeof value === "string" && value.trim() && value.length <= 256 && !/[\u0000-\u001f]/.test(value)
    ? value.trim() : "";
}

async function optionalCall(ctx     , method     , params     ) {
  try {
    return await ctx.call(method, params);
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && ctx.connected()) return null;
    throw error;
  }
}

async function failedJobsThisWeek(ctx     , nowMs     , agentId     ) {
  if (!ctx.advertisesAll("cron.runs", "cron.list")) return null;
  let listed     ;
  try {
    listed = await agentJobIds(ctx, agentId);
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && ctx.connected()) return null;
    throw error;
  }
  const since = nowMs - 7 * DAY_MS;
  const failed = new Set();
  let offset = 0;
  for (let page = 0; page < CRON_RUNS_PAGES; page += 1) {

    const reply      = await optionalCall(ctx, "cron.runs",
      { scope: "all", agentId, statuses: ["error"], limit: CRON_RUNS_PAGE, offset, sortDir: "desc" });
    if (!reply) return page === 0 ? null : failed.size;
    const entries = Array.isArray(reply.entries) ? reply.entries : [];
    for (const entry of entries) {
      if (count(entry?.ts) < since) return failed.size;
      if (entry?.status === "error" && listed.has(entry?.jobId)) failed.add(entry.jobId);
    }
    if (reply.hasMore !== true || entries.length === 0) return failed.size;
    offset = typeof reply.nextOffset === "number" ? reply.nextOffset : offset + entries.length;
  }
  return failed.size;
}

async function providerProblems(ctx     ) {
  if (!ctx.advertises("models.authStatus")) return null;
  const reply      = await optionalCall(ctx, "models.authStatus", {});
  if (!reply || reply.unavailable || !Array.isArray(reply.providers)) return null;
  return reply.providers.filter((row     ) => ["expired", "missing"].includes(row?.status)).length;
}

function openclawStatePath() {
  return process.env.OPENCLAW_STATE_DIR || homedir();
}

const hostStatfs = statfs;

async function diskFreeBytes(readStatfs     , path     ) {
  try {
    const stats      = await readStatfs(path);
    const free = Number(stats?.bavail) * Number(stats?.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

function accountingRow(totals     , records     ) {
  const all = Math.max(0, Math.trunc(count(records)));
  const unpriced = Math.min(all, Math.max(0, Math.trunc(count(totals?.missingCostEntries))));
  const cost = count(totals?.totalCost);
  return {
    input: count(totals?.input),
    output: count(totals?.output),
    records: all,
    actualRecords: 0,
    estimatedRecords: all - unpriced,
    actual: null,
    estimated: cost > 0 || all - unpriced > 0 ? cost : null,
  };
}

function modelName(row     ) {
  const name = [safeName(row?.provider), safeName(row?.model)].filter(Boolean).join("/");
  return MODEL_ID.test(name) ? name : "redacted-model";
}

function usageFromSessions(reply     , periodDays     , nowMs     ) {
  const rows = Array.isArray(reply?.aggregates?.byModel) ? reply.aggregates.byModel : [];
  const counted = rows.reduce((sum     , row     ) => sum + Math.trunc(count(row?.count)), 0);

  const records = Math.max(counted, Math.trunc(count(reply?.aggregates?.messages?.assistant)));
  return {
    observedAt: nowMs, source: "native_session_accounting", window: "session_start", periodDays,
    auxiliary: "unknown", truncated: rows.length > 100,
    totals: accountingRow(reply?.totals, records),
    models: rows.slice(0, 100).map((row     ) => ({ ...accountingRow(row?.totals, row?.count), model: modelName(row) })),
  };
}

function usageFromCost(reply     , periodDays     , nowMs     ) {
  return {
    observedAt: nowMs, source: "native_session_accounting", window: "session_start", periodDays,
    auxiliary: "unknown", truncated: false,
    totals: accountingRow(reply?.totals, 0),
    models: [],
  };
}

async function servedScope(env     ) {
  const agents = await env.agents();
  const ids = agents.map((row     ) => row.id).sort();
  return {
    names: agents.map((row     ) => safeName(row.name) || row.id).slice(0, 128),
    revision: shortHash(`openclaw-agents:${ids.join("\n")}`),
  };
}

function restartSupported(ctx     ) {
  return ctx.advertises("gateway.restart.request") && TOKEN.test(ctx.bootId() || "");
}

function createHealthSection(opts      = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const readStatfs = typeof opts.statfs === "function" ? opts.statfs : statfs;
  const statePath = typeof opts.statePath === "string" ? opts.statePath
    : openclawStatePath();
  const store = opts.store || processStore();

  function rememberReceipt(receipt     ) {
    store.receipts.set(receipt.operationId, receipt);
    while (store.receipts.size > RECEIPT_LIMIT) store.receipts.delete(store.receipts.keys().next().value);
  }

  async function restartView(env     , receipt      = null) {
    const { ctx } = env;
    const scope = await servedScope(env);
    const bootId = ctx.bootId();

    const pending = [...store.receipts.values()].some((row     ) => row.oldBootId === bootId && row.phase === "accepted");
    let activeWork = 0;
    const preflight      = ctx.advertises("gateway.restart.preflight")
      ? await optionalCall(ctx, "gateway.restart.preflight", {}) : null;
    if (preflight) activeWork = Math.trunc(count(preflight?.counts?.totalActive));
    const restart      = {
      gatewayId: store.gatewayId,
      bootId,
      scopeRevision: scope.revision,
      affectedProfiles: scope.names,
      phase: pending ? "draining" : "ready",
      supported: restartSupported(ctx),
      activeWork,
      waitSeconds: 0,
      drainSeconds: activeWork > 0 ? SAFE_RESTART_DRAIN_SECONDS : 0,
    };
    if (receipt) {
      restart.receipt = {
        operationId: receipt.operationId,
        gatewayId: receipt.gatewayId,
        oldBootId: receipt.oldBootId,
        scopeRevision: receipt.scopeRevision,
        phase: receipt.phase,
      };
    }
    return restart;
  }

  async function restartRequest(env     , payload     ) {
    const { ctx } = env;
    if (store.receipts.has(payload.operationId)) return { status: "error", errorCode: "operation_conflict" };
    const scope = await servedScope(env);
    if (payload.gatewayId !== store.gatewayId || payload.bootId !== ctx.bootId()) {
      return { status: "error", errorCode: "gateway_changed" };
    }
    if (payload.scopeRevision !== scope.revision) return { status: "error", errorCode: "stale_preview" };
    if ([...store.receipts.values()].some((row     ) => row.oldBootId === payload.bootId && row.phase === "accepted")) {
      return { status: "error", errorCode: "already_draining" };
    }
    const receipt      = {
      operationId: payload.operationId,
      gatewayId: store.gatewayId,
      oldBootId: payload.bootId,
      scopeRevision: scope.revision,
      phase: "unconfirmed",
    };

    rememberReceipt(receipt);
    let reply     ;
    try {
      reply = await ctx.call("gateway.restart.request", { reason: "Requested from OcuClaw settings" });
    } catch (error     ) {
      if (error instanceof OpenClawManagementError && error.code === "unsupported") {
        receipt.phase = "rejected";
        return { status: "unsupported" };
      }
      throw error;
    }
    receipt.phase = reply?.ok === true && ["scheduled", "deferred", "coalesced"].includes(reply.status) ? "accepted" : "rejected";
    return { status: "ok", restart: await restartView(env, receipt) };
  }

  async function restartStatus(env     , payload     ) {
    const { ctx } = env;
    const receipt = payload.gatewayId === store.gatewayId ? store.receipts.get(payload.operationId) : null;
    if (!receipt) return { status: "error", errorCode: "gateway_changed" };
    const bootId = ctx.bootId();
    if (receipt.phase === "accepted" && bootId && bootId !== receipt.oldBootId) receipt.phase = "recovered";
    return { status: "ok", restart: await restartView(env, receipt) };
  }

  async function snapshot(env     , agentId     ) {
    const { ctx } = env;
    const nowMs = now();
    const [jobFailures, providerFailures, diskFree] = await Promise.all([
      failedJobsThisWeek(ctx, nowMs, agentId),
      providerProblems(ctx),
      diskFreeBytes(readStatfs, statePath),
    ]);
    return {
      status: "ok",
      health: {
        snapshot: {
          observedAt: nowMs, source: "native_gateway", gateway: "responding", provider: "unknown",
          providerFailures, jobFailures, diskFree,
        },
      },
    };
  }

  async function usage(env     , request     ) {
    const { ctx } = env;
    const periodDays = request.health?.periodDays;
    const nowMs = now();
    const range = `${periodDays}d`;

    const sessions      = await optionalCall(ctx, "sessions.usage", { agentScope: "all", range, mode: "utc", limit: 1 });
    if (sessions?.aggregates) return { status: "ok", health: { usage: usageFromSessions(sessions, periodDays, nowMs) } };
    const cost      = await ctx.call("usage.cost", { agentScope: "all", range, mode: "utc" });
    return { status: "ok", health: { usage: usageFromCost(cost, periodDays, nowMs) } };
  }

  return {
    id: "health",
    operations: [
      { operation: "health.snapshot", scope: "profile" },
      { operation: "health.usage", scope: "profile" },
      { operation: "diagnostics.status", scope: "profile" },
      { operation: "diagnostics.start", scope: "profile" },
      { operation: "diagnostics.cancel", scope: "profile" },
      { operation: "restart.preview", scope: "gateway" },
      { operation: "restart.request", scope: "gateway" },
      { operation: "restart.status", scope: "gateway" },
    ],
    supports(ctx     , operation     ) {

      if (operation === "health.snapshot") return true;
      if (operation === "health.usage") return ctx.advertises("usage.cost");
      if (operation.startsWith("restart.")) return restartSupported(ctx);
      return false;
    },
    async handle(env     , request     ) {
      const { ctx } = env;
      if (!ctx.connected()) throw new OpenClawManagementError("management_unavailable");
      const agents = await env.agents();
      if (!agents.some((row     ) => row.id === request.profileId)) return { status: "error", errorCode: "profile_not_served" };
      switch (request.operation) {
        case "health.snapshot": return snapshot(env, request.profileId);
        case "health.usage": return usage(env, request);
        case "restart.preview": return { status: "ok", restart: await restartView(env) };
        case "restart.request": return restartRequest(env, request.payload || {});
        case "restart.status": return restartStatus(env, request.payload || {});
        default: throw new OpenClawManagementError("unsupported");
      }
    },
  };
}

const healthSection = createHealthSection();

module.exports = { failedJobsThisWeek, providerProblems, openclawStatePath, hostStatfs, diskFreeBytes, usageFromSessions, usageFromCost, createHealthSection, healthSection };
