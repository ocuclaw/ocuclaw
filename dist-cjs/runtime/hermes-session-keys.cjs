const HERMES_SESSION_KEY_PREFIX = "hermes:";

const DEFAULT_HERMES_NAMESPACE = "main";

const HERMES_FOREIGN_KEY_MARKER = "x";

const OCUCLAW_PLATFORM_SEGMENT = "ocuclaw";
const OCUCLAW_CHAT_TYPE_SEGMENT = "dm";

const AGENT_KEY_PREFIX = "agent:";

function isHermesSessionKey(key) {
  return (
    typeof key === "string" &&
    key.toLowerCase().startsWith(HERMES_SESSION_KEY_PREFIX)
  );
}

function isForeignHermesSessionKey(key) {
  if (typeof key !== "string") return false;
  const segments = key.trim().toLowerCase().split(":");
  return (
    segments.length >= 4 &&
    segments[0] === "hermes" &&
    segments[2] === HERMES_FOREIGN_KEY_MARKER
  );
}

function mintedHermesSessionKey(chatId, namespace) {
  const ns = normalizeSegment(namespace) || DEFAULT_HERMES_NAMESPACE;
  const chat = typeof chatId === "string" ? chatId.trim() : "";
  if (!chat || chat.includes(":") || chat === HERMES_FOREIGN_KEY_MARKER) {
    throw new Error(
      `minted hermes chatId must be a single non-marker segment; got ${JSON.stringify(chatId)}`,
    );
  }
  return `${HERMES_SESSION_KEY_PREFIX}${ns}:${chat}`;
}

function hermesDefaultSessionKeyPrefix(namespace) {
  const ns = normalizeSegment(namespace) || DEFAULT_HERMES_NAMESPACE;
  return `${HERMES_SESSION_KEY_PREFIX}${ns}:`;
}

function hermesSupportedSessionKeyPrefixes() {
  return [HERMES_SESSION_KEY_PREFIX];
}

function stripAgentNamespace(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  if (!sessionKey.startsWith(AGENT_KEY_PREFIX)) return null;
  const rest = sessionKey.slice(AGENT_KEY_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { namespace: rest.slice(0, sep), remainder: rest.slice(sep + 1) };
}

function deriveHermesPublicKey(row) {
  if (!row || typeof row !== "object") return null;
  const stripped = stripAgentNamespace(row.sessionKey);
  if (stripped) {
    const segments = stripped.remainder.split(":");
    if (
      segments.length === 3 &&
      segments[0] === OCUCLAW_PLATFORM_SEGMENT &&
      segments[1] === OCUCLAW_CHAT_TYPE_SEGMENT &&
      segments[2] &&
      segments[2] !== HERMES_FOREIGN_KEY_MARKER
    ) {
      return {
        key: `${HERMES_SESSION_KEY_PREFIX}${stripped.namespace}:${segments[2]}`,
        kind: "minted",
      };
    }

    return {
      key: `${HERMES_SESSION_KEY_PREFIX}${stripped.namespace}:${HERMES_FOREIGN_KEY_MARKER}:${stripped.remainder}`,
      kind: "foreign",
    };
  }

  const source = normalizeSegment(row.source);
  const rootId = normalizeSegment(row.lineageRootId) || normalizeSegment(row.id);
  if (!source || !rootId || source.includes(":")) return null;
  return {
    key: `${HERMES_SESSION_KEY_PREFIX}${DEFAULT_HERMES_NAMESPACE}:${HERMES_FOREIGN_KEY_MARKER}:${source}:${rootId}`,
    kind: "externalRoot",
  };
}

function parseHermesPublicKey(key) {
  if (typeof key !== "string") return null;
  if (!key.toLowerCase().startsWith(HERMES_SESSION_KEY_PREFIX)) return null;
  const rest = key.slice(HERMES_SESSION_KEY_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  const namespace = rest.slice(0, sep);
  const tail = rest.slice(sep + 1);
  if (tail.startsWith(`${HERMES_FOREIGN_KEY_MARKER}:`)) {
    const remainder = tail.slice(HERMES_FOREIGN_KEY_MARKER.length + 1);
    if (!remainder) return null;
    return { namespace, kind: "foreign", remainder };
  }
  if (!tail || tail.includes(":") || tail === HERMES_FOREIGN_KEY_MARKER) {

    return null;
  }
  return { namespace, kind: "minted", chatId: tail };
}

function normalizeSegment(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { HERMES_SESSION_KEY_PREFIX, DEFAULT_HERMES_NAMESPACE, HERMES_FOREIGN_KEY_MARKER, OCUCLAW_PLATFORM_SEGMENT, OCUCLAW_CHAT_TYPE_SEGMENT, isHermesSessionKey, isForeignHermesSessionKey, mintedHermesSessionKey, hermesDefaultSessionKeyPrefix, hermesSupportedSessionKeyPrefixes, stripAgentNamespace, deriveHermesPublicKey, parseHermesPublicKey };
