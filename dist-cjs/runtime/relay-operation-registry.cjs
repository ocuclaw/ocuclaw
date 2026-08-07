const SLOW_BUCKETS_MS = [5_000, 10_000, 30_000, 60_000];

function createRelayOperationRegistry(options) {
  const now = options.now || Date.now;
  const retentionMs = options.retentionMs || 90_000;
  const entriesByRequestId = new Map();
  const requestIdByRunId = new Map();

  function prune(nowMs = now()) {
    for (const [requestId, entry] of entriesByRequestId) {
      if (nowMs - entry.receivedAtMs > retentionMs) {
        entriesByRequestId.delete(requestId);
        for (const [runId, mappedRequestId] of requestIdByRunId) {
          if (mappedRequestId === requestId) {
            requestIdByRunId.delete(runId);
          }
        }
      }
    }
  }

  function receiptFrame(entry) {
    return JSON.stringify({
      type: "ocuclaw.operation.received",
      requestId: entry.requestId,
      operation: entry.operation,
      status: "upstream_pending",
      phase: "relay_received",
      receivedAtMs: entry.receivedAtMs,
    });
  }

  function beginMessageSend(params) {
    prune();
    const existing = entriesByRequestId.get(params.requestId);
    if (existing) {
      options.emitDebug(
        "operation_received",
        "info",
        {
          requestId: existing.requestId,
          operation: existing.operation,
          class: existing.class,
          clientId: existing.clientId,
          sessionKey: existing.sessionKey,
          duplicate: true,
          retainedFinal: existing.finalFrame !== null,
        },
        { sessionKey: existing.sessionKey },
      );
      return {
        duplicate: true,
        receipt: receiptFrame(existing),
        finalFrame: existing.finalFrame,
        complete: (finalFrame, result = {}) =>
          complete(existing.requestId, finalFrame, result),
        fail: (finalFrame, result = {}) =>
          fail(existing.requestId, finalFrame, result),
      };
    }

    const receivedAtMs = now();
    const entry = {
      requestId: params.requestId,
      operation: "message.send",
      class: "transactional",
      clientId: params.clientId,
      sessionKey: params.sessionKey || null,
      receivedAtMs,
      startedAtMs: null,
      upstreamAckAtMs: null,
      lifecycleStartAtMs: null,
      firstStreamAtMs: null,
      completedAtMs: null,
      finalFrame: null,
      slowBuckets: new Set(),
    };
    entriesByRequestId.set(entry.requestId, entry);
    options.emitDebug(
      "operation_received",
      "info",
      {
        requestId: entry.requestId,
        operation: entry.operation,
        class: entry.class,
        clientId: entry.clientId,
        sessionKey: entry.sessionKey,
        duplicate: false,
      },
      { sessionKey: entry.sessionKey },
    );
    return {
      duplicate: false,
      receipt: receiptFrame(entry),
      finalFrame: null,
      complete: (finalFrame, result = {}) => complete(entry.requestId, finalFrame, result),
      fail: (finalFrame, result = {}) => fail(entry.requestId, finalFrame, result),
    };
  }

  function markStarted(requestId) {
    const entry = entriesByRequestId.get(requestId);
    if (!entry || entry.startedAtMs !== null) return;
    entry.startedAtMs = now();
    options.emitDebug(
      "operation_started",
      "debug",
      {
        requestId,
        operation: entry.operation,
        class: entry.class,
        elapsedMs: entry.startedAtMs - entry.receivedAtMs,
      },
      { sessionKey: entry.sessionKey },
    );
  }

  function markUpstreamAck(requestId, params = {}) {
    const entry = entriesByRequestId.get(requestId);
    if (!entry) return;
    entry.upstreamAckAtMs = now();
    if (params.runId) requestIdByRunId.set(params.runId, requestId);
    options.emitDebug(
      "operation_phase",
      "debug",
      {
        requestId,
        operation: entry.operation,
        class: entry.class,
        phase: "upstream_ack",
        status: params.status || null,
        elapsedMs: entry.upstreamAckAtMs - entry.receivedAtMs,
        upstreamAckMs: entry.upstreamAckAtMs - entry.receivedAtMs,
      },
      { sessionKey: entry.sessionKey, runId: params.runId || null },
    );
  }

  function markRunPhase(runId, phase) {
    const requestId = requestIdByRunId.get(runId);
    if (!requestId) return;
    const entry = entriesByRequestId.get(requestId);
    if (!entry) return;
    const atMs = now();
    if (phase === "lifecycle_start" && entry.lifecycleStartAtMs === null) {
      entry.lifecycleStartAtMs = atMs;
    }
    if (phase === "first_stream" && entry.firstStreamAtMs === null) {
      entry.firstStreamAtMs = atMs;
    }
    if (phase === "complete") {
      entry.completedAtMs = atMs;
    }
    options.emitDebug(
      "operation_phase",
      "debug",
      {
        requestId,
        operation: entry.operation,
        class: entry.class,
        phase,
        elapsedMs: atMs - entry.receivedAtMs,
        ackToPhaseMs: entry.upstreamAckAtMs ? atMs - entry.upstreamAckAtMs : null,
        lifecycleStartMs: entry.lifecycleStartAtMs
          ? entry.lifecycleStartAtMs - entry.receivedAtMs
          : null,
        firstStreamMs: entry.firstStreamAtMs
          ? entry.firstStreamAtMs - entry.receivedAtMs
          : null,
      },
      { sessionKey: entry.sessionKey, runId },
    );
  }

  function complete(requestId, finalFrame, result = {}) {
    const entry = entriesByRequestId.get(requestId);
    if (!entry) return;
    const completedAtMs = now();
    entry.completedAtMs = completedAtMs;
    entry.finalFrame = finalFrame;
    options.emitDebug(
      "operation_completed",
      "info",
      {
        requestId,
        operation: entry.operation,
        class: entry.class,
        elapsedMs: completedAtMs - entry.receivedAtMs,
        resultSource: "typed_final_frame",
        ...result,
      },
      { sessionKey: entry.sessionKey },
    );
  }

  function fail(requestId, finalFrame, result = {}) {
    const entry = entriesByRequestId.get(requestId);
    if (!entry) return;
    const failedAtMs = now();
    entry.completedAtMs = failedAtMs;
    entry.finalFrame = finalFrame;
    options.emitDebug(
      "operation_failed",
      "warn",
      {
        requestId,
        operation: entry.operation,
        class: entry.class,
        elapsedMs: failedAtMs - entry.receivedAtMs,
        ...result,
      },
      { sessionKey: entry.sessionKey },
    );
  }

  function queueDepthSnapshot() {
    prune();
    let transactional = 0;
    for (const entry of entriesByRequestId.values()) {
      if (!entry.completedAtMs && entry.class === "transactional") transactional += 1;
    }
    return {
      transactional,
      latestMutation: 0,
      coalescableRead: 0,
      bestEffort: 0,
    };
  }

  function reconcileRequestIds(requestIds) {
    prune();
    const ids = Array.isArray(requestIds) ? requestIds : [];
    return ids
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
      .map((requestId) => {
        const entry = entriesByRequestId.get(requestId);
        if (!entry) {
          return {
            requestId,
            known: false,
            receiptFrame: null,
            finalFrame: null,
          };
        }
        return {
          requestId,
          known: true,
          receiptFrame: receiptFrame(entry),
          finalFrame: entry.finalFrame || null,
        };
      });
  }

  return {
    beginMessageSend,
    markStarted,
    markUpstreamAck,
    markRunPhase,
    queueDepthSnapshot,
    reconcileRequestIds,
  };
}

module.exports = { createRelayOperationRegistry };
