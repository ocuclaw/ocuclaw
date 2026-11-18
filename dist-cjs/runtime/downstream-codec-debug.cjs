const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");

function formatDebugSet(data) {
  return JSON.stringify({
    type: "debug-set",
    ...data,
  });
}

function formatDebugDump(data) {
  return JSON.stringify({
    type: "debug-dump",
    ...data,
  });
}

function formatTraceLog(data) {
  return JSON.stringify({ type: "trace-log", ...data });
}

function formatDebugConfigSnapshot(data) {
  const enabled = Array.isArray(data && data.enabled)
    ? data.enabled
        .filter(
          (entry) =>
            entry &&
            typeof entry.cat === "string" &&
            entry.cat.trim() &&
            Number.isFinite(Number(entry.expiresAtMs)),
        )
        .map((entry) => ({
          cat: entry.cat.trim(),
          expiresAtMs: Math.floor(Number(entry.expiresAtMs)),
        }))
    : [];
  return JSON.stringify({
    type: APP_PROTOCOL.debugConfigSnapshot,
    serverNowMs:
      Number.isFinite(data && data.serverNowMs)
        ? Math.floor(data.serverNowMs)
        : 0,
    enabled,
  });
}

function formatRemoteControl(data) {
  return JSON.stringify({
    type: APP_PROTOCOL.remoteControl,
    ...data,
  });
}

function formatRemoteControlAck(data) {
  return JSON.stringify({
    type: "remote-control-ack",
    ...data,
  });
}

function formatAutomationStateRequest(data) {
  return JSON.stringify({
    type: APP_PROTOCOL.automationStateGet,
    requestId:
      data && typeof data.requestId === "string" && data.requestId
        ? data.requestId
        : null,
    sessionKey:
      data && typeof data.sessionKey === "string" && data.sessionKey
        ? data.sessionKey
        : null,
  });
}

function formatAutomationRegistryRequest() {
  return JSON.stringify({
    type: APP_PROTOCOL.automationRegistryGet,
  });
}

function formatAutomationStateSnapshot(data) {
  return JSON.stringify({
    type: APP_PROTOCOL.automationStateSnapshot,
    ok: data && data.ok !== false,
    requestId:
      data && typeof data.requestId === "string" && data.requestId
        ? data.requestId
        : null,
    state:
      data && data.state && typeof data.state === "object" ? data.state : null,
    reasonCode:
      data && typeof data.reasonCode === "string" && data.reasonCode
        ? data.reasonCode
        : null,
    message:
      data && typeof data.message === "string" && data.message
        ? data.message
        : null,
  });
}

function formatAutomationRegistry(data) {

  const schemaVersion =
    data && Number.isInteger(data.schemaVersion) && data.schemaVersion >= 1
      ? data.schemaVersion
      : 1;
  return JSON.stringify({
    type: APP_PROTOCOL.automationRegistry,
    schemaVersion,
    entries: data && Array.isArray(data.entries) ? data.entries : [],
  });
}

function formatReadinessProbeRequest(data) {
  return JSON.stringify({
    type: APP_PROTOCOL.readinessProbeRequest,
    requestId:
      data && typeof data.requestId === "string" && data.requestId
        ? data.requestId
        : null,
    sinceMs:
      data && Number.isFinite(Number(data.sinceMs))
        ? Math.max(0, Math.floor(Number(data.sinceMs)))
        : 0,
    sessionKey:
      data && typeof data.sessionKey === "string" && data.sessionKey
        ? data.sessionKey
        : null,
  });
}

function formatReadinessProbeAck(data) {
  return JSON.stringify({
    type: APP_PROTOCOL.readinessProbeAck,
    ok: data && data.ok !== false,
    requestId:
      data && typeof data.requestId === "string" && data.requestId
        ? data.requestId
        : null,
    reasonCode:
      data && typeof data.reasonCode === "string" && data.reasonCode
        ? data.reasonCode
        : null,
    message:
      data && typeof data.message === "string" && data.message
        ? data.message
        : null,
    activeSessionKey:
      data && typeof data.activeSessionKey === "string" && data.activeSessionKey
        ? data.activeSessionKey
        : null,
    emittedAtMs:
      data && Number.isFinite(Number(data.emittedAtMs))
        ? Math.max(0, Math.floor(Number(data.emittedAtMs)))
        : null,
    clientId:
      data && typeof data.clientId === "string" && data.clientId
        ? data.clientId
        : null,
    clientName:
      data && typeof data.clientName === "string" && data.clientName
        ? data.clientName
        : null,
    clientVersion:
      data && typeof data.clientVersion === "string" && data.clientVersion
        ? data.clientVersion
        : null,
  });
}

module.exports = { formatDebugSet, formatDebugDump, formatTraceLog, formatDebugConfigSnapshot, formatRemoteControl, formatRemoteControlAck, formatAutomationStateRequest, formatAutomationRegistryRequest, formatAutomationStateSnapshot, formatAutomationRegistry, formatReadinessProbeRequest, formatReadinessProbeAck };
