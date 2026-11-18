"""Pause model Tasks while the glasses are away (#5037).

Hermes keeps running a Task's job when nobody wears the glasses. Its own
catch-up only covers ten minutes of gateway downtime, so a week away would
pile up a week of briefs nobody reads, each one a paid model call.

So the gateway remembers when the glasses were last seen (the app-presence
receipt the adapter writes every 30 seconds). After ``AWAY_AFTER_MS`` with no
glasses, every job a Task owns that calls the model is paused with Hermes'
own ``pause_job(job_id, reason=AWAY_REASON)``. The next time the glasses are
seen, only jobs still paused with that reason are resumed, so a job the owner
paused stays paused. Nothing runs by itself on return: resume only puts the
job back on its schedule.

* Fixed-text reminders (``no_agent`` jobs, #5036) are never paused: they cost
  no model call, and a missed "pay rent" must still show up.
* One switch turns the away pause off. Turning it off resumes OcuClaw's own
  pauses at once.
* The state is one small file, ``<HERMES_HOME>/state/ocuclaw.task-away.json``.

Every entry point here is called from the presence pump's write path or a
management op, so none of them raises: a cron store fault must never break
the presence receipt.
"""

from __future__ import annotations

import json
import logging
import time
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

from .receipts import state_dir, write_json_receipt
from .task_schedule_management import OWNER_SOURCE

logger = logging.getLogger(__name__)

STATE_FILENAME = "ocuclaw.task-away.json"
SCHEMA_VERSION = 1
#: Two days without the glasses (#5022).
AWAY_AFTER_MS = 2 * 24 * 60 * 60 * 1000
#: The reason Hermes stores on jobs OcuClaw paused. Resume reads it back, so
#: it must never match a reason an owner or another tool could write.
AWAY_REASON = "ocuclaw-away"
#: "Seen" is written at most this often while the glasses stay connected.
SEEN_WRITE_EVERY_MS = 10 * 60 * 1000

_EMPTY: Dict[str, Any] = {"schemaVersion": SCHEMA_VERSION, "enabled": True,
                          "lastSeenAtMs": None, "pausedJobIds": []}


def _now_ms() -> int:
    return int(time.time() * 1000)


def state_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(None if home is None else Path(home))
    return None if directory is None else directory / STATE_FILENAME


def read_state(home: Optional[Path] = None) -> Dict[str, Any]:
    """The stored state, or the defaults when it is missing or unreadable."""
    path = state_path(home)
    state = dict(_EMPTY, pausedJobIds=[])
    if path is None:
        return state
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return state
    if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
        return state
    if isinstance(raw.get("enabled"), bool):
        state["enabled"] = raw["enabled"]
    seen = raw.get("lastSeenAtMs")
    if isinstance(seen, int) and not isinstance(seen, bool) and seen > 0:
        state["lastSeenAtMs"] = seen
    paused = raw.get("pausedJobIds")
    if isinstance(paused, list):
        state["pausedJobIds"] = [str(item) for item in paused if isinstance(item, str)][:256]
    return state


def _write_state(state: Mapping[str, Any], home: Optional[Path]) -> bool:
    path = state_path(home)
    if path is None:
        return False
    try:
        write_json_receipt(path, dict(state))
        return True
    except Exception:  # noqa: BLE001 - a state write never breaks the pump
        logger.warning("[ocuclaw] could not write the Task away state", exc_info=True)
        return False


def glasses_seen(body: Mapping[str, Any]) -> Optional[bool]:
    """What one app-presence receipt says about the glasses.

    True when the G2 reports connected; False when the relay answered and no
    app or glasses are there. None when the receipt cannot tell (the relay
    did not answer), which changes nothing.
    """
    if not isinstance(body, Mapping) or body.get("observationErrorCode"):
        return None
    device = body.get("device") if isinstance(body.get("device"), Mapping) else {}
    connected = device.get("connected")
    if connected is True:
        return True
    count = body.get("authenticatedAppCount")
    if not isinstance(count, int) or isinstance(count, bool):
        return None
    if connected is None and count > 0:
        # An app that reports no device facts: the app is the best evidence.
        return True
    return False


def _cron():
    from cron.jobs import get_job, list_jobs, pause_job, resume_job, use_cron_store

    return get_job, list_jobs, pause_job, resume_job, use_cron_store


def _uses_model(job: Mapping[str, Any]) -> bool:
    return not job.get("no_agent")


def _owned_by_a_task(job: Mapping[str, Any]) -> bool:
    origin = job.get("origin")
    return isinstance(origin, Mapping) and origin.get("source") == OWNER_SOURCE


def _store(home: Optional[Path], use_cron_store: Callable[[Any], Any]):
    return use_cron_store(home) if home is not None else nullcontext()


def _pause_away(home: Optional[Path]) -> List[str]:
    _get, list_jobs, pause_job, _resume, use_cron_store = _cron()
    paused: List[str] = []
    with _store(home, use_cron_store):
        for job in list_jobs(include_disabled=True):
            if not _owned_by_a_task(job) or not _uses_model(job) or not job.get("enabled", True):
                continue
            if pause_job(job["id"], reason=AWAY_REASON) is not None:
                paused.append(str(job["id"]))
    return paused


def _resume_away(job_ids: List[str], home: Optional[Path]) -> List[str]:
    get_job, _list, _pause, resume_job, use_cron_store = _cron()
    resumed: List[str] = []
    with _store(home, use_cron_store):
        for job_id in job_ids:
            job = get_job(job_id)
            # Only a job still paused for this reason: one the owner paused,
            # resumed or deleted since is left as it is.
            if job is None or job.get("enabled", True) or job.get("paused_reason") != AWAY_REASON:
                continue
            if resume_job(job_id) is not None:
                resumed.append(job_id)
    return resumed


def observe(body: Mapping[str, Any], *, home: Optional[Path] = None,
            now_ms: Optional[int] = None) -> str:
    """Feed one app-presence receipt. Returns what happened, for logs and tests:
    ``unknown``, ``seen``, ``resumed``, ``waiting``, ``paused``, ``off`` or ``failed``.
    """
    try:
        seen = glasses_seen(body)
        if seen is None:
            return "unknown"
        now = _now_ms() if now_ms is None else now_ms
        state = read_state(home)
        if seen:
            outcome = "seen"
            if state["pausedJobIds"]:
                resumed = _resume_away(state["pausedJobIds"], home)
                logger.info("[ocuclaw] glasses back: resumed %d Task job(s)", len(resumed))
                state["pausedJobIds"] = []
                outcome = "resumed"
            last = state["lastSeenAtMs"]
            if outcome == "resumed" or last is None or now - last >= SEEN_WRITE_EVERY_MS:
                state["lastSeenAtMs"] = now
                _write_state(state, home)
            return outcome
        if not state["enabled"]:
            return "off"
        if state["lastSeenAtMs"] is None:
            # Never seen since this feature arrived: start the clock now, so
            # an install never pauses anything on its first reading.
            state["lastSeenAtMs"] = now
            _write_state(state, home)
            return "waiting"
        if state["pausedJobIds"] or now - state["lastSeenAtMs"] < AWAY_AFTER_MS:
            return "waiting"
        state["pausedJobIds"] = _pause_away(home)
        _write_state(state, home)
        logger.info("[ocuclaw] glasses away 2 days: paused %d Task job(s)",
                    len(state["pausedJobIds"]))
        return "paused"
    except Exception:  # noqa: BLE001 - never breaks the presence receipt
        logger.warning("[ocuclaw] Task away check failed", exc_info=True)
        return "failed"


def set_enabled(enabled: bool, *, home: Optional[Path] = None) -> Dict[str, Any]:
    """The one switch. Off resumes OcuClaw's own pauses at once."""
    state = read_state(home)
    state["enabled"] = bool(enabled)
    resumed: List[str] = []
    if not enabled and state["pausedJobIds"]:
        resumed = _resume_away(state["pausedJobIds"], home)
        state["pausedJobIds"] = []
    if not _write_state(state, home):
        raise OSError("the Task away state could not be written")
    return {"enabled": state["enabled"], "resumedJobIds": resumed}


def view(home: Optional[Path] = None) -> Dict[str, Any]:
    state = read_state(home)
    return {"enabled": state["enabled"], "lastSeenAtMs": state["lastSeenAtMs"],
            "pausedCount": len(state["pausedJobIds"]), "awayAfterMs": AWAY_AFTER_MS}
