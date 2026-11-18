"""Board uncertainty: read exact stock owner receipts; acknowledge on their live owner loop.

An acknowledgement never retries or reclaims a Board run. The private target binds
the selected profile store, Board run/claim and the complete owner marker. Only its
opaque digest reaches the phone. Old engines and unserved owners stay read-only.
"""
from __future__ import annotations

import asyncio
from contextlib import closing
from concurrent.futures import TimeoutError as FutureTimeout
import hmac
from pathlib import Path
import re
import sqlite3

from . import board_management as bm, board_ops

OPERATION = "board.acknowledge"
TOKEN = re.compile(r"^[0-9a-f]{64}$")
_IN_FLIGHT = {}


def binding(conn, card_id, home):
    """Read a current running card's exact owner admission from its trusted profile DB."""
    if home is None:
        return None
    try:
        owner_db = (Path(home).resolve() / "state.db").resolve()
        task = conn.execute("SELECT current_run_id, claim_lock FROM tasks WHERE id=? AND status='running'",
                            [card_id]).fetchone()
        if task is None or not task[0] or not task[1]:
            return None
        from .board_tail import EVENT_COLS, event_hash
        marker = conn.execute(f"SELECT {', '.join(EVENT_COLS)} FROM task_events WHERE task_id=?"
                              " AND run_id=? AND kind='owner_admitted' ORDER BY id DESC LIMIT 1",
                              [card_id, task[0]]).fetchone()
        if marker is None:
            return None
        fields = bm._payload(marker["payload"])
        if Path(fields["db"]).resolve() != owner_db:
            return None
        session, request = fields["session_id"], fields["request_id"]
        if not isinstance(session, str) or not session or not isinstance(request, str) or not request:
            return None
        with closing(sqlite3.connect(owner_db.as_uri() + "?mode=ro", uri=True, timeout=0.25)) as owner:
            rows = owner.execute("SELECT admission_id, generation, status, outcome FROM session_admissions"
                                 " WHERE target_session_id=? AND request_id=?", [session, request]).fetchall()
            if len(rows) != 1:
                return None
            admission, generation, status, outcome = rows[0]
        if not isinstance(admission, str) or type(generation) is not int or generation < 1:
            return None
        return {"home": str(Path(home).resolve()), "store": bm._file_identity(owner_db),
                "card": card_id, "run": int(task[0]), "claim": str(task[1]),
                "event": int(marker["id"]), "eventHash": event_hash(marker),
                "session": session, "request": request, "admission": admission,
                "generation": generation, "status": status, "outcome": outcome}
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
        return None


def token(target, anchor):
    return board_ops.digest({"anchor": anchor, **{k: v for k, v in target.items() if k not in {"status", "outcome"}}})


def readable_homes(rpc, selected_home):
    """Only boot-frozen enrolled routes may supply shared Board owner receipts."""
    homes = [] if selected_home is None else [Path(selected_home).resolve()]
    if rpc is not None:
        try:
            enabled, routes = rpc._routing_snapshot()
            if enabled:
                homes.extend(Path(home).resolve() for home in routes.values())
        except (AttributeError, OSError, TypeError, ValueError):
            pass
    return tuple(dict.fromkeys(homes))


def unknown_cards(conn, homes):
    """One classifier shared by Needs you counts, paging and row labels."""
    if homes is None:
        return {}
    if isinstance(homes, (str, Path)):
        homes = (homes,)
    conn.row_factory = sqlite3.Row
    out = {}
    for row in conn.execute("SELECT id FROM tasks WHERE status='running'").fetchall():
        for home in homes:
            found = binding(conn, row[0], home)
            if found and found["status"] == "unknown":
                out[row[0]] = found
                break
    return out


def owner(rpc, home):
    adapter = getattr(rpc, "_management_adapter", None)
    loop = getattr(adapter, "_loop", None)
    runner = getattr(adapter, "gateway_runner", None)
    if home is None or runner is None or loop is None or loop.is_closed() or not loop.is_running():
        return None
    try:
        from gateway.session_authorities import authority_for_home, require_serving
        authority = authority_for_home(runner, home)
        if authority is None or Path(authority.db.db_path).resolve() != Path(home).resolve() / "state.db":
            return None
        require_serving(authority)
        return authority, loop
    except (ImportError, AttributeError, OSError, RuntimeError):
        return None


def _current(root, slug, card_id, home, anchor):
    db, _ = bm.board_paths(root, slug)
    def read(conn):
        conn.row_factory = sqlite3.Row
        if bm.board_anchor(root, bm._file_identity(db)) != anchor:
            raise bm.BoardReadError("stale_target")
        return binding(conn, card_id, home)
    return bm._read(db, read)


def wire(receipt):
    out = {"key": receipt["key"], "operation": "acknowledge", "state": receipt["state"]}
    if receipt["state"] == "succeeded":
        out["card"] = receipt["result"]["card"]
        out["resolution"] = receipt["result"]["resolution"]
    if receipt["state"] == "refused":
        out["code"] = receipt.get("code") or "stale_target"
    return {"receipt": out}


def _finish(key, state, code=None, resolution=None):
    result = None
    if state == "succeeded":
        receipt = board_ops.get(key)
        db, _ = bm.board_paths(Path(receipt["result"]["root"]), receipt["board"])
        card_id = receipt["result"]["target"]["card"]
        try:
            row = bm._read(db, lambda conn: conn.execute("SELECT status FROM tasks WHERE id=?", [card_id]).fetchone())
            card_state = row[0] if row and isinstance(row[0], str) and bm._STATUS.fullmatch(row[0]) else "unknown"
        except bm.BoardReadError:
            card_state = "unknown"
        result = {**receipt["result"], "card": {"id": card_id, "state": card_state}, "resolution": resolution}
    return board_ops.finish(key, state, code=code, result=result)


async def _resolve(authority, root, slug, anchor, key, target):
    try:
        from gateway.session_contract import SessionRef
        try:
            # Hermes 0.23.0 renamed Principal to SessionActor (upstream 9ad4a599, no alias).
            from gateway.session_contract import SessionActor as actor_type
        except ImportError:
            from gateway.session_contract import Principal as actor_type
        actor = actor_type("ocuclaw:phone", authority.profile_id,
                          frozenset({"session:submit", "session:control", "session:operator"}), "ocuclaw-management")
        ref = SessionRef(authority.profile_id, target["session"])
        authority.authorize(actor, ref, "session:control")
        current = await asyncio.to_thread(_current, root, slug, target["card"], target["home"], anchor)
        if current is None or token(current, anchor) != token(target, anchor) or current["status"] != "unknown":
            await asyncio.to_thread(_finish, key, "refused", "stale_target")
            return
        resolved = await authority.resolve_unknown(actor, ref, target["admission"], target["generation"])
        await asyncio.to_thread(_finish, key, "succeeded", None, resolved.outcome)
    except bm.BoardReadError as exc:
        await asyncio.to_thread(_finish, key, "refused", exc.code)
    except Exception:
        # A native write may have committed before its observer failed. Never send again.
        await asyncio.to_thread(_finish, key, "outcome_unknown")


def acknowledge(root, payload, profile, rpc, home):
    from .board_create import _gateway
    if not isinstance(payload, dict) or set(payload) != {"slug", "id", "anchor", "key", "unknownTarget"}:
        raise bm.BoardReadError("invalid_request")
    slug, card_id, anchor, key, viewed = (payload[k] for k in ("slug", "id", "anchor", "key", "unknownTarget"))
    checks = ((slug, bm._SLUG), (card_id, bm._CARD_ID), (anchor, bm._ANCHOR), (key, board_ops.KEY), (viewed, TOKEN))
    if any(not isinstance(value, str) or not pattern.fullmatch(value) for value, pattern in checks):
        raise bm.BoardReadError("invalid_request")
    issued = False
    try:
        receipt = board_ops.begin(key, gateway=_gateway(), profile=profile, operation=OPERATION,
                                  board=slug, anchor=anchor, intent_digest=board_ops.digest(payload), native_key="",
                                  pending={"viewed": viewed})
        if not receipt.get("fresh"):
            return looked_up(root, receipt)
        try:
            found = _current(root, slug, card_id, home, anchor)
        except bm.BoardReadError as exc:
            return wire(_finish(key, "refused", exc.code))
        if found is None or found["status"] != "unknown" or not hmac.compare_digest(token(found, anchor), viewed):
            return wire(_finish(key, "refused", "stale_target"))
        owned = owner(rpc, home)
        if owned is None:
            return wire(_finish(key, "refused", "temporarily_unavailable"))
        if not board_ops.note(key, {"target": found, "root": str(root)}, writer=board_ops.current_writer()):
            return wire(board_ops.get(key))
        authority, loop = owned
        coroutine = _resolve(authority, root, slug, anchor, key, found)
        try:
            future = asyncio.run_coroutine_threadsafe(coroutine, loop)
        except RuntimeError:
            coroutine.close()
            return wire(_finish(key, "refused", "temporarily_unavailable"))
        _IN_FLIGHT[key] = future
        issued = True
        def completed(done):
            if not done.cancelled() and done.exception() is None:
                _IN_FLIGHT.pop(key, None)
        future.add_done_callback(completed)
        try:
            future.result(timeout=20)
        except FutureTimeout:
            pass  # The owner coroutine still finishes the durable receipt after a phone timeout.
        return wire(board_ops.get(key))
    except board_ops.OpRefused as exc:
        raise bm.BoardReadError(exc.code) from None
    except board_ops.OpStoreError:
        raise bm.BoardReadError("outcome_unknown" if issued else "temporarily_unavailable") from None


def looked_up(root, receipt):
    local = _IN_FLIGHT.get(receipt["key"])
    if receipt["state"] == "pending" and (receipt.get("taken_over") or not board_ops.writer_live(receipt)
                                         or (local is not None and local.done())):
        target = (receipt.get("result") or {}).get("target")
        if target:
            try:
                # Exact admission readback only. A newer Board run cannot answer this old receipt.
                db = Path(target["home"]) / "state.db"
                if bm._file_identity(db) != target["store"]:
                    raise ValueError("store changed")
                with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=0.25)) as conn:
                    row = conn.execute("SELECT generation,status,outcome FROM session_admissions WHERE admission_id=?"
                                       " AND target_session_id=? AND request_id=?",
                                       [target["admission"], target["session"], target["request"]]).fetchone()
                succeeded = row and row[0] == target["generation"] and row[1] == "terminal" and row[2] in {"interrupted", "completed", "failed"}
                receipt = _finish(receipt["key"], "succeeded" if succeeded else "outcome_unknown", resolution=row[2] if succeeded else None)
            except (OSError, ValueError, KeyError, sqlite3.Error):
                receipt = _finish(receipt["key"], "outcome_unknown")
        else:
            receipt = _finish(receipt["key"], "refused", "expired_request")
        _IN_FLIGHT.pop(receipt["key"], None)
    return wire(receipt)
