const MAX_TRACES = 64;
const NOTE_MAX_CHARS = 600;
const FAILED_TURN_ID_PREFIX = "failed:";

const FAILED_LINES                         = {
  provider_rate_limited: "The model is rate limited.",
  provider_quota_exhausted: "The model is out of credits.",
  provider_auth_invalid: "The model sign-in expired.",
  provider_unavailable: "The model didn't answer.",
  provider_timeout: "The model didn't answer.",
  provider_request_invalid: "The model refused the request.",
};
const FAILED_LINE_DEFAULT = "The agent hit an error.";

function text(raw         )         {
  return typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
}

function failedTurnLine(code        )         {
  return `Failed: ${FAILED_LINES[code] || FAILED_LINE_DEFAULT}`;
}

function failedTurnText(trace                 )         {
  const line = failedTurnLine(trace.code);
  return trace.note ? `${trace.note}\n\n${line}` : line;
}

function isNoteText(rowText        , note               )          {
  if (!note || !rowText) return false;
  return rowText === note || (note.endsWith("…") && rowText.startsWith(note.slice(0, -1)));
}

function userAnchorKeys(msg     , textOf                      )           {
  if (!msg || msg.role !== "user") return [];
  const keys           = [];
  const runId = text(msg.runId);
  if (runId) keys.push(`run:${runId}`);
  for (const sendId of [msg.clientSendId, msg.sendId, msg.idempotencyKey]) {
    if (text(sendId)) keys.push(`send:${text(sendId)}`);
  }
  const serverId = text(msg.id ?? msg.messageId ?? msg.__openclaw?.id);
  if (serverId) keys.push(`srv:${serverId}`);
  const words = (textOf(msg) || "").replace(/\s+/g, " ").trim();
  if (words) keys.push(`text:${words}`);
  return keys;
}

function isFailedTurnMessage(msg     )          {
  return !!msg && msg.role === "assistant" && !!msg.failedTurn;
}

function createFailedTurnTraces() {
  const traces                    = [];

  function record(
    input                                                               ,
    messages       ,
    textOf                      ,
  )          {
    const runId = text(input.runId);
    if (!runId) return false;
    let anchor      = null;
    let note = "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const msg = messages[index];
      if (!msg || isFailedTurnMessage(msg)) continue;
      if (!note && msg.role === "assistant" && text(msg.runId) === runId) note = text(textOf(msg));
      if (msg.role === "user" && (text(msg.runId) === runId || !anchor)) {
        anchor = msg;
        if (text(msg.runId) === runId) break;
      }
    }
    const anchorKeys = userAnchorKeys(anchor, textOf);
    if (anchorKeys.length === 0) return false;
    if (!note) note = text(input.streamedText);
    const trimmed = note.length > NOTE_MAX_CHARS ? `${note.slice(0, NOTE_MAX_CHARS - 1).trimEnd()}…` : note;
    const existing = traces.findIndex((trace) => trace.runId === runId);
    if (existing >= 0) traces.splice(existing, 1);
    traces.push({ runId, code: text(input.code) || "agent_error", note: trimmed || null, anchorKeys });
    while (traces.length > MAX_TRACES) traces.shift();
    return true;
  }

  function weave(messages       , textOf                      )        {
    const woven = messages.filter((msg) => !isFailedTurnMessage(msg));
    if (traces.length === 0) return woven;
    for (const trace of traces) {
      const wanted = new Set(trace.anchorKeys);
      let anchor = -1;

      for (const prefix of ["run:", "send:", "srv:", "text:"]) {
        for (let index = woven.length - 1; index >= 0; index -= 1) {
          if (userAnchorKeys(woven[index], textOf).some((key) => key.startsWith(prefix) && wanted.has(key))) {
            anchor = index;
            break;
          }
        }
        if (anchor >= 0) break;
      }
      if (anchor < 0) continue;
      let end = anchor + 1;
      let answered = false;
      let noteRow = -1;
      while (end < woven.length && woven[end]?.role !== "user") {
        const msg = woven[end];

        if (msg?.role === "assistant" && text(msg.runId) === trace.runId) {
          if (noteRow < 0 && isNoteText(text(textOf(msg)), trace.note)) noteRow = end;
        } else if (msg?.role === "assistant" && text(textOf(msg))) {
          answered = true;
        }
        end += 1;
      }
      if (answered) continue;
      if (noteRow >= 0) {
        woven.splice(noteRow, 1);
        end -= 1;
      }
      woven.splice(end, 0, {
        role: "assistant",
        id: `${FAILED_TURN_ID_PREFIX}${trace.runId}`,
        runId: trace.runId,
        content: failedTurnText(trace),
        failedTurn: { code: trace.code },
      });
    }
    return woven;
  }

  return { record, weave, count: () => traces.length, reset: () => { traces.length = 0; } };
}

module.exports = { FAILED_TURN_ID_PREFIX, failedTurnLine, failedTurnText, userAnchorKeys, isFailedTurnMessage, createFailedTurnTraces };
