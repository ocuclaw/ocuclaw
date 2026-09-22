"""Per-section facts for the phone's Hermes hub, read once with the overview (#3069).

The hub states each section's live state in one line ("Smart · asks when unsure", "2 jobs ·
next today 8:00"), and the management lane refuses a second in-flight read, so those facts
ride the overview read the hub already makes rather than five reads of their own.

Every field is gated by its own capability and omitted when its native read fails or reports
nothing. An absent field means that row simply has no second line, which is honest; a zero or
a placeholder would be a fact the wearer acts on. Only numbers and one enum cross here - never
a name, path, command or job text. Each section is read through the same module that section's
page reads, so a hub row and its page cannot disagree.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from time import monotonic
from typing import Any

logger = logging.getLogger(__name__)

APPROVAL_MODES = ("smart", "manual", "off")
# Both job readers - the native one and the stock fallback - hand back at most this many jobs.
JOB_LIST_CAP = 100
# The phone carries these as JavaScript numbers; past this they are no longer the count sent.
MAX_WIRE_INTEGER = 9007199254740991


def _count(value: Any) -> int | None:
    """A non-negative whole number the wire can carry, or None. A bool is not a count."""
    if type(value) is not int or not 0 <= value <= MAX_WIRE_INTEGER:
        return None
    return value


def _dig(value: Any, *keys: str) -> Any:
    """Walk a curated section result. A missing or reshaped step reads as nothing, not a crash."""
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _read(handler: Any, *args: Any, **kwargs: Any) -> Any:
    """One section read. A failed or unsupported section is not a fact about that section."""
    result = handler(*args, **kwargs)
    return result if isinstance(result, dict) and result.get("status") == "ok" else None


def _epoch_ms(value: Any) -> int | None:
    """Hermes reports a job's next run as an ISO-8601 instant; without an offset it names no instant."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None:
        return None
    try:
        return _count(int(moment.timestamp() * 1000))
    except (OverflowError, OSError, ValueError):
        return None


def _approvals(rpc: Any, identity: dict) -> dict:
    """The mode the Approvals page shows, in that page's own three words."""
    from .approvals_management import handle_approvals
    result = _read(handle_approvals, rpc, {**identity, "operation": "approvals.read"}, None)
    mode = _dig(result, "approvals", "fields", "mode", "effectiveValue")
    return {"approvalsMode": mode if mode in APPROVAL_MODES else None}


def _tools(rpc: Any, identity: dict) -> dict:
    """Toolsets the agent can actually use, and skills left enabled.

    A toolset counts when its state is `allowed_by_setting`: enabled AND usable. Merely "not
    blocked" would count a toolset whose tools are unavailable on this host, and the hub would
    say the agent has something it does not.
    """
    from .tools_management import handle_tools
    snapshot = _dig(_read(handle_tools, rpc, {**identity, "operation": "tools.read"}, None), "tools")
    groups, skills = _dig(snapshot, "tools"), _dig(snapshot, "installedSkills")
    toolsets = None
    if isinstance(groups, list):
        states = [_dig(row, "state") for row in groups]
        # A host that did not check availability reports `not_checked`, and "usable" is then
        # not a thing this read knows. Count nothing rather than count a guess.
        if all(state != "not_checked" for state in states):
            toolsets = _count(states.count("allowed_by_setting"))
    return {
        "toolsets": toolsets,
        "skills": _count(sum(1 for row in skills if _dig(row, "enabled"))) if isinstance(skills, list) else None,
    }


def _needs_auth(rpc: Any, identity: dict, rows: list) -> int | None:
    """How many OAuth connections have no token on disk. A floor, not a total.

    A connection is waiting on the wearer when it is configured for OAuth, this phone could
    actually run that flow for it, and no token file exists - the same three things the plugin
    already weighs before it reports `oauth_required` on a connection test. Two reasons the
    real number can be higher: a token that is present but expired looks signed in until
    something tries to refresh it, and the native token check answers "present" when it cannot
    tell, deliberately, so that a doubtful read never blocks a working connection.

    Requiring OAuth is also what keeps the token lookup honest: token files are named by
    `_safe_filename`, which folds every non-word character to `_`, so `my server` and
    `my_server` share one file - and because only OAuth-configured connections are looked up,
    such a collision can only ever mistake one OAuth connection for another, never read a
    plain neighbour's file, and it only lowers the count, which is the direction the floor
    already allows.
    """
    if not any(_dig(row, "oauthSupported") for row in rows):
        return 0
    from .connections_management import _native
    from .management_profiles import management_profile_home
    from hermes_cli.mcp_config import _oauth_tokens_present
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return None
    tx, native = _native()[:2]
    waiting = 0
    with native.profile_context(home):
        with tx.config_transaction():
            servers = native.capture()[1].get("mcp_servers") or {}
        if not isinstance(servers, dict):
            return None
        for row in rows:
            name = _dig(row, "name")
            server = servers.get(name) if isinstance(name, str) else None
            # `oauthSupported` alone would also count a plain HTTP connection that uses no
            # auth at all: it could run the flow, but it is not waiting for anyone.
            if not _dig(row, "oauthSupported") or not isinstance(server, dict) or server.get("auth") != "oauth":
                continue
            if not _oauth_tokens_present(name):
                waiting += 1
    return _count(waiting)


def _connections(rpc: Any, identity: dict) -> dict:
    """Configured MCP connections, and how many of them are waiting to be signed in again."""
    from .connections_management import handle_connections
    rows = _dig(_read(handle_connections, rpc, {**identity, "operation": "connections.read"}, None),
                "connections", "snapshot", "mcp")
    if not isinstance(rows, list):
        return {"mcp": None, "mcpNeedsAuth": None}
    try:
        waiting = _needs_auth(rpc, identity, rows)
    except Exception:
        # The count of connections is still a fact even when their sign-in state is not.
        waiting = None
    return {"mcp": _count(len(rows)), "mcpNeedsAuth": waiting}


def _jobs(rpc: Any, identity: dict) -> dict:
    """How many jobs, and when the soonest unpaused one runs next."""
    from .jobs_management import handle_jobs
    data = _dig(_read(handle_jobs, {**identity, "operation": "jobs.list"}, None, rpc=rpc), "jobs")
    rows = _dig(data, "jobs")
    # Both job readers cap the list at 100. At the cap the count is a floor, not a count, and
    # the soonest run may be off the end, so neither is reported. The read's own `truncated`
    # flag is NOT the test: the native reader raises it for the job-list cap alone, but the
    # stock fallback ORs in a history capped at 50, which says nothing about how many jobs
    # there are - measured on a seeded profile, where it blanked a complete 20-job list
    # because the ledger held more than 50 runs. One rule covers both readers.
    if not isinstance(rows, list) or len(rows) >= JOB_LIST_CAP:
        return {}
    runs = [_epoch_ms(_dig(row, "nextRunAt")) for row in rows if not _dig(row, "paused")]
    # Hermes parks a past next_run_at on a job it is retrying. A moment that has already gone
    # by is not a next run, so it is dropped here rather than after the minimum - dropping it
    # afterwards would let one stuck job hide every real future run behind it.
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    return {"jobs": _count(len(rows)),
            "nextJobAtMs": min([run for run in runs if run is not None and run >= now], default=None)}


def _learning(rpc: Any, identity: dict) -> dict:
    """"Reviews on" - whether Hermes asks before it writes what it learned.

    The Learning row reads "Reviews on · N saved" and sits beside the proposals card, so it
    means the two write-review gates (Review memory writes, Review skill writes): proposals
    exist because those are on. Automatic background review is a different thing and is not
    what this says. On when either gate is on, off only when both are off, absent when the
    pair could not be read.
    """
    from .learning_management import _capture, _native
    from .management_profiles import management_profile_home
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return {}
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
    # The cheap half of the Learning read: the same captured fields the page renders, without
    # its provider catalog and route resolution, which say nothing about these two switches.
    native = _native()
    token = set_hermes_home_override(home)
    secret_token = None
    try:
        secret_token = set_secret_scope(build_profile_secret_scope(home))
        fields = _dig(_capture(*native), "fields")
    finally:
        if secret_token is not None:
            reset_secret_scope(secret_token)
        reset_hermes_home_override(token)
    gates = [_dig(fields, name, "effectiveValue") for name in ("memoryApproval", "skillApproval")]
    if any(state not in ("on", "off") for state in gates):
        return {"reviewsOn": None}
    return {"reviewsOn": "on" in gates}


def _saved(rpc: Any, identity: dict) -> dict:
    """Saved learning entries, the same listing the Learning page counts.

    Straight to the native listing rather than through the section handler, which serialises
    every record to check a size limit the page needs and a count does not. There is no
    listing-free count in Hermes 0.21.x: the memory and user-profile totals do come cheap in
    `targets`, but saved skills are only countable by walking them, and leaving skills out
    would make this row disagree with the page it summarises. The walk is therefore what this
    costs, which is why it is the last reader to run and the first the budget drops.
    """
    from .management_profiles import management_profile_home
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return {}
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import saved_learning
    token = set_hermes_home_override(home)
    try:
        rows = saved_learning.listing().get("records")
    finally:
        reset_hermes_home_override(token)
    return {"savedEntries": _count(len(rows)) if isinstance(rows, list) else None}


def _health(rpc: Any, identity: dict) -> dict:
    """Free bytes where this profile lives, and failed job runs in the last seven days."""
    from .health_management import snapshot
    from .management_profiles import management_profile_home
    home = management_profile_home(rpc, identity["profileId"])
    if home is None:
        return {}
    row = snapshot(home)
    # Both are None when their ledger or filesystem could not be read: omit, never send zero.
    return {"failedJobs7d": _count(_dig(row, "jobFailures")), "diskFreeBytes": _count(_dig(row, "diskFree"))}


# Each fact is gated by the capability of the read that produces it, cheapest reader first.
# The tab waits on this read, so when the budget below runs out the remaining readers are not
# called at all and their fields are simply absent - which is what an unreadable field already
# means. Ordering therefore decides which facts survive a slow host, so keep it honest:
# a stat and one small bounded COUNT first, config reads next, directory walks last. The
# health COUNT's date predicate is not indexed - it is cheap because the execution ledger
# is capped at 1000 terminal rows, not because SQLite can seek it.
READERS = (
    ("health.snapshot", _health),
    ("approvals.read", _approvals),
    ("learning.read", _learning),
    ("jobs.list", _jobs),
    ("connections.read", _connections),
    ("tools.read", _tools),
    ("saved.list", _saved),
)

# Wall-clock ceiling for the whole summary. The hub would rather open now with four rows
# stating a fact than open late with seven.
BUDGET_MS = 1500


def overview_summary(rpc: Any, identity: dict, capabilities: list, budget_ms: int = BUDGET_MS) -> dict:
    """The facts this Hermes can honestly state about each section, for the hub's one read."""
    supported = {row.get("operation") for row in capabilities
                 if isinstance(row, dict) and row.get("supported")}
    summary: dict = {}
    deadline = monotonic() + max(0, budget_ms) / 1000
    for operation, reader in READERS:
        if operation not in supported:
            continue
        if monotonic() >= deadline:
            # Spent. Every remaining field stays absent, which the contract already allows.
            break
        try:
            fields = reader(rpc, identity)
            for name, value in fields.items():
                if value is not None:
                    summary[name] = value
        except Exception:
            # A failed native read is not a fact, and its exception never leaves this process:
            # paths, credentials and configuration occur in them, so only the operation name
            # is logged. A reader that answered something other than fields is a failed read
            # too, not a reason to lose the overview the whole tab is waiting on.
            logger.debug("summary reader %s failed", operation)
            continue
    return summary
