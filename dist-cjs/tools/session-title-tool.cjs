const SESSION_TITLE_LIMITS = {
  titleMax: 55,
};

const sessionTitleParametersSchema = {
  type: "object",
  required: ["title"],
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: SESSION_TITLE_LIMITS.titleMax,
    },
  },
  additionalProperties: false,
};

function validateSessionTitleInput(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "missing_field", message: "input must be an object with a title field" };
  }
  if (!("title" in input)) {
    return { ok: false, code: "missing_field", message: "title field is required" };
  }
  if (typeof input.title !== "string") {
    return { ok: false, code: "invalid_type", message: "title must be a string" };
  }
  const trimmed = input.title.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "title_empty", message: "title cannot be empty or whitespace-only" };
  }
  if (trimmed.length > SESSION_TITLE_LIMITS.titleMax) {
    return {
      ok: false,
      code: "title_too_long",
      message: `title is ${trimmed.length} chars; max ${SESSION_TITLE_LIMITS.titleMax}`,
    };
  }
  return { ok: true, spec: { title: trimmed } };
}

const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY, isHermesEvenAiSessionKey } = require("../domain/even-ai-session-keys.cjs");

function isEvenAiDedicatedKey(sessionKey) {
  if (typeof sessionKey !== "string") return false;
  const normalized = sessionKey.trim().toLowerCase();
  return (
    normalized === DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY ||
    normalized.startsWith(`${DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY}:`) ||
    isHermesEvenAiSessionKey(normalized)
  );
}

function gateReason(sessionKey, deps) {

  if (
    typeof deps.hasRecordedUserMessage === "function" &&
    !deps.hasRecordedUserMessage(sessionKey)
  ) {
    return "no_user_message_yet";
  }
  return null;
}

function createSessionTitleToolHandler(deps) {
  async function setSessionTitle(params) {
    const validation = validateSessionTitleInput(params);
    if (!validation.ok) {
      const err = new Error(`${validation.code}: ${validation.message}`);
      err.code = validation.code;
      throw err;
    }
    const sessionKey = deps.peekSessionKey();
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      const err = new Error(
        "no_active_session: no OcuClaw session is currently active",
      );
      err.code = "no_active_session";
      throw err;
    }
    if (isEvenAiDedicatedKey(sessionKey)) {
      const err = new Error(
        "session_not_renamable: the persistent EvenAI session cannot be retitled",
      );
      err.code = "session_not_renamable";
      throw err;
    }
    const blockedReason = gateReason(sessionKey, deps);
    if (blockedReason) {
      const err = new Error(`${blockedReason}: tool unavailable for this session`);
      err.code = blockedReason;
      throw err;
    }
    const result = await deps.setSessionTitle(sessionKey, validation.spec.title, {
      origin: "user_tool",
    });
    if (result && result.ok === false) {
      const err = new Error(`${result.code}: ${result.message || "set rejected"}`);
      err.code = result.code;
      throw err;
    }
    return result || { ok: true };
  }
  return { setSessionTitle };
}

const TOOL_DESCRIPTION = [
  "Rename the current chat session (shown in the user's glasses session list).",
  "",
  "Call ONLY when the user explicitly asks to rename or retitle the session.",
  "Automatic titling is handled elsewhere — do not call this proactively.",
  "",
  "Title: 2-5 word noun phrase, ≤55 chars, no trailing punctuation or quotes.",
].join("\n");

function registerSessionTitleTool(api, service) {
  if (!api || typeof api.registerTool !== "function") {
    throw new Error("registerSessionTitleTool requires api.registerTool");
  }
  if (!service) {
    throw new Error("registerSessionTitleTool requires the OcuClaw relay service");
  }

  const handler = createSessionTitleToolHandler({
    peekSessionKey: () => service.peekSessionKey(),
    setSessionTitle: (sessionKey, title, opts) => service.setSessionTitle(sessionKey, title, opts),
    isSessionUserLocked: (sessionKey) => service.isSessionUserLocked(sessionKey),
    isNeuralSessionNamesEnabled: (sessionKey) => service.isNeuralSessionNamesEnabled(sessionKey),
    hasRecordedUserMessage: (sessionKey) => service.hasRecordedUserMessage(sessionKey),
  });

  api.registerTool({
    name: "set_session_title",
    description: TOOL_DESCRIPTION,
    parameters: sessionTitleParametersSchema,
    async execute(_toolCallId, params) {
      await handler.setSessionTitle(params);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "accepted" }) }],
      };
    },
  });
}

module.exports = { SESSION_TITLE_LIMITS, sessionTitleParametersSchema, validateSessionTitleInput, createSessionTitleToolHandler, TOOL_DESCRIPTION, registerSessionTitleTool };
