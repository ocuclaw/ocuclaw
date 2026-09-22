function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveInputPredictionIdentity(lookups) {
  const l = lookups && typeof lookups === "object" ? lookups : {};
  const sessionKey = clean(l.clientSessionKey);
  const out = { sessionKey, agentId: "", profileId: "" };
  if (!sessionKey) return out;
  const hermes = clean(l.backendKind).toLowerCase() === "hermes";
  let resolved = "";
  try {
    const shortKey = typeof l.extractShortKey === "function" ? clean(l.extractShortKey(sessionKey)) || sessionKey : sessionKey;

    if (hermes && typeof l.getSessionProfileId === "function") {
      resolved = clean(l.getSessionProfileId(shortKey, sessionKey));
    }
    if (!resolved && typeof l.getSessionAgentId === "function") {
      resolved = clean(l.getSessionAgentId(shortKey, sessionKey));
    }
  } catch {
    resolved = "";
  }
  if (hermes) {

    if (!resolved) return { ...out, unroutable: true };
    out.profileId = resolved;
    return out;
  }
  if (resolved) out.agentId = resolved;
  return out;
}

module.exports = { resolveInputPredictionIdentity };
