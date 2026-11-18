function createRelayVoiceHandlers(ctx                           ) {
  const {
    opts,
    voiceCredentials,
    relayBackendKind,
    jevConnection,
    noteJevActivity,
    warmJevOnce,
    simulation,
    emitDebug,
    sessionService,
  } = ctx;

  return {
    onGetSonioxModels() {
      return voiceCredentials.getSonioxModelsSnapshot();
    },

    onGetHermesSttCapabilities:
      relayBackendKind === "hermes" &&
      typeof opts.getHermesSttCapabilities === "function"
        ? () => opts.getHermesSttCapabilities()
        : null,

    onHermesSttTranscribe:
      relayBackendKind === "hermes" &&
      typeof opts.hermesSttTranscribe === "function"
        ? (request     ) => {

            noteJevActivity("voice_transcribe");
            return opts.hermesSttTranscribe(request);
          }
        : null,
    hermesSttUpload: relayBackendKind === "hermes" ? opts.hermesSttUpload : null,

    onRequestSonioxTemporaryKey(clientId     , request     ) {
      if (simulation.isVoiceScriptingArmed()) {

        emitDebug(
          "voice.timeline",
          "soniox_temp_key_parked",
          "info",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({
            clientId,
            voiceSessionId:
              request && typeof request.voiceSessionId === "string"
                ? request.voiceSessionId
                : null,
          }),
        );
        return new Promise(() => {});
      }

      if (jevConnection) {
        const voiceSessionId = request && typeof request.voiceSessionId === "string" ? request.voiceSessionId : "";
        try {
          if (voiceSessionId.startsWith("warm-lease-")) warmJevOnce("voice_start");
          else jevConnection.noteActivity("voice_start");
        } catch {

        }
      }
      return voiceCredentials.mintSonioxTemporaryKey(clientId, request);
    },

    onRequestCartesiaAccessToken(clientId     , request     ) {
      return voiceCredentials.mintCartesiaAccessToken(clientId, request);
    },
  };
}

module.exports = { createRelayVoiceHandlers };
