const { taskToolMcpServerOf, taskToolResultError } = require("../tools/glasses-ui-task-tool-failures.cjs");
const { TASK_USES_CHECK_FAILED_REASON } = require("../tools/glasses-ui-task-uses.cjs");

function isPlainObject(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function currentConfig(api     ) {
  const runtimeConfig = api && api.runtime && api.runtime.config;
  if (runtimeConfig && typeof runtimeConfig.current === "function") {
    try {
      const cfg = runtimeConfig.current();
      if (isPlainObject(cfg)) return cfg;
    } catch (_) {

    }
  }
  return isPlainObject(api && api.config) ? api.config : {};
}

const CODEX_OPENCLAW_NAMESPACE = "openclaw";

function mcpServerPrefixOf(toolName        , servers          ) {
  return servers
    .filter((name) => toolName.startsWith(`${name}__`) && toolName.length > name.length + 2)
    .sort((a, b) => b.length - a.length)[0] || null;
}

function openClawMcpToolOf(toolName     , cfg     ) {
  if (typeof toolName !== "string" || !toolName.includes("__")) return null;
  const servers = cfg && isPlainObject(cfg.mcp) && isPlainObject(cfg.mcp.servers) ? Object.keys(cfg.mcp.servers) : [];
  const own = mcpServerPrefixOf(toolName, servers);
  if (own) return { server: own, tool: toolName.slice(own.length + 2), annotations: {} };
  if (!toolName.startsWith(CODEX_OPENCLAW_NAMESPACE)) return null;
  const rest = toolName.slice(CODEX_OPENCLAW_NAMESPACE.length);
  const codex = mcpServerPrefixOf(rest, servers);
  return codex ? { server: codex, tool: rest.slice(codex.length + 2), annotations: {} } : null;
}

function createTaskToolResultObserver(api     , service     ) {
  return function noteTaskToolResult(event     , ctx      = null) {
    try {
      const message = event && event.message;
      if (!message || message.role !== "toolResult") return undefined;
      const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
      if (!sessionKey) return undefined;
      const cfg = currentConfig(api);
      const servers = cfg && isPlainObject(cfg.mcp) && isPlainObject(cfg.mcp.servers) ? Object.keys(cfg.mcp.servers) : [];
      const server = taskToolMcpServerOf(message.toolName, servers);
      if (!server) return undefined;
      const relay = service?.getRelay?.() || null;
      if (relay && typeof relay.noteTaskToolCall === "function") {
        relay.noteTaskToolCall({ sessionKey, server, error: taskToolResultError(message) });
      }
    } catch (_) {

    }
    return undefined;
  };
}

function createTaskUsesGuardHook(api     , service     , opts      = {}) {
  const onRefused = typeof opts.onRefused === "function" ? opts.onRefused : null;

  const readMarks = opts.readMarks && typeof opts.readMarks.annotationsOf === "function" ? opts.readMarks : null;
  return async function holdTaskRunToItsList(event     , ctx      = null) {
    const toolName = typeof event?.toolName === "string" ? event.toolName : "";
    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    if (!toolName || !sessionKey) return undefined;
    let relay      = null;
    try {
      relay = service?.getRelay?.() || null;
    } catch (_) {
      relay = null;
    }
    if (!relay || typeof relay.checkTaskToolCall !== "function") return undefined;
    const cfg = currentConfig(api);
    let mcp      = openClawMcpToolOf(toolName, cfg);
    if (mcp && readMarks && typeof relay.taskToolCallNeedsMarks === "function") {
      try {
        if (relay.taskToolCallNeedsMarks({ sessionKey, mcp })) {
          const annotations = await readMarks.annotationsOf({ server: mcp.server, tool: mcp.tool, spec: cfg.mcp.servers[mcp.server] });

          if (isPlainObject(annotations)) mcp = { ...mcp, annotations, listed: true };
        }
      } catch (_) {

      }
    }
    let verdict      = null;
    try {
      verdict = relay.checkTaskToolCall({
        toolName,
        args: isPlainObject(event?.params) ? event.params : {},
        sessionKey,
        mcp,
      });
    } catch (_) {

      verdict = { block: true, reason: TASK_USES_CHECK_FAILED_REASON };
    }
    if (!verdict || verdict.block !== true) return undefined;
    if (onRefused) {
      try {
        onRefused({ toolName, taskId: verdict.taskId || null, mode: verdict.mode || null });
      } catch (_) {

      }
    }
    return { block: true, blockReason: String(verdict.reason || "not-allowed-for-this-task") };
  };
}

module.exports = { openClawMcpToolOf, createTaskToolResultObserver, createTaskUsesGuardHook };
