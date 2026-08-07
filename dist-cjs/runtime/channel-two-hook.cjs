const { composeChannelTwoFragment } = require("../domain/prompt-channel-fragments.cjs");

function createChannelTwoHook(service, opts = {}) {
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};

  const everConnected = new Set();
  const renderGatePending = new Set();
  const capped = (set) => {
    if (set.size >= 512) set.clear();
    return set;
  };
  return function channelTwoBeforePromptBuild(_event, ctx) {
    const sessionKey =
      ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
        ? ctx.sessionKey
        : null;
    if (!sessionKey) return undefined;
    try {
      const glassesConnected =
        typeof service.hasConnectedAppClient === "function"
          ? service.hasConnectedAppClient()
          : true;
      const glassesWasConnected = everConnected.has(sessionKey);
      const fragment = composeChannelTwoFragment({
        startEnabled: service.getDisplayStartStates(sessionKey),
        currentEnabled: service.getDisplayCurrentStates(sessionKey),
        glassesConnected,
        glassesWasConnected,
        renderGateLifted: glassesConnected && renderGatePending.has(sessionKey),
      });
      if (glassesConnected) {
        capped(everConnected).add(sessionKey);
        renderGatePending.delete(sessionKey);
      } else if (glassesWasConnected) {
        capped(renderGatePending).add(sessionKey);
      }
      if (!fragment) return undefined;
      emitDebug("relay.session", "channel_two_fragment_injected", "debug",
        { sessionKey }, () => ({ chars: fragment.length }));
      return { appendSystemContext: fragment };
    } catch (_err) {

      return undefined;
    }
  };
}

module.exports = { createChannelTwoHook };
