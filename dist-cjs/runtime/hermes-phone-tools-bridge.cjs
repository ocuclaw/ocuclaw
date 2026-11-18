const { PROGRAM_CARD_DRAFT_TOOL, PROGRAM_CARD_DRAFT_DESCRIPTION, programCardDraftParametersSchema } = require("../tools/program-card-drafts.cjs");

const { createDeviceInfoToolHandler, DEFAULT_DEVICE_INFO_TIMEOUT_MS, DEVICE_INFO_TOOL_DESCRIPTION, deviceInfoParametersSchema } = require("../tools/device-info-tool.cjs");
const { DEFAULT_GET_SETTINGS_TIMEOUT_MS, DEFAULT_SET_SETTING_TIMEOUT_MS, GET_SETTINGS_TOOL_DESCRIPTION, GET_SETTINGS_TOOL_NAME, SET_SETTING_TOOL_DESCRIPTION, SET_SETTING_TOOL_NAME, getSettingsParametersSchema, runGetSettingsTool, runSetSettingTool, setSettingParametersSchema } = require("../tools/phone-settings-tool.cjs");
const { DEFAULT_SHOW_BOT_SCREEN_TIMEOUT_MS, SHOW_BOT_SCREEN_TOOL_DESCRIPTION, SHOW_BOT_SCREEN_TOOL_NAME, runShowBotScreenTool, showBotScreenParametersSchema } = require("../tools/bot-screen/show-bot-screen-tool.cjs");
const { createLocationToolHandler, DEFAULT_LOCATION_TIMEOUT_MS, LOCATION_TOOL_DESCRIPTION, locationParametersSchema } = require("../tools/location-tool.cjs");
const { createSessionTitleToolHandler, sessionTitleParametersSchema, TOOL_DESCRIPTION: SESSION_TITLE_TOOL_DESCRIPTION } = require("../tools/session-title-tool.cjs");
const { createProgramCardToolHandler, DEFAULT_PROGRAM_CARD_TIMEOUT_MS, PROGRAM_CARD_CLIENT_RETURN_LINK_MS, PROGRAM_CARD_FIRST_LOOK_OPEN_WAIT_MS, EDIT_GLASSES_CARD_TOOL_DESCRIPTION, EDIT_GLASSES_CARD_TOOL_NAME, editGlassesCardParametersSchema, GLASSES_CARD_COMMAND_TOOL_DESCRIPTION, GLASSES_CARD_COMMAND_TOOL_NAME, glassesCardCommandParametersSchema, LOOK_GLASSES_CARD_TOOL_NAME, lookGlassesCardParametersSchema, PROGRAM_CARD_CAPABILITY, programCardParametersSchema, WRITE_GLASSES_CARD_TOOL_DESCRIPTION, WRITE_GLASSES_CARD_TOOL_NAME } = require("../tools/program-card-tool.cjs");
const { PROGRAM_CARD_LOOK_CAPABILITY, PROGRAM_CARD_LOOK_CASES_CAPABILITY, PROGRAM_CARD_LOOK_CASES_HOST_MS, PROGRAM_CARD_LOOK_PLAY_CAPABILITY, PROGRAM_CARD_LOOK_PLAY_RUN_CAPABILITY, PROGRAM_CARD_LOOK_TIMEOUT_MS, PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS, PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY, lookResultForModel, lookToolImageContent } = require("../tools/program-card-look.cjs");
const { PROGRAM_CARD_FRAME_DRAW_CAPABILITY, PROGRAM_CARD_FRAME_IDEA_CAPABILITY } = require("../tools/program-card-frame-lane.cjs");
const { PROGRAM_CARD_FEED_LIMITS } = require("../tools/glasses-ui-program-card-feeds.cjs");
const { PROGRAM_CARD_LOCATION_LIMITS, PROGRAM_CARD_LOCATION_SETTLE } = require("../tools/glasses-ui-program-card-location.cjs");
const { PROGRAM_CARD_LOOK_DRIVE_CAPABILITY, PROGRAM_CARD_LOOK_DRIVE_GUIDE, PROGRAM_CARD_LOOK_DRIVE_HOST_TIMEOUT_MS } = require("../tools/program-card-look-drive.cjs");
const { LINK_MAX_LINE_BYTES } = require("./hermes-control-link.cjs");
const { PROGRAM_CARD_LOOK_GUIDE, PROGRAM_CARD_PICTURES_CAPABILITY, PROGRAM_CARD_SPRITES_CAPABILITY, PROGRAM_CARD_TEST_PLAYER_CAPABILITY, programCardYesGuides } = require("../tools/program-card-guide.cjs");
const { createOpenCardStore } = require("../tools/program-card-context.cjs");
const { PROGRAM_CARD_JEV_LIMITS } = require("../tools/glasses-ui-program-card-jev.cjs");
const { PROGRAM_CARD_MCP_LIMITS } = require("../tools/glasses-ui-program-card-mcp.cjs");
const { createRequestCardMcpWriteHandler, REQUEST_CARD_MCP_WRITE_TOOL_DESCRIPTION, REQUEST_CARD_MCP_WRITE_TOOL_NAME, requestCardMcpWriteParametersSchema } = require("../tools/program-card-mcp-writes.cjs");
const { createRequestHostCommandHandler, HOST_COMMAND_LIMITS, REQUEST_HOST_COMMAND_TOOL_DESCRIPTION, REQUEST_HOST_COMMAND_TOOL_NAME, requestHostCommandParametersSchema } = require("../tools/program-card-host-commands.cjs");
const { createRequestCardSetupHandler, PROGRAM_CARD_SETUP_LIMITS, REQUEST_CARD_SETUP_TOOL_DESCRIPTION, REQUEST_CARD_SETUP_TOOL_NAME, requestCardSetupParametersSchema } = require("../tools/program-card-setup-requests.cjs");
const { createSaveGlassesCardHandler, SAVE_GLASSES_CARD_TOOL_DESCRIPTION, SAVE_GLASSES_CARD_TOOL_NAME, saveGlassesCardParametersSchema } = require("../tools/save-glasses-card-tool.cjs");
const { PROGRAM_CARD_SAVE_REQUEST_TIMEOUT_MS } = require("../tools/program-card-saves.cjs");
const { ASK_CARD_TOOL_DESCRIPTION, ASK_CARD_TOOL_NAME, CARD_ASK_LONGEST_MS, CARD_ASK_TIMEOUT_MS, askCardParametersSchema, cardAskGame, cardAskGate, cardAskPlan, createCardAskHandler, spendCardAsk } = require("../tools/program-card-ask-tool.cjs");
const { isEvenAiAgentSession } = require("../tools/glasses-ui-tool.cjs");
const { cardStudioRecordingMethod } = require("../tools/card-studio-record.cjs");
const { normalizeHermesLiveUiSessionKey } = require("./hermes-liveui-bridge.cjs");
const { isForeignHermesSessionKey, parseHermesPublicKey } = require("./hermes-session-keys.cjs");

const PHONE_TOOL_TOOLSET = "ocuclaw";

const PHONE_TOOL_DEFAULT_LINK_TIMEOUT_MS = 15000;

const LOCATION_PHONE_TOOL_NAME = "get_current_location";

const DEVICE_INFO_PHONE_TOOL_NAME = "get_evenrealities_device_info";

const LINK_PHONE_TOOL_METHODS = Object.freeze({
  getCurrentLocation: "tools.getCurrentLocation",
  getDeviceInfo: "tools.getDeviceInfo",
  setSessionTitle: "tools.setSessionTitle",
  writeGlassesCard: "tools.writeGlassesCard",
  saveGlassesCard: "tools.saveGlassesCard",
  askGlassesCard: "tools.askGlassesCard",
  glassesCardCommand: "tools.glassesCardCommand",
  editGlassesCard: "tools.editGlassesCard",
  lookGlassesCard: "tools.lookGlassesCard",
  glassesCardDraft: "tools.glassesCardDraft",
  requestCardMcpWrite: "tools.requestCardMcpWrite",
  requestHostCommand: "tools.requestHostCommand",
  requestCardSetup: "tools.requestCardSetup",
  getPhoneSettings: "tools.getPhoneSettings",
  setPhoneSetting: "tools.setPhoneSetting",
  showBotScreen: "tools.showBotScreen",
});

function buildHermesPhoneToolDescriptor(
  name     ,
  description     ,
  parameters     ,
  method     ,
  opts     ,
) {
  const options = opts && typeof opts === "object" ? opts : {};
  const descriptor      = {
    name,
    toolset: PHONE_TOOL_TOOLSET,
    description,
    schema: { name, description, parameters },
    method,
  };
  const linkTimeoutMs = options.linkTimeoutMs;
  if (typeof linkTimeoutMs === "number" && Number.isFinite(linkTimeoutMs) && linkTimeoutMs > 0) {
    descriptor.linkTimeoutMs = linkTimeoutMs;
  }
  return descriptor;
}

function buildLocationDescriptor() {
  return buildHermesPhoneToolDescriptor(
    LOCATION_PHONE_TOOL_NAME,
    LOCATION_TOOL_DESCRIPTION,
    locationParametersSchema,
    LINK_PHONE_TOOL_METHODS.getCurrentLocation,
    { linkTimeoutMs: DEFAULT_LOCATION_TIMEOUT_MS },
  );
}

function buildDeviceInfoDescriptor() {
  return buildHermesPhoneToolDescriptor(
    DEVICE_INFO_PHONE_TOOL_NAME,
    DEVICE_INFO_TOOL_DESCRIPTION,
    deviceInfoParametersSchema,
    LINK_PHONE_TOOL_METHODS.getDeviceInfo,
    { linkTimeoutMs: DEFAULT_DEVICE_INFO_TIMEOUT_MS },
  );
}

const SESSION_TITLE_PHONE_TOOL_NAME = "set_session_title";

function buildSessionTitleDescriptor() {
  return buildHermesPhoneToolDescriptor(
    SESSION_TITLE_PHONE_TOOL_NAME,
    SESSION_TITLE_TOOL_DESCRIPTION,
    sessionTitleParametersSchema,
    LINK_PHONE_TOOL_METHODS.setSessionTitle,
    {},
  );
}

const PROGRAM_CARD_WITH_REQUESTS_LINK_TIMEOUT_MS =
  DEFAULT_PROGRAM_CARD_TIMEOUT_MS +
  PROGRAM_CARD_JEV_LIMITS.requestWaitMs +
  PROGRAM_CARD_JEV_LIMITS.requestGraceMs +
  PROGRAM_CARD_MCP_LIMITS.listTimeoutMs +
  PROGRAM_CARD_MCP_LIMITS.requestWaitMs +
  PROGRAM_CARD_MCP_LIMITS.requestGraceMs;

const PROGRAM_CARD_SITES_SETTLE_LONGEST_MS =
  PROGRAM_CARD_LOCATION_SETTLE.arriveMs + PROGRAM_CARD_LOCATION_SETTLE.answerMs + PROGRAM_CARD_LOCATION_SETTLE.returnMs +
  PROGRAM_CARD_FEED_LIMITS.settleSubscribeWaitMs +
  PROGRAM_CARD_FEED_LIMITS.settleAsksMax * PROGRAM_CARD_LOCATION_LIMITS.consentMs +
  PROGRAM_CARD_FEED_LIMITS.settleReturnWaitMs + PROGRAM_CARD_FEED_LIMITS.settleDataWaitMs;

function buildProgramCardDescriptor() {
  return buildHermesPhoneToolDescriptor(
    WRITE_GLASSES_CARD_TOOL_NAME,
    WRITE_GLASSES_CARD_TOOL_DESCRIPTION,
    programCardParametersSchema,
    LINK_PHONE_TOOL_METHODS.writeGlassesCard,
    { linkTimeoutMs: PROGRAM_CARD_WITH_REQUESTS_LINK_TIMEOUT_MS + DEFAULT_PROGRAM_CARD_TIMEOUT_MS +

      PROGRAM_CARD_FIRST_LOOK_OPEN_WAIT_MS + PROGRAM_CARD_LOOK_TIMEOUT_MS + PROGRAM_CARD_LOOK_CASES_HOST_MS +

      PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS +

      PROGRAM_CARD_CLIENT_RETURN_LINK_MS +

      PROGRAM_CARD_SITES_SETTLE_LONGEST_MS },
  );
}

function buildSaveGlassesCardDescriptor() {
  return buildHermesPhoneToolDescriptor(
    SAVE_GLASSES_CARD_TOOL_NAME,
    SAVE_GLASSES_CARD_TOOL_DESCRIPTION,
    saveGlassesCardParametersSchema,
    LINK_PHONE_TOOL_METHODS.saveGlassesCard,
    { linkTimeoutMs: PROGRAM_CARD_SAVE_REQUEST_TIMEOUT_MS },
  );
}

function buildAskGlassesCardDescriptor() {
  return buildHermesPhoneToolDescriptor(
    ASK_CARD_TOOL_NAME,
    ASK_CARD_TOOL_DESCRIPTION,
    askCardParametersSchema,
    LINK_PHONE_TOOL_METHODS.askGlassesCard,
    { linkTimeoutMs: CARD_ASK_LONGEST_MS },
  );
}

function buildGlassesCardCommandDescriptor() {
  return buildHermesPhoneToolDescriptor(
    GLASSES_CARD_COMMAND_TOOL_NAME,
    GLASSES_CARD_COMMAND_TOOL_DESCRIPTION,
    glassesCardCommandParametersSchema,
    LINK_PHONE_TOOL_METHODS.glassesCardCommand,
    { linkTimeoutMs: PROGRAM_CARD_LOOK_TIMEOUT_MS + PROGRAM_CARD_CLIENT_RETURN_LINK_MS },
  );
}

function buildEditGlassesCardDescriptor() {
  return buildHermesPhoneToolDescriptor(
    EDIT_GLASSES_CARD_TOOL_NAME,
    EDIT_GLASSES_CARD_TOOL_DESCRIPTION,
    editGlassesCardParametersSchema,
    LINK_PHONE_TOOL_METHODS.editGlassesCard,
    { linkTimeoutMs: PROGRAM_CARD_WITH_REQUESTS_LINK_TIMEOUT_MS + PROGRAM_CARD_CLIENT_RETURN_LINK_MS +
      PROGRAM_CARD_FIRST_LOOK_OPEN_WAIT_MS + PROGRAM_CARD_LOOK_TIMEOUT_MS + PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS +
      PROGRAM_CARD_SITES_SETTLE_LONGEST_MS },
  );
}

function buildLookGlassesCardDescriptor() {
  return buildHermesPhoneToolDescriptor(
    LOOK_GLASSES_CARD_TOOL_NAME,
    `Test the open card on an isolated copy. ${PROGRAM_CARD_LOOK_GUIDE}\n${PROGRAM_CARD_LOOK_DRIVE_GUIDE}`,
    lookGlassesCardParametersSchema,
    LINK_PHONE_TOOL_METHODS.lookGlassesCard,
    { linkTimeoutMs: Math.max(PROGRAM_CARD_LOOK_TIMEOUT_MS + PROGRAM_CARD_LOOK_GAME_LIVE_EXTRA_MS, PROGRAM_CARD_LOOK_DRIVE_HOST_TIMEOUT_MS) +
      5_000 + PROGRAM_CARD_CLIENT_RETURN_LINK_MS },
  );
}

function buildRequestCardMcpWriteDescriptor() {
  return buildHermesPhoneToolDescriptor(
    REQUEST_CARD_MCP_WRITE_TOOL_NAME,
    REQUEST_CARD_MCP_WRITE_TOOL_DESCRIPTION,
    requestCardMcpWriteParametersSchema,
    LINK_PHONE_TOOL_METHODS.requestCardMcpWrite,
    { linkTimeoutMs: PROGRAM_CARD_MCP_LIMITS.listTimeoutMs + PROGRAM_CARD_MCP_LIMITS.requestWaitMs + PROGRAM_CARD_MCP_LIMITS.requestGraceMs },
  );
}

function buildRequestHostCommandDescriptor() {
  return buildHermesPhoneToolDescriptor(
    REQUEST_HOST_COMMAND_TOOL_NAME,
    REQUEST_HOST_COMMAND_TOOL_DESCRIPTION,
    requestHostCommandParametersSchema,
    LINK_PHONE_TOOL_METHODS.requestHostCommand,
    { linkTimeoutMs: HOST_COMMAND_LIMITS.requestWaitMs + HOST_COMMAND_LIMITS.requestGraceMs + 5_000 },
  );
}

const REQUEST_CARD_SETUP_LINK_TIMEOUT_MS = PROGRAM_CARD_MCP_LIMITS.listTimeoutMs +
  3 * (PROGRAM_CARD_SETUP_LIMITS.requestWaitMs + 5_000) + PROGRAM_CARD_SETUP_LIMITS.saveMs;

function buildRequestCardSetupDescriptor() {
  return buildHermesPhoneToolDescriptor(
    REQUEST_CARD_SETUP_TOOL_NAME,
    REQUEST_CARD_SETUP_TOOL_DESCRIPTION,
    requestCardSetupParametersSchema,
    LINK_PHONE_TOOL_METHODS.requestCardSetup,
    { linkTimeoutMs: REQUEST_CARD_SETUP_LINK_TIMEOUT_MS },
  );
}

const PHONE_TOOL_DESCRIPTOR_BUILDERS      = Object.freeze([
  buildLocationDescriptor,
  buildDeviceInfoDescriptor,
  buildSessionTitleDescriptor,
  buildProgramCardDescriptor,
  buildSaveGlassesCardDescriptor,
  buildAskGlassesCardDescriptor,
  buildGlassesCardCommandDescriptor,
  buildEditGlassesCardDescriptor,
  buildLookGlassesCardDescriptor,
  () => buildHermesPhoneToolDescriptor(PROGRAM_CARD_DRAFT_TOOL, PROGRAM_CARD_DRAFT_DESCRIPTION,
    programCardDraftParametersSchema, LINK_PHONE_TOOL_METHODS.glassesCardDraft,
    { linkTimeoutMs: CARD_ASK_TIMEOUT_MS + PROGRAM_CARD_WITH_REQUESTS_LINK_TIMEOUT_MS }),
  buildRequestCardMcpWriteDescriptor,
  buildRequestHostCommandDescriptor,
  buildRequestCardSetupDescriptor,

  () => buildHermesPhoneToolDescriptor(GET_SETTINGS_TOOL_NAME, GET_SETTINGS_TOOL_DESCRIPTION,
    getSettingsParametersSchema, LINK_PHONE_TOOL_METHODS.getPhoneSettings,
    { linkTimeoutMs: DEFAULT_GET_SETTINGS_TIMEOUT_MS }),
  () => buildHermesPhoneToolDescriptor(SET_SETTING_TOOL_NAME, SET_SETTING_TOOL_DESCRIPTION,
    setSettingParametersSchema, LINK_PHONE_TOOL_METHODS.setPhoneSetting,
    { linkTimeoutMs: DEFAULT_SET_SETTING_TIMEOUT_MS + 5_000 }),

  () => buildHermesPhoneToolDescriptor(SHOW_BOT_SCREEN_TOOL_NAME, SHOW_BOT_SCREEN_TOOL_DESCRIPTION,
    showBotScreenParametersSchema, LINK_PHONE_TOOL_METHODS.showBotScreen,
    { linkTimeoutMs: DEFAULT_SHOW_BOT_SCREEN_TIMEOUT_MS + 5_000 }),
]);

function buildHermesPhoneToolsHelloPayload() {
  return PHONE_TOOL_DESCRIPTOR_BUILDERS.map((build     ) => build());
}

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

const HERMES_SETUP_CHAT_SESSION_KEY = "ocuclaw:setup";

function resolvePhoneToolSessionKey(rawKey     ) {
  const raw = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!raw) return { ok: false, code: "requires_hermes_session_key" };

  if (!raw.includes(":")) return { ok: false, code: "requires_hermes_session_key" };
  if (isForeignHermesSessionKey(raw)) {
    return { ok: false, code: "requires_hermes_session_key" };
  }
  const normalized = normalizeHermesLiveUiSessionKey(raw);
  if (typeof normalized !== "string" || !normalized.trim()) {
    return { ok: false, code: "requires_hermes_session_key" };
  }
  if (isForeignHermesSessionKey(normalized)) {
    return { ok: false, code: "requires_hermes_session_key" };
  }
  const parsed = parseHermesPublicKey(normalized);
  if (!parsed || parsed.kind !== "minted") {
    return { ok: false, code: "requires_hermes_session_key" };
  }
  return { ok: true, sessionKey: normalized };
}

function createHermesPhoneToolsBridge(opts      = {}) {
  const relay = opts && opts.relay;
  if (!relay) {
    throw new Error("createHermesPhoneToolsBridge requires relay");
  }
  const logger = (opts && opts.logger) || silentLogger();

  const locationDeps      = {
    relay: {
      sendLocationRequest: (msg     ) => {
        if (typeof relay.sendLocationRequest !== "function") {
          const err      = new Error(
            "location_unavailable: relay cannot send location requests",
          );
          err.code = "location_unavailable";
          throw err;
        }
        return relay.sendLocationRequest(msg);
      },
      onLocationResponse: (cb     ) => {
        if (typeof relay.onLocationResponse !== "function") return () => {};
        return relay.onLocationResponse(cb);
      },
    },
    isSessionConnected: (_sessionKey     ) => {
      if (typeof relay.hasConnectedAppClient === "function") {
        return relay.hasConnectedAppClient();
      }
      return false;
    },
    isLocationAccessEnabled: () => {
      if (typeof relay.isLocationAccessEnabled === "function") {
        return relay.isLocationAccessEnabled();
      }
      return false;
    },

    considerModel: (params     ) => relay.considerProgramCardModel(params),
    ...(typeof relay.considerProgramCardAgentRefresh === "function"
      ? { considerAgentRefresh: (params     ) => relay.considerProgramCardAgentRefresh(params) }
      : {}),
    ...(typeof relay.programCardAgentRefreshAllowed === "function"
      ? { agentRefreshAllowed: (key     ) => relay.programCardAgentRefreshAllowed(key) }
      : {}),
    emitDebug: (event     , severity     , data     , context      = {}) => {
      if (typeof relay.emitDebug !== "function") return;
      relay.emitDebug(
        "relay.session",
        event,
        severity,
        { sessionKey: (context && context.sessionKey) || undefined },
        () => data || {},
      );
    },
  };
  if (opts && typeof opts.locationTimeoutMs === "number") {
    locationDeps.timeoutMs = opts.locationTimeoutMs;
  }
  if (opts && typeof opts.setTimeout === "function") {
    locationDeps.setTimeout = opts.setTimeout;
  }
  if (opts && typeof opts.clearTimeout === "function") {
    locationDeps.clearTimeout = opts.clearTimeout;
  }
  if (opts && typeof opts.newRequestId === "function") {
    locationDeps.newRequestId = opts.newRequestId;
  }

  const locationHandler = createLocationToolHandler(locationDeps);

  async function getCurrentLocation(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) {
      return {
        error: `${LOCATION_PHONE_TOOL_NAME} requires HERMES_SESSION_KEY`,
        code: gate.code,
      };
    }
    try {
      return await locationHandler.getCurrentLocation(request.params, {
        sessionKey: gate.sessionKey,
      });
    } catch (err     ) {
      const code =
        err && typeof err.code === "string" && err.code.trim()
          ? err.code.trim()
          : "location_unavailable";
      const message = err && err.message ? String(err.message) : code;
      logger.warn(`[hermes-phone-tools] ${LOCATION_PHONE_TOOL_NAME} failed: ${message}`);
      return { error: message, code };
    }
  }

  let unsubscribeDeviceInfo      = () => {};
  const deviceInfoDeps      = {
    relay: {
      sendDeviceInfoRequest: (msg     ) => {
        if (typeof relay.sendDeviceInfoRequest !== "function") {
          const err      = new Error(
            "device_unavailable: relay cannot send device info requests",
          );
          err.code = "device_unavailable";
          throw err;
        }
        return relay.sendDeviceInfoRequest(msg);
      },
      onDeviceInfoResponse: (cb     ) => {
        if (typeof relay.onDeviceInfoResponse !== "function") return () => {};
        const off = relay.onDeviceInfoResponse(cb);
        if (typeof off === "function") unsubscribeDeviceInfo = off;
        return off;
      },
    },

    isSessionConnected: (_sessionKey     ) => {
      if (typeof relay.hasConnectedAppClient === "function") {
        return relay.hasConnectedAppClient();
      }
      return false;
    },
  };
  if (opts && typeof opts.deviceInfoTimeoutMs === "number") {
    deviceInfoDeps.timeoutMs = opts.deviceInfoTimeoutMs;
  }
  if (opts && typeof opts.setTimeout === "function") {
    deviceInfoDeps.setTimeout = opts.setTimeout;
  }
  if (opts && typeof opts.clearTimeout === "function") {
    deviceInfoDeps.clearTimeout = opts.clearTimeout;
  }
  if (opts && typeof opts.newRequestId === "function") {
    deviceInfoDeps.newRequestId = opts.newRequestId;
  }

  const deviceInfoHandler = createDeviceInfoToolHandler(deviceInfoDeps);

  async function getDeviceInfo(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) {
      return {
        error: `${DEVICE_INFO_PHONE_TOOL_NAME} requires HERMES_SESSION_KEY`,
        code: gate.code,
      };
    }
    try {
      return await deviceInfoHandler.getDeviceInfo(request.params, {
        sessionKey: gate.sessionKey,
      });
    } catch (err     ) {
      const code =
        err && typeof err.code === "string" && err.code.trim()
          ? err.code.trim()
          : "device_unavailable";
      const message = err && err.message ? String(err.message) : code;
      logger.warn(`[hermes-phone-tools] ${DEVICE_INFO_PHONE_TOOL_NAME} failed: ${message}`);
      return { error: message, code };
    }
  }

  async function phoneSettingsCall(toolName        , relayMethod        , run     , params     , fallbackCode = "settings_timeout") {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) {
      return { error: `${toolName} requires HERMES_SESSION_KEY`, code: gate.code };
    }
    try {
      return await run((value     ) => {
        if (typeof relay[relayMethod] !== "function") return { ok: false, code: "phone_not_connected" };
        return relay[relayMethod](value);
      }, request.params);
    } catch (err     ) {
      const code = err && typeof err.code === "string" && err.code.trim() ? err.code.trim() : fallbackCode;
      const message = err && err.message ? String(err.message) : code;
      logger.warn(`[hermes-phone-tools] ${toolName} failed: ${message}`);
      return { error: message, code };
    }
  }
  const getPhoneSettings = (params     ) =>
    phoneSettingsCall(GET_SETTINGS_TOOL_NAME, "getPhoneSettings", runGetSettingsTool, params);
  const setPhoneSetting = (params     ) =>
    phoneSettingsCall(SET_SETTING_TOOL_NAME, "setPhoneSetting", runSetSettingTool, params);

  const showBotScreen = (params     ) =>
    phoneSettingsCall(SHOW_BOT_SCREEN_TOOL_NAME, "showBotScreen", runShowBotScreenTool, params, "show_timeout");

  function buildSessionTitleHandler(sessionKey     ) {
    return createSessionTitleToolHandler({
      peekSessionKey: () => sessionKey,
      setSessionTitle: (key     , title     , opts     ) => {
        if (typeof relay.setSessionTitle !== "function") {
          const err      = new Error(
            "session_title_unavailable: relay cannot set session titles",
          );
          err.code = "session_title_unavailable";
          throw err;
        }

        return relay.setSessionTitle(key, title, opts);
      },

      isSessionUserLocked: (key     ) =>
        typeof relay.isSessionUserLocked === "function"
          ? relay.isSessionUserLocked(key)
          : false,
      isNeuralSessionNamesEnabled: (key     ) =>
        typeof relay.isNeuralSessionNamesEnabled === "function"
          ? relay.isNeuralSessionNamesEnabled(key)
          : false,

      hasRecordedUserMessage: (key     ) =>
        typeof relay.hasRecordedUserMessage === "function"
          ? relay.hasRecordedUserMessage(key)
          : false,
    });
  }

  async function setSessionTitle(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) {
      return {
        error: `${SESSION_TITLE_PHONE_TOOL_NAME} requires HERMES_SESSION_KEY`,
        code: gate.code,
      };
    }
    try {
      await buildSessionTitleHandler(gate.sessionKey).setSessionTitle(
        request.params,
      );

      return { status: "accepted" };
    } catch (err     ) {
      const code =
        err && typeof err.code === "string" && err.code.trim()
          ? err.code.trim()
          : "session_title_unavailable";
      const message = err && err.message ? String(err.message) : code;
      logger.warn(
        `[hermes-phone-tools] ${SESSION_TITLE_PHONE_TOOL_NAME} failed: ${message}`,
      );
      return { error: message, code };
    }
  }

  const openCards = createOpenCardStore({ keyOf: normalizeHermesLiveUiSessionKey });
  const unsubscribeCardContext = typeof relay.onProgramCardContext === "function"
    ? relay.onProgramCardContext((frame     ) => { if (typeof frame?.sessionKey === "string") openCards.report(frame.sessionKey, frame.card); })
    : () => {};
  function lookToolResponse(value     ) {
    const { images = [], imageReport, aggregateReport: _aggregateReport, ...result } = value;
    const body = result.ok === true ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "error")) : result;
    return { content: [{ type: "text", text: JSON.stringify(lookResultForModel(body)) }, ...lookToolImageContent(imageReport ?? result.report ?? result.capture, images)] };
  }
  const programCardHandler = createProgramCardToolHandler({
    pictureFileScope: (key        ) => relay.programCardPictureFileScope?.(key) ?? null,
    supportsDrafts: (key        ) => relay.supportsProgramCardDrafts?.(key) === true,
    writeDraft: (key        , card     ) => relay.writeProgramCardDraft(key, card),
    notesOn: () => typeof relay.cardBuildNotesOn === "function" && relay.cardBuildNotesOn() === true,
    taskFor: (key        ) => typeof relay.cardBuildTaskFor === "function" ? relay.cardBuildTaskFor(key) : null,

    changeOf: (key        ) => typeof relay.cardBuildChangeOf === "function" ? relay.cardBuildChangeOf(key) : null,
    changeDone: (key        ) => typeof relay.cardBuildChangeDone === "function" ? relay.cardBuildChangeDone(key) : null,
    changeTested: (key        , tested = true) => typeof relay.cardBuildChangeTested === "function" ? relay.cardBuildChangeTested(key, tested) : null,
    changeRevive: (key        , draftId        ) =>
      typeof relay.cardBuildChangeRevive === "function" ? relay.cardBuildChangeRevive(key, draftId) : false,
    changeLiveFailed: (key        , failed         ) =>
      typeof relay.cardBuildChangeLiveFailed === "function" ? relay.cardBuildChangeLiveFailed(key, failed) : null,
    liveFailed: (key        , parts       ) =>
      typeof relay.cardBuildLiveFailed === "function" ? relay.cardBuildLiveFailed(key, parts) : null,
    changeReplace: (key        , numbers     , notChecks      ) =>
      typeof relay.cardBuildChangeReplace === "function" ? relay.cardBuildChangeReplace(key, numbers, notChecks) : null,

    changeSpoken: (key        , open     ) => typeof relay.cardBuildChangeSpoken === "function" ? relay.cardBuildChangeSpoken(key, open) : null,
    relay: {
      sendProgramCardRequest: (msg     ) => {
        if (typeof relay.sendProgramCardRequest !== "function") {
          const err      = new Error("relay cannot send program card requests");
          err.code = "no_downstream_client";
          throw err;
        }
        return relay.sendProgramCardRequest(msg);
      },
      onProgramCardResponse: (cb     ) => {
        if (typeof relay.onProgramCardResponse !== "function") return () => {};
        return relay.onProgramCardResponse(cb);
      },

      onProgramCardPlayScreen: (cb     ) => {
        if (typeof relay.onProgramCardPlayScreen !== "function") return () => {};
        return relay.onProgramCardPlayScreen(cb);
      },

      onProgramCardFrameChanged: (cb     ) => {
        if (typeof relay.onProgramCardFrameChanged !== "function") return () => {};
        return relay.onProgramCardFrameChanged(cb);
      },
      sendProgramCardLookResult: (msg     ) => relay.sendProgramCardLookResult?.(msg),
      clearProgramCardLookResults: (sessionKey     ) => relay.clearProgramCardLookResults?.(sessionKey),
    },
    hasCapableClient: () =>
      typeof relay.hasConnectedAppClientCapability === "function" &&
      relay.hasConnectedAppClientCapability(PROGRAM_CARD_CAPABILITY) === true,

    ...(typeof relay.hasConnectedAppClient === "function" ? { hasAppClient: () => relay.hasConnectedAppClient() === true } : {}),

    clientAwayMs: () => relay.programCardClientAwayMs?.() ?? null,
    hasLookClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_CAPABILITY) === true,
    hasPicturesClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_PICTURES_CAPABILITY) === true,
    hasDriveLookClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_DRIVE_CAPABILITY) === true,
    hasPlayLookClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_PLAY_CAPABILITY) === true,
    hasPlayRunLookClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_PLAY_RUN_CAPABILITY) === true,
    hasCasesLookClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_CASES_CAPABILITY) === true,

    hasCardStudioClient: (sessionKey        ) => relay.hasCardStudioClient?.(sessionKey) === true,

    kitLevel: () => relay.programCardKitLevel?.() ?? null,

    taskBuildCard: (sessionKey        ) => typeof relay.cardBuildTestCard === "function" ? relay.cardBuildTestCard(sessionKey) : null,
    hasLiveCaptureClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY) === true,

    frameComplete: () => (typeof relay.completeProgramCardFrame === "function" ? relay.completeProgramCardFrame : null),

    frameDetail: () => relay.programCardFrameDetail?.() ?? null,

    noteFrameBrief: (source        , brief     ) => relay.noteProgramCardFrameBrief?.(source, brief),
    hasFrameDrawClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_FRAME_DRAW_CAPABILITY) === true,

    hasFrameIdeaClient: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_FRAME_IDEA_CAPABILITY) === true,
    noteFrameIdea: (sessionKey        , idea        ) => relay.noteCardBuildFrameIdea?.(sessionKey, idea),
    holdBuildDone: (sessionKey        , settled                  , maxMs        ) =>
      typeof relay.holdCardBuildDone === "function" && relay.holdCardBuildDone(sessionKey, settled, maxMs) === true,

    noteSpeck: (sessionKey        , text        ) => relay.noteCardBuildSpeck?.(sessionKey, text),

    admitLookResult: (result     ) => new TextEncoder().encode(JSON.stringify(lookToolResponse(result))).byteLength <= LINK_MAX_LINE_BYTES - 16_384,
    getOpenCard: (sessionKey        ) => openCards.get(sessionKey),
    sessionsShowing: (cardKey        ) => openCards.sessionsShowing(cardKey),
    isCardReady: (sessionKey        ) => openCards.isReady(sessionKey),
    markCardReady: (sessionKey        , held         ) => openCards.markReady(sessionKey, held),
    sessionKeyOf: normalizeHermesLiveUiSessionKey,

    ...(Number.isFinite(opts?.firstLookOpenWaitMs) ? { firstLookOpenWaitMs: opts.firstLookOpenWaitMs } : {}),
    ...(typeof relay.considerProgramCardJev === "function"
      ? { considerJev: (params     ) => relay.considerProgramCardJev(params) }
      : {}),

    ...(typeof relay.liveProgramCardParts === "function"
      ? { liveParts: (params     ) => relay.liveProgramCardParts(params) }
      : {}),

    cardHealth: (key        , sessionKey        ) =>
      typeof relay.programCardHealth === "function" ? relay.programCardHealth(key, sessionKey) : [],

    ...(typeof relay.settleProgramCardSites === "function"
      ? { settleCardSites: (params     ) => relay.settleProgramCardSites(params) }
      : {}),
    ...(typeof relay.considerProgramCardMcp === "function"
      ? { considerMcp: (params     ) => relay.considerProgramCardMcp(params) }
      : {}),
    ...(typeof relay.checkProgramCardMcpWrites === "function"
      ? { checkMcpWrites: (params     ) => relay.checkProgramCardMcpWrites(params) }
      : {}),
    ...(typeof relay.considerProgramCardModel === "function"
      ? { considerModel: (params     ) => relay.considerProgramCardModel(params) }
      : {}),

    ...(typeof relay.programCardHealth === "function"
      ? { health: (key        , sessionKey        , declared     ) => relay.programCardHealth(key, sessionKey, declared) }
      : {}),
    ...(typeof relay.considerProgramCardAgentRefresh === "function"
      ? { considerAgentRefresh: (params     ) => relay.considerProgramCardAgentRefresh(params) }
      : {}),
    ...(typeof relay.programCardAgentRefreshAllowed === "function"
      ? { agentRefreshAllowed: (key     ) => relay.programCardAgentRefreshAllowed(key) }
      : {}),
    emitDebug: (event     , severity     , data     , context      = {}) => {
      if (typeof relay.emitDebug !== "function") return;
      relay.emitDebug(
        "relay.session",
        event,
        severity,
        { sessionKey: (context && context.sessionKey) || undefined },
        () => data || {},
      );
    },
    ...(opts && typeof opts.programCardTimeoutMs === "number"
      ? { timeoutMs: opts.programCardTimeoutMs }
      : {}),
    ...(opts && typeof opts.setTimeout === "function" ? { setTimeout: opts.setTimeout } : {}),
    ...(opts && typeof opts.clearTimeout === "function" ? { clearTimeout: opts.clearTimeout } : {}),
    ...(opts && typeof opts.newRequestId === "function" ? { newRequestId: opts.newRequestId } : {}),
  });
  const disconnectDrive = (event     ) => {
    const raw = typeof event === "string" ? event : event?.sessionKey;
    if (typeof raw === "string" && raw.trim()) programCardHandler.disconnectSession(normalizeHermesLiveUiSessionKey(raw));
  };
  const unsubscribeCardDisconnect = typeof relay.onAppClientDisconnect === "function"
    ? relay.onAppClientDisconnect(disconnectDrive) : () => {};
  const unsubscribeCardSessionLeft = typeof relay.onAppClientSessionLeft === "function"
    ? relay.onAppClientSessionLeft(disconnectDrive) : () => {};

  function evenAiDedicatedSessionKey() {
    try {
      return typeof opts.getEvenAiDedicatedSessionKey === "function"
        ? opts.getEvenAiDedicatedSessionKey()
        : null;
    } catch {
      return null;
    }
  }

  const askScope = (opts && opts.askScope) || globalThis;
  const askGate = (sessionKey        ) => cardAskGate(sessionKey, Date.now(), askScope);
  const askCardHandler = createCardAskHandler({
    scopeHost: askScope,
    yesGuides: () => programCardYesGuides((capability) => relay.hasConnectedAppClientCapability?.(capability) === true, {
      hostDrawsFrames: typeof relay.completeProgramCardFrame === "function",
    }),
    spritesOn: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_SPRITES_CAPABILITY) === true,
    testPlayerOn: () => relay.hasConnectedAppClientCapability?.(PROGRAM_CARD_TEST_PLAYER_CAPABILITY) === true,

    onGameYes: (sessionKey        , game     ) => { programCardHandler.prepareFrameIdea(sessionKey, game); },
    notesOn: () => typeof relay.cardBuildNotesOn === "function" && relay.cardBuildNotesOn() === true,
    buildTurn: (sessionKey        , info     ) =>
      typeof relay.planCardBuildTurn === "function" ? relay.planCardBuildTurn(sessionKey, info) : false,
    taskFor: (sessionKey        ) => typeof relay.cardBuildTaskFor === "function" ? relay.cardBuildTaskFor(sessionKey) : null,

    taskCard: (sessionKey        ) => typeof relay.cardBuildTestCard === "function" ? relay.cardBuildTestCard(sessionKey) : null,

    taskStarter: (sessionKey        ) => typeof relay.cardBuildStarter === "function" ? relay.cardBuildStarter(sessionKey) : null,

    taskAdd: (sessionKey        ) => typeof relay.cardBuildTaskAdd === "function" ? relay.cardBuildTaskAdd(sessionKey) : null,

    taskFixAsk: (sessionKey        ) => typeof relay.cardBuildTaskFixAsk === "function" ? relay.cardBuildTaskFixAsk(sessionKey) : null,
    taskFix: (sessionKey        ) => typeof relay.cardBuildTaskFix === "function" ? relay.cardBuildTaskFix(sessionKey) : null,

    findSavedCard: (sessionKey        , query        ) =>
      typeof relay.cardBuildFindSaved === "function" ? relay.cardBuildFindSaved(sessionKey, query) : null,

    noDraftsWhy: (sessionKey        ) => typeof relay.cardBuildNoDraftsWhy === "function" ? relay.cardBuildNoDraftsWhy(sessionKey) : "",
    changeCard: (sessionKey        , change     ) =>
      typeof relay.cardBuildChange === "function" ? relay.cardBuildChange(sessionKey, change) : null,
    presentCardAsk: (p     ) =>
      typeof relay.presentCardAsk === "function"
        ? relay.presentCardAsk(p)
        : Promise.resolve({ answer: "no_answer", reason: "no_connected_client" }),

    ...(typeof relay.programCardHostHealth === "function"
      ? { hostHealth: (parts          ) => relay.programCardHostHealth(parts) } : {}),
    askNotShown: (sessionKey        ) => relay.cardAskNotShown?.(sessionKey),
    emit: (fields     ) => {
      if (typeof relay.emitGlassesUiLifecycle === "function") {
        relay.emitGlassesUiLifecycle("program_card_ask", "info", fields);
      }
    },
    ...(opts && typeof opts.cardAskTimeoutMs === "number" ? { timeoutMs: opts.cardAskTimeoutMs } : {}),
    ...(opts && typeof opts.cardAskChangeWaitMs === "number" ? { changeWaitMs: opts.cardAskChangeWaitMs } : {}),
  });

  async function askGlassesCard(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) return { answer: "no_answer", next: `No ask was shown (${gate.code}).` };
    if (isEvenAiAgentSession(gate.sessionKey, evenAiDedicatedSessionKey())) {
      return { answer: "no_answer", next: "No ask was shown (even_ai_session)." };
    }
    return askCardHandler(gate.sessionKey          , request.params);
  }

  const requestWriteHandler = createRequestCardMcpWriteHandler({
    considerWrite: (p     ) => typeof relay.considerProgramCardMcpWrite === "function"
      ? relay.considerProgramCardMcpWrite(p) : { answer: "off" },
  });

  async function requestCardMcpWrite(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) return { answer: "off", next: `No request was shown (${gate.code}).` };
    if (isEvenAiAgentSession(gate.sessionKey, evenAiDedicatedSessionKey())) {
      return { answer: "off", next: "No request was shown (even_ai_session)." };
    }
    return requestWriteHandler(gate.sessionKey          , request.params);
  }

  const requestHostCommandHandler = createRequestHostCommandHandler({
    considerHostCommand: (p     ) => typeof relay.considerProgramCardHostCommand === "function"
      ? relay.considerProgramCardHostCommand(p) : { answer: "off" },
  });

  async function requestHostCommand(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) return { answer: "off", next: `No ask was shown (${gate.code}).` };
    if (isEvenAiAgentSession(gate.sessionKey, evenAiDedicatedSessionKey())) {
      return { answer: "off", next: "No ask was shown (even_ai_session)." };
    }
    return requestHostCommandHandler(gate.sessionKey          , request.params);
  }

  const requestCardSetupHandler = createRequestCardSetupHandler({
    considerSetup: (p     ) => typeof relay.considerProgramCardSetup === "function"
      ? relay.considerProgramCardSetup(p) : { answer: "no_glasses" },
    getOpenCard: (sessionKey        ) => openCards.get(sessionKey),
  });

  async function requestCardSetup(params     ) {
    const request = params && typeof params === "object" ? params : {};
    if (request.setup === true) {

      const p = request.params && typeof request.params === "object" ? request.params : {};
      if (p.what !== "mcp" && p.what !== "server") {
        return { answer: "no_answer", next: "No request was shown (setup_asks_for_mcp_or_a_server_only)." };
      }
      let current      = null;
      try { current = typeof relay.peekSessionKey === "function" ? relay.peekSessionKey() : null; } catch (_) { current = null; }
      const usable = typeof current === "string" && !!current.trim() && !isEvenAiAgentSession(current, evenAiDedicatedSessionKey());
      return requestCardSetupHandler(usable ? current.trim() : HERMES_SETUP_CHAT_SESSION_KEY, { what: p.what, server: p.server, during: "setup" });
    }
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) return { answer: "no_answer", next: `No request was shown (${gate.code}).` };
    if (isEvenAiAgentSession(gate.sessionKey, evenAiDedicatedSessionKey())) {
      return { answer: "no_answer", next: "No request was shown (even_ai_session)." };
    }
    return requestCardSetupHandler(gate.sessionKey          , request.params);
  }

  function hermesCardBody(result     ) {
    if (result && result.ok === true && result.error === null) {

      const { jev, mcp, model, next } = result;
      return {
        ok: true,
        shown: result.shown === true,

        ...(result.ready === true ? { ready: true } : {}),
        ...(result.draft ? { draft: result.draft } : {}),
        ...(typeof result.persisted === "boolean" ? { persisted: result.persisted } : {}),
        ...(typeof jev === "string" ? { jev } : {}),
        ...(typeof mcp === "string" ? { mcp } : {}),
        ...(typeof model === "string" ? { model } : {}),
        ...(typeof next === "string" && next ? { next } : {}),
      };
    }
    return result;
  }

  function writeResponse(result     ) {
    const { firstLook, images, imageReport, ...written } = result || ({}       );
    if (!firstLook) return hermesCardBody(result);
    return lookToolResponse({ ...hermesCardBody(written), firstLook, images: images ?? [], imageReport: imageReport ?? firstLook.report });
  }

  async function writeGlassesCard(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) {
      return { ok: false, shown: false, error: gate.code };
    }

    if (isEvenAiAgentSession(gate.sessionKey, evenAiDedicatedSessionKey())) {
      return { ok: false, shown: false, error: "even_ai_session" };
    }

    const refused = askGate(gate.sessionKey          );
    if (refused) return { ok: false, shown: false, error: refused };
    try {

      const plan = cardAskPlan(gate.sessionKey          , askScope);

      const game = cardAskGame(gate.sessionKey          , askScope);
      const result = await programCardHandler.writeCard(request.params, {
        sessionKey: gate.sessionKey,

        imageModel: { host: "hermes", model: typeof request.model === "string" ? request.model : "unknown",
          input: Array.isArray(request.modelInput) ? request.modelInput.filter((v     ) => v === "text" || v === "image") : [] },
        ...(plan ? { plan } : {}),
        ...(typeof game === "boolean" ? { game } : {}),
      });
      if (result && (result.ok === true || result.persisted === true)) spendCardAsk(gate.sessionKey          , askScope);
      return writeResponse(result);
    } catch (err     ) {
      const message = err && err.message ? String(err.message) : "program_card_failed";
      logger.warn(`[hermes-phone-tools] ${WRITE_GLASSES_CARD_TOOL_NAME} failed: ${message}`);
      return { ok: false, shown: false, error: message };
    }
  }

  async function talkToCard(op                    , params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) return { ok: false, error: gate.code };
    if (isEvenAiAgentSession(gate.sessionKey, evenAiDedicatedSessionKey())) {
      return { ok: false, error: "even_ai_session" };
    }
    try {
      const result      = await programCardHandler.talk(op, request.params, { sessionKey: gate.sessionKey,
        imageModel: { host: "hermes", model: typeof request.model === "string" ? request.model : "unknown",
          input: Array.isArray(request.modelInput) ? request.modelInput.filter((kind     ) => kind === "text" || kind === "image") : [] } });
      if (op === "command" && request.params?.capture === true) return lookToolResponse(result);

      if (op === "edit" && result?.fixedRefusedWrite === true) {
        if (result.ok === true || result.persisted === true) spendCardAsk(gate.sessionKey          , askScope);
        const { fixedRefusedWrite: _fixed, ...written } = result;
        return { ...writeResponse(written), fixedRefusedWrite: true };
      }

      if (op === "edit" && Array.isArray(result?.images) && result.images.length) return lookToolResponse(result);

      if (result && result.ok === true && result.error === null) {
        const { error: _error, ...rest } = result;
        return lookResultForModel(rest);
      }
      return lookResultForModel(result);
    } catch (err     ) {
      const message = err && err.message ? String(err.message) : "program_card_failed";
      logger.warn(`[hermes-phone-tools] card ${op} failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  async function lookGlassesCard(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) return { ok: false, error: gate.code };
    if (isEvenAiAgentSession(gate.sessionKey, evenAiDedicatedSessionKey())) return { ok: false, error: "even_ai_session" };
    const result = await programCardHandler.lookCard(request.params, {
      sessionKey: gate.sessionKey,
      imageModel: { host: "hermes", model: typeof request.model === "string" ? request.model : "unknown",
        input: Array.isArray(request.modelInput) ? request.modelInput.filter((v     ) => v === "text" || v === "image") : [] },
    });
    return lookToolResponse(result);
  }

  const saveCardHandler = createSaveGlassesCardHandler({
    broadcastSaveRequest: (params     ) => {
      if (typeof relay.broadcastProgramCardSaveRequest !== "function") {
        throw new Error("relay cannot send save requests");
      }
      relay.broadcastProgramCardSaveRequest(params);
    },
    isAppConnected: () =>
      typeof relay.hasConnectedAppClient === "function" ? relay.hasConnectedAppClient() : true,
    ...(opts && typeof opts.saveCardTimeoutMs === "number"
      ? { timeoutMs: opts.saveCardTimeoutMs }
      : {}),
    ...(opts && typeof opts.setTimeout === "function" ? { setTimeout: opts.setTimeout } : {}),
    ...(opts && typeof opts.clearTimeout === "function" ? { clearTimeout: opts.clearTimeout } : {}),
  });

  async function saveGlassesCard(params     ) {
    const request = params && typeof params === "object" ? params : {};
    const gate = resolvePhoneToolSessionKey(request.sessionKey);
    if (!gate.ok) {
      return `The card was not saved (${gate.code}).`;
    }
    const result      = await saveCardHandler.saveGlassesCard(request.params);
    const block = result && Array.isArray(result.content) ? result.content[0] : null;
    return block && typeof block.text === "string" ? block.text : "The card was not saved.";
  }

  let unsubscribeAgentEnd      = () => {};
  if (opts && opts.hostHooks && typeof opts.hostHooks.on === "function") {
    const off = opts.hostHooks.on("agent_end", (_event     , ctx     ) => {
      const sessionKey =
        ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
          ? ctx.sessionKey.trim()
          : "";
      if (!sessionKey) return;
      const normalized = normalizeHermesLiveUiSessionKey(sessionKey);
      locationHandler.drainSession(normalized, {
        ok: false,
        code: "location_aborted",
      });
      deviceInfoHandler.drainSession(normalized, {
        ok: false,
        code: "device_info_aborted",
      });
      programCardHandler.drainSession(normalized, { error: "aborted" });
    });
    if (typeof off === "function") unsubscribeAgentEnd = off;
  }

  const studio = (tool        , method                       ) => cardStudioRecordingMethod(relay, tool, method, (request     ) => {
    const gate = resolvePhoneToolSessionKey(request?.sessionKey);
    return gate.ok ? gate.sessionKey           : null;
  });

  return {

    methods: {
      [LINK_PHONE_TOOL_METHODS.getCurrentLocation]: getCurrentLocation,
      [LINK_PHONE_TOOL_METHODS.getDeviceInfo]: getDeviceInfo,
      [LINK_PHONE_TOOL_METHODS.setSessionTitle]: setSessionTitle,
      [LINK_PHONE_TOOL_METHODS.writeGlassesCard]: studio("write_glasses_card", writeGlassesCard),
      [LINK_PHONE_TOOL_METHODS.saveGlassesCard]: studio("save_glasses_card", saveGlassesCard),
      [LINK_PHONE_TOOL_METHODS.askGlassesCard]: studio("ask_glasses_card", askGlassesCard),
      [LINK_PHONE_TOOL_METHODS.glassesCardCommand]: studio("glasses_card_command", (params     ) => talkToCard("command", params)),
      [LINK_PHONE_TOOL_METHODS.editGlassesCard]: studio("edit_glasses_card", (params     ) => talkToCard("edit", params)),
      [LINK_PHONE_TOOL_METHODS.lookGlassesCard]: studio("look_glasses_card", lookGlassesCard),
      [LINK_PHONE_TOOL_METHODS.glassesCardDraft]: studio("glasses_card_draft", async (request     ) => {
        const gate = resolvePhoneToolSessionKey(request?.sessionKey);
        if (!gate.ok) return { ok: false, error: gate.code };
        if (isEvenAiAgentSession(gate.sessionKey, evenAiDedicatedSessionKey())) return { ok: false, error: "even_ai_session" };
        return relay.programCardDraftAction?.(gate.sessionKey, request.params) || { ok: false, error: "draft_unavailable" };
      }),
      [LINK_PHONE_TOOL_METHODS.requestCardMcpWrite]: studio("request_card_mcp_write", requestCardMcpWrite),
      [LINK_PHONE_TOOL_METHODS.requestHostCommand]: studio("request_host_command", requestHostCommand),
      [LINK_PHONE_TOOL_METHODS.requestCardSetup]: studio("request_card_setup", requestCardSetup),
      [LINK_PHONE_TOOL_METHODS.getPhoneSettings]: getPhoneSettings,
      [LINK_PHONE_TOOL_METHODS.setPhoneSetting]: setPhoneSetting,
      [LINK_PHONE_TOOL_METHODS.showBotScreen]: showBotScreen,
    },
    dispose() {
      try {
        unsubscribeAgentEnd();
      } catch {

      }
      try {
        unsubscribeDeviceInfo();
      } catch {

      }
      try { unsubscribeCardDisconnect?.(); } catch {  }
      try { unsubscribeCardSessionLeft?.(); } catch {  }
      try { unsubscribeCardContext?.(); } catch {  }
      locationHandler.dispose();
      locationHandler.drainAll({ ok: false, code: "location_aborted" });
      deviceInfoHandler.drainAll({ ok: false, code: "device_info_aborted" });
      programCardHandler.dispose();
      programCardHandler.drainAll({ error: "aborted" });
    },
  };
}

module.exports = { PHONE_TOOL_TOOLSET, PHONE_TOOL_DEFAULT_LINK_TIMEOUT_MS, LOCATION_PHONE_TOOL_NAME, DEVICE_INFO_PHONE_TOOL_NAME, LINK_PHONE_TOOL_METHODS, buildHermesPhoneToolDescriptor, buildLocationDescriptor, buildDeviceInfoDescriptor, SESSION_TITLE_PHONE_TOOL_NAME, buildSessionTitleDescriptor, PROGRAM_CARD_WITH_REQUESTS_LINK_TIMEOUT_MS, PROGRAM_CARD_SITES_SETTLE_LONGEST_MS, buildProgramCardDescriptor, buildSaveGlassesCardDescriptor, buildAskGlassesCardDescriptor, buildGlassesCardCommandDescriptor, buildEditGlassesCardDescriptor, buildLookGlassesCardDescriptor, buildRequestCardMcpWriteDescriptor, buildRequestHostCommandDescriptor, REQUEST_CARD_SETUP_LINK_TIMEOUT_MS, buildRequestCardSetupDescriptor, PHONE_TOOL_DESCRIPTOR_BUILDERS, buildHermesPhoneToolsHelloPayload, HERMES_SETUP_CHAT_SESSION_KEY, resolvePhoneToolSessionKey, createHermesPhoneToolsBridge };
