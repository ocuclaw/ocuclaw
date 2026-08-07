const { createEvenTerminalBridge } = require("./bridge.cjs");

const DEFAULT_EVEN_TERMINAL_REFRESH_MS = 15_000;

function createEvenTerminalRuntimeWiring(opts = {}) {
  if (opts.enabled !== true) {
    return {
      relayOptions: { evenTerminalEnabled: false },
      attachBeforeStart() {},
      startDiscovery() {
        return Promise.resolve();
      },
      dispose() {},
    };
  }

  const logger = opts.logger || { info() {}, warn() {} };
  const createBridge =
    typeof opts.createBridge === "function"
      ? opts.createBridge
      : createEvenTerminalBridge;
  const bridge = createBridge({ logger, stateDir: opts.stateDir });
  const refreshMs = Number.isFinite(opts.refreshMs) && opts.refreshMs > 0
    ? Math.floor(opts.refreshMs)
    : DEFAULT_EVEN_TERMINAL_REFRESH_MS;
  const setIntervalImpl = opts.setIntervalImpl || setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl || clearInterval;

  let activeSubscriptionKey = null;
  let attachedRelay = null;
  let classifiedUnsubscribe = null;
  let refreshTimer = null;
  let discoveryStarted = false;
  let discoveryPromise = null;
  let disposed = false;

  function discoverySignature() {
    const providers = typeof bridge.getAvailableProviders === "function"
      ? bridge.getAvailableProviders()
      : [];
    const sessions = typeof bridge.getEtSessionRows === "function"
      ? bridge.getEtSessionRows()
      : [];
    return JSON.stringify({ providers, sessions });
  }

  async function refreshAndBroadcast() {
    if (disposed || typeof bridge.refresh !== "function") return;
    const before = discoverySignature();
    try {
      await bridge.refresh();
    } catch (err) {
      logger.warn(
        `[even-terminal] refresh failed: ${err && err.message ? err.message : err}`,
      );
      return;
    }
    if (disposed || discoverySignature() === before) return;
    if (
      attachedRelay &&
      typeof attachedRelay.broadcastStatus === "function"
    ) {
      attachedRelay.broadcastStatus();
    }
  }

  const relayOptions = {
    evenTerminalEnabled: true,
    etSessionProvider: () => bridge.getEtSessionRows(),
    etAvailableProviders: () => bridge.getAvailableProviders(),
    etHistoryProvider(sessionKey) {
      const match = /^et:(claude|codex):(.+)$/.exec(sessionKey || "");
      return match
        ? bridge.getHistory(match[1], match[2])
        : Promise.resolve([]);
    },
    etTranscriptSearchProvider: (query, searchOpts) =>
      bridge.searchTranscripts(query, searchOpts),
    onEtSessionActivated(sessionKey) {
      if (
        activeSubscriptionKey &&
        activeSubscriptionKey !== sessionKey
      ) {
        bridge.unsubscribe(activeSubscriptionKey);
        activeSubscriptionKey = null;
      }
      if (!sessionKey) {
        bridge.setActive(null);
        return;
      }
      activeSubscriptionKey = sessionKey;
      bridge.setActive(sessionKey);
      bridge.subscribe(sessionKey);
    },
    onEtSend: (provider, sessionId, text) =>
      bridge.sendPrompt(provider, sessionId, text),
    onEtCreateSession: (provider, text) =>
      bridge.createSession(provider, text),
    onEtAbort: (provider, sessionId) =>
      bridge.interruptSession(provider, sessionId),
  };

  function attachBeforeStart(relay) {
    if (disposed) {
      throw new Error("Even Terminal wiring has been disposed");
    }
    if (attachedRelay) {
      throw new Error("Even Terminal wiring is already attached");
    }
    attachedRelay = relay;

    if (typeof relay.setDemandResponders === "function") {
      relay.setDemandResponders({
        respondPermission: (
          provider,
          sessionId,
          decision,
        ) => bridge.respondPermission(provider, sessionId, decision),
        respondQuestion: (
          provider,
          sessionId,
          answer,
        ) => bridge.respondQuestion(provider, sessionId, answer),
      });
    }

    classifiedUnsubscribe = bridge.onClassified((event) => {
      logger.info(
        `[even-terminal] classified ${event.class} ${event.type} ${event.sessionKey}`,
      );
      if (
        event.class === "stream" &&
        typeof relay.injectEtStreamFrame === "function"
      ) {
        try {
          relay.injectEtStreamFrame(event);
        } catch (err) {
          logger.warn(`[even-terminal] inject: ${err.message}`);
        }
      }
      if (typeof relay.injectDemand === "function") {
        try {
          relay.injectDemand(event);
        } catch (err) {
          logger.warn(`[even-terminal] demand: ${err.message}`);
        }
      }
    });
  }

  function startDiscovery() {
    if (disposed || discoveryStarted) {
      return discoveryPromise || Promise.resolve();
    }
    if (!attachedRelay) {
      return Promise.reject(
        new Error("Even Terminal wiring must attach before discovery starts"),
      );
    }
    discoveryStarted = true;
    refreshTimer = setIntervalImpl(() => refreshAndBroadcast(), refreshMs);
    if (refreshTimer && typeof refreshTimer.unref === "function") {
      refreshTimer.unref();
    }
    discoveryPromise = refreshAndBroadcast();
    return discoveryPromise;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (refreshTimer) {
      clearIntervalImpl(refreshTimer);
      refreshTimer = null;
    }
    if (typeof classifiedUnsubscribe === "function") {
      classifiedUnsubscribe();
      classifiedUnsubscribe = null;
    }
    if (typeof bridge.stopAll === "function") {
      bridge.stopAll();
    }
    activeSubscriptionKey = null;
    attachedRelay = null;
  }

  return {
    relayOptions,
    attachBeforeStart,
    startDiscovery,
    dispose,
  };
}

module.exports = { DEFAULT_EVEN_TERMINAL_REFRESH_MS, createEvenTerminalRuntimeWiring };
