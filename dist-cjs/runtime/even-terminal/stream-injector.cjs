function createEtStreamInjector(deps) {
  const sessions = new Map();

  function state(sessionKey) {
    let s = sessions.get(sessionKey);
    if (!s) {

      s = { acc: "", runId: `et-${sessionKey}`, finalized: true, lastInputTokens: 0 };
      sessions.set(sessionKey, s);
    }
    return s;
  }

  function doFinalize(sessionKey, s, sender, resultText) {
    const finalText = s.acc || (typeof resultText === "string" ? resultText : "");
    if (finalText) {

      const finalBody = deps.renderStreamingBody
        ? deps.renderStreamingBody(finalText, sender)
        : `${sender}: ${finalText}`;
      deps.broadcastStreaming(finalBody);
      deps.addAssistantMessage(finalText, sender);
    }
    deps.broadcastPages();
    deps.broadcastActivity({ state: "idle", sessionKey, runId: s.runId, phase: "complete" });

    if (deps.emitContextSnapshot && s.lastInputTokens > 0) {
      deps.emitContextSnapshot(sessionKey, s.lastInputTokens, false);
    }
    s.acc = "";
    s.finalized = true;
  }

  function handle(ev) {
    if (!ev || typeof ev.type !== "string") return;
    const sessionKey = ev.sessionKey;
    const frame = ev.frame || {};
    const s = state(sessionKey);
    const sender = deps.resolveSender(sessionKey) || "Agent";
    switch (ev.type) {
      case "user_prompt": {
        const text = typeof frame.text === "string" ? frame.text : "";
        if (text) {
          deps.addUserMessage(text);
          deps.broadcastPages();
        }
        s.acc = "";
        s.finalized = false;
        break;
      }
      case "status": {
        if (frame.state === "busy") {
          s.finalized = false;
          deps.broadcastActivity({ state: "thinking", sessionKey, runId: s.runId, phase: "start" });
        } else if (frame.state === "idle") {

          if (!s.finalized) doFinalize(sessionKey, s, sender, "");
        }
        break;
      }
      case "text_delta": {
        s.acc += typeof frame.text === "string" ? frame.text : "";
        s.finalized = false;
        deps.broadcastStreaming(`${sender}: ${s.acc}`);
        break;
      }
      case "tool_start": {
        deps.broadcastActivity({ state: "thinking", sessionKey, runId: s.runId, tool: frame.name || null, phase: "start" });
        break;
      }
      case "running_stats": {

        const inputTokens = typeof frame.inputTokens === "number" ? frame.inputTokens : null;
        if (inputTokens != null) {
          s.lastInputTokens = inputTokens;
          if (deps.emitContextSnapshot) deps.emitContextSnapshot(sessionKey, inputTokens, true);
        }
        break;
      }
      case "result": {

        doFinalize(sessionKey, s, sender, frame.text);
        break;
      }
      default:
        break;
    }
  }

  return { handle };
}

module.exports = { createEtStreamInjector };
