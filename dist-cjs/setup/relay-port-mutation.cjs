const { OPENCLAW_BUNDLE_DEFAULT_WS_PORT } = require("../config/runtime-config.cjs");
const { CLOUDWAYS_RESTART_NOTE, isCloudwaysManagedHost } = require("./cloudways-host.cjs");
const { supersedeRelayPortMarker } = require("../config/relay-port-default.cjs");

const SET_RELAY_PORT_OPERATION = "set_relay_port";
const MIN_RELAY_PORT = 1;
const MAX_RELAY_PORT = 65535;

function isRecord(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedPort(value     ) {
  return Number.isInteger(value) && value >= MIN_RELAY_PORT && value <= MAX_RELAY_PORT;
}

function validateRelayPortMutationParams(params     ) {
  if (
    !isRecord(params) ||
    params.operation !== SET_RELAY_PORT_OPERATION ||
    !boundedPort(params.expectedCurrentPort) ||
    !boundedPort(params.newPort) ||
    params.expectedCurrentPort === params.newPort ||
    Object.keys(params).some(
      (key) => !["operation", "expectedCurrentPort", "newPort"].includes(key),
    )
  ) {
    const err      = new Error(
      "invalid_input: set_relay_port requires distinct expectedCurrentPort and newPort integers from 1 through 65535",
    );
    err.code = "invalid_input";
    throw err;
  }
  return {
    operation: SET_RELAY_PORT_OPERATION,
    expectedCurrentPort: params.expectedCurrentPort,
    newPort: params.newPort,
  };
}

function explicitRelayPort(config     ) {
  const value = config?.plugins?.entries?.ocuclaw?.config?.wsPort;
  return value === undefined ? OPENCLAW_BUNDLE_DEFAULT_WS_PORT : value;
}

function stalePrecondition(expected     , actual     ) {
  const err      = new Error(
    `stale_precondition: expected current relay port ${expected}, but it is ${boundedPort(actual) ? actual : "not a valid port"}`,
  );
  err.code = "stale_precondition";
  return err;
}

function ensurePluginConfig(draft     ) {
  if (!isRecord(draft.plugins)) draft.plugins = {};
  if (!isRecord(draft.plugins.entries)) draft.plugins.entries = {};
  if (!isRecord(draft.plugins.entries.ocuclaw)) {
    draft.plugins.entries.ocuclaw = {};
  }
  if (!isRecord(draft.plugins.entries.ocuclaw.config)) {
    draft.plugins.entries.ocuclaw.config = {};
  }
  return draft.plugins.entries.ocuclaw.config;
}

function boundedMutationError(code     , message     ) {
  const err      = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

function createRelayPortMutation(api     ) {
  const runtimeConfig = api?.runtime?.config;
  return async function setRelayPort(rawParams     ) {
    const params = validateRelayPortMutationParams(rawParams);
    if (
      !runtimeConfig ||
      typeof runtimeConfig.current !== "function" ||
      typeof runtimeConfig.mutateConfigFile !== "function"
    ) {
      throw boundedMutationError(
        "unsupported_host",
        "this OpenClaw host does not expose the required config mutation contract",
      );
    }

    const current = runtimeConfig.current();
    const currentPort = explicitRelayPort(current);
    if (currentPort !== params.expectedCurrentPort) {
      throw stalePrecondition(params.expectedCurrentPort, currentPort);
    }

    let mutation     ;
    try {
      mutation = await runtimeConfig.mutateConfigFile({
        afterWrite: {
          mode: "restart",
          reason: "OcuClaw relay port changed",
        },
        mutate(draft     ) {
          const transactionPort = explicitRelayPort(draft);
          if (transactionPort !== params.expectedCurrentPort) {
            throw stalePrecondition(params.expectedCurrentPort, transactionPort);
          }
          ensurePluginConfig(draft).wsPort = params.newPort;
          return {
            previousPort: params.expectedCurrentPort,
            newPort: params.newPort,
          };
        },
      });
    } catch (err     ) {
      if (err?.code === "stale_precondition") throw err;
      if (
        err?.name === "ConfigMutationConflictError" ||
        err?.code === "CONFIG_MUTATION_CONFLICT"
      ) {
        throw boundedMutationError(
          "config_conflict",
          "the OpenClaw configuration changed before the relay-port write could commit",
        );
      }
      throw boundedMutationError(
        "mutation_failed",
        "OpenClaw did not persist the relay-port change",
      );
    }

    const persistedPort = explicitRelayPort(mutation?.nextConfig);
    if (persistedPort !== params.newPort) {
      throw boundedMutationError(
        "verification_failed",
        "the persisted relay port did not match the requested port",
      );
    }

    try {
      const stateApi = api?.runtime?.state;
      const stateDir =
        stateApi && typeof stateApi.resolveStateDir === "function"
          ? stateApi.resolveStateDir(
              typeof process !== "undefined" ? process.env : undefined,
            )
          : null;
      if (typeof stateDir === "string" && stateDir) {
        supersedeRelayPortMarker({
          stateDir,
          newPort: params.newPort,
          previousPort: params.expectedCurrentPort,
          logger: api?.logger,
        });
      }
    } catch (_) {

    }

    return {
      schemaVersion: 1,
      operation: SET_RELAY_PORT_OPERATION,
      status: "verified",
      target: { pluginId: "ocuclaw", field: "wsPort" },
      change: {
        previousPort: params.expectedCurrentPort,
        newPort: params.newPort,
      },
      verification: {
        status: "passed",
        evidence: "persisted-config-readback",
      },
      followUp: {
        requiresRestart: mutation?.followUp?.requiresRestart === true,
      },
    };
  };
}

function createRelayPortApprovalHook() {
  return async function requireRelayPortApproval(event     ) {
    if (
      event?.toolName !== "ocuclaw_setup" ||
      event?.params?.operation !== SET_RELAY_PORT_OPERATION
    ) {
      return;
    }
    let params;
    try {
      params = validateRelayPortMutationParams(event.params);
    } catch (err     ) {
      return {
        block: true,
        blockReason: err.message,
      };
    }
    return {
      requireApproval: {
        title: "Change OcuClaw relay port",
        description:
          `Change the local OcuClaw relay port from ${params.expectedCurrentPort} to ${params.newPort}. ` +
          (isCloudwaysManagedHost()
            ? CLOUDWAYS_RESTART_NOTE
            : "This requires a gateway restart and briefly interrupts connected clients."),
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: 120_000,
        timeoutBehavior: "deny",
      },
    };
  };
}

module.exports = { SET_RELAY_PORT_OPERATION, MIN_RELAY_PORT, MAX_RELAY_PORT, validateRelayPortMutationParams, createRelayPortMutation, createRelayPortApprovalHook };
