const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { hostIsCloudways, hostSummary, isCloudwaysManagedHost } = require("./cloudways-host.cjs");

const PROVISION_RELAY_CREDENTIAL_OPERATION = "provision_relay_credential";

function provisionFollowUp(requiresRestart, host = null) {

  let resolved = typeof host === "function" ? safeCall(host) : host;
  if (!resolved || typeof resolved !== "object") resolved = safeHostSummary();
  if (resolved && resolved.managed === "cloudways") {
    return {
      requiresRestart: false,
      evidence: "cloudways-managed-host-hot-reload",
      instruction:
        "The relay picks this credential up by hot reload. Wait about 5 seconds and re-read journey; the relay should report running. Never run `openclaw gateway restart` on this host: it is a no-op, and the only real restart bounces the whole container. See references/cloudways.md.",
    };
  }
  return { requiresRestart: requiresRestart === true };
}

const PROVISION_APPROVAL_BODY =
  "Let this host generate a private Relay Credential and store it at " +
  "plugins.entries.ocuclaw.config.relayToken. It runs only when no credential is " +
  "configured: an existing credential is preserved and never rotated, so already " +
  "paired phones keep working. The value is created on this host, is never shown " +
  "to the assistant and never written to logs or receipts. ";

const PROVISION_APPROVAL_RESTART_SENTENCE =
  "The gateway must restart before the relay uses it.";

const PROVISION_APPROVAL_HOT_RELOAD_SENTENCE =
  "The relay loads it by itself; no gateway restart is needed on this host.";

function provisionApprovalDescription(host = undefined) {
  let resolved = typeof host === "function" ? safeCall(host) : host;
  const cloudways = resolved === undefined || resolved === null
    ? isCloudwaysManagedHost()
    : hostIsCloudways(resolved);
  return PROVISION_APPROVAL_BODY + (cloudways
    ? PROVISION_APPROVAL_HOT_RELOAD_SENTENCE
    : PROVISION_APPROVAL_RESTART_SENTENCE);
}

function safeHostSummary() {
  try {
    return hostSummary();
  } catch (_) {
    return null;
  }
}

function safeCall(factory) {
  try {
    return factory();
  } catch (_) {
    return null;
  }
}

const CREDENTIAL_BYTES = 32;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateProvisionRelayCredentialParams(params) {
  if (
    !isRecord(params) ||
    params.operation !== PROVISION_RELAY_CREDENTIAL_OPERATION ||
    Object.keys(params).some((key) => key !== "operation")
  ) {
    const err = new Error(
      "invalid_input: provision_relay_credential takes no arguments; the credential is generated on the host and is never supplied by a caller",
    );
    err.code = "invalid_input";
    throw err;
  }
  return { operation: PROVISION_RELAY_CREDENTIAL_OPERATION };
}

function boundedProvisionError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

function classifyConfiguredRelayCredential(config) {
  if (!isRecord(config)) return "ambiguous";
  for (const key of ["plugins", "entries", "ocuclaw", "config"]) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) return "absent";
    config = config[key];

    if (config === undefined || config === null) return "absent";
    if (!isRecord(config)) return "ambiguous";
  }
  if (!Object.prototype.hasOwnProperty.call(config, "relayToken")) return "absent";
  const value = config.relayToken;
  if (value === undefined) return "absent";
  if (typeof value !== "string") return "ambiguous";
  return value.trim().length === 0 ? "empty" : "present";
}

function describeValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

function describeRelayCredentialAmbiguity(config) {
  if (!isRecord(config)) {
    return `the host configuration document is not an object (found ${describeValueType(config)})`;
  }
  let node = config;
  let traversed = "";
  for (const key of ["plugins", "entries", "ocuclaw", "config"]) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) return null;
    node = node[key];
    traversed = traversed ? `${traversed}.${key}` : key;
    if (node === undefined || node === null) return null;
    if (!isRecord(node)) {
      return `${traversed} is not an object (found ${describeValueType(node)})`;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(node, "relayToken")) return null;
  const value = node.relayToken;
  if (value === undefined) return null;
  if (typeof value !== "string") {
    return `plugins.entries.ocuclaw.config.relayToken is not a string (found ${describeValueType(value)})`;
  }
  return null;
}

function ambiguityDetail(config) {
  return (
    describeRelayCredentialAmbiguity(config) ??
    "the shape of the OcuClaw configuration branch could not be assessed"
  );
}

function ensurePluginConfig(draft) {
  if (!isRecord(draft.plugins)) draft.plugins = {};
  if (!isRecord(draft.plugins.entries)) draft.plugins.entries = {};
  if (!isRecord(draft.plugins.entries.ocuclaw)) draft.plugins.entries.ocuclaw = {};
  if (!isRecord(draft.plugins.entries.ocuclaw.config)) {
    draft.plugins.entries.ocuclaw.config = {};
  }
  return draft.plugins.entries.ocuclaw.config;
}

function readOnlyHostError(target) {
  return boundedProvisionError(
    "read_only_host",
    `this OpenClaw configuration is externally managed and not writable by the gateway process (${target}); the deployment owner must provision plugins.entries.ocuclaw.config.relayToken in the managed source. No write was attempted.`,
  );
}

function probeConfigWritable(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    return { decided: false, writable: null, evidence: "config-path-unavailable" };
  }
  let stats = null;
  try {
    stats = fs.statSync(configPath);
  } catch (_) {
    stats = null;
  }
  if (stats) {
    try {
      fs.accessSync(configPath, fs.constants.W_OK);
    } catch (_) {
      return { decided: true, writable: false, evidence: "config-file-not-writable" };
    }
  }

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    return { decided: false, writable: null, evidence: "config-directory-absent" };
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch (_) {
    return { decided: true, writable: false, evidence: "config-directory-not-writable" };
  }
  return { decided: true, writable: true, evidence: "config-path-writable" };
}

function resolveUserPath(value, environment) {
  const raw = String(value).trim();
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    const home =
      typeof environment.HOME === "string" && environment.HOME.length > 0
        ? environment.HOME
        : typeof os.homedir === "function"
          ? os.homedir()
          : "";
    if (home) {
      const rest = raw.slice(1).replace(/^[\\/]/, "");
      return path.resolve(rest ? path.join(home, rest) : home);
    }
  }
  return path.resolve(raw);
}

function resolveHostConfigPath(api, env) {
  const environment = isRecord(env) ? env : {};
  const override = environment.OPENCLAW_CONFIG_PATH;
  if (typeof override === "string" && override.trim().length > 0) {
    return resolveUserPath(override, environment);
  }
  const stateApi = api && api.runtime && api.runtime.state;
  if (stateApi && typeof stateApi.resolveStateDir === "function") {
    try {
      const stateDir = stateApi.resolveStateDir(environment);
      if (typeof stateDir === "string" && stateDir) {
        return path.join(stateDir, "openclaw.json");
      }
    } catch (_) {

    }
  }
  return null;
}

const PROVISION_AFTER_WRITE_RESTART = Object.freeze({
  mode: "restart",
  reason: "OcuClaw relay credential provisioned",
});

function createRelayCredentialProvision(api, options = {}) {
  const runtimeConfig = api?.runtime?.config;

  const loadedAtBootOption = isRecord(options) ? options.relayCredentialLoadedAtBoot : undefined;
  const resolveLoadedAtBoot = () =>
    typeof loadedAtBootOption === "function" ? loadedAtBootOption() : loadedAtBootOption;

  const afterWrite = isRecord(options) && isRecord(options.afterWrite)
    ? options.afterWrite
    : PROVISION_AFTER_WRITE_RESTART;
  return async function provisionRelayCredential(rawParams) {
    const loadedAtBoot = resolveLoadedAtBoot();
    validateProvisionRelayCredentialParams(rawParams);
    if (
      !runtimeConfig ||
      typeof runtimeConfig.current !== "function" ||
      typeof runtimeConfig.mutateConfigFile !== "function"
    ) {
      throw boundedProvisionError(
        "unsupported_host",
        "this OpenClaw host does not expose the required config mutation contract; configure plugins.entries.ocuclaw.config.relayToken through the manual setup step instead",
      );
    }

    let current;
    try {
      current = runtimeConfig.current();
    } catch (_) {
      throw boundedProvisionError(
        "config_unreadable",
        "OpenClaw could not read its current configuration, so no credential state could be verified; repair the configuration through an operator-owned OpenClaw surface, then re-run setup. Nothing was changed.",
      );
    }

    const existing = classifyConfiguredRelayCredential(current);
    if (existing === "ambiguous") {
      throw boundedProvisionError(
        "ambiguous_existing_credential",
        `the OcuClaw configuration branch in this host configuration cannot be assessed: ${ambiguityDetail(current)}; the deployment owner must repair it through an operator-owned OpenClaw surface before a credential can be provisioned. Nothing was changed and no credential was replaced.`,
      );
    }
    if (existing === "present") {

      const configuredSinceBoot = loadedAtBoot === false;
      return {
        schemaVersion: 1,
        operation: PROVISION_RELAY_CREDENTIAL_OPERATION,
        status: "preserved",
        target: { pluginId: "ocuclaw", field: "relayToken" },
        credential: {
          presence: "present",
          origin: "pre-existing",
          rotated: false,
          disclosure: "never-in-model-output-logs-or-receipts",
        },
        verification: {
          status: "passed",
          evidence: configuredSinceBoot
            ? "credential-configured-since-boot"
            : "existing-credential-presence",
        },
        followUp: provisionFollowUp(configuredSinceBoot, options && options.hostSummary),
      };
    }

    const configPath = resolveHostConfigPath(
      api,
      typeof process !== "undefined" ? process.env : undefined,
    );
    const writable = probeConfigWritable(configPath);
    if (writable.decided && writable.writable === false) {
      throw readOnlyHostError(writable.evidence);
    }

    const provisioned = randomBytes(CREDENTIAL_BYTES).toString("base64url");
    let mutation;
    try {
      mutation = await runtimeConfig.mutateConfigFile({

        afterWrite: { ...afterWrite },
        mutate(draft, context) {

          const snapshotPath = context?.snapshot?.path;
          if (typeof snapshotPath === "string" && snapshotPath.length > 0) {
            const snapshotWritable = probeConfigWritable(snapshotPath);
            if (snapshotWritable.decided && snapshotWritable.writable === false) {
              throw readOnlyHostError(snapshotWritable.evidence);
            }
          }

          const inTransaction = classifyConfiguredRelayCredential(draft);
          if (inTransaction === "ambiguous") {
            const file =
              typeof snapshotPath === "string" && snapshotPath.length > 0
                ? ` at ${snapshotPath}`
                : "";
            throw boundedProvisionError(
              "ambiguous_existing_credential",
              `the OcuClaw branch of the ON-DISK OpenClaw configuration${file} cannot be assessed and differs from the loaded snapshot this operation read: ${ambiguityDetail(draft)}; the deployment owner must repair that file through an operator-owned OpenClaw surface, then re-run setup. Nothing was written and no credential was replaced.`,
            );
          }
          if (inTransaction === "present") {
            throw boundedProvisionError(
              "stale_precondition",
              "a relay credential was configured before this write could commit; the existing credential was preserved and nothing was rotated — re-read setup state before acting",
            );
          }
          ensurePluginConfig(draft).relayToken = provisioned;
          return { provisioned: true };
        },
      });
    } catch (err) {
      if (
        err?.code === "stale_precondition" ||
        err?.code === "read_only_host" ||
        err?.code === "ambiguous_existing_credential"
      ) {
        throw err;
      }
      if (
        err?.name === "ConfigMutationConflictError" ||
        err?.code === "CONFIG_MUTATION_CONFLICT"
      ) {
        throw boundedProvisionError(
          "config_conflict",
          "the OpenClaw configuration changed before the relay-credential write could commit; re-read setup state and provision again. No credential was recorded.",
        );
      }

      if (
        err?.name === "NixModeConfigMutationError" ||
        err?.code === "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE"
      ) {
        throw readOnlyHostError("host-config-immutable-nix-mode");
      }
      if (err?.code === "EACCES" || err?.code === "EPERM" || err?.code === "EROFS") {
        throw readOnlyHostError(`config-write-refused-${String(err.code).toLowerCase()}`);
      }

      const hostError = {
        name: typeof err?.name === "string" ? err.name : null,
        code: typeof err?.code === "string" ? err.code : null,
        message: typeof err?.message === "string" ? err.message : null,
      };
      const failure = boundedProvisionError(
        "mutation_failed",
        `OpenClaw did not confirm the relay-credential write; treat credential state as unknown and re-read setup state before retrying. Host error: ${JSON.stringify(hostError)}`,
      );
      failure.hostError = hostError;
      throw failure;
    }

    const persisted = mutation?.nextConfig?.plugins?.entries?.ocuclaw?.config?.relayToken;
    if (typeof persisted !== "string" || persisted !== provisioned) {
      throw boundedProvisionError(
        "verification_failed",
        "the persisted OpenClaw configuration did not read back the provisioned relay credential; re-read setup state before retrying and do not assume a credential is configured",
      );
    }

    return {
      schemaVersion: 1,
      operation: PROVISION_RELAY_CREDENTIAL_OPERATION,
      status: "provisioned",
      target: { pluginId: "ocuclaw", field: "relayToken" },
      credential: {
        presence: "present",
        origin: "host-generated",
        rotated: false,
        disclosure: "never-in-model-output-logs-or-receipts",
      },
      verification: { status: "passed", evidence: "persisted-config-readback" },
      followUp: provisionFollowUp(mutation?.followUp?.requiresRestart, options && options.hostSummary),
    };
  };
}

function relayCredentialProvisioningCapability(api) {
  if (api?.registrationMode !== "full") return "unavailable";
  const runtimeConfig = api?.runtime?.config;
  return runtimeConfig &&
    typeof runtimeConfig.current === "function" &&
    typeof runtimeConfig.mutateConfigFile === "function" &&
    typeof api?.registerTool === "function"
    ? "available"
    : "unavailable";
}

function createRelayCredentialApprovalHook(options = {}) {
  return async function requireRelayCredentialApproval(event) {
    if (
      event?.toolName !== "ocuclaw_setup" ||
      event?.params?.operation !== PROVISION_RELAY_CREDENTIAL_OPERATION
    ) {
      return;
    }
    try {
      validateProvisionRelayCredentialParams(event.params);
    } catch (err) {
      return {
        block: true,
        blockReason: err.message,
      };
    }
    return {
      requireApproval: {
        title: "Create a private OcuClaw Relay Credential",
        description: provisionApprovalDescription(options && options.hostSummary),
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: 120_000,
        timeoutBehavior: "deny",
      },
    };
  };
}

module.exports = { PROVISION_RELAY_CREDENTIAL_OPERATION, provisionFollowUp, PROVISION_APPROVAL_RESTART_SENTENCE, PROVISION_APPROVAL_HOT_RELOAD_SENTENCE, provisionApprovalDescription, validateProvisionRelayCredentialParams, classifyConfiguredRelayCredential, describeRelayCredentialAmbiguity, probeConfigWritable, resolveHostConfigPath, PROVISION_AFTER_WRITE_RESTART, createRelayCredentialProvision, relayCredentialProvisioningCapability, createRelayCredentialApprovalHook };
