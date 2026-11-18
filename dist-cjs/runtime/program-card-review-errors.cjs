const KINDS = new Set(["rate_limited", "overloaded", "auth_required", "quota_exhausted", "timeout", "cancelled", "local_busy", "lab_budget_exhausted", "unknown"]);
const ORIGINS = new Set(["provider", "native", "relay", "lab", "unknown"]);
const TRANSIENT = new Set(["rate_limited", "overloaded", "local_busy"]);
const MAX_DATE_MS = 8_640_000_000_000_000;

function cleanReviewFailure(raw     ) {
  if (!raw || !KINDS.has(raw.kind)) return null;
  return { kind: raw.kind, origin: ORIGINS.has(raw.origin) ? raw.origin : "unknown",
    retryable: TRANSIENT.has(raw.kind),
    ...(TRANSIENT.has(raw.kind) && typeof raw.retryAtMs === "number" && Number.isSafeInteger(raw.retryAtMs) && raw.retryAtMs >= 0 && raw.retryAtMs <= MAX_DATE_MS
      ? { retryAtMs: raw.retryAtMs } : {}) };
}

function reviewRetryAt(value     , nowMs        , milliseconds = false) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const numeric = typeof value === "number" || /^\d+(?:\.\d+)?$/.test(value.trim());
  const delay = numeric ? Number(value) * (milliseconds ? 1 : 1000) : NaN;
  const at = numeric ? nowMs + delay : typeof value === "string" && /^[A-Za-z]{3}, /.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at >= 0 && at <= MAX_DATE_MS && (!numeric || delay >= 0)
    ? Math.max(nowMs, Math.ceil(at)) : undefined;
}

function normalizeReviewFailure(error     , nowMs = Date.now(), depth = 0) {
  const normalized = cleanReviewFailure(error?.failure);
  if (normalized) return normalized;
  const body = error?.body || error?.response?.data || {};
  const code = String(error?.code || body?.error?.code || body?.error?.type || body?.code || "").toLowerCase();
  const status = error?.status_code ?? error?.status ?? error?.response?.status;
  const name = error?.name || "";
  const message = typeof error?.message === "string" ? error.message : "";
  let kind = "unknown", origin = "unknown";
  if (["model_cancelled", "cancelled", "abort_err", "llm_completion_aborted"].includes(code) || name === "AbortError") kind = "cancelled";
  else if (["insufficient_quota", "quota_exhausted", "billing_hard_limit_reached", "provider_quota_exhausted"].includes(code) || status === 402) kind = "quota_exhausted";
  else if (["lab_proxy_busy", "review_busy", "link_overloaded"].includes(code)) {
    kind = "local_busy"; origin = code === "lab_proxy_busy" ? "lab" : "relay";
  } else if (code === "lab_budget_exhausted") { kind = "lab_budget_exhausted"; origin = "lab"; }
  else if (["invalid_api_key", "authentication_error", "permission_denied", "auth_required", "llm_completion_not_authorized"].includes(code) || [401, 403].includes(status) || ["AuthenticationError", "PermissionError", "PluginLlmTrustError"].includes(name)) kind = "auth_required";
  else if (["server_overloaded", "overloaded_error", "overloaded", "provider_overloaded"].includes(code) || [503, 529].includes(status)
    || /Our servers are currently overloaded\./i.test(message)) kind = "overloaded";
  else if (["rate_limit_exceeded", "rate_limited", "rate_limit_error", "provider_rate_limited"].includes(code) || status === 429 || name === "RateLimitError") kind = "rate_limited";
  else if (["timeout", "model_timeout", "link_request_timeout", "llm_completion_timeout"].includes(code) || ["TimeoutError", "APITimeoutError"].includes(name)) kind = "timeout";
  if (code === "native_rate_limited") { kind = "rate_limited"; origin = "native"; }
  if (["provider_rate_limited", "provider_overloaded"].includes(code)) origin = "provider";
  if (kind === "unknown" && error?.cause && depth < 4) return normalizeReviewFailure(error.cause, nowMs, depth + 1);
  const headers = error?.response?.headers || error?.headers;
  const header = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"] ?? headers?.["Retry-After"];
  const retryAtMs = reviewRetryAt(header ?? error?.retry_after, nowMs)
    ?? reviewRetryAt(error?.retry_after_ms, nowMs, true);
  return { kind, origin, retryable: TRANSIENT.has(kind), ...(TRANSIENT.has(kind) && retryAtMs !== undefined ? { retryAtMs } : {}) };
}

module.exports = { cleanReviewFailure, reviewRetryAt, normalizeReviewFailure };
