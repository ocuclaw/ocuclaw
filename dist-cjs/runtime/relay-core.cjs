const { createProgramCardDraftService, PROGRAM_CARD_DRAFT_CAPABILITY } = require("../tools/program-card-drafts.cjs");
const { composeCardOpenWhy, PROGRAM_CARD_CHECK_CARDS_MAX, PROGRAM_CARD_NO_DRAFT_SERVICE, programCardNamedParts, withCardPhoneWhy } = require("../tools/program-card-health.cjs");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { createFirstUseStore, createFirstUseObserver, runFirstUseOperation, firstUseBinding, classifyFirstUseReplyEvidence, firstUseResult, observeReplyEvidenceInto, firstUseAttemptHoldsSideWork, firstUseAttemptPredatesPairing } = require("../setup/first-use.cjs");
const { setupInstallation, firstUseRunErrored, firstUseWithRunErrored, firstUseProviderErrorClass, FIRST_USE_ERRORED_RUN_REASONS } = require("../setup/setup-journey.cjs");
const { createSetupWelcome } = require("../setup/welcome.cjs");
const { createModelSitesService } = require("../tools/liveui-model-sites/model-sites-service.cjs");
const { createFirstUseRelayRun, FIRST_USE_RELAY_ARM_LINES, FIRST_USE_RELAY_ARM_ACTION, FIRST_USE_RELAY_WELCOME_LINES } = require("../setup/first-use-relay-run.cjs");
const { createPluginVersionService } = require("./plugin-version-service.cjs");
const conversationStateModule = require("../domain/conversation-state.cjs");
const { createDebugStore } = require("../domain/debug-store.cjs");
const { redactDiagnosticData } = require("../domain/debug-bundle-redaction.cjs");
const { startUploadCaptureArming } = require("../domain/debug-upload-preset.cjs");
const { summarizeGlassesUiContent } = require("../domain/glasses-ui-content-summary.cjs");
const { composeReadabilitySystemPrompt } = require("../domain/readability-system-prompt.cjs");
const { CODE_PLATE_CAPABILITY, composeGlassesUiChannelOne, RETIRED_V1_CHANNEL_ONE_MARKER } = require("../domain/glasses-ui-system-prompt.cjs");
const { composeQuestionLikelyAnswersChannelOne } = require("../domain/question-answers-prompt.cjs");
const { LIVEUI_MODEL_ROUTING_GUIDANCE } = require("../tools/glasses-ui-compose-tool.cjs");
const { composeGlassesDisplaySystemPrompt } = require("../domain/glasses-display-system-prompt.cjs");
const { createStablePromptSnapshotStore } = require("./stable-prompt-snapshot.cjs");
const { createPromptTurnOwnership } = require("./prompt-turn-ownership.cjs");
const { createBufferedHttpRequest, createBufferedHttpResponse } = require("./buffered-http.cjs");
const { createRelayPairing } = require("./relay-pairing.cjs");
const { createVoiceCredentials } = require("./voice-credentials.cjs");
const { createHermesEnrollment, HERMES_DEFAULT_PROFILE } = require("./hermes-enrollment.cjs");
const { createMintAgentRefs } = require("./mint-agent-ref.cjs");
const { createEventChannel } = require("./event-channel.cjs");
const { createRelaySimulation } = require("./relay-simulation.cjs");
const { createRelaySessionModelConfig } = require("./relay-session-model-config.cjs");
const { createRelaySessionHandlers } = require("./relay-session-handlers.cjs");
const { createRelayVoiceHandlers } = require("./relay-voice-handlers.cjs");
const { createRelayLiveuiHandlers } = require("./relay-liveui-handlers.cjs");
const { createRelayToolingHandlers } = require("./relay-tooling-handlers.cjs");
const { createRelayProgramCardHandlers } = require("./relay-program-card-handlers.cjs");
const { createRelayTaskHandlers } = require("./relay-task-handlers.cjs");
const { createRelayGlassesUiHandlers } = require("./relay-glasses-ui-handlers.cjs");
const { createRelayAgentHandlers } = require("./relay-agent-handlers.cjs");
const { createRelayCatalogHandlers } = require("./relay-catalog-handlers.cjs");
const { createRelaySetupHandlers } = require("./relay-setup-handlers.cjs");
const { createRelayStarMapHandlers } = require("./relay-star-map-handlers.cjs");
const { createRelayChatTurnHandlers } = require("./relay-chat-turn-handlers.cjs");
const { createRelaySettingsHandlers } = require("./relay-settings-handlers.cjs");
const { createActivityStatusAdapter } = require("../domain/activity-status-adapter.cjs");
const { activityNarrateGuidance, resolveActivityLabs } = require("../domain/activity-labs.cjs");
const { createEvenAiEndpoint } = require("../even-ai/even-ai-endpoint.cjs");
const { createEvenAiRestartRecovery, createEvenAiSendJournal } = require("../even-ai/even-ai-restart-recovery.cjs");
const { createEvenAiRequestObservation } = require("../even-ai/even-ai-request-observation.cjs");
const { createEvenAiRouter } = require("../even-ai/even-ai-router.cjs");
const { createEvenAiRunWaiter } = require("../even-ai/even-ai-run-waiter.cjs");
const { createEvenAiSettingsStore, normalizeEvenAiDefaultAgent } = require("../even-ai/even-ai-settings-store.cjs");
const { createPluginOpenclawClient } = require("../gateway/openclaw-client.cjs");
const { createPluginRpcGatewayBridge, scopeOpenClawSessionKey } = require("../gateway/gateway-bridge.cjs");
const { createInputPredictionService } = require("./input-prediction-service.cjs");
const { createApprovalExplainer } = require("./approval-explainer.cjs");
const { createProgramCardReviewer } = require("./program-card-review.cjs");
const { createTaskResultProposals } = require("./task-result-proposal.cjs");
const { createAgentDrafts } = require("./agent-draft.cjs");
const { createTaskFromWords } = require("./task-from-words.cjs");
const { createTaskPresentations } = require("./task-presentations.cjs");
const { createTaskCardCreate, TASK_CARD_TEST_SOURCE } = require("./task-card-create.cjs");
const { createTaskFixSave } = require("../tools/task-fix-save.cjs");
const { createTaskFixUndo } = require("../tools/task-fix-undo.cjs");
const { createTaskCardLookUndo } = require("../tools/glasses-ui-task-card-look-undo.cjs");
const { taskScheduleBinding } = require("../tools/glasses-ui-task-schedule.cjs");
const { liveuiLibraryDigest } = require("../tools/glasses-ui-library.cjs");
const { formatProgramCardFrame, formatProgramCardRevisions } = require("./downstream-codec-liveui.cjs");
const { createFrameBriefMemory, createProgramCardFrameRedo } = require("../tools/program-card-frame-redo.cjs");
const { FRAME_GRID_CELLS, FRAME_SCREEN_CELLS, frameScreenFromGrid } = require("../tools/program-card-frame-save.cjs");
const { liveuiTemplateValuesOwner } = require("../tools/glasses-ui-template-values.cjs");
const { PROGRAM_CARD_LOOK_CAPABILITY, PROGRAM_CARD_LOOK_CASES_HOST_MS, PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS, PROGRAM_CARD_LOOK_PLAY_CAPABILITY, PROGRAM_CARD_LOOK_RESULT_MAX_BYTES, PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY } = require("../tools/program-card-look.cjs");
const { PROGRAM_CARD_LOOK_DRIVE_CAPABILITY } = require("../tools/program-card-look-drive.cjs");
const { PROGRAM_CARD_FRAME_DRAW_CAPABILITY, PROGRAM_CARD_FRAME_IDEA_CAPABILITY } = require("../tools/program-card-frame-lane.cjs");
const { createBackendPrewarm } = require("./backend-prewarm.cjs");
const { resolveInputPredictionIdentity } = require("./input-prediction-identity.cjs");
const { createOpenClawAgentCreator } = require("../gateway/openclaw-agent-create.cjs");
const { createOpenClawAgentEmojiUpdater } = require("../gateway/openclaw-agent-emoji.cjs");
const { createOpenClawAgentSettings } = require("../gateway/openclaw-agent-settings.cjs");
const { createOpenClawAgentDefaults } = require("../gateway/openclaw-agent-defaults.cjs");
const { createOpenClawManagement } = require("./openclaw-management.cjs");
const { createOpenClawTaskSchedule, taskIdOfJob, testIdOfJob } = require("./openclaw-task-schedule.cjs");
const { createOpenClawTaskResults } = require("./openclaw-task-results.cjs");
const { createOpenClawDayWrapLink } = require("./openclaw-task-day-wrap.cjs");
const { createTaskAlertMemory } = require("../domain/task-alert-state.cjs");
const { taskRunPromptNamed } = require("../domain/task-run-prompt.cjs");
const { MODELS_OPERATIONS } = require("./hermes-models-management.cjs");
const { createLiveUiPictureHost } = require("../gateway/liveui-picture-host.cjs");
const { isKnownBackendKind, setActiveBackendKind, getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { createAgentTurnTracker } = require("../tools/glasses-ui-wake.cjs");
const { createCardBuildTurns } = require("./card-build-turn.cjs");
const { cardAskApproved } = require("../tools/program-card-ask-tool.cjs");
const { mintPreloadedChildren, preloadedChildrenAreMinted } = require("../tools/glasses-ui-children.cjs");
const { liveUiPresetFrame } = require("../tools/liveui-compiler/preset-forms.cjs");
const { gatewaySessionKeyFor, relaySessionKeyFor } = require("./openclaw-session-key.cjs");
const { createArmedJevConnection, createJevClient, jevFeaturesArmed } = require("../domain/glasses-ui-jev-client.cjs");
const { createSurfaceDecisionFirer, createSurfaceDecisionStore } = require("../domain/glasses-ui-decision-store.cjs");
const { createLiveUiAskedWordsStore } = require("../domain/liveui-asked-words.cjs");
const { createWebJevShadow } = require("../domain/firecrawl-web-jev.cjs");
const { JEV_MODEL_ID, buildJevState, composeSurfaceDecision, composeV2SurfaceDecision } = require("../domain/glasses-ui-surface-decision.cjs");
const { composeCardDecision } = require("../domain/glasses-ui-jev-card.cjs");
const { parseLiveUiClientCapabilities } = require("../domain/liveui-v2-client-forms.cjs");
const { getRegisteredLiveuiGlassesLibraryController, getRegisteredGlassesUiHandler } = require("../tools/glasses-ui-tool.cjs");
const { createLiveuiTaskRunController } = require("../tools/glasses-ui-task-run.cjs");
const { projectTaskRunRecord } = require("../tools/glasses-ui-task-run-records.cjs");
const { createProgramCardFeed, createProgramCardFeedStore, feedCardFromScheduledResult, formatProgramCardBindings, formatProgramCardRefreshResult, programCardFollowsOwnChanges } = require("../tools/glasses-ui-program-card-feed.cjs");
const { createTaskOpenUpdate, createTaskOpenUpdateStore } = require("../tools/glasses-ui-task-open-update.cjs");
const { TASK_RUNS_WATCH_BEAT_MS, createTaskRunsWeek, createTaskRunsWeekStore } = require("../tools/glasses-ui-task-runs-week.cjs");
const { TASK_USES_CHECK_FAILED_REASON, TASK_USES_NOT_ALLOWED, TASK_USES_NOT_OFFERED, TASK_USES_NOT_ON_OPEN, createTaskHeldPolicy, createTaskJobMemory, createTaskUsesPolicy, createTaskUsesStore, taskStepMcpFacts } = require("../tools/glasses-ui-task-uses.cjs");
const { createTaskToolLedger, taskToolGroupOfMcp } = require("../tools/glasses-ui-task-tool-failures.cjs");
const { createLiveuiTaskTests } = require("../tools/glasses-ui-task-test.cjs");
const { CARD_STARTER_FIRST_STATE, cardStarterName, cardStarterSource, savedTaskStarterCard } = require("../tools/card-starters.cjs");
const { starterCheckStart, starterCheckVerdict } = require("../tools/task-starter-check.cjs");
const { AUTOMATION_REFUSED_TOOLS, cronJobOfSessionKey } = require("./openclaw-automation-run-guard.cjs");
const { taskUncheckedRunFailure } = require("../tools/glasses-ui-task-unchecked.cjs");
const { createTaskCardRuns } = require("../domain/task-card-runs.cjs");
const { cardHasParts, createCardPartRuns } = require("../tools/glasses-ui-card-part-runs.cjs");
const { createTaskCheckAgain, createTaskCheckAgainStore, taskCheckAgainAsk, taskCheckAgainSends } = require("../tools/glasses-ui-task-check-again.cjs");
const { createCardPartLink } = require("../tools/glasses-ui-card-part-link.cjs");
const { addCardPart, cardPartAddHandOff, followCardParts, linkedCardParts, repinCardParts } = require("../tools/glasses-ui-card-part-add.cjs");
const { TASK_FIX_BUILD_CODES, taskFixAskWords, taskFixHandOff, taskFixLabel, taskFixLastValues, taskFixPick, taskFixSavedValues } = require("../tools/glasses-ui-task-fix-build.cjs");
const { cardChangeTurnLine, changeLinesOfWords, createCardChanges, findSavedCard, PROGRAM_CARD_CHANGE_SAVED_TYPE } = require("../tools/program-card-change.cjs");
const { PROGRAM_CARD_TASK_RUN_CAPABILITY, PROGRAM_CARD_TASK_RUN_GUIDE, PROGRAM_CARD_TASK_UNCHECKED_CAPABILITY, PROGRAM_CARD_TASK_UNCHECKED_GUIDE } = require("../tools/program-card-guide.cjs");
const { PROGRAM_CARD_JEV_CAPABILITY, createProgramCardJev, createProgramCardJevStore } = require("../tools/glasses-ui-program-card-jev.cjs");
const { createProgramCardArt, createProgramCardArtStore } = require("../tools/program-card-art.cjs");
const { PROGRAM_CARD_MCP_CAPABILITY, PROGRAM_CARD_MCP_WRITES_CAPABILITY, createProgramCardMcp, createProgramCardMcpStore, createProgramCardMcpWritesStore, createProgramCardSourceRev } = require("../tools/glasses-ui-program-card-mcp.cjs");
const { createProgramCardHostCommands } = require("../tools/program-card-host-commands.cjs");
const { createHermesProgramCardMcpHost } = require("./program-card-mcp-hosts.cjs");
const { createProgramCardModel, createProgramCardModelStore } = require("../tools/glasses-ui-program-card-model.cjs");
const { createProgramCardAgentRefresh, createProgramCardAgentRefreshStore } = require("../tools/glasses-ui-program-card-agent-refresh.cjs");
const { createProgramCardLocation, PROGRAM_CARD_LOCATION_SETTLE } = require("../tools/glasses-ui-program-card-location.cjs");
const { createProgramCardSetupRequests, createProgramCardSetupRequestsStore } = require("../tools/program-card-setup-requests.cjs");
const { onProgramCardDeleted } = require("../tools/glasses-ui-library.cjs");
const { forgetDeletedProgramCard } = require("../tools/glasses-ui-program-card-delete.cjs");
const { PROGRAM_CARD_TASK_SLOTS_CAPABILITY, TASK_SLOTS_DATA_MAX, TASK_SLOT_FIRST, bindingSlot, cardTaskSlots, taskSlotsCap, validTaskSlotName } = require("../tools/glasses-ui-task-slots.cjs");
const { TASK_FIX_CAPABILITY, taskFixDoneOpen, taskFixEnding } = require("../tools/glasses-ui-task-fix.cjs");
const { createHermesProgramCardModelHost } = require("./program-card-model-hosts.cjs");
const { compareRungs } = require("../tools/glasses-ui-delivery-ladder.cjs");
const { createLiveuiExecutorRegistry, projectTaskExecutorState, resolveLiveuiExecutorRegistryRoot } = require("../tools/glasses-ui-executor-registry.cjs");
const { createProgramCardSaves, forgetProgramCardClient, noteOpenProgramCard, notePlanIcon, planIconForSession } = require("../tools/program-card-saves.cjs");
const { programCardKitLevelOf, programCardLibraryWithKits } = require("../tools/program-card-kit-check.cjs");
const { createProgramCardIconPicker } = require("../tools/program-card-icon-pick.cjs");
const { createCardIconModelClient, LINK_PROGRAM_CARD_ICON_LLM_COMPLETE_METHOD } = require("../tools/program-card-icon-model.cjs");
const { CARD_ICON_QUESTIONS } = require("../domain/program-card-icons.cjs");
const { createDownstreamHandler } = require("./downstream-handler.cjs");
const { createBundleCache } = require("../domain/debug-bundle-cache.cjs");
const { createClientEventFoldCache } = require("../domain/debug-client-fold-cache.cjs");
const { createOcuClawSettingsStore, normalizeOcuClawAgentProgressNotes, normalizeOcuClawCardBuildFastMode, ocuClawDefaultAgentAsAgentId, sanitizeOcuClawWaitingAvailableSurfaces } = require("./ocuclaw-settings-store.cjs");
const { createSavedPromptsStore } = require("./saved-prompts-store.cjs");
const { buildCapabilitySnapshot, buildPushMessage } = require("./capability-snapshot.cjs");
const { createRelayHealthMonitor } = require("./relay-health-monitor.cjs");
const { createGlassesBackpressureLatch } = require("./glasses-backpressure-latch.cjs");
const { createRelayOperationRegistry } = require("./relay-operation-registry.cjs");
const { createRelayWorkerSupervisor } = require("./relay-worker-supervisor.cjs");
const { isPairingControlPath, isPairingEndpointPath } = require("../domain/pairing/pairing-endpoint-address.cjs");
const { LIVEUI_AUDIO_PATH, LIVEUI_SUBTITLES_PATH } = require("../tools/liveui-video/video-service.cjs");
const { createDefaultPhoneExitNode } = require("../tools/liveui-video/phone-exit-node.cjs");
const { readTailscaleCliReceipt, resolveHostStateDir, writeJsonReceiptDurable } = require("../setup/private-route.cjs");
const { JEV_CHECK_FILE, clearJevCheckRecord, createJevKeyCheck, writeJevCheckRecord } = require("../setup/jev-key-check.cjs");
const { createSessionService } = require("./session-service.cjs");
const { GREETING_SEND_HOLD_DEADLINE_MS } = require("./greeting-send-gate.cjs");
const { createSessionsGoneHandler } = require("./sessions-gone.cjs");
const { createUpstreamRuntime, classifyRunOutcomeFrame, isCancelledRunFrame } = require("./upstream-runtime.cjs");
const { CARD_BUILD_CHANGE_RUN_WAIT_MS, CARD_BUILD_TASK_CAPABILITY, CARD_STUDIO_CAPABILITY, cardBuildLegacyFrame, cardBuildReasoningSignal, cardBuildView, createCardBuildPhases } = require("./card-build-phases.cjs");
const { CARD_STUDIO_CATEGORY, createCardStudioStore } = require("../domain/card-studio-stream.cjs");
const { LINK_TASK_OUTPUT_SNAPSHOT_METHOD, createCardStudioReport } = require("../tools/card-studio-report.cjs");
const { createProgramCardRevisions } = require("../tools/program-card-revisions.cjs");
const { createProgramCardSlotHandlers, createProgramCardSlots } = require("../tools/program-card-slots.cjs");
const { createLiveuiTaskRunRecordStore } = require("../tools/glasses-ui-task-run-records.cjs");
const { PROGRAM_CARD_REVIEWS_DIRECTORY, programCardCurrentRevision } = require("../tools/glasses-ui-library.cjs");
const { CARD_ASK_CHANGE_WAIT_MS, fitCardDirections, fitCardPlan, fitCardSites, PROGRAM_CARD_CHANGE_CAPABILITY, PROGRAM_CARD_CHOICE_CAPABILITY, PROGRAM_CARD_PLAN_CAPABILITY } = require("../tools/program-card-plan.cjs");
const { createDemandRouter } = require("./demand-router.cjs");
const { buildDemandFrame } = require("./demand-surface.cjs");
const { createHermesSlashConfirmRouter } = require("./hermes-slash-confirm-router.cjs");
const { formatBoardMoment } = require("./hermes-board-moments.cjs");
const { LINK_TASK_RESULT_PUSH_METHOD, createHermesTaskPush, formatTaskPushMessage, supportsTaskPush } = require("./hermes-task-push.cjs");
const { createHermesTaskRows, createTaskRowsBroadcast, formatTaskLookOffer, taskLookOffer, taskPopupUntilMs, taskRowsMissJobs } = require("./hermes-task-rows.cjs");
const { readRecentTaskResultHistory } = require("./hermes-task-page.cjs");
const { createHermesClarifyRouter } = require("./hermes-clarify-router.cjs");
const { createReplyDeliveryCoordinator } = require("./reply-delivery-coordinator.cjs");
const { createOpenClawQuestionRouter } = require("./openclaw-question-router.cjs");
const { createOpenClawWaiting, OPENCLAW_WAITING_LOCAL_SURFACES } = require("./openclaw-waiting.cjs");
const { createRealtimeTalkLane } = require("./realtime-talk-lane.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { createTtsLane } = require("./tts-lane.cjs");
const { createPhoneSettingsRoundTrip } = require("../tools/phone-settings-tool.cjs");
const { createBotScreenShowRoundTrip } = require("../tools/bot-screen/show-bot-screen-tool.cjs");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY, extractEmbeddedEvenAiSessionKey } = require("../domain/even-ai-session-keys.cjs");
const { DEFAULT_HERMES_NAMESPACE, hermesProfileIdForNamespace, isAdoptedHermesSessionKey, mintedHermesSessionKey, parseHermesPublicKey } = require("./hermes-session-keys.cjs");
const { createSessionDriverWatch } = require("./session-driver-watch.cjs");
const { createProfileBotScreenSource } = require("../tools/bot-screen/profile-bot-screen.cjs");
const { BOT_SCREEN_AIM_MODEL } = require("../tools/bot-screen/bot-screen-aim.cjs");
const { BOT_SCREEN_ELEMENTS_EVENT, BOT_SCREEN_RUN_EVENT, BOT_SCREEN_STEP_EVENT, BOT_SCREEN_TARGET_EVENT, createBotScreenSource } = require("../tools/bot-screen/bot-screen-source.cjs");
const { MIRROR_AUTHOR, MIRROR_ORIGIN, createSessionMirrorWatch } = require("./session-mirror-watch.cjs");

const LIVEUI_TASK_DISCOVERY_CHANNEL_ONE =
  "The wearer may have saved LiveUI Tasks; before using shell, calendar or search tools, call manage_liveui_tasks find_tasks only when the Task index in your context lists a Task that fits the job or the wearer names a saved Task; with no Task index, or no listed Task that fits, skip find_tasks.";

const GLASSES_UI_MARKERS = new Set(["listening", "parked", "inflight", "processing", "refreshing"]);

const LIVEUI_RECONNECT_GRACE_DEFAULT_MS = 12_000;

function sanitizeGlassesMarker(v) { return GLASSES_UI_MARKERS.has(v) ? v : undefined; }

const GLASSES_UI_RENDER_ORIGINS = new Set(["agent", "cron", "task"]);
function sanitizeGlassesRenderOrigin(v     ) { return GLASSES_UI_RENDER_ORIGINS.has(v) ? v : undefined; }

const SKILL_LIST_WRITES = new Set(["tools.skillToggle", "clawhub.skills.install"]);

function glassesUiRenderPayload(
  params     ,
  context                                                   ,
  spec     ,
) {
  return {
    type: "glasses_ui_render",
    sessionKey: context.sessionKey,
    liveUiSessionGeneration: context.liveUiSessionGeneration,
    surfaceId: params && typeof params.surfaceId === "string" ? params.surfaceId : "",

    seq: Number.isFinite(params && params.seq) ? Math.floor(params.seq) : null,
    depth: Number.isFinite(params && params.depth) ? Math.floor(params.depth) : 1,
    spec: spec || null,
    marker: sanitizeGlassesMarker(params && params.marker),

    origin: sanitizeGlassesRenderOrigin(params && params.origin),

    collect: typeof (params && params.collect) === "boolean" ? params.collect : undefined,
    live: typeof (params && params.live) === "boolean" ? params.live : undefined,
  };
}

function parseHermesFeatureTokens(raw         ) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const seen = new Set();
  for (const piece of raw.split(",")) {
    const token = piece.trim().toLowerCase();
    if (token) seen.add(token);
  }
  return Array.from(seen).sort();
}

function resolveEvenAiRouterOptionsForBackend(backendKind     ) {
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
        ? (sessionKey     ) => {
            const parsed = parseHermesPublicKey(sessionKey);
            return !!parsed && parsed.kind === "minted";
          }
        : (sessionKey     ) =>
            typeof sessionKey === "string" &&
            sessionKey.trim().toLowerCase().startsWith("ocuclaw:"),
  };
}

const LISTEN_INTERCEPT_RECOVERY_ERROR = "Voice interrupted; retry";
const LISTEN_INTERCEPT_RECOVERY_CODE = "transport_interrupted";
const LOCATION_REQUEST_TARGET_TTL_MS = 30_000;

const PROGRAM_CARD_CAPABILITY = "programCardsV1";

const SECRET_ENTRY_CAPABILITY = "secretEntryV1";
const PROGRAM_CARD_REQUEST_TARGET_TTL_MS = 30_000;

const FRAME_REDO_SESSION_KEY = "ocuclaw-frame-redo";
const PROGRAM_CARD_FRAME_REDO_DRAW_TIMEOUT_MS = 20_000;
const PROGRAM_CARD_REQUEST_OPS = new Set(["command", "edit", "look", "frame_draw", "draft_prepare", "draft_launch", "draft_cancel", "draft_removed"]);
const PROGRAM_CARD_ERROR_MAX_CHARS = 600;
const PROGRAM_CARD_RESULT_MAX_CHARS = 24_000;

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

function resolveLiveUiSessionContext(
  sessionKey     ,
  activeSessionKey     ,
  ensureGeneration     ,
) {
  const explicitSessionKey =
    typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
  const fallbackSessionKey =
    typeof activeSessionKey === "string" && activeSessionKey.trim() ? activeSessionKey.trim() : null;
  const resolvedSessionKey = explicitSessionKey || fallbackSessionKey;
  return {
    sessionKey: resolvedSessionKey,
    liveUiSessionGeneration:
      resolvedSessionKey && typeof ensureGeneration === "function"
        ? ensureGeneration(resolvedSessionKey)
        : null,
  };
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

function createRelay(opts) {
  const firstUseStore = opts.setupStateDir ? createFirstUseStore(opts.setupStateDir) : null;
  const firstUseObserver      = firstUseStore ? createFirstUseObserver(firstUseStore, { readPhone: readSetupPhone }) : null;
  const setupWelcome = firstUseStore ? createSetupWelcome(firstUseStore, readSetupPhone,
    () => typeof opts.getSetupWelcomeRenderer === "function" ? opts.getSetupWelcomeRenderer() : getRegisteredGlassesUiHandler(),
    undefined, (runId     , signal     ) => awaitRunSettled(runId, signal)) : null;

  const firstUseRelayRun      = firstUseStore && setupWelcome ? createFirstUseRelayRun({
    store: firstUseStore,
    readPhone: () => readSetupPhone(),
    observe: (record     ) => observeReplyEvidenceInto(firstUseStore, record, observeFirstUseReplyEvidence),
    erroredRunSince: (startedAt     ) => erroredRunSince(startedAt),
    settledRunErrored: (record     ) => settledRunErrored(record),
    welcome: setupWelcome,
    wake: (params     ) => dispatchAgentWake(params),

    showLines: (params     ) => {
      if (getActiveBackendKind() === "hermes") return Promise.reject(new Error("show-lines-openclaw-only"));
      const gatewaySession = openclawGatewayKeyFor(params.sessionKey);
      return gatewayBridge.request("chat.inject", {
        sessionKey: gatewaySession.key,
        ...(gatewaySession.agentId ? { agentId: gatewaySession.agentId } : {}),
        message: params.message,
      });
    },
    onChange: () => publishSetupHintIfChanged(),
    log: (event     , fields     ) => emitDebug("relay.protocol", event, "info", {}, () => fields),
  }) : null;

  function readSetupPhone() {
    const snapshot = server?.getReadinessSnapshot();
    if (snapshot?.connectedClientCount !== 1 || snapshot?.clients?.length !== 1) throw new Error("setup-phone-session-ambiguous-or-disconnected");
    const clientId = snapshot.clients[0].clientId;
    const sessionKey = server.getClientSessionKey(clientId);
    if (!sessionKey) throw new Error("setup-phone-session-unavailable");
    return { clientId, sessionKey, generation: ensureLiveUiSessionGeneration(sessionKey) };
  }

  const RUN_OUTCOME_MAX = 64;

  const RUN_SETTLE_GRACE_MS = 1000;

  const RUN_SETTLE_MAX_WAIT_MS = 15000;
  const runOutcomes = new Map();
  function noteRunActivity(runId     , terminal     , errored     , code     ) {
    if (typeof runId !== "string" || !runId) return;
    const previous = runOutcomes.get(runId);
    runOutcomes.delete(runId);
    runOutcomes.set(runId, {

      errored: previous?.errored === true || errored === true,
      code: (errored === true && typeof code === "string" && code ? code : null) ?? previous?.code ?? null,
      terminal: previous?.terminal === true || terminal === true,
      terminalAt: previous?.terminal === true ? previous.terminalAt : (terminal === true ? Date.now() : null),
    });
    while (runOutcomes.size > RUN_OUTCOME_MAX) {
      runOutcomes.delete(runOutcomes.keys().next().value);
    }
  }
  function runErrored(runId     ) {
    return runOutcomes.get(runId)?.errored === true;
  }

  let lastErroredRun      = null;
  function noteErroredRun(runId     , errored     , code     ) {
    if (errored !== true || typeof runId !== "string" || !runId) return;
    lastErroredRun = { runId, code: typeof code === "string" && code ? code : null, at: Date.now() };
  }

  function noteRunOutcomeFrame(activity     , phase      = null, origin      = null) {
    const runId = activity && typeof activity.runId === "string" && activity.runId ? activity.runId : null;
    if (!runId) return;
    const outcome = classifyRunOutcomeFrame(activity, phase ?? activity.phase ?? null, origin ?? activity.origin ?? null);
    noteRunActivity(runId, outcome.terminal, outcome.errored, outcome.code);
    noteErroredRun(runId, outcome.errored, outcome.code);
    noteSetupTurnRun(activity, runId);
  }
  function erroredRunSince(startedAt     ) {
    if (!lastErroredRun) return null;

    const since = typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
    if (Number.isFinite(since) && lastErroredRun.at < since) return null;

    let attemptId      = null;
    try { attemptId = firstUseStore?.read()?.attemptId ?? null; } catch (_) { attemptId = null; }
    const own = firstUseObserver?.runsForAttempt?.(attemptId) ?? [];
    for (const runId of own) {
      const outcome = runOutcomes.get(runId);
      const erroredCode = outcome?.errored === true ? outcome.code
        : lastErroredRun.runId === runId ? lastErroredRun.code
        : undefined;

      if (erroredCode !== undefined) return firstUseRunErrored(erroredCode);
    }
    return null;
  }

  function settledRunErrored(record     ) {
    if (!record || !FIRST_USE_ERRORED_RUN_REASONS.includes(record.replyEvidenceReason)) return null;
    const runId = typeof record.reply?.runId === "string" ? record.reply.runId : null;
    const code = runId
      ? runOutcomes.get(runId)?.code ?? (lastErroredRun?.runId === runId ? lastErroredRun.code : null)
      : null;
    return code ? firstUseRunErrored(code)
      : { code: null, class: firstUseRunErrored(record.replyEvidenceReason).class };
  }

  function awaitRunSettled(runId     , signal      = null) {
    return new Promise      ((resolve) => {
      if (typeof runId !== "string" || !runId || !runOutcomes.has(runId)) return resolve();
      const deadline = Date.now() + RUN_SETTLE_MAX_WAIT_MS;
      let timer      = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener?.("abort", done);
        resolve();
      };
      const tick = () => {
        if (signal?.aborted) return done();
        const outcome = runOutcomes.get(runId);
        if (!outcome || Date.now() >= deadline) return done();
        if (outcome.terminal === true) {
          const waited = Date.now() - (outcome.terminalAt ?? 0);
          if (waited >= RUN_SETTLE_GRACE_MS) return done();
          timer = setTimeout(tick, Math.max(1, RUN_SETTLE_GRACE_MS - waited));
          return;
        }
        timer = setTimeout(tick, 100);
      };
      signal?.addEventListener?.("abort", done, { once: true });
      tick();
    });
  }

  function observeFirstUseReplyEvidence(record     ) {
    const candidateKey = firstUseBinding(record);
    if (!candidateKey || !record?.reply?.runId || !record?.sessionKey) {
      return { accepted: false, reason: "attribution_unavailable" };
    }
    const marked = (globalThis       ).process?.env?.OCUCLAW_ALLOW_SIMULATOR_REPLY_EVIDENCE === "1";

    const named = (verdict     ) => {
      if (verdict?.reason !== "reply_run_errored") return verdict;
      if (runOutcomes.get(record.reply.runId)?.code !== "provider_rate_limited") return verdict;
      return { ...verdict, reason: "reply_run_rate_limited" };
    };
    const before = replyDelivery.status(candidateKey);
    if (before?.status === "sdk_accepted" || before?.status === "pending") {
      return named(classifyFirstUseReplyEvidence(before, marked));
    }

    const settled = before && before.reason && before.reason !== "unknown_candidate" ? before : null;
    replyDelivery.observe({ candidateKey, sessionKey: record.sessionKey, runId: record.reply.runId });
    const after = replyDelivery.status(candidateKey);
    if (after?.status === "sdk_accepted") return named(classifyFirstUseReplyEvidence(after, marked));
    return named(classifyFirstUseReplyEvidence(after?.status === "pending" && settled ? settled : after, marked));
  }

  let setupHintPhase      = null;
  function readSetupHintPhase() {

    if (typeof opts.getSetupHintPhase === "function") {
      try { return opts.getSetupHintPhase() === "awaiting-first-reply" ? "awaiting-first-reply" : null; }
      catch (_) { return null; }
    }
    if (!firstUseStore) return null;

    try { return firstUseStore.read()?.status === "awaiting-reply" ? "awaiting-first-reply" : null; }
    catch (_) { return null; }
  }

  const SETUP_TURN_CLOSE_GRACE_MS = 120000;
  let setupHintError      = null;
  let setupTurnWatch      = null;
  let setupTurnError      = null;
  let hermesSetupAttempt = 0;
  function readSetupAttempt(nextPhase     ) {
    if (typeof opts.getSetupHintPhase === "function") {

      if (nextPhase === "awaiting-first-reply" && setupHintPhase !== "awaiting-first-reply") hermesSetupAttempt += 1;
      return hermesSetupAttempt > 0 ? { id: `hermes:${hermesSetupAttempt}`, sessionKey: null } : null;
    }
    if (!firstUseStore) return null;
    try {
      const record = firstUseStore.read();
      return record && record.status !== "completed" && record.attemptId
        ? { id: record.attemptId, sessionKey: record.sessionKey || null }
        : null;
    } catch (_) { return null; }
  }
  function refreshSetupHint() {
    const next = readSetupHintPhase();
    const attempt = readSetupAttempt(next);
    const attemptId = attempt ? attempt.id : null;
    if (next === "awaiting-first-reply" && attemptId) {
      if (!setupTurnWatch || setupTurnWatch.attempt !== attemptId) {
        setupTurnWatch = { attempt: attemptId, sessionKey: attempt?.sessionKey ?? null, closedAt: null, runIds: new Set() };
      } else {
        setupTurnWatch.closedAt = null;
      }
    } else if (setupTurnWatch && setupTurnWatch.closedAt === null) {
      setupTurnWatch.closedAt = Date.now();
    }
    if (setupTurnError && setupTurnError.attempt !== attemptId) setupTurnError = null;
    const nextError = setupTurnError ? { code: setupTurnError.code } : null;
    const errorChanged = (nextError?.code ?? undefined) !== (setupHintError?.code ?? undefined)
      || !!nextError !== !!setupHintError;
    if (next === setupHintPhase && !errorChanged) return false;
    setupHintPhase = next;
    setupHintError = nextError;
    return true;
  }

  function publishSetupHintIfChanged() {
    try { if (refreshSetupHint()) broadcastStatus(); } catch (_) {  }
  }
  function setupTurnSessionMatches(activity     ) {

    if (typeof opts.getSetupHintPhase === "function") return true;
    const frameKey = normalizeAppSessionKeyForCompare(activity && activity.sessionKey);
    const expected = normalizeAppSessionKeyForCompare(setupTurnWatch?.sessionKey);

    return !frameKey || !expected || expected === frameKey;
  }

  function noteSetupTurnRun(activity     , runId     ) {
    try {
      const watch = setupTurnWatch;
      if (!watch || !runId || !setupTurnSessionMatches(activity)) return;
      const outcome = runOutcomes.get(runId);
      if (!watch.runIds.has(runId)) {
        const open = watch.closedAt === null || Date.now() - watch.closedAt <= SETUP_TURN_CLOSE_GRACE_MS;
        if (open) {
          watch.runIds.add(runId);
          while (watch.runIds.size > RUN_OUTCOME_MAX) watch.runIds.delete(watch.runIds.values().next().value);
        }
      }
      let next = setupTurnError;
      if (watch.runIds.has(runId) && outcome?.errored === true) {
        next = { attempt: watch.attempt, code: firstUseProviderErrorClass(outcome.code) };
      } else if (setupTurnError && outcome?.terminal === true && outcome.errored !== true) {

        next = null;
      }
      if (next === setupTurnError) return;
      if (next && setupTurnError && next.attempt === setupTurnError.attempt && next.code === setupTurnError.code) return;
      setupTurnError = next;
      publishSetupHintIfChanged();
    } catch (_) {  }
  }
  refreshSetupHint();

  const observeFirstUse = (method     , ...args       ) => {
    try { firstUseObserver?.[method](...args); } catch (_) {  }

    if (setupHintPhase === "awaiting-first-reply") publishSetupHintIfChanged();
  };
  const logger = normalizeLogger(opts.logger);
  const externalDebugToolsEnabled = opts.externalDebugToolsEnabled !== false;
  const debugAutoArm = typeof opts.debugAutoArm === "boolean"
    ? opts.debugAutoArm
    : externalDebugToolsEnabled;

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

      inputPrediction: opts.inputPrediction,
    });

  const liveuiJevArmConfig = opts.liveuiJev || (opts.config && opts.config.liveuiJev) || {};

  const liveuiV2Config = opts.liveuiV2 || (opts.config && opts.config.liveuiV2) || {};

  const liveUiPictureHost = createLiveUiPictureHost({
    backendKind: () => getActiveBackendKind(),
    request: (method, params) => gatewayBridge.request(method, params),
    pictureFolders: () => (Array.isArray(liveuiV2Config.pictureFolders) ? liveuiV2Config.pictureFolders : null),
  });

  let liveUiVideoRouteInstance                       = opts.liveUiVideoRoute || null;
  const liveUiVideoRoute = ()                => {
    if (!liveUiVideoRouteInstance) {
      liveUiVideoRouteInstance = createDefaultPhoneExitNode({
        hostStateDir: resolveHostStateDir(),
        readTailscaleCliReceipt,
        writeJsonReceiptDurable,
      });
    }
    return liveUiVideoRouteInstance;
  };
  if (opts.liveUiVideoRouteRestore !== false) {
    Promise.resolve()
      .then(() => liveUiVideoRoute().restore())
      .catch((err     ) => logger.warn(`[ocuclaw] LiveUI video route restore failed: ${err && err.message ? err.message : err}`));
  }

  const liveUiV2Session = (sessionKey     ) =>
    typeof sessionService.isLiveUiV2Session === "function" &&
    sessionService.isLiveUiV2Session(sessionKey) === true;

  const hasConnectedLiveUiV2Client = () => {
    try {
      const snap = server && typeof server.getReadinessSnapshot === "function" ? server.getReadinessSnapshot() : null;
      const clients = snap && Array.isArray(snap.clients) ? snap.clients : [];
      return clients.some((entry     ) => parseLiveUiClientCapabilities(entry && entry.clientCapabilities).v2);
    } catch {
      return false;
    }
  };
  const hasConnectedClientCapability = (capability        ) => {
    try {
      const snap = server && typeof server.getReadinessSnapshot === "function" ? server.getReadinessSnapshot() : null;
      const clients = snap && Array.isArray(snap.clients) ? snap.clients : [];
      return clients.some((entry     ) => Array.isArray(entry && entry.clientCapabilities) && entry.clientCapabilities.includes(capability));
    } catch {
      return false;
    }
  };

  const jevConnection = createArmedJevConnection(
    {
      liveuiJev: liveuiJevArmConfig,
      botScreenJev: opts.botScreenJev,
      programCardsJev: opts.programCardsJev,
    },
    {
      emit: (payload     ) => {
        emitDebug("glasses.lifecycle", "glasses_ui_jev_warm", "debug", {}, () => payload);
      },
    },

    opts.jevConnectionFactory,
  );

  function noteJevActivity(trigger     , activityOptions      = undefined) {
    if (!jevConnection) return;
    try {
      jevConnection.noteActivity(trigger, activityOptions);
    } catch {

    }
  }

  function warmJevOnce(trigger     ) {
    if (!jevConnection) return;
    try {
      jevConnection.warm(trigger);
    } catch {

    }
  }

  const jevCheckFile = typeof opts.stateDir === "string" && opts.stateDir ? path.join(opts.stateDir, JEV_CHECK_FILE) : null;

  if (jevCheckFile) clearJevCheckRecord(fs, jevCheckFile);
  const loadedTypesafeKey = () => {
    for (const value of [liveuiJevArmConfig.apiKey, opts.typesafeApiKey, opts.programCardsJev?.apiKey, opts.botScreenJev?.apiKey]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const jevKeyCheck = createJevKeyCheck({
    loadedKey: loadedTypesafeKey,

    readSnapshot: async (connectionId        ) => {
      const request = { requestId: `jev-check-${Date.now().toString(36)}`, operation: "status" };
      const result      = getActiveBackendKind() === "hermes"
        ? await gatewayBridge.request("optional.setup", { request, context: { connectionId } })
        : typeof opts.optionalSetup?.handle === "function" ? await opts.optionalSetup.handle(request, { connectionId }) : null;
      return result && result.status === "ok" && result.snapshot ? result.snapshot : null;
    },
    createClient: typeof opts.jevClientFactory === "function" ? opts.jevClientFactory : createJevClient,
    ...(typeof opts.jevCheckFetch === "function" ? { fetchImpl: opts.jevCheckFetch } : {}),
    connection: jevConnection,
    emit: (row     ) => {
      emitDebug("glasses.lifecycle", "jev_key_check", "info", {}, () => ({
        outcome: row.result, ms: row.ms, jevReason: row.reason || null, httpStatus: row.httpStatus ?? null,
      }));
    },
    record: (row     ) => {
      if (!jevCheckFile) return;
      try {
        writeJevCheckRecord(fs, jevCheckFile, row.result, Date.now());
      } catch (err     ) {
        logger.warn(`[ocuclaw] Jev check record not written: ${err && err.code ? err.code : "error"}`);
      }
    },
  });

  const inputPredictionService = createInputPredictionService({
    gatewayBridge,
    now: opts.now,
    logger,
    timeoutMs: opts.inputPredictionTimeoutMs,
    emitDebug: (category     , event     , data     ) => {
      try {
        emitDebug(category, event, "debug", {}, () => data);
      } catch {

      }
    },

    resolveIdentity: (clientId     ) => {
      const backendKind = gatewayBridge && gatewayBridge.kind ? gatewayBridge.kind : "openclaw";
      const connectionId = `${backendKind}:${opts.gatewayUrl || "local"}`;
      if (typeof opts.inputPredictionAgentId === "function") {
        return { connectionId, agentId: opts.inputPredictionAgentId(clientId) };
      }
      const identity = resolveInputPredictionIdentity({
        backendKind,
        clientSessionKey:
          server && typeof (server       ).getClientSessionKey === "function"
            ? (server       ).getClientSessionKey(clientId)
            : null,
        getSessionAgentId: (shortKey     , fullKey     ) => sessionService.getSessionAgentId(shortKey, fullKey),
        getSessionProfileId:
          typeof (sessionService       ).getSessionProfileId === "function"
            ? (shortKey     , fullKey     ) => (sessionService       ).getSessionProfileId(shortKey, fullKey)
            : undefined,
        extractShortKey:
          typeof (sessionService       ).extractShortKey === "function"
            ? (key     ) => (sessionService       ).extractShortKey(key)
            : undefined,
      });
      return {
        connectionId,
        agentId: identity.agentId,
        profileId: identity.profileId,
        sessionKey: identity.sessionKey,
        unroutable: (identity       ).unroutable === true,
      };
    },
  });

  if (gatewayBridge && isKnownBackendKind(gatewayBridge.kind)) {
    setActiveBackendKind(gatewayBridge.kind);
  }
  const relayBackendKind =
    gatewayBridge && isKnownBackendKind(gatewayBridge.kind)
      ? gatewayBridge.kind
      : "openclaw";

  const cardBeforeSave = new Map             ();

  const programCardSaves = createProgramCardSaves({
    libraryDir: resolveLiveuiExecutorRegistryRoot({
      libraryDir: opts.liveuiLibraryDir,
      templateLibraryDir: opts.templateLibraryDir,
    }),
    now: opts.now,
    onSaved: (saved     ) => {
      cardBeforeSave.delete(saved.appId);
      cardBeforeSave.set(saved.appId, saved);
      while (cardBeforeSave.size > 256) cardBeforeSave.delete(cardBeforeSave.keys().next().value          );
    },

    taskSlotsCap: () => programCardTaskSlotsCap(),

    kitLevel: () => programCardKitLevel(),

    keepRevisions: (appId        ) => (programCardFeed?.store?.list?.() || [])
      .filter((binding     ) => binding?.schemaVersion === 2 && binding.cardId === appId)
      .flatMap((binding     ) => [binding.revision, binding.fixed?.revision,
        ...(binding.fixed?.others || []).map((other     ) => other.revision)]),
  });

  const programCardSlots = createProgramCardSlots({ libraryDir: programCardSaves.libraryDir, now: opts.now });
  const programCardSlotHandlers = createProgramCardSlotHandlers({
    saves: programCardSaves,
    slots: programCardSlots,
    canAccess: (clientId        , appId        ) => privateCardAccess(clientId, appId),
  });
  function programCardTaskSlotsCap() { return taskSlotsCap(opts.programCardTaskSlotsCap); }

  function programCardUndoRevisions(appId        )           {
    return (programCardFeed?.store?.list?.() || [])
      .filter((binding     ) => binding?.schemaVersion === 2 && binding.cardId === appId && taskFixDoneOpen(binding.fixed, Date.now()))
      .flatMap((binding     ) => [binding.fixed.revision, ...(binding.fixed.others || []).map((other     ) => other.revision)]);
  }

  function clientHasTaskSlots(clientId        ) {
    const client = (server?.getReadinessSnapshot()?.clients || []).find((entry     ) => entry?.clientId === clientId);
    return Array.isArray(client?.clientCapabilities) && client.clientCapabilities.includes(PROGRAM_CARD_TASK_SLOTS_CAPABILITY);
  }

  function clientHasTaskFix(clientId        ) {
    const client = (server?.getReadinessSnapshot()?.clients || []).find((entry     ) => entry?.clientId === clientId);
    return Array.isArray(client?.clientCapabilities) && client.clientCapabilities.includes(TASK_FIX_CAPABILITY);
  }

  function clientKitLevel(clientId     ) {
    try {
      const client = (server?.getReadinessSnapshot()?.clients || []).find((entry     ) => entry?.clientId === clientId);
      return programCardKitLevelOf(client?.clientCapabilities);
    } catch {
      return null;
    }
  }

  function programCardKitLevel() {
    try {
      const clients = server?.getReadinessSnapshot()?.clients || [];
      let lowest                = null;
      for (const entry of clients) {
        if (!Array.isArray(entry?.clientCapabilities) || !entry.clientCapabilities.includes(PROGRAM_CARD_CAPABILITY)) continue;
        const level = programCardKitLevelOf(entry.clientCapabilities);
        if (level !== null && (lowest === null || level < lowest)) lowest = level;
      }
      return lowest;
    } catch {
      return null;
    }
  }

  function sessionHasCardStudio(sessionKey     ) {
    const want = normalizeAppSessionKeyForCompare(sessionKey);
    if (!want || !server) return false;
    try {
      const clients = server.getReadinessSnapshot()?.clients || [];
      return clients.some((entry     ) => Array.isArray(entry?.clientCapabilities)
        && entry.clientCapabilities.includes(CARD_STUDIO_CAPABILITY)
        && normalizeAppSessionKeyForCompare(server?.getClientSessionKey?.(entry.clientId)) === want);
    } catch {
      return false;
    }
  }

  function cardReviewRetryOwner(clientId     ) {
    if (!server?.getAppClientIds?.().includes(clientId)) return null;
    const sessionKey = server?.getClientSessionKey?.(clientId);

    if (!sessionKey) return { clientId, sessionKey: null, profileId: null, defaultSelection: true };
    if (relayBackendKind !== "hermes") return { clientId, sessionKey, profileId: null };
    const identity = resolveInputPredictionIdentity({
      backendKind: "hermes", clientSessionKey: sessionKey,
      getSessionAgentId: (short     , full     ) => sessionService.getSessionAgentId(short, full),
      getSessionProfileId: (short     , full     ) => (sessionService       ).getSessionProfileId?.(short, full),
      extractShortKey: (key     ) => (sessionService       ).extractShortKey?.(key) || key,
    });
    return identity.profileId && !(identity       ).unroutable
      ? { clientId, sessionKey, profileId: identity.profileId } : null;
  }
  const programCardReviewer = createProgramCardReviewer({
    saves: programCardSaves,
    isRetryOwnerCurrent: (owner     ) => {
      const current = cardReviewRetryOwner(owner.clientId);
      return !!current && current.sessionKey === owner.sessionKey && current.profileId === owner.profileId &&
        current.defaultSelection === owner.defaultSelection;
    },
    host: relayBackendKind === "hermes" ? "hermes" : "openclaw",

    canPlayLook: () => (server?.getReadinessSnapshot?.()?.clients || []).some((client     ) =>
      Array.isArray(client?.clientCapabilities) && client.clientCapabilities.includes(PROGRAM_CARD_LOOK_PLAY_CAPABILITY)),
    imageModelFor: relayBackendKind === "hermes" ? undefined : opts.inputPrediction?.reviewImageModel,
    modelPrice: relayBackendKind === "hermes" ? undefined : opts.inputPrediction?.reviewModelPrice,

    visionCanary: true,
    visionHostVersion: () => [
      relayBackendKind === "hermes" ? `hermes ${hermesVersion || "unknown"}` : `openclaw ${pluginVersionService.getOpenClawHostVersion() || "unknown"}`,
      `ocuclaw ${pluginVersionService.getPluginVersion() || "unknown"}`,
    ].join(" "),
    llmComplete:
      gatewayBridge && gatewayBridge.kind === "hermes"
        ? (params     ) => gatewayBridge.request("program_card.review.llm.complete", params)
        : opts.inputPrediction && opts.inputPrediction.llmComplete,
    onChange: (appId     , view     ) => {
      if (!server) return;
      const frame = handler.formatProgramCardReview(view);
      const ownerScope = appId ? programCardFeed?.store.ownerScope(appId) : null;
      if (!ownerScope) return server.broadcast(frame);
      for (const client of server.getReadinessSnapshot()?.clients || [])
        if (taskPresentationClientOwns(client.clientId, { ownerScope })) server.unicast(client.clientId, frame);
    },

    onRevisionSeen: (appId     ) => broadcastCardRevisions(appId),

    onTrace: ({ event, appId, ...data }     ) => noteCardReviewEvent(appId, `card_${event}`, data),
    logger,
    now: opts.now,
  });
  const taskResultProposals = createTaskResultProposals({
    logger,
    complete: gatewayBridge && gatewayBridge.kind === "hermes"
      ? (params     ) => gatewayBridge.request("task.proposal.llm.complete", params)
      : opts.inputPrediction && opts.inputPrediction.llmComplete,
    keep: (clientId        , candidate     ) => {
      if (!taskPresentations) throw new Error("presentation_unavailable");
      return taskPresentations.keep(clientId, candidate);
    },

    guidesFor: (clientId        ) => {
      const client = server?.getReadinessSnapshot()?.clients?.find((entry     ) => entry.clientId === clientId);
      const has = (capability        ) => client?.clientCapabilities?.includes(capability) === true;

      return [has(PROGRAM_CARD_TASK_RUN_CAPABILITY) ? PROGRAM_CARD_TASK_RUN_GUIDE : "",
        has(PROGRAM_CARD_TASK_UNCHECKED_CAPABILITY) ? PROGRAM_CARD_TASK_UNCHECKED_GUIDE : ""].filter(Boolean).join("\n");
    },
  });

  const agentDrafts = createAgentDrafts({
    logger,
    complete: gatewayBridge && gatewayBridge.kind === "hermes"
      ? (params     ) => gatewayBridge.request("agent.draft.llm.complete", params)
      : opts.inputPrediction && opts.inputPrediction.llmComplete,
  });

  const taskFromWords = createTaskFromWords({
    logger,
    complete: gatewayBridge && gatewayBridge.kind === "hermes"
      ? (params     ) => gatewayBridge.request("task.proposal.llm.complete", params)
      : opts.inputPrediction && opts.inputPrediction.llmComplete,
  });
  const liveuiExecutorRegistry = opts.liveuiExecutorRegistry || createLiveuiExecutorRegistry({
    libraryDir: opts.liveuiLibraryDir,
    templateLibraryDir: opts.templateLibraryDir,
    heartbeatMs: opts.liveuiExecutorHeartbeatMs,
    now: opts.now,
  });
  let liveuiAgents      = [];
  let liveuiExecutorRegistryStarted = false;
  let liveuiGlassesLibraryController = opts.liveuiGlassesLibraryController || null;
  let liveuiTaskRunController      = null;

  const taskCardRuns = createTaskCardRuns();
  let programCardFeed      = null;

  let taskOpenUpdate      = null;

  let cardPartRuns      = null;

  let cardPartLink      = null;

  let taskRunsWeek      = null;

  const programCardBindingsSnapshot = (clientId        ) => {
    const parts = clientHasTaskSlots(clientId);
    return formatProgramCardBindings(
      programCardFeed.store.list().filter((binding     ) => (binding.schemaVersion !== 2 ||
        taskPresentationClientOwns(clientId, binding)) && (parts || bindingSlot(binding) === TASK_SLOT_FIRST)),
      programCardFeed.store.listProposals(),

      (binding     ) => programCardFeed.bindingState(binding),
      (binding     ) => (taskOpenUpdate ? taskOpenUpdate.projection(binding) : null),

      programCardSnapshotCards(clientId, parts),

      (binding     ) => taskRunsWeekFor(binding.taskId),

      clientHasTaskFix(clientId) ? (binding     ) => programCardFeed.fixOffer(binding, { parts }) : null,

      clientHasTaskFix(clientId) ? (binding     ) => taskFixPhoneState(binding, clientId) : null,
    );
  };

  function programCardSnapshotCards(clientId        , parts         ) {
    const canSee = (appId        ) => privateCardAccess(clientId, appId);
    const byId = new Map             ();
    for (const entry of programCardAgentRefresh.cards(canSee)) byId.set(entry.cardId, { ...entry });
    const cap = programCardTaskSlotsCap();
    for (const cardId of programCardFeed.store.ownedCards()) {
      if (!canSee(cardId)) continue;
      const scope = programCardFeed.store.ownerScope(cardId);
      if (!scope || scope === "unavailable" || !taskPresentationClientOwns(clientId, { ownerScope: scope })) continue;
      const card = programCardSaves.source({ appId: cardId });
      if (card.status !== "accepted") continue;
      const bound = programCardFeed.store.forCard(cardId).filter((binding     ) => binding.schemaVersion === 2);
      const declared = cardTaskSlots(card, bound.find((binding     ) => bindingSlot(binding) === TASK_SLOT_FIRST)?.inputs || null) || [];
      const slots = declared.filter((slot     ) => parts || slot.name === TASK_SLOT_FIRST).map((slot     ) => {
        const filled = bound.find((binding     ) => bindingSlot(binding) === slot.name);

        return { name: slot.name, label: slot.label, ...(filled ? { taskId: filled.taskId } : {}),
          ...(filled && taskCheckAgain.allowed(filled.taskId) ? { checkAgain: true } : {}) };
      });
      if (!slots.length) continue;
      byId.set(cardId, { ...(byId.get(cardId) || { cardId }), revision: card.revision, slots,
        addable: parts && declared.length < cap });
    }
    return [...byId.values()];
  }
  function pushProgramCardBindings() {
    for (const client of server?.getReadinessSnapshot()?.clients || [])
      server.unicast(client.clientId, programCardBindingsSnapshot(client.clientId));
  }

  function pushBindingsIfTaskCard(appId         ) {
    if (typeof appId !== "string" || !appId || !programCardFeed) return;
    if (programCardFeed.store.forCard(appId).length) pushProgramCardBindings();
  }

  const cardsFollowOwnChanges = opts.cardsFollowOwnChanges !== undefined ? opts.cardsFollowOwnChanges !== false
    : programCardFollowsOwnChanges();

  function followCardRevision(appId         , why        ) {
    if (typeof appId !== "string" || !appId || !programCardFeed) return;
    if (!programCardFeed.store.forCard(appId).length) return;
    const source      = cardsFollowOwnChanges ? programCardSaves.source({ appId }) : null;
    if (source?.status !== "accepted") return pushProgramCardBindings();

    const last = cardBeforeSave.get(appId);
    cardBeforeSave.delete(appId);
    const before = last && last.revision === source.revision && last.sourceHash === source.sourceHash ? last.previous : null;
    const moved = followCardParts(programCardFeed.store, appId, source.revision, source.sourceHash, cardTaskSlots(source, null), before);
    if (moved.stopped.length)
      logger.warn(`[program-card] card save stops tasks card=${appId} revision=${source.revision} why=${why} tasks=${moved.stopped.join(",")}`);
    if (moved.followed.length)
      logger.info(`[program-card] card save kept tasks card=${appId} revision=${source.revision} why=${why} tasks=${moved.followed.join(",")}`);
    pushProgramCardBindings();

    void reconcileRepinned(moved.followed);
  }

  let liveuiGrantsPushController      = null;
  let liveuiTasksPushController      = null;
  let unsubscribeLiveuiTasksPush      = null;
  function attachLiveuiTasksPush(controller     ) {
    if (controller === liveuiTasksPushController) return;
    unsubscribeLiveuiTasksPush?.();
    unsubscribeLiveuiTasksPush = null;
    liveuiTasksPushController = controller;
    if (typeof controller?.onLiveuiTasksChanged !== "function") return;
    unsubscribeLiveuiTasksPush = controller.onLiveuiTasksChanged(() => {

      if (controller !== liveuiTasksPushController) return;
      broadcastLiveuiTasksSnapshot(controller);
    });
  }
  function attachLiveuiGrantsPush(controller     ) {
    if (!controller || controller === liveuiGrantsPushController) return;
    if (typeof controller.onLiveuiGrantsChanged !== "function") return;
    liveuiGrantsPushController = controller;
    controller.onLiveuiGrantsChanged(() => {
      try {
        if (typeof controller.liveuiGrantsSnapshot !== "function") return;
        server.broadcast(handler.formatLiveuiGrantsSnapshot(controller.liveuiGrantsSnapshot() || {}));
      } catch (err     ) {
        logger.warn(
          `[liveui] grants snapshot broadcast failed: ${err && err.message ? err.message : err}`,
        );
      }
    });
  }
  function resolveLiveuiGlassesLibraryController() {
    const controller = liveuiGlassesLibraryController || getRegisteredLiveuiGlassesLibraryController(
      globalThis,
      {
        taskRunController: liveuiTaskRunController,
        resolveExecutorState: resolveLiveuiTaskExecutorState,
      },
    );
    attachLiveuiGrantsPush(controller);
    attachLiveuiTasksPush(controller);
    return controller;
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

  function getActivityLabs(frame      ) {
    const runId = frame && typeof frame.runId === "string" ? frame.runId : null;
    return resolveActivityLabs(
      Reflect.get(ocuClawSettingsStore.getSnapshot(), "activityLabs"),
      Reflect.get(globalThis, "process")?.env?.OCUCLAW_ACTIVITY_LABS,
      relayBackendKind,
      runId ? openClawRunProviders.get(runId) : undefined,
    );
  }

  const openClawRunProviders = new Map                ();
  const OPENCLAW_RUN_PROVIDERS_MAX = 64;
  const activityStatusAdapter = createActivityStatusAdapter({
    ...(opts.activityStatusAdapter || {}),
    labs: getActivityLabs,
  });
  const agentTurnChangedChannel = createEventChannel(logger, "agent_turn_changed");
  function dispatchAgentTurnChanged(sessionKey     , busy     ) {
    agentTurnChangedChannel.emit(() => ({ sessionKey, busy }));
  }

  const agentTurnTracker = createAgentTurnTracker({ onChange: dispatchAgentTurnChanged });

  const relayKeyOf = (sessionKey        ) => relaySessionKeyFor(sessionKey) || sessionKey;
  const cardBuildTurns = createCardBuildTurns({
    enabled: () => normalizeOcuClawCardBuildFastMode(
      Reflect.get(ocuClawSettingsStore.getSnapshot(), "cardBuildFastMode")) === true,
    sessionConfig: (sessionKey) => sessionService.getSessionModelConfig(relayKeyOf(sessionKey)),
    setFastMode: (sessionKey, on) => sessionService.setSessionModelConfig(relayKeyOf(sessionKey), { fastMode: on }),
    dispatch: (params) => {
      const sessionKey = relayKeyOf(params.sessionKey);
      const channelPrompt = getActiveBackendKind() === "hermes"
        ? stablePromptSnapshots.peek(sessionKey, sessionKey)
        : "";
      return dispatchAgentWake({ ...params, sessionKey, ...(channelPrompt ? { channelPrompt } : {}) });
    },
    yesUnspent: (sessionKey) => cardAskApproved(sessionKey),
    slot: relayKeyOf,
    isBusy: (sessionKey) => agentTurnTracker.isBusy(sessionKey),
    released: (buildKey) => broadcastCardBuild(cardBuildPhases.release({ sessionKey: buildKey }), "buildTurnReleased"),
    log: (event, fields) => emitDebug("relay.protocol", event, "info", {}, () => fields),
  });
  agentTurnChangedChannel.on((event     ) => cardBuildTurns.onTurnChanged(event));

  const backendPrewarm = createBackendPrewarm({
    request: (method     , params     ) => gatewayBridge.request(method, params),
    getBackendKind: () => getActiveBackendKind(),
    resolveSessionKey: (requested     ) => requested || sessionService.peekSessionKey() || null,
    scopeSessionKey: (sessionKey     ) =>
      scopeOpenClawSessionKey(sessionKey, stableSendOptions(sessionKey, null)),
    isTurnActive: (sessionKey     ) => agentTurnTracker.isBusy(sessionKey),
    onOutcome: (outcome     ) => {
      emitDebug("relay.protocol", "backend_prewarm", "debug", { sessionKey: outcome.sessionKey }, () => outcome);
    },
  });
  const sharedHttpServer = opts.httpServer || null;

  let cachedPages = null;
  let pagesSourceRevision                = null;
  let pagesSourceSession                = null;
  let pagesSourceRunId                = null;

  let pagesRevision = 0;

  let cachedEntries = "";
  let entriesRevision = 0;
  let entriesLastSeq = -1;

  let entriesCount = 0;

  let entriesSessionId      = null;

  let cachedStatus = null;

  let statusRevision = 0;

  const optionalSetupGeneration = crypto.randomUUID();

  const modelSitesGeneration = crypto.randomUUID();
  const modelSitesConnections = new Map                ();
  const modelSites = opts.modelSites || (typeof opts.stateDir === "string" && path.isAbsolute(opts.stateDir)
    ? createModelSitesService({
      stateDir: opts.stateDir,
      httpEnabled: () => {
        const cfg      = typeof opts.getGlassesUiLiveConfig === "function" ? opts.getGlassesUiLiveConfig() || {} : {};
        return cfg.httpEnabled !== false;
      },
      hostCheck: () => {
        const controller = resolveLiveuiGlassesLibraryController();
        return controller && typeof controller.liveuiHostCheck === "function" ? controller.liveuiHostCheck() : null;
      },
      networkReach: () => {
        const cfg      = typeof opts.getGlassesUiLiveConfig === "function" ? opts.getGlassesUiLiveConfig() || {} : {};
        return (cfg.httpHostPolicy === undefined ? "owner-grants" : cfg.httpHostPolicy) === "owner-grants" ? "wearer" : "hosts";
      },
    }) : null);

  const liveUiSessionGenerationBootId =
    typeof opts.liveUiSessionGenerationBootId === "string" &&
    opts.liveUiSessionGenerationBootId.trim()
      ? opts.liveUiSessionGenerationBootId.trim()
      : crypto.randomUUID();
  let liveUiSessionGenerationSeq = 0;
  const liveUiSessionGenerations = new Map();

  const userSendDedupe = new Map();
  const USER_SEND_DEDUPE_MAX = 512;
  const USER_SEND_DEDUPE_TTL_MS = 5 * 60_000;

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
  const clientEventFoldCache = createClientEventFoldCache({ now: () => Date.now() });
  let bundleCacheSweepTimer = null;

  let taskRunsWatchTimer      = null;

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

              data:
                cat === "openclaw.message" && data && typeof data === "object"
                  ? redactDiagnosticData(data                           , "off")
                  : data,
            }),
        );
      } catch {

      }
    }
  }

  function isForcedLiveuiFailureEvent(payload     ) {
    return !!(
      payload &&
      (payload.event === "liveui_render_failed" ||
        payload.event === "liveui_render_unparsed")
    );
  }

  function resetActivityStatusAdapter() {
    activityStatusAdapter.reset();
  }

  const voiceCredentials = createVoiceCredentials({
    opts,
    logger,
    emitDebug,
    sessionService: { peekSessionKey: () => sessionService.peekSessionKey() },
  });

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

  const savedPromptsStore = createSavedPromptsStore({
    logger,
    emitDebug,
    stateDir: opts.stateDir,
  });
  const setOcuClawLocalSettings =
    typeof opts.setOcuClawSettings === "function"
      ? opts.setOcuClawSettings
      : (patch = {}) => ocuClawSettingsStore.setSettings(patch);

  let pushedExplainApprovals                 = null;
  function pushApprovalExplainSetting(force = false) {
    if (!gatewayBridge || gatewayBridge.kind !== "hermes") return;
    const enabled = ocuClawSettingsStore.getSnapshot().explainApprovals !== false;
    if (!force && pushedExplainApprovals === enabled) return;
    pushedExplainApprovals = enabled;
    Promise.resolve()
      .then(() => gatewayBridge.request("approval.explain.setting", { enabled }))
      .catch((err     ) => {
        if (err && err.code === -32601) return;

        pushedExplainApprovals = null;
        logger.debug?.(
          `[relay] approval.explain.setting push failed: ${err && err.message ? err.message : err}`,
        );
      });
  }

  let pushedWaitingOnYouKey                = null;
  let waitingSettingsMethodMissing = false;
  let waitingOnYouSupported = false;
  let waitingOnYouSurfaces           = [];
  function applyWaitingSettingsReply(supported         , surfaces          ) {
    if (
      supported === waitingOnYouSupported &&
      surfaces.length === waitingOnYouSurfaces.length &&
      surfaces.every((name, index) => name === waitingOnYouSurfaces[index])
    ) {
      return;
    }
    waitingOnYouSupported = supported;
    waitingOnYouSurfaces = surfaces;
    if (!server || !handler) return;
    getOcuClawSettingsSnapshot()
      .then((settings) => server.broadcast(handler.formatOcuClawSettings(settings)))
      .catch((err     ) => {
        logger.debug?.(
          `[relay] waiting settings snapshot broadcast failed: ${err && err.message ? err.message : err}`,
        );
      });
  }
  function pushWaitingSettings(force = false) {
    if (gatewayBridge && gatewayBridge.kind === "openclaw") {
      applyOpenClawWaitingSettings(force);
      return;
    }
    if (!gatewayBridge || gatewayBridge.kind !== "hermes") return;
    if (waitingSettingsMethodMissing) return;
    const stored = ocuClawSettingsStore.getSnapshot().waitingOnYou;
    const params = {
      show: stored.show,
      answer: stored.answer,
      surfaces: { ...stored.surfaces },
    };
    const key = JSON.stringify(params);
    if (!force && pushedWaitingOnYouKey === key) return;
    pushedWaitingOnYouKey = key;
    Promise.resolve()
      .then(() => gatewayBridge.request("waiting.settings", params))
      .then((reply     ) => {
        applyWaitingSettingsReply(
          !!(reply && reply.supported === true),
          sanitizeOcuClawWaitingAvailableSurfaces(reply && reply.availableSurfaces),
        );
      })
      .catch((err     ) => {
        if (err && err.code === -32601) {
          waitingSettingsMethodMissing = true;
          applyWaitingSettingsReply(false, []);
          return;
        }
        if (pushedWaitingOnYouKey === key) pushedWaitingOnYouKey = null;
        logger.debug?.(
          `[relay] waiting.settings push failed: ${err && err.message ? err.message : err}`,
        );
      });
  }

  let openClawWaitingSettingsKey                = null;
  function applyOpenClawWaitingSettings(force         ) {
    if (!openClawWaiting) return;
    const key = JSON.stringify(ocuClawSettingsStore.getSnapshot().waitingOnYou);
    if (!force && openClawWaitingSettingsKey === key) return;
    openClawWaitingSettingsKey = key;
    openClawWaiting.settingsChanged();
    Promise.resolve()
      .then(() => gatewayBridge.request("channels.status", { probe: false }))
      .then((status     ) => applyWaitingSettingsReply(true, openClawChannelSurfaces(status)))
      .catch((err     ) => {
        applyWaitingSettingsReply(true, waitingOnYouSurfaces);
        logger.debug?.(
          `[relay] waiting surfaces read failed: ${err && err.message ? err.message : err}`,
        );
      });
  }
  function openClawChannelSurfaces(status     ) {
    const accounts = status && typeof status.channelAccounts === "object" && status.channelAccounts
      ? status.channelAccounts
      : {};
    const order = Array.isArray(status && status.channelOrder) ? status.channelOrder : Object.keys(accounts);
    const ids = [...new Set([...order, ...Object.keys(accounts)])].filter((id     ) => {
      const rows = Array.isArray(accounts[id]) ? accounts[id] : [];
      return rows.some((row     ) => row && (row.configured === true || row.running === true));
    });
    return sanitizeOcuClawWaitingAvailableSurfaces(ids)
      .filter((name        ) => !OPENCLAW_WAITING_LOCAL_SURFACES.includes(name));
  }

  async function getOcuClawSettingsSnapshot() {
    const local = {
      ...ocuClawSettingsStore.getSnapshot(),

      activityLabs: getActivityLabs(),
      waitingOnYouSupported,
      waitingOnYouSurfaces: waitingOnYouSurfaces.slice(),

      ...(openClawWaiting ? { waitingOnYouLocalSurfaces: OPENCLAW_WAITING_LOCAL_SURFACES.slice() } : {}),
    };
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

      ...(profile && typeof profile.liveReasoning === "string"
        ? { liveReasoning: profile.liveReasoning }
        : {}),
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

  function rebroadcastAgentsCatalog() {
    if (!upstreamRuntime) return;
    Promise.resolve(upstreamRuntime.getAgentsCatalogSnapshot())
      .then((fresh     ) => broadcastAgentsCatalog(fresh))
      .catch(() => {});
  }

  const hermesEnrollment = createHermesEnrollment({
    gatewayBridge,
    emitDebug,
    rebroadcastAgentsCatalog,
  });

  async function hermesManagementRequest(input     ) {

    if (getActiveBackendKind() === "openclaw") {
      const reply      = await openClawManagement.handle(input);

      if (SKILL_LIST_WRITES.has(input?.operation) && reply?.status !== "unsupported") {
        upstreamRuntime?.invalidateSkillsCatalog?.(`management_${input.operation}`);
      }
      return reply;
    }

    if (getActiveBackendKind() !== "hermes" || MODELS_OPERATIONS.has(input?.operation)) {
      const error      = new Error("Hermes management is unavailable on this backend.");
      error.code = "capability_unavailable";
      throw error;
    }
    const result      = await gatewayBridge.request("hermes.management", input);
    if (result && hermesEnrollment.noteView(result.agents)) rebroadcastAgentsCatalog();
    return result;
  }

  function createHermesProfile(input     ) {
    if (getActiveBackendKind() !== "hermes") {
      const error      = new Error("Hermes profile creation is not available on this backend.");
      error.code = "capability_unavailable";
      throw error;
    }
    return Promise.resolve(gatewayBridge.request("profiles.create", input)).then(async (result     ) => {

      if (result && (result.status === "created" || result.status === "partial")) {

        await hermesEnrollment.reread("profile_create");
        try {
          await upstreamRuntime?.refreshAgentsCatalog?.(true);
        } catch (error     ) {
          logger.warn(`[relay] Hermes profile created but catalog refresh failed: ${error?.message || error}`);
        }
      }
      return result;
    });
  }

  const mintAgentRefs = createMintAgentRefs({
    ocuClawSettingsStore,
    evenAiSettingsStore,
    logger,
    emitDebug,
    hermesEnrollment,
  });

  const stablePromptSnapshots = createStablePromptSnapshotStore({
    stateDir: opts.stateDir,
    emitDebug,

    isRetired: (prompt        ) => prompt.includes(RETIRED_V1_CHANNEL_ONE_MARKER),
  });

  const promptTurnOwnership = createPromptTurnOwnership();

  let stablePromptSweepTimer = null;

  let uploadCaptureArmingDisposer      = null;
  let refreshUploadCaptureArming      = null;

  function computeStableChannelOne(startSignals) {
    const baseReadability = composeReadabilitySystemPrompt(
      ocuClawSettingsStore.getSnapshot().systemPrompt,
      { hostProvidesReadability: relayBackendKind === "hermes" },
    );
    const display = composeGlassesDisplaySystemPrompt({
      emoji: startSignals.emoji,
      pace: startSignals.pace,
      beat: startSignals.beat,
      speck: startSignals.speck,
    });

    const glassesPointer = composeGlassesUiChannelOne(undefined, hasConnectedClientCapability(CODE_PLATE_CAPABILITY));
    const parts = [];
    if (baseReadability) parts.push(baseReadability);
    if (display) parts.push(display);
    if (glassesPointer) parts.push(glassesPointer);
    parts.push(LIVEUI_MODEL_ROUTING_GUIDANCE);
    parts.push(LIVEUI_TASK_DISCOVERY_CHANNEL_ONE);

    parts.push(composeQuestionLikelyAnswersChannelOne(relayBackendKind === "hermes" ? "hermes" : "openclaw"));

    const labs = getActivityLabs();
    if (labs.includes("narrate")) {
      const notesInConversation = normalizeOcuClawAgentProgressNotes(
        Reflect.get(ocuClawSettingsStore.getSnapshot(), "agentProgressNotes"),
      ) === "conversation";
      parts.push(activityNarrateGuidance(labs, notesInConversation));
    }
    return parts.join("\n\n");
  }

  function stableSendOptions(resolvedSessionKey, content) {
    const options = {
      prompt: {
        content,
        owner: "ocuclaw",
        lane: "logical-session-frozen",
      },
    };

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

  function openclawGatewayKeyFor(sessionKey     ) {
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

  function dispatchAgentWake(params     ) {
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
    const channelPrompt =
      params && typeof params.channelPrompt === "string" ? params.channelPrompt : "";
    agentTurnTracker.markBusy(sessionKey);
    emitDebug(
      "relay.protocol",
      "glasses_wake_dispatch",
      "info",
      { sessionKey },
      () => ({
        idempotencyKey,
        messageChars: message.length,
        channelPromptChars: channelPrompt.length,
        deliver: params?.deliver === true,
      }),
    );
    const gatewaySession = openclawGatewayKeyFor(sessionKey);
    const requestParams = {
      message,
      sessionKey: gatewaySession.key,
      ...(gatewaySession.agentId ? { agentId: gatewaySession.agentId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(channelPrompt
        ? { extraSystemPrompt: channelPrompt, promptOwner: "ocuclaw", promptLane: "logical-session-frozen" }
        : {}),
      ...(params?.deliver === true ? { deliver: true } : {}),
      ...(params?.bestEffortDeliver === true ? { bestEffortDeliver: true } : {}),
    };
    return gatewayBridge.request("agent", requestParams, { expectFinal: false });
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

  const sessionModelConfig = createRelaySessionModelConfig({
    logger,
    ocuClawSettingsStore,
    get sessionService() { return sessionService; },
    get upstreamRuntime() { return upstreamRuntime; },
    get server() { return server; },
    get handler() { return handler; },
  });
  const {
    applyCurrentSessionModelConfigSnapshot,
    clearCurrentSessionModelConfigSnapshot,
    adoptActiveSessionModelConfig,
    maybeSeedOcuClawSessionConfig,
    applyNewChatReasoningDefault,
    seedOcuClawSessionConfigForNewSession,
  } = sessionModelConfig;

  const sessionService = createSessionService({
    logger,
    gatewayBridge,
    getOcuClawProfileOptions: opts.getOcuClawProfileOptions,
    conversationState,
    emitDebug,
    greetingHoldDeadlineMs: opts.greetingHoldDeadlineMs,
    stateDir: opts.stateDir,
    sessionLimit: opts.sessionLimit,

    defaultSessionKeyPrefix: opts.defaultSessionKeyPrefix,
    supportedSessionKeyPrefixes: opts.supportedSessionKeyPrefixes,
    sessionKeyPrefixForAgentRef: opts.sessionKeyPrefixForAgentRef,
    getDefaultSessionAgentRef: mintAgentRefs.getDefaultSessionAgentRef,

    sessionReadStateSupported: () =>

      parseHermesFeatureTokens(process.env.OCUCLAW_HERMES_FEATURES).includes(
        "session_read_state",
      ),
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
    getAgentPrimaryModel(agentId) {
      return upstreamRuntime &&
        typeof upstreamRuntime.getAgentPrimaryModel === "function"
        ? upstreamRuntime.getAgentPrimaryModel(agentId)
        : null;
    },
    getDefaultAgentId() {
      if (getActiveBackendKind() === "hermes") {
        return "";
      }
      return ocuClawDefaultAgentAsAgentId(
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

    broadcastActivity: (activity     , activitySource     ) =>
      broadcastActivity(activity, activitySource),
  });

  const ownershipClient =
    openclawClient || (gatewayBridge && gatewayBridge.rawClient) || null;
  if (ownershipClient && typeof ownershipClient.setSessionAgentResolver === "function") {
    ownershipClient.setSessionAgentResolver((sessionKey     ) =>
      sessionService.getSessionAgentId(sessionKey, sessionKey),
    );
  }

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

  const simulation = createRelaySimulation({
    logger,
    emitDebug,
    sessionService,
    conversationState,
    liveUiV2Session,
    relayOperationRegistry,
    ocuClawSettingsStore,
    broadcastActivity,
    broadcastPages,
    broadcastModelsCatalog,
    broadcastSessions,
    buildLocalUserMessageContent,
    cachePages,
    sendDemand,
    get upstreamRuntime() { return upstreamRuntime; },
    get server() { return server; },
    get handler() { return handler; },
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

  const SESSION_TITLE_STATUS_FALLBACK_MS = 1500;
  let sessionTitleStatusFallbackTimer = null;

  const CARD_BUILD_DONE_REPLY_WAIT_MS = Number.isFinite(opts.cardBuildDoneReplyWaitMs)
    ? Math.max(0, opts.cardBuildDoneReplyWaitMs)
    : 10_000;

  const CARD_BUILD_DONE_LATE_QUIET_MS = Number.isFinite(opts.cardBuildDoneLateQuietMs)
    ? Math.max(0, opts.cardBuildDoneLateQuietMs)
    : 2_000;

  const cardBuildLiveFailed = new Map               ();
  function cardBuildLiveAtDone(done     )                                            {
    const at = relayKeyOf(done.sessionKey);
    const parts = cardBuildLiveFailed.get(at);
    if (!parts) return null;
    cardBuildLiveFailed.delete(at);

    if (done.by === "clean_test" || done.by === "stopped") return null;
    emitDebug("relay.session", "program_card_live_at_done", "debug", { sessionKey: done.sessionKey, runId: done.runId },
      () => ({ by: done.by, parts: parts.length, reasons: [...new Set(parts.map((part) => part.reason))].slice(0, 4) }));
    return { status: "failed", parts };
  }

  const cardBuildPhases = createCardBuildPhases({
    matchKey: normalizeAppSessionKeyForCompare,
    onRunMismatch: (mismatch) => emitDebug(
      "relay.protocol",
      "card_build_run_mismatch",
      "debug",
      { sessionKey: mismatch.sessionKey, runId: mismatch.runId },
      () => ({ edge: mismatch.edge, buildRunId: mismatch.buildRunId }),
    ),

    studio: (sessionKey) => sessionHasCardStudio(sessionKey),

    onStepDeviation: (deviation) => {
      const data = () => ({ from: deviation.from, to: deviation.to });

      try { cardStudio.note({ sessionKey: deviation.sessionKey, event: "step_deviation", severity: "info", data: data() }); } catch {  }
      emitDebug("relay.protocol", "step_deviation", "info", { sessionKey: deviation.sessionKey, runId: deviation.runId }, data);
    },

    onDone: (done) => {
      emitDebug("relay.session", "program_card_done", "debug", { sessionKey: done.sessionKey, runId: done.runId },
        () => ({ by: done.by, lines: done.lines, ms: done.ms, outcome: done.outcome }));
      try {
        cardStudio.buildDone({ sessionKey: done.sessionKey, outcome: done.outcome, doneBy: done.by, runId: done.runId, lines: done.lines, ms: done.ms });
      } catch {  }

      return { changeSave: saveCardChangeAtDone(done), live: cardBuildLiveAtDone(done) };
    },

    change: (sessionKey) => {
      const open = cardChanges?.of(sessionKey);

      if (!open || open.saved !== null || open.ended || typeof open.name !== "string") return null;
      const own = open.firstSaved ? open.lines.slice(0, open.firstSaved - 1) : open.lines;
      return { name: open.name, lines: own };
    },
  });

  const cardStudio = createCardStudioStore({
    matchKey: normalizeAppSessionKeyForCompare,
    ...(typeof opts.stateDir === "string" && opts.stateDir ? { dir: path.join(opts.stateDir, "card-studio"), fs } : {}),
  });

  const cardStudioRevisions = createProgramCardRevisions({ libraryDir: programCardSaves.libraryDir, fs });
  const cardStudioRunRecords = createLiveuiTaskRunRecordStore({ rootDir: programCardSaves.libraryDir, fs });
  const cardStudioReport = createCardStudioReport({
    store: cardStudio,
    readCard: (appId        ) => {
      const loaded      = programCardSaves.load(appId);
      if (!loaded || loaded.status !== "accepted") return null;
      const record = loaded.record;
      return { name: record.name, revision: programCardCurrentRevision(record), state: record.state,
        source: record.card && record.card.kind === "source" ? record.card.source : null };
    },
    revisions: (appId        ) => cardStudioRevisions.list(appId),
    readReview: (appId        ) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(programCardSaves.libraryDir, PROGRAM_CARD_REVIEWS_DIRECTORY, `${appId}.json`), "utf8"));
      } catch {
        return null;
      }
    },
    runRecords: (taskId        ) => cardStudioRunRecords.list(taskId),
    taskRows: () => {
      if (relayBackendKind === "hermes") {
        const source = opts.cardStudioTasks;
        return source && typeof source.rows === "function" ? source.rows() : [];
      }
      return openClawTaskRows.read();
    },
    taskOutput: (params     ) => {
      if (relayBackendKind === "hermes") {
        const source = opts.cardStudioTasks;
        return source && typeof source.output === "function" ? source.output(params) : null;
      }
      return openClawTaskResults.link.request(LINK_TASK_OUTPUT_SNAPSHOT_METHOD, params);
    },
  });

  function noteCardStudioToolCall(call     ) {
    let noted      = null;
    try {

      const runId = call && typeof call.sessionKey === "string" && call.runId === undefined
        ? cardBuildPhases.current(call.sessionKey)?.runId ?? null : call?.runId;
      noted = cardStudio.toolCall(call && runId ? { ...call, runId } : call);
    } catch (err     ) {
      logger.warn(`[relay] card studio call not kept: ${err && err.message ? err.message : err}`);
    }
    if (noted) {
      emitDebug(CARD_STUDIO_CATEGORY, "card_build_call", "info", { sessionKey: call.sessionKey }, () => ({ ...noted,
        durationMs: Number.isFinite(call.endedAtMs) && Number.isFinite(call.startedAtMs) ? Math.max(0, call.endedAtMs - call.startedAtMs) : null }));
    }
    return noted;
  }

  function noteCardStudioTrace(cat     , event     , severity     , context     , buildData     ) {
    if (cat !== "relay.session" || typeof event !== "string" || !event.startsWith("program_card_")) return;
    const sessionKey = context && typeof context.sessionKey === "string" ? context.sessionKey : "";
    if (!sessionKey) return;
    try {
      const data = typeof buildData === "function" ? buildData() : buildData;
      cardStudio.note({ sessionKey, event, severity, data });
    } catch {

    }
  }

  function noteCardReviewEvent(appId     , event        , data     ) {
    if (typeof appId !== "string" || !appId) return;
    try {
      cardStudio.cardEvent({ cardKey: `app:${appId}`, event, data });
    } catch {

    }
  }

  const cardAcceptCandidates = new Map                ();
  function noteCardAcceptTest(request     ) {
    const look = request?.check?.look;
    if (typeof request?.candidateId !== "string" || !look || typeof look !== "object") return;
    noteCardReviewEvent(request.appId, "card_accept_test", { reviewId: request.reviewId ?? null, ideaId: request.ideaId ?? null,
      candidateId: request.candidateId, checkOk: request.check.ok === true, look });
  }
  function noteCardAccept(request     , result     , startedAt        ) {
    try {
      if (!request || !result || typeof result !== "object") return;
      noteCardAcceptRow(request, result, startedAt);
    } catch {

    }
  }
  function noteCardAcceptRow(request     , result     , startedAt        ) {
    const checking = typeof request.candidateId === "string" && !!request.candidateId;
    const sent = typeof result.candidateId === "string" ? result.candidateId : null;

    const candidateId = checking ? request.candidateId : sent;
    const status = typeof result.status === "string" ? result.status : typeof result.code === "string" ? "rejected" : null;
    const at = Date.now();
    let retestMs                = null;
    if (checking) {
      const sentAt = cardAcceptCandidates.get(request.candidateId);
      if (sentAt !== undefined) retestMs = Math.max(0, startedAt - sentAt);
      if (status !== "rejected") cardAcceptCandidates.delete(request.candidateId);
    }

    if (status === "candidate" && sent) {
      cardAcceptCandidates.delete(sent);
      cardAcceptCandidates.set(sent, at);
      while (cardAcceptCandidates.size > 64) cardAcceptCandidates.delete(cardAcceptCandidates.keys().next().value          );
    }
    const num = (value     ) => (Number.isFinite(value) ? value : undefined);
    noteCardReviewEvent(request.appId, "card_accept", {
      step: checking ? "check" : "candidate", reviewId: request.reviewId ?? null, ideaId: request.ideaId ?? null, candidateId, status,
      ...(checking && sent && sent !== request.candidateId ? { nextCandidateId: sent } : {}),
      ...(typeof result.code === "string" ? { code: result.code } : {}),
      ...(num(result.attempt) !== undefined ? { attempt: result.attempt } : {}),
      ...(checking && request.check && typeof request.check === "object" ? { checkOk: request.check.ok === true } : {}),
      ...(request.force === true ? { force: true } : {}),
      ...(retestMs !== null ? { retestMs } : {}),
      ...(typeof result.reason === "string" ? { reason: result.reason.slice(0, 80) } : {}),
      ...(typeof result.metric === "string" ? { metric: result.metric } : {}),
      ...(num(result.before) !== undefined ? { before: result.before } : {}),
      ...(num(result.after) !== undefined ? { after: result.after } : {}),
      ...(typeof result.compare?.gain === "boolean" ? { gain: result.compare.gain } : {}),
      ...(num(result.revision) !== undefined ? { revision: result.revision } : {}),
      ms: Math.max(0, at - startedAt),
    });
  }

  const cardBuildDoneHolds = new Map                                              ();
  function holdCardBuildDone(sessionKey        , settled                  , maxMs        ) {
    const key = relayKeyOf(sessionKey);
    if (!key || cardBuildDoneHolds.has(key)) return false;
    const hold = { held: null                , edge: "" };
    cardBuildDoneHolds.set(key, hold);
    broadcastCardBuild(cardBuildPhases.frameLane({ sessionKey, state: "drawing" }), "frameLane");
    let timer      = null;
    const release = (why        ) => {
      if (cardBuildDoneHolds.get(key) !== hold) return;
      cardBuildDoneHolds.delete(key);
      if (timer) clearTimeout(timer);
      emitDebug("relay.protocol", "card_build_done_hold", "debug", { sessionKey }, () => ({ released: why, held: !!hold.held }));

      if (hold.held) broadcastCardBuild(hold.held, `${hold.edge}+frame`, { heldRelease: true });
    };
    timer = setTimeout(() => release("cap"), Math.max(0, maxMs));
    if (typeof timer?.unref === "function") timer.unref();
    const ended = (status         ) => {
      release("frame");
      broadcastCardBuild(cardBuildPhases.frameLane({ sessionKey, state: status === "wired" ? "added" : "none" }), "frameLane", { only: "studio" });
    };
    Promise.resolve(settled).then(ended, () => ended(null));
    return true;
  }

  function heldAsChecking(frame     ) {
    return frame.done === true && cardBuildDoneHolds.has(relayKeyOf(frame.sessionKey))
      ? { ...frame, done: false, phase: frame.studio === true ? "finishing" : "checking" } : frame;
  }

  function sendCardBuild(frame     , opts
                                                 = {}) {
    if (!server) return;
    const elsewhere = opts.elsewhere === true;
    const replay = opts.replay === true;
    const marks = { ...(elsewhere ? { elsewhere: true } : {}), ...(replay ? { replay: true } : {}) };
    const testingOf = (shown     ) => [shown.phase, ...shown.steps.map((step     ) => step.phase)].some(phase => phase === "looking" || phase === "pressing");

    const studio = frame.studio === true;

    const held = studio && opts.held === true && frame.done === true;
    const legacy = studio ? cardBuildLegacyFrame(held ? { ...frame, done: false, phase: "finishing" } : frame) : frame;
    const testing = testingOf(legacy);

    const planned = frame.plan !== undefined || frame.name !== undefined;
    if (!studio && !testing && !planned && !elsewhere && !replay && !opts.onlyClientId) {
      server.broadcast(handler.formatCardBuild({ ...frame, sessionKey: relaySessionKeyFor(frame.sessionKey) }));
      return;
    }
    const clients = new Map(server.getReadinessSnapshot().clients.map((client     ) => [client.clientId, client]));
    for (const clientId of opts.onlyClientId ? [opts.onlyClientId] : server.getClientIds()) {
      const client      = clients.get(clientId);
      const caps = client?.clientCapabilities || [];
      if ((elsewhere || replay) && !caps.includes(CARD_BUILD_TASK_CAPABILITY)) continue;
      const known = (phase        ) => phase === "looking" ? caps.includes(PROGRAM_CARD_LOOK_CAPABILITY)
        : phase === "pressing" ? caps.includes(PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY) : true;
      const studioPhone = studio && !!client && caps.includes(CARD_STUDIO_CAPABILITY);
      if (studio && opts.only && (opts.only === "studio") !== studioPhone) continue;
      const shown = studioPhone ? frame : legacy;
      let adapted = studioPhone || !client || !testing ? shown : { ...shown,
        phase: shown.phase && !known(shown.phase) ? "checking" : shown.phase,
        ...(!known(shown.phase) ? { detail: undefined } : {}),
        steps: shown.steps.map((step     ) => known(step.phase) ? step : { phase: "checking", durationMs: step.durationMs }),
      };
      if (planned && !caps.includes(PROGRAM_CARD_PLAN_CAPABILITY)) {
        const { name: _name, plan: _plan, change: _change, icon: _icon, ...unplanned } = adapted;
        adapted = unplanned;
      }
      server.unicast(clientId, handler.formatCardBuild({ ...adapted, ...marks, sessionKey: relaySessionKeyFor(frame.sessionKey) }));
    }
  }

  function replayTaskCardBuilds(clientId        ) {
    for (const frame of cardBuildPhases.taskBuilds()) {

      const held = frame.done === true && frame.studio === true && cardBuildDoneHolds.has(relayKeyOf(frame.sessionKey));
      sendCardBuild(held ? frame : heldAsChecking(frame), { replay: true, elsewhere: !sessionService.isCurrentSession(frame.sessionKey),
        onlyClientId: clientId, held });
    }
  }

  const cardBuildDonesMissed = new Set        ();

  const cardBuildDoneSentAtMs = new Map                ();
  function noteCardBuildDoneMissed(chat        ) {
    cardBuildDonesMissed.delete(chat);
    cardBuildDonesMissed.add(chat);
    if (cardBuildDonesMissed.size > 32) cardBuildDonesMissed.delete(cardBuildDonesMissed.values().next().value          );
  }

  const cardBuildRunsEndedElsewhere = new Map                       ();
  function noteCardBuildRunEndedElsewhere(activity     ) {
    const open = cardBuildPhases.current(activity.sessionKey);
    if (!open || open.task) return;
    const runId = typeof activity.runId === "string" && activity.runId ? activity.runId : null;
    if (runId && open.runId && runId !== open.runId) return;
    const chat = relayKeyOf(open.sessionKey);
    cardBuildRunsEndedElsewhere.delete(chat);
    cardBuildRunsEndedElsewhere.set(chat, open.runId ?? null);
    if (cardBuildRunsEndedElsewhere.size > 32) {
      cardBuildRunsEndedElsewhere.delete(cardBuildRunsEndedElsewhere.keys().next().value          );
    }
  }

  const cardBuildReconnectReplayMs = Number.isFinite(opts.cardBuildReconnectReplayMs)
    ? Math.max(0, opts.cardBuildReconnectReplayMs)
    : 1500;

  function replayChatCardBuilds(clientId        , owedDones                     = null) {
    if (!server || !server.getClientIds().includes(clientId)) return;
    for (const frame of cardBuildPhases.chatBuilds()) {
      if (!sessionService.isCurrentSession(frame.sessionKey)) continue;
      const chat = relayKeyOf(frame.sessionKey);
      if (frame.done === true) {
        if (owedDones ? !owedDones.has(chat) : !cardBuildDonesMissed.delete(chat)) continue;
        cardBuildDoneSentAtMs.set(chat, Date.now());
      } else if (owedDones) continue;
      else if (cardBuildRunsEndedElsewhere.has(chat) && cardBuildRunsEndedElsewhere.get(chat) === (frame.runId ?? null)) {

        continue;
      }
      const held = frame.done === true && frame.studio === true && cardBuildDoneHolds.has(chat);
      sendCardBuild(held ? frame : heldAsChecking(frame), { onlyClientId: clientId, held });
      emitDebug("relay.protocol", "card_build_reconnect_sent", "info", { sessionKey: frame.sessionKey },
        () => ({ clientId, phase: frame.phase ?? null, done: frame.done === true }));
    }
  }

  const cardStudioDoneFrames = new WeakSet        ();

  function broadcastCardBuild(frames       , edge = "", opts                                                        = {}) {
    for (let frame of frames) {

      if (frame && frame.done === true && !cardStudioDoneFrames.has(frame)) {
        cardStudioDoneFrames.add(frame);
        try {
          cardStudio.buildDone({ sessionKey: frame.sessionKey, outcome: frame.outcome ?? null, runId: frame.runId, steps: frame.steps });
        } catch {  }
      }
      if (!server) continue;

      const elsewhere = !sessionService.isCurrentSession(frame.sessionKey);

      if (!frame.task && !elsewhere && !(opts.heldRelease && frame.studio === true)) {
        const chat = relayKeyOf(frame.sessionKey);

        if (cardBuildRunsEndedElsewhere.has(chat) && cardBuildRunsEndedElsewhere.get(chat) !== (frame.runId ?? null)) {
          cardBuildRunsEndedElsewhere.delete(chat);
        }
        if (frame.done !== true) {
          cardBuildDonesMissed.delete(chat);
          cardBuildDoneSentAtMs.delete(chat);
        } else if (!connectedAppClientHas(PROGRAM_CARD_CAPABILITY)) noteCardBuildDoneMissed(chat);
        else {

          cardBuildDonesMissed.delete(chat);
          cardBuildDoneSentAtMs.delete(chat);
          cardBuildDoneSentAtMs.set(chat, Date.now());
          if (cardBuildDoneSentAtMs.size > 32) cardBuildDoneSentAtMs.delete(cardBuildDoneSentAtMs.keys().next().value          );
        }
      }

      if (elsewhere && !frame.task && !(frame.done === true && frame.changeSave)) continue;
      const hold = frame.done === true ? cardBuildDoneHolds.get(relayKeyOf(frame.sessionKey)) : undefined;
      const studio = frame.studio === true;
      if (hold) {

        hold.held = [frame];
        hold.edge = edge;
        if (studio) taskFixEnded(frame);
        else frame = { ...frame, done: false, phase: "checking" };
      } else if (!(opts.heldRelease && studio)) taskFixEnded(frame);
      sendCardBuild(frame, { elsewhere, held: !!hold && studio,
        ...(studio && opts.heldRelease ? { only: "legacy"          } : opts.only ? { only: opts.only } : {}) });
      emitDebug(
        "relay.protocol",
        "card_build_sent",
        "debug",
        { sessionKey: frame.sessionKey, runId: frame.runId },
        () => {
          const ended = frame.steps.filter((step     ) => step.durationMs != null);
          return {
            phase: frame.phase,
            done: frame.done,

            studio: frame.studio === true,

            frameLane: frame.frameLane ?? null,
            ...(hold ? { heldForFrame: true } : {}),
            edge: edge || null,
            origin: frame.origin ?? null,
            steps: frame.steps.map((step     ) => step.phase).join(","),

            durationsMs: frame.steps.map((step     ) => step.durationMs ?? "-").join(","),

            lastStepMs: ended.length > 0 ? ended[ended.length - 1].durationMs : null,

            part: frame.part ?? null,
            design: Array.isArray(frame.design) ? frame.design.length : 0,
            attempt: frame.attempt ?? 1,

            task: !!frame.task,
            outcome: frame.outcome ?? null,
            elsewhere,

            view: cardBuildView(frame),
          };
        },
      );
    }
    scheduleCardBuildTick();
  }

  let cardBuildTickTimer      = null;
  let cardBuildTickAt                = null;
  function scheduleCardBuildTick() {
    const due = cardBuildPhases.nextTickAt();
    if (due === cardBuildTickAt) return;
    if (cardBuildTickTimer) clearTimeout(cardBuildTickTimer);
    cardBuildTickTimer = null;
    cardBuildTickAt = due;
    if (due == null) return;
    cardBuildTickTimer = setTimeout(() => {
      cardBuildTickTimer = null;
      cardBuildTickAt = null;
      broadcastCardBuild(cardBuildPhases.tick(), "designQuiet");
      scheduleCardBuildTick();
    }, Math.max(0, due - Date.now()) + 50);
    if (typeof cardBuildTickTimer?.unref === "function") cardBuildTickTimer.unref();
  }

  function carryCardBuild(activity     )                          {
    if (!activity) return null;
    const sessionKey = activity.sessionKey || null;
    const carried = cardBuildTurns.carriesBuild(sessionKey, activity.runId);
    if (carried === "carry") {
      cardBuildPhases.handOff({ sessionKey, runId: activity.runId });
      const open = cardBuildPhases.current(sessionKey);
      if (open) broadcastCardBuild([open], "handOff");
    }
    if (carried) emitDebug("relay.protocol", "card_build_turn_carry", "info", { sessionKey }, () => ({ carried }));
    return carried;
  }

  function noteCardBuildActivity(activity     , turnEnded         , carried                         ) {
    if (!activity) return;
    const sessionKey = activity.sessionKey || null;
    if (turnEnded) {
      if (carried) return;

      broadcastCardBuild(cardBuildPhases.runEnd({ sessionKey, runId: activity.runId, aborted: isCancelledRunFrame(activity) }), "runEnd");

      const flush = setTimeout(() => {

        try { broadcastCardBuild(cardBuildPhases.flushDone({ sessionKey }), "flushDone"); } catch {  }
      }, CARD_BUILD_DONE_REPLY_WAIT_MS);
      if (typeof (flush       )?.unref === "function") (flush       ).unref();
      return;
    }
    if (activity.origin === "tool" && activity.toolPhase === "start") {
      broadcastCardBuild(cardBuildPhases.toolStart({ sessionKey, runId: activity.runId, tool: activity.tool }), `tool:${activity.tool}`);
    } else if (activity.origin === "tool" && (activity.toolPhase === "end" || activity.toolPhase === "result" || activity.toolPhase === "error")) {
      broadcastCardBuild(cardBuildPhases.toolEnd({ sessionKey, runId: activity.runId, tool: activity.tool }), `toolEnd:${activity.tool}`);
    } else if (cardBuildReasoningSignal(activity) === "cue") {

      const headline = activityStatusAdapter.headlineNote(activity);
      if (headline) {
        broadcastCardBuild(cardBuildPhases.reasoningHeadline({ sessionKey, runId: activity.runId, headline }), "reasoning");
      } else {

        broadcastCardBuild(cardBuildPhases.reasoning({ sessionKey, runId: activity.runId }), "reasoningCue");
      }
    } else if (cardBuildReasoningSignal(activity) === "headline") {
      broadcastCardBuild(cardBuildPhases.reasoningHeadline({ sessionKey, runId: activity.runId, headline: activity.summary }), "reasoning");
    }
  }

  function broadcastActivity(rawActivity     , activitySource      = null) {
    const activity = activityStatusAdapter.augmentActivity(rawActivity || {});
    const runId = activity && activity.runId ? activity.runId : null;
    const origin = activity && activity.origin ? activity.origin : null;
    const phase = activity && activity.phase ? activity.phase : null;

    const lifecycleOutcome = typeof origin === "string" && origin.trim().toLowerCase() === "lifecycle"
      ? classifyRunOutcomeFrame(activity, phase, origin)
      : null;
    const turnEnded = phase === "end" || (lifecycleOutcome !== null && lifecycleOutcome.terminal);

    try {
      webJevShadow.observeActivity(activity, turnEnded);
    } catch (_) {

    }
    agentTurnTracker.onActivity(
      (activity && activity.sessionKey) || sessionService.ensureSessionKey(),
      turnEnded ? "end" : phase,

      runId,
    );
    sessionService.observeGreetingActivity(
      activitySource === "unattributed" ? null : activity && activity.sessionKey,
      phase,
      runId,
      activitySource || origin,
    );
    if (turnEnded && liveuiTaskRunController) {
      liveuiTaskRunController.observeTurnIdle(
        (activity && activity.sessionKey) || sessionService.ensureSessionKey(),
        { failed: lifecycleOutcome !== null && lifecycleOutcome.errored },
      );
    }

    if (runId) noteRunOutcomeFrame(activity, phase, origin);

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
        modelCallSeq: Number.isInteger(activity && activity.modelCallSeq) && activity.modelCallSeq > 0
          ? activity.modelCallSeq
          : null,
        category: (activity && activity.category) || null,
        origin,
        phase,
        toolPhase: (activity && activity.toolPhase) || null,
        tool: (activity && activity.tool) || null,
        activityId: (activity && activity.activityId) || null,
        seq: Number.isFinite(activity && activity.seq) ? activity.seq : null,

        ...(activity && activity.labelSource
          ? {
              labelSource: activity.labelSource,
              labelFits: Array.isArray(activity.labelFits) ? activity.labelFits : null,
              shortLabel: activity.shortLabel || null,
              toolLabel: activity.toolLabel || null,
            }
          : {}),

        ...(activity && activity.chapter
          ? { chapter: activity.chapter, toolLabel: activity.toolLabel || null }
          : {}),
      }),
    );

    const carried = turnEnded ? carryCardBuild(activity) : null;

    if (turnEnded) noteCardBuildActivity(activity, turnEnded, carried);
    server.broadcast(handler.formatActivity(activity));
    if (!turnEnded) noteCardBuildActivity(activity, turnEnded, carried);

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
        }, "simulated");
      }, SESSION_TITLE_STATUS_FALLBACK_MS);
    }

    return activity;
  }

  function broadcastProviderUsageSnapshot(snapshot) {
    if (!server || !handler || typeof handler.formatProviderUsageSnapshot !== "function") {
      return snapshot;
    }
    server.broadcast(handler.formatProviderUsageSnapshot(snapshot || {}));
    return snapshot;
  }

  function broadcastModelsCatalog(snapshot) {
    if (!server || !handler || typeof handler.formatModelsCatalog !== "function") {
      return snapshot;
    }
    server.broadcast(handler.formatModelsCatalog(snapshot || {}));
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
      optionalSetupCommandsVersion: opts.optionalSetupCommandsVersion,
      optionalSetupGeneration,
      optionalSetupEvenAiCommands: opts.optionalSetupEvenAiCommands,
      optionalSetupJevCheck: true,
      modelSitesCommandsVersion: modelSites ? 1 : 0,
      modelSitesGeneration,
      evenAiRequestObservation: evenAiRequestObservation.getSnapshot(),
      stale: options.stale === true,
      externalDebugToolsEnabled,
      allowDebugUpload,
      sessionOptionsSupported:
        opts.hermesSessionOptionsSupported === true,
      agentDraftSupported: agentDrafts.supported(),
      taskFromWordsSupported: taskFromWords.supported(),
      agentCatalogSnapshot,

      hermesFeatures: parseHermesFeatureTokens(process.env.OCUCLAW_HERMES_FEATURES),
      openclawHostVersion: pluginVersionService.getOpenClawHostVersion(),
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

  function openClawTaskSheetAgentId()                  {
    const chosen = ocuClawDefaultAgentAsAgentId(ocuClawSettingsStore.getSnapshot().defaultAgent);
    if (chosen) return Promise.resolve(chosen);
    return getCapabilityAgentCatalogSnapshot().then(
      (catalog     ) => typeof catalog?.defaultId === "string" && catalog.defaultId.trim() ? catalog.defaultId.trim() : "main",
      () => "main",
    );
  }

  function unicastCapabilitySnapshot(clientId) {
    if (!server || !clientId) return;
    getCapabilityAgentCatalogSnapshot().then((agentCatalogSnapshot) => {
      if (!server) return;
      server.unicast(clientId, buildCapabilitySnapshotFrame(agentCatalogSnapshot));
    });
  }

  function unicastActivityReplay(clientId     ) {
    if (!server || !handler || !clientId || !upstreamRuntime) return;
    const frame = typeof upstreamRuntime.getActivityReplay === "function"
      ? upstreamRuntime.getActivityReplay() : upstreamRuntime.getActivityPlanReplay();
    if (!frame) return;
    server.unicast(clientId, handler.formatActivity(activityStatusAdapter.augmentActivity(frame)));
  }

  function appClientSupportsCapabilitySnapshot(entry) {
    return !!(
      entry &&
      Array.isArray(entry.clientCapabilities) &&
      entry.clientCapabilities.includes("capability-snapshot")
    );
  }

  function formatSecretRequestFrame(request     ) {
    return JSON.stringify({
      type: "ocuclaw.secret.request",
      id: request.id,
      backend: "openclaw",
      agentName: request.agentName || null,
      sessionKey: request.sessionKey,
      sessionTitle: sessionService.getSessionTitle(request.sessionKey) || null,
      kind: "secret",
      name: request.name,
      prompt: request.prompt,
      header: request.header || null,
      reason: request.reason || null,
      allowedHosts: request.allowedHosts,
      existing: request.existing,
      expiresAtMs: request.expiresAtMs,
    });
  }

  function hasConnectedSecretEntryApp() {
    try {
      const clients =
        server && typeof server.getReadinessSnapshot === "function"
          ? (server.getReadinessSnapshot().clients || [])
          : [];
      return clients.some(appClientSupportsSecretEntry);
    } catch {
      return false;
    }
  }

  function broadcastSecretFrame(frame        ) {
    if (!server) return;
    const clients =
      typeof server.getReadinessSnapshot === "function"
        ? (server.getReadinessSnapshot().clients || [])
        : [];
    for (const entry of clients) {
      if (appClientSupportsSecretEntry(entry)) server.unicast(entry.clientId, frame);
    }
  }

  function appClientSupportsSecretEntry(entry     ) {
    return !!(
      entry &&
      entry.clientKind === "app" &&
      Array.isArray(entry.clientCapabilities) &&
      entry.clientCapabilities.includes(SECRET_ENTRY_CAPABILITY)
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

  function executorRegistryAgents(agents     ) {
    if (!Array.isArray(agents)) return [];
    return agents
      .map((entry      = {}) => {
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
    } catch (err     ) {
      logger.warn(`[relay] LiveUI Executor registry read failed: ${err && err.message ? err.message : err}`);
      return [];
    }
  }

  function updateLiveuiExecutorRegistry(snapshot     ) {
    if (
      !snapshot ||
      snapshot.stale === true ||
      snapshot.unsupported === true ||
      !Array.isArray(snapshot.agents)
    ) return snapshot;
    liveuiAgents = snapshot.agents.map((entry     ) => ({ ...entry }));
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
    } catch (err     ) {
      logger.warn(`[relay] LiveUI Executor registry publish failed: ${err && err.message ? err.message : err}`);
    }
    return snapshot;
  }

  function resolveLiveuiTaskExecutorState(
    executor     ,
    version      = {},
    agents      = liveuiAgents,
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
    const localRecord = registry.find((record     ) => record && record.host === relayBackendKind);
    const localLastSeenAt = localRecord && Number.isSafeInteger(localRecord.updatedAt)
      ? localRecord.updatedAt
      : catalog && Number.isSafeInteger(catalog.fetchedAtMs)
        ? catalog.fetchedAtMs
        : Date.now();
    const executors      = [];
    const seen = new Set();
    const pushOption = (host     , agent     , lastSeenAt     , stateInput     ) => {
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
    } catch (err     ) {
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
    server.broadcast(handler.formatAgentsCatalog(hermesEnrollment.stampCatalog(snapshot || {})));
    broadcastCapabilitySnapshot(snapshot || {});
    return snapshot;
  }

  const appClientDisconnectChannel = createEventChannel(logger, "app_client_disconnect");
  function dispatchAppClientDisconnect(sessionKey) {
    appClientDisconnectChannel.emit(() => ({ sessionKey }));
    if (liveuiTaskRunController) {
      liveuiTaskRunController.observeSessionEnd({
        sessionKey: sessionKey || "",
        reason: "glasses_disconnected",
      });
    }
    rotateLiveUiSessionGenerationAfterDisconnect(sessionKey);
  }

  const liveUiPaintedSessionKeys      = new Set();
  function rotateLiveUiSessionGenerationAfterDisconnect(sessionKey     ) {
    const normalizedSessionKey = normalizeAppSessionKeyForCompare(sessionKey);
    const keys = normalizedSessionKey
      ? [normalizedSessionKey].filter((key) => liveUiPaintedSessionKeys.has(key))
      : [...liveUiPaintedSessionKeys];
    const rotated        = [];
    for (const key of keys) {
      liveUiPaintedSessionKeys.delete(key);
      const generation = rotateLiveUiSessionGeneration(key);
      if (generation) rotated.push({ sessionKey: key, liveUiSessionGeneration: generation });
    }
    if (rotated.length === 0) return;
    emitDebug(
      "glasses.lifecycle",
      "disconnect_generation_rotated",
      "info",
      {},
      () => ({ rotated }),
    );
    if (server) broadcastStatus();
  }

  const appClientSessionLeftChannel = createEventChannel(logger, "app_client_session_left");
  function dispatchAppClientSessionLeft(sessionKey     , nextSessionKey     ) {
    appClientSessionLeftChannel.emit(() => ({ sessionKey, nextSessionKey }));
  }

  function noteAppClientSessionSelected(clientId     , sessionKey     ) {
    if (!server || typeof (server       ).setClientSessionKey !== "function") return;
    const previous =
      typeof (server       ).getClientSessionKey === "function"
        ? (server       ).getClientSessionKey(clientId)
        : null;
    if (!(server       ).setClientSessionKey(clientId, sessionKey)) return;
    profileBotScreenSource?.selectionChanged(clientId);
    if (previous && previous !== sessionKey) {
      cardDrafts?.cancelClient(clientId);
    }

    const next = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if ((previous || "") !== next) programCardReviewer.cancelClient(clientId);
    if (
      previous &&
      next &&
      previous !== next &&
      typeof (server       ).getAppClientCountOnSession === "function" &&
      (server       ).getAppClientCountOnSession(next) > 0 &&
      (server       ).getAppClientCountOnSession(previous) === 0
    ) {
      dispatchAppClientSessionLeft(previous, next);
    }
  }

  const appPresenceChangedChannel = createEventChannel(logger, "app_presence_changed");
  function dispatchAppPresenceChanged(reason     ) {
    appPresenceChangedChannel.emit(() => ({ reason }));
    if (reason === "grace_resumed") replayLiveUiV2AfterGrace();
  }

  function replayLiveUiV2AfterGrace() {
    if (!upstreamRuntime || typeof upstreamRuntime.replayLiveUiV2Session !== "function") return;
    const viewed = relayApi.getAppViewedSessionKeys();
    if (!Array.isArray(viewed)) return;
    for (const sessionKey of viewed) {
      try {
        upstreamRuntime.replayLiveUiV2Session(sessionKey, "grace_resumed");
      } catch (err     ) {
        emitDebug("glasses.lifecycle", "liveui_v2_replay_failed", "warn", { sessionKey }, () => ({
          error: err && err.message ? err.message : String(err),
        }));
      }
    }
  }

  function liveUiV2Sender() {
    return upstreamRuntime && upstreamRuntime.liveUiV2Sender ? upstreamRuntime.liveUiV2Sender : null;
  }

  const pairingCompletedChannel = createEventChannel(logger, "pairing_completed");
  function dispatchPairingCompleted(completionId     ) {

    try { if (getActiveBackendKind() === "openclaw") firstUseStore?.notePairingCompleted(); }
    catch (err     ) { logger.warn(`[relay] setup first-use pairing note failed: ${err && err.message ? err.message : err}`); }

    try { if (getActiveBackendKind() === "openclaw") firstUseRelayRun?.pairingCompleted(); }
    catch (err     ) { logger.warn(`[relay] setup pairing wake failed: ${err && err.message ? err.message : err}`); }
    pairingCompletedChannel.emit(() => completionId);
  }

  const replyDelivery = createReplyDeliveryCoordinator({
    getLedger: () => ({
      sessionKey: sessionService.peekSessionKey() || null,
      entries: typeof conversationState.getEntries === "function"
        ? conversationState.getEntries().entries
        : [],
    }),
    listClients: () =>
      server && typeof server.getReadinessSnapshot === "function"
        ? (server.getReadinessSnapshot().clients || [])
        : [],
    unicast: (clientId     , frame     ) => { if (server) server.unicast(clientId, frame); },
    emitDebug: (event     , data     ) =>
      emitDebug("relay.session", event, "debug", {}, () => data),
    isRunErrored: runErrored,
  });

  const logicalSessionResetChannel = createEventChannel(logger, "logical_session_reset");
  function ensureLiveUiSessionGeneration(sessionKey     ) {
    const normalizedSessionKey = normalizeAppSessionKeyForCompare(sessionKey);
    if (!normalizedSessionKey) return null;
    const existing = liveUiSessionGenerations.get(normalizedSessionKey);
    if (existing) return existing;
    const generation = `${liveUiSessionGenerationBootId}:${++liveUiSessionGenerationSeq}`;
    liveUiSessionGenerations.set(normalizedSessionKey, generation);
    return generation;
  }
  function currentLiveUiSessionContext(sessionKey     ) {
    return resolveLiveUiSessionContext(
      sessionKey,
      sessionService.peekSessionKey(),
      ensureLiveUiSessionGeneration,
    );
  }
  function rotateLiveUiSessionGeneration(sessionKey     ) {
    const normalizedSessionKey = normalizeAppSessionKeyForCompare(sessionKey);
    if (!normalizedSessionKey) return null;
    const generation = `${liveUiSessionGenerationBootId}:${++liveUiSessionGenerationSeq}`;
    liveUiSessionGenerations.set(normalizedSessionKey, generation);
    return generation;
  }
  function dispatchLogicalSessionReset(sessionKey     , reason     ) {
    const normalizedSessionKey =
      typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
    if (!normalizedSessionKey) return;
    const normalizedReason =
      typeof reason === "string" && reason.trim() ? reason.trim() : "logical_reset";
    const liveUiSessionGeneration = rotateLiveUiSessionGeneration(normalizedSessionKey);
    logicalSessionResetChannel.emit(() => ({
      sessionKey: normalizedSessionKey,
      reason: normalizedReason,
      liveUiSessionGeneration,
    }));
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
    normalizedSessionKey     ,
    normalizedReason     ,
    liveUiSessionGeneration     ,
  ) {
    forgetPresetSurfaces(normalizedSessionKey);
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

  function clearGlassesUiSurfacesOnly(sessionKey     , reason     ) {
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
  function clearLogicalSessionState(sessionKey     , reason     ) {
    sessionService.clearLogicalSessionState(sessionKey);

    dropCardCheckAsk(sessionKey);
    dispatchLogicalSessionReset(sessionKey, reason);
  }

  const glassesUiResultChannel = createEventChannel(logger, "glasses_ui_result");

  let injectChildGeneration = 0;
  function withInjectMintedChildren(surfaceId     , spec     ) {
    if (!spec || !Array.isArray(spec.children) || preloadedChildrenAreMinted(spec.children)) return spec;
    injectChildGeneration += 1;
    return {
      ...spec,
      children: mintPreloadedChildren(surfaceId, spec.title, spec.children, `i${injectChildGeneration}`),
    };
  }

  function sendGlassesUiRender(params) {
    if (!server) return;
    const { sessionKey, liveUiSessionGeneration } = currentLiveUiSessionContext(
      params && params.sessionKey,
    );
    const paintedSessionKey = normalizeAppSessionKeyForCompare(sessionKey);
    if (paintedSessionKey) liveUiPaintedSessionKeys.add(paintedSessionKey);
    const renderSurfaceId = params && typeof params.surfaceId === "string" ? params.surfaceId : "";
    const payload = glassesUiRenderPayload(
      params,
      { sessionKey, liveUiSessionGeneration },
      params && params.spec ? withInjectMintedChildren(renderSurfaceId, params.spec) : null,
    );
    const asked = presetAskedWords(params && params.sessionKey, payload);
    if (asked) (payload       ).asked = asked;

    const preset = sendPresetForm(payload, false);
    if (!preset) return;
    emitDebug(
      "glasses.lifecycle",
      "surface_send",
      "debug",
      { sessionKey: payload.sessionKey || undefined },
      () => ({ surfaceId: payload.surfaceId, mode: "render", seq: payload.seq, depth: payload.depth, origin: payload.origin, preset, ...summarizeGlassesUiContent(payload.spec) }),
    );
  }

  const presetSurfaces = new Map             ();
  const PRESET_SURFACES_MAX = 256;
  function presetSurfaceKey(sessionKey     , surfaceId     ) {
    return `${normalizeAppSessionKeyForCompare(sessionKey) || ""}\u0000${surfaceId}`;
  }
  function forgetPresetSurfaces(sessionKey     ) {
    const prefix = `${normalizeAppSessionKeyForCompare(sessionKey) || ""}\u0000`;
    for (const key of [...presetSurfaces.keys()]) if (key.startsWith(prefix)) presetSurfaces.delete(key);
  }

  function presetAskedWords(rawSessionKey     , payload     )                {
    const held = presetSurfaces.get(presetSurfaceKey(payload.sessionKey, payload.surfaceId));
    if (held) return typeof held.asked === "string" && held.asked ? held.asked : null;
    if (payload.origin !== "agent") return null;
    const run = agentTurnTracker.runIdFor(rawSessionKey || payload.sessionKey);
    if (!run.runId || !run.active || run.ambiguous) return null;
    return liveUiAskedWords.wordsFor(run.runId);
  }

  function sendPresetForm(payload     , patch         )                {
    const frame = liveUiPresetFrame(payload, { patch });
    if (!frame) {
      emitDebug(
        "glasses.lifecycle",
        "surface_send_dropped",
        "warn",
        { sessionKey: payload.sessionKey || undefined },
        () => ({ surfaceId: payload.surfaceId, reason: "no_preset", kind: payload.spec && payload.spec.kind }),
      );
      return null;
    }
    server.broadcast(JSON.stringify(frame));
    const key = presetSurfaceKey(payload.sessionKey, payload.surfaceId);
    presetSurfaces.delete(key);
    presetSurfaces.set(key, payload);
    if (presetSurfaces.size > PRESET_SURFACES_MAX) presetSurfaces.delete(presetSurfaces.keys().next().value          );
    return (frame.spec                                ).preset.name;
  }

  function sendDemand(params) {
    if (!server || !params) return;
    const payload = buildDemandFrame(params);
    if (!payload) return;
    if (typeof params.clientId === "string") server.unicast(params.clientId, JSON.stringify(payload));
    else if ((payload       ).cardPlan) {

      const { cardPlan: _plan, ...yesNo } = payload       ;

      const { change: _change, ...unchanged } = (payload       ).cardPlan;
      const fixed = { ...payload, cardPlan: unchanged };

      const choice = Array.isArray((payload       ).cardPlan.choices);
      const clients = new Map(server.getReadinessSnapshot().clients.map((client     ) => [client.clientId, client]));
      for (const clientId of server.getClientIds()) {
        const caps = (clients.get(clientId)       )?.clientCapabilities || [];
        const frame = !caps.includes(PROGRAM_CARD_PLAN_CAPABILITY) || (choice && !caps.includes(PROGRAM_CARD_CHOICE_CAPABILITY)) ? yesNo
          : caps.includes(PROGRAM_CARD_CHANGE_CAPABILITY) ? payload : fixed;
        server.unicast(clientId, JSON.stringify(frame));
      }
    } else server.broadcast(JSON.stringify(payload));
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
        botScreen: (payload       ).botScreen === true,
        cardPlan: (payload       ).cardPlan ? (payload       ).cardPlan.lines.length : 0,
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

  function applyConfirmedHermesReset(result      = {}) {
    const sessionKey =
      typeof result.sessionKey === "string" && result.sessionKey
        ? result.sessionKey
        : sessionService.ensureSessionKey();
    if (!sessionService.isCurrentSession(sessionKey)) return false;
    sessionService.invalidateSessionsCache();
    resetActivityStatusAdapter();
    simulation.clearSyntheticWorkForSession(sessionKey);
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

    presentDecision: (request     ) => demandRouter.presentDecision(request),
    resolve: (request     ) => {
      if (typeof opts.resolveHermesSlashConfirm !== "function") {
        return Promise.resolve({
          status: "rejected",
          error: "Hermes slash confirmation resolver is unavailable",
        });
      }
      return opts.resolveHermesSlashConfirm(request);
    },
    applyReset: applyConfirmedHermesReset,
    emit: (event     , data     ) => {
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

  function sendGlassesUiSurfaceUpdate(params     ) {
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
            const o                                                      = { label: i.label };
            if (typeof i.body === "string") o.body = i.body;
            if (typeof i.checked === "boolean") o.checked = i.checked;
            return o;
          }
          return null;
        })
        .filter((i) => i !== null);
    }
    const m = sanitizeGlassesMarker(patch.marker); if (m) cleanPatch.marker = m;
    const { sessionKey, liveUiSessionGeneration } = currentLiveUiSessionContext(
      params && params.sessionKey,
    );
    const surfaceId = params && typeof params.surfaceId === "string" ? params.surfaceId : "";

    const prev = presetSurfaces.get(presetSurfaceKey(sessionKey, surfaceId));
    if (!prev) {
      emitDebug(
        "glasses.lifecycle",
        "surface_send_dropped",
        "warn",
        { sessionKey: sessionKey || undefined },
        () => ({ surfaceId, reason: "no_open_preset" }),
      );
      return;
    }
    const { marker, ...fieldsPatch } = cleanPatch                           ;

    const seq = Number.isFinite(params && params.seq)
      ? Math.floor(params.seq)
      : (Number.isSafeInteger(prev.seq) ? prev.seq : 0) + 1;
    const payload = {
      ...prev,
      liveUiSessionGeneration,
      seq,
      spec: { ...prev.spec, ...fieldsPatch },
      marker: typeof marker === "string" ? marker : prev.marker,
    };
    const preset = sendPresetForm(payload, true);
    if (!preset) return;
    emitDebug(
      "glasses.lifecycle",
      "surface_send",
      "debug",
      { sessionKey: payload.sessionKey || undefined },
      () => ({ surfaceId, mode: "update", seq, preset, ...summarizeGlassesUiContent(cleanPatch) }),
    );
  }

  const liveUiV2OutcomeChannel = createEventChannel(logger, "liveui V2 outcome");

  function dispatchGlassesUiResult(frame) {
    if (!frame || typeof frame !== "object") return;
    const v2 = liveUiV2Sender();

    if (v2 && v2.owns(frame.surfaceId)) {
      const noted =
        upstreamRuntime && typeof upstreamRuntime.noteLiveUiV2Outcome === "function"
          ? upstreamRuntime.noteLiveUiV2Outcome({
              surfaceId: frame.surfaceId,
              outcome: frame.outcome,
              clientId: typeof frame.clientId === "string" ? frame.clientId : null,
              reportAuthoritative: frame.reportAuthoritative === true,
              reportAuthorityReason: typeof frame.reportAuthorityReason === "string" ? frame.reportAuthorityReason : null,
            })
          : v2.noteOutcome(frame.surfaceId, frame.outcome);
      if (noted && noted.wake === true && noted.parked) {
        liveUiV2OutcomeChannel.emit(() => ({ ...noted.parked }));
        if (liveUiV2OutcomeChannel.size === 0) {
          emitDebug("glasses.lifecycle", "liveui_v2_outcome_unwoken", "warn", {}, () => ({
            surfaceId: frame.surfaceId,
            eventId: noted.parked.eventId,
            reason: "no_handler",
          }));
        }
      }
      return;
    }
    glassesUiResultChannel.emit(() => ({
      surfaceId: typeof frame.surfaceId === "string" ? frame.surfaceId : "",
      outcome: frame.outcome,
    }));
  }

  const glassesUiNavEventChannel = createEventChannel(logger, "glasses_ui_nav_event");

  function dispatchGlassesUiNavEvent(frame) {
    if (!frame || typeof frame !== "object") return;
    const v2 = liveUiV2Sender();
    if (v2 && v2.owns(frame.surfaceId)) {

      if (frame.depth === 0) {
        const ended = v2.surfaceSessionOf(frame.surfaceId);
        for (const surfaceId of ended ? v2.surfacesOf(ended) : [frame.surfaceId]) v2.noteEnded(surfaceId, "dismissed");
      }
      return;
    }
    glassesUiNavEventChannel.emit(() => ({
      surfaceId: typeof frame.surfaceId === "string" ? frame.surfaceId : "",
      depth: frame.depth === 0 ? 0 : Number.isFinite(frame.depth) ? Math.max(1, Math.floor(frame.depth)) : 1,

      ...(frame.action === "push_local" && typeof frame.childSurfaceId === "string"
        ? {
            action: "push_local",
            childSurfaceId: frame.childSurfaceId,
            itemIndex: Number.isInteger(frame.itemIndex) ? frame.itemIndex : null,
          }
        : {}),
    }));
  }

  const glassesUiRenderReceiptChannel = createEventChannel(logger, "surface_render_receipt");

  function dispatchGlassesUiRenderReceipt(frame     ) {
    if (!frame || typeof frame !== "object") return;
    const v2 = liveUiV2Sender();
    if (v2 && v2.noteReceipt({ surfaceId: frame.surfaceId, seq: frame.seq })) return;
    glassesUiRenderReceiptChannel.emit(() => ({
      surfaceId: typeof frame.surfaceId === "string" ? frame.surfaceId : "",

      seq: Number.isFinite(frame.seq) ? Math.floor(frame.seq) : null,
    }));
  }

  const glassesUiClientFailureChannel = createEventChannel(logger, "liveui client-failure");

  function dispatchGlassesUiClientFailure(clientId     , data     , authority      = null) {
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
        channel: authority ? "render_error" : "debug",
        authoritative: authority?.authoritative === true,
        handlerCount: glassesUiClientFailureChannel.size,
      }),
    );
    const v2 = liveUiV2Sender();
    if (v2 && v2.owns(data.surfaceId)) {

      v2.noteRenderError({
        surfaceId: data.surfaceId,
        seq: data.seq,
        code: data.code,
        clientId,
        authoritative: authority?.authoritative === true,
      });
      return;
    }
    glassesUiClientFailureChannel.emit(() => ({
      clientId: typeof clientId === "string" ? clientId : null,
      surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",

      seq: Number.isFinite(data.seq) ? Math.floor(data.seq) : null,
      code: typeof data.code === "string" ? data.code : "",
      sdkCode: Number.isFinite(data.sdkCode) ? data.sdkCode : null,

      sessionKey: typeof data.sessionKey === "string" ? data.sessionKey : null,
      activeSessionKey:
        typeof data.activeSessionKey === "string" ? data.activeSessionKey : null,
      channel: authority ? "render_error" : "debug",
      authoritative: authority?.authoritative === true,
      authorityReason: authority?.authorityReason || null,
    }));
  }

  const deviceInfoResponseChannel = createEventChannel(logger, "device_info_response");
  const glassesPresenceChangedChannel = createEventChannel(logger, "glasses_presence_changed");

  function dispatchGlassesPresenceChanged(frame     ) {
    const allowed = new Set(["worn", "absent", "in_case", "unknown"]);
    const presence = allowed.has(frame && frame.presence) ? frame.presence : "unknown";
    emitDebug(
      "glasses.lifecycle",
      "glasses_presence_changed",
      "debug",
      {},
      () => ({ presence, handlerCount: glassesPresenceChangedChannel.size }),
    );
    glassesPresenceChangedChannel.emit(() => ({ presence }));
  }

  const programCardFeedsChannel = createEventChannel(logger, "program_card_feeds");

  function dispatchProgramCardFeeds(frame     ) {
    programCardFeedsChannel.emit(() => frame);
  }

  function sendProgramCardData(frame     ) {
    if (!server || !frame || typeof frame !== "object") return;
    server.broadcast(JSON.stringify({ ...frame, type: "program_card_data" }));
  }

  let cardRequestsShown = 0;
  function presentCardRequestDecision(request     ) {
    if (!demandRouter || !server || server.getConnectedAppCount() === 0) return false;
    const sessionKey = request && request.surface ? request.surface.sessionKey : null;
    const onDecision = request && typeof request.onDecision === "function" ? request.onDecision : null;
    const accepted = demandRouter.presentDecision({
      ...request,
      onDecision: (decision     ) => {
        broadcastCardBuild(cardBuildPhases.approvalEnd({ sessionKey }), "approvalEnd");
        if (onDecision) return onDecision(decision);
      },
    });
    if (accepted === true || (!!accepted && typeof accepted === "object" && accepted.presented === true)) cardRequestsShown += 1;
    if (accepted) broadcastCardBuild(cardBuildPhases.approvalStart({ sessionKey }), "approvalStart");
    return accepted;
  }

  const programCardJev = createProgramCardJev({
    config: opts.programCardsJev || {},
    createClient: typeof opts.jevClientFactory === "function" ? opts.jevClientFactory : createJevClient,
    connection: jevConnection,
    store: createProgramCardJevStore({ libraryDir: opts.liveuiLibraryDir }),
    send: (frame     ) => {
      if (server && frame && typeof frame === "object") server.broadcast(JSON.stringify(frame));
    },
    presentDecision: presentCardRequestDecision,
    sessionKey: () => sessionService.peekSessionKey() || null,
    noteActivity: () => noteJevActivity("send", { warm: false }),
    emitLifecycle: (event     , level     , data     ) => {
      emitDebug("glasses.lifecycle", event, level || "debug", {}, () => ({ ...(data || {}) }));
    },
  });
  glassesPresenceChangedChannel.on((msg     ) => programCardJev.setPresence(msg && msg.presence));

  const programCardHostCommands = createProgramCardHostCommands({
    enabled: !!opts.programCardsMcp && opts.programCardsMcp.hostCommands !== false,
    libraryDir: opts.liveuiLibraryDir,
    env: () => ((globalThis       ).process || {}).env || {},
    uid: typeof (globalThis       ).process?.getuid === "function" ? (globalThis       ).process.getuid() : null,
    presentDecision: presentCardRequestDecision,
    cancelDecision: (surfaceId        ) => demandRouter?.cancelDecision(surfaceId) === true,
    emitLifecycle: (event     , level     , data     ) => {
      emitDebug("glasses.lifecycle", event, level || "debug", {}, () => ({ ...(data || {}) }));
    },
  });
  const programCardMcp = createProgramCardMcp({
    config: opts.programCardsMcp || {},
    hostCommands: programCardHostCommands,
    host:
      gatewayBridge && gatewayBridge.kind === "hermes"
        ? createHermesProgramCardMcpHost((method        , params     ) => gatewayBridge.request(method, params))
        : opts.programCardMcpHost || null,
    store: createProgramCardMcpStore({ libraryDir: opts.liveuiLibraryDir }),
    writesStore: createProgramCardMcpWritesStore({ libraryDir: opts.liveuiLibraryDir }),

    sourceRev: createProgramCardSourceRev({ libraryDir: opts.liveuiLibraryDir }),

    writesCapable: () => hasConnectedClientCapability(PROGRAM_CARD_MCP_WRITES_CAPABILITY),
    send: (frame     ) => {
      if (server && frame && typeof frame === "object") server.broadcast(JSON.stringify(frame));
    },
    presentDecision: presentCardRequestDecision,
    cancelDecision: (surfaceId        ) => demandRouter?.cancelDecision(surfaceId) === true,
    sessionKey: () => sessionService.peekSessionKey() || null,
    emitLifecycle: (event     , level     , data     ) => {
      emitDebug("glasses.lifecycle", event, level || "debug", {}, () => ({ ...(data || {}) }));
    },
  });
  glassesPresenceChangedChannel.on((msg     ) => programCardMcp.setPresence(msg && msg.presence));
  const programCardModel = createProgramCardModel({
    config: opts.programCardsModel || {},
    canAccessCard: (clientId        , key        ) => !key.startsWith("app:") || privateCardAccess(clientId, key.slice(4)),
    resolveContext: ({ owner, sessionKey }     ) => {
      if (gatewayBridge?.kind !== 'hermes') return {};
      const identity = resolveInputPredictionIdentity({
        backendKind: 'hermes',
        clientSessionKey: owner ? server?.getClientSessionKey?.(owner) : sessionKey,
        getSessionAgentId: (short     , full     ) => sessionService.getSessionAgentId(short, full),
        getSessionProfileId: (short     , full     ) => (sessionService       ).getSessionProfileId?.(short, full),
        extractShortKey: (key     ) => (sessionService       ).extractShortKey?.(key) || key,
      });
      return identity.profileId && !(identity       ).unroutable ? { profileId: identity.profileId } : null;
    },
    host: gatewayBridge?.kind === "hermes"
      ? createHermesProgramCardModelHost((method        , params     ) => gatewayBridge.request(method, params))
      : opts.programCardModelHost,
    store: createProgramCardModelStore({ libraryDir: opts.liveuiLibraryDir }),
    send: (clientId        , frame     ) => {
      if (!server?.getAppClientIds?.().includes(clientId)) return false;
      server.unicast(clientId, JSON.stringify(frame));
      return true;
    },
    broadcast: (frame     ) => server?.broadcast(JSON.stringify(frame)),
    presentDecision: presentCardRequestDecision,
    sessionKey: () => sessionService.peekSessionKey() || null,
    emitLifecycle: (event     , level     , data     ) => emitDebug("glasses.lifecycle", event, level, {}, () => data),
  });
  glassesPresenceChangedChannel.on((msg     ) => programCardModel.setPresence(msg?.presence));

  const programCardAgentRefresh = createProgramCardAgentRefresh({
    store: createProgramCardAgentRefreshStore({ libraryDir: opts.liveuiLibraryDir }),
    presentDecision: presentCardRequestDecision,
    sessionKey: () => sessionService.peekSessionKey() || null,
    onChange: () => { if (programCardFeed) pushProgramCardBindings(); },
    emitLifecycle: (event     , level     , data     ) => emitDebug("glasses.lifecycle", event, level || "debug", {}, () => ({ ...(data || {}) })),
  });

  let cardSetupSaveSeq = 0;
  async function saveProgramCardSwitchOn(name        ) {
    const permission = name === "mcp" ? "program_cards_mcp" : name === "jev" ? "program_cards_jev" : name === "model" ? "program_cards_model" : null;
    if (!permission) return false;
    const stamp = `${Date.now().toString(36)}-${(++cardSetupSaveSeq).toString(36)}`;
    const context = { connectionId: `card-setup-${optionalSetupGeneration}-${stamp}` };
    const send = (request     ) => getActiveBackendKind() === "hermes"
      ? gatewayBridge.request("optional.setup", { request, context })
      : typeof opts.optionalSetup?.handle === "function" ? opts.optionalSetup.handle(request, context) : null;
    try {
      const preview      = await send({ requestId: `card-setup-preview-${stamp}`, operation: "diagnostics.preview", permission, allowed: true });
      const operationId = preview && preview.status === "ok" && preview.diagnostics ? preview.diagnostics.operationId : null;
      if (typeof operationId !== "string" || !operationId) return false;
      const applied      = await send({ requestId: `card-setup-apply-${stamp}`, operation: "diagnostics.apply", operationId });
      return !!applied && applied.status === "saved";
    } catch (_) {
      return false;
    }
  }
  const programCardSetupRequests = createProgramCardSetupRequests({
    store: createProgramCardSetupRequestsStore({ libraryDir: opts.liveuiLibraryDir }),
    presentDecision: presentCardRequestDecision,
    cancelDecision: (surfaceId        ) => demandRouter?.cancelDecision(surfaceId) === true,
    switches: () => ({ jev: programCardJev.state().enabled, mcp: programCardMcp.state().enabled, model: programCardModel.state().enabled }),
    saveSwitch: saveProgramCardSwitchOn,

    servers: async () => {
      try { await programCardMcp.refresh(); } catch (_) {  }
      return programCardMcp.state().servers || [];
    },
    allowServer: (server        ) => programCardMcp.allowServerForCards(server),
    requestsShown: () => cardRequestsShown,
    canShow: () => !!demandRouter && !!server && server.getConnectedAppCount() > 0,

    askUses: async ({ key, sessionKey }     ) => {
      const out      = {};
      for (const [part, engine] of [["mcp", programCardMcp], ["jev", programCardJev], ["model", programCardModel]]         ) {
        try {
          const answer = await engine.askAgainFor(key, sessionKey);
          if (answer) out[part] = answer;
        } catch (_) {  }
      }
      return out;
    },
    emitLifecycle: (event     , level     , data     ) => emitDebug("glasses.lifecycle", event, level || "debug", {}, () => ({ ...(data || {}) })),
  });

  const taskCheckAgain = createTaskCheckAgain({
    store: createTaskCheckAgainStore({ libraryDir: opts.liveuiLibraryDir }),
    onChange: () => { if (programCardFeed) pushProgramCardBindings(); },
  });

  function checkAgainAsks(clientId        , binding     ) {
    if (binding.schemaVersion === 2 && !taskPresentationClientOwns(clientId, binding)) return false;
    if (programCardFeed.bindingState(binding) !== "current") return false;
    return !taskCheckAgain.allowed(binding.taskId);
  }

  function withCheckAgainAsk(cardId        , result     ) {
    const parts = Array.isArray(result?.slots) ? result.slots : [result];
    const ask = taskCheckAgainAsk({
      cardName: programCardFeed.store.forCard(cardId)[0]?.cardName,
      parts,
      nameOf: (taskId        ) => {
        const task = resolveLiveuiGlassesLibraryController()?.readTaskForRun(taskId)?.task;
        return task?.versions?.approved?.name || task?.name;
      },
      sendsOf: (taskId        ) => taskCheckAgainSends(taskUsesStore.read(taskId)),
    });
    return ask ? { ...result, ask } : result;
  }

  function agentRefreshTaskName(sessionKey        , key        ) {
    const appId = typeof key === "string" && key.startsWith("app:") ? key.slice(4) : null;
    const taskId = appId ? programCardFeed?.store.forCard(appId)?.[0]?.taskId : null;
    const bound = taskId ? resolveLiveuiGlassesLibraryController()?.readTaskForRun(taskId)?.task?.name : null;
    if (typeof bound === "string" && bound.trim()) return bound;
    return cardBuildPhases.taskFor(sessionKey)?.name || null;
  }
  function considerProgramCardAgentRefresh(params      = {}) {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
    return programCardAgentRefresh.consider({ ...params, task: agentRefreshTaskName(sessionKey, params.key) });
  }

  const grantLiveSite = (host        ) => {
    const controller = resolveLiveuiGlassesLibraryController();
    return controller && typeof controller.grantLiveuiSite === "function"
      ? controller.grantLiveuiSite(host)
      : { ok: false, code: "item_unavailable" };
  };
  const programCardLocation = createProgramCardLocation({
    send: (clientId        , frame     ) => {
      if (!server?.getAppClientIds?.().includes(clientId)) return false;
      server.unicast(clientId, JSON.stringify(frame));
      return true;
    },
    presentDecision: presentCardRequestDecision,
    grantSite: grantLiveSite,

    siteListed: (host        ) => {
      const controller = resolveLiveuiGlassesLibraryController();
      const check = controller && typeof controller.liveuiHostCheck === "function" ? controller.liveuiHostCheck() : null;
      return typeof check === "function" ? check(host) === "listed" : null;
    },
    sessionKey: () => sessionService.peekSessionKey() || null,
    emitLifecycle: (event     , level     , data     ) => emitDebug("glasses.lifecycle", event, level || "debug", {}, () => ({ ...(data || {}) })),
  });

  const stopCardDeleteListener = onProgramCardDeleted(opts.liveuiLibraryDir, (appId        ) => {
    programCardAgentRefresh.remove(`app:${appId}`);

    try { cardPartRuns?.dropCard(appId); } catch (_) {  }
    const unbound = forgetDeletedProgramCard(appId, {
      jev: programCardJev, mcp: programCardMcp, model: programCardModel, feedStore: programCardFeed?.store,
    });

    if (!unbound.length) return pushProgramCardBindings();
    logger.info(`[program-card] card deleted card=${appId} unbound=${unbound.join(",")}`);

    const controller = resolveLiveuiGlassesLibraryController();
    for (const taskId of unbound) {
      taskCardLookUndo.restore(taskId, appId).catch(() => false).then(() => {
        if (controller && typeof controller.reconcileTaskSchedule === "function") return controller.reconcileTaskSchedule(taskId);
      }).catch(() => {});
    }
    pushProgramCardBindings();
  });

  const phoneSettingsRoundTrip = createPhoneSettingsRoundTrip({
    hasPhone: () => (server ? server.getConnectedAppCount() > 0 : false),
    broadcast: (frame     ) => { if (!server) throw new Error("relay not started"); server.broadcast(JSON.stringify(frame)); },
    getTimeoutMs: opts.phoneSettingsGetTimeoutMs,
    setTimeoutMs: opts.phoneSettingsSetTimeoutMs,
  });

  const botScreenShowRoundTrip = createBotScreenShowRoundTrip({
    hasPhone: () => (server ? server.getConnectedAppCount() > 0 : false),
    broadcast: (frame     ) => { if (!server) throw new Error("relay not started"); server.broadcast(JSON.stringify(frame)); },
    timeoutMs: opts.botScreenShowTimeoutMs,
  });

  function sendDeviceInfoRequest(params) {
    if (!server) return;
    const payload = {
      type: "device_info_request",
      sessionKey: params && typeof params.sessionKey === "string" ? params.sessionKey : null,
      requestId: params && typeof params.requestId === "string" ? params.requestId : "",
    };
    server.broadcast(JSON.stringify(payload));
  }

  function dispatchDeviceInfoResponse(frame) {
    if (!frame || typeof frame !== "object") return;
    deviceInfoResponseChannel.emit(() => ({
      requestId: typeof frame.requestId === "string" ? frame.requestId : "",
      ok: frame.ok === true,
      code: typeof frame.code === "string" ? frame.code : undefined,
      data: frame.data && typeof frame.data === "object" ? frame.data : undefined,
    }));
  }

  const locationResponseChannel = createEventChannel(logger, "location_response");
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
    locationResponseChannel.emit(() => ({
      requestId,
      ok: frame.ok === true,
      code: typeof frame.code === "string" ? frame.code : undefined,
      data: frame.data && typeof frame.data === "object" ? frame.data : undefined,
    }));
  }

  const programCardResponseChannel = createEventChannel(logger, "program_card_response");
  const pendingProgramCardRequestTargets = new Map();

  function prunePendingProgramCardRequestTargets(nowMs = Date.now()) {
    for (const [requestId, pending] of pendingProgramCardRequestTargets) {
      if (!pending || !Number.isFinite(pending.expiresAtMs) || pending.expiresAtMs <= nowMs) {
        pendingProgramCardRequestTargets.delete(requestId);
      }
    }
  }

  function resolveProgramCardRequestTarget(sessionKey     , capability = PROGRAM_CARD_CAPABILITY, requireSession = false) {
    if (!server || typeof server.getReadinessSnapshot !== "function") {
      return { ok: false, code: "no_downstream_client" };
    }
    const snapshot = server.getReadinessSnapshot();
    const clients = snapshot && Array.isArray(snapshot.clients) ? snapshot.clients : [];
    const capable = clients.filter(
      (entry     ) =>
        entry &&
        typeof entry.clientId === "string" &&
        entry.clientId &&
        Array.isArray(entry.clientCapabilities) &&
        entry.clientCapabilities.includes(capability),
    );
    if (capable.length === 0) {
      return { ok: false, code: clients.length === 0 ? "no_downstream_client" : "no_capable_app_client" };
    }
    const matching = capable.filter((entry     ) => locationSessionMatchesRequest(entry, sessionKey));
    if (requireSession && matching.length === 0) return { ok: false, code: "unsupported" };
    const pool = matching.length > 0 ? matching : capable;
    let target = pool[0];
    for (const entry of pool) {
      const at = Number.isFinite(entry.connectedAtMs) ? entry.connectedAtMs : 0;
      const best = Number.isFinite(target.connectedAtMs) ? target.connectedAtMs : 0;
      if (at > best) target = entry;
    }
    return { ok: true, clientId: target.clientId };
  }

  function sendProgramCardRequest(params     ) {
    prunePendingProgramCardRequestTargets();
    const requestId = params && typeof params.requestId === "string" ? params.requestId : "";
    const sessionKey = params && typeof params.sessionKey === "string" ? params.sessionKey : null;
    const liveCapture = (params?.op === "look" && params?.payload?.live === true) || (params?.op === "command" && params?.payload?.capture === true);
    const driveLook = params?.op === "look" && (params?.payload?.drive === true ||
      typeof params?.payload?.copyId === "string" || params?.payload?.stop === true);
    const isDraft = typeof params?.op === "string" && params.op.startsWith("draft_");
    const strict = isDraft ? resolveDraftContext(sessionKey, params.clientId) : null;
    const target = isDraft
      ? (strict?.clientId && draftBindingCurrent(strict) ? { ok: true, clientId: strict.clientId } : { ok: false, code: "no_draft_client" })
      : resolveProgramCardRequestTarget(sessionKey, liveCapture ? PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY
        : driveLook ? PROGRAM_CARD_LOOK_DRIVE_CAPABILITY
        : params?.op === "look" ? PROGRAM_CARD_LOOK_CAPABILITY
        : params?.op === "frame_draw" ? PROGRAM_CARD_FRAME_DRAW_CAPABILITY : PROGRAM_CARD_CAPABILITY, liveCapture || driveLook);
    if (!target.ok) {
      emitDebug(
        "relay.session",
        "program_card_request_target_error",
        "warn",
        { sessionKey: sessionKey || undefined },
        () => ({ requestId, sessionKey, code: target.code }),
      );
      const err      = new Error(`program card request target unavailable: ${target.code}`);
      err.code = target.code;
      throw err;
    }
    const payload = {
      type: "program_card_request",
      sessionKey: relaySessionKeyFor(sessionKey),
      requestId,
      title: params && typeof params.title === "string" ? params.title : "",
      source: params && typeof params.source === "string" ? params.source : "",
      why: params && typeof params.why === "string" ? params.why : "",

      ...(params && PROGRAM_CARD_REQUEST_OPS.has(params.op)
        ? { op: params.op, payload: { ...(params.payload && typeof params.payload === "object" ? params.payload : {}), ...(isDraft ? { ownerSession: server.getClientSessionKey(target.clientId) } : {}) } }
        : {}),
    };
    if (requestId) {
      pendingProgramCardRequestTargets.set(requestId, {
        targetClientId: target.clientId,
        sessionKey,
        op: params && PROGRAM_CARD_REQUEST_OPS.has(params.op) ? params.op : "write",

        lookResultExpected: params?.op === "look" && params?.payload?.live !== true && params?.payload?.stop !== true,

        largeResult: params?.op === "look" || params?.op === "frame_draw" || liveCapture,

        expiresAtMs: Date.now() + PROGRAM_CARD_REQUEST_TARGET_TTL_MS +
          (params?.op === "look" && Array.isArray(params.payload?.cases) ? PROGRAM_CARD_LOOK_CASES_HOST_MS : 0) +

          (params?.op === "look" && params.payload?.gameLiveS !== undefined ? PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS : 0),

        ...(params?.op === "draft_launch" && typeof params.payload?.draftId === "string" ? { draftId: params.payload.draftId } : {}),
      });
    }
    emitDebug(
      "relay.session",
      "program_card_request_unicast",
      "debug",
      { sessionKey: sessionKey || undefined },
      () => ({
        requestId,
        sessionKey,
        targetClientId: target.clientId,
        sourceLength: payload.source.length,
      }),
    );
    if (params?.op === "command") broadcastCardBuild(cardBuildPhases.commandStart({ sessionKey, label: params.commandLabel, cardOpen: params.cardKnownOpen }), "command");

    if (params?.op === "edit" || params?.op === "draft_prepare") {

      broadcastCardBuild(cardBuildPhases.cardRequest({ sessionKey, op: params.op, agent: params.agentEdit === true }), `request:${params.op}`);

    }
    if (params?.op === "look" && params.payload?.stop !== true && params.payload?.live !== true) {
      broadcastCardBuild(cardBuildPhases.lookStart({ sessionKey }), "lookStart");

      if (typeof params.payload?.copyId !== "string") {
        try { cardStudio.noteLookStart({ sessionKey, start: params.payload?.start }); } catch {  }
      }
    }

    if (params?.op === "look" || params?.op === "edit") {
      broadcastCardBuild(cardBuildPhases.lookTests({ sessionKey, requirements: params.payload?.requirements, verdicts: params.payload?.verdicts }), `tests:${params.op}`);
    }
    server.unicast(target.clientId, JSON.stringify(payload));
  }

  const programCardFrameChangedChannel = createEventChannel(logger, "program card frame change");

  const programCardPlayScreenChannel = createEventChannel(logger, "program card play screen");

  function dispatchProgramCardResponse(frame     ) {
    if (!frame || typeof frame !== "object") return;
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    const clientId = typeof frame.clientId === "string" ? frame.clientId : null;
    const pending = requestId ? pendingProgramCardRequestTargets.get(requestId) : null;
    let reason = null;
    if (!pending || pending.completed) reason = "no_pending_request";
    else if (pending.expiresAtMs <= Date.now()) reason = "expired";
    else if (!clientId || clientId !== pending.targetClientId) reason = "wrong_client";
    else if (pending.sessionKey && !appSessionKeysMatch(frame.sessionKey, pending.sessionKey)) {
      reason = "wrong_session";
    }
    if (reason) {
      emitDebug(
        "relay.session",
        "program_card_response_ignored",
        "warn",
        { sessionKey: (pending && pending.sessionKey) || undefined },
        () => ({
          requestId,
          reason,
          clientId,
          targetClientId: pending ? pending.targetClientId : null,
        }),
      );
      if (reason === "expired") pendingProgramCardRequestTargets.delete(requestId);
      return;
    }
    if (pending.lookResultExpected) pending.completed = true;
    else pendingProgramCardRequestTargets.delete(requestId);
    const resultFits = pending.op?.startsWith("draft_") ? programCardDraftResultFits(frame.result)
      : programCardResultFits(frame.result, pending.largeResult ? PROGRAM_CARD_LOOK_RESULT_MAX_BYTES : PROGRAM_CARD_RESULT_MAX_CHARS, pending.largeResult);
    const oversizedLook = pending.largeResult && frame.result && !resultFits;

    const withoutState = !resultFits && !pending.largeResult && !pending.op?.startsWith("draft_")
      ? programCardResultWithoutState(frame.result) : null;
    const outcome = {
      requestId,
      clientId,
      sessionKey: pending.sessionKey,
      ok: frame.ok === true && !oversizedLook,
      shown: frame.shown === true,
      error:
        oversizedLook ? "look_payload_too_large" : typeof frame.error === "string" && frame.error
          ? frame.error.slice(0, PROGRAM_CARD_ERROR_MAX_CHARS)
          : null,
      ...(resultFits ? { result: frame.result } : withoutState ? { result: withoutState } : {}),

      ...(programCardResultFits(frame.jev) ? { jev: frame.jev } : {}),

      ...(programCardResultFits(frame.mcp) ? { mcp: frame.mcp } : {}),
      ...(programCardResultFits(frame.model) ? { model: frame.model } : {}),

      ...(programCardResultFits(frame.refresh) ? { refresh: frame.refresh } : {}),
    };
    emitDebug(
      "relay.session",
      "program_card_response_dispatch",
      outcome.ok ? "debug" : "warn",
      { sessionKey: pending.sessionKey || undefined },
      () => pending.op?.startsWith("draft_") ? { requestId, ok: outcome.ok, shown: outcome.shown, clientId }
        : pending.largeResult
        ? { requestId, sessionKey: pending.sessionKey, ok: outcome.ok, error: outcome.error, clientId,
          steps: outcome.result?.report?.steps?.length ?? 0, captureStatus: outcome.result?.capture?.status ?? null }
        : ({ ...outcome, clientId }),
    );
    broadcastCardBuild(cardBuildPhases.cardResponse({ sessionKey: pending.sessionKey, op: pending.op, ok: outcome.ok, draftId: pending.draftId }), `response:${pending.op}`);
    cardDrafts?.onResponse(outcome);
    programCardResponseChannel.emit(() => ({ ...outcome }));
  }

  function dispatchProgramCardLookProgress(frame     ) {
    const requestId = typeof frame?.requestId === "string" ? frame.requestId : "";
    const pending = pendingProgramCardRequestTargets.get(requestId);
    if (!pending || pending.completed || pending.op !== "look" || pending.expiresAtMs <= Date.now() ||
      frame.clientId !== pending.targetClientId || !appSessionKeysMatch(frame.sessionKey, pending.sessionKey)) return;

    if (frame.frameLayout && typeof frame.frameLayout === "object" && !Array.isArray(frame.frameLayout)) {
      emitDebug("relay.session", "program_card_play_screen", "debug", { sessionKey: pending.sessionKey }, () => ({ requestId }));
      programCardPlayScreenChannel.emit(() => ({ requestId, sessionKey: pending.sessionKey, frameLayout: frame.frameLayout }));
    }
    const detail = typeof frame.detail === "string" ? frame.detail.replace(/[\r\n\t]+/g, " ").trim().slice(0, 100) : "";
    if (!detail) return;
    broadcastCardBuild(cardBuildPhases.lookProgress({ sessionKey: pending.sessionKey, detail }), "lookProgress");
  }

  function sendProgramCardLookResult(params     ) {
    const pending = pendingProgramCardRequestTargets.get(params?.requestId);
    if (!pending || !pending.completed || !pending.lookResultExpected || pending.expiresAtMs <= Date.now() ||
      !appSessionKeysMatch(params.sessionKey, pending.sessionKey)) return false;
    if (pending.receiptSent && (params.metadataOnly !== true || typeof pending.receiptDigest !== "string" ||
      params.cardId !== pending.receiptCardId || params.report?.digest !== pending.receiptDigest || params.report?.planHash !== pending.receiptPlanHash)) return false;
    const { verdictsOnly, ...result } = params;
    const payload = { ...result, type: "ocuclaw.program_card.look.result", sessionKey: relaySessionKeyFor(pending.sessionKey) };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > PROGRAM_CARD_LOOK_RESULT_MAX_BYTES) return false;
    pending.receiptSent = true;
    pending.receiptCardId = params.cardId;
    pending.receiptDigest = params.report?.digest;
    pending.receiptPlanHash = params.report?.planHash;

    pending.expiresAtMs = Date.now() + 10 * 60_000;
    server.unicast(pending.targetClientId, JSON.stringify(payload));

    broadcastCardBuild(cardBuildPhases.lookTests({ sessionKey: pending.sessionKey, tests: params.tests, looks: params.looks }), "tests:result");

    if (params.hardCases?.check) broadcastCardBuild(cardBuildPhases.lookCheck({ sessionKey: pending.sessionKey, check: params.hardCases.check }), "check:result");
    if (params.hardCases?.check) taskFixChecked(pending.sessionKey, params.hardCases);

    if (verdictsOnly === true) broadcastCardBuild(cardBuildPhases.checked({ sessionKey: pending.sessionKey }), "checked");
    return true;
  }

  function clearProgramCardLookResults(sessionKey         ) {
    for (const [requestId, pending] of pendingProgramCardRequestTargets) {
      if (pending.completed && pending.lookResultExpected && (sessionKey === undefined || appSessionKeysMatch(sessionKey, pending.sessionKey))) pendingProgramCardRequestTargets.delete(requestId);
    }
  }

  function programCardResultFits(result, cap = PROGRAM_CARD_RESULT_MAX_CHARS, byteLimit = false) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    try {
      const serialized = JSON.stringify(result);
      return (byteLimit ? new TextEncoder().encode(serialized).byteLength : serialized.length) <= cap;
    } catch (_) {
      return false;
    }
  }

  function programCardResultWithoutState(result         )                                 {
    if (!result || typeof result !== "object" || Array.isArray(result) || !("state" in result)) return null;
    const { state, ...rest } = result;
    let stateBytes = null;
    try { stateBytes = new TextEncoder().encode(JSON.stringify(state) ?? "").byteLength; } catch (_) {  }
    const trimmed = { ...rest, stateOmitted: true, ...(stateBytes === null ? {} : { stateBytes }) };
    return programCardResultFits(trimmed) ? trimmed : null;
  }

  const programCardContextChannel = createEventChannel(logger, "program_card_context");

  const openCardKeys = new Map                ();

  function isCardWorkTurn(sessionKey        , params      = null) {
    if (params && (params.taskBuild || params.cardChange || params.cardCheck)) return true;
    return typeof sessionKey === "string" && !!sessionKey && openCardKeys.has(relayKeyOf(sessionKey));
  }

  function dispatchProgramCardContext(frame) {
    if (!frame || typeof frame.sessionKey !== "string" || !frame.sessionKey) return;
    const card = frame.card && typeof frame.card === "object" && !Array.isArray(frame.card) ? frame.card : { open: false };
    emitDebug(
      "relay.session",
      "program_card_context",
      "debug",
      { sessionKey: frame.sessionKey },
      () => ({ clientId: frame.clientId || null, open: card.open === true, sourceLength: typeof card.source === "string" ? card.source.length : 0 }),
    );

    try { cardStudio.noteContext({ sessionKey: frame.sessionKey, card }); } catch {  }

    const openAt = relayKeyOf(frame.sessionKey);
    openCardKeys.delete(openAt);
    if (card.open === true && typeof card.key === "string") openCardKeys.set(openAt, card.key);
    while (openCardKeys.size > 64) openCardKeys.delete(openCardKeys.keys().next().value          );

    noteOpenProgramCard(frame.sessionKey, card.open === true ? card.cardId : null, card.open === true ? card.source : null,
      globalThis, frame.clientId, card.writeRequestId);

    if (card.open === true && typeof card.key === "string" && typeof card.from === "string" &&
        card.key.startsWith("app:") && privateCardAccess(frame.clientId || "", card.key.slice(4))) {
      programCardAgentRefresh.carry(card.from, card.key);
    }
    programCardContextChannel.emit(() => ({ sessionKey: frame.sessionKey, card }));
  }

  function programCardDraftResultFits(result     ) {
    try { return !!result && typeof result === "object" && JSON.stringify(result).length <= 512 * 1024; }
    catch { return false; }
  }
  function draftOwner(sessionKey        ) {
    if (!opts.stateDir || typeof sessionKey !== "string" || !sessionKey.trim()) return null;
    const key = sessionKey.trim();
    if (relayBackendKind === "hermes") {
      const parsed = parseHermesPublicKey(key);
      if (!parsed) return null;
      return { installation: path.resolve(opts.stateDir), backend: "hermes", profile: parsed.namespace,
        agent: parsed.namespace, conversation: key };
    }
    const match = /^agent:([^:]+):(.+)$/i.exec(key);
    const conversation = match ? match[2] : key;
    const agent = match?.[1] || sessionService.getSessionAgentId(conversation, key) || "main";
    return { installation: path.resolve(opts.stateDir), backend: "openclaw", profile: path.resolve(opts.stateDir), agent, conversation };
  }
  function resolveDraftContext(sessionKey        , requestedClient         ) {
    const owner = draftOwner(sessionKey);
    if (!owner) return null;
    const ownerKey = JSON.stringify(owner);
    const candidates = (server?.getReadinessSnapshot()?.clients || []).filter((client     ) => {
      if (requestedClient && client.clientId !== requestedClient) return false;
      if (!client.clientCapabilities?.includes(PROGRAM_CARD_DRAFT_CAPABILITY)) return false;
      const clientKey = server.getClientSessionKey(client.clientId);
      const candidateOwner = clientKey && draftOwner(clientKey);
      return candidateOwner && JSON.stringify(candidateOwner) === ownerKey;
    }).sort((a     , b     ) => (b.connectedAtMs || 0) - (a.connectedAtMs || 0));
    return { owner, ownerKey, sessionKey, clientId: candidates[0]?.clientId || "" };
  }
  function draftBindingCurrent(binding     ) {
    if (!binding.clientId) return false;
    const current = resolveDraftContext(binding.sessionKey, binding.clientId);
    return current?.ownerKey === binding.ownerKey && current?.clientId === binding.clientId;
  }

  function taskPresentationOwnerScope(owner     ) {
    if (!owner) return null;
    const { installation, backend, profile, agent } = owner;
    return liveuiLibraryDigest({ installation, backend, profile, agent });
  }
  function taskPresentationClientOwns(clientId        , binding     ) {
    const sessionKey = server?.getClientSessionKey(clientId);

    const client = server?.getReadinessSnapshot()?.clients?.find((entry     ) => entry.clientId === clientId);
    return !!client?.clientCapabilities?.includes("taskPresentationsV1") && !!sessionKey &&
      taskPresentationOwnerScope(draftOwner(sessionKey)) === binding.ownerScope;
  }

  function savedCardReadable(appId        , sessionKey        ) {
    const ownerScope = programCardFeed?.store.ownerScope(appId);
    return !ownerScope || taskPresentationOwnerScope(draftOwner(sessionKey)) === ownerScope;
  }

  async function settleCardLocationAsk() {
    const L = PROGRAM_CARD_LOCATION_SETTLE;
    const startedAt = Date.now();
    const sleep = (ms        ) => new Promise((resolve) => setTimeout(resolve, ms));
    const asking = () => { try { return programCardLocation.asking() === true; } catch (_) { return false; } };
    while (!asking() && Date.now() - startedAt < L.arriveMs) await sleep(L.pollMs);
    if (!asking()) return { asked: false, ms: Date.now() - startedAt };
    const askedAt = Date.now();
    while (asking() && Date.now() - askedAt < L.answerMs) await sleep(L.pollMs);
    await sleep(L.returnMs);
    return { asked: true, ms: Date.now() - startedAt };
  }

  function programCardHealthRows(key     , sessionKey      = "", declared      = null) {
    if (typeof key === "string" && key.startsWith("app:") && !savedCardReadable(key.slice(4), sessionKey)) return [];
    const parts        = [];
    for (const [part, engine] of [["mcp", programCardMcp], ["jev", programCardJev], ["model", programCardModel]]         ) {
      try { parts.push(...engine.health(key, declared?.[part] ?? null)); } catch (_) {  }
    }

    try { parts.push(...programCardLocation.health(key)); } catch (_) {  }
    return parts;
  }

  function savedCardNamedParts(appId        )           {
    try {
      const saved      = programCardSaves.source({ appId });
      const source = saved?.status === "accepted" && saved.card?.kind === "source" ? saved.card.source : null;
      return typeof source === "string" ? programCardNamedParts(source) : [];
    } catch (_) {
      return [];
    }
  }

  function savedCardHealth(appId        ) {
    const key = `app:${appId}`;
    const parts        = [];
    const notRead           = [];
    const noRecord           = [];
    const judged           = [];
    const hostWide        = [];
    let named                      ;
    for (const [part, engine] of [["mcp", programCardMcp], ["jev", programCardJev], ["model", programCardModel]]         ) {
      try {
        const judges = typeof (engine       ).healthJudges === "function" ? (engine       ).healthJudges(key) : "yes";
        if (judges === "no_record") {
          if (named === undefined) named = savedCardNamedParts(appId);
          if (!named.includes(part)) continue;
          noRecord.push(part);
          let reason = "";
          try { reason = typeof (engine       ).hostHealth === "function" ? (engine       ).hostHealth() : ""; } catch (_) { reason = ""; }
          if (typeof reason === "string" && reason) hostWide.push({ part, use: "", reason });
          continue;
        }
        if (judges === "not_ready") {
          notRead.push(part);

          try { engine.health(key, null); } catch (_) {  }
          continue;
        }
        parts.push(...engine.health(key, null));
        judged.push(part);
      } catch (_) {
        notRead.push(part);
      }
    }

    try { parts.push(...programCardLocation.health(key)); } catch (_) {  }
    return { parts, judged, ...(notRead.length ? { notRead } : {}), ...(noRecord.length ? { noRecord } : {}), ...(hostWide.length ? { hostWide } : {}) };
  }

  async function readTaskRunRows() {
    const read = typeof opts.onGetTaskRows === "function" ? opts.onGetTaskRows
      : openClawTaskSchedulesOn() ? () => openClawTaskRows.read() : null;
    if (!read) return null;
    const rows = await read();
    if (taskRowsMissJobs(rows)) throw new Error("task rows read without the host's jobs");

    if (!Array.isArray(rows)) throw new Error("task rows read answered no list");
    return rows;
  }
  function privateCardAccess(clientId        , appId        ) {
    if (!appId) return true;
    const ownerScope = programCardFeed?.store.ownerScope(appId);
    return !ownerScope || taskPresentationClientOwns(clientId, { ownerScope });
  }
  const draftApprovalClients = new Map             ();
  const cardDrafts = opts.stateDir ? createProgramCardDraftService({
    stateDir: opts.stateDir, resolveContext: resolveDraftContext, isCurrent: draftBindingCurrent,

    kitLevel: () => programCardKitLevel(),
    clientKitLevel: (clientId     ) => clientKitLevel(clientId),

    taskContext: (sessionKey        , clientId        ) => taskCardDraftContext(sessionKey, clientId),
    canAccessSaved: (binding     , appId        ) => privateCardAccess(binding.clientId, appId),
    promoteOnce: (params     ) => {

      const owner = params.base?.appId && programCardFeed?.store.ownerScope(params.base.appId);
      if (owner && programCardFeed.store.claimCard(params.appId, owner).status !== "accepted")
        return { status: "rejected", code: "presentation_owner_changed" };
      return programCardSaves.promoteDraft(params);
    },
    loadSaved: (appId        ) => programCardSaves.load(appId),

    savedSource: (appId        ) => programCardSaves.source({ appId }),

    savedKit: (appId        , revision        ) => programCardSaves.revisionKit(appId, revision),
    promoteSaved: (params     , taskSlots     , saveOptions      = null) => programCardSaves.promoteSavedDraft(params, taskSlots, saveOptions),
    recoveredSave: (appId        , draftId        ) => programCardSaves.recoveredDraftResult(appId, draftId),
    send: sendProgramCardRequest,
    onShown: async (binding     , result     ) => {
      const grants      = {};
      if (result.jev) grants.jev = (await programCardJev.consider({ sessionKey: binding.sessionKey, ...result.jev, cause: "draft_launch" })).answer;
      if (result.mcp) grants.mcp = (await programCardMcp.consider({ sessionKey: binding.sessionKey, ...result.mcp, cause: "draft_launch" })).answer;
      if (result.model) grants.model = (await programCardModel.consider({ sessionKey: binding.sessionKey, ...result.model, cause: "draft_launch" })).answer;

      if (result.refresh) {
        grants.agentRefresh = (await considerProgramCardAgentRefresh({ sessionKey: binding.sessionKey, ...result.refresh, cause: "draft_launch" })).answer;
        grants.refresh = undefined;
      }
      return grants;
    },
    approve: (binding     , draft     , requestKey        ) => new Promise(resolve => {
      if (!draftBindingCurrent(binding)) return resolve({ answer: "cancel" });
      draftApprovalClients.set(requestKey, binding);
      const accepted = demandRouter.presentDecision({
        surface: { surfaceId: requestKey, sessionKey: relaySessionKeyFor(binding.sessionKey) || binding.sessionKey,
          clientId: binding.clientId, kind: "question", title: "Launch draft?",
          question: `Open “${draft.title}” (revision ${draft.revision}) on your glasses?`,
          options: [{ key: "yes", label: "Yes, launch" }, { key: "no", label: "Not now" }], deadlineSec: 60 },
        expiresAtMs: Date.now() + 60000,
        onDecision: ({ choice }     ) => { draftApprovalClients.delete(requestKey); resolve({ answer: choice }); },
      });
      if (!accepted) { draftApprovalClients.delete(requestKey); resolve({ answer: "cancel" }); }
    }),
    cancelApproval: (requestKey        ) => demandRouter?.cancelDecision(requestKey),
  }) : null;

  const cardChanges = cardDrafts ? createCardChanges({
    list: () => programCardSaves.list(),
    load: (appId        ) => programCardSaves.load(appId),
    openSaved: (sessionKey        , appId        , opts      ) => cardDrafts.openSaved(sessionKey, appId, opts),
    openWhy: (sessionKey        , error         ) => cardOpenWhy(sessionKey, error),
    promoteChange: (sessionKey        , draftId        , change     ) => cardDrafts.promoteChange(sessionKey, draftId, change),

    draftOpen: async (sessionKey        , draftId        ) => {
      const got      = await cardDrafts.run(sessionKey, { action: "get", draftId });
      if (got?.ok === true) return got.status === "draft";
      return got?.error !== "not_found";
    },
    onSaved: (appId        , saved     ) => {
      broadcastCardRevisionChanged(appId);
      broadcastCardChangeSaved(appId, saved);

      followCardRevision(appId, "change");
    },
    keyOf: (sessionKey        ) => relaySessionKeyFor(sessionKey) || sessionKey,
  }) : null;

  function broadcastCardChangeSaved(appId        , saved     ) {
    if (!server || typeof saved?.draftId !== "string" || !Number.isSafeInteger(saved.revision)) return;
    const source      = programCardSaves.source({ appId });
    server.broadcast(JSON.stringify({
      type: PROGRAM_CARD_CHANGE_SAVED_TYPE,
      appId,
      draftId: saved.draftId,
      revision: saved.revision,
      ...(typeof saved.name === "string" ? { name: saved.name } : {}),
      ...(source?.status === "accepted" && typeof source.sourceHash === "string" ? { sourceHash: source.sourceHash } : {}),
    }));
  }

  function saveCardChangeAtDone(done     )                                                                                                {
    if (!cardChanges) return null;

    let before      = null;
    try { before = cardChanges.of(done.sessionKey); } catch { before = null; }

    if (before?.ended) return null;
    let result      = null;
    try {
      result = cardChanges.doneAt(done.sessionKey, done);
    } catch {
      result = { status: "rejected", code: "save_failed" };
    }
    if (!result) {
      const open = before;
      if (!open || open.saved) return null;

      const untouched = !open.tested && !open.round;
      const code = done.by === "stopped" ? "stopped"
        : untouched ? (runErrored(done.runId) ? "agent_failed" : "no_edit")
        : !open.tested ? "not_tested" : "not_saved";
      result = { status: "kept", appId: open.appId, code };
    }

    if (result.status !== "saved") { try { cardChanges.setAside(done.sessionKey); } catch {  } }
    const changeSaved = () => ({ by: done.by, status: result.status ?? null, revision: result.revision ?? null, code: result.code ?? null });
    noteCardStudioTrace("relay.session", "program_card_change_saved", "debug", { sessionKey: done.sessionKey }, changeSaved);
    emitDebug("relay.session", "program_card_change_saved", "debug", { sessionKey: done.sessionKey, runId: done.runId }, changeSaved);
    logger.info(`[program-card] change at done by=${done.by} card=${result.appId ?? "?"} ${result.status === "saved" ? `revision=${result.revision}` : `${result.status}=${result.code}`}`);
    const appId = typeof result.appId === "string" ? result.appId : before?.appId;
    return { status: result.status, ...(typeof result.code === "string" ? { code: result.code } : {}),
      ...(Number.isSafeInteger(result.revision) ? { revision: result.revision } : {}),
      ...(typeof appId === "string" ? { appId } : {}),

      ...(result.status !== "saved" && typeof before?.draftId === "string" ? { draftId: before.draftId } : {}) };
  }

  const wearerWords = new Map                                      ();
  const WEARER_WORDS_MS = 10 * 60_000;
  function noteWearerWords(sessionKey        , text     ) {
    const key = relaySessionKeyFor(sessionKey) || sessionKey;
    if (!key || typeof text !== "string" || !text.trim()) return;
    wearerWords.delete(key);
    wearerWords.set(key, { text: text.trim().slice(0, 1000), at: Date.now() });
    while (wearerWords.size > 64) wearerWords.delete(wearerWords.keys().next().value          );
  }
  function lastWearerWords(sessionKey        ) {
    const kept = wearerWords.get(relaySessionKeyFor(sessionKey) || sessionKey);
    return kept && Date.now() - kept.at <= WEARER_WORDS_MS ? kept.text : "";
  }

  const cardCheckAsks = new Map                                                                                              ();
  const CARD_CHECK_ASK_MS = 60_000;

  function noteCardCheckAsk(sessionKey        , ask     , text     , id     ) {
    const key = relaySessionKeyFor(sessionKey) || sessionKey;
    if (!key) return;
    cardCheckAsks.delete(key);
    if (!ask || typeof ask.appId !== "string") return;
    cardCheckAsks.set(key, { appId: ask.appId, id: typeof id === "string" ? id : "", at: Date.now(),
      text: typeof text === "string" ? text.trim() : "", taken: false, run: "" });
    while (cardCheckAsks.size > 64) cardCheckAsks.delete(cardCheckAsks.keys().next().value          );
  }

  function dropCardCheckAsk(sessionKey     , id      ) {
    const key = typeof sessionKey === "string" ? relaySessionKeyFor(sessionKey) || sessionKey : "";
    if (!key) return;
    if (typeof id === "string" && cardCheckAsks.get(key)?.id !== id) return;
    cardCheckAsks.delete(key);
  }

  function cardCheckAskOf(sessionKey        , turn      = {})                                         {
    const key = relaySessionKeyFor(sessionKey) || sessionKey;
    const kept = key ? cardCheckAsks.get(key) : null;
    if (!kept) return null;
    const now = Date.now();
    if (now - kept.at > CARD_CHECK_ASK_MS) { cardCheckAsks.delete(key); return null; }
    const ownerScope = programCardFeed?.store.ownerScope(kept.appId);
    if (ownerScope && taskPresentationOwnerScope(draftOwner(sessionKey)) !== ownerScope) return null;
    const run = turn && typeof turn.run === "string" ? turn.run.trim() : "";
    if (kept.taken) {

      if (!run || run !== kept.run) { cardCheckAsks.delete(key); return null; }
    } else {

      if (turn && turn.viewer === true) return null;

      if (turn && typeof turn.ticket === "string" && !(kept.id && turn.ticket === kept.id)) return null;

      const texts = (turn && Array.isArray(turn.texts) ? turn.texts : []).filter((t     ) => typeof t === "string").map((t        ) => t.trim());
      if (texts.length > 0 && !(kept.text && texts.some((t        ) => t.includes(kept.text)))) return null;
      kept.taken = true;
      kept.run = run;
    }
    kept.at = now;
    let loaded      = null;
    try { loaded = programCardSaves.load(kept.appId); } catch { loaded = null; }
    if (!loaded || loaded.status !== "accepted" || !loaded.record) return null;
    return { appId: kept.appId, name: typeof loaded.record.name === "string" ? loaded.record.name : "" };
  }

  function draftPhoneFacts(sessionKey        ) {
    return {
      connected: server ? server.getConnectedAppCount() > 0 : null,
      cards: connectedAppClientHas(PROGRAM_CARD_CAPABILITY),
      lacksCall: !connectedAppClientHas(PROGRAM_CARD_DRAFT_CAPABILITY),
      here: !!resolveDraftContext(sessionKey)?.clientId,
    };
  }

  function cardOpenWhy(sessionKey        , error         )         {
    try { return composeCardOpenWhy(error, draftPhoneFacts(sessionKey)); } catch { return ""; }
  }

  const NO_DRAFT_SERVICE_OPEN = Object.freeze({ ok: false, error: PROGRAM_CARD_NO_DRAFT_SERVICE });

  async function openCardChangeForSend(sessionKey        , appId        , words        , again = false) {
    if (!cardChanges) return null;
    let handOff      = null;

    const going      = cardChanges.of(sessionKey);
    const fresh = going?.ended === true && going.appId === appId && openCardKeys.get(relayKeyOf(sessionKey)) === `app:${appId}`;
    try {
      handOff = await cardChanges.ask(sessionKey, { appId, words, approved: true, ...(again ? { again: true } : {}),
        ...(fresh ? { fresh: true, carry: true } : {}) });
    } catch {
      handOff = null;
    }
    if (!handOff || handOff.refused) {
      logger.warn(`[program-card] change box not opened card=${appId} error=${handOff?.openError ?? "unavailable"}`);
      return handOff;
    }
    logger.info(`[program-card] change box card=${appId} draft=${handOff.draftId} kept=${handOff.kept === true} lines=${handOff.lines.length}`);

    if (!handOff.kept || !cardBuildPhases.current(sessionKey)) {

      const plan = again && Array.isArray(handOff.lines)
        ? handOff.lines.slice(0, Number.isSafeInteger(handOff.firstSaved) ? handOff.firstSaved - 1 : handOff.lines.length)
        : changeLinesOfWords(words);
      broadcastCardBuild(cardBuildPhases.changeOpened({ sessionKey, name: handOff.card, plan }), "change");

      const wait = setTimeout(() => {
        try {
          const ended = cardBuildPhases.releaseChange({ sessionKey });
          if (!ended.length) return;
          broadcastCardBuild(ended, "changeRunNeverStarted");

          broadcastCardBuild(cardBuildPhases.flushDone({ sessionKey }), "flushDone");
        } catch {  }
      }, CARD_BUILD_CHANGE_RUN_WAIT_MS + 1_000);
      if (typeof (wait       )?.unref === "function") (wait       ).unref();
    }
    return handOff;
  }

  async function openSpokenCardChange(sessionKey        , open     ) {
    const appId = typeof open?.appId === "string" ? open.appId : "";
    if (!cardChanges || !appId || !sessionHasCardStudio(sessionKey)) return null;

    const going      = cardChanges.of(sessionKey);
    if ((going?.saved === null && !going.ended) || cardBuildPhases.taskFor(sessionKey) || taskFixOfSession(sessionKey)) return null;
    let handOff      = null;
    try {
      handOff = await cardChanges.ask(sessionKey, { appId, words: lastWearerWords(sessionKey), approved: true,
        ...(open.state !== undefined ? { state: open.state } : {}),

        ...(going?.ended ? { fresh: true } : {}) });
    } catch {
      handOff = null;
    }
    if (!handOff || handOff.refused) {
      logger.warn(`[program-card] spoken change not opened card=${appId} error=${handOff?.openError ?? "unavailable"}`);
      return null;
    }
    logger.info(`[program-card] spoken change card=${appId} draft=${handOff.draftId} lines=${handOff.lines.length}`);
    return handOff;
  }

  const taskPresentations = cardDrafts ? createTaskPresentations({
    stateDir: opts.stateDir, drafts: cardDrafts, current: draftBindingCurrent,
    context: (clientId        ) => {
      const key = server?.getClientSessionKey(clientId);
      return key ? resolveDraftContext(key, clientId) : null;
    },
    taskExists: (taskId        ) => resolveLiveuiGlassesLibraryController()?.readTaskForRun(taskId)?.status === "accepted",
    revisionCandidate: (context     , taskId        ) => {
      const binding = programCardFeed?.store.read(taskId);
      const version = resolveLiveuiGlassesLibraryController()?.readTaskForRun(taskId)?.task?.versions?.approved;
      if (binding?.schemaVersion !== 2 || !version || !taskPresentationClientOwns(context.clientId, binding) ||
          binding.taskVersionId !== version.versionId || binding.requestDigest !== taskScheduleBinding(version).requestDigest)
        return { code: "presentation_owner_changed" };
      const source = programCardSaves.source({ appId: binding.cardId });
      if (source.status !== "accepted" || source.card?.kind !== "source") return { code: "presentation_unavailable" };
      return { target: { taskId, cardId: binding.cardId, previousDigest: binding.bindingDigest,
        taskVersionId: binding.taskVersionId, requestDigest: binding.requestDigest, revision: source.revision, sourceHash: source.sourceHash },
        candidate: { status: "ready", title: source.name.slice(0, 80), summary: "Review the saved card revision with the Task’s existing data. Applying it keeps the same Task, schedule and data fields.",
          look: "AGENT", request: version.request, sample: ["Saved Task data, or unavailable fields"], sampleAtMs: binding.last?.atMs || 0,
          presentation: { kind: "program", source: source.card.source, inputs: binding.inputs,
            sample: binding.last?.values || Object.fromEntries(binding.inputs.map((input     ) => [input.key, null])) } } };
    },
    revisionCurrent: (context     , target     ) => !!taskPresentationRevisionBinding(context, target),
    applyRevision: async (context     , target     ) => {
      const binding = taskPresentationRevisionBinding(context, target, true);
      if (!binding) return { status: "rejected", code: "presentation_revision_changed" };
      const result = programCardFeed.store.bind({ ...binding, revision: target.revision, sourceHash: target.sourceHash });
      if (result.status !== "accepted") return result;

      if (cardHasParts(programCardFeed.store, target.cardId)) {
        const source = programCardSaves.source({ appId: target.cardId });
        const table = source.status === "accepted" ? cardTaskSlots(source, null) : null;
        const pinned = repinCardParts(programCardFeed.store, target.cardId, target.revision, target.sourceHash, table, target.taskId);
        await reconcileRepinned(pinned.repinned);
      }
      const controller = resolveLiveuiGlassesLibraryController();
      const scheduled = controller.readTaskSchedule(target.taskId)?.schedule?.approved?.when;
      const synced = scheduled ? await controller.reconcileTaskSchedule(target.taskId) : { status: "accepted", state: "none" };
      pushProgramCardBindings();
      if (!synced || synced.status !== "accepted" || !["none", "active", "paused"].includes(synced.state))
        return { status: "rejected", code: "presentation_schedule_unsynced" };
      return { status: "saved", taskId: target.taskId };
    },
    bind: ({ taskId, version, presentation, savedCard, sourceHash, title, owner }     ) => {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) return { status: "rejected", code: "presentation_unavailable" };
      if (presentation.kind === "builtin") return { status: "accepted" };
      if (presentation.kind === "surface") {
        const templateId = `result-${taskId.slice("setup-".length)}`;
        const envelope = { schemaVersion: 2, templateId, name: title, body: { records: presentation.records }, inputs: presentation.inputs };
        const existing = controller.readTemplate(templateId);
        if (existing?.status === "accepted") {
          const stored = existing.envelope;
          return stored?.helperOf?.taskId === taskId && liveuiLibraryDigest(stored.body) === liveuiLibraryDigest(envelope.body) &&
            liveuiLibraryDigest(stored.inputs) === liveuiLibraryDigest(envelope.inputs)
            ? { status: "accepted", look: { kind: "template", templateId } }
            : { status: "rejected", code: "presentation_revision_changed" };
        }
        if (existing?.code !== "template_not_found") return existing;
        const saved = controller.saveTemplate(envelope, { helperOf: { taskId } });
        return saved?.status === "saved" ? { status: "accepted", look: { kind: "template", templateId } } : saved;
      }
      if (!programCardFeed || !savedCard) return { status: "rejected", code: "presentation_unavailable" };
      const current = programCardSaves.source({ appId: savedCard.appId });
      if (current.status !== "accepted" || current.revision !== savedCard.revision || current.sourceHash !== sourceHash)
        return { status: "rejected", code: "presentation_revision_changed" };
      const bound = programCardFeed.store.bind({ schemaVersion: 2, taskId, cardId: savedCard.appId, cardName: title,
        revision: savedCard.revision, sourceHash, ownerScope: taskPresentationOwnerScope(owner),
        ...taskScheduleBinding(version), inputs: presentation.inputs });
      return bound?.status === "accepted" ? { status: "accepted", look: { kind: "agent" } } : bound;
    },
  }) : null;

  function taskCardDraftContext(sessionKey        , clientId        ) {
    const context = resolveDraftContext(sessionKey);
    const client = (server?.getReadinessSnapshot()?.clients || []).find((entry     ) => entry.clientId === clientId);
    if (!context || !client?.clientCapabilities?.includes(PROGRAM_CARD_DRAFT_CAPABILITY)) return null;
    const clientKey = server.getClientSessionKey(clientId);
    const clientOwner = clientKey && draftOwner(clientKey);
    if (!clientOwner || taskPresentationOwnerScope(clientOwner) !== taskPresentationOwnerScope(context.owner)) return null;
    return { ...context, clientId };
  }

  const taskCardLookUndo = createTaskCardLookUndo({
    store: () => programCardFeed?.store || null,
    readPlan: (taskId        ) => resolveLiveuiGlassesLibraryController()?.readTaskSchedule(taskId)?.schedule?.approved || null,
    setLook: (taskId        , look     ) => {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller ? controller.setTaskLook(taskId, look) : { status: "rejected", code: "task_schedule_unavailable" };
    },
    reconcile: (taskId        ) => resolveLiveuiGlassesLibraryController()?.reconcileTaskSchedule(taskId),
    owns: (clientId        , binding     ) => taskPresentationClientOwns(clientId, binding),
    pushBindings: () => pushProgramCardBindings(),
    logger,
  });

  function bindTaskCard({ taskId, version, card, test, owner, plan }     ) {
    if (!programCardFeed) return { status: "rejected", code: "presentation_unavailable" };
    const source = programCardSaves.source({ appId: card.appId });
    if (source.status !== "accepted" || source.revision !== card.revision)
      return { status: "rejected", code: "presentation_revision_changed" };
    const existing = programCardFeed.store.read(taskId);
    const inputs = test?.inputs || (existing?.schemaVersion === 2 && existing.cardId === card.appId ? existing.inputs : null);
    if (!inputs) return { status: "rejected", code: "card_test_missing" };
    const bound = programCardFeed.store.bind({ schemaVersion: 2, taskId, cardId: card.appId, cardName: card.name,
      revision: card.revision, sourceHash: source.sourceHash, ownerScope: taskPresentationOwnerScope(owner),
      ...taskScheduleBinding(version), inputs });
    if (bound?.status !== "accepted") return bound || { status: "rejected", code: "binding_save_failed" };

    if (!programCardFeed.store.markTaskBuilt(card.appId)) logger.warn(`[program-card] task-built mark not kept card=${card.appId}`);
    if (test && !bound.binding.last) {
      const kept = programCardFeed.store.recordDelivery(taskId, { values: test.values, atMs: test.atMs,
        source: TASK_CARD_TEST_SOURCE, deliveryId: `test-${taskId}`, bindingDigest: bound.binding.bindingDigest });
      if (!kept || kept.status === "rejected") logger.warn(`[program-card] test values not kept task=${taskId}`);
    }

    const layout = plan ? taskCardLookUndo.keep(taskId, card.appId, plan) : null;
    return { status: "accepted", look: { kind: "agent" }, ...(layout ? { kept: layout } : {}) };
  }

  const taskCardCreate = cardDrafts ? createTaskCardCreate({
    buildEnd: (handle        ) => cardBuildPhases.taskEnd(handle),
    forgetBuild: (handle        ) => cardBuildPhases.forgetTaskEnd(handle),
    owner: (sessionKey        , clientId        ) => {
      const context = taskCardDraftContext(sessionKey, clientId);
      if (!context) return null;
      return { owner: context.owner, agentId: context.owner.backend === "hermes"
        ? hermesProfileIdForNamespace(context.owner.agent) : context.owner.agent };
    },
    testCard: (testId         ) => typeof testId === "string" ? liveuiTaskTests.cardOf(testId) : null,
    taskSaved: (taskId        ) => {
      const loaded = resolveLiveuiGlassesLibraryController()?.readTask?.(taskId);
      return loaded?.status === "accepted" && !!loaded.task?.versions?.approved;
    },
    draft: (sessionKey        , draftId        ) => cardDrafts.run(sessionKey, { action: "get", draftId }),
    promote: (sessionKey        , clientId        , params     ) => cardDrafts.promoteForTask(sessionKey, clientId, params),
    bind: bindTaskCard,
    unbind: (taskId        ) => {
      if (!programCardFeed?.store.read(taskId)) return;
      programCardFeed.store.clear(taskId);

      programCardFeed.store.forgetLook(taskId);
      pushProgramCardBindings();
    },
    dropTask: (taskId        ) => {
      const controller = resolveLiveuiGlassesLibraryController();
      const loaded = controller?.readTask?.(taskId);
      if (loaded?.status !== "accepted" || loaded.task?.versions?.approved) return;
      controller.organizeLibrary({ action: "delete", itemType: "task", itemId: taskId, expectedDigest: loaded.task.digest });
    },
    unsave: (sessionKey        , draftId        , appId        ) => {
      const deleted = resolveLiveuiGlassesLibraryController()?.organizeLibrary({ action: "delete", itemType: "app", itemId: appId });
      if (deleted?.status !== "deleted" && programCardSaves.load(appId)?.status === "accepted") return;
      cardDrafts.unpromoteForTask(sessionKey, draftId, appId);
    },
    discard: async (sessionKey        , draftId        ) => {
      const draft      = await cardDrafts.run(sessionKey, { action: "get", draftId });
      if (!draft?.ok || draft.status !== "draft") return false;
      const out      = await cardDrafts.run(sessionKey, { action: "discard", draftId,
        revision: draft.revision, checkpointSeq: draft.checkpointSeq });
      return out?.ok === true && out.discarded === true;
    },

    savedTask: (taskId        ) => {
      const saved = savedTaskForCard(taskId);
      return saved ? { name: saved.name, version: saved.version } : null;
    },
    hasCard: (taskId        ) => !!programCardFeed?.store.read(taskId),
    useCard: async (taskId        ) => {

      const controller = resolveLiveuiGlassesLibraryController();
      const plan = controller?.readTaskSchedule(taskId)?.schedule?.approved;
      let kept      = null;
      if (plan && plan.look?.kind !== "agent") {
        const set      = await controller.setTaskLook(taskId, { kind: "agent" });
        if (!set || (set.status !== "saved" && set.status !== "unchanged")) return { status: "rejected", code: set?.code || "presentation_look_failed" };

        const cardId = programCardFeed?.store.read(taskId)?.cardId;
        if (typeof cardId === "string") kept = taskCardLookUndo.keep(taskId, cardId, plan);
      }

      if (plan?.when) {
        try { await controller.reconcileTaskSchedule(taskId); } catch (err     ) {
          logger.warn(`[program-card] task card sync failed task=${taskId}: ${err?.message || err}`);
        }
      }
      pushProgramCardBindings();
      return { status: "accepted", ...(kept ? { kept } : {}) };
    },
    dropTest: (testId        ) => liveuiTaskTests.drop(testId),

    starterOf: (testId         ) => typeof testId === "string" ? liveuiTaskTests.starterOf(testId) : null,
    starterFit: (testId         , clientId        ) => typeof testId === "string" ? liveuiTaskTests.starterFitOf(testId, clientId) : null,
    phoneOwner: (clientId        ) => {
      const clientKey = server?.getClientSessionKey?.(clientId);
      const owner = clientKey ? draftOwner(clientKey) : null;
      if (!owner) return null;
      return { owner, agentId: owner.backend === "hermes" ? hermesProfileIdForNamespace(owner.agent) : owner.agent };
    },
    nameTaken: (name        ) => {
      const wanted = name.trim().toLocaleLowerCase();
      const items = resolveLiveuiGlassesLibraryController()?.listLibrary?.() || [];
      return items.some((item     ) => typeof item?.name === "string" && item.name.trim().toLocaleLowerCase() === wanted);
    },
    saveStarterCard: ({ name, source, inputs, starter, owner }     ) => {
      if (!programCardFeed) return { status: "rejected", code: "presentation_unavailable" };
      const scope = taskPresentationOwnerScope(owner);

      const table = [{ name: "task", label: name.slice(0, 40), inputs, maxBytes: TASK_SLOTS_DATA_MAX }];
      return programCardSaves.save({ name, card: { kind: "source", source }, state: CARD_STARTER_FIRST_STATE, by: "owner" },
        { taskSlots: table, starter,

          beforeCreate: (appId        ) => programCardFeed.store.claimCard(appId, scope).status === "accepted" });
    },
    markStarter: (appId        , starter     ) => programCardFeed?.store.markStarter(appId, starter) === true,
    deleteCard: (appId        ) => {
      resolveLiveuiGlassesLibraryController()?.organizeLibrary({ action: "delete", itemType: "app", itemId: appId });
      programCardFeed?.store.forgetStarter(appId);
    },
    bindingOf: (taskId        ) => programCardFeed?.store.read(taskId) || null,

    taskTestCard: (testId         , taskId        ) => typeof testId === "string" ? liveuiTaskTests.cardOfTask(testId, taskId) : null,
    cardStarter: (appId        ) => programCardFeed?.store.cardStarter(appId) || null,
    savedTaskStarter: (taskId        ) => {
      const saved = savedTaskForCard(taskId);
      return saved?.plan?.starter ? savedTaskStarterCard(saved.plan.starter.key, saved.version.request) : null;
    },

    addPlan: ({ cardId, taskId, test, owner, part, name }     ) => {
      if (!programCardFeed) return { status: "rejected", code: "card_unavailable" };
      const cardScope = programCardFeed.store.ownerScope(cardId);
      if (cardScope && cardScope !== taskPresentationOwnerScope(owner)) return { status: "rejected", code: "presentation_owner_changed" };
      if (programCardFeed.store.forCard(cardId).some((binding     ) => binding.taskId === taskId)) return { status: "rejected", code: "task_on_card" };

      const taskName = savedTaskForCard(taskId)?.name || (typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : taskId);
      const plan      = cardAddPlan(cardId, taskName, test, part);
      return plan.status === "accepted" ? { status: "accepted", table: plan.table, slot: plan.slot, name: plan.card.name } : plan;
    },
    promoteRevision: (sessionKey        , clientId        , params     , table     ) =>
      cardDrafts.promoteForTask(sessionKey, clientId, params, table),
    repin: async (cardId        , card     , table     , exceptTaskId        ) => {
      const source = programCardSaves.source({ appId: cardId });
      if (source.status !== "accepted" || source.revision !== card.revision) return { repinned: [], failed: [] };
      const pinned = repinCardParts(programCardFeed.store, cardId, source.revision, source.sourceHash, table, exceptTaskId);
      await reconcileRepinned(pinned.repinned);
      return pinned;
    },
    bindPart: ({ taskId, version, card, test, owner, slot, inputs }     ) => {
      const source = programCardSaves.source({ appId: card.appId });
      if (source.status !== "accepted" || source.revision !== card.revision)
        return { status: "rejected", code: "presentation_revision_changed" };
      const bound = programCardFeed.store.bind({ schemaVersion: 2, taskId, cardId: card.appId, cardName: card.name, slot,
        revision: card.revision, sourceHash: source.sourceHash, ownerScope: taskPresentationOwnerScope(owner),
        ...taskScheduleBinding(version), inputs });
      if (bound?.status !== "accepted") return bound || { status: "rejected", code: "binding_save_failed" };
      if (test && !bound.binding.last) {
        const kept = programCardFeed.store.recordDelivery(taskId, { values: test.values, atMs: test.atMs,
          source: TASK_CARD_TEST_SOURCE, deliveryId: `test-${taskId}`, bindingDigest: bound.binding.bindingDigest });
        if (!kept || kept.status === "rejected") logger.warn(`[program-card] test values not kept task=${taskId}`);
      }
      logger.info(`[program-card] added task=${taskId} card=${card.appId} slot=${slot} revision=${card.revision}`);
      return { status: "accepted" };
    },
  }) : null;

  function cardAddPlan(cardId        , taskName        , test     , part                = null) {
    const source      = programCardSaves.source({ appId: cardId });
    if (!programCardFeed || source.status !== "accepted") return { status: "rejected", code: "card_unavailable" };
    const bound = programCardFeed.store.forCard(cardId).filter((binding     ) => binding.schemaVersion === 2);
    const table = cardTaskSlots(source, bound.find((binding     ) => bindingSlot(binding) === TASK_SLOT_FIRST)?.inputs || null);
    const plan      = addCardPart(table, taskName, Array.isArray(test?.inputs) ? test.inputs : [], programCardTaskSlotsCap(), part);
    if (plan.status !== "accepted") return plan;
    const parts = plan.table.map((entry     ) => {
      if (entry.name === plan.slot) return { ...entry, isNew: true, ...(test?.values ? { values: test.values, atMs: test.atMs } : {}) };
      const last = bound.find((binding     ) => bindingSlot(binding) === entry.name)?.last;
      return { ...entry, ...(last?.values ? { values: last.values, atMs: last.atMs } : {}) };
    });
    return { status: "accepted", table: plan.table, slot: plan.slot, parts,
      card: { appId: cardId, name: source.name, revision: source.revision } };
  }

  function taskBuildWithPart(taskBuild     ) {
    if (!taskBuild?.addTo || typeof taskBuild.name !== "string") return taskBuild;
    const test = typeof taskBuild.testId === "string" ? liveuiTaskTests.cardOf(taskBuild.testId) : null;
    const plan      = cardAddPlan(taskBuild.addTo, taskBuild.name, test);
    return plan.status === "accepted" ? { ...taskBuild, part: plan.slot } : taskBuild;
  }

  function cardBuildAddPlan(sessionKey        ) {
    const marker = cardBuildPhases.taskFor(sessionKey);
    if (!marker?.addTo) return null;
    const testId = cardBuildPhases.taskTestFor(sessionKey);
    const test = testId ? liveuiTaskTests.cardOf(testId) : null;
    return cardAddPlan(marker.addTo, marker.name, test, marker.part || null);
  }

  const taskFixBuilds = new Map             ();

  const TASK_FIX_UNSENT_MS = 2 * 60_000;

  const TASK_FIX_QUIET_MS = Number.isSafeInteger(opts.taskFixQuietMs) && opts.taskFixQuietMs > 0 ? opts.taskFixQuietMs : 3 * 60_000;
  const TASK_FIX_HANDLE = /^[A-Za-z0-9_-]{8,80}$/;

  function taskFixLive(fix     ) {
    if (!fix || fix.thrownAway) return false;
    const end = cardBuildPhases.taskEnd(fix.handle);
    if (end) return end.outcome === "draft";
    if (fix.sessionKey) {
      if (cardBuildPhases.taskFor(fix.sessionKey)?.handle !== fix.handle) return false;
      if (cardBuildPhases.current(fix.sessionKey)) fix.buildSeen = true;
      return fix.buildSeen || Date.now() - fix.startedAtMs < TASK_FIX_QUIET_MS;
    }
    return Date.now() - fix.startedAtMs < TASK_FIX_UNSENT_MS;
  }

  function taskFixQuietCheck(fix     ) {
    if (fix.quietTimer) return;
    const wait = Math.max(0, fix.startedAtMs + TASK_FIX_QUIET_MS - Date.now()) + 1000;
    fix.quietTimer = setTimeout(() => {
      if (taskFixBuilds.get(fix.cardId) !== fix || fix.saved || fix.ended) return;
      if (!taskFixLive(fix)) {
        logger.info(`[program-card] fix gave up card=${fix.cardId} task=${fix.taskId} no build started`);
        pushProgramCardBindings();
      }
    }, wait);
    fix.quietTimer.unref?.();
  }

  function taskFixOfSession(sessionKey        ) {
    const marker = cardBuildPhases.taskFor(sessionKey);
    if (!marker?.fix) return null;
    for (const fix of taskFixBuilds.values()) {
      if (fix.taskId === marker.fix && fix.handle === marker.handle) return fix;
    }
    return null;
  }

  function taskFixChecked(sessionKey        , hardCases     ) {
    const fix = taskFixOfSession(sessionKey);
    if (!fix || !hardCases?.verdict) return;
    fix.check = { verdict: hardCases.verdict, sourceHash: typeof hardCases.sourceHash === "string" ? hardCases.sourceHash : null,
      kept: Number.isInteger(hardCases.kept) ? hardCases.kept : 0, atMs: Date.now() };
    logger.info(`[program-card] fix checked card=${fix.cardId} verdict=${fix.check.verdict} kept=${fix.check.kept}`);
  }

  function taskFixParts(binding     , inputs       , values     , atMs        ) {
    const bound = programCardFeed.store.forCard(binding.cardId).filter((entry     ) => entry.schemaVersion === 2);
    if (bound.length < 2) return null;
    const source      = programCardSaves.source({ appId: binding.cardId });
    const table = cardTaskSlots(source, bound.find((entry     ) => bindingSlot(entry) === TASK_SLOT_FIRST)?.inputs || null);
    if (!Array.isArray(table) || table.length < 2) return null;
    const mine = bindingSlot(binding);
    return table.map((entry     ) => {
      if (entry.name === mine) return { ...entry, inputs, isNew: true, values, atMs };
      const last = bound.find((other     ) => bindingSlot(other) === entry.name)?.last;
      return { ...entry, ...(last?.values ? { values: last.values, atMs: last.atMs } : {}) };
    });
  }

  function startTaskFix(clientId        , taskId        , handle         ) {
    const store = programCardFeed?.store;
    const binding = store ? store.read(taskId) : null;
    if (binding?.schemaVersion !== 2 || !taskPresentationClientOwns(clientId, binding)) return { status: "rejected", code: "card_not_bound" };
    if (typeof handle !== "string" || !TASK_FIX_HANDLE.test(handle)) return { status: "rejected", code: "invalid_request" };
    const offer      = programCardFeed.fixOffer(binding, { parts: clientHasTaskSlots(clientId) });
    if (!offer) return { status: "rejected", code: TASK_FIX_BUILD_CODES.notOffered };
    const pick      = taskFixPick(binding.inputs, binding.fix, offer.key);
    if (pick.status !== "accepted") return pick;
    const running = taskFixBuilds.get(binding.cardId);
    if (running && running.handle !== handle && taskFixLive(running)) return { status: "rejected", code: TASK_FIX_BUILD_CODES.running };
    const source      = programCardSaves.source({ appId: binding.cardId });
    if (source?.status !== "accepted") return { status: "rejected", code: TASK_FIX_BUILD_CODES.card };
    if (source.revision !== binding.revision) return { status: "rejected", code: TASK_FIX_BUILD_CODES.changed };
    const controller = resolveLiveuiGlassesLibraryController();
    const loaded = controller?.readTask?.(taskId);
    const named = loaded?.status === "accepted" ? loaded.task?.versions?.approved?.name || loaded.task?.name : null;
    const when = controller?.readTaskSchedule?.(taskId)?.schedule?.approved?.when;
    const fix = {
      cardId: binding.cardId, taskId, clientId, handle, key: pick.key,
      label: taskFixLabel(binding.inputs.find((input     ) => input.key === pick.key), pick.key),
      change: pick.change, inputs: pick.inputs, values: pick.values, atMs: pick.atMs,

      kept: taskFixLastValues(pick.inputs, binding.last),

      slot: bindingSlot(binding), parts: taskFixParts(binding, pick.inputs, pick.values, pick.atMs),
      revision: binding.revision, sourceHash: binding.sourceHash, cardName: typeof source.name === "string" ? source.name : binding.cardId,
      taskName: typeof named === "string" && named.trim() ? named.trim() : taskId,
      timeZone: typeof when?.timeZone === "string" ? when.timeZone : null, startedAtMs: Date.now(),
    };
    taskFixBuilds.delete(binding.cardId);
    taskFixBuilds.set(binding.cardId, fix);
    if (taskFixBuilds.size > 32) taskFixBuilds.delete(taskFixBuilds.keys().next().value          );

    logger.info(`[program-card] fix started card=${fix.cardId} task=${taskId} ${fix.key}:${fix.change}`);
    return { status: "accepted", handle, cardId: fix.cardId, cardName: fix.cardName, task: fix.taskName, key: fix.key,
      label: fix.label, change: fix.change, card: { inputs: fix.inputs, values: fix.values, atMs: fix.atMs },

      ...(fix.parts ? { part: fix.slot } : {}) };
  }

  function taskBuildWithFix(taskBuild     , clientId               , sessionKey        ) {
    if (!taskBuild?.fix) return taskBuild;
    const fix = [...taskFixBuilds.values()].find((entry     ) => entry.taskId === taskBuild.fix && entry.handle === taskBuild.handle);
    if (!fix || (clientId && fix.clientId !== clientId) || !taskFixLive(fix)) {
      const { fix: _fix, ...plain } = taskBuild;
      logger.warn(`[program-card] fix marker dropped task=${taskBuild.fix}`);
      return plain;
    }
    fix.sessionKey = sessionKey;
    taskFixQuietCheck(fix);

    return fix.parts ? { ...taskBuild, part: fix.slot } : taskBuild;
  }

  function taskFixEnded(frame     ) {
    if (!frame?.done || !frame.task?.fix) return;
    const fix = [...taskFixBuilds.values()].find((entry     ) => entry.taskId === frame.task.fix && entry.handle === frame.task.handle);
    if (!fix) return;
    if (fix.ended) {

      if (frame.outcome === "draft" && !fix.saved) pushProgramCardBindings();
      return;
    }
    fix.ended = frame.outcome || "failed";
    const ended = taskFixEnding(frame.outcome, frame.check);
    if (!ended) return;
    const { check, counts } = ended;
    const kept      = programCardFeed?.store?.fixTry?.(fix.taskId, check, counts);
    if (kept && kept.status !== "accepted") logger.warn(`[program-card] fix try not kept task=${fix.taskId} code=${kept.code}`);
    logger.info(`[program-card] fix ended card=${fix.cardId} task=${fix.taskId} outcome=${fix.ended} check=${check}${counts ? " try" : ""}`);
    if (kept?.status === "accepted") pushProgramCardBindings();
  }

  function taskFixThrownAway(taskId        , handle         ) {
    const fix = [...taskFixBuilds.values()].find((entry     ) => entry.taskId === taskId && entry.handle === handle);
    if (!fix || fix.saved || fix.thrownAway) return;
    fix.thrownAway = true;
    const kept      = programCardFeed?.store?.fixTry?.(taskId, "card_changed", false);
    logger.info(`[program-card] fix thrown away card=${fix.cardId} task=${taskId} check=card_changed`);
    if (kept?.status === "accepted") pushProgramCardBindings();
  }

  function taskFixPhoneState(binding     , clientId        ) {
    if (binding?.schemaVersion !== 2 || !programCardFeed) return null;
    const fix = taskFixBuilds.get(binding.cardId);
    let fixing      = null;
    if (fix && fix.taskId === binding.taskId && !fix.saved && taskFixLive(fix)) {
      const end = cardBuildPhases.taskEnd(fix.handle);
      fixing = { state: end?.outcome === "draft" ? "ready" : "building", key: fix.key,
        ...(typeof fix.label === "string" && fix.label ? { label: fix.label } : {}), runAtMs: fix.atMs,
        ...(fix.clientId === clientId ? { handle: fix.handle } : {}) };
    }
    let unsynced = false;
    if (binding.fixed) {
      try { unsynced = resolveLiveuiGlassesLibraryController()?.readTaskSchedule?.(binding.taskId)?.schedule?.state === "unsynced"; }
      catch (_) { unsynced = false; }
    }
    const done = programCardFeed.fixDone(binding, unsynced);
    return fixing || done ? { fixing, done } : null;
  }

  const taskFixSave = cardDrafts ? createTaskFixSave({
    fixOf: (taskId        , handle        ) => {
      for (const fix of taskFixBuilds.values()) if (fix.taskId === taskId && fix.handle === handle) return fix;
      return null;
    },
    buildEnd: (handle        ) => cardBuildPhases.taskEnd(handle),
    binding: (taskId        ) => programCardFeed ? programCardFeed.store.read(taskId) : null,
    owns: (clientId        , binding     ) => taskPresentationClientOwns(clientId, binding),
    current: (binding     ) => programCardFeed.bindingState(binding) === "current",
    card: (cardId        ) => {
      const loaded      = programCardSaves.load(cardId);
      return loaded?.status === "accepted" ? loaded.record : null;
    },
    source: (cardId        ) => programCardSaves.source({ appId: cardId }),
    draft: (sessionKey        , draftId        ) => cardDrafts.run(sessionKey, { action: "get", draftId }),
    digest: (source        ) => liveuiLibraryDigest({ kind: "source", source }),
    pick: (binding     , key        ) => taskFixPick(binding.inputs, binding.fix, key),
    values: taskFixSavedValues,

    table: (source     , binding     , inputs       ) => (cardTaskSlots(source, binding.inputs) || [])
      .map((part     ) => part.name === bindingSlot(binding) ? { ...part, inputs: inputs.map((entry     ) => ({ ...entry })) } : part),
    promote: (sessionKey        , clientId        , params     , table     , saveOptions     ) =>
      cardDrafts.promoteForTask(sessionKey, clientId, params, table, saveOptions),
    undoRevision: (previous     , number        ) => programCardSaves.undoRevision(previous, number),
    unpromote: (sessionKey        , draftId        , appId        ) => cardDrafts.unpromoteForTask(sessionKey, draftId, appId),
    applyFix: (taskId        , change     ) => programCardFeed.store.applyFix(taskId, change),
    others: (cardId        , taskId        ) => programCardFeed.store.forCard(cardId)
      .filter((binding     ) => binding.schemaVersion === 2 && binding.taskId !== taskId),
    repin: (cardId        , revision        , sourceHash        , table       , taskId        ) =>
      repinCardParts(programCardFeed.store, cardId, revision, sourceHash, table, taskId),
    restore: (binding     ) => programCardFeed.store.restore(binding),
    prune: (cardId        ) => programCardSaves.pruneRevisions(cardId),

    resend: (taskIds          ) => reconcileRepinned(taskIds),
    saved: (fix     ) => {
      fix.saved = true;
      pushProgramCardBindings();

      broadcastCardRevisionChanged(fix.cardId);
    },
    now: () => Date.now(),
    log: (line        ) => logger.info(line),
  }) : null;

  const taskFixUndo = createTaskFixUndo({
    binding: (taskId        ) => programCardFeed ? programCardFeed.store.read(taskId) : null,
    owns: (clientId        , binding     ) => taskPresentationClientOwns(clientId, binding),
    open: (fixed     ) => taskFixDoneOpen(fixed, Date.now()),
    source: (cardId        ) => programCardSaves.source({ appId: cardId }),
    hasRevision: (cardId        , number        ) => (programCardSaves.listRevisions({ appId: cardId, seen: false })?.revisions || [])
      .some((row     ) => row.number === number),
    restore: (cardId        , number        ) => programCardSaves.restoreRevision({ appId: cardId, number,
      linkedParts: linkedCardParts(programCardFeed.store, cardId) }),
    undoLink: (taskId        , back     ) => programCardFeed.store.undoFix(taskId, back),
    repinOne: (taskId        , revision        , sourceHash        ) => {
      const binding = programCardFeed.store.read(taskId);
      return binding ? programCardFeed.store.bind({ ...binding, revision, sourceHash }) : { status: "rejected", code: "card_not_bound" };
    },
    rewrite: (binding     ) => programCardFeed.store.restore(binding),
    close: (taskId        ) => {
      if (programCardFeed.store.fixClose(taskId)?.status === "accepted") pushProgramCardBindings();
    },
    resend: (taskIds          ) => reconcileRepinned(taskIds),

    done: (result     ) => { pushProgramCardBindings(); broadcastCardRevisionChanged(result.cardId); },
    log: (line        ) => logger.info(line),
  });

  async function reconcileRepinned(taskIds          ) {
    const controller = resolveLiveuiGlassesLibraryController();
    for (const taskId of taskIds) {
      if (!controller?.readTaskSchedule(taskId)?.schedule?.approved?.when) continue;
      try { await controller.reconcileTaskSchedule(taskId); } catch (err     ) {
        logger.warn(`[program-card] re-pinned task sync failed task=${taskId}: ${err?.message || err}`);
      }
    }
    if (taskIds.length) pushProgramCardBindings();
  }

  function savedTaskForCard(taskId        ) {
    const controller = resolveLiveuiGlassesLibraryController();
    const loaded = controller?.readTask?.(taskId);
    const version = loaded?.status === "accepted" ? loaded.task?.versions?.approved : null;
    const plan = version ? controller.readTaskSchedule(taskId)?.schedule?.approved : null;
    if (!version || !plan || plan.kind !== "brief" || typeof version.request !== "string" || !version.request.trim()) return null;
    const name = typeof version.name === "string" && version.name.trim() ? version.name : loaded.task.name;
    return { name: typeof name === "string" ? name : taskId, version, plan };
  }

  function newTaskCardParts(clientId        , testId        ) {
    const draft = liveuiTaskTests.draftOf(testId, clientId);
    if (!draft) return { status: "rejected", code: "card_test_missing" };
    const scope = taskOwnerScopeOf("", { executor: { host: relayBackendKind, agentId: draft.profileId } });
    if (!scope) return { status: "rejected", code: "presentation_owner_changed" };
    return cardPartLink.partsForNew({ clientId, scope, tested: draft.card });
  }

  function linkCreatedTask(clientId        , testId               , cardPart     , outcome     ) {
    if (!cardPart || !testId) return outcome;
    return Promise.resolve(outcome).then((result     ) => {
      if (result?.status !== "saved" || typeof result.taskId !== "string" || !cardPartLink) return result;
      const taskId = result.taskId;
      const linked      = cardPartLink.link({ clientId, taskId, cardId: cardPart.cardId, slot: cardPart.slot,
        replace: true, tested: liveuiTaskTests.cardOf(testId) });
      if (linked?.status !== "linked") {
        logger.warn(`[program-card] create link refused task=${taskId} card=${cardPart.cardId} code=${linked?.code}`);
        return { ...result, cardPart: { status: "rejected", code: typeof linked?.code === "string" ? linked.code : "link_failed" } };
      }
      logger.info(`[program-card] created task=${taskId} into card=${linked.cardId} slot=${linked.slot}` +
        `${linked.replaced ? ` replaced=${linked.replaced}` : ""}`);
      const controller = resolveLiveuiGlassesLibraryController();
      if (controller && typeof controller.reconcileTaskSchedule === "function") {
        for (const id of [taskId, linked.replaced].filter(Boolean)) Promise.resolve(controller.reconcileTaskSchedule(id)).catch(() => {});
      }
      pushProgramCardBindings();
      return { ...result, cardPart: { status: "linked", cardId: linked.cardId, slot: linked.slot } };
    });
  }

  function cardPartInputsFor(clientId        , part     ) {
    const cardId = typeof part?.cardId === "string" ? part.cardId : "";
    if (!cardId || !validTaskSlotName(part?.slot) || !programCardFeed) return null;
    const scope = programCardFeed.store.ownerScope(cardId);
    if (!scope || scope === "unavailable" || !taskPresentationClientOwns(clientId, { ownerScope: scope })) return null;
    const source = programCardSaves.source({ appId: cardId });
    if (source.status !== "accepted") return null;
    const first = programCardFeed.store.forCard(cardId).find((binding     ) => binding.schemaVersion === 2 && bindingSlot(binding) === TASK_SLOT_FIRST);
    const found = (cardTaskSlots(source, first?.inputs || null) || []).find((entry     ) => entry.name === part.slot);
    return found ? found.inputs : null;
  }

  function taskNameOf(task     , version     , taskId        ) {
    const name = typeof version?.name === "string" && version.name.trim() ? version.name : task?.name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : taskId;
  }

  function taskOwnerScopeOf(taskId        , version     ) {
    const bound = programCardFeed?.store.read(taskId);
    if (bound?.schemaVersion === 2 && typeof bound.ownerScope === "string") return bound.ownerScope;
    const host = version?.executor?.host;
    const agentId = typeof version?.executor?.agentId === "string" ? version.executor.agentId.trim() : "";
    if (!opts.stateDir || host !== relayBackendKind || !agentId) return null;
    const installation = path.resolve(opts.stateDir);
    if (relayBackendKind === "hermes") {
      const namespace = agentId === "default" ? "main" : agentId;
      return taskPresentationOwnerScope({ installation, backend: "hermes", profile: namespace, agent: namespace });
    }
    return taskPresentationOwnerScope({ installation, backend: "openclaw", profile: installation, agent: agentId });
  }

  function taskPresentationRevisionBinding(context     , target     , allowApplied = false) {
    const binding = programCardFeed?.store.read(target.taskId);
    const version = resolveLiveuiGlassesLibraryController()?.readTaskForRun(target.taskId)?.task?.versions?.approved;
    const source = programCardSaves.source({ appId: target.cardId });
    if (binding?.schemaVersion !== 2 || !version || !taskPresentationClientOwns(context.clientId, binding) ||
        binding.cardId !== target.cardId || binding.taskVersionId !== target.taskVersionId || version.versionId !== target.taskVersionId ||
        taskScheduleBinding(version).requestDigest !== target.requestDigest || source.status !== "accepted" ||
        source.revision !== target.revision || source.sourceHash !== target.sourceHash ||
        binding.bindingDigest !== target.previousDigest && !(allowApplied && binding.revision === target.revision && binding.sourceHash === target.sourceHash)) return null;
    return binding;
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

  function settlePendingUserSend(id     ) {
    if (conversationState && typeof conversationState.settleUserSend === "function") {
      conversationState.settleUserSend(id);
    }
  }

  function dispatchOcuClawUserSend(params      = {}) {
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

  const jevConfig = opts.liveuiJev || (opts.config && opts.config.liveuiJev) || {};
  const surfaceDecisionStore = createSurfaceDecisionStore({
    emit: (payload     , sessionKey     ) => {

      emitDebug("glasses.lifecycle", "glasses_ui_jev_decision", "debug", { sessionKey }, () => ({ ...payload }));
    },
  });

  const liveUiAskedWords = createLiveUiAskedWordsStore();
  const fireSurfaceDecision = createSurfaceDecisionFirer({
    config: jevConfig,
    store: surfaceDecisionStore,

    createClient: typeof opts.jevClientFactory === "function" ? opts.jevClientFactory : createJevClient,
    connection: jevConnection,
    buildState: buildJevState,

    compose: (answers     ) => composeCardDecision(answers) || composeSurfaceDecision(answers),

    v2Turn: (sessionKey     ) => liveUiV2Session(sessionKey) && hasConnectedLiveUiV2Client(),

    cardTurn: () => hasConnectedClientCapability(PROGRAM_CARD_CAPABILITY),

    titleIcons: () => liveuiTitleIconsOn(),
    emitIcon: (payload     , sessionKey     ) => {
      emitDebug("glasses.lifecycle", "glasses_ui_jev_icon", "debug", { sessionKey }, () => ({ ...payload }));
    },
  });

  const webJevShadow = createWebJevShadow({
    enabled: () => debugStore.isEnabled("firecrawl.web", undefined) && jevFeaturesArmed({ liveuiJev: jevConfig }),
    apiKey: () => (typeof jevConfig.apiKey === "string" ? jevConfig.apiKey : ""),
    createClient: typeof opts.jevClientFactory === "function" ? opts.jevClientFactory : createJevClient,
    connection: jevConnection,
    buildState: buildJevState,
    emit: (row     , sessionKey     , runId     ) => {
      emitDebug("firecrawl.web", "web_jev_shadow", "debug", { sessionKey, runId }, () => ({ ...row }));
    },
  });

  function liveuiTitleIconsOn() {
    try {
      const controller = resolveLiveuiGlassesLibraryController();
      const loaded = controller && typeof controller.getLiveuiPrefs === "function"
        ? controller.getLiveuiPrefs()
        : null;
      return !(loaded && loaded.prefs && loaded.prefs.titleIcons === false);
    } catch (_) {
      return true;
    }
  }

  let cardIconJev      = null;

  function setLiveuiJevEnabled(enabled         ) {
    jevConfig.enabled = enabled === true;
    const keyed = () => typeof jevConfig.apiKey === "string" && jevConfig.apiKey !== "";
    if (jevConfig.enabled && !keyed() && typeof opts.typesafeApiKey === "string" && opts.typesafeApiKey) {
      jevConfig.apiKey = opts.typesafeApiKey;
    }
    if (typeof fireSurfaceDecision.reset === "function") fireSurfaceDecision.reset();
    cardIconJev = null;
    return { enabled: jevConfig.enabled === true, keyed: keyed() };
  }

  const cardIconModel      = createCardIconModelClient({
    llmComplete: typeof opts.cardIconLlmComplete === "function"
      ? opts.cardIconLlmComplete
      : gatewayBridge && gatewayBridge.kind === "hermes"
        ? (params     ) => gatewayBridge.request(LINK_PROGRAM_CARD_ICON_LLM_COMPLETE_METHOD, params)
        : opts.inputPrediction && typeof opts.inputPrediction.llmComplete === "function"
          ? (params     ) => opts.inputPrediction.llmComplete(params)
          : null,
  });
  const cardIconPicker = createProgramCardIconPicker({
    saves: programCardSaves,
    jev: () => {
      if (!liveuiTitleIconsOn()) return null;
      if (jevConfig.enabled !== true || !jevConfig.apiKey) return cardIconModel;
      if (!cardIconJev) {
        cardIconJev = (typeof opts.jevClientFactory === "function" ? opts.jevClientFactory : createJevClient)({
          apiKey: jevConfig.apiKey,
          enabled: true,
          model: (typeof jevConfig.model === "string" && jevConfig.model) || JEV_MODEL_ID,
          questions: CARD_ICON_QUESTIONS,
          ...(jevConnection ? { connection: jevConnection } : {}),
        });
      }
      return cardIconJev;
    },
    onChanged: () => broadcastLiveuiLibrarySnapshot(),
    report: (payload     ) => {
      emitDebug("glasses.lifecycle", "program_card_icon_pick", "debug", {}, () => ({ ...payload }));
    },
  });

  function planCardIcon(sessionKey        , name               , plan       ) {
    const description = plan.map((item     ) => item.line).join("; ");
    const picked      = cardIconPicker.planPick(name || "", description);
    const pick      = { icon: picked.icon || null, by: picked.icon ? "keywords" : null, open: true };
    notePlanIcon(sessionKey, pick);
    emitDebug("glasses.lifecycle", "program_card_plan_icon", "debug", { sessionKey }, () => ({
      by: pick.by, icon: pick.icon, jevAsked: !!picked.jev,
    }));
    if (picked.jev) {
      picked.jev.then((row     ) => {
        const current = pick.open === true && planIconForSession(sessionKey) === pick;
        const icon = row && row.icon ? row.icon : null;
        if (current && icon) {
          pick.icon = icon;
          pick.by = "jev";
        }
        emitDebug("glasses.lifecycle", "program_card_plan_icon", "debug", { sessionKey }, () => ({
          by: "jev",
          icon,
          confidence: row ? row.confidence : null,
          ms: row ? row.ms : null,
          ...(row && row.via ? { via: row.via } : {}),
          ...(row && row.jevFailed ? { jevFailed: row.jevFailed } : {}),
          outcome: !icon ? "none" : current ? "picked" : "dropped",
        }));
        if (current && icon) broadcastCardBuild(cardBuildPhases.icon({ sessionKey, icon }), "icon");
      }).catch((err     ) => {
        logger.warn(`[program-card] plan icon pick failed: ${err && err.message ? err.message : err}`);
      });
    }
    return pick;
  }

  function libraryWithCardKits(items     ) {
    return programCardLibraryWithKits(items, (appId, revision) => programCardSaves.revisionKit(appId, revision));
  }

  function broadcastLiveuiLibrarySnapshot() {
    const controller = resolveLiveuiGlassesLibraryController();
    if (!server || !controller || typeof controller.listLibrary !== "function") return;
    Promise.resolve()
      .then(() => controller.listLibrary())
      .then((items     ) => server.broadcast(handler.formatLiveuiLibrary(libraryWithCardKits(items) || [])))
      .catch((err     ) => {
        logger.warn(`[program-card] Library snapshot after an icon pick failed: ${err && err.message ? err.message : err}`);
      });
  }

  function broadcastCardRevisionChanged(appId        ) {
    broadcastLiveuiLibrarySnapshot();
    broadcastCardRevisions(appId);
  }

  function broadcastCardRevisions(appId        ) {
    if (!server) return;
    const revisions      = programCardFrameRedo.decorate(programCardSaves.listRevisions({ appId }));
    if (revisions?.status === "accepted") server.broadcast(formatProgramCardRevisions(revisions));
  }

  function connectedAppClientHas(capability     ) {

    if (typeof capability !== "string" || !capability) return false;
    try {
      const snap =
        server && typeof server.getReadinessSnapshot === "function"
          ? server.getReadinessSnapshot()
          : null;
      const clients = snap && Array.isArray(snap.clients) ? snap.clients : [];
      return clients.some(
        (entry     ) =>
          Array.isArray(entry && entry.clientCapabilities) &&
          entry.clientCapabilities.includes(capability),
      );
    } catch {
      return false;
    }
  }

  const programCardCapableClients = new Map                ();
  let programCardClientLeftAtMs                = null;

  function dropGoneProgramCardClients() {
    if (programCardCapableClients.size === 0 || !server) return;
    const live = new Set        (server.getClientIds());
    for (const clientId of [...programCardCapableClients.keys()]) {
      if (!live.has(clientId)) programCardCapableClients.delete(clientId);
    }
    if (programCardCapableClients.size === 0) programCardClientLeftAtMs = Date.now();
  }
  function noteProgramCardClientIdentified(clientId        , entry     ) {
    if (typeof clientId !== "string" || !clientId) return;
    if (Array.isArray(entry?.clientCapabilities) && entry.clientCapabilities.includes(PROGRAM_CARD_CAPABILITY)) {
      programCardCapableClients.set(clientId, Date.now());
    }
  }

  const CARD_BUILD_DEAD_LINK_MS = 60_000;

  function noteProgramCardClientClosed(clientId        , closeCode          = null) {
    const had = programCardCapableClients.delete(clientId);
    dropGoneProgramCardClients();
    if (!had) return;
    const at = Date.now();
    const deadLinkDones = closeCode === 1006
      ? [...cardBuildDoneSentAtMs].filter(([, sentAt]) => at - sentAt <= CARD_BUILD_DEAD_LINK_MS)
      : [];
    if (programCardCapableClients.size > 0) {

      for (const [otherId, identifiedAt] of programCardCapableClients) {
        const owed = new Set(deadLinkDones.filter(([, sentAt]) => identifiedAt > sentAt).map(([chat]) => chat));
        if (owed.size > 0) replayChatCardBuilds(otherId, owed);
      }
      return;
    }
    programCardClientLeftAtMs = at;
    if (closeCode !== 1006) return;
    for (const [chat] of deadLinkDones) noteCardBuildDoneMissed(chat);
    cardBuildDoneSentAtMs.clear();
  }

  function programCardClientAwayMs()                {
    dropGoneProgramCardClients();
    if (programCardClientLeftAtMs === null || connectedAppClientHas(PROGRAM_CARD_CAPABILITY)) return null;
    return Math.max(0, Date.now() - programCardClientLeftAtMs);
  }

  const programCardFrameDraws = new Map                                ();
  programCardResponseChannel.on((outcome     ) => {
    const settle = programCardFrameDraws.get(outcome?.requestId);
    if (settle) settle(outcome);
  });
  function drawSavedCardFrame(code        )               {
    const requestId = `frame-redo-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      let timer      = null;
      const settle = (outcome     ) => {
        programCardFrameDraws.delete(requestId);
        if (timer) clearTimeout(timer);
        if (!outcome?.ok) return resolve({ ok: false, error: String(outcome?.error ?? "frame_sandbox").slice(0, 400) });
        const result = outcome.result ?? {};
        const bytes = (field        ) => (typeof result[field] === "string" ? new Uint8Array((globalThis       ).Buffer.from(result[field], "base64")) : null);
        const screen = bytes("screen");
        if (screen && screen.length === FRAME_SCREEN_CELLS) return resolve({ ok: true, screen, out: result.out });
        const grid = bytes("grid");
        if (grid && grid.length === FRAME_GRID_CELLS) return resolve({ ok: true, screen: frameScreenFromGrid(grid), out: result.out });
        resolve({ ok: false, error: "frame_sandbox: the phone sent no screen" });
      };
      programCardFrameDraws.set(requestId, settle);
      timer = setTimeout(() => settle({ ok: false, error: "timeout" }), PROGRAM_CARD_FRAME_REDO_DRAW_TIMEOUT_MS);
      try {
        sendProgramCardRequest({ sessionKey: FRAME_REDO_SESSION_KEY, requestId, title: "", source: "", why: "", op: "frame_draw", payload: { code } });
      } catch (err     ) {
        settle({ ok: false, error: err?.code === "unsupported" ? "unsupported" : "no_client" });
      }
    });
  }
  function programCardFrameCompleteFn() {
    return gatewayBridge && gatewayBridge.kind === "hermes"
      ? (params     ) => gatewayBridge.request("program_card.frame.llm.complete", params)
      : opts.inputPrediction && typeof opts.inputPrediction.llmComplete === "function"
        ? (params     ) => opts.inputPrediction.llmComplete(params)
        : null;
  }

  const programCardArt = createProgramCardArt({
    host: () => (gatewayBridge?.kind === "hermes" ? "hermes" : "openclaw"),

    takesDetail: () => programCardFrameCompleteFn() !== null,
    store: createProgramCardArtStore({ libraryDir: opts.liveuiLibraryDir }),
    send: (clientId        , frame     ) => {
      if (server?.getAppClientIds?.().includes(clientId)) server.unicast(clientId, JSON.stringify(frame));
    },
    emit: (event        , level        , data     ) => emitDebug("glasses.lifecycle", event, level || "debug", {}, () => ({ ...(data || {}) })),
  });
  const programCardFrameBriefs = createFrameBriefMemory();
  const programCardFrameRedo = createProgramCardFrameRedo({
    saves: programCardSaves,
    complete: programCardFrameCompleteFn,
    canDraw: () => connectedAppClientHas(PROGRAM_CARD_FRAME_DRAW_CAPABILITY),
    canIdea: () => connectedAppClientHas(PROGRAM_CARD_FRAME_IDEA_CAPABILITY),
    draw: drawSavedCardFrame,
    notify: (event     ) => { if (server) server.broadcast(formatProgramCardFrame(event)); },
    saved: (appId        ) => {
      broadcastCardRevisionChanged(appId);

      followCardRevision(appId, "frame_redraw");
    },

    changed: (change     ) => {
      programCardFrameChangedChannel.emit(() => change);
    },
    recall: (game        ) => programCardFrameBriefs.recall(game),
    detail: () => programCardArt.detail(),
    debug: (event        , severity        , data     , sessionKey        ) =>
      emitDebug("relay.session", event, severity, { sessionKey }, () => data),
  });

  function dispatchOcuClawUserSendOnce(params      = {}) {
    const id = params.id;
    const text = params.text;
    const sessionKey = params.sessionKey;
    const attachment = params.attachment || null;
    const clientDisplaySignals = params.clientDisplaySignals || null;
    const resolvedSessionKey = sessionKey || sessionService.ensureSessionKey();

    cardBuildPhases.requestOrigin({ sessionKey: resolvedSessionKey, origin: params.origin });

    if (params.cardChange?.again !== true) noteWearerWords(resolvedSessionKey, text);

    dropCardCheckAsk(resolvedSessionKey);

    if (params.cardChange && !params.cardChangeOpened) {
      return openCardChangeForSend(resolvedSessionKey, params.cardChange.appId, text, params.cardChange.again === true)
        .then(()      => dispatchOcuClawUserSendOnce({ ...params, sessionKey: resolvedSessionKey, cardChangeOpened: true }));
    }

    if (params.taskBuild) broadcastCardBuild(cardBuildPhases.requestTask({ sessionKey: resolvedSessionKey,
      task: taskBuildWithFix(taskBuildWithPart(params.taskBuild),
        typeof params.firstUseClientId === "string" ? params.firstUseClientId : null, resolvedSessionKey) }), "task");
    const questionAnswer =
      !attachment && !!openClawQuestionRouter && openClawQuestionRouter.handleText(resolvedSessionKey, text);

    const decisionAnswer =
      !attachment && !questionAnswer && !!demandRouter && demandRouter.handleText(resolvedSessionKey, text);
    if (questionAnswer || decisionAnswer) {
      relayOperationRegistry.markStarted(id);
      relayOperationRegistry.markUpstreamAck(id, { status: "question_answered" });
      conversationState.addMessage("user", buildLocalUserMessageContent(text, null));
      broadcastPages();
      emitDebug(
        "glasses.lifecycle",
        "question_text_answered",
        "info",
        { sessionKey: resolvedSessionKey },
        () => ({ messageId: id, textChars: typeof text === "string" ? text.length : 0, decision: decisionAnswer }),
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
    if (resolvedSessionKey) {
      const displaySignals = clientDisplaySignals || {};
      if (clientDisplaySignals) {
        sessionService.recordNeuralSessionNamesEnabled(
          resolvedSessionKey,
          clientDisplaySignals.neuralSessionNamesEnabled !== false,
        );
      }

      sessionService.recordDisplayToggleStates(resolvedSessionKey, {
        emoji: displaySignals.neuralEmojiReactorState === "active",
        pace: displaySignals.neuralPaceModulatorState === "active",
        beat: displaySignals.neuralPaceModulatorState === "active",
        speck: displaySignals.neuralSpeckReactorState === "active",
      });
    }

    const startDisplaySignals = sessionService.getDisplayStartStates(resolvedSessionKey);
    const frozenOcuClawPrompt = stablePromptSnapshots.getOrCreate(
      resolvedSessionKey,

      resolvedSessionKey,
      () => computeStableChannelOne(startDisplaySignals),
    );
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

    fireSurfaceDecision(resolvedSessionKey, text, id);
    webJevShadow.fire(resolvedSessionKey, text, id);

    if (typeof upstreamRuntime.prefetchLiveUiVideo === "function") {
      try {
        upstreamRuntime.prefetchLiveUiVideo(text);
      } catch {

      }
    }

    noteJevActivity("send", { warm: false });

    return maybeSeedOcuClawSessionConfig(resolvedSessionKey)

      .then(() => cardBuildTurns.beforeTurn(resolvedSessionKey, isCardWorkTurn(resolvedSessionKey, params)))
      .then(() => {

      agentTurnTracker.markBusy(resolvedSessionKey);
      const gateQueuedAt = Date.now();
      let upstreamDispatchedAt      = null;
      let localPublishDoneAt      = null;
      let localPublishDebugEmitted = false;
      const emitLocalPublishTiming = () => {
        if (
          localPublishDebugEmitted ||
          !Number.isFinite(upstreamDispatchedAt) ||
          !Number.isFinite(localPublishDoneAt)
        ) return;
        localPublishDebugEmitted = true;
        emitDebug(
          "relay.protocol",
          "send_local_publish",
          "debug",
          { sessionKey: resolvedSessionKey },
          () => ({
            messageId: id,
            upstreamDispatchMs: upstreamDispatchedAt - sendStartedAt,
            heldMs: Math.max(0, upstreamDispatchedAt - gateQueuedAt),
            localPublishMs: localPublishDoneAt - gateQueuedAt,
            onSendSyncMs: localPublishDoneAt - sendStartedAt,
            hasAttachment,
            deferredUntilAccepted: materializesHermesDraft,
          }),
        );
      };
      const upstreamPromise = sessionService.dispatchUserSend(
        resolvedSessionKey,
        () => {
          upstreamDispatchedAt = Date.now();
          if (params.firstUsePhoneOrigin === true) {
            let phone      = null;
            try {
              const current = readSetupPhone();
              if (current.clientId === params.firstUseClientId) phone = current;
            } catch (_) {  }
            observeFirstUse("sent", {
              backend: getActiveBackendKind(), source: params.source, sessionKey: resolvedSessionKey, messageId: id, phone,
              gatewaySessionKey: scopeOpenClawSessionKey(resolvedSessionKey, stableSendOptions(resolvedSessionKey, frozenOcuClawPrompt)),
            });
          }
          emitLocalPublishTiming();
          agentTurnTracker.markBusy(resolvedSessionKey);
          const promptTurnTicket =
            typeof text === "string" && text.trimStart().startsWith("/")
              ? null
              : promptTurnOwnership.begin(resolvedSessionKey, {
                  owner: "ocuclaw",
                  lane: "logical-session-frozen",
                  replyLanguage: clientDisplaySignals?.replyLanguage,

                  cardCheck: params.cardCheck ? id : undefined,
                });

          if (params.cardCheck) noteCardCheckAsk(resolvedSessionKey, params.cardCheck, text, id);
          try {
            return Promise.resolve(gatewayBridge.sendMessage(
              text,
              resolvedSessionKey,
              attachment,
              {
                ...stableSendOptions(
                  resolvedSessionKey,
                  frozenOcuClawPrompt,
                ),
                diagnostic: buildOcuClawSendDiagnostic({
                  ...params,
                  sessionKey: resolvedSessionKey,
                }),
              },
            )).then((result     ) => {
              const status = result && typeof result.status === "string"
                ? result.status.trim().toLowerCase()
                : "accepted";
              if (status !== "accepted" && status !== "queued") {
                promptTurnOwnership.cancel(promptTurnTicket);

                if (params.cardCheck) dropCardCheckAsk(resolvedSessionKey, id);
              }
              return result;
            }, (err     ) => {
              promptTurnOwnership.cancel(promptTurnTicket);
              if (params.cardCheck) dropCardCheckAsk(resolvedSessionKey, id);
              throw err;
            });
          } catch (err) {
            promptTurnOwnership.cancel(promptTurnTicket);
            if (params.cardCheck) dropCardCheckAsk(resolvedSessionKey, id);
            throw err;
          }
        },
      );

      const publishLocalUserMessage = () => {
        const userContent = buildLocalUserMessageContent(text, attachment);
        conversationState.addMessage("user", userContent, null, {
          clientSendId: id,
        });

        if (typeof conversationState.markUserSendPending === "function") {
          conversationState.markUserSendPending(id);
        }
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
      localPublishDoneAt = Date.now();
      emitLocalPublishTiming();

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
          observeFirstUse("ack", id, result);
          const ackStatus = result && typeof result.status === "string"
            ? result.status.trim().toLowerCase()
            : "accepted";
          if (ackStatus !== "accepted" && ackStatus !== "queued") settlePendingUserSend(id);
          const runId = result && result.runId ? result.runId : null;

          if (params.sentByAppClient === true) {
            replyDelivery.noteRunOrigin(runId, params.firstUseClientId);
          }
          if (
            runId &&
            conversationState &&
            typeof conversationState.bindRunIdToClientSendId === "function"
          ) {
            if (conversationState.bindRunIdToClientSendId(id, runId)) {
              broadcastEntriesForActiveLedgerClients("run_id_bound");
            }
          }
          relayOperationRegistry.markUpstreamAck(id, {
            runId,
            status: result && result.status ? result.status : null,
          });
          if (runId && upstreamRuntime) {
            upstreamRuntime.trackAcceptedRun({
              runId,
              modelSitesAllowed: (params.source === "phone_ui" && params.firstUsePhoneOrigin === true)
                || (params.source === "hybrid_voice_endpoint" && params.modelSitesWearerOrigin === true),
              sessionKey: resolvedSessionKey,
              messageId: id,
              sendStartedAt,
              ackAt,
            });
          }

          if (runId) surfaceDecisionStore.noteRun(resolvedSessionKey, id, runId);

          if (
            runId &&
            (ackStatus === "accepted" || ackStatus === "queued") &&
            params.source !== "liveui_task" &&
            !params.taskBuild
          ) {
            liveUiAskedWords.noteRun(runId, text);
          }
          if (runId) webJevShadow.noteRun(resolvedSessionKey, id, runId);

          if (runId && params.cardChange) cardBuildPhases.changeSendRun({ sessionKey: resolvedSessionKey, runId });

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
          observeFirstUse("failed", id);
          settlePendingUserSend(id);
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

    if (upstreamRuntime && typeof upstreamRuntime.noteLiveUiV2Stop === "function") {
      upstreamRuntime.noteLiveUiV2Stop(sessionKey);
    }
    const gatewaySession = openclawGatewayKeyFor(sessionKey);
    const request = {
      key: gatewaySession.key,
      ...(gatewaySession.agentId ? { agentId: gatewaySession.agentId } : {}),
    };
    return gatewayBridge.request("sessions.abort", request).then(
      (result) => {

        if (result && result.aborted === true) hermesClarifyRouter?.stopSession(sessionKey);
        return {
          status: "accepted",
          ...(result && typeof result === "object" ? result : {}),
        };
      },
    );
  }

  function dispatchOcuClawSessionSteer(params      = {}) {
    const requestId = params.requestId;
    const steerStartedAt = Date.now();
    const sessionKey =
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : sessionService.ensureSessionKey();

    cardBuildPhases.requestOrigin({ sessionKey, origin: params.origin });
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
            modelSitesAllowed: params.wearerOrigin === true && !pendingRemoteSendRunBindings.has(requestId),
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

  let server      = null;
  function botScreenJevDecide() {
    if (!jevFeaturesArmed({ botScreenJev: opts.botScreenJev })) return null;
    const client = (opts.jevClientFactory || createJevClient)({
      apiKey: opts.botScreenJev.apiKey,
      enabled: true,
      model: BOT_SCREEN_AIM_MODEL,
      connection: jevConnection,
    });
    return (state     , callOptions     ) => {
      noteJevActivity("bot_screen_jev", { warm: false });
      return client.decide(state, callOptions);
    };
  }

  const profileBotScreenSource = opts.botScreenProfileRouting === true && typeof opts.botScreenRequest === "function"
    ? createProfileBotScreenSource({
      profile: (clientId        ) => {
        const key = server?.getClientSessionKey?.(clientId);
        const parsed = key ? parseHermesPublicKey(key) : null;

        return key && !parsed ? "!invalid" : hermesProfileIdForNamespace(parsed?.namespace || DEFAULT_HERMES_NAMESPACE);
      },
      session: (clientId        ) => server?.getClientSessionKey?.(clientId) || null,
      pairingId: crypto.createHash("sha256").update(String(opts.token || "")).digest("hex"),
      stateDir: opts.stateDir,
      clarify: (sessionKey        ) => {
        const surface = hermesClarifyRouter?.activeSurfaceId(sessionKey);
        return typeof surface === "string" && surface.startsWith("hermes-clarify:") ? surface.slice("hermes-clarify:".length) : null;
      },
      continueBot: async ({ sessionKey, clarifyId }     ) => {
        const parsed = parseHermesPublicKey(sessionKey);
        if (!parsed) throw new Error("invalid_source_session");
        if (clarifyId) {
          const answer = await gatewayBridge.request("clarify.resolve", { id: clarifyId, response: "Done, carry on." });
          if (answer?.status === "accepted") return;
        }
        await gatewayBridge.sendMessage("Done, carry on.", sessionKey, null);
      },
      request: opts.botScreenRequest,
      send: (clientId        , frame        ) => server?.unicast?.(clientId, frame),
      trace: (event        , data     ) => emitDebug("glasses.lifecycle", event, "debug", {}, () => data),
      clients: () => server?.getAppClientIds?.() || [],

      jevDecide: botScreenJevDecide(),
      jevBudgetMs: opts.botScreenJev?.budgetMs,
      jevWarm: () => noteJevActivity("bot_screen_jev"),
    }) : null;
  const botScreenSource = profileBotScreenSource || (opts.botScreen && typeof opts.botScreen === "object"
    ? createBotScreenSource({
      socket: typeof opts.botScreen.socket === "string" ? opts.botScreen.socket : null,
      probe: opts.botScreen.probe || null,
      request: typeof opts.botScreenRequest === "function" ? opts.botScreenRequest : null,
      send: (clientId        , frame        ) => {
        if (server && typeof server.unicast === "function") server.unicast(clientId, frame);
      },
      trace: (event        , data     ) => emitDebug("glasses.lifecycle", event, "debug", {}, () => data),
      clients: () => (server && typeof server.getAppClientIds === "function" ? server.getAppClientIds() : []),
    })
    : null);

  if (botScreenSource && gatewayBridge && typeof gatewayBridge.on === "function") {
    gatewayBridge.on(BOT_SCREEN_TARGET_EVENT, (data     ) => botScreenSource.target(data));
    gatewayBridge.on(BOT_SCREEN_STEP_EVENT, (data     ) => botScreenSource.step(data));
    gatewayBridge.on(BOT_SCREEN_ELEMENTS_EVENT, (data     ) => botScreenSource.elements(data));

    gatewayBridge.on(BOT_SCREEN_RUN_EVENT, (data     ) => botScreenSource.run(data));
  }
  let evenAiEndpoint = null;
  let evenAiRouter = null;
  let evenAiRunWaiter = null;
  let evenAiRestartRecovery = null;
  const pendingBufferedEvenAiResponses = new Map();
  let observationBroadcastPending = false;
  const evenAiRequestObservation = createEvenAiRequestObservation({
    stateDir: opts.stateDir,
    captureCoverage: (sinceMs     ) => debugStore.captureCoverage("evenai", sinceMs),
    diagnostic: (data     ) => emitDebug("evenai", "even_ai_test_summary", "info", {}, () => data),
    readContext() {

      const { trackedThrowawayKeys: _tracked, ...settings } = getEvenAiEndpointSettingsSnapshot();
      return {
        settings,
        backend: getActiveBackendKind(),
        credential: opts.evenAiToken,
        enabled: opts.evenAiEnabled,
        activeSession: settings.routingMode === "active" ? sessionService.peekSessionKey() : null,
      };
    },
    readProofContext() {
      const { trackedThrowawayKeys: _tracked, ...settings } = getEvenAiEndpointSettingsSnapshot();
      return { settings, backend: getActiveBackendKind(), credential: opts.evenAiToken, enabled: opts.evenAiEnabled,
        activeAgent: settings.routingMode === "active" ? sessionService.getSessionAgentId(sessionService.peekSessionKey(), undefined) : null };
    },
    onChange() {
      if (observationBroadcastPending) return;
      observationBroadcastPending = true;
      getCapabilityAgentCatalogSnapshot().then((catalog) => {
        observationBroadcastPending = false;
        broadcastCapabilitySnapshot(catalog);
      });
    },
  });
  let relayApi      = null;

  async function applyOcuClawSettingsPatch(patch = {}) {
    let localPatch = patch;

    if (
      Object.prototype.hasOwnProperty.call(patch || {}, "liveReasoning") &&
      !(getActiveBackendKind() === "hermes" && typeof opts.setOcuClawProfileOptions === "function")
    ) {
      localPatch = { ...patch };
      Reflect.deleteProperty(localPatch, "liveReasoning");
      patch = localPatch;
    }
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
          key === "confirmModelSelection" ||

          key === "liveReasoning"
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
    pushApprovalExplainSetting();
    pushWaitingSettings();
    const settings = await getOcuClawSettingsSnapshot();
    const result = { status: "accepted", settings };
    evenAiRequestObservation.refresh();
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
      demandRouter?.forgetAll("switch_session");
      if (upstreamRuntime && typeof upstreamRuntime.clearTyping === "function") {
        upstreamRuntime.clearTyping("switch_session");
      }
      if (upstreamRuntime && typeof upstreamRuntime.handleSessionChanged === "function") {
        upstreamRuntime.handleSessionChanged("switch_session");
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

  const openClawAgentCreator = createOpenClawAgentCreator({
    gatewayBridge,
    backendKind: getActiveBackendKind,
    isConnected: () => upstreamRuntime?.isConnected?.() === true,
    refreshAgentsCatalog: (force     ) => upstreamRuntime?.refreshAgentsCatalog?.(force),
    onCatalogRefreshError: ({ error }     ) => {
      logger.warn(`[relay] OpenClaw agent created but catalog refresh failed: ${error?.message || error}`);
    },
  });
  const openClawAgentEmojiUpdater = createOpenClawAgentEmojiUpdater({
    gatewayBridge,
    backendKind: getActiveBackendKind,
    isConnected: () => upstreamRuntime?.isConnected?.() === true,
    refreshAgentsCatalog: (force     ) => upstreamRuntime?.refreshAgentsCatalog?.(force),
    onCatalogRefreshError: ({ error }     ) => {
      logger.warn(`[relay] Agent emoji updated but catalog refresh failed: ${error?.message || error}`);
    },
  });
  const openClawAgentSettings = createOpenClawAgentSettings({
    gatewayBridge,
    backendKind: getActiveBackendKind,
    isConnected: () => upstreamRuntime?.isConnected?.() === true,
    refreshAgentsCatalog: (force     ) => upstreamRuntime?.refreshAgentsCatalog?.(force),
    onCatalogRefreshError: ({ error }     ) => {
      logger.warn(`[relay] Agent settings updated but catalog refresh failed: ${error?.message || error}`);
    },
  });
  const openClawAgentDefaults = createOpenClawAgentDefaults({
    gatewayBridge,
    backendKind: getActiveBackendKind,
    isConnected: () => upstreamRuntime?.isConnected?.() === true,
  });

  const openClawManagement = createOpenClawManagement({
    gatewayBridge,
    getHello: () => gatewayBridge.rawClient?.getHelloFeatures?.() ?? null,
    isConnected: () => getActiveBackendKind() === "openclaw" && upstreamRuntime?.isConnected?.() === true,
    getAgents: async () => (await upstreamRuntime?.getAgentsCatalogSnapshot?.())?.agents || [],
    agentTools: openClawAgentSettings,
    agentDefaults: openClawAgentDefaults,

    taskSchedulesAvailable: () => openClawTaskSchedule.available() === true,

    taskPagesWatched: () => openClawTaskSchedule.pageWatchAvailable() === true,

    beforeCapabilities: () => openClawTaskSchedule.settle(),
  });

  const openClawTaskSchedulesOn = () => getActiveBackendKind() === "openclaw" &&
    ocuClawSettingsStore.getSnapshot().openclawTaskSchedules === true;

  const openClawTaskSchedule = createOpenClawTaskSchedule({
    ctx: openClawManagement.context,
    enabled: openClawTaskSchedulesOn,
    getAgents: async () => (await upstreamRuntime?.getAgentsCatalogSnapshot?.())?.agents || [],
    onJobOwned: (jobId        , taskId        ) => {

      taskJobMemory.note(jobId, taskId);
      openClawTaskResults.noteOwned(jobId, taskId);
    },
    onJobDeleted: (jobId        ) => {

      taskJobMemory.note(jobId, taskJobMemory.taskOf(jobId) || "deleted-task");
      openClawTaskResults.dropJob(jobId);
    },

    onJobReplaced: (oldId        , newId        ) => {

      taskJobMemory.note(oldId, taskJobMemory.taskOf(oldId) || taskJobMemory.taskOf(newId) || "replaced-task");
      openClawTaskResults.moveJob(oldId, newId);
    },

    onTestEnded: (jobId        ) => openClawTaskResults.dropTestJob(jobId),
    contextFrom: (jobId        , profileId        , starter     ) => openClawDayWrap.contextFrom(jobId, profileId, starter),
  });

  const taskToolLedger = createTaskToolLedger();

  const taskAlertMemory = createTaskAlertMemory({ stateDir: opts.stateDir, fs, path, logger });
  const alertTaskOf = (field                    , id     , schedules      = undefined) => {
    if (typeof id !== "string" || !id) return null;
    const rows = schedules !== undefined ? schedules : taskHandler()?.listTaskSchedules?.() || [];
    const task = Array.isArray(rows) ? rows.find((row     ) => row && row[field] === id) : null;
    return task && task.kind === "alert" ? task : null;
  };

  const taskAlertRunEnd = (jobId     , run     , schedules      = undefined)                => {
    try {
      if (!alertTaskOf("jobId", jobId, schedules)) return null;
      const verdict = taskAlertMemory.runEnd(jobId, run);
      logger.info(`[task-alert] job=${jobId} verdict=${verdict} state=${run && run.state ? "given" : "none"}`);
      return verdict;
    } catch (_) {

      return null;
    }
  };

  const taskAlertRepeat = (result     , schedules      = undefined)          => {
    try {
      if (!alertTaskOf("taskId", result && result.taskId, schedules) &&
        !alertTaskOf("jobId", result && result.jobId, schedules)) return false;
      const repeat = taskAlertMemory.isRepeat(result);
      if (repeat) logger.info(`[task-alert] job=${result.jobId} repeat result=${result.resultId} held`);
      return repeat;
    } catch (_) {
      return false;
    }
  };
  const openClawTaskResults = createOpenClawTaskResults({

    alertRunEnd: (jobId        , run     ) => taskAlertRunEnd(jobId, run),
    stateDir: opts.stateDir,
    enabled: openClawTaskSchedulesOn,
    ctx: openClawManagement.context,
    push: (params     ) => openClawTaskPush.methods[LINK_TASK_RESULT_PUSH_METHOD](params),

    onRunChanged: () => openClawTaskRowsBroadcast.ring(),

    onTestResult: (params     ) => liveuiTaskTests.onResult(params),

    toolFailuresOf: (sessionKey        , sinceMs               ) => {
      const run = `cron:${sessionKey}`;
      const failures = taskToolLedger.failures(run, sinceMs);
      taskToolLedger.drop(run);
      return failures;
    },

    toolsRanOf: (sessionKey        ) => taskToolLedger.ran(`cron:${sessionKey}`),
    logger,
  });
  const taskHandler = () => getRegisteredGlassesUiHandler()       ;

  let hostTaskJobRunner      = null;
  const taskJobRunner = () => {
    const registered = taskHandler();
    if (typeof registered?.runTaskScheduleNow === "function") return registered;
    return typeof hostTaskJobRunner?.runTaskScheduleNow === "function" ? hostTaskJobRunner : null;
  };

  const taskUncheckedRuns = ()                      => {
    const out                      = {};
    const keep = (taskId     , failure     ) => {
      if (typeof taskId === "string" && failure && (!out[taskId] || failure.atMs > out[taskId].atMs)) out[taskId] = failure;
    };
    try {
      for (const binding of programCardFeed?.store?.list?.() || []) {
        if (binding?.last) keep(binding.taskId, taskUncheckedRunFailure(binding.last.values, binding.last.unchecked, binding.last.atMs));
      }
    } catch (_) {  }
    try {
      const handler = taskHandler();
      for (const schedule of handler?.listTaskSchedules?.() || []) {
        if (typeof schedule?.lookTemplateId !== "string" || typeof handler.readDeliveredTemplateValues !== "function") continue;
        const file = handler.readDeliveredTemplateValues(schedule.lookTemplateId, { owner: liveuiTemplateValuesOwner({ taskId: schedule.taskId }) });
        if (file) keep(schedule.taskId, taskUncheckedRunFailure(file.values, file.unchecked, file.deliveredAtMs));
      }
    } catch (_) {  }
    return out;
  };

  const taskRunPrompt = (jobId     , schedules      = undefined, host                = null)                => {
    try {
      const rows = schedules !== undefined ? schedules : taskHandler()?.listTaskSchedules?.() || [];
      const blocks = taskRunPromptNamed(jobId, {
        schedules: rows,
        cardBound: (taskId        ) => (programCardFeed?.store?.list?.() || []).some((binding     ) => binding?.taskId === taskId),
        host,
      });
      if (!blocks.length) return null;

      logger.info(`[task-run-prompt] job=${jobId} blocks=${blocks.map((block) => block.name).join(",")}`);
      return blocks.map((block) => block.text).join("\n\n");
    } catch (_) {

      return null;
    }
  };
  const openClawDayWrap = createOpenClawDayWrapLink({
    enabled: openClawTaskSchedulesOn,
    starterJobs: () => taskHandler()?.listTaskStarterJobs?.() || [],
    recentResults: (jobId        ) => openClawTaskResults.store.recentForJob(jobId),
    logger,
  });
  const openClawTaskPush = createHermesTaskPush({
    relay: { sendTaskPushMessage: (task     , clientId      ) => relayApi ? relayApi.sendTaskPushMessage(task, clientId) : 0 },
    link: openClawTaskResults.link,
    logger,
    isQuiet: (taskId     ) => taskHandler()?.isTaskScheduleQuiet?.(taskId) === true,

    isRepeat: (result     ) => taskAlertRepeat(result),
    taskFor: (result     ) => taskHandler()?.taskForTaskResult?.(result) ?? null,
    popupUntilFor: (result     ) => taskPopupUntilMs(result, taskHandler()?.listTaskSchedules?.() || []),

    onResult: (result     ) => taskRunsWeek?.onResult(result),

    onResultCard: (pushed     ) => {

      let toolFailures      = null;
      try {
        toolFailures = openClawTaskResults.store.get(pushed?.id)?.toolFailures || null;
      } catch (_) {  }
      const result = toolFailures ? { ...pushed, toolFailures } : pushed;

      feedCardFromScheduledResult({
        result,
        taskFor: (r     ) => taskHandler()?.taskForTaskResult?.(r) ?? null,
        deliver: (params     ) => programCardFeed ? programCardFeed.deliverTaskResult(params) : null,
        logger,
      });
      const kept      = taskHandler()?.onTaskResultDelivered?.(result);
      return kept && kept.status === "written" && typeof kept.templateId === "string" ? kept.templateId : null;
    },
  });
  const openClawTaskRows = createHermesTaskRows({
    link: openClawTaskResults.link,
    logger,
    schedules: () => taskHandler()?.listTaskSchedules?.() || [],
    setLook: (taskId     , look     ) => taskHandler()?.setTaskLook?.(taskId, look) ?? null,
    cardRuns: () => taskCardRuns.snapshot(),
    uncheckedRuns: () => taskUncheckedRuns(),
    leftOut: (taskId        ) => taskLeftOut(taskId),

    onJobRuns: (list     ) => taskRunsWeek?.onJobRuns(list),
  });
  const openClawTaskRowsBroadcast = createTaskRowsBroadcast({
    read: () => openClawTaskRows.read(),
    send: (frame     ) => (relayApi ? relayApi.sendTaskRowsFrame(frame) : 0),
    logger,
  });

  gatewayBridge.on("gatewayEvent", (data     ) => {
    if (getActiveBackendKind() !== "openclaw") return;

    if (data && data.event === "skills.changed") upstreamRuntime?.invalidateSkillsCatalog?.("skills_changed");
    if (!server) return;
    const notice = openClawManagement.eventNotice(data && data.event);
    if (notice) server.broadcast(JSON.stringify({ type: "ocuclaw.management.event", ...notice }));
  });

  const sessionDriverListeners = new Set();
  const sessionDriverWatch = createSessionDriverWatch({
    logger,
    request: (key     ) => gatewayBridge.request("sessions.driver", { key }),
    onState: (snapshot     ) => {
      if (server && handler && typeof handler.formatSessionDriverState === "function") {
        server.broadcast(handler.formatSessionDriverState(snapshot));
      }
      for (const listener of sessionDriverListeners) {
        try { if (typeof listener === "function") listener(); } catch {  }
      }
    },
    onDebug: (event     , data     ) => {
      emitDebug(
        "app.timeline",
        "session_driver",
        "info",
        { sessionKey: (data && data.key) || sessionService.peekSessionKey() || null },
        () => ({ event, ...data, diagnostics: sessionDriverWatch.diagnostics() }),
      );
    },
  });

  const sessionMirrorWatch = createSessionMirrorWatch({
    logger,
    readWatermark: (key     ) => gatewayBridge.request("chat.watermark", { sessionKey: key }),
    readTail: (key     , afterId     , limit     , order     ) =>
      gatewayBridge.request("chat.history", { sessionKey: key, afterId, limit, ...(order ? { order } : {}) }),
    isOwnTurnActive: () => {
      const snapshot = sessionDriverWatch.snapshot();
      return !!(
        snapshot &&
        snapshot.inflight === true &&
        (!snapshot.inflightPlatform || snapshot.inflightPlatform === "ocuclaw")
      );
    },
    onRows: (rows     , info     ) => {
      if (!upstreamRuntime || typeof upstreamRuntime.ingestMirroredRows !== "function") return;
      upstreamRuntime.ingestMirroredRows(rows, {
        sessionKey: info.sessionKey,
        author: MIRROR_AUTHOR,
        origin: MIRROR_ORIGIN,
      });
    },
    onRehydrate: (info     ) =>
      upstreamRuntime && typeof upstreamRuntime.rehydrateHistory === "function"
        ? upstreamRuntime.rehydrateHistory(info.sessionKey, info.reason)
        : Promise.resolve(false),
    onDebug: (event     , data     ) => {
      emitDebug(
        "app.timeline",
        "session_mirror",
        "info",
        { sessionKey: (data && data.key) || sessionService.peekSessionKey() || null },
        () => ({ event, ...data, diagnostics: sessionMirrorWatch.diagnostics() }),
      );
    },
  });

  gatewayBridge.on("activity", (data     ) => {
    if (data && data.runId && sessionMirrorWatch.armedKey()) {
      sessionMirrorWatch.noteOwnActivity(data.sessionKey || null, "activity");
    }
  });
  gatewayBridge.on("message", (data     ) => {
    if (data && data.runId && sessionMirrorWatch.armedKey()) {
      sessionMirrorWatch.noteOwnActivity(data.sessionKey || null, "message_commit");
    }
  });

  function syncSessionDriverWatch(reason      = "status") {
    const current = sessionService.peekSessionKey();
    const wantArmed =
      getActiveBackendKind() === "hermes" &&
      typeof current === "string" &&
      isAdoptedHermesSessionKey(current);
    if (wantArmed) {
      if (sessionDriverWatch.armedKey() !== current) {
        sessionDriverWatch.arm(current).catch((err     ) => {
          logger.warn(`[relay] session driver watch arm failed (${reason}): ${err && err.message}`);
        });
      }
      if (sessionMirrorWatch.armedKey() !== current) {
        sessionMirrorWatch.arm(current).catch((err     ) => {
          logger.warn(`[relay] session mirror watch arm failed (${reason}): ${err && err.message}`);
        });
      }
    } else {
      if (sessionDriverWatch.armedKey()) sessionDriverWatch.disarm();
      if (sessionMirrorWatch.armedKey()) sessionMirrorWatch.disarm();
    }
  }

  function readinessClientEntry(clientId     ) {
    const snapshot =
      server && typeof server.getReadinessSnapshot === "function"
        ? server.getReadinessSnapshot()
        : null;
    return snapshot && Array.isArray(snapshot.clients)
      ? snapshot.clients.find((client     ) => client && client.clientId === clientId) || null
      : null;
  }

  const sessionHandlers = createRelaySessionHandlers({
    sessionService,
    broadcastSessions,
    hermesEnrollment,
    stablePromptSnapshots,
    logger,
    simulation,
    conversationState,
    switchToSessionAndRunPostSwitchFlow,
    mintAgentRefs,
    emitDebug,
    clearCurrentSessionModelConfigSnapshot,
    seedOcuClawSessionConfigForNewSession,
    adoptActiveSessionModelConfig,
    resetActivityStatusAdapter,
    clearLogicalSessionState,
    cachePages,
    openclawGatewayKeyFor,
    gatewayBridge,
    applyNewChatReasoningDefault,
    broadcastEntriesForActiveLedgerClients,
    sessionDriverWatch,
    getCapabilityAgentCatalogSnapshot,
    setPathwayBinding,
    noteAppClientSessionSelected,
    taskResultProposals,
    agentDrafts,
    taskFromWords,
    taskPresentations,
    programCardBindingsSnapshot,
    buildEvenAiSessionsSnapshot,
    get upstreamRuntime() { return upstreamRuntime; },
    get server() { return server; },
    get programCardFeed() { return programCardFeed; },
  });
  const voiceHandlers = createRelayVoiceHandlers({
    opts,
    voiceCredentials,
    relayBackendKind,
    jevConnection,
    noteJevActivity,
    warmJevOnce,
    simulation,
    emitDebug,
    sessionService,
  });
  const liveuiHandlers = createRelayLiveuiHandlers({
    resolveLiveuiGlassesLibraryController,
    programCardSaves,
    privateCardAccess,
    programCardReviewer,
    cardIconPicker,
    logger,
    followCardRevision,
    programCardFrameRedo,
    libraryWithCardKits,
    pushBindingsIfTaskCard,
    clearGlassesUiSurfacesOnly,
    sessionService,
    taskPresentationClientOwns,
    cardDrafts,
    cardBuildPhases,
    clientKitLevel,
    reconcileRepinned,
    programCardUndoRevisions,
    cardStudio,
    noteCardReviewEvent,
    cardReviewRetryOwner,
    noteCardAcceptTest,
    noteCardAccept,
    listLiveuiTaskExecutors,
    pushProgramCardBindings,
    liveUiVideoRoute,
    get server() { return server; },
    get programCardFeed() { return programCardFeed; },
    get liveuiTaskRunController() { return liveuiTaskRunController; },
  });
  const toolingHandlers = createRelayToolingHandlers({
    emitDebug,
    sessionService,
    opts,
    logger,
    debugStore,
    relayBackendKind,
    bundleCache,
    clientEventFoldCache,
    externalDebugToolsEnabled,
    hermesVersion,
    debugUploadMaxZipBytes,
    cardStudioReport,
    resolveSaveDir,
    isDebugBundlePhoneHandoffAllowed,
    writeConsoleLog,
    cardStudio,
    isForcedLiveuiFailureEvent,
    dispatchGlassesUiClientFailure,
    applyDebugSet,
    applyTraceLogSet,
    liveUiTraceFlagPath,
    armRemoteSendRunBinding,
    get server() { return server; },
    get pluginVersionService() { return pluginVersionService; },
    get liveUiTraceLogEnabled() { return liveUiTraceLogEnabled; },
  });
  const programCardHandlers = createRelayProgramCardHandlers({
    logger,
    taskPresentationClientOwns,
    pushProgramCardBindings,
    resolveLiveuiGlassesLibraryController,
    cardDrafts,
    programCardAgentRefresh,
    withCheckAgainAsk,
    taskCheckAgain,
    taskFixSave,
    dispatchProgramCardFeeds,
    emitDebug,
    programCardJev,
    programCardMcp,
    programCardSetupRequests,
    programCardModel,
    programCardArt,
    programCardLocation,
    dispatchLocationResponse,
    dispatchProgramCardResponse,
    dispatchProgramCardLookProgress,
    dispatchProgramCardContext,
    programCardBindingsSnapshot,
    checkAgainAsks,
    clientHasTaskSlots,
    privateCardAccess,
    programCardSaves,
    newTaskCardParts,
    startTaskFix,
    taskFixThrownAway,
    taskFixUndo,
    taskCardLookUndo,
    get taskOpenUpdate() { return taskOpenUpdate; },
    get upstreamRuntime() { return upstreamRuntime; },
    get server() { return server; },
    get programCardFeed() { return programCardFeed; },
    get cardPartLink() { return cardPartLink; },
    get cardPartRuns() { return cardPartRuns; },
    get taskRunsWeek() { return taskRunsWeek; },
  });
  const taskHandlers = createRelayTaskHandlers({
    opts,
    taskCardCreate,
    taskPresentations,
    relayBackendKind,
    seedTaskFromTest,
    openClawTaskSchedulesOn,
    openClawTaskRows,
    programCardSaves,
    pushProgramCardBindings,
    linkCreatedTask,
    openClawTaskSheetAgentId,
    cardPartInputsFor,
    openClawTaskPush,
    logger,
    ringTaskRows,
    taskCardLookUndo,
    savedTaskForCard,
    taskResultProposals,
    agentDrafts,
    taskFromWords,
    get server() { return server; },
    get liveuiTaskTests() { return liveuiTaskTests; },
  });
  const glassesUiHandlers = createRelayGlassesUiHandlers({
    emitDebug,
    setupWelcome,
    resolveLiveuiGlassesLibraryController,
    glassesUiResultChannel,
    liveUiV2Sender,
    logger,
    dispatchGlassesUiResult,
    draftApprovalClients,
    draftBindingCurrent,
    dispatchGlassesUiNavEvent,
    glassesUiRenderReceiptChannel,
    dispatchGlassesUiRenderReceipt,
    appSessionKeysMatch,
    get upstreamRuntime() { return upstreamRuntime; },
    get liveuiTaskRunController() { return liveuiTaskRunController; },
    get server() { return server; },
    get demandRouter() { return demandRouter; },
  });
  const agentHandlers = createRelayAgentHandlers({
    gatewayBridge,
    logger,
    openClawAgentSettings,
    openClawAgentDefaults,
    openClawAgentCreator,
    openClawAgentEmojiUpdater,
    emitDebug,
    hermesEnrollment,
    get upstreamRuntime() { return upstreamRuntime; },
  });
  const catalogHandlers = createRelayCatalogHandlers({
    inputPredictionService,
    sessionService,
    noteJevActivity,
    conversationState,
    emitDebug,
    resetActivityStatusAdapter,
    simulation,
    broadcastPages,
    stablePromptSnapshots,
    clearLogicalSessionState,
    openclawGatewayKeyFor,
    gatewayBridge,
    get upstreamRuntime() { return upstreamRuntime; },
  });
  const setupHandlers = createRelaySetupHandlers({
    opts,
    emitDebug,
    optionalSetupGeneration,
    evenAiRequestObservation,
    jevKeyCheck,
    gatewayBridge,
    modelSitesGeneration,
    modelSitesConnections,
    modelSites,
    get openClawQuestionRouter() { return openClawQuestionRouter; },
  });
  const starMapHandlers = createRelayStarMapHandlers({
    gatewayBridge,
    logger,
    sessionService,
    get server() { return server; },
  });
  const chatTurnHandlers = createRelayChatTurnHandlers({
    gatewayBridge,
    simulation,
    sessionService,
    activeLedgerSnapshot,
    dispatchOcuClawUserSend,
    pendingRemoteSendRunBindings,
    dispatchOcuClawSessionAbort,
    dispatchOcuClawSessionSteer,
    get openClawWaiting() { return openClawWaiting; },
  });
  const settingsHandlers = createRelaySettingsHandlers({
    evenAiSettingsStore,
    savedPromptsStore,
    getOcuClawSettingsSnapshot,
    evenAiRequestObservation,
    applyOcuClawSettingsPatch,
    get server() { return server; },
    get handler() { return handler; },
  });
  const handler = createDownstreamHandler({
    logger,

    approvalPurposeEnabled: () => ocuClawSettingsStore.getSnapshot().explainApprovals !== false,
    externalDebugToolsEnabled,
    getGlassesUiLiveConfig: opts.getGlassesUiLiveConfig,
    getLiveuiHostCheck: () => {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller && typeof controller.liveuiHostCheck === "function"
        ? controller.liveuiHostCheck()
        : null;
    },
    resolveLiveUiSessionContext: currentLiveUiSessionContext,
    defaultEvenAiDedicatedSessionKey,
    getSnapshotRevision(kind) {
      if (kind === "pages") return pagesRevision;
      if (kind === "status") return statusRevision;
      return null;
    },
    ...chatTurnHandlers,
    ...agentHandlers,
    onCreateHermesProfile: createHermesProfile,
    onHermesManagement: hermesManagementRequest,
    getManagementBackendLabel: () => (getActiveBackendKind() === "openclaw" ? "OpenClaw" : "Hermes"),

    onBoardMomentAck(ack     ) {
      if (typeof opts.onBoardMomentAck === "function") opts.onBoardMomentAck(ack);
    },

    onBotScreenMessage: botScreenSource
      ? (clientId     , msg     ) => botScreenSource.handle(clientId, msg)
      : null,
    ...taskHandlers,
    ...setupHandlers,
    ...glassesUiHandlers,
    onGlassesUiRenderError(frame     ) {
      dispatchGlassesUiClientFailure(frame.clientId, frame, frame);
    },
    onReplyRenderReceipt(sender     , receipt     ) {
      replyDelivery.acceptReceipt(sender, receipt);
    },
    onDeviceInfoResponse(frame) {
      dispatchDeviceInfoResponse(frame);
    },
    onPhoneSettingsSnapshot(frame     ) {
      phoneSettingsRoundTrip.onSnapshot(frame);
    },
    onPhoneSettingsResult(frame     ) {
      phoneSettingsRoundTrip.onResult(frame);
    },
    onBotScreenShowResult(frame     ) {
      botScreenShowRoundTrip.onResult(frame);
    },
    onGlassesPresenceChanged(frame     ) {
      dispatchGlassesPresenceChanged(frame);
    },
    ...programCardHandlers,
    onGlassesUiRenderInject(params) {
      sendGlassesUiRender(params);
    },
    onGlassesUiSurfaceUpdateInject(params) {
      sendGlassesUiSurfaceUpdate(params);
    },
    ...sessionHandlers,
    ...toolingHandlers,
    operationRegistry: relayOperationRegistry,

    ...simulation.handlers,

    ...catalogHandlers,

    onInputStarted(_clientId     , input     ) {
      backendPrewarm.noteInputStarted(input);
    },

    ...starMapHandlers,

    ...liveuiHandlers,

    ...programCardSlotHandlers,

    isPhoneClient(clientId     ) {
      const entry = readinessClientEntry(clientId);
      return !!(entry && entry.clientKind === "app");
    },

    clientNameOf(clientId     ) {
      const entry = readinessClientEntry(clientId);
      return entry && typeof entry.clientName === "string" ? entry.clientName : null;
    },

    ...voiceHandlers,

    realtimeTalkLane: createRealtimeTalkLane({
      request: (method     , params     , options     ) => gatewayBridge.request(method, params, options),
      subscribe: (listener     ) => gatewayBridge.on("talkEvent", listener),
      send: (clientId     , frame     ) => { if (server) server.unicast(clientId, frame); },
      backendKind: () => getActiveBackendKind(),
      gatewayKey: () => openclawGatewayKeyFor(sessionService.ensureSessionKey()),
      logger,
    }),

    ttsLane: createTtsLane({
      request: (method     , params     , options     ) => gatewayBridge.request(method, params, options),
      backendKind: relayBackendKind,
      logger,
    }),

    unicast: (clientId     , frame     ) => { if (server) server.unicast(clientId, frame); },

    onGetStatus() {
      return buildStatusObject({ includeDownstreamReadiness: true });
    },

    ...settingsHandlers,

    isUpstreamConnected() {
      return true;
    },

  });

  const pluginVersionService = createPluginVersionService({
    openclawRuntimeVersion: () =>
      opts.inputPrediction && typeof opts.inputPrediction.hostVersion === "string"
        ? opts.inputPrediction.hostVersion
        : undefined,
  });

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

    failStartOnBindConflict: opts.failStartOnBindConflict === true,

    appDisconnectGraceMs: Number.isFinite(opts.liveuiReconnectGraceMs)
      ? opts.liveuiReconnectGraceMs
      : LIVEUI_RECONNECT_GRACE_DEFAULT_MS,
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
    completeBufferedEvenAiHttpRequest,
    onPairingAuthenticatedHello(hello     ) {
      relayPairing.noteAuthenticatedHello(hello);
    },
    getActiveSessionKey() {
      return sessionService.peekSessionKey() || null;
    },
    onAppClientDisconnect(sessionKey) {
      dispatchAppClientDisconnect(sessionKey);
      if (!debugAutoArm && refreshUploadCaptureArming) refreshUploadCaptureArming();
      if (server && server.getConnectedAppCount() === 0) {
        demandRouter.forgetDecisions("client_disconnect");
      }
    },

    onAppClientClosed(clientId     , closed      = null) {
      taskResultProposals.cancel(clientId);
      agentDrafts.cancel(clientId);
      taskFromWords.cancel(clientId);
      taskPresentations?.cancel(clientId);
      inputPredictionService.onClientDisconnect(clientId);
      programCardArt.forget(clientId);
      forgetProgramCardClient(clientId);
      noteProgramCardClientClosed(clientId, closed?.closeCode ?? null);
      programCardModel.disconnect(clientId);
      cardDrafts?.cancelClient(clientId);
      programCardReviewer.cancelClient(clientId);

      replyDelivery.forgetClient(clientId);

      if (botScreenSource) botScreenSource.clientGone(clientId);

      if (upstreamRuntime && typeof upstreamRuntime.noteProgramCardPicturesClientGone === "function") {
        upstreamRuntime.noteProgramCardPicturesClientGone(clientId);
      }
      if (upstreamRuntime && typeof upstreamRuntime.noteLiveUiPictureClientGone === "function") {
        upstreamRuntime.noteLiveUiPictureClientGone(clientId);
      }
    },
    onAppClientIdentified(clientId, entry     ) {
      noteProgramCardClientIdentified(clientId, entry);

      warmJevOnce("client_connect");
      if (upstreamRuntime && typeof upstreamRuntime.refreshSessionAttention === "function") {
        hermesClarifyRouter?.forgetAll("client_reconnect");
        upstreamRuntime.refreshSessionAttention();
      }
      if (!debugAutoArm && refreshUploadCaptureArming) refreshUploadCaptureArming();
      if (appClientSupportsCapabilitySnapshot(entry)) {
        setTimeout(() => unicastCapabilitySnapshot(clientId), 0);
      }

      if (appClientSupportsSecretEntry(entry) && openClawQuestionRouter && server) {
        for (const request of openClawQuestionRouter.secretClientReady()) {
          server.unicast(clientId, formatSecretRequestFrame(request));
        }
      }

      if (supportsTaskPush(entry) && typeof opts.onTaskPushClientReady === "function") {
        try {
          opts.onTaskPushClientReady(clientId);
        } catch (err) {
          logger.warn(`[relay] task push client ready failed: ${String(err)}`);
        }
      } else if (supportsTaskPush(entry) && openClawTaskSchedulesOn()) {

        openClawTaskResults.start();
        openClawTaskPush.clientReady(clientId).catch(() => {});
      }

      if (supportsTaskPush(entry)) {
        const controller = resolveLiveuiGlassesLibraryController();
        if (controller && typeof controller.retryUnsyncedTaskSchedules === "function") {
          Promise.resolve(controller.retryUnsyncedTaskSchedules()).catch(() => {});
        }
      }

      if (Array.isArray(entry?.clientCapabilities) && entry.clientCapabilities.includes(CARD_BUILD_TASK_CAPABILITY)) {
        setTimeout(() => replayTaskCardBuilds(clientId), 0);
      }

      const chatBuildReplay      = setTimeout(() => replayChatCardBuilds(clientId), cardBuildReconnectReplayMs);
      if (typeof chatBuildReplay?.unref === "function") chatBuildReplay.unref();

      const driverSnapshot = sessionDriverWatch.snapshot();
      if (driverSnapshot && server && handler) {
        server.unicast(clientId, handler.formatSessionDriverState(driverSnapshot));
      }

      if (upstreamRuntime && (typeof upstreamRuntime.getActivityReplay === "function" ||
          typeof upstreamRuntime.getActivityPlanReplay === "function")) {
        setTimeout(() => unicastActivityReplay(clientId), 0);
      }

      if (upstreamRuntime && typeof upstreamRuntime.getWaitingReplay === "function") {
        const waitingFrame = upstreamRuntime.getWaitingReplay();
        if (waitingFrame && server) server.unicast(clientId, waitingFrame);

        if (waitingFrame && server && typeof upstreamRuntime.getWaitingExplanationReplay === "function") {
          for (const frame of upstreamRuntime.getWaitingExplanationReplay()) {
            server.unicast(clientId, frame);
          }
        }
      }
      if (
        Array.isArray(entry && entry.clientCapabilities) &&
        entry.clientCapabilities.includes("ledgerV1")
      ) {

        setTimeout(() => {
          const snapshot = activeLedgerSnapshot();
          if (
            snapshot !== null &&
            !!cachedEntries &&
            entriesSessionId === (sessionService.peekSessionKey() || null) &&
            entriesRevision === snapshot.entriesRevision &&
            entriesLastSeq === snapshot.lastSeq
          ) {
            replyDelivery.notifyEntriesChanged();
            return;
          }
          broadcastEntriesForActiveLedgerClients("ledger_client_attached");
        }, 0);
      }
    },
    onAppPresenceChanged(reason     ) {
      dispatchAppPresenceChanged(reason);
    },
    emitDebug(category, event, severity, context, payloadFactory, options) {
      emitDebug(category, event, severity, context, payloadFactory, options);
    },
  });

  function buildStatusObject(options = {}) {
    const includeDownstreamReadiness = options.includeDownstreamReadiness === true;
    const activeSessionKey = sessionService.ensureSessionKey();

    const status      = {
      openclaw:
        upstreamRuntime && upstreamRuntime.isConnected()
          ? "connected"
          : "disconnected",
      agent: upstreamRuntime ? upstreamRuntime.getAgentName() : null,
      agentEmoji: upstreamRuntime ? upstreamRuntime.getAgentEmoji() : null,
      agentAvatarHash: upstreamRuntime ? upstreamRuntime.getAgentAvatarHash() : null,
      session: activeSessionKey,
      liveUiSessionGeneration: ensureLiveUiSessionGeneration(activeSessionKey),
      evenAiEnabled: opts.evenAiEnabled === true,
      ledgerV1: activeConversationSupportsLedger(),
    };

    if (setupHintError) {

      status.setupHint = "first-reply-errored";
      status.setupHintErrorClass = setupHintError.code;
    } else if (setupHintPhase) {
      status.setupHint = setupHintPhase;
    }

    const bootstrapPending =
      upstreamRuntime && typeof upstreamRuntime.getAgentBootstrapPending === "function"
        ? upstreamRuntime.getAgentBootstrapPending()
        : null;
    if (typeof bootstrapPending === "boolean") status.agentBootstrapPending = bootstrapPending;
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

  function cachePages(pages = [], ledgerV1 = false, sourceRunId                = null) {
    const nextRevision = pagesRevision + 1;
    const assistantCommit =
      typeof conversationState.getAssistantCommitSnapshot === "function"
        ? conversationState.getAssistantCommitSnapshot()
        : null;
    const activeSessionKey =
      typeof sessionService.peekSessionKey === "function"
        ? sessionService.peekSessionKey()
        : null;
    const sourceSnapshot = typeof conversationState.getEntries === "function"
      ? conversationState.getEntries() : null;
    const sourceRevision = sourceSnapshot?.entriesRevision;
    if (!Number.isFinite(sourceRevision) || sourceRevision !== pagesSourceRevision ||
        activeSessionKey !== pagesSourceSession) pagesSourceRunId = null;
    pagesSourceRevision = Number.isFinite(sourceRevision) ? sourceRevision : null;
    pagesSourceSession = activeSessionKey;

    const explicitSource = typeof sourceRunId === "string" ? sourceRunId.trim() : "";
    if (Number.isFinite(sourceRevision) && explicitSource &&
        sourceSnapshot?.entries?.at(-1)?.runId === explicitSource) pagesSourceRunId = explicitSource;
    const next = handler.formatPages(pages, {
      revision: nextRevision,
      ledgerV1,
      sourceRunId: pagesSourceRunId,
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

  function broadcastEntriesForActiveLedgerClients(reason      = null) {
    if (hasActiveLedgerClient()) {
      const snapshot = activeLedgerSnapshot();
      if (snapshot !== null) server.broadcast(cacheEntries(snapshot, reason));
    }

    replyDelivery.notifyEntriesChanged();
  }

  function cacheEntries(snapshot      = {}, reason      = null, sourceRowCount      = null) {
    const sessionId = sessionService.peekSessionKey();
    const previousSessionId = entriesSessionId;
    const previousRevision = entriesRevision;
    const previousLastSeq = entriesLastSeq;
    const previousCount = entriesCount;
    cachedEntries = handler.formatEntries(snapshot, sessionId);
    entriesRevision = Number.isFinite(Number(snapshot.entriesRevision))
      ? Math.max(0, Math.floor(Number(snapshot.entriesRevision)))
      : entriesRevision;
    entriesLastSeq = Number.isFinite(Number(snapshot.lastSeq))
      ? Math.floor(Number(snapshot.lastSeq))
      : -1;
    entriesCount = Array.isArray(snapshot.entries) ? snapshot.entries.length : 0;
    entriesSessionId = sessionId || null;

    if (
      previousCount > 0 &&
      (entriesCount < previousCount || entriesLastSeq < previousLastSeq)
    ) {
      const sessionChanged = !!previousSessionId && previousSessionId !== entriesSessionId;
      const rowsFromUpstream = Number.isFinite(Number(sourceRowCount))
        ? Math.max(0, Math.floor(Number(sourceRowCount)))
        : null;

      const upstreamSentEnough = rowsFromUpstream !== null && rowsFromUpstream >= previousCount;
      const expectedReset = sessionChanged || reason === "new_chat";
      const verdict = sessionChanged
        ? "session_changed_expected"
        : reason === "new_chat"

          ? "new_chat_expected"
          : reason === "gateway_history" || reason === "mirror_rehydrate"
            ? (upstreamSentEnough ? "local_filter_dropped_rows" : "upstream_history_shrank")
            : reason === "session_switch"
              ? "session_switch_same_key"
              : "local_state_shrank";
      emitDebug(
        "relay.session",
        "ledger_snapshot_shrank",
        expectedReset ? "info" : "warn",
        { sessionKey: sessionId },
        () => ({
          verdict,
          implicates: expectedReset
            ? "neither"
            : verdict === "upstream_history_shrank"
              ? "gateway"
              : "relay",
          reason: reason || "unattributed",
          upstreamRowCount: rowsFromUpstream,
          sessionId,
          previousSessionId,
          entriesRevision,
          previousEntriesRevision: previousRevision,
          lastSeq: entriesLastSeq,
          previousLastSeq,
          entryCount: entriesCount,
          previousEntryCount: previousCount,
          complete: snapshot.complete !== false,
        }),
      );
    }
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

  function broadcastPages(options      = {}) {
    const pages = conversationState.getPages();
    const ledgerSnapshot = activeLedgerSnapshot();
    const preserveLedgerLane =
      options.preserveLedgerLane === true && hasActiveLedgerClient() && !!cachedEntries;
    const next = cachePages(pages, ledgerSnapshot !== null || preserveLedgerLane, options.sourceRunId);
    if (next !== null) {
      server.broadcast(next);
    }
    if (ledgerSnapshot !== null) {
      const entriesFrame = cacheEntries(
        ledgerSnapshot,
        options.reason || null,
        options.sourceRowCount ?? null,
      );

      server.broadcast(entriesFrame);
    } else if (!preserveLedgerLane) {
      cachedEntries = "";
      entriesLastSeq = -1;
    }

    replyDelivery.notifyEntriesChanged();
    return preserveLedgerLane;
  }

  function broadcastSessions() {
    evenAiRequestObservation.refresh();
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

    syncSessionDriverWatch("status");
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

  let hermesClarifyRouter      = null;
  let openClawQuestionRouter      = null;
  let demandRouter      = null;

  let openClawWaiting      = null;

  upstreamRuntime = createUpstreamRuntime({
    modelSites,

    noteRunOutcomeFrame,
    noteCardBuildRunSignal: (frame     ) => {
      if (!frame || frame.signal !== "model_call" || frame.phase !== "start") return;
      broadcastCardBuild(cardBuildPhases.modelCallStart({ sessionKey: frame.sessionKey, runId: frame.runId }), "modelCallStart");
    },

    noteCardBuildReasoning: (update     ) => {
      if (!update) return;
      broadcastCardBuild(cardBuildPhases.reasoning({ sessionKey: update.sessionKey, runId: update.runId }), "reasoningText");
    },
    noteCardBuildAgentNote: (note     ) => {
      if (!note) return;
      broadcastCardBuild(cardBuildPhases.agentNote({ sessionKey: note.sessionKey, runId: note.runId, text: note.text }), "agentNote");
    },
    noteCardBuildLateReply: (reply     ) => {
      if (!reply) return;
      broadcastCardBuild(cardBuildPhases.lateReply({ sessionKey: reply.sessionKey, runId: reply.runId, text: reply.text }), "lateReply");

      const sessionKey = reply.sessionKey;
      const quiet = setTimeout(() => {
        try {
          broadcastCardBuild(cardBuildPhases.flushQuietDone({ sessionKey, quietMs: CARD_BUILD_DONE_LATE_QUIET_MS }), "flushDone");
        } catch {  }
      }, CARD_BUILD_DONE_LATE_QUIET_MS + 10);
      if (typeof (quiet       )?.unref === "function") (quiet       ).unref();
    },
    noteCardBuildFinalReply: (reply     ) => {
      if (!reply) return;
      broadcastCardBuild(cardBuildPhases.finalReply({ sessionKey: reply.sessionKey, runId: reply.runId, text: reply.text }), "finalReply");
    },

    noteCardBuildOffSessionActivity: (activity     ) => {
      if (!activity) return;
      const origin = typeof activity.origin === "string" ? activity.origin : null;
      const phase = activity.phase || null;
      const outcome = origin && origin.trim().toLowerCase() === "lifecycle" ? classifyRunOutcomeFrame(activity, phase, origin) : null;
      const turnEnded = phase === "end" || (outcome !== null && outcome.terminal);
      if (!cardBuildPhases.taskFor(activity.sessionKey)) {

        if (turnEnded) noteCardBuildRunEndedElsewhere(activity);
        return;
      }
      if (!turnEnded && origin !== "tool") return;
      noteCardBuildActivity(activity, turnEnded, turnEnded ? carryCardBuild(activity) : null);
    },

    liveUiV2SessionContext: (sessionKey     ) => currentLiveUiSessionContext(sessionKey),

    liveUiV2DecidedFrame: (_sessionKey     , runId     ) => surfaceDecisionStore.decidedFrame(runId),

    liveUiV2DecidedIcon: (_sessionKey     , runId     ) => surfaceDecisionStore.decidedIcon(runId),

    liveUiV2AskedWords: (_sessionKey     , runId     ) => liveUiAskedWords.wordsFor(runId),
    isGlassesUnderBackpressure: () => glassesBackpressureLatch.isOverHighWater(),

    liveUiPictureContext: {
      httpEnabled: () => {
        const cfg      = typeof opts.getGlassesUiLiveConfig === "function" ? opts.getGlassesUiLiveConfig() || {} : {};
        return cfg.httpEnabled !== false;
      },

      wearerReachOpen: () => {
        const cfg      = typeof opts.getGlassesUiLiveConfig === "function" ? opts.getGlassesUiLiveConfig() || {} : {};
        return (cfg.httpHostPolicy === undefined ? "owner-grants" : cfg.httpHostPolicy) === "owner-grants";
      },
      hostCheck: () => {
        const controller = resolveLiveuiGlassesLibraryController();
        return controller && typeof controller.liveuiHostCheck === "function" ? controller.liveuiHostCheck() : null;
      },
      fileScope: (sessionKey     ) => liveUiPictureHost.fileScope(sessionKey),

      videoSpeed: () => {
        try {
          const controller = resolveLiveuiGlassesLibraryController();
          const loaded = controller && typeof controller.getLiveuiPrefs === "function"
            ? controller.getLiveuiPrefs()
            : null;
          return !(loaded && loaded.prefs && loaded.prefs.videoSpeed === false);
        } catch (_) {
          return true;
        }
      },

      videoSize: () => {
        try {
          const controller = resolveLiveuiGlassesLibraryController();
          const loaded = controller && typeof controller.getLiveuiPrefs === "function"
            ? controller.getLiveuiPrefs()
            : null;
          const size = loaded && loaded.prefs ? loaded.prefs.videoSize : null;
          return typeof size === "number" ? size : null;
        } catch (_) {
          return null;
        }
      },
    },
    observeSetupEvent: (name     , data     ) => {
      if (name === "message") observeFirstUse("reply", data);

      if ((name === "error" && data?.aborted !== true) || name === "connectFailed" || (name === "status" && data === "disconnected")) observeFirstUse("clear");
    },
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

    approvalExplainer: createApprovalExplainer({

      llmComplete:
        gatewayBridge && gatewayBridge.kind === "hermes"
          ? (params     ) => gatewayBridge.request("approval.llm.complete", params)
          : opts.inputPrediction && opts.inputPrediction.llmComplete,
      enabled: () => ocuClawSettingsStore.getSnapshot().explainApprovals !== false,
      logger,
    }),
    getCurrentSessionModelConfigSnapshot() {
      return sessionModelConfig.getSnapshot();
    },

    getAgentProgressNotes() {

      return Reflect.get(ocuClawSettingsStore.getSnapshot(), "agentProgressNotes") ?? null;
    },

    noteActivityProse(data     ) {
      return activityStatusAdapter.noteProse(data);
    },

    liveProseHeadlines(data     ) {
      return activityStatusAdapter.liveProseHeadlines(data);
    },
    observeTaskToolUse(params     ) {
      return liveuiTaskRunController
        ? liveuiTaskRunController.observeToolUse(params)
        : false;
    },
    observeTaskApproval(params     ) {
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
    onClarify(data     ) {
      if (!hermesClarifyRouter) {
        logger.warn("[hermes] clarify dropped before demand router initialization");
        return false;
      }
      return hermesClarifyRouter.handleRequest(data);
    },
    onSessionAttention(data     ) {
      return hermesClarifyRouter?.reconcile(data);
    },
    onSessionsGone(data     ) {
      return sessionsGone.observe(data);
    },
    takeWaitingApproval(data     ) {
      return !!openClawWaiting && openClawWaiting.takeApproval(data);
    },
    observeWaitingApprovalResolved(data     ) {
      return !!openClawWaiting && openClawWaiting.observeApprovalResolved(data);
    },
    onQuestion(data     ) {

      if (openClawWaiting && openClawWaiting.takeQuestion(data)) return true;
      if (!openClawQuestionRouter) {
        logger.warn("[openclaw] question dropped before demand router initialization");
        return false;
      }
      return openClawQuestionRouter.handleRequest(data);
    },
    onQuestionResolved(data     ) {
      if (openClawWaiting && openClawWaiting.observeQuestionResolved(data)) return true;
      return openClawQuestionRouter?.handleResolved(data) || false;
    },
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
    fetchAgentAvatar: opts.fetchAgentAvatar,
  });

  async function resolveLiveuiTaskExecutor(executor     ) {
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
    const match = catalog.agents.find((entry      = {}) => {
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

  async function createLiveuiTaskSession(executor     ) {
    simulation.clearSyntheticWorkForSession(sessionService.ensureSessionKey());
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

      if (typeof (server       ).getAppClientIds === "function") {
        for (const clientId of (server       ).getAppClientIds()) {
          noteAppClientSessionSelected(clientId, result.sessionKey);
        }
      }
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

  async function replaceGoneCurrentSession(goneKey     ) {
    simulation.clearSyntheticWorkForSession(goneKey);
    await hermesEnrollment.ensureFresh("session_gone");
    const rawBinding = mintAgentRefs.getAppPathwayAgentRef();
    const agentFallback = hermesEnrollment.agentRefIsUnenrolled(rawBinding) ? rawBinding : "";

    const result = await sessionService.newSession({
      sendResetCommand: false,
      materializeImmediately: false,
    });
    if (result && typeof result.sessionKey === "string" && result.sessionKey.trim()) {
      stablePromptSnapshots.evict(result.sessionKey);
      sessionService.clearDisplayToggleStates(result.sessionKey);
    }
    clearCurrentSessionModelConfigSnapshot("session_gone");
    if (upstreamRuntime && typeof upstreamRuntime.clearTyping === "function") {
      upstreamRuntime.clearTyping("session_gone");
    }
    if (upstreamRuntime && typeof upstreamRuntime.handleSessionChanged === "function") {
      upstreamRuntime.handleSessionChanged("session_gone");
    }
    const sessionModelConfig = await seedOcuClawSessionConfigForNewSession(result.sessionKey);
    if (server) {
      if (typeof (server       ).getAppClientIds === "function") {
        for (const clientId of (server       ).getAppClientIds()) {
          noteAppClientSessionSelected(clientId, result.sessionKey);
        }
      }
      server.broadcast(
        handler.formatSessionSwitched(result.sessionKey, "", true, agentFallback, true),
      );
      server.broadcast(handler.formatPages(result.pages, {}));
      if (sessionModelConfig) {
        server.broadcast(handler.formatSessionModelConfig(sessionModelConfig));
      }
    }
    broadcastStatus();
  }

  const sessionsGone = createSessionsGoneHandler({
    sessionStillExists: (key     ) => sessionService.sessionStillExists(key),
    invalidateSessionsCache: () => sessionService.invalidateSessionsCache(),
    getCurrentSessionKey: () => sessionService.peekSessionKey(),
    isDraftSession: (key     ) => sessionService.isDraftSession(key),
    forgetSessions(keys     ) {
      for (const key of keys) {
        stablePromptSnapshots.evict(key);
        sessionService.clearDisplayToggleStates(key);
      }
      sessionService.forgetSessionsDeletedElsewhere(keys);
    },
    replaceCurrentSession: replaceGoneCurrentSession,
    async broadcastSessions(namedKeys     ) {
      await broadcastSessions();

      if (namedKeys.some((key     ) => sessionService.isEvenAiSessionKey(key))) {
        broadcastEvenAiSessions();
      }
    },
    emitDebug(event     , level     , data     ) {
      emitDebug("relay.session", event, level, {}, () => data);
    },
    logger,
  });

  function ringTaskRows() {
    if (typeof opts.onTaskRowsChanged === "function") {
      try {
        opts.onTaskRowsChanged();
      } catch (err) {
        logger.warn(`[relay] task rows change failed: ${String(err)}`);
      }
    } else if (openClawTaskSchedulesOn()) {
      openClawTaskRowsBroadcast.ring();
    }
  }

  function broadcastLiveuiTasksSnapshot(controller      = null) {
    try {
      controller ||= resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.listTasksForPhone !== "function") return;
      server.broadcast(handler.formatLiveuiTasks(controller.listTasksForPhone() || {}));
    } catch (err     ) {
      logger.warn(
        `[liveui] Task Run snapshot broadcast failed: ${err && err.message ? err.message : err}`,
      );
    }
  }

  liveuiTaskRunController = createLiveuiTaskRunController({
    resolvePresentationFeed: ({ taskId, clientId, version }     ) => {
      const binding = programCardFeed?.store.read(taskId);
      if (binding?.schemaVersion === 2 && taskPresentationClientOwns(clientId, binding) && programCardFeed.current(binding))
        return { cardId: binding.cardId, cardName: binding.cardName, keys: binding.inputs.map((input     ) => input.key),
        inputs: binding.inputs, bindingDigest: binding.bindingDigest };
      const controller = resolveLiveuiGlassesLibraryController();

      if (typeof controller?.readTaskSchedule !== "function" || typeof controller?.readTemplate !== "function") return null;
      const look = controller.readTaskSchedule(taskId)?.schedule?.approved?.look;
      if (look?.kind !== "template" || !look.templateId.startsWith("result-")) return null;
      const template = controller.readTemplate(look.templateId)?.envelope;
      if (template?.helperOf?.taskId !== taskId || !Array.isArray(template.inputs)) return null;
      return { presentationKind: "surface", cardId: look.templateId, cardName: template.name,
        keys: template.inputs.map((input     ) => input.key), inputs: template.inputs,
        bindingDigest: liveuiLibraryDigest({ templateDigest: template.digest, ...taskScheduleBinding(version) }) };
    },
    host: relayBackendKind,
    loadTask(taskId     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller && typeof controller.readTaskForRun === "function"
        ? controller.readTaskForRun(taskId)
        : { status: "rejected", code: "task_not_found" };
    },
    resolveTemplateHint(templateId     ) {
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
        const appAgentRef = mintAgentRefs.getAppPathwayAgentRef();
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
          : mintAgentRefs.getAppPathwayAgentRef() || sessionService.getSessionAgentId("", undefined),
      };
    },
    createSession: createLiveuiTaskSession,
    sendUserMessage({ runId, sessionKey, text, onSessionResolved }     ) {
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
    abortSession(sessionKey     ) {
      return dispatchOcuClawSessionAbort({
        requestId: `liveui-task-abort-${crypto.randomUUID()}`,
        sessionKey,
      });
    },
    newRunId: () => `liveui-task-${crypto.randomUUID()}`,
    onRunStarted(run     ) {
      broadcastLiveuiTasksSnapshot();

      try { if (taskCardRuns.started(run)) ringTaskRows(); } catch (_) {  }
    },
    onRunEnded(run     ) {

      broadcastLiveuiTasksSnapshot();

      try { if (taskCardRuns.ended(run)) ringTaskRows(); } catch (_) {  }

      try { taskRunsWeek?.onRelayRunEnded(run); } catch (_) {  }

      try { taskOpenUpdate?.onRunEnded(run); } catch (_) {  }

      try { cardPartRuns?.onRunEnded(run); } catch (_) {  }
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
        by: run.by,
      }));
    },
  });

  programCardFeed = createProgramCardFeed({
    store: createProgramCardFeedStore({ libraryDir: opts.liveuiLibraryDir, loadCard: (appId        ) => programCardSaves.source({ appId }) }),
    loadCard: (appId        ) => programCardSaves.source({ appId }),

    toolFailuresOf: (active     ) => typeof active?.runId === "string" ? taskToolLedger.failures(`feed:${active.runId}`) : null,
    loadTask(taskId     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller && typeof controller.readTaskForRun === "function"
        ? controller.readTaskForRun(taskId)
        : null;
    },
    taskRunController: () => liveuiTaskRunController,
    relaySessionKeyFor,
    deliverSurfaceFromRun: ({ active, values }     ) => {
      const controller = resolveLiveuiGlassesLibraryController();
      const version = controller?.readTaskForRun(active.taskId)?.task?.versions?.approved;
      const look = controller?.readTaskSchedule(active.taskId)?.schedule?.approved?.look;
      if (!version || look?.kind !== "template" || look.templateId !== active.feed.cardId)
        return { status: "rejected", code: "presentation_revision_changed" };
      const template = controller.readTemplate(look.templateId)?.envelope;
      if (template?.helperOf?.taskId !== active.taskId || active.feed.bindingDigest !==
          liveuiLibraryDigest({ templateDigest: template.digest, ...taskScheduleBinding(version) }))
        return { status: "rejected", code: "presentation_revision_changed" };

      const saved = controller.writeDeliveredTemplateValues(look.templateId, { values, owner: liveuiTemplateValuesOwner({ taskId: active.taskId }),
        resultId: active.runId, deliveredAtMs: Date.now(), source: "run", toolFailures: taskToolLedger.failures(`feed:${active.runId}`) });
      return saved?.status === "written" ? { status: "delivered", cardId: look.templateId, keys: Object.keys(saved.values || {}),
        ...(saved.unchecked ? { unchecked: saved.unchecked } : {}), ...(saved.allUnchecked ? { allUnchecked: true } : {}),
        values: saved.values, ...(saved.fixes ? { fixes: saved.fixes } : {}), ...(saved.unfit ? { unfit: saved.unfit } : {}),
        ...(saved.missing ? { missing: saved.missing } : {}), ...(saved.dropped ? { dropped: saved.dropped } : {}) } : saved;
    },
    canRefresh: taskPresentationClientOwns,

    followTask: cardsFollowOwnChanges,
    onTaskFollowed: (taskId        ) => {
      void Promise.resolve().then(() => {
        const controller = resolveLiveuiGlassesLibraryController();
        if (controller && typeof controller.reconcileTaskSchedule === "function")
          Promise.resolve(controller.reconcileTaskSchedule(taskId)).catch(() => {});
        pushProgramCardBindings();
      }).catch(() => {});
    },
    send: (frame     , binding     ) => {
      noteCardStudioTaskData(frame);
      if (binding?.schemaVersion !== 2) return server.broadcast(frame);
      for (const client of server.getReadinessSnapshot()?.clients || [])

        if (taskPresentationClientOwns(client.clientId, binding) && (bindingSlot(binding) === TASK_SLOT_FIRST || clientHasTaskSlots(client.clientId)))
          server.unicast(client.clientId, frame);
    },
    onTaskResult: (params     ) => {

      if (params?.outcome?.allUnchecked === true) ringTaskRows();
      return taskOpenUpdate?.onTaskResult(params);
    },

    onFixChanged: () => pushProgramCardBindings(),
    logger,
  });

  function noteCardStudioTaskData(frame     ) {
    try {
      const data = typeof frame === "string" ? JSON.parse(frame) : frame;
      if (!data || data.type !== "ocuclaw.program.data") return;
      cardStudio.taskData({ taskId: data.taskId, cardId: data.cardId, slot: data.slot, resultAtMs: data.atMs,
        values: data.values, fixes: data.fixes, unchecked: data.unchecked });
    } catch {

    }
  }

  taskOpenUpdate = createTaskOpenUpdate({
    store: createTaskOpenUpdateStore({ libraryDir: opts.liveuiLibraryDir }),
    feed: programCardFeed,
    logger,
    send: (frame     , binding     ) => {
      if (!server) return;
      if (binding?.schemaVersion !== 2) return server.broadcast(frame);
      for (const client of server.getReadinessSnapshot()?.clients || [])
        if (taskPresentationClientOwns(client.clientId, binding) && (bindingSlot(binding) === TASK_SLOT_FIRST || clientHasTaskSlots(client.clientId)))
          server.unicast(client.clientId, frame);
    },
    rowRun: async (taskId        ) => {
      const read = typeof opts.onGetTaskRows === "function" ? opts.onGetTaskRows
        : openClawTaskSchedulesOn() ? () => openClawTaskRows.read() : null;
      if (!read) return null;
      const rows = await read();
      const row = Array.isArray(rows) ? rows.find((entry     ) => entry && entry.taskId === taskId) : null;
      return row && row.run && typeof row.run === "object" ? row.run : null;
    },
    activeTaskId: () => liveuiTaskRunController?.activeRun?.()?.taskId || null,
    hasJob: (taskId        ) => taskHasCardJob(taskId),
    runJobNow: (taskId        ) => runCardJobNow(taskId, false),

    launchFeedRun: ({ clientId, cardId, slot }     ) => cardHasParts(programCardFeed.store, cardId) && cardPartRuns
      ? cardPartRuns.launchOpenRun({ clientId, cardId, slot })
      : programCardFeed.refresh({ clientId, cardId, by: "open" }),

    taskKind: (taskId        ) => {
      try {
        const controller = resolveLiveuiGlassesLibraryController();
        const read = typeof controller?.readTaskSchedule === "function" ? controller.readTaskSchedule(taskId) : null;
        const kind = read?.status === "accepted" ? read.schedule?.approved?.kind : null;
        return typeof kind === "string" ? kind : null;
      } catch (_) {
        return null;
      }
    },
    hostEnforces: (taskId        ) => taskUsesHostEnforces(taskId),
  });

  function taskHasCardJob(taskId        ) {
    if (!taskJobRunner()) return false;
    const controller = resolveLiveuiGlassesLibraryController();
    const job = typeof controller?.readTaskSchedule === "function" ? controller.readTaskSchedule(taskId)?.schedule?.job : null;
    return !!(job && typeof job.jobId === "string" && job.jobId && job.state !== "gone");
  }

  async function runCardJobNow(taskId        , refresh         ) {
    const atMs = Date.now();
    try { if (taskCardRuns.jobStarted(taskId, atMs)) ringTaskRows(); } catch (_) {  }
    if (refresh) try { taskRunsWeek?.store?.expectRunNow(taskId, atMs); } catch (_) {  }
    let result      = null;
    try { result = await taskJobRunner()?.runTaskScheduleNow(taskId); } catch (_) { result = null; }
    if (!result || result.status !== "accepted" || result.state === "job_missing") {
      try { if (taskCardRuns.jobNotStarted(taskId, atMs)) ringTaskRows(); } catch (_) {  }
      if (refresh) try { taskRunsWeek?.store?.forgetRunNow(taskId, atMs); } catch (_) {  }
    }
    return result;
  }

  cardPartRuns = createCardPartRuns({
    feed: programCardFeed,
    logger,
    canRun: taskPresentationClientOwns,
    taskKind: (taskId        ) => {
      const controller = resolveLiveuiGlassesLibraryController();
      const read = typeof controller?.readTaskSchedule === "function" ? controller.readTaskSchedule(taskId) : null;
      const kind = read?.status === "accepted" ? read.schedule?.approved?.kind : null;
      return typeof kind === "string" ? kind : null;
    },
    running: async (taskId        ) => {
      if (liveuiTaskRunController?.activeRun?.()?.taskId === taskId) return true;
      const read = typeof opts.onGetTaskRows === "function" ? opts.onGetTaskRows
        : openClawTaskSchedulesOn() ? () => openClawTaskRows.read() : null;
      if (!read) return false;
      const rows = await read();
      const row = Array.isArray(rows) ? rows.find((entry     ) => entry && entry.taskId === taskId) : null;
      return row?.run?.state === "running";
    },
    hasJob: (taskId        ) => taskHasCardJob(taskId),
    runJobNow: (taskId        ) => runCardJobNow(taskId, true),
    busy: () => !!liveuiTaskRunController?.isBusy?.(),
    launchFeed: ({ clientId, cardId, slot, by }     ) => {

      if (by === "agent") {
        const binding = programCardFeed.store.forCard(cardId).find((entry     ) => bindingSlot(entry) === slot);
        if (binding) taskRunsWeek?.agentRefreshAsked(binding.taskId);
      }
      return programCardFeed.refresh({ clientId, cardId, slot, by: by === "wearer" ? "card" : by });
    },
    agent: {
      take: (binding     ) => (taskOpenUpdate ? taskOpenUpdate.takeAgentRefresh(binding) : { ok: true }),
      giveBack: (binding     , day        ) => taskOpenUpdate?.giveBackAgentRefresh(binding, day),
    },
    clientConnected: (clientId        ) => (server?.getReadinessSnapshot()?.clients || []).some((entry     ) => entry?.clientId === clientId),
    send: (clientId        , result     ) => server?.unicast(clientId, formatProgramCardRefreshResult(result)),

    checkAgainAllowed: (taskId        ) => taskCheckAgain.allowed(taskId),
  });

  cardPartLink = createCardPartLink({
    store: programCardFeed.store,
    feed: programCardFeed,
    card: (appId        ) => programCardSaves.source({ appId }),
    task: (taskId        ) => {
      const controller = resolveLiveuiGlassesLibraryController();
      const loaded = controller?.readTask?.(taskId);
      const version = loaded?.status === "accepted" ? loaded.task?.versions?.approved : null;
      if (!version) return null;
      const read = typeof controller.readTaskSchedule === "function" ? controller.readTaskSchedule(taskId) : null;
      const kind = read?.status === "accepted" && typeof read.schedule?.approved?.kind === "string" ? read.schedule.approved.kind : "brief";
      return { name: taskNameOf(loaded.task, version, taskId), version, kind };
    },
    taskScope: (taskId        , version     ) => taskOwnerScopeOf(taskId, version),
    clientOwns: (clientId        , scope        ) => taskPresentationClientOwns(clientId, { ownerScope: scope }),
    taskName: (taskId        ) => {
      const loaded = resolveLiveuiGlassesLibraryController()?.readTask?.(taskId);
      return loaded?.status === "accepted" ? taskNameOf(loaded.task, loaded.task?.versions?.approved, taskId) : taskId;
    },
    testCard: (testId        , taskId        ) => liveuiTaskTests.cardOfTask(testId, taskId),

    cap: () => programCardTaskSlotsCap(),
    clientParts: (clientId        ) => clientHasTaskSlots(clientId),
  });

  taskRunsWeek = createTaskRunsWeek({
    store: createTaskRunsWeekStore({ libraryDir: opts.liveuiLibraryDir }),
    taskFor: (result     ) => taskHandler()?.taskForTaskResult?.(result) ?? null,
    logger,
  });

  function taskRunsWeekFor(taskId        ) {
    if (!taskRunsWeek || typeof taskId !== "string") return null;
    try {
      const controller = resolveLiveuiGlassesLibraryController();
      const read = typeof controller?.readTaskSchedule === "function" ? controller.readTaskSchedule(taskId) : null;
      const when = read?.status === "accepted" ? read.schedule?.approved?.when : undefined;
      return taskRunsWeek.week(taskId, when === undefined ? {} : { scheduled: !!when });
    } catch (_) {
      return null;
    }
  }

  const taskUsesStore = createTaskUsesStore({ libraryDir: opts.liveuiLibraryDir });
  const taskUsesOpenStore = createTaskOpenUpdateStore({ libraryDir: opts.liveuiLibraryDir });
  const taskUsesPolicy = createTaskUsesPolicy({
    store: taskUsesStore,
    logger,
    glassesTools: AUTOMATION_REFUSED_TOOLS,
    onNeeds: (taskId        , step     ) => {
      emitDebug("glasses.lifecycle", "task_step_needs_ok", "info", null, () => ({ taskId, kind: step?.kind || null }));

      ringTaskRows();
    },
  });

  function taskLeftOut(taskId        )         {
    try {
      const needs = taskUsesStore.read(taskId)?.needs;
      return Array.isArray(needs) ? needs.length : 0;
    } catch (_) {
      return 0;
    }
  }

  const liveuiTaskTests = createLiveuiTaskTests({
    enabled: () => true,
    scheduler: () => {
      try {
        return resolveLiveuiGlassesLibraryController()?.taskTestScheduler?.() || null;
      } catch (_) {
        return null;
      }
    },
    send: (clientId     , frame     ) => {
      if (!server || typeof server.unicast !== "function") return false;
      server.unicast(clientId, JSON.stringify(frame));
      return true;
    },
    glassesTools: AUTOMATION_REFUSED_TOOLS,

    starterCheck: { start: starterCheckStart, verdict: starterCheckVerdict },
    logger,
  });

  const taskJobMemory = createTaskJobMemory();
  const taskHeldPolicy = createTaskHeldPolicy({
    logger, glassesTools: AUTOMATION_REFUSED_TOOLS, label: "run whose job is gone", why: "job_gone",
    reason: `${TASK_USES_NOT_ALLOWED}: this run's Task changed or was removed, so OcuClaw skipped this step. Finish now without it.`,
  });

  const openClawTestJobs = createTaskJobMemory();

  function noteOpenClawJobMarks(event     ) {
    try {
      const jobId = event && typeof event.jobId === "string" ? event.jobId : "";
      const job = event && event.job && typeof event.job === "object" ? event.job : null;
      if (!jobId || !job) return;
      const testTaskId = testIdOfJob(job);
      if (testTaskId) {
        if (event.action === "finished") openClawTestJobs.forget(jobId);
        else openClawTestJobs.note(jobId, testTaskId);
        return;
      }
      const taskId = taskIdOfJob(job);
      if (taskId) taskJobMemory.note(jobId, taskId);
    } catch (_) {

    }
  }

  function seedTaskFromTest(testId               , outcome     ) {
    if (!testId) return outcome;
    return Promise.resolve(outcome).then((result     ) => {
      if (result && result.status === "saved" && typeof result.taskId === "string") {
        const taken = liveuiTaskTests.takeForTask(testId);
        try {
          if (taken) taskUsesStore.seed(result.taskId, taken);
        } catch (err     ) {
          logger?.warn?.(`[task-test] could not give ${result.taskId} its test's list: ${err?.message || err}`);
        }
      }
      return result;
    });
  }

  function taskExecutorHost(taskId        )                {
    try {
      const loaded = resolveLiveuiGlassesLibraryController()?.readTask?.(taskId);
      const host = loaded?.status === "accepted" ? loaded.task?.versions?.approved?.executor?.host : null;
      return typeof host === "string" ? host : null;
    } catch (_) {
      return null;
    }
  }

  function taskUsesHostEnforces(taskId        ) {
    const host = getActiveBackendKind();
    return (host === "openclaw" || host === "hermes") && taskExecutorHost(taskId) === host;
  }

  function activeRunHasSession(run     , hookKey     ) {
    const key = typeof hookKey === "string" ? hookKey.trim() : "";
    if (!run || !key || typeof run.sessionKey !== "string" || !run.sessionKey) return false;
    return run.sessionKey === key || run.sessionKey === relaySessionKeyFor(key);
  }

  function taskRunOfToolCall({ sessionKey, cronJobId }     )                                                                                      {
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    const run = liveuiTaskRunController?.activeRun?.() || null;

    if (run && typeof run.taskId === "string" && activeRunHasSession(run, key)) {
      const pending = taskUsesOpenStore.openRun(run.taskId);
      const open = !!(run.feed && pending && pending.via === "feed" && Number.isFinite(run.startedAt) &&
        run.startedAt >= pending.atMs - 1000);
      return { taskId: run.taskId, mode: open ? "open" : "run" };
    }
    const jobId = typeof cronJobId === "string" && cronJobId ? cronJobId : cronJobOfSessionKey(key);
    if (!jobId) return null;

    const test = liveuiTaskTests.testOfJob(jobId);

    if (test) return { taskId: test.taskId, mode: "test", ...(test.closed ? { closed: true } : {}) };
    let taskId      = null;
    try {
      taskId = resolveLiveuiGlassesLibraryController()?.taskForTaskResult?.({ jobId }) || null;
    } catch (_) {
      taskId = null;
    }
    if (typeof taskId !== "string" || !taskId) {

      const starting = liveuiTaskTests.testLaunching?.() || null;
      if (starting) return { taskId: starting.taskId, mode: "test", closed: true };

      const testTaskId = openClawTestJobs.taskOf(jobId);
      if (testTaskId) return { taskId: testTaskId, mode: "test", closed: true };

      const seen = taskJobMemory.taskOf(jobId);
      if (seen) return { taskId: seen, mode: "held" };

      if (getActiveBackendKind() === "hermes" && typeof cronJobId === "string" && cronJobId) return { taskId: "", mode: "held" };
      return null;
    }
    taskJobMemory.note(jobId, taskId);
    const pending = taskUsesOpenStore.openRun(taskId);
    return { taskId, mode: pending && pending.via === "job" ? "open" : "run" };
  }

  function taskRunMcpFacts(host        , mcp     ) {
    if (!mcp || typeof mcp !== "object" || typeof mcp.server !== "string" || typeof mcp.tool !== "string") return null;
    let marks      = null;
    try {
      marks = programCardMcp.writeMarksOf(mcp.server, mcp.tool);
    } catch (_) {
      marks = null;
    }
    return taskStepMcpFacts(host, mcp, marks);
  }

  function checkTaskToolCall(input      = {}) {
    const host = getActiveBackendKind();
    if (host !== "openclaw" && host !== "hermes") return { block: false };
    const owner = taskRunOfToolCall(input);
    if (!owner) return { block: false };
    const policy = owner.mode === "held" ? taskHeldPolicy
      : owner.mode === "test" ? (owner.closed ? liveuiTaskTests.closedPolicy : liveuiTaskTests.policy) : taskUsesPolicy;
    let verdict      = null;
    try {
      verdict = policy.check({
        host,
        taskId: owner.taskId,
        mode: owner.mode,
        toolName: input.toolName,
        args: input.args,
        mcp: taskRunMcpFacts(host, input.mcp),
      });
    } catch (err     ) {

      logger?.warn?.(`[task-uses] check failed for ${owner.taskId}: ${err?.message || err}`);
      verdict = null;
    }
    if (!verdict) {
      return { block: true, reason: TASK_USES_CHECK_FAILED_REASON, taskId: owner.taskId, mode: owner.mode };
    }
    if (verdict.allow) {

      if (owner.mode === "run") {
        const run = taskToolRunOf(input);
        if (run) taskToolLedger.noteRan(run);
      }
      return { block: false };
    }

    if (owner.mode === "run" && (verdict.why === "not_on_list" || verdict.why === "kept_off")) {
      const run = taskToolRunOf(input);
      const group = taskToolGroupOfMcp(input.mcp?.server) || (typeof input.toolName === "string" && input.toolName
        ? `tool:${input.toolName}` : null);
      if (run) taskToolLedger.noteRefused(run, group, verdict.why === "kept_off" ? "kept_off" : "not_allowed");
    }

    if (owner.mode !== "test" && typeof opts.onTaskStepRefused === "function") {
      try {
        opts.onTaskStepRefused({
          taskId: owner.taskId,
          mode: owner.mode,
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : null,
          cronJobId: typeof input.cronJobId === "string" ? input.cronJobId : null,
          useKey: verdict.step?.keys?.[0] || null,
          useKeys: Array.isArray(verdict.step?.keys) ? verdict.step.keys : [],
          why: verdict.why || null,
          at: Date.now(),
        });
      } catch (err     ) {
        logger?.warn?.(`[task-uses] onTaskStepRefused failed: ${err?.message || err}`);
      }
    }
    return { block: true, reason: verdict.reason, taskId: owner.taskId, mode: owner.mode };
  }

  const OWN_REFUSAL = new RegExp([TASK_USES_NOT_ALLOWED, TASK_USES_NOT_OFFERED, TASK_USES_NOT_ON_OPEN].join("|"));

  function taskToolRunOf({ sessionKey, cronJobId }     )                {
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if (!key) {
      const jobId = typeof cronJobId === "string" ? cronJobId.trim() : "";
      return jobId ? `job:${jobId}` : null;
    }
    const run = liveuiTaskRunController?.activeRun?.() || null;
    if (run && run.feed && typeof run.runId === "string" && activeRunHasSession(run, key)) return `feed:${run.runId}`;
    return cronJobOfSessionKey(key) ? `cron:${key}` : null;
  }

  function noteTaskToolCall(input      = {}) {
    if (getActiveBackendKind() !== "openclaw") return;
    const group = taskToolGroupOfMcp(input.server);
    if (!group) return;
    const run = taskToolRunOf(input);
    if (!run) return;
    const error = typeof input.error === "string" ? input.error : input.error === null ? null : undefined;
    if (error === undefined || (error !== null && OWN_REFUSAL.test(error))) return;
    taskToolLedger.noteCall(run, group, error);
  }

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

      resolveDedicatedSessionKey(agentRef     ) {
        if (getActiveBackendKind() !== "hermes") return "";
        const ref = typeof agentRef === "string" ? agentRef.trim() : "";
        if (!ref || ref === HERMES_DEFAULT_PROFILE) return "";
        try {
          return mintedHermesSessionKey("even-ai", ref);
        } catch {
          return "";
        }
      },
      ...evenAiRouterOptions,
    });
    evenAiRunWaiter = createEvenAiRunWaiter({
      gatewayBridge,
      logger,
      emitDebug,
    });

    if (relayBackendKind === "openclaw" && opts.stateDir) {
      evenAiRestartRecovery = createEvenAiRestartRecovery({
        journal: createEvenAiSendJournal({ stateDir: opts.stateDir, logger }),
        gatewayBridge,
        logger,
        emitDebug,
        dispatchGatewayUserSend(sessionKey     , send     ) {
          return sessionService.dispatchUserSend(sessionKey, send);
        },
        beginPromptTurnOwnership: promptTurnOwnership.begin,
        cancelPromptTurnOwnership: promptTurnOwnership.cancel,
      });
    }
    evenAiEndpoint = createEvenAiEndpoint({
      requestObservation: evenAiRequestObservation,
      publishNativePerformance(frame         ) {
        server.broadcast(JSON.stringify(frame));
      },
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
      hostProvidesReadability: relayBackendKind === "hermes",

      getSharedSessionChannelPrompt(sessionKey     ) {
        return relayBackendKind === "hermes"
          ? stablePromptSnapshots.peek(sessionKey, sessionKey)
          : "";
      },
      requestTimeoutMs: opts.evenAiRequestTimeoutMs,
      gatewayUserSendHoldDeadlineMs:
        Number.isFinite(opts.greetingHoldDeadlineMs) && opts.greetingHoldDeadlineMs > 0
          ? Math.floor(opts.greetingHoldDeadlineMs)
          : GREETING_SEND_HOLD_DEADLINE_MS,
      maxBodyBytes: opts.evenAiMaxBodyBytes,
      dedupWindowMs: opts.evenAiDedupWindowMs,
      gatewayBridge,
      dispatchGatewayUserSend(sessionKey     , send     ) {
        return sessionService.dispatchUserSend(sessionKey, send);
      },
      beginPromptTurnOwnership: promptTurnOwnership.begin,
      cancelPromptTurnOwnership: promptTurnOwnership.cancel,
      router: evenAiRouter,
      runWaiter: evenAiRunWaiter,
      restartRecovery: evenAiRestartRecovery,
      emitDebug,
      dispatchOcuClawUserSend(params     ) {

        return dispatchOcuClawUserSend({ ...params,
          modelSitesWearerOrigin: params?.source === "hybrid_voice_endpoint", origin: "glasses" });
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

      hasGlassesSurfaceAppClient() {
        if (!server) return false;
        if (typeof (server       ).getGlassesSurfaceAppCount !== "function") {
          return server.getConnectedAppCount() > 0;
        }
        return (server       ).getGlassesSurfaceAppCount() > 0;
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
      async seedDefaultModelForRoute(params     ) {
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

        if (getActiveBackendKind() === "hermes") {
          return "";
        }
        const evenAiDefault = normalizeEvenAiDefaultAgent(
          evenAiSettingsStore.getSnapshot().defaultAgent,
        );
        if (sessionKey && evenAiDefault) {

          sessionService.setSessionAgentId(sessionKey, evenAiDefault);
        }
        return evenAiDefault;
      },

      async getDefaultMintAgentRef() {
        await hermesEnrollment.ensureFresh("even_ai_mint");
        return mintAgentRefs.getEvenAiDefaultAgentRefForMint();
      },

      resolveMintAgentRef(input     ) {
        return mintAgentRefs.resolveEvenAiMintAgentRef(input);
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

        if (server && typeof (server       ).getAppClientIds === "function") {
          for (const clientId of (server       ).getAppClientIds()) {
            noteAppClientSessionSelected(clientId, route.sessionKey);
          }
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

  const relayPairing = createRelayPairing({ opts, logger, dispatchPairingCompleted });

  async function handleBufferedEvenAiHttpRequest(envelope) {
    const url =
      envelope && typeof envelope.url === "string" ? envelope.url : "/";
    const pathname = new URL(url, "http://127.0.0.1").pathname;
    if (isPairingEndpointPath(pathname)) {
      return relayPairing.handleHttpRequest(envelope);
    }
    if (isPairingControlPath(pathname)) {
      return relayPairing.handleControlRequest(envelope);
    }

    if (pathname === LIVEUI_AUDIO_PATH && typeof upstreamRuntime.serveLiveUiAudio === "function") {
      return upstreamRuntime.serveLiveUiAudio(envelope);
    }
    if (pathname === LIVEUI_SUBTITLES_PATH && typeof upstreamRuntime.serveLiveUiSubtitles === "function") {
      return upstreamRuntime.serveLiveUiSubtitles(envelope);
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
        const pending = pendingBufferedEvenAiResponses.get(requestId);
        if (pending && res.listenerCount("finish") > 0) {
          pending.timer = setTimeout(() => cancelBufferedEvenAiHttpRequest({ requestId }), 30_000);
          pending.timer.unref?.();
        } else {
          pendingBufferedEvenAiResponses.delete(requestId);
        }
      }
    }
  }

  function completeBufferedEvenAiHttpRequest(envelope     ) {
    const pending = pendingBufferedEvenAiResponses.get(envelope?.requestId);
    if (!pending) return false;
    pendingBufferedEvenAiResponses.delete(envelope.requestId);
    clearTimeout(pending.timer);
    pending.res.emit("finish");
    return true;
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
    pendingBufferedEvenAiResponses.delete(requestId);
    clearTimeout(pending.timer);
    pending.res.emit("close");
    pending.req.emit("close");
    return true;
  }

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
    dismiss: ({ surfaceId, sessionKey, reason }     ) => {
      sendDemandDismiss({ surfaceId, sessionKey, reason });
      emitDebug("glasses.lifecycle", "demand_retired", "info", {}, () => ({
        producer: "hermes",
        surfaceId,
        reason,
      }), undefined);
    },
    respond: (id     , response     ) =>
      gatewayBridge.request("clarify.resolve", { id, response }),
    awaitText: (id     ) =>
      gatewayBridge.request("clarify.await_text", { id }),
    isCurrentSession: (sessionKey     ) => sessionService.isCurrentSession(sessionKey),
    onError: (info     ) => {
      logger.warn(`[hermes] clarify outcome ignored: ${info.reason} (${info.surfaceId || info.id || "unknown"})`);
    },
  });

  if (relayBackendKind === "openclaw" && gatewayBridge) {
    openClawWaiting = createOpenClawWaiting({
      logger,
      publish: (payload     ) => upstreamRuntime && upstreamRuntime.publishWaiting(payload),
      getSettings: () => ocuClawSettingsStore.getSnapshot().waitingOnYou,
      resolveApproval: ({ kind, id, decision }     ) =>
        gatewayBridge.request(kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve", {
          id,
          decision,
        }),
      resolveQuestion: ({ id, answers }     ) =>
        gatewayBridge.request("question.resolve", { id, answers, resolvedBy: "ocuclaw-glasses" }),
      describeSession: async (key     ) => {
        const reply      = await gatewayBridge.request("sessions.describe", { key });
        const row = reply && reply.session && typeof reply.session === "object" ? reply.session : {};
        return row.label || row.displayName || row.derivedTitle || row.subject || "";
      },
    });

    gatewayBridge.on("connected", () => {
      const read = (method        ) =>
        Promise.resolve()
          .then(() => gatewayBridge.request(method, {}))
          .catch(() => null);
      Promise.all([read("exec.approval.list"), read("plugin.approval.list"), read("question.list")])
        .then(([exec, plugin, questions]       ) => {
          if (!openClawWaiting) return;
          const approvals = Array.isArray(exec) && Array.isArray(plugin)
            ? [...exec, ...plugin.map((row     ) => ({ ...row, approvalKind: "plugin" }))]
            : null;
          openClawWaiting.backfill({
            approvals,
            questions: questions && Array.isArray(questions.questions) ? questions.questions : null,
          });
        })
        .catch(() => {});
    });
  }

  openClawQuestionRouter = createOpenClawQuestionRouter({
    inject: (surface     ) => {
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
    dismiss: ({ surfaceId, sessionKey, reason }     ) => {
      sendDemandDismiss({ surfaceId, sessionKey, reason });
      emitDebug("glasses.lifecycle", "demand_retired", "info", {}, () => ({
        producer: "openclaw",
        surfaceId,
        reason,
      }), undefined);
    },
    respond: (id     , answers     ) =>
      gatewayBridge.request("question.resolve", {
        id,
        answers,
        resolvedBy: "ocuclaw-glasses",
      }),
    canPresentSecret: () => hasConnectedSecretEntryApp(),
    presentSecret: (request     ) => {
      broadcastSecretFrame(formatSecretRequestFrame(request));
      emitDebug("glasses.lifecycle", "secret_prompt_presented", "info", {}, () => ({
        producer: "openclaw",
        id: request.id,
        name: request.name,
        hosts: request.allowedHosts.length,
      }), undefined);
    },
    clearSecret: ({ id, outcome }     ) => {
      broadcastSecretFrame(JSON.stringify({ type: "ocuclaw.secret.cleared", id, outcome }));
      emitDebug("glasses.lifecycle", "secret_prompt_cleared", "info", {}, () => ({
        producer: "openclaw",
        id,
        outcome,
      }), undefined);
    },

    resolveSecret: (id     , params     ) =>
      gatewayBridge.request("question.resolve", params.cancel === true
        ? { id, cancel: true, resolvedBy: "ocuclaw-phone" }
        : {
          id,
          answers: params.answers,
          ...(Array.isArray(params.secretStoreAllowedHosts)
            ? { secretStoreAllowedHosts: params.secretStoreAllowedHosts }
            : {}),
          resolvedBy: "ocuclaw-phone",
        }),
    isCurrentSession: (sessionKey     ) => sessionService.isCurrentSession(sessionKey),
    onError: (info     ) => {
      logger.warn(`[openclaw] question outcome ignored: ${info.reason} (${info.surfaceId || info.id || "unknown"})`);
    },
  });

  demandRouter = createDemandRouter({
    inject: sendDemand,
    dismiss: sendDemandDismiss,
    isCurrentSession: (sessionKey     ) => sessionService.isCurrentSession(sessionKey),
    onError: (info     ) => {
      logger.warn(`[demand] outcome ignored: ${info.reason} (${info.surfaceId || "unknown"})`);
    },
    producers: [
      {
        matches: (frame     ) =>
          typeof frame?.surfaceId === "string" && frame.surfaceId.startsWith("hermes-clarify:"),
        handleOutcome: (frame     ) => hermesClarifyRouter.handleOutcome(frame),
        forgetAll: (reason     ) => hermesClarifyRouter.forgetAll(reason),
      },
      {
        matches: (frame     ) =>
          typeof frame?.surfaceId === "string" && frame.surfaceId.startsWith("openclaw-question:"),
        handleOutcome: (frame     ) => openClawQuestionRouter.handleOutcome(frame),
        forgetAll: (reason     ) => openClawQuestionRouter.forgetAll(reason),
      },
    ],
  });

  relayApi = {
    broadcastStatus,
    onAgentTurnChanged(handler     ) {
      return agentTurnChangedChannel.on(handler);
    },

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
        (event === "render_rejected" || event === "render_receipt_rejected" || event === "render_error_terminal") &&
        liveuiTaskRunController &&
        data &&
        typeof data.sessionKey === "string"
      ) {
        if (event === "render_error_terminal") {
          liveuiTaskRunController.observeSurfaceRenderFailure(data);
        } else {
          liveuiTaskRunController.observeRenderFailure(data.sessionKey);
        }
      }
      emitDebug("glasses.lifecycle", event, severity, {}, () => data || {});
    },

    start() {
      pushApprovalExplainSetting(true);
      pushWaitingSettings(true);

      try { if (getActiveBackendKind() === "openclaw") firstUseRelayRun?.resume(); } catch (_) {  }

      if (!taskRunsWatchTimer && taskRunsWeek) {
        try { taskRunsWeek.store.start(); } catch (_) {  }
        taskRunsWatchTimer = setInterval(() => {
          try { taskRunsWeek.store.beat(); } catch (_) {  }
        }, TASK_RUNS_WATCH_BEAT_MS);
        if (typeof taskRunsWatchTimer.unref === "function") taskRunsWatchTimer.unref();
      }

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
          fullPresetOn: () => debugAutoArm,
          getConnectedClientVersions: () => {
            const snapshot = server && typeof server.getReadinessSnapshot === "function"
              ? server.getReadinessSnapshot()
              : null;
            return snapshot && Array.isArray(snapshot.clients)
              ? snapshot.clients.map((entry     ) => entry && entry.clientVersion)
              : [];
          },
          armCategories: (cats     , ttlMs     ) => {
            const result = applyDebugSet("upload-capture-arming", {
              enable: cats,
              ttlMs,
            });
            if (server && typeof server.broadcastApp === "function") {
              server.broadcastApp(handler.formatDebugConfigSnapshot({
                serverNowMs: result.nowMs,
                enabled: result.enabled,
              }));
            }
            return result;
          },
          maxTtlMs: debugStore.getConfig().maxTtlMs,

          preset: opts.debugUploadCapturePreset,
          onArmError: (err         ) =>
            logger.warn(
              `[relay] upload-capture arming failed (preset override?): ${err instanceof Error ? err.message : err}`,
            ),
          setInterval,
          clearInterval,
        });
        refreshUploadCaptureArming = uploadCaptureArmingDisposer.refresh;
      }
      const startGateway = () => Promise.resolve(gatewayBridge.start())

        .then(() => hermesEnrollment.refresh("relay_start").catch(() => false))
        .then(() => {
          voiceCredentials.prefetchSonioxModels("relay_start").catch((err) => {
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
      openClawTaskResults.dispose();
      openClawTaskRowsBroadcast.dispose();
      openClawTaskPush.dispose();
      cardDrafts?.dispose();
      modelSites?.close();
      modelSitesConnections.clear();
      firstUseRelayRun?.shutdown();
      setupWelcome?.cancel();
      if (liveuiTaskRunController) {
        liveuiTaskRunController.observeHostLoss();
      }

      unsubscribeLiveuiTasksPush?.();
      unsubscribeLiveuiTasksPush = null;
      liveuiTasksPushController = null;
      stopLiveuiExecutorRegistry();
      simulation.clearSyntheticWork();
      sessionService.discardDraftSession("runtime_stop");
      demandRouter.forgetAll("runtime_stop");
      programCardJev.stopAll();
      programCardMcp.stopAll();
      programCardModel.stopAll();
      programCardAgentRefresh.stopAll();
      programCardSetupRequests.stopAll();
      stopCardDeleteListener();
      replyDelivery.dispose();
      if (botScreenSource) botScreenSource.dispose();
      if (bundleCacheSweepTimer) {
        clearInterval(bundleCacheSweepTimer);
        bundleCacheSweepTimer = null;
      }
      if (taskRunsWatchTimer) {
        clearInterval(taskRunsWatchTimer);
        taskRunsWatchTimer = null;
        try { taskRunsWeek?.store.beat(); } catch (_) {  }
      }
      if (stablePromptSweepTimer) {
        clearInterval(stablePromptSweepTimer);
        stablePromptSweepTimer = null;
      }
      if (uploadCaptureArmingDisposer) {
        uploadCaptureArmingDisposer();
        uploadCaptureArmingDisposer = null;
        refreshUploadCaptureArming = null;
      }
      if (evenAiEndpoint) {
        evenAiEndpoint.close();
      }
      evenAiRequestObservation.close();

      if (jevConnection) void jevConnection.close();
      for (const requestId of pendingBufferedEvenAiResponses.keys()) {
        cancelBufferedEvenAiHttpRequest({ requestId });
      }
      if (evenAiRunWaiter) {
        evenAiRunWaiter.close();
      }
      if (evenAiRestartRecovery) {
        evenAiRestartRecovery.close();
      }
      if (upstreamRuntime) {
        upstreamRuntime.stop();
      }
      sessionDriverWatch.disarm();
      sessionMirrorWatch.disarm();
      relayHealth.stop();
      gatewayBridge.stop();
      return Promise.all([
        sessionService.flushFirstSentUserMessageCache(),

        Promise.resolve(savedPromptsStore.flush()).catch(() => {}),

        Promise.resolve(ocuClawSettingsStore.flush()).catch(() => {}),
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
    completeBufferedEvenAiHttpRequest,
    cancelBufferedEvenAiHttpRequest,
    getEvenAiRequestObservation: () => evenAiRequestObservation.getSnapshot(),

    get pairingEndpoint() {
      return relayPairing.endpointService;
    },

    get pairingExchangeHost() {
      return relayPairing.exchangeHost;
    },

    getSessionDriverDiagnostics() {
      return { ...sessionDriverWatch.diagnostics(), mirror: sessionMirrorWatch.diagnostics() };
    },
    getSessionDriverProjection(sessionKey     ) {
      if (sessionKey !== relayApi.getConnectedAppActiveSessionKey()) return null;
      return sessionDriverWatch.projection(sessionKey);
    },
    onSessionDriverChanged(listener     ) {
      sessionDriverListeners.add(listener);
      return () => sessionDriverListeners.delete(listener);
    },

    getSessionMirrorDiagnostics() {
      return sessionMirrorWatch.diagnostics();
    },

    noteSessionMirrorTurnEnd(sessionKey     ) {
      return sessionMirrorWatch.noteOwnTurnEnd(sessionKey, "agent_end");
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

    get cardStudioForTest() {
      return cardStudio;
    },

    __stablePromptWouldChurnForTest(sessionKey     , perTurnSignals      = {}) {
      const startEmoji = perTurnSignals.neuralEmojiReactorState === "active";
      const startPace = perTurnSignals.neuralPaceModulatorState === "active";
      const startBeat = startPace;
      const startSpeck = perTurnSignals.neuralSpeckReactorState === "active";
      return stablePromptSnapshots.wouldChurn(
        sessionKey,
        sessionKey,
        computeStableChannelOne({
          emoji: startEmoji,
          pace: startPace,
          beat: startBeat,
          speck: startSpeck,
        }),
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
        simulation.clearSyntheticWorkForSession(sessionKey);
      } else {
        simulation.clearSyntheticWork();
      }
    },

    relayHealth,

    get httpServer() {
      return sharedHttpServer;
    },

    getEvenAiSettingsSnapshot() {
      return evenAiSettingsStore.getSnapshot();
    },

    consumePromptTurnOwnership(sessionKey     , identity      = null) {
      return promptTurnOwnership.consume(sessionKey, identity);
    },

    takeSurfaceDecisionForPrompt(sessionKey     , query      = {}) {
      if (!sessionKey) return Promise.resolve(null);

      const scoped = {
        ...query,
        budgetMs: Number.isFinite(query && query.budgetMs)
          ? query.budgetMs
          : Number.isFinite(jevConfig.budgetMs)
            ? jevConfig.budgetMs
            : 800,
      };

      const mapped = relaySessionKeyFor(sessionKey);

      return surfaceDecisionStore.takeDecisionForPrompt(sessionKey, {
        ...scoped,
        fallbackKeys: mapped && mapped !== sessionKey ? [mapped] : [],
        restyle: (decided     ) =>
          composeV2SurfaceDecision(decided, {
            openSurface:
              !!upstreamRuntime &&
              typeof upstreamRuntime.liveUiV2PatchTarget === "function" &&
              !!upstreamRuntime.liveUiV2PatchTarget(sessionKey),
          }),
      });
    },

    takeLiveUiV2FenceFragments(sessionKey     ) {
      if (!sessionKey || !upstreamRuntime) return [];
      if (typeof upstreamRuntime.takeLiveUiV2FenceFragments !== "function") return [];
      return upstreamRuntime.takeLiveUiV2FenceFragments(sessionKey);
    },

    collectLiveUiV2State(sessionKey     ) {
      if (!sessionKey || !upstreamRuntime || typeof upstreamRuntime.collectLiveUiV2State !== "function") return null;
      return upstreamRuntime.collectLiveUiV2State(sessionKey);
    },

    isLiveUiV2TapOwed(sessionKey     , eventId     ) {
      if (!sessionKey || !upstreamRuntime || typeof upstreamRuntime.isLiveUiV2TapOwed !== "function") return null;
      return upstreamRuntime.isLiveUiV2TapOwed(sessionKey, eventId);
    },

    isLiveUiV2Session(sessionKey     ) {
      return liveUiV2Session(sessionKey);
    },

    composeLiveUiV2Records(sessionKey     , input      = {}) {
      if (!upstreamRuntime || typeof upstreamRuntime.composeLiveUiV2Records !== "function") {
        return { ok: false, mode: "none", target: null, frame: null, placed: [], notes: [], reason: "relay_not_ready", painted: false, surfaceId: null, specRev: null };
      }
      return upstreamRuntime.composeLiveUiV2Records(sessionKey, input);
    },

    writeLiveUiV2Data(sessionKey     , surfaceId     , patch     ) {
      if (!upstreamRuntime || typeof upstreamRuntime.writeLiveUiV2Data !== "function") return { ok: false, reason: "surface_gone" };
      return upstreamRuntime.writeLiveUiV2Data(sessionKey, surfaceId, patch);
    },

    prefetchLiveUiV2Picture(sessionKey     , surfaceId     , src     , componentId     ) {
      if (!upstreamRuntime || typeof upstreamRuntime.prefetchLiveUiV2Picture !== "function") return Promise.resolve({ ok: true });
      return upstreamRuntime.prefetchLiveUiV2Picture(sessionKey, surfaceId, src, componentId);
    },

    setLiveUiV2Inputs(sessionKey     , surfaceId     , inputs     , values     ) {
      if (!upstreamRuntime || typeof upstreamRuntime.setLiveUiV2Inputs !== "function") return { ok: false, reason: "surface_gone" };
      return upstreamRuntime.setLiveUiV2Inputs(sessionKey, surfaceId, inputs, values);
    },

    isLiveUiV2SurfaceLive(sessionKey     , surfaceId     ) {
      if (!upstreamRuntime || typeof upstreamRuntime.isLiveUiV2SurfaceLive !== "function") return false;
      return upstreamRuntime.isLiveUiV2SurfaceLive(sessionKey, surfaceId) === true;
    },

    liveUiV2TopSurface(sessionKey     , opts      ) {
      if (!upstreamRuntime || typeof upstreamRuntime.liveUiV2TopSurface !== "function") return null;
      return upstreamRuntime.liveUiV2TopSurface(sessionKey, opts);
    },

    openLiveUiV2Records(sessionKey     , input      = {}) {
      if (!upstreamRuntime || typeof upstreamRuntime.openLiveUiV2Records !== "function") {
        return { ok: false, painted: false, surfaceId: null, specRev: null, notes: [], reason: "relay_not_ready" };
      }
      return upstreamRuntime.openLiveUiV2Records(sessionKey, input);
    },

    withdrawLiveUiV2Surface(sessionKey     , surfaceId     , reason     ) {
      if (!upstreamRuntime || typeof upstreamRuntime.withdrawLiveUiV2Surface !== "function") return false;
      return upstreamRuntime.withdrawLiveUiV2Surface(sessionKey, surfaceId, reason) === true;
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

    isFirstUseAttemptOpen() {
      if (!firstUseStore) return false;
      try { return firstUseAttemptHoldsSideWork(firstUseStore.read(), Date.now()); }
      catch (_) { return false; }
    },

    deleteDistillerSession(sessionKey) {
      return sessionService.deleteSessions("ocuclaw", [sessionKey]);
    },
    supportsProgramCardDrafts(sessionKey        ) { return !!resolveDraftContext(sessionKey)?.clientId; },
    writeProgramCardDraft(sessionKey        , card     ) { return cardDrafts?.write(sessionKey, card); },
    programCardDraftAction(sessionKey        , params     ) {
      const answer = cardDrafts?.run(sessionKey, params);
      if (!answer) return { ok: false, error: "draft_unavailable" };

      return Promise.resolve(answer).then((result     ) => withCardPhoneWhy(result, () => draftPhoneFacts(sessionKey)));
    },
    programCardDraftIndex(sessionKey        ) { return cardDrafts?.index(sessionKey) || ""; },
    getStateDir() {
      return opts.stateDir;
    },
    emitDebug(...args) {
      noteCardStudioTrace(args[0], args[1], args[2], args[3], args[4]);
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
    setupFirstUse(operation     , input      = {}) {
      if (getActiveBackendKind() !== "openclaw" || !firstUseStore) throw new Error("setup-first-use-unavailable");
      if (input.installationId && input.installationId !== setupInstallation(opts.setupStateDir).id) throw new Error("installation-mismatch");

      try {

        if (operation === "run_errored") {
          const stored = firstUseStore.read();
          if (!stored) return null;
          if (stored.status === "awaiting-reply") return erroredRunSince(stored.startedAt);
          return settledRunErrored(stored);
        }
        if (operation === "begin") {

          let phone      = null;
          try { phone = readSetupPhone(); } catch (_) { phone = null; }

          const stored      = firstUseStore.read();
          const resumeSession = firstUseAttemptPredatesPairing(stored) ? phone?.sessionKey : stored?.sessionKey;
          const begun      = firstUseStore.begin(input.sessionKey || resumeSession || sessionService.peekSessionKey(), input.retry === true, phone);
          const settled = settledRunErrored(begun);
          return settled ? { ...begun, replyRunErrored: settled } : begun;
        }
        const result      = runFirstUseOperation(firstUseStore, operation, input, () => readSetupPhone().sessionKey, readSetupPhone, observeFirstUseReplyEvidence);

        if (operation === "first_use_wait" && result?.status === "awaiting-reply") {
          const errored = erroredRunSince(firstUseStore.read()?.startedAt);
          if (errored) return firstUseWithRunErrored(result, errored);
        }

        if (operation === "first_use_wait" && result?.replyWasProviderError === true) {
          const settled = settledRunErrored(firstUseStore.read());
          if (settled) return firstUseWithRunErrored(result, settled);
        }
        return result;
      } finally {
        publishSetupHintIfChanged();
      }
    },
    setupFirstUseToolAvailable() {
      return getActiveBackendKind() === "openclaw" && !!firstUseStore;
    },

    refreshSetupHint() {
      publishSetupHintIfChanged();
      return setupHintPhase;
    },
    setupWelcomeAvailable() {
      return getActiveBackendKind() === "openclaw" && setupWelcome?.available() === true;
    },
    setupWelcome(input     , signal     ) {
      if (getActiveBackendKind() !== "openclaw" || !setupWelcome) throw new Error("setup-welcome-unavailable");
      if (input.installationId !== setupInstallation(opts.setupStateDir).id) throw new Error("installation-mismatch");
      return setupWelcome.run(input, signal);
    },

    cancelSetupWelcome() {
      if (getActiveBackendKind() !== "openclaw" || !setupWelcome) return false;
      return setupWelcome.cancel("cancelled") === true;
    },

    setupFirstUseRelayAvailable() {
      return getActiveBackendKind() === "openclaw" && !!firstUseRelayRun;
    },
    noteSetupSession(session     ) {
      if (getActiveBackendKind() !== "openclaw" || !firstUseRelayRun) return;
      firstUseRelayRun.noteSetupSession(session);
    },

    ingestRunSignal(data     ) {
      if (upstreamRuntime && typeof upstreamRuntime.ingestRunSignal === "function") {
        upstreamRuntime.ingestRunSignal(data);
      }
    },
    isSetupWakeRun(runId     ) {
      return !!firstUseRelayRun && firstUseRelayRun.isWakeRun(runId) === true;
    },

    checkTaskToolCall(input     ) {
      try {
        return checkTaskToolCall(input);
      } catch (err     ) {

        logger.warn(`[task-uses] check failed: ${err && err.message ? err.message : err}`);
        return { block: true, reason: TASK_USES_CHECK_FAILED_REASON };
      }
    },

    taskToolCallNeedsMarks(input     ) {
      try {
        if (getActiveBackendKind() !== "openclaw") return false;
        const mcp = input && input.mcp;
        if (!mcp || typeof mcp.server !== "string" || typeof mcp.tool !== "string") return false;
        if (!taskRunOfToolCall(input || {})) return false;
        const marks = programCardMcp.writeMarksOf(mcp.server, mcp.tool);
        return !(marks?.listed === true && marks?.cardsOn === true);
      } catch (_) {
        return false;
      }
    },

    noteTaskToolCall(input     ) {
      try {
        noteTaskToolCall(input);
      } catch (err     ) {
        logger.warn(`[task-tools] note failed: ${err && err.message ? err.message : err}`);
      }
    },

    taskToolFailuresOfJob(jobId     , endedAtMs      = null) {
      const id = typeof jobId === "string" ? jobId.trim() : "";
      if (!id) return null;
      try {
        const run = `job:${id}`;
        const failures = taskToolLedger.failures(run);
        if (Number.isSafeInteger(endedAtMs) && failures.some((failure     ) => failure.at > endedAtMs + 5_000)) return null;
        taskToolLedger.drop(run);
        return failures.length ? failures : null;
      } catch (_) {
        return null;
      }
    },

    taskToolsRanOfJob(jobId     ) {
      const id = typeof jobId === "string" ? jobId.trim() : "";
      if (!id) return null;
      try {
        return taskToolLedger.ran(`job:${id}`);
      } catch (_) {
        return null;
      }
    },

    onTaskTestResult(params     ) {
      try {
        return liveuiTaskTests.onResult(params);
      } catch (err     ) {
        logger.warn(`[task-test] result failed: ${err && err.message ? err.message : err}`);
        return { ok: false, error: "failed" };
      }
    },
    setupFirstUseRelay(operation     , input      = {}) {
      if (getActiveBackendKind() !== "openclaw" || !firstUseStore || !firstUseRelayRun) throw new Error("setup-first-use-unavailable");
      if (input.installationId && input.installationId !== setupInstallation(opts.setupStateDir).id) throw new Error("installation-mismatch");
      const session = input.setupSession;
      if (!session || typeof session.setupSessionKey !== "string") throw new Error("setup-session-required");
      firstUseRelayRun.noteSetupSession(session);
      const armed = (lines     ) => {
        const result      = firstUseResult(firstUseStore.read());
        if (result.status === "completed" || result.relayRun?.status !== "running") return result;
        return { ...result, nextOperations: [], say: [...lines], action: FIRST_USE_RELAY_ARM_ACTION };
      };
      const phoneSession = () => readSetupPhone().sessionKey;
      try {
        const { setupSession, ...params } = input;
        if (operation === "first_use_begin" || operation === "first_use_retry") {
          const begun      = runFirstUseOperation(firstUseStore, operation, { ...params, relayRun: session },
            phoneSession, readSetupPhone, observeFirstUseReplyEvidence);
          if (begun.status === "completed") return begun;
          firstUseRelayRun.arm();
          const status = firstUseStore.read()?.status;
          return armed(status === "awaiting-welcome" ? FIRST_USE_RELAY_WELCOME_LINES : FIRST_USE_RELAY_ARM_LINES);
        }
        if (operation === "first_use_wait") {

          const r = firstUseStore.read();
          if (!r) throw new Error("setup-attempt-required");
          if (r.relayRun && !r.relayRun.ending && !firstUseRelayRun.running()) firstUseRelayRun.arm();
          return armed(r.status === "awaiting-welcome" ? FIRST_USE_RELAY_WELCOME_LINES : FIRST_USE_RELAY_ARM_LINES);
        }
        if (operation === "first_use_confirm") {
          const result      = runFirstUseOperation(firstUseStore, operation, params, phoneSession, readSetupPhone, observeFirstUseReplyEvidence);
          const r = firstUseStore.read();
          if (r?.status !== "awaiting-welcome" || r.welcome) return result;

          firstUseStore.armRelayRun(r.attemptId, session);
          firstUseRelayRun.arm();
          return armed(FIRST_USE_RELAY_WELCOME_LINES);
        }
        if (operation === "first_use_welcome" || operation === "first_use_welcome_retry") {
          const r = firstUseStore.read();
          if (!r) throw new Error("setup-attempt-required");
          if (r.status === "completed") return firstUseResult(r);
          if (params.binding !== firstUseBinding(r)) throw new Error("setup-confirmation-mismatch");
          if (r.status !== "awaiting-welcome") throw new Error("setup-welcome-mismatch");
          const retry = operation === "first_use_welcome_retry";
          if (r.welcome && !retry) throw new Error("setup-welcome-retry-required");
          if (retry && r.welcome?.attempts >= 2) throw new Error("setup-welcome-retry-exhausted");
          if (!setupWelcome?.available()) throw new Error("setup-welcome-unavailable");
          firstUseStore.armRelayRun(r.attemptId, session);
          firstUseRelayRun.arm({ retryWelcome: retry && !!r.welcome });
          return armed(FIRST_USE_RELAY_WELCOME_LINES);
        }
        throw new Error("setup-first-use-operation-invalid");
      } finally {
        publishSetupHintIfChanged();
      }
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

    onHermesManagementForTest(input     ) {
      return hermesManagementRequest(input);
    },

    onCreateHermesProfileForTest(input     ) {
      return createHermesProfile(input);
    },

    _clearLogicalSessionState(sessionKey) {
      clearLogicalSessionState(sessionKey, "test_hook");
    },

    _dispatchAppClientDisconnectForTest(sessionKey     ) {
      dispatchAppClientDisconnect(sessionKey);
    },

    _currentStatusForTest() {
      return cacheStatus(buildStatusObject());
    },

    sendGlassesUiRender(params) {
      sendGlassesUiRender(params);
    },

    setLiveuiGlassesLibraryController(controller     ) {
      liveuiGlassesLibraryController = controller || null;
    },

    setTaskJobRunner(handler     ) {
      hostTaskJobRunner = handler || null;
    },

    resolveLiveuiTaskExecutorState,
    stopLiveuiExecutorRegistry,

    sendDemand(params) {
      sendDemand(params);
    },

    presentHermesSlashConfirm(params) {
      return hermesSlashConfirmRouter.present(params || {});
    },

    cardBuildNotesOn() {
      return normalizeOcuClawAgentProgressNotes(Reflect.get(ocuClawSettingsStore.getSnapshot(), "agentProgressNotes")) === "conversation";
    },

    noteCardStudioToolCall(call     ) {
      return noteCardStudioToolCall(call);
    },

    cardBuildTaskFor(sessionKey     ) {
      return cardBuildPhases.taskFor(typeof sessionKey === "string" ? sessionKey : "");
    },

    cardBuildTestCard(sessionKey     ) {
      const key = typeof sessionKey === "string" ? sessionKey : "";

      const fix = taskFixOfSession(key);

      if (fix) return { inputs: fix.inputs, values: fix.values, atMs: fix.atMs, ...(fix.kept ? { kept: fix.kept } : {}),
        ...(fix.parts ? { part: fix.slot, parts: fix.parts, taskSlots: fix.parts.map((part     ) => part.name) } : {}) };
      const testId = cardBuildPhases.taskTestFor(key);
      const card = testId ? liveuiTaskTests.cardOf(testId) : null;

      const plan      = card ? cardBuildAddPlan(key) : null;
      return plan?.status === "accepted" ? { ...card, part: plan.slot, parts: plan.parts } : card;
    },

    cardBuildStarter(sessionKey     ) {
      const key = typeof sessionKey === "string" ? sessionKey : "";
      const marker = cardBuildPhases.taskFor(key);
      if (!marker || marker.addTo || marker.fix || taskFixOfSession(key)) return null;
      const testId = cardBuildPhases.taskTestFor(key);
      const ran = testId ? liveuiTaskTests.starterOf(testId) : null;
      if (!ran) return null;
      return { starterId: ran.starter.starterId, name: cardStarterName(ran.starter, ran.locale),
        source: cardStarterSource(ran.starter, ran.locale) };
    },

    async cardBuildTaskAdd(sessionKey     ) {
      const key = typeof sessionKey === "string" ? sessionKey : "";
      const plan      = cardBuildAddPlan(key);
      if (!plan) return null;

      const opened = plan.status !== "accepted" ? null : cardDrafts ? await cardDrafts.openSaved(key, plan.card.appId) : NO_DRAFT_SERVICE_OPEN;
      if (opened && opened.ok !== true) logger.warn(`[program-card] add-to draft not opened card=${plan.card.appId} error=${opened.error}`);
      return cardPartAddHandOff(plan, opened, opened && opened.ok !== true ? cardOpenWhy(key, opened.error) : "");
    },

    cardBuildTaskFixCheck(sessionKey     ) {
      const fix = taskFixOfSession(typeof sessionKey === "string" ? sessionKey : "");
      return fix?.check ? { ...fix.check } : null;
    },

    cardBuildTaskFixAsk(sessionKey     ) {
      const fix = taskFixOfSession(typeof sessionKey === "string" ? sessionKey : "");
      return fix ? { name: fix.cardName, label: fix.label, ...taskFixAskWords(fix) } : null;
    },

    async cardBuildTaskFix(sessionKey     ) {
      const key = typeof sessionKey === "string" ? sessionKey : "";
      const fix = taskFixOfSession(key);
      if (!fix) return null;
      const source      = programCardSaves.source({ appId: fix.cardId });
      const refused = source?.status !== "accepted" ? TASK_FIX_BUILD_CODES.card
        : source.revision !== fix.revision || source.sourceHash !== fix.sourceHash ? TASK_FIX_BUILD_CODES.changed : null;
      if (refused) {
        logger.warn(`[program-card] fix not opened card=${fix.cardId} code=${refused}`);
        return taskFixHandOff(fix, null, refused);
      }
      const opened = cardDrafts ? await cardDrafts.openSaved(key, fix.cardId) : NO_DRAFT_SERVICE_OPEN;
      if (opened && opened.ok !== true) logger.warn(`[program-card] fix draft not opened card=${fix.cardId} error=${opened.error}`);
      if (opened?.draft?.draftId) fix.draftId = opened.draft.draftId;
      return taskFixHandOff(fix, opened, null, opened && opened.ok !== true ? cardOpenWhy(key, opened.error) : "");
    },

    cardBuildNoDraftsWhy(sessionKey     ) {
      return cardDrafts ? "" : cardOpenWhy(typeof sessionKey === "string" ? sessionKey : "", PROGRAM_CARD_NO_DRAFT_SERVICE);
    },

    cardBuildFindSaved(_sessionKey     , query     ) {
      return cardChanges ? cardChanges.find(query) : { status: "none", matches: [] };
    },

    async cardBuildChange(sessionKey     , change     ) {
      const key = typeof sessionKey === "string" ? sessionKey : "";
      if (!cardChanges) return null;
      const handOff      = await cardChanges.open(key, change || {});
      if (handOff?.refused) logger.warn(`[program-card] change not opened card=${change?.appId} error=${handOff.openError}`);
      return handOff;
    },

    cardBuildChangeOf(sessionKey     ) {
      return cardChanges ? cardChanges.of(typeof sessionKey === "string" ? sessionKey : "") : null;
    },

    cardBuildChangeReplace(sessionKey     , numbers     , notChecks      ) {
      return cardChanges ? cardChanges.replace(typeof sessionKey === "string" ? sessionKey : "", numbers, notChecks) : null;
    },

    cardBuildChangeDone(sessionKey     ) {
      const result      = cardChanges ? cardChanges.done(typeof sessionKey === "string" ? sessionKey : "") : null;
      if (result) logger.info(`[program-card] change done card=${result.appId} ${result.status === "saved" ? `revision=${result.revision}` : `error=${result.code}`}`);
      return result;
    },

    cardBuildChangeTested(sessionKey     , tested      = true) {

      return cardChanges ? cardChanges.tested(typeof sessionKey === "string" ? sessionKey : "", tested !== false) : false;
    },

    async cardBuildChangeRevive(sessionKey     , draftId     ) {
      if (!cardChanges || typeof draftId !== "string" || !draftId) return false;
      try {
        return (await cardChanges.revive(typeof sessionKey === "string" ? sessionKey : "", draftId)) === true;
      } catch {
        return false;
      }
    },

    cardBuildChangeLiveFailed(sessionKey     , failed     ) {
      return cardChanges ? cardChanges.liveFailed(typeof sessionKey === "string" ? sessionKey : "", failed === true) : false;
    },

    cardBuildLiveFailed(sessionKey     , parts     ) {
      if (typeof sessionKey !== "string" || !sessionKey) return false;
      const at = relayKeyOf(sessionKey);
      cardBuildLiveFailed.delete(at);
      const failed = Array.isArray(parts) ? parts.filter((part) => part && typeof part === "object").slice(0, 4)
        .map((part) => ({ kind: part.kind, name: part.name, reason: part.reason, ...(part.httpStatus ? { httpStatus: part.httpStatus } : {}) })) : [];
      if (!failed.length) return false;
      cardBuildLiveFailed.set(at, failed);
      while (cardBuildLiveFailed.size > 64) cardBuildLiveFailed.delete(cardBuildLiveFailed.keys().next().value          );
      return true;
    },

    async cardBuildChangeSpoken(sessionKey     , open     ) {
      return openSpokenCardChange(typeof sessionKey === "string" ? sessionKey : "", open);
    },

    programCardChangeLine(sessionKey     ) {
      return cardChanges ? cardChangeTurnLine(cardChanges.of(typeof sessionKey === "string" ? sessionKey : "")) : "";
    },

    programCardCheckAsked(sessionKey     , turn      = {}) {
      const session = typeof sessionKey === "string" ? sessionKey : "";
      const asked = cardCheckAskOf(session, turn);
      if (!asked) return null;
      const health        = [];
      for (const engine of [programCardMcp, programCardJev, programCardModel]) {
        try { health.push(...engine.health(`app:${asked.appId}`, null)); } catch (_) {  }
      }
      return { ...asked, health };
    },

    planCardBuildTurn(sessionKey     , info     ) {
      return cardBuildTurns.plan(typeof sessionKey === "string" ? sessionKey : "", info || {});
    },

    cardAskNotShown(rawSessionKey     ) {
      const rawKey = typeof rawSessionKey === "string" ? rawSessionKey.trim() : "";
      const sessionKey = (rawKey && relaySessionKeyFor(rawKey)) || rawKey;
      if (sessionKey) broadcastCardBuild(cardBuildPhases.askNotShown({ sessionKey }), "ask:not_asked");
    },

    presentCardAsk(params      = {}) {
      const rawKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
      const sessionKey = (rawKey && relaySessionKeyFor(rawKey)) || rawKey;
      const question = typeof params.question === "string" ? params.question.trim() : "";
      if (!sessionKey || !question) return Promise.resolve({ answer: "no_answer", reason: "invalid_request" });

      notePlanIcon(sessionKey, null);
      if (!server || server.getConnectedAppCount() === 0) {
        return Promise.resolve({ answer: "no_answer", reason: "no_connected_client" });
      }
      const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(1000, Number(params.timeoutMs)) : 60_000;
      const expiresAtMs = Date.now() + timeoutMs;
      const plan = fitCardPlan(params.plan);
      const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 40) : null;
      const askedUses = typeof params.uses === "string" && params.uses.trim() ? params.uses.replace(/\s+/g, " ").trim() : "";

      const fix = typeof params.fix === "string" && params.fix.trim() ? params.fix.replace(/\s+/g, " ").trim().slice(0, 40) : null;

      const task = fix ? null : cardBuildPhases.taskFor(sessionKey);
      const taskUses = task ? `shows your ${task.name} result` : "";
      const uses = [taskUses, askedUses].filter(Boolean).join("; ").slice(0, 280) || null;

      const choices = !fix && !task && plan && hasConnectedClientCapability(PROGRAM_CARD_PLAN_CAPABILITY) &&
        hasConnectedClientCapability(PROGRAM_CARD_CHOICE_CAPABILITY) ? fitCardDirections(params.choices) : null;
      let iconPick      = plan && !choices ? planCardIcon(sessionKey, name, plan) : null;
      const icon = iconPick ? iconPick.icon : null;
      if (plan) broadcastCardBuild(cardBuildPhases.plan(choices ? { sessionKey, name, choice: true } : { sessionKey, name, plan, icon }));

      cardBuildPhases.askSay({ sessionKey, reason: params.reason, say: params.say });

      broadcastCardBuild(cardBuildPhases.askStart({ sessionKey }), "ask:shown");
      const planShown = !!plan && hasConnectedClientCapability(PROGRAM_CARD_PLAN_CAPABILITY);

      const changeShown = planShown && hasConnectedClientCapability(PROGRAM_CARD_CHANGE_CAPABILITY);
      const changeWaitMs = Number.isFinite(params.changeWaitMs)
        ? Math.max(1000, Number(params.changeWaitMs))
        : CARD_ASK_CHANGE_WAIT_MS;

      const sites           = planShown && !choices && !fix && !task ? fitCardSites(params.sites) : [];
      const grantShownSites = (shownSites     ) => {
        const shown = Array.isArray(shownSites) ? sites.filter((host) => shownSites.includes(host)) : [];
        const allowed = shown.filter((host) => {
          try { return grantLiveSite(host)?.ok === true; } catch (_) { return false; }
        });

        emitDebug("glasses.lifecycle", "program_card_plan_sites", "info", { sessionKey }, () => ({
          listed: sites.length, shown: shown.length, allowed: allowed.length,
        }));
        return allowed;
      };
      return new Promise((resolve) => {
        const accepted = demandRouter.presentDecision({
          surface: {
            surfaceId: `card-ask:${sessionKey}:${Date.now().toString(36)}`,
            sessionKey,
            kind: "question",
            title: typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Make a card?",
            question,

            options: choices
              ? [...choices.map((direction     , index        ) => ({ key: `pick:${index}`, label: direction.label })), { key: "no", label: "No thanks" }]
              : [
                { key: "yes", label: "Yes, make it" },
                { key: "no", label: "No thanks" },
              ],
            deadlineSec: Math.ceil(timeoutMs / 1000),
            ...(planShown
              ? { cardPlan: {
                name, lines: plan, ...(icon ? { icon } : {}), ...(uses ? { uses } : {}), ...(changeShown ? { change: true } : {}),
                ...(fix ? { fix } : {}),
                ...(choices ? { choices: choices.map((direction     ) => ({ label: direction.label })) } : {}),
                ...(sites.length ? { sites } : {}),
              } }
              : {}),
          },
          expiresAtMs,
          ...(changeShown ? { textChoice: "change", textWaitMs: changeWaitMs } : {}),
          onDecision: ({ choice: decided, reason, text, shownSites }     ) => {

            const pickedIndex = choices && typeof decided === "string" && decided.startsWith("pick:") ? Number(decided.slice(5)) : -1;
            const picked = pickedIndex >= 0 && choices ? choices[pickedIndex] || null : null;
            const choice = picked ? "yes" : decided;

            if (picked) {
              iconPick = planCardIcon(sessionKey, picked.label, picked.plan);
              broadcastCardBuild(cardBuildPhases.plan({ sessionKey, name: picked.label, plan: picked.plan, icon: iconPick.icon }));
            }
            const change = choice === "change" && typeof text === "string" && text ? text : "";

            const ownWords = choices && change ? fitCardPlan([change]) : null;
            if (ownWords) broadcastCardBuild(cardBuildPhases.plan({ sessionKey, name: null, plan: ownWords }));

            if (iconPick && !change && choice !== "yes") iconPick.open = false;

            if (iconPick && !change && choice === "no" && planIconForSession(sessionKey) === iconPick) notePlanIcon(sessionKey, null);
            broadcastCardBuild(cardBuildPhases.askAnswer({
              sessionKey,
              answer: change ? "yes" : choice,
              ...(change ? { change } : {}),
            }), `ask:${change ? "change" : choice}`);
            const choiceShown = choices ? { choiceShown: true } : {};

            const sitesAllowed = sites.length && choice === "yes" && !change ? { sitesAllowed: grantShownSites(shownSites) } : {};
            if (change) resolve({ answer: "yes", change, planShown, ...choiceShown });
            else if (choice === "yes" || choice === "no") {
              resolve({ answer: choice, ...(planShown ? { planShown } : {}), ...choiceShown, ...(picked ? { picked: pickedIndex } : {}), ...sitesAllowed });
            } else resolve({ answer: "no_answer", reason: reason || "cancel", ...(planShown ? { planShown } : {}), ...choiceShown });
          },
        });
        if (!accepted) {
          if (iconPick) iconPick.open = false;

          broadcastCardBuild(cardBuildPhases.askAnswer({ sessionKey, answer: "no_answer" }), "ask:not_shown");
          resolve({ answer: "no_answer", reason: "presentation_failed" });
        }
      });
    },

    presentTaskConfirm(params      = {}) {
      const confirmId = typeof params.confirmId === "string" ? params.confirmId.trim() : "";
      const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
      if (!confirmId || !sessionKey || !Array.isArray(params.options) || params.options.length === 0) {
        return { presented: false, reason: "invalid_request" };
      }
      if (!server || server.getConnectedAppCount() === 0) return { presented: false, reason: "no_connected_client" };
      const expiresAtMs = Number.isFinite(params.expiresAtMs) ? Number(params.expiresAtMs) : Date.now() + 120_000;
      const accepted = demandRouter.presentDecision({
        surface: {
          surfaceId: `task-confirm:${sessionKey}:${confirmId}`,
          sessionKey,
          kind: "permission",
          title: typeof params.title === "string" ? params.title : "New Task",
          question: params.question,
          options: params.options,
          deadlineSec: Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000)),
        },
        expiresAtMs,
        onDecision: params.onDecision,
      });
      return accepted ? { presented: true } : { presented: false, reason: "presentation_failed" };
    },

    sendBoardMoment(moment     ) {
      if (!server || typeof server.unicast !== "function" || typeof server.getReadinessSnapshot !== "function") return 0;
      const frame = formatBoardMoment(moment);
      let sent = 0;
      for (const entry of server.getReadinessSnapshot().clients || []) {
        if (entry && entry.clientKind === "app") {
          server.unicast(entry.clientId, frame);
          sent += 1;
        }
      }
      return sent;
    },

    sendTaskPushMessage(task     , clientId      ) {
      if (!server || typeof server.unicast !== "function" || typeof server.getReadinessSnapshot !== "function") return 0;
      const frame = formatTaskPushMessage(task);
      let sent = 0;
      for (const entry of server.getReadinessSnapshot().clients || []) {
        if (!supportsTaskPush(entry) || (clientId != null && entry.clientId !== clientId)) continue;
        server.unicast(entry.clientId, frame);
        sent += 1;
      }
      return sent;
    },

    sendTaskRowsFrame(frame     ) {
      if (typeof frame !== "string" || !server || typeof server.unicast !== "function" ||
        typeof server.getReadinessSnapshot !== "function") return 0;
      let sent = 0;
      for (const entry of server.getReadinessSnapshot().clients || []) {
        if (!supportsTaskPush(entry)) continue;
        server.unicast(entry.clientId, frame);
        sent += 1;
      }
      return sent;
    },

    taskRowsChanged() {
      ringTaskRows();
    },

    taskCardRuns() {
      return taskCardRuns.snapshot();
    },

    taskUncheckedRuns() {
      return taskUncheckedRuns();
    },

    taskLeftOut(taskId        ) {
      return taskLeftOut(taskId);
    },

    taskRunsWeekResult(result     ) {
      return taskRunsWeek ? taskRunsWeek.onResult(result) : null;
    },

    taskRunsWeekJobRuns(list     ) {
      return taskRunsWeek ? taskRunsWeek.onJobRuns(list) : null;
    },

    taskRunsWeek(taskId        ) {
      return taskRunsWeekFor(taskId);
    },

    openClawTaskSchedulesOn() {
      return openClawTaskSchedulesOn();
    },

    openClawTaskSchedulesAvailable() {
      return openClawTaskSchedule.available() === true;
    },

    openClawTaskPageWatchAvailable() {
      return openClawTaskSchedule.pageWatchAvailable() === true;
    },

    taskScheduleRequest(identity     ) {
      return openClawTaskSchedule.handle(identity);
    },

    noteOpenClawCronEnabled(enabled     ) {
      openClawTaskSchedule.noteCronEnabled(enabled);

      if (enabled === true && openClawTaskSchedulesOn()) {
        openClawTaskResults.start();
        void openClawTaskResults.sweep();

        void openClawTaskSchedule.sweepStaleTests();
      }
    },

    noteOpenClawAgentFinalize(event     , ctx     ) {
      openClawTaskResults.noteFinalize(event, ctx);
    },

    noteOpenClawRunModel(ctx     ) {
      const runId = ctx && typeof ctx.runId === "string" ? ctx.runId : "";
      const provider = ctx && typeof ctx.modelProviderId === "string" ? ctx.modelProviderId : "";
      if (!runId || !provider) return;
      openClawRunProviders.delete(runId);
      if (openClawRunProviders.size >= OPENCLAW_RUN_PROVIDERS_MAX) {
        openClawRunProviders.delete(openClawRunProviders.keys().next().value          );
      }
      openClawRunProviders.set(runId, provider);
    },

    openClawTaskRunContext(event     , ctx     ) {
      let wrap     ;
      try {
        wrap = openClawDayWrap.beforePromptBuild(event, ctx);
      } catch (_) {

        wrap = undefined;
      }
      const jobId = openClawTaskSchedulesOn() ? cronJobOfSessionKey(ctx && ctx.sessionKey) : null;
      const blocks = jobId ? taskRunPrompt(jobId, undefined, "openclaw") : null;
      const parts = [wrap && typeof wrap.prependContext === "string" ? wrap.prependContext : null, blocks]
        .filter((part) => typeof part === "string" && part);
      return parts.length ? { prependContext: parts.join("\n\n") } : undefined;
    },

    taskRunPrompt(jobId     , schedules      = undefined) {
      return taskRunPrompt(jobId, schedules);
    },

    taskAlertRunEnd(jobId     , run     , schedules      = undefined) {
      return taskAlertRunEnd(jobId, run, schedules);
    },

    taskAlertRepeat(result     , schedules      = undefined) {
      return taskAlertRepeat(result, schedules);
    },

    noteOpenClawCronChanged(event     ) {
      noteOpenClawJobMarks(event);
      if (!openClawTaskSchedulesOn()) return;
      openClawTaskResults.start();
      openClawTaskResults.noteCronChanged(event);
    },

    openClawTaskRecentResults(jobId     ) {
      return readRecentTaskResultHistory(openClawTaskResults.link, jobId, logger);
    },

    feedProgramCard(params     ) {
      if (!programCardFeed) return { status: "rejected", code: "no_feed_run" };
      return programCardFeed.feedFromRun(params || {});
    },

    deliverProgramCardTaskResult(params     ) {
      if (!programCardFeed) return { status: "skipped", reason: "no_feed" };
      return programCardFeed.deliverTaskResult(params || {});
    },

    sendTaskLookOffer(offer     ) {
      if (!server || typeof server.unicast !== "function" || typeof server.getReadinessSnapshot !== "function") return 0;
      const curated = taskLookOffer(offer);
      if (!curated) return 0;
      const frame = formatTaskLookOffer(curated);
      let sent = 0;
      for (const entry of server.getReadinessSnapshot().clients || []) {
        if (!supportsTaskPush(entry)) continue;
        server.unicast(entry.clientId, frame);
        sent += 1;
      }
      return sent;
    },

    sendGlassesUiSurfaceUpdate(params) {
      sendGlassesUiSurfaceUpdate(params);
    },

    broadcastPushMessage(params) {
      return broadcastPushMessage(params);
    },

    dispatchGlassesWake(params) {

      const sessionKey = params && typeof params.sessionKey === "string" ? params.sessionKey : "";
      const channelPrompt =
        getActiveBackendKind() === "hermes" && sessionKey
          ? stablePromptSnapshots.peek(sessionKey, sessionKey)
          : "";
      if (!sessionKey) return dispatchAgentWake(channelPrompt ? { ...params, channelPrompt } : params);

      agentTurnTracker.markBusy(sessionKey);
      return cardBuildTurns.beforeTurn(sessionKey, isCardWorkTurn(sessionKey)).then(() =>
        dispatchAgentWake(channelPrompt ? { ...params, channelPrompt } : params));
    },

    isAgentTurnBusy(sessionKey) {
      return agentTurnTracker.isBusy(sessionKey);
    },

    currentAgentRunId(sessionKey     ) {
      return agentTurnTracker.runIdFor(sessionKey);
    },

    onGlassesUiResult(handler) {
      return glassesUiResultChannel.on(handler);
    },

    onLiveUiV2Outcome(handler     ) {
      return liveUiV2OutcomeChannel.on(handler);
    },

    onGlassesUiNavEvent(handler) {
      return glassesUiNavEventChannel.on(handler);
    },

    onGlassesUiRenderReceipt(handler     ) {
      return glassesUiRenderReceiptChannel.on(handler);
    },

    onGlassesUiClientFailure(handler     ) {
      return glassesUiClientFailureChannel.on(handler);
    },

    sendDeviceInfoRequest(params) {
      sendDeviceInfoRequest(params);
    },

    onDeviceInfoResponse(handler) {
      return deviceInfoResponseChannel.on(handler);
    },

    getPhoneSettings() {
      return phoneSettingsRoundTrip.get();
    },

    setPhoneSetting(params     ) {
      return phoneSettingsRoundTrip.set(params);
    },

    showBotScreen(params      ) {
      return botScreenShowRoundTrip.show(params);
    },
    onGlassesPresenceChanged(handler     ) {
      return glassesPresenceChangedChannel.on(handler);
    },

    onProgramCardFeeds(handler     ) {
      return programCardFeedsChannel.on(handler);
    },

    sendProgramCardData(frame     ) {
      sendProgramCardData(frame);
    },

    askLiveuiSite(request     ) {
      return programCardLocation.askSite(request);
    },

    liveProgramCardParts(params      = {}) {
      const request = params || {};

      const mcp = () => (request.mcp === true && typeof request.key === "string" ? programCardMcp.lastCallsOf(request.key) : null);
      const controller = request.feeds === true ? resolveLiveuiGlassesLibraryController() : null;
      if (!controller || typeof controller.programCardFeedOutcomes !== "function") return Promise.resolve({ feeds: null, mcp: mcp() });
      try {
        return Promise.resolve(controller.programCardFeedOutcomes(request)).then((feeds     ) => ({ feeds, mcp: mcp() }), () => ({ feeds: null, mcp: mcp() }));
      } catch (_) {
        return Promise.resolve({ feeds: null, mcp: mcp() });
      }
    },

    settleProgramCardSites(params      = {}) {
      const controller = resolveLiveuiGlassesLibraryController();

      const located = params && params.location === true ? settleCardLocationAsk() : Promise.resolve(null);
      return located.then((location     ) => {
        if (!controller || typeof controller.settleProgramCardFeeds !== "function") return location ? { feeds: 0, asked: 0, allowed: 0, ready: true, ms: 0, location } : null;
        try {
          return Promise.resolve(controller.settleProgramCardFeeds(params || {}))
            .then((settled     ) => (settled && location ? { ...settled, location } : settled), () => null);
        } catch (_) {
          return null;
        }
      });
    },

    considerProgramCardJev(params      = {}) {
      return programCardJev.consider(params || {});
    },

    programCardJevTaught() {
      return programCardJev.armed() === true && hasConnectedClientCapability(PROGRAM_CARD_JEV_CAPABILITY);
    },
    programCardSwitches() {
      return { jev: programCardJev.state().enabled, mcp: programCardMcp.state().enabled, model: programCardModel.state().enabled };
    },

    async programCardToolsFacts(opts      = {}) {
      const cards = connectedAppClientHas(PROGRAM_CARD_CAPABILITY) === true;
      const mcp = programCardMcp.state().enabled === true;
      if (!opts || opts.servers !== true) return { cards, mcp };
      if (!mcp) return { cards, mcp, known: true, reason: "", servers: [] };

      let timer      = null;
      let listed = false;
      try {
        listed = await Promise.race([
          Promise.resolve(programCardMcp.refresh()).then(() => true),
          new Promise         ((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
        ]);
      } catch (_) {
        listed = false;
      } finally {
        clearTimeout(timer);
      }
      const reason = programCardMcp.hostHealth();
      const rows = programCardMcp.state().servers || [];
      return { cards, mcp, known: listed && programCardMcp.hostHealthKnown() === true, reason: typeof reason === "string" ? reason : "",
        servers: rows.map((row     ) => ({ name: row.name, connected: row.connected === true, cards: row.cards === true })) };
    },

    programCardHealth(key     , sessionKey      = "", declared      = null) {
      return programCardHealthRows(key, sessionKey, declared);
    },

    programCardFeedHealth(cardId     , key      = "", sessionKey      = "") {
      if (typeof cardId !== "string" || !cardId) return [];
      if (typeof key === "string" && key.startsWith("app:") && !savedCardReadable(key.slice(4), sessionKey)) return [];
      try {
        const rows = resolveLiveuiGlassesLibraryController()?.programCardFeedHealth?.(cardId);
        return Array.isArray(rows) ? rows : [];
      } catch (_) {
        return [];
      }
    },

    programCardCheck(sessionKey      = "", query      = null) {
      const session = typeof sessionKey === "string" ? sessionKey : "";
      let saved        = [];
      try {
        saved = programCardSaves.list().filter((card     ) => savedCardReadable(card.appId, session));
      } catch (_) {
        return { status: "unavailable" };
      }
      if (query !== null && query !== undefined) {
        const found      = findSavedCard(saved, query);
        if (found.status !== "found") return { status: found.status, matches: found.matches.map((card     ) => ({ appId: card.appId, name: card.name })) };
        return { status: "found", card: { appId: found.card.appId, name: found.card.name }, ...savedCardHealth(found.card.appId) };
      }
      const cards        = [];
      const read = saved.slice(0, PROGRAM_CARD_CHECK_CARDS_MAX);
      for (const card of read) {
        const { parts, judged: _judged, ...unjudged }      = savedCardHealth(card.appId);
        if (parts.length || unjudged.notRead || unjudged.noRecord) cards.push({ appId: card.appId, name: card.name, parts, ...unjudged });
      }
      return { status: "all", read: read.length, left: saved.length - read.length, cards };
    },

    async programCardHostHealth(parts     ) {
      const rows        = [];
      for (const [part, engine] of [["mcp", programCardMcp], ["jev", programCardJev]]         ) {
        if (!Array.isArray(parts) || !parts.includes(part)) continue;
        try {
          const reason = await engine.hostHealth();
          if (reason) rows.push({ part, use: "", reason });
        } catch (_) {  }
      }
      return rows;
    },

    async programCardSetupFacts() {
      const host        = [];
      const notRead           = [];
      for (const [part, engine] of [["mcp", programCardMcp], ["jev", programCardJev], ["model", programCardModel]]         ) {
        try {
          const reason = await engine.hostHealth();
          if (typeof reason === "string" && reason) host.push({ part, use: "", reason });

          else if (typeof (engine       ).hostHealthKnown === "function" && (engine       ).hostHealthKnown() === false) notRead.push(part);
        } catch (_) {
          notRead.push(part);
        }
      }
      return { phone: { connected: server ? server.getConnectedAppCount() > 0 : null, cards: connectedAppClientHas(PROGRAM_CARD_CAPABILITY) },
        host, ...(notRead.length ? { notRead } : {}) };
    },

    async taskRunRow(taskId     ) {
      if (typeof taskId !== "string" || !taskId) return null;
      const rows = await readTaskRunRows();
      const row = Array.isArray(rows) ? rows.find((entry     ) => entry && entry.taskId === taskId) : null;
      return row && typeof row === "object" ? row : null;
    },

    taskRunRows() {
      return readTaskRunRows();
    },
    considerProgramCardModel(params     ) { return programCardModel.consider(params); },

    considerProgramCardAgentRefresh(params     ) { return considerProgramCardAgentRefresh(params); },

    programCardAgentRefreshAllowed(key     ) { return programCardAgentRefresh.allowed(key); },

    holdCardBuildDone(sessionKey        , settled                  , maxMs        ) {
      return holdCardBuildDone(sessionKey, settled, maxMs);
    },

    noteCardBuildSpeck(sessionKey        , text        ) {
      if (typeof sessionKey !== "string" || typeof text !== "string") return;
      broadcastCardBuild(cardBuildPhases.speck({ sessionKey, runId: null, text }), "speck");
    },

    noteCardBuildFrameIdea(sessionKey        , idea        ) {
      if (typeof sessionKey !== "string" || typeof idea !== "string") return;
      broadcastCardBuild(cardBuildPhases.frameIdea({ sessionKey, idea }), "frameIdea", { only: "studio" });
    },
    completeProgramCardFrame: programCardFrameCompleteFn(),

    programCardFrameDetail: () => programCardArt.detail(),

    noteProgramCardFrameBrief(source     , brief     ) {
      programCardFrameBriefs.note(source, brief);
    },
    applyProgramCardSwitches(values     ) {
      if (!values || typeof values !== "object") throw new Error("invalid_switches");
      if (typeof values.jev === "boolean") programCardJev.setEnabled(values.jev);
      if (typeof values.mcp === "boolean") programCardMcp.setEnabled(values.mcp);
      if (typeof values.model === "boolean") programCardModel.setEnabled(values.model);

      for (const name of ["jev", "mcp", "model"]) if (values[name] === true) programCardSetupRequests.noteOn(`switch:${name}`);
      return { jev: programCardJev.state().enabled, mcp: programCardMcp.state().enabled, model: programCardModel.state().enabled };
    },

    applyLiveuiJev(values     ) {
      if (!values || typeof values !== "object" || typeof values.enabled !== "boolean") throw new Error("invalid_switches");
      return setLiveuiJevEnabled(values.enabled);
    },

    considerProgramCardMcp(params      = {}) {
      return programCardMcp.consider(params || {});
    },

    considerProgramCardMcpWrite(params      = {}) {
      return programCardMcp.considerWrite(params || {});
    },

    considerProgramCardHostCommand(params      = {}) {
      return programCardMcp.considerHostCommand(params || {});
    },

    considerProgramCardSetup(params      = {}) {
      return programCardSetupRequests.consider(params || {});
    },

    programCardHostCommandsOn() {
      return programCardMcp.hostCommandsOn() === true;
    },

    checkProgramCardMcpWrites(params      = {}) {
      return programCardMcp.checkWriteGrants(params || {});
    },

    programCardMcpTools() {
      if (programCardMcp.armed() !== true || !hasConnectedClientCapability(PROGRAM_CARD_MCP_CAPABILITY)) return "";
      return programCardMcp.taughtTools();
    },

    sendLocationRequest(params) {
      sendLocationRequest(params);
    },

    broadcastProgramCardSaveRequest(params     ) {
      if (!server || typeof server.broadcast !== "function") {
        throw new Error("ocuclaw relay not started");
      }
      server.broadcast(handler.formatProgramCardSaveRequest(params || {}));
    },

    onLocationResponse(handler) {
      return locationResponseChannel.on(handler);
    },

    sendProgramCardRequest(params     ) {
      sendProgramCardRequest(params);
    },

    programCardPictureFileScope(sessionKey     ) {
      return liveUiPictureHost.fileScope(sessionKey);
    },
    sendProgramCardLookResult(params     ) {
      return sendProgramCardLookResult(params);
    },
    clearProgramCardLookResults(sessionKey         ) {
      clearProgramCardLookResults(sessionKey);
    },

    onProgramCardResponse(handler     ) {
      return programCardResponseChannel.on(handler);
    },

    onProgramCardPlayScreen(handler     ) {
      return programCardPlayScreenChannel.on(handler);
    },

    onProgramCardFrameChanged(handler     ) {
      return programCardFrameChangedChannel.on(handler);
    },

    onProgramCardContext(handler     ) {
      return programCardContextChannel.on(handler);
    },

    isLocationAccessEnabled() {
      return hasLocationAccessEnabledReadinessClient();
    },

    hasConnectedAppClient() {
      return server ? server.getConnectedAppCount() > 0 : false;
    },

    getAppViewedSessionKeys() {
      if (!server || typeof (server       ).getAppClientSessionKeys !== "function") return null;
      if (!(server.getConnectedAppCount() > 0)) return null;
      const keys = new Set();
      for (const key of (server       ).getAppClientSessionKeys()) {
        if (typeof key === "string" && key.trim()) keys.add(key.trim());
      }
      if (keys.size === 0) return null;
      const current = sessionService.peekSessionKey();
      if (typeof current === "string" && current.trim()) keys.add(current.trim());
      return [...keys];
    },

    getConnectedAppActiveSessionKey() {
      try {
        const snapshot =
          server && typeof server.getReadinessSnapshot === "function"
            ? server.getReadinessSnapshot()
            : null;
        const clients = snapshot && Array.isArray(snapshot.clients) ? snapshot.clients : [];
        let best      = null;
        for (const entry of clients) {
          const readiness = entry && entry.readinessSnapshot;
          const sessionKey =
            readiness && typeof readiness.activeSessionKey === "string"
              ? readiness.activeSessionKey.trim()
              : "";
          if (!sessionKey) continue;
          const observedAtMs = Number.isFinite(readiness.emittedAtMs)
            ? readiness.emittedAtMs
            : Number.isFinite(entry.connectedAtMs)
              ? entry.connectedAtMs
              : 0;
          if (!best || observedAtMs >= best.observedAtMs) {
            best = { sessionKey, observedAtMs };
          }
        }
        return best ? best.sessionKey : null;
      } catch {
        return null;
      }
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

    isAgentBootstrapPending() {
      try {
        return !!upstreamRuntime && typeof upstreamRuntime.getAgentBootstrapPending === "function"
          && upstreamRuntime.getAgentBootstrapPending() === true;
      } catch {
        return false;
      }
    },

    getHostModelInput(provider     , modelId     ) {
      try {
        return upstreamRuntime && typeof upstreamRuntime.getHostModelInput === "function"
          ? upstreamRuntime.getHostModelInput(provider, modelId) : null;
      } catch {
        return null;
      }
    },

    hasCardStudioClient(sessionKey     ) {
      return sessionHasCardStudio(sessionKey);
    },

    programCardKitLevel() {
      return programCardKitLevel();
    },

    hasConnectedAppClientCapability(capability     ) {
      return connectedAppClientHas(capability);
    },

    programCardClientAwayMs() {
      return programCardClientAwayMs();
    },

    onAppClientDisconnect(handler) {
      return appClientDisconnectChannel.on(handler);
    },

    onAppClientSessionLeft(handler     ) {
      return appClientSessionLeftChannel.on(handler);
    },

    onAppPresenceChanged(handler     ) {
      return appPresenceChangedChannel.on(handler);
    },

    observeReplyDelivery(params     ) {
      return replyDelivery.observe(params || {});
    },
    getReplyDeliveryStatus(candidateKey     ) {
      return replyDelivery.status(candidateKey);
    },
    onReplyDeliverySettled(handler     ) {
      return replyDelivery.onSettled(handler);
    },
    onPairingCompleted(handler     ) {
      return pairingCompletedChannel.on(handler);
    },

    getAppPresenceProjection() {

      if (!server || typeof server.getAppPresenceProjection !== "function") return null;
      try {
        return server.getAppPresenceProjection();
      } catch {
        return null;
      }
    },

    onLogicalSessionReset(handler     ) {
      return logicalSessionResetChannel.on(handler);
    },
  };
  return relayApi;
}

const createRelayCore = createRelay;

module.exports = { LIVEUI_TASK_DISCOVERY_CHANNEL_ONE, sanitizeGlassesMarker, glassesUiRenderPayload, parseHermesFeatureTokens, resolveEvenAiRouterOptionsForBackend, resolveLiveUiSessionContext, createRelayCore, createRelay };
