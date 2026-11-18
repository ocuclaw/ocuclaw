"""Task output for a Debug Report (#6892, spec #6875, ruling #6596 r12).

When the wearer sends a Debug Report, the Node relay asks for the Task
output of the Tasks the wearer used, as one more fixed document, the way it
asks for ``connectionHealth.snapshot``:

    ``taskOutput.snapshot {jobIds}`` -> ``ocuclaw.task-output-snapshot`` v1

For each named job the document holds the newest Task Result (status,
headline, the body's first 4,096 characters, card values, time) and, only
when that newest result is a failed run, the last 8 KB of the job's newest
cron output file. Read-only: it acks nothing and changes nothing. Node redacts
the body and the log (the host-text redactor, then the report's code-safe
secret pass) before anything goes into the report, and keeps 4 KB of the body.

SECURITY-RULED (#6596): a Debug Report may hold Task output (latest Task
Result body up to 4 KB, redacted; Hermes cron log only for a failed run, last
8 KB), only in a report the wearer chooses to send, only after the code-safe
secret pass, and only to the existing debug upload and triage services.
Nothing new listens or is reachable: this answers the existing link only.

The link handler is ``TaskPushBridge.handle_task_output`` (task_push.py), beside
the other ``task.result.*`` methods Node calls.

Stdlib only, plus :mod:`task_results`.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

from .task_results import TaskResultStore, TaskResultStoreError

logger = logging.getLogger(__name__)

METHOD = "taskOutput.snapshot"
CONTRACT = "ocuclaw.task-output-snapshot"
CONTRACT_VERSION = 1
#: A report carries at most 3 Tasks; a request names at most this many jobs.
JOBS_MAX = 8
#: The body's start that goes over the link (the report keeps 4 KB of it).
BODY_CHARS = 4096
#: The cron log tail a failed run sends.
CRON_LOG_BYTES = 8192
ID_MAX = 128
#: A job id names a folder: letters, digits, ``.``, ``_`` and ``-`` only, never a separator,
#: a drive (``C:``), ``.`` or ``..``.
_SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,%d}\Z" % (ID_MAX - 1))
#: The page watch's own file in a job's output folder (task_page_watch.py): never a run log.
_NOT_RUN_LOGS = frozenset({"monitor_last_output.txt"})


def _hermes_output_dir(job_id: str) -> Optional[Path]:
    """Hermes keeps each cron run's output under ``cron/output/<job_id>/``."""
    try:
        from cron import jobs  # Hermes; absent in a bare test environment.
        return Path(jobs._job_output_dir(job_id))
    except Exception:  # noqa: BLE001 - no Hermes cron, no log
        return None


def _tail(path: Path, limit: int) -> str:
    size = path.stat().st_size
    with path.open("rb") as handle:
        if size > limit:
            handle.seek(size - limit)
        data = handle.read(limit)
    text = data.decode("utf-8", errors="replace")
    # A cut that landed inside a character leaves a replacement mark first.
    return text.lstrip("�") if size > limit else text


def cron_log_tail(job_id: str, output_dir_of: Callable[[str], Optional[Path]] = _hermes_output_dir) -> Optional[Dict[str, Any]]:
    """The newest run log of *job_id*: its last 8 KB and when it was written, or None."""
    folder = output_dir_of(job_id)
    if folder is None:
        return None
    try:
        logs = [entry for entry in folder.iterdir()
                if entry.is_file() and not entry.is_symlink() and entry.name not in _NOT_RUN_LOGS]
        if not logs:
            return None
        newest = max(logs, key=lambda entry: entry.stat().st_mtime)
        text = _tail(newest, CRON_LOG_BYTES)
        at_ms = int(newest.stat().st_mtime * 1000)
    except OSError:
        return None
    return {"text": text, "atMs": at_ms} if text else None


def _job_ids(params: Any) -> List[str]:
    raw = params.get("jobIds") if isinstance(params, Mapping) else None
    if not isinstance(raw, list):
        return []
    seen: List[str] = []
    for job_id in raw:
        if isinstance(job_id, str) and _SAFE_ID.match(job_id) and job_id not in seen:
            seen.append(job_id)
    return seen[:JOBS_MAX]


def task_output_document(params: Any, *, store: Callable[[], TaskResultStore] = TaskResultStore,
                         output_dir_of: Callable[[str], Optional[Path]] = _hermes_output_dir) -> Dict[str, Any]:
    """The ``ocuclaw.task-output-snapshot`` v1 document for the jobs *params* names."""
    jobs: List[Dict[str, Any]] = []
    ids = _job_ids(params)
    kept = None
    if ids:
        try:
            kept = store()
        except (TaskResultStoreError, OSError) as exc:
            logger.warning("[ocuclaw] task output store unavailable: %s", type(exc).__name__)
    for job_id in ids:
        newest = None
        if kept is not None:
            try:
                recent = kept.recent_for_job(job_id, 1)
                newest = recent[0] if recent else None
            except (TaskResultStoreError, OSError):
                newest = None
        result = None
        if newest is not None:
            result = {
                "status": newest.status,
                "headline": newest.headline,
                "body": (newest.body or "")[:BODY_CHARS],
                "card": newest.card,
                "createdAtMs": newest.created_at_ms,
                "truncated": bool(newest.truncated),
            }
        cron_log = cron_log_tail(job_id, output_dir_of) if newest is not None and newest.failed else None
        jobs.append({"jobId": job_id, "result": result, "cronLog": cron_log})
    return {"contract": CONTRACT, "contractVersion": CONTRACT_VERSION, "jobs": jobs}
