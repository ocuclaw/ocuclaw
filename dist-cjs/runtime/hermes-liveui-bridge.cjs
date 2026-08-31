const { createGlassesUiToolHandler, DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS, GET_GLASSES_UI_STATE_TOOL_DESCRIPTION, GLASSES_UI_TOOL_DESCRIPTION, getGlassesUiStateParametersSchema, glassesUiParametersSchema } = require("../tools/glasses-ui-tool.cjs");

const { readAgentRunId } = require("../tools/glasses-ui-wake.cjs");
const { normalizeGlassesSessionKey } = require("../tools/glasses-ui-surfaces.cjs");

const { isLiveuiSwitchedOff, liveuiDisabledError, liveuiDisabledResult } = require("../tools/glasses-ui-prefs.cjs");
const { writeCompanionSnapshot } = require("../tools/glasses-ui-companion-snapshot.cjs");
const { createLiveuiGlassesLibraryController, dispatchLiveuiTemplateOperation, LIVEUI_TEMPLATE_TOOL_DESCRIPTION, LIVEUI_TEMPLATE_TOOL_NAME, liveuiTemplateToolParametersSchema, runLiveuiTemplateRenderLifecycle } = require("../tools/glasses-ui-template-library.cjs");
const { dispatchLiveuiTaskOperation, LIVEUI_TASK_TOOL_DESCRIPTION, LIVEUI_TASK_TOOL_NAME, liveuiTaskToolParametersSchema } = require("../tools/glasses-ui-task-library.cjs");
const { composeChannelTwoFragment } = require("../domain/prompt-channel-fragments.cjs");
const { formatLiveuiTaskIndex, projectLiveuiTaskIndexRows } = require("../tools/glasses-ui-task-index.cjs");
const { DEFAULT_STAGE_GRACE_MS } = require("../tools/glasses-ui-limits.cjs");
const { DEFAULT_HERMES_NAMESPACE, HERMES_FOREIGN_KEY_MARKER, HERMES_SESSION_KEY_PREFIX, OCUCLAW_CHAT_TYPE_SEGMENT, OCUCLAW_PLATFORM_SEGMENT, isHermesSessionKey, mintedHermesSessionKey, parseHermesPublicKey, stripAgentNamespace } = require("./hermes-session-keys.cjs");

const LIVEUI_TOOL_NAME = "render_glasses_ui";
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
});

const LIVEUI_STATE_TOOL_NAME = "get_glasses_ui_state";

const DEFAULT_LIVEUI_CONFIG = Object.freeze({
  enabled: true,

  tickBackend: "anthropic-api",
  tickModel: "",
  tickApiBaseUrl: "",
  allowAgentModelOverride: false,
  tickMaxOutputTokens: 200,
  httpEnabled: false,
  httpAllowHosts: [],
  llmEnabled: false,
  maxConcurrentSurfacesPerHost: 4,
  stageGraceMs: DEFAULT_STAGE_GRACE_MS,

  includeLastRenderInOutcome: false,
});

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
  const usable = fragments.filter((f) => f && typeof f.text === "string" && f.text.trim());
  const usableTaskIndex = typeof taskIndex === "string" ? taskIndex : "";
  if (usable.length === 0 && !usableTaskIndex) return null;
  return [
    "<ocuclaw_liveui_context_v1>",
    JSON.stringify({
      source: "ocuclaw-plugin",
      provenance: "plugin-generated",
      target: "user_message_ephemeral",
      fragments: usable.map((f) => ({ kind: f.kind, text: f.text })),
      ...(usableTaskIndex ? { task_index: usableTaskIndex } : {}),
    }),
    "</ocuclaw_liveui_context_v1>",
  ].join("\n");
}

function buildHermesToolDescriptor(name, description, parameters, methods) {
  return {
    name,
    toolset: LIVEUI_TOOLSET,
    description,
    schema: { name, description, parameters },
    methods,
  };
}

function buildHermesLiveUiToolDescriptor() {
  return buildHermesToolDescriptor(
    LIVEUI_TOOL_NAME,
    GLASSES_UI_TOOL_DESCRIPTION,
    glassesUiParametersSchema,
    {
      render: LINK_LIVEUI_METHODS.render,
      abort: LINK_LIVEUI_METHODS.abort,
      prompt: LINK_LIVEUI_METHODS.prompt,
      promptAck: LINK_LIVEUI_METHODS.promptAck,
    },
  );
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

function buildHermesLiveUiTemplateToolDescriptor() {
  return buildHermesToolDescriptor(
    LIVEUI_TEMPLATE_TOOL_NAME,
    LIVEUI_TEMPLATE_TOOL_DESCRIPTION,
    liveuiTemplateToolParametersSchema,
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

function buildHermesLiveUiHelloPayload() {
  return {
    tools: [
      buildHermesLiveUiToolDescriptor(),
      buildHermesLiveUiStateToolDescriptor(),
      buildHermesLiveUiTemplateToolDescriptor(),
      buildHermesLiveUiTaskToolDescriptor(),
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
    return { ...DEFAULT_LIVEUI_CONFIG, ...cfg };
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
    },
    emitLifecycle,
    getGlassesUiLiveConfig: liveConfig,
    resolveLlmApiKey: resolveLlmApiKeySync,
    executeLlmRecipe,
    timeoutMs: renderTimeoutMs,
    paintFloorMs: Number.isFinite(opts.paintFloorMs) ? opts.paintFloorMs : undefined,
    isSessionConnected: () => boolFromRelay(relay, "hasConnectedAppClient", false),
    isUnderBackpressure: () => boolFromRelay(relay, "isGlassesSendBufferOverHighWater", false),
    dispatchWake:
      typeof relay.dispatchGlassesWake === "function"
        ? (params) => relay.dispatchGlassesWake(params)
        : null,
    isAgentTurnBusy: (sessionKey) => {
      try {
        return typeof relay.isAgentTurnBusy === "function"
          ? !!relay.isAgentTurnBusy(sessionKey)
          : false;
      } catch {
        return false;
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
      });
    },
    templateLibraryDir:
      typeof injectedTemplateLibraryDir === "string" ? injectedTemplateLibraryDir : undefined,
    libraryDir: typeof injectedLibraryDir === "string" ? injectedLibraryDir : undefined,
    host: "hermes",
    now: typeof injectedNow === "function" ? injectedNow : undefined,
    describeToolApprovalBehaviour,
  });

  if (typeof relay.onAppClientDisconnect === "function") {
    relay.onAppClientDisconnect(({ sessionKey } = {}) => {
      if (sessionKey) {
        handler.drainSession(normalizeHermesLiveUiSessionKey(sessionKey), { result: "glasses_disconnected" });
      } else {
        handler.drainAll({ result: "glasses_disconnected" });
      }
    });
  }

  if (typeof relay.onLogicalSessionReset === "function") {
    relay.onLogicalSessionReset(({ sessionKey, reason } = {}) => {
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
    emitLifecycle("agent_end_settle", "debug", {
      sessionKey: normalized,
      stackDepth,
      settledPending,
      settlement: settledPending > 0 ? "aborted" : null,
      storeId: handler.storeId,

      ...readAgentRunId(relay, normalized, ctx, event),
    });
    handler.parkMarkerOnAgentEnd(normalized);
    resetDepth(normalized);
  }

  if (opts.hostHooks && typeof opts.hostHooks.on === "function") {
    opts.hostHooks.on("agent_end", handleAgentEnd);
  }

  async function withActiveCall(params, run) {
    const sessionKey = normalizeSessionKeyFromParams(params);
    const callId = normalizeCallId(params);
    const controller = new AbortController();
    activeCalls.set(callId, { controller, sessionKey });
    try {
      return await run({ sessionKey, signal: controller.signal });
    } finally {
      activeCalls.delete(callId);
    }
  }

  function toolResultEnvelope(result) {
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
    return withActiveCall(params, async ({ sessionKey, signal }) => {
      try {
        const outcome = await handler.runDynamicUi({
          sessionKey,
          depth: validateOnly ? 0 : nextDepth(sessionKey),
          spec,
          signal,
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

  function prompt(params) {
    const sessionKey = normalizeSessionKeyFromParams(params);
    const fragments = [];
    let voicemailAckToken = null;
    const channelTwo = composeChannelTwoFragment({
      startEnabled: displayStates(relay, "getDisplayStartStates", sessionKey),
      currentEnabled: displayStates(relay, "getDisplayCurrentStates", sessionKey),
      glassesConnected: boolFromRelay(relay, "hasConnectedAppClient", true),
    });
    if (channelTwo) fragments.push({ kind: "channel_two", text: channelTwo });
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
    };
  }

  function uiState(params) {
    if (liveuiSwitchedOff()) return toolResultEnvelope(liveuiDisabledResult());
    const sessionKey = normalizeSessionKeyFromParams(params);
    const channels = handler.snapshotUiState(sessionKey);
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

  async function templates(params) {
    if (liveuiSwitchedOff()) return toolResultEnvelope(liveuiDisabledResult());
    const args = normalizeToolArgs(params);
    const result = await dispatchLiveuiTemplateOperation(handler, args, async (template, values) => {
      return withActiveCall(params, ({ sessionKey, signal }) =>
        runLiveuiTemplateRenderLifecycle({
          template,
          values,
          sessionKey,
          signal,
          depthBySession,
          nextDepth,
          renderStoredTemplate: (renderInput) =>
            handler.renderStoredTemplate(renderInput),
        }),
      );
    });
    return toolResultEnvelope(result);
  }

  async function tasks(params) {
    if (liveuiSwitchedOff()) return toolResultEnvelope(liveuiDisabledResult());
    const args = normalizeToolArgs(params);
    const agentId = params && typeof params.agentId === "string" ? params.agentId : undefined;
    const sessionKey = normalizeSessionKeyFromParams(params);
    const result = await dispatchLiveuiTaskOperation({
      createTaskDraft: (input) => handler.createTaskDraft(input, { agentId }),
      updateTaskDraft: (input) => handler.updateTaskDraft(input, { agentId }),
      readTask: (taskId) => handler.readTask(taskId),
      listTasks: () => handler.listTasks(),
      findTasks: (query) => handler.findTasks(query),
      saveUiAsHelper: (input) => handler.saveUiAsHelper(input, { sessionKey, agentId }),
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
    },
    render,
    abort,
    prompt,
    promptAck,
    uiState,
    templates,
    tasks,
    resolveLlmApiKey,
    executeLlmRecipe,
    _debugState() {
      return {
        activeCalls: activeCalls.size,
        depthEntries: depthBySession.size,
      };
    },
  };
}

module.exports = { DEFAULT_LIVEUI_CONFIG, LIVEUI_TOOL_NAME, LIVEUI_TOOLSET, LINK_LIVEUI_METHODS, normalizeHermesLiveUiSessionKey, buildHermesLiveUiToolDescriptor, buildHermesLiveUiStateToolDescriptor, buildHermesLiveUiTemplateToolDescriptor, buildHermesLiveUiTaskToolDescriptor, LIVEUI_STATE_TOOL_NAME, buildHermesLiveUiHelloPayload, createHermesLiveUiBridge };
