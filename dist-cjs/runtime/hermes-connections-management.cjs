const CONNECTION_READS = new Set(["connections.read", "connections.receipt", "mcp.testStatus", "mcp.oauthStatus"]);
const CONNECTION_OPERATIONS = new Set([...CONNECTION_READS, "mcp.enabled", "mcp.test", "mcp.oauthStart", "mcp.oauthCancel", "channels.enabled", "channels.pauseReconnect", "channels.resumeReconnect"]);
const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v     , limit = 160) => typeof v === "string" && v.length <= limit && !/[\u0000-\u001f]/.test(v);
const id = (v     ) => typeof v === "string" && /^[A-Za-z0-9_-]{12,120}$/.test(v);
const revision = (v     ) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const time = (v     ) => Number.isSafeInteger(v) && v >= 0;
const effects = new Set(["connected", "disabled", "connecting", "failed", "not_started", "unknown", "paused", "retrying", "disconnected"]);
const outcomes = new Set(["running", "authorization_required", "committed", "failed", "cancelled", "expired", "unknown", "not_found"]);
const reasons = new Set(["", "stdio_credentials", "header_credentials", "credential_name_collision", "unsupported_transport", "native_callback_unavailable", "command_may_install"]);

const CONNECTION_ERRORS                         = {
  invalid_request: "Review this connection action and confirmation.", unsupported: "This Hermes needs native connection management compatibility.",
  profile_not_served: "This profile is not served by the connected gateway.", native_read_failed: "Hermes could not read this profile's native connections.",
  config_conflict: "This connection changed elsewhere. Refresh and review the action.", managed_setting: "This connection is inherited or managed and cannot be changed here.",
  intent_expired: "This action expired before native admission. Review and submit again.", management_path_protected: "The active OcuClaw management connection cannot be disabled or paused here.",
  runtime_unavailable: "This profile has no supported live gateway connection owner.", reconnect_not_applicable: "Reconnect control applies only to failed retry queues, not healthy connected channels.",
  oauth_transport_unsupported: "Reauthentication needs a supported installed HTTP connection and an existing configured native callback route.",
  test_unsupported: "Use an installed native command that does not bootstrap or update software before testing here.",
  oauth_busy: "A native authorization flow is already active for this connection, or its pending limit was reached.", operation_busy: "Too many connection actions are already running for this profile.",
  not_found: "This connection or operation is no longer available.", identity_conflict: "This action identity was already used. Check its original receipt.",
  outcome_unknown: "The action outcome is unknown. Check its original receipt before another action.", oauth_required: "OAuth authorization is required before this connection can pass a test.",
  oauth_failed: "Native authorization did not complete. Existing credentials were preserved unless the outcome is unknown.",
  test_failed: "The native connection test failed or timed out.", cancelled: "Authorization cancelled.", expired: "Authorization expired.",
  owner_restarted: "The native owner restarted. Check the operation outcome before another action.",
  cancellation_requested: "Cancellation requested. Hermes is discarding the pending authorization state.", oauth_ending: "Hermes is finishing the failed authorization attempt.",
};

function connectionsRequest(op        , raw     )      {
  if (!CONNECTION_OPERATIONS.has(op)) return null;
  if (op === "connections.read") return raw == null || record(raw) && !Object.keys(raw).length ? {} : null;
  if (!record(raw) || !id(raw.mutationId)) return null;
  const keys = ["mutationId"];
  if (!CONNECTION_READS.has(op)) {
    keys.push("confirmed", "producedAtMs", "expiresAtMs");
    if (raw.confirmed !== true || !time(raw.producedAtMs) || !time(raw.expiresAtMs) || raw.expiresAtMs <= raw.producedAtMs || raw.expiresAtMs - raw.producedAtMs > 30000) return null;
    if (op !== "mcp.oauthCancel") {
      keys.push("name", "revision");
      if (!text(raw.name) || !raw.name.trim() || !revision(raw.revision)) return null;
    }
    if (["mcp.enabled", "channels.enabled"].includes(op)) {
      keys.push("value");
      if (typeof raw.value !== "boolean") return null;
    }
  }
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(k => !keys.includes(k))) return null;
  return Object.fromEntries(keys.map(k => [k, raw[k]]));
}

function connectionsSnapshot(raw     )      {
  if (!record(raw) || !time(raw.observedAtMs) || typeof raw.sharedScope !== "boolean" || !Array.isArray(raw.mcp) || raw.mcp.length > 100 || !Array.isArray(raw.channels) || raw.channels.length > 100) return null;
  const mcp        = [], channels        = [];
  for (const row of raw.mcp) {
    if (!record(row) || !text(row.name) || !row.name.trim() || mcp.some(r => r.name === row.name) || !revision(row.revision) || !["enabled", "writable", "oauthSupported", "testSupported"].every(k => typeof row[k] === "boolean") || !effects.has(row.effective) || !["http", "stdio"].includes(row.transport) || !reasons.has(row.oauthReason) || !reasons.has(row.testReason) || row.oauthSupported !== !row.oauthReason || row.testSupported !== !row.testReason || row.applyTiming !== "new_session_or_restart") return null;
    mcp.push(Object.fromEntries(["name", "enabled", "effective", "revision", "writable", "transport", "oauthSupported", "oauthReason", "testSupported", "testReason", "applyTiming"].map(k => [k, row[k]])));
  }
  for (const row of raw.channels) {
    if (!record(row) || !text(row.name) || !row.name.trim() || channels.some(r => r.name === row.name) || !revision(row.revision) || !revision(row.runtimeRevision) || !["writable", "protected", "canPause", "canResume"].every(k => typeof row[k] === "boolean") || row.enabled !== null && typeof row.enabled !== "boolean" || !effects.has(row.effective) || row.applyTiming !== "restart_required" || row.protected && (row.writable || row.canPause || row.canResume) || row.canPause && row.canResume || row.canPause && row.effective !== "retrying" || row.canResume && row.effective !== "paused" || row.enabled === null && row.writable) return null;
    channels.push(Object.fromEntries(["name", "enabled", "effective", "revision", "runtimeRevision", "writable", "protected", "canPause", "canResume", "applyTiming"].map(k => [k, row[k]])));
  }
  return { observedAtMs: raw.observedAtMs, sharedScope: raw.sharedScope, mcp, channels };
}

function authorizationUrl(value     ) {
  if (!text(value, 4096)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash && ![...url.searchParams.keys()].some(k => ["client_secret", "access_token", "refresh_token", "password", "token", "code"].includes(k.toLowerCase()));
  } catch { return false; }
}

function connectionReceipt(raw     , allowUrl = false)      {
  if (!record(raw) || !id(raw.mutationId) || !outcomes.has(raw.outcome) || !time(raw.createdAtMs) || !time(raw.expiresAtMs) || !text(raw.name) || !text(raw.operation) || raw.outcome !== "not_found" && (!CONNECTION_OPERATIONS.has(raw.operation) || CONNECTION_READS.has(raw.operation))) return null;
  const result      = Object.fromEntries(["mutationId", "operation", "name", "outcome", "createdAtMs", "expiresAtMs"].map(k => [k, raw[k]]));
  if (raw.outcome === "not_found" && (raw.operation !== "" || raw.name !== "" || raw.createdAtMs !== 0 || raw.expiresAtMs !== 0)) return null;
  if (raw.errorCode != null) {
    if (!Object.hasOwn(CONNECTION_ERRORS, raw.errorCode)) return null;
    result.errorCode = raw.errorCode;
  }
  if (raw.flowId != null) { if (!id(raw.flowId)) return null; result.flowId = raw.flowId; }
  if (raw.toolCount != null) { if (!Number.isSafeInteger(raw.toolCount) || raw.toolCount < 0 || raw.toolCount > 10000) return null; result.toolCount = raw.toolCount; }
  if (raw.observedAtMs != null) { if (!time(raw.observedAtMs)) return null; result.observedAtMs = raw.observedAtMs; }
  if (raw.applyTiming != null) { if (!["active_now", "new_session_or_restart", "restart_required"].includes(raw.applyTiming)) return null; result.applyTiming = raw.applyTiming; }
  if (raw.savedEnabled != null) { if (typeof raw.savedEnabled !== "boolean") return null; result.savedEnabled = raw.savedEnabled; }
  if (raw.effective != null) { if (!effects.has(raw.effective)) return null; result.effective = raw.effective; }
  if (allowUrl && raw.authorizationUrl != null) {
    if (raw.operation !== "mcp.oauthStart" || raw.outcome !== "authorization_required" || !authorizationUrl(raw.authorizationUrl)) return null;
    result.authorizationUrl = raw.authorizationUrl;
  }
  return result;
}

function connectionsManagementResult(identity     , raw     )      {
  const op = identity.operation;
  const snapshot = connectionsSnapshot(raw.connections?.snapshot);
  const receipt = connectionReceipt(raw.connections?.receipt, ["mcp.oauthStart", "mcp.oauthStatus"].includes(op));
  const expected = op === "mcp.oauthCancel" || op === "mcp.oauthStatus" ? "mcp.oauthStart" : op === "mcp.testStatus" ? "mcp.test" : op;
  const valid = op === "connections.read" ? Boolean(snapshot && !receipt) : Boolean(receipt && receipt.mutationId === identity.connections?.mutationId && (op === "connections.receipt" || receipt.outcome === "not_found" && CONNECTION_READS.has(op) || receipt.operation === expected));
  const readback = !receipt || receipt.outcome !== "committed" || !["mcp.enabled", "channels.enabled"].includes(op) || receipt.savedEnabled === identity.connections?.value;
  const envelope = Object.fromEntries(["requestId", "operation", "scope", "profileId"].map(k => [k, identity[k]]));
  if (raw.status === "ok" && valid && readback) return { ...envelope, status: "ok", capabilities: [], connections: op === "connections.read" ? { snapshot } : { receipt } };
  const code = raw.status !== "ok" && Object.hasOwn(CONNECTION_ERRORS, raw.errorCode) ? raw.errorCode : CONNECTION_READS.has(op) ? "native_read_failed" : "outcome_unknown";
  return { ...envelope, status: code === "unsupported" ? "unsupported" : "error", capabilities: [], errorCode: code, errorMessage: CONNECTION_ERRORS[code], ...(receipt && receipt.mutationId === identity.connections?.mutationId ? { connections: { receipt } } : {}) };
}

module.exports = { CONNECTION_OPERATIONS, CONNECTION_READS, CONNECTION_ERRORS, connectionsRequest, connectionsSnapshot, connectionReceipt, connectionsManagementResult };
