"""Hermes First-Run Proof completion journey (#1322 / #1268).

The public snapshot owns no mutation API.  This module is the single writer
for the private, profile-scoped attempt checkpoint and the durable proof
receipt.  A phone-origin/G2 confirmation arms an attempt; only the exact
Hermes welcome LiveUI surface returning a wearer dismissal can commit it.

Attempt and proof publication reuse :mod:`receipts`' platform-hardened atomic
primitives.  Core completion has no second record: it is derived from the
durable proof, so a crash cannot create "proof committed, completion missing"
split truth.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from .pairing_completion import read_pairing_completion
from .receipts import (
    FIRST_RUN_PROOF_SCHEMA_VERSION,
    FIRST_RUN_BINDING_LOCK_FILENAME,
    ReceiptAlreadyClaimedError,
    ReceiptUnavailableError,
    claim_json_receipt,
    fingerprint_home,
    first_run_proof_path,
    read_first_run_proof,
    receipt_state_lock,
    resolve_receipt_home,
    state_dir,
    write_json_receipt,
)
from .relay_credential import read_relay_credential_marker
from .welcome_plates import (
    HERMES_CLOUDWAYS_PLATE_BASE64,
    HERMES_PLATE_BASE64,
    PLATE_HEIGHT,
    PLATE_WIDTH,
)

FIRST_RUN_ATTEMPT_FILENAME = "ocuclaw.first-run-proof-attempt.json"
FIRST_RUN_PHONE_CANDIDATE_FILENAME = "ocuclaw.first-run-phone-candidate.json"
FIRST_RUN_REPLY_DELIVERY_FILENAME = "ocuclaw.first-run-reply-delivery.json"
FIRST_RUN_LOCK_FILENAME = FIRST_RUN_BINDING_LOCK_FILENAME
FIRST_RUN_ATTEMPT_SCHEMA_VERSION = 1
FIRST_RUN_PHONE_CANDIDATE_SCHEMA_VERSION = 1
FIRST_RUN_REPLY_DELIVERY_SCHEMA_VERSION = 1
FIRST_RUN_ATTEMPT_RESUME_SECONDS = 60 * 60
FIRST_RUN_PROOF_METHOD = "phone-origin-g2-wearer-confirmed"
#: The machine-evidence arming path's proof method. Deliberately a DIFFERENT
#: string from the wearer one: a reader must never have to guess which kind of
#: evidence a committed proof rests on, and the two must never be conflated.
FIRST_RUN_PROOF_METHOD_SDK_RECEIPT = "phone-origin-g2-sdk-receipt"
PHONE_ORIGIN_WAIT_SECONDS = 165.0
#: #3523. A slow hello gets one quiet re-wait inside the same tool call, so the
#: assistant never improvises chat between two waits.
PHONE_ORIGIN_REWAITS = 1
#: #3523. Hermes ends any one tool call at this many seconds. Every blocking
#: setup wait below must finish, with margin, inside it.
HERMES_TOOL_CALL_LIMIT_SECONDS = 420.0
#: #3523. The welcome wait covers the worst honest case: the gateway may hold
#: the welcome up to 30 s for the reply run (adapter
#: ``FIRST_RUN_WELCOME_REPLY_WAIT_SECONDS``), each card lasts 60 s
#: (``WELCOME_SURFACE["timeoutMs"]``) and the gateway re-renders it once. That
#: is 150 s of cards and hold alone, so a 150 s wait missed a tap on the second
#: card; 210 s leaves a minute for render and watcher latency.
WELCOME_ROUND_TRIP_WAIT_SECONDS = 210.0
FIRST_RUN_WAIT_POLL_SECONDS = 0.1
PHONE_TURN_CANDIDATE_GATE_TTL_SECONDS = 60.0

# -- reply-delivery evidence (#3030) ------------------------------------------
#
# The Node relay validates one client SDK receipt for the exact committed
# assistant reply of a phone-origin turn and reports it over the authenticated
# control link. This module joins that report to the CURRENT phone-turn
# candidate and persists a secret-free record beside the Attempt, under the
# same binding lock. The record is evidence that the originating phone's SDK
# accepted a slice of that reply — never that a wearer saw anything.

#: Which evidence armed a First-Run Proof Attempt. Historical records that
#: predate this field read as ``wearer_confirmed``; they are never rewritten.
REPLY_EVIDENCE_WEARER_CONFIRMED = "wearer_confirmed"
REPLY_EVIDENCE_CLIENT_SDK_RECEIPT = "client_sdk_receipt"
REPLY_EVIDENCE_VALUES = (
    REPLY_EVIDENCE_WEARER_CONFIRMED,
    REPLY_EVIDENCE_CLIENT_SDK_RECEIPT,
)

REPLY_DELIVERY_PENDING = "pending"
REPLY_DELIVERY_SDK_ACCEPTED = "sdk_accepted"
REPLY_DELIVERY_UNCONFIRMED = "unconfirmed"
REPLY_DELIVERY_UNSUPPORTED = "unsupported"
#: The statuses a Node report may carry. ``pending`` is an observation state,
#: never a reported outcome.
REPLY_DELIVERY_REPORT_STATUSES = (
    REPLY_DELIVERY_SDK_ACCEPTED,
    REPLY_DELIVERY_UNCONFIRMED,
    REPLY_DELIVERY_UNSUPPORTED,
)
REPLY_DELIVERY_STATUSES = (REPLY_DELIVERY_PENDING, *REPLY_DELIVERY_REPORT_STATUSES)

REPLY_DELIVERY_EVIDENCE_KIND = "client_sdk_receipt"
REPLY_DELIVERY_LANE_DEVICE = "device"
REPLY_DELIVERY_LANE_SIMULATOR = "simulator"
REPLY_DELIVERY_LANES = (REPLY_DELIVERY_LANE_DEVICE, REPLY_DELIVERY_LANE_SIMULATOR)

#: Test-lane marker. Simulator evidence must never arm a real installation, so
#: it qualifies only where an explicit test installation sets this to ``1``.
SIMULATOR_REPLY_EVIDENCE_ENV = "OCUCLAW_HERMES_ALLOW_SIMULATOR_REPLY_EVIDENCE"

#: Closed diagnostic vocabulary. A reason outside this set is recorded as
#: ``unspecified`` rather than passed through as prose.
REPLY_DELIVERY_REASONS = frozenset(
    {
        "attribution_unavailable",
        "binding_changed",
        "client_disconnected",
        "client_lacks_contract",
        "observation_expired",
        "record_unavailable",
        # #3232: the run itself errored, so its "reply" is the model's error
        # text. An errored run yields no receipt, whatever the glasses painted.
        "reply_run_errored",
        "reply_run_rate_limited",
        "runtime_lacks_contract",
        "runtime_unavailable",
        "sdk_write_failed",
        "sdk_write_timeout",
        "simulator_lane_not_eligible",
        "unspecified",
        "unsupported_reply_shape",
        "wait_timeout",
    }
)
REPLY_DELIVERY_REASON_UNSPECIFIED = "unspecified"
#: #3232. Reasons that say the agent RUN errored, so what the glasses painted
#: was the model's error text and there is no first reply to evidence. None of
#: these may record Core Setup Completion or arm the welcome, whatever status
#: rode alongside them.
REPLY_DELIVERY_ERRORED_RUN_REASONS = frozenset(
    {
        "reply_run_errored",
        "reply_run_rate_limited",
    }
)
REPLY_DELIVERY_REASON_MAX_CHARS = 64

REPLY_DELIVERY_OBSERVE_METHOD = "replyDelivery.observe"
REPLY_DELIVERY_REPORT_METHOD = "replyDelivery.report"
#: Node holds one 30 s deadline per observation (the wait for the ledger commit
#: and the probe share it); the host wait outlasts it so a reported outcome
#: always beats the host's bound.
REPLY_DELIVERY_WAIT_SECONDS = 40.0
REPLY_DELIVERY_OBSERVE_TIMEOUT_SECONDS = 35.0

_REPLY_DELIVERY_REPORT_KEYS = frozenset(
    {"candidateId", "status", "reason", "evidence"}
)
_REPLY_DELIVERY_EVIDENCE_KEYS = frozenset({"kind", "lane", "coveredChars"})
_REPLY_DELIVERY_KEYS = frozenset(
    {
        "schemaVersion",
        "profileFingerprint",
        "candidateId",
        "credentialGenerationId",
        "pairingCompletionId",
        "status",
        "reason",
        "evidence",
        "lane",
        "coveredChars",
        "receivedAt",
    }
)

def _welcome_surface(image_base64: str) -> Dict[str, Any]:
    return {
        "kind": "text_surface",
        "template": "image_caption",
        "title": "Double-tap to continue",
        "imageBase64": image_base64,
        "imageWidth": PLATE_WIDTH,
        "imageHeight": PLATE_HEIGHT,
        "body": "Welcome to OcuClaw on Hermes",
        "timeoutMs": 60000,
    }


# The collab lockup (#3187) rides inline: see welcome_plates for why.
WELCOME_SURFACE = _welcome_surface(HERMES_PLATE_BASE64)
WELCOME_SURFACE_CLOUDWAYS = _welcome_surface(HERMES_CLOUDWAYS_PLATE_BASE64)
WELCOME_SURFACES = (WELCOME_SURFACE, WELCOME_SURFACE_CLOUDWAYS)


def welcome_surface(*, cloudways: bool) -> Dict[str, Any]:
    """The locked welcome surface for this host, as a fresh dict."""

    return dict(WELCOME_SURFACE_CLOUDWAYS if cloudways else WELCOME_SURFACE)
WELCOME_DISMISSALS = frozenset({"dismissed", "back"})

_ATTEMPT_KEYS = frozenset(
    {
        "schemaVersion",
        "profileFingerprint",
        "armedAt",
        "expiresAt",
        "hermesRelease",
        "hermesPackageVersion",
        "ocuclawVersion",
        "credentialGenerationId",
        "pairingCompletionId",
        "sessionFingerprint",
        "turnFingerprint",
        "welcomeFailures",
    }
)
#: Added by #3030. A record written before it exists is still valid and reads
#: as wearer-confirmed; old records are never rewritten.
_ATTEMPT_OPTIONAL_KEYS = frozenset({"replyEvidence"})
_PHONE_CANDIDATE_KEYS = frozenset(
    {
        "schemaVersion",
        "profileFingerprint",
        "completedAt",
        "expiresAt",
        "sessionFingerprint",
        "turnFingerprint",
    }
)
#: #3392. Only on a candidate whose run the adapter closed as a provider error:
#: the run-outcome code, so the separate CLI process can name the failure and
#: its fix. A closed vocabulary; anything else is never written or read back.
_PHONE_CANDIDATE_OPTIONAL_KEYS = frozenset({"runErrorCode"})
PHONE_CANDIDATE_RUN_ERROR_CODES = frozenset(
    {
        "provider_auth_invalid",
        "provider_error",
        "provider_quota_exhausted",
        "provider_rate_limited",
    }
)


class PhoneTurnCandidateGate:
    """Join delivery and processing evidence for one exact phone turn.

    Hermes may report processing completion either before or after the
    platform's final message commit.  Neither signal proves a successful
    phone-origin round trip alone, so this bounded in-memory gate publishes
    exactly once only after both have arrived for the same session/run pair.
    Failed outcomes remain as tombstones until expiry so a late delivery
    cannot turn a failed run into a setup candidate.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = PHONE_TURN_CANDIDATE_GATE_TTL_SECONDS,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_seconds = max(1.0, float(ttl_seconds))
        self._now = now
        self._lock = threading.RLock()
        self._entries: Dict[Tuple[str, str], Dict[str, Any]] = {}

    def note_committed(self, session_key: str, run_id: str) -> bool:
        return self._note(session_key, run_id, committed=True)

    def note_processing(
        self, session_key: str, run_id: str, *, succeeded: bool
    ) -> bool:
        return self._note(session_key, run_id, succeeded=bool(succeeded))

    def note_errored(self, session_key: str, run_id: str) -> bool:
        """H11 (#3348). A non-retryable provider error still has a phone turn.

        The run failed, so it must never become a *successful* candidate, and
        the ``succeeded=False`` tombstone below still guarantees that. But the
        model's error text did reach the glasses, and the only surface that
        can tell the user "your message got through, the model did not answer"
        is this candidate's reply-delivery observation, which refuses it with
        ``reply_run_errored``. Publishing nothing would instead time the setup
        wait out as if the phone had never spoken.
        """
        return self._note(session_key, run_id, committed=True, errored=True)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def _note(
        self,
        session_key: str,
        run_id: str,
        *,
        committed: bool = False,
        succeeded: Optional[bool] = None,
        errored: bool = False,
    ) -> bool:
        session_key = str(session_key or "").strip()
        run_id = str(run_id or "").strip()
        if not session_key or not run_id:
            return False
        now = self._now()
        key = (session_key, run_id)
        with self._lock:
            expired = [
                candidate_key
                for candidate_key, entry in self._entries.items()
                if now - float(entry["touchedAt"]) > self._ttl_seconds
            ]
            for candidate_key in expired:
                del self._entries[candidate_key]
            entry = self._entries.setdefault(
                key,
                {
                    "committed": False,
                    "succeeded": None,
                    "published": False,
                    "touchedAt": now,
                },
            )
            entry["touchedAt"] = now
            if committed:
                entry["committed"] = True
            if succeeded is False or (
                succeeded is True and entry["succeeded"] is None
            ):
                # Failure is terminal for this run. A contradictory late or
                # duplicate callback must never reopen it.
                entry["succeeded"] = succeeded
            if errored:
                # H11: the run is terminal and failed. Tombstone it so no
                # later callback can publish it as a success, then publish it
                # once as the errored candidate the setup wait is waiting for.
                entry["succeeded"] = False
                if entry["committed"] and not entry["published"]:
                    entry["published"] = True
                    return True
                return False
            if (
                entry["committed"]
                and entry["succeeded"] is True
                and not entry["published"]
            ):
                entry["published"] = True
                return True
            return False


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _as_utc(value).isoformat()


def _parse_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _as_utc(parsed)


def _fingerprint(value: Any) -> Optional[str]:
    """One-way binding for opaque session/task identifiers.

    The raw identifiers never enter either receipt.  Empty or unavailable
    identifiers remain ``None`` instead of being guessed.
    """

    text = str(value or "").strip()
    if not text:
        return None
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def _bundle_identity(
    *,
    hermes_release: Optional[str],
    hermes_package_version: Optional[str],
    ocuclaw_version: Optional[str],
) -> Optional[Dict[str, str]]:
    values = {
        "hermesRelease": hermes_release,
        "hermesPackageVersion": hermes_package_version,
        "ocuclawVersion": ocuclaw_version,
    }
    if any(not isinstance(value, str) or not value.strip() for value in values.values()):
        return None
    return {key: str(value).strip() for key, value in values.items()}


def _binding_ids(home: Optional[Path]) -> Tuple[Optional[str], Optional[str]]:
    marker = read_relay_credential_marker(home)
    completion = read_pairing_completion(home)
    generation_id = (
        marker.get("generationId") if isinstance(marker, Mapping) else None
    )
    completion_id = (
        completion.get("completionId") if isinstance(completion, Mapping) else None
    )
    return (
        generation_id if isinstance(generation_id, str) else None,
        completion_id if isinstance(completion_id, str) else None,
    )


def first_run_attempt_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(home)
    return None if directory is None else directory / FIRST_RUN_ATTEMPT_FILENAME


def first_run_phone_candidate_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(home)
    return (
        None
        if directory is None
        else directory / FIRST_RUN_PHONE_CANDIDATE_FILENAME
    )


def _is_fingerprint(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in "0123456789abcdef" for char in value)
    )


def _phone_candidate_id(candidate: Mapping[str, Any]) -> str:
    """Return a secret-free opaque binding for one exact candidate receipt."""

    canonical = json.dumps(
        {
            "completedAt": candidate.get("completedAt"),
            "sessionFingerprint": candidate.get("sessionFingerprint"),
            "turnFingerprint": candidate.get("turnFingerprint"),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(
        ("ocuclaw-phone-candidate-v1\0" + canonical).encode("utf-8")
    ).hexdigest()


def record_phone_turn_candidate(
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    session_key: Optional[str],
    turn_id: Optional[str],
    run_error_code: Optional[str] = None,
) -> Dict[str, Any]:
    """Publish the latest delivered phone turn for a separate host CLI.

    The gateway and ``hermes`` CLI are different processes. Only one-way
    fingerprints cross that boundary; raw session and turn identifiers never
    enter profile state.
    """

    resolved = home if home is not None else resolve_receipt_home()
    profile_fingerprint = fingerprint_home(resolved)
    path = first_run_phone_candidate_path(resolved)
    session_fingerprint = _fingerprint(session_key)
    turn_fingerprint = _fingerprint(turn_id)
    if resolved is None or profile_fingerprint is None or path is None:
        return {"state": "unavailable", "recorded": False}
    if session_fingerprint is None or turn_fingerprint is None:
        return {"state": "turn_identity_unavailable", "recorded": False}
    completed_at = _as_utc(now or _utc_now())
    body = {
        "schemaVersion": FIRST_RUN_PHONE_CANDIDATE_SCHEMA_VERSION,
        "profileFingerprint": profile_fingerprint,
        "completedAt": _iso(completed_at),
        "expiresAt": _iso(
            completed_at + timedelta(seconds=FIRST_RUN_ATTEMPT_RESUME_SECONDS)
        ),
        "sessionFingerprint": session_fingerprint,
        "turnFingerprint": turn_fingerprint,
    }
    if run_error_code in PHONE_CANDIDATE_RUN_ERROR_CODES:
        # #3392. Not part of the candidate id: the binding stays the same
        # whatever the run's outcome was.
        body["runErrorCode"] = run_error_code
    with receipt_state_lock(state_dir(resolved), FIRST_RUN_LOCK_FILENAME) as acquired:
        if not acquired:
            return {"state": "lock_unavailable", "recorded": False}
        try:
            write_json_receipt(path, body, durable=True)
        except ReceiptUnavailableError:
            return {"state": "write_failed", "recorded": False}
    # The caller needs the binding it just wrote so it can ask the Node child
    # to observe delivery for this exact candidate. It is opaque and
    # secret-free; the raw session and turn identifiers stay in this process.
    return {
        "state": "ready",
        "recorded": True,
        "candidateId": _phone_candidate_id(body),
    }


def _read_phone_turn_candidate(
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    resolved = home if home is not None else resolve_receipt_home()
    profile_fingerprint = fingerprint_home(resolved)
    path = first_run_phone_candidate_path(resolved)
    if resolved is None or profile_fingerprint is None or path is None:
        return {"state": "unavailable"}
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"state": "missing"}
    except (OSError, UnicodeError, ValueError):
        return {"state": "unreadable"}
    if (
        not isinstance(record, dict)
        or not _PHONE_CANDIDATE_KEYS <= set(record)
        or not set(record) <= _PHONE_CANDIDATE_KEYS | _PHONE_CANDIDATE_OPTIONAL_KEYS
        or (
            "runErrorCode" in record
            and record["runErrorCode"] not in PHONE_CANDIDATE_RUN_ERROR_CODES
        )
        or record.get("schemaVersion")
        != FIRST_RUN_PHONE_CANDIDATE_SCHEMA_VERSION
    ):
        return {"state": "malformed"}
    if record.get("profileFingerprint") != profile_fingerprint:
        return {"state": "wrong_profile"}
    completed_at = _parse_time(record.get("completedAt"))
    expires_at = _parse_time(record.get("expiresAt"))
    if (
        completed_at is None
        or expires_at is None
        or expires_at
        != completed_at + timedelta(seconds=FIRST_RUN_ATTEMPT_RESUME_SECONDS)
        or not _is_fingerprint(record.get("sessionFingerprint"))
        or not _is_fingerprint(record.get("turnFingerprint"))
    ):
        return {"state": "malformed"}
    if _as_utc(now or _utc_now()) >= expires_at:
        return {"state": "expired"}
    return {
        "state": "ready",
        "completedAt": record["completedAt"],
        "sessionFingerprint": record["sessionFingerprint"],
        "turnFingerprint": record["turnFingerprint"],
        "candidateId": _phone_candidate_id(record),
        **({"runErrorCode": record["runErrorCode"]} if "runErrorCode" in record else {}),
    }


def wait_for_phone_turn_candidate(
    *,
    home: Optional[Path] = None,
    not_before: Optional[datetime] = None,
    timeout_seconds: float = PHONE_ORIGIN_WAIT_SECONDS,
    poll_seconds: float = FIRST_RUN_WAIT_POLL_SECONDS,
) -> Dict[str, Any]:
    """Wait for a newly completed phone-origin turn without exposing IDs."""

    threshold = _as_utc(not_before or _utc_now())
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    while True:
        candidate = _read_phone_turn_candidate(home=home)
        state = str(candidate.get("state") or "unavailable")
        completed_at = _parse_time(candidate.get("completedAt"))
        if state == "ready" and completed_at is not None and completed_at >= threshold:
            return {
                "state": "received",
                "received": True,
                "completedAt": candidate["completedAt"],
                "candidateId": candidate["candidateId"],
                # #3392. Present only when the adapter closed this run as errored.
                **({"runErrorCode": candidate["runErrorCode"]} if candidate.get("runErrorCode") else {}),
            }
        if state in {"unavailable", "unreadable", "malformed", "wrong_profile"}:
            return {"state": state, "received": False}
        if time.monotonic() >= deadline:
            return {"state": "timeout", "received": False}
        time.sleep(max(0.001, min(float(poll_seconds), deadline - time.monotonic())))


def wait_for_phone_origin(
    *,
    home: Optional[Path] = None,
    timeout_seconds: float = PHONE_ORIGIN_WAIT_SECONDS,
    poll_seconds: float = FIRST_RUN_WAIT_POLL_SECONDS,
    rewaits: int = PHONE_ORIGIN_REWAITS,
    on_rewait: Optional[Callable[[], Any]] = None,
) -> Dict[str, Any]:
    """The setup tool's hello wait: one bounded wait, then quiet re-waits (#3523).

    Only a plain ``timeout`` earns a re-wait; every other answer (a turn, or a
    receipt that cannot be read) returns at once. Every wait shares the first
    wait's start as its threshold, so a hello sent just before the first wait
    ended still counts. ``on_rewait`` runs before each re-wait (the adapter
    refreshes the phone's "send a message" hint there, whose TTL covers one
    wait). A result that needed a re-wait says ``rewaited: true``.
    """

    threshold = _utc_now()
    result = wait_for_phone_turn_candidate(
        home=home,
        not_before=threshold,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
    )
    for _ in range(max(0, int(rewaits))):
        if result.get("state") != "timeout":
            break
        if on_rewait is not None:
            on_rewait()
        result = wait_for_phone_turn_candidate(
            home=home,
            not_before=threshold,
            timeout_seconds=timeout_seconds,
            poll_seconds=poll_seconds,
        )
        result["rewaited"] = True
    return result


def reply_delivery_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(home)
    return (
        None
        if directory is None
        else directory / FIRST_RUN_REPLY_DELIVERY_FILENAME
    )


def _reason_code(value: Any) -> Optional[str]:
    """Project a reported reason onto the closed diagnostic vocabulary."""

    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text if text in REPLY_DELIVERY_REASONS else REPLY_DELIVERY_REASON_UNSPECIFIED


def validate_reply_delivery_report(
    params: Any,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Validate one ``replyDelivery.report`` payload as a closed shape.

    Returns ``(normalized, None)`` or ``(None, "invalid_params")``. Extra keys,
    wrong types, an out-of-range status or lane, and an evidence block that
    does not match the status are all refusals — a malformed report must never
    settle an observation.
    """

    if not isinstance(params, Mapping) or set(params) != _REPLY_DELIVERY_REPORT_KEYS:
        return None, "invalid_params"
    candidate_id = params.get("candidateId")
    if not _is_fingerprint(candidate_id):
        return None, "invalid_params"
    status = params.get("status")
    if status not in REPLY_DELIVERY_REPORT_STATUSES:
        return None, "invalid_params"
    reason = params.get("reason")
    if reason is not None and (
        not isinstance(reason, str)
        or not reason.strip()
        or len(reason) > REPLY_DELIVERY_REASON_MAX_CHARS
    ):
        return None, "invalid_params"
    evidence = params.get("evidence")
    accepted = status == REPLY_DELIVERY_SDK_ACCEPTED
    if accepted != isinstance(evidence, Mapping):
        # `evidence` is non-null iff the status is `sdk_accepted`.
        return None, "invalid_params"
    kind: Optional[str] = None
    lane: Optional[str] = None
    covered_chars: Optional[int] = None
    if accepted:
        if set(evidence) != _REPLY_DELIVERY_EVIDENCE_KEYS:
            return None, "invalid_params"
        kind = evidence.get("kind")
        lane = evidence.get("lane")
        covered_chars = evidence.get("coveredChars")
        if (
            kind != REPLY_DELIVERY_EVIDENCE_KIND
            or lane not in REPLY_DELIVERY_LANES
            or isinstance(covered_chars, bool)
            or not isinstance(covered_chars, int)
            or covered_chars <= 0
        ):
            return None, "invalid_params"
    return (
        {
            "candidate_id": candidate_id,
            "status": status,
            "reason": _reason_code(reason),
            "evidence": kind,
            "lane": lane,
            "covered_chars": covered_chars,
        },
        None,
    )


def _read_reply_delivery_record(
    path: Optional[Path], profile_fingerprint: Optional[str]
) -> Tuple[Optional[Dict[str, Any]], str]:
    if path is None or profile_fingerprint is None:
        return None, "unavailable"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "missing"
    except (OSError, UnicodeError, ValueError):
        return None, "unreadable"
    if (
        not isinstance(record, dict)
        or set(record) != _REPLY_DELIVERY_KEYS
        or record.get("schemaVersion") != FIRST_RUN_REPLY_DELIVERY_SCHEMA_VERSION
        or record.get("status") not in REPLY_DELIVERY_REPORT_STATUSES
        or not _is_fingerprint(record.get("candidateId"))
    ):
        return None, "malformed"
    if record.get("profileFingerprint") != profile_fingerprint:
        return None, "wrong_profile"
    return record, "ok"


def record_reply_delivery(
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    candidate_id: str,
    status: str,
    reason: Optional[str] = None,
    evidence: Optional[str] = None,
    lane: Optional[str] = None,
    covered_chars: Optional[int] = None,
) -> Dict[str, Any]:
    """Persist one observation for the CURRENT phone-turn candidate.

    Bound to the exact candidate by constant-time comparison: an unknown or
    already-replaced candidate is refused and nothing is written. A later
    ``sdk_accepted`` may upgrade a stored ``unconfirmed``/``unsupported`` for
    the same candidate; nothing downgrades a stored ``sdk_accepted``, and a
    repeat of the same observation is an idempotent no-op.
    """

    if status not in REPLY_DELIVERY_REPORT_STATUSES:
        return {"ok": False, "error": "invalid_params"}
    accepted = status == REPLY_DELIVERY_SDK_ACCEPTED
    if accepted:
        if (
            evidence != REPLY_DELIVERY_EVIDENCE_KIND
            or lane not in REPLY_DELIVERY_LANES
            or isinstance(covered_chars, bool)
            or not isinstance(covered_chars, int)
            or covered_chars <= 0
        ):
            return {"ok": False, "error": "invalid_params"}
    elif evidence is not None or lane is not None or covered_chars is not None:
        return {"ok": False, "error": "invalid_params"}

    resolved = home if home is not None else resolve_receipt_home()
    profile_fingerprint = fingerprint_home(resolved)
    path = reply_delivery_path(resolved)
    if resolved is None or profile_fingerprint is None or path is None:
        return {"ok": False, "error": "profile_unavailable"}

    with receipt_state_lock(state_dir(resolved), FIRST_RUN_LOCK_FILENAME) as acquired:
        if not acquired:
            return {"ok": False, "error": "lock_unavailable"}
        candidate = _read_phone_turn_candidate(home=resolved, now=now)
        if candidate.get("state") != "ready" or not hmac.compare_digest(
            str(candidate_id), str(candidate.get("candidateId") or "")
        ):
            # Unknown or replaced candidate: refuse, and persist nothing.
            return {"ok": False, "error": "candidate_unknown"}
        existing, existing_status = _read_reply_delivery_record(
            path, profile_fingerprint
        )
        if (
            existing_status == "ok"
            and existing is not None
            and hmac.compare_digest(
                str(existing.get("candidateId")), str(candidate_id)
            )
        ):
            if existing.get("status") == REPLY_DELIVERY_SDK_ACCEPTED and not accepted:
                return {"ok": True, "state": "retained"}
            if (
                existing.get("status") == status
                and existing.get("reason") == _reason_code(reason)
                and existing.get("evidence") == evidence
                and existing.get("lane") == lane
                and existing.get("coveredChars") == covered_chars
            ):
                return {"ok": True, "state": "duplicate"}
        generation_id, completion_id = _binding_ids(resolved)
        body = {
            "schemaVersion": FIRST_RUN_REPLY_DELIVERY_SCHEMA_VERSION,
            "profileFingerprint": profile_fingerprint,
            "candidateId": str(candidate_id),
            "credentialGenerationId": generation_id,
            "pairingCompletionId": completion_id,
            "status": status,
            "reason": _reason_code(reason),
            "evidence": evidence,
            "lane": lane,
            "coveredChars": covered_chars,
            "receivedAt": _iso(_as_utc(now or _utc_now())),
        }
        try:
            write_json_receipt(path, body, durable=True)
        except ReceiptUnavailableError:
            return {"ok": False, "error": "write_failed"}
    return {"ok": True, "state": "recorded"}


def _simulator_reply_evidence_allowed() -> bool:
    return str(os.environ.get(SIMULATOR_REPLY_EVIDENCE_ENV, "")).strip() == "1"


def _project_reply_delivery(
    *,
    home: Optional[Path],
    candidate_id: str,
) -> Dict[str, Any]:
    """Qualify the stored record against the exact candidate and bindings."""

    resolved = home if home is not None else resolve_receipt_home()
    profile_fingerprint = fingerprint_home(resolved)
    path = reply_delivery_path(resolved)
    record, status = _read_reply_delivery_record(path, profile_fingerprint)
    if status != "ok" or record is None:
        return {
            "eligible": False,
            "settled": False,
            "status": REPLY_DELIVERY_PENDING,
            "reason": None,
            "evidence": None,
            "lane": None,
        }
    if not hmac.compare_digest(
        str(record.get("candidateId")), str(candidate_id or "")
    ):
        # Another candidate's observation. Keep waiting for this one.
        return {
            "eligible": False,
            "settled": False,
            "status": REPLY_DELIVERY_PENDING,
            "reason": None,
            "evidence": None,
            "lane": None,
        }
    generation_id, completion_id = _binding_ids(resolved)
    if (
        record.get("credentialGenerationId") != generation_id
        or record.get("pairingCompletionId") != completion_id
    ):
        # Credential rotation, re-pair, reset or a profile change: the record
        # describes an installation that no longer exists.
        return {
            "eligible": False,
            "settled": True,
            "status": REPLY_DELIVERY_UNCONFIRMED,
            "reason": "binding_changed",
            "evidence": None,
            "lane": None,
        }
    lane = record.get("lane")
    if (
        record.get("status") == REPLY_DELIVERY_SDK_ACCEPTED
        and lane == REPLY_DELIVERY_LANE_SIMULATOR
        and not _simulator_reply_evidence_allowed()
    ):
        return {
            "eligible": False,
            "settled": True,
            "status": REPLY_DELIVERY_UNCONFIRMED,
            "reason": "simulator_lane_not_eligible",
            "evidence": None,
            "lane": REPLY_DELIVERY_LANE_SIMULATOR,
        }
    return {
        "eligible": record.get("status") == REPLY_DELIVERY_SDK_ACCEPTED,
        "settled": True,
        "status": record.get("status"),
        "reason": record.get("reason"),
        "evidence": record.get("evidence"),
        "lane": lane,
    }


def _reply_delivery_result(projection: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "status": projection["status"],
        "reason": projection["reason"],
        "evidence": projection["evidence"],
        "lane": projection["lane"],
    }


def wait_for_reply_delivery(
    *,
    home: Optional[Path] = None,
    candidate_id: str,
    timeout_seconds: float = REPLY_DELIVERY_WAIT_SECONDS,
    poll_seconds: float = FIRST_RUN_WAIT_POLL_SECONDS,
) -> Dict[str, Any]:
    """Bounded poll for this candidate's reply-delivery observation.

    Never restarts the phone-origin wait and never mutates anything: an
    expired bound simply reports ``unconfirmed``/``wait_timeout``, and the
    same candidate still arms through the wearer path afterwards.
    """

    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    while True:
        projection = _project_reply_delivery(home=home, candidate_id=candidate_id)
        if projection["settled"]:
            return _reply_delivery_result(projection)
        if time.monotonic() >= deadline:
            return {
                "status": REPLY_DELIVERY_UNCONFIRMED,
                "reason": "wait_timeout",
                "evidence": None,
                "lane": None,
            }
        time.sleep(max(0.001, min(float(poll_seconds), deadline - time.monotonic())))


def is_welcome_surface(args: Any) -> bool:
    """Whether ``args`` is exactly one of the locked Hermes Welcome surfaces."""

    if not isinstance(args, Mapping) or type(args.get("timeoutMs")) is not int:
        return False
    return any(
        set(args) == set(surface)
        and all(args.get(key) == value for key, value in surface.items())
        for surface in WELCOME_SURFACES
    )


def _read_attempt(path: Optional[Path]) -> Tuple[Optional[Dict[str, Any]], str]:
    if path is None:
        return None, "unavailable"
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, "missing"
    except (OSError, UnicodeError):
        return None, "unreadable"
    try:
        record = json.loads(raw)
    except ValueError:
        return None, "unreadable"
    if (
        not isinstance(record, dict)
        or set(record) - _ATTEMPT_OPTIONAL_KEYS != _ATTEMPT_KEYS
        or (
            "replyEvidence" in record
            and record["replyEvidence"] not in REPLY_EVIDENCE_VALUES
        )
    ):
        return None, "malformed"
    if record.get("schemaVersion") != FIRST_RUN_ATTEMPT_SCHEMA_VERSION:
        return None, "unsupported_schema"
    return record, "ok"


def _reply_evidence_of(record: Any) -> str:
    """The evidence discriminator, defaulting historical records to the wearer.

    A record written before #3030 carries no field. Reading it as
    ``wearer_confirmed`` is the only compatible reading: those attempts and
    proofs were armed by a wearer answering the display question.
    """

    if not isinstance(record, Mapping):
        return REPLY_EVIDENCE_WEARER_CONFIRMED
    value = record.get("replyEvidence")
    return (
        value if value in REPLY_EVIDENCE_VALUES else REPLY_EVIDENCE_WEARER_CONFIRMED
    )


def _proof_method_for(record: Any) -> str:
    return (
        FIRST_RUN_PROOF_METHOD_SDK_RECEIPT
        if _reply_evidence_of(record) == REPLY_EVIDENCE_CLIENT_SDK_RECEIPT
        else FIRST_RUN_PROOF_METHOD
    )


def _proof_is_committed(record: Any) -> bool:
    return (
        isinstance(record, Mapping) and _parse_time(record.get("provenAt")) is not None
    )


def inspect_attempt(
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    hermes_release: Optional[str] = None,
    hermes_package_version: Optional[str] = None,
    ocuclaw_version: Optional[str] = None,
    session_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Read and qualify the resumable checkpoint without mutating it."""

    resolved = home if home is not None else resolve_receipt_home()
    profile_fingerprint = fingerprint_home(resolved)
    if resolved is None or profile_fingerprint is None:
        return {"state": "unavailable", "committed": False, "resumeAllowed": False}

    proof, proof_status = read_first_run_proof(profile_fingerprint, home=resolved)
    if proof_status == "ok" and _proof_is_committed(proof):
        return {
            "state": "committed",
            "committed": True,
            "resumeAllowed": False,
            "provenAt": proof.get("provenAt"),
            "replyEvidence": _reply_evidence_of(proof),
        }
    if proof_status != "missing":
        return {
            "state": "proof_unavailable",
            "committed": False,
            "resumeAllowed": False,
        }

    record, status = _read_attempt(first_run_attempt_path(resolved))
    if status == "missing":
        return {"state": "missing", "committed": False, "resumeAllowed": False}
    if status != "ok" or record is None:
        return {
            "state": status,
            "committed": False,
            "resumeAllowed": False,
        }
    if record.get("profileFingerprint") != profile_fingerprint:
        return {
            "state": "wrong_profile",
            "committed": False,
            "resumeAllowed": False,
        }

    current = _as_utc(now or _utc_now())
    armed_at = _parse_time(record.get("armedAt"))
    expires_at = _parse_time(record.get("expiresAt"))
    if (
        armed_at is None
        or expires_at is None
        or expires_at != armed_at + timedelta(seconds=FIRST_RUN_ATTEMPT_RESUME_SECONDS)
    ):
        return {
            "state": "malformed",
            "committed": False,
            "resumeAllowed": False,
        }
    if current >= expires_at:
        return {
            "state": "expired",
            "committed": False,
            "resumeAllowed": False,
            "expiredAt": _iso(expires_at),
        }

    expected_bundle = _bundle_identity(
        hermes_release=hermes_release,
        hermes_package_version=hermes_package_version,
        ocuclaw_version=ocuclaw_version,
    )
    if expected_bundle is None:
        return {
            "state": "bundle_unavailable",
            "committed": False,
            "resumeAllowed": False,
        }
    if any(record.get(key) != value for key, value in expected_bundle.items()):
        return {
            "state": "bundle_changed",
            "committed": False,
            "resumeAllowed": False,
        }

    expected_session = _fingerprint(session_key)
    if (
        expected_session is not None
        and record.get("sessionFingerprint") != expected_session
    ):
        return {
            "state": "session_changed",
            "committed": False,
            "resumeAllowed": False,
        }

    failures = record.get("welcomeFailures")
    if isinstance(failures, bool) or not isinstance(failures, int) or failures < 0:
        return {
            "state": "malformed",
            "committed": False,
            "resumeAllowed": False,
        }
    if failures >= 2:
        return {
            "state": "failed",
            "committed": False,
            "resumeAllowed": False,
            "welcomeFailures": failures,
            "warningRequired": True,
        }

    generation_id, completion_id = _binding_ids(resolved)
    if record.get("credentialGenerationId") != generation_id:
        return {
            "state": "credential_generation_changed",
            "committed": False,
            "resumeAllowed": False,
            "welcomeFailures": failures,
        }
    if record.get("pairingCompletionId") != completion_id:
        return {
            "state": "pairing_completion_changed",
            "committed": False,
            "resumeAllowed": False,
            "welcomeFailures": failures,
        }
    return {
        "state": "armed",
        "committed": False,
        "resumeAllowed": True,
        "armedAt": record["armedAt"],
        "expiresAt": record["expiresAt"],
        "welcomeFailures": failures,
        "retryAllowed": failures == 1,
        "replyEvidence": _reply_evidence_of(record),
    }


def wait_for_first_run_terminal(
    *,
    home: Optional[Path] = None,
    timeout_seconds: float = WELCOME_ROUND_TRIP_WAIT_SECONDS,
    poll_seconds: float = FIRST_RUN_WAIT_POLL_SECONDS,
    hermes_release: Optional[str],
    hermes_package_version: Optional[str],
    ocuclaw_version: Optional[str],
) -> Dict[str, Any]:
    """Wait for the managed gateway to commit or close the welcome attempt."""

    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    while True:
        state = inspect_attempt(
            home=home,
            hermes_release=hermes_release,
            hermes_package_version=hermes_package_version,
            ocuclaw_version=ocuclaw_version,
            session_key=None,
        )
        if state.get("committed") is True or state.get("state") != "armed":
            return state
        if time.monotonic() >= deadline:
            return {
                "state": "timeout",
                "committed": False,
                "resumeAllowed": True,
                "retryAllowed": state.get("retryAllowed") is True,
            }
        time.sleep(max(0.001, min(float(poll_seconds), deadline - time.monotonic())))


def _arm_first_run_proof_unlocked(
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    hermes_release: Optional[str],
    hermes_package_version: Optional[str],
    ocuclaw_version: Optional[str],
    session_key: Optional[str],
    turn_id: Optional[str],
    session_fingerprint: Optional[str] = None,
    turn_fingerprint: Optional[str] = None,
    reply_evidence: str = REPLY_EVIDENCE_WEARER_CONFIRMED,
) -> Dict[str, Any]:
    """Atomically create a fresh one-hour First-Run Proof Attempt."""

    if reply_evidence not in REPLY_EVIDENCE_VALUES:
        return {
            "state": "reply_evidence_invalid",
            "armed": False,
            "committed": False,
        }

    resolved = home if home is not None else resolve_receipt_home()
    profile_fingerprint = fingerprint_home(resolved)
    path = first_run_attempt_path(resolved)
    if resolved is None or profile_fingerprint is None or path is None:
        raise ReceiptUnavailableError("no profile-scoped Hermes home resolved")

    bundle_identity = _bundle_identity(
        hermes_release=hermes_release,
        hermes_package_version=hermes_package_version,
        ocuclaw_version=ocuclaw_version,
    )
    if bundle_identity is None:
        return {
            "state": "bundle_unavailable",
            "armed": False,
            "committed": False,
        }
    raw_session_fingerprint = _fingerprint(session_key)
    raw_turn_fingerprint = _fingerprint(turn_id)
    if raw_session_fingerprint is not None:
        session_fingerprint = raw_session_fingerprint
    if raw_turn_fingerprint is not None:
        turn_fingerprint = raw_turn_fingerprint
    if session_fingerprint is None or turn_fingerprint is None:
        return {
            "state": "turn_identity_unavailable",
            "armed": False,
            "committed": False,
        }
    if not _is_fingerprint(session_fingerprint) or not _is_fingerprint(
        turn_fingerprint
    ):
        return {
            "state": "turn_identity_invalid",
            "armed": False,
            "committed": False,
        }

    proof, proof_status = read_first_run_proof(profile_fingerprint, home=resolved)
    if proof_status == "ok" and _proof_is_committed(proof):
        return {
            "state": "committed",
            "armed": False,
            "committed": True,
            "provenAt": proof.get("provenAt"),
        }
    if proof_status != "missing":
        return {
            "state": "proof_unavailable",
            "armed": False,
            "committed": False,
        }

    existing, existing_status = _read_attempt(path)
    if existing_status == "ok" and existing is not None:
        existing_state = inspect_attempt(
            home=resolved,
            now=now,
            hermes_release=hermes_release,
            hermes_package_version=hermes_package_version,
            ocuclaw_version=ocuclaw_version,
            session_key=session_key,
        )
        if existing_state.get("state") == "armed":
            return {
                "state": "armed",
                "armed": True,
                "committed": False,
                "armedAt": existing["armedAt"],
                "expiresAt": existing["expiresAt"],
                "resumeAllowed": True,
                "welcomeFailures": existing["welcomeFailures"],
                "alreadyArmed": True,
                "replyEvidence": _reply_evidence_of(existing),
            }
        if existing.get("turnFingerprint") == turn_fingerprint:
            return {
                "state": existing_state.get("state"),
                "armed": False,
                "committed": False,
                "restartRequired": True,
                "reason": "new_phone_origin_turn_required",
            }
    # An invalid Attempt is ephemeral and non-authoritative. A newly confirmed
    # phone-origin turn may replace it under the state lock; otherwise a
    # truncated or future-incompatible checkpoint could strand setup forever.

    armed_at = _as_utc(now or _utc_now())
    expires_at = armed_at + timedelta(seconds=FIRST_RUN_ATTEMPT_RESUME_SECONDS)
    generation_id, completion_id = _binding_ids(resolved)
    body = {
        "schemaVersion": FIRST_RUN_ATTEMPT_SCHEMA_VERSION,
        "profileFingerprint": profile_fingerprint,
        "armedAt": _iso(armed_at),
        "expiresAt": _iso(expires_at),
        **bundle_identity,
        "credentialGenerationId": generation_id,
        "pairingCompletionId": completion_id,
        "sessionFingerprint": session_fingerprint,
        "turnFingerprint": turn_fingerprint,
        "welcomeFailures": 0,
        # Which evidence armed this Attempt. Machine evidence never sets, nor
        # implies, wearer confirmation; there is no wearer field to set.
        "replyEvidence": reply_evidence,
    }
    try:
        write_json_receipt(path, body, durable=True)
    except ReceiptUnavailableError:
        return {
            "state": "write_failed",
            "armed": False,
            "committed": False,
            "reason": "attempt_write_failed",
        }
    return {
        "state": "armed",
        "armed": True,
        "committed": False,
        "armedAt": body["armedAt"],
        "expiresAt": body["expiresAt"],
        "resumeAllowed": True,
        "replyEvidence": reply_evidence,
    }


def _remove_attempt(path: Optional[Path]) -> None:
    if path is None:
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        # Proof is already durable and is the authoritative completion truth;
        # a stale attempt is harmless and readers always check proof first.
        pass


def _record_attempt_failure(
    path: Path,
    record: Mapping[str, Any],
    *,
    outcome: str,
    reason: str,
) -> Dict[str, Any]:
    failures = int(record["welcomeFailures"]) + 1
    updated = {**record, "welcomeFailures": failures}
    try:
        write_json_receipt(path, updated, durable=True)
    except ReceiptUnavailableError:
        return {
            "state": "write_failed",
            "committed": False,
            "reason": "attempt_write_failed",
        }
    return {
        "state": "armed" if failures == 1 else "failed",
        "committed": False,
        "outcome": outcome or "missing",
        "welcomeFailures": failures,
        "retryAllowed": failures == 1,
        "warningRequired": failures >= 2,
        "reason": reason,
    }


def _record_welcome_outcome_unlocked(
    outcome: Any,
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    hermes_release: Optional[str],
    hermes_package_version: Optional[str],
    ocuclaw_version: Optional[str],
    session_key: Optional[str],
) -> Dict[str, Any]:
    """Commit on a live dismissal, otherwise advance the one-retry state."""

    resolved = home if home is not None else resolve_receipt_home()
    profile_fingerprint = fingerprint_home(resolved)
    attempt_path = first_run_attempt_path(resolved)
    proof_path = first_run_proof_path(resolved)
    if (
        resolved is None
        or profile_fingerprint is None
        or attempt_path is None
        or proof_path is None
    ):
        return {
            "state": "unavailable",
            "committed": False,
            "reason": "profile_unavailable",
        }

    outcome_name = str(outcome or "").strip()
    status = inspect_attempt(
        home=resolved,
        now=now,
        hermes_release=hermes_release,
        hermes_package_version=hermes_package_version,
        ocuclaw_version=ocuclaw_version,
        session_key=session_key,
    )
    if status.get("committed") is True:
        return {
            "state": "committed",
            "committed": True,
            "provenAt": status.get("provenAt"),
            "method": (
                FIRST_RUN_PROOF_METHOD_SDK_RECEIPT
                if status.get("replyEvidence") == REPLY_EVIDENCE_CLIENT_SDK_RECEIPT
                else FIRST_RUN_PROOF_METHOD
            ),
            "alreadyCommitted": True,
        }
    binding_state = status.get("state")
    if binding_state in {
        "credential_generation_changed",
        "pairing_completion_changed",
    }:
        record, record_status = _read_attempt(attempt_path)
        if record_status != "ok" or record is None:
            return {
                "state": record_status,
                "committed": False,
                "reason": f"attempt_{record_status}",
            }
        return _record_attempt_failure(
            attempt_path,
            record,
            outcome=outcome_name,
            reason=f"attempt_{binding_state}",
        )
    if status.get("state") != "armed":
        return {
            **status,
            "committed": False,
            "reason": f"attempt_{status.get('state')}",
        }

    record, record_status = _read_attempt(attempt_path)
    if record_status != "ok" or record is None:
        return {
            "state": record_status,
            "committed": False,
            "reason": f"attempt_{record_status}",
        }

    bundle_identity = _bundle_identity(
        hermes_release=hermes_release,
        hermes_package_version=hermes_package_version,
        ocuclaw_version=ocuclaw_version,
    )
    if bundle_identity is None:
        return {
            "state": "bundle_unavailable",
            "committed": False,
            "reason": "attempt_bundle_unavailable",
        }
    if any(record.get(key) != value for key, value in bundle_identity.items()):
        return {
            "state": "bundle_changed",
            "committed": False,
            "reason": "attempt_bundle_changed",
        }

    if outcome_name in WELCOME_DISMISSALS:
        proven_at = _iso(_as_utc(now or _utc_now()))
        reply_evidence = _reply_evidence_of(record)
        proof = {
            "schemaVersion": FIRST_RUN_PROOF_SCHEMA_VERSION,
            "profileFingerprint": profile_fingerprint,
            "provenAt": proven_at,
            **bundle_identity,
            # Carried from the Attempt so the durable record states which
            # evidence armed it rather than leaving a reader to assume.
            "replyEvidence": reply_evidence,
        }
        try:
            claim_json_receipt(proof_path, proof)
        except ReceiptAlreadyClaimedError:
            existing, existing_status = read_first_run_proof(
                profile_fingerprint, home=resolved
            )
            if existing_status != "ok" or not _proof_is_committed(existing):
                return {
                    "state": "proof_unavailable",
                    "committed": False,
                    "reason": "proof_claim_race_unreadable",
                }
            proven_at = existing.get("provenAt")
            reply_evidence = _reply_evidence_of(existing)
        except ReceiptUnavailableError:
            return {
                "state": "write_failed",
                "committed": False,
                "reason": "proof_write_failed",
            }
        _remove_attempt(attempt_path)
        return {
            "state": "committed",
            "committed": True,
            "provenAt": proven_at,
            "method": (
                FIRST_RUN_PROOF_METHOD_SDK_RECEIPT
                if reply_evidence == REPLY_EVIDENCE_CLIENT_SDK_RECEIPT
                else FIRST_RUN_PROOF_METHOD
            ),
        }

    return _record_attempt_failure(
        attempt_path,
        record,
        outcome=outcome_name,
        reason="welcome_dismissal_unconfirmed",
    )


def arm_first_run_proof(
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    hermes_release: Optional[str],
    hermes_package_version: Optional[str],
    ocuclaw_version: Optional[str],
    session_key: Optional[str],
    turn_id: Optional[str],
    reply_evidence: str = REPLY_EVIDENCE_WEARER_CONFIRMED,
) -> Dict[str, Any]:
    """Serialize and atomically arm one First-Run Proof Attempt."""

    resolved = home if home is not None else resolve_receipt_home()
    with receipt_state_lock(state_dir(resolved), FIRST_RUN_LOCK_FILENAME) as acquired:
        if not acquired:
            return {
                "state": "lock_unavailable",
                "armed": False,
                "committed": False,
            }
        return _arm_first_run_proof_unlocked(
            home=resolved,
            now=now,
            hermes_release=hermes_release,
            hermes_package_version=hermes_package_version,
            ocuclaw_version=ocuclaw_version,
            session_key=session_key,
            turn_id=turn_id,
            reply_evidence=reply_evidence,
        )


def _errored_run_refusal(
    *,
    home: Optional[Path],
    candidate: Mapping[str, Any],
    candidate_id: str,
) -> Optional[Dict[str, Any]]:
    """The #3468 refusal when this candidate's run errored, else ``None``.

    Either signal is enough: the adapter's ``runErrorCode`` on the candidate,
    or the phone's delivery observation naming an errored run.
    """

    run_error_code = candidate.get("runErrorCode") or None
    reason = _project_reply_delivery(home=home, candidate_id=candidate_id).get(
        "reason"
    )
    errored_reason = reason if reason in REPLY_DELIVERY_ERRORED_RUN_REASONS else None
    if run_error_code is None and errored_reason is None:
        return None
    return {
        "state": "reply_run_errored",
        "armed": False,
        "committed": False,
        "replyWasProviderError": True,
        "runErrorCode": run_error_code,
        "reason": errored_reason or "reply_run_errored",
    }


def phone_turn_run_error_code(
    candidate_id: str,
    *,
    home: Optional[Path] = None,
) -> Optional[str]:
    """The adapter's error code for this exact candidate's run, if any."""

    candidate = _read_phone_turn_candidate(home=home)
    if candidate.get("state") != "ready" or not hmac.compare_digest(
        str(candidate_id or ""), str(candidate.get("candidateId") or "")
    ):
        return None
    return candidate.get("runErrorCode") or None


def arm_first_run_proof_from_candidate(
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    hermes_release: Optional[str],
    hermes_package_version: Optional[str],
    ocuclaw_version: Optional[str],
    expected_candidate_id: str,
    reply_evidence: str = REPLY_EVIDENCE_WEARER_CONFIRMED,
) -> Dict[str, Any]:
    """Arm in the host process from the gateway's fingerprint-only receipt.

    ``reply_evidence`` names which path the caller is claiming. The wearer
    path is unchanged. ``client_sdk_receipt`` is refused unless this exact
    candidate already has an eligible ``sdk_accepted`` observation, so a
    caller can never assert machine evidence it does not have. A candidate
    whose run errored is refused on BOTH paths (#3468): state
    ``reply_run_errored``, ``replyWasProviderError: True``, nothing written.
    """

    resolved = home if home is not None else resolve_receipt_home()
    with receipt_state_lock(state_dir(resolved), FIRST_RUN_LOCK_FILENAME) as acquired:
        if not acquired:
            return {
                "state": "lock_unavailable",
                "armed": False,
                "committed": False,
            }
        candidate = _read_phone_turn_candidate(home=resolved, now=now)
        if candidate.get("state") != "ready":
            return {
                "state": f"phone_turn_{candidate.get('state')}",
                "armed": False,
                "committed": False,
            }
        if not hmac.compare_digest(
            str(expected_candidate_id), str(candidate.get("candidateId") or "")
        ):
            return {
                "state": "phone_turn_replaced",
                "armed": False,
                "committed": False,
            }
        # #3468. A provider-error reply never proves setup, whatever evidence
        # the caller claims: the wearer saw the model's error text, and an
        # errored run has no receipt worth the name. Checked before either
        # evidence path, so nothing is written for this turn.
        errored = _errored_run_refusal(
            home=resolved,
            candidate=candidate,
            candidate_id=expected_candidate_id,
        )
        if errored is not None:
            return errored
        if reply_evidence == REPLY_EVIDENCE_CLIENT_SDK_RECEIPT:
            projection = _project_reply_delivery(
                home=resolved, candidate_id=expected_candidate_id
            )
            if not projection["eligible"]:
                return {
                    "state": "reply_evidence_unavailable",
                    "armed": False,
                    "committed": False,
                    "reason": projection["reason"] or "record_unavailable",
                }
        return _arm_first_run_proof_unlocked(
            home=resolved,
            now=now,
            hermes_release=hermes_release,
            hermes_package_version=hermes_package_version,
            ocuclaw_version=ocuclaw_version,
            session_key=None,
            turn_id=None,
            session_fingerprint=candidate["sessionFingerprint"],
            turn_fingerprint=candidate["turnFingerprint"],
            reply_evidence=reply_evidence,
        )


def record_welcome_outcome(
    outcome: Any,
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    hermes_release: Optional[str],
    hermes_package_version: Optional[str],
    ocuclaw_version: Optional[str],
    session_key: Optional[str],
) -> Dict[str, Any]:
    """Serialize one welcome result with the attempt and proof receipts."""

    resolved = home if home is not None else resolve_receipt_home()
    with receipt_state_lock(state_dir(resolved), FIRST_RUN_LOCK_FILENAME) as acquired:
        if not acquired:
            return {
                "state": "lock_unavailable",
                "committed": False,
                "reason": "proof_lock_unavailable",
            }
        return _record_welcome_outcome_unlocked(
            outcome,
            home=resolved,
            now=now,
            hermes_release=hermes_release,
            hermes_package_version=hermes_package_version,
            ocuclaw_version=ocuclaw_version,
            session_key=session_key,
        )


__all__ = [
    "FIRST_RUN_ATTEMPT_FILENAME",
    "FIRST_RUN_LOCK_FILENAME",
    "FIRST_RUN_ATTEMPT_RESUME_SECONDS",
    "FIRST_RUN_PROOF_METHOD",
    "FIRST_RUN_PROOF_METHOD_SDK_RECEIPT",
    "FIRST_RUN_REPLY_DELIVERY_FILENAME",
    "REPLY_DELIVERY_ERRORED_RUN_REASONS",
    "REPLY_DELIVERY_OBSERVE_METHOD",
    "REPLY_DELIVERY_REPORT_METHOD",
    "REPLY_DELIVERY_OBSERVE_TIMEOUT_SECONDS",
    "REPLY_DELIVERY_PENDING",
    "REPLY_DELIVERY_SDK_ACCEPTED",
    "REPLY_DELIVERY_UNCONFIRMED",
    "REPLY_DELIVERY_UNSUPPORTED",
    "REPLY_DELIVERY_WAIT_SECONDS",
    "REPLY_EVIDENCE_CLIENT_SDK_RECEIPT",
    "REPLY_EVIDENCE_VALUES",
    "REPLY_EVIDENCE_WEARER_CONFIRMED",
    "SIMULATOR_REPLY_EVIDENCE_ENV",
    "WELCOME_DISMISSALS",
    "WELCOME_SURFACE",
    "WELCOME_SURFACES",
    "WELCOME_SURFACE_CLOUDWAYS",
    "arm_first_run_proof",
    "first_run_attempt_path",
    "inspect_attempt",
    "is_welcome_surface",
    "phone_turn_run_error_code",
    "record_reply_delivery",
    "record_welcome_outcome",
    "reply_delivery_path",
    "validate_reply_delivery_report",
    "wait_for_first_run_terminal",
    "wait_for_phone_origin",
    "wait_for_phone_turn_candidate",
    "wait_for_reply_delivery",
    "welcome_surface",
]
