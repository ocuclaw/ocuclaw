function createRelaySettingsHandlers(ctx                              ) {
  const {
    evenAiSettingsStore,
    savedPromptsStore,
    getOcuClawSettingsSnapshot,
    evenAiRequestObservation,
    applyOcuClawSettingsPatch,
  } = ctx;

  return {
    onGetEvenAiSettings() {
      return evenAiSettingsStore.getSnapshot();
    },

    onGetOcuClawSettings() {
      return getOcuClawSettingsSnapshot();
    },

    onGetSavedPrompts() {
      return savedPromptsStore.list();
    },

    onWriteSavedPrompts(request      = {}) {
      return savedPromptsStore.write(request || {});
    },

    async onSetEvenAiSettings(patch     ) {
      const result = await evenAiSettingsStore.setSettings(patch || {});
      evenAiRequestObservation.refresh();
      if (result && result.status === "accepted" && result.settings && ctx.server) {
        ctx.server.broadcast(ctx.handler.formatEvenAiSettings(result.settings));
      }
      return result;
    },

    async onSetOcuClawSettings(patch     ) {
      return applyOcuClawSettingsPatch(patch || {});
    },
  };
}

module.exports = { createRelaySettingsHandlers };
