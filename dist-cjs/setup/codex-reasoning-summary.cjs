const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { codexEngineState } = require("./codex-engine.cjs");

const CODEX_REASONING_SUMMARY_OVERRIDE = 'model_reasoning_summary="auto"';
const CODEX_APP_SERVER_DEFAULT_ARGS = Object.freeze(["app-server", "--listen", "stdio://"]);
const CODEX_APP_SERVER_ARGS_KEY = "plugins.entries.codex.config.appServer.args";

function isRecord(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const REASONING_SUMMARY_SETTING = /^\s*model_reasoning_summary\s*=/;

function argsSetReasoningSummary(args          ) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value      = null;
    if (arg === "-c" || arg === "--config") value = args[index + 1];
    else if (arg.startsWith("--config=")) value = arg.slice("--config=".length);
    else if (/^-c.+/.test(arg)) value = arg.slice(2).replace(/^=/, "");
    if (typeof value === "string" && REASONING_SUMMARY_SETTING.test(value)) return true;
  }
  return false;
}

function tomlSetsReasoningSummary(text     ) {
  if (typeof text !== "string") return false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return false;
    if (REASONING_SUMMARY_SETTING.test(line)) return true;
  }
  return false;
}

function readAgentCodexConfigTomls(stateDir     , config      = null) {
  const homes = new Set        ();
  if (typeof stateDir === "string" && stateDir) {
    try {
      for (const id of readdirSync(path.join(stateDir, "agents"))) {
        homes.add(path.join(stateDir, "agents", id, "agent", "codex-home"));
      }
    } catch (_) {  }
  }
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const entries = isRecord(config?.agents?.entries) ? Object.values(config.agents.entries) : [];
  for (const agent of [...list, ...entries]) {
    const dir = isRecord(agent) && typeof agent.agentDir === "string" ? agent.agentDir.trim() : "";
    if (dir && path.isAbsolute(dir)) homes.add(path.join(dir, "codex-home"));
  }
  const texts           = [];
  for (const home of homes) {
    try { texts.push(readFileSync(path.join(home, "config.toml"), "utf8")); } catch (_) {  }
  }
  return texts;
}

function planCodexReasoningSummary(config     , options      = {}) {
  const skip = (reason        ) => ({ status: "skipped", reason });
  if (!codexEngineState(config).inUse) return skip("codex-engine-not-configured");
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
  if (argsSetReasoningSummary(current)) return skip("already-set");
  const tomls = Array.isArray(options.codexConfigTomls) ? options.codexConfigTomls : [];
  if (tomls.some(tomlSetsReasoningSummary)) return skip("already-set");

  const base = current.length > 0 ? current : [...CODEX_APP_SERVER_DEFAULT_ARGS];
  const subcommand = base.lastIndexOf("app-server");
  const override = ["-c", CODEX_REASONING_SUMMARY_OVERRIDE];
  const args = subcommand >= 0
    ? [...base.slice(0, subcommand), ...override, ...base.slice(subcommand)]
    : [...base, ...override];
  return { status: "write", args };
}

function applyCodexReasoningSummary(draft     , options      = {}) {
  const plan      = planCodexReasoningSummary(draft, options);
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

module.exports = { CODEX_REASONING_SUMMARY_OVERRIDE, CODEX_APP_SERVER_DEFAULT_ARGS, CODEX_APP_SERVER_ARGS_KEY, argsSetReasoningSummary, tomlSetsReasoningSummary, readAgentCodexConfigTomls, planCodexReasoningSummary, applyCodexReasoningSummary };
