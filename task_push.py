"""Task pop-ups (#5028): Task Results from the host inbox to the glasses.

The chain is

    cron send() -> task_results store -> ``task.result.push`` to the Node
    relay -> ``ocuclaw.push.message`` to apps that advertise
    ``taskResultPushV1`` -> the app shows the pop-up and acks
    (``ocuclaw.push.ack``) -> Node ``task.result.ack`` -> store ack.

A push is a doorbell, not an acknowledgement: a result stays unacked until
the app says it showed it. When an app with the capability connects, Node
asks for the unacked results (``task.result.unacked``) and sends them to it,
so a result nobody saw is sent again.

A Task result never goes to the home chat once the store holds it (#5817,
ending #5026's interim chat copy): with no capable app or a link that is
down, it waits unacked and pops up on the next connect, as on OpenClaw. A
failed run never pops up (the app acks it silently); its Task row shows the
failure (``failedAtMs``) and its page the cause. Only a store failure, where
nothing else holds the result, still sends its clean text to the chat.

Stdlib only, plus :mod:`task_results`.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

from . import task_results
from .native_readers import running_cron_jobs
from .task_alert_state import take_quiet_verdict
from .task_output import METHOD as TASK_OUTPUT_METHOD
from .task_output import task_output_document
from .task_run_prompt import agent_failure_of as kept_agent_failure
from .task_run_usage import run_usage
from .task_results import STATUS_OK, TaskResult, TaskResultStore, TaskResultStoreError

logger = logging.getLogger(__name__)

#: Python -> Node: results for the apps (a doorbell, never an ack).
PUSH_METHOD = "task.result.push"
#: Python -> Node (#6422): a "See it work" test's answer, for the Draft on the phone only.
TEST_RESULT_METHOD = "task.test.result"
#: A test's headline and body are cut to these, as a Task Result's are on the wire.
TEST_HEADLINE_MAX = 200
TEST_BODY_MAX = 4000
#: Node -> Python: a capable app connected; which results has nobody acked?
UNACKED_METHOD = "task.result.unacked"
#: Node -> Python: the app showed a result's pop-up.
ACK_METHOD = "task.result.ack"
#: Node -> Python (#5033): each job's newest result and failed run, for the
#: glasses' Task rows.
LATEST_METHOD = "task.result.latest"
#: One latest reply lists at most this many jobs (Node refuses more).
LATEST_MAX = 50
#: Node -> Python (#5040): one job's newest results, for its Task's page.
RECENT_METHOD = "task.result.recent"
#: Node -> Python (#5036): the wearer acted on a reminder (Done, or Again in 30 min).
REMINDER_METHOD = "task.result.reminder"
REMINDER_ACTIONS = frozenset({"done", "again"})
#: Again in 30 min: when the reminder pops up once more.
AGAIN_DELAY_MS = 30 * 60 * 1000
#: A failed run's cause, as the phone shows it.
ERROR_MAX = 300
#: One push (and one unacked reply) carries at most this many (Node refuses more).
PUSH_MAX = 20
PUSH_TIMEOUT_SECONDS = 5.0
#: Node's text bounds (``hermes-task-push.ts``).
ID_MAX = 128
NAME_MAX = 200
_RESULT_ID = re.compile(r"\A[A-Za-z0-9_-]{22}\Z")
_CONTROL = re.compile(r"[\u0000-\u001f\u007f]+")
#: #6420: Python -> Node doorbell: a Task's run started or ended, so the rows go
#: out to the apps at once (``hermes-task-rows.ts`` ``task.rows.changed``).
ROWS_CHANGED_METHOD = "task.rows.changed"
#: #6420: the mark every job a Task made carries (``task_schedule_management``).
TASK_ORIGIN_SOURCE = "ocuclaw-task"
#: #6420: a run's host error text, as Node reads it (Node clips it again and
#: removes secrets before anything reaches an app).
HOST_ERROR_MAX = 500
#: #6420: a result kept this long before (or 2 minutes after) the job's
#: ``last_run_at`` came from that run; with none, the run was quiet.
RESULT_BEFORE_RUN_MS = 3 * 60 * 1000
RESULT_AFTER_RUN_MS = 2 * 60 * 1000
#: #6420: Hermes ``last_status`` codes for a run that started and broke.
#: ``cancelled`` is not a failure, and an unknown future code says nothing.
FAILED_STATUSES = frozenset({"error", "failed", "blocked_config", "interrupted", "delivery_failed"})
#: #6678: the ``hostStatus`` of a run whose agent declared it failed (Node reads ``agent_gave_up``).
AGENT_FAILURE_STATUS = "agent_failure"
#: #6678: the agent's answer comes before its delivery and Hermes' end stamp; a delivery may
#: take this long.
AGENT_FAILURE_BEFORE_RUN_MS = 10 * 60 * 1000
#: #6420: a running job's start read again within this much of the one kept is
#: the same run (Hermes rounds the time it has run to 0.1 s).
RUN_START_JITTER_MS = 1000
#: #6420: a Send one now still waiting for Hermes' scheduler this long after the
#: tap is not going (the scheduler ticks each minute).
MANUAL_RUN_WAIT_MS = 3 * 60 * 1000
_ISO = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\Z")


def _line(value: Any, limit: int) -> Optional[str]:
    """One display line: control characters become a space, clipped; None when blank."""
    if value is None:
        return None
    text = _CONTROL.sub(" ", str(value)).strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def push_wire(result: TaskResult, *, task_id: Optional[str] = None) -> Dict[str, Any]:
    """The narrow shape Node validates: no card, no error, no ack state.

    ``taskId`` is the OcuClaw Task this job belongs to; until Tasks own their
    schedule (#5029) it is None and the job id and name identify the result.
    """
    return {
        "resultId": result.id,
        "taskId": _line(task_id, ID_MAX),
        "jobId": _line(result.job_id, ID_MAX) or "job",
        "jobName": _line(result.job_name, NAME_MAX),
        "status": result.status,
        "headline": _line(result.headline, task_results.HEADLINE_MAX) or task_results.DEFAULT_HEADLINE,
        "body": result.body[: task_results.BODY_MAX],
        "createdAtMs": int(result.created_at_ms),
    }


def latest_wire(ok: Optional[TaskResult], failed: Optional[TaskResult],
                undone: Optional[List[int]] = None,
                run: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """#5033: one job's row facts. ``latest`` is the newest ``ok`` result in
    the push shape (None when none is kept), ``latestAcked`` whether its
    pop-up showed, ``failedAtMs`` when its newest failed run ended.
    #5036: ``latestDone`` whether the wearer acted on it (a reminder's Done or
    Again in 30 min), ``undoneAtMs`` the times of the job's results nobody
    acted on yet (the last 7 days, oldest first): a reminder's missed ones.
    #6420: ``failedError`` that failed run's cause, and ``run`` the job's own
    run facts (:func:`job_run_facts`) when Hermes has any."""
    job = ok or failed
    wire = {
        "jobId": _line(job.job_id, ID_MAX) or "job",
        "jobName": _line(job.job_name, NAME_MAX),
        "latest": push_wire(ok) if ok is not None else None,
        "latestAcked": bool(ok is not None and ok.acked),
        "latestDone": bool(ok is not None and ok.done_at_ms is not None),
        "undoneAtMs": list(undone or [])[-task_results.UNDONE_MAX:],
        "failedAtMs": int(failed.created_at_ms) if failed is not None else None,
        "failedError": _line(failed.error, ERROR_MAX) if failed is not None else None,
    }
    if run:
        wire["run"] = run
    return wire


def run_only_wire(job_id: str, job_name: Any, run: Dict[str, Any]) -> Dict[str, Any]:
    """#6420: a Task's job Hermes has run facts for but no kept result yet (a
    quiet run, a failure that delivered nothing, a run going now)."""
    return {
        "jobId": _line(job_id, ID_MAX) or "job", "jobName": _line(job_name, NAME_MAX), "latest": None,
        "latestAcked": False, "latestDone": False, "undoneAtMs": [], "failedAtMs": None, "failedError": None,
        "run": run,
    }


def _iso_ms(value: Any) -> Optional[int]:
    """Hermes' run stamps are ISO with a zone; anything else is unknown."""
    if not isinstance(value, str) or not _ISO.match(value):
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        return None
    ms = int(stamp.timestamp() * 1000)
    return ms if ms >= 0 else None


def task_owned_jobs() -> List[Dict[str, Any]]:
    """#6420: the Hermes jobs a Task owns (``origin.source`` is OcuClaw's mark),
    or none when this Hermes lacks the cron API."""
    try:
        from cron.jobs import list_jobs
    except (ImportError, AttributeError):
        return []
    try:
        jobs = list_jobs(include_disabled=True)
    except Exception as exc:  # noqa: BLE001 - run facts never break the rows
        logger.debug("[ocuclaw] cron jobs unreadable for run facts: %s", exc)
        return []
    return [job for job in jobs or [] if isinstance(job, dict) and isinstance(job.get("id"), str)
            and isinstance(job.get("origin"), dict) and job["origin"].get("source") == TASK_ORIGIN_SOURCE]


def running_job_since(now_ms: int) -> Dict[str, Optional[int]]:
    """#6420: the jobs running now, each with when it started (None when Hermes
    does not say). Hermes keeps this in memory only, in this gateway process."""
    try:
        details = running_cron_jobs()
    except (ImportError, AttributeError):
        return {}
    except Exception as exc:  # noqa: BLE001
        logger.debug("[ocuclaw] running cron jobs unreadable: %s", exc)
        return {}
    out: Dict[str, Optional[int]] = {}
    for entry in details or []:
        job_id = entry.get("job_id") if isinstance(entry, Mapping) else None
        if not isinstance(job_id, str) or not job_id:
            continue
        elapsed = entry.get("elapsed_s")
        valid = isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool) and elapsed >= 0
        out[job_id] = max(0, now_ms - int(elapsed * 1000)) if valid else None
    return out


def queued_run_since(job: Mapping[str, Any], now_ms: int) -> Optional[int]:
    """#6420: Hermes runs a Send one now at its scheduler's next tick, up to a
    minute later (``cron.jobs.trigger_job`` stamps ``manual_run_at``). Until then
    the run reads as going from the tap, as on OpenClaw; with no start
    ``MANUAL_RUN_WAIT_MS`` after it, it does not. None when nothing is asked."""
    asked = job.get("manual_run_at")
    if not isinstance(asked, str) or asked != job.get("next_run_at") or not job.get("enabled", True):
        return None
    at = _iso_ms(asked)
    return at if at is not None and 0 <= now_ms - at <= MANUAL_RUN_WAIT_MS else None


def _agent_declared(job: Mapping[str, Any], error: Optional[str], ended: int,
                    agent_failure_of: Optional[Callable[[str], Optional[Dict[str, Any]]]]) -> bool:
    """#6678: the job's newest failed run is the agent's own ``[CRON_FAILURE]``: its kept
    evidence (``task_run_prompt.note_agent_failure``) is this run's ``last_error``, noted at
    most ``AGENT_FAILURE_BEFORE_RUN_MS`` before Hermes stamped the run's end."""
    if agent_failure_of is None or not error or not isinstance(job.get("id"), str):
        return False
    try:
        kept = agent_failure_of(job["id"])
    except Exception as exc:  # noqa: BLE001 - no proof: Hermes' own code stands
        logger.debug("[ocuclaw] task agent failure unreadable: %s", exc)
        return False
    if not isinstance(kept, dict) or not isinstance(kept.get("atMs"), int):
        return False
    if not ended - AGENT_FAILURE_BEFORE_RUN_MS <= kept["atMs"] <= ended + RUN_START_JITTER_MS:
        return False
    return str(kept.get("evidence") or "").strip()[:HOST_ERROR_MAX] == error.strip()[:HOST_ERROR_MAX]


def job_run_facts(job: Mapping[str, Any], results: Iterable[TaskResult],
                  running_since: Optional[int],
                  usage_of: Optional[Callable[[str, int], Optional[Dict[str, Any]]]] = None,
                  agent_failure_of: Optional[Callable[[str], Optional[Dict[str, Any]]]] = None) -> Optional[Dict[str, Any]]:
    """#6420: one Task-owned job's run facts for the rows
    (``domain/task-run-facts.ts``): a run going now, and its newest run from
    the job record. A run that ended ``ok`` with no result kept near it was a
    quiet one (``[SILENT]``, a no-agent or monitor run that found nothing). A
    failure keeps Hermes' own code and text; Node sorts and redacts them.
    #6638: ``usage_of(job_id, ended_ms)`` says what that run took
    (``task_run_usage.run_usage``), carried as the run's ``usage``."""
    facts: Dict[str, Any] = {}
    if running_since is not None:
        facts["runningSinceMs"] = running_since
    ended = _iso_ms(job.get("last_run_at"))
    status = job.get("last_status") if isinstance(job.get("last_status"), str) else None
    last: Optional[Dict[str, Any]] = None
    if ended is not None and status is not None:
        dispatch = job.get("last_dispatch") if isinstance(job.get("last_dispatch"), Mapping) else {}
        started = _iso_ms(dispatch.get("dispatched_at"))
        started = started if started is not None and started <= ended else None
        if status == "ok":
            near = any(r.status == STATUS_OK and ended - RESULT_BEFORE_RUN_MS <= r.created_at_ms <= ended + RESULT_AFTER_RUN_MS
                       for r in results)
            last = {"outcome": "ok" if near else "quiet", "startedAtMs": started, "endedAtMs": ended}
        elif status in FAILED_STATUSES:
            error = job.get("last_error") if isinstance(job.get("last_error"), str) else None
            if status == "delivery_failed" and not error:
                error = job.get("last_delivery_error") if isinstance(job.get("last_delivery_error"), str) else None
            # #6678: Hermes records an agent's [CRON_FAILURE] as a plain error; OcuClaw kept its evidence.
            if status == "error" and _agent_declared(job, error, ended, agent_failure_of):
                status = AGENT_FAILURE_STATUS
            last = {"outcome": "failed", "startedAtMs": started, "endedAtMs": ended, "hostStatus": status,
                    "error": error[:HOST_ERROR_MAX] if error else None}
    if last is not None and usage_of is not None and isinstance(job.get("id"), str):
        try:
            usage = usage_of(job["id"], last["endedAtMs"])
        except Exception as exc:  # noqa: BLE001 - usage never breaks the rows
            logger.debug("[ocuclaw] task run usage failed: %s", exc)
            usage = None
        if isinstance(usage, dict):
            last["usage"] = usage
    if last is not None:
        facts["lastRun"] = last
    return facts or None


class TaskPushBridge:
    """The Python half. ``request(method, params)`` is the control link's
    request, read at call time (it raises while the link is down).
    ``store`` builds the store each call, so tests can point it anywhere."""

    def __init__(self, request: Callable[[str, dict], Awaitable[Any]], *,
                 store: Callable[[], TaskResultStore] = TaskResultStore,
                 now_ms: Callable[[], int] = lambda: int(time.time() * 1000),
                 owned_jobs: Callable[[], List[Dict[str, Any]]] = task_owned_jobs,
                 running: Callable[[int], Dict[str, Optional[int]]] = running_job_since,
                 usage_of: Optional[Callable[[str, int], Optional[Dict[str, Any]]]] = run_usage,
                 agent_failure_of: Optional[Callable[[str], Optional[Dict[str, Any]]]] = kept_agent_failure,
                 quiet_verdict: Callable[[Optional[str]], Optional[str]] = take_quiet_verdict):
        self._request = request
        # #6673: an Alert run's quiet verdict, taken once by its delivery (tests point it anywhere).
        self._quiet_verdict = quiet_verdict
        # #6638: what each job's newest run took (tests point it anywhere).
        self._usage_of = usage_of
        # #6678: a job's kept [CRON_FAILURE] evidence (tests point it anywhere).
        self._agent_failure_of = agent_failure_of
        self._store = store
        self._now_ms = now_ms
        self._again_handle: Optional[asyncio.TimerHandle] = None
        # #6420: the Hermes cron reads behind the run facts (tests point them anywhere).
        self._owned_jobs = owned_jobs
        self._running = running
        # Each running job's start, kept while it runs; a run Hermes names without a
        # start is dated by when it was first seen here.
        self._first_seen: Dict[str, int] = {}
        # The last run facts the watch saw: a change rings Node.
        self._run_signature: Optional[Tuple[Any, ...]] = None

    async def push(self, results: Iterable[TaskResult]) -> int:
        """Send *results* to the capable apps. Returns how many frames went out
        (0 when no capable app is connected or the link is down); never raises."""
        results = list(results)[:PUSH_MAX]
        batch = [push_wire(r) for r in results]
        if not batch:
            return 0
        params: Dict[str, Any] = {"results": batch}
        # #5032: an ok result's card values ride beside it, by result id, so
        # Node keeps them for its Task's Look before the app hears of it.
        cards = {r.id: r.card for r in results if r.status == STATUS_OK and isinstance(r.card, dict)}
        if cards:
            params["cards"] = cards
        try:
            reply = await self._request(PUSH_METHOD, params)
        except Exception as exc:  # noqa: BLE001 - stays unacked; the next connect sends it
            logger.debug("[ocuclaw] task result push failed: %s", exc)
            return 0
        if not isinstance(reply, Mapping) or reply.get("ok") is not True:
            logger.warning("[ocuclaw] task result push refused: %s",
                           reply.get("error") if isinstance(reply, Mapping) else "unknown")
            return 0
        sent = reply.get("sent")
        return sent if isinstance(sent, int) and not isinstance(sent, bool) and sent > 0 else 0

    def _record(self, content: Any, metadata: Mapping[str, Any]) -> Tuple[Optional[TaskResult], str]:
        job_id = task_results.task_job_id(metadata)
        try:
            result = self._store().record_result(job_id, None, content, metadata)
        except (TaskResultStoreError, ValueError) as exc:
            logger.warning("[ocuclaw] task result for job %s not stored: %s", job_id, exc)
            return None, task_results.clean_text(task_results.parse_cron_delivery(content))
        logger.info("[ocuclaw] task result %s stored for job %s (%s)", result.id, result.job_id, result.status)
        return result, task_results.clean_text({"headline": result.headline, "body": result.body})

    async def deliver_send(self, content: Any, metadata: Mapping[str, Any]) -> Tuple[bool, str]:
        """The adapter's cron-send hook: keep the result and push it.

        Returns ``(held, text)``. ``held`` is True when the store kept the
        result, pushed or not; the adapter then skips the home chat (#5817).
        Only on a store failure is it False, and the adapter delivers *text*,
        the clean text, as the last resort.
        """
        verdict = self._quiet_verdict(task_results.task_job_id(metadata))
        if verdict is not None:
            # #6673: an Alert run that would not alert, or saw what its last run saw, keeps no
            # result, so it reads as a quiet run ("nothing new") and never pops up.
            logger.info("[ocuclaw] task alert run for job %s kept no result (%s)",
                        task_results.task_job_id(metadata), verdict)
            return True, ""
        result, text = await asyncio.to_thread(self._record, content, metadata)
        if result is None:
            return False, text
        await self.push([result])
        return True, text

    async def deliver_test(self, content: Any, metadata: Mapping[str, Any]) -> bool:
        """A "See it work" test's delivery (#6422): hand the answer to Node for the Draft.

        Nothing is stored, pushed as a Task Result, or sent to the home chat: a test keeps
        nothing until the owner creates the Task. Always True (held); a link failure only
        means the phone hears no answer and Node ends the test when its wait runs out.
        """
        parsed = task_results.parse_cron_delivery(content)
        params: Dict[str, Any] = {
            "jobId": task_results.task_job_id(metadata),
            "failed": parsed.get("failed") is True,
            "headline": str(parsed.get("headline") or "")[:TEST_HEADLINE_MAX],
            "body": str(parsed.get("body") or "")[:TEST_BODY_MAX],
        }
        if isinstance(parsed.get("card"), dict):
            params["card"] = parsed["card"]
        try:
            await self._request(TEST_RESULT_METHOD, params)
        except Exception as exc:  # noqa: BLE001 - the phone's wait runs out instead
            logger.debug("[ocuclaw] test result hand-off failed: %s", exc)
        return True

    async def deliver_stored(self, result_id: str) -> bool:
        """The inbox pump's hook for a result already kept (``hermes cron
        run``, #5031): push it, never store it again. True when the store
        holds it, as :meth:`deliver_send`; only when it cannot be read does
        the pump send the clean text."""
        try:
            result = await asyncio.to_thread(lambda: self._store().get(result_id))
        except TaskResultStoreError as exc:
            logger.debug("[ocuclaw] stored task result %s unreadable: %s", result_id, exc)
            return False
        if result is None:
            return False
        await self.push([result])
        return True

    def _unacked(self) -> List[Dict[str, Any]]:
        results = self._store().list_unacked()
        return [push_wire(r) for r in results[-PUSH_MAX:]]

    async def handle_unacked(self, params: Any) -> Dict[str, Any]:
        """Node asks, for a capable app that just connected: the newest
        unacked results, oldest first."""
        self.arm_again()
        try:
            results = await asyncio.to_thread(self._unacked)
        except TaskResultStoreError:
            return {"ok": False, "error": "store_unavailable"}
        return {"ok": True, "results": results}

    async def handle_ack(self, params: Any) -> Dict[str, Any]:
        """The app showed a result's pop-up. A repeat is harmless (``acked`` False)."""
        result_id = params.get("resultId") if isinstance(params, Mapping) else None
        if not isinstance(result_id, str) or not _RESULT_ID.match(result_id):
            return {"ok": False, "error": "invalid_params"}
        try:
            acked = await asyncio.to_thread(lambda: self._store().ack(result_id))
        except TaskResultStoreError:
            return {"ok": False, "error": "store_unavailable"}
        if acked:
            logger.info("[ocuclaw] task result %s acked by the app", result_id)
        return {"ok": True, "acked": bool(acked)}

    def _running_now(self, now_ms: int, owned: Iterable[Mapping[str, Any]] = ()) -> Dict[str, int]:
        """#6420: the jobs running now, each with its start, and each Send one now
        still waiting for the scheduler's tick, from the tap."""
        try:
            running = dict(self._running(now_ms))
        except Exception:  # noqa: BLE001
            running = {}
        for job in owned:
            asked = queued_run_since(job, now_ms)
            if asked is not None and job["id"] not in running:
                running[job["id"]] = asked
        for job_id in [j for j in self._first_seen if j not in running]:
            del self._first_seen[job_id]
        out: Dict[str, int] = {}
        for job_id, since in running.items():
            # Hermes says how long a run has gone to the tenth of a second, so the start
            # it gives moves a little on each read. Keep the first one while the run goes,
            # unless a later start says a new run began.
            kept = self._first_seen.get(job_id)
            if kept is None or (since is not None and since > kept + RUN_START_JITTER_MS):
                kept = self._first_seen[job_id] = since if since is not None else now_ms
            out[job_id] = kept
        return out

    def _owned(self) -> List[Dict[str, Any]]:
        try:
            return list(self._owned_jobs() or [])
        except Exception:  # noqa: BLE001
            return []

    def _latest(self) -> List[Dict[str, Any]]:
        store = self._store()
        now_ms = self._now_ms()
        undone = store.undone_by_job(now_ms=now_ms)
        # #6420: each Task-owned job's own run facts, from the job record and the running set.
        owned = self._owned()
        running = self._running_now(now_ms, owned)
        facts: Dict[str, Dict[str, Any]] = {}
        names: Dict[str, Any] = {}
        for job in owned:
            job_id = job["id"]
            run = job_run_facts(job, store.recent_for_job(job_id, limit=5), running.get(job_id), self._usage_of,
                                self._agent_failure_of)
            if run:
                facts[job_id] = run
                names[job_id] = job.get("name")
        rows = []
        for ok, failed in store.latest_by_job()[:LATEST_MAX]:
            job_id = (ok or failed).job_id
            rows.append(latest_wire(ok, failed, undone.get(job_id), facts.pop(job_id, None)))
        for job_id, run in facts.items():
            if len(rows) >= LATEST_MAX:
                break
            rows.append(run_only_wire(job_id, names.get(job_id), run))
        return rows

    def _run_state(self) -> Tuple[Any, ...]:
        """#6420: what the rows' run facts rest on: the Task jobs running now
        (a Send one now waiting for the tick among them) and each one's newest run."""
        owned = self._owned()
        ids = {job["id"] for job in owned}
        now_ms = self._now_ms()
        going = set(self._running(now_ms)) | {job["id"] for job in owned if queued_run_since(job, now_ms) is not None}
        running = tuple(sorted(j for j in going if j in ids))
        runs = tuple(sorted((job["id"], str(job.get("last_run_at")), str(job.get("last_status"))) for job in owned))
        return running, runs

    async def watch_runs(self) -> bool:
        """#6420: the inbox pump's tick: when a Task's run started or ended since
        the last look, ring Node so the rows go out to the apps at once (the
        glasses' corner spinner). The first look only remembers. True when it
        rang; never raises."""
        try:
            signature = await asyncio.to_thread(self._run_state)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[ocuclaw] task run watch failed: %s", exc)
            return False
        previous, self._run_signature = self._run_signature, signature
        if previous is None or previous == signature:
            return False
        try:
            await self._request(ROWS_CHANGED_METHOD, {})
        except Exception as exc:  # noqa: BLE001 - rung again on the next tick
            logger.debug("[ocuclaw] task rows doorbell failed: %s", exc)
            self._run_signature = previous
            return False
        return True

    async def handle_latest(self, params: Any) -> Dict[str, Any]:
        """#5033: Node asks for the glasses' Task rows: each job's newest
        result and failed run, newest job first. Read-only; acks nothing."""
        self.arm_again()
        try:
            jobs = await asyncio.to_thread(self._latest)
        except TaskResultStoreError:
            return {"ok": False, "error": "store_unavailable"}
        return {"ok": True, "jobs": jobs}

    # -- reminders (#5036) -------------------------------------------------

    async def handle_reminder(self, params: Any) -> Dict[str, Any]:
        """The wearer acted on a reminder on the glasses: ``done``, or
        ``again`` (it pops up once more in :data:`AGAIN_DELAY_MS`). The host
        keeps the Again, not the phone, so it comes even if the phone sleeps:
        the copy waits unacked and the next connect sends it."""
        result_id = params.get("resultId") if isinstance(params, Mapping) else None
        action = params.get("action") if isinstance(params, Mapping) else None
        if not isinstance(result_id, str) or not _RESULT_ID.match(result_id) or action not in REMINDER_ACTIONS:
            return {"ok": False, "error": "invalid_params"}
        now_ms = self._now_ms()
        again_at = now_ms + AGAIN_DELAY_MS if action == "again" else None
        try:
            acted = await asyncio.to_thread(
                lambda: self._store().act_on_reminder(result_id, again_at_ms=again_at, now_ms=now_ms))
        except TaskResultStoreError:
            return {"ok": False, "error": "store_unavailable"}
        if acted is None:
            return {"ok": True, "found": False}
        logger.info("[ocuclaw] reminder %s: %s", result_id, action)
        self.arm_again()
        return {"ok": True, "found": True, **({"againAtMs": again_at} if again_at is not None else {})}

    def arm_again(self) -> None:
        """Make sure the soonest Again in 30 min has a timer. Called after an
        Again and on every connect and rows read, so a gateway restart (which
        loses timers) re-arms on the next one. Never raises."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        try:
            at = self._store().next_again_at()
        except TaskResultStoreError:
            return
        if self._again_handle is not None:
            self._again_handle.cancel()
            self._again_handle = None
        if at is None:
            return
        delay = max(0.0, (at - self._now_ms()) / 1000.0)
        self._again_handle = loop.call_later(delay, lambda: loop.create_task(self.fire_agains()))

    async def fire_agains(self) -> int:
        """Pop up each Again that is due (a fresh copy of the reminder), then
        arm the next. Returns how many copies were made."""
        self._again_handle = None
        try:
            copies = await asyncio.to_thread(lambda: self._store().fire_agains(now_ms=self._now_ms()))
        except TaskResultStoreError:
            copies = []
        if copies:
            sent = await self.push(copies)
            logger.info("[ocuclaw] %d reminder(s) popped up again (%d sent)", len(copies), sent)
        self.arm_again()
        return len(copies)

    def _recent(self, job_id: str) -> List[Dict[str, Any]]:
        rows = []
        for result in self._store().recent_for_job(job_id):
            row = {**push_wire(result), "error": _line(result.error, ERROR_MAX) if result.failed else None}
            # Stored/delivered is not received by the app. Failed notices are
            # acked without a successful result popup, so only ok receipts count.
            acked = result.acked_at_ms
            if (result.status == STATUS_OK and isinstance(acked, int) and not isinstance(acked, bool)
                    and result.created_at_ms <= acked <= 8_640_000_000_000_000):
                row["ackedAtMs"] = acked
            rows.append(row)
        return rows

    async def handle_recent(self, params: Any) -> Dict[str, Any]:
        """#5040: Node asks for one job's newest results (at most 30, newest
        first), each with its failure cause. Read-only; acks nothing."""
        job_id = params.get("jobId") if isinstance(params, Mapping) else None
        if not isinstance(job_id, str) or not job_id or len(job_id) > ID_MAX or _CONTROL.search(job_id):
            return {"ok": False, "error": "invalid_params"}
        try:
            results = await asyncio.to_thread(self._recent, job_id)
        except TaskResultStoreError:
            return {"ok": False, "error": "store_unavailable"}
        return {"ok": True, "results": results}

    async def handle_task_output(self, params: Any) -> Dict[str, Any]:
        """#6892: a Debug Report's Task output (``taskOutput.snapshot``, task_output.py):
        each named job's newest result, and a failed run's cron log tail. Read-only."""
        return await asyncio.to_thread(task_output_document, params, store=self._store)

    def handlers(self) -> Dict[str, Callable[[Any], Awaitable[Dict[str, Any]]]]:
        """The link methods Node calls."""
        return {UNACKED_METHOD: self.handle_unacked, ACK_METHOD: self.handle_ack,
                LATEST_METHOD: self.handle_latest, RECENT_METHOD: self.handle_recent,
                REMINDER_METHOD: self.handle_reminder, TASK_OUTPUT_METHOD: self.handle_task_output}
