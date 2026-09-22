const REPLY_RENDER_PROBE_TYPE = "reply_render_probe";
const REPLY_RENDER_RECEIPT_TYPE = "reply_render_receipt";
const REPLY_DELIVERY_CAPABILITY = "replyRenderReceiptV1";
const REPLY_DELIVERY_EVIDENCE_KIND = "client_sdk_receipt";
const REPLY_DELIVERY_DEADLINE_MS = 30000;
const REPLY_DELIVERY_MAX_PENDING = 128;
const REPLY_DELIVERY_MAX_RANGES = 64;
const REPLY_DELIVERY_LANES = ["device", "simulator"];

const RECEIPT_KEYS = ["type", "attemptId", "sessionKey", "runId", "entryId", "revision", "lane", "ranges"];
const isId = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const isPositiveInt = (value) => Number.isSafeInteger(value) && value > 0;

const isRevision = (value) => Number.isSafeInteger(value) && value >= 0;

function normalizeTarget(target) {
  if (!target || !isId(target.sessionKey) || !isId(target.runId) || !isId(target.entryId)) return null;
  if (!isRevision(target.revision) || !isPositiveInt(target.textLength)) return null;
  return {
    sessionKey: target.sessionKey,
    runId: target.runId,
    entryId: target.entryId,
    revision: target.revision,
    textLength: target.textLength,
  };
}

function coveredChars(receipt, textLength) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const keys = Object.keys(receipt);
  if (keys.length !== RECEIPT_KEYS.length || !keys.every((key) => RECEIPT_KEYS.includes(key))) return null;
  if (receipt.type !== REPLY_RENDER_RECEIPT_TYPE || !isId(receipt.attemptId)) return null;
  if (!REPLY_DELIVERY_LANES.includes(receipt.lane)) return null;
  const ranges = receipt.ranges;
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > REPLY_DELIVERY_MAX_RANGES) return null;
  for (const range of ranges) {
    if (!range || typeof range !== "object" || Object.keys(range).length !== 2) return null;
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return null;
    if (range.start < 0 || range.end <= range.start || range.end > textLength) return null;
  }

  let covered = 0;
  let reach = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const from = Math.max(range.start, reach);
    if (range.end > from) {
      covered += range.end - from;
      reach = range.end;
    }
  }
  return covered;
}

function createReplyDelivery({
  now = () => performance.now(),
  randomId = () => globalThis.crypto.randomUUID(),
  maxPending = REPLY_DELIVERY_MAX_PENDING,
  deadlineMs = REPLY_DELIVERY_DEADLINE_MS,
  onSettle = null,
} = {}) {

  const pending = new Map();
  const settled = new Map();
  const result = (status, reason, evidence = null) => ({ status, reason, evidence });

  function settle(candidateKey, value) {
    settled.delete(candidateKey);
    settled.set(candidateKey, value);
    while (settled.size > maxPending) settled.delete(settled.keys().next().value);

    if (typeof onSettle === "function") {
      try { onSettle(candidateKey, result(value.status, value.reason, value.evidence)); } catch (_) {}
    }
  }

  function dropAttempt(attempt, reason) {
    pending.delete(attempt.attemptId);
    settle(attempt.candidateKey, result("unconfirmed", reason));
  }

  function expire() {
    for (const attempt of [...pending.values()]) {

      if (!pending.has(attempt.attemptId)) continue;
      if (now() - attempt.at > deadlineMs) dropAttempt(attempt, "deadline_expired");
    }
  }

  function attemptFor(candidateKey) {
    for (const attempt of pending.values()) {
      if (attempt.candidateKey === candidateKey) return attempt;
    }
    return null;
  }

  const probeOf = (attempt) => ({
    type: REPLY_RENDER_PROBE_TYPE,
    attemptId: attempt.attemptId,
    sessionKey: attempt.target.sessionKey,
    runId: attempt.target.runId,
    entryId: attempt.target.entryId,
    revision: attempt.target.revision,
  });

  function sameTarget(a, b) {
    return a.sessionKey === b.sessionKey && a.runId === b.runId &&
      a.entryId === b.entryId && a.revision === b.revision;
  }

  function observe(candidateKey, rawTarget, connections, startedAt = null) {
    expire();
    const done = settled.get(candidateKey);
    if (done && done.status === "sdk_accepted") return { status: done.status, reason: null };
    const terminal = (status, reason) => {
      const active = attemptFor(candidateKey);
      if (active) pending.delete(active.attemptId);
      settle(candidateKey, result(status, reason));
      return { status, reason };
    };
    const target = normalizeTarget(rawTarget);
    if (!target) return terminal("unsupported", "target_identity_missing");
    const apps = (Array.isArray(connections) ? connections : [])
      .filter((entry) => entry && entry.clientKind === "app" && isId(entry.clientId));
    if (apps.length === 0) return terminal("unconfirmed", "no_app_recipient");
    if (apps.length > 1) return terminal("unconfirmed", "ambiguous_recipient");
    if (apps[0].supportsReceipt !== true) return terminal("unsupported", "peer_lacks_contract");

    const active = attemptFor(candidateKey);
    if (active && active.clientId === apps[0].clientId && sameTarget(active.target, target)) {
      return { status: "pending", reason: null, clientId: active.clientId, probe: probeOf(active), resend: false };
    }
    if (active) pending.delete(active.attemptId);
    settled.delete(candidateKey);
    const at = active ? active.at : Number.isFinite(startedAt) ? startedAt : now();
    const attempt = { attemptId: randomId(), candidateKey, target, clientId: apps[0].clientId, at };
    pending.set(attempt.attemptId, attempt);
    while (pending.size > maxPending) dropAttempt(pending.values().next().value, "evicted");
    return { status: "pending", reason: null, clientId: attempt.clientId, probe: probeOf(attempt), resend: true };
  }

  function accept(connection, receipt) {
    expire();
    const deny = (reason) => ({ ok: false, reason });
    if (!connection || connection.clientKind !== "app") return deny("not_app_client");
    const attemptId = receipt && typeof receipt === "object" ? receipt.attemptId : null;
    const attempt = isId(attemptId) ? pending.get(attemptId) : null;
    if (!attempt) {
      for (const done of settled.values()) {
        if (done.attemptId === attemptId && isId(attemptId)) return deny("already_settled");
      }
      return deny(coveredChars(receipt, Number.MAX_SAFE_INTEGER) === null ? "malformed_receipt" : "unknown_attempt");
    }
    if (attempt.clientId !== connection.clientId) return deny("recipient_mismatch");
    const covered = coveredChars(receipt, attempt.target.textLength);
    if (covered === null) return deny("malformed_receipt");
    if (!sameTarget(attempt.target, receipt)) return deny("target_mismatch");
    pending.delete(attempt.attemptId);
    settle(attempt.candidateKey, {
      ...result("sdk_accepted", null, {
        kind: REPLY_DELIVERY_EVIDENCE_KIND,
        lane: receipt.lane,
        coveredChars: covered,
      }),
      attemptId: attempt.attemptId,
    });
    return { ok: true, reason: null };
  }

  function status(candidateKey) {
    expire();
    if (attemptFor(candidateKey)) return result("pending", null);
    const done = settled.get(candidateKey);
    if (!done) return result("unconfirmed", "unknown_candidate");
    return result(done.status, done.reason, done.evidence);
  }

  function forgetClient(clientId) {
    for (const attempt of [...pending.values()]) {
      if (attempt.clientId === clientId) dropAttempt(attempt, "recipient_disconnected");
    }
  }

  function invalidate(candidateKey) {
    const active = attemptFor(candidateKey);
    if (active) pending.delete(active.attemptId);
    settled.delete(candidateKey);
  }

  return { observe, accept, status, forgetClient, invalidate, sweep: expire };
}

module.exports = { REPLY_RENDER_PROBE_TYPE, REPLY_RENDER_RECEIPT_TYPE, REPLY_DELIVERY_CAPABILITY, REPLY_DELIVERY_EVIDENCE_KIND, REPLY_DELIVERY_DEADLINE_MS, REPLY_DELIVERY_MAX_PENDING, REPLY_DELIVERY_MAX_RANGES, REPLY_DELIVERY_LANES, createReplyDelivery };
