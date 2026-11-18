const { createHermesControlLink, LINK_EXIT_CODES, LINK_HANDSHAKE_TIMEOUT_MS } = require("./hermes-control-link.cjs");
const { createHermesGatewayBridge, LINK_BACKEND_EVENT_METHOD, LINK_PROFILE_METHODS } = require("./hermes-gateway-bridge.cjs");
const { createHermesHostHooks, LINK_HOST_HOOK_METHOD } = require("./hermes-host-hooks.cjs");
const { buildHermesLiveUiHelloPayload, createHermesLiveUiBridge, mergeLiveConfig } = require("./hermes-liveui-bridge.cjs");

const { buildHermesPhoneToolsHelloPayload, createHermesPhoneToolsBridge } = require("./hermes-phone-tools-bridge.cjs");
const { createHermesPresencePush } = require("./hermes-presence-push.cjs");
const { LINK_TASK_USES_CHECK_METHOD, answerHermesTaskUsesCheck } = require("./hermes-task-uses-check.cjs");
const { LINK_TASK_RUN_PROMPT_METHOD } = require("../domain/task-run-prompt.cjs");
const { LINK_TASK_RUN_ANSWER_METHOD, splitAlertState } = require("../domain/task-alert-state.cjs");
const { LINK_TASK_TEST_RESULT_METHOD } = require("../tools/glasses-ui-task-test.cjs");
const { hermesAuxCallDebugData } = require("./hermes-aux-usage.cjs");

const { createHermesSetupHint, LINK_SETUP_HINT_METHOD } = require("./hermes-setup-hint.cjs");
const { createHermesSttLane } = require("./hermes-stt-lane.cjs");
const { createHermesPairingCompletionPush } = require("./hermes-pairing-completion-push.cjs");
const { createHermesBoardMoments } = require("./hermes-board-moments.cjs");
const { createHermesTaskPush } = require("./hermes-task-push.cjs");
const { LINK_TASK_ROWS_CHANGED_METHOD, createHermesTaskRows, createTaskRowsBroadcast, noteHermesHeldRun, taskPopupUntilMs, withoutHeldAnswers } = require("./hermes-task-rows.cjs");
const { taskRunHeld } = require("../domain/task-run-facts.cjs");
const { readRecentTaskResultHistory } = require("./hermes-task-page.cjs");
const { answerTaskSheetRequest } = require("./hermes-task-sheet.cjs");
const { createHermesReplyDeliveryLink } = require("./hermes-reply-delivery-link.cjs");
const { createHermesRuntimeReadiness } = require("./hermes-runtime-readiness.cjs");
const { DEFAULT_HERMES_NAMESPACE, hermesDefaultSessionKeyPrefix, hermesSupportedSessionKeyPrefixes, parseHermesPublicKey } = require("./hermes-session-keys.cjs");
const { createRelay } = require("./relay-core.cjs");
const { createCloudwaysSupervisor } = require("../setup/cloudways-supervisor.cjs");
const { botScreenFromHello } = require("../tools/bot-screen/bot-screen-source.cjs");
const { savedTaskStarterCard } = require("../tools/card-starters.cjs");
const { feedCardFromScheduledResult } = require("../tools/glasses-ui-program-card-feed.cjs");
const { HERMES_BUNDLE_DEFAULT_WS_PORT, resolveLiveuiJev, resolveLiveuiV2, resolveBotScreenJev, resolveProgramCardsJev, resolveProgramCardsMcp } = require("../config/runtime-config.cjs");
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
  "link.echo": (params     ) => (params === undefined ? null : params),
  [LINK_BACKEND_EVENT_METHOD]: (_params     ) => null,
  [LINK_HOST_HOOK_METHOD]: (_params     ) => null,
  "slash.confirm.present": (_params     ) => ({
    presented: false,
    reason: "relay_unavailable",
  }),
  [LINK_SETUP_HINT_METHOD]: (_params     ) => ({ phase: null }),

  "stt.stream.partial": (_params     ) => null,

  "aux.call": (_params     ) => null,
};

const link = createHermesControlLink({
  input: process.stdin,
  output: process.stdout,
  logger,
  emitDebug,
  methods: linkMethods,
  hello: {

    liveui: buildHermesLiveUiHelloPayload({
      glassesUiSchema: process.env.OCUCLAW_GLASSES_UI_SCHEMA,
      liveuiTemplatesSchema: process.env.OCUCLAW_LIVEUI_TEMPLATES_SCHEMA,
    }),
    phoneTools: buildHermesPhoneToolsHelloPayload(),
  },
});

const { bridge: gatewayBridge, dispatchBackendEvent } =
  createHermesGatewayBridge({ link, logger });
const hostHooks = createHermesHostHooks({ logger });

const sttLane = createHermesSttLane({ link, logger });
const readiness = createHermesRuntimeReadiness({ dispatchBackendEvent, logger });
let activeRelay      = null;

const setupHint = createHermesSetupHint({ getRelay: () => activeRelay, logger });
Object.assign(linkMethods, setupHint.methods);
Object.assign(linkMethods, { "program_cards.switches.apply": (params     ) => {
  if (!activeRelay) throw new Error("relay_unavailable");
  return activeRelay.applyProgramCardSwitches(params);
}, "liveui.jev.apply": (params     ) => {

  if (!activeRelay) throw new Error("relay_unavailable");
  return activeRelay.applyLiveuiJev(params);
}, "program_cards.tools.facts": (params     ) => {

  if (!activeRelay) throw new Error("relay_unavailable");
  return activeRelay.programCardToolsFacts({ servers: !!params && params.servers === true });
} });
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

linkMethods["aux.call"] = (params     ) => {
  const relay = activeRelay;
  if (relay && params && (params.phase === "pre" || params.phase === "post")) {
    relay.emitDebug("token.aux", params.phase === "pre" ? "aux_call_start" : "aux_call_end", "debug", {},
      () => hermesAuxCallDebugData(params));
  }
  return null;
};
linkMethods["slash.confirm.present"] = (params     ) => {
  if (!activeRelay || typeof activeRelay.presentHermesSlashConfirm !== "function") {
    return { presented: false, reason: "relay_unavailable" };
  }
  return activeRelay.presentHermesSlashConfirm(params || {});
};

linkMethods["stt.stream.partial"] = (params     ) => {
  try {
    if (params && typeof params.streamId === "string" && typeof params.text === "string") {
      sttLane.upload.partial(params.streamId, params.text);
    }
  } catch (_) {

  }
  return null;
};

void hostHooks;

link.onClose(() => {
  logger.info("[hermes-link] control link closed; exiting");

  readiness.announceDisconnected("link_closed");
  activeRelay?.stopLiveuiExecutorRegistry();
  void sttLane.upload.dispose().finally(() => process.exit(LINK_EXIT_CODES.clean));
});

process.on("SIGTERM", () => {
  logger.info("[hermes-link] SIGTERM; exiting");
  readiness.announceDisconnected("sigterm");
  activeRelay?.stopLiveuiExecutorRegistry();
  void sttLane.upload.dispose().finally(() => process.exit(LINK_EXIT_CODES.clean));
});
process.on("SIGINT", () => {
  activeRelay?.stopLiveuiExecutorRegistry();
  void sttLane.upload.dispose().finally(() => process.exit(LINK_EXIT_CODES.clean));
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
  let relay;
  const profileNamespace = (context      = {}) => {
    const parsed = parseHermesPublicKey(
      typeof context.sessionKey === "string" ? context.sessionKey : "",
    );
    return parsed ? parsed.namespace : DEFAULT_HERMES_NAMESPACE;
  };
  const getHermesProfileOptions = (context      = {}) =>
    link.request(LINK_PROFILE_METHODS.optionsGet, {
      ns: profileNamespace(context),
    });
  const setHermesProfileOptions = (patch      = {}, context      = {}) => {
    const options      = {};
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

    if (patch.liveReasoning === true) {
      options.live_reasoning = true;
    }
    return link.request(LINK_PROFILE_METHODS.optionsApply, {
      ns: profileNamespace(context),
      options,
    });
  };

  let boardMoments      = null;

  let taskPush      = null;

  let taskRows      = null;

  let taskSheetLiveui      = null;

  let taskRowsBroadcast      = null;

  const heldAnswers = new Map                ();
  relay = createRelay({

    onTaskRowsChanged: () => {
      if (taskRowsBroadcast) taskRowsBroadcast.ring();
    },

    failStartOnBindConflict: true,
    onBoardMomentAck: (ack     ) => {
      if (boardMoments) boardMoments.ack(ack);
    },
    onTaskPushAck: (ack     ) => {
      if (taskPush) taskPush.ack(ack);
    },
    onTaskPushClientReady: (clientId     ) => {
      if (taskPush) taskPush.clientReady(clientId);
    },

    onGetTaskRows: () => (taskRows ? taskRows.read() : null),

    onSetTaskLook: (choice     ) => (taskRows ? taskRows.useLook(choice) : null),

    onActTaskReminder: (choice     ) => (taskRows ? taskRows.actOnReminder(choice) : null),

    onTaskSheet: (request     ) => answerTaskSheetRequest(taskSheetLiveui ? taskSheetLiveui.handler : null, request, {
      recentResults: async (jobId     ) => withoutHeldAnswers(await readRecentTaskResultHistory(link, jobId, logger), heldAnswers),

      starterCard: savedTaskStarterCard,
    }),
    optionalSetupCommandsVersion: 1,
    optionalSetupEvenAiCommands: true,
      port,
      host,
      token: typeof config.relayToken === "string" ? config.relayToken : "",

      config: {
        sonioxApiKey:
          typeof config.sonioxApiKey === "string" ? config.sonioxApiKey : "",
      },

      liveuiJev: resolveLiveuiJev(config.liveuiJev, {}, {}),

      typesafeApiKey: typeof config.typesafeApiKey === "string" ? config.typesafeApiKey : "",

      liveuiV2: resolveLiveuiV2(config.liveuiV2),

      phoneAddress: typeof config.phoneAddress === "string" ? config.phoneAddress : null,
      stateDir:
        typeof config.stateDir === "string" && config.stateDir
          ? config.stateDir
          : undefined,
      gatewayBridge,
      resolveHermesSlashConfirm: (params     ) =>
        link.request("slash.confirm.resolve", params || {}),

      getConnectionHealthDocument: () =>
        link.request("connectionHealth.snapshot", {}),

      cardStudioTasks: {
        rows: () => (taskRows ? taskRows.read() : []),
        output: (params     ) => link.request("taskOutput.snapshot", params || {}),
      },

      getHermesSttCapabilities: () => sttLane.getCapabilities(),

      hermesSttTranscribe: (request     ) => sttLane.transcribe(request),
      hermesSttUpload: sttLane.upload,

      getSetupHintPhase: setupHint.getPhase,
      hermesVersion:
        ackPayload && typeof ackPayload.hermesVersion === "string"
          ? ackPayload.hermesVersion
          : null,
      hermesSessionOptionsSupported:
        config.sessionOptionsSupported === true,

      botScreen: botScreenFromHello(config),
      botScreenProfileRouting: config.botScreenProfileRouting === true,
      botScreenRequest: (method        , params     ) => link.request(method, params),

      botScreenJev: resolveBotScreenJev(config.botScreenJev, {}, {}, config),
      getOcuClawProfileOptions: getHermesProfileOptions,
      setOcuClawProfileOptions: setHermesProfileOptions,
      externalDebugToolsEnabled:
        config.externalDebugToolsEnabled !== false,
      debugAutoArm: config.debugAutoArm === true,
      getGlassesUiLiveConfig: () => mergeLiveConfig(config && config.glassesUiLive),
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
      inputPredictionTimeoutMs: config.inputPredictionTimeoutMs,

      programCardsJev: resolveProgramCardsJev(config.programCardsJev, {}, {}, config),

      programCardsMcp: resolveProgramCardsMcp(config.programCardsMcp),
      programCardsModel: resolveProgramCardsMcp(config.programCardsModel),
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
      logger,
  });
  activeRelay = relay;

  link.setDebugEmitter((category     , event     , data     ) => {
    emitDebug(category, event, data);
    relay.emitDebug(category, event, "debug", {}, () => data || {});
  });
  return Promise.resolve(relay.start())
    .then(() => {
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

      if (typeof relay.setTaskJobRunner === "function") relay.setTaskJobRunner(liveui.handler);
      Object.assign(linkMethods, liveui.methods);

      Object.assign(linkMethods, {
        [LINK_TASK_USES_CHECK_METHOD]: (params     ) => answerHermesTaskUsesCheck(relay, params),

        [LINK_TASK_RUN_PROMPT_METHOD]: (params     ) => {
          const jobId = params && typeof params.jobId === "string" ? params.jobId : null;
          const schedules = typeof liveui.handler?.listTaskSchedules === "function" ? liveui.handler.listTaskSchedules() : [];
          const context = jobId && typeof relay.taskRunPrompt === "function" ? relay.taskRunPrompt(jobId, schedules) : null;
          return { context: typeof context === "string" ? context : null };
        },

        [LINK_TASK_RUN_ANSWER_METHOD]: (params     ) => {
          const jobId = params && typeof params.jobId === "string" ? params.jobId : null;
          if (!jobId || typeof params.text !== "string" || typeof params.silent !== "boolean" ||
            typeof relay.taskAlertRunEnd !== "function") return { verdict: null };
          const schedules = typeof liveui.handler?.listTaskSchedules === "function" ? liveui.handler.listTaskSchedules() : [];
          const verdict = relay.taskAlertRunEnd(jobId, { state: splitAlertState(params.text).state, silent: params.silent }, schedules);
          return { verdict: typeof verdict === "string" ? verdict : null };
        },

        [LINK_TASK_TEST_RESULT_METHOD]: (params     ) => relay.onTaskTestResult(params),
      });

      const phoneTools = createHermesPhoneToolsBridge({
        relay,
        hostHooks,
        logger,
        getEvenAiDedicatedSessionKey: () =>
          typeof config.evenAiDedicatedSessionKey === "string"
            ? config.evenAiDedicatedSessionKey
            : "",
      });
      Object.assign(linkMethods, phoneTools.methods);

      hostHooks.on("agent_end", (_event     , ctx     ) => {
        if (typeof relay.noteSessionMirrorTurnEnd !== "function") return;
        Promise.resolve(relay.noteSessionMirrorTurnEnd(ctx && ctx.sessionKey)).catch(() => {});
      });

      const presence = createHermesPresencePush({ relay, link, logger });
      Object.assign(linkMethods, presence.methods);
      presence.push();
      createHermesPairingCompletionPush({ relay, link, logger });

      boardMoments = createHermesBoardMoments({ relay, link, logger });
      Object.assign(linkMethods, boardMoments.methods);

      const runToolFailures = new Map               ();

      const heldRuns = new Map                ();
      const takeRunToolFailures = (result     ) => {
        if (typeof relay.taskToolFailuresOfJob !== "function" || typeof result?.resultId !== "string") return;
        try {

          const ran = typeof relay.taskToolsRanOfJob === "function" ? relay.taskToolsRanOfJob(result.jobId) : null;
          const failures = relay.taskToolFailuresOfJob(result.jobId, result.createdAtMs);
          if (!Array.isArray(failures) || !failures.length) return;

          if (result.status === "ok" && ran === false && taskRunHeld(failures)) {
            noteHermesHeldRun(heldAnswers, result.resultId, result.createdAtMs);
            logger?.info?.(`[hermes-task-push] held answer job=${result.jobId} leftOut=${failures.length}`);
          }

          if (taskRunHeld(failures) && noteHermesHeldRun(heldRuns, result.jobId, result.createdAtMs)) taskRowsBroadcast?.ring();
          runToolFailures.set(result.resultId, failures);
          while (runToolFailures.size > 32) runToolFailures.delete(runToolFailures.keys().next().value          );
        } catch (_) {  }
      };
      taskPush = createHermesTaskPush({
        relay,
        link,
        logger,
        isQuiet: (taskId     ) =>
          !!liveui.handler && typeof liveui.handler.isTaskScheduleQuiet === "function" &&
          liveui.handler.isTaskScheduleQuiet(taskId) === true,

        isHeld: (result     ) => heldAnswers.has(result?.resultId),

        isRepeat: (result     ) => typeof relay.taskAlertRepeat === "function" && relay.taskAlertRepeat(result,
          liveui.handler && typeof liveui.handler.listTaskSchedules === "function" ? liveui.handler.listTaskSchedules() : []) === true,

        taskFor: (result     ) =>
          liveui.handler && typeof liveui.handler.taskForTaskResult === "function"
            ? liveui.handler.taskForTaskResult(result)
            : null,
        popupUntilFor: (result     ) => taskPopupUntilMs(result,
          liveui.handler && typeof liveui.handler.listTaskSchedules === "function"
            ? liveui.handler.listTaskSchedules() : []),

        onResult: (result     ) => {

          takeRunToolFailures(result);
          return typeof relay.taskRunsWeekResult === "function" ? relay.taskRunsWeekResult(result) : null;
        },

        onResultCard: (pushed     ) => {

          const toolFailures = runToolFailures.get(pushed?.id) || null;
          runToolFailures.delete(pushed?.id);
          const result = toolFailures ? { ...pushed, toolFailures } : pushed;

          feedCardFromScheduledResult({
            result,
            taskFor: (r     ) => liveui.handler && typeof liveui.handler.taskForTaskResult === "function"
              ? liveui.handler.taskForTaskResult(r)
              : null,
            deliver: typeof relay.deliverProgramCardTaskResult === "function"
              ? (params     ) => relay.deliverProgramCardTaskResult(params)
              : null,
            logger,
          });
          if (!liveui.handler || typeof liveui.handler.onTaskResultDelivered !== "function") return null;
          const kept      = liveui.handler.onTaskResultDelivered(result);
          return kept && kept.status === "written" && typeof kept.templateId === "string" ? kept.templateId : null;
        },
      });
      Object.assign(linkMethods, taskPush.methods);
      taskRows = createHermesTaskRows({
        link,
        logger,
        schedules: () =>
          liveui.handler && typeof liveui.handler.listTaskSchedules === "function"
            ? liveui.handler.listTaskSchedules()
            : [],

        setLook: (taskId     , look     ) =>
          liveui.handler && typeof liveui.handler.setTaskLook === "function"
            ? liveui.handler.setTaskLook(taskId, look)
            : null,

        cardRuns: () => (typeof relay.taskCardRuns === "function" ? relay.taskCardRuns() : null),

        uncheckedRuns: () => (typeof relay.taskUncheckedRuns === "function" ? relay.taskUncheckedRuns() : null),

        leftOut: (taskId        ) => (typeof relay.taskLeftOut === "function" ? relay.taskLeftOut(taskId) : 0),

        heldRuns: () => Object.fromEntries(heldRuns),

        heldAnswers: () => Object.fromEntries(heldAnswers),

        onJobRuns: (list     ) => (typeof relay.taskRunsWeekJobRuns === "function" ? relay.taskRunsWeekJobRuns(list) : null),
      });

      taskRowsBroadcast = createTaskRowsBroadcast({
        read: () => taskRows.read(),
        send: (frame     ) => (typeof relay.sendTaskRowsFrame === "function" ? relay.sendTaskRowsFrame(frame) : 0),
        logger,
      });
      Object.assign(linkMethods, {
        [LINK_TASK_ROWS_CHANGED_METHOD]: () => {
          taskRowsBroadcast.ring();
          return { ok: true };
        },
      });
      taskSheetLiveui = liveui;

      Object.assign(linkMethods, createHermesReplyDeliveryLink({ relay, link, logger }).methods);
      startCloudwaysSupervisor();
      return relay;
    });
}

function startCloudwaysSupervisor() {
  try {
    const supervisor = createCloudwaysSupervisor({ logger, layoutOptions: { bundle: "hermes" } });
    Promise.resolve(supervisor.start()).catch((err     ) => {
      logger.warn(`[ocuclaw] cloudways supervisor start failed: ${err && err.message ? err.message : err}`);
    });
  } catch (err     ) {
    logger.warn(`[ocuclaw] cloudways supervisor unavailable: ${err && err.message ? err.message : err}`);
  }
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
