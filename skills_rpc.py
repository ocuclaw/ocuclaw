"""Complete native skill proposals and durable outcomes, never arbitrary RPC."""
from __future__ import annotations

import json
from pathlib import Path
import re

OPERATIONS = ("skills.pending", "skills.review", "skills.decide", "skills.receipt")


def compatible():
    try:
        import hermes_constants
        from .native_compat import probe
        from tools import skill_decisions
        return bool(probe(Path(hermes_constants.__file__).parent, ["skill-decisions-v1"])["supported"] and
                    skill_decisions.loaded_supported())
    except (ImportError, AttributeError, OSError, ValueError, KeyError):
        return False


def capabilities():
    supported = compatible()
    return [{"operation": operation, "scope": "profile", "supported": supported,
             "applyTiming": "active_now" if operation == "skills.decide" else "read_only"}
            for operation in OPERATIONS]


def _receipt(row):
    # Native journals retain filesystem recovery detail. Only the reviewed
    # identity and operation outcomes belong on the authenticated phone wire.
    fields = ("operationId", "proposalId", "decision", "proposalRevision", "targetRevision", "status", "alreadyResolved")
    return {**{key: row[key] for key in fields if key in row},
            "operations": [{key: operation[key] for key in ("index", "name", "action", "execution", "finalState")
                            if key in operation} for operation in row.get("operations", [])],
            "rollback": [{key: operation[key] for key in ("name", "status") if key in operation}
                         for operation in row.get("rollback", [])]}


def handle_skills(rpc, identity, arguments):
    result = {**identity, "capabilities": capabilities()}
    def fail(code, status="error"):
        return {**result, "status": status, "errorCode": code,
                "errorMessage": "Could not review native skills. Check the original receipt before another decision."}
    if not all(row["supported"] for row in result["capabilities"]):
        return fail("unsupported", "unsupported")
    from .management_profiles import management_profile_home
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return fail("profile_not_served")
    operation = identity["operation"]
    required = {"skills.pending": set(), "skills.review": {"proposalId"}, "skills.receipt": {"operationId"},
                "skills.decide": {"operationId", "proposalId", "decision", "proposalRevision", "targetRevision"}}[operation]
    p = arguments if isinstance(arguments, dict) else {}
    if set(p) != required:
        return fail("invalid_request")
    for key, value in p.items():
        pattern = r"[a-f0-9]{64}" if key.endswith("Revision") else r"[A-Za-z0-9_-]{1,128}"
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            return fail("invalid_request")
    try:
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from tools import skill_decisions as native
        token = set_hermes_home_override(home)
        try:
            if operation == "skills.pending":
                payload = native.pending()
            elif operation == "skills.review":
                payload = {"review": native.review(p["proposalId"])}
            elif operation == "skills.receipt":
                payload = {"receipt": _receipt(native.receipt(p["operationId"]))}
            else:
                payload = {"receipt": _receipt(native.decide(p["operationId"], p["proposalId"], p["decision"],
                                                             p["proposalRevision"], p["targetRevision"]))}
            if len(json.dumps(payload, ensure_ascii=False).encode()) > 524288:
                return fail("review_too_large")
            return {**result, "status": "ok", "skills": payload}
        finally:
            reset_hermes_home_override(token)
    except Exception as exc:
        code = getattr(exc, "code", "native_skills_failed")
        return fail(code if code in {"stale_review", "already_resolved", "recovery_required", "operation_conflict",
                                    "invalid_id", "invalid_decision", "invalid_proposal", "unsafe_path", "external_target"}
                    else "native_skills_failed")
