"""Secret-free receipt for authenticated phone pairing completion (#1322)."""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from .receipts import (
    FIRST_RUN_BINDING_LOCK_FILENAME,
    ReceiptUnavailableError,
    receipt_state_lock,
    resolve_receipt_home,
    state_dir,
    write_json_receipt,
)

PAIRING_COMPLETION_FILENAME = "ocuclaw.pairing-completion.json"

_COMPLETION_KEYS = frozenset({"v", "completionId", "completedAt"})
_COMPLETION_ID = re.compile(r"^[A-Za-z0-9_-]{43}$")


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_utc_iso(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == timezone.utc.utcoffset(None)


def _is_completion_id(value: Any) -> bool:
    if not isinstance(value, str) or _COMPLETION_ID.fullmatch(value) is None:
        return False
    try:
        decoded = base64.urlsafe_b64decode(value + "=")
    except (ValueError, TypeError):
        return False
    return (
        len(decoded) == 32
        and base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") == value
    )


def pairing_completion_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(home)
    return None if directory is None else directory / PAIRING_COMPLETION_FILENAME


def read_pairing_completion(home: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Return the exact valid receipt, otherwise ``None`` fail-soft."""

    path = pairing_completion_path(home)
    if path is None:
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, ValueError):
        return None
    if not isinstance(record, dict) or set(record) != _COMPLETION_KEYS:
        return None
    if type(record.get("v")) is not int or record.get("v") != 1:
        return None
    if not _is_completion_id(record.get("completionId")):
        return None
    if not _is_utc_iso(record.get("completedAt")):
        return None
    return dict(record)


def record_pairing_completion(
    *,
    completion_id: str,
    home: Optional[Path] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Atomically record one Node-minted ID, idempotently on redelivery."""

    resolved = home if home is not None else resolve_receipt_home()
    path = pairing_completion_path(resolved)
    if path is None:
        raise ReceiptUnavailableError("no profile-scoped Hermes home resolved")
    if not _is_completion_id(completion_id):
        raise ValueError("completion_id must be canonical 32-byte base64url")
    # This receipt is part of the Attempt's commit predicate.  Serialize its
    # replacement with Attempt validation and proof publication so a pairing
    # completion cannot land in the check-to-commit window.
    with receipt_state_lock(
        state_dir(resolved), FIRST_RUN_BINDING_LOCK_FILENAME
    ) as acquired:
        if not acquired:
            raise ReceiptUnavailableError("first-run binding lock unavailable")
        current = read_pairing_completion(resolved)
        if current is not None and current.get("completionId") == completion_id:
            return current
        record = {
            "v": 1,
            "completionId": completion_id,
            "completedAt": _as_utc(now or datetime.now(timezone.utc)).isoformat(),
        }
        write_json_receipt(path, record, durable=True)
    return record


__all__ = [
    "PAIRING_COMPLETION_FILENAME",
    "pairing_completion_path",
    "read_pairing_completion",
    "record_pairing_completion",
]
