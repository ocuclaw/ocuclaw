"""Sessions-plane control-link RPC handlers (W05): SessionDB glue.

The Node bridge (``hermes-gateway-bridge.ts``) translates the OcuClaw bridge
vocabulary into the ``db.*`` link lane this module serves. Division of labor
(PROTOCOL.md "Bridge db lane"):

- **Node owns the public-key grammar.** This module never sees a ``hermes:``
  key — the bridge sends a parsed IDENTITY object (``{ns, chatId}`` minted /
  ``{ns, remainder}`` foreign-or-external) and this module resolves it to a
  live transcript id via native session_key reconstruction +
  compression-tip walking (``resolve_resume_session_id``).
- **Reads ride a read-only SessionDB** — the documented WAL external-reader
  (``mode=ro`` takes no write lock; hermes_state.py:902-919 + the
  session_search_tool precedent). The two writes this plane owns (title
  patch, lineage delete) ride a lazily-created writable ``SessionDB`` — the
  same per-instance-connection pattern every in-tree hermes consumer uses.
- ``last_active``/timestamps stay **unix seconds** on the wire; the Node
  bridge owns the seconds→ms conversion (the contract map's ×1000 trap).

All hermes imports are deferred so the module stays importable outside a
hermes environment (framing/unit tests); DB calls run in a worker thread
(``asyncio.to_thread``) so link handlers never block the gateway loop.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# ADR-0004 deny trio: the non-conversational sources excluded from the
# glasses session list (messaging viewports stay visible by design).
DENY_SOURCES: Tuple[str, ...] = ("tool", "cron", "subagent")

# Hermes's default-lane session-key namespace is the literal ``agent:main``
# whenever SessionSource.profile is unset (session.py:766-780). Mirrors
# DEFAULT_HERMES_NAMESPACE in hermes-session-keys.ts.
DEFAULT_SESSION_NAMESPACE = "main"

# Native segments for ocuclaw-minted sessions (mirror of the Node constants;
# the W06 dispatch lane pins the DM SessionSource shape).
OCUCLAW_PLATFORM_SEGMENT = "ocuclaw"
OCUCLAW_CHAT_TYPE_SEGMENT = "dm"

LIST_LIMIT_DEFAULT = 100
LIST_LIMIT_MAX = 500
# Search scans a much wider candidate window than the caller's result limit —
# limiting BEFORE the substring filter would silently hide matches older than
# the first page (Codex review W05 finding). Bounded, not unbounded: hermes
# session counts are modest and rows are cheap.
SEARCH_SCAN_LIMIT = 5000
DB_METHOD_SESSIONS_LIST = "db.sessions.list"
DB_METHOD_RESOLVE_KEY = "db.sessions.resolveKey"
DB_METHOD_SET_TITLE = "db.sessions.setTitle"
DB_METHOD_DELETE = "db.sessions.delete"
DB_METHOD_CHAT_HISTORY = "db.chat.history"
DB_METHOD_DESCRIBE = "db.sessions.describe"
DB_METHOD_COMPACTION_INFO = "db.sessions.compactionInfo"


def default_state_db_path() -> Path:
    """``$HERMES_HOME/state.db`` via hermes's own resolver (never a literal
    ``~/.hermes`` — profiles are isolated homes)."""
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "state.db"


class SessionRpc:
    """Link RPC handlers over one hermes ``state.db``."""

    def __init__(
        self,
        db_path: Path,
        namespace: str = DEFAULT_SESSION_NAMESPACE,
    ) -> None:
        self._db_path = Path(db_path)
        self._ns = namespace or DEFAULT_SESSION_NAMESPACE
        self._reader: Any = None
        self._writer: Any = None

    # -- registration ------------------------------------------------------

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        """method → async handler, for LinkProcess.register_request_handler."""
        return {
            DB_METHOD_SESSIONS_LIST: self.list_sessions,
            DB_METHOD_RESOLVE_KEY: self.resolve_key,
            DB_METHOD_SET_TITLE: self.set_title,
            DB_METHOD_DELETE: self.delete_session,
            DB_METHOD_CHAT_HISTORY: self.chat_history,
            DB_METHOD_DESCRIBE: self.describe_session,
            DB_METHOD_COMPACTION_INFO: self.compaction_info,
        }

    # -- async handler wrappers (DB work off the event loop) ----------------

    async def list_sessions(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_list, params)

    async def resolve_key(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_resolve_key, params)

    async def set_title(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_set_title, params)

    async def delete_session(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_delete, params)

    async def chat_history(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_history, params)

    async def describe_session(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_describe, params)

    async def compaction_info(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_compaction_info, params)

    # -- DB access ----------------------------------------------------------

    def _get_reader(self):
        # Cross-thread reuse is SAFE by hermes's own design: SessionDB opens
        # its connection with check_same_thread=False and serializes every
        # operation behind its internal threading.Lock (hermes_state.py:895+,
        # :914/:926), and CPython ships sqlite3.threadsafety == 3
        # (serialized). The db.* RPC lane (asyncio.to_thread pool threads)
        # and the on_session_end hook (agent worker thread) both ride this
        # one cached reader deliberately.
        if self._reader is None:
            if not self._db_path.exists():
                raise RuntimeError(f"hermes state DB not found at {self._db_path}")
            from hermes_state import SessionDB

            self._reader = SessionDB(db_path=self._db_path, read_only=True)
        return self._reader

    def _get_writer(self):
        if self._writer is None:
            from hermes_state import SessionDB

            self._writer = SessionDB(db_path=self._db_path)
        return self._writer

    def _session_keys_by_id(self, session_ids: List[str]) -> Dict[str, str]:
        ids = [sid for sid in session_ids if isinstance(sid, str) and sid]
        if not ids:
            return {}
        placeholders = ",".join("?" for _ in ids)
        with sqlite3.connect(self._db_path, timeout=10) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT id, session_key FROM sessions WHERE id IN ({placeholders})",
                ids,
            ).fetchall()
        return {
            str(row["id"]): str(row["session_key"])
            for row in rows
            if row["session_key"]
        }

    def _purge_delivery_obligations_for_deleted_keys(
        self, session_keys: List[str]
    ) -> int:
        keys = sorted({key for key in session_keys if isinstance(key, str) and key})
        if not keys:
            return 0
        with sqlite3.connect(self._db_path, timeout=10) as conn:
            table = conn.execute(
                """SELECT 1 FROM sqlite_master
                   WHERE type='table' AND name='delivery_obligations'"""
            ).fetchone()
            if table is None:
                return 0
            deleted = 0
            for key in keys:
                cursor = conn.execute(
                    """DELETE FROM delivery_obligations
                       WHERE session_key = ?
                         AND NOT EXISTS (
                           SELECT 1 FROM sessions WHERE session_key = ?
                         )""",
                    (key, key),
                )
                deleted += max(cursor.rowcount, 0)
            return deleted

    # -- W06 dispatch-plane sync lookups (called from the on_session_end hook
    # thread — plain fast sqlite reads, never the event loop) ----------------

    def row_by_id(self, session_id: str) -> Optional[Dict[str, Any]]:
        """id → {id, session_key, source} (on_session_end carries session_id,
        NOT session_key — the indexed native key column is the bridge back)."""
        row = self._get_reader().get_session(str(session_id))
        return dict(row) if row else None

    def newest_carrier_id(self, session_key: str) -> Optional[str]:
        """Newest row id carrying a session_key (started_at DESC — hermes's
        own recovery order). A /new reset mints a FRESH row on the same
        deterministic key, so an on_session_end whose session_id is NOT the
        newest carrier belongs to a pre-reset (cancelled) turn — the
        stale-end guard the dispatch glue applies under a cancel fence."""
        row = self._lookup_session_key(str(session_key))
        return str(row["id"]) if row else None

    def conversation_by_id(
        self, session_id: str, limit: int = 0
    ) -> List[Dict[str, Any]]:
        """Conversational rows for a transcript id (same shaping as
        chat.history: user/assistant with content, server-side tail slice) —
        the agent_end hook payload + history push source (on_session_end
        itself carries no messages)."""
        rows = self._get_reader().get_messages_as_conversation(
            str(session_id), include_ancestors=True
        )
        messages = [
            {"role": row.get("role"), "content": row.get("content")}
            for row in rows
            if row.get("role") in ("user", "assistant") and row.get("content")
        ]
        if limit > 0 and len(messages) > limit:
            messages = messages[-limit:]
        return messages

    # -- identity resolution -------------------------------------------------

    def _lookup_session_key(self, session_key: str) -> Optional[Dict[str, Any]]:
        # session_key is NOT unique (regular index): reset/re-created chats
        # reuse the same deterministic key on a FRESH row that is not a
        # compression child of the old one. Newest-first matches hermes's own
        # recovery lookups — the oldest row would route history/title/delete
        # to a dead transcript (Codex review W05 finding). The tip walk then
        # resolves compression forks from whichever row we picked.
        lister = getattr(self._get_reader(), "list_gateway_sessions", None)
        if callable(lister):
            rows = lister(active_only=False)
            for row in rows:
                if row.get("session_key") == session_key:
                    return dict(row)
            return None
        rows = self._get_reader().list_sessions_rich(
            limit=SEARCH_SCAN_LIMIT,
            include_children=True,
            include_archived=True,
            order_by_last_active=True,
            project_compression_tips=False,
        )
        for row in rows:
            if row.get("session_key") == session_key:
                return dict(row)
        return None

    def _lookup_minted_chat_id(self, ns: str, chat_id: str) -> Optional[Dict[str, Any]]:
        # Exact DM-shaped native key ONLY — the Node grammar derives every
        # other ocuclaw arity as a FOREIGN key (hermes:<ns>:x:<remainder>),
        # so a broader match here would alias two public keys onto one row
        # and break parse/derive symmetry (Codex review W05 finding).
        return self._lookup_session_key(
            f"agent:{ns}:{OCUCLAW_PLATFORM_SEGMENT}:{OCUCLAW_CHAT_TYPE_SEGMENT}:{chat_id}"
        )

    def _resolve_target(self, identity: Any, *, fail_closed: bool = False) -> str:
        """identity → live transcript (compression-tip) session id."""
        ident = identity if isinstance(identity, dict) else {}
        ns = str(ident.get("ns") or self._ns)
        chat_id = ident.get("chatId")
        remainder = ident.get("remainder")
        db = self._get_reader()
        if isinstance(chat_id, str) and chat_id:
            native_key = (
                f"agent:{ns}:{OCUCLAW_PLATFORM_SEGMENT}:"
                f"{OCUCLAW_CHAT_TYPE_SEGMENT}:{chat_id}"
            )
            row = self._lookup_minted_chat_id(ns, chat_id)
            if row is None:
                raise ValueError(f"no such session: hermes:{ns}:{chat_id}")
            return db.resolve_resume_session_id(row["id"])
        if isinstance(remainder, str) and remainder:
            # Foreign gateway row: reconstruct the native session_key.
            row = self._lookup_session_key(f"agent:{ns}:{remainder}")
            if row is not None:
                return db.resolve_resume_session_id(row["id"])
            # External-root form: <source>:<lineageRootId> (CLI/TUI/api rows
            # carry no platform-shaped session_key — ADR-0004). Derivation
            # ONLY mints these under the default-lane namespace, so any other
            # ns must not fall through here — else a fabricated
            # hermes:<other>:x:<source>:<id> key could mutate/delete a
            # default-lane row across the namespace boundary (Codex review
            # W05 finding).
            if ns == DEFAULT_SESSION_NAMESPACE:
                parts = remainder.split(":", 1)
                if len(parts) == 2:
                    source, root_id = parts
                    root = db.get_session(root_id)
                    if root is not None and root.get("source") == source:
                        return db.resolve_resume_session_id(root_id)
            raise ValueError(f"no such session: hermes:{ns}:x:{remainder}")
        raise ValueError("invalid session identity")

    def resolve_identity_row(self, identity: Any) -> Dict[str, Any]:
        """identity → live rich-ish row dict. W08 action handlers use this
        per request so compressed sessions and reset carriers never cache a
        stale transcript id."""
        tip = self._resolve_target(identity)
        row = self._get_reader().get_session(tip)
        if row is None:
            raise ValueError(f"no such session: {tip}")
        return dict(row)

    def _walk_compression_chain(self, session_id: str) -> List[str]:
        """tip → root ids joined by compression edges (parent carries
        ``end_reason='compression'`` — the canonical up-walk predicate)."""
        lineage = getattr(self._get_reader(), "get_compression_lineage", None)
        if callable(lineage):
            ids = lineage(session_id)
            if ids:
                return list(reversed([str(value) for value in ids]))
        return [session_id]

    def _lineage_root_id(self, row: Dict[str, Any]) -> str:
        projected = row.get("_lineage_root_id")
        if projected:
            return str(projected)
        return str(self._walk_compression_chain(str(row.get("id")))[-1])

    # -- wire shaping --------------------------------------------------------

    def _row_to_wire(self, row: Dict[str, Any]) -> Dict[str, Any]:
        wire = {
            "id": row.get("id"),
            "sessionKey": row.get("session_key"),
            "source": row.get("source"),
            "lineageRootId": self._lineage_root_id(row),
            # REAL unix seconds — the Node bridge owns the ×1000 conversion.
            "lastActive": row.get("last_active"),
            "title": row.get("title"),
            "preview": row.get("preview"),
            "messageCount": row.get("message_count"),
        }
        return wire

    def _list_row_visible(self, row: Dict[str, Any]) -> bool:
        return row.get("end_reason") != "compression"

    @staticmethod
    def _dedupe_by_session_key(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Keep the first visible row for each non-empty session_key.

        A /new reset can end a row with ``session_reset`` and mint a fresh row
        on the same deterministic key. ``order_by_last_active=True`` is
        newest-first, matching hermes recovery order in ``_lookup_session_key``,
        so keep-first prevents stale reset carriers from shadowing the live row.
        NULL/empty keys stay distinct because downstream identifies them by id.
        """
        seen = set()
        deduped = []
        for row in rows:
            session_key = row.get("session_key")
            if not session_key:
                deduped.append(row)
                continue
            if session_key in seen:
                continue
            seen.add(session_key)
            deduped.append(row)
        return deduped

    # -- sync handler bodies -------------------------------------------------

    def _sync_list(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        try:
            limit = int(p.get("limit"))
        except (TypeError, ValueError):
            limit = LIST_LIMIT_DEFAULT
        limit = max(1, min(limit, LIST_LIMIT_MAX))
        search = str(p.get("search") or "").strip().lower()
        key_identity = p.get("keyIdentity")
        if isinstance(key_identity, dict):
            # Exact-key hydration (session-service fetchCurrentSessionRow
            # searches by the session key itself): resolve via the INDEXED
            # identity lookups — never a bounded recency scan, which would
            # make old-but-valid sessions vanish from key lookups (Codex
            # review W05 finding) — then fetch the rich row by exact id.
            try:
                tip = self._resolve_target(key_identity)
            except ValueError:
                return {"sessions": []}
            # id_query is only honored on the order_by_last_active path
            # (hermes_state.py:2790-2793 — other callers pass None).
            rows = self._get_reader().list_sessions_rich(
                exclude_sources=list(DENY_SOURCES),
                id_query=tip,
                limit=2,
                include_children=True,
                order_by_last_active=True,
                project_compression_tips=True,
            )
            wire = [
                self._row_to_wire(row)
                for row in rows
                if row.get("id") == tip and self._list_row_visible(row)
            ]
            return {"sessions": wire[:limit]}
        # The caller's limit bounds RESULTS; a text search must scan a wide
        # candidate window first, else matches older than the first page
        # vanish (limit-before-filter).
        rows = self._get_reader().list_sessions_rich(
            exclude_sources=list(DENY_SOURCES),
            limit=SEARCH_SCAN_LIMIT if search else limit,
            include_children=True,
            order_by_last_active=True,
            project_compression_tips=True,
        )
        rows = [row for row in rows if self._list_row_visible(row)]
        rows = self._dedupe_by_session_key(rows)
        wire = [self._row_to_wire(row) for row in rows]
        if search:
            # Title/preview substring (the map's sanctioned inside-mode search
            # shape; FTS session search is a future refinement).
            wire = [
                w
                for w in wire
                if search in (w.get("title") or "").lower()
                or search in (w.get("preview") or "").lower()
            ][:limit]
        # Dedupe can shrink a no-search page below limit; accepted for now.
        return {"sessions": wire}

    def _sync_resolve_key(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        key = str(p.get("key") or "").strip()
        if not key:
            raise ValueError("resolveKey requires a key")
        # A non-prefixed key can only be a raw hermes session id; the Node
        # bridge derives the public key from the returned row.
        row = self._get_reader().get_session(key)
        if row is None:
            raise ValueError(f"no such session: {key}")
        row = dict(row)
        row["last_active"] = row.get("last_active") or row.get("started_at")
        return {"row": self._row_to_wire(row)}

    def _sync_set_title(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        tip = self._resolve_target(p.get("identity"), fail_closed=True)
        title = p.get("title")
        if title is not None and not isinstance(title, str):
            raise ValueError("title must be a string or null")
        # Empty/None clears (sanitize_title maps both to NULL). ValueError on
        # UNIQUE collision propagates to the link error surface — the caller's
        # title patch is fire-and-forget and logs it.
        self._get_writer().set_session_title(tip, title if title else None)
        return {"ok": True}

    def _sync_delete(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        identity = p.get("identity")
        ident = identity if isinstance(identity, dict) else {}
        chat_id = ident.get("chatId")
        if not isinstance(chat_id, str) or not chat_id:
            raise ValueError("refusing to delete non-minted (foreign) session")
        tip = self._resolve_target(identity, fail_closed=True)
        # Delete the WHOLE compression lineage tip→root: delete_session
        # orphans compression children (parent NULLed, hermes_state.py:
        # 4732-4736), so deleting only the tip would resurface ancestors as
        # roots in the next list (map sessions.delete verdict). Child-first
        # order avoids observing half-orphaned intermediates.
        chain = self._walk_compression_chain(tip)
        keys_by_id = self._session_keys_by_id(chain)
        writer = self._get_writer()
        deleted = [sid for sid in chain if writer.delete_session(sid)]
        self._purge_delivery_obligations_for_deleted_keys(
            [keys_by_id[sid] for sid in deleted if sid in keys_by_id]
        )
        return {"deleted": deleted}

    def _sync_history(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        tip = self._resolve_target(p.get("identity"), fail_closed=True)
        rows = self._get_reader().get_messages_as_conversation(
            tip, include_ancestors=True
        )
        # Conversational shaping happens HERE, before serialization: only
        # user/assistant rows with content survive, and the tail slice
        # applies server-side so a long transcript never has to fit the
        # 1 MiB link frame cap when the caller asked for a bounded page
        # (Codex review W05 finding). Content stays scalar-or-block-list;
        # the Node bridge re-shapes defensively over the same pinned shape.
        messages = [
            {"role": row.get("role"), "content": row.get("content")}
            for row in rows
            if row.get("role") in ("user", "assistant") and row.get("content")
        ]
        try:
            limit = int(p.get("limit"))
        except (TypeError, ValueError):
            limit = 0
        if limit > 0 and len(messages) > limit:
            messages = messages[-limit:]
        return {"messages": messages, "sessionId": tip}

    def _sync_describe(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        tip = self._resolve_target(p.get("identity"), fail_closed=True)
        row = self._get_reader().get_session(tip)
        if row is None:
            raise ValueError(f"no such session: {tip}")
        return {
            "model": row.get("model"),
            "tokens": {
                "input": row.get("input_tokens") or 0,
                "output": row.get("output_tokens") or 0,
                "cacheRead": row.get("cache_read_tokens") or 0,
                "cacheWrite": row.get("cache_write_tokens") or 0,
                "reasoning": row.get("reasoning_tokens") or 0,
            },
            "messageCount": row.get("message_count") or 0,
        }

    def _sync_compaction_info(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        tip = self._resolve_target(p.get("identity"), fail_closed=True)
        # Compaction count = compression-chain hops (map compaction.list row;
        # in-place archive_and_compact events are invisible to a hop count —
        # documented undercount, synthesized/medium).
        hops = len(self._walk_compression_chain(tip)) - 1
        return {"hops": hops}

    def copy_to_ocuclaw(
        self,
        identity: Any,
        *,
        chat_id: str,
        target_public_key: str = "",
    ) -> Dict[str, Any]:
        """Copy a foreign/external transcript into a fresh OcuClaw-keyed
        session. This deliberately does NOT call hermes `/fork`, because that
        marks the source ended as `branched`; instead it writes a public child
        row and appends the transcript through Hermes' writer API."""
        target_chat_id = str(chat_id or "").strip()
        if not target_chat_id:
            raise ValueError("copy target requires chatId")
        source_tip = self._resolve_target(identity, fail_closed=True)
        messages = self.conversation_by_id(source_tip)
        if not messages:
            raise ValueError("copy source has no conversational messages")
        session_id = f"ocuclaw_copy_{uuid.uuid4().hex}"
        copy_chat_id = f"copy-{uuid.uuid4().hex}"
        copy_key = f"agent:{self._ns}:{OCUCLAW_PLATFORM_SEGMENT}:{OCUCLAW_CHAT_TYPE_SEGMENT}:{copy_chat_id}"
        writer = self._get_writer()
        writer.create_session(
            session_id,
            OCUCLAW_PLATFORM_SEGMENT,
            session_key=copy_key,
            chat_id=copy_chat_id,
            chat_type=OCUCLAW_CHAT_TYPE_SEGMENT,
            parent_session_id=source_tip,
        )
        for message in messages:
            writer.append_message(
                session_id=session_id,
                role=str(message.get("role") or "unknown"),
                content=message.get("content"),
            )
        row = writer.get_session(session_id)
        if row is None:
            raise RuntimeError(f"copied session missing after create: {session_id}")
        row_dict = dict(row)
        return self._row_to_wire(row_dict)


class ProfileSessionRpc:
    """Route the db.* lane across profile-isolated Hermes state DBs."""

    def __init__(
        self,
        default_db_path: Path,
        routing_provider: Callable[[], Tuple[bool, Dict[str, Path]]],
    ) -> None:
        self._default_db_path = Path(default_db_path)
        self._routing_provider = routing_provider
        self._lock = threading.RLock()
        self._rpcs: Dict[str, SessionRpc] = {
            DEFAULT_SESSION_NAMESPACE: SessionRpc(
                self._default_db_path,
                namespace=DEFAULT_SESSION_NAMESPACE,
            )
        }

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        return {
            DB_METHOD_SESSIONS_LIST: self.list_sessions,
            DB_METHOD_RESOLVE_KEY: self.resolve_key,
            DB_METHOD_SET_TITLE: self.set_title,
            DB_METHOD_DELETE: self.delete_session,
            DB_METHOD_CHAT_HISTORY: self.chat_history,
            DB_METHOD_DESCRIBE: self.describe_session,
            DB_METHOD_COMPACTION_INFO: self.compaction_info,
        }

    def _routing(self) -> Tuple[bool, Dict[str, Path]]:
        enabled, homes = self._routing_provider()
        normalized = {
            str(ns or DEFAULT_SESSION_NAMESPACE): Path(home)
            for ns, home in homes.items()
        }
        normalized.setdefault(
            DEFAULT_SESSION_NAMESPACE,
            self._default_db_path.parent,
        )
        return bool(enabled), normalized

    @staticmethod
    def _namespace_from_params(params: Any) -> str:
        p = params if isinstance(params, dict) else {}
        for candidate in (p.get("identity"), p.get("keyIdentity")):
            if isinstance(candidate, dict):
                return str(candidate.get("ns") or DEFAULT_SESSION_NAMESPACE)
        return str(p.get("ns") or DEFAULT_SESSION_NAMESPACE)

    @staticmethod
    def _has_namespace_context(params: Any) -> bool:
        p = params if isinstance(params, dict) else {}
        return (
            "ns" in p
            or isinstance(p.get("identity"), dict)
            or isinstance(p.get("keyIdentity"), dict)
        )

    def _rpc_for_namespace(self, ns: str) -> SessionRpc:
        namespace = str(ns or DEFAULT_SESSION_NAMESPACE)
        if namespace == DEFAULT_SESSION_NAMESPACE:
            return self._rpcs[DEFAULT_SESSION_NAMESPACE]
        enabled, homes = self._routing()
        if not enabled or namespace not in homes:
            raise RuntimeError(
                f"Hermes profile namespace {namespace!r} is not served"
            )
        with self._lock:
            rpc = self._rpcs.get(namespace)
            db_path = homes[namespace] / "state.db"
            if rpc is None or rpc._db_path != db_path:
                rpc = SessionRpc(db_path, namespace=namespace)
                self._rpcs[namespace] = rpc
            return rpc

    def _ambient_rpc(self) -> SessionRpc:
        # VERIFIED Hermes 0.19 anchors: gateway/run.py:18733 enters
        # _profile_runtime_scope for the whole turn; :16396 carries that
        # ContextVar through copy_context into the agent worker; and
        # agent/turn_finalizer.py:610-626 fires on_session_end there. Resolve
        # get_hermes_home() NOW, not at adapter construction, so hook lookups
        # follow the profile whose run_conversation is finalizing.
        db_path = default_state_db_path()
        if db_path == self._default_db_path:
            return self._rpcs[DEFAULT_SESSION_NAMESPACE]
        _enabled, homes = self._routing()
        namespace = next(
            (
                ns
                for ns, home in homes.items()
                if Path(home) / "state.db" == db_path
            ),
            None,
        )
        if namespace is None:
            raise RuntimeError(
                f"ambient Hermes profile DB is not served: {db_path}"
            )
        return self._rpc_for_namespace(namespace)

    async def list_sessions(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_list_sessions, params)

    def _sync_list_sessions(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        enabled, homes = self._routing()
        if not enabled:
            # Hard regression fence: do not even inspect profile homes in the
            # legacy mode; this is exactly the old one-DB result.
            return self._rpcs[DEFAULT_SESSION_NAMESPACE]._sync_list(p)

        key_identity = p.get("keyIdentity")
        if isinstance(key_identity, dict):
            try:
                rpc = self._rpc_for_namespace(self._namespace_from_params(p))
                return rpc._sync_list(p)
            except Exception:  # noqa: BLE001
                return {"sessions": []}

        try:
            limit = int(p.get("limit"))
        except (TypeError, ValueError):
            limit = LIST_LIMIT_DEFAULT
        limit = max(1, min(limit, LIST_LIMIT_MAX))
        fanout_params = dict(p)
        fanout_params["limit"] = limit
        rows: List[Dict[str, Any]] = []
        for ns in homes:
            try:
                rows.extend(
                    self._rpc_for_namespace(ns)._sync_list(fanout_params)["sessions"]
                )
            except Exception:  # noqa: BLE001
                # One uninitialised/corrupt profile DB must not blank healthy
                # profiles from the all-profile session list.
                continue
        rows.sort(
            key=lambda row: float(row.get("lastActive") or 0),
            reverse=True,
        )
        return {"sessions": rows[:limit]}

    async def _route(self, method: str, params: Any) -> Dict[str, Any]:
        rpc = self._rpc_for_namespace(self._namespace_from_params(params))
        return await getattr(rpc, method)(params)

    async def resolve_key(self, params: Any) -> Dict[str, Any]:
        if self._has_namespace_context(params):
            return await self._route("resolve_key", params)
        return await asyncio.to_thread(self._sync_resolve_key, params)

    def _sync_resolve_key(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        key = str(p.get("key") or "").strip()
        if not key:
            raise ValueError("resolveKey requires a key")
        enabled, homes = self._routing()
        if enabled:
            namespaces = homes
        else:
            namespaces = {
                DEFAULT_SESSION_NAMESPACE: homes.get(
                    DEFAULT_SESSION_NAMESPACE,
                    self._default_db_path.parent,
                )
            }
        matches = []
        for ns in namespaces:
            try:
                matches.append(
                    self._rpc_for_namespace(ns)._sync_resolve_key(p)
                )
            except Exception:  # noqa: BLE001
                continue
        if not matches:
            raise ValueError(f"no such session: {key}")
        if len(matches) > 1:
            raise ValueError(
                f"ambiguous session key across profiles: {key}"
            )
        return matches[0]

    async def set_title(self, params: Any) -> Dict[str, Any]:
        return await self._route("set_title", params)

    async def delete_session(self, params: Any) -> Dict[str, Any]:
        return await self._route("delete_session", params)

    async def chat_history(self, params: Any) -> Dict[str, Any]:
        return await self._route("chat_history", params)

    async def describe_session(self, params: Any) -> Dict[str, Any]:
        return await self._route("describe_session", params)

    async def compaction_info(self, params: Any) -> Dict[str, Any]:
        return await self._route("compaction_info", params)

    def row_by_id(self, session_id: str) -> Optional[Dict[str, Any]]:
        return self._ambient_rpc().row_by_id(session_id)

    def newest_carrier_id(self, session_key: str) -> Optional[str]:
        return self._ambient_rpc().newest_carrier_id(session_key)

    def conversation_by_id(
        self, session_id: str, limit: int = 0
    ) -> List[Dict[str, Any]]:
        return self._ambient_rpc().conversation_by_id(session_id, limit=limit)

    def copy_to_ocuclaw(
        self,
        identity: Any,
        *,
        chat_id: str,
        target_public_key: str = "",
    ) -> Dict[str, Any]:
        params = {"identity": identity}
        return self._rpc_for_namespace(
            self._namespace_from_params(params)
        ).copy_to_ocuclaw(
            identity,
            chat_id=chat_id,
            target_public_key=target_public_key,
        )
