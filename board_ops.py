"""Hermes Board operation receipts (#3055); contract in docs/hermes-board/contract.md.

The shared mutation machinery every Board write reuses. A receipt is
OcuClaw's own record of one wearer action, keyed by the phone's operation
key. It lives in OcuClaw's Board store (``<process home>/state/ocuclaw-board.db``,
beside ``board_watch``), never in a Hermes table.

A receipt binds the key to its scope (gateway, profile), its operation, its
board instance (the #3044 anchor) and a digest of its payload. OcuClaw
enforces that binding, not Hermes: the same key with another scope is
``stale_scope``, with another intent ``operation_conflict``.

States: ``pending`` (written before any native write, with the writer's
process identity), then exactly one of ``succeeded``, ``refused`` (with a
code) or ``outcome_unknown``. A final state never changes, so a retry with
the same key returns the same answer. A dropped response is never a reason
to write again: the phone looks the receipt up instead.

A lookup of a key with no receipt records a ``refused`` / ``expired_request``
tombstone, so a request that never arrived can never land later.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from typing import Any, Optional

from . import board_watch, receipts

STATES = ("pending", "succeeded", "refused", "outcome_unknown")
FINAL_STATES = ("succeeded", "refused", "outcome_unknown")
#: The phone's operation key: 16-64 URL-safe characters.
KEY = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
#: Final receipts older than this are pruned. The phone resolves a key within
#: minutes (a retry, or a lookup after a dropped reply); this is far beyond it.
RETENTION_SECONDS = 7 * 24 * 3600
#: The operation name a lookup tombstone records.
TOMBSTONE = ""

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS board_op ("
    " key TEXT PRIMARY KEY, gateway TEXT NOT NULL, profile TEXT NOT NULL,"
    " operation TEXT NOT NULL, board TEXT NOT NULL, anchor TEXT NOT NULL,"
    " digest TEXT NOT NULL, native_key TEXT NOT NULL, state TEXT NOT NULL,"
    " code TEXT, result TEXT, writer_pid INTEGER, writer_start INTEGER,"
    " created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
)
_COLUMNS = ("key", "gateway", "profile", "operation", "board", "anchor", "digest", "native_key",
            "state", "code", "result", "writer_pid", "writer_start", "created_at", "updated_at")


class OpStoreError(Exception):
    """OcuClaw's receipt store cannot be read or written right now."""


class OpRefused(Exception):
    """A curated refusal before anything was written; ``code`` is a Board code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def digest(intent: Any) -> str:
    """The payload binding: SHA-256 over canonical JSON."""
    raw = json.dumps(intent, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def _writer() -> tuple:
    pid = os.getpid()
    return pid, receipts.process_start_time(pid)


def writer_live(receipt: dict) -> bool:
    """Whether the process that owns a pending receipt may still be running.
    Unknown counts as live: a pending receipt is never resolved on a guess."""
    return receipts.writer_is_live({"pid": receipt.get("writer_pid"),
                                    "start_time": receipt.get("writer_start")}) is not False


def _open() -> sqlite3.Connection:
    try:
        conn = board_watch._open(create=True)
    except board_watch.WatchStoreError:
        raise OpStoreError("store unavailable") from None
    try:
        conn.execute(_SCHEMA)
    except sqlite3.Error:
        conn.close()
        raise OpStoreError("store unavailable") from None
    return conn


def _row(row) -> Optional[dict]:
    if row is None:
        return None
    out = dict(zip(_COLUMNS, row))
    try:
        out["result"] = json.loads(out["result"]) if out["result"] else None
    except ValueError:
        out["result"] = None
    return out


def _select(conn, key: str) -> Optional[dict]:
    return _row(conn.execute(f"SELECT {', '.join(_COLUMNS)} FROM board_op WHERE key = ?", [key]).fetchone())


def _write(body):
    conn = _open()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            out = body(conn)
            conn.execute("COMMIT")
            return out
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    except sqlite3.Error:
        raise OpStoreError("store unwritable") from None
    finally:
        conn.close()


def _check_scope(found: dict, *, gateway: str, profile: str) -> None:
    if found["gateway"] != gateway or found["profile"] != profile:
        raise OpRefused("stale_scope")


def begin(key: str, *, gateway: str, profile: str, operation: str, board: str, anchor: str,
          intent_digest: str, native_key: str, pending: Optional[dict] = None,
          now: Optional[int] = None) -> dict:
    """The receipt for ``key``, written ``pending`` when new.

    An existing receipt must match scope (else ``stale_scope``) and intent
    (else ``operation_conflict``); a tombstone answers as its final state. A
    pending receipt whose writer died is taken over by this process before any
    native write, so a lookup never tombstones an attempt that is running."""
    if not KEY.match(key or ""):
        raise OpRefused("invalid_request")
    now = int(time.time()) if now is None else int(now)
    pid, start = _writer()

    def body(conn):
        conn.execute("DELETE FROM board_op WHERE state != 'pending' AND updated_at < ?",
                     [now - RETENTION_SECONDS])
        found = _select(conn, key)
        if found is None:
            conn.execute(
                "INSERT INTO board_op (key, gateway, profile, operation, board, anchor, digest, native_key,"
                " state, code, result, writer_pid, writer_start, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?)",
                [key, gateway, profile, operation, board, anchor, intent_digest, native_key,
                 json.dumps(pending, sort_keys=True) if pending is not None else None, pid, start, now, now])
            # #3056: this call wrote the receipt, so this attempt owns it.
            return {**_select(conn, key), "fresh": True}
        _check_scope(found, gateway=gateway, profile=profile)
        if found["operation"] == TOMBSTONE:
            return found
        if (found["operation"], found["board"], found["anchor"], found["digest"]) != (
                operation, board, anchor, intent_digest):
            raise OpRefused("operation_conflict")
        if found["state"] == "pending" and not writer_live(found):
            conn.execute("UPDATE board_op SET writer_pid = ?, writer_start = ?, updated_at = ?"
                         " WHERE key = ? AND state = 'pending'", [pid, start, now, key])
            # #3056: the dead writer's attempt is this process's to settle now.
            found = {**_select(conn, key), "taken_over": True}
        return found

    return _write(body)


def finish(key: str, state: str, *, code: Optional[str] = None, result: Optional[dict] = None,
           writer: Optional[tuple] = None) -> dict:
    """Move a pending receipt to its final ``state`` and return what is stored.
    A receipt already final keeps its answer. ``writer`` makes the move
    conditional on the pending receipt still belonging to that process
    (a lookup resolving a dead writer's attempt). Without ``result`` the
    pending receipt's own result is kept (#3056: a refused verdict still
    names its verdict)."""
    if state not in FINAL_STATES:
        raise ValueError(state)
    now = int(time.time())

    def body(conn):
        sql = ("UPDATE board_op SET state = ?, code = ?, result = COALESCE(?, result), updated_at = ?"
               " WHERE key = ? AND state = 'pending'")
        params = [state, code, json.dumps(result, sort_keys=True) if result is not None else None, now, key]
        if writer is not None:
            sql += " AND writer_pid IS ? AND writer_start IS ?"
            params += [writer[0], writer[1]]
        conn.execute(sql, params)
        return _select(conn, key)

    return _write(body)


def merge_result(key: str, fields: dict) -> dict:
    """Add ``fields`` to a succeeded receipt's result (the post-create watch
    step records that it ran). The original answer's keys never change."""
    now = int(time.time())

    def body(conn):
        found = _select(conn, key)
        if found is None or found["state"] != "succeeded":
            return found
        merged = {**(found["result"] or {}), **fields}
        conn.execute("UPDATE board_op SET result = ?, updated_at = ? WHERE key = ?",
                     [json.dumps(merged, sort_keys=True), now, key])
        return _select(conn, key)

    return _write(body)


def current_writer() -> tuple:
    """This process's writer identity, as a pending receipt records it."""
    return _writer()


def note(key: str, fields: dict, *, writer: tuple) -> bool:
    """Add ``fields`` to a pending receipt that still belongs to ``writer``
    (#3056 records that a verdict is about to be issued). False when the
    receipt is final or another process owns it: then nothing was written."""
    now = int(time.time())

    def body(conn):
        found = _select(conn, key)
        if (found is None or found["state"] != "pending"
                or (found["writer_pid"], found["writer_start"]) != tuple(writer)):
            return False
        merged = {**(found["result"] or {}), **fields}
        conn.execute("UPDATE board_op SET result = ?, updated_at = ? WHERE key = ? AND state = 'pending'",
                     [json.dumps(merged, sort_keys=True), now, key])
        return True

    return _write(body)


def lookup(key: str, *, gateway: str, profile: str) -> dict:
    """The receipt for ``key``. A key with no receipt gets a tombstone
    (``refused`` / ``expired_request``) so the request can never land later."""
    if not KEY.match(key or ""):
        raise OpRefused("invalid_request")
    now = int(time.time())

    def body(conn):
        found = _select(conn, key)
        if found is None:
            conn.execute(
                "INSERT INTO board_op (key, gateway, profile, operation, board, anchor, digest, native_key,"
                " state, code, result, writer_pid, writer_start, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, '', '', '', '', 'refused', 'expired_request', NULL, NULL, NULL, ?, ?)",
                [key, gateway, profile, TOMBSTONE, now, now])
            found = _select(conn, key)
        _check_scope(found, gateway=gateway, profile=profile)
        return found

    return _write(body)


def get(key: str) -> Optional[dict]:
    """The stored receipt, or None. Never creates the store."""
    if board_watch.store_path() is None or not board_watch.store_path().is_file():
        return None
    conn = _open()
    try:
        return _select(conn, key)
    except sqlite3.Error:
        raise OpStoreError("store unreadable") from None
    finally:
        conn.close()


def open_counts(board: str, *, gateway: str, profile: str) -> dict:
    """#3063: this scope's receipts on ``board`` that are not settled yet:
    ``{pending, unknown}``. A read: it never creates the store."""
    out = {"pending": 0, "unknown": 0}
    try:
        conn = board_watch._open(create=False)
    except board_watch.WatchStoreError:
        raise OpStoreError("store unavailable") from None
    if conn is None:
        return out
    try:
        rows = conn.execute(
            "SELECT state, COUNT(*) FROM board_op WHERE board = ? AND gateway = ? AND profile = ?"
            " AND state IN ('pending', 'outcome_unknown') GROUP BY state", [board, gateway, profile]).fetchall()
    except sqlite3.Error as exc:
        if "no such table" in str(exc).lower():
            return out
        raise OpStoreError("store unreadable") from None
    finally:
        conn.close()
    for state, count in rows:
        out["pending" if state == "pending" else "unknown"] = int(count)
    return out
