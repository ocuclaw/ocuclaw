const HEARTBEAT_OPERATIONS = new Set(["heartbeat.read", "heartbeat.update", "heartbeat.pause"]);
const HEARTBEAT_READS = new Set(["heartbeat.read"]);
const EVERY = ["default", "0m", "15m", "30m", "1h", "2h", "4h"];
const TARGETS = ["owner", "last", "none"];
const SHOWN_TARGETS = ["default", ...TARGETS, "channel"];
const TIMINGS = ["active_now", "restart_required"];
const STATUSES = ["alert", "ok", "skipped", "failed"];
const REASONS = ["no_route", "target_none", "quiet_hours", "alerts_off", "paused", "background_work", "dm_blocked", "busy", "other"];
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION = /^\d{1,5}(ms|s|m|h|d)?$/;
const record = (v     ) => v && typeof v === "object" && !Array.isArray(v);
const exact = (v     , keys          ) => record(v) && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const revision = (v     ) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const name = (v     , max        ) => typeof v === "string" && v.length <= max && /^[A-Za-z0-9_.:/@+-]*$/.test(v);
const line = (v     , max        ) => typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v);
const isHeartbeatOperation = (operation     ) => HEARTBEAT_OPERATIONS.has(operation);

function windowShape(value     ) {
  if (typeof value !== "string") return false;
  const parts = value.split("-");
  return parts.length === 2 && CLOCK.test(parts[0]) && (CLOCK.test(parts[1]) || parts[1] === "24:00");
}

function windowValid(value     ) {
  return windowShape(value) && value.split("-")[0] !== value.split("-")[1];
}

function changesValid(raw     ) {
  if (!record(raw)) return false;
  const keys = Object.keys(raw);
  if (keys.length < 1 || keys.length > 5) return false;
  return keys.every((key) => {
    const value = raw[key];
    if (key === "every") return EVERY.includes(value);
    if (key === "target") return TARGETS.includes(value);
    if (key === "activeHours") return value === "all_day" || windowValid(value);
    if (key === "lightContext" || key === "isolatedSession") return typeof value === "boolean";
    return false;
  });
}

function heartbeatRequest(operation        , raw     )      {
  if (operation === "heartbeat.read") return raw === undefined || exact(raw, []) ? {} : null;
  if (operation === "heartbeat.pause") return exact(raw, ["paused"]) && typeof raw.paused === "boolean" ? { paused: raw.paused } : null;
  if (operation === "heartbeat.update") {
    if (!exact(raw, ["revision", "changes"]) || !revision(raw.revision) || !changesValid(raw.changes)) return null;
    return { revision: raw.revision, changes: { ...raw.changes } };
  }
  return null;
}

function lastRun(raw     )      {
  if (raw == null) return null;
  if (!record(raw) || !STATUSES.includes(raw.status) || !Number.isSafeInteger(raw.atMs) || raw.atMs <= 0) return undefined;
  const out      = { status: raw.status, atMs: raw.atMs };
  if (raw.reason != null) {
    if (!REASONS.includes(raw.reason) || !["skipped", "failed"].includes(raw.status)) return undefined;
    out.reason = raw.reason;
  }
  if (raw.preview != null) {
    if (raw.status !== "alert" || !line(raw.preview, 160)) return undefined;
    out.preview = raw.preview;
  }
  if (raw.channel != null) {
    if (!name(raw.channel, 64)) return undefined;
    out.channel = raw.channel;
  }
  return out;
}

function heartbeatSnapshot(raw     )      {
  if (!record(raw) || !revision(raw.revision)) return null;
  const every = raw.every === "custom" || EVERY.includes(raw.every) || (typeof raw.every === "string" && DURATION.test(raw.every)) ? raw.every : null;
  const activeHours = raw.activeHours === "all_day" || raw.activeHours === "custom" || windowShape(raw.activeHours) ? raw.activeHours : null;
  if (every == null || activeHours == null || !SHOWN_TARGETS.includes(raw.target)) return null;
  if (!name(raw.targetChannel, 64) || (raw.target === "channel") !== (raw.targetChannel !== "")) return null;
  if (!line(raw.model, 160)) return null;
  for (const key of ["lightContext", "isolatedSession", "customPrompt", "agentOwn", "automationsOff", "writable", "canPause"]) {
    if (typeof raw[key] !== "boolean") return null;
  }
  if (!Number.isSafeInteger(raw.otherAgentsOwn) || raw.otherAgentsOwn < 0) return null;
  if (raw.paused !== null && typeof raw.paused !== "boolean") return null;
  if (raw.applyTiming != null && !TIMINGS.includes(raw.applyTiming)) return null;
  const last = lastRun(raw.last);
  if (last === undefined) return null;
  const out      = {
    revision: raw.revision, every, activeHours, target: raw.target, targetChannel: raw.targetChannel,
    lightContext: raw.lightContext, isolatedSession: raw.isolatedSession, model: raw.model, customPrompt: raw.customPrompt,
    agentOwn: raw.agentOwn, otherAgentsOwn: Math.min(raw.otherAgentsOwn, 999), automationsOff: raw.automationsOff,
    writable: raw.writable, canPause: raw.canPause, paused: raw.paused, last,
  };
  if (raw.applyTiming != null) out.applyTiming = raw.applyTiming;
  return out;
}

const ERRORS                         = {
  invalid_request: "The heartbeat request was invalid. Reload the page and try again.",
  native_read_failed: "Heartbeat settings could not be read. Refresh when connected.",
  config_changed: "This setting changed on the host while you were editing. Reload it, then try again.",
  rate_limited: "Too many changes in a minute. Wait a moment, then try again.",
  host_refused: "The host refused this heartbeat change. Nothing was saved.",
  profile_not_served: "This agent is no longer served here. Pick another one.",
  outcome_unknown: "The change may or may not have saved. Reload to see what the host has now.",
};

function heartbeatManagementResult(identity     , raw     , backend = "Hermes")      {
  const envelope = { requestId: identity.requestId, operation: identity.operation, scope: identity.scope, profileId: identity.profileId };
  if (raw.status === "unsupported") {
    return { ...envelope, status: "unsupported", capabilities: [], errorCode: "unsupported",
      errorMessage: `This ${backend} host does not support this operation. Update ${backend} and OcuClaw to a compatible version.` };
  }
  const snapshot = raw.heartbeat == null ? null : heartbeatSnapshot(raw.heartbeat);
  if (raw.status === "ok" && snapshot) return { ...envelope, status: "ok", capabilities: [], heartbeat: snapshot };
  const write = !HEARTBEAT_READS.has(identity.operation);
  const code = raw.status !== "ok" && Object.hasOwn(ERRORS, raw.errorCode) ? raw.errorCode : write ? "outcome_unknown" : "native_read_failed";
  return { ...envelope, status: "error", capabilities: [], errorCode: code, errorMessage: ERRORS[code] };
}

module.exports = { HEARTBEAT_OPERATIONS, HEARTBEAT_READS, isHeartbeatOperation, heartbeatRequest, heartbeatSnapshot, heartbeatManagementResult };
