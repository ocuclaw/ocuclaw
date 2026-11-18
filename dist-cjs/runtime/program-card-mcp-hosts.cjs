const { realpathSync } = require("node:fs");

const { createRequire } = require("node:module");

const { pathToFileURL } = require("node:url");

const LINK_PROGRAM_CARD_MCP_LIST_METHOD = "program_card.mcp.list";
const LINK_PROGRAM_CARD_MCP_CALL_METHOD = "program_card.mcp.call";
const LINK_PROGRAM_CARD_MCP_ALLOW_METHOD = "program_card.mcp.allow";

const RPC_METHOD_NOT_FOUND = -32601;

const SNAPSHOT_MAX_AGE_MS = 60_000;

const SNAPSHOT_FRESH_MS = 5_000;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const codeOf = (value     ) => (value && typeof value.code === "string" ? value.code : "failed");

function createHermesProgramCardMcpHost(request                                               ) {
  return {
    kind: "hermes",
    async list() {
      try {
        const out = await request(LINK_PROGRAM_CARD_MCP_LIST_METHOD, {});
        return isPlainObject(out) ? out : { ok: false, reason: "failed" };
      } catch (err     ) {

        const oldParent = err && (err.code === RPC_METHOD_NOT_FOUND || err.code === "method_not_found");
        return { ok: false, reason: oldParent ? "unsupported" : "failed" };
      }
    },
    async call({ server, tool, args, timeoutMs, write, ownerWrite }     ) {
      try {

        const out = await request(LINK_PROGRAM_CARD_MCP_CALL_METHOD, {
          server, tool, args, timeoutMs,
          ...(write === true ? { write: true } : {}),
          ...(ownerWrite === true ? { ownerWrite: true } : {}),
        });
        return isPlainObject(out) ? out : { ok: false, code: "failed" };
      } catch (err     ) {
        return { ok: false, code: err && /timeout/i.test(String(err.code || err.message || "")) ? "timeout" : "failed" };
      }
    },
    async allow(server        , allow         ) {
      try {
        const out = await request(LINK_PROGRAM_CARD_MCP_ALLOW_METHOD, { server, allow });
        return isPlainObject(out) ? out : { ok: false, code: "failed" };
      } catch (err     ) {
        return { ok: false, code: codeOf(err) };
      }
    },
  };
}

async function importHostSdk(name        )               {
  return import(name).catch(() => {

    const hostRequire = createRequire(realpathSync(process.argv[1]));
    return import(pathToFileURL(hostRequire.resolve(name)).href);
  });
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

function configuredServers(cfg     ) {
  const servers = cfg && isPlainObject(cfg.mcp) && isPlainObject(cfg.mcp.servers) ? cfg.mcp.servers : {};
  const out      = {};
  for (const name of Object.keys(servers).sort()) {
    const spec = servers[name];
    if (SERVER_NAME.test(name) && isPlainObject(spec) && spec.enabled !== false) out[name] = spec;
  }
  return out;
}

function hidesTools(spec     ) {
  const codex = isPlainObject(spec) && isPlainObject(spec.codex) ? spec.codex : {};
  return codex.defaultToolsApprovalMode !== "approve";
}

function defaultAgentId(cfg     ) {
  const list = cfg && isPlainObject(cfg.agents) && Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
  const marked = list.find((agent     ) => isPlainObject(agent) && agent.default === true && typeof agent.id === "string" && agent.id);
  if (marked) return marked.id;
  const first = list.find((agent     ) => isPlainObject(agent) && typeof agent.id === "string" && agent.id);
  return first ? first.id : "main";
}

function shapeResult(result     ) {
  if (!isPlainObject(result)) return { ok: true, text: typeof result === "string" ? result : "" };
  const details = isPlainObject(result.details) ? result.details : {};
  const blocks = Array.isArray(result.content) ? result.content : [];

  const texts = blocks
    .filter((block     ) => isPlainObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block     ) => block.text)
    .filter((text        ) => !(details.structuredContent !== undefined && text.startsWith("structuredContent:")));
  const out      = { ok: true };
  if (details.structuredContent !== undefined && details.structuredContent !== null) out.structured = details.structuredContent;
  if (texts.length) out.text = texts.join("\n");
  if (result.isError === true || details.isError === true || details.status === "error") out.isError = true;
  return out;
}

function createOpenClawProgramCardMcpHost(api     , opts      = {}) {
  const importSdk = typeof opts.importSdk === "function" ? opts.importSdk : importHostSdk;
  const sessionPrefix = typeof opts.sessionPrefix === "string" && opts.sessionPrefix ? opts.sessionPrefix : "ocuclaw-cards";
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const logger = api && api.logger;
  let materialized      = null;
  let materializedKey = "";
  let materializedAtMs = 0;
  let building                      = null;

  let epoch = 0;

  const running = new Map             ();
  const retiring = new Set     ();
  let toolMeta      = null;
  let calls = 0;

  async function sdk() {
    const projection = await importSdk("openclaw/plugin-sdk/codex-mcp-projection");
    if (!projection || typeof projection.materializeStaticMcpToolsForHarnessRun !== "function") {
      throw Object.assign(new Error("no static MCP helper"), { code: "unsupported" });
    }
    if (!toolMeta) {
      const harness = await importSdk("openclaw/plugin-sdk/agent-harness-runtime").catch(() => null);
      toolMeta = harness && typeof harness.getPluginToolMeta === "function" ? harness.getPluginToolMeta : () => null;
    }
    return projection;
  }

  async function close(snapshot     ) {
    if (snapshot && typeof snapshot.dispose === "function") {
      try {
        await snapshot.dispose();
      } catch (_) {

      }
    }
  }

  async function retire(snapshot     ) {
    if (!snapshot) return;
    if ((running.get(snapshot) || 0) > 0) {
      retiring.add(snapshot);
      return;
    }
    await close(snapshot);
  }

  async function release() {
    const owned = materialized;
    materialized = null;
    materializedKey = "";
    materializedAtMs = 0;
    await retire(owned);
  }

  async function drop() {
    epoch += 1;
    await release();
  }

  function reusable(key        , fresh         ) {
    if (!materialized || materializedKey !== key) return false;
    return now() - materializedAtMs < (fresh ? SNAPSHOT_FRESH_MS : SNAPSHOT_MAX_AGE_MS);
  }

  async function ensure(cfg     , wanted     , fresh         ) {
    const key = JSON.stringify(wanted);
    if (reusable(key, fresh)) return materialized;

    while (building) await building.catch(() => {});
    if (reusable(key, fresh)) return materialized;
    const mine = (async () => {
      const startedIn = epoch;
      const projection = await sdk();
      if (startedIn !== epoch) return { tools: [] };
      const again = !!materialized && materializedKey === key;
      if (!again) await release();
      const agentId = defaultAgentId(cfg);
      const agent = api && api.runtime && api.runtime.agent;
      const workspaceDir = agent && typeof agent.resolveAgentWorkspaceDir === "function"
        ? agent.resolveAgentWorkspaceDir(cfg, agentId)
        : undefined;
      const sessionId = `${sessionPrefix}:${agentId}`;
      let next     ;
      try {
        next = await projection.materializeStaticMcpToolsForHarnessRun({
          sessionId,
          sessionKey: sessionId,
          agentId,
          ...(workspaceDir ? { workspaceDir } : {}),
          cfg: { ...cfg, mcp: { ...(isPlainObject(cfg.mcp) ? cfg.mcp : {}), servers: wanted } },
          warn: (message     ) => {
            if (logger && typeof logger.debug === "function") logger.debug(`[ocuclaw] card MCP: ${String(message).slice(0, 300)}`);
          },
        });
      } catch (err) {
        if (startedIn !== epoch) return { tools: [] };
        if (!again) throw err;
        if (logger && typeof logger.debug === "function") logger.debug(`[ocuclaw] card MCP: tools not read again (${String(err && (err       ).message || err).slice(0, 200)})`);

        materializedAtMs = now();
        return materialized;
      }
      if (startedIn !== epoch) {
        await close(next);
        return { tools: [] };
      }
      const previous = materialized && materialized !== next ? materialized : null;
      materialized = next || { tools: [] };
      materializedKey = key;
      materializedAtMs = now();
      await retire(previous);
      return materialized;
    })();
    building = mine;
    try {
      return await mine;
    } finally {
      if (building === mine) building = null;
    }
  }

  function describe(tool     ) {
    let meta      = null;
    try {
      meta = toolMeta ? toolMeta(tool) : null;
    } catch (_) {
      meta = null;
    }
    const mcp = meta && isPlainObject(meta.mcp) ? meta.mcp : null;
    if (!mcp || typeof mcp.serverName !== "string" || typeof mcp.toolName !== "string") return null;
    const approval = isPlainObject(mcp.codexApproval) ? mcp.codexApproval : {};
    return {
      server: mcp.serverName,
      name: mcp.toolName,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: isPlainObject(tool.parameters) ? tool.parameters : isPlainObject(tool.inputSchema) ? tool.inputSchema : null,
      annotations: isPlainObject(approval.annotations) ? approval.annotations : {},
      tool,
    };
  }

  function findTool(snapshot     , server        , name        ) {
    for (const tool of (snapshot && Array.isArray(snapshot.tools) ? snapshot.tools : [])) {
      const described = describe(tool);
      if (described && described.server === server && described.name === name) return tool;
    }
    return null;
  }

  return {
    kind: "openclaw",
    async list(params      = {}) {
      const cfg = currentConfig(api);
      const configured = configuredServers(cfg);
      const names = Object.keys(configured);
      if (!names.length) {
        await drop();
        return { ok: true, servers: [] };
      }
      const asked = new Set(Array.isArray(params.servers) ? params.servers : []);
      const wanted      = {};
      for (const name of names) if (asked.has(name)) wanted[name] = configured[name];
      const tools = new Map();
      let ready = false;
      if (Object.keys(wanted).length) {
        try {
          const runtime = await ensure(cfg, wanted, params.fresh === true);
          ready = true;
          for (const tool of Array.isArray(runtime.tools) ? runtime.tools : []) {
            const described = describe(tool);
            if (!described || !Object.prototype.hasOwnProperty.call(wanted, described.server)) continue;
            if (!tools.has(described.server)) tools.set(described.server, []);
            const { tool: _tool, server: _server, ...row } = described;
            tools.get(described.server).push(row);
          }
        } catch (err     ) {
          if (err && err.code === "unsupported") return { ok: false, reason: "unsupported" };
          if (logger && typeof logger.warn === "function") logger.warn(`[ocuclaw] card MCP: tools unavailable (${String(err && err.message || err).slice(0, 200)})`);
          return { ok: false, reason: "failed" };
        }
      } else {
        await drop();
      }
      return {
        ok: true,

        writes: true,

        servers: names.map((name) => ({
          name,
          connected: ready && Object.prototype.hasOwnProperty.call(wanted, name) && tools.has(name),
          ...(hidesTools(configured[name]) ? { reason: "host_blocked" } : {}),
          tools: tools.get(name) || [],
        })),
      };
    },
    async call({ server, tool, args, timeoutMs }     ) {

      const snapshot = materialized;
      const target = findTool(snapshot, server, tool);
      if (!target || typeof target.execute !== "function") return { ok: false, code: "off" };
      calls += 1;
      running.set(snapshot, (running.get(snapshot) || 0) + 1);

      const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
      try {
        const result = await target.execute(`ocuclaw-card-${calls}`, args || {}, signal);
        return shapeResult(result);
      } catch (err     ) {
        const name = err && (err.name || err.code);
        return { ok: false, code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "failed" };
      } finally {
        const left = (running.get(snapshot) || 1) - 1;
        if (left > 0) running.set(snapshot, left);
        else {
          running.delete(snapshot);
          if (retiring.delete(snapshot)) void close(snapshot);
        }
      }
    },
    async dispose() {
      const held = [...retiring];
      retiring.clear();
      running.clear();
      await drop();
      for (const snapshot of held) await close(snapshot);
    },
  };
}

module.exports = { LINK_PROGRAM_CARD_MCP_LIST_METHOD, LINK_PROGRAM_CARD_MCP_CALL_METHOD, LINK_PROGRAM_CARD_MCP_ALLOW_METHOD, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_FRESH_MS, createHermesProgramCardMcpHost, createOpenClawProgramCardMcpHost };
