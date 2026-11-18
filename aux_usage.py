"""Per-task counts for OcuClaw's own auxiliary model calls (#5046, R7-R14).

Hermes counts auxiliary usage only inside an agent turn
(``agent/aux_accounting.py``). OcuClaw's approval explainer, live view
refresh and silent input predictions run from relay handlers, outside any
turn, so Hermes' own usage numbers never include them. The host's
``post_auxiliary_call`` hook (0.22+) is the one place they can be seen: it
fires once per physical provider attempt, retries and fallbacks included.

This module keeps a small per-profile tally of those attempts:

* only OcuClaw's three task keys are handled; anything else returns at once;
* no content field (``request_messages``, ``request``, ``system_prompt``,
  ``response``) is ever read — only task, request id, attempt number,
  provider, model, duration, the error flag and token counts;
* per UTC day and task: ``calls`` (distinct ``api_request_id``),
  ``attempts``, ``failedAttempts``, ``fallbacks`` (a successful attempt on a
  different provider or model from attempt 0 of the same request), input,
  output and cache-read tokens, and a bounded sample of successful attempt
  durations for the median wait;
* ``aux-usage.json`` in OcuClaw's per-profile state dir, flushed at most once
  a minute and at exit, keeping 90 days; a corrupt file is moved aside.

Handlers never raise: the host swallows observer errors anyway, and a count
is never worth a failed approval card.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from . import aux_tasks

logger = logging.getLogger(__name__)

PRE_AUXILIARY_CALL_HOOK_NAME = "pre_auxiliary_call"
POST_AUXILIARY_CALL_HOOK_NAME = "post_auxiliary_call"

# In <HERMES_HOME>/state beside Hermes' own files; uninstall.py names all three.
STORE_FILENAME = "ocuclaw.aux-usage.json"
TMP_FILENAME = ".ocuclaw.aux-usage.json.tmp"
CORRUPT_FILENAME = "ocuclaw.aux-usage.corrupt.json"
STORE_VERSION = 1
RETENTION_DAYS = 90
FLUSH_INTERVAL_S = 60.0
# Durations kept per task per day, for the median. A busy live view (one
# refresh a second) would otherwise grow the file without bound.
MAX_DURATIONS_PER_DAY = 240
MAX_TRACKED_REQUESTS = 512

_ROUTE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,159}")
_REQUEST_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
_COUNTERS = ("calls", "attempts", "failedAttempts", "fallbacks", "input", "output", "cacheRead")


def _day(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _route_name(value: Any) -> str:
    text = str(value or "").strip()
    return text if _ROUTE_NAME.fullmatch(text) else ""


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if value != value or value < 0 or value == float("inf"):  # NaN / inf
        return 0
    return int(value)


def _empty_bucket() -> Dict[str, Any]:
    return {**{key: 0 for key in _COUNTERS}, "durationsMs": [], "route": ""}


def _median(values: List[int]) -> Optional[int]:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) // 2


def attempt_fields(payload: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The metadata-only view of one hook payload, or None for a foreign task.

    The only reader of the host's payload: every other function works on
    this dict, so no content field can leak past here.
    """
    task = payload.get("aux_task")
    if not isinstance(task, str) or task not in aux_tasks.OCUCLAW_TASKS:
        return None
    request_id = str(payload.get("api_request_id") or "")
    return {
        "task": task,
        "requestId": request_id if _REQUEST_ID.fullmatch(request_id) else "",
        "attempt": _count(payload.get("retry_count")),
        "provider": _route_name(payload.get("provider")),
        "model": _route_name(payload.get("model")),
    }


def _usage_fields(payload: Mapping[str, Any]) -> Dict[str, Any]:
    usage = payload.get("usage")
    usage = usage if isinstance(usage, Mapping) else {}
    duration = payload.get("api_duration")
    ms = _count(duration * 1000) if isinstance(duration, (int, float)) and not isinstance(duration, bool) else 0
    return {
        "ms": ms,
        "input": _count(usage.get("input_tokens")),
        "output": _count(usage.get("output_tokens")),
        "cacheRead": _count(usage.get("cache_read_tokens")),
        "failed": payload.get("error") is not None,
    }


class AuxUsageTally:
    """One profile's per-day, per-task counts, backed by ``aux-usage.json``."""

    def __init__(
        self,
        path: Optional[Path],
        *,
        clock: Callable[[], float] = time.time,
        flush_interval_s: float = FLUSH_INTERVAL_S,
    ) -> None:
        self.path = path
        self._clock = clock
        self._flush_interval_s = flush_interval_s
        self._lock = threading.Lock()
        # Held around the whole write: the temp file has one fixed name.
        self._write_lock = threading.Lock()
        self._days: Dict[str, Dict[str, Dict[str, Any]]] = {}
        # api_request_id -> (day, task, first (provider, model), fallback counted)
        self._requests: "OrderedDict[str, List[Any]]" = OrderedDict()
        self._dirty = False
        # The first change is written at once; later ones at most once per interval.
        self._last_flush = clock() - flush_interval_s
        self._load()

    # -- store -------------------------------------------------------------

    def _load(self) -> None:
        if self.path is None or not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict) or raw.get("version") != STORE_VERSION or not isinstance(raw.get("days"), dict):
                raise ValueError("unrecognized aux usage store")
            days: Dict[str, Dict[str, Dict[str, Any]]] = {}
            for day, tasks in raw["days"].items():
                datetime.strptime(day, "%Y-%m-%d")
                if not isinstance(tasks, dict):
                    raise ValueError("bad day")
                for task, row in tasks.items():
                    if task not in aux_tasks.OCUCLAW_TASKS or not isinstance(row, dict):
                        continue
                    bucket = _empty_bucket()
                    for key in _COUNTERS:
                        bucket[key] = _count(row.get(key))
                    durations = row.get("durationsMs")
                    if isinstance(durations, list):
                        bucket["durationsMs"] = [_count(v) for v in durations[-MAX_DURATIONS_PER_DAY:]]
                    bucket["route"] = row.get("route") if isinstance(row.get("route"), str) and len(row["route"]) <= 330 else ""
                    days.setdefault(day, {})[task] = bucket
        except Exception as exc:  # noqa: BLE001 - a corrupt store starts empty
            self._move_aside(exc)
            return
        self._days = days
        self._prune()

    def _move_aside(self, exc: BaseException) -> None:
        assert self.path is not None
        # One fixed name, so uninstall can name every file this writes.
        aside = self.path.with_name(CORRUPT_FILENAME)
        try:
            os.replace(self.path, aside)
            logger.warning("[ocuclaw] aux usage store unreadable (%s); moved to %s", type(exc).__name__, aside.name)
        except OSError:
            logger.warning("[ocuclaw] aux usage store unreadable (%s)", type(exc).__name__)

    def _prune(self) -> None:
        oldest = _day(self._clock() - (RETENTION_DAYS - 1) * 86400)
        for day in [d for d in self._days if d < oldest]:
            del self._days[day]

    def flush(self) -> bool:
        """Write the store now if anything changed; never raises."""
        with self._write_lock:
            with self._lock:
                if not self._dirty or self.path is None:
                    return False
                self._prune()
                body = json.dumps({"version": STORE_VERSION, "days": self._days}, sort_keys=True, separators=(",", ":"))
                self._dirty = False
                self._last_flush = self._clock()
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_name(TMP_FILENAME)
                tmp.write_text(body, encoding="utf-8")
                os.replace(tmp, self.path)
                return True
            except OSError as exc:
                logger.debug("[ocuclaw] aux usage flush failed: %s", exc)
                with self._lock:
                    self._dirty = True
                return False

    def _maybe_flush(self) -> None:
        if self._dirty and self._clock() - self._last_flush >= self._flush_interval_s:
            self.flush()

    # -- recording ---------------------------------------------------------

    def record(self, fields: Mapping[str, Any], result: Mapping[str, Any]) -> None:
        """Count one finished attempt (``attempt_fields`` + ``_usage_fields``)."""
        now = self._clock()
        day = _day(now)
        task = fields["task"]
        route = (fields["provider"], fields["model"])
        with self._lock:
            bucket = self._days.setdefault(day, {}).setdefault(task, _empty_bucket())
            request_id = fields["requestId"]
            tracked = self._requests.get(request_id) if request_id else None
            if tracked is None:
                bucket["calls"] += 1
                if request_id:
                    self._requests[request_id] = tracked = [day, task, route, False]
                    while len(self._requests) > MAX_TRACKED_REQUESTS:
                        self._requests.popitem(last=False)
            else:
                self._requests.move_to_end(request_id)
                if fields["attempt"] == 0:
                    tracked[2] = route
            bucket["attempts"] += 1
            if result["failed"]:
                bucket["failedAttempts"] += 1
            else:
                if tracked is not None and not tracked[3] and route != tracked[2]:
                    tracked[3] = True
                    bucket["fallbacks"] += 1
                if fields["provider"] or fields["model"]:
                    bucket["route"] = " · ".join(part for part in route if part)
            bucket["input"] += result["input"]
            bucket["output"] += result["output"]
            bucket["cacheRead"] += result["cacheRead"]
            if not result["failed"]:
                # The typical wait is for an answer; a timeout is a failure.
                durations = bucket["durationsMs"]
                durations.append(result["ms"])
                if len(durations) > MAX_DURATIONS_PER_DAY:
                    del durations[: len(durations) - MAX_DURATIONS_PER_DAY]
            self._dirty = True
        self._maybe_flush()

    # -- reading -----------------------------------------------------------

    def tasks(self, period_days: int) -> List[Dict[str, Any]]:
        """``health.usage`` rows for the last ``period_days`` UTC days, busiest first."""
        oldest = _day(self._clock() - (max(1, period_days) - 1) * 86400)
        totals: Dict[str, Dict[str, Any]] = {}
        latest_route: Dict[str, Tuple[str, str]] = {}
        with self._lock:
            for day in sorted(self._days):
                if day < oldest:
                    continue
                for task, bucket in self._days[day].items():
                    row = totals.setdefault(task, {**{key: 0 for key in _COUNTERS}, "durations": []})
                    for key in _COUNTERS:
                        row[key] += bucket[key]
                    row["durations"].extend(bucket["durationsMs"])
                    if bucket["route"]:
                        latest_route[task] = (day, bucket["route"])
        rows = []
        for task, row in totals.items():
            rows.append({
                "task": task,
                "calls": row["calls"],
                "attempts": row["attempts"],
                "failedAttempts": row["failedAttempts"],
                "fallbacks": row["fallbacks"],
                "input": row["input"],
                "output": row["output"],
                "typicalMs": _median(row["durations"]),
                "route": latest_route.get(task, ("", "auto"))[1],
            })
        rows.sort(key=lambda r: (-r["calls"], r["task"]))
        return rows


# -- process-wide tally ------------------------------------------------------

_TALLY_LOCK = threading.Lock()
_TALLY: Optional[AuxUsageTally] = None
_TALLY_HOME: Optional[Path] = None
_HOOKS_REGISTERED = False
_ATEXIT_REGISTERED = False


def _process_home() -> Optional[Path]:
    from .receipts import resolve_receipt_home

    return resolve_receipt_home()


def store_path(home: Optional[Path]) -> Optional[Path]:
    from .receipts import state_dir

    directory = state_dir(home) if home is not None else None
    return None if directory is None else directory / STORE_FILENAME


def live_tally() -> Optional[AuxUsageTally]:
    """This process's tally, created on first use for the process profile."""
    global _TALLY, _TALLY_HOME, _ATEXIT_REGISTERED
    with _TALLY_LOCK:
        if _TALLY is None:
            home = _process_home()
            _TALLY_HOME = Path(home).expanduser().absolute() if home is not None else None
            _TALLY = AuxUsageTally(store_path(_TALLY_HOME))
            if not _ATEXIT_REGISTERED:
                atexit.register(flush_live_tally)
                _ATEXIT_REGISTERED = True
        return _TALLY


def flush_live_tally() -> None:
    tally = _TALLY
    if tally is not None:
        tally.flush()


def reset_for_tests() -> None:
    global _TALLY, _TALLY_HOME, _HOOKS_REGISTERED
    with _TALLY_LOCK:
        _TALLY = None
        _TALLY_HOME = None
        _HOOKS_REGISTERED = False


def hooks_registered() -> bool:
    return _HOOKS_REGISTERED


def usage_tasks(home: Any, period_days: int) -> Optional[List[Dict[str, Any]]]:
    """Rows for ``health.usage``, or None when this host has no hooks.

    The gateway's own profile reads the live tally (it holds everything not
    yet flushed); any other served profile reads its store from disk.
    """
    if not _HOOKS_REGISTERED:
        return None
    resolved = Path(home).expanduser().absolute()
    tally = live_tally()
    if tally is not None and _TALLY_HOME == resolved:
        return tally.tasks(period_days)
    return AuxUsageTally(store_path(resolved)).tasks(period_days)


# -- hooks -------------------------------------------------------------------


def make_hooks(emit: Callable[[str, Dict[str, Any]], None]) -> Tuple[Callable[..., None], Callable[..., None]]:
    """``(pre, post)`` observers. ``emit(phase, data)`` feeds the ``token.aux``
    debug category; ``post`` also counts the attempt."""

    def pre(**payload: Any) -> None:
        try:
            fields = attempt_fields(payload)
            if fields is not None:
                emit("pre", fields)
        except Exception:  # noqa: BLE001 - observers never raise
            logger.debug("[ocuclaw] pre_auxiliary_call observer failed", exc_info=True)

    def post(**payload: Any) -> None:
        try:
            fields = attempt_fields(payload)
            if fields is None:
                return
            result = _usage_fields(payload)
            tally = live_tally()
            if tally is not None:
                tally.record(fields, result)
            emit("post", {**fields, **{key: result[key] for key in ("ms", "input", "output", "failed")}})
        except Exception:  # noqa: BLE001 - observers never raise
            logger.debug("[ocuclaw] post_auxiliary_call observer failed", exc_info=True)

    return pre, post


def register_hooks(register_hook: Any, valid_hook_names: frozenset, emit: Callable[[str, Dict[str, Any]], None]) -> bool:
    """Register the observers when the host's vocabulary has them (R7)."""
    global _HOOKS_REGISTERED
    _HOOKS_REGISTERED = False
    if not callable(register_hook) or POST_AUXILIARY_CALL_HOOK_NAME not in valid_hook_names:
        return False
    pre, post = make_hooks(emit)
    register_hook(POST_AUXILIARY_CALL_HOOK_NAME, post)
    if PRE_AUXILIARY_CALL_HOOK_NAME in valid_hook_names:
        register_hook(PRE_AUXILIARY_CALL_HOOK_NAME, pre)
    _HOOKS_REGISTERED = True
    return True
