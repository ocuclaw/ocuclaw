"""Host-owned Relay Credential lifecycle and fresh-profile discriminator.

The reusable credential itself lives only in Hermes's managed ``.env``.  This
module owns the separate, secret-free generation marker that distinguishes a
provably fresh profile from an established profile whose credential is gone.
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any, Iterator, Optional

from . import receipts


RELAY_CREDENTIAL_MARKER_FILENAME = "ocuclaw.relay-credential.json"
RELAY_CREDENTIAL_ENV = "OCUCLAW_RELAY_TOKEN"

PERSISTENCE_COMMITTED = "replacement_committed"
PERSISTENCE_ROLLED_BACK = "previous_restored"
PERSISTENCE_AMBIGUOUS = "rollback_ambiguous"

BOOTSTRAP_GENERATED = "generated"
BOOTSTRAP_ADOPTED = "adopted"
BOOTSTRAP_PRESERVED = "preserved"
BOOTSTRAP_ESTABLISHED_MISSING = "established_missing"
BOOTSTRAP_MANAGED_MISSING = "managed_missing"
BOOTSTRAP_UNAVAILABLE = "unavailable"
BOOTSTRAP_FAILED = "failed"

MANAGED_CREDENTIAL_REQUIRED_MESSAGE = (
    "managed Hermes profile: OcuClaw does not write secrets in managed mode; "
    "provision OCUCLAW_RELAY_TOKEN through your deployment, then restart"
)

_MARKER_KEYS = frozenset(
    {"v", "generationId", "createdAt", "profileFingerprint"}
)
_GENERATION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")
_PROFILE_FINGERPRINT_PATTERN = re.compile(r"[0-9a-f]{64}")
_THREAD_LOCK = threading.RLock()
_LOCK_WAIT_SECONDS = 5.0


class _GenerationLockBusy(Exception):
    pass


def relay_credential_marker_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = receipts.state_dir(home)
    return None if directory is None else directory / RELAY_CREDENTIAL_MARKER_FILENAME


def _read_marker_file(path: Optional[Path]) -> Optional[dict]:
    if path is None:
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        record = json.loads(raw)
    except (FileNotFoundError, OSError, UnicodeError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def _parse_utc_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed if parsed.utcoffset().total_seconds() == 0 else None


def _valid_marker(record: Any, *, home: Optional[Path]) -> bool:
    fingerprint = receipts.fingerprint_home(home)
    return bool(
        isinstance(record, dict)
        and set(record) == _MARKER_KEYS
        and record.get("v") == 1
        and not isinstance(record.get("v"), bool)
        and isinstance(record.get("generationId"), str)
        and _GENERATION_ID_PATTERN.fullmatch(record["generationId"])
        and _parse_utc_iso(record.get("createdAt")) is not None
        and isinstance(record.get("profileFingerprint"), str)
        and _PROFILE_FINGERPRINT_PATTERN.fullmatch(record["profileFingerprint"])
        and fingerprint is not None
        and hmac.compare_digest(record["profileFingerprint"], fingerprint)
    )


def read_relay_credential_marker(home: Optional[Path] = None) -> Optional[dict]:
    """Read the exact-profile v1 marker; reject every unqualified shape."""
    resolved = home if home is not None else receipts.resolve_receipt_home()
    if resolved is None:
        return None
    record = _read_marker_file(relay_credential_marker_path(resolved))
    return record if _valid_marker(record, home=resolved) else None


def _as_utc(now: Optional[datetime]) -> datetime:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _marker_body(
    *, home: Path, generation_id: str, now: Optional[datetime] = None
) -> dict:
    if _GENERATION_ID_PATTERN.fullmatch(str(generation_id or "")) is None:
        raise ValueError("generation_id must be canonical 32-byte base64url")
    fingerprint = receipts.fingerprint_home(home)
    if fingerprint is None:
        raise receipts.ReceiptUnavailableError(
            "profile-scoped Hermes home could not be fingerprinted"
        )
    return {
        "v": 1,
        "generationId": generation_id,
        "createdAt": _as_utc(now).isoformat(),
        "profileFingerprint": fingerprint,
    }


def write_relay_credential_marker(
    *,
    home: Optional[Path] = None,
    generation_id: str,
    now: Optional[datetime] = None,
) -> Path:
    """Atomically replace the marker after an explicit credential reset."""
    resolved = home if home is not None else receipts.resolve_receipt_home()
    path = relay_credential_marker_path(resolved)
    if resolved is None or path is None:
        raise receipts.ReceiptUnavailableError(
            "no profile-scoped Hermes home resolved"
        )
    with _generation_lock(resolved), _binding_lock(resolved):
        return receipts.write_json_receipt(
            path,
            _marker_body(home=resolved, generation_id=generation_id, now=now),
            durable=True,
        )


def new_generation_id() -> str:
    """Return 32 CSPRNG bytes as canonical unpadded base64url (43 chars)."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")


def read_relay_credential() -> str:
    """Read the managed credential without exposing it beyond this process."""
    try:
        from hermes_cli.config import get_env_value  # type: ignore

        value = get_env_value(RELAY_CREDENTIAL_ENV)
        if isinstance(value, str) and value.strip():
            return value.strip()
    except Exception:  # noqa: BLE001 - the supervised process env is the fallback
        pass
    return str(os.environ.get(RELAY_CREDENTIAL_ENV, "") or "").strip()


def is_managed_profile() -> bool:
    """Use Hermes's own predicate for its activation-owned secret mode."""
    try:
        from hermes_cli.config import is_managed  # type: ignore

        return bool(is_managed())
    except Exception:  # noqa: BLE001 - indeterminate must never authorize mutation
        return True


def _marker_file_present(path: Optional[Path]) -> bool:
    if path is None:
        return False
    try:
        path.stat()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        # An unreadable marker is evidence of prior establishment, never
        # permission to silently replace a credential all phones may share.
        return True


def is_profile_established(home: Optional[Path] = None) -> bool:
    """A readable credential OR any existing marker establishes the profile."""
    if read_relay_credential():
        return True
    resolved = home if home is not None else receipts.resolve_receipt_home()
    return _marker_file_present(relay_credential_marker_path(resolved))


def persist_relay_credential(credential: str, previous_credential: str) -> str:
    """Use Hermes's atomic writer and restore the prior value on uncertainty."""
    from hermes_cli.config import get_env_value, save_env_value  # type: ignore

    try:
        save_env_value(RELAY_CREDENTIAL_ENV, credential)
        stored = get_env_value(RELAY_CREDENTIAL_ENV)
        if isinstance(stored, str) and hmac.compare_digest(stored, credential):
            return PERSISTENCE_COMMITTED
    except BaseException:  # noqa: BLE001 - includes Ctrl-C in mutation window
        pass

    try:
        save_env_value(RELAY_CREDENTIAL_ENV, previous_credential)
        restored = get_env_value(RELAY_CREDENTIAL_ENV)
    except BaseException:  # noqa: BLE001 - includes Ctrl-C in rollback window
        return PERSISTENCE_AMBIGUOUS
    if isinstance(restored, str) and hmac.compare_digest(
        restored, previous_credential
    ):
        return PERSISTENCE_ROLLED_BACK
    return PERSISTENCE_AMBIGUOUS


def _open_generation_lock(lock_path: Path) -> int:
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(lock_path, flags, 0o600)
    try:
        if os.name == "nt":
            import msvcrt

            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise _GenerationLockBusy from exc
        else:
            import fcntl

            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise _GenerationLockBusy from exc
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def _generation_lock(home: Path) -> Iterator[None]:
    directory = receipts.state_dir(home)
    if directory is None:
        raise receipts.ReceiptUnavailableError(
            "no profile-scoped Hermes state directory resolved"
        )
    directory.mkdir(parents=True, exist_ok=True)
    receipts._harden_receipt_path(directory, is_dir=True)
    lock_path = directory / f".{RELAY_CREDENTIAL_MARKER_FILENAME}.lock"
    deadline = time.monotonic() + _LOCK_WAIT_SECONDS
    with _THREAD_LOCK:
        while True:
            try:
                fd = _open_generation_lock(lock_path)
                break
            except _GenerationLockBusy:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "timed out waiting for credential generation lock"
                    )
                time.sleep(0.01)
        try:
            yield
        finally:
            os.close(fd)


@contextmanager
def _binding_lock(home: Path) -> Iterator[None]:
    """Serialize marker publication with Attempt validation/proof commit."""

    with receipts.receipt_state_lock(
        receipts.state_dir(home), receipts.FIRST_RUN_BINDING_LOCK_FILENAME
    ) as acquired:
        if not acquired:
            raise receipts.ReceiptUnavailableError(
                "first-run binding lock unavailable"
            )
        yield


def bootstrap_relay_credential(home: Optional[Path] = None) -> str:
    """Generate once when fresh, or adopt a marker without credential mutation.

    The profile lock serializes the required credential-first ordering.  The
    marker still uses an exclusive claim, so the publication itself can never
    overwrite a generation identity selected by another process.
    """
    managed = is_managed_profile()
    managed_credential = read_relay_credential() if managed else ""
    if managed and not managed_credential:
        return BOOTSTRAP_MANAGED_MISSING

    resolved = home if home is not None else receipts.resolve_receipt_home()
    if resolved is None:
        return BOOTSTRAP_PRESERVED if managed_credential else BOOTSTRAP_UNAVAILABLE
    try:
        with _generation_lock(resolved):
            marker_path = relay_credential_marker_path(resolved)
            existing_credential = read_relay_credential()
            if managed and not existing_credential:
                return BOOTSTRAP_MANAGED_MISSING
            if existing_credential:
                if _marker_file_present(marker_path):
                    return BOOTSTRAP_PRESERVED
                with _binding_lock(resolved):
                    if _marker_file_present(marker_path):
                        return BOOTSTRAP_PRESERVED
                    generation_id = new_generation_id()
                    body = _marker_body(home=resolved, generation_id=generation_id)
                    try:
                        receipts.claim_json_receipt(marker_path, body)
                    except receipts.ReceiptAlreadyClaimedError:
                        return BOOTSTRAP_PRESERVED
                    except Exception:  # noqa: BLE001 - reconcile post-publish errors
                        published = _read_marker_file(marker_path)
                        if published == body:
                            return BOOTSTRAP_ADOPTED
                        if _marker_file_present(marker_path):
                            return BOOTSTRAP_PRESERVED
                        return BOOTSTRAP_PRESERVED if managed else BOOTSTRAP_FAILED
                    return BOOTSTRAP_ADOPTED
            if _marker_file_present(marker_path):
                return BOOTSTRAP_ESTABLISHED_MISSING

            with _binding_lock(resolved):
                if _marker_file_present(marker_path):
                    return BOOTSTRAP_ESTABLISHED_MISSING
                credential = new_generation_id()
                generation_id = new_generation_id()
                persistence = persist_relay_credential(credential, "")
                if persistence != PERSISTENCE_COMMITTED:
                    return BOOTSTRAP_FAILED

                body = _marker_body(home=resolved, generation_id=generation_id)
                try:
                    receipts.claim_json_receipt(marker_path, body)
                except receipts.ReceiptAlreadyClaimedError:
                    # A process outside this version's lock discipline won.  The
                    # physical marker still makes the profile established; never
                    # overwrite it or generate again.
                    return BOOTSTRAP_PRESERVED
                except Exception:  # noqa: BLE001 - reconcile possible post-publish error
                    published = _read_marker_file(marker_path)
                    if published == body:
                        return BOOTSTRAP_GENERATED
                    # Keep the two-write transaction closed when publication did
                    # not happen.  If rollback is ambiguous, the readable
                    # credential alone safely establishes the profile next time.
                    persist_relay_credential("", credential)
                    return BOOTSTRAP_FAILED
                return BOOTSTRAP_GENERATED
    except Exception:  # noqa: BLE001 - plugin admission remains diagnosable
        # A deployment-provided credential alone establishes a managed profile.
        # Marker adoption is best-effort there because the activation-owned
        # state directory may intentionally be unwritable to this process.
        return BOOTSTRAP_PRESERVED if managed_credential else BOOTSTRAP_FAILED


__all__ = [
    "RELAY_CREDENTIAL_MARKER_FILENAME",
    "MANAGED_CREDENTIAL_REQUIRED_MESSAGE",
    "bootstrap_relay_credential",
    "is_managed_profile",
    "is_profile_established",
    "new_generation_id",
    "read_relay_credential_marker",
    "relay_credential_marker_path",
    "write_relay_credential_marker",
]
