"""Hermes Board split (#3060); contract in docs/hermes-board/contract.md.

``board.decompose`` asks Hermes to split one triage card into a small graph
of child cards, with stock ``hermes_cli.kanban_decompose.decompose_task`` on
both pins (0.21.1 ``2237be35``, 0.21.3 ``345cd2b0``). Stock asks the
auxiliary ``kanban_decomposer`` model for the graph, then creates the
children, links them under the card and moves the card ``triage -> todo`` in
one transaction; a reply that is one unit of work tightens the card instead
(stock's ``specify`` path). Either way the card leaves triage.

It is not idempotent: the same request twice would ask the model twice. So:

1. **Receipt first**, as for create (``board_ops.begin``): key, scope, board
   instance and the card named. A retry never runs the split again; a same
   key answer comes from the receipt.
2. **Checks.** The board exists, is the instance the phone saw and needs no
   create or migrate (the create checks), the card is on it and in triage,
   the decomposer model is configured (Hermes' own ``triage_aux_status``:
   an explicit ``auxiliary.kanban_decomposer`` slot, or a main model the
   ``auto`` slot falls back to), and ``dependencies`` is on, again, right
   before the call.
3. **Call** ``decompose_task`` under ``scoped_current_board(slug)``, after
   checking that the board it resolves there is the chosen board's store
   (an ambient ``HERMES_KANBAN_DB`` would win over the scope).
4. **Receipt final.** A reply that did not split is decided by reading the
   card: stock applies nothing on ``ok=False``, and both applied outcomes
   move the card out of triage.

A dropped answer is never a reason to split again: the phone looks the
receipt up. A pending receipt whose writer died (or was orphaned in this
process) resolves from the card: still in triage means nothing happened
(``expired_request``); anything else is ``outcome_unknown``.

``barrier`` is a seam for the contract suite, as in ``board_create``.
"""
from __future__ import annotations

import secrets
import threading
from pathlib import Path
from typing import Callable, Optional

from . import board_create as bcreate
from . import board_management as bm
from . import board_ops

OPERATION = "board.decompose"
PAYLOAD_KEYS = {"slug", "anchor", "key", "id"}
#: Who the stock audit trail names for a split from the phone.
AUTHOR = "ocuclaw"
#: The model call's own timeout. The control link waits 30 s for a management
#: answer; a slower split still lands, and the phone reads its receipt.
MODEL_TIMEOUT_SECONDS = 25
#: Child ids a receipt carries (stock asks for 2-6).
CHILDREN_MAX = 20

#: Named points: ``receipted`` (pending receipt durable, nothing asked) and
#: ``decomposed`` (stock returned, receipt still pending).
POINTS = ("receipted", "decomposed")
barrier: Callable[[str], None] = lambda point: None

#: Keys whose split runs in this process now. A pending receipt this process
#: owns but is not running is orphaned, and resolves like a dead writer's.
_INFLIGHT: set = set()
_LOCK = threading.Lock()


def parse(payload) -> tuple:
    if not isinstance(payload, dict) or set(payload) != PAYLOAD_KEYS:
        raise bm.BoardReadError("invalid_request")
    slug, anchor, key, card_id = (payload.get(k) for k in ("slug", "anchor", "key", "id"))
    if not isinstance(slug, str) or not bm._SLUG.match(slug):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(anchor, str) or not bm._ANCHOR.match(anchor):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(key, str) or not board_ops.KEY.match(key):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(card_id, str) or not bm._CARD_ID.match(card_id):
        raise bm.BoardReadError("invalid_request")
    return slug, anchor, key, card_id


def decomposer_configured() -> bool:
    """Hermes' own answer to "can a triage card be decomposed here": the
    ``kanban_decomposer`` aux slot is set, or its ``auto`` default has a main
    model to fall back to. Unreadable config is not configured."""
    try:
        from hermes_cli.config import load_config_readonly
        from hermes_cli.kanban_diagnostics import triage_aux_status
        status = triage_aux_status(load_config_readonly())
    except Exception:
        return False
    return bool(status) and bool(status.get("decomposer_explicit") or status.get("main_model_visible"))


def _capability(capabilities: list) -> None:
    bcreate._capability(capabilities, "dependencies")


def wire_receipt(receipt: dict) -> dict:
    """``{key, operation: "decompose", state}`` plus the split (succeeded)
    or the code (refused)."""
    out = {"key": receipt["key"], "operation": "decompose", "state": receipt["state"]}
    result = receipt.get("result") or {}
    if receipt["state"] == "succeeded" and isinstance(result.get("id"), str):
        out["split"] = {"id": result["id"], "fanout": bool(result.get("fanout")),
                        "children": [c for c in result.get("children") or [] if isinstance(c, str)][:CHILDREN_MAX]}
    if receipt["state"] == "refused":
        out["code"] = receipt.get("code") or "invalid_request"
    return out


def _answer(slug: str, meta: Path, receipt: dict) -> dict:
    return {"target": {"slug": slug, "name": bm._metadata(slug, meta)["name"]},
            "receipt": wire_receipt(receipt)}


def _card_state(db: Path, card_id: str) -> Optional[str]:
    """The card's status, or None when it is not on the board. Raises when
    the store cannot be read."""
    def body(conn):
        return conn.execute("SELECT status FROM tasks WHERE id = ?", [card_id]).fetchone()
    row = bm._read(db, body)
    return None if row is None else str(row[0])


def _card_ready(db: Path, card_id: str) -> None:
    """``invalid_target`` when the card is not on the board, ``stale_target``
    when it left triage or was split before."""
    def body(conn):
        row = conn.execute("SELECT status FROM tasks WHERE id = ?", [card_id]).fetchone()
        if row is None:
            raise bm.BoardReadError("invalid_target")
        if row[0] != "triage":
            raise bm.BoardReadError("stale_target")
        if conn.execute("SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'decomposed' LIMIT 1",
                        [card_id]).fetchone() is not None:
            raise bm.BoardReadError("stale_target")
    bm._read(db, body)


def decompose(root: Path, payload, profile: str, capabilities: list) -> dict:
    slug, anchor, key, card_id = parse(payload)
    _capability(capabilities)
    db, meta = bm.board_paths(root, slug)
    gateway = bcreate._gateway()
    with _LOCK:
        if key in _INFLIGHT:
            # The same key is splitting in this process now: its answer is not known yet.
            raise bm.BoardReadError("outcome_unknown")
        _INFLIGHT.add(key)
    try:
        attempt = secrets.token_hex(8)
        try:
            receipt = board_ops.begin(key, gateway=gateway, profile=profile, operation=OPERATION, board=slug,
                                      anchor=anchor, intent_digest=board_ops.digest({"id": card_id}),
                                      native_key="", pending={"id": card_id, "attempt": attempt})
        except board_ops.OpRefused as refusal:
            raise bm.BoardReadError(refusal.code) from None
        except board_ops.OpStoreError:
            # Nothing is asked of Hermes without a durable pending receipt.
            raise bm.BoardReadError("temporarily_unavailable") from None
        if receipt["state"] == "pending":
            if (receipt.get("result") or {}).get("attempt") == attempt:
                barrier("receipted")
                receipt = _execute(root, slug, anchor, card_id, key, capabilities)
            else:
                # An earlier attempt with this key: never split again. Resolve it if its
                # writer is gone; a live one elsewhere is still unknown from here.
                receipt = _settle(root, receipt, db, held=True)
        if receipt["state"] != "succeeded":
            raise bm.BoardReadError(receipt.get("code") if receipt["state"] == "refused" else "outcome_unknown")
        return _answer(slug, meta, receipt)
    finally:
        with _LOCK:
            _INFLIGHT.discard(key)


def _refuse(key: str, code: str) -> dict:
    return board_ops.finish(key, "refused", code=code)


def _execute(root: Path, slug: str, anchor: str, card_id: str, key: str, capabilities: list) -> dict:
    """Checks, the stock call and the final receipt, for a pending receipt this attempt wrote."""
    try:
        db, _meta = bcreate._ready(root, slug, anchor)
        _card_ready(db, card_id)
        if not decomposer_configured():
            return _refuse(key, "not_configured")
        # Capability and authority, again, right before the call.
        _capability(bm.board_capabilities())
        _capability(capabilities)
    except bm.BoardReadError as refusal:
        return _refuse(key, refusal.code)
    except OSError:
        return _refuse(key, "temporarily_unavailable")
    outcome = None
    try:
        from hermes_cli.kanban_db import kanban_db_path, scoped_current_board
        from hermes_cli.kanban_decompose import decompose_task
        with scoped_current_board(slug):
            # Stock resolves the store from the context; HERMES_KANBAN_DB in this process would
            # win over the scope. Split only when it resolves to the chosen board's store.
            if Path(kanban_db_path()).resolve() != db.resolve():
                return _refuse(key, "not_configured")
            outcome = decompose_task(card_id, author=AUTHOR, timeout=MODEL_TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001 - decided by reading the card, never the exception text
        outcome = None
    barrier("decomposed")
    if outcome is not None and getattr(outcome, "ok", False):
        children = [c for c in (getattr(outcome, "child_ids", None) or []) if isinstance(c, str)]
        return board_ops.finish(key, "succeeded", result={
            "id": card_id, "fanout": bool(getattr(outcome, "fanout", False)), "children": children[:CHILDREN_MAX]})
    try:
        status = _card_state(db, card_id)
    except (bm.BoardReadError, OSError):
        return board_ops.finish(key, "outcome_unknown")
    if outcome is not None:
        # Stock applied nothing (ok=False). A card that left triage moved on its own.
        return _refuse(key, "temporarily_unavailable" if status == "triage" else "stale_target")
    # The call raised: still in triage means nothing was applied; otherwise it cannot tell.
    if status == "triage":
        return _refuse(key, "temporarily_unavailable")
    return board_ops.finish(key, "outcome_unknown")


def _orphaned(receipt: dict, *, held: bool) -> bool:
    """A pending receipt nobody is running: its writer died, or it is this
    process's and not in flight here (``held``: the caller holds the key)."""
    if not board_ops.writer_live(receipt):
        return True
    pid, start = board_ops._writer()
    if (receipt.get("writer_pid"), receipt.get("writer_start")) != (pid, start):
        return False
    if held:
        return True
    with _LOCK:
        return receipt["key"] not in _INFLIGHT


def _settle(root: Path, receipt: dict, db: Path, *, held: bool) -> dict:
    """Resolve an orphaned pending receipt from the card on the board
    instance it named: still in triage (and never split) is ``expired_request``;
    anything else, or another board instance, is ``outcome_unknown``."""
    if receipt["state"] != "pending" or not _orphaned(receipt, held=held):
        return receipt
    writer = (receipt.get("writer_pid"), receipt.get("writer_start"))
    card_id = (receipt.get("result") or {}).get("id")
    try:
        same = db.is_file() and bm.board_anchor(root, bm._file_identity(db)) == receipt["anchor"]
        untouched = False
        if same and isinstance(card_id, str):
            try:
                _card_ready(db, card_id)
                untouched = True
            except bm.BoardReadError as gone:
                if gone.code not in ("invalid_target", "stale_target"):
                    raise
    except (bm.BoardReadError, OSError):
        # Busy or unreadable now: still pending, ask again.
        return receipt
    try:
        if untouched:
            return board_ops.finish(receipt["key"], "refused", code="expired_request", writer=writer)
        return board_ops.finish(receipt["key"], "outcome_unknown", writer=writer)
    except board_ops.OpStoreError:
        return receipt


def lookup_receipt(root: Path, receipt: dict) -> dict:
    """``board.receipt`` for a split. Never writes Hermes."""
    slug = receipt["board"]
    db, meta = bm.board_paths(root, slug)
    receipt = _settle(root, receipt, db, held=False)
    return _answer(slug, meta, receipt)
