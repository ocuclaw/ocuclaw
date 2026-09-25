"""Read-only board-instance checkpoint and event tail (#3038, #3051).

The #3038 proof built this as a test helper; #3051's moment tail uses it in
production, so it lives in the bundle and ``tests/board_identity.py`` imports
it. Stdlib only and no relative imports: the proof's notifier subprocess loads
this file by path.

Stock Hermes has no board-instance id, and writing one into ``board.json`` or
a Hermes table is forbidden, so identity here is a *checkpoint* kept by the
reader in OcuClaw-owned storage:

* ``cursor``  - the high-water ``task_events.id`` already accounted for.
* ``anchor``  - id + content hash of the newest event row at or below the
  cursor. Event ids are AUTOINCREMENT, never reused, and rows are never
  rewritten, so the same id with a different hash is a different lifetime.
* file identity (``st_dev``/``st_ino``) and ``board.json`` ``created_at`` -
  advisory. A change forces a resnapshot; no change proves nothing
  (``hermes import`` restores a DB in place and keeps its inode).

A checkpoint is valid only when all of these hold, read in one transaction:
the DB exists; file identity and ``board.json`` ``created_at`` are unchanged;
``sqlite_sequence`` for ``task_events`` is not below the cursor; the anchor row
still exists with the same hash; and no row in the unread range
``(cursor, seq]`` is missing (``hermes kanban gc`` and archived-task deletion
leave holes). Anything else yields ``resnapshot``: take the current board
state, move the cursor to the current ``seq`` and deliver no history.

Every read opens the store ``mode=ro`` with a bounded lock wait and never
creates or migrates it. Invalid UTF-8 reads as U+FFFD (``_lenient``), as the
Board read lane does.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Optional

#: Bounded lock wait for every read (seconds).
BUSY_TIMEOUT_S = 2.0

#: Reasons a checkpoint is not continuous. Each one leads to a resnapshot.
REASONS = (
    "board_missing",       # the DB file is gone (board removed)
    "file_replaced",       # st_dev/st_ino changed
    "board_recreated",     # board.json created_at changed
    "sequence_regressed",  # sqlite_sequence(task_events) < cursor
    "anchor_missing",      # the anchor row is gone (pruned, or a new lifetime)
    "anchor_changed",      # same id, different row: a new lifetime
    "unread_gap",          # rows in (cursor, seq] were deleted before being read
)

EVENT_COLS = ("id", "task_id", "run_id", "kind", "payload", "created_at")


@dataclass(frozen=True)
class Checkpoint:
    db: str
    meta: Optional[str]
    dev: int
    ino: int
    board_created_at: Optional[int]
    cursor: int
    anchor_id: Optional[int]
    anchor_hash: Optional[str]


@dataclass
class Verdict:
    continuous: bool
    reasons: list = field(default_factory=list)
    seq: int = 0


@dataclass
class TailResult:
    action: str                      # "events" | "resnapshot"
    events: list                     # new events, oldest first (always [] on resnapshot)
    checkpoint: Optional[Checkpoint]  # the checkpoint to store next (None: board missing)
    reasons: list = field(default_factory=list)
    snapshot: Optional[list] = None  # current cards on resnapshot
    facts: object = None             # what the caller's ``facts`` read returned, same transaction


def _lenient(raw: bytes) -> str:
    return bytes(raw).decode("utf-8", errors="replace")


def open_ro(db: Path) -> sqlite3.Connection:
    """Read-only connection with a bounded lock wait; never creates a store."""
    db = Path(db)
    if not db.is_file():
        raise FileNotFoundError(db)
    conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True,
                           timeout=BUSY_TIMEOUT_S, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.text_factory = _lenient
    return conn


def _board_created_at(meta: Optional[Path]) -> Optional[int]:
    if meta is None or not Path(meta).is_file():
        return None
    try:
        value = json.loads(Path(meta).read_text(encoding="utf-8")).get("created_at")
    except (OSError, ValueError, AttributeError):
        return None
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def event_hash(row) -> str:
    h = hashlib.sha256()
    for col in EVENT_COLS:
        h.update(repr(row[col]).encode())
        h.update(b"\x1f")
    return h.hexdigest()


def seq(conn) -> int:
    row = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'task_events'").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _anchor(conn, cursor: int):
    row = conn.execute(
        "SELECT * FROM task_events WHERE id <= ? ORDER BY id DESC LIMIT 1", (cursor,),
    ).fetchone()
    return (row["id"], event_hash(row)) if row is not None else (None, None)


def _checkpoint(conn, db: Path, meta: Optional[Path], cursor: int) -> Checkpoint:
    st = os.stat(db)
    anchor_id, anchor_hash = _anchor(conn, cursor)
    return Checkpoint(
        db=str(db), meta=str(meta) if meta else None, dev=st.st_dev, ino=st.st_ino,
        board_created_at=_board_created_at(meta), cursor=cursor,
        anchor_id=anchor_id, anchor_hash=anchor_hash,
    )


def _verify(conn, cp: Checkpoint) -> Verdict:
    reasons = []
    try:
        st = os.stat(cp.db)
    except FileNotFoundError:  # removed after the caller's existence check
        return Verdict(continuous=False, reasons=["board_missing"])
    if (st.st_dev, st.st_ino) != (cp.dev, cp.ino):
        reasons.append("file_replaced")
    if _board_created_at(Path(cp.meta) if cp.meta else None) != cp.board_created_at:
        reasons.append("board_recreated")
    current = seq(conn)
    if current < cp.cursor:
        reasons.append("sequence_regressed")
    if cp.anchor_id is not None:
        row = conn.execute("SELECT * FROM task_events WHERE id = ?", (cp.anchor_id,)).fetchone()
        if row is None:
            reasons.append("anchor_missing")
        elif event_hash(row) != cp.anchor_hash:
            reasons.append("anchor_changed")
    elif conn.execute("SELECT 1 FROM task_events WHERE id <= ? LIMIT 1", (cp.cursor,)).fetchone():
        # No row at or below the cursor survived when the checkpoint was taken
        # (gc removed all read history). Rows reappearing there can only come
        # from a restore of an older lifetime.
        reasons.append("anchor_changed")
    if current > cp.cursor:
        present = conn.execute(
            "SELECT COUNT(*) FROM task_events WHERE id > ? AND id <= ?", (cp.cursor, current),
        ).fetchone()[0]
        if present < current - cp.cursor:
            reasons.append("unread_gap")
    return Verdict(continuous=not reasons, reasons=reasons, seq=current)


def _snapshot(conn) -> list:
    return [dict(r) for r in conn.execute(
        "SELECT id, status, title FROM tasks WHERE status != 'archived' ORDER BY id"
    )]


def first_watch(db: Path, meta: Optional[Path] = None) -> tuple[list, Checkpoint]:
    """Start a watch: current snapshot plus a cursor boundary at the current
    ``seq``. No history is replayed."""
    conn = open_ro(db)
    try:
        conn.execute("BEGIN")
        try:
            return _snapshot(conn), _checkpoint(conn, Path(db), meta, seq(conn))
        finally:
            conn.execute("COMMIT")
    finally:
        conn.close()


def verify(cp: Checkpoint) -> Verdict:
    if not Path(cp.db).is_file():
        return Verdict(continuous=False, reasons=["board_missing"])
    conn = open_ro(Path(cp.db))
    try:
        conn.execute("BEGIN")
        try:
            return _verify(conn, cp)
        finally:
            conn.execute("COMMIT")
    finally:
        conn.close()


def tail(cp: Checkpoint, limit: int = 200,
         facts: Optional[Callable[[sqlite3.Connection, list], object]] = None) -> TailResult:
    """Read events after the checkpoint, or say resnapshot when continuity
    cannot be proven. One read transaction covers the check, the read and the
    caller's ``facts(conn, events)`` (for example the cards' titles)."""
    if not Path(cp.db).is_file():
        return TailResult("resnapshot", [], None, ["board_missing"], None)
    db, meta = Path(cp.db), Path(cp.meta) if cp.meta else None
    conn = open_ro(db)
    try:
        conn.execute("BEGIN")
        try:
            verdict = _verify(conn, cp)
            if "board_missing" in verdict.reasons:
                return TailResult("resnapshot", [], None, verdict.reasons, None)
            if not verdict.continuous:
                return TailResult("resnapshot", [], _checkpoint(conn, db, meta, verdict.seq),
                                  verdict.reasons, _snapshot(conn))
            rows = conn.execute(
                "SELECT * FROM task_events WHERE id > ? ORDER BY id LIMIT ?", (cp.cursor, int(limit)),
            ).fetchall()
            events = [{c: r[c] for c in EVENT_COLS} for r in rows]
            for event, row in zip(events, rows):
                event["hash"] = event_hash(row)
            cursor = events[-1]["id"] if events else cp.cursor
            extra = facts(conn, events) if facts is not None and events else None
            return TailResult("events", events, _checkpoint(conn, db, meta, cursor), facts=extra)
        finally:
            conn.execute("COMMIT")
    finally:
        conn.close()


def to_json(cp: Checkpoint) -> str:
    return json.dumps(asdict(cp), sort_keys=True)


def from_json(text: str) -> Optional[Checkpoint]:
    """A stored checkpoint, or None when it cannot be read back exactly."""
    try:
        raw = json.loads(text)
        cp = Checkpoint(**raw)
    except (TypeError, ValueError):
        return None
    ints = (cp.dev, cp.ino, cp.cursor)
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in ints) or not isinstance(cp.db, str):
        return None
    return cp
