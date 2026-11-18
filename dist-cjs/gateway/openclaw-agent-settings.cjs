const { normalizeAgentCreateSetup } = require("./agent-create-setup.cjs");
const { AGENT_ROSTER_MIGRATION_MESSAGE, agentRosterShape, findConfiguredAgent, isAgentOwnershipRefusal, isLegacyAgentListRefusal } = require("./openclaw-agent-roster.cjs");

const OPENCLAW_AGENT_SETTINGS_CAPABILITY = "openclawAgentSettings";

const MANAGED_TOOL_GROUPS      = {
  web: ["web_search", "web_fetch"],
  files: ["read", "write", "edit", "apply_patch"],
  terminal: ["exec", "process"],
};

const OPENCLAW_TOOL_PROFILES      = ["minimal", "coding", "messaging", "full"];

const AGENT_SKILLS_MAX = 200;
const AGENT_SKILL_NAME_MAX = 100;

function cleanText(value     ) {
  return typeof value === "string" ? value.trim() : "";
}

function modelParts(raw     ) {
  const value = cleanText(
    typeof raw === "string" ? raw : raw?.primary || raw?.default || raw?.model,
  );
  if (!value) return { model: "", provider: "" };
  const slash = value.indexOf("/");
  return slash > 0
    ? { provider: value.slice(0, slash), model: value.slice(slash + 1) }
    : { provider: "", model: value };
}

function blockedGroups(deny     ) {
  const denied = new Set(Array.isArray(deny) ? deny.filter((x) => typeof x === "string") : []);
  return ["web", "files", "terminal"]
    .filter((group) => MANAGED_TOOL_GROUPS[group].every((tool     ) => denied.has(tool)));
}

function toolProfileOf(agent     ) {
  const profile = cleanText(agent?.tools?.profile);
  return OPENCLAW_TOOL_PROFILES.includes(profile) ? profile : "";
}

function skillsOf(agent     ) {
  if (!Array.isArray(agent?.skills)) return null;
  return [...new Set(agent.skills.map(cleanText).filter(Boolean))].sort();
}

function sameList(a     , b     ) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function normalizeToolProfile(value     ) {
  const profile = cleanText(value);
  if ((value != null && typeof value !== "string") || (profile && !OPENCLAW_TOOL_PROFILES.includes(profile))) {
    throw new OpenClawAgentSettingsError("invalid_settings", "Choose a tool profile.");
  }
  return profile;
}

function normalizeSkills(value     ) {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > AGENT_SKILLS_MAX ||
    value.some((name     ) =>
      typeof name !== "string" || !name.trim() || name.length > AGENT_SKILL_NAME_MAX || /[\0\r\n]/.test(name))
  ) {
    throw new OpenClawAgentSettingsError("invalid_settings", "Choose skills from the list.");
  }
  return [...new Set(value.map(cleanText))].sort();
}

function normalizeBlockedGroups(value     ) {
  if (!Array.isArray(value) || value.some((group     ) => !MANAGED_TOOL_GROUPS[group])) {
    throw new OpenClawAgentSettingsError("invalid_settings", "Choose tool groups from the list.");
  }
  return [...new Set(value)].sort();
}

function applyAgentTools(nextAgent     , blockedTools     , toolProfile     ) {
  const nextTools      =
    nextAgent.tools && typeof nextAgent.tools === "object" ? { ...nextAgent.tools } : {};
  if (blockedTools !== undefined) {
    const currentDeny = Array.isArray(nextTools.deny)
      ? nextTools.deny.filter((x     ) => typeof x === "string")
      : [];
    const currentlyManagedTools = new Set(
      blockedGroups(currentDeny).flatMap((group     ) => MANAGED_TOOL_GROUPS[group] || []),
    );
    const deny = [...new Set([
      ...currentDeny.filter((tool     ) => !currentlyManagedTools.has(tool)),
      ...blockedTools.flatMap((group     ) => MANAGED_TOOL_GROUPS[group] || []),
    ])];
    if (deny.length > 0) nextTools.deny = deny;
    else delete nextTools.deny;
  }
  if (toolProfile) nextTools.profile = toolProfile;
  else if (toolProfile !== undefined) delete nextTools.profile;
  if (Object.keys(nextTools).length > 0) nextAgent.tools = nextTools;
  else delete nextAgent.tools;
}

function skillOptionsFrom(status     , selected     ) {
  const rows = Array.isArray(status?.skills) ? status.skills : null;
  if (!rows) return null;
  const chosen = new Set(selected || []);
  const options      = new Map();
  for (const row of rows) {
    const name = cleanText(row?.name);
    if (!name || options.has(name)) continue;
    if ((row.eligible === true && row.disabled !== true) || chosen.has(name)) {
      options.set(name, { name, description: cleanText(row.description).slice(0, 160) });
    }
  }
  for (const name of chosen) {
    if (!options.has(name)) options.set(name, { name, description: "" });
  }
  return [...options.values()].sort((a     , b     ) => a.name.localeCompare(b.name));
}

function entryMergePatch(baseHash     , key     , before     , next     ) {
  const prior = before && typeof before === "object" ? before : {};
  const entry      = {};
  const replacePaths      = [];
  const setOrDelete = (field     , value     ) => {
    if (value !== undefined) entry[field] = value;
    else if (prior[field] !== undefined) entry[field] = null;
  };
  if (next.identity?.emoji !== undefined) entry.identity = { emoji: next.identity.emoji };
  else if (prior.identity?.emoji !== undefined) entry.identity = { emoji: null };
  setOrDelete("workspace", next.workspace);

  if (typeof next.model === "string" && prior.model && typeof prior.model === "object") {
    entry.model = { primary: next.model };
  } else {
    setOrDelete("model", next.model);
  }
  const tools      = {};
  const priorDeny = prior.tools?.deny;
  const nextDeny = next.tools?.deny;
  if (nextDeny !== undefined || priorDeny !== undefined) {
    tools.deny = nextDeny === undefined ? null : nextDeny;

    if (Array.isArray(priorDeny)) replacePaths.push(`agents.entries.${key}.tools.deny`);
  }
  if (next.tools?.profile !== prior.tools?.profile) {
    tools.profile = next.tools?.profile === undefined ? null : next.tools.profile;
  }
  if (Object.keys(tools).length > 0) entry.tools = tools;
  if (!sameList(next.skills, prior.skills)) {
    entry.skills = next.skills === undefined ? null : next.skills;
    if (Array.isArray(prior.skills)) replacePaths.push(`agents.entries.${key}.skills`);
  }
  return {
    baseHash,
    raw: JSON.stringify({ agents: { entries: { [key]: entry } } }),
    ...(replacePaths.length > 0 ? { replacePaths } : {}),
  };
}

class OpenClawAgentSettingsError extends Error {
  code     ;
  retryable     ;

  constructor(code     , message     , retryable = false) {
    super(message);
    this.name = "OpenClawAgentSettingsError";
    this.code = code;
    this.retryable = retryable;
  }
}

function normalizeError(error     ) {
  if (error instanceof OpenClawAgentSettingsError) return error;
  if (isAgentOwnershipRefusal(error)) {
    return new OpenClawAgentSettingsError("host_migration_needed", AGENT_ROSTER_MIGRATION_MESSAGE);
  }
  const message = cleanText(error?.message) || "OpenClaw rejected the agent settings request";
  const lower = message.toLowerCase();
  if (lower.includes("base hash") || lower.includes("config changed")) {
    return new OpenClawAgentSettingsError(
      "config_changed",
      "OpenClaw settings changed at the same time. Reload and try again.",
      true,
    );
  }
  if (lower.includes("not connected") || lower.includes("handshake") || lower.includes("timeout")) {
    return new OpenClawAgentSettingsError(
      "backend_unavailable",
      "OpenClaw is not ready. Try again when it reconnects.",
      true,
    );
  }
  return new OpenClawAgentSettingsError("agent_settings_failed", message, true);
}

function createOpenClawAgentSettings(deps      = {}) {
  const gatewayBridge = deps.gatewayBridge;
  const refreshAgentsCatalog =
    typeof deps.refreshAgentsCatalog === "function" ? deps.refreshAgentsCatalog : null;
  const onCatalogRefreshError =
    typeof deps.onCatalogRefreshError === "function" ? deps.onCatalogRefreshError : () => {};
  const inFlight      = new Map();
  const writeQueue      = new Map();

  function isAvailable() {
    return (
      cleanText(typeof deps.backendKind === "function" ? deps.backendKind() : deps.backendKind)
        .toLowerCase() === "openclaw" &&
      !!gatewayBridge &&
      typeof gatewayBridge.request === "function" &&
      (typeof deps.isConnected !== "function" || deps.isConnected() === true)
    );
  }

  async function snapshot(agentId     ) {
    if (!isAvailable()) {
      throw new OpenClawAgentSettingsError(
        "backend_unavailable",
        "OpenClaw is not ready. Try again when it reconnects.",
        true,
      );
    }
    const configSnapshot = await gatewayBridge.request("config.get", {});
    const agent = findConfiguredAgent(configSnapshot?.config, agentId);
    if (!agent && agentId !== "main") {
      throw new OpenClawAgentSettingsError("agent_not_found", "That agent no longer exists.");
    }
    let instructions = "";
    try {
      const soul = await gatewayBridge.request("agents.files.get", { agentId, name: "SOUL.md" });
      instructions = typeof soul?.file?.content === "string" ? soul.file.content : "";
    } catch (error) {
      throw normalizeError(error);
    }
    const model = modelParts(agent?.model);
    const skills = skillsOf(agent);
    let skillOptions = null;
    try {
      skillOptions = skillOptionsFrom(await gatewayBridge.request("skills.status", { agentId }), skills);
    } catch {

    }
    return {
      configSnapshot,
      agent: agent || { id: agentId },
      result: {
        status: "loaded",
        backend: "openclaw",
        agentId,
        name: cleanText(agent?.identity?.name) || cleanText(agent?.name) || agentId,
        emoji: cleanText(agent?.identity?.emoji) || null,
        setup: {
          instructions,
          model: model.model,
          provider: model.provider,
          workspace: cleanText(agent?.workspace),
          blockedTools: blockedGroups(agent?.tools?.deny),
          toolProfile: toolProfileOf(agent),
          ...(skillOptions ? { skills, skillOptions } : {}),
        },
      },
    };
  }

  async function writeAgentRecord(current     , agentKey     , nextAgent     ) {
    const config = current.configSnapshot?.config;
    const configuredAgents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    const configuredIndex = configuredAgents.findIndex(
      (row     ) => cleanText(row?.id) === agentKey,
    );
    const nextAgents = configuredAgents.slice();
    if (configuredIndex >= 0) nextAgents[configuredIndex] = nextAgent;
    else nextAgents.push(nextAgent);

    const baseHash = cleanText(current.configSnapshot?.hash);
    if (!baseHash) {
      throw new OpenClawAgentSettingsError(
        "config_snapshot_unavailable",
        "OpenClaw did not provide a writable settings snapshot.",
        true,
      );
    }
    const listWrite = () => ({
      baseHash,
      raw: JSON.stringify({ agents: { list: nextAgents } }),
      replacePaths: ["agents.list"],
    });
    const entriesWrite = () => entryMergePatch(baseHash, agentKey, current.agent, nextAgent);
    const shape = agentRosterShape(config);
    let result;
    if (shape === "entries") {
      result = await gatewayBridge.request("config.patch", entriesWrite());
    } else {
      try {
        result = await gatewayBridge.request("config.patch", listWrite());
      } catch (error) {

        if (shape !== null || !isLegacyAgentListRefusal(error)) throw error;
        result = await gatewayBridge.request("config.patch", entriesWrite());
      }
    }
    if (result?.ok !== true) {
      throw new OpenClawAgentSettingsError(
        "settings_not_saved",
        "OpenClaw did not confirm the settings update.",
        true,
      );
    }
    return result;
  }

  async function getSettings(input      = {}) {
    const agentId = cleanText(input.agentId);
    if (!agentId) throw new OpenClawAgentSettingsError("invalid_agent_id", "Choose an agent first.");
    try {
      return (await snapshot(agentId)).result;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async function performSet(agentId     , input     ) {
    let configSaved = false;
    try {
      const { toolProfile: rawProfile, skills: rawSkills, ...rawSetup } =
        input.setup && typeof input.setup === "object" ? input.setup : {};

      const has = (key     ) => Object.prototype.hasOwnProperty.call(input.setup || {}, key);
      const toolProfile = has("toolProfile") ? normalizeToolProfile(rawProfile) : undefined;
      const skills = has("skills") ? normalizeSkills(rawSkills) : undefined;
      const unqualifiedModel = cleanText(rawSetup.model) && !cleanText(rawSetup.provider);
      const setup = normalizeAgentCreateSetup(
        unqualifiedModel ? { ...rawSetup, model: "", provider: "" } : rawSetup,
      );
      if (unqualifiedModel) setup.model = cleanText(rawSetup.model);
      const rawEmoji = input.emoji;
      const emoji = rawEmoji == null ? null : cleanText(rawEmoji) || null;
      const current = await snapshot(agentId);
      const agentKey = cleanText(current.agent?.id) || agentId;
      const nextAgent      = {
        ...(current.agent && typeof current.agent === "object" ? current.agent : {}),
        id: agentKey,
      };
      const nextIdentity      =
        nextAgent.identity && typeof nextAgent.identity === "object"
          ? { ...nextAgent.identity }
          : {};
      if (emoji == null) delete nextIdentity.emoji;
      else nextIdentity.emoji = emoji;
      if (Object.keys(nextIdentity).length > 0) nextAgent.identity = nextIdentity;
      else delete nextAgent.identity;
      if (setup.workspace) nextAgent.workspace = setup.workspace;
      else delete nextAgent.workspace;
      if (setup.model) {
        nextAgent.model = setup.provider ? `${setup.provider}/${setup.model}` : setup.model;
      } else {
        delete nextAgent.model;
      }
      applyAgentTools(nextAgent, setup.blockedTools, toolProfile);
      if (skills) nextAgent.skills = skills;
      else if (skills === null) delete nextAgent.skills;
      const result = await writeAgentRecord(current, agentKey, nextAgent);
      configSaved = true;

      const soul = await gatewayBridge.request("agents.files.set", {
        agentId,
        name: "SOUL.md",
        content: setup.instructions,
      });
      if (soul?.ok !== true) {
        throw new OpenClawAgentSettingsError(
          "instructions_not_saved",
          "OpenClaw did not confirm the instruction update.",
          true,
        );
      }
      if (refreshAgentsCatalog) {
        try { await refreshAgentsCatalog(true); } catch (error) {
          onCatalogRefreshError({ error, agentId });
        }
      }
      const loaded = current.result.setup;
      const savedSkills = skills === undefined ? loaded.skills : skills;
      return {
        status: "updated",
        backend: "openclaw",
        agentId,
        name: current.result.name,
        emoji,
        setup: {
          ...setup,
          toolProfile: toolProfile === undefined ? loaded.toolProfile : toolProfile,
          ...(loaded.skillOptions
            ? {
              skills: savedSkills,
              skillOptions: skillOptionsFrom(
                { skills: loaded.skillOptions.map((option     ) => ({ ...option, eligible: true })) },
                savedSkills,
              ),
            }
            : {}),
        },
        restartRequired: Boolean(result.restart),
      };
    } catch (error     ) {
      const normalized = normalizeError(error);
      if (configSaved) {
        normalized.code = "settings_partially_saved";
        normalized.message = "Other settings were saved, but instructions were not. Reload before trying again.";
      }
      throw normalized;
    }
  }

  function setSettings(input      = {}) {
    const agentId = cleanText(input.agentId);
    if (!agentId) return Promise.reject(new OpenClawAgentSettingsError("invalid_agent_id", "Choose an agent first."));
    const existing = inFlight.get(agentId);
    if (existing) return existing;
    const pending = queueWrite(agentId, () => performSet(agentId, input)).finally(() => {
      if (inFlight.get(agentId) === pending) inFlight.delete(agentId);
    });
    inFlight.set(agentId, pending);
    return pending;
  }

  function queueWrite(agentId     , write     ) {
    const previous = writeQueue.get(agentId) || Promise.resolve();
    const next = previous.catch(() => {}).then(write);
    const settled = next.catch(() => {});
    writeQueue.set(agentId, settled);
    settled.then(() => {
      if (writeQueue.get(agentId) === settled) writeQueue.delete(agentId);
    });
    return next;
  }

  async function performSetTools(agentId     , input     ) {
    try {
      const has = (key     ) => Object.prototype.hasOwnProperty.call(input, key);
      const blockedTools = has("blockedTools") ? normalizeBlockedGroups(input.blockedTools) : undefined;
      const toolProfile = has("toolProfile") ? normalizeToolProfile(input.toolProfile) : undefined;
      const current = await snapshot(agentId);
      const expectedHash = cleanText(input.baseHash);
      if (expectedHash && expectedHash !== cleanText(current.configSnapshot?.hash)) {
        throw new OpenClawAgentSettingsError(
          "config_changed",
          "OpenClaw settings changed at the same time. Reload and try again.",
          true,
        );
      }
      const agentKey = cleanText(current.agent?.id) || agentId;
      const nextAgent      = {
        ...(current.agent && typeof current.agent === "object" ? current.agent : {}),
        id: agentKey,
      };
      applyAgentTools(nextAgent, blockedTools, toolProfile);
      const result = await writeAgentRecord(current, agentKey, nextAgent);
      return { ok: true, restartRequired: Boolean(result.restart) };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  function setAgentTools(input      = {}) {
    const agentId = cleanText(input.agentId);
    if (!agentId) return Promise.reject(new OpenClawAgentSettingsError("invalid_agent_id", "Choose an agent first."));
    return queueWrite(agentId, () => performSetTools(agentId, input));
  }

  return {
    capability: OPENCLAW_AGENT_SETTINGS_CAPABILITY,
    isAvailable,
    getSettings,
    setSettings,
    setAgentTools,
  };
}

module.exports = { OPENCLAW_AGENT_SETTINGS_CAPABILITY, OPENCLAW_TOOL_PROFILES, OpenClawAgentSettingsError, createOpenClawAgentSettings };
