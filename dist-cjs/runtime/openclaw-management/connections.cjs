const { createHash } = require("node:crypto");
const { OpenClawManagementError } = require("./shared.cjs");

const RECEIPT_TTL_MS = 10 * 60 * 1000;
const RECEIPT_LIMIT = 64;
const ROW_LIMIT = 100;
const NAME_LIMIT = 160;

const READS = new Set(["connections.read", "connections.receipt", "mcp.testStatus", "mcp.oauthStatus"]);

function record(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revisionOf(value     ) {
  return createHash("sha256").update(JSON.stringify(value === undefined ? null : value)).digest("hex");
}

function displayName(value     ) {
  const clean = typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim() : "";
  return clean.length > NAME_LIMIT ? clean.slice(0, NAME_LIMIT).trim() : clean;
}

function effectiveState(enabled     , account     ) {
  if (enabled === false || account?.enabled === false) return "disabled";
  if (!record(account)) return "unknown";
  const lifecycle = account.lifecycle;
  if (lifecycle === "ready" || (account.running === true && account.connected === true)) return "connected";
  if (lifecycle === "recovering" || account.restartPending === true) return "retrying";
  if (lifecycle === "starting" || account.running === true) return "connecting";
  if (lifecycle === "blocked") return "failed";
  if (account.configured === false) return "not_started";

  if (lifecycle === "stopped" || account.running === false) return "paused";
  return "unknown";
}

function channelEnabledPath(channels     , channelId     , accountId     ) {
  const channel = channels?.[channelId];
  if (!record(channel)) return null;
  if (!record(channel.accounts)) return { path: [channelId], entry: channel };
  if (channel.enabled === false) return null;
  const entry = channel.accounts[accountId];
  return record(entry) ? { path: [channelId, "accounts", accountId], entry } : null;
}

function savedChannelEnabled(channels     , channelId     , accountId     ) {
  const channel = channels?.[channelId];
  if (!record(channel)) return null;
  if (channel.enabled === false) return false;
  const entry = record(channel.accounts) ? channel.accounts[accountId] : null;
  if (record(entry) && entry.enabled === false) return false;
  return true;
}

function nestedPatch(path     , leaf     ) {
  return path.reduceRight((acc     , key     ) => ({ [key]: acc }), leaf);
}

function mcpServerNames(config     ) {
  const servers = record(config?.mcp?.servers) ? config.mcp.servers : {};
  return Object.keys(servers).sort()
    .filter((key     ) => record(servers[key]) && displayName(key) === key && key !== "")
    .slice(0, ROW_LIMIT);
}

function mcpSummary(config     ) {
  return { mcp: mcpServerNames(config).length, mcpNeedsAuth: 0 };
}

async function readConnections(ctx     ) {
  const { config, hash } = await ctx.readConfig();
  const writable = ctx.advertises("config.patch") && typeof hash === "string" && hash.length > 0;
  const servers = record(config?.mcp?.servers) ? config.mcp.servers : {};
  const mcp      = [];
  for (const key of Object.keys(servers).sort()) {
    const server = servers[key];
    const name = displayName(key);
    if (!record(server) || !name || name !== key || mcp.length >= ROW_LIMIT) continue;
    const enabled = server.enabled !== false;
    mcp.push({
      name,
      enabled,

      effective: enabled ? "unknown" : "disabled",
      revision: revisionOf(server),
      writable,
      transport: typeof server.command === "string" && server.command ? "stdio" : "http",
      oauthSupported: false,
      oauthReason: "native_callback_unavailable",
      testSupported: false,
      testReason: "unsupported_transport",
      applyTiming: "new_session_or_restart",
    });
  }

  const channels      = [];
  const targets = new Map();
  if (ctx.advertises("channels.status")) {
    const status      = await ctx.call("channels.status", { probe: false });
    const savedChannels = record(config?.channels) ? config.channels : {};
    const labels = record(status?.channelLabels) ? status.channelLabels : {};
    const accounts = record(status?.channelAccounts) ? status.channelAccounts : {};
    const defaults = record(status?.channelDefaultAccountId) ? status.channelDefaultAccountId : {};
    const order = Array.isArray(status?.channelOrder) ? status.channelOrder : Object.keys(accounts);
    const ids = [...new Set([...order, ...Object.keys(accounts)])].filter((id     ) => typeof id === "string");
    for (const channelId of ids) {
      const rows = Array.isArray(accounts[channelId]) ? accounts[channelId] : [];
      for (const account of rows) {
        if (!record(account) || typeof account.accountId !== "string" || channels.length >= ROW_LIMIT) continue;
        const accountId = account.accountId;
        const inConfig = record(savedChannels[channelId]);

        if (!inConfig && account.configured !== true && account.running !== true) continue;
        const label = displayName(labels[channelId]) || displayName(channelId);
        const name = displayName(accountId === defaults[channelId] || rows.length === 1 ? label : `${label} · ${accountId}`);
        if (!name || channels.some((row     ) => row.name === name)) continue;
        const enabled = savedChannelEnabled(savedChannels, channelId, accountId);
        const effective = effectiveState(enabled, account);
        const enabledPath = channelEnabledPath(savedChannels, channelId, accountId);
        channels.push({
          name,
          enabled,
          effective,
          revision: revisionOf(enabledPath ? enabledPath.entry : savedChannels[channelId]),

          runtimeRevision: revisionOf({ channelId, accountId, effective }),
          writable: writable && enabled !== null && enabledPath !== null,
          protected: false,
          canPause: effective === "retrying" && ctx.advertises("channels.stop"),
          canResume: effective === "paused" && ctx.advertises("channels.start"),
          applyTiming: "restart_required",
        });
        targets.set(name, { channelId, accountId, enabledPath: enabledPath && enabledPath.path });
      }
    }
  }
  return {
    hash,
    snapshot: { observedAtMs: Date.now(), sharedScope: true, mcp, channels },
    targets,
  };
}

function createConnectionsSection(opts      = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const receipts = new Map();

  function prune() {
    const at = now();
    for (const [id, receipt] of receipts) {
      if (receipt.expiresAtMs <= at) receipts.delete(id);
    }
    while (receipts.size > RECEIPT_LIMIT) receipts.delete(receipts.keys().next().value);
  }

  function remember(receipt     ) {
    prune();
    receipts.set(receipt.mutationId, receipt);
    return receipt;
  }

  function notFound(mutationId     ) {
    return { mutationId, operation: "", name: "", outcome: "not_found", createdAtMs: 0, expiresAtMs: 0 };
  }

  function receiptFor(request     , extra     ) {
    const createdAtMs = now();
    return remember({
      mutationId: request.connections.mutationId,
      operation: request.operation,
      name: request.connections.name,
      createdAtMs,
      expiresAtMs: createdAtMs + RECEIPT_TTL_MS,
      observedAtMs: createdAtMs,
      ...extra,
    });
  }

  function refuse(code     ) {
    return { status: "error", errorCode: code, capabilities: [] };
  }

  function answer(receipt     ) {
    return { status: "ok", capabilities: [], connections: { receipt } };
  }

  async function setMcpEnabled(ctx     , request     , current     ) {
    const { name, value, revision } = request.connections;
    const row = current.snapshot.mcp.find((entry     ) => entry.name === name);
    if (!row) return refuse("not_found");
    if (!row.writable) return refuse("managed_setting");
    if (row.revision !== revision) return refuse("config_conflict");
    try {
      await ctx.patchConfig({ patch: { mcp: { servers: { [name]: { enabled: value } } } }, baseHash: current.hash });
    } catch (error     ) {
      return writeFailure(request, error);
    }
    const after = await readBack(ctx);
    const saved = after?.snapshot.mcp.find((entry     ) => entry.name === name);
    if (!saved) return answer(receiptFor(request, { outcome: "unknown", errorCode: "outcome_unknown" }));
    return answer(receiptFor(request, {
      outcome: saved.enabled === value ? "committed" : "failed",
      ...(saved.enabled === value ? {} : { errorCode: "config_conflict" }),
      savedEnabled: saved.enabled,
      effective: saved.effective,
      applyTiming: "new_session_or_restart",
    }));
  }

  async function setChannelEnabled(ctx     , request     , current     ) {
    const { name, value, revision } = request.connections;
    const row = current.snapshot.channels.find((entry     ) => entry.name === name);
    const target = current.targets.get(name);
    if (!row || !target) return refuse("not_found");
    if (!row.writable || !target.enabledPath) return refuse("managed_setting");
    if (row.revision !== revision) return refuse("config_conflict");
    try {
      await ctx.patchConfig({ patch: { channels: nestedPatch(target.enabledPath, { enabled: value }) }, baseHash: current.hash });
    } catch (error     ) {
      return writeFailure(request, error);
    }
    const timing = await ctx.applyTiming(`channels.${target.enabledPath.join(".")}.enabled`);
    const after = await readBack(ctx);
    const saved = after?.snapshot.channels.find((entry     ) => entry.name === name);
    if (!saved) return answer(receiptFor(request, { outcome: "unknown", errorCode: "outcome_unknown" }));
    return answer(receiptFor(request, {
      outcome: saved.enabled === value ? "committed" : "failed",
      ...(saved.enabled === value ? {} : { errorCode: "config_conflict" }),
      savedEnabled: saved.enabled === true,
      effective: saved.effective,
      applyTiming: timing || "restart_required",
    }));
  }

  async function reconnect(ctx     , request     , current     , pause     ) {
    const { name, revision } = request.connections;
    const row = current.snapshot.channels.find((entry     ) => entry.name === name);
    const target = current.targets.get(name);
    if (!row || !target) return refuse("not_found");
    if (row.runtimeRevision !== revision) return refuse("config_conflict");
    if (pause ? !row.canPause : !row.canResume) return refuse("reconnect_not_applicable");
    try {
      await ctx.call(pause ? "channels.stop" : "channels.start", { channel: target.channelId, accountId: target.accountId });
    } catch (error     ) {
      return writeFailure(request, error);
    }
    const after = await readBack(ctx);
    const live = after?.snapshot.channels.find((entry     ) => entry.name === name);
    return answer(receiptFor(request, {
      outcome: "committed",
      ...(live ? { effective: live.effective } : {}),
    }));
  }

  async function readBack(ctx     ) {
    try {
      return await readConnections(ctx);
    } catch {
      return null;
    }
  }

  function writeFailure(request     , error     ) {
    const code = error instanceof OpenClawManagementError ? error.code : "";
    if (code === "config_changed") return refuse("config_conflict");
    if (code === "rate_limited") return refuse("operation_busy");
    if (code === "unsupported") return refuse("unsupported");
    return answer(receiptFor(request, { outcome: "unknown", errorCode: "outcome_unknown" }));
  }

  async function handle(env     , request     ) {
    const { ctx } = env;
    if (!ctx.connected()) throw new OpenClawManagementError("management_unavailable");
    const agents = await env.agents();
    if (!agents.some((row     ) => row.id === request.profileId)) return refuse("profile_not_served");
    const op = request.operation;
    if (op === "connections.receipt") {
      prune();
      const id = request.connections?.mutationId;
      return answer(receipts.get(id) || notFound(id));
    }
    if (op === "connections.read") {
      try {
        return { status: "ok", capabilities: [], connections: { snapshot: (await readConnections(ctx)).snapshot } };
      } catch (error     ) {
        if (error instanceof OpenClawManagementError && error.code === "unsupported") throw error;
        return refuse("native_read_failed");
      }
    }
    if (READS.has(op)) throw new OpenClawManagementError("unsupported");
    const payload = request.connections || {};
    if (!(payload.expiresAtMs > now())) return refuse("intent_expired");
    if (receipts.has(payload.mutationId)) return refuse("identity_conflict");
    let current     ;
    try {
      current = await readConnections(ctx);
    } catch (error     ) {
      if (error instanceof OpenClawManagementError && error.code === "unsupported") throw error;
      return refuse("native_read_failed");
    }
    if (op === "mcp.enabled") return setMcpEnabled(ctx, request, current);
    if (op === "channels.enabled") return setChannelEnabled(ctx, request, current);
    if (op === "channels.pauseReconnect") return reconnect(ctx, request, current, true);
    if (op === "channels.resumeReconnect") return reconnect(ctx, request, current, false);
    throw new OpenClawManagementError("unsupported");
  }

  function supports(ctx     , operation     ) {
    const read = ctx.advertises("config.get");
    switch (operation) {
      case "connections.read":
      case "connections.receipt":
        return read;
      case "mcp.enabled":
      case "channels.enabled":
        return read && ctx.advertises("config.patch");
      case "channels.pauseReconnect":
        return read && ctx.advertisesAll("channels.status", "channels.stop");
      case "channels.resumeReconnect":
        return read && ctx.advertisesAll("channels.status", "channels.start");
      default:
        return false;
    }
  }

  return {
    id: "connections",
    operations: [
      { operation: "connections.read", scope: "profile" },
      { operation: "connections.receipt", scope: "profile" },
      { operation: "mcp.testStatus", scope: "profile" },
      { operation: "mcp.oauthStatus", scope: "profile" },
      { operation: "mcp.enabled", scope: "profile" },
      { operation: "mcp.test", scope: "profile" },
      { operation: "mcp.oauthStart", scope: "profile" },
      { operation: "mcp.oauthCancel", scope: "profile" },
      { operation: "channels.enabled", scope: "profile" },
      { operation: "channels.pauseReconnect", scope: "profile" },
      { operation: "channels.resumeReconnect", scope: "profile" },
    ],
    supports,
    handle,
  };
}

const connectionsSection = createConnectionsSection();

module.exports = { mcpSummary, createConnectionsSection, connectionsSection };
