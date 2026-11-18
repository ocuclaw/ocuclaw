const { normalizeAgentCreateSetup } = require("./agent-create-setup.cjs");
const { agentRosterShape, findConfiguredAgent } = require("./openclaw-agent-roster.cjs");
const OPENCLAW_AGENT_CREATE_CAPABILITY = "openclawAgentCreate";

const DEFAULT_AGENT_ID = "main";
const VALID_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS = /[^a-z0-9_-]+/g;
const LEADING_DASHES = /^-+/;
const TRAILING_DASHES = /-+$/;

function cleanText(value         ) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOpenClawAgentId(value         ) {
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

function agentIdForName(name     ) {
  if (!name) {
    throw new OpenClawAgentCreateError("invalid_agent_name", "Enter a name for the new agent.", false);
  }
  const agentId = normalizeOpenClawAgentId(name);
  if (agentId !== DEFAULT_AGENT_ID) return agentId;
  if (!/[a-z0-9]/i.test(name)) {
    throw new OpenClawAgentCreateError("invalid_name", "Use at least one letter or number in the name.", false);
  }
  throw new OpenClawAgentCreateError("reserved_agent_id", '"main" is reserved. Choose another name.', false);
}

function defaultOpenClawAgentWorkspace(agentId         ) {
  const normalized = normalizeOpenClawAgentId(agentId);
  return `~/.openclaw/workspace-${normalized}`;
}

class OpenClawAgentCreateError extends Error {
  code     ;
  retryable     ;

  constructor(code     , message     , retryable = false) {
    super(message);
    this.name = "OpenClawAgentCreateError";
    this.code = code;
    this.retryable = retryable;
  }
}

function creationError(error     , name      = "") {
  if (error instanceof OpenClawAgentCreateError) return error;
  const rawMessage = cleanText(error && error.message) || "OpenClaw rejected the request";
  const message = rawMessage.toLowerCase();

  if (message.includes("already exists")) {
    return new OpenClawAgentCreateError(
      "agent_already_exists",
      name ? `An agent named ${name} already exists.` : "An agent with this name already exists.",
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

function createOpenClawAgentCreator(deps      = {}) {
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
  const receiptLimit = Number.isInteger(deps.receiptLimit) && deps.receiptLimit > 0 ? deps.receiptLimit : 128;

  function makeRoomForReceipt() {
    for (const [key, held] of receipts) {
      if (receipts.size < receiptLimit) return;
      if (!held.pending) receipts.delete(key);
    }
    if (receipts.size >= receiptLimit) {
      throw new OpenClawAgentCreateError(
        "backend_unavailable",
        "Too many agents are being created. Try again in a moment.",
        true,
      );
    }
  }

  const settleMs = Number.isFinite(deps.newAgentSettleMs) ? deps.newAgentSettleMs : 250;

  async function onceAgentVisible(fn     ) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (error     ) {
        const message = cleanText(error?.message);
        if (attempt >= 8 || !/not found|could not read the new agent/i.test(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
    }
  }

  async function applySetup(agentId     , setup     ) {
    let restartRequired = false;
    if (setup.instructions) {
      const saved = await onceAgentVisible(() =>
        gatewayBridge.request("agents.files.set", { agentId, name: "SOUL.md", content: setup.instructions }));
      if (saved?.ok !== true) throw new Error("Personality was not confirmed saved.");
    }
    if (setup.blockedTools.length) {
      const { snapshot, agent } = await onceAgentVisible(async () => {
        const snapshot = await gatewayBridge.request("config.get", {});
        const agent = findConfiguredAgent(snapshot?.config, agentId);
        if (!snapshot?.hash || !agent) throw new Error("Could not read the new agent's tool settings.");
        return { snapshot, agent };
      });
      const config = snapshot.config;
      const groups      = { web: ["web_search", "web_fetch"], files: ["read", "write", "edit", "apply_patch"], terminal: ["exec", "process"] };
      const withBlocks = (x     ) => [...new Set([...(x.tools?.deny || []), ...setup.blockedTools.flatMap((k     ) => groups[k])])];

      const agents = agentRosterShape(config) === "entries"
        ? { entries: { [agent.id]: { tools: { deny: withBlocks(agent) } } } }
        : { list: config.agents.list.map((x     ) => x.id !== agent.id ? x : { ...x, tools: { ...x.tools, deny: withBlocks(x) } }) };
      const saved = await gatewayBridge.request("config.patch", {
        baseHash: snapshot.hash, raw: JSON.stringify({ agents }),
      });
      if (saved?.ok !== true) throw new Error("Tool blocks were not confirmed saved.");
      restartRequired = Boolean(saved.restart);
    }
    return restartRequired;
  }

  async function createWithSetup(input     , setup     ) {
    const requestId = cleanText(input.requestId);
    if (!requestId || requestId.length > 120) {
      throw new OpenClawAgentCreateError("invalid_setup", "Missing or invalid setup request id.", false);
    }
    const name = cleanText(input.name);
    const agentId = agentIdForName(name);
    const fingerprint = JSON.stringify({ name, setup });
    let receipt = receipts.get(requestId);
    if (receipt && receipt.fingerprint !== fingerprint) {
      throw new OpenClawAgentCreateError("invalid_setup", "This request belongs to another draft.", false);
    }
    if (!receipt) {
      makeRoomForReceipt();
      receipt = { fingerprint, result: null, pending: null, agent: null, failed: null };
      receipts.set(requestId, receipt);
    }
    if (receipt.pending) return receipt.pending;
    if (receipt.result?.status === "created") return receipt.result;
    if (receipt.failed) throw receipt.failed;
    receipt.pending = (async () => {
      if (!receipt.agent) {
        try {
          const result = await gatewayBridge.request("agents.create", {
            name, workspace: setup.workspace || defaultOpenClawAgentWorkspace(agentId),
            ...(setup.model ? { model: `${setup.provider}/${setup.model}` } : {}),
          });
          const returnedId = cleanText(result && result.agentId);
          if (result?.ok !== true || !returnedId || normalizeOpenClawAgentId(returnedId) !== agentId) {
            throw new OpenClawAgentCreateError(
              "agent_create_indeterminate",
              "Creation was not confirmed. Check the agent list before trying another draft.",
              true,
            );
          }
          receipt.agent = { id: returnedId, name: cleanText(result.name) || name };
        } catch (error) {

          receipt.failed = creationError(error, name);
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

  async function performCreate(name     , agentId     ) {
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
      throw creationError(error, name);
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

  function createAgent(input      = {}) {
    if (input.setup != null) {
      if (!supportsCreation()) {
        return Promise.reject(new OpenClawAgentCreateError(
          "capability_unavailable", "Agent creation is not supported by this backend.", false));
      }
      if (!isAvailable()) {
        return Promise.reject(new OpenClawAgentCreateError(
          "backend_unavailable", "OpenClaw is not ready. Try again when it reconnects.", true));
      }
      let setup;
      try { setup = normalizeAgentCreateSetup(input.setup); }
      catch (error     ) {
        return Promise.reject(new OpenClawAgentCreateError(
          "invalid_setup", cleanText(error && error.message) || "Invalid agent setup.", false));
      }
      try { return createWithSetup(input, setup); }
      catch (error) { return Promise.reject(creationError(error, cleanText(input.name))); }
    }
    const name = cleanText(input && input.name);
    let agentId;
    try { agentId = agentIdForName(name); }
    catch (error) { return Promise.reject(error); }

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

module.exports = { OPENCLAW_AGENT_CREATE_CAPABILITY, normalizeOpenClawAgentId, defaultOpenClawAgentWorkspace, OpenClawAgentCreateError, createOpenClawAgentCreator };
