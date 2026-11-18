const { createGlassesUiToolHandler, DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS, GET_GLASSES_UI_STATE_TOOL_DESCRIPTION, getGlassesUiStateParametersSchema } = require("../tools/glasses-ui-tool.cjs");

const { readAgentRunId } = require("../tools/glasses-ui-wake.cjs");
const { normalizeGlassesSessionKey } = require("../tools/glasses-ui-surfaces.cjs");

const { isLiveuiSwitchedOff, liveuiDisabledError, liveuiDisabledResult } = require("../tools/glasses-ui-prefs.cjs");
const { writeCompanionSnapshot } = require("../tools/glasses-ui-companion-snapshot.cjs");
const { surfaceDecisionLineForHermes } = require("../domain/glasses-ui-surface-decision.cjs");
const { DEFAULT_REPLY_LANGUAGE, composeReplyLanguageFragment } = require("../domain/reply-language.cjs");
const { createLiveuiGlassesLibraryController, dispatchLiveuiTemplateOperation, LIVEUI_TEMPLATE_TOOL_DESCRIPTION, LIVEUI_TEMPLATE_TOOL_NAME, liveuiTemplateToolParametersSchemaFor, runLiveuiTemplateRenderLifecycle } = require("../tools/glasses-ui-template-library.cjs");
const { isLiveuiTemplateComposed } = require("../tools/glasses-ui-template-v2.cjs");
const { dispatchLiveuiTaskOperation, LIVEUI_TASK_TOOL_DESCRIPTION, LIVEUI_TASK_TOOL_NAME, liveuiTaskToolParametersSchema } = require("../tools/glasses-ui-task-library.cjs");
const { runCardCheck, withTaskRunHealth } = require("../tools/program-card-health.cjs");
const { TASK_PUSH_CAPABILITY } = require("./hermes-task-push.cjs");
const { COMPOSE_GLASSES_UI_TOOL_DESCRIPTION, COMPOSE_GLASSES_UI_TOOL_NAME, composeGlassesUiParametersSchema, composeGlassesUi } = require("../tools/glasses-ui-compose-tool.cjs");
const { composeChannelTwoFragment, composeEvenAiTurnChannelTwoFragment, VIEWER_TURN_NOTICE } = require("../domain/prompt-channel-fragments.cjs");
const { buildLiveuiContextFence } = require("../tools/glasses-ui-context-fence.cjs");
const { PROGRAM_CARD_CAPABILITY, PROGRAM_CARD_WHEN } = require("../tools/program-card-tool.cjs");
const { composeOpenCardFragment, createOpenCardStore, programCardCheckAskOf, programCardDoneSaves, programCardHealthOf } = require("../tools/program-card-context.cjs");
const { cardFixCheckInTurn } = require("../tools/program-card-fix-playbook.cjs");
const { PROGRAM_CARD_HOST_COMMANDS_ON_LINE, PROGRAM_CARD_JEV_ON_LINE, PROGRAM_CARD_LOOK_POINTER, PROGRAM_CARD_LIVE_CAPTURE_GUIDE, PROGRAM_CARD_FIRMWARE_TEXT_GUIDE, programCardMcpOnLines } = require("../tools/program-card-guide.cjs");
const { PROGRAM_CARD_MCP_CAPABILITY } = require("../tools/glasses-ui-program-card-mcp.cjs");
const { CARD_DIRECTIONS_MAX, CARD_DIRECTIONS_MIN, CARD_PLAN_LINE_TARGET, CARD_PLAN_MAX_LINES, CARD_PLAN_MIN_LINES, CARD_PLAN_PROVABLE_SHORT, CARD_PLAN_SITES_MAX } = require("../tools/program-card-plan.cjs");
const { ASK_CARD_TOOL_NAME } = require("../domain/glasses-ui-jev-card.cjs");
const { PROGRAM_CARD_LOOK_CAPABILITY, PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY, PROGRAM_CARD_FIRMWARE_TEXT_CAPABILITY } = require("../tools/program-card-look.cjs");
const { PROGRAM_CARD_ACTIONS_CAPABILITY, PROGRAM_CARD_ACTIONS_GUIDE, PROGRAM_CARD_ACTIONS_ON_LINE } = require("../tools/program-card-guide.cjs");
const { PROGRAM_CARD_MODELS_3D_CAPABILITY, PROGRAM_CARD_PICTURES_CAPABILITY, programCardPicturesGuide } = require("../tools/program-card-guide.cjs");
const { formatLiveuiTaskIndex, projectLiveuiTaskIndexRows } = require("../tools/glasses-ui-task-index.cjs");
const { DEFAULT_STAGE_GRACE_MS } = require("../tools/glasses-ui-limits.cjs");
const { DEFAULT_HERMES_NAMESPACE, HERMES_FOREIGN_KEY_MARKER, HERMES_SESSION_KEY_PREFIX, OCUCLAW_CHAT_TYPE_SEGMENT, OCUCLAW_PLATFORM_SEGMENT, isHermesSessionKey, mintedHermesSessionKey, parseHermesPublicKey, stripAgentNamespace } = require("./hermes-session-keys.cjs");

const LIVEUI_TOOLSET = "ocuclaw";

const LINK_LIVEUI_METHODS = Object.freeze({

  render: "liveui.render",
  abort: "liveui.abort",
  prompt: "liveui.prompt",
  promptAck: "liveui.promptAck",
  llmAuth: "liveui.llmAuth",
  llmRecipe: "liveui.llmRecipe",

  uiState: "liveui.uiState",
  templates: "liveui.templates",
  tasks: "liveui.tasks",

  compose: "liveui.compose",
});

const LIVEUI_STATE_TOOL_NAME = "get_glasses_ui_state";

const HERMES_SURFACE_DECISION_MAX_WAIT_MS = 1500;

const PROGRAM_CARD_ASK_ARGUMENTS_EXAMPLE = {
  reason: "one line: why a card beats a screen or a chat reply",
  title: "the card's name",
  plan: [{ line: "one thing the card does that you can test" }],

  say: ["2 to 3 action-first sentences on how you will build it"],
};

const PROGRAM_CARD_DIRECTIONS_SHAPE_FOR_HERMES =
  `When the ask does not say what the card shows ("a card for my morning"), do not guess: leave "plan" out and add "directions", ${CARD_DIRECTIONS_MIN} or ${CARD_DIRECTIONS_MAX} of {"label", "plan"}, each a different card ("label": what it shows, in a few words), one from the wearer's own data when a tool can read it; the yes names their pick in "picked".`;

const PROGRAM_CARD_SITES_SHAPE_FOR_HERMES =
  `For a card that reads live data from a website, add "sites": its hostnames ("api.open-meteo.com"), ${CARD_PLAN_SITES_MAX} at most; the yes allows them ("sitesAllowed").`;
const PROGRAM_CARD_ASK_SHAPE_FOR_HERMES =
  `Ask through tool_call, no tool_describe needed: name "${ASK_CARD_TOOL_NAME}", arguments ${JSON.stringify(PROGRAM_CARD_ASK_ARGUMENTS_EXAMPLE)}, with ${CARD_PLAN_MIN_LINES} to ${CARD_PLAN_MAX_LINES} plan lines of about ${CARD_PLAN_LINE_TARGET} characters, one the touch that makes it special. ${CARD_PLAN_PROVABLE_SHORT} Add "jev" or "mcp", one line each, only when it asks Jev or reads MCP tools. ${PROGRAM_CARD_SITES_SHAPE_FOR_HERMES} For a game, add "game": true and aim high: plan it deep. To change a saved card not open on the glasses, add "savedCard": its name or id, and plan only the change; never edit first. ${PROGRAM_CARD_DIRECTIONS_SHAPE_FOR_HERMES}`;

const PROGRAM_CARD_NOTES_RULE_FOR_HERMES =
  "In a turn that builds a card, don't load or edit skills (no skill_view or skill_manage), before the ask or after it: the card guide in the card tools is current, and your card notes come with the ask's yes. " +
  "Saving card lessons is not part of the build: Hermes's review saves them after your reply, only in the skill the yes names as card_notes_skill: short rules within 1,500 characters, no reference files, only what the card guide doesn't already say.";

const PROGRAM_CARD_HINT_FOR_HERMES =
  `Programmable cards are on (ask_glasses_card first, then write_glasses_card on a yes). ${PROGRAM_CARD_WHEN} ${PROGRAM_CARD_ASK_SHAPE_FOR_HERMES} ${PROGRAM_CARD_NOTES_RULE_FOR_HERMES}`;

const PROGRAM_CARD_JEV_HINT_FOR_HERMES = PROGRAM_CARD_JEV_ON_LINE;

const DEFAULT_LIVEUI_CONFIG = Object.freeze({
  enabled: true,

  tickBackend: "anthropic-api",
  tickModel: "",
  tickApiBaseUrl: "",
  allowAgentModelOverride: false,
  tickMaxOutputTokens: 200,
  httpEnabled: true,
  httpHostPolicy: "owner-grants",
  httpAllowHosts: [],
  llmEnabled: true,
  maxConcurrentSurfacesPerHost: 4,
  stageGraceMs: DEFAULT_STAGE_GRACE_MS,

  includeLastRenderInOutcome: false,
});

function offSwitch(value         , defaultValue         )          {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return String(value).toLowerCase() !== "false";
}

function mergeLiveConfig(raw     ) {
  const merged = {
    ...DEFAULT_LIVEUI_CONFIG,
    ...(raw && typeof raw === "object" ? raw : {}),
  };

  merged.enabled = offSwitch(merged.enabled, DEFAULT_LIVEUI_CONFIG.enabled);
  merged.httpEnabled = offSwitch(merged.httpEnabled, DEFAULT_LIVEUI_CONFIG.httpEnabled);
  merged.llmEnabled = offSwitch(merged.llmEnabled, DEFAULT_LIVEUI_CONFIG.llmEnabled);
  return merged;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function readRuntimeConfig(opts) {
  const fn = opts && typeof opts.getRuntimeConfig === "function" ? opts.getRuntimeConfig : null;
  if (!fn) return {};
  try {
    return fn() || {};
  } catch {
    return {};
  }
}

function boolFromRelay(relay, method, fallback = false) {
  try {
    return !!(relay && typeof relay[method] === "function" ? relay[method]() : fallback);
  } catch {
    return fallback;
  }
}

function displayStates(relay, method, sessionKey) {
  try {
    const value =
      relay && typeof relay[method] === "function"
        ? relay[method](sessionKey)
        : null;
    return value && typeof value === "object" ? value : { emoji: false, pace: false };
  } catch {
    return { emoji: false, pace: false };
  }
}

function neuralSessionNamesEnabled(relay     , sessionKey     ) {
  try {
    return relay && typeof relay.isNeuralSessionNamesEnabled === "function"
      ? relay.isNeuralSessionNamesEnabled(sessionKey) !== false
      : true;
  } catch {
    return true;
  }
}

function normalizeToolArgs(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  if (params.args && typeof params.args === "object" && !Array.isArray(params.args)) {
    return params.args;
  }
  if (params.spec && typeof params.spec === "object" && !Array.isArray(params.spec)) {
    return params.spec;
  }
  return params;
}

function normalizeCallId(params) {
  const raw =
    params && typeof params.callId === "string" && params.callId.trim()
      ? params.callId.trim()
      : "";
  return raw || `liveui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeHermesLiveUiSessionKey(rawKey) {
  const raw = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : "main";
  if (isHermesSessionKey(raw)) return raw;
  const stripped = stripAgentNamespace(raw);
  if (stripped) {
    const parts = stripped.remainder.split(":");
    if (
      parts.length === 3 &&
      parts[0] === OCUCLAW_PLATFORM_SEGMENT &&
      parts[1] === OCUCLAW_CHAT_TYPE_SEGMENT &&
      parts[2] &&
      parts[2] !== HERMES_FOREIGN_KEY_MARKER
    ) {
      return mintedHermesSessionKey(parts[2], stripped.namespace);
    }
    return `${HERMES_SESSION_KEY_PREFIX}${stripped.namespace}:${HERMES_FOREIGN_KEY_MARKER}:${stripped.remainder}`;
  }
  if (!raw.includes(":") && raw !== HERMES_FOREIGN_KEY_MARKER) {
    return mintedHermesSessionKey(raw, DEFAULT_HERMES_NAMESPACE);
  }
  return normalizeGlassesSessionKey(raw);
}

function normalizeSessionKeyFromParams(params) {
  const raw =
    params && typeof params.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim()
      : "main";
  return normalizeHermesLiveUiSessionKey(raw);
}

function buildPromptFence(fragments, taskIndex = "") {
  return buildLiveuiContextFence(fragments, taskIndex);
}

function buildHermesToolDescriptor(name     , description     , parameters     , methods     ) {
  return {
    name,
    toolset: LIVEUI_TOOLSET,
    description,
    schema: { name, description, parameters },
    methods,
  };
}

function buildHermesLiveUiStateToolDescriptor() {
  return buildHermesToolDescriptor(
    LIVEUI_STATE_TOOL_NAME,
    GET_GLASSES_UI_STATE_TOOL_DESCRIPTION,
    getGlassesUiStateParametersSchema,
    {
      uiState: LINK_LIVEUI_METHODS.uiState,
    },
  );
}

function buildHermesLiveUiTemplateToolDescriptor(opts      = {}) {
  return buildHermesToolDescriptor(
    LIVEUI_TEMPLATE_TOOL_NAME,
    LIVEUI_TEMPLATE_TOOL_DESCRIPTION,
    liveuiTemplateToolParametersSchemaFor(opts && opts.liveuiTemplatesSchema),
    {
      templates: LINK_LIVEUI_METHODS.templates,
    },
  );
}

function buildHermesLiveUiTaskToolDescriptor() {
  return buildHermesToolDescriptor(
    LIVEUI_TASK_TOOL_NAME,
    LIVEUI_TASK_TOOL_DESCRIPTION,
    liveuiTaskToolParametersSchema,
    {
      tasks: LINK_LIVEUI_METHODS.tasks,
    },
  );
}

function buildHermesLiveUiComposeToolDescriptor() {
  return buildHermesToolDescriptor(
    COMPOSE_GLASSES_UI_TOOL_NAME,
    COMPOSE_GLASSES_UI_TOOL_DESCRIPTION,
    composeGlassesUiParametersSchema,
    {
      compose: LINK_LIVEUI_METHODS.compose,
    },
  );
}

function buildHermesLiveUiHelloPayload(opts      = {}) {
  return {
    tools: [
      buildHermesLiveUiStateToolDescriptor(),
      buildHermesLiveUiTemplateToolDescriptor(opts),
      buildHermesLiveUiTaskToolDescriptor(),
      buildHermesLiveUiComposeToolDescriptor(),
    ],
    methods: { ...LINK_LIVEUI_METHODS },
  };
}

function createHermesLiveUiBridge(opts = {}) {
  const relay = opts.relay;
  if (!relay) {
    throw new Error("createHermesLiveUiBridge requires relay");
  }
  const link = opts.link || null;
  const logger = opts.logger || silentLogger();
  const injectedTemplateLibraryDir =
    opts && typeof opts === "object" ? Reflect.get(opts, "templateLibraryDir") : undefined;
  const injectedLibraryDir =
    opts && typeof opts === "object" ? Reflect.get(opts, "libraryDir") : undefined;
  const injectedNow =
    opts && typeof opts === "object" ? Reflect.get(opts, "now") : undefined;
  const activeCalls = new Map();
  const depthBySession = new Map();
  let taskIndexPromptFailureLogged = false;

  const replyLanguageBySession = new Map();

  const openCards = createOpenCardStore({ keyOf: normalizeHermesLiveUiSessionKey });
  const unsubscribeOpenCards =
    typeof relay.onProgramCardContext === "function"
      ? relay.onProgramCardContext((frame     ) => {
          if (frame && typeof frame.sessionKey === "string") openCards.report(frame.sessionKey, frame.card);
        }) || (() => {})
      : () => {};

  function emitLifecycle(event, severity, data) {
    try {
      if (relay && typeof relay.emitGlassesUiLifecycle === "function") {
        relay.emitGlassesUiLifecycle(event, severity, data);
      }
    } catch {

    }
  }

  function liveConfig() {
    const runtimeConfig = readRuntimeConfig(opts);
    const cfg =
      runtimeConfig && runtimeConfig.glassesUiLive && typeof runtimeConfig.glassesUiLive === "object"
        ? runtimeConfig.glassesUiLive
        : {};
    return mergeLiveConfig(cfg);
  }

  function renderTimeoutMs() {
    const runtimeConfig = readRuntimeConfig(opts);
    return Number.isFinite(runtimeConfig.renderGlassesUiTimeoutMs)
      ? runtimeConfig.renderGlassesUiTimeoutMs
      : DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS;
  }

  function describeToolApprovalBehaviour() {
    const runtimeConfig = readRuntimeConfig(opts);
    const explicit = runtimeConfig && runtimeConfig.toolApprovalBehaviour;
    if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
    const mode = runtimeConfig && runtimeConfig.approvals && runtimeConfig.approvals.mode;
    if (typeof mode === "string" && mode.trim()) {
      return `Tool approvals use this Agent's Hermes ${mode.trim()} mode.`;
    }
    return "Tool approvals follow this Agent's current settings.";
  }

  function nextDepth(sessionKey) {
    const key = normalizeHermesLiveUiSessionKey(sessionKey || "main");
    const next = (depthBySession.get(key) || 0) + 1;
    depthBySession.set(key, next);
    return next;
  }

  function resetDepth(sessionKey) {
    if (!sessionKey) {
      depthBySession.clear();
      return;
    }
    depthBySession.delete(normalizeHermesLiveUiSessionKey(sessionKey));
  }

  async function resolveLlmApiKey(modelRef) {
    return "";
  }

  function resolveLlmApiKeySync(modelRef) {
    return "";
  }

  async function executeLlmRecipe(recipe, ctx) {
    if (!link || typeof link.request !== "function") {
      return { error: "hermes llm recipe unavailable: control link not ready" };
    }
    try {
      const result = await link.request(LINK_LIVEUI_METHODS.llmRecipe, { recipe, ctx });
      if (result && typeof result === "object") return result;
      return { output: typeof result === "string" ? result : "" };
    } catch (err) {
      return {
        error: `hermes llm recipe failed: ${err && err.message ? err.message : err}`,
      };
    }
  }

  const handler = createGlassesUiToolHandler({
    relay: {
      sendGlassesUiRender: (msg) => relay.sendGlassesUiRender(msg),
      sendGlassesUiSurfaceUpdate: (msg) => relay.sendGlassesUiSurfaceUpdate(msg),
      onGlassesUiResult: (cb) => relay.onGlassesUiResult(cb),

      onLiveUiV2Outcome:
        typeof relay.onLiveUiV2Outcome === "function"
          ? (cb) => relay.onLiveUiV2Outcome(cb)
          : undefined,
      collectLiveUiV2State:
        typeof relay.collectLiveUiV2State === "function"
          ? (sessionKey) => relay.collectLiveUiV2State(sessionKey)
          : undefined,
      isLiveUiV2TapOwed:
        typeof relay.isLiveUiV2TapOwed === "function"
          ? (sessionKey, eventId) => relay.isLiveUiV2TapOwed(sessionKey, eventId)
          : undefined,

      writeLiveUiV2Data:
        typeof relay.writeLiveUiV2Data === "function"
          ? (sessionKey, surfaceId, patch) => relay.writeLiveUiV2Data(sessionKey, surfaceId, patch)
          : undefined,

      prefetchLiveUiV2Picture:
        typeof relay.prefetchLiveUiV2Picture === "function"
          ? (sessionKey     , surfaceId     , src     , componentId     ) => relay.prefetchLiveUiV2Picture(sessionKey, surfaceId, src, componentId)
          : undefined,
      isLiveUiV2SurfaceLive:
        typeof relay.isLiveUiV2SurfaceLive === "function"
          ? (sessionKey, surfaceId) => relay.isLiveUiV2SurfaceLive(sessionKey, surfaceId)
          : undefined,
      setLiveUiV2Inputs:
        typeof relay.setLiveUiV2Inputs === "function"
          ? (sessionKey, surfaceId, inputs, values) => relay.setLiveUiV2Inputs(sessionKey, surfaceId, inputs, values)
          : undefined,
      liveUiV2TopSurface:
        typeof relay.liveUiV2TopSurface === "function"
          ? (sessionKey, opts) => relay.liveUiV2TopSurface(sessionKey, opts)
          : undefined,
      openLiveUiV2Records:
        typeof relay.openLiveUiV2Records === "function"
          ? (sessionKey, input) => relay.openLiveUiV2Records(sessionKey, input)
          : undefined,
      withdrawLiveUiV2Surface:
        typeof relay.withdrawLiveUiV2Surface === "function"
          ? (sessionKey, surfaceId, reason) => relay.withdrawLiveUiV2Surface(sessionKey, surfaceId, reason)
          : undefined,

      onGlassesUiRenderReceipt:
        typeof relay.onGlassesUiRenderReceipt === "function"
          ? (cb) => relay.onGlassesUiRenderReceipt(cb)
          : undefined,

      onGlassesUiClientFailure:
        typeof relay.onGlassesUiClientFailure === "function"
          ? (cb) => relay.onGlassesUiClientFailure(cb)
          : undefined,
      hasClientCapability:
        typeof relay.hasConnectedAppClientCapability === "function"
          ? (capability) => relay.hasConnectedAppClientCapability(capability)
          : undefined,
      onGlassesPresenceChanged:
        typeof relay.onGlassesPresenceChanged === "function"
          ? (cb) => relay.onGlassesPresenceChanged(cb)
          : undefined,

      onProgramCardFeeds:
        typeof relay.onProgramCardFeeds === "function"
          ? (cb) => relay.onProgramCardFeeds(cb)
          : undefined,
      sendProgramCardData:
        typeof relay.sendProgramCardData === "function"
          ? (frame) => relay.sendProgramCardData(frame)
          : undefined,
      askLiveuiSite:
        typeof relay.askLiveuiSite === "function"
          ? (request) => relay.askLiveuiSite(request)
          : undefined,
    },
    emitLifecycle,
    getGlassesUiLiveConfig: liveConfig,
    resolveLlmApiKey: resolveLlmApiKeySync,
    executeLlmRecipe,
    timeoutMs: renderTimeoutMs,
    paintFloorMs: Number.isFinite(opts.paintFloorMs) ? opts.paintFloorMs : undefined,
    isSessionConnected: () => boolFromRelay(relay, "hasConnectedAppClient", false),

    getViewedSessionKeys: () => {
      try {
        const keys =
          typeof relay.getAppViewedSessionKeys === "function"
            ? relay.getAppViewedSessionKeys()
            : null;
        return Array.isArray(keys) ? keys.map((key     ) => normalizeHermesLiveUiSessionKey(key)) : null;
      } catch {
        return null;
      }
    },
    isUnderBackpressure: () => boolFromRelay(relay, "isGlassesSendBufferOverHighWater", false),
    dispatchWake:
      typeof relay.dispatchGlassesWake === "function"
        ? (params) => relay.dispatchGlassesWake(params)
        : null,
    isAgentTurnBusy: (sessionKey) => {
      try {
        const busy = typeof relay.isAgentTurnBusy === "function"
          ? relay.isAgentTurnBusy(sessionKey)
          : null;
        return typeof busy === "boolean" ? busy : null;
      } catch {
        return null;
      }
    },
    publishCompanionSnapshot: (machine) => {
      const parsed = parseHermesPublicKey(
        machine && typeof machine.sessionKey === "string" ? machine.sessionKey : "",
      );
      return writeCompanionSnapshot({

        stateDir: opts.stateDir,
        backend: "hermes",
        profile: parsed ? parsed.namespace : DEFAULT_HERMES_NAMESPACE,
        machine,
        ownership: typeof relay.getSessionDriverProjection === "function"
          ? relay.getSessionDriverProjection(machine?.sessionKey) : null,
      });
    },
    templateLibraryDir:
      typeof injectedTemplateLibraryDir === "string" ? injectedTemplateLibraryDir : undefined,
    libraryDir: typeof injectedLibraryDir === "string" ? injectedLibraryDir : undefined,
    host: "hermes",
    now: typeof injectedNow === "function" ? injectedNow : undefined,
    describeToolApprovalBehaviour,

    taskScheduleRequest:
      link && typeof link.request === "function"
        ? (identity     ) => link.request("gw.hermes.management", identity)
        : null,

    taskSyncChanged: () => {
      if (typeof relay.taskRowsChanged === "function") relay.taskRowsChanged();
    },

    scheduledTasksEnabled: () =>
      typeof relay.hasConnectedAppClientCapability === "function" &&
      relay.hasConnectedAppClientCapability(TASK_PUSH_CAPABILITY) === true,

    presentTaskConfirm: (request     ) => {
      if (typeof relay.presentTaskConfirm !== "function") return { presented: false, reason: "unavailable" };
      const sessionKey = request && typeof request.sessionKey === "string" && request.sessionKey
        ? request.sessionKey
        : typeof relay.getConnectedAppActiveSessionKey === "function"
          ? relay.getConnectedAppActiveSessionKey()
          : null;
      return relay.presentTaskConfirm({ ...request, sessionKey });
    },

    onTaskLookOffer: (offer     ) => {
      if (relay && typeof relay.sendTaskLookOffer === "function") relay.sendTaskLookOffer(offer);
    },
  });

  const publishConnectedAppSnapshot = () => {
    const sessionKey =
      typeof relay.getConnectedAppActiveSessionKey === "function"
        ? relay.getConnectedAppActiveSessionKey()
        : null;
    if (!sessionKey) return;
    try {
      handler.publishCompanionSnapshot(sessionKey);
    } catch (err     ) {
      logger.warn(
        `[hermes-liveui] companion snapshot refresh failed: ${err && err.message ? err.message : err}`,
      );
    }
  };

  const replayAfterGrace = (event     ) => {
    const reason = event && typeof event === "object" ? event.reason : event;
    if (reason !== "grace_resumed") return;
    const viewed =
      typeof relay.getAppViewedSessionKeys === "function" ? relay.getAppViewedSessionKeys() : null;
    if (!Array.isArray(viewed)) return;
    for (const sessionKey of viewed) {
      try {
        handler.replaySessionTop(normalizeHermesLiveUiSessionKey(sessionKey), "grace_resumed");
      } catch (err     ) {
        logger.warn(
          `[hermes-liveui] reconnect replay failed: ${err && err.message ? err.message : err}`,
        );
      }
    }
  };
  const onAppPresenceChanged = (event     ) => {
    publishConnectedAppSnapshot();
    replayAfterGrace(event);
  };
  const unsubscribeAppState =
    typeof relay.onAppPresenceChanged === "function"
      ? relay.onAppPresenceChanged(onAppPresenceChanged)
      : () => {};
  const unsubscribeAgentTurn =
    typeof relay.onAgentTurnChanged === "function"
      ? relay.onAgentTurnChanged(({ sessionKey, busy }     ) => {
          if (sessionKey) handler.refreshMarkerForAgentTurn(sessionKey);

          if (sessionKey && busy === false) handler.agentTurnEnded(sessionKey);
          publishConnectedAppSnapshot();
        })
      : () => {};
  const unsubscribeDriver = typeof relay.onSessionDriverChanged === "function"
    ? relay.onSessionDriverChanged(publishConnectedAppSnapshot) : () => {};
  publishConnectedAppSnapshot();

  const companionRefreshTimer      = setInterval(publishConnectedAppSnapshot, 15_000);
  if (companionRefreshTimer && typeof companionRefreshTimer.unref === "function") {
    companionRefreshTimer.unref();
  }

  if (typeof relay.onAppClientDisconnect === "function") {
    relay.onAppClientDisconnect(({ sessionKey } = {}) => {
      if (sessionKey) {
        handler.drainSession(normalizeHermesLiveUiSessionKey(sessionKey), { result: "glasses_disconnected" });
      } else {
        handler.drainAll({ result: "glasses_disconnected" });
      }
    });
  }

  if (typeof relay.onAppClientSessionLeft === "function") {
    relay.onAppClientSessionLeft(({ sessionKey, nextSessionKey }      = {}) => {
      if (!sessionKey) return;
      const normalizedSessionKey = normalizeHermesLiveUiSessionKey(sessionKey);
      const drained = handler.drainSession(normalizedSessionKey, {
        result: "preempted",
        reason: "session_left",
      });
      resetDepth(normalizedSessionKey);
      emitLifecycle("session_left_drain", "info", {
        sessionKey: normalizedSessionKey,
        nextSessionKey: nextSessionKey || null,
        drained,
        storeId: handler.storeId,
      });
    });
  }

  if (typeof relay.onLogicalSessionReset === "function") {
    relay.onLogicalSessionReset(({ sessionKey, reason }      = {}) => {
      if (!sessionKey) return;
      const normalizedSessionKey = normalizeHermesLiveUiSessionKey(sessionKey);
      const drained = handler.drainSession(normalizedSessionKey, {
        result: "session_reset",
        reason: reason || "logical_reset",
      });
      resetDepth(normalizedSessionKey);
      emitLifecycle("session_reset_drain", "info", {
        sessionKey: normalizedSessionKey,
        reason: reason || "logical_reset",
        drained,
        storeId: handler.storeId,
      });
    });
  }

  if (typeof relay.onGlassesUiNavEvent === "function") {
    relay.onGlassesUiNavEvent((ev) => {
      const sessionKey = handler.sessionForSurface(ev && ev.surfaceId);
      if (!sessionKey) {
        emitLifecycle("nav_event_skipped_foreign_surface", "debug", {
          evSurfaceId: ev && ev.surfaceId,
          evDepth: ev && ev.depth,
        });
        return;
      }
      handler.handleNavEvent(sessionKey, ev || {});
    });
  }

  function handleAgentEnd(event, ctx = {}) {
    const sessionKey =
      ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
        ? ctx.sessionKey.trim()
        : "";
    if (!sessionKey) {
      resetDepth("");
      return;
    }
    const normalized = normalizeHermesLiveUiSessionKey(sessionKey);
    const stackDepth = handler.surfaceStackDepth(normalized);
    const settledPending = handler.settleSession(normalized, { result: "aborted" });

    const releasedTerminalTop = handler.releaseTerminalTopOnAgentEnd(
      normalized,
      { result: "aborted", origin: "system" },
    );
    emitLifecycle("agent_end_settle", "debug", {
      sessionKey: normalized,
      stackDepth,
      settledPending,
      settlement: settledPending > 0 ? "aborted" : null,
      releasedTerminalTop,
      storeId: handler.storeId,

      ...readAgentRunId(relay, normalized, ctx, event),
    });
    if (!releasedTerminalTop) handler.parkMarkerOnAgentEnd(normalized);
    resetDepth(normalized);
  }

  if (opts.hostHooks && typeof opts.hostHooks.on === "function") {
    opts.hostHooks.on("agent_end", handleAgentEnd);
  }

  async function withActiveCall(params     , run     ) {
    const sessionKey = normalizeSessionKeyFromParams(params);
    const callId = normalizeCallId(params);
    const controller = new AbortController();
    activeCalls.set(callId, { controller, sessionKey });
    try {
      return await run({ sessionKey, signal: controller.signal, callId });
    } finally {
      activeCalls.delete(callId);
    }
  }

  function toolResultEnvelope(result     ) {
    return {
      result,
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  function liveuiSwitchedOff() {
    return isLiveuiSwitchedOff(handler);
  }

  async function render(params) {
    if (liveuiSwitchedOff()) throw liveuiDisabledError();
    const spec = normalizeToolArgs(params);

    const validateOnly = Boolean(spec && spec.validateOnly === true);
    return withActiveCall(params, async ({ sessionKey, signal }     ) => {
      try {
        const outcome = await handler.runDynamicUi({
          sessionKey,
          depth: validateOnly ? 0 : nextDepth(sessionKey),
          spec,
          signal,

          requireViewedSession: !(params && params.hostOriginated === true),

          origin: params && params.hostOriginated === true ? "task" : "agent",
        });
        return toolResultEnvelope(outcome);
      } catch (err) {
        if (!validateOnly) {
          const prev = depthBySession.get(sessionKey) || 0;
          depthBySession.set(sessionKey, Math.max(0, prev - 1));
        }
        throw err;
      }
    });
  }

  async function compose(params     ) {
    if (liveuiSwitchedOff()) throw liveuiDisabledError();
    const args = normalizeToolArgs(params);
    return withActiveCall(params, async ({ sessionKey, callId }     ) =>
      toolResultEnvelope(await composeGlassesUi(relay, sessionKey, args, { callId, handler })),
    );
  }

  function abort(params) {
    const callId =
      params && typeof params.callId === "string" && params.callId.trim()
        ? params.callId.trim()
        : "";
    const sessionKey =
      params && typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? normalizeHermesLiveUiSessionKey(params.sessionKey.trim())
        : "";
    let aborted = 0;
    for (const [id, call] of Array.from(activeCalls.entries())) {
      if (callId && id !== callId) continue;
      if (sessionKey && call.sessionKey !== sessionKey) continue;
      call.controller.abort();
      aborted += 1;
      if (callId) break;
    }
    return { status: "accepted", aborted };
  }

  async function prompt(params) {
    const sessionKey = normalizeSessionKeyFromParams(params);
    const fragments = [];
    let voicemailAckToken = null;

    const viewerTurn = !!(params && params.viewerTurn === true);
    const queuedOwnership =
      !viewerTurn && typeof relay.consumePromptTurnOwnership === "function"
        ? relay.consumePromptTurnOwnership(sessionKey)
        : null;
    const promptOwner =
      params && (params.promptOwner === "ocuclaw" || params.promptOwner === "even-ai")
        ? params.promptOwner
        : queuedOwnership && queuedOwnership.owner;
    const channelTwo = composeChannelTwoFragment({
      startEnabled: displayStates(relay, "getDisplayStartStates", sessionKey),
      currentEnabled: displayStates(relay, "getDisplayCurrentStates", sessionKey),
      glassesConnected: boolFromRelay(relay, "hasConnectedAppClient", true),
      includeNeuralGuidance: promptOwner !== "even-ai",
    });
    if (channelTwo) fragments.push({ kind: "channel_two", text: channelTwo });
    if (viewerTurn && promptOwner !== "even-ai") {
      fragments.push({ kind: "viewer_turn", text: VIEWER_TURN_NOTICE });
    }

    const ticketLanguage = queuedOwnership && queuedOwnership.replyLanguage;
    if (ticketLanguage) {
      const previous = replyLanguageBySession.get(sessionKey);
      if (!replyLanguageBySession.has(sessionKey) && replyLanguageBySession.size >= 512) {
        replyLanguageBySession.clear();
      }
      replyLanguageBySession.set(sessionKey, ticketLanguage);
      const show =
        ticketLanguage !== DEFAULT_REPLY_LANGUAGE ||
        (!!previous && previous !== ticketLanguage);
      const replyLanguage = show ? composeReplyLanguageFragment(ticketLanguage) : undefined;
      if (replyLanguage) fragments.push({ kind: "reply_language", text: replyLanguage });
    }

    if (promptOwner === "even-ai") {
      try {
        const snapshot =
          typeof relay.getEvenAiSettingsSnapshot === "function"
            ? relay.getEvenAiSettingsSnapshot()
            : null;
        const ownerPrompt =
          snapshot && typeof snapshot.systemPrompt === "string"
            ? snapshot.systemPrompt
            : "";
        const evenAi = composeEvenAiTurnChannelTwoFragment(ownerPrompt, {
          sharesOcuClawSession: !!(queuedOwnership && queuedOwnership.sharesOcuClawSession),
        });
        if (evenAi) fragments.unshift({ kind: "even_ai_owner", text: evenAi });
      } catch (err) {
        logger.warn(
          `[hermes-liveui] even ai owner prompt injection failed: ${String(err)}`,
        );
      }
    }
    try {
      const voicemail =
        typeof handler.previewVoicemailInjection === "function"
          ? handler.previewVoicemailInjection(sessionKey)
          : handler.buildVoicemailInjection(sessionKey);
      if (typeof voicemail === "string" && voicemail) {
        fragments.push({ kind: "voicemail", text: voicemail });
      } else if (voicemail && typeof voicemail === "object" && voicemail.fragment) {
        fragments.push({ kind: "voicemail", text: voicemail.fragment });
        voicemailAckToken =
          typeof voicemail.ackToken === "string" && voicemail.ackToken
            ? voicemail.ackToken
            : null;
      }
    } catch (err) {
      logger.warn(
        `[hermes-liveui] voicemail injection failed: ${err && err.message ? err.message : err}`,
      );
    }

    let feedbackAckToken = null;
    try {
      const feedback =
        typeof handler.previewFeedbackInjection === "function"
          ? handler.previewFeedbackInjection(sessionKey)
          : typeof handler.buildFeedbackInjection === "function"
            ? handler.buildFeedbackInjection(sessionKey)
            : null;
      if (typeof feedback === "string" && feedback) {
        fragments.push({ kind: "feedback", text: feedback });
      } else if (feedback && typeof feedback === "object" && feedback.fragment) {
        fragments.push({ kind: "feedback", text: feedback.fragment });
        feedbackAckToken =
          typeof feedback.ackToken === "string" && feedback.ackToken
            ? feedback.ackToken
            : null;
      }
    } catch (err) {
      logger.warn(
        `[hermes-liveui] feedback injection failed: ${err && err.message ? err.message : err}`,
      );
    }
    try {

      if (
        !viewerTurn &&
        promptOwner !== "even-ai" &&
        typeof relay.takeSurfaceDecisionForPrompt === "function"
      ) {
        const decided = await relay.takeSurfaceDecisionForPrompt(sessionKey, {
          text: params && typeof params.text === "string" ? params.text : undefined,
          maxWaitMs: HERMES_SURFACE_DECISION_MAX_WAIT_MS,
        });
        if (decided && decided.oneLine) {

          fragments.push({ kind: "surface_decision", text: surfaceDecisionLineForHermes(decided.oneLine) });
        }
      }

      if (promptOwner !== "even-ai" && typeof relay.takeLiveUiV2FenceFragments === "function") {
        const v2Fragments = relay.takeLiveUiV2FenceFragments(sessionKey);
        if (Array.isArray(v2Fragments)) fragments.push(...v2Fragments);
      }
    } catch (err) {
      logger.warn(
        `[hermes-liveui] surface decision injection failed: ${err && err.message ? err.message : err}`,
      );
    }

    if (
      promptOwner !== "even-ai" &&
      typeof relay.hasConnectedAppClientCapability === "function" &&
      relay.hasConnectedAppClientCapability(PROGRAM_CARD_CAPABILITY) === true
    ) {
      const jevOn = typeof relay.programCardJevTaught === "function" && relay.programCardJevTaught() === true;

      const mcpLines = programCardMcpOnLines(
        typeof relay.programCardMcpTools === "function" ? relay.programCardMcpTools() : "",
      );

      const hostLine = typeof relay.programCardHostCommandsOn === "function" && relay.programCardHostCommandsOn() === true &&
        relay.hasConnectedAppClientCapability(PROGRAM_CARD_MCP_CAPABILITY) === true ? PROGRAM_CARD_HOST_COMMANDS_ON_LINE : "";
      fragments.push({
        kind: "program_card",
        text: [PROGRAM_CARD_HINT_FOR_HERMES, jevOn ? PROGRAM_CARD_JEV_HINT_FOR_HERMES : "", mcpLines, hostLine,

          relay.hasConnectedAppClientCapability(PROGRAM_CARD_LOOK_CAPABILITY) === true ? PROGRAM_CARD_LOOK_POINTER : "",
          relay.hasConnectedAppClientCapability(PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY) === true ? PROGRAM_CARD_LIVE_CAPTURE_GUIDE : "",
          relay.hasConnectedAppClientCapability(PROGRAM_CARD_FIRMWARE_TEXT_CAPABILITY) === true ? PROGRAM_CARD_FIRMWARE_TEXT_GUIDE : "",

          relay.hasConnectedAppClientCapability(PROGRAM_CARD_ACTIONS_CAPABILITY) === true ? `${PROGRAM_CARD_ACTIONS_ON_LINE}${PROGRAM_CARD_ACTIONS_GUIDE}` : "",

          relay.hasConnectedAppClientCapability(PROGRAM_CARD_PICTURES_CAPABILITY) === true
            ? programCardPicturesGuide(relay.hasConnectedAppClientCapability(PROGRAM_CARD_MODELS_3D_CAPABILITY) === true) : ""]
          .filter(Boolean)
          .join(" "),
      });

      const open = openCards.get(sessionKey);

      const openCard = composeOpenCardFragment(open, Date.now(), { doneSaves: programCardDoneSaves(relay, sessionKey, open), host: "hermes", check: cardFixCheckInTurn,
        health: programCardHealthOf((card) => relay.programCardHealth?.(card.key, sessionKey), open,
          (card) => relay.programCardFeedHealth?.(card.cardId, card.key, sessionKey)) });
      if (openCard) fragments.push({ kind: "program_card_open", text: openCard });

      const changeLine = typeof relay.programCardChangeLine === "function" ? relay.programCardChangeLine(sessionKey) : "";
      if (changeLine) fragments.push({ kind: "program_card_change", text: changeLine });

      const checkAsk = programCardCheckAskOf(relay, sessionKey, open, Date.now(), { host: "hermes", check: cardFixCheckInTurn,
        turn: { viewer: viewerTurn, texts: params && typeof params.text === "string" ? [params.text] : [],
          ticket: queuedOwnership && typeof queuedOwnership.cardCheck === "string" ? queuedOwnership.cardCheck : "" } });
      if (checkAsk) fragments.push({ kind: "program_card_check_ask", text: checkAsk });
    }
    if (promptOwner !== "even-ai") {
      const draftIndex = typeof relay.programCardDraftIndex === "function" ? relay.programCardDraftIndex(sessionKey) : "";
      if (draftIndex) fragments.push({ kind: "program_card_drafts", text: draftIndex });
    }
    let taskIndex = "";
    try {
      const snapshot = glassesLibrary.listTasksForPhone();
      taskIndex = formatLiveuiTaskIndex(projectLiveuiTaskIndexRows(
        snapshot && snapshot.tasks,
        snapshot && snapshot.organization,
      ));
    } catch (err) {
      if (!taskIndexPromptFailureLogged) {
        taskIndexPromptFailureLogged = true;
        logger.warn(
          `[hermes-liveui] task index injection failed: ${String(err)}`,
        );
      }
    }
    const context = buildPromptFence(fragments, taskIndex);
    const fragmentKinds = [
      ...fragments.map((f) => f.kind),
      ...(taskIndex ? ["task_index"] : []),
    ];
    return {
      context,
      fragments: fragmentKinds,
      fragmentsConcatenated: fragmentKinds.length >= 2,
      ephemeralOnly: true,
      voicemailAckToken,
      feedbackAckToken,

      promptOwner: promptOwner || null,

      neuralSessionNamesEnabled: neuralSessionNamesEnabled(relay, sessionKey),
    };
  }

  function uiState(params     ) {
    if (liveuiSwitchedOff()) return toolResultEnvelope(liveuiDisabledResult());
    const sessionKey = normalizeSessionKeyFromParams(params);

    const channels = handler.collectUiState(sessionKey);
    handler.publishCompanionSnapshot(sessionKey);
    try {
      emitLifecycle("ui_state_snapshot", "debug", {
        sessionKey,
        ...channels.dev,

        machine: channels.machine,
      });
    } catch {

    }
    return { status: "accepted", result: channels.model };
  }

  async function templates(params     ) {
    if (liveuiSwitchedOff()) return toolResultEnvelope(liveuiDisabledResult());
    const args = normalizeToolArgs(params);

    const result = await dispatchLiveuiTemplateOperation(handler, args, async (template     , values     ) => {

      if (isLiveuiTemplateComposed(template)) {
        return withActiveCall(params, ({ sessionKey, signal }     ) =>
          handler.renderStoredTemplate({ template, values, sessionKey, signal, origin: "agent" }),
        );
      }
      return withActiveCall(params, ({ sessionKey, signal }     ) =>
        runLiveuiTemplateRenderLifecycle({
          template,
          values,
          sessionKey,
          signal,
          depthBySession,
          nextDepth,
          requireViewedSession: true,
          origin: "agent",
          renderStoredTemplate: (renderInput     ) =>
            handler.renderStoredTemplate(renderInput),
        }),
      );
    }, { v2: true });
    return toolResultEnvelope(result);
  }

  async function tasks(params     ) {
    if (liveuiSwitchedOff()) return toolResultEnvelope(liveuiDisabledResult());
    const args = normalizeToolArgs(params);
    const agentId = params && typeof params.agentId === "string" ? params.agentId : undefined;
    const sessionKey = normalizeSessionKeyFromParams(params);
    const result = await dispatchLiveuiTaskOperation({
      createTaskDraft: (input     ) => handler.createTaskDraft(input, { agentId }),
      updateTaskDraft: (input     ) => handler.updateTaskDraft(input, { agentId }),

      readTask: (taskId     ) => withTaskRunHealth(handler.readTask(taskId), {
        row: () => (typeof relay.taskRunRow === "function" ? relay.taskRunRow(taskId) : null),
        records: () => handler.listTaskRunRecords(taskId),
      }),
      listTasks: () => handler.listTasks(),

      check: (input     ) => runCardCheck(input, {
        cards: (query               ) => (typeof relay.programCardCheck === "function" ? relay.programCardCheck(sessionKey, query) : null),
        rows: () => {
          if (typeof relay.taskRunRows !== "function") throw new Error("no task rows read");
          return relay.taskRunRows();
        },
        tasks: () => handler.listTasks(),
      }, Date.now(), { host: "hermes", check: cardFixCheckInTurn }),
      findTasks: (query     ) => handler.findTasks(query),
      saveUiAsHelper: (input     ) => handler.saveUiAsHelper(input, { sessionKey, agentId }),

      feedCard: (input     ) => typeof relay.feedProgramCard === "function"
        ? relay.feedProgramCard({ sessionKey, values: input.values })
        : { status: "rejected", code: "no_feed_run" },

      listVoiceTaskSchedules: () => handler.listVoiceTaskSchedules(),
      scheduleTask: (input     ) => handler.scheduleTask(input, { agentId, sessionKey }),
      lessenTaskSchedule: (action     , input     ) => handler.lessenTaskSchedule(action, input),
    }, args);
    return toolResultEnvelope(result);
  }

  function promptAck(params) {
    const sessionKey = normalizeSessionKeyFromParams(params);
    const ackToken =
      params && typeof params.ackToken === "string" ? params.ackToken : "";
    const feedbackAckToken =
      params && typeof params.feedbackAckToken === "string" ? params.feedbackAckToken : "";
    let consumed = false;
    try {
      consumed =
        typeof handler.ackVoicemailInjection === "function"
          ? !!handler.ackVoicemailInjection(sessionKey, ackToken)
          : false;
    } catch (err) {
      logger.warn(
        `[hermes-liveui] voicemail ack failed: ${err && err.message ? err.message : err}`,
      );
    }

    let feedbackConsumed = false;
    try {
      feedbackConsumed =
        typeof handler.ackFeedbackInjection === "function"
          ? !!handler.ackFeedbackInjection(sessionKey, feedbackAckToken)
          : false;
    } catch (err) {
      logger.warn(
        `[hermes-liveui] feedback ack failed: ${err && err.message ? err.message : err}`,
      );
    }
    return { status: "accepted", consumed, feedbackConsumed };
  }

  const glassesLibrary = createLiveuiGlassesLibraryController({
    handler,
    depthBySession,
    nextDepth,
    normalizeSessionKey: normalizeHermesLiveUiSessionKey,
    taskRunController: Reflect.get(opts, "taskRunController"),
    resolveExecutorState: Reflect.get(opts, "resolveExecutorState"),
  });

  return {
    handler,
    glassesLibrary,
    methods: {
      [LINK_LIVEUI_METHODS.render]: render,
      [LINK_LIVEUI_METHODS.abort]: abort,
      [LINK_LIVEUI_METHODS.prompt]: prompt,
      [LINK_LIVEUI_METHODS.promptAck]: promptAck,
      [LINK_LIVEUI_METHODS.uiState]: uiState,
      [LINK_LIVEUI_METHODS.templates]: templates,
      [LINK_LIVEUI_METHODS.tasks]: tasks,
      [LINK_LIVEUI_METHODS.compose]: compose,
    },
    render,
    compose,
    abort,
    prompt,
    promptAck,
    uiState,
    templates,
    tasks,
    resolveLlmApiKey,
    executeLlmRecipe,
    dispose() {
      clearInterval(companionRefreshTimer);
      unsubscribeAppState();
      unsubscribeAgentTurn();
      unsubscribeDriver();
      unsubscribeOpenCards();
      openCards.clear();
    },
    _debugState() {
      return {
        activeCalls: activeCalls.size,
        depthEntries: depthBySession.size,
      };
    },
  };
}

module.exports = { LIVEUI_TOOLSET, LINK_LIVEUI_METHODS, LIVEUI_STATE_TOOL_NAME, HERMES_SURFACE_DECISION_MAX_WAIT_MS, PROGRAM_CARD_ASK_ARGUMENTS_EXAMPLE, PROGRAM_CARD_DIRECTIONS_SHAPE_FOR_HERMES, PROGRAM_CARD_SITES_SHAPE_FOR_HERMES, PROGRAM_CARD_ASK_SHAPE_FOR_HERMES, PROGRAM_CARD_NOTES_RULE_FOR_HERMES, PROGRAM_CARD_HINT_FOR_HERMES, PROGRAM_CARD_JEV_HINT_FOR_HERMES, DEFAULT_LIVEUI_CONFIG, mergeLiveConfig, normalizeHermesLiveUiSessionKey, buildHermesLiveUiStateToolDescriptor, buildHermesLiveUiTemplateToolDescriptor, buildHermesLiveUiTaskToolDescriptor, buildHermesLiveUiComposeToolDescriptor, buildHermesLiveUiHelloPayload, createHermesLiveUiBridge };
