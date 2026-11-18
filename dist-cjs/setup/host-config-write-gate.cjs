const { isDeepStrictEqual } = require("node:util");

const HOST_CONFIG_WRITE_GATE_DEFAULTS = Object.freeze({
  pollMs: 200,
  settleMs: 1500,
  maxWaitMs: 300000,
});

function pluginsBranch(config     ) {
  return config && typeof config === "object" ? config.plugins : undefined;
}

function createHostConfigWriteGate(options      = {}) {
  const readLive = typeof options.readLive === "function" ? options.readLive : null;
  const startedPlugins = pluginsBranch(options.startedConfig);
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0
    ? options.pollMs
    : HOST_CONFIG_WRITE_GATE_DEFAULTS.pollMs;
  const settleMs = Number.isFinite(options.settleMs) && options.settleMs >= 0
    ? options.settleMs
    : HOST_CONFIG_WRITE_GATE_DEFAULTS.settleMs;
  const maxWaitMs = Number.isFinite(options.maxWaitMs) && options.maxWaitMs >= 0
    ? options.maxWaitMs
    : HOST_CONFIG_WRITE_GATE_DEFAULTS.maxWaitMs;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;

  let timer      = null;
  let cancelled = false;
  let settled      = null;
  let resolveSettled      = null;

  function readLiveBranch() {
    if (!readLive) return { readable: false, branch: undefined };
    try {
      return { readable: true, branch: pluginsBranch(readLive()) };
    } catch (_) {
      return { readable: false, branch: undefined };
    }
  }

  function matchesStarted(live     ) {
    return !live.readable || isDeepStrictEqual(live.branch, startedPlugins);
  }

  function finish(outcome     ) {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const resolve = resolveSettled;
    resolveSettled = null;
    if (resolve) resolve(outcome);
  }

  function whenSettled() {
    if (settled) return settled;
    settled = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    const startedAt = now();
    const atStart = readLiveBranch();
    const matchedAtStart = matchesStarted(atStart);

    const inFlightBranch = matchedAtStart ? null : { branch: atStart.branch };
    let matchingSince      = matchedAtStart ? startedAt : null;
    let lastBranch = atStart.branch;
    const tick = () => {
      timer = null;
      if (cancelled) return;
      const at = now();
      const waitedMs = at - startedAt;
      const live = readLiveBranch();
      const matched = matchesStarted(live);
      const published = !matched && inFlightBranch !== null && live.readable &&
        !isDeepStrictEqual(live.branch, inFlightBranch.branch);
      if (matched || published) {

        if (matchingSince === null || !isDeepStrictEqual(live.branch, lastBranch)) matchingSince = at;
        if (at - matchingSince >= settleMs) {
          finish({
            settled: true,
            reason: matchedAtStart ? "live-config-current" : matched ? "activation-committed" : "live-config-published",
            waitedMs,
          });
          return;
        }
      } else {
        matchingSince = null;
      }
      lastBranch = live.branch;
      if (waitedMs >= maxWaitMs) {
        finish({ settled: false, reason: "max-wait-elapsed", waitedMs });
        return;
      }
      timer = setTimer(tick, pollMs);
    };
    timer = setTimer(tick, Math.min(pollMs, settleMs) || 0);
    return settled;
  }

  function cancel() {
    cancelled = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    resolveSettled = null;
  }

  return { whenSettled, cancel };
}

module.exports = { HOST_CONFIG_WRITE_GATE_DEFAULTS, createHostConfigWriteGate };
