"""Hermes Board create (#3055); contract in docs/hermes-board/contract.md.

``board.create`` makes one card from the phone. It is the only Board write
with a native idempotency key, and that key is best-effort on both pins
(0.21.1 ``2237be35``, 0.21.3 ``345cd2b0``): ``create_task`` looks it up
before its write transaction, only a non-unique index backs it, the lookup
skips archived cards, and the key is not bound to the payload. So OcuClaw
does the binding and the serialization itself:

1. **Receipt first.** ``board_ops.begin`` writes a ``pending`` receipt (key,
   scope, board instance, payload digest) in OcuClaw's store before anything
   touches Hermes. Same key, other scope: ``stale_scope``; other intent:
   ``operation_conflict``. A final receipt answers again as it did.
2. **Checks.** ``board_exists`` plus a schema check: the store must already
   hold every table, column and index the engine's own ``connect()`` would
   create or migrate, so ``connect()`` has nothing to create or migrate. A
   missing or unchecked board is never opened for writing. The board
   instance must be the one the phone saw (``stale_target``), and the
   ``create`` capability is read again right before the write.
3. **Write.** One outer ``write_txn`` (BEGIN IMMEDIATE, a sanctioned nesting
   primitive) holds OcuClaw's own lookup of the native key, archived cards
   included, and ``create_task`` (which nests as a savepoint). Two attempts
   with one key serialize on the writer lock: the second finds the first's
   card. A card the key made that was archived since is refused
   (``stale_target``), never created again.
4. **Receipt final**, then the **watch step**: the new card is watched in
   the mode the wearer chose through #3050's watch store. A same-key retry
   after a crash resolves the card from the receipt (or the native key) and
   runs the watch step again; it is idempotent.

``create_task`` always gets explicit values: ``workspace_kind="scratch"``
and ``project_id=""`` (one behavior on both pins: 0.21.1 would otherwise
anchor a project board's card to a worktree even with ``scratch``),
``initial_status="running"`` (stock accepts only ``running`` or
``blocked``; ``todo`` raises ``ValueError``), ``triage=True``
for "park in triage" and ``triage=False`` for "make ready", no runtime,
model or skills overrides, ``created_by="ocuclaw"`` and the board slug.

#3060: ``parents`` (the cards this one depends on) go to stock
``create_task(parents=)``, so the card and its links commit together and it
never sits ready before it is linked: a "make ready" card with a parent not
done lands in ``todo``. They need the ``dependencies`` capability, must be
live cards on the same board (checked in the read transaction and again
inside the write), and join the receipt's intent only when present.

``barrier`` is a seam for the contract suite: a test process replaces it to
stop (and kill) the writer at a named point. Production never pauses.
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
from pathlib import Path
import re
import sqlite3
from typing import Callable, Optional

from . import board_management as bm
from . import board_ops

OPERATION = "board.create"
#: The two lanes a phone can create into.
LANES = ("triage", "ready")
#: #3060: where a new card can land: a lane, or ``todo`` when "make ready"
#: names a parent that is not done yet.
CARD_STATES = ("triage", "todo", "ready")
#: #3060: at most this many cards a new card can depend on.
PARENTS_MAX = 8
#: Watch modes a new card can start in (#3050). ``notify_wake`` needs ``wake`` (off, #3064).
WATCH_MODES = ("off", "notify")
TITLE_MAX = 200
BODY_MAX = 4000
PRIORITY_MIN, PRIORITY_MAX = -10, 10
CREATED_BY = "ocuclaw"
PAYLOAD_KEYS = {"slug", "anchor", "key", "title", "body", "assignee", "priority", "lane", "watch", "parents"}
_ASSIGNEE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_PROSE_REFUSED = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")
_TEXT_REFUSED = re.compile(r"[\x00-\x1f\x7f]")

#: Named points, in order. ``receipted``: the pending receipt is durable and
#: nothing native is written. ``committed``: the card is committed, the
#: receipt still pending. ``succeeded``: the receipt is final, the watch step
#: not run. ``watched``: everything is done, the response not yet sent.
POINTS = ("receipted", "committed", "succeeded", "watched")
barrier: Callable[[str], None] = lambda point: None

#: The legacy event kinds and in-flight rows the engine's migration rewrites.
#: A store holding any is refused: ``connect()`` would change it.
_LEGACY_EVENT_KINDS = ("ready", "priority", "spawn_auto_blocked")


# --------------------------------------------------------------------------
# Request
# --------------------------------------------------------------------------

def _text(value, limit: int, *, prose: bool = False) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > limit:
        return None
    if (_PROSE_REFUSED if prose else _TEXT_REFUSED).search(value):
        return None
    return value


def parse(payload) -> tuple:
    """``(slug, anchor, key, intent)`` or ``invalid_request``. The intent is
    what the receipt digests: every field that shapes the card."""
    if not isinstance(payload, dict) or set(payload) - PAYLOAD_KEYS:
        raise bm.BoardReadError("invalid_request")
    slug, anchor, key = payload.get("slug"), payload.get("anchor"), payload.get("key")
    if not isinstance(slug, str) or not bm._SLUG.match(slug):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(anchor, str) or not bm._ANCHOR.match(anchor):
        raise bm.BoardReadError("invalid_request")
    if not isinstance(key, str) or not board_ops.KEY.match(key):
        raise bm.BoardReadError("invalid_request")
    title = _text(payload.get("title"), TITLE_MAX)
    if title is None:
        raise bm.BoardReadError("invalid_request")
    body = payload.get("body")
    if body is not None:
        body = _text(body, BODY_MAX, prose=True)
        if body is None:
            raise bm.BoardReadError("invalid_request")
    assignee = payload.get("assignee")
    if assignee is not None and (not isinstance(assignee, str) or not _ASSIGNEE.match(assignee)):
        raise bm.BoardReadError("invalid_request")
    priority = payload.get("priority", 0)
    if isinstance(priority, bool) or not isinstance(priority, int) or not PRIORITY_MIN <= priority <= PRIORITY_MAX:
        raise bm.BoardReadError("invalid_request")
    lane, watch = payload.get("lane"), payload.get("watch")
    if lane not in LANES or watch not in WATCH_MODES:
        raise bm.BoardReadError("invalid_request")
    intent = {"title": title, "body": body, "assignee": assignee.lower() if assignee else None,
              "priority": priority, "lane": lane, "watch": watch}
    parents = _parents(payload.get("parents"))
    if parents:
        # Only when present, so a create without parents digests as it did before #3060.
        intent["parents"] = parents
    return slug, anchor, key, intent


def _parents(value) -> list:
    """#3060: the cards a new card depends on: distinct card ids, at most
    ``PARENTS_MAX``, in the order given. Absent or empty is none."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > PARENTS_MAX:
        raise bm.BoardReadError("invalid_request")
    if any(not isinstance(p, str) or not bm._CARD_ID.match(p) for p in value) or len(set(value)) != len(value):
        raise bm.BoardReadError("invalid_request")
    return list(value)


def _parents_live(conn, parents: list) -> bool:
    """Every parent is a card on this board that is not archived."""
    if not parents:
        return True
    marks = ",".join("?" for _ in parents)
    rows = conn.execute(f"SELECT id, status FROM tasks WHERE id IN ({marks})", parents).fetchall()
    return len(rows) == len(parents) and all(row[1] != "archived" for row in rows)


class _ParentsGone(Exception):
    """A parent was archived or removed between the check and the write."""


def native_key(gateway: str, profile: str, slug: str, key: str) -> str:
    """The idempotency key Hermes stores. Deterministic, so a retry after a
    crash finds the card the first attempt committed."""
    raw = f"{gateway}\0{profile}\0{slug}\0{key}".encode()
    return "ocuclaw-board:" + hashlib.sha256(raw).hexdigest()[:32]


# --------------------------------------------------------------------------
# Write readiness: board_exists plus a schema check
# --------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _engine_schema() -> tuple:
    """What this engine's ``connect()`` would leave on a store: every table's
    columns (name -> declared type) and every named index. Built on a private
    in-memory database with the engine's own schema script and migration;
    nothing on disk is touched."""
    import hermes_cli.kanban_db as kb
    import hermes_cli.kanban_db_connect as kc
    mem = sqlite3.connect(":memory:", isolation_level=None, check_same_thread=False)
    try:
        mem.row_factory = sqlite3.Row
        mem.executescript(kb.SCHEMA_SQL)
        kc._migrate_add_optional_columns(mem)
        tables = {}
        for (name,) in mem.execute("SELECT name FROM sqlite_master WHERE type = 'table'"
                                   " AND name NOT LIKE 'sqlite_%'").fetchall():
            tables[name] = {row[1]: (row[2] or "").upper() for row in mem.execute(f'PRAGMA table_info("{name}")')}
        indexes = frozenset(row[0] for row in mem.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL"))
        events = mem.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_events'").fetchone()
        fence = bool(events and "AUTOINCREMENT" in (events[0] or "").upper())
    finally:
        mem.close()
    return tables, indexes, fence


def engine_schema_facts() -> tuple:
    """``(tables, indexes, fence)`` for the compatible-tier probe
    (``board_management.compatibility_problem``): this engine's own schema,
    and whether its ``task_events`` ids are AUTOINCREMENT (never reused, so
    the event fence every stale check compares only grows)."""
    return _engine_schema()


def check_writable(conn: sqlite3.Connection) -> None:
    """``schema_unsupported`` unless ``connect()`` would find nothing to
    create or migrate on this (read-only) store."""
    try:
        tables, indexes, _fence = _engine_schema()
    except Exception:
        raise bm.BoardReadError("schema_unsupported") from None
    try:
        for name, columns in tables.items():
            have = {row[1]: (row[2] or "").upper() for row in conn.execute(f'PRAGMA table_info("{name}")')}
            if any(have.get(col) != kind for col, kind in columns.items()):
                raise bm.BoardReadError("schema_unsupported")
        stored = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        if not indexes <= stored:
            raise bm.BoardReadError("schema_unsupported")
        marks = ",".join("?" for _ in _LEGACY_EVENT_KINDS)
        if conn.execute(f"SELECT 1 FROM task_events WHERE kind IN ({marks}) LIMIT 1",
                        _LEGACY_EVENT_KINDS).fetchone() is not None:
            raise bm.BoardReadError("schema_unsupported")
        if conn.execute("SELECT 1 FROM tasks WHERE status = 'running' AND current_run_id IS NULL"
                        " LIMIT 1").fetchone() is not None:
            raise bm.BoardReadError("schema_unsupported")
    except sqlite3.DatabaseError as exc:
        raise bm.BoardReadError(bm._sqlite_code(exc)) from None


def _ready(root: Path, slug: str, anchor: str, parents: tuple = ()) -> tuple:
    """``(db, meta)`` for a board that exists, is the instance the phone saw
    and can be written without ``connect()`` creating or migrating it. #3060:
    every parent named must be a live card on it (``stale_target``)."""
    from hermes_cli.kanban_db import board_exists
    db, meta = bm.board_paths(root, slug)
    if not board_exists(slug):
        raise bm.BoardReadError("invalid_target")

    def body(conn):
        if bm.board_anchor(root, bm._file_identity(db)) != anchor:
            raise bm.BoardReadError("stale_target")
        check_writable(conn)
        if not _parents_live(conn, list(parents)):
            raise bm.BoardReadError("stale_target")

    bm._read(db, body)
    return db, meta


def _assignee_exists(name: str) -> bool:
    try:
        from hermes_cli.profiles import profile_exists
        return bool(profile_exists(name))
    except Exception:
        return False


# --------------------------------------------------------------------------
# Native write
# --------------------------------------------------------------------------

def _card(row, lane: str) -> dict:
    """The receipt's card. ``state`` is the lane the card was created in, from
    its native ``created`` event (``lane``, what was asked, if that is
    unreadable): a card may have moved on by the time a retry reads it."""
    event = bm._payload(row["created"])
    created = event.get("status")
    out = {"id": row["id"], "title": bm._clean(row["title"], TITLE_MAX),
           "state": created if created in CARD_STATES else lane, "priority": int(row["priority"] or 0)}
    assignee = bm._clean(row["assignee"], 64)
    if assignee:
        out["assignee"] = assignee
    # #3060: the parents it was linked to at creation, from the same native event.
    parents = event.get("parents")
    if isinstance(parents, list):
        linked = [p for p in parents if isinstance(p, str) and bm._CARD_ID.match(p)][:PARENTS_MAX]
        if linked:
            out["parents"] = linked
    return out


_CARD_SQL = ("SELECT t.id, t.title, t.status, t.assignee, t.priority, (SELECT e.payload FROM task_events e"
             " WHERE e.task_id = t.id AND e.kind = 'created' ORDER BY e.id LIMIT 1) AS created FROM tasks t WHERE ")


def _find(conn, key: str):
    """The card this native key made, archived included (stock's own lookup
    skips archived cards)."""
    return conn.execute(_CARD_SQL + "t.idempotency_key = ? ORDER BY t.created_at, t.id LIMIT 1", [key]).fetchone()


def _write(db: Path, slug: str, intent: dict, key: str) -> dict:
    import hermes_cli.kanban_db as kb
    from hermes_cli.kanban_db_connect import connect, write_txn
    conn = connect(db_path=db)
    try:
        with write_txn(conn):
            row = _find(conn, key)
            if row is None:
                parents = tuple(intent.get("parents") or ())
                # #3060: checked again under the writer lock; stock would link an archived parent.
                if not _parents_live(conn, list(parents)):
                    raise _ParentsGone()
                task_id = kb.create_task(
                    conn, title=intent["title"], body=intent["body"], assignee=intent["assignee"],
                    created_by=CREATED_BY, workspace_kind="scratch", project_id="",
                    priority=intent["priority"], parents=parents, triage=intent["lane"] == "triage",
                    idempotency_key=key, initial_status="running", board=slug)
                row = conn.execute(_CARD_SQL + "t.id = ?", [task_id]).fetchone()
        return {"card": _card(row, intent["lane"]), "archived": row["status"] == "archived"}
    finally:
        conn.close()


def _read_back(db: Path, key: str, lane: str) -> Optional[dict]:
    """After a failed write: the card the key made, or None. Raises if the
    store cannot be read (the outcome is then unknown)."""
    def body(conn):
        conn.row_factory = sqlite3.Row
        return _find(conn, key)
    row = bm._read(db, body)
    return None if row is None else {"card": _card(row, lane), "archived": row["status"] == "archived"}


def _still_live(db: Path, card_id: str) -> bool:
    def body(conn):
        return conn.execute("SELECT status FROM tasks WHERE id = ?", [card_id]).fetchone()
    row = bm._read(db, body)
    return row is not None and row[0] != "archived"


# --------------------------------------------------------------------------
# Operation
# --------------------------------------------------------------------------

def _gateway() -> str:
    from .board_moments import gateway_id
    return gateway_id()


def _capability(capabilities: list, key: str = "create") -> None:
    row = next((r for r in capabilities if r["key"] == key), None)
    if row is None or not row.get("enabled"):
        raise bm.BoardReadError((row or {}).get("code") or "unsupported")


def _capabilities(capabilities: list, intent: dict) -> None:
    """``create``, and ``dependencies`` (#3060) when the card names parents."""
    _capability(capabilities)
    if intent.get("parents"):
        _capability(capabilities, "dependencies")


def _answer(slug: str, meta: Path, receipt: dict) -> dict:
    return {"target": {"slug": slug, "name": bm._metadata(slug, meta)["name"]},
            "receipt": wire_receipt(receipt)}


def wire_receipt(receipt: dict) -> dict:
    """The receipt as the phone reads it: key, operation, state, and the
    card and watch (succeeded) or the code (refused)."""
    if receipt["operation"] == "board.decompose":
        from . import board_decompose
        return board_decompose.wire_receipt(receipt)
    tombstone = receipt["operation"] == board_ops.TOMBSTONE
    out = {"key": receipt["key"], "operation": "create" if not tombstone else "unknown",
           "state": receipt["state"]}
    result = receipt.get("result") or {}
    if receipt["state"] == "succeeded" and isinstance(result.get("card"), dict):
        out["card"] = result["card"]
        out["watch"] = {"mode": result.get("watch", "off"), "applied": bool(result.get("watchApplied"))}
    if receipt["state"] == "refused":
        out["code"] = receipt.get("code") or "invalid_request"
    return out


def _watch_step(profile: str, slug: str, db: Path, meta: Path, receipt: dict) -> dict:
    """Watch the new card in the chosen mode (#3050's store), once. A crash
    before it is recorded runs it again on the next same-key attempt."""
    result = receipt.get("result") or {}
    if result.get("watchApplied"):
        return receipt
    mode = result.get("watch", "off")
    if mode != "off":
        try:
            bm.set_watch(profile, slug, result["card"]["id"], db, meta, mode)
        except bm.BoardReadError:
            return receipt
    try:
        return board_ops.merge_result(receipt["key"], {"watchApplied": True})
    except board_ops.OpStoreError:
        return receipt


def create(root: Path, payload, profile: str, capabilities: list) -> dict:
    slug, anchor, key, intent = parse(payload)
    _capabilities(capabilities, intent)
    db, meta = bm.board_paths(root, slug)
    gateway = _gateway()
    nkey = native_key(gateway, profile, slug, key)
    try:
        receipt = board_ops.begin(key, gateway=gateway, profile=profile, operation=OPERATION, board=slug,
                                  anchor=anchor, intent_digest=board_ops.digest(intent), native_key=nkey,
                                  pending={"watch": intent["watch"], "lane": intent["lane"]})
    except board_ops.OpRefused as refusal:
        raise bm.BoardReadError(refusal.code) from None
    except board_ops.OpStoreError:
        # Nothing is written to Hermes without a durable pending receipt.
        raise bm.BoardReadError("temporarily_unavailable") from None
    if receipt["state"] in ("refused", "outcome_unknown"):
        raise bm.BoardReadError(receipt.get("code") or receipt["state"])
    if receipt["state"] == "pending":
        barrier("receipted")
        receipt = _execute(root, slug, anchor, intent, key, nkey, capabilities)
        if receipt["state"] != "succeeded":
            raise bm.BoardReadError(receipt.get("code") or receipt["state"])
        barrier("succeeded")
    else:
        # Same key, same intent, already applied: the original answer, unless
        # the card it made was archived or its board replaced since.
        card = (receipt.get("result") or {}).get("card") or {}
        try:
            live = bool(card.get("id")) and _still_live(db, card["id"]) and \
                bm.board_anchor(root, bm._file_identity(db)) == receipt["anchor"]
        except (bm.BoardReadError, OSError):
            live = False
        if not live:
            raise bm.BoardReadError("stale_target")
    receipt = _watch_step(profile, slug, db, meta, receipt)
    barrier("watched")
    return _answer(slug, meta, receipt)


def _refuse(key: str, code: str) -> dict:
    return board_ops.finish(key, "refused", code=code)


def _execute(root: Path, slug: str, anchor: str, intent: dict, key: str, nkey: str,
             capabilities: list) -> dict:
    """Checks, the native write and the final receipt, for a pending receipt."""
    try:
        db, meta = _ready(root, slug, anchor, tuple(intent.get("parents") or ()))
        if intent["assignee"] is not None and not _assignee_exists(intent["assignee"]):
            return _refuse(key, "invalid_request")
        # Capability and authority, again, right before the write.
        _capabilities(bm.board_capabilities(), intent)
        _capabilities(capabilities, intent)
    except bm.BoardReadError as refusal:
        return _refuse(key, refusal.code)
    except OSError:
        return _refuse(key, "temporarily_unavailable")
    try:
        written = _write(db, slug, intent, nkey)
    except _ParentsGone:
        # Rolled back before stock was called: nothing was written.
        return _refuse(key, "stale_target")
    except Exception as exc:  # noqa: BLE001 - the outcome decides, never the exception text
        # A failure after COMMIT (a post-commit invariant check) leaves the
        # card committed; anything before it rolled back. Read to know which.
        try:
            written = _read_back(db, nkey, intent["lane"])
        except Exception:  # noqa: BLE001
            return board_ops.finish(key, "outcome_unknown")
        if written is None:
            code = "invalid_request" if isinstance(exc, ValueError) else "temporarily_unavailable"
            return _refuse(key, code)
    barrier("committed")
    result = {"card": written["card"], "watch": intent["watch"]}
    receipt = board_ops.finish(key, "succeeded", result=result)
    if written["archived"]:
        # The key's card was made by an earlier attempt and archived since.
        raise bm.BoardReadError("stale_target")
    return receipt


def lookup(root: Path, payload, profile: str) -> dict:
    """``board.receipt``: the receipt for ``key``, resolving a pending one
    whose writer died from native state. Never writes Hermes."""
    if not isinstance(payload, dict) or set(payload) - {"key"}:
        raise bm.BoardReadError("invalid_request")
    key = payload.get("key")
    gateway = _gateway()
    try:
        receipt = board_ops.lookup(key if isinstance(key, str) else "", gateway=gateway, profile=profile)
    except board_ops.OpRefused as refusal:
        raise bm.BoardReadError(refusal.code) from None
    except board_ops.OpStoreError:
        raise bm.BoardReadError("temporarily_unavailable") from None
    if receipt["operation"] == board_ops.TOMBSTONE:
        return {"receipt": wire_receipt(receipt)}
    from . import board_actions, board_review
    if receipt["operation"] == board_review.OPERATION:
        # #3056: a verdict's receipt, settled by its own rules.
        return board_review.looked_up(root, receipt)
    from . import board_comment
    if receipt["operation"] == board_comment.OPERATION:
        # #3058: a comment's receipt, settled by its own rules (never resent).
        return board_comment.looked_up(root, receipt)
    if receipt["operation"] == "board.decompose":
        # #3060: a split's receipt resolves by its own rules (it is not idempotent).
        from . import board_decompose
        return board_decompose.lookup_receipt(root, receipt)
    if receipt["operation"] == board_actions.OPERATION:
        # #3059: a card action's receipt, settled by its own rules.
        return board_actions.looked_up(root, receipt, profile)
    slug = receipt["board"]
    db, meta = bm.board_paths(root, slug)
    if receipt["state"] == "pending" and not board_ops.writer_live(receipt):
        receipt = _resolve_dead(root, receipt, db)
    if receipt["state"] == "succeeded":
        receipt = _watch_step(profile, slug, db, meta, receipt)
    return _answer(slug, meta, receipt)


def _resolve_dead(root: Path, receipt: dict, db: Path) -> dict:
    """A pending receipt whose writer died: the card its native key made, or
    none. Resolved only for the writer that died (a retry that took over in
    the meantime owns it) and only on the board instance it named."""
    writer = (receipt.get("writer_pid"), receipt.get("writer_start"))
    try:
        same = db.is_file() and bm.board_anchor(root, bm._file_identity(db)) == receipt["anchor"]
        pending = receipt.get("result") or {}
        found = _read_back(db, receipt["native_key"], pending.get("lane", "triage")) if same else None
    except (bm.BoardReadError, OSError):
        # Busy or unreadable now: still pending, ask again.
        return receipt
    try:
        if not same:
            return board_ops.finish(receipt["key"], "outcome_unknown", writer=writer)
        if found is None:
            return board_ops.finish(receipt["key"], "refused", code="expired_request", writer=writer)
        # The pending receipt carries the watch mode the attempt asked for.
        watch = (receipt.get("result") or {}).get("watch", "off")
        return board_ops.finish(receipt["key"], "succeeded", writer=writer,
                                result={"card": found["card"], "watch": watch})
    except board_ops.OpStoreError:
        return receipt
