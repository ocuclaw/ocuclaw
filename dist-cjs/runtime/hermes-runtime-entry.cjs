const { createHermesControlLink, LINK_EXIT_CODES, LINK_HANDSHAKE_TIMEOUT_MS } = require("./hermes-control-link.cjs");
const { createHermesGatewayBridge, LINK_BACKEND_EVENT_METHOD, LINK_PROFILE_METHODS } = require("./hermes-gateway-bridge.cjs");
const { createHermesHostHooks, LINK_HOST_HOOK_METHOD } = require("./hermes-host-hooks.cjs");
const { buildHermesLiveUiHelloPayload, createHermesLiveUiBridge } = require("./hermes-liveui-bridge.cjs");
const { createHermesPresencePush } = require("./hermes-presence-push.cjs");
const { createHermesPairingCompletionPush } = require("./hermes-pairing-completion-push.cjs");
const { createHermesRuntimeReadiness } = require("./hermes-runtime-readiness.cjs");
const { createEvenTerminalRuntimeWiring } = require("./even-terminal/runtime-wiring.cjs");
const { DEFAULT_HERMES_NAMESPACE, hermesDefaultSessionKeyPrefix, hermesSupportedSessionKeyPrefixes, parseHermesPublicKey } = require("./hermes-session-keys.cjs");
const { createRelay } = require("./relay-core.cjs");
const { HERMES_BUNDLE_DEFAULT_WS_PORT } = require("../config/runtime-config.cjs");
const { setActiveBackendKind } = require("../gateway/backend-contract.cjs");

setActiveBackendKind("hermes");

const originalConsoleError = console.error.bind(console);
const debugStderrEnabled =
  process.env.OCUCLAW_LINK_DEBUG_STDERR === "1";
const writeStderr = originalConsoleError;
const writeVerboseStderr = debugStderrEnabled ? writeStderr : () => {};

console.log = writeVerboseStderr;
console.info = writeVerboseStderr;
console.debug = writeVerboseStderr;
console.warn = writeStderr;
console.error = writeStderr;

const logger = {
  info: writeVerboseStderr,
  warn: writeStderr,
  error: writeStderr,
  debug: writeVerboseStderr,

  traceLog: writeStderr,
};

const handshakeTimeoutMs = (() => {
  const raw = Number.parseInt(
    process.env.OCUCLAW_LINK_HANDSHAKE_TIMEOUT_MS || "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : LINK_HANDSHAKE_TIMEOUT_MS;
})();

function emitDebug(category, event, data) {
  if (process.env.OCUCLAW_LINK_DEBUG_STDERR === "1") {
    logger.debug(`[${category}] ${event} ${JSON.stringify(data)}`);
  }
}

const linkMethods = {
  "link.echo": (params) => (params === undefined ? null : params),
  [LINK_BACKEND_EVENT_METHOD]: (_params) => null,
  [LINK_HOST_HOOK_METHOD]: (_params) => null,
  "slash.confirm.present": (_params) => ({
    presented: false,
    reason: "relay_unavailable",
  }),
};

const link = createHermesControlLink({
  input: process.stdin,
  output: process.stdout,
  logger,
  emitDebug,
  methods: linkMethods,
  hello: {
    liveui: buildHermesLiveUiHelloPayload(),
  },
});

const { bridge: gatewayBridge, dispatchBackendEvent } =
  createHermesGatewayBridge({ link, logger });
const hostHooks = createHermesHostHooks({ logger });
const readiness = createHermesRuntimeReadiness({ dispatchBackendEvent, logger });
let activeEvenTerminalWiring = null;
let activeRelay = null;

function disposeActiveEvenTerminalWiring() {
  if (!activeEvenTerminalWiring) return;
  activeEvenTerminalWiring.dispose();
  activeEvenTerminalWiring = null;
}
linkMethods[LINK_BACKEND_EVENT_METHOD] = (params) => {
  const name = params && typeof params.name === "string" ? params.name : "";
  if (!name) {
    throw new Error("backend.event requires a name");
  }
  dispatchBackendEvent(name, params.payload);
  return null;
};
linkMethods[LINK_HOST_HOOK_METHOD] = (params) => {
  hostHooks.dispatchHookFrame(params);
  return null;
};
linkMethods["slash.confirm.present"] = (params) => {
  if (!activeRelay || typeof activeRelay.presentHermesSlashConfirm !== "function") {
    return { presented: false, reason: "relay_unavailable" };
  }
  return activeRelay.presentHermesSlashConfirm(params || {});
};

void hostHooks;

link.onClose(() => {
  logger.info("[hermes-link] control link closed; exiting");

  readiness.announceDisconnected("link_closed");
  activeRelay?.stopLiveuiExecutorRegistry();
  disposeActiveEvenTerminalWiring();
  process.exit(LINK_EXIT_CODES.clean);
});

process.on("SIGTERM", () => {
  logger.info("[hermes-link] SIGTERM; exiting");
  readiness.announceDisconnected("sigterm");
  activeRelay?.stopLiveuiExecutorRegistry();
  disposeActiveEvenTerminalWiring();
  process.exit(LINK_EXIT_CODES.clean);
});
process.on("SIGINT", () => {
  activeRelay?.stopLiveuiExecutorRegistry();
  disposeActiveEvenTerminalWiring();
  process.exit(LINK_EXIT_CODES.clean);
});

function bootRelay(ackPayload) {
  const config =
    ackPayload && ackPayload.config && typeof ackPayload.config === "object"
      ? ackPayload.config
      : {};
  if (typeof config.relayToken !== "string" || !config.relayToken) {
    logger.warn(
      "[hermes-runtime] no relayToken in ack config — link-only mode (relay not booted)",
    );
    return Promise.resolve(null);
  }
  const evenAiEnabled = config.evenAiEnabled === true;
  const evenAiToken =
    typeof config.evenAiToken === "string" ? config.evenAiToken.trim() : "";
  if (evenAiEnabled && !evenAiToken) {
    throw new Error(
      "OcuClaw evenAiToken is required when evenAiEnabled is true.",
    );
  }
  const port = Number.isFinite(Number(config.wsPort))
    ? Number(config.wsPort)
    : HERMES_BUNDLE_DEFAULT_WS_PORT;
  const host =
    typeof config.wsBind === "string" && config.wsBind
      ? config.wsBind
      : "127.0.0.1";
  const evenTerminalWiring = createEvenTerminalRuntimeWiring({
    enabled: config.evenTerminalEnabled === true,
    logger,
    stateDir:
      typeof config.stateDir === "string" && config.stateDir
        ? config.stateDir
        : undefined,
  });
  activeEvenTerminalWiring = evenTerminalWiring;
  let relay;
  const profileNamespace = (context = {}) => {
    const parsed = parseHermesPublicKey(
      typeof context.sessionKey === "string" ? context.sessionKey : "",
    );
    return parsed ? parsed.namespace : DEFAULT_HERMES_NAMESPACE;
  };
  const getHermesProfileOptions = (context = {}) =>
    link.request(LINK_PROFILE_METHODS.optionsGet, {
      ns: profileNamespace(context),
    });
  const setHermesProfileOptions = (patch = {}, context = {}) => {
    const options = {};
    if (Object.prototype.hasOwnProperty.call(patch, "defaultModel")) {
      const raw = String(patch.defaultModel || "").trim();
      const slash = raw.indexOf("/");
      options.model = slash > 0 ? raw.slice(slash + 1) : raw;
      if (slash > 0) options.provider = raw.slice(0, slash);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "defaultThinking")) {
      const raw = String(patch.defaultThinking || "").trim().toLowerCase();
      options.reasoning_effort = raw === "off" ? "none" : raw;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "defaultFastMode")) {
      options.fast = patch.defaultFastMode === true;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "conversationToolProgress")) {

      options.tool_progress = patch.conversationToolProgress === true ? "all" : "off";
    }
    if (patch.confirmModelSelection === true) {
      options.confirm_model_selection = true;
    }
    return link.request(LINK_PROFILE_METHODS.optionsApply, {
      ns: profileNamespace(context),
      options,
    });
  };
  try {
    relay = createRelay({
      port,
      host,
      token: typeof config.relayToken === "string" ? config.relayToken : "",

      config: {
        sonioxApiKey:
          typeof config.sonioxApiKey === "string" ? config.sonioxApiKey : "",
      },
      stateDir:
        typeof config.stateDir === "string" && config.stateDir
          ? config.stateDir
          : undefined,
      gatewayBridge,
      resolveHermesSlashConfirm: (params) =>
        link.request("slash.confirm.resolve", params || {}),

      getConnectionHealthDocument: () =>
        link.request("connectionHealth.snapshot", {}),
      hermesVersion:
        ackPayload && typeof ackPayload.hermesVersion === "string"
          ? ackPayload.hermesVersion
          : null,
      hermesSessionOptionsSupported:
        config.sessionOptionsSupported === true,
      getOcuClawProfileOptions: getHermesProfileOptions,
      setOcuClawProfileOptions: setHermesProfileOptions,
      externalDebugToolsEnabled:
        config.externalDebugToolsEnabled !== false,
      allowDebugUpload: config.allowDebugUpload === true,
      debugUploadMaxZipBytes: config.debugUploadMaxZipBytes,
      debugUploadCapturePreset: config.debugUploadCapturePreset,
      debugBundleSaveDir: config.debugBundleSaveDir,
      evenAiEnabled,
      evenAiToken,
      evenAiSystemPrompt:
        typeof config.evenAiSystemPrompt === "string"
          ? config.evenAiSystemPrompt
          : "",
      evenAiRequestTimeoutMs: config.evenAiRequestTimeoutMs,
      evenAiMaxBodyBytes: config.evenAiMaxBodyBytes,
      evenAiDedupWindowMs: config.evenAiDedupWindowMs,
      evenAiRoutingMode:
        typeof config.evenAiRoutingMode === "string"
          ? config.evenAiRoutingMode
          : "active",
      evenAiDedicatedSessionKey:
        typeof config.evenAiDedicatedSessionKey === "string"
          ? config.evenAiDedicatedSessionKey
          : "",

      defaultSessionKeyPrefix: hermesDefaultSessionKeyPrefix(DEFAULT_HERMES_NAMESPACE),
      supportedSessionKeyPrefixes: hermesSupportedSessionKeyPrefixes(),
      sessionKeyPrefixForAgentRef(agentRef = "") {

        const ref = typeof agentRef === "string" ? agentRef.trim() : "";
        return hermesDefaultSessionKeyPrefix(
          ref === "default" ? DEFAULT_HERMES_NAMESPACE : ref,
        );
      },
      ...evenTerminalWiring.relayOptions,
      logger,
    });
    activeRelay = relay;

    evenTerminalWiring.attachBeforeStart(relay);
  } catch (err) {
    evenTerminalWiring.dispose();
    if (activeEvenTerminalWiring === evenTerminalWiring) {
      activeEvenTerminalWiring = null;
    }
    throw err;
  }

  link.setDebugEmitter((category, event, data) => {
    emitDebug(category, event, data);
    relay.emitDebug(category, event, "debug", {}, () => data || {});
  });
  return Promise.resolve(relay.start())
    .then(() => {
      void evenTerminalWiring.startDiscovery();
      logger.info(`[hermes-runtime] relay listening on ws://${host}:${port}`);
      const liveui = createHermesLiveUiBridge({
        relay,
        link,
        hostHooks,
        logger,
        stateDir: config.stateDir,
        getRuntimeConfig: () => config,
        resolveExecutorState: relay.resolveLiveuiTaskExecutorState,
      });
      relay.setLiveuiGlassesLibraryController(liveui.glassesLibrary);
      Object.assign(linkMethods, liveui.methods);

      const presence = createHermesPresencePush({ relay, link, logger });
      Object.assign(linkMethods, presence.methods);
      presence.push();
      createHermesPairingCompletionPush({ relay, link, logger });
      return relay;
    })
    .catch((err) => {
      evenTerminalWiring.dispose();
      if (activeEvenTerminalWiring === evenTerminalWiring) {
        activeEvenTerminalWiring = null;
      }
      throw err;
    });
}

function isBindFailure(err) {
  if (!err) return false;
  if (err.code === "EADDRINUSE") return true;
  return /EADDRINUSE/.test(err.message || "");
}

link
  .start({ handshakeTimeoutMs })
  .then((ackPayload) => {
    const configKeys =
      ackPayload && ackPayload.config && typeof ackPayload.config === "object"
        ? Object.keys(ackPayload.config).sort().join(",")
        : "";
    logger.info(
      `[hermes-link] handshake complete (hermes=${
        (ackPayload && ackPayload.hermesVersion) || "unknown"
      } configKeys=${configKeys})`,
    );
    return bootRelay(ackPayload).then((relay) => {
      if (relay === null) return;

      readiness.announceReady(ackPayload);

      link.request("runtime.ready", {}).catch((err) => {
        logger.warn(
          `[hermes-runtime] runtime.ready notify failed: ${err && err.message ? err.message : err}`,
        );
      });
    });
  })
  .catch((err) => {
    logger.error(
      `[hermes-runtime] startup failed: ${err && err.message ? err.message : err}`,
    );
    readiness.announceFailure(err);
    if (isBindFailure(err)) {
      process.exit(LINK_EXIT_CODES.bindFailure);
    }
    process.exit(
      err && Number.isInteger(err.exitCode) ? err.exitCode : LINK_EXIT_CODES.fatal,
    );
  });

module.exports = {};
