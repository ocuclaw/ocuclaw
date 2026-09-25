"""Hermes Board watches (#3050); contract in docs/hermes-board/contract.md.

A watch is an OcuClaw-owned preference keyed by profile + board + card. It
lives in OcuClaw's own store (``<process home>/state/ocuclaw-board.db``, the
directory OcuClaw receipts already use), never in Hermes: the Board never
writes or deletes native ``kanban_notify_subs`` rows. Hermes owns those rows
(its notifier sends them as chat prose, its GC purges them, child cards
inherit them), so native auto-subscriptions keep working beside a watch.

The gateway serving the profile owns the store, so the key's gateway part is
implied by where the file lives. Every read and write names one profile and
one board; nothing here lists or changes another profile's watches.

The moment tail (#3051, ``board_moments``) reads :func:`watched` at tail
time, so turning a watch off stops future moments for that scoped watch.
#3052: turning it off also cancels that watch's pending deliveries
(``board_moments.note_watch``, backed by ``due()``). The tail keeps its own
tables (checkpoint, watch start, deliveries) in the same store file.
"""
from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import time
from typing import Iterable, Optional

from . import receipts

#: Modes a watch can be set to. ``off`` removes the row.
MODES = ("off", "notify")
#: Named in the contract, refused while its capability (``wake``) is off: every engine (#3064).
RESERVED_MODES = ("notify_wake",)
STORE_FILENAME = "ocuclaw-board.db"
BUSY_TIMEOUT_SECONDS = 1.0

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS board_watch ("
    " profile TEXT NOT NULL, board TEXT NOT NULL, task TEXT NOT NULL,"
    " mode TEXT NOT NULL, updated_at INTEGER NOT NULL,"
    " PRIMARY KEY (profile, board, task))"
)


class WatchStoreError(Exception):
    """OcuClaw's watch store cannot be read or written right now."""


def store_path() -> Optional[Path]:
    directory = receipts.state_dir()
    return None if directory is None else directory / STORE_FILENAME


def _open(create: bool) -> Optional[sqlite3.Connection]:
    path = store_path()
    if path is None:
        raise WatchStoreError("no OcuClaw state directory")
    if not create and not path.is_file():
        return None
    try:
        if create:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        conn = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_SECONDS, isolation_level=None,
                               check_same_thread=False)
    except (OSError, sqlite3.Error):
        raise WatchStoreError("store unavailable") from None
    try:
        conn.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_SECONDS * 1000)}")
        if create:
            conn.execute(_SCHEMA)
            if os.name == "posix":
                os.chmod(path, 0o600)
    except (OSError, sqlite3.Error):
        conn.close()
        raise WatchStoreError("store unavailable") from None
    return conn


def modes(profile: str, board: str, task_ids: Iterable[str]) -> dict:
    """``{task: mode}`` for this profile's watches on ``board``; a card with no
    watch is ``off``. Reads never create the store."""
    ids = list(dict.fromkeys(str(t) for t in task_ids))
    out = {task: "off" for task in ids}
    if not ids:
        return out
    conn = _open(create=False)
    if conn is None:
        return out
    try:
        for start in range(0, len(ids), 200):
            chunk = ids[start:start + 200]
            rows = conn.execute(
                "SELECT task, mode FROM board_watch WHERE profile = ? AND board = ? AND task IN ("
                + ",".join("?" for _ in chunk) + ")", [profile, board, *chunk])
            for task, mode in rows:
                if mode in MODES:
                    out[task] = mode
    except sqlite3.Error:
        raise WatchStoreError("store unreadable") from None
    finally:
        conn.close()
    return out


def watched(profile: str, board: str) -> list:
    """The cards this profile watches on ``board`` (mode not ``off``), sorted."""
    conn = _open(create=False)
    if conn is None:
        return []
    try:
        rows = conn.execute("SELECT task FROM board_watch WHERE profile = ? AND board = ? AND mode != 'off'"
                            " ORDER BY task", [profile, board]).fetchall()
    except sqlite3.Error:
        raise WatchStoreError("store unreadable") from None
    finally:
        conn.close()
    return [row[0] for row in rows]


def scopes() -> list:
    """Every ``(profile, board)`` with at least one watch on, sorted (#3051's
    tail walks these). Reads never create the store."""
    conn = _open(create=False)
    if conn is None:
        return []
    try:
        rows = conn.execute("SELECT DISTINCT profile, board FROM board_watch WHERE mode != 'off'"
                            " ORDER BY profile, board").fetchall()
    except sqlite3.Error:
        raise WatchStoreError("store unreadable") from None
    finally:
        conn.close()
    return [(row[0], row[1]) for row in rows]


def set_mode(profile: str, board: str, task: str, mode: str,
             live: Optional[Iterable[str]] = None) -> str:
    """Set one scoped watch; ``off`` deletes it. Idempotent: setting the same
    mode again changes nothing. ``live`` (the board's card ids, read in the
    same request) prunes this profile's watches on cards that are gone."""
    if mode not in MODES:
        raise ValueError(mode)
    conn = _open(create=True)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            if mode == "off":
                conn.execute("DELETE FROM board_watch WHERE profile = ? AND board = ? AND task = ?",
                             [profile, board, task])
            else:
                conn.execute(
                    "INSERT INTO board_watch (profile, board, task, mode, updated_at) VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT (profile, board, task) DO UPDATE SET mode = excluded.mode,"
                    " updated_at = excluded.updated_at",
                    [profile, board, task, mode, int(time.time())])
            if live is not None:
                keep = set(live) | {task}
                gone = [t for (t,) in conn.execute(
                    "SELECT task FROM board_watch WHERE profile = ? AND board = ?", [profile, board])
                    if t not in keep]
                conn.executemany("DELETE FROM board_watch WHERE profile = ? AND board = ? AND task = ?",
                                 [[profile, board, t] for t in gone])
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    except sqlite3.Error:
        raise WatchStoreError("store unwritable") from None
    finally:
        conn.close()
    return mode
