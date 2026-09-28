const GREETING_SEND_HOLD_DEADLINE_MS = 15_000;

const GREETING_SEND_HOLD_MAX_MS = 90_000;

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

  const preempt = typeof deps.preempt === "function" ? deps.preempt : null;

  const isGreetingLive =
    typeof deps.isGreetingLive === "function" ? deps.isGreetingLive : null;
  const deadlineMs = Number.isFinite(deps.deadlineMs)
    ? Math.max(0, deps.deadlineMs)
    : GREETING_SEND_HOLD_DEADLINE_MS;
  const maxHoldMs = Number.isFinite(deps.maxHoldMs)
    ? Math.max(deadlineMs, deps.maxHoldMs)
    : Math.max(deadlineMs, GREETING_SEND_HOLD_MAX_MS);
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

        preempted: gate.abortSent === true,
        deadlineExtensions: gate.deadlineExtensions || 0,
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
      greetingRunAcked: false,
      greetingTextStarted: false,
      preemptRequested: false,
      abortSent: false,
      timer: null,
    };
    gates.set(key, gate);

    scheduleDeadline(gate, deadlineMs);
    return true;
  }

  function scheduleDeadline(gate, delayMs) {
    gate.timer = schedule(() => onDeadline(gate), delayMs);
    if (gate.timer && typeof gate.timer.unref === "function") {
      gate.timer.unref();
    }
  }

  function onDeadline(gate) {
    if (gates.get(gate.key) !== gate) return;
    gate.timer = null;
    const heldMs = Math.max(0, now() - gate.armedAtMs);
    const remainingMs = maxHoldMs - heldMs;

    if (!isGreetingLive || !gate.greetingRunId || !gate.queue.length || remainingMs <= 0) {
      flush(gate, "deadline");
      return;
    }
    let live;
    try {
      live = isGreetingLive({ sessionKey: gate.sessionKey, runId: gate.greetingRunId });
    } catch {
      flush(gate, "deadline");
      return;
    }
    Promise.resolve(live).then(
      (stillLive) => {
        if (gates.get(gate.key) !== gate) return;
        if (stillLive === true) {
          gate.deadlineExtensions = (gate.deadlineExtensions || 0) + 1;
          scheduleDeadline(gate, Math.min(deadlineMs, remainingMs));
        } else {
          flush(gate, "deadline");
        }
      },
      () => flush(gate, "deadline"),
    );
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
      maybePreempt(gate);
    });
  }

  function maybePreempt(gate) {
    if (!preempt || gates.get(gate.key) !== gate) return false;
    if (gate.preemptRequested || gate.greetingTextStarted) return false;

    if (!gate.queue.length || !gate.greetingRunAcked) return false;
    gate.preemptRequested = true;
    try {
      preempt({
        sessionKey: gate.sessionKey,
        runId: gate.greetingRunId,
        heldSends: gate.queue.length,

        stillEligible: () => gates.get(gate.key) === gate && !gate.greetingTextStarted,
        noteAbortSent: () => {
          gate.abortSent = true;
          gate.awaitingAbortReceipt = true;
        },

        abortFailed: () => {
          if (gates.get(gate.key) !== gate || !gate.awaitingAbortReceipt) return;
          gate.awaitingAbortReceipt = false;
          if (gate.greetingTerminal) flush(gate, gate.greetingTerminal);
        },
        release: (reason) => flush(gate, reason || "greeting_aborted"),
      });
    } catch {}
    return true;
  }

  function noteGreetingText(sessionKey, runId) {
    if (!gates.size) return false;
    const normalizedRunId =
      typeof runId === "string" && runId.trim() ? runId.trim() : null;
    let gate = gates.get(normalizeSessionKey(sessionKey));
    if (!gate && normalizedRunId) {

      gate = Array.from(gates.values()).find((g) => g.greetingRunId === normalizedRunId);
    }
    if (!gate) return false;
    if (gate.greetingRunId && normalizedRunId && gate.greetingRunId !== normalizedRunId) {
      return false;
    }
    gate.greetingTextStarted = true;
    return true;
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
    if (normalizedRunId) {
      gate.greetingRunId = normalizedRunId;
      gate.greetingRunAcked = true;
    }
    maybePreempt(gate);
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
    if (normalizedPhase === "error") {

      if (gate.greetingRunId && normalizedRunId && gate.greetingRunId !== normalizedRunId) {
        return false;
      }
      if (gate.awaitingAbortReceipt) return holdForAbortReceipt(gate, "greeting_error");
      return flush(gate, "greeting_error");
    }
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
    if (gate.awaitingAbortReceipt) return holdForAbortReceipt(gate, "greeting_end");
    return flush(gate, "greeting_end");
  }

  function holdForAbortReceipt(gate, reason) {
    gate.greetingTerminal = reason;
    return false;
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
    noteGreetingText,
    onActivity,
    evict,
    releaseAll,
  };
}

module.exports = { GREETING_SEND_HOLD_DEADLINE_MS, createGreetingSendGate };
