"""Hermes Board reads (#3028), the watch write (#3050, OcuClaw's own store
in ``board_watch``) and the moment policy (#3053, the same store, in
``board_moments``); contract in docs/hermes-board/contract.md.

Stock only: read-only SQLite and board.json, never ``kanban_db_connect.connect()``
(it creates and migrates), never ``HERMES_KANBAN_DB`` / ``HERMES_KANBAN_BOARD``,
never the active profile's home as the board root. No path, SQL or native
exception text reaches the phone.
"""
import base64
from functools import lru_cache
import hashlib
import hmac
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import secrets
import sqlite3

logger = logging.getLogger(__name__)

OPERATIONS = {"board.status", "board.boards", "board.lanes", "board.cards", "board.card", "board.timeline",
              "board.watch", "board.policy", "board.policy.set", "board.create", "board.receipt",
              "board.verdict", "board.comment", "board.tools.enable", "board.decompose", "board.action",
              "board.maintenance", "board.export", "board.export.part", "board.artifact", "board.artifact.part"}
#: #3050: ``board.watch`` writes OcuClaw's own store only. #3053:
#: ``board.policy.set`` (the moment policy) does too. #3055: ``board.create``
#: is the first native write (``board_create``); ``board.receipt`` looks up its
#: OcuClaw receipt and never writes Hermes. #3056: ``board.verdict`` is Approve
#: or Request changes, bound to the review the wearer saw (``board_review``);
#: a verdict's ``board.receipt`` may hand back that op's own still-held claim.
#: #3060: ``board.decompose`` splits a triage card with stock
#: ``decompose_task`` (``board_decompose``).
#: #3058: ``board.comment`` adds a note without changing state, at most once
#: (``board_comment``).
#: #3059: ``board.action`` is the card sheet's More menu (Reassign, Set model,
#: Retry, Archive; ``board_actions``).
#: #3061: ``board.tools.enable`` runs the wearer's own
#: ``hermes tools enable kanban --platform ocuclaw`` after the phone's
#: confirmation (``board_tools``).
#: #3063: Settings › Board › Maintenance (``board_maintenance``):
#: ``board.maintenance`` reads diagnostics and stale claims; ``board.export``
#: writes an archive to OcuClaw's own temp area and ``board.export.part``
#: hands it over once and deletes it. Its per-card reclaim is a ``board.action``.
#: #3044: ``board.artifact`` and ``board.artifact.part`` open one card artifact
#: (``board_artifacts``). They are reads: the copy lands in OcuClaw's own temp
#: area, like an export's archive, and Hermes is never written.
WRITES = {"board.watch", "board.policy.set", "board.create", "board.verdict", "board.comment",
          "board.tools.enable", "board.decompose", "board.action", "board.export", "board.export.part"}
#: #3053: the moment policy's read and write, profile-scoped, no board.
POLICY_OPERATIONS = {"board.policy", "board.policy.set"}
READS = OPERATIONS - WRITES
#: Operations that name one board (#3043) or one card on it (#3044, #3050), or
#: carry an operation key (#3055).
TARGETED = {"board.lanes", "board.cards", "board.card", "board.timeline", "board.watch", "board.create",
            "board.receipt", "board.verdict", "board.comment", "board.decompose", "board.action",
            "board.maintenance", "board.export", "board.export.part", "board.artifact", "board.artifact.part"}
#: #3063: the maintenance section's own operations, worded for it.
MAINTENANCE_OPERATIONS = {"board.maintenance", "board.export", "board.export.part"}
#: #3044: opening a card artifact, worded for it.
ARTIFACT_OPERATIONS = {"board.artifact", "board.artifact.part"}
CARD_OPERATIONS = {"board.card", "board.timeline", "board.watch"}
#: #3055: the operations whose refusals are worded for a new card.
CREATE_OPERATIONS = {"board.create", "board.receipt"}
#: #3060: the operation whose refusals are worded for a split.
DECOMPOSE_OPERATIONS = {"board.decompose"}
#: Writes whose failure after the receipt may have reached Hermes: never a guess.
UNCERTAIN_WRITES = {"board.create", "board.verdict", "board.comment", "board.decompose", "board.action"}

#: Every Board capability key, in report order. Later tickets flip their own
#: key; none may add a key without updating the contract.
CAPABILITY_KEYS = (
    "browse", "passive_moments", "wake", "agent_tools", "create", "comment",
    "approve", "request_changes", "answer_and_unblock", "make_ready", "reassign",
    "set_model", "retry", "archive", "dependencies", "watch", "maintenance", "artifact_open",
)

#: The ticket that will enable each key that is still off.
DEFERRED_OWNERS = {
    "dependencies": 3060,
}
#: #3058: keys no engine supports safely, whatever its certification. Answer-and-
#: unblock needs one guarded native operation (the expected question, and the
#: comment plus the unblock as one idempotent step) that no pin has (P0.1
#: #3040: deferred to an upstream guard). So it reports ``unsupported`` with no
#: owner, and there is no documented-race exception.
#: #3064: ``wake`` too. No typed Board identity reaches the adapter on any pin
#: (P0.1 #3041), so an automatic wake could not be told from other internal
#: messages. There is no fallback wake; Notify + wake stays off on every engine.
UNSUPPORTED_KEYS = ("answer_and_unblock", "wake")
#: Keys a certified or compatible engine enables. ``watch`` (#3050) needs no native write:
#: it is an OcuClaw preference, so it follows certification like ``browse``.
#: ``passive_moments`` (#3051) reads ``task_events`` read-only and keeps its
#: delivery state in OcuClaw's store, so it follows certification too.
#: ``create`` (#3055) is the pinned engines' own ``create_task`` under an outer
#: ``write_txn``, bound by an OcuClaw receipt; its contract suite runs on both pins.
#: ``approve`` and ``request_changes`` (#3056) are the #3039 claim-then-inspect
#: composition of stock calls, bound by an OcuClaw receipt; proven on both pins.
#: ``dependencies`` (#3060) is stock ``create_task(parents=)`` and stock
#: ``decompose_task``, both present on both pins, with the same receipts.
#: ``comment`` (#3058) is stock ``add_comment`` at most once: an OcuClaw receipt
#: with a comment watermark, never resent (the form #3040 enabled on both pins).
#: ``reassign``, ``set_model``, ``retry`` and ``archive`` (#3059) are each one
#: stock call behind its own state guard and an OcuClaw receipt; each has its
#: own contract tests on both pins and none follows another key.
#: ``make_ready`` (#3707) is the same shape: stock ``specify_triage_task`` (no
#: fields), triage only, present on every pin (0.21.1 .. 0.21.5).
#: ``maintenance`` (#3063) opens Settings › Board › Maintenance; each of its
#: actions (diagnostics, export, reclaim) has its own gate under it
#: (``board_maintenance.gates``) and its own contract tests on both pins.
#: ``artifact_open`` (#3044) is a read: one card artifact, checked like stock's
#: dashboard download (the row belongs to the card, the file resolves under
#: stock ``attachments_root(board)``), copied to OcuClaw's own temp area and
#: handed over in parts. It is on only while that stock helper takes a board
#: (``board_artifacts.supported``); its contract tests run on every pin.
CERTIFIED_KEYS = ("browse", "passive_moments", "create", "comment", "approve", "request_changes",
                  "make_ready", "reassign", "set_model", "retry", "archive", "watch", "dependencies", "maintenance",
                  "artifact_open")

#: Board certification is a fact about installed code, not a version label:
#: SHA-256 over FINGERPRINT_SOURCES (concatenated in order) for each pinned
#: engine. A 0.21.x patch whose kanban store sources differ is not certified
#: until its fingerprint is recorded here; it may still be ``compatible``
#: (ENABLED_TIERS, the structural probe below).
FINGERPRINT_SOURCES = ("hermes_cli.kanban_db", "hermes_cli.kanban_db_connect")
CERTIFIED_ENGINES = {
    "0.21.1": {
        "tag": "v2026.9.7", "commit": "2237be355906fbe6065ce1815711eee52b2d646e",
        "fingerprint": "032fd4ed741b6f6b5fef011c3e173673ff816b299a0ddd4a1dc104dbf8f6e609",
    },
    "0.21.3": {
        "tag": "v2026.9.14", "commit": "345cd2b057a452236de401d3534b8502a7465e8d",
        "fingerprint": "437a086dbc4dac306b2f38f40cf3fbfd237c3ab94d80b1e9f47bd605abcfb50c",
    },
    # Certified after the #3049 proof (Matt, 2026-09-24): its kanban store adds
    # lenient decoding, archived-parent-counts-as-done and a delegated fence, and
    # none of them changes what Board reads. The deferred actions stay deferred.
    "0.21.4": {
        "tag": "v2026.9.21", "commit": "d337b736aa1e8ebecfab043842d13e4a2d2f48a3",
        "fingerprint": "a6add6f8aa374198bc06e26df9c2e468c3a3bf44c9e2451a1ed1546160a097ce",
    },
    # Certified by Matt (2026-09-24): its kanban store differs from 0.21.4 only
    # in a gc retention guard (a negative window now raises). Board never calls
    # gc, and every kanban call Board makes is byte-identical to 0.21.4.
    "0.21.5": {
        "tag": "v2026.9.24", "commit": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
        "fingerprint": "6c51376e70700941522441dd66399f80b3a61812bf34d35d89028bf4065c96cb",
    },
}

#: The columns Board reads (a subset: extra native columns are fine).
REQUIRED_COLUMNS = {
    "tasks": {"id", "title", "body", "assignee", "status", "priority", "created_at",
              "completed_at", "block_kind", "current_run_id"},
    "task_links": {"parent_id", "child_id"},
    "task_comments": {"id", "task_id", "author", "body", "created_at"},
    "task_events": {"id", "task_id", "run_id", "kind", "payload", "created_at"},
    "task_runs": {"id", "task_id", "profile", "status", "outcome", "summary",
                  "started_at", "ended_at"},
}

#: The fallback tier (Matty, 2026-09-25: Board must not turn itself off just
#: because a new Hermes came out that it does not recognise). A build whose
#: kanban sources match no certified fingerprint is ``compatible`` when both
#: hold, and then enables exactly what a certified engine enables:
#:
#: 1. its version is inside the adapter's own support range
#:    (``health.hermes_version_supported``: 0.21.1 <= v < 0.22.0). The same
#:    gate starts the adapter, so a build outside it (an unstamped Hermes
#:    checkout reports ``0.0.0``) never reaches Board at all;
#: 2. the structural probe passes: every stock name Board calls exists and
#:    ``inspect.signature(...).bind`` accepts the arguments Board passes
#:    (COMPATIBLE_CALLS), each constant has its type (COMPATIBLE_CONSTANTS),
#:    the claim Board reads back carries ``current_run_id``, and the schema
#:    this engine's own ``connect()`` would leave (built in memory, nothing on
#:    disk) has every column Board reads or its write guards check
#:    (REQUIRED_COLUMNS + GUARD_COLUMNS) with ``task_events`` ids never reused
#:    (AUTOINCREMENT: the fence every stale check compares).
#:
#: Nothing is patched and nothing is written. Every write keeps its own
#: guards on either tier: the store check, the anchor, the receipt and the
#: fence bind it to what the wearer saw. A failed probe stays ``uncertified``
#: with a short ``reason`` (a closed token plus a stock name; never a path).
ENABLED_TIERS = ("certified", "compatible")
#: A placeholder argument: ``bind`` checks the call's shape, never a value.
_ARG = object()
#: ``(module, name, args, kwargs)``: each stock call Board makes, as it makes it.
#: Some names appear twice because Board calls them two ways.
COMPATIBLE_CALLS = (
    # Reads and the store's location (board_management, board_create, board_maintenance).
    ("hermes_cli.kanban_db", "kanban_home", (), {}),
    ("hermes_cli.kanban_db", "kanban_db_path", (), {}),
    ("hermes_cli.kanban_db", "kanban_db_path", (_ARG,), {}),
    ("hermes_cli.kanban_db", "board_exists", (_ARG,), {}),
    ("hermes_cli.kanban_db", "redact_review_value", (_ARG,), {}),
    # Create (#3055) and dependencies (#3060).
    ("hermes_cli.kanban_db", "create_task", (_ARG,), dict.fromkeys((
        "title", "body", "assignee", "created_by", "workspace_kind", "project_id", "priority",
        "parents", "triage", "idempotency_key", "initial_status", "board"), _ARG)),
    ("hermes_cli.kanban_db", "scoped_current_board", (_ARG,), {}),
    ("hermes_cli.kanban_decompose", "decompose_task", (_ARG,), {"author": _ARG, "timeout": _ARG}),
    # Verdicts (#3056): claim, inspect, decide, release.
    ("hermes_cli.kanban_db", "claim_review_task", (_ARG, _ARG), {"ttl_seconds": _ARG, "claimer": _ARG}),
    ("hermes_cli.kanban_db", "heartbeat_claim", (_ARG, _ARG), {"ttl_seconds": _ARG, "claimer": _ARG}),
    ("hermes_cli.kanban_db", "reclaim_task", (_ARG, _ARG), {"reason": _ARG}),
    ("hermes_cli.kanban_db", "complete_task", (_ARG, _ARG), {"expected_run_id": _ARG, "result": _ARG}),
    ("hermes_cli.kanban_db", "request_changes", (_ARG, _ARG), {"reason": _ARG, "expected_run_id": _ARG}),
    # Comment (#3058).
    ("hermes_cli.kanban_db", "add_comment", (_ARG, _ARG, _ARG, _ARG), {}),
    # Card actions (#3059, #3707) and reclaim (#3063).
    ("hermes_cli.kanban_db", "specify_triage_task", (_ARG, _ARG), {"author": None}),
    ("hermes_cli.kanban_db", "reassign_task", (_ARG, _ARG, _ARG), {}),
    ("hermes_cli.kanban_db", "set_model_override", (_ARG, _ARG, _ARG, _ARG), {}),
    ("hermes_cli.kanban_db", "archive_task", (_ARG, _ARG), {}),
    ("hermes_cli.kanban_db", "unblock_task", (_ARG, _ARG), {}),
    ("hermes_cli.kanban_db", "promote_task", (_ARG, _ARG), {"actor": _ARG, "reason": _ARG}),
    # The connection and the store check (board_create.check_writable).
    ("hermes_cli.kanban_db_connect", "connect", (), {"db_path": _ARG}),
    ("hermes_cli.kanban_db_connect", "write_txn", (_ARG,), {}),
    ("hermes_cli.kanban_db_connect", "_migrate_add_optional_columns", (_ARG,), {}),
)
#: ``(module, name, type)``: the stock constants Board reads.
COMPATIBLE_CONSTANTS = (
    ("hermes_cli.kanban_db", "SCHEMA_SQL", str),
    ("hermes_cli.kanban_db", "DEFAULT_CLAIM_HEARTBEAT_MAX_STALE_SECONDS", (int, float)),
)
#: Columns Board's write guards and stale checks read beyond REQUIRED_COLUMNS:
#: the claim (#3056, #3063) and the create receipt's idempotency key (#3055).
GUARD_COLUMNS = {
    "tasks": {"claim_lock", "claim_expires", "last_heartbeat_at", "idempotency_key"},
}

DEFAULT_BOARD = "default"
MAX_BOARDS = 64
BUSY_TIMEOUT_SECONDS = 0.5
_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

#: Native statuses in lane order (#3043). Others in the store follow, sorted.
LANE_ORDER = ("triage", "todo", "scheduled", "ready", "running", "blocked",
              "review", "done", "archived")
RUN_OUTCOMES = {"completed", "blocked", "crashed", "timed_out", "spawn_failed",
                "gave_up", "reclaimed"}
PAGE_DEFAULT = 25
PAGE_MAX = 50
CURSOR_MAX = 512
_STATUS = re.compile(r"^[a-z][a-z_]{0,31}$")
_NEEDS_YOU = "(t.status = 'review' OR (t.status = 'blocked' AND t.block_kind = 'needs_input'))"
#: The latest finished run's outcome, as a card row reads it.
_LATEST_OUTCOME = ("(SELECT r.outcome FROM task_runs r WHERE r.task_id = t.id AND r.outcome IS NOT NULL"
                   " ORDER BY r.id DESC LIMIT 1)")
#: #3599: open cards whose latest finished run failed. A later success clears it.
FAILED_OUTCOMES = ("crashed", "timed_out", "spawn_failed", "gave_up")
_FAILED = (f"(t.status NOT IN ('done', 'archived') AND {_LATEST_OUTCOME}"
           f" IN ({', '.join(repr(o) for o in FAILED_OUTCOMES)}))")
#: Signs cursors; a gateway restart makes every older cursor expired_request.
_CURSOR_KEY = secrets.token_bytes(32)

#: Card detail (#3044). Hermes ids are ``t_`` + hex; the pattern leaves room
#: for other id shapes without admitting paths or spaces.
_CARD_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_ANCHOR = re.compile(r"^[A-Za-z0-9_-]{16}$")
_CONTENT_TYPE = re.compile(r"^[a-z]+/[a-z0-9.+-]{1,60}$")
TIMELINE_DEFAULT = 20
TIMELINE_MAX = 50
BRIEF_MAX = 4000
PROSE_MAX = 1000
COMMENT_MAX = 2000
RELATED_MAX = 20
ARTIFACT_NAME_MAX = 120
#: Comment/event pairing scans at most this many rows per card; beyond it a
#: ``commented`` entry carries its author only.
PAIRING_MAX = 5000
#: Redaction runs on at most this much of one text cell.
_REDACT_WINDOW = 256 * 1024
#: The one payload key each timeline kind may show, all through redaction.
#: Every other kind shows its name and time only (no error text, no paths).
TIMELINE_TEXT = {"blocked": "reason", "changes_requested": "reason",
                 "review_requested": "summary", "completed": "summary",
                 # #3058: the loop breaker's block keeps its reason, like any block.
                 "block_loop_detected": "reason"}

MESSAGES = {
    "invalid_request": "This Board request is not valid.",
    "invalid_target": "That board is not available.",
    "stale_scope": "This list belongs to another profile. Start it again.",
    "stale_target": "This board was replaced. Start the list again.",
    "expired_request": "This list expired. Start it again.",
    "uncertified": "Board isn't available on this Hermes version yet.",
    "store_missing": "This Hermes has no kanban board store yet.",
    "schema_unsupported": "This Hermes board store's format isn't supported.",
    "temporarily_unavailable": "The board store is busy or unreadable. Try again shortly.",
    "native_read_failed": "Hermes could not read its boards. Check the native gateway.",
}

#: The same codes as MESSAGES, worded for a card read (#3044).
CARD_MESSAGES = {
    "invalid_target": "That card is no longer available.",
    "stale_target": "This board was replaced. Open the card again.",
    "stale_scope": "This card belongs to another profile. Open it again.",
    "expired_request": "This timeline expired. Open the card again.",
}

#: #3050: the same codes, worded for a watch change.
WATCH_MESSAGES = {
    "temporarily_unavailable": "Board couldn't save this watch. Try again shortly.",
    "deferred": "Notify + wake isn't available yet.",
    # #3064: its own code, since the phone withdraws Board on `unsupported`.
    "wake_unsupported": "Notify + wake isn't supported by this Hermes.",
}

#: #3053: the same codes, worded for the moment policy.
POLICY_MESSAGES = {
    "temporarily_unavailable": "Board couldn't reach your moment settings. Try again shortly.",
    "invalid_request": "Board can't use these moment settings. Check the times and time zone.",
}

#: #3055: the same codes, worded for a new card and its receipt.
CREATE_MESSAGES = {
    "invalid_request": "Hermes couldn't take this card. Check its title and worker.",
    "stale_target": "The board changed since this card was started. Refresh and try again.",
    "stale_scope": "This card was started for another profile.",
    "expired_request": "Hermes didn't save this card. Start it again.",
    "outcome_unknown": "Hermes can't tell whether this card was saved. Check the board before trying again.",
    "operation_conflict": "This request was already used for a different card. Start again.",
    "temporarily_unavailable": "Board couldn't save this card. Try again shortly.",
    "deferred": "Creating cards isn't available on this Hermes yet.",
}

#: #3060: the same codes, worded for splitting a card.
DECOMPOSE_MESSAGES = {
    "invalid_request": "Hermes couldn't split this card.",
    "invalid_target": "That card is no longer on this board.",
    "stale_target": "This card has left triage, so it can't be split now.",
    "stale_scope": "This split was started for another profile.",
    "expired_request": "Hermes didn't split this card. Try again.",
    "outcome_unknown": "Hermes can't tell whether this card was split. Check the board before trying again.",
    "operation_conflict": "This request was already used for a different card. Start again.",
    "temporarily_unavailable": "Hermes couldn't split this card right now. Try again shortly.",
    "not_configured": "Hermes isn't set up to split cards. Set a decomposer model in Hermes.",
    "deferred": "Splitting cards isn't available on this Hermes yet.",
}

#: #3059: the same codes, worded for a card action (Reassign, Set model, Retry, Archive).
ACTION_MESSAGES = {
    "invalid_request": "Hermes couldn't make this change. Check the card and try again.",
    "invalid_target": "That card is no longer available.",
    "stale_target": "This card changed since you opened it. Look again before changing it.",
    "stale_scope": "This change was started for another profile.",
    "expired_request": "Hermes didn't make this change. Try again.",
    "outcome_unknown": "Hermes can't tell whether this change was made. Check the card before trying again.",
    "operation_conflict": "This request was already used for a different change. Start again.",
    "temporarily_unavailable": "Board couldn't make this change. Try again shortly.",
    "deferred": "This action isn't available on this Hermes yet.",
}
#: #3063: the same codes, worded for Settings › Board › Maintenance (its
#: diagnostics and export; a reclaim is a card action and worded as one).
MAINTENANCE_MESSAGES = {
    "invalid_request": "Board couldn't take this maintenance request.",
    "invalid_target": "That board is not available for maintenance.",
    "stale_target": "This board was replaced. Open Maintenance again.",
    "stale_scope": "This export was started for another profile.",
    "expired_request": "This export is no longer available. Export the board again.",
    "too_large": "This board's export is too large to send to the phone.",
    "temporarily_unavailable": "Board couldn't finish this. Try again shortly.",
    "unsupported": "This maintenance action isn't available on this Hermes.",
    "deferred": "Maintenance isn't available on this Hermes yet.",
}
#: #3044: the same codes, worded for opening a card artifact. Its own
#: ``artifact_unsupported`` refuses while ``artifact_open`` is off: the phone
#: withdraws Board on ``unsupported``.
ARTIFACT_MESSAGES = {
    "invalid_request": "Board couldn't open this artifact.",
    "invalid_target": "This artifact is no longer available.",
    "stale_target": "This board was replaced. Open the card again.",
    "stale_scope": "This artifact was opened for another profile. Open it again.",
    "expired_request": "This artifact is no longer ready. Open it again.",
    "too_large": "This artifact is too large to open on the phone.",
    "temporarily_unavailable": "Board couldn't open this artifact. Try again shortly.",
    "artifact_unsupported": "Opening artifacts isn't supported by this Hermes.",
}
#: #3056: the same codes, worded for a verdict on a review.
VERDICT_MESSAGES = {
    "invalid_request": "Hermes couldn't take this decision.",
    "invalid_target": "That card is no longer available.",
    "stale_target": "This review changed since you opened it. Look again before deciding.",
    "stale_scope": "This decision was started for another profile.",
    "expired_request": "Hermes didn't record this decision. Decide again.",
    "outcome_unknown": "Hermes can't tell whether your decision was recorded. Check the card before deciding again.",
    "operation_conflict": "This request was already used for a different decision. Decide again.",
    "temporarily_unavailable": "Board couldn't record this decision. Try again shortly.",
    "deferred": "Decisions aren't available on this Hermes yet.",
}

#: #3058: the same codes, worded for a comment on a card.
COMMENT_MESSAGES = {
    "invalid_request": "Hermes couldn't take this comment. Check its text.",
    "invalid_target": "That card is no longer available.",
    "stale_target": "This board was replaced. Open the card again before commenting.",
    "stale_scope": "This comment was started for another profile.",
    "expired_request": "Hermes didn't add this comment. You can send it again.",
    "outcome_unknown": "Hermes can't tell whether your comment was added. Check the timeline before sending it again.",
    "operation_conflict": "This request was already used for something else. Send the comment again.",
    "temporarily_unavailable": "Board couldn't add this comment. Try again shortly.",
    "deferred": "Comments aren't available on this Hermes yet.",
}


class BoardReadError(Exception):
    """A curated refusal; ``code`` is one of the contract's closed codes."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# --------------------------------------------------------------------------
# Engine identity and capabilities
# --------------------------------------------------------------------------

def _source_fingerprint():
    digest = hashlib.sha256()
    for module in FINGERPRINT_SOURCES:
        spec = importlib.util.find_spec(module)
        if spec is None or not spec.origin:
            return None
        digest.update(Path(spec.origin).read_bytes())
    return digest.hexdigest()


def _short(module: str) -> str:
    return module.rsplit(".", 1)[-1]


def compatibility_problem(version: str):
    """None when an engine with no certified fingerprint may still run Board
    (the ``compatible`` tier, see ENABLED_TIERS), else a short reason token.
    Reads code and an in-memory schema only; never touches a store on disk."""
    import inspect
    from importlib import import_module
    from .health import hermes_version_supported
    if not hermes_version_supported(version):
        return "version_out_of_range"
    for module, name, args, kwargs in COMPATIBLE_CALLS:
        try:
            fn = getattr(import_module(module), name)
        except (ImportError, AttributeError):
            return f"missing:{_short(module)}.{name}"
        try:
            inspect.signature(fn).bind(*args, **kwargs)
        except (TypeError, ValueError):
            return f"signature:{_short(module)}.{name}"
    for module, name, kind in COMPATIBLE_CONSTANTS:
        try:
            value = getattr(import_module(module), name)
        except (ImportError, AttributeError):
            return f"missing:{_short(module)}.{name}"
        if isinstance(value, bool) or not isinstance(value, kind):
            return f"type:{_short(module)}.{name}"
    # The verdict reads the claim's run back (board_review._decide).
    task = getattr(import_module("hermes_cli.kanban_db"), "Task", None)
    if task is None or "current_run_id" not in getattr(task, "__dataclass_fields__", {}):
        return "missing:kanban_db.Task.current_run_id"
    from . import board_create
    tables, _indexes, fence = board_create.engine_schema_facts()
    for table, columns in (*REQUIRED_COLUMNS.items(), *GUARD_COLUMNS.items()):
        missing = sorted(columns - set(tables.get(table) or ()))
        if missing:
            return f"schema:{table}.{missing[0]}"
    if not fence:
        return "schema:task_events.autoincrement"
    return None


@lru_cache(maxsize=1)
def engine_identity() -> dict:
    """``{version, certification, pin?, reason?}``; cached per process (code is
    fixed for the life of the gateway). ``certified`` when the kanban sources
    match a pinned fingerprint and its version; else ``compatible`` when
    ``compatibility_problem`` finds nothing; else ``uncertified`` with that
    problem as ``reason``."""
    from .health import hermes_version
    version = hermes_version()
    try:
        fingerprint = _source_fingerprint()
    except (OSError, ImportError, ValueError):
        fingerprint = None
    version = "".join(c for c in str(version or "") if c.isprintable())[:32]
    pin = next((v for v, e in CERTIFIED_ENGINES.items()
                if fingerprint is not None and e["fingerprint"] == fingerprint and v == version), None)
    if pin:
        return {"version": version, "certification": "certified", "pin": pin}
    try:
        reason = compatibility_problem(version)
    except Exception:  # noqa: BLE001 - an engine the probe cannot read is not compatible
        reason = "probe_failed"
    if reason is None:
        logger.info("Hermes Board: %s has no certified kanban fingerprint; the structural probe passed,"
                    " Board runs as compatible", version or "unknown")
        return {"version": version, "certification": "compatible"}
    logger.warning("Hermes Board: %s is not certified and not compatible (%s); Board stays off",
                   version or "unknown", reason)
    return {"version": version, "certification": "uncertified", "reason": reason}


def board_enabled(engine: dict) -> bool:
    """Whether this engine runs Board: certified or compatible."""
    return engine.get("certification") in ENABLED_TIERS


def board_capabilities(engine=None, tools=None) -> list:
    """Every key, in order. ``tools`` is the served profile's #3061 voice-tools
    view (``board_tools.view``); ``agent_tools`` follows it, and reads as
    ``temporarily_unavailable`` when no profile's view was read."""
    from . import board_tools
    engine = engine or engine_identity()
    certified = board_enabled(engine)
    rows = []
    for key in CAPABILITY_KEYS:
        if key == "agent_tools":
            rows.append(board_tools.capability(tools) if certified
                        else {"key": key, "enabled": False, "code": "uncertified"})
        elif key == "artifact_open" and certified:
            from . import board_artifacts
            rows.append({"key": key, "enabled": True} if board_artifacts.supported()
                        else {"key": key, "enabled": False, "code": "unsupported"})
        elif key in CERTIFIED_KEYS:
            rows.append({"key": key, "enabled": True} if certified
                        else {"key": key, "enabled": False, "code": "uncertified"})
        elif key in UNSUPPORTED_KEYS:
            rows.append({"key": key, "enabled": False, "code": "unsupported"})
        else:
            rows.append({"key": key, "enabled": False, "code": "deferred", "owner": DEFERRED_OWNERS[key]})
    return rows


def generic_capabilities() -> list:
    """The generic catalog row, so a client reading only it sees Board."""
    browse = board_enabled(engine_identity())
    return [{"operation": "board.browse", "scope": "profile", "supported": browse, "applyTiming": "read_only"}]


# --------------------------------------------------------------------------
# Read lane
# --------------------------------------------------------------------------

def board_root() -> Path:
    """The shared kanban root. ``kanban_home()`` honours HERMES_KANBAN_HOME and
    otherwise resolves the default Hermes root, never a profile home."""
    from hermes_cli.kanban_db import kanban_home
    return Path(kanban_home()).expanduser().resolve()


def _contained(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root)
        return True
    except (OSError, ValueError):
        return False


def board_paths(root: Path, slug: str):
    """``(db, board.json)`` for a validated slug, contained in ``root``."""
    if not isinstance(slug, str) or not _SLUG.match(slug):
        raise BoardReadError("invalid_target")
    meta = root / "kanban" / "boards" / slug / "board.json"
    db = root / "kanban.db" if slug == DEFAULT_BOARD else root / "kanban" / "boards" / slug / "kanban.db"
    if not _contained(root, db) or not _contained(root, meta):
        raise BoardReadError("invalid_target")
    return db, meta


def _lenient(raw: bytes) -> str:
    """The store's text_factory: invalid UTF-8 in a TEXT cell reads with
    replacement characters instead of failing the read. 0.21.1 and 0.21.3 do
    not decode leniently themselves; 0.21.4 and later do, and this reader sets
    its own anyway."""
    return bytes(raw).decode("utf-8", errors="replace")


def _decoded(value):
    """A BLOB cell (bytes, whatever the text_factory) decoded the same way."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return _lenient(value)
    return value


def _clean(value, limit):
    text = "".join(c for c in str(_decoded(value) or "") if c.isprintable()).strip()
    return text[:limit]


def _display_name(slug: str) -> str:
    return " ".join(p.capitalize() for p in slug.replace("_", "-").split("-") if p) or slug


def _metadata(slug: str, meta_path: Path) -> dict:
    raw = {}
    try:
        if meta_path.is_file() and meta_path.stat().st_size <= 64 * 1024:
            loaded = json.loads(meta_path.read_text(encoding="utf-8"))
            raw = loaded if isinstance(loaded, dict) else {}
    except (OSError, ValueError):
        raw = {}
    row = {"slug": slug, "name": _clean(raw.get("name"), 80) or _display_name(slug),
           "isDefault": slug == DEFAULT_BOARD, "archived": raw.get("archived") is True}
    description = _clean(raw.get("description"), 240)
    icon = _clean(raw.get("icon"), 16)
    color = raw.get("color")
    if description:
        row["description"] = description
    if icon:
        row["icon"] = icon
    if isinstance(color, str) and _COLOR.match(color):
        row["color"] = color
    return row


def open_store(db: Path) -> sqlite3.Connection:
    """Read-only, bounded-wait connection; refuses a missing or foreign store.
    Callers close it."""
    if not db.is_file():
        raise BoardReadError("store_missing")
    try:
        conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True,
                               timeout=BUSY_TIMEOUT_SECONDS, check_same_thread=False)
    except sqlite3.Error:
        raise BoardReadError("temporarily_unavailable") from None
    conn.text_factory = _lenient
    try:
        conn.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_SECONDS * 1000)}")
        check_schema(conn)
    except BaseException:
        conn.close()
        raise
    return conn


def check_schema(conn: sqlite3.Connection) -> None:
    try:
        for table, columns in REQUIRED_COLUMNS.items():
            have = {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}
            if not columns <= have:
                raise BoardReadError("schema_unsupported")
    except sqlite3.DatabaseError as exc:
        raise BoardReadError(_sqlite_code(exc)) from None


def _sqlite_code(exc: sqlite3.Error) -> str:
    text = str(exc).lower()
    if "not a database" in text or "malformed" in text:
        return "schema_unsupported"
    return "temporarily_unavailable"


def _board_row(root: Path, slug: str) -> dict:
    db, meta = board_paths(root, slug)
    row = _metadata(slug, meta)
    try:
        conn = open_store(db)
    except BoardReadError as refusal:
        row["state"] = refusal.code
        return row
    try:
        count = conn.execute("SELECT COUNT(*) FROM tasks WHERE status != 'archived'").fetchone()[0]
    except sqlite3.Error as exc:
        row["state"] = _sqlite_code(exc)
        return row
    finally:
        conn.close()
    row["state"] = "ready" if count else "empty"
    row["cardCount"] = int(count)
    return row


def list_boards(root: Path) -> list:
    """``default`` first, then every valid ``kanban/boards/<slug>`` that holds a
    board (``kanban.db`` or ``board.json``), sorted, at most MAX_BOARDS."""
    slugs = []
    boards_dir = root / "kanban" / "boards"
    if boards_dir.is_dir() and _contained(root, boards_dir):
        for child in sorted(boards_dir.iterdir(), key=lambda p: p.name):
            name = child.name
            if name == DEFAULT_BOARD or not _SLUG.match(name) or not child.is_dir():
                continue
            if not _contained(root, child):
                continue
            if (child / "kanban.db").exists() or (child / "board.json").exists():
                slugs.append(name)
    return [_board_row(root, slug) for slug in [DEFAULT_BOARD, *slugs][:MAX_BOARDS]]


# --------------------------------------------------------------------------
# Lanes and cards (#3043)
# --------------------------------------------------------------------------

def _target(root: Path, payload: dict):
    """``(slug, db, meta)`` for an existing board named by the payload."""
    slug = payload.get("slug")
    if not isinstance(slug, str) or not _SLUG.match(slug):
        raise BoardReadError("invalid_request")
    db, meta = board_paths(root, slug)
    if slug != DEFAULT_BOARD and not db.parent.is_dir():
        raise BoardReadError("invalid_target")
    return slug, db, meta


def _file_identity(db: Path) -> list:
    st = os.stat(db)
    return [st.st_dev, st.st_ino]


def _read(db: Path, body):
    """Run ``body(conn)`` in one read transaction on a read-only store."""
    conn = open_store(db)
    try:
        conn.execute("BEGIN")
        try:
            return body(conn)
        finally:
            conn.execute("COMMIT")
    except sqlite3.Error as exc:
        raise BoardReadError(_sqlite_code(exc)) from None
    finally:
        conn.close()


def read_lanes(root: Path, payload: dict) -> dict:
    slug, db, meta = _target(root, payload)

    def body(conn):
        counts = {}
        for status, count in conn.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status"):
            key = status if isinstance(status, str) and _STATUS.match(status) else "unknown"
            counts[key] = counts.get(key, 0) + int(count)
        needs_you = conn.execute(f"SELECT COUNT(*) FROM tasks t WHERE {_NEEDS_YOU}").fetchone()[0]
        failed = conn.execute(f"SELECT COUNT(*) FROM tasks t WHERE {_FAILED}").fetchone()[0]
        return counts, int(needs_you), int(failed), _file_identity(db)

    counts, needs_you, failed, identity = _read(db, body)
    lanes = [{"status": s, "count": counts.get(s, 0), "known": True} for s in LANE_ORDER]
    lanes += [{"status": s, "count": counts[s], "known": False}
              for s in sorted(counts) if s not in LANE_ORDER]
    total = sum(c for s, c in counts.items() if s != "archived")
    # #3055: the board instance (the #3044 anchor), so a new card binds to the board the wearer saw.
    return {"target": {"slug": slug, "name": _metadata(slug, meta)["name"]},
            "anchor": board_anchor(root, identity), "lanes": lanes, "needsYou": needs_you, "failed": failed,
            "total": total}


def _filter_sql(filter_):
    if filter_ == "all":
        return "t.status != 'archived'", []
    if filter_ == "needs_you":
        return _NEEDS_YOU, []
    if filter_ == "failed":  # #3599: the Failed tile's list, like needs_you never a status
        return _FAILED, []
    if isinstance(filter_, str) and _STATUS.match(filter_):
        return "t.status = ?", [filter_]
    raise BoardReadError("invalid_request")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def encode_cursor(fields: dict) -> str:
    body = _b64(json.dumps(fields, separators=(",", ":"), sort_keys=True).encode())
    sig = _b64(hmac.new(_CURSOR_KEY, body.encode(), hashlib.sha256).digest()[:18])
    return f"{body}.{sig}"


def _open_cursor(cursor) -> dict:
    """A cursor's fields once its form and signature check out."""
    if not isinstance(cursor, str) or not 0 < len(cursor) <= CURSOR_MAX or cursor.count(".") != 1:
        raise BoardReadError("invalid_request")
    body, sig = cursor.split(".")
    want = _b64(hmac.new(_CURSOR_KEY, body.encode(), hashlib.sha256).digest()[:18])
    if not hmac.compare_digest(sig, want):
        raise BoardReadError("expired_request")
    try:
        fields = json.loads(_unb64(body))
    except ValueError:
        raise BoardReadError("invalid_request") from None
    if not isinstance(fields, dict):
        raise BoardReadError("invalid_request")
    return fields


def decode_cursor(cursor, *, profile: str, slug: str, filter_: str, identity: list) -> list:
    """The keyset ``[priority, created_at, id]`` a valid cursor resumes after."""
    fields = _open_cursor(cursor)
    try:
        key = fields["k"]
        priority, created_at, task_id = int(key[0]), int(key[1]), str(key[2])
    except (ValueError, KeyError, TypeError, IndexError):
        raise BoardReadError("invalid_request") from None
    if "t" in fields:  # a timeline cursor (#3044) never resumes a card list
        raise BoardReadError("invalid_request")
    if fields.get("p") != profile:
        raise BoardReadError("stale_scope")
    if fields.get("s") != slug or fields.get("f") != filter_:
        raise BoardReadError("invalid_request")
    if fields.get("i") != identity:
        raise BoardReadError("stale_target")
    return [priority, created_at, task_id]


def _card(row) -> dict:
    status = row["status"] if isinstance(row["status"], str) and _STATUS.match(row["status"]) else "unknown"
    card = {"id": _clean(row["id"], 64), "title": _clean(row["title"], 200) or "Untitled",
            "state": status, "priority": int(row["pr"]), "createdAt": int(row["created_at"] or 0)}
    assignee = _clean(row["assignee"], 64)
    if assignee:
        card["assignee"] = assignee
    if row["outcome"] is not None:
        card["runOutcome"] = row["outcome"] if row["outcome"] in RUN_OUTCOMES else "other"
    # #3599: how long the running card has run; left out when unknown. List rows only
    # (the card sheet carries it on latestRun).
    started = row["started_at"] if "started_at" in row.keys() else None
    if status == "running" and isinstance(started, int) and started > 0:
        card["runStartedAt"] = started
    if status == "review":
        card["attention"] = "needs_review"
    elif status == "blocked" and row["block_kind"] == "needs_input":
        card["attention"] = "needs_input"
    else:
        card["attention"] = "none"
    return card


def read_cards(root: Path, payload: dict, profile: str) -> dict:
    if set(payload) - {"slug", "filter", "cursor", "limit"}:
        raise BoardReadError("invalid_request")
    slug, db, meta = _target(root, payload)
    filter_ = payload.get("filter")
    where, args = _filter_sql(filter_)
    limit = payload.get("limit", PAGE_DEFAULT)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= PAGE_MAX:
        raise BoardReadError("invalid_request")

    def body(conn):
        conn.row_factory = sqlite3.Row
        identity = _file_identity(db)
        after = None
        if payload.get("cursor") is not None:
            after = decode_cursor(payload["cursor"], profile=profile, slug=slug,
                                  filter_=filter_, identity=identity)
        total = conn.execute(f"SELECT COUNT(*) FROM tasks t WHERE {where}", args).fetchone()[0]
        sql = (
            "SELECT t.id, t.title, t.status, COALESCE(t.priority, 0) AS pr, t.created_at,"
            " t.assignee, t.block_kind,"
            f" {_LATEST_OUTCOME} AS outcome,"
            " (SELECT r.started_at FROM task_runs r WHERE r.task_id = t.id"
            "  ORDER BY r.id DESC LIMIT 1) AS started_at"
            f" FROM tasks t WHERE {where}"
        )
        params = list(args)
        if after is not None:
            sql += (" AND (COALESCE(t.priority, 0) < ? OR (COALESCE(t.priority, 0) = ?"
                    " AND (t.created_at > ? OR (t.created_at = ? AND t.id > ?))))")
            params += [after[0], after[0], after[1], after[1], after[2]]
        sql += " ORDER BY pr DESC, t.created_at ASC, t.id ASC LIMIT ?"
        rows = conn.execute(sql, [*params, limit + 1]).fetchall()
        return identity, int(total), rows

    identity, total, rows = _read(db, body)
    page = rows[:limit]
    result = {"target": {"slug": slug, "name": _metadata(slug, meta)["name"]},
              "cards": _with_watch([_card(r) for r in page], profile, slug), "total": total}
    if len(rows) > limit:
        last = page[-1]
        result["nextCursor"] = encode_cursor({
            "v": 1, "p": profile, "s": slug, "f": filter_, "i": identity,
            "k": [int(last["pr"]), int(last["created_at"] or 0), str(last["id"])],
        })
    return result


# --------------------------------------------------------------------------
# Card detail and timeline (#3044)
# --------------------------------------------------------------------------

def board_anchor(root: Path, identity: list) -> str:
    """The deep-link anchor: a digest of the root and the store's file
    identity. Opaque, stable across gateway restarts, and different for a
    replaced store or another Hermes root. #3038's anchor checkpoint replaces
    it when moments land."""
    raw = f"{root}\0{identity[0]}:{identity[1]}".encode()
    return _b64(hashlib.sha256(raw).digest()[:12])


def _redact(text: str):
    """Hermes' own review-boundary redaction; withholds the text if it fails."""
    try:
        from hermes_cli.kanban_db import redact_review_value
        out = redact_review_value(text)
    except Exception:
        return None
    return out if isinstance(out, str) else None


def _prose(value, limit: int):
    """Wearer-facing free text: leniently decoded, redacted, printable (line
    breaks kept), bounded. None when there is nothing to show."""
    text = _decoded(value)
    if not isinstance(text, str) or not text.strip():
        return None
    text = _redact(text[:_REDACT_WINDOW])
    if text is None:
        return None
    text = "".join(c if c.isprintable() or c == "\n" else " " if c == "\t" else "" for c in text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:limit] or None


def _payload(value) -> dict:
    try:
        loaded = json.loads(_decoded(value) or "null")
    except (ValueError, TypeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _int(value, default=0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _columns(conn, table: str) -> set:
    return {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}


def _card_target(root: Path, payload: dict, keys: set):
    if set(payload) - keys:
        raise BoardReadError("invalid_request")
    slug, db, meta = _target(root, payload)
    card_id = payload.get("id")
    if not isinstance(card_id, str) or not _CARD_ID.match(card_id):
        raise BoardReadError("invalid_request")
    return slug, db, meta, card_id


def _attention(status, block_kind) -> str:
    if status == "review":
        return "needs_review"
    if status == "blocked" and block_kind == "needs_input":
        return "needs_input"
    return "none"


def _related(conn, sql: str, card_id: str):
    rows = conn.execute(sql + " ORDER BY t.id LIMIT ?", [card_id, RELATED_MAX]).fetchall()
    out = []
    for row in rows:
        status = row["status"] if isinstance(row["status"], str) and _STATUS.match(row["status"]) else "unknown"
        out.append({"id": _clean(row["id"], 64), "title": _clean(row["title"], 200) or "Untitled", "state": status})
    return out


def _artifacts(conn, card_id: str):
    """Curated descriptors: name, type, size, time. Never ``stored_path``."""
    if not {"id", "task_id", "filename", "content_type", "size", "created_at"} <= _columns(conn, "task_attachments"):
        return [], 0
    count = conn.execute("SELECT COUNT(*) FROM task_attachments WHERE task_id = ?", [card_id]).fetchone()[0]
    rows = conn.execute(
        "SELECT id, filename, content_type, size, created_at FROM task_attachments"
        " WHERE task_id = ? ORDER BY created_at ASC, id ASC LIMIT ?", [card_id, RELATED_MAX]).fetchall()
    out = []
    for row in rows:
        item = artifact_descriptor(row)
        if item is not None:
            out.append(item)
    return out, int(count)


def artifact_descriptor(row):
    """One artifact's curated descriptor from its ``task_attachments`` row, or
    None when it has no usable name. #3044's open (``board_artifacts``) names
    the file with this same descriptor."""
    name = _clean(re.split(r"[\\/]", str(_decoded(row["filename"]) or ""))[-1], ARTIFACT_NAME_MAX)
    if not name:
        return None
    item = {"id": _int(row["id"]), "name": name, "size": max(0, _int(row["size"])),
            "createdAt": max(0, _int(row["created_at"]))}
    kind = _decoded(row["content_type"])
    if isinstance(kind, str) and _CONTENT_TYPE.match(kind.strip().lower()):
        item["contentType"] = kind.strip().lower()
    return item


def _comment_pairs(conn, card_id: str) -> dict:
    """``{commented event id: comment id}``. ``add_comment`` writes the comment
    and its ``commented`` event (author and length only) in one transaction, so
    both run in id order; comments written without an event are skipped. A
    comment pairs with the next event by the same author, no longer than the
    event's length, at most a minute older. Unpaired events show no text."""
    events = conn.execute(
        "SELECT id, payload, created_at FROM task_events WHERE task_id = ? AND kind = 'commented'"
        " ORDER BY id LIMIT ?", [card_id, PAIRING_MAX + 1]).fetchall()
    comments = conn.execute(
        "SELECT id, author, created_at, length(body) AS len FROM task_comments WHERE task_id = ?"
        " ORDER BY id LIMIT ?", [card_id, PAIRING_MAX + 1]).fetchall()
    if len(events) > PAIRING_MAX or len(comments) > PAIRING_MAX:
        return {}
    pairs, start = {}, 0
    for event in events:
        detail = _payload(event["payload"])
        author = str(detail.get("author") or "").strip()
        length = _int(detail.get("len"), -1)
        at = _int(event["created_at"])
        k = start
        while k < len(comments) and _int(comments[k]["created_at"]) <= at:
            c = comments[k]
            if (str(_decoded(c["author"]) or "") == author and _int(c["created_at"]) >= at - 60
                    and 0 < _int(c["len"]) <= length):
                pairs[event["id"]] = c["id"]
                start = k + 1
                break
            k += 1
    return pairs


def _timeline(conn, card_id: str, before, limit: int):
    """One page, newest first, keyset on ``task_events.id`` (native
    ``list_events`` is unpaged)."""
    sql = "SELECT id, run_id, kind, payload, created_at FROM task_events WHERE task_id = ?"
    params = [card_id]
    if before is not None:
        sql += " AND id < ?"
        params.append(before)
    rows = conn.execute(sql + " ORDER BY id DESC LIMIT ?", [*params, limit + 1]).fetchall()
    page = rows[:limit]
    bodies = {}
    if any(r["kind"] == "commented" for r in page):
        pairs = _comment_pairs(conn, card_id)
        wanted = [pairs[r["id"]] for r in page if r["id"] in pairs]
        if wanted:
            marks = ",".join("?" * len(wanted))
            found = {r["id"]: r["body"] for r in
                     conn.execute(f"SELECT id, body FROM task_comments WHERE id IN ({marks})", wanted)}
            bodies = {event: found.get(comment) for event, comment in pairs.items()}
    entries = []
    for row in page:
        kind = row["kind"] if isinstance(row["kind"], str) and _STATUS.match(row["kind"]) else "other"
        entry = {"id": int(row["id"]), "kind": kind, "at": max(0, _int(row["created_at"]))}
        if row["run_id"] is not None:
            entry["runId"] = _int(row["run_id"])
        if kind == "commented":
            author = _clean(_payload(row["payload"]).get("author"), 64)
            if author:
                entry["author"] = author
            text = _prose(bodies.get(row["id"]), COMMENT_MAX)
        elif kind in TIMELINE_TEXT:
            text = _prose(_payload(row["payload"]).get(TIMELINE_TEXT[kind]), PROSE_MAX)
        else:
            text = None
        if text:
            entry["text"] = text
        entries.append(entry)
    last = int(page[-1]["id"]) if len(rows) > limit and page else None
    return entries, last


def _timeline_cursor(profile, slug, card_id, identity, last) -> str:
    return encode_cursor({"v": 1, "t": "timeline", "p": profile, "s": slug, "c": card_id,
                          "i": identity, "k": [last]})


def _block_loop(conn, card_id: str):
    """#3058: the stock loop breaker's outcome, or None. A card that blocked
    again for the same cause after an unblock (``BLOCK_RECURRENCE_LIMIT``) goes
    to ``triage`` with a ``block_loop_detected`` event instead of ``blocked``.
    It shows while that event is the card's newest (comments aside): the card
    is no longer a question to answer, and the sheet says why it is in triage.
    ``{kind?, reason?}``: the block's kind and its (redacted) reason."""
    row = conn.execute("SELECT kind, payload FROM task_events WHERE task_id = ? AND kind != 'commented'"
                       " ORDER BY id DESC LIMIT 1", [card_id]).fetchone()
    if row is None or _decoded(row["kind"]) != "block_loop_detected":
        return None
    payload = _payload(row["payload"])
    loop = {}
    kind = payload.get("kind")
    if isinstance(kind, str) and _STATUS.match(kind):
        loop["kind"] = kind
    reason = _prose(payload.get("reason"), PROSE_MAX)
    if reason:
        loop["reason"] = reason
    return loop


def _card_detail(conn, card_id: str) -> dict:
    task_columns = _columns(conn, "tasks")
    optional = ", t.result" if "result" in task_columns else ""
    row = conn.execute(
        "SELECT t.id, t.title, t.body, t.status, COALESCE(t.priority, 0) AS pr, t.created_at,"
        " t.completed_at, t.assignee, t.block_kind,"
        " (SELECT r.outcome FROM task_runs r WHERE r.task_id = t.id AND r.outcome IS NOT NULL"
        "  ORDER BY r.id DESC LIMIT 1) AS outcome" + optional +
        " FROM tasks t WHERE t.id = ?", [card_id]).fetchone()
    if row is None:
        raise BoardReadError("invalid_target")
    card = _card(row)
    brief = _prose(row["body"], BRIEF_MAX)
    if brief:
        card["brief"] = brief
    block_kind = _decoded(row["block_kind"])
    if card["state"] == "blocked" and isinstance(block_kind, str) and _STATUS.match(block_kind):
        card["blockKind"] = block_kind
    if row["completed_at"] is not None:
        card["completedAt"] = max(0, _int(row["completed_at"]))
    if optional:
        result = _prose(row["result"], PROSE_MAX)
        if result:
            card["result"] = result
    # Attention identity: the event that raised it, read in the same snapshot.
    kind = {"needs_review": "review_requested", "needs_input": "blocked"}.get(card["attention"])
    if kind:
        from .board_tail import EVENT_COLS, event_hash
        raised = conn.execute(f"SELECT {', '.join(EVENT_COLS)} FROM task_events WHERE task_id = ? AND kind = ?"
                              " ORDER BY id DESC LIMIT 1", [card_id, kind]).fetchone()
        if raised is not None:
            card["attentionEvent"] = int(raised["id"])
            # #3056: the hash of that whole event row. A decision names both,
            # so a restored board that reuses the id with other content never matches.
            card["attentionHash"] = event_hash(raised)
            if kind == "blocked":
                question = _prose(_payload(raised["payload"]).get("reason"), PROSE_MAX)
                if question:
                    card["question"] = question
    if card["state"] == "triage":
        loop = _block_loop(conn, card_id)
        if loop is not None:
            card["blockLoop"] = loop
    run = conn.execute("SELECT id, profile, status, outcome, summary, started_at, ended_at FROM task_runs"
                       " WHERE task_id = ? ORDER BY id DESC LIMIT 1", [card_id]).fetchone()
    if run is not None:
        status = _decoded(run["status"])
        latest = {"id": int(run["id"]),
                  "status": status if isinstance(status, str) and _STATUS.match(status) else "unknown",
                  "startedAt": max(0, _int(run["started_at"]))}
        outcome = _decoded(run["outcome"])
        if outcome is not None:
            latest["outcome"] = outcome if outcome in RUN_OUTCOMES else "other"
        worker = _clean(run["profile"], 64)
        if worker:
            latest["worker"] = worker
        summary = _prose(run["summary"], PROSE_MAX)
        if summary:
            latest["summary"] = summary
        if run["ended_at"] is not None:
            latest["endedAt"] = max(0, _int(run["ended_at"]))
        card["latestRun"] = latest
    card["parents"] = _related(conn, "SELECT t.id, t.title, t.status FROM task_links l"
                                     " JOIN tasks t ON t.id = l.parent_id WHERE l.child_id = ?", card_id)
    card["children"] = _related(conn, "SELECT t.id, t.title, t.status FROM task_links l"
                                      " JOIN tasks t ON t.id = l.child_id WHERE l.parent_id = ?", card_id)
    card["artifacts"], card["artifactCount"] = _artifacts(conn, card_id)
    return card


def read_card(root: Path, payload: dict, profile: str) -> dict:
    """One card and its first timeline page, in one read transaction. With an
    ``anchor`` (a deep link) the store must still be the one it named."""
    slug, db, meta, card_id = _card_target(root, payload, {"slug", "id", "anchor"})
    anchor = payload.get("anchor")
    if anchor is not None and (not isinstance(anchor, str) or not _ANCHOR.match(anchor)):
        raise BoardReadError("invalid_request")

    def body(conn):
        conn.row_factory = sqlite3.Row
        identity = _file_identity(db)
        current = board_anchor(root, identity)
        if anchor is not None and not hmac.compare_digest(anchor, current):
            raise BoardReadError("stale_target")
        card = _card_detail(conn, card_id)
        # #3059: the More menu's guards read the same snapshot as the sheet.
        from .board_actions import card_facts
        facts = card_facts(conn, card_id)
        total = conn.execute("SELECT COUNT(*) FROM task_events WHERE task_id = ?", [card_id]).fetchone()[0]
        timeline, last = _timeline(conn, card_id, None, TIMELINE_DEFAULT)
        return identity, current, card, facts, int(total), timeline, last

    identity, current, card, facts, total, timeline, last = _read(db, body)
    card = _with_watch([card], profile, slug)[0]
    if facts is not None:
        # #3059: the actions this card offers now (capability on and state guard met), and
        # its model override, which Set model shows.
        from .board_actions import card_actions
        card["actions"] = card_actions(facts, board_capabilities())
        if facts["model"]:
            card["model"] = facts["model"]
    result = {"target": {"slug": slug, "name": _metadata(slug, meta)["name"]}, "anchor": current,
              "card": card, "timeline": timeline, "total": total}
    if last is not None:
        result["nextCursor"] = _timeline_cursor(profile, slug, card_id, identity, last)
    return result


def read_timeline(root: Path, payload: dict, profile: str) -> dict:
    """The next timeline page after ``cursor``. The card must still exist."""
    slug, db, meta, card_id = _card_target(root, payload, {"slug", "id", "cursor", "limit"})
    limit = payload.get("limit", TIMELINE_DEFAULT)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= TIMELINE_MAX:
        raise BoardReadError("invalid_request")
    fields = _open_cursor(payload.get("cursor"))
    try:
        before = int(fields["k"][0])
    except (ValueError, KeyError, TypeError, IndexError):
        raise BoardReadError("invalid_request") from None
    if fields.get("t") != "timeline":
        raise BoardReadError("invalid_request")
    if fields.get("p") != profile:
        raise BoardReadError("stale_scope")
    if fields.get("s") != slug or fields.get("c") != card_id:
        raise BoardReadError("invalid_request")

    def body(conn):
        conn.row_factory = sqlite3.Row
        identity = _file_identity(db)
        if fields.get("i") != identity:
            raise BoardReadError("stale_target")
        if conn.execute("SELECT 1 FROM tasks WHERE id = ?", [card_id]).fetchone() is None:
            raise BoardReadError("invalid_target")
        total = conn.execute("SELECT COUNT(*) FROM task_events WHERE task_id = ?", [card_id]).fetchone()[0]
        timeline, last = _timeline(conn, card_id, before, limit)
        return identity, int(total), timeline, last

    identity, total, timeline, last = _read(db, body)
    result = {"target": {"slug": slug, "name": _metadata(slug, meta)["name"]},
              "timeline": timeline, "total": total}
    if last is not None:
        result["nextCursor"] = _timeline_cursor(profile, slug, card_id, identity, last)
    return result


# --------------------------------------------------------------------------
# Watch (#3050)
# --------------------------------------------------------------------------

def _with_watch(cards: list, profile: str, slug: str) -> list:
    """Each card with this profile's ``watch`` mode on this board. If
    OcuClaw's watch store cannot be read the rows carry no mode (browsing
    never fails for a watch), and the phone offers no watch change."""
    from . import board_watch
    try:
        found = board_watch.modes(profile, slug, [c["id"] for c in cards])
    except board_watch.WatchStoreError:
        return cards
    return [{**c, "watch": found.get(c["id"], "off")} for c in cards]


def write_watch(root: Path, payload: dict, profile: str, capabilities: list) -> dict:
    """Set this profile's watch on one card. The card must be on the board;
    nothing is written to Hermes (the store and ``board.json`` stay
    byte-identical, and native ``kanban_notify_subs`` rows are never read or
    written here). Idempotent: repeating a request changes nothing."""
    from . import board_watch
    slug, db, meta, card_id = _card_target(root, payload, {"slug", "id", "mode"})
    mode = payload.get("mode")
    enabled = {row["key"]: row for row in capabilities}
    if mode in board_watch.RESERVED_MODES:
        wake = enabled.get("wake", {})
        if not wake.get("enabled"):
            code = wake.get("code") or "unsupported"
            raise BoardReadError("wake_unsupported" if code == "unsupported" else code)
    if mode not in board_watch.MODES:
        raise BoardReadError("invalid_request")

    def body(conn):
        if conn.execute("SELECT 1 FROM tasks WHERE id = ?", [card_id]).fetchone() is None:
            raise BoardReadError("invalid_target")
        return [row[0] for row in conn.execute("SELECT id FROM tasks")]

    live = _read(db, body)
    set_watch(profile, slug, card_id, db, meta, mode, live=live)
    return {"target": {"slug": slug, "name": _metadata(slug, meta)["name"]},
            "watch": {"id": card_id, "mode": mode}}


def set_watch(profile: str, slug: str, card_id: str, db: Path, meta: Path, mode: str, live=None) -> None:
    """Store one scoped watch (#3050) and its moment start (#3051). Idempotent;
    #3055's create runs it for a new card. ``temporarily_unavailable`` when
    OcuClaw's store cannot be written."""
    from . import board_moments, board_watch
    try:
        # #3051: a notify watch's moments start at the board's current event,
        # recorded before the watch exists, so the tail never replays history.
        if mode == "notify":
            board_moments.note_watch(profile, slug, card_id, db, meta, mode)
        board_watch.set_mode(profile, slug, card_id, mode, live=live)
        if mode == "off":
            board_moments.note_watch(profile, slug, card_id, db, meta, mode)
    except (board_watch.WatchStoreError, board_moments.MomentStoreError):
        raise BoardReadError("temporarily_unavailable") from None


def moment_policy(profile: str, payload, *, now=None) -> dict:
    """#3053: this profile's moment policy (``payload`` None), or set it to
    ``payload`` (an idempotent set). OcuClaw's own store only: nothing in
    Hermes is read or written, including its display config. Answers the
    ``policy`` view: state, the three settings and what the backend does
    with a moment now."""
    import time
    from . import board_moments, board_policy
    now = int(time.time()) if now is None else now
    try:
        if payload is None:
            return board_policy.view(board_moments.policy(profile), now)
        wanted = board_policy.parse_request(payload)
        if wanted is None:
            raise BoardReadError("invalid_request")
        board_moments.set_policy(profile, wanted, now=now)
        return board_policy.view(wanted, now)
    except board_moments.MomentStoreError:
        raise BoardReadError("temporarily_unavailable") from None


# --------------------------------------------------------------------------
# Management family
# --------------------------------------------------------------------------

def _profile_home(rpc, profile: str):
    """The served profile's home, or None when it cannot be resolved."""
    if rpc is None:
        return None
    try:
        from .management_profiles import management_profile_home
        return management_profile_home(rpc, profile)
    except Exception:
        return None


def handle_board(identity: dict, payload, rpc=None) -> dict:
    from . import board_tools
    operation = identity["operation"]
    worded = CARD_MESSAGES if operation in CARD_OPERATIONS else {}
    if operation == "board.watch":
        worded = {**worded, **WATCH_MESSAGES}
    if operation in POLICY_OPERATIONS:
        worded = POLICY_MESSAGES
    if operation in CREATE_OPERATIONS:
        worded = CREATE_MESSAGES
    if operation in DECOMPOSE_OPERATIONS:
        worded = DECOMPOSE_MESSAGES
    if operation == "board.verdict":
        worded = VERDICT_MESSAGES
    if operation == "board.comment":
        worded = COMMENT_MESSAGES
    if operation == "board.action":
        worded = ACTION_MESSAGES
    if operation in MAINTENANCE_OPERATIONS:
        worded = MAINTENANCE_MESSAGES
    if operation in ARTIFACT_OPERATIONS:
        worded = ARTIFACT_MESSAGES

    def fail(code: str, message: str | None = None) -> dict:
        message = message or worded.get(code) or MESSAGES.get(code, MESSAGES["native_read_failed"])
        return {**identity, "status": "error", "errorCode": code, "errorMessage": message, "capabilities": []}

    targeted = operation in TARGETED
    if targeted or operation in ("board.policy.set", "board.tools.enable"):
        if not isinstance(payload, dict):
            return fail("invalid_request")
    elif payload is not None and payload != {}:
        return fail("invalid_request")
    engine = engine_identity()
    certified = board_enabled(engine)
    # #3061: whether Hermes' kanban agent tools are on for OcuClaw, for the served
    # profile. Every answer carries the same agent_tools row; status carries the view.
    home = _profile_home(rpc, identity["profileId"])
    tools = board_tools.view(home, certified)
    board = {"engine": dict(engine), "capabilities": board_capabilities(engine, tools)}
    if operation == "board.status":
        board["agentTools"] = tools
        return {**identity, "status": "ok", "capabilities": [], "board": board}
    if not certified:
        return fail("uncertified")
    if operation == "board.tools.enable":
        # #3061: the server re-checks everything the phone offered, then runs the
        # wearer's own command once; only the read-back decides.
        try:
            tools = board_tools.enable(home, certified, payload)
        except board_tools.ToolsError as refusal:
            return fail(refusal.code, refusal.message)
        except Exception:
            return fail("outcome_unknown", board_tools.MESSAGES["timeout"])
        board["capabilities"] = board_capabilities(engine, tools)
        board["agentTools"] = tools
        return {**identity, "status": "ok", "capabilities": [], "board": board}
    if operation == "board.watch":
        # #3050: the server enforces the watch capability, whatever the phone offered.
        watch = next(row for row in board["capabilities"] if row["key"] == "watch")
        if not watch["enabled"]:
            return fail(watch["code"])
    if operation in POLICY_OPERATIONS:
        # #3053: the policy is the moments' own; the server enforces it too.
        moments = next(row for row in board["capabilities"] if row["key"] == "passive_moments")
        if not moments["enabled"]:
            return fail(moments["code"])
        try:
            board["policy"] = moment_policy(identity["profileId"], payload if operation == "board.policy.set" else None)
        except BoardReadError as refusal:
            return fail(refusal.code)
        except Exception:
            return fail("temporarily_unavailable")
        return {**identity, "status": "ok", "capabilities": [], "board": board}
    try:
        root = board_root()
        if operation == "board.boards":
            # board_exists('default') is always true natively, so a missing
            # default store is reported on its row as store_missing, never empty.
            board["boards"] = list_boards(root)
        elif operation == "board.lanes":
            if set(payload) - {"slug"}:
                return fail("invalid_request")
            board.update(read_lanes(root, payload))
        elif operation == "board.cards":
            board.update(read_cards(root, payload, identity["profileId"]))
        elif operation == "board.card":
            board.update(read_card(root, payload, identity["profileId"]))
        elif operation == "board.watch":
            board.update(write_watch(root, payload, identity["profileId"], board["capabilities"]))
        elif operation == "board.create":
            # #3055: the server enforces `create` again right before the native write.
            from . import board_create
            board.update(board_create.create(root, payload, identity["profileId"], board["capabilities"]))
        elif operation == "board.receipt":
            from . import board_create
            board.update(board_create.lookup(root, payload, identity["profileId"]))
        elif operation == "board.decompose":
            # #3060: the server enforces `dependencies` again right before stock decompose_task.
            from . import board_decompose
            board.update(board_decompose.decompose(root, payload, identity["profileId"], board["capabilities"]))
        elif operation == "board.verdict":
            # #3056: the server enforces the verdict's capability again right before the claim.
            from . import board_review
            board.update(board_review.decide(root, payload, identity["profileId"], board["capabilities"]))
        elif operation == "board.comment":
            # #3058: the server enforces `comment` again right before the native write.
            from . import board_comment
            board.update(board_comment.add(root, payload, identity["profileId"], board["capabilities"]))
        elif operation == "board.action":
            # #3059: the server enforces the action's own capability again right before the write.
            from . import board_actions
            board.update(board_actions.act(root, payload, identity["profileId"], board["capabilities"]))
        elif operation in MAINTENANCE_OPERATIONS:
            # #3063: each maintenance action checks its own gate under `maintenance`.
            from . import board_maintenance
            if operation == "board.maintenance":
                board.update(board_maintenance.read(root, payload, identity["profileId"], board["capabilities"]))
            elif operation == "board.export":
                board.update(board_maintenance.export(root, payload, identity["profileId"], board["capabilities"]))
            else:
                board.update(board_maintenance.part(payload, identity["profileId"], board["capabilities"]))
        elif operation in ARTIFACT_OPERATIONS:
            # #3044: opening a card artifact checks `artifact_open` itself, then stock's own scope rules.
            from . import board_artifacts
            if operation == "board.artifact":
                board.update(board_artifacts.open_artifact(root, payload, identity["profileId"], board["capabilities"]))
            else:
                board.update(board_artifacts.part(payload, identity["profileId"], board["capabilities"]))
        else:
            board.update(read_timeline(root, payload, identity["profileId"]))
    except BoardReadError as refusal:
        return fail(refusal.code)
    except Exception:
        # #3055, #3056, #3058, #3059: a write that failed unexpectedly may have written; never a guess.
        return fail("outcome_unknown" if operation in UNCERTAIN_WRITES else "native_read_failed")
    return {**identity, "status": "ok", "capabilities": [], "board": board}
