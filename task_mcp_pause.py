"""#6679: a Task run never inherits another run's MCP server pause on Hermes.

Hermes counts failed calls per MCP server for the whole profile (``tools.mcp_tool``
``_server_error_counts``). After 3 in a row it pauses that server for about 60 s for every
session and job: its guard against a model looping on a broken tool. So one Task whose tool kept
failing paused the server for a different Task that ran next, and that run ended Done blaming
its own tool ("chaos_slow was blocked after 3 rejected calls"). OpenClaw has no shared pause: the
next Task simply calls its tool. This gives each Task run the guard to itself, with Hermes's own
numbers, so both hosts behave the same:

- ``post_tool_call`` counts the run's own failed MCP calls per server. An answer clears the count,
  as Hermes's own count does.
- ``pre_tool_call``, on a Task run's MCP call: when the run itself failed that server ``threshold``
  times in a row and the cooldown has not run out, the call is blocked here with Hermes's advice.
  Otherwise, when Hermes's shared pause is open for that server, the failures were other runs',
  so the pause is closed with Hermes's own ``_reset_server_error`` and this call reaches the
  server. The run that failed keeps its own pause from its own count.

A Task run is a cron run of a job OcuClaw made for a Task, a See it work test included
(``task_uses_hook.task_cron_job_of_session``). Chats and other cron jobs keep Hermes's shared pause
unchanged. Hermes has no public API for the pause, so its MCP client's state is read through
``tools.mcp_tool_common._core`` behind a shape check (the ledgers ``card_mcp`` already reads). A
missing or reshaped piece leaves every call to Hermes, as before.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .task_uses_hook import task_cron_job_of_session

logger = logging.getLogger(__name__)

# Hermes's numbers (tools/mcp_tool.py), used only when its own can't be read.
DEFAULT_THRESHOLD = 3
DEFAULT_COOLDOWN_S = 60.0
_MAX_RUNS = 256
_MAX_PENDING = 64

OWN_PAUSE_MESSAGE = (
    "MCP server '{server}' failed the last {failures} calls in this run. Paused for ~{retry}s. "
    "Do NOT repeat the same call: fix the arguments or target, or use a different approach, and "
    "say in your answer what you could not check."
)

# Hermes's own refusals that never reached the server, so they are no strike (mcp_tool_handlers.py
# ``_check_circuit_breaker``): a call another session's pause refused in a race.
_REFUSAL_MARKS = ("rejected the last", "is unreachable after")


@dataclass
class Breaker:
    """Hermes's shared per-server pause, as this module reads and closes it."""

    resolve: Callable[[str], Any]
    counts: Dict[Any, int]
    opened_at: Dict[Any, float]
    reset: Callable[[str], None]
    threshold: int = DEFAULT_THRESHOLD
    cooldown_s: float = DEFAULT_COOLDOWN_S

    def is_open(self, server: str, now: float) -> bool:
        key = self.resolve(server)
        if self.counts.get(key, 0) < self.threshold:
            return False
        return now - self.opened_at.get(key, 0.0) < self.cooldown_s


def hermes_breaker() -> Optional[Breaker]:
    """Hermes's MCP pause, or None when this Hermes doesn't have the shape this module knows."""
    try:
        from tools.mcp_tool_common import _core
        from tools.mcp_tool_scope import _resolve_server_key
    except Exception:  # noqa: BLE001 - an older or newer Hermes
        return None
    try:
        counts = _core._server_error_counts
        opened_at = _core._server_breaker_opened_at
        reset = _core._reset_server_error
        threshold = getattr(_core, "_CIRCUIT_BREAKER_THRESHOLD", DEFAULT_THRESHOLD)
        cooldown = getattr(_core, "_CIRCUIT_BREAKER_COOLDOWN_SEC", DEFAULT_COOLDOWN_S)
    except Exception:  # noqa: BLE001 - renamed or moved ledgers
        return None
    if not isinstance(counts, dict) or not isinstance(opened_at, dict):
        return None
    if not callable(reset) or not callable(_resolve_server_key):
        return None
    if not isinstance(threshold, int) or isinstance(threshold, bool) or threshold < 1:
        return None
    if not isinstance(cooldown, (int, float)) or isinstance(cooldown, bool) or cooldown <= 0:
        return None
    return Breaker(_resolve_server_key, counts, opened_at, reset, threshold, float(cooldown))


@dataclass
class _Run:
    job_id: Optional[str]
    # server -> [failures in a row, monotonic time the run's own pause opened]
    servers: Dict[str, List[float]] = field(default_factory=dict)
    # tool call -> server, for calls this module let through and has not seen answered
    pending: "OrderedDict[str, str]" = field(default_factory=OrderedDict)

    def let_through(self, call: str, server: str) -> None:
        """Remember a call this module let reach the server, until its answer comes back."""
        self.pending[call] = server
        while len(self.pending) > _MAX_PENDING:
            self.pending.popitem(last=False)


class TaskMcpPause:
    """Per-Task-run MCP pauses. One per process; thread-safe."""

    def __init__(self, *, breaker: Callable[[], Optional[Breaker]] = hermes_breaker,
                 job_of: Callable[[str], Optional[str]] = task_cron_job_of_session,
                 clock: Callable[[], float] = time.monotonic):
        self._breaker = breaker
        self._job_of = job_of
        self._clock = clock
        self._lock = threading.Lock()
        self._runs: "OrderedDict[str, _Run]" = OrderedDict()

    def _run(self, session_id: str) -> Optional[_Run]:
        """The session's run state when it is a Task run, else None. Looked up once per session."""
        with self._lock:
            if session_id in self._runs:
                self._runs.move_to_end(session_id)
                run = self._runs[session_id]
                return run if run.job_id else None
        try:
            job_id = self._job_of(session_id)
        except Exception:  # noqa: BLE001 - an unreadable job owns no Task
            job_id = None
        with self._lock:
            run = self._runs.setdefault(session_id, _Run(job_id if isinstance(job_id, str) else None))
            while len(self._runs) > _MAX_RUNS:
                self._runs.popitem(last=False)
        return run if run.job_id else None

    def before_call(self, kwargs: Dict[str, Any], mcp_of: Callable[[str], Any]) -> Optional[Dict[str, str]]:
        """``pre_tool_call``: a block directive for a call this run's own pause holds, else None."""
        tool_name = str(kwargs.get("tool_name") or "").strip()
        session_id = str(kwargs.get("session_id") or "").strip()
        if not tool_name.startswith("mcp_") or not session_id:
            return None
        run = self._run(session_id)
        if run is None:
            return None
        try:
            mcp = mcp_of(tool_name)
        except Exception:  # noqa: BLE001 - not one of the owner's servers
            mcp = None
        server = mcp.get("server") if isinstance(mcp, dict) else None
        if not isinstance(server, str) or not server:
            return None
        breaker = self._breaker()
        if breaker is None:
            return None
        now = self._clock()
        with self._lock:
            own = run.servers.get(server)
            if own and own[0] >= breaker.threshold and now - own[1] < breaker.cooldown_s:
                retry = max(1, int(breaker.cooldown_s - (now - own[1])))
                return {"action": "block", "message": OWN_PAUSE_MESSAGE.format(
                    server=server, failures=int(own[0]), retry=retry)}
            run.let_through(_call_key(kwargs), server)
        try:
            if breaker.is_open(server, now):
                breaker.reset(server)
                logger.info("[ocuclaw] task run %s: closed Hermes's pause on MCP server %s "
                            "(other runs' errors)", run.job_id, server)
        except Exception:  # noqa: BLE001 - leave the call to Hermes's own pause
            logger.warning("[ocuclaw] task run MCP pause check failed for %s", server)
        return None

    def after_call(self, kwargs: Dict[str, Any]) -> None:
        """``post_tool_call``: count or clear this run's failures on the call's server."""
        session_id = str(kwargs.get("session_id") or "").strip()
        if not session_id:
            return
        with self._lock:
            run = self._runs.get(session_id)
            server = run.pending.pop(_call_key(kwargs), None) if run is not None else None
        if run is None or server is None:
            return
        failed = _failed(kwargs)
        if failed is None:
            return
        breaker = self._breaker()
        threshold = breaker.threshold if breaker is not None else DEFAULT_THRESHOLD
        now = self._clock()
        with self._lock:
            own = run.servers.setdefault(server, [0, 0.0])
            if failed:
                own[0] += 1
                if own[0] >= threshold:
                    own[1] = now
            else:
                own[0], own[1] = 0, 0.0


def _call_key(kwargs: Dict[str, Any]) -> str:
    call_id = str(kwargs.get("tool_call_id") or "").strip()
    return call_id or f"tool:{kwargs.get('tool_name') or ''}"


def _failed(kwargs: Dict[str, Any]) -> Optional[bool]:
    """True for a strike, False for an answer, None for a refusal that never reached the server.

    Hermes's own rule (``_result_is_error``): a JSON payload with an ``error`` key failed.
    """
    result = kwargs.get("result")
    payload: Any = result
    if isinstance(result, str):
        try:
            payload = json.loads(result)
        except (TypeError, ValueError):
            return False
    if not isinstance(payload, dict) or "error" not in payload:
        return False
    error = payload.get("error")
    if isinstance(error, str) and error.startswith("MCP server '") and any(m in error for m in _REFUSAL_MARKS):
        return None
    return True


TASK_MCP_PAUSE = TaskMcpPause()
