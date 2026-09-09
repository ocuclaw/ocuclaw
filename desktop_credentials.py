"""Direct-human optional credentials. Durable request metadata never holds secrets."""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any

from .receipts import receipt_state_lock, resolve_receipt_home, state_dir, write_json_receipt

REQUEST_FILE = "ocuclaw.desktop-credentials.json"
LOCK_FILE = "ocuclaw.desktop-credentials.lock"
REQUEST_TTL = 600
FIELDS = {"soniox": "OCUCLAW_SONIOX_API_KEY", "evenAi": "OCUCLAW_EVEN_AI_TOKEN"}


def _home() -> Path:
    from hermes_constants import get_hermes_home

    home = resolve_receipt_home()
    if home is None or home.resolve() != Path(get_hermes_home()).resolve():
        raise ValueError("profile_unavailable")
    return home


def _presence() -> dict[str, bool]:
    from hermes_cli.config import get_env_value, invalidate_env_cache

    invalidate_env_cache()
    return {name: bool(str(get_env_value(key) or "").strip()) for name, key in FIELDS.items()}


def _read(home: Path) -> dict[str, Any] | None:
    try:
        row = json.loads((state_dir(home) / REQUEST_FILE).read_text())
        if (
            set(row) != {"v", "id", "selected", "createdAt", "state"}
            or row["v"] != 1
            or not isinstance(row["id"], str)
            or len(row["id"]) != 32
            or not isinstance(row["selected"], list)
            or len(row["selected"]) != 1
            or any(name not in FIELDS for name in row["selected"])
            or type(row["createdAt"]) not in (int, float)
            or row["state"] not in {"pending", "saved", "cancelled"}
        ):
            return None
        if not 0 <= time.time() - row["createdAt"] < REQUEST_TTL:
            row["state"] = "expired"
        return row
    except (OSError, ValueError, TypeError, KeyError):
        return None


def _public(row: dict[str, Any] | None, *, direct: bool = False) -> dict[str, Any]:
    result = {
        "state": row["state"] if row else "idle",
        "selected": row["selected"] if row else [],
        "present": _presence(),
    }
    if direct and row:
        result["requestId"] = row["id"]
    return result


def status(*, direct: bool = False) -> dict[str, Any]:
    try:
        return _public(_read(_home()), direct=direct)
    except Exception:
        return {"state": "unavailable", "selected": [], "present": {}}


def request(selected: Any) -> dict[str, Any]:
    """Model may request a dialog, but supplies no credential value or capability."""
    if (
        not isinstance(selected, list) or len(selected) != 1
        or any(not isinstance(name, str) or name not in FIELDS for name in selected)
        or len(selected) != len(set(selected))
    ):
        return {"state": "invalid_selection"}
    try:
        home = _home()
        with receipt_state_lock(state_dir(home), LOCK_FILE) as locked:
            if not locked:
                return {"state": "busy"}
            row = _read(home)
            if row and row["state"] == "pending":
                # Never replace a live form or invalidate another window's input.
                if row["selected"] != selected:
                    return {"state": "busy", "selected": row["selected"]}
                return _public(row)
            row = {"v": 1, "id": secrets.token_hex(16), "selected": selected,
                   "createdAt": time.time(), "state": "pending"}
            write_json_receipt(state_dir(home) / REQUEST_FILE, row)
            return _public(row)
    except Exception:
        return {"state": "unavailable"}


def submit(request_id: Any, values: Any = None, *, cancel: bool = False) -> dict[str, Any]:
    """Only the capability-checked Desktop route calls this, never an LLM tool.

    Validate the whole payload before writing. A writer failure may follow one
    successful save: report presence only and leave the request retryable.
    Exception messages and submitted values never leave this function.
    """
    try:
        home = _home()
        with receipt_state_lock(state_dir(home), LOCK_FILE) as locked:
            if not locked:
                return {"state": "busy"}
            row = _read(home)
            if not row or row["state"] != "pending" or request_id != row["id"]:
                return {"state": "stale_request"}
            if cancel:
                row["state"] = "cancelled"
            else:
                if not isinstance(values, dict) or set(values) - set(row["selected"]):
                    return {"state": "invalid_fields"}
                # Header credentials: reject control/non-ASCII characters before
                # Hermes's writer can warn about them in a log. Never silently
                # strip a newline or truncate a pasted value.
                for value in values.values():
                    if not isinstance(value, str) or len(value) > 4096 or any(
                        ord(char) < 32 or ord(char) > 126 for char in value
                    ):
                        return {"state": "invalid_value"}
                present = _presence()
                if any(not values.get(name, "").strip() and not present[name] for name in row["selected"]):
                    return {"state": "missing_value", "present": present}
                from hermes_cli.config import invalidate_env_cache, load_env, save_env_value

                for name, value in values.items():
                    if value.strip():
                        save_env_value(FIELDS[name], value.strip())
                        invalidate_env_cache()
                        if load_env().get(FIELDS[name]) != value.strip():
                            return {"state": "save_failed", "present": _presence()}
                row["state"] = "saved"
            write_json_receipt(state_dir(home) / REQUEST_FILE, row)
            return _public(row, direct=True)
    except Exception:
        # Partial writes are not rolled back over a user's newly saved key.
        return {"state": "save_failed", "present": status().get("present", {})}
