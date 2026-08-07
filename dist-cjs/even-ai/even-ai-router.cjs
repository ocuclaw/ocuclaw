const { normalizeEvenAiRoutingMode } = require("./even-ai-settings-store.cjs");
const { DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY, } = require("../domain/even-ai-session-keys.cjs");

function normalizeSessionKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function defaultDedicatedSessionKeyValidator(value) {
  return typeof value === "string" &&
    value.toLowerCase().startsWith("ocuclaw:");
}

function normalizeDedicatedSessionKey(
  value,
  defaultSessionKey,
  validator,
) {
  const normalized = normalizeSessionKey(value);
  return normalized && validator(normalized) ? normalized : defaultSessionKey;
}

function createEvenAiRouter(opts = {}) {
  const sessionService = opts.sessionService;
  if (!sessionService || typeof sessionService.ensureSessionKey !== "function") {
    throw new Error("Even AI router requires sessionService.ensureSessionKey()");
  }

  const getRoutingMode =
    typeof opts.getRoutingMode === "function"
      ? opts.getRoutingMode
      : () => opts.routingMode;
  const configuredDefaultDedicatedSessionKey = Reflect.get(
    opts,
    "defaultDedicatedSessionKey",
  );
  const configuredValidator = Reflect.get(opts, "validator");
  const configuredDetachedSessionKeyPrefix = Reflect.get(
    opts,
    "detachedSessionKeyPrefix",
  );
  const defaultDedicatedSessionKey =
    normalizeSessionKey(configuredDefaultDedicatedSessionKey) ||
    DEFAULT_EVEN_AI_DEDICATED_SESSION_KEY;
  const dedicatedSessionKeyValidator =
    typeof configuredValidator === "function"
      ? configuredValidator
      : defaultDedicatedSessionKeyValidator;
  const detachedSessionKeyPrefix =
    normalizeSessionKey(configuredDetachedSessionKeyPrefix) ||
    `${defaultDedicatedSessionKey}:`;
  const dedicatedSessionKey = normalizeDedicatedSessionKey(
    opts.dedicatedSessionKey,
    defaultDedicatedSessionKey,
    dedicatedSessionKeyValidator,
  );

  async function resolveTargetSession(request = { agentRef: "" }) {
    const routingMode = normalizeEvenAiRoutingMode(getRoutingMode());
    const previousSessionKey =
      typeof sessionService.peekSessionKey === "function"
        ? normalizeSessionKey(sessionService.peekSessionKey())
        : null;

    if (routingMode === "background") {
      return {
        routingMode,
        sessionKey: dedicatedSessionKey,
        previousSessionKey,
        sessionChanged: false,
      };
    }

    if (routingMode === "background_new") {
      if (typeof sessionService.createDetachedSessionKey !== "function") {
        throw new Error(
          "Even AI router requires sessionService.createDetachedSessionKey()",
        );
      }
      const sessionKey = normalizeSessionKey(
        await Promise.resolve(
          sessionService.createDetachedSessionKey(detachedSessionKeyPrefix, {
            agentRef:
              typeof request.agentRef === "string" ? request.agentRef.trim() : "",
          }),
        ),
      );
      if (!sessionKey) {
        throw new Error("Even AI router failed to create a detached session key.");
      }
      return {
        routingMode,
        sessionKey,
        previousSessionKey,
        sessionChanged: false,
        sessionMinted: true,
        mintedAgentRef:
          typeof request.agentRef === "string" ? request.agentRef.trim() : "",
      };
    }

    return {
      routingMode: normalizeEvenAiRoutingMode(),
      sessionKey: normalizeSessionKey(sessionService.ensureSessionKey()) || "main",
      previousSessionKey,
      sessionChanged: false,
    };
  }

  return {
    getRoutingMode() {
      return normalizeEvenAiRoutingMode(getRoutingMode());
    },

    getDedicatedSessionKey() {
      return dedicatedSessionKey;
    },

    resolveActiveSession() {
      return normalizeSessionKey(sessionService.ensureSessionKey()) || "main";
    },

    resolveTargetSession,
  };
}

module.exports = { createEvenAiRouter };
