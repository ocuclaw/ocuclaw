const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { parseOptionalTrimmedString } = require("./downstream-parse-optional.cjs");
const { projectSessionDriverFields } = require("./session-driver-projection.cjs");

function formatSessions(sessions) {
  return JSON.stringify({ type: APP_PROTOCOL.sessionListResult, sessions });
}

function sessionInfoFingerprint(session) {
  const row = session && typeof session === "object" ? session : {};
  const raw = [
    row.key || "",
    Number.isFinite(Number(row.updatedAt)) ? String(Math.floor(Number(row.updatedAt))) : "0",
    row.preview || "",
    row.firstUserMessage || "",
    row.title || "",
    row.pinned === true ? "true" : "false",
    Number.isFinite(Number(row.pinnedAtMs)) ? String(Math.floor(Number(row.pinnedAtMs))) : "",
    row.agentId || "",
    row.agentName || "",
    row.status || "",
    row.activityDescription || "",

    row.unread === true ? "true" : row.unread === false ? "false" : "",
    row.hidden === true ? "true" : row.hidden === false ? "false" : "",
    ...(row.agentStatus ? [
      row.agentStatus.working === true ? "true" : "false",
      row.agentStatus.needsYou === true ? "true" : "false",
      row.agentStatus.failed === true ? "true" : "false",
      String(Math.floor(Number(row.agentStatus.observedAtMs) || 0)),
      row.agentStatus.unknown === true ? "true" : "false",
    ] : []),

    ...(typeof row.source === "string" && row.source.trim() ? [row.source.trim()] : []),
  ].join("\u001f");
  return fnv1a32Hex(raw);
}

function fnv1a32Hex(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeSessionDiffLimit(limit) {
  if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return 80;
  return Math.min(200, Math.max(1, Math.floor(Number(limit))));
}

function normalizeSessionDiffKind(kind) {
  const normalized = String(kind || "").trim().toLowerCase();
  if (!normalized) return "ocuclaw";
  if (normalized === "ocuclaw" || normalized === "evenai") {
    return normalized;
  }
  return null;
}

function buildSessionDiff({ kind, sessions, known, limit, dedicatedKey }) {
  const normalizedKind = normalizeSessionDiffKind(kind);
  if (!normalizedKind) throw new Error("invalid_session_diff_kind");
  const normalizedLimit = normalizeSessionDiffLimit(limit);
  const rows = Array.isArray(sessions) ? sessions : [];
  const limitedRows = rows
    .slice()
    .sort((left, right) => (Number(right && right.updatedAt) || 0) - (Number(left && left.updatedAt) || 0))
    .slice(0, normalizedLimit);
  const knownByKey = new Map();
  for (const row of Array.isArray(known) ? known : []) {
    const key = typeof row.key === "string" ? row.key.trim().toLowerCase() : "";
    if (!key) continue;
    knownByKey.set(key, row);
  }
  const liveKeys = new Set();
  const changed = [];
  for (const row of limitedRows) {
    const key = typeof row.key === "string" ? row.key.trim().toLowerCase() : "";
    if (!key) continue;
    liveKeys.add(key);
    const knownRow = knownByKey.get(key);
    const updatedAt = Number.isFinite(Number(row.updatedAt))
      ? Math.floor(Number(row.updatedAt))
      : 0;
    const fingerprint = sessionInfoFingerprint(row);
    if (
      !knownRow ||
      knownRow.updatedAt !== updatedAt ||
      knownRow.fingerprint !== fingerprint
    ) {
      changed.push(row);
    }
  }
  const deletedKeys = [];
  for (const row of Array.isArray(known) ? known : []) {
    const rawKey = typeof row.key === "string" ? row.key.trim() : "";
    const key = rawKey.toLowerCase();
    if (key && !liveKeys.has(key)) deletedKeys.push(rawKey);
  }
  const out = {
    type: APP_PROTOCOL.sessionListDiffResult,
    kind: normalizedKind,
    sessions: changed,
    deletedKeys,
    limit: normalizedLimit,
  };
  if (typeof dedicatedKey === "string" && dedicatedKey) {
    out.dedicatedKey = dedicatedKey;
  }
  return out;
}

function formatSessionDiff(payload) {
  return JSON.stringify(buildSessionDiff(payload || {}));
}

function formatEmptySessionDiff(kind, limit, dedicatedKey) {
  const normalizedKind = normalizeSessionDiffKind(kind);
  if (!normalizedKind) throw new Error("invalid_session_diff_kind");
  const out = {
    type: APP_PROTOCOL.sessionListDiffResult,
    kind: normalizedKind,
    sessions: [],
    deletedKeys: [],
    limit: normalizeSessionDiffLimit(limit),
  };
  if (typeof dedicatedKey === "string" && dedicatedKey) {
    out.dedicatedKey = dedicatedKey;
  }
  return JSON.stringify(out);
}

function formatSessionSwitched(
  sessionKey,
  requestId = "",
  draft = false,
  agentFallback = "",
  previousSessionGone = false,
) {
  const droppedAgentRef = parseOptionalTrimmedString(agentFallback);
  return JSON.stringify({
    type: APP_PROTOCOL.sessionSwitchApplied,
    sessionKey,
    ...(draft === true ? { draft: true } : {}),

    ...(droppedAgentRef ? { agentFallback: droppedAgentRef } : {}),

    ...(previousSessionGone === true ? { previousSessionGone: true } : {}),
    ...(parseOptionalTrimmedString(requestId)
      ? { requestId: parseOptionalTrimmedString(requestId) }
      : {}),
  });
}

function formatSessionSwitchRejected(payload = {}) {
  const reason = typeof payload.reason === "string" && payload.reason.trim()
    ? payload.reason.trim()
    : "unsupported_session_key";
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
  const currentSessionKey = typeof payload.currentSessionKey === "string" && payload.currentSessionKey.trim()
    ? payload.currentSessionKey.trim()
    : null;
  return JSON.stringify({
    type: APP_PROTOCOL.sessionSwitchRejected,
    sessionKey,
    status: "rejected",
    reason,
    currentSessionKey,
  });
}

function formatSessionModelConfig(payload) {
  return JSON.stringify({
    type: APP_PROTOCOL.sessionConfigSnapshot,
    effectiveThinkingLevel:
      payload && typeof payload.effectiveThinkingLevel === "string"
        ? payload.effectiveThinkingLevel
        : "",
    ...(typeof payload?.thinkingDefault === "string" ? { thinkingDefault: payload.thinkingDefault } : {}),
    ...(Array.isArray(payload?.thinkingLevels) ? { thinkingLevels: payload.thinkingLevels } : {}),
    sessionKey: (payload && payload.sessionKey) || "",
    modelProvider:
      payload && typeof payload.modelProvider === "string"
        ? payload.modelProvider
        : null,
    model:
      payload && typeof payload.model === "string" ? payload.model : null,
    thinkingLevel:
      payload && typeof payload.thinkingLevel === "string"
        ? payload.thinkingLevel
        : "",
    reasoningLevel:
      payload && typeof payload.reasoningLevel === "string"
        ? payload.reasoningLevel
        : "off",
    verboseLevel:
      payload && typeof payload.verboseLevel === "string"
        ? payload.verboseLevel
        : "off",
    fastMode: !!(payload && payload.fastMode === true),
    ...(typeof payload?.fastModeSupported === "boolean"
      ? { fastModeSupported: payload.fastModeSupported }
      : {}),
    elevatedLevel:
      payload && typeof payload.elevatedLevel === "string"
        ? payload.elevatedLevel
        : "off",
    agentId:
      payload && typeof payload.agentId === "string" ? payload.agentId : "",

    ...(typeof payload?.effectiveAgentId === "string" && payload.effectiveAgentId
      ? { effectiveAgentId: payload.effectiveAgentId }
      : {}),
  });
}

function formatSessionModelConfigAck(payload) {
  const out = {
    type: APP_PROTOCOL.sessionConfigSetAck,
    status:
      payload && typeof payload.status === "string"
        ? payload.status
        : "rejected",
    ...(payload && payload.error !== undefined ? { error: payload.error } : {}),
    ...(payload &&
    typeof payload.requestId === "string" &&
    payload.requestId.trim()
      ? { requestId: payload.requestId.trim() }
      : {}),
  };
  return JSON.stringify(out);
}

function formatCompactSessionAck(payload) {
  const msg = {
    type: APP_PROTOCOL.sessionCompactAck,
    status:
      payload && payload.status === "accepted" ? "accepted" : "rejected",
  };
  if (payload && payload.requestId) {
    msg.requestId = String(payload.requestId);
  }
  if (msg.status === "rejected") {
    msg.error =
      payload && payload.error
        ? String(payload.error)
        : "compact failed";
  }
  return JSON.stringify(msg);
}

function formatSessionAgentAck(payload) {
  const out = {
    type: APP_PROTOCOL.sessionAgentSetAck,
    status:
      payload && typeof payload.status === "string"
        ? payload.status
        : "rejected",
  };
  if (payload && payload.error !== undefined) {
    out.error = payload.error;
  }
  return JSON.stringify(out);
}

function formatSessionDriverState(snapshot     ) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  return JSON.stringify({
    type: APP_PROTOCOL.sessionDriver,
    ...projectSessionDriverFields(s),
    holdPid: Number.isFinite(s.holdPid) ? s.holdPid : null,
    updatedAtMs: Number.isFinite(s.updatedAtMs) ? s.updatedAtMs : Date.now(),
  });
}

function createEvenAiSessionsFormatter({ defaultEvenAiDedicatedSessionKey }     ) {

  function formatEvenAiSessions(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.evenAiSessionListResult,
      sessions: Array.isArray(payload && payload.sessions) ? payload.sessions : [],
      dedicatedKey:
        payload && typeof payload.dedicatedKey === "string"
          ? payload.dedicatedKey
          : defaultEvenAiDedicatedSessionKey,
    });
  }

  return { formatEvenAiSessions };
}

module.exports = { formatSessions, formatSessionDiff, formatEmptySessionDiff, formatSessionSwitched, formatSessionSwitchRejected, formatSessionModelConfig, formatSessionModelConfigAck, formatCompactSessionAck, formatSessionAgentAck, formatSessionDriverState, createEvenAiSessionsFormatter, sessionInfoFingerprint, normalizeSessionDiffLimit, normalizeSessionDiffKind };
