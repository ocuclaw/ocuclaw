const { modelSiteProvider } = require("../tools/liveui-pictures/model-source.cjs");
const operations                           = {
  status: ["provider"],
  "credential.begin": ["provider", "intent", "revision"],
  "credential.save": ["transactionId", "credential"],
  "credential.remove": ["transactionId"],
  "credential.cancel": ["transactionId"],
};
const id = (value     ) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const operation = (value     ) => typeof value === "string" && Object.prototype.hasOwnProperty.call(operations, value);
const intents = ["create", "replace", "remove"];
const states = ["not_connected", "checking", "connected", "needs_reconnect", "temporarily_unavailable"];
const MODEL_SITES_RESULT_CODES = Object.freeze([
  "invalid_request", "phone_only", "unsupported", "unavailable", "not_connected", "configuration_changed",
  "transaction_expired", "transaction_invalid", "replacement_required", "busy", "invalid_token",
  "needs_reconnect", "download_unavailable", "rate_limited", "provider_unavailable", "network_policy",
  "unsupported_format", "too_large", "conversion_failed", "cancelled", "save_failed", "unattended", "outcome_unknown",
]);

function parseModelSitesRequest(value     )      {
  if (!value || typeof value !== "object" || Array.isArray(value) || !id(value.requestId)
      || !operation(value.operation)) return null;
  const fields = operations[value.operation];
  if (Object.keys(value).some(key => !["type", "requestId", "operation", ...fields].includes(key))
      || (value.type !== undefined && value.type !== "ocuclaw.model_sites.request")) return null;
  if (value.operation === "credential.begin"
      && (!modelSiteProvider(value.provider) || !intents.includes(value.intent) || !id(value.revision))) return null;
  if (value.operation === "status" && value.provider !== undefined && !modelSiteProvider(value.provider)) return null;
  if (value.operation.startsWith("credential.") && value.operation !== "credential.begin" && !id(value.transactionId)) return null;
  if (value.operation === "credential.save"
      && (typeof value.credential !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(value.credential))) return null;
  return Object.fromEntries(["requestId", "operation", ...fields].map(key => [key, value[key]]));
}

function modelSitesFailure(request     , code = "unavailable", status = "rejected")      {
  return { requestId: id(request?.requestId) ? request.requestId : "",
    operation: operation(request?.operation) ? request.operation : "status",
    status, code };
}

function boundedText(value     , limit        )                {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return text ? text.slice(0, limit) : null;
}

function modelSitesResult(request     , result     )      {
  const statuses = ["ok", "saved", "removed", "cancelled", "rejected", "unsupported", "outcome_unknown"];
  if (!result || !statuses.includes(result.status)) return modelSitesFailure(request, "unavailable", "outcome_unknown");
  const out      = { requestId: request.requestId, operation: request.operation, status: result.status };
  if (MODEL_SITES_RESULT_CODES.includes(result.code)) out.code = result.code;
  const snapshot = result.snapshot;
  if (modelSiteProvider(snapshot?.provider) && states.includes(snapshot.state) && id(snapshot.revision)) {
    out.snapshot = { provider: snapshot.provider, state: snapshot.state, revision: snapshot.revision };
    if (MODEL_SITES_RESULT_CODES.includes(snapshot.code)) out.snapshot.code = snapshot.code;
    const account = snapshot.account;
    const name = boundedText(account?.name, 128);
    if (typeof account?.id === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(account.id) && name) {
      out.snapshot.account = { id: account.id, name };

      if (typeof account.url === "string" && /^https:\/\/sketchfab\.com\/[A-Za-z0-9_.-]{1,128}$/.test(account.url)) {
        out.snapshot.account.url = account.url;
      }
    }
  }
  const transaction = result.transaction;
  if (id(transaction?.id) && Number.isFinite(transaction.expiresAtMs) && transaction.expiresAtMs > 0
      && intents.includes(transaction.intent)) {
    out.transaction = { id: transaction.id, expiresAtMs: transaction.expiresAtMs, provider: modelSiteProvider(transaction.provider) ? transaction.provider : "sketchfab", intent: transaction.intent };
  }
  return out;
}

async function handleModelSitesRequest(service     , request     , connectionId        )               {
  if (!service) return modelSitesFailure(request, "unsupported", "unsupported");
  try {
    let result     ;
    switch (request.operation) {
      case "status": return modelSitesResult(request, { status: "ok", snapshot: await service.status(request.provider) });
      case "credential.begin": result = await service.begin(connectionId, request.intent, request.revision, request.provider); break;
      case "credential.save": result = await service.save(connectionId, request.transactionId, request.credential); break;
      case "credential.remove": result = await service.remove(connectionId, request.transactionId); break;
      case "credential.cancel": result = await service.cancel(connectionId, request.transactionId); break;
      default: return modelSitesFailure(request, "invalid_request");
    }
    const status = result?.status === "ok"
      ? ({ "credential.save": "saved", "credential.remove": "removed", "credential.cancel": "cancelled" }       )[request.operation] || "ok"
      : result?.code === "outcome_unknown" ? "outcome_unknown" : "rejected";
    return modelSitesResult(request, { ...result, status });
  } catch (_) {
    return modelSitesFailure(request, "unavailable", "outcome_unknown");
  }
}

module.exports = { MODEL_SITES_RESULT_CODES, parseModelSitesRequest, modelSitesFailure, modelSitesResult, handleModelSitesRequest };
