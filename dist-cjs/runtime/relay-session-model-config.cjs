const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { ocuClawDefaultAgentAsAgentId } = require("./ocuclaw-settings-store.cjs");

function createRelaySessionModelConfig(ctx                                ) {
  const { logger, ocuClawSettingsStore } = ctx;

  let currentSessionModelConfigSnapshot

           = null;

  function sessionAgentHasOwnModel(sessionKey     ) {
    if (
      !sessionKey ||
      !ctx.sessionService ||
      typeof ctx.sessionService.getSessionAgentId !== "function" ||
      !ctx.upstreamRuntime ||
      typeof ctx.upstreamRuntime.agentHasOwnModel !== "function"
    ) {
      return false;
    }
    return ctx.upstreamRuntime.agentHasOwnModel(
      ctx.sessionService.getSessionAgentId(sessionKey, sessionKey),
    );
  }

  function buildOcuClawInitialSessionConfigPatch(settings     , sessionKey = "") {

    if (getActiveBackendKind() === "hermes") return null;
    const patch      = {};
    if (
      settings &&
      typeof settings.defaultModel === "string" &&
      settings.defaultModel.trim() &&
      !sessionAgentHasOwnModel(sessionKey)
    ) {
      patch.modelRef = settings.defaultModel.trim();
    }
    if (
      settings &&
      typeof settings.defaultThinking === "string" &&
      settings.defaultThinking.trim()
    ) {
      patch.thinkingLevel = settings.defaultThinking.trim().toLowerCase();
    }
    if (settings && settings.defaultFastMode === true) {
      patch.fastMode = true;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  function seedSessionAgentDefault(sessionKey     , defaultAgent     ) {
    if (
      getActiveBackendKind() === "hermes" ||
      !sessionKey ||
      !ctx.sessionService ||
      typeof ctx.sessionService.setSessionAgentId !== "function" ||
      typeof ctx.sessionService.getSessionAgentId !== "function"
    ) {
      return;
    }

    const normalized =
      typeof defaultAgent === "string" ? ocuClawDefaultAgentAsAgentId(defaultAgent) : "";
    if (!normalized) {
      return;
    }
    if (
      typeof ctx.sessionService.hasExplicitSessionAgent === "function" &&
      ctx.sessionService.hasExplicitSessionAgent(sessionKey)
    ) {

      return;
    }
    ctx.sessionService.setSessionAgentId(sessionKey, normalized);
  }

  async function maybeSeedOcuClawSessionConfig(sessionKey     ) {
    if (
      !sessionKey ||
      !ctx.sessionService ||
      typeof ctx.sessionService.hasPendingInitialConfig !== "function" ||
      !ctx.sessionService.hasPendingInitialConfig(sessionKey)
    ) {
      return;
    }

    const settings = ocuClawSettingsStore.getSnapshot();
    seedSessionAgentDefault(sessionKey, settings.defaultAgent);
    const patch = buildOcuClawInitialSessionConfigPatch(settings, sessionKey);
    if (!patch) {
      ctx.sessionService.clearPendingInitialConfig(sessionKey);
      return;
    }

    const result = await ctx.sessionService.setSessionModelConfig(
      sessionKey,
      patch,
      { initial: true },
    );
    if (!result || result.status !== "accepted") {
      throw new Error(
        (result && result.error) || "failed to seed OcuClaw new-session defaults",
      );
    }
    if (
      result.config &&
      sessionKey === ctx.sessionService.ensureSessionKey() &&
      ctx.server
    ) {
      ctx.server.broadcast(ctx.handler.formatSessionModelConfig(result.config));
    }
  }

  async function applyNewChatReasoningDefault(sessionKey                           ) {
    if (
      getActiveBackendKind() !== "openclaw" ||
      !sessionKey ||
      !ctx.sessionService ||
      typeof ctx.sessionService.setSessionModelConfig !== "function"
    ) {
      return null;
    }
    const current =
      typeof ctx.sessionService.peekSessionReasoningLevel === "function"
        ? ctx.sessionService.peekSessionReasoningLevel(sessionKey)
        : null;
    if (current === "on" || current === "on.full") return null;
    try {
      const result = await ctx.sessionService.setSessionModelConfig(
        sessionKey,
        { reasoningLevel: "on" },
        { keepPendingInitial: true },
      );
      if (result && result.status === "accepted" && result.config) {
        return result.config;
      }
      logger.warn(
        `[relay] new-chat reasoning default not applied: ${
          (result && result.error) || "not accepted"
        }`,
      );
    } catch (err     ) {
      logger.warn(
        `[relay] new-chat reasoning default failed: ${
          err && err.message ? err.message : String(err)
        }`,
      );
    }
    return null;
  }

  async function seedOcuClawSessionConfigForNewSession(sessionKey     ) {
    if (!sessionKey || !ctx.sessionService) {
      return null;
    }

    const settings = ocuClawSettingsStore.getSnapshot();
    seedSessionAgentDefault(sessionKey, settings.defaultAgent);
    const patch = buildOcuClawInitialSessionConfigPatch(settings, sessionKey);
    if (!patch) {
      return applyNewChatReasoningDefault(sessionKey);
    }

    const seededConfig =
      typeof ctx.sessionService.primeSessionModelConfig === "function"
        ? ctx.sessionService.primeSessionModelConfig(sessionKey, patch)
        : null;

    if (getActiveBackendKind() === "hermes") {
      return seededConfig;
    }
    const result = await ctx.sessionService.setSessionModelConfig(
      sessionKey,
      patch,
      { initial: true },
    );
    const seeded =
      result && result.status === "accepted" && result.config
        ? result.config
        : seededConfig;
    return (await applyNewChatReasoningDefault(sessionKey)) || seeded;
  }

  function isActiveSessionModelConfig(config     ) {
    return !!(
      config &&
      typeof config.sessionKey === "string" &&
      (
        typeof ctx.sessionService.isCurrentSession === "function"
          ? ctx.sessionService.isCurrentSession(config.sessionKey)
          : config.sessionKey === ctx.sessionService.ensureSessionKey()
      )
    );
  }

  function applyCurrentSessionModelConfigSnapshot(config     ) {
    if (!isActiveSessionModelConfig(config)) {
      return false;
    }
    const previous = currentSessionModelConfigSnapshot;
    currentSessionModelConfigSnapshot = config;

    if (ctx.server && previous && (
      previous.modelProvider !== config.modelProvider ||
      previous.model !== config.model ||
      previous.reasoningLevel !== config.reasoningLevel ||
      previous.thinkingLevel !== config.thinkingLevel ||
      previous.effectiveThinkingLevel !== config.effectiveThinkingLevel ||
      previous.thinkingDefault !== config.thinkingDefault ||
      JSON.stringify(previous.thinkingLevels) !== JSON.stringify(config.thinkingLevels) ||
      previous.fastModeSupported !== config.fastModeSupported
    )) {
      ctx.server.broadcast(ctx.handler.formatSessionModelConfig(config));
    }
    if (
      ctx.upstreamRuntime &&
      typeof ctx.upstreamRuntime.handleCurrentSessionModelConfigChanged === "function"
    ) {
      ctx.upstreamRuntime.handleCurrentSessionModelConfigChanged().catch((err     ) => {
        logger.warn(`[relay] Provider usage rebroadcast failed after session config update: ${err.message}`);
      });
    }
    return true;
  }

  function clearCurrentSessionModelConfigSnapshot(trigger     ) {
    currentSessionModelConfigSnapshot = null;
    if (
      ctx.upstreamRuntime &&
      typeof ctx.upstreamRuntime.handleCurrentSessionModelConfigCleared === "function"
    ) {
      ctx.upstreamRuntime.handleCurrentSessionModelConfigCleared().catch((err     ) => {
        logger.warn(`[relay] Provider usage clear broadcast failed after ${trigger}: ${err.message}`);
      });
    }
  }

  function adoptActiveSessionModelConfig(config     ) {
    if (!isActiveSessionModelConfig(config)) {
      return false;
    }
    currentSessionModelConfigSnapshot = config;
    if (ctx.server) {
      ctx.server.broadcast(ctx.handler.formatSessionModelConfig(config));
    }
    return true;
  }

  return {
    getSnapshot: () => currentSessionModelConfigSnapshot,
    applyCurrentSessionModelConfigSnapshot,
    clearCurrentSessionModelConfigSnapshot,
    adoptActiveSessionModelConfig,
    maybeSeedOcuClawSessionConfig,
    applyNewChatReasoningDefault,
    seedOcuClawSessionConfigForNewSession,
  };
}

module.exports = { createRelaySessionModelConfig };
