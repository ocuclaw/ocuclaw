const LINK_REPLY_DELIVERY_OBSERVE_METHOD = "replyDelivery.observe";
const LINK_REPLY_DELIVERY_REPORT_METHOD = "replyDelivery.report";
const DEFAULT_RETRY_DELAY_MS = 250;

const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_QUEUE = 128;
const CANDIDATE_ID_PATTERN = /^[0-9a-f]{64}$/;
const PERMANENT_REFUSALS = ["candidate_unknown", "invalid_params"];
const OBSERVE_KEYS =["candidateId", "sessionKey", "runId"];

const HERMES_REASONS = {
  deadline_expired: "observation_expired",
  recipient_disconnected: "client_disconnected",
  no_app_recipient: "client_disconnected",
  peer_lacks_contract: "client_lacks_contract",
  target_identity_missing: "attribution_unavailable",
  origin_unbound: "attribution_unavailable",
  ambiguous_recipient: "attribution_unavailable",
  reply_entry_not_found: "attribution_unavailable",
  reply_not_text: "unsupported_reply_shape",

  reply_run_errored: "reply_run_errored",
  reply_run_rate_limited: "reply_run_rate_limited",
};
const hermesReason = (reason) =>
  reason === null || reason === undefined ? null : HERMES_REASONS[reason] || "unspecified";

function createHermesReplyDeliveryLink({
  relay,
  link,
  logger,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let disposed = false;
  let inFlight = false;
  let retryTimer = null;

  const queue = new Map();

  function warn(message) {
    if (logger && typeof logger.warn === "function") {
      logger.warn(`[hermes-reply-delivery] ${message}`);
    }
  }

  function scheduleRetry() {
    if (disposed || retryTimer !== null) return;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      drain();
    }, retryDelayMs);
    if (retryTimer && typeof retryTimer.unref === "function") retryTimer.unref();
  }

  function failed(candidateId, entry, reason) {
    entry.attempts += 1;
    if (queue.get(candidateId) === entry && entry.attempts >= maxAttempts) {
      queue.delete(candidateId);
      warn(`report dropped after ${entry.attempts} attempts: ${reason}`);
      drain();
      return;
    }
    warn(`report failed: ${reason}`);
    scheduleRetry();
  }

  function drain() {
    if (disposed || inFlight || retryTimer !== null || queue.size === 0) return;
    const [candidateId, entry] = queue.entries().next().value;
    inFlight = true;
    let pending;
    try {
      pending = link.request(LINK_REPLY_DELIVERY_REPORT_METHOD, entry.params);
    } catch (err) {
      inFlight = false;
      failed(candidateId, entry, err && err.message ? err.message : String(err));
      return;
    }
    Promise.resolve(pending).then(
      (result) => {
        if (disposed) return;
        inFlight = false;
        if (!result || result.ok !== true) {

          if (PERMANENT_REFUSALS.includes(result?.error)) {
            if (queue.get(candidateId) === entry) queue.delete(candidateId);
            warn(`report dropped: ${result.error}`);
            drain();
            return;
          }
          failed(candidateId, entry, `refused: ${result?.error || "unknown"}`);
          return;
        }
        if (queue.get(candidateId) === entry) queue.delete(candidateId);
        drain();
      },
      (err) => {
        if (disposed) return;
        inFlight = false;
        failed(candidateId, entry, err && err.message ? err.message : String(err));
      },
    );
  }

  function report(candidateId, status) {
    if (disposed || !CANDIDATE_ID_PATTERN.test(String(candidateId))) return;
    if (!status || status.status === "pending") return;
    const evidence = status.status === "sdk_accepted" && status.evidence
      ? {
          kind: status.evidence.kind,
          lane: status.evidence.lane,
          coveredChars: status.evidence.coveredChars,
        }
      : null;

    if (logger && typeof logger.info === "function") {
      logger.info(`[hermes-reply-delivery] settled ${status.status}${status.reason ? ` (${status.reason})` : ""}`);
    }
    queue.delete(candidateId);
    queue.set(candidateId, {
      attempts: 0,
      params: { candidateId, status: status.status, reason: hermesReason(status.reason), evidence },
    });
    while (queue.size > MAX_QUEUE) queue.delete(queue.keys().next().value);
    drain();
  }

  const methods = {};
  methods[LINK_REPLY_DELIVERY_OBSERVE_METHOD] = (params) => {
    const keys = params && typeof params === "object" && !Array.isArray(params) ? Object.keys(params) : [];
    if (
      keys.length !== OBSERVE_KEYS.length ||
      !OBSERVE_KEYS.every((key) => typeof params[key] === "string" && params[key].length > 0) ||
      !CANDIDATE_ID_PATTERN.test(params.candidateId)
    ) {
      return { ok: false, error: "invalid_params" };
    }
    if (!relay || typeof relay.observeReplyDelivery !== "function") {
      return { ok: false, error: "relay_unavailable" };
    }
    const seen = relay.observeReplyDelivery({
      candidateKey: params.candidateId,
      sessionKey: params.sessionKey,
      runId: params.runId,
    });
    return { ok: true, status: seen.status, reason: hermesReason(seen.reason) };
  };

  const unsubscribe =
    relay && typeof relay.onReplyDeliverySettled === "function"
      ? relay.onReplyDeliverySettled(report)
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
    } catch (_) {}
  }

  return { methods, report, dispose };
}

module.exports = { createHermesReplyDeliveryLink, LINK_REPLY_DELIVERY_OBSERVE_METHOD, LINK_REPLY_DELIVERY_REPORT_METHOD };
