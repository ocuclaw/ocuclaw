const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { activeNewSessionGreetingPrompt } = require("./session-service.cjs");

function createRelayCatalogHandlers(ctx                             ) {
  const {
    inputPredictionService,
    sessionService,
    noteJevActivity,
    conversationState,
    emitDebug,
    resetActivityStatusAdapter,
    simulation,
    broadcastPages,
    stablePromptSnapshots,
    clearLogicalSessionState,
    openclawGatewayKeyFor,
    gatewayBridge,
  } = ctx;

  return {
    onGetModelsCatalog() {
      return ctx.upstreamRuntime
        ? ctx.upstreamRuntime.getModelsCatalogSnapshot()
        : Promise.resolve({ models: [], fetchedAtMs: Date.now(), stale: true });
    },

    onInputPrediction(clientId     , op     , payload     ) {
      switch (op) {
        case "capabilities":
          return inputPredictionService.capabilities(clientId);
        case "request":

          noteJevActivity("typing");
          return inputPredictionService.request(clientId, payload);
        case "open":
          noteJevActivity("typing");
          return inputPredictionService.open(clientId, payload);
        case "cancel":
          return inputPredictionService.cancel(clientId, payload).then((ack     ) => ({
            requestId: payload && typeof payload.requestId === "string" ? payload.requestId : "",
            ...ack,
          }));
        case "test":
          return inputPredictionService.test(clientId, payload);
        case "modelAllow":
          return inputPredictionService.modelAllow(clientId, payload);
        default:
          return Promise.reject(new Error(`unknown input prediction op: ${op}`));
      }
    },

    onGetSkillsCatalog() {
      return ctx.upstreamRuntime
        ? ctx.upstreamRuntime.getSkillsCatalogSnapshot()
        : Promise.resolve({ skills: [], fetchedAtMs: Date.now(), stale: true });
    },

    onGetCommandCatalog() {
      return ctx.upstreamRuntime
        ? ctx.upstreamRuntime.getCommandCatalogSnapshot()
        : Promise.resolve({
            commands: [],
            fetchedAtMs: Date.now(),
            stale: true,
            unsupported: true,
            backendKind: "none",
            executes: "intercepted-only",
          });
    },

    onGetProviderUsageSnapshot() {
      return ctx.upstreamRuntime
        ? ctx.upstreamRuntime.getProviderUsageSnapshot()
        : Promise.resolve({
            sessionKey: null,
            provider: null,
            displayName: null,
            limitingWindowKey: null,
            windows: [],
            fetchedAtMs: Date.now(),
            stale: true,
          });
    },

    onSlashCommand(command     ) {
      emitDebug(
        "relay.protocol",
        "slash_command",
        "debug",
        { sessionKey: sessionService.ensureSessionKey() },

        () => {
          const text = typeof command === "string" ? command.trim() : "";
          const name = text.split(/\s+/, 1)[0] || "";
          return { command: name, withText: text.length > name.length };
        },
      );
      if (command === "/reset" && getActiveBackendKind() !== "hermes") {
        sessionService.invalidateSessionsCache();
        resetActivityStatusAdapter();
        simulation.clearSyntheticWorkForSession(sessionService.ensureSessionKey());
        conversationState.clear(sessionService.ensureSessionKey(), true);
        if (ctx.upstreamRuntime && typeof ctx.upstreamRuntime.clearTyping === "function") {
          ctx.upstreamRuntime.clearTyping("slash_reset");
        }
        conversationState.setAgentName(
          (ctx.upstreamRuntime ? ctx.upstreamRuntime.getAgentName() : null) || "Agent",
        );
        broadcastPages();
      }

      if (
        getActiveBackendKind() !== "hermes" &&
        (command === "/new" || command === "/reset")
      ) {
        const resetKey = sessionService.ensureSessionKey();
        stablePromptSnapshots.evict(resetKey);

        clearLogicalSessionState(
          resetKey,
          command === "/new" ? "slash_new" : "slash_reset",
        );
      }
      if (ctx.upstreamRuntime && ctx.upstreamRuntime.isConnected()) {

        const outboundCommand =
          command === "/reset" && getActiveBackendKind() !== "hermes"
            ? `/reset ${activeNewSessionGreetingPrompt()}`
            : command;
        const resetSessionKey = sessionService.ensureSessionKey();
        const resetGatewaySession = openclawGatewayKeyFor(resetSessionKey);

        return gatewayBridge.sendMessage(
          outboundCommand,
          resetSessionKey,
          null,
          resetGatewaySession.agentId
            ? { agentId: resetGatewaySession.agentId }
            : undefined,
        );
      }
      return Promise.resolve();
    },
  };
}

module.exports = { createRelayCatalogHandlers };
