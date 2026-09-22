const { randomUUID, createHmac } = require("node:crypto");

const fs = require("node:fs");

const path = require("node:path");

function requestProofStore(stateDir     ) {
  const file = typeof stateDir === "string" && stateDir ? path.join(stateDir, "even-ai-request-proof.json") : null;
  let salt = randomUUID();
  const entries = new Map();
  if (file) try {
    if (fs.statSync(file).size <= 32768) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.version === 1 && typeof saved.salt === "string" && /^[a-f0-9-]{36}$/.test(saved.salt) && Array.isArray(saved.entries)) {
        salt = saved.salt;
        for (const row of saved.entries.slice(-16)) {
          if (!row || !/^[a-f0-9]{64}$/.test(row.key) || !["succeeded", "failed"].includes(row.outcome)
            || !Number.isFinite(row.observedAtMs) || row.observedAtMs < 0) continue;
          entries.set(row.key, { outcome: row.outcome, observedAtMs: row.observedAtMs,
            succeededAtMs: Number.isFinite(row.succeededAtMs) && row.succeededAtMs >= 0 && row.succeededAtMs <= row.observedAtMs ? row.succeededAtMs : null });
        }
      }
    }
  } catch {  }
  return {
    key: (context     ) => createHmac("sha256", salt).update(JSON.stringify(context) ?? "null").digest("hex"),
    get: (key        ) => entries.get(key),
    set(key        , value     ) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > 16) entries.delete(entries.keys().next().value);
      if (!file) return;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, salt,
          entries: [...entries].map(([key, value]) => ({ key, ...value })) }), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, file);
      } catch {  }
      finally { try { fs.unlinkSync(temporary); } catch {} }
    },
  };
}

function createEvenAiRequestObservation(options      = {}) {
  const readContext = options.readContext || (() => null);
  const readProofContext = options.readProofContext || readContext;
  const proofs = requestProofStore(options.stateDir);
  let proofKey      = null;
  const now = options.now || Date.now;
  const newRevision = options.newRevision || randomUUID;
  const changed = options.onChange || (() => {});
  let revision = newRevision();
  let context      = undefined;
  let outcome = "unknown";
  let observedAtMs      = null;
  let succeededAtMs      = null;
  let serial = 0;
  let settledSerial = 0;
  let testState = "idle";
  let testSerial = 0;
  let expiresAtMs      = null;
  let timer      = null;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  function expire() {
    if (["waiting", "received"].includes(testState) && now() >= expiresAtMs) {
      testState = "timed_out";
      clearTimer();
      changed();
    }
  }

  function refresh() {
    const next = JSON.stringify(readContext());
    const nextProofKey = proofs.key(readProofContext());
    if (next === context && nextProofKey === proofKey) return false;
    const first = context === undefined;
    context = next;
    proofKey = nextProofKey;
    if (!first) revision = newRevision();
    const proof = proofs.get(proofKey);
    outcome = proof?.outcome ?? "unknown";
    observedAtMs = proof?.observedAtMs ?? null;
    succeededAtMs = proof?.succeededAtMs ?? null;
    settledSerial = 0;
    clearTimer();
    testState = "idle";
    testSerial = 0;
    expiresAtMs = null;
    if (!first) changed();
    return !first;
  }
  return {
    refresh,
    close: clearTimer,
    arm() {
      refresh();
      expire();
      if (["waiting", "received"].includes(testState)) return false;
      testState = "waiting";
      testSerial = 0;
      expiresAtMs = now() + 120_000;
      clearTimer();
      timer = setTimeout(expire, 120_000);
      timer?.unref?.();
      changed();
      return true;
    },
    cancel() {
      refresh();
      if (!["waiting", "received"].includes(testState)) return;
      clearTimer();
      testState = "cancelled";
      changed();
    },
    begin() {
      refresh();
      expire();
      const ticket = { revision, serial: ++serial };
      if (testState === "waiting") {
        testState = "received";
        testSerial = ticket.serial;
        changed();
      }
      return ticket;
    },
    decorateReply(ticket     , text        ) {
      refresh();
      expire();
      return ticket?.revision === revision && ticket.serial === testSerial && testState === "received" && text.trim()
        ? `OcuClaw is now configured correctly with Even AI.\n\n${text}` : text;
    },
    complete(ticket     , result     ) {
      refresh();
      if (!ticket || ticket.revision !== revision || !Number.isInteger(ticket.serial)
        || ticket.serial <= settledSerial || !["succeeded", "failed"].includes(result)) return false;
      settledSerial = ticket.serial;
      outcome = result;
      observedAtMs = now();
      if (result === "succeeded") succeededAtMs = observedAtMs;
      proofs.set(proofKey, { outcome, observedAtMs, succeededAtMs });
      expire();
      if (ticket.serial === testSerial && testState === "received") {
        testState = result === "succeeded" ? "replied" : "failed";
        clearTimer();
      } else if (!["waiting", "received"].includes(testState)) {

        testState = "idle";
        testSerial = 0;
        expiresAtMs = null;
      }
      changed();
      return true;
    },
    getSnapshot() {
      refresh();
      expire();
      return { revision, requestOutcome: outcome, evidence: "runtime-request", observedAtMs, testState, expiresAtMs, succeededAtMs };
    },
  };
}

function normalizeEvenAiRequestObservation(value     ) {
  if (!value || typeof value.revision !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.revision)
    || !["unknown", "succeeded", "failed"].includes(value.requestOutcome)
    || value.evidence !== "runtime-request") return null;
  const observedAtMs = value.requestOutcome === "unknown" ? null : value.observedAtMs;
  if (value.requestOutcome !== "unknown" && (!Number.isFinite(observedAtMs) || observedAtMs < 0)) return null;
  return { revision: value.revision, requestOutcome: value.requestOutcome, evidence: "runtime-request", observedAtMs,
    testState: ["idle", "waiting", "received", "replied", "failed", "cancelled", "timed_out"].includes(value.testState) ? value.testState : "idle",
    expiresAtMs: Number.isFinite(value.expiresAtMs) ? value.expiresAtMs : null,
    succeededAtMs: Number.isFinite(observedAtMs) && Number.isFinite(value.succeededAtMs) && value.succeededAtMs >= 0 && value.succeededAtMs <= observedAtMs ? value.succeededAtMs
      : value.requestOutcome === "succeeded" ? observedAtMs : null };
}

module.exports = { createEvenAiRequestObservation, normalizeEvenAiRequestObservation };
