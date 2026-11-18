const { OpenClawManagementError } = require("./shared.cjs");

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const LOCATION_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CHANNELS = ["stable", "extended-stable", "beta", "dev"];
const INSTALL_KINDS = ["package", "git", "immutable", "unknown"];
const RUN_PHASES = ["requested", "staging", "validating", "repairing", "activating", "restarting", "verifying", "finished"];
const RUN_RESULTS = ["succeeded", "failed", "rolled-back", "skipped"];
const BACKUP_KINDS = ["archive", "sqlite-snapshot", "git", "external"];
const LOCATION_STATES = ["ok", "unavailable", "uninitialized", "wrong-key", "error"];
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const PROBLEM_LEVELS = ["warn", "error", "fatal"];
const LOG_TAIL = { limit: 500, maxBytes: 250000 };
const LOG_ENTRIES = 60;
const LOG_TEXT = 300;
const LOG_SOURCE = 48;
const PROVIDER_TEXT = 40;
const BACKUP_LIMIT = 20;
const LOCATION_LIMIT = 8;
const RECEIPT_LIMIT = 16;

const UPDATE_RACE_MS = 10000;
const PROBE_RACE_MS = 5000;
const UPDATE_NOTE = "Requested from OcuClaw settings";
const TIMED_OUT = Symbol("timed-out");

const UPDATE_REASONS      = {
  owner_required: "not_allowed",
  "restart-disabled": "restart_disabled",
  "not-openclaw-root": "managed_elsewhere",
  "unmanaged-package-install": "managed_elsewhere",
  "container-image-install": "managed_elsewhere",
  "external-supervisor-update-required": "managed_elsewhere",
  unsupported_git_channel: "unsupported_install",
  "unsupported-update-target": "unsupported_install",
  "managed-service-handoff-already-running": "already_running",
  "update-campaign-applying": "already_running",
  "restart-unavailable": "unavailable",
  "managed-service-handoff-unavailable": "unavailable",
};

const STORE_KEY = Symbol.for("ocuclaw.openclaw-management.maintenance");

function processStore() {
  const holder      = globalThis;
  if (!holder[STORE_KEY]) holder[STORE_KEY] = { receipts: new Map(), lastUpdate: null, updateInFlight: false };
  return holder[STORE_KEY];
}

function record(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value     ) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function intOrNull(value     ) {
  return typeof value === "number" && Number.isSafeInteger(Math.trunc(value)) && value >= 0 ? Math.trunc(value) : null;
}

function timeMs(value     ) {
  if (typeof value === "number") return intOrNull(value);
  if (typeof value !== "string" || !value) return null;
  return intOrNull(Date.parse(value));
}

function version(value     ) {
  return typeof value === "string" && VERSION.test(value) ? value : null;
}

function oneOf(list     , value     ) {
  return list.includes(value) ? value : null;
}

function cut(text     , limit     ) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
}

function label(value     , limit     ) {
  if (typeof value !== "string") return null;
  const clean = cut(value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), limit).trim();
  return clean || null;
}

function logText(value     ) {
  const masked = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(Bearer)\s+[^\s"',;]+/gi, "$1 …")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, "…")
    .replace(/[A-Za-z0-9_+\/=-]{32,}/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return cut(masked, LOG_TEXT);
}

async function optionalCall(ctx     , method     , params     ) {
  try {
    return await ctx.call(method, params);
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && ctx.connected()) return null;
    throw error;
  }
}

function hostCodeOf(error     ) {
  return typeof error?.hostCode === "string" ? error.hostCode : "";
}

function race(promise     , ms     ) {
  let timer      = null;
  const timeout = new Promise((resolve     ) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function configOf(reply     ) {
  if (record(reply?.config)) return reply.config;
  if (record(reply?.parsed)) return reply.parsed;
  return null;
}

function coldStorageFrom(config     ) {
  return record(config) ? config?.session?.maintenance?.coldStorage?.enabled === true : null;
}

function messageOf(parsed     , meta     ) {
  if (typeof parsed.message === "string") return parsed.message;
  const parts      = [];
  for (const key of Object.keys(parsed)) {
    if (!/^\d+$/.test(key)) continue;
    const item = parsed[key];
    if (key === "0" && typeof item === "string" && (item === meta?.name || contextOf(item))) continue;
    if (typeof item === "string") parts.push(item);
    else if (item != null) parts.push(JSON.stringify(item));
  }
  return parts.join(" ");
}

function contextOf(raw     ) {
  if (typeof raw !== "string" || !raw.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function logEntry(line     ) {
  if (typeof line !== "string" || !line.trim()) return null;
  let parsed      = null;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  if (!record(parsed)) return { atMs: null, level: null, source: null, text: logText(line) };
  const meta = record(parsed._meta) ? parsed._meta : {};
  const context = contextOf(meta.name) || contextOf(parsed["0"]) || {};
  const levelRaw = typeof meta.logLevelName === "string" ? meta.logLevelName : parsed.level;
  const level = typeof levelRaw === "string" ? oneOf(LOG_LEVELS, levelRaw.toLowerCase()) : null;
  const source = label(context.subsystem, LOG_SOURCE) || label(parsed.subsystem, LOG_SOURCE)
    || label(context.plugin, LOG_SOURCE) || label(context.module, LOG_SOURCE)
    || (contextOf(meta.name) ? null : label(meta.name, LOG_SOURCE));
  return {
    atMs: timeMs(parsed.time) ?? timeMs(meta.date),
    level,
    source,
    text: logText(messageOf(parsed, meta)),
  };
}

function logsFrom(reply     , filter     ) {
  const lines = Array.isArray(reply?.lines) ? reply.lines : [];
  const entries      = [];
  let matched = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = logEntry(lines[i]);
    if (!entry) continue;
    if (filter === "problems" && !PROBLEM_LEVELS.includes(entry.level)) continue;
    matched += 1;
    if (entries.length < LOG_ENTRIES) entries.push(entry);
  }
  return { filter, truncated: reply?.truncated === true || matched > LOG_ENTRIES, entries };
}

function receiptView(receipt     ) {
  if (!receipt) return null;
  const view      = {
    operationId: receipt.operationId, kind: receipt.kind, outcome: receipt.outcome,
    reason: receipt.reason, atMs: receipt.atMs,
  };
  if (receipt.kind === "update") Object.assign(view, { fromVersion: receipt.fromVersion, toVersion: receipt.toVersion });
  if (receipt.cleanup) view.cleanup = { ...receipt.cleanup };
  return view;
}

function updateFrom(reply     , hostVersion     , request     ) {
  if (!record(reply)) return null;
  const available = record(reply.updateAvailable) ? reply.updateAvailable : null;
  const schedule = record(reply.schedule) ? reply.schedule : {};
  const active = record(reply.activeRun) ? reply.activeRun : null;
  const last = record(reply.lastRun) && reply.lastRun.status !== "running" ? reply.lastRun : null;
  const latestVersion = available ? version(available.latestVersion) : null;
  const running = active && oneOf(RUN_PHASES, active.phase) && timeMs(active.createdAtMs) !== null
    ? { phase: active.phase, startedAtMs: timeMs(active.createdAtMs) } : null;
  return {
    currentVersion: version(available?.currentVersion) ?? version(hostVersion),
    latestVersion,
    updateAvailable: Boolean(latestVersion),
    channel: oneOf(CHANNELS, reply.effectiveChannel) ?? oneOf(CHANNELS, schedule.channel),
    installKind: oneOf(INSTALL_KINDS, schedule.install?.kind),
    autoUpdate: typeof schedule.autoEnabled === "boolean" ? schedule.autoEnabled : null,
    running,
    last: last && oneOf(RUN_RESULTS, last.status) ? {
      status: last.status,
      finishedAtMs: timeMs(last.finishedAtMs),
      fromVersion: version(last.before?.version),
      toVersion: version(last.after?.version) ?? version(last.target?.version),
    } : null,
    request: receiptView(request),
  };
}

function sessionsFrom(reply     , coldStorage     ) {
  if (!record(reply) || !Array.isArray(reply.agents)) return null;
  const sum = (key     ) => reply.agents.reduce((total     , row     ) => total + count(row?.[key]), 0);
  const maintenance = record(reply.maintenance) ? reply.maintenance : {};
  return {
    agents: reply.agents.length,
    hotTranscripts: sum("hotTranscripts"),
    coldTranscripts: sum("coldTranscripts"),
    databaseBytes: sum("databaseBytes") + sum("walBytes"),
    archiveBytes: sum("archiveBytes") + sum("embeddedArchiveBytes"),
    coldStorage,
    archiving: maintenance.running === true,
    lastArchivedAtMs: timeMs(maintenance.lastCompletedAt),
    archiveFailed: maintenance.lastError != null,
  };
}

function backupsFrom(reply     ) {
  if (!record(reply) || !Array.isArray(reply.targets)) return null;
  return reply.targets.filter((row     ) => record(row) && BACKUP_KINDS.includes(row.kind)).slice(0, BACKUP_LIMIT)
    .map((row     ) => {
      const latest = record(row.latest) ? row.latest : null;
      return {
        kind: row.kind,
        status: latest?.status === "ok" ? "ok" : latest?.status === "failed" ? "failed" : "none",
        atMs: timeMs(latest?.createdAt),
        bytes: intOrNull(latest?.bytes),
      };
    });
}

function createMaintenanceSection(opts      = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const updateRaceMs = typeof opts.updateRaceMs === "number" ? opts.updateRaceMs : UPDATE_RACE_MS;
  const probeRaceMs = typeof opts.probeRaceMs === "number" ? opts.probeRaceMs : PROBE_RACE_MS;
  const store = opts.store || processStore();

  function remember(receipt     ) {
    store.receipts.set(receipt.operationId, receipt);
    while (store.receipts.size > RECEIPT_LIMIT) store.receipts.delete(store.receipts.keys().next().value);
  }

  const answer = (receipt     ) => ({ status: "ok", maintenance: { receipt: receiptView(receipt) } });

  function replay(payload     , kind     ) {
    const prior = store.receipts.get(payload.operationId);
    if (!prior) return null;
    return prior.kind === kind ? answer(prior) : { status: "error", errorCode: "invalid_request" };
  }

  function failed(receipt     , error     , reason     ) {
    if (!(error instanceof OpenClawManagementError)) throw error;
    if (error.code === "management_unavailable") {
      if (hostCodeOf(error)) Object.assign(receipt, { outcome: "refused", reason });
      return answer(receipt);
    }
    Object.assign(receipt, { outcome: "refused", reason: "unavailable" });
    if (error.code === "unsupported") return { status: "unsupported" };
    return { status: "error", errorCode: error.code };
  }

  async function coldStorage(ctx     ) {
    if (!ctx.advertises("config.get")) return null;
    return coldStorageFrom(configOf(await optionalCall(ctx, "config.get", {})));
  }

  async function locations(ctx     ) {
    if (!ctx.advertises("storage.locations.list")) return null;
    const reply      = await optionalCall(ctx, "storage.locations.list", {});
    if (!record(reply) || !Array.isArray(reply.locations)) return null;
    const rows = reply.locations.filter((row     ) => record(row) && typeof row.name === "string" && LOCATION_NAME.test(row.name)
      && label(row.provider, PROVIDER_TEXT)).slice(0, LOCATION_LIMIT);
    return Promise.all(rows.map(async (row     ) => {
      const probe      = ctx.advertises("storage.locations.probe")
        ? await race(optionalCall(ctx, "storage.locations.probe", { name: row.name }), probeRaceMs) : null;
      const known = record(probe) && LOCATION_STATES.includes(probe.state);
      return {
        name: row.name,
        provider: label(row.provider, PROVIDER_TEXT),
        encrypted: row.encrypted === true,

        state: known ? probe.state : "error",
        freeBytes: known ? intOrNull(probe.freeBytes) : null,
        totalBytes: known ? intOrNull(probe.totalBytes) : null,
      };
    }));
  }

  async function snapshot(ctx     ) {
    const advertised = (method     , params      = {}) => ctx.advertises(method) ? optionalCall(ctx, method, params) : null;
    const storageOn = ctx.advertises("sessions.storage.status");
    const [update, storage, cold, backup, places] = await Promise.all([
      advertised("update.status"),
      advertised("sessions.storage.status"),
      storageOn ? coldStorage(ctx) : null,
      advertised("backup.status"),
      locations(ctx),
    ]);
    return {
      status: "ok",
      maintenance: {
        snapshot: {
          observedAtMs: now(),
          update: updateFrom(update, ctx.hostVersion(), store.lastUpdate),
          sessions: sessionsFrom(storage, cold),
          backups: backupsFrom(backup),
          locations: places,
        },
      },
    };
  }

  async function logs(ctx     , payload     ) {
    const reply      = await ctx.call("logs.tail", { ...LOG_TAIL });
    return { status: "ok", maintenance: { logs: logsFrom(reply, payload.filter) } };
  }

  async function update(ctx     , payload     ) {
    const prior = replay(payload, "update");
    if (prior) return prior;
    const status      = await ctx.call("update.status", {});
    const available = record(status?.updateAvailable) ? status.updateAvailable : null;
    if (!available || available.latestVersion !== payload.expectVersion) return { status: "error", errorCode: "stale_preview" };
    const receipt      = {
      operationId: payload.operationId, kind: "update", outcome: "unknown", reason: null, atMs: now(),
      fromVersion: version(available.currentVersion) ?? version(ctx.hostVersion()), toVersion: payload.expectVersion,
    };
    remember(receipt);

    if (status.activeRun || store.updateInFlight) {
      Object.assign(receipt, { outcome: "refused", reason: "already_running" });
      return answer(receipt);
    }

    store.lastUpdate = receipt;
    store.updateInFlight = true;
    let timedOut = false;
    const settled = ctx.call("update.run", { note: UPDATE_NOTE }).then((reply     ) => {
      if (reply?.ok === true) Object.assign(receipt, { outcome: "started", reason: null });
      else if (reply?.ok === false) {
        const native = reply.result?.reason ?? reply.code;
        Object.assign(receipt, { outcome: "refused", reason: UPDATE_REASONS[native] || "failed" });
      }
      return answer(receipt);
    }, (error     ) => {

      if (timedOut && error instanceof OpenClawManagementError && error.code === "management_unavailable" && !hostCodeOf(error)) {
        return answer(receipt);
      }
      return failed(receipt, error, "managed_elsewhere");
    }).finally(() => { store.updateInFlight = false; });
    const result      = await race(settled, updateRaceMs);
    if (result !== TIMED_OUT) return result;
    timedOut = true;
    if (receipt.outcome === "unknown") receipt.outcome = "started";

    settled.catch(() => {});
    return answer(receipt);
  }

  async function cleanup(ctx     , payload     ) {
    const prior = replay(payload, "cleanup");
    if (prior) return prior;
    const receipt      = { operationId: payload.operationId, kind: "cleanup", outcome: "unknown", reason: null, atMs: now() };
    remember(receipt);
    let reply     ;
    try {
      reply = await ctx.call("sessions.cleanup", { allAgents: true });
    } catch (error     ) {
      return failed(receipt, error, "failed");
    }
    const stores = (Array.isArray(reply?.stores) ? reply.stores : [reply])
      .filter((row     ) => record(row) && typeof row.beforeCount === "number" && typeof row.afterCount === "number");
    if (stores.length === 0) return answer(receipt);
    const sum = (pick     ) => stores.reduce((total     , row     ) => total + count(pick(row)), 0);
    receipt.outcome = "done";
    receipt.cleanup = {
      sessionsBefore: sum((row     ) => row.beforeCount),
      sessionsAfter: sum((row     ) => row.afterCount),
      freedBytes: sum((row     ) => row.unreferencedArtifacts?.freedBytes) + sum((row     ) => row.diskBudget?.freedBytes),
    };
    return answer(receipt);
  }

  async function archive(ctx     , payload     ) {
    const prior = replay(payload, "archive");
    if (prior) return prior;
    const receipt      = { operationId: payload.operationId, kind: "archive", outcome: "unknown", reason: null, atMs: now() };
    remember(receipt);
    try {
      await ctx.call("sessions.storage.run", {});
    } catch (error     ) {
      let reason = "failed";
      if (error instanceof OpenClawManagementError && hostCodeOf(error)) {
        try { if ((await coldStorage(ctx)) === false) reason = "cold_storage_off"; } catch { reason = "failed"; }
      }
      return failed(receipt, error, reason);
    }

    receipt.outcome = "started";
    return answer(receipt);
  }

  return {
    id: "maintenance",
    operations: [
      { operation: "maintenance.read", scope: "gateway" },
      { operation: "maintenance.logs", scope: "gateway" },
      { operation: "maintenance.update", scope: "gateway" },
      { operation: "maintenance.cleanup", scope: "gateway" },
      { operation: "maintenance.archive", scope: "gateway" },
    ],
    supports(ctx     , operation     ) {
      switch (operation) {
        case "maintenance.read":
          return ["update.status", "sessions.storage.status", "backup.status", "storage.locations.list"]
            .some((method     ) => ctx.advertises(method));
        case "maintenance.logs": return ctx.advertises("logs.tail");
        case "maintenance.update": return ctx.advertisesAll("update.status", "update.run");
        case "maintenance.cleanup": return ctx.advertises("sessions.cleanup");
        case "maintenance.archive": return ctx.advertisesAll("sessions.storage.status", "sessions.storage.run");
        default: return false;
      }
    },
    async handle(env     , request     ) {
      const { ctx } = env;
      if (!ctx.connected()) throw new OpenClawManagementError("management_unavailable");
      const payload = record(request.maintenance) ? request.maintenance : {};
      switch (request.operation) {
        case "maintenance.read": return snapshot(ctx);
        case "maintenance.logs": return logs(ctx, payload);
        case "maintenance.update": return update(ctx, payload);
        case "maintenance.cleanup": return cleanup(ctx, payload);
        case "maintenance.archive": return archive(ctx, payload);
        default: throw new OpenClawManagementError("unsupported");
      }
    },
  };
}

const maintenanceSection = createMaintenanceSection();

module.exports = { logText, logEntry, logsFrom, updateFrom, sessionsFrom, backupsFrom, createMaintenanceSection, maintenanceSection };
