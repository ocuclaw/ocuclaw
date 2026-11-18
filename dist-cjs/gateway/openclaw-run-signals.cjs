function fields(raw         )         {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw          ) : {};
}

function text(raw         )                {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function count(raw         )                {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function millis(raw         , min        )                {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= min ? raw : null;
}

function phaseOf(raw         )               {
  return raw === "start" || raw === "end" ? raw : null;
}

const OPEN_COMPACTION_RUNS_MAX = 64;

function createOpenclawAgentRunSignals() {
  const openCompactions = new Map                ();
  let compactions = 0;

  function compactionSpanId(runId        , phase       , itemId               )         {
    if (itemId) return itemId;
    const open = openCompactions.get(runId);
    if (phase === "end") {
      openCompactions.delete(runId);
      return open || "compaction";
    }
    if (open) return open;
    compactions += 1;
    const spanId = `compaction-${compactions}`;
    openCompactions.set(runId, spanId);
    for (const key of openCompactions.keys()) {
      if (openCompactions.size <= OPEN_COMPACTION_RUNS_MAX) break;
      openCompactions.delete(key);
    }
    return spanId;
  }

  function compaction(runId        , sessionKey        , data        )                           {
    const phase = phaseOf(data.phase);

    if (!phase || Array.isArray(data.messages)) return null;
    const signal                    = {
      signal: "compaction",
      phase,
      sessionKey,
      runId,
      spanId: compactionSpanId(runId, phase, text(data.itemId)),
      atMs: Date.now(),
    };
    if (phase === "end") {
      const outcome =
        text(data.outcome) ||
        (data.completed === true ? "completed" : data.completed === false ? "failed" : null);
      if (outcome) signal.outcome = outcome;
    }
    return signal;
  }

  function retryWait(runId        , sessionKey        , data        )                    {
    const atMs = Date.now();
    const attempt = count(data.attempt);
    const retryAtMs = millis(data.retryAt, 1);
    const signal                    = {
      signal: "retry_wait",
      phase: "start",
      sessionKey,
      runId,

      spanId: `retry-${attempt ?? 0}-${retryAtMs ?? atMs}`,
      atMs,
    };
    const reason = text(data.reason);
    if (reason) signal.reason = reason;
    if (retryAtMs !== null) signal.retryAtMs = retryAtMs;
    const waitMs = millis(data.delayMs, 0);
    if (waitMs !== null) signal.waitMs = waitMs;
    if (attempt !== null) signal.attempt = attempt;
    const maxAttempts = count(data.maxAttempts);
    if (maxAttempts !== null) signal.maxAttempts = maxAttempts;
    return signal;
  }

  function fromAgentEvent(
    runId         ,
    stream         ,
    data         ,
    sessionKey         ,
  )                           {
    const run = text(runId);
    const session = text(sessionKey);
    if (!run || !session) return null;
    const body = fields(data);
    if (stream === "compaction") return compaction(run, session, body);
    if (stream === "run_status" && body.phase === "retrying") return retryWait(run, session, body);
    return null;
  }

  return { fromAgentEvent };
}

const COMPACTION_RUN_ID = /^(.+):compaction:[^:]+$/;

function ownerRunId(runId               )                {
  const match = runId ? COMPACTION_RUN_ID.exec(runId) : null;
  return match ? match[1] : runId;
}

function modelCallOutcome(event        )                {
  if (event.failureKind === "aborted") return "aborted";
  const outcome = event.outcome;
  return outcome === "completed" || outcome === "error" ? outcome : null;
}

function modelCallRunSignal(
  phase       ,
  event         ,
  ctx         ,
  atMs        ,
)                           {
  const e = fields(event);
  const c = fields(ctx);
  const spanId = text(e.callId);
  const sessionKey = text(e.sessionKey) || text(c.sessionKey);
  if (!spanId || !sessionKey) return null;
  const signal                    = { signal: "model_call", phase, sessionKey, spanId, atMs };
  const runId = ownerRunId(text(e.runId) || text(c.runId));
  if (runId) signal.runId = runId;
  const provider = text(e.provider);
  if (provider) signal.provider = provider;
  const model = text(e.model);
  if (model) signal.model = model;
  const outcome = phase === "end" ? modelCallOutcome(e) : null;
  if (outcome) signal.outcome = outcome;
  return signal;
}

const SUBAGENT_OUTCOMES = new Set(["ok", "error", "timeout", "killed"]);

function subagentOutcome(raw         )         {
  return typeof raw === "string" && SUBAGENT_OUTCOMES.has(raw) ? raw : "unknown";
}

function subagentRunSignal(
  phase       ,
  ctx         ,
  childSessionKey         ,
  childRunId         ,
  atMs        ,
)                           {
  const c = fields(ctx);
  const sessionKey = text(c.requesterSessionKey);
  const child = text(childSessionKey) || text(c.childSessionKey);
  if (!sessionKey || !child) return null;
  const signal                    = {
    signal: "subagent",
    phase,
    sessionKey,

    spanId: child,
    atMs,
    childSessionKey: child,
  };
  const runId = text(childRunId) || text(c.runId);
  if (runId) signal.childRunId = runId;
  return signal;
}

function subagentProgressRunSignal(event         , ctx         , atMs        ) {
  const e = fields(event);
  const phase = e.phase === "started" ? "start" : e.phase === "ended" ? "end" : null;
  if (!phase) return null;
  const signal = subagentRunSignal(phase, ctx, e.childSessionKey, e.runId, atMs);
  if (signal && phase === "end") signal.outcome = subagentOutcome(e.outcome);
  return signal;
}

function subagentSpawnedRunSignal(event         , ctx         , atMs        ) {
  const e = fields(event);
  const signal = subagentRunSignal("start", ctx, e.childSessionKey, e.runId, atMs);
  const label = text(e.label);
  if (signal && label) signal.label = label;
  return signal;
}

function subagentEndedRunSignal(event         , ctx         , atMs        ) {
  const e = fields(event);
  const signal = subagentRunSignal("end", ctx, e.targetSessionKey, e.runId, atMs);
  if (signal) signal.outcome = subagentOutcome(e.outcome);
  return signal;
}

const SENT_SUBAGENT_EDGES = Symbol.for("ocuclaw.openclaw.subagentRunSignalEdges");
const SENT_SUBAGENT_EDGES_MAX = 512;

function firstSubagentEdge(signal                          )                           {
  if (!signal) return null;
  const host      = globalThis;
  if (!(host[SENT_SUBAGENT_EDGES] instanceof Map)) host[SENT_SUBAGENT_EDGES] = new Map();
  const sent                     = host[SENT_SUBAGENT_EDGES];
  const key = `${signal.childSessionKey}\u0000${signal.childRunId || ""}`;
  const last = sent.get(key);
  if (last === "end" || last === signal.phase) return null;
  sent.delete(key);
  sent.set(key, signal.phase);
  for (const old of sent.keys()) {
    if (sent.size <= SENT_SUBAGENT_EDGES_MAX) break;
    sent.delete(old);
  }
  return signal;
}

function hasSubagentProgress(hostVersion         )                 {
  const match =
    typeof hostVersion === "string" ? /^(\d{4})\.(\d+)\.(\d+)/.exec(hostVersion.trim()) : null;
  if (!match) return null;
  const year = Number(match[1]);
  return year > 2026 || (year === 2026 && Number(match[2]) >= 8);
}

function registerOpenclawRunSignalHooks(api     , getRelay               ) {
  function hook(toSignal                                                                          ) {
    return (event         , ctx         )       => {
      try {
        const relay = fields(getRelay());
        const ingest = relay.ingestRunSignal;
        if (typeof ingest !== "function") return;
        const signal = toSignal(event, ctx, Date.now());
        if (signal) ingest.call(relay, signal);
      } catch (_err) {

      }
    };
  }
  api.on("model_call_started", hook((event, ctx, atMs) => modelCallRunSignal("start", event, ctx, atMs)));
  api.on("model_call_ended", hook((event, ctx, atMs) => modelCallRunSignal("end", event, ctx, atMs)));
  const progress = hasSubagentProgress(api.runtime && api.runtime.version);
  if (progress !== false) {
    api.on("subagent_progress", hook((event, ctx, atMs) =>
      firstSubagentEdge(subagentProgressRunSignal(event, ctx, atMs))));
  }
  if (progress !== true) {
    api.on("subagent_spawned", hook((event, ctx, atMs) =>
      firstSubagentEdge(subagentSpawnedRunSignal(event, ctx, atMs))));
    api.on("subagent_ended", hook((event, ctx, atMs) =>
      firstSubagentEdge(subagentEndedRunSignal(event, ctx, atMs))));
  }
}

module.exports = { createOpenclawAgentRunSignals, registerOpenclawRunSignalHooks };
