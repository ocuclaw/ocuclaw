const { randomUUID } = require("node:crypto");

const locationParametersSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function validateLocationInput(input) {
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

function createPendingLocationMap() {
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

const DEFAULT_LOCATION_TIMEOUT_MS = 10_000;

function numericField(source, field) {
  return source && Number.isFinite(source[field]) ? source[field] : undefined;
}

function normalizeLocationData(data) {
  const latitude = numericField(data, "latitude");
  const longitude = numericField(data, "longitude");
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const out = { latitude, longitude };
  for (const field of ["accuracy", "altitude", "speed", "heading", "timestamp"]) {
    const value = numericField(data, field);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function normalizeRelaySendErrorCode(err) {
  const code =
    err && typeof err.code === "string" && err.code.trim() ? err.code.trim() : "";
  if (code === "location_access_disabled") return code;
  if (
    code === "no_downstream_client" ||
    code === "no_matching_app_client" ||
    code === "multi_recipient_fanout"
  ) {
    return "app_not_connected";
  }
  return code || "location_unavailable";
}

function emitLocationDebug(deps, event, severity, data, context = {}) {
  if (!deps || typeof deps.emitDebug !== "function") return;
  try {
    deps.emitDebug(event, severity, data || {}, context || {});
  } catch {

  }
}

function createLocationToolHandler(deps) {
  const pending = createPendingLocationMap();
  const newRequestId =
    deps && typeof deps.newRequestId === "function"
      ? deps.newRequestId
      : () => `loc-${randomUUID().slice(0, 8)}`;

  function resolveHandlerTimeoutMs() {
    if (!deps || deps.timeoutMs === undefined) return DEFAULT_LOCATION_TIMEOUT_MS;
    if (typeof deps.timeoutMs === "function") {
      const v = deps.timeoutMs();
      return Number.isFinite(v) ? v : DEFAULT_LOCATION_TIMEOUT_MS;
    }
    return Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_LOCATION_TIMEOUT_MS;
  }

  const unsubscribeLocationResponse = deps.relay.onLocationResponse((msg) => {
    if (!msg || typeof msg.requestId !== "string") return;
    pending.resolve(msg.requestId, msg);
  }) || (() => {});

  async function getCurrentLocation(params, ctx) {
    const startedAtMs = Date.now();
    const validation = validateLocationInput(params);
    if (!validation.ok) {
      const err = new Error(`${validation.code}: ${validation.message}`);
      err.code = validation.code;
      throw err;
    }
    const sessionKey =
      ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
        ? ctx.sessionKey.trim()
        : "main";
    const locationAccessEnabled =
      typeof deps.isLocationAccessEnabled === "function"
        ? deps.isLocationAccessEnabled()
        : true;
    const sessionConnected =
      typeof deps.isSessionConnected === "function"
        ? deps.isSessionConnected(sessionKey)
        : true;
    emitLocationDebug(
      deps,
      "location_tool_begin",
      "debug",
      {
        sessionKey,
        locationAccessEnabled,
        sessionConnected,
      },
      { sessionKey },
    );
    if (!locationAccessEnabled) {
      const err = new Error(
        "location_access_disabled: enable Location access in WebUI settings",
      );
      err.code = "location_access_disabled";
      throw err;
    }
    if (!sessionConnected) {
      const err = new Error(
        "app_not_connected: no OcuClaw WebUI client connected for this session",
      );
      err.code = "app_not_connected";
      throw err;
    }

    const requestId = newRequestId();
    const promise = pending.register(sessionKey, requestId);
    try {
      emitLocationDebug(
        deps,
        "location_tool_request_send",
        "debug",
        { requestId, sessionKey },
        { sessionKey },
      );
      deps.relay.sendLocationRequest({ sessionKey, requestId });
    } catch (err) {
      const code = normalizeRelaySendErrorCode(err);
      emitLocationDebug(
        deps,
        "location_tool_request_send_error",
        "warn",
        {
          requestId,
          sessionKey,
          code,
          errorMessage: err && err.message ? err.message : String(err),
        },
        { sessionKey },
      );
      pending.resolve(requestId, {
        ok: false,
        code,
        requestId,
      });
    }

    const timeoutMs = resolveHandlerTimeoutMs();
    const setTimeoutFn =
      deps && typeof deps.setTimeout === "function" ? deps.setTimeout : setTimeout;
    const clearTimeoutFn =
      deps && typeof deps.clearTimeout === "function" ? deps.clearTimeout : clearTimeout;
    let timeoutHandle = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeoutFn(() => {
        emitLocationDebug(
          deps,
          "location_tool_timeout",
          "warn",
          { requestId, sessionKey, timeoutMs },
          { sessionKey },
        );
        pending.resolve(requestId, { ok: false, code: "location_timeout", requestId });
      }, timeoutMs);
    }

    const outcome = await promise;
    if (timeoutHandle !== null) clearTimeoutFn(timeoutHandle);
    emitLocationDebug(
      deps,
      "location_tool_outcome",
      outcome && outcome.ok === true ? "debug" : "warn",
      {
        requestId,
        sessionKey,
        elapsedMs: Date.now() - startedAtMs,
        ok: outcome && outcome.ok === true,
        code: outcome && typeof outcome.code === "string" ? outcome.code : null,
        hasData: !!(outcome && outcome.data && typeof outcome.data === "object"),
      },
      { sessionKey },
    );
    if (outcome && outcome.ok === true) {
      const data = normalizeLocationData(outcome.data);
      if (data) return data;
      const err = new Error(
        "location_unavailable: location response was ok but carried invalid data",
      );
      err.code = "location_unavailable";
      throw err;
    }
    const code =
      outcome && typeof outcome.code === "string" ? outcome.code : "location_unavailable";
    const err = new Error(`${code}: location request failed`);
    err.code = code;
    throw err;
  }

  return {
    getCurrentLocation,
    drainSession(sessionKey, outcome) {
      return pending.drainSession(sessionKey, outcome);
    },
    drainAll(outcome) {
      return pending.drainAll(outcome);
    },
    dispose() {
      unsubscribeLocationResponse();
    },
  };
}

const TOOL_DESCRIPTION = [
  "Read the user's current phone GPS coordinates when Location access is enabled in WebUI settings.",
  "Returns latitude, longitude, and any available accuracy, altitude, speed, heading, timestamp fields.",
  "Errors: location_access_disabled, app_not_connected, location_timeout, location_unavailable.",
].join("\n");

function resolveToolSessionKey(ctx, service) {
  if (ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()) {
    return ctx.sessionKey.trim();
  }
  if (service && typeof service.peekSessionKey === "function") {
    const sessionKey = service.peekSessionKey();
    if (typeof sessionKey === "string" && sessionKey.trim()) {
      return sessionKey.trim();
    }
  }
  return "main";
}

function registerLocationTool(api, service) {
  if (!api || typeof api.registerTool !== "function") {
    throw new Error("registerLocationTool requires api.registerTool");
  }
  if (!service) {
    throw new Error("registerLocationTool requires the OcuClaw relay service");
  }

  const handler = createLocationToolHandler({
    relay: {
      sendLocationRequest: (msg) => service.sendLocationRequest(msg),
      onLocationResponse: (cb) => service.onLocationResponse(cb),
    },
    isSessionConnected: (_sessionKey) => {
      if (typeof service.hasConnectedAppClient === "function") {
        return service.hasConnectedAppClient();
      }
      return false;
    },
    isLocationAccessEnabled: () => {
      if (typeof service.isLocationAccessEnabled === "function") {
        return service.isLocationAccessEnabled();
      }
      return false;
    },
    emitDebug: (event, severity, data, context = {}) => {
      if (typeof service.emitDebug === "function") {
        service.emitDebug(
          "relay.session",
          event,
          severity,
          { sessionKey: context.sessionKey || undefined },
          () => data || {},
        );
      }
    },
  });

  api.registerTool(
    (ctx) => {
      const factorySessionKey = resolveToolSessionKey(ctx, service);
      return {
        name: "get_current_location",
        description: TOOL_DESCRIPTION,
        parameters: locationParametersSchema,
        async execute(_toolCallId, params) {
          const data = await handler.getCurrentLocation(params, { sessionKey: factorySessionKey });
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
          };
        },
      };
    },
    { name: "get_current_location" },
  );

  if (typeof api.on === "function") {
    api.on("agent_end", (_event, ctx) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;
      if (sessionKey) {
        handler.drainSession(sessionKey, { ok: false, code: "location_aborted" });
      }
    });
  }

  return function dispose() {
    handler.dispose();
    handler.drainAll({ ok: false, code: "location_aborted" });
  };
}

module.exports = { locationParametersSchema, validateLocationInput, createPendingLocationMap, DEFAULT_LOCATION_TIMEOUT_MS, createLocationToolHandler, registerLocationTool };
