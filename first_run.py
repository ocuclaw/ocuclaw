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

FIRST_RUN_ATTEMPT_FILENAME = "ocuclaw.first-run-proof-attempt.json"
FIRST_RUN_PHONE_CANDIDATE_FILENAME = "ocuclaw.first-run-phone-candidate.json"
FIRST_RUN_LOCK_FILENAME = FIRST_RUN_BINDING_LOCK_FILENAME
FIRST_RUN_ATTEMPT_SCHEMA_VERSION = 1
FIRST_RUN_PHONE_CANDIDATE_SCHEMA_VERSION = 1
FIRST_RUN_ATTEMPT_RESUME_SECONDS = 60 * 60
FIRST_RUN_PROOF_METHOD = "phone-origin-g2-wearer-confirmed"
PHONE_ORIGIN_WAIT_SECONDS = 165.0
WELCOME_ROUND_TRIP_WAIT_SECONDS = 150.0
FIRST_RUN_WAIT_POLL_SECONDS = 0.1
PHONE_TURN_CANDIDATE_GATE_TTL_SECONDS = 60.0

WELCOME_SURFACE = {
    "kind": "text_surface",
    "template": "image_caption",
    "imageAsset": "hermes_welcome",
    "body": "Welcome to OcuClaw on Hermes",
    "timeoutMs": 60000,
}
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
    with receipt_state_lock(state_dir(resolved), FIRST_RUN_LOCK_FILENAME) as acquired:
        if not acquired:
            return {"state": "lock_unavailable", "recorded": False}
        try:
            write_json_receipt(path, body, durable=True)
        except ReceiptUnavailableError:
            return {"state": "write_failed", "recorded": False}
    return {"state": "ready", "recorded": True}


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
        or set(record) != _PHONE_CANDIDATE_KEYS
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
            }
        if state in {"unavailable", "unreadable", "malformed", "wrong_profile"}:
            return {"state": state, "received": False}
        if time.monotonic() >= deadline:
            return {"state": "timeout", "received": False}
        time.sleep(max(0.001, min(float(poll_seconds), deadline - time.monotonic())))


def is_welcome_surface(args: Any) -> bool:
    """Whether ``args`` is the exact locked Hermes Welcome surface."""

    if not isinstance(args, Mapping) or set(args) != set(WELCOME_SURFACE):
        return False
    return (
        all(args.get(key) == value for key, value in WELCOME_SURFACE.items())
        and type(args.get("timeoutMs")) is int
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
    if not isinstance(record, dict) or set(record) != _ATTEMPT_KEYS:
        return None, "malformed"
    if record.get("schemaVersion") != FIRST_RUN_ATTEMPT_SCHEMA_VERSION:
        return None, "unsupported_schema"
    return record, "ok"


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
) -> Dict[str, Any]:
    """Atomically create a fresh one-hour First-Run Proof Attempt."""

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
            "method": FIRST_RUN_PROOF_METHOD,
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
        proof = {
            "schemaVersion": FIRST_RUN_PROOF_SCHEMA_VERSION,
            "profileFingerprint": profile_fingerprint,
            "provenAt": proven_at,
            **bundle_identity,
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
            "method": FIRST_RUN_PROOF_METHOD,
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
        )


def arm_first_run_proof_from_candidate(
    *,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
    hermes_release: Optional[str],
    hermes_package_version: Optional[str],
    ocuclaw_version: Optional[str],
    expected_candidate_id: str,
) -> Dict[str, Any]:
    """Arm in the host process from the gateway's fingerprint-only receipt."""

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
    "WELCOME_DISMISSALS",
    "WELCOME_SURFACE",
    "arm_first_run_proof",
    "first_run_attempt_path",
    "inspect_attempt",
    "is_welcome_surface",
    "record_welcome_outcome",
    "wait_for_first_run_terminal",
    "wait_for_phone_turn_candidate",
]
