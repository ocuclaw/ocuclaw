const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { normalizeActivityLabs } = require("../domain/activity-labs.cjs");
const { normalizeEvenAiRoutingMode, normalizeEvenAiDefaultAgent } = require("../even-ai/even-ai-settings-store.cjs");
const { normalizeOcuClawEvenAiSection, normalizeOcuClawSystemPrompt, normalizeOcuClawDefaultModel, normalizeOcuClawDefaultThinking, normalizeOcuClawDefaultAgent, normalizeOcuClawAutoAgent, normalizeOcuClawAutoFallbackAgent, normalizeOcuClawAutoGraceMs, normalizeOcuClawAgentProgressNotes, normalizeOcuClawPathways, normalizeOcuClawWaitingOnYou, sanitizeOcuClawWaitingAvailableSurfaces } = require("./ocuclaw-settings-store.cjs");

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

function waitingOnYouLocalSurfacesField(value     ) {
  if (!Array.isArray(value)) return {};
  const names           = [];
  for (const raw of value) {
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (/^[a-z0-9_-]{1,32}$/.test(name) && !names.includes(name)) names.push(name);
    if (names.length >= 8) break;
  }
  return names.length > 0 ? { waitingOnYouLocalSurfaces: names } : {};
}

function activityLabsField(value     ) {
  const labs = normalizeActivityLabs(value);
  return labs.length > 0 ? { activityLabs: labs } : {};
}

const LIVE_REASONING_STATES = ["on", "restart", "off", "unset", "unavailable"];

function liveReasoningField(value     ) {
  return typeof value === "string" && LIVE_REASONING_STATES.includes(value)
    ? { liveReasoning: value }
    : {};
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

    autoAgent: normalizeOcuClawAutoAgent(payload && payload.autoAgent),
    autoFallbackAgent: normalizeOcuClawAutoFallbackAgent(
      payload && typeof payload.autoFallbackAgent === "string"
        ? payload.autoFallbackAgent
        : undefined,
    ),
    autoGraceMs: normalizeOcuClawAutoGraceMs(payload && payload.autoGraceMs),
    agentProgressNotes: normalizeOcuClawAgentProgressNotes(
      payload && typeof payload.agentProgressNotes === "string"
        ? payload.agentProgressNotes
        : undefined,
    ),
    conversationToolProgress: !!(
      payload && payload.conversationToolProgress === true
    ),
    explainApprovals: !(payload && payload.explainApprovals === false),
    cardBuildFastMode: !(payload && payload.cardBuildFastMode === false),

    ...activityLabsField(payload && payload.activityLabs),

    ...liveReasoningField(payload && payload.liveReasoning),
    waitingOnYou: normalizeOcuClawWaitingOnYou(payload && payload.waitingOnYou),

    waitingOnYouSupported: !!(payload && payload.waitingOnYouSupported === true),
    waitingOnYouSurfaces: sanitizeOcuClawWaitingAvailableSurfaces(
      payload && payload.waitingOnYouSurfaces,
    ),

    ...waitingOnYouLocalSurfacesField(payload && payload.waitingOnYouLocalSurfaces),
    pathways: normalizeOcuClawPathways(payload && payload.pathways),
    evenAi: formatOcuClawEvenAiSnapshot(payload && payload.evenAi),
  });
}

function formatSavedPromptRow(prompt     ) {
  const source = prompt && typeof prompt === "object" ? prompt : {};
  const rawRouting =
    source.routing && typeof source.routing === "object" ? source.routing : {};
  const routing      = { target: rawRouting.target === "new" ? "new" : "current" };
  for (const key of ["agentId", "modelId", "thinking"]) {
    if (typeof rawRouting[key] === "string" && rawRouting[key]) {
      routing[key] = rawRouting[key];
    }
  }
  return {
    id: typeof source.id === "string" ? source.id : "",
    name: typeof source.name === "string" ? source.name : "",
    body: typeof source.body === "string" ? source.body : "",
    order: Number.isFinite(source.order) ? source.order : 0,
    routing,
    updatedAtMs: Number.isFinite(source.updatedAtMs) ? source.updatedAtMs : 0,
  };
}

function savedPromptsBody(payload     ) {
  const source = payload && typeof payload === "object" ? payload : {};
  const prompts = Array.isArray(source.prompts) ? source.prompts : [];
  return {
    hostId: typeof source.hostId === "string" ? source.hostId : "",
    cap: Number.isFinite(source.cap) ? source.cap : 0,
    count: Number.isFinite(source.count) ? source.count : prompts.length,
    orderUpdatedAtMs: Number.isFinite(source.orderUpdatedAtMs) ? source.orderUpdatedAtMs : 0,
    prompts: prompts.map(formatSavedPromptRow),
  };
}

function formatSavedPrompts(payload     ) {
  return JSON.stringify({
    type: APP_PROTOCOL.savedPromptsSnapshot,
    ...savedPromptsBody(payload),
  });
}

function formatSavedPromptsAck(payload     ) {
  const source = payload && typeof payload === "object" ? payload : {};
  const out      = {
    type: APP_PROTOCOL.savedPromptsWriteAck,
    status: source.status === "accepted" ? "accepted" : "rejected",
  };

  if (typeof source.hostId === "string" && source.hostId) {
    Object.assign(out, savedPromptsBody(source));
  }
  if (out.status !== "accepted") {
    out.reason = typeof source.reason === "string" && source.reason
      ? source.reason
      : "rejected";
  }

  if (typeof source.requestId === "string" && source.requestId) {
    out.requestId = source.requestId;
  }
  return JSON.stringify(out);
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

module.exports = { formatEvenAiSettings, formatEvenAiSettingsAck, formatOcuClawSettings, formatSavedPrompts, formatSavedPromptsAck, formatOcuClawSettingsAck };
