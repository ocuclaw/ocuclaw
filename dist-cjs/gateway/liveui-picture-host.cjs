const os = require("node:os");
const path = require("node:path");
const { configuredAgentRows } = require("./openclaw-agent-roster.cjs");
const { hermesProfileIdForNamespace, isHermesSessionKey } = require("../runtime/hermes-session-keys.cjs");

const DEFAULT_CACHE_MS = 60_000;
const OPENCLAW_DEFAULT_WORKSPACE = "~/.openclaw/workspace";
const OPENCLAW_DEFAULT_STATE_DIR = "~/.openclaw";

const OPENCLAW_IMAGE_TOOL_FOLDER = ["media", "tool-image-generation"];

function openClawImageToolFolder(env                                     = {})         {
  const stateDir = cleanText(env.OPENCLAW_STATE_DIR) || OPENCLAW_DEFAULT_STATE_DIR;
  return [stateDir.replace(/[\\/]+$/, ""), ...OPENCLAW_IMAGE_TOOL_FOLDER].join("/");
}

function cleanText(value         )         {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value         )                               {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sandboxed(entry         )          {
  if (!isRecord(entry) || !isRecord(entry.sandbox)) return false;
  const mode = cleanText(entry.sandbox.mode).toLowerCase();
  return mode !== "" && mode !== "off";
}

function openClawPictureScope(config         )                                               {
  const cfg = isRecord(config) ? config : {};
  const defaults = isRecord(cfg.agents) && isRecord(cfg.agents.defaults) ? cfg.agents.defaults : {};
  const rows = configuredAgentRows(cfg);
  const workspaces = [cleanText(defaults.workspace) || OPENCLAW_DEFAULT_WORKSPACE];
  for (const row of rows) {
    const ws = cleanText(row.workspace);
    if (ws) workspaces.push(ws);
  }
  return { workspaces, sandboxed: sandboxed(defaults) || rows.some((row     ) => sandboxed(row)) };
}

function hermesProfileForSession(sessionKey        )         {
  if (!isHermesSessionKey(sessionKey)) return "default";
  const rest = sessionKey.slice("hermes:".length);
  const sep = rest.indexOf(":");
  return hermesProfileIdForNamespace(sep > 0 ? rest.slice(0, sep) : rest);
}

function createLiveUiPictureHost(deps                       ) {
  const tmpdir = deps.tmpdir ?? (() => os.tmpdir());
  const homedir = deps.homedir ?? (() => os.homedir());
  const env = deps.env ?? (() => (Reflect.get(globalThis, "process")?.env ?? {})                                      );
  const now = deps.now ?? (() => Date.now());
  const cacheMs = Number.isFinite(deps.cacheMs) ? (deps.cacheMs          ) : DEFAULT_CACHE_MS;
  const cache = new Map                                                                             ();

  function expand(p        )                {
    const raw = cleanText(p);
    if (!raw) return null;
    const full = raw === "~" ? homedir() : raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw;
    return path.isAbsolute(full) ? path.resolve(full) : null;
  }

  async function hostScope(sessionKey        )                                                        {
    const kind = deps.backendKind();
    const key = `${kind}\u0000${kind === "hermes" ? hermesProfileForSession(sessionKey) : ""}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.scope;
    let scope = { workspaces: []            , sandboxed: false };
    try {
      if (kind === "openclaw") {
        const snapshot = await deps.request("config.get", {});
        scope = openClawPictureScope(snapshot && isRecord(snapshot.config) ? snapshot.config : snapshot);
      } else if (kind === "hermes") {
        const settings = await deps.request("profiles.settings.get", { profileId: hermesProfileForSession(sessionKey) });
        const workspace = cleanText(settings?.setup?.workspace);
        const backend = cleanText(settings?.terminalBackend).toLowerCase();
        scope = { workspaces: workspace ? [workspace] : [], sandboxed: backend !== "" && backend !== "local" };
      }
    } catch {

    }
    cache.set(key, { at: now(), scope });
    return scope;
  }

  return {

    async fileScope(sessionKey        )                                  {
      const scope = await hostScope(sessionKey);
      const operator = deps.pictureFolders();
      const toolFolders = deps.backendKind() === "openclaw" ? [openClawImageToolFolder(env())] : [];
      const listed = Array.isArray(operator) ? operator : [...scope.workspaces, ...toolFolders, tmpdir()];
      const roots = [...new Set(listed.map(expand).filter((p)              => !!p))];
      return { roots, filesAllowed: !scope.sandboxed };
    },
    clearCache()       {
      cache.clear();
    },
  };
}

module.exports = { openClawImageToolFolder, openClawPictureScope, hermesProfileForSession, createLiveUiPictureHost };
