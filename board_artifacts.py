"""Hermes Board card artifacts (#3044): open one artifact on the phone.
Contract: docs/hermes-board/contract.md ("Card detail (#3044)", "Opening an
artifact").

A read, under its own ``artifact_open`` capability key. Stock only (0.21.1
``2237be35``, 0.21.3 ``345cd2b0``, 0.21.4 ``d337b736``): no monkeypatch and no
write to a Hermes table or file.

- ``board.artifact`` names ``{slug, anchor, id, attachment}``: the card the
  wearer opened, on the store instance the sheet read, and one attachment id
  from its artifact list. Never a path or a URL. The store is read read-only,
  as ``board.card`` reads it. The attachment row must belong to that card.
  Its ``stored_path`` must resolve (following links) under stock
  ``attachments_root(board)`` and be a regular file: the check stock's own
  dashboard download makes. A file over ``ARTIFACT_MAX_BYTES`` is
  ``too_large``. The bytes are copied into OcuClaw's own staging area (0700),
  with the export's TTL and one live file per scope
  (``board_maintenance.stage``).
- ``board.artifact.part`` hands the copy over once, in order, in size-capped
  base64 parts (``board_maintenance.read_part``), then deletes it.

The answer names the file with the card's own curated descriptor
(``board_management.artifact_descriptor``): the phone checks it against the
row it tapped. No path, root or native text crosses.
"""
from __future__ import annotations

import base64
import hmac
import inspect
import os
import re
import shutil
import sqlite3
import stat
from functools import lru_cache
from pathlib import Path

from . import board_maintenance as bmt
from . import board_management as bm

OPEN = "board.artifact"
PART = "board.artifact.part"
OPERATIONS = (OPEN, PART)
CAPABILITY = "artifact_open"
KIND = "artifact"

#: The largest artifact the phone is handed (stock caps an attachment at 25 MiB).
ARTIFACT_MAX_BYTES = 8 * 1024 * 1024
STAGE_DIRNAME = "ocuclaw-board-artifact"
_ATTACHMENT_MAX = 2 ** 53 - 1
_COLUMNS = {"id", "task_id", "filename", "stored_path", "content_type", "size", "created_at"}
_COPY_CHUNK = 1024 * 1024
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{22}$")


@lru_cache(maxsize=1)
def supported() -> bool:
    """Stock ``attachments_root`` resolves one named board's attachment root."""
    try:
        from hermes_cli.kanban_db import attachments_root
        return "board" in inspect.signature(attachments_root).parameters
    except Exception:  # noqa: BLE001 - an engine without it has no open
        return False


def require(capabilities: list) -> None:
    """Refuse while ``artifact_open`` is off. Never ``unsupported`` (the phone
    withdraws Board on it)."""
    row = next((r for r in capabilities if r.get("key") == CAPABILITY), None)
    if row is None or not row.get("enabled"):
        raise bm.BoardReadError("artifact_unsupported")


def _parse(payload) -> tuple:
    if not isinstance(payload, dict) or set(payload) != {"slug", "anchor", "id", "attachment"}:
        raise bm.BoardReadError("invalid_request")
    slug, anchor, card_id, attachment = payload["slug"], payload["anchor"], payload["id"], payload["attachment"]
    if not isinstance(slug, str) or not bm._SLUG.match(slug):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(anchor, str) or not bm._ANCHOR.match(anchor):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(card_id, str) or not bm._CARD_ID.match(card_id):
        raise bm.BoardReadError("invalid_request")
    if isinstance(attachment, bool) or not isinstance(attachment, int) or not 0 <= attachment <= _ATTACHMENT_MAX:
        raise bm.BoardReadError("invalid_request")
    return slug, anchor, card_id, attachment


def _row(root: Path, db: Path, anchor: str, card_id: str, attachment: int):
    """``(descriptor, stored_path)`` for the attachment, read in one
    transaction on the read-only store the wearer saw."""

    def body(conn):
        conn.row_factory = sqlite3.Row
        if not hmac.compare_digest(anchor, bm.board_anchor(root, bm._file_identity(db))):
            raise bm.BoardReadError("stale_target")
        if conn.execute("SELECT 1 FROM tasks WHERE id = ?", [card_id]).fetchone() is None:
            raise bm.BoardReadError("invalid_target")
        if not _COLUMNS <= bm._columns(conn, "task_attachments"):
            raise bm.BoardReadError("invalid_target")
        row = conn.execute(
            "SELECT id, filename, stored_path, content_type, size, created_at FROM task_attachments"
            " WHERE id = ? AND task_id = ?", [attachment, card_id]).fetchone()
        if row is None:
            raise bm.BoardReadError("invalid_target")
        descriptor = bm.artifact_descriptor(row)
        stored = bm._decoded(row["stored_path"])
        if descriptor is None or not isinstance(stored, str) or not stored or "\0" in stored:
            raise bm.BoardReadError("invalid_target")
        return descriptor, stored

    return bm._read(db, body)


def _contained_file(slug: str, stored: str) -> tuple:
    """``(path, stat)``: the stored file, resolved, under stock
    ``attachments_root(board)`` and a regular file. Stock's dashboard makes
    the same check before it serves an attachment."""
    from hermes_cli.kanban_db import attachments_root
    try:
        base = Path(attachments_root(board=slug)).expanduser().resolve()
        path = Path(stored).resolve(strict=True)
        path.relative_to(base)
        info = os.stat(path)
    except (OSError, ValueError, RuntimeError):
        raise bm.BoardReadError("invalid_target") from None
    if not stat.S_ISREG(info.st_mode):
        raise bm.BoardReadError("invalid_target")
    return path, info


def _copy(path: Path, seen: os.stat_result, directory: Path) -> tuple:
    """Copy the checked file into ``directory`` (mode 0600), refusing one that
    changed under the check or grew past the cap. Answers ``(copy, size)``."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        source = os.open(path, flags)
    except OSError:
        raise bm.BoardReadError("invalid_target") from None
    target = directory / "artifact"
    try:
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != (seen.st_dev, seen.st_ino):
            raise bm.BoardReadError("invalid_target")
        if info.st_size > ARTIFACT_MAX_BYTES:
            raise bm.BoardReadError("too_large")
        size = 0
        out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            while True:
                chunk = os.read(source, _COPY_CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > ARTIFACT_MAX_BYTES:
                    raise bm.BoardReadError("too_large")
                os.write(out, chunk)
        finally:
            os.close(out)
    except OSError:
        raise bm.BoardReadError("temporarily_unavailable") from None
    finally:
        os.close(source)
    return target, size


def open_artifact(root: Path, payload, profile: str, capabilities: list) -> dict:
    """Stage one card artifact for the phone. Answers its token, curated name
    and type, size and part count."""
    from .board_create import _gateway
    slug, anchor, card_id, attachment = _parse(payload)
    require(capabilities)
    slug, db, meta = bm._target(root, {"slug": slug})
    descriptor, stored = _row(root, db, anchor, card_id, attachment)
    path, seen = _contained_file(slug, stored)
    if seen.st_size > ARTIFACT_MAX_BYTES:
        raise bm.BoardReadError("too_large")
    # Capability and authority, again, right before the copy.
    require(bm.board_capabilities())
    require(capabilities)
    bmt.sweep(dirname=STAGE_DIRNAME)
    gateway = _gateway()
    directory = bmt.stage_dir(STAGE_DIRNAME)
    try:
        copy, size = _copy(path, seen, directory)
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    parts = bmt.stage(KIND, directory, copy, size, gateway, profile)
    artifact = {"token": directory.name, "card": card_id, "attachment": attachment, "name": descriptor["name"],
                "size": size, "parts": parts}
    if "contentType" in descriptor:
        artifact["contentType"] = descriptor["contentType"]
    return {"target": {"slug": slug, "name": bm._metadata(slug, meta)["name"]}, "artifact": artifact}


def part(payload, profile: str, capabilities: list) -> dict:
    """One part of a staged artifact, in order, once."""
    from .board_create import _gateway
    if not isinstance(payload, dict) or set(payload) != {"token", "part"}:
        raise bm.BoardReadError("invalid_request")
    token, index = payload["token"], payload["part"]
    if not isinstance(token, str) or not _TOKEN.match(token):
        raise bm.BoardReadError("invalid_request")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise bm.BoardReadError("invalid_request")
    require(capabilities)
    chunk, parts = bmt.read_part(KIND, token, index, _gateway(), profile)
    return {"artifact": {"token": token, "part": index, "parts": parts,
                         "data": base64.b64encode(chunk).decode("ascii")}}
