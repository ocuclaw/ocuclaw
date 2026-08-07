const fs = require("node:fs");
const path = require("node:path");
const { stripAllTaggedSpans } = require("../domain/tagged-span-strip.cjs");
const { isEvenAiSessionKey: matchesEvenAiSessionKeyGrammar } = require("../domain/even-ai-session-keys.cjs");
const { activeBackendDisplayName, getActiveBackendKind, } = require("../gateway/backend-contract.cjs");
const { createDisplayToggleTracker } = require("./display-toggle-states.cjs");
const { decideTitleWrite, isUserOrigin } = require("./session-title-record.cjs");
const { createDistillerBudget } = require("./session-title-distiller-budget.cjs");
const { isEtSessionKey } = require("./even-terminal/session-key.cjs");
const { isForeignHermesSessionKey } = require("./hermes-session-keys.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");

const SESSION_FIRST_USER_CACHE_FILE = "session-first-user-cache.json";
const SESSION_TITLE_CACHE_FILE = "session-title-cache.json";
const SESSION_PIN_CACHE_FILE = "ocuclaw-session-pins.json";
const SESSION_AGENT_CACHE_FILE = "ocuclaw-session-agents.json";
const PIN_CAP_PER_KIND = 20;

const NEW_SESSION_GREETING_PROMPT =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. If BOOTSTRAP.md exists in the provided Project Context, read it and follow its instructions first. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

const HERMES_NEW_SESSION_GREETING_PROMPT =
  "A new session was started via /new or /reset. Greet the user in your configured persona, if one is provided. Keep it to 1-3 sentences and ask what they want to do. Do not mention internal steps, files, tools, or reasoning.";

function activeNewSessionGreetingPrompt() {
  return getActiveBackendKind() === "hermes"
    ? HERMES_NEW_SESSION_GREETING_PROMPT
    : NEW_SESSION_GREETING_PROMPT;
}

function createUnsupportedSessionKeyError(sessionKey, currentSessionKey = null) {
  const err = new Error("unsupported session key");
  err.name = "UnsupportedSessionKeyError";
  err.code = "unsupported_session_key";
  err.reason = "unsupported_session_key";
  err.sessionKey = sessionKey;
  err.currentSessionKey = currentSessionKey;
  return err;
}

function normalizeStateDir(stateDir) {
  if (typeof stateDir !== "string") return null;
  const trimmed = stateDir.trim();
  return trimmed ? trimmed : null;
}

function resolveSessionFirstUserMessageCachePath(stateDir) {
  const resolvedStateDir = normalizeStateDir(stateDir);
  if (!resolvedStateDir) return null;
  return path.join(resolvedStateDir, SESSION_FIRST_USER_CACHE_FILE);
}

function resolveSessionTitleCachePath(stateDir) {
  const resolvedStateDir = normalizeStateDir(stateDir);
  if (!resolvedStateDir) return null;
  return path.join(resolvedStateDir, SESSION_TITLE_CACHE_FILE);
}

function resolveSessionPinCachePath(stateDir) {
  const resolvedStateDir = normalizeStateDir(stateDir);
  if (!resolvedStateDir) return null;
  return path.join(resolvedStateDir, SESSION_PIN_CACHE_FILE);
}

function resolveSessionAgentCachePath(stateDir) {
  const resolvedStateDir = normalizeStateDir(stateDir);
  if (!resolvedStateDir) return null;
  return path.join(resolvedStateDir, SESSION_AGENT_CACHE_FILE);
}

function deriveAgentIdFromFullKey(fullKey) {
  if (typeof fullKey !== "string") return "";
  const match = /^agent:([a-z0-9][a-z0-9_-]*):/i.exec(fullKey.trim());
  return match ? match[1] : "";
}

function sanitizeAssistantContentBlocks(content) {
  if (typeof content === "string") {
    return stripAllTaggedSpans(content);
  }
  if (!Array.isArray(content)) return content;
  return content.map((block) =>
    block && block.type === "text" && typeof block.text === "string"
      ? { ...block, text: stripAllTaggedSpans(block.text) }
      : block,
  );
}

function createSessionService(opts = {}) {
  const logger = normalizeLogger(opts.logger);
  const gatewayBridge = opts.gatewayBridge;
  const conversationState = opts.conversationState;
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const getAgentName =
    typeof opts.getAgentName === "function" ? opts.getAgentName : () => null;
  const getAgentDisplayName =
    typeof opts.getAgentDisplayName === "function"
      ? opts.getAgentDisplayName
      : () => null;
  const getDefaultAgentId =
    typeof opts.getDefaultAgentId === "function"
      ? opts.getDefaultAgentId
      : () => "";
  const isUpstreamConnected =
    typeof opts.isUpstreamConnected === "function"
      ? opts.isUpstreamConnected
      : typeof opts.getOpenclawConnected === "function"
        ? opts.getOpenclawConnected
      : () => false;
  const onSessionStateReset =
    typeof opts.onSessionStateReset === "function"
      ? opts.onSessionStateReset
      : null;
  const onPagesChanged =
    typeof opts.onPagesChanged === "function" ? opts.onPagesChanged : null;
  const onStatusChanged =
    typeof opts.onStatusChanged === "function" ? opts.onStatusChanged : null;
  const onSessionModelConfig =
    typeof opts.onSessionModelConfig === "function"
      ? opts.onSessionModelConfig
      : null;
  const isPinnedFirstUserMessageKey =
    typeof opts.isPinnedFirstUserMessageKey === "function"
      ? opts.isPinnedFirstUserMessageKey
      : null;
  const etHistoryProvider =
    typeof opts.etHistoryProvider === "function" ? opts.etHistoryProvider : null;
  const etTranscriptSearchProvider =
    typeof opts.etTranscriptSearchProvider === "function"
      ? opts.etTranscriptSearchProvider
      : null;

  let currentSessionKey = null;

  let pendingSessionListKey = null;
  let lastGeneratedSessionTimestamp = 0;
  const DEFAULT_SESSION_KEY_PREFIX =
    typeof opts.defaultSessionKeyPrefix === "string" &&
    opts.defaultSessionKeyPrefix.trim()
      ? opts.defaultSessionKeyPrefix.trim()
      : "ocuclaw:";
  const SUPPORTED_SESSION_KEY_PREFIXES =
    Array.isArray(opts.supportedSessionKeyPrefixes) &&
    opts.supportedSessionKeyPrefixes.length > 0
      ? opts.supportedSessionKeyPrefixes
      : [DEFAULT_SESSION_KEY_PREFIX];
  const SUPPORTED_SESSION_KEY_PREFIXES_LOWER = SUPPORTED_SESSION_KEY_PREFIXES.map(
    (prefix) => String(prefix || "").toLowerCase(),
  );
  const configuredSessionKeyPrefixForAgentRef = Reflect.get(
    opts,
    "sessionKeyPrefixForAgentRef",
  );
  const sessionKeyPrefixForAgentRef =
    typeof configuredSessionKeyPrefixForAgentRef === "function"
      ? configuredSessionKeyPrefixForAgentRef
      : null;
  const configuredGetDefaultSessionAgentRef = Reflect.get(
    opts,
    "getDefaultSessionAgentRef",
  );
  const getDefaultSessionAgentRef =
    typeof configuredGetDefaultSessionAgentRef === "function"
      ? configuredGetDefaultSessionAgentRef
      : () => "";

  const etSessionProvider =
    typeof opts.etSessionProvider === "function" ? opts.etSessionProvider : () => [];

  const sessionLimit = opts.sessionLimit || 100;

  const persistFirstUserMessages = opts.persistFirstUserMessages !== false;

  const strictFirstUserMessage = opts.strictFirstUserMessage !== false;

  const firstUserMessageCachePath = resolveSessionFirstUserMessageCachePath(
    opts.stateDir,
  );

  const sessionCacheTtlMs =
    Number.isFinite(opts.sessionCacheTtlMs) && opts.sessionCacheTtlMs > 0
      ? Math.floor(opts.sessionCacheTtlMs)
      : 5000;

  let cachedSessions = null;

  let cachedSessionsFetchedAt = 0;

  let inFlightSessionsFetch = null;

  const sessionModelConfigCache = new Map();

  const pendingInitialConfigSessionKeys = new Set();

  const firstUserMessageCache = new Map();
  const firstUserMessageCacheLimit = Math.max(64, sessionLimit * 8);

  const firstSentUserMessageBySession = loadFirstSentUserMessageCache();

  const sessionTitleCachePath = resolveSessionTitleCachePath(opts.stateDir);

  const sessionTitleByKey = loadSessionTitleCache();

  const neuralSessionNamesEnabledByKey = new Map();

  const displayToggleTracker = createDisplayToggleTracker({ stateDir: opts.stateDir });

  const distillerBudget = createDistillerBudget({});

  const sessionPinCachePath = resolveSessionPinCachePath(opts.stateDir);

  const sessionPinByKey = loadSessionPinCache();

  const sessionAgentCachePath = resolveSessionAgentCachePath(opts.stateDir);

  const sessionAgentByKey = loadSessionAgentCache();

  function generateSessionKey(rawPrefix = DEFAULT_SESSION_KEY_PREFIX) {
    const effectivePrefix =
      typeof rawPrefix === "string" && rawPrefix.trim()
        ? rawPrefix.trim()
        : DEFAULT_SESSION_KEY_PREFIX;
    const nowMs = Date.now();
    const nextTimestamp =
      nowMs > lastGeneratedSessionTimestamp
        ? nowMs
        : lastGeneratedSessionTimestamp + 1;
    lastGeneratedSessionTimestamp = nextTimestamp;
    return `${effectivePrefix}${nextTimestamp}`;
  }

  function normalizeAgentRef(value = "") {
    return typeof value === "string" ? value.trim() : "";
  }

  function resolveMintAgentRef(
    explicitAgentRef = "",
    inheritAppBinding = false,
  ) {
    const normalizedAgentRef = normalizeAgentRef(explicitAgentRef);
    return normalizedAgentRef || (
      inheritAppBinding ? normalizeAgentRef(getDefaultSessionAgentRef()) : ""
    );
  }

  function mintSessionKey({
    agentRef = "",
    inheritAppBinding = false,
    fallbackPrefix = "",
  } = {}) {
    const resolvedAgentRef = resolveMintAgentRef(
      agentRef,
      inheritAppBinding,
    );
    let prefix = fallbackPrefix;
    if (sessionKeyPrefixForAgentRef) {
      const hookedPrefix = sessionKeyPrefixForAgentRef(
        resolvedAgentRef || undefined,
      );
      prefix =
        typeof hookedPrefix === "string" && hookedPrefix.trim()
          ? hookedPrefix.trim()
          : DEFAULT_SESSION_KEY_PREFIX;
      if (
        fallbackPrefix &&
        fallbackPrefix.startsWith(DEFAULT_SESSION_KEY_PREFIX)
      ) {
        prefix += fallbackPrefix.slice(DEFAULT_SESSION_KEY_PREFIX.length);
      }
    }
    const sessionKey = generateSessionKey(prefix);

    if (
      resolvedAgentRef &&
      (!sessionKeyPrefixForAgentRef || fallbackPrefix)
    ) {
      setSessionAgentId(sessionKey, resolvedAgentRef);
    }
    return { sessionKey, agentRef: resolvedAgentRef };
  }

  function ensureSessionKey() {
    if (!currentSessionKey) {
      currentSessionKey = mintSessionKey({
        inheritAppBinding: true,
      }).sessionKey;
    }
    return currentSessionKey;
  }

  function peekSessionKey() {
    return currentSessionKey;
  }

  function createDetachedSessionKey(prefix, opts = { agentRef: "" }) {
    const { sessionKey, agentRef } = mintSessionKey({
      agentRef: opts.agentRef,
      inheritAppBinding: false,
      fallbackPrefix: prefix,
    });
    invalidateSessionsCache();
    pendingSessionListKey = sessionKey;
    emitDebug(
      "relay.session",
      "detached_session_prepared",
      "info",
      { sessionKey },
      () => ({
        sessionKey,
        agentRef: agentRef || null,
      }),
    );
    return sessionKey;
  }

  function normalizeThinkingLevel(raw) {
    if (typeof raw !== "string") return "";
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === "off" ||
      normalized === "minimal" ||
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high" ||
      normalized === "xhigh" ||
      normalized === "max" ||
      normalized === "ultra"
    ) {
      return normalized;
    }
    return "";
  }

  function normalizeReasoningLevel(raw) {
    if (typeof raw !== "string") return "off";
    const normalized = raw.trim().toLowerCase();
    if (normalized === "on.full" || normalized === "full") return "on.full";
    if (normalized === "stream") return "on";
    if (normalized === "on") return "on";
    return "off";
  }

  function normalizeVerboseLevel(raw) {
    if (typeof raw !== "string") return "off";
    const normalized = raw.trim().toLowerCase();
    if (normalized === "off" || normalized === "on" || normalized === "full") {
      return normalized;
    }
    return "off";
  }

  function normalizeElevatedLevel(raw) {
    if (typeof raw !== "string") return "off";
    const normalized = raw.trim().toLowerCase();
    if (normalized === "on" || normalized === "ask" || normalized === "full") {
      return normalized;
    }
    return "off";
  }

  function normalizeSessionModelRef(modelProviderRaw, modelRaw) {
    let modelProvider =
      typeof modelProviderRaw === "string" && modelProviderRaw.trim()
        ? modelProviderRaw.trim()
        : null;
    let model =
      typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : null;
    if (model && model.includes("/")) {
      const slashIdx = model.indexOf("/");
      const splitProvider = model.slice(0, slashIdx).trim();
      const splitModel = model.slice(slashIdx + 1).trim();
      if (!modelProvider && splitProvider) modelProvider = splitProvider;
      model = splitModel || model;
    }
    return {
      modelProvider,
      model,
    };
  }

  function buildSessionModelConfig(sessionKey, row) {
    const normalized = normalizeSessionModelRef(
      row && row.modelProvider,
      row && row.model,
    );
    return {
      sessionKey,
      modelProvider: normalized.modelProvider,
      model: normalized.model,
      thinkingLevel: normalizeThinkingLevel(row && row.thinkingLevel),
      reasoningLevel: normalizeReasoningLevel(row && row.reasoningLevel),
      verboseLevel: normalizeVerboseLevel(row && row.verboseLevel),
      fastMode: !!(row && row.fastMode === true),
      elevatedLevel: normalizeElevatedLevel(row && row.elevatedLevel),

      agentId: sessionAgentOverrideId(sessionKey),
    };
  }

  function listSessionsBySearch(search) {
    return gatewayBridge.request("sessions.list", {
      search,
      includeGlobal: false,
      includeUnknown: false,
      limit: sessionLimit,
    });
  }

  async function resolveSessionCanonicalKey(sessionKey) {
    if (!isUpstreamConnected()) return sessionKey;
    if (hasSupportedSessionKeyPrefix(sessionKey)) {
      return sessionKey;
    }
    try {
      const resolved = await gatewayBridge.request("sessions.resolve", {
        key: sessionKey,
        includeGlobal: false,
        includeUnknown: false,
      });
      if (resolved && typeof resolved.key === "string" && resolved.key.trim()) {
        return resolved.key.trim();
      }
    } catch {

    }
    return sessionKey;
  }

  function normalizeExactSessionKey(rawKey) {
    if (typeof rawKey !== "string") return "";
    const trimmed = rawKey.trim();
    if (!trimmed) return "";
    const shortKey = extractShortKey(trimmed);
    return hasSupportedSessionKeyPrefix(shortKey) ? shortKey : "";
  }

  function findBestSessionRow(rows, targetKey, canonicalKey) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const targetShort = extractShortKey(targetKey || "");
    const canonicalShort = extractShortKey(canonicalKey || "");

    const fullCanonicalMatch = rows.find((row) => {
      return row && typeof row.key === "string" && canonicalKey && row.key === canonicalKey;
    });
    if (fullCanonicalMatch) return fullCanonicalMatch;

    const shortCanonicalMatch = rows.find((row) => {
      if (!row || typeof row.key !== "string") return false;
      return canonicalShort && extractShortKey(row.key) === canonicalShort;
    });
    if (shortCanonicalMatch) return shortCanonicalMatch;

    return (
      rows.find((row) => {
        if (!row || typeof row.key !== "string") return false;
        return targetShort && extractShortKey(row.key) === targetShort;
      }) || null
    );
  }

  async function fetchCurrentSessionRow(sessionKey) {
    const canonicalKey = await resolveSessionCanonicalKey(sessionKey);
    const firstResult = await listSessionsBySearch(sessionKey);
    const firstRows =
      firstResult && Array.isArray(firstResult.sessions)
        ? firstResult.sessions
        : [];
    const firstMatch = findBestSessionRow(firstRows, sessionKey, canonicalKey);
    if (firstMatch) {
      return { row: firstMatch, canonicalKey };
    }

    const secondResult = await listSessionsBySearch(canonicalKey);
    const secondRows =
      secondResult && Array.isArray(secondResult.sessions)
        ? secondResult.sessions
        : [];
    const secondMatch = findBestSessionRow(secondRows, sessionKey, canonicalKey);
    return { row: secondMatch, canonicalKey };
  }

  function cachedSessionModelConfig(sessionKey) {
    return sessionModelConfigCache.get(sessionKey) || buildSessionModelConfig(sessionKey, null);
  }

  function primeSessionModelConfig(sessionKey, patch) {
    const base = cachedSessionModelConfig(sessionKey);
    const normalizedModel =
      Object.prototype.hasOwnProperty.call(patch || {}, "modelRef") &&
      patch.oneTurn !== true
      ? normalizeSessionModelRef(null, patch && patch.modelRef)
      : {
          modelProvider: base.modelProvider,
          model: base.model,
        };
    const config = {
      sessionKey,
      modelProvider: normalizedModel.modelProvider,
      model: normalizedModel.model,
      thinkingLevel:
        patch && Object.prototype.hasOwnProperty.call(patch, "thinkingLevel")
          ? normalizeThinkingLevel(patch.thinkingLevel)
          : base.thinkingLevel,
      reasoningLevel:
        patch && Object.prototype.hasOwnProperty.call(patch, "reasoningLevel")
          ? normalizeReasoningLevel(patch.reasoningLevel)
          : patch && Object.prototype.hasOwnProperty.call(patch, "reasoningEnabled")
            ? normalizeReasoningLevel(patch.reasoningEnabled ? "on" : "off")
          : base.reasoningLevel,
      verboseLevel:
        patch && Object.prototype.hasOwnProperty.call(patch, "verboseLevel")
          ? normalizeVerboseLevel(patch.verboseLevel)
          : base.verboseLevel,
      fastMode:
        patch && Object.prototype.hasOwnProperty.call(patch, "fastMode")
          ? patch.fastMode === true
          : base.fastMode,
      elevatedLevel:
        patch && Object.prototype.hasOwnProperty.call(patch, "elevatedLevel")
          ? normalizeElevatedLevel(patch.elevatedLevel)
          : base.elevatedLevel,

      agentId: sessionAgentOverrideId(sessionKey),
    };
    sessionModelConfigCache.set(sessionKey, config);
    return config;
  }

  function notifySessionModelConfigIfCurrent(sessionKey, config) {
    if (
      onSessionModelConfig &&
      normalizeSessionKeyForCompare(sessionKey) ===
        normalizeSessionKeyForCompare(ensureSessionKey())
    ) {
      onSessionModelConfig(config);
    }
  }

  function isHostSessionModelPatch(patch) {
    if (!patch || typeof patch !== "object") return false;
    return (
      Object.prototype.hasOwnProperty.call(patch, "modelRef") ||
      Object.prototype.hasOwnProperty.call(patch, "thinkingLevel") ||
      Object.prototype.hasOwnProperty.call(patch, "reasoningLevel") ||
      Object.prototype.hasOwnProperty.call(patch, "reasoningEnabled") ||
      Object.prototype.hasOwnProperty.call(patch, "verboseLevel") ||
      Object.prototype.hasOwnProperty.call(patch, "fastMode") ||
      Object.prototype.hasOwnProperty.call(patch, "elevatedLevel")
    );
  }

  async function getSessionModelConfig(sessionKey = ensureSessionKey()) {
    if (!isUpstreamConnected()) {
      return cachedSessionModelConfig(sessionKey);
    }
    try {
      const resolved = await fetchCurrentSessionRow(sessionKey);
      const row = resolved && resolved.row ? resolved.row : null;
      if (!row) {
        return cachedSessionModelConfig(sessionKey);
      }
      const config = buildSessionModelConfig(sessionKey, row);
      sessionModelConfigCache.set(sessionKey, config);
      notifySessionModelConfigIfCurrent(sessionKey, config);
      return config;
    } catch (err) {
      emitDebug(
        "relay.session",
        "session_model_config_fetch_failed",
        "warn",
        { sessionKey },
        () => ({
          message: err && err.message ? err.message : String(err),
        }),
      );
      return cachedSessionModelConfig(sessionKey);
    }
  }

  async function getCurrentSessionModelConfig() {
    return getSessionModelConfig(ensureSessionKey());
  }

  async function setSessionModelConfig(sessionKey = ensureSessionKey(), patch) {
    const hasHostPatch = isHostSessionModelPatch(patch);

    if (!hasHostPatch) {
      return {
        status: "rejected",
        error: "setSessionModelConfig requires at least one field",
      };
    }

    if (!isUpstreamConnected()) {
      return {
        status: "rejected",
        error: `${activeBackendDisplayName()} disconnected`,
      };
    }

    let canonicalKey = await resolveSessionCanonicalKey(sessionKey);
    if (hasSupportedSessionKeyPrefix(sessionKey)) {
      const resolved = await fetchCurrentSessionRow(sessionKey);
      const row = resolved && resolved.row ? resolved.row : null;
      if (row && typeof row.key === "string" && row.key.trim()) {
        canonicalKey = row.key.trim();
      }
    }
    const request = { key: canonicalKey };
    if (patch && typeof patch.modelRef === "string") {
      const requestedModel = patch.modelRef.trim() ? patch.modelRef : null;
      Object.assign(request, { model: requestedModel });
      if (requestedModel && patch.oneTurn === true) {

        if (getActiveBackendKind() !== "hermes") {
          return {
            status: "rejected",
            error: "one-turn model scope requires the hermes backend",
          };
        }
        Object.assign(request, { oneTurn: true });
      }
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "thinkingLevel")) {
      request.thinkingLevel =
        typeof patch.thinkingLevel === "string" && patch.thinkingLevel.trim()
          ? normalizeThinkingLevel(patch.thinkingLevel)
          : null;
    }
    if (patch && typeof patch.reasoningLevel === "string") {
      Object.assign(request, {
        reasoningLevel: normalizeReasoningLevel(patch.reasoningLevel),
      });
    } else if (patch && patch.reasoningEnabled !== undefined) {
      Object.assign(request, {
        reasoningLevel: patch.reasoningEnabled ? "on" : "off",
      });
    }
    if (patch && typeof patch.verboseLevel === "string") {
      request.verboseLevel = patch.verboseLevel;
    }
    if (patch && typeof patch.fastMode === "boolean") {
      request.fastMode = patch.fastMode;
    }
    if (patch && typeof patch.elevatedLevel === "string") {
      request.elevatedLevel = patch.elevatedLevel;
    }

    try {
      const result = await gatewayBridge.request("sessions.patch", request);

      let primePatch = patch;
      const applied =
        result &&
        typeof result === "object" &&
        result.applied &&
        typeof result.applied === "object"
          ? result.applied
          : null;
      if (applied && typeof applied.model === "string" && applied.model.trim()) {
        const appliedProvider =
          typeof applied.provider === "string" && applied.provider.trim()
            ? applied.provider.trim()
            : "";
        primePatch = {
          ...patch,
          modelRef: appliedProvider
            ? `${appliedProvider}/${applied.model.trim()}`
            : applied.model.trim(),
        };
      }
      const config = primeSessionModelConfig(sessionKey, primePatch);
      notifySessionModelConfigIfCurrent(sessionKey, config);
      pendingInitialConfigSessionKeys.delete(sessionKey);
      return { status: "accepted", config };
    } catch (err) {
      emitDebug(
        "relay.session",
        "session_model_config_set_failed",
        "warn",
        { sessionKey },
        () => ({
          message: err && err.message ? err.message : String(err),
        }),
      );
      return {
        status: "rejected",
        error: err && err.message ? err.message : "sessions.patch failed",
      };
    }
  }

  async function setCurrentSessionModelConfig(patch) {
    return setSessionModelConfig(ensureSessionKey(), patch);
  }

  function mergeEtSessionRows(baseRows) {
    const rows = Array.isArray(baseRows) ? baseRows.slice() : [];
    let etRows = [];
    try {
      etRows = etSessionProvider() || [];
    } catch (err) {
      etRows = [];
    }
    const seen = new Set(rows.map((s) => s && s.key));
    for (const row of etRows) {
      if (!row || typeof row.key !== "string" || seen.has(row.key)) continue;
      seen.add(row.key);
      rows.push(row);
    }
    return rows;
  }

  async function getSessions() {
    if (cachedSessions && Date.now() - cachedSessionsFetchedAt < sessionCacheTtlMs) {

      return mergeEtSessionRows(cachedSessions);
    }
    if (inFlightSessionsFetch) {
      return inFlightSessionsFetch;
    }
    if (!isUpstreamConnected()) {

      return mergeEtSessionRows(cachedSessions || []);
    }

    inFlightSessionsFetch = (async () => {
      const result = await gatewayBridge.request("sessions.list", {
        limit: sessionLimit,
      });
      const rows = (result && result.sessions) || [];
      const sortedRows = rows
        .filter((row) => {
          const key = extractShortKey(row && row.key);
          return hasSupportedSessionKeyPrefix(key) && !isEvenAiSessionKey(key);
        })
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));

      const sessions = await Promise.all(
        sortedRows.map(async (row) => {
          const key = extractShortKey(row.key);
          const updatedAt = Number.isFinite(row.updatedAt)
            ? Math.floor(row.updatedAt)
            : 0;
          const firstUserMessage = await resolveFirstUserMessage(
            key,
            updatedAt,
            row.messages,
          );
          const pinMeta = getSessionPin(key);
          const agentFields = resolveSessionAgentFields(key, row.key);
          return {
            key,
            updatedAt,
            preview: firstUserMessage
              ? firstUserMessage.slice(0, 80)
              : strictFirstUserMessage
                ? ""
                : extractPreview(row.messages),
            firstUserMessage,
            title: resolveRowTitle(key, row),
            pinned: pinMeta.pinned,
            pinnedAtMs: pinMeta.pinnedAtMs,
            agentId: agentFields.agentId,
            agentName: agentFields.agentName,
          };
        }),
      );

      if (
        typeof pendingSessionListKey === "string" &&
        hasSupportedSessionKeyPrefix(pendingSessionListKey) &&
        !isEvenAiSessionKey(pendingSessionListKey)
      ) {
        const hasPendingSession = sessions.some((session) =>
          sameSessionKey(session && session.key, pendingSessionListKey),
        );
        if (hasPendingSession) {
          pendingSessionListKey = null;
        } else {
          const updatedAt =
            extractSessionTimestampFromKey(pendingSessionListKey) || Date.now();
          const firstUserMessage = await resolveFirstUserMessage(
            pendingSessionListKey,
            updatedAt,
            [],
          );
          const pinMeta = getSessionPin(pendingSessionListKey);
          const agentFields = resolveSessionAgentFields(
            pendingSessionListKey,
            pendingSessionListKey,
          );
          sessions.unshift({
            key: pendingSessionListKey,
            updatedAt,
            preview: firstUserMessage ? firstUserMessage.slice(0, 80) : "",
            firstUserMessage,
            title: resolveRowTitle(pendingSessionListKey, null),
            pinned: pinMeta.pinned,
            pinnedAtMs: pinMeta.pinnedAtMs,
            agentId: agentFields.agentId,
            agentName: agentFields.agentName,
          });
        }
      }

      return mergeEtSessionRows(cacheSessions(sessions));
    })();

    return inFlightSessionsFetch.finally(() => {
      inFlightSessionsFetch = null;
    });
  }

  async function getSessionsByExactKeys(sessionKeys) {
    if (!Array.isArray(sessionKeys) || sessionKeys.length === 0) {
      return [];
    }
    if (!isUpstreamConnected()) {
      return [];
    }

    const orderedKeys = [];
    const seen = new Set();
    for (const rawKey of sessionKeys) {
      const normalizedKey = normalizeExactSessionKey(rawKey);
      if (!normalizedKey) continue;
      const dedupeKey = normalizedKey.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      orderedKeys.push(normalizedKey);
    }

    const sessions = [];
    for (const sessionKey of orderedKeys) {
      let resolved;
      try {
        resolved = await fetchCurrentSessionRow(sessionKey);
      } catch (err) {
        emitDebug(
          "relay.session",
          "session_exact_lookup_failed",
          "debug",
          { sessionKey },
          () => ({
            message: err && err.message ? err.message : String(err),
          }),
        );
        continue;
      }

      const row = resolved && resolved.row ? resolved.row : null;
      if (!row) {
        continue;
      }

      const key = extractShortKey(row.key || sessionKey);
      const updatedAt = Number.isFinite(row.updatedAt)
        ? Math.floor(row.updatedAt)
        : 0;
      const fallbackMessages = Array.isArray(row.messages) ? row.messages : [];
      const firstUserMessage = await resolveFirstUserMessage(
        key,
        updatedAt,
        fallbackMessages,
      );
      const pinMeta = getSessionPin(key);
      const agentFields = resolveSessionAgentFields(key, row.key || sessionKey);
      sessions.push({
        key,
        updatedAt,
        preview: firstUserMessage
          ? firstUserMessage.slice(0, 80)
          : strictFirstUserMessage
            ? ""
            : extractPreview(fallbackMessages),
        firstUserMessage,
        title: resolveRowTitle(key, row),
        pinned: pinMeta.pinned,
        pinnedAtMs: pinMeta.pinnedAtMs,
        agentId: agentFields.agentId,
        agentName: agentFields.agentName,
      });
    }

    return sessions;
  }

  async function copyForeignSession(sourceKey) {
    if (typeof sourceKey !== "string" || !sourceKey.trim()) {
      throw new Error("copyForeignSession requires a session key");
    }
    if (!isUpstreamConnected()) {
      throw new Error("gateway not connected");
    }
    const result = await gatewayBridge.request("sessions.copy", {
      key: sourceKey.trim(),
    });

    const status =
      result && typeof result.status === "string" ? result.status : "accepted";
    if (status !== "accepted") {
      throw new Error(result.error || `sessions.copy ${status}`);
    }
    const key = extractShortKey(result && result.key);
    if (!key) {
      throw new Error("sessions.copy returned no session key");
    }
    return { key };
  }

  function resolveSessionAgentFields(shortKey, fullKey) {
    const agentId = getSessionAgentId(shortKey, fullKey);
    if (!agentId) {
      return { agentId: null, agentName: null };
    }
    return { agentId, agentName: getAgentDisplayName(agentId) || agentId };
  }

  function extractShortKey(fullKey) {
    if (typeof fullKey !== "string") return "";
    const fullKeyLower = fullKey.toLowerCase();
    let prefixIndex = -1;
    for (const prefix of SUPPORTED_SESSION_KEY_PREFIXES_LOWER) {
      const idx = fullKeyLower.indexOf(prefix);
      if (idx >= 0 && (prefixIndex < 0 || idx < prefixIndex)) {
        prefixIndex = idx;
      }
    }
    return prefixIndex >= 0 ? fullKey.slice(prefixIndex) : fullKey;
  }

  function hasSupportedSessionKeyPrefix(key) {
    if (typeof key !== "string" || key.length === 0) return false;
    const keyLower = key.toLowerCase();
    return SUPPORTED_SESSION_KEY_PREFIXES_LOWER.some((prefix) => keyLower.includes(prefix));
  }

  function isEvenAiSessionKey(key) {
    if (typeof key !== "string" || !key.trim()) return false;
    return matchesEvenAiSessionKeyGrammar(extractShortKey(key));
  }

  function sameSessionKey(left, right) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    return left.toLowerCase() === right.toLowerCase();
  }

  function extractSessionTimestampFromKey(sessionKey) {
    if (typeof sessionKey !== "string") return 0;
    const idx = sessionKey.lastIndexOf(":");
    if (idx < 0 || idx >= sessionKey.length - 1) return 0;
    const maybeTs = Number.parseInt(sessionKey.slice(idx + 1), 10);
    return Number.isFinite(maybeTs) && maybeTs > 0 ? maybeTs : 0;
  }

  function extractPreview(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return "";
    for (const msg of messages) {
      const text = extractMessageText(msg && msg.content);
      if (!text || isSyntheticSessionStarter(text)) continue;
      return text.slice(0, 80);
    }
    return "";
  }

  function resolveRowTitle(sessionKey, row) {
    const cached = getSessionTitle(sessionKey);
    if (cached !== null) return cached;

    const candidates = [row?.title, row?.label, row?.displayName];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
    return null;
  }

  function extractMessageText(content) {
    if (typeof content === "string") {
      return normalizeSessionText(content);
    }
    if (!Array.isArray(content)) return "";
    const textParts = [];
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") {
        const text = normalizeSessionText(block.text);
        if (text) textParts.push(text);
      }
    }
    return normalizeSessionText(textParts.join(" "));
  }

  function extractFirstUserMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return "";
    for (const msg of messages) {
      const role =
        msg && typeof msg.role === "string" ? msg.role.toLowerCase() : "";
      if (role !== "user") continue;
      const text = extractMessageText(msg.content);
      if (isSyntheticSessionStarter(text)) continue;
      if (text) return text;
    }
    return "";
  }

  function normalizeSessionText(text) {
    if (typeof text !== "string") return "";
    return text.replace(/\s+/g, " ").trim();
  }

  function loadSessionTitleCache() {
    if (!sessionTitleCachePath) return new Map();
    try {
      if (!fs.existsSync(sessionTitleCachePath)) {
        return new Map();
      }
      const raw = fs.readFileSync(sessionTitleCachePath, "utf8");
      const parsed = JSON.parse(raw);
      const sessions =
        parsed &&
        parsed.version === 1 &&
        parsed.sessions &&
        typeof parsed.sessions === "object"
          ? parsed.sessions
          : {};
      const out = new Map();
      for (const [sessionKey, value] of Object.entries(sessions)) {
        if (!sessionKey || !value || typeof value !== "object") continue;
        const title = typeof value.title === "string" ? value.title : "";
        if (!title) continue;
        const setAtMs = Number.isFinite(value.setAtMs) ? Math.floor(value.setAtMs) : 0;
        const userSet = value.userSet === true;
        out.set(sessionKey, { title, setAtMs, userSet });
      }
      pruneSessionTitleEntries(out);
      return out;
    } catch {
      return new Map();
    }
  }

  function persistSessionTitleCache() {
    if (!sessionTitleCachePath) return;
    try {
      fs.mkdirSync(path.dirname(sessionTitleCachePath), { recursive: true });
      const sessions = {};
      for (const [sessionKey, value] of sessionTitleByKey) {
        sessions[sessionKey] = {
          title: value.title,
          setAtMs: value.setAtMs,
          userSet: value.userSet === true,
        };
      }
      fs.writeFileSync(
        sessionTitleCachePath,
        JSON.stringify(
          {
            version: 1,
            updatedAtMs: Date.now(),
            sessions,
          },
          null,
          2,
        ) + "\n",
      );
    } catch (err) {
      logger.error(
        `[relay] Failed to persist session title cache: ${err.message}`,
      );
    }
  }

  function loadSessionPinCache() {
    if (!sessionPinCachePath) return new Map();
    try {
      if (!fs.existsSync(sessionPinCachePath)) return new Map();
      const raw = fs.readFileSync(sessionPinCachePath, "utf8");
      const parsed = JSON.parse(raw);
      const out = new Map();
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (
          value &&
          typeof value === "object" &&
          typeof value.pinnedAtMs === "number"
        ) {
          out.set(key, { pinned: !!value.pinned, pinnedAtMs: value.pinnedAtMs });
        }
      }
      return out;
    } catch {
      return new Map();
    }
  }

  function persistSessionPinCache() {
    if (!sessionPinCachePath) return;
    try {
      fs.mkdirSync(path.dirname(sessionPinCachePath), { recursive: true });
      const obj = {};
      for (const [key, value] of sessionPinByKey.entries()) {
        obj[key] = value;
      }
      fs.writeFileSync(sessionPinCachePath, JSON.stringify(obj), "utf8");
    } catch (err) {
      logger.error(`[relay] Failed to persist session pin cache: ${err.message}`);
    }
  }

  function countPinnedForKind(kind) {
    let n = 0;
    for (const [key, val] of sessionPinByKey.entries()) {
      if (!val.pinned) continue;
      if (
        kind === "ocuclaw" &&
        hasSupportedSessionKeyPrefix(key) &&
        !isEvenAiSessionKey(key) &&
        !isForeignHermesSessionKey(key)
      ) n++;
      else if (kind === "evenai" && isEvenAiSessionKey(key)) n++;
    }
    return n;
  }

  function getSessionPin(sessionKey) {
    const v = sessionPinByKey.get(sessionKey);
    return v ?? { pinned: false, pinnedAtMs: null };
  }

  function loadSessionAgentCache() {
    if (!sessionAgentCachePath) return new Map();
    try {
      if (!fs.existsSync(sessionAgentCachePath)) return new Map();
      const raw = fs.readFileSync(sessionAgentCachePath, "utf8");
      const parsed = JSON.parse(raw);
      const out = new Map();
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (typeof value === "string" && value.trim()) {
          out.set(key, value.trim());
        }
      }
      return out;
    } catch {
      return new Map();
    }
  }

  function persistSessionAgentCache() {
    if (!sessionAgentCachePath) return;
    try {
      fs.mkdirSync(path.dirname(sessionAgentCachePath), { recursive: true });
      const obj = {};
      for (const [key, value] of sessionAgentByKey.entries()) {
        obj[key] = value;
      }
      fs.writeFileSync(sessionAgentCachePath, JSON.stringify(obj), "utf8");
    } catch (err) {
      logger.error(
        `[relay] Failed to persist session agent cache: ${err.message}`,
      );
    }
  }

  function explicitSessionAgentId(sessionKey, fullKey) {
    const override = sessionAgentByKey.get(sessionKey);
    if (typeof override === "string" && override.trim()) {
      return override.trim();
    }
    return deriveAgentIdFromFullKey(fullKey || sessionKey) || "";
  }

  function sessionAgentOverrideId(sessionKey) {
    const override = sessionAgentByKey.get(sessionKey);
    return typeof override === "string" && override.trim()
      ? override.trim()
      : "";
  }

  function getSessionAgentId(sessionKey, fullKey) {
    const explicit = explicitSessionAgentId(sessionKey, fullKey);
    if (explicit) {
      return explicit;
    }
    const fallback = getDefaultAgentId();
    return typeof fallback === "string" && fallback.trim()
      ? fallback.trim()
      : "";
  }

  function hasExplicitSessionAgent(sessionKey, fullKey) {
    return explicitSessionAgentId(sessionKey, fullKey) !== "";
  }

  function setSessionAgentId(sessionKey, agentId) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      return { ok: false, reason: "invalid" };
    }
    const normalized = typeof agentId === "string" ? agentId.trim() : "";
    if (normalized) {
      sessionAgentByKey.set(sessionKey, normalized);
    } else {
      sessionAgentByKey.delete(sessionKey);
    }
    persistSessionAgentCache();
    invalidateSessionsCache();
    return { ok: true };
  }

  function setSessionPinned(kind, sessionKey, pinned) {
    if (!sessionKey || (kind !== "ocuclaw" && kind !== "evenai")) {
      return { ok: false, reason: "invalid" };
    }
    if (pinned) {
      const countForKind = countPinnedForKind(kind);
      const already = sessionPinByKey.get(sessionKey)?.pinned === true;
      const bypassesOwnSessionCap =
        kind === "ocuclaw" && isForeignHermesSessionKey(sessionKey);
      if (
        !already &&
        !bypassesOwnSessionCap &&
        countForKind >= PIN_CAP_PER_KIND
      ) {
        return { ok: false, reason: "cap" };
      }
      sessionPinByKey.set(sessionKey, { pinned: true, pinnedAtMs: Date.now() });
    } else {
      sessionPinByKey.delete(sessionKey);
    }
    persistSessionPinCache();
    invalidateSessionsCache();
    return { ok: true };
  }

  async function deleteSessions(kind, sessionKeys) {
    const deleted = [];
    const failed = [];
    for (const key of sessionKeys) {
      try {
        await deleteSingleSession(kind, key);
        sessionPinByKey.delete(key);
        sessionTitleByKey.delete(key);
        firstSentUserMessageBySession.delete(key);
        distillerBudget.clear(key);
        deleted.push(key);
      } catch (err) {
        failed.push({ key, reason: err?.message ?? "unknown" });
      }
    }
    persistSessionPinCache();
    persistSessionTitleCache();
    invalidateSessionsCache();
    return { deleted, failed };
  }

  async function searchTranscripts(kind, query, searchOpts = {}) {
    const needle = (typeof query === "string" ? query.trim() : "").toLowerCase();
    if (!needle) return { snippets: [], truncated: false, refreshing: false };
    if (kind === "terminal") {
      if (!etTranscriptSearchProvider) {
        return { snippets: [], truncated: false, refreshing: false };
      }
      return etTranscriptSearchProvider(query, searchOpts);
    }
    const maxSnippets = 50;
    const contextChars = 60;
    const sessions = await getTranscriptSearchSessions(kind).catch(() => []);
    const snippets = [];
    let truncated = false;
    for (const session of sessions) {
      if (snippets.length >= maxSnippets) {
        truncated = true;
        break;
      }
      if (
        kind === "ocuclaw" &&
        (
          !hasSupportedSessionKeyPrefix(session.key) ||
          isEvenAiSessionKey(session.key) ||
          isForeignHermesSessionKey(session.key)
        )
      ) continue;
      if (kind === "evenai" && !isEvenAiSessionKey(session.key)) continue;
      let history;
      try {
        history = await gatewayBridge.request("chat.history", {
          sessionKey: session.key,
          limit: 200,
        });
      } catch {
        continue;
      }
      const messages = (history && Array.isArray(history.messages)) ? history.messages : [];
      for (const msg of messages) {
        if (snippets.length >= maxSnippets) {
          truncated = true;
          break;
        }
        const text = extractRawMessageText(msg);
        if (!text) continue;
        const lower = text.toLowerCase();
        const idx = lower.indexOf(needle);
        if (idx < 0) continue;
        const matchEnd = idx + needle.length;
        const before = text.slice(Math.max(0, idx - contextChars), idx);
        const match = text.slice(idx, matchEnd);
        const after = text.slice(matchEnd, Math.min(text.length, matchEnd + contextChars));
        snippets.push({
          sessionKey: session.key,
          role: typeof msg.role === "string" ? msg.role : "",
          updatedAtMs: session.updatedAt || 0,
          before,
          match,
          after,
        });
      }
    }
    return { snippets, truncated };
  }

  async function getTranscriptSearchSessions(kind) {
    if (kind === "evenai") {
      if (!isUpstreamConnected()) return [];
      const result = await gatewayBridge.request("sessions.list", {
        limit: sessionLimit,
      });
      const rows = (result && result.sessions) || [];
      return rows
        .map((row) => {
          const key = extractShortKey(row && row.key);
          return {
            key,
            updatedAt: Number.isFinite(row && row.updatedAt)
              ? Math.floor(row.updatedAt)
              : 0,
          };
        })
        .filter((row) => row.key && isEvenAiSessionKey(row.key))
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    }

    const sessions = await getSessions();
    return sessions.filter((session) => (
      session &&
      typeof session.key === "string" &&
      hasSupportedSessionKeyPrefix(session.key) &&
      !isEvenAiSessionKey(session.key) &&
      !isForeignHermesSessionKey(session.key)
    ));
  }

  function extractRawMessageText(msg) {
    if (!msg) return "";
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      let acc = "";
      for (const block of msg.content) {
        if (block && block.type === "text" && typeof block.text === "string") {
          acc += (acc ? "\n" : "") + block.text;
        }
      }
      return acc;
    }
    return "";
  }

  async function deleteSingleSession(kind, key) {

    const canonicalKey = await resolveSessionCanonicalKey(key);
    await gatewayBridge.request("sessions.delete", {
      key: canonicalKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  }

  async function switchAndDeleteSessions(kind, sessionKeys) {
    if (
      kind === "ocuclaw" &&
      currentSessionKey &&
      sessionKeys.includes(currentSessionKey)
    ) {
      await newSession();
    }
    return deleteSessions(kind, sessionKeys);
  }

  async function broadcastSessionsForKind(kind) {
    invalidateSessionsCache();
    if (kind === "ocuclaw" && typeof opts.broadcastSessions === "function") {
      try {
        await opts.broadcastSessions();
      } catch (err) {
        logger.error(
          `[relay] broadcastSessions failed: ${err?.message ?? err}`,
        );
      }
    } else if (
      kind === "evenai" &&
      typeof opts.broadcastEvenAiSessions === "function"
    ) {
      try {
        await opts.broadcastEvenAiSessions();
      } catch (err) {
        logger.error(
          `[relay] broadcastEvenAiSessions failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  function pruneSessionTitleEntries(cache) {
    while (cache.size > firstUserMessageCacheLimit) {
      let evicted = false;
      for (const sessionKey of cache.keys()) {
        if (shouldPinFirstUserMessageKey(sessionKey)) {
          continue;
        }
        cache.delete(sessionKey);
        evicted = true;
        break;
      }
      if (!evicted) {
        break;
      }
    }
  }

  function loadFirstSentUserMessageCache() {
    if (!persistFirstUserMessages || !firstUserMessageCachePath) return new Map();
    try {
      if (!fs.existsSync(firstUserMessageCachePath)) {
        return new Map();
      }
      const raw = fs.readFileSync(firstUserMessageCachePath, "utf8");
      const parsed = JSON.parse(raw);
      const sessions =
        parsed &&
        parsed.version === 1 &&
        parsed.sessions &&
        typeof parsed.sessions === "object"
          ? parsed.sessions
          : {};
      const out = new Map();
      for (const [sessionKey, value] of Object.entries(sessions)) {
        const normalized = normalizeSessionText(value);
        if (!sessionKey || !normalized) continue;
        out.set(sessionKey, normalized);
      }
      pruneFirstUserMessageEntries(out);
      return out;
    } catch {
      return new Map();
    }
  }

  let firstUserCacheWriteInFlight = false;
  let firstUserCacheDirty = false;
  let firstUserCacheFlushPromise = null;
  let firstUserCacheFlushResolve = null;

  async function writeFirstSentUserMessageCacheToDisk() {
    const sessions = {};
    for (const [sessionKey, text] of firstSentUserMessageBySession) {
      sessions[sessionKey] = text;
    }
    const payload =
      JSON.stringify(
        {
          version: 1,
          updatedAtMs: Date.now(),
          sessions,
        },
        null,
        2,
      ) + "\n";
    const tmpPath = `${firstUserMessageCachePath}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(firstUserMessageCachePath), {
        recursive: true,
      });
      await fs.promises.writeFile(tmpPath, payload);
      await fs.promises.rename(tmpPath, firstUserMessageCachePath);
    } catch (err) {
      logger.error(
        `[relay] Failed to persist session first-user cache: ${err && err.message ? err.message : err}`,
      );
    }
  }

  function runFirstSentUserMessageCacheWrite() {
    if (firstUserCacheWriteInFlight) {
      return;
    }
    if (!firstUserCacheDirty) {

      if (firstUserCacheFlushResolve) {
        const resolve = firstUserCacheFlushResolve;
        firstUserCacheFlushResolve = null;
        firstUserCacheFlushPromise = null;
        resolve();
      }
      return;
    }
    firstUserCacheDirty = false;
    firstUserCacheWriteInFlight = true;
    writeFirstSentUserMessageCacheToDisk().finally(() => {
      firstUserCacheWriteInFlight = false;

      runFirstSentUserMessageCacheWrite();
    });
  }

  function persistFirstSentUserMessageCache() {
    if (!persistFirstUserMessages || !firstUserMessageCachePath) return;
    firstUserCacheDirty = true;
    runFirstSentUserMessageCacheWrite();
  }

  function flushFirstSentUserMessageCache() {
    if (!persistFirstUserMessages || !firstUserMessageCachePath) {
      return Promise.resolve();
    }
    if (!firstUserCacheWriteInFlight && !firstUserCacheDirty) {
      return Promise.resolve();
    }
    if (!firstUserCacheFlushPromise) {
      firstUserCacheFlushPromise = new Promise((resolve) => {
        firstUserCacheFlushResolve = resolve;
      });
    }
    return firstUserCacheFlushPromise;
  }

  function pruneFirstSentUserMessageCache() {
    pruneFirstUserMessageEntries(firstSentUserMessageBySession);
  }

  function recordFirstSentUserMessage(sessionKey, text) {
    const normalized = normalizeSessionText(text);
    if (!normalized || normalized.startsWith("/")) return;
    if (firstSentUserMessageBySession.has(sessionKey)) return;

    firstSentUserMessageBySession.set(sessionKey, normalized);
    pruneFirstSentUserMessageCache();
    persistFirstSentUserMessageCache();

    firstUserMessageCache.set(sessionKey, {
      updatedAt: Number.MAX_SAFE_INTEGER,
      firstUserMessage: normalized,
    });
    pruneFirstUserMessageCache();
  }

  function getSessionTitle(sessionKey) {
    const entry = sessionTitleByKey.get(sessionKey);
    return entry ? entry.title : null;
  }

  function getSessionTitleRecord(sessionKey) {
    const entry = sessionTitleByKey.get(sessionKey);
    return entry ? { ...entry } : null;
  }

  function setSessionTitle(sessionKey, title, opts) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      return { ok: false, code: "invalid_session_key" };
    }
    if (typeof title !== "string" || !title.trim()) {
      return { ok: false, code: "invalid_title" };
    }
    const trimmed = title.trim();

    const origin =
      opts && typeof opts.origin === "string" && opts.origin
        ? opts.origin
        : opts && opts.userSet === true
          ? "user_tool"
          : "topic_distiller";
    const previous = sessionTitleByKey.get(sessionKey);
    const decision = decideTitleWrite(previous, origin);
    if (!decision.allowed) {
      return { ok: false, code: decision.code };
    }
    const replaced = !!previous;
    const nextUserSet = decision.nextUserSet;
    const setByUser = isUserOrigin(origin);
    sessionTitleByKey.set(sessionKey, {
      title: trimmed,
      setAtMs: Date.now(),
      userSet: !!nextUserSet,
      origin,
    });
    pruneSessionTitleEntries(sessionTitleByKey);
    persistSessionTitleCache();
    invalidateSessionsCache();
    emitDebug(
      "relay.session",
      setByUser ? "session_title_set_by_user" : "session_title_set",
      "info",
      { sessionKey },
      () => ({ sessionKey, title: trimmed, replaced, userSet: !!nextUserSet, origin }),
    );

    if (!isUpstreamConnected()) {
      emitDebug(
        "relay.session",
        "session_title_upstream_mirror_skipped",
        "debug",
        { sessionKey },
        () => ({ reason: "upstream_disconnected", origin }),
      );
    }
    if (isUpstreamConnected()) {
      resolveSessionCanonicalKey(sessionKey)
        .then((canonicalKey) =>

          gatewayBridge.request("sessions.patch", {
            key: canonicalKey,
            label: trimmed,
          }),
        )
        .catch((err) => {
          emitDebug(
            "relay.session",
            "session_title_upstream_patch_failed",
            "debug",
            { sessionKey },
            () => ({ message: err && err.message ? err.message : String(err) }),
          );
        });
    }
    return { ok: true, replaced, userSet: !!nextUserSet };
  }

  function isSessionUserLocked(sessionKey) {
    const entry = sessionTitleByKey.get(sessionKey);
    return entry ? entry.userSet === true : false;
  }

  function hasRecordedFirstUserMessage(sessionKey) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) return false;
    return firstSentUserMessageBySession.has(sessionKey);
  }

  function recordNeuralSessionNamesEnabled(sessionKey, enabled) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) return;
    neuralSessionNamesEnabledByKey.set(sessionKey, enabled === true);
    while (neuralSessionNamesEnabledByKey.size > firstUserMessageCacheLimit) {
      const oldest = neuralSessionNamesEnabledByKey.keys().next().value;
      if (oldest === undefined) break;
      neuralSessionNamesEnabledByKey.delete(oldest);
    }
  }

  function isNeuralSessionNamesEnabled(sessionKey) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) return true;
    const cached = neuralSessionNamesEnabledByKey.get(sessionKey);
    return cached === undefined ? true : cached;
  }

  function recordDisplayToggleStates(sessionKey, states) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) return;
    displayToggleTracker.record(sessionKey, states);
  }
  function getDisplayStartStates(sessionKey) {
    return displayToggleTracker.getStart(sessionKey);
  }
  function getDisplayCurrentStates(sessionKey) {
    return displayToggleTracker.getCurrent(sessionKey);
  }
  function clearDisplayToggleStates(sessionKey) {
    displayToggleTracker.clear(sessionKey);
  }

  function getDistillerBudget() {
    return distillerBudget;
  }
  function clearDistillerBudget(sessionKey) {
    if (typeof sessionKey === "string" && sessionKey.trim()) {
      distillerBudget.clear(sessionKey);
    }
  }

  function clearSessionTitle(sessionKey) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) return;
    const hadTitle = sessionTitleByKey.delete(sessionKey);
    if (!hadTitle) return;
    persistSessionTitleCache();
    invalidateSessionsCache();
    if (isUpstreamConnected()) {
      resolveSessionCanonicalKey(sessionKey)
        .then((canonicalKey) =>
          gatewayBridge.request("sessions.patch", { key: canonicalKey, label: null }),
        )
        .catch((err) => {
          emitDebug(
            "relay.session",
            "session_title_upstream_clear_failed",
            "debug",
            { sessionKey },
            () => ({ message: err && err.message ? err.message : String(err) }),
          );
        });
    }
  }

  function clearLogicalSessionState(sessionKey) {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) return;
    clearSessionTitle(sessionKey);
    displayToggleTracker.clear(sessionKey);
    distillerBudget.clear(sessionKey);

    const hadMarker = firstSentUserMessageBySession.delete(sessionKey);
    firstUserMessageCache.delete(sessionKey);
    if (hadMarker) persistFirstSentUserMessageCache();
    neuralSessionNamesEnabledByKey.delete(sessionKey);
  }

  function isSyntheticSessionStarter(text) {
    if (!text) return false;
    if (
      typeof conversationState._isLikelySyntheticSessionStarterPrompt === "function" &&
      conversationState._isLikelySyntheticSessionStarterPrompt(text)
    ) {
      return true;
    }
    const normalized = normalizeSessionText(text).toLowerCase();
    if (!normalized.includes("/new") || !normalized.includes("/reset")) return false;
    if (/^a\s+new\s+session\s+was\s+started\b/.test(normalized)) return true;
    if (normalized.length < 80) return false;
    if (
      !/\b(?:new|fresh)\s+session\b|\bsession\b.*\b(?:started|reset|created)\b/.test(normalized)
    ) {
      return false;
    }

    let signalCount = 0;
    if (/\bgreet\b/.test(normalized)) signalCount += 1;
    if (/\bconfigured\b.*\b(?:persona|style|voice)\b/.test(normalized)) signalCount += 1;
    if (/\bbe yourself\b|\bmannerisms\b|\bmood\b/.test(normalized)) signalCount += 1;
    if (/\b(?:1-3|1 to 3|one to three)\s+sentences?\b/.test(normalized)) signalCount += 1;
    if (/\bask\b.*\bwhat\b.*\bwant\b.*\bdo\b/.test(normalized)) signalCount += 1;
    if (/\bdefault(?:_| )model\b/.test(normalized)) signalCount += 1;
    if (/\bdo not mention\b/.test(normalized)) signalCount += 1;
    if (/\binternal\b.*\b(?:steps|files|tools|reasoning)\b/.test(normalized)) signalCount += 1;
    return signalCount >= 2;
  }

  function pruneFirstUserMessageCache() {
    pruneFirstUserMessageEntries(firstUserMessageCache);
  }

  function shouldPinFirstUserMessageKey(sessionKey) {
    if (!isPinnedFirstUserMessageKey || typeof sessionKey !== "string") {
      return false;
    }
    const normalizedKey = sessionKey.trim();
    if (!normalizedKey) {
      return false;
    }
    try {
      return isPinnedFirstUserMessageKey(normalizedKey) === true;
    } catch (err) {
      logger.warn(
        `[relay] first-user cache pin callback failed for ${normalizedKey}: ${err && err.message ? err.message : err}`,
      );
      return false;
    }
  }

  function pruneFirstUserMessageEntries(cache) {
    while (cache.size > firstUserMessageCacheLimit) {
      let evicted = false;
      for (const sessionKey of cache.keys()) {
        if (shouldPinFirstUserMessageKey(sessionKey)) {
          continue;
        }
        cache.delete(sessionKey);
        evicted = true;
        break;
      }
      if (!evicted) {
        break;
      }
    }
  }

  async function resolveFirstUserMessage(sessionKey, updatedAt, fallbackMessages) {
    const firstObservedUserMessage = firstSentUserMessageBySession.get(sessionKey);
    if (firstObservedUserMessage) {
      return firstObservedUserMessage;
    }

    const cached = firstUserMessageCache.get(sessionKey);
    if (cached && cached.firstUserMessage) {
      return cached.firstUserMessage;
    }
    if (cached && cached.updatedAt === updatedAt) {
      return cached.firstUserMessage;
    }

    if (strictFirstUserMessage) {
      firstUserMessageCache.set(sessionKey, { updatedAt, firstUserMessage: "" });
      pruneFirstUserMessageCache();
      return "";
    }

    let firstUserMessage = "";
    if (isUpstreamConnected()) {
      try {
        const result = await gatewayBridge.request("chat.history", {
          sessionKey,
          limit: 200,
        });
        firstUserMessage = extractFirstUserMessage(
          result && Array.isArray(result.messages) ? result.messages : [],
        );
      } catch (err) {
        emitDebug(
          "relay.session",
          "session_first_message_lookup_failed",
          "debug",
          { sessionKey },
          () => ({
            message: err && err.message ? err.message : String(err),
          }),
        );
      }
    }
    if (!firstUserMessage) {
      firstUserMessage = extractFirstUserMessage(fallbackMessages);
    }
    firstUserMessageCache.set(sessionKey, { updatedAt, firstUserMessage });
    pruneFirstUserMessageCache();
    return firstUserMessage;
  }

  function cacheSessions(sessions) {
    cachedSessions = Array.isArray(sessions) ? sessions : [];
    cachedSessionsFetchedAt = Date.now();
    return cachedSessions;
  }

  function invalidateSessionsCache() {
    cachedSessionsFetchedAt = 0;
  }

  function handleUpstreamStatusChange(connected) {
    if (!connected) {
      inFlightSessionsFetch = null;
    }
  }

  async function switchToSession(sessionKey, opts = {}) {
    if (
      typeof sessionKey === "string" &&
      sessionKey.length > 0 &&
      !hasSupportedSessionKeyPrefix(sessionKey) &&
      !isEtSessionKey(sessionKey)
    ) {
      emitDebug(
        "relay.session",
        "switch_session_rejected",
        "warn",
        { sessionKey, reason: "unsupported_session_key" },
        () => ({
          sessionKey,
          reason: "unsupported_session_key",
          currentSessionKey,
        }),
      );
      throw createUnsupportedSessionKeyError(sessionKey, currentSessionKey);
    }
    const markPendingSessionList =
      opts.markPendingSessionList === true &&
      hasSupportedSessionKeyPrefix(sessionKey);
    invalidateSessionsCache();
    if (onSessionStateReset) {
      onSessionStateReset();
    }
    pendingSessionListKey = markPendingSessionList ? sessionKey : null;
    currentSessionKey = sessionKey;
    emitDebug(
      "relay.session",
      "switch_session",
      "info",
      { sessionKey },
      () => ({
        sessionKey,
        markPendingSessionList,
      }),
    );
    conversationState.clear();

    if (isEtSessionKey(sessionKey) && etHistoryProvider) {
      try {
        const rows = await etHistoryProvider(sessionKey);

        const etAgentName = /^et:codex:/.test(sessionKey) ? "Codex" : "Claude";
        conversationState.hydrate(Array.isArray(rows) ? rows : [], etAgentName);
      } catch (err) {
        logger.error(`[relay] et history load failed: ${err.message}`);
      }
    } else if (isUpstreamConnected()) {
      try {
        const result = await gatewayBridge.request("chat.history", {
          sessionKey,
          limit: 200,
        });
        const messages =
          result && Array.isArray(result.messages) ? result.messages : [];
        const sanitized = Array.isArray(messages)
          ? messages.map((msg) =>
              msg && msg.role === "assistant"
                ? { ...msg, content: sanitizeAssistantContentBlocks(msg.content) }
                : msg,
            )
          : messages;
        conversationState.hydrate(sanitized, getAgentName());
      } catch (err) {
        logger.error(
          `[relay] Failed to load session history: ${err.message}`,
        );
      }
    }

    const pages = conversationState.getPages();
    if (onPagesChanged) {
      onPagesChanged(pages);
    }
    if (onStatusChanged) {
      onStatusChanged();
    }
    return pages;
  }

  async function newSession(opts = {}) {
    const sendResetCommand = Reflect.get(opts, "sendResetCommand") !== false;
    const hasAgentRef = Reflect.has(opts, "agentRef");
    const { sessionKey, agentRef } = mintSessionKey({
      agentRef: hasAgentRef ? Reflect.get(opts, "agentRef") : "",
      inheritAppBinding: !hasAgentRef,
    });
    invalidateSessionsCache();
    if (onSessionStateReset) {
      onSessionStateReset();
    }
    currentSessionKey = sessionKey;
    pendingSessionListKey = sessionKey;
    pendingInitialConfigSessionKeys.add(sessionKey);
    emitDebug(
      "relay.session",
      "new_session",
      "info",
      { sessionKey },
      () => ({
        sessionKey,
        sendResetCommand,
        agentRef: agentRef || null,
      }),
    );
    conversationState.clear();
    conversationState.setAgentName(getAgentName() || "Agent");
    const pages = conversationState.getPages();
    if (onPagesChanged) {
      onPagesChanged(pages);
    }
    if (onStatusChanged) {
      onStatusChanged();
    }
    if (sendResetCommand && isUpstreamConnected()) {
      gatewayBridge
        .sendMessage(`/new ${activeNewSessionGreetingPrompt()}`, sessionKey)
        .catch((err) => {
          logger.error(`[relay] Failed to send /new for new session: ${err.message}`);
        });
    }
    return { sessionKey, pages };
  }

  function normalizeSessionKeyForCompare(rawKey) {
    if (typeof rawKey !== "string") return "";
    const trimmed = rawKey.trim();
    if (!trimmed) return "";
    return extractShortKey(trimmed).toLowerCase();
  }

  function isCurrentSession(eventSessionKey) {
    const eventKey = normalizeSessionKeyForCompare(eventSessionKey || "main");
    const currentKey = normalizeSessionKeyForCompare(ensureSessionKey());
    if (!eventKey || !currentKey) return false;
    return eventKey === currentKey || eventKey.endsWith(`:${currentKey}`);
  }

  function hasPendingInitialConfig(sessionKey) {
    return pendingInitialConfigSessionKeys.has(sessionKey);
  }

  function clearPendingInitialConfig(sessionKey) {
    pendingInitialConfigSessionKeys.delete(sessionKey);
  }

  return {
    ensureSessionKey,
    peekSessionKey,
    createDetachedSessionKey,
    recordFirstSentUserMessage,
    flushFirstSentUserMessageCache,
    invalidateSessionsCache,
    handleUpstreamStatusChange,
    getSessionModelConfig,
    getCurrentSessionModelConfig,
    setSessionModelConfig,
    setCurrentSessionModelConfig,
    primeSessionModelConfig,
    hasPendingInitialConfig,
    clearPendingInitialConfig,
    getSessions,
    copyForeignSession,
    getSessionTitle,
    getSessionTitleRecord,
    getSessionsByExactKeys,
    hasRecordedFirstUserMessage,
    isNeuralSessionNamesEnabled,
    isEvenAiSessionKey,
    isSessionUserLocked,
    recordNeuralSessionNamesEnabled,
    recordDisplayToggleStates,
    getDisplayStartStates,
    getDisplayCurrentStates,
    clearDisplayToggleStates,
    getDistillerBudget,
    clearDistillerBudget,
    clearSessionTitle,
    clearLogicalSessionState,
    setSessionTitle,
    switchToSession,
    newSession,
    isCurrentSession,
    setSessionPinned,
    getSessionPin,
    getSessionAgentId,
    setSessionAgentId,
    hasExplicitSessionAgent,
    deleteSessions,
    switchAndDeleteSessions,
    broadcastSessionsForKind,
    searchTranscripts,
  };
}

module.exports = { activeNewSessionGreetingPrompt, createSessionService, HERMES_NEW_SESSION_GREETING_PROMPT, NEW_SESSION_GREETING_PROMPT };
