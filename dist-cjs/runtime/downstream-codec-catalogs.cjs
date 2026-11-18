const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { buildStarMapForgottenBody, buildStarMapSnapshotBody } = require("../domain/star-map.cjs");

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
    ...(payload && payload.hermesFleet ? { hermesFleet: payload.hermesFleet } : {}),
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

    ...(Array.isArray(payload && payload.enrolled)
      ? {
          enrolled: payload.enrolled
            .filter((name     ) => typeof name === "string" && name.trim())
            .map((name     ) => name.trim()),
        }
      : {}),
  });
}

function formatAgentCreateResult(type     , requestId     , payload      = {}) {
  const itemKey = type === APP_PROTOCOL.hermesProfileCreateResult ? "profile" : "agent";
  const item = payload && payload[itemKey] && typeof payload[itemKey] === "object"
    ? payload[itemKey]
    : null;
  return JSON.stringify({
    type,
    requestId,
    status: ["created", "partial"].includes(payload?.status) ? payload.status : "error",
    ...(item ? { [itemKey]: item } : {}),
    ...(type === APP_PROTOCOL.hermesProfileCreateResult || payload?.restartRequired === true
      ? { restartRequired: payload && payload.restartRequired === true }
      : {}),
    ...(payload && typeof payload.errorCode === "string" && payload.errorCode
      ? { errorCode: payload.errorCode }
      : {}),
    ...(payload && typeof payload.errorMessage === "string" && payload.errorMessage
      ? { errorMessage: payload.errorMessage }
      : {}),

    ...(payload && (payload.retryable === true || payload.errorCode === "backend_unavailable")
      ? { retryable: true }
      : {}),
  });
}

function formatAgentEmojiSetResult(requestId     , payload      = {}) {
  return JSON.stringify({
    type: APP_PROTOCOL.agentEmojiSetResult,
    requestId,
    status: payload && payload.status === "updated" ? "updated" : "error",
    ...(payload && typeof payload.backend === "string" ? { backend: payload.backend } : {}),
    ...(payload && typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
    emoji: payload && typeof payload.emoji === "string" ? payload.emoji : null,
    ...(payload && typeof payload.errorCode === "string" && payload.errorCode
      ? { errorCode: payload.errorCode }
      : {}),
    ...(payload && typeof payload.errorMessage === "string" && payload.errorMessage
      ? { errorMessage: payload.errorMessage }
      : {}),
  });
}

const AGENT_ROUTE_REASONS = new Set(["named", "router", "fallback", "single"]);

function formatAgentsRouteResult(requestId     , payload      = {}) {
  const agentRef = payload && typeof payload.agentRef === "string" ? payload.agentRef : "";
  const reason = payload && AGENT_ROUTE_REASONS.has(payload.reason) ? payload.reason : "";
  const ok = payload && payload.status === "ok" && agentRef && reason;
  return JSON.stringify({
    type: APP_PROTOCOL.agentsRouteResult,
    requestId,
    status: ok ? "ok" : "error",
    ...(ok ? {
      agentRef,
      reason,
      latencyMs: Number.isFinite(payload.latencyMs) && payload.latencyMs >= 0 ? Math.round(payload.latencyMs) : 0,
    } : {}),
    ...(!ok && payload && typeof payload.errorCode === "string" && payload.errorCode
      ? { errorCode: payload.errorCode }
      : {}),
    ...(!ok && payload && typeof payload.errorMessage === "string" && payload.errorMessage
      ? { errorMessage: payload.errorMessage }
      : {}),
  });
}

function agentDescriptionErrorFields(payload     ) {
  return {
    ...(payload && typeof payload.errorCode === "string" && payload.errorCode
      ? { errorCode: payload.errorCode }
      : {}),
    ...(payload && typeof payload.errorMessage === "string" && payload.errorMessage
      ? { errorMessage: payload.errorMessage }
      : {}),
  };
}

function formatAgentDescriptionSetResult(requestId     , payload      = {}) {
  const ok = payload && payload.status === "updated";
  return JSON.stringify({
    type: APP_PROTOCOL.agentDescriptionSetResult,
    requestId,
    status: ok ? "updated" : "error",
    ...(payload && typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
    ...(ok ? { description: typeof payload.description === "string" ? payload.description : "" } : {}),
    ...(!ok ? agentDescriptionErrorFields(payload) : {}),
  });
}

function formatAgentDescriptionAutoResult(requestId     , payload      = {}) {
  const ok = payload && payload.status === "ok" && Array.isArray(payload.results);
  return JSON.stringify({
    type: APP_PROTOCOL.agentDescriptionAutoResult,
    requestId,
    status: ok ? "ok" : "error",
    ...(ok ? {
      results: payload.results
        .filter((row     ) => row && typeof row.agentId === "string" && row.agentId)
        .map((row     ) => ({
          agentId: row.agentId,
          ok: row.ok === true,
          ...(row.ok === true && typeof row.description === "string" ? { description: row.description } : {}),
          ...(row.ok !== true && typeof row.reason === "string" && row.reason ? { reason: row.reason } : {}),
        })),
    } : agentDescriptionErrorFields(payload)),
  });
}

function formatAgentSettingsResult(requestId     , payload      = {}) {
  const setup = payload && payload.setup && typeof payload.setup === "object"
    ? payload.setup
    : null;
  return JSON.stringify({
    type: APP_PROTOCOL.agentSettingsResult,
    requestId,
    status: ["loaded", "updated"].includes(payload?.status) ? payload.status : "error",
    ...(payload && typeof payload.backend === "string" ? { backend: payload.backend } : {}),
    ...(payload && typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
    ...(payload && typeof payload.name === "string" ? { name: payload.name } : {}),
    emoji: payload && typeof payload.emoji === "string" ? payload.emoji : null,
    ...(setup ? { setup } : {}),
    restartRequired: payload?.restartRequired === true,
    ...(payload && typeof payload.errorCode === "string" && payload.errorCode
      ? { errorCode: payload.errorCode }
      : {}),
    ...(payload && typeof payload.errorMessage === "string" && payload.errorMessage
      ? { errorMessage: payload.errorMessage }
      : {}),
  });
}

function formatHostDefaultsResult(requestId     , payload      = {}) {
  const text = (value     ) => (typeof value === "string" ? value : "");
  const list = (value     ) => (Array.isArray(value) ? value.filter((x     ) => typeof x === "string") : []);
  const source = payload && payload.defaults && typeof payload.defaults === "object" ? payload.defaults : null;
  const options = payload && payload.options && typeof payload.options === "object" ? payload.options : null;
  const ok = ["loaded", "updated"].includes(payload?.status);
  return JSON.stringify({
    type: APP_PROTOCOL.hostDefaultsResult,
    requestId,
    status: ok ? payload.status : "error",
    ...(payload && typeof payload.backend === "string" ? { backend: payload.backend } : {}),
    ...(ok && typeof payload.hash === "string" ? { hash: payload.hash } : {}),
    ...(ok && source
      ? {
        defaults: {
          model: text(source.model),
          fallbacks: list(source.fallbacks),
          thinking: text(source.thinking),
          fastMode: text(source.fastMode),
          reasoning: text(source.reasoning),
          toolDetail: text(source.toolDetail),
        },
      }
      : {}),
    ...(ok ? { supported: list(payload.supported) } : {}),
    ...(ok && options
      ? {
        options: Object.fromEntries(
          ["thinking", "fastMode", "reasoning", "toolDetail"].map((key) => [key, list(options[key])]),
        ),
      }
      : {}),
    ...(ok ? { restartFields: list(payload.restartFields) } : {}),
    restartRequired: payload?.restartRequired === true,
    ...(payload && typeof payload.errorCode === "string" && payload.errorCode
      ? { errorCode: payload.errorCode }
      : {}),
    ...(payload && typeof payload.errorMessage === "string" && payload.errorMessage
      ? { errorMessage: payload.errorMessage }
      : {}),
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

function formatStarMapSnapshot(payload     ) {
  return JSON.stringify({
    type: APP_PROTOCOL.starmapSnapshot,
    ...buildStarMapSnapshotBody(payload),
  });
}

function formatStarMapForgotten(payload     ) {
  return JSON.stringify({
    type: APP_PROTOCOL.starmapForgotten,
    ...buildStarMapForgottenBody(payload),
  });
}

module.exports = { formatModelsCatalog, formatSkillsCatalog, formatStarMapSnapshot, formatStarMapForgotten, formatCommandCatalog, formatAgentsCatalog, formatAgentCreateResult, formatAgentEmojiSetResult, formatAgentsRouteResult, formatAgentDescriptionSetResult, formatAgentDescriptionAutoResult, formatAgentSettingsResult, formatHostDefaultsResult, formatProviderUsageSnapshot };
