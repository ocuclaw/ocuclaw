const ET_PREFIX = "et:";
const PROVIDERS = new Set(["claude", "codex"]);

function mintEtSessionKey(provider, sessionId) {
  return `${ET_PREFIX}${provider}:${sessionId}`;
}

function isEtSessionKey(key) {
  return typeof key === "string" && key.startsWith(ET_PREFIX);
}

function parseEtSessionKey(key) {
  if (!isEtSessionKey(key)) return null;
  const rest = key.slice(ET_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const provider = rest.slice(0, sep);
  const sessionId = rest.slice(sep + 1);
  if (!PROVIDERS.has(provider) || !sessionId) return null;
  return { provider, sessionId };
}

function etProviderDisplayName(provider) {
  return provider === "codex" ? "Codex" : "Claude";
}

module.exports = { mintEtSessionKey, isEtSessionKey, parseEtSessionKey, etProviderDisplayName };
