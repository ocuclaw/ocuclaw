const { createGlassesUiToolHandler, DEFAULT_RENDER_GLASSES_UI_TIMEOUT_MS, GLASSES_UI_TOOL_DESCRIPTION, glassesUiParametersSchema, } = require("../tools/glasses-ui-tool.cjs");
const { normalizeGlassesSessionKey } = require("../tools/glasses-ui-surfaces.cjs");
const { composeChannelTwoFragment } = require("../domain/prompt-channel-fragments.cjs");
const { DEFAULT_HERMES_NAMESPACE, HERMES_FOREIGN_KEY_MARKER, HERMES_SESSION_KEY_PREFIX, OCUCLAW_CHAT_TYPE_SEGMENT, OCUCLAW_PLATFORM_SEGMENT, isHermesSessionKey, mintedHermesSessionKey, stripAgentNamespace, } = require("./hermes-session-keys.cjs");

const LIVEUI_TOOL_NAME = "render_glasses_ui";
const LIVEUI_TOOLSET = "plugin_ocuclaw";

const LINK_LIVEUI_METHODS = Object.freeze({
  render: "liveui.render",
  abort: "liveui.abort",
  prompt: "liveui.prompt",
  promptAck: "liveui.promptAck",
  llmAuth: "liveui.llmAuth",
  llmRecipe: "liveui.llmRecipe",
});

const DEFAULT_LIVEUI_CONFIG = Object.freeze({
  enabled: true,
  tickBackend: "openai-compat",
  tickModel: "",
  tickApiBaseUrl: "",
  allowAgentModelOverride: false,
  tickMaxOutputTokens: 200,
  httpEnabled: false,
  httpAllowHosts: [],
  llmEnabled: false,
  maxConcurrentSurfacesPerHost: 4,
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

function buildPromptFence(fragments) {
  const usable = fragments.filter((f) => f && typeof f.text === "string" && f.text.trim());
  if (usable.length === 0) return null;
  return [
    "<ocuclaw_liveui_context_v1>",
    JSON.stringify({
      source: "ocuclaw-plugin",
      provenance: "plugin-generated",
      target: "user_message_ephemeral",
      fragments: usable.map((f) => ({ kind: f.kind, text: f.text })),
    }),
    "</ocuclaw_liveui_context_v1>",
  ].join("\n");
}

function buildHermesLiveUiToolDescriptor() {
  return {
    name: LIVEUI_TOOL_NAME,
    toolset: LIVEUI_TOOLSET,
    description: GLASSES_UI_TOOL_DESCRIPTION,
    schema: {
      name: LIVEUI_TOOL_NAME,
      description: GLASSES_UI_TOOL_DESCRIPTION,
      parameters: glassesUiParametersSchema,
    },
    methods: {
      render: LINK_LIVEUI_METHODS.render,
      abort: LINK_LIVEUI_METHODS.abort,
      prompt: LINK_LIVEUI_METHODS.prompt,
      promptAck: LINK_LIVEUI_METHODS.promptAck,
    },
  };
}

function buildHermesLiveUiHelloPayload() {
  return {
    tools: [buildHermesLiveUiToolDescriptor()],
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
  const activeCalls = new Map();
  const depthBySession = new Map();

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

  function handleAgentEnd(_event, ctx = {}) {
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
    const settledPending = handler.settleSession(normalized, { result: "preempted" });
    emitLifecycle("agent_end_settle", "debug", {
      sessionKey: normalized,
      stackDepth,
      settledPending,
      storeId: handler.storeId,
    });
    handler.parkMarkerOnAgentEnd(normalized);
    resetDepth(normalized);
  }

  if (opts.hostHooks && typeof opts.hostHooks.on === "function") {
    opts.hostHooks.on("agent_end", handleAgentEnd);
  }

  async function render(params) {
    const sessionKey = normalizeSessionKeyFromParams(params);
    const callId = normalizeCallId(params);
    const controller = new AbortController();
    activeCalls.set(callId, { controller, sessionKey });
    try {
      const outcome = await handler.runDynamicUi({
        sessionKey,
        depth: nextDepth(sessionKey),
        spec: normalizeToolArgs(params),
        signal: controller.signal,
      });
      return {
        result: outcome,
        content: [{ type: "text", text: JSON.stringify(outcome) }],
      };
    } catch (err) {
      const prev = depthBySession.get(sessionKey) || 0;
      depthBySession.set(sessionKey, Math.max(0, prev - 1));
      throw err;
    } finally {
      activeCalls.delete(callId);
    }
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
    const context = buildPromptFence(fragments);
    return {
      context,
      fragments: fragments.map((f) => f.kind),
      fragmentsConcatenated: fragments.length >= 2,
      ephemeralOnly: true,
      voicemailAckToken,
    };
  }

  function promptAck(params) {
    const sessionKey = normalizeSessionKeyFromParams(params);
    const ackToken =
      params && typeof params.ackToken === "string" ? params.ackToken : "";
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
    return { status: "accepted", consumed };
  }

  return {
    handler,
    methods: {
      [LINK_LIVEUI_METHODS.render]: render,
      [LINK_LIVEUI_METHODS.abort]: abort,
      [LINK_LIVEUI_METHODS.prompt]: prompt,
      [LINK_LIVEUI_METHODS.promptAck]: promptAck,
    },
    render,
    abort,
    prompt,
    promptAck,
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

module.exports = { LIVEUI_TOOL_NAME, LIVEUI_TOOLSET, LINK_LIVEUI_METHODS, normalizeHermesLiveUiSessionKey, buildHermesLiveUiToolDescriptor, buildHermesLiveUiHelloPayload, createHermesLiveUiBridge };
