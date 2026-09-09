"""Authenticated native automation editor transport."""
import math
from pathlib import Path
import re
import time

from .native_compat import probe

READS = {"automations.options", "automations.read", "automations.preview", "automations.receipt"}
OPERATIONS = READS | {"automations.create", "automations.update", "automations.delete", "automations.cancel"}


def _native(profile):
    import hermes_constants
    if not probe(Path(hermes_constants.__file__).parent, ["automations-management-v1"], require_frontend=False)["supported"]:
        raise NotImplementedError()
    from cron import phone_automations
    if phone_automations.API_VERSION != 1:
        raise NotImplementedError()
    phone_automations.owner_for(profile)
    return phone_automations


def automations_capabilities(profile):
    try:
        _native(profile)
        supported = True
    except Exception:
        supported = False
    return [{"operation": op, "scope": "profile", "supported": supported,
             "applyTiming": "read_only" if op in READS else "active_now"} for op in sorted(OPERATIONS)]


def _validate(operation, payload):
    p = payload or {}
    if not isinstance(p, dict):
        raise ValueError()
    allowed = {"automations.options": set(), "automations.read": {"jobId"},
               "automations.receipt": {"operationId"},
               "automations.preview": {"jobId", "revision", "fields", "template", "templateValues"}}
    keys = allowed.get(operation, {"operationId", "producedAt", "expiresAt"} |
             ({"fields", "template", "templateValues", "reviewHash"} if operation == "automations.create" else
              {"jobId", "revision", "fields", "reviewHash"} if operation == "automations.update" else {"jobId", "revision"}))
    if set(p) - keys:
        raise ValueError()
    for key in {"jobId", "operationId", "template"} & set(p):
        if not isinstance(p[key], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", p[key]):
            raise ValueError()
    if "revision" in p and (not isinstance(p["revision"], str) or not re.fullmatch(r"[a-f0-9]{64}", p["revision"])):
        raise ValueError()
    if operation in {"automations.create", "automations.update"} and (not isinstance(p.get("reviewHash"), str) or not re.fullmatch(r"[a-f0-9]{64}", p["reviewHash"])):
        raise ValueError()
    if operation == "automations.read" and not p.get("jobId") or operation == "automations.receipt" and not p.get("operationId"):
        raise ValueError()
    for key in ("fields", "templateValues"):
        if key in p and (not isinstance(p[key], dict) or len(p[key]) > 100):
            raise ValueError()
    if operation not in READS:
        if not p.get("operationId"):
            raise ValueError()
        if operation in {"automations.update", "automations.delete"} and (not p.get("jobId") or not p.get("revision")):
            raise ValueError()
        for key in ("producedAt", "expiresAt"):
            if isinstance(p.get(key), bool) or not isinstance(p.get(key), (int, float)) or not math.isfinite(p[key]):
                raise ValueError()
        now = time.time() * 1000
        if not p["producedAt"] <= now + 1000 or not 0 < p["expiresAt"] - p["producedAt"] <= 15000 or now > p["expiresAt"]:
            raise ValueError()
    return p


def handle_automations(identity, payload):
    operation = identity["operation"]
    def fail(code, status="error"):
        messages = {"unsupported": "This gateway needs compatible native automation editing.",
                    "invalid_request": "Invalid or expired automation request. Refresh before acting.",
                    "invalid_fields": "The native scheduler rejected these fields, schedule or destination.",
                    "stale_edit": "This native job changed while you were editing. Reopen it before saving.",
                    "missing_destination": "This native delivery destination is unavailable or needs its home target configured.",
                    "invalid_context": "A context job is missing or refers to this same job. Choose existing native job IDs.",
                    "outcome_unknown": "Outcome unknown. Check the saved operation receipt before acting again.",
                    "native_read_failed": "Could not read native automation settings. Reconnect and refresh."}
        return {**identity, "status": status, "capabilities": [], "errorCode": code, "errorMessage": messages[code]}
    try:
        if identity["scope"] != "profile":
            raise ValueError()
        p = _validate(operation, payload)
    except ValueError:
        return fail("invalid_request")
    try:
        native = _native(identity["profileId"])
    except Exception:
        return fail("unsupported", "unsupported")
    try:
        profile = identity["profileId"]
        if operation == "automations.options":
            data = {"options": native.options(profile)}
        elif operation == "automations.read":
            data = {"job": native.read(profile, p["jobId"])}
        elif operation == "automations.preview":
            data = {"preview": native.preview(profile, p)}
        elif operation == "automations.receipt":
            data = {"receipt": native.receipt(profile, p["operationId"])}
        else:
            data = {"receipt": native.mutate(profile, operation, p)}
        return {**identity, "status": "ok", "capabilities": [], "automations": data}
    except ValueError as exc:
        code = str(exc) if str(exc) in {"stale_edit", "missing_destination", "invalid_context"} else "invalid_fields"
        return fail(code if operation in READS else "outcome_unknown")
    except Exception:
        return fail("native_read_failed" if operation in READS else "outcome_unknown")
