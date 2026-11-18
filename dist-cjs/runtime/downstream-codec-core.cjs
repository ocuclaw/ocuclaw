const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { formatSendAck, formatMainOperationReceived } = require("./relay-worker-protocol.cjs");
const { parseOptionalTrimmedString } = require("./downstream-parse-optional.cjs");

const PROTOCOL_SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "devicetoken",
  "nonce",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "setcookie",
  "signature",
  "token",
]);

function isProtocolSecretKey(key     ) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    PROTOCOL_SECRET_KEYS.has(normalized) ||
    /(?:apikey|authorization|cookie|credential|nonce|password|privatekey|secret|signature|token)$/.test(normalized)
  );
}

function sanitizeProtocolFrame(value     , seen = new WeakSet(), depth = 0)      {
  if (value === null || typeof value !== "object") return value;
  if (value.type === "ocuclaw.optional.setup.request") return { type: value.type, private: true };
  if (value.type === "ocuclaw.model_sites.request" || value.type === "ocuclaw.model_sites.result") return { type: value.type, private: true };

  if (value.type === "ocuclaw.secret.answer") return { type: value.type, private: true };
  if (value.type === "remote-control" && value.action === "webui-secret-entry") {
    return { type: value.type, action: value.action, private: true };
  }

  if (
    value.type === "req" && value.method === "question.resolve" &&
    value.params && typeof value.params === "object" && value.params.answers !== undefined
  ) {
    const { answers: _answers, ...params } = value.params;
    const clean = sanitizeProtocolFrame({ ...value, params }, seen, depth);
    clean.params.answers = "[REDACTED]";
    return clean;
  }
  if (value.type === "ocuclaw.botscreen.control" || value.type === "ocuclaw.botscreen.control.result" || value.type === "ocuclaw.botscreen.frame" ||
      value.type === "ocuclaw.botscreen.aim" || value.type === "ocuclaw.botscreen.aim.result") {

    return { type: value.type, private: true };
  }
  if (depth >= 16 || seen.has(value)) return "[REDACTED]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeProtocolFrame(entry, seen, depth + 1));
  }
  const clean      = {};
  for (const [key, entry] of Object.entries(value)) {
    clean[key] = isProtocolSecretKey(key)
      ? "[REDACTED]"
      : sanitizeProtocolFrame(entry, seen, depth + 1);
  }
  return clean;
}

function formatEntries(snapshot      = {}, sessionId = "") {
  const value = snapshot && typeof snapshot === "object" ? snapshot : {};
  const rawBaseSeq = value.baseSeq;
  const rawLastSeq = value.lastSeq;
  return JSON.stringify({
    type: APP_PROTOCOL.entries,
    sessionId: typeof sessionId === "string" ? sessionId : null,
    entriesRevision: Number.isFinite(Number(value.entriesRevision))
      ? Math.max(0, Math.floor(Number(value.entriesRevision)))
      : 0,
    baseSeq: rawBaseSeq !== null && rawBaseSeq !== undefined &&
      Number.isFinite(Number(rawBaseSeq))
      ? Math.max(0, Math.floor(Number(rawBaseSeq)))
      : 0,
    lastSeq: rawLastSeq !== null && rawLastSeq !== undefined &&
      Number.isFinite(Number(rawLastSeq))
      ? Math.floor(Number(rawLastSeq))
      : -1,
    complete: value.complete !== false,
    entries: Array.isArray(value.entries) ? value.entries : [],
  });
}

function formatActivity(activity) {
  return JSON.stringify({ ...activity, type: APP_PROTOCOL.activity });
}

function formatThinkingUpdate(update) {
  return JSON.stringify({ ...update, type: APP_PROTOCOL.thinkingUpdate });
}

function formatRunSignal(frame                         ) {
  return JSON.stringify({ ...frame, type: APP_PROTOCOL.runSignal });
}

function formatCardBuild(frame                         ) {
  return JSON.stringify({ ...frame, type: APP_PROTOCOL.cardBuild });
}

function formatThinkingFinalize(update) {
  return JSON.stringify({ ...update, type: APP_PROTOCOL.thinkingFinalize });
}

function formatTyping(update) {
  return JSON.stringify({ ...update, type: APP_PROTOCOL.typingUpdate });
}

function formatError(error, meta) {
  const msg = {
    type: "error",
    error: error || "Unknown error",
  };
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    if (typeof meta.code === "string" && meta.code.trim()) {
      msg.code = meta.code.trim();
    }
    if (typeof meta.requestId === "string" && meta.requestId.trim()) {
      msg.requestId = meta.requestId.trim();
    }
    if (typeof meta.op === "string" && meta.op.trim()) {
      msg.op = meta.op.trim();
    }
  }
  return JSON.stringify(msg);
}

function formatSendAckCompat(id, status, error, errorCode, data      = undefined) {
  return formatSendAck(id, status, error, errorCode, data);
}

function formatSessionAbortAck(data      = {}) {
  const msg      = {
    type: APP_PROTOCOL.sessionAbortAck,
    requestId: parseOptionalTrimmedString(data.requestId),
    status: data.status || "accepted",
  };
  if (data.sessionKey !== undefined) msg.sessionKey = data.sessionKey;
  if (typeof data.aborted === "boolean") msg.aborted = data.aborted;
  if (data.abortedRunId !== undefined) msg.abortedRunId = data.abortedRunId;
  if (data.error !== undefined) msg.error = data.error;
  if (data.errorCode !== undefined) msg.errorCode = data.errorCode;
  return JSON.stringify(msg);
}

function formatOperationReceived(data) {
  return formatMainOperationReceived(data);
}

function formatProtocol(direction, frame) {
  return JSON.stringify({
    type: APP_PROTOCOL.protocolFrame,
    direction,
    frame: sanitizeProtocolFrame(frame),
  });
}

function formatStreaming(text, emojiSpans, paceSpans, meta = {}) {
  const payload      = {
    type: APP_PROTOCOL.messageStreamDelta,
    text,
  };
  if (typeof meta.runId === "string" && meta.runId) payload.runId = meta.runId;
  if (
    meta.seq !== null &&
    meta.seq !== undefined &&
    Number.isFinite(Number(meta.seq))
  ) {
    payload.seq = Math.max(0, Math.floor(Number(meta.seq)));
  }
  if (
    meta.messageIndex !== null &&
    meta.messageIndex !== undefined &&
    Number.isFinite(Number(meta.messageIndex))
  ) {
    payload.messageIndex = Math.max(0, Math.floor(Number(meta.messageIndex)));
  }
  if (Array.isArray(emojiSpans) && emojiSpans.length > 0) {
    payload.emojiSpans = emojiSpans;
  }
  if (Array.isArray(paceSpans) && paceSpans.length > 0) {
    payload.paceSpans = paceSpans;
  }
  return JSON.stringify(payload);
}

function formatStreamClear(options) {
  const opts = options && typeof options === "object" ? options : {};
  const runId =
    typeof opts.runId === "string" && opts.runId.trim() ? opts.runId.trim() : null;
  const sessionKey =
    typeof opts.sessionKey === "string" && opts.sessionKey.trim()
      ? opts.sessionKey.trim()
      : null;
  const reason =
    typeof opts.reason === "string" && opts.reason.trim()
      ? opts.reason.trim()
      : "stream_withdrawn";
  return JSON.stringify({
    type: APP_PROTOCOL.messageStreamClear,
    runId,
    sessionKey,
    reason,
  });
}

function formatCapabilitySnapshot(payload) {
  return JSON.stringify({
    type: APP_PROTOCOL.capabilitySnapshot,
    source:
      payload && typeof payload.source === "string" && payload.source.trim()
        ? payload.source.trim()
        : "openclaw",
    displayName:
      payload && typeof payload.displayName === "string" && payload.displayName.trim()
        ? payload.displayName.trim()
        : null,
    generatedAtMs:
      Number.isFinite(payload && payload.generatedAtMs)
        ? Math.floor(payload.generatedAtMs)
        : Date.now(),
    stale: !!(payload && payload.stale),
    families:
      payload && payload.families && typeof payload.families === "object"
        ? payload.families
        : {},
    agentCatalog:
      payload && Array.isArray(payload.agentCatalog)
        ? payload.agentCatalog
        : [],
  });
}

function formatPushMessage(payload) {
  return JSON.stringify({
    type: APP_PROTOCOL.pushMessage,
    preview:
      payload && typeof payload.preview === "string" ? payload.preview : "",
    sessionRef:
      payload && typeof payload.sessionRef === "string" ? payload.sessionRef : null,
    sessionKey:
      payload && typeof payload.sessionKey === "string" ? payload.sessionKey : null,
    pushOrigin:
      payload && typeof payload.pushOrigin === "string" ? payload.pushOrigin : "agent",
    urgency:
      payload && typeof payload.urgency === "string" ? payload.urgency : "normal",
    generatedAtMs:
      Number.isFinite(payload && payload.generatedAtMs)
        ? Math.floor(payload.generatedAtMs)
        : Date.now(),
  });
}

function createSnapshotFormatters({ getSnapshotRevision }     ) {

  function formatPages(pages, meta) {
    const fallbackRevision = getSnapshotRevision
      ? getSnapshotRevision("pages")
      : null;
    const revision = Number.isFinite(meta && meta.revision)
      ? Math.floor(meta.revision)
      : Number.isFinite(fallbackRevision)
        ? Math.floor(fallbackRevision)
        : null;
    const assistantCommit = meta && meta.assistantCommit;
    const normalizedAssistantCommit =
      assistantCommit &&
      Number.isFinite(assistantCommit.generation) &&
      typeof assistantCommit.text === "string" &&
      typeof assistantCommit.sessionKey === "string" &&
      assistantCommit.sessionKey
        ? {
            generation: Math.floor(assistantCommit.generation),
            text: assistantCommit.text,
            sessionKey: assistantCommit.sessionKey,
          }
        : null;
    const msg = {
      type: APP_PROTOCOL.pages,
      pages,
      ...(meta && typeof meta.ledgerV1 === "boolean" ? { ledgerV1: meta.ledgerV1 } : {}),
      ...(revision !== null ? { revision } : {}),
      ...(typeof meta?.sourceRunId === "string" && meta.sourceRunId.trim()
        ? { sourceRunId: meta.sourceRunId.trim() } : {}),
      ...(normalizedAssistantCommit ? { assistantCommit: normalizedAssistantCommit } : {}),
    };
    return JSON.stringify(msg);
  }

  function formatStatus(status, meta) {
    const msg = { ...status, type: APP_PROTOCOL.status };
    const fallbackRevision = getSnapshotRevision
      ? getSnapshotRevision("status")
      : null;
    const revision = Number.isFinite(meta && meta.revision)
      ? Math.floor(meta.revision)
      : Number.isFinite(fallbackRevision)
        ? Math.floor(fallbackRevision)
        : null;
    if (revision !== null) {
      msg.revision = revision;
    }
    return JSON.stringify(msg);
  }

  return { formatPages, formatStatus };
}

module.exports = { sanitizeProtocolFrame, formatEntries, formatActivity, formatThinkingUpdate, formatThinkingFinalize, formatRunSignal, formatCardBuild, formatTyping, formatError, formatSendAckCompat, formatSessionAbortAck, formatOperationReceived, formatProtocol, formatStreaming, formatStreamClear, formatCapabilitySnapshot, formatPushMessage, createSnapshotFormatters };
