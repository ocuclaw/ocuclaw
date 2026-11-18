const { createOpenClawProgramCardMcpHost } = require("./program-card-mcp-hosts.cjs");

const TASK_READ_MARKS_TTL_MS = 10 * 60_000;

const TASK_READ_MARKS_RETRY_MS = 60_000;

const TASK_READ_MARKS_TIMEOUT_MS = 15_000;
const SERVERS_MAX = 32;
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

function isPlainObject(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function specKey(spec     ) {
  try {
    return JSON.stringify(spec);
  } catch (_) {
    return "";
  }
}

function hintsOf(raw     ) {
  const out      = {};
  const given = isPlainObject(raw) ? raw : {};
  for (const hint of HINTS) if (typeof given[hint] === "boolean") out[hint] = given[hint];
  return out;
}

function createOpenClawTaskReadMarks(api     , opts      = {}) {
  const makeHost = typeof opts.makeHost === "function"
    ? opts.makeHost
    : () => createOpenClawProgramCardMcpHost(api, { sessionPrefix: "ocuclaw-task-reads" });
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const setTimeoutFn = typeof opts.setTimeoutFn === "function" ? opts.setTimeoutFn : setTimeout;
  const timeoutMs = Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TASK_READ_MARKS_TIMEOUT_MS;
  const logger = api && api.logger;

  const cache = new Map             ();
  const listing = new Map                      ();

  function fresh(entry     , key        ) {
    if (!entry || entry.key !== key) return false;
    return now() - entry.atMs < (entry.tools ? TASK_READ_MARKS_TTL_MS : TASK_READ_MARKS_RETRY_MS);
  }

  async function listOnce(server        , key        ) {
    let host      = null;
    let tools                          = null;
    try {
      host = makeHost();
      const answer = await host.list({ servers: [server], fresh: true });
      const row = answer && answer.ok === true && Array.isArray(answer.servers)
        ? answer.servers.find((entry     ) => entry && entry.name === server && entry.connected === true)
        : null;
      if (row) {
        tools = new Map();
        for (const tool of Array.isArray(row.tools) ? row.tools : []) {
          if (tool && typeof tool.name === "string") tools.set(tool.name, hintsOf(tool.annotations));
        }
      }
    } catch (err     ) {
      if (logger && typeof logger.debug === "function") {
        logger.debug(`[task-uses] could not list ${server}'s tools: ${String(err && err.message || err).slice(0, 200)}`);
      }
      tools = null;
    } finally {
      if (host && typeof host.dispose === "function") {
        try {
          await host.dispose();
        } catch (_) {

        }
      }
    }
    cache.delete(server);
    cache.set(server, { key, atMs: now(), tools });
    while (cache.size > SERVERS_MAX) cache.delete(cache.keys().next().value          );
    return tools;
  }

  function withTimeout(promise              ) {
    return new Promise((resolve) => {
      let done = false;
      const timer      = setTimeoutFn(() => {
        if (done) return;
        done = true;
        resolve(null);
      }, timeoutMs);
      promise.then((value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }, () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  return {
    async annotationsOf({ server, tool, spec }     )               {
      if (typeof server !== "string" || !server || typeof tool !== "string" || !tool) return null;
      const key = specKey(spec);
      let entry = cache.get(server);
      if (!fresh(entry, key)) {
        let pending = listing.get(server);
        if (!pending) {
          pending = listOnce(server, key).finally(() => listing.delete(server));
          listing.set(server, pending);
        }
        await withTimeout(pending);
        entry = cache.get(server);
        if (!entry || entry.key !== key) return null;
      }
      return entry.tools && entry.tools.has(tool) ? { ...entry.tools.get(tool) } : null;
    },

    clear() {
      cache.clear();
    },
  };
}

module.exports = { TASK_READ_MARKS_TTL_MS, TASK_READ_MARKS_RETRY_MS, TASK_READ_MARKS_TIMEOUT_MS, createOpenClawTaskReadMarks };
