const LINK_PAIRING_COMPLETED_METHOD = "pairing.completed";
const DEFAULT_RETRY_DELAY_MS = 250;

const COMPLETION_ID_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function createHermesPairingCompletionPush({
  relay,
  link,
  logger,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let disposed = false;
  let inFlight = false;
  let retryTimer = null;

  const queue = new Map();

  function warn(err) {
    if (!logger || typeof logger.warn !== "function") return;
    logger.warn(
      `[hermes-pairing] completion receipt push failed: ${err && err.message ? err.message : err}`,
    );
  }

  function scheduleRetry() {
    if (disposed || retryTimer !== null) return;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      drain();
    }, retryDelayMs);
    if (retryTimer && typeof retryTimer.unref === "function") retryTimer.unref();
  }

  function refused(result) {
    warn(new Error(`receipt refused: ${result?.error || "unknown"}`));
    scheduleRetry();
  }

  function failed(err) {
    warn(err);
    scheduleRetry();
  }

  function drain() {
    if (disposed || inFlight || retryTimer !== null || queue.size === 0) return;
    const completionId = queue.keys().next().value;
    inFlight = true;
    let pending;
    try {
      pending = link.request(LINK_PAIRING_COMPLETED_METHOD, { completionId });
    } catch (err) {
      inFlight = false;
      failed(err);
      return;
    }
    Promise.resolve(pending).then(
      (result) => {
        if (disposed) return;
        inFlight = false;
        if (!result || result.ok !== true) {
          refused(result);
          return;
        }
        queue.delete(completionId);
        drain();
      },
      (err) => {
        if (disposed) return;
        inFlight = false;
        failed(err);
      },
    );
  }

  function push(completionId) {
    if (disposed) return;
    if (typeof completionId !== "string" || !COMPLETION_ID_PATTERN.test(completionId)) {
      warn(new Error("invalid completion ID"));
      return;
    }
    if (queue.has(completionId)) return;
    queue.set(completionId, true);
    drain();
  }

  const unsubscribe =
    relay && typeof relay.onPairingCompleted === "function"
      ? relay.onPairingCompleted(push)
      : () => {};

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (retryTimer !== null) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
    queue.clear();
    try {
      if (typeof unsubscribe === "function") unsubscribe();
    } catch (err) {
      warn(err);
    }
  }

  return { push, dispose };
}

module.exports = { createHermesPairingCompletionPush, LINK_PAIRING_COMPLETED_METHOD };
