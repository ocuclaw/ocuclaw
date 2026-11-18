const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { codexEngineState } = require("./codex-engine.cjs");
const { CODEX_APP_SERVER_DEFAULT_ARGS, readAgentCodexConfigTomls } = require("./codex-reasoning-summary.cjs");

const CODEX_REQUEST_COMPRESSION_FEATURE = "enable_request_compression";
const CODEX_REQUEST_COMPRESSION_OFF = `features.${CODEX_REQUEST_COMPRESSION_FEATURE}=false`;
const CODEX_APP_SERVER_ARGS_ENV = "OPENCLAW_CODEX_APP_SERVER_ARGS";

const CODEX_REQUEST_COMPRESSION_MARKER = "ocuclaw-codex-request-compression.json";

function isRecord(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const FEATURE_SETTING = new RegExp(`^\\s*features\\.${CODEX_REQUEST_COMPRESSION_FEATURE}\\s*=`);

function argsSetRequestCompression(args          ) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value      = null;
    if (arg === "-c" || arg === "--config") value = args[index + 1];
    else if (arg.startsWith("--config=")) value = arg.slice("--config=".length);
    else if (/^-c.+/.test(arg)) value = arg.slice(2).replace(/^=/, "");
    if (typeof value === "string" && FEATURE_SETTING.test(value)) return true;
    if ((arg === "--enable" || arg === "--disable") && args[index + 1] === CODEX_REQUEST_COMPRESSION_FEATURE) return true;
    if (arg === `--enable=${CODEX_REQUEST_COMPRESSION_FEATURE}` || arg === `--disable=${CODEX_REQUEST_COMPRESSION_FEATURE}`) return true;
  }
  return false;
}

function tomlSetsRequestCompression(text     ) {
  if (typeof text !== "string") return false;
  let table = "";
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]*?)\s*\]/.exec(line);
    if (header) { table = header[1]; continue; }
    if (table === "" && FEATURE_SETTING.test(line)) return true;
    if (table === "features" && new RegExp(`^\\s*${CODEX_REQUEST_COMPRESSION_FEATURE}\\s*=`).test(line)) return true;
  }
  return false;
}

function planCodexRequestCompression(config     , options      = {}) {
  const skip = (reason        ) => ({ status: "skipped", reason });
  if (!codexEngineState(config).inUse) return skip("codex-engine-not-configured");
  if (options.addedBefore === true) return skip("added-before");
  const codexConfig = config?.plugins?.entries?.codex?.config;
  if (codexConfig !== undefined && !isRecord(codexConfig)) return skip("app-server-config-unreadable");
  const appServer = codexConfig?.appServer;
  if (appServer !== undefined && !isRecord(appServer)) return skip("app-server-config-unreadable");
  const server = appServer || {};
  if (server.transport !== undefined && server.transport !== "stdio") return skip("app-server-not-local");

  if (server.homeScope === "user") return skip("native-codex-home");
  if (typeof server.command === "string" && server.command.trim()) return skip("custom-app-server-command");
  let current           = [];
  if (typeof server.args === "string") {

    if (server.args.trim()) return skip("args-string");
  } else if (Array.isArray(server.args)) {
    if (!server.args.every((arg     ) => typeof arg === "string")) return skip("app-server-config-unreadable");
    current = server.args.map((arg        ) => arg.trim()).filter(Boolean);
  } else if (server.args !== undefined) {
    return skip("app-server-config-unreadable");
  }

  const envArgs = options.env && typeof options.env[CODEX_APP_SERVER_ARGS_ENV] === "string" ? options.env[CODEX_APP_SERVER_ARGS_ENV] : "";
  if (current.length === 0 && envArgs.trim()) return skip("args-env");
  if (argsSetRequestCompression(current)) return skip("already-set");
  const tomls = Array.isArray(options.codexConfigTomls) ? options.codexConfigTomls : [];
  if (tomls.some(tomlSetsRequestCompression)) return skip("already-set");
  const base = current.length > 0 ? current : [...CODEX_APP_SERVER_DEFAULT_ARGS];
  const subcommand = base.lastIndexOf("app-server");
  const override = ["-c", CODEX_REQUEST_COMPRESSION_OFF];
  const args = subcommand >= 0
    ? [...base.slice(0, subcommand), ...override, ...base.slice(subcommand)]
    : [...base, ...override];
  return { status: "write", args };
}

function applyCodexRequestCompression(draft     , options      = {}) {
  const plan      = planCodexRequestCompression(draft, options);
  if (plan.status !== "write") return plan;
  if (!isRecord(draft.plugins)) draft.plugins = {};
  if (!isRecord(draft.plugins.entries)) draft.plugins.entries = {};
  if (!isRecord(draft.plugins.entries.codex)) draft.plugins.entries.codex = {};
  const codex = draft.plugins.entries.codex;
  if (!isRecord(codex.config)) codex.config = {};
  if (!isRecord(codex.config.appServer)) codex.config.appServer = {};
  codex.config.appServer.args = plan.args;
  return { status: "set", reason: null };
}

function markerPath(stateDir        ) {
  return path.join(stateDir, CODEX_REQUEST_COMPRESSION_MARKER);
}

async function ensureCodexRequestCompressionOff(api     , stateDir     , env      = (globalThis       ).process?.env) {
  const runtimeConfig = api?.runtime?.config;
  if (!runtimeConfig || typeof runtimeConfig.mutateConfigFile !== "function") return { status: "skipped", reason: "no-config-writer" };
  if (typeof stateDir !== "string" || !stateDir) return { status: "skipped", reason: "no-state-dir" };
  try {
    const addedBefore = existsSync(markerPath(stateDir));
    let current      = null;
    try { current = typeof runtimeConfig.current === "function" ? runtimeConfig.current() : api?.config ?? null; } catch (_) { current = api?.config ?? null; }
    const codexConfigTomls = readAgentCodexConfigTomls(stateDir, current);
    const options = { codexConfigTomls, env, addedBefore };
    const first      = planCodexRequestCompression(current, options);
    if (first.status !== "write") return first;
    let outcome      = { status: "skipped", reason: "mutation-not-run" };
    await runtimeConfig.mutateConfigFile({

      afterWrite: { mode: "auto", reason: "OcuClaw turns Codex request compression off (#7156)" },
      mutate(draft     ) {

        outcome = applyCodexRequestCompression(draft, options);
        return outcome;
      },
    });
    if (outcome.status === "set") {
      try {
        writeFileSync(markerPath(stateDir), JSON.stringify({ version: 1, addedAt: new Date().toISOString(), override: CODEX_REQUEST_COMPRESSION_OFF, issue: "#7156" }, null, 2) + "\n");
      } catch (_) {  }
    }
    return outcome;
  } catch (err     ) {
    return { status: "skipped", reason: `failed: ${err && err.message ? String(err.message).slice(0, 120) : "unknown"}` };
  }
}

function readCodexRequestCompressionMarker(stateDir     ) {
  try { return JSON.parse(readFileSync(markerPath(stateDir), "utf8")); } catch (_) { return null; }
}

module.exports = { CODEX_REQUEST_COMPRESSION_FEATURE, CODEX_REQUEST_COMPRESSION_OFF, CODEX_APP_SERVER_ARGS_ENV, CODEX_REQUEST_COMPRESSION_MARKER, argsSetRequestCompression, tomlSetsRequestCompression, planCodexRequestCompression, applyCodexRequestCompression, ensureCodexRequestCompressionOff, readCodexRequestCompressionMarker };
