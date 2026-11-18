const { sanitizeVoiceNetworkCause } = require("./voice-network-cause.cjs");
const { sanitizeAttemptSummary } = require("./voice-attempt-summary.cjs");

const DEFAULT_SAFE_KEYS = new Set([
  "page", "pageCount", "selectedIndex", "cursor", "index", "count", "lane",
  "slotState", "ms", "durationMs", "seq", "ok", "enabled", "connected",
  "battery", "batteryLevel", "from", "to", "lines", "width", "height", "kind",
  "severity", "state", "phase", "captureEpoch",
]);

const SAFE_KEYS = {
  "sdk.frames": new Set([

    "clientLaunchId", "writerId", "method", "sdkOutcome", "waitOutcome",
    "appDisposition", "disposition",
    "writeSeq", "chars", "lineCount", "selectedLane", "selectedCanonicalIndex",
    "virtualPageCount", "slotIntent", "slotRunId", "indicator", "bodyHash",
    "statusEmojiDecisionBranch", "streamingEmojiVariant", "startsWithNewline",
    "endsWithNewline", "unifiedHeaderChars", "unifiedBodyChars",
    "unifiedLeftTruncated", "payloadLiteMode", "containerName", "containerID",
    "owner", "coalesced", "contentOffset", "contentLength",
    "bridgeCallPrevented",
  ]),

  "glasses.lifecycle": new Set([
    "surfaceId", "mode", "depth", "kind", "itemsMore",

    "outcome", "skipReason", "shape", "slot",

    "warmTrigger",

    "jevReason", "httpStatus",

    "code", "skipped", "refusedType", "copy", "modelFormat", "videoReason",
  ]),

  "card.studio": new Set([
    "buildId", "cardKey", "tool", "atMs", "startedAtMs", "endedAtMs", "outcome", "calls",
    "tests", "result", "code", "part", "parts", "mimeType", "control", "focusId", "heldMs",
    "taskId", "slot", "resultAtMs", "valueDigest", "windowMs", "draftId", "revision", "appId",
    "hash", "length",

    "doneBy",
  ]),

  "openclaw.message": new Set([
    "runId", "backendKind",
  ]),

  "evenai": new Set([
    "requestId", "bodyBytes", "messageChars", "model", "extraSystemPromptChars",
    "routingMode", "sessionChanged", "listenEnabled", "dedupWindowMs",
    "activeRequestId", "code", "elapsedMs", "timeoutMs", "textChars", "failureReason",
  ]),

  "voice.timeline": new Set([
    "voiceSessionId", "trigger", "wasWaiting", "flagSource", "transcriptChars",
    "sdkPackage", "networkRequestId", "preparationPurpose",
  ]),

  "voice.transport": new Set([
    "voiceSessionId", "trigger", "state", "transportMode",
  ]),

  "voice.ptt": new Set([
    "provider", "endpointDetection", "count", "chars", "heldMs", "source",
  ]),

  "voice.waveform": new Set([
    "consecutiveFailureCount", "failSilentTripCount", "atMs",
  ]),

  "screen.nav": new Set([
    "activeScreen", "navigationSeq", "inFlightNavigationSeq", "owner", "navSeq",
    "source", "sysType", "textType", "listType", "menuDepth", "pendingCount",
    "deferredDoubleClick", "coalesced", "replacedMenuActivation",
  ]),

  "render.ownership": new Set([
    "activeScreen", "navigationSeq", "inFlightNavigationSeq", "owner",
  ]),

  "render.header_animation": new Set([
    "slotRunId", "slotActivityId", "slotSeq", "slotCategory", "slotOrigin",
    "slotPhase", "slotIntent", "expectedScreenLifecycleEpoch",
  ]),

  "render.virtual_pager.diagnostics": new Set([
    "selectedLane", "selectedCanonicalIndex", "streamPageCount",
    "historyPageCount", "autoFollow", "streamManualBrowseActive",
    "handoffAnchorOffset",
  ]),

  "relay.protocol": new Set([
    "messageId", "textChars", "hasAttachment", "attachmentBytes",
    "upstreamDispatchMs", "localPublishMs", "onSendSyncMs", "clientId",
    "persisted",
  ]),

  "relay.worker.health": new Set([
    "workerEpoch", "mainFrameAgeMs", "mainHeartbeatAgeMs",
    "workerMainQueueDepth", "workerQueueDepthByClass",
  ]),

  "relay.operation": new Set([
    "requestId", "operation", "class", "clientId", "duplicate", "retainedFinal",
  ]),

  "relay.health": new Set([
    "bufferedAmountBytes", "thresholdBytes", "clientId",
  ]),
  "relay.session": new Set([
    "sessionId", "clientId",
  ]),
  "openclaw.run": new Set([
    "role", "contentBlocks", "textChars", "rawAssistantChars",
    "assistantDeltaChars", "firstGatewayChunk", "gatewayReceivedAtMs",
    "gatewayToRelayIngressMs", "backendKind",
  ]),

  "openclaw.seq": new Set(["backendKind"]),
  "openclaw.history": new Set(["backendKind"]),
  "hermes.link": new Set(["type", "method"]),

  "token.aux": new Set([
    "task", "requestId", "attempt", "provider", "model", "ms", "input", "output", "failed",
  ]),

  "firecrawl.web": new Set([
    "round", "digest", "outcome", "skipReason", "ms", "needsWeb", "standalone",
    "freshness", "freshnessConfidence", "source", "sourceConfidence", "depth",
    "depthConfidence", "watchTarget", "watchTargetConfidence", "usedWeb", "webCalls",
    "webSearches", "webReads", "webBrowses", "firstWebMs", "runMs",
  ]),

  "app.lifecycle": new Set([
    "requestId", "sinceMs", "flushed", "dropped",
  ]),
};

const SECRET_KEY_RE = /token|secret|auth|api[_-]?key|password|passwd|pwd|cookie|bearer/i;

const SECRET_NAME_HUMP_RE = /([a-z0-9])([A-Z])|([A-Z])([A-Z][a-z])/g;
const SECRET_NAME_TAIL_RE = /(?:^|[^a-z0-9])(?:credentials?|passphrase|private[^a-z0-9]?key|pairing[^a-z0-9]?code|pin[^a-z0-9]?code|pin|otp)[^a-z]*$/;

function isSecretKey(key        ) {
  if (SECRET_KEY_RE.test(key)) return true;
  const words = key.replace(SECRET_NAME_HUMP_RE, (_m, a, b, c, d) => `${a ?? c}_${b ?? d}`).toLowerCase();
  return SECRET_NAME_TAIL_RE.test(words);
}
const TOKEN_VALUE_RE = /[?&](?:token|access_token|key)=[^&\s"]+/gi;

const SECRET_VALUE_RE = /(?:bearer\s+\S+|authorization\s*[:=]\s*(?:[a-z][a-z0-9._~+-]*\s+)?\S+|(?:access[_-]?token|token|secret|api[_-]?key|password|passwd|pwd)\s*=\s*\S+)/gi;

const CREDENTIAL_SHAPE_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live_|test_)?[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16}|tskey-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

const LABELED_CREDENTIAL_RE = /((?:(?<![A-Za-z0-9])|(?<=(?:[Aa]pi|API|[Aa]ccess|[Rr]efresh|[Cc]lient|[Pp]rivate|[Aa]uth|[Bb]earer|[Ss]ession|[Dd]evice|[Rr]elay|[Gg]ateway|[Bb]ot|[Aa]pp|[Ii]d|[Uu]ser))(?=[A-Z]))(?:(?:[Aa]pi|API)[ _-]?(?:[Kk]ey|KEY)|[Kk]ey|KEY|[Tt]oken|TOKEN|[Ss]ecret|SECRET|[Pp]ass(?:word|wd)|PASS(?:WORD|WD))(?:\\{0,3}["'])?(?:(?=(\s+))\2(?:is|was|Is|Was|IS|WAS)(?=[\s:=%]))?(?:(?=(\s*))\3(?::|=|%3[Dd])(?=(\s*))\4|(?=(\s+))\5)(?:\\{0,3}["'])?)(?![a-z0-9_]+(?:[.\/][a-z0-9_]+)+(?![A-Za-z0-9_\-.+\/]))(?=[A-Za-z0-9_\-.+\/]{0,255}\d)(?=[A-Za-z0-9_\-.+\/]{0,255}[A-Za-z])[A-Za-z0-9_\-.+\/]{20,}/g;

const URL_AUTHORITY_RE = /\b(wss?|https?):\/\/[^\/\s"'?#]+/gi;

const URL_USERINFO_RE = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*):\/\/[^\/\s"'?#]*@/g;

const ADDRESS_KEY_RE = /^(?:url|uri|addr|address|host|hostname|endpoint|relay|gateway|ip(?:v[46])?)(?:[A-Z_]|$)|(?:Url|Uri|Addr|Address|Host|Hostname|Endpoint|Relay|Gateway|Ip(?:v[46])?)(?:[A-Z_]|$)|(?:^|(?<=[a-z0-9_]))(?:URL|URI|ADDR|ADDRESS|HOST|HOSTNAME|ENDPOINT|RELAY|GATEWAY|IP(?:[Vv][46])?)(?:[A-Z_]|$)/;

function isAddressKey(key        ) {
  return ADDRESS_KEY_RE.test(key);
}

function structuralPlaceholder(s) {

  return s.replace(/\S/g, "■");
}

function safeKeysFor(cat) {
  const extra = SAFE_KEYS[cat];
  if (!extra) return DEFAULT_SAFE_KEYS;
  return new Set([...DEFAULT_SAFE_KEYS, ...extra]);
}

function scrubSecretShapes(text        ) {
  return text
    .replace(TOKEN_VALUE_RE, "[redacted]")
    .replace(SECRET_VALUE_RE, "[redacted-secret]")
    .replace(CREDENTIAL_SHAPE_RE, "[redacted-secret]")
    .replace(LABELED_CREDENTIAL_RE, "$1[redacted-secret]")
    .replace(URL_AUTHORITY_RE, "$1://[redacted-host]")
    .replace(URL_USERINFO_RE, "$1://[redacted-userinfo]@");
}

function setOwn(out     , key        , value         ) {
  if (key === "__proto__") Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  else out[key] = value;
}

function scrubKey(key        , out                         ) {
  const cleaned = scrubSecretShapes(key);
  if (cleaned === key && !Object.prototype.hasOwnProperty.call(out, key)) return key;
  let candidate = cleaned;
  for (let n = 2; Object.prototype.hasOwnProperty.call(out, candidate); n++) candidate = `${cleaned}#${n}`;
  return candidate;
}

const MAX_REDACT_DEPTH = 64;

function redactAddressValue(v         , depth        , ancestors             )          {
  if (typeof v === "string") return "[redacted-address]";
  if (typeof v === "bigint") return "[redacted-address]";
  if (v == null || typeof v !== "object") return v;
  if (ancestors.has(v)) return "[circular]";
  if (depth >= MAX_REDACT_DEPTH) return "[too-deep]";
  ancestors.add(v);
  const out      = Array.isArray(v) ? [] : {};
  for (const [k, inner] of Object.entries(v)) {
    if (isSecretKey(k)) continue;
    setOwn(out, scrubKey(k, out), redactAddressValue(inner, depth + 1, ancestors));
  }
  ancestors.delete(v);
  return out;
}

function redactData(cat     , data     , mode     , depth = 0, ancestors              = new Set())      {
  if (data == null || typeof data !== "object") return data;
  if (ancestors.has(data)) return "[circular]";
  if (depth >= MAX_REDACT_DEPTH) return "[too-deep]";
  ancestors.add(data);
  try {
    return redactObject(cat, data, mode, depth, ancestors);
  } finally {
    ancestors.delete(data);
  }
}

function redactObject(cat     , data     , mode     , depth        , ancestors             ) {

  if (["botScreen.control", "botScreen.snapshot"].includes(data.method)) return { method: "botScreen.control", private: true };
  if (data.type === "ocuclaw.botscreen.control" || data.type === "ocuclaw.botscreen.control.result" || data.type === "ocuclaw.botscreen.frame" ||
      data.type === "ocuclaw.botscreen.aim" || data.type === "ocuclaw.botscreen.aim.result") {
    return { type: data.type, private: true };
  }
  if (data.privateDisplay === true) return { privateDisplay: true };
  const safe = safeKeysFor(cat);
  const out      = Array.isArray(data) ? [] : {};
  for (const [k, v] of Object.entries(data)) {

    if (isSecretKey(k)) continue;
    setOwn(out, scrubKey(k, out), redactEntry(cat, k, v, safe, mode, depth, ancestors));
  }
  return out;
}

function redactEntry(cat     , k        , v     , safe             , mode     , depth        , ancestors             ) {
  if (cat === "voice.timeline" && k === "networkCause") return sanitizeVoiceNetworkCause(v);
  if (v && typeof v === "object" && isAddressKey(k)) return redactAddressValue(v, depth + 1, ancestors);

  if (typeof v === "bigint") return String(v);
  if (typeof v === "string") {

    if (isAddressKey(k)) return "[redacted-address]";

    const cleaned = scrubSecretShapes(v);
    if (safe.has(k) || mode === "off") return cleaned;
    if (mode === "full") return "";
    return structuralPlaceholder(cleaned);
  }

  if (v && typeof v === "object") return redactData(cat, v, mode, depth + 1, ancestors);
  return v;
}

function redactEvents(events, opts) {
  const mode = opts && opts.mode ? opts.mode : "structural";
  return events.map((evt) => {
    const out      = {
      ts: evt.ts,
      cat: evt.cat,
      event: evt.event,
      severity: evt.severity,
      seq: evt.seq,
      data: ["voice_attempt_summary", "even_ai_test_summary"].includes(evt.event)
        ? sanitizeAttemptSummary(evt.data) : redactData(evt.cat, evt.data, mode),
    };

    if (typeof evt.sessionKey === "string" && evt.sessionKey) {
      out.sessionKey = scrubSecretShapes(evt.sessionKey);
    }
    if (typeof evt.reportSessionKey === "string" && evt.reportSessionKey) out.reportSessionKey = scrubSecretShapes(evt.reportSessionKey);
    if (Number.isSafeInteger(evt.phoneSeq) && evt.phoneSeq > 0) out.phoneSeq = evt.phoneSeq;
    if (typeof evt.runId === "string" && evt.runId) {
      out.runId = scrubSecretShapes(evt.runId);
    }
    if (typeof evt.screen === "string" && evt.screen) {

      out.screen = scrubSecretShapes(evt.screen);
    }
    if (evt.source === "phone") out.source = "phone";
    if (Number.isFinite(evt.clientTsMs)) out.clientTsMs = Math.floor(evt.clientTsMs);
    if (evt.source === "phone" && typeof evt.clientId === "string") out.clientId = scrubSecretShapes(evt.clientId);
    return out;
  });
}

function redactDiagnosticData(data                         , mode = "off") {
  return redactData("client.diagnostics", data, mode);
}

module.exports = { isSecretKey, isAddressKey, structuralPlaceholder, scrubSecretShapes, redactEvents, redactDiagnosticData, SAFE_KEYS, DEFAULT_SAFE_KEYS };
