const MAINTENANCE_READS = new Set(["maintenance.read", "maintenance.logs"]);
const MAINTENANCE_OPERATIONS = new Set([...MAINTENANCE_READS, "maintenance.update", "maintenance.cleanup", "maintenance.archive"]);
const KIND_OF      = { "maintenance.update": "update", "maintenance.cleanup": "cleanup", "maintenance.archive": "archive" };

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const token = (v     ) => typeof v === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(v);
const version = (v     ) => typeof v === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(v);
const nullableVersion = (v     ) => v === null || version(v);
const int = (v     ) => Number.isSafeInteger(v) && v >= 0;
const nullableInt = (v     ) => v === null || int(v);
const nullableBool = (v     ) => v === null || typeof v === "boolean";
const safeText = (v     , limit     ) => typeof v === "string" && v.length <= limit && !/[\u0000-\u001f\u007f]/.test(v);
const label = (v     , limit     ) => safeText(v, limit) && v.trim().length > 0;
const oneOf = (list     , v     ) => list.includes(v);

const CHANNELS = ["stable", "extended-stable", "beta", "dev"];
const INSTALL_KINDS = ["package", "git", "immutable", "unknown"];
const RUN_PHASES = ["requested", "staging", "validating", "repairing", "activating", "restarting", "verifying", "finished"];
const RUN_RESULTS = ["succeeded", "failed", "rolled-back", "skipped"];
const BACKUP_KINDS = ["archive", "sqlite-snapshot", "git", "external"];
const BACKUP_STATUSES = ["ok", "failed", "none"];
const LOCATION_STATES = ["ok", "unavailable", "uninitialized", "wrong-key", "error"];
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const PROBLEM_LEVELS = ["warn", "error", "fatal"];
const OUTCOMES = ["started", "done", "refused", "unknown"];
const REASONS = ["not_allowed", "restart_disabled", "managed_elsewhere", "unsupported_install", "already_running", "unavailable", "cold_storage_off", "failed"];

const MAINTENANCE_ERRORS      = {
  invalid_request: "Review this maintenance action and its confirmation.",
  stale_preview: "The available update changed. Refresh, then review it again.",
  rate_limited: "Too many changes in a minute. Wait a moment, then try again.",
  config_changed: "This setting changed on the host. Refresh, then try again.",
  phone_only: "Only the phone can run maintenance actions.",
  unsupported: "This OpenClaw host does not support this maintenance action.",
  management_unavailable: "Could not read OpenClaw maintenance state. Refresh when connected.",
  outcome_unknown: "Outcome unknown. Refresh before you try this again.",
  invalid_maintenance_result: "OpenClaw sent maintenance state this app cannot show.",
};

const PASSED = new Set(["invalid_request", "stale_preview", "rate_limited", "config_changed", "phone_only"]);

function exactKeys(raw     , keys     ) {
  return Object.keys(raw).length === keys.length && Object.keys(raw).every(k => keys.includes(k));
}

function maintenanceRequest(op     , raw     ) {
  if (!MAINTENANCE_OPERATIONS.has(op)) return null;
  if (op === "maintenance.read") return raw == null || record(raw) && exactKeys(raw, []) ? {} : null;
  if (!record(raw)) return null;
  if (op === "maintenance.logs") return exactKeys(raw, ["filter"]) && oneOf(["problems", "all"], raw.filter) ? { filter: raw.filter } : null;
  const keys = op === "maintenance.update" ? ["operationId", "expectVersion", "confirmed"] : ["operationId", "confirmed"];
  if (!exactKeys(raw, keys) || !token(raw.operationId) || raw.confirmed !== true) return null;
  if (op === "maintenance.update" && !version(raw.expectVersion)) return null;
  return Object.fromEntries(keys.map(k => [k, raw[k]]));
}

function maintenanceReceipt(raw     , kind     ) {
  if (!record(raw) || !token(raw.operationId) || raw.kind !== kind || !oneOf(OUTCOMES, raw.outcome) ||
    !(raw.reason === null || oneOf(REASONS, raw.reason)) || !int(raw.atMs)) return null;
  const receipt      = { operationId: raw.operationId, kind, outcome: raw.outcome, reason: raw.reason, atMs: raw.atMs };
  if (kind === "update") {
    for (const key of ["fromVersion", "toVersion"]) {
      if (raw[key] === undefined) continue;
      if (!nullableVersion(raw[key])) return null;
      receipt[key] = raw[key];
    }
  } else if (raw.fromVersion !== undefined || raw.toVersion !== undefined) return null;
  const done = kind === "cleanup" && raw.outcome === "done";
  if (done !== (raw.cleanup !== undefined)) return null;
  if (done) {
    const c = raw.cleanup;
    if (!record(c) || !["sessionsBefore", "sessionsAfter", "freedBytes"].every(k => int(c[k]))) return null;
    receipt.cleanup = { sessionsBefore: c.sessionsBefore, sessionsAfter: c.sessionsAfter, freedBytes: c.freedBytes };
  }
  return receipt;
}

function updateView(u     ) {
  if (u === null) return null;
  if (!record(u) || !nullableVersion(u.currentVersion) || !nullableVersion(u.latestVersion) || typeof u.updateAvailable !== "boolean" ||
    !(u.channel === null || oneOf(CHANNELS, u.channel)) || !(u.installKind === null || oneOf(INSTALL_KINDS, u.installKind)) ||
    !nullableBool(u.autoUpdate)) return undefined;
  let running      = null;
  if (u.running !== null) {
    if (!record(u.running) || !oneOf(RUN_PHASES, u.running.phase) || !int(u.running.startedAtMs)) return undefined;
    running = { phase: u.running.phase, startedAtMs: u.running.startedAtMs };
  }
  let last      = null;
  if (u.last !== null) {
    const l = u.last;
    if (!record(l) || !oneOf(RUN_RESULTS, l.status) || !nullableInt(l.finishedAtMs) || !nullableVersion(l.fromVersion) || !nullableVersion(l.toVersion)) return undefined;
    last = { status: l.status, finishedAtMs: l.finishedAtMs, fromVersion: l.fromVersion, toVersion: l.toVersion };
  }
  const request = u.request === null ? null : maintenanceReceipt(u.request, "update");
  if (request === null && u.request !== null) return undefined;
  return { currentVersion: u.currentVersion, latestVersion: u.latestVersion, updateAvailable: u.updateAvailable, channel: u.channel,
    installKind: u.installKind, autoUpdate: u.autoUpdate, running, last, request };
}

function sessionsView(s     ) {
  if (s === null) return null;
  const counts = ["agents", "hotTranscripts", "coldTranscripts", "databaseBytes", "archiveBytes"];
  if (!record(s) || !counts.every(k => int(s[k])) || !nullableBool(s.coldStorage) || typeof s.archiving !== "boolean" ||
    !nullableInt(s.lastArchivedAtMs) || typeof s.archiveFailed !== "boolean") return undefined;
  return Object.fromEntries([...counts, "coldStorage", "archiving", "lastArchivedAtMs", "archiveFailed"].map(k => [k, s[k]]));
}

function backupsView(list     ) {
  if (list === null) return null;
  if (!Array.isArray(list) || list.length > 20) return undefined;
  const rows      = [];
  for (const b of list) {
    if (!record(b) || !oneOf(BACKUP_KINDS, b.kind) || !oneOf(BACKUP_STATUSES, b.status) || !nullableInt(b.atMs) || !nullableInt(b.bytes)) return undefined;
    rows.push({ kind: b.kind, status: b.status, atMs: b.atMs, bytes: b.bytes });
  }
  return rows;
}

function locationsView(list     ) {
  if (list === null) return null;
  if (!Array.isArray(list) || list.length > 8) return undefined;
  const rows      = [];
  for (const l of list) {
    if (!record(l) || typeof l.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(l.name) || rows.some((r     ) => r.name === l.name) ||
      !label(l.provider, 40) || typeof l.encrypted !== "boolean" || !oneOf(LOCATION_STATES, l.state) ||
      !nullableInt(l.freeBytes) || !nullableInt(l.totalBytes)) return undefined;
    rows.push({ name: l.name, provider: l.provider, encrypted: l.encrypted, state: l.state, freeBytes: l.freeBytes, totalBytes: l.totalBytes });
  }
  return rows;
}

function maintenanceSnapshot(raw     ) {
  if (!record(raw) || !int(raw.observedAtMs)) return null;
  const parts      = {
    update: updateView(raw.update), sessions: sessionsView(raw.sessions),
    backups: backupsView(raw.backups), locations: locationsView(raw.locations),
  };
  if (Object.values(parts).some(v => v === undefined)) return null;
  return { observedAtMs: raw.observedAtMs, ...parts };
}

function maintenanceLogs(raw     , filter     ) {
  if (!record(raw) || raw.filter !== filter || typeof raw.truncated !== "boolean" || !Array.isArray(raw.entries) || raw.entries.length > 60) return null;
  const entries      = [];
  for (const e of raw.entries) {
    if (!record(e) || !nullableInt(e.atMs) || !(e.level === null || oneOf(LOG_LEVELS, e.level)) ||
      !(e.source === null || label(e.source, 48)) || !safeText(e.text, 300)) return null;
    if (filter === "problems" && !oneOf(PROBLEM_LEVELS, e.level)) return null;
    entries.push({ atMs: e.atMs, level: e.level, source: e.source, text: e.text });
  }
  return { filter, truncated: raw.truncated, entries };
}

function maintenanceFailure(identity     , code      = "management_unavailable", unsupported      = false, backend      = "OpenClaw") {
  const envelope = Object.fromEntries(["requestId", "operation", "scope", "profileId"].map(k => [k, identity[k]]));
  if (unsupported || code === "unsupported") {
    return { ...envelope, status: "unsupported", capabilities: [], errorCode: "unsupported", errorMessage: MAINTENANCE_ERRORS.unsupported.replace(/OpenClaw/g, backend) };
  }
  const read = MAINTENANCE_READS.has(identity.operation);
  const errorCode = PASSED.has(code) ? code
    : read ? (code === "invalid_maintenance_result" ? code : "management_unavailable") : "outcome_unknown";
  return { ...envelope, status: "error", capabilities: [], errorCode, errorMessage: MAINTENANCE_ERRORS[errorCode].replace(/OpenClaw/g, backend) };
}

function maintenanceManagementResult(identity     , raw     , backend      = "OpenClaw") {
  const op = identity.operation;
  if (raw.status === "unsupported") return maintenanceFailure(identity, "unsupported", true, backend);
  if (raw.status !== "ok") return maintenanceFailure(identity, raw.errorCode, false, backend);
  const body = record(raw.maintenance) ? raw.maintenance : {};
  let maintenance      = null;
  if (op === "maintenance.read") {
    const snapshot = maintenanceSnapshot(body.snapshot);
    if (snapshot) maintenance = { snapshot };
  } else if (op === "maintenance.logs") {
    const logs = maintenanceLogs(body.logs, identity.maintenance?.filter);
    if (logs) maintenance = { logs };
  } else {
    const receipt = maintenanceReceipt(body.receipt, KIND_OF[op]);
    if (receipt && receipt.operationId === identity.maintenance?.operationId) maintenance = { receipt };
  }
  if (!maintenance) return maintenanceFailure(identity, "invalid_maintenance_result", false, backend);
  const envelope = Object.fromEntries(["requestId", "operation", "scope", "profileId"].map(k => [k, identity[k]]));
  return { ...envelope, status: "ok", capabilities: [], maintenance };
}

module.exports = { MAINTENANCE_READS, MAINTENANCE_OPERATIONS, MAINTENANCE_ERRORS, maintenanceRequest, maintenanceReceipt, maintenanceSnapshot, maintenanceLogs, maintenanceFailure, maintenanceManagementResult };
