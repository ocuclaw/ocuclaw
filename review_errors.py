"""Review-only safe failure contract. No provider body, URL or message crosses it."""
from datetime import timezone
from email.utils import parsedate_to_datetime
import math
import re
import time

_TRANSIENT = {"rate_limited", "overloaded", "local_busy"}
_MAX_DATE_MS = 8_640_000_000_000_000


def _retry_at(value, now_ms, milliseconds=False):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        if isinstance(value, str) and not re.fullmatch(r"\d+(?:\.\d+)?", value.strip()):
            raise ValueError("not delta seconds")
        delay = float(value) * (1 if milliseconds else 1000)
        if delay < 0 or not math.isfinite(delay):
            return None
        at = now_ms + delay
    except (ValueError, TypeError):
        if not isinstance(value, str):
            return None
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                return None
            at = date.astimezone(timezone.utc).timestamp() * 1000
        except (ValueError, TypeError, OverflowError):
            return None
    return max(now_ms, math.ceil(at)) if math.isfinite(at) and 0 <= at <= _MAX_DATE_MS else None


def review_failure(exc, *, now_ms=None, _depth=0):
    now_ms = round(time.time() * 1000) if now_ms is None else now_ms
    response = getattr(exc, "response", None)
    body = getattr(exc, "body", None)
    body = body if isinstance(body, dict) else {}
    nested = body.get("error") if isinstance(body.get("error"), dict) else {}
    code = str(getattr(exc, "code", None) or nested.get("code") or nested.get("type") or body.get("code") or "").lower()
    status = getattr(exc, "status_code", None) or getattr(response, "status_code", None)
    name = type(exc).__name__
    kind, origin = "unknown", "unknown"
    if code in {"model_cancelled", "cancelled", "abort_err"}:
        kind = "cancelled"
    elif code in {"insufficient_quota", "quota_exhausted", "billing_hard_limit_reached", "provider_quota_exhausted"} or status == 402:
        kind = "quota_exhausted"
    elif code in {"lab_proxy_busy", "review_busy", "link_overloaded"}:
        kind, origin = "local_busy", "lab" if code == "lab_proxy_busy" else "relay"
    elif code == "lab_budget_exhausted":
        kind, origin = "lab_budget_exhausted", "lab"
    elif code in {"invalid_api_key", "authentication_error", "permission_denied", "auth_required"} or status in {401, 403} or name in {"AuthenticationError", "PermissionError", "PluginLlmTrustError"}:
        kind = "auth_required"
    elif code in {"server_overloaded", "overloaded_error", "overloaded", "provider_overloaded"} or status in {503, 529} or "our servers are currently overloaded." in str(exc).lower():
        kind = "overloaded"
    elif code in {"rate_limit_exceeded", "rate_limited", "rate_limit_error", "provider_rate_limited"} or status == 429 or name == "RateLimitError":
        kind = "rate_limited"
    elif code in {"timeout", "model_timeout", "link_request_timeout", "llm_completion_timeout"} or name in {"TimeoutError", "APITimeoutError"}:
        kind = "timeout"
    if code == "native_rate_limited":
        kind, origin = "rate_limited", "native"
    if code in {"provider_rate_limited", "provider_overloaded"}:
        origin = "provider"
    cause = getattr(exc, "__cause__", None)
    if kind == "unknown" and cause is not None and _depth < 4:
        return review_failure(cause, now_ms=now_ms, _depth=_depth + 1)
    result = {"kind": kind, "origin": origin, "retryable": kind in _TRANSIENT}
    headers = getattr(response, "headers", None) or getattr(exc, "headers", None) or {}
    get_header = getattr(headers, "get", None)
    header = get_header("retry-after") if callable(get_header) else None
    if header is None and callable(get_header):
        header = get_header("Retry-After")
    at = _retry_at(header if header is not None else getattr(exc, "retry_after", None), now_ms)
    if at is None:
        at = _retry_at(getattr(exc, "retry_after_ms", None), now_ms, milliseconds=True)
    if kind in _TRANSIENT and at is not None:
        result["retryAtMs"] = at
    return result
