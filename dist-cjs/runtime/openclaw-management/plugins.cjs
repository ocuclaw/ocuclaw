const { createHash } = require("node:crypto");
const { OpenClawManagementError } = require("./shared.cjs");

const SELF_PLUGIN_ID = "ocuclaw";
const PLUGIN_LIMIT = 100;
const REQUEST_LIMIT = 50;
const DEVICE_LIMIT = 100;
const NAME_LIMIT = 160;
const SHORT_ID = 12;

const READ = "plugins.read";
const WRITES = new Set(["plugins.enabled", "plugins.reload", "plugins.uninstall", "devices.approve", "devices.reject", "devices.remove"]);

function record(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value     ) {
  return Array.isArray(value) ? value.filter(record) : [];
}

function displayName(value     ) {
  const clean = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return clean.length > NAME_LIMIT ? clean.slice(0, NAME_LIMIT).trim() : clean;
}

function safeId(value     ) {
  return typeof value === "string" && /^[A-Za-z0-9@._:/+=-]{1,200}$/.test(value) ? value : "";
}

function time(value     ) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function revisionOf(value     ) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pluginState(plugin     ) {
  const runtime = record(plugin.runtime) ? plugin.runtime.state : null;
  if (plugin.enabled !== true || runtime === "disabled") return "off";
  if (runtime === "service-failed" || plugin.state === "error") return "failed";
  if (plugin.state === "needs-setup") return "needs_setup";
  if (runtime === "active") return "active";
  return "not_loaded";
}

function accessOf(entry     ) {
  const roles = [entry.role, ...(Array.isArray(entry.roles) ? entry.roles : [])].filter((role     ) => typeof role === "string");
  const scopes = Array.isArray(entry.scopes) ? entry.scopes : [];
  if (scopes.includes("operator.admin")) return "full";
  if (scopes.includes("operator.write")) return "change";
  if (roles.length > 0 && roles.every((role     ) => role === "node")) return "node";
  if (scopes.includes("operator.read")) return "read";
  return "other";
}

function deviceName(entry     , id     ) {
  return displayName(entry.operatorLabel) || displayName(entry.displayName) || displayName(entry.clientId) || id.slice(0, SHORT_ID);
}

function platformOf(entry     ) {
  return displayName(entry.platform || entry.deviceFamily).slice(0, 40);
}

async function readPlugins(ctx     ) {
  if (!ctx.advertises("plugins.list")) return null;
  const answer      = await ctx.call("plugins.list", {});
  const mutable = answer?.mutationAllowed !== false;
  const rows      = [];
  for (const plugin of list(answer?.plugins)) {

    if (plugin.installed !== true || rows.length >= PLUGIN_LIMIT) continue;
    const id = safeId(plugin.id);
    if (!id || rows.some((row     ) => row.id === id)) continue;
    const state = pluginState(plugin);

    const isSelf = id === SELF_PLUGIN_ID;
    rows.push({
      id,
      name: displayName(plugin.name) || id,
      enabled: plugin.enabled === true,
      state,
      protected: isSelf,
      writable: mutable && !isSelf && ctx.advertises("plugins.setEnabled"),
      canReload: mutable && !isSelf && plugin.enabled === true && (state === "failed" || state === "not_loaded") &&
        ctx.advertises("plugins.reload"),
      removable: mutable && !isSelf && plugin.removable === true && ctx.advertises("plugins.uninstall"),
      revision: revisionOf({ id, enabled: plugin.enabled === true, state }),
    });
  }
  rows.sort((a     , b     ) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return rows;
}

async function readDevices(ctx     ) {
  if (!ctx.advertises("device.pair.list")) return null;
  const answer      = await ctx.call("device.pair.list", {});
  const requests      = [];
  const devices      = [];
  for (const entry of list(answer?.pending)) {
    const id = safeId(entry.requestId);
    const deviceId = safeId(entry.deviceId);
    if (!id || !deviceId || requests.length >= REQUEST_LIMIT) continue;
    requests.push({
      kind: "device", id, name: deviceName(entry, deviceId), platform: platformOf(entry),
      access: accessOf(entry), upgrade: entry.isRepair === true, runsCommands: false, atMs: time(entry.ts),
    });
  }
  for (const entry of list(answer?.paired)) {
    const id = safeId(entry.deviceId);
    if (!id || devices.length >= DEVICE_LIMIT || devices.some((row     ) => row.id === id)) continue;
    devices.push({
      id, name: deviceName(entry, id), platform: platformOf(entry), access: accessOf(entry),
      connected: entry.connected === true, lastSeenAtMs: time(entry.lastSeenAtMs),
      removable: ctx.advertises("device.pair.remove"),
    });
  }
  return { requests, devices };
}

async function readNodeRequests(ctx     ) {
  if (!ctx.advertises("node.pair.list")) return null;
  const answer      = await ctx.call("node.pair.list", {});
  const requests      = [];
  for (const entry of list(answer?.pending)) {
    const id = safeId(entry.requestId);
    const nodeId = safeId(entry.nodeId);
    if (!id || !nodeId || requests.length >= REQUEST_LIMIT) continue;
    const required = Array.isArray(entry.requiredApproveScopes) ? entry.requiredApproveScopes : [];
    requests.push({
      kind: "node", id, name: deviceName(entry, nodeId), platform: platformOf(entry), access: "node",

      upgrade: false, runsCommands: required.includes("operator.admin"), atMs: time(entry.ts),
    });
  }
  return requests;
}

async function readSnapshot(ctx     ) {
  const plugins = await readPlugins(ctx);
  const devices = await readDevices(ctx);
  const nodeRequests = await readNodeRequests(ctx);
  const requests = [...(devices?.requests || []), ...(nodeRequests || [])]
    .sort((a     , b     ) => (b.atMs || 0) - (a.atMs || 0)).slice(0, REQUEST_LIMIT);
  return {
    observedAtMs: ctx.now(),
    pluginsListed: plugins !== null,
    devicesListed: devices !== null || nodeRequests !== null,
    plugins: plugins || [],
    requests,
    devices: devices?.devices || [],
  };
}

async function pairingSummary(ctx     ) {
  if (!ctx.advertises("device.pair.list") && !ctx.advertises("node.pair.list")) return null;
  try {
    const devices = await readDevices(ctx);
    const nodes = await readNodeRequests(ctx);
    return { pairingRequests: (devices?.requests.length || 0) + (nodes?.length || 0) };
  } catch {
    return null;
  }
}

function done(snapshot     , request     , outcome     ) {
  return { status: "ok", capabilities: [], plugins: { snapshot, done: { operation: request.operation, id: request.plugins.id, outcome } } };
}

async function writeAndCheck(ctx     , request     , method     , params     , applied     ) {
  let answered = true;
  try {
    await ctx.call(method, params);
  } catch (error     ) {
    const failure      = error;
    if (!(failure instanceof OpenClawManagementError) || ["unsupported", "rate_limited"].includes(failure.code)) throw failure;

    answered = Boolean(error?.hostCode);
  }
  let after     ;
  try {
    after = await readSnapshot(ctx);
  } catch {
    throw new OpenClawManagementError("outcome_unknown");
  }
  if (applied(after)) return done(after, request, "committed");
  if (!answered) throw new OpenClawManagementError("outcome_unknown");
  return done(after, request, "not_applied");
}

async function write(ctx     , request     ) {
  const change = request.plugins;
  const current = await readSnapshot(ctx);
  if (request.operation.startsWith("plugins.")) {
    const row = current.plugins.find((entry     ) => entry.id === change.id);
    if (!row) throw new OpenClawManagementError("not_found");
    if (row.protected) throw new OpenClawManagementError("protected_plugin");
    if (row.revision !== change.revision) throw new OpenClawManagementError("config_changed");
    if (request.operation === "plugins.uninstall") {
      if (!row.removable) throw new OpenClawManagementError("managed_setting");
      return writeAndCheck(ctx, request, "plugins.uninstall", { pluginId: change.id },
        (after     ) => !after.plugins.some((entry     ) => entry.id === change.id));
    }
    if (request.operation === "plugins.enabled") {
      if (!row.writable) throw new OpenClawManagementError("managed_setting");

      return writeAndCheck(ctx, request, "plugins.setEnabled", { pluginId: change.id, enabled: change.value },
        (after     ) => after.plugins.some((entry     ) => entry.id === change.id && entry.enabled === change.value));
    }
    if (!row.canReload) throw new OpenClawManagementError("managed_setting");
    return writeAndCheck(ctx, request, "plugins.reload", { plugins: [{ pluginId: change.id }] },
      (after     ) => after.plugins.some((entry     ) => entry.id === change.id && entry.state === "active"));
  }
  if (request.operation === "devices.remove") {
    if (!current.devices.some((entry     ) => entry.id === change.id && entry.removable)) throw new OpenClawManagementError("not_found");
    return writeAndCheck(ctx, request, "device.pair.remove", { deviceId: change.id },
      (after     ) => !after.devices.some((entry     ) => entry.id === change.id));
  }

  const pending = current.requests.find((entry     ) => entry.id === change.id && entry.kind === change.kind);
  if (!pending) throw new OpenClawManagementError("request_gone");
  const method = `${change.kind === "node" ? "node" : "device"}.pair.${request.operation === "devices.approve" ? "approve" : "reject"}`;
  if (!ctx.advertises(method)) throw new OpenClawManagementError("unsupported");
  return writeAndCheck(ctx, request, method, { requestId: change.id },
    (after     ) => !after.requests.some((entry     ) => entry.id === change.id && entry.kind === change.kind));
}

const OPERATION_METHODS      = {
  "plugins.enabled": ["plugins.setEnabled"],
  "plugins.reload": ["plugins.reload"],
  "plugins.uninstall": ["plugins.uninstall"],
  "devices.approve": ["device.pair.approve", "node.pair.approve"],
  "devices.reject": ["device.pair.reject", "node.pair.reject"],
  "devices.remove": ["device.pair.remove"],
};

const pluginsSection = {
  id: "plugins",
  operations: [
    { operation: READ, scope: "profile" },
    ...[...WRITES].map((operation) => ({ operation, scope: "profile" })),
  ],
  supports(ctx     , operation     ) {
    const readable = ctx.advertises("plugins.list") || ctx.advertises("device.pair.list") || ctx.advertises("node.pair.list");
    if (!readable) return false;
    if (operation === READ) return true;
    return (OPERATION_METHODS[operation] || []).some((method     ) => ctx.advertises(method));
  },

  applyTiming: () => "active_now",
  async handle(env     , request     ) {
    const { ctx } = env;
    if (!request.plugins) throw new OpenClawManagementError("invalid_request");
    if (request.operation === READ) return { status: "ok", plugins: { snapshot: await readSnapshot(ctx) } };
    return write(ctx, request);
  },
};

module.exports = { pairingSummary, pluginsSection };
