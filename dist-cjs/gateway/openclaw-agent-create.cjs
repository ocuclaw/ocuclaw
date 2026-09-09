const { normalizeAgentCreateSetup } = require("./agent-create-setup.cjs");
const OPENCLAW_AGENT_CREATE_CAPABILITY = "openclawAgentCreate";

const DEFAULT_AGENT_ID = "main";
const VALID_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS = /[^a-z0-9_-]+/g;
const LEADING_DASHES = /^-+/;
const TRAILING_DASHES = /-+$/;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOpenClawAgentId(value) {
  const trimmed = cleanText(value);
  if (!trimmed) return DEFAULT_AGENT_ID;
  const normalized = trimmed.toLowerCase();
  if (VALID_AGENT_ID.test(trimmed)) return normalized;
  return (
    normalized
      .replace(INVALID_AGENT_ID_CHARS, "-")
      .replace(LEADING_DASHES, "")
      .replace(TRAILING_DASHES, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function defaultOpenClawAgentWorkspace(agentId) {
  const normalized = normalizeOpenClawAgentId(agentId);
  return `~/.openclaw/workspace-${normalized}`;
}

class OpenClawAgentCreateError extends Error {
  code;
  retryable;

  constructor(code, message, retryable = false) {
    super(message);
    this.name = "OpenClawAgentCreateError";
    this.code = code;
    this.retryable = retryable;
  }
}

function creationError(error) {
  if (error instanceof OpenClawAgentCreateError) return error;
  const rawMessage = cleanText(error && error.message) || "OpenClaw rejected the request";
  const message = rawMessage.toLowerCase();

  if (message.includes("already exists")) {
    return new OpenClawAgentCreateError(
      "agent_already_exists",
      rawMessage,
      false,
    );
  }
  if (message.includes("reserved") && message.includes(DEFAULT_AGENT_ID)) {
    return new OpenClawAgentCreateError("reserved_agent_id", rawMessage, false);
  }
  if (
    message.includes("method not found") ||
    message.includes("unknown method") ||
    error?.code === -32601 ||
    error?.code === "METHOD_NOT_FOUND"
  ) {
    return new OpenClawAgentCreateError(
      "capability_unavailable",
      "This OpenClaw host cannot create agents from the phone.",
      false,
    );
  }
  if (
    message.includes("gateway not connected") ||
    message.includes("handshake") ||
    message.includes("timeout") ||
    error?.code === "rpc_timeout" ||
    error?.code === "handshake_pending"
  ) {
    return new OpenClawAgentCreateError(
      "backend_unavailable",
      "OpenClaw is not ready. Try again when it reconnects.",
      true,
    );
  }
  return new OpenClawAgentCreateError("agent_create_failed", rawMessage, true);
}

function createOpenClawAgentCreator(deps = {}) {
  const gatewayBridge = deps.gatewayBridge;
  const refreshAgentsCatalog =
    typeof deps.refreshAgentsCatalog === "function"
      ? deps.refreshAgentsCatalog
      : null;
  const onCatalogRefreshError =
    typeof deps.onCatalogRefreshError === "function"
      ? deps.onCatalogRefreshError
      : () => {};
  const inFlight = new Map();

  const receipts = new Map();

  async function applySetup(agentId, setup) {
    let restartRequired = false;
    if (setup.instructions) {
      const saved = await gatewayBridge.request("agents.files.set", { agentId, name: "SOUL.md", content: setup.instructions });
      if (saved?.ok !== true) throw new Error("Personality was not confirmed saved.");
    }
    if (setup.blockedTools.length) {
      const snapshot = await gatewayBridge.request("config.get", {});
      const list = snapshot?.config?.agents?.list;
      if (!snapshot?.hash || !Array.isArray(list) || !list.some(x => x.id === agentId)) {
        throw new Error("Could not read the new agent's tool settings.");
      }
      const groups = { web: ["web_search", "web_fetch"], files: ["read", "write", "edit", "apply_patch"], terminal: ["exec", "process"] };
      const next = list.map(x => x.id !== agentId ? x : {
        ...x, tools: { ...x.tools, deny: [...new Set([...(x.tools?.deny || []), ...setup.blockedTools.flatMap((k) => groups[k])])] },
      });
      const saved = await gatewayBridge.request("config.patch", {
        baseHash: snapshot.hash, raw: JSON.stringify({ agents: { list: next } }),
      });
      if (saved?.ok !== true) throw new Error("Tool blocks were not confirmed saved.");
      restartRequired = Boolean(saved.restart);
    }
    return restartRequired;
  }

  async function createWithSetup(input, setup) {
    const requestId = cleanText(input.requestId);
    if (!requestId || requestId.length > 120) throw new Error("Missing or invalid setup request id.");
    const name = cleanText(input.name);
    const fingerprint = JSON.stringify({ name, setup });
    let receipt = receipts.get(requestId);
    if (receipt && receipt.fingerprint !== fingerprint) throw new Error("This request belongs to another draft.");
    if (!receipt) {
      if (receipts.size >= 128) throw new Error("Creation receipt limit reached. Reconnect after the relay restarts.");
      receipt = { fingerprint, result: null, pending: null, agent: null, failed: null };
      receipts.set(requestId, receipt);
    }
    if (receipt.pending) return receipt.pending;
    if (receipt.result?.status === "created") return receipt.result;
    if (receipt.failed) throw receipt.failed;
    receipt.pending = (async () => {
      const agentId = normalizeOpenClawAgentId(name);
      if (!name || agentId === DEFAULT_AGENT_ID) throw new OpenClawAgentCreateError("reserved_agent_id", "Choose a name other than main.");
      if (!receipt.agent) {
        try {
          const result = await gatewayBridge.request("agents.create", {
            name, workspace: setup.workspace || defaultOpenClawAgentWorkspace(agentId),
            ...(setup.model ? { model: `${setup.provider}/${setup.model}` } : {}),
          });
          if (result?.ok !== true || result.agentId !== agentId) throw new Error("Creation was not confirmed. Check the agent list before trying another draft.");
          receipt.agent = { id: result.agentId, name: cleanText(result.name) || name };
        } catch (error) {

          receipt.failed = creationError(error);
          throw receipt.failed;
        }
      }
      try {
        const restartRequired = await applySetup(agentId, setup);
        receipt.result = { status: "created", agent: receipt.agent, restartRequired };
      } catch (error) {
        receipt.result = {
          status: "partial", agent: receipt.agent, restartRequired: false,
          errorCode: "setup_incomplete", errorMessage: "Agent created, but some settings were not saved. Retry setup on this same agent.",
        };
      }
      if (refreshAgentsCatalog) {
        try { await refreshAgentsCatalog(true); } catch (error) { onCatalogRefreshError({ error, agent: receipt.agent }); }
      }
      return receipt.result;
    })().finally(() => { receipt.pending = null; });
    return receipt.pending;
  }

  function backendKind() {
    if (typeof deps.backendKind === "function") {
      return cleanText(deps.backendKind()).toLowerCase();
    }
    return cleanText(deps.backendKind || gatewayBridge?.kind).toLowerCase();
  }

  function supportsCreation() {
    return (
      backendKind() === "openclaw" &&
      !!gatewayBridge &&
      typeof gatewayBridge.request === "function"
    );
  }

  function isAvailable() {
    return (
      supportsCreation() &&
      (typeof deps.isConnected !== "function" || deps.isConnected() === true)
    );
  }

  async function performCreate(name, agentId) {
    if (!supportsCreation()) {
      throw new OpenClawAgentCreateError(
        "capability_unavailable",
        "Agent creation is not supported by this backend.",
        false,
      );
    }
    if (!isAvailable()) {
      throw new OpenClawAgentCreateError(
        "backend_unavailable",
        "OpenClaw is not ready. Try again when it reconnects.",
        true,
      );
    }

    let result;
    try {
      result = await gatewayBridge.request("agents.create", {
        name,
        workspace: defaultOpenClawAgentWorkspace(agentId),
      });
    } catch (error) {
      throw creationError(error);
    }

    const returnedId = cleanText(result && result.agentId);
    if (
      !result ||
      result.ok !== true ||
      !returnedId ||
      normalizeOpenClawAgentId(returnedId) !== agentId
    ) {
      throw new OpenClawAgentCreateError(
        "agent_create_indeterminate",
        "OpenClaw did not confirm the new agent. Refresh the agent list before retrying.",
        true,
      );
    }

    const agent = {
      id: returnedId,
      name: cleanText(result.name) || name,
    };
    if (refreshAgentsCatalog) {
      try {
        await refreshAgentsCatalog(true);
      } catch (error) {
        onCatalogRefreshError({ error, agent });
      }
    }
    return {
      status: "created",
      agent,
      restartRequired: false,
    };
  }

  function createAgent(input = {}) {
    if (input.setup != null) {
      if (!isAvailable()) return Promise.reject(new Error("OpenClaw is not ready."));
      try { return createWithSetup(input, normalizeAgentCreateSetup(input.setup)); }
      catch (error) { return Promise.reject(error); }
    }
    const name = cleanText(input && input.name);
    if (!name) {
      return Promise.reject(
        new OpenClawAgentCreateError(
          "invalid_agent_name",
          "Enter a name for the new agent.",
          false,
        ),
      );
    }
    const agentId = normalizeOpenClawAgentId(name);
    if (agentId === DEFAULT_AGENT_ID) {
      return Promise.reject(
        new OpenClawAgentCreateError(
          "reserved_agent_id",
          '"main" is reserved. Choose another name.',
          false,
        ),
      );
    }

    const existing = inFlight.get(agentId);
    if (existing) return existing;
    const pending = performCreate(name, agentId).finally(() => {
      if (inFlight.get(agentId) === pending) inFlight.delete(agentId);
    });
    inFlight.set(agentId, pending);
    return pending;
  }

  return {
    capability: OPENCLAW_AGENT_CREATE_CAPABILITY,
    supportsCreation,
    isAvailable,
    createAgent,
  };
}

module.exports = { OPENCLAW_AGENT_CREATE_CAPABILITY, OpenClawAgentCreateError, normalizeOpenClawAgentId, defaultOpenClawAgentWorkspace, createOpenClawAgentCreator };
