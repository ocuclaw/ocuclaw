"""Hermes Board moments (#3051); contract in docs/hermes-board/contract.md.

A moment is a curated event about a watched card that asks for the wearer:
a review request, a question, or a failure. The chain is

    read-only event tail -> durable pending delivery -> relay push
    -> phone ack -> delivery settled

and each step is OcuClaw's own. Stock only: Hermes' ``task_events`` table is
read ``mode=ro`` through ``board_tail`` (the #3038 checkpoint), notification
prose is never parsed, and nothing is written to Hermes. Native
``kanban_notify_subs`` rows are never read or written here.

Storage is OcuClaw's Board store (``board_watch.store_path()``). Per profile
and board it keeps the #3038 checkpoint (``board_tail``) and each watch's
starting event (``board_watch_since``); ``board_moment`` holds deliveries.
New pending deliveries and the advanced checkpoint commit in one
transaction, so a crash either keeps both or neither: the cursor never moves
past an event whose moment was not stored.

Tail progress and delivery are separate. A push to the relay is a doorbell,
not an acknowledgement; a delivery stays pending, and is pushed again every
``RESEND_SECONDS``, until the phone's ``board.moment.ack`` names it or it
expires. A repeated ack is harmless. Periodic catch-up (``INTERVAL_SECONDS``)
is the only trigger; no notifier metadata is needed.

#3052 makes the chain survive the rest of real life. A restart pushes every
pending delivery at once. A push no phone received does not wait out the
resend delay. Unwatching (or the card leaving the board) cancels that
watch's pending deliveries. A resnapshot is recorded, and one that proves a
new board lifetime supersedes the old lifetime's pending deliveries. A new
relay pairing (delivery authority) reopens what the old pairing acked. Each
persistence, send and ack boundary calls :func:`_at`, so a crash test can
SIGKILL a real process exactly there.

#3053 adds the backend's delivery policy (``board_policy``): moments on or
off, the quiet done moment, and quiet hours in the stored time zone, with
unknown policy holding every push. Each card keeps at most one pending
delivery (its newest event; older ones settle as ``coalesced``), and a card
at its cap waits. Moments follow explicit Board watches only: native
subscriptions (auto-subscribe on create, child inheritance) are never read.
"""
from __future__ import annotations

import asyncio
import base64
from functools import lru_cache
import hashlib
import json
import logging
import re
import socket
import sqlite3
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional

from . import board_management as bm
from . import board_policy
from . import board_tail
from . import board_watch

logger = logging.getLogger(__name__)

MOMENT_VERSION = 1
#: Python -> Node: pending moments for the phone (a doorbell, never an ack).
PUSH_METHOD = "board.moment.push"
#: Node -> Python: the phone accepted a delivery.
ACK_METHOD = "board.moment.ack"

ATTENTION_CLASSES = ("review", "question", "failure")
#: #3053: the quiet completion moment, only when the profile's policy turns
#: it on (off by default). It asks nothing of the wearer: the phone never
#: interrupts for it and it never counts as attention.
DONE = "done"
#: Every class an envelope may carry.
MOMENT_CLASSES = ATTENTION_CLASSES + (DONE,)
#: What the phone reports it did with a moment: ``durable`` (kept in its Board
#: delivery state across a reload) or ``volatile`` (shown, but its storage
#: refused the write). The store keeps which, so the weaker state is never
#: reported as durable (#3052).
ACK_STATES = ("durable", "volatile")
#: A moment expires this long after its event; an older event never becomes one.
EXPIRY_SECONDS = 24 * 3600
#: Pending deliveries one profile may hold across all its boards. At the cap
#: every tail of that profile pauses (the cursor stays) instead of dropping
#: anything. #3052: below the phone's 256 remembered delivery ids, so every
#: resend of a pending delivery is still recognised as a repeat; the load
#: test (tests/test_board_moments_robust.py) holds a full queue's tick well
#: inside the interval.
MAX_PENDING = 200
#: Events one tail step reads (never more than the pending room left). The
#: load test measured a full step at ≤12 ms on both pins, so one tick
#: catches up a busy board.
TAIL_BATCH = 200
#: Moments one push carries (Node refuses more than 20; ~12 KB measured). A
#: full queue drains in MAX_PENDING / PUSH_BATCH ticks.
PUSH_BATCH = 20
INTERVAL_SECONDS = 5.0
RESEND_SECONDS = 15
PUSH_TIMEOUT_SECONDS = 10.0
#: #3053 per-card cap: a card's new moment is pushed only while fewer than
#: ``CARD_CAP`` of that card's moments were acked in the last
#: ``CARD_WINDOW_SECONDS``. Past it the moment waits (still pending, still
#: durable), and a newer one for the card replaces it (per-card coalescing),
#: so a flapping worker reaches the wearer at most twice in ten minutes and
#: then as its latest event.
CARD_CAP = 2
CARD_WINDOW_SECONDS = 600

#: #3052: resnapshot reasons that prove the board is another lifetime (not
#: only pruned history). Pending deliveries from the old lifetime name cards
#: and an anchor that no longer exist, so they are superseded.
LIFETIME_REASONS = frozenset({"board_missing", "file_replaced", "board_recreated", "sequence_regressed",
                              "anchor_changed", "board_moved"})
#: #3052: a stored checkpoint that cannot be read back. It resnapshots like
#: pruned history: the board is the same, only the cursor is lost.
CURSOR_INVALID = "cursor_invalid"
#: #3052: the checkpoint names another store file than this board's path
#: (the kanban root moved). Another file is another lifetime.
BOARD_MOVED = "board_moved"

#: #3052: every point where a crash leaves a distinct state. Each is passed to
#: :func:`_at`, in this order for one delivery.
BARRIER_POINTS = ("tail.read", "tail.stored", "tail.committed", "due.stored",
                  "push.sending", "push.sent", "ack.stored", "ack.committed")


def _at(point: str) -> None:
    """Crash-test seam, a no-op in production. ``*.stored`` points run inside
    the write transaction before COMMIT; the others between steps.
    ``tests/board_moments_child.py`` replaces it with a line barrier."""
    return None

_ID = re.compile(r"^[A-Za-z0-9_-]{22}$")
_GATEWAY = re.compile(r"^[0-9a-f]{16}$")
_PROFILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_KIND = re.compile(r"^[a-z][a-z_]{0,31}$")
TITLE_MAX = 200
LINE_MAX = 120

#: The fixed line a moment shows under the card title. No worker prose
#: crosses in a moment; the card sheet carries the question or summary.
_FAILURE_LINES = {
    "crashed": "The run crashed.",
    "timed_out": "The run timed out.",
    "gave_up": "Hermes gave up on this card.",
    "blocked": "Blocked.",
    "block_loop_detected": "Blocked again. Moved to triage.",
}
_LINES = {"review": "Ready for your review.", "question": "Needs your answer."}
_LOOP_QUESTION_LINE = "Asked again. Moved to triage."

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS board_tail ("
    " profile TEXT NOT NULL, board TEXT NOT NULL, checkpoint TEXT NOT NULL,"
    " updated_at INTEGER NOT NULL, PRIMARY KEY (profile, board))",
    "CREATE TABLE IF NOT EXISTS board_watch_since ("
    " profile TEXT NOT NULL, board TEXT NOT NULL, task TEXT NOT NULL, since INTEGER NOT NULL,"
    " PRIMARY KEY (profile, board, task))",
    "CREATE TABLE IF NOT EXISTS board_moment ("
    " delivery TEXT PRIMARY KEY, profile TEXT NOT NULL, board TEXT NOT NULL, task TEXT NOT NULL,"
    " source TEXT NOT NULL, envelope TEXT NOT NULL, state TEXT NOT NULL, ack TEXT,"
    " created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, sent_at INTEGER,"
    " attempts INTEGER NOT NULL DEFAULT 0, attention TEXT, event INTEGER, acked_at INTEGER,"
    " UNIQUE (profile, source))",
    # #3052: the last explicit resnapshot per scope (evidence), and the
    # delivery authority the store last served under.
    "CREATE TABLE IF NOT EXISTS board_tail_reset ("
    " profile TEXT NOT NULL, board TEXT NOT NULL, reasons TEXT NOT NULL, superseded INTEGER NOT NULL,"
    " at INTEGER NOT NULL, PRIMARY KEY (profile, board))",
    "CREATE TABLE IF NOT EXISTS board_moment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    # #3053: the moment policy per profile (board_policy.py).
    board_policy.SCHEMA,
)
#: #3053: columns added to ``board_moment`` after #3052 shipped its store:
#: the moment class (so a policy change can cancel done moments), the source
#: event id (per-card coalescing keeps the newest) and when the phone acked
#: it (the per-card cap).
_ADDED_COLUMNS = (("attention", "TEXT"), ("event", "INTEGER"), ("acked_at", "INTEGER"))


class MomentStoreError(Exception):
    """OcuClaw's moment store cannot be read or written right now."""


# --------------------------------------------------------------------------
# Attention class
# --------------------------------------------------------------------------

def attention_class(kind: Any, payload: Any) -> Optional[str]:
    """The moment class of one native event, or None when it is not a moment.

    Mirrors upstream ``diagnostic_event`` (0.21.4 and later, in the gateway's
    kanban notifier), re-implemented because 0.21.1 and 0.21.3 lack it and the
    tail reads native events itself on every pin: ``review_requested`` is a review; ``blocked`` or
    ``block_loop_detected`` with payload kind ``needs_input`` is a question;
    ``crashed``, ``timed_out``, ``gave_up``, any other block (other kind or
    none) and a ``status`` change to ``blocked`` or ``triage`` are failures.
    """
    payload = payload if isinstance(payload, dict) else {}
    if kind == "review_requested":
        return "review"
    if kind in ("blocked", "block_loop_detected"):
        return "question" if payload.get("kind") == "needs_input" else "failure"
    if kind in ("crashed", "timed_out", "gave_up"):
        return "failure"
    if kind == "status" and payload.get("status") in ("blocked", "triage"):
        return "failure"
    return None


def done_class(kind: Any, payload: Any) -> Optional[str]:
    """#3053: ``done`` for a completion (``completed``, or a ``status`` change
    to ``done``), else None. It is a moment only when the profile's policy
    turns done moments on; it is never attention."""
    payload = payload if isinstance(payload, dict) else {}
    if kind == "completed" or (kind == "status" and payload.get("status") == "done"):
        return DONE
    return None


def moment_line(kind: str, payload: dict, attention: str) -> str:
    if attention == DONE:
        return "Moved to done." if kind == "status" else "Done."
    if kind == "block_loop_detected" and attention == "question":
        # #3058: the stock loop breaker sent the card to triage, not to a new
        # question: it is still a question moment, but nothing waits for an answer.
        return _LOOP_QUESTION_LINE
    if attention in _LINES:
        return _LINES[attention]
    if kind == "status":
        return "Moved to triage." if payload.get("status") == "triage" else "Moved to blocked."
    return _FAILURE_LINES.get(kind, "Needs attention.")


def _payload(value) -> dict:
    try:
        loaded = json.loads(value) if isinstance(value, str) else None
    except ValueError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


# --------------------------------------------------------------------------
# Envelope
# --------------------------------------------------------------------------

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _id(*parts: Any) -> str:
    return _b64(hashlib.sha256("\0".join(str(p) for p in parts).encode()).digest()[:16])


def source_id(root: Path, slug: str, event_id: int, event_hash: str) -> str:
    """The source event's identity: this root's board, the event id and the
    row's content hash (#3038: the same id with another hash is another board
    lifetime). The same for every subscriber."""
    return _id("source", root, slug, event_id, event_hash)


def delivery_id(gateway: str, profile: str, source: str) -> str:
    """One subscriber's delivery of one source event. Deterministic, so a
    re-run of the tail after a crash names the same delivery."""
    return _id("delivery", gateway, profile, source)


@lru_cache(maxsize=1)
def gateway_id() -> str:
    """This gateway: its host and process Hermes home, as ``restart_rpc``
    names it. Opaque."""
    from . import receipts
    home = receipts.resolve_receipt_home()
    parts: list = [socket.gethostname()]
    if home is not None:
        try:
            st = Path(home).stat()
            parts += [str(Path(home).resolve()), st.st_dev, st.st_ino]
        except OSError:
            parts.append(str(home))
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:16]


def action_guard(capabilities: Iterable[dict]) -> dict:
    """What a moment may offer: a verdict (``approve``) and an answer
    (``answer_and_unblock``), each as its capability row says. A certified
    engine turns the verdict on (#3056); the answer is ``unsupported`` on
    every engine (#3058)."""
    rows = {row["key"]: row for row in capabilities}

    def guard(key: str) -> dict:
        row = rows.get(key) or {"enabled": False, "code": "unsupported"}
        if row.get("enabled"):
            return {"enabled": True}
        out = {"enabled": False, "code": row.get("code") or "unsupported"}
        if "owner" in row:
            out["owner"] = row["owner"]
        return out

    return {"verdict": guard("approve"), "answer": guard("answer_and_unblock")}


def build_envelope(*, gateway: str, profile: str, root: Path, slug: str, board_name: str, anchor: str,
                   event: dict, title: str, attention: str, actions: dict) -> dict:
    kind = event["kind"]
    source = source_id(root, slug, event["id"], event["hash"])
    ev = {"id": int(event["id"]), "kind": kind, "at": int(event["created_at"])}
    if isinstance(event.get("run_id"), int) and event["run_id"] > 0:
        ev["runId"] = int(event["run_id"])
    return {
        "v": MOMENT_VERSION,
        "deliveryId": delivery_id(gateway, profile, source),
        "sourceId": source,
        "gateway": gateway,
        "profile": profile,
        "board": {"slug": slug, "name": board_name, "anchor": anchor},
        "card": {"id": event["task_id"], "title": title},
        "event": ev,
        "attention": attention,
        "expiresAt": int(event["created_at"]) + EXPIRY_SECONDS,
        "display": {"line": moment_line(kind, _payload(event.get("payload")), attention)},
        "actions": actions,
    }


def _text(value: Any, limit: int) -> bool:
    return (isinstance(value, str) and 0 < len(value) <= limit
            and all(c.isprintable() for c in value))


def _whole(value: Any, low: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= low


#: The contract's closed Board codes; a guard that is off names one.
BOARD_CODES = frozenset({
    "unsupported", "uncertified", "schema_unsupported", "store_missing", "invalid_target",
    "empty_board", "temporarily_unavailable", "disconnected", "stale_target", "stale_scope",
    "expired_request", "outcome_unknown", "deferred",
})


def _guard_valid(value: Any) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("enabled"), bool):
        return False
    if value["enabled"]:
        return set(value) == {"enabled"}
    if not set(value) <= {"enabled", "code", "owner"} or value.get("code") not in BOARD_CODES:
        return False
    return "owner" not in value or _whole(value["owner"], 1)


def valid_envelope(env: Any) -> bool:
    """Strict: exact keys, closed values, bounded text. The same rules Node
    and the phone apply at their boundaries."""
    try:
        if not isinstance(env, dict) or set(env) != {
                "v", "deliveryId", "sourceId", "gateway", "profile", "board", "card", "event",
                "attention", "expiresAt", "display", "actions"}:
            return False
        board, card, event = env["board"], env["card"], env["event"]
        display, actions = env["display"], env["actions"]
        return (
            env["v"] == MOMENT_VERSION
            and all(isinstance(env[k], str) and _ID.match(env[k]) for k in ("deliveryId", "sourceId"))
            and isinstance(env["gateway"], str) and bool(_GATEWAY.match(env["gateway"]))
            and isinstance(env["profile"], str) and bool(_PROFILE.match(env["profile"]))
            and isinstance(board, dict) and set(board) == {"slug", "name", "anchor"}
            and isinstance(board["slug"], str) and bool(bm._SLUG.match(board["slug"]))
            and _text(board["name"], 80)
            and isinstance(board["anchor"], str) and bool(bm._ANCHOR.match(board["anchor"]))
            and isinstance(card, dict) and set(card) == {"id", "title"}
            and isinstance(card["id"], str) and bool(bm._CARD_ID.match(card["id"]))
            and _text(card["title"], TITLE_MAX)
            and isinstance(event, dict) and set(event) - {"runId"} == {"id", "kind", "at"}
            and _whole(event["id"], 1) and isinstance(event["kind"], str) and bool(_KIND.match(event["kind"]))
            and _whole(event["at"]) and ("runId" not in event or _whole(event["runId"], 1))
            and env["attention"] in MOMENT_CLASSES
            and _whole(env["expiresAt"])
            and isinstance(display, dict) and set(display) == {"line"} and _text(display["line"], LINE_MAX)
            and isinstance(actions, dict) and set(actions) == {"verdict", "answer"}
            and all(_guard_valid(actions[k]) for k in ("verdict", "answer"))
        )
    except (KeyError, TypeError):
        return False


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------

def _open() -> sqlite3.Connection:
    try:
        conn = board_watch._open(create=True)
    except board_watch.WatchStoreError:
        raise MomentStoreError("store unavailable") from None
    try:
        for statement in _SCHEMA:
            conn.execute(statement)
        have = {row[1] for row in conn.execute("PRAGMA table_info(board_moment)")}
        for name, kind in _ADDED_COLUMNS:
            if name not in have:
                conn.execute(f"ALTER TABLE board_moment ADD COLUMN {name} {kind}")
    except sqlite3.Error:
        conn.close()
        raise MomentStoreError("store unavailable") from None
    return conn


def _write(body: Callable[[sqlite3.Connection], Any]) -> Any:
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
        raise MomentStoreError("store unwritable") from None
    finally:
        conn.close()


def note_watch(profile: str, slug: str, task: str, db: Path, meta: Optional[Path], mode: str) -> None:
    """Record where a watch starts, before the watch is stored.

    ``notify``: the card's moments start after the board's current event
    (a watch never replays history), and the first watch on a board takes the
    #3038 checkpoint there. Setting ``notify`` again keeps the first start, so
    events not yet tailed are not skipped. ``off`` forgets the start and
    cancels that watch's pending deliveries (#3052); :func:`due` cancels any
    a crash left between the two writes."""
    if mode != "notify":
        def forget(conn):
            conn.execute("DELETE FROM board_watch_since WHERE profile = ? AND board = ? AND task = ?",
                         [profile, slug, task])
            conn.execute("UPDATE board_moment SET state = 'cancelled' WHERE profile = ? AND board = ?"
                         " AND task = ? AND state = 'pending'", [profile, slug, task])
        _write(forget)
        return
    try:
        _, cp = board_tail.first_watch(db, meta)
    except (OSError, sqlite3.Error):
        raise MomentStoreError("board unreadable") from None
    now = int(time.time())

    def body(conn):
        conn.execute(
            "INSERT OR IGNORE INTO board_tail (profile, board, checkpoint, updated_at) VALUES (?, ?, ?, ?)",
            [profile, slug, board_tail.to_json(cp), now])
        conn.execute(
            "INSERT OR IGNORE INTO board_watch_since (profile, board, task, since) VALUES (?, ?, ?, ?)",
            [profile, slug, task, cp.cursor])

    _write(body)


def _titles(conn: sqlite3.Connection, events: list) -> dict:
    ids = sorted({e["task_id"] for e in events if isinstance(e.get("task_id"), str)})
    out = {}
    for start in range(0, len(ids), 200):
        chunk = ids[start:start + 200]
        for row in conn.execute("SELECT id, title FROM tasks WHERE id IN (" + ",".join("?" for _ in chunk) + ")",
                                chunk):
            out[row[0]] = row[1]
    return out


def tail_scope(profile: str, slug: str, root: Path, *, now: Optional[int] = None,
               capabilities: Optional[list] = None) -> dict:
    """One catch-up step for one profile on one board. Returns what happened:
    ``{"action": "idle"|"boundary"|"paused"|"resnapshot"|"events", "new": n, ...}``."""
    now = int(time.time()) if now is None else now
    db, meta = bm.board_paths(root, slug)
    watched = set(board_watch.watched(profile, slug))
    if not watched:
        return {"action": "idle", "new": 0}
    conn = _open()
    try:
        row = conn.execute("SELECT checkpoint FROM board_tail WHERE profile = ? AND board = ?",
                           [profile, slug]).fetchone()
        since = dict(conn.execute("SELECT task, since FROM board_watch_since WHERE profile = ? AND board = ?",
                                  [profile, slug]).fetchall())
        # #3052: the cap is per profile, across its boards: the phone keeps
        # one delivery state per profile.
        pending = conn.execute("SELECT COUNT(*) FROM board_moment WHERE profile = ? AND state = 'pending'",
                               [profile]).fetchone()[0]
        # #3053: the profile's moment policy, read with the rest. A row that
        # does not read back is unknown: its moments are stored and held.
        policy = board_policy.load(conn, profile)
    except sqlite3.Error:
        raise MomentStoreError("store unreadable") from None
    finally:
        conn.close()
    stored = row[0] if row else None
    cp = board_tail.from_json(stored) if stored else None
    if stored is None:
        # First watch on this board: a boundary at the current event, never a replay.
        if not db.is_file():
            return {"action": "idle", "new": 0}
        _, fresh = board_tail.first_watch(db, meta)
        _write(lambda c: c.execute(
            "INSERT OR IGNORE INTO board_tail (profile, board, checkpoint, updated_at) VALUES (?, ?, ?, ?)",
            [profile, slug, board_tail.to_json(fresh), now]))
        return {"action": "boundary", "new": 0}
    if cp is None or Path(cp.db) != db:
        # #3052: a checkpoint that cannot be read back, or one for another
        # store file, is an explicit resnapshot, never a silent restart.
        reason = CURSOR_INVALID if cp is None else BOARD_MOVED
        if not db.is_file():
            fresh = None
        else:
            _, fresh = board_tail.first_watch(db, meta)
        return _resnapshot(profile, slug, stored, fresh, [reason], now)
    if pending >= MAX_PENDING:
        return {"action": "paused", "new": 0, "pending": pending}
    # Each event is at most one moment, so reading no more events than the
    # room left keeps the cap exact.
    result = board_tail.tail(cp, min(TAIL_BATCH, MAX_PENDING - pending), facts=_titles)
    if result.action == "resnapshot":
        # The board was replaced, restored or pruned: move to its current
        # boundary and deliver no history. Current attention is in the board.
        return _resnapshot(profile, slug, stored, result.checkpoint, list(result.reasons), now)
    _at("tail.read")
    titles = result.facts or {}
    gateway = gateway_id()
    caps = capabilities if capabilities is not None else bm.board_capabilities()
    actions = action_guard(caps)
    anchor = bm.board_anchor(root, [cp.dev, cp.ino])
    board_name = bm._metadata(slug, meta)["name"]
    moments = []
    # #3053: moments off moves the tail on and stores nothing, so turning them
    # on again never replays what happened while they were off. Unknown keeps
    # storing (held at push time); done moments need a known policy that
    # turns them on.
    off = policy.state != "unknown" and not policy.moments
    with_done = policy.state != "unknown" and policy.moments and policy.done
    for event in [] if off else result.events:
        task = event.get("task_id")
        if task not in watched or not isinstance(event.get("id"), int) or event["id"] <= since.get(task, 0):
            continue
        payload = _payload(event.get("payload"))
        attention = attention_class(event.get("kind"), payload)
        if attention is None and with_done:
            attention = done_class(event.get("kind"), payload)
        if attention is None or not isinstance(event.get("created_at"), int):
            continue
        if owned_by_create(profile, slug, event):
            continue
        if event["created_at"] + EXPIRY_SECONDS <= now:
            continue  # too old to interrupt; the board shows the current state
        title = bm._clean(titles.get(task), TITLE_MAX) or "Untitled"
        env = build_envelope(gateway=gateway, profile=profile, root=root, slug=slug, board_name=board_name,
                             anchor=anchor, event=event, title=title, attention=attention, actions=actions)
        if valid_envelope(env):
            moments.append(env)
        else:
            logger.warning("[ocuclaw] board moment refused by its own validator (event %s)", event.get("id"))

    def commit(c):
        # Another step moved the checkpoint first: leave it, the next step
        # reads from there. Deliveries and the cursor commit together.
        if _stored(c, profile, slug) != stored:
            return 0, 0
        # #3052: a watch turned off since the read gets nothing: the watch
        # table is in this store, so this transaction sees the latest.
        still = {t for (t,) in c.execute(
            "SELECT task FROM board_watch WHERE profile = ? AND board = ? AND mode != 'off'", [profile, slug])}
        added = coalesced = 0
        for env in moments:
            card = env["card"]["id"]
            if card not in still:
                continue
            cur = c.execute(
                "INSERT OR IGNORE INTO board_moment (delivery, profile, board, task, source, envelope, state,"
                " created_at, expires_at, attention, event) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
                [env["deliveryId"], profile, slug, card, env["sourceId"],
                 json.dumps(env, sort_keys=True), now, env["expiresAt"], env["attention"], env["event"]["id"]])
            added += cur.rowcount
            if cur.rowcount:
                # #3053 per-card coalescing: the card's newest moment replaces
                # its older pending ones. The survivor is that newer event's
                # own envelope, never a merge: a historical completion and a
                # newer review request never become an invented present state.
                coalesced += c.execute(
                    "UPDATE board_moment SET state = 'coalesced' WHERE profile = ? AND board = ? AND task = ?"
                    " AND state = 'pending' AND delivery != ? AND COALESCE(event, 0) < ?",
                    [profile, slug, card, env["deliveryId"], env["event"]["id"]]).rowcount
        c.execute("UPDATE board_tail SET checkpoint = ?, updated_at = ? WHERE profile = ? AND board = ?",
                  [board_tail.to_json(result.checkpoint), now, profile, slug])
        _at("tail.stored")
        return added, coalesced

    added, coalesced = _write(commit)
    _at("tail.committed")
    out = {"action": "events", "new": added, "read": len(result.events)}
    if coalesced:
        out["coalesced"] = coalesced
    return out


def owned_by_create(profile: str, slug: str, event: dict) -> bool:
    """#3055's seam: whether this source event is the wearer's own create,
    already confirmed on the phone by its create receipt, so it must not
    become a second notification. #3053 leaves it False: no event the tail
    turns into a moment comes from a create today (``created`` is never a
    moment, and a watch starts after the board's current event). #3055
    replaces this with a lookup in its receipts, keyed by profile, board and
    card, and reconciles its receipt with the source event here."""
    return False


def _resnapshot(profile: str, slug: str, stored: Optional[str], fresh: Optional[board_tail.Checkpoint],
                reasons: list, now: int) -> dict:
    """Move this scope to the board's current boundary and deliver no
    history (#3038). #3052 makes it explicit: the reasons are recorded per
    scope, and a new lifetime supersedes the scope's pending deliveries,
    which name cards and an anchor of a board that is gone. Pruned history or
    a lost cursor keeps them: they are real events of this board."""
    lifetime = bool(LIFETIME_REASONS.intersection(reasons))

    def reset(c):
        if _stored(c, profile, slug) != stored:
            return None  # another step moved first; the next step reads from there
        if fresh is None:
            c.execute("DELETE FROM board_tail WHERE profile = ? AND board = ?", [profile, slug])
        else:
            c.execute("UPDATE board_tail SET checkpoint = ?, updated_at = ? WHERE profile = ? AND board = ?",
                      [board_tail.to_json(fresh), now, profile, slug])
        c.execute("DELETE FROM board_watch_since WHERE profile = ? AND board = ?", [profile, slug])
        superseded = 0
        if lifetime:
            superseded = c.execute("UPDATE board_moment SET state = 'superseded' WHERE profile = ? AND board = ?"
                                   " AND state = 'pending'", [profile, slug]).rowcount
        c.execute("INSERT OR REPLACE INTO board_tail_reset (profile, board, reasons, superseded, at)"
                  " VALUES (?, ?, ?, ?, ?)", [profile, slug, ",".join(reasons), superseded, now])
        return superseded

    superseded = _write(reset)
    if superseded is None:
        return {"action": "idle", "new": 0}
    logger.info("[ocuclaw] board moments resnapshot %s/%s: %s (superseded %d)",
                profile, slug, ",".join(reasons), superseded)
    return {"action": "resnapshot", "new": 0, "reasons": reasons, "superseded": superseded}


def _stored(conn, profile: str, slug: str) -> Optional[str]:
    row = conn.execute("SELECT checkpoint FROM board_tail WHERE profile = ? AND board = ?",
                       [profile, slug]).fetchone()
    return row[0] if row else None


def catch_up(root: Optional[Path] = None, *, now: Optional[int] = None) -> dict:
    """One catch-up step for every watched profile and board. A board that
    cannot be read now is skipped and tried again next time."""
    root = bm.board_root() if root is None else root
    out = {}
    caps = bm.board_capabilities()
    for profile, slug in board_watch.scopes():
        try:
            out[f"{profile}/{slug}"] = tail_scope(profile, slug, root, now=now, capabilities=caps)
        except (bm.BoardReadError, MomentStoreError, board_watch.WatchStoreError, OSError, sqlite3.Error) as exc:
            out[f"{profile}/{slug}"] = {"action": "skipped", "new": 0, "error": type(exc).__name__}
    return out


def due(*, now: Optional[int] = None, limit: int = PUSH_BATCH) -> list:
    """Pending moments to push now, oldest first: never sent, or sent
    ``RESEND_SECONDS`` ago without an ack. Expired ones settle as expired;
    #3052: one whose watch is gone (turned off, or its card left the board)
    settles as cancelled, whatever crash came between the two writes.

    #3053: the backend's policy decides what goes now. A profile whose
    policy is in quiet hours, or unknown (a row that does not read back, or
    a time zone this gateway cannot load), pushes nothing: its deliveries
    stay pending, durable and expiring as usual, and go when the window
    ends or the policy is saved again. A card at its cap
    (``CARD_CAP`` acked in ``CARD_WINDOW_SECONDS``) holds its next new
    moment; a resend of one already pushed is never capped."""
    now = int(time.time()) if now is None else now

    def body(conn):
        conn.execute("UPDATE board_moment SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?", [now])
        conn.execute(
            "UPDATE board_moment SET state = 'cancelled' WHERE state = 'pending' AND NOT EXISTS ("
            " SELECT 1 FROM board_watch w WHERE w.profile = board_moment.profile AND w.board = board_moment.board"
            " AND w.task = board_moment.task AND w.mode != 'off')")
        candidates = conn.execute(
            "SELECT delivery, envelope, profile, board, task, attempts FROM board_moment WHERE state = 'pending'"
            " AND (sent_at IS NULL OR sent_at <= ?) ORDER BY created_at, delivery",
            [now - RESEND_SECONDS]).fetchall()
        decisions: Dict[str, str] = {}
        rows = []
        for delivery, env, profile, board, task, attempts in candidates:
            if len(rows) >= int(limit):
                break
            if profile not in decisions:
                decisions[profile] = board_policy.decision(board_policy.load(conn, profile), now)
            if decisions[profile] != board_policy.DELIVERING:
                continue
            if not attempts and _card_recent(conn, profile, board, task, now) >= CARD_CAP:
                continue
            rows.append((delivery, env))
        conn.executemany("UPDATE board_moment SET sent_at = ?, attempts = attempts + 1 WHERE delivery = ?",
                         [[now, d] for d, _ in rows])
        if rows:
            _at("due.stored")
        return [json.loads(env) for _, env in rows]

    return _write(body)


def _card_recent(conn: sqlite3.Connection, profile: str, board: str, task: str, now: int) -> int:
    """#3053: this card's moments the phone acked in the cap window."""
    return conn.execute(
        "SELECT COUNT(*) FROM board_moment WHERE profile = ? AND board = ? AND task = ?"
        " AND acked_at IS NOT NULL AND acked_at > ?", [profile, board, task, now - CARD_WINDOW_SECONDS]).fetchone()[0]


def policy(profile: str) -> board_policy.Policy:
    """#3053: this profile's moment policy. Reads never create the store; a
    store that cannot be read raises :class:`MomentStoreError`."""
    path = board_watch.store_path()
    if path is None or not path.is_file():
        return board_policy.DEFAULT
    conn = _open()
    try:
        return board_policy.load(conn, profile)
    except sqlite3.Error:
        raise MomentStoreError("store unreadable") from None
    finally:
        conn.close()


def set_policy(profile: str, wanted: board_policy.Policy, *, now: Optional[int] = None) -> dict:
    """#3053: store this profile's moment policy (an idempotent set). In the
    same transaction, moments off cancels the profile's pending deliveries
    and done moments off cancels its pending done moments: turning a thing
    off stops what was waiting for it. Returns what was cancelled."""
    now = int(time.time()) if now is None else now

    def body(conn):
        conn.execute("INSERT INTO board_policy (profile, policy, updated_at) VALUES (?, ?, ?)"
                     " ON CONFLICT (profile) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at",
                     [profile, board_policy.to_json(wanted), now])
        if not wanted.moments:
            return conn.execute("UPDATE board_moment SET state = 'cancelled' WHERE profile = ? AND state = 'pending'",
                                [profile]).rowcount
        if not wanted.done:
            return conn.execute("UPDATE board_moment SET state = 'cancelled' WHERE profile = ? AND state = 'pending'"
                                " AND attention = ?", [profile, DONE]).rowcount
        return 0

    return {"cancelled": _write(body)}


def release(delivery_ids: Iterable[str]) -> int:
    """#3052: a push that reached no phone (the relay had no app connected)
    does not wait out ``RESEND_SECONDS``: those deliveries are due again on
    the next tick, so a phone that reconnects gets them within one interval."""
    ids = list(delivery_ids)
    if not ids:
        return 0
    return _write(lambda c: sum(c.execute(
        "UPDATE board_moment SET sent_at = NULL WHERE delivery = ? AND state = 'pending'", [d]).rowcount
        for d in ids))


def reload() -> int:
    """#3052: a restarted gateway (or a new control link) pushes every
    pending delivery at once instead of waiting out the resend delay."""
    return _write(lambda c: c.execute(
        "UPDATE board_moment SET sent_at = NULL WHERE state = 'pending' AND sent_at IS NOT NULL").rowcount)


def authority_id(relay_token: Any) -> Optional[str]:
    """The delivery authority a relay credential grants, as a one-way digest
    (the credential itself is never stored). None when the gateway runs no
    relay, so no phone can be paired."""
    if not isinstance(relay_token, str) or not relay_token:
        return None
    return hashlib.sha256(b"ocuclaw.board.moment.authority\0" + relay_token.encode()).hexdigest()[:32]


def check_authority(current: Optional[str], *, now: Optional[int] = None) -> dict:
    """#3052: a new relay pairing revokes the old one's delivery authority.
    Acks the old pairing made no longer count: every unexpired acked delivery
    is pending again and, with every other pending delivery, due at once, so
    the newly paired phone gets them (the phone shows them as one catch-up,
    and a phone that already holds one acks it without a second toast).
    The first authority seen is recorded and reopens nothing."""
    if current is None:
        return {"changed": False, "reopened": 0}
    now = int(time.time()) if now is None else now

    def body(conn):
        row = conn.execute("SELECT value FROM board_moment_meta WHERE key = 'authority'").fetchone()
        if row is not None and row[0] == current:
            return {"changed": False, "reopened": 0}
        reopened = 0
        if row is not None:
            reopened = conn.execute(
                "UPDATE board_moment SET state = 'pending', ack = NULL, sent_at = NULL"
                " WHERE state = 'acked' AND expires_at > ?", [now]).rowcount
            conn.execute("UPDATE board_moment SET sent_at = NULL WHERE state = 'pending'")
        conn.execute("INSERT OR REPLACE INTO board_moment_meta (key, value) VALUES ('authority', ?)", [current])
        return {"changed": row is not None, "reopened": reopened}

    return _write(body)


def ack(params: Any) -> dict:
    """The phone accepted a delivery. Idempotent: a repeated or late ack
    changes nothing and still answers ok."""
    if not isinstance(params, dict) or set(params) != {"deliveryId", "state"}:
        return {"ok": False, "error": "invalid_params"}
    delivery, state = params["deliveryId"], params["state"]
    if not isinstance(delivery, str) or not _ID.match(delivery) or state not in ACK_STATES:
        return {"ok": False, "error": "invalid_params"}

    now = int(time.time())

    def body(conn):
        conn.execute("UPDATE board_moment SET state = 'acked', ack = ?, acked_at = ? WHERE delivery = ?"
                     " AND state = 'pending'", [state, now, delivery])
        # #3053: a coalesced moment the phone had already taken still counts
        # toward its card's cap; its state stays coalesced.
        conn.execute("UPDATE board_moment SET ack = ?, acked_at = ? WHERE delivery = ? AND state = 'coalesced'"
                     " AND acked_at IS NULL", [state, now, delivery])
        known = conn.execute("SELECT 1 FROM board_moment WHERE delivery = ?", [delivery]).fetchone() is not None
        _at("ack.stored")
        return known

    try:
        known = _write(body)
    except MomentStoreError:
        return {"ok": False, "error": "store_unavailable"}
    _at("ack.committed")
    return {"ok": True, "known": known}


def deliveries(profile: Optional[str] = None) -> list:
    """Every stored delivery as ``{deliveryId, profile, board, task, state, ack, attempts, attention}``
    (evidence and tests; reads never create the store)."""
    path = board_watch.store_path()
    if path is None or not path.is_file():
        return []
    conn = _open()
    try:
        sql = "SELECT delivery, profile, board, task, state, ack, attempts, attention FROM board_moment"
        args: list = []
        if profile is not None:
            sql += " WHERE profile = ?"
            args.append(profile)
        rows = conn.execute(sql + " ORDER BY created_at, delivery", args).fetchall()
    finally:
        conn.close()
    keys = ("deliveryId", "profile", "board", "task", "state", "ack", "attempts", "attention")
    return [dict(zip(keys, row)) for row in rows]


def resets() -> dict:
    """#3052: the last explicit resnapshot per scope, ``{"profile/board":
    {"reasons": [...], "superseded": n, "at": t}}`` (evidence and tests)."""
    path = board_watch.store_path()
    if path is None or not path.is_file():
        return {}
    conn = _open()
    try:
        rows = conn.execute("SELECT profile, board, reasons, superseded, at FROM board_tail_reset").fetchall()
    finally:
        conn.close()
    return {f"{p}/{b}": {"reasons": r.split(","), "superseded": s, "at": t} for p, b, r, s, t in rows}


def cursor(profile: str, slug: str) -> Optional[int]:
    """The stored tail cursor for one scope, or None (evidence and tests)."""
    path = board_watch.store_path()
    if path is None or not path.is_file():
        return None
    conn = _open()
    try:
        stored = _stored(conn, profile, slug)
    finally:
        conn.close()
    cp = board_tail.from_json(stored) if stored else None
    return None if cp is None else cp.cursor


def enabled() -> bool:
    caps = bm.board_capabilities()
    return any(r["key"] == "passive_moments" and r["enabled"] for r in caps)


# --------------------------------------------------------------------------
# Pump (runs in the gateway's event loop)
# --------------------------------------------------------------------------

class MomentPump:
    """Catch up, then push what is due, every ``interval`` seconds while the
    control link is up. ``request(method, params)`` is the link's request."""

    def __init__(self, request: Callable[[str, dict], Awaitable[Any]], *, interval: float = INTERVAL_SECONDS,
                 clock: Callable[[], float] = time.time, authority: Optional[str] = None):
        self._request = request
        self._interval = interval
        self._clock = clock
        #: #3052: the delivery authority this link serves under (:func:`authority_id`).
        self._authority = authority
        #: #3052: a new pump is a restart or a new link: its first tick pushes
        #: every pending delivery at once.
        self._reload = True
        self._task: Optional[asyncio.Task] = None

    async def handle_ack(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(ack, params)

    async def tick(self) -> dict:
        if not enabled():
            return {"skipped": "disabled"}
        now = int(self._clock())
        out: Dict[str, Any] = {}
        if self._reload:
            out["reloaded"] = await asyncio.to_thread(reload)
            self._reload = False
        authority = await asyncio.to_thread(check_authority, self._authority, now=now)
        if authority["changed"]:
            logger.info("[ocuclaw] board moments: new relay pairing, %d delivery(ies) reopened",
                        authority["reopened"])
            out["authority"] = authority
        scopes = await asyncio.to_thread(catch_up, None, now=now)
        moments = await asyncio.to_thread(due, now=now)
        if moments:
            _at("push.sending")
            try:
                result = await self._request(PUSH_METHOD, {"moments": moments})
            except Exception as exc:  # noqa: BLE001 - stays pending; pushed again later
                logger.debug("[ocuclaw] board moment push failed: %s", exc)
            else:
                _at("push.sent")
                if isinstance(result, dict) and result.get("sent") == 0:
                    # No phone was connected: nobody saw it, so it is due again next tick.
                    out["released"] = await asyncio.to_thread(release, [m["deliveryId"] for m in moments])
        return {"scopes": scopes, "pushed": len(moments), **out}

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - Board never takes the gateway down
                logger.exception("[ocuclaw] board moment tick failed")

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
