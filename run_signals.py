"""Run signals for the status lens: the ``runSignal`` backend event.

Four live spans beside the tool and reasoning frames: model calls, context
compaction, subagents and retry waits. This module is Hermes-free span
bookkeeping. The adapter resolves which OcuClaw run a hook belongs to (the
same routing its tool and reasoning frames use) and hands that run here; this
module turns the hook's kwargs into payloads and pairs every end with the
start it opened. PROTOCOL.md "Run signals (`runSignal`)" is the contract.

Everything here runs on Hermes's hook threads, ``pre_api_request`` before
every main-loop model call, so each method is a few dict operations under one
lock and never raises on a malformed payload.
"""

from __future__ import annotations

from collections import OrderedDict
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

RUN_SIGNAL_EVENT = "runSignal"

MODEL_CALL = "model_call"
COMPACTION = "compaction"
SUBAGENT = "subagent"
RETRY_WAIT = "retry_wait"

# The context compressor's summary calls (agent/context_compressor.py and
# agent/micro_compaction.py pass task="compression"). The auxiliary hooks fire
# for every auxiliary task on the gateway; all others are ignored.
COMPACTION_AUX_TASK = "compression"

# api_request_error reasons whose ordinary recovery is a backoff sleep before
# the next attempt: turn_api_error.settle_unrecovered_error ->
# compute_error_backoff, and turn_response_check.retry_invalid_response ->
# jittered_backoff ("invalid_response" is that site's own reason string).
# Every other reason is repaired and retried at once (image shrink, format
# strips, credential refresh), compressed (overflow family) or ends in a
# fallback or a terminal error; a wait never follows it.
RETRY_WAIT_REASONS = frozenset(
    {
        "rate_limit",
        "upstream_rate_limit",
        "overloaded",
        "server_error",
        "timeout",
        "unknown",
        "invalid_response",
    }
)

# subagent_stop child_status (the entry status tools/delegate_tool_child_run.py
# and tools/delegate_tool.py write) -> the lens's outcome words.
SUBAGENT_OUTCOMES = {
    "completed": "ok",
    "failed": "error",
    "error": "error",
    "timeout": "timeout",
    "interrupted": "killed",
}

# Open spans and model-call attempt counters each keep at most this many
# entries; the oldest goes first. A span lost that way still ends on the relay
# when its run ends.
MAX_TRACKED = 512


def _text(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""
    return str(value).strip()


def _count(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def subagent_outcome(child_status: Any) -> str:
    return SUBAGENT_OUTCOMES.get(_text(child_status).lower(), "unknown")


def _model_call_request(kwargs: Mapping[str, Any]) -> str:
    """The logical call an attempt belongs to.

    Hermes mints ``api_request_id`` once per call (``<turn_id>:api:<n>``,
    agent/conversation_loop.py) and every retry of that call reuses it. The
    fallback rebuilds the same shape from fields all three hooks carry.
    """
    request = _text(kwargs.get("api_request_id"))
    if request:
        return request
    count = _count(kwargs.get("api_call_count"))
    if count is None:
        return ""
    turn = _text(kwargs.get("turn_id"))
    return f"{turn}:api:{count}" if turn else f"api:{count}"


def model_call_request(kwargs: Mapping[str, Any]) -> str:
    """The logical call a hook's attempt belongs to ("" when unknown)."""
    return _model_call_request(kwargs)


def model_call_iteration(kwargs: Mapping[str, Any]) -> Optional[int]:
    """The turn's 1-based model-call counter a hook carries, if any.

    ``pre_api_request`` and ``post_api_request`` spell it ``api_call_count``;
    the stream hooks spell the same counter ``iteration``
    (agent/stream_delivery.py ``_stream_hook_base_payload``).
    """
    count = _count(kwargs.get("api_call_count"))
    if count is None:
        count = _count(kwargs.get("iteration"))
    return count if count is not None and count > 0 else None


def _compaction_span_id(kwargs: Mapping[str, Any]) -> str:
    """One span per provider attempt; pre and post carry the same base.

    ``api_request_id`` is the auxiliary call's own ``aux-<uuid>`` and
    ``retry_count`` its 0-based attempt (agent/auxiliary_client.py
    ``_relay_auxiliary_metadata``), so the pair is unique per attempt.
    """
    attempt = (_count(kwargs.get("retry_count")) or 0) + 1
    request = _text(kwargs.get("api_request_id"))
    if not request:
        started = kwargs.get("started_at")
        if isinstance(started, bool) or not isinstance(started, (int, float)):
            return ""
        request = f"compaction:{_text(kwargs.get('turn_id'))}:{int(started * 1000)}"
    return request if attempt == 1 else f"{request}#{attempt}"


def _frame(
    signal: str,
    phase: str,
    session_key: str,
    run_id: Optional[str],
    span_id: str,
    at_ms: int,
) -> Dict[str, Any]:
    frame: Dict[str, Any] = {
        "signal": signal,
        "phase": phase,
        "sessionKey": session_key,
    }
    if run_id:
        frame["runId"] = run_id
    frame["spanId"] = span_id
    frame["atMs"] = at_ms
    return frame


def _end_of(start: Mapping[str, Any], outcome: str, at_ms: int) -> Dict[str, Any]:
    frame = _frame(
        start["signal"],
        "end",
        start["sessionKey"],
        start.get("runId"),
        start["spanId"],
        at_ms,
    )
    frame["outcome"] = outcome
    return frame


def _retry_wait(
    kwargs: Mapping[str, Any], failed: Mapping[str, Any], at_ms: int
) -> Optional[Dict[str, Any]]:
    """The wait that follows a failed attempt, when the engine will back off.

    ``retry_count`` is the failed attempt's 0-based index and ``max_retries``
    the attempt budget (agent.api_max_retries, minimum 1; the retry loop runs
    while ``retry_count < max_retries``). The engine adds one after the hook
    and backs off only while attempts remain, so the wait leads to attempt
    ``retry_count + 2`` of ``max_retries``. Hermes reports no wait time to
    plugins, so the frame never carries one.
    """
    if kwargs.get("retryable") is not True:
        return None
    reason = _text(kwargs.get("reason")).lower()
    if reason not in RETRY_WAIT_REASONS:
        return None
    retry_count = _count(kwargs.get("retry_count"))
    max_retries = _count(kwargs.get("max_retries"))
    if retry_count is None or max_retries is None or retry_count + 1 >= max_retries:
        return None
    wait = _frame(
        RETRY_WAIT,
        "start",
        failed["sessionKey"],
        failed.get("runId"),
        f"{failed['spanId']}:wait",
        at_ms,
    )
    wait["reason"] = reason
    wait["attempt"] = retry_count + 2
    wait["maxAttempts"] = max_retries
    return wait


class RunSignalSpans:
    """Open run-signal spans, keyed by the host's own ids. Thread-safe."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.time,
        max_tracked: int = MAX_TRACKED,
    ) -> None:
        self._clock = clock
        self._max_tracked = max(1, int(max_tracked))
        self._lock = threading.Lock()
        # (signal, host ids...) -> the start payload of a compaction or
        # subagent span still open.
        self._open: "OrderedDict[Tuple[str, ...], Dict[str, Any]]" = OrderedDict()
        # session_id -> (logical call, start payload) of the session's open
        # model-call attempt. An agent makes one main-loop call at a time.
        self._model_calls: "OrderedDict[str, Tuple[str, Dict[str, Any]]]" = OrderedDict()
        # (session_id, logical call) -> physical attempts seen for that call.
        self._attempts: "OrderedDict[Tuple[str, str], int]" = OrderedDict()

    def _now_ms(self) -> int:
        return int(self._clock() * 1000)

    def _trim(self, table: "OrderedDict[Any, Any]") -> None:
        while len(table) > self._max_tracked:
            table.popitem(last=False)

    def _open_span(self, key: Tuple[str, ...], start: Dict[str, Any]) -> bool:
        """Remember ``start``; False when that span is already open."""
        with self._lock:
            if key in self._open:
                return False
            self._open[key] = start
            self._trim(self._open)
            return True

    def _close_span(self, key: Tuple[str, ...]) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._open.pop(key, None)

    def open_count(self) -> int:
        with self._lock:
            return len(self._open) + len(self._model_calls)

    # -- model calls -------------------------------------------------------

    def model_call_start(
        self, kwargs: Mapping[str, Any], *, session_key: str, run_id: Optional[str]
    ) -> List[Dict[str, Any]]:
        """``pre_api_request``: open this attempt of the call.

        The session's still-open attempt ends first, as an error: an agent
        makes one main-loop call at a time, so a new one means Hermes gave up
        on the old one without either end hook (a recovery that re-sends the
        call without ``api_request_error``, such as a truncated response, or
        an error recovered before classification). The first attempt's spanId
        is the call's ``api_request_id``; attempt n's is ``<id>#n``.
        """
        session_id = _text(kwargs.get("session_id"))
        request = _model_call_request(kwargs)
        if not session_id or not request or not session_key:
            return []
        at_ms = self._now_ms()
        frames: List[Dict[str, Any]] = []
        with self._lock:
            earlier = self._model_calls.pop(session_id, None)
            if earlier is not None:
                frames.append(_end_of(earlier[1], "error", at_ms))
            attempt = self._attempts.pop((session_id, request), 0) + 1
            self._attempts[(session_id, request)] = attempt
            self._trim(self._attempts)
            span_id = request if attempt == 1 else f"{request}#{attempt}"
            start = _frame(MODEL_CALL, "start", session_key, run_id, span_id, at_ms)
            provider = _text(kwargs.get("provider"))
            model = _text(kwargs.get("model"))
            if provider:
                start["provider"] = provider
            if model:
                start["model"] = model
            self._model_calls[session_id] = (request, start)
            self._trim(self._model_calls)
        frames.append(start)
        return frames

    def _take_model_call(self, kwargs: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
        """The session's open attempt, if it belongs to this hook's call."""
        session_id = _text(kwargs.get("session_id"))
        request = _model_call_request(kwargs)
        with self._lock:
            open_call = self._model_calls.get(session_id)
            if open_call is None or not request or open_call[0] != request:
                return None
            del self._model_calls[session_id]
            return open_call[1]

    def model_call_end(
        self, kwargs: Mapping[str, Any], outcome: str
    ) -> List[Dict[str, Any]]:
        """``post_api_request``: end the open attempt, if this adapter opened one."""
        start = self._take_model_call(kwargs)
        if start is None:
            return []
        return [_end_of(start, outcome, self._now_ms())]

    def model_call_failed(self, kwargs: Mapping[str, Any]) -> List[Dict[str, Any]]:
        """``api_request_error``: end the failed attempt as an error, then open
        the retry wait when the engine will back off before the next one."""
        start = self._take_model_call(kwargs)
        if start is None:
            return []
        at_ms = self._now_ms()
        frames = [_end_of(start, "error", at_ms)]
        wait = _retry_wait(kwargs, start, at_ms)
        if wait is not None:
            frames.append(wait)
        return frames

    # -- compaction ----------------------------------------------------------

    def compaction_start(
        self, kwargs: Mapping[str, Any], *, session_key: str, run_id: Optional[str]
    ) -> List[Dict[str, Any]]:
        """``pre_auxiliary_call`` for a compression attempt."""
        session_id = _text(kwargs.get("session_id"))
        span_id = _compaction_span_id(kwargs)
        if not session_id or not span_id or not session_key:
            return []
        start = _frame(COMPACTION, "start", session_key, run_id, span_id, self._now_ms())
        if not self._open_span((COMPACTION, session_id, span_id), start):
            return []
        return [start]

    def compaction_end(self, kwargs: Mapping[str, Any]) -> List[Dict[str, Any]]:
        """``post_auxiliary_call``: ``failed`` when the attempt raised."""
        start = self._close_span(
            (COMPACTION, _text(kwargs.get("session_id")), _compaction_span_id(kwargs))
        )
        if start is None:
            return []
        failed = bool(_text(kwargs.get("error")) or _text(kwargs.get("error_type")))
        return [_end_of(start, "failed" if failed else "completed", self._now_ms())]

    # -- subagents -----------------------------------------------------------

    def subagent_start(
        self, kwargs: Mapping[str, Any], *, session_key: str, run_id: Optional[str]
    ) -> List[Dict[str, Any]]:
        """``subagent_start``, already routed to the PARENT's run.

        spanId is the child's session id, the one id ``subagent_stop`` also
        carries. Without it the child subagent id still opens the span, and
        the relay ends it with the parent run.
        """
        child = _text(kwargs.get("child_session_id")) or _text(
            kwargs.get("child_subagent_id")
        )
        if not child or not session_key:
            return []
        start = _frame(SUBAGENT, "start", session_key, run_id, child, self._now_ms())
        label = _text(kwargs.get("child_role"))
        if label:
            start["label"] = label
        if not self._open_span((SUBAGENT, child), start):
            return []
        return [start]

    def subagent_end(self, kwargs: Mapping[str, Any]) -> List[Dict[str, Any]]:
        """``subagent_stop``: the outcome is the child's own status."""
        child = _text(kwargs.get("child_session_id"))
        if not child:
            return []
        start = self._close_span((SUBAGENT, child))
        if start is None:
            return []
        outcome = subagent_outcome(kwargs.get("child_status"))
        return [_end_of(start, outcome, self._now_ms())]
