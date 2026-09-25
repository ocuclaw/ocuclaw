"""Hermes Board maintenance (#3063): diagnostics, board export and per-card
reclaim of a stale worker, behind a collapsed section in Settings › Board.
Contract: docs/hermes-board/contract.md ("Maintenance (#3063)").

Stock only (0.21.1 ``2237be35``, 0.21.3 ``345cd2b0``). Each action has its own
gate, under the ``maintenance`` capability key:

- ``diagnostics``: ``board.maintenance`` reads the store read-only, in one
  read transaction: curated counts and the running cards whose claim looks
  stale. No prompt, body, credential, path, claim lock or native exception
  text crosses; a claim is named by a short digest only.
- ``export``: ``board.export`` calls stock ``export_board`` with an explicit
  slug (never None) and explicit ``include_attachments`` / ``include_logs``
  flags. The tar.gz lands in OcuClaw's own state directory, never in Hermes'
  tree. ``board.export.part`` hands it to the phone once, in order, in
  size-capped parts; the file is deleted after the last part, on any
  out-of-order or repeated part, on a newer export for the same scope, and
  when it is older than ``EXPORT_TTL_SECONDS``.
- ``reclaim``: a ``board.action`` (``board_actions``) with action
  ``reclaim``: stock ``reclaim_task`` on that one card, after an OcuClaw
  pre-check that the card still holds the claim the wearer viewed, on the run
  the wearer viewed, and that the claim is still stale. Never the board-wide
  ``release_stale_claims``, never ``force``.
"""
from __future__ import annotations

import base64
import hashlib
import inspect
import re
import secrets
import shutil
import sqlite3
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import Optional

from . import board_management as bm
from . import board_ops

READ = "board.maintenance"
EXPORT = "board.export"
PART = "board.export.part"
OPERATIONS = (READ, EXPORT, PART)
#: The section's actions, in the order the phone shows them. Each has its own
#: gate; all sit under the ``maintenance`` capability key.
GATES = ("diagnostics", "export", "reclaim")
CAPABILITY = "maintenance"

#: At most this many stale cards are listed (the count covers them all).
STALE_MAX = 20
#: The two stale signals stock's own sweep uses, read here without writing.
STALE_REASONS = ("claim_expired", "heartbeat_stale")
#: Columns the stale check reads (present on both pins; absent means no list).
STALE_COLUMNS = {"claim_lock", "claim_expires", "last_heartbeat_at"}
JOURNAL_MODES = ("wal", "delete", "truncate", "persist", "memory", "off")

#: The largest archive the phone is handed. Larger ones are deleted at once.
EXPORT_MAX_BYTES = 8 * 1024 * 1024
#: One part's raw size (base64 on the wire is a third larger).
PART_BYTES = 192 * 1024
#: An export not fully fetched by then is deleted.
EXPORT_TTL_SECONDS = 300
EXPORT_DIRNAME = "ocuclaw-board-export"
_EXPORT_ID = re.compile(r"^[A-Za-z0-9_-]{22}$")

_lock = threading.Lock()
#: Live staged files by id: kind, path, size, parts, next part, scope, created
#: time. ``kind`` is ``export`` (a board export) or ``artifact`` (#3044, one
#: card artifact, ``board_artifacts``); both share these staging rules.
_exports: dict = {}
EXPORT_KIND = "export"


# --------------------------------------------------------------------------
# Gates
# --------------------------------------------------------------------------

@lru_cache(maxsize=1)
def export_supported() -> bool:
    """Stock ``export_board`` takes an explicit board and both include flags."""
    try:
        from hermes_cli.kanban_transfer import export_board
        params = inspect.signature(export_board).parameters
    except Exception:  # noqa: BLE001 - an engine without it has no export
        return False
    return {"board", "output_path", "include_attachments", "include_logs"} <= set(params)


@lru_cache(maxsize=1)
def reclaim_supported() -> bool:
    """Stock ``reclaim_task`` takes the reason that tags this op's own event."""
    try:
        from hermes_cli.kanban_db import reclaim_task
        return "reason" in inspect.signature(reclaim_task).parameters
    except Exception:  # noqa: BLE001
        return False


def gates(capabilities: list) -> list:
    """``[{key, enabled, code?}]`` for each maintenance action, in order. All
    are off, with the capability's own code, while ``maintenance`` is off."""
    row = next((r for r in capabilities if r.get("key") == CAPABILITY), None)
    if row is None or not row.get("enabled"):
        code = (row or {}).get("code") or "unsupported"
        return [{"key": key, "enabled": False, "code": code} for key in GATES]
    supported = {"diagnostics": True, "export": export_supported(), "reclaim": reclaim_supported()}
    return [{"key": key, "enabled": True} if supported[key] else {"key": key, "enabled": False, "code": "unsupported"}
            for key in GATES]


def require(capabilities: list, gate: str) -> None:
    """Refuse with the gate's code unless this maintenance action is on."""
    row = next((r for r in gates(capabilities) if r["key"] == gate), None)
    if row is None or not row["enabled"]:
        raise bm.BoardReadError((row or {}).get("code") or "unsupported")


# --------------------------------------------------------------------------
# Stale claims (read-only)
# --------------------------------------------------------------------------

def claim_digest(claim_lock) -> str:
    """The viewed claim, named without its host or pid."""
    raw = str(bm._decoded(claim_lock) or "").encode("utf-8", "replace")
    return hashlib.sha256(b"ocuclaw-board-claim\0" + raw).hexdigest()[:16]


def _heartbeat_max() -> int:
    from hermes_cli.kanban_db import DEFAULT_CLAIM_HEARTBEAT_MAX_STALE_SECONDS
    return int(DEFAULT_CLAIM_HEARTBEAT_MAX_STALE_SECONDS)


def stale_reason(status, claim_expires, heartbeat, now: int) -> Optional[str]:
    """Why a card's claim looks stale, by stock's own two signals, or None.
    A heartbeat older than stock's limit wins over a merely expired claim."""
    if status != "running":
        return None
    hb = bm._int(heartbeat, None) if heartbeat is not None else None
    if hb is not None and now - hb > _heartbeat_max():
        return "heartbeat_stale"
    expires = bm._int(claim_expires, None) if claim_expires is not None else None
    if expires is not None and expires < now:
        return "claim_expired"
    return None


def claim_facts(conn: sqlite3.Connection, card_id: str, now: Optional[int] = None) -> Optional[dict]:
    """``{claim, stale}`` for one card, in the caller's transaction; None when
    this store has no claim columns."""
    if not STALE_COLUMNS <= bm._columns(conn, "tasks"):
        return None
    row = conn.execute("SELECT status, claim_lock, claim_expires, last_heartbeat_at FROM tasks WHERE id = ?",
                       [card_id]).fetchone()
    if row is None:
        return None
    now = int(time.time()) if now is None else now
    return {"claim": claim_digest(row[1]),
            "stale": stale_reason(bm._decoded(row[0]), row[2], row[3], now)}


def _stale_cards(conn: sqlite3.Connection, now: int) -> tuple:
    """``(count, rows)``: every running card whose claim looks stale, the
    oldest first; at most STALE_MAX rows."""
    if not STALE_COLUMNS <= bm._columns(conn, "tasks"):
        return 0, []
    found = []
    for row in conn.execute(
            "SELECT t.id, t.title, t.assignee, t.claim_lock, t.claim_expires, t.last_heartbeat_at,"
            " (SELECT r.id FROM task_runs r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1)"
            " FROM tasks t WHERE t.status = 'running'"):
        reason = stale_reason("running", row[4], row[5], now)
        card_id = bm._decoded(row[0])
        if reason is None or not isinstance(card_id, str) or not bm._CARD_ID.match(card_id):
            continue
        since = bm._int(row[5], now) if reason == "heartbeat_stale" else bm._int(row[4], now)
        out = {"id": card_id, "title": bm._clean(row[1], 200) or card_id, "run": int(row[6] or 0),
               "claim": claim_digest(row[3]), "reason": reason, "staleFor": max(0, now - since)}
        worker = bm._clean(row[2], 64)
        if worker:
            out["worker"] = worker
        found.append(out)
    found.sort(key=lambda r: (-r["staleFor"], r["id"]))
    return len(found), found[:STALE_MAX]


# --------------------------------------------------------------------------
# board.maintenance
# --------------------------------------------------------------------------

def _count(conn, table: str, where: str = "") -> int:
    try:
        return int(conn.execute(f'SELECT COUNT(*) FROM "{table}" {where}').fetchone()[0])
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc).lower():
            return 0
        raise


def _size(db: Path) -> int:
    total = 0
    for path in (db, db.with_name(db.name + "-wal")):
        try:
            total += path.stat().st_size
        except OSError:
            pass
    return total


def read(root: Path, payload, profile: str, capabilities: list) -> dict:
    """The section's read: its gates, and, while ``diagnostics`` is on, the
    board's curated diagnostics and its stale cards. Never writes."""
    from .board_create import _gateway
    if not isinstance(payload, dict) or set(payload) - {"slug"}:
        raise bm.BoardReadError("invalid_request")
    row = next((r for r in capabilities if r.get("key") == CAPABILITY), None)
    if row is None or not row.get("enabled"):
        raise bm.BoardReadError((row or {}).get("code") or "unsupported")
    slug, db, meta = bm._target(root, payload)
    rows = gates(capabilities)
    diagnostics_on = next(r for r in rows if r["key"] == "diagnostics")["enabled"]
    now = int(time.time())

    def body(conn):
        identity = bm._file_identity(db)
        if not diagnostics_on:
            return identity, None, None
        counts = {
            "cards": _count(conn, "tasks", "WHERE status != 'archived'"),
            "archived": _count(conn, "tasks", "WHERE status = 'archived'"),
            "running": _count(conn, "tasks", "WHERE status = 'running'"),
            "runs": _count(conn, "task_runs"),
            "events": _count(conn, "task_events"),
            "comments": _count(conn, "task_comments"),
            "attachments": _count(conn, "task_attachments"),
        }
        mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0] or "").lower()
        counts["journal"] = mode if mode in JOURNAL_MODES else "other"
        stale_count, stale = _stale_cards(conn, now)
        counts["stale"] = stale_count
        return identity, counts, stale

    identity, counts, stale = bm._read(db, body)
    out = {"target": {"slug": slug, "name": bm._metadata(slug, meta)["name"]},
           "anchor": bm.board_anchor(root, identity), "maintenance": {"gates": rows}}
    if counts is not None:
        try:
            receipts = board_ops.open_counts(slug, gateway=_gateway(), profile=profile)
        except board_ops.OpStoreError:
            receipts = None
        diagnostics = {"checkedAt": now, "sizeBytes": _size(db), **counts}
        if receipts is not None:
            diagnostics["receipts"] = receipts
        out["maintenance"]["diagnostics"] = diagnostics
        out["maintenance"]["stale"] = stale
    return out


# --------------------------------------------------------------------------
# board.export and board.export.part
# --------------------------------------------------------------------------

def export_root(dirname: str = EXPORT_DIRNAME) -> Optional[Path]:
    """OcuClaw's own staging area named ``dirname``, under its state directory."""
    from . import receipts
    directory = receipts.state_dir()
    return None if directory is None else directory / dirname


def stage_dir(dirname: str) -> Path:
    """A fresh 0700 directory for one staged file, under ``dirname``'s area."""
    base = export_root(dirname)
    if base is None:
        raise bm.BoardReadError("temporarily_unavailable")
    directory = base / secrets.token_urlsafe(16)
    try:
        base.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.mkdir(mode=0o700)
    except OSError:
        raise bm.BoardReadError("temporarily_unavailable") from None
    return directory


def stage(kind: str, directory: Path, path: Path, size: int, gateway: str, profile: str) -> int:
    """Hold ``path`` (in ``directory``, whose name is its id) for its scope and
    answer its part count. One live file per kind and scope: a newer one
    replaces it."""
    parts = max(1, -(-size // PART_BYTES))
    with _lock:
        for old in [k for k, e in _exports.items()
                    if e["kind"] == kind and e["gateway"] == gateway and e["profile"] == profile]:
            _drop(old)
        _exports[directory.name] = {"kind": kind, "path": path, "dir": directory, "size": size, "parts": parts,
                                    "next": 0, "gateway": gateway, "profile": profile, "created": time.time()}
    return parts


def read_part(kind: str, staged_id: str, index: int, gateway: str, profile: str) -> tuple:
    """``(bytes, parts)`` for part ``index`` of a live staged file of ``kind``,
    in order, once. It is deleted after its last part, or at once on a part out
    of order, repeated or past the TTL (``expired_request``). Another scope's
    file is ``stale_scope``."""
    with _lock:
        entry = _exports.get(staged_id)
        if entry is None or entry["kind"] != kind:
            raise bm.BoardReadError("expired_request")
        if entry["gateway"] != gateway or entry["profile"] != profile:
            raise bm.BoardReadError("stale_scope")
        if time.time() - entry["created"] > EXPORT_TTL_SECONDS or index != entry["next"] or index >= entry["parts"]:
            _drop(staged_id)
            raise bm.BoardReadError("expired_request")
        try:
            with open(entry["path"], "rb") as handle:
                handle.seek(index * PART_BYTES)
                chunk = handle.read(PART_BYTES)
        except OSError:
            _drop(staged_id)
            raise bm.BoardReadError("expired_request") from None
        entry["next"] += 1
        parts = entry["parts"]
        if entry["next"] >= parts:
            _drop(staged_id)
    return chunk, parts


def _drop(export_id: str) -> None:
    """Forget one export and delete its directory. Caller holds the lock."""
    entry = _exports.pop(export_id, None)
    if entry is not None:
        shutil.rmtree(entry["dir"], ignore_errors=True)


def sweep(now: Optional[float] = None, dirname: str = EXPORT_DIRNAME) -> None:
    """Delete every staged file past its TTL, and any directory in OcuClaw's
    ``dirname`` area this process does not know (left by a restart) once it is
    that old."""
    now = time.time() if now is None else now
    with _lock:
        for export_id in [k for k, e in _exports.items() if now - e["created"] > EXPORT_TTL_SECONDS]:
            _drop(export_id)
        root = export_root(dirname)
        if root is None or not root.is_dir():
            return
        known = {e["dir"] for e in _exports.values()}
        for child in root.iterdir():
            try:
                old = now - child.stat().st_mtime > EXPORT_TTL_SECONDS
            except OSError:
                continue
            if child not in known and old:
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    try:
                        child.unlink()
                    except OSError:
                        pass


def _parse_export(payload) -> tuple:
    if not isinstance(payload, dict) or set(payload) != {"slug", "anchor", "attachments", "logs"}:
        raise bm.BoardReadError("invalid_request")
    slug, anchor = payload["slug"], payload["anchor"]
    if not isinstance(slug, str) or not bm._SLUG.match(slug):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(anchor, str) or not bm._ANCHOR.match(anchor):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(payload["attachments"], bool) or not isinstance(payload["logs"], bool):
        raise bm.BoardReadError("invalid_request")
    return slug, anchor, payload["attachments"], payload["logs"]


def export(root: Path, payload, profile: str, capabilities: list) -> dict:
    """Stock ``export_board`` for the named board, into OcuClaw's own temp
    area. Answers the export's id, name, size and part count."""
    from .board_create import _gateway
    from hermes_cli.kanban_db import board_exists, kanban_db_path
    from hermes_cli.kanban_transfer import export_board
    slug, anchor, attachments, logs = _parse_export(payload)
    require(capabilities, "export")
    db, meta = bm.board_paths(root, slug)
    if not board_exists(slug):
        raise bm.BoardReadError("invalid_target")

    def body(conn):
        if bm.board_anchor(root, bm._file_identity(db)) != anchor:
            raise bm.BoardReadError("stale_target")

    bm._read(db, body)
    # Stock must resolve the very store the wearer saw (a pinned HERMES_KANBAN_DB would not).
    try:
        same = Path(kanban_db_path(slug)).resolve() == db.resolve()
    except (OSError, ValueError):
        same = False
    if not same:
        raise bm.BoardReadError("invalid_target")
    # Capability and authority, again, right before the native call.
    require(bm.board_capabilities(), "export")
    require(capabilities, "export")
    if export_root() is None:
        raise bm.BoardReadError("temporarily_unavailable")
    sweep()
    gateway = _gateway()
    directory = stage_dir(EXPORT_DIRNAME)
    export_id = directory.name
    try:
        summary = export_board(slug, str(directory / slug), include_attachments=attachments, include_logs=logs)
        archive = Path(summary["archive"]).resolve()
        if archive.parent != directory.resolve() or not archive.is_file():
            raise bm.BoardReadError("temporarily_unavailable")
        size = archive.stat().st_size
    except bm.BoardReadError:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except FileNotFoundError:
        shutil.rmtree(directory, ignore_errors=True)
        raise bm.BoardReadError("store_missing") from None
    except ValueError:
        shutil.rmtree(directory, ignore_errors=True)
        raise bm.BoardReadError("invalid_target") from None
    except Exception:  # noqa: BLE001 - never the native text
        shutil.rmtree(directory, ignore_errors=True)
        raise bm.BoardReadError("temporarily_unavailable") from None
    if size > EXPORT_MAX_BYTES:
        shutil.rmtree(directory, ignore_errors=True)
        raise bm.BoardReadError("too_large")
    # One live export per scope: a newer one replaces it.
    parts = stage(EXPORT_KIND, directory, archive, size, gateway, profile)
    return {"target": {"slug": slug, "name": bm._metadata(slug, meta)["name"]},
            "export": {"id": export_id, "name": f"{slug}.tar.gz", "size": size, "parts": parts,
                       "attachments": attachments, "logs": logs}}


def part(payload, profile: str, capabilities: list) -> dict:
    """One part of a live export, in order, once. The export is deleted after
    its last part, or at once on a part out of order or repeated."""
    from .board_create import _gateway
    if not isinstance(payload, dict) or set(payload) != {"id", "part"}:
        raise bm.BoardReadError("invalid_request")
    export_id, index = payload["id"], payload["part"]
    if not isinstance(export_id, str) or not _EXPORT_ID.match(export_id):
        raise bm.BoardReadError("invalid_request")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise bm.BoardReadError("invalid_request")
    require(capabilities, "export")
    chunk, parts = read_part(EXPORT_KIND, export_id, index, _gateway(), profile)
    return {"export": {"id": export_id, "part": index, "parts": parts,
                       "data": base64.b64encode(chunk).decode("ascii")}}


def live_exports(kind: str = EXPORT_KIND) -> int:
    """How many staged files of ``kind`` this process holds (tests)."""
    with _lock:
        return sum(1 for e in _exports.values() if e["kind"] == kind)


def forget_exports() -> None:
    """Delete every staged file this process holds, exports and artifacts
    (tests, and a gateway shutdown)."""
    with _lock:
        for export_id in list(_exports):
            _drop(export_id)
