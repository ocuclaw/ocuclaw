const MODEL_OUTPUT_ITEM_KINDS = new Set(["analysis", "preamble", "answer_candidate"]);
const TOOL_ITEM_KINDS = new Set(["tool", "command", "patch", "search"]);
const MAX_TRACKED_RUNS = 16;
const MAX_TRACKED_TOOLS = 256;

function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runKey(runId         )                {
  return typeof runId === "string" && runId.trim() ? runId.trim() : null;
}

function isCount(value         )          {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function lowerToken(value         )         {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function createOpenclawModelCallTracker() {
  const runs = new Map                       ();

  function stateOf(runId         )                       {
    const key = runKey(runId);
    return key ? runs.get(key) || null : null;
  }

  function startCall(state               ) {
    state.seq += 1;
    state.ended = false;
    state.toolEnded = false;
  }

  function onModelOutput(state               ) {
    if (state.seq === 0 || state.ended || state.toolEnded) startCall(state);
  }

  function onToolStart(state               ) {
    if (state.seq === 0 || state.ended) startCall(state);
  }

  function beginRun(runId         ) {
    const key = runKey(runId);
    if (!key) return;
    runs.delete(key);
    runs.set(key, {
      seq: 0,
      codex: false,
      ended: false,
      toolEnded: false,
      finishing: false,
      tools: new Map(),
    });
    while (runs.size > MAX_TRACKED_RUNS) runs.delete(runs.keys().next().value          );
  }

  function clear() {
    runs.clear();
  }

  function observe(runId         , stream         , data         ) {
    const state = stateOf(runId);
    if (!state || !isRecord(data)) return;
    const phase = lowerToken(data.phase);
    switch (stream) {
      case "codex_app_server":
        state.codex = true;
        return;
      case "lifecycle":
        if (phase === "finishing" || phase === "end" || phase === "error") {
          state.finishing = true;
        } else if (phase === "model" && !state.finishing) {
          if (lowerToken(data.provider) === "codex") state.codex = true;
          startCall(state);
        }
        return;
      case "usage":
        if (state.codex && (isCount(data.activeContextTokens) || isCount(data.inputTokens))) {
          state.ended = true;
        }
        return;
      case "thinking":
      case "assistant":
        onModelOutput(state);
        return;
      case "item": {
        const kind = lowerToken(data.kind);
        if (MODEL_OUTPUT_ITEM_KINDS.has(kind)) {
          if (phase !== "end") onModelOutput(state);
        } else if (TOOL_ITEM_KINDS.has(kind)) {
          if (phase === "start") onToolStart(state);
          else if (phase === "end") state.toolEnded = true;
        }
        return;
      }
      case "tool":
        if (phase === "start") onToolStart(state);
        else if (phase === "result") state.toolEnded = true;
        return;
      default:
        return;
    }
  }

  function current(runId         )                {
    const state = stateOf(runId);
    return state && state.seq > 0 ? state.seq : null;
  }

  function forTool(runId         , toolCallId         , toolPhase                            ) {
    const state = stateOf(runId);
    if (!state) return null;
    const id = runKey(toolCallId);
    const seq = state.seq > 0 ? state.seq : null;
    if (!id) return seq;
    if (toolPhase === "start") {
      if (seq !== null && !state.tools.has(id)) {
        state.tools.set(id, seq);
        while (state.tools.size > MAX_TRACKED_TOOLS) {
          state.tools.delete(state.tools.keys().next().value          );
        }
      }
      return state.tools.get(id) ?? seq;
    }
    const started = state.tools.get(id);
    if (toolPhase === "end") state.tools.delete(id);
    return started ?? seq;
  }

  return { beginRun, clear, observe, current, forTool };
}

function positiveModelCallSeq(value         )                {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

module.exports = { createOpenclawModelCallTracker, positiveModelCallSeq };
