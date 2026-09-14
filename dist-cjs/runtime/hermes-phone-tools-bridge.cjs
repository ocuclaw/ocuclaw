const { createDeviceInfoToolHandler, DEFAULT_DEVICE_INFO_TIMEOUT_MS, DEVICE_INFO_TOOL_DESCRIPTION, deviceInfoParametersSchema } = require("../tools/device-info-tool.cjs");
const { createLocationToolHandler, DEFAULT_LOCATION_TIMEOUT_MS, LOCATION_TOOL_DESCRIPTION, locationParametersSchema } = require("../tools/location-tool.cjs");
const { createSessionTitleToolHandler, sessionTitleParametersSchema, TOOL_DESCRIPTION: SESSION_TITLE_TOOL_DESCRIPTION } = require("../tools/session-title-tool.cjs");
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
});

function buildHermesPhoneToolDescriptor(
  name,
  description,
  parameters,
  method,
  opts,
) {
  const options = opts && typeof opts === "object" ? opts : {};
  const descriptor = {
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

const PHONE_TOOL_DESCRIPTOR_BUILDERS = Object.freeze([
  buildLocationDescriptor,
  buildDeviceInfoDescriptor,
  buildSessionTitleDescriptor,
]);

function buildHermesPhoneToolsHelloPayload() {
  return PHONE_TOOL_DESCRIPTOR_BUILDERS.map((build) => build());
}

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function resolvePhoneToolSessionKey(rawKey) {
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

function createHermesPhoneToolsBridge(opts = {}) {
  const relay = opts && opts.relay;
  if (!relay) {
    throw new Error("createHermesPhoneToolsBridge requires relay");
  }
  const logger = (opts && opts.logger) || silentLogger();

  const locationDeps = {
    relay: {
      sendLocationRequest: (msg) => {
        if (typeof relay.sendLocationRequest !== "function") {
          const err = new Error(
            "location_unavailable: relay cannot send location requests",
          );
          err.code = "location_unavailable";
          throw err;
        }
        return relay.sendLocationRequest(msg);
      },
      onLocationResponse: (cb) => {
        if (typeof relay.onLocationResponse !== "function") return () => {};
        return relay.onLocationResponse(cb);
      },
    },
    isSessionConnected: (_sessionKey) => {
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

    emitDebug: (event, severity, data, context = {}) => {
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

  async function getCurrentLocation(params) {
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
    } catch (err) {
      const code =
        err && typeof err.code === "string" && err.code.trim()
          ? err.code.trim()
          : "location_unavailable";
      const message = err && err.message ? String(err.message) : code;
      logger.warn(`[hermes-phone-tools] ${LOCATION_PHONE_TOOL_NAME} failed: ${message}`);
      return { error: message, code };
    }
  }

  let unsubscribeDeviceInfo = () => {};
  const deviceInfoDeps = {
    relay: {
      sendDeviceInfoRequest: (msg) => {
        if (typeof relay.sendDeviceInfoRequest !== "function") {
          const err = new Error(
            "device_unavailable: relay cannot send device info requests",
          );
          err.code = "device_unavailable";
          throw err;
        }
        return relay.sendDeviceInfoRequest(msg);
      },
      onDeviceInfoResponse: (cb) => {
        if (typeof relay.onDeviceInfoResponse !== "function") return () => {};
        const off = relay.onDeviceInfoResponse(cb);
        if (typeof off === "function") unsubscribeDeviceInfo = off;
        return off;
      },
    },

    isSessionConnected: (_sessionKey) => {
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

  async function getDeviceInfo(params) {
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
    } catch (err) {
      const code =
        err && typeof err.code === "string" && err.code.trim()
          ? err.code.trim()
          : "device_unavailable";
      const message = err && err.message ? String(err.message) : code;
      logger.warn(`[hermes-phone-tools] ${DEVICE_INFO_PHONE_TOOL_NAME} failed: ${message}`);
      return { error: message, code };
    }
  }

  function buildSessionTitleHandler(sessionKey) {
    return createSessionTitleToolHandler({
      peekSessionKey: () => sessionKey,
      setSessionTitle: (key, title, opts) => {
        if (typeof relay.setSessionTitle !== "function") {
          const err = new Error(
            "session_title_unavailable: relay cannot set session titles",
          );
          err.code = "session_title_unavailable";
          throw err;
        }

        return relay.setSessionTitle(key, title, opts);
      },

      isSessionUserLocked: (key) =>
        typeof relay.isSessionUserLocked === "function"
          ? relay.isSessionUserLocked(key)
          : false,
      isNeuralSessionNamesEnabled: (key) =>
        typeof relay.isNeuralSessionNamesEnabled === "function"
          ? relay.isNeuralSessionNamesEnabled(key)
          : false,

      hasRecordedUserMessage: (key) =>
        typeof relay.hasRecordedUserMessage === "function"
          ? relay.hasRecordedUserMessage(key)
          : false,
    });
  }

  async function setSessionTitle(params) {
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
    } catch (err) {
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

  let unsubscribeAgentEnd = () => {};
  if (opts && opts.hostHooks && typeof opts.hostHooks.on === "function") {
    const off = opts.hostHooks.on("agent_end", (_event, ctx) => {
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
    });
    if (typeof off === "function") unsubscribeAgentEnd = off;
  }

  return {

    methods: {
      [LINK_PHONE_TOOL_METHODS.getCurrentLocation]: getCurrentLocation,
      [LINK_PHONE_TOOL_METHODS.getDeviceInfo]: getDeviceInfo,
      [LINK_PHONE_TOOL_METHODS.setSessionTitle]: setSessionTitle,
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
      locationHandler.dispose();
      locationHandler.drainAll({ ok: false, code: "location_aborted" });
      deviceInfoHandler.drainAll({ ok: false, code: "device_info_aborted" });
    },
  };
}

module.exports = { PHONE_TOOL_TOOLSET, PHONE_TOOL_DEFAULT_LINK_TIMEOUT_MS, LOCATION_PHONE_TOOL_NAME, DEVICE_INFO_PHONE_TOOL_NAME, LINK_PHONE_TOOL_METHODS, buildHermesPhoneToolDescriptor, buildLocationDescriptor, buildDeviceInfoDescriptor, PHONE_TOOL_DESCRIPTOR_BUILDERS, buildHermesPhoneToolsHelloPayload, resolvePhoneToolSessionKey, createHermesPhoneToolsBridge, SESSION_TITLE_PHONE_TOOL_NAME, buildSessionTitleDescriptor };
