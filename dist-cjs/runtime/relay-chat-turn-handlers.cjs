function createRelayChatTurnHandlers(ctx                              ) {
  const {
    gatewayBridge,
    simulation,
    sessionService,
    activeLedgerSnapshot,
    dispatchOcuClawUserSend,
    pendingRemoteSendRunBindings,
    dispatchOcuClawSessionAbort,
    dispatchOcuClawSessionSteer,
  } = ctx;

  return {

    onSend(id     , text     , sessionKey     , attachment     , clientDisplaySignals     , firstUsePhoneOrigin     , firstUseClientId     , origin      = null, taskBuild      = null, cardChange      = null, cardCheck      = null) {

      const scripted = attachment ? null : simulation.maybeAbsorbScriptedAppSend(id, text, sessionKey);
      if (scripted) return scripted;
      return dispatchOcuClawUserSend({
        id,
        text,
        sessionKey,
        attachment,
        clientDisplaySignals: clientDisplaySignals || null,
        source: "phone_ui",
        firstUsePhoneOrigin: firstUsePhoneOrigin === true && !pendingRemoteSendRunBindings.has(id),

        sentByAppClient: firstUsePhoneOrigin === true,
        firstUseClientId,
        origin,

        taskBuild,

        cardChange,

        cardCheck,
      });
    },

    onWaitingAnswer(_clientId     , request     ) {
      if (ctx.openClawWaiting) return ctx.openClawWaiting.answer(request);
      if (!gatewayBridge || gatewayBridge.kind !== "hermes") {
        const error      = new Error("Waiting answers are not available on this backend.");
        error.code = "capability_unavailable";
        throw error;
      }
      return gatewayBridge.request("waiting.answer", request);
    },

    onLedgerCursor(payload      = {}) {
      const sessionId = payload.sessionId;
      const activeSessionKey = sessionService.peekSessionKey();
      if (sessionId !== activeSessionKey) return null;
      const snapshot = activeLedgerSnapshot();

      if (
        payload.quiet === true &&
        snapshot !== null &&
        payload.entriesRevision === snapshot.entriesRevision &&
        payload.lastSeq === snapshot.lastSeq
      ) {
        return null;
      }
      return snapshot;
    },

    onResyncRequest(payload      = {}) {
      const sessionId = payload.sessionId;
      const activeSessionKey = sessionService.peekSessionKey();
      if (sessionId !== activeSessionKey) return null;
      return activeLedgerSnapshot();
    },

    onAbortSession({ requestId, sessionKey }     ) {
      return dispatchOcuClawSessionAbort({ requestId, sessionKey });
    },

    onSteerSession({ requestId, sessionKey, message, attachment, wearerOrigin, origin }     ) {
      return dispatchOcuClawSessionSteer({
        requestId,
        sessionKey,
        message,
        attachment,
        wearerOrigin: wearerOrigin === true,
        origin,
      });
    },

    onApprovalResolve(id     , decision     , meta      = { reason: undefined }) {

      if (simulation.isSyntheticApproval(id)) {
        simulation.resolveSyntheticApproval(id, decision, "manual");
        return Promise.resolve({ ok: true, synthetic: true });
      }
      return gatewayBridge.resolveApproval(id, decision, {
        reason: meta && meta.reason,
      });
    },
  };
}

module.exports = { createRelayChatTurnHandlers };
