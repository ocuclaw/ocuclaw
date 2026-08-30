const BACKEND_KINDS = Object.freeze(["openclaw", "hermes"]);

const DEFAULT_BACKEND_KIND = "openclaw";

const BACKEND_DISPLAY_NAMES = Object.freeze({
  openclaw: "OpenClaw",
  hermes: "Hermes",
});

const BRIDGE_REQUEST_METHODS = Object.freeze([
  "agent",
  "agent.identity.get",
  "agents.files.get",
  "agents.list",
  "chat.history",
  "chat.send",
  "commands.list",
  "config.get",
  "exec.approval.resolve",
  "models.authStatus",
  "models.list",
  "plugin.approval.resolve",
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

module.exports = { BACKEND_KINDS, BACKEND_DISPLAY_NAMES, DEFAULT_BACKEND_KIND, BRIDGE_REQUEST_METHODS, BRIDGE_EVENTS, BRIDGE_HOST_HOOKS, METHOD_NOT_FOUND_CODE, isKnownBackendKind, backendDisplayName, setActiveBackendKind, getActiveBackendKind, activeBackendDisplayName };
