"""Exact compaction counts from Hermes' ``post_compaction`` hook (0.22.3+).

Hermes compacts in place by default (``compression.in_place: true``), so a
compaction keeps the session id and the compression chain stays one segment
long. The chain-hop count OcuClaw reported before stays 0 on nearly every
session, and the compressor's own ``compression_count`` lives only in memory.
The hook is an event, not a counter, so OcuClaw keeps the count itself:

* one small store per profile, ``ocuclaw.compactions.json`` in OcuClaw's state
  dir beside Hermes' own files; uninstall.py names it and its two siblings;
* keyed by Hermes session id. ``full`` counts in-place ``summarize`` and
  ``provider_native`` compactions, the ones a person means by "compacted";
  ``micro`` and ``prune`` count the small trims, which never reach the total;
  ``rotatedIn`` counts compactions that moved onto this id, which the chain's
  hop count already holds, so it stays out of the total too;
* ``last`` is the newest event: kind, reason, tokens before and after, time,
  and the session's message count once it is known (the occupancy estimate
  after a manual compress applies only while that count is unchanged);
* ``trackingSince`` (ms) is when this profile's ledger was armed. A session
  that started earlier may have compactions the ledger never saw, so its
  total is a floor, never exact. Evicting an old entry moves it forward.

The hook fires inside Hermes' compression commit window with the session's
lease held, bounded by ``hook_callback_timeout``, and a still-running call
skips that session's next one. So the callback only bumps memory under a lock;
a timer thread writes within about a second, and at exit. Writes are deltas
merged under a file lock, so a CLI process and the gateway can both count.
Handlers never raise.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

# Bound at import: the at-exit flush runs after a plugin loader may already
# have dropped this package from sys.modules, so a relative import there fails.
from .receipts import _acquire_exclusive, _release_exclusive, state_dir

logger = logging.getLogger(__name__)

POST_COMPACTION_HOOK_NAME = "post_compaction"

# In <HERMES_HOME>/state beside Hermes' own files; uninstall.py names all three.
STORE_FILENAME = "ocuclaw.compactions.json"
TMP_FILENAME = ".ocuclaw.compactions.json.tmp"
CORRUPT_FILENAME = "ocuclaw.compactions.corrupt.json"
# Held around each merge-write; never deleted (another process may hold it).
LOCK_FILENAME = ".ocuclaw.compactions.lock"
STORE_VERSION = 1
FLUSH_DELAY_S = 1.0
MAX_SESSIONS = 5000

# The kinds a person means by "compacted": a summary that replaced history.
FULL_KINDS = frozenset({"summarize", "provider_native"})
_COUNTER_FOR_KIND = {"micro_summarize": "micro", "prune_tool_results": "prune"}
_COUNTERS = ("full", "micro", "prune", "rotatedIn")

_SESSION_ID = re.compile(r"[A-Za-z0-9_.:-]{1,160}")
_LABEL = re.compile(r"[a-z][a-z0-9_]{0,39}")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def _tokens(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _label(value: Any) -> str:
    text = str(value or "").strip()
    return text if _LABEL.fullmatch(text) else "unknown"


def _session_id(value: Any) -> str:
    text = str(value or "").strip()
    return text if _SESSION_ID.fullmatch(text) else ""


def event_fields(payload: Mapping[str, Any], now_ms: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """The hook payload as one ledger event, or None when it names no session.

    ``session_id`` is the session holding the compacted transcript now; a
    set ``old_session_id`` means the compaction rotated onto it.
    """
    session_id = _session_id(payload.get("session_id"))
    if not session_id:
        return None
    old = _session_id(payload.get("old_session_id"))
    in_place = not old or old == session_id
    kind = _label(payload.get("kind"))
    return {
        "sessionId": session_id,
        "kind": kind,
        "reason": _label(payload.get("reason")),
        "inPlace": in_place,
        "counted": in_place and kind in FULL_KINDS,
        "beforeTokens": _tokens(payload.get("before_tokens")),
        "afterTokens": _tokens(payload.get("after_tokens")),
        "atMs": _now_ms() if now_ms is None else int(now_ms),
    }


def _counter(event: Mapping[str, Any]) -> Optional[str]:
    if not event["inPlace"]:
        return "rotatedIn"
    if event["counted"]:
        return "full"
    return _COUNTER_FOR_KIND.get(event["kind"])


def _empty_entry() -> Dict[str, Any]:
    return {**{key: 0 for key in _COUNTERS}, "last": None}


def _last_fields(event: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "kind": event["kind"],
        "reason": event["reason"],
        "inPlace": bool(event["inPlace"]),
        "beforeTokens": event["beforeTokens"],
        "afterTokens": event["afterTokens"],
        "atMs": int(event["atMs"]),
        "messageCount": event.get("messageCount"),
    }


def _clean_last(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict) or not isinstance(raw.get("atMs"), int):
        return None
    message_count = raw.get("messageCount")
    return {
        "kind": _label(raw.get("kind")),
        "reason": _label(raw.get("reason")),
        "inPlace": raw.get("inPlace") is True,
        "beforeTokens": _tokens(raw.get("beforeTokens")),
        "afterTokens": _tokens(raw.get("afterTokens")),
        "atMs": raw["atMs"],
        "messageCount": _tokens(message_count),
    }


def _newer(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if a is None:
        return b
    if b is None:
        return a
    return b if b["atMs"] >= a["atMs"] else a


class CompactionLedger:
    """One profile's per-session compaction counts, backed by the store file."""

    def __init__(
        self,
        path: Optional[Path],
        *,
        flush_delay_s: float = FLUSH_DELAY_S,
        max_sessions: int = MAX_SESSIONS,
    ) -> None:
        self.path = path
        self._flush_delay_s = flush_delay_s
        self._max_sessions = max_sessions
        self._lock = threading.Lock()
        # Held around the whole merge-write: the temp file has one fixed name.
        self._write_lock = threading.Lock()
        # Deltas this process has not written yet, merged into every read.
        self._pending: Dict[str, Dict[str, Any]] = {}
        self._pending_since: Optional[int] = None
        self._timer: Optional[threading.Timer] = None
        # The store as last read, re-read when its mtime or size moves.
        self._disk_since: Optional[int] = None
        self._disk_sessions: Dict[str, Dict[str, Any]] = {}
        self._disk_stamp: Optional[Tuple[int, int]] = None

    # -- store -------------------------------------------------------------

    def _read_store(self) -> Tuple[Optional[int], Dict[str, Dict[str, Any]]]:
        """``(trackingSince, sessions)`` from disk; a corrupt store is moved
        aside and reads as empty. Never raises."""
        if self.path is None:
            return None, {}
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None, {}
        except OSError as exc:
            logger.debug("[ocuclaw] compaction store unreadable: %s", exc)
            return None, {}
        try:
            raw = json.loads(text)
            if not isinstance(raw, dict) or raw.get("version") != STORE_VERSION or not isinstance(raw.get("sessions"), dict):
                raise ValueError("unrecognized compaction store")
            since = raw.get("trackingSince")
            since = since if isinstance(since, int) and not isinstance(since, bool) else None
            sessions: Dict[str, Dict[str, Any]] = {}
            for sid, row in raw["sessions"].items():
                if not _session_id(sid) or not isinstance(row, dict):
                    continue
                entry = _empty_entry()
                for key in _COUNTERS:
                    entry[key] = _count(row.get(key))
                entry["last"] = _clean_last(row.get("last"))
                sessions[sid] = entry
        except Exception as exc:  # noqa: BLE001 - a corrupt store starts empty
            self._move_aside(exc)
            return None, {}
        return since, sessions

    def _move_aside(self, exc: BaseException) -> None:
        assert self.path is not None
        # One fixed name, so uninstall can name every file this writes.
        aside = self.path.with_name(CORRUPT_FILENAME)
        try:
            os.replace(self.path, aside)
            logger.warning("[ocuclaw] compaction store unreadable (%s); moved to %s", type(exc).__name__, aside.name)
        except OSError:
            logger.warning("[ocuclaw] compaction store unreadable (%s)", type(exc).__name__)

    def _stamp(self) -> Optional[Tuple[int, int]]:
        if self.path is None:
            return None
        try:
            stat = self.path.stat()
        except OSError:
            return None
        return stat.st_mtime_ns, stat.st_size

    def _refresh_disk(self) -> None:
        stamp = self._stamp()
        if stamp is not None and stamp == self._disk_stamp:
            return
        since, sessions = self._read_store()
        with self._lock:
            self._disk_since, self._disk_sessions, self._disk_stamp = since, sessions, stamp

    def _merge(
        self,
        since: Optional[int],
        sessions: Dict[str, Dict[str, Any]],
        pending_since: Optional[int],
        pending: Mapping[str, Dict[str, Any]],
    ) -> Tuple[Optional[int], Dict[str, Dict[str, Any]]]:
        merged_since = since if since is not None else pending_since
        merged = {sid: {**entry} for sid, entry in sessions.items()}
        for sid, delta in pending.items():
            entry = merged.setdefault(sid, _empty_entry())
            for key in _COUNTERS:
                entry[key] = entry[key] + delta[key]
            entry["last"] = _newer(entry["last"], delta["last"])
        return merged_since, merged

    def _evict(self, since: Optional[int], sessions: Dict[str, Dict[str, Any]]) -> Optional[int]:
        """Keep the newest ``max_sessions`` entries. A session that lost its
        entry may have uncounted compactions, so ``trackingSince`` moves past
        the newest evicted one: anything that started before it is a floor."""
        excess = len(sessions) - self._max_sessions
        if excess <= 0:
            return since
        def touched(sid: str) -> int:
            last = sessions[sid]["last"]
            return last["atMs"] if last else 0
        oldest = sorted(sessions, key=touched)[:excess]
        newest_evicted = max(touched(sid) for sid in oldest)
        for sid in oldest:
            del sessions[sid]
        return max(since or 0, newest_evicted + 1)

    def flush(self) -> bool:
        """Merge this process's deltas into the store now; never raises."""
        with self._write_lock:
            with self._lock:
                self._timer = None
                if self.path is None or (not self._pending and self._pending_since is None):
                    return False
                pending, pending_since = self._pending, self._pending_since
                self._pending, self._pending_since = {}, None
            written = False
            fd: Optional[int] = None
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(self.path.with_name(LOCK_FILENAME), os.O_CREAT | os.O_RDWR, 0o600)
                if _acquire_exclusive(fd):
                    try:
                        since, sessions = self._read_store()
                        since, sessions = self._merge(since, sessions, pending_since, pending)
                        since = self._evict(since, sessions)
                        body = json.dumps(
                            {"version": STORE_VERSION, "trackingSince": since, "sessions": sessions},
                            sort_keys=True,
                            separators=(",", ":"),
                        )
                        tmp = self.path.with_name(TMP_FILENAME)
                        tmp.write_text(body, encoding="utf-8")
                        os.replace(tmp, self.path)
                        written = True
                    finally:
                        _release_exclusive(fd)
            except OSError as exc:
                logger.debug("[ocuclaw] compaction store flush failed: %s", exc)
            finally:
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            if not written:
                # Keep the deltas for the next write; nothing is lost but time.
                with self._lock:
                    for sid, delta in pending.items():
                        entry = self._pending.setdefault(sid, _empty_entry())
                        for key in _COUNTERS:
                            entry[key] += delta[key]
                        entry["last"] = _newer(entry["last"], delta["last"])
                    if self._pending_since is None:
                        self._pending_since = pending_since
                return False
        self._refresh_disk()
        return True

    def _schedule_flush(self) -> None:
        """Called with ``self._lock`` held."""
        if self._timer is not None or self.path is None:
            return
        timer = threading.Timer(self._flush_delay_s, self.flush)
        timer.daemon = True
        self._timer = timer
        try:
            timer.start()
        except RuntimeError:  # interpreter shutting down; atexit flushes
            self._timer = None

    # -- recording ---------------------------------------------------------

    def arm(self, now_ms: Optional[int] = None) -> None:
        """Record when counting began, once per profile; later calls keep the
        first time."""
        self._refresh_disk()
        with self._lock:
            if self._disk_since is not None or self._pending_since is not None:
                return
            self._pending_since = _now_ms() if now_ms is None else int(now_ms)
            self._schedule_flush()

    def record(self, event: Mapping[str, Any]) -> None:
        """Count one committed compaction (``event_fields``). Memory only."""
        counter = _counter(event)
        with self._lock:
            entry = self._pending.setdefault(event["sessionId"], _empty_entry())
            if counter is not None:
                entry[counter] += 1
            entry["last"] = _newer(entry["last"], _last_fields(event))
            if self._pending_since is None and self._disk_since is None:
                # A profile first seen here through the hook: count from now.
                self._pending_since = int(event["atMs"])
            self._schedule_flush()

    def note_message_count(self, session_id: str, at_ms: int, message_count: Any) -> None:
        """Attach the session's message count, read after the event, to it."""
        count = _tokens(message_count)
        if count is None:
            return
        self._refresh_disk()
        with self._lock:
            entry = self._pending.get(session_id)
            last = entry["last"] if entry else None
            if last is None:
                # Already written: a zero delta carries the patched event, and
                # the merge keeps the newer-or-equal one.
                disk = self._disk_sessions.get(session_id)
                if disk is None or disk["last"] is None or disk["last"]["atMs"] != at_ms:
                    return
                entry = self._pending[session_id] = _empty_entry()
                last = entry["last"] = {**disk["last"]}
            if last["atMs"] != at_ms:
                return
            last["messageCount"] = count
            self._schedule_flush()

    # -- reading -----------------------------------------------------------

    def view(self, session_ids: Iterable[str]) -> Tuple[Optional[int], Dict[str, Dict[str, Any]]]:
        """``(trackingSince, {id: entry})`` for the ids that have one."""
        self._refresh_disk()
        wanted = [sid for sid in session_ids if sid]
        with self._lock:
            since = self._disk_since if self._disk_since is not None else self._pending_since
            out: Dict[str, Dict[str, Any]] = {}
            for sid in wanted:
                disk = self._disk_sessions.get(sid)
                delta = self._pending.get(sid)
                if disk is None and delta is None:
                    continue
                entry = {**disk} if disk is not None else _empty_entry()
                if delta is not None:
                    for key in _COUNTERS:
                        entry[key] = entry[key] + delta[key]
                    entry["last"] = _newer(entry["last"], delta["last"])
                if entry["last"] is not None:
                    entry["last"] = {**entry["last"]}
                out[sid] = entry
        return since, out


# -- process-wide registry -----------------------------------------------------

_REGISTRY_LOCK = threading.Lock()
_LEDGERS: Dict[Path, CompactionLedger] = {}
_HOOK_REGISTERED = False
_ATEXIT_REGISTERED = False


def _normal_home(home: Any) -> Optional[Path]:
    if home is None:
        return None
    try:
        return Path(home).expanduser().resolve()
    except (OSError, RuntimeError, TypeError, ValueError):
        return None


def _context_home() -> Optional[Path]:
    """The profile home of the code running now: Hermes runs each profile's
    turns and its /compress inside that profile's runtime scope."""
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - absent Hermes counts nothing
        return None


def store_path(home: Optional[Path]) -> Optional[Path]:
    directory = state_dir(home) if home is not None else None
    return None if directory is None else directory / STORE_FILENAME


def ledger_for_home(home: Any) -> Optional[CompactionLedger]:
    """This process's ledger for one profile home, created on first use."""
    global _ATEXIT_REGISTERED
    resolved = _normal_home(home)
    if resolved is None:
        return None
    with _REGISTRY_LOCK:
        ledger = _LEDGERS.get(resolved)
        if ledger is None:
            ledger = _LEDGERS[resolved] = CompactionLedger(store_path(resolved))
            if not _ATEXIT_REGISTERED:
                atexit.register(flush_all)
                _ATEXIT_REGISTERED = True
        return ledger


def flush_all() -> None:
    with _REGISTRY_LOCK:
        ledgers = list(_LEDGERS.values())
    for ledger in ledgers:
        ledger.flush()


def hook_registered() -> bool:
    return _HOOK_REGISTERED


def reset_for_tests() -> None:
    global _HOOK_REGISTERED
    with _REGISTRY_LOCK:
        ledgers = list(_LEDGERS.values())
        _LEDGERS.clear()
        _HOOK_REGISTERED = False
    for ledger in ledgers:
        with ledger._lock:
            timer, ledger._timer = ledger._timer, None
        if timer is not None:
            timer.cancel()


def _started_ms(row: Mapping[str, Any]) -> Optional[int]:
    started = row.get("started_at")
    if isinstance(started, bool) or not isinstance(started, (int, float)) or started <= 0:
        return None
    return int(started * 1000)


def chain_info(home: Any, chain_rows: List[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """The ledger's view of one compression chain (rows tip first), or None
    when this process has no hook or the profile was never armed.

    ``counted`` adds to the chain's hop count. ``exact`` holds only when every
    segment started after ``trackingSince``; a row with no start time is a
    floor. ``last`` is the newest event on the chain.
    """
    if not _HOOK_REGISTERED:
        return None
    ledger = ledger_for_home(home)
    if ledger is None:
        return None
    ids = [str(row.get("id") or "") for row in chain_rows]
    since, entries = ledger.view(ids)
    if since is None:
        return None
    last = None
    # Root first, so a tie in time goes to the newer segment.
    for sid in reversed(ids):
        if sid in entries:
            last = _newer(last, entries[sid]["last"])
    starts = [_started_ms(row) for row in chain_rows]
    return {
        "counted": sum(entry["full"] for entry in entries.values()),
        "exact": bool(chain_rows) and all(start is not None and start >= since for start in starts),
        "last": last,
    }


# -- hook ----------------------------------------------------------------------


def make_hook(on_event: Callable[[Dict[str, Any]], None]) -> Callable[..., None]:
    """The ``post_compaction`` observer. It records into the ledger of the
    profile in scope, then hands the event (with that home) to ``on_event``,
    which must return at once."""

    def post_compaction(**payload: Any) -> None:
        try:
            event = event_fields(payload)
            if event is None:
                return
            home = _context_home()
            ledger = ledger_for_home(home)
            if ledger is not None:
                ledger.record(event)
            on_event({**event, "home": home})
        except Exception:  # noqa: BLE001 - observers never raise
            logger.debug("[ocuclaw] post_compaction observer failed", exc_info=True)

    return post_compaction


def register_hook(
    register: Any,
    valid_hook_names: frozenset,
    on_event: Callable[[Dict[str, Any]], None],
) -> bool:
    """Register the observer where the host's vocabulary has it (0.22.3+),
    and arm the process profile's ledger so its new sessions count exactly."""
    global _HOOK_REGISTERED
    _HOOK_REGISTERED = False
    if not callable(register) or POST_COMPACTION_HOOK_NAME not in valid_hook_names:
        return False
    register(POST_COMPACTION_HOOK_NAME, make_hook(on_event))
    _HOOK_REGISTERED = True
    try:
        ledger = ledger_for_home(_context_home())
        if ledger is not None:
            ledger.arm()
    except Exception:  # noqa: BLE001 - arming is best-effort; a first event arms too
        logger.debug("[ocuclaw] compaction ledger arm failed", exc_info=True)
    return True
