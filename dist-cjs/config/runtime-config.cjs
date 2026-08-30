const { normalizeEvenAiRoutingMode } = require("../even-ai/even-ai-settings-store.cjs");
const { DEFAULT_STAGE_GRACE_MS, MIN_STAGE_GRACE_MS, MAX_STAGE_GRACE_MS } = require("../tools/glasses-ui-limits.cjs");

const OPENCLAW_BUNDLE_DEFAULT_WS_PORT = 9000;
const HERMES_FRESH_INSTALL_WS_PORT_CANDIDATES = Object.freeze([
  47801,
  43118,
  38272,
]);
const HERMES_BUNDLE_DEFAULT_WS_PORT =
  HERMES_FRESH_INSTALL_WS_PORT_CANDIDATES[0];

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return String(value).toLowerCase() !== "false";
}

function parseIntOrDefault(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = parseInt(String(value), 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function parseEvenAiRoutingMode(value) {
  return normalizeEvenAiRoutingMode(value);
}

function parseEvenAiDedicatedSessionKey(value) {
  const trimmed = pickString(value);
  if (!trimmed) {
    return "ocuclaw:even-ai";
  }
  return trimmed.toLowerCase().startsWith("ocuclaw:")
    ? trimmed
    : "ocuclaw:even-ai";
}

function parseJsonOrUndefined(value, envName) {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return JSON.parse(String(value));
  } catch (err) {
    throw new Error(`${envName} must be valid JSON: ${err.message}`);
  }
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function pickValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function resolveGatewayUrlFromOpenClawConfig(openclawConfig) {
  if (!isObject(openclawConfig) || !isObject(openclawConfig.gateway)) {
    return "";
  }
  const gateway = openclawConfig.gateway;
  const remoteMode = gateway.mode === "remote";
  if (remoteMode && isObject(gateway.remote)) {
    const remoteUrl = pickString(gateway.remote.url);
    if (remoteUrl) {
      return remoteUrl;
    }
  }
  const scheme = gateway.tls && gateway.tls.enabled === true ? "wss" : "ws";
  const port = parseIntOrDefault(gateway.port, 18789);
  return `${scheme}://127.0.0.1:${port}`;
}

function resolveGatewayTokenFromOpenClawConfig(openclawConfig) {
  if (!isObject(openclawConfig) || !isObject(openclawConfig.gateway)) {
    return "";
  }
  const gateway = openclawConfig.gateway;
  const remoteMode = gateway.mode === "remote";
  if (remoteMode && isObject(gateway.remote)) {
    return pickString(gateway.remote.token);
  }
  return pickString(
    isObject(gateway.auth) ? gateway.auth.token : undefined,
  );
}

function createRuntimeConfigOverview(opts = {}) {
  const pluginConfig = isObject(opts.pluginConfig) ? opts.pluginConfig : {};
  const openclawConfig = isObject(opts.openclawConfig) ? opts.openclawConfig : {};
  return {
    relayToken: pickString(pluginConfig.relayToken),
    gatewayToken: pickString(resolveGatewayTokenFromOpenClawConfig(openclawConfig)),
    sonioxApiKey: pickString(pluginConfig.sonioxApiKey),
    cartesiaApiKey: pickString(pluginConfig.cartesiaApiKey),
    evenAiToken: pickString(pluginConfig.evenAiToken),
    wsBind: pickString(pluginConfig.wsBind, "127.0.0.1"),
    wsPort: parseIntOrDefault(
      pickValue(pluginConfig.wsPort),
      OPENCLAW_BUNDLE_DEFAULT_WS_PORT,
    ),
  };
}

function resolveDebugNoisyPolicies(pluginValue, envValue) {
  if (pluginValue !== undefined && pluginValue !== null) {
    return pluginValue;
  }
  return parseJsonOrUndefined(envValue, "debugNoisyPolicies");
}

const GLASSES_UI_LIVE_BACKENDS = new Set([
  "anthropic-api",
  "openai-compat",
]);

const GLASSES_UI_LIVE_DEFAULT_MODEL = {
  "anthropic-api": "anthropic/claude-haiku-4-5-20251001",
  "openai-compat": "gpt-4o-mini",
};

function resolveGlassesUiLive(value) {
  const raw = isObject(value) ? value : {};

  const tickBackend = GLASSES_UI_LIVE_BACKENDS.has(raw.tickBackend)
    ? raw.tickBackend
    : "anthropic-api";
  const tickModel = pickString(raw.tickModel) || GLASSES_UI_LIVE_DEFAULT_MODEL[tickBackend];
  const tickApiBaseUrl = pickString(raw.tickApiBaseUrl) || "https://api.openai.com";
  return {
    enabled: parseBool(raw.enabled, true),
    tickBackend,
    tickModel,
    tickApiBaseUrl,
    allowAgentModelOverride: parseBool(raw.allowAgentModelOverride, false),
    tickMaxOutputTokens: parseIntOrDefault(raw.tickMaxOutputTokens, 200),

    httpEnabled: parseBool(raw.httpEnabled, false),

    httpAllowHosts: Array.isArray(raw.httpAllowHosts)
      ? raw.httpAllowHosts.filter((h) => typeof h === "string")
      : [],

    llmEnabled: parseBool(raw.llmEnabled, false),

    maxConcurrentSurfacesPerHost: clampInt(raw.maxConcurrentSurfacesPerHost, 1, 64, 4),

    stageGraceMs: clampInt(
      raw.stageGraceMs,
      MIN_STAGE_GRACE_MS,
      MAX_STAGE_GRACE_MS,
      DEFAULT_STAGE_GRACE_MS,
    ),
  };
}

function createRuntimeConfig(opts = {}) {
  const pluginConfig = isObject(opts.pluginConfig) ? opts.pluginConfig : {};
  const openclawConfig = isObject(opts.openclawConfig) ? opts.openclawConfig : {};
  const relayToken = pickString(pluginConfig.relayToken);
  const gatewayUrl = pickString(resolveGatewayUrlFromOpenClawConfig(openclawConfig));
  const gatewayToken = pickString(resolveGatewayTokenFromOpenClawConfig(openclawConfig));

  if (!relayToken) {
    throw new Error(
      [
        "OcuClaw relayToken is required.",
        "Set the plugin config with:",
        '  openclaw config set plugins.entries.ocuclaw.config.relayToken "your-token"',
        "The same token must be entered in the OcuClaw app's relay server token field within Even Hub.",
        "Allow OpenClaw to reload, then verify: openclaw plugins inspect ocuclaw --runtime",
        "If the gateway is live but the runtime remains stale, run once: openclaw gateway restart --safe",
      ].join("\n"),
    );
  }
  if (!gatewayUrl) {
    throw new Error(
      "OcuClaw gatewayUrl is required from api.config.gateway. OpenClaw gateway config is missing or unusable.",
    );
  }
  if (!gatewayToken) {
    throw new Error(
      "OcuClaw gatewayToken is required from api.config.gateway. OpenClaw gateway auth token is missing or unusable.",
    );
  }

  const evenAiEnabled = parseBool(pluginConfig.evenAiEnabled, false);
  const evenAiToken = pickString(pluginConfig.evenAiToken);
  if (evenAiEnabled && !evenAiToken) {
    throw new Error(
      [
        "OcuClaw evenAiToken is required when evenAiEnabled is true.",
        "Set the plugin config with:",
        '  openclaw config set plugins.entries.ocuclaw.config.evenAiToken "your-token"',
        "The same token must be entered as the password in the Even AI Agent Configure section of the Even Realities app.",
        "To disable Even AI instead, run:",
        "  openclaw config set plugins.entries.ocuclaw.config.evenAiEnabled false --strict-json",
        "Allow OpenClaw to reload, then verify: openclaw plugins inspect ocuclaw --runtime",
        "If the gateway is live but the runtime remains stale, run once: openclaw gateway restart --safe",
      ].join("\n"),
    );
  }

  return {
    gatewayUrl,
    gatewayToken,
    relayToken,
    wsBind: pickString(pluginConfig.wsBind, "127.0.0.1"),
    wsPort: parseIntOrDefault(
      pickValue(pluginConfig.wsPort),
      OPENCLAW_BUNDLE_DEFAULT_WS_PORT,
    ),
    sessionLimit: parseIntOrDefault(pickValue(pluginConfig.sessionLimit), 80),
    sonioxApiKey: pickString(pluginConfig.sonioxApiKey),
    cartesiaApiKey: pickString(pluginConfig.cartesiaApiKey),
    debugNoisyPolicies: resolveDebugNoisyPolicies(
      pluginConfig.debugNoisyPolicies,
      undefined,
    ),
    externalDebugToolsEnabled: parseBool(
      pluginConfig.externalDebugToolsEnabled,
      false,
    ),
    allowDebugUpload: parseBool(pluginConfig.allowDebugUpload, false),
    debugUploadMaxZipBytes: clampInt(pluginConfig.debugUploadMaxZipBytes, 100_000, 4_300_000, 4_000_000),
    debugUploadCapturePreset: Array.isArray(pluginConfig.debugUploadCapturePreset) ? pluginConfig.debugUploadCapturePreset : undefined,
    debugBundleSaveDir: pluginConfig.debugBundleSaveDir || "",
    evenAiEnabled,
    evenAiToken,
    evenAiSystemPrompt: pickString(pluginConfig.evenAiSystemPrompt),
    evenAiRequestTimeoutMs: parseIntOrDefault(
      pluginConfig.evenAiRequestTimeoutMs,
      60000,
    ),
    evenAiMaxBodyBytes: parseIntOrDefault(
      pluginConfig.evenAiMaxBodyBytes,
      65536,
    ),
    evenAiDedupWindowMs: parseIntOrDefault(
      pluginConfig.evenAiDedupWindowMs,
      500,
    ),
    evenAiRoutingMode: parseEvenAiRoutingMode(pluginConfig.evenAiRoutingMode),
    evenAiDedicatedSessionKey: parseEvenAiDedicatedSessionKey(
      pluginConfig.evenAiDedicatedSessionKey,
    ),
    sessionTitleModel: pickString(pluginConfig.sessionTitleModel),
    renderGlassesUiTimeoutMs: parseIntOrDefault(
      pluginConfig.renderGlassesUiTimeoutMs,
      30 * 60 * 1000,
    ),
    glassesUiLive: resolveGlassesUiLive(pluginConfig.glassesUiLive),
    freshnessWindowMs: parseIntOrDefault(pluginConfig.freshnessWindowMs, 5000),
    evenTerminalEnabled: parseBool(
      pluginConfig.evenTerminal && pluginConfig.evenTerminal.enabled,
      false,
    ),
    evenTerminalRefreshMs: parseIntOrDefault(
      pluginConfig.evenTerminal && pickValue(pluginConfig.evenTerminal.refreshMs),
      15000,
    ),
  };
}

module.exports = { createRuntimeConfig, HERMES_BUNDLE_DEFAULT_WS_PORT, HERMES_FRESH_INSTALL_WS_PORT_CANDIDATES, DEFAULT_STAGE_GRACE_MS, MIN_STAGE_GRACE_MS, MAX_STAGE_GRACE_MS };
