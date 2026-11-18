const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { createGatewayTimingLedger } = require("./gateway-timing-ledger.cjs");
const { stripDisplayMarkup } = require("../domain/tagged-span-strip.cjs");
const { speckFeelings } = require("../domain/speck-marker.cjs");
const { sanitizeConnectReason } = require("./sanitize-connect-reason.cjs");
const { sanitizeProtocolFrame } = require("../runtime/downstream-handler.cjs");
const { isAgentSelectionRequiredError, scopeOpenClawRequestSessionParams } = require("../runtime/openclaw-session-key.cjs");
const { isTitleDistillerRun } = require("../runtime/session-title-distiller-helpers.cjs");
const { createDeclinedToolRunTracker } = require("../runtime/declined-tool-reply.cjs");
const { createApprovalContextRecorder } = require("./approval-context.cjs");
const { createOpenclawAgentRunSignals } = require("./openclaw-run-signals.cjs");
const { createOpenclawModelCallTracker, positiveModelCallSeq } = require("./openclaw-model-calls.cjs");
const { stripLiveuiContextFenceFromHistoryResult } = require("../tools/glasses-ui-context-fence.cjs");
const { projectOpenClawConversationHistory } = require("../domain/openclaw-conversation-history.cjs");
const { pickPatchPath } = require("../domain/activity-status-labels.cjs");

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

const LATE_SUMMARY_HOLD_MS = 600;

const RELEASES_HELD_SUMMARY_ITEM_KINDS = new Set(["preamble", "tool", "command", "patch", "search"]);

const REASONING_CUE_LABEL = "Reasoning...";

const TOOL_CALL_WRAPPER_NAME = "tool_call";
const TOOL_CALL_WRAPPER_LIMIT = 256;
const WRAPPED_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function wrappedToolName(args     )                {
  if (!args || typeof args !== "object" || typeof args.id !== "string") return null;
  const id = args.id.trim();
  const name = id.slice(id.lastIndexOf(":") + 1).trim();
  return WRAPPED_TOOL_NAME_RE.test(name) && name !== TOOL_CALL_WRAPPER_NAME ? name : null;
}

const PLAN_MAX_ITEMS = 30;
const PLAN_ITEM_MAX_CHARS = 120;
const PLAN_STATUSES = ["pending", "in_progress", "completed", "cancelled"];
const RUN_SESSION_KEY_LIMIT = 64;

const PROGRESS_RECORDS_READ_BUDGET_MS = 3000;
const PROGRESS_RECORDS_READ_RETRY_MS = 250;
const PROGRESS_RECORDS_HISTORY_LIMIT = 20;

const COMPOSE_TOOL_NAME = "compose_glasses_ui";
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

function helloFeaturesFrom(helloOk     ) {
  const features = isObject(helloOk && helloOk.features) ? helloOk.features : {};
  const server = isObject(helloOk && helloOk.server) ? helloOk.server : {};
  const names = (list     ) =>
    Array.isArray(list) ? list.filter((name) => typeof name === "string" && name.length > 0) : [];
  return Object.freeze({
    methods: Object.freeze(names(features.methods)),
    events: Object.freeze(names(features.events)),
    bootId: typeof server.bootId === "string" ? server.bootId : null,
    version: typeof server.version === "string" ? server.version : null,
  });
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

function stripPatchBodies(args     ) {
  const looksLikePatch = (value     ) =>
    typeof value === "string" && /^\s*\*\*\* Begin Patch/.test(value);
  const hasBody =
    "diff" in args ||
    typeof args.patch === "string" ||
    looksLikePatch(args.input) ||
    Array.isArray(args.changes);
  if (!hasBody) return args;
  const out      = { ...args };
  delete out.diff;
  if (typeof out.patch === "string") delete out.patch;
  if (looksLikePatch(out.input)) delete out.input;
  if (Array.isArray(out.changes)) {
    out.changes = out.changes.map((change     ) => {
      if (!isObject(change)) return change;
      const kept      = {};
      if (typeof change.path === "string") kept.path = change.path;
      if (change.kind !== undefined) kept.kind = change.kind;
      return kept;
    });
  }
  return out;
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

    text.includes("usage-limit") ||
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

  if (
    text.includes("oauthrefreshfailure") ||
    text.includes("oauth refresh failed") ||
    text.includes("token refresh failed") ||
    text.includes("refresh token expired") ||
    text.includes("session has ended") ||
    text.includes("please log in again") ||
    text.includes("401 unauthorized") ||
    text.includes("http 401") ||
    text.includes("status 401") ||
    text.includes("unauthorized")
  ) {
    return "auth_refresh";
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

function isGatewaySeqGapNotice(data         )          {
  return !!data && typeof data === "object" && (data                           ).reason === "seq gap";
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

  const stopReason = pickTrimmedString(source.stopReason);
  const aborted = source.aborted === true || (!!stopReason && stopReason.toLowerCase() === "aborted");
  const activity = {
    state: "idle",
    sessionKey,
    runId,
    origin: "lifecycle",
    phase: "error",
    isError: true,
    code,
    ...(aborted ? { aborted: true } : {}),
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

  const stopReason = pickTrimmedString(source.stopReason);
  if (source.aborted === true || (!!stopReason && stopReason.toLowerCase() === "aborted")) {
    Object.assign(error, { aborted: true });
  }
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

function cumulativeAssistantText(data, previousText, previousItemId, startsMessage = false) {
  if (typeof data.text === "string") return data.text;
  if (typeof data.delta !== "string" || !data.delta) return null;

  if (data.phase === "commentary") return null;
  const itemId =
    typeof data.itemId === "string" && data.itemId.trim() ? data.itemId.trim() : null;
  const sameMessage =
    !startsMessage &&
    data.replace !== true &&
    !(itemId && previousItemId && itemId !== previousItemId);
  return `${sameMessage ? previousText : ""}${data.delta}`;
}

function noteMediaUrls(target          , data     ) {
  if (!data || !Array.isArray(data.mediaUrls)) return;
  for (const url of data.mediaUrls) {
    const value = typeof url === "string" ? url.trim() : "";
    if (value && !value.includes("\n") && !target.includes(value)) target.push(value);
  }
}

function withMediaLines(text     , urls          ) {
  const base = typeof text === "string" ? text : "";
  const missing = (urls || []).filter((url) => !base.includes(`MEDIA:${url}`));
  if (missing.length === 0) return base;
  const lines = missing.map((url) => `MEDIA:${url}`).join("\n");
  return base.trim() ? `${base.trimEnd()}\n\n${lines}` : lines;
}

function assistantMessagePhase(data     ) {
  return typeof data.phase === "string" && data.phase.trim()
    ? data.phase.trim().toLowerCase()
    : null;
}

function collapseWhitespace(text     ) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function findProgressTexts(messages     , preambles          , found                   ) {
  if (!Array.isArray(messages)) return found;
  const next = found.slice();
  for (let i = messages.length - 1; i >= 0 && next.some((text) => !text); i -= 1) {
    const msg = messages[i];
    if (!isObject(msg) || msg.role !== "assistant") continue;
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") continue;
      const collapsed = collapseWhitespace(block.text);
      preambles.forEach((preamble, index) => {
        if (!next[index] && collapsed.startsWith(preamble)) next[index] = block.text;
      });
    }
  }
  return next;
}

function newRunProgress() {
  return {

    keepsLines: false,

    streamedAsReply: false,

    messages: new Map(),

    holdsIndex: null       ,

    read: null       ,
  };
}

function beforeDeadline(promise              , deadline        ) {
  let timer      = null;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("deadline passed")), Math.max(0, deadline - Date.now()));
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function unscopeEcho(result     , params     , scoped     ) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  let next = result;
  for (const field of ["key", "sessionKey"]) {
    if (scoped[field] !== params[field] && result[field] === scoped[field]) {
      if (next === result) next = { ...result };
      next[field] = params[field];
    }
  }
  return next;
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

function clampThinkingFrameText(rawText     ) {
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

function joinThinkingSegments(baseText     , nextText     ) {
  const base = typeof baseText === "string" ? baseText.trim() : "";
  const next = typeof nextText === "string" ? nextText.trim() : "";
  if (!base) return next;
  if (!next) return base;
  return `${base}\n${next}`;
}

function clampPlanText(raw     ) {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (text.length <= PLAN_ITEM_MAX_CHARS) return text;
  return `${text.slice(0, PLAN_ITEM_MAX_CHARS - 1).trimEnd()}…`;
}

function normalizePlanStatus(raw     ) {
  const status = typeof raw === "string" ? raw.trim().toLowerCase().replace(/-/g, "_") : "";
  return PLAN_STATUSES.includes(status) ? status : "pending";
}

function planStepGlance(items       ) {
  const counted = items.filter((item) => item.status !== "cancelled");
  const total = counted.length;
  if (!total) return null;
  const completed = counted.filter((item) => item.status === "completed").length;
  if (completed === total) return { index: total, total, done: true };
  let index = counted.findIndex((item) => item.status === "in_progress");
  let current = index >= 0 ? counted[index] : null;
  if (!current) {
    index = Math.min(completed, total - 1);
    current = counted.find((item) => item.status === "pending") || counted[index];
  }
  const step      = { index: index + 1, total, done: false };
  if (current && current.content) step.content = current.content;
  return step;
}

function buildActivityPlan(data     , revision        ) {
  if (!isObject(data) || !Array.isArray(data.steps)) return null;
  const items        = [];
  for (const raw of data.steps) {
    if (!isObject(raw)) continue;
    const content = clampPlanText(raw.step ?? raw.content ?? raw.text);
    if (!content) continue;
    items.push({ content, status: normalizePlanStatus(raw.status) });
  }
  if (!items.length) return null;
  const summary      = { total: items.length };
  for (const status of PLAN_STATUSES) {
    summary[status] = items.filter((item) => item.status === status).length;
  }
  const plan      = { revision, items: items.slice(0, PLAN_MAX_ITEMS), summary };
  if (items.length > PLAN_MAX_ITEMS) plan.truncated = true;
  const step = planStepGlance(items);
  if (step) plan.step = step;
  const explanation = clampPlanText(data.explanation);
  if (explanation) plan.explanation = explanation;
  return plan;
}

function newThinkingStreamSegment() {
  return { raw: "", base: "", events: 0, itemId: null, ordinal: 0, boundary: false };
}

const SUMMARY_TITLE_MAX_CHARS = 100;
function asSummaryTitle(segment     , events        ) {
  if (typeof segment !== "string" || events !== 1) return segment;
  const title = segment.trim();
  if (!title || title.length > SUMMARY_TITLE_MAX_CHARS) return segment;
  if (title.includes("*") || /[\r\n]/.test(title)) return segment;
  return `**${title}**`;
}

function finishedSentences(text     ) {
  if (typeof text !== "string") return null;
  const match = /^[\s\S]*[.!?](?=\s|$)/.exec(text.trim());
  return match ? match[0].trim() : null;
}

class OpenClawClient extends EventEmitter {

  _thinkingStreamSegments     ;
  _commentaryByRun     ;
  _preToolProseKey     ;
  _reasoningCueItemIds     ;
  _planRevisionByRun     ;
  _modelCalls     ;
  _toolCallWrappers     ;
  _liveThinkingRunIds     ;
  _heldThinking     ;
  _lateSummaryHoldMs     ;
  _activeRunId     ;
  _activeRunStartedAtMs     ;
  _activeRunSessionKey     ;
  _runMessagePhase     ;
  _runRecordsPreambles     ;
  _runStreamedRecordTexts     ;
  _runProgress     ;
  _runMessageIndex     ;
  _activeRunGeneration     ;
  _commitHold     ;
  _runTextBuffer     ;
  _runMediaUrls          ;
  _historyResolved     ;
  _eventQueue     ;
  _logger     ;
  _approvalContext     ;

  _ws     ;
  _socketGeneration     ;
  _stopped     ;
  _helloFeatures     ;

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

    this._sessionDefaults = null;

    this._helloFeatures = null;
    this._agentSelectionRequiredLatched = false;
    this._sessionAgentResolver = null;

    this._backoffMs = 1000;
    this._reconnectTimer = null;

    this._lastTick = null;
    this._tickWatchTimer = null;

    this._activeRunId = null;
    this._activeRunSessionKey = null;
    this._activeRunStartedAtMs = null;
    this._activeRunGeneration = 0;
    this._runTextBuffer = "";

    this._runMediaUrls = [];

    const declinedToolRunsOwner      = this;
    declinedToolRunsOwner._declinedToolRuns = createDeclinedToolRunTracker();

    const runRouting      = this;
    runRouting._runSessionKeys = new Map();

    runRouting._backgroundRunText = new Map();

    runRouting._runSignals = createOpenclawAgentRunSignals();

    this._runMessageIndex = 0;

    this._runItemId = null;

    this._runMessagePhase = null;

    this._runRecordsPreambles = new Map();

    this._runStreamedRecordTexts = [];

    this._runProgress = newRunProgress();

    this._commitHold = false;

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

    this._commentaryByRun = new Map();

    this._reasoningCueItemIds = new Set();

    this._planRevisionByRun = new Map();

    this._modelCalls = createOpenclawModelCallTracker();

    this._toolCallWrappers = new Map();

    this._approvalContext = createApprovalContextRecorder();

    this._liveThinkingRunIds = new Set();

    this._heldThinking = new Map();
    const holdMs = (opts       ).lateSummaryHoldMs;
    this._lateSummaryHoldMs =
      typeof holdMs === "number" && Number.isFinite(holdMs)
        ? Math.max(0, holdMs)
        : LATE_SUMMARY_HOLD_MS;
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
      const ws = this._ws;
      this._ws = null;
      try { ws.close(); } catch {  }
    }
    this._flushPendingErrors(new Error("client stopped"));
    this.emit("status", "stopped");
  }

  request(method, params, opts) {

    if (method === "chat.history" || method === "sessions.list") {
      return this._requestScoped(method, params, opts).then((result) =>
        stripLiveuiContextFenceFromHistoryResult(method, result),
      );
    }
    return this._requestScoped(method, params, opts);
  }

  _requestScoped(method     , params     , opts     ) {
    if (method === "connect") return this._requestFrame(method, params, opts);

    const scoped = this._agentSelectionRequired()
      ? this._scopeSessionParams(method, params)
      : this._scopeSessionParams(method, params, true);
    const sent = this._requestFrame(method, scoped, opts);
    if (scoped !== params) return sent.then((result) => unscopeEcho(result, params, scoped));
    return sent.catch((err) => {
      if (!isAgentSelectionRequiredError(err)) throw err;
      this._agentSelectionRequiredLatched = true;
      const retry = this._scopeSessionParams(method, params);
      if (retry === params) throw err;
      this._logger.info(
        `[openclaw] ${method} needs an agent owner; retrying with an agent-scoped session key`
      );
      return this._requestFrame(method, retry, opts).then((result) =>
        unscopeEcho(result, params, retry),
      );
    });
  }

  setSessionAgentResolver(resolver     ) {
    this._sessionAgentResolver = typeof resolver === "function" ? resolver : null;
  }

  getHelloFeatures() {
    return this._helloFeatures;
  }

  getSessionDefaults() {
    return this._sessionDefaults ? { ...this._sessionDefaults } : null;
  }

  _agentSelectionRequired() {
    return (
      this._agentSelectionRequiredLatched === true ||
      (this._sessionDefaults !== null && this._sessionDefaults.selectionRequired === true)
    );
  }

  _scopeSessionParams(method     , params     , nonDefaultOnly = false) {
    return scopeOpenClawRequestSessionParams(method, params, {
      resolveAgentId: this._sessionAgentResolver,
      defaultAgentId: this._sessionDefaults ? this._sessionDefaults.defaultAgentId : "",
      nonDefaultOnly,
    });
  }

  _requestFrame(method     , params     , opts     ) {

    const ws = this._ws;
    const gen = this._socketGeneration;
    if (this._stopped || !ws || ws !== this._ws || ws.readyState !== WebSocket.OPEN) {

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
    if ((method === "agent" || method === "chat.send") && params) {
      this._approvalContext.noteUserMessage(params.sessionKey, params.message);
    }
    this.emit("protocol", {
      direction: "out",
      frame: sanitizeProtocolFrame(frame),
    });
    if (!this._isCurrentSocket(ws, gen)) return promise;
    ws.send(raw);

    if (method === "chat.send") {
      this._registerChatCommandRun(params);
      promise.catch(() => {
        if (!this._isCurrentSocket(ws, gen)) return;
        this._forgetChatCommandRun(params);
      });
    }
    return promise;
  }

  sendMessage(text, sessionKey, attachment) {
    const ws = this._ws;
    const generation = this._socketGeneration;
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
      if (!this._isCurrentSocket(ws, generation)) return result;
      const status = result && result.status;
      if (result && result.runId) {
        this._activeRunId = result.runId;
        this._rememberRunSessionKey(result.runId, key);
        this._logger.info(`[openclaw] Agent run accepted: ${result.runId}`);
      }
      return result;
    }).catch((err) => {
      if (!this._isCurrentSocket(ws, generation)) throw err;
      this._logger.error(`[openclaw] Agent request failed: ${err.message}`);
      this.emit("error", err);
      throw err;
    });
  }

  async fetchAgentIdentity(sessionKey) {
    const ws = this._ws;
    const generation = this._socketGeneration;
    const params = sessionKey ? { sessionKey } : {};
    const result = await this.request("agent.identity.get", params);
    if (!this._isCurrentSocket(ws, generation)) return result;
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
    this._runMediaUrls = [];
    this._runMessageIndex = 0;
    this._runItemId = null;
    this._runMessagePhase = null;
    this._gapDuringRun = false;
    this._seenThinkingSummaryIds.clear();
    this._seenThinkingFrameIds.clear();
    this._thinkingFrameBuffers.clear();
    this._thinkingStreamSegments.clear();
    this._commentaryByRun.clear();
    this._reasoningCueItemIds.clear();
    this._planRevisionByRun.clear();
    this._runRecordsPreambles.clear();
    this._runStreamedRecordTexts = [];
    this._runProgress = newRunProgress();
    this._liveThinkingRunIds.clear();
    this._clearHeldThinking();
    this._toolCallWrappers.clear();
    this._modelCalls.clear();
    this._modelCalls.beginRun(this._activeRunId);
    return this._activeRunGeneration;
  }

  _rememberRunSessionKey(runId     , sessionKey     ) {
    const id = normalizeRunId(runId);
    const key = normalizeSessionKey(sessionKey);
    if (!id || !key) return;
    const client      = this;
    const runSessionKeys = client._runSessionKeys;
    runSessionKeys.delete(id);
    runSessionKeys.set(id, key);
    while (runSessionKeys.size > RUN_SESSION_KEY_LIMIT) {
      runSessionKeys.delete(runSessionKeys.keys().next().value);
    }
  }

  _sessionKeyForRun(runId     , eventSessionKey     ) {
    const direct = normalizeSessionKey(eventSessionKey);
    if (direct) return direct;
    const client      = this;
    const id = normalizeRunId(runId);
    const known = id ? client._runSessionKeys.get(id) : null;
    return known || client._activeRunSessionKey;
  }

  _isBackgroundRun(runId     , sessionKey     ) {
    return isTitleDistillerRun(runId, sessionKey);
  }

  _invalidateActiveRun() {
    this._activeRunGeneration += 1;
    this._stopHistoryActivityPolling();
    this._activeRunId = null;
    this._activeRunSessionKey = null;
    this._activeRunStartedAtMs = null;
    this._runTextBuffer = "";
    this._runMediaUrls = [];
    this._runMessageIndex = 0;
    this._runItemId = null;
    this._runMessagePhase = null;
    this._gapDuringRun = false;
    this._seenThinkingSummaryIds.clear();
    this._seenThinkingFrameIds.clear();
    this._thinkingFrameBuffers.clear();
    this._thinkingStreamSegments.clear();
    this._commentaryByRun.clear();
    this._reasoningCueItemIds.clear();
    this._planRevisionByRun.clear();
    this._runRecordsPreambles.clear();
    this._runStreamedRecordTexts = [];
    this._runProgress = newRunProgress();
    this._liveThinkingRunIds.clear();
    this._clearHeldThinking();
    this._toolCallWrappers.clear();
    this._modelCalls.clear();
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

    if (!this._historyResolved || this._commitHold) {
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

  _isCurrentSocket(ws, generation) {
    return !this._stopped && ws === this._ws && generation === this._socketGeneration;
  }

  _connect() {
    if (this._stopped) return;

    const previous = this._ws;
    this._ws = null;
    this._flushPendingErrors(new Error("gateway connection replaced"));
    this._stopTickWatch();
    if (previous) {
      try { previous.close(); } catch {  }
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }

    this._clearEstablishTimer();

    this._connectNonce = null;
    this._connectSent = false;

    this._socketGeneration += 1;
    const generation = this._socketGeneration;

    this._timingLedger.clear("connect_reset");
    this._lastSeq = null;
    this._lastTick = null;
    this._historyResolved = false;
    this._eventQueue = [];

    this._commitHold = false;

    this._chatCommandRuns.clear();
    const runRouting      = this;
    runRouting._backgroundRunText.clear();
    this._invalidateActiveRun();

    const url = this._gatewayUrl;
    this.emit("status", "connecting");

    if (this._stopped || generation !== this._socketGeneration) return;
    this._logger.info(`[openclaw] Connecting to ${url}`);
    const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
    this._ws = ws;
    const isCurrent = () => this._isCurrentSocket(ws, generation);

    this._armEstablishTimer(ws);

    ws.on("open", () => {
      if (!isCurrent()) return;

      this._clearEstablishTimer();
      this._logger.info("[openclaw] WebSocket open, waiting for challenge...");

      this._connectTimer = setTimeout(() => {
        if (!isCurrent()) return;
        this._sendConnect();
      }, 750);
    });

    ws.on("message", (data) => {
      if (!isCurrent()) return;
      this._handleMessage(data.toString());
    });

    ws.on("close", (code, reason) => {
      if (!isCurrent()) return;
      const reasonText = reason ? reason.toString() : "";
      this._logger.info(`[openclaw] WebSocket closed: ${code} ${reasonText}`);
      this._ws = null;
      if (this._connectTimer) {
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
      }
      this._clearEstablishTimer();
      this._stopTickWatch();
      this._stopHistoryActivityPolling();
      this._timingLedger.clear("disconnect");
      this._flushPendingErrors(new Error(`gateway closed (${code}): ${reasonText}`));
      this.emit("disconnected", { code, reason: reasonText });
      if (this._stopped || generation !== this._socketGeneration) return;
      this.emit("status", "disconnected");

      if (!this._ws && generation === this._socketGeneration && !this._reconnectTimer) {
        this._scheduleReconnect();
      }
    });

    ws.on("error", (err) => {

      if (!isCurrent()) return;
      this._logger.error(`[openclaw] WebSocket error: ${err.message}`);
      if (!this._connectSent) {
        this.emit("error", err);
      }
    });
  }

  _armEstablishTimer(ws) {
    const establishGeneration = this._socketGeneration;
    const timer = setTimeout(() => {
      if (this._establishTimer !== timer || !this._isCurrentSocket(ws, establishGeneration)) {
        return;
      }
      this._establishTimer = null;
      this._logger.warn(
        `[openclaw] Connect establishment timeout (${ESTABLISH_TIMEOUT_MS}ms), terminating socket`
      );
      try {
        ws.terminate();
      } catch {

      }
    }, ESTABLISH_TIMEOUT_MS);
    this._establishTimer = timer;
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
    const ws = this._ws;
    const generation = this._socketGeneration;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this._logger.error(`[openclaw] Failed to parse message: ${err.message}`);
      return;
    }

    this.emit("protocol", {
      direction: "in",
      frame: sanitizeProtocolFrame(parsed),
    });
    if (!this._isCurrentSocket(ws, generation)) return;

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

        if (payload.runId && !isTitleDistillerRun(payload.runId, null)) {
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

        if (parsed.error && parsed.error.details !== undefined) {
          Object.assign(err, { details: parsed.error.details });
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
    const ws = this._ws;
    const generation = this._socketGeneration;

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
        if (!this._isCurrentSocket(ws, generation)) return;

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

    if (typeof evt.event === "string") {
      this.emit("gatewayEvent", { event: evt.event });
    }

    if (evt.event === "talk.event") {
      this.emit("talkEvent", evt.payload || null);
      return;
    }

    if (evt.event === "shutdown") {
      const payload = evt.payload || {};
      const restartMs = typeof payload.restartExpectedMs === "number" ? payload.restartExpectedMs : 5000;
      this._logger.info(`[openclaw] Gateway shutdown, reconnecting in ${restartMs}ms`);
      this.emit("status", "shutdown");
      if (!this._isCurrentSocket(ws, generation)) return;

      this._scheduleReconnect(restartMs);

      if (ws) {
        ws.close(1000, "shutdown");
      }
      return;
    }

    if (evt.event === "exec.approval.requested") {
      this.emit("approval", this._withApprovalContext(evt.payload));
      return;
    }

    if (evt.event === "exec.approval.resolved") {
      this.emit("approvalResolved", evt.payload);
      return;
    }

    if (evt.event === "plugin.approval.requested") {
      this.emit(
        "approval",
        this._withApprovalContext({ ...(evt.payload || {}), approvalKind: "plugin" }),
      );
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

      const recordsPreambles = isCommitEvent ? this._recordsPreamblesToRead(payload.runId) : [];

      if (isCommitEvent && recordsPreambles.length) this._runProgress.read = null;
      if (isCommitEvent && (!this._historyResolved || this._commitHold || recordsPreambles.length)) {

        const capturedCommit = {
          fullText: withMediaLines(this._runTextBuffer, this._runMediaUrls),
          activeRunId: this._activeRunId,
          activeRunSessionKey: this._activeRunSessionKey,
          gapDuringRun: this._gapDuringRun,
          runProgress: this._runProgress,
          ...(recordsPreambles.length ? { recordsPreambles } : {}),
        };
        if (!this._historyResolved || this._commitHold) {
          this._eventQueue.push({ payload: evt.payload, capturedCommit });
          return;
        }
        this._commitAgentEvent(evt.payload, capturedCommit);
        return;
      }
      this._handleAgentEvent(evt.payload);
      return;
    }
  }

  _withApprovalContext(payload     ) {
    if (!payload || typeof payload !== "object") return payload;
    return { ...payload, ocuclawApprovalContext: this._approvalContext.contextFor(payload) };
  }

  _handleAgentEvent(payload, capturedCommit) {
    if (!payload) return;

    const { runId, stream, data } = payload;

    const chatCommandEntry = this._chatCommandRuns.get(normalizeRunId(runId));
    if (chatCommandEntry) chatCommandEntry.agentOwned = true;
    if (!stream || !data) return;

    this._approvalContext.noteAgentEvent(runId, stream, data);

    if (stream === "lifecycle" && data.phase === "start") {
      this._rememberRunSessionKey(runId, payload.sessionKey);
    }
    const runSessionKey = this._sessionKeyForRun(runId, payload.sessionKey);
    if (this._isBackgroundRun(runId, runSessionKey)) {
      this._handleBackgroundRunEvent(runId, stream, data, runSessionKey);
      return;
    }

    this._modelCalls.observe(normalizeRunId(runId) || normalizeRunId(this._activeRunId), stream, data);

    switch (stream) {
      case "lifecycle":
        if (data.phase === "end" || data.phase === "error") {
          this._releaseHeldThinking(runId, false, "run_ended");
        }
        this._handleLifecycleEvent(runId, data, payload.sessionKey, capturedCommit);
        break;
      case "assistant":
        this._handleAssistantEvent(runId, data, runSessionKey);
        break;
      case "tool":
        this._noteThinkingBoundary(runId);
        this._handleToolEvent(runId, data, runSessionKey);
        break;
      case "thinking":
        this._handleThinkingStreamEvent(runId, data, runSessionKey);
        break;
      case "item":
        this._noteThinkingBoundary(runId);

        if (isObject(data) && RELEASES_HELD_SUMMARY_ITEM_KINDS.has(data.kind)) {
          this._releaseHeldThinking(runId, true, `item_${data.kind}`);
        }
        this._noteRecordsPreamble(runId, data, runSessionKey);
        this._handleCommentaryItemEvent(runId, data, runSessionKey);
        this._handleAnalysisItemEvent(runId, data, runSessionKey);
        break;
      case "plan":
        this._handlePlanStreamEvent(runId, data, runSessionKey);
        break;
      case "compaction":
      case "run_status": {
        const client      = this;
        const signal = client._runSignals.fromAgentEvent(runId, stream, data, runSessionKey);
        if (signal) client.emit("runSignal", signal);
        break;
      }
      case "error":
        if (isGatewaySeqGapNotice(data)) {

          this._logger.warn(`[openclaw] Gateway seq gap on run ${runId || "?"}: ${JSON.stringify(data)}`);
          break;
        }
        this._logger.error(`[openclaw] Agent error: ${JSON.stringify(data)}`);
        {
          const terminalActivity = buildTerminalErrorActivity(
            data,
            runId || this._activeRunId,
            runSessionKey,
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

        const bufferedText = capturedCommit ? capturedCommit.fullText : withMediaLines(this._runTextBuffer, this._runMediaUrls);
        const completedRunId = normalizeRunId(committedActiveRunId) || normalizeRunId(runId);

        const declinedToolRunsOwner      = this;
        const declinedFallback = declinedToolRunsOwner._declinedToolRuns.takeFallback(completedRunId, bufferedText);
        const replyText = declinedFallback || bufferedText;

        const progressRecords =
          capturedCommit && Array.isArray(capturedCommit.progressRecords)
            ? capturedCommit.progressRecords
            : [];

        const runProgress = capturedCommit ? capturedCommit.runProgress || null : this._runProgress;
        const paintedProgress = runProgress
          ? [...runProgress.messages.values()].map((message     ) => message.text).filter(Boolean)
          : [];
        const liveUiText = progressRecords.length
          ? [...progressRecords, replyText].filter(Boolean).join("\n\n")
          : replyText;
        const fullText = paintedProgress.length
          ? [...progressRecords, ...paintedProgress, replyText].filter(Boolean).join("\n\n")
          : liveUiText;
        const openProgress = runProgress && runProgress.holdsIndex && !runProgress.holdsIndex.ended
          ? runProgress.holdsIndex
          : null;
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

        if (openProgress) {
          openProgress.ended = true;
          this.emit("streaming", {
            text: openProgress.text,
            messageIndex: openProgress.index,
            messageId: openProgress.messageId,
            sessionKey: completedSessionKey,
            runId: completedRunId,
            liveUiRecordsOnly: true,
            end: true,
            gatewayReceivedAtMs: Date.now(),
          });
        }
        this.emit("message", {
          runId: completedRunId,
          role: "assistant",
          content: [{ type: "text", text: fullText }],
          ...(paintedProgress.length ? { liveUiText } : {}),
          sessionKey: completedSessionKey,

          finalReplyCommitted: commitIsLiveActiveRun && !!completedRunId &&
            normalizeRunId(runId) === completedRunId && !!completedSessionKey &&
            normalizeSessionKey(committedActiveRunSessionKey) === completedSessionKey,
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
        const historyGuardOwner      = this;
        const idleRunGeneration = historyGuardOwner._activeRunGeneration;
        const rehydrate = () => this._fetchHistory(completedSessionKey || "main", {
          idleRunGeneration,

          commitRunId: completedRunId,
          commitText: fullText,
        });
        function onRehydrateError(err     ) {
          historyGuardOwner._logger.error(
            `[openclaw] Post-commit history fetch failed: ${err.message}`
          );
        }
        if (declinedFallback && completedSessionKey) {

          historyGuardOwner.request("chat.inject", { sessionKey: completedSessionKey, message: declinedFallback })
            .then(
              () => historyGuardOwner._logger.info(`[openclaw] Declined-command fallback reply sent: ${completedRunId}`),
              (err) => historyGuardOwner._logger.warn(
                `[openclaw] Declined-command fallback inject failed: ${err && err.message}`,
              ),
            )
            .then(rehydrate)
            .catch(onRehydrateError);
        } else {
          rehydrate().catch(onRehydrateError);
        }
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

  _handleBackgroundRunEvent(runId     , stream     , data     , sessionKey     ) {
    const client      = this;
    const id = normalizeRunId(runId);
    if (!id) return;
    if (stream === "assistant") {
      const text = cumulativeAssistantText(
        data,
        client._backgroundRunText.get(id) || "",
        null,
      );
      if (text === null) return;
      client._backgroundRunText.set(id, text);
      client.emit("streaming", {
        text,
        sessionKey,
        runId: id,
        gatewayReceivedAtMs: Date.now(),
        rawAssistantChars: text.length,
      });
      return;
    }
    if (stream !== "lifecycle") return;
    if (data.phase === "start") {
      client._backgroundRunText.set(id, "");
      client.emit("activity", {
        state: "thinking",
        sessionKey,
        runId: id,
        origin: "lifecycle",
        phase: "start",
      });
      return;
    }
    if (data.phase === "end") {
      const fullText = client._backgroundRunText.get(id) || "";
      client._backgroundRunText.delete(id);
      client._runSessionKeys.delete(id);
      client._timingLedger.recordRunTerminal({ runId: id });
      client.emit("message", {
        runId: id,
        role: "assistant",
        content: [{ type: "text", text: fullText }],
        sessionKey,
        finalReplyCommitted: false,
      });
      client.emit("activity", {
        state: "idle",
        sessionKey,
        runId: id,
        origin: "lifecycle",
        phase: "end",
      });
      return;
    }
    if (data.phase === "error") {
      client._backgroundRunText.delete(id);
      client._runSessionKeys.delete(id);
      client._timingLedger.recordRunTerminal({ runId: id });
      client._logger.warn(`[openclaw] Background run error: ${JSON.stringify(data)}`);
      const terminalActivity = buildTerminalErrorActivity(
        data,
        id,
        sessionKey,
        "agent_lifecycle_error",
      );
      if (terminalActivity.sessionKey) client.emit("activity", terminalActivity);
    }
  }

  _handleAssistantEvent(runId, data, sessionKey = this._activeRunSessionKey) {
    this._emitThinkingActivityFromPayload(
      runId,
      sessionKey,
      data,
      "assistant_event",
      { modelCallSeq: this._modelCalls.current(normalizeRunId(runId) || normalizeRunId(this._activeRunId)) },
    );

    const phase = assistantMessagePhase(data);
    const afterCommentary = this._runMessagePhase === "commentary" && phase !== "commentary";

    const afterProgress = this._runProgress.holdsIndex !== null;

    if (phase === "commentary") this._runProgress.streamedAsReply = true;

    const text = cumulativeAssistantText(
      data,
      this._runTextBuffer,
      this._runItemId,
      (afterCommentary && phase !== null) || afterProgress,
    );
    if ((text === null || (text === "" && data.replace !== true)) && phase !== "commentary") {
      noteMediaUrls(this._runMediaUrls, data);
    }
    if (text !== null) {

      if (text === "" && data.replace !== true) return;
      if (phase !== "commentary") this._releaseHeldThinking(runId, false, "reply_started");
      const previousText = this._runTextBuffer;
      const previousTextLength = previousText.length;
      const gatewayReceivedAtMs = Date.now();
      const rawAssistantChars = text.length;
      const assistantDeltaChars = Math.max(0, rawAssistantChars - previousTextLength);
      const firstGatewayChunk = previousTextLength <= 0;

      const itemId =
        typeof data.itemId === "string" && data.itemId.trim()
          ? data.itemId.trim()
          : null;
      const leavesCommentary =
        afterCommentary &&
        (phase !== null || data.replace === true || !text.startsWith(previousText));
      const newMessage = afterProgress || leavesCommentary || (itemId && this._runItemId
        ? itemId !== this._runItemId
        : previousTextLength > 0 &&
          data.replace !== true &&
          !text.startsWith(previousText));
      if (newMessage) {
        if (previousText.includes("<ui")) this._runStreamedRecordTexts.push(collapseWhitespace(previousText));
        this._runMediaUrls = [];
        this._runMessageIndex += 1;
        this._runMessagePhase = null;
        this._runProgress.holdsIndex = null;
      }

      if (itemId || leavesCommentary || afterProgress) this._runItemId = itemId;
      if (phase === "commentary") this._runMessagePhase = "commentary";
      if (phase !== "commentary") noteMediaUrls(this._runMediaUrls, data);
      this._runTextBuffer = text;
      this.emit("streaming", {
        text,
        messageIndex: this._runMessageIndex,
        sessionKey,
        runId: runId || this._activeRunId || null,
        gatewayReceivedAtMs,
        rawAssistantChars,
        assistantDeltaChars,
        firstGatewayChunk,
      });
    }
  }

  _unwrapToolCallEvent(runId     , data     , isToolStart         , isToolEnd         )      {
    const runKey = normalizeRunId(runId) || normalizeRunId(this._activeRunId) || "__global__";
    const toolCallId =
      typeof data.toolCallId === "string" && data.toolCallId.trim() ? data.toolCallId.trim() : null;
    if (data.name !== TOOL_CALL_WRAPPER_NAME) {
      const parentId =
        typeof data.parentToolCallId === "string" && data.parentToolCallId.trim()
          ? data.parentToolCallId.trim()
          : null;
      const silent = !!parentId && !!this._toolCallWrappers.get(`${runKey}:${parentId}`);
      return { data, silent };
    }
    const wrapperKey = toolCallId ? `${runKey}:${toolCallId}` : null;
    let inner               ;
    if (isToolStart) {
      inner = wrappedToolName(data.args);
      if (wrapperKey) {
        this._toolCallWrappers.set(wrapperKey, inner);
        while (this._toolCallWrappers.size > TOOL_CALL_WRAPPER_LIMIT) {
          this._toolCallWrappers.delete(this._toolCallWrappers.keys().next().value);
        }
      }
    } else {
      inner = wrapperKey ? this._toolCallWrappers.get(wrapperKey) || null : null;
      if (isToolEnd && wrapperKey) this._toolCallWrappers.delete(wrapperKey);
    }
    if (!inner) return { data, silent: true };
    const unwrapped      = { ...data, name: inner };
    if (isToolStart) {
      const innerArgs = isObject(data.args) && isObject(data.args.args) ? data.args.args : null;
      if (innerArgs) unwrapped.args = innerArgs;
      else delete unwrapped.args;
    }
    return { data: unwrapped, silent: false };
  }

  _handleToolEvent(runId     , rawData     , sessionKey      = this._activeRunSessionKey) {
    if (!rawData || !rawData.name) return;
    const rawPhase = typeof rawData.phase === "string" ? rawData.phase.trim().toLowerCase() : "";
    if (rawPhase !== "start" && rawPhase !== "update" && rawPhase !== "result") return;
    const isToolStart = rawPhase === "start";
    const isToolEnd = rawPhase === "result";
    this._releaseHeldThinking(runId, true, "tool");
    const unwrapped = this._unwrapToolCallEvent(runId, rawData, isToolStart, isToolEnd);
    const data = unwrapped.data;
    if (isToolStart) this._settleProgressRecordsAtTool(runId, data, sessionKey);
    if (unwrapped.silent) {
      if (isToolEnd) {
        const declinedToolRunsOwner      = this;
        declinedToolRunsOwner._declinedToolRuns.noteToolEnd(normalizeRunId(runId || this._activeRunId), {
          tool: data.name,
          isError: data.isError === true,
          status: data.status,
        });
      }
      return;
    }

    if (isToolStart && this._runMessagePhase !== "commentary" && this._runTextBuffer) {
      const proseRunId = normalizeRunId(runId) || normalizeRunId(this._activeRunId);
      const proseKey = `${proseRunId || "run"}:${this._runMessageIndex}:${this._runTextBuffer.length}`;
      if (this._preToolProseKey !== proseKey) {
        this._preToolProseKey = proseKey;
        const visible = stripDisplayMarkup(this._runTextBuffer).replace(/`/g, "").replace(/\s+/g, " ").trim();
        this._emitPreToolProse(proseRunId, sessionKey, visible.slice(-600), "last");
      }
    }

    const rawArgs = isObject(data.args) ? data.args : null;
    const pathFromData =
      typeof data.path === "string" && data.path.trim() && !isNullishToken(data.path)
        ? data.path.trim()
        : null;
    const pathFromArgs = pickStringPathFromArgs(rawArgs) || pickPatchPath(rawArgs);
    const path = pathFromData || pathFromArgs || null;
    const args = rawArgs ? stripPatchBodies(rawArgs) : null;

    const activity = {
      state: "thinking",
      tool: data.name,
      sessionKey,
      runId: runId || this._activeRunId || null,
      origin: "tool",
      phase: isToolStart ? "start" : "update",
      toolPhase: isToolEnd ? "end" : "start",
    };

    if (args) activity.args = args;
    if (path) activity.path = path;

    if (isToolStart && typeof data.meta === "string" && data.meta.trim()) {
      (activity       ).meta = data.meta.trim();
    }
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

    const modelCallSeq = positiveModelCallSeq(this._modelCalls.forTool(
      normalizeRunId(activity.runId),
      (activity       ).toolCallId,
      isToolStart ? "start" : isToolEnd ? "end" : "update",
    ));
    if (modelCallSeq !== null) (activity       ).modelCallSeq = modelCallSeq;
    if (isToolEnd) {

      const declinedToolRunsOwner      = this;
      declinedToolRunsOwner._declinedToolRuns.noteToolEnd(normalizeRunId(activity.runId), {
        tool: data.name,
        isError: data.isError === true,
        status: data.status,
      });
    }

    this.emit("activity", activity);
  }

  _startHistoryActivityPolling() {
    this._stopHistoryActivityPolling();
    if (!this._activeRunId || !this._activeRunSessionKey) return;

    const ws = this._ws;
    const generation = this._socketGeneration;
    const poll = () => {
      if (!this._isCurrentSocket(ws, generation)) return;
      this._pollHistoryActivity().catch((err) => {
        if (!this._isCurrentSocket(ws, generation)) return;

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
    const ws = this._ws;
    const generation = this._socketGeneration;
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
      if (!this._isCurrentSocket(ws, generation)) return;
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

  _handleThinkingStreamEvent(runId, data, sessionKey = this._activeRunSessionKey) {
    if (!isObject(data)) return;

    const normalizedRunId =
      normalizeRunId(runId) || normalizeRunId(this._activeRunId);
    const segmentKey = normalizedRunId || "__global__";

    const gatewayText =
      typeof data.text === "string" && data.text.trim() ? data.text : null;
    const gatewayDelta = typeof data.delta === "string" && data.delta ? data.delta : null;
    if (!gatewayText && !gatewayDelta) return;
    const itemId = typeof data.itemId === "string" && data.itemId.trim() ? data.itemId.trim() : null;

    const state = this._thinkingStreamSegments.get(segmentKey) || newThinkingStreamSegment();
    if (state.raw) {
      let retire = false;
      if (itemId) {
        retire = itemId !== state.itemId;
      } else if (state.boundary) {

        retire = !(gatewayText && gatewayText.length > state.raw.length && gatewayText.startsWith(state.raw));
      }
      if (retire) {
        state.base = joinThinkingSegments(state.base, asSummaryTitle(state.raw, state.events));
        state.raw = "";
        state.events = 0;
        state.ordinal += 1;
      }
    }
    state.boundary = false;
    if (itemId) state.itemId = itemId;

    if (gatewayText) {
      if (!state.raw || gatewayText.startsWith(state.raw)) {

        if (gatewayText !== state.raw) state.events += 1;
        state.raw = gatewayText;
      } else if (state.raw.startsWith(gatewayText)) {

      } else if (state.itemId) {

        state.raw = gatewayText;
        state.events += 1;
      } else {

        state.base = joinThinkingSegments(state.base, asSummaryTitle(state.raw, state.events));
        state.raw = gatewayText;
        state.events = 1;
        state.ordinal += 1;
      }
    } else {

      state.raw = `${state.raw}${gatewayDelta}`;
      state.events += 1;
    }
    this._thinkingStreamSegments.set(segmentKey, state);

    const segmentText = asSummaryTitle(state.raw, state.events);
    const cumulativeRaw = joinThinkingSegments(state.base, segmentText);
    if (!cumulativeRaw.trim() || !String(segmentText || "").trim()) return;

    if (normalizedRunId) {
      this._liveThinkingRunIds.add(normalizedRunId);
    }

    const payload      = {
      thinking: sliceFromLastClosedBoldSegment(segmentText) || segmentText,
    };
    if (data.thinkingSignature) payload.thinkingSignature = data.thinkingSignature;
    const segment = `seg${state.ordinal}`;

    const modelCallSeq = this._modelCalls.current(normalizedRunId);
    this._holdThinkingSummary(normalizedRunId, () =>
      this._emitThinkingActivityFromPayload(
        normalizedRunId,
        sessionKey,
        payload,
        "thinking_stream",
        { frameText: cumulativeRaw, segment, modelCallSeq },
      ),
    );
  }

  _noteThinkingBoundary(runId     ) {
    const key = normalizeRunId(runId) || normalizeRunId(this._activeRunId) || "__global__";
    const state = this._thinkingStreamSegments.get(key);
    if (state && state.raw) state.boundary = true;
  }

  _holdThinkingSummary(runId     , emit            ) {
    if (!(this._lateSummaryHoldMs > 0)) {
      emit();
      return;
    }
    const key = normalizeRunId(runId) || "__global__";
    const held = this._heldThinking.get(key);
    if (held) {
      held.emit = emit;
      return;
    }
    const entry      = { emit, heldAtMs: Date.now(), timer: null };
    entry.timer = setTimeout(
      () => this._releaseHeldThinking(key, true, "hold_elapsed"),
      this._lateSummaryHoldMs,
    );
    this._heldThinking.set(key, entry);
  }

  _releaseHeldThinking(runId     , show         , reason        ) {
    const key = normalizeRunId(runId) || normalizeRunId(this._activeRunId) || "__global__";
    const held = this._heldThinking.get(key);
    if (!held) return;
    this._heldThinking.delete(key);
    clearTimeout(held.timer);
    this._logger.info(
      `[openclaw] reasoning summary ${show ? "shown" : "dropped"} (${reason}, held ${
        Date.now() - held.heldAtMs
      } ms)`,
    );
    if (show) held.emit();
  }

  _clearHeldThinking() {
    for (const held of this._heldThinking.values()) clearTimeout(held.timer);
    this._heldThinking.clear();
  }

  _noteRecordsPreamble(runId     , data     , sessionKey      = this._activeRunSessionKey) {
    if (!isObject(data) || data.kind !== "preamble" || typeof data.progressText !== "string") return;
    const activeRunId = normalizeRunId(this._activeRunId);
    const id = normalizeRunId(runId);
    if (!activeRunId || (id && id !== activeRunId)) return;
    const progress = this._runProgress;
    if (data.progressText.includes("\n")) progress.keepsLines = true;
    const itemId = typeof data.itemId === "string" ? data.itemId.trim() : "";
    if (progress.messages.has(itemId)) {
      this._paintProgressRecords(activeRunId, itemId, data.progressText, sessionKey, data.phase === "end");
      return;
    }
    if (!data.progressText.includes("<ui")) return;
    if (progress.keepsLines && !progress.streamedAsReply) {
      this._runRecordsPreambles.delete(itemId);
      this._paintProgressRecords(activeRunId, itemId, data.progressText, sessionKey, data.phase === "end");
      return;
    }
    this._runRecordsPreambles.set(itemId, data.progressText);
  }

  _paintProgressRecords(runId     , itemId        , text        , sessionKey     , end = false) {
    const progress = this._runProgress;
    let message = progress.messages.get(itemId);
    if (!message) {
      this._runMessageIndex += 1;
      message = {
        index: this._runMessageIndex,
        messageId: `progress:${itemId || this._runMessageIndex}`,
        text: "",
        ended: false,
      };
      progress.messages.set(itemId, message);
      progress.holdsIndex = message;
    }
    if (message.ended || (!end && message.text === text)) return;
    message.text = text;
    message.ended = end;
    this.emit("streaming", {
      text,
      messageIndex: message.index,
      messageId: message.messageId,
      sessionKey,
      runId,
      liveUiRecordsOnly: true,
      ...(end ? { end: true } : {}),
      gatewayReceivedAtMs: Date.now(),
    });
  }

  _owedRecordsPreambles()                     {
    if (!this._runRecordsPreambles.size) return [];
    const streamed = [...this._runStreamedRecordTexts, collapseWhitespace(this._runTextBuffer)];
    return [...this._runRecordsPreambles.entries()].filter(
      ([, text]) => !streamed.some((messageText) => messageText.includes(collapseWhitespace(text))),
    );
  }

  _recordsPreamblesToRead(runId     ) {
    if (!this._runRecordsPreambles.size) return [];
    const activeRunId = normalizeRunId(this._activeRunId);
    const id = normalizeRunId(runId);
    if (!activeRunId || (id && id !== activeRunId)) return [];
    return this._owedRecordsPreambles().map(([, text]) => text);
  }

  _settleProgressRecordsAtTool(runId     , data     , sessionKey     ) {
    const activeRunId = normalizeRunId(this._activeRunId);
    const id = normalizeRunId(runId);
    if (!activeRunId || (id && id !== activeRunId)) return;
    const owed = this._owedRecordsPreambles();
    if (!owed.length) return;
    const args = isObject(data.args) ? data.args : null;
    if (data.name === COMPOSE_TOOL_NAME && args && typeof args.records === "string" && args.records.trim()) {
      for (const [itemId] of owed) this._runRecordsPreambles.delete(itemId);
      this._logger.info(`[openclaw] ${owed.length} LiveUI progress text(s) left to the compose call's records`);
      return;
    }
    const progress = this._runProgress;
    if (progress.read) return;
    const read = {};
    progress.read = read;
    const generation = this._activeRunGeneration;
    const index = this._runMessageIndex;
    const buffer = this._runTextBuffer;
    this._readProgressTexts(sessionKey, owed.map(([, text]) => text))
      .then((found) => {
        if (progress.read !== read || this._activeRunGeneration !== generation) return;
        progress.read = null;

        if (this._runMessageIndex !== index || this._runTextBuffer !== buffer) return;
        owed.forEach(([itemId], i) => {
          const text = found[i];
          if (!text || !this._runRecordsPreambles.has(itemId)) return;
          this._runRecordsPreambles.delete(itemId);
          this._paintProgressRecords(activeRunId, itemId, text, sessionKey, true);
        });
      })
      .catch((err     ) => {
        this._logger.debug(
          `[openclaw] Progress text read at tool start failed: ${err && err.message ? err.message : String(err)}`
        );
      });
  }

  _commitAgentEvent(payload     , capturedCommit     ) {
    const preambles = capturedCommit && capturedCommit.recordsPreambles;
    if (!Array.isArray(preambles) || !preambles.length || Array.isArray(capturedCommit.progressRecords)) {
      this._handleAgentEvent(payload, capturedCommit);
      return true;
    }
    const ws = this._ws;
    const generation = this._socketGeneration;
    const sessionKey =
      normalizeSessionKey(payload.sessionKey) ||
      normalizeSessionKey(capturedCommit.activeRunSessionKey);
    this._commitHold = true;
    this._readProgressRecords(sessionKey, preambles)
      .then((progressRecords) => {
        if (!this._isCurrentSocket(ws, generation)) return;
        this._commitHold = false;
        try {
          this._handleAgentEvent(payload, { ...capturedCommit, progressRecords });
        } finally {
          if (this._historyResolved) this._drainEventQueue();
        }
      })
      .catch((err     ) => {
        this._logger.error(
          `[openclaw] Commit after progress read failed: ${err && err.message ? err.message : String(err)}`
        );
      });
    return false;
  }

  async _readProgressRecords(sessionKey     , preambles          ) {
    const found = await this._readProgressTexts(sessionKey, preambles);
    const texts = found.filter((text)                 => typeof text === "string");
    if (texts.length < preambles.length) {
      this._logger.warn(
        `[openclaw] ${preambles.length - texts.length} of ${preambles.length} LiveUI progress texts ` +
          `not in history for session ${sessionKey}; committing without them`
      );
    } else {
      this._logger.info(`[openclaw] Read ${texts.length} LiveUI progress text(s) back from history`);
    }
    return texts;
  }

  async _readProgressTexts(sessionKey     , preambles          )                             {
    if (!sessionKey) return preambles.map(() => null);
    const ws = this._ws;
    const generation = this._socketGeneration;
    const deadline = Date.now() + PROGRESS_RECORDS_READ_BUDGET_MS;
    let found                    = preambles.map(() => null);
    for (;;) {
      try {
        const result      = await beforeDeadline(
          this.request("chat.history", { sessionKey, limit: PROGRESS_RECORDS_HISTORY_LIMIT }, undefined),
          deadline,
        );
        found = findProgressTexts(result && result.messages, preambles, found);
      } catch (err     ) {
        this._logger.debug(
          `[openclaw] Progress text read failed: ${err && err.message ? err.message : String(err)}`
        );
      }
      if (!this._isCurrentSocket(ws, generation)) return preambles.map(() => null);
      if (found.every(Boolean)) break;
      if (Date.now() + PROGRESS_RECORDS_READ_RETRY_MS >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, PROGRESS_RECORDS_READ_RETRY_MS));
    }
    return found;
  }

  _handleCommentaryItemEvent(runId     , data     , sessionKey      = this._activeRunSessionKey) {
    if (!isObject(data) || data.kind !== "preamble") return;

    const feelings =
      typeof data.progressText === "string" ? speckFeelings(data.progressText) : [];
    const text =
      typeof data.progressText === "string"
        ? stripDisplayMarkup(data.progressText).replace(/`/g, "").replace(/\s+/g, " ").trim()
        : "";

    const note = data.phase === "end" ? text : finishedSentences(text);
    if (!note) return;

    const normalizedRunId =
      normalizeRunId(runId) || normalizeRunId(this._activeRunId);
    const runKey = normalizedRunId || "__global__";
    const noteId =
      typeof data.itemId === "string" && data.itemId.trim()
        ? data.itemId.trim()
        : `${runKey}:commentary`;
    const previous = this._commentaryByRun.get(runKey);
    const feelingKey = feelings.join(",");
    if (
      previous &&
      previous.noteId === noteId &&
      previous.note === note &&
      previous.feelingKey === feelingKey
    ) {
      return;
    }
    this._commentaryByRun.set(runKey, { noteId, note, feelingKey });

    this.emit("thinking", {
      phase: "update",
      sessionKey:
        normalizeSessionKey(sessionKey) || normalizeSessionKey(this._activeRunSessionKey),
      runId: normalizedRunId,
      text: note,
      delta: note,
      presentation: "progress_note",
      progressNoteId: noteId,
      ...(feelings.length ? { speckFeelings: feelings } : {}),
      source: "commentary",
    });
    this._emitPreToolProse(normalizedRunId, sessionKey, note);
  }

  _emitPreToolProse(runId     , sessionKey     , text     , pick      = "first") {
    if (typeof text !== "string" || !text.trim()) return;
    const client      = this;
    const modelCallSeq = positiveModelCallSeq(this._modelCalls.current(runId));
    client.emit("activity", {
      state: "thinking",
      sessionKey:
        normalizeSessionKey(sessionKey) || normalizeSessionKey(this._activeRunSessionKey),
      runId: runId || null,
      origin: "narration",
      phase: "update",
      summary: text.length > 600 ? text.slice(0, 600) : text,

      prosePick: pick === "last" ? "last" : "first",
      ...(modelCallSeq === null ? {} : { modelCallSeq }),
    });
  }

  _handleAnalysisItemEvent(runId     , data     , sessionKey      = this._activeRunSessionKey) {
    if (!isObject(data) || data.kind !== "analysis" || data.phase !== "start") return;
    const normalizedRunId = normalizeRunId(runId) || normalizeRunId(this._activeRunId);
    const itemId = typeof data.itemId === "string" && data.itemId.trim() ? data.itemId.trim() : null;
    if (itemId) {
      const cueKey = `${normalizedRunId || "run"}:${itemId}`;
      if (this._reasoningCueItemIds.has(cueKey)) return;
      this._reasoningCueItemIds.add(cueKey);
    }
    const client      = this;
    const modelCallSeq = positiveModelCallSeq(this._modelCalls.current(normalizedRunId));
    client.emit("activity", {
      state: "thinking",
      sessionKey:
        normalizeSessionKey(sessionKey) || normalizeSessionKey(this._activeRunSessionKey),
      runId: normalizedRunId || null,
      origin: "thinking",
      phase: "update",
      summary: REASONING_CUE_LABEL,
      thinkingSummarySource: "generic",
      ...(modelCallSeq === null ? {} : { modelCallSeq }),
    });
  }

  _handlePlanStreamEvent(runId     , data     , sessionKey      = this._activeRunSessionKey) {
    const normalizedRunId = normalizeRunId(runId) || normalizeRunId(this._activeRunId);
    const runKey = normalizedRunId || "__global__";
    const revision = (this._planRevisionByRun.get(runKey) || 0) + 1;
    const plan = buildActivityPlan(data, revision);
    if (!plan) return;
    this._planRevisionByRun.set(runKey, revision);
    const client      = this;
    const modelCallSeq = positiveModelCallSeq(this._modelCalls.current(normalizedRunId));
    client.emit("activity", {
      state: "thinking",
      sessionKey:
        normalizeSessionKey(sessionKey) || normalizeSessionKey(this._activeRunSessionKey),
      runId: normalizedRunId || null,
      origin: "plan",
      phase: "update",
      plan,
      ...(modelCallSeq === null ? {} : { modelCallSeq }),
    });
  }

  _emitThinkingActivityFromPayload(runId     , sessionKey     , rawPayload     , source = "unknown", options      = {}) {
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
        authoritativeFrameText ? options.frameText : null,
      );
      if (emittedFrame && frameDedupeKey) {
        this._seenThinkingFrameIds.add(frameDedupeKey);
      }
    }

    const dedupeSeed = extracted.signatureId || hashThinkingKey(extracted.label);
    const segment = options && typeof options.segment === "string" ? options.segment : null;
    const dedupeKey = segment
      ? `${normalizedRunId || "run"}:${segment}:${dedupeSeed}`
      : `${normalizedRunId || "run"}:${dedupeSeed}`;
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

    const modelCallSeq = positiveModelCallSeq(options && options.modelCallSeq);
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
      ...(modelCallSeq === null ? {} : { modelCallSeq }),
    });
  }

  _emitThinkingFrameUpdate(runId, sessionKey, extracted, source, authoritativeText      = null) {
    const normalizedRunId = normalizeRunId(runId);
    const normalizedSessionKey = normalizeSessionKey(sessionKey);
    const detail = normalizeThinkingText(extracted && extracted.detail);

    const authoritative =
      typeof authoritativeText === "string" && authoritativeText.trim()
        ? authoritativeText.trim()
        : null;
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
    if (this._stopped || !this._ws) return;
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
    const ws = this._ws;
    const isCurrent = () => this._isCurrentSocket(ws, connectGeneration);

    this.request("connect", params)
      .then((helloOk) => {
        if (!isCurrent()) return;
        this._logger.info(
          `[openclaw] Connected! protocol=${helloOk.protocol}, ` +
            `tick=${helloOk.policy && helloOk.policy.tickIntervalMs}ms`
        );

        this._backoffMs = 1000;

        this._applyConnectPolicy(helloOk.policy);
        this._applySessionDefaults(helloOk.snapshot && helloOk.snapshot.sessionDefaults);
        this._helloFeatures = helloFeaturesFrom(helloOk);

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
        if (!isCurrent()) return;
        this.emit("status", "connected");
        if (!isCurrent()) return;

        this._postConnect().catch((err) => {
          if (!isCurrent()) return;
          this._logger.error(`[openclaw] Post-connect setup failed: ${err.message}`);
          this.emit("error", err);
        });
      })
      .catch((err) => {
        if (!isCurrent()) return;

        const reason = sanitizeConnectReason(err && err.message);
        this._logger.error(`[openclaw] Connect failed: ${reason}`);

        if (canFallback) {
          this._logger.info(
            "[openclaw] Clearing cached device token, will use gateway token on next connect"
          );
          this._deviceToken = null;
          clearDeviceToken(this._persistencePaths);
        }

        this.emit("connectFailed", {
          reason,
          minProtocol: MIN_PROTOCOL_VERSION,
          maxProtocol: MAX_PROTOCOL_VERSION,
        });

        const safeErr      = new Error(reason);
        if (err && err.code != null) safeErr.code = err.code;
        this.emit("error", safeErr);
        if (isCurrent()) {
          ws.close(1008, "connect failed");
        }
      });
  }

  async _postConnect() {
    const ws = this._ws;
    const generation = this._socketGeneration;

    this.fetchAgentIdentity().catch((err) => {
      if (!this._isCurrentSocket(ws, generation)) return;
      this._logger.error(`[openclaw] Agent identity fetch failed: ${err.message}`);
    });
    if (!this._isCurrentSocket(ws, generation)) return;

    try {
      await this._fetchHistory("main");
    } catch (err) {
      if (!this._isCurrentSocket(ws, generation)) return;
      this._logger.error(`[openclaw] Chat history fetch failed: ${err.message}`);
    }

    if (!this._isCurrentSocket(ws, generation)) return;
    this._historyResolved = true;
    this._drainEventQueue();
  }

  async _fetchHistory(sessionKey, options      = {}) {
    const ws = this._ws;
    const generation = this._socketGeneration;
    const result = await this.request("chat.history", {
      sessionKey,
      limit: 200,
    });
    if (!this._isCurrentSocket(ws, generation)) return result;

    if (Number.isFinite(options.idleRunGeneration)) {
      const historyResult      = result;
      const historyGuardOwner      = this;
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

    const messages = projectOpenClawConversationHistory(
      result && Array.isArray(result.messages) ? result.messages : [],
    );

    const echoedSessionKey = (result && result.sessionKey) || sessionKey;
    this._logger.info(
      `[openclaw] Chat history loaded: ${messages.length} messages ` +
        `(requested=${sessionKey} answered=${echoedSessionKey}` +
        `${normalizeSessionKey(sessionKey) === normalizeSessionKey(echoedSessionKey) ? "" : " KEY_MISMATCH"})`
    );

    this.emit("history", {
      sessionKey: echoedSessionKey,
      messages,

      ...(normalizeRunId(options.commitRunId) && typeof options.commitText === "string"
        ? { commitRunId: normalizeRunId(options.commitRunId), commitText: options.commitText }
        : {}),
    });

    return result;
  }

  _drainEventQueue() {

    if (this._commitHold) return;
    const ws = this._ws;
    const generation = this._socketGeneration;
    const queue = this._eventQueue;
    this._eventQueue = [];
    for (let index = 0; index < queue.length; index += 1) {
      const evt = queue[index];
      if (!this._isCurrentSocket(ws, generation)) return;

      if (evt && evt.chatCommit) {
        this._commitChatCommandRun(evt.chatCommit);
        continue;
      }
      if (!this._commitAgentEvent(evt.payload, evt.capturedCommit)) {

        this._eventQueue = queue.slice(index + 1).concat(this._eventQueue);
        return;
      }
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
    const generation = this._socketGeneration;
    const timer = setTimeout(() => {
      if (this._stopped || generation !== this._socketGeneration || this._reconnectTimer !== timer) return;
      this._reconnectTimer = null;
      this.start();
    }, delay);
    this._reconnectTimer = timer;

    if (this._reconnectTimer.unref) {
      this._reconnectTimer.unref();
    }
  }

  _applySessionDefaults(sessionDefaults     ) {

    this._agentSelectionRequiredLatched = false;
    if (!sessionDefaults || typeof sessionDefaults !== "object") {
      this._sessionDefaults = null;
      return;
    }
    const defaultAgentId =
      typeof sessionDefaults.defaultAgentId === "string"
        ? sessionDefaults.defaultAgentId.trim()
        : "";
    this._sessionDefaults = {
      defaultAgentId,
      ownership:
        typeof sessionDefaults.ownership === "string" ? sessionDefaults.ownership : null,
      selectionRequired: sessionDefaults.selectionRequired === true,
    };
    if (this._sessionDefaults.selectionRequired) {
      this._logger.info(
        `[openclaw] Gateway requires explicit agent ownership; default agent=${defaultAgentId || "(none)"}`
      );
    }
  }

  _applyConnectPolicy(policy) {
    if (policy && typeof policy.tickIntervalMs === "number") {
      this._tickIntervalMs = Math.min(policy.tickIntervalMs, TICK_WATCH_MAX_INTERVAL_MS);
    }
  }

  _startTickWatch() {
    this._stopTickWatch();
    const ws = this._ws;
    const generation = this._socketGeneration;
    const pollMs = Math.max(Math.floor(this._tickIntervalMs / 4), 1000);
    this._tickWatchTimer = setInterval(() => {
      if (!this._isCurrentSocket(ws, generation)) return;
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

module.exports = { mapFailureHintToActivityCode, inferFailureHintFromText, resolveTerminalErrorCode, isGatewaySeqGapNotice, buildTerminalErrorActivity, createPluginOpenclawClient };
