const APPROVAL_PURPOSE_MAX = 120;
const TEXT_TAIL_MAX = 1200;
const USER_TEXT_MAX = 600;
const MAX_RUNS = 32;
const MAX_TOOL_CALLS = 128;
const MAX_SESSIONS = 32;

function setBounded(map     , key     , value     , max     ) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function trimmedString(value     ) {
  return typeof value === "string" ? value.trim() : "";
}

function sessionTail(value     ) {
  return trimmedString(value).replace(/^agent:[^:]+:/i, "").toLowerCase();
}

function tail(text     , max     ) {
  return text.length > max ? text.slice(text.length - max) : text;
}

function cleanPurposeLine(value     , max = APPROVAL_PURPOSE_MAX) {
  if (typeof value !== "string") return "";
  const line = value

    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/`+|\*\*|__/g, "")
    .replace(/^[#>\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function purposeFromPluginDescription(request     ) {
  const raw = trimmedString(request && request.description);
  if (!raw.startsWith("{")) return "";
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? cleanPurposeLine(parsed.description) : "";
  } catch {
    return "";
  }
}

function createApprovalContextRecorder() {
  const toolCalls = new Map();
  const runs = new Map();
  const userTextBySession = new Map();

  function runEntry(runId     ) {
    const existing = runs.get(runId);
    if (existing) return existing;
    const entry = { assistant: "", thinking: "" };
    setBounded(runs, runId, entry, MAX_RUNS);
    return entry;
  }

  function appendStreamText(previous     , data     ) {
    if (typeof data.text === "string" && data.text) {

      return tail(data.text, TEXT_TAIL_MAX);
    }
    if (typeof data.delta === "string" && data.delta) {
      return tail(previous + data.delta, TEXT_TAIL_MAX);
    }
    return previous;
  }

  function noteAgentEvent(runId     , stream     , data     ) {
    if (!data || typeof data !== "object") return;
    const run = trimmedString(runId);
    if (stream === "tool") {
      const toolCallId = trimmedString(data.toolCallId);
      const phase = trimmedString(data.phase).toLowerCase();
      if (!toolCallId || phase !== "start") return;
      const args = data.args && typeof data.args === "object" ? data.args : null;
      setBounded(
        toolCalls,
        toolCallId,
        {
          name: trimmedString(data.name),
          purpose: cleanPurposeLine(args && args.title),
        },
        MAX_TOOL_CALLS,
      );
      return;
    }
    if (!run) return;
    if (stream === "assistant") {
      const entry = runEntry(run);
      entry.assistant = appendStreamText(entry.assistant, data);
    } else if (stream === "thinking") {
      const entry = runEntry(run);
      entry.thinking = appendStreamText(entry.thinking, data);
    }
  }

  function noteUserMessage(sessionKey     , text     ) {
    const key = sessionTail(sessionKey);
    const message = trimmedString(text);
    if (!key || !message || message.startsWith("/")) return;
    setBounded(userTextBySession, key, tail(message, USER_TEXT_MAX), MAX_SESSIONS);
  }

  function contextFor(payload     ) {
    const request = payload && payload.request && typeof payload.request === "object"
      ? payload.request
      : {};
    const toolCallId = trimmedString(request.toolCallId);
    const runId = trimmedString(request.runId);
    const sessionKey = sessionTail(request.sessionKey);
    const tool = toolCallId ? toolCalls.get(toolCallId) : undefined;
    const run = runId ? runs.get(runId) : undefined;
    const purpose = (tool && tool.purpose) || purposeFromPluginDescription(request);
    return {
      purpose,
      userMessage: (sessionKey && userTextBySession.get(sessionKey)) || "",
      assistantText: run ? run.assistant.trim() : "",
      thinkingText: run ? run.thinking.trim() : "",
    };
  }

  function clear() {
    toolCalls.clear();
    runs.clear();
    userTextBySession.clear();
  }

  return { noteAgentEvent, noteUserMessage, contextFor, clear };
}

module.exports = { APPROVAL_PURPOSE_MAX, cleanPurposeLine, createApprovalContextRecorder };
