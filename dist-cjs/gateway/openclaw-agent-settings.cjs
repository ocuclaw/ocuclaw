const { normalizeAgentCreateSetup } = require("./agent-create-setup.cjs");

const OPENCLAW_AGENT_SETTINGS_CAPABILITY = "openclawAgentSettings";

const MANAGED_TOOL_GROUPS = {
  web: ["web_search", "web_fetch"],
  files: ["read", "write", "edit", "apply_patch"],
  terminal: ["exec", "process"],
};
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function modelParts(raw) {
  const value = cleanText(
    typeof raw === "string" ? raw : raw?.primary || raw?.default || raw?.model,
  );
  if (!value) return { model: "", provider: "" };
  const slash = value.indexOf("/");
  return slash > 0
    ? { provider: value.slice(0, slash), model: value.slice(slash + 1) }
    : { provider: "", model: value };
}

function blockedGroups(deny) {
  const denied = new Set(Array.isArray(deny) ? deny.filter((x) => typeof x === "string") : []);
  return ["web", "files", "terminal"]
    .filter((group) => MANAGED_TOOL_GROUPS[group].every((tool) => denied.has(tool)));
}

class OpenClawAgentSettingsError extends Error {
  code;
  retryable;

  constructor(code, message, retryable = false) {
    super(message);
    this.name = "OpenClawAgentSettingsError";
    this.code = code;
    this.retryable = retryable;
  }
}

function normalizeError(error) {
  if (error instanceof OpenClawAgentSettingsError) return error;
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

function createOpenClawAgentSettings(deps = {}) {
  const gatewayBridge = deps.gatewayBridge;
  const refreshAgentsCatalog =
    typeof deps.refreshAgentsCatalog === "function" ? deps.refreshAgentsCatalog : null;
  const onCatalogRefreshError =
    typeof deps.onCatalogRefreshError === "function" ? deps.onCatalogRefreshError : () => {};
  const inFlight = new Map();

  function isAvailable() {
    return (
      cleanText(typeof deps.backendKind === "function" ? deps.backendKind() : deps.backendKind)
        .toLowerCase() === "openclaw" &&
      !!gatewayBridge &&
      typeof gatewayBridge.request === "function" &&
      (typeof deps.isConnected !== "function" || deps.isConnected() === true)
    );
  }

  async function snapshot(agentId) {
    if (!isAvailable()) {
      throw new OpenClawAgentSettingsError(
        "backend_unavailable",
        "OpenClaw is not ready. Try again when it reconnects.",
        true,
      );
    }
    const configSnapshot = await gatewayBridge.request("config.get", {});
    const list = configSnapshot?.config?.agents?.list;
    const agent = Array.isArray(list) ? list.find((row) => cleanText(row?.id) === agentId) : null;
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
        },
      },
    };
  }

  async function getSettings(input = {}) {
    const agentId = cleanText(input.agentId);
    if (!agentId) throw new OpenClawAgentSettingsError("invalid_agent_id", "Choose an agent first.");
    try {
      return (await snapshot(agentId)).result;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async function performSet(agentId, input) {
    let configSaved = false;
    try {
      const rawSetup = input.setup && typeof input.setup === "object" ? input.setup : {};
      const unqualifiedModel = cleanText(rawSetup.model) && !cleanText(rawSetup.provider);
      const setup = normalizeAgentCreateSetup(
        unqualifiedModel ? { ...rawSetup, model: "", provider: "" } : rawSetup,
      );
      if (unqualifiedModel) setup.model = cleanText(rawSetup.model);
      const rawEmoji = input.emoji;
      const emoji = rawEmoji == null ? null : cleanText(rawEmoji) || null;
      const current = await snapshot(agentId);
      const currentDeny = Array.isArray(current.agent?.tools?.deny)
        ? current.agent.tools.deny.filter((x) => typeof x === "string")
        : [];
      const currentlyBlocked = blockedGroups(currentDeny);
      const currentlyManagedTools = new Set(
        currentlyBlocked.flatMap((group) => MANAGED_TOOL_GROUPS[group] || []),
      );
      const deny = [
        ...currentDeny.filter((tool) => !currentlyManagedTools.has(tool)),
        ...setup.blockedTools.flatMap((group) => MANAGED_TOOL_GROUPS[group] || []),
      ];

      const configuredAgents = Array.isArray(current.configSnapshot?.config?.agents?.list)
        ? current.configSnapshot.config.agents.list
        : [];
      const configuredIndex = configuredAgents.findIndex(
        (row) => cleanText(row?.id) === agentId,
      );
      const nextAgent = {
        ...(current.agent && typeof current.agent === "object" ? current.agent : {}),
        id: agentId,
      };
      const nextIdentity =
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
      const nextTools =
        nextAgent.tools && typeof nextAgent.tools === "object" ? { ...nextAgent.tools } : {};
      const uniqueDeny = [...new Set(deny)];
      if (uniqueDeny.length > 0) nextTools.deny = uniqueDeny;
      else delete nextTools.deny;
      if (Object.keys(nextTools).length > 0) nextAgent.tools = nextTools;
      else delete nextAgent.tools;
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
      const result = await gatewayBridge.request("config.patch", {
        baseHash,
        raw: JSON.stringify({
          agents: {
            list: nextAgents,
          },
        }),
        replacePaths: ["agents.list"],
      });
      if (result?.ok !== true) {
        throw new OpenClawAgentSettingsError(
          "settings_not_saved",
          "OpenClaw did not confirm the settings update.",
          true,
        );
      }
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
      return {
        status: "updated",
        backend: "openclaw",
        agentId,
        name: current.result.name,
        emoji,
        setup,
        restartRequired: Boolean(result.restart),
      };
    } catch (error) {
      const normalized = normalizeError(error);
      if (configSaved) {
        normalized.code = "settings_partially_saved";
        normalized.message = "Other settings were saved, but instructions were not. Reload before trying again.";
      }
      throw normalized;
    }
  }

  function setSettings(input = {}) {
    const agentId = cleanText(input.agentId);
    if (!agentId) return Promise.reject(new OpenClawAgentSettingsError("invalid_agent_id", "Choose an agent first."));
    const existing = inFlight.get(agentId);
    if (existing) return existing;
    const pending = performSet(agentId, input).finally(() => {
      if (inFlight.get(agentId) === pending) inFlight.delete(agentId);
    });
    inFlight.set(agentId, pending);
    return pending;
  }

  return { capability: OPENCLAW_AGENT_SETTINGS_CAPABILITY, isAvailable, getSettings, setSettings };
}

module.exports = { OPENCLAW_AGENT_SETTINGS_CAPABILITY, OpenClawAgentSettingsError, createOpenClawAgentSettings };
