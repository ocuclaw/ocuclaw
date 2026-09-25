"""Hermes Board card actions (#3059): Reassign, Set model, Retry and Archive,
from the card sheet's More menu. Contract: docs/hermes-board/contract.md
("Card actions (#3059)").

Stock only (0.21.1 ``2237be35``, 0.21.3 ``345cd2b0``): every native write is
one stock ``hermes_cli.kanban_db`` call, and none takes an expected state,
run or claim. So the binding is OcuClaw's, as #3055's operation API map says:

1. **Receipt first.** ``board_ops.begin`` writes a ``pending`` receipt bound
   to the scope, the board instance and the intent (card, action, the card
   state and latest run the wearer saw, and the action's value) before
   anything touches Hermes.
2. **Checks.** #3055's board checks (the store exists, is the instance the
   phone saw, needs no migration); a read-only pre-check that the card is
   still in the state and on the run the wearer saw (``stale_target``) and
   that the action fits that state (``invalid_request``); the action's own
   capability, read again. The pre-check's event fence and the retry's native
   path are noted on the receipt before the write.
3. **Write.** One stock call. Residual race window: a card changed by another
   writer between the pre-check and the call is not detected by the call.
4. **Receipt final**, with the card's lane read right after the write.

A lost answer is looked up by key (``board.receipt``), never sent again. A
dead writer's attempt is settled from native records only, never re-issued:
no event of the action's kind after the fence means nothing was written
(``expired_request``); one that carries this op's own tag (a retry's
reclaim or promote reason) means it landed; any other is ``outcome_unknown``.

#3707: Make ready moves a triage card on with stock ``specify_triage_task``
(no title, body or assignee): triage to todo in one transaction, a
``specified`` event, then stock ``recompute_ready``, so a card with no open
parent lands in ``ready``. Its event carries no tag, so a dead writer's
attempt is settled as Archive's is.

``force`` is never passed: 0.21.3's ``promote_task`` has none, and 0.21.1's
would skip the parent check.

``barrier`` is a seam for the contract suite, as in ``board_create``.
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
import inspect
import re
import sqlite3
from pathlib import Path
from typing import Callable, Optional

from . import board_management as bm
from . import board_ops

OPERATION = "board.action"
#: The More menu's actions, in the order the phone shows them. Each is gated by
#: its own capability key of the same name. #3707: ``make_ready`` leads.
ACTIONS = ("make_ready", "reassign", "set_model", "retry", "archive")
#: #3063: Settings › Board › Maintenance's per-card reclaim of a stale worker.
#: It rides this flow but is never on the More menu: its gate is the
#: ``maintenance`` capability plus its own maintenance gate (``board_maintenance``).
MAINTENANCE_ACTIONS = ("reclaim",)
ALL_ACTIONS = ACTIONS + MAINTENANCE_ACTIONS
PAYLOAD_KEYS = {"slug", "anchor", "id", "key", "action", "state", "run", "assignee", "model", "provider", "claim"}
#: The value keys each action takes, beyond the binding. #3063: reclaim's
#: ``claim`` is the digest of the claim the wearer viewed.
VALUE_KEYS = {"make_ready": set(), "reassign": {"assignee"}, "set_model": {"model", "provider"},
              "retry": set(), "archive": set(), "reclaim": {"claim"}}
_CLAIM = re.compile(r"^[0-9a-f]{16}$")

#: State guards. A running card is never reassigned (stock refuses it under a
#: claim; Retry first). Set model applies at the next dispatch, so a running
#: card takes it. Done and archived cards take neither. A status this engine
#: does not know takes no action at all.
REASSIGN_STATES = ("triage", "todo", "scheduled", "ready", "blocked", "review")
SET_MODEL_STATES = ("triage", "todo", "scheduled", "ready", "running", "blocked", "review")
ARCHIVE_STATES = ("triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done")
#: Run outcomes that are a failed run, as opposed to a state transition.
FAILED_OUTCOMES = ("crashed", "timed_out", "spawn_failed", "gave_up")
#: The event each native path appends; a dead writer's attempt is settled by it.
EVENT_KINDS = {"make_ready": "specified", "reassign": "assigned", "set_model": "model_override_set", "archive": "archived",
               "reclaim": "reclaimed", "unblock": "unblocked", "promote": "promoted_manual"}
ACTOR = "ocuclaw"
MODEL_MAX = 128

_ASSIGNEE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$")
_PROVIDER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

#: Named points, in order. ``receipted``: the pending receipt is durable,
#: nothing checked. ``checked``: the pre-check passed and its fence is on the
#: receipt; nothing native is written. ``committed``: the stock call returned,
#: the receipt is still pending. ``succeeded``: the receipt is final.
POINTS = ("receipted", "checked", "committed", "succeeded")
barrier: Callable[[str], None] = lambda point: None


# --------------------------------------------------------------------------
# Guards
# --------------------------------------------------------------------------

@lru_cache(maxsize=1)
def archive_stops_worker() -> bool:
    """Whether this engine's ``archive_task`` terminates a running card's
    host-local worker. 0.21.3's does (``signal_fn``); 0.21.1's only flips the
    row, which orphans the live worker, so a running card is not archived there."""
    from hermes_cli.kanban_db import archive_task
    return "signal_fn" in inspect.signature(archive_task).parameters


def retry_via(facts: dict) -> Optional[str]:
    """The stock path Retry takes for the card as it is: ``reclaim`` for a
    running card, ``unblock`` for a scheduled or blocked card, ``promote`` for
    a todo card whose parents are all finished. None when Retry does not fit.

    A card blocked on a question (``needs_input``) is retried too: the wearer
    comments the answer first, Retry sends the card back to Ready, and the
    next run reads the card with its comments. A second block on the same
    question goes to triage (stock ``BLOCK_RECURRENCE_LIMIT``), so it cannot
    loop. The one-step Answer (#3058) stays off."""
    status = facts["status"]
    if status == "running":
        return "reclaim"
    if status in ("scheduled", "blocked"):
        return "unblock"
    if status == "todo" and facts["openParents"] == 0:
        return "promote"
    return None


def fits(action: str, facts: dict) -> bool:
    """The action's state guard, on the card as read."""
    status = facts["status"]
    if action == "make_ready":
        # #3707: stock specify_triage_task moves a triage card only.
        return status == "triage"
    if action == "reassign":
        return status in REASSIGN_STATES
    if action == "set_model":
        return status in SET_MODEL_STATES
    if action == "retry":
        return retry_via(facts) is not None
    if action == "archive":
        return status in ARCHIVE_STATES and (status != "running" or archive_stops_worker())
    if action == "reclaim":
        # #3063: only a running card whose claim still looks stale.
        return status == "running" and facts.get("stale") is not None
    return False


def _enabled(capabilities: list, action: str) -> bool:
    return any(row.get("key") == action and row.get("enabled") for row in capabilities)


def card_actions(facts: dict, capabilities: list) -> list:
    """The actions the More menu offers for this card: capability on and state
    guard met, in menu order. ``board.card`` carries it."""
    try:
        return [a for a in ACTIONS if _enabled(capabilities, a) and fits(a, facts)]
    except Exception:  # noqa: BLE001 - a guard that cannot be read offers nothing
        return []


def card_facts(conn: sqlite3.Connection, card_id: str) -> Optional[dict]:
    """What the guards and the stale check read, in the caller's transaction:
    status, block kind, the newest run (id and outcome), unfinished parents,
    the card's newest event id (the fence), assignee and model override."""
    columns = bm._columns(conn, "tasks")
    model = ", t.model_override AS model" if "model_override" in columns else ", NULL AS model"
    row = conn.execute(
        "SELECT t.status, t.block_kind, t.assignee" + model + ","
        " (SELECT r.id FROM task_runs r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS run,"
        " (SELECT r.outcome FROM task_runs r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS outcome,"
        " (SELECT COUNT(*) FROM task_links l JOIN tasks p ON p.id = l.parent_id"
        "  WHERE l.child_id = t.id AND p.status NOT IN ('done', 'archived')) AS open_parents,"
        " (SELECT COALESCE(MAX(e.id), 0) FROM task_events e WHERE e.task_id = t.id) AS fence"
        " FROM tasks t WHERE t.id = ?", [card_id]).fetchone()
    if row is None:
        return None
    status = bm._decoded(row[0])
    block_kind = bm._decoded(row[1])
    outcome = bm._decoded(row[5])
    return {"status": status if isinstance(status, str) and bm._STATUS.match(status) else "unknown",
            "blockKind": block_kind if isinstance(block_kind, str) else None,
            "assignee": bm._clean(row[2], 64) or None,
            "model": bm._clean(row[3], MODEL_MAX) or None,
            "run": int(row[4] or 0),
            "outcome": outcome if isinstance(outcome, str) else None,
            "openParents": int(row[6] or 0),
            "fence": int(row[7] or 0)}


# --------------------------------------------------------------------------
# Request
# --------------------------------------------------------------------------

def parse(payload) -> tuple:
    """``(slug, anchor, key, intent)`` or ``invalid_request``. The intent is
    what the receipt digests: the card, the action, what the wearer saw and
    the action's value."""
    if not isinstance(payload, dict) or set(payload) - PAYLOAD_KEYS:
        raise bm.BoardReadError("invalid_request")
    slug, anchor, key = payload.get("slug"), payload.get("anchor"), payload.get("key")
    card_id, action = payload.get("id"), payload.get("action")
    if not isinstance(slug, str) or not bm._SLUG.match(slug):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(anchor, str) or not bm._ANCHOR.match(anchor):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(key, str) or not board_ops.KEY.match(key):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(card_id, str) or not bm._CARD_ID.match(card_id):
        raise bm.BoardReadError("invalid_request")
    if action not in ALL_ACTIONS:
        raise bm.BoardReadError("invalid_request")
    state, run = payload.get("state"), payload.get("run")
    if not isinstance(state, str) or not bm._STATUS.match(state):
        raise bm.BoardReadError("invalid_request")
    if isinstance(run, bool) or not isinstance(run, int) or run < 0:
        raise bm.BoardReadError("invalid_request")
    extra = set(payload) - {"slug", "anchor", "id", "key", "action", "state", "run"}
    if extra - VALUE_KEYS[action]:
        raise bm.BoardReadError("invalid_request")
    intent = {"id": card_id, "action": action, "state": state, "run": run}
    if action == "reassign":
        assignee = payload.get("assignee")
        if not isinstance(assignee, str) or (assignee and not _ASSIGNEE.match(assignee)):
            raise bm.BoardReadError("invalid_request")
        intent["assignee"] = assignee.lower() or None
    if action == "set_model":
        model, provider = payload.get("model"), payload.get("provider")
        if not isinstance(model, str) or (model and not _MODEL.match(model)):
            raise bm.BoardReadError("invalid_request")
        if provider is not None and (not isinstance(provider, str) or not _PROVIDER.match(provider) or not model):
            raise bm.BoardReadError("invalid_request")
        intent["model"] = model or None
        intent["provider"] = provider
    if action == "reclaim":
        # #3063: the claim the wearer viewed; a reclaim only ever fits a running card.
        claim = payload.get("claim")
        if not isinstance(claim, str) or not _CLAIM.match(claim) or state != "running":
            raise bm.BoardReadError("invalid_request")
        intent["claim"] = claim
    return slug, anchor, key, intent


def op_tag(gateway: str, profile: str, slug: str, key: str, action: Optional[str] = None) -> str:
    """The reason a retry's reclaim or promote (or #3063's maintenance reclaim)
    records natively. It names this op (a digest, never the phone's key), so a
    settle can tell its own write."""
    raw = f"{gateway}\0{profile}\0{slug}\0{key}".encode()
    verb = "Reclaimed" if action == "reclaim" else "Retried"
    return verb + " from OcuClaw (" + hashlib.sha256(raw).hexdigest()[:16] + ")"


# --------------------------------------------------------------------------
# Native write
# --------------------------------------------------------------------------

def _native(db: Path, intent: dict, via: Optional[str], tag: str) -> bool:
    """The one stock call. True when it applied; False when stock refused it
    (its own row check found the card changed). Never ``force``."""
    from hermes_cli.kanban_db import (archive_task, promote_task, reassign_task, reclaim_task,
                                      set_model_override, specify_triage_task, unblock_task)
    from hermes_cli.kanban_db_connect import connect
    action, card_id = intent["action"], intent["id"]
    conn = connect(db_path=db)
    try:
        if action == "make_ready":
            # #3707: no title, body or assignee, so no audit comment; the
            # ``specified`` event's payload is None. Lands todo, then ready.
            return bool(specify_triage_task(conn, card_id, author=None))
        if action == "reassign":
            return bool(reassign_task(conn, card_id, intent["assignee"]))
        if action == "set_model":
            return bool(set_model_override(conn, card_id, intent["model"], intent["provider"]))
        if action == "archive":
            return bool(archive_task(conn, card_id))
        if action == "reclaim" or via == "reclaim":
            # #3063: this one card only; never the board-wide release_stale_claims.
            return bool(reclaim_task(conn, card_id, reason=tag))
        if via == "unblock":
            return bool(unblock_task(conn, card_id))
        if via == "promote":
            ok, _reason = promote_task(conn, card_id, actor=ACTOR, reason=tag)
            return bool(ok)
        return False
    finally:
        conn.close()


def _read_facts(db: Path, card_id: str) -> Optional[dict]:
    def body(conn):
        facts = card_facts(conn, card_id)
        if facts is not None:
            # #3063: the claim the card holds now (a digest) and whether it looks stale.
            from .board_maintenance import claim_facts
            facts.update(claim_facts(conn, card_id) or {"claim": None, "stale": None})
        return facts
    return bm._read(db, body)


def _landed(db: Path, card_id: str, fence: int, kind: str, tag: str) -> str:
    """After ``fence``: ``none`` (no event of the action's kind), ``ours`` (one
    that carries this op's tag) or ``some`` (one nobody can attribute)."""
    def body(conn):
        return conn.execute("SELECT payload FROM task_events WHERE task_id = ? AND kind = ? AND id > ?"
                            " ORDER BY id", [card_id, kind, fence]).fetchall()
    rows = bm._read(db, body)
    if not rows:
        return "none"
    if any(bm._payload(row[0]).get("reason") == tag for row in rows):
        return "ours"
    return "some"


def _card_after(db: Path, card_id: str) -> dict:
    """The receipt's card: its lane (and worker, model) read right after the
    write. A card that cannot be read now reports the lane ``unknown``, never
    a guess."""
    try:
        facts = _read_facts(db, card_id)
    except bm.BoardReadError:
        facts = None
    out = {"id": card_id, "state": "unknown"}
    if facts is None:
        return out
    out["state"] = facts["status"]
    if facts["assignee"]:
        out["assignee"] = facts["assignee"]
    if facts["model"]:
        out["model"] = facts["model"]
    return out


# --------------------------------------------------------------------------
# Operation
# --------------------------------------------------------------------------

def _capability(capabilities: list, action: str) -> None:
    # #3063: a maintenance action is gated by `maintenance` and then its own gate.
    key = "maintenance" if action in MAINTENANCE_ACTIONS else action
    row = next((r for r in capabilities if r["key"] == key), None)
    if row is None or not row.get("enabled"):
        raise bm.BoardReadError((row or {}).get("code") or "unsupported")
    if action in MAINTENANCE_ACTIONS:
        from .board_maintenance import require
        require(capabilities, action)


def wire_receipt(receipt: dict) -> dict:
    """The receipt as the phone reads it. ``operation`` is the action; a
    succeeded one names the card and its lane after the write, and a retry its
    native path and the failed run it recovered, if the run had failed."""
    result = receipt.get("result") or {}
    action = result.get("action") if result.get("action") in ALL_ACTIONS else "unknown"
    out = {"key": receipt["key"], "operation": action, "state": receipt["state"]}
    if receipt["state"] == "succeeded" and isinstance(result.get("card"), dict):
        out["card"] = result["card"]
        if action == "retry" and result.get("via") in ("reclaim", "unblock", "promote"):
            out["via"] = result["via"]
        if result.get("failedRun") in FAILED_OUTCOMES:
            out["failedRun"] = result["failedRun"]
    if receipt["state"] == "refused":
        out["code"] = receipt.get("code") or "invalid_request"
    return out


def _answer(slug: str, meta: Path, receipt: dict) -> dict:
    return {"target": {"slug": slug, "name": bm._metadata(slug, meta)["name"]},
            "receipt": wire_receipt(receipt)}


def act(root: Path, payload, profile: str, capabilities: list) -> dict:
    from .board_create import _gateway
    slug, anchor, key, intent = parse(payload)
    _capability(capabilities, intent["action"])
    db, meta = bm.board_paths(root, slug)
    gateway = _gateway()
    try:
        receipt = board_ops.begin(key, gateway=gateway, profile=profile, operation=OPERATION, board=slug,
                                  anchor=anchor, intent_digest=board_ops.digest(intent), native_key="",
                                  pending={"action": intent["action"], "id": intent["id"]})
    except board_ops.OpRefused as refusal:
        raise bm.BoardReadError(refusal.code) from None
    except board_ops.OpStoreError:
        # Nothing is written to Hermes without a durable pending receipt.
        raise bm.BoardReadError("temporarily_unavailable") from None
    if receipt["state"] == "pending":
        if receipt.get("fresh"):
            barrier("receipted")
            receipt = _execute(root, slug, anchor, key, intent, capabilities,
                               op_tag(gateway, profile, slug, key, intent["action"]))
        elif receipt.get("taken_over"):
            # A dead writer's attempt with this key: settled, never issued again.
            receipt = settle(root, receipt, op_tag(gateway, profile, slug, key, intent["action"]),
                             writer=board_ops.current_writer())
        if receipt["state"] == "pending":
            # The same key is still running elsewhere: its answer is the receipt's.
            raise bm.BoardReadError("outcome_unknown")
    if receipt["state"] != "succeeded":
        raise bm.BoardReadError(receipt.get("code") or receipt["state"])
    barrier("succeeded")
    return _answer(slug, meta, receipt)


def _refuse(key: str, code: str) -> dict:
    return board_ops.finish(key, "refused", code=code)


def _execute(root: Path, slug: str, anchor: str, key: str, intent: dict, capabilities: list,
             tag: str) -> dict:
    """Checks, the stock call and the final receipt, for a fresh pending receipt."""
    from .board_create import _assignee_exists, _ready
    action, card_id = intent["action"], intent["id"]
    try:
        db, _meta = _ready(root, slug, anchor)
        facts = _read_facts(db, card_id)
        if facts is None:
            return _refuse(key, "invalid_target")
        # The successor check: the card is in the state and on the run the wearer saw.
        if facts["status"] != intent["state"] or facts["run"] != intent["run"]:
            return _refuse(key, "stale_target")
        # #3063: a reclaim is bound to the claim the wearer viewed, still stale now.
        if action == "reclaim" and (facts["claim"] != intent["claim"] or facts["stale"] is None):
            return _refuse(key, "stale_target")
        if not fits(action, facts):
            return _refuse(key, "invalid_request")
        if action == "reassign" and intent["assignee"] and not _assignee_exists(intent["assignee"]):
            return _refuse(key, "invalid_request")
        # Capability and authority, again, right before the write.
        _capability(bm.board_capabilities(), action)
        _capability(capabilities, action)
    except bm.BoardReadError as refusal:
        return _refuse(key, refusal.code)
    except OSError:
        return _refuse(key, "temporarily_unavailable")
    via = retry_via(facts) if action == "retry" else None
    failed = facts["outcome"] if facts["outcome"] in FAILED_OUTCOMES and action == "retry" else None
    noted = {"fence": facts["fence"], "via": via, "failedRun": failed}
    try:
        owned = board_ops.note(key, noted, writer=board_ops.current_writer())
    except board_ops.OpStoreError:
        return _refuse(key, "temporarily_unavailable")
    if not owned:
        # Another process settled or took this receipt: its answer stands.
        return board_ops.get(key) or {"key": key, "state": "outcome_unknown"}
    barrier("checked")
    try:
        applied = _native(db, intent, via, tag)
    except Exception as exc:  # noqa: BLE001 - the store decides, never the exception text
        return _after_failure(db, key, intent, noted, tag, exc)
    if not applied:
        # Stock's own row check refused it: the card changed after the pre-check.
        try:
            gone = _read_facts(db, card_id) is None
        except bm.BoardReadError:
            gone = False
        return _refuse(key, "invalid_target" if gone else "stale_target")
    barrier("committed")
    result = {"action": action, "id": card_id, **noted, "card": _card_after(db, card_id)}
    return board_ops.finish(key, "succeeded", result=result)


def _after_failure(db: Path, key: str, intent: dict, noted: dict, tag: str, exc: Exception) -> dict:
    """A stock call that raised may have committed (an after-commit step can
    raise too). Read to know: nothing of its kind after the fence is a refusal;
    anything else cannot be told apart from another writer's."""
    kind = EVENT_KINDS[noted["via"] or intent["action"]]
    try:
        landed = _landed(db, intent["id"], noted["fence"], kind, tag)
    except Exception:  # noqa: BLE001
        return board_ops.finish(key, "outcome_unknown")
    if landed == "none":
        if isinstance(exc, ValueError):
            return _refuse(key, "invalid_request")
        if isinstance(exc, RuntimeError):
            # Stock refuses an override on an archived card, or a reassign under a claim.
            return _refuse(key, "stale_target")
        return _refuse(key, "temporarily_unavailable")
    if landed == "ours":
        result = {"action": intent["action"], "id": intent["id"], **noted,
                  "card": _card_after(db, intent["id"])}
        return board_ops.finish(key, "succeeded", result=result)
    return board_ops.finish(key, "outcome_unknown")


def settle(root: Path, receipt: dict, tag: str, *, writer: tuple) -> dict:
    """A pending receipt whose writer died, settled from native records only,
    on the board instance it named. Never issues the action."""
    pending = receipt.get("result") or {}
    action, card_id = pending.get("action"), pending.get("id")
    key = receipt["key"]
    try:
        if action not in ALL_ACTIONS or not isinstance(card_id, str):
            return board_ops.finish(key, "outcome_unknown", writer=writer)
        if pending.get("fence") is None:
            # Died before its pre-check was noted: nothing native was written.
            return board_ops.finish(key, "refused", code="expired_request", writer=writer)
    except board_ops.OpStoreError:
        return receipt
    db, _meta = bm.board_paths(root, receipt["board"])
    try:
        same = db.is_file() and bm.board_anchor(root, bm._file_identity(db)) == receipt["anchor"]
        kind = EVENT_KINDS[pending.get("via") or action]
        landed = _landed(db, card_id, int(pending["fence"]), kind, tag) if same else None
    except (bm.BoardReadError, OSError, KeyError):
        # Busy or unreadable now: still pending, ask again.
        return receipt
    try:
        if not same:
            return board_ops.finish(key, "outcome_unknown", writer=writer)
        if landed == "none":
            return board_ops.finish(key, "refused", code="expired_request", writer=writer)
        if landed == "ours":
            result = {**pending, "card": _card_after(db, card_id)}
            return board_ops.finish(key, "succeeded", result=result, writer=writer)
        return board_ops.finish(key, "outcome_unknown", writer=writer)
    except board_ops.OpStoreError:
        return receipt


def looked_up(root: Path, receipt: dict, profile: str) -> dict:
    """``board.receipt`` for an action's key. A pending receipt whose writer
    died is settled from native records; nothing is written to Hermes."""
    from .board_create import _gateway
    slug = receipt["board"]
    _db, meta = bm.board_paths(root, slug)
    if receipt["state"] == "pending" and not board_ops.writer_live(receipt):
        action = (receipt.get("result") or {}).get("action")
        receipt = settle(root, receipt, op_tag(_gateway(), profile, slug, receipt["key"], action),
                         writer=(receipt.get("writer_pid"), receipt.get("writer_start")))
    return _answer(slug, meta, receipt)
