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
import inspect
import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# ADR-0004 deny trio: the non-conversational sources excluded from the
# glasses session list (messaging viewports stay visible by design).
DENY_SOURCES: Tuple[str, ...] = ("tool", "cron", "subagent")

# Sources whose rows have no gateway peer and may be adopted onto the glasses
# (Continue here, #2509). Mirrors ADOPTABLE_FOREIGN_SOURCES in
# hermes-session-keys.ts and ADOPTABLE_FOREIGN_HERMES_SOURCES in SessionRoute.kt.
ADOPTABLE_SOURCES: Tuple[str, ...] = ("desktop", "cli", "tui")


class NotAdoptableError(ValueError):
    """A resolvable row the adopt lane refuses to re-key (verdict in ``str()``)."""

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
# Rich projection is several DB reads per distinct session. Inspect a generous
# newest-hit window, then surface truncation instead of multiplying that work
# across an entire long-lived DB (and again across every served profile).
SEARCH_PROJECTION_MIN = 100
SEARCH_PROJECTION_MULTIPLIER = 5
DB_METHOD_SESSIONS_LIST = "db.sessions.list"
DB_METHOD_SESSIONS_SEARCH = "db.sessions.search"
DB_METHOD_RESOLVE_KEY = "db.sessions.resolveKey"
DB_METHOD_SET_TITLE = "db.sessions.setTitle"
DB_METHOD_SET_READ = "db.sessions.setRead"
DB_METHOD_SET_HIDDEN = "db.sessions.setHidden"
DB_METHOD_DELETE = "db.sessions.delete"
DB_METHOD_CHAT_HISTORY = "db.chat.history"
DB_METHOD_DESCRIBE = "db.sessions.describe"
DB_METHOD_COMPACTION_INFO = "db.sessions.compactionInfo"
# Desktop→glasses mirror (#2513): the row-id high-water mark of a lane's live
# transcript. One indexed `MAX(id)` over the tip's messages on a read-only
# connection — NOT `latest_message_row_id`, which is role/text-filtered
# (hermes_state.py:11948-11981) and would sit still on a tool-call-only tail.
DB_METHOD_CHAT_WATERMARK = "db.chat.watermark"

logger = logging.getLogger(__name__)

# Cache for _read_probe_statements(): deriving the probes parses SCHEMA_SQL
# through an in-memory SQLite database, so pay that once per process.
_READ_PROBE_STATEMENTS: Optional[Tuple[str, ...]] = None

# Session read/hidden state (hermes >= 0.20.2 / v2026.8.16): the `sessions`
# columns and the three SessionDB primitives that back the unread glyph and
# the Hide action. Feature-detected together, never by version string.
SESSION_READ_STATE_COLUMNS: Tuple[str, ...] = ("hidden", "last_read_at")
SESSION_READ_STATE_PRIMITIVES: Tuple[str, ...] = (
    "set_session_hidden",
    "set_session_read",
    "session_unread",
)
SESSION_READ_STATE_UNSUPPORTED = "session read state unsupported on this hermes"

# Cache for session_read_state_supported(): the probe parses SCHEMA_SQL, so
# pay it once per process. `None` = not yet computed.
_SESSION_READ_STATE_SUPPORTED: Optional[bool] = None


def _optional_int(value: Any) -> Optional[int]:
    """A JSON number/string as int, or None for absent/unparseable input."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _is_stale_schema_error(exc: BaseException) -> bool:
    """True for the two errors a store behind ``SCHEMA_SQL`` raises at prepare
    time: a missing table and a missing column."""
    message = str(exc).lower()
    return "no such table" in message or "no such column" in message


def _read_probe_statements() -> Tuple[str, ...]:
    """SELECT statements that fail iff the live store is behind SCHEMA_SQL.

    Prefers hermes's own sanctioned helper,
    ``hermes_state_schema.schema_read_probe_statements`` (added after the
    0.20.0 floor). On a 0.20.0 host that helper does not exist,
    so derive the identical probes from the identical source of truth using
    the reconciler's own parser (``SessionSchemaMixin._parse_schema_columns``,
    present at both v2026.8.3 and v2026.8.19) — never a hand-maintained
    column list, which upstream documents going stale within days.

    Each statement is ``LIMIT 0``: column resolution happens at prepare time,
    so the probe reads zero rows. Column references are table-qualified —
    an unqualified double-quoted identifier that fails to resolve silently
    degrades to a string literal (SQLite's double-quoted-string misfeature),
    which would make the probe pass on exactly the stale store it exists to
    catch.

    Returns ``()`` if neither route is importable, which turns the whole
    heal into a no-op rather than a new failure mode.
    """
    global _READ_PROBE_STATEMENTS
    if _READ_PROBE_STATEMENTS is not None:
        return _READ_PROBE_STATEMENTS
    try:
        from hermes_state_schema import schema_read_probe_statements

        _READ_PROBE_STATEMENTS = tuple(schema_read_probe_statements())
        return _READ_PROBE_STATEMENTS
    except ImportError:
        pass
    try:
        from hermes_state_common import SCHEMA_SQL
        from hermes_state_schema import SessionSchemaMixin

        tables = SessionSchemaMixin._parse_schema_columns(SCHEMA_SQL)
    except Exception:  # pragma: no cover - hermes absent / API moved
        logger.debug("session_rpc: no schema read probe available", exc_info=True)
        _READ_PROBE_STATEMENTS = ()
        return _READ_PROBE_STATEMENTS
    _READ_PROBE_STATEMENTS = tuple(
        'SELECT {} FROM "{}" LIMIT 0'.format(
            ", ".join(
                '"{}"."{}"'.format(table.replace('"', '""'), col.replace('"', '""'))
                for col in cols
            ),
            table.replace('"', '""'),
        )
        for table, cols in sorted(tables.items())
    )
    return _READ_PROBE_STATEMENTS


def session_read_state_supported() -> bool:
    """True when the RUNNING hermes carries session read/hidden state.

    Two halves, both required, neither of them a version string (the release
    watcher's standing rule — a version gate goes stale the week a patch
    backports or drops a column):

    1. the `sessions` table in the running hermes's own ``SCHEMA_SQL`` carries
       ``hidden`` and ``last_read_at``, read through the reconciler's own
       parser (``SessionSchemaMixin._parse_schema_columns``, present at both
       v2026.8.3 and v2026.8.19 — the same parser ``_read_probe_statements``
       already uses), and
    2. ``hermes_state.SessionDB`` exposes the three primitives that back the
       lane: ``set_session_hidden``, ``set_session_read``, ``session_unread``.

    Neither half touches the DB, so this is valid at ``register()`` time —
    before any reader is opened and before the Node child is spawned. Any
    exception means "not supported": the whole lane goes inert rather than
    turning a probe failure into a new failure mode. Computed once per
    process (the answer cannot change without a gateway restart).
    """
    global _SESSION_READ_STATE_SUPPORTED
    if _SESSION_READ_STATE_SUPPORTED is not None:
        return _SESSION_READ_STATE_SUPPORTED
    supported = False
    try:
        from hermes_state import SessionDB
        from hermes_state_common import SCHEMA_SQL
        from hermes_state_schema import SessionSchemaMixin

        tables = SessionSchemaMixin._parse_schema_columns(SCHEMA_SQL)
        columns = set(tables.get("sessions") or ())
        supported = all(col in columns for col in SESSION_READ_STATE_COLUMNS) and all(
            callable(getattr(SessionDB, name, None))
            for name in SESSION_READ_STATE_PRIMITIVES
        )
    except Exception:  # noqa: BLE001 - hermes absent / API moved => inert
        logger.debug(
            "session_rpc: session read state probe unavailable", exc_info=True
        )
        supported = False
    _SESSION_READ_STATE_SUPPORTED = supported
    logger.info(
        "session_rpc: session read state %s on this hermes",
        "supported" if supported else "unsupported",
    )
    return supported


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
        session_store_provider: Optional[Callable[[str], Any]] = None,
    ) -> None:
        self._db_path = Path(db_path)
        self._ns = namespace or DEFAULT_SESSION_NAMESPACE
        self._session_store_provider = session_store_provider
        self._reader: Any = None
        self._writer: Any = None
        self._identity_warning_keys: set[Tuple[int, str, str]] = set()
        self._fts_probe_warning_emitted = False

    def _warn_identity_degrade_once(
        self, reader: Any, session_id: str, reason: str, message: str, *args: Any
    ) -> None:
        key = (id(reader), str(session_id), reason)
        if key in self._identity_warning_keys:
            return
        self._identity_warning_keys.add(key)
        logger.warning(message, *args)

    # -- registration ------------------------------------------------------

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        """method → async handler, for LinkProcess.register_request_handler."""
        return {
            DB_METHOD_SESSIONS_LIST: self.list_sessions,
            DB_METHOD_SESSIONS_SEARCH: self.search_sessions,
            DB_METHOD_RESOLVE_KEY: self.resolve_key,
            DB_METHOD_SET_TITLE: self.set_title,
            DB_METHOD_SET_READ: self.set_read,
            DB_METHOD_SET_HIDDEN: self.set_hidden,
            DB_METHOD_DELETE: self.delete_session,
            DB_METHOD_CHAT_HISTORY: self.chat_history,
            DB_METHOD_DESCRIBE: self.describe_session,
            DB_METHOD_COMPACTION_INFO: self.compaction_info,
            DB_METHOD_CHAT_WATERMARK: self.chat_watermark,
        }

    # -- async handler wrappers (DB work off the event loop) ----------------

    async def chat_watermark(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_watermark, params)

    async def list_sessions(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_list, params)

    async def resolve_key(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_resolve_key, params)

    async def search_sessions(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_search, params)

    async def set_title(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_set_title, params)

    async def set_read(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_set_read, params)

    async def set_hidden(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_set_hidden, params)

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
            self._reader = self._open_reader_healed()
        return self._reader

    def _open_reader_healed(self):
        """Read-only SessionDB, healed once if the store is behind SCHEMA_SQL.

        Read-only opens skip ``_reconcile_columns()`` by design (no DDL
        against another profile's live DB), so a store created before a schema
        addition raises "no such column" on read paths until something opens
        it writable. This is not a hypothetical: hermes 0.20.5 moved
        ``SCHEMA_VERSION`` 25 -> 26 (``hermes_state_common.py:219``, was
        ``:155`` at v2026.8.3) with four new ``sessions`` columns
        (``git_metadata_generation``, ``title_source``, ``hidden``,
        ``last_read_at``), and ``list_sessions_rich`` appends
        ``s.hidden = 0`` to the WHERE clause unconditionally when
        ``include_hidden`` is False (``hermes_state.py:8768-8769``) — so
        ``db.sessions.list`` fails OUTRIGHT on a pre-upgrade store, not merely
        in an optional projection that per-row ``in`` gating could cover.

        The one writable open is upstream's own documented remedy for exactly
        this case, not an OcuClaw invention: see
        ``hermes_state_schema.schema_read_probe_statements`` ("Callers that
        heal on staleness (see ``_open_session_db_at_path`` in
        ``hermes_cli/web_server.py``) run these probes right after a read-only
        open") and that caller's probe -> one writable open -> reopen
        read-only sequence. OcuClaw already opens this same store writable for
        the title-patch / lineage-delete lane (``_get_writer``), so no new
        access class is introduced, and the healthy path still never takes a
        write lock: the probe runs first and a current store never reaches the
        writable branch.

        If the writable reconcile cannot close the gap (e.g. a column SQLite
        refuses to ADD), the plain read-only reader is returned anyway and the
        failure is logged once. Reads that do not touch the missing column
        keep working, which is strictly better than raising on every poll.
        """
        from hermes_state import SessionDB

        def _open_probed():
            db = SessionDB(db_path=self._db_path, read_only=True)
            # Unit-test fakes may replace SessionDB without a raw connection.
            conn = getattr(db, "_conn", None)
            if conn is None:
                return db
            try:
                for statement in _read_probe_statements():
                    conn.execute(statement).fetchone()
            except BaseException:
                close = getattr(db, "close", None)
                if callable(close):
                    close()
                raise
            return db

        try:
            return _open_probed()
        except sqlite3.DatabaseError as exc:
            if not _is_stale_schema_error(exc):
                raise
            logger.info(
                "hermes state DB at %s is behind the running hermes schema "
                "(%s); reconciling with one writable open",
                self._db_path,
                exc,
            )

        SessionDB(db_path=self._db_path).close()
        try:
            return _open_probed()
        except sqlite3.DatabaseError as still_stale:
            if not _is_stale_schema_error(still_stale):
                raise
            logger.warning(
                "hermes state DB at %s is missing schema a writable "
                "reconcile could not add (%s); serving reads unprobed — "
                "queries touching the missing column will still fail",
                self._db_path,
                still_stale,
            )
            return SessionDB(db_path=self._db_path, read_only=True)

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

    def _session_ids_by_key(self, session_key: str) -> List[str]:
        """Every row id carrying a native session_key, newest carrier first.

        ``session_key`` is a NON-unique index: a ``/new`` reset ends the old
        row with ``session_reset`` and mints a FRESH row on the same
        deterministic key. Read straight through sqlite (the
        ``_session_keys_by_id`` precedent) — SessionDB exposes no key → all-ids
        primitive, and the recency lookups deliberately return only the newest.
        """
        key = str(session_key or "")
        if not key:
            return []
        with sqlite3.connect(self._db_path, timeout=10) as conn:
            conn.row_factory = sqlite3.Row
            # Live carriers first (same rule as `_carriers_for_key`): after an
            # adopt the newest row on the key is the ended empty stub and the
            # live transcript is the OLDER row (#2509).
            rows = conn.execute(
                """SELECT id FROM sessions
                   WHERE session_key = ?
                   ORDER BY (ended_at IS NULL) DESC, started_at DESC""",
                (key,),
            ).fetchall()
        return [str(row["id"]) for row in rows]

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
        rows = self._conversation_rows_with_identity(str(session_id))
        messages = [
            self._conversation_row_to_wire(row)
            for row in rows
            if row.get("role") in ("user", "assistant") and row.get("content")
        ]
        if limit > 0 and len(messages) > limit:
            messages = messages[-limit:]
        return messages

    def _conversation_rows_with_identity(self, session_id: str) -> List[Dict[str, Any]]:
        """Enrich the public conversation projection with stable row identity.

        Hermes 0.20 can opt the AUTOINCREMENT primary key into the same public
        projection query via ``include_row_ids``. Reading content and identity
        from that one snapshot prevents a concurrent rewind from pairing an old
        projection with a replacement row's id. Older 0.19-compatible readers
        lack the keyword and deliberately degrade just that session to derived
        ids rather than reintroducing a racy private metadata query.
        """
        reader = self._get_reader()
        read_conversation = reader.get_messages_as_conversation
        try:
            parameters = inspect.signature(read_conversation).parameters.values()
            supports_row_ids = any(
                parameter.name == "include_row_ids"
                or parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in parameters
            )
        except (TypeError, ValueError):
            supports_row_ids = True

        if not supports_row_ids:
            public_rows = read_conversation(
                session_id,
                include_ancestors=True,
            )
            self._warn_identity_degrade_once(
                reader,
                session_id,
                "metadata_unavailable",
                "[ocuclaw] Hermes atomic identity projection unavailable for session %s; "
                "using derived ledger ids",
                session_id,
            )
            return public_rows

        public_rows = read_conversation(
            session_id,
            include_ancestors=True,
            include_row_ids=True,
        )

        if any(row.get("_row_id") is None for row in public_rows):
            self._warn_identity_degrade_once(
                reader,
                session_id,
                "metadata_unavailable",
                "[ocuclaw] Hermes atomic identity projection omitted row ids for session %s; "
                "using derived ledger ids",
                session_id,
            )
            return [
                {key: value for key, value in row.items() if key != "_row_id"}
                for row in public_rows
            ]

        enriched_rows = []
        for message in public_rows:
            enriched = dict(message)
            enriched["id"] = enriched.pop("_row_id")
            if enriched.get("message_id") is not None:
                enriched["platform_message_id"] = enriched.get("message_id")
            enriched_rows.append(enriched)
        return enriched_rows

    @staticmethod
    def _conversation_row_to_wire(row: Dict[str, Any]) -> Dict[str, Any]:
        wire = {"role": row.get("role"), "content": row.get("content")}
        for field in ("id", "timestamp", "platform_message_id"):
            if row.get(field) is not None:
                wire[field] = row.get(field)
        return wire

    # -- identity resolution -------------------------------------------------

    def _carriers_for_key(self, session_key: str) -> List[Dict[str, Any]]:
        """Every raw row carrying a native session_key, LIVE carriers first.

        Read through the public ``list_sessions_rich(session_key=K)`` filter
        (hermes_state.py ``s.session_key = ?``), never through
        ``list_gateway_sessions``: that lister picks the newest row per key
        with a ``MAX(started_at)`` subquery that runs BEFORE its
        ``ended_at IS NULL`` clause, so a key whose newest row is an EMPTY
        ended predecessor resolves to that dead row (#2509 — the adopt trap:
        ``/resume <tip> --all`` mints a fresh row on the adopt key, ends it
        with ``session_switch`` and re-keys the OLDER Desktop transcript,
        which is the live carrier). Compression self-heals the trap (the
        continuation child is newest again); an uncompressed lineage never
        does, which is why this ordering is the contract, not a tie-break.

        Order: live rows (``ended_at`` NULL) before ended rows, newest
        ``started_at`` first within each group — hermes's own recovery order
        for reset carriers (a ``/new`` reset ends the old row and mints a
        fresh live one), extended with the liveness rule.
        """
        key = str(session_key or "")
        if not key:
            return []
        reader = self._get_reader()
        kwargs: Dict[str, Any] = {
            "session_key": key,
            "limit": SEARCH_SCAN_LIMIT,
            "include_children": True,
            "include_archived": True,
            "order_by_last_active": True,
            "project_compression_tips": False,
        }
        if session_read_state_supported():
            # A hidden carrier is still the carrier (the wearer's open chat
            # may be hidden from the desktop) — the 0.20.5+ kwarg only.
            kwargs["include_hidden"] = True
        try:
            rows = reader.list_sessions_rich(**kwargs)
        except TypeError:
            # Pre-``session_key`` filter hosts: wide scan, exact-key match.
            kwargs.pop("session_key", None)
            rows = [
                row
                for row in reader.list_sessions_rich(**kwargs)
                if row.get("session_key") == key
            ]
        carriers = [dict(row) for row in rows if row.get("session_key") == key]
        carriers.sort(
            key=lambda row: (
                row.get("ended_at") is None,
                float(row.get("started_at") or 0.0),
            ),
            reverse=True,
        )
        return carriers

    def lineage_for_key(self, session_key: str) -> List[str]:
        """Every session id Desktop's marker/lease files could name for a
        native key: the live carrier's tip first, then its compression chain
        to the root, then every other carrier (ended predecessors included —
        a Desktop lease claimed before the adopt names the OLD tip). Deduped,
        order preserved. Empty when the key carries nothing (#2510)."""
        ordered: List[str] = []
        seen: set = set()

        def push(value: Any) -> None:
            text = str(value or "")
            if text and text not in seen:
                seen.add(text)
                ordered.append(text)

        carriers = self._carriers_for_key(session_key)
        if carriers:
            live = carriers[0]
            tip = str(self._get_reader().resolve_resume_session_id(str(live.get("id"))))
            push(tip)
            for value in self._walk_compression_chain(tip):
                push(value)
        for row in carriers:
            push(row.get("id"))
        return ordered

    def _lookup_session_key(self, session_key: str) -> Optional[Dict[str, Any]]:
        # session_key is NOT unique (regular index): reset/re-created chats
        # reuse the same deterministic key on a FRESH row that is not a
        # compression child of the old one, and an adopt re-keys an OLDER
        # transcript under a key whose newest row is an ended stub. The live
        # carrier wins, newest-first within liveness (`_carriers_for_key`);
        # the tip walk then resolves compression forks from whichever row we
        # picked.
        carriers = self._carriers_for_key(session_key)
        return carriers[0] if carriers else None

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
        model = row.get("model")
        if isinstance(model, str) and model.strip():
            wire["model"] = model.strip()
        billing_provider = row.get("billing_provider")
        if isinstance(billing_provider, str) and billing_provider.strip():
            wire["modelProvider"] = billing_provider.strip()
        # Additive, column-gated growth. `list_sessions_rich` fetches with
        # `SELECT s.*`, so a row from a host whose schema predates
        # `last_activity_description` (hermes_state_common.py:234) simply has
        # no such KEY — a per-row `in` check is free, exact for THIS db, and
        # needs no PRAGMA preflight and no reach into SessionDB privates.
        # The wire stays byte-identical on those hosts.
        #
        # Deliberately NOT carried: `last_activity_at`. OcuClaw's existing
        # `lastActive` is already
        # `COALESCE(MAX(last_activity_at, MAX(messages.timestamp)), started_at)`
        # (hermes_state_common.py:105-127) — strictly fresher than the raw
        # column, and it is already on the wire, so the phone can gate the
        # description on staleness without a second timestamp.
        if "last_activity_description" in row:
            description = row.get("last_activity_description")
            # Upstream clears this to "" in the turn's `finally`
            # (`clear_session_activity_labels`), so empty means idle, not
            # unknown. Normalize both to None so the wire has one absent form.
            wire["lastActivityDescription"] = (
                description if isinstance(description, str) and description else None
            )
        # Same per-row `in` gate, same reason: `unread` is DERIVED onto every
        # `list_sessions_rich` row by upstream (`session_unread`, the
        # last_read_at watermark vs last_active), and `hidden` rides the
        # `SELECT s.*`. A host whose schema predates them (0.20.0) carries
        # neither KEY, so the wire stays byte-identical there — the client
        # sees "absent", never a fabricated `false`.
        if "unread" in row:
            wire["unread"] = bool(row.get("unread"))
        if "hidden" in row:
            wire["hidden"] = bool(row.get("hidden"))
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

        Liveness beats recency (#2509): an adopt ends a fresh EMPTY row on
        the adopt key (newest by ``last_active`` — its ``started_at``) and
        re-keys the older Desktop transcript, which stays live. The live
        carrier is the row the key resolves to (`_lookup_session_key`), so
        it is the row the list shows.
        """
        first_index: Dict[str, int] = {}
        deduped: List[Dict[str, Any]] = []
        for row in rows:
            session_key = row.get("session_key")
            if not session_key:
                deduped.append(row)
                continue
            if session_key in first_index:
                kept = deduped[first_index[session_key]]
                if kept.get("ended_at") is not None and row.get("ended_at") is None:
                    deduped[first_index[session_key]] = row
                continue
            first_index[session_key] = len(deduped)
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
            # The exact-key path must hydrate a HIDDEN row too: the wearer's
            # active session can be hidden from the desktop while the glasses
            # still hold it open, and the honest answer is the row with
            # `hidden: true`, not a silent disappearance. The kwarg does not
            # exist at 0.20.0, so pass it only when the lane is supported.
            hidden_kwargs = (
                {"include_hidden": True} if session_read_state_supported() else {}
            )
            # id_query is only honored on the order_by_last_active path
            # (hermes_state.py:2790-2793 — other callers pass None).
            rows = self._get_reader().list_sessions_rich(
                exclude_sources=list(DENY_SOURCES),
                id_query=tip,
                limit=2,
                include_children=True,
                order_by_last_active=True,
                project_compression_tips=True,
                **hidden_kwargs,
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

    @staticmethod
    def _search_query(query: str) -> str:
        """Match Hermes dashboard search's partial-word behavior.

        SessionDB.search_messages() applies Hermes 0.20's bounded
        _sanitize_fts5_query() before MATCH; this layer deliberately mirrors
        the dashboard's prefix expansion rather than bypassing that sanitizer.
        """
        terms = []
        for token in re.findall(r'"[^"]*"|\S+', query.strip()):
            if token.startswith('"') or token.endswith("*"):
                terms.append(token)
            else:
                terms.append(f"{token}*")
        return " ".join(terms)

    def _visible_search_row(self, session_id: str) -> Optional[Dict[str, Any]]:
        db = self._get_reader()
        tip = db.resolve_resume_session_id(str(session_id))
        raw_row = db.get_session(tip)
        if raw_row is None:
            return None
        row = dict(raw_row)
        if row.get("source") in DENY_SOURCES or not self._list_row_visible(row):
            return None
        session_key = row.get("session_key")
        if session_key:
            newest = self._lookup_session_key(str(session_key))
            if newest is None:
                return None
            newest_tip = db.resolve_resume_session_id(str(newest["id"]))
            if newest_tip != tip:
                # A reset can leave searchable messages on an older carrier
                # whose public key now identifies a different live row. The
                # normal session list hides that carrier, so deep search must
                # hide it too rather than navigate the hit to the wrong chat.
                return None
        # Use the same rich-row projection as sessions.list so lastActive,
        # preview, source, and compression metadata are identical on both
        # paths. get_session() above is only the indexed identity check.
        rich_rows = db.list_sessions_rich(
            exclude_sources=list(DENY_SOURCES),
            id_query=tip,
            limit=2,
            include_children=True,
            order_by_last_active=True,
            project_compression_tips=True,
        )
        return next(
            (dict(candidate) for candidate in rich_rows if candidate.get("id") == tip),
            None,
        )

    def _sync_search(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        query = str(p.get("query") or "").strip()
        try:
            limit = int(p.get("limit"))
        except (TypeError, ValueError):
            limit = 50
        limit = max(1, min(limit, 100))
        if not query:
            return {"available": True, "matches": [], "truncated": False}

        db = self._get_reader()
        # Hermes 0.20's read-only SessionDB constructor probes the actual FTS
        # table and stores the result here. search_messages() otherwise maps
        # the unavailable state to [], which is indistinguishable from a real
        # zero-match query and therefore cannot cross our public RPC honestly.
        if not hasattr(db, "_fts_enabled"):
            if not self._fts_probe_warning_emitted:
                logger.error("Hermes SessionDB FTS capability probe is unavailable")
                self._fts_probe_warning_emitted = True
            return {
                "available": False,
                "reason": "fts_probe_unavailable",
                "matches": [],
                "truncated": False,
            }
        if not bool(db._fts_enabled):
            return {
                "available": False,
                "reason": "fts_unavailable",
                "matches": [],
                "truncated": False,
            }

        raw_matches = db.search_messages(
            self._search_query(query),
            exclude_sources=list(DENY_SOURCES),
            role_filter=["user", "assistant"],
            limit=SEARCH_SCAN_LIMIT,
            sort="newest",
            fields=("session_id", "role", "snippet", "timestamp", "source"),
        )
        seen = set()
        projected: Dict[str, Optional[Dict[str, Any]]] = {}
        matches: List[Dict[str, Any]] = []
        projection_limit = max(
            SEARCH_PROJECTION_MIN,
            limit * SEARCH_PROJECTION_MULTIPLIER,
        )
        projection_count = 0
        projection_truncated = False
        for match in raw_matches:
            raw_session_id = str(match.get("session_id") or "")
            if raw_session_id not in projected:
                if projection_count >= projection_limit:
                    projection_truncated = True
                    break
                projection_count += 1
                projected[raw_session_id] = self._visible_search_row(raw_session_id)
                visible = projected[raw_session_id]
                if visible is not None:
                    # Compression ancestors and their live tip can both carry
                    # hits. Cache the projected tip too so each visible
                    # conversation pays the rich-row lookup at most once.
                    projected.setdefault(str(visible.get("id") or ""), visible)
            row = projected[raw_session_id]
            if row is None:
                continue
            wire = self._row_to_wire(row)
            dedupe_key = wire.get("sessionKey") or (
                wire.get("source"), wire.get("lineageRootId")
            )
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            matches.append(
                {
                    "session": wire,
                    "role": match.get("role"),
                    "snippet": match.get("snippet") or "",
                }
            )
        matches.sort(
            key=lambda match: float(match["session"].get("lastActive") or 0),
            reverse=True,
        )
        truncated = (
            projection_truncated
            or len(matches) > limit
            or len(raw_matches) >= SEARCH_SCAN_LIMIT
        )
        return {
            "available": True,
            "matches": matches[:limit],
            "truncated": truncated,
        }

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

    def _sync_set_read(self, params: Any) -> Dict[str, Any]:
        """Stamp the read watermark (`last_read_at`) on one conversation.

        `read=False` writes 0.0 = EXPLICITLY unread (any activity postdates
        it); NULL, the pre-feature default, means "never tracked" = read, so
        shipping the column never badges a whole history at once. Upstream
        stamps the entire compression lineage as a unit, so the tip is the
        only id this needs.
        """
        if not session_read_state_supported():
            raise ValueError(SESSION_READ_STATE_UNSUPPORTED)
        p = params if isinstance(params, dict) else {}
        tip = self._resolve_target(p.get("identity"), fail_closed=True)
        read = p.get("read")
        self._get_writer().set_session_read(
            tip, read=True if read is None else bool(read)
        )
        return {"ok": True}

    def _hide_targets(self, identity: Any, tip: str) -> List[str]:
        """Every row whose `hidden` flag must move with this identity.

        `set_session_hidden` flips ONE compression lineage. A minted key can
        carry several: a `/new` reset ends the old row with `session_reset`
        and mints a fresh row on the same deterministic session_key, and
        `_dedupe_by_session_key` merely keeps the newest carrier in front of
        the older ones. Hiding only the tip would therefore resurface a stale
        pre-reset carrier — with its stale preview — on the very next list.
        So a minted identity flips every carrier of its native key.

        Foreign identities have no minted key grammar to enumerate (and their
        `remainder` may be an external-root form with no session_key at all),
        so they flip the resolved tip's lineage only.
        """
        ident = identity if isinstance(identity, dict) else {}
        chat_id = ident.get("chatId")
        if not isinstance(chat_id, str) or not chat_id:
            return [tip]
        ns = str(ident.get("ns") or self._ns)
        carriers = self._session_ids_by_key(
            f"agent:{ns}:{OCUCLAW_PLATFORM_SEGMENT}:"
            f"{OCUCLAW_CHAT_TYPE_SEGMENT}:{chat_id}"
        )
        if tip not in carriers:
            carriers.append(tip)
        return carriers

    def _sync_set_hidden(self, params: Any) -> Dict[str, Any]:
        """Hide/unhide a conversation from the global sessions listing."""
        if not session_read_state_supported():
            raise ValueError(SESSION_READ_STATE_UNSUPPORTED)
        p = params if isinstance(params, dict) else {}
        identity = p.get("identity")
        hidden = bool(p.get("hidden"))
        tip = self._resolve_target(identity, fail_closed=True)
        writer = self._get_writer()
        for target in self._hide_targets(identity, tip):
            writer.set_session_hidden(target, hidden)
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
        rows = self._conversation_rows_with_identity(tip)
        # Conversational shaping happens HERE, before serialization: only
        # user/assistant rows with content survive, and the tail slice
        # applies server-side so a long transcript never has to fit the
        # 1 MiB link frame cap when the caller asked for a bounded page
        # (Codex review W05 finding). Content stays scalar-or-block-list;
        # the Node bridge re-shapes defensively over the same pinned shape.
        messages = [
            self._conversation_row_to_wire(row)
            for row in rows
            if row.get("role") in ("user", "assistant") and row.get("content")
        ]
        # PRE-slice count. The tail slice below is the only reason a caller
        # can silently lose the beginning of its own conversation; `total`
        # is what makes that loss observable instead of invisible. No
        # `offset` companion: nothing in composeApp or the plugin has a
        # load-earlier affordance, so an offset would be protocol surface for
        # a UI that does not exist. The slice stays TAIL-anchored.
        total = len(messages)
        # Desktop→glasses mirror (#2513): `afterId` tails the transcript past a
        # `db.chat.watermark` row id. Applied BEFORE the limit so the caller
        # gets exactly the rows that landed since its watermark. A store whose
        # projection carries no row ids (0.19-compatible readers) cannot tail
        # — say so instead of returning the whole transcript as "new".
        after_id = _optional_int(p.get("afterId"))
        row_ids_unavailable = False
        if after_id is not None:
            if any(message.get("id") is None for message in messages):
                row_ids_unavailable = True
                messages = []
            else:
                messages = [
                    message for message in messages if int(message["id"]) > after_id
                ]
        try:
            limit = int(p.get("limit"))
        except (TypeError, ValueError):
            limit = 0
        if limit > 0 and len(messages) > limit:
            messages = messages[-limit:]
        result: Dict[str, Any] = {"messages": messages, "sessionId": tip, "total": total}
        if row_ids_unavailable:
            result["rowIdsUnavailable"] = True
        return result

    # -- Desktop→glasses mirror (#2513) --------------------------------------

    def _sync_watermark(self, params: Any) -> Dict[str, Any]:
        """``{identity}`` → ``{sessionId, watermark, dbPath, hermesHome}``.

        ``watermark`` is ``MAX(messages.id)`` over the lane's LIVE transcript
        (the compression tip); ``None`` for an empty transcript. New rows —
        Desktop's, the gateway's, anyone's — always land on the tip with a
        higher AUTOINCREMENT id, and a compression fork moves ``sessionId``,
        which the caller treats as "rehydrate", never as a tail. Read on a
        separate ``mode=ro`` connection (no write lock, hermes_state.py:902-919)
        so a Desktop mid-write is never blocked by the mirror.
        """
        p = params if isinstance(params, dict) else {}
        tip = self._resolve_target(p.get("identity"), fail_closed=True)
        return {
            "sessionId": tip,
            "watermark": self._max_message_row_id(tip),
            "dbPath": str(self._db_path),
            "hermesHome": str(self._db_path.parent),
        }

    def _max_message_row_id(self, session_id: str) -> Optional[int]:
        uri = f"file:{self._db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=10)
        try:
            row = conn.execute(
                "SELECT MAX(id) FROM messages WHERE session_id = ?",
                (str(session_id),),
            ).fetchone()
        finally:
            conn.close()
        return int(row[0]) if row and row[0] is not None else None

    def _sync_describe(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        tip = self._resolve_target(p.get("identity"), fail_closed=True)
        row = self._get_reader().get_session(tip)
        if row is None:
            raise ValueError(f"no such session: {tip}")
        described = {
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
        # Current prompt occupancy is not a SessionDB token total. Hermes owns
        # it in the public, persisted SessionStore entry as
        # ``last_prompt_tokens``. The adapter receives that store through
        # BasePlatformAdapter.set_session_store before connect, so read it via
        # the public lookup API and never guess from cumulative billed tokens.
        store = (
            self._session_store_provider(self._ns)
            if self._session_store_provider is not None
            else None
        )
        lookup = getattr(store, "lookup_by_session_id", None)
        if callable(lookup):
            try:
                entry = lookup(tip)
                raw_prompt_tokens = getattr(entry, "last_prompt_tokens", None)
                if (
                    isinstance(raw_prompt_tokens, int)
                    and not isinstance(raw_prompt_tokens, bool)
                    and raw_prompt_tokens >= 0
                ):
                    described["lastMessageTokenCount"] = raw_prompt_tokens
            except Exception:  # noqa: BLE001 - context row degrades honestly
                logger.debug(
                    "session_rpc: SessionStore prompt-token read failed",
                    exc_info=True,
                )
        # Spend belongs on the single-session read, next to the token counters
        # it sits beside conceptually. COALESCE(actual, estimated) is upstream's
        # own rule twice over: `HermesSession.displayCostUSD` in Scarf is
        # `actualCostUSD ?? estimatedCostUSD`, and hermes' reaping filter uses
        # `COALESCE(s.actual_cost_usd, s.estimated_cost_usd, 0)`
        # (hermes_state.py:8171). Column-gated per row, same rule as
        # `_row_to_wire`: absent columns leave the key off entirely.
        cost = self._coalesced_cost_usd(row)
        if cost is not None:
            described["costUsd"] = cost
        return described

    @staticmethod
    def _coalesced_cost_usd(row: Dict[str, Any]) -> Optional[float]:
        """COALESCE(actual_cost_usd, estimated_cost_usd) as a float, or None.

        None covers three cases that must not be distinguishable downstream:
        the host's schema predates the columns, the columns are NULL, or the
        values are non-numeric. "No figure" is the honest render in all three.
        """
        for column in ("actual_cost_usd", "estimated_cost_usd"):
            if column not in row:
                continue
            value = row.get(column)
            if value is None or isinstance(value, bool):
                continue
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
        return None

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

    # -- Continue here (adopt) — #2509 ---------------------------------------

    def resolve_adopt_source(self, identity: Any) -> Dict[str, Any]:
        """identity → the live tip of an ADOPTABLE external row.

        Adoptable = a row Hermes wrote with no gateway peer (``session_key``
        NULL — Desktop/CLI/TUI, ADR-0004's external-root form) whose source
        is in ``ADOPTABLE_SOURCES``. Platform-origin rows (Telegram/Discord/…)
        own a gateway peer that ``/resume`` would rewrite, so they stay
        read-only (map #2507). Minted identities are refused before the DB
        is touched — adopting the wearer's own chat would end it.

        Raises ``ValueError`` (not found / not resolvable) or
        ``NotAdoptableError`` (resolvable, but a row this lane must not
        re-key). Returns ``{tip, rootId, source, title, lineage}`` where
        ``lineage`` is tip → root (the ids Desktop's marker/lease files key
        on — T2's hold check reads them).
        """
        ident = identity if isinstance(identity, dict) else {}
        if ident.get("chatId"):
            raise NotAdoptableError("minted_identity_refused")
        ns = str(ident.get("ns") or self._ns)
        if ns != DEFAULT_SESSION_NAMESPACE:
            raise NotAdoptableError("adopt_requires_default_namespace")
        tip = self._resolve_target(identity, fail_closed=True)
        db = self._get_reader()
        row = db.get_session(tip)
        if row is None:
            raise ValueError(f"no such session: {tip}")
        row = dict(row)
        source = str(row.get("source") or "")
        if row.get("session_key"):
            raise NotAdoptableError("platform_row_not_adoptable")
        if source not in ADOPTABLE_SOURCES:
            raise NotAdoptableError("source_not_adoptable")
        lineage = self._walk_compression_chain(tip)
        return {
            "tip": tip,
            "rootId": lineage[-1] if lineage else tip,
            "source": source,
            "title": row.get("title"),
            "lineage": lineage,
        }

    def adopt_outcome(self, adopt_key: str, tip: str) -> Dict[str, Any]:
        """Read the adopt verdict from the DB, never from Hermes's reply text.

        After ``switch_session`` the tip row carries the adopt key and is
        live; every OTHER carrier of that key is the ended fresh stub
        (``end_reason='session_switch'``, 0 messages). ``adopted`` is True
        only when the tip is the LIVE carrier the key resolves to.
        """
        carriers = self._carriers_for_key(adopt_key)
        live = [row for row in carriers if row.get("ended_at") is None]
        tip_row = next((row for row in carriers if str(row.get("id")) == tip), None)
        adopted = (
            tip_row is not None
            and tip_row.get("ended_at") is None
            and bool(live)
            and str(live[0].get("id")) == tip
        )
        predecessors = [
            {
                "id": str(row.get("id")),
                "endReason": row.get("end_reason"),
                "messageCount": int(row.get("message_count") or 0),
            }
            for row in carriers
            if str(row.get("id")) != tip
        ]
        return {
            "adopted": adopted,
            "tip": tip,
            "predecessors": predecessors,
            "session": self._row_to_wire(tip_row) if tip_row is not None else None,
        }

    def hide_sessions(self, session_ids: List[str]) -> List[str]:
        """Hide rows with the public view-state flag (no-op pre-0.20.5)."""
        if not session_read_state_supported():
            return []
        writer = self._get_writer()
        hidden = []
        for session_id in session_ids:
            try:
                writer.set_session_hidden(str(session_id), True)
                hidden.append(str(session_id))
            except Exception:  # noqa: BLE001 - presentation only, never fatal
                logger.debug("hide predecessor %s failed", session_id, exc_info=True)
        return hidden


class ProfileSessionRpc:
    """Route the db.* lane across profile-isolated Hermes state DBs."""

    def __init__(
        self,
        default_db_path: Path,
        routing_provider: Callable[[], Tuple[bool, Dict[str, Path]]],
        session_store_provider: Optional[Callable[[str], Any]] = None,
    ) -> None:
        self._default_db_path = Path(default_db_path)
        self._routing_provider = routing_provider
        self._session_store_provider = session_store_provider
        self._lock = threading.RLock()
        self._rpcs: Dict[str, SessionRpc] = {
            DEFAULT_SESSION_NAMESPACE: SessionRpc(
                self._default_db_path,
                namespace=DEFAULT_SESSION_NAMESPACE,
                session_store_provider=self._session_store_provider,
            )
        }

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        return {
            DB_METHOD_SESSIONS_LIST: self.list_sessions,
            DB_METHOD_SESSIONS_SEARCH: self.search_sessions,
            DB_METHOD_RESOLVE_KEY: self.resolve_key,
            DB_METHOD_SET_TITLE: self.set_title,
            DB_METHOD_SET_READ: self.set_read,
            DB_METHOD_SET_HIDDEN: self.set_hidden,
            DB_METHOD_DELETE: self.delete_session,
            DB_METHOD_CHAT_HISTORY: self.chat_history,
            DB_METHOD_DESCRIBE: self.describe_session,
            DB_METHOD_COMPACTION_INFO: self.compaction_info,
            DB_METHOD_CHAT_WATERMARK: self.chat_watermark,
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
                rpc = SessionRpc(
                    db_path,
                    namespace=namespace,
                    session_store_provider=self._session_store_provider,
                )
                self._rpcs[namespace] = rpc
            return rpc

    def _ambient_rpc(self) -> SessionRpc:
        # VERIFIED Hermes 0.20 anchors: gateway.run._profile_runtime_scope
        # covers the whole turn, the ContextVar crosses into the agent worker
        # through copy_context, and agent.turn_finalizer fires on_session_end
        # inside that scope. Resolve
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

    async def search_sessions(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_search_sessions, params)

    def _sync_search_sessions(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        enabled, homes = self._routing()
        if not enabled:
            return self._rpcs[DEFAULT_SESSION_NAMESPACE]._sync_search(p)
        try:
            limit = int(p.get("limit"))
        except (TypeError, ValueError):
            limit = 50
        limit = max(1, min(limit, 100))
        fanout_params = dict(p)
        fanout_params["limit"] = limit
        matches: List[Dict[str, Any]] = []
        unavailable_profiles = []
        failed_profiles = []
        unavailable_reasons = set()
        successful_profiles = 0
        truncated = False
        for ns, home in homes.items():
            if not (Path(home) / "state.db").exists():
                continue
            try:
                result = self._rpc_for_namespace(ns)._sync_search(fanout_params)
            except Exception:  # noqa: BLE001
                logger.exception("Hermes transcript search failed for profile %s", ns)
                unavailable_profiles.append(ns)
                failed_profiles.append(ns)
                continue
            if not result.get("available", False):
                unavailable_profiles.append(ns)
                unavailable_reasons.add(str(result.get("reason") or "fts_unavailable"))
            else:
                successful_profiles += 1
            matches.extend(result.get("matches") or [])
            truncated = truncated or bool(result.get("truncated"))
        matches.sort(
            key=lambda match: float(match["session"].get("lastActive") or 0),
            reverse=True,
        )
        truncated = truncated or len(matches) > limit
        response: Dict[str, Any] = {
            "available": not unavailable_profiles,
            "matches": matches[:limit],
            "truncated": truncated,
        }
        if unavailable_profiles:
            if successful_profiles > 0:
                response["reason"] = "partial_search_unavailable"
            elif failed_profiles:
                response["reason"] = "search_failed"
            elif "fts_probe_unavailable" in unavailable_reasons:
                response["reason"] = "fts_probe_unavailable"
            else:
                response["reason"] = "fts_unavailable"
            if failed_profiles:
                response["failedProfiles"] = sorted(failed_profiles)
            response["unavailableProfiles"] = sorted(unavailable_profiles)
        return response

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

    async def set_read(self, params: Any) -> Dict[str, Any]:
        return await self._route("set_read", params)

    async def set_hidden(self, params: Any) -> Dict[str, Any]:
        return await self._route("set_hidden", params)

    async def delete_session(self, params: Any) -> Dict[str, Any]:
        return await self._route("delete_session", params)

    async def chat_history(self, params: Any) -> Dict[str, Any]:
        return await self._route("chat_history", params)

    async def chat_watermark(self, params: Any) -> Dict[str, Any]:
        return await self._route("chat_watermark", params)

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

    # -- Continue here (adopt) — #2509: default-lane only, by contract ------

    def resolve_adopt_source(self, identity: Any) -> Dict[str, Any]:
        return self._rpc_for_namespace(
            self._namespace_from_params({"identity": identity})
        ).resolve_adopt_source(identity)

    def adopt_outcome(self, adopt_key: str, tip: str) -> Dict[str, Any]:
        return self._rpc_for_namespace(DEFAULT_SESSION_NAMESPACE).adopt_outcome(
            adopt_key, tip
        )

    def lineage_for_key(self, session_key: str, ns: Optional[str] = None) -> List[str]:
        return self._rpc_for_namespace(
            str(ns or DEFAULT_SESSION_NAMESPACE)
        ).lineage_for_key(session_key)

    def hide_sessions(self, session_ids: List[str]) -> List[str]:
        return self._rpc_for_namespace(DEFAULT_SESSION_NAMESPACE).hide_sessions(
            session_ids
        )
