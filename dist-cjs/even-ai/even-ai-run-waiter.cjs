const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { extractEmbeddedEvenAiSessionKey } = require("../domain/even-ai-session-keys.cjs");

function normalizeRunId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeSessionKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeSessionKeyForCompare(value) {
  const normalized = normalizeSessionKey(value);
  if (!normalized) return "";
  return (extractEmbeddedEvenAiSessionKey(normalized) || normalized).toLowerCase();
}

function sessionKeysMatch(expected, actual) {
  const normalizedExpected = normalizeSessionKeyForCompare(expected);
  const normalizedActual = normalizeSessionKeyForCompare(actual);
  if (!normalizedExpected || !normalizedActual) return false;
  return (
    normalizedExpected === normalizedActual ||
    normalizedExpected.endsWith(`:${normalizedActual}`) ||
    normalizedActual.endsWith(`:${normalizedExpected}`)
  );
}

function extractAssistantText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => {
      return (
        block &&
        block.type === "text" &&
        typeof block.text === "string"
      );
    })
    .map((block) => block.text)
    .join("");
}

function createRunWaiterError(code, message, extras = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extras);
  return err;
}

function createEvenAiRunWaiter(opts = {}) {
  const gatewayBridge = opts.gatewayBridge;
  if (!gatewayBridge || typeof gatewayBridge.on !== "function") {
    throw new Error("Even AI run waiter requires gatewayBridge.on()");
  }

  const logger = normalizeLogger(opts.logger);
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const setTimeoutFn =
    typeof opts.setTimeout === "function" ? opts.setTimeout : setTimeout;
  const clearTimeoutFn =
    typeof opts.clearTimeout === "function" ? opts.clearTimeout : clearTimeout;

  const pendingRuns = new Map();

  function cleanupPending(runId) {
    const pending = pendingRuns.get(runId);
    if (!pending) return null;
    pendingRuns.delete(runId);
    if (pending.timer) {
      clearTimeoutFn(pending.timer);
    }
    return pending;
  }

  function rejectRun(runId, err, eventName) {
    const pending = cleanupPending(runId);
    if (!pending) return false;
    emitDebug(
      "evenai",
      eventName,
      err && err.code === "evenai_timeout" ? "warn" : "error",
      {
        sessionKey: pending.sessionKey || undefined,
        runId,
      },
      () => ({
        timeoutMs: pending.timeoutMs,
        code: err && err.code ? err.code : null,
        message: err && err.message ? err.message : String(err),
      }),
    );
    pending.reject(err);
    return true;
  }

  function resolveRun(runId, text) {
    const pending = cleanupPending(runId);
    if (!pending) return false;
    emitDebug(
      "evenai",
      "run_wait_resolved",
      "debug",
      {
        sessionKey: pending.sessionKey || undefined,
        runId,
      },
      () => ({
        timeoutMs: pending.timeoutMs,
        textChars: text.length,
      }),
    );
    pending.resolve(text);
    return true;
  }

  const offMessage = gatewayBridge.on("message", (data) => {
    const runId = normalizeRunId(data && data.runId);
    if (!runId || !pendingRuns.has(runId)) return;
    const pending = pendingRuns.get(runId);
    const sessionKey = normalizeSessionKey(data && data.sessionKey);
    if (
      pending &&
      pending.sessionKey &&
      sessionKey &&
      !sessionKeysMatch(pending.sessionKey, sessionKey)
    ) {
      return;
    }
    if (data && typeof data.role === "string" && data.role !== "assistant") {
      return;
    }
    resolveRun(runId, extractAssistantText(data && data.content));
  });

  const offActivity = gatewayBridge.on("activity", (data) => {
    const runId = normalizeRunId(data && data.runId);
    if (!runId || !pendingRuns.has(runId)) return;
    const phase = typeof data.phase === "string" ? data.phase.trim().toLowerCase() : "";
    if (phase !== "error") return;
    rejectRun(
      runId,
      createRunWaiterError(
        "evenai_upstream_error",
        "Even AI run failed before completing.",
      ),
      "run_wait_failed",
    );
  });

  const offDisconnected = gatewayBridge.on("disconnected", () => {
    for (const runId of Array.from(pendingRuns.keys())) {
      rejectRun(
        runId,
        createRunWaiterError(
          "evenai_disconnected",
          "Gateway disconnected while waiting for Even AI completion.",
        ),
        "run_wait_disconnected",
      );
    }
  });

  return {
    waitForRun(request = {}) {
      const runId = normalizeRunId(request.runId);
      if (!runId) {
        return Promise.reject(
          createRunWaiterError(
            "evenai_missing_run_id",
            "Even AI run waiter requires a runId.",
          ),
        );
      }
      if (pendingRuns.has(runId)) {
        return Promise.reject(
          createRunWaiterError(
            "evenai_duplicate_wait",
            `Even AI run ${runId} is already being awaited.`,
          ),
        );
      }

      const sessionKey = normalizeSessionKey(request.sessionKey);
      const timeoutMs =
        Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
          ? Math.floor(request.timeoutMs)
          : null;

      return new Promise((resolve, reject) => {
        const pending = {
          resolve,
          reject,
          sessionKey,
          timer: null,
          timeoutMs,
        };

        if (timeoutMs !== null) {
          pending.timer = setTimeoutFn(() => {
            rejectRun(
              runId,
              createRunWaiterError(
                "evenai_timeout",
                "Even AI request timed out.",
                { timeoutMs },
              ),
              "run_wait_timeout",
            );
          }, timeoutMs);
        }

        pendingRuns.set(runId, pending);
        emitDebug(
          "evenai",
          "run_wait_started",
          "debug",
          { sessionKey: sessionKey || undefined, runId },
          () => ({ timeoutMs }),
        );
      });
    },

    cancelRun(runId, reason) {
      const normalized = normalizeRunId(runId);
      if (!normalized) return false;
      const message =
        typeof reason === "string" && reason.length > 0
          ? `Even AI run cancelled: ${reason}.`
          : "Even AI run cancelled.";
      return rejectRun(
        normalized,
        createRunWaiterError("evenai_cancelled", message, { reason: reason || null }),
        "run_wait_cancelled",
      );
    },

    close() {
      if (typeof offMessage === "function") offMessage();
      if (typeof offActivity === "function") offActivity();
      if (typeof offDisconnected === "function") offDisconnected();

      for (const runId of Array.from(pendingRuns.keys())) {
        rejectRun(
          runId,
          createRunWaiterError(
            "evenai_waiter_closed",
            "Even AI run waiter stopped.",
          ),
          "run_wait_closed",
        );
      }
      logger.debug("[evenai] run waiter closed");
    },
  };
}

module.exports = { createEvenAiRunWaiter };
