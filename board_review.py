"""Hermes Board verdicts (#3056); contract in docs/hermes-board/contract.md.

``board.verdict`` is Approve or Request changes on a card in review, bound
to the review the wearer saw. It ships the claim-then-inspect composition
the P0.1 proof established on both pins (0.21.1 ``2237be35``, 0.21.3
``345cd2b0``; docs/hermes-board/p0.1-3039-verdict-binding.md), with
#3055's receipts around it. Every Hermes write is a stock
``hermes_cli.kanban_db`` call; nothing is patched.

1. **Token.** ``board.card`` names the review in force: ``attentionEvent``
   (the newest ``review_requested`` event id) and ``attentionHash`` (a hash
   of that whole event row). The phone sends both back with the verdict.
2. **Receipt first.** ``board_ops.begin`` writes a ``pending`` receipt bound
   to the scope, the board instance and the intent (card, verdict, token,
   reason) before anything touches Hermes.
3. **Checks.** The board exists, is the instance the phone saw and needs no
   migration (#3055's checks); the verdict's capability is read again; a
   read-only pre-check refuses a card that is gone or no longer on that
   review without writing anything. Passing it proves nothing on its own: a
   rework can land before the claim.
4. **Claim.** ``claim_review_task(claimer=<op lock>, ttl_seconds=30)``: an
   atomic ``review -> running`` CAS. The op lock is derived from the
   operation key, so it is unique per attempt and names the op on the
   native ``claimed`` event.
5. **Inspect, after the claim.** The review in force at claim time (the
   newest ``review_requested`` row below this run's ``claimed`` row) must be
   the token's row, and nothing but earlier OcuClaw claim lifecycles may sit
   between them. Anything else refuses (``stale_target``).
6. **Issued.** The receipt records the run before the decision call. From
   here a lost answer can never be retried: a restarted gateway reads the
   run's native outcome instead.
7. **Decide.** Approve is ``complete_task(expected_run_id=run)``; Request
   changes is ``request_changes(reason, expected_run_id=run)``. Both CAS on
   ``current_run_id``, which only this claim opened. ``force`` is never
   passed (0.21.1 and 0.21.3 have no such argument; 0.21.4 and later add it
   as an operator override that defaults off).
8. **Release.** On any refusal after the claim the op hands its own claim
   back at once, so the card is in the same review again with no review
   event minted and no sweep needed. First ``heartbeat_claim(claimer=<op
   lock>)``, a CAS on this op's lock: it proves the claim is still ours and
   re-arms it, so no stale-claim sweep can take it in between. Then stock
   ``reclaim_task``, which restores the run's source phase (``review``),
   records ``reclaimed`` and ends the run. A claim that is no longer ours is
   left alone. Recovery does the same when it finds this op's claim still
   held. If the reclaim itself fails, the claim is shortened to one second as
   a fallback, for the engine's sweep.

Native task completion is broader than a human Approve (it also takes
``ready``, ``blocked`` and ``running`` cards); it is only ever called here
for a run this op claimed from the review it inspected.

``barrier`` is the contract suite's seam, as in ``board_create``.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Callable, Optional

from . import board_create as bc
from . import board_management as bm
from . import board_ops
from .board_tail import EVENT_COLS, event_hash

OPERATION = "board.verdict"
#: The verdicts, each named as its capability key.
VERDICTS = ("approve", "request_changes")
#: Verdict -> the native run outcome it produces.
VERDICT_OUTCOME = {"approve": "completed", "request_changes": "changes_requested"}
PAYLOAD_KEYS = {"slug", "anchor", "id", "key", "verdict", "attentionEvent", "attentionHash", "reason"}
REASON_MAX = 1000
#: Prefix of every OcuClaw verdict claim lock. The inspection only tolerates
#: earlier claim lifecycles that carry it.
OP_PREFIX = "ocuclaw-verdict:"
#: The claim's bound. A decision takes milliseconds; a refusal hands the claim
#: back at once. Only a crash nobody looks up leaves it to lapse, and then the
#: card is back in review after this plus one sweep. The default native TTL
#: (15 minutes) is far too long.
CLAIM_TTL_SECONDS = 30
#: Fallback only: a refused op whose reclaim failed shortens its own claim to
#: this (the engine clamps to 1 s) and leaves it to the sweep.
RELEASE_TTL_SECONDS = 1
#: The reason ``reclaim_task`` records on the ended run and its event.
RELEASE_REASON = "OcuClaw verdict not applied"
#: Approve's result text on the card.
APPROVE_RESULT = "Approved from OcuClaw."

#: Named points, in order. ``receipted``: the pending receipt is durable,
#: nothing native is written. ``checked``: the pre-check passed, nothing
#: native is written. ``claimed``: the claim is committed. ``issued``: the
#: inspection passed and the receipt records the run; the decision is not
#: called yet. ``decided``: the verdict is committed natively, the receipt is
#: still pending. ``succeeded``: the receipt is final, the answer not sent.
POINTS = ("receipted", "checked", "claimed", "issued", "decided", "succeeded")
barrier: Callable[[str], None] = lambda point: None

_HASH = re.compile(r"^[0-9a-f]{64}$")
_PROSE_REFUSED = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")
_EVENT_SQL = ", ".join(EVENT_COLS)
_CLAIM_LIFECYCLE = ("claimed", "reclaimed", "claim_extended")
#: ``request_changes`` refusals that mean the card moved on (else the
#: review itself cannot take the verdict).
_MOVED_ON = ("task is not in an active review run", "run_id mismatch", "task changed during review handoff",
             "active run was not claimed from review")


# --------------------------------------------------------------------------
# Request
# --------------------------------------------------------------------------

def parse(payload) -> tuple:
    """``(slug, anchor, key, intent)`` or ``invalid_request``. The intent is
    what the receipt digests: the card, the verdict, the review token and the
    reason."""
    if not isinstance(payload, dict) or set(payload) - PAYLOAD_KEYS:
        raise bm.BoardReadError("invalid_request")
    slug, anchor, key = payload.get("slug"), payload.get("anchor"), payload.get("key")
    card_id, verdict = payload.get("id"), payload.get("verdict")
    event, digest = payload.get("attentionEvent"), payload.get("attentionHash")
    if not isinstance(slug, str) or not bm._SLUG.match(slug):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(anchor, str) or not bm._ANCHOR.match(anchor):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(key, str) or not board_ops.KEY.match(key):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(card_id, str) or not bm._CARD_ID.match(card_id):
        raise bm.BoardReadError("invalid_request")
    if verdict not in VERDICTS:
        raise bm.BoardReadError("invalid_request")
    if isinstance(event, bool) or not isinstance(event, int) or event < 1:
        raise bm.BoardReadError("invalid_request")
    if not isinstance(digest, str) or not _HASH.match(digest):
        raise bm.BoardReadError("invalid_request")
    reason = payload.get("reason")
    if verdict == "request_changes":
        # Request changes needs a reason: what the worker should fix.
        if not isinstance(reason, str):
            raise bm.BoardReadError("invalid_request")
        reason = reason.strip()
        if not reason or len(reason) > REASON_MAX or _PROSE_REFUSED.search(reason):
            raise bm.BoardReadError("invalid_request")
    elif reason is not None:
        raise bm.BoardReadError("invalid_request")
    intent = {"card": card_id, "verdict": verdict, "event": event, "hash": digest, "reason": reason}
    return slug, anchor, key, intent


def op_lock(gateway: str, profile: str, slug: str, key: str) -> str:
    """The claim lock for one attempt. Deterministic, so recovery finds the
    op's run on the native ``claimed`` event; a phone key never reaches Hermes."""
    raw = f"{gateway}\0{profile}\0{slug}\0{key}".encode()
    return OP_PREFIX + hashlib.sha256(raw).hexdigest()[:32]


# --------------------------------------------------------------------------
# The review token (read side)
# --------------------------------------------------------------------------

def _rows(conn):
    """A read-only Board connection that yields rows by column name."""
    conn.row_factory = sqlite3.Row
    return conn


def _payload(row) -> dict:
    raw = row["payload"]
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _latest_review(conn, card_id: str, before: Optional[int] = None):
    sql = "SELECT " + _EVENT_SQL + " FROM task_events WHERE task_id = ? AND kind = 'review_requested'"
    params: list = [card_id]
    if before is not None:
        sql += " AND id < ?"
        params.append(int(before))
    return conn.execute(sql + " ORDER BY id DESC LIMIT 1", params).fetchone()


def _precheck(conn, intent: dict) -> Optional[str]:
    """Read-only: None while the card is in review on the token's review,
    else the code to refuse with. Nothing is claimed for a refusal here."""
    row = conn.execute("SELECT status FROM tasks WHERE id = ?", [intent["card"]]).fetchone()
    if row is None:
        return "invalid_target"
    if row["status"] != "review":
        return "stale_target"
    review = _latest_review(conn, intent["card"])
    if review is None or int(review["id"]) != intent["event"] or event_hash(review) != intent["hash"]:
        return "stale_target"
    return None


def inspect(conn, intent: dict, run_id: int, lock: str) -> Optional[str]:
    """After the claim: None when ``run_id`` was claimed by ``lock`` while the
    token's review was the one in force, else why not. The #3039 inspection."""
    card_id = intent["card"]
    claimed = conn.execute(
        "SELECT " + _EVENT_SQL + " FROM task_events WHERE task_id = ? AND run_id = ? AND kind = 'claimed' ORDER BY id LIMIT 1",
        (card_id, int(run_id)),
    ).fetchone()
    if claimed is None:
        return "claim_provenance_missing"
    p = _payload(claimed)
    if p.get("lock") != lock or p.get("source_status") != "review":
        return "claim_provenance_mismatch"
    review = _latest_review(conn, card_id, before=claimed["id"])
    if review is None or int(review["id"]) != intent["event"]:
        return "review_changed"
    if event_hash(review) != intent["hash"]:
        return "review_rewritten"
    ours: set = set()
    for e in conn.execute(
        "SELECT " + _EVENT_SQL + " FROM task_events WHERE task_id = ? AND id > ? AND id < ? ORDER BY id",
        (card_id, int(review["id"]), int(claimed["id"])),
    ).fetchall():
        ep = _payload(e)
        if (e["kind"] == "claimed" and ep.get("source_status") == "review"
                and str(ep.get("lock", "")).startswith(OP_PREFIX)):
            ours.add(e["run_id"])
            continue
        if e["kind"] in _CLAIM_LIFECYCLE and e["run_id"] in ours:
            continue
        return f"activity_since_review:{e['kind']}"
    return None


def _settled(db: Path, card_id: str, run_id: int, lock: str, verdict: str) -> str:
    """What native state says about an issued decision on ``run_id``:
    ``open`` (still this op's claim: the decision never committed),
    ``other`` (the run ended some other way: the verdict did not apply), or
    ``unknown`` (it ended as the verdict would end it, which an unscoped
    terminal command can do too, or the state reads inconsistently)."""
    def body(conn):
        conn = _rows(conn)
        task = conn.execute("SELECT status, current_run_id, claim_lock FROM tasks WHERE id = ?",
                            [card_id]).fetchone()
        run = conn.execute("SELECT outcome, ended_at FROM task_runs WHERE id = ? AND task_id = ?",
                           [int(run_id), card_id]).fetchone()
        return task, run

    task, run = bm._read(db, body)
    if run is None:
        return "unknown"
    if run["outcome"] is None and run["ended_at"] is None:
        if (task is not None and task["status"] == "running" and task["current_run_id"] == int(run_id)
                and task["claim_lock"] == lock):
            return "open"
        return "unknown"
    return "unknown" if run["outcome"] == VERDICT_OUTCOME[verdict] else "other"


# --------------------------------------------------------------------------
# Operation
# --------------------------------------------------------------------------

def _gateway() -> str:
    from .board_moments import gateway_id
    return gateway_id()


def _capability(capabilities: list, verdict: str) -> None:
    row = next((r for r in capabilities if r["key"] == verdict), None)
    if row is None or not row.get("enabled"):
        raise bm.BoardReadError((row or {}).get("code") or "unsupported")


def wire_receipt(receipt: dict) -> dict:
    """The receipt as the phone reads it: key, the verdict as its operation,
    state, and the card (succeeded) or the code (refused)."""
    pending = receipt.get("result") or {}
    out = {"key": receipt["key"], "operation": pending.get("verdict", "approve"), "state": receipt["state"]}
    if receipt["state"] == "succeeded" and isinstance(pending.get("card"), dict):
        out["card"] = pending["card"]
    if receipt["state"] == "refused":
        out["code"] = receipt.get("code") or "invalid_request"
    return out


def _answer(slug: str, meta: Path, receipt: dict) -> dict:
    return {"target": {"slug": slug, "name": bm._metadata(slug, meta)["name"]},
            "receipt": wire_receipt(receipt)}


def decide(root: Path, payload, profile: str, capabilities: list) -> dict:
    slug, anchor, key, intent = parse(payload)
    _capability(capabilities, intent["verdict"])
    db, meta = bm.board_paths(root, slug)
    gateway = _gateway()
    lock = op_lock(gateway, profile, slug, key)
    try:
        receipt = board_ops.begin(key, gateway=gateway, profile=profile, operation=OPERATION, board=slug,
                                  anchor=anchor, intent_digest=board_ops.digest(intent), native_key=lock,
                                  pending={"id": intent["card"], "verdict": intent["verdict"]})
    except board_ops.OpRefused as refusal:
        raise bm.BoardReadError(refusal.code) from None
    except board_ops.OpStoreError:
        # Nothing is written to Hermes without a durable pending receipt.
        raise bm.BoardReadError("temporarily_unavailable") from None
    if receipt.get("fresh"):
        barrier("receipted")
        receipt = _execute(root, slug, anchor, intent, key, lock)
        if receipt["state"] == "succeeded":
            barrier("succeeded")
    elif receipt.get("taken_over"):
        # Same key after the gateway that sent it died: settled from native
        # state, never issued again.
        receipt = _resolve(root, receipt, db, board_ops.current_writer())
    else:
        # Same key again after a refusal: its claim, if still held, goes back.
        _release_after_refusal(root, receipt, db)
    if receipt["state"] == "pending":
        # Another live attempt with this key is still running: the phone
        # looks the key up, it never sends the verdict twice.
        raise bm.BoardReadError("outcome_unknown")
    if receipt["state"] != "succeeded":
        raise bm.BoardReadError(receipt.get("code") or receipt["state"])
    return _answer(slug, meta, receipt)


def _refuse(key: str, code: str) -> dict:
    return board_ops.finish(key, "refused", code=code)


def _release(conn, kb, card_id: str, lock: str) -> bool:
    """Hand this op's own claim back now: the card returns to the review it
    was claimed from. True when it did.

    ``heartbeat_claim`` is a CAS on this op's lock, so it succeeds only while
    the claim is ours, and it re-arms the claim, so no stale-claim sweep can
    take it before the reclaim. ``reclaim_task`` then re-reads the lock and
    CASes on what it read; with a live claim of ours that is this op's lock
    unless an operator reclaim and a new claim both land in the microseconds
    between the two calls. Never ``release_stale_claims``: it sweeps the
    whole board."""
    try:
        if not kb.heartbeat_claim(conn, card_id, ttl_seconds=CLAIM_TTL_SECONDS, claimer=lock):
            return False  # not ours (any more): never touched
    except Exception:  # noqa: BLE001 - unreadable: leave it; the bounded claim lapses
        return False
    try:
        if kb.reclaim_task(conn, card_id, reason=RELEASE_REASON):
            return True
    except Exception:  # noqa: BLE001 - fall back to the bounded claim below
        pass
    try:
        kb.heartbeat_claim(conn, card_id, ttl_seconds=RELEASE_TTL_SECONDS, claimer=lock)
    except Exception:  # noqa: BLE001 - the bounded claim lapses on its own
        pass
    return False


def _release_held(db: Path, card_id: str, lock: str) -> bool:
    """Recovery: release this op's claim when it is still on the card (a
    writer that died holding it, or a refusal whose release did not land).
    Reads first; writes only when the claim is this op's."""
    def held(conn):
        row = _rows(conn).execute("SELECT status, claim_lock FROM tasks WHERE id = ?", [card_id]).fetchone()
        return row is not None and row["status"] == "running" and row["claim_lock"] == lock

    try:
        if not card_id or not bm._read(db, held):
            return False
    except (bm.BoardReadError, OSError):
        return False
    import hermes_cli.kanban_db as kb
    from hermes_cli.kanban_db_connect import connect
    try:
        conn = connect(db_path=db)
    except Exception:  # noqa: BLE001 - nothing was written
        return False
    try:
        return _release(conn, kb, card_id, lock)
    finally:
        conn.close()


def _execute(root: Path, slug: str, anchor: str, intent: dict, key: str, lock: str) -> dict:
    """Checks, the claim, the inspection, the decision and the final receipt,
    for a receipt this attempt wrote."""
    writer = board_ops.current_writer()
    try:
        db, _meta = bc._ready(root, slug, anchor)
        # Capability and authority, again, right before the write.
        _capability(bm.board_capabilities(), intent["verdict"])
        problem = bm._read(db, lambda conn: _precheck(_rows(conn), intent))
    except bm.BoardReadError as refusal:
        return _refuse(key, refusal.code)
    except OSError:
        return _refuse(key, "temporarily_unavailable")
    if problem:
        return _refuse(key, problem)
    barrier("checked")
    import hermes_cli.kanban_db as kb
    from hermes_cli.kanban_db_connect import connect
    try:
        conn = connect(db_path=db)
    except Exception:  # noqa: BLE001 - nothing was written
        return _refuse(key, "temporarily_unavailable")
    try:
        return _decide(conn, kb, db, intent, key, lock, writer)
    finally:
        conn.close()


def _decide(conn, kb, db: Path, intent: dict, key: str, lock: str, writer: tuple) -> dict:
    card_id, verdict_ = intent["card"], intent["verdict"]
    try:
        task = kb.claim_review_task(conn, card_id, ttl_seconds=CLAIM_TTL_SECONDS, claimer=lock)
    except Exception:  # noqa: BLE001 - a claim that may have landed is released; no verdict was issued
        _release(conn, kb, card_id, lock)
        return _refuse(key, "temporarily_unavailable")
    if task is None or task.current_run_id is None:
        # Not in review any more (another decider, a worker, a parent that reopened).
        return _refuse(key, "stale_target")
    run_id = int(task.current_run_id)
    barrier("claimed")
    try:
        problem = inspect(conn, intent, run_id, lock)
    except Exception:  # noqa: BLE001 - an unreadable log never decides
        problem = "unreadable"
    if problem:
        _release(conn, kb, card_id, lock)
        return _refuse(key, "temporarily_unavailable" if problem == "unreadable" else "stale_target")
    try:
        issued = board_ops.note(key, {"issued": run_id}, writer=writer)
    except board_ops.OpStoreError:
        issued = False
    if not issued:
        # The decision is never called without its record.
        _release(conn, kb, card_id, lock)
        return _refuse(key, "temporarily_unavailable")
    barrier("issued")
    try:
        if verdict_ == "approve":
            ok, detail = kb.complete_task(conn, card_id, expected_run_id=run_id, result=APPROVE_RESULT), None
        else:
            ok, detail = kb.request_changes(conn, card_id, reason=intent["reason"], expected_run_id=run_id)
    except Exception:  # noqa: BLE001 - the outcome decides, never the exception text
        return _after_failure(conn, kb, db, intent, key, lock, run_id)
    if not ok:
        _release(conn, kb, card_id, lock)
        code = "stale_target" if detail is None or detail in _MOVED_ON else \
            "invalid_target" if detail == "task not found" else "invalid_request"
        return _refuse(key, code)
    barrier("decided")
    try:
        row = conn.execute("SELECT status FROM tasks WHERE id = ?", [card_id]).fetchone()
        state = row["status"] if row is not None else None
    except Exception:  # noqa: BLE001
        state = None
    state = state if isinstance(state, str) and bm._STATUS.match(state) else "unknown"
    return board_ops.finish(key, "succeeded",
                            result={"id": card_id, "card": {"id": card_id, "state": state}, "verdict": verdict_,
                                    "issued": run_id})


def _after_failure(conn, kb, db: Path, intent: dict, key: str, lock: str, run_id: int) -> dict:
    """The decision call raised: read native state to know whether it landed."""
    try:
        settled = _settled(db, intent["card"], run_id, lock, intent["verdict"])
    except Exception:  # noqa: BLE001
        return board_ops.finish(key, "outcome_unknown")
    if settled == "open":
        _release(conn, kb, intent["card"], lock)
        return _refuse(key, "temporarily_unavailable")
    if settled == "other":
        return _refuse(key, "stale_target")
    return board_ops.finish(key, "outcome_unknown")


def _resolve(root: Path, receipt: dict, db: Path, writer: tuple) -> dict:
    """A pending receipt whose writer died, settled for ``writer`` (the
    process that now owns it) from native state. Never issues the verdict:
    an op that died before issuing is refused, one that issued is read back.
    The only Hermes write is handing back the dead op's own claim when it is
    still held (``_release_held``)."""
    pending = receipt.get("result") or {}
    card_id, lock = pending.get("id", ""), receipt["native_key"]
    try:
        issued = pending.get("issued")
        if issued is None:
            # Died before issuing: nothing was decided. A claim it left on the
            # card is handed back now, never left for a sweep.
            if _same_store(root, db, receipt):
                _release_held(db, card_id, lock)
            return board_ops.finish(receipt["key"], "refused", code="expired_request", writer=writer)
        try:
            same = db.is_file() and bm.board_anchor(root, bm._file_identity(db)) == receipt["anchor"]
            settled = _settled(db, card_id, int(issued), lock,
                               pending.get("verdict", "approve")) if same else "unknown"
        except (bm.BoardReadError, OSError):
            # Busy or unreadable now: still pending, ask again.
            return receipt
        if settled == "open":
            # Issued, never decided, and the run is still this op's claim.
            _release_held(db, card_id, lock)
            return board_ops.finish(receipt["key"], "refused", code="expired_request", writer=writer)
        if settled == "other":
            return board_ops.finish(receipt["key"], "refused", code="stale_target", writer=writer)
        return board_ops.finish(receipt["key"], "outcome_unknown", writer=writer)
    except board_ops.OpStoreError:
        return receipt


def _same_store(root: Path, db: Path, receipt: dict) -> bool:
    """The board file is still the instance the receipt was written for."""
    try:
        return db.is_file() and bm.board_anchor(root, bm._file_identity(db)) == receipt["anchor"]
    except (bm.BoardReadError, OSError):
        return False


def _release_after_refusal(root: Path, receipt: dict, db: Path) -> None:
    """A refused receipt whose op still holds its claim (its release did not
    land) hands the claim back now. Writes Hermes only in that case."""
    if receipt.get("state") != "refused" or not receipt.get("native_key"):
        return
    card_id = (receipt.get("result") or {}).get("id", "")
    if card_id and _same_store(root, db, receipt):
        _release_held(db, card_id, receipt["native_key"])


def looked_up(root: Path, receipt: dict) -> dict:
    """``board.receipt`` for a verdict: the receipt, a dead writer's pending
    one settled from native state first. It never issues a verdict; it writes
    Hermes only to hand back this op's own claim when one is still held."""
    slug = receipt["board"]
    db, meta = bm.board_paths(root, slug)
    if receipt["state"] == "pending" and not board_ops.writer_live(receipt):
        receipt = _resolve(root, receipt, db, (receipt.get("writer_pid"), receipt.get("writer_start")))
    _release_after_refusal(root, receipt, db)
    return _answer(slug, meta, receipt)
