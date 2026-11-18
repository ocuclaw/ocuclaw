"""#6422 "What it uses": hold a Task's runs to its list from Hermes's ``pre_tool_call`` hook.

The list and the decision live in the shared Node runtime
(extensions/ocuclaw/src/tools/glasses-ui-task-uses.ts). This module works out
whether a tool call can belong to a Task run, and asks the child over the
control link (``task.uses.check``, hermes-task-uses-check.ts):

- a cron session (``cron_<jobId>_<YYYYmmdd>_<HHMMSS>`` on older Hermes, a
  ``local-<hex>`` owner execution admitted as ``cron:<jobId>:…`` on newer) whose
  job OcuClaw made for a Task (``origin.source == "ocuclaw-task"``): a scheduled run, or "Send
  one now", which an open of the Task's card may have started;
- a session on the OcuClaw platform: the one run launched from the glasses
  rides one of those, and the child matches it by session.

Every other call is left alone without a link round trip. A call this module
forwards runs only on the child's explicit ``{"block": false}``: when the child
cannot answer (no adapter, a link error or timeout, a reply of any other shape),
or the call's arguments cannot reach it as the host will act on them, the call is
refused. That holds for an OcuClaw chat too (DeepSec finding_2db4afd2955e3604):
the run launched from the glasses rides one, and only the child can tell it from
the wearer's own chat.

A cron session keeps being checked by the job its session names after the job's
record is gone (DeepSec finding_865f515d3a39d62a): a test's end, or a Task's
delete, removes the record while its agent may still be running. A job this
process ended (``note_task_job_ended``) holds every call of its run.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
import sqlite3
import sys
import threading
import time
import types
from collections import OrderedDict
from contextlib import closing
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .control_link import RPC_METHOD_NOT_FOUND_CODE
from .native_readers import current_cron_execution

logger = logging.getLogger(__name__)

TASK_USES_CHECK_METHOD = "task.uses.check"
TASK_USES_CHECK_TIMEOUT_S = 3.0
TASK_OWNER_SOURCE = "ocuclaw-task"
# #6422: a "See it work" test of a Task Draft is held the same way (task_schedule_management.TEST_SOURCE).
TASK_TEST_SOURCE = "ocuclaw-task-test"
TASK_USES_UNCHECKED_MESSAGE = (
    "not-allowed-for-this-task: OcuClaw could not check what this Task may use, so it skipped "
    "this step. Carry on without it, and say in your answer what you could not do."
)
# A call outside a known Task cron run (an OcuClaw chat) that could not be checked.
TASK_USES_UNCHECKED_STEP_MESSAGE = (
    "not-allowed-for-this-task: OcuClaw could not check this step, so it skipped it. Carry on "
    "without it, and say in your answer what you could not do."
)
TASK_USES_ENDED_MESSAGE = (
    "not-allowed-for-this-task: this run was stopped, so OcuClaw skipped this step. Finish now "
    "without it."
)
_CRON_SESSION = re.compile(r"^cron_(.+)_\d{8}_\d{6}$")
_ARG_TEXT_MAX = 2000
# The relay judges at most this many arguments (hermes-task-uses-check.ts ARGS_MAX); a call with
# more is refused, never judged on the part that fits.
_ARGS_MAX = 32
_ARG_KEY_MAX = 256
_TOOL_NAME_MAX = 256
_ARG_DEPTH_MAX = 32
# DeepSec finding_30a3ac0aa46ae4cb / finding_9dd580591125fb0a: a JS object copy can read this key
# as its prototype, never as data, so an argument holding it at any depth is refused.
_PROTO_KEY = "__proto__"
# DeepSec finding_832486e780ccb4a2: a cut argument keeps the whole text's digest after a NUL
# (never part of a real command), so the relay judges a long command as its exact text, never as
# the prefix that survived the cut (glasses-ui-task-uses.ts TASK_USES_CUT_MARK).
_CUT_MARK = "\x00ocuclaw-cut-sha256:"
_MEMORY_MAX = 1024


def _cut_text(value: str) -> str:
    if len(value) <= _ARG_TEXT_MAX:
        return value
    # JS hashes the UTF-16 string's UTF-8 form: a surrogate pair is its character, a lone
    # surrogate is U+FFFD. Round-tripping through UTF-16 gives Python the same text.
    text = value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return value[:_ARG_TEXT_MAX] + _CUT_MARK + digest


class _Bounded:
    """A thread-safe, size-bounded memory of keys (oldest forgotten first)."""

    def __init__(self, limit: int = _MEMORY_MAX) -> None:
        self._limit = limit
        self._lock = threading.Lock()
        self._items: "OrderedDict[str, Any]" = OrderedDict()

    def put(self, key: str, value: Any = "") -> None:
        with self._lock:
            self._items[key] = value
            self._items.move_to_end(key)
            while len(self._items) > self._limit:
                self._items.popitem(last=False)

    def get(self, key: str) -> Any:
        with self._lock:
            return self._items.get(key)

    def __contains__(self, key: str) -> bool:
        with self._lock:
            return key in self._items


# PR #7647 review: the memories live on a ``sys.modules`` holder, as ``_ADAPTERS`` does
# (adapter.py ``_live_adapter_registry``), so a plugin reload that purges and re-imports the bundle
# in a live gateway keeps them: a run held before stays held.
_MEMORY_HOLDER_MODULE = "_ocuclaw_task_uses_memory"


def _process_memory(name: str) -> Any:
    holder = sys.modules.get(_MEMORY_HOLDER_MODULE)
    if holder is None:
        holder = types.ModuleType(_MEMORY_HOLDER_MODULE)
        sys.modules[_MEMORY_HOLDER_MODULE] = holder
    memory = getattr(holder, name, None)
    if memory is None:
        memory = _Bounded()
        setattr(holder, name, memory)
    return memory


# Sessions this process saw as a Task's cron run: session id -> job id. A run stays one when its
# job record later goes, or cannot be read.
_TASK_RUN_SESSIONS = _process_memory("task_run_sessions")
# The Task (or test) a job was seen to belong to: job id -> (task id, is a test).
_TASK_JOB_OWNERS = _process_memory("task_job_owners")
# Jobs this process removed while their run may still be going (a test's end, a Task's delete).
_ENDED_TASK_JOBS = _process_memory("ended_task_jobs")


def note_task_job_ended(job_id: Any) -> None:
    """A Task's (or a test's) job is gone: every later call of a run it started is refused.

    The removal never stops an agent turn in flight, so the run may go on; the job id stays
    known here for the life of this process, which is the life of any run it started here.
    """
    if isinstance(job_id, str) and job_id:
        _ENDED_TASK_JOBS.put(job_id)



_CRON_ADMISSION = re.compile(r"^cron:([^:]+):[^:]+$")
_CRON_PRINCIPAL = "cron-owner"
# The ``source`` Hermes's scheduler gives a cron fire's session (its agent's ``platform``).
_CRON_SOURCE = "cron"


def _owner_execution_job(session_id: str) -> Optional[str]:
    """The job of the cron fire bound to this context, when its session is ``session_id``."""
    try:
        bound = current_cron_execution()
    except Exception:  # noqa: BLE001 - a Hermes without owner executions
        return None
    if isinstance(bound, tuple) and len(bound) >= 3 and bound[1] == session_id and isinstance(bound[2], str):
        return bound[2]
    return None


def _admitted_cron_job(session_id: str, home: Any = None) -> Optional[str]:
    """The job whose cron fire admitted ``session_id``, read from the profile's ``state.db``."""
    return _admission_lookup(session_id, home)[0]


_NO_STORE = object()
# A store read may wait out a brief lock (a journal_mode=DELETE writer) for this long, inside the
# call's one TASK_USES_CHECK_TIMEOUT_S budget, before the store counts as unreadable.
_STORE_READ_BUDGET_S = 1.0
_STORE_RETRY_S = 0.05


def _store_row(home: Any, sql: str, args: list, deadline: Optional[float] = None) -> Any:
    """One row of the profile's ``state.db``, read-only: the row, None, or ``_NO_STORE`` when the
    profile has no store. Retries a locked or busy read until the deadline; raises past it."""
    if home is None:
        from hermes_constants import get_hermes_home
        home = get_hermes_home()
    db = Path(home) / "state.db"
    if not db.is_file():
        return _NO_STORE
    end = time.monotonic() + _STORE_READ_BUDGET_S
    if deadline is not None:
        end = min(end, deadline)
    uri = db.resolve().as_uri() + "?mode=ro"
    while True:
        wait = max(0.01, min(0.25, end - time.monotonic()))
        try:
            with closing(sqlite3.connect(uri, uri=True, timeout=wait)) as conn:
                return conn.execute(sql, args).fetchone()
        except sqlite3.OperationalError as exc:
            text = str(exc)
            if ("locked" not in text and "busy" not in text) or time.monotonic() + _STORE_RETRY_S >= end:
                raise
            time.sleep(_STORE_RETRY_S)


def _admission_lookup(session_id: str, home: Any = None,
                      deadline: Optional[float] = None) -> "tuple[Optional[str], bool]":
    """``(job id or None, unreadable)``: an absent store or an older one with no admissions
    names no job; a store that exists and cannot be read says ``unreadable``."""
    try:
        row = _store_row(home, "SELECT request_id FROM session_admissions WHERE target_session_id=?"
                         " AND principal_id=? AND request_id LIKE 'cron:%' ORDER BY seq DESC LIMIT 1",
                         [session_id, _CRON_PRINCIPAL], deadline)
        if row is _NO_STORE:
            return None, False
    except ImportError:
        # A host with no profile home to read names no store, and so no admission.
        return None, False
    except sqlite3.OperationalError as exc:
        # An older store has no admissions table: it names no job.
        return None, "no such table" not in str(exc)
    except Exception:  # noqa: BLE001 - an unreadable store
        return None, True
    match = _CRON_ADMISSION.match(row[0]) if row and isinstance(row[0], str) else None
    return (match.group(1) if match else None), False


def task_cron_job_of_session(session_id: str, get_job: Optional[Callable[[str], Any]] = None,
                             home: Any = None) -> Optional[str]:
    """The job id when ``session_id`` is a cron run of a job OcuClaw made for a Task, else None.

    Older Hermes names a cron session ``cron_<jobId>_<YYYYmmdd>_<HHMMSS>``. Newer Hermes runs a
    fire as an owner execution in a ``local-<hex>`` session: its job is the one bound to this
    context, or else the one whose ``cron:<jobId>:<executionId>`` admission made the session.
    """
    job_id = _cron_job_id_of_session(session_id, home)
    if not job_id:
        return None
    return job_id if _job_owner(job_id, get_job) == _OWNER_TASK else None


_OWNER_TASK = "task"
_OWNER_OTHER = "other"
_OWNER_UNKNOWN = "unknown"


def _cron_job_id_of_session(session_id: str, home: Any = None) -> Optional[str]:
    """The cron job whose fire runs ``session_id``, whoever owns it, else None.

    Read from the session's name, its owner-execution binding or its admission: never from the
    job record, which a delete or a test's end removes while its run may still be going.
    """
    sid = str(session_id or "")
    if not sid:
        return None
    match = _CRON_SESSION.match(sid)
    return match.group(1) if match else (_owner_execution_job(sid) or _admitted_cron_job(sid, home))


def _job_owner(job_id: str, get_job: Optional[Callable[[str], Any]] = None) -> str:
    """Whether the job record says OcuClaw made ``job_id`` for a Task (or its test), another owner
    made it, or the record cannot say (gone, unreadable, or a Hermes without cron)."""
    return _job_origin(job_id, get_job)[0]


def _job_origin(job_id: str, get_job: Optional[Callable[[str], Any]] = None) -> "tuple[str, Any]":
    """``(_job_owner's answer, (task id, is a test) when it is a Task's or test's job)``."""
    if get_job is None:
        try:
            from cron.jobs import get_job as hermes_get_job
        except Exception:  # noqa: BLE001 - a Hermes without cron
            return _OWNER_UNKNOWN, None
        get_job = hermes_get_job
    try:
        job = get_job(job_id)
    except Exception:  # noqa: BLE001 - an unreadable job
        return _OWNER_UNKNOWN, None
    if not isinstance(job, dict):
        return _OWNER_UNKNOWN, None
    origin = job.get("origin")
    if (isinstance(origin, dict) and origin.get("source") in (TASK_OWNER_SOURCE, TASK_TEST_SOURCE)
            and isinstance(origin.get("taskId"), str)):
        return _OWNER_TASK, (origin["taskId"], origin.get("source") == TASK_TEST_SOURCE)
    return _OWNER_OTHER, None


def _plain(value: Any, depth: int) -> bool:
    """True when ``value`` is JSON data the relay reads exactly as the host's tool will.

    Never a ``__proto__`` key (a JS copy can take it as a prototype), a non-text key, a number
    JSON cannot carry (the relay's parser drops the whole line), or nesting past the bound.
    """
    if depth > _ARG_DEPTH_MAX:
        return False
    if value is None or isinstance(value, (bool, int, str)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, (list, tuple)):
        return all(_plain(item, depth + 1) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and key != _PROTO_KEY and _plain(item, depth + 1)
                   for key, item in value.items())
    return False


def _projection(args: Any) -> Optional[Dict[str, Any]]:
    """The call's arguments as the relay judges them, or None when they cannot reach it as the
    host's tool will act on them (the call is then refused, never judged on a part of it).

    Long texts are cut with their digest (``_cut_text``); a long list or object goes as its cut
    ``repr``, a text the relay never reads as a read.
    """
    if args is None:
        return {}
    if not isinstance(args, dict) or len(args) > _ARGS_MAX:
        return None
    out: Dict[str, Any] = {}
    for key, value in list(args.items()):
        if not isinstance(key, str) or len(key) > _ARG_KEY_MAX or key == _PROTO_KEY or not _plain(value, 1):
            return None
        if isinstance(value, str):
            out[key] = _cut_text(value)
        elif isinstance(value, (list, tuple, dict)):
            out[key] = value if len(repr(value)) <= _ARG_TEXT_MAX else _cut_text(repr(value))
        else:
            out[key] = value
    return out


def _store_session_row(session_id: str, home: Any = None, deadline: Optional[float] = None) -> Dict[str, Any]:
    """``{session_key, source, parent_session_id}`` of ``session_id`` read from the profile's
    ``state.db`` (with no live adapter to read it); ``{}`` when the store or the row is absent.
    Raises when unreadable."""
    row = _store_row(home, "SELECT session_key, source, parent_session_id FROM sessions WHERE id=?",
                     [session_id], deadline)
    if row is _NO_STORE or not row:
        return {}
    return {"session_key": row[0], "source": row[1], "parent_session_id": row[2]}


def _bound_cron_job() -> Optional[str]:
    """The job of the cron fire bound to this context, whatever its session (a call with none)."""
    try:
        bound = current_cron_execution()
    except Exception:  # noqa: BLE001 - a Hermes without owner executions
        return None
    if isinstance(bound, tuple) and len(bound) >= 3 and isinstance(bound[2], str) and bound[2]:
        return bound[2]
    return None


def _block(message: str) -> Dict[str, str]:
    return {"action": "block", "message": message}


_ANCESTOR_HOPS_MAX = 16
# session_rpc.py SessionRpcRouter._ambient_rpc: the hook ran in a profile OcuClaw does not serve
# (admitted or draining). No OcuClaw chat or Task job lives there.
_UNSERVED_PROFILE = "ambient Hermes profile DB is not served"
_LINK_POLL_S = 0.05


def _named_cron_job(session_id: str, home: Any, deadline: Optional[float] = None) -> "tuple[Optional[str], bool]":
    """``(job, unreadable)``: the job ``session_id``'s name, owner-execution binding or admission
    names; ``unreadable`` when the admission could not be read (DeepSec review: held, not None)."""
    match = _CRON_SESSION.match(session_id)
    if match:
        return match.group(1), False
    bound = _owner_execution_job(session_id)
    if bound:
        return bound, False
    return _admission_lookup(session_id, home, deadline=deadline)


def _ancestors(row: Dict[str, Any], read_row: Callable[[str], Dict[str, Any]]):
    """``(session id, row)`` of each session this one was compressed from (``parent_session_id``)."""
    seen = set()
    parent = str(row.get("parent_session_id") or "")
    while parent and parent not in seen and len(seen) < _ANCESTOR_HOPS_MAX:
        seen.add(parent)
        parent_row = read_row(parent)
        yield parent, parent_row
        parent = str(parent_row.get("parent_session_id") or "")


def _ancestor_cron_job(row: Dict[str, Any], read_row: Callable[[str], Dict[str, Any]], home: Any,
                       deadline: Optional[float] = None) -> "tuple[Optional[str], bool]":
    """``(job, unreadable)`` named by a session this one was compressed from."""
    for parent, _parent_row in _ancestors(row, read_row):
        job_id = _TASK_RUN_SESSIONS.get(parent)
        if job_id:
            return job_id, False
        job_id, unreadable = _named_cron_job(parent, home, deadline)
        if job_id or unreadable:
            return job_id, unreadable
    return None, False


def _cron_turn(job_id: str, session_id: str, get_job: Optional[Callable[[str], Any]],
               known: bool = False) -> Any:
    """``{"cronJobId", "ownerTaskId"?, "ownerTest"?}`` for a cron run of ``job_id`` the relay must
    judge, a block directive for a run this process ended, or None when the job record names
    another owner. The owner, when this process knows it, rides along (add-only request fields):
    the child refuses a Task's or test's job it cannot place."""
    if job_id in _ENDED_TASK_JOBS:
        return _block(TASK_USES_ENDED_MESSAGE)
    owner = _TASK_JOB_OWNERS.get(job_id)
    if owner is None and not known:
        kind, owner = _job_origin(job_id, get_job)
        if kind == _OWNER_OTHER:
            return None
        if kind == _OWNER_TASK:
            _TASK_JOB_OWNERS.put(job_id, owner)
    if owner is not None and session_id:
        _TASK_RUN_SESSIONS.put(session_id, job_id)
    # A record that is gone or cannot be read is not another owner's: a stopped test's, or a
    # deleted or replaced Task's, run may still be going. A test's, the relay holds to reads; a
    # Task's job this process removed is held above (note_task_job_ended).
    turn: Dict[str, Any] = {"cronJobId": job_id}
    if isinstance(owner, tuple) and len(owner) == 2:
        turn["ownerTaskId"], turn["ownerTest"] = owner[0], owner[1] is True
    return turn


def _task_turn(session_id: str, row_by_id: Optional[Callable[[str], Any]], platform: str,
               get_job: Optional[Callable[[str], Any]], home: Any, has_adapter: bool = True,
               deadline: Optional[float] = None) -> Any:
    """What the relay must judge this call as: ``{"cronJobId", …}`` (a Task's cron run, its record
    gone or unreadable included), ``{"nativeSessionKey", "source"?}`` (an OcuClaw chat), a block
    directive (a run this process ended, or one that cannot be placed), or None (positively not a
    Task run)."""
    job_id = _TASK_RUN_SESSIONS.get(session_id) if session_id else None
    if job_id is not None:
        return _cron_turn(job_id, session_id, get_job, known=True)
    if not session_id:
        job_id = _bound_cron_job()
        return _cron_turn(job_id, session_id, get_job) if job_id else None
    match = _CRON_SESSION.match(session_id)
    job_id = match.group(1) if match else _owner_execution_job(session_id)
    if job_id:
        return _cron_turn(job_id, session_id, get_job)
    if not has_adapter:
        # PR #7647 review: no OcuClaw adapter was ever registered in this process (a `hermes`
        # CLI chat or TUI), so no OcuClaw chat or glasses-launched run can live here: only a cron
        # fire bound to this context (`hermes cron run`) can be a Task's. The store is not read.
        job_id = _bound_cron_job()
        return _cron_turn(job_id, session_id, get_job) if job_id else None
    job_id, unreadable = _admission_lookup(session_id, home, deadline=deadline)
    if job_id:
        return _cron_turn(job_id, session_id, get_job)

    def read_row(sid: str) -> Dict[str, Any]:
        row = row_by_id(sid) if row_by_id is not None else _store_session_row(sid, home, deadline)
        return row if isinstance(row, dict) else {}

    try:
        row = read_row(session_id)
    except RuntimeError as exc:
        if str(exc).startswith(_UNSERVED_PROFILE):
            # PR #7647 review: a session on a profile OcuClaw does not serve is positively not an
            # OcuClaw chat, and no Task job is made there.
            return None
        raise
    source = str(row.get("source") or "")
    native_key = str(row.get("session_key") or "")
    ocuclaw_key = f":{platform}:" in f":{native_key}:"
    if source == _CRON_SOURCE:
        # A cron fire's session its name and admission no longer name: Hermes gives a run a new
        # session id when it compresses its context. The fire bound to this context, or the
        # session it was compressed from, names the job; a cron session none names is held.
        job_id = _bound_cron_job()
        if not job_id:
            job_id, _unreadable = _ancestor_cron_job(row, read_row, home, deadline)
        return _cron_turn(job_id, session_id, get_job) if job_id else _block(TASK_USES_UNCHECKED_MESSAGE)
    if unreadable and not ocuclaw_key and (not source or source == platform):
        # The admission that would name a cron fire could not be read, and the row does not
        # positively name another platform: held.
        return _block(TASK_USES_UNCHECKED_MESSAGE)
    if not ocuclaw_key and source == platform:
        # PR #7647 review: an OcuClaw session compressed into a new one carries no session key
        # until its turn returns; the session it came from names the chat the relay matches.
        native_key = next((str(parent_row.get("session_key") or "") for _p, parent_row in _ancestors(row, read_row)
                           if f":{platform}:" in f":{parent_row.get('session_key') or ''}:"), "")
        if not native_key:
            return _block(TASK_USES_UNCHECKED_STEP_MESSAGE)
    elif not ocuclaw_key:
        return None
    turn: Dict[str, Any] = {"nativeSessionKey": native_key}
    if source:
        turn["source"] = source
    return turn


def ready_link_request(pick: Callable[[], Optional[Callable[..., Any]]], method: str, params: Any, *,
                       timeout_s: float) -> Any:
    """``method`` asked over a ready link, waiting inside ``timeout_s`` for one (PR #7647 review).

    ``pick()`` names the request of an adapter whose child is ready, or None. A child just
    started, restarted or reconnected may not have registered the method yet: a "method not
    found" answer is asked once more. Raises TimeoutError when no ready link answers in time.
    """
    deadline = time.monotonic() + max(0.0, float(timeout_s or 0))
    retried = False
    while True:
        requester = pick()
        remaining = deadline - time.monotonic()
        if requester is not None and remaining > 0:
            try:
                return requester(method, params, timeout_s=remaining)
            except Exception as exc:  # noqa: BLE001 - only "method not found" is asked again
                if getattr(exc, "code", None) != RPC_METHOD_NOT_FOUND_CODE or retried:
                    raise
                retried = True
        if time.monotonic() + _LINK_POLL_S >= deadline:
            raise TimeoutError(f"{method}: no ready control link within {timeout_s:.1f}s")
        time.sleep(_LINK_POLL_S)


def unchecked_directive() -> Dict[str, str]:
    """The block for a call the hook could not even place (a raise around it)."""
    return _block(TASK_USES_UNCHECKED_STEP_MESSAGE)


def task_uses_block(
    kwargs: Dict[str, Any],
    *,
    request: Optional[Callable[..., Any]],
    row_by_id: Optional[Callable[[str], Any]],
    platform: str,
    mcp_of: Optional[Callable[[str], Any]] = None,
    get_job: Optional[Callable[[str], Any]] = None,
    home: Any = None,
    has_adapter: bool = True,
) -> Optional[Dict[str, str]]:
    """A ``pre_tool_call`` block directive for a step the Task run may not take, else None.

    ``request(method, params, timeout_s=)`` is the adapter's thread-safe link
    request (None when no adapter is live), ``row_by_id`` its session reader,
    ``has_adapter`` False when no OcuClaw adapter was ever registered in this
    process. None only for a call positively not part of a Task run, or one the
    relay explicitly allowed (``{"block": false}``); never raises. Store reads
    and the link share one ``TASK_USES_CHECK_TIMEOUT_S`` budget.
    """
    deadline = time.monotonic() + TASK_USES_CHECK_TIMEOUT_S
    tool_name = str(kwargs.get("tool_name") or "").strip()
    if not tool_name:
        return None
    session_id = str(kwargs.get("session_id") or "").strip()
    try:
        turn = _task_turn(session_id, row_by_id, platform, get_job, home, has_adapter, deadline)
    except Exception as exc:  # noqa: BLE001 - a session this cannot place may be a Task run
        logger.warning("[ocuclaw] task uses check could not place the session (%s)", type(exc).__name__)
        return _block(TASK_USES_UNCHECKED_STEP_MESSAGE)
    if turn is None or turn.get("action") == "block":
        return turn
    unchecked = TASK_USES_UNCHECKED_MESSAGE if "cronJobId" in turn else TASK_USES_UNCHECKED_STEP_MESSAGE
    try:
        return _checked(turn, tool_name, session_id, kwargs.get("args"), request, mcp_of, unchecked, deadline)
    except Exception as exc:  # noqa: BLE001 - a Task run's call that cannot be checked is refused
        logger.warning("[ocuclaw] task uses check failed (%s)", type(exc).__name__)
        return _block(unchecked)


def _checked(turn: Dict[str, Any], tool_name: str, session_id: str, args: Any,
             request: Optional[Callable[..., Any]], mcp_of: Optional[Callable[[str], Any]],
             unchecked: str, deadline: float) -> Optional[Dict[str, str]]:
    projected = _projection(args)
    if projected is None or len(tool_name) > _TOOL_NAME_MAX:
        logger.info("[ocuclaw] task run step %s skipped: its arguments cannot be checked", tool_name[:64])
        return _block(unchecked)
    if request is None:
        return _block(unchecked)
    params: Dict[str, Any] = {"toolName": tool_name, "args": projected, "sessionId": session_id, **turn}
    if mcp_of is not None and tool_name.startswith("mcp_"):
        try:
            mcp = mcp_of(tool_name)
        except Exception:  # noqa: BLE001 - no hints: the step asks
            mcp = None
        if mcp:
            params["mcp"] = mcp
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return _block(unchecked)
    reply = request(TASK_USES_CHECK_METHOD, params, timeout_s=remaining)
    block = reply.get("block") if isinstance(reply, dict) else None
    if block is False:
        return None
    if block is True:
        reason = str(reply.get("reason") or "").strip() or unchecked
        logger.info("[ocuclaw] task run step %s skipped", tool_name[:64])
        return _block(reason[:1000])
    logger.warning("[ocuclaw] task uses check gave no verdict")
    return _block(unchecked)
