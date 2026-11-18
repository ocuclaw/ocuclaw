const { activeBackendDisplayName } = require("../gateway/backend-contract.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { validateGlassesUiInjectSpec } = require("../tools/glasses-ui-tool.cjs");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY } = require("../domain/even-ai-session-keys.cjs");
const { parseStarMapForgetRequest } = require("../domain/star-map.cjs");
const { normalizeReplyLanguageTag } = require("../domain/reply-language.cjs");
const { isForeignHermesSessionKey } = require("./hermes-session-keys.cjs");
const { APP_CLIENT_NAME } = require("./relay-client-names.cjs");
const { cardBuildTaskSendOf, cardChangeSendOf, cardCheckSendOf } = require("./card-build-phases.cjs");
const { parseOptionalSetupRequest, optionalSetupFailure, optionalSetupResult } = require("../setup/optional-setup-protocol.cjs");
const { parseModelSitesRequest, modelSitesFailure, modelSitesResult } = require("../setup/model-sites-protocol.cjs");
const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { parseOptionalTrimmedString, parseOptionalInteger, parseOptionalNonNegativeNumber, parseOptionalPositiveInt } = require("./downstream-parse-optional.cjs");
const { parseRemoteControl } = require("./downstream-remote-control.cjs");
const { formatEntries, formatActivity, formatThinkingUpdate, formatThinkingFinalize, formatRunSignal, formatCardBuild, formatTyping, formatError, formatSendAckCompat, formatSessionAbortAck, formatOperationReceived, formatProtocol, formatStreaming, formatStreamClear, formatCapabilitySnapshot, formatPushMessage, createSnapshotFormatters } = require("./downstream-codec-core.cjs");
const { formatSessions, formatSessionDiff, formatSessionSwitched, formatSessionSwitchRejected, formatSessionModelConfig, formatSessionModelConfigAck, formatSessionDriverState, createEvenAiSessionsFormatter, sessionInfoFingerprint } = require("./downstream-codec-sessions.cjs");
const { formatModelsCatalog, formatSkillsCatalog, formatStarMapSnapshot, formatStarMapForgotten, formatCommandCatalog, formatAgentsCatalog, formatAgentCreateResult, formatAgentEmojiSetResult, formatAgentsRouteResult, formatAgentDescriptionSetResult, formatAgentDescriptionAutoResult, formatAgentSettingsResult, formatHostDefaultsResult, formatProviderUsageSnapshot } = require("./downstream-codec-catalogs.cjs");
const { formatLiveuiLibrary, formatLiveuiLibraryOpenResult, formatProgramCardSaveRequest, formatProgramCardReview, formatLiveuiTasks, formatLiveuiTaskReviewAck, formatLiveuiTaskExecutors, formatLiveuiTaskExecutorAck, formatLiveuiTaskPreferredTemplateAck, formatLiveuiTaskContextAck, formatLiveuiPrefs, formatLiveuiPrefsAck, formatLiveuiGrantsSnapshot, formatLiveuiGrantsAck, formatLiveuiStatus, formatLiveuiTaskSettingsAck } = require("./downstream-codec-liveui.cjs");
const { formatEvenAiSettings, formatEvenAiSettingsAck, formatOcuClawSettings, formatSavedPrompts, formatSavedPromptsAck, formatOcuClawSettingsAck } = require("./downstream-codec-settings.cjs");
const { formatApprovalExplanation, formatApprovalExplanationPending, formatApprovalResolved, formatApprovalResponseAck, formatWaiting, createApprovalFormatter } = require("./downstream-codec-approval.cjs");
const { formatSonioxModels, formatHermesSttTranscribeResult, formatTranscription, formatListenCommitted, formatEvenAiListenIntercepted, formatListenEnded, formatListenError, formatListenReady, formatScriptedListenReady, formatSonioxTemporaryKey, formatSonioxTemporaryKeyError, createHermesSttCapabilitiesFormatter } = require("./downstream-codec-voice.cjs");
const { REALTIME_APP_PROTOCOL, createRealtimeTalkDownstreamHandlers } = require("./realtime-talk-lane.cjs");
const { TTS_APP_PROTOCOL, createTtsDownstreamHandlers } = require("./tts-lane.cjs");
const { PHONE_SETTINGS_APP_PROTOCOL } = require("../tools/phone-settings-tool.cjs");
const { formatDebugSet, formatDebugDump, formatTraceLog, formatDebugConfigSnapshot, formatRemoteControl, formatRemoteControlAck, formatAutomationStateRequest, formatAutomationRegistryRequest, formatAutomationStateSnapshot, formatAutomationRegistry, formatReadinessProbeRequest, formatReadinessProbeAck } = require("./downstream-codec-debug.cjs");
const { createLiveuiHandlers } = require("./downstream-handlers-liveui.cjs");
const { createHermesHandlers } = require("./downstream-handlers-hermes.cjs");
const { createSimulateHandlers } = require("./downstream-handlers-simulate.cjs");
const { createSessionHandlers } = require("./downstream-handlers-sessions.cjs");
const { createSettingsHandlers } = require("./downstream-handlers-settings.cjs");
const { createVoiceHandlers } = require("./downstream-handlers-voice.cjs");

const { sanitizeProtocolFrame } = require("./downstream-codec-core.cjs");

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function parseEventDebug(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.cat !== "string" || !msg.cat.trim()) return null;
  if (typeof msg.event !== "string" || !msg.event.trim()) return null;
  const severity =
    msg.severity === "info" || msg.severity === "warn" || msg.severity === "error"
      ? msg.severity
      : "debug";
  return {
    cat: msg.cat.trim(),
    event: msg.event.trim(),
    severity,
    screen: typeof msg.screen === "string" && msg.screen.trim() ? msg.screen.trim() : null,
    runId: typeof msg.runId === "string" && msg.runId.trim() ? msg.runId.trim() : null,
    sessionKey:
      typeof msg.sessionKey === "string" && msg.sessionKey.trim() ? msg.sessionKey.trim() : null,
    data:
      msg.data && typeof msg.data === "object" && !Array.isArray(msg.data)
        ? msg.data
        : { value: msg.data ?? null },
  };
}

function createDownstreamHandler(opts) {
  const logger = normalizeLogger(opts.logger);
  const externalDebugToolsEnabled = opts.externalDebugToolsEnabled !== false;
  const onSend = opts.onSend;
  const onAbortSession = opts.onAbortSession || null;
  const onSteerSession = opts.onSteerSession || null;
  const onSimulate = opts.onSimulate;
  const onSimulateStream = opts.onSimulateStream || null;
  const onSimulateStreamCancel = opts.onSimulateStreamCancel || null;
  const onSimulateActivity = opts.onSimulateActivity || null;
  const onSimulateThinking = opts.onSimulateThinking || null;
  const onSimulateRunSignal = opts.onSimulateRunSignal || null;
  const onSimulateModelCatalog = opts.onSimulateModelCatalog || null;
  const onSimulateSessionList = opts.onSimulateSessionList || null;
  const onSimulateTool = opts.onSimulateTool || null;
  const onSimulateApproval = opts.onSimulateApproval || null;
  const approvalPurposeEnabled =
    typeof opts.approvalPurposeEnabled === "function" ? opts.approvalPurposeEnabled : () => true;
  const onSimulateDemand = opts.onSimulateDemand || null;
  const onSimulateVoice = opts.onSimulateVoice || null;
  const onNewChat = opts.onNewChat;
  const onGetSessions = opts.onGetSessions;
  const onSwitchSession = opts.onSwitchSession;
  const onCopySession = opts.onCopySession;
  const onAdoptSession = opts.onAdoptSession;
  const onSessionDriverTakeOver = opts.onSessionDriverTakeOver;
  const onNewSession = opts.onNewSession;
  const onSlashCommand = opts.onSlashCommand;
  const onGetModelsCatalog = opts.onGetModelsCatalog;
  const onInputPrediction = typeof opts.onInputPrediction === "function" ? opts.onInputPrediction : null;
  const onInputStarted = typeof opts.onInputStarted === "function" ? opts.onInputStarted : null;
  const onClientSessionSelected =
    typeof opts.onClientSessionSelected === "function" ? opts.onClientSessionSelected : null;
  const onGetSkillsCatalog = opts.onGetSkillsCatalog;
  const onGetStarMap = typeof opts.onGetStarMap === "function" ? opts.onGetStarMap : null;
  const onForgetStar = typeof opts.onForgetStar === "function" ? opts.onForgetStar : null;
  const onGetLiveuiLibrary = opts.onGetLiveuiLibrary || null;
  const onOpenLiveuiLibraryItem = opts.onOpenLiveuiLibraryItem || null;
  const onSaveProgramCard = typeof opts.onSaveProgramCard === "function" ? opts.onSaveProgramCard : null;
  const onCheckpointProgramCard =
    typeof opts.onCheckpointProgramCard === "function" ? opts.onCheckpointProgramCard : null;
  const onOpenProgramCard = typeof opts.onOpenProgramCard === "function" ? opts.onOpenProgramCard : null;
  const onGetProgramCardSource = typeof opts.onGetProgramCardSource === "function" ? opts.onGetProgramCardSource : null;
  const onGetProgramCardRevisions =
    typeof opts.onGetProgramCardRevisions === "function" ? opts.onGetProgramCardRevisions : null;
  const onProgramCardRevision = typeof opts.onProgramCardRevision === "function" ? opts.onProgramCardRevision : null;
  const onGetProgramCardSlots = typeof opts.onGetProgramCardSlots === "function" ? opts.onGetProgramCardSlots : null;
  const onProgramCardSlot = typeof opts.onProgramCardSlot === "function" ? opts.onProgramCardSlot : null;
  const onProgramCardReview = typeof opts.onProgramCardReview === "function" ? opts.onProgramCardReview : null;
  const onProgramCardReviewApply =
    typeof opts.onProgramCardReviewApply === "function" ? opts.onProgramCardReviewApply : null;
  const onProgramCardRevisionPicture =
    typeof opts.onProgramCardRevisionPicture === "function" ? opts.onProgramCardRevisionPicture : null;
  const onCancelLiveuiTaskLaunch = opts.onCancelLiveuiTaskLaunch || null;

  const onProgramCardRequest = typeof opts.onProgramCardRequest === "function" ? opts.onProgramCardRequest : null;
  const onGetLiveuiTasksForPhone = opts.onGetLiveuiTasksForPhone || null;
  const onGetLiveuiTaskRunsForPhone = opts.onGetLiveuiTaskRunsForPhone || null;
  const onGetLiveuiTaskExecutors = opts.onGetLiveuiTaskExecutors || null;
  const onSetLiveuiTaskExecutor = opts.onSetLiveuiTaskExecutor || null;
  const onSetLiveuiTaskSettingValues = opts.onSetLiveuiTaskSettingValues || null;
  const onSetLiveuiTaskPreferredTemplate = opts.onSetLiveuiTaskPreferredTemplate || null;

  const isPhoneClient = typeof opts.isPhoneClient === "function"
    ? opts.isPhoneClient
    : () => false;
  const clientNameOf = typeof opts.clientNameOf === "function" ? opts.clientNameOf : () => null;
  const logSafe = (value     , max     ) =>
    typeof value === "string" && value ? value.replace(/[^A-Za-z0-9._:@/-]/g, "?").slice(0, max) : "";

  function admitPhoneOnlyWrite(clientId     , operation     ) {
    if (isPhoneClient(clientId) !== true) return false;
    let clientName = null;
    try {
      clientName = clientNameOf(clientId);
    } catch (_err     ) {
      clientName = null;
    }
    if (clientName !== APP_CLIENT_NAME) {
      logger.warn(
        `[downstream] phone-only write from non-app client name=${logSafe(clientName, 64) || "(none)"} operation=${logSafe(operation, 120) || "(unknown)"}`,
      );
    }
    return true;
  }
  const onReviewLiveuiTask = opts.onReviewLiveuiTask || null;
  const onSetLiveuiTaskContext = opts.onSetLiveuiTaskContext || null;
  const onGetLiveuiPrefs = opts.onGetLiveuiPrefs || null;
  const onSetLiveuiPrefs = opts.onSetLiveuiPrefs || null;
  const onGetLiveuiGrants = opts.onGetLiveuiGrants || null;
  const onSetLiveuiGrant = opts.onSetLiveuiGrant || null;
  const onGetLiveuiStatus = opts.onGetLiveuiStatus || null;
  const onOrganizeLiveuiLibrary = opts.onOrganizeLiveuiLibrary || null;
  const onGetCommandCatalog = opts.onGetCommandCatalog;
  const onGetAgentsCatalog = opts.onGetAgentsCatalog;
  const onCreateOpenClawAgent = opts.onCreateOpenClawAgent || null;
  const onCreateHermesProfile = opts.onCreateHermesProfile || null;
  const onHermesManagement = opts.onHermesManagement || null;

  const getManagementBackendLabel = opts.getManagementBackendLabel || null;
  const onBoardMomentAck = opts.onBoardMomentAck || null;
  const onBotScreenMessage = opts.onBotScreenMessage || null;
  const onTaskPushAck = opts.onTaskPushAck || null;
  const onGetTaskRows = opts.onGetTaskRows || null;
  const onSetTaskLook = opts.onSetTaskLook || null;
  const onActTaskReminder = opts.onActTaskReminder || null;
  const onTaskSheet = opts.onTaskSheet || null;
  const onWaitingAnswer = opts.onWaitingAnswer || null;
  const onSetAgentEmoji = opts.onSetAgentEmoji || null;
  const onRouteAgent = opts.onRouteAgent || null;
  const onAgentDescription = opts.onAgentDescription || null;
  const onGetAgentSettings = opts.onGetAgentSettings || null;
  const onSetAgentSettings = opts.onSetAgentSettings || null;
  const onGetHostDefaults = opts.onGetHostDefaults || null;
  const onSetHostDefaults = opts.onSetHostDefaults || null;
  const onGetSonioxModels = opts.onGetSonioxModels || null;
  const onGetHermesSttCapabilities = opts.onGetHermesSttCapabilities || null;
  const onHermesSttTranscribe = opts.onHermesSttTranscribe || null;
  const hermesSttUpload = opts.hermesSttUpload || null;

  const realtimeTalkLane = opts.realtimeTalkLane || null;
  const realtimeTalkHandlers = createRealtimeTalkDownstreamHandlers({ lane: realtimeTalkLane, isPhoneClient });
  const ttsHandlers = createTtsDownstreamHandlers({ lane: opts.ttsLane || null });
  const offlineTtsHandlers = createTtsDownstreamHandlers({ lane: null });

  if (hermesSttUpload && typeof opts.unicast === "function") {
    hermesSttUpload.setPartialSink?.((clientId     , frame     ) =>
      opts.unicast(clientId, JSON.stringify(frame)));
  }
  const onGetProviderUsageSnapshot = opts.onGetProviderUsageSnapshot || null;
  const onGetSessionModelConfig = opts.onGetSessionModelConfig;
  const onSetSessionModelConfig = opts.onSetSessionModelConfig;
  const onSetSessionAgent = opts.onSetSessionAgent;
  const onCompactSession = opts.onCompactSession || null;
  const onGetEvenAiSettings = opts.onGetEvenAiSettings;
  const onGetEvenAiSessions = opts.onGetEvenAiSessions;
  const onSetEvenAiSettings = opts.onSetEvenAiSettings;
  const onGetOcuClawSettings = opts.onGetOcuClawSettings;
  const onSetOcuClawSettings = opts.onSetOcuClawSettings;
  const onGetSavedPrompts      = opts.onGetSavedPrompts || null;
  const onWriteSavedPrompts      = opts.onWriteSavedPrompts || null;
  const onRequestSonioxTemporaryKey = opts.onRequestSonioxTemporaryKey || null;
  const onRequestCartesiaAccessToken = opts.onRequestCartesiaAccessToken || null;
  const onGetStatus = opts.onGetStatus || null;
  const isUpstreamConnected = opts.isUpstreamConnected;
  const onConsoleLog = opts.onConsoleLog || null;
  const onApprovalResolve = opts.onApprovalResolve || null;
  const onDebugSet = opts.onDebugSet || null;
  const onDebugDump = opts.onDebugDump || null;
  const onEventDebug = opts.onEventDebug || null;
  const onTraceLogSet = opts.onTraceLogSet || null;
  const onTraceLogGet = opts.onTraceLogGet || null;
  const onRemoteControl = opts.onRemoteControl || null;
  const onAutomationState = opts.onAutomationState || null;
  const onAutomationRegistry = opts.onAutomationRegistry || null;
  const onLedgerCursor = opts.onLedgerCursor || null;
  const onResyncRequest = opts.onResyncRequest || null;
  const onReadinessProbe = opts.onReadinessProbe || null;
  const onGlassesUiResult = opts.onGlassesUiResult || null;
  const onDemandResponse = opts.onDemandResponse || null;
  const onGlassesUiRenderInject = opts.onGlassesUiRenderInject || null;
  const resolveLiveUiSessionContext =
    typeof opts.resolveLiveUiSessionContext === "function"
      ? opts.resolveLiveUiSessionContext
      : null;
  const getGlassesUiLiveConfig = typeof opts.getGlassesUiLiveConfig === "function"
    ? opts.getGlassesUiLiveConfig
    : null;

  const getLiveuiHostCheck = typeof opts.getLiveuiHostCheck === "function"
    ? opts.getLiveuiHostCheck
    : null;
  const onGlassesUiSurfaceUpdateInject = opts.onGlassesUiSurfaceUpdateInject || null;
  const onGlassesUiNavEvent = opts.onGlassesUiNavEvent || null;

  const onGlassesUiRenderReceipt = opts.onGlassesUiRenderReceipt || null;

  const onReplyRenderReceipt = opts.onReplyRenderReceipt || null;

  const onLiveUiPictureWant = opts.onLiveUiPictureWant || null;

  const onLiveUiVideoWant = opts.onLiveUiVideoWant || null;
  const onGlassesUiRenderError = opts.onGlassesUiRenderError || null;

  const onLiveUiStateReport = opts.onLiveUiStateReport || null;
  const onDeviceInfoResponse = opts.onDeviceInfoResponse || null;
  const onGlassesPresenceChanged = opts.onGlassesPresenceChanged || null;
  const onProgramCardFeeds = opts.onProgramCardFeeds || null;

  const onProgramCardPictures = opts.onProgramCardPictures || null;
  const onProgramCardJev = opts.onProgramCardJev || null;
  const onProgramCardMcp = opts.onProgramCardMcp || null;
  const onProgramCardModel = opts.onProgramCardModel || null;
  const onProgramCardArt = opts.onProgramCardArt || null;

  const onProgramCardLocation = opts.onProgramCardLocation || null;
  const onLocationResponse = opts.onLocationResponse || null;
  const onProgramCardResponse = opts.onProgramCardResponse || null;
  const onProgramCardLookProgress = opts.onProgramCardLookProgress || null;
  const onProgramCardContext = opts.onProgramCardContext || null;
  const onSetUserSessionTitle = opts.onSetUserSessionTitle || null;
  const onSetSessionPinned = opts.onSetSessionPinned || null;
  const onSetSessionHidden = opts.onSetSessionHidden || null;
  const onMarkAllSessionsRead = opts.onMarkAllSessionsRead || null;
  const onDeleteSessions = opts.onDeleteSessions || null;
  const onSearchTranscripts = opts.onSearchTranscripts || null;
  const onDebugBundleRequest = opts.onDebugBundleRequest || null;
  const onDebugBundleClientEvents = opts.onDebugBundleClientEvents || null;
  const onDebugBundleSave = opts.onDebugBundleSave || null;
  const onDebugBundleFetch = opts.onDebugBundleFetch || null;
  const getSnapshotRevision = opts.getSnapshotRevision || null;
  const operationRegistry = opts.operationRegistry || null;
  const defaultEvenAiDedicatedSessionKey =
    typeof opts.defaultEvenAiDedicatedSessionKey === "string" &&
    opts.defaultEvenAiDedicatedSessionKey.trim()
      ? opts.defaultEvenAiDedicatedSessionKey.trim()
      : DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY;

  function resolveInjectedLiveUiSession(rawSessionKey     ) {
    const requestedSessionKey = parseOptionalTrimmedString(rawSessionKey) || null;
    if (!resolveLiveUiSessionContext) {
      return { sessionKey: requestedSessionKey, liveUiSessionGeneration: null };
    }
    const resolved = resolveLiveUiSessionContext(requestedSessionKey) || {};
    return {
      sessionKey: parseOptionalTrimmedString(resolved.sessionKey) || requestedSessionKey,
      liveUiSessionGeneration:
        parseOptionalTrimmedString(resolved.liveUiSessionGeneration) || null,
    };
  }

  const protocolSubscribers = new Set();
  const APPROVAL_DECISIONS = new Set([
    "allow-once",
    "allow-session",
    "allow-always",
    "deny",
  ]);
  const approvalResolveCacheTtlMs = Number.isFinite(opts.approvalResolveCacheTtlMs)
    ? Math.max(1_000, Math.floor(opts.approvalResolveCacheTtlMs))
    : 30_000;
  const approvalResolveCacheMaxEntries = Number.isFinite(opts.approvalResolveCacheMaxEntries)
    ? Math.max(10, Math.floor(opts.approvalResolveCacheMaxEntries))
    : 500;
  const EXTERNAL_DEBUG_TOOLS_DISABLED_ERROR =
    "external debug tools are disabled by plugin config";

  const approvalResolveCache = new Map();

  const { formatPages, formatStatus } = createSnapshotFormatters({ getSnapshotRevision });
  const { formatEvenAiSessions } = createEvenAiSessionsFormatter({ defaultEvenAiDedicatedSessionKey });
  const { formatApproval } = createApprovalFormatter({ approvalPurposeEnabled });
  const { formatHermesSttCapabilities } = createHermesSttCapabilitiesFormatter({ hermesSttUpload });

  function isExternalDebugToolMessageType(messageType) {
    return (
      messageType === "debug-set" ||
      messageType === "debug-dump" ||
      messageType === "trace-log-set" ||
      messageType === "trace-log-get" ||
      messageType === "remote-control" ||
      messageType === APP_PROTOCOL.automationStateGet ||
      messageType === APP_PROTOCOL.automationRegistryGet ||
      messageType === APP_PROTOCOL.readinessProbeRequest ||
      messageType === "glasses_ui_render" ||
      messageType === "glasses_ui_surface_update" ||
      messageType === "simulate" ||
      messageType === "simulateStream" ||
      messageType === "simulateStreamCancel" ||
      messageType === "simulateActivity" ||
      messageType === "simulateTool" ||
      messageType === "simulateThinking" ||
      messageType === "simulateRunSignal" ||
      messageType === "simulateApproval" ||
      messageType === "simulateDemand" ||
      messageType === "simulateVoice" ||
      messageType === "simulateModelCatalog" ||
      messageType === "simulateSessionList"
    );
  }

  function isRetiredEvenTerminalSessionKey(key) {
    return typeof key === "string" && key.trim().toLowerCase().startsWith("et:");
  }

  function parseTraceLogSet(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("trace-log-set requires an object");
    }
    if (typeof msg.enabled !== "boolean") {
      throw new Error("trace-log-set requires boolean 'enabled'");
    }
    return { enabled: msg.enabled };
  }

  function normalizeCategories(raw, fieldName) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      throw new Error(`${fieldName} must be an array`);
    }
    const dedup = new Set();
    for (const entry of raw) {
      if (typeof entry !== "string") {
        throw new Error(`${fieldName} entries must be strings`);
      }
      const cat = entry.trim();
      if (!cat) {
        throw new Error(`${fieldName} entries must be non-empty strings`);
      }
      dedup.add(cat);
    }
    return Array.from(dedup.values());
  }

  function parseDebugSet(msg) {
    const hasEnableDisable = msg.enable !== undefined || msg.disable !== undefined;
    const enable = hasEnableDisable
      ? normalizeCategories(msg.enable, "enable")
      : msg.enabled === false
        ? []
        : normalizeCategories(msg.categories, "categories");
    const disable = hasEnableDisable
      ? normalizeCategories(msg.disable, "disable")
      : msg.enabled === false
        ? normalizeCategories(msg.categories, "categories")
        : [];
    if (enable.length === 0 && disable.length === 0) {
      throw new Error("debug-set requires categories to enable and/or disable");
    }
    if (
      msg.ttlMs !== undefined &&
      (!Number.isFinite(Number(msg.ttlMs)) || Number(msg.ttlMs) <= 0)
    ) {
      throw new Error("debug-set ttlMs must be a positive number");
    }
    return {
      enable,
      disable,
      ttlMs: msg.ttlMs === undefined ? undefined : Number(msg.ttlMs),
    };
  }

  function parseDebugDump(msg) {
    const categories = normalizeCategories(msg.categories, "categories");
    if (
      msg.limit !== undefined &&
      (!Number.isFinite(Number(msg.limit)) || Number(msg.limit) <= 0)
    ) {
      throw new Error("debug-dump limit must be a positive number");
    }
    if (
      msg.sinceMs !== undefined &&
      (!Number.isFinite(Number(msg.sinceMs)) || Number(msg.sinceMs) < 0)
    ) {
      throw new Error("debug-dump sinceMs must be a non-negative number");
    }
    if (
      msg.sinceAgeMs !== undefined &&
      (!Number.isFinite(Number(msg.sinceAgeMs)) || Number(msg.sinceAgeMs) < 0)
    ) {
      throw new Error("debug-dump sinceAgeMs must be a non-negative number");
    }
    if (
      msg.untilMs !== undefined &&
      (!Number.isFinite(Number(msg.untilMs)) || Number(msg.untilMs) < 0)
    ) {
      throw new Error("debug-dump untilMs must be a non-negative number");
    }
    return {
      categories,
      limit: msg.limit === undefined ? undefined : Number(msg.limit),
      sinceMs: msg.sinceMs === undefined ? undefined : Number(msg.sinceMs),
      sinceAgeMs: msg.sinceAgeMs === undefined ? undefined : Number(msg.sinceAgeMs),
      untilMs: msg.untilMs === undefined ? undefined : Number(msg.untilMs),
    };
  }

  function parseApprovalResponsePayload(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("ocuclaw.approval.resolve payload must be an object");
    }
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      throw new Error("ocuclaw.approval.resolve id is required");
    }
    const decisionRaw = parseOptionalTrimmedString(msg.decision);
    if (!decisionRaw) {
      throw new Error("ocuclaw.approval.resolve decision is required");
    }
    const decision = decisionRaw.toLowerCase();
    if (!APPROVAL_DECISIONS.has(decision)) {
      throw new Error(
        "ocuclaw.approval.resolve decision must be allow-once|allow-session|allow-always|deny",
      );
    }
    return {
      id,
      decision,
      requestId: parseOptionalTrimmedString(msg.requestId) || null,
      reason: (parseOptionalTrimmedString(msg.reason) || "").slice(0, 500) || null,
    };
  }

  function pruneApprovalResolveCache(nowMs) {
    for (const [key, entry] of approvalResolveCache) {
      if (!entry || entry.expiresAtMs <= nowMs) {
        approvalResolveCache.delete(key);
      }
    }
    while (approvalResolveCache.size > approvalResolveCacheMaxEntries) {
      const oldest = approvalResolveCache.keys().next();
      if (oldest.done) break;
      approvalResolveCache.delete(oldest.value);
    }
  }

  function parseReadinessProbe(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("readiness probe payload must be an object");
    }
    const requestId = parseOptionalTrimmedString(msg.requestId);
    if (!requestId) {
      throw new Error("readiness probe requires requestId");
    }
    const sinceMs = parseOptionalNonNegativeNumber(msg.sinceMs, "sinceMs");
    if (sinceMs === undefined) {
      throw new Error("readiness probe sinceMs must be a non-negative number");
    }
    return {
      requestId,
      sinceMs,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
    };
  }

  function parseAutomationStateGet(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("automation state payload must be an object");
    }
    const requestId = parseOptionalTrimmedString(msg.requestId);
    if (!requestId) {
      throw new Error("automation state request requires requestId");
    }
    return {
      requestId,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
    };
  }

  const ATTACHMENT_MAX_DECODED_BYTES = 5_000_000;
  const ATTACHMENT_MAX_ENCODED_CHARS =
    Math.ceil((ATTACHMENT_MAX_DECODED_BYTES * 4) / 3) + 16;

  function stripDataUrlPrefix(value) {
    if (typeof value !== "string") return "";
    if (!value.startsWith("data:")) return value;
    const comma = value.indexOf(",");
    return comma >= 0 ? value.slice(comma + 1) : value;
  }

  function rejectAttachment(errorCode, error) {
    return {
      ok: false,
      errorCode,
      error,
    };
  }

  function parseAttachment(rawAttachment) {
    if (rawAttachment === undefined || rawAttachment === null) {
      return { ok: true, attachment: null };
    }
    if (typeof rawAttachment !== "object" || Array.isArray(rawAttachment)) {
      return rejectAttachment(
        "attachment_invalid_type",
        "attachment must be an object",
      );
    }

    const kind = parseOptionalTrimmedString(rawAttachment.kind) || "image";
    if (kind !== "image") {
      return rejectAttachment(
        "attachment_invalid_type",
        "unsupported attachment kind",
      );
    }

    const mimeTypeRaw = parseOptionalTrimmedString(rawAttachment.mimeType);
    const mimeType = mimeTypeRaw ? mimeTypeRaw.toLowerCase() : null;
    if (!mimeType || !mimeType.startsWith("image/")) {
      return rejectAttachment(
        "attachment_invalid_type",
        "attachment mimeType must be image/*",
      );
    }

    const base64Raw = parseOptionalTrimmedString(rawAttachment.base64Data);
    if (!base64Raw) {
      return rejectAttachment(
        "attachment_missing_data",
        "attachment base64Data is required",
      );
    }

    const base64Data = stripDataUrlPrefix(base64Raw).replace(/\s+/g, "");
    if (!base64Data) {
      return rejectAttachment(
        "attachment_missing_data",
        "attachment base64Data is required",
      );
    }

    if (base64Data.length > ATTACHMENT_MAX_ENCODED_CHARS) {
      return rejectAttachment(
        "attachment_too_large_encoded",
        `attachment payload exceeds encoded limit (${ATTACHMENT_MAX_ENCODED_CHARS} chars)`,
      );
    }

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) {
      return rejectAttachment(
        "attachment_decode_failed",
        "attachment base64Data is not valid base64",
      );
    }

    let decoded;
    try {
      decoded = Buffer.from(base64Data, "base64");
    } catch {
      return rejectAttachment(
        "attachment_decode_failed",
        "attachment base64Data decode failed",
      );
    }
    if (!decoded || decoded.length <= 0) {
      return rejectAttachment(
        "attachment_missing_data",
        "attachment decoded payload is empty",
      );
    }

    const canonical = decoded.toString("base64").replace(/=+$/g, "");
    const providedCanonical = base64Data.replace(/=+$/g, "");
    if (canonical !== providedCanonical) {
      return rejectAttachment(
        "attachment_decode_failed",
        "attachment base64Data decode failed",
      );
    }

    if (decoded.length > ATTACHMENT_MAX_DECODED_BYTES) {
      return rejectAttachment(
        "attachment_too_large",
        `attachment exceeds ${ATTACHMENT_MAX_DECODED_BYTES} byte decoded limit`,
      );
    }

    const sourceRaw = parseOptionalTrimmedString(rawAttachment.source);
    const sourceNormalized = sourceRaw ? sourceRaw.toLowerCase() : null;
    const source =
      sourceNormalized === "camera" || sourceNormalized === "gallery"
        ? sourceNormalized
        : null;

    return {
      ok: true,
      attachment: {
        kind: "image",
        name: parseOptionalTrimmedString(rawAttachment.name) || "image.jpg",
        mimeType,
        base64Data,
        sizeBytes: decoded.length,
        widthPx: parseOptionalPositiveInt(rawAttachment.widthPx),
        heightPx: parseOptionalPositiveInt(rawAttachment.heightPx),
        source,
      },
    };
  }

  function parseClientDisplaySignals(raw) {
    if (raw == null || typeof raw !== "object") return null;
    const coerceState = (val) => {
      const s = typeof val === "string" ? val : null;
      return s === "active" || s === "recently-disabled" || s === "inactive"
        ? s
        : "inactive";
    };
    const state = coerceState(raw.neuralEmojiReactorState);
    const paceState = coerceState(raw.neuralPaceModulatorState);
    const speckState = coerceState(raw.neuralSpeckReactorState);
    const enabledRaw = raw.neuralSessionNamesEnabled;
    const neuralSessionNamesEnabled =
      typeof enabledRaw === "boolean" ? enabledRaw : true;
    const naturalTextFlowEnabled = raw.naturalTextFlowEnabled === true;

    const replyLanguage = normalizeReplyLanguageTag(raw.replyLanguage);

    return {
      neuralEmojiReactorState: state,
      neuralPaceModulatorState: paceState,
      neuralSpeckReactorState: speckState,
      neuralSessionNamesEnabled,
      naturalTextFlowEnabled,
      ...(replyLanguage ? { replyLanguage } : {}),
    };
  }

  function parseSendOrigin(raw         )                             {
    return raw === "phone" || raw === "glasses" ? raw : null;
  }

  function handleSend(clientId, msg) {
    const requestId = parseOptionalTrimmedString(msg.requestId);
    if (!requestId) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "Missing required field: requestId",
        ),
      };
    }

    const parsedAttachment      = parseAttachment(msg.attachment);
    if (!parsedAttachment.ok) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          parsedAttachment.error,
          parsedAttachment.errorCode,
        ),
      };
    }
    const attachment = parsedAttachment.attachment || null;

    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text.trim() && !attachment) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "Missing required field: text",
        ),
      };
    }

    if (isForeignHermesSessionKey(msg.sessionKey)) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "Foreign sessions are read-only; copy to OcuClaw before sending.",
          "unsupported_session_key",
          undefined,
        ),
      };
    }

    if (isRetiredEvenTerminalSessionKey(msg.sessionKey)) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "Even Terminal sessions are no longer supported.",
          "unsupported_session_key",
          undefined,
        ),
      };
    }

    if (!isUpstreamConnected()) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          `${activeBackendDisplayName()} disconnected`,
        ),
      };
    }

    const operation =
      operationRegistry && typeof operationRegistry.beginMessageSend === "function"
        ? operationRegistry.beginMessageSend({
            requestId,
            clientId,
            sessionKey: msg.sessionKey || null,
          })
        : null;

    if (operation && operation.duplicate) {
      const frames = operation.finalFrame
        ? [operation.receipt, operation.finalFrame]
        : [operation.receipt];
      return { unicast: frames };
    }

    const clientDisplaySignals = parseClientDisplaySignals(msg.clientDisplaySignals);

    const followup = onSend(
      requestId,
      text,
      msg.sessionKey || null,
      attachment,
      clientDisplaySignals,
      typeof opts.isPhoneClient === "function" && opts.isPhoneClient(clientId) === true,
      clientId,
      parseSendOrigin(msg.origin),

      cardBuildTaskSendOf(msg.taskBuild),

      cardChangeSendOf(msg.cardChange),

      cardCheckSendOf(msg.cardCheck),
    ).then(
      (result     ) => {
        const status = (result && result.status) || "accepted";
        const frame = formatSendAckCompat(
          requestId,
          status,
          undefined,
          undefined,
          { runId: result && result.runId },
        );
        if (operation && typeof operation.complete === "function") {
          operation.complete(frame, {
            status,
            runId: result && result.runId ? result.runId : null,
          });
        }
        return { unicast: frame };
      },
      (err     ) => {
        const frame = formatSendAckCompat(
          requestId,
          "rejected",
          err.message || "Send failed",
          err.errorCode || err.code || undefined,
        );
        if (operation && typeof operation.fail === "function") {
          operation.fail(frame, {
            errorCode: err.errorCode || err.code || null,
            message: err.message || "Send failed",
          });
        }
        return { unicast: frame };
      },
    );

    return operation
      ? {
          unicast: operation.receipt || formatOperationReceived({
            requestId,
            operation: "message.send",
          }),
          followup,
        }
      : followup;
  }

  function handleLedgerSync(
    msg      = {},
    callback      = () => null,
  ) {
    const sessionId = parseOptionalTrimmedString(msg.sessionId);
    if (!sessionId || typeof callback !== "function") return null;
    try {
      const payload      = {
        sessionId,
        lastSeq: parseOptionalInteger(msg.lastSeq),
        entriesRevision: parseOptionalInteger(msg.entriesRevision),
        digest: parseOptionalInteger(msg.digest),
        fromSeq: parseOptionalInteger(msg.fromSeq),
      };

      if (msg.quiet === true) payload.quiet = true;
      const result = callback(payload);
      return result ? { unicast: formatEntries(result, sessionId) } : null;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[downstream] ledger sync handler threw: ${detail}`,
      );
      return null;
    }
  }

  function handleAbortSession(
    clientId,
    msg,
  ) {
    const requestId = parseOptionalTrimmedString(msg.requestId);
    if (!requestId) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          status: "rejected",
          error: "Missing required field: requestId",
        }),
      };
    }
    const sessionKey = parseOptionalTrimmedString(msg.sessionKey);
    if (!sessionKey) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          status: "rejected",
          error: "Missing required field: sessionKey",
        }),
      };
    }
    if (isRetiredEvenTerminalSessionKey(sessionKey)) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          sessionKey,
          status: "rejected",
          error: "Even Terminal sessions are no longer supported.",
          errorCode: "unsupported_session_key",
        }),
      };
    }

    if (isForeignHermesSessionKey(sessionKey)) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          sessionKey,
          status: "rejected",
          error: "Foreign sessions are read-only; nothing to stop here.",
          errorCode: "unsupported_session_key",
        }),
      };
    }

    if (!onAbortSession) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          sessionKey,
          status: "rejected",
          error: "session abort is not available",
        }),
      };
    }
    if (!isUpstreamConnected()) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          sessionKey,
          status: "rejected",
          error: `${activeBackendDisplayName()} disconnected`,
        }),
      };
    }
    return Promise.resolve().then(() => onAbortSession({ requestId, sessionKey })).then(
      (result) => ({
        unicast: formatSessionAbortAck({
          ...(result || { status: "accepted" }),
          requestId,
          sessionKey,
        }),
      }),
      (err) => ({
        unicast: formatSessionAbortAck({
          requestId,
          sessionKey,
          status: "rejected",
          error: err && err.message ? err.message : "session abort failed",
          errorCode: err && (err.errorCode || err.code) ? (err.errorCode || err.code) : undefined,
        }),
      }),
    );
  }

  function handleSteerSession(clientId, msg) {
    const requestId = parseOptionalTrimmedString(msg.requestId);
    if (!requestId) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "Missing required field: requestId",
        ),
      };
    }
    const sessionKey = parseOptionalTrimmedString(msg.sessionKey);
    if (!sessionKey) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "Missing required field: sessionKey",
        ),
      };
    }
    if (isForeignHermesSessionKey(sessionKey)) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "Foreign sessions are read-only; copy to OcuClaw before sending.",
          "unsupported_session_key",
          undefined,
        ),
      };
    }
    const parsedAttachment = parseAttachment(msg.attachment);
    if (!parsedAttachment.ok) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          parsedAttachment.error,
          parsedAttachment.errorCode,
        ),
      };
    }
    const message = typeof msg.message === "string" ? msg.message : "";
    if (!message.trim() && !parsedAttachment.attachment) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "Missing required field: message",
        ),
      };
    }
    if (!onSteerSession) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          "session steer is not available",
        ),
      };
    }
    if (!isUpstreamConnected()) {
      return {
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          `${activeBackendDisplayName()} disconnected`,
        ),
      };
    }
    return Promise.resolve(onSteerSession({
      requestId,
      sessionKey,
      message,
      attachment: parsedAttachment.attachment,
      wearerOrigin: isPhoneClient(clientId) === true,
      origin: parseSendOrigin(msg.origin),
    })).then(
      (result) => ({
        unicast: formatSendAckCompat(
          requestId,
          (result && result.status) || "accepted",
          undefined,
          undefined,
          { runId: result && result.runId },
        ),
      }),
      (err) => ({
        unicast: formatSendAckCompat(
          requestId,
          "rejected",
          err && err.message ? err.message : "session steer failed",
          err && (err.errorCode || err.code) ? (err.errorCode || err.code) : undefined,
        ),
      }),
    );
  }

  const {
    handleSimulate,
    handleSimulateStream,
    handleSimulateStreamCancel,
    handleSimulateActivity,
    handleSimulateModelCatalog,
    handleSimulateSessionList,
    handleSimulateTool,
    handleSimulateThinking,
    handleSimulateRunSignal,
    handleSimulateApproval,
    handleSimulateDemand,
    handleSimulateVoice,
    handleGlassesUiSurfaceUpdateInject,
  } = createSimulateHandlers({
    formatPages,
    resolveInjectedLiveUiSession,
    onSimulate,
    onSimulateStream,
    onSimulateStreamCancel,
    onSimulateActivity,
    onSimulateThinking,
    onSimulateRunSignal,
    onSimulateModelCatalog,
    onSimulateSessionList,
    onSimulateTool,
    onSimulateApproval,
    onSimulateDemand,
    onSimulateVoice,
    onGlassesUiSurfaceUpdateInject,
  });

  function handleSubscribeProtocol(clientId) {
    protocolSubscribers.add(clientId);
    return null;
  }

  function handleApprovalResponse(clientId, msg) {
    let payload;
    try {
      payload = parseApprovalResponsePayload(msg);
    } catch (err) {
      return {
        unicast: formatApprovalResponseAck({
          id: parseOptionalTrimmedString(msg && msg.id) || null,
          decision: parseOptionalTrimmedString(msg && msg.decision) || null,
          requestId: parseOptionalTrimmedString(msg && msg.requestId) || null,
          status: "rejected",
          code: "invalid_approval_response",
          message:
            err && err.message
              ? err.message
              : "Invalid ocuclaw.approval.resolve payload",
          idempotent: false,
        }),
      };
    }

    if (!onApprovalResolve) {
      return {
        unicast: formatApprovalResponseAck({
          id: payload.id,
          decision: payload.decision,
          requestId: payload.requestId,
          status: "rejected",
          code: "approval_unavailable",
          message: "approval resolution is not available",
          idempotent: false,
        }),
      };
    }

    const nowMs = Date.now();
    pruneApprovalResolveCache(nowMs);
    const idempotencyScope = payload.requestId || `client:${clientId}`;
    const cacheKey = `${payload.id}|${payload.decision}|${idempotencyScope}`;
    const existing = approvalResolveCache.get(cacheKey);
    if (existing && existing.expiresAtMs > nowMs) {
      existing.expiresAtMs = nowMs + approvalResolveCacheTtlMs;
      return existing.promise.then((ack) => ({
        unicast: formatApprovalResponseAck({
          ...ack,
          idempotent: true,
          code:
            ack && ack.status === "accepted"
              ? "duplicate_request"
              : ack && ack.code
                ? ack.code
                : "duplicate_request",
        }),
      }));
    }

    const promise = Promise.resolve(
      onApprovalResolve(
        payload.id,
        payload.decision,
        { requestId: payload.requestId, clientId, reason: payload.reason },
      ),
    ).then(
      () => ({
        id: payload.id,
        decision: payload.decision,
        requestId: payload.requestId,
        status: "accepted",
        code: "ok",
        message: null,
        idempotent: false,
      }),
      (err) => {
        const message =
          err && err.message ? err.message : "approvalResolve failed";
        logger.error(`[downstream] approvalResolve failed: ${message}`);
        return {
          id: payload.id,
          decision: payload.decision,
          requestId: payload.requestId,
          status: "rejected",
          code: "approval_resolve_failed",
          message,
          idempotent: false,
        };
      },
    );

    const cacheEntry = {
      expiresAtMs: nowMs + approvalResolveCacheTtlMs,
      promise,
    };
    approvalResolveCache.set(cacheKey, cacheEntry);
    pruneApprovalResolveCache(nowMs);

    return promise.then((ack) => {
      if (ack && ack.status === "accepted") {
        cacheEntry.expiresAtMs = Date.now() + approvalResolveCacheTtlMs;
      } else {
        approvalResolveCache.delete(cacheKey);
      }
      return { unicast: formatApprovalResponseAck(ack) };
    });
  }

  function handleInputStarted(clientId     , msg     ) {
    if (!onInputStarted) return null;
    try {
      onInputStarted(clientId, {
        source: typeof msg.source === "string" ? msg.source : "",
        sessionKey: typeof msg.sessionKey === "string" && msg.sessionKey ? msg.sessionKey : null,
      });
    } catch (err     ) {
      logger.warn(`[downstream] input started handler threw: ${err && err.message ? err.message : err}`);
    }
    return null;
  }

  function handleInputPrediction(clientId     , op     , msg     ) {
    const payload = msg && typeof msg === "object" ? msg : {};
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";

    const testRequestId = /^[A-Za-z0-9._:@/-]{1,128}$/.test(requestId) ? requestId : "";
    const resultType =
      op === "capabilities"
        ? APP_PROTOCOL.inputPredictionCapabilitiesResult
        : op === "test"
          ? APP_PROTOCOL.inputPredictionTestResult
          : op === "cancel"
            ? `${APP_PROTOCOL.inputPredictionCancel}.ack`
            : op === "open"
              ? APP_PROTOCOL.inputPredictionOpenResult
              : op === "modelAllow"
                ? APP_PROTOCOL.inputPredictionModelAllowResult
                : APP_PROTOCOL.inputPredictionResult;

    const modelAllowFailure = (status     ) => ({
      requestId: testRequestId,
      status,
      activation: { required: false, mode: "none" },
    });

    const noIdentity = { agentId: "", profileId: "", sessionKey: "" };
    const frame = (body     ) => ({
      unicast: JSON.stringify({
        type: resultType,
        ...(op === "cancel" || op === "modelAllow" ? {} : noIdentity),
        ...body,
      }),
    });
    if (!onInputPrediction) {
      if (op === "capabilities") {
        return frame({
          protocolVersion: 1,
          supported: false,
          unsupportedReason: "input prediction service not wired on this host",
          structuredOutput: false,
          abort: false,
          policyRevision: "",
          limits: null,
          models: [],
          connectionDefault: null,
        });
      }
      if (op === "cancel") return frame({ requestId, accepted: false, abort: false });
      if (op === "modelAllow") return frame(modelAllowFailure("error"));

      if (op === "open") {
        return frame({ requestId, status: "unavailable", replies: [], words: [], provider: "", model: "", elapsedMs: 0, usage: null, reason: "input prediction service not wired on this host" });
      }
      return frame({ requestId: op === "test" ? testRequestId : requestId, status: "unavailable", candidates: [], provider: "", model: "", elapsedMs: 0, usage: null, reason: "input prediction service not wired on this host" });
    }

    const { type: _type, ...rest } = payload;
    return Promise.resolve(onInputPrediction(clientId, op, rest)).then(
      (result) => frame(result && typeof result === "object" ? result : {}),
      (err) => {
        logger.error(`[downstream] input prediction ${op} failed: ${err && err.message ? err.message : err}`);
        if (op === "capabilities") {
          return frame({ protocolVersion: 1, supported: false, unsupportedReason: "input prediction failed", structuredOutput: false, abort: false, policyRevision: "", limits: null, models: [], connectionDefault: null });
        }
        if (op === "cancel") return frame({ requestId, accepted: false, abort: false });
        if (op === "modelAllow") return frame(modelAllowFailure("error"));
        if (op === "open") {
          return frame({ requestId, status: "error", replies: [], words: [], provider: "", model: "", elapsedMs: 0, usage: null, reason: "input prediction failed" });
        }
        return frame({ requestId: op === "test" ? testRequestId : requestId, status: "error", candidates: [], provider: "", model: "", elapsedMs: 0, usage: null, reason: "input prediction failed" });
      },
    );
  }

  function handleGetModelsCatalog(clientId) {
    if (!onGetModelsCatalog) {
      return {
        unicast: formatModelsCatalog({
          models: [],
          fetchedAtMs: Date.now(),
          stale: true,
        }),
      };
    }
    return Promise.resolve(onGetModelsCatalog()).then(
      (payload) => ({
        unicast: formatModelsCatalog(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getModelsCatalog failed: ${err.message}`);
        return {
          unicast: formatModelsCatalog({
            models: [],
            fetchedAtMs: Date.now(),
            stale: true,
          }),
        };
      },
    );
  }

  function handleGetSkillsCatalog(clientId) {
    if (!onGetSkillsCatalog) {
      return {
        unicast: formatSkillsCatalog({
          skills: [],
          fetchedAtMs: Date.now(),
          stale: true,
        }),
      };
    }
    return Promise.resolve(onGetSkillsCatalog()).then(
      (payload) => ({
        unicast: formatSkillsCatalog(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getSkills failed: ${err.message}`);
        return {
          unicast: formatSkillsCatalog({
            skills: [],
            fetchedAtMs: Date.now(),
            stale: true,
          }),
        };
      },
    );
  }

  function handleGetStarMap(clientId     ) {
    if (!onGetStarMap) {
      return {
        unicast: formatStarMapSnapshot({ status: "unsupported", errorCode: "unsupported" }),
      };
    }
    return Promise.resolve()
      .then(() => onGetStarMap(clientId))
      .then(
        (payload     ) => ({ unicast: formatStarMapSnapshot(payload || {}) }),
        (err     ) => {
          logger.error(`[downstream] starmap.get failed: ${err && err.message ? err.message : err}`);
          return {
            unicast: formatStarMapSnapshot({ status: "error", errorCode: "starmap_failed" }),
          };
        },
      );
  }

  function handleForgetStar(clientId     , msg     ) {
    const echo = {
      requestId: msg && typeof msg.requestId === "string" ? msg.requestId : "",
      id: msg && typeof msg.id === "string" ? msg.id : "",
    };
    if (!onForgetStar) {
      return {
        unicast: formatStarMapForgotten({ ...echo, status: "unsupported", errorCode: "unsupported" }),
      };
    }
    const request = parseStarMapForgetRequest(msg);
    if (!request) {
      return {
        unicast: formatStarMapForgotten({ ...echo, status: "refused", errorCode: "bad_request" }),
      };
    }
    const answer = { requestId: request.requestId, id: request.id };

    if (!admitPhoneOnlyWrite(clientId, msg.type)) {
      return { unicast: formatStarMapForgotten({ ...answer, status: "refused", errorCode: "phone_only" }) };
    }
    return Promise.resolve()
      .then(() => onForgetStar(clientId, request))
      .then(
        (payload     ) => ({
          unicast: formatStarMapForgotten({ ...(payload && typeof payload === "object" ? payload : {}), ...answer }),
        }),
        (err     ) => {
          logger.error(`[downstream] starmap.forget failed: ${err && err.message ? err.message : err}`);
          return {
            unicast: formatStarMapForgotten({ ...answer, status: "error", errorCode: "forget_failed" }),
          };
        },
      );
  }

  const {
    handleGetLiveuiLibrary,
    handleOpenLiveuiLibraryItem,
    handleSaveProgramCard,
    handleCheckpointProgramCard,
    handleGetProgramCardSource,
    handleGetProgramCardRevisions,
    handleProgramCardRevision,
    handleProgramCardReview,
    handleProgramCardReviewLookStep,
    handleProgramCardRevisionPicture,
    handleGetProgramCardSlots,
    handleProgramCardSlot,
    handleProgramCardReviewApply,
    handleCancelLiveuiTaskLaunch,
    handleGetLiveuiTasksForPhone,
    handleGetLiveuiTaskRunsForPhone,
    handleReviewLiveuiTask,
    handleGetLiveuiTaskExecutors,
    handleSetLiveuiTaskExecutor,
    handleSetLiveuiTaskPreferredTemplate,
    handleSetLiveuiTaskContext,
    handleGetLiveuiPrefs,
    handleSetLiveuiPrefs,
    handleGetLiveuiGrants,
    handleSetLiveuiGrant,
    handleGetLiveuiStatus,
    handleSetLiveuiTaskSettingValues,
    handleOrganizeLiveuiLibrary,
    handleLiveuiVideoRoute,
  } = createLiveuiHandlers({
    logger,
    isPhoneClient,
    admitPhoneOnlyWrite,
    onGetLiveuiLibrary,
    onOpenLiveuiLibraryItem,
    onCancelLiveuiTaskLaunch,
    onGetLiveuiTasksForPhone,
    onGetLiveuiTaskRunsForPhone,
    onGetLiveuiTaskExecutors,
    onSetLiveuiTaskExecutor,
    onSetLiveuiTaskSettingValues,
    onSetLiveuiTaskPreferredTemplate,
    onReviewLiveuiTask,
    onSetLiveuiTaskContext,
    onGetLiveuiPrefs,
    onSetLiveuiPrefs,
    onGetLiveuiGrants,
    onSetLiveuiGrant,
    onGetLiveuiStatus,
    onOrganizeLiveuiLibrary,
    onLiveuiVideoRoute: opts.onLiveuiVideoRoute || null,
    onSaveProgramCard,
    onCheckpointProgramCard,
    onOpenProgramCard,
    onGetProgramCardSource,
    onGetProgramCardRevisions,
    onProgramCardRevision,
    onProgramCardReview,
    onProgramCardReviewApply,
    onProgramCardRevisionPicture,
    onGetProgramCardSlots,
    onProgramCardSlot,
  });

  function handleGetCommandCatalog(clientId) {
    if (!onGetCommandCatalog) {
      return {
        unicast: formatCommandCatalog({
          commands: [],
          fetchedAtMs: Date.now(),
          stale: true,
          unsupported: true,
          backendKind: "none",
          executes: "intercepted-only",
        }),
      };
    }
    return Promise.resolve(onGetCommandCatalog()).then(
      (payload) => ({
        unicast: formatCommandCatalog(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getCommands failed: ${err.message}`);
        return {
          unicast: formatCommandCatalog({
            commands: [],
            fetchedAtMs: Date.now(),
            stale: true,
            unsupported: false,
            backendKind: "none",
            executes: "intercepted-only",
          }),
        };
      },
    );
  }

  function handleGetAgentsCatalog(clientId, msg      = {}) {
    if (!onGetAgentsCatalog) {
      return {
        unicast: formatAgentsCatalog({
          agents: [],
          fetchedAtMs: Date.now(),
          stale: true,
          unsupported: true,
        }),
      };
    }
    return Promise.resolve(onGetAgentsCatalog({ forceRefresh: msg.forceRefresh === true })).then(
      (payload) => ({
        unicast: formatAgentsCatalog(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getAgentsCatalog failed: ${err.message}`);
        return {
          unicast: formatAgentsCatalog({
            agents: [],
            fetchedAtMs: Date.now(),
            stale: true,
          }),
        };
      },
    );
  }

  function normalizeAgentCreateRequest(msg     ) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId.trim() : "";
    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    if (!requestId) return { errorCode: "missing_request_id", errorMessage: "Missing request id." };
    if (!name) return { requestId, errorCode: "invalid_name", errorMessage: "Enter a name." };
    if (name.length > 64 || /[\u0000\r\n]/.test(name)) {
      return {
        requestId,
        errorCode: "invalid_name",
        errorMessage: "Use one line with 64 characters or fewer.",
      };
    }
    return { requestId, name, ...(msg.setup != null ? { setup: msg.setup } : {}) };
  }

  function handleAgentCreate(clientId     , msg     , options     ) {
    const parsed      = normalizeAgentCreateRequest(msg);
    const requestId = parsed.requestId || "";
    const resultType = options.resultType;
    const failure = (err     ) => ({
      unicast: formatAgentCreateResult(resultType, requestId, {
        status: "error",
        errorCode:
          err && typeof err.code === "string" && err.code ? err.code : "create_failed",
        errorMessage: err && err.message ? err.message : options.failureMessage,
        ...(err && err.retryable === true ? { retryable: true } : {}),
      }),
    });
    if (parsed.errorCode) {
      return {
        unicast: formatAgentCreateResult(resultType, requestId, {
          status: "error",
          errorCode: parsed.errorCode,
          errorMessage: parsed.errorMessage,
        }),
      };
    }
    if (!admitPhoneOnlyWrite(clientId, msg?.type)) {
      return failure(Object.assign(new Error("Agent creation is phone-only."), { code: "phone_only" }));
    }
    if (typeof options.handler !== "function") {
      return failure(Object.assign(new Error(options.unavailableMessage), { code: "unsupported" }));
    }
    return Promise.resolve().then(() => options.handler({ name: parsed.name,
      ...(parsed.setup != null ? { setup: parsed.setup, requestId } : {}),
    })).then(
      (payload     ) => ({
        unicast: formatAgentCreateResult(resultType, requestId, payload || {}),
      }),
      failure,
    ).catch(failure);
  }

  function handleCreateOpenClawAgent(clientId     , msg     ) {
    return handleAgentCreate(clientId, msg, {
      handler: onCreateOpenClawAgent,
      resultType: APP_PROTOCOL.openclawAgentCreateResult,
      unavailableMessage: "OpenClaw agent creation is not available.",
      failureMessage: "OpenClaw could not create the agent.",
    });
  }

  const {
    handleHermesManagement,
    handleBoardMomentAck,
    handleBotScreen,
    handleTaskPushAck,
    handleTaskRowsGet,
    handleTaskLookSet,
    handleTaskReminder,
    handleTaskSheet,
    handleTaskProposal,
    handleAgentDraft,
    handleTaskWords,
    handleTaskPage,
    handleTaskTest,
    handleCreateHermesProfile,
    handleWaitingAnswer,
  } = createHermesHandlers({
    logger,
    isPhoneClient,
    admitPhoneOnlyWrite,
    handleAgentCreate,
    onHermesManagement,
    getManagementBackendLabel,
    onBoardMomentAck,
    onBotScreenMessage,
    onTaskPushAck,
    onGetTaskRows,
    onSetTaskLook,
    onActTaskReminder,
    onTaskSheet,
    onTaskProposal: opts.onTaskProposal,
    onTaskTest: opts.onTaskTest,
    onAgentDraft: opts.onAgentDraft,
    onTaskWords: opts.onTaskWords,
    onGetLiveuiTasksForPhone,
    onGetLiveuiLibrary,
    onCreateHermesProfile,
    onWaitingAnswer,
  });

  function handleSetAgentEmoji(clientId     , msg     ) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId.trim() : "";
    const agentId = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
    const emoji = msg.emoji == null || msg.emoji === "" ? null : msg.emoji;
    const fail = (errorCode     , errorMessage     ) => ({
      unicast: formatAgentEmojiSetResult(requestId, {
        status: "error", agentId, emoji, errorCode, errorMessage,
      }),
    });
    if (!requestId) return fail("missing_request_id", "Missing request id.");
    if (!agentId) return fail("invalid_agent_id", "Choose an agent.");
    if (emoji !== null && (typeof emoji !== "string" || emoji.length > 16 || /[\u0000\r\n]/.test(emoji))) {
      return fail("invalid_emoji", "Choose one emoji.");
    }
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.agentEmojiSet)) return fail("phone_only", "Agent emoji changes are phone-only.");
    if (typeof onSetAgentEmoji !== "function") return fail("unsupported", "Agent emoji changes are not available.");
    const failure = (err     ) => fail(
      err && typeof err.code === "string" && err.code ? err.code : "update_failed",
      err && err.message ? err.message : "Could not update the emoji.",
    );
    return Promise.resolve(onSetAgentEmoji({ agentId, emoji })).then(
      (payload     ) => ({ unicast: formatAgentEmojiSetResult(requestId, payload || {}) }),
      failure,
    ).catch(failure);
  }

  const AGENTS_ROUTE_MAX_TEXT = 4000;

  const agentsRouteInFlight = new Set     ();
  function handleAgentsRoute(clientId     , msg     ) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId.trim() : "";
    const text = typeof msg.text === "string" ? msg.text.slice(0, AGENTS_ROUTE_MAX_TEXT) : "";
    const fallbackAgentRef = typeof msg.fallbackAgentRef === "string" && msg.fallbackAgentRef.trim()
      ? msg.fallbackAgentRef.trim()
      : null;
    const fail = (errorCode     , errorMessage     ) => ({
      unicast: formatAgentsRouteResult(requestId, { status: "error", errorCode, errorMessage }),
    });
    if (!requestId) return fail("missing_request_id", "Missing request id.");
    if (!text.trim()) return fail("invalid_text", "Say something first.");
    if (typeof onRouteAgent !== "function") return fail("unsupported", "Auto is not available.");
    if (agentsRouteInFlight.has(clientId)) return fail("route_busy", "Auto is still picking an agent.");
    const failure = (err     ) => fail(
      err && typeof err.code === "string" && err.code ? err.code : "route_failed",
      err && err.message ? err.message : "Auto could not pick an agent.",
    );
    agentsRouteInFlight.add(clientId);
    return Promise.resolve()
      .then(() => onRouteAgent({ text, requestId, fallbackAgentRef }))
      .then(
        (payload     ) => ({ unicast: formatAgentsRouteResult(requestId, { status: "ok", ...(payload || {}) }) }),
        failure,
      )
      .catch(failure)
      .finally(() => agentsRouteInFlight.delete(clientId));
  }

  const AGENT_DESCRIPTION_MAX_CHARS = 280;

  const AGENT_DESCRIBE_MAX_AGENTS = 4;
  function handleAgentDescription(clientId     , msg     , op                ) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId.trim() : "";
    const format = op === "auto" ? formatAgentDescriptionAutoResult : formatAgentDescriptionSetResult;
    const agentId = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
    const agentIds           = Array.isArray(msg.agentIds)
      ? Array.from(new Set        (msg.agentIds
        .filter((id     ) => typeof id === "string" && id.trim())
        .map((id        ) => id.trim())))
      : [];
    const description = typeof msg.description === "string" ? msg.description.trim() : "";
    const fail = (errorCode     , errorMessage     ) => ({
      unicast: format(requestId, { status: "error", agentId, errorCode, errorMessage }),
    });
    if (!requestId) return fail("missing_request_id", "Missing request id.");
    if (op === "set") {
      if (!agentId) return fail("invalid_agent_id", "Choose an agent.");
      if (typeof msg.description !== "string" || description.length > AGENT_DESCRIPTION_MAX_CHARS ||
          /[\u0000]/.test(description)) {
        return fail("invalid_description", "Keep it to one or two sentences.");
      }
    } else if (!agentIds.length || agentIds.length > AGENT_DESCRIBE_MAX_AGENTS) {
      return fail("invalid_agent_id", "Choose an agent.");
    }
    const type = op === "auto" ? APP_PROTOCOL.agentDescriptionAuto : APP_PROTOCOL.agentDescriptionSet;
    if (!admitPhoneOnlyWrite(clientId, type)) return fail("phone_only", "Agent descriptions are phone-only.");
    if (typeof onAgentDescription !== "function") return fail("unsupported", "Agent descriptions are not available.");
    const failure = (err     ) => fail(
      err && typeof err.code === "string" && err.code ? err.code : "update_failed",
      err && err.message ? err.message : "Could not update the description.",
    );
    const request = op === "auto" ? { op, agentIds } : { op, agentId, description };
    return Promise.resolve(onAgentDescription(request)).then(
      (payload     ) => ({ unicast: format(requestId, { ...(payload || {}), agentId }) }),
      failure,
    ).catch(failure);
  }

  function agentSettingsFailure(requestId     , agentId     , err     ) {
    return {
      unicast: formatAgentSettingsResult(requestId, {
        status: "error",
        agentId,
        errorCode: err && typeof err.code === "string" && err.code ? err.code : "agent_settings_failed",
        errorMessage: err && err.message ? err.message : "Could not load or save the agent settings.",
      }),
    };
  }

  function normalizeAgentSettingsIdentity(msg     ) {
    const requestId = typeof msg.requestId === "string" ? msg.requestId.trim() : "";
    const agentId = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
    if (!requestId) return { requestId, agentId, error: "Missing request id." };
    if (!agentId) return { requestId, agentId, error: "Choose an agent." };
    return { requestId, agentId, error: null };
  }

  function handleGetAgentSettings(clientId     , msg     ) {
    const parsed = normalizeAgentSettingsIdentity(msg);
    if (parsed.error) return agentSettingsFailure(parsed.requestId, parsed.agentId, new Error(parsed.error));
    if (!isPhoneClient(clientId)) return agentSettingsFailure(parsed.requestId, parsed.agentId, Object.assign(new Error("Agent settings are phone-only."), { code: "phone_only" }));
    if (typeof onGetAgentSettings !== "function") return agentSettingsFailure(parsed.requestId, parsed.agentId, Object.assign(new Error("Agent settings are not available."), { code: "unsupported" }));
    const failure = (error     ) => agentSettingsFailure(parsed.requestId, parsed.agentId, error);
    return Promise.resolve(onGetAgentSettings({ agentId: parsed.agentId })).then(
      (payload     ) => ({ unicast: formatAgentSettingsResult(parsed.requestId, payload || {}) }),
      failure,
    ).catch(failure);
  }

  function handleSetAgentSettings(clientId     , msg     ) {
    const parsed = normalizeAgentSettingsIdentity(msg);
    if (parsed.error) return agentSettingsFailure(parsed.requestId, parsed.agentId, new Error(parsed.error));
    const emoji = msg.emoji == null || msg.emoji === "" ? null : msg.emoji;
    if (emoji !== null && (typeof emoji !== "string" || emoji.length > 32 || /[\u0000\r\n]/.test(emoji))) {
      return agentSettingsFailure(parsed.requestId, parsed.agentId, Object.assign(new Error("Use one letter or one emoji."), { code: "invalid_icon" }));
    }
    if (!msg.setup || typeof msg.setup !== "object" || Array.isArray(msg.setup)) {
      return agentSettingsFailure(parsed.requestId, parsed.agentId, Object.assign(new Error("Agent settings are missing."), { code: "invalid_settings" }));
    }
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.agentSettingsSet)) return agentSettingsFailure(parsed.requestId, parsed.agentId, Object.assign(new Error("Agent settings are phone-only."), { code: "phone_only" }));
    if (typeof onSetAgentSettings !== "function") return agentSettingsFailure(parsed.requestId, parsed.agentId, Object.assign(new Error("Agent settings are not available."), { code: "unsupported" }));
    const failure = (error     ) => agentSettingsFailure(parsed.requestId, parsed.agentId, error);
    return Promise.resolve(onSetAgentSettings({ agentId: parsed.agentId, emoji, setup: msg.setup,
      ...(msg.producedAtMs !== undefined || msg.expiresAtMs !== undefined ? { producedAtMs: msg.producedAtMs, expiresAtMs: msg.expiresAtMs } : {}) })).then(
      (payload     ) => ({ unicast: formatAgentSettingsResult(parsed.requestId, payload || {}) }),
      failure,
    ).catch(failure);
  }

  function hostDefaultsFailure(requestId     , err     ) {
    return {
      unicast: formatHostDefaultsResult(requestId, {
        status: "error",
        errorCode: err && typeof err.code === "string" && err.code ? err.code : "defaults_failed",
        errorMessage: err && err.message ? err.message : "Could not load or save the defaults for all chats.",
      }),
    };
  }

  function hostDefaultsRequestId(msg     ) {
    return typeof msg.requestId === "string" ? msg.requestId.trim() : "";
  }

  function handleGetHostDefaults(clientId     , msg     ) {
    const requestId = hostDefaultsRequestId(msg);
    if (!requestId) return hostDefaultsFailure(requestId, new Error("Missing request id."));
    if (!isPhoneClient(clientId)) return hostDefaultsFailure(requestId, Object.assign(new Error("Defaults for all chats are phone-only."), { code: "phone_only" }));
    if (typeof onGetHostDefaults !== "function") return hostDefaultsFailure(requestId, Object.assign(new Error("Defaults for all chats are not available."), { code: "unsupported" }));
    const failure = (error     ) => hostDefaultsFailure(requestId, error);
    return Promise.resolve(onGetHostDefaults()).then(
      (payload     ) => ({ unicast: formatHostDefaultsResult(requestId, payload || {}) }),
      failure,
    ).catch(failure);
  }

  function handleSetHostDefaults(clientId     , msg     ) {
    const requestId = hostDefaultsRequestId(msg);
    if (!requestId) return hostDefaultsFailure(requestId, new Error("Missing request id."));
    if (!msg.changes || typeof msg.changes !== "object" || Array.isArray(msg.changes)) {
      return hostDefaultsFailure(requestId, Object.assign(new Error("Nothing to change."), { code: "invalid_defaults" }));
    }
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.hostDefaultsSet)) return hostDefaultsFailure(requestId, Object.assign(new Error("Defaults for all chats are phone-only."), { code: "phone_only" }));
    if (typeof onSetHostDefaults !== "function") return hostDefaultsFailure(requestId, Object.assign(new Error("Defaults for all chats are not available."), { code: "unsupported" }));
    const failure = (error     ) => hostDefaultsFailure(requestId, error);
    const baseHash = typeof msg.baseHash === "string" ? msg.baseHash.trim() : "";
    return Promise.resolve(onSetHostDefaults({ changes: msg.changes, baseHash })).then(
      (payload     ) => ({ unicast: formatHostDefaultsResult(requestId, payload || {}) }),
      failure,
    ).catch(failure);
  }

  const {
    handleGetSonioxModels,
    handleGetHermesSttCapabilities,
    handleHermesSttTranscribe,
    handleRequestSonioxTemporaryKey,
    handleRequestCartesiaAccessToken,
  } = createVoiceHandlers({
    logger,
    formatHermesSttCapabilities,
    onGetSonioxModels,
    onGetHermesSttCapabilities,
    onHermesSttTranscribe,
    onRequestSonioxTemporaryKey,
    onRequestCartesiaAccessToken,
  });

  function handleGetProviderUsageSnapshot(clientId) {
    const emptySnapshot = () => ({
      sessionKey: null,
      provider: null,
      displayName: null,
      limitingWindowKey: null,
      windows: [],
      fetchedAtMs: Date.now(),
      stale: true,
    });

    if (!onGetProviderUsageSnapshot) {
      return {
        unicast: formatProviderUsageSnapshot(emptySnapshot()),
      };
    }
    return Promise.resolve(onGetProviderUsageSnapshot()).then(
      (payload) => ({
        unicast: formatProviderUsageSnapshot(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getProviderUsageSnapshot failed: ${err.message}`);
        return {
          unicast: formatProviderUsageSnapshot(emptySnapshot()),
        };
      },
    );
  }

  function handleGetStatus(clientId) {
    if (!onGetStatus) {
      return { unicast: formatError("getStatus is not available") };
    }
    try {
      return {
        unicast: formatStatus(onGetStatus() || {}),
      };
    } catch (err) {
      return { unicast: formatError(err.message || "getStatus failed") };
    }
  }

  const {
    handleGetEvenAiSettings,
    handleGetEvenAiSessions,
    handleSetEvenAiSettings,
    handleGetOcuClawSettings,
    handleSetOcuClawSettings,
    handleGetSavedPrompts,
    handleWriteSavedPrompts,
  } = createSettingsHandlers({
    logger,
    formatEvenAiSessions,
    hasOwn,
    onGetEvenAiSettings,
    onGetEvenAiSessions,
    onSetEvenAiSettings,
    onGetOcuClawSettings,
    onSetOcuClawSettings,
    onGetSavedPrompts,
    onWriteSavedPrompts,
  });

  const {
    handleNewChat,
    handleGetSessions,
    handleGetSessionDiff,
    handleGetSessionModelConfig,
    handleSetSessionAgent,
    handleSetSessionModelConfig,
    handleCompactSession,
    handleSwitchSession,
    handleCopySession,
    handleSessionDriverTakeOver,
    handleAdoptSession,
    handleNewSession,
    handleSetUserSessionTitle,
    handleSetSessionPinned,
    handleSetSessionHidden,
    handleMarkAllSessionsRead,
    handleDeleteSessions,
    handleSearchTranscripts,
  } = createSessionHandlers({
    logger,
    formatPages,
    defaultEvenAiDedicatedSessionKey,
    hasOwn,
    isRetiredEvenTerminalSessionKey,
    onClientSessionSelected,
    onNewChat,
    onGetSessions,
    onGetEvenAiSessions,
    onSwitchSession,
    onCopySession,
    onAdoptSession,
    onSessionDriverTakeOver,
    onNewSession,
    onGetSessionModelConfig,
    onSetSessionModelConfig,
    onSetSessionAgent,
    onCompactSession,
    onSetUserSessionTitle,
    onSetSessionPinned,
    onSetSessionHidden,
    onMarkAllSessionsRead,
    onDeleteSessions,
    onSearchTranscripts,
  });

  function handleSlashCommand(clientId, msg) {
    if (!msg.command) return null;
    return onSlashCommand(msg.command).then(
      () => null,
      (err) => {
        logger.error(`[downstream] slashCommand failed: ${err.message}`);
        return null;
      },
    );
  }

  function handleConsole(clientId, msg) {
    if (onConsoleLog) {
      onConsoleLog(msg.level || "log", msg.message || "");
    }
    return null;
  }

  function handleEventDebug(clientId, msg) {
    const parsed = parseEventDebug(msg);
    if (parsed && onEventDebug) {
      onEventDebug(clientId, parsed);
      return null;
    }
    if (onConsoleLog) {
      const legacyMessage =
        typeof msg.data === "string" ? msg.data : JSON.stringify(msg);
      onConsoleLog("event", legacyMessage);
    }
    return null;
  }

  function handleRemovedListenAction(messageType) {
    return {
      unicast: formatError(
        `${messageType} was removed; hybrid-local voice stays local to the app`,
      ),
    };
  }

  function handleDebugSet(clientId, msg) {
    if (!onDebugSet) {
      return { unicast: formatError("debug-set is not available") };
    }

    let payload;
    try {
      payload = parseDebugSet(msg);
    } catch (err) {
      return { unicast: formatError(err.message) };
    }

    try {
      const result = onDebugSet(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => {
            const payloadResult = resolved || { ok: true };
            const out = { unicast: formatDebugSet(payloadResult) };
            if (
              payloadResult.ok !== false &&
              Number.isFinite(payloadResult.nowMs) &&
              Array.isArray(payloadResult.enabled)
            ) {
              out.broadcastApp = formatDebugConfigSnapshot({
                serverNowMs: payloadResult.nowMs,
                enabled: payloadResult.enabled,
              });
            }
            return out;
          },
          (err) => ({ unicast: formatError(err.message || "debug-set failed") }),
        );
      }
      const payloadResult = result || { ok: true };
      const out = { unicast: formatDebugSet(payloadResult) };
      if (
        payloadResult.ok !== false &&
        Number.isFinite(payloadResult.nowMs) &&
        Array.isArray(payloadResult.enabled)
      ) {
        out.broadcastApp = formatDebugConfigSnapshot({
          serverNowMs: payloadResult.nowMs,
          enabled: payloadResult.enabled,
        });
      }
      return out;
    } catch (err) {
      return { unicast: formatError(err.message || "debug-set failed") };
    }
  }

  function handleDebugDump(clientId, msg) {
    if (!onDebugDump) {
      return { unicast: formatError("debug-dump is not available") };
    }

    let payload;
    try {
      payload = parseDebugDump(msg);
    } catch (err) {
      return { unicast: formatError(err.message) };
    }

    try {
      const result = onDebugDump(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => ({ unicast: formatDebugDump(resolved || { ok: true, events: [] }) }),
          (err) => ({ unicast: formatError(err.message || "debug-dump failed") }),
        );
      }
      return { unicast: formatDebugDump(result || { ok: true, events: [] }) };
    } catch (err) {
      return { unicast: formatError(err.message || "debug-dump failed") };
    }
  }

  function handleTraceLogSet(clientId, msg) {
    if (!onTraceLogSet) {
      return { unicast: formatError("trace-log-set is not available") };
    }
    let payload;
    try {
      payload = parseTraceLogSet(msg);
    } catch (err) {
      return { unicast: formatError(err.message) };
    }
    try {
      const result = onTraceLogSet(clientId, payload) || { ok: true };
      return { unicast: formatTraceLog(result) };
    } catch (err) {
      return { unicast: formatError(err.message || "trace-log-set failed") };
    }
  }

  function handleTraceLogGet(clientId) {
    if (!onTraceLogGet) {
      return { unicast: formatError("trace-log-get is not available") };
    }
    try {
      const result = onTraceLogGet(clientId) || { ok: true };
      return { unicast: formatTraceLog(result) };
    } catch (err) {
      return { unicast: formatError(err.message || "trace-log-get failed") };
    }
  }

  function handleRemoteControl(clientId, msg) {
    if (!onRemoteControl) {
      return { unicast: formatError("remote-control is not available") };
    }

    let payload;
    try {
      payload = parseRemoteControl(msg);
    } catch (err) {
      return { unicast: formatError(err.message) };
    }

    const finalize = (result) => {
      const resolved = result || {};
      const requestId = resolved.requestId || payload.requestId || null;
      const ack = {
        ok: resolved.ok !== false,
        requestId,
        action: payload.action,
        dispatched: !!resolved.control,
      };
      if (resolved.message) ack.message = resolved.message;
      if (resolved.detail) ack.detail = resolved.detail;

      const out = {
        unicast: formatRemoteControlAck(ack),
      };
      if (resolved.control) {
        out.broadcast = formatRemoteControl(resolved.control);
      }
      return out;
    };

    try {
      const result = onRemoteControl(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => finalize(resolved),
          (err) => ({ unicast: formatError(err.message || "remote-control failed") }),
        );
      }
      return finalize(result);
    } catch (err) {
      return { unicast: formatError(err.message || "remote-control failed") };
    }
  }

  function handleReadinessProbe(clientId, msg) {
    if (!onReadinessProbe) {
      return { unicast: formatError("readiness probe is not available") };
    }

    let payload;
    try {
      payload = parseReadinessProbe(msg);
    } catch (err) {
      return { unicast: formatError(err.message) };
    }

    const finalize = (result) => {
      const resolved = result || {};
      const requestId = resolved.requestId || payload.requestId;
      if (
        resolved.ok === false ||
        !resolved.targetClientId ||
        !resolved.probe
      ) {
        return {
          unicast: formatReadinessProbeAck({
            ok: false,
            requestId,
            reasonCode: resolved.reasonCode || null,
            message: resolved.message || "readiness probe was not dispatched",
            activeSessionKey: resolved.activeSessionKey || null,
            emittedAtMs: resolved.emittedAtMs || null,
          }),
        };
      }

      return {
        readinessProbe: {
          requestId,
          targetClientId: resolved.targetClientId,
          message: formatReadinessProbeRequest(resolved.probe),
        },
      };
    };

    try {
      const result = onReadinessProbe(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => finalize(resolved),
          (err) => ({
            unicast: formatError(err.message || "readiness probe failed"),
          }),
        );
      }
      return finalize(result);
    } catch (err) {
      return { unicast: formatError(err.message || "readiness probe failed") };
    }
  }

  function handleAutomationState(clientId, msg) {
    let payload;
    try {
      payload = parseAutomationStateGet(msg);
    } catch (err) {
      return {
        unicast: formatAutomationStateSnapshot({
          ok: false,
          requestId:
            msg && typeof msg.requestId === "string" ? msg.requestId : null,
          reasonCode: "snapshot_unavailable",
          message: err.message,
        }),
      };
    }

    if (!onAutomationState) {
      return null;
    }

    const finalize = (result) => {
      const resolved = result || {};
      const requestId = resolved.requestId || payload.requestId;
      if (
        resolved.ok === false ||
        !resolved.targetClientId ||
        !resolved.request
      ) {
        return {
          unicast: formatAutomationStateSnapshot({
            ok: false,
            requestId,
            reasonCode: resolved.reasonCode || "snapshot_unavailable",
            message:
              resolved.message || "automation state request was not dispatched",
          }),
        };
      }

      return {
        automationStateRequest: {
          requestId,
          targetClientId: resolved.targetClientId,
          message: formatAutomationStateRequest(resolved.request),
        },
      };
    };

    try {
      const result = onAutomationState(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => finalize(resolved),
          (err) => ({
            unicast: formatAutomationStateSnapshot({
              ok: false,
              requestId: payload.requestId,
              reasonCode: "snapshot_unavailable",
              message: err.message || "automation state request failed",
            }),
          }),
        );
      }
      return finalize(result);
    } catch (err) {
      return {
        unicast: formatAutomationStateSnapshot({
          ok: false,
          requestId: payload.requestId,
          reasonCode: "snapshot_unavailable",
          message: err.message || "automation state request failed",
        }),
      };
    }
  }

  function handleAutomationRegistry(clientId) {
    if (!onAutomationRegistry) {
      return null;
    }

    const finalize = (result) => {
      const resolved = result || {};
      if (
        resolved.ok === false ||
        !resolved.targetClientId ||
        !resolved.request
      ) {
        return {
          unicast: formatError(
            resolved.message || "automation registry request was not dispatched",
          ),
        };
      }

      return {
        automationRegistryRequest: {
          targetClientId: resolved.targetClientId,
          message: formatAutomationRegistryRequest(resolved.request),
        },
      };
    };

    try {
      const result = onAutomationRegistry(clientId, {});
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => finalize(resolved),
          (err) => ({
            unicast: formatError(err.message || "automation registry request failed"),
          }),
        );
      }
      return finalize(result);
    } catch (err) {
      return {
        unicast: formatError(err.message || "automation registry request failed"),
      };
    }
  }

  return {

    handleMessage(clientId, raw, transportContext      = {}) {
      let msg     ;
      try {
        msg = JSON.parse(raw);
      } catch {
        return { unicast: formatError("Invalid JSON") };
      }

      if (
        !externalDebugToolsEnabled &&
        msg &&
        typeof msg.type === "string" &&
        isExternalDebugToolMessageType(msg.type)
      ) {
        return {
          unicast: formatError(EXTERNAL_DEBUG_TOOLS_DISABLED_ERROR),
        };
      }

      switch (msg.type) {
        case "ocuclaw.model_sites.request": {
          const request = parseModelSitesRequest(msg);
          const respond = (result     ) => ({ unicast: JSON.stringify({ type: "ocuclaw.model_sites.result", ...result }) });
          if (!admitPhoneOnlyWrite(clientId, msg.type)) return respond(modelSitesFailure(msg, "phone_only"));
          if (!request) return respond(modelSitesFailure(msg, "invalid_request"));
          if (typeof opts.onModelSites !== "function") return respond(modelSitesFailure(request, "unsupported", "unsupported"));
          return Promise.resolve().then(() => opts.onModelSites(clientId, request, transportContext.workerEpoch))
            .then((result     ) => respond(modelSitesResult(request, result)))
            .catch(() => respond(modelSitesFailure(request, "unavailable", "outcome_unknown")))
            .finally(() => { if (request.credential) request.credential = ""; msg = null; });
        }
        case "ocuclaw.optional.setup.request": {
          const request = parseOptionalSetupRequest(msg);
          const respond = (result     ) => ({ unicast: JSON.stringify({ type: "ocuclaw.optional.setup.result", ...result }) });
          if (!admitPhoneOnlyWrite(clientId, msg.type)) return respond(optionalSetupFailure(msg, "phone_only"));
          if (!request) return respond(optionalSetupFailure(msg, "invalid_request"));
          if (typeof opts.onOptionalSetup !== "function") return respond(optionalSetupFailure(request, "unsupported", "unsupported"));
          return Promise.resolve().then(() => opts.onOptionalSetup(clientId, request, transportContext.workerEpoch))
            .then((result     ) => respond(optionalSetupResult(request, result)))
            .catch(() => respond(optionalSetupFailure(request, "unavailable", "outcome_unknown")))
            .finally(() => { if (request.credential) request.credential = ""; msg = null; });
        }
        case "ocuclaw.secret.answer": {

          const requestId = typeof msg.requestId === "string" ? msg.requestId.slice(0, 128) : "";
          const id = typeof msg.id === "string" ? msg.id.trim().slice(0, 256) : "";
          const respond = (result     ) => ({
            unicast: JSON.stringify({
              type: "ocuclaw.secret.result",
              requestId,
              id,
              status: result && typeof result.status === "string" ? result.status : "failed",
              reason: result && typeof result.reason === "string" ? result.reason : null,
            }),
          });
          const answer      = { id, skip: msg.skip === true };
          if (!answer.skip) answer.value = typeof msg.value === "string" ? msg.value : "";
          if (Array.isArray(msg.allowedHosts)) answer.allowedHosts = msg.allowedHosts.filter((host     ) => typeof host === "string");
          msg = null;
          if (!admitPhoneOnlyWrite(clientId, "ocuclaw.secret.answer")) return respond({ status: "refused", reason: "phone_only" });
          if (!requestId || !id) return respond({ status: "refused", reason: "invalid_request" });
          if (typeof opts.onSecretAnswer !== "function") return respond({ status: "refused", reason: "unsupported" });
          return Promise.resolve().then(() => opts.onSecretAnswer(clientId, answer))
            .then((result     ) => respond(result))
            .catch(() => respond({ status: "failed", reason: "unavailable" }))
            .finally(() => { answer.value = ""; });
        }
        case APP_PROTOCOL.ledgerCursor:
          return handleLedgerSync(msg, onLedgerCursor);
        case APP_PROTOCOL.ledgerResyncRequest:
          return handleLedgerSync(msg, onResyncRequest);
        case APP_PROTOCOL.messageSend:
          return handleSend(clientId, msg);
        case APP_PROTOCOL.sessionAbort:
          return handleAbortSession(clientId, msg);
        case APP_PROTOCOL.sessionSteer:
          return handleSteerSession(clientId, msg);
        case "simulate":
          return handleSimulate(clientId, msg);
        case "simulateStream":
          return handleSimulateStream(clientId, msg);
        case "simulateStreamCancel":
          return handleSimulateStreamCancel(clientId, msg);
        case "simulateActivity":
          return handleSimulateActivity(clientId, msg);
        case "simulateModelCatalog":
          return handleSimulateModelCatalog(msg);
        case "simulateSessionList":
          return handleSimulateSessionList(msg);
        case "simulateTool":
          return handleSimulateTool(clientId, msg);
        case "simulateThinking":
          return handleSimulateThinking(clientId, msg);
        case "simulateRunSignal":
          return handleSimulateRunSignal(clientId, msg);
        case "simulateApproval":
          return handleSimulateApproval(clientId, msg);
        case "simulateDemand":
          return handleSimulateDemand(clientId, msg);
        case "simulateVoice":
          return handleSimulateVoice(clientId, msg);
        case "glasses_ui_surface_update":
          return handleGlassesUiSurfaceUpdateInject(clientId, msg);
        case APP_PROTOCOL.protocolSubscribe:
          return handleSubscribeProtocol(clientId);
        case APP_PROTOCOL.approvalResolve:
          return handleApprovalResponse(clientId, msg);
        case APP_PROTOCOL.waitingAnswer:
          return handleWaitingAnswer(clientId, msg);
        case APP_PROTOCOL.sessionReset:
          return handleNewChat(clientId);
        case APP_PROTOCOL.sessionList:
          return handleGetSessions(clientId);
        case APP_PROTOCOL.sessionListDiff:
          return handleGetSessionDiff(clientId, msg);
        case APP_PROTOCOL.sessionSwitch:
          return handleSwitchSession(clientId, msg);
        case APP_PROTOCOL.sessionCopy:
          return handleCopySession(clientId, msg);
        case APP_PROTOCOL.sessionAdopt:
          return handleAdoptSession(clientId, msg);
        case APP_PROTOCOL.sessionDriverTakeOver:
          return handleSessionDriverTakeOver(clientId, msg);
        case APP_PROTOCOL.sessionCreate:
          return handleNewSession(clientId, msg);
        case APP_PROTOCOL.sessionTitleSet:
          return handleSetUserSessionTitle(clientId, msg);
        case "ocuclaw.session.pinned.set":
          return handleSetSessionPinned(clientId, msg);
        case APP_PROTOCOL.sessionHiddenSet:
          return handleSetSessionHidden(clientId, msg);
        case APP_PROTOCOL.sessionReadAll:
          return handleMarkAllSessionsRead(clientId, msg);
        case "ocuclaw.session.delete":
          return handleDeleteSessions(clientId, msg);
        case "ocuclaw.session.transcripts.search":
          return handleSearchTranscripts(clientId, msg);
        case APP_PROTOCOL.modelCatalogGet:
          return handleGetModelsCatalog(clientId);
        case APP_PROTOCOL.inputPredictionCapabilities:
          return handleInputPrediction(clientId, "capabilities", msg);
        case APP_PROTOCOL.inputPredictionRequest:
          return handleInputPrediction(clientId, "request", msg);
        case APP_PROTOCOL.inputPredictionOpen:
          return handleInputPrediction(clientId, "open", msg);
        case APP_PROTOCOL.inputPredictionCancel:
          return handleInputPrediction(clientId, "cancel", msg);
        case APP_PROTOCOL.inputPredictionTest:
          return handleInputPrediction(clientId, "test", msg);
        case APP_PROTOCOL.inputStarted:
          return handleInputStarted(clientId, msg);
        case APP_PROTOCOL.inputPredictionModelAllow:

          if (!admitPhoneOnlyWrite(clientId, msg.type)) {
            return {
              unicast: JSON.stringify({
                type: APP_PROTOCOL.inputPredictionModelAllowResult,
                requestId: msg && typeof msg.requestId === "string" && /^[A-Za-z0-9._:@/-]{1,128}$/.test(msg.requestId) ? msg.requestId : "",
                status: "policy-denied",
                activation: { required: false, mode: "none" },
              }),
            };
          }
          return handleInputPrediction(clientId, "modelAllow", msg);
        case APP_PROTOCOL.skillsCatalogGet:
        case "getSkills":
          return handleGetSkillsCatalog(clientId);
        case APP_PROTOCOL.starmapGet:
          return handleGetStarMap(clientId);
        case APP_PROTOCOL.starmapForget:
          return handleForgetStar(clientId, msg);
        case APP_PROTOCOL.liveuiLibraryGet:
          return handleGetLiveuiLibrary(clientId);
        case APP_PROTOCOL.liveuiLibraryOpen:
          return handleOpenLiveuiLibraryItem(clientId, msg);
        case APP_PROTOCOL.programCardSave:
          return handleSaveProgramCard(clientId, msg);
        case APP_PROTOCOL.programCardCheckpoint:
          return handleCheckpointProgramCard(clientId, msg);
        case APP_PROTOCOL.programCardSourceGet:
          return handleGetProgramCardSource(clientId, msg);
        case APP_PROTOCOL.programCardRevisionsGet:
          return handleGetProgramCardRevisions(clientId, msg);
        case APP_PROTOCOL.programCardRevision:
          return handleProgramCardRevision(clientId, msg);
        case APP_PROTOCOL.programCardRevisionPicture:
          return handleProgramCardRevisionPicture(clientId, msg);
        case APP_PROTOCOL.programCardSlotsGet:
          return handleGetProgramCardSlots(clientId, msg);
        case APP_PROTOCOL.programCardSlot:
          return handleProgramCardSlot(clientId, msg);
        case APP_PROTOCOL.programCardReviewLookStep:
          return handleProgramCardReviewLookStep(clientId, msg);
        case APP_PROTOCOL.programCardReviewGet:
        case APP_PROTOCOL.programCardReviewStart:
        case APP_PROTOCOL.programCardReviewCancel:
        case APP_PROTOCOL.programCardReviewRetry:
        case APP_PROTOCOL.programCardReviewRetryCancel:
        case APP_PROTOCOL.programCardReviewDecide:
          return handleProgramCardReview(clientId, msg);
        case APP_PROTOCOL.programCardReviewApply:
          return handleProgramCardReviewApply(clientId, msg);
        case APP_PROTOCOL.liveuiTaskCancel:
          return handleCancelLiveuiTaskLaunch(clientId, msg);
        case APP_PROTOCOL.liveuiTasksGet:
          return handleGetLiveuiTasksForPhone(clientId);
        case APP_PROTOCOL.liveuiTaskRunsGet:
          return handleGetLiveuiTaskRunsForPhone(clientId, msg);
        case "ocuclaw.program_card.drafts": {
          if (!onProgramCardRequest || !admitPhoneOnlyWrite(clientId, msg.type)) return null;
          return Promise.resolve(onProgramCardRequest({ clientId, type: msg.type, msg, ownerWrite: true }));
        }
        case APP_PROTOCOL.programBindingsGet:
        case APP_PROTOCOL.programBindingSet:
        case APP_PROTOCOL.programBindingClear:
        case APP_PROTOCOL.programBindingRelink:
        case APP_PROTOCOL.programBindingFixNotNow:
        case APP_PROTOCOL.programBindingFixStart:
        case APP_PROTOCOL.programBindingFixSave:
        case APP_PROTOCOL.programBindingFixClose:
        case APP_PROTOCOL.programBindingFixUndo:
        case APP_PROTOCOL.programBindingParts:
        case APP_PROTOCOL.programBindingLink:
        case APP_PROTOCOL.programBindingOpenUpdate:
        case APP_PROTOCOL.programOpened:
        case APP_PROTOCOL.programClosed:
        case APP_PROTOCOL.programRefresh:
        case APP_PROTOCOL.programAgentRefresh:
        case APP_PROTOCOL.programCheckAgain: {
          if (!onProgramCardRequest) return null;
          const ownerWrite = msg.type === APP_PROTOCOL.programBindingSet || msg.type === APP_PROTOCOL.programBindingClear ||
            msg.type === APP_PROTOCOL.programBindingRelink || msg.type === APP_PROTOCOL.programBindingOpenUpdate ||
            msg.type === APP_PROTOCOL.programBindingFixNotNow || msg.type === APP_PROTOCOL.programBindingFixStart ||
            msg.type === APP_PROTOCOL.programBindingFixSave || msg.type === APP_PROTOCOL.programBindingFixClose ||
            msg.type === APP_PROTOCOL.programBindingFixUndo ||
            msg.type === APP_PROTOCOL.programBindingParts || msg.type === APP_PROTOCOL.programBindingLink ||
            msg.type === APP_PROTOCOL.programAgentRefresh || msg.type === APP_PROTOCOL.programCheckAgain
            ? admitPhoneOnlyWrite(clientId, msg.type)
            : false;
          return Promise.resolve(onProgramCardRequest({ clientId, type: msg.type, msg, ownerWrite })).catch((err     ) => {
            logger.error(`[downstream] program card request failed: ${err && err.message ? err.message : err}`);
            return null;
          });
        }
        case APP_PROTOCOL.liveuiTaskReview:
          return handleReviewLiveuiTask(clientId, msg);
        case APP_PROTOCOL.liveuiTaskExecutorsGet:
          return handleGetLiveuiTaskExecutors(clientId);
        case APP_PROTOCOL.liveuiTaskExecutorSet:
          return handleSetLiveuiTaskExecutor(clientId, msg);
        case APP_PROTOCOL.liveuiTaskPreferredTemplateSet:
          return handleSetLiveuiTaskPreferredTemplate(clientId, msg);
        case APP_PROTOCOL.liveuiTaskContextSet:
          return handleSetLiveuiTaskContext(clientId, msg);
        case APP_PROTOCOL.liveuiTaskSettingsSet:
          return handleSetLiveuiTaskSettingValues(clientId, msg);
        case APP_PROTOCOL.liveuiPrefsGet:
          return handleGetLiveuiPrefs(clientId);
        case APP_PROTOCOL.liveuiPrefsSet:
          return handleSetLiveuiPrefs(clientId, msg);
        case APP_PROTOCOL.liveuiGrantsGet:
          return handleGetLiveuiGrants(clientId);
        case APP_PROTOCOL.liveuiGrantsSet:
          return handleSetLiveuiGrant(clientId, msg);
        case APP_PROTOCOL.liveuiStatusGet:
          return handleGetLiveuiStatus(clientId);
        case APP_PROTOCOL.liveuiVideoRoute:
          return handleLiveuiVideoRoute(clientId, msg);
        case APP_PROTOCOL.liveuiLibraryOrganize:
          return handleOrganizeLiveuiLibrary(clientId, msg);
        case APP_PROTOCOL.commandCatalogGet:
        case "getCommands":
          return handleGetCommandCatalog(clientId);
        case APP_PROTOCOL.agentsCatalogGet:
        case "getAgentsCatalog":
          return handleGetAgentsCatalog(clientId, msg);
        case APP_PROTOCOL.openclawAgentCreate:
          return handleCreateOpenClawAgent(clientId, msg);
        case APP_PROTOCOL.hermesProfileCreate:
          return handleCreateHermesProfile(clientId, msg);
        case APP_PROTOCOL.management:
        case APP_PROTOCOL.hermesManagement:
          return handleHermesManagement(clientId, msg);
        case APP_PROTOCOL.boardMomentAck:
          return handleBoardMomentAck(clientId, msg);
        case APP_PROTOCOL.botScreenOpen:
        case APP_PROTOCOL.botScreenClose:
        case APP_PROTOCOL.botScreenStatusGet:
        case APP_PROTOCOL.botScreenWant:
        case APP_PROTOCOL.botScreenControl:
        case APP_PROTOCOL.botScreenAim:
        case APP_PROTOCOL.botScreenStart:
          return handleBotScreen(clientId, msg);
        case APP_PROTOCOL.pushAck:
          return handleTaskPushAck(clientId, msg);
        case APP_PROTOCOL.taskRowsGet:
          return handleTaskRowsGet(clientId);
        case APP_PROTOCOL.taskReminder:
          return handleTaskReminder(clientId, msg);
        case APP_PROTOCOL.taskLookSet:
          return handleTaskLookSet(clientId, msg);
        case APP_PROTOCOL.taskSheetSave:
          return handleTaskSheet(clientId, msg, "save");
        case APP_PROTOCOL.taskProposalStart:
        case APP_PROTOCOL.taskProposalCancel:
        case APP_PROTOCOL.taskProposalPreview:
        case APP_PROTOCOL.taskProposalRevision:
        case APP_PROTOCOL.taskProposalApplyRevision:
          return handleTaskProposal(clientId, msg);
        case APP_PROTOCOL.agentDraftStart:
        case APP_PROTOCOL.agentDraftCancel:
          return handleAgentDraft(clientId, msg);
        case APP_PROTOCOL.taskWordsStart:
        case APP_PROTOCOL.taskWordsCancel:
          return handleTaskWords(clientId, msg);
        case APP_PROTOCOL.taskSheetRun:
          return handleTaskSheet(clientId, msg, "run");
        case APP_PROTOCOL.taskSheetQuiet:
          return handleTaskSheet(clientId, msg, "quiet");
        case APP_PROTOCOL.taskPageGet:
          return handleTaskPage(clientId, msg, "page");
        case APP_PROTOCOL.taskPageAct:
          return handleTaskPage(clientId, msg, "act");
        case APP_PROTOCOL.taskTestRun:
        case APP_PROTOCOL.taskTestAct:
        case APP_PROTOCOL.taskTestStop:
        case APP_PROTOCOL.taskTestDrop:
        case APP_PROTOCOL.taskTestStarterReport:
        case APP_PROTOCOL.taskCardDrop:
        case APP_PROTOCOL.taskCardSave:
        case APP_PROTOCOL.taskCardUndo:
          return handleTaskTest(clientId, msg);
        case APP_PROTOCOL.agentEmojiSet:
          return handleSetAgentEmoji(clientId, msg);
        case APP_PROTOCOL.agentsRoute:
          return handleAgentsRoute(clientId, msg);
        case APP_PROTOCOL.agentDescriptionSet:
          return handleAgentDescription(clientId, msg, "set");
        case APP_PROTOCOL.agentDescriptionAuto:
          return handleAgentDescription(clientId, msg, "auto");
        case APP_PROTOCOL.agentSettingsGet:
          return handleGetAgentSettings(clientId, msg);
        case APP_PROTOCOL.agentSettingsSet:
          return handleSetAgentSettings(clientId, msg);
        case APP_PROTOCOL.hostDefaultsGet:
          return handleGetHostDefaults(clientId, msg);
        case APP_PROTOCOL.hostDefaultsSet:
          return handleSetHostDefaults(clientId, msg);
        case APP_PROTOCOL.sonioxModelsGet:
        case "getSonioxModels":
          return handleGetSonioxModels(clientId);
        case APP_PROTOCOL.hermesSttCapabilitiesGet:
          return handleGetHermesSttCapabilities(msg);
        case APP_PROTOCOL.hermesSttTranscribe:
          return handleHermesSttTranscribe(msg);

        case REALTIME_APP_PROTOCOL.capabilitiesGet:
        case REALTIME_APP_PROTOCOL.start:
        case REALTIME_APP_PROTOCOL.audio:
        case REALTIME_APP_PROTOCOL.markAck:
        case REALTIME_APP_PROTOCOL.interrupt:
        case REALTIME_APP_PROTOCOL.stop:
          return realtimeTalkHandlers.handle(clientId, msg);

        case TTS_APP_PROTOCOL.capabilitiesGet:
          return isPhoneClient(clientId)
            ? ttsHandlers.handleGetTtsCapabilities(msg)
            : offlineTtsHandlers.handleGetTtsCapabilities(msg);
        case TTS_APP_PROTOCOL.speak:
          return isPhoneClient(clientId)
            ? ttsHandlers.handleTtsSpeak(msg)
            : offlineTtsHandlers.handleTtsSpeak(msg);

        case PHONE_SETTINGS_APP_PROTOCOL.snapshot:
          if (isPhoneClient(clientId) && typeof opts.onPhoneSettingsSnapshot === "function") {
            opts.onPhoneSettingsSnapshot(msg);
          }
          return null;
        case PHONE_SETTINGS_APP_PROTOCOL.result:
          if (isPhoneClient(clientId) && typeof opts.onPhoneSettingsResult === "function") {
            opts.onPhoneSettingsResult(msg);
          }
          return null;

        case APP_PROTOCOL.botScreenShowResult:
          if (isPhoneClient(clientId) && typeof opts.onBotScreenShowResult === "function") {
            opts.onBotScreenShowResult(msg);
          }
          return null;
        case "ocuclaw.voice.hermes.stt.upload.begin":
        case "ocuclaw.voice.hermes.stt.upload.chunk":
        case "ocuclaw.voice.hermes.stt.upload.commit":
        case "ocuclaw.voice.hermes.stt.upload.cancel": {
          const result = hermesSttUpload && isPhoneClient(clientId)
            ? hermesSttUpload.handle(clientId, msg)
            : Promise.resolve({ success: false, error: { code: "offline", message: "upload unavailable" } });
          return Promise.resolve(result).then(payload => ({
            unicast: msg.type.endsWith(".commit")
              ? formatHermesSttTranscribeResult({ ...payload, requestId: msg.requestId, provider: msg.provider })
              : JSON.stringify({ type: "ocuclaw.voice.hermes.stt.upload.status", uploadId: msg.uploadId,
                  success: payload.success, error: payload.error }),
          }));
        }
        case APP_PROTOCOL.providerUsageGet:
        case "getProviderUsageSnapshot":
          return handleGetProviderUsageSnapshot(clientId);
        case APP_PROTOCOL.statusGet:
        case "getStatus":
          return handleGetStatus(clientId);
        case APP_PROTOCOL.sessionConfigGet:
          return handleGetSessionModelConfig(clientId);
        case APP_PROTOCOL.sessionConfigSet:
          return handleSetSessionModelConfig(clientId, msg);
        case APP_PROTOCOL.sessionAgentSet:
        case "setSessionAgent":
          return handleSetSessionAgent(clientId, msg);
        case APP_PROTOCOL.sessionCompact:
          return handleCompactSession(clientId, msg);
        case APP_PROTOCOL.evenAiSettingsGet:
          return handleGetEvenAiSettings(clientId);
        case APP_PROTOCOL.evenAiSessionList:
          return handleGetEvenAiSessions(clientId);
        case APP_PROTOCOL.evenAiSettingsSet:
          return handleSetEvenAiSettings(clientId, msg);
        case APP_PROTOCOL.ocuClawSettingsGet:
          return handleGetOcuClawSettings(clientId);
        case APP_PROTOCOL.ocuClawSettingsSet:
          return handleSetOcuClawSettings(clientId, msg);
        case APP_PROTOCOL.savedPromptsGet:
          return handleGetSavedPrompts(clientId);
        case APP_PROTOCOL.savedPromptsWrite:
          return handleWriteSavedPrompts(clientId, msg);
        case APP_PROTOCOL.commandSlash:
          return handleSlashCommand(clientId, msg);
        case "console":
          return handleConsole(clientId, msg);
        case "listen-start":
        case "listen-stop":
        case "listen-send":
        case "listen-retry":
          return handleRemovedListenAction(msg.type);
        case APP_PROTOCOL.requestSonioxTemporaryKey:
          return handleRequestSonioxTemporaryKey(clientId, msg);
        case APP_PROTOCOL.requestCartesiaAccessToken:
          return handleRequestCartesiaAccessToken(clientId, msg);
        case "debug-set":
          return handleDebugSet(clientId, msg);
        case "debug-dump":
          return handleDebugDump(clientId, msg);
        case "debug-bundle-request":

          if (typeof onDebugBundleRequest === "function") {
            try {
              onDebugBundleRequest(clientId, msg);
            } catch (err) {
              logger.warn(
                `[downstream] debug-bundle-request handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "debug-bundle-client-events": {

          const result = typeof onDebugBundleClientEvents === "function"
            ? onDebugBundleClientEvents(clientId, msg)
            : { accepted: false, reason: "unsupported", bytes: 0, complete: false };
          return {
            unicast: JSON.stringify({
              type: "debug-bundle-client-events-ack",
              foldId: typeof msg.foldId === "string" ? msg.foldId : "",
              accepted: result.accepted === true,
              bytes: Number.isSafeInteger(result.bytes) ? result.bytes : 0,
              complete: result.complete === true,
              ...(result.duplicate === true ? { duplicate: true } : {}),
              ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
            }),
          };
        }
        case "debug-bundle-save":
          if (typeof onDebugBundleSave === "function") {
            try {
              onDebugBundleSave(clientId, msg);
            } catch (err) {
              logger.warn(
                `[downstream] debug-bundle-save handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "debug-bundle-fetch":
          if (typeof onDebugBundleFetch === "function") {
            try {
              onDebugBundleFetch(clientId, msg);
            } catch (err) {
              logger.warn(
                `[downstream] debug-bundle-fetch handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "trace-log-set":
          return handleTraceLogSet(clientId, msg);
        case "trace-log-get":
          return handleTraceLogGet(clientId);
        case "remote-control":
          return handleRemoteControl(clientId, msg);
        case APP_PROTOCOL.automationRegistryGet:
          return handleAutomationRegistry(clientId);
        case APP_PROTOCOL.automationStateGet:
          return handleAutomationState(clientId, msg);
        case APP_PROTOCOL.readinessProbeRequest:
          return handleReadinessProbe(clientId, msg);
        case APP_PROTOCOL.debugEvent:
          return handleEventDebug(clientId, msg);
        case "glasses_ui_result":
          if (typeof onGlassesUiResult === "function") {
            try {
              onGlassesUiResult({
                clientId,
                phoneClient: isPhoneClient(clientId),
                surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
                outcome: msg.outcome,

                reportAuthoritative: transportContext.liveuiStateReportAuthority?.eligible === true,
                reportAuthorityReason: transportContext.liveuiStateReportAuthority?.eligible === true
                  ? null : transportContext.liveuiStateReportAuthority?.reason || "unbound_send",
              });
            } catch (err) {
              logger.warn(
                `[downstream] glasses_ui_result handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "demand_response": {
          const surfaceId =
            typeof msg.surfaceId === "string" ? msg.surfaceId.trim() : "";
          const result =
            msg.result === "selected" ||
            msg.result === "await_text" ||

            msg.result === "await_text_cancelled" ||
            msg.result === "dismissed"
              ? msg.result
              : "";
          const selectedIndex = msg.selectedIndex;
          const validSelectedIndex =
            Number.isInteger(selectedIndex) && selectedIndex >= 0;
          const selectedIndices = Array.isArray(msg.selectedIndices)
            ? msg.selectedIndices
            : null;
          const validSelectedIndices =
            selectedIndices !== null &&
            selectedIndices.length > 0 &&
            selectedIndices.every((value) => Number.isInteger(value) && value >= 0);
          if (
            !surfaceId ||
            !result ||
            (result === "selected" && !validSelectedIndex && !validSelectedIndices) ||
            (result === "selected" && validSelectedIndex && validSelectedIndices) ||
            (result !== "selected" &&
              (hasOwn(msg, "selectedIndex") || hasOwn(msg, "selectedIndices")))
          ) {
            return null;
          }
          if (typeof onDemandResponse === "function") {
            try {
              const frame      = { surfaceId, result };
              if (surfaceId.startsWith("draft-launch-")) frame.clientId = clientId;
              if (result === "selected") frame.selectedIndex = selectedIndex;
              if (result === "selected" && validSelectedIndices) {
                delete frame.selectedIndex;
                frame.selectedIndices = selectedIndices;
              }

              if (result === "selected" && Array.isArray(msg.shownSites)) {
                const shown = msg.shownSites
                  .filter((host     ) => typeof host === "string" && host.length <= 253).slice(0, 8);
                if (shown.length) frame.shownSites = shown;
              }

              if (result === "dismissed" && msg.exit === "double_tap") frame.exit = "double_tap";
              onDemandResponse(frame);
            } catch (err) {
              logger.warn(
                `[downstream] demand_response handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        }
        case "liveui_state_report":

          if (typeof onLiveUiStateReport === "function") {
            try {
              const { type: _type, ...report } = msg;
              onLiveUiStateReport({
                clientId,
                report,
                authoritative: transportContext.liveuiStateReportAuthority?.eligible === true,
                authorityReason: transportContext.liveuiStateReportAuthority?.eligible === true
                  ? null : transportContext.liveuiStateReportAuthority?.reason || "unbound_send",
              });
            } catch (err     ) {
              logger.warn(
                `[downstream] liveui_state_report handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "glasses_ui_render_error":
          if (typeof onGlassesUiRenderError === "function") {
            onGlassesUiRenderError({
              clientId,
              surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
              seq: Number.isSafeInteger(msg.seq) && msg.seq > 0 ? msg.seq : null,
              code: typeof msg.code === "string" ? msg.code : "",
              sdkCode: Number.isSafeInteger(msg.sdkCode) ? msg.sdkCode : null,

              sessionKey: typeof msg.sessionKey === "string" ? msg.sessionKey : null,
              activeSessionKey:
                typeof msg.activeSessionKey === "string" ? msg.activeSessionKey : null,
              authoritative: transportContext.liveuiRenderErrorAuthority?.eligible === true,
              authorityReason: transportContext.liveuiRenderErrorAuthority?.eligible === true
                ? null : transportContext.liveuiRenderErrorAuthority?.reason || "unbound_send",
            });
          }
          return null;
        case "surface_render_receipt":

          if (typeof onGlassesUiRenderReceipt === "function") {
            try {
              onGlassesUiRenderReceipt({
                surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
                seq: Number.isFinite(msg.seq) ? Math.floor(msg.seq) : null,
              });
            } catch (err     ) {
              logger.warn(
                `[downstream] surface_render_receipt handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "liveui_picture_want":

          if (typeof onLiveUiPictureWant === "function") {
            try {
              onLiveUiPictureWant(clientId, msg);
            } catch (err     ) {
              logger.warn(
                `[downstream] liveui_picture_want handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "liveui_video_want":
          if (typeof onLiveUiVideoWant === "function") {
            try {
              onLiveUiVideoWant(clientId, msg);
            } catch (err     ) {
              logger.warn(
                `[downstream] liveui_video_want handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "reply_render_receipt":

          if (typeof onReplyRenderReceipt === "function") {
            try {
              onReplyRenderReceipt(
                { clientId, clientKind: isPhoneClient(clientId) === true ? "app" : "debug" },
                msg,
              );
            } catch (err     ) {
              logger.warn(
                `[downstream] reply_render_receipt handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "glasses_ui_nav_event":

          if (typeof onGlassesUiNavEvent === "function") {
            try {
              onGlassesUiNavEvent({
                surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
                depth: msg.depth === 0 ? 0 : Number.isFinite(msg.depth) ? Math.max(1, Math.floor(msg.depth)) : 1,

                ...(msg.action === "push_local" && typeof msg.childSurfaceId === "string"
                  ? {
                      action: "push_local",
                      childSurfaceId: msg.childSurfaceId,
                      itemIndex: Number.isInteger(msg.itemIndex) ? msg.itemIndex : null,
                    }
                  : {}),
              });
            } catch (err) {
              logger.warn(
                `[downstream] glasses_ui_nav_event handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "glasses_ui_render": {

          const id = parseOptionalTrimmedString(msg.id);
          if (!id) {

            if (typeof onGlassesUiRenderInject === "function") {
              try {
                const liveUiSession = resolveInjectedLiveUiSession(msg.sessionKey);
                onGlassesUiRenderInject({
                  surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
                  ...liveUiSession,
                  depth: Number.isFinite(msg.depth) ? Math.max(1, Math.floor(msg.depth)) : 1,
                  spec: msg.spec,
                });
              } catch (err) {
                logger.warn(
                  `[downstream] glasses_ui_render inject handler threw: ${err && err.message ? err.message : err}`,
                );
              }
            }
            return null;
          }
          const surfaceId = parseOptionalTrimmedString(msg.surfaceId);
          if (!surfaceId) {
            return { unicast: formatSendAckCompat(id, "rejected", "glasses_ui_render requires surfaceId") };
          }
          if (typeof onGlassesUiRenderInject !== "function") {
            return { unicast: formatSendAckCompat(id, "rejected", "glasses_ui_render not supported by relay") };
          }
          let glassesUiLiveConfig;
          try {
            glassesUiLiveConfig = getGlassesUiLiveConfig ? getGlassesUiLiveConfig() : undefined;
          } catch (_) {
            glassesUiLiveConfig = undefined;
          }
          let hostCheck      = null;
          try {
            hostCheck = getLiveuiHostCheck ? getLiveuiHostCheck() : null;
          } catch (_) {
            hostCheck = null;
          }
          const validation = validateGlassesUiInjectSpec(msg.spec, glassesUiLiveConfig, {
            hostCheck: typeof hostCheck === "function" ? hostCheck : undefined,
          });
          if (!validation.ok) {
            return {
              unicast: formatSendAckCompat(
                id,
                "rejected",
                validation.message || "Invalid glasses_ui_render spec",
                validation.code,
              ),
            };
          }
          if (msg.depth !== undefined && (!Number.isInteger(msg.depth) || msg.depth < 1)) {
            return { unicast: formatSendAckCompat(id, "rejected", "glasses_ui_render depth must be an integer >= 1") };
          }
          const marker = parseOptionalTrimmedString(msg.marker);
          if (marker && marker !== "listening" && marker !== "parked" && marker !== "inflight" && marker !== "processing" && marker !== "refreshing") {
            return { unicast: formatSendAckCompat(id, "rejected", "glasses_ui_render marker must be listening|parked|inflight|processing|refreshing") };
          }
          try {
            const liveUiSession = resolveInjectedLiveUiSession(msg.sessionKey);
            onGlassesUiRenderInject({
              surfaceId,
              ...liveUiSession,
              depth: msg.depth === undefined ? 1 : msg.depth,
              marker: marker || null,
              spec: validation.spec,
            });
            return { unicast: formatSendAckCompat(id, "accepted") };
          } catch (err) {
            return {
              unicast: formatSendAckCompat(
                id,
                "rejected",
                err && err.message ? err.message : "glasses_ui_render failed",
              ),
            };
          }
        }
        case "device_info_response":
          if (typeof onDeviceInfoResponse === "function") {
            try {
              onDeviceInfoResponse({
                requestId: typeof msg.requestId === "string" ? msg.requestId : "",
                ok: msg.ok === true,
                code: typeof msg.code === "string" ? msg.code : undefined,
                data: msg.data && typeof msg.data === "object" ? msg.data : undefined,
              });
            } catch (err) {
              logger.warn(
                `[downstream] device_info_response handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "glasses_presence_changed":
          if (typeof onGlassesPresenceChanged === "function") {
            try {
              onGlassesPresenceChanged({
                presence: typeof msg.presence === "string" ? msg.presence : "unknown",
              });
            } catch (err     ) {
              logger.warn(
                `[downstream] glasses_presence_changed handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "program_card_feeds":

          if (typeof onProgramCardFeeds === "function" && admitPhoneOnlyWrite(clientId, msg.type)) {
            try {
              onProgramCardFeeds({
                op: msg.op === "subscribe" || msg.op === "unsubscribe" ? msg.op : "",
                sub: typeof msg.sub === "string" ? msg.sub : "",
                card: typeof msg.card === "string" ? msg.card : "",
                feeds: Array.isArray(msg.feeds) ? msg.feeds : [],

                block: Array.isArray(msg.block) ? msg.block : [],
                ...(msg.sites === "ask" || msg.sites === "off" ? { sites: msg.sites } : {}),
              });
            } catch (err     ) {
              logger.warn(
                `[downstream] program_card_feeds handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "program_card_pictures":

          if (typeof onProgramCardPictures === "function" && admitPhoneOnlyWrite(clientId, msg.type)) {
            try {
              onProgramCardPictures(clientId, msg);
            } catch (err     ) {
              logger.warn(
                `[downstream] program_card_pictures handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "program_card_jev":

          if (typeof onProgramCardJev === "function" && admitPhoneOnlyWrite(clientId, msg.type)) {
            try {
              onProgramCardJev({
                op: typeof msg.op === "string" ? msg.op : "",
                sub: typeof msg.sub === "string" ? msg.sub : "",
                ...(msg.card && typeof msg.card === "object" && !Array.isArray(msg.card) ? { card: msg.card } : {}),
                ...(Array.isArray(msg.uses) ? { uses: msg.uses } : {}),
                ...(typeof msg.from === "string" ? { from: msg.from } : {}),
                ...(Array.isArray(msg.asks) ? { asks: msg.asks } : {}),
                ...(typeof msg.key === "string" ? { key: msg.key } : {}),
                ...(typeof msg.digest === "string" ? { digest: msg.digest } : {}),
                ...(typeof msg.allow === "boolean" ? { allow: msg.allow } : {}),
              });
            } catch (err     ) {
              logger.warn(
                `[downstream] program_card_jev handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "program_card_model":
          if (typeof onProgramCardModel === "function" && admitPhoneOnlyWrite(clientId, msg.type)) {
            onProgramCardModel(msg, clientId);
          }
          return null;
        case "program_card_art":

          if (typeof onProgramCardArt === "function" && admitPhoneOnlyWrite(clientId, msg.type)) {
            try {
              onProgramCardArt({
                op: typeof msg.op === "string" ? msg.op : "",
                ...(typeof msg.detail === "string" ? { detail: msg.detail } : {}),
              }, clientId);
            } catch (err     ) {
              logger.warn(`[downstream] program_card_art handler threw: ${err && err.message ? err.message : err}`);
            }
          }
          return null;
        case "program_card_location":

          if (typeof onProgramCardLocation === "function" && admitPhoneOnlyWrite(clientId, msg.type)) {
            try {
              onProgramCardLocation(clientId, msg);
            } catch (err     ) {
              logger.warn(
                `[downstream] program_card_location handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "program_card_mcp":

          if (typeof onProgramCardMcp === "function" && admitPhoneOnlyWrite(clientId, msg.type)) {
            try {
              onProgramCardMcp({
                op: typeof msg.op === "string" ? msg.op : "",
                sub: typeof msg.sub === "string" ? msg.sub : "",
                ...(msg.card && typeof msg.card === "object" && !Array.isArray(msg.card) ? { card: msg.card } : {}),
                ...(Array.isArray(msg.uses) ? { uses: msg.uses } : {}),
                ...(typeof msg.from === "string" ? { from: msg.from } : {}),
                ...(Array.isArray(msg.calls) ? { calls: msg.calls } : {}),
                ...(typeof msg.key === "string" ? { key: msg.key } : {}),
                ...(typeof msg.digest === "string" ? { digest: msg.digest } : {}),
                ...(typeof msg.allow === "boolean" ? { allow: msg.allow } : {}),
                ...(typeof msg.server === "string" ? { server: msg.server } : {}),

                ...(typeof msg.id === "string" ? { id: msg.id } : {}),
                ...(typeof msg.send === "boolean" ? { send: msg.send } : {}),
                ...(typeof msg.via === "string" ? { via: msg.via } : {}),
                ...(typeof msg.request === "string" ? { request: msg.request } : {}),
                ...(typeof msg.use === "string" ? { use: msg.use } : {}),
                ...(typeof msg.level === "string" ? { level: msg.level } : {}),
                ...(typeof msg.autoSend === "boolean" ? { autoSend: msg.autoSend } : {}),
                ...(typeof msg.tool === "string" ? { tool: msg.tool } : {}),
                ...(typeof msg.write === "boolean" ? { write: msg.write } : {}),

                ...(typeof msg.on === "boolean" ? { on: msg.on } : {}),
                ...(typeof msg.warned === "boolean" ? { warned: msg.warned } : {}),
                ...(typeof msg.part === "string" ? { part: msg.part } : {}),

                ...(typeof msg.action === "string" ? { action: msg.action } : {}),
                ...(typeof msg.name === "string" ? { name: msg.name } : {}),
              });
            } catch (err     ) {
              logger.warn(
                `[downstream] program_card_mcp handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "location_response":
          if (typeof onLocationResponse === "function") {
            try {
              onLocationResponse({
                clientId,
                requestId: typeof msg.requestId === "string" ? msg.requestId : "",
                ok: msg.ok === true,
                code: typeof msg.code === "string" ? msg.code : undefined,
                data: msg.data && typeof msg.data === "object" ? msg.data : undefined,
              });
            } catch (err) {
              logger.warn(
                `[downstream] location_response handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case APP_PROTOCOL.programCardLookProgress:
          if (typeof onProgramCardLookProgress === "function") {
            onProgramCardLookProgress({ clientId, sessionKey: typeof msg.sessionKey === "string" ? msg.sessionKey : null,
              requestId: typeof msg.requestId === "string" ? msg.requestId : "", detail: typeof msg.detail === "string" ? msg.detail : "",

              ...(msg.frameLayout && typeof msg.frameLayout === "object" && !Array.isArray(msg.frameLayout) ? { frameLayout: msg.frameLayout } : {}) });
          }
          return null;
        case "program_card_response":
          if (typeof onProgramCardResponse === "function") {
            try {
              onProgramCardResponse({
                clientId,
                sessionKey: typeof msg.sessionKey === "string" ? msg.sessionKey : null,
                requestId: typeof msg.requestId === "string" ? msg.requestId : "",
                ok: msg.ok === true,
                shown: msg.shown === true,
                error: typeof msg.error === "string" ? msg.error : null,

                ...(msg.result && typeof msg.result === "object" && !Array.isArray(msg.result) ? { result: msg.result } : {}),

                ...(msg.jev && typeof msg.jev === "object" && !Array.isArray(msg.jev) ? { jev: msg.jev } : {}),

                ...(msg.mcp && typeof msg.mcp === "object" && !Array.isArray(msg.mcp) ? { mcp: msg.mcp } : {}),
                ...(msg.model && typeof msg.model === "object" && !Array.isArray(msg.model) ? { model: msg.model } : {}),

                ...(msg.refresh && typeof msg.refresh === "object" && !Array.isArray(msg.refresh) ? { refresh: msg.refresh } : {}),
              });
            } catch (err     ) {
              logger.warn(
                `[downstream] program_card_response handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;

        case "program_card_context":
          if (typeof onProgramCardContext === "function" && typeof msg.sessionKey === "string" && msg.sessionKey) {
            try {
              onProgramCardContext({
                clientId,
                sessionKey: msg.sessionKey,
                card: msg.card && typeof msg.card === "object" && !Array.isArray(msg.card) ? msg.card : { open: false },
              });
            } catch (err     ) {
              logger.warn(
                `[downstream] program_card_context handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        default:
          return null;
      }
    },

    formatPages,
    formatEntries,
    formatStatus,
    formatActivity,
    formatThinkingUpdate,
    formatThinkingFinalize,
    formatRunSignal,
    formatCardBuild,
    formatTyping,
    formatSendAck: formatSendAckCompat,
    formatProtocol,
    formatStreaming,
    formatStreamClear,
    formatSessions,
    formatSessionDiff,
    sessionInfoFingerprint,
    formatSessionSwitched,
    formatSessionSwitchRejected,
    formatSessionDriverState,
    formatModelsCatalog,
    formatSkillsCatalog,
    formatLiveuiLibrary,
    formatLiveuiLibraryOpenResult,
    formatProgramCardSaveRequest,
    formatProgramCardReview,
    formatLiveuiTasks,
    formatLiveuiTaskReviewAck,
    formatLiveuiTaskExecutors,
    formatLiveuiTaskExecutorAck,
    formatLiveuiTaskPreferredTemplateAck,
    formatLiveuiTaskContextAck,
    formatLiveuiTaskSettingsAck,
    formatLiveuiPrefs,
    formatLiveuiPrefsAck,
    formatLiveuiGrantsSnapshot,
    formatLiveuiGrantsAck,
    formatLiveuiStatus,
    formatCommandCatalog,
    formatAgentsCatalog,
    formatAgentCreateResult,
    formatAgentEmojiSetResult,
    formatSonioxModels,
    formatHermesSttCapabilities,
    formatHermesSttTranscribeResult,
    formatProviderUsageSnapshot,
    formatCapabilitySnapshot,
    formatPushMessage,
    formatSessionModelConfig,
    formatSessionModelConfigAck,
    formatEvenAiSettings,
    formatOcuClawSettings,
    formatSavedPrompts,
    formatSavedPromptsAck,
    formatEvenAiSessions,
    formatEvenAiSettingsAck,
    formatOcuClawSettingsAck,
    formatApproval,
    formatApprovalExplanation,
    formatApprovalExplanationPending,
    formatApprovalResolved,
    formatApprovalResponseAck,
    formatWaiting,
    formatTranscription,
    formatListenCommitted,
    formatEvenAiListenIntercepted,
    formatListenEnded,
    formatListenError,
    formatListenReady,
    formatScriptedListenReady,
    formatSonioxTemporaryKey,
    formatSonioxTemporaryKeyError,
    formatDebugSet,
    formatDebugDump,
    formatDebugConfigSnapshot,
    formatRemoteControl,
    formatRemoteControlAck,
    formatAutomationStateRequest,
    formatAutomationStateSnapshot,
    formatAutomationRegistry,
    formatReadinessProbeRequest,
    formatReadinessProbeAck,
    formatError,

    isProtocolSubscriber(clientId) {
      return protocolSubscribers.has(clientId);
    },

    removeClient(clientId) {
      protocolSubscribers.delete(clientId);
      if (typeof opts.onOptionalSetupDisconnect === "function") opts.onOptionalSetupDisconnect(clientId);
      if (typeof opts.onModelSitesDisconnect === "function") opts.onModelSitesDisconnect(clientId);
      realtimeTalkLane?.removeClient(clientId);
      return hermesSttUpload?.removeClient(clientId);
    },
  };
}

module.exports = { sanitizeProtocolFrame, parseEventDebug, createDownstreamHandler };
