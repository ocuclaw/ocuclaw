const { normalizeEvenAiRoutingMode } = require("../even-ai/even-ai-settings-store.cjs");
const { DEFAULT_STAGE_GRACE_MS, MIN_STAGE_GRACE_MS, MAX_STAGE_GRACE_MS } = require("../tools/glasses-ui-limits.cjs");
const { buildModelAliasIndex, resolveConfiguredDefaultModelRef } = require("../runtime/upstream-runtime.cjs");
const { gatewayRestartAdvice } = require("../setup/cloudways-host.cjs");

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

function gatewayEnvSources(openclawConfig, env) {
  return {
    configEnv: isObject(openclawConfig) && isObject(openclawConfig.env) ? openclawConfig.env : {},
    processEnv: isObject(env) ? env : {},
  };
}

function resolveGatewayPortSource(openclawConfig, env) {
  const gateway = isObject(openclawConfig) && isObject(openclawConfig.gateway)
    ? openclawConfig.gateway
    : null;
  const { configEnv, processEnv } = gatewayEnvSources(openclawConfig, env);
  return pickValue(
    gateway ? gateway.port : undefined,
    configEnv.OPENCLAW_GATEWAY_PORT,
    processEnv.OPENCLAW_GATEWAY_PORT,
  );
}

function resolveGatewayUrlFromOpenClawConfig(openclawConfig, env) {
  if (!isObject(openclawConfig)) {
    return "";
  }
  const gateway = isObject(openclawConfig.gateway) ? openclawConfig.gateway : null;
  if (gateway && gateway.mode === "remote" && isObject(gateway.remote)) {
    const remoteUrl = pickString(gateway.remote.url);
    if (remoteUrl) {
      return remoteUrl;
    }
  }
  const portSource = resolveGatewayPortSource(openclawConfig, env);

  if (!gateway && portSource === undefined) {
    return "";
  }
  const scheme = gateway && gateway.tls && gateway.tls.enabled === true ? "wss" : "ws";
  const port = parseIntOrDefault(portSource, 18789);
  return `${scheme}://127.0.0.1:${port}`;
}

function resolveGatewayTokenFromOpenClawConfig(openclawConfig, env) {
  if (!isObject(openclawConfig)) {
    return "";
  }
  const gateway = isObject(openclawConfig.gateway) ? openclawConfig.gateway : null;
  if (gateway && gateway.mode === "remote" && isObject(gateway.remote)) {
    return pickString(gateway.remote.token);
  }
  const { configEnv, processEnv } = gatewayEnvSources(openclawConfig, env);
  return pickString(
    gateway && isObject(gateway.auth) ? gateway.auth.token : undefined,
    configEnv.OPENCLAW_GATEWAY_TOKEN,
    processEnv.OPENCLAW_GATEWAY_TOKEN,
  );
}

function createRuntimeConfigOverview(opts = {}) {
  const pluginConfig = isObject(opts.pluginConfig) ? opts.pluginConfig : {};
  const openclawConfig = isObject(opts.openclawConfig) ? opts.openclawConfig : {};

  const env = isObject(opts.env) ? opts.env : {};
  return {
    relayToken: pickString(pluginConfig.relayToken),
    gatewayToken: pickString(resolveGatewayTokenFromOpenClawConfig(openclawConfig, env)),
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

function configuredDefaultModelIsPresent(openclawConfig) {
  const modelConfig =
    openclawConfig && openclawConfig.agents && openclawConfig.agents.defaults
      ? openclawConfig.agents.defaults.model
      : undefined;
  if (typeof modelConfig === "string") return modelConfig.trim() !== "";
  return !!(
    modelConfig &&
    typeof modelConfig === "object" &&
    typeof modelConfig.primary === "string" &&
    modelConfig.primary.trim()
  );
}

function warnNoTickBackend(logger, provider) {
  const message =
    `[ocuclaw] glassesUiLive llm disabled: no tick backend for provider "${provider || "none"}"`;
  if (logger && typeof logger.warn === "function") {
    logger.warn(message);
    return;
  }
  console.warn(message);
}

function defaultLiveModelForBackend(backend) {
  return backend === "openai-compat"
    ? GLASSES_UI_LIVE_DEFAULT_MODEL["openai-compat"]
    : GLASSES_UI_LIVE_DEFAULT_MODEL["anthropic-api"];
}

function resolveGlassesUiLive(value, openclawConfig, logger) {
  const raw = isObject(value) ? value : {};
  const explicitTickBackend = Object.prototype.hasOwnProperty.call(raw, "tickBackend");
  const explicitTickModel = pickString(raw.tickModel) !== "";

  let tickBackend = GLASSES_UI_LIVE_BACKENDS.has(raw.tickBackend)
    ? raw.tickBackend
    : "anthropic-api";
  let tickModel = pickString(raw.tickModel) || defaultLiveModelForBackend(tickBackend);
  const tickApiBaseUrl = pickString(raw.tickApiBaseUrl) || "https://api.openai.com";
  let llmDisabledReason;

  if (!explicitTickBackend && !explicitTickModel) {

    const configured = configuredDefaultModelIsPresent(openclawConfig);
    const hostModel = configured
      ? resolveConfiguredDefaultModelRef(
          openclawConfig,
          buildModelAliasIndex(openclawConfig),
        )
      : null;
    const provider = hostModel && hostModel.provider ? hostModel.provider : "";
    if (provider === "anthropic") {
      tickBackend = "anthropic-api";
      tickModel = defaultLiveModelForBackend(tickBackend);
    } else if (
      provider === "openai" &&
      (!pickString(raw.tickApiBaseUrl) || tickApiBaseUrl === "https://api.openai.com")
    ) {
      tickBackend = "openai-compat";
      tickModel = defaultLiveModelForBackend(tickBackend);
    } else {
      llmDisabledReason = "no_backend";
      warnNoTickBackend(logger, provider);
    }
  }

  return {
    enabled: parseBool(raw.enabled, true),
    tickBackend,
    tickModel,
    tickApiBaseUrl,
    allowAgentModelOverride: parseBool(raw.allowAgentModelOverride, false),
    tickMaxOutputTokens: parseIntOrDefault(raw.tickMaxOutputTokens, 200),

    httpEnabled: parseBool(raw.httpEnabled, true),

    httpHostPolicy:
      typeof raw.httpHostPolicy === "string"
        ? raw.httpHostPolicy
        : "owner-grants",

    httpAllowHosts: Array.isArray(raw.httpAllowHosts)
      ? raw.httpAllowHosts.filter((h) => typeof h === "string")
      : [],

    llmEnabled: parseBool(raw.llmEnabled, true) && !llmDisabledReason,
    ...(llmDisabledReason ? { llmDisabledReason } : {}),

    maxConcurrentSurfacesPerHost: clampInt(raw.maxConcurrentSurfacesPerHost, 1, 64, 4),

    stageGraceMs: clampInt(
      raw.stageGraceMs,
      MIN_STAGE_GRACE_MS,
      MAX_STAGE_GRACE_MS,
      DEFAULT_STAGE_GRACE_MS,
    ),
  };
}

const MIN_SILENT_INPUT_JEV_BUDGET_MS = 200;
const MAX_SILENT_INPUT_JEV_BUDGET_MS = 5000;
const DEFAULT_SILENT_INPUT_JEV_BUDGET_MS = 2500;

function resolveSilentInputJev(value, openclawConfig, env) {
  const raw = isObject(value) ? value : {};
  const { configEnv, processEnv } = gatewayEnvSources(openclawConfig, env);
  return {

    enabled: raw.enabled === true || raw.enabled === "true",
    apiKey: pickString(raw.apiKey, configEnv.TYPESAFE_API_KEY, processEnv.TYPESAFE_API_KEY),

    budgetMs: clampInt(
      raw.budgetMs == null ? undefined : raw.budgetMs,
      MIN_SILENT_INPUT_JEV_BUDGET_MS,
      MAX_SILENT_INPUT_JEV_BUDGET_MS,
      DEFAULT_SILENT_INPUT_JEV_BUDGET_MS,
    ),
  };
}

function createRuntimeConfig(opts = {}) {
  const pluginConfig = isObject(opts.pluginConfig) ? opts.pluginConfig : {};
  const openclawConfig = isObject(opts.openclawConfig) ? opts.openclawConfig : {};
  const env = isObject(opts.env) ? opts.env : {};
  const relayToken = pickString(pluginConfig.relayToken);
  const gatewayUrl = pickString(resolveGatewayUrlFromOpenClawConfig(openclawConfig, env));
  const gatewayToken = pickString(resolveGatewayTokenFromOpenClawConfig(openclawConfig, env));

  if (!relayToken) {
    throw new Error(
      [
        "OcuClaw relayToken is required.",
        "Set the plugin config with:",
        '  openclaw config set plugins.entries.ocuclaw.config.relayToken "your-token"',
        "The same token must be entered in the OcuClaw app's relay server token field within Even Hub.",
        "Allow OpenClaw to reload, then verify: openclaw plugins inspect ocuclaw --runtime",
        gatewayRestartAdvice(
          "If the gateway is live but the runtime remains stale, run once: openclaw gateway restart --safe",
        ),
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
        "Never put this token in chat or a command argument.",
        "To restore plugin loading while you repair only Even AI, disable its setting:",
        "  openclaw config set plugins.entries.ocuclaw.config.evenAiEnabled false --strict-json",
        "Allow OpenClaw to reload, then verify: openclaw plugins inspect ocuclaw --runtime",
        "When the plugin is loaded, use private terminal entry: openclaw ocuclaw credential even-ai",
        "Then run openclaw ocuclaw even-ai enable and follow its activation result. Do not restart Cloudways.",
        "Enter the same private token in the Even app's Even AI Agent Configuration, then test a real glasses request.",
      ].join("\n"),
    );
  }

  const externalDebugToolsEnabled = parseBool(
    pluginConfig.externalDebugToolsEnabled,
    false,
  );

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
    externalDebugToolsEnabled,
    debugAutoArm: parseBool(pluginConfig.debugAutoArm, externalDebugToolsEnabled),
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
    glassesUiLive: resolveGlassesUiLive(
      pluginConfig.glassesUiLive,
      openclawConfig,
      Reflect.get(opts, "logger"),
    ),
    silentInputJev: resolveSilentInputJev(pluginConfig.silentInputJev, openclawConfig, env),
    freshnessWindowMs: parseIntOrDefault(pluginConfig.freshnessWindowMs, 5000),
  };
}

module.exports = { createRuntimeConfig, OPENCLAW_BUNDLE_DEFAULT_WS_PORT, HERMES_BUNDLE_DEFAULT_WS_PORT, HERMES_FRESH_INSTALL_WS_PORT_CANDIDATES, DEFAULT_STAGE_GRACE_MS, MIN_STAGE_GRACE_MS, MAX_STAGE_GRACE_MS, resolveSilentInputJev };
