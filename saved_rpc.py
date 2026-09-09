"""Authenticated, profile-scoped saved learning with native exact compatibility."""
from __future__ import annotations

import json
import inspect
from pathlib import Path
import re

OPERATIONS = ("saved.list", "saved.read", "saved.preview", "saved.mutate", "saved.receipt", "saved.recover")


def compatible():
    try:
        import hermes_constants
        from .native_compat import probe
        from tools import saved_learning
        return bool(probe(Path(hermes_constants.__file__).parent, ["saved-native-v1"])["supported"]
                    and saved_learning.loaded_supported()
                    and all("expires_at_ms" in inspect.signature(getattr(saved_learning, name)).parameters
                            for name in ("mutate", "recover")))
    except (ImportError, AttributeError, OSError, ValueError, KeyError):
        return False


def capabilities():
    supported = compatible()
    return [{"operation": operation, "scope": "profile", "supported": supported,
             "applyTiming": "future_chat" if operation == "saved.mutate" else "active_now" if operation == "saved.recover" else "read_only"}
            for operation in OPERATIONS]


def _receipt(row):
    fields = ("operationId", "entryId", "action", "previewRevision", "status", "cancelledBeforeAdmission", "validationRejected")
    return {key: row[key] for key in fields if key in row}


def handle_saved(rpc, identity, arguments):
    result = {**identity, "capabilities": capabilities()}
    def fail(code, status="error"):
        return {**result, "status": status, "errorCode": code,
                "errorMessage": "Could not change saved learning. Check the original receipt before another change."}
    if not all(row["supported"] for row in result["capabilities"]):
        return fail("unsupported", "unsupported")
    from .management_profiles import management_profile_home
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return fail("profile_not_served")
    operation = identity["operation"]
    required = {"saved.list": set(), "saved.read": {"entryId"}, "saved.receipt": {"operationId"}, "saved.recover": {"operationId", "producedAtMs", "expiresAtMs"},
                "saved.preview": {"entryId", "action", "content"},
                "saved.mutate": {"operationId", "entryId", "action", "content", "previewRevision", "producedAtMs", "expiresAtMs"}}[operation]
    p = arguments if isinstance(arguments, dict) else {}
    if set(p) != required:
        return fail("invalid_request")
    for key, value in p.items():
        if key in ("producedAtMs", "expiresAtMs"):
            if type(value) is not int or not 0 <= value <= 9007199254740991:
                return fail("invalid_request")
            continue
        if not isinstance(value, str):
            return fail("invalid_request")
        if key == "content":
            if len(value.encode("utf-8")) > 262144 or "\x00" in value:
                return fail("invalid_request")
        elif key == "action":
            if value not in ("edit", "remove"):
                return fail("invalid_request")
        elif not re.fullmatch(r"[a-f0-9]{64}" if key in ("entryId", "previewRevision") else r"[A-Za-z0-9_-]{1,128}", value):
            return fail("invalid_request")
    if p.get("action") == "remove" and p.get("content"):
        return fail("invalid_request")
    try:
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from tools import saved_learning as native
        token = set_hermes_home_override(home)
        try:
            if operation == "saved.list":
                payload = native.listing()
            elif operation == "saved.read":
                payload = {"entry": native.read(p["entryId"])}
            elif operation == "saved.preview":
                payload = {"preview": native.preview(p["entryId"], p["action"], p["content"])}
            elif operation == "saved.receipt":
                payload = {"receipt": _receipt(native.receipt(p["operationId"]))}
            elif operation == "saved.recover":
                payload = {"receipt": _receipt(native.recover(p["operationId"], produced_at_ms=p["producedAtMs"], expires_at_ms=p["expiresAtMs"]))}
            else:
                payload = {"receipt": _receipt(native.mutate(p["operationId"], p["entryId"], p["action"],
                                                           p["content"], p["previewRevision"], produced_at_ms=p["producedAtMs"], expires_at_ms=p["expiresAtMs"]))}
            if len(json.dumps(payload, ensure_ascii=False).encode()) > 524288:
                return fail("review_too_large")
            return {**result, "status": "ok", "saved": payload}
        finally:
            reset_hermes_home_override(token)
    except Exception as exc:
        code = getattr(exc, "code", "native_saved_failed")
        return fail(code if code in {"stale_review", "recovery_required", "operation_conflict", "validation_failed",
                                    "invalid_id", "invalid_request", "unsafe_path", "intent_expired"} else "native_saved_failed")
