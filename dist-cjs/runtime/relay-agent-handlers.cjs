const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");

function createRelayAgentHandlers(ctx                           ) {
  const {
    gatewayBridge,
    logger,
    openClawAgentSettings,
    openClawAgentDefaults,
    openClawAgentCreator,
    openClawAgentEmojiUpdater,
    emitDebug,
    hermesEnrollment,
  } = ctx;

  return {
    onCreateOpenClawAgent(input     ) {
      return openClawAgentCreator.createAgent(input);
    },

    async onSetAgentEmoji({ agentId, emoji }     ) {
      if (getActiveBackendKind() === "openclaw") {
        return openClawAgentEmojiUpdater.setEmoji({ agentId, emoji });
      }
      if (getActiveBackendKind() !== "hermes") {
        const error      = new Error("Agent emoji changes are not available on this backend.");
        error.code = "capability_unavailable";
        throw error;
      }
      const result      = await gatewayBridge.request("profiles.emoji.set", {
        profileId: agentId,
        emoji,
      });
      try {
        await ctx.upstreamRuntime?.refreshAgentsCatalog?.(true);
      } catch (error     ) {
        logger.warn(`[relay] Hermes profile emoji updated but catalog refresh failed: ${error?.message || error}`);
      }
      return { ...result, backend: "hermes", agentId };
    },

    async onRouteAgent({ text, requestId, fallbackAgentRef }     ) {

      if (getActiveBackendKind() !== "hermes") {
        const error      = new Error("Auto is not available on this backend.");
        error.code = "capability_unavailable";
        throw error;
      }
      const result      = await gatewayBridge.request("agents.route", { text, requestId, fallbackAgentRef });

      emitDebug("relay.protocol", "agents_route", "info", {}, () => ({
        agentRef: result?.agentRef, reason: result?.reason, latencyMs: result?.latencyMs,
      }));
      return result;
    },

    async onAgentDescription({ op, agentId, agentIds, description }     ) {

      if (getActiveBackendKind() !== "hermes") {
        const error      = new Error("Agent descriptions are not available on this backend.");
        error.code = "capability_unavailable";
        throw error;
      }
      try {
        return op === "auto"
          ? await gatewayBridge.request("profiles.description.auto", { profileIds: agentIds })
          : await gatewayBridge.request("profiles.description.set", { profileId: agentId, description });
      } finally {

        try {
          await ctx.upstreamRuntime?.refreshAgentsCatalog?.(true);
        } catch (error     ) {
          logger.warn(`[relay] Hermes profile description request ended but catalog refresh failed: ${error?.message || error}`);
        }
      }
    },

    onGetAgentSettings({ agentId }     ) {
      if (getActiveBackendKind() === "openclaw") {
        return openClawAgentSettings.getSettings({ agentId });
      }
      if (getActiveBackendKind() !== "hermes") {
        const error      = new Error("Agent settings are not available on this backend.");
        error.code = "capability_unavailable";
        throw error;
      }
      return gatewayBridge.request("profiles.settings.get", { profileId: agentId });
    },

    async onSetAgentSettings({ agentId, emoji, setup, producedAtMs, expiresAtMs }     ) {
      let result     ;
      if (getActiveBackendKind() === "openclaw") {
        result = await openClawAgentSettings.setSettings({ agentId, emoji, setup });

        ctx.upstreamRuntime?.invalidateSkillsCatalog?.("agent_settings_saved");
      } else if (getActiveBackendKind() === "hermes") {
        result = await gatewayBridge.request("profiles.settings.set", { profileId: agentId, emoji, setup, producedAtMs, expiresAtMs });
        try {
          await ctx.upstreamRuntime?.refreshAgentsCatalog?.(true);
        } catch (error     ) {
          logger.warn(`[relay] Hermes profile settings updated but catalog refresh failed: ${error?.message || error}`);
        }
      } else {
        const error      = new Error("Agent settings are not available on this backend.");
        error.code = "capability_unavailable";
        throw error;
      }
      return { ...result, backend: getActiveBackendKind(), agentId };
    },

    onGetHostDefaults() {
      if (getActiveBackendKind() !== "openclaw") {
        const error      = new Error("Defaults for all chats are not available on this backend.");
        error.code = "capability_unavailable";
        throw error;
      }
      return openClawAgentDefaults.getDefaults();
    },

    onSetHostDefaults({ changes, baseHash }     ) {
      if (getActiveBackendKind() !== "openclaw") {
        const error      = new Error("Defaults for all chats are not available on this backend.");
        error.code = "capability_unavailable";
        throw error;
      }
      return openClawAgentDefaults.setDefaults({ changes, baseHash });
    },

    onGetAgentsCatalog({ forceRefresh = false }      = {}) {
      return ctx.upstreamRuntime
        ? Promise.resolve(ctx.upstreamRuntime.getAgentsCatalogSnapshot(forceRefresh)).then(
            (snapshot     ) => hermesEnrollment.stampCatalog(snapshot),
          )
        : Promise.resolve({
            agents: [],
            defaultId: null,
            mainKey: null,
            scope: null,
            fetchedAtMs: Date.now(),
            stale: true,
            unsupported: true,
          });
    },
  };
}

module.exports = { createRelayAgentHandlers };
