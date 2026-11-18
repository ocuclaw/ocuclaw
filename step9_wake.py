"""Step 9 on Hermes, hands-off: a waiter that wakes the setup chat.

OpenClaw's relay wakes the setup chat once the wearer's first glasses message
is in, so the agent ends its turn on step 9's lines. Hermes has no such wake,
and the call that waited inside ``next`` left a real model silent for the whole
window (runs 42582562511, 42594298253, 42602344883: Claude chained the
waiting calls without relaying the lines that tell the wearer to send).

So the call that arms step 9 starts
``hermes ocuclaw step9-wait`` as a Hermes background process with
``notify_on_complete``, and answers ``then: end_turn``. The agent ends its turn
on the lines, which a model relays reliably in a turn's last message. The
waiter holds the phone's "send a message" hint, waits for the wearer's phone
turn and the glasses receipt for its reply, then exits with an
``[ocuclaw setup wake]`` line. Hermes turns that completion into a new turn in
the same chat (the WebUI's ``process_wakeup``), and that turn's ``next`` arms
the proof and moves on. The waiter never arms anything itself: ``next`` stays
the only place that does.

Any part that is not there (an older Hermes, an approval the turn cannot
grant, notifications switched off) falls back to the waiting ``next`` call.
So does a chat Hermes cannot wake: its terminal tool answers
``notify_on_complete: false`` for a one-shot run, a cron job, a stateless API
request or a subagent, and only a ``true`` keeps the waiter.
"""

from __future__ import annotations

import inspect
import json
import logging
import shlex
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional, TextIO

logger = logging.getLogger(__name__)

#: The same marker OpenClaw's relay wake carries (the skill and the e2e agent read it).
WAKE_HEADER = "[ocuclaw setup wake]"
WAKE_LINE_IN = (
    f"{WAKE_HEADER} The message from the glasses is in. Call ocuclaw_setup with "
    '{"operation":"next"} now and relay its lines.'
)
WAKE_LINE_TIMEOUT = (
    f"{WAKE_HEADER} No message from the glasses arrived in time. Call ocuclaw_setup "
    'with {"operation":"next"} now and relay its lines.'
)
#: One wait slice: the phone hint's TTL is 180 s, so it is refreshed each slice.
WAIT_SLICE_S = 60.0
#: After the phone turn, how long the waiter gives the phone's glasses receipt,
#: so the woken ``next`` finds it in place (``NEXT_REPLY_RECEIPT_WAIT_S``).
RECEIPT_WAIT_S = 40.0
#: A receipt that cannot be read yet (a write in progress) is read again after this.
UNSETTLED_RETRY_S = 2.0


def wake_command(home: Optional[Path], since: float, deadline: float) -> str:
    """The fixed command the background process runs. Bare ``hermes``: Hermes
    puts its own install folder first on a child's PATH, and the plugin's own
    Python path is stripped there, so ``python -m`` forms would not import."""
    argv = ["hermes", "ocuclaw", "step9-wait", "--since", f"{since:.3f}", "--deadline", f"{deadline:.3f}"]
    if home is not None:
        argv[3:3] = ["--home", str(home)]
    return shlex.join(argv)


def run_step9_wait(
    *,
    home: Optional[Path],
    since: float,
    deadline: float,
    out: TextIO = sys.stdout,
    now_fn: Callable[[], float] = time.time,
    sleep_fn: Callable[[float], None] = time.sleep,
    wait_candidate: Optional[Callable[..., Dict[str, Any]]] = None,
    wait_delivery: Optional[Callable[..., Dict[str, Any]]] = None,
    hint: Optional[Callable[..., Any]] = None,
) -> int:
    """Wait for the wearer's first phone turn at or after ``since`` until
    ``deadline`` (epoch seconds), then for its glasses receipt; print the wake
    line and return 0. Reads only; never arms the proof."""
    if wait_candidate is None or wait_delivery is None:
        from .first_run import wait_for_phone_turn_candidate, wait_for_reply_delivery

        wait_candidate = wait_candidate or wait_for_phone_turn_candidate
        wait_delivery = wait_delivery or wait_for_reply_delivery
    if hint is None:
        from .setup_hint import awaiting_first_reply

        hint = awaiting_first_reply
    not_before = datetime.fromtimestamp(since, tz=timezone.utc)
    candidate: Dict[str, Any] = {}
    with hint(home=home) as refresh:
        while True:
            left = deadline - now_fn()
            if left <= 0:
                break
            candidate = dict(wait_candidate(home=home, not_before=not_before, timeout_seconds=min(WAIT_SLICE_S, left)))
            if candidate.get("received") is True:
                break
            if candidate.get("state") != "timeout":
                # unavailable / unreadable / malformed / wrong_profile can be a
                # write in progress: read again until the deadline.
                sleep_fn(min(UNSETTLED_RETRY_S, max(0.0, deadline - now_fn())))
            refresh()
    candidate_id = candidate.get("candidateId")
    if candidate.get("received") is True and isinstance(candidate_id, str):
        if not candidate.get("runErrorCode"):
            try:
                wait_delivery(home=home, candidate_id=candidate_id, timeout_seconds=RECEIPT_WAIT_S)
            except Exception:  # noqa: BLE001 - the woken next reads the receipt itself
                logger.debug("[ocuclaw] step9-wait: receipt wait failed", exc_info=True)
        out.write(WAKE_LINE_IN + "\n")
    else:
        out.write(WAKE_LINE_TIMEOUT + "\n")
    out.flush()
    return 0


# -- the live pieces (inside the Hermes process) --------------------------------


def start_wake(task_id: Optional[str], home: Optional[Path], since: float, deadline: float) -> Optional[str]:
    """Start the waiter as a Hermes background process that wakes this chat
    when it exits. Returns its process id, or None when this Hermes cannot
    (the caller then keeps the waiting ``next`` call)."""
    if not task_id:
        return None
    try:
        from tools.terminal_tool import terminal_tool  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 - an older or different Hermes
        return None
    params = inspect.signature(terminal_tool).parameters
    needed = ("background", "notify_on_complete", "task_id", "_host_local")
    if not all(name in params for name in needed):
        return None
    if not _notifications_on():
        return None
    kwargs: Dict[str, Any] = {
        "background": True,
        "notify_on_complete": True,
        "task_id": task_id,
        "_host_local": True,
    }
    # Kept across the agent's own lifecycle cleanup (the turn ends right after).
    if "persist_on_release" in params:
        kwargs["persist_on_release"] = True
    try:
        raw = terminal_tool(wake_command(home, since, deadline), **kwargs)
        parsed = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
    except Exception:  # noqa: BLE001 - never fail the setup call over the wake
        logger.warning("[ocuclaw] step 9 wake could not start", exc_info=True)
        return None
    if parsed.get("error") or parsed.get("status") == "pending_approval":
        logger.info("[ocuclaw] step 9 wake not started: %s", parsed.get("error") or parsed.get("status"))
        return None
    proc = parsed.get("session_id")
    if not isinstance(proc, str) or not proc:
        return None
    if parsed.get("notify_on_complete") is not True:
        # Hermes started it and says this chat cannot be woken when it exits (a
        # one-shot run, a cron job, a stateless API request, a subagent). That
        # is Hermes's own answer, so the waiting ``next`` call stays.
        logger.info("[ocuclaw] step 9 wake not kept: this chat takes no completion notice")
        _stop_waiter(proc)
        return None
    for old in [known for known in _KEPT_FOR if not wake_running(known)]:
        del _KEPT_FOR[old]
    _KEPT_FOR[proc] = task_id
    return proc


def _stop_waiter(proc_id: str) -> None:
    """End a waiter nothing will hear. Best effort: left alone, it exits by
    its own deadline."""
    try:
        from tools.process_registry import process_registry  # type: ignore[import-not-found]

        process_registry.kill_process(proc_id)
    except Exception:  # noqa: BLE001
        logger.debug("[ocuclaw] step 9 wake: waiter not stopped", exc_info=True)


#: Each kept waiter's chat (its tool call's task id): the only chat it wakes.
_KEPT_FOR: Dict[str, str] = {}


def wake_running(proc_id: Optional[str], task_id: Optional[str] = None) -> bool:
    """Whether the waiter still runs. With ``task_id``: and it is that chat's
    own. A waiter wakes the chat that started it and no other, so a new chat
    that asks during step 9 must not end its turn on it (Hermes drops the
    notice outright once the first chat is closed)."""
    if not proc_id:
        return False
    if task_id is not None and _KEPT_FOR.get(proc_id) != task_id:
        return False
    try:
        from tools.process_registry import process_registry  # type: ignore[import-not-found]

        session = process_registry.get(proc_id)
    except Exception:  # noqa: BLE001
        return False
    return session is not None and not bool(getattr(session, "exited", True))


def _notifications_on() -> bool:
    """``display.background_process_notifications: off`` drops the completion
    that would wake the chat."""
    try:
        from hermes_cli.config import load_config  # type: ignore[import-not-found]

        display = (load_config() or {}).get("display") or {}
        mode = display.get("background_process_notifications") if isinstance(display, dict) else None
    except Exception:  # noqa: BLE001 - unreadable reads as the default (on)
        return True
    return str(mode).strip().lower() not in ("off", "false", "0") if mode is not None else True
