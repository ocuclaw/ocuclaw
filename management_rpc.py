"""Scoped administration over the authenticated native control link.

Capabilities describe this adapter and verified native APIs; configuration
mutations require the explicit native transaction compatibility package.
"""
from __future__ import annotations

from typing import Any
from .memory_rpc import OPERATIONS as MEMORY_OPERATIONS, capabilities as memory_capabilities, handle_memory
from .skills_rpc import OPERATIONS as SKILLS_OPERATIONS, capabilities as skills_capabilities, handle_skills
from .health_management import OPERATIONS as HEALTH_OPERATIONS, capabilities as health_capabilities, handle_health
from .saved_rpc import OPERATIONS as SAVED_OPERATIONS, capabilities as saved_capabilities, handle_saved
from .tools_management import OPERATIONS as TOOLS_OPERATIONS, tools_capabilities, handle_tools
from .connections_management import OPERATIONS as CONNECTION_OPERATIONS, capabilities as connection_capabilities, handle_connections


def _text(value: Any, limit: int = 160) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return "".join(c for c in value.strip() if c.isprintable())[:limit]


def _learning_attention(rpc: Any, profile_id: str) -> int | None:
    """Count complete native proposal queues; unavailable is never zero."""
    try:
        from .memory_rpc import compatible as memory_compatible
        from .skills_rpc import compatible as skills_compatible
        from .management_profiles import management_profile_home
        if not memory_compatible() or not skills_compatible():
            return None
        home = management_profile_home(rpc, profile_id)
        if home is None:
            return None
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from tools import memory_decisions, skill_decisions
        token = set_hermes_home_override(home)
        try:
            # One shared transaction prevents decisions between the two reads.
            with skill_decisions.skill_transaction(allow_uncertain=True):
                counts = [memory_decisions.pending()["count"], skill_decisions.pending()["count"]]
            if any(type(count) is not int or count < 0 for count in counts):
                return None
            return sum(counts)
        finally:
            reset_hermes_home_override(token)
    except Exception:
        return None


def read_management(rpc: Any, params: Any) -> dict:
    p = params if isinstance(params, dict) else {}
    identity = {key: _text(p.get(key)) or "" for key in
                ("requestId", "operation", "scope", "profileId")}

    def fail(code: str, message: str, status: str = "error") -> dict:
        return {**identity, "status": status, "errorCode": code,
                "errorMessage": message, "capabilities": []}

    from .jobs_management import OPERATIONS as JOB_OPERATIONS
    from .automations_management import OPERATIONS as AUTOMATION_OPERATIONS
    job_operation = identity["operation"] in JOB_OPERATIONS
    from .approvals_management import OPERATIONS as APPROVAL_OPERATIONS
    approval_operation = identity["operation"] in APPROVAL_OPERATIONS
    automation_operation = identity["operation"] in AUTOMATION_OPERATIONS
    from .permissions_management import OPERATIONS as PERMISSION_OPERATIONS
    permission_operation = identity["operation"] in PERMISSION_OPERATIONS
    from .learning_management import OPERATIONS as LEARNING_OPERATIONS
    learning_operation = identity["operation"] in LEARNING_OPERATIONS
    allowed = set(identity) | ({"memory"} if identity["operation"] in MEMORY_OPERATIONS else set()) | ({"jobs"} if job_operation else set()) | ({"approvals"} if approval_operation else set())
    allowed |= {"skills"} if identity["operation"] in SKILLS_OPERATIONS else set()
    allowed |= {"automations"} if automation_operation else set()
    allowed |= {"permissions"} if permission_operation else set()
    allowed |= {"health"} if identity["operation"] in HEALTH_OPERATIONS else set()
    allowed |= {"saved"} if identity["operation"] in SAVED_OPERATIONS else set()
    allowed |= {"tools"} if identity["operation"] in TOOLS_OPERATIONS else set()
    allowed |= {"connections"} if identity["operation"] in CONNECTION_OPERATIONS else set()
    allowed |= {"learning"} if learning_operation else set()
    if set(p) - allowed or any(not identity[key] for key in identity):
        return fail("invalid_request", "A request identity and explicit profile scope are required.")
    if any(p[key] != identity[key] for key in identity):
        return fail("invalid_request", "Request identity is invalid.")
    if identity["scope"] not in ("profile", "gateway"):
        return fail("invalid_scope", "Choose profile or shared gateway scope.")
    if identity["operation"] not in ("capabilities", "overview", *MEMORY_OPERATIONS, *SKILLS_OPERATIONS, *HEALTH_OPERATIONS, *SAVED_OPERATIONS, *TOOLS_OPERATIONS, *CONNECTION_OPERATIONS) and not job_operation and not approval_operation and not automation_operation and not permission_operation and not learning_operation:
        return fail("unsupported", "This operation is not supported by the connected Hermes adapter.", "unsupported")
    if identity["operation"] == "overview" and identity["scope"] != "profile":
        return fail("invalid_scope", "Overview requires a selected profile.")
    if identity["operation"] in (*MEMORY_OPERATIONS, *SKILLS_OPERATIONS, *SAVED_OPERATIONS) and identity["scope"] != "profile":
        return fail("invalid_scope", "Memory requires a selected profile.")
    try:
        snapshot = rpc._sync_profiles_list({})
    except (ImportError, AttributeError):
        return fail("unsupported", "This Hermes installation cannot report served profiles. Update its OcuClaw integration.", "unsupported")
    except Exception:
        # Never forward native exceptions: paths, credentials or config can occur
        # in them. A failed native read is not an empty healthy installation.
        return fail("native_read_failed", "Hermes could not read its served profiles. Check the native gateway.")
    profiles = snapshot.get("profiles", [])
    profile = next((row for row in profiles if row.get("name") == identity["profileId"]), None)
    if profile is None:
        return fail("profile_not_served", "This profile is no longer served by the connected gateway. Refresh the profile list.")
    if identity["operation"] in MEMORY_OPERATIONS:
        return handle_memory(rpc, identity, p.get("memory"))
    if identity["operation"] in HEALTH_OPERATIONS:
        return handle_health(rpc, identity, p.get("health"))
    if identity["operation"] in TOOLS_OPERATIONS:
        return handle_tools(rpc, identity, p.get("tools"))
    if identity["operation"] in CONNECTION_OPERATIONS:
        return handle_connections(rpc, identity, p.get("connections"))
    if job_operation:
        from .jobs_management import handle_jobs
        return handle_jobs(identity, p.get("jobs"), rpc=rpc)
    if learning_operation:
        from .learning_management import handle_learning
        return handle_learning(rpc, identity, p.get("learning"))
    if approval_operation:
        from .approvals_management import handle_approvals
        return handle_approvals(rpc, identity, p.get("approvals"))
    if identity["operation"] in SKILLS_OPERATIONS:
        return handle_skills(rpc, identity, p.get("skills"))
    if automation_operation:
        from .automations_management import handle_automations
        return handle_automations(identity, p.get("automations"))
    if permission_operation:
        from .permissions_management import handle_permissions
        return handle_permissions(rpc, identity, p.get("permissions"))
    if identity["operation"] in SAVED_OPERATIONS:
        return handle_saved(rpc, identity, p.get("saved"))
    capabilities = [
        {"operation": "capabilities", "scope": "gateway", "supported": True, "applyTiming": "read_only"},
        {"operation": "overview", "scope": "profile", "supported": True, "applyTiming": "read_only"},
    ] + [
        {"operation": operation, "scope": "profile", "supported": False, "applyTiming": "read_only"}
        for operation in ("approvals", "learning", "jobs", "tools", "health", "activeWork", "attentionCount")
    ]
    result = {**identity, "status": "ok", "capabilities": capabilities + memory_capabilities() + skills_capabilities() + health_capabilities() + saved_capabilities()}
    result["capabilities"].extend(tools_capabilities())
    result["capabilities"].extend(connection_capabilities())
    from .jobs_management import jobs_capabilities
    result["capabilities"].extend(jobs_capabilities(identity["profileId"]))
    from .approvals_management import approvals_capabilities
    result["capabilities"].extend(approvals_capabilities())
    from .learning_management import learning_capabilities
    result["capabilities"].extend(learning_capabilities())
    from .automations_management import automations_capabilities
    result["capabilities"].extend(automations_capabilities(identity["profileId"]))
    from .permissions_management import permissions_capabilities
    result["capabilities"].extend(permissions_capabilities())
    if identity["operation"] == "overview":
        overview = {
            "profileName": _text(profile.get("displayName")) or identity["profileId"],
            # Execution of this handler proves the native gateway is responding.
            # It does not prove provider health or any process outside Hermes.
            "gatewayState": "running", "servedProfiles": len(profiles),
        }
        for key in ("model", "provider"):
            value = _text(profile.get(key))
            if value:
                overview[key] = value
        attention = _learning_attention(rpc, identity["profileId"])
        if attention is not None:
            overview.update(attentionCount=attention, attentionKind="learning_proposals")
            for capability in result["capabilities"]:
                if capability["operation"] == "attentionCount":
                    capability["supported"] = True
        result["overview"] = overview
    return result
