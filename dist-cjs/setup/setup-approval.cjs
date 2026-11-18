const { createRelayPortApprovalHook } = require("./relay-port-mutation.cjs");
const { createRelayCredentialApprovalHook } = require("./relay-credential-provision.cjs");
const { CONFIRM_PAIRING_OPERATION, consumeApproval, heldPairingExchange, lookupApproval, openClawApprovalRequest, releasePairingExchange, SETUP_APPROVAL_OPERATIONS } = require("./setup-approval-store.cjs");

const SETUP_CHAT_STALE_BINDING_REASON =
  "stale_binding: this approval is not current. Call ocuclaw_setup next for a fresh one.";

function createSetupChatApprovalHook(options      = {}) {
  const stateDir = typeof options?.stateDir === "function" ? options.stateDir : () => null;
  return async function requireSetupChatApproval(event     ) {
    if (event?.toolName !== "ocuclaw_setup") return undefined;
    const operation = event?.params?.operation;
    if (!(SETUP_APPROVAL_OPERATIONS                     ).includes(operation)) return undefined;
    let dir      = null;
    try { dir = stateDir(); } catch (_) { dir = null; }
    const entry = lookupApproval(dir, event.params.binding);
    if (!entry || entry.operation !== operation) {
      return { block: true, blockReason: SETUP_CHAT_STALE_BINDING_REASON };
    }
    const request      = openClawApprovalRequest(operation, entry.shown);
    if (operation === CONFIRM_PAIRING_OPERATION) {
      request.requireApproval.onResolution = (decision     ) => refusedPairingCard(dir, entry.binding, decision);
    }
    return request;
  };
}

const REFUSED_CARD_DECISIONS = new Set(["deny", "timeout", "cancelled"]);

async function refusedPairingCard(stateDir     , binding     , decision     )                   {
  if (!REFUSED_CARD_DECISIONS.has(String(decision || "").toLowerCase())) return false;
  const entry = consumeApproval(stateDir, binding, CONFIRM_PAIRING_OPERATION);
  if (!entry) return false;
  const held = heldPairingExchange(stateDir);
  if (!held || (entry.exchangeId && held.exchangeId !== entry.exchangeId)) return false;
  releasePairingExchange(stateDir, "failed");
  try { await held.call("cancel"); } catch (_) {  }
  return true;
}

function createSetupApprovalHook(extraHooks      = [], options      = {}) {
  const hooks = [createRelayPortApprovalHook(), createRelayCredentialApprovalHook(),
    ...(Array.isArray(extraHooks) ? extraHooks : []), createSetupChatApprovalHook(options)];
  return async function requireSetupApproval(event     , ctx      = undefined) {
    for (const hook of hooks) {
      const decision = await hook(event, ctx);
      if (decision) return decision;
    }
    return undefined;
  };
}

module.exports = { SETUP_CHAT_STALE_BINDING_REASON, createSetupChatApprovalHook, refusedPairingCard, createSetupApprovalHook };
