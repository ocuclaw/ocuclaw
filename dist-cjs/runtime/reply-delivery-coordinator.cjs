const { REPLY_DELIVERY_CAPABILITY, REPLY_DELIVERY_DEADLINE_MS, REPLY_DELIVERY_MAX_PENDING, createReplyDelivery } = require("./reply-delivery.cjs");

const SWEEP_INTERVAL_MS = 1000;

function selectReplyTarget(entries, sessionKey, runId, runErrored = false) {
  if (runErrored === true) return { target: null, reason: "reply_run_errored" };
  const ofRun = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.role === "assistant" && entry.runId === runId);
  if (ofRun.length === 0) return { target: null, reason: "reply_entry_not_found" };
  for (let index = ofRun.length - 1; index >= 0; index -= 1) {
    const entry = ofRun[index];
    const text = typeof entry.text === "string" ? entry.text : "";
    if (text.trim().length === 0) continue;
    if (entry.idSource !== "server") return { target: null, reason: "target_identity_missing" };
    return {
      target: { sessionKey, runId, entryId: entry.id, revision: entry.rev, textLength: text.length },
      reason: null,
    };
  }
  return { target: null, reason: "reply_not_text" };
}

function createReplyDeliveryCoordinator({
  getLedger,
  listClients,
  unicast,
  now = () => performance.now(),
  randomId,
  deadlineMs = REPLY_DELIVERY_DEADLINE_MS,
  maxPending = REPLY_DELIVERY_MAX_PENDING,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  emitDebug = null,

  isRunErrored = null,
}) {
  const listeners = new Set();

  const runOrigins = new Map();

  const waiting = new Map();

  const terminals = new Map();

  const tracked = new Map();
  let sweepTimer = null;

  const debug = (event, data) => {
    if (typeof emitDebug === "function") emitDebug(event, data);
  };

  function announce(candidateKey, status) {
    debug("reply_delivery_settled", { status: status.status, reason: status.reason });
    for (const listener of listeners) {
      try { listener(candidateKey, status); } catch (_) {}
    }
    stopSweepIfIdle();
  }

  const delivery = createReplyDelivery({ now, randomId, deadlineMs, maxPending, onSettle: announce });
  const terminal = (candidateKey, status, reason) => {
    const result = { status, reason, evidence: null };
    delivery.invalidate(candidateKey);
    terminals.delete(candidateKey);
    terminals.set(candidateKey, result);
    while (terminals.size > maxPending) terminals.delete(terminals.keys().next().value);
    announce(candidateKey, result);
    return { status, reason };
  };

  function pendingCount() {
    let count = waiting.size;
    for (const key of tracked.keys()) if (delivery.status(key).status === "pending") count += 1;
    return count;
  }

  function startSweep() {
    if (sweepTimer !== null) return;
    sweepTimer = setIntervalFn(sweep, SWEEP_INTERVAL_MS);
    if (sweepTimer && typeof sweepTimer.unref === "function") sweepTimer.unref();
  }

  function stopSweepIfIdle() {
    if (sweepTimer === null || pendingCount() > 0) return;
    clearIntervalFn(sweepTimer);
    sweepTimer = null;
  }

  function sweep() {
    delivery.sweep();
    for (const [candidateKey, entry] of [...waiting]) {
      if (now() - entry.at <= deadlineMs) continue;
      waiting.delete(candidateKey);

      terminal(candidateKey, entry.reason === "reply_entry_not_found" ? "unconfirmed" : "unsupported", entry.reason);
    }
    for (const key of [...tracked.keys()]) {
      if (delivery.status(key).status !== "pending") tracked.delete(key);
    }
    stopSweepIfIdle();
  }

  function noteRunOrigin(runId, clientId) {
    if (typeof runId !== "string" || !runId || typeof clientId !== "string" || !clientId) return;
    runOrigins.delete(runId);
    runOrigins.set(runId, clientId);
    while (runOrigins.size > maxPending) runOrigins.delete(runOrigins.keys().next().value);
  }

  function tryObserve(candidateKey, sessionKey, runId, startedAt) {

    const ledger = getLedger() || {};
    const ledgerSessionKey = typeof ledger.sessionKey === "string" && ledger.sessionKey ? ledger.sessionKey : sessionKey;
    let errored = false;
    if (typeof isRunErrored === "function") { try { errored = isRunErrored(runId) === true; } catch (_) { errored = false; } }
    const selected = selectReplyTarget(ledger.entries, ledgerSessionKey, runId, errored);

    if (selected.reason === "reply_run_errored") {
      return { settled: terminal(candidateKey, "unconfirmed", "reply_run_errored") };
    }
    if (!selected.target) return selected;
    const originId = runOrigins.get(runId);
    if (!originId) return { settled: terminal(candidateKey, "unconfirmed", "origin_unbound") };

    const origin = (listClients() || [])
      .filter((entry) => entry && entry.clientId === originId)
      .map((entry) => ({
        clientId: entry.clientId,
        clientKind: entry.clientKind,
        supportsReceipt: Array.isArray(entry.clientCapabilities) &&
          entry.clientCapabilities.includes(REPLY_DELIVERY_CAPABILITY),
      }));
    terminals.delete(candidateKey);
    const seen = delivery.observe(candidateKey, selected.target, origin, startedAt);
    if (seen.status === "pending") {
      if (!tracked.has(candidateKey)) tracked.set(candidateKey, { sessionKey, runId });
      startSweep();
      if (seen.resend) {
        debug("reply_render_probe_unicast", { targetClientId: seen.clientId });
        try { unicast(seen.clientId, JSON.stringify(seen.probe)); } catch (_) {}
      }
    }
    return { settled: { status: seen.status, reason: seen.reason || null } };
  }

  function observe({ candidateKey, sessionKey, runId }) {
    const valid = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
    if (!valid(candidateKey) || !valid(sessionKey) || !valid(runId)) {
      return { status: "unsupported", reason: "target_identity_missing" };
    }

    const earlier = waiting.get(candidateKey);
    const at = earlier ? earlier.at : now();
    const attempt = tryObserve(candidateKey, sessionKey, runId, at);
    if (attempt.settled) return attempt.settled;

    waiting.delete(candidateKey);
    waiting.set(candidateKey, { sessionKey, runId, at, reason: attempt.reason });
    while (waiting.size > maxPending) {
      const oldest = waiting.keys().next().value;
      waiting.delete(oldest);
      terminal(oldest, "unconfirmed", "evicted");
    }
    startSweep();
    return { status: "pending", reason: null };
  }

  function notifyEntriesChanged() {
    for (const [candidateKey, entry] of [...waiting]) {
      const attempt = tryObserve(candidateKey, entry.sessionKey, entry.runId, entry.at);
      if (attempt.settled) waiting.delete(candidateKey);
      else entry.reason = attempt.reason;
    }

    for (const [candidateKey, entry] of [...tracked]) {
      if (waiting.has(candidateKey)) continue;
      if (delivery.status(candidateKey).status !== "pending") { tracked.delete(candidateKey); continue; }
      tryObserve(candidateKey, entry.sessionKey, entry.runId, null);
    }
  }

  function acceptReceipt(sender, receipt) {
    const result = delivery.accept(sender, receipt);
    debug("reply_render_receipt_recv", { ok: result.ok, reason: result.reason });
    return result;
  }

  function status(candidateKey) {
    if (waiting.has(candidateKey)) return { status: "pending", reason: null, evidence: null };
    return terminals.get(candidateKey) || delivery.status(candidateKey);
  }

  function forgetClient(clientId) {
    delivery.forgetClient(clientId);
    for (const [runId, originId] of [...runOrigins]) {
      if (originId === clientId) runOrigins.delete(runId);
    }
  }

  function onSettled(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    if (sweepTimer !== null) clearIntervalFn(sweepTimer);
    sweepTimer = null;
    listeners.clear();
    waiting.clear();
    tracked.clear();
  }

  return { observe, acceptReceipt, status, noteRunOrigin, notifyEntriesChanged, forgetClient, onSettled, sweep, dispose };
}

module.exports = { selectReplyTarget, createReplyDeliveryCoordinator };
