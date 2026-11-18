const { createRuntimeConfig, createRuntimeConfigOverview, OPENCLAW_BUNDLE_DEFAULT_WS_PORT, resolveGlassesUiLive } = require("../config/runtime-config.cjs");
const { hasExplicitWsPort, persistRelayPortMarker, resolveRelayPortDecision } = require("../config/relay-port-default.cjs");
const { createPluginOpenclawClient } = require("../gateway/openclaw-client.cjs");
const { createBundledModelInputLookup } = require("../gateway/input-prediction-openclaw.cjs");
const { composeContainerLoopbackNotice, isContainerEnvironment, isLoopbackBindAddress } = require("./container-env.cjs");
const { createRelay: createPluginOwnedRelay } = require("./relay-core.cjs");
const { answerTaskSheetRequest } = require("./hermes-task-sheet.cjs");
const { getRegisteredGlassesUiHandler } = require("../tools/glasses-ui-tool.cjs");
const { bundledCardFixPlaybookFile } = require("../tools/program-card-fix-playbook.cjs");
const { composeCardSetupCheck, readCardSetupTaskRows, runCardCheck, withTaskRunHealth } = require("../tools/program-card-health.cjs");
const { runOutsideRetiredPluginCache } = require("./openclaw-plugin-cache-scope.cjs");
const { createCloudwaysSupervisor } = require("../setup/cloudways-supervisor.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");

function resolveCreateRelay(createRelayOverride) {
  if (typeof createRelayOverride === "function") {
    return createRelayOverride;
  }
  return createPluginOwnedRelay;
}
function resolveOpenclawClient(openclawClientOverride, runtimeConfig, logger, stateDir) {
  if (openclawClientOverride) {
    return openclawClientOverride;
  }
  return createPluginOpenclawClient({
    gatewayUrl: runtimeConfig.gatewayUrl,
    gatewayToken: runtimeConfig.gatewayToken,
    logger,
    stateDir,
  });
}

const SHARED_RELAY_SYMBOL = Symbol.for("ocuclaw.shared.relay");

function getSharedRelay() {
  return globalThis[SHARED_RELAY_SYMBOL] || null;
}

function setSharedRelay(relay) {
  globalThis[SHARED_RELAY_SYMBOL] = relay;
}

function clearSharedRelay(relay) {
  if (globalThis[SHARED_RELAY_SYMBOL] === relay) {
    globalThis[SHARED_RELAY_SYMBOL] = null;
  }
}

function readInputPredictionTimeoutMs(pluginConfig     ) {
  const raw = pluginConfig && pluginConfig.inputPredictionTimeoutMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function createOcuClawRelayService(opts = {}) {
  const baseLogger = normalizeLogger(opts.logger);
  let relay = null;

  let cloudwaysSupervisor      = null;
  let runtimeConfig = null;
  let setupConfig = null;

  let adoptedRelayToken      = null;

  let relayCredentialLoad      = {
    origin: null,
    mintOnLoad: { status: "not-attempted", code: null, detail: null },
  };
  let relayCredentialAdoptionAnnounced = false;

  let deferredStart      = null;

  let conversationAccessGrant      = { attempted: false, status: "not-attempted", code: null };

  let mintReload      = { attempted: false, status: "not-attempted", code: null };
  const optsAny0      = opts;

  const bundledModelInput = createBundledModelInputLookup({ hostRoot: optsAny0.hostCatalogRoot });
  function effectivePluginConfig() {
    if (adoptedRelayToken === null) return optsAny0.pluginConfig;
    const base = optsAny0.pluginConfig && typeof optsAny0.pluginConfig === "object"
      ? optsAny0.pluginConfig
      : {};
    return { ...base, relayToken: adoptedRelayToken };
  }
  function recordRelayCredentialLoad(origin     , mint     ) {
    relayCredentialLoad = {
      origin,
      mintOnLoad: {
        status: mint && typeof mint.status === "string" ? mint.status : "not-attempted",
        code: mint && typeof mint.code === "string" ? mint.code : null,
        detail: mint && typeof mint.detail === "string" ? mint.detail : null,
      },
    };
  }
  function announceRelayCredentialAdopted() {
    if (relayCredentialAdoptionAnnounced) return;
    relayCredentialAdoptionAnnounced = true;
    if (typeof optsAny0.onRelayCredentialAdopted !== "function") return;
    try {
      optsAny0.onRelayCredentialAdopted(relayCredentialLoad);
    } catch (err     ) {
      baseLogger.warn(
        `[ocuclaw] relay credential adoption hook failed: ${err && err.message ? err.message : String(err)}`,
      );
    }
  }

  const facadeSubscriptionChannels = {
    onGlassesUiResult: { registry: new Set(), liveUnsubs: new Map() },

    onLiveUiV2Outcome: { registry: new Set(), liveUnsubs: new Map() },
    onGlassesUiNavEvent: { registry: new Set(), liveUnsubs: new Map() },

    onGlassesUiRenderReceipt: { registry: new Set(), liveUnsubs: new Map() },

    onGlassesUiClientFailure: { registry: new Set(), liveUnsubs: new Map() },
    onDeviceInfoResponse: { registry: new Set(), liveUnsubs: new Map() },
    onGlassesPresenceChanged: { registry: new Set(), liveUnsubs: new Map() },
    onProgramCardFeeds: { registry: new Set(), liveUnsubs: new Map() },
    onLocationResponse: { registry: new Set(), liveUnsubs: new Map() },
    onProgramCardResponse: { registry: new Set(), liveUnsubs: new Map() },
    onProgramCardPlayScreen: { registry: new Set(), liveUnsubs: new Map() },
    onProgramCardFrameChanged: { registry: new Set(), liveUnsubs: new Map() },
    onProgramCardContext: { registry: new Set(), liveUnsubs: new Map() },
    onAppClientDisconnect: { registry: new Set(), liveUnsubs: new Map() },
    onAppClientSessionLeft: { registry: new Set(), liveUnsubs: new Map() },

    onAppPresenceChanged: { registry: new Set(), liveUnsubs: new Map() },
    onLogicalSessionReset: { registry: new Set(), liveUnsubs: new Map() },
    onAgentTurnChanged: { registry: new Set(), liveUnsubs: new Map() },
  };
  function attachFacadeHandler(method, channel, handler, relayInstance) {
    if (!relayInstance || typeof relayInstance[method] !== "function") return;
    const unsub = relayInstance[method](handler);
    if (typeof unsub === "function") channel.liveUnsubs.set(handler, unsub);
  }
  function subscribeFacadeChannel(method, handler) {
    if (typeof handler !== "function") return () => {};
    const channel = facadeSubscriptionChannels[method];
    channel.registry.add(handler);
    attachFacadeHandler(method, channel, handler, resolveLiveRelay());
    return () => {
      channel.registry.delete(handler);
      const unsub = channel.liveUnsubs.get(handler);
      channel.liveUnsubs.delete(handler);
      if (typeof unsub === "function") {
        try {
          unsub();
        } catch (_) {

        }
      }
    };
  }
  function attachFacadeSubscriptions(relayInstance) {
    for (const [method, channel] of Object.entries(facadeSubscriptionChannels)) {
      channel.liveUnsubs.clear();
      for (const handler of channel.registry) {
        attachFacadeHandler(method, channel, handler, relayInstance);
      }
    }
  }

  function getRuntimeConfig() {
    if (!runtimeConfig) {
      runtimeConfig =
        opts.runtimeConfig ||
        createRuntimeConfig({
          env: opts.env || process.env,
          pluginConfig: effectivePluginConfig(),
          openclawConfig: opts.openclawConfig,
        });
    }
    return runtimeConfig;
  }

  function getSetupConfig() {
    if (runtimeConfig) {
      return runtimeConfig;
    }
    if (opts.runtimeConfig) {
      return opts.runtimeConfig;
    }
    if (!setupConfig) {
      setupConfig = createRuntimeConfigOverview({
        env: opts.env || process.env,
        pluginConfig: effectivePluginConfig(),
        openclawConfig: opts.openclawConfig,
      });
    }
    return setupConfig;
  }

  async function resolveRelayCredentialAtStart(logger     ) {
    const boot = getSetupConfig();
    if (boot.relayToken) {
      if (relayCredentialLoad.origin === null) {
        recordRelayCredentialLoad("pre-existing", { status: "not-needed", code: "credential-loaded-at-boot" });
      }
      return true;
    }
    if (typeof optsAny0.mintRelayCredentialAtLoad !== "function") {
      recordRelayCredentialLoad(null, { status: "not-attempted", code: "no-minter" });
      return false;
    }
    let outcome     ;
    try {
      outcome = await optsAny0.mintRelayCredentialAtLoad();
    } catch (err     ) {
      outcome = {
        status: "failed",
        code: typeof err?.code === "string" ? err.code : "mint_failed",
        detail: typeof err?.message === "string" ? err.message : String(err),
      };
    }
    const credential = outcome && typeof outcome.credential === "string" && outcome.credential.length > 0
      ? outcome.credential
      : null;

    recordRelayCredentialLoad(credential ? outcome.origin : null, outcome);
    if (!credential) {
      logger.warn(
        `[ocuclaw] relay credential not minted at load (${
          (outcome && outcome.code) || "unknown"
        }): ${(outcome && outcome.detail) || "no detail"}`,
      );
      return false;
    }
    adoptedRelayToken = credential;
    runtimeConfig = null;
    setupConfig = null;
    logger.info(
      outcome.status === "minted"
        ? "[ocuclaw] relay credential minted by this host at plugin load and adopted in-process; pair a phone with `openclaw ocuclaw pair`"
        : `[ocuclaw] relay credential adopted in-process at start (${outcome.code})`,
    );
    return true;
  }

  function pendingFirstLoadConfigWrites(stateDir     ) {
    const pending      = [];
    if (!getSetupConfig().relayToken && typeof optsAny0.mintRelayCredentialAtLoad === "function") {
      pending.push("relay-credential");
    }
    if (conversationAccessGrantOwed()) pending.push("conversation-access");
    const wsPortViewAmbiguous =
      hasExplicitWsPort(optsAny0.pluginConfig) &&
      optsAny0.pluginConfig.wsPort === OPENCLAW_BUNDLE_DEFAULT_WS_PORT;
    if (
      !optsAny0.runtimeConfig &&
      typeof optsAny0.persistFreshWsPortConfig === "function" &&
      (!hasExplicitWsPort(optsAny0.pluginConfig) || wsPortViewAmbiguous) &&
      resolveRelayPortDecision({ stateDir, fsImpl: optsAny0.relayPortFs }).origin === "fresh-default"
    ) {
      pending.push("relay-port");
    }
    return pending;
  }

  function deferStartUntilHostSettled(startOpts     , logger     , pending     ) {
    const gate = optsAny0.createConfigWriteGate(startOpts.config);
    const deferral = { gate };
    deferredStart = deferral;
    logger.info(
      `[ocuclaw] relay start waits for OpenClaw to finish activating the plugin: first-load config write pending (${pending.join(", ")})`,
    );
    Promise.resolve(gate.whenSettled())
      .then((outcome     ) => {
        if (deferredStart !== deferral) return null;
        deferredStart = null;
        logger.info(
          `[ocuclaw] OpenClaw activation settled (${(outcome && outcome.reason) || "unknown"}, ${
            (outcome && outcome.waitedMs) || 0
          } ms): starting relay`,
        );

        return runOutsideRetiredPluginCache(() => start({ ...startOpts, hostSettled: true }));
      })
      .catch((err     ) => {
        logger.error(
          `[ocuclaw] relay start after OpenClaw activation failed: ${err && err.message ? err.message : String(err)}`,
        );
      });
    return null;
  }

  function conversationAccessGrantOwed() {
    return !conversationAccessGrant.attempted &&
      typeof optsAny0.grantConversationAccessAtLoad === "function";
  }

  function grantConversationAccessAfterStart(logger     ) {
    if (!conversationAccessGrantOwed()) {
      reloadAfterMintIfOwed(logger);
      return;
    }
    conversationAccessGrant = { attempted: true, status: "pending", code: null };
    Promise.resolve()
      .then(() => optsAny0.grantConversationAccessAtLoad())
      .catch((err     ) => ({
        status: "failed",
        code: "grant_failed",
        detail: err && err.message ? err.message : String(err),
      }))
      .then((outcome     ) => {
        const status = outcome && typeof outcome.status === "string" ? outcome.status : "failed";
        const code = outcome && typeof outcome.code === "string" ? outcome.code : null;
        conversationAccessGrant = { attempted: true, status, code };
        if (status === "granted") {
          logger.info(
            outcome.afterWrite === "auto"
              ? "[ocuclaw] conversation access granted at plugin load; OpenClaw reloads the plugin to register its conversation hooks"
              : "[ocuclaw] conversation access granted at plugin load; the conversation hooks register at the next gateway start",
          );
        } else if (status === "skipped" || status === "failed") {
          logger.warn(
            `[ocuclaw] conversation access not granted at load (${code || "unknown"}): ${
              (outcome && outcome.detail) || "no detail"
            }`,
          );
        }

        if (!(status === "granted" && outcome.afterWrite === "auto")) reloadAfterMintIfOwed(logger);
      });
  }

  function reloadAfterMintIfOwed(logger     ) {
    if (mintReload.attempted) return;
    if (relayCredentialLoad.mintOnLoad.status !== "minted" || adoptedRelayToken === null) return;
    if (typeof optsAny0.reloadAfterRelayCredentialMint !== "function") return;
    mintReload = { attempted: true, status: "pending", code: null };
    Promise.resolve()
      .then(() => optsAny0.reloadAfterRelayCredentialMint())
      .catch((err     ) => ({
        status: "failed",
        code: "reload_failed",
        detail: err && err.message ? err.message : String(err),
      }))
      .then((outcome     ) => {
        const status = outcome && typeof outcome.status === "string" ? outcome.status : "failed";
        const code = outcome && typeof outcome.code === "string" ? outcome.code : null;
        mintReload = { attempted: true, status, code };
        if (status === "reloading") {
          logger.info("[ocuclaw] relay credential minted at load; OpenClaw reloads the plugin so every part of it has the credential");
        } else {
          logger.warn(
            `[ocuclaw] no plugin reload after the load-time mint (${code || "unknown"}): ${
              (outcome && outcome.detail) || "the credential reaches the setup tools at the next gateway start"
            }`,
          );
        }
      });
  }

  function cancelDeferredStart() {
    if (!deferredStart) return false;
    const deferral = deferredStart;
    deferredStart = null;
    try {
      deferral.gate.cancel();
    } catch (_) {

    }
    return true;
  }

  async function start(startOpts      = {}) {
    if (relay) {
      return relay;
    }
    if (deferredStart) {
      return null;
    }

    const logger = normalizeLogger(startOpts.logger || baseLogger);
    if (
      startOpts.hostSettled !== true &&
      typeof optsAny0.createConfigWriteGate === "function" &&
      startOpts.config &&
      typeof startOpts.config === "object"
    ) {
      const pending = pendingFirstLoadConfigWrites(startOpts.stateDir || optsAny0.stateDir);
      if (pending.length > 0) {
        return deferStartUntilHostSettled(startOpts, logger, pending);
      }
    }
    await resolveRelayCredentialAtStart(logger);
    const readiness = getSetupConfig();
    const missingRequiredSecrets = [];
    if (!readiness.relayToken) missingRequiredSecrets.push("relayToken");
    if (!readiness.gatewayToken) missingRequiredSecrets.push("gatewayToken");
    if (missingRequiredSecrets.length > 0) {
      logger.warn(
        `[ocuclaw] relay service not started: ${missingRequiredSecrets.join(" and ")} ` +
          "must be configured first; no relay listener was opened",
      );
      grantConversationAccessAfterStart(logger);
      return null;
    }
    const config = getRuntimeConfig();
    const stateDir = startOpts.stateDir || opts.stateDir;

    let effectiveWsPort = config.wsPort;
    const wsPortViewAmbiguous =
      hasExplicitWsPort(opts.pluginConfig) &&
      opts.pluginConfig.wsPort === OPENCLAW_BUNDLE_DEFAULT_WS_PORT;
    if (
      !opts.runtimeConfig &&
      (!hasExplicitWsPort(opts.pluginConfig) || wsPortViewAmbiguous)
    ) {
      const portDecision = resolveRelayPortDecision({
        stateDir,
        fsImpl: opts.relayPortFs,
      });
      if (portDecision.origin === "fresh-default") {

        let writeResult = null;
        if (typeof opts.persistFreshWsPortConfig === "function") {
          try {
            writeResult = await opts.persistFreshWsPortConfig(portDecision.port);
          } catch (err     ) {
            writeResult = {
              written: false,
              reason: `mutation-failed: ${err && err.message}`,
            };
          }
        } else {
          writeResult = { written: false, reason: "no-config-writer" };
        }
        if (writeResult && writeResult.written === true) {
          effectiveWsPort = portDecision.port;
          logger.info(
            `[ocuclaw] relay wsPort not set in config: using ${portDecision.port} (fresh-default)`,
          );
          logger.info(
            `[ocuclaw] fresh-install relay port ${portDecision.port} written to plugin config`,
          );
          persistRelayPortMarker({
            stateDir,
            decision: portDecision,
            logger,
            fsImpl: opts.relayPortFs,
          });
        } else if (writeResult && writeResult.reason === "already-set") {

          effectiveWsPort = Number.isInteger(writeResult.existingPort)
            ? writeResult.existingPort
            : config.wsPort;
          logger.info(
            `[ocuclaw] relay wsPort ${effectiveWsPort} confirmed explicit in config; fresh default not applied`,
          );
        } else {

          logger.warn(
            `[ocuclaw] could not confirm fresh-install relay port in config (${
              (writeResult && writeResult.reason) || "unknown"
            }); keeping ${effectiveWsPort} for this start`,
          );
        }
      } else {
        effectiveWsPort = portDecision.port;
        logger.info(
          `[ocuclaw] relay wsPort not set in config: using ${portDecision.port} (${portDecision.origin})`,
        );
        if (portDecision.persistMarker) {
          persistRelayPortMarker({
            stateDir,
            decision: portDecision,
            logger,
            fsImpl: opts.relayPortFs,
          });
        }
      }
    }
    const createRelay = resolveCreateRelay(opts.createRelay);
    const openclawClient = resolveOpenclawClient(
      opts.openclawClient,
      config,
      logger,
      stateDir,
    );
    if (typeof openclawClient.setLogger === "function") {
      openclawClient.setLogger(logger);
    }
    const optsAny      = opts;
    const nextRelay = createRelay({
      optionalSetupCommandsVersion: 1,
      optionalSetupEvenAiCommands: true,
      optionalSetup: optsAny.optionalSetup,
      setupStateDir: optsAny.setupStateDir,

      readPhoneAddress: optsAny.readPhoneAddress,
      phoneAddress: config.phoneAddress,
      gatewayUrl: config.gatewayUrl,
      gatewayToken: config.gatewayToken,

      inputPrediction: optsAny.inputPrediction,

      inputPredictionTimeoutMs: readInputPredictionTimeoutMs(optsAny.pluginConfig),

      programCardsJev: config.programCardsJev,

      programCardsMcp: config.programCardsMcp,
      programCardMcpHost: optsAny.programCardMcpHost,
      programCardsModel: config.programCardsModel,
      programCardModelHost: optsAny.programCardModelHost,

      onTaskSheet: (request     ) => answerTaskSheetRequest(getRegisteredGlassesUiHandler(), request, {
        recentResults: (jobId     ) => {
          const liveRelay = resolveLiveRelay();
          return liveRelay && typeof liveRelay.openClawTaskRecentResults === "function"
            ? liveRelay.openClawTaskRecentResults(jobId) : { available: false, results: [] };
        },
      }),
      httpServer: startOpts.httpServer || opts.httpServer,
      port: effectiveWsPort,
      host: config.wsBind,
      token: config.relayToken,
      sessionLimit: config.sessionLimit,
      sonioxApiKey: config.sonioxApiKey,
      cartesiaApiKey: config.cartesiaApiKey,

      liveuiJev: config.liveuiJev,
      liveuiV2: config.liveuiV2,
      debugNoisyPolicies: config.debugNoisyPolicies,
      externalDebugToolsEnabled: config.externalDebugToolsEnabled,
      debugAutoArm: config.debugAutoArm,
      allowDebugUpload: config.allowDebugUpload,
      liveuiReconnectGraceMs: config.liveuiReconnectGraceMs,
      debugUploadMaxZipBytes: config.debugUploadMaxZipBytes,
      debugUploadCapturePreset: config.debugUploadCapturePreset,
      debugBundleSaveDir: config.debugBundleSaveDir,
      evenAiEnabled: config.evenAiEnabled,
      evenAiToken: config.evenAiToken,
      evenAiSystemPrompt: config.evenAiSystemPrompt,
      evenAiRequestTimeoutMs: config.evenAiRequestTimeoutMs,
      evenAiMaxBodyBytes: config.evenAiMaxBodyBytes,
      evenAiDedupWindowMs: config.evenAiDedupWindowMs,
      evenAiRoutingMode: config.evenAiRoutingMode,
      evenAiDedicatedSessionKey: config.evenAiDedicatedSessionKey,
      getGlassesUiLiveConfig: () => {
        const serviceOpts      = opts;
        const current = getRuntimeConfig();
        if (serviceOpts.runtimeConfig) {
          return current && current.glassesUiLive ? current.glassesUiLive : undefined;
        }

        return resolveGlassesUiLive(
          serviceOpts.pluginConfig && serviceOpts.pluginConfig.glassesUiLive,
          serviceOpts.openclawConfig,
          logger,
        );
      },
      stateDir,
      openclawClient,
      logger,
      consoleLogPath: opts.consoleLogPath,
      activityStatusAdapter: {
        freshnessWindowMs: config.freshnessWindowMs,
        now: () => Date.now(),
      },
    });

    relay = nextRelay;

    try {
      nextRelay.effectiveWsPort = effectiveWsPort;
    } catch (_) {

    }

    try {
      nextRelay.relayLifecycle = "starting";
    } catch (_) {

    }
    setSharedRelay(nextRelay);

    attachFacadeSubscriptions(nextRelay);
    logger.info(
      `[ocuclaw] relay inbound subscriptions attached: ${Object.entries(facadeSubscriptionChannels)
        .map(([method, ch]) => `${method}=${ch.registry.size}`)
        .join(" ")}`,
    );
    try {
      await Promise.resolve(nextRelay.start());
      try {
        nextRelay.relayLifecycle = "listening";
      } catch (_) {

      }
      logger.info(
        `[ocuclaw] relay service started on ws://${config.wsBind}:${effectiveWsPort}`,
      );
      const containerEnvProbe =
        typeof opts.isContainerEnvironment === "function"
          ? opts.isContainerEnvironment
          : isContainerEnvironment;
      if (isLoopbackBindAddress(config.wsBind) && containerEnvProbe()) {
        logger.info(composeContainerLoopbackNotice(config.wsBind, effectiveWsPort));
      }
      startCloudwaysSupervisor(logger, startOpts);

      if (adoptedRelayToken !== null) announceRelayCredentialAdopted();
      grantConversationAccessAfterStart(logger);
      return nextRelay;
    } catch (err) {
      clearSharedRelay(nextRelay);
      relay = null;
      throw err;
    }
  }

  function getRelayCredentialLoadState() {
    return {
      origin: relayCredentialLoad.origin,
      adoptedInProcess: adoptedRelayToken !== null,
      mintOnLoad: { ...relayCredentialLoad.mintOnLoad },
    };
  }

  function startCloudwaysSupervisor(logger     , startOpts     ) {
    if (cloudwaysSupervisor) return;
    if (opts.cloudwaysSupervisor === false || startOpts.cloudwaysSupervisor === false) return;
    try {
      const create = typeof opts.createCloudwaysSupervisor === "function"
        ? opts.createCloudwaysSupervisor
        : createCloudwaysSupervisor;
      cloudwaysSupervisor = create({ logger });
      Promise.resolve(cloudwaysSupervisor.start()).catch((error     ) => {
        logger.warn(`[ocuclaw] cloudways supervisor start failed: ${String((error && error.message) || error)}`);
      });
    } catch (error     ) {
      cloudwaysSupervisor = null;
      logger.warn(`[ocuclaw] cloudways supervisor unavailable: ${String((error && error.message) || error)}`);
    }
  }

  function stopCloudwaysSupervisor() {
    if (!cloudwaysSupervisor) return;
    const supervisor = cloudwaysSupervisor;
    cloudwaysSupervisor = null;

    try { supervisor.stop(); } catch (_) {  }
  }

  async function stop(stopOpts      = {}) {
    if (cancelDeferredStart()) {
      normalizeLogger(stopOpts.logger || baseLogger).info(
        "[ocuclaw] relay start cancelled: the service stopped before OpenClaw finished activating the plugin",
      );
    }
    if (!relay) {
      stopCloudwaysSupervisor();
      return;
    }

    const logger = normalizeLogger(stopOpts.logger || baseLogger);
    const activeRelay = relay;
    relay = null;
    clearSharedRelay(activeRelay);
    stopCloudwaysSupervisor();
    await Promise.resolve(activeRelay.stop());
    logger.info("[ocuclaw] relay service stopped");
  }

  function resolveLiveRelay() {

    return relay || getSharedRelay();
  }
  return {
    getRuntimeConfig,
    getSetupConfig,
    getRelayCredentialLoadState,
    getConversationAccessGrantState() {
      return { ...conversationAccessGrant };
    },
    getRelay() {
      return resolveLiveRelay();
    },
    sendGlassesUiRender(params) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.sendGlassesUiRender !== "function") {
        throw new Error("ocuclaw relay not started");
      }
      liveRelay.sendGlassesUiRender(params);
    },
    sendGlassesUiSurfaceUpdate(params) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.sendGlassesUiSurfaceUpdate !== "function") {
        throw new Error("ocuclaw relay not started");
      }
      liveRelay.sendGlassesUiSurfaceUpdate(params);
    },
    broadcastPushMessage(params) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.broadcastPushMessage !== "function") {
        throw new Error("ocuclaw relay not started");
      }
      return liveRelay.broadcastPushMessage(params);
    },

    sendTaskPushMessage(task     , clientId      ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.sendTaskPushMessage !== "function") return 0;
      return liveRelay.sendTaskPushMessage(task, clientId);
    },

    feedProgramCard(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.feedProgramCard !== "function") {
        return { status: "rejected", code: "no_feed_run" };
      }
      return liveRelay.feedProgramCard(params);
    },

    sendTaskLookOffer(offer     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.sendTaskLookOffer !== "function") return 0;
      return liveRelay.sendTaskLookOffer(offer);
    },

    openClawTaskSchedulesOn() {
      const liveRelay = resolveLiveRelay();
      return !!liveRelay && typeof liveRelay.openClawTaskSchedulesOn === "function" &&
        liveRelay.openClawTaskSchedulesOn() === true;
    },
    openClawTaskSchedulesAvailable() {
      const liveRelay = resolveLiveRelay();
      return !!liveRelay && typeof liveRelay.openClawTaskSchedulesAvailable === "function" &&
        liveRelay.openClawTaskSchedulesAvailable() === true;
    },

    openClawTaskPageWatchAvailable() {
      const liveRelay = resolveLiveRelay();
      return !!liveRelay && typeof liveRelay.openClawTaskPageWatchAvailable === "function" &&
        liveRelay.openClawTaskPageWatchAvailable() === true;
    },

    taskRowsChanged() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.taskRowsChanged === "function") liveRelay.taskRowsChanged();
    },
    taskScheduleRequest(identity     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.taskScheduleRequest !== "function") {
        return Promise.reject(Object.assign(new Error("capability_unavailable"), { code: "capability_unavailable" }));
      }
      return liveRelay.taskScheduleRequest(identity);
    },
    noteOpenClawCronEnabled(enabled     ) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.noteOpenClawCronEnabled === "function") liveRelay.noteOpenClawCronEnabled(enabled);
    },

    noteOpenClawAgentFinalize(event     , ctx     ) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.noteOpenClawAgentFinalize === "function") liveRelay.noteOpenClawAgentFinalize(event, ctx);
    },

    noteOpenClawRunModel(ctx     ) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.noteOpenClawRunModel === "function") liveRelay.noteOpenClawRunModel(ctx);
    },

    openClawTaskRunContext(event     , ctx     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.openClawTaskRunContext === "function"
        ? liveRelay.openClawTaskRunContext(event, ctx) : undefined;
    },
    noteOpenClawCronChanged(event     ) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.noteOpenClawCronChanged === "function") liveRelay.noteOpenClawCronChanged(event);
    },

    emitGlassesUiLifecycle(event, severity, data) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.emitGlassesUiLifecycle === "function") {
        liveRelay.emitGlassesUiLifecycle(event, severity, data);
      }
    },

    takeSurfaceDecisionForPrompt(sessionKey, query) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.takeSurfaceDecisionForPrompt !== "function") {
        return Promise.resolve(null);
      }
      return liveRelay.takeSurfaceDecisionForPrompt(sessionKey, query);
    },

    presentCardAsk(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.presentCardAsk !== "function") {
        return Promise.resolve({ answer: "no_answer", reason: "unavailable" });
      }
      return liveRelay.presentCardAsk(params);
    },

    cardAskNotShown(sessionKey     ) {
      resolveLiveRelay()?.cardAskNotShown?.(sessionKey);
    },

    cardBuildNotesOn() {
      const liveRelay = resolveLiveRelay();
      return !!liveRelay && typeof liveRelay.cardBuildNotesOn === "function" && liveRelay.cardBuildNotesOn() === true;
    },

    noteCardStudioToolCall(call     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.noteCardStudioToolCall === "function" ? liveRelay.noteCardStudioToolCall(call) : null;
    },

    cardBuildTaskFor(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildTaskFor === "function" ? liveRelay.cardBuildTaskFor(sessionKey) : null;
    },

    cardBuildTestCard(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildTestCard === "function" ? liveRelay.cardBuildTestCard(sessionKey) : null;
    },

    cardBuildStarter(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildStarter === "function" ? liveRelay.cardBuildStarter(sessionKey) : null;
    },

    cardBuildTaskFixAsk(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildTaskFixAsk === "function" ? liveRelay.cardBuildTaskFixAsk(sessionKey) : null;
    },
    async cardBuildTaskFix(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildTaskFix === "function" ? liveRelay.cardBuildTaskFix(sessionKey) : null;
    },

    async cardBuildTaskAdd(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildTaskAdd === "function" ? liveRelay.cardBuildTaskAdd(sessionKey) : null;
    },

    cardBuildNoDraftsWhy(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildNoDraftsWhy === "function" ? liveRelay.cardBuildNoDraftsWhy(sessionKey) : "";
    },

    cardBuildFindSaved(sessionKey     , query     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildFindSaved === "function" ? liveRelay.cardBuildFindSaved(sessionKey, query) : null;
    },
    async cardBuildChange(sessionKey     , change     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildChange === "function" ? liveRelay.cardBuildChange(sessionKey, change) : null;
    },
    cardBuildChangeOf(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildChangeOf === "function" ? liveRelay.cardBuildChangeOf(sessionKey) : null;
    },

    cardBuildChangeReplace(sessionKey     , numbers     , notChecks      ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildChangeReplace === "function" ? liveRelay.cardBuildChangeReplace(sessionKey, numbers, notChecks) : null;
    },
    cardBuildChangeDone(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildChangeDone === "function" ? liveRelay.cardBuildChangeDone(sessionKey) : null;
    },

    cardBuildChangeTested(sessionKey     , tested      = true) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildChangeTested === "function" ? liveRelay.cardBuildChangeTested(sessionKey, tested) : null;
    },

    async cardBuildChangeRevive(sessionKey     , draftId     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildChangeRevive === "function" ? liveRelay.cardBuildChangeRevive(sessionKey, draftId) : false;
    },

    cardBuildChangeLiveFailed(sessionKey     , failed     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildChangeLiveFailed === "function" ? liveRelay.cardBuildChangeLiveFailed(sessionKey, failed) : null;
    },

    cardBuildLiveFailed(sessionKey     , parts     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildLiveFailed === "function" ? liveRelay.cardBuildLiveFailed(sessionKey, parts) : null;
    },

    async cardBuildChangeSpoken(sessionKey     , open     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.cardBuildChangeSpoken === "function" ? liveRelay.cardBuildChangeSpoken(sessionKey, open) : null;
    },
    programCardChangeLine(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.programCardChangeLine === "function" ? liveRelay.programCardChangeLine(sessionKey) : "";
    },

    programCardCheckAsked(sessionKey     , turn      = {}) {
      const liveRelay = resolveLiveRelay();
      return liveRelay && typeof liveRelay.programCardCheckAsked === "function" ? liveRelay.programCardCheckAsked(sessionKey, turn) : null;
    },

    async planCardBuildTurn(sessionKey     , info     ) {
      const liveRelay = resolveLiveRelay();
      return !!liveRelay && typeof liveRelay.planCardBuildTurn === "function"
        && (await liveRelay.planCardBuildTurn(sessionKey, info)) === true;
    },

    takeLiveUiV2FenceFragments(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.takeLiveUiV2FenceFragments !== "function") {
        return [];
      }
      return liveRelay.takeLiveUiV2FenceFragments(sessionKey);
    },

    isLiveUiV2Session(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.isLiveUiV2Session !== "function") return false;
      return liveRelay.isLiveUiV2Session(sessionKey) === true;
    },

    composeLiveUiV2Records(sessionKey     , input     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.composeLiveUiV2Records !== "function") {
        return { ok: false, mode: "none", target: null, frame: null, placed: [], notes: [], reason: "relay_not_ready", painted: false, surfaceId: null, specRev: null };
      }
      return liveRelay.composeLiveUiV2Records(sessionKey, input);
    },

    writeLiveUiV2Data(sessionKey     , surfaceId     , patch     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.writeLiveUiV2Data !== "function") return { ok: false, reason: "surface_gone" };
      return liveRelay.writeLiveUiV2Data(sessionKey, surfaceId, patch);
    },
    prefetchLiveUiV2Picture(sessionKey     , surfaceId     , src     , componentId     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.prefetchLiveUiV2Picture !== "function") return Promise.resolve({ ok: true });
      return liveRelay.prefetchLiveUiV2Picture(sessionKey, surfaceId, src, componentId);
    },
    setLiveUiV2Inputs(sessionKey     , surfaceId     , inputs     , values     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.setLiveUiV2Inputs !== "function") return { ok: false, reason: "surface_gone" };
      return liveRelay.setLiveUiV2Inputs(sessionKey, surfaceId, inputs, values);
    },
    isLiveUiV2SurfaceLive(sessionKey     , surfaceId     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.isLiveUiV2SurfaceLive !== "function") return false;
      return liveRelay.isLiveUiV2SurfaceLive(sessionKey, surfaceId) === true;
    },
    liveUiV2TopSurface(sessionKey     , opts      ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.liveUiV2TopSurface !== "function") return null;
      return liveRelay.liveUiV2TopSurface(sessionKey, opts);
    },
    openLiveUiV2Records(sessionKey     , input     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.openLiveUiV2Records !== "function") {
        return { ok: false, painted: false, surfaceId: null, specRev: null, notes: [], reason: "relay_not_ready" };
      }
      return liveRelay.openLiveUiV2Records(sessionKey, input);
    },
    withdrawLiveUiV2Surface(sessionKey     , surfaceId     , reason     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.withdrawLiveUiV2Surface !== "function") return false;
      return liveRelay.withdrawLiveUiV2Surface(sessionKey, surfaceId, reason) === true;
    },

    onGlassesUiResult(handler) {
      return subscribeFacadeChannel("onGlassesUiResult", handler);
    },
    onLiveUiV2Outcome(handler     ) {
      return subscribeFacadeChannel("onLiveUiV2Outcome", handler);
    },

    collectLiveUiV2State(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.collectLiveUiV2State !== "function") return null;
      return liveRelay.collectLiveUiV2State(sessionKey);
    },

    isLiveUiV2TapOwed(sessionKey     , eventId     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.isLiveUiV2TapOwed !== "function") return null;
      return liveRelay.isLiveUiV2TapOwed(sessionKey, eventId);
    },
    onGlassesUiNavEvent(handler) {
      return subscribeFacadeChannel("onGlassesUiNavEvent", handler);
    },
    onGlassesUiRenderReceipt(handler     ) {
      return subscribeFacadeChannel("onGlassesUiRenderReceipt", handler);
    },
    onGlassesUiClientFailure(handler     ) {
      return subscribeFacadeChannel("onGlassesUiClientFailure", handler);
    },
    onAppClientDisconnect(handler) {
      return subscribeFacadeChannel("onAppClientDisconnect", handler);
    },
    onAppClientSessionLeft(handler     ) {
      return subscribeFacadeChannel("onAppClientSessionLeft", handler);
    },
    onAppPresenceChanged(handler     ) {
      return subscribeFacadeChannel("onAppPresenceChanged", handler);
    },
    onLogicalSessionReset(handler     ) {
      return subscribeFacadeChannel("onLogicalSessionReset", handler);
    },
    onAgentTurnChanged(handler     ) {
      return subscribeFacadeChannel("onAgentTurnChanged", handler);
    },
    sendDeviceInfoRequest(params) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.sendDeviceInfoRequest !== "function") {
        throw new Error("ocuclaw relay not started");
      }
      liveRelay.sendDeviceInfoRequest(params);
    },
    onDeviceInfoResponse(handler) {
      return subscribeFacadeChannel("onDeviceInfoResponse", handler);
    },
    getPhoneSettings() {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.getPhoneSettings !== "function") {
        return Promise.resolve({ ok: false, code: "phone_not_connected" });
      }
      return liveRelay.getPhoneSettings();
    },
    setPhoneSetting(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.setPhoneSetting !== "function") {
        return Promise.resolve({ ok: false, code: "phone_not_connected" });
      }
      return liveRelay.setPhoneSetting(params);
    },
    onGlassesPresenceChanged(handler     ) {
      return subscribeFacadeChannel("onGlassesPresenceChanged", handler);
    },
    onProgramCardFeeds(handler     ) {
      return subscribeFacadeChannel("onProgramCardFeeds", handler);
    },
    sendProgramCardData(frame     ) {

      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.sendProgramCardData === "function") liveRelay.sendProgramCardData(frame);
    },

    askLiveuiSite(request     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.askLiveuiSite !== "function") return "unavailable";
      return liveRelay.askLiveuiSite(request);
    },

    liveProgramCardParts(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.liveProgramCardParts !== "function") return Promise.resolve(null);
      return liveRelay.liveProgramCardParts(params);
    },

    settleProgramCardSites(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.settleProgramCardSites !== "function") return Promise.resolve(null);
      return liveRelay.settleProgramCardSites(params);
    },

    considerProgramCardJev(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.considerProgramCardJev !== "function") return Promise.resolve({ answer: "off" });
      return liveRelay.considerProgramCardJev(params);
    },
    programCardJevTaught() {
      const liveRelay = resolveLiveRelay();
      return !!liveRelay && typeof liveRelay.programCardJevTaught === "function" && liveRelay.programCardJevTaught() === true;
    },
    programCardSwitches() {
      const liveRelay = resolveLiveRelay();
      return liveRelay?.programCardSwitches?.() || null;
    },

    programCardHealth(key     , sessionKey      = "", declared      = null) {
      const liveRelay = resolveLiveRelay();
      const parts = liveRelay?.programCardHealth?.(key, sessionKey, declared);
      return Array.isArray(parts) ? parts : [];
    },

    programCardFeedHealth(cardId     , key      = "", sessionKey      = "") {
      const liveRelay = resolveLiveRelay();
      const rows = liveRelay?.programCardFeedHealth?.(cardId, key, sessionKey);
      return Array.isArray(rows) ? rows : [];
    },

    async programCardSetupCheck() {
      const liveRelay = resolveLiveRelay();
      let facts      = null;
      try {
        facts = (await liveRelay?.programCardSetupFacts?.()) ?? null;
      } catch (_) {
        facts = null;
      }
      if (!facts) return composeCardSetupCheck(null);

      const tasks = typeof liveRelay?.taskRunRows === "function" ? await readCardSetupTaskRows(() => liveRelay.taskRunRows()) : null;
      return composeCardSetupCheck({ ...facts, ...(tasks ? { tasks } : {}) });
    },

    async programCardToolsSetup(opts      = {}) {
      try {
        return (await resolveLiveRelay()?.programCardToolsFacts?.(opts)) ?? null;
      } catch (_) {
        return null;
      }
    },

    async programCardHostHealth(parts     ) {
      const liveRelay = resolveLiveRelay();
      const rows = await liveRelay?.programCardHostHealth?.(parts);
      return Array.isArray(rows) ? rows : [];
    },

    taskReadWithHealth(result     , taskId     , records     ) {
      const liveRelay = resolveLiveRelay();
      return withTaskRunHealth(result, {
        row: () => (typeof liveRelay?.taskRunRow === "function" ? liveRelay.taskRunRow(taskId) : null),
        records,
      });
    },

    cardCheck(input     , sessionKey     , tasks     ) {
      const liveRelay = resolveLiveRelay();
      return runCardCheck(input, {
        cards: (query               ) => (typeof liveRelay?.programCardCheck === "function" ? liveRelay.programCardCheck(sessionKey, query) : null),
        rows: () => {
          if (typeof liveRelay?.taskRunRows !== "function") throw new Error("no relay");
          return liveRelay.taskRunRows();
        },
        tasks,
      }, Date.now(), { host: "openclaw", playbookFile: bundledCardFixPlaybookFile() });
    },
    considerProgramCardModel(params     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay?.considerProgramCardModel?.(params) || Promise.resolve({ answer: "off" });
    },

    considerProgramCardAgentRefresh(params     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay?.considerProgramCardAgentRefresh?.(params) || Promise.resolve({ answer: "no_answer" });
    },

    programCardAgentRefreshAllowed(key     ) {
      return resolveLiveRelay()?.programCardAgentRefreshAllowed?.(key) === true;
    },

    programCardFrameComplete() {
      const complete = resolveLiveRelay()?.completeProgramCardFrame;
      return typeof complete === "function" ? complete : null;
    },

    programCardFrameDetail() {
      const detail = resolveLiveRelay()?.programCardFrameDetail;
      return typeof detail === "function" ? detail() : null;
    },

    noteProgramCardFrameBrief(source        , brief     ) {
      resolveLiveRelay()?.noteProgramCardFrameBrief?.(source, brief);
    },

    noteCardBuildFrameIdea(sessionKey        , idea        ) {
      resolveLiveRelay()?.noteCardBuildFrameIdea?.(sessionKey, idea);
    },

    holdCardBuildDone(sessionKey        , settled                  , maxMs        ) {
      const liveRelay = resolveLiveRelay();
      return typeof liveRelay?.holdCardBuildDone === "function" ? liveRelay.holdCardBuildDone(sessionKey, settled, maxMs) : false;
    },

    noteCardBuildSpeck(sessionKey        , text        ) {
      resolveLiveRelay()?.noteCardBuildSpeck?.(sessionKey, text);
    },
    applyProgramCardSwitches(values     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay?.applyProgramCardSwitches) throw new Error("relay_unavailable");
      return liveRelay.applyProgramCardSwitches(values);
    },

    applyLiveuiJev(values     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay?.applyLiveuiJev) throw new Error("relay_unavailable");
      return liveRelay.applyLiveuiJev(values);
    },

    considerProgramCardMcp(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.considerProgramCardMcp !== "function") return Promise.resolve({ answer: "off" });
      return liveRelay.considerProgramCardMcp(params);
    },
    considerProgramCardMcpWrite(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.considerProgramCardMcpWrite !== "function") return Promise.resolve({ answer: "off" });
      return liveRelay.considerProgramCardMcpWrite(params);
    },

    considerProgramCardSetup(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.considerProgramCardSetup !== "function") return Promise.resolve({ answer: "no_glasses" });
      return liveRelay.considerProgramCardSetup(params);
    },

    considerProgramCardHostCommand(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.considerProgramCardHostCommand !== "function") return Promise.resolve({ answer: "off" });
      return liveRelay.considerProgramCardHostCommand(params);
    },
    programCardHostCommandsOn() {
      const liveRelay = resolveLiveRelay();
      return !!liveRelay && typeof liveRelay.programCardHostCommandsOn === "function" && liveRelay.programCardHostCommandsOn() === true;
    },

    checkProgramCardMcpWrites(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.checkProgramCardMcpWrites !== "function") return Promise.resolve({ ok: false });
      return liveRelay.checkProgramCardMcpWrites(params);
    },
    programCardMcpTools() {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.programCardMcpTools !== "function") return "";
      const tools = liveRelay.programCardMcpTools();
      return typeof tools === "string" ? tools : "";
    },
    sendLocationRequest(params) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.sendLocationRequest !== "function") {
        throw new Error("ocuclaw relay not started");
      }
      liveRelay.sendLocationRequest(params);
    },
    onLocationResponse(handler) {
      return subscribeFacadeChannel("onLocationResponse", handler);
    },
    broadcastProgramCardSaveRequest(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.broadcastProgramCardSaveRequest !== "function") {
        throw new Error("ocuclaw relay not started");
      }
      liveRelay.broadcastProgramCardSaveRequest(params);
    },
    supportsProgramCardDrafts(sessionKey        ) { return resolveLiveRelay()?.supportsProgramCardDrafts?.(sessionKey) === true; },
    writeProgramCardDraft(sessionKey        , card     ) {
      return resolveLiveRelay()?.writeProgramCardDraft?.(sessionKey, card) || { ok: false, shown: false, error: "draft_unavailable" };
    },
    programCardDraftAction(sessionKey        , params     ) {
      return resolveLiveRelay()?.programCardDraftAction?.(sessionKey, params) || { ok: false, error: "draft_unavailable" };
    },
    programCardDraftIndex(sessionKey        ) { return resolveLiveRelay()?.programCardDraftIndex?.(sessionKey) || ""; },
    programCardPictureFileScope(sessionKey        ) {
      return resolveLiveRelay()?.programCardPictureFileScope?.(sessionKey) ?? null;
    },
    sendProgramCardRequest(params     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.sendProgramCardRequest !== "function") {
        const err      = new Error("ocuclaw relay not started");
        err.code = "no_downstream_client";
        throw err;
      }
      liveRelay.sendProgramCardRequest(params);
    },
    onProgramCardResponse(handler     ) {
      return subscribeFacadeChannel("onProgramCardResponse", handler);
    },

    onProgramCardPlayScreen(handler     ) {
      return subscribeFacadeChannel("onProgramCardPlayScreen", handler);
    },

    onProgramCardFrameChanged(handler     ) {
      return subscribeFacadeChannel("onProgramCardFrameChanged", handler);
    },
    sendProgramCardLookResult(params     ) {
      const liveRelay = resolveLiveRelay();
      return liveRelay?.sendProgramCardLookResult?.(params) ?? false;
    },
    clearProgramCardLookResults(sessionKey         ) {
      resolveLiveRelay()?.clearProgramCardLookResults?.(sessionKey);
    },
    onProgramCardContext(handler     ) {
      return subscribeFacadeChannel("onProgramCardContext", handler);
    },
    isLocationAccessEnabled() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.isLocationAccessEnabled === "function") {
        return liveRelay.isLocationAccessEnabled();
      }
      return false;
    },
    getEvenAiSettingsSnapshot() {
      if (relay && typeof relay.getEvenAiSettingsSnapshot === "function") {
        return relay.getEvenAiSettingsSnapshot();
      }
      const config = runtimeConfig;
      return {
        routingMode: config ? config.evenAiRoutingMode : "active",
        systemPrompt: config ? config.evenAiSystemPrompt : "",
        defaultModel: "",
        defaultThinking: "",
        listenEnabled: false,
        trackedThrowawayKeys: [],
      };
    },
    getEvenAiDedicatedSessionKey() {
      return runtimeConfig ? runtimeConfig.evenAiDedicatedSessionKey : "ocuclaw:even-ai";
    },
    getSessionTitleModel() {
      return runtimeConfig ? runtimeConfig.sessionTitleModel || "" : "";
    },

    getSessionTitle(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getSessionTitle === "function") {
        return liveRelay.getSessionTitle(sessionKey);
      }
      return null;
    },
    hasRecordedUserMessage(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.hasRecordedUserMessage === "function") {
        return liveRelay.hasRecordedUserMessage(sessionKey);
      }

      return false;
    },
    isNeuralSessionNamesEnabled(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.isNeuralSessionNamesEnabled === "function") {
        return liveRelay.isNeuralSessionNamesEnabled(sessionKey);
      }
      return true;
    },
    isSessionUserLocked(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.isSessionUserLocked === "function") {
        return liveRelay.isSessionUserLocked(sessionKey);
      }
      return false;
    },
    getDisplayStartStates(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getDisplayStartStates === "function") {
        return liveRelay.getDisplayStartStates(sessionKey);
      }
      return { emoji: false, pace: false };
    },
    getDisplayCurrentStates(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getDisplayCurrentStates === "function") {
        return liveRelay.getDisplayCurrentStates(sessionKey);
      }
      return { emoji: false, pace: false };
    },
    consumePromptTurnOwnership(sessionKey     , identity      = null) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.consumePromptTurnOwnership === "function") {
        return liveRelay.consumePromptTurnOwnership(sessionKey, identity);
      }
      return null;
    },

    getSessionTitleRecord(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getSessionTitleRecord === "function") {
        return liveRelay.getSessionTitleRecord(sessionKey);
      }
      return null;
    },
    isEvenAiSessionKey(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.isEvenAiSessionKey === "function") {
        return liveRelay.isEvenAiSessionKey(sessionKey);
      }
      return false;
    },
    getRawMessages() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getRawMessages === "function") {
        return liveRelay.getRawMessages();
      }
      return [];
    },
    getDistillerBudget() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getDistillerBudget === "function") {
        return liveRelay.getDistillerBudget();
      }
      return null;
    },
    isFirstUseAttemptOpen() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.isFirstUseAttemptOpen === "function") {
        return liveRelay.isFirstUseAttemptOpen();
      }
      return false;
    },
    deleteDistillerSession(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.deleteDistillerSession === "function") {
        return liveRelay.deleteDistillerSession(sessionKey);
      }
      return Promise.resolve(null);
    },
    getStateDir() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getStateDir === "function") {
        return liveRelay.getStateDir();
      }
      return opts.stateDir;
    },
    emitDebug(...args) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.emitDebug === "function") {
        return liveRelay.emitDebug(...args);
      }
      return undefined;
    },
    gatewayRequest(method, params, requestOpts) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.gatewayRequest === "function") {
        return liveRelay.gatewayRequest(method, params, requestOpts);
      }
      return Promise.reject(new Error("relay_not_running"));
    },
    onGatewayEvent(eventName, listener) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.onGatewayEvent === "function") {
        return liveRelay.onGatewayEvent(eventName, listener);
      }
      return () => {};
    },
    peekSessionKey() {

      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.peekSessionKey === "function") {
        return liveRelay.peekSessionKey();
      }
      return null;
    },
    recordNeuralSessionNamesEnabled(sessionKey, enabled) {
      if (relay && typeof relay.recordNeuralSessionNamesEnabled === "function") {
        relay.recordNeuralSessionNamesEnabled(sessionKey, enabled);
      }
    },
    setSessionTitle(sessionKey, title, opts) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.setSessionTitle === "function") {
        return liveRelay.setSessionTitle(sessionKey, title, opts);
      }
      return { ok: false, code: "relay_not_running" };
    },
    hasConnectedAppClient() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.hasConnectedAppClient === "function") {
        return liveRelay.hasConnectedAppClient();
      }
      return false;
    },

    getAppViewedSessionKeys() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getAppViewedSessionKeys === "function") {
        return liveRelay.getAppViewedSessionKeys();
      }
      return null;
    },
    getConnectedAppClientVersion() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.getConnectedAppClientVersion === "function") {
        return liveRelay.getConnectedAppClientVersion();
      }
      return null;
    },

    getHostModelInput(provider     , modelId     ) {
      const liveRelay = resolveLiveRelay();
      const live = liveRelay && typeof liveRelay.getHostModelInput === "function"
        ? liveRelay.getHostModelInput(provider, modelId) : null;
      return Array.isArray(live) ? live : bundledModelInput(provider, modelId);
    },

    hasCardStudioClient(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.hasCardStudioClient === "function") {
        return liveRelay.hasCardStudioClient(sessionKey) === true;
      }
      return false;
    },

    programCardKitLevel() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.programCardKitLevel === "function") {
        const level = liveRelay.programCardKitLevel();
        return Number.isSafeInteger(level) && level >= 1 ? level : null;
      }
      return null;
    },
    hasConnectedAppClientCapability(capability     ) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.hasConnectedAppClientCapability === "function") {
        return liveRelay.hasConnectedAppClientCapability(capability);
      }
      return false;
    },

    programCardClientAwayMs() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.programCardClientAwayMs === "function") {
        return liveRelay.programCardClientAwayMs();
      }
      return null;
    },

    isAgentBootstrapPending() {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.isAgentBootstrapPending === "function") {
        return liveRelay.isAgentBootstrapPending() === true;
      }
      return false;
    },

    presentTaskConfirm(request     ) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.presentTaskConfirm !== "function") return { presented: false, reason: "unavailable" };
      const active = typeof liveRelay.getConnectedAppActiveSessionKey === "function"
        ? liveRelay.getConnectedAppActiveSessionKey() : null;
      const sessionKey = typeof active === "string" && active
        ? active
        : request && typeof request.sessionKey === "string" ? request.sessionKey : null;
      return liveRelay.presentTaskConfirm({ ...request, sessionKey });
    },
    isGlassesSendBufferOverHighWater() {

      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.isGlassesSendBufferOverHighWater === "function") {
        return liveRelay.isGlassesSendBufferOverHighWater();
      }
      return false;
    },

    dispatchGlassesWake(params) {
      const liveRelay = resolveLiveRelay();
      if (!liveRelay || typeof liveRelay.dispatchGlassesWake !== "function") {

        return Promise.reject(new Error("ocuclaw relay not started"));
      }
      return liveRelay.dispatchGlassesWake(params);
    },
    isAgentTurnBusy(sessionKey) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.isAgentTurnBusy === "function") {
        return liveRelay.isAgentTurnBusy(sessionKey);
      }

      return null;
    },

    currentAgentRunId(sessionKey     ) {
      const liveRelay = resolveLiveRelay();
      if (liveRelay && typeof liveRelay.currentAgentRunId === "function") {
        return liveRelay.currentAgentRunId(sessionKey);
      }
      return { runId: null, active: false, atMs: null };
    },
    start,
    stop,
  };
}

module.exports = { createOcuClawRelayService };
