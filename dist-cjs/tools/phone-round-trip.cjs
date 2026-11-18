function validateNoInput(input     ) {
  if (input === undefined || input === null) return { ok: true };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "invalid_input", message: "input must be an object" };
  const keys = Object.keys(input);
  if (keys.length > 0) return { ok: false, code: "invalid_input", message: `unknown key(s): ${keys.join(", ")}` };
  return { ok: true };
}

function createPhoneRoundTrip(deps      = {}) {
  const pending = new Map();

  let sequence = 0;
  const prefix = typeof deps.idPrefix === "string" && deps.idPrefix ? deps.idPrefix : "pr";
  const newRequestId =
    typeof deps.newRequestId === "function"
      ? deps.newRequestId
      : () => `${prefix}-${Date.now().toString(36)}-${(sequence += 1)}`;
  const setTimeoutFn = typeof deps.setTimeout === "function" ? deps.setTimeout : setTimeout;
  const clearTimeoutFn = typeof deps.clearTimeout === "function" ? deps.clearTimeout : clearTimeout;
  const timeoutCode = typeof deps.timeoutCode === "string" && deps.timeoutCode ? deps.timeoutCode : "phone_timeout";
  const abortCode = typeof deps.abortCode === "string" && deps.abortCode ? deps.abortCode : "phone_aborted";

  function settle(requestId     , kind        , outcome     ) {
    const entry = pending.get(requestId);
    if (!entry || (kind && entry.kind !== kind)) return;
    pending.delete(requestId);
    clearTimeoutFn(entry.timer);
    entry.resolve(outcome);
  }

  function ask(kind        , frame     , timeoutMs        ) {
    if (typeof deps.hasPhone === "function" && !deps.hasPhone()) {
      return Promise.resolve({ ok: false, code: "phone_not_connected" });
    }
    const requestId = newRequestId();
    return new Promise((resolve) => {
      const timer = setTimeoutFn(() => settle(requestId, kind, { ok: false, code: timeoutCode }), timeoutMs);
      pending.set(requestId, { kind, resolve, timer });
      try {
        deps.broadcast({ ...frame, requestId });
      } catch (_) {
        settle(requestId, kind, { ok: false, code: "phone_not_connected" });
      }
    });
  }

  function drainAll() {
    for (const requestId of [...pending.keys()]) settle(requestId, "", { ok: false, code: abortCode });
  }

  return { ask, settle, drainAll };
}

module.exports = { validateNoInput, createPhoneRoundTrip };
