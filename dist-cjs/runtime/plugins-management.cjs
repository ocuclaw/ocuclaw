const PLUGINS_READS = new Set(["plugins.read"]);
const PLUGINS_OPERATIONS = new Set([...PLUGINS_READS, "plugins.enabled", "plugins.reload", "plugins.uninstall", "devices.approve", "devices.reject", "devices.remove"]);

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v     , limit = 160) => typeof v === "string" && v.length <= limit && !/[\u0000-\u001f]/.test(v);
const handle = (v     ) => typeof v === "string" && /^[A-Za-z0-9@._:/+=-]{1,200}$/.test(v);
const revision = (v     ) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const time = (v     ) => Number.isSafeInteger(v) && v >= 0;
const PLUGIN_STATES = new Set(["active", "off", "failed", "needs_setup", "not_loaded"]);
const ACCESS = new Set(["full", "change", "read", "node", "other"]);
const KINDS = new Set(["device", "node"]);

const PLUGINS_ERRORS                         = {
  invalid_request: "Review this change and confirm it again.",
  not_found: "This plugin or device is no longer on OpenClaw. Refresh the list.",
  request_gone: "This pairing request has gone or changed. Refresh, then check the new one.",
  protected_plugin: "OcuClaw needs this plugin to reach your glasses, so it can't be turned off here.",
  managed_setting: "OpenClaw doesn't let this be changed from here.",
  native_read_failed: "Could not read plugins and devices from OpenClaw. Refresh when connected.",
  outcome_unknown: "OpenClaw didn't confirm this change. Refresh to see whether it happened.",
  config_changed: "This setting changed on the host while you were editing. Reload it, then try again.",
  rate_limited: "Too many changes in a minute. Wait a moment, then try again.",
};

function pluginsRequest(op        , raw     )      {
  if (!PLUGINS_OPERATIONS.has(op)) return null;
  if (PLUGINS_READS.has(op)) return raw == null || record(raw) && !Object.keys(raw).length ? {} : null;
  if (!record(raw) || raw.confirmed !== true || !handle(raw.id)) return null;
  const keys = ["confirmed", "id"];
  if (op.startsWith("plugins.")) {
    keys.push("revision");
    if (!revision(raw.revision)) return null;
  }
  if (op === "plugins.enabled") {
    keys.push("value");
    if (typeof raw.value !== "boolean") return null;
  }
  if (op === "devices.approve" || op === "devices.reject") {
    keys.push("kind");
    if (!KINDS.has(raw.kind)) return null;
  }
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(k => !keys.includes(k))) return null;
  return Object.fromEntries(keys.map(k => [k, raw[k]]));
}

const pick = (row     , keys     ) => Object.fromEntries(keys.map((k     ) => [k, row[k]]));
const atMs = (v     ) => v === null || time(v);

function pluginsSnapshot(raw     )      {
  if (!record(raw) || !time(raw.observedAtMs) || typeof raw.pluginsListed !== "boolean" || typeof raw.devicesListed !== "boolean" ||
    !Array.isArray(raw.plugins) || raw.plugins.length > 100 || !Array.isArray(raw.requests) || raw.requests.length > 50 ||
    !Array.isArray(raw.devices) || raw.devices.length > 100) return null;
  const plugins        = [], requests        = [], devices        = [];
  for (const row of raw.plugins) {
    if (!record(row) || !handle(row.id) || plugins.some(r => r.id === row.id) || !text(row.name) || !row.name.trim() ||
      !PLUGIN_STATES.has(row.state) || !revision(row.revision) ||
      !["enabled", "protected", "writable", "canReload", "removable"].every(k => typeof row[k] === "boolean") ||
      row.protected && (row.writable || row.canReload || row.removable)) return null;
    plugins.push(pick(row, ["id", "name", "enabled", "state", "protected", "writable", "canReload", "removable", "revision"]));
  }
  for (const row of raw.requests) {
    if (!record(row) || !KINDS.has(row.kind) || !handle(row.id) || requests.some(r => r.id === row.id && r.kind === row.kind) ||
      !text(row.name) || !row.name.trim() || !text(row.platform, 40) || !ACCESS.has(row.access) ||
      typeof row.upgrade !== "boolean" || typeof row.runsCommands !== "boolean" || !atMs(row.atMs)) return null;
    requests.push(pick(row, ["kind", "id", "name", "platform", "access", "upgrade", "runsCommands", "atMs"]));
  }
  for (const row of raw.devices) {
    if (!record(row) || !handle(row.id) || devices.some(r => r.id === row.id) || !text(row.name) || !row.name.trim() ||
      !text(row.platform, 40) || !ACCESS.has(row.access) || typeof row.connected !== "boolean" ||
      typeof row.removable !== "boolean" || !atMs(row.lastSeenAtMs)) return null;
    devices.push(pick(row, ["id", "name", "platform", "access", "connected", "lastSeenAtMs", "removable"]));
  }
  return { observedAtMs: raw.observedAtMs, pluginsListed: raw.pluginsListed, devicesListed: raw.devicesListed, plugins, requests, devices };
}

function pluginsManagementResult(identity     , raw     , backend = "OpenClaw")      {
  const op = identity.operation;
  const envelope = Object.fromEntries(["requestId", "operation", "scope", "profileId"].map(k => [k, identity[k]]));
  const snapshot = pluginsSnapshot(raw.plugins?.snapshot);
  const finished = raw.plugins?.done;
  const doneValid = record(finished) && finished.operation === op && finished.id === identity.plugins?.id &&
    ["committed", "not_applied"].includes(finished.outcome);
  const valid = snapshot && (PLUGINS_READS.has(op) ? finished === undefined : doneValid);
  if (raw.status === "ok" && valid) {
    return { ...envelope, status: "ok", capabilities: [], plugins: { snapshot, ...(PLUGINS_READS.has(op) ? {} : { done: pick(finished, ["operation", "id", "outcome"]) }) } };
  }
  if (raw.status === "unsupported") {
    return { ...envelope, status: "unsupported", capabilities: [], errorCode: "unsupported",
      errorMessage: `This ${backend} host does not support this operation. Update ${backend} and OcuClaw to a compatible version.` };
  }

  const known = raw.status === "error" && Object.hasOwn(PLUGINS_ERRORS, raw.errorCode);
  const code = known ? raw.errorCode : PLUGINS_READS.has(op) ? "native_read_failed" : "outcome_unknown";
  return { ...envelope, status: "error", capabilities: [], errorCode: code, errorMessage: PLUGINS_ERRORS[code] };
}

module.exports = { PLUGINS_READS, PLUGINS_OPERATIONS, PLUGINS_ERRORS, pluginsRequest, pluginsSnapshot, pluginsManagementResult };
