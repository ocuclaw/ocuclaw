const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { createPluginVersionService } = require("./plugin-version-service.cjs");
const conversationStateModule = require("../domain/conversation-state.cjs");
const { stripAllTaggedSpans } = require("../domain/tagged-span-strip.cjs");
const { parseTaggedSpans } = require("../domain/tagged-span-parser.cjs");
const { EMOJI_TAG_FAMILY_CONFIG } = require("../domain/neural-emoji-reactor-tag-config.cjs");
const { PACE_TAG_FAMILY_CONFIG } = require("../domain/neural-pace-modulator-tag-config.cjs");
const { applyMarkdownWithSpans } = require("../domain/streaming-span-markdown.cjs");
const { createDebugStore } = require("../domain/debug-store.cjs");
const { startUploadCaptureArming, UPLOAD_CAPTURE_PRESET } = require("../domain/debug-upload-preset.cjs");
const { summarizeGlassesUiContent } = require("../domain/glasses-ui-content-summary.cjs");
const { composeReadabilitySystemPrompt } = require("../domain/readability-system-prompt.cjs");
const { composeNeuralEmojiReactorSystemPrompt } = require("../domain/neural-emoji-reactor-system-prompt.cjs");
const { composeNeuralPaceModulatorSystemPrompt } = require("../domain/neural-pace-modulator-system-prompt.cjs");
const { composeGlassesUiNudgeSystemPrompt } = require("../domain/glasses-ui-system-prompt.cjs");
const { composeGlassesDisplaySystemPrompt } = require("../domain/glasses-display-system-prompt.cjs");
const { createStablePromptSnapshotStore } = require("./stable-prompt-snapshot.cjs");
const { createActivityStatusAdapter } = require("../domain/activity-status-adapter.cjs");
const { createEvenAiEndpoint } = require("../even-ai/even-ai-endpoint.cjs");
const { createEvenAiRouter } = require("../even-ai/even-ai-router.cjs");
const { createEvenAiRunWaiter } = require("../even-ai/even-ai-run-waiter.cjs");
const { createEvenAiSettingsStore, normalizeEvenAiDefaultAgent } = require("../even-ai/even-ai-settings-store.cjs");
const { createPluginOpenclawClient } = require("../gateway/openclaw-client.cjs");
const { createPluginRpcGatewayBridge } = require("../gateway/gateway-bridge.cjs");
const { isKnownBackendKind, setActiveBackendKind, getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { createAgentTurnTracker } = require("../tools/glasses-ui-wake.cjs");
const { gatewaySessionKeyFor } = require("./openclaw-session-key.cjs");
const { getRegisteredLiveuiGlassesLibraryController } = require("../tools/glasses-ui-tool.cjs");
const { createLiveuiTaskRunController } = require("../tools/glasses-ui-task-run.cjs");
const { projectTaskRunRecord } = require("../tools/glasses-ui-task-run-records.cjs");
const { compareRungs } = require("../tools/glasses-ui-delivery-ladder.cjs");
const { createLiveuiExecutorRegistry, projectTaskExecutorState } = require("../tools/glasses-ui-executor-registry.cjs");
const { createDownstreamHandler } = require("./downstream-handler.cjs");
const { handleDebugBundleRequest, handleDebugBundleSave, handleDebugBundleFetch } = require("./debug-bundle-handler.cjs");
const { createBundleCache } = require("../domain/debug-bundle-cache.cjs");
const { saveBundleToDisk } = require("../domain/debug-bundle-save.cjs");
const { createOcuClawSettingsStore, normalizeOcuClawDefaultAgent } = require("./ocuclaw-settings-store.cjs");
const { buildCapabilitySnapshot, buildPushMessage } = require("./capability-snapshot.cjs");
const { createRelayHealthMonitor } = require("./relay-health-monitor.cjs");
const { createGlassesBackpressureLatch } = require("./glasses-backpressure-latch.cjs");
const { createRelayOperationRegistry } = require("./relay-operation-registry.cjs");
const { createRelayWorkerSupervisor } = require("./relay-worker-supervisor.cjs");
const { isPairingControlPath, isPairingEndpointPath } = require("../domain/pairing/pairing-endpoint-address.cjs");
const { createPairingControlService } = require("../domain/pairing/pairing-control-service.cjs");
const { createPairingEndpointService } = require("../domain/pairing/pairing-endpoint-service.cjs");
const { createPairingExchangeHost } = require("../domain/pairing/pairing-exchange.cjs");
const { resolveNoiseSuite } = require("../domain/pairing/noise-suite.cjs");
const { activeNewSessionGreetingPrompt, createSessionService, isSupersededSessionSwitchError } = require("./session-service.cjs");
const { createUpstreamRuntime } = require("./upstream-runtime.cjs");
const { isEtSessionKey, parseEtSessionKey, etProviderDisplayName } = require("./even-terminal/session-key.cjs");
const { createEtStreamInjector } = require("./even-terminal/stream-injector.cjs");
const { createDemandRouter } = require("./even-terminal/demand-router.cjs");
const { createHermesSlashConfirmRouter } = require("./hermes-slash-confirm-router.cjs");
const { buildDemandFrame } = require("./even-terminal/demand-surface.cjs");
const { createHermesClarifyRouter } = require("./hermes-clarify-router.cjs");
const { createOpenClawQuestionRouter } = require("./openclaw-question-router.cjs");
const { buildEtSessionSwitchClearActivity } = require("./even-terminal/activity-clear.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { normalizeSonioxTemporaryKeyErrorCodeForRelay: normalizeSonioxTemporaryKeyErrorCode } = require("../domain/soniox-temp-key-errors.cjs");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY, extractEmbeddedEvenAiSessionKey } = require("../domain/even-ai-session-keys.cjs");
const { DEFAULT_HERMES_NAMESPACE, hermesProfileIdForNamespace, mintedHermesSessionKey, parseHermesPublicKey } = require("./hermes-session-keys.cjs");

const LIVEUI_TASK_DISCOVERY_CHANNEL_ONE =
  "The wearer may have saved LiveUI Tasks; before using shell, calendar or search tools for a job that sounds like a saved Task, call manage_liveui_tasks find_tasks.";

const GLASSES_UI_MARKERS = new Set(["listening", "parked", "inflight"]);
function sanitizeGlassesMarker(v) { return GLASSES_UI_MARKERS.has(v) ? v : undefined; }

function parseHermesFeatureTokens(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const seen = new Set();
  for (const piece of raw.split(",")) {
    const token = piece.trim().toLowerCase();
    if (token) seen.add(token);
  }
  return Array.from(seen).sort();
}

function resolveEvenAiRouterOptionsForBackend(backendKind) {
  const defaultDedicatedSessionKey =
    backendKind === "hermes"
      ? mintedHermesSessionKey("even-ai", undefined)
      : DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY;
  return {
    defaultDedicatedSessionKey,
    detachedSessionKeyPrefix:
      backendKind === "hermes"
        ? `${defaultDedicatedSessionKey}-`
        : `${defaultDedicatedSessionKey}:`,
    validator:
      backendKind === "hermes"
        ? (sessionKey) => {
            const parsed = parseHermesPublicKey(sessionKey);
            return !!parsed && parsed.kind === "minted";
          }
        : (sessionKey) =>
            typeof sessionKey === "string" &&
            sessionKey.trim().toLowerCase().startsWith("ocuclaw:"),
  };
}

const SONIOX_TEMP_KEY_URL = "https://api.soniox.com/v1/auth/temporary-api-key";
const SONIOX_MODELS_URL = "https://api.soniox.com/v1/models";
const DEFAULT_SONIOX_TEMP_KEY_EXPIRES_IN_SECONDS = 3600;

const DEFAULT_SONIOX_TEMP_KEY_MINT_TIMEOUT_MS = 8000;
const CARTESIA_ACCESS_TOKEN_URL = "https://api.cartesia.ai/access-token";
const CARTESIA_VERSION = "2026-03-01";
const DEFAULT_CARTESIA_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 3600;
const DEFAULT_CARTESIA_ACCESS_TOKEN_MINT_TIMEOUT_MS = 8000;
const LISTEN_INTERCEPT_RECOVERY_ERROR = "Voice interrupted; retry";
const LISTEN_INTERCEPT_RECOVERY_CODE = "transport_interrupted";
const LOCATION_REQUEST_TARGET_TTL_MS = 30_000;

const SIMULATE_VOICE_COMMIT_DISPLAY_GATE_MS = 250;
const SIMULATE_THINKING_HEARTBEAT_INTERVAL_MS = 500;
const SIMULATE_THINKING_HEARTBEAT_CEILING_MS = 30_000;

function pickTrimmedString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function tailForLog(value, maxChars = 160) {
  const text =
    typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function normalizeEvenAiSessionKeyForLookup(rawKey) {
  return extractEmbeddedEvenAiSessionKey(rawKey);
}

function normalizeAppSessionKeyForCompare(rawKey) {
  if (typeof rawKey !== "string") return "";
  const trimmed = rawKey.trim();
  if (!trimmed) return "";
  const agentMatch = /^agent:[^:]+:(.+)$/i.exec(trimmed);
  return (agentMatch ? agentMatch[1] : trimmed).trim().toLowerCase();
}

function appSessionKeysMatch(leftKey, rightKey) {
  const left = normalizeAppSessionKeyForCompare(leftKey);
  const right = normalizeAppSessionKeyForCompare(rightKey);
  return !!left && !!right && left === right;
}

function dedupeNormalizedSessionKeys(sessionKeys) {
  if (!Array.isArray(sessionKeys) || sessionKeys.length === 0) {
    return [];
  }
  const dedupe = new Set();
  const normalized = [];
  for (const rawKey of sessionKeys) {
    const normalizedKey = normalizeEvenAiSessionKeyForLookup(rawKey);
    if (!normalizedKey) continue;
    const compareKey = normalizedKey.toLowerCase();
    if (dedupe.has(compareKey)) continue;
    dedupe.add(compareKey);
    normalized.push(normalizedKey);
  }
  return normalized;
}

function parseExpiryMs(raw, nowMs) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw > 10_000_000_000 ? Math.floor(raw) : nowMs + Math.floor(raw * 1000);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return parseExpiryMs(numeric, nowMs);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
}

function normalizeSonioxTemporaryKeyResult(result, voiceSessionId, nowMs = Date.now()) {
  const temporaryKey = pickTrimmedString(
    result && result.temporaryKey,
    result && result.temporary_key,
    result && result.key,
    result && result.apiKey,
    result && result.api_key,
  );
  if (!temporaryKey) {
    throw new Error("Soniox temporary-key response missing temporaryKey");
  }

  const expiresAtMs =
    parseExpiryMs(
      result && (
        result.expiresAtMs ??
        result.expires_at_ms ??
        result.expiresAt ??
        result.expires_at
      ),
      nowMs,
    ) ??
    (
      Number.isFinite(result && result.expiresInSeconds)
        ? nowMs + Math.floor(result.expiresInSeconds * 1000)
        : null
    ) ??
    (
      Number.isFinite(result && result.expires_in_seconds)
        ? nowMs + Math.floor(result.expires_in_seconds * 1000)
        : null
    );

  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error("Soniox temporary-key response missing expiresAtMs");
  }

  return {
    voiceSessionId,
    temporaryKey,
    expiresAtMs: Math.floor(expiresAtMs),
  };
}

function normalizeSonioxModelEntryRows(result) {
  const rows =
    result &&
    typeof result === "object" &&
    Array.isArray(result.models)
      ? result.models
      : [];
  const models = [];
  const seenIds = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const transcriptionMode =
      typeof row.transcription_mode === "string"
        ? row.transcription_mode.trim()
        : "";
    if (transcriptionMode !== "real_time") continue;
    if (row.aliased_model_id !== undefined && row.aliased_model_id !== null) {
      const aliasedModelId = pickTrimmedString(row.aliased_model_id);
      if (aliasedModelId) continue;
    }
    const id = pickTrimmedString(row.id);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    models.push({
      id,
      name: pickTrimmedString(row.name) || id,
      supportsMaxEndpointDelay: row.supports_max_endpoint_delay === true,
      languages: normalizeSonioxLanguageRows(row.languages),
    });
  }
  return models;
}

function normalizeSonioxLanguageRows(rows) {
  if (!Array.isArray(rows)) return [];
  const languages = [];
  const seenCodes = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const code = pickTrimmedString(row.code).toLowerCase();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);
    languages.push({ code, name: pickTrimmedString(row.name) || code });
  }
  return languages;
}

function decodeBufferedHttpBody(envelope) {
  return Buffer.from((envelope && envelope.bodyBase64) || "", "base64");
}

function createBufferedHttpRequest(envelope) {
  const req = new EventEmitter();
  req.method = envelope && envelope.method ? envelope.method : "GET";
  req.url = envelope && envelope.url ? envelope.url : "/";
  req.headers = envelope && envelope.headers && typeof envelope.headers === "object"
    ? envelope.headers
    : {};
  req.socket = {
    remoteAddress: "127.0.0.1",
  };
  const body = decodeBufferedHttpBody(envelope);
  process.nextTick(() => {
    if (body.length > 0) {
      req.emit("data", body);
    }
    req.emit("end");
  });
  return req;
}

function createBufferedHttpResponse(maxResponseBytes) {
  const headers = {};
  const chunks = [];
  let totalBytes = 0;
  const limit = Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
    ? Math.floor(maxResponseBytes)
    : 262_144;

  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = false;
  res.setHeader = function (name, value) {
    if (typeof name === "string" && name) {
      headers[name.toLowerCase()] = value;
    }
  };
  res.getHeader = function (name) {
    return typeof name === "string" ? headers[name.toLowerCase()] : undefined;
  };
  res.write = function (chunk) {
    if (this.writableEnded) return false;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    totalBytes += buffer.length;
    if (totalBytes > limit) {
      throw new Error("Buffered HTTP response exceeded relay worker limit");
    }
    chunks.push(buffer);
    return true;
  };
  res.end = function (chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    this.writableEnded = true;
  };
  res.toResult = function () {
    return {
      statusCode: this.statusCode,
      headers: { ...headers },
      body: Buffer.concat(chunks),
    };
  };
  return res;
}

function createRelay(opts) {
  const logger = normalizeLogger(opts.logger);
  const externalDebugToolsEnabled = opts.externalDebugToolsEnabled !== false;

  const allowDebugUpload = opts.allowDebugUpload === true;
  const isDebugBundlePhoneHandoffAllowed = () =>
    externalDebugToolsEnabled && allowDebugUpload;

  const debugUploadMaxZipBytes =
    Number.isFinite(opts.debugUploadMaxZipBytes) && opts.debugUploadMaxZipBytes > 0
      ? Math.floor(opts.debugUploadMaxZipBytes)
      : 4_000_000;
  const openclawClient =
    opts.openclawClient ||
    (opts.gatewayBridge
      ? null
      : createPluginOpenclawClient({
          gatewayUrl: opts.gatewayUrl,
          gatewayToken: opts.gatewayToken,
          logger,
          stateDir: opts.stateDir,
        }));
  if (openclawClient && typeof openclawClient.setLogger === "function") {
    openclawClient.setLogger(logger);
  }
  const gatewayBridge =
    opts.gatewayBridge ||
    createPluginRpcGatewayBridge({
      openclawClient,
    });

  if (gatewayBridge && isKnownBackendKind(gatewayBridge.kind)) {
    setActiveBackendKind(gatewayBridge.kind);
  }
  const relayBackendKind =
    gatewayBridge && isKnownBackendKind(gatewayBridge.kind)
      ? gatewayBridge.kind
      : "openclaw";
  const liveuiExecutorRegistry = opts.liveuiExecutorRegistry || createLiveuiExecutorRegistry({
    libraryDir: opts.liveuiLibraryDir,
    templateLibraryDir: opts.templateLibraryDir,
    heartbeatMs: opts.liveuiExecutorHeartbeatMs,
    now: opts.now,
  });
  let liveuiAgents = [];
  let liveuiExecutorRegistryStarted = false;
  let liveuiGlassesLibraryController = opts.liveuiGlassesLibraryController || null;
  let liveuiTaskRunController = null;

  function resolveLiveuiGlassesLibraryController() {
    return liveuiGlassesLibraryController || getRegisteredLiveuiGlassesLibraryController(
      globalThis,
      {
        taskRunController: liveuiTaskRunController,
        resolveExecutorState: resolveLiveuiTaskExecutorState,
      },
    );
  }
  const evenAiRouterOptions =
    resolveEvenAiRouterOptionsForBackend(relayBackendKind);
  const defaultEvenAiDedicatedSessionKey =
    evenAiRouterOptions.defaultDedicatedSessionKey;
  const configuredEvenAiDedicatedSessionKey =
    typeof opts.evenAiDedicatedSessionKey === "string"
      ? opts.evenAiDedicatedSessionKey.trim()
      : "";
  const noRouterEvenAiDedicatedSessionKey =
    configuredEvenAiDedicatedSessionKey &&
    evenAiRouterOptions.validator(configuredEvenAiDedicatedSessionKey)
      ? configuredEvenAiDedicatedSessionKey
      : defaultEvenAiDedicatedSessionKey;
  const hermesVersion =
    relayBackendKind === "hermes" &&
    typeof opts.hermesVersion === "string" &&
    opts.hermesVersion.trim()
      ? opts.hermesVersion.trim()
      : null;
  const conversationState =
    opts.conversationState || conversationStateModule;
  const activityStatusAdapter = createActivityStatusAdapter(
    opts.activityStatusAdapter,
  );

  const agentTurnTracker = createAgentTurnTracker();
  const sharedHttpServer = opts.httpServer || null;

  let cachedPages = null;

  let pagesRevision = 0;

  let cachedEntries = "";
  let entriesRevision = 0;
  let entriesLastSeq = -1;

  let cachedStatus = null;

  let statusRevision = 0;

  const liveUiSessionGenerationBootId =
    typeof opts.liveUiSessionGenerationBootId === "string" &&
    opts.liveUiSessionGenerationBootId.trim()
      ? opts.liveUiSessionGenerationBootId.trim()
      : crypto.randomUUID();
  let liveUiSessionGenerationSeq = 0;
  const liveUiSessionGenerations = new Map();

  let currentSessionModelConfigSnapshot = null;

  let simulateStreamRunSeq = 0;

  const simulateStreamRuns = new Map();

  const userSendDedupe = new Map();
  const USER_SEND_DEDUPE_MAX = 512;
  const USER_SEND_DEDUPE_TTL_MS = 5 * 60_000;

  const syntheticTimers = new Map();

  const pendingCommitPublishBySession = new Map();

  const simulateToolStarts = new Map();

  const simulateOpenRuns = new Set();

  const simulateCompletedRuns = new Set();

  const simulateResponseStartedRuns = new Set();

  const simulateThinkingHeartbeats = new Map();

  const syntheticApprovals = new Map();

  let voiceScriptingArmed = false;

  const debugCategories = Array.isArray(opts.debugCategories)
    ? opts.debugCategories
    : opts.debugCategories && typeof opts.debugCategories === "object"
      ? Object.entries(opts.debugCategories)
          .filter(([, enabled]) => enabled)
          .map(([category]) => category)
      : opts.debugCategories;

  const debugNow =
    typeof opts.debugNow === "function" ? opts.debugNow : () => Date.now();

  const debugArmStatePath =
    typeof opts.stateDir === "string" && opts.stateDir
      ? path.join(opts.stateDir, "debug-arm.json")
      : null;
  let initialDebugArm = [];
  if (debugArmStatePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(debugArmStatePath, "utf8"));
      if (parsed && Array.isArray(parsed.enabled)) {
        initialDebugArm = parsed.enabled;
      }
    } catch {
      initialDebugArm = [];
    }
  }
  const debugStore = createDebugStore({
    categories: debugCategories,
    capacity: opts.debugCapacity,
    defaultTtlMs: opts.debugDefaultTtlMs,
    maxTtlMs: opts.debugMaxTtlMs,
    dumpDefaultLimit: opts.debugDumpDefaultLimit,
    dumpMaxLimit: opts.debugDumpMaxLimit,
    now: debugNow,
    noisyPolicies: opts.debugNoisyPolicies,
    initialEnabled: initialDebugArm,
  });

  const bundleCache = createBundleCache({ maxEntries: 4, ttlMs: 5 * 60_000, now: () => Date.now() });
  let bundleCacheSweepTimer = null;

  function resolveSaveDir() {
    const c = opts.debugBundleSaveDir;
    return (typeof c === "string" && c.trim()) ? c : path.join(os.homedir(), ".openclaw", "ocuclaw-debug-bundles");
  }

  const liveUiTraceFlagPath =
    typeof opts.stateDir === "string" && opts.stateDir
      ? path.join(opts.stateDir, "liveui-trace.json")
      : null;
  let liveUiTraceLogEnabled = false;
  if (liveUiTraceFlagPath) {
    try {
      liveUiTraceLogEnabled =
        JSON.parse(fs.readFileSync(liveUiTraceFlagPath, "utf8")).enabled === true;
    } catch {
      liveUiTraceLogEnabled = false;
    }
  }

  const consoleLogPath =
    typeof opts.consoleLogPath === "string" && opts.consoleLogPath.trim()
      ? opts.consoleLogPath
      : null;

  if (consoleLogPath) {
    try {
      fs.writeFileSync(consoleLogPath, "");
    } catch {}
  }
  const CONSOLE_LOG_MAX_LINES = 500;
  const CONSOLE_LOG_TRIM_TO = 250;

  function writeConsoleLog(level, message) {
    if (!consoleLogPath) {
      logger.debug(`[browser:${level}] ${message}`);
      return;
    }
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const line = `[${timestamp}] [${level}] ${message}\n`;
    try {
      fs.appendFileSync(consoleLogPath, line);

      const content = fs.readFileSync(consoleLogPath, "utf8");
      const lines = content.split("\n");
      if (lines.length > CONSOLE_LOG_MAX_LINES) {
        const trimmed = lines.slice(-CONSOLE_LOG_TRIM_TO).join("\n");
        fs.writeFileSync(consoleLogPath, trimmed);
      }
    } catch (err) {
      logger.error(`[relay] Console log write failed: ${err.message}`);
    }
  }

  function emitDebug(cat, event, severity, context, buildData, options = undefined) {
    const force = !!(options && options.force === true);
    if (!force && !debugStore.isEnabled(cat) && !(liveUiTraceLogEnabled && (cat === "glasses.lifecycle" || cat === "openclaw.message"))) {
      return;
    }

    let data = {};
    if (typeof buildData === "function") {
      try {
        data = buildData() || {};
      } catch (err) {
        data = { buildError: err.message || String(err) };
      }
    }

    if (relayBackendKind === "hermes" && cat.startsWith("openclaw.")) {
      data =
        data && typeof data === "object" && !Array.isArray(data)
          ? { ...data, backendKind: "hermes" }
          : { value: data, backendKind: "hermes" };
    }

    const ts = debugNow();
    const payload = { ts, cat, event, severity, data };

    if (context && context.sessionKey) payload.sessionKey = context.sessionKey;
    if (context && context.runId) payload.runId = context.runId;
    if (context && context.screen) payload.screen = context.screen;

    debugStore.emit(payload, { force });

    if (liveUiTraceLogEnabled && (cat === "glasses.lifecycle" || cat === "openclaw.message")) {
      try {
        const surfaceId =
          data && typeof data.surfaceId === "string" ? data.surfaceId : null;
        const sessionKey =
          payload.sessionKey ||
          (data && typeof data.sessionKey === "string" ? data.sessionKey : null) ||
          null;
        const side =
          cat === "openclaw.message"
            ? (event === "user_message" ? "user" : "agent")
            : "openclaw";

        logger.traceLog(
          "[liveui] " +
            JSON.stringify({
              trace: "liveui",
              side,
              ts,
              cat,
              event,
              severity,
              surfaceId,
              sessionKey,
              data,
            }),
        );
      } catch {

      }
    }
  }

  function isForcedReadinessProofEvent(payload) {
    return !!(
      payload &&
      payload.cat === "app.lifecycle" &&
      payload.event === "readiness_probe_received"
    );
  }

  function isForcedLiveuiFailureEvent(payload) {
    return !!(
      payload &&
      (payload.event === "liveui_render_failed" ||
        payload.event === "liveui_render_unparsed")
    );
  }

  function simulateStreamRunKey(sessionKey, runId) {
    return JSON.stringify([sessionKey, runId]);
  }

  function cancelSimulateStreamRun(entry) {
    if (!entry || simulateStreamRuns.get(entry.key) !== entry) return 0;

    simulateStreamRuns.delete(entry.key);
    const timers = Array.from(entry.timers);
    entry.timers.clear();
    for (const timer of timers) clearTimeout(timer);
    return timers.length;
  }

  function scheduleSimulateStreamTimer(entry, delayMs, callback) {
    const timer = setTimeout(() => {
      entry.timers.delete(timer);
      if (simulateStreamRuns.get(entry.key) !== entry) return;
      try {
        callback();
      } catch (err) {
        logger.error(`[relay] simulate-stream timer failed: ${err.message}`);
      }
    }, delayMs);
    entry.timers.add(timer);
    return timer;
  }

  function cancelSimulateStreamRunsForSession(sessionKey) {
    let cleared = 0;
    for (const entry of Array.from(simulateStreamRuns.values())) {
      if (entry.sessionKey === sessionKey) cleared += cancelSimulateStreamRun(entry);
    }
    if (cleared > 0) {
      logger.info(
        `[relay] cancelled ${cleared} pending simulate-stream timer(s) for session ${sessionKey}`,
      );
    }
    return cleared;
  }

  function cancelAllSimulateStreamRuns() {
    for (const entry of Array.from(simulateStreamRuns.values())) {
      cancelSimulateStreamRun(entry);
    }
  }

  function scheduleSyntheticTimer(delayMs, callback, sessionKey) {
    const timer = setTimeout(() => {
      syntheticTimers.delete(timer);
      try {
        callback();
      } catch (err) {
        logger.error(`[relay] synthetic timer failed: ${err.message}`);
      }
    }, delayMs);
    syntheticTimers.set(timer, typeof sessionKey === "string" ? sessionKey : null);
    return timer;
  }

  function dropPendingCommitPublish(sessionKey = "") {
    const pending = pendingCommitPublishBySession.get(sessionKey);
    if (!pending) return false;
    pendingCommitPublishBySession.delete(sessionKey);
    clearTimeout(pending.timer);
    syntheticTimers.delete(pending.timer);
    return true;
  }

  function flushPendingCommitPublish(sessionKey = "") {
    const pending = pendingCommitPublishBySession.get(sessionKey);
    if (!pending) return false;
    pendingCommitPublishBySession.delete(sessionKey);
    clearTimeout(pending.timer);
    syntheticTimers.delete(pending.timer);
    try {
      pending.publish();
    } catch (err) {
      logger.error(`[relay] pending commit publish flush failed: ${String(err)}`);
    }
    return true;
  }

  function clearSyntheticTimersForSession(sessionKey) {
    for (const [timer, timerSessionKey] of syntheticTimers) {
      if (timerSessionKey !== sessionKey) continue;
      clearTimeout(timer);
      syntheticTimers.delete(timer);
    }
    pendingCommitPublishBySession.delete(sessionKey);
  }

  function clearSyntheticTimers() {
    for (const timer of syntheticTimers.keys()) clearTimeout(timer);
    syntheticTimers.clear();
    pendingCommitPublishBySession.clear();
  }

  function simulatedRunKeyMatchesSession(key = "", sessionKey = "") {
    try {
      const tuple = JSON.parse(key);
      return Array.isArray(tuple) && tuple[0] === (sessionKey || "");
    } catch {
      return false;
    }
  }

  function clearSimulatedRunStateForSession(sessionKey = "") {

    dropPendingCommitPublish(sessionKey);
    for (const key of Array.from(simulateThinkingHeartbeats.keys())) {
      if (simulatedRunKeyMatchesSession(key, sessionKey)) {
        cancelSimulatedThinkingHeartbeat(key);
      }
    }
    for (const key of Array.from(simulateOpenRuns)) {
      if (simulatedRunKeyMatchesSession(String(key), sessionKey)) {
        simulateOpenRuns.delete(key);
      }
    }
    for (const key of Array.from(simulateCompletedRuns)) {
      if (simulatedRunKeyMatchesSession(String(key), sessionKey)) {
        simulateCompletedRuns.delete(key);
      }
    }
    for (const key of Array.from(simulateResponseStartedRuns)) {
      if (simulatedRunKeyMatchesSession(String(key), sessionKey)) {
        simulateResponseStartedRuns.delete(key);
      }
    }
  }

  function clearSyntheticWorkForSession(sessionKey) {
    cancelSimulateStreamRunsForSession(sessionKey);
    clearSyntheticTimersForSession(sessionKey);
    clearSimulatedRunStateForSession(sessionKey);
  }

  function clearSyntheticWork() {
    cancelAllSimulateStreamRuns();
    clearSyntheticTimers();
    for (const key of Array.from(simulateThinkingHeartbeats.keys())) {
      cancelSimulatedThinkingHeartbeat(key);
    }
    simulateOpenRuns.clear();
    simulateCompletedRuns.clear();
    simulateResponseStartedRuns.clear();
  }

  function resetActivityStatusAdapter() {
    activityStatusAdapter.reset();
  }

  const configuredSonioxApiKey =
    opts.sonioxApiKey !== undefined
      ? opts.sonioxApiKey
      : (opts.config && opts.config.sonioxApiKey) || "";
  const sonioxTemporaryKeyExpiresInSeconds = Number.isFinite(
    opts.sonioxTemporaryKeyExpiresInSeconds,
  )
    ? Math.max(30, Math.floor(opts.sonioxTemporaryKeyExpiresInSeconds))
    : DEFAULT_SONIOX_TEMP_KEY_EXPIRES_IN_SECONDS;
  const sonioxTemporaryKeyMintTimeoutMs = Number.isFinite(
    opts.sonioxTemporaryKeyMintTimeoutMs,
  )
    ? Math.max(1, Math.floor(opts.sonioxTemporaryKeyMintTimeoutMs))
    : DEFAULT_SONIOX_TEMP_KEY_MINT_TIMEOUT_MS;
  const configuredCartesiaApiKey =
    opts.cartesiaApiKey !== undefined
      ? opts.cartesiaApiKey
      : (opts.config && opts.config.cartesiaApiKey) || "";
  const cartesiaAccessTokenExpiresInSeconds = Number.isFinite(
    opts.cartesiaAccessTokenExpiresInSeconds,
  )
    ? Math.max(30, Math.min(3600, Math.floor(opts.cartesiaAccessTokenExpiresInSeconds)))
    : DEFAULT_CARTESIA_ACCESS_TOKEN_EXPIRES_IN_SECONDS;
  const cartesiaAccessTokenMintTimeoutMs = Number.isFinite(
    opts.cartesiaAccessTokenMintTimeoutMs,
  )
    ? Math.max(1, Math.floor(opts.cartesiaAccessTokenMintTimeoutMs))
    : DEFAULT_CARTESIA_ACCESS_TOKEN_MINT_TIMEOUT_MS;

  let cachedSonioxModels = null;
  let cachedSonioxModelsFetchedAt = 0;
  let cachedSonioxModelsStale = true;
  let sonioxModelsFetchStarted = false;

  let inFlightSonioxModelsFetch = null;

  function resolveFetchImpl() {
    return typeof opts.fetch === "function"
      ? opts.fetch
      : typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null;
  }

  function sonioxModelsSnapshot(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const hasCache = Array.isArray(cachedSonioxModels);
    return {
      models: hasCache ? cachedSonioxModels : [],
      fetchedAtMs: hasCache ? cachedSonioxModelsFetchedAt : now,
      stale: !hasCache || cachedSonioxModelsStale,
    };
  }

  function cacheSonioxModels(models, fetchedAtMs, stale) {
    cachedSonioxModels = Array.isArray(models) ? models : [];
    cachedSonioxModelsFetchedAt = Number.isFinite(fetchedAtMs)
      ? Math.floor(fetchedAtMs)
      : Date.now();
    cachedSonioxModelsStale = !!stale;
    return sonioxModelsSnapshot(cachedSonioxModelsFetchedAt);
  }

  function getSonioxModelsSnapshot() {
    if (inFlightSonioxModelsFetch) {
      return inFlightSonioxModelsFetch;
    }
    return Promise.resolve(sonioxModelsSnapshot());
  }

  function prefetchSonioxModels(trigger = "relay_start") {
    if (inFlightSonioxModelsFetch) {
      return inFlightSonioxModelsFetch;
    }
    if (sonioxModelsFetchStarted) {
      return Promise.resolve(sonioxModelsSnapshot());
    }
    sonioxModelsFetchStarted = true;

    const fetchImpl = resolveFetchImpl();
    if (!configuredSonioxApiKey) {
      const snapshot = cacheSonioxModels([], Date.now(), true);
      emitDebug(
        "voice.timeline",
        "soniox_models_prefetch_skipped",
        "warn",
        { sessionKey: sessionService.peekSessionKey() || undefined },
        () => ({
          trigger,
          reason: "api_key_not_configured",
        }),
      );
      return Promise.resolve(snapshot);
    }
    if (!fetchImpl) {
      const snapshot = cacheSonioxModels([], Date.now(), true);
      emitDebug(
        "voice.timeline",
        "soniox_models_prefetch_skipped",
        "warn",
        { sessionKey: sessionService.peekSessionKey() || undefined },
        () => ({
          trigger,
          reason: "fetch_unavailable",
        }),
      );
      return Promise.resolve(snapshot);
    }

    inFlightSonioxModelsFetch = Promise.resolve()
      .then(async () => {
        const response = await fetchImpl(SONIOX_MODELS_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${configuredSonioxApiKey}`,
          },
        });
        const rawText =
          response && typeof response.text === "function"
            ? await response.text()
            : "";
        let payload = {};
        if (rawText) {
          try {
            payload = JSON.parse(rawText);
          } catch {
            if (!response.ok) {
              throw new Error(
                `Soniox models request failed (${response.status}): ${tailForLog(rawText)}`,
              );
            }
            throw new Error(
              `Soniox models response was not valid JSON (${response.status})`,
            );
          }
        }
        if (!response.ok) {
          const errorDetail = pickTrimmedString(
            payload && payload.error,
            payload && payload.message,
            payload && payload.detail,
            rawText,
          ) || `HTTP ${response.status}`;
          throw new Error(
            `Soniox models request failed (${response.status}): ${tailForLog(errorDetail)}`,
          );
        }
        const snapshot = cacheSonioxModels(
          normalizeSonioxModelEntryRows(payload || {}),
          Date.now(),
          false,
        );
        emitDebug(
          "voice.timeline",
          "soniox_models_prefetched",
          "info",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({
            trigger,
            count: snapshot.models.length,
            stale: snapshot.stale,
          }),
        );
        return snapshot;
      })
      .catch((err) => {
        const snapshot = Array.isArray(cachedSonioxModels)
          ? cacheSonioxModels(cachedSonioxModels, cachedSonioxModelsFetchedAt, true)
          : cacheSonioxModels([], Date.now(), true);
        emitDebug(
          "voice.timeline",
          "soniox_models_prefetch_failed",
          "warn",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({
            trigger,
            message: err && err.message ? err.message : String(err),
          }),
        );
        return snapshot;
      })
      .finally(() => {
        inFlightSonioxModelsFetch = null;
      });

    return inFlightSonioxModelsFetch;
  }

  async function mintSonioxTemporaryKey(clientId, request) {
    const voiceSessionId = pickTrimmedString(request && request.voiceSessionId);
    if (!voiceSessionId) {
      throw new Error("voiceSessionId is required");
    }

    const sessionKey = pickTrimmedString(request && request.sessionKey) || null;
    const nowMs = Date.now();
    const resolvedSessionKey = sessionKey || sessionService.peekSessionKey() || undefined;
    const emitIssued = (normalized, source) => {
      logger.info(
        `[relay] soniox temp key issued: clientId=${clientId} voiceSessionId=${voiceSessionId} source=${source} expiresAtMs=${normalized.expiresAtMs}`,
      );
      emitDebug(
        "voice.timeline",
        "soniox_temp_key_issued",
        "info",
        { sessionKey: resolvedSessionKey },
        () => ({
          clientId,
          voiceSessionId,
          expiresAtMs: normalized.expiresAtMs,
          source,
        }),
      );
      return normalized;
    };

    try {
      emitDebug(
        "voice.timeline",
        "soniox_temp_key_requested",
        "info",
        { sessionKey: resolvedSessionKey },
        () => ({
          clientId,
          voiceSessionId,
          expiresInSeconds: sonioxTemporaryKeyExpiresInSeconds,
        }),
      );

      if (typeof opts.createSonioxTemporaryKey === "function") {
        const overrideResult = await Promise.resolve(
          opts.createSonioxTemporaryKey({
            voiceSessionId,
            sessionKey,
            expiresInSeconds: sonioxTemporaryKeyExpiresInSeconds,
          }),
        );
        return emitIssued(
          normalizeSonioxTemporaryKeyResult(
            overrideResult || {},
            voiceSessionId,
            nowMs,
          ),
          "override",
        );
      }

      if (!configuredSonioxApiKey) {
        throw new Error("Soniox API key is not configured");
      }

      const fetchImpl = resolveFetchImpl();
      if (!fetchImpl) {
        throw new Error("fetch is not available for Soniox temporary-key minting");
      }

      const mintAbortController = new AbortController();
      const mintTimeoutTimer = setTimeout(
        () => mintAbortController.abort(),
        sonioxTemporaryKeyMintTimeoutMs,
      );
      let response;
      try {
        response = await fetchImpl(SONIOX_TEMP_KEY_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configuredSonioxApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            usage_type: "transcribe_websocket",
            expires_in_seconds: sonioxTemporaryKeyExpiresInSeconds,
            client_reference_id: voiceSessionId,
          }),
          signal: mintAbortController.signal,
        });
      } finally {
        clearTimeout(mintTimeoutTimer);
      }

      const rawText =
        response && typeof response.text === "function"
          ? await response.text()
          : "";
      let payload = {};
      if (rawText) {
        try {
          payload = JSON.parse(rawText);
        } catch (err) {
          if (!response.ok) {
            throw new Error(
              `Soniox temporary-key request failed (${response.status}): ${tailForLog(rawText)}`,
            );
          }
          throw new Error(
            `Soniox temporary-key response was not valid JSON (${response.status})`,
          );
        }
      }

      if (!response.ok) {
        const errorDetail = pickTrimmedString(
          payload && payload.error,
          payload && payload.message,
          payload && payload.detail,
          rawText,
        ) || `HTTP ${response.status}`;
        throw new Error(
          `Soniox temporary-key request failed (${response.status}): ${tailForLog(errorDetail)}`,
        );
      }

      return emitIssued(
        normalizeSonioxTemporaryKeyResult(
          payload || {},
          voiceSessionId,
          nowMs,
        ),
        "soniox_api",
      );
    } catch (err) {
      const message =
        err && err.message
          ? err.message
          : "Soniox temporary-key request failed";
      const code = normalizeSonioxTemporaryKeyErrorCode(err);
      logger.warn(
        `[relay] soniox temp key failed: clientId=${clientId} voiceSessionId=${voiceSessionId} code=${code} message=${tailForLog(message)}`,
      );
      emitDebug(
        "voice.timeline",
        "soniox_temp_key_failed",
        "warn",
        { sessionKey: resolvedSessionKey },
        () => ({
          clientId,
          voiceSessionId,
          code,
          message: tailForLog(message),
        }),
      );
      throw err;
    }
  }

  function normalizeCartesiaAccessTokenResult(result, voiceSessionId, nowMs) {
    const accessToken =
      pickTrimmedString(result && (result.accessToken || result.token)) || "";
    if (!accessToken) {
      throw new Error("Cartesia access-token response missing token");
    }
    const expiresInSeconds = Number.isFinite(result && result.expiresInSeconds)
      ? result.expiresInSeconds
      : cartesiaAccessTokenExpiresInSeconds;
    const expiresAtMs = Number.isFinite(result && result.expiresAtMs)
      ? Math.floor(result.expiresAtMs)
      : Math.floor(nowMs + expiresInSeconds * 1000);
    return { voiceSessionId, accessToken, expiresAtMs };
  }

  async function mintCartesiaAccessToken(clientId, request) {
    const voiceSessionId = pickTrimmedString(request && request.voiceSessionId);
    if (!voiceSessionId) {
      throw new Error("voiceSessionId is required");
    }
    const sessionKey = pickTrimmedString(request && request.sessionKey) || null;
    const nowMs = Date.now();
    const resolvedSessionKey = sessionKey || sessionService.peekSessionKey() || undefined;
    const emitIssued = (normalized, source) => {
      logger.info(
        `[relay] cartesia access token issued: clientId=${clientId} voiceSessionId=${voiceSessionId} source=${source} expiresAtMs=${normalized.expiresAtMs}`,
      );
      emitDebug(
        "voice.timeline",
        "cartesia_access_token_issued",
        "info",
        { sessionKey: resolvedSessionKey },
        () => ({ clientId, voiceSessionId, expiresAtMs: normalized.expiresAtMs, source }),
      );
      return normalized;
    };

    try {
      if (typeof opts.createCartesiaAccessToken === "function") {
        const overrideResult = await Promise.resolve(
          opts.createCartesiaAccessToken({
            voiceSessionId,
            sessionKey,
            expiresInSeconds: cartesiaAccessTokenExpiresInSeconds,
          }),
        );
        return emitIssued(
          normalizeCartesiaAccessTokenResult(overrideResult || {}, voiceSessionId, nowMs),
          "override",
        );
      }

      if (!configuredCartesiaApiKey) {
        throw new Error("Cartesia API key is not configured");
      }
      const fetchImpl = resolveFetchImpl();
      if (!fetchImpl) {
        throw new Error("fetch is not available for Cartesia access-token minting");
      }

      const mintAbortController = new AbortController();
      const mintTimeoutTimer = setTimeout(
        () => mintAbortController.abort(),
        cartesiaAccessTokenMintTimeoutMs,
      );
      let response;
      try {
        response = await fetchImpl(CARTESIA_ACCESS_TOKEN_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configuredCartesiaApiKey}`,
            "Cartesia-Version": CARTESIA_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            grants: { stt: true },
            expires_in: cartesiaAccessTokenExpiresInSeconds,
          }),
          signal: mintAbortController.signal,
        });
      } finally {
        clearTimeout(mintTimeoutTimer);
      }

      const rawText =
        response && typeof response.text === "function" ? await response.text() : "";
      let payload = {};
      if (rawText) {
        try {
          payload = JSON.parse(rawText);
        } catch (err) {
          throw new Error(
            `Cartesia access-token response was not valid JSON (${response.status})`,
          );
        }
      }
      if (!response.ok) {
        const errorDetail =
          pickTrimmedString(
            payload && payload.message,
            payload && payload.error,
            rawText,
          ) || `HTTP ${response.status}`;
        throw new Error(
          `Cartesia access-token request failed (${response.status}): ${tailForLog(errorDetail)}`,
        );
      }

      return emitIssued(
        normalizeCartesiaAccessTokenResult(
          { token: payload && payload.token },
          voiceSessionId,
          nowMs,
        ),
        "cartesia_api",
      );
    } catch (err) {
      const message = err && err.message ? err.message : "Cartesia access-token request failed";
      logger.warn(
        `[relay] cartesia access token failed: clientId=${clientId} voiceSessionId=${voiceSessionId} message=${tailForLog(message)}`,
      );
      emitDebug(
        "voice.timeline",
        "cartesia_access_token_failed",
        "warn",
        { sessionKey: resolvedSessionKey },
        () => ({ clientId, voiceSessionId, message: tailForLog(message) }),
      );
      throw err;
    }
  }

  let upstreamRuntime = JSON.parse("null");
  const evenAiSettingsStore = createEvenAiSettingsStore({
    logger,
    emitDebug,
    stateDir: opts.stateDir,
    defaults: {
      routingMode: opts.evenAiRoutingMode,
      systemPrompt: opts.evenAiSystemPrompt,
    },
  });
  const ocuClawSettingsStore = createOcuClawSettingsStore({
    logger,
    emitDebug,
    stateDir: opts.stateDir,
    defaults: {
      systemPrompt: opts.ocuClawSystemPrompt,
    },
  });
  const setOcuClawLocalSettings =
    typeof opts.setOcuClawSettings === "function"
      ? opts.setOcuClawSettings
      : (patch = {}) => ocuClawSettingsStore.setSettings(patch);

  async function getOcuClawSettingsSnapshot() {
    const local = ocuClawSettingsStore.getSnapshot();
    if (
      getActiveBackendKind() !== "hermes" ||
      typeof opts.getOcuClawProfileOptions !== "function"
    ) {
      return local;
    }
    const profile = await opts.getOcuClawProfileOptions({
      sessionKey: sessionService && sessionService.ensureSessionKey(),
    });
    return {
      ...local,
      defaultModel:
        profile && typeof profile.defaultModel === "string"
          ? profile.defaultModel
          : "",
      defaultThinking:
        profile && typeof profile.defaultThinking === "string"
          ? profile.defaultThinking
          : "",
      defaultFastMode: !!(profile && profile.defaultFastMode === true),
    };
  }
  function getEvenAiEndpointSettingsSnapshot() {
    const evenAiSettings = evenAiSettingsStore.getSnapshot();
    const ocuClawSettings = ocuClawSettingsStore.getSnapshot();
    return {
      ...evenAiSettings,
      pathways: ocuClawSettings.pathways,
      evenAi: ocuClawSettings.evenAi,
    };
  }
  let appBindingMismatchLogged = false;
  function getAppPathwayAgentRef() {
    const pathways = ocuClawSettingsStore.getSnapshot().pathways;
    const app =
      pathways && typeof pathways === "object"
        ? Reflect.get(pathways, "app")
        : null;
    const rawBinding =
      app && typeof app === "object" ? Reflect.get(app, "binding") : null;
    const binding = Object.assign(
      { backend: "", agentRef: "" },
      rawBinding && typeof rawBinding === "object" ? rawBinding : {},
    );
    const localBackendKind = getActiveBackendKind();
    if (binding.backend && binding.backend !== localBackendKind) {
      if (!appBindingMismatchLogged) {
        appBindingMismatchLogged = true;
        logger.warn(
          `[relay] pathways.app binding targets ${binding.backend}; ` +
            `local backend is ${localBackendKind}, using the local default`,
        );
      }
      return "";
    }
    appBindingMismatchLogged = false;
    return typeof binding.agentRef === "string" ? binding.agentRef.trim() : "";
  }

  const stablePromptSnapshots = createStablePromptSnapshotStore({
    stateDir: opts.stateDir,
    emitDebug,
  });

  let stablePromptSweepTimer = null;

  let uploadCaptureArmingDisposer = null;

  function computeStableChannelOne(startSignals) {
    const baseReadability = composeReadabilitySystemPrompt(
      ocuClawSettingsStore.getSnapshot().systemPrompt,
    );
    const display = composeGlassesDisplaySystemPrompt({
      emoji: startSignals.emoji,
      pace: startSignals.pace,
    });
    const glassesPointer = composeGlassesUiNudgeSystemPrompt();
    const parts = [];
    if (baseReadability) parts.push(baseReadability);
    if (display) parts.push(display);
    if (glassesPointer) parts.push(glassesPointer);
    parts.push(LIVEUI_TASK_DISCOVERY_CHANNEL_ONE);
    return parts.join("\n\n");
  }

  function stableSendOptions(resolvedSessionKey, sessionId, perTurnSignals) {
    const signals = perTurnSignals || {};

    const startEmoji = signals.neuralEmojiReactorState === "active";
    const startPace = signals.neuralPaceModulatorState === "active";
    const extraSystemPrompt = stablePromptSnapshots.getOrCreate(
      resolvedSessionKey,
      sessionId,
      () => computeStableChannelOne({ emoji: startEmoji, pace: startPace }),
    );

    if (
      stablePromptSnapshots.wouldChurn(
        resolvedSessionKey,
        sessionId,
        computeStableChannelOne({ emoji: startEmoji, pace: startPace }),
      )
    ) {
      emitDebug(
        "relay.session",
        "stable_prompt_churn_detected",
        "warn",
        { sessionKey: resolvedSessionKey },
        () => ({ sessionId: sessionId || null }),
      );
    }
    const options = { extraSystemPrompt };

    const agentId = sessionService.getSessionAgentId(resolvedSessionKey);
    if (
      getActiveBackendKind() !== "hermes" &&
      typeof agentId === "string" &&
      agentId.trim()
    ) {
      options.agentId = agentId.trim();
    }
    return options;
  }

  function openclawGatewayKeyFor(sessionKey) {
    if (getActiveBackendKind() === "hermes") {
      return { key: sessionKey, agentId: "" };
    }
    const agentId = sessionService.getSessionAgentId(sessionKey, undefined);
    const key = gatewaySessionKeyFor(sessionKey, agentId);
    return {
      key,
      agentId: key !== sessionKey ? agentId : "",
    };
  }

  function buildOcuClawSendDiagnostic(params = {}) {
    const attachment = params.attachment || null;
    const messageId =
      typeof params.id === "string" && params.id.trim()
        ? params.id.trim()
        : null;
    const sessionKey =
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : sessionService.ensureSessionKey();
    const source =
      typeof params.source === "string" && params.source.trim()
        ? params.source.trim()
        : "relay_send";

    return {
      messageId,
      sessionKey,
      source,
      textChars: typeof params.text === "string" ? params.text.length : 0,
      hasAttachment: !!attachment,
      attachmentBytes:
        attachment && Number.isFinite(attachment.sizeBytes)
          ? Math.floor(attachment.sizeBytes)
          : null,
    };
  }

  function buildLocalUserMessageContent(text, attachment) {
    const userContent = [];
    if (typeof text === "string" && text.trim()) {
      userContent.push({ type: "text", text });
    }
    if (attachment) {
      userContent.push({
        type: "image",
        mimeType: attachment.mimeType || null,
        fileName: attachment.name || null,
        source: attachment.source || null,
        sizeBytes:
          Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes > 0
            ? Math.floor(attachment.sizeBytes)
            : null,
        widthPx:
          Number.isFinite(attachment.widthPx) && attachment.widthPx > 0
            ? Math.floor(attachment.widthPx)
            : null,
        heightPx:
          Number.isFinite(attachment.heightPx) && attachment.heightPx > 0
            ? Math.floor(attachment.heightPx)
            : null,
      });
    }
    if (userContent.length === 0) {
      userContent.push({ type: "text", text });
    }
    return userContent;
  }

  function buildGatewayAttachment(attachment) {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      typeof attachment.base64Data !== "string" ||
      !attachment.base64Data
    ) {
      return null;
    }
    const normalizedAttachment = {
      type: attachment.kind || "image",
      mimeType: attachment.mimeType || "image/jpeg",
      fileName: attachment.name || "image.jpg",
      content: attachment.base64Data,
    };
    if (typeof attachment.source === "string" && attachment.source) {
      normalizedAttachment.source = attachment.source;
    }
    if (Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes > 0) {
      normalizedAttachment.sizeBytes = Math.floor(attachment.sizeBytes);
    }
    if (Number.isFinite(attachment.widthPx) && attachment.widthPx > 0) {
      normalizedAttachment.widthPx = Math.floor(attachment.widthPx);
    }
    if (Number.isFinite(attachment.heightPx) && attachment.heightPx > 0) {
      normalizedAttachment.heightPx = Math.floor(attachment.heightPx);
    }
    return normalizedAttachment;
  }

  function buildOcuClawInitialSessionConfigPatch(settings) {

    if (getActiveBackendKind() === "hermes") return null;
    const patch = {};
    if (settings && typeof settings.defaultModel === "string" && settings.defaultModel.trim()) {
      patch.modelRef = settings.defaultModel.trim();
    }
    if (
      settings &&
      typeof settings.defaultThinking === "string" &&
      settings.defaultThinking.trim()
    ) {
      patch.thinkingLevel = settings.defaultThinking.trim().toLowerCase();
    }
    if (settings && settings.defaultFastMode === true) {
      patch.fastMode = true;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  function seedSessionAgentDefault(sessionKey, defaultAgent) {
    if (
      getActiveBackendKind() === "hermes" ||
      !sessionKey ||
      !sessionService ||
      typeof sessionService.setSessionAgentId !== "function" ||
      typeof sessionService.getSessionAgentId !== "function"
    ) {
      return;
    }
    const normalized =
      typeof defaultAgent === "string" ? defaultAgent.trim() : "";
    if (!normalized) {
      return;
    }
    if (
      typeof sessionService.hasExplicitSessionAgent === "function" &&
      sessionService.hasExplicitSessionAgent(sessionKey)
    ) {

      return;
    }
    sessionService.setSessionAgentId(sessionKey, normalized);
  }

  async function maybeSeedOcuClawSessionConfig(sessionKey) {
    if (
      !sessionKey ||
      !sessionService ||
      typeof sessionService.hasPendingInitialConfig !== "function" ||
      !sessionService.hasPendingInitialConfig(sessionKey)
    ) {
      return;
    }

    const settings = ocuClawSettingsStore.getSnapshot();
    seedSessionAgentDefault(sessionKey, settings.defaultAgent);
    const patch = buildOcuClawInitialSessionConfigPatch(settings);
    if (!patch) {
      sessionService.clearPendingInitialConfig(sessionKey);
      return;
    }

    const result = await sessionService.setSessionModelConfig(
      sessionKey,
      patch,
      { initial: true },
    );
    if (!result || result.status !== "accepted") {
      throw new Error(
        (result && result.error) || "failed to seed OcuClaw new-session defaults",
      );
    }
    if (
      result.config &&
      sessionKey === sessionService.ensureSessionKey() &&
      server
    ) {
      server.broadcast(handler.formatSessionModelConfig(result.config));
    }
  }

  async function seedOcuClawSessionConfigForNewSession(sessionKey) {
    if (!sessionKey || !sessionService) {
      return null;
    }

    const settings = ocuClawSettingsStore.getSnapshot();
    seedSessionAgentDefault(sessionKey, settings.defaultAgent);
    const patch = buildOcuClawInitialSessionConfigPatch(settings);
    if (!patch) {
      return null;
    }

    const seededConfig =
      typeof sessionService.primeSessionModelConfig === "function"
        ? sessionService.primeSessionModelConfig(sessionKey, patch)
        : null;

    if (getActiveBackendKind() === "hermes") {
      return seededConfig;
    }
    const result = await sessionService.setSessionModelConfig(
      sessionKey,
      patch,
      { initial: true },
    );
    if (result && result.status === "accepted" && result.config) {
      return result.config;
    }
    return seededConfig;
  }

  const sessionService = createSessionService({
    logger,
    gatewayBridge,
    conversationState,
    emitDebug,
    stateDir: opts.stateDir,
    sessionLimit: opts.sessionLimit,

    defaultSessionKeyPrefix: opts.defaultSessionKeyPrefix,
    supportedSessionKeyPrefixes: opts.supportedSessionKeyPrefixes,
    sessionKeyPrefixForAgentRef: opts.sessionKeyPrefixForAgentRef,
    getDefaultSessionAgentRef: getAppPathwayAgentRef,

    sessionReadStateSupported: () =>

      parseHermesFeatureTokens(process.env.OCUCLAW_HERMES_FEATURES).includes(
        "session_read_state",
      ),
    etSessionProvider: opts.etSessionProvider,
    etHistoryProvider: opts.etHistoryProvider,
    etTranscriptSearchProvider: opts.etTranscriptSearchProvider,
    persistFirstUserMessages: opts.persistFirstUserMessages,
    strictFirstUserMessage: opts.strictFirstUserMessage,
    sessionCacheTtlMs: opts.sessionCacheTtlMs,
    getOpenclawConnected() {
      return upstreamRuntime ? upstreamRuntime.isConnected() : false;
    },
    getAgentName() {
      return upstreamRuntime ? upstreamRuntime.getAgentName() : null;
    },
    getAgentDisplayName(agentId) {
      return upstreamRuntime &&
        typeof upstreamRuntime.getAgentDisplayName === "function"
        ? upstreamRuntime.getAgentDisplayName(agentId)
        : null;
    },
    getDefaultAgentId() {
      if (getActiveBackendKind() === "hermes") {
        return "";
      }
      return normalizeOcuClawDefaultAgent(
        ocuClawSettingsStore.getSnapshot().defaultAgent,
      );
    },
    isPinnedFirstUserMessageKey(sessionKey) {
      const normalizedSessionKey = normalizeEvenAiSessionKeyForLookup(sessionKey);
      if (!normalizedSessionKey) {
        return false;
      }
      const trackedThrowawayKeys =
        typeof evenAiSettingsStore.getTrackedThrowawayKeys === "function"
          ? evenAiSettingsStore.getTrackedThrowawayKeys()
          : [];
      return dedupeNormalizedSessionKeys(trackedThrowawayKeys).some(
        (trackedKey) =>
          trackedKey.toLowerCase() === normalizedSessionKey.toLowerCase(),
      );
    },
    onSessionStateReset: resetActivityStatusAdapter,
    onPagesChanged: cachePages,
    onStatusChanged: broadcastStatus,
    onSessionModelConfig(config) {
      applyCurrentSessionModelConfigSnapshot(config);
    },
    broadcastSessions: () => broadcastSessions(),
    broadcastEvenAiSessions: () => broadcastEvenAiSessions(),
  });

  const relayHealth = createRelayHealthMonitor({
    emitDebug(event, severity, data) {
      emitDebug(
        "relay.health",
        event,
        severity,
        { sessionKey: sessionService.peekSessionKey() || undefined },
        () => data,
        { force: event === "relay_queue_depth" },
      );
    },
  });
  relayHealth.start();

  const relayOperationRegistry = createRelayOperationRegistry({
    emitDebug(event, severity, data, context = {}) {
      emitDebug(
        "relay.operation",
        event,
        severity,
        {
          sessionKey: context.sessionKey || sessionService.peekSessionKey() || undefined,
          runId: context.runId || undefined,
        },
        () => data,
      );
    },
  });

  const REMOTE_SEND_RUN_BINDING_TTL_MS = 60_000;
  const pendingRemoteSendRunBindings = new Map();

  function emitRemoteSendRunBinding(binding, payload) {
    if (!server) return;
    try {
      server.unicast(
        binding.clientId,
        JSON.stringify({
          type: "remote-control-run-bound",
          requestId: binding.requestId,
          action: "send-message",
          sessionKey: payload.sessionKey || binding.sessionKey || null,
          runId: payload.runId || null,

          runIdSource: payload.runId ? "relay_send_ack" : null,
          status: payload.status,
          error: payload.error || null,
        }),
      );
    } catch (err) {
      logger.warn(`[relay] remote-control run binding unicast failed: ${String(err)}`);
    }
  }

  function settleRemoteSendRunBinding(requestId, payload) {
    if (!requestId || !payload) return;
    const binding = pendingRemoteSendRunBindings.get(requestId);
    if (!binding) return;
    pendingRemoteSendRunBindings.delete(requestId);
    clearTimeout(binding.timer);
    emitRemoteSendRunBinding(binding, payload);
    emitDebug(
      "relay.protocol",
      "remote_control_run_bound",
      payload.runId ? "info" : "warn",
      { sessionKey: payload.sessionKey || binding.sessionKey || undefined, runId: payload.runId || undefined },
      () => ({
        requestId,
        runId: payload.runId || null,
        status: payload.status,
        elapsedMs: Date.now() - binding.armedAtMs,
      }),
    );
  }

  function armRemoteSendRunBinding({ requestId, clientId, sessionKey }) {
    if (!requestId || !clientId) return;

    const existing = pendingRemoteSendRunBindings.get(requestId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      settleRemoteSendRunBinding(requestId, { status: "unbound_timeout" });
    }, REMOTE_SEND_RUN_BINDING_TTL_MS);
    if (typeof timer.unref === "function") timer.unref();
    pendingRemoteSendRunBindings.set(requestId, {
      requestId,
      clientId,
      sessionKey: sessionKey || null,
      armedAtMs: Date.now(),
      timer,
    });
  }

  function isActiveSessionModelConfig(config) {
    return !!(
      config &&
      typeof config.sessionKey === "string" &&
      (
        typeof sessionService.isCurrentSession === "function"
          ? sessionService.isCurrentSession(config.sessionKey)
          : config.sessionKey === sessionService.ensureSessionKey()
      )
    );
  }

  function applyCurrentSessionModelConfigSnapshot(config) {
    if (!isActiveSessionModelConfig(config)) {
      return false;
    }
    currentSessionModelConfigSnapshot = config;
    if (
      upstreamRuntime &&
      typeof upstreamRuntime.handleCurrentSessionModelConfigChanged === "function"
    ) {
      upstreamRuntime.handleCurrentSessionModelConfigChanged().catch((err) => {
        logger.warn(`[relay] Provider usage rebroadcast failed after session config update: ${err.message}`);
      });
    }
    return true;
  }

  function clearCurrentSessionModelConfigSnapshot(trigger) {
    currentSessionModelConfigSnapshot = null;
    if (
      upstreamRuntime &&
      typeof upstreamRuntime.handleCurrentSessionModelConfigCleared === "function"
    ) {
      upstreamRuntime.handleCurrentSessionModelConfigCleared().catch((err) => {
        logger.warn(`[relay] Provider usage clear broadcast failed after ${trigger}: ${err.message}`);
      });
    }
  }

  const SESSION_TITLE_STATUS_FALLBACK_MS = 1500;
  let sessionTitleStatusFallbackTimer = null;

  function broadcastActivity(rawActivity) {
    const activity = activityStatusAdapter.augmentActivity(rawActivity || {});
    const runId = activity && activity.runId ? activity.runId : null;
    const origin = activity && activity.origin ? activity.origin : null;
    const phase = activity && activity.phase ? activity.phase : null;
    agentTurnTracker.onActivity(
      (activity && activity.sessionKey) || sessionService.ensureSessionKey(),
      phase,

      runId,
    );
    if (phase === "end" && liveuiTaskRunController) {
      liveuiTaskRunController.observeTurnIdle(
        (activity && activity.sessionKey) || sessionService.ensureSessionKey(),
      );
    }

    emitDebug(
      "app.timeline",
      "activity",
      "debug",
      {
        sessionKey: (activity && activity.sessionKey) || sessionService.ensureSessionKey(),
        runId,
      },
      () => ({
        state: (activity && activity.state) || null,
        tool: (activity && activity.tool) || null,
        label: (activity && activity.label) || null,
        intent: (activity && activity.intent) || null,
        thinkingSummarySource: (activity && activity.thinkingSummarySource) || null,
        category: (activity && activity.category) || null,
        isError: typeof activity.isError === "boolean" ? activity.isError : null,
        code: (activity && activity.code) || null,
        activityId: (activity && activity.activityId) || null,
        seq: Number.isFinite(activity && activity.seq) ? activity.seq : null,
        origin,
        phase,
      }),
    );

    emitDebug(
      "activity.status",
      "activity_resolved",
      "debug",
      {
        sessionKey: (activity && activity.sessionKey) || sessionService.ensureSessionKey(),
        runId,
      },
      () => ({
        state: (activity && activity.state) || null,
        label: (activity && activity.label) || null,
        summary: (activity && activity.summary) || null,
        thinkingSummarySource: (activity && activity.thinkingSummarySource) || null,
        candidateRank: (activity && activity.candidateRank) || null,
        category: (activity && activity.category) || null,
        origin,
        phase,
        toolPhase: (activity && activity.toolPhase) || null,
        tool: (activity && activity.tool) || null,
        activityId: (activity && activity.activityId) || null,
        seq: Number.isFinite(activity && activity.seq) ? activity.seq : null,
      }),
    );

    server.broadcast(handler.formatActivity(activity));

    if (sessionTitleStatusFallbackTimer) {
      clearTimeout(sessionTitleStatusFallbackTimer);
      sessionTitleStatusFallbackTimer = null;
    }
    if (
      activity &&
      activity.tool === "set_session_title" &&
      phase !== "end" &&
      origin !== "synthetic_session_title_fallback"
    ) {
      const fallbackSessionKey = activity.sessionKey || null;
      const fallbackRunId = runId;
      sessionTitleStatusFallbackTimer = setTimeout(() => {
        sessionTitleStatusFallbackTimer = null;
        broadcastActivity({
          state: "thinking",
          sessionKey: fallbackSessionKey,
          runId: fallbackRunId,
          origin: "synthetic_session_title_fallback",
          phase: "update",
        });
      }, SESSION_TITLE_STATUS_FALLBACK_MS);
    }

    return activity;
  }

  function emitSimulatedActivity(rawActivity = JSON.parse("{}"), { nativeLifecycle = false } = {}) {

    if (rawActivity.origin === "lifecycle" && rawActivity.phase === "start") {
      flushPendingCommitPublish(
        typeof rawActivity.sessionKey === "string" ? rawActivity.sessionKey : "",
      );
    }
    if (
      nativeLifecycle &&
      upstreamRuntime &&
      typeof upstreamRuntime.ingestActivityFrame === "function"
    ) {

      upstreamRuntime.ingestActivityFrame(rawActivity);
      return;
    }
    return broadcastActivity(rawActivity);
  }

  function simulatedRunKey(runId = "", sessionKey = "") {
    return JSON.stringify([sessionKey || "", runId]);
  }

  function simulatedThinkingFrame(runId = "", sessionKey = "", summary = "") {
    return {
      state: "thinking",
      sessionKey,
      runId,
      origin: "thinking",
      phase: "update",
      summary,
    };
  }

  function cancelSimulatedThinkingHeartbeat(key = "") {
    const entry = simulateThinkingHeartbeats.get(key);
    if (!entry) return false;
    simulateThinkingHeartbeats.delete(key);
    clearInterval(entry.timer);
    return true;
  }

  function expireSimulatedThinkingHeartbeat(entry = JSON.parse("null")) {
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.timer = null;
    entry.expired = true;
  }

  function emitSimulatedThinkingHeartbeat(entry = JSON.parse("null")) {
    if (simulateThinkingHeartbeats.get(entry.key) !== entry) return false;
    if (!simulateOpenRuns.has(entry.key)) {
      cancelSimulatedThinkingHeartbeat(entry.key);
      return false;
    }
    if (
      entry.expired ||
      Date.now() - entry.startedAtMs >= SIMULATE_THINKING_HEARTBEAT_CEILING_MS
    ) {
      expireSimulatedThinkingHeartbeat(entry);
      return false;
    }
    emitSimulatedActivity(entry.frame, { nativeLifecycle: true });
    return true;
  }

  function startOrUpdateSimulatedThinkingHeartbeat(runId = "", sessionKey = "", summary = "") {
    const key = simulatedRunKey(runId, sessionKey);
    const frame = simulatedThinkingFrame(runId, sessionKey, summary);
    const existing = simulateThinkingHeartbeats.get(key);
    if (existing) {
      existing.frame = frame;
      return existing;
    }

    const expired = simulateResponseStartedRuns.has(key);
    const entry = {
      key,
      sessionKey,
      runId,
      frame,
      startedAtMs: Date.now(),

      timer: JSON.parse("null"),
      expired,
    };
    if (!expired) {
      entry.timer = setInterval(
        () => emitSimulatedThinkingHeartbeat(entry),
        SIMULATE_THINKING_HEARTBEAT_INTERVAL_MS,
      );
      if (typeof entry.timer.unref === "function") entry.timer.unref();
    }
    simulateThinkingHeartbeats.set(key, entry);
    return entry;
  }

  function findSimulatedThinkingHeartbeatForSession(sessionKey = "") {
    let match = null;
    for (const entry of simulateThinkingHeartbeats.values()) {
      if (entry.sessionKey === sessionKey) match = entry;
    }
    return match;
  }

  function ensureSimulatedRunOpen(runId = "", sessionKey = "", { nativeLifecycle = false } = {}) {
    const key = simulatedRunKey(runId, sessionKey);
    if (!nativeLifecycle || simulateCompletedRuns.has(key)) {
      return false;
    }
    if (simulateOpenRuns.has(key)) return true;
    simulateOpenRuns.add(key);
    emitSimulatedActivity({
      state: "thinking",
      sessionKey,
      runId,
      origin: "lifecycle",
      phase: "start",
    }, { nativeLifecycle });
    return true;
  }

  function emitSimulatedRunComplete(runId = "", sessionKey = "", { nativeLifecycle = false } = {}) {
    const key = simulatedRunKey(runId, sessionKey);
    if (nativeLifecycle) cancelSimulatedThinkingHeartbeat(key);
    if (!nativeLifecycle || simulateCompletedRuns.has(key)) {
      return false;
    }
    ensureSimulatedRunOpen(runId, sessionKey, { nativeLifecycle });
    simulateOpenRuns.delete(key);
    simulateCompletedRuns.add(key);
    simulateResponseStartedRuns.delete(key);
    emitSimulatedActivity({
      state: "idle",
      sessionKey,
      runId,
      origin: "lifecycle",
      phase: "end",
      category: "run_complete_synth",
      activityId: `run-complete-synth-${runId}`,
    }, { nativeLifecycle });
    return true;
  }

  function pruneSyntheticApprovals(nowMs) {
    for (const [id, entry] of syntheticApprovals) {
      if (entry.expiresAtMs + 60_000 < nowMs) syntheticApprovals.delete(id);
    }
  }

  function resolveSyntheticApproval(approvalId, decision, source) {
    const entry = syntheticApprovals.get(approvalId);
    if (!entry) return false;
    if (!entry.resolved) {
      entry.resolved = true;
      entry.decision = decision;
      if (server && handler) {
        server.broadcast(handler.formatApprovalResolved({ id: approvalId, decision }));
      }
      emitDebug(
        "approvals.timeline",
        "approval_resolved",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({ approvalId, decision, synthetic: true, source }),
      );
      const heartbeat = entry.heartbeatKey
        ? simulateThinkingHeartbeats.get(entry.heartbeatKey)
        : null;
      if (heartbeat) emitSimulatedThinkingHeartbeat(heartbeat);
    }
    return true;
  }

  function broadcastProviderUsageSnapshot(snapshot) {
    if (!server || !handler || typeof handler.formatProviderUsageSnapshot !== "function") {
      return snapshot;
    }
    server.broadcast(handler.formatProviderUsageSnapshot(snapshot || {}));
    return snapshot;
  }

  function broadcastSkillsCatalog(snapshot) {
    if (!server || !handler || typeof handler.formatSkillsCatalog !== "function") {
      return snapshot;
    }
    server.broadcast(handler.formatSkillsCatalog(snapshot || {}));
    return snapshot;
  }

  function broadcastCommandCatalog(snapshot) {
    if (!server || !handler || typeof handler.formatCommandCatalog !== "function") {
      return snapshot;
    }
    server.broadcast(handler.formatCommandCatalog(snapshot || {}));
    return snapshot;
  }

  function buildCapabilitySnapshotFrame(agentCatalogSnapshot, options = {}) {
    const snapshot = buildCapabilitySnapshot({
      source: getActiveBackendKind(),
      stale: options.stale === true,
      evenTerminalEnabled: opts.evenTerminalEnabled === true,
      sessionOptionsSupported:
        opts.hermesSessionOptionsSupported === true,
      agentCatalogSnapshot,

      hermesFeatures: parseHermesFeatureTokens(process.env.OCUCLAW_HERMES_FEATURES),
    });
    return handler.formatCapabilitySnapshot(snapshot);
  }

  function getCapabilityAgentCatalogSnapshot() {
    if (
      upstreamRuntime &&
      typeof upstreamRuntime.getAgentsCatalogSnapshot === "function"
    ) {
      return Promise.resolve(upstreamRuntime.getAgentsCatalogSnapshot()).catch((err) => {
        logger.warn(`[relay] capability agent catalog failed: ${err.message}`);
        return {
          agents: [],
          fetchedAtMs: Date.now(),
          stale: true,
          unsupported: true,
        };
      });
    }
    return Promise.resolve({
      agents: [],
      fetchedAtMs: Date.now(),
      stale: true,
      unsupported: true,
    });
  }

  function unicastCapabilitySnapshot(clientId) {
    if (!server || !clientId) return;
    getCapabilityAgentCatalogSnapshot().then((agentCatalogSnapshot) => {
      if (!server) return;
      server.unicast(clientId, buildCapabilitySnapshotFrame(agentCatalogSnapshot));
    });
  }

  function appClientSupportsCapabilitySnapshot(entry) {
    return !!(
      entry &&
      Array.isArray(entry.clientCapabilities) &&
      entry.clientCapabilities.includes("capability-snapshot")
    );
  }

  function broadcastCapabilitySnapshot(agentCatalogSnapshot, options = {}) {
    if (!server || !handler || typeof handler.formatCapabilitySnapshot !== "function") {
      return agentCatalogSnapshot;
    }
    const frame = buildCapabilitySnapshotFrame(agentCatalogSnapshot, options);
    const clients =
      server && typeof server.getReadinessSnapshot === "function"
        ? (server.getReadinessSnapshot().clients || [])
        : [];
    for (const entry of clients) {
      if (appClientSupportsCapabilitySnapshot(entry)) {
        server.unicast(entry.clientId, frame);
      }
    }
    return agentCatalogSnapshot;
  }

  function broadcastPushMessage(payload) {
    if (!server || !handler || typeof handler.formatPushMessage !== "function") {
      return null;
    }
    const frame = buildPushMessage(payload || {});
    server.broadcast(handler.formatPushMessage(frame));
    return frame;
  }

  function executorRegistryAgents(agents) {
    if (!Array.isArray(agents)) return [];
    return agents
      .map((entry = {}) => {
        const agentId = typeof entry.id === "string"
          ? entry.id.trim()
          : typeof entry.agentId === "string"
            ? entry.agentId.trim()
            : "";
        if (!agentId) return null;
        const name = typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : agentId;
        const emoji = typeof entry.emoji === "string" ? entry.emoji.trim() : "";
        return { agentId, name, ...(emoji ? { emoji } : {}) };
      })
      .filter(Boolean);
  }

  function readLiveuiExecutorRegistry() {
    try {
      return liveuiExecutorRegistry.readAll();
    } catch (err) {
      logger.warn(`[relay] LiveUI Executor registry read failed: ${err && err.message ? err.message : err}`);
      return [];
    }
  }

  function updateLiveuiExecutorRegistry(snapshot) {
    if (
      !snapshot ||
      snapshot.stale === true ||
      snapshot.unsupported === true ||
      !Array.isArray(snapshot.agents)
    ) return snapshot;
    liveuiAgents = snapshot.agents.map((entry) => ({ ...entry }));
    const publication = {
      host: relayBackendKind,
      agents: executorRegistryAgents(snapshot.agents),
      online: true,
    };
    try {
      if (!liveuiExecutorRegistryStarted) {
        liveuiExecutorRegistry.startHeartbeat(publication);
        liveuiExecutorRegistryStarted = true;
      } else {
        liveuiExecutorRegistry.updateHeartbeat(publication);
      }
    } catch (err) {
      logger.warn(`[relay] LiveUI Executor registry publish failed: ${err && err.message ? err.message : err}`);
    }
    return snapshot;
  }

  function resolveLiveuiTaskExecutorState(
    executor,
    version = {},
    agents = liveuiAgents,
  ) {
    return projectTaskExecutorState({
      executor,
      context: version && version.context,
      thisHost: relayBackendKind,
      liveAgents: Array.isArray(agents) ? agents : [],
      backendOnline: !!(upstreamRuntime && upstreamRuntime.isConnected()),
      registry: readLiveuiExecutorRegistry(),
    });
  }

  async function listLiveuiTaskExecutors() {
    const catalog = await getCapabilityAgentCatalogSnapshot();
    updateLiveuiExecutorRegistry(catalog);
    const localCatalogIncompatible = !catalog ||
      catalog.unsupported === true ||
      catalog.stale === true ||
      !Array.isArray(catalog.agents);
    const registry = readLiveuiExecutorRegistry();
    const localRecord = registry.find((record) => record && record.host === relayBackendKind);
    const localLastSeenAt = localRecord && Number.isSafeInteger(localRecord.updatedAt)
      ? localRecord.updatedAt
      : catalog && Number.isSafeInteger(catalog.fetchedAtMs)
        ? catalog.fetchedAtMs
        : Date.now();
    const executors = [];
    const seen = new Set();
    const pushOption = (host, agent, lastSeenAt, stateInput) => {
      if (!agent || typeof agent.agentId !== "string" || !agent.agentId.trim()) return;
      const agentId = agent.agentId.trim();
      const key = `${host}:${agentId.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      const projected = stateInput || resolveLiveuiTaskExecutorState({ host, agentId });
      executors.push({
        host,
        agentId,
        name: typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : agentId,
        ...(typeof agent.emoji === "string" && agent.emoji.trim()
          ? { emoji: agent.emoji.trim() }
          : {}),
        state: projected.state === "ready" ? "available" : projected.reason,
        lastSeenAt: Number.isSafeInteger(lastSeenAt) ? lastSeenAt : 0,
      });
    };
    for (const agent of executorRegistryAgents(liveuiAgents)) {
      pushOption(
        relayBackendKind,
        agent,
        localLastSeenAt,
        localCatalogIncompatible && !!(upstreamRuntime && upstreamRuntime.isConnected())
          ? { state: "unavailable", reason: "backend_incompatible" }
          : null,
      );
    }
    for (const record of registry) {
      if (!record || record.host === relayBackendKind || !Array.isArray(record.agents)) continue;
      for (const agent of record.agents) {
        pushOption(
          record.host,
          agent,
          record.updatedAt,
          { state: "unavailable", reason: "host_not_connected" },
        );
      }
    }
    return { thisHost: relayBackendKind, executors };
  }

  function stopLiveuiExecutorRegistry() {
    if (!liveuiExecutorRegistryStarted) return null;
    try {
      const stopped = liveuiExecutorRegistry.stop();
      liveuiExecutorRegistryStarted = false;
      return stopped;
    } catch (err) {
      logger.warn(`[relay] LiveUI Executor registry offline publish failed: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  function broadcastAgentsCatalog(snapshot) {
    updateLiveuiExecutorRegistry(snapshot);
    if (!server || !handler || typeof handler.formatAgentsCatalog !== "function") {
      return snapshot;
    }

    const agents =
      snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
    if (agents.length === 0 && !(snapshot && snapshot.unsupported)) {
      return snapshot;
    }
    server.broadcast(handler.formatAgentsCatalog(snapshot || {}));
    broadcastCapabilitySnapshot(snapshot || {});
    return snapshot;
  }

  const appClientDisconnectHandlers = new Set();
  function onAppClientDisconnect(handler) {
    if (typeof handler !== "function") return () => {};
    appClientDisconnectHandlers.add(handler);
    return () => appClientDisconnectHandlers.delete(handler);
  }
  function dispatchAppClientDisconnect(sessionKey) {
    for (const handler of appClientDisconnectHandlers) {
      try { handler({ sessionKey }); } catch (err) {
        logger.warn(`[relay] app_client_disconnect handler threw: ${err && err.message ? err.message : err}`);
      }
    }
    if (liveuiTaskRunController) {
      liveuiTaskRunController.observeSessionEnd({
        sessionKey: sessionKey || "",
        reason: "glasses_disconnected",
      });
    }
  }

  const appPresenceChangedHandlers = new Set();
  function onAppPresenceChanged(handler) {
    if (typeof handler !== "function") return () => {};
    appPresenceChangedHandlers.add(handler);
    return () => appPresenceChangedHandlers.delete(handler);
  }
  function dispatchAppPresenceChanged(reason) {
    for (const handler of appPresenceChangedHandlers) {
      try { handler({ reason }); } catch (err) {
        logger.warn(`[relay] app_presence_changed handler threw: ${err && err.message ? err.message : err}`);
      }
    }
  }

  const pairingCompletedHandlers = new Set();
  function onPairingCompleted(handler) {
    if (typeof handler !== "function") return () => {};
    pairingCompletedHandlers.add(handler);
    return () => pairingCompletedHandlers.delete(handler);
  }
  function dispatchPairingCompleted(completionId) {
    for (const handler of pairingCompletedHandlers) {
      try { handler(completionId); } catch (err) {
        logger.warn(`[relay] pairing_completed handler threw: ${err && err.message ? err.message : err}`);
      }
    }
  }

  const logicalSessionResetHandlers = new Set();
  function ensureLiveUiSessionGeneration(sessionKey) {
    const normalizedSessionKey = normalizeAppSessionKeyForCompare(sessionKey);
    if (!normalizedSessionKey) return null;
    const existing = liveUiSessionGenerations.get(normalizedSessionKey);
    if (existing) return existing;
    const generation = `${liveUiSessionGenerationBootId}:${++liveUiSessionGenerationSeq}`;
    liveUiSessionGenerations.set(normalizedSessionKey, generation);
    return generation;
  }
  function rotateLiveUiSessionGeneration(sessionKey) {
    const normalizedSessionKey = normalizeAppSessionKeyForCompare(sessionKey);
    if (!normalizedSessionKey) return null;
    const generation = `${liveUiSessionGenerationBootId}:${++liveUiSessionGenerationSeq}`;
    liveUiSessionGenerations.set(normalizedSessionKey, generation);
    return generation;
  }
  function onLogicalSessionReset(handler) {
    if (typeof handler !== "function") return () => {};
    logicalSessionResetHandlers.add(handler);
    return () => logicalSessionResetHandlers.delete(handler);
  }
  function dispatchLogicalSessionReset(sessionKey, reason) {
    const normalizedSessionKey =
      typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
    if (!normalizedSessionKey) return;
    const normalizedReason =
      typeof reason === "string" && reason.trim() ? reason.trim() : "logical_reset";
    const liveUiSessionGeneration = rotateLiveUiSessionGeneration(normalizedSessionKey);
    for (const handler of logicalSessionResetHandlers) {
      try {
        handler({
          sessionKey: normalizedSessionKey,
          reason: normalizedReason,
          liveUiSessionGeneration,
        });
      } catch (err) {
        logger.warn(`[relay] logical_session_reset handler threw: ${String(err)}`);
      }
    }
    if (liveuiTaskRunController) {
      liveuiTaskRunController.observeSessionEnd({
        sessionKey: normalizedSessionKey,
        reason: "session_reset",
      });
    }
    broadcastGlassesUiSessionReset(
      normalizedSessionKey,
      normalizedReason,
      liveUiSessionGeneration,
    );
  }

  function broadcastGlassesUiSessionReset(
    normalizedSessionKey,
    normalizedReason,
    liveUiSessionGeneration,
  ) {
    if (server) {
      server.broadcast(
        JSON.stringify({
          type: "glasses_ui_session_reset",
          sessionKey: normalizedSessionKey,
          reason: normalizedReason,
          liveUiSessionGeneration,
        }),
      );
    }
    emitDebug(
      "glasses.lifecycle",
      "session_reset_send",
      "info",
      { sessionKey: normalizedSessionKey },
      () => ({ reason: normalizedReason, liveUiSessionGeneration }),
      {},
    );

    broadcastStatus();
  }

  function clearGlassesUiSurfacesOnly(sessionKey, reason) {
    const normalizedSessionKey =
      typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
    if (!normalizedSessionKey) return null;
    const normalizedReason =
      typeof reason === "string" && reason.trim() ? reason.trim() : "logical_reset";
    const liveUiSessionGeneration = rotateLiveUiSessionGeneration(normalizedSessionKey);
    broadcastGlassesUiSessionReset(
      normalizedSessionKey,
      normalizedReason,
      liveUiSessionGeneration,
    );
    return liveUiSessionGeneration;
  }
  function clearLogicalSessionState(sessionKey, reason) {
    sessionService.clearLogicalSessionState(sessionKey);
    dispatchLogicalSessionReset(sessionKey, reason);
  }

  const glassesUiResultHandlers = new Set();

  function sendGlassesUiRender(params) {
    if (!server) return;
    const sessionKey = params && typeof params.sessionKey === "string" ? params.sessionKey : null;
    const payload = {
      type: "glasses_ui_render",
      sessionKey,
      liveUiSessionGeneration: ensureLiveUiSessionGeneration(sessionKey),
      surfaceId: params && typeof params.surfaceId === "string" ? params.surfaceId : "",

      seq: Number.isFinite(params && params.seq) ? Math.floor(params.seq) : null,
      depth: Number.isFinite(params && params.depth) ? Math.floor(params.depth) : 1,
      spec: params && params.spec ? params.spec : null,
      marker: sanitizeGlassesMarker(params && params.marker),
    };
    server.broadcast(JSON.stringify(payload));
    emitDebug(
      "glasses.lifecycle",
      "surface_send",
      "debug",
      { sessionKey: payload.sessionKey || undefined },
      () => ({ surfaceId: payload.surfaceId, mode: "render", seq: payload.seq, depth: payload.depth, ...summarizeGlassesUiContent(payload.spec) }),
    );
  }

  function sendDemand(params) {
    if (!server || !params) return;
    const options = Array.isArray(params.options)
      ? params.options
          .filter((option) => option && typeof option.label === "string" && option.label)
          .map((option) => ({
            label: option.label,
            detail: typeof option.detail === "string" ? option.detail : null,
          }))
      : [];
    const payload = {
      type: "demand",
      surfaceId: typeof params.surfaceId === "string" ? params.surfaceId : "",
      sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : null,
      kind: params.kind === "permission" ? "permission" : "question",
      title: typeof params.title === "string" ? params.title : "",
      question: typeof params.question === "string" ? params.question : "",
      deadlineSec:
        Number.isFinite(params.deadlineSec) && params.deadlineSec > 0
          ? Math.floor(params.deadlineSec)
          : 60,

      questionIndex: Number.isInteger(params.questionIndex) ? params.questionIndex : 0,
      questionCount: Number.isInteger(params.questionCount) ? params.questionCount : 0,
      presentation: params.presentation === "adaptive" ? "adaptive" : "reel",
      selectionMode:
        params.selectionMode === "multi" || params.selectionMode === "open"
          ? params.selectionMode
          : "single",
      allowOther: params.allowOther === true,
      options,
    };
    if (
      !payload.surfaceId ||
      !payload.question ||
      (payload.options.length === 0 && payload.selectionMode !== "open")
    ) return;
    server.broadcast(JSON.stringify(payload));
    emitDebug(
      "glasses.lifecycle",
      "demand_send",
      "debug",
      { sessionKey: payload.sessionKey || undefined },
      () => ({
        surfaceId: payload.surfaceId,
        kind: payload.kind,
        options: payload.options.length,
        deadlineSec: payload.deadlineSec,
        presentation: payload.presentation,
        selectionMode: payload.selectionMode,
        allowOther: payload.allowOther,
      }),
      undefined,
    );
  }

  function sendDemandDismiss(params) {
    if (!server || !params) return;
    const surfaceId = typeof params.surfaceId === "string" ? params.surfaceId : "";
    if (!surfaceId) return;
    const payload = {
      type: "demand_dismiss",
      surfaceId,
      sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : null,
      reason: typeof params.reason === "string" ? params.reason : "resolved",
    };
    server.broadcast(JSON.stringify(payload));
    emitDebug(
      "glasses.lifecycle",
      "demand_dismiss_send",
      "debug",
      { sessionKey: payload.sessionKey || undefined },
      () => ({ surfaceId: payload.surfaceId, reason: payload.reason }),
      undefined,
    );
  }

  function applyConfirmedHermesReset(result = {}) {
    const sessionKey =
      typeof result.sessionKey === "string" && result.sessionKey
        ? result.sessionKey
        : sessionService.ensureSessionKey();
    if (!sessionService.isCurrentSession(sessionKey)) return false;
    sessionService.invalidateSessionsCache();
    resetActivityStatusAdapter();
    clearSyntheticWorkForSession(sessionKey);
    conversationState.clear();
    stablePromptSnapshots.evict(sessionKey);
    clearLogicalSessionState(sessionKey, "hermes_slash_reset_confirmed");
    if (upstreamRuntime && typeof upstreamRuntime.clearTyping === "function") {
      upstreamRuntime.clearTyping("hermes_slash_reset_confirmed");
    }
    conversationState.setAgentName(
      (upstreamRuntime ? upstreamRuntime.getAgentName() : null) || "Agent",
    );
    broadcastPages();
    emitDebug(
      "relay.session",
      "reset_receipt_removed",
      "info",
      { sessionKey },
      () => ({ transientStatus: "Chat reset" }),
      undefined,
    );
    return true;
  }

  const hermesSlashConfirmRouter = createHermesSlashConfirmRouter({
    hasConnectedClient: () => !!server && server.getConnectedAppCount() > 0,

    presentDecision: (request) => demandRouter.presentDecision(request),
    resolve: (request) => {
      if (typeof opts.resolveHermesSlashConfirm !== "function") {
        return Promise.resolve({
          status: "rejected",
          error: "Hermes slash confirmation resolver is unavailable",
        });
      }
      return opts.resolveHermesSlashConfirm(request);
    },
    applyReset: applyConfirmedHermesReset,
    emit: (event, data) => {
      emitDebug(
        "relay.session",
        event,
        "info",
        { sessionKey: data && data.sessionKey },
        () => data || {},
        undefined,
      );
    },
  });

  function sendGlassesUiSurfaceUpdate(params) {
    if (!server) return;
    const patch = params && params.patch ? params.patch : null;
    if (!patch) return;
    const cleanPatch = {};
    if (typeof patch.title === "string") cleanPatch.title = patch.title;
    if (typeof patch.body === "string") cleanPatch.body = patch.body;
    if (Array.isArray(patch.items)) {

      cleanPatch.items = patch.items
        .map((i) => {
          if (typeof i === "string") return i;
          if (i && typeof i === "object" && typeof i.label === "string") {
            const o = { label: i.label };
            if (typeof i.body === "string") o.body = i.body;
            return o;
          }
          return null;
        })
        .filter((i) => i !== null);
    }
    const m = sanitizeGlassesMarker(patch.marker); if (m) cleanPatch.marker = m;
    const sessionKey = params && typeof params.sessionKey === "string" ? params.sessionKey : null;
    const payload = {
      type: "glasses_ui_surface_update",
      sessionKey,
      liveUiSessionGeneration: ensureLiveUiSessionGeneration(sessionKey),
      surfaceId: params && typeof params.surfaceId === "string" ? params.surfaceId : "",

      seq: Number.isFinite(params && params.seq) ? Math.floor(params.seq) : null,
      patch: cleanPatch,
    };
    server.broadcast(JSON.stringify(payload));
    emitDebug(
      "glasses.lifecycle",
      "surface_send",
      "debug",
      { sessionKey: payload.sessionKey || undefined },
      () => ({ surfaceId: payload.surfaceId, mode: "update", seq: payload.seq, ...summarizeGlassesUiContent(cleanPatch) }),
    );
  }

  function onGlassesUiResult(handler) {
    if (typeof handler !== "function") return () => {};
    glassesUiResultHandlers.add(handler);
    return () => glassesUiResultHandlers.delete(handler);
  }

  function dispatchGlassesUiResult(frame) {
    if (!frame || typeof frame !== "object") return;
    for (const handler of glassesUiResultHandlers) {
      try {
        handler({
          surfaceId: typeof frame.surfaceId === "string" ? frame.surfaceId : "",
          outcome: frame.outcome,
        });
      } catch (err) {
        logger.warn(`[relay] glasses_ui_result handler threw: ${err.message}`);
      }
    }
  }

  const glassesUiNavEventHandlers = new Set();

  function onGlassesUiNavEvent(handler) {
    if (typeof handler !== "function") return () => {};
    glassesUiNavEventHandlers.add(handler);
    return () => glassesUiNavEventHandlers.delete(handler);
  }

  function dispatchGlassesUiNavEvent(frame) {
    if (!frame || typeof frame !== "object") return;
    for (const handler of glassesUiNavEventHandlers) {
      try {
        handler({
          surfaceId: typeof frame.surfaceId === "string" ? frame.surfaceId : "",
          depth: Number.isFinite(frame.depth) ? Math.max(1, Math.floor(frame.depth)) : 1,
        });
      } catch (err) {
        logger.warn(`[relay] glasses_ui_nav_event handler threw: ${err.message}`);
      }
    }
  }

  const glassesUiRenderReceiptHandlers = new Set();

  function onGlassesUiRenderReceipt(handler) {
    if (typeof handler !== "function") return () => {};
    glassesUiRenderReceiptHandlers.add(handler);
    return () => glassesUiRenderReceiptHandlers.delete(handler);
  }

  function dispatchGlassesUiRenderReceipt(frame) {
    if (!frame || typeof frame !== "object") return;
    for (const handler of glassesUiRenderReceiptHandlers) {
      try {
        handler({
          surfaceId: typeof frame.surfaceId === "string" ? frame.surfaceId : "",

          seq: Number.isFinite(frame.seq) ? Math.floor(frame.seq) : null,
        });
      } catch (err) {
        logger.warn(`[relay] surface_render_receipt handler threw: ${err.message}`);
      }
    }
  }

  const glassesUiClientFailureHandlers = new Set();

  function onGlassesUiClientFailure(handler) {
    if (typeof handler !== "function") return () => {};
    glassesUiClientFailureHandlers.add(handler);
    return () => glassesUiClientFailureHandlers.delete(handler);
  }

  function dispatchGlassesUiClientFailure(clientId, data) {
    if (!data || typeof data !== "object") return;

    emitDebug(
      "glasses.lifecycle",
      "client_failure_recv",
      "debug",
      {},
      () => ({
        clientId: typeof clientId === "string" ? clientId : null,
        surfaceId: data.surfaceId,
        seq: data.seq,
        code: data.code,
        handlerCount: glassesUiClientFailureHandlers.size,
      }),
    );
    for (const handler of glassesUiClientFailureHandlers) {
      try {
        handler({
          clientId: typeof clientId === "string" ? clientId : null,
          surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",

          seq: Number.isFinite(data.seq) ? Math.floor(data.seq) : null,
          code: typeof data.code === "string" ? data.code : "",
          sdkCode: Number.isFinite(data.sdkCode) ? data.sdkCode : null,
        });
      } catch (err) {
        logger.warn(`[relay] liveui client-failure handler threw: ${err.message}`);
      }
    }
  }

  const deviceInfoResponseHandlers = new Set();
  const glassesPresenceChangedHandlers = new Set();

  function onGlassesPresenceChanged(handler) {
    if (typeof handler !== "function") return () => {};
    glassesPresenceChangedHandlers.add(handler);
    return () => glassesPresenceChangedHandlers.delete(handler);
  }

  function dispatchGlassesPresenceChanged(frame) {
    const allowed = new Set(["worn", "absent", "in_case", "unknown"]);
    const presence = allowed.has(frame && frame.presence) ? frame.presence : "unknown";
    emitDebug(
      "glasses.lifecycle",
      "glasses_presence_changed",
      "debug",
      {},
      () => ({ presence, handlerCount: glassesPresenceChangedHandlers.size }),
    );
    for (const rawHandler of glassesPresenceChangedHandlers) {
      const handler = rawHandler;
      try {
        handler({ presence });
      } catch (err) {
        logger.warn(
          `[relay] glasses_presence_changed handler threw: ${err && err.message ? err.message : err}`,
        );
      }
    }
  }

  function sendDeviceInfoRequest(params) {
    if (!server) return;
    const payload = {
      type: "device_info_request",
      sessionKey: params && typeof params.sessionKey === "string" ? params.sessionKey : null,
      requestId: params && typeof params.requestId === "string" ? params.requestId : "",
    };
    server.broadcast(JSON.stringify(payload));
  }

  function onDeviceInfoResponse(handler) {
    if (typeof handler !== "function") return () => {};
    deviceInfoResponseHandlers.add(handler);
    return () => deviceInfoResponseHandlers.delete(handler);
  }

  function dispatchDeviceInfoResponse(frame) {
    if (!frame || typeof frame !== "object") return;
    for (const handler of deviceInfoResponseHandlers) {
      try {
        handler({
          requestId: typeof frame.requestId === "string" ? frame.requestId : "",
          ok: frame.ok === true,
          code: typeof frame.code === "string" ? frame.code : undefined,
          data: frame.data && typeof frame.data === "object" ? frame.data : undefined,
        });
      } catch (err) {
        logger.warn(
          `[relay] device_info_response handler threw: ${err && err.message ? err.message : err}`,
        );
      }
    }
  }

  const locationResponseHandlers = new Set();
  const pendingLocationRequestTargets = new Map();

  function prunePendingLocationRequestTargets(nowMs = Date.now()) {
    for (const [requestId, pending] of pendingLocationRequestTargets) {
      if (!pending || !Number.isFinite(pending.expiresAtMs) || pending.expiresAtMs <= nowMs) {
        pendingLocationRequestTargets.delete(requestId);
      }
    }
  }

  function locationAccessEnabledForReadinessClient(entry) {
    return !!(
      entry &&
      entry.readinessSnapshot &&
      entry.readinessSnapshot.locationAccessEnabled === true
    );
  }

  function hasLocationAccessEnabledReadinessClient() {
    if (!server || typeof server.getReadinessSnapshot !== "function") {
      return false;
    }
    const snapshot = server.getReadinessSnapshot();
    const clients = snapshot && Array.isArray(snapshot.clients) ? snapshot.clients : [];
    return clients.some((entry) => locationAccessEnabledForReadinessClient(entry));
  }

  function locationSessionMatchesRequest(entry, sessionKey) {
    const readinessSnapshot = entry && entry.readinessSnapshot;
    if (readinessSnapshot && typeof readinessSnapshot === "object") {
      const readinessSessionKey =
        typeof readinessSnapshot.activeSessionKey === "string"
          ? readinessSnapshot.activeSessionKey
          : "";
      return appSessionKeysMatch(sessionKey, readinessSessionKey);
    }
    return appSessionKeysMatch(sessionKey, entry && entry.protocolSessionKey);
  }

  function resolveLocationRequestTarget(sessionKey) {
    if (!server || typeof server.getReadinessSnapshot !== "function") {
      return { ok: false, code: "no_downstream_client" };
    }
    const snapshot = server.getReadinessSnapshot();
    const clients = snapshot && Array.isArray(snapshot.clients) ? snapshot.clients : [];
    if (clients.length === 0) {
      return { ok: false, code: "no_downstream_client" };
    }
    const requestedSessionKey = normalizeAppSessionKeyForCompare(sessionKey);
    const matchingClients = requestedSessionKey
      ? clients.filter((entry) => locationSessionMatchesRequest(entry, sessionKey))
      : [];
    const candidates =
      matchingClients.length > 0
        ? matchingClients
        : !requestedSessionKey && clients.length === 1
          ? clients
          : [];
    if (candidates.length === 0) {
      return { ok: false, code: "no_matching_app_client" };
    }
    if (candidates.length > 1) {
      return { ok: false, code: "multi_recipient_fanout" };
    }
    const targetClientId =
      candidates[0] && typeof candidates[0].clientId === "string"
        ? candidates[0].clientId
        : "";
    if (!targetClientId) {
      return { ok: false, code: "no_downstream_client" };
    }
    if (!locationAccessEnabledForReadinessClient(candidates[0])) {
      return { ok: false, code: "location_access_disabled" };
    }
    return { ok: true, clientId: targetClientId };
  }

  function sendLocationRequest(params) {
    if (!server) return;
    prunePendingLocationRequestTargets();
    const requestId = params && typeof params.requestId === "string" ? params.requestId : "";
    const sessionKey = params && typeof params.sessionKey === "string" ? params.sessionKey : null;
    const target = resolveLocationRequestTarget(params && params.sessionKey);
    if (!target.ok) {
      emitDebug(
        "relay.session",
        "location_request_target_error",
        "warn",
        { sessionKey: sessionKey || undefined },
        () => ({
          requestId,
          sessionKey,
          code: target.code,
        }),
      );
      const err = new Error(`location request target unavailable: ${target.code}`);
      err.code = target.code;
      throw err;
    }
    const payload = {
      type: "location_request",
      sessionKey,
      requestId,
    };
    if (requestId) {
      pendingLocationRequestTargets.set(requestId, {
        targetClientId: target.clientId,
        sessionKey: payload.sessionKey,
        expiresAtMs: Date.now() + LOCATION_REQUEST_TARGET_TTL_MS,
      });
    }
    emitDebug(
      "relay.session",
      "location_request_unicast",
      "debug",
      { sessionKey: payload.sessionKey || undefined },
      () => ({
        requestId,
        sessionKey: payload.sessionKey,
        targetClientId: target.clientId,
      }),
    );
    server.unicast(target.clientId, JSON.stringify(payload));
  }

  function onLocationResponse(handler) {
    if (typeof handler !== "function") return () => {};
    locationResponseHandlers.add(handler);
    return () => locationResponseHandlers.delete(handler);
  }

  function dispatchLocationResponse(frame) {
    if (!frame || typeof frame !== "object") return;
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    const pending = requestId ? pendingLocationRequestTargets.get(requestId) : null;
    if (!pending) {
      emitDebug(
        "relay.session",
        "location_response_ignored",
        "warn",
        {},
        () => ({
          requestId,
          reason: "no_pending_request",
          clientId: frame && typeof frame.clientId === "string" ? frame.clientId : null,
        }),
      );
      return;
    }
    if (
      pending.expiresAtMs <= Date.now() ||
      typeof frame.clientId !== "string" ||
      frame.clientId !== pending.targetClientId
    ) {
      emitDebug(
        "relay.session",
        "location_response_ignored",
        "warn",
        { sessionKey: pending.sessionKey || undefined },
        () => ({
          requestId,
          reason:
            pending.expiresAtMs <= Date.now()
              ? "expired"
              : "wrong_client",
          clientId: frame && typeof frame.clientId === "string" ? frame.clientId : null,
          targetClientId: pending.targetClientId,
        }),
      );
      if (pending.expiresAtMs <= Date.now()) {
        pendingLocationRequestTargets.delete(requestId);
      }
      return;
    }
    pendingLocationRequestTargets.delete(requestId);
    emitDebug(
      "relay.session",
      "location_response_dispatch",
      frame.ok === true ? "debug" : "warn",
      { sessionKey: pending.sessionKey || undefined },
      () => ({
        requestId,
        ok: frame.ok === true,
        code: typeof frame.code === "string" ? frame.code : null,
        hasData: !!(frame.data && typeof frame.data === "object"),
        clientId: frame.clientId,
      }),
    );
    for (const handler of locationResponseHandlers) {
      try {
        handler({
          requestId,
          ok: frame.ok === true,
          code: typeof frame.code === "string" ? frame.code : undefined,
          data: frame.data && typeof frame.data === "object" ? frame.data : undefined,
        });
      } catch (err) {
        logger.warn(
          `[relay] location_response handler threw: ${err && err.message ? err.message : err}`,
        );
      }
    }
  }

  function normalizeAttachmentErrorCode(err) {
    if (!err) return "attachment_upstream_rejected";
    const code = typeof err.code === "string" ? err.code.trim() : "";
    if (
      code === "attachment_invalid_type" ||
      code === "attachment_decode_failed" ||
      code === "attachment_too_large" ||
      code === "attachment_too_large_encoded" ||
      code === "attachment_missing_data" ||
      code === "attachment_upstream_rejected"
    ) {
      return code;
    }

    const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
    if (message.includes("invalid type") || message.includes("mime")) {
      return "attachment_invalid_type";
    }
    if (message.includes("base64") || message.includes("decode")) {
      return "attachment_decode_failed";
    }
    if (message.includes("too large") || message.includes("exceeds")) {
      return "attachment_too_large";
    }
    return "attachment_upstream_rejected";
  }

  function dispatchOcuClawUserSend(params = {}) {
    const sendId = typeof params.id === "string" ? params.id.trim() : "";
    const dedupeSessionKey = params.sessionKey || sessionService.peekSessionKey();
    const dedupeKey = sendId && dedupeSessionKey ? `${dedupeSessionKey}\u0000${sendId}` : "";
    const dedupeNowMs = debugNow();
    const cachedDedupe = dedupeKey ? userSendDedupe.get(dedupeKey) : null;
    if (cachedDedupe && cachedDedupe.expiresAtMs > dedupeNowMs) {
      emitDebug(
        "relay.protocol",
        "send_deduped",
        "info",
        { sessionKey: dedupeSessionKey },
        () => ({ messageId: sendId }),
        {},
      );
      return cachedDedupe.operation;
    }
    if (dedupeKey && cachedDedupe) userSendDedupe.delete(dedupeKey);
    const operation = dispatchOcuClawUserSendOnce(params);
    if (dedupeKey) {
      const dedupeEntry = {
        operation,
        expiresAtMs: dedupeNowMs + USER_SEND_DEDUPE_TTL_MS,
      };
      userSendDedupe.set(dedupeKey, dedupeEntry);
      while (userSendDedupe.size > USER_SEND_DEDUPE_MAX) {
        userSendDedupe.delete(userSendDedupe.keys().next().value);
      }
      if (operation && typeof operation.then === "function") {
        operation.then((result) => {
          const status = result && typeof result.status === "string"
            ? result.status.trim().toLowerCase()
            : "accepted";
          if (status !== "accepted" && status !== "queued") {
            if (userSendDedupe.get(dedupeKey) === dedupeEntry) userSendDedupe.delete(dedupeKey);
          }
        }, () => {
          if (userSendDedupe.get(dedupeKey) === dedupeEntry) userSendDedupe.delete(dedupeKey);
        });
      }
    }
    return operation;
  }

  function dispatchOcuClawUserSendOnce(params = {}) {
    const id = params.id;
    const text = params.text;
    const sessionKey = params.sessionKey;
    const attachment = params.attachment || null;
    const clientDisplaySignals = params.clientDisplaySignals || null;
    const resolvedSessionKey = sessionKey || sessionService.ensureSessionKey();
    if (
      !attachment &&
      openClawQuestionRouter &&
      openClawQuestionRouter.handleText(resolvedSessionKey, text)
    ) {
      relayOperationRegistry.markStarted(id);
      relayOperationRegistry.markUpstreamAck(id, { status: "question_answered" });
      conversationState.addMessage("user", buildLocalUserMessageContent(text, null));
      broadcastPages();
      emitDebug(
        "glasses.lifecycle",
        "question_text_answered",
        "info",
        { sessionKey: resolvedSessionKey },
        () => ({ messageId: id, textChars: typeof text === "string" ? text.length : 0 }),
        undefined,
      );
      return Promise.resolve({ status: "accepted", questionAnswer: true });
    }
    const materializesHermesDraft =
      getActiveBackendKind() === "hermes" &&
      typeof sessionService.markDraftSessionInFlight === "function" &&
      sessionService.markDraftSessionInFlight(resolvedSessionKey);
    if (!materializesHermesDraft) {
      sessionService.recordFirstSentUserMessage(resolvedSessionKey, text);
    }
    if (clientDisplaySignals && resolvedSessionKey) {
      sessionService.recordNeuralSessionNamesEnabled(
        resolvedSessionKey,
        clientDisplaySignals.neuralSessionNamesEnabled !== false,
      );
      sessionService.recordDisplayToggleStates(resolvedSessionKey, {
        emoji: clientDisplaySignals.neuralEmojiReactorState === "active",
        pace: clientDisplaySignals.neuralPaceModulatorState === "active",
      });
    }
    const hasAttachment = !!attachment;
    const sendStartedAt = Date.now();
    relayOperationRegistry.markStarted(id);
    sessionService.invalidateSessionsCache();
    emitDebug(
      "relay.protocol",
      "send",
      "info",
      { sessionKey: resolvedSessionKey },
      () => ({
        messageId: id,
        textChars: typeof text === "string" ? text.length : 0,
        hasAttachment,
        attachmentBytes:
          attachment && Number.isFinite(attachment.sizeBytes)
            ? attachment.sizeBytes
            : null,
      }),
    );

    return maybeSeedOcuClawSessionConfig(resolvedSessionKey).then(() => {

      agentTurnTracker.markBusy(resolvedSessionKey);

      const upstreamPromise = gatewayBridge.sendMessage(
        text,
        resolvedSessionKey,
        attachment,
        {
          ...stableSendOptions(
            resolvedSessionKey,

            resolvedSessionKey,
            clientDisplaySignals,
          ),
          diagnostic: buildOcuClawSendDiagnostic({
            ...params,
            sessionKey: resolvedSessionKey,
          }),
        },
      );
      const upstreamDispatchedAt = Date.now();

      const publishLocalUserMessage = () => {
        const userContent = buildLocalUserMessageContent(text, attachment);
        conversationState.addMessage("user", userContent, null, {
          clientSendId: id,
        });
        emitDebug(
          "openclaw.message",
          "user_message",
          "info",
          { sessionKey: resolvedSessionKey },
          () => ({ text: typeof text === "string" ? text : "" }),
        );
        broadcastPages();
      };
      if (!materializesHermesDraft) publishLocalUserMessage();
      const localPublishDoneAt = Date.now();

      emitDebug(
        "relay.protocol",
        "send_local_publish",
        "debug",
        { sessionKey: resolvedSessionKey },
        () => ({
          messageId: id,
          upstreamDispatchMs: upstreamDispatchedAt - sendStartedAt,
          localPublishMs: localPublishDoneAt - upstreamDispatchedAt,
          onSendSyncMs: localPublishDoneAt - sendStartedAt,
          hasAttachment,
          deferredUntilAccepted: materializesHermesDraft,
        }),
      );

      return upstreamPromise.then(
        (result) => {
          if (materializesHermesDraft && result && result.status === "accepted") {
            if (sessionService.isCurrentSession(resolvedSessionKey)) {
              publishLocalUserMessage();
            }
            sessionService.recordFirstSentUserMessage(resolvedSessionKey, text);
            if (sessionService.materializeDraftSession(resolvedSessionKey) && server) {
              server.broadcast(JSON.stringify({
                type: "ocuclaw.session.materialized",
                sessionKey: resolvedSessionKey,
              }));
            }
          } else if (materializesHermesDraft) {
            sessionService.releaseDraftSessionSend(resolvedSessionKey);
          }
          const ackAt = Date.now();
          const runId = result && result.runId ? result.runId : null;
          if (
            runId &&
            conversationState &&
            typeof conversationState.bindRunIdToClientSendId === "function"
          ) {
            if (conversationState.bindRunIdToClientSendId(id, runId)) {
              broadcastEntriesForActiveLedgerClients();
            }
          }
          relayOperationRegistry.markUpstreamAck(id, {
            runId,
            status: result && result.status ? result.status : null,
          });
          if (runId && upstreamRuntime) {
            upstreamRuntime.trackAcceptedRun({
              runId,
              sessionKey: resolvedSessionKey,
              messageId: id,
              sendStartedAt,
              ackAt,
            });
          }

          if (runId) agentTurnTracker.noteRun(resolvedSessionKey, runId);

          settleRemoteSendRunBinding(id, {
            runId,
            sessionKey: resolvedSessionKey,
            status: runId ? "bound" : "unbound_no_run_id",
          });
          emitDebug(
            "relay.protocol",
            "send_upstream_ack",
            "debug",
            { sessionKey: resolvedSessionKey, runId },
            () => ({
              messageId: id,
              runId,
              status: result && result.status ? result.status : null,
              elapsedMs: ackAt - sendStartedAt,
              hasAttachment,
            }),
          );
          return result;
        },
        (err) => {
          if (materializesHermesDraft) {
            sessionService.releaseDraftSessionSend(resolvedSessionKey);
          }
          const mirroredErrorCode =
            err && typeof err.errorCode === "string" && err.errorCode.trim()
              ? err.errorCode.trim()
              : err && typeof err.code === "string" && err.code.trim()
                ? err.code.trim()
                : attachment
                  ? normalizeAttachmentErrorCode(err)
                  : null;
          if (mirroredErrorCode && err && typeof err === "object") {
            err.errorCode = mirroredErrorCode;
          }

          settleRemoteSendRunBinding(id, {
            sessionKey: resolvedSessionKey,
            status: "unbound_send_failed",
            error: err && err.message ? err.message : String(err),
          });
          emitDebug(
            "relay.protocol",
            "send_upstream_error",
            "warn",
            { sessionKey: resolvedSessionKey },
            () => ({
              messageId: id,
              elapsedMs: Date.now() - sendStartedAt,
              hasAttachment,
              errorCode:
                err && typeof err.errorCode === "string" ? err.errorCode : null,
              message: err && err.message ? err.message : String(err),
            }),
          );
          throw err;
        },
      );
    });
  }

  function dispatchOcuClawSessionAbort(params = {}) {
    const requestId = params.requestId;
    const sessionKey =
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : sessionService.ensureSessionKey();
    emitDebug(
      "relay.protocol",
      "session_abort_requested",
      "info",
      { sessionKey },
      () => ({ requestId }),
    );
    const gatewaySession = openclawGatewayKeyFor(sessionKey);
    const request = {
      key: gatewaySession.key,
      ...(gatewaySession.agentId ? { agentId: gatewaySession.agentId } : {}),
    };
    return gatewayBridge.request("sessions.abort", request).then(
      (result) => ({
        status: "accepted",
        ...(result && typeof result === "object" ? result : {}),
      }),
    );
  }

  function dispatchOcuClawSessionSteer(params = {}) {
    const requestId = params.requestId;
    const steerStartedAt = Date.now();
    const sessionKey =
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : sessionService.ensureSessionKey();
    const message = typeof params.message === "string" ? params.message : "";
    const attachment = params.attachment || null;
    const gatewayAttachment = buildGatewayAttachment(attachment);
    const gatewaySession = openclawGatewayKeyFor(sessionKey);
    const request = {
      key: gatewaySession.key,
      message,
      idempotencyKey: requestId,
      ...(gatewaySession.agentId ? { agentId: gatewaySession.agentId } : {}),
    };
    if (gatewayAttachment) {
      request.attachments = [gatewayAttachment];
    }

    emitDebug(
      "relay.protocol",
      "session_steer_requested",
      "info",
      { sessionKey },
      () => ({
        requestId,
        messageChars: message.length,
        hasAttachment: !!attachment,
      }),
    );

    const diagnostic = {
      messageId: requestId,
      sessionKey,
      source: "phone_ui_replace",
      textChars: message.length,
      hasAttachment: !!attachment,
      attachmentBytes:
        attachment && Number.isFinite(attachment.sizeBytes)
          ? Math.floor(attachment.sizeBytes)
          : null,
    };

    return maybeSeedOcuClawSessionConfig(sessionKey)
      .then(() => gatewayBridge.request("sessions.steer", request, {
        expectFinal: false,
        diagnostic,
      }))
      .then((result) => {
        const status =
          result && typeof result.status === "string" ? result.status : "";
        if (status && status !== "accepted" && status !== "started") {
          throw new Error(
            (result && typeof result.error === "string" && result.error) ||
              `session steer ${status}`,
          );
        }
        sessionService.recordFirstSentUserMessage(sessionKey, message);
        sessionService.invalidateSessionsCache();
        agentTurnTracker.markBusy(sessionKey);
        const ackAt = Date.now();
        const runId = result && result.runId ? result.runId : null;
        if (runId && upstreamRuntime) {
          upstreamRuntime.trackAcceptedRun({
            runId,
            sessionKey,
            messageId: requestId,
            sendStartedAt: steerStartedAt,
            ackAt,
          });
        }

        if (runId) agentTurnTracker.noteRun(sessionKey, runId);
        const userContent = buildLocalUserMessageContent(message, attachment);
        conversationState.addMessage("user", userContent, null, {
          clientSendId: requestId,
          runId,
        });
        emitDebug(
          "openclaw.message",
          "user_message",
          "info",
          { sessionKey },
          () => ({ text: message }),
        );
        broadcastPages();
        return {
          ...(result && typeof result === "object" ? result : {}),
          status: "accepted",
        };
      });
  }

  function emitListenInterceptRecovery(params = {}) {
    const connectedAppClients = server ? server.getConnectedAppCount() : 0;
    if (!server || !handler) {
      return {
        cleanupEmitted: false,
        connectedAppClients,
      };
    }

    server.broadcast(
      handler.formatListenError(
        LISTEN_INTERCEPT_RECOVERY_ERROR,
        LISTEN_INTERCEPT_RECOVERY_CODE,
      ),
    );
    server.broadcast(handler.formatListenEnded());
    return {
      cleanupEmitted: true,
      connectedAppClients,
    };
  }

  function emitListenInterceptBroadcast(params = {}) {
    if (!server || !handler) {
      return;
    }
    const sessionKey = params && typeof params.sessionKey === "string" ? params.sessionKey : null;
    server.broadcast(handler.formatEvenAiListenIntercepted(sessionKey));
  }

  let server = null;
  let evenAiEndpoint = null;
  let evenAiRouter = null;
  let evenAiRunWaiter = null;
  const pendingBufferedEvenAiResponses = new Map();
  let relayApi = null;

  async function applyOcuClawSettingsPatch(patch = {}) {
    let localPatch = patch;
    if (
      getActiveBackendKind() === "hermes" &&
      typeof opts.setOcuClawProfileOptions === "function"
    ) {
      const profilePatch = {};
      localPatch = {};
      for (const [key, value] of Object.entries(patch || {})) {
        if (
          key === "defaultModel" ||
          key === "defaultThinking" ||
          key === "defaultFastMode" ||
          key === "confirmModelSelection"
        ) {
          Reflect.set(profilePatch, key, value);
        } else if (key === "conversationToolProgress") {

          Reflect.set(profilePatch, key, value);
          Reflect.set(localPatch, key, value);
        } else {
          Reflect.set(localPatch, key, value);
        }
      }
      if (Object.keys(profilePatch).some((key) => key !== "confirmModelSelection")) {
        const profileResult = await opts.setOcuClawProfileOptions(profilePatch, {
          sessionKey: sessionService && sessionService.ensureSessionKey(),
        });
        if (!profileResult || profileResult.status !== "accepted") {
          return profileResult || {
            status: "rejected",
            error: "Hermes profile settings update failed",
          };
        }
      }
    }
    const localResult = Object.keys(localPatch).length > 0
      ? await setOcuClawLocalSettings(localPatch)
      : { status: "accepted" };
    if (!localResult || localResult.status !== "accepted") return localResult;
    const settings = await getOcuClawSettingsSnapshot();
    const result = { status: "accepted", settings };
    if (result && result.status === "accepted" && result.settings && server) {
      server.broadcast(handler.formatOcuClawSettings(result.settings));
    }
    return result;
  }

  function setPathwayBinding(
    pathway = "",
    binding = { backend: "", agentRef: "" },
  ) {
    return applyOcuClawSettingsPatch({
      pathways: {
        [pathway]: {
          binding,
        },
      },
    });
  }

  function applyTraceLogSet(clientId, request) {
    const enabled = !!(request && request.enabled === true);
    liveUiTraceLogEnabled = enabled;
    let persisted = false;
    if (liveUiTraceFlagPath) {
      try {
        fs.writeFileSync(liveUiTraceFlagPath, JSON.stringify({ enabled }) + "\n");
        persisted = true;
      } catch (err) {
        logger.warn(`[relay] liveui trace-log flag persist failed: ${err && err.message ? err.message : err}`);
      }
    }
    emitDebug("relay.protocol", "trace_log_set", "info", { sessionKey: sessionService.ensureSessionKey() }, () => ({ clientId, enabled, persisted }));
    return { ok: true, enabled, persisted, persistedPath: liveUiTraceFlagPath };
  }

  function persistDebugArm() {
    if (!debugArmStatePath) return false;
    try {
      const enabled = debugStore.getSnapshot().enabled;
      fs.writeFileSync(debugArmStatePath, JSON.stringify({ enabled }) + "\n");
      return true;
    } catch (err) {
      logger.warn(`[relay] debug arm persist failed: ${err && err.message ? err.message : err}`);
      return false;
    }
  }

  function applyDebugSet(clientId, request) {
    const result = debugStore.setCategories(request);
    if (!result.ok) {
      throw new Error(result.error || "debug-set failed");
    }

    persistDebugArm();
    emitDebug(
      "relay.protocol",
      "debug_set",
      "info",
      { sessionKey: sessionService.ensureSessionKey() },
      () => ({
        clientId,
        enable: result.applied.enable,
        disable: result.applied.disable,
        ttlMs: result.ttlMs,
        enabledCount: result.enabled.length,
      }),
    );
    return result;
  }

  async function switchToSessionAndRunPostSwitchFlow(sessionKey) {
    try {
      const pages = await sessionService.switchToSession(sessionKey);

      Promise.resolve(sessionService.markSessionRead(sessionKey)).catch(() => {});
      clearCurrentSessionModelConfigSnapshot("switch_session");

      demandRouter.forgetAll("switch_session");
      hermesClarifyRouter?.forgetAll("switch_session");
      openClawQuestionRouter?.forgetAll("switch_session");
      if (isEtSessionKey(sessionKey)) {
        broadcastActivity(buildEtSessionSwitchClearActivity(sessionKey));
        if (typeof opts.onEtSessionActivated === "function") {
          try { opts.onEtSessionActivated(sessionKey); } catch (e) { logger.warn(`[relay] onEtSessionActivated: ${e.message}`); }
        }
      } else {
        if (typeof opts.onEtSessionActivated === "function") {
          try { opts.onEtSessionActivated(null); } catch (e) {  }
        }
        if (upstreamRuntime && typeof upstreamRuntime.clearTyping === "function") {
          upstreamRuntime.clearTyping("switch_session");
        }
        if (upstreamRuntime && typeof upstreamRuntime.handleSessionChanged === "function") {
          upstreamRuntime.handleSessionChanged("switch_session");
        }
      }

      broadcastStatus();
      return pages;
    } catch (err) {
      if (err && (err.reason === "unsupported_session_key" || err.code === "unsupported_session_key")) {
        err.currentSessionKey = err.currentSessionKey || sessionService.peekSessionKey() || null;
      }
      throw err;
    }
  }

  const handler = createDownstreamHandler({
    logger,
    externalDebugToolsEnabled,
    defaultEvenAiDedicatedSessionKey,
    getSnapshotRevision(kind) {
      if (kind === "pages") return pagesRevision;
      if (kind === "status") return statusRevision;
      return null;
    },

    onSend(id, text, sessionKey, attachment, clientDisplaySignals) {
      return dispatchOcuClawUserSend({
        id,
        text,
        sessionKey,
        attachment,
        clientDisplaySignals: clientDisplaySignals || null,
        source: "phone_ui",
      });
    },
    onLedgerCursor(payload = {}) {
      const sessionId = payload.sessionId;
      const activeSessionKey = sessionService.peekSessionKey();
      if (sessionId !== activeSessionKey) return null;
      return activeLedgerSnapshot();
    },
    onResyncRequest(payload = {}) {
      const sessionId = payload.sessionId;
      const activeSessionKey = sessionService.peekSessionKey();
      if (sessionId !== activeSessionKey) return null;
      return activeLedgerSnapshot();
    },
    onAbortSession({ requestId, sessionKey }) {
      return dispatchOcuClawSessionAbort({ requestId, sessionKey });
    },
    onSteerSession({ requestId, sessionKey, message, attachment }) {
      return dispatchOcuClawSessionSteer({
        requestId,
        sessionKey,
        message,
        attachment,
      });
    },
    onGlassesUiResult(frame) {
      const liveuiController = resolveLiveuiGlassesLibraryController();
      const taskSessionKey =
        liveuiController && typeof liveuiController.sessionForSurface === "function"
          ? liveuiController.sessionForSurface(frame && frame.surfaceId)
          : null;
      emitDebug(
        "glasses.lifecycle",
        "surface_outcome",
        "debug",
        {},
        () => ({
          surfaceId: frame && frame.surfaceId,
          outcome: frame && frame.outcome,

          handlerCount: glassesUiResultHandlers.size,
        }),
      );
      if (glassesUiResultHandlers.size === 0) {
        logger.warn(
          `[relay] glasses_ui_result dropped: no subscribed handlers (surfaceId=${frame && frame.surfaceId})`,
        );
      }
      dispatchGlassesUiResult(frame);
      if (liveuiTaskRunController && taskSessionKey) {
        liveuiTaskRunController.observeSurfaceOutcome({
          sessionKey: taskSessionKey,
          outcome: frame && frame.outcome,
        });
      }
    },
    onDemandResponse(frame) {
      emitDebug(
        "glasses.lifecycle",
        "demand_response",
        "debug",
        {},
        () => ({
          surfaceId: frame && frame.surfaceId,
          result: frame && frame.result,
          selectedIndex: frame && frame.selectedIndex,
          selectedIndices: frame && frame.selectedIndices,
        }),
      );
      if (
        frame &&
        typeof frame.surfaceId === "string" &&
        frame.surfaceId.startsWith("hermes-clarify:")
      ) {
        hermesClarifyRouter?.handleOutcome(frame);
      } else if (
        frame &&
        typeof frame.surfaceId === "string" &&
        frame.surfaceId.startsWith("openclaw-question:")
      ) {
        openClawQuestionRouter?.handleOutcome(frame);
      } else {
        demandRouter.handleOutcome(frame);
      }
    },
    onGlassesUiNavEvent(frame) {
      emitDebug(
        "glasses.lifecycle",
        "nav_event_recv",
        "debug",
        {},
        () => ({ surfaceId: frame && frame.surfaceId, depth: frame && frame.depth }),
      );
      dispatchGlassesUiNavEvent(frame);
    },
    onGlassesUiRenderReceipt(frame) {

      emitDebug(
        "glasses.lifecycle",
        "render_receipt_recv",
        "debug",
        {},
        () => ({
          surfaceId: frame && frame.surfaceId,
          seq: frame && frame.seq,
          handlerCount: glassesUiRenderReceiptHandlers.size,
        }),
        {},
      );
      dispatchGlassesUiRenderReceipt(frame);

      Promise.resolve().then(() => {
        if (!liveuiTaskRunController) return;
        const liveuiController = resolveLiveuiGlassesLibraryController();
        if (!liveuiController) return;
        const surfaceId = frame && frame.surfaceId;
        const seq = frame && frame.seq;
        if (
          typeof liveuiController.hasClientReceipt !== "function" ||
          !liveuiController.hasClientReceipt(surfaceId, seq)
        ) return;
        const sessionKey =
          typeof liveuiController.sessionForSurface === "function"
            ? liveuiController.sessionForSurface(surfaceId)
            : null;
        if (sessionKey) {
          const first = liveuiTaskRunController.observeFirstRender({
            sessionKey,
            surfaceId,
            at: Date.now(),
          });
          if (!first) {
            liveuiTaskRunController.observeSurfaceRender({ sessionKey, surfaceId });
          }
          const delivery = typeof liveuiController.deliveryStateOf === "function"
            ? liveuiController.deliveryStateOf(surfaceId)
            : null;
          if (delivery && typeof delivery.rung === "string") {
            liveuiTaskRunController.observeSurfaceDelivery({
              sessionKey,
              surfaceId,
              delivery: delivery.rung,
            });
          }
        }
      });
    },
    onDeviceInfoResponse(frame) {
      dispatchDeviceInfoResponse(frame);
    },
    onGlassesPresenceChanged(frame) {
      dispatchGlassesPresenceChanged(frame);
    },
    onLocationResponse(frame) {
      dispatchLocationResponse(frame);
    },
    onGlassesUiRenderInject(params) {
      sendGlassesUiRender(params);
    },
    onGlassesUiSurfaceUpdateInject(params) {
      sendGlassesUiSurfaceUpdate(params);
    },
    async onSetUserSessionTitle(sessionKey, title) {
      const result = await sessionService.setUserSessionTitle(sessionKey, title);
      if (result && result.ok) {
        await broadcastSessions();
      }
      return result;
    },
    onSetSessionPinned(sessionKey, pinned, kind) {
      const result = sessionService.setSessionPinned(kind, sessionKey, pinned);
      if (result && result.ok) {
        broadcastSessions();
      }
      return result;
    },
    async onSetSessionHidden(sessionKey, hidden) {
      const result = await sessionService.setSessionHidden(sessionKey, hidden);
      if (result && result.ok) {

        await broadcastSessions();
      }
      return result;
    },
    onCompactSession({ sessionKey }) {
      if (!upstreamRuntime || typeof upstreamRuntime.compactActiveSession !== "function") {
        return Promise.resolve({
          status: "rejected",
          error: "upstream runtime not ready",
        });
      }
      return upstreamRuntime.compactActiveSession(sessionKey);
    },
    onDeleteSessions(sessionKeys, kind, switchBeforeDelete) {
      if (Array.isArray(sessionKeys)) {
        for (const key of sessionKeys) {
          if (typeof key === "string" && key.trim()) {
            stablePromptSnapshots.evict(key);
            sessionService.clearDisplayToggleStates(key);
          }
        }
      }
      const action = switchBeforeDelete
        ? sessionService.switchAndDeleteSessions(kind, sessionKeys)
        : sessionService.deleteSessions(kind, sessionKeys);
      Promise.resolve(action)
        .then(() => broadcastSessions())
        .catch((err) => {
          logger.error(`[relay] deleteSessions failed: ${err && err.message ? err.message : err}`);
        });
    },
    onSearchTranscripts(clientId, query, kind) {
      const sendSearchResult = (result) => {
        if (!server) return;
        const payload = {
          type: "ocuclaw.session.transcripts.search.result",
          query,
          kind,
          snippets: result && Array.isArray(result.snippets) ? result.snippets : [],
          truncated: !!(result && result.truncated),
          refreshing: !!(result && result.refreshing),
          unavailable: !!(result && result.unavailable),
          unavailableReason:
            result && typeof result.unavailableReason === "string"
              ? result.unavailableReason
              : null,
        };
        server.unicast(clientId, JSON.stringify(payload));
      };
      Promise.resolve(sessionService.searchTranscripts(kind, query))
        .then((result) => {
          sendSearchResult(result);
          if (result && result.refreshPromise && typeof result.refreshPromise.then === "function") {
            result.refreshPromise
              .then(() => sessionService.searchTranscripts(kind, query, { skipRefresh: true }))
              .then((freshResult) => sendSearchResult({ ...freshResult, refreshing: false }))
              .catch((err) => {
                logger.error(`[relay] terminal transcript refresh failed: ${err && err.message ? err.message : err}`);
                sendSearchResult({ snippets: result.snippets || [], truncated: !!result.truncated, refreshing: false });
              });
          }
        })
        .catch((err) => {
          logger.error(`[relay] searchTranscripts failed: ${err && err.message ? err.message : err}`);
          if (server) {
            const payload = {
              type: "ocuclaw.session.transcripts.search.result",
              query, kind, snippets: [], truncated: false, refreshing: false,
              unavailable: true, unavailableReason: "search_failed",
            };
            server.unicast(clientId, JSON.stringify(payload));
          }
        });
    },

    onDebugBundleRequest(clientId, msg) {

      const reportedClientVersion = (() => {
        try {
          const snap =
            server && typeof server.getReadinessSnapshot === "function"
              ? server.getReadinessSnapshot()
              : null;
          const entry =
            snap && Array.isArray(snap.clients)
              ? snap.clients.find((c) => c.clientId === clientId)
              : null;
          const v = entry && typeof entry.clientVersion === "string" ? entry.clientVersion.trim() : "";
          return v.length ? v : null;
        } catch {
          return null;
        }
      })();
      const deps = {
        gatesOn: () => externalDebugToolsEnabled,
        dump: (query) => debugStore.dump(query),

        preset:
          opts.debugUploadCapturePreset &&
          Array.isArray(opts.debugUploadCapturePreset) &&
          opts.debugUploadCapturePreset.length
            ? opts.debugUploadCapturePreset
            : UPLOAD_CAPTURE_PRESET,

        build: {
          clientVersion: reportedClientVersion,
          requiresClientVersion: pluginVersionService.getRequiresClientVersion(),
          pluginVersion: pluginVersionService.getPluginVersion(),
          openclawVersion:
            relayBackendKind === "openclaw"
              ? pluginVersionService.getOpenClawHostVersion()
              : null,
          distHash: pluginVersionService.getDistHash(),
          ...(relayBackendKind === "hermes"
            ? { backendKind: "hermes", hermesVersion }
            : {}),
        },
        maxZipBytes: debugUploadMaxZipBytes,
        chunkBytes: 64000,
        send: (id, frame) => {
          if (server) server.unicast(id, JSON.stringify(frame));
        },

        emit: (event, data) =>
          emitDebug("relay.operation", event, "debug", {}, () => data),
        logError: (m) => logger.error(`[relay] ${m}`),
        newBundleId: () => crypto.randomUUID(),
        cachePut: (id = "", e = {}) => bundleCache.put(id, e),
        now: () => Date.now(),
      };
      if (
        relayBackendKind === "hermes" &&
        typeof opts.getConnectionHealthDocument === "function"
      ) {

        Object.defineProperty(deps, "getConnectionHealthDocument", {
          value: opts.getConnectionHealthDocument,
          enumerable: true,
        });
      }
      return Promise.resolve(handleDebugBundleRequest(deps, clientId, msg)).catch(
        (err) => {
          logger.error(
            `[relay] debug-bundle-request failed: ${err && err.message ? err.message : err}`,
          );
        },
      );
    },
    onDebugBundleSave(clientId, msg) {
      return Promise.resolve(handleDebugBundleSave({
        gatesOn: () => externalDebugToolsEnabled,
        cacheGet: (id) => bundleCache.get(id),
        saveBundle: (a) => saveBundleToDisk({ ...a, saveDir: resolveSaveDir(), fs, path }),
        now: () => Date.now(),
        send: (id, frame) => { if (server) server.unicast(id, JSON.stringify(frame)); },
        emit: (event, data) => emitDebug("relay.operation", event, "debug", {}, () => data),
        logError: (m) => logger.error(`[relay] ${m}`),
      }, clientId, msg)).catch((err) => {
        logger.error(`[relay] debug-bundle-save failed: ${err && err.message ? err.message : err}`);
      });
    },
    onDebugBundleFetch(clientId, msg) {
      return Promise.resolve(handleDebugBundleFetch({
        gatesOn: isDebugBundlePhoneHandoffAllowed,
        cacheGet: (id) => bundleCache.get(id),
        chunkBytes: 64000,
        send: (id, frame) => { if (server) server.unicast(id, JSON.stringify(frame)); },
        emit: (event, data) => emitDebug("relay.operation", event, "debug", {}, () => data),
      }, clientId, msg)).catch((err) => {
        logger.error(`[relay] debug-bundle-fetch failed: ${err && err.message ? err.message : err}`);
      });
    },
    operationRegistry: relayOperationRegistry,

    onSimulate(sender, text) {
      emitDebug(
        "relay.protocol",
        "simulate",
        "debug",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          sender: sender || "Simulator",
          textChars: typeof text === "string" ? text.length : 0,
        }),
      );

      conversationState.addMessage("assistant", [{ type: "text", text }], sender || "Simulator");

      const pages = conversationState.getPages();
      cachePages(pages);
      return pages;
    },

    onSimulateStream(request) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const nativeLifecycle = request.nativeLifecycle === true;
      const sender = (
        request.sender ||
        (upstreamRuntime ? upstreamRuntime.getAgentName() : null) ||
        "Simulator"
      ).trim();
      const text = typeof request.text === "string" ? request.text : "";
      const chunkChars = Math.min(
        200,
        Math.max(1, request.chunkChars ?? 16),
      );
      const chunkIntervalMs = Math.min(
        5000,
        Math.max(10, request.chunkIntervalMs ?? 45),
      );
      const startDelayMs = Math.min(
        5000,
        Math.max(0, request.startDelayMs ?? 80),
      );
      const thinkingTailMs = Math.min(
        10000,
        Math.max(0, request.thinkingTailMs ?? 900),
      );
      const runId = request.runId || `sim-${Date.now()}-${++simulateStreamRunSeq}`;
      const nativeRunIsEmittable = nativeLifecycle
        ? ensureSimulatedRunOpen(runId, sessionKey, { nativeLifecycle })
        : false;
      const key = simulateStreamRunKey(sessionKey, runId);
      const superseded = simulateStreamRuns.get(key);
      const supersededTimerCount = superseded
        ? cancelSimulateStreamRun(superseded)
        : 0;
      const streamRun = {
        key,
        sessionKey,
        runId,
        timers: new Set(),
        nativeFirstChunkHandled: false,
      };
      simulateStreamRuns.set(key, streamRun);
      const chunkCount = Math.max(1, Math.ceil(text.length / chunkChars));
      const streamPrefix = `${sender}: `;

      emitDebug(
        "relay.protocol",
        "simulate_stream_start",
        "info",
        { sessionKey, runId },
        () => ({
          messageId: request.id || null,
          sender,
          textChars: text.length,
          chunkChars,
          chunkIntervalMs,
          startDelayMs,
          thinkingTailMs,
          chunkCount,
          supersededTimerCount,
        }),
      );

      if (!nativeLifecycle) {
        broadcastActivity({
          state: "thinking",
          sessionKey,
          runId,
          origin: "simulate",
          phase: "start",
        });
      }

      for (let index = 0; index < chunkCount; index += 1) {
        const visibleChars = Math.min(text.length, (index + 1) * chunkChars);
        const delayMs = startDelayMs + (index * chunkIntervalMs);
        scheduleSimulateStreamTimer(streamRun, delayMs, () => {
          if (
            nativeRunIsEmittable &&
            !streamRun.nativeFirstChunkHandled
          ) {
            streamRun.nativeFirstChunkHandled = true;
            cancelSimulatedThinkingHeartbeat(
              simulatedRunKey(runId, sessionKey),
            );
            const runKey = simulatedRunKey(runId, sessionKey);
            if (
              simulateOpenRuns.has(runKey) &&
              !simulateResponseStartedRuns.has(runKey)
            ) {
              simulateResponseStartedRuns.add(runKey);
              if (
                upstreamRuntime &&
                typeof upstreamRuntime.synthesizeResponseStarted === "function"
              ) {
                upstreamRuntime.synthesizeResponseStarted(runId, sessionKey);
              }
            }
          }

          const parsedSpans = parseTaggedSpans(text.slice(0, visibleChars), [
            EMOJI_TAG_FAMILY_CONFIG,
            PACE_TAG_FAMILY_CONFIG,
          ]);
          const { text: streamedText, spansByFamily } = applyMarkdownWithSpans(
            parsedSpans,
            streamPrefix,
            conversationState,
          );
          server.broadcast(handler.formatStreaming(
            streamedText,
            spansByFamily.emoji || [],
            spansByFamily.pace || [],
            { runId, seq: index + 1 },
          ));
          emitDebug(
            "relay.protocol",
            "simulate_stream_chunk",
            "debug",
            { sessionKey, runId },
            () => ({
              chunkIndex: index + 1,
              chunkCount,
              visibleChars,
              totalChars: text.length,
            }),
          );
        });
      }

      const completeDelayMs = startDelayMs + (chunkCount * chunkIntervalMs) + thinkingTailMs;
      scheduleSimulateStreamTimer(streamRun, completeDelayMs, () => {
        try {

          conversationState.addMessage(
            "assistant",
            [{ type: "text", text: stripAllTaggedSpans(text) }],
            sender,
          );
          broadcastPages();
          if (nativeLifecycle) {
            if (nativeRunIsEmittable) {
              emitSimulatedRunComplete(runId, sessionKey, { nativeLifecycle });
            }
          } else {
            broadcastActivity({
              state: "idle",
              sessionKey,
              runId,
              origin: "simulate",
              phase: "complete",
            });
          }
          emitDebug(
            "relay.protocol",
            "simulate_stream_complete",
            "info",
            { sessionKey, runId },
            () => ({
              messageId: request.id || null,
              textChars: text.length,
              chunkCount,
              thinkingTailMs,
              completeDelayMs,
            }),
          );
        } finally {
          if (simulateStreamRuns.get(key) === streamRun) {
            simulateStreamRuns.delete(key);
          }
        }
      });

      return Promise.resolve({
        status: "accepted",
        runId,
      });
    },

    onSimulateStreamCancel(request) {
      const runId = request.runId;
      let entry = null;
      if (request.sessionKey) {
        entry = simulateStreamRuns.get(
          simulateStreamRunKey(request.sessionKey, runId),
        ) || null;
      } else {
        const matches = Array.from(simulateStreamRuns.values())
          .filter((candidate) => candidate.runId === runId);
        if (matches.length > 1) {
          return Promise.resolve({
            status: "rejected",
            error: `simulateStreamCancel runId ${runId} matches multiple sessions`,
            errorCode: "ambiguous_run_id",
            runId,
          });
        }
        entry = matches[0] || null;
      }

      const sessionKey = entry
        ? entry.sessionKey
        : request.sessionKey || null;
      const clearedTimerCount = entry ? cancelSimulateStreamRun(entry) : 0;
      emitDebug(
        "relay.protocol",
        "simulate_stream_cancel",
        "info",
        { sessionKey, runId },
        () => ({
          messageId: request.id || null,
          found: !!entry,
          clearedTimerCount,
        }),
      );
      return Promise.resolve({ status: "accepted", runId });
    },

    onSimulateActivity(request) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const runId = request.runId || `sim-${Date.now()}-${++simulateStreamRunSeq}`;
      const summary = request.summary || null;
      const nativeLifecycle = request.nativeLifecycle === true;
      emitDebug(
        "relay.protocol",
        "simulate_activity",
        "info",
        { sessionKey, runId },
        () => ({
          messageId: request.id || null,
          state: request.state,
          hasSummary: !!summary,
        }),
      );
      if (nativeLifecycle) {
        if (request.state === "thinking") {
          const runIsEmittable = ensureSimulatedRunOpen(
            runId,
            sessionKey,
            { nativeLifecycle },
          );
          if (runIsEmittable && summary) {
            const heartbeat = startOrUpdateSimulatedThinkingHeartbeat(
              runId,
              sessionKey,
              summary,
            );
            emitSimulatedActivity(heartbeat.frame, { nativeLifecycle });
          }
        } else {
          emitSimulatedRunComplete(runId, sessionKey, { nativeLifecycle });
        }
      } else if (request.state === "thinking") {
        broadcastActivity({
          state: "thinking",
          sessionKey,
          runId,
          origin: "lifecycle",
          phase: "start",
        });
        if (summary) {
          broadcastActivity({
            state: "thinking",
            sessionKey,
            runId,
            origin: "thinking",
            phase: "update",
            summary,
          });
        }
      } else {
        broadcastActivity({
          state: "idle",
          sessionKey,
          runId,
          origin: "lifecycle",
          phase: "end",
        });
      }
      return Promise.resolve({ status: "accepted", runId });
    },

    onSimulateTool(request) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const { runId, phase, tool } = request;
      const args = request.argsPreview || null;
      const nativeLifecycle = request.nativeLifecycle === true;
      const nowMs = Date.now();
      let elapsedMs = null;
      if (phase === "start") {
        simulateToolStarts.set(runId, nowMs);
        if (simulateToolStarts.size > 200) {
          const oldest = simulateToolStarts.keys().next();
          if (!oldest.done) simulateToolStarts.delete(oldest.value);
        }
        const activity = {
          state: "thinking",
          tool,
          sessionKey,
          runId,
          origin: "tool",
          phase: "start",
        };
        if (args) activity.args = args;
        if (nativeLifecycle) {
          if (ensureSimulatedRunOpen(runId, sessionKey, { nativeLifecycle })) {
            emitSimulatedActivity(activity, { nativeLifecycle });
          }
        } else {
          broadcastActivity(activity);
        }
      } else {

        elapsedMs = Number.isFinite(request.elapsedMs)
          ? Math.max(0, Math.floor(request.elapsedMs))
          : simulateToolStarts.has(runId)
            ? Math.max(0, nowMs - simulateToolStarts.get(runId))
            : null;
        simulateToolStarts.delete(runId);
      }
      emitDebug(
        "openclaw.run",
        "gateway_event_received",
        "debug",
        { sessionKey, runId },
        () => ({
          eventKind: "agent",
          runId,
          sessionKey,
          source: "simulate",
          stream: "tool",
          phase,
          tool,
          ...(phase === "result"
            ? { elapsedMs, isError: request.isError === true }
            : {}),
        }),
      );
      return Promise.resolve({ status: "accepted", runId });
    },

    onSimulateDemand(request) {
      sendDemand({
        surfaceId: request.surfaceId,
        sessionKey: request.sessionKey || sessionService.ensureSessionKey(),
        kind: request.kind,
        title: request.title,
        question: request.question,
        deadlineSec: request.deadlineSec,
        questionIndex: request.questionIndex,
        questionCount: request.questionCount,
        options: request.options,
      });
      return { status: "accepted" };
    },

    onSimulateApproval(request) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const nativeLifecycle = request.nativeLifecycle === true;
      const approvalId = request.approvalId;
      const nowMs = Date.now();
      pruneSyntheticApprovals(nowMs);
      if (request.phase === "request") {
        const expiresAtMs = nowMs + request.expiresInMs;
        syntheticApprovals.set(approvalId, {
          resolved: false,
          decision: null,
          expiresAtMs,

          heartbeatKey: nativeLifecycle
            ? findSimulatedThinkingHeartbeatForSession(sessionKey)?.key || null
            : null,
        });
        emitDebug(
          "approvals.timeline",
          "approval_requested",
          "info",
          { sessionKey },
          () => ({
            approvalId,
            approvalKind: "exec",
            synthetic: true,
            commandLength: (request.command || "").length,
          }),
        );
        if (server && handler) {
          server.broadcast(handler.formatApproval({
            id: approvalId,
            createdAtMs: nowMs,
            expiresAtMs,
            request: {
              command: request.command,
              ask: request.ask || null,
              allowedDecisions: request.allowedDecisions,
              sessionKey,
            },
          }));
        }
        return Promise.resolve({ status: "accepted" });
      }
      if (!syntheticApprovals.has(approvalId)) {
        return Promise.resolve({
          status: "rejected",
          error: `unknown synthetic approval id: ${approvalId}`,
        });
      }
      resolveSyntheticApproval(approvalId, request.decision, "scripted");
      return Promise.resolve({ status: "accepted" });
    },

    onSimulateVoice(request) {
      const phase = request.phase;
      const text = typeof request.text === "string" ? request.text : "";

      if (phase === "reopen") {

        const rawReopenKey =
          typeof request.sessionKey === "string" ? request.sessionKey.trim() : "";
        const peekedReopenKey = sessionService.peekSessionKey();
        const activeReopenKey =
          typeof peekedReopenKey === "string" ? peekedReopenKey.trim() : "";
        const reopenSessionKey = rawReopenKey || activeReopenKey;
        if (!reopenSessionKey) {
          return Promise.resolve({
            status: "rejected",
            error: "simulateVoice reopen requires an active session",
          });
        }
        emitDebug(
          "voice.timeline",
          "simulate_voice",
          "info",
          { sessionKey: reopenSessionKey },
          () => ({
            messageId: request.id || null,
            phase,
            textChars: text.length,
          }),
          undefined,
        );
        if (!server || !handler) {
          return Promise.resolve({
            status: "rejected",
            error: "relay not ready for simulateVoice broadcast",
          });
        }
        server.broadcast(handler.formatScriptedListenReady(reopenSessionKey));
        return Promise.resolve({ status: "accepted" });
      }
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      emitDebug(
        "voice.timeline",
        "simulate_voice",
        phase === "partial" ? "debug" : "info",
        { sessionKey },
        () => ({
          messageId: request.id || null,
          phase,
          textChars: text.length,
        }),
      );
      if (phase === "arm" || phase === "disarm") {
        voiceScriptingArmed = phase === "arm";
        return Promise.resolve({ status: "accepted" });
      }
      if (!server || !handler) {
        return Promise.resolve({
          status: "rejected",
          error: "relay not ready for simulateVoice broadcast",
        });
      }
      if (phase === "partial") {
        server.broadcast(handler.formatTranscription(text, false));
        return Promise.resolve({ status: "accepted" });
      }
      if (phase === "commit") {
        server.broadcast(
          handler.formatListenCommitted(text, "endpoint", request.sessionKey || null),
        );

        const publishCommittedUserMessage = () => {
          conversationState.addMessage(
            "user",
            buildLocalUserMessageContent(text, null),
          );
          emitDebug(
            "openclaw.message",
            "user_message",
            "info",
            { sessionKey },
            () => ({ text }),
          );
          broadcastPages();
        };
        const pendingCommitEntry = {

          timer: JSON.parse("null"),
          publish: publishCommittedUserMessage,
        };
        pendingCommitEntry.timer = scheduleSyntheticTimer(
          SIMULATE_VOICE_COMMIT_DISPLAY_GATE_MS,
          () => {

            if (pendingCommitPublishBySession.get(sessionKey) === pendingCommitEntry) {
              pendingCommitPublishBySession.delete(sessionKey);
            }
            publishCommittedUserMessage();
          },
          sessionKey,
        );
        pendingCommitPublishBySession.set(sessionKey, pendingCommitEntry);
        return Promise.resolve({ status: "accepted" });
      }
      server.broadcast(handler.formatListenEnded());
      return Promise.resolve({ status: "accepted" });
    },

    onNewChat() {
      emitDebug(
        "relay.session",
        "new_chat",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({}),
      );
      if (upstreamRuntime && typeof upstreamRuntime.clearTyping === "function") {
        upstreamRuntime.clearTyping("new_chat");
      }
      if (getActiveBackendKind() === "hermes") {
        clearSyntheticWorkForSession(sessionService.ensureSessionKey());
        return sessionService.newSession({
          sendResetCommand: false,
          materializeImmediately: false,
        }).then(async (result) => {
          stablePromptSnapshots.evict(result.sessionKey);
          sessionService.clearDisplayToggleStates(result.sessionKey);
          clearCurrentSessionModelConfigSnapshot("new_chat");
          if (upstreamRuntime && typeof upstreamRuntime.handleSessionChanged === "function") {
            upstreamRuntime.handleSessionChanged("new_chat");
          }
          const sessionModelConfig = await seedOcuClawSessionConfigForNewSession(
            result.sessionKey,
          );
          return {
            ...result,
            draft: true,
            ...(sessionModelConfig ? { sessionModelConfig } : {}),
          };
        });
      }
      sessionService.invalidateSessionsCache();
      resetActivityStatusAdapter();

      clearSyntheticWorkForSession(sessionService.ensureSessionKey());
      conversationState.clear(sessionService.ensureSessionKey(), true);

      const newChatSessionKey = sessionService.ensureSessionKey();
      stablePromptSnapshots.evict(newChatSessionKey);
      clearLogicalSessionState(newChatSessionKey, "new_chat");
      conversationState.setAgentName(
        (upstreamRuntime ? upstreamRuntime.getAgentName() : null) || "Agent",
      );
      const pages = conversationState.getPages();
      cachePages(pages);
      if (upstreamRuntime && upstreamRuntime.isConnected()) {

        gatewayBridge.sendMessage("/new", "main").catch((err) => {
          logger.error(`[relay] Failed to send /new: ${err.message}`);
        });
      }
      return Promise.resolve(pages);
    },

    onGetSessions() {
      return sessionService.getSessions();
    },

    onSwitchSession(sessionKey) {
      return switchToSessionAndRunPostSwitchFlow(sessionKey);
    },

    async onCopySession(sourceKey) {
      const copied = await sessionService.copyForeignSession(sourceKey);
      let pages;
      try {
        pages = await switchToSessionAndRunPostSwitchFlow(copied.key);
      } catch (err) {
        if (!isSupersededSessionSwitchError(err)) throw err;

        broadcastSessions();
        return { sessionKey: copied.key, pages: null, superseded: true };
      }
      broadcastSessions();
      return { sessionKey: copied.key, pages };
    },

    async onNewSession(request = {}) {
      const hasRequestedAgentRef = Reflect.has(request, "agentRef");
      const rawRequestedAgentRef = hasRequestedAgentRef
        ? Reflect.get(request, "agentRef")
        : "";
      const requestedAgentRef =
        typeof rawRequestedAgentRef === "string"
          ? rawRequestedAgentRef.trim()
          : "";
      let resolvedAgentRef = requestedAgentRef;
      if (requestedAgentRef) {
        const catalog = await getCapabilityAgentCatalogSnapshot();
        if (
          !catalog ||
          catalog.unsupported === true ||
          catalog.stale === true ||
          !Array.isArray(catalog.agents)
        ) {
          throw new Error("Agent catalog unavailable.");
        }
        const needle = requestedAgentRef.toLowerCase();
        const match = catalog.agents.find((entry = { id: "", name: "" }) => {
          if (!entry || typeof entry !== "object") return false;
          const id =
            typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
          const name =
            typeof entry.name === "string"
              ? entry.name.trim().toLowerCase()
              : "";
          return id === needle || name === needle;
        });
        if (!match) {
          throw new Error(`No agent named ${requestedAgentRef}.`);
        }
        resolvedAgentRef =
          typeof match.id === "string" && match.id.trim()
            ? match.id.trim()
            : requestedAgentRef;
      }
      if (Reflect.get(request, "scope") === "default") {
        const bindingResult = await setPathwayBinding("app", {
          backend: getActiveBackendKind(),
          agentRef: resolvedAgentRef,
        });
        if (!bindingResult || bindingResult.status !== "accepted") {
          throw new Error("Couldn't save the default session agent.");
        }
      }

      clearSyntheticWorkForSession(sessionService.ensureSessionKey());
      const hermesDraft = getActiveBackendKind() === "hermes";
      const result = await sessionService.newSession({
        ...(hasRequestedAgentRef ? { agentRef: resolvedAgentRef } : {}),
        sendResetCommand: !hermesDraft,
        materializeImmediately: !hermesDraft,
      });

      if (result && typeof result.sessionKey === "string" && result.sessionKey.trim()) {
        stablePromptSnapshots.evict(result.sessionKey);
        sessionService.clearDisplayToggleStates(result.sessionKey);
      }
      clearCurrentSessionModelConfigSnapshot("new_session");
      if (upstreamRuntime && typeof upstreamRuntime.clearTyping === "function") {
        upstreamRuntime.clearTyping("new_session");
      }
      if (upstreamRuntime && typeof upstreamRuntime.handleSessionChanged === "function") {
        upstreamRuntime.handleSessionChanged("new_session");
      }
      const sessionModelConfig = await seedOcuClawSessionConfigForNewSession(
        result && result.sessionKey,
      );
      return sessionModelConfig
        ? {
            ...result,
            draft: hermesDraft,
            sessionModelConfig,
          }
        : { ...result, draft: hermesDraft };
    },

    async createEtSession(provider, text) {
      if (typeof opts.onEtCreateSession !== "function") return null;
      let newKey = null;
      try {
        newKey = await opts.onEtCreateSession(provider, text);
      } catch (e) {
        logger.warn(`[relay] onEtCreateSession: ${e.message}`);
        return null;
      }
      if (!newKey || !isEtSessionKey(newKey)) return null;

      if (typeof opts.onEtSessionActivated === "function") {
        try { opts.onEtSessionActivated(newKey); } catch (e) { logger.warn(`[relay] onEtSessionActivated: ${e.message}`); }
      }
      let pages;
      try {
        pages = await sessionService.switchToSession(newKey);
      } catch (err) {
        if (!isSupersededSessionSwitchError(err)) throw err;

        return { sessionKey: newKey, pages: null, superseded: true };
      }
      clearCurrentSessionModelConfigSnapshot("create_et_session");

      broadcastStatus();
      return { sessionKey: newKey, pages };
    },

    onGetModelsCatalog() {
      return upstreamRuntime
        ? upstreamRuntime.getModelsCatalogSnapshot()
        : Promise.resolve({ models: [], fetchedAtMs: Date.now(), stale: true });
    },

    onGetSkillsCatalog() {
      return upstreamRuntime
        ? upstreamRuntime.getSkillsCatalogSnapshot()
        : Promise.resolve({ skills: [], fetchedAtMs: Date.now(), stale: true });
    },

    onGetLiveuiLibrary() {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller ? controller.listLibrary() : [];
    },

    onOpenLiveuiLibraryItem({ clientId, itemType, itemId }) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) {
        return { itemType, itemId, status: "rejected", code: "item_unavailable" };
      }
      return controller.openLibraryItem({
        clientId,
        itemType,
        itemId,
        sessionKey: sessionService.ensureSessionKey(),
        origin: "glasses",
        taskRunController: liveuiTaskRunController,
      });
    },

    onCancelLiveuiTaskLaunch({ clientId, taskId }) {
      if (!liveuiTaskRunController) return false;
      return liveuiTaskRunController.cancelTaskLaunch({ clientId, taskId });
    },

    onGetLiveuiTasksForPhone() {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller
        ? controller.listTasksForPhone()
        : { tasks: [], templates: [], invalid: [] };
    },

    onGetLiveuiTaskRunsForPhone(taskId) {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller && typeof controller.listTaskRunRecords === "function"
        ? controller.listTaskRunRecords(taskId)
        : [];
    },

    onGetLiveuiTaskExecutors() {
      return listLiveuiTaskExecutors();
    },

    onSetLiveuiTaskExecutor({ taskId, executor }) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      return controller.updateTaskExecutor(taskId, executor);
    },

    onSetLiveuiTaskSettingValues({ taskId, expectedDigest, values }) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.updateTaskSettingValues !== "function") {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      return controller.updateTaskSettingValues(taskId, values, { expectedDigest });
    },

    onSetLiveuiTaskPreferredTemplate({ taskId, expectedDigest, templateId }) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.updateTaskPreferredTemplate !== "function") {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      return controller.updateTaskPreferredTemplate({ taskId, expectedDigest, templateId });
    },

    isPhoneClient(clientId) {
      const snapshot =
        server && typeof server.getReadinessSnapshot === "function"
          ? server.getReadinessSnapshot()
          : null;
      const entry = snapshot && Array.isArray(snapshot.clients)
        ? snapshot.clients.find((client) => client && client.clientId === clientId)
        : null;
      return !!(entry && entry.clientKind === "app");
    },

    onReviewLiveuiTask({ taskId, action, expectedDigest }) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) {
        return { taskId, action, status: "rejected", code: "item_unavailable" };
      }
      return controller.reviewTask({ taskId, action, expectedDigest });
    },

    onSetLiveuiTaskContext({ taskId, context }) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.updateTaskContext !== "function") {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      const result = controller.updateTaskContext(taskId, context);
      return result && result.status === "saved"
        ? { taskId, status: "accepted" }
        : {
          taskId,
          status: "rejected",
          code: result && typeof result.code === "string"
            ? result.code
            : "task_context_update_failed",
        };
    },

    onGetLiveuiPrefs() {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.getLiveuiPrefs !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      return controller.getLiveuiPrefs();
    },

    onSetLiveuiPrefs({ patch }) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.setLiveuiPrefs !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      const result = controller.setLiveuiPrefs(patch);

      if (result && result.status === "accepted" && Array.isArray(result.clearedSessionKeys)) {
        for (const sessionKey of result.clearedSessionKeys) {
          clearGlassesUiSurfacesOnly(sessionKey, "liveui_disabled");
        }
      }
      return result;
    },

    onGetLiveuiStatus() {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.getLiveuiStatus !== "function") return null;
      return controller.getLiveuiStatus();
    },

    onOrganizeLiveuiLibrary(params) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) {
        return {
          action: params && typeof params.action === "string" ? params.action : "",
          status: "rejected",
          code: "item_unavailable",
        };
      }
      return controller.organizeLibrary(params);
    },

    onGetCommandCatalog() {
      return upstreamRuntime
        ? upstreamRuntime.getCommandCatalogSnapshot()
        : Promise.resolve({
            commands: [],
            fetchedAtMs: Date.now(),
            stale: true,
            unsupported: true,
            backendKind: "none",
            executes: "intercepted-only",
          });
    },

    onGetAgentsCatalog() {
      return upstreamRuntime
        ? upstreamRuntime.getAgentsCatalogSnapshot()
        : Promise.resolve({
            agents: [],
            defaultId: null,
            mainKey: null,
            scope: null,
            fetchedAtMs: Date.now(),
            stale: true,
            unsupported: true,
          });
    },

    onGetProviderUsageSnapshot() {
      return upstreamRuntime
        ? upstreamRuntime.getProviderUsageSnapshot()
        : Promise.resolve({
            sessionKey: null,
            provider: null,
            displayName: null,
            limitingWindowKey: null,
            windows: [],
            fetchedAtMs: Date.now(),
            stale: true,
          });
    },

    onGetSonioxModels() {
      return getSonioxModelsSnapshot();
    },

    onGetStatus() {
      return buildStatusObject({ includeDownstreamReadiness: true });
    },

    onGetSessionModelConfig() {
      return sessionService.getCurrentSessionModelConfig();
    },

    async onSetSessionModelConfig(patch) {
      const result = await sessionService.setCurrentSessionModelConfig(patch || {});
      if (
        result &&
        result.status === "accepted" &&
        result.config &&
        isActiveSessionModelConfig(result.config)
      ) {
        currentSessionModelConfigSnapshot = result.config;
        server.broadcast(handler.formatSessionModelConfig(result.config));
      }
      return result;
    },

    onSetSessionAgent(patch) {
      if (getActiveBackendKind() === "hermes") {
        return {
          status: "rejected",
          error:
            "Hermes profiles own separate chats. Open or create the profile chat instead.",
        };
      }
      const sessionKey = sessionService.ensureSessionKey();
      const result = sessionService.setSessionAgentId(
        sessionKey,
        (patch && patch.agentId) || "",
      );
      if (!result || result.ok !== true) {
        return {
          status: "rejected",
          error: (result && result.reason) || "invalid session agent",
        };
      }

      if (typeof sessionService.primeSessionModelConfig === "function") {
        const config = sessionService.primeSessionModelConfig(sessionKey, {});
        if (config && isActiveSessionModelConfig(config)) {
          currentSessionModelConfigSnapshot = config;
          if (server) {
            server.broadcast(handler.formatSessionModelConfig(config));
          }
        }
      }
      broadcastSessions();
      return { status: "accepted" };
    },

    onGetEvenAiSettings() {
      return evenAiSettingsStore.getSnapshot();
    },

    onGetOcuClawSettings() {
      return getOcuClawSettingsSnapshot();
    },

    async onGetEvenAiSessions() {
      return buildEvenAiSessionsSnapshot();
    },

    async onSetEvenAiSettings(patch) {
      const result = await evenAiSettingsStore.setSettings(patch || {});
      if (result && result.status === "accepted" && result.settings && server) {
        server.broadcast(handler.formatEvenAiSettings(result.settings));
      }
      return result;
    },

    async onSetOcuClawSettings(patch) {
      return applyOcuClawSettingsPatch(patch || {});
    },

    onSlashCommand(command) {
      emitDebug(
        "relay.protocol",
        "slash_command",
        "debug",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({ command }),
      );
      if (command === "/reset" && getActiveBackendKind() !== "hermes") {
        sessionService.invalidateSessionsCache();
        resetActivityStatusAdapter();
        clearSyntheticWorkForSession(sessionService.ensureSessionKey());
        conversationState.clear(sessionService.ensureSessionKey(), true);
        if (upstreamRuntime && typeof upstreamRuntime.clearTyping === "function") {
          upstreamRuntime.clearTyping("slash_reset");
        }
        conversationState.setAgentName(
          (upstreamRuntime ? upstreamRuntime.getAgentName() : null) || "Agent",
        );
        broadcastPages();
      }

      if (
        getActiveBackendKind() !== "hermes" &&
        (command === "/new" || command === "/reset")
      ) {
        const resetKey = sessionService.ensureSessionKey();
        stablePromptSnapshots.evict(resetKey);

        clearLogicalSessionState(
          resetKey,
          command === "/new" ? "slash_new" : "slash_reset",
        );
      }
      if (upstreamRuntime && upstreamRuntime.isConnected()) {

        const outboundCommand =
          command === "/reset" && getActiveBackendKind() !== "hermes"
            ? `/reset ${activeNewSessionGreetingPrompt()}`
            : command;
        const resetSessionKey = sessionService.ensureSessionKey();
        const resetGatewaySession = openclawGatewayKeyFor(resetSessionKey);
        return gatewayBridge.sendMessage(
          outboundCommand,
          resetSessionKey,
          null,
          resetGatewaySession.agentId
            ? { agentId: resetGatewaySession.agentId }
            : undefined,
        );
      }
      return Promise.resolve();
    },

    isUpstreamConnected() {
      return true;
    },

    onConsoleLog(level, message) {
      writeConsoleLog(level, message);
      if (level === "event") {
        emitDebug(
          "sdk.events",
          "event_debug",
          "debug",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            level,
            message,
          }),
        );
      }
    },

    onEventDebug(clientId, payload) {
      if (!payload || typeof payload !== "object") return;
      const cat = payload.cat;
      const forceStore =
        isForcedReadinessProofEvent(payload) || isForcedLiveuiFailureEvent(payload);
      if (!forceStore && !debugStore.isEnabled(cat)) return;
      emitDebug(
        cat,
        payload.event,
        payload.severity || "debug",
        {
          sessionKey: payload.sessionKey || sessionService.ensureSessionKey(),
          runId: payload.runId || null,
          screen: payload.screen || null,
        },
        () => ({
          clientId,
          ...(payload.data || {}),
        }),
        { force: forceStore },
      );

      if (isForcedLiveuiFailureEvent(payload)) {
        dispatchGlassesUiClientFailure(clientId, payload.data || {});
      }
    },

    onApprovalResolve(id, decision, meta = { reason: undefined }) {

      if (syntheticApprovals.has(id)) {
        resolveSyntheticApproval(id, decision, "manual");
        return Promise.resolve({ ok: true, synthetic: true });
      }
      return gatewayBridge.resolveApproval(id, decision, {
        reason: meta && meta.reason,
      });
    },

    onRequestSonioxTemporaryKey(clientId, request) {
      if (voiceScriptingArmed) {

        emitDebug(
          "voice.timeline",
          "soniox_temp_key_parked",
          "info",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({
            clientId,
            voiceSessionId:
              request && typeof request.voiceSessionId === "string"
                ? request.voiceSessionId
                : null,
          }),
        );
        return new Promise(() => {});
      }
      return mintSonioxTemporaryKey(clientId, request);
    },

    onRequestCartesiaAccessToken(clientId, request) {
      return mintCartesiaAccessToken(clientId, request);
    },

    onDebugSet(clientId, request) {
      return applyDebugSet(clientId, request);
    },

    onTraceLogSet(clientId, request) {
      return applyTraceLogSet(clientId, request);
    },
    onTraceLogGet() {
      return { ok: true, enabled: liveUiTraceLogEnabled, persistedPath: liveUiTraceFlagPath };
    },

    onDebugDump(clientId, request) {
      const result = debugStore.dump(request);
      if (!result.ok) {
        throw new Error(result.error || "debug-dump failed");
      }

      emitDebug(
        "relay.protocol",
        "debug_dump",
        "debug",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          categories: result.categories,
          redaction: result.redaction,
          limit: result.limit,
          returned: result.returned,
          totalMatched: result.totalMatched,
        }),
      );

      return result;
    },

    onRemoteControl(clientId, request) {
      const now = Date.now();
      const requestId =
        (typeof request.requestId === "string" && request.requestId.trim()) ||
        `rc-${now}-${Math.random().toString(16).slice(2, 8)}`;
      const isDebugCloseAppClientAction =
        request &&
        request.action === "relay-action" &&
        request.relayAction === "debug-close-app-client";
      const recipientEstimate = server ? server.getConnectedAppCount(clientId) : 0;

      emitDebug(
        "relay.protocol",
        "remote_control_requested",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          action: request.action || "unknown",
          recipientEstimate,
        }),
      );

      if (recipientEstimate <= 0) {
        return {
          ok: false,
          requestId,
          message: "No downstream app clients connected",
          detail: { recipientEstimate },
        };
      }

      if (isDebugCloseAppClientAction) {
        if (!server || typeof server.closeConnectedAppClients !== "function") {
          return {
            ok: false,
            requestId,
            message: "Downstream close hook unavailable",
            detail: { recipientEstimate },
          };
        }
        const closeResult = server.closeConnectedAppClients({
          excludeClientId: clientId,
          reason: "debug_close_app_client",
        });
        emitDebug(
          "relay.protocol",
          "remote_control_server_action_applied",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            clientId,
            requestId,
            action: request.action || "unknown",
            relayAction: request.relayAction || null,
            recipientEstimate,
            closedCount: closeResult.closedCount,
            closedClientIds: closeResult.closedClientIds,
            reason: closeResult.reason,
          }),
        );
        return {
          ok: closeResult.closedCount > 0,
          requestId,
          message:
            closeResult.closedCount > 0
              ? `Closed ${closeResult.closedCount} app client(s)`
              : "No downstream app clients connected",
          detail: {
            recipientEstimate,
            closedCount: closeResult.closedCount,
            closedClientIds: closeResult.closedClientIds,
            reason: closeResult.reason,
          },
        };
      }

      const control = {
        ...request,
        requestId,
        issuedAtMs: now,
        issuedByClientId: clientId,
      };

      if (control.action === "send-message") {
        armRemoteSendRunBinding({
          requestId,
          clientId,
          sessionKey: control.sessionKey || null,
        });
      }

      emitDebug(
        "relay.protocol",
        "remote_control_dispatched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          action: control.action || "unknown",
          recipientEstimate,
          runBindingArmed: control.action === "send-message",
        }),
      );

      return {
        ok: true,
        requestId,
        message: `Dispatched to ${recipientEstimate} client(s)`,
        detail: { recipientEstimate },
        control,
      };
    },

    onReadinessProbe(clientId, request) {
      const now = Date.now();
      const requestId =
        (typeof request.requestId === "string" && request.requestId.trim()) ||
        `readiness-${now}-${Math.random().toString(16).slice(2, 8)}`;
      const sinceMs = Number.isFinite(Number(request && request.sinceMs))
        ? Math.max(0, Math.floor(Number(request.sinceMs)))
        : now;
      const snapshot =
        server && typeof server.getReadinessSnapshot === "function"
          ? server.getReadinessSnapshot()
          : {
              connectedClientCount: 0,
              fanoutRecipientCount: 0,
              clients: [],
            };
      const targetClientId =
        snapshot &&
        snapshot.connectedClientCount === 1 &&
        snapshot.fanoutRecipientCount === 1 &&
        Array.isArray(snapshot.clients) &&
        snapshot.clients.length === 1 &&
        typeof snapshot.clients[0].clientId === "string"
          ? snapshot.clients[0].clientId
          : null;

      emitDebug(
        "relay.protocol",
        "readiness_probe_requested",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          sinceMs,
          requestedSessionKey:
            typeof request.sessionKey === "string" && request.sessionKey.trim()
              ? request.sessionKey.trim()
              : null,
          connectedClientCount:
            snapshot && Number.isFinite(snapshot.connectedClientCount)
              ? snapshot.connectedClientCount
              : 0,
          fanoutRecipientCount:
            snapshot && Number.isFinite(snapshot.fanoutRecipientCount)
              ? snapshot.fanoutRecipientCount
              : 0,
        }),
      );

      if (
        !snapshot ||
        snapshot.connectedClientCount <= 0 ||
        snapshot.fanoutRecipientCount <= 0
      ) {
        return {
          ok: false,
          requestId,
          reasonCode: "no_downstream_client",
          message: "No downstream app clients connected",
        };
      }

      if (
        snapshot.connectedClientCount > 1 ||
        snapshot.fanoutRecipientCount > 1 ||
        !targetClientId
      ) {
        return {
          ok: false,
          requestId,
          reasonCode: "multi_recipient_fanout",
          message: "Multiple downstream app clients connected",
        };
      }

      emitDebug(
        "relay.protocol",
        "readiness_probe_dispatched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          targetClientId,
          sinceMs,
        }),
      );

      return {
        ok: true,
        requestId,
        targetClientId,
        probe: {
          requestId,
          sinceMs,
          sessionKey:
            typeof request.sessionKey === "string" && request.sessionKey.trim()
              ? request.sessionKey.trim()
              : null,
        },
      };
    },

    onAutomationRegistry(clientId) {
      const snapshot =
        server && typeof server.getReadinessSnapshot === "function"
          ? server.getReadinessSnapshot()
          : {
              connectedClientCount: 0,
              fanoutRecipientCount: 0,
              clients: [],
            };
      const targetEntry =
        snapshot &&
        snapshot.connectedClientCount === 1 &&
        snapshot.fanoutRecipientCount === 1 &&
        Array.isArray(snapshot.clients) &&
        snapshot.clients.length === 1
          ? snapshot.clients[0]
          : null;
      const targetClientId =
        targetEntry && typeof targetEntry.clientId === "string"
          ? targetEntry.clientId
          : null;
      const readinessPublished =
        !!(
          targetEntry &&
          targetEntry.readinessSnapshot &&
          Number.isFinite(targetEntry.readinessSnapshot.emittedAtMs)
        );

      emitDebug(
        "relay.protocol",
        "automation_registry_requested",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          connectedClientCount:
            snapshot && Number.isFinite(snapshot.connectedClientCount)
              ? snapshot.connectedClientCount
              : 0,
          fanoutRecipientCount:
            snapshot && Number.isFinite(snapshot.fanoutRecipientCount)
              ? snapshot.fanoutRecipientCount
              : 0,
        }),
      );

      if (
        !snapshot ||
        snapshot.connectedClientCount <= 0 ||
        snapshot.fanoutRecipientCount <= 0
      ) {
        return {
          ok: false,
          reasonCode: "no_downstream_client",
          message: "No downstream app clients connected",
        };
      }

      if (
        snapshot.connectedClientCount > 1 ||
        snapshot.fanoutRecipientCount > 1 ||
        !targetClientId
      ) {
        return {
          ok: false,
          reasonCode: "multi_recipient_fanout",
          message: "Multiple downstream app clients connected",
        };
      }

      if (!readinessPublished) {
        return {
          ok: false,
          reasonCode: "registry_unavailable",
          message: "Automation registry is unavailable",
        };
      }

      emitDebug(
        "relay.protocol",
        "automation_registry_dispatched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          targetClientId,
        }),
      );

      return {
        ok: true,
        targetClientId,
        request: {},
      };
    },

    onAutomationState(clientId, request) {

      const now = Date.now();
      const requestId =
        (typeof request.requestId === "string" && request.requestId.trim()) ||
        `automation-${now}-${Math.random().toString(16).slice(2, 8)}`;
      const requestedSessionKey =
        typeof request.sessionKey === "string" && request.sessionKey.trim()
          ? request.sessionKey.trim()
          : null;
      const snapshot =
        server && typeof server.getReadinessSnapshot === "function"
          ? server.getReadinessSnapshot()
          : {
              connectedClientCount: 0,
              fanoutRecipientCount: 0,
              clients: [],
            };
      const targetEntry =
        snapshot &&
        snapshot.connectedClientCount === 1 &&
        snapshot.fanoutRecipientCount === 1 &&
        Array.isArray(snapshot.clients) &&
        snapshot.clients.length === 1
          ? snapshot.clients[0]
          : null;
      const targetClientId =
        targetEntry && typeof targetEntry.clientId === "string"
          ? targetEntry.clientId
          : null;

      const readinessPublished =
        !!(
          targetEntry &&
          targetEntry.readinessSnapshot &&
          Number.isFinite(targetEntry.readinessSnapshot.emittedAtMs)
        );

      emitDebug(
        "relay.protocol",
        "automation_state_requested",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          requestedSessionKey,
          connectedClientCount:
            snapshot && Number.isFinite(snapshot.connectedClientCount)
              ? snapshot.connectedClientCount
              : 0,
          fanoutRecipientCount:
            snapshot && Number.isFinite(snapshot.fanoutRecipientCount)
              ? snapshot.fanoutRecipientCount
              : 0,
        }),
      );

      if (
        !snapshot ||
        snapshot.connectedClientCount <= 0 ||
        snapshot.fanoutRecipientCount <= 0
      ) {
        return {
          ok: false,
          requestId,
          reasonCode: "no_downstream_client",
          message: "No downstream app clients connected",
        };
      }

      if (
        snapshot.connectedClientCount > 1 ||
        snapshot.fanoutRecipientCount > 1 ||
        !targetClientId
      ) {
        return {
          ok: false,
          requestId,
          reasonCode: "multi_recipient_fanout",
          message: "Multiple downstream app clients connected",
        };
      }

      if (!readinessPublished) {
        return {
          ok: false,
          requestId,
          reasonCode: "snapshot_unavailable",
          message: "Automation state snapshot is unavailable",
        };
      }

      emitDebug(
        "relay.protocol",
        "automation_state_dispatched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          targetClientId,
        }),
      );

      return {
        ok: true,
        requestId,
        targetClientId,
        request: {
          requestId,
          sessionKey: requestedSessionKey,
        },
      };
    },

    resolveEtSendKey(sessionKey) {

      if (sessionKey && isEtSessionKey(sessionKey)) return sessionKey;
      if (!sessionKey && isEtSessionKey(sessionService.ensureSessionKey())) {
        return sessionService.ensureSessionKey();
      }
      return null;
    },

    sendEtPrompt(etKey, text) {
      const m = /^et:(claude|codex):(.+)$/.exec(etKey || "");
      if (m && typeof opts.onEtSend === "function") {
        Promise.resolve(opts.onEtSend(m[1], m[2], text)).catch((e) => logger.warn(`[relay] onEtSend: ${e.message}`));
      }
    },

    tryEtAbort(sessionKey) {

      const key = (sessionKey && isEtSessionKey(sessionKey)) ? sessionKey
        : (!sessionKey && isEtSessionKey(sessionService.ensureSessionKey()) ? sessionService.ensureSessionKey() : null);
      if (!key) return false;
      const m = /^et:(claude|codex):(.+)$/.exec(key);
      if (m && typeof opts.onEtAbort === "function") {
        Promise.resolve(opts.onEtAbort(m[1], m[2])).catch((e) => logger.warn(`[relay] onEtAbort: ${e.message}`));
      }
      return true;
    },
  });

  const pluginVersionService = createPluginVersionService();

  const glassesBackpressureLatch = createGlassesBackpressureLatch({
    emitDebug: (event, severity, data) =>
      emitDebug("relay.health", event, severity, null, () => data || {}),
  });

  server = createRelayWorkerSupervisor({
    pluginId: "ocuclaw",
    getPluginVersion: () => pluginVersionService.getPluginVersion(),
    getRequiresClientVersion: () => pluginVersionService.getRequiresClientVersion(),
    logger,
    handler,
    operationRegistry: relayOperationRegistry,
    host: opts.host,
    port: opts.port,
    token: opts.token,
    onWorkerBackpressure: (message) => glassesBackpressureLatch.report(message),
    externalDebugToolsEnabled,
    evenAiEnabled: opts.evenAiEnabled === true,
    evenAiRequestTimeoutMs: opts.evenAiRequestTimeoutMs,
    evenAiMaxBodyBytes: opts.evenAiMaxBodyBytes,
    evenAiMaxResponseBytes: opts.evenAiMaxResponseBytes,
    getCurrentPages() {
      return cachedPages;
    },
    getCurrentEntries() {
      return cachedEntries;
    },
    getCurrentStatus() {
      return cachedStatus;
    },
    getCurrentDebugConfig() {
      return handler.formatDebugConfigSnapshot(debugStore.getSnapshot());
    },
    getCurrentResumeState() {
      return {
        pagesRevision: pagesRevision || 0,
        entriesRevision: entriesRevision || 0,
        lastSeq: entriesLastSeq,
        statusRevision: statusRevision || 0,
      };
    },
    getAgentAvatarHash: () =>
      upstreamRuntime && typeof upstreamRuntime.getAgentAvatarHash === "function"
        ? upstreamRuntime.getAgentAvatarHash()
        : null,
    getAgentAvatarDataUriByHash: (hash) =>
      upstreamRuntime && typeof upstreamRuntime.getAgentAvatarDataUriByHash === "function"
        ? upstreamRuntime.getAgentAvatarDataUriByHash(hash)
        : null,
    handleBufferedEvenAiHttpRequest(envelope) {
      return handleBufferedEvenAiHttpRequest(envelope);
    },
    cancelBufferedEvenAiHttpRequest(envelope) {
      return cancelBufferedEvenAiHttpRequest(envelope);
    },
    onPairingAuthenticatedHello(hello) {
      notePairingAuthenticatedHello(hello);
    },
    getActiveSessionKey() {
      return sessionService.peekSessionKey() || null;
    },
    onAppClientDisconnect(sessionKey) {
      dispatchAppClientDisconnect(sessionKey);
      if (server && server.getConnectedAppCount() === 0) {
        demandRouter.forgetExternal("client_disconnect");
      }
    },
    onAppClientIdentified(clientId, entry) {
      if (appClientSupportsCapabilitySnapshot(entry)) {
        setTimeout(() => unicastCapabilitySnapshot(clientId), 0);
      }
      if (
        Array.isArray(entry && entry.clientCapabilities) &&
        entry.clientCapabilities.includes("ledgerV1")
      ) {

        setTimeout(() => broadcastEntriesForActiveLedgerClients(), 0);
      }
    },
    onAppPresenceChanged(reason) {
      dispatchAppPresenceChanged(reason);
    },
    emitDebug(category, event, severity, context, payloadFactory, options) {
      emitDebug(category, event, severity, context, payloadFactory, options);
    },
  });

  function buildStatusObject(options = {}) {
    const includeDownstreamReadiness = options.includeDownstreamReadiness === true;
    const activeSessionKey = sessionService.ensureSessionKey();

    const etActive = parseEtSessionKey(activeSessionKey);
    const evenTerminalProviders =
      opts.evenTerminalEnabled === true && typeof opts.etAvailableProviders === "function"
        ? sanitizeEtProviderList(opts.etAvailableProviders())
        : [];
    const status = {
      openclaw:
        upstreamRuntime && upstreamRuntime.isConnected()
          ? "connected"
          : "disconnected",
      agent: etActive
        ? etProviderDisplayName(etActive.provider)
        : (upstreamRuntime ? upstreamRuntime.getAgentName() : null),
      agentEmoji: upstreamRuntime ? upstreamRuntime.getAgentEmoji() : null,
      agentAvatarHash: upstreamRuntime ? upstreamRuntime.getAgentAvatarHash() : null,
      session: activeSessionKey,
      liveUiSessionGeneration: ensureLiveUiSessionGeneration(activeSessionKey),
      evenAiEnabled: opts.evenAiEnabled === true,
      evenTerminalEnabled: opts.evenTerminalEnabled === true,
      evenTerminalProviders,
      ledgerV1: activeConversationSupportsLedger(),
    };
    if (includeDownstreamReadiness) {
      status.downstreamReadiness =
        server && typeof server.getReadinessSnapshot === "function"
          ? server.getReadinessSnapshot()
          : {
              connectedClientCount: 0,
              fanoutRecipientCount: 0,
              updatedAtMs: null,
              clients: [],
            };
    }
    return status;
  }

  function sanitizeEtProviderList(raw) {
    if (!Array.isArray(raw)) return [];
    const allowed = new Set(["codex", "claude"]);
    const seen = new Set();
    const out = [];
    for (const value of raw) {
      const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (!allowed.has(provider) || seen.has(provider)) continue;
      seen.add(provider);
      out.push(provider);
    }
    return out;
  }

  function cachePages(pages = [], ledgerV1 = false) {
    const nextRevision = pagesRevision + 1;
    const assistantCommit =
      typeof conversationState.getAssistantCommitSnapshot === "function"
        ? conversationState.getAssistantCommitSnapshot()
        : null;
    const activeSessionKey =
      typeof sessionService.peekSessionKey === "function"
        ? sessionService.peekSessionKey()
        : null;
    const next = handler.formatPages(pages, {
      revision: nextRevision,
      ledgerV1,
      assistantCommit:
        assistantCommit && activeSessionKey
          ? { ...assistantCommit, sessionKey: activeSessionKey }
          : null,
    });
    if (next !== cachedPages) {
      cachedPages = next;
      pagesRevision = nextRevision;
    }
    return cachedPages;
  }

  function activeConversationSupportsLedger() {
    const activeSessionKey = sessionService.peekSessionKey();
    if (isEtSessionKey(activeSessionKey)) return false;
    return !!(
      conversationState &&
      typeof conversationState.isLedgerCapable === "function" &&
      conversationState.isLedgerCapable()
    );
  }

  function activeLedgerSnapshot() {
    if (!activeConversationSupportsLedger()) return null;
    const snapshot = conversationState.getEntries();
    return snapshot && snapshot.ledgerV1 === true ? snapshot : null;
  }

  function hasActiveLedgerClient() {
    if (!server || typeof server.getReadinessSnapshot !== "function") return false;
    const readiness = server.getReadinessSnapshot();
    return !!(
      readiness &&
      Array.isArray(readiness.clients) &&
      readiness.clients.some((client) =>
        Array.isArray(client && client.clientCapabilities) &&
        client.clientCapabilities.includes("ledgerV1")
      )
    );
  }

  function broadcastEntriesForActiveLedgerClients() {
    if (!hasActiveLedgerClient()) return;
    const snapshot = activeLedgerSnapshot();
    if (snapshot !== null) server.broadcast(cacheEntries(snapshot));
  }

  function cacheEntries(snapshot = {}) {
    const sessionId = sessionService.peekSessionKey();
    cachedEntries = handler.formatEntries(snapshot, sessionId);
    entriesRevision = Number.isFinite(Number(snapshot.entriesRevision))
      ? Math.max(0, Math.floor(Number(snapshot.entriesRevision)))
      : entriesRevision;
    entriesLastSeq = Number.isFinite(Number(snapshot.lastSeq))
      ? Math.floor(Number(snapshot.lastSeq))
      : -1;
    return cachedEntries;
  }

  function cacheStatus(statusObj) {
    const nextRevision = statusRevision + 1;
    const next = handler.formatStatus(statusObj, { revision: nextRevision });
    if (next !== cachedStatus) {
      cachedStatus = next;
      statusRevision = nextRevision;
    }
    return cachedStatus;
  }

  function broadcastPages(options = {}) {
    const pages = conversationState.getPages();
    const ledgerSnapshot = activeLedgerSnapshot();
    const preserveLedgerLane =
      options.preserveLedgerLane === true && hasActiveLedgerClient() && !!cachedEntries;
    const next = cachePages(pages, ledgerSnapshot !== null || preserveLedgerLane);
    if (next !== null) {
      server.broadcast(next);
    }
    if (ledgerSnapshot !== null) {
      const entriesFrame = cacheEntries(ledgerSnapshot);

      server.broadcast(entriesFrame);
    } else if (!preserveLedgerLane) {
      cachedEntries = "";
      entriesLastSeq = -1;
    }
    return preserveLedgerLane;
  }

  function broadcastSessions() {
    return sessionService
      .getSessions()
      .then((sessions) => {
        server.broadcast(handler.formatSessions(sessions));
      })
      .catch((err) => {
        emitDebug(
          "relay.session",
          "session_broadcast_failed",
          "debug",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({ message: err && err.message ? err.message : String(err) }),
        );
      });
  }

  async function buildEvenAiSessionsSnapshot() {
    const dedicatedKey =
      evenAiRouter && typeof evenAiRouter.getDedicatedSessionKey === "function"
        ? evenAiRouter.getDedicatedSessionKey()
        : noRouterEvenAiDedicatedSessionKey;
    const dedicatedEvenAiKey = normalizeEvenAiSessionKeyForLookup(dedicatedKey);
    const trackedThrowawayKeys =
      typeof evenAiSettingsStore.getTrackedThrowawayKeys === "function"
        ? evenAiSettingsStore.getTrackedThrowawayKeys()
        : [];
    const normalizedTrackedThrowawayKeys = dedupeNormalizedSessionKeys(
      trackedThrowawayKeys,
    );
    const resolvedSessions = await sessionService.getSessionsByExactKeys([
      ...normalizedTrackedThrowawayKeys,
      ...(dedicatedEvenAiKey ? [dedicatedEvenAiKey] : []),
    ]);
    const normalizedDedicatedKey = dedicatedEvenAiKey.toLowerCase();
    const sessions = [];
    let dedicatedIncluded = false;
    for (const session of resolvedSessions) {
      if (
        !dedicatedIncluded &&
        session &&
        typeof session.key === "string" &&
        session.key.trim().toLowerCase() === normalizedDedicatedKey
      ) {
        sessions.push(session);
        dedicatedIncluded = true;
        continue;
      }

      if (session && session.hidden === true) continue;
      sessions.push(session);
    }
    if (!dedicatedIncluded && dedicatedEvenAiKey) {
      sessions.unshift({
        key: dedicatedEvenAiKey,
        updatedAt: 0,
        preview: "",
        firstUserMessage: "",
      });
    }
    return { sessions, dedicatedKey };
  }

  function broadcastEvenAiSessions() {
    if (!server) return;
    buildEvenAiSessionsSnapshot()
      .then((payload) => {
        server.broadcast(handler.formatEvenAiSessions(payload));
      })
      .catch((err) => {
        emitDebug(
          "relay.session",
          "session_broadcast_failed",
          "debug",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({
            kind: "evenai",
            message: err && err.message ? err.message : String(err),
          }),
        );
      });
  }

  function broadcastStatus() {
    const next = cacheStatus(buildStatusObject());
    if (next !== null) {
      server.broadcast(next);
    }
    if (server && typeof server.notifyAgentAvatarChanged === "function") {
      const hash =
        upstreamRuntime && typeof upstreamRuntime.getAgentAvatarHash === "function"
          ? upstreamRuntime.getAgentAvatarHash()
          : null;
      const dataUri =
        hash &&
        upstreamRuntime &&
        typeof upstreamRuntime.getAgentAvatarDataUriByHash === "function"
          ? upstreamRuntime.getAgentAvatarDataUriByHash(hash)
          : null;
      server.notifyAgentAvatarChanged(hash, dataUri);
    }
  }

  let hermesClarifyRouter = null;
  let openClawQuestionRouter = null;

  upstreamRuntime = createUpstreamRuntime({
    logger,
    stateDir: opts.stateDir,
    gatewayBridge,
    conversationState,
    sessionService,
    handler,
    emitDebug,
    broadcastPages,
    broadcastStatus,
    broadcastActivity,
    broadcastProviderUsageSnapshot,
    broadcastSkillsCatalog,
    broadcastCommandCatalog,
    broadcastAgentsCatalog,
    operationRegistry: relayOperationRegistry,
    getCurrentSessionModelConfigSnapshot() {
      return currentSessionModelConfigSnapshot;
    },

    getAgentProgressNotes() {

      return Reflect.get(ocuClawSettingsStore.getSnapshot(), "agentProgressNotes") ?? null;
    },
    observeTaskToolUse(params) {
      return liveuiTaskRunController
        ? liveuiTaskRunController.observeToolUse(params)
        : false;
    },
    observeTaskApproval(params) {
      return liveuiTaskRunController
        ? liveuiTaskRunController.observeApproval(params)
        : false;
    },
    resetActivityStatusAdapter,
    modelsCacheTtlMs: opts.modelsCacheTtlMs,
    getServer() {
      return server;
    },
    getVoiceRuntime() {
      return null;
    },
    onClarify(data) {
      if (!hermesClarifyRouter) {
        logger.warn("[hermes] clarify dropped before demand router initialization");
        return false;
      }
      return hermesClarifyRouter.handleRequest(data);
    },
    onQuestion(data) {
      if (!openClawQuestionRouter) {
        logger.warn("[openclaw] question dropped before demand router initialization");
        return false;
      }
      return openClawQuestionRouter.handleRequest(data);
    },
    onQuestionResolved(data) {
      return openClawQuestionRouter?.handleResolved(data) || false;
    },
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
    fetchAgentAvatar: opts.fetchAgentAvatar,
  });

  async function resolveLiveuiTaskExecutor(executor) {
    const catalog = await getCapabilityAgentCatalogSnapshot();
    updateLiveuiExecutorRegistry(catalog);
    const projected = resolveLiveuiTaskExecutorState(
      executor,
      {},
      catalog && Array.isArray(catalog.agents) ? catalog.agents : liveuiAgents,
    );
    if (projected.state === "unavailable") return projected;
    if (
      !catalog ||
      catalog.unsupported === true ||
      catalog.stale === true ||
      !Array.isArray(catalog.agents)
    ) return { state: "unavailable", reason: "backend_incompatible" };
    if (projected.state !== "ready") return projected;
    const needle = executor.agentId.trim().toLowerCase();
    const match = catalog.agents.find((entry = {}) => {
      const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
      const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
      return id === needle || name === needle;
    });
    if (!match) return { state: "needs_setup", reason: "executor_missing" };
    const agentId = typeof match.id === "string" && match.id.trim()
      ? match.id.trim()
      : executor.agentId.trim();
    return {
      state: "ready",
      executor: { host: relayBackendKind, agentId },
    };
  }

  async function createLiveuiTaskSession(executor) {
    clearSyntheticWorkForSession(sessionService.ensureSessionKey());
    const hermesDraft = relayBackendKind === "hermes";
    const result = await sessionService.newSession({
      agentRef: executor.agentId,
      sendResetCommand: false,
      materializeImmediately: !hermesDraft,
    });
    if (result && typeof result.sessionKey === "string" && result.sessionKey.trim()) {
      stablePromptSnapshots.evict(result.sessionKey);
      sessionService.clearDisplayToggleStates(result.sessionKey);
    }
    clearCurrentSessionModelConfigSnapshot("liveui_task_launch");
    if (upstreamRuntime && typeof upstreamRuntime.clearTyping === "function") {
      upstreamRuntime.clearTyping("liveui_task_launch");
    }
    if (upstreamRuntime && typeof upstreamRuntime.handleSessionChanged === "function") {
      upstreamRuntime.handleSessionChanged("liveui_task_launch");
    }
    const sessionModelConfig = await seedOcuClawSessionConfigForNewSession(result.sessionKey);
    if (server) {
      server.broadcast(handler.formatSessionSwitched(result.sessionKey, "", hermesDraft));
      server.broadcast(handler.formatPages(result.pages, {}));
      if (sessionModelConfig) {
        server.broadcast(handler.formatSessionModelConfig(sessionModelConfig));
      }
    }
    broadcastStatus();
    void broadcastSessions();
    return { sessionKey: result.sessionKey };
  }

  function broadcastLiveuiTasksSnapshot() {
    try {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.listTasksForPhone !== "function") return;
      server.broadcast(handler.formatLiveuiTasks(controller.listTasksForPhone() || {}));
    } catch (err) {
      logger.warn(
        `[liveui] Task Run snapshot broadcast failed: ${err && err.message ? err.message : err}`,
      );
    }
  }

  liveuiTaskRunController = createLiveuiTaskRunController({
    host: relayBackendKind,
    loadTask(taskId) {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller && typeof controller.readTaskForRun === "function"
        ? controller.readTaskForRun(taskId)
        : { status: "rejected", code: "task_not_found" };
    },
    resolveTemplateHint(templateId) {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller && typeof controller.resolveTemplateHint === "function"
        ? controller.resolveTemplateHint(templateId)
        : null;
    },
    resolveExecutor: resolveLiveuiTaskExecutor,
    resolveCurrentSession() {
      const sessionKey = sessionService.peekSessionKey();
      if (relayBackendKind === "hermes") {
        const parsed = sessionKey ? parseHermesPublicKey(sessionKey) : null;
        const appAgentRef = getAppPathwayAgentRef();
        return {
          sessionKey: sessionKey || null,
          agentId: parsed
            ? hermesProfileIdForNamespace(parsed.namespace)
            : appAgentRef || hermesProfileIdForNamespace(DEFAULT_HERMES_NAMESPACE),
        };
      }
      return {
        sessionKey: sessionKey || null,
        agentId: sessionKey
          ? sessionService.getSessionAgentId(sessionKey, undefined)
          : getAppPathwayAgentRef() || sessionService.getSessionAgentId("", undefined),
      };
    },
    createSession: createLiveuiTaskSession,
    sendUserMessage({ runId, sessionKey, text, onSessionResolved }) {
      const operation = dispatchOcuClawUserSendOnce({
        id: runId,
        text,
        sessionKey,
        attachment: null,
        clientDisplaySignals: null,
        source: "liveui_task",
      });
      const resolvedSessionKey = sessionService.peekSessionKey();
      if (typeof onSessionResolved === "function") onSessionResolved(resolvedSessionKey);
      return Promise.resolve(operation).then((result) => {
        const status = result && typeof result.status === "string"
          ? result.status.trim().toLowerCase()
          : "accepted";
        if (status !== "accepted" && status !== "queued") {
          throw new Error("Task Request was not accepted");
        }
        return { ...(result || {}), sessionKey: resolvedSessionKey };
      });
    },
    abortSession(sessionKey) {
      return dispatchOcuClawSessionAbort({
        requestId: `liveui-task-abort-${crypto.randomUUID()}`,
        sessionKey,
      });
    },
    newRunId: () => `liveui-task-${crypto.randomUUID()}`,
    onRunStarted() {
      broadcastLiveuiTasksSnapshot();
    },
    onRunEnded(run) {

      broadcastLiveuiTasksSnapshot();
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.appendTaskRunRecord !== "function") return;
      let delivery = typeof run.delivery === "string" ? run.delivery : "none";
      if (typeof controller.deliveryStateOf === "function" && Array.isArray(run.surfaceIds)) {
        for (const surfaceId of run.surfaceIds) {
          const state = controller.deliveryStateOf(surfaceId);
          const rung = state && typeof state.rung === "string" ? state.rung : null;
          if (rung && (delivery === "none" || compareRungs(rung, delivery) > 0)) {
            delivery = rung;
          }
        }
      }
      controller.appendTaskRunRecord(projectTaskRunRecord({
        recordId: `liveui-task-record-${crypto.randomUUID()}`,
        runId: run.runId,
        taskId: run.taskId,
        versionId: run.versionId,
        executor: run.executor,
        context: run.context,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        toolNames: run.toolNames,
        approvals: run.approvals,
        outcome: run.endedReason,
        delivery,
      }));
    },
  });

  async function shouldSeedSessionScopedDefaultForRoute(route) {
    const routingMode =
      route && typeof route.routingMode === "string"
        ? route.routingMode.trim().toLowerCase()
        : "active";
    const sessionKey =
      route && typeof route.sessionKey === "string" ? route.sessionKey.trim() : "";
    if (!sessionKey || routingMode === "active") {
      return false;
    }
    if (routingMode === "background_new") {
      return true;
    }
    if (routingMode !== "background") {
      return false;
    }
    try {
      const existingSessions = await sessionService.getSessionsByExactKeys([sessionKey]);
      return existingSessions.length === 0;
    } catch {
      return false;
    }
  }

  if (opts.evenAiEnabled === true) {
    evenAiRouter = createEvenAiRouter({
      sessionService,
      getRoutingMode() {
        return evenAiSettingsStore.getSnapshot().routingMode;
      },
      dedicatedSessionKey: opts.evenAiDedicatedSessionKey,
      ...evenAiRouterOptions,
    });
    evenAiRunWaiter = createEvenAiRunWaiter({
      gatewayBridge,
      logger,
      emitDebug,
    });
    evenAiEndpoint = createEvenAiEndpoint({
      logger,
      httpServer: sharedHttpServer,
      enabled: true,
      externallyRouted: true,
      token: opts.evenAiToken,
      getSettingsSnapshot() {
        return getEvenAiEndpointSettingsSnapshot();
      },
      getSystemPrompt() {
        return evenAiSettingsStore.getSnapshot().systemPrompt;
      },
      requestTimeoutMs: opts.evenAiRequestTimeoutMs,
      maxBodyBytes: opts.evenAiMaxBodyBytes,
      dedupWindowMs: opts.evenAiDedupWindowMs,
      gatewayBridge,
      router: evenAiRouter,
      runWaiter: evenAiRunWaiter,
      emitDebug,
      dispatchOcuClawUserSend(params) {
        return dispatchOcuClawUserSend(params);
      },
      emitListenInterceptRecovery(params) {
        return emitListenInterceptRecovery(params);
      },
      emitListenInterceptBroadcast(params) {
        return emitListenInterceptBroadcast(params);
      },
      hasConnectedAppClient() {
        return server ? server.getConnectedAppCount() > 0 : false;
      },
      recordFirstSentUserMessage(sessionKey, text) {
        sessionService.recordFirstSentUserMessage(sessionKey, text);
      },
      onSessionRouted(route) {
        if (!route || route.routingMode !== "background_new") {
          return;
        }
        if (
          typeof evenAiSettingsStore.recordTrackedThrowawayKey === "function" &&
          typeof route.sessionKey === "string"
        ) {
          evenAiSettingsStore.recordTrackedThrowawayKey(route.sessionKey);
        }
      },
      async shouldSeedThinkingForRoute(params) {
        const route = params && params.route ? params.route : params;
        const thinkingLevel =
          params && typeof params.thinkingLevel === "string"
            ? params.thinkingLevel.trim().toLowerCase()
            : "";
        if (!thinkingLevel) {
          return false;
        }
        return shouldSeedSessionScopedDefaultForRoute(route);
      },
      async seedFastModeForRoute(params) {
        const route = params && params.route ? params.route : params;
        const settings = evenAiSettingsStore.getSnapshot();
        if (!settings || settings.defaultFastMode !== true) {
          return false;
        }
        if (!(await shouldSeedSessionScopedDefaultForRoute(route))) {
          return false;
        }
        const result = await sessionService.setSessionModelConfig(
          route.sessionKey.trim(),
          { fastMode: true },
        );
        return !!(result && result.status === "accepted");
      },
      async seedDefaultModelForRoute(params) {
        const route = params && params.route ? params.route : params;
        const settings = evenAiSettingsStore.getSnapshot();
        const modelRef =
          settings && typeof settings.defaultModel === "string"
            ? settings.defaultModel.trim()
            : "";
        if (!modelRef) {
          return false;
        }
        if (!(await shouldSeedSessionScopedDefaultForRoute(route))) {
          return false;
        }
        const result = await sessionService.setSessionModelConfig(
          route.sessionKey.trim(),
          { modelRef },
        );
        return !!(result && result.status === "accepted");
      },
      resolveAgentForRoute(params) {
        const route = params && params.route ? params.route : params;
        const routingMode =
          (route && typeof route.routingMode === "string"
            ? route.routingMode.trim().toLowerCase()
            : "") || "active";
        const sessionKey =
          route && typeof route.sessionKey === "string"
            ? route.sessionKey.trim()
            : "";

        if (routingMode === "active") {
          return sessionKey ? sessionService.getSessionAgentId(sessionKey) : "";
        }
        const evenAiDefault = normalizeEvenAiDefaultAgent(
          evenAiSettingsStore.getSnapshot().defaultAgent,
        );
        if (sessionKey && evenAiDefault) {

          sessionService.setSessionAgentId(sessionKey, evenAiDefault);
        }
        return evenAiDefault;
      },
      getAgentsCatalogSnapshot() {
        return getCapabilityAgentCatalogSnapshot();
      },
      setHeyEvenBinding(binding = { backend: "", agentRef: "" }) {
        return setPathwayBinding("heyEven", binding);
      },
      onSessionActivated(route) {
        if (!route || !route.sessionChanged) {
          return;
        }
        server.broadcast(handler.formatSessionSwitched(route.sessionKey));
        if (cachedPages !== null) {
          server.broadcast(cachedPages);
        }
      },
      isUpstreamConnected() {
        return upstreamRuntime ? upstreamRuntime.isConnected() : false;
      },
    });
  }

  let pairingEndpointService = null;
  let pairingExchangeHost = null;
  let pairingEndpointPromise = null;

  function ensurePairingEndpoint() {
    if (pairingEndpointPromise) return pairingEndpointPromise;
    pairingEndpointPromise = (async () => {
      let noiseSuite = null;
      try {
        noiseSuite = await resolveNoiseSuite();
      } catch (err) {
        noiseSuite = null;
        logger.warn(
          `[ocuclaw] pairing noise suite probe failed: ${err && err.message ? err.message : err}`,
        );
      }
      if (!noiseSuite) {
        logger.warn(
          "[ocuclaw] pairing endpoint held: this runtime cannot carry the Noise handshake",
        );
        return null;
      }
      const service = createPairingEndpointService({
        onHandlerError: () => {
          logger.warn(
            "[ocuclaw] pairing endpoint handler failed; phone response stayed fail-closed",
          );
        },

        tick: () => {
          if (pairingExchangeHost) pairingExchangeHost.tick();
        },

        activeExchangeId: () => {
          try {
            const snapshot = pairingExchangeHost && pairingExchangeHost.snapshot();
            return snapshot && snapshot.exchangeId ? snapshot.exchangeId : null;
          } catch {
            return null;
          }
        },
      });
      pairingExchangeHost = createPairingExchangeHost({
        transport: service.transport,
        noiseSuite,

        readRelayCredential: () => (typeof opts.token === "string" ? opts.token : ""),

        resolveClientRole: () => "app",
        onPairingCompleted: (completionId) => dispatchPairingCompleted(completionId),
      });
      pairingEndpointService = service;
      return service;
    })().catch((err) => {

      logger.warn(
        `[ocuclaw] pairing endpoint unavailable: ${err && err.message ? err.message : err}`,
      );
      return null;
    });
    return pairingEndpointPromise;
  }

  function pairingJsonResult(status, json, extraHeaders = null) {
    const res = createBufferedHttpResponse(opts.evenAiMaxResponseBytes || 262_144);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");

    res.setHeader("cache-control", "no-store");

    if (extraHeaders) {
      for (const key of Object.keys(extraHeaders)) {
        res.setHeader(key, extraHeaders[key]);
      }
    }
    res.end(status === 204 ? "" : JSON.stringify(json));
    return res.toResult();
  }

  async function handleBufferedPairingHttpRequest(envelope) {
    const service = await ensurePairingEndpoint();
    if (!service) {
      return pairingJsonResult(503, { v: 1, error: "rejected" });
    }
    const headers =
      envelope && envelope.headers && typeof envelope.headers === "object"
        ? envelope.headers
        : {};
    const contentType =
      typeof headers["content-type"] === "string" ? headers["content-type"] : null;
    const body = decodeBufferedHttpBody(envelope);

    const result = await service.handleRequest({
      method: envelope && typeof envelope.method === "string" ? envelope.method : "GET",
      contentType,
      body: body.toString("utf8"),
      bodyBytes:
        envelope && Number.isFinite(envelope.bodyBytes) ? envelope.bodyBytes : body.length,
    });
    return pairingJsonResult(result.status, result.json, result.headers);
  }

  function notePairingAuthenticatedHello(hello) {

    Promise.resolve(ensurePairingEndpoint())
      .then((service) => (service ? service.noteAuthenticatedHello(hello) : false))
      .catch((err) => {
        logger.warn(
          `[ocuclaw] pairing hello correlation failed: ${err && err.message ? err.message : err}`,
        );
      });
  }

  let pairingControlService = null;

  async function handleBufferedPairingControlRequest(envelope) {

    const service = await ensurePairingEndpoint();
    if (!service || !pairingExchangeHost) {
      return pairingJsonResult(503, { v: 1, error: "rejected" });
    }
    if (!pairingControlService) {
      pairingControlService = createPairingControlService({
        exchangeHost: () => pairingExchangeHost,

        readRelayCredential: () => (typeof opts.token === "string" ? opts.token : ""),
      });
    }
    const headers =
      envelope && envelope.headers && typeof envelope.headers === "object"
        ? envelope.headers
        : {};
    const contentType =
      typeof headers["content-type"] === "string" ? headers["content-type"] : null;
    const body = decodeBufferedHttpBody(envelope);
    const result = await pairingControlService.handleRequest({
      method: envelope && typeof envelope.method === "string" ? envelope.method : "GET",
      contentType,
      headers,
      body: body.toString("utf8"),
      bodyBytes:
        envelope && Number.isFinite(envelope.bodyBytes) ? envelope.bodyBytes : body.length,
    });

    return pairingJsonResult(result.status, result.json);
  }

  async function handleBufferedEvenAiHttpRequest(envelope) {
    const url =
      envelope && typeof envelope.url === "string" ? envelope.url : "/";
    const pathname = new URL(url, "http://127.0.0.1").pathname;
    if (isPairingEndpointPath(pathname)) {
      return handleBufferedPairingHttpRequest(envelope);
    }
    if (isPairingControlPath(pathname)) {
      return handleBufferedPairingControlRequest(envelope);
    }
    if (!evenAiEndpoint || typeof evenAiEndpoint.handleRequest !== "function") {
      return {
        statusCode: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from("not found"),
      };
    }
    const req = createBufferedHttpRequest(envelope);
    const res = createBufferedHttpResponse(opts.evenAiMaxResponseBytes || 262_144);
    const requestId =
      envelope && typeof envelope.requestId === "string" ? envelope.requestId : null;
    if (requestId) {
      pendingBufferedEvenAiResponses.set(requestId, { req, res });
    }
    try {
      await Promise.resolve(evenAiEndpoint.handleRequest(req, res));
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("not found");
      }
      return res.toResult();
    } finally {
      if (requestId) {
        pendingBufferedEvenAiResponses.delete(requestId);
      }
    }
  }

  function cancelBufferedEvenAiHttpRequest(envelope) {
    const requestId =
      envelope && typeof envelope.requestId === "string" ? envelope.requestId : null;
    if (!requestId) {
      return false;
    }
    const pending = pendingBufferedEvenAiResponses.get(requestId);
    if (!pending) {
      return false;
    }
    pending.res.emit("close");
    pending.req.emit("close");
    return true;
  }

  let demandResponders = null;

  const demandRouter = createDemandRouter({
    inject: (surface) => {
      sendDemand(buildDemandFrame(surface));
      emitDebug("glasses.lifecycle", "demand_presented", "info", {}, () => ({
        surfaceId: surface.surfaceId,
        kind: surface.payload.kind,
        options: surface.options.length,
        deadlineSec: surface.payload.deadlineSec,
        step: surface.meta.stepIndex,
        steps: surface.meta.stepCount,
      }));
    },

    onFlush: ({ reason, answered, total, sessionKey }) => {
      emitDebug("glasses.lifecycle", "demand_answered", "info", { sessionKey }, () => ({
        reason,
        answered,
        total,
        skipped: total - answered,
      }));
    },

    dismiss: ({ surfaceId, sessionKey, reason }) => {
      sendDemandDismiss({ surfaceId, sessionKey, reason });
      emitDebug("glasses.lifecycle", "demand_retired", "info", {}, () => ({ surfaceId, reason }));
    },
    respondPermission: (provider, sessionId, decision) => {
      if (!demandResponders) return;
      Promise.resolve(demandResponders.respondPermission(provider, sessionId, decision)).catch(
        (e) => logger.warn(`[even-terminal] permission respond failed: ${e && e.message}`),
      );
    },
    respondQuestion: (provider, sessionId, answer) => {
      if (!demandResponders) return;
      Promise.resolve(demandResponders.respondQuestion(provider, sessionId, answer)).catch(
        (e) => logger.warn(`[even-terminal] question respond failed: ${e && e.message}`),
      );
    },
    onError: (info) => {
      logger.warn(`[even-terminal] demand outcome ignored: ${info.reason} (${info.surfaceId})`);
    },
  });

  hermesClarifyRouter = createHermesClarifyRouter({
    inject: (surface) => {
      sendDemand(surface);
      emitDebug("glasses.lifecycle", "demand_presented", "info", {}, () => ({
        producer: "hermes",
        surfaceId: surface.surfaceId,
        kind: surface.kind,
        options: surface.options.length,
        deadlineSec: surface.deadlineSec,
        presentation: surface.presentation,
        selectionMode: surface.selectionMode,
        allowOther: surface.allowOther,
      }), undefined);
    },
    dismiss: ({ surfaceId, sessionKey, reason }) => {
      sendDemandDismiss({ surfaceId, sessionKey, reason });
      emitDebug("glasses.lifecycle", "demand_retired", "info", {}, () => ({
        producer: "hermes",
        surfaceId,
        reason,
      }), undefined);
    },
    respond: (id, response) =>
      gatewayBridge.request("clarify.resolve", { id, response }),
    awaitText: (id) =>
      gatewayBridge.request("clarify.await_text", { id }),
    isCurrentSession: (sessionKey) => sessionService.isCurrentSession(sessionKey),
    onError: (info) => {
      logger.warn(`[hermes] clarify outcome ignored: ${info.reason} (${info.surfaceId || info.id || "unknown"})`);
    },
  });

  openClawQuestionRouter = createOpenClawQuestionRouter({
    inject: (surface) => {
      sendDemand(surface);
      emitDebug("glasses.lifecycle", "demand_presented", "info", {}, () => ({
        producer: "openclaw",
        surfaceId: surface.surfaceId,
        kind: surface.kind,
        options: surface.options.length,
        deadlineSec: surface.deadlineSec,
        questionIndex: surface.questionIndex,
        questionCount: surface.questionCount,
        presentation: surface.presentation,
        selectionMode: surface.selectionMode,
        allowOther: surface.allowOther,
      }), undefined);
    },
    dismiss: ({ surfaceId, sessionKey, reason }) => {
      sendDemandDismiss({ surfaceId, sessionKey, reason });
      emitDebug("glasses.lifecycle", "demand_retired", "info", {}, () => ({
        producer: "openclaw",
        surfaceId,
        reason,
      }), undefined);
    },
    respond: (id, answers) =>
      gatewayBridge.request("question.resolve", {
        id,
        answers,
        resolvedBy: "ocuclaw-glasses",
      }),
    isCurrentSession: (sessionKey) => sessionService.isCurrentSession(sessionKey),
    onError: (info) => {
      logger.warn(`[openclaw] question outcome ignored: ${info.reason} (${info.surfaceId || info.id || "unknown"})`);
    },
  });

  const etStreamInjector = createEtStreamInjector({
    broadcastStreaming: (text) => server.broadcast(handler.formatStreaming(text)),
    addUserMessage: (text) => conversationState.addMessage("user", [{ type: "text", text }], null),
    addAssistantMessage: (text, sender) => conversationState.addMessage("assistant", [{ type: "text", text }], sender),
    broadcastPages,
    broadcastActivity,
    resolveSender: (sessionKey) => (/^et:codex:/.test(sessionKey || "") ? "Codex" : "Claude"),

    renderStreamingBody: (text, sender) => {
      const stripped = stripAllTaggedSpans(typeof text === "string" ? text : "");
      const { text: plain } = conversationState._markdownToPlainText(stripped, {
        stripReplyTags: true,
      });
      return `${sender}: ${plain || ""}`;
    },

    emitContextSnapshot: (sessionKey, contextTokens, runActive) => {
      const et = parseEtSessionKey(sessionKey);
      if (!et) return;
      const contextWindow = et.provider === "codex" ? 400000 : 1000000;
      server.broadcast(
        JSON.stringify({
          type: "ocuclaw.session.context.snapshot",
          sessionKey,
          contextTokens,
          contextWindow,
          compactionCount: 0,
          runActive: runActive === true,
          snapshotAtMs: Date.now(),
        }),
      );
    },
  });

  relayApi = {

    injectEtStreamFrame(ev) {
      if (!ev || !isEtSessionKey(ev.sessionKey)) return;
      if (!sessionService.isCurrentSession(ev.sessionKey)) return;
      try {
        etStreamInjector.handle(ev);
      } catch (e) {
        logger.warn(`[relay] injectEtStreamFrame: ${e.message}`);
      }
    },

    injectDemand(ev) {
      if (!ev || !isEtSessionKey(ev.sessionKey)) return;
      if (!sessionService.isCurrentSession(ev.sessionKey)) return;
      try {
        demandRouter.handleClassified(ev);
      } catch (e) {
        logger.warn(`[relay] injectDemand: ${e.message}`);
      }
    },

    setDemandResponders(responders) {
      demandResponders =
        responders &&
        typeof responders.respondPermission === "function" &&
        typeof responders.respondQuestion === "function"
          ? responders
          : null;
    },
    broadcastStatus,

    emitGlassesUiLifecycle(event, severity, data) {
      if (
        event === "render_sent" &&
        liveuiTaskRunController &&
        data &&
        typeof data.sessionKey === "string"
      ) {
        liveuiTaskRunController.observeRenderAttempt({
          sessionKey: data.sessionKey,
          surfaceId: data.surfaceId,
        });
      } else if (
        (event === "render_rejected" || event === "render_receipt_rejected") &&
        liveuiTaskRunController &&
        data &&
        typeof data.sessionKey === "string"
      ) {
        liveuiTaskRunController.observeRenderFailure(data.sessionKey);
      }
      emitDebug("glasses.lifecycle", event, severity, {}, () => data || {});
    },

    start() {

      if (!bundleCacheSweepTimer) {
        bundleCacheSweepTimer = setInterval(() => bundleCache.sweep(), 60_000);
        if (typeof bundleCacheSweepTimer.unref === "function") bundleCacheSweepTimer.unref();
      }

      if (!stablePromptSweepTimer) {
        stablePromptSweepTimer = setInterval(
          () => stablePromptSnapshots.sweep(),
          60 * 60 * 1000,
        );
        if (typeof stablePromptSweepTimer.unref === "function") {
          stablePromptSweepTimer.unref();
        }
      }

      if (!uploadCaptureArmingDisposer) {
        uploadCaptureArmingDisposer = startUploadCaptureArming({
          gatesOn: () => externalDebugToolsEnabled,
          armCategories: (cats, ttlMs) =>
            applyDebugSet("upload-capture-arming", { enable: cats, ttlMs }),
          maxTtlMs: debugStore.getConfig().maxTtlMs,

          preset: opts.debugUploadCapturePreset,
          onArmError: (err) =>
            logger.warn(
              `[relay] upload-capture arming failed (preset override?): ${err && err.message}`,
            ),
          setInterval,
          clearInterval,
        });
      }
      const startGateway = () => Promise.resolve(gatewayBridge.start()).then(() => {
        prefetchSonioxModels("relay_start").catch((err) => {
          logger.warn(`[relay] Soniox models prefetch failed: ${err.message}`);
        });
        if (upstreamRuntime && typeof upstreamRuntime.start === "function") {
          return upstreamRuntime.start();
        }
      });
      if (server && typeof server.start === "function") {
        return Promise.resolve(server.start()).then(startGateway);
      }
      return startGateway();
    },

    stop() {
      if (liveuiTaskRunController) {
        liveuiTaskRunController.observeHostLoss();
      }
      stopLiveuiExecutorRegistry();
      clearSyntheticWork();
      sessionService.discardDraftSession("runtime_stop");
      demandRouter.forgetAll("runtime_stop");
      if (bundleCacheSweepTimer) {
        clearInterval(bundleCacheSweepTimer);
        bundleCacheSweepTimer = null;
      }
      if (stablePromptSweepTimer) {
        clearInterval(stablePromptSweepTimer);
        stablePromptSweepTimer = null;
      }
      if (uploadCaptureArmingDisposer) {
        uploadCaptureArmingDisposer();
        uploadCaptureArmingDisposer = null;
      }
      if (evenAiEndpoint) {
        evenAiEndpoint.close();
      }
      if (evenAiRunWaiter) {
        evenAiRunWaiter.close();
      }
      if (upstreamRuntime) {
        upstreamRuntime.stop();
      }
      relayHealth.stop();
      gatewayBridge.stop();
      return Promise.all([
        sessionService.flushFirstSentUserMessageCache(),
        Promise.resolve(server.close()),
      ]).then(() => undefined);
    },

    handleEvenAiHttpRequest(req, res) {
      if (!evenAiEndpoint || typeof evenAiEndpoint.handleRequest !== "function") {
        return Promise.resolve(false);
      }
      return Promise.resolve(evenAiEndpoint.handleRequest(req, res));
    },

    handleBufferedEvenAiHttpRequest,

    get pairingEndpoint() {
      return pairingEndpointService;
    },

    get pairingExchangeHost() {
      return pairingExchangeHost;
    },

    get server() {
      return server;
    },

    get workerReadyForTest() {
      return server && server.readyPromise ? server.readyPromise : Promise.resolve();
    },

    get debugStoreForTest() {
      return debugStore;
    },

    __stablePromptWouldChurnForTest(sessionKey, perTurnSignals = {}) {
      const startEmoji = perTurnSignals.neuralEmojiReactorState === "active";
      const startPace = perTurnSignals.neuralPaceModulatorState === "active";
      return stablePromptSnapshots.wouldChurn(
        sessionKey,
        sessionKey,
        computeStableChannelOne({ emoji: startEmoji, pace: startPace }),
      );
    },

    get liveUiTraceLogEnabledForTest() {
      return liveUiTraceLogEnabled;
    },
    __onTraceLogSetForTest(clientId, request) {
      return applyTraceLogSet(clientId, request);
    },
    __onDebugSetForTest(clientId, request) {
      return applyDebugSet(clientId, request);
    },

    get operationRegistryForTest() {
      return relayOperationRegistry;
    },

    get upstreamRuntimeForTest() {
      return upstreamRuntime;
    },

    get activityStatusAdapterForTest() {
      return activityStatusAdapter;
    },

    get liveuiTaskRunControllerForTest() {
      return liveuiTaskRunController;
    },

    _clearSyntheticWorkForTest(sessionKey = JSON.parse("null")) {
      if (typeof sessionKey === "string") {
        clearSyntheticWorkForSession(sessionKey);
      } else {
        clearSyntheticWork();
      }
    },

    relayHealth,

    get httpServer() {
      return sharedHttpServer;
    },

    getEvenAiSettingsSnapshot() {
      return evenAiSettingsStore.getSnapshot();
    },

    getSessionTitle(sessionKey) {
      return sessionService.getSessionTitle(sessionKey);
    },

    hasRecordedUserMessage(sessionKey) {
      return sessionService.hasRecordedFirstUserMessage(sessionKey);
    },

    isNeuralSessionNamesEnabled(sessionKey) {
      return sessionService.isNeuralSessionNamesEnabled(sessionKey);
    },

    isSessionUserLocked(sessionKey) {
      return sessionService.isSessionUserLocked(sessionKey);
    },

    getDisplayStartStates(sessionKey) {
      return sessionService.getDisplayStartStates(sessionKey);
    },

    getDisplayCurrentStates(sessionKey) {
      return sessionService.getDisplayCurrentStates(sessionKey);
    },

    getSessionTitleRecord(sessionKey) {
      return sessionService.getSessionTitleRecord(sessionKey);
    },
    isEvenAiSessionKey(sessionKey) {
      return sessionService.isEvenAiSessionKey(sessionKey);
    },
    getRawMessages() {
      return conversationState.getRawMessages();
    },
    getDistillerBudget() {
      return sessionService.getDistillerBudget();
    },

    deleteDistillerSession(sessionKey) {
      return sessionService.deleteSessions("ocuclaw", [sessionKey]);
    },
    getStateDir() {
      return opts.stateDir;
    },
    emitDebug(...args) {
      return emitDebug(...args);
    },
    gatewayRequest(method, params, requestOpts) {
      return gatewayBridge.request(method, params, requestOpts);
    },
    onGatewayEvent(eventName, listener) {
      return gatewayBridge.on(eventName, listener);
    },

    peekSessionKey() {
      return sessionService.peekSessionKey();
    },

    flushFirstSentUserMessageCache() {
      return sessionService.flushFirstSentUserMessageCache();
    },

    recordNeuralSessionNamesEnabled(sessionKey, enabled) {
      sessionService.recordNeuralSessionNamesEnabled(sessionKey, enabled);
    },

    setSessionTitle(sessionKey, title, opts) {
      const result = sessionService.setSessionTitle(sessionKey, title, opts);
      if (result && result.ok) {
        broadcastSessions();
      }
      return result;
    },

    _dispatchOcuClawUserSend(params) {
      return dispatchOcuClawUserSend(params || {});
    },

    _handleDownstreamMessageForTest(clientId, raw) {
      return handler.handleMessage(clientId, raw);
    },

    _clearLogicalSessionState(sessionKey) {
      clearLogicalSessionState(sessionKey, "test_hook");
    },

    sendGlassesUiRender(params) {
      sendGlassesUiRender(params);
    },

    setLiveuiGlassesLibraryController(controller) {
      liveuiGlassesLibraryController = controller || null;
    },

    resolveLiveuiTaskExecutorState,
    stopLiveuiExecutorRegistry,

    sendDemand(params) {
      sendDemand(params);
    },

    presentHermesSlashConfirm(params) {
      return hermesSlashConfirmRouter.present(params || {});
    },

    sendGlassesUiSurfaceUpdate(params) {
      sendGlassesUiSurfaceUpdate(params);
    },

    broadcastPushMessage(params) {
      return broadcastPushMessage(params);
    },

    dispatchGlassesWake(params) {
      const sessionKey =
        params && typeof params.sessionKey === "string" && params.sessionKey
          ? params.sessionKey
          : sessionService.ensureSessionKey();
      const message = params && typeof params.message === "string" ? params.message : "";
      if (!message) {
        return Promise.reject(new Error("dispatchGlassesWake requires a message"));
      }
      const idempotencyKey =
        params && typeof params.idempotencyKey === "string" && params.idempotencyKey
          ? params.idempotencyKey
          : null;
      agentTurnTracker.markBusy(sessionKey);
      emitDebug(
        "relay.protocol",
        "glasses_wake_dispatch",
        "info",
        { sessionKey },
        () => ({
          idempotencyKey,
          messageChars: message.length,
        }),
      );
      const gatewaySession = openclawGatewayKeyFor(sessionKey);
      const requestParams = {
        message,
        sessionKey: gatewaySession.key,
        ...(gatewaySession.agentId ? { agentId: gatewaySession.agentId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      return gatewayBridge.request("agent", requestParams, { expectFinal: false });
    },

    isAgentTurnBusy(sessionKey) {
      return agentTurnTracker.isBusy(sessionKey);
    },

    currentAgentRunId(sessionKey) {
      return agentTurnTracker.runIdFor(sessionKey);
    },

    onGlassesUiResult(handler) {
      return onGlassesUiResult(handler);
    },

    onGlassesUiNavEvent(handler) {
      return onGlassesUiNavEvent(handler);
    },

    onGlassesUiRenderReceipt(handler) {
      return onGlassesUiRenderReceipt(handler);
    },

    onGlassesUiClientFailure(handler) {
      return onGlassesUiClientFailure(handler);
    },

    sendDeviceInfoRequest(params) {
      sendDeviceInfoRequest(params);
    },

    onDeviceInfoResponse(handler) {
      return onDeviceInfoResponse(handler);
    },
    onGlassesPresenceChanged(handler) {
      return onGlassesPresenceChanged(handler);
    },

    sendLocationRequest(params) {
      sendLocationRequest(params);
    },

    onLocationResponse(handler) {
      return onLocationResponse(handler);
    },

    isLocationAccessEnabled() {
      return hasLocationAccessEnabledReadinessClient();
    },

    hasConnectedAppClient() {
      return server ? server.getConnectedAppCount() > 0 : false;
    },

    getConnectedAppClientVersion() {

      try {
        const snap =
          server && typeof server.getReadinessSnapshot === "function"
            ? server.getReadinessSnapshot()
            : null;
        const clients = snap && Array.isArray(snap.clients) ? snap.clients : [];
        let best = null;
        for (const entry of clients) {
          const version =
            entry && typeof entry.clientVersion === "string" ? entry.clientVersion.trim() : "";
          if (!version.length) continue;
          const at = Number.isFinite(entry.connectedAtMs) ? entry.connectedAtMs : 0;
          if (!best || at >= best.at) best = { at, version };
        }
        return best ? best.version : null;
      } catch {
        return null;
      }
    },

    isGlassesSendBufferOverHighWater() {
      return glassesBackpressureLatch.isOverHighWater();
    },

    hasConnectedAppClientCapability(capability) {

      if (typeof capability !== "string" || !capability) return false;
      try {
        const snap =
          server && typeof server.getReadinessSnapshot === "function"
            ? server.getReadinessSnapshot()
            : null;
        const clients = snap && Array.isArray(snap.clients) ? snap.clients : [];
        return clients.some(
          (entry) =>
            Array.isArray(entry && entry.clientCapabilities) &&
            entry.clientCapabilities.includes(capability),
        );
      } catch {
        return false;
      }
    },

    onAppClientDisconnect(handler) {
      return onAppClientDisconnect(handler);
    },

    onAppPresenceChanged(handler) {
      return onAppPresenceChanged(handler);
    },

    onPairingCompleted(handler) {
      return onPairingCompleted(handler);
    },

    getAppPresenceProjection() {

      if (!server || typeof server.getAppPresenceProjection !== "function") return null;
      try {
        return server.getAppPresenceProjection();
      } catch {
        return null;
      }
    },

    onLogicalSessionReset(handler) {
      return onLogicalSessionReset(handler);
    },
  };
  return relayApi;
}

const createRelayCore = createRelay;

module.exports = { LIVEUI_TASK_DISCOVERY_CHANNEL_ONE, createRelayCore, createRelay, sanitizeGlassesMarker, resolveEvenAiRouterOptionsForBackend, parseHermesFeatureTokens };
