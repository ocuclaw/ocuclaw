const nodeFs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, canonicalSerialize, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");

const LIVEUI_EXECUTOR_REGISTRY_SCHEMA = 1;
const LIVEUI_EXECUTOR_REGISTRY_DIRNAME = "executors-v1";
const LIVEUI_EXECUTOR_REGISTRY_HOSTS = Object.freeze(["openclaw", "hermes"]);
const LIVEUI_EXECUTOR_REGISTRY_HEARTBEAT_MS = 60_000;

const REGISTRY_AGENT_KEYS = new Set(["agentId", "name", "emoji"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHost(value) {
  return LIVEUI_EXECUTOR_REGISTRY_HOSTS.includes(value);
}

function validRegistryAgent(value) {
  return !!(
    isPlainObject(value) &&
    Object.keys(value).every((key) => REGISTRY_AGENT_KEYS.has(key)) &&
    typeof value.agentId === "string" &&
    !!value.agentId.trim() &&
    typeof value.name === "string" &&
    !!value.name.trim() &&
    (value.emoji === undefined || typeof value.emoji === "string")
  );
}

function normalizePublishedAgents(input) {
  if (!Array.isArray(input)) throw new Error("executor registry agents must be an array");
  const agents = [];
  const seen = new Set();
  for (const raw of input) {
    if (!isPlainObject(raw)) throw new Error("executor registry agent must be an object");
    const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const emoji = typeof raw.emoji === "string" ? raw.emoji.trim() : "";
    if (!agentId || !name) {
      throw new Error("executor registry agent requires agentId and name");
    }
    const key = agentId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    agents.push({ agentId, name, ...(emoji ? { emoji } : {}) });
  }
  return agents;
}

function registryRecords(registry) {
  if (Array.isArray(registry)) return registry;
  if (registry && Array.isArray(registry.records)) return registry.records;
  if (registry && typeof registry === "object") {
    return LIVEUI_EXECUTOR_REGISTRY_HOSTS
      .map((host) => Reflect.get(registry, host))
      .filter(Boolean);
  }
  return [];
}

function normalizedLiveAgentIdentity(value) {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? [id.toLowerCase()] : [];
  }
  if (!value || typeof value !== "object") return [];
  const identities = [];
  for (const key of ["agentId", "id", "name"]) {
    const candidate = typeof value[key] === "string" ? value[key].trim().toLowerCase() : "";
    if (candidate) identities.push(candidate);
  }
  return identities;
}

function projectTaskExecutorState(input = {}) {
  const executor = input.executor;
  const thisHost = input.thisHost;
  if (input.context === "current_session") {
    return input.backendOnline === false
      ? { state: "unavailable", reason: "backend_offline" }
      : { state: "ready" };
  }
  if (
    !isPlainObject(executor) ||
    !isHost(executor.host) ||
    typeof executor.agentId !== "string" ||
    !executor.agentId.trim()
  ) {
    return { state: "unavailable", reason: "backend_incompatible" };
  }
  if (executor.host !== thisHost) {
    return { state: "unavailable", reason: "host_not_connected" };
  }
  if (input.backendOnline === false) {
    return { state: "unavailable", reason: "backend_offline" };
  }

  const localRegistry = registryRecords(input.registry).find(
    (record) => record && record.host === thisHost,
  );
  if (localRegistry) {
    if (localRegistry.schema !== LIVEUI_EXECUTOR_REGISTRY_SCHEMA) {
      return { state: "unavailable", reason: "backend_incompatible" };
    }
    if (!Array.isArray(localRegistry.agents)) {
      return { state: "unavailable", reason: "backend_incompatible" };
    }
    const needle = executor.agentId.trim().toLowerCase();
    const registryMatch = localRegistry.agents.find(
      (agent) =>
        agent &&
        typeof agent.agentId === "string" &&
        agent.agentId.trim().toLowerCase() === needle,
    );
    if (registryMatch && !validRegistryAgent(registryMatch)) {
      return { state: "unavailable", reason: "backend_incompatible" };
    }
  }

  const needle = executor.agentId.trim().toLowerCase();
  const available = Array.isArray(input.liveAgents) && input.liveAgents.some(
    (agent) => normalizedLiveAgentIdentity(agent).includes(needle),
  );
  return available
    ? { state: "ready" }
    : { state: "needs_setup", reason: "executor_missing" };
}

function resolveLiveuiExecutorRegistryRoot(options = {}) {
  if (typeof options.libraryDir === "string" && options.libraryDir.trim()) {
    return resolveLiveuiLibraryRoot(options.libraryDir);
  }
  if (typeof options.templateLibraryDir === "string" && options.templateLibraryDir.trim()) {
    return resolveLiveuiLibraryRoot(path.dirname(options.templateLibraryDir.trim()));
  }
  return resolveLiveuiLibraryRoot(undefined);
}

function createLiveuiExecutorRegistry(options = {}) {
  const fs = options.fs && typeof options.fs === "object" ? options.fs : nodeFs;
  const libraryDir = resolveLiveuiExecutorRegistryRoot(options);
  const registryDir = path.join(libraryDir, LIVEUI_EXECUTOR_REGISTRY_DIRNAME);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const heartbeatMs = Number.isFinite(options.heartbeatMs) && options.heartbeatMs > 0
    ? Math.floor(options.heartbeatMs)
    : LIVEUI_EXECUTOR_REGISTRY_HEARTBEAT_MS;
  const schedule = typeof options.setInterval === "function" ? options.setInterval : setInterval;
  const unschedule = typeof options.clearInterval === "function" ? options.clearInterval : clearInterval;
  let heartbeatTimer = null;
  let heartbeatPublication = null;

  function filePath(host) {
    if (!isHost(host)) throw new Error("executor registry host must be openclaw or hermes");
    return path.join(registryDir, `${host}.json`);
  }

  function publish(input = {}) {
    if (!isHost(input.host)) {
      throw new Error("executor registry host must be openclaw or hermes");
    }
    if (typeof input.online !== "boolean") {
      throw new Error("executor registry online must be boolean");
    }
    const agents = normalizePublishedAgents(input.agents);
    const updatedAt = now();
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      throw new Error("executor registry updatedAt must be a non-negative safe integer");
    }
    const record = {
      schema: LIVEUI_EXECUTOR_REGISTRY_SCHEMA,
      host: input.host,
      updatedAt,
      online: input.online,
      agents,
    };
    atomicWriteLiveuiLibraryRecord({
      fs,
      libraryDir,
      targetPath: filePath(input.host),
      record,
    });
    heartbeatPublication = {
      host: record.host,
      online: record.online,
      agents: record.agents,
    };
    return record;
  }

  function readHost(host) {
    const target = filePath(host);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) return { schema: null, host, updatedAt: 0, online: false, agents: [] };
      const record = JSON.parse(fs.readFileSync(target, "utf8"));
      if (!isPlainObject(record) || record.host !== host) {
        return { schema: null, host, updatedAt: 0, online: false, agents: [] };
      }
      return record;
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      return { schema: null, host, updatedAt: 0, online: false, agents: [] };
    }
  }

  function readAll() {
    return LIVEUI_EXECUTOR_REGISTRY_HOSTS
      .map((host) => readHost(host))
      .filter((record) => record !== null);
  }

  function startHeartbeat(input = {}) {
    const first = publish({ ...input, online: true });
    if (!heartbeatTimer) {
      heartbeatTimer = schedule(() => {
        if (heartbeatPublication && heartbeatPublication.online === true) {
          publish(heartbeatPublication);
        }
      }, heartbeatMs);
      if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
    }
    return first;
  }

  function updateHeartbeat(input = {}) {
    const next = {
      host: input.host,
      online: input.online !== false,
      agents: normalizePublishedAgents(input.agents),
    };
    const changed = canonicalSerialize(next) !== canonicalSerialize(heartbeatPublication);
    heartbeatPublication = next;
    return changed ? publish(next) : null;
  }

  function stop() {
    if (heartbeatTimer) {
      unschedule(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (!heartbeatPublication) return null;
    if (heartbeatPublication.online === false) return null;
    return publish({ ...heartbeatPublication, online: false });
  }

  return {
    libraryDir,
    registryDir,
    publish,
    readAll,
    startHeartbeat,
    updateHeartbeat,
    stop,
  };
}

module.exports = { LIVEUI_EXECUTOR_REGISTRY_SCHEMA, LIVEUI_EXECUTOR_REGISTRY_DIRNAME, LIVEUI_EXECUTOR_REGISTRY_HOSTS, LIVEUI_EXECUTOR_REGISTRY_HEARTBEAT_MS, resolveLiveuiExecutorRegistryRoot, createLiveuiExecutorRegistry, projectTaskExecutorState };
