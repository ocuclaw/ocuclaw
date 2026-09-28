const { isHermesSessionKey } = require("./hermes-session-keys.cjs");

const OPENCLAW_GATEWAY_DEFAULT_AGENT_ID = "main";
const AGENT_SCOPED_SESSION_KEY_RE = /^agent:([^:]+):(.+)$/i;

function gatewaySessionKeyFor(sessionKey, agentId) {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!key) return key;

  if (isHermesSessionKey(key)) return key;
  if (AGENT_SCOPED_SESSION_KEY_RE.test(key)) return key;

  const selectedAgent = typeof agentId === "string" ? agentId.trim() : "";
  if (
    !selectedAgent ||
    selectedAgent.toLowerCase() === OPENCLAW_GATEWAY_DEFAULT_AGENT_ID
  ) {
    return key;
  }
  return `agent:${selectedAgent}:${key}`;
}

function isAgentSelectionRequiredError(err) {
  if (!err) return false;
  if (err.code === "AGENT_SELECTION_REQUIRED") return true;
  const message = typeof err.message === "string" ? err.message : String(err);
  return /Multiple agents are configured, but .* has no explicit owner/i.test(message);
}

function isSessionScopedMethod(method) {
  return (
    typeof method === "string" &&
    (method === "agent" ||
      method === "agent.identity.get" ||
      method.startsWith("chat.") ||
      method.startsWith("sessions."))
  );
}

function scopeOpenClawRequestSessionParams(
  method,
  params,
  opts = {},
) {
  if (!params || typeof params !== "object") return params;

  if (method === "commands.list" || (method === "agent.identity.get" && !params.sessionKey)) {
    const defaultAgentId =
      typeof opts.defaultAgentId === "string" ? opts.defaultAgentId.trim() : "";
    if (params.sessionKey || params.agentId || !defaultAgentId) return params;
    return { ...params, agentId: defaultAgentId };
  }
  if (!isSessionScopedMethod(method)) return params;
  let next = params;
  for (const field of ["key", "sessionKey"]) {
    const raw = params[field];
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || isHermesSessionKey(key) || AGENT_SCOPED_SESSION_KEY_RE.test(key)) {
      continue;
    }
    let agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId && typeof opts.resolveAgentId === "function") {
      try {
        const resolved = opts.resolveAgentId(key);
        agentId = typeof resolved === "string" ? resolved.trim() : "";
      } catch {
        agentId = "";
      }
    }
    if (!agentId && typeof opts.defaultAgentId === "string") {
      agentId = opts.defaultAgentId.trim();
    }
    if (!agentId) continue;
    if (next === params) next = { ...params };
    next[field] = `agent:${agentId}:${key}`;
  }
  return next;
}

function relaySessionKeyFor(sessionKey) {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!key) return key;
  const match = AGENT_SCOPED_SESSION_KEY_RE.exec(key);
  return match ? match[2] : key;
}

module.exports = { gatewaySessionKeyFor, isAgentSelectionRequiredError, scopeOpenClawRequestSessionParams, relaySessionKeyFor };
