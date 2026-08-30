const { formatSendAck, formatWorkerOperationReceived, formatWorkerQueueTimeoutAck, formatWorkerRestartUncertainAck, normalizeRequestId } = require("./relay-worker-protocol.cjs");

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_RETAINED_FINAL_TTL_MS = 30_000;

function normalizeNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(Number(value))) return fallback;
  return Math.max(0, Math.floor(Number(value)));
}

function makeFinalResult(entry, finalFrame, reason) {
  return {
    clientId: entry.clientId,
    requestId: entry.requestId,
    finalFrame,
    reason,
  };
}

function createWorkerMessageSendQueue(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const workerEpoch = normalizeNonNegativeInteger(options.workerEpoch, 0);
  const maxEntries = normalizeNonNegativeInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const ttlMs = normalizeNonNegativeInteger(options.ttlMs, DEFAULT_TTL_MS);
  const retainedFinalTtlMs = normalizeNonNegativeInteger(
    options.retainedFinalTtlMs,
    DEFAULT_RETAINED_FINAL_TTL_MS,
  );
  const entries = new Map();
  const retainedFinals = new Map();

  function nowMs() {
    return normalizeNonNegativeInteger(now(), Date.now());
  }

  function pruneRetainedFinals(atMs = nowMs()) {
    for (const [requestId, retained] of retainedFinals.entries()) {
      if (retained.expiresAtMs <= atMs) {
        retainedFinals.delete(requestId);
      }
    }
  }

  function retainFinal(requestId, finalFrame, atMs = nowMs()) {
    if (!requestId || retainedFinalTtlMs <= 0) return;
    retainedFinals.set(requestId, {
      finalFrame,
      expiresAtMs: atMs + retainedFinalTtlMs,
    });
  }

  function enqueue(raw = {}) {
    const atMs = nowMs();
    pruneRetainedFinals(atMs);

    const requestId = normalizeRequestId(raw.requestId);
    if (!requestId) {
      return {
        status: "rejected",
        finalFrame: formatSendAck(null, "rejected", "Missing or invalid requestId.", "invalid_request"),
      };
    }

    const retainedFinal = retainedFinals.get(requestId);
    if (retainedFinal) {
      return {
        status: "duplicate_final",
        finalFrame: retainedFinal.finalFrame,
      };
    }

    const existing = entries.get(requestId);
    if (existing) {
      return {
        status: "duplicate_queued",
        receipt: existing.receipt,
      };
    }

    if (entries.size >= maxEntries) {
      const finalFrame = formatSendAck(
        requestId,
        "rejected",
        "Relay worker message queue is full.",
        "worker_queue_full",
      );
      retainFinal(requestId, finalFrame, atMs);
      return {
        status: "rejected",
        finalFrame,
      };
    }

    const receipt = formatWorkerOperationReceived({
      requestId,
      operation: "message.send",
      workerEpoch,
      receivedAtMs: atMs,
    });
    entries.set(requestId, {
      clientId: raw.clientId,
      requestId,
      text: raw.text,
      sessionKey: raw.sessionKey,
      attachment: raw.attachment,
      receipt,
      workerEpoch,
      queuedAtMs: atMs,
      expiresAtMs: atMs + ttlMs,
    });
    return {
      status: "queued",
      receipt,
    };
  }

  function drainReady(limit = entries.size) {
    const max = normalizeNonNegativeInteger(limit, entries.size);
    const drained = [];
    for (const [requestId, entry] of entries.entries()) {
      if (drained.length >= max) break;
      entries.delete(requestId);
      drained.push({ ...entry });
    }
    return drained;
  }

  function expire() {
    const atMs = nowMs();
    pruneRetainedFinals(atMs);
    const expired = [];
    for (const [requestId, entry] of entries.entries()) {
      if (entry.expiresAtMs > atMs) continue;
      entries.delete(requestId);
      const finalFrame = formatWorkerQueueTimeoutAck(requestId);
      retainFinal(requestId, finalFrame, atMs);
      expired.push(makeFinalResult(entry, finalFrame, "worker_queue_timeout"));
    }
    return expired;
  }

  function settle(requestId) {
    const id = normalizeRequestId(requestId);
    if (!id) return false;
    return entries.delete(id);
  }

  function depthSnapshot() {
    return { "message.send": entries.size };
  }

  function reconcileOldEpochPending(params = {}) {
    const atMs = nowMs();
    pruneRetainedFinals(atMs);
    const mainResults = new Map();
    for (const result of Array.isArray(params.mainResults) ? params.mainResults : []) {
      const requestId = normalizeRequestId(result && result.requestId);
      if (requestId) {
        mainResults.set(requestId, result);
      }
    }

    const results = [];
    for (const rawRequestId of Array.isArray(params.requestIds) ? params.requestIds : []) {
      const requestId = normalizeRequestId(rawRequestId);
      if (!requestId) continue;
      const mainResult = mainResults.get(requestId);
      if (mainResult && mainResult.known) {
        const forwarded = { requestId };
        if (mainResult.receiptFrame) forwarded.receiptFrame = mainResult.receiptFrame;
        if (mainResult.finalFrame) forwarded.finalFrame = mainResult.finalFrame;
        results.push(forwarded);
        continue;
      }

      const finalFrame = formatWorkerRestartUncertainAck(requestId);
      retainFinal(requestId, finalFrame, atMs);
      results.push({
        requestId,
        finalFrame,
        reason: "worker_restarted_before_main_accept",
      });
    }
    return results;
  }

  return {
    enqueue,
    drainReady,
    expire,
    settle,
    depthSnapshot,
    reconcileOldEpochPending,
  };
}

module.exports = { createWorkerMessageSendQueue };
