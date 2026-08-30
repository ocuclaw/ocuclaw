const { normalizeEvenAiRoutingMode, normalizeEvenAiDefaultAgent } = require("../even-ai/even-ai-settings-store.cjs");
const { activeBackendDisplayName } = require("../gateway/backend-contract.cjs");
const { normalizeOcuClawDefaultModel, normalizeOcuClawDefaultThinking, normalizeOcuClawAgentProgressNotes, normalizeOcuClawSystemPrompt, normalizeOcuClawDefaultAgent, normalizeOcuClawEvenAiSection, normalizeOcuClawEvenAiPeer, normalizeOcuClawPathwayBinding, normalizeOcuClawPathways } = require("./ocuclaw-settings-store.cjs");
const { formatMainOperationReceived, formatSendAck } = require("./relay-worker-protocol.cjs");
const { CAPABILITY_SNAPSHOT_TYPE, PUSH_MESSAGE_TYPE } = require("./capability-snapshot.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { validateGlassesUiSpec } = require("../tools/glasses-ui-tool.cjs");
const { normalizeSonioxTemporaryKeyErrorCodeForDownstream: normalizeSonioxTemporaryKeyErrorCode } = require("../domain/soniox-temp-key-errors.cjs");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY } = require("../domain/even-ai-session-keys.cjs");
const { isForeignHermesSessionKey } = require("./hermes-session-keys.cjs");

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
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
  const onSimulateTool = opts.onSimulateTool || null;
  const onSimulateApproval = opts.onSimulateApproval || null;
  const onSimulateDemand = opts.onSimulateDemand || null;
  const onSimulateVoice = opts.onSimulateVoice || null;
  const onNewChat = opts.onNewChat;
  const onGetSessions = opts.onGetSessions;
  const onSwitchSession = opts.onSwitchSession;
  const onCopySession = opts.onCopySession;
  const onNewSession = opts.onNewSession;
  const createEtSession = opts.createEtSession || null;
  const onSlashCommand = opts.onSlashCommand;
  const onGetModelsCatalog = opts.onGetModelsCatalog;
  const onGetSkillsCatalog = opts.onGetSkillsCatalog;
  const onGetLiveuiLibrary = opts.onGetLiveuiLibrary || null;
  const onOpenLiveuiLibraryItem = opts.onOpenLiveuiLibraryItem || null;
  const onCancelLiveuiTaskLaunch = opts.onCancelLiveuiTaskLaunch || null;
  const onGetLiveuiTasksForPhone = opts.onGetLiveuiTasksForPhone || null;
  const onGetLiveuiTaskRunsForPhone = opts.onGetLiveuiTaskRunsForPhone || null;
  const onGetLiveuiTaskExecutors = opts.onGetLiveuiTaskExecutors || null;
  const onSetLiveuiTaskExecutor = opts.onSetLiveuiTaskExecutor || null;
  const onSetLiveuiTaskSettingValues = opts.onSetLiveuiTaskSettingValues || null;
  const onSetLiveuiTaskPreferredTemplate = opts.onSetLiveuiTaskPreferredTemplate || null;
  const isPhoneClient = typeof opts.isPhoneClient === "function"
    ? opts.isPhoneClient
    : () => true;
  const onReviewLiveuiTask = opts.onReviewLiveuiTask || null;
  const onSetLiveuiTaskContext = opts.onSetLiveuiTaskContext || null;
  const onGetLiveuiPrefs = opts.onGetLiveuiPrefs || null;
  const onSetLiveuiPrefs = opts.onSetLiveuiPrefs || null;
  const onGetLiveuiStatus = opts.onGetLiveuiStatus || null;
  const onOrganizeLiveuiLibrary = opts.onOrganizeLiveuiLibrary || null;
  const onGetCommandCatalog = opts.onGetCommandCatalog;
  const onGetAgentsCatalog = opts.onGetAgentsCatalog;
  const onGetSonioxModels = opts.onGetSonioxModels || null;
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
  const onGlassesUiSurfaceUpdateInject = opts.onGlassesUiSurfaceUpdateInject || null;
  const onGlassesUiNavEvent = opts.onGlassesUiNavEvent || null;

  const onGlassesUiRenderReceipt = opts.onGlassesUiRenderReceipt || null;
  const onDeviceInfoResponse = opts.onDeviceInfoResponse || null;
  const onGlassesPresenceChanged = opts.onGlassesPresenceChanged || null;
  const onLocationResponse = opts.onLocationResponse || null;
  const onSetUserSessionTitle = opts.onSetUserSessionTitle || null;
  const onSetSessionPinned = opts.onSetSessionPinned || null;
  const onSetSessionHidden = opts.onSetSessionHidden || null;
  const onDeleteSessions = opts.onDeleteSessions || null;
  const onSearchTranscripts = opts.onSearchTranscripts || null;
  const onDebugBundleRequest = opts.onDebugBundleRequest || null;
  const onDebugBundleSave = opts.onDebugBundleSave || null;
  const onDebugBundleFetch = opts.onDebugBundleFetch || null;
  const getSnapshotRevision = opts.getSnapshotRevision || null;
  const operationRegistry = opts.operationRegistry || null;
  const resolveEtSendKey = opts.resolveEtSendKey || null;
  const sendEtPrompt = opts.sendEtPrompt || null;
  const tryEtAbort = opts.tryEtAbort || null;
  const defaultEvenAiDedicatedSessionKey =
    typeof opts.defaultEvenAiDedicatedSessionKey === "string" &&
    opts.defaultEvenAiDedicatedSessionKey.trim()
      ? opts.defaultEvenAiDedicatedSessionKey.trim()
      : DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY;

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
  const APP_PROTOCOL = {
    activity: "ocuclaw.activity.update",
    automationStateGet: "ocuclaw.automation.state.get",
    automationStateSnapshot: "ocuclaw.automation.state.snapshot",
    automationRegistryGet: "ocuclaw.automation.registry.get",
    automationRegistry: "ocuclaw.automation.registry",
    approvalRequest: "ocuclaw.approval.request",
    approvalResolve: "ocuclaw.approval.resolve",
    approvalResolveAck: "ocuclaw.approval.resolve.ack",
    approvalResolved: "ocuclaw.approval.resolved",
    commandCatalogGet: "ocuclaw.command.catalog.get",
    commandCatalogSnapshot: "ocuclaw.command.catalog.snapshot",
    commandSlash: "ocuclaw.command.slash",
    debugConfigSnapshot: "ocuclaw.debug.config.snapshot",
    debugEvent: "ocuclaw.debug.event",
    evenAiSettingsGet: "ocuclaw.evenai.settings.get",
    evenAiSessionList: "ocuclaw.evenai.session.list",
    evenAiSessionListResult: "ocuclaw.evenai.session.list.result",
    evenAiSettingsSet: "ocuclaw.evenai.settings.set",
    evenAiSettingsSetAck: "ocuclaw.evenai.settings.set.ack",
    evenAiSettingsSnapshot: "ocuclaw.evenai.settings.snapshot",
    ocuClawSettingsGet: "ocuclaw.settings.get",
    ocuClawSettingsSet: "ocuclaw.settings.set",
    ocuClawSettingsSetAck: "ocuclaw.settings.set.ack",
    ocuClawSettingsSnapshot: "ocuclaw.settings.snapshot",
    messageSend: "ocuclaw.message.send",
    messageSendAck: "ocuclaw.message.send.ack",
    messageStreamDelta: "ocuclaw.message.stream.delta",
    messageStreamClear: "ocuclaw.message.stream.clear",
    thinkingFinalize: "ocuclaw.thinking.finalize",
    thinkingUpdate: "ocuclaw.thinking.update",
    modelCatalogGet: "ocuclaw.model.catalog.get",
    modelCatalogSnapshot: "ocuclaw.model.catalog.snapshot",
    providerUsageGet: "ocuclaw.provider.usage.get",
    providerUsageSnapshot: "ocuclaw.provider.usage.snapshot",
    skillsCatalogGet: "ocuclaw.skills.catalog.get",
    skillsCatalogSnapshot: "ocuclaw.skills.catalog.snapshot",
    liveuiLibraryGet: "ocuclaw.liveui.library.get",
    liveuiLibrarySnapshot: "ocuclaw.liveui.library.snapshot",
    liveuiLibraryOpen: "ocuclaw.liveui.library.open",
    liveuiLibraryOpenResult: "ocuclaw.liveui.library.open.result",
    liveuiTaskCancel: "ocuclaw.liveui.task.cancel",
    liveuiTasksGet: "ocuclaw.liveui.tasks.get",
    liveuiTasksSnapshot: "ocuclaw.liveui.tasks.snapshot",
    liveuiTaskRunsGet: "ocuclaw.liveui.task.runs.get",
    liveuiTaskRunsSnapshot: "ocuclaw.liveui.task.runs.snapshot",
    liveuiTaskReview: "ocuclaw.liveui.task.review",
    liveuiTaskReviewAck: "ocuclaw.liveui.task.review.ack",
    liveuiTaskExecutorsGet: "ocuclaw.liveui.task.executors.get",
    liveuiTaskExecutorsSnapshot: "ocuclaw.liveui.task.executors.snapshot",
    liveuiTaskExecutorSet: "ocuclaw.liveui.task.executor.set",
    liveuiTaskExecutorAck: "ocuclaw.liveui.task.executor.ack",
    liveuiTaskPreferredTemplateSet: "ocuclaw.liveui.task.preferred_template.set",
    liveuiTaskPreferredTemplateAck: "ocuclaw.liveui.task.preferred_template.ack",
    liveuiTaskContextSet: "ocuclaw.liveui.task.context.set",
    liveuiTaskContextAck: "ocuclaw.liveui.task.context.ack",
    liveuiTaskSettingsSet: "ocuclaw.liveui.task.settings.set",
    liveuiTaskSettingsAck: "ocuclaw.liveui.task.settings.ack",
    liveuiLibraryOrganize: "ocuclaw.liveui.library.organize",
    liveuiLibraryOrganizeAck: "ocuclaw.liveui.library.organize.ack",
    liveuiPrefsGet: "ocuclaw.liveui.prefs.get",
    liveuiPrefsSet: "ocuclaw.liveui.prefs.set",
    liveuiPrefsSnapshot: "ocuclaw.liveui.prefs.snapshot",
    liveuiPrefsAck: "ocuclaw.liveui.prefs.ack",
    liveuiStatusGet: "ocuclaw.liveui.status.get",
    liveuiStatusSnapshot: "ocuclaw.liveui.status",
    agentsCatalogGet: "ocuclaw.agent.catalog.get",
    agentsCatalogSnapshot: "ocuclaw.agent.catalog.snapshot",
    entries: "ocuclaw.ledger.entries",
    ledgerCursor: "ocuclaw.ledger.cursor",
    ledgerResyncRequest: "ocuclaw.ledger.resync.request",
    pages: "ocuclaw.view.pages.snapshot",
    protocolSubscribe: "ocuclaw.protocol.tap.subscribe",
    protocolFrame: "ocuclaw.protocol.tap.frame",
    readinessProbeAck: "ocuclaw.readiness.probe.ack",
    readinessProbeRequest: "ocuclaw.readiness.probe.request",
    remoteControl: "ocuclaw.remote.control",
    requestSonioxTemporaryKey: "requestSonioxTemporaryKey",
    requestCartesiaAccessToken: "requestCartesiaAccessToken",
    sonioxModelsGet: "ocuclaw.voice.soniox.models.get",
    sonioxModelsSnapshot: "ocuclaw.voice.soniox.models.snapshot",
    sessionConfigGet: "ocuclaw.session.config.get",
    sessionConfigSet: "ocuclaw.session.config.set",
    sessionConfigSetAck: "ocuclaw.session.config.set.ack",
    sessionConfigSnapshot: "ocuclaw.session.config.snapshot",
    sessionAgentSet: "ocuclaw.session.agent.set",
    sessionAgentSetAck: "ocuclaw.session.agent.set.ack",
    sessionAbort: "ocuclaw.session.abort",
    sessionAbortAck: "ocuclaw.session.abort.ack",
    sessionCompact: "ocuclaw.session.compact",
    sessionCompactAck: "ocuclaw.session.compact.ack",
    sessionCreate: "ocuclaw.session.create",
    sessionCreateEt: "ocuclaw.session.create.et",
    sessionCopy: "ocuclaw.session.copy",
    sessionCopyAck: "ocuclaw.session.copy.ack",
    sessionHiddenSet: "ocuclaw.session.hidden.set",
    sessionList: "ocuclaw.session.list",
    sessionListDiff: "ocuclaw.session.list.diff",
    sessionListDiffResult: "ocuclaw.session.list.diff.result",
    sessionListResult: "ocuclaw.session.list.result",
    sessionReset: "ocuclaw.session.reset",
    sessionSteer: "ocuclaw.session.steer",
    sessionSwitch: "ocuclaw.session.switch",
    sessionSwitchApplied: "ocuclaw.session.switch.applied",
    sessionSwitchRejected: "ocuclaw.session.switch.rejected",
    sessionTitleSet: "ocuclaw.session.title.set",
    sonioxTemporaryKey: "sonioxTemporaryKey",
    sonioxTemporaryKeyError: "sonioxTemporaryKeyError",
    cartesiaAccessToken: "cartesiaAccessToken",
    cartesiaAccessTokenError: "cartesiaAccessTokenError",
    capabilitySnapshot: CAPABILITY_SNAPSHOT_TYPE,
    pushMessage: PUSH_MESSAGE_TYPE,
    status: "ocuclaw.runtime.status",
    statusGet: "ocuclaw.runtime.status.get",
    typingUpdate: "ocuclaw.typing.update",
  };

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
      ...(normalizedAssistantCommit ? { assistantCommit: normalizedAssistantCommit } : {}),
    };
    return JSON.stringify(msg);
  }

  function formatEntries(snapshot = {}, sessionId = "") {
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

  function formatActivity(activity) {
    return JSON.stringify({ ...activity, type: APP_PROTOCOL.activity });
  }

  function formatThinkingUpdate(update) {
    return JSON.stringify({ ...update, type: APP_PROTOCOL.thinkingUpdate });
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
      messageType === "simulateStreamCancel" ||
      messageType === "simulateActivity" ||
      messageType === "simulateTool" ||
      messageType === "simulateApproval" ||
      messageType === "simulateDemand" ||

      messageType === "simulateEtDemand" ||
      messageType === "simulateVoice"
    );
  }

  function formatSendAckCompat(id, status, error, errorCode, data = undefined) {
    return formatSendAck(id, status, error, errorCode, data);
  }

  function formatSessionAbortAck(data = {}) {
    const msg = {
      type: APP_PROTOCOL.sessionAbortAck,
      requestId: parseOptionalTrimmedString(data.requestId),
      status: data.status || "accepted",
    };
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
      frame,
    });
  }

  function formatStreaming(text, emojiSpans, paceSpans, meta = {}) {
    const payload = {
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
    if (
      normalized === "ocuclaw" ||
      normalized === "evenai" ||
      normalized === "terminal"
    ) {
      return normalized;
    }
    return null;
  }

  function isTerminalSessionKey(key) {
    return typeof key === "string" && key.trim().toLowerCase().startsWith("et:");
  }

  function isSessionInDiffKind(kind, row) {
    const key = typeof row === "string" ? row : row && row.key;
    if (kind === "terminal") return isTerminalSessionKey(key);
    if (kind === "ocuclaw") return !isTerminalSessionKey(key);
    return true;
  }

  function parseKnownSessionRows(msg) {
    if (!msg || !Array.isArray(msg.known)) return [];
    const out = [];
    for (const item of msg.known) {
      if (!item || typeof item !== "object") continue;
      const key = typeof item.key === "string" ? item.key.trim() : "";
      if (!key) continue;
      out.push({
        key,
        updatedAt: Number.isFinite(Number(item.updatedAt))
          ? Math.floor(Number(item.updatedAt))
          : 0,
        fingerprint:
          typeof item.fingerprint === "string" ? item.fingerprint.trim() : "",
      });
    }
    return out;
  }

  function buildSessionDiff({ kind, sessions, known, limit, dedicatedKey }) {
    const normalizedKind = normalizeSessionDiffKind(kind);
    if (!normalizedKind) throw new Error("invalid_session_diff_kind");
    const normalizedLimit = normalizeSessionDiffLimit(limit);
    const rows = Array.isArray(sessions)
      ? sessions.filter((row) => isSessionInDiffKind(normalizedKind, row))
      : [];
    const limitedRows = rows
      .slice()
      .sort((left, right) => (Number(right && right.updatedAt) || 0) - (Number(left && left.updatedAt) || 0))
      .slice(0, normalizedLimit);
    const knownByKey = new Map();
    for (const row of Array.isArray(known) ? known : []) {
      if (!isSessionInDiffKind(normalizedKind, row)) continue;
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
      if (!isSessionInDiffKind(normalizedKind, rawKey)) continue;
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

  function formatSessionSwitched(sessionKey, requestId = "", draft = false) {
    return JSON.stringify({
      type: APP_PROTOCOL.sessionSwitchApplied,
      sessionKey,
      ...(draft === true ? { draft: true } : {}),
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

  function formatModelsCatalog(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.modelCatalogSnapshot,
      models: Array.isArray(payload && payload.models) ? payload.models : [],
      fetchedAtMs:
        Number.isFinite(payload && payload.fetchedAtMs)
          ? Math.floor(payload.fetchedAtMs)
          : 0,
      stale: !!(payload && payload.stale),
    });
  }

  function formatSkillsCatalog(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.skillsCatalogSnapshot,
      skills: Array.isArray(payload && payload.skills) ? payload.skills : [],
      fetchedAtMs:
        Number.isFinite(payload && payload.fetchedAtMs)
          ? Math.floor(payload.fetchedAtMs)
          : Date.now(),
      stale: !!(payload && payload.stale),
    });
  }

  function formatLiveuiLibrary(items) {
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiLibrarySnapshot,
      items: Array.isArray(items) ? items : [],
    });
  }

  function formatLiveuiLibraryOpenResult(payload = {}) {
    const status = payload.status === "accepted" ? "accepted" : "rejected";
    const code = typeof payload.code === "string" && payload.code ? payload.code : null;
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiLibraryOpenResult,
      itemType: typeof payload.itemType === "string" ? payload.itemType : "",
      itemId: typeof payload.itemId === "string" ? payload.itemId : "",
      status,
      ...(status === "rejected" && code ? { code } : {}),
    });
  }

  function normalizeLiveuiTaskRunning(value) {
    if (!value || typeof value !== "object") return null;
    const runId = typeof value.runId === "string" ? value.runId : "";
    if (!runId) return null;
    return {
      since: Number.isSafeInteger(value.since) ? value.since : 0,
      executor: typeof value.executor === "string" ? value.executor : "",
      runId,
    };
  }

  function formatLiveuiTasks(payload = {}) {
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiTasksSnapshot,
      tasks: tasks.map((task) =>
        task && typeof task === "object"
          ? { ...task, running: normalizeLiveuiTaskRunning(task.running) }
          : task,
      ),
      templates: Array.isArray(payload.templates) ? payload.templates : [],
      invalid: Array.isArray(payload.invalid) ? payload.invalid : [],
      organization: payload.organization && typeof payload.organization === "object"
        ? payload.organization
        : { schemaVersion: 1, order: [], hidden: [], digest: "" },
      ...(typeof payload.organizationInvalid === "string" && payload.organizationInvalid
        ? { organizationInvalid: payload.organizationInvalid }
        : {}),
    });
  }

  function formatLiveuiTaskRuns(taskId, records) {
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiTaskRunsSnapshot,
      taskId: typeof taskId === "string" ? taskId : "",
      records: Array.isArray(records) ? records : [],
    });
  }

  function formatLiveuiTaskReviewAck(payload = {}) {
    const status = payload.status === "accepted" ? "accepted" : "rejected";
    const code = typeof payload.code === "string" && payload.code ? payload.code : null;
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiTaskReviewAck,
      taskId: typeof payload.taskId === "string" ? payload.taskId : "",
      action: typeof payload.action === "string" ? payload.action : "",
      status,
      ...(status === "rejected" && code ? { code } : {}),
      ...(status === "rejected" && typeof payload.message === "string" && payload.message
        ? { message: payload.message }
        : {}),
      ...(payload.task && typeof payload.task === "object" ? { task: payload.task } : {}),
    });
  }

  function formatLiveuiTaskExecutors(payload = {}) {
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiTaskExecutorsSnapshot,
      thisHost: payload.thisHost === "hermes" ? "hermes" : "openclaw",
      executors: Array.isArray(payload.executors) ? payload.executors : [],
    });
  }

  function formatLiveuiTaskExecutorAck(payload = {}) {
    const status = payload.status === "accepted" ? "accepted" : "rejected";
    const code = typeof payload.code === "string" && payload.code ? payload.code : null;
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiTaskExecutorAck,
      taskId: typeof payload.taskId === "string" ? payload.taskId : "",
      status,
      ...(status === "rejected" && code ? { code } : {}),
    });
  }

  function formatLiveuiTaskPreferredTemplateAck(payload = {}) {
    const status = payload.status === "accepted" ? "accepted" : "rejected";
    const code = typeof payload.code === "string" && payload.code ? payload.code : null;
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiTaskPreferredTemplateAck,
      taskId: typeof payload.taskId === "string" ? payload.taskId : "",
      status,
      ...(status === "rejected" && code ? { code } : {}),
      ...(payload.task && typeof payload.task === "object" ? { task: payload.task } : {}),
    });
  }

  function formatLiveuiTaskContextAck(payload = {}) {
    const status = payload.status === "accepted" ? "accepted" : "rejected";
    const code = typeof payload.code === "string" && payload.code ? payload.code : null;
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiTaskContextAck,
      taskId: typeof payload.taskId === "string" ? payload.taskId : "",
      status,
      ...(status === "rejected" && code ? { code } : {}),
    });
  }

  function formatLiveuiPrefs(payload = {}) {
    const prefs = payload && typeof payload === "object" ? payload : {};
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiPrefsSnapshot,
      enabled: prefs.enabled !== false,
      defaultContext: prefs.defaultContext === "current_session" ? "current_session" : "isolated",
      defaultExecutor: typeof prefs.defaultExecutor === "string" && prefs.defaultExecutor
        ? prefs.defaultExecutor
        : null,
      pauseApps: prefs.pauseApps === true,
      ...(typeof prefs.prefsInvalid === "string" && prefs.prefsInvalid
        ? { prefsInvalid: prefs.prefsInvalid }
        : {}),
    });
  }

  function formatLiveuiPrefsAck(payload = {}) {
    const status = payload.status === "accepted" ? "accepted" : "rejected";
    const code = typeof payload.code === "string" && payload.code ? payload.code : null;
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiPrefsAck,
      status,
      ...(status === "rejected" && code ? { code } : {}),
    });
  }

  function formatLiveuiStatus(payload = {}) {
    const status = payload && typeof payload === "object" ? payload : {};
    const asInt = (value) => (Number.isFinite(value) ? Math.floor(value) : 0);
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiStatusSnapshot,
      host: status.host === "hermes" ? "hermes" : "openclaw",
      refreshEnabled: status.refreshEnabled !== false,
      httpEnabled: status.httpEnabled === true,
      allowedDomains: asInt(status.allowedDomains),
      llmEnabled: status.llmEnabled === true,
      allowAgentModelOverride: status.allowAgentModelOverride === true,
      surfaces: asInt(status.surfaces),
      maxSurfaces: Number.isFinite(status.maxSurfaces) ? Math.floor(status.maxSurfaces) : 1,
      stageGraceMs: asInt(status.stageGraceMs),
      approvalHudSupported: status.approvalHudSupported !== false,
    });
  }

  function formatLiveuiTaskSettingsAck(payload = {}) {
    const status = payload.status === "accepted" ? "accepted" : "rejected";
    const code = typeof payload.code === "string" && payload.code ? payload.code : null;
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiTaskSettingsAck,
      taskId: typeof payload.taskId === "string" ? payload.taskId : "",
      status,
      ...(status === "rejected" && code ? { code } : {}),
      ...(status === "rejected" && Array.isArray(payload.invalid)
        ? { invalid: payload.invalid.map((entry) => ({
            key: entry && typeof entry.key === "string" ? entry.key : "",
            code: entry && typeof entry.code === "string" ? entry.code : "setting_value_invalid",
          })) }
        : {}),
      ...(payload.task && typeof payload.task === "object" ? { task: payload.task } : {}),
    });
  }

  function formatLiveuiLibraryOrganizeAck(payload = {}) {
    const status = payload.status === "accepted" ? "accepted" : "rejected";
    const code = typeof payload.code === "string" && payload.code ? payload.code : null;
    const message = typeof payload.message === "string" && payload.message ? payload.message : null;
    return JSON.stringify({
      type: APP_PROTOCOL.liveuiLibraryOrganizeAck,
      action: typeof payload.action === "string" ? payload.action : "",
      status,
      ...(status === "rejected" && code ? { code } : {}),
      ...(status === "rejected" && message ? { message } : {}),
      ...(status === "accepted" && Array.isArray(payload.clearedPreferredTemplateTaskIds)
        ? { clearedPreferredTemplateTaskIds: payload.clearedPreferredTemplateTaskIds }
        : {}),
    });
  }

  function formatCommandCatalog(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.commandCatalogSnapshot,
      commands: Array.isArray(payload && payload.commands) ? payload.commands : [],
      fetchedAtMs:
        Number.isFinite(payload && payload.fetchedAtMs)
          ? Math.floor(payload.fetchedAtMs)
          : Date.now(),
      stale: !!(payload && payload.stale),
      unsupported: !!(payload && payload.unsupported),
      backendKind:
        typeof (payload && payload.backendKind) === "string" && payload.backendKind
          ? payload.backendKind
          : "none",
      executes: (payload && payload.executes) === "all" ? "all" : "intercepted-only",
    });
  }

  function formatAgentsCatalog(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.agentsCatalogSnapshot,
      agents: Array.isArray(payload && payload.agents) ? payload.agents : [],
      defaultId:
        payload && typeof payload.defaultId === "string"
          ? payload.defaultId
          : null,
      mainKey:
        payload && typeof payload.mainKey === "string" ? payload.mainKey : null,
      scope:
        payload && typeof payload.scope === "string" ? payload.scope : null,
      fetchedAtMs:
        Number.isFinite(payload && payload.fetchedAtMs)
          ? Math.floor(payload.fetchedAtMs)
          : Date.now(),
      stale: !!(payload && payload.stale),
      unsupported: !!(payload && payload.unsupported),
    });
  }

  function formatSonioxModels(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.sonioxModelsSnapshot,
      models: Array.isArray(payload && payload.models) ? payload.models : [],
      fetchedAtMs:
        Number.isFinite(payload && payload.fetchedAtMs)
          ? Math.floor(payload.fetchedAtMs)
          : 0,
      stale: !!(payload && payload.stale),
    });
  }

  function formatProviderUsageSnapshot(payload) {
    const provider =
      payload && typeof payload.provider === "string" && payload.provider.trim()
        ? payload.provider.trim()
        : null;
    const windows = Array.isArray(payload && payload.windows)
      ? payload.windows.map((window) => Number.isFinite(window && window.usedPercent) ? ({
          key:
            window && typeof window.key === "string" && window.key.trim()
              ? window.key.trim()
              : null,
          label:
            window && typeof window.label === "string" && window.label.trim()
              ? window.label.trim()
              : null,
          usedPercent: window.usedPercent,
          resetAtMs:
            Number.isFinite(window && window.resetAtMs)
              ? Math.floor(window.resetAtMs)
              : null,
          sortOrder:
            Number.isFinite(window && window.sortOrder)
              ? Math.floor(window.sortOrder)
              : null,
        }) : null).filter(Boolean)
      : [];
    return JSON.stringify({
      type: APP_PROTOCOL.providerUsageSnapshot,
      sessionKey:
        payload && typeof payload.sessionKey === "string" && payload.sessionKey.trim()
          ? payload.sessionKey.trim()
          : null,
      provider,
      displayName:
        payload && typeof payload.displayName === "string" && payload.displayName.trim()
          ? payload.displayName.trim()
          : provider,
      limitingWindowKey:
        payload &&
        typeof payload.limitingWindowKey === "string" &&
        payload.limitingWindowKey.trim()
          ? payload.limitingWindowKey.trim()
          : null,
      windows,
      fetchedAtMs:
        Number.isFinite(payload && payload.fetchedAtMs)
          ? Math.floor(payload.fetchedAtMs)
          : Date.now(),
      stale: !!(payload && payload.stale),
      poolStatus:
        payload && (payload.poolStatus === "ready" || payload.poolStatus === "exhausted")
          ? payload.poolStatus
          : "unknown",
      totalProfileCount:
        Number.isFinite(payload && payload.totalProfileCount) && payload.totalProfileCount >= 0
          ? Math.floor(payload.totalProfileCount)
          : null,
      unavailableReason:
        payload &&
        typeof payload.unavailableReason === "string" &&
        payload.unavailableReason.trim()
          ? payload.unavailableReason.trim()
          : null,
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

  function formatSessionModelConfig(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.sessionConfigSnapshot,
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
      elevatedLevel:
        payload && typeof payload.elevatedLevel === "string"
          ? payload.elevatedLevel
          : "off",
      agentId:
        payload && typeof payload.agentId === "string" ? payload.agentId : "",
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

  function formatEvenAiSettings(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.evenAiSettingsSnapshot,
      routingMode: normalizeEvenAiRoutingMode(
        payload && typeof payload.routingMode === "string"
          ? payload.routingMode
          : undefined,
      ),
      systemPrompt:
        payload && typeof payload.systemPrompt === "string"
          ? payload.systemPrompt
          : "",
      defaultModel:
        payload && typeof payload.defaultModel === "string"
          ? payload.defaultModel
          : "",
      defaultThinking:
        payload && typeof payload.defaultThinking === "string"
          ? payload.defaultThinking
          : "",
      listenEnabled: payload && payload.listenEnabled === true,
      defaultFastMode: !!(payload && payload.defaultFastMode === true),
      defaultAgent: normalizeEvenAiDefaultAgent(
        payload && typeof payload.defaultAgent === "string"
          ? payload.defaultAgent
          : undefined,
      ),
    });
  }

  function formatEvenAiSettingsAck(payload) {
    const out = {
      type: APP_PROTOCOL.evenAiSettingsSetAck,
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

  function formatOcuClawEvenAiSnapshot(value) {
    const normalized = normalizeOcuClawEvenAiSection(value);
    return {
      peer: {
        url: normalized.peer.url,
        bearerTokenConfigured: !!normalized.peer.bearerToken,
        forwardSecretConfigured: !!normalized.peer.forwardSecret,
      },
    };
  }

  function formatOcuClawSettings(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.ocuClawSettingsSnapshot,
      systemPrompt: normalizeOcuClawSystemPrompt(
        payload && typeof payload.systemPrompt === "string"
          ? payload.systemPrompt
          : undefined,
      ),
      defaultModel: normalizeOcuClawDefaultModel(
        payload && typeof payload.defaultModel === "string"
          ? payload.defaultModel
          : undefined,
      ),
      defaultThinking: normalizeOcuClawDefaultThinking(
        payload && typeof payload.defaultThinking === "string"
          ? payload.defaultThinking
          : undefined,
      ),
      defaultFastMode: !!(payload && payload.defaultFastMode === true),
      defaultAgent: normalizeOcuClawDefaultAgent(
        payload && typeof payload.defaultAgent === "string"
          ? payload.defaultAgent
          : undefined,
      ),
      agentProgressNotes: normalizeOcuClawAgentProgressNotes(
        payload && typeof payload.agentProgressNotes === "string"
          ? payload.agentProgressNotes
          : undefined,
      ),
      conversationToolProgress: !!(
        payload && payload.conversationToolProgress === true
      ),
      pathways: normalizeOcuClawPathways(payload && payload.pathways),
      evenAi: formatOcuClawEvenAiSnapshot(payload && payload.evenAi),
    });
  }

  function formatOcuClawSettingsAck(payload) {
    const out = {
      type: APP_PROTOCOL.ocuClawSettingsSetAck,
      status:
        payload && typeof payload.status === "string"
          ? payload.status
          : "rejected",
    };
    if (payload && payload.error !== undefined) {
      out.error = payload.error;
    }
    if (payload && typeof payload.confirmationTitle === "string") {
      Reflect.set(out, "confirmationTitle", payload.confirmationTitle);
    }
    if (payload && typeof payload.confirmationMessage === "string") {
      Reflect.set(out, "confirmationMessage", payload.confirmationMessage);
    }
    return JSON.stringify(out);
  }

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

  function formatApproval(data) {
    const request = data && data.request ? data.request : {};
    const approvalKind =
      (data && data.approvalKind === "plugin") ||
      (data && typeof data.id === "string" && data.id.startsWith("plugin:")) ||
      (typeof request.title === "string" && request.title.length > 0)
        ? "plugin"
        : "exec";
    const isPluginApproval = approvalKind === "plugin";
    const commandText =
      request.command ||
      (request.host === "node" && request.systemRunPlan && typeof request.systemRunPlan.commandText === "string"
        ? request.systemRunPlan.commandText
        : "") ||
      (isPluginApproval && typeof request.title === "string" ? request.title : "") ||
      "";
    const pluginDescription =
      isPluginApproval && typeof request.description === "string" && request.description.length > 0
        ? request.description
        : null;
    return JSON.stringify({
      type: APP_PROTOCOL.approvalRequest,
      id: data.id,
      ...(isPluginApproval ? { approvalKind: "plugin" } : {}),
      requestId:
        (data && typeof data.requestId === "string" && data.requestId) ||
        (request && typeof request.requestId === "string" && request.requestId) ||
        null,
      command: commandText,
      cwd: request.cwd || pluginDescription || null,
      agentId: request.agentId || null,
      host: request.host || (isPluginApproval ? "plugin" : null),
      security: request.security || (isPluginApproval && typeof request.severity === "string" ? request.severity : null),
      ask: request.ask || null,
      resolvedPath: request.resolvedPath || null,
      sessionKey: request.sessionKey || null,
      ...(isPluginApproval
        ? {
            pluginId: typeof request.pluginId === "string" ? request.pluginId : null,
            toolName: typeof request.toolName === "string" ? request.toolName : null,
            description: pluginDescription,
          }
        : {}),
      createdAtMs: data.createdAtMs || 0,

      expiresAtMs:
        typeof data.expiresAtMs === "number" &&
        Number.isFinite(data.expiresAtMs) &&
        data.expiresAtMs > 0
          ? data.expiresAtMs
          : 0,
      allowedDecisions: Array.isArray(request.allowedDecisions)
        ? request.allowedDecisions.filter((d) => typeof d === "string")
        : null,
    });
  }

  function formatApprovalResolved(data) {
    return JSON.stringify({
      type: APP_PROTOCOL.approvalResolved,
      id: data.id,
      requestId:
        data && typeof data.requestId === "string" && data.requestId
          ? data.requestId
          : null,
      decision: data.decision || null,
    });
  }

  function formatApprovalResponseAck(data) {
    return JSON.stringify({
      type: APP_PROTOCOL.approvalResolveAck,
      id: data && data.id ? data.id : null,
      decision: data && data.decision ? data.decision : null,
      requestId:
        data && data.requestId !== undefined && data.requestId !== null
          ? data.requestId
          : null,
      status:
        data && typeof data.status === "string" && data.status
          ? data.status
          : "rejected",
      code:
        data && typeof data.code === "string" && data.code
          ? data.code
          : null,
      message:
        data && typeof data.message === "string" && data.message
          ? data.message
          : null,
      idempotent:
        data && data.idempotent !== undefined
          ? !!data.idempotent
          : false,
    });
  }

  function formatTranscription(text, isFinal) {
    return JSON.stringify({
      type: "transcription",
      text,
      final: !!isFinal,
    });
  }

  function formatListenCommitted(text, source, sessionKey) {
    return JSON.stringify({
      type: "listen-committed",
      text,
      source,
      sessionKey: sessionKey || null,
    });
  }

  function formatEvenAiListenIntercepted(sessionKey) {
    return JSON.stringify({
      type: "even-ai-listen-intercepted",
      sessionKey: sessionKey ?? null,
    });
  }

  function formatListenEnded() {
    return JSON.stringify({ type: "listen-ended" });
  }

  function formatListenError(error, code = null) {
    const msg = { type: "listen-error", error };
    if (typeof code === "string" && code.trim()) {
      msg.code = code.trim();
    }
    return JSON.stringify(msg);
  }

  function formatListenReady() {
    return JSON.stringify({ type: "listen-ready" });
  }

  function formatScriptedListenReady(sessionKey = null) {
    return JSON.stringify({
      type: "scripted-listen-ready",
      sessionKey: sessionKey || null,
    });
  }

  function formatSonioxTemporaryKey(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.sonioxTemporaryKey,
      voiceSessionId:
        payload && typeof payload.voiceSessionId === "string"
          ? payload.voiceSessionId
          : "",
      temporaryKey:
        payload && typeof payload.temporaryKey === "string"
          ? payload.temporaryKey
          : "",
      expiresAtMs:
        payload && Number.isFinite(payload.expiresAtMs)
          ? Math.floor(payload.expiresAtMs)
          : 0,
    });
  }

  function formatSonioxTemporaryKeyError(payload) {
    const msg = {
      type: APP_PROTOCOL.sonioxTemporaryKeyError,
      voiceSessionId:
        payload && typeof payload.voiceSessionId === "string"
          ? payload.voiceSessionId
          : "",
      error:
        payload && typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : "Soniox temporary-key request failed",
    };
    const code =
      payload && typeof payload.code === "string" && payload.code.trim()
        ? payload.code.trim()
        : "";
    if (code) {
      msg.code = code;
    }
    return JSON.stringify(msg);
  }

  function parseRequestCartesiaAccessToken(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("requestCartesiaAccessToken payload must be an object");
    }

    const voiceSessionId = parseOptionalTrimmedString(msg.voiceSessionId);
    if (!voiceSessionId) {
      throw new Error("voiceSessionId is required");
    }

    return {
      voiceSessionId,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey),
    };
  }

  function normalizeCartesiaAccessTokenErrorCode(err) {

    const explicit = err && typeof err.code === "string" ? err.code.trim() : "";
    if (explicit) return explicit;

    const message =
      err && typeof err.message === "string" && err.message.trim()
        ? err.message.trim()
        : "";
    const lowered = message.toLowerCase();
    if (!message) return "cartesia_access_token_failed";

    if (err && err.name === "AbortError") {
      return "cartesia_access_token_mint_timeout";
    }
    if (lowered.includes("api key is not configured")) {
      return "cartesia_access_token_not_configured";
    }
    if (lowered.includes("fetch is not available")) {
      return "cartesia_access_token_fetch_unavailable";
    }
    if (lowered.includes("voicesessionid is required")) {
      return "cartesia_access_token_invalid_request";
    }
    if (lowered.includes("missing token")) {
      return "cartesia_access_token_invalid_response";
    }
    const statusMatch = lowered.match(/\((\d{3})\)/);
    if (statusMatch) {
      return `cartesia_access_token_http_${statusMatch[1]}`;
    }
    return "cartesia_access_token_failed";
  }

  function formatCartesiaAccessToken(payload) {
    return JSON.stringify({
      type: APP_PROTOCOL.cartesiaAccessToken,
      voiceSessionId:
        payload && typeof payload.voiceSessionId === "string" ? payload.voiceSessionId : "",
      accessToken:
        payload && typeof payload.accessToken === "string" ? payload.accessToken : "",
      expiresAtMs:
        payload && Number.isFinite(payload.expiresAtMs) ? Math.floor(payload.expiresAtMs) : 0,
    });
  }

  function formatCartesiaAccessTokenError(payload) {
    const msg = {
      type: APP_PROTOCOL.cartesiaAccessTokenError,
      voiceSessionId:
        payload && typeof payload.voiceSessionId === "string" ? payload.voiceSessionId : "",
      error:
        payload && typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : "Cartesia access-token request failed",
    };
    const code =
      payload && typeof payload.code === "string" && payload.code.trim()
        ? payload.code.trim()
        : "";
    if (code) {
      msg.code = code;
    }
    return JSON.stringify(msg);
  }

  function formatDebugSet(data) {
    return JSON.stringify({
      type: "debug-set",
      ...data,
    });
  }

  function formatDebugDump(data) {
    return JSON.stringify({
      type: "debug-dump",
      ...data,
    });
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

  function formatTraceLog(data) {
    return JSON.stringify({ type: "trace-log", ...data });
  }

  function formatDebugConfigSnapshot(data) {
    const enabled = Array.isArray(data && data.enabled)
      ? data.enabled
          .filter(
            (entry) =>
              entry &&
              typeof entry.cat === "string" &&
              entry.cat.trim() &&
              Number.isFinite(Number(entry.expiresAtMs)),
          )
          .map((entry) => ({
            cat: entry.cat.trim(),
            expiresAtMs: Math.floor(Number(entry.expiresAtMs)),
          }))
      : [];
    return JSON.stringify({
      type: APP_PROTOCOL.debugConfigSnapshot,
      serverNowMs:
        Number.isFinite(data && data.serverNowMs)
          ? Math.floor(data.serverNowMs)
          : 0,
      enabled,
    });
  }

  function formatRemoteControl(data) {
    return JSON.stringify({
      type: APP_PROTOCOL.remoteControl,
      ...data,
    });
  }

  function formatRemoteControlAck(data) {
    return JSON.stringify({
      type: "remote-control-ack",
      ...data,
    });
  }

  function formatAutomationStateRequest(data) {
    return JSON.stringify({
      type: APP_PROTOCOL.automationStateGet,
      requestId:
        data && typeof data.requestId === "string" && data.requestId
          ? data.requestId
          : null,
      sessionKey:
        data && typeof data.sessionKey === "string" && data.sessionKey
          ? data.sessionKey
          : null,
    });
  }

  function formatAutomationRegistryRequest() {
    return JSON.stringify({
      type: APP_PROTOCOL.automationRegistryGet,
    });
  }

  function formatAutomationStateSnapshot(data) {
    return JSON.stringify({
      type: APP_PROTOCOL.automationStateSnapshot,
      ok: data && data.ok !== false,
      requestId:
        data && typeof data.requestId === "string" && data.requestId
          ? data.requestId
          : null,
      state:
        data && data.state && typeof data.state === "object" ? data.state : null,
      reasonCode:
        data && typeof data.reasonCode === "string" && data.reasonCode
          ? data.reasonCode
          : null,
      message:
        data && typeof data.message === "string" && data.message
          ? data.message
          : null,
    });
  }

  function formatAutomationRegistry(data) {

    const schemaVersion =
      data && Number.isInteger(data.schemaVersion) && data.schemaVersion >= 1
        ? data.schemaVersion
        : 1;
    return JSON.stringify({
      type: APP_PROTOCOL.automationRegistry,
      schemaVersion,
      entries: data && Array.isArray(data.entries) ? data.entries : [],
    });
  }

  function formatReadinessProbeRequest(data) {
    return JSON.stringify({
      type: APP_PROTOCOL.readinessProbeRequest,
      requestId:
        data && typeof data.requestId === "string" && data.requestId
          ? data.requestId
          : null,
      sinceMs:
        data && Number.isFinite(Number(data.sinceMs))
          ? Math.max(0, Math.floor(Number(data.sinceMs)))
          : 0,
      sessionKey:
        data && typeof data.sessionKey === "string" && data.sessionKey
          ? data.sessionKey
          : null,
    });
  }

  function formatReadinessProbeAck(data) {
    return JSON.stringify({
      type: APP_PROTOCOL.readinessProbeAck,
      ok: data && data.ok !== false,
      requestId:
        data && typeof data.requestId === "string" && data.requestId
          ? data.requestId
          : null,
      reasonCode:
        data && typeof data.reasonCode === "string" && data.reasonCode
          ? data.reasonCode
          : null,
      message:
        data && typeof data.message === "string" && data.message
          ? data.message
          : null,
      activeSessionKey:
        data && typeof data.activeSessionKey === "string" && data.activeSessionKey
          ? data.activeSessionKey
          : null,
      emittedAtMs:
        data && Number.isFinite(Number(data.emittedAtMs))
          ? Math.max(0, Math.floor(Number(data.emittedAtMs)))
          : null,
      clientId:
        data && typeof data.clientId === "string" && data.clientId
          ? data.clientId
          : null,
      clientName:
        data && typeof data.clientName === "string" && data.clientName
          ? data.clientName
          : null,
      clientVersion:
        data && typeof data.clientVersion === "string" && data.clientVersion
          ? data.clientVersion
          : null,
    });
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

  function parseEventDebug(msg) {
    if (!msg || typeof msg !== "object") return null;
    if (typeof msg.cat !== "string" || !msg.cat.trim()) return null;
    if (typeof msg.event !== "string" || !msg.event.trim()) return null;
    const severity =
      msg.severity === "info" ||
      msg.severity === "warn" ||
      msg.severity === "error"
        ? msg.severity
        : "debug";
    return {
      cat: msg.cat.trim(),
      event: msg.event.trim(),
      severity,
      screen:
        typeof msg.screen === "string" && msg.screen.trim()
          ? msg.screen.trim()
          : null,
      runId:
        typeof msg.runId === "string" && msg.runId.trim()
          ? msg.runId.trim()
          : null,
      sessionKey:
        typeof msg.sessionKey === "string" && msg.sessionKey.trim()
          ? msg.sessionKey.trim()
          : null,
      data:
        msg.data && typeof msg.data === "object" && !Array.isArray(msg.data)
          ? msg.data
          : { value: msg.data ?? null },
    };
  }

  function normalizeRemoteButton(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("remote-control button is required");
    }
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === "click" ||
      normalized === "tap" ||
      normalized === "double-click" ||
      normalized === "double_click" ||
      normalized === "doubleclick" ||
      normalized === "double-tap" ||
      normalized === "double_tap" ||
      normalized === "doubletap" ||
      normalized === "long-press" ||
      normalized === "long_press" ||
      normalized === "longpress" ||
      normalized === "long-press-release" ||
      normalized === "long_press_release" ||
      normalized === "longpressrelease" ||
      normalized === "scroll-up" ||
      normalized === "scroll_up" ||
      normalized === "scrollup" ||
      normalized === "up" ||
      normalized === "scroll-down" ||
      normalized === "scroll_down" ||
      normalized === "scrolldown" ||
      normalized === "down"
    ) {
      if (normalized === "tap") return "click";
      if (
        normalized === "double_click" ||
        normalized === "doubleclick" ||
        normalized === "double-tap" ||
        normalized === "double_tap" ||
        normalized === "doubletap"
      ) {
        return "double-click";
      }
      if (normalized === "long_press" || normalized === "longpress") {
        return "long-press";
      }
      if (
        normalized === "long_press_release" ||
        normalized === "longpressrelease"
      ) {
        return "long-press-release";
      }
      if (normalized === "scroll_up" || normalized === "scrollup" || normalized === "up") {
        return "scroll-up";
      }
      if (normalized === "scroll_down" || normalized === "scrolldown" || normalized === "down") {
        return "scroll-down";
      }
      return normalized;
    }
    throw new Error(`unsupported remote-control button: ${raw}`);
  }

  function normalizeRemoteRelayAction(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("remote-control relayAction is required");
    }
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === "perf-conversation-upgrade-probe" ||
      normalized === "perf_conversation_upgrade_probe" ||
      normalized === "perfconversationupgradeprobe" ||
      normalized === "conversation-upgrade-probe" ||
      normalized === "conversation_upgrade_probe" ||
      normalized === "conversationupgradeprobe"
    ) {
      return "perf-conversation-upgrade-probe";
    }
    if (
      normalized === "new-session" ||
      normalized === "new_session" ||
      normalized === "newsession"
    ) {
      return "new-session";
    }
    if (
      normalized === "get-sessions" ||
      normalized === "get_sessions" ||
      normalized === "getsessions" ||
      normalized === "sessions"
    ) {
      return "get-sessions";
    }
    if (
      normalized === "switch-session" ||
      normalized === "switch_session" ||
      normalized === "switchsession"
    ) {
      return "switch-session";
    }
    if (normalized === "new-chat" || normalized === "new_chat" || normalized === "newchat") {
      return "new-chat";
    }
    if (
      normalized === "slash-command" ||
      normalized === "slash_command" ||
      normalized === "slash"
    ) {
      return "slash-command";
    }
    if (
      normalized === "listen-start" ||
      normalized === "listen_start" ||
      normalized === "listenstart"
    ) {
      return "listen-start";
    }
    if (
      normalized === "listen-stop" ||
      normalized === "listen_stop" ||
      normalized === "listenstop"
    ) {
      return "listen-stop";
    }
    if (
      normalized === "listen-send" ||
      normalized === "listen_send" ||
      normalized === "listensend"
    ) {
      return "listen-send";
    }
    if (
      normalized === "listen-retry" ||
      normalized === "listen_retry" ||
      normalized === "listenretry"
    ) {
      return "listen-retry";
    }
    if (
      normalized === "ptt-confirm" ||
      normalized === "ptt_confirm" ||
      normalized === "pttconfirm"
    ) {
      return "ptt-confirm";
    }
    if (
      normalized === "ptt-redo" ||
      normalized === "ptt_redo" ||
      normalized === "pttredo"
    ) {
      return "ptt-redo";
    }
    if (
      normalized === "ptt-cancel" ||
      normalized === "ptt_cancel" ||
      normalized === "pttcancel"
    ) {
      return "ptt-cancel";
    }
    if (
      normalized === "ptt-partial" ||
      normalized === "ptt_partial" ||
      normalized === "pttpartial"
    ) {
      return "ptt-partial";
    }
    if (
      normalized === "ptt-lab-start" ||
      normalized === "ptt_lab_start" ||
      normalized === "pttlabstart"
    ) {
      return "ptt-lab-start";
    }
    if (
      normalized === "ptt-lab-commit" ||
      normalized === "ptt_lab_commit" ||
      normalized === "pttlabcommit"
    ) {
      return "ptt-lab-commit";
    }
    if (
      normalized === "ptt-lab-release" ||
      normalized === "ptt_lab_release" ||
      normalized === "pttlabrelease"
    ) {
      return "ptt-lab-release";
    }
    if (
      normalized === "perf-reset-ladder" ||
      normalized === "perf_reset_ladder" ||
      normalized === "perfresetladder" ||
      normalized === "reset-ladder" ||
      normalized === "reset_ladder" ||
      normalized === "resetladder"
    ) {
      return "perf-reset-ladder";
    }
    if (
      normalized === "perf-relay-reconnect-only" ||
      normalized === "perf_relay_reconnect_only" ||
      normalized === "perfrelayreconnectonly" ||
      normalized === "relay-reconnect-only" ||
      normalized === "relay_reconnect_only" ||
      normalized === "relayreconnectonly"
    ) {
      return "perf-relay-reconnect-only";
    }
    if (
      normalized === "perf-sdk-page-recreate-only" ||
      normalized === "perf_sdk_page_recreate_only" ||
      normalized === "perfsdkpagerecreateonly" ||
      normalized === "sdk-page-recreate-only" ||
      normalized === "sdk_page_recreate_only" ||
      normalized === "sdkpagerecreateonly"
    ) {
      return "perf-sdk-page-recreate-only";
    }
    if (
      normalized === "perf-config" ||
      normalized === "perf_config" ||
      normalized === "perfconfig" ||
      normalized === "perf-drift-config" ||
      normalized === "perf_drift_config" ||
      normalized === "perfdriftconfig"
    ) {
      return "perf-config";
    }
    if (
      normalized === "waveform-demo" ||
      normalized === "waveform_demo" ||
      normalized === "waveformdemo"
    ) {
      return "waveform-demo";
    }
    if (
      normalized === "debug-close-app-client" ||
      normalized === "debug_close_app_client" ||
      normalized === "debugcloseappclient" ||
      normalized === "close-app-client" ||
      normalized === "close_app_client" ||
      normalized === "closeappclient"
    ) {
      return "debug-close-app-client";
    }
    throw new Error(`unsupported remote relayAction: ${raw}`);
  }

  function parseOptionalTrimmedString(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed || null;
  }

  function parseOptionalInteger(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string" && raw.trim() === "") return null;
    return Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : null;
  }

  function parseOptionalBoolean(raw, fieldName) {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    if (typeof raw !== "string") {
      throw new Error(`${fieldName} must be a boolean`);
    }
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    throw new Error(`${fieldName} must be a boolean`);
  }

  function parseOptionalPositiveNumber(raw, fieldName) {
    if (raw === undefined || raw === null) return undefined;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`${fieldName} must be a positive number`);
    }
    return Math.floor(num);
  }

  function parseOptionalNonNegativeNumber(raw, fieldName) {
    if (raw === undefined || raw === null) return undefined;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`${fieldName} must be a non-negative number`);
    }
    return Math.floor(num);
  }

  function parseOptionalStringArray(raw, fieldName) {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) {
      throw new Error(`${fieldName} must be an array of strings`);
    }
    const values = [];
    for (const entry of raw) {
      if (typeof entry !== "string") {
        throw new Error(`${fieldName} must be an array of strings`);
      }
      const trimmed = entry.trim();
      if (trimmed) values.push(trimmed);
    }
    return values;
  }

  function parseSetSessionModelConfig(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("setSessionModelConfig payload must be an object");
    }

    const payload = {};
    let parsedModelRef = "";

    if (Object.prototype.hasOwnProperty.call(msg, "modelRef")) {
      if (typeof msg.modelRef !== "string") {
        throw new Error("modelRef must be in provider/id format or blank");
      }
      const modelRef = msg.modelRef.trim();
      if (!modelRef) {
        payload.modelRef = "";
      } else {
        if (!modelRef.includes("/")) {
          throw new Error("modelRef must be in provider/id format");
        }
        payload.modelRef = modelRef;
        parsedModelRef = modelRef;
      }
    }

    if (Object.prototype.hasOwnProperty.call(msg, "thinkingLevel")) {
      if (typeof msg.thinkingLevel !== "string") {
        throw new Error(
          "thinkingLevel must be blank|off|minimal|low|medium|high|xhigh|max|ultra",
        );
      }
      const normalized = msg.thinkingLevel.trim().toLowerCase();
      if (
        normalized &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(normalized)
      ) {
        throw new Error(
          "thinkingLevel must be blank|off|minimal|low|medium|high|xhigh|max|ultra",
        );
      }
      payload.thinkingLevel = normalized;
    }

    const oneTurn = parseOptionalBoolean(msg.oneTurn, "oneTurn");
    if (oneTurn !== undefined) {
      if (oneTurn && !parsedModelRef) {
        throw new Error("oneTurn requires a non-blank modelRef");
      }
      Object.assign(payload, { oneTurn });
    }

    if (Object.prototype.hasOwnProperty.call(msg, "reasoningLevel")) {
      if (typeof msg.reasoningLevel !== "string") {
        throw new Error("reasoningLevel must be off|on|on.full");
      }
      const normalized = msg.reasoningLevel.trim().toLowerCase();
      if (!["off", "on", "on.full"].includes(normalized)) {
        throw new Error("reasoningLevel must be off|on|on.full");
      }
      Object.assign(payload, { reasoningLevel: normalized });
    }

    const reasoningEnabled = parseOptionalBoolean(
      msg.reasoningEnabled,
      "reasoningEnabled",
    );
    if (reasoningEnabled !== undefined) {
      payload.reasoningEnabled = reasoningEnabled;
    }

    const verboseLevel = parseOptionalTrimmedString(msg.verboseLevel);
    if (verboseLevel) {
      const normalized = verboseLevel.toLowerCase();
      if (!["off", "on", "full"].includes(normalized)) {
        throw new Error("verboseLevel must be off|on|full");
      }
      payload.verboseLevel = normalized;
    }

    const fastMode = parseOptionalBoolean(msg.fastMode, "fastMode");
    if (fastMode !== undefined) {
      payload.fastMode = fastMode;
    }

    const elevatedLevel = parseOptionalTrimmedString(msg.elevatedLevel);
    if (elevatedLevel) {
      const normalized = elevatedLevel.toLowerCase();
      if (!["off", "on", "ask", "full"].includes(normalized)) {
        throw new Error("elevatedLevel must be off|on|ask|full");
      }
      payload.elevatedLevel = normalized;
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("setSessionModelConfig requires at least one field");
    }

    return payload;
  }

  function parseNewSession(msg = { agentRef: "", scope: "", requestId: "" }) {
    const payload = {
      scope: "once",
      requestId: parseOptionalTrimmedString(msg && msg.requestId),
    };
    if (hasOwn(msg, "agentRef")) {
      if (typeof msg.agentRef !== "string") {
        throw new Error("agentRef must be a string");
      }
      Object.assign(payload, { agentRef: msg.agentRef.trim() });
    }
    if (hasOwn(msg, "scope")) {
      if (typeof msg.scope !== "string") {
        throw new Error("scope must be once|default");
      }
      const scope = msg.scope.trim().toLowerCase();
      if (scope !== "once" && scope !== "default") {
        throw new Error("scope must be once|default");
      }
      payload.scope = scope;
    }
    return payload;
  }

  function parseSetEvenAiSettings(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("setEvenAiSettings payload must be an object");
    }

    const payload = {};

    if (Object.prototype.hasOwnProperty.call(msg, "routingMode")) {
      const routingMode = parseOptionalTrimmedString(msg.routingMode);
      if (!routingMode) {
        throw new Error("routingMode must be active|background|background_new");
      }
      const normalizedInput = routingMode.toLowerCase();
      if (
        ![
          "active",
          "background",
          "background_new",
          "dedicated",
          "new",
          "dedicated_shadow",
          "new_shadow",
        ].includes(normalizedInput)
      ) {
        throw new Error("routingMode must be active|background|background_new");
      }
      payload.routingMode = normalizeEvenAiRoutingMode(routingMode);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "systemPrompt")) {
      if (typeof msg.systemPrompt !== "string") {
        throw new Error("systemPrompt must be a string");
      }
      payload.systemPrompt = msg.systemPrompt.trim();
    }

    if (Object.prototype.hasOwnProperty.call(msg, "defaultModel")) {
      if (typeof msg.defaultModel !== "string") {
        throw new Error("defaultModel must be a string");
      }
      payload.defaultModel = msg.defaultModel.trim();
    }

    if (Object.prototype.hasOwnProperty.call(msg, "defaultThinking")) {
      if (typeof msg.defaultThinking !== "string") {
        throw new Error("defaultThinking must be a string");
      }
      const normalizedThinking = msg.defaultThinking.trim().toLowerCase();
      if (
        normalizedThinking &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(normalizedThinking)
      ) {
        throw new Error("defaultThinking must be off|minimal|low|medium|high|xhigh|max|ultra");
      }
      payload.defaultThinking = normalizedThinking;
    }

    if (Object.prototype.hasOwnProperty.call(msg, "listenEnabled")) {
      if (typeof msg.listenEnabled !== "boolean") {
        throw new Error("listenEnabled must be a boolean");
      }
      payload.listenEnabled = msg.listenEnabled;
    }

    if (Object.prototype.hasOwnProperty.call(msg, "defaultFastMode")) {
      if (typeof msg.defaultFastMode !== "boolean") {
        throw new Error("defaultFastMode must be a boolean");
      }
      payload.defaultFastMode = msg.defaultFastMode;
    }

    if (Object.prototype.hasOwnProperty.call(msg, "defaultAgent")) {
      if (typeof msg.defaultAgent !== "string") {
        throw new Error("defaultAgent must be a string");
      }
      payload.defaultAgent = normalizeEvenAiDefaultAgent(msg.defaultAgent);
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("setEvenAiSettings requires at least one field");
    }

    return payload;
  }

  function parseOcuClawEvenAiPatch(value) {
    const patch = {};
    if (!hasOwn(value, "peer")) {
      return patch;
    }
    if (!value.peer || typeof value.peer !== "object" || Array.isArray(value.peer)) {
      throw new Error("evenAi.peer must be an object");
    }
    const peerPatch = {};
    if (hasOwn(value.peer, "url")) {
      if (typeof value.peer.url !== "string") {
        throw new Error("evenAi.peer.url must be a string");
      }
      peerPatch.url = normalizeOcuClawEvenAiPeer({ url: value.peer.url }).url;
    }
    if (hasOwn(value.peer, "bearerToken")) {
      if (typeof value.peer.bearerToken !== "string") {
        throw new Error("evenAi.peer.bearerToken must be a string");
      }
      peerPatch.bearerToken = normalizeOcuClawEvenAiPeer({
        bearerToken: value.peer.bearerToken,
      }).bearerToken;
    }
    if (hasOwn(value.peer, "forwardSecret")) {
      if (typeof value.peer.forwardSecret !== "string") {
        throw new Error("evenAi.peer.forwardSecret must be a string");
      }
      peerPatch.forwardSecret = normalizeOcuClawEvenAiPeer({
        forwardSecret: value.peer.forwardSecret,
      }).forwardSecret;
    }
    patch.peer = peerPatch;
    return patch;
  }

  function parseOcuClawPathwaysPatch(value) {
    const patch = {};
    for (const key of ["heyEven", "app"]) {
      if (!hasOwn(value, key)) {
        continue;
      }
      const pathway = value[key];
      if (!pathway || typeof pathway !== "object" || Array.isArray(pathway)) {
        throw new Error(`pathways.${key} must be an object`);
      }
      const pathwayPatch = {};
      if (hasOwn(pathway, "binding")) {
        const binding = pathway.binding;
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
          throw new Error(`pathways.${key}.binding must be an object`);
        }
        const bindingPatch = {};
        if (hasOwn(binding, "backend")) {
          if (typeof binding.backend !== "string") {
            throw new Error(`pathways.${key}.binding.backend must be a string`);
          }
          bindingPatch.backend = normalizeOcuClawPathwayBinding({
            backend: binding.backend,
          }).backend;
        }
        if (hasOwn(binding, "agentRef")) {
          if (typeof binding.agentRef !== "string") {
            throw new Error(`pathways.${key}.binding.agentRef must be a string`);
          }
          bindingPatch.agentRef = normalizeOcuClawPathwayBinding({
            agentRef: binding.agentRef,
          }).agentRef;
        }
        pathwayPatch.binding = bindingPatch;
      }
      patch[key] = pathwayPatch;
    }
    return patch;
  }

  function parseSetOcuClawSettings(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("setOcuClawSettings payload must be an object");
    }

    const payload = {};

    if (Object.prototype.hasOwnProperty.call(msg, "systemPrompt")) {
      if (typeof msg.systemPrompt !== "string") {
        throw new Error("systemPrompt must be a string");
      }
      payload.systemPrompt = msg.systemPrompt.trim();
    }

    if (Object.prototype.hasOwnProperty.call(msg, "defaultModel")) {
      if (typeof msg.defaultModel !== "string") {
        throw new Error("defaultModel must be a string");
      }
      payload.defaultModel = normalizeOcuClawDefaultModel(msg.defaultModel);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "defaultThinking")) {
      if (typeof msg.defaultThinking !== "string") {
        throw new Error("defaultThinking must be a string");
      }
      payload.defaultThinking = normalizeOcuClawDefaultThinking(msg.defaultThinking);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "defaultFastMode")) {
      if (typeof msg.defaultFastMode !== "boolean") {
        throw new Error("defaultFastMode must be a boolean");
      }
      payload.defaultFastMode = msg.defaultFastMode;
    }

    if (Object.prototype.hasOwnProperty.call(msg, "defaultAgent")) {
      if (typeof msg.defaultAgent !== "string") {
        throw new Error("defaultAgent must be a string");
      }
      payload.defaultAgent = normalizeOcuClawDefaultAgent(msg.defaultAgent);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "confirmModelSelection")) {
      if (typeof msg.confirmModelSelection !== "boolean") {
        throw new Error("confirmModelSelection must be a boolean");
      }
      Reflect.set(payload, "confirmModelSelection", msg.confirmModelSelection);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "agentProgressNotes")) {
      if (typeof msg.agentProgressNotes !== "string") {
        throw new Error("agentProgressNotes must be a string");
      }
      const normalizedNotes = msg.agentProgressNotes.trim().toLowerCase();
      if (
        normalizedNotes !== "off" &&
        normalizedNotes !== "status" &&
        normalizedNotes !== "conversation"
      ) {
        throw new Error(
          "agentProgressNotes must be one of off|status|conversation",
        );
      }
      payload.agentProgressNotes = normalizeOcuClawAgentProgressNotes(normalizedNotes);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "conversationToolProgress")) {
      if (typeof msg.conversationToolProgress !== "boolean") {
        throw new Error("conversationToolProgress must be a boolean");
      }
      Reflect.set(payload, "conversationToolProgress", msg.conversationToolProgress);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "pathways")) {
      if (!msg.pathways || typeof msg.pathways !== "object" || Array.isArray(msg.pathways)) {
        throw new Error("pathways must be an object");
      }
      payload.pathways = parseOcuClawPathwaysPatch(msg.pathways);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "evenAi")) {
      if (!msg.evenAi || typeof msg.evenAi !== "object" || Array.isArray(msg.evenAi)) {
        throw new Error("evenAi must be an object");
      }
      payload.evenAi = parseOcuClawEvenAiPatch(msg.evenAi);
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("setOcuClawSettings requires at least one field");
    }

    return payload;
  }

  function parseRequestSonioxTemporaryKey(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("requestSonioxTemporaryKey payload must be an object");
    }

    const voiceSessionId = parseOptionalTrimmedString(msg.voiceSessionId);
    if (!voiceSessionId) {
      throw new Error("voiceSessionId is required");
    }

    return {
      voiceSessionId,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey),
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

  function parseRemoteControl(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("remote-control payload must be an object");
    }
    const actionRaw = parseOptionalTrimmedString(msg.action);
    if (!actionRaw) {
      throw new Error("remote-control action is required");
    }

    const action = actionRaw.toLowerCase();
    const payload = {
      action,
      requestId: parseOptionalTrimmedString(msg.requestId) || null,
    };

    if (action === "button") {
      payload.button = normalizeRemoteButton(msg.button);
      return payload;
    }

    if (action === "send-message") {
      const text = typeof msg.text === "string" ? msg.text : "";
      if (!text.trim()) {
        throw new Error("remote-control send-message requires non-empty text");
      }
      payload.text = text;
      const sessionKey = parseOptionalTrimmedString(msg.sessionKey);
      if (sessionKey) payload.sessionKey = sessionKey;
      return payload;
    }

    if (action === "setting-set") {
      const settingKey = parseOptionalTrimmedString(msg.settingKey);
      const value = parseOptionalTrimmedString(msg.value);
      if (!settingKey) {
        throw new Error("remote-control setting-set requires settingKey");
      }
      if (!value) {
        throw new Error("remote-control setting-set requires value");
      }
      payload.settingKey = settingKey;
      payload.value = value;
      return payload;
    }

    if (action === "webui-composer-set-text") {
      payload.text = typeof msg.text === "string" ? msg.text : "";
      return payload;
    }

    if (action === "webui-composer-submit") {
      return payload;
    }

    if (action === "webui-open-tab") {
      const value = parseOptionalTrimmedString(msg.value);
      if (!value) {
        throw new Error("remote-control webui-open-tab requires value");
      }
      payload.value = value;
      return payload;
    }

    if (action === "webui-session-select") {
      const sessionKey = parseOptionalTrimmedString(msg.sessionKey);
      if (!sessionKey) {
        throw new Error("remote-control webui-session-select requires sessionKey");
      }
      payload.sessionKey = sessionKey;
      return payload;
    }

    if (action === "webui-agent-menu-open") {
      return payload;
    }

    if (
      action === "webui-debug-upload-open" ||
      action === "webui-debug-upload-send" ||
      action === "webui-debug-upload-dismiss"
    ) {
      return payload;
    }

    if (action === "webui-debug-upload-set-note" || action === "webui-debug-upload-set-contact") {
      payload.text = typeof msg.text === "string" ? msg.text : "";
      return payload;
    }

    if (
      action === "webui-pair-open" ||
      action === "webui-pair-phrase-match" ||
      action === "webui-pair-phrase-mismatch" ||
      action === "webui-pair-dismiss"
    ) {
      return payload;
    }

    if (action === "webui-pair-scan-payload") {
      const text = parseOptionalTrimmedString(msg.text);
      if (!text) {
        throw new Error("remote-control webui-pair-scan-payload requires text");
      }
      return { ...payload, text };
    }

    if (action === "webui-pair-manual") {

      const text = parseOptionalTrimmedString(msg.text);
      const value = parseOptionalTrimmedString(msg.value);
      if (!text) {
        throw new Error("remote-control webui-pair-manual requires text (the address)");
      }
      if (!value) {
        throw new Error("remote-control webui-pair-manual requires value (the pairing code)");
      }
      return { ...payload, text, value };
    }

    if (action === "relay-action") {
      const normalizedRelayAction = normalizeRemoteRelayAction(msg.relayAction);
      payload.relayAction = normalizedRelayAction;
      if (
        normalizedRelayAction === "listen-start" ||
        normalizedRelayAction === "listen-stop" ||
        normalizedRelayAction === "listen-send" ||
        normalizedRelayAction === "listen-retry"
      ) {
        throw new Error(
          `remote-control relayAction ${normalizedRelayAction} was removed; voice stays local to the app`,
        );
      }
      const sessionKey = parseOptionalTrimmedString(msg.sessionKey);
      const command = parseOptionalTrimmedString(msg.command);
      if (normalizedRelayAction === "switch-session" && !sessionKey) {
        throw new Error("remote-control switch-session requires sessionKey");
      }
      if (normalizedRelayAction === "slash-command" && !command) {
        throw new Error("remote-control slash-command requires command");
      }
      if (
        (normalizedRelayAction === "ptt-partial" || normalizedRelayAction === "ptt-lab-commit") &&
        !command
      ) {
        throw new Error(`remote-control ${normalizedRelayAction} requires command`);
      }
      if (sessionKey) payload.sessionKey = sessionKey;
      if (command) payload.command = command;
      const endpointDetection = parseOptionalBoolean(msg.endpointDetection, "endpointDetection");
      if (endpointDetection !== undefined) payload.endpointDetection = endpointDetection;
      const maxEndpointDelayMs = parseOptionalPositiveNumber(
        msg.maxEndpointDelayMs,
        "maxEndpointDelayMs",
      );
      if (maxEndpointDelayMs !== undefined) payload.maxEndpointDelayMs = maxEndpointDelayMs;
      const model = parseOptionalTrimmedString(msg.model);
      if (model) payload.model = model;
      const languageHints = parseOptionalStringArray(msg.languageHints, "languageHints");
      if (languageHints !== undefined) payload.languageHints = languageHints;
      return payload;
    }

    if (action === "list-click") {
      const index = parseOptionalNonNegativeNumber(msg.index, "index");
      if (index === undefined) {
        throw new Error("remote-control list-click requires index");
      }
      payload.index = index;
      const containerId = parseOptionalNonNegativeNumber(msg.containerId, "containerId");
      const containerName = parseOptionalTrimmedString(msg.containerName);
      if (containerId !== undefined) payload.containerId = containerId;
      if (containerName) payload.containerName = containerName;
      return payload;
    }

    if (action === "menu-item-click") {
      const itemId = Number(msg.itemId);
      if (!Number.isInteger(itemId) || itemId < 1 || itemId > 0xffff_ffff) {
        throw new Error("remote-control menu-item-click requires itemId to be a non-zero uint32");
      }
      return { ...payload, itemId };
    }

    if (action === "text-event") {
      payload.eventType = normalizeRemoteButton(msg.eventType || msg.button);
      const containerId = parseOptionalNonNegativeNumber(msg.containerId, "containerId");
      const containerName = parseOptionalTrimmedString(msg.containerName);
      if (containerId !== undefined) payload.containerId = containerId;
      if (containerName) payload.containerName = containerName;
      return payload;
    }

    throw new Error(`unsupported remote-control action: ${actionRaw}`);
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

  function parseOptionalPositiveInt(value) {
    if (value === undefined || value === null) return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.floor(num);
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
    const enabledRaw = raw.neuralSessionNamesEnabled;
    const neuralSessionNamesEnabled =
      typeof enabledRaw === "boolean" ? enabledRaw : true;

    return {
      neuralEmojiReactorState: state,
      neuralPaceModulatorState: paceState,
      neuralSessionNamesEnabled,
    };
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

    if (typeof resolveEtSendKey === "function") {
      const etKey = resolveEtSendKey(msg.sessionKey);
      if (etKey) {
        const etOperation =
          operationRegistry && typeof operationRegistry.beginMessageSend === "function"
            ? operationRegistry.beginMessageSend({ requestId, clientId, sessionKey: etKey })
            : null;
        if (etOperation && etOperation.duplicate) {
          const frames = etOperation.finalFrame
            ? [etOperation.receipt, etOperation.finalFrame]
            : [etOperation.receipt];
          return { unicast: frames };
        }
        let status;
        let ack;
        if (attachment) {

          status = "rejected";
          ack = formatSendAckCompat(requestId, status, "Even Terminal sessions do not support attachments.");
        } else {
          if (typeof sendEtPrompt === "function") sendEtPrompt(etKey, text);
          status = "accepted";
          ack = formatSendAckCompat(requestId, status);
        }
        if (etOperation && typeof etOperation.complete === "function") {
          etOperation.complete(ack, { status });
        }
        return { unicast: ack };
      }
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
    ).then(
      (result) => {
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
      (err) => {
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
    msg = {},
    callback = () => null,
  ) {
    const sessionId = parseOptionalTrimmedString(msg.sessionId);
    if (!sessionId || typeof callback !== "function") return null;
    try {
      const result = callback({
        sessionId,
        lastSeq: parseOptionalInteger(msg.lastSeq),
        entriesRevision: parseOptionalInteger(msg.entriesRevision),
        digest: parseOptionalInteger(msg.digest),
        fromSeq: parseOptionalInteger(msg.fromSeq),
      });
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

    if (typeof tryEtAbort === "function" && tryEtAbort(sessionKey)) {
      return {
        unicast: formatSessionAbortAck({ requestId, status: "accepted" }),
      };
    }
    if (!sessionKey) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          status: "rejected",
          error: "Missing required field: sessionKey",
        }),
      };
    }

    if (!onAbortSession) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          status: "rejected",
          error: "session abort is not available",
        }),
      };
    }
    if (!isUpstreamConnected()) {
      return {
        unicast: formatSessionAbortAck({
          requestId,
          status: "rejected",
          error: `${activeBackendDisplayName()} disconnected`,
        }),
      };
    }
    return Promise.resolve(onAbortSession({ requestId, sessionKey })).then(
      (result) => ({
        unicast: formatSessionAbortAck({
          requestId,
          ...(result || { status: "accepted" }),
        }),
      }),
      (err) => ({
        unicast: formatSessionAbortAck({
          requestId,
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

  function handleSimulate(clientId, msg) {
    const pages = onSimulate(
      msg.sender || "Simulator",
      msg.text || "",
    );
    return { broadcast: formatPages(pages) };
  }

  function handleSimulateStream(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }

    if (!onSimulateStream) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStream not supported by relay",
        ),
      };
    }

    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text.trim()) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStream requires non-empty text",
        ),
      };
    }

    let chunkChars;
    let chunkIntervalMs;
    let startDelayMs;
    let thinkingTailMs;
    try {
      chunkChars = parseOptionalPositiveNumber(msg.chunkChars, "chunkChars");
      chunkIntervalMs = parseOptionalPositiveNumber(msg.chunkIntervalMs, "chunkIntervalMs");
      startDelayMs = parseOptionalNonNegativeNumber(msg.startDelayMs, "startDelayMs");
      thinkingTailMs = parseOptionalNonNegativeNumber(msg.thinkingTailMs, "thinkingTailMs");
    } catch (err) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "Invalid simulateStream parameters",
        ),
      };
    }

    const request = {
      id,

      sender:
        parseOptionalTrimmedString(msg.sender) ||
        (msg.nativeLifecycle === true ? null : "Simulator"),
      text,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      chunkChars,
      chunkIntervalMs,
      startDelayMs,
      thinkingTailMs,
      runId: parseOptionalTrimmedString(msg.runId) || null,
      nativeLifecycle: msg.nativeLifecycle === true,
    };

    return Promise.resolve(onSimulateStream(request)).then(
      (result) => {
        const status = result && result.status ? result.status : "accepted";
        const error = result && result.error ? result.error : undefined;
        const errorCode = result && result.errorCode ? result.errorCode : undefined;
        const runId = result && result.runId ? result.runId : request.runId;
        return { unicast: formatSendAckCompat(id, status, error, errorCode, { runId }) };
      },
      (err) => ({
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "simulateStream failed",
          err && err.code ? err.code : undefined,
        ),
      }),
    );
  }

  function handleSimulateStreamCancel(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
          "missing_id",
        ),
      };
    }

    const runId = parseOptionalTrimmedString(msg.runId);
    if (!runId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStreamCancel requires non-empty runId",
          "missing_run_id",
        ),
      };
    }

    if (!onSimulateStreamCancel) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStreamCancel not supported by relay",
          "unsupported_operation",
          { runId },
        ),
      };
    }

    const request = {
      id,
      runId,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
    };
    return Promise.resolve(onSimulateStreamCancel(request)).then(
      (result) => {
        const status = result && result.status ? result.status : "accepted";
        const error = result && result.error ? result.error : undefined;
        const errorCode = result && result.errorCode ? result.errorCode : undefined;
        return {
          unicast: formatSendAckCompat(id, status, error, errorCode, { runId }),
        };
      },
      (err) => ({
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "simulateStreamCancel failed",
          err && err.code ? err.code : undefined,
          { runId },
        ),
      }),
    );
  }

  function ackSimulateVerb(id, verb, callbackResult) {
    return Promise.resolve(callbackResult).then(
      (result) => {
        const status = result && result.status ? result.status : "accepted";
        const error = result && result.error ? result.error : undefined;
        return { unicast: formatSendAckCompat(id, status, error) };
      },
      (err) => ({
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : `${verb} failed`,
        ),
      }),
    );
  }

  function handleSimulateActivity(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateActivity) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateActivity not supported by relay",
        ),
      };
    }
    const state = parseOptionalTrimmedString(msg.state);
    if (state !== "thinking" && state !== "idle") {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateActivity state must be thinking|idle",
        ),
      };
    }
    return ackSimulateVerb(id, "simulateActivity", onSimulateActivity({
      id,
      state,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      runId: parseOptionalTrimmedString(msg.runId) || null,
      summary: parseOptionalTrimmedString(msg.summary) || null,
      nativeLifecycle: msg.nativeLifecycle === true,
    }));
  }

  function handleSimulateTool(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateTool) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateTool not supported by relay",
        ),
      };
    }
    const runId = parseOptionalTrimmedString(msg.runId);
    if (!runId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateTool requires runId (pairs start/result)",
        ),
      };
    }
    const phase = parseOptionalTrimmedString(msg.phase);
    if (phase !== "start" && phase !== "result") {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateTool phase must be start|result",
        ),
      };
    }
    const tool = parseOptionalTrimmedString(msg.tool);
    if (!tool) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateTool requires tool (real tool name, label derives relay-side)",
        ),
      };
    }
    let elapsedMs;
    try {
      elapsedMs = parseOptionalNonNegativeNumber(msg.elapsedMs, "elapsedMs");
    } catch (err) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "Invalid simulateTool parameters",
        ),
      };
    }
    return ackSimulateVerb(id, "simulateTool", onSimulateTool({
      id,
      runId,
      phase,
      tool,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      argsPreview:
        msg.argsPreview &&
        typeof msg.argsPreview === "object" &&
        !Array.isArray(msg.argsPreview)
          ? msg.argsPreview
          : null,
      isError: msg.isError === true,
      elapsedMs,
      nativeLifecycle: msg.nativeLifecycle === true,
    }));
  }

  function handleSimulateApproval(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateApproval) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateApproval not supported by relay",
        ),
      };
    }
    const approvalId = parseOptionalTrimmedString(msg.approvalId);
    if (!approvalId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateApproval requires approvalId (pairs request/resolve)",
        ),
      };
    }
    const phase = parseOptionalTrimmedString(msg.phase);
    if (phase !== "request" && phase !== "resolve") {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateApproval phase must be request|resolve",
        ),
      };
    }
    if (phase === "request") {
      const command = parseOptionalTrimmedString(msg.command);
      if (!command) {
        return {
          unicast: formatSendAckCompat(
            id,
            "rejected",
            "simulateApproval request requires command",
          ),
        };
      }
      let expiresInMs;
      try {
        expiresInMs = parseOptionalPositiveNumber(msg.expiresInMs, "expiresInMs");
      } catch (err) {
        return {
          unicast: formatSendAckCompat(
            id,
            "rejected",
            err && err.message ? err.message : "Invalid simulateApproval parameters",
          ),
        };
      }
      const allowedDecisions =
        Array.isArray(msg.allowedDecisions) &&
        msg.allowedDecisions.some((d) => typeof d === "string")
          ? msg.allowedDecisions.filter((d) => typeof d === "string")
          : ["allow-once", "deny"];
      return ackSimulateVerb(id, "simulateApproval", onSimulateApproval({
        id,
        phase,
        approvalId,
        command,
        ask: parseOptionalTrimmedString(msg.ask) || null,
        allowedDecisions,
        expiresInMs: expiresInMs || 120000,
        sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
        nativeLifecycle: msg.nativeLifecycle === true,
      }));
    }
    const decision = parseOptionalTrimmedString(msg.decision);
    if (!decision) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateApproval resolve requires decision",
        ),
      };
    }
    return ackSimulateVerb(id, "simulateApproval", onSimulateApproval({
      id,
      phase,
      approvalId,
      decision,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      nativeLifecycle: msg.nativeLifecycle === true,
    }));
  }

  function handleSimulateDemand(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateDemand) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateDemand not supported by relay",
        ),
      };
    }
    const surfaceId = parseOptionalTrimmedString(msg.surfaceId);
    if (!surfaceId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateDemand requires surfaceId",
        ),
      };
    }
    const question = parseOptionalTrimmedString(msg.question);
    if (!question) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateDemand requires question",
        ),
      };
    }
    const options = Array.isArray(msg.options)
      ? msg.options
          .map((option) => ({
            label: parseOptionalTrimmedString(option && option.label) || "",
            detail: parseOptionalTrimmedString(option && option.detail) || null,
          }))
          .filter((option) => option.label)
      : [];
    if (!options.length) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateDemand requires at least one option with a label",
        ),
      };
    }
    return ackSimulateVerb(id, "simulateDemand", onSimulateDemand({
      id,
      surfaceId,
      question,
      options,
      kind: msg.kind === "permission" ? "permission" : "question",
      title: parseOptionalTrimmedString(msg.title) || "even terminal",
      deadlineSec: Number.isFinite(msg.deadlineSec) && msg.deadlineSec > 0
        ? msg.deadlineSec
        : 120,

      questionIndex: Number.isInteger(msg.questionIndex) && msg.questionIndex >= 0
        ? msg.questionIndex
        : 0,
      questionCount: Number.isInteger(msg.questionCount) && msg.questionCount >= 0
        ? msg.questionCount
        : 0,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
    }));
  }

  function handleSimulateVoice(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateVoice) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateVoice not supported by relay",
        ),
      };
    }
    const phase = parseOptionalTrimmedString(msg.phase);
    if (
      phase !== "arm" &&
      phase !== "disarm" &&
      phase !== "partial" &&
      phase !== "commit" &&
      phase !== "end" &&
      phase !== "reopen"
    ) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateVoice phase must be arm|disarm|partial|commit|end|reopen",
        ),
      };
    }
    const text = typeof msg.text === "string" ? msg.text : "";
    if ((phase === "partial" || phase === "commit") && !text.trim()) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          `simulateVoice ${phase} requires text`,
        ),
      };
    }
    return ackSimulateVerb(id, "simulateVoice", onSimulateVoice({
      id,
      phase,
      text,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
    }));
  }

  function handleGlassesUiSurfaceUpdateInject(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onGlassesUiSurfaceUpdateInject) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "glasses_ui_surface_update not supported by relay",
        ),
      };
    }
    const surfaceId = parseOptionalTrimmedString(msg.surfaceId);
    if (!surfaceId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "glasses_ui_surface_update requires surfaceId",
        ),
      };
    }
    const patch =
      msg.patch && typeof msg.patch === "object" && !Array.isArray(msg.patch)
        ? msg.patch
        : null;
    if (!patch || Object.keys(patch).length === 0) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "glasses_ui_surface_update requires a non-empty patch",
        ),
      };
    }
    try {
      onGlassesUiSurfaceUpdateInject({
        surfaceId,
        patch,
        sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      });
    } catch (err) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "glasses_ui_surface_update failed",
        ),
      };
    }
    return { unicast: formatSendAckCompat(id, "accepted") };
  }

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

  function handleNewChat(clientId) {
    return onNewChat().then(
      (result) => {
        if (result && typeof result === "object" && typeof result.sessionKey === "string") {
          return {
            broadcast: [
              formatSessionSwitched(result.sessionKey, "", result.draft === true),
              formatPages(Array.isArray(result.pages) ? result.pages : []),
            ],
          };
        }
        return { broadcast: formatPages(result) };
      },
      (err) => {
        logger.error(`[downstream] newChat failed: ${err.message}`);
        return null;
      },
    );
  }

  function handleGetSessions(clientId) {
    return onGetSessions().then(
      (sessions) => ({ unicast: formatSessions(sessions) }),
      (err) => {
        logger.error(`[downstream] getSessions failed: ${err.message}`);
        return { unicast: formatSessions([]) };
      },
    );
  }

  function handleGetSessionDiff(clientId, msg) {
    const kind = normalizeSessionDiffKind(msg && msg.kind);
    if (!kind) {
      return Promise.resolve({
        unicast: formatError("invalid_session_diff_kind", {}),
      });
    }
    const known = parseKnownSessionRows(msg);
    const limit = normalizeSessionDiffLimit(msg && msg.limit);
    if (kind === "evenai") {
      if (!onGetEvenAiSessions) {
        return Promise.resolve({
          unicast: formatEmptySessionDiff(
            kind,
            limit,
            defaultEvenAiDedicatedSessionKey,
          ),
        });
      }
      return Promise.resolve(onGetEvenAiSessions()).then(
        (payload) => ({
          unicast: formatSessionDiff({
            kind,
            sessions: payload && payload.sessions,
            known,
            limit,
            dedicatedKey:
              payload && typeof payload.dedicatedKey === "string"
                ? payload.dedicatedKey
                : defaultEvenAiDedicatedSessionKey,
          }),
        }),
        (err) => {
          logger.error(`[downstream] getEvenAiSessionDiff failed: ${err.message}`);
          return {
            unicast: formatEmptySessionDiff(
              kind,
              limit,
              defaultEvenAiDedicatedSessionKey,
            ),
          };
        },
      );
    }
    return onGetSessions().then(
      (sessions) => ({
        unicast: formatSessionDiff({ kind, sessions, known, limit }),
      }),
      (err) => {
        logger.error(`[downstream] getSessionDiff failed: ${err.message}`);
        return { unicast: formatEmptySessionDiff(kind, limit) };
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

  function handleGetLiveuiLibrary(clientId) {
    if (!onGetLiveuiLibrary) return { unicast: formatLiveuiLibrary([]) };
    return Promise.resolve(onGetLiveuiLibrary()).then(
      (items) => ({ unicast: formatLiveuiLibrary(items) }),
      (err) => {
        logger.error(`[downstream] get LiveUI Library failed: ${err.message}`);
        return { unicast: formatLiveuiLibrary([]) };
      },
    );
  }

  function handleOpenLiveuiLibraryItem(clientId, msg) {
    const itemType = typeof msg.itemType === "string" ? msg.itemType : "";
    const itemId = typeof msg.itemId === "string" ? msg.itemId : "";
    if (!onOpenLiveuiLibraryItem) {
      return {
        unicast: formatLiveuiLibraryOpenResult({
          itemType,
          itemId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    return Promise.resolve(onOpenLiveuiLibraryItem({ clientId, itemType, itemId })).then(
      (result) => ({
        unicast: formatLiveuiLibraryOpenResult({ itemType, itemId, ...(result || {}) }),
      }),
      (err) => {
        logger.error(`[downstream] open LiveUI Library item failed: ${err.message}`);
        return {
          unicast: formatLiveuiLibraryOpenResult({
            itemType,
            itemId,
            status: "rejected",
            code: "template_open_failed",
          }),
        };
      },
    );
  }

  function handleCancelLiveuiTaskLaunch(clientId, msg) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    if (!onCancelLiveuiTaskLaunch) return null;
    try {
      const result = onCancelLiveuiTaskLaunch({ clientId, taskId });
      if (result && typeof result.then === "function") {
        return result.then(
          () => null,
          (err) => {
            logger.warn(
              `[downstream] cancel LiveUI Task launch failed: ${err && err.message ? err.message : err}`,
            );
            return null;
          },
        );
      }
      return null;
    } catch (err) {
      logger.warn(
        `[downstream] cancel LiveUI Task launch failed: ${err && err.message ? err.message : err}`,
      );
      return null;
    }
  }

  function handleGetLiveuiTasksForPhone(clientId) {
    if (!onGetLiveuiTasksForPhone) {
      return { unicast: formatLiveuiTasks({ tasks: [], templates: [], invalid: [] }) };
    }
    return Promise.resolve(onGetLiveuiTasksForPhone()).then(
      (payload) => ({ unicast: formatLiveuiTasks(payload || {}) }),
      (err) => {
        logger.error(`[downstream] get LiveUI Tasks failed: ${err.message}`);
        return { unicast: formatLiveuiTasks({ tasks: [], templates: [], invalid: [] }) };
      },
    );
  }

  function handleGetLiveuiTaskRunsForPhone(clientId, msg) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId.trim() : "";
    if (!isPhoneClient(clientId)) {
      return { unicast: formatError("liveui_task_runs_phone_only", {}) };
    }
    if (!taskId) {
      return { unicast: formatError("liveui_task_runs_task_id_required", {}) };
    }
    if (!onGetLiveuiTaskRunsForPhone) {
      return { unicast: formatLiveuiTaskRuns(taskId, []) };
    }
    return Promise.resolve(onGetLiveuiTaskRunsForPhone(taskId)).then(
      (records) => ({ unicast: formatLiveuiTaskRuns(taskId, records) }),
      (err) => {
        logger.error(`[downstream] get LiveUI Task Runs failed: ${err.message}`);
        return { unicast: formatLiveuiTaskRuns(taskId, []) };
      },
    );
  }

  function handleReviewLiveuiTask(clientId, msg) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const action = typeof msg.action === "string" ? msg.action : "";
    const expectedDigest = typeof msg.expectedDigest === "string" ? msg.expectedDigest : "";
    if (!isPhoneClient(clientId)) {
      return {
        unicast: formatLiveuiTaskReviewAck({
          taskId,
          action,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onReviewLiveuiTask) {
      return {
        unicast: formatLiveuiTaskReviewAck({
          taskId,
          action,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err) => {
      logger.error(`[downstream] review LiveUI Task failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskReviewAck({
          taskId,
          action,
          status: "rejected",
          code: "task_review_failed",
        }),
      };
    };
    return Promise.resolve(onReviewLiveuiTask({ clientId, taskId, action, expectedDigest })).then(
      (result) => {
        const ack = formatLiveuiTaskReviewAck({ taskId, action, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleGetLiveuiTaskExecutors(clientId) {
    if (!isPhoneClient(clientId)) {
      return { unicast: formatError("phone_only", { code: "phone_only" }) };
    }
    if (!onGetLiveuiTaskExecutors) {
      return { unicast: formatLiveuiTaskExecutors({ executors: [] }) };
    }
    return Promise.resolve(onGetLiveuiTaskExecutors()).then(
      (payload) => ({ unicast: formatLiveuiTaskExecutors(payload || {}) }),
      (err) => {
        logger.error(`[downstream] get LiveUI Task Executors failed: ${err.message}`);
        return { unicast: formatLiveuiTaskExecutors({ executors: [] }) };
      },
    );
  }

  function handleSetLiveuiTaskExecutor(clientId, msg) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const executor = msg.executor && typeof msg.executor === "object"
      ? {
          host: typeof msg.executor.host === "string" ? msg.executor.host : "",
          agentId: typeof msg.executor.agentId === "string" ? msg.executor.agentId : "",
        }
      : { host: "", agentId: "" };
    if (!isPhoneClient(clientId)) {
      return {
        unicast: formatLiveuiTaskExecutorAck({
          taskId,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onSetLiveuiTaskExecutor) {
      return {
        unicast: formatLiveuiTaskExecutorAck({
          taskId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err) => {
      logger.error(`[downstream] set LiveUI Task Executor failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskExecutorAck({
          taskId,
          status: "rejected",
          code: "task_executor_update_failed",
        }),
      };
    };
    return Promise.resolve(onSetLiveuiTaskExecutor({ clientId, taskId, executor })).then(
      (result) => {
        const ack = formatLiveuiTaskExecutorAck({ taskId, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiTaskPreferredTemplate(clientId, msg) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const expectedDigest = typeof msg.expectedDigest === "string" ? msg.expectedDigest : "";
    const templateId = msg.templateId === null
      ? null
      : typeof msg.templateId === "string"
        ? msg.templateId
        : "";
    if (!isPhoneClient(clientId)) {
      return {
        unicast: formatLiveuiTaskPreferredTemplateAck({
          taskId,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onSetLiveuiTaskPreferredTemplate) {
      return {
        unicast: formatLiveuiTaskPreferredTemplateAck({
          taskId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err) => {
      logger.error(`[downstream] set LiveUI Task Preferred Template failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskPreferredTemplateAck({
          taskId,
          status: "rejected",
          code: "task_preferred_template_update_failed",
        }),
      };
    };
    return Promise.resolve(onSetLiveuiTaskPreferredTemplate({
      clientId,
      taskId,
      expectedDigest,
      templateId,
    })).then(
      (result) => {
        const ack = formatLiveuiTaskPreferredTemplateAck({ taskId, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiTaskContext(clientId, msg) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const context = typeof msg.context === "string" ? msg.context : "";
    if (!isPhoneClient(clientId)) {
      return {
        unicast: formatLiveuiTaskContextAck({
          taskId,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onSetLiveuiTaskContext) {
      return {
        unicast: formatLiveuiTaskContextAck({
          taskId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err) => {
      logger.error(`[downstream] set LiveUI Task context failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskContextAck({
          taskId,
          status: "rejected",
          code: "task_context_update_failed",
        }),
      };
    };
    return Promise.resolve(onSetLiveuiTaskContext({ clientId, taskId, context })).then(
      (result) => {
        const ack = formatLiveuiTaskContextAck({ taskId, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleGetLiveuiPrefs(clientId) {
    if (!isPhoneClient(clientId)) {
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "phone_only" }) };
    }
    if (!onGetLiveuiPrefs) {
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "item_unavailable" }) };
    }
    const failure = (err) => {
      logger.error(`[downstream] get LiveUI prefs failed: ${err.message}`);
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "prefs_read_failed" }) };
    };
    return Promise.resolve(onGetLiveuiPrefs()).then(
      (result) => ({
        unicast: formatLiveuiPrefs({
          ...((result && result.prefs) || {}),
          ...(result && result.prefsInvalid ? { prefsInvalid: result.prefsInvalid } : {}),
        }),
      }),
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiPrefs(clientId, msg) {
    if (!isPhoneClient(clientId)) {
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "phone_only" }) };
    }
    if (!onSetLiveuiPrefs) {
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "item_unavailable" }) };
    }
    const patch = {};
    if (typeof msg.enabled === "boolean") patch.enabled = msg.enabled;
    if (typeof msg.pauseApps === "boolean") patch.pauseApps = msg.pauseApps;
    if (typeof msg.defaultContext === "string") patch.defaultContext = msg.defaultContext;
    if (msg.defaultExecutor === null || typeof msg.defaultExecutor === "string") {
      patch.defaultExecutor = msg.defaultExecutor;
    }
    const failure = (err) => {
      logger.error(`[downstream] set LiveUI prefs failed: ${err.message}`);
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "prefs_update_failed" }) };
    };
    return Promise.resolve(onSetLiveuiPrefs({ clientId, patch })).then(
      (result) => {
        const ack = formatLiveuiPrefsAck(result || {});
        if (!result || result.status !== "accepted") return { unicast: ack };

        return Promise.resolve(onGetLiveuiStatus ? onGetLiveuiStatus() : null).then((status) => ({
          unicast: ack,
          broadcast: [
            formatLiveuiPrefs(result.prefs || {}),
            ...(status ? [formatLiveuiStatus(status)] : []),
          ],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleGetLiveuiStatus(clientId) {
    if (!isPhoneClient(clientId)) {
      return { unicast: formatError("LiveUI status is phone-only", { code: "phone_only" }) };
    }
    if (!onGetLiveuiStatus) {
      return { unicast: formatError("LiveUI status unavailable", { code: "item_unavailable" }) };
    }
    const failure = (err) => {
      logger.error(`[downstream] get LiveUI status failed: ${err.message}`);
      return { unicast: formatError("LiveUI status unavailable", { code: "status_read_failed" }) };
    };
    return Promise.resolve(onGetLiveuiStatus()).then(
      (status) => ({ unicast: formatLiveuiStatus(status || {}) }),
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiTaskSettingValues(clientId, msg) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const expectedDigest = typeof msg.expectedDigest === "string" ? msg.expectedDigest : "";
    const values = msg.values && typeof msg.values === "object" && !Array.isArray(msg.values)
      ? msg.values
      : {};
    if (!isPhoneClient(clientId)) {
      return {
        unicast: formatLiveuiTaskSettingsAck({
          taskId,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onSetLiveuiTaskSettingValues) {
      return {
        unicast: formatLiveuiTaskSettingsAck({
          taskId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err) => {
      logger.error(`[downstream] set LiveUI Task Settings failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskSettingsAck({
          taskId,
          status: "rejected",
          code: "task_setting_values_update_failed",
        }),
      };
    };
    return Promise.resolve(onSetLiveuiTaskSettingValues({
      clientId,
      taskId,
      expectedDigest,
      values,
    })).then(
      (result) => {
        const ack = formatLiveuiTaskSettingsAck({ taskId, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleOrganizeLiveuiLibrary(clientId, msg) {
    const params = {
      clientId,
      action: typeof msg.action === "string" ? msg.action : "",
      expectedDigest: typeof msg.expectedDigest === "string" ? msg.expectedDigest : "",
      ...(typeof msg.itemType === "string" ? { itemType: msg.itemType } : {}),
      ...(typeof msg.itemId === "string" ? { itemId: msg.itemId } : {}),
      ...(Array.isArray(msg.order) ? { order: msg.order } : {}),
      ...(Object.prototype.hasOwnProperty.call(msg, "name") ? { name: msg.name } : {}),
      ...(Object.prototype.hasOwnProperty.call(msg, "description")
        ? { description: msg.description }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(msg, "icon") ? { icon: msg.icon } : {}),
    };
    if (!isPhoneClient(clientId)) {
      return {
        unicast: formatLiveuiLibraryOrganizeAck({
          action: params.action,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onOrganizeLiveuiLibrary) {
      return {
        unicast: formatLiveuiLibraryOrganizeAck({
          action: params.action,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err) => {
      logger.error(`[downstream] organize LiveUI Library failed: ${err.message}`);
      return {
        unicast: formatLiveuiLibraryOrganizeAck({
          action: params.action,
          status: "rejected",
          code: "library_organize_failed",
        }),
      };
    };
    return Promise.resolve(onOrganizeLiveuiLibrary(params)).then(
      (result) => {
        const ack = formatLiveuiLibraryOrganizeAck({
          action: params.action,
          ...(result || {}),
        });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([phone, glasses]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(phone || {}), formatLiveuiLibrary(glasses)],
        }));
      },
      failure,
    ).catch(failure);
  }

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

  function handleGetAgentsCatalog(clientId) {
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
    return Promise.resolve(onGetAgentsCatalog()).then(
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

  function handleGetSonioxModels(clientId) {
    if (!onGetSonioxModels) {
      return {
        unicast: formatSonioxModels({
          models: [],
          fetchedAtMs: Date.now(),
          stale: true,
        }),
      };
    }
    return Promise.resolve(onGetSonioxModels()).then(
      (payload) => ({
        unicast: formatSonioxModels(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getSonioxModels failed: ${err.message}`);
        return {
          unicast: formatSonioxModels({
            models: [],
            fetchedAtMs: Date.now(),
            stale: true,
          }),
        };
      },
    );
  }

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

  function handleGetSessionModelConfig(clientId) {
    if (!onGetSessionModelConfig) {
      return { unicast: formatError("getSessionModelConfig is not available") };
    }
    return Promise.resolve(onGetSessionModelConfig()).then(
      (payload) => ({
        unicast: formatSessionModelConfig(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getSessionModelConfig failed: ${err.message}`);
        return { unicast: formatError(err.message || "getSessionModelConfig failed") };
      },
    );
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

  function parseSetSessionAgent(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("setSessionAgent payload must be an object");
    }
    if (!Object.prototype.hasOwnProperty.call(msg, "agentId")) {
      throw new Error("setSessionAgent requires an agentId field");
    }
    if (msg.agentId !== null && typeof msg.agentId !== "string") {
      throw new Error("agentId must be a string or null");
    }
    return { agentId: typeof msg.agentId === "string" ? msg.agentId.trim() : "" };
  }

  function handleSetSessionAgent(clientId, msg) {
    if (!onSetSessionAgent) {
      return {
        unicast: formatSessionAgentAck({
          status: "rejected",
          error: "setSessionAgent is not available",
        }),
      };
    }
    let payload;
    try {
      payload = parseSetSessionAgent(msg);
    } catch (err) {
      return {
        unicast: formatSessionAgentAck({
          status: "rejected",
          error: err && err.message ? err.message : "invalid setSessionAgent payload",
        }),
      };
    }
    return Promise.resolve(onSetSessionAgent(payload)).then(
      (result) => ({
        unicast: formatSessionAgentAck(result || { status: "accepted" }),
      }),
      (err) => ({
        unicast: formatSessionAgentAck({
          status: "rejected",
          error: err && err.message ? err.message : "setSessionAgent failed",
        }),
      }),
    );
  }

  function handleSetSessionModelConfig(clientId, msg) {
    const requestId =
      msg && typeof msg.requestId === "string" && msg.requestId.trim()
        ? msg.requestId.trim()
        : undefined;
    const formatAck = (payload) =>
      formatSessionModelConfigAck(
        requestId === undefined ? payload : { ...payload, requestId },
      );

    if (!onSetSessionModelConfig) {
      return {
        unicast: formatAck({
          status: "rejected",
          error: "setSessionModelConfig is not available",
        }),
      };
    }

    let payload;
    try {
      payload = parseSetSessionModelConfig(msg);
    } catch (err) {
      return {
        unicast: formatAck({
          status: "rejected",
          error: err && err.message ? err.message : "invalid setSessionModelConfig payload",
        }),
      };
    }

    return Promise.resolve(onSetSessionModelConfig(payload)).then(
      (result) =>
        ({
          unicast: formatAck(result || { status: "accepted" }),
        }),
      (err) =>
        ({
          unicast: formatAck({
            status: "rejected",
            error: err && err.message ? err.message : "setSessionModelConfig failed",
          }),
        }),
    );
  }

  function handleCompactSession(clientId, msg) {
    if (!onCompactSession) {
      return Promise.resolve({
        unicast: formatCompactSessionAck({
          status: "rejected",
          requestId: msg && msg.requestId,
          error: "compactSession is not available",
        }),
      });
    }
    const sessionKey =
      msg && typeof msg.sessionKey === "string" && msg.sessionKey
        ? msg.sessionKey
        : null;
    if (!sessionKey) {
      return Promise.resolve({
        unicast: formatCompactSessionAck({
          status: "rejected",
          requestId: msg && msg.requestId,
          error: "sessionKey is required",
        }),
      });
    }
    return Promise.resolve(onCompactSession({ sessionKey })).then(
      (result) => ({
        unicast: formatCompactSessionAck({
          ...(result || { status: "accepted" }),
          requestId: msg.requestId,
        }),
      }),
      (err) => ({
        unicast: formatCompactSessionAck({
          status: "rejected",
          requestId: msg.requestId,
          error: err && err.message ? err.message : "compactSession failed",
        }),
      }),
    );
  }

  function handleGetEvenAiSettings(clientId) {
    if (!onGetEvenAiSettings) {
      return { unicast: formatError("getEvenAiSettings is not available") };
    }
    return Promise.resolve(onGetEvenAiSettings()).then(
      (payload) => ({
        unicast: formatEvenAiSettings(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getEvenAiSettings failed: ${err.message}`);
        return { unicast: formatError(err.message || "getEvenAiSettings failed") };
      },
    );
  }

  function handleGetEvenAiSessions(clientId) {
    if (!onGetEvenAiSessions) {
      return { unicast: formatError("getEvenAiSessions is not available") };
    }
    return Promise.resolve(onGetEvenAiSessions()).then(
      (payload) => ({
        unicast: formatEvenAiSessions(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getEvenAiSessions failed: ${err.message}`);
        return { unicast: formatEvenAiSessions({ sessions: [] }) };
      },
    );
  }

  function handleSetEvenAiSettings(clientId, msg) {
    if (!onSetEvenAiSettings) {
      return {
        unicast: formatEvenAiSettingsAck({
          status: "rejected",
          error: "setEvenAiSettings is not available",
        }),
      };
    }

    let payload;
    try {
      payload = parseSetEvenAiSettings(msg);
    } catch (err) {
      return {
        unicast: formatEvenAiSettingsAck({
          status: "rejected",
          error: err && err.message ? err.message : "invalid setEvenAiSettings payload",
        }),
      };
    }

    return Promise.resolve(onSetEvenAiSettings(payload)).then(
      (result) => ({
        unicast: formatEvenAiSettingsAck(result || { status: "accepted" }),
      }),
      (err) => ({
        unicast: formatEvenAiSettingsAck({
          status: "rejected",
          error: err && err.message ? err.message : "setEvenAiSettings failed",
        }),
      }),
    );
  }

  function handleGetOcuClawSettings(clientId) {
    if (!onGetOcuClawSettings) {
      return { unicast: formatError("getOcuClawSettings is not available") };
    }
    return Promise.resolve(onGetOcuClawSettings()).then(
      (payload) => ({
        unicast: formatOcuClawSettings(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getOcuClawSettings failed: ${err.message}`);
        return { unicast: formatError(err.message || "getOcuClawSettings failed") };
      },
    );
  }

  function handleSetOcuClawSettings(clientId, msg) {
    if (!onSetOcuClawSettings) {
      return {
        unicast: formatOcuClawSettingsAck({
          status: "rejected",
          error: "setOcuClawSettings is not available",
        }),
      };
    }

    let payload;
    try {
      payload = parseSetOcuClawSettings(msg);
    } catch (err) {
      return {
        unicast: formatOcuClawSettingsAck({
          status: "rejected",
          error: err && err.message ? err.message : "invalid setOcuClawSettings payload",
        }),
      };
    }

    return Promise.resolve(onSetOcuClawSettings(payload)).then(
      (result) => ({
        unicast: formatOcuClawSettingsAck(result || { status: "accepted" }),
      }),
      (err) => ({
        unicast: formatOcuClawSettingsAck({
          status: "rejected",
          error: err && err.message ? err.message : "setOcuClawSettings failed",
        }),
      }),
    );
  }

  function handleSwitchSession(clientId, msg) {
    if (!msg.sessionKey) return null;
    return onSwitchSession(msg.sessionKey).then(
      (pages) => ({
        broadcast: [
          formatSessionSwitched(msg.sessionKey),
          formatPages(pages),
        ],
      }),
      (err) => {

        if (
          err &&
          (err.reason === "session_switch_superseded" ||
            err.code === "session_switch_superseded")
        ) {
          return null;
        }
        logger.error(`[downstream] switchSession failed: ${err.message}`);
        if (err && (err.reason === "unsupported_session_key" || err.code === "unsupported_session_key")) {
          return {
            broadcast: [
              formatSessionSwitchRejected({
                sessionKey: msg.sessionKey,
                reason: "unsupported_session_key",
                currentSessionKey: err.currentSessionKey,
              }),
            ],
          };
        }
        return null;
      },
    );
  }

  function handleCopySession(clientId, msg) {
    if (!msg.sessionKey) return null;
    if (!isForeignHermesSessionKey(msg.sessionKey)) {
      return {
        unicast: JSON.stringify({
          type: APP_PROTOCOL.sessionCopyAck,
          ok: false,
          copiedFrom: msg.sessionKey,
          error: "foreign_session_copy_requires_foreign_source",
        }),
      };
    }
    return onCopySession(msg.sessionKey).then(
      (result) => {
        const ack = {
          unicast: JSON.stringify({
            type: APP_PROTOCOL.sessionCopyAck,
            ok: true,
            key: result.sessionKey,
            copiedFrom: msg.sessionKey,
          }),
        };

        if (result.superseded === true) return ack;
        return {
          ...ack,
          broadcast: [
            formatSessionSwitched(result.sessionKey),
            formatPages(result.pages),
          ],
        };
      },
      (err) => {
        logger.error(`[downstream] copySession failed: ${err.message}`);
        return {
          unicast: JSON.stringify({
            type: APP_PROTOCOL.sessionCopyAck,
            ok: false,
            copiedFrom: msg.sessionKey,
            error: err.message,
          }),
        };
      },
    );
  }

  function handleNewSession(
    clientId,
    msg = { agentRef: "", scope: "", requestId: "" },
  ) {
    let payload;
    try {
      payload = parseNewSession(msg);
    } catch (err) {
      return {
        unicast: formatError(
          err instanceof Error ? err.message : "invalid newSession payload",
          {
            requestId: parseOptionalTrimmedString(msg && msg.requestId),
            op: APP_PROTOCOL.sessionCreate,
          },
        ),
      };
    }
    return Promise.resolve(onNewSession(payload)).then(
      (result) => {
        const broadcast = [
          formatSessionSwitched(result.sessionKey, payload.requestId, result.draft),
          formatPages(result.pages),
        ];
        if (result && result.sessionModelConfig) {
          broadcast.push(formatSessionModelConfig(result.sessionModelConfig));
        }
        return { broadcast };
      },
      (err) => {
        logger.error(`[downstream] newSession failed: ${err.message}`);
        return {
          unicast: formatError(
            err instanceof Error ? err.message : "newSession failed",
            {
              requestId: payload.requestId,
              op: APP_PROTOCOL.sessionCreate,
            },
          ),
        };
      },
    );
  }

  function handleCreateEtSession(clientId, msg) {
    const requestId = parseOptionalTrimmedString(msg && msg.requestId);
    const reject = (error) => (
      requestId ? { unicast: formatSendAckCompat(requestId, "rejected", error) } : null
    );
    if (typeof createEtSession !== "function") {
      return reject("Even Terminal session creation is unavailable.");
    }
    const provider = msg && typeof msg.provider === "string" ? msg.provider.trim() : "";
    const text = msg && typeof msg.text === "string" ? msg.text : "";
    if ((provider !== "claude" && provider !== "codex") || !text.trim()) {
      return reject("Invalid Even Terminal session creation request.");
    }
    return Promise.resolve(createEtSession(provider, text)).then(
      (result) => {
        if (!result || typeof result.sessionKey !== "string" || !result.sessionKey) {
          return reject("Even Terminal session creation failed.");
        }

        const action = {};

        if (result.superseded !== true) {
          action.broadcast = [
            formatSessionSwitched(result.sessionKey),
            formatPages(result.pages),
          ];
        }
        if (requestId) action.unicast = formatSendAckCompat(requestId, "accepted");
        if (!action.broadcast && !action.unicast) return null;
        return action;
      },
      (err) => {
        const message = err && err.message ? err.message : "Even Terminal session creation failed.";
        logger.error(`[downstream] createEtSession failed: ${message}`);
        return reject(message);
      },
    );
  }

  function handleSetUserSessionTitle(clientId, msg) {
    if (typeof onSetUserSessionTitle !== "function") return null;
    const sessionKey =
      typeof msg.sessionKey === "string" ? msg.sessionKey.trim() : "";
    const title = typeof msg.title === "string" ? msg.title.trim() : "";
    if (!sessionKey || !title) return null;
    if (title.length > 55) return null;

    const errorAction = (code) => ({
      unicast: formatError(code, {
        code,
        op: "session.title.set",
      }),
    });
    if (isForeignHermesSessionKey(sessionKey)) {
      return errorAction("session_not_renamable");
    }

    const failure = (err) => {
      const message = err && err.message ? err.message : String(err || "");
      const conflict = /already in use|unique/i.test(message);
      const code = conflict
        ? "session_title_conflict"
        : "session_title_update_failed";
      return errorAction(code);
    };

    const finish = (resolved) => {
      if (!resolved || resolved.ok !== false) return null;
      return resolved.code === "session_title_conflict"
        ? errorAction("session_title_conflict")
        : failure(new Error(resolved.code || "title update rejected"));
    };
    try {
      const result = onSetUserSessionTitle(sessionKey, title);
      if (result && typeof result.then === "function") {
        return result.then(finish, failure);
      }
      return finish(result);
    } catch (err) {
      return failure(err);
    }
  }

  function handleSetSessionPinned(clientId, msg) {
    if (typeof onSetSessionPinned !== "function") return null;
    const sessionKey =
      typeof msg.sessionKey === "string" ? msg.sessionKey.trim() : "";
    const pinned = msg.pinned === true;
    const kind = msg.kind;
    if (
      !sessionKey ||
      isForeignHermesSessionKey(sessionKey) ||
      (kind !== "ocuclaw" && kind !== "evenai")
    ) {
      return { unicast: formatError("invalid_session_pin_request") };
    }
    const result = onSetSessionPinned(sessionKey, pinned, kind);
    if (result && result.ok === false) {
      const code = result.reason === "cap" ? "pin_cap_reached" : "invalid_session_pin_request";
      return { unicast: formatError(code) };
    }
    return null;
  }

  function handleSetSessionHidden(clientId, msg) {
    if (typeof onSetSessionHidden !== "function") return null;
    const sessionKey =
      typeof msg.sessionKey === "string" ? msg.sessionKey.trim() : "";
    if (!sessionKey) {
      return {
        unicast: formatError("invalid_session_hidden_request", {
          code: "invalid_session_hidden_request",
          op: "session.hidden.set",
        }),
      };
    }
    const hidden = msg.hidden === true;
    const finish = (result) => {
      if (result && result.ok === false) {
        const code =
          typeof result.code === "string"
            ? result.code
            : "invalid_session_hidden_request";
        return {
          unicast: formatError(code, { code, op: "session.hidden.set" }),
        };
      }
      return null;
    };
    const failure = (err) => {
      logger.warn(
        `[handler] session.hidden.set failed: ${err && err.message ? err.message : err}`,
      );
      return {
        unicast: formatError("session_hidden_update_failed", {
          code: "session_hidden_update_failed",
          op: "session.hidden.set",
        }),
      };
    };
    try {
      const result = onSetSessionHidden(sessionKey, hidden);
      if (result && typeof result.then === "function") {
        return result.then(finish, failure);
      }
      return finish(result);
    } catch (err) {
      return failure(err);
    }
  }

  function handleDeleteSessions(clientId, msg) {
    if (typeof onDeleteSessions !== "function") return null;
    const sessionKeys = Array.isArray(msg.sessionKeys) ? msg.sessionKeys.filter((k) => typeof k === "string" && k) : [];
    const kind = msg.kind;
    const switchBeforeDelete = msg.switchBeforeDelete === true;
    if (
      sessionKeys.length === 0 ||
      sessionKeys.some(isForeignHermesSessionKey) ||
      (kind !== "ocuclaw" && kind !== "evenai")
    ) {
      return { unicast: formatError("invalid_session_delete_request") };
    }
    onDeleteSessions(sessionKeys, kind, switchBeforeDelete);
    return null;
  }

  function handleSearchTranscripts(clientId, msg) {
    if (typeof onSearchTranscripts !== "function") return null;
    const query = typeof msg.query === "string" ? msg.query : "";
    const kind = msg.kind;
    if (!query.trim() || (kind !== "ocuclaw" && kind !== "evenai" && kind !== "terminal")) {
      return { unicast: formatError("invalid_transcript_search_request") };
    }
    onSearchTranscripts(clientId, query, kind);
    return null;
  }

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

  function handleRequestSonioxTemporaryKey(clientId, msg) {
    let payload;
    try {
      payload = parseRequestSonioxTemporaryKey(msg);
    } catch (err) {
      return {
        unicast: formatSonioxTemporaryKeyError({
          voiceSessionId:
            msg && typeof msg.voiceSessionId === "string" ? msg.voiceSessionId : "",
          error: err && err.message ? err.message : "requestSonioxTemporaryKey failed",
          code: normalizeSonioxTemporaryKeyErrorCode(err),
        }),
      };
    }

    if (!onRequestSonioxTemporaryKey) {
      return {
        unicast: formatSonioxTemporaryKeyError({
          voiceSessionId: payload.voiceSessionId,
          error: "requestSonioxTemporaryKey is not available",
          code: "soniox_temp_key_unavailable",
        }),
      };
    }

    try {
      const result = onRequestSonioxTemporaryKey(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => ({ unicast: formatSonioxTemporaryKey(resolved || payload) }),
          (err) => {
            const error =
              err && err.message
                ? err.message
                : "requestSonioxTemporaryKey failed";
            return {
              unicast: formatSonioxTemporaryKeyError({
                voiceSessionId: payload.voiceSessionId,
                error,
                code: normalizeSonioxTemporaryKeyErrorCode(err),
              }),
            };
          },
        );
      }
      return { unicast: formatSonioxTemporaryKey(result || payload) };
    } catch (err) {
      return {
        unicast: formatSonioxTemporaryKeyError({
          voiceSessionId: payload.voiceSessionId,
          error: err && err.message ? err.message : "requestSonioxTemporaryKey failed",
          code: normalizeSonioxTemporaryKeyErrorCode(err),
        }),
      };
    }
  }

  function handleRequestCartesiaAccessToken(clientId, msg) {
    let payload;
    try {
      payload = parseRequestCartesiaAccessToken(msg);
    } catch (err) {
      return {
        unicast: formatCartesiaAccessTokenError({
          voiceSessionId:
            msg && typeof msg.voiceSessionId === "string" ? msg.voiceSessionId : "",
          error: err && err.message ? err.message : "requestCartesiaAccessToken failed",
          code: normalizeCartesiaAccessTokenErrorCode(err),
        }),
      };
    }

    if (!onRequestCartesiaAccessToken) {
      return {
        unicast: formatCartesiaAccessTokenError({
          voiceSessionId: payload.voiceSessionId,
          error: "requestCartesiaAccessToken is not available",
          code: "cartesia_access_token_unavailable",
        }),
      };
    }

    try {
      const result = onRequestCartesiaAccessToken(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => ({ unicast: formatCartesiaAccessToken(resolved || payload) }),
          (err) => ({
            unicast: formatCartesiaAccessTokenError({
              voiceSessionId: payload.voiceSessionId,
              error: err && err.message ? err.message : "requestCartesiaAccessToken failed",
              code: normalizeCartesiaAccessTokenErrorCode(err),
            }),
          }),
        );
      }
      return { unicast: formatCartesiaAccessToken(result || payload) };
    } catch (err) {
      return {
        unicast: formatCartesiaAccessTokenError({
          voiceSessionId: payload.voiceSessionId,
          error: err && err.message ? err.message : "requestCartesiaAccessToken failed",
          code: normalizeCartesiaAccessTokenErrorCode(err),
        }),
      };
    }
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

    handleMessage(clientId, raw) {
      let msg;
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
        case "simulateTool":
          return handleSimulateTool(clientId, msg);
        case "simulateApproval":
          return handleSimulateApproval(clientId, msg);
        case "simulateDemand":
        case "simulateEtDemand":
          return handleSimulateDemand(clientId, msg);
        case "simulateVoice":
          return handleSimulateVoice(clientId, msg);
        case "glasses_ui_surface_update":
          return handleGlassesUiSurfaceUpdateInject(clientId, msg);
        case APP_PROTOCOL.protocolSubscribe:
          return handleSubscribeProtocol(clientId);
        case APP_PROTOCOL.approvalResolve:
          return handleApprovalResponse(clientId, msg);
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
        case APP_PROTOCOL.sessionCreate:
          return handleNewSession(clientId, msg);
        case APP_PROTOCOL.sessionCreateEt:
          return handleCreateEtSession(clientId, msg);
        case APP_PROTOCOL.sessionTitleSet:
          return handleSetUserSessionTitle(clientId, msg);
        case "ocuclaw.session.pinned.set":
          return handleSetSessionPinned(clientId, msg);
        case APP_PROTOCOL.sessionHiddenSet:
          return handleSetSessionHidden(clientId, msg);
        case "ocuclaw.session.delete":
          return handleDeleteSessions(clientId, msg);
        case "ocuclaw.session.transcripts.search":
          return handleSearchTranscripts(clientId, msg);
        case APP_PROTOCOL.modelCatalogGet:
          return handleGetModelsCatalog(clientId);
        case APP_PROTOCOL.skillsCatalogGet:
        case "getSkills":
          return handleGetSkillsCatalog(clientId);
        case APP_PROTOCOL.liveuiLibraryGet:
          return handleGetLiveuiLibrary(clientId);
        case APP_PROTOCOL.liveuiLibraryOpen:
          return handleOpenLiveuiLibraryItem(clientId, msg);
        case APP_PROTOCOL.liveuiTaskCancel:
          return handleCancelLiveuiTaskLaunch(clientId, msg);
        case APP_PROTOCOL.liveuiTasksGet:
          return handleGetLiveuiTasksForPhone(clientId);
        case APP_PROTOCOL.liveuiTaskRunsGet:
          return handleGetLiveuiTaskRunsForPhone(clientId, msg);
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
        case APP_PROTOCOL.liveuiStatusGet:
          return handleGetLiveuiStatus(clientId);
        case APP_PROTOCOL.liveuiLibraryOrganize:
          return handleOrganizeLiveuiLibrary(clientId, msg);
        case APP_PROTOCOL.commandCatalogGet:
        case "getCommands":
          return handleGetCommandCatalog(clientId);
        case APP_PROTOCOL.agentsCatalogGet:
        case "getAgentsCatalog":
          return handleGetAgentsCatalog(clientId);
        case APP_PROTOCOL.sonioxModelsGet:
        case "getSonioxModels":
          return handleGetSonioxModels(clientId);
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
                surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
                outcome: msg.outcome,
              });
            } catch (err) {
              logger.warn(
                `[downstream] glasses_ui_result handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;

        case "et_demand_response":
        case "demand_response": {
          const surfaceId =
            typeof msg.surfaceId === "string" ? msg.surfaceId.trim() : "";
          const result =
            msg.result === "selected" ||
            msg.result === "await_text" ||
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
              const frame = { surfaceId, result };
              if (result === "selected") frame.selectedIndex = selectedIndex;
              if (result === "selected" && validSelectedIndices) {
                delete frame.selectedIndex;
                frame.selectedIndices = selectedIndices;
              }
              onDemandResponse(frame);
            } catch (err) {
              logger.warn(
                `[downstream] demand_response handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        }
        case "surface_render_receipt":

          if (typeof onGlassesUiRenderReceipt === "function") {
            try {
              onGlassesUiRenderReceipt({
                surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
                seq: Number.isFinite(msg.seq) ? Math.floor(msg.seq) : null,
              });
            } catch (err) {
              logger.warn(
                `[downstream] surface_render_receipt handler threw: ${err && err.message ? err.message : err}`,
              );
            }
          }
          return null;
        case "glasses_ui_nav_event":

          if (typeof onGlassesUiNavEvent === "function") {
            try {
              onGlassesUiNavEvent({
                surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
                depth: Number.isFinite(msg.depth) ? Math.max(1, Math.floor(msg.depth)) : 1,
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
                onGlassesUiRenderInject({
                  surfaceId: typeof msg.surfaceId === "string" ? msg.surfaceId : "",
                  sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
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
          const validation = validateGlassesUiSpec(msg.spec);
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
          if (marker && marker !== "listening" && marker !== "parked" && marker !== "inflight") {
            return { unicast: formatSendAckCompat(id, "rejected", "glasses_ui_render marker must be listening|parked|inflight") };
          }
          try {
            onGlassesUiRenderInject({
              surfaceId,
              sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
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
            } catch (err) {
              logger.warn(
                `[downstream] glasses_presence_changed handler threw: ${err && err.message ? err.message : err}`,
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
    formatModelsCatalog,
    formatSkillsCatalog,
    formatLiveuiLibrary,
    formatLiveuiLibraryOpenResult,
    formatLiveuiTasks,
    formatLiveuiTaskReviewAck,
    formatLiveuiTaskExecutors,
    formatLiveuiTaskExecutorAck,
    formatLiveuiTaskPreferredTemplateAck,
    formatLiveuiTaskContextAck,
    formatLiveuiTaskSettingsAck,
    formatLiveuiPrefs,
    formatLiveuiPrefsAck,
    formatLiveuiStatus,
    formatCommandCatalog,
    formatAgentsCatalog,
    formatSonioxModels,
    formatProviderUsageSnapshot,
    formatCapabilitySnapshot,
    formatPushMessage,
    formatSessionModelConfig,
    formatSessionModelConfigAck,
    formatEvenAiSettings,
    formatOcuClawSettings,
    formatEvenAiSessions,
    formatEvenAiSettingsAck,
    formatOcuClawSettingsAck,
    formatApproval,
    formatApprovalResolved,
    formatApprovalResponseAck,
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
    },
  };
}

module.exports = { createDownstreamHandler };
