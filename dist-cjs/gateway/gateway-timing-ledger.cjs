const AGENT_ACK_SLOW_MS = 1000;
const AGENT_LIFECYCLE_WAIT_SLOW_MS = 1500;
const GATEWAY_REQUEST_SLOW_MS = 1500;
const ACCEPTED_RUN_TTL_MS = 120000;

const CATEGORY_RELAY_PROTOCOL = "relay.protocol";
const CATEGORY_OPENCLAW_RUN = "openclaw.run";

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function pickId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function pickBoolean(value) {
  return value === true ? true : value === false ? false : null;
}

function pickNonNegativeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return null;
}

function textCharsFromParams(params) {
  if (!isObject(params)) return null;
  if (typeof params.message === "string") return params.message.length;
  if (typeof params.text === "string") return params.text.length;
  return null;
}

function attachmentBytesFromAttachment(attachment) {
  if (!isObject(attachment)) return 0;
  const explicit =
    pickNonNegativeNumber(attachment.bytes) ??
    pickNonNegativeNumber(attachment.byteLength) ??
    pickNonNegativeNumber(attachment.size);
  if (explicit != null) return explicit;
  if (typeof attachment.content === "string") return attachment.content.length;
  if (typeof attachment.base64Data === "string") return attachment.base64Data.length;
  if (typeof attachment.data === "string") return attachment.data.length;
  return 0;
}

function attachmentSummaryFromParams(params) {
  if (!isObject(params)) {
    return { hasAttachment: false, attachmentBytes: 0 };
  }
  const attachments = Array.isArray(params.attachments) ? params.attachments : [];
  let attachmentBytes = 0;
  for (const attachment of attachments) {
    attachmentBytes += attachmentBytesFromAttachment(attachment);
  }
  return {
    hasAttachment: attachments.length > 0,
    attachmentBytes,
  };
}

function sanitizeDiagnostic(args) {
  const diagnostic = isObject(args.diagnostic) ? args.diagnostic : {};
  const params = isObject(args.params) ? args.params : {};
  const attachmentSummary = attachmentSummaryFromParams(params);
  const textChars =
    pickNonNegativeNumber(diagnostic.textChars) ?? textCharsFromParams(params) ?? 0;
  const attachmentBytes =
    pickNonNegativeNumber(diagnostic.attachmentBytes) ??
    attachmentSummary.attachmentBytes;
  const hasAttachment =
    pickBoolean(diagnostic.hasAttachment) ?? attachmentSummary.hasAttachment;
  return {
    messageId: pickId(diagnostic.messageId ?? args.messageId),
    sessionKey: pickId(diagnostic.sessionKey ?? args.sessionKey),
    source: pickId(diagnostic.source ?? args.source),
    textChars,
    hasAttachment,
    attachmentBytes,
  };
}

function responseStatus(args) {
  return pickId(args.status ?? (isObject(args.response) ? args.response.status : null));
}

function responseRunId(args) {
  return pickId(args.runId ?? (isObject(args.response) ? args.response.runId : null));
}

function responseErrorCode(args) {
  if (args.errorCode != null) return pickId(args.errorCode);
  if (isObject(args.error) && args.error.code != null) return pickId(args.error.code);
  if (isObject(args.response) && args.response.errorCode != null) {
    return pickId(args.response.errorCode);
  }
  return null;
}

function gatewayEventText(args) {
  if (typeof args.text === "string") return args.text;
  if (isObject(args.data) && typeof args.data.text === "string") {
    return args.data.text;
  }
  if (isObject(args.payload) && typeof args.payload.text === "string") {
    return args.payload.text;
  }
  return null;
}

function isAgentGatewayEvent(args) {
  const kind = pickId(args.kind ?? args.type ?? args.eventType);
  if (kind === "agent") return true;
  if (kind != null && kind !== "agent") return false;
  return pickId(args.runId) != null;
}

function safeLoggerWarn(logger, message) {
  if (!logger) return;
  if (typeof logger.warn === "function") {
    logger.warn(message);
    return;
  }
  if (typeof logger === "function") {
    logger(message);
  }
}

function createGatewayTimingLedger(opts = {}) {
  const getNow = typeof opts.now === "function" ? opts.now : () => Date.now();
  const emitTiming =
    typeof opts.emitTiming === "function" ? opts.emitTiming : () => {};
  const setTimer =
    typeof opts.setTimer === "function" ? opts.setTimer : setTimeout;
  const clearTimer =
    typeof opts.clearTimer === "function" ? opts.clearTimer : clearTimeout;
  let logger = opts.logger || null;
  const requests = new Map();
  const acceptedRuns = new Map();

  function nowMs() {
    const value = Number(getNow());
    return Number.isFinite(value) ? Math.floor(value) : Date.now();
  }

  function emit(category, event, severity, context, data) {
    emitTiming({
      category,
      event,
      severity,
      context: context || {},
      data: data || {},
    });
  }

  function clearTimerRef(ref) {
    if (ref == null) return;
    clearTimer(ref);
  }

  function armDiagnosticTimer(fn, delayMs) {
    const timer = setTimer(fn, delayMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    return timer;
  }

  function requestContext(request) {
    return {
      requestId: request.requestId,
      method: request.method,
      messageId: request.messageId,
      sessionKey: request.sessionKey,
      source: request.source,
    };
  }

  function runContext(run) {
    return {
      runId: run.runId,
      requestId: run.requestId,
      messageId: run.messageId,
      sessionKey: run.sessionKey,
      source: run.source,
    };
  }

  function scheduleRequestSlowTimer(request) {
    const thresholdMs =
      request.method === "agent" ? AGENT_ACK_SLOW_MS : GATEWAY_REQUEST_SLOW_MS;
    request.slowTimer = armDiagnosticTimer(() => {
      if (request.slowEmitted) return;
      request.slowEmitted = true;
      const elapsedMs = Math.max(0, nowMs() - request.sentAtMs);
      const data = {
        requestId: request.requestId,
        method: request.method,
        elapsedMs,
        thresholdMs,
        pendingRequests: requests.size,
        expectFinal: request.expectFinal,
        sessionKey: request.sessionKey,
        messageId: request.messageId,
        source: request.source,
      };
      emit(
        CATEGORY_RELAY_PROTOCOL,
        "gateway_request_slow",
        "warn",
        requestContext(request),
        data,
      );
      safeLoggerWarn(
        logger,
        `[openclaw-timing] slow request method=${request.method} requestId=${request.requestId} elapsedMs=${elapsedMs} pendingRequests=${requests.size}`,
      );
    }, thresholdMs);
  }

  function scheduleAcceptedRunTimers(run) {
    run.lifecycleWaitTimer = armDiagnosticTimer(() => {
      if (run.lifecycleSlowEmitted || run.lifecycleStartedAtMs != null) return;
      run.lifecycleSlowEmitted = true;
      const ackToLifecycleMs = Math.max(0, nowMs() - run.acceptedAtMs);
      emit(
        CATEGORY_OPENCLAW_RUN,
        "agent_lifecycle_wait_slow",
        "warn",
        runContext(run),
        {
          runId: run.runId,
          requestId: run.requestId,
          messageId: run.messageId,
          sessionKey: run.sessionKey,
          source: run.source,
          ackToLifecycleMs,
          thresholdMs: AGENT_LIFECYCLE_WAIT_SLOW_MS,
          pendingRequests: requests.size,
        },
      );
      safeLoggerWarn(
        logger,
        `[openclaw-timing] slow accepted-run runId=${run.runId} messageId=${run.messageId || "none"} ackToLifecycleMs=${ackToLifecycleMs} pendingRequests=${requests.size}`,
      );
    }, AGENT_LIFECYCLE_WAIT_SLOW_MS);
    run.ttlTimer = armDiagnosticTimer(() => {
      const current = acceptedRuns.get(run.runId);
      if (current !== run) return;
      clearTimerRef(run.lifecycleWaitTimer);
      acceptedRuns.delete(run.runId);
    }, ACCEPTED_RUN_TTL_MS);
  }

  function removeRun(runId) {
    const key = pickId(runId);
    if (!key) return;
    const run = acceptedRuns.get(key);
    if (!run) return;
    clearTimerRef(run.lifecycleWaitTimer);
    clearTimerRef(run.ttlTimer);
    acceptedRuns.delete(key);
  }

  return {
    clear(reason) {
      for (const request of requests.values()) {
        clearTimerRef(request.slowTimer);
      }
      for (const run of acceptedRuns.values()) {
        clearTimerRef(run.lifecycleWaitTimer);
        clearTimerRef(run.ttlTimer);
      }
      requests.clear();
      acceptedRuns.clear();
      void reason;
    },

    pendingRequestCount() {
      return requests.size;
    },

    recordGatewayEventReceived(args = {}) {
      if (!isAgentGatewayEvent(args)) return;
      const receivedAtMs = nowMs();
      const runId = pickId(args.runId);
      const run = runId ? acceptedRuns.get(runId) : null;
      const stream = pickId(args.stream ?? args.channel);
      const phase = pickId(args.phase ?? args.state);
      const text = gatewayEventText(args);
      const isLifecycleStart = stream === "lifecycle" && phase === "start";

      if (run && isLifecycleStart) {
        clearTimerRef(run.lifecycleWaitTimer);
        run.lifecycleWaitTimer = null;
        run.lifecycleStartedAtMs = receivedAtMs;
      }

      const sinceRunStartMs =
        run && run.lifecycleStartedAtMs != null
          ? Math.max(0, receivedAtMs - run.lifecycleStartedAtMs)
          : null;
      const data = {
        eventKind: "agent",
        runId,
        requestId: run ? run.requestId : null,
        messageId: run ? run.messageId : null,
        sessionKey: run ? run.sessionKey : null,
        source: run ? run.source : null,
        stream,
        phase,
        sinceAcceptedMs: run ? Math.max(0, receivedAtMs - run.acceptedAtMs) : null,
        sinceRunStartMs,
        rawAssistantChars:
          stream === "assistant" && text != null ? text.length : null,
        pendingRequests: requests.size,
      };
      emit(
        CATEGORY_OPENCLAW_RUN,
        "gateway_event_received",
        "debug",
        {
          sessionKey: data.sessionKey,
          runId,
          requestId: data.requestId,
          messageId: data.messageId,
          stream,
          phase,
        },
        data,
      );
    },

    recordRequestSent(args = {}) {
      const requestId = pickId(args.requestId ?? args.id);
      if (!requestId) return;
      const sentAtMs = nowMs();
      const diagnostic = sanitizeDiagnostic(args);
      const request = {
        requestId,
        method: pickId(args.method) || "unknown",
        expectFinal: args.expectFinal === true,
        sessionKey: pickId(
          diagnostic.sessionKey ??
            args.sessionKey ??
            (isObject(args.params) ? args.params.sessionKey : null),
        ),
        messageId: diagnostic.messageId,
        source: diagnostic.source,
        textChars: diagnostic.textChars,
        hasAttachment: diagnostic.hasAttachment,
        attachmentBytes: diagnostic.attachmentBytes,
        sentAtMs,
        slowTimer: null,
        slowEmitted: false,
      };
      const existing = requests.get(requestId);
      if (existing) {
        clearTimerRef(existing.slowTimer);
      }
      requests.set(requestId, request);
      scheduleRequestSlowTimer(request);
      emit(
        CATEGORY_RELAY_PROTOCOL,
        "gateway_request_sent",
        "info",
        requestContext(request),
        {
          requestId,
          method: request.method,
          expectFinal: request.expectFinal,
          sessionKey: request.sessionKey,
          messageId: request.messageId,
          source: request.source,
          textChars: request.textChars,
          hasAttachment: request.hasAttachment,
          attachmentBytes: request.attachmentBytes,
          pendingRequests: requests.size,
        },
      );
    },

    recordResponseReceived(args = {}) {
      const requestId = pickId(args.requestId ?? args.id);
      const request = requestId ? requests.get(requestId) : null;
      const receivedAtMs = nowMs();
      const method = request ? request.method : pickId(args.method) || "unknown";
      const status = responseStatus(args);
      const runId = responseRunId(args);
      const ok = args.ok === true;
      const errorCode = responseErrorCode(args);
      if (request && status === "accepted") {
        clearTimerRef(request.slowTimer);
        request.slowTimer = null;
      }
      const elapsedMs = request ? Math.max(0, receivedAtMs - request.sentAtMs) : null;
      const data = {
        requestId,
        method,
        ok,
        status,
        elapsedMs,
        runId,
        errorCode,
        messageId: request ? request.messageId : null,
        sessionKey: request ? request.sessionKey : null,
        source: request ? request.source : null,
        pendingRequests: requests.size,
      };
      emit(
        CATEGORY_RELAY_PROTOCOL,
        "gateway_response_received",
        ok ? "info" : "warn",
        request ? requestContext(request) : { requestId, method },
        data,
      );

      const acceptedAgentRun =
        (method === "agent" && status === "accepted") ||
        (method === "sessions.steer" && (status === "started" || status === "accepted"));
      if (ok && acceptedAgentRun && runId) {
        const run = {
          runId,
          requestId,
          messageId: request ? request.messageId : null,
          sessionKey: request ? request.sessionKey : null,
          source: request ? request.source : null,
          acceptedAtMs: receivedAtMs,
          lifecycleStartedAtMs: null,
          lifecycleWaitTimer: null,
          lifecycleSlowEmitted: false,
          ttlTimer: null,
        };
        removeRun(runId);
        acceptedRuns.set(runId, run);
        scheduleAcceptedRunTimers(run);
        emit(
          CATEGORY_OPENCLAW_RUN,
          "agent_request_accepted",
          "info",
          runContext(run),
          {
            runId,
            requestId,
            messageId: run.messageId,
            sessionKey: run.sessionKey,
            source: run.source,
            ackElapsedMs: elapsedMs,
            pendingRequests: requests.size,
          },
        );
      }

      if (request && args.keepPending !== true) {
        clearTimerRef(request.slowTimer);
        requests.delete(requestId);
      }
    },

    recordRunTerminal(args = {}) {
      removeRun(args.runId ?? args.id);
    },

    setLogger(nextLogger) {
      logger = nextLogger || null;
    },
  };
}

module.exports = { createGatewayTimingLedger };
