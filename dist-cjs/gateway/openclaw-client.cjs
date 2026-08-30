const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { createGatewayTimingLedger } = require("./gateway-timing-ledger.cjs");
const { sanitizeConnectReason } = require("./sanitize-connect-reason.cjs");

const DEVICE_KEY_FILE = "ocuclaw-device-key.json";
const DEVICE_TOKEN_FILE = "ocuclaw-device-token.json";

const CLIENT_ID = "gateway-client";
const CLIENT_VERSION = "0.1.0";
const CLIENT_MODE = "backend";
const ROLE = "operator";
const SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.admin",
];
const MIN_PROTOCOL_VERSION = 3;
const MAX_PROTOCOL_VERSION = 4;
const HISTORY_ACTIVITY_POLL_INTERVAL_MS = 500;
const HISTORY_ACTIVITY_POLL_LIMIT = 40;
const THINKING_FRAME_MAX_CHARS = 8000;
const THINKING_FRAME_TRUNCATION_PREFIX = "[truncated]...";

const RPC_ACK_TIMEOUT_MS = 15000;

const ESTABLISH_TIMEOUT_MS = 10000;

const TICK_WATCH_MAX_INTERVAL_MS = 60000;
const TICK_STALE_MULTIPLIER = 1.5;

const THINKING_SUMMARY_KEYS = [
  "summary",
  "thinkingSummary",
  "reasoningSummary",
  "intentLabel",
];
const THINKING_DETAIL_KEYS = [
  "thinking",
  "reasoning",
  "thinkingText",
  "analysis",
];

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function normalizeLogger(logger) {
  if (!logger || typeof logger !== "object") {
    return {
      info: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    };
  }
  return {
    info:
      typeof logger.info === "function"
        ? logger.info.bind(logger)
        : typeof logger.log === "function"
          ? logger.log.bind(logger)
          : console.log.bind(console),
    warn:
      typeof logger.warn === "function"
        ? logger.warn.bind(logger)
        : console.warn.bind(console),
    error:
      typeof logger.error === "function"
        ? logger.error.bind(logger)
        : console.error.bind(console),
    debug:
      typeof logger.debug === "function"
        ? logger.debug.bind(logger)
        : typeof logger.info === "function"
          ? logger.info.bind(logger)
          : console.debug.bind(console),
  };
}

function pickTrimmedString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeStateDir(stateDir) {
  if (typeof stateDir !== "string") return null;
  const trimmed = stateDir.trim();
  return trimmed ? trimmed : null;
}

function resolvePersistencePaths(stateDir) {
  const resolvedStateDir = normalizeStateDir(stateDir);
  if (!resolvedStateDir) return null;
  return {
    stateDir: resolvedStateDir,
    deviceKeyPath: path.join(resolvedStateDir, DEVICE_KEY_FILE),
    deviceTokenPath: path.join(resolvedStateDir, DEVICE_TOKEN_FILE),
  };
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {

  }
}

function base64UrlEncode(buf) {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

function loadOrCreateDeviceIdentity(persistencePaths, logger) {
  const deviceKeyPath = persistencePaths && persistencePaths.deviceKeyPath;

  try {
    if (deviceKeyPath && fs.existsSync(deviceKeyPath)) {
      const raw = fs.readFileSync(deviceKeyPath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        parsed.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {

        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedId && derivedId !== parsed.deviceId) {

          const updated = { ...parsed, deviceId: derivedId };
          writeJsonFile(deviceKeyPath, updated);
          logger.info(
            `[openclaw] Loaded device identity (fixed ID): ${derivedId.slice(0, 12)}...`
          );
          return {
            deviceId: derivedId,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
        logger.info(
          `[openclaw] Loaded device identity: ${parsed.deviceId.slice(0, 12)}...`
        );
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {

  }

  const identity = generateIdentity();
  if (!deviceKeyPath) {
    logger.info(
      `[openclaw] Generated in-memory device identity: ${identity.deviceId.slice(0, 12)}...`
    );
    return identity;
  }
  const stored = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  writeJsonFile(deviceKeyPath, stored);
  logger.info(
    `[openclaw] Generated new device identity: ${identity.deviceId.slice(0, 12)}...`
  );
  return identity;
}

function loadDeviceToken(deviceId, persistencePaths) {
  const deviceTokenPath = persistencePaths && persistencePaths.deviceTokenPath;
  try {
    if (!deviceTokenPath || !fs.existsSync(deviceTokenPath)) return null;
    const raw = fs.readFileSync(deviceTokenPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.version === 1 &&
      parsed.deviceId === deviceId &&
      typeof parsed.token === "string"
    ) {
      return parsed.token;
    }
    return null;
  } catch {
    return null;
  }
}

function storeDeviceToken(deviceId, token, role, scopes, persistencePaths) {
  const deviceTokenPath = persistencePaths && persistencePaths.deviceTokenPath;
  if (!deviceTokenPath) return;
  const data = {
    version: 1,
    deviceId,
    token,
    role,
    scopes: scopes || [],
    updatedAtMs: Date.now(),
  };
  writeJsonFile(deviceTokenPath, data);
}

function clearDeviceToken(persistencePaths) {
  const deviceTokenPath = persistencePaths && persistencePaths.deviceTokenPath;
  try {
    if (deviceTokenPath && fs.existsSync(deviceTokenPath)) {
      fs.unlinkSync(deviceTokenPath);
    }
  } catch {

  }
}

function buildDeviceAuthPayload(params) {
  const version = params.nonce ? "v2" : "v1";
  const scopes = params.scopes.join(",");
  const token = params.token || "";
  const parts = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
  ];
  if (version === "v2") {
    parts.push(params.nonce || "");
  }
  return parts.join("|");
}

function signPayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function publicKeyRawBase64Url(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isNullishToken(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "(null)" ||
    normalized === "(undefined)" ||
    normalized === "none"
  );
}

function pickStringPathFromArgs(args) {
  if (!isObject(args)) return null;
  const keys = [
    "path",
    "filePath",
    "file_path",
    "filepath",
    "file",
    "target",
    "outputPath",
    "output_path",
    "output",
    "destination",
    "dest",
  ];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      if (!isNullishToken(trimmed)) {
        return trimmed;
      }
    }
  }
  return null;
}

function pickFirstString(obj, keys) {
  const entry = pickFirstStringEntry(obj, keys);
  return entry ? entry.value : null;
}

function pickFirstStringEntry(obj, keys) {
  if (!isObject(obj)) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

function normalizeThinkingText(raw) {
  if (typeof raw !== "string") return null;

  const cleaned = raw
    .replace(/\*\*/g, "")
    .trim();
  return cleaned || null;
}

function extractFirstBoldThinkingSegment(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.match(/\*\*([\s\S]+?)\*\*/);
  if (!match) return null;
  return normalizeThinkingText(match[1]);
}

function normalizeThinkingSummarySource(rawSource) {
  if (typeof rawSource !== "string") return null;
  const normalized = rawSource.trim().toLowerCase();
  if (
    normalized === "summary" ||
    normalized === "bold" ||
    normalized === "detail" ||
    normalized === "generic"
  ) {
    return normalized;
  }
  return null;
}

const FAILURE_LABEL_MAX_CHARS = 120;
const FAILURE_DETAIL_MAX_CHARS = 240;
const FAILOVER_REASON_ACTIVITY_CODE_MAP = Object.freeze({
  rate_limit: "provider_rate_limited",
  billing: "provider_quota_exhausted",
  auth: "provider_auth_invalid",
  auth_permanent: "provider_auth_invalid",
  overloaded: "provider_unavailable",
  timeout: "provider_timeout",
  format: "provider_request_invalid",
});

function shortText(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(Math.max(maxChars, 0));
  return `${text.slice(0, maxChars - 3)}...`;
}

function sanitizeFailureText(rawText, maxChars) {
  if (rawText === undefined || rawText === null) return null;
  let text = String(rawText);

  text = text.replace(
    new RegExp(`([?&](?:token|access_token|api_key|key|password|secret)=)[^&#\\s]+`, "gi"),
    "$1[redacted]",
  );
  text = text.replace(
    /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^,\s"'`]+)/gi,
    "$1[redacted]",
  );
  text = text.replace(/(authorization\s*:\s*bearer\s+)[^\s"'`]+/gi, "$1[redacted]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/g, "Bearer [redacted]");
  text = text.replace(
    /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    "[redacted]",
  );
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return shortText(text, maxChars);
}

function normalizeFailureHint(rawHint) {
  if (typeof rawHint !== "string") return "";
  const trimmed = rawHint.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.replace(/[\s-]+/g, "_");
}

function mapFailureHintToActivityCode(rawHint) {
  const normalizedHint = normalizeFailureHint(rawHint);
  if (!normalizedHint) return null;
  if (Object.hasOwn(FAILOVER_REASON_ACTIVITY_CODE_MAP, normalizedHint)) {
    return FAILOVER_REASON_ACTIVITY_CODE_MAP[normalizedHint];
  }
  if (
    normalizedHint === "auth_scope" ||
    normalizedHint === "auth_refresh" ||
    normalizedHint === "auth_html_403"
  ) {
    return "provider_auth_invalid";
  }
  if (normalizedHint === "proxy") {
    return "provider_unavailable";
  }
  return null;
}

function inferFailureHintFromText(rawText) {
  if (typeof rawText !== "string") return null;
  const text = rawText.trim().toLowerCase();
  if (!text) return null;

  if (
    text.includes("rate_limit") ||
    text.includes("rate limit") ||
    text.includes("rate limited") ||
    text.includes("too many requests") ||
    text.includes("usage limit") ||
    text.includes("organization usage limit")
  ) {
    return "rate_limit";
  }

  if (
    text.includes("out of credits") ||
    text.includes("insufficient credits") ||
    text.includes("insufficient quota") ||
    text.includes("quota exhausted") ||
    text.includes("quota balance") ||
    text.includes("payment required") ||
    text.includes("billing hard limit") ||
    text.includes("credit balance")
  ) {
    return "billing";
  }

  if (
    text.includes("invalid api key") ||
    text.includes("api key invalid") ||
    text.includes("authentication failed") ||
    text.includes("missing scopes") ||
    text.includes("missing scope") ||
    text.includes("invalid_api_key") ||
    text.includes("permission_error") ||
    text.includes("oauth token refresh failed")
  ) {
    return "auth";
  }

  if (text.includes("timed out") || text.includes("timeout")) {
    return "timeout";
  }

  if (
    text.includes("invalid request") ||
    text.includes("bad request") ||
    text.includes("provider_request_invalid")
  ) {
    return "format";
  }

  if (
    text.includes("service unavailable") ||
    text.includes("provider unavailable") ||
    text.includes("temporarily unavailable") ||
    text.includes("overloaded")
  ) {
    return "overloaded";
  }

  return null;
}

function resolveTerminalErrorCode(source, fallbackCode) {
  const explicitCode = pickTrimmedString(source.code, source.errorCode);
  if (explicitCode) {
    return explicitCode;
  }

  const structuredHintCode = mapFailureHintToActivityCode(
    pickTrimmedString(source.errorKind, source.failoverReason, source.providerRuntimeFailureKind),
  );
  if (structuredHintCode) {
    return structuredHintCode;
  }

  const inferredHintCode = mapFailureHintToActivityCode(
    inferFailureHintFromText(
      pickTrimmedString(
        source.detail,
        source.message,
        source.error,
        source.label,
        source.reason,
      ),
    ),
  );
  return inferredHintCode || fallbackCode || "agent_error";
}

function buildTerminalErrorActivity(data, fallbackRunId, fallbackSessionKey, fallbackCode) {
  const source = isObject(data) ? data : {};
  const code = resolveTerminalErrorCode(source, fallbackCode);
  const labelSource = pickTrimmedString(
    source.label,
    source.title,
    source.summary,
    source.message,
    source.error,
    code,
    "Run failed",
  );
  const detailSource = pickTrimmedString(
    source.detail,
    source.message,
    source.error,
    source.reason,
    source.label,
    code,
  );
  const runId = normalizeRunId(
    pickTrimmedString(source.runId, fallbackRunId),
  );
  const sessionKey = normalizeSessionKey(
    pickTrimmedString(source.sessionKey, fallbackSessionKey),
  );
  const activity = {
    state: "idle",
    sessionKey,
    runId,
    origin: "lifecycle",
    phase: "error",
    isError: true,
    code,
  };
  const label = sanitizeFailureText(labelSource, FAILURE_LABEL_MAX_CHARS);
  const detail = sanitizeFailureText(detailSource, FAILURE_DETAIL_MAX_CHARS);
  if (label) activity.label = label;
  if (detail) activity.detail = detail;
  else if (label) activity.detail = label;

  if (pickTrimmedString(source.failoverReason)) {
    activity.failoverPending = true;
  }
  return activity;
}

function buildStructuredError(data, fallbackMessage, fallbackCode) {
  const source = isObject(data) ? data : {};
  const error = new Error(
    pickTrimmedString(source.message, source.error, fallbackMessage) || fallbackMessage,
  );
  const code = pickTrimmedString(source.code, source.errorCode, fallbackCode) || fallbackCode;
  const requestId = pickTrimmedString(source.requestId);
  const op = pickTrimmedString(source.op);
  if (code) error.code = code;
  if (requestId) error.requestId = requestId;
  if (op) error.op = op;
  return error;
}

function selectThinkingDisplayLabel({
  summaryText,
  boldLabelCandidate,
  detailText,
  preferredSource,
}) {
  const candidates = [
    { source: "summary", text: summaryText },
    { source: "bold", text: boldLabelCandidate },
    { source: "detail", text: detailText },
  ];
  if (preferredSource) {
    const preferred = candidates.find((candidate) => (
      candidate.source === preferredSource &&
      candidate.text
    ));
    if (preferred) return preferred;
  }
  return candidates.find((candidate) => candidate.text) || null;
}

function buildThinkingDebugRawPayload(raw) {
  if (!isObject(raw)) return null;
  const snapshot = {};
  const keys = [
    "type",
    ...THINKING_SUMMARY_KEYS,
    ...THINKING_DETAIL_KEYS,
    "thinkingSignature",
  ];
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      snapshot[key] = value.trim();
    } else if (key === "type" && value != null) {
      snapshot[key] = String(value);
    }
  }
  return snapshot;
}

function parseThinkingSignatureId(rawSignature) {
  if (!rawSignature) return null;
  if (typeof rawSignature === "string") {
    try {
      const parsed = JSON.parse(rawSignature);
      if (parsed && typeof parsed.id === "string" && parsed.id.trim()) {
        return parsed.id.trim();
      }
    } catch {
      return null;
    }
    return null;
  }
  if (
    isObject(rawSignature) &&
    typeof rawSignature.id === "string" &&
    rawSignature.id.trim()
  ) {
    return rawSignature.id.trim();
  }
  return null;
}

function extractThinkingPayload(raw) {
  if (!isObject(raw)) return null;
  if (raw.redacted === true || raw.type === "redacted_thinking") return null;
  const summaryEntry = pickFirstStringEntry(raw, THINKING_SUMMARY_KEYS);
  const detailEntry = pickFirstStringEntry(raw, THINKING_DETAIL_KEYS);
  const summaryText = normalizeThinkingText(summaryEntry ? summaryEntry.value : null);
  const detailText = normalizeThinkingText(detailEntry ? detailEntry.value : null);
  const boldLabelCandidate = extractFirstBoldThinkingSegment(detailEntry ? detailEntry.value : null);
  const explicitSource = normalizeThinkingSummarySource(
    pickFirstString(raw, ["thinkingSummarySource", "labelSource"])
  );
  const selectedLabel = selectThinkingDisplayLabel({
    summaryText,
    boldLabelCandidate,
    detailText,
    preferredSource: explicitSource,
  });
  if (!selectedLabel) return null;
  const label = selectedLabel.text;
  const thinkingSummarySource = selectedLabel.source;
  const labelEntry = thinkingSummarySource === "summary" ? summaryEntry : detailEntry;
  return {
    label,
    detail: detailText || label,
    signatureId: parseThinkingSignatureId(raw.thinkingSignature),
    summaryKey: summaryEntry ? summaryEntry.key : null,
    detailKey: detailEntry ? detailEntry.key : null,
    summaryText,
    detailText,
    labelSource: thinkingSummarySource,
    thinkingSummarySource,
    labelKey: labelEntry ? labelEntry.key : null,
    labelRaw: labelEntry ? labelEntry.value : null,
    boldLabelCandidate,
  };
}

function sliceFromLastClosedBoldSegment(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const pattern = /\*\*[\s\S]+?\*\*/g;
  let lastIndex = -1;
  let match = pattern.exec(raw);
  while (match) {
    lastIndex = match.index;
    match = pattern.exec(raw);
  }
  if (lastIndex < 0) return null;
  return raw.slice(lastIndex);
}

function extractHistoryTimestampMs(rawMessage) {
  if (!isObject(rawMessage)) return null;
  const ts = rawMessage.timestamp;
  if (Number.isFinite(ts)) return Math.floor(ts);
  if (typeof ts === "string" && ts.trim()) {
    const parsed = Number(ts);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
}

function normalizeRunId(rawRunId) {
  if (typeof rawRunId !== "string") return null;
  const trimmed = rawRunId.trim();
  return trimmed || null;
}

function normalizeSessionKey(rawSessionKey) {
  if (typeof rawSessionKey !== "string") return null;
  const trimmed = rawSessionKey.trim();
  return trimmed || null;
}

const CHAT_COMMAND_RUN_TTL_MS = 10 * 60 * 1000;
const CHAT_COMMAND_RUN_MAX = 32;

function extractChatMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text
    ) {
      parts.push(block.text);
    }
  }
  if (parts.length > 0) return parts.join("");
  return typeof message.text === "string" ? message.text : "";
}

function hashThinkingKey(seed) {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

function thinkingFrameDedupeKey(runId, extracted) {
  if (!extracted) return null;
  const normalizedRunId = normalizeRunId(runId) || "run";
  if (extracted.signatureId) {
    return `${normalizedRunId}:signature:${extracted.signatureId}`;
  }
  const detail = normalizeThinkingText(extracted.detail);
  if (!detail) return null;
  return `${normalizedRunId}:detail:${hashThinkingKey(detail)}`;
}

function clampThinkingFrameText(rawText) {
  const text = typeof rawText === "string" ? rawText : "";
  if (text.length <= THINKING_FRAME_MAX_CHARS) return text;
  const keep = Math.max(
    0,
    THINKING_FRAME_MAX_CHARS - THINKING_FRAME_TRUNCATION_PREFIX.length,
  );
  return `${THINKING_FRAME_TRUNCATION_PREFIX}${text.slice(-keep)}`;
}

function appendThinkingFrameText(previousText, nextText) {
  const previous = typeof previousText === "string" ? previousText.trim() : "";
  const next = typeof nextText === "string" ? nextText.trim() : "";
  let text = "";
  if (!next) text = previous;
  else if (!previous) text = next;
  else if (next.startsWith(previous)) text = next;
  else if (previous.includes(next)) text = previous;
  else text = `${previous}\n${next}`;
  return clampThinkingFrameText(text);
}

function joinThinkingSegments(baseText, nextText) {
  const base = typeof baseText === "string" ? baseText.trim() : "";
  const next = typeof nextText === "string" ? nextText.trim() : "";
  if (!base) return next;
  if (!next) return base;
  return `${base}\n${next}`;
}

class OpenClawClient extends EventEmitter {

  _thinkingStreamSegments;

  constructor(opts = {}) {
    super();
    this._logger = normalizeLogger(opts.logger);
    this._timingLedger = createGatewayTimingLedger({
      logger: this._logger,
      now: () => Date.now(),
      emitTiming: (event) => this.emit("timing", event),
    });
    this._gatewayUrl = pickTrimmedString(opts.gatewayUrl);
    this._gatewayToken = pickTrimmedString(opts.gatewayToken);
    this._persistencePaths = resolvePersistencePaths(opts.stateDir);
    this._ws = null;
    this._stopped = false;
    this._pending = new Map();
    this._identity = null;
    this._connectNonce = null;
    this._connectSent = false;
    this._connectTimer = null;

    this._establishTimer = null;

    this._socketGeneration = 0;
    this._handshakeGeneration = -1;
    this._tickIntervalMs = 30000;
    this._deviceToken = null;

    this._backoffMs = 1000;
    this._reconnectTimer = null;

    this._lastTick = null;
    this._tickWatchTimer = null;

    this._activeRunId = null;
    this._activeRunSessionKey = null;
    this._activeRunStartedAtMs = null;
    this._activeRunGeneration = 0;
    this._runTextBuffer = "";

    this._chatCommandRuns = new Map();

    this._agentIdentity = null;

    this._lastSeq = null;
    this._gapDuringRun = false;

    this._historyResolved = false;
    this._eventQueue = [];
    this._historyActivityPollTimer = null;
    this._historyActivityPollInFlightGeneration = null;
    this._seenThinkingSummaryIds = new Set();
    this._seenThinkingFrameIds = new Set();
    this._thinkingFrameBuffers = new Map();

    this._thinkingStreamSegments = new Map();

    this._liveThinkingRunIds = new Set();
  }

  setLogger(logger) {
    this._logger = normalizeLogger(logger);
    this._timingLedger.setLogger(this._logger);
  }

  start() {
    if (this._stopped) return;

    if (!this._identity) {
      this._identity = loadOrCreateDeviceIdentity(
        this._persistencePaths,
        this._logger,
      );

      this._deviceToken = loadDeviceToken(
        this._identity.deviceId,
        this._persistencePaths,
      );
      if (this._deviceToken) {
        this._logger.info("[openclaw] Loaded cached device token");
      }
    }

    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    this._clearEstablishTimer();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._timingLedger.clear("stop");
    this._invalidateActiveRun();
    this._stopTickWatch();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._flushPendingErrors(new Error("client stopped"));
    this.emit("status", "stopped");
  }

  request(method, params, opts) {

    const ws = this._ws;
    const gen = this._socketGeneration;
    if (!ws || ws !== this._ws || ws.readyState !== WebSocket.OPEN) {

      return Promise.reject(new Error("gateway not connected"));
    }

    if (
      method !== "connect" &&
      ws instanceof WebSocket &&
      this._handshakeGeneration !== gen
    ) {
      const err = new Error("gateway handshake in flight");
      err.code = "handshake_pending";
      err.retryable = true;
      return Promise.reject(err);
    }
    const id = crypto.randomUUID();
    const frame = { type: "req", id, method, params };
    const expectFinal = opts && opts.expectFinal === true;
    const diagnostic = opts && opts.diagnostic;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, expectFinal, method, diagnostic });
    });

    const timer = setTimeout(() => {
      const pendingEntry = this._pending.get(id);
      if (!pendingEntry) return;
      this._pending.delete(id);
      const err = new Error("rpc ack timeout");
      err.code = "rpc_timeout";
      err.retryable = true;
      pendingEntry.reject(err);
    }, RPC_ACK_TIMEOUT_MS);
    if (timer.unref) {
      timer.unref();
    }
    const pendingForTimer = this._pending.get(id);
    if (pendingForTimer) {
      pendingForTimer.timer = timer;
    }
    const raw = JSON.stringify(frame);
    this._timingLedger.recordRequestSent({
      requestId: id,
      method,
      params,
      expectFinal,
      diagnostic,
    });
    this.emit("protocol", { direction: "out", frame });
    ws.send(raw);

    if (method === "chat.send") {
      this._registerChatCommandRun(params);
      promise.catch(() => {
        this._forgetChatCommandRun(params);
      });
    }
    return promise;
  }

  sendMessage(text, sessionKey, attachment) {
    const key = sessionKey || "main";
    const idempotencyKey = crypto.randomUUID();
    const params = { message: text, sessionKey: key, idempotencyKey };
    if (
      attachment &&
      typeof attachment === "object" &&
      typeof attachment.base64Data === "string" &&
      attachment.base64Data
    ) {
      params.attachments = [
        {
          type: attachment.kind || "image",
          mimeType: attachment.mimeType || "image/jpeg",
          fileName: attachment.name || "image.jpg",
          content: attachment.base64Data,
        },
      ];
    }

    return this.request(
      "agent",
      params,
    ).then((result) => {
      const status = result && result.status;
      if (result && result.runId) {
        this._activeRunId = result.runId;
        this._logger.info(`[openclaw] Agent run accepted: ${result.runId}`);
      }
      return result;
    }).catch((err) => {
      this._logger.error(`[openclaw] Agent request failed: ${err.message}`);
      this.emit("error", err);
      throw err;
    });
  }

  async fetchAgentIdentity(sessionKey) {
    const params = sessionKey ? { sessionKey } : {};
    const result = await this.request("agent.identity.get", params);
    this._agentIdentity = result;
    this.emit("agentIdentity", result);
    this._logger.info(`[openclaw] Agent identity: ${result && result.name}`);
    return result;
  }

  resolveApproval(id, decision) {
    const method =
      typeof id === "string" && id.startsWith("plugin:")
        ? "plugin.approval.resolve"
        : "exec.approval.resolve";
    return this.request(method, { id, decision });
  }

  _beginActiveRun(runId, sessionKey) {
    this._activeRunGeneration += 1;
    this._activeRunId = normalizeRunId(runId);
    this._activeRunSessionKey = normalizeSessionKey(sessionKey);
    this._activeRunStartedAtMs = Date.now();
    this._runTextBuffer = "";
    this._gapDuringRun = false;
    this._seenThinkingSummaryIds.clear();
    this._seenThinkingFrameIds.clear();
    this._thinkingFrameBuffers.clear();
    this._thinkingStreamSegments.clear();
    this._liveThinkingRunIds.clear();
    return this._activeRunGeneration;
  }

  _invalidateActiveRun() {
    this._activeRunGeneration += 1;
    this._stopHistoryActivityPolling();
    this._activeRunId = null;
    this._activeRunSessionKey = null;
    this._activeRunStartedAtMs = null;
    this._runTextBuffer = "";
    this._gapDuringRun = false;
    this._seenThinkingSummaryIds.clear();
    this._seenThinkingFrameIds.clear();
    this._thinkingFrameBuffers.clear();
    this._thinkingStreamSegments.clear();
    this._liveThinkingRunIds.clear();
    return this._activeRunGeneration;
  }

  _registerChatCommandRun(params) {
    const runId = normalizeRunId(params && params.idempotencyKey);
    if (!runId) return;

    const cutoffMs = Date.now() - CHAT_COMMAND_RUN_TTL_MS;
    for (const [key, entry] of this._chatCommandRuns) {
      if (entry.startedAtMs <= cutoffMs) this._chatCommandRuns.delete(key);
    }
    while (this._chatCommandRuns.size >= CHAT_COMMAND_RUN_MAX) {
      const oldest = this._chatCommandRuns.keys().next();
      if (oldest.done) break;
      this._chatCommandRuns.delete(oldest.value);
    }
    this._chatCommandRuns.set(runId, {
      sessionKey: normalizeSessionKey(params && params.sessionKey) || "main",
      startedAtMs: Date.now(),
      agentOwned: false,
    });
  }

  _forgetChatCommandRun(params) {
    const runId = normalizeRunId(params && params.idempotencyKey);
    if (runId) this._chatCommandRuns.delete(runId);
  }

  _commitChatCommandRun(commit) {
    this.emit("message", {
      runId: commit.runId,
      role: "assistant",
      content: [{ type: "text", text: commit.text }],
      sessionKey: commit.sessionKey,
    });
    this.emit("activity", {
      state: "idle",
      sessionKey: commit.sessionKey,
      runId: commit.runId,
      origin: "lifecycle",
      phase: "end",
    });
    this._logger.info(
      `[openclaw] Gateway command run ended: ${commit.runId} (${commit.text.length} chars)`,
    );
  }

  _handleChatEvent(payload) {
    if (!payload || typeof payload !== "object") return;
    const runId = normalizeRunId(payload.runId);
    if (!runId) return;
    const entry = this._chatCommandRuns.get(runId);
    if (!entry) return;
    const state = typeof payload.state === "string" ? payload.state : "";

    if (state !== "final" && state !== "error") {
      if (state === "aborted") this._chatCommandRuns.delete(runId);
      return;
    }
    this._chatCommandRuns.delete(runId);

    if (entry.agentOwned) return;
    const text = extractChatMessageText(payload.message);

    if (!text) return;
    const commit = {
      runId,
      sessionKey:
        normalizeSessionKey(payload.sessionKey) || entry.sessionKey || null,
      text,
    };

    if (!this._historyResolved) {
      this._eventQueue.push({ chatCommit: commit });
      return;
    }
    this._commitChatCommandRun(commit);
  }

  _isActiveRunContextCurrent(context) {
    if (!context || typeof context !== "object") return false;
    return (
      this._activeRunGeneration === context.generation &&
      normalizeRunId(this._activeRunId) === context.runId &&
      normalizeSessionKey(this._activeRunSessionKey) === context.sessionKey &&
      Boolean(normalizeRunId(this._activeRunId)) &&
      Boolean(normalizeSessionKey(this._activeRunSessionKey))
    );
  }

  _connect() {
    if (this._stopped) return;

    if (this._ws) {
      try { this._ws.close(); } catch {  }
      this._ws = null;
    }

    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }

    this._clearEstablishTimer();

    const url = this._gatewayUrl;
    this.emit("status", "connecting");
    this._logger.info(`[openclaw] Connecting to ${url}`);

    this._connectNonce = null;
    this._connectSent = false;

    this._socketGeneration += 1;

    this._timingLedger.clear("connect_reset");
    this._lastSeq = null;
    this._lastTick = null;
    this._historyResolved = false;
    this._eventQueue = [];

    this._chatCommandRuns.clear();
    this._invalidateActiveRun();

    const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
    this._ws = ws;

    this._armEstablishTimer(ws);

    ws.on("open", () => {

      this._clearEstablishTimer();
      this._logger.info("[openclaw] WebSocket open, waiting for challenge...");

      this._connectTimer = setTimeout(() => {
        this._sendConnect();
      }, 750);
    });

    ws.on("message", (data) => {
      this._handleMessage(data.toString());
    });

    ws.on("close", (code, reason) => {
      const reasonText = reason ? reason.toString() : "";
      this._logger.info(`[openclaw] WebSocket closed: ${code} ${reasonText}`);
      this._ws = null;
      this._clearEstablishTimer();
      this._stopTickWatch();
      this._stopHistoryActivityPolling();
      this._timingLedger.clear("disconnect");
      this._flushPendingErrors(new Error(`gateway closed (${code}): ${reasonText}`));
      this.emit("disconnected", { code, reason: reasonText });
      this.emit("status", "disconnected");

      if (!this._reconnectTimer) {
        this._scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      this._logger.error(`[openclaw] WebSocket error: ${err.message}`);
      if (!this._connectSent) {
        this.emit("error", err);
      }
    });
  }

  _armEstablishTimer(ws) {
    const establishGeneration = this._socketGeneration;
    this._establishTimer = setTimeout(() => {
      this._establishTimer = null;
      if (this._stopped || ws !== this._ws || establishGeneration !== this._socketGeneration) {
        return;
      }
      this._logger.warn(
        `[openclaw] Connect establishment timeout (${ESTABLISH_TIMEOUT_MS}ms), terminating socket`
      );
      try {
        ws.terminate();
      } catch {

      }
    }, ESTABLISH_TIMEOUT_MS);
    if (this._establishTimer.unref) {
      this._establishTimer.unref();
    }
  }

  _clearEstablishTimer() {
    if (this._establishTimer) {
      clearTimeout(this._establishTimer);
      this._establishTimer = null;
    }
  }

  _handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this._logger.error(`[openclaw] Failed to parse message: ${err.message}`);
      return;
    }

    this.emit("protocol", { direction: "in", frame: parsed });

    if (parsed.type === "event") {
      this._handleEvent(parsed);
      return;
    }

    if (parsed.type === "res") {
      const pending = this._pending.get(parsed.id);
      if (!pending) return;

      const payload = parsed.payload;
      const status = payload && payload.status;
      const keepPending =
        pending.expectFinal && parsed.ok === true && status === "accepted";
      this._timingLedger.recordResponseReceived({
        requestId: parsed.id,
        ok: parsed.ok === true,
        payload: parsed.payload,
        response: parsed.payload,
        error: parsed.error,
        keepPending,
      });
      if (keepPending) {

        if (pending.timer) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }

        if (payload.runId) {
          this._activeRunId = payload.runId;
          this._logger.info(`[openclaw] Agent run accepted: ${payload.runId}`);
        }
        return;
      }

      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      this._pending.delete(parsed.id);
      if (parsed.ok) {
        pending.resolve(parsed.payload);
      } else {
        const errMsg =
          parsed.error && parsed.error.message ? parsed.error.message : "unknown error";
        const err = new Error(errMsg);
        if (parsed.error && typeof parsed.error.code === "string") {
          err.code = parsed.error.code;
        }
        if (parsed.error && parsed.error.data !== undefined) {
          err.data = parsed.error.data;
        }

        if (parsed.error && parsed.error.retryable && parsed.error.retryAfterMs) {
          err.retryAfterMs = parsed.error.retryAfterMs;
        }
        pending.reject(err);
      }
      return;
    }
  }

  _handleEvent(evt) {

    if (evt.event === "connect.challenge") {
      const nonce =
        evt.payload && typeof evt.payload.nonce === "string" ? evt.payload.nonce : null;
      if (nonce) {
        this._logger.info("[openclaw] Received connect.challenge");
        this._connectNonce = nonce;
        this._sendConnect();
      }
      return;
    }

    const seq = typeof evt.seq === "number" ? evt.seq : null;
    if (seq !== null) {
      if (this._lastSeq !== null && seq > this._lastSeq + 1) {
        const gapInfo = { expected: this._lastSeq + 1, received: seq };
        this._logger.warn(
          `[openclaw] Sequence gap: expected ${gapInfo.expected}, received ${gapInfo.received}`
        );
        this.emit("gap", gapInfo);

        if (this._activeRunId) {
          this._gapDuringRun = true;
        }
      }
      this._lastSeq = seq;
    }

    if (evt.event === "tick") {
      this._lastTick = Date.now();
      return;
    }

    if (evt.event === "shutdown") {
      const payload = evt.payload || {};
      const restartMs = typeof payload.restartExpectedMs === "number" ? payload.restartExpectedMs : 5000;
      this._logger.info(`[openclaw] Gateway shutdown, reconnecting in ${restartMs}ms`);
      this.emit("status", "shutdown");

      this._scheduleReconnect(restartMs);

      if (this._ws) {
        this._ws.close(1000, "shutdown");
      }
      return;
    }

    if (evt.event === "exec.approval.requested") {
      this.emit("approval", evt.payload);
      return;
    }

    if (evt.event === "exec.approval.resolved") {
      this.emit("approvalResolved", evt.payload);
      return;
    }

    if (evt.event === "plugin.approval.requested") {
      this.emit("approval", { ...(evt.payload || {}), approvalKind: "plugin" });
      return;
    }

    if (evt.event === "plugin.approval.resolved") {
      this.emit("approvalResolved", { ...(evt.payload || {}), approvalKind: "plugin" });
      return;
    }

    if (evt.event === "question.requested") {

      this.emit("question", evt.payload);
      return;
    }

    if (evt.event === "question.resolved") {

      this.emit("questionResolved", evt.payload);
      return;
    }

    if (evt.event === "chat") {
      this._handleChatEvent(evt.payload);
      return;
    }

    if (evt.event === "agent") {
      const payload = evt.payload || {};
      const data = payload.data || {};
      this._timingLedger.recordGatewayEventReceived({
        eventName: evt.event,
        payload: evt.payload,
        kind: evt.event,
        runId: payload.runId,
        stream: payload.stream,
        phase: data.phase,
        data,
      });

      const isCommitEvent = data.phase === "end" && payload.stream === "lifecycle";
      if (isCommitEvent && !this._historyResolved) {

        this._eventQueue.push({
          payload: evt.payload,
          capturedCommit: {
            fullText: this._runTextBuffer,
            activeRunId: this._activeRunId,
            activeRunSessionKey: this._activeRunSessionKey,
            gapDuringRun: this._gapDuringRun,
          },
        });
        return;
      }
      this._handleAgentEvent(evt.payload);
      return;
    }
  }

  _handleAgentEvent(payload, capturedCommit) {
    if (!payload) return;

    const { runId, stream, data } = payload;

    const chatCommandEntry = this._chatCommandRuns.get(normalizeRunId(runId));
    if (chatCommandEntry) chatCommandEntry.agentOwned = true;
    if (!stream || !data) return;

    switch (stream) {
      case "lifecycle":
        this._handleLifecycleEvent(runId, data, payload.sessionKey, capturedCommit);
        break;
      case "assistant":
        this._handleAssistantEvent(runId, data);
        break;
      case "tool":
        this._handleToolEvent(runId, data);
        break;
      case "thinking":
        this._handleThinkingStreamEvent(runId, data);
        break;
      case "error":
        this._logger.error(`[openclaw] Agent error: ${JSON.stringify(data)}`);
        {
          const terminalActivity = buildTerminalErrorActivity(
            data,
            runId || this._activeRunId,
            payload.sessionKey || this._activeRunSessionKey,
            "agent_error",
          );
          if (terminalActivity.runId && terminalActivity.sessionKey) {
            this.emit("activity", terminalActivity);
            this._timingLedger.recordRunTerminal({
              runId: terminalActivity.runId,
            });
            this._invalidateActiveRun();
          }
          this.emit(
            "error",
            buildStructuredError(data, "agent error", terminalActivity.code || "agent_error"),
          );
        }
        break;
      default:
        break;
    }
  }

  _handleLifecycleEvent(runId, data, sessionKey, capturedCommit) {
    switch (data.phase) {
      case "start":
        this._beginActiveRun(runId, sessionKey);
        this._startHistoryActivityPolling();
        this.emit("activity", {
          state: "thinking",
          sessionKey,
          runId,
          origin: "lifecycle",
          phase: "start",
        });
        this._logger.info(`[openclaw] Agent run started: ${runId}`);
        break;

      case "end": {

        const committedActiveRunId = capturedCommit
          ? capturedCommit.activeRunId
          : this._activeRunId;
        const committedActiveRunSessionKey = capturedCommit
          ? capturedCommit.activeRunSessionKey
          : this._activeRunSessionKey;

        const fullText = capturedCommit ? capturedCommit.fullText : this._runTextBuffer;
        const completedRunId = normalizeRunId(committedActiveRunId) || normalizeRunId(runId);
        const completedSessionKey =
          normalizeSessionKey(sessionKey) ||
          normalizeSessionKey(committedActiveRunSessionKey) ||
          null;
        const gapDuringRun = capturedCommit ? capturedCommit.gapDuringRun : this._gapDuringRun;

        this._timingLedger.recordRunTerminal({
          runId: completedRunId,
        });

        const commitIsLiveActiveRun =
          normalizeRunId(this._activeRunId) === normalizeRunId(committedActiveRunId);
        if (!capturedCommit || commitIsLiveActiveRun) {
          this._invalidateActiveRun();
        }

        this.emit("message", {
          runId: completedRunId,
          role: "assistant",
          content: [{ type: "text", text: fullText }],
          sessionKey: completedSessionKey,
        });
        this.emit("activity", {
          state: "idle",
          sessionKey: completedSessionKey,
          runId: completedRunId,
          origin: "lifecycle",
          phase: "end",
        });
        this._logger.info(
          `[openclaw] Agent run ended: ${completedRunId} (${fullText.length} chars)`
        );

        if (gapDuringRun) {
          this._logger.info("[openclaw] Gap detected during run, re-fetching history");
        }
        const historyGuardOwner = this;
        this._fetchHistory(completedSessionKey || "main", {
          idleRunGeneration: historyGuardOwner._activeRunGeneration,
        }).catch((err) => {
          this._logger.error(
            `[openclaw] Post-commit history fetch failed: ${err.message}`
          );
        });
        break;
      }

      case "error":
        this._logger.error(`[openclaw] Agent lifecycle error: ${JSON.stringify(data)}`);
        {
          const terminalActivity = buildTerminalErrorActivity(
            data,
            runId || this._activeRunId,
            sessionKey || this._activeRunSessionKey,
            "agent_lifecycle_error",
          );
          if (terminalActivity.runId && terminalActivity.sessionKey) {
            this.emit("activity", terminalActivity);
          }
          this._timingLedger.recordRunTerminal({
            runId: terminalActivity.runId,
          });
          this._invalidateActiveRun();
          this.emit(
            "error",
            buildStructuredError(
              data,
              "agent lifecycle error",
              terminalActivity.code || "agent_lifecycle_error",
            ),
          );
        }
        break;

      default:
        break;
    }
  }

  _handleAssistantEvent(runId, data) {
    this._emitThinkingActivityFromPayload(
      runId,
      this._activeRunSessionKey,
      data,
      "assistant_event",
    );

    if (typeof data.text === "string") {
      const previousTextLength = this._runTextBuffer.length;
      const gatewayReceivedAtMs = Date.now();
      const rawAssistantChars = data.text.length;
      const assistantDeltaChars = Math.max(0, rawAssistantChars - previousTextLength);
      const firstGatewayChunk = previousTextLength <= 0;
      this._runTextBuffer = data.text;
      this.emit("streaming", {
        text: data.text,
        sessionKey: this._activeRunSessionKey,
        runId: runId || this._activeRunId || null,
        gatewayReceivedAtMs,
        rawAssistantChars,
        assistantDeltaChars,
        firstGatewayChunk,
      });
    }
  }

  _handleToolEvent(runId, data) {
    if (!data || !data.name) return;
    const rawPhase = typeof data.phase === "string" ? data.phase.trim().toLowerCase() : "";
    if (rawPhase !== "start" && rawPhase !== "update" && rawPhase !== "result") return;
    const isToolStart = rawPhase === "start";
    const isToolEnd = rawPhase === "result";

    const args = isObject(data.args) ? data.args : null;
    const pathFromData =
      typeof data.path === "string" && data.path.trim() && !isNullishToken(data.path)
        ? data.path.trim()
        : null;
    const pathFromArgs = pickStringPathFromArgs(args);
    const path = pathFromData || pathFromArgs || null;

    const activity = {
      state: "thinking",
      tool: data.name,
      sessionKey: this._activeRunSessionKey,
      runId: runId || this._activeRunId || null,
      origin: "tool",
      phase: isToolStart ? "start" : "update",
      toolPhase: isToolEnd ? "end" : "start",
    };

    if (args) activity.args = args;
    if (path) activity.path = path;
    if (typeof data.toolCallId === "string" && data.toolCallId.trim()) {
      const trimmedToolCallId = data.toolCallId.trim();
      activity.activityId = trimmedToolCallId;
      activity.toolCallId = trimmedToolCallId;
    }
    if (Number.isFinite(data.seq)) {
      activity.seq = Math.floor(data.seq);
    }
    if (isToolEnd && data.isError === true) {
      activity.isError = true;
    }

    this.emit("activity", activity);
  }

  _startHistoryActivityPolling() {
    this._stopHistoryActivityPolling();
    if (!this._activeRunId || !this._activeRunSessionKey) return;

    const poll = () => {
      this._pollHistoryActivity().catch((err) => {

        const benignTransient =
          !!err &&
          (err.code === "handshake_pending" ||
            (!!err.message &&
              /gateway (not connected|handshake in flight)/i.test(err.message)));
        if (!benignTransient) {
          this._logger.warn(
            `[openclaw] Thinking-summary poll failed: ${
              err && err.message ? err.message : String(err)
            }`
          );
        }
      });
    };

    this._historyActivityPollTimer = setInterval(
      poll,
      HISTORY_ACTIVITY_POLL_INTERVAL_MS,
    );
    if (this._historyActivityPollTimer.unref) {
      this._historyActivityPollTimer.unref();
    }
  }

  _stopHistoryActivityPolling() {
    if (this._historyActivityPollTimer) {
      clearInterval(this._historyActivityPollTimer);
      this._historyActivityPollTimer = null;
    }
    this._historyActivityPollInFlightGeneration = null;
  }

  async _pollHistoryActivity() {
    if (!this._historyResolved) return;
    const runContext = {
      generation: this._activeRunGeneration,
      runId: normalizeRunId(this._activeRunId),
      sessionKey: normalizeSessionKey(this._activeRunSessionKey),
    };
    if (!runContext.runId || !runContext.sessionKey) return;

    if (this._liveThinkingRunIds.has(runContext.runId)) return;
    if (this._historyActivityPollInFlightGeneration === runContext.generation) return;

    this._historyActivityPollInFlightGeneration = runContext.generation;
    try {
      const result = await this.request("chat.history", {
        sessionKey: runContext.sessionKey,
        limit: HISTORY_ACTIVITY_POLL_LIMIT,
      });
      if (!this._isActiveRunContextCurrent(runContext)) {
        this._logger.debug(
          `[openclaw] Dropped stale thinking-summary poll for run ${runContext.runId}`
        );
        return;
      }
      const responseSessionKey =
        normalizeSessionKey(result && result.sessionKey) || runContext.sessionKey;
      if (responseSessionKey !== runContext.sessionKey) {
        this._logger.debug(
          `[openclaw] Dropped thinking-summary poll with mismatched session ${String(
            result && result.sessionKey
          )}`
        );
        return;
      }
      const messages = result && Array.isArray(result.messages) ? result.messages : [];
      this._emitThinkingFromHistory(
        messages,
        responseSessionKey,
        runContext,
      );
    } finally {
      if (this._historyActivityPollInFlightGeneration === runContext.generation) {
        this._historyActivityPollInFlightGeneration = null;
      }
    }
  }

  _emitThinkingFromHistory(messages, sessionKey, runContext) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    if (runContext && !this._isActiveRunContextCurrent(runContext)) return;
    const activeRunId = normalizeRunId(this._activeRunId);
    const runStartMs = Number.isFinite(this._activeRunStartedAtMs)
      ? this._activeRunStartedAtMs
      : null;

    for (const message of messages) {
      if (!isObject(message)) continue;
      if (message.role !== "assistant") continue;

      const messageRunId = normalizeRunId(message.runId);
      if (activeRunId && messageRunId && messageRunId !== activeRunId) continue;

      const messageTs = extractHistoryTimestampMs(message);
      if (
        activeRunId &&
        !messageRunId &&
        runStartMs !== null &&
        messageTs !== null &&
        messageTs < runStartMs - 2000
      ) {
        continue;
      }

      const content = Array.isArray(message.content) ? message.content : [];
      for (const contentItem of content) {
        if (!isObject(contentItem)) continue;
        if (contentItem.type !== "thinking") continue;
        this._emitThinkingActivityFromPayload(
          messageRunId || activeRunId,
          sessionKey,
          contentItem,
          "history",
        );
      }
    }
  }

  _handleThinkingStreamEvent(runId, data) {
    if (!isObject(data)) return;

    const normalizedRunId =
      normalizeRunId(runId) || normalizeRunId(this._activeRunId);
    const segmentKey = normalizedRunId || "__global__";

    const gatewayText =
      typeof data.text === "string" && data.text.trim() ? data.text : null;
    const gatewayDelta = typeof data.delta === "string" && data.delta ? data.delta : null;

    const state = this._thinkingStreamSegments.get(segmentKey) || { raw: "", base: "" };
    if (gatewayText) {
      if (!state.raw || gatewayText.startsWith(state.raw)) {

        state.raw = gatewayText;
      } else if (state.raw.startsWith(gatewayText)) {

      } else {

        state.base = joinThinkingSegments(state.base, state.raw);
        state.raw = gatewayText;
      }
    } else if (gatewayDelta) {

      state.raw = `${state.raw}${gatewayDelta}`;
    } else {
      return;
    }
    this._thinkingStreamSegments.set(segmentKey, state);

    const cumulativeRaw = joinThinkingSegments(state.base, state.raw);
    if (!cumulativeRaw.trim()) return;

    if (normalizedRunId) {
      this._liveThinkingRunIds.add(normalizedRunId);
    }

    const payload = {
      thinking: sliceFromLastClosedBoldSegment(cumulativeRaw) || cumulativeRaw,
    };
    if (data.thinkingSignature) payload.thinkingSignature = data.thinkingSignature;
    this._emitThinkingActivityFromPayload(
      normalizedRunId,
      this._activeRunSessionKey,
      payload,
      "thinking_stream",
      { frameText: cumulativeRaw },
    );
  }

  _emitThinkingActivityFromPayload(runId, sessionKey, rawPayload, source = "unknown", options = {}) {
    const extracted = extractThinkingPayload(rawPayload);
    if (!extracted) return;

    const normalizedRunId = normalizeRunId(runId) || normalizeRunId(this._activeRunId);
    const normalizedSessionKey = sessionKey || this._activeRunSessionKey || null;

    const authoritativeFrameText = normalizeThinkingText(
      options && typeof options.frameText === "string" ? options.frameText : null,
    );
    const frameDedupeKey = authoritativeFrameText
      ? `${normalizedRunId || "run"}:frame:${hashThinkingKey(authoritativeFrameText)}`
      : thinkingFrameDedupeKey(normalizedRunId, extracted);
    if (!frameDedupeKey || !this._seenThinkingFrameIds.has(frameDedupeKey)) {
      const emittedFrame = this._emitThinkingFrameUpdate(
        normalizedRunId,
        normalizedSessionKey,
        extracted,
        source,
        authoritativeFrameText,
      );
      if (emittedFrame && frameDedupeKey) {
        this._seenThinkingFrameIds.add(frameDedupeKey);
      }
    }

    const dedupeSeed = extracted.signatureId || hashThinkingKey(extracted.label);
    const dedupeKey = `${normalizedRunId || "run"}:${dedupeSeed}`;
    if (this._seenThinkingSummaryIds.has(dedupeKey)) return;
    this._seenThinkingSummaryIds.add(dedupeKey);

    this.emit("thinkingDebug", {
      sessionKey: sessionKey || this._activeRunSessionKey || null,
      runId: normalizedRunId || null,
      source,
      signatureId: extracted.signatureId || null,
      rawKeys: isObject(rawPayload) ? Object.keys(rawPayload).sort() : [],
      rawPayload: buildThinkingDebugRawPayload(rawPayload),
      summaryKey: extracted.summaryKey,
      detailKey: extracted.detailKey,
      labelKey: extracted.labelKey,
      labelRaw: extracted.labelRaw,
      labelSource: extracted.labelSource,
      thinkingSummarySource: extracted.thinkingSummarySource,
      normalizedSummary: extracted.summaryText || null,
      normalizedDetail: extracted.detailText || null,
      label: extracted.label,
      detail: extracted.detail,
      boldLabelCandidate: extracted.boldLabelCandidate || null,
      boldLabelMatchesCurrentLabel: extracted.boldLabelCandidate
        ? extracted.boldLabelCandidate === extracted.label
        : null,
    });

    this.emit("activity", {
      state: "thinking",
      sessionKey: normalizedSessionKey,
      runId: normalizedRunId || null,
      origin: "thinking",
      phase: "update",
      summary: extracted.label,
      thinking: extracted.detail,
      thinkingSummarySource: extracted.thinkingSummarySource,
      thinkingSignatureId: extracted.signatureId || null,
    });
  }

  _emitThinkingFrameUpdate(runId, sessionKey, extracted, source, authoritativeText = null) {
    const normalizedRunId = normalizeRunId(runId);
    const normalizedSessionKey = normalizeSessionKey(sessionKey);
    const detail = normalizeThinkingText(extracted && extracted.detail);
    const authoritative = normalizeThinkingText(authoritativeText);
    if (!authoritative && !detail) return false;
    const bufferKey = normalizedRunId || "__global__";
    const previous = this._thinkingFrameBuffers.get(bufferKey) || "";

    const text = authoritative
      ? clampThinkingFrameText(authoritative)
      : appendThinkingFrameText(previous, detail);
    if (!text) return false;
    this._thinkingFrameBuffers.set(bufferKey, text);
    this.emit("thinking", {
      phase: "update",
      sessionKey: normalizedSessionKey,
      runId: normalizedRunId,
      text,

      delta: authoritative
        ? (text.startsWith(previous) ? text.slice(previous.length) : text)
        : detail,
      summary: extracted.label,
      thinkingSummarySource: extracted.thinkingSummarySource,
      thinkingSignatureId: extracted.signatureId || null,
      source,
    });
    return true;
  }

  _sendConnect() {
    if (this._connectSent) return;
    this._connectSent = true;

    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }

    const identity = this._identity;
    if (!identity) {
      this.emit("error", new Error("no device identity"));
      return;
    }

    const authToken = this._deviceToken || this._gatewayToken || undefined;
    const canFallback = Boolean(this._deviceToken && this._gatewayToken);

    const signedAtMs = Date.now();
    const nonce = this._connectNonce || undefined;

    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: SCOPES,
      signedAtMs,
      token: authToken || null,
      nonce,
    });

    const signature = signPayload(identity.privateKeyPem, payload);

    const params = {
      minProtocol: MIN_PROTOCOL_VERSION,
      maxProtocol: MAX_PROTOCOL_VERSION,
      client: {
        id: CLIENT_ID,
        version: CLIENT_VERSION,
        platform: process.platform,
        mode: CLIENT_MODE,
      },
      role: ROLE,
      scopes: SCOPES,

      caps: ["tool-events", "approvals"],
      auth: authToken ? { token: authToken } : undefined,
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    };

    this._logger.info("[openclaw] Sending connect request...");

    const connectGeneration = this._socketGeneration;

    this.request("connect", params)
      .then((helloOk) => {
        this._logger.info(
          `[openclaw] Connected! protocol=${helloOk.protocol}, ` +
            `tick=${helloOk.policy && helloOk.policy.tickIntervalMs}ms`
        );

        this._backoffMs = 1000;

        this._applyConnectPolicy(helloOk.policy);

        this._lastTick = Date.now();
        this._startTickWatch();

        if (helloOk.auth && helloOk.auth.deviceToken) {
          this._deviceToken = helloOk.auth.deviceToken;
          storeDeviceToken(
            identity.deviceId,
            helloOk.auth.deviceToken,
            helloOk.auth.role || ROLE,
            helloOk.auth.scopes || SCOPES,
            this._persistencePaths,
          );
          this._logger.info("[openclaw] Device token cached");
        }

        if (connectGeneration === this._socketGeneration) {
          this._handshakeGeneration = connectGeneration;
        }

        this.emit("connected", {
          protocol: helloOk.protocol,
          tickIntervalMs: this._tickIntervalMs,
        });
        this.emit("status", "connected");

        this._postConnect().catch((err) => {
          this._logger.error(`[openclaw] Post-connect setup failed: ${err.message}`);
          this.emit("error", err);
        });
      })
      .catch((err) => {
        this._logger.error(`[openclaw] Connect failed: ${err.message}`);

        if (canFallback) {
          this._logger.info(
            "[openclaw] Clearing cached device token, will use gateway token on next connect"
          );
          this._deviceToken = null;
          clearDeviceToken(this._persistencePaths);
        }

        this.emit("connectFailed", {
          reason: sanitizeConnectReason(err && err.message),
          minProtocol: MIN_PROTOCOL_VERSION,
          maxProtocol: MAX_PROTOCOL_VERSION,
        });
        this.emit("error", err);
        if (this._ws) {
          this._ws.close(1008, "connect failed");
        }
      });
  }

  async _postConnect() {

    this.fetchAgentIdentity().catch((err) => {
      this._logger.error(`[openclaw] Agent identity fetch failed: ${err.message}`);
    });

    try {
      await this._fetchHistory("main");
    } catch (err) {
      this._logger.error(`[openclaw] Chat history fetch failed: ${err.message}`);
    }

    this._historyResolved = true;
    this._drainEventQueue();
  }

  async _fetchHistory(sessionKey, options = {}) {
    const result = await this.request("chat.history", {
      sessionKey,
      limit: 200,
    });

    if (Number.isFinite(options.idleRunGeneration)) {
      const historyResult = result;
      const historyGuardOwner = this;
      const responseSessionKey =
        normalizeSessionKey(historyResult && historyResult.sessionKey) || normalizeSessionKey(sessionKey);
      const stalePostCommitHydrate =
        historyGuardOwner._activeRunGeneration !== options.idleRunGeneration ||
        Boolean(normalizeRunId(historyGuardOwner._activeRunId)) ||
        responseSessionKey !== normalizeSessionKey(sessionKey);
      if (stalePostCommitHydrate) {
        historyGuardOwner._logger.debug(
          `[openclaw] Dropped stale post-commit history for session ${sessionKey}`
        );
        return result;
      }
    }

    const messages = result && Array.isArray(result.messages) ? result.messages : [];
    this._logger.info(`[openclaw] Chat history loaded: ${messages.length} messages`);

    this.emit("history", {
      sessionKey: (result && result.sessionKey) || sessionKey,
      messages,
    });

    return result;
  }

  _drainEventQueue() {
    const queue = this._eventQueue;
    this._eventQueue = [];
    for (const evt of queue) {

      if (evt && evt.chatCommit) {
        this._commitChatCommandRun(evt.chatCommit);
        continue;
      }
      this._handleAgentEvent(evt.payload, evt.capturedCommit);
    }
  }

  _scheduleReconnect(delayOverride) {
    if (this._stopped) return;

    const base = this._backoffMs;

    if (typeof delayOverride !== "number") {
      this._backoffMs = Math.min(this._backoffMs * 2, 30000);
    }

    const delay =
      typeof delayOverride === "number"
        ? delayOverride
        : Math.floor(base / 2 + Math.random() * (base / 2));

    this._logger.info(
      `[openclaw] Reconnecting in ${delay}ms (backoff: ${this._backoffMs}ms)`
    );

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.start();
    }, delay);

    if (this._reconnectTimer.unref) {
      this._reconnectTimer.unref();
    }
  }

  _applyConnectPolicy(policy) {
    if (policy && typeof policy.tickIntervalMs === "number") {
      this._tickIntervalMs = Math.min(policy.tickIntervalMs, TICK_WATCH_MAX_INTERVAL_MS);
    }
  }

  _startTickWatch() {
    this._stopTickWatch();
    const pollMs = Math.max(Math.floor(this._tickIntervalMs / 4), 1000);
    this._tickWatchTimer = setInterval(() => {
      if (this._stopped) return;
      if (!this._lastTick) return;
      const elapsed = Date.now() - this._lastTick;
      if (elapsed > this._tickIntervalMs * TICK_STALE_MULTIPLIER) {
        this._logger.warn(
          `[openclaw] Tick timeout (${elapsed}ms since last tick), closing connection`
        );
        if (this._ws) {
          this._ws.close(4000, "tick timeout");
        }
      }
    }, pollMs);

    if (this._tickWatchTimer.unref) {
      this._tickWatchTimer.unref();
    }
  }

  _stopTickWatch() {
    if (this._tickWatchTimer) {
      clearInterval(this._tickWatchTimer);
      this._tickWatchTimer = null;
    }
  }

  _flushPendingErrors(err) {
    for (const [, pending] of this._pending) {

      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      pending.reject(err);
    }
    this._pending.clear();
  }
}

function createPluginOpenclawClient(opts = {}) {
  return new OpenClawClient(opts);
}

module.exports = { createPluginOpenclawClient };
