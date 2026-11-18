"""#6673: an Alert goes off only when what it watches changed.

Each scheduled run is a fresh session that never sees what it said last time,
so every Alert run ends with a fenced ``ocuclaw-alert`` block saying whether
to notify and what it saw (the per-run words, ``domain/task-run-prompt.ts``),
and the plugin compares (``domain/task-alert-state.ts``, shared with
OpenClaw). Two hooks carry it on Hermes:

- ``post_llm_call`` on a cron run of a Task's job hands the run's final answer
  to the child (``task.run.answer {jobId, text, silent}``), with whether Hermes
  reads it as silent (``native_readers.autonomous_silence_reader``, as
  ``cron/scheduler.py`` does). The child keeps what the run saw and answers its verdict: ``quiet``
  (silent, or notify false), ``same`` (notify, but it saw what the last run
  saw) or ``alert``; null for a run that is no Alert's.
- The cron send hook (``TaskPushBridge.deliver_send``) keeps no result for a
  run whose verdict was ``quiet`` or ``same``: the run then reads as a quiet
  one ("nothing new"), as a ``[SILENT]`` run does.

The block itself never shows: ``task_results.parse_cron_delivery`` takes it
out of every delivery.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple

from . import native_readers
from .task_run_prompt import _task_job

logger = logging.getLogger(__name__)

TASK_RUN_ANSWER_METHOD = "task.run.answer"
TASK_RUN_ANSWER_TIMEOUT_S = 3.0
#: The answer sent to the child (the block is at its end, so keep the tail).
ANSWER_MAX = 8000
#: A verdict is for this run's own delivery, which follows its answer within this.
VERDICT_FRESH_MS = 10 * 60 * 1000
#: Verdicts that keep no result.
QUIET_VERDICTS = frozenset({"quiet", "same"})
VERDICTS = frozenset({"quiet", "same", "alert"})
_SILENT = "[SILENT]"

_lock = threading.Lock()
_verdicts: Dict[str, Tuple[str, int]] = {}


def _silent(text: str) -> bool:
    """Whether Hermes' cron delivery reads *text* as silent."""
    try:
        is_autonomous_silence_response = native_readers.autonomous_silence_reader()
    except ImportError:
        stripped = text.strip()
        lines = [line for line in stripped.splitlines() if line.strip()]
        return bool(lines) and (stripped.upper().startswith(_SILENT)
                                or lines[0].strip().upper() == _SILENT or lines[-1].strip().upper() == _SILENT)
    return bool(is_autonomous_silence_response(text))


def note_run_answer(kwargs: Dict[str, Any], *, request: Optional[Callable[..., Any]],
                    get_job: Optional[Callable[[str], Any]] = None,
                    now_ms: Optional[int] = None) -> Optional[str]:
    """``post_llm_call``: hand a Task run's final answer to the child and keep its verdict."""
    job_id = _task_job(kwargs, get_job)
    if job_id is None or request is None:
        return None
    text = kwargs.get("assistant_response")
    text = text if isinstance(text, str) else ""
    try:
        reply = request(TASK_RUN_ANSWER_METHOD, {"jobId": job_id, "text": text[-ANSWER_MAX:], "silent": _silent(text)},
                        timeout_s=TASK_RUN_ANSWER_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 - the run delivers as it always did
        logger.warning("[ocuclaw] task run answer unavailable (%s)", type(exc).__name__)
        return None
    verdict = reply.get("verdict") if isinstance(reply, dict) else None
    if verdict not in VERDICTS:
        return None
    at = int(time.time() * 1000) if now_ms is None else int(now_ms)
    with _lock:
        _verdicts[job_id] = (verdict, at)
    logger.info("[ocuclaw] task alert verdict job=%s %s", job_id, verdict)
    return verdict


def take_quiet_verdict(job_id: Optional[str], *, now_ms: Optional[int] = None) -> Optional[str]:
    """The cron send hook: this run's ``quiet``/``same`` verdict for *job_id*, taken once, else None."""
    if not isinstance(job_id, str) or not job_id:
        return None
    at = int(time.time() * 1000) if now_ms is None else int(now_ms)
    with _lock:
        kept = _verdicts.pop(job_id, None)
    if kept is None or not (0 <= at - kept[1] <= VERDICT_FRESH_MS):
        return None
    return kept[0] if kept[0] in QUIET_VERDICTS else None


def _reset_for_tests() -> None:
    with _lock:
        _verdicts.clear()
