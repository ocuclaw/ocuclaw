const DEFAULT_SAFE_KEYS = new Set([
  "page", "pageCount", "selectedIndex", "cursor", "index", "count", "lane",
  "slotState", "ms", "durationMs", "seq", "ok", "enabled", "connected",
  "battery", "batteryLevel", "from", "to", "lines", "width", "height", "kind",
  "severity", "state", "phase",
]);

const SAFE_KEYS = {
  "sdk.frames": new Set([
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
    "sdkPackage",
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

  "app.lifecycle": new Set([
    "requestId", "sinceMs", "flushed", "dropped",
  ]),
};

const SECRET_KEY_RE = /token|secret|auth|apikey|api_key|password|cookie|bearer/i;
const TOKEN_VALUE_RE = /[?&](?:token|access_token|key)=[^&\s"]+/gi;

const SECRET_VALUE_RE = /(?:bearer\s+\S+|authorization\s*[:=]\s*(?:bearer\s+)?\S+|(?:access[_-]?token|token|secret|api[_-]?key|password|passwd|pwd)\s*=\s*\S+)/gi;

const URL_AUTHORITY_RE = /\b(wss?|https?):\/\/[^\/\s"'?#]+/gi;

const ADDRESS_KEY_RE = /^(?:url|uri|addr|address|host|hostname|endpoint|relay|gateway)(?:[A-Z_]|$)|(?:Url|Uri|Addr|Address|Host|Hostname|Endpoint|Relay|Gateway)(?:[A-Z_]|$)/;

function structuralPlaceholder(s) {

  return s.replace(/\S/g, "■");
}

function safeKeysFor(cat) {
  const extra = SAFE_KEYS[cat];
  if (!extra) return DEFAULT_SAFE_KEYS;
  return new Set([...DEFAULT_SAFE_KEYS, ...extra]);
}

function redactData(cat, data, mode) {
  if (data == null || typeof data !== "object") return data;
  const safe = safeKeysFor(cat);
  const out = Array.isArray(data) ? [] : {};
  for (const [k, v] of Object.entries(data)) {

    if (SECRET_KEY_RE.test(k)) continue;
    if (typeof v === "string") {

      if (ADDRESS_KEY_RE.test(k)) {
        out[k] = "[redacted-address]";
        continue;
      }

      const cleaned = v
        .replace(TOKEN_VALUE_RE, "[redacted]")
        .replace(SECRET_VALUE_RE, "[redacted-secret]")
        .replace(URL_AUTHORITY_RE, "$1://[redacted-host]");
      if (safe.has(k) || mode === "off") {
        out[k] = cleaned;
      } else if (mode === "full") {
        out[k] = "";
      } else {
        out[k] = structuralPlaceholder(cleaned);
      }
    } else if (v && typeof v === "object") {

      out[k] = redactData(cat, v, mode);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactEvents(events, opts) {
  const mode = opts && opts.mode ? opts.mode : "structural";
  return events.map((evt) => {
    const out = {
      ts: evt.ts,
      cat: evt.cat,
      event: evt.event,
      severity: evt.severity,
      seq: evt.seq,
      data: redactData(evt.cat, evt.data, mode),
    };

    if (typeof evt.sessionKey === "string" && evt.sessionKey) {
      out.sessionKey = evt.sessionKey;
    }
    if (typeof evt.runId === "string" && evt.runId) {
      out.runId = evt.runId;
    }
    if (typeof evt.screen === "string" && evt.screen) {

      out.screen = evt.screen;
    }
    return out;
  });
}

module.exports = { redactEvents, structuralPlaceholder, SAFE_KEYS, DEFAULT_SAFE_KEYS };
