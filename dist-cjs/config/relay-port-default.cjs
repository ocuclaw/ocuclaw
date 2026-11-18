const fs = require("node:fs");
const path = require("node:path");
const { OPENCLAW_BUNDLE_DEFAULT_WS_PORT } = require("./runtime-config.cjs");
const { PLUGIN_VERSION } = require("../version.cjs");

const FRESH_INSTALL_DEFAULT_WS_PORT = 47800;
const RELAY_PORT_MARKER_FILE = "ocuclaw-relay-port.json";
const MARKER_SCHEMA_VERSION = 1;

const LEGACY_STATE_EVIDENCE_EXTRA_FILES = ["even-ai-settings.json", "debug-arm.json"];

function isValidPort(value     ) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function hasExplicitWsPort(pluginConfig     ) {
  return (
    pluginConfig !== null &&
    typeof pluginConfig === "object" &&
    !Array.isArray(pluginConfig) &&
    Object.prototype.hasOwnProperty.call(pluginConfig, "wsPort") &&
    pluginConfig.wsPort !== undefined &&
    pluginConfig.wsPort !== null &&
    pluginConfig.wsPort !== ""
  );
}

function readMarker(stateDir     , fsImpl     ) {
  try {
    const raw = fsImpl.readFileSync(path.join(stateDir, RELAY_PORT_MARKER_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schemaVersion === MARKER_SCHEMA_VERSION &&
      isValidPort(parsed.port) &&
      (parsed.origin === "fresh-default" || parsed.origin === "legacy-preserve")
    ) {
      return parsed;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function readRelayPortMarker(stateDir     , fsImpl      = fs) {
  const dir = typeof stateDir === "string" && stateDir ? stateDir : null;
  if (!dir) return null;
  return readMarker(dir, fsImpl);
}

function hasLegacyStateEvidence(stateDir     , fsImpl     ) {
  let entries;
  try {
    entries = fsImpl.readdirSync(stateDir);
  } catch (_) {

    return true;
  }
  return entries.some(
    (name     ) =>
      (name.startsWith("ocuclaw-") &&
        name.endsWith(".json") &&
        name !== RELAY_PORT_MARKER_FILE) ||
      LEGACY_STATE_EVIDENCE_EXTRA_FILES.includes(name),
  );
}

function resolveRelayPortDecision(opts      = {}) {
  const fsImpl = opts.fsImpl || fs;
  const stateDir = typeof opts.stateDir === "string" && opts.stateDir ? opts.stateDir : null;
  if (!stateDir) {

    return { port: OPENCLAW_BUNDLE_DEFAULT_WS_PORT, origin: "no-state-dir", persistMarker: false };
  }
  const marker = readMarker(stateDir, fsImpl);
  if (marker) {
    return { port: marker.port, origin: marker.origin, persistMarker: false };
  }
  if (hasLegacyStateEvidence(stateDir, fsImpl)) {
    return {
      port: OPENCLAW_BUNDLE_DEFAULT_WS_PORT,
      origin: "legacy-preserve",
      persistMarker: true,
    };
  }
  return {
    port: FRESH_INSTALL_DEFAULT_WS_PORT,
    origin: "fresh-default",
    persistMarker: true,
  };
}

function persistRelayPortMarker(opts      = {}) {
  const fsImpl = opts.fsImpl || fs;
  const decision = opts.decision;
  if (
    !opts.stateDir ||
    !decision ||
    decision.persistMarker !== true ||
    !isValidPort(decision.port)
  ) {
    return false;
  }
  try {
    fsImpl.writeFileSync(
      path.join(opts.stateDir, RELAY_PORT_MARKER_FILE),
      JSON.stringify(
        {
          schemaVersion: MARKER_SCHEMA_VERSION,
          port: decision.port,
          origin: decision.origin,
          decidedAt: new Date().toISOString(),
          pluginVersion: PLUGIN_VERSION,
        },
        null,
        2,
      ) + "\n",
    );
    return true;
  } catch (err     ) {
    if (opts.logger && typeof opts.logger.warn === "function") {
      opts.logger.warn(
        `[ocuclaw] could not persist relay-port marker: ${err && err.message}`,
      );
    }
    return false;
  }
}

function supersedeRelayPortMarker(opts      = {}) {
  const fsImpl = opts.fsImpl || fs;
  const stateDir =
    typeof opts.stateDir === "string" && opts.stateDir ? opts.stateDir : null;
  if (!stateDir || !isValidPort(opts.newPort)) {
    return false;
  }
  const existing = readMarker(stateDir, fsImpl);
  if (!existing) {

    return false;
  }
  if (existing.port === opts.newPort) {

    return false;
  }
  const markerPath = path.join(stateDir, RELAY_PORT_MARKER_FILE);

  let raw      = { ...existing };
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(markerPath, "utf8"));
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch (_) {

  }
  const next = {
    ...raw,
    schemaVersion: MARKER_SCHEMA_VERSION,
    port: opts.newPort,
    origin: existing.origin,
    supersededBy: {
      source: "set_relay_port",
      port: opts.newPort,
      previousPort: isValidPort(opts.previousPort) ? opts.previousPort : existing.port,
      at: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
    },
  };
  try {
    fsImpl.writeFileSync(markerPath, JSON.stringify(next, null, 2) + "\n");
    return true;
  } catch (err     ) {
    if (opts.logger && typeof opts.logger.warn === "function") {
      opts.logger.warn(
        `[ocuclaw] could not supersede relay-port marker: ${err && err.message}`,
      );
    }
    return false;
  }
}

function ensurePluginConfigDraft(draft     ) {
  if (!draft.plugins || typeof draft.plugins !== "object") draft.plugins = {};
  if (!draft.plugins.entries || typeof draft.plugins.entries !== "object") {
    draft.plugins.entries = {};
  }
  if (!draft.plugins.entries.ocuclaw || typeof draft.plugins.entries.ocuclaw !== "object") {
    draft.plugins.entries.ocuclaw = {};
  }
  if (
    !draft.plugins.entries.ocuclaw.config ||
    typeof draft.plugins.entries.ocuclaw.config !== "object"
  ) {
    draft.plugins.entries.ocuclaw.config = {};
  }
  return draft.plugins.entries.ocuclaw.config;
}

function createFreshWsPortConfigWriter(api     ) {
  const runtimeConfig = api?.runtime?.config;
  if (
    !runtimeConfig ||
    typeof runtimeConfig.mutateConfigFile !== "function"
  ) {
    return null;
  }
  return async function persistFreshWsPortConfig(port     ) {
    if (!isValidPort(port)) {
      return { written: false, reason: "invalid-port" };
    }

    let outcome      = { written: false, reason: "mutation-not-run" };
    await runtimeConfig.mutateConfigFile({
      afterWrite: {
        mode: "none",
        reason: "OcuClaw fresh-install relay port default",
      },
      mutate(draft     ) {
        const cfg = ensurePluginConfigDraft(draft);
        if (hasExplicitWsPort(cfg)) {

          outcome = {
            written: false,
            reason: "already-set",
            existingPort: isValidPort(cfg.wsPort) ? cfg.wsPort : null,
          };
          return outcome;
        }
        cfg.wsPort = port;
        outcome = { written: true };
        return outcome;
      },
    });
    return outcome;
  };
}

module.exports = { FRESH_INSTALL_DEFAULT_WS_PORT, RELAY_PORT_MARKER_FILE, hasExplicitWsPort, readRelayPortMarker, resolveRelayPortDecision, persistRelayPortMarker, supersedeRelayPortMarker, createFreshWsPortConfigWriter };
