const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { forgetStarMapNode, readStarMapSnapshot } = require("../domain/star-map.cjs");
const { resolveInputPredictionIdentity } = require("./input-prediction-identity.cjs");

function createRelayStarMapHandlers(ctx                             ) {
  const {
    gatewayBridge,
    logger,
    sessionService,
  } = ctx;

  function resolveStarMapAgentId(clientId     , backend        ) {
    let clientSessionKey      = null;
    try {
      clientSessionKey =
        ctx.server && typeof (ctx.server       ).getClientSessionKey === "function"
          ? (ctx.server       ).getClientSessionKey(clientId)
          : null;
      if (!clientSessionKey && typeof (sessionService       ).peekSessionKey === "function") {
        clientSessionKey = (sessionService       ).peekSessionKey();
      }
    } catch {
      clientSessionKey = null;
    }
    const identity      = resolveInputPredictionIdentity({
      backendKind: backend,
      clientSessionKey,
      getSessionAgentId: (shortKey     , fullKey     ) => sessionService.getSessionAgentId(shortKey, fullKey),
      getSessionProfileId:
        typeof (sessionService       ).getSessionProfileId === "function"
          ? (shortKey     , fullKey     ) => (sessionService       ).getSessionProfileId(shortKey, fullKey)
          : undefined,
      extractShortKey:
        typeof (sessionService       ).extractShortKey === "function"
          ? (key     ) => (sessionService       ).extractShortKey(key)
          : undefined,
    });
    if (backend === "hermes") return identity.profileId || "";
    return identity.agentId || "main";
  }

  return {

    onGetStarMap(clientId     ) {
      const backend = getActiveBackendKind() === "hermes" ? "hermes" : "openclaw";
      return readStarMapSnapshot({
        request: (method     , params     ) => gatewayBridge.request(method, params),
        agentId: resolveStarMapAgentId(clientId, backend),
        backend,
      }).then((snapshot     ) => {
        if (snapshot.status !== "ok") {
          logger.warn(`[relay] star map ${snapshot.status}: ${snapshot.errorCode}`);
        }
        return snapshot;
      });
    },

    onForgetStar(clientId     , request     ) {
      const backend = getActiveBackendKind() === "hermes" ? "hermes" : "openclaw";
      return forgetStarMapNode({
        request: (method     , params     ) => gatewayBridge.request(method, params),
        agentId: resolveStarMapAgentId(clientId, backend),
        requestId: request && request.requestId,
        id: request && request.id,
        kind: request && request.kind,
        text: request && request.text,
      }).then((reply     ) => {
        if (reply.status !== "ok") {
          logger.warn(`[relay] star map forget ${reply.status}: ${reply.errorCode}`);
        }
        return reply;
      });
    },
  };
}

module.exports = { createRelayStarMapHandlers };
