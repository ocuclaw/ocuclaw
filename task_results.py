"""Scheduled-task results kept on the host (#5026).

Hermes delivers a cron run through the platform adapter's ``send()`` like a
chat reply: ``adapter.send(chat_id, text, metadata={"job_id": ..., "notify":
...})`` (``cron/scheduler_delivery.py`` ``_live_route_metadata``). That text
carries Hermes' chat wrapper, can be a one-line failure notice, and above
4000 characters is cut with a footer naming a host path. None of that suits
the glasses.

This module turns such a delivery into a Task result and keeps it:

* :func:`parse_cron_delivery` strips the wrapper, the truncation footer and
  the failure notice's operator guidance, then splits what is left into a
  headline (first line), a body, and an optional fenced ``ocuclaw-card``
  block of JSON values. It needs no metadata, so a standalone sender that
  only sees the text can still read the job id from the wrapper.
* :class:`TaskResultStore` keeps each result in a small SQLite file under the
  plugin's state directory (``<HERMES_HOME>/state/task_results.sqlite3``), so
  results survive a gateway restart and a second process can write safely.
  It keeps the latest result per job (for the glasses) and the last
  :data:`RECENT_LIMIT` results (for the phone). Each result has an id and an
  ack state; :meth:`TaskResultStore.ack` acks once.
* A process without the live adapter (``hermes cron run`` in a terminal)
  writes its delivery here undelivered (#5031): a result, or a plain pending
  message when the text names no job. The gateway's inbox pump
  (``task_delivery.py``) sends what is undelivered once and marks it
  delivered. Delivered is not acked: the ack stays the wearer's.

Stdlib only. Hermes' global ``cron.wrap_response`` is left alone, because
other platforms use the wrapper; text without it parses too.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

STORE_FILENAME = "task_results.sqlite3"
#: Results the phone can list.
RECENT_LIMIT = 30
#: Jobs whose latest result is kept beyond :data:`RECENT_LIMIT` (a bound, so
#: deleted jobs cannot grow the store without limit).
LATEST_JOBS_LIMIT = 200
#: A card block larger than this (UTF-8 bytes) is ignored.
CARD_MAX_BYTES = 16 * 1024
HEADLINE_MAX = 200
#: Stored body bound; Hermes caps a non-chunking send at 4000 chars, but a
#: standalone sender may hand over the whole output.
BODY_MAX = 32 * 1024
ERROR_MAX = 500
BUSY_TIMEOUT_SECONDS = 5.0
CARD_FENCE = "ocuclaw-card"
DEFAULT_HEADLINE = "Scheduled task"

STATUS_OK = "ok"
STATUS_FAILED = "failed"

# -- Hermes 0.22.1 delivery text ------------------------------------------------
#
# Wrapper, ``cron/scheduler_delivery.py:1827-1837`` (``_deliver_result``):
#   f"Cronjob Response: {task_name}\n"
#   f"(job_id: {job.get('id', '')})\n"
#   f"-------------\n\n"
#   f"{content}\n\n"
#   "To stop or manage this job, send me a new message "
#   f"(e.g. \"stop reminder {task_name}\")."
# Hermes then strips MEDIA tags (which can collapse blank lines and strip the
# ends), so the patterns below tolerate whitespace drift.
_WRAP_HEADER = re.compile(
    r"\A\s*Cronjob Response: (?P<name>[^\n]*)\n"
    r"\(job_id: (?P<job_id>[^)\n]*)\)\n"
    r"-{3,}[ \t]*(?:\n|\Z)"
)
_WRAP_FOOTER = re.compile(
    r"\s*To stop or manage this job, send me a new message "
    r"\(e\.g\. \"stop reminder [^\n]*\"\)\.\s*\Z"
)
# Truncation, ``gateway/delivery.py:256`` (``_cap_oversized_output``):
#   f"\n\n... [truncated, full output saved to {saved_path}]"
# The path is a host path; it never reaches the glasses.
_TRUNCATION_FOOTER = re.compile(r"\s*\.\.\. \[truncated, full output saved to [^\n]*\]\s*\Z")
# Failure notices, ``cron/scheduler_failure_copy.py`` (provider, generic,
# script timeout, inactivity) all open "⚠️ Cron '{job_name}' failed: ";
# a blocked-config run opens "⛔ Cron '{job_name}' did not run: ".
_FAILED = re.compile(r"\A\s*⚠️?\s*Cron '(?P<name>.*?)' failed: (?P<rest>.*)\Z", re.DOTALL)
_DID_NOT_RUN = re.compile(r"\A\s*⛔️?\s*Cron '(?P<name>.*?)' did not run: (?P<rest>.*)\Z", re.DOTALL)
# Where the operator guidance starts, by notice shape.
_GENERIC_GUIDANCE = ". See the full run with `hermes cron runs "  # generic_failure_notice
_BLOCKED_GUIDANCE = " Nothing was charged. Hermes will try again"  # blocked_config_notice
# Provider, script-timeout and inactivity notices: the cause is the first
# clause, ended by ". " (the cause glosses hold no full stop).
_FIRST_SENTENCE_END = re.compile(r"\.(?:\s|\Z)|\n")

_CARD_BLOCK = re.compile(
    r"^[ \t]*```" + CARD_FENCE + r"[ \t]*\n(?P<json>.*?)\n?^[ \t]*```[ \t]*$\n?",
    re.DOTALL | re.MULTILINE,
)
# An opening fence with no close (the text was truncated inside the block).
_CARD_OPEN_TAIL = re.compile(r"^[ \t]*```" + CARD_FENCE + r"[ \t]*(?:\n.*)?\Z", re.DOTALL | re.MULTILINE)
#: #6673: an Alert run's state block (``domain/task-alert-state.ts``), for the plugin only.
ALERT_FENCE = "ocuclaw-alert"
_ALERT_BLOCK = re.compile(
    r"^[ \t]*```" + ALERT_FENCE + r"[ \t]*\n.*?\n?^[ \t]*```[ \t]*$\n?",
    re.DOTALL | re.MULTILINE,
)
_ALERT_OPEN_TAIL = re.compile(r"^[ \t]*```" + ALERT_FENCE + r"[ \t]*(?:\n.*)?\Z", re.DOTALL | re.MULTILINE)


def strip_alert_blocks(text: str) -> str:
    """*text* without its ``ocuclaw-alert`` blocks (an unclosed one at the end too), as
    ``splitAlertState`` in ``domain/task-alert-state.ts`` takes them out."""
    if ("```" + ALERT_FENCE) not in text:
        return text
    rest = _ALERT_OPEN_TAIL.sub("", _ALERT_BLOCK.sub("", text))
    return re.sub(r"\n{3,}", "\n\n", rest).rstrip()
_HEADING = re.compile(r"\A(?:#{1,6}\s+)?(?P<text>.*?)\s*\Z")


def _strip_emphasis(line: str) -> str:
    line = _HEADING.match(line).group("text")
    for mark in ("**", "__"):
        if len(line) > 2 * len(mark) and line.startswith(mark) and line.endswith(mark):
            line = line[len(mark):-len(mark)].strip()
    return line


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite JSON number {name}")


def parse_card(raw: str) -> Optional[Dict[str, Any]]:
    """The card's JSON object, or None when it is too big, invalid, or not an
    object. Never raises."""
    if not isinstance(raw, str) or len(raw.encode("utf-8", "surrogatepass")) > CARD_MAX_BYTES:
        return None
    try:
        value = json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def _split_card(text: str) -> tuple[str, Optional[Dict[str, Any]]]:
    """Remove every ``ocuclaw-card`` block from *text*; the last one is the card."""
    card: Optional[Dict[str, Any]] = None
    blocks = list(_CARD_BLOCK.finditer(text))
    if blocks:
        card = parse_card(blocks[-1].group("json"))
        text = _CARD_BLOCK.sub("", text)
    text = _CARD_OPEN_TAIL.sub("", text)
    return text, card


def _failure_cause(rest: str, *, blocked: bool) -> str:
    rest = rest.strip()
    marker = _BLOCKED_GUIDANCE if blocked else _GENERIC_GUIDANCE
    cut = rest.rfind(marker)
    if cut >= 0:
        cause = rest[:cut]
    else:
        end = _FIRST_SENTENCE_END.search(rest)
        cause = rest[: end.start()] if end else rest
    cause = re.sub(r"\s+", " ", cause).strip().rstrip(".").strip()
    return _clip(cause, ERROR_MAX)


def _sentence(text: str) -> str:
    text = text[:1].upper() + text[1:]
    return text if text.endswith((".", "!", "?")) else text + "."


def parse_cron_delivery(text: Any, *, job_name: Optional[str] = None) -> Dict[str, Any]:
    """Split one Hermes cron delivery into its parts.

    Returns ``{job_id, job_name, failed, error, headline, body, card,
    truncated, wrapped}``. ``job_id``/``job_name`` come from the wrapper and
    are None without it (*job_name* is the fallback name). ``failed`` is True for a failure or did-not-run
    notice, with ``error`` its cause (no host paths or CLI guidance).
    ``card`` is the parsed ``ocuclaw-card`` object or None. ``headline`` is
    never empty: without text it falls back to the job name.
    """
    text = "" if text is None else str(text)
    text = text.replace("\r\n", "\n")
    truncated = False
    match = _TRUNCATION_FOOTER.search(text)
    if match:
        truncated = True
        text = text[: match.start()]

    fallback_name = (str(job_name).strip() or None) if job_name is not None else None
    job_id: Optional[str] = None
    job_name = None
    wrapped = False
    header = _WRAP_HEADER.match(text)
    if header:
        wrapped = True
        job_id = header.group("job_id").strip() or None
        job_name = header.group("name").strip() or None
        text = text[header.end():]
        footer = _WRAP_FOOTER.search(text)
        if footer:
            text = text[: footer.start()]

    failed = False
    error: Optional[str] = None
    failure = _FAILED.match(text)
    blocked = None if failure else _DID_NOT_RUN.match(text)
    notice = failure or blocked
    if notice:
        failed = True
        job_name = job_name or (notice.group("name").strip() or None) or fallback_name
        error = _failure_cause(notice.group("rest"), blocked=blocked is not None) or "unknown error"
        name = job_name or DEFAULT_HEADLINE
        headline = _clip(f"{name} {'did not run' if blocked else 'failed'}", HEADLINE_MAX)
        return {
            "job_id": job_id, "job_name": job_name, "failed": True, "error": error,
            "headline": headline, "body": _sentence(error), "card": None,
            "truncated": truncated, "wrapped": wrapped,
        }

    job_name = job_name or fallback_name
    # #6673: an Alert's ``ocuclaw-alert`` block is for the plugin; it never shows.
    text, card = _split_card(strip_alert_blocks(text))
    lines = text.strip("\n").split("\n")
    headline = ""
    rest_at = 0
    for index, line in enumerate(lines):
        if line.strip():
            headline = _strip_emphasis(line.strip())
            rest_at = index + 1
            break
    body = "\n".join(lines[rest_at:]).strip() if headline else ""
    if not headline:
        headline = job_name or DEFAULT_HEADLINE
    return {
        "job_id": job_id, "job_name": job_name, "failed": failed, "error": error,
        "headline": _clip(headline, HEADLINE_MAX), "body": _clip(body, BODY_MAX), "card": card,
        "truncated": truncated, "wrapped": wrapped,
    }


def clean_text(parsed: Mapping[str, Any]) -> str:
    """What a chat surface shows today: headline, then body; no card JSON."""
    headline = str(parsed.get("headline") or DEFAULT_HEADLINE)
    body = str(parsed.get("body") or "")
    return f"{headline}\n\n{body}" if body else headline


def task_job_id(metadata: Any) -> Optional[str]:
    """The cron job id a ``send()`` carries, or None for an ordinary send."""
    if not isinstance(metadata, Mapping):
        return None
    job_id = metadata.get("job_id")
    if job_id is None:
        return None
    job_id = str(job_id).strip()
    return job_id or None


# -- storage --------------------------------------------------------------------


class TaskResultStoreError(Exception):
    """The store could not be opened or written."""


@dataclass(frozen=True)
class TaskResult:
    id: str
    job_id: str
    job_name: Optional[str]
    status: str
    headline: str
    body: str
    card: Optional[Dict[str, Any]]
    error: Optional[str]
    truncated: bool
    created_at_ms: int
    acked_at_ms: Optional[int]
    #: When a chat send carried it (#5031); None while it waits for the pump.
    delivered_at_ms: Optional[int] = None
    #: The chat a standalone sender was asked to reach; None means home.
    chat_id: Optional[str] = None
    #: #5036: when the wearer acted on this reminder (Done, or Again in 30
    #: min); None while it waits. Acting on one acts on its job's older ones.
    done_at_ms: Optional[int] = None
    #: #5036: Again in 30 min: when it pops up once more. None when none waits.
    again_at_ms: Optional[int] = None

    @property
    def failed(self) -> bool:
        return self.status == STATUS_FAILED

    @property
    def acked(self) -> bool:
        return self.acked_at_ms is not None

    def to_wire(self) -> Dict[str, Any]:
        """camelCase shape for the relay and the phone."""
        return {
            "id": self.id, "jobId": self.job_id, "jobName": self.job_name, "status": self.status,
            "headline": self.headline, "body": self.body, "card": self.card, "error": self.error,
            "truncated": self.truncated, "createdAtMs": self.created_at_ms, "ackedAtMs": self.acked_at_ms,
        }


_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS task_result ("
    " seq INTEGER PRIMARY KEY AUTOINCREMENT,"
    " id TEXT NOT NULL UNIQUE,"
    " job_id TEXT NOT NULL,"
    " job_name TEXT,"
    " status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),"
    " headline TEXT NOT NULL,"
    " body TEXT NOT NULL,"
    " card TEXT,"
    " error TEXT,"
    " truncated INTEGER NOT NULL DEFAULT 0,"
    " created_at_ms INTEGER NOT NULL,"
    " acked_at_ms INTEGER,"
    " delivered_at_ms INTEGER,"
    " chat_id TEXT)",
    "CREATE INDEX IF NOT EXISTS task_result_job ON task_result (job_id, seq)",
    # A standalone delivery whose text names no job (#5031).
    "CREATE TABLE IF NOT EXISTS pending_message ("
    " seq INTEGER PRIMARY KEY AUTOINCREMENT,"
    " id TEXT NOT NULL UNIQUE,"
    " chat_id TEXT,"
    " text TEXT NOT NULL,"
    " created_at_ms INTEGER NOT NULL,"
    " delivered_at_ms INTEGER)",
)
#: Columns added after the first schema (#5031). A row from before them was
#: delivered by ``send()``, so it reads as delivered when it was made.
_ADDED_COLUMNS = (
    ("delivered_at_ms", "INTEGER", "UPDATE task_result SET delivered_at_ms = created_at_ms"),
    ("chat_id", "TEXT", None),
    # #5036: a reminder's Done and Again in 30 min.
    ("done_at_ms", "INTEGER", None),
    ("again_at_ms", "INTEGER", None),
)
_COLUMNS = ("id, job_id, job_name, status, headline, body, card, error, truncated, created_at_ms, acked_at_ms,"
            " delivered_at_ms, chat_id, done_at_ms, again_at_ms")
#: #5036: a reminder not acted on is "missed" after its pop-up window; rows
#: count the ones from the last 7 days (missed rows clear after 7 days).
UNDONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
#: One job lists at most this many reminders not acted on.
UNDONE_MAX = 50


@dataclass(frozen=True)
class PendingMessage:
    """A standalone delivery with no job id, for the home chat (#5031)."""
    id: str
    chat_id: Optional[str]
    text: str
    created_at_ms: int
    delivered_at_ms: Optional[int] = None


@dataclass(frozen=True)
class Outbound:
    """One undelivered entry, as the inbox pump sends it. ``job_id`` is set
    only for a Task result; a plain pending message has none."""
    id: str
    chat_id: Optional[str]
    text: str
    created_at_ms: int
    job_id: Optional[str] = None


def _row(row: tuple) -> TaskResult:
    card = None
    if row[6] is not None:
        try:
            card = json.loads(row[6])
        except ValueError:
            card = None
    return TaskResult(
        id=row[0], job_id=row[1], job_name=row[2], status=row[3], headline=row[4], body=row[5],
        card=card if isinstance(card, dict) else None, error=row[7], truncated=bool(row[8]),
        created_at_ms=int(row[9]), acked_at_ms=None if row[10] is None else int(row[10]),
        delivered_at_ms=None if row[11] is None else int(row[11]), chat_id=row[12],
        done_at_ms=None if row[13] is None else int(row[13]),
        again_at_ms=None if row[14] is None else int(row[14]),
    )


def _insert(conn: sqlite3.Connection, result: TaskResult) -> None:
    """Keep *result*, then trim to the last RECENT_LIMIT results plus each job's latest."""
    card = None if result.card is None else json.dumps(result.card, separators=(",", ":"))
    conn.execute(
        f"INSERT INTO task_result ({_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (result.id, result.job_id, result.job_name, result.status, result.headline, result.body,
         card, result.error, int(result.truncated), result.created_at_ms, result.acked_at_ms,
         result.delivered_at_ms, result.chat_id, result.done_at_ms, result.again_at_ms))
    conn.execute(
        "DELETE FROM task_result WHERE seq NOT IN"
        " (SELECT seq FROM task_result ORDER BY seq DESC LIMIT ?)"
        " AND seq NOT IN (SELECT MAX(seq) FROM task_result GROUP BY job_id"
        " ORDER BY MAX(seq) DESC LIMIT ?)",
        (RECENT_LIMIT, LATEST_JOBS_LIMIT))


def _missing_columns(conn: sqlite3.Connection) -> list:
    present = {row[1] for row in conn.execute("PRAGMA table_info(task_result)")}
    return [column for column in _ADDED_COLUMNS if column[0] not in present]


def _migrate(conn: sqlite3.Connection) -> None:
    if not _missing_columns(conn):
        return
    conn.execute("BEGIN IMMEDIATE")  # a second process may be migrating too
    try:
        for name, kind, backfill in _missing_columns(conn):
            conn.execute(f"ALTER TABLE task_result ADD COLUMN {name} {kind}")
            if backfill:
                conn.execute(backfill)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def default_store_path() -> Optional[Path]:
    """``<HERMES_HOME>/state/task_results.sqlite3`` via the plugin's receipt
    home (the gateway's process home), or None when it cannot be resolved."""
    try:
        from . import receipts
    except ImportError:
        return None
    directory = receipts.state_dir()
    return None if directory is None else directory / STORE_FILENAME


class TaskResultStore:
    """Task results in one SQLite file. Each call opens and closes its own
    connection, so a reopened store (a restarted gateway, another process)
    sees every committed result."""

    def __init__(self, path: Optional[Path] = None):
        resolved = Path(path) if path is not None else default_store_path()
        if resolved is None:
            raise TaskResultStoreError("no OcuClaw state directory")
        self.path = resolved

    def _connect(self) -> sqlite3.Connection:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            conn = sqlite3.connect(str(self.path), timeout=BUSY_TIMEOUT_SECONDS, isolation_level=None,
                                   check_same_thread=False)
        except (OSError, sqlite3.Error):
            raise TaskResultStoreError("store unavailable") from None
        try:
            conn.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_SECONDS * 1000)}")
            for statement in _SCHEMA:
                conn.execute(statement)
            _migrate(conn)
            if os.name == "posix":
                os.chmod(self.path, 0o600)
        except (OSError, sqlite3.Error):
            conn.close()
            raise TaskResultStoreError("store unavailable") from None
        return conn

    def _write(self, body):
        conn = self._connect()
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
            raise TaskResultStoreError("store unwritable") from None
        finally:
            conn.close()

    def _read(self, sql: str, params: tuple = ()) -> List[TaskResult]:
        conn = self._connect()
        try:
            return [_row(row) for row in conn.execute(sql, params).fetchall()]
        except sqlite3.Error:
            raise TaskResultStoreError("store unreadable") from None
        finally:
            conn.close()

    def record_result(self, job_id: Any, job_name: Any, raw_text: Any,
                      metadata: Optional[Mapping[str, Any]] = None, *,
                      now_ms: Optional[int] = None, delivered: bool = True,
                      chat_id: Any = None) -> TaskResult:
        """Parse one delivery and keep it. *job_id* wins over the wrapper's
        (pass None to read it from the wrapper); *job_name* likewise.
        *delivered* is False only when no chat send carries the result (a
        standalone sender); the inbox pump then sends it to *chat_id*."""
        given_name = (str(job_name).strip() or None) if job_name is not None else None
        parsed = parse_cron_delivery(raw_text, job_name=given_name)
        resolved_job = (str(job_id).strip() if job_id is not None else "") or parsed["job_id"]
        if not resolved_job:
            resolved_job = task_job_id(metadata) or ""
        if not resolved_job:
            raise ValueError("a task result needs a job id")
        name = given_name or parsed["job_name"]
        if parsed["failed"]:
            # A watched page that would not load fails with Hermes's model-timeout
            # copy; a failed model run on a changed page lost the change (#5039).
            from .task_page_watch import on_failed_run
            reason = on_failed_run(resolved_job)
            if reason:
                parsed = {**parsed, "error": _clip(reason, ERROR_MAX), "body": _sentence(reason)}
        created_at_ms = int(now_ms if now_ms is not None else time.time() * 1000)
        result = TaskResult(
            id=secrets.token_urlsafe(16), job_id=resolved_job, job_name=name or None,
            status=STATUS_FAILED if parsed["failed"] else STATUS_OK,
            headline=parsed["headline"], body=parsed["body"], card=parsed["card"],
            error=parsed["error"], truncated=bool(parsed["truncated"]),
            created_at_ms=created_at_ms, acked_at_ms=None,
            delivered_at_ms=created_at_ms if delivered else None, chat_id=_chat(chat_id),
        )
        self._write(lambda conn: _insert(conn, result))
        return result

    def get(self, result_id: str) -> Optional[TaskResult]:
        rows = self._read(f"SELECT {_COLUMNS} FROM task_result WHERE id = ?", (str(result_id),))
        return rows[0] if rows else None

    def ack(self, result_id: Any, *, now_ms: Optional[int] = None) -> bool:
        """Ack a result. True only for the call that acked it; a repeated or
        unknown id changes nothing and returns False."""
        stamp = int(now_ms if now_ms is not None else time.time() * 1000)

        def body(conn):
            return conn.execute(
                "UPDATE task_result SET acked_at_ms = ? WHERE id = ? AND acked_at_ms IS NULL",
                (stamp, str(result_id))).rowcount == 1

        return bool(self._write(body))

    def list_unacked(self) -> List[TaskResult]:
        """Unacked results, oldest first."""
        return self._read(f"SELECT {_COLUMNS} FROM task_result WHERE acked_at_ms IS NULL ORDER BY seq")

    def latest_per_job(self) -> List[TaskResult]:
        """Each job's newest result, newest first (what the glasses show)."""
        return self._read(
            f"SELECT {_COLUMNS} FROM task_result WHERE seq IN"
            " (SELECT MAX(seq) FROM task_result GROUP BY job_id) ORDER BY seq DESC")

    def latest_by_job(self) -> List[Tuple[Optional[TaskResult], Optional[TaskResult]]]:
        """#5033: each job's newest ``ok`` result and newest failed run, as
        ``(ok, failed)`` pairs, the job with the newest of either first (the
        glasses' Task rows). Either side is None when the job has none kept."""
        rows = self._read(
            f"SELECT {_COLUMNS} FROM task_result WHERE seq IN"
            " (SELECT MAX(seq) FROM task_result GROUP BY job_id, status) ORDER BY seq DESC")
        pairs: Dict[str, List[Optional[TaskResult]]] = {}
        for result in rows:
            pair = pairs.setdefault(result.job_id, [None, None])
            pair[1 if result.failed else 0] = result
        return [(pair[0], pair[1]) for pair in pairs.values()]

    def recent(self, limit: int = RECENT_LIMIT) -> List[TaskResult]:
        """The newest results, newest first (what the phone lists)."""
        limit = max(0, min(int(limit), RECENT_LIMIT))
        return self._read(f"SELECT {_COLUMNS} FROM task_result ORDER BY seq DESC LIMIT ?", (limit,))

    def recent_for_job(self, job_id: str, limit: int = RECENT_LIMIT) -> List[TaskResult]:
        """#5040: one job's newest results, newest first (a Task's page on the phone)."""
        limit = max(0, min(int(limit), RECENT_LIMIT))
        return self._read(f"SELECT {_COLUMNS} FROM task_result WHERE job_id = ? ORDER BY seq DESC LIMIT ?",
                          (str(job_id), limit))

    # -- reminders (#5036) and deleted Tasks ----------------------------------

    def act_on_reminder(self, result_id: Any, *, again_at_ms: Optional[int] = None,
                        now_ms: Optional[int] = None) -> Optional[TaskResult]:
        """The wearer acted on a reminder: Done, or Again in 30 min when
        *again_at_ms* is given. Marks it and its job's older ``ok`` results
        done and acked (they are dealt with), and for Again keeps when it pops
        up once more. Returns the result, or None for an unknown or failed one."""
        stamp = int(now_ms if now_ms is not None else time.time() * 1000)

        def body(conn):
            row = conn.execute("SELECT seq, job_id, status FROM task_result WHERE id = ?",
                               (str(result_id),)).fetchone()
            if row is None or row[2] != STATUS_OK:
                return False
            conn.execute(
                "UPDATE task_result SET done_at_ms = ?, acked_at_ms = COALESCE(acked_at_ms, ?)"
                " WHERE job_id = ? AND status = 'ok' AND seq <= ? AND done_at_ms IS NULL",
                (stamp, stamp, row[1], row[0]))
            # One Again waits per job: the newest choice wins.
            conn.execute("UPDATE task_result SET again_at_ms = NULL WHERE job_id = ?", (row[1],))
            if again_at_ms is not None:
                conn.execute("UPDATE task_result SET again_at_ms = ? WHERE id = ?",
                             (int(again_at_ms), str(result_id)))
            return True

        return self.get(str(result_id)) if self._write(body) else None

    def next_again_at(self) -> Optional[int]:
        """When the soonest Again in 30 min falls due, or None."""
        conn = self._connect()
        try:
            row = conn.execute("SELECT MIN(again_at_ms) FROM task_result WHERE again_at_ms IS NOT NULL").fetchone()
        except sqlite3.Error:
            raise TaskResultStoreError("store unreadable") from None
        finally:
            conn.close()
        return None if row is None or row[0] is None else int(row[0])

    def fire_agains(self, *, now_ms: Optional[int] = None) -> List[TaskResult]:
        """Each Again that is due pops up once more: a fresh, unacked copy of
        the reminder, made now (so the glasses treat it as new). The Again is
        then spent. Returns the copies, oldest first."""
        stamp = int(now_ms if now_ms is not None else time.time() * 1000)

        def body(conn):
            due = [_row(row) for row in conn.execute(
                f"SELECT {_COLUMNS} FROM task_result WHERE again_at_ms IS NOT NULL AND again_at_ms <= ?"
                " ORDER BY seq", (stamp,)).fetchall()]
            copies = []
            for original in due:
                conn.execute("UPDATE task_result SET again_at_ms = NULL WHERE id = ?", (original.id,))
                copy = TaskResult(
                    id=secrets.token_urlsafe(16), job_id=original.job_id, job_name=original.job_name,
                    status=original.status, headline=original.headline, body=original.body, card=original.card,
                    error=None, truncated=original.truncated, created_at_ms=stamp, acked_at_ms=None,
                    delivered_at_ms=stamp, chat_id=original.chat_id)
                _insert(conn, copy)
                copies.append(copy)
            return copies

        return list(self._write(body))

    def undone_by_job(self, *, now_ms: Optional[int] = None) -> Dict[str, List[int]]:
        """#5036: each job's ``ok`` results nobody acted on (Done or Again),
        from the last :data:`UNDONE_WINDOW_MS`, as their times, oldest first."""
        stamp = int(now_ms if now_ms is not None else time.time() * 1000)
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT job_id, created_at_ms FROM task_result WHERE status = 'ok' AND done_at_ms IS NULL"
                " AND created_at_ms >= ? ORDER BY seq", (stamp - UNDONE_WINDOW_MS,)).fetchall()
        except sqlite3.Error:
            raise TaskResultStoreError("store unreadable") from None
        finally:
            conn.close()
        out: Dict[str, List[int]] = {}
        for job_id, created_at_ms in rows:
            out.setdefault(job_id, []).append(int(created_at_ms))
        return {job_id: times[-UNDONE_MAX:] for job_id, times in out.items()}

    def drop_job(self, job_id: Any) -> int:
        """Forget every result of a job whose Task was deleted, so it never
        comes back as a "From Hermes" row. Returns how many went."""

        def body(conn):
            return conn.execute("DELETE FROM task_result WHERE job_id = ?", (str(job_id),)).rowcount

        return int(self._write(body) or 0)

    def move_job(self, old_job_id: Any, new_job_id: Any) -> Tuple[int, int]:
        """#6772: a Task's new job replaced *old_job_id*. Its results the app
        already received (acked) move to *new_job_id*, so the Task's Runs keep
        them; the rest go, as :meth:`drop_job` does, so a run of the old job is
        never pushed as the new one's. Returns ``(moved, dropped)``."""

        def body(conn):
            dropped = conn.execute("DELETE FROM task_result WHERE job_id = ? AND acked_at_ms IS NULL",
                                   (str(old_job_id),)).rowcount
            moved = conn.execute("UPDATE task_result SET job_id = ? WHERE job_id = ?",
                                 (str(new_job_id), str(old_job_id))).rowcount
            return moved, dropped

        result = self._write(body)
        return (int(result[0]), int(result[1])) if result else (0, 0)

    # -- standalone deliveries (#5031) ---------------------------------------

    def record_message(self, chat_id: Any, text: Any, *, now_ms: Optional[int] = None) -> PendingMessage:
        """Keep a plain, undelivered message (a standalone send with no job)."""
        message = PendingMessage(
            id=secrets.token_urlsafe(16), chat_id=_chat(chat_id), text=_clip(str(text or ""), BODY_MAX),
            created_at_ms=int(now_ms if now_ms is not None else time.time() * 1000))

        def body(conn):
            conn.execute(
                "INSERT INTO pending_message (id, chat_id, text, created_at_ms) VALUES (?, ?, ?, ?)",
                (message.id, message.chat_id, message.text, message.created_at_ms))
            conn.execute(
                "DELETE FROM pending_message WHERE seq NOT IN"
                " (SELECT seq FROM pending_message ORDER BY seq DESC LIMIT ?)", (RECENT_LIMIT,))

        self._write(body)
        return message

    def list_undelivered(self) -> List[Outbound]:
        """Results and messages no chat send has carried, oldest first, as
        the clean text to send."""
        conn = self._connect()
        try:
            results = conn.execute(
                "SELECT id, chat_id, headline, body, created_at_ms, seq, job_id FROM task_result"
                " WHERE delivered_at_ms IS NULL").fetchall()
            messages = conn.execute(
                "SELECT id, chat_id, text, created_at_ms, seq FROM pending_message"
                " WHERE delivered_at_ms IS NULL").fetchall()
        except sqlite3.Error:
            raise TaskResultStoreError("store unreadable") from None
        finally:
            conn.close()
        rows = [(row[4], 0, row[5], Outbound(row[0], row[1], clean_text({"headline": row[2], "body": row[3]}),
                                             int(row[4]), job_id=row[6])) for row in results]
        rows += [(row[3], 1, row[4], Outbound(row[0], row[1], row[2], int(row[3]))) for row in messages]
        return [entry for *_key, entry in sorted(rows, key=lambda row: row[:3])]

    def mark_delivered(self, entry_id: Any, *, now_ms: Optional[int] = None) -> bool:
        """Claim an entry for delivery. True only for the call that claimed it."""
        stamp = int(now_ms if now_ms is not None else time.time() * 1000)

        def body(conn):
            return sum(conn.execute(
                f"UPDATE {table} SET delivered_at_ms = ? WHERE id = ? AND delivered_at_ms IS NULL",
                (stamp, str(entry_id))).rowcount for table in ("task_result", "pending_message")) == 1

        return bool(self._write(body))

    def unmark_delivered(self, entry_id: Any) -> None:
        """Undo a claim whose send failed, so the next pump tick retries."""

        def body(conn):
            for table in ("task_result", "pending_message"):
                conn.execute(f"UPDATE {table} SET delivered_at_ms = NULL WHERE id = ?", (str(entry_id),))

        self._write(body)


def _chat(chat_id: Any) -> Optional[str]:
    return (str(chat_id).strip() or None) if chat_id is not None else None


# -- module-level API over the default store ----------------------------------


def record_result(job_id: Any, job_name: Any, raw_text: Any,
                  metadata: Optional[Mapping[str, Any]] = None) -> TaskResult:
    return TaskResultStore().record_result(job_id, job_name, raw_text, metadata)


def ack(result_id: Any) -> bool:
    return TaskResultStore().ack(result_id)


def list_unacked() -> List[TaskResult]:
    return TaskResultStore().list_unacked()


def latest_per_job() -> List[TaskResult]:
    return TaskResultStore().latest_per_job()


def recent(limit: int = RECENT_LIMIT) -> List[TaskResult]:
    return TaskResultStore().recent(limit)


def handle_send(content: Any, metadata: Mapping[str, Any],
                store: Optional[TaskResultStore] = None) -> str:
    """The adapter's cron-send hook: keep the result, return the clean text
    to deliver in its place. A store failure is logged, never raised, so the
    wearer still gets the text."""
    job_id = task_job_id(metadata)
    try:
        result = (store or TaskResultStore()).record_result(job_id, None, content, metadata)
    except (TaskResultStoreError, ValueError) as exc:
        logger.warning("[ocuclaw] task result for job %s not stored: %s", job_id, exc)
        return clean_text(parse_cron_delivery(content))
    logger.info("[ocuclaw] task result %s stored for job %s (%s)", result.id, result.job_id, result.status)
    return clean_text({"headline": result.headline, "body": result.body})
