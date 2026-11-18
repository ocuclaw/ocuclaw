const { normalizeEvenAiDefaultModel } = require("./even-ai-settings-store.cjs");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY, EVEN_AI_THROWAWAY_SESSION_PREFIX, isHermesEvenAiSessionKey } = require("../domain/even-ai-session-keys.cjs");

function trimString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeSessionKey(value) {
  return trimString(value).toLowerCase();
}

function parseModelRef(value) {
  const normalized = normalizeEvenAiDefaultModel(value);
  if (!normalized) {
    return null;
  }
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash >= normalized.length - 1) {
    return {
      modelOverride: normalized,
    };
  }
  const providerOverride = normalized.slice(0, slash).trim();
  const modelOverride = normalized.slice(slash + 1).trim();
  if (!providerOverride || !modelOverride) {
    return {
      modelOverride: normalized,
    };
  }
  return {
    providerOverride,
    modelOverride,
  };
}

function isEvenAiModelHookSession(sessionKey, dedicatedSessionKey) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return false;
  }
  if (
    normalizedSessionKey === DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY ||
    normalizedSessionKey.startsWith(EVEN_AI_THROWAWAY_SESSION_PREFIX) ||
    isHermesEvenAiSessionKey(normalizedSessionKey)
  ) {
    return true;
  }
  const normalizedDedicatedKey = normalizeSessionKey(dedicatedSessionKey);
  return !!normalizedDedicatedKey && normalizedSessionKey === normalizedDedicatedKey;
}

function createEvenAiModelHook(opts = {}) {
  const getSettingsSnapshot =
    typeof opts.getSettingsSnapshot === "function"
      ? opts.getSettingsSnapshot
      : () => ({});
  const getDedicatedSessionKey =
    typeof opts.getDedicatedSessionKey === "function"
      ? opts.getDedicatedSessionKey
      : () => opts.dedicatedSessionKey;

  return function evenAiBeforeModelResolve(_event, ctx) {
    const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
    if (!isEvenAiModelHookSession(sessionKey, getDedicatedSessionKey())) {
      return;
    }
    const settings = getSettingsSnapshot() || {};
    const parsed = parseModelRef(settings.defaultModel);
    if (!parsed || !parsed.modelOverride) {
      return;
    }
    return parsed;
  };
}

module.exports = { createEvenAiModelHook };
