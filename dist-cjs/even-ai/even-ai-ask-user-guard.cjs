const ASK_USER_TOOL_NAME = "ask_user";

const EVEN_AI_ASK_USER_BLOCK_REASON =
  "The user is talking through Even AI on their glasses, which cannot show " +
  "ask_user questions. Ask the question in plain text in your reply instead, " +
  "with any options as a short numbered list in the sentence, then end your " +
  "turn. Their next Even AI message is the answer.";

const EVEN_AI_RUN_TTL_MS = 3_600_000;
const EVEN_AI_RUN_CAP = 512;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createEvenAiAskUserGuard(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const onBlocked = typeof opts.onBlocked === "function" ? opts.onBlocked : () => {};
  const evenAiRuns = new Map();

  function prune(nowMs) {
    for (const [runId, expiresAtMs] of evenAiRuns) {
      if (expiresAtMs > nowMs) break;
      evenAiRuns.delete(runId);
    }
  }

  function noteEvenAiRun(runIdValue) {
    const runId = trimString(runIdValue);
    if (!runId) return false;
    const nowMs = now();
    prune(nowMs);
    evenAiRuns.delete(runId);
    if (evenAiRuns.size >= EVEN_AI_RUN_CAP) {
      const oldest = evenAiRuns.keys().next().value;
      if (oldest !== undefined) evenAiRuns.delete(oldest);
    }
    evenAiRuns.set(runId, nowMs + EVEN_AI_RUN_TTL_MS);
    return true;
  }

  function observePromptTurnOwnership(consume) {
    return (sessionKey, identity = null) => {
      const ownership = consume(sessionKey, identity);
      if (ownership && ownership.owner === "even-ai") noteEvenAiRun(identity);
      return ownership;
    };
  }

  function isEvenAiRun(runIdValue) {
    const runId = trimString(runIdValue);
    if (!runId) return false;
    const expiresAtMs = evenAiRuns.get(runId);
    if (expiresAtMs === undefined) return false;
    if (expiresAtMs <= now()) {
      evenAiRuns.delete(runId);
      return false;
    }
    return true;
  }

  function beforeToolCall(event, ctx = null) {
    if (trimString(event?.toolName) !== ASK_USER_TOOL_NAME) return undefined;
    const runId = trimString(event?.runId) || trimString(ctx?.runId);
    if (!isEvenAiRun(runId)) return undefined;
    try {
      onBlocked({ runId, sessionKey: trimString(ctx?.sessionKey) || null });
    } catch (_err) {

    }
    return { block: true, blockReason: EVEN_AI_ASK_USER_BLOCK_REASON };
  }

  return { noteEvenAiRun, observePromptTurnOwnership, isEvenAiRun, beforeToolCall };
}

module.exports = { ASK_USER_TOOL_NAME, EVEN_AI_ASK_USER_BLOCK_REASON, createEvenAiAskUserGuard };
