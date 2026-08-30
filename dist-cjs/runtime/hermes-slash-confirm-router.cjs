const DEFAULT_CONFIRM_TTL_MS = 300_000;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createHermesSlashConfirmRouter(deps = {}) {
  const hasConnectedClient =
    typeof deps.hasConnectedClient === "function"
      ? deps.hasConnectedClient
      : () => false;
  const presentDecision =
    typeof deps.presentDecision === "function" ? deps.presentDecision : () => false;
  const resolve =
    typeof deps.resolve === "function"
      ? deps.resolve
      : async () => ({});
  const applyReset =
    typeof deps.applyReset === "function" ? deps.applyReset : () => {};
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  async function resolveChoice(confirmId, sessionKey, decision = {}) {
    const choice = clean(decision.choice) || "cancel";
    const reason = clean(decision.reason) || "resolved";
    emit("slash_confirm_resolution", { sessionKey, confirmId, choice, reason });
    try {
      const result = await resolve({ confirmId, sessionKey, choice });
      if (result && result.temporaryReplyRemoved === true) {
        emit("temporary_reply_removed", { sessionKey, confirmId });
      }
      if (result && result.reset === true) applyReset(result);
    } catch (error) {

      emit("slash_confirm_resolution_failed", {
        sessionKey,
        confirmId,
        choice,
        reason,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  function present(params = {}) {
    const confirmId = clean(params.confirmId);
    const sessionKey = clean(params.sessionKey);
    const title = clean(params.title);
    const command = clean(params.command).replace(/^\//, "").toLowerCase();
    if (!confirmId || !sessionKey || !title) {
      emit("slash_confirm_fallback", { reason: "invalid_request" });
      return { presented: false, reason: "invalid_request" };
    }
    if (!hasConnectedClient()) {
      emit("slash_confirm_fallback", { sessionKey, confirmId, reason: "no_connected_client" });
      return { presented: false, reason: "no_connected_client" };
    }

    const expiresAtMs = Number.isFinite(params.expiresAtMs)
      ? Number(params.expiresAtMs)
      : now() + DEFAULT_CONFIRM_TTL_MS;
    const ttlMs = Math.max(1, expiresAtMs - now());
    const surfaceId = `hermes-slash-confirm:${sessionKey}:${confirmId}`;
    const question =
      command === "undo"
        ? "Undo the last conversation turn?"
        : command === "reload-mcp"
          ? "Reload MCP servers now?"
          : command === "reset" || command === "new" || command === "clear"
            ? "Reset this chat and replace its current conversation?"
            : `Run /${command || "this command"}?`;
    const accepted = presentDecision({
      surface: {
        surfaceId,
        sessionKey,
        kind: "permission",
        title,

        question,
        options: [
          {
            key: "once",
            label: "Approve once",
            detail: command ? `Run /${command} once.` : "Run this command once.",
          },
          {
            key: "always",
            label: "Always approve",
            detail:
              "Stop asking before destructive slash commands for this Hermes profile. Re-enable approvals.destructive_slash_confirm: true in config.yaml.",
          },
          { key: "cancel", label: "Cancel", detail: "Keep this conversation unchanged." },
        ],
        deadlineSec: Math.max(1, Math.ceil(ttlMs / 1000)),
      },
      expiresAtMs,
      onDecision: (decision) => resolveChoice(confirmId, sessionKey, decision),
    });
    if (!accepted) {
      emit("slash_confirm_fallback", { sessionKey, confirmId, reason: "presentation_failed" });
      return { presented: false, reason: "presentation_failed" };
    }
    emit("slash_confirm_presented", { sessionKey, confirmId, expiresAtMs });
    return { presented: true };
  }

  return { present };
}

module.exports = { createHermesSlashConfirmRouter };
