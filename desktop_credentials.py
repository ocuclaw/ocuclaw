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
            set(row) not in ({"v", "id", "selected", "createdAt", "state"},
                            {"v", "id", "selected", "createdAt", "state", "changed"})
            or row["v"] != 1
            or not isinstance(row["id"], str)
            or len(row["id"]) != 32
            or not isinstance(row["selected"], list)
            or len(row["selected"]) != 1
            or any(name not in FIELDS for name in row["selected"])
            or type(row["createdAt"]) not in (int, float)
            or row["state"] not in {"pending", "saved", "cancelled"}
            or ("changed" in row and not isinstance(row["changed"], bool))
        ):
            return None
        if row["state"] == "pending" and not 0 <= time.time() - row["createdAt"] < REQUEST_TTL:
            row["state"] = "expired"
        return row
    except (OSError, ValueError, TypeError, KeyError):
        return None


def _public(row: dict[str, Any] | None, *, direct: bool = False) -> dict[str, Any]:
    result = {
        "state": row["state"] if row else "idle",
        "selected": row["selected"] if row else [],
        "present": _presence(),
        "changed": row.get("changed") if row else None,
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
            interrupted_change = bool(row and row["state"] == "expired" and row.get("changed"))
            if row and (row["state"] == "pending" or interrupted_change):
                # Never replace a live form or invalidate another window's input.
                if row["selected"] != selected:
                    return {"state": "busy", "selected": row["selected"]}
                if row["state"] == "pending":
                    return _public(row)
            row = {"v": 1, "id": secrets.token_hex(16), "selected": selected,
                   "createdAt": time.time(), "state": "pending", "changed": interrupted_change}
            write_json_receipt(state_dir(home) / REQUEST_FILE, row)
            return _public(row)
    except Exception:
        return {"state": "unavailable"}


def save_selected_value(home: Path, name: str, value: str) -> bool:
    """Domain writer; callers own their authorization and LOCK_FILE admission.

    Desktop keeps its presenter-capability endpoint and pending form. The phone
    has a separate authenticated transaction; it never creates a Desktop form.
    """
    from hermes_cli.config import get_env_value, invalidate_env_cache, load_env, save_env_value
    from .optional_setup import begin_save, finish_save, PENDING, _read as read_optional

    if name not in FIELDS or not isinstance(value, str) or len(value) > 4096 or any(
        ord(char) < 32 or ord(char) > 126 for char in value
    ):
        raise ValueError("invalid_value")
    value = value.strip()
    if not value:
        return False
    if value != str(get_env_value(FIELDS[name]) or "").strip():
        revision = begin_save(home, name)
        try:
            save_env_value(FIELDS[name], value)
            invalidate_env_cache()
            if load_env().get(FIELDS[name]) != value:
                raise ValueError("save_failed")
            finish_save(home, revision, name, saved=True)
        except Exception:
            finish_save(home, revision, name, saved=False)
            raise ValueError("save_failed") from None
        return True
    pending = read_optional(home, PENDING)
    if (pending.get("choices") or {}).get(name) in {"saving", "save_failed"}:
        revision = begin_save(home, name)
        finish_save(home, revision, name, saved=True)
    return False


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
                from hermes_cli.config import get_env_value

                for name, value in values.items():
                    if value.strip() and value.strip() != str(get_env_value(FIELDS[name]) or "").strip():
                        # Keep activation pending across a crash after the secret
                        # writer succeeds but before the saved receipt is committed.
                        row["changed"] = True
                        write_json_receipt(state_dir(home) / REQUEST_FILE, row, durable=True)
                        try:
                            save_selected_value(home, name, value)
                        except Exception:
                            return {"state": "save_failed", "present": _presence()}
                    elif value.strip():
                        # A previous writer may have succeeded before reporting a
                        # failure. A retry verifies its value without replacing it.
                        save_selected_value(home, name, value)
                row["state"] = "saved"
            write_json_receipt(state_dir(home) / REQUEST_FILE, row)
            return _public(row, direct=True)
    except Exception:
        # Partial writes are not rolled back over a user's newly saved key.
        return {"state": "save_failed", "present": status().get("present", {})}
