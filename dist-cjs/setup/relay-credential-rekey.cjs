const { randomBytes } = require("node:crypto");
const WebSocket = require("ws");

const { classifyConfiguredRelayCredential, probeConfigWritable, resolveHostConfigPath } = require("./relay-credential-provision.cjs");

const REKEY_CONFIRMATION_WORD = "reset";

const REKEY_WARNING =
  "A new key immediately disconnects every paired phone. The old key stops " +
  "working for good, and each phone must pair again with a new phone code.";

const REKEY_AFTER_WRITE = Object.freeze({
  mode: "restart",
  reason: "OcuClaw relay credential replaced at the wearer's request",
});

const CREDENTIAL_BYTES = 32;

const REKEY_RELAY_SWAP_DEADLINE_MS = 60_000;
const REKEY_RELAY_SWAP_INTERVAL_MS = 1_000;

const RELAY_ADMISSION_GRACE_MS = 400;
const RELAY_CONNECT_TIMEOUT_MS = 2_000;

function rekeyError(code     , message     ) {
  const err      = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

function readOnlyHostError(target     ) {
  return rekeyError(
    "read_only_host",
    `this OpenClaw configuration is externally managed and not writable by this process (${target}); the key was not changed.`,
  );
}

function ensurePluginConfig(draft     ) {
  return draft.plugins.entries.ocuclaw.config;
}

function createRelayCredentialRekey(api     , deps      = {}) {
  const runtimeConfig = api?.runtime?.config;
  const generate = typeof deps.generate === "function"
    ? deps.generate
    : () => randomBytes(CREDENTIAL_BYTES).toString("base64url");
  return async function rekeyRelayCredential(params      = {}) {
    const previous = typeof params?.previous === "string" ? params.previous : "";
    if (!previous) {
      throw rekeyError("credential_missing", "there is no present relay credential to replace; the key was not changed.");
    }
    if (
      !runtimeConfig ||
      typeof runtimeConfig.current !== "function" ||
      typeof runtimeConfig.mutateConfigFile !== "function"
    ) {
      throw rekeyError("unsupported_host", "this OpenClaw host does not expose the config mutation contract; the key was not changed.");
    }
    const configPath = resolveHostConfigPath(api, typeof process !== "undefined" ? process.env : undefined);
    const writable = probeConfigWritable(configPath);
    if (writable.decided && writable.writable === false) throw readOnlyHostError(writable.evidence);

    const replacement = String(generate() || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(replacement) || replacement === previous) {
      throw rekeyError("generation_failed", "a strong new key could not be generated; the key was not changed.");
    }

    let mutation     ;
    try {
      mutation = await runtimeConfig.mutateConfigFile({
        afterWrite: { ...REKEY_AFTER_WRITE },
        mutate(draft     , context     ) {
          const snapshotPath = context?.snapshot?.path;
          if (typeof snapshotPath === "string" && snapshotPath.length > 0) {
            const snapshotWritable = probeConfigWritable(snapshotPath);
            if (snapshotWritable.decided && snapshotWritable.writable === false) {
              throw readOnlyHostError(snapshotWritable.evidence);
            }
          }
          if (
            classifyConfiguredRelayCredential(draft) !== "present" ||
            draft.plugins.entries.ocuclaw.config.relayToken !== previous
          ) {
            throw rekeyError(
              "stale_precondition",
              "the relay credential changed before the new key could be written; nothing was written. Run the command again.",
            );
          }
          ensurePluginConfig(draft).relayToken = replacement;
          return { rekeyed: true };
        },
      });
    } catch (err     ) {
      if (err?.code === "stale_precondition" || err?.code === "read_only_host") throw err;
      if (err?.name === "ConfigMutationConflictError" || err?.code === "CONFIG_MUTATION_CONFLICT") {
        throw rekeyError("config_conflict", "the OpenClaw configuration changed during the write; the key was not changed. Run the command again.");
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

      throw rekeyError("mutation_failed", "OpenClaw did not confirm the write, so it is unknown which key is saved. Run openclaw ocuclaw doctor before trying again.");
    }

    const persisted = mutation?.nextConfig?.plugins?.entries?.ocuclaw?.config?.relayToken;
    if (typeof persisted !== "string" || persisted !== replacement) {
      throw rekeyError("verification_failed", "the saved configuration did not read back the new key, so it is unknown which key is saved. Run openclaw ocuclaw doctor before trying again.");
    }
    return { status: "rekeyed", credential: replacement };
  };
}

function verifyRelayCredential(port     , credential     , options      = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : RELAY_ADMISSION_GRACE_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : RELAY_CONNECT_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof credential !== "string" || !credential) {
      resolve("unreachable");
      return;
    }
    let ws      = null;
    let settled = false;
    let grace      = null;
    const settle = (outcome     ) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (grace) clearTimeout(grace);
      try { ws?.terminate(); } catch (_) {  }
      resolve(outcome);
    };
    const connectTimer = setTimeout(() => settle("unreachable"), timeoutMs);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(credential)}`, {
        handshakeTimeout: timeoutMs,
      });
    } catch (_) {
      settle("unreachable");
      return;
    }
    ws.once("open", () => {
      clearTimeout(connectTimer);
      grace = setTimeout(() => settle("accepted"), graceMs);
    });
    ws.once("close", (code     ) => settle(code === 4001 ? "rejected" : "unreachable"));
    ws.once("error", () => settle("unreachable"));
    ws.once("unexpected-response", () => settle("unreachable"));
  });
}

async function awaitRelayCredentialSwap(params     , deps      = {}) {
  const verify = typeof deps.verify === "function" ? deps.verify : verifyRelayCredential;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === "function"
    ? deps.sleep
    : (ms     ) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadlineMs = Number.isFinite(params?.deadlineMs) ? params.deadlineMs : REKEY_RELAY_SWAP_DEADLINE_MS;
  const intervalMs = Number.isFinite(params?.intervalMs) ? params.intervalMs : REKEY_RELAY_SWAP_INTERVAL_MS;
  const deadline = now() + deadlineMs;
  let replacement = "unreachable";
  for (;;) {
    replacement = await verify(params.port, params.replacement);
    if (replacement === "accepted" || now() >= deadline) break;
    await sleep(intervalMs);
  }
  if (replacement !== "accepted") return { replacement, previous: "not_checked" };
  const previous = await verify(params.port, params.previous);
  return { replacement, previous };
}

module.exports = { REKEY_CONFIRMATION_WORD, REKEY_WARNING, REKEY_AFTER_WRITE, REKEY_RELAY_SWAP_DEADLINE_MS, createRelayCredentialRekey, verifyRelayCredential, awaitRelayCredentialSwap };
