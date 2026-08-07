const { formatWorkerHealth } = require("./relay-worker-protocol.cjs");

const DEFAULT_THRESHOLDS = Object.freeze({
  mainDelayedThresholdMs: 2_000,
  mainRecoveredThresholdMs: 800,
  emitHeartbeatMs: 5_000,
  loopLagDegradedP95Ms: 250,
  loopLagRecoveredP95Ms: 100,
});

const MESSAGE_SEND_DEGRADED_DEPTH = 32;

function normalizeNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(Number(value))) return fallback;
  return Math.max(0, Math.floor(Number(value)));
}

function normalizeOptionalNonNegativeInteger(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.floor(Number(value)));
}

function normalizeThresholds(value = {}) {
  return {
    mainDelayedThresholdMs: normalizeNonNegativeInteger(
      value.mainDelayedThresholdMs,
      DEFAULT_THRESHOLDS.mainDelayedThresholdMs,
    ),
    mainRecoveredThresholdMs: normalizeNonNegativeInteger(
      value.mainRecoveredThresholdMs,
      DEFAULT_THRESHOLDS.mainRecoveredThresholdMs,
    ),
    emitHeartbeatMs: normalizeNonNegativeInteger(
      value.emitHeartbeatMs,
      DEFAULT_THRESHOLDS.emitHeartbeatMs,
    ),
    loopLagDegradedP95Ms: normalizeNonNegativeInteger(
      value.loopLagDegradedP95Ms,
      DEFAULT_THRESHOLDS.loopLagDegradedP95Ms,
    ),
    loopLagRecoveredP95Ms: normalizeNonNegativeInteger(
      value.loopLagRecoveredP95Ms,
      DEFAULT_THRESHOLDS.loopLagRecoveredP95Ms,
    ),
  };
}

function normalizeQueueDepthByClass(value) {
  return {
    "message.send": normalizeNonNegativeInteger(
      value && value["message.send"],
      0,
    ),
  };
}

function createRelayWorkerHealthMonitor(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const emitFrame = typeof options.emitFrame === "function" ? options.emitFrame : () => {};
  const emitDebug = typeof options.emitDebug === "function" ? options.emitDebug : () => {};
  const workerEpoch = normalizeNonNegativeInteger(options.workerEpoch, 0);
  const thresholds = normalizeThresholds(options.thresholds);

  let status = "main_disconnected";
  let lastStatusEmitAtMs = null;
  let lastMainHeartbeatAtMs = null;
  let lastMainFrameAtMs = null;
  let lastMainStatusAtMs = null;
  let cachedPagesRevision = null;
  let cachedStatusRevision = null;
  let workerMainQueueDepth = 0;
  let workerMainPostLatencyMs = null;
  let workerQueueDepthByClass = normalizeQueueDepthByClass(null);
  let loopLagP95Ms = null;
  let sendBufferHighWaterClients = 0;

  function nowMs() {
    return normalizeNonNegativeInteger(now(), Date.now());
  }

  function ageFrom(atMs, currentMs) {
    if (atMs === null) return null;
    return Math.max(0, currentMs - atMs);
  }

  function latestMainActivityAtMs() {
    if (lastMainHeartbeatAtMs === null) return lastMainFrameAtMs;
    if (lastMainFrameAtMs === null) return lastMainHeartbeatAtMs;
    return Math.max(lastMainHeartbeatAtMs, lastMainFrameAtMs);
  }

  function updateCachedRevisions(data = {}, atMs = nowMs()) {
    const pagesRevision = normalizeOptionalNonNegativeInteger(data.cachedPagesRevision);
    const statusRevision = normalizeOptionalNonNegativeInteger(data.cachedStatusRevision);
    if (pagesRevision !== null) {
      cachedPagesRevision = pagesRevision;
    }
    if (statusRevision !== null) {
      cachedStatusRevision = statusRevision;
      lastMainStatusAtMs = normalizeOptionalNonNegativeInteger(data.lastMainStatusAtMs) ?? atMs;
    } else if (data.lastMainStatusAtMs !== undefined) {
      lastMainStatusAtMs = normalizeOptionalNonNegativeInteger(data.lastMainStatusAtMs);
    }
  }

  function buildFrame(nextStatus) {
    const atMs = nowMs();
    return formatWorkerHealth({
      workerEpoch,
      workerStatus: nextStatus,
      mainFrameAgeMs: ageFrom(lastMainFrameAtMs, atMs),
      mainHeartbeatAgeMs: ageFrom(lastMainHeartbeatAtMs, atMs),
      workerMainQueueDepth,
      workerMainPostLatencyMs,
      workerQueueDepthByClass,
      cachedPagesRevision,
      cachedStatusRevision,
      lastMainStatusAtMs,
      backpressure: {
        loopLagP95Ms,
        sendBufferHighWaterClients,
        messageSendQueueDepth: workerQueueDepthByClass["message.send"],
      },
    });
  }

  function shouldEmitHeartbeat(atMs) {
    if (lastStatusEmitAtMs === null) return true;
    return thresholds.emitHeartbeatMs > 0 &&
      atMs - lastStatusEmitAtMs >= thresholds.emitHeartbeatMs;
  }

  function setStatus(nextStatus, force = false) {
    const atMs = nowMs();
    const previousStatus = status;
    const transitioned = nextStatus !== previousStatus;

    if (!transitioned && !force && !shouldEmitHeartbeat(atMs)) {
      return status;
    }

    status = nextStatus;
    emitFrame(buildFrame(nextStatus));
    lastStatusEmitAtMs = atMs;

    if (transitioned) {
      emitDebug("worker_health_transition", "info", {
        from: previousStatus,
        to: nextStatus,
        workerEpoch,
        mainFrameAgeMs: ageFrom(lastMainFrameAtMs, atMs),
        mainHeartbeatAgeMs: ageFrom(lastMainHeartbeatAtMs, atMs),
        workerMainQueueDepth,
        workerQueueDepthByClass,
      });
    }

    return status;
  }

  function isDegraded() {
    if (workerQueueDepthByClass["message.send"] >= MESSAGE_SEND_DEGRADED_DEPTH) {
      return true;
    }
    if (sendBufferHighWaterClients >= 1) {
      return true;
    }
    if (loopLagP95Ms !== null) {

      const enterThreshold =
        status === "degraded"
          ? thresholds.loopLagRecoveredP95Ms
          : thresholds.loopLagDegradedP95Ms;
      if (loopLagP95Ms >= enterThreshold) return true;
    }
    return false;
  }

  function computeStatus() {

    if (isDegraded()) {
      return "degraded";
    }
    const mainActivityAtMs = latestMainActivityAtMs();
    if (mainActivityAtMs === null) {
      return "main_disconnected";
    }

    const mainActivityAgeMs = ageFrom(mainActivityAtMs, nowMs());
    if (status === "main_delayed") {
      return mainActivityAgeMs > thresholds.mainRecoveredThresholdMs
        ? "main_delayed"
        : "ready";
    }
    return mainActivityAgeMs >= thresholds.mainDelayedThresholdMs
      ? "main_delayed"
      : "ready";
  }

  function recordMainHeartbeat(data = {}) {
    const atMs = nowMs();
    lastMainHeartbeatAtMs = atMs;
    updateCachedRevisions(data, atMs);
    return setStatus(computeStatus(), true);
  }

  function recordMainFrame(data = {}) {
    const atMs = nowMs();
    lastMainFrameAtMs = atMs;
    updateCachedRevisions(data, atMs);
    return setStatus(computeStatus());
  }

  function updateQueueDepth(nextDepthByClass = {}) {
    workerQueueDepthByClass = normalizeQueueDepthByClass(nextDepthByClass);
    return status;
  }

  function updateLoopLagP95Ms(value) {
    loopLagP95Ms = normalizeOptionalNonNegativeInteger(value);
    return status;
  }

  function updateSendBufferHighWaterClients(value) {
    sendBufferHighWaterClients = normalizeNonNegativeInteger(value, 0);
    return status;
  }

  function updateWorkerMainQueueDepth(value) {
    workerMainQueueDepth = normalizeNonNegativeInteger(value, 0);
    return status;
  }

  function updateWorkerMainPostLatencyMs(value) {
    workerMainPostLatencyMs = normalizeOptionalNonNegativeInteger(value);
    return status;
  }

  function markRestarting() {
    return setStatus("restarting", true);
  }

  function sample() {
    return setStatus(computeStatus());
  }

  function currentStatus() {
    return status;
  }

  return {
    recordMainHeartbeat,
    recordMainFrame,
    updateQueueDepth,
    updateLoopLagP95Ms,
    updateSendBufferHighWaterClients,
    updateWorkerMainQueueDepth,
    updateWorkerMainPostLatencyMs,
    markRestarting,
    sample,
    currentStatus,
  };
}

module.exports = { createRelayWorkerHealthMonitor };
