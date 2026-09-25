"""Hermes Board comments (#3058); contract in docs/hermes-board/contract.md.

``board.comment`` adds the wearer's note to a card without changing the
card's state. It ships the "at most once" form the P0.1 proof enabled on both
pins (0.21.1 ``2237be35``, 0.21.3 ``345cd2b0``;
docs/hermes-board/p0.1-3040-answer-and-comment.md), with #3055's receipts
around it. The only Hermes write is stock ``hermes_cli.kanban_db.add_comment``.

Stock Hermes has no comment idempotency: nothing native names the operation,
and the proof shows a crash after the insert reads exactly like a second
client adding the same text. So this is *at most once*, never exactly once:

1. **Receipt first.** ``board_ops.begin`` writes a ``pending`` receipt bound
   to the scope, the board instance and the intent (card, text) before
   anything touches Hermes. The receipt's live writer is the op lock: a
   same-key request beside it answers ``outcome_unknown`` and is never run.
2. **Checks.** The board exists, is the instance the phone saw and needs no
   migration (#3055's checks); the ``comment`` capability is read again; the
   card must still be on that board.
3. **Watermark.** The card's newest comment id is recorded in the receipt
   before ``add_comment`` runs.
4. ``add_comment(author="ocuclaw", body=<text>)``. The author is fixed text;
   no operation key reaches Hermes.
5. **Done receipt**, then the answer.

A pending receipt whose writer died is settled from native records only and
never resent: no watermark, or no comment above it, means nothing landed
(``refused`` / ``expired_request``); any comment above it is
``outcome_unknown``, because it may be this op's or another client's. Prose
is never compared.

``barrier`` is the contract suite's seam, as in ``board_create``.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable, Optional

from . import board_create as bc
from . import board_management as bm
from . import board_ops

OPERATION = "board.comment"
PAYLOAD_KEYS = {"slug", "anchor", "id", "key", "body"}
#: The longest comment. The card sheet's timeline shows this much of one.
BODY_MAX = bm.COMMENT_MAX
#: Every OcuClaw comment's author. Fixed text: the operation key is never in it.
AUTHOR = "ocuclaw"

#: Named points, in order. ``receipted``: the pending receipt is durable,
#: nothing native is written. ``checked``: the checks passed, nothing native
#: is written. ``marked``: the watermark is durable, the comment not written.
#: ``committed``: the comment is committed natively, the receipt is still
#: pending. ``succeeded``: the receipt is final, the answer not sent.
POINTS = ("receipted", "checked", "marked", "committed", "succeeded")
barrier: Callable[[str], None] = lambda point: None

_PROSE_REFUSED = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")


# --------------------------------------------------------------------------
# Request
# --------------------------------------------------------------------------

def parse(payload) -> tuple:
    """``(slug, anchor, key, intent)`` or ``invalid_request``. The intent is
    what the receipt digests: the card and the trimmed text."""
    if not isinstance(payload, dict) or set(payload) != PAYLOAD_KEYS:
        raise bm.BoardReadError("invalid_request")
    slug, anchor, key = payload["slug"], payload["anchor"], payload["key"]
    card_id, body = payload["id"], payload["body"]
    if not isinstance(slug, str) or not bm._SLUG.match(slug):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(anchor, str) or not bm._ANCHOR.match(anchor):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(key, str) or not board_ops.KEY.match(key):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(card_id, str) or not bm._CARD_ID.match(card_id):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(body, str):
        raise bm.BoardReadError("invalid_request")
    body = body.strip()
    if not body or len(body) > BODY_MAX or _PROSE_REFUSED.search(body):
        raise bm.BoardReadError("invalid_request")
    return slug, anchor, key, {"card": card_id, "body": body}


# --------------------------------------------------------------------------
# Native reads
# --------------------------------------------------------------------------

def _card_state(conn, card_id: str) -> Optional[str]:
    row = conn.execute("SELECT status FROM tasks WHERE id = ?", [card_id]).fetchone()
    if row is None:
        return None
    state = bm._decoded(row[0])
    return state if isinstance(state, str) and bm._STATUS.match(state) else "unknown"


def watermark(conn, card_id: str) -> int:
    """The card's newest comment id (0 when it has none)."""
    row = conn.execute("SELECT COALESCE(MAX(id), 0) FROM task_comments WHERE task_id = ?", [card_id]).fetchone()
    return int(row[0] or 0)


def comments_above(db: Path, card_id: str, mark: int) -> int:
    """How many comments the card has above ``mark``, read-only. Any author:
    a comment by anyone else is indistinguishable after a crash."""
    return int(bm._read(db, lambda conn: conn.execute(
        "SELECT COUNT(*) FROM task_comments WHERE task_id = ? AND id > ?", [card_id, int(mark)]).fetchone()[0]))


# --------------------------------------------------------------------------
# Operation
# --------------------------------------------------------------------------

def _gateway() -> str:
    from .board_moments import gateway_id
    return gateway_id()


def _capability(capabilities: list) -> None:
    row = next((r for r in capabilities if r["key"] == "comment"), None)
    if row is None or not row.get("enabled"):
        raise bm.BoardReadError((row or {}).get("code") or "unsupported")


def wire_receipt(receipt: dict) -> dict:
    """The receipt as the phone reads it: key, ``comment``, state, and the
    card (succeeded) or the code (refused)."""
    result = receipt.get("result") or {}
    out = {"key": receipt["key"], "operation": "comment", "state": receipt["state"]}
    if receipt["state"] == "succeeded" and isinstance(result.get("card"), dict):
        out["card"] = result["card"]
    if receipt["state"] == "refused":
        out["code"] = receipt.get("code") or "invalid_request"
    return out


def _answer(slug: str, meta: Path, receipt: dict) -> dict:
    return {"target": {"slug": slug, "name": bm._metadata(slug, meta)["name"]},
            "receipt": wire_receipt(receipt)}


def add(root: Path, payload, profile: str, capabilities: list) -> dict:
    slug, anchor, key, intent = parse(payload)
    _capability(capabilities)
    db, meta = bm.board_paths(root, slug)
    try:
        receipt = board_ops.begin(key, gateway=_gateway(), profile=profile, operation=OPERATION, board=slug,
                                  anchor=anchor, intent_digest=board_ops.digest(intent), native_key="",
                                  pending={"id": intent["card"]})
    except board_ops.OpRefused as refusal:
        raise bm.BoardReadError(refusal.code) from None
    except board_ops.OpStoreError:
        # Nothing is written to Hermes without a durable pending receipt.
        raise bm.BoardReadError("temporarily_unavailable") from None
    if receipt.get("fresh"):
        barrier("receipted")
        receipt = _execute(root, slug, anchor, intent, key)
        if receipt["state"] == "succeeded":
            barrier("succeeded")
    elif receipt.get("taken_over"):
        # Same key after the gateway that sent it died: settled from native
        # records, never sent again.
        receipt = _resolve(root, receipt, db, board_ops.current_writer())
    if receipt["state"] == "pending":
        # Another live attempt with this key is still running: the phone looks
        # the key up, it never sends the comment twice.
        raise bm.BoardReadError("outcome_unknown")
    if receipt["state"] != "succeeded":
        raise bm.BoardReadError(receipt.get("code") or receipt["state"])
    return _answer(slug, meta, receipt)


def _refuse(key: str, code: str) -> dict:
    return board_ops.finish(key, "refused", code=code)


def _execute(root: Path, slug: str, anchor: str, intent: dict, key: str) -> dict:
    """Checks, the watermark, the comment and the final receipt, for a receipt
    this attempt wrote."""
    writer = board_ops.current_writer()
    try:
        db, _meta = bc._ready(root, slug, anchor)
        # Capability and authority, again, right before the write.
        _capability(bm.board_capabilities())
        state = bm._read(db, lambda conn: _card_state(conn, intent["card"]))
    except bm.BoardReadError as refusal:
        return _refuse(key, refusal.code)
    except OSError:
        return _refuse(key, "temporarily_unavailable")
    if state is None:
        return _refuse(key, "invalid_target")
    barrier("checked")
    import hermes_cli.kanban_db as kb
    from hermes_cli.kanban_db_connect import connect
    try:
        conn = connect(db_path=db)
    except Exception:  # noqa: BLE001 - nothing was written
        return _refuse(key, "temporarily_unavailable")
    try:
        return _write(conn, kb, db, intent, key, writer)
    finally:
        conn.close()


def _write(conn, kb, db: Path, intent: dict, key: str, writer: tuple) -> dict:
    card_id = intent["card"]
    try:
        mark = watermark(conn, card_id)
    except Exception:  # noqa: BLE001 - nothing was written
        return _refuse(key, "temporarily_unavailable")
    try:
        marked = board_ops.note(key, {"mark": mark}, writer=writer)
    except board_ops.OpStoreError:
        marked = False
    if not marked:
        # The comment is never written without its watermark on record.
        return _refuse(key, "temporarily_unavailable")
    barrier("marked")
    try:
        kb.add_comment(conn, card_id, AUTHOR, intent["body"])
    except Exception as exc:  # noqa: BLE001 - native state decides, never the exception text
        return _after_failure(db, intent, key, mark, isinstance(exc, ValueError))
    barrier("committed")
    try:
        state = _card_state(conn, card_id)
    except Exception:  # noqa: BLE001
        state = None
    return board_ops.finish(key, "succeeded", result={
        "id": card_id, "mark": mark, "card": {"id": card_id, "state": state or "unknown"}})


def _after_failure(db: Path, intent: dict, key: str, mark: int, refused_by_stock: bool) -> dict:
    """``add_comment`` raised. Nothing above the watermark means it did not
    land (stock refuses a card that is gone with ``ValueError`` before its
    insert); anything above it may be this op's, so it cannot tell."""
    try:
        later = comments_above(db, intent["card"], mark)
    except Exception:  # noqa: BLE001
        return board_ops.finish(key, "outcome_unknown")
    if later:
        return board_ops.finish(key, "outcome_unknown")
    return _refuse(key, "invalid_target" if refused_by_stock else "temporarily_unavailable")


def _resolve(root: Path, receipt: dict, db: Path, writer: tuple) -> dict:
    """A pending receipt whose writer died, settled for ``writer`` (the
    process that now owns it) from native records. Never writes Hermes and
    never resends the comment."""
    pending = receipt.get("result") or {}
    try:
        mark = pending.get("mark")
        if mark is None:
            # It died before its watermark: add_comment never ran.
            return board_ops.finish(receipt["key"], "refused", code="expired_request", writer=writer)
        try:
            same = db.is_file() and bm.board_anchor(root, bm._file_identity(db)) == receipt["anchor"]
            later = comments_above(db, pending.get("id", ""), int(mark)) if same else None
        except (bm.BoardReadError, OSError):
            # Busy or unreadable now: still pending, ask again.
            return receipt
        if later == 0:
            return board_ops.finish(receipt["key"], "refused", code="expired_request", writer=writer)
        return board_ops.finish(receipt["key"], "outcome_unknown", writer=writer)
    except board_ops.OpStoreError:
        return receipt


def looked_up(root: Path, receipt: dict) -> dict:
    """``board.receipt`` for a comment: the receipt, a dead writer's pending
    one settled from native records first. Never writes Hermes."""
    slug = receipt["board"]
    db, meta = bm.board_paths(root, slug)
    if receipt["state"] == "pending" and not board_ops.writer_live(receipt):
        receipt = _resolve(root, receipt, db, (receipt.get("writer_pid"), receipt.get("writer_start")))
    return _answer(slug, meta, receipt)
