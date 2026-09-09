const BACKEND_KINDS = Object.freeze(["openclaw", "hermes"]);

const PROMPT_OWNERS = Object.freeze(["ocuclaw", "even-ai"]);

const PROMPT_LANES = Object.freeze([
  "logical-session-frozen",
  "turn-scoped",
]);

const DEFAULT_BACKEND_KIND = "openclaw";

const BACKEND_DISPLAY_NAMES = Object.freeze({
  openclaw: "OpenClaw",
  hermes: "Hermes",
});

const BRIDGE_REQUEST_METHODS = Object.freeze([
  "agent",
  "agent.identity.get",
  "agents.create",
  "agents.files.get",
  "agents.files.set",
  "agents.list",
  "chat.history",
  "chat.send",
  "commands.list",
  "config.get",
  "config.patch",
  "exec.approval.resolve",
  "hermes.management",
  "models.authStatus",
  "models.list",
  "plugin.approval.resolve",
  "profiles.create",
  "profiles.emoji.set",
  "profiles.settings.get",
  "profiles.settings.set",
  "sessions.abort",
  "sessions.compact",
  "sessions.compaction.list",
  "sessions.copy",
  "sessions.delete",
  "sessions.describe",
  "sessions.list",
  "sessions.patch",
  "sessions.resolve",
  "sessions.steer",
  "skills.status",
  "status",
  "usage.status",
]);

const BRIDGE_EVENTS = Object.freeze([
  "activity",
  "agentIdentity",
  "approval",
  "approvalResolved",
  "connectFailed",
  "connected",
  "disconnected",
  "error",
  "history",
  "message",
  "protocol",
  "status",
  "streaming",
  "thinking",
  "thinkingDebug",
  "timing",
]);

const BRIDGE_HOST_HOOKS = Object.freeze([
  "connect",
  "before_prompt_build",
  "before_model_resolve",
  "agent_end",
]);

const METHOD_NOT_FOUND_CODE = -32601;

function isKnownBackendKind(kind) {
  return typeof kind === "string" && BACKEND_KINDS.indexOf(kind) !== -1;
}

function isKnownPromptOwner(owner) {
  return typeof owner === "string" && PROMPT_OWNERS.indexOf(owner) !== -1;
}

function isKnownPromptLane(lane) {
  return typeof lane === "string" && PROMPT_LANES.indexOf(lane) !== -1;
}

function normalizeBridgePrompt(requestOptions) {
  if (!requestOptions || typeof requestOptions !== "object") return null;

  const hasPrompt =
    Object.prototype.hasOwnProperty.call(requestOptions, "prompt") &&
    requestOptions.prompt !== undefined;
  const hasLegacyPrompt =
    Object.prototype.hasOwnProperty.call(requestOptions, "extraSystemPrompt") &&
    requestOptions.extraSystemPrompt !== undefined;

  if (hasPrompt && hasLegacyPrompt) {
    throw new Error("prompt and extraSystemPrompt cannot be supplied together");
  }

  if (!hasPrompt) {
    const content =
      typeof requestOptions.extraSystemPrompt === "string"
        ? requestOptions.extraSystemPrompt.trim()
        : "";
    return content
      ? { content, owner: null, lane: null, legacy: true }
      : null;
  }

  const prompt = requestOptions.prompt;
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    throw new Error("prompt must be an object");
  }
  if (typeof prompt.content !== "string") {
    throw new Error("prompt.content must be a string");
  }
  const content = prompt.content.trim();
  if (!isKnownPromptOwner(prompt.owner)) {
    throw new Error("prompt.owner must be 'ocuclaw' or 'even-ai'");
  }
  if (!isKnownPromptLane(prompt.lane)) {
    throw new Error(
      "prompt.lane must be 'logical-session-frozen' or 'turn-scoped'",
    );
  }

  if (!content) return null;
  return {
    content,
    owner: prompt.owner,
    lane: prompt.lane,
    legacy: false,
  };
}

function backendDisplayName(kind) {
  if (isKnownBackendKind(kind)) {
    return BACKEND_DISPLAY_NAMES[kind];
  }
  return BACKEND_DISPLAY_NAMES[DEFAULT_BACKEND_KIND];
}

let activeBackendKind = DEFAULT_BACKEND_KIND;

function setActiveBackendKind(kind) {
  if (!isKnownBackendKind(kind)) {
    throw new Error(`Unknown backend kind: ${JSON.stringify(kind)}`);
  }
  activeBackendKind = kind;
}

function getActiveBackendKind() {
  return activeBackendKind;
}

function activeBackendDisplayName() {
  return BACKEND_DISPLAY_NAMES[activeBackendKind];
}

module.exports = { BACKEND_KINDS, PROMPT_OWNERS, PROMPT_LANES, BACKEND_DISPLAY_NAMES, DEFAULT_BACKEND_KIND, BRIDGE_REQUEST_METHODS, BRIDGE_EVENTS, BRIDGE_HOST_HOOKS, METHOD_NOT_FOUND_CODE, isKnownBackendKind, isKnownPromptOwner, isKnownPromptLane, normalizeBridgePrompt, backendDisplayName, setActiveBackendKind, getActiveBackendKind, activeBackendDisplayName };
