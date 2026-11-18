const { evenAiSessionKeysMatch } = require("../domain/even-ai-session-keys.cjs");
const { classifyRunOutcomeFrame, isCancelledRunFrame } = require("../runtime/upstream-runtime.cjs");
const { extractAssistantText } = require("./even-ai-run-waiter.cjs");

const NATIVE_PERFORMANCE_TYPE = "ocuclaw.evenai.performance";
const PRE_ACK_LIMIT = 32;
const TEXT_LIMIT = 16_000;
const TEXT_INTERVAL_MS = 200;
const FINAL_TEXT_GRACE_MS = 1_000;
const OBSERVATION_LIMIT_MS = 120_000;

function observeNativePerformance(options

 ) {
  const generation = options.generation;
  const offs                 = [];
  const pending                                = [];
  let runId = "", seq = 0, closed = false, messageIndex = 0;
  let lastText = "", lastActivity = "";
  let textTimer                                       = null;
  let finalTextTimer                                       = null;
  let queuedText                                                = null;
  let textSentAt = 0;
  const send = (phase                                 , extra                                  = {}, retiredBinding = false) => {
    if (closed && !retiredBinding) return;
    try {
      options.publish({ type: NATIVE_PERFORMANCE_TYPE, version: 1,
        requestId: options.requestId, servingRequestId: options.servingRequestId || options.requestId,
        backend: options.backend, sessionKey: options.sessionKey, generation, seq: ++seq, phase,
        ...(runId ? { runId } : {}), ...extra });
    } catch {  }
  };
  const retire = (phase                                      , text         ) => {
    if (closed) return;
    if (textTimer) clearTimeout(textTimer);
    if (finalTextTimer) clearTimeout(finalTextTimer);
    finalTextTimer = null;
    if (phase === "completed" && queuedText) send("text", queuedText);
    textTimer = null; queuedText = null;
    send(phase, typeof text === "string" ? { text: text.slice(0, TEXT_LIMIT), messageIndex } : {});
    closed = true; clearTimeout(timer); pending.length = 0;
    for (const off of offs.splice(0)) off();
    options.onRetired?.();
  };
  const ingest = (kind        , data     ) => {
    if (closed || !data || !evenAiSessionKeysMatch(data.sessionKey, options.sessionKey) || typeof data.runId !== "string") return;
    if (!runId) {

      if (pending.length === PRE_ACK_LIMIT) pending.shift();
      pending.push({ kind, data: {
        runId: data.runId, sessionKey: data.sessionKey,
        text: typeof data.text === "string" ? data.text.slice(0, TEXT_LIMIT) : undefined,
        content: kind === "message" ? extractAssistantText(data.content).slice(0, TEXT_LIMIT) : undefined,
        role: data.role, turnActive: data.turnActive, retag: data.retag, messageKind: data.messageKind,
        origin: data.origin, code: data.code, aborted: data.aborted,
        messageIndex: data.messageIndex, intent: data.intent, tool: data.tool,
        state: data.state, phase: data.phase, toolPhase: data.toolPhase,
        isError: data.isError, failoverPending: data.failoverPending,
      } });
      return;
    }
    if (data.runId !== runId) return;
    if (kind === "message") {
      const messageKind = typeof data.messageKind === "string" ? data.messageKind.trim().toLowerCase() : "";
      if ((data.role && data.role !== "assistant") || data.turnActive === true || data.retag === true ||
          ["narration", "tool_progress"].includes(messageKind)) return;
      retire("completed", extractAssistantText(data.content));
    } else if (kind === "streaming" && typeof data.text === "string") {
      const index = Number.isSafeInteger(data.messageIndex) && data.messageIndex >= 0 ? data.messageIndex : 0;
      const text = data.text.slice(0, TEXT_LIMIT);
      if (index === messageIndex && text === lastText) return;
      if (queuedText && index !== messageIndex) {
        send("text", queuedText); queuedText = null;
        if (textTimer) clearTimeout(textTimer);
        textTimer = null;
      }
      messageIndex = index; lastText = text;
      queuedText = { text, messageIndex };
      const flush = () => {
        textTimer = null;
        if (queuedText) { send("text", queuedText); queuedText = null; textSentAt = Date.now(); }
      };
      if (!textTimer) {
        const remaining = TEXT_INTERVAL_MS - (Date.now() - textSentAt);
        if (remaining <= 0) flush();
        else textTimer = setTimeout(flush, remaining);
      }
    } else if (kind === "activity") {

      const outcome = classifyRunOutcomeFrame(data, data.phase, data.origin);
      if (outcome.terminal) {
        if (isCancelledRunFrame(data)) retire("cancelled");
        else if (outcome.errored) retire("failed");

        else if (!finalTextTimer) finalTextTimer = setTimeout(() => retire("completed", lastText), FINAL_TEXT_GRACE_MS);
        return;
      }
      if (finalTextTimer) return;
      if (data.toolPhase === "end") return;
      const fields = {
        intent: typeof data.intent === "string" ? data.intent.slice(0, 80) : "",
        tool: typeof data.tool === "string" ? data.tool.slice(0, 80) : "",
        state: typeof data.state === "string" ? data.state.slice(0, 40) : "",
      };
      const key = JSON.stringify(fields);
      if (key !== lastActivity) { lastActivity = key; send("activity", fields); }
    }
  };
  const subscribe = (name        , listener                     ) => {
    const off = options.bridge.on(name, listener);
    offs.push(typeof off === "function" ? off               : () => options.bridge.off?.(name, listener));
  };
  const timer = setTimeout(() => retire("cancelled"), OBSERVATION_LIMIT_MS);
  subscribe("streaming", data => ingest("streaming", data));
  subscribe("activity", data => ingest("activity", data));
  subscribe("message", data => ingest("message", data));
  subscribe("disconnected", () => retire("cancelled"));
  send("accepted");
  return {
    bind(id        ) {
      if (runId || !id) return;

      runId = id; send("bound", {}, closed);
      if (closed) return;
      for (const item of pending.splice(0)) ingest(item.kind, item.data);
    },
    complete(text        ) { retire("completed", text); },
    fail() { retire("failed"); },
    cancel() { retire("cancelled"); },
  };
}

module.exports = { NATIVE_PERFORMANCE_TYPE, observeNativePerformance };
