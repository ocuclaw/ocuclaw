const OPENCLAW_AGENT_EMOJI_CAPABILITY = "openclawAgentEmojiSet";

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

class OpenClawAgentEmojiError extends Error {
  code;
  retryable;

  constructor(code, message, retryable = false) {
    super(message);
    this.name = "OpenClawAgentEmojiError";
    this.code = code;
    this.retryable = retryable;
  }
}

function normalizeError(error) {
  if (error instanceof OpenClawAgentEmojiError) return error;
  const message = cleanText(error?.message) || "OpenClaw rejected the emoji update";
  const lower = message.toLowerCase();
  if (lower.includes("base hash") || lower.includes("config changed")) {
    return new OpenClawAgentEmojiError(
      "config_changed",
      "OpenClaw settings changed at the same time. Refresh and try again.",
      true,
    );
  }
  if (
    lower.includes("not connected") ||
    lower.includes("handshake") ||
    lower.includes("timeout")
  ) {
    return new OpenClawAgentEmojiError(
      "backend_unavailable",
      "OpenClaw is not ready. Try again when it reconnects.",
      true,
    );
  }
  return new OpenClawAgentEmojiError("emoji_update_failed", message, true);
}

function createOpenClawAgentEmojiUpdater(deps = {}) {
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

  async function perform(agentId, emoji) {
    if (!isAvailable()) {
      throw new OpenClawAgentEmojiError(
        "backend_unavailable",
        "OpenClaw is not ready. Try again when it reconnects.",
        true,
      );
    }
    try {
      const snapshot = await gatewayBridge.request("config.get", {});
      const baseHash = cleanText(snapshot?.hash);
      if (!baseHash) {
        throw new OpenClawAgentEmojiError(
          "config_snapshot_unavailable",
          "OpenClaw did not provide a writable settings snapshot.",
          true,
        );
      }
      const patch = {
        agents: {
          list: [{ id: agentId, identity: { emoji } }],
        },
      };
      const result = await gatewayBridge.request("config.patch", {
        raw: JSON.stringify(patch),
        baseHash,
      });
      if (!result || result.ok !== true) {
        throw new OpenClawAgentEmojiError(
          "emoji_update_indeterminate",
          "OpenClaw did not confirm the emoji update.",
          true,
        );
      }
    } catch (error) {
      throw normalizeError(error);
    }

    if (refreshAgentsCatalog) {
      try {
        await refreshAgentsCatalog(true);
      } catch (error) {
        onCatalogRefreshError({ error, agentId, emoji });
      }
    }
    return { status: "updated", backend: "openclaw", agentId, emoji };
  }

  function setEmoji(input = {}) {
    const agentId = cleanText(input.agentId);
    if (!agentId) {
      return Promise.reject(
        new OpenClawAgentEmojiError("invalid_agent_id", "Choose an agent first."),
      );
    }
    const rawEmoji = input.emoji;
    const emoji = rawEmoji == null ? null : cleanText(rawEmoji) || null;
    const existing = inFlight.get(agentId);
    if (existing) return existing;
    const pending = perform(agentId, emoji).finally(() => {
      if (inFlight.get(agentId) === pending) inFlight.delete(agentId);
    });
    inFlight.set(agentId, pending);
    return pending;
  }

  return { capability: OPENCLAW_AGENT_EMOJI_CAPABILITY, isAvailable, setEmoji };
}

module.exports = { OPENCLAW_AGENT_EMOJI_CAPABILITY, OpenClawAgentEmojiError, createOpenClawAgentEmojiUpdater };
