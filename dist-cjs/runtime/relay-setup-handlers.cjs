const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { handleModelSitesRequest } = require("../setup/model-sites-protocol.cjs");

function createRelaySetupHandlers(ctx                           ) {
  const {
    opts,
    emitDebug,
    optionalSetupGeneration,
    evenAiRequestObservation,
    jevKeyCheck,
    gatewayBridge,
    modelSitesGeneration,
    modelSitesConnections,
    modelSites,
  } = ctx;

  const optionalSetupConnections = new Map();
  function disconnectModelSites(clientId        ) {
    const connectionId = modelSitesConnections.get(clientId);
    modelSitesConnections.delete(clientId);
    if (connectionId) modelSites?.releaseClient(connectionId);
  }
  let evenAiTestOwner      = null;
  const optionalSetupConnection = (clientId     , workerEpoch     ) => `${optionalSetupGeneration}-${workerEpoch}-${clientId}`;
  function disconnectOptionalSetup(clientId     ) {
    const connectionId = optionalSetupConnections.get(clientId);
    optionalSetupConnections.delete(clientId);
    if (!connectionId) return;
    if (evenAiTestOwner === connectionId) {
      evenAiTestOwner = null;
      evenAiRequestObservation.cancel();
    }
    if (getActiveBackendKind() === "hermes") {
      Promise.resolve(gatewayBridge.request("optional.setup.disconnect", { connectionId })).catch(() => {});
    } else if (typeof opts.optionalSetup?.disconnect === "function") opts.optionalSetup.disconnect(connectionId);
  }

  return {
    onOptionalSetup(clientId     , request     , workerEpoch     ) {
      const rejectArm = (code     ) => {
        if (request.operation === "evenai.test.arm") emitDebug("evenai", "even_ai_test_summary", "info", {}, () => ({
          version: 1, testId: request.requestId, stage: "arm_rejected", terminal: "failure", reasonCode: code,
          clientId, captureCoverage: "unknown", noRequestEvidence: "unknown",
        }));
        return { status: "rejected", code };
      };
      if (!Number.isInteger(workerEpoch) || workerEpoch < 1) return rejectArm("not_connected");
      const connectionId = optionalSetupConnection(clientId, workerEpoch);
      optionalSetupConnections.set(clientId, connectionId);
      const context = { connectionId };

      if (request.operation === "credential.save") { evenAiRequestObservation.cancel(); evenAiTestOwner = null; }

      if (request.operation === "evenai.test.arm") {
        if (opts.evenAiEnabled !== true || !opts.evenAiToken) return rejectArm("unavailable");
        if (!evenAiRequestObservation.arm(request.requestId)) return rejectArm("busy");
        evenAiTestOwner = connectionId;
        return { status: "ok" };
      }
      if (request.operation === "evenai.test.cancel") {
        evenAiRequestObservation.cancel();
        evenAiTestOwner = null;
        return { status: "cancelled" };
      }

      if (request.operation === "jev.check") return jevKeyCheck.check(connectionId);
      if (getActiveBackendKind() === "hermes") return gatewayBridge.request("optional.setup", { request, context });
      return typeof opts.optionalSetup?.handle === "function" ? opts.optionalSetup.handle(request, context)
        : { status: "unsupported", code: "unsupported" };
    },
    onOptionalSetupDisconnect: disconnectOptionalSetup,
    onModelSites(clientId        , request     , workerEpoch     ) {
      if (!Number.isInteger(workerEpoch) || workerEpoch < 1) return { status: "rejected", code: "not_connected" };
      const connectionId = `${modelSitesGeneration}-${workerEpoch}-${clientId}`;
      const previous = modelSitesConnections.get(clientId);
      if (previous && previous !== connectionId) modelSites?.releaseClient(previous);
      modelSitesConnections.set(clientId, connectionId);
      return handleModelSitesRequest(modelSites, request, connectionId);
    },
    onModelSitesDisconnect: disconnectModelSites,
    onSecretAnswer(_clientId        , answer     ) {
      if (!ctx.openClawQuestionRouter) return { status: "refused", reason: "unsupported" };
      return ctx.openClawQuestionRouter.handleSecretAnswer(answer);
    },
  };
}

module.exports = { createRelaySetupHandlers };
