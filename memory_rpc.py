"""Curated native memory decisions on the authenticated management connection."""
from __future__ import annotations

import json
from pathlib import Path
import re

OPERATIONS = ("memory.pending", "memory.review", "memory.decide", "memory.receipt")


def compatible():
    try:
        import fcntl  # This native compatibility package requires real process locks.
        import hermes_constants
        from .native_compat import probe
        return bool(probe(Path(hermes_constants.__file__).parent, ["memory-decisions-v1"])["supported"])
    except (ImportError, AttributeError, OSError, ValueError, KeyError):
        return False


def capabilities():
    supported = compatible()
    return [{"operation": operation, "scope": "profile", "supported": supported,
             "applyTiming": "active_now" if operation == "memory.decide" else "read_only"}
            for operation in OPERATIONS]


def handle_memory(rpc, identity, arguments):
    result = {**identity, "capabilities": capabilities()}

    def fail(code, status="error"):
        messages = {
            "unsupported": "Memory decisions are unavailable in this Hermes integration.",
            "stale_review": "The proposal or target changed. Open it again and review the current content.",
            "already_resolved": "This proposal is already resolved. Refresh Pending.",
            "validation_failed": "This proposal cannot apply to the current memory. Check capacity and operation validity in native Hermes.",
            "recovery_required": "A native decision has an uncertain outcome. Check its durable receipt before making another decision.",
            "operation_conflict": "This operation ID belongs to another decision. No new change was applied.",
        }
        return {**result, "status": status, "errorCode": code,
                "errorMessage": messages.get(code, "Could not read or decide native memory. Pending work has not been silently retried.")}

    if not all(row["supported"] for row in result["capabilities"]):
        return fail("unsupported", "unsupported")
    from .management_profiles import management_profile_home
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return fail("profile_not_served")
    p = arguments if isinstance(arguments, dict) else {}
    operation = identity["operation"]
    required = {
        "memory.pending": set(), "memory.review": {"proposalId"},
        "memory.receipt": {"operationId"},
        "memory.decide": {"operationId", "proposalId", "decision", "proposalRevision", "targetRevision"},
    }[operation]
    if set(p) != required:
        return fail("invalid_request")
    for key, value in p.items():
        pattern = r"[a-f0-9]{64}" if key.endswith("Revision") else r"[A-Za-z0-9_-]{1,128}"
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            return fail("invalid_request")
    try:
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from tools import memory_decisions as native
        token = set_hermes_home_override(home)
        try:
            if operation == "memory.pending":
                payload = native.pending()
            elif operation == "memory.review":
                payload = {"review": native.review(p["proposalId"])}
            elif operation == "memory.receipt":
                payload = {"receipt": native.receipt(p["operationId"])}
            else:
                payload = {"receipt": native.decide(p["operationId"], p["proposalId"], p["decision"],
                                                    p["proposalRevision"], p["targetRevision"])}
            # Refuse oversized full reviews rather than silently truncate evidence.
            if len(json.dumps(payload, ensure_ascii=False).encode()) > 524288:
                return fail("review_too_large")
            return {**result, "status": "ok", "memory": payload}
        finally:
            reset_hermes_home_override(token)
    except Exception as exc:
        code = getattr(exc, "code", "native_memory_failed")
        if code not in {"stale_review", "already_resolved", "validation_failed", "recovery_required",
                        "operation_conflict", "invalid_id", "invalid_decision", "invalid_proposal", "unsafe_path"}:
            code = "native_memory_failed"
        return fail(code)
