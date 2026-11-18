const KINDS = new Set(["model_call", "compaction", "subagent", "retry_wait"]);
const LABEL_FIELDS = ["outcome", "provider", "model", "label", "reason"]         ;
const ID_FIELDS = ["childSessionKey", "childRunId"]         ;
const COUNT_FIELDS = ["attempt", "maxAttempts"]         ;
const LABEL_MAX_CHARS = 120;
const ID_MAX_CHARS = 512;
const DEFAULT_MAX_OPEN = 256;

const DEFAULT_OPEN_TTL_MS = 6 * 60 * 60 * 1000;

function text(raw         , maxChars        )                {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed && trimmed.length <= maxChars ? trimmed : null;
}

function normalizeRunSignal(raw         , nowMs        )                        {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw                           ;
  const signal = text(data.signal, ID_MAX_CHARS);
  const phase = text(data.phase, ID_MAX_CHARS);
  const sessionKey = text(data.sessionKey, ID_MAX_CHARS);
  if (!signal || !KINDS.has(signal) || (phase !== "start" && phase !== "end") || !sessionKey) {
    return null;
  }
  const atMs = typeof data.atMs === "number" && Number.isFinite(data.atMs) && data.atMs > 0 ? data.atMs : nowMs;
  const frame                 = {
    signal: signal                 ,
    phase,
    sessionKey,
    runId: text(data.runId, ID_MAX_CHARS),
    spanId: text(data.spanId, ID_MAX_CHARS) || signal,
    atMs,
  };
  for (const field of LABEL_FIELDS) {
    const value = text(data[field], LABEL_MAX_CHARS);
    if (value) frame[field] = value;
  }
  for (const field of ID_FIELDS) {
    const value = text(data[field], ID_MAX_CHARS);
    if (value) frame[field] = value;
  }
  for (const field of COUNT_FIELDS) {
    const value = data[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) frame[field] = value;
  }
  if (frame.signal === "retry_wait" && frame.phase === "start") {
    const retryAtMs = data.retryAtMs;
    const waitMs = data.waitMs;
    if (typeof retryAtMs === "number" && Number.isFinite(retryAtMs) && retryAtMs > 0) {
      frame.retryAtMs = retryAtMs;
      frame.waitMs = Math.max(0, Math.round(retryAtMs - nowMs));
    } else if (typeof waitMs === "number" && Number.isFinite(waitMs) && waitMs >= 0) {
      frame.waitMs = Math.round(waitMs);
    }
  }
  return frame;
}

function spanKey(frame                )         {
  return [frame.signal, frame.sessionKey, frame.runId || "", frame.spanId].join("\u0000");
}

function endOf(start                , outcome        , atMs        )                 {
  return {
    signal: start.signal,
    phase: "end",
    sessionKey: start.sessionKey,
    runId: start.runId,
    spanId: start.spanId,
    atMs,
    outcome,
  };
}

function createRunSignalTracker(
  options                                                               = {},
) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const maxOpen = Number.isInteger(options.maxOpen) && Number(options.maxOpen) > 0
    ? Number(options.maxOpen)
    : DEFAULT_MAX_OPEN;
  const openTtlMs = Number.isFinite(options.openTtlMs) && Number(options.openTtlMs) > 0
    ? Number(options.openTtlMs)
    : DEFAULT_OPEN_TTL_MS;

  const open = new Map                  ();

  function prune(at        , room        ) {
    for (const [key, span] of open) {
      if (open.size + room <= maxOpen && at - span.openedAt <= openTtlMs) break;
      open.delete(key);
    }
  }

  function endWhere(match                                    , outcome        , atMs        ) {
    const ended                   = [];
    for (const [key, span] of open) {
      if (!match(span.frame)) continue;
      open.delete(key);
      ended.push(endOf(span.frame, outcome, atMs));
    }
    return ended;
  }

  function ingest(raw         )                   {
    const at = now();
    const frame = normalizeRunSignal(raw, at);
    if (!frame) return [];
    prune(at, 0);
    const key = spanKey(frame);
    if (frame.phase === "end") return open.delete(key) ? [frame] : [];
    if (open.has(key)) return [];
    if (frame.signal === "retry_wait" && frame.retryAtMs !== undefined && frame.waitMs === 0) return [];
    const runId = frame.runId;
    const frames = frame.signal === "model_call" && runId
      ? endWhere(
        (start) => start.signal === "retry_wait" && start.runId === runId && start.sessionKey === frame.sessionKey,
        "retrying",
        frame.atMs,
      )
      : [];
    prune(at, 1);
    open.set(key, { frame, openedAt: at });
    frames.push(frame);
    return frames;
  }

  function endRun(runId         )                   {
    if (typeof runId !== "string" || !runId) return [];
    return endWhere((start) => start.runId === runId, "run_ended", now());
  }

  return {
    ingest,
    endRun,
    openCount: () => open.size,
  };
}

module.exports = { normalizeRunSignal, createRunSignalTracker };
