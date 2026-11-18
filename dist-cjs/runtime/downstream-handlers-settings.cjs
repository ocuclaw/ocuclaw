const { normalizeEvenAiRoutingMode, normalizeEvenAiDefaultAgent } = require("../even-ai/even-ai-settings-store.cjs");
const { normalizeOcuClawDefaultModel, normalizeOcuClawDefaultThinking, normalizeOcuClawAgentProgressNotes, normalizeOcuClawDefaultAgent, normalizeOcuClawAutoFallbackAgent, normalizeOcuClawAutoGraceMs, OCUCLAW_AUTO_GRACE_MAX_MS, normalizeOcuClawEvenAiPeer, normalizeOcuClawPathwayBinding, OCUCLAW_WAITING_SURFACE_RE, OCUCLAW_WAITING_SURFACES_MAX } = require("./ocuclaw-settings-store.cjs");
const { normalizeAndValidateCustomSystemPrompt } = require("../domain/custom-system-prompt-limit.cjs");
const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { parseOptionalTrimmedString } = require("./downstream-parse-optional.cjs");
const { formatError } = require("./downstream-codec-core.cjs");
const { formatEvenAiSettings, formatEvenAiSettingsAck, formatOcuClawSettings, formatSavedPrompts, formatSavedPromptsAck, formatOcuClawSettingsAck } = require("./downstream-codec-settings.cjs");

function createSettingsHandlers({
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
}     ) {
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
      payload.systemPrompt = normalizeAndValidateCustomSystemPrompt(msg.systemPrompt);
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

  function parseWaitingOnYouPatch(value     ) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("waitingOnYou must be an object");
    }
    const patch      = {};
    for (const key of ["show", "answer"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (typeof value[key] !== "boolean") {
        throw new Error(`waitingOnYou.${key} must be a boolean`);
      }
      patch[key] = value[key];
    }
    if (Object.prototype.hasOwnProperty.call(value, "surfaces")) {
      const surfaces = value.surfaces;
      if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces)) {
        throw new Error("waitingOnYou.surfaces must be an object");
      }
      const names = Object.keys(surfaces);
      if (names.length > OCUCLAW_WAITING_SURFACES_MAX) {
        throw new Error(
          `waitingOnYou.surfaces allows at most ${OCUCLAW_WAITING_SURFACES_MAX} entries`,
        );
      }
      const surfacesPatch      = {};
      for (const name of names) {
        if (!OCUCLAW_WAITING_SURFACE_RE.test(name)) {
          throw new Error("waitingOnYou.surfaces names must match [a-z0-9_-]{1,32}");
        }
        if (typeof surfaces[name] !== "boolean") {
          throw new Error(`waitingOnYou.surfaces.${name} must be a boolean`);
        }
        surfacesPatch[name] = surfaces[name];
      }
      patch.surfaces = surfacesPatch;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("waitingOnYou requires show, answer or surfaces");
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
      payload.systemPrompt = normalizeAndValidateCustomSystemPrompt(msg.systemPrompt);
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

    if (Object.prototype.hasOwnProperty.call(msg, "autoAgent")) {
      if (typeof msg.autoAgent !== "boolean") {
        throw new Error("autoAgent must be a boolean");
      }
      Reflect.set(payload, "autoAgent", msg.autoAgent);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "autoFallbackAgent")) {
      if (typeof msg.autoFallbackAgent !== "string") {
        throw new Error("autoFallbackAgent must be a string");
      }
      Reflect.set(payload, "autoFallbackAgent", normalizeOcuClawAutoFallbackAgent(msg.autoFallbackAgent));
    }

    if (Object.prototype.hasOwnProperty.call(msg, "autoGraceMs")) {
      const grace = msg.autoGraceMs;
      if (!Number.isInteger(grace) || grace < 0 || grace > OCUCLAW_AUTO_GRACE_MAX_MS) {
        throw new Error(`autoGraceMs must be an integer from 0 to ${OCUCLAW_AUTO_GRACE_MAX_MS}`);
      }
      Reflect.set(payload, "autoGraceMs", normalizeOcuClawAutoGraceMs(grace));
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

    if (Object.prototype.hasOwnProperty.call(msg, "explainApprovals")) {
      if (typeof msg.explainApprovals !== "boolean") {
        throw new Error("explainApprovals must be a boolean");
      }
      Reflect.set(payload, "explainApprovals", msg.explainApprovals);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "cardBuildFastMode")) {
      if (typeof msg.cardBuildFastMode !== "boolean") {
        throw new Error("cardBuildFastMode must be a boolean");
      }
      Reflect.set(payload, "cardBuildFastMode", msg.cardBuildFastMode);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "activityLabs")) {
      const labs = Reflect.get(msg, "activityLabs");
      if (!Array.isArray(labs) || labs.length > 16 || labs.some((lab) => typeof lab !== "string")) {
        throw new Error("activityLabs must be an array of at most 16 strings");
      }
      Reflect.set(payload, "activityLabs", labs);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "liveReasoning")) {
      if (Reflect.get(msg, "liveReasoning") !== true) {
        throw new Error("liveReasoning accepts only true");
      }
      Reflect.set(payload, "liveReasoning", true);
    }

    if (Object.prototype.hasOwnProperty.call(msg, "waitingOnYou")) {
      Reflect.set(payload, "waitingOnYou", parseWaitingOnYouPatch(msg.waitingOnYou));
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

  function handleGetSavedPrompts(clientId     ) {
    if (!onGetSavedPrompts) {
      return {
        unicast: formatError("saved prompts are not available", {
          code: "saved_prompts_unavailable",
          op: APP_PROTOCOL.savedPromptsGet,
        }),
      };
    }

    return Promise.resolve()
      .then(() => onGetSavedPrompts())
      .then(
        (payload) => ({ unicast: formatSavedPrompts(payload || {}) }),
        (err) => {
          const message = err && err.message ? err.message : "getSavedPrompts failed";
          logger.error(`[downstream] getSavedPrompts failed: ${message}`);
          return {
            unicast: formatError(message, {
              code: "saved_prompts_read_failed",
              op: APP_PROTOCOL.savedPromptsGet,
            }),
          };
        },
      );
  }

  function handleWriteSavedPrompts(clientId     , msg     ) {
    const requestId = msg && typeof msg.requestId === "string" ? msg.requestId : "";
    if (!onWriteSavedPrompts) {

      return {
        unicast: formatError("saved prompts are not available", {
          code: "saved_prompts_unavailable",
          op: APP_PROTOCOL.savedPromptsWrite,
          requestId,
        }),
      };
    }
    const request = {
      op: msg && typeof msg.op === "string" ? msg.op : "",
      prompt: msg && typeof msg.prompt === "object" ? msg.prompt : null,
      id: msg && typeof msg.id === "string" ? msg.id : "",
      ids: msg && Array.isArray(msg.ids) ? msg.ids : null,
      updatedAtMs: Number.isFinite(msg && msg.updatedAtMs) ? msg.updatedAtMs : undefined,
    };
    return Promise.resolve()
      .then(() => onWriteSavedPrompts(request))
      .then(
      (result) => {
        const payload = result || { status: "rejected", reason: "rejected" };
        const action      = {
          unicast: formatSavedPromptsAck({ ...payload, requestId }),
        };
        if (payload.status === "accepted") {
          action.broadcast = [formatSavedPrompts(payload)];
        }
        return action;
      },
      (err) => {
        const message = err && err.message ? err.message : "writeSavedPrompts failed";
        logger.error(`[downstream] writeSavedPrompts failed: ${message}`);

        return {
          unicast: formatError(message, {
            code: "saved_prompts_write_failed",
            op: APP_PROTOCOL.savedPromptsWrite,
            requestId,
          }),
        };
      },
    );
  }

  return {
    handleGetEvenAiSettings,
    handleGetEvenAiSessions,
    handleSetEvenAiSettings,
    handleGetOcuClawSettings,
    handleSetOcuClawSettings,
    handleGetSavedPrompts,
    handleWriteSavedPrompts,
  };
}

module.exports = { createSettingsHandlers };
