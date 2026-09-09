const GREETING_SEND_HOLD_DEADLINE_MS = 15_000;

function normalizeSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return "";
  return sessionKey.trim().replace(/^agent:[^:]+:/, "");
}

function createGreetingSendGate(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const schedule =
    typeof deps.setTimeout === "function" ? deps.setTimeout : setTimeout;
  const cancel =
    typeof deps.clearTimeout === "function" ? deps.clearTimeout : clearTimeout;
  const onRelease =
    typeof deps.onRelease === "function" ? deps.onRelease : () => {};
  const deadlineMs = Number.isFinite(deps.deadlineMs)
    ? Math.max(0, deps.deadlineMs)
    : GREETING_SEND_HOLD_DEADLINE_MS;
  const gates = new Map();

  function flush(gate, reason) {
    if (!gate || gates.get(gate.key) !== gate) return false;
    gates.delete(gate.key);
    if (gate.timer) cancel(gate.timer);

    const heldSends = gate.queue.length;
    const heldMs = Math.max(0, now() - gate.armedAtMs);
    try {
      onRelease({
        sessionKey: gate.sessionKey,
        reason,
        heldMs,
        heldSends,
      });
    } catch {}

    for (const pending of gate.queue) {
      try {
        Promise.resolve(pending.send()).then(pending.resolve, pending.reject);
      } catch (err) {
        pending.reject(err);
      }
    }
    return true;
  }

  function arm(sessionKey) {
    const key = normalizeSessionKey(sessionKey);
    if (!key) return false;
    const prior = gates.get(key);
    if (prior) flush(prior, "session_reset");

    const gate = {
      key,
      sessionKey: key,
      armedAtMs: now(),
      queue: [],
      greetingStarted: false,
      greetingRunId: null,
      timer: null,
    };
    gates.set(key, gate);

    gate.timer = schedule(() => flush(gate, "deadline"), deadlineMs);
    if (gate.timer && typeof gate.timer.unref === "function") {
      gate.timer.unref();
    }
    return true;
  }

  function dispatch(sessionKey, send) {
    if (typeof send !== "function") {
      return Promise.reject(new TypeError("greeting gate dispatch requires a function"));
    }
    const gate = gates.get(normalizeSessionKey(sessionKey));
    if (!gate) {
      try {
        return Promise.resolve(send());
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise((resolve, reject) => {
      gate.queue.push({ send, resolve, reject });
    });
  }

  function noteGreetingRun(sessionKey, runId, status) {
    if (!gates.size) return false;
    const gate = gates.get(normalizeSessionKey(sessionKey));
    if (!gate) return false;
    const normalizedStatus =
      typeof status === "string" ? status.trim().toLowerCase() : "";
    if (normalizedStatus !== "accepted") return false;

    gate.greetingStarted = true;
    const normalizedRunId =
      typeof runId === "string" && runId.trim() ? runId.trim() : null;
    if (normalizedRunId) gate.greetingRunId = normalizedRunId;
    return true;
  }

  function onActivity(sessionKey, phase, runId, origin) {
    if (!gates.size) return false;
    const gate = gates.get(normalizeSessionKey(sessionKey));
    if (!gate) return false;
    if (typeof origin === "string" && origin.trim().toLowerCase() === "simulated") {
      return false;
    }

    const normalizedPhase = typeof phase === "string" ? phase.trim().toLowerCase() : "";
    const normalizedRunId =
      typeof runId === "string" && runId.trim() ? runId.trim() : null;
    if (normalizedPhase !== "end") {
      if (!gate.greetingStarted) {

        gate.greetingStarted = true;
        gate.greetingRunId = normalizedRunId;
      } else if (!gate.greetingRunId && normalizedRunId) {

        gate.greetingRunId = normalizedRunId;
      }
      return false;
    }
    if (!gate.greetingStarted) return false;
    if (gate.greetingRunId && gate.greetingRunId !== normalizedRunId) return false;
    return flush(gate, "greeting_end");
  }

  function evict(sessionKey, reason = "session_reset") {
    const gate = gates.get(normalizeSessionKey(sessionKey));
    return flush(gate, reason);
  }

  function releaseAll(reason = "upstream_disconnected") {
    let released = 0;
    for (const gate of Array.from(gates.values())) {
      if (flush(gate, reason)) released += 1;
    }
    return released;
  }

  return {
    arm,
    dispatch,
    noteGreetingRun,
    onActivity,
    evict,
    releaseAll,
  };
}

module.exports = { GREETING_SEND_HOLD_DEADLINE_MS, createGreetingSendGate };
