"""Curated native scheduler RPC; no prompt, output, exception or credential dump."""
import math
from pathlib import Path
import re
import time

from .native_compat import probe

OPERATIONS = {"jobs.list", "jobs.history", "jobs.receipt", "jobs.pause", "jobs.resume", "jobs.run", "jobs.cancel"}
READS = {"jobs.list", "jobs.history", "jobs.receipt"}


def _native(profile):
    import hermes_constants
    if not probe(Path(hermes_constants.__file__).parent, ["jobs-management-v1"], require_frontend=False)["supported"]:
        raise NotImplementedError()
    from cron import phone_management
    if phone_management.API_VERSION != 1:
        raise NotImplementedError()
    phone_management.owner_for(profile)
    return phone_management


def jobs_capabilities(profile):
    try:
        _native(profile)
        supported = True
    except Exception:
        supported = False
    from .stock_management import jobs_available
    reads_supported = supported or jobs_available()
    return [{"operation": op, "scope": "profile", "supported": supported or (op in {"jobs.list", "jobs.history"} and reads_supported),
             "applyTiming": "read_only" if op in READS else "active_now"} for op in sorted(OPERATIONS)]


def _text(value, limit=160):
    return "".join(c for c in str(value or "") if c.isprintable())[:limit]


def _execution(row):
    if not isinstance(row, dict):
        return None
    return {"id": _text(row.get("id")), "jobId": _text(row.get("job_id")),
            "status": row.get("status") if row.get("status") in {"claimed", "running", "completed", "failed", "unknown"} else "unknown",
            "delivery": row.get("delivery_outcome") if row.get("delivery_outcome") in
                {"failed", "delivered", "not_configured", "suppressed", "suppressed_acked"} else "unknown",
            "startedAt": _text(row.get("started_at") or row.get("claimed_at")),
            "finishedAt": _text(row.get("finished_at"))}


def _job(row):
    schedule = row.get("schedule") or {}
    return {"id": _text(row.get("id")), "name": _text(row.get("name") or row.get("id")),
            "state": _text(row.get("state")), "paused": not row.get("enabled", True) or row.get("state") == "paused",
            "schedule": _text(schedule.get("display") or schedule.get("expr") or schedule.get("run_at") or schedule.get("kind")),
            "nextRunAt": _text(row.get("next_run_at")),
            "lastExecution": _execution(row.get("latest_execution"))}


def _receipt(row):
    return {"operationId": _text(row.get("operationId")), "jobId": _text(row.get("jobId")),
            "state": row.get("state") if row.get("state") in
                {"not_found", "cancelled", "reserved", "rejected", "applied", "admitted", "unknown"} else "unknown",
            "executionId": _text(row.get("executionId")), "execution": _execution(row.get("execution")),
            "jobPresence": row.get("jobPresence", "unknown"),
            "job": _job(row["job"]) if row.get("job") else None}


def _validate(operation, payload):
    p = payload or {}
    if not isinstance(p, dict):
        raise ValueError()
    allowed = ({"jobId"} if operation == "jobs.history" else {"operationId"} if operation == "jobs.receipt" else
               set() if operation == "jobs.list" else {"operationId", "jobId", "producedAt", "expiresAt", "resumeAndRun"})
    if set(p) - allowed:
        raise ValueError()
    for key in ("jobId", "operationId"):
        if key in p and (not isinstance(p[key], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", p[key])):
            raise ValueError()
    if operation == "jobs.receipt" and not p.get("operationId"):
        raise ValueError()
    if operation not in READS:
        if not p.get("jobId") or not p.get("operationId"):
            raise ValueError()
        for key in ("producedAt", "expiresAt"):
            if isinstance(p.get(key), bool) or not isinstance(p.get(key), (int, float)) or not math.isfinite(p[key]):
                raise ValueError()
        now = time.time() * 1000
        if not p["producedAt"] <= now + 1000 or not 0 < p["expiresAt"] - p["producedAt"] <= 15000 or now > p["expiresAt"]:
            raise ValueError()
        if "resumeAndRun" in p and (operation != "jobs.run" or not isinstance(p["resumeAndRun"], bool)):
            raise ValueError()
    return p


def handle_jobs(identity, payload, *, rpc=None):
    operation = identity["operation"]
    def fail(code, status="error"):
        return {**identity, "status": status, "capabilities": [], "errorCode": code,
                "errorMessage": {"unsupported": "This scheduler action is unavailable in this Hermes integration. Job history remains read only.",
                    "invalid_request": "Invalid or expired job request. Refresh before acting.",
                    "outcome_unknown": "Outcome unknown. Check this operation receipt; do not run it again.",
                    "native_read_failed": "Could not read native jobs. Reconnect and refresh."}[code]}
    try:
        if identity["scope"] != "profile":
            raise ValueError()
        p = _validate(operation, payload)
    except ValueError:
        return fail("invalid_request")
    try:
        native = _native(identity["profileId"])
    except Exception:
        if rpc is None or operation not in {"jobs.list", "jobs.history"}:
            return fail("unsupported", "unsupported")
        native = None
    try:
        if operation in {"jobs.list", "jobs.history"}:
            if native is None:
                from .stock_management import jobs_snapshot
                snapshot = jobs_snapshot(rpc, identity["profileId"], p.get("jobId"))
            else:
                snapshot = native.snapshot(identity["profileId"], p.get("jobId"))
            data = {"provider": _text(snapshot["provider"]), "jobs": [_job(row) for row in snapshot["jobs"]],
                    "history": [_execution(row) for row in snapshot["history"]], "truncated": snapshot["truncated"]}
        elif operation == "jobs.receipt":
            data = {"receipt": _receipt(native.receipt(identity["profileId"], p["operationId"]))}
        else:
            data = {"receipt": _receipt(native.mutate(identity["profileId"], operation, p))}
        return {**identity, "status": "ok", "capabilities": [], "jobs": data}
    except Exception:
        return fail("native_read_failed" if operation in READS else "outcome_unknown")
