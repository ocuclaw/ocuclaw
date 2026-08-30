const { backendDisplayName, DEFAULT_BACKEND_KIND, isKnownBackendKind } = require("../gateway/backend-contract.cjs");

const CAPABILITY_SNAPSHOT_TYPE = "ocuclaw.capability.snapshot";
const PUSH_MESSAGE_TYPE = "ocuclaw.push.message";
const THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const REASONING_VISIBILITY_LEVELS = Object.freeze([
  "off",
  "on",
  "on.full",
]);

const MODEL_REASONING_CEILINGS = Object.freeze({
  providers: Object.freeze({
    anthropic: "max",
    lmstudio: "xhigh",
    xai: "high",
    "xai-oauth": "high",
  }),
  modelPrefixes: Object.freeze({
    copilot: Object.freeze({
      "gpt-5": "high",
      o1: "high",
      o3: "high",
      o4: "high",
    }),
    "copilot-acp": Object.freeze({
      "gpt-5": "high",
      o1: "high",
      o3: "high",
      o4: "high",
    }),
  }),
});

const PROVIDER_CEILING_LOOKUP = new Map(
  Object.entries(MODEL_REASONING_CEILINGS.providers),
);
const MODEL_PREFIX_CEILING_LOOKUP = new Map(
  Object.entries(MODEL_REASONING_CEILINGS.modelPrefixes),
);

function reasoningCeilingForModel(provider = "", model = "") {
  const normalizedProvider =
    typeof provider === "string" ? provider.trim().toLowerCase() : "";
  const normalizedModel =
    typeof model === "string" ? model.trim().toLowerCase() : "";
  const providerCeiling = PROVIDER_CEILING_LOOKUP.get(normalizedProvider);
  if (providerCeiling) return providerCeiling;
  const prefixRules = MODEL_PREFIX_CEILING_LOOKUP.get(normalizedProvider);
  if (!prefixRules || !normalizedModel) return null;
  for (const [prefix, ceiling] of Object.entries(prefixRules)) {
    const unqualifiedModel = normalizedModel.includes("/")
      ? normalizedModel.slice(normalizedModel.indexOf("/") + 1)
      : normalizedModel;
    if (unqualifiedModel.startsWith(prefix)) return ceiling;
  }
  return null;
}

const BASE_EFFECT_CAPABILITIES = Object.freeze([
  "neural_span_render",
  "glasses_ui_tool",
]);

const HERMES_BASE_EFFECT_CAPABILITIES = Object.freeze([
  ...BASE_EFFECT_CAPABILITIES,
  "tool_progress",
]);

const HERMES_FEATURE_EFFECT_CAPABILITIES = Object.freeze({
  interim_hook: "agent_progress_notes",
  stream_hooks: "reasoning_stream",

  session_read_state: "session_read_state",
});

function normalizeHermesFeatureTokens(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const tokens = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const token = entry.trim().toLowerCase();
    if (!token) continue;
    if (!Object.prototype.hasOwnProperty.call(HERMES_FEATURE_EFFECT_CAPABILITIES, token)) {
      continue;
    }
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

function hermesEffectCapabilities(hermesFeatures) {
  const capabilities = [...HERMES_BASE_EFFECT_CAPABILITIES];
  for (const token of normalizeHermesFeatureTokens(hermesFeatures)) {
    const capability = HERMES_FEATURE_EFFECT_CAPABILITIES[token];
    if (capability && !capabilities.includes(capability)) {
      capabilities.push(capability);
    }
  }
  return capabilities;
}

const OPENCLAW_PROFILE = Object.freeze({
  ownedSubsystems: ["openclaw_session", "openclaw_global", "even_ai"],
  effectCapabilities: [...BASE_EFFECT_CAPABILITIES],
});

function buildHermesProfile(hermesFeatures) {
  return Object.freeze({
    ownedSubsystems: ["openclaw_session", "openclaw_global", "even_ai"],
    effectCapabilities: hermesEffectCapabilities(hermesFeatures),
  });
}

function normalizeSource(source) {
  return isKnownBackendKind(source) ? source : DEFAULT_BACKEND_KIND;
}

function normalizeGeneratedAtMs(value, nowMs) {
  if (Number.isFinite(value)) return Math.floor(value);
  return Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
}

function normalizeAgentCatalogEntry(entry = { name: "", id: "", display: "" }, backend = "") {
  if (!entry || typeof entry !== "object") return null;
  const rawName =
    typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : "";
  if (!rawName) return null;
  const display =
    typeof entry.display === "string" && entry.display.trim()
      ? entry.display.trim()
      : typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : rawName;
  return {
    name: rawName,
    display,
    backend,
  };
}

function normalizeAgentCatalog(snapshot = { agents: [] }, backend = "") {
  const raw = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
  return raw
    .map((entry) => normalizeAgentCatalogEntry(entry, backend))
    .filter(Boolean);
}

function buildFamilies(source, options = {}) {
  const isHermes = source === "hermes";
  const evenTerminalEnabled = options.evenTerminalEnabled === true;
  return {
    sessions: {
      list: true,
      switch: true,
      create: true,
      newSessionAgentRef:
        isHermes ||
        !(
          options.agentCatalogSnapshot &&
          options.agentCatalogSnapshot.unsupported === true
        ),
      routes: {
        openclaw: { selectable: true },
        hermes: { selectable: isHermes },
        evenTerminal: { selectable: evenTerminalEnabled },
      },
      foreignSessions: {
        adopt: false,
        inject: false,
        copy: true,
      },
    },
    chat: {
      send: true,
      abort: true,
      steer: true,
    },
    activity: {
      lifecycle: true,
      reasoning: "summaries",
      subagentProgress: "lifecycle",
    },
    approvals: {
      scopes: isHermes
        ? ["allow-once", "allow-session", "deny"]
        : ["allow-once", "allow-session", "allow-always", "deny"],
    },
    models: {
      catalog: true,
      sessionOverride:
        !isHermes || Reflect.get(options, "sessionOptionsSupported") === true,
      oneTurnOverride: isHermes,
      thinkingLevels: [...THINKING_LEVELS],
      reasoningLevels: [...REASONING_VISIBILITY_LEVELS],
      reasoningCeilings: MODEL_REASONING_CEILINGS,
      fastMode: true,
    },
    skills: {
      list: true,
    },
    commands: {
      catalog: true,
    },
    agents: {
      list: true,
      identityFile: true,
    },
    settings: {
      profiles: {
        openclaw: OPENCLAW_PROFILE,
        hermes: buildHermesProfile(options.hermesFeatures),
      },
    },
    liveui: {
      render: true,
      nav: true,
    },
    evenTerminal: {
      enabled: evenTerminalEnabled,
    },
    pathways: {
      evenAiBindingEditable: source === "openclaw",
    },
    push: {
      message: true,
    },
    diagnostics: {
      protocolEvents: false,
      timingEvents: false,
    },
  };
}

function buildCapabilitySnapshot(options = {}) {
  const source = normalizeSource(options.source);
  const generatedAtMs = normalizeGeneratedAtMs(options.generatedAtMs, options.nowMs);
  const agentCatalog = normalizeAgentCatalog(options.agentCatalogSnapshot, source);
  return {
    type: CAPABILITY_SNAPSHOT_TYPE,
    source,
    displayName: backendDisplayName(source),
    generatedAtMs,
    stale: options.stale === true,
    families: buildFamilies(source, {
      ...options,
      agentCatalogSnapshot: options.agentCatalogSnapshot,
    }),
    agentCatalog,
  };
}

function buildPushMessage(options = {}) {
  const sessionRef =
    options && typeof options.sessionRef === "string" && options.sessionRef.trim()
      ? options.sessionRef.trim()
      : null;
  const sessionKey =
    options && typeof options.sessionKey === "string" && options.sessionKey.trim()
      ? options.sessionKey.trim()
      : sessionRef;
  const preview =
    options && typeof options.preview === "string" && options.preview.trim()
      ? options.preview.trim()
      : "";
  const rawOrigin =
    options && typeof options.pushOrigin === "string"
      ? options.pushOrigin.trim().toLowerCase()
      : "";
  const pushOrigin =
    rawOrigin === "cron" || rawOrigin === "background" || rawOrigin === "agent"
      ? rawOrigin
      : "agent";
  const rawUrgency =
    options && typeof options.urgency === "string"
      ? options.urgency.trim().toLowerCase()
      : "";
  const urgency =
    rawUrgency === "low" || rawUrgency === "normal" || rawUrgency === "high"
      ? rawUrgency
      : "normal";
  return {
    type: PUSH_MESSAGE_TYPE,
    preview,
    sessionRef,
    sessionKey,
    pushOrigin,
    urgency,
    generatedAtMs: normalizeGeneratedAtMs(options.generatedAtMs, options.nowMs),
  };
}

module.exports = { CAPABILITY_SNAPSHOT_TYPE, PUSH_MESSAGE_TYPE, THINKING_LEVELS, REASONING_VISIBILITY_LEVELS, MODEL_REASONING_CEILINGS, reasoningCeilingForModel, buildCapabilitySnapshot, buildPushMessage, HERMES_FEATURE_EFFECT_CAPABILITIES, hermesEffectCapabilities };
