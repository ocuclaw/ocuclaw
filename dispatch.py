"""Turn dispatch + runId correlation ledger (W06, plan D9).

The Node bridge mints a ``runId`` per turn and dispatches over the link's
``dispatch.send`` lane; hermes has no idempotencyKey→runId echo, so THIS
module is the correlation authority that stamps the mint onto every
synthesized ``streaming``/``message``/``activity`` event (the contract map's
"single most fragile piece"). Design is normative in the bundle PROTOCOL.md
("Dispatch lane" / "D9 runId correlation table").

Pure-Python on purpose: no hermes imports, fully unit-testable. The adapter
(``adapter.py``) owns MessageEvent construction, link emission, and the
hermes hook glue; this module owns record lifecycle + event payload shapes.

Thread-safety: hermes hooks (``on_session_end``) fire synchronously on the
agent's worker thread while dispatch RPCs run on the gateway loop — every
ledger mutation takes the internal lock.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

DISPATCH_METHOD = "dispatch.send"
BACKEND_EVENT_METHOD = "backend.event"
BACKEND_HOOK_METHOD = "backend.hook"

PROMPT_OWNERS = frozenset({"ocuclaw", "even-ai"})
PROMPT_LANES = frozenset({"logical-session-frozen", "turn-scoped"})

KIND_TURN = "turn"
KIND_SLASH = "slash"

STATE_ACTIVE = "active"
# Busy dispatches mirror hermes's REAL busy bookkeeping (gateway
# _queue_or_replace_pending_event, #28503): TEXT follow-ups ride a FIFO —
# each gets its OWN turn in arrival order, so each keeps its OWN pending
# record and full runId correlation. Only the PHOTO/media-burst semantics
# merge into the head pending slot (either side media-carrying): those
# dispatches attach to the FIRST pending TURN carrier as RIDERS — one
# merged turn runs on the carrier's runId, riders resolve with terminal
# activity only (never a duplicate commit) when the carrier completes.
# Steer is NEVER assumed (absorption is unobservable; hermes falls back to
# queue in several paths — Codex review W06 finding): under actual steer a
# pending record becomes a janitor-closed phantom (accepted residual;
# waiter consumers carry their own timeouts).
STATE_PENDING = "pending"
STATE_RIDER = "rider"

DEFAULT_STALE_TURN_SECONDS = 1800.0  # tool calls legitimately run >10 min
ERROR_TERMINAL_STALE_TURN_SECONDS = 5.0
IDEMPOTENCY_TTL_SECONDS = 600.0
JANITOR_INTERVAL_SECONDS = 60.0
# A cancelling slash closes running records proactively, but a turn whose
# cancel landed AFTER run_conversation passed the finalize point still fires
# a LATE on_session_end — the fence marks that window so a stale end can't
# complete post-cancel records (Codex review W06 finding).
CANCEL_FENCE_TTL_SECONDS = 30.0
# Hermes's StreamConsumer can deliver a short turn's sole final send just
# after on_session_end. Retain that ended run briefly so the send keeps the
# dispatch correlation that existed for the turn.
ENDED_RUN_SEND_GRACE_SECONDS = 2.0

# The StreamConsumer appends this cursor to non-final deliveries
# (gateway/config.py DEFAULT_STREAMING_CURSOR). A custom-configured cursor is
# not visible to the adapter — M1 strips the default only (ledgered).
STREAM_CURSOR = " ▉"

# Bypass slash commands hermes serializes onto a busy session by CANCELLING
# the running turn first (base.py _dispatch_active_session_command). The
# ledger mirrors that: the cancelled head closes with code "cancelled".
CANCELLING_SLASH_COMMANDS = ("/stop", "/new", "/reset")


def validate_prompt_metadata(params: Any) -> Optional[Tuple[str, str]]:
    """Validate bounded #2089 prompt metadata on ``dispatch.send``.

    Legacy dispatches carry only ``channelPrompt`` and remain valid. New
    owned prompts carry both enum fields together; the metadata never changes
    the channel-prompt bytes Hermes passes to the model.
    """
    values = params if isinstance(params, dict) else {}
    owner = values.get("promptOwner")
    lane = values.get("promptLane")
    if owner is None and lane is None:
        return None
    if not isinstance(owner, str) or owner not in PROMPT_OWNERS:
        raise ValueError("promptOwner must be 'ocuclaw' or 'even-ai'")
    if not isinstance(lane, str) or lane not in PROMPT_LANES:
        raise ValueError(
            "promptLane must be 'logical-session-frozen' or 'turn-scoped'"
        )
    content = values.get("channelPrompt")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("prompt metadata requires a non-empty channelPrompt")
    return str(owner), str(lane)


def strip_stream_cursor(text: Any) -> str:
    value = text if isinstance(text, str) else ""
    if value.endswith(STREAM_CURSOR):
        return value[: -len(STREAM_CURSOR)]
    return value


# Session-reset commands whose OcuClaw call sites may append a greeting prompt.
# Hermes routes both through its destructive reset-confirmation gate. Forward
# only the bare command: dispatching the remainder as a second turn can run it
# before the wearer has approved the reset, in the conversation being cleared.
RESET_COMMANDS = ("/new", "/reset")


def normalize_session_reset_command(message: str) -> str:
    """Return a bare Hermes ``/new``/``/reset`` command.

    Trailing OcuClaw greeting text is deliberately dropped. Hermes owns the
    confirmation and reset result; synthesizing a second turn here would need
    decision-aware lifecycle state that the adapter does not safely have.
    """
    text = message if isinstance(message, str) else ""
    stripped = text.rstrip()
    command = stripped.split(None, 1)[0] if stripped else ""
    if command in RESET_COMMANDS:
        return command
    return text


def is_cancelling_slash(message: str) -> bool:
    text = (message or "").strip()
    command = text.split(None, 1)[0] if text else ""
    return command in CANCELLING_SLASH_COMMANDS


# The platform update command is refused for glasses sessions (P19). Running
# it pulls Hermes past the baseline this bundle is certified against, in
# place, with no proof the new tree still satisfies the Backend Adapter and
# SessionDB contract — the wearer would lose a working assistant to a silent
# pull. The one sanctioned transition is the supervised upgrade contract
# (explicit restart, health re-verification, roll-forward-only recovery),
# which is NOT this command.
UPDATE_COMMANDS = ("update",)


def is_platform_update_command(message: str) -> bool:
    """True when the message's leading token is the platform update command.

    The token is normalized the way hermes normalizes it, because anything
    hermes accepts as ``/update`` must be refused here first. Hermes's
    ``MessageEvent.get_command()`` strips leading whitespace, takes the first
    whitespace-delimited token, lowercases it, and drops an ``@botname``
    suffix; ``resolve_command()`` then lowercases again. So ``/UPDATE`` and
    ``/update@ocuclaw`` both resolve to canonical ``update``.

    Normalizing less than hermes does is what makes this a real gap rather
    than a style point: an unrefused variant falls through to hermes's own
    gate, which answers refused platforms with "run ``hermes update`` from
    the terminal" — the exact instruction P19 exists to keep off the glasses.
    The registry gate still blocks the update itself, so what leaks is the
    wording, not the destructive act.
    """
    text = (message or "").strip()
    token = text.split(None, 1)[0] if text else ""
    if not token.startswith("/"):
        return False
    name = token[1:].casefold().split("@", 1)[0]
    return name in UPDATE_COMMANDS


def wall_clock_ms() -> int:
    """Wall-clock milliseconds — the clock ``originAtMs`` is expressed in.

    The ledger's own ``now`` is monotonic (durations, staleness); an origin
    stamp has to be comparable against timestamps the consumer already holds.
    """
    return int(time.time() * 1000)


@dataclass
class DispatchRecord:
    run_id: str
    session_key: str
    public_key: str
    kind: str
    state: str
    epoch: int
    created_at: float
    last_activity_at: float
    needs_lifecycle_start: bool = False
    error_stale_deadline_at: Optional[float] = None
    terminal_error_code: Optional[str] = None
    idempotency_key: Optional[str] = None
    status: str = "accepted"
    session_state: Optional[str] = None
    prompt_owner: Optional[str] = None
    prompt_lane: Optional[str] = None
    # Current (latest) outbound message for this turn — the StreamConsumer
    # opens one per segment; ``finalize=True`` commits it; a fresh send while
    # one is open commits the previous first (defensive).
    current_message_id: Optional[str] = None
    current_text: str = ""
    current_committed: bool = True  # nothing open yet
    stream_chunks: int = 0
    # Wall-clock ms at which the CURRENT message was first sent — its ORIGIN
    # (#1619). Hermes flushes an assistant message lazily on the next send(),
    # so a tool-progress line commits after the tool output it introduces;
    # the consumer re-splices it here. ``previous_origin_ms`` carries the same
    # stamp for the message a fresh send just flushed.
    current_origin_ms: Optional[int] = None
    previous_origin_ms: Optional[int] = None
    # The platform message id of the message a fresh send just flushed
    # (#1691). Same shape and same reason as ``previous_origin_ms``: the
    # commit that flush emits belongs to the PREVIOUS message, so it must
    # carry the previous message's id, not the id this send just minted.
    previous_message_id: Optional[str] = None
    # Media-carrying dispatch (drives the head-slot media-merge mirror).
    has_media: bool = False
    # Busy dispatches hermes merged into this head pending slot (photo/media
    # burst semantics); resolved (terminal activity only) when the carrier
    # completes.
    riders: List["DispatchRecord"] = field(default_factory=list)


class DispatchLedger:
    """session_key → FIFO of DispatchRecords + idempotency dedup index."""

    def __init__(
        self,
        *,
        stale_turn_seconds: float = DEFAULT_STALE_TURN_SECONDS,
        idempotency_ttl_seconds: float = IDEMPOTENCY_TTL_SECONDS,
        ended_run_send_grace_seconds: float = ENDED_RUN_SEND_GRACE_SECONDS,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._stale_after = max(
            60.0,
            float(stale_turn_seconds or 0) or DEFAULT_STALE_TURN_SECONDS,
        )
        self._idempotency_ttl = idempotency_ttl_seconds
        self._ended_run_send_grace = max(0.0, float(ended_run_send_grace_seconds))
        self._now = now
        self._lock = threading.Lock()
        self._sessions: Dict[str, List[DispatchRecord]] = {}
        self._idempotency: Dict[str, Tuple[DispatchRecord, float]] = {}
        self._last_ended: Dict[str, Tuple[DispatchRecord, float]] = {}
        self._epoch = 0
        # session_key → fence expiry (monotonic); armed on cancelling-slash
        # record closure, disarmed ONLY by TTL (non-consuming — see
        # cancel_fence_active).
        self._cancel_fences: Dict[str, float] = {}

    # -- dispatch ------------------------------------------------------------

    def find_idempotent(self, idempotency_key: Optional[str]) -> Optional[DispatchRecord]:
        if not idempotency_key:
            return None
        with self._lock:
            self._purge_idempotency_locked()
            hit = self._idempotency.get(idempotency_key)
            return hit[0] if hit else None

    def begin(
        self,
        *,
        session_key: str,
        run_id: str,
        public_key: str,
        kind: str,
        idempotency_key: Optional[str] = None,
        session_state: Optional[str] = None,
        has_media: bool = False,
        prompt_owner: Optional[str] = None,
        prompt_lane: Optional[str] = None,
    ) -> DispatchRecord:
        with self._lock:
            now = self._now()
            # A newer dispatch supersedes any prior turn's unclaimed final
            # send for this native session identity.
            self._last_ended.pop(session_key, None)
            self._epoch += 1
            fifo = self._sessions.setdefault(session_key, [])
            has_open = any(r.state in (STATE_ACTIVE, STATE_PENDING) for r in fifo)
            # Busy bookkeeping mirrors hermes (#28503, see STATE_PENDING
            # note): TEXT follow-ups get their OWN pending record (FIFO —
            # each runs as its own turn); only the media-burst semantics
            # merge into the FIRST pending TURN carrier (the head slot):
            # a media-carrying dispatch always merges when a carrier
            # exists, and a text dispatch merges only into a media-carrying
            # carrier. Slash dispatches keep their own pending record
            # (bypass commands never reach here — they cancel-close).
            carrier = None
            if has_open and kind == KIND_TURN:
                head_slot = next(
                    (
                        existing
                        for existing in fifo
                        if existing.state == STATE_PENDING
                        and existing.kind == KIND_TURN
                    ),
                    None,
                )
                if head_slot is not None and (has_media or head_slot.has_media):
                    carrier = head_slot
            state = (
                STATE_ACTIVE
                if not has_open
                else (STATE_RIDER if carrier is not None else STATE_PENDING)
            )
            record = DispatchRecord(
                run_id=run_id,
                session_key=session_key,
                public_key=public_key,
                kind=kind,
                state=state,
                epoch=self._epoch,
                created_at=now,
                last_activity_at=now,
                idempotency_key=idempotency_key,
                session_state=session_state,
                has_media=has_media,
                prompt_owner=prompt_owner,
                prompt_lane=prompt_lane,
            )
            if carrier is not None:
                carrier.riders.append(record)
                if has_media:
                    # hermes upgrades the merged head slot to media-carrying.
                    carrier.has_media = True
            else:
                fifo.append(record)
            if idempotency_key:
                self._purge_idempotency_locked()
                self._idempotency[idempotency_key] = (
                    record,
                    now + self._idempotency_ttl,
                )
            return record

    # -- event correlation ---------------------------------------------------

    def head(self, session_key: str) -> Optional[DispatchRecord]:
        with self._lock:
            return self._head_locked(session_key)

    def note_send(
        self, session_key: str, message_id: str, text: str
    ) -> Tuple[Optional[DispatchRecord], Optional[str], bool]:
        """New outbound message.

        Returns ``(record, uncommittedPreviousText, endedRunCommit)``. The
        final flag marks the one-shot grace claim for a turn whose
        on_session_end beat its first/final send; callers emit that send as a
        committed message rather than opening a stream.
        """
        with self._lock:
            record = self._activity_head_locked(session_key)
            if record is None:
                ended = self._last_ended.get(session_key)
                if ended is None:
                    return None, None, False
                ended_record, ended_at = ended
                self._last_ended.pop(session_key, None)
                if self._now() - ended_at > self._ended_run_send_grace:
                    return None, None, False
                return ended_record, None, True
            previous = (
                record.current_text
                if record.current_message_id is not None and not record.current_committed
                else None
            )
            record.previous_origin_ms = (
                record.current_origin_ms if previous is not None else None
            )
            record.previous_message_id = (
                record.current_message_id if previous is not None else None
            )
            record.current_message_id = message_id
            record.current_text = text
            record.current_committed = False
            record.current_origin_ms = wall_clock_ms()
            record.stream_chunks += 1
            self._touch_record_locked(record)
            return record, previous, False

    def note_edit(
        self, session_key: str, message_id: str, text: str, *, finalize: bool
    ) -> Optional[DispatchRecord]:
        with self._lock:
            record = self._head_locked(session_key)
            # STRICT message ownership (Codex review W06 finding): edits bind
            # only to the head's own current message. Every legitimate edit
            # follows the send() that minted its message_id on this record —
            # a mismatched id is a LATE edit from a completed previous turn
            # (e.g. run A's trailing finalize arriving after run B was
            # promoted) and must never stamp the new head's runId.
            if record is None or record.current_message_id != message_id:
                return None
            record.current_text = text
            record.current_committed = bool(finalize)
            record.stream_chunks += 1
            self._touch_record_locked(record)
            return record

    def touch(self, session_key: str) -> Optional[DispatchRecord]:
        with self._lock:
            record = self._activity_head_locked(session_key)
            if record is not None:
                self._touch_record_locked(record)
            return record

    def mark_error_terminal(
        self,
        session_key: str,
        *,
        code: str,
        stale_after_seconds: float = ERROR_TERMINAL_STALE_TURN_SECONDS,
    ) -> Optional[DispatchRecord]:
        """Mark the active turn as error-terminal when Hermes reports an
        escaped provider/API failure but never fires on_session_end.

        This is intentionally per-record instead of shrinking the normal
        janitor window: long-running tools can still take the broad stale
        timeout, while provider-400 style terminal errors stop stranding the
        D9 head until the 1800s backstop.
        """
        with self._lock:
            record = self._head_locked(session_key)
            if record is None:
                return None
            now = self._now()
            timeout = max(0.0, float(stale_after_seconds or 0.0))
            record.last_activity_at = now
            record.error_stale_deadline_at = now + timeout
            record.terminal_error_code = (code or "provider_error").strip() or "provider_error"
            return record

    # -- completion ----------------------------------------------------------

    def complete_head(
        self, session_key: str
    ) -> Tuple[Optional[DispatchRecord], List[DispatchRecord], Optional[DispatchRecord]]:
        """Pop the active head (+ its merged riders — busy dispatches hermes
        coalesced into the carrier's single pending event); promote the next
        pending record to active. Returns (head, riders, promoted); riders
        get terminal activity only, never a duplicate commit."""
        with self._lock:
            return self._complete_head_locked(session_key)

    def complete_head_if_run(
        self, session_key: str, run_id: str
    ) -> Tuple[Optional[DispatchRecord], List[DispatchRecord], Optional[DispatchRecord]]:
        """Complete only when ``run_id`` still owns the active head."""
        with self._lock:
            head = self._head_locked(session_key)
            if head is None or head.run_id != run_id:
                return None, [], None
            return self._complete_head_locked(session_key)

    def complete_session_end_head(
        self, session_key: str
    ) -> Tuple[Optional[DispatchRecord], List[DispatchRecord], Optional[DispatchRecord]]:
        """Complete an on_session_end head and retain its correlation briefly.

        Hermes can invoke on_session_end before StreamConsumer's sole final
        send for short, unstreamed replies. Only this lifecycle completion
        path creates a late-send claim; other completion causes deliberately
        remain ineligible.
        """
        with self._lock:
            result = self._complete_head_locked(session_key)
            head = result[0]
            if head is not None:
                self._last_ended[session_key] = (head, self._now())
            return result

    def complete_stream_tail_head(
        self, session_key: str
    ) -> Tuple[Optional[DispatchRecord], List[DispatchRecord], Optional[DispatchRecord]]:
        """complete_head, but only when the head is an open unfinalized
        stream head (current message minted, not committed). Check + pop are
        one lock hold: the janitor sweep can complete heads from the event
        loop, so a separate head() probe would race it."""
        with self._lock:
            head = self._head_locked(session_key)
            if (
                head is None
                or head.current_message_id is None
                or head.current_committed
            ):
                return None, [], None
            return self._complete_head_locked(session_key)

    def pop_slash_head(
        self, session_key: str
    ) -> Tuple[Optional[DispatchRecord], List[DispatchRecord], Optional[DispatchRecord]]:
        """complete_head, but only when the active head is a slash record
        (their single-shot reply send is the completion signal — hermes slash
        turns fire no on_session_end)."""
        with self._lock:
            head = self._head_locked(session_key)
            if head is None or head.kind != KIND_SLASH:
                return None, [], None
            return self._complete_head_locked(session_key)

    def sweep_stale(
        self,
    ) -> List[Tuple[DispatchRecord, List[DispatchRecord], Optional[DispatchRecord]]]:
        """Close records whose turn shows no activity within the stale window
        (escaped-exception turns bypass finalize_turn — the janitor is the
        backstop so run-waiters reject instead of hanging forever)."""
        closed = []
        with self._lock:
            now = self._now()
            self._purge_last_ended_locked(now)
            cutoff = now - self._stale_after
            for session_key in list(self._sessions.keys()):
                head = self._head_locked(session_key)
                if head is None:
                    pending = self._pending_head_locked(session_key)
                    if pending is not None and pending.last_activity_at < cutoff:
                        pending.state = STATE_ACTIVE
                        closed.append(self._complete_head_locked(session_key, promote=False))
                    continue
                deadline = head.error_stale_deadline_at
                if deadline is not None and deadline <= now:
                    closed.append(self._complete_head_locked(session_key, promote=False))
                elif head.last_activity_at < cutoff:
                    closed.append(self._complete_head_locked(session_key))
        return [entry for entry in closed if entry[0] is not None]

    def discard_records(
        self, session_key: str, records: List[DispatchRecord]
    ) -> Tuple[List[DispatchRecord], Optional[DispatchRecord]]:
        """Remove specific records (failed dispatch cleanup). Returns
        (removed, promoted): only records STILL IN the ledger are removed —
        a fast slash part may have already completed via its reply send, and
        its runId must not receive a second (contradictory) terminal (Codex
        review W06 finding). Riders of removed carriers are removed with
        them. Removed records' idempotency entries are PURGED — a retried
        requestId after a failed dispatch must re-dispatch, never be
        replayed as accepted (Codex review W06 finding). When the active
        head was among the removed, the next pending record promotes (the
        caller emits its start)."""
        with self._lock:
            fifo = self._sessions.get(session_key, [])
            removed = []
            for record in records:
                if record in fifo:
                    fifo.remove(record)
                    removed.append(record)
                    removed.extend(record.riders)
                    record.riders.clear()
                    continue
                # A failed RIDER lives off-FIFO on its carrier — detach it
                # there or it would later be reported as successfully
                # completed with the carrier (Codex review W06 finding).
                for candidate in fifo:
                    if record in candidate.riders:
                        candidate.riders.remove(record)
                        removed.append(record)
                        break
            for record in removed:
                key = record.idempotency_key
                if key:
                    hit = self._idempotency.get(key)
                    if hit is not None and hit[0] is record:
                        del self._idempotency[key]
            promoted = None
            if not any(r.state == STATE_ACTIVE for r in fifo):
                for record in fifo:
                    if record.state == STATE_PENDING:
                        record.state = STATE_ACTIVE
                        record.last_activity_at = self._now()
                        promoted = record
                        break
            if not fifo:
                self._sessions.pop(session_key, None)
            return removed, promoted

    def purge_idempotency(self, records: List[DispatchRecord]) -> None:
        """Drop these records' idempotency entries regardless of ledger
        membership — a partially-failed SPLIT dispatch may have already
        completed the record that owns the caller's key (inline slash), and
        a retry must re-dispatch the whole request instead of replaying the
        completed part as accepted (Codex review W06 finding)."""
        with self._lock:
            for record in records:
                key = record.idempotency_key
                if key:
                    hit = self._idempotency.get(key)
                    if hit is not None and hit[0] is record:
                        del self._idempotency[key]

    def drain_session(self, session_key: str) -> List[DispatchRecord]:
        """Remove every ledger record for a cancelling/resetting session.

        Unlike complete_head(), this also drains the pending-only state created
        by an error-terminal sweep that deliberately did not promote a queued
        follow-up before real activity arrived.
        """
        with self._lock:
            self._last_ended.pop(session_key, None)
            fifo = self._sessions.pop(session_key, [])
            drained = []
            for record in fifo:
                drained.append(record)
                drained.extend(record.riders)
                record.riders.clear()
            return drained

    def pending_count(self) -> int:
        with self._lock:
            return sum(len(fifo) for fifo in self._sessions.values())

    def is_busy(self, session_key: str) -> bool:
        """Adapter-side busy signal (spec: busy OPEN comes from dispatch
        bookkeeping, NOT on_session_start). W08 injection + W12 wake-absorb
        consume this."""
        with self._lock:
            return any(
                record.state in (STATE_ACTIVE, STATE_PENDING)
                for record in self._sessions.get(session_key, [])
            )

    def take_lifecycle_start(self, record: DispatchRecord) -> bool:
        with self._lock:
            if not record.needs_lifecycle_start:
                return False
            record.needs_lifecycle_start = False
            return True

    # -- cancel fence (stale on_session_end guard) ----------------------------

    def arm_cancel_fence(self, session_key: str) -> None:
        with self._lock:
            self._cancel_fences[session_key] = self._now() + CANCEL_FENCE_TTL_SECONDS

    def cancel_fence_active(self, session_key: str) -> bool:
        """Non-consuming, TTL-bounded: while armed, EVERY on_session_end for
        the session gets the newest-carrier verification. Deliberately not
        one-shot — a legitimate post-reset end must not disarm the fence
        before a very late stale end from the cancelled turn arrives (Codex
        review W06 finding); the TTL is the only disarm."""
        with self._lock:
            expiry = self._cancel_fences.get(session_key)
            if expiry is None:
                return False
            if expiry <= self._now():
                del self._cancel_fences[session_key]
                return False
            return True

    # -- internals -----------------------------------------------------------

    def _head_locked(self, session_key: str) -> Optional[DispatchRecord]:
        for record in self._sessions.get(session_key, []):
            if record.state == STATE_ACTIVE:
                return record
        return None

    def _activity_head_locked(self, session_key: str) -> Optional[DispatchRecord]:
        head = self._head_locked(session_key)
        if head is not None:
            return head
        record = self._pending_head_locked(session_key)
        if record is None:
            return None
        record.state = STATE_ACTIVE
        record.last_activity_at = self._now()
        record.needs_lifecycle_start = True
        return record

    def _pending_head_locked(self, session_key: str) -> Optional[DispatchRecord]:
        for record in self._sessions.get(session_key, []):
            if record.state == STATE_PENDING:
                return record
        return None

    def _touch_record_locked(self, record: DispatchRecord) -> None:
        record.last_activity_at = self._now()
        record.error_stale_deadline_at = None
        record.terminal_error_code = None

    def _complete_head_locked(
        self, session_key: str, *, promote: bool = True
    ) -> Tuple[Optional[DispatchRecord], List[DispatchRecord], Optional[DispatchRecord]]:
        fifo = self._sessions.get(session_key, [])
        head = self._head_locked(session_key)
        if head is None:
            return None, [], None
        fifo.remove(head)
        riders = list(head.riders)
        head.riders.clear()
        promoted = None
        if promote:
            for record in fifo:
                if record.state == STATE_PENDING:
                    record.state = STATE_ACTIVE
                    record.last_activity_at = self._now()
                    promoted = record
                    break
        if not fifo:
            self._sessions.pop(session_key, None)
        return head, riders, promoted

    def _purge_idempotency_locked(self) -> None:
        now = self._now()
        expired = [k for k, (_, expiry) in self._idempotency.items() if expiry <= now]
        for key in expired:
            del self._idempotency[key]

    def _purge_last_ended_locked(self, now: float) -> None:
        expired = [
            session_key
            for session_key, (_, ended_at) in self._last_ended.items()
            if now - ended_at > self._ended_run_send_grace
        ]
        for session_key in expired:
            del self._last_ended[session_key]


# -- event payload builders (wire shapes; see PROTOCOL.md) --------------------


def lifecycle_start_activity(record: DispatchRecord) -> Dict[str, Any]:
    return {
        "state": "thinking",
        "origin": "lifecycle",
        "phase": "start",
        "runId": record.run_id,
        "sessionKey": record.public_key,
    }


def lifecycle_terminal_activity(
    record: DispatchRecord,
    *,
    completed: bool,
    interrupted: bool = False,
    code: Optional[str] = None,
) -> Dict[str, Any]:
    if completed:
        return {
            "state": "idle",
            "origin": "lifecycle",
            "phase": "end",
            "runId": record.run_id,
            "sessionKey": record.public_key,
        }
    return {
        "state": "error",
        "origin": "lifecycle",
        "phase": "error",
        "isError": True,
        "code": code or ("interrupted" if interrupted else "failed"),
        "runId": record.run_id,
        "sessionKey": record.public_key,
    }


def streaming_event(
    record: DispatchRecord,
    text: str,
    *,
    message_kind: Optional[str] = None,
) -> Dict[str, Any]:
    """One overlay paint of an assistant message's text-so-far.

    ``message_kind`` carries the SAME routing tag the eventual commit will
    carry, and it has to travel here too. Hermes commits an assistant message
    lazily — on a host with ``display.platforms.ocuclaw.tool_progress: false``
    there is no next ``send()`` until the turn's reply, so a progress note
    written before a 12-second tool is not committed for those 12 seconds.
    Routing only at commit time therefore leaves the note painted on the
    display for the whole tool no matter which routing the wearer chose, and
    all three ``agentProgressNotes`` settings look identical while it is up.
    """
    event: Dict[str, Any] = {
        "runId": record.run_id,
        "sessionKey": record.public_key,
        # CUMULATIVE by construction: the StreamConsumer hands the adapter the
        # full accumulated text on every send/edit (never deltas).
        "text": text,
        "rawAssistantChars": len(text),
        "firstGatewayChunk": record.stream_chunks <= 1,
    }
    if message_kind:
        event["messageKind"] = message_kind
    if record.current_message_id:
        event["messageId"] = record.current_message_id
    return event


def message_commit_event(
    record: DispatchRecord,
    text: str,
    *,
    turn_active: bool = False,
    message_kind: Optional[str] = None,
    origin_at_ms: Optional[int] = None,
    message_id: Optional[str] = None,
) -> Dict[str, Any]:
    """One committed assistant message.

    ``turn_active`` marks a commit that lands while the run is still open (a
    segment break, or a fresh send flushing the previous uncommitted message).
    Without it the consumer treats every runId-carrying commit as the end of
    the turn and tears the turn down mid-flight — status line blanked, thinking
    finalized — on any agent that writes more than one message per turn.

    ``message_kind`` is ROUTING only (``"narration"`` = a mid-turn sentence the
    agent wrote to the wearer, not part of its answer). It never decides turn
    lifecycle: an adapter running against a host with no narration hook emits
    the same commits untagged, and those turns must still behave.

    ``origin_at_ms`` is ORDERING only (#1619): wall-clock milliseconds at which
    the model produced this text, which for a narration commit is nowhere near
    when hermes committed it — hermes flushes an assistant message lazily on
    the next ``send()``, so on a tool turn the note commits after the tool
    progress line it announces. The consumer places the note at this position
    instead of at the end. Absent on every commit that is not narration.

    ``message_id`` is IDENTITY (#1691): the adapter-minted platform message id
    of THIS message — the same token hermes was handed back as
    ``SendResult.message_id`` and the same token ``DispatchLedger.note_edit``
    binds edits to. The Node consumer reads it as ``data.id`` and stamps the
    display entry ``idSource:"server"``. Without it every hermes assistant
    commit is ``derived``, and ONE derived entry drops the whole session to
    the legacy flattened-Pages fallback (#1685/#1690). It is deliberately NOT
    the hermes SessionDB row id: that id is minted by hermes' own persistence
    lane after this send returns and is unknowable at commit time — see
    PROTOCOL.md "Message identity on commits" for why the live and rehydrated
    namespaces are allowed to differ.
    """
    event: Dict[str, Any] = {
        "sessionKey": record.public_key,
        "runId": record.run_id,
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
    }
    if message_id:
        event["id"] = str(message_id)
    if turn_active:
        event["turnActive"] = True
    if message_kind:
        event["messageKind"] = message_kind
    if isinstance(origin_at_ms, int) and origin_at_ms > 0:
        event["originAtMs"] = origin_at_ms
    return event


def message_retag_event(
    record: DispatchRecord,
    text: str,
    *,
    message_kind: str = "narration",
    origin_at_ms: Optional[int] = None,
    message_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Correct the kind of an ALREADY-COMMITTED message.

    Rides the existing ``message`` event with ``retag:true`` because the
    child's bridge event names are frozen — and because a retag is a
    correction to a message, not a new lane. It carries no ``content``: the
    commit it corrects already delivered that.

    ``message_id`` (#1691) names the commit being corrected outright, so the
    consumer no longer has to guess. ``text`` (whitespace-normalized) stays on
    the wire as the FALLBACK match: a retag can name a message whose commit
    this adapter never minted an id for (a pre-#1691 host, or a commit that
    landed through a path with no ledger record), and the mid-reveal prefix
    upgrade is a text operation regardless — the retag carries the finished
    sentence the truncated commit is a prefix of.

    ``origin_at_ms`` rides along for the same reason it rides the commit: a
    retag that keeps the message (notes → conversation) must also move it back
    to where it belongs on the page (#1619).
    """
    event: Dict[str, Any] = {
        "retag": True,
        "sessionKey": record.public_key,
        "runId": record.run_id,
        "messageKind": message_kind,
        "text": " ".join(str(text or "").split()),
    }
    if message_id:
        event["id"] = str(message_id)
    if isinstance(origin_at_ms, int) and origin_at_ms > 0:
        event["originAtMs"] = origin_at_ms
    return event


def uncorrelated_message_event(
    session_identity: Dict[str, Any],
    text: str,
    *,
    message_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Delivery with no ledger record (cron deliver='origin', foreign-origin
    turns): the main-lane consumer reads runId null-tolerantly.

    It carries ``originAtMs`` = NOW, which never moves this message (its origin
    IS its commit position) but gives the consumer something to sort a later
    lazily-flushed commit against. Without it a tool OUTPUT — which arrives on
    this path — is an unstamped wall the tool-progress line cannot be spliced
    past, and the turn keeps reading note -> output -> command (#1619).

    It carries ``message_id`` for the same reason a correlated commit does
    (#1691): these messages are real conversation entries, and ONE of them
    without an id is enough to drop the whole session off ledgerV1. There is
    no dispatch record here, so the caller passes the id it minted for this
    send (or mints a fresh one).
    """
    event: Dict[str, Any] = {
        "sessionIdentity": dict(session_identity),
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "originAtMs": wall_clock_ms(),
    }
    if message_id:
        event["id"] = str(message_id)
    return event


def status_activity(
    session_identity: Dict[str, Any],
    event_type: str,
    message: str,
    *,
    status_key: Optional[str] = None,
    record: Optional[DispatchRecord] = None,
    label: Optional[str] = None,
    candidate_rank: Optional[str] = None,
) -> Dict[str, Any]:
    # origin "status" keeps notices off the terminal-boundary classifier
    # (isTerminalActivityBoundary requires origin=="lifecycle").
    payload: Dict[str, Any] = {
        "origin": "status",
        "state": event_type or "notice",
        "phase": "progress",
        "detail": message,
    }
    if status_key:
        payload["statusKey"] = status_key
    # A label makes the notice VISIBLE: the app's status presenter clears
    # label-less non-thinking slots (clear_non_visible_activity). Only the
    # notices the wearer must see carry one (the Desktop lease wait, #2510).
    if label:
        payload["label"] = label
    if candidate_rank:
        payload["candidateRank"] = candidate_rank
    if record is not None:
        payload["runId"] = record.run_id
        payload["sessionKey"] = record.public_key
    else:
        payload["sessionIdentity"] = dict(session_identity)
    return payload


def history_event(
    session_identity: Dict[str, Any],
    messages: List[Dict[str, Any]],
    *,
    public_key: Optional[str] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"messages": messages}
    if public_key:
        payload["sessionKey"] = public_key
    else:
        payload["sessionIdentity"] = dict(session_identity)
    return payload


def agent_end_hook_frame(
    session_identity: Dict[str, Any],
    messages: Optional[List[Dict[str, Any]]],
    *,
    public_key: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> Dict[str, Any]:
    ctx: Dict[str, Any] = {}
    if public_key:
        ctx["sessionKey"] = public_key
    else:
        ctx["sessionIdentity"] = dict(session_identity)
    if agent_id:
        ctx["agentId"] = agent_id
    # run_id is OPTIONAL — back-compat with older children that never sent
    # it. When present, it lets readAgentRunId report the exact
    # runIdSource "host_hook" instead of falling back to the relay-side
    # run tracker (#1525).
    if run_id:
        ctx["runId"] = run_id
    event: Dict[str, Any] = {}
    if messages is not None:
        event["messages"] = messages
    return {"name": "agent_end", "event": event, "ctx": ctx}


def parse_ocuclaw_session_key(session_key: str) -> Optional[Dict[str, str]]:
    """Native ``agent:<ns>:ocuclaw:dm:<chatId>`` → {ns, chatId}. Python may
    parse NATIVE keys (this is hermes's own grammar); the PUBLIC ``hermes:``
    grammar stays Node-owned."""
    parts = (session_key or "").split(":")
    if (
        len(parts) == 5
        and parts[0] == "agent"
        and parts[2] == "ocuclaw"
        and parts[3] == "dm"
        and parts[1]
        and parts[4]
    ):
        return {"ns": parts[1], "chatId": parts[4]}
    return None
