"""#6678: a Task's scheduled run gets OcuClaw's per-run words, and its own failure is kept.

Ruled by Matt (2026-11-06, #6678): a text Brief where nothing could be checked
reads Failed, with the agent's own line. Two hooks carry it on Hermes:

- ``pre_llm_call`` on a cron run of a Task's job asks the child for this run's
  words (``task.run.prompt {jobId}``, the shared ``domain/task-run-prompt.ts``)
  and hands them to Hermes as the turn's context. Nothing is written to the
  job, and a child that does not answer leaves the run as approved.
- ``post_llm_call`` on the same run keeps the agent's own ``[CRON_FAILURE]``
  evidence, read exactly as Hermes reads it (``cron/scheduler.py``
  ``_cron_failure_marker_error``). Hermes then records the run as a plain
  ``error`` with that evidence as ``last_error``, so nothing in the job tells
  an agent's verdict from a broken run. ``task_push.job_run_facts`` matches the
  kept evidence to the job's ``last_error`` and reports ``agent_failure``, which
  the run facts read as ``agent_gave_up`` with the agent's line.

The kept evidence is one small JSON file under the plugin's state directory,
the newest per job, so a run read after a gateway restart still reads right.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .task_uses_hook import task_cron_job_of_session

logger = logging.getLogger(__name__)

TASK_RUN_PROMPT_METHOD = "task.run.prompt"
TASK_RUN_PROMPT_TIMEOUT_S = 3.0
#: Hermes' own agent-declared failure marker: the exact, whole first line.
CRON_FAILURE_MARKER = "[CRON_FAILURE]"
#: Hermes' evidence when the agent wrote nothing after the marker.
DEFAULT_EVIDENCE = "Cron agent reported failure."
#: The platform Hermes' scheduler gives a cron run's agent.
CRON_PLATFORM = "cron"
AGENT_FAILURES_FILENAME = "task_agent_failures.json"
AGENT_FAILURES_MAX = 64
#: Kept evidence, like a run's host error, is read as Node reads it (task_push.HOST_ERROR_MAX).
EVIDENCE_MAX = 500
CONTEXT_MAX = 4000


def _task_job(kwargs: Dict[str, Any], get_job: Optional[Callable[[str], Any]] = None) -> Optional[str]:
    """The Task job this hook call's turn is a scheduled run of, else None."""
    if str(kwargs.get("platform") or "") != CRON_PLATFORM:
        return None
    if str(kwargs.get("parent_session_id") or "").strip():
        # A delegated child's turn is not the run's answer.
        return None
    session_id = str(kwargs.get("session_id") or "").strip()
    if not session_id:
        return None
    return task_cron_job_of_session(session_id, get_job)


def task_run_prompt_context(kwargs: Dict[str, Any], *, request: Optional[Callable[..., Any]],
                            get_job: Optional[Callable[[str], Any]] = None) -> Optional[str]:
    """``pre_llm_call``: this run's words from the child, or None (not a Task run, no words, no link)."""
    job_id = _task_job(kwargs, get_job)
    if job_id is None or request is None:
        return None
    try:
        reply = request(TASK_RUN_PROMPT_METHOD, {"jobId": job_id}, timeout_s=TASK_RUN_PROMPT_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 - the run goes as approved
        logger.warning("[ocuclaw] task run prompt unavailable (%s)", type(exc).__name__)
        return None
    context = reply.get("context") if isinstance(reply, dict) else None
    if not isinstance(context, str) or not context.strip():
        return None
    logger.info("[ocuclaw] task run prompt job=%s", job_id)
    return context.strip()[:CONTEXT_MAX]


def agent_declared_failure(text: Any) -> Optional[str]:
    """The agent's ``[CRON_FAILURE]`` evidence, as Hermes reads it, else None."""
    lines = (text if isinstance(text, str) else "").splitlines()
    if not lines or lines[0].rstrip() != CRON_FAILURE_MARKER:
        return None
    return "\n".join(lines[1:]).strip() or DEFAULT_EVIDENCE


def agent_failures_path() -> Optional[Path]:
    try:
        from . import receipts
    except ImportError:
        return None
    directory = receipts.state_dir()
    return None if directory is None else directory / AGENT_FAILURES_FILENAME


def _read(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    jobs = data.get("jobs") if isinstance(data, dict) else None
    return jobs if isinstance(jobs, dict) else {}


def _write(path: Path, jobs: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix=".task_agent_failures.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"schemaVersion": 1, "jobs": jobs}, handle, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def note_agent_failure(kwargs: Dict[str, Any], *, get_job: Optional[Callable[[str], Any]] = None,
                       now_ms: Optional[int] = None, path: Optional[Path] = None) -> bool:
    """``post_llm_call``: keep a Task run's ``[CRON_FAILURE]`` evidence. True when one was kept."""
    evidence = agent_declared_failure(kwargs.get("assistant_response"))
    if evidence is None:
        return False
    job_id = _task_job(kwargs, get_job)
    if job_id is None:
        return False
    target = path if path is not None else agent_failures_path()
    if target is None:
        return False
    at = int(time.time() * 1000) if now_ms is None else int(now_ms)
    jobs = _read(target)
    jobs.pop(job_id, None)
    jobs[job_id] = {"atMs": at, "evidence": evidence[:EVIDENCE_MAX]}
    while len(jobs) > AGENT_FAILURES_MAX:
        jobs.pop(next(iter(jobs)))
    try:
        _write(target, jobs)
    except OSError as exc:
        logger.warning("[ocuclaw] task agent failure not kept (%s)", type(exc).__name__)
        return False
    logger.info("[ocuclaw] task run agent failure job=%s", job_id)
    return True


def agent_failure_of(job_id: str, path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """The newest kept ``{atMs, evidence}`` for a job, or None."""
    target = path if path is not None else agent_failures_path()
    if target is None or not isinstance(job_id, str) or not job_id:
        return None
    entry = _read(target).get(job_id)
    if (not isinstance(entry, dict) or not isinstance(entry.get("evidence"), str)
            or not isinstance(entry.get("atMs"), int) or isinstance(entry.get("atMs"), bool)):
        return None
    return entry
