const { activeBackendDisplayName } = require("../gateway/backend-contract.cjs");

const APP_PROTOCOL = Object.freeze({
  messageSend: "ocuclaw.message.send",
  messageSendAck: "ocuclaw.message.send.ack",
  operationReceived: "ocuclaw.operation.received",
  workerOperationReceived: "ocuclaw.worker.operation.received",
  workerHealth: "ocuclaw.worker.health",
  protocolHelloAck: "protocolHelloAck",
  resumeAck: "ocuclaw.sync.resume.ack",
  entries: "ocuclaw.ledger.entries",
  pages: "ocuclaw.view.pages.snapshot",
  status: "ocuclaw.runtime.status",
  debugConfigSnapshot: "ocuclaw.debug.config.snapshot",
  avatarFetch: "ocuclaw.avatar.fetch",
  avatarBlob: "ocuclaw.avatar.blob",
  readinessSnapshot: "ocuclaw.readiness.snapshot",
  readinessProbeRequest: "ocuclaw.readiness.probe.request",
  readinessProbeAck: "ocuclaw.readiness.probe.ack",
  automationStateGet: "ocuclaw.automation.state.get",
  automationStateSnapshot: "ocuclaw.automation.state.snapshot",
  automationRegistryGet: "ocuclaw.automation.registry.get",
  automationRegistry: "ocuclaw.automation.registry",
  approvalRequest: "ocuclaw.approval.request",
  approvalResolved: "ocuclaw.approval.resolved",
  sessionContextSnapshot: "ocuclaw.session.context.snapshot",
  sessionCompact: "ocuclaw.session.compact",
  sessionCompactAck: "ocuclaw.session.compact.ack",
  visibility: "visibility",
});

const WORKER_FEATURES = Object.freeze([
  "worker-health",
  "worker-receipts",
  "worker-resume-metadata",
  "message-send-worker-queue",
  "ledgerV1",
]);

const DEFAULT_WORKER_QUEUE_CAPS = Object.freeze({
  messageSendMaxEntries: 32,
  messageSendTtlMs: 30_000,
  retainedFinalTtlMs: 30_000,
  oldEpochPendingHardCapMs: 90_000,
});

const DEFAULT_WORKER_HEALTH_THRESHOLDS = Object.freeze({
  mainDelayedThresholdMs: 2_000,
  mainRecoveredThresholdMs: 800,
  mainStaleResumeThresholdMs: 5_000,
  heartbeatIntervalMs: 1_000,
  emitHeartbeatMs: 5_000,
  loopLagDegradedP95Ms: 250,
  loopLagRecoveredP95Ms: 100,
});

const DEFAULT_NUDGE_THRESHOLDS = Object.freeze({
  nudgeActiveIntervalMs: 150,
  nudgeSlowIntervalMs: 1000,
  nudgeIdleDeactivateMs: 5000,
  nudgeHeartbeatIntervalMs: 10000,
  nudgeHardTimeoutMs: 60000,
});

const DEFAULT_WORKER_RPC_LIMITS = Object.freeze({
  mainRequestTimeoutMs: 5_000,
  httpRequestTimeoutMs: 60_000,
  httpMaxBodyBytes: 65_536,
  httpMaxResponseBytes: 262_144,

  wsMaxMessageBytes: 25 * 1024 * 1024,
});

const ALLOWED_WORKER_STATUSES = new Set([
  "ready",
  "main_delayed",
  "main_disconnected",
  "restarting",
  "degraded",
]);
const ALLOWED_CACHE_STATES = new Set(["fresh", "stale", "empty", "warming"]);
const WORKER_QUEUE_CLASSES = Object.freeze(["message.send"]);

function normalizeRequestId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseNonNegativeRevision(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  const num = Math.floor(Number(value));
  return num >= 0 ? num : null;
}

function parseNonNegativeInteger(value) {
  return parseNonNegativeRevision(value);
}

function parseOptionalInteger(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : null;
}

function parseNonNegativeDuration(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.floor(Number(value)));
}

function normalizeWorkerStatus(value) {
  return ALLOWED_WORKER_STATUSES.has(value) ? value : "ready";
}

function normalizeCacheState(value) {
  return ALLOWED_CACHE_STATES.has(value) ? value : null;
}

function normalizeWorkerQueueDepthByClass(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const depths = {};
  for (const className of WORKER_QUEUE_CLASSES) {
    const parsed = parseNonNegativeInteger(source[className]);
    depths[className] = parsed === null ? 0 : parsed;
  }
  return depths;
}

function normalizeRequestIdList(value) {
  if (!Array.isArray(value)) return null;
  const ids = [];
  for (const entry of value) {
    const requestId = normalizeRequestId(entry);
    if (requestId) {
      ids.push(requestId);
    }
  }
  return ids;
}

function estimateJsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function parseMessageType(message) {
  try {
    const parsed = typeof message === "string" ? JSON.parse(message) : message;
    return parsed && typeof parsed.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

function normalizeBackpressure(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    loopLagP95Ms: parseNonNegativeDuration(v.loopLagP95Ms),
    sendBufferHighWaterClients: parseNonNegativeInteger(v.sendBufferHighWaterClients) ?? 0,
    messageSendQueueDepth: parseNonNegativeInteger(v.messageSendQueueDepth) ?? 0,
  };
}

function formatWorkerHealth(data = {}) {
  return JSON.stringify({
    type: APP_PROTOCOL.workerHealth,
    workerEpoch: parseNonNegativeInteger(data.workerEpoch) ?? 0,
    workerStatus: normalizeWorkerStatus(data.workerStatus),
    mainFrameAgeMs: parseNonNegativeDuration(data.mainFrameAgeMs),
    mainHeartbeatAgeMs: parseNonNegativeDuration(data.mainHeartbeatAgeMs),
    workerMainQueueDepth: parseNonNegativeInteger(data.workerMainQueueDepth) ?? 0,
    workerMainPostLatencyMs: parseNonNegativeDuration(data.workerMainPostLatencyMs),
    workerQueueDepthByClass: normalizeWorkerQueueDepthByClass(data.workerQueueDepthByClass),
    cachedPagesRevision: parseNonNegativeRevision(data.cachedPagesRevision),
    cachedStatusRevision: parseNonNegativeRevision(data.cachedStatusRevision),
    lastMainStatusAtMs: parseNonNegativeInteger(data.lastMainStatusAtMs),
    backpressure: normalizeBackpressure(data.backpressure),
  });
}

function formatWorkerOperationReceived(data) {
  const requestId = normalizeRequestId(data && data.requestId);
  if (!requestId) throw new Error("worker receipt requires requestId");
  return JSON.stringify({
    type: APP_PROTOCOL.workerOperationReceived,
    requestId,
    operation: data.operation || "message.send",
    status: "worker_pending",
    phase: "worker_received",
    workerEpoch: parseNonNegativeInteger(data.workerEpoch) ?? 0,
    receivedAtMs: parseNonNegativeInteger(data.receivedAtMs) ?? Date.now(),
  });
}

function formatMainOperationReceived(data) {
  const requestId = normalizeRequestId(data && data.requestId);
  if (!requestId) throw new Error("main receipt requires requestId");
  return JSON.stringify({
    type: APP_PROTOCOL.operationReceived,
    requestId,
    operation: data.operation || "message.send",
    status: data.status || "upstream_pending",
    phase: data.phase || "relay_received",
    receivedAtMs: parseNonNegativeInteger(data.receivedAtMs) ?? Date.now(),
  });
}

function formatSendAck(requestId, status, error, errorCode, data = {}) {
  const id = normalizeRequestId(requestId);
  const msg = { type: APP_PROTOCOL.messageSendAck, requestId: id, status };
  if (error !== undefined) msg.error = error;
  if (errorCode !== undefined) msg.errorCode = errorCode;
  if (data && typeof data.runId === "string" && data.runId.trim()) {
    msg.runId = data.runId.trim();
  }
  return JSON.stringify(msg);
}

function formatWorkerQueueTimeoutAck(requestId) {
  return formatSendAck(
    requestId,
    "rejected",
    `${activeBackendDisplayName()} did not accept the message before the relay worker queue timeout.`,
    "worker_queue_timeout",
  );
}

function formatWorkerRestartUncertainAck(requestId) {
  return formatSendAck(
    requestId,
    "rejected",
    `The relay worker restarted before ${activeBackendDisplayName()} accepted the message. Retry may resend the message.`,
    "worker_restarted_before_main_accept",
  );
}

function formatProtocolHelloAck(payload = {}) {
  const value = { ...payload };
  const ack = {
    type: APP_PROTOCOL.protocolHelloAck,
    protocolVersion: value.protocolVersion || "v2",
    supportedProtocolVersions: Array.isArray(value.supportedProtocolVersions)
      ? value.supportedProtocolVersions
      : ["v2"],
    reason: value.reason || null,
    deprecatedV1: false,
  };
  if (typeof value.pluginVersion === "string" && value.pluginVersion) ack.pluginVersion = value.pluginVersion;
  if (typeof value.requiresClientVersion === "string" && value.requiresClientVersion) ack.requiresClientVersion = value.requiresClientVersion;
  if (typeof value.pluginId === "string" && value.pluginId) ack.pluginId = value.pluginId;
  if (typeof value.backendKind === "string" && value.backendKind) ack.backendKind = value.backendKind;
  const workerEpoch = parseNonNegativeInteger(value.workerEpoch);
  if (workerEpoch !== null) ack.workerEpoch = workerEpoch;
  if (Array.isArray(value.workerFeatures)) ack.workerFeatures = value.workerFeatures;
  return JSON.stringify(ack);
}

function formatResumeAck(payload = {}) {
  const value = { ...payload };
  const msg = {
    type: APP_PROTOCOL.resumeAck,
    reason: value.reason || null,
    sentPages: !!value.sentPages,
    sentEntries: !!value.sentEntries,
    sentStatus: !!value.sentStatus,
    sentApprovals: parseNonNegativeInteger(value.sentApprovals) ?? 0,
    pagesRevision: parseNonNegativeRevision(value.pagesRevision),
    entriesRevision: parseNonNegativeRevision(value.entriesRevision),
    lastSeq: parseOptionalInteger(value.lastSeq),
    statusRevision: parseNonNegativeRevision(value.statusRevision),
  };
  for (const key of [
    "workerEpoch",
    "previousWorkerEpoch",
    "cachedPagesRevision",
    "cachedStatusRevision",
  ]) {
    const parsed = parseNonNegativeRevision(value[key]);
    if (parsed !== null) msg[key] = parsed;
  }
  for (const key of ["workerRestarted", "mainStale", "resumeProvisional"]) {
    if (value[key] !== undefined) msg[key] = !!value[key];
  }
  const cacheState = normalizeCacheState(value.cacheState);
  if (cacheState) msg.cacheState = cacheState;
  const workerOnlyPendingRequestIds = normalizeRequestIdList(
    value.workerOnlyPendingRequestIds,
  );
  if (workerOnlyPendingRequestIds) {
    msg.workerOnlyPendingRequestIds = workerOnlyPendingRequestIds;
  }
  const unresolvedWorkerPendingRequestIds = normalizeRequestIdList(
    value.unresolvedWorkerPendingRequestIds,
  );
  if (unresolvedWorkerPendingRequestIds) {
    msg.unresolvedWorkerPendingRequestIds = unresolvedWorkerPendingRequestIds;
  }
  return JSON.stringify(msg);
}

module.exports = { APP_PROTOCOL, WORKER_FEATURES, DEFAULT_WORKER_QUEUE_CAPS, DEFAULT_WORKER_HEALTH_THRESHOLDS, DEFAULT_NUDGE_THRESHOLDS, DEFAULT_WORKER_RPC_LIMITS, normalizeRequestId, parseNonNegativeRevision, estimateJsonByteLength, parseMessageType, formatWorkerHealth, formatWorkerOperationReceived, formatMainOperationReceived, formatSendAck, formatWorkerQueueTimeoutAck, formatWorkerRestartUncertainAck, formatProtocolHelloAck, formatResumeAck };
