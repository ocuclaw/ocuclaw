const NATIVE_OBSERVATION_FIELD = "ocuclawNativeObservation";
const NATIVE_OBSERVATION_HEADER = "x-ocuclaw-native-observation";
const RESPONSE_TYPE = "ocuclaw.evenai.observation";
const RETENTION_MS = 120_000;
const TERMINAL_RETENTION_MS = 15_000;
const RECORD_LIMIT = 32;
const FRAME_LIMIT = 64;
const RECORD_BYTES = 128_000;
const encoder = new TextEncoder();
const POLL_MS = 500;
const NATIVE_POLL_TIMEOUT_MS = 2_000;
const NATIVE_POLL_RESPONSE_LIMIT = 196_608;

function parseNativeObservation(value     )                                   {
  if (!value || value.version !== 1 || !["attach", "snapshot"].includes(value.op) ||
      !/^[a-f0-9]{48}$/.test(value.nonce) || !/^chatcmpl-[a-f0-9-]{36}$/.test(value.requestId) ||
      !["hermes", "openclaw"].includes(value.backend) ||
      (value.afterSeq !== undefined && (!Number.isSafeInteger(value.afterSeq) || value.afterSeq < 0))) return null;
  return { version: 1, op: value.op, nonce: value.nonce, requestId: value.requestId,
    backend: value.backend, ...(value.afterSeq === undefined ? {} : { afterSeq: value.afterSeq }) };
}

const terminal = (frame                        ) => ["completed", "failed", "cancelled"].includes(frame.phase);
const identityKey = (id                           ) => `${id.backend}:${id.requestId}:${id.nonce}`;

function createNativeObservationRegistry() {

  const records = new Map                ();
  const remove = (key        ) => { const record = records.get(key); if (record) clearTimeout(record.timer); records.delete(key); };
  return {
    claim(id                           ) {
      const key = identityKey(id);
      if (records.has(key)) return null;
      while (records.size >= RECORD_LIMIT) remove(records.keys().next().value );
      const record         = { frames: [], bytes: 0, droppedThrough: 0,
        timer: setTimeout(() => remove(key), RETENTION_MS) };
      records.set(key, record);
      return (frame                        ) => {
        if (records.get(key) !== record) return;
        const bytes = encoder.encode(JSON.stringify(frame)).byteLength;
        record.frames.push(frame); record.bytes += bytes;
        while (record.frames.length > FRAME_LIMIT || record.bytes > RECORD_BYTES) {
          const dropped = record.frames.shift() ;
          record.bytes -= encoder.encode(JSON.stringify(dropped)).byteLength; record.droppedThrough = dropped.seq;
        }
        if (terminal(frame)) {
          clearTimeout(record.timer);
          record.timer = setTimeout(() => remove(key), TERMINAL_RETENTION_MS);
        }
      };
    },
    snapshot(id                           ) {
      const record = records.get(identityKey(id));
      const cursor = id.afterSeq || 0;
      return { type: RESPONSE_TYPE, version: 1, requestId: id.requestId, nonce: id.nonce,
        state: record ? "admitted" : "unknown", gap: !!record && cursor < record.droppedThrough,
        frames: record ? record.frames.filter(frame => frame.seq > cursor) : [] };
    },
    close() { for (const key of records.keys()) remove(key); },
  };
}

function pollNativePeerObservation(options

 ) {
  let active = true, seq = 0, last                                = null, finished = false;
  let currentAbort                         = null;
  let wake                      = null;
  let closePromise                       = null;
  const deadline = Date.now() + Math.min(RETENTION_MS, options.timeoutMs);
  const publish = (frame                        ) => { try { options.publish(frame); } catch {} };
  const retire = () => {
    if (last && !terminal(last)) publish({ ...last, seq: last.seq + 1, phase: "cancelled", text: undefined });
    finished = true;
  };
  async function poll(force = false) {
    if ((!active && !force) || finished || Date.now() >= deadline) return;
    const abort = new AbortController(); currentAbort = abort;
    const timer = setTimeout(() => abort.abort(), Math.min(NATIVE_POLL_TIMEOUT_MS, deadline - Date.now()));
    try {
      const response = await options.request({ ...options.identity, op: "snapshot", afterSeq: seq }, abort.signal);
      if ((!active && !force) || finished) return;
      if (response?.type !== RESPONSE_TYPE || response.version !== 1 || response.requestId !== options.identity.requestId ||
          response.nonce !== options.identity.nonce || !["unknown", "admitted"].includes(response.state) ||
          !Array.isArray(response.frames) || response.frames.length > FRAME_LIMIT || response.gap === true) {
        active = false; retire(); return;
      }
      if (response.state === "unknown" && last) { active = false; retire(); return; }
      for (const frame of response.frames) {
        if (frame?.type !== "ocuclaw.evenai.performance" || frame.version !== 1 ||
            frame.requestId !== options.identity.requestId || !Number.isSafeInteger(frame.seq) || frame.seq !== seq + 1 ||
            typeof frame.servingRequestId !== "string" || !frame.servingRequestId || frame.servingRequestId.length > 128 ||
            !["hermes", "openclaw"].includes(frame.backend) || typeof frame.sessionKey !== "string" || !frame.sessionKey || frame.sessionKey.length > 512 ||
            typeof frame.generation !== "string" || !frame.generation || frame.generation.length > 128 ||
            !["accepted", "bound", "activity", "text", "completed", "failed", "cancelled"].includes(frame.phase) ||
            (frame.text !== undefined && (typeof frame.text !== "string" || frame.text.length > 16_000)) ||
            (frame.runId !== undefined && (typeof frame.runId !== "string" || !frame.runId || frame.runId.length > 128)) ||
            (frame.messageIndex !== undefined && (!Number.isSafeInteger(frame.messageIndex) || frame.messageIndex < 0)) ||
            ["intent", "tool", "state"].some(key => frame[key] !== undefined && (typeof frame[key] !== "string" || frame[key].length > 80)) ||
            (!last && frame.phase !== "accepted") ||
            (last && (frame.generation !== last.generation || frame.servingRequestId !== last.servingRequestId ||
              frame.backend !== last.backend || frame.sessionKey !== last.sessionKey || (last.runId && frame.runId !== last.runId)))) {
          active = false; retire(); return;
        }
        const safe                         = {
          type: "ocuclaw.evenai.performance", version: 1, requestId: frame.requestId,
          servingRequestId: frame.servingRequestId, backend: frame.backend, sessionKey: frame.sessionKey,
          generation: frame.generation, seq: frame.seq, phase: frame.phase,
          ...Object.fromEntries(["runId", "text", "messageIndex", "intent", "tool", "state"]
            .filter(key => frame[key] !== undefined).map(key => [key, frame[key]])),
        };
        seq = frame.seq; last = safe; publish(safe);
        if (terminal(frame)) { finished = true; active = false; break; }
      }
    } finally { clearTimeout(timer); if (currentAbort === abort) currentAbort = null; }
  }
  const task = (async () => {
    while (active && !finished && Date.now() < deadline) {
      try { await poll(); } catch { if (active) { retire(); active = false; } }
      if (active && !finished) await new Promise      (resolve => {
        const timer = setTimeout(() => { wake = null; resolve(); }, POLL_MS);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
    }
    if (active && !finished) retire();
  })();
  return {
    done: task,
    close(finalSnapshot = false) {
      if (closePromise) return closePromise;
      active = false; wake?.(); currentAbort?.abort();
      closePromise = (async () => {
        await task;
        if (finalSnapshot && !finished) { try { await poll(true); } catch {} }
        if (!finished) retire();
      })();
      return closePromise;
    },
  };
}

module.exports = { NATIVE_OBSERVATION_FIELD, NATIVE_OBSERVATION_HEADER, NATIVE_POLL_TIMEOUT_MS, NATIVE_POLL_RESPONSE_LIMIT, parseNativeObservation, createNativeObservationRegistry, pollNativePeerObservation };
