"""What a Task's scheduled run took: its tokens, and its cost when Hermes says
it is real (#6638, R3 of #6546).

Ruled by Matt on 2026-11-05 ("Tokens always, dollars when real"). Hermes
0.22.5 admits each cron fire as an owner execution: request
``cron:<jobId>:<executionId>`` into a ``local-<hex>`` session (older Hermes
named the session ``cron_<jobId>_<YYYYmmdd>_<HHMMSS>``). That session's row in
``state.db`` holds the run's tokens and Hermes' own word on its money,
``cost_status``:

- ``actual``     the provider billed it (``actual_cost_usd``);
- ``estimated``  priced from a price list (``estimated_cost_usd``), shown as "about";
- ``included``   a subscription (a Codex or ChatGPT sign-in): no money per run. When
                 every row's ``billing_provider`` is a ChatGPT sign-in, the run names
                 its plan (``plan: "chatgpt"``, round 2: "In your ChatGPT plan");
- anything else  tokens only. A NULL cost is never read as $0.

A long run continues in compression children (``parent_session_id``, the
parent ended ``compression``); side calls inside the run (titles, compression,
OcuClaw's own aux calls) land in ``session_model_usage`` with ``task != ''``.
Main-task ledger rows duplicate the session counters, so only side rows add.

Read-only (``mode=ro``) with plain SQL and column checks: no private Hermes
import, and a Hermes with another schema reads as nothing. Node curates the
reply again (``curateRunUsage`` in ``domain/task-run-facts.ts``).
"""
from __future__ import annotations

import logging
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

#: The admissions principal of a cron fire (``session_rpc.CRON_OWNER_PRINCIPAL``).
CRON_OWNER_PRINCIPAL = "cron-owner"
#: A run's session starts before the job record says it ended; this much slack
#: covers Hermes' rounding of both stamps.
START_SLACK_MS = 5_000
#: A lineage longer than this is a broken store, not a run.
LINEAGE_MAX = 100
#: Read usage stays the same for an ended run; this many are remembered.
CACHE_MAX = 256
TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
PRICED = ("actual", "estimated")
#: The billing providers whose sign-in is a ChatGPT plan (a Codex sign-in is one).
CHATGPT_PROVIDERS = frozenset({"openai-codex"})

_cache: Dict[Tuple[str, str, int], Dict[str, Any]] = {}


def _home(home: Any) -> Optional[Path]:
    if home is not None:
        return Path(home)
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - no Hermes home, no usage
        return None


def _columns(conn: sqlite3.Connection, table: str) -> set:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _money(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value >= 0 else None


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _run_root(conn: sqlite3.Connection, job_id: str, ended_ms: int) -> Optional[str]:
    """The session the job's newest run ending at ``ended_ms`` started in."""
    like = _escape_like(job_id)
    candidates: List[str] = []
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_admissions'").fetchone():
        candidates += [row[0] for row in conn.execute(
            "SELECT target_session_id FROM session_admissions WHERE principal_id = ? AND request_id LIKE ? ESCAPE '\\'"
            " ORDER BY seq DESC LIMIT 20", (CRON_OWNER_PRINCIPAL, f"cron:{like}:%")).fetchall()
            if isinstance(row[0], str)]
    candidates += [row[0] for row in conn.execute(
        "SELECT id FROM sessions WHERE source = 'cron' AND id LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 20",
        (f"cron\\_{like}\\_%",)).fetchall()]
    best: Optional[Tuple[float, str]] = None
    for sid in dict.fromkeys(candidates):
        row = conn.execute("SELECT started_at FROM sessions WHERE id = ?", (sid,)).fetchone()
        started = row[0] if row else None
        if not isinstance(started, (int, float)) or started * 1000 > ended_ms + START_SLACK_MS:
            continue
        if best is None or started > best[0]:
            best = (started, sid)
    return best[1] if best else None


def _lineage(conn: sqlite3.Connection, root: str) -> List[str]:
    lineage = [root]
    while len(lineage) < LINEAGE_MAX:
        children = [row[0] for row in conn.execute(
            "SELECT c.id FROM sessions c JOIN sessions p ON p.id = c.parent_session_id"
            " WHERE c.parent_session_id = ? AND p.end_reason = 'compression'", (lineage[-1],)).fetchall()]
        if len(children) != 1:
            break
        lineage.append(children[0])
    return lineage


def combine(rows: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """One run's usage from its ledger rows (sessions and side calls), each with
    the token fields, ``cost_status``, ``actual_cost_usd`` and ``estimated_cost_usd``.

    Any row with no money word makes the run tokens only, since its dollars are
    not known. Rows all ``included`` are included. Otherwise the run is priced:
    ``estimated`` when any row is, else ``actual``; included rows add $0."""
    rows = list(rows)
    if not rows:
        return None
    tokens = sum(_count(row.get(field)) for row in rows for field in TOKEN_FIELDS)
    statuses = [row.get("cost_status") if row.get("cost_status") in (*PRICED, "included") else "unknown" for row in rows]
    usd = 0.0
    for row, status in zip(rows, statuses):
        if status == "actual":
            amount = _money(row.get("actual_cost_usd"))
        elif status == "estimated":
            amount = _money(row.get("estimated_cost_usd"))
        else:
            continue
        if amount is None:
            statuses = ["unknown"]
            break
        usd += amount
    if "unknown" in statuses:
        return {"tokens": tokens, "cost": "unknown", "usd": None}
    if all(status == "included" for status in statuses):
        included: Dict[str, Any] = {"tokens": tokens, "cost": "included", "usd": None}
        if all(row.get("billing_provider") in CHATGPT_PROVIDERS for row in rows):
            included["plan"] = "chatgpt"
        return included
    cost = "estimated" if "estimated" in statuses else "actual"
    return {"tokens": tokens, "cost": cost, "usd": round(usd, 6)}


def read_run_usage(conn: sqlite3.Connection, job_id: str, ended_ms: int) -> Optional[Dict[str, Any]]:
    """The usage of ``job_id``'s run that ended at ``ended_ms``, or None."""
    session_cols = _columns(conn, "sessions")
    needed = {"id", "started_at", "parent_session_id", "end_reason", "cost_status", "actual_cost_usd",
              "estimated_cost_usd", *TOKEN_FIELDS}
    if not needed <= session_cols:
        return None
    root = _run_root(conn, job_id, ended_ms)
    if root is None:
        return None
    lineage = _lineage(conn, root)
    money = (*TOKEN_FIELDS, "cost_status", "actual_cost_usd", "estimated_cost_usd")
    # The provider names the plan; a Hermes without the column reads as no plan named.
    fields = ", ".join((*money, "billing_provider") if "billing_provider" in session_cols else money)
    marks = ",".join("?" * len(lineage))
    conn.row_factory = sqlite3.Row
    rows = [dict(row) for row in conn.execute(f"SELECT {fields} FROM sessions WHERE id IN ({marks})", lineage)]
    side_cols = _columns(conn, "session_model_usage") if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_model_usage'").fetchone() else set()
    if {"session_id", "task", "cost_status", "actual_cost_usd", "estimated_cost_usd", *TOKEN_FIELDS} <= side_cols:
        side = ", ".join((*money, "billing_provider") if "billing_provider" in side_cols else money)
        rows += [dict(row) for row in conn.execute(
            f"SELECT {side} FROM session_model_usage WHERE session_id IN ({marks}) AND task != ''", lineage)]
    return combine(rows)


def run_usage(job_id: str, ended_ms: int, *, home: Any = None) -> Optional[Dict[str, Any]]:
    """What ``job_id``'s run that ended at ``ended_ms`` took, or None when
    Hermes cannot say. Never raises."""
    if not isinstance(job_id, str) or not job_id or not isinstance(ended_ms, int):
        return None
    base = _home(home)
    if base is None:
        return None
    key = (str(base), job_id, ended_ms)
    if key in _cache:
        return dict(_cache[key])
    path = base / "state.db"
    try:
        if not path.is_file():
            return None
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.25)) as conn:
            usage = read_run_usage(conn, job_id, ended_ms)
    except Exception as exc:  # noqa: BLE001 - usage never breaks the rows
        logger.debug("[ocuclaw] task run usage unreadable: %s", exc)
        return None
    if usage is None:
        return None
    _cache[key] = usage
    while len(_cache) > CACHE_MAX:
        _cache.pop(next(iter(_cache)))
    return dict(usage)
