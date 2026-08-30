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

function relaySessionKeyFor(sessionKey) {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!key) return key;
  const match = AGENT_SCOPED_SESSION_KEY_RE.exec(key);
  return match ? match[2] : key;
}

module.exports = { gatewaySessionKeyFor, relaySessionKeyFor };
