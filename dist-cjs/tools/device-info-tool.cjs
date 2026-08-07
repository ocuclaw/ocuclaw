const { randomUUID } = require("node:crypto");

const deviceInfoParametersSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function validateDeviceInfoInput(input) {
  if (input === undefined || input === null) return { ok: true };
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "input must be an object or undefined",
    };
  }
  const keys = Object.keys(input);
  if (keys.length > 0) {
    return {
      ok: false,
      code: "invalid_input",
      message: `unknown key(s): ${keys.join(", ")}`,
    };
  }
  return { ok: true };
}

function createPendingDeviceInfoMap() {
  const byRequest = new Map();

  function register(sessionKey, requestId) {
    return new Promise((resolve) => {
      byRequest.set(requestId, { sessionKey, resolve });
    });
  }

  function resolve(requestId, outcome) {
    const pending = byRequest.get(requestId);
    if (!pending) return;
    byRequest.delete(requestId);
    pending.resolve(outcome);
  }

  function drainSession(sessionKey, outcome) {
    const ids = [];
    for (const [requestId, pending] of byRequest) {
      if (pending.sessionKey === sessionKey) ids.push(requestId);
    }
    for (const requestId of ids) {
      const pending = byRequest.get(requestId);
      if (!pending) continue;
      byRequest.delete(requestId);
      pending.resolve(outcome);
    }
    return ids.length;
  }

  function drainAll(outcome) {
    const ids = [...byRequest.keys()];
    for (const requestId of ids) {
      const pending = byRequest.get(requestId);
      if (!pending) continue;
      byRequest.delete(requestId);
      pending.resolve(outcome);
    }
    return ids.length;
  }

  return { register, resolve, drainSession, drainAll };
}

const DEFAULT_DEVICE_INFO_TIMEOUT_MS = 10_000;

function createDeviceInfoToolHandler(deps) {
  const pending = createPendingDeviceInfoMap();
  const newRequestId =
    deps && typeof deps.newRequestId === "function"
      ? deps.newRequestId
      : () => `dev-${randomUUID().slice(0, 8)}`;

  function resolveHandlerTimeoutMs() {
    if (!deps || deps.timeoutMs === undefined) return DEFAULT_DEVICE_INFO_TIMEOUT_MS;
    if (typeof deps.timeoutMs === "function") {
      const v = deps.timeoutMs();
      return Number.isFinite(v) ? v : DEFAULT_DEVICE_INFO_TIMEOUT_MS;
    }
    return Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_DEVICE_INFO_TIMEOUT_MS;
  }

  deps.relay.onDeviceInfoResponse((msg) => {
    if (!msg || typeof msg.requestId !== "string") return;
    pending.resolve(msg.requestId, msg);
  });

  async function getDeviceInfo(params, ctx) {
    const validation = validateDeviceInfoInput(params);
    if (!validation.ok) {
      const err = new Error(`${validation.code}: ${validation.message}`);
      err.code = validation.code;
      throw err;
    }
    const sessionKey =
      ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
        ? ctx.sessionKey.trim()
        : "main";
    if (typeof deps.isSessionConnected === "function" && !deps.isSessionConnected(sessionKey)) {
      const err = new Error(
        "glasses_not_connected: no Even Realities device client connected for this session",
      );
      err.code = "glasses_not_connected";
      throw err;
    }
    const requestId = newRequestId();
    const promise = pending.register(sessionKey, requestId);
    try {
      deps.relay.sendDeviceInfoRequest({ sessionKey, requestId });
    } catch (sendErr) {

      pending.resolve(requestId, { ok: false, code: "device_unavailable", requestId });
      const outcome = await promise;
      const code =
        outcome && typeof outcome.code === "string" ? outcome.code : "device_unavailable";
      const err = new Error(`${code}: device info request failed`);
      err.code = code;
      throw err;
    }

    const timeoutMs = resolveHandlerTimeoutMs();
    const setTimeoutFn =
      deps && typeof deps.setTimeout === "function" ? deps.setTimeout : setTimeout;
    const clearTimeoutFn =
      deps && typeof deps.clearTimeout === "function" ? deps.clearTimeout : clearTimeout;
    let timeoutHandle = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeoutFn(() => {
        pending.resolve(requestId, { ok: false, code: "device_info_timeout", requestId });
      }, timeoutMs);
    }

    const outcome = await promise;
    if (timeoutHandle !== null) clearTimeoutFn(timeoutHandle);
    if (outcome && outcome.ok === true) {
      if (!outcome.data || typeof outcome.data !== "object") {

        const err = new Error(
          "device_unavailable: device info response was ok but carried no data",
        );
        err.code = "device_unavailable";
        throw err;
      }
      return outcome.data;
    }
    const code =
      outcome && typeof outcome.code === "string" ? outcome.code : "device_unavailable";
    const err = new Error(`${code}: device info request failed`);
    err.code = code;
    throw err;
  }

  return {
    getDeviceInfo,
    drainSession(sessionKey, outcome) {
      return pending.drainSession(sessionKey, outcome);
    },
    drainAll(outcome) {
      return pending.drainAll(outcome);
    },
  };
}

const TOOL_DESCRIPTION = [
  "Read the user's G2 glasses battery percentage. Returns { batteryLevel: <int 0-100> }.",
  "Errors: glasses_not_connected (no Even Realities device connected),",
  "device_info_timeout, device_unavailable (SDK could not read battery).",
  "Call only when the user asks about glasses battery.",
].join("\n");

function registerDeviceInfoTool(api, service) {
  if (!api || typeof api.registerTool !== "function") {
    throw new Error("registerDeviceInfoTool requires api.registerTool");
  }
  if (!service) {
    throw new Error("registerDeviceInfoTool requires the OcuClaw relay service");
  }

  const handler = createDeviceInfoToolHandler({
    relay: {
      sendDeviceInfoRequest: (msg) => service.sendDeviceInfoRequest(msg),
      onDeviceInfoResponse: (cb) => service.onDeviceInfoResponse(cb),
    },

    isSessionConnected: (_sessionKey) => {
      if (typeof service.hasConnectedAppClient === "function") {
        return service.hasConnectedAppClient();
      }
      return false;
    },
  });

  api.registerTool({
    name: "get_evenrealities_device_info",
    description: TOOL_DESCRIPTION,
    parameters: deviceInfoParametersSchema,
    async execute(_toolCallId, params) {
      const data = await handler.getDeviceInfo(params, { sessionKey: "main" });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    },
  });

  if (typeof api.on === "function") {
    api.on("agent_end", (_event, ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;
      if (sessionKey) {
        handler.drainSession(sessionKey, { ok: false, code: "device_info_aborted" });
      }
    });
  }

  return function dispose() {
    handler.drainAll({ ok: false, code: "device_info_aborted" });
  };
}

module.exports = { deviceInfoParametersSchema, validateDeviceInfoInput, createPendingDeviceInfoMap, DEFAULT_DEVICE_INFO_TIMEOUT_MS, createDeviceInfoToolHandler, registerDeviceInfoTool };
