"""Read adapters for unchanged Hermes APIs; never installs native modules."""
from contextlib import contextmanager
import copy
import json

from .management_profiles import management_profile_home


@contextmanager
def profile_context(rpc, profile):
    import hermes_constants as homes
    home = management_profile_home(rpc, profile)
    if home is None:
        raise ValueError("Profile is not served")
    token = homes.set_hermes_home_override(home)
    try:
        yield home
    finally:
        homes.reset_hermes_home_override(token)


def jobs_available():
    try:
        from cron.jobs import _normalize_job_record, use_cron_store
        from cron.executions import list_executions
        from cron.scheduler_provider import resolve_cron_scheduler
        return all(callable(fn) for fn in (_normalize_job_record, use_cron_store, list_executions, resolve_cron_scheduler))
    except (ImportError, AttributeError):
        return False


def jobs_snapshot(rpc, profile, job_id=None):
    from cron import jobs, executions
    from cron.scheduler_provider import resolve_cron_scheduler
    with profile_context(rpc, profile) as home, jobs.use_cron_store(home):
        # Native list_jobs can repair and rewrite malformed stores. Inspect one
        # immutable JSON read and use its pure normalizer instead; phone reads
        # must not silently perform that repair or recover execution outcomes.
        path = home / "cron" / "jobs.json"
        raw = b'{"jobs": []}'
        if path.exists():
            with path.open("rb") as stream:
                raw = stream.read(8_000_001)
        if len(raw) > 8_000_000:
            raise ValueError("Job store exceeds supported size")
        document = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(document, dict) or not isinstance(document.get("jobs"), list) or any(not isinstance(row, dict) for row in document["jobs"]):
            raise ValueError("Native job store requires repair in Hermes")
        rows = [jobs._normalize_job_record(row) for row in document["jobs"][:100]]
        latest = executions.latest_executions([row["id"] for row in rows])
        for row in rows:
            row["latest_execution"] = latest.get(row["id"])
        history = executions.list_executions(job_id=job_id, limit=51)
        return {"provider": resolve_cron_scheduler().name, "jobs": rows[:100],
                "history": history[:50], "truncated": len(document["jobs"]) > 100 or len(history) > 50}


def tools_available():
    try:
        from hermes_cli.config import load_config_readonly
        from agent.secret_scope import build_profile_secret_scope
        return callable(load_config_readonly) and callable(build_profile_secret_scope)
    except (ImportError, AttributeError):
        return False


def tools_snapshot(rpc, profile):
    from hermes_cli import config
    from . import stock_tools
    from .tools_management import _digest, _paths, _snapshot_scoped
    with profile_context(rpc, profile), stock_tools.profile_tool_context():
        effective = copy.deepcopy(config.load_config_readonly())
        stamp = _digest(effective)
        paths = _paths(rpc._platform_name)
        # These hashes identify a read snapshot. They are not native CAS tokens.
        leaves = {path: {"managed": True, "revision": stamp, "value": None}
                  for path in (*paths.values(), "skills.disabled")}
        # Native eligibility probes may resolve auxiliary OAuth credentials.
        # A passive inventory must not rotate a grant as a side effect.
        result = _snapshot_scoped(stock_tools, rpc._platform_name, leaves, effective, False)
        if _digest(config.load_config_readonly()) != stamp:
            raise ValueError("Configuration changed while reading")
        return result
