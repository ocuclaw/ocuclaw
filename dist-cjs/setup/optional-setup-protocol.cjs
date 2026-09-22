const { normalizeDnsName } = require("./private-route.cjs");
const operations      = {
  status: [],
  "credential.begin": ["capability", "intent"],
  "credential.save": ["transactionId", "credential"],
  "credential.cancel": ["transactionId"],
  "activation.preview": [],
  "activation.apply": ["operationId"],
  "activation.status": ["operationId"],
  "diagnostics.preview": ["permission", "allowed"],
  "diagnostics.apply": ["operationId"],
  "route.preview": [],
  "route.apply": ["operationId"],
  "route.status": ["operationId"],
  "evenai.test.arm": [],
  "evenai.test.cancel": [],
};
const id = (value     ) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function parseOptionalSetupRequest(value     ) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !id(value.requestId) || !Object.prototype.hasOwnProperty.call(operations, value.operation)) return null;
  const keys = ["type", "requestId", "operation", ...operations[value.operation]];
  if (Object.keys(value).some(key => !keys.includes(key))
      || (value.type !== undefined && value.type !== "ocuclaw.optional.setup.request")) return null;
  if (value.operation === "credential.begin" && (!["soniox", "even_ai"].includes(value.capability) || !["create", "replace"].includes(value.intent))) return null;
  if (value.operation.startsWith("credential.") && value.operation !== "credential.begin" && !id(value.transactionId)) return null;
  if (value.operation === "credential.save" && (typeof value.credential !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(value.credential))) return null;
  if (["activation.apply", "activation.status", "diagnostics.apply", "route.apply", "route.status"].includes(value.operation) && !id(value.operationId)) return null;
  if (value.operation === "diagnostics.preview" && (!["access", "handoff"].includes(value.permission) || typeof value.allowed !== "boolean")) return null;
  const request      = { requestId: value.requestId, operation: value.operation };
  for (const key of operations[value.operation]) request[key] = value[key];
  return request;
}

function optionalSetupFailure(request     , code = "unavailable", status = "rejected") {
  return { requestId: id(request?.requestId) ? request.requestId : "",
    operation: Object.prototype.hasOwnProperty.call(operations, request?.operation) ? request.operation : "status", status, code };
}

function optionalSetupResult(request     , result     ) {
  const states = ["not_configured", "saved", "available_to_test", "unknown", "save_failed"];
  const modes = ["hot_reload", "restart", "manual", "none"];
  const allowedStatus = ["ok", "saved", "preserved", "cancelled", "rejected", "unsupported", "outcome_unknown"];
  const codes = ["invalid_request", "phone_only", "unsupported", "unavailable", "not_connected", "configuration_changed", "transaction_expired", "transaction_invalid", "replacement_required", "busy", "save_unconfirmed", "activation_unavailable", "operation_unknown", "activation_pending", "invalid_input"];
  if (!result || !allowedStatus.includes(result.status)) return optionalSetupFailure(request, "unavailable", "outcome_unknown");
  const out      = { requestId: request.requestId, operation: request.operation, status: result.status };
  if (codes.includes(result.code)) out.code = result.code;
  const snapshot = result.snapshot;
  if (snapshot && ["openclaw", "hermes"].includes(snapshot.runtime) && id(snapshot.generation)) {
    const capabilities      = {};
    for (const key of ["soniox", "even_ai"]) {
      const row = snapshot.capabilities?.[key];
      capabilities[key] = { present: row?.present === true, state: states.includes(row?.state) ? row.state : "unknown" };
    }
    const activation = snapshot.activation;
    out.snapshot = { runtime: snapshot.runtime, generation: snapshot.generation, capabilities,
      coreComplete: typeof snapshot.coreComplete === "boolean" ? snapshot.coreComplete : null,
      activation: { supported: activation?.supported === true, required: activation?.required === true,
        mode: modes.includes(activation?.mode) ? activation.mode : "none", affectsAllProfiles: activation?.affectsAllProfiles === true } };
    if (snapshot.diagnostics) {
      const d = snapshot.diagnostics;
      out.snapshot.diagnostics = { supported: d.supported === true, access: d.access === true, handoff: d.handoff === true,
        activeAccess: typeof d.activeAccess === "boolean" ? d.activeAccess : null,
        activeHandoff: typeof d.activeHandoff === "boolean" ? d.activeHandoff : null };
    }
  }
  const transaction = result.transaction;
  if (transaction && id(transaction.id) && Number.isFinite(transaction.expiresAtMs)
      && ["soniox", "even_ai"].includes(transaction.capability) && ["create", "replace"].includes(transaction.intent)) {
    out.transaction = { id: transaction.id, expiresAtMs: transaction.expiresAtMs, capability: transaction.capability, intent: transaction.intent };
  }
  const activation = result.activation;
  if (activation && id(activation.operationId) && Number.isFinite(activation.expiresAtMs)
      && modes.includes(activation.mode) && ["preview", "accepted", "pending", "complete", "unknown", "unsupported"].includes(activation.state)) {
    out.activation = { operationId: activation.operationId, expiresAtMs: activation.expiresAtMs,
      mode: activation.mode, affectsAllProfiles: activation.affectsAllProfiles === true, state: activation.state };
  }
  const diagnostics = result.diagnostics;
  if (diagnostics && id(diagnostics.operationId) && Number.isFinite(diagnostics.expiresAtMs)
      && ["access", "handoff"].includes(diagnostics.permission) && typeof diagnostics.allowed === "boolean"
      && ["preview", "saved", "unknown", "unsupported"].includes(diagnostics.state)) {
    out.diagnostics = { operationId: diagnostics.operationId, expiresAtMs: diagnostics.expiresAtMs,
      permission: diagnostics.permission, allowed: diagnostics.allowed, state: diagnostics.state };
  }
  const route = result.route;
  if (route && id(route.operationId) && Number.isFinite(route.expiresAtMs)
      && ["preview", "ready", "refused", "unknown"].includes(route.state)
      && ["route_absent", "route_matches", "route_conflict", "context_changed", "route_unavailable", "apply_unconfirmed"].includes(route.reason)) {
    const host = normalizeDnsName(route.host);
    const endpoint = host && route.host === host && route.agentUrl === `https://${host}:8443/v1/chat/completions`
      && Number.isInteger(route.relayPort) && route.relayPort > 0 && route.relayPort <= 65535;

    out.route = { operationId: route.operationId, expiresAtMs: route.expiresAtMs,
      state: endpoint || route.state === "refused" ? route.state : "unknown",
      reason: endpoint || route.state === "refused" ? route.reason : "route_unavailable",
      host: endpoint ? host : null, agentUrl: endpoint ? route.agentUrl : null,
      relayPort: endpoint ? route.relayPort : null, tailnetOnly: true, requestVerified: false };
  }
  return out;
}

module.exports = { parseOptionalSetupRequest, optionalSetupFailure, optionalSetupResult };
