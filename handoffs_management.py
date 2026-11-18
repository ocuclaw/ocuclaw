"""Phone management for "Asks other agents" (#6797): read and set the switch.

``handoffs.read`` and ``handoffs.set`` are profile-scoped operations on the
``gw.hermes.management`` lane. They exist only while the ``ocuclaw-agents``
delegation backend is registered (Hermes 0.22.5+); otherwise the capability
rows say ``supported: false`` and the phone hides the setting.

The switch lives in the asking agent's OWN ``config.yaml`` because Hermes picks
a delegation backend per profile, so it applies wherever that agent runs
(glasses, Desktop, Telegram) and from its next new chat.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from . import delegation_handoffs as handoffs

READS = {"handoffs.read"}
#: ``handoffs.restore`` is the doctor's one-tap fix for a stranded backend
#: (profiles_report ``delegation_backend_stranded``). It is gateway scoped
#: because the stranded agent may not be served here, and it only ever puts
#: the previous backend back, so it narrows and never widens.
RESTORE = "handoffs.restore"
OPERATIONS = READS | {"handoffs.set", RESTORE}
ERRORS = {
    "invalid_request": "Review the agents this agent may ask, then try again.",
    "unsupported": "Asking other agents needs Hermes 0.22.5 or later with OcuClaw loaded.",
    "agent_not_enrolled": "One of those agents is no longer enrolled. Refresh and pick again.",
    "replace_unconfirmed": "This agent uses another delegation backend. Confirm replacing it first.",
    "managed": "This Hermes install is managed, so its delegation settings are read only.",
    "native_read_failed": "Hermes could not read this agent's delegation settings.",
    "profile_not_served": "This agent is no longer served here. Pick another one.",
}


def capabilities() -> List[Dict[str, Any]]:
    supported = handoffs.is_registered()
    return [
        {"operation": "handoffs.read", "scope": "profile", "supported": supported, "applyTiming": "read_only"},
        {"operation": "handoffs.set", "scope": "profile", "supported": supported, "applyTiming": "new_chat"},
        {"operation": RESTORE, "scope": "gateway", "supported": supported, "applyTiming": "new_chat"},
    ]


def _restore(identity: Mapping[str, Any], arguments: Any) -> Dict[str, Any]:
    if identity.get("scope") != "gateway" or identity.get("profileId") != handoffs.DEFAULT_BACKEND:
        return _fail(identity, "invalid_request")
    if not isinstance(arguments, Mapping) or set(arguments) != {"profiles"}:
        return _fail(identity, "invalid_request")
    names = arguments.get("profiles")
    if (not isinstance(names, list) or not names or len(names) > handoffs.MAX_AGENTS
            or any(handoffs._profile_name(name) is None for name in names)):
        return _fail(identity, "invalid_request")
    from .profile_routes import resolve_default_home

    default_home = resolve_default_home()
    if default_home is None:
        return _fail(identity, "native_read_failed")
    homes = dict(handoffs.profile_homes(Path(default_home)))
    restored: List[str] = []
    try:
        for name in names:
            home = homes.get(name)
            if home is not None and handoffs.restore_home(home):
                restored.append(name)
    except handoffs.SwitchRefused as exc:
        return _fail(identity, exc.code if exc.code in ERRORS else "native_read_failed")
    except Exception:  # noqa: BLE001 - native exceptions can carry paths
        return _fail(identity, "native_read_failed")
    return {**identity, "status": "ok", "capabilities": capabilities(),
            "handoffs": {"restored": restored, "applyTiming": "new_chat"}}


def _fail(identity: Mapping[str, Any], code: str, status: str = "error") -> Dict[str, Any]:
    return {**identity, "status": status, "errorCode": code,
            "errorMessage": ERRORS.get(code, ERRORS["native_read_failed"]), "capabilities": []}


def _served_rows(rpc: Any) -> List[Mapping[str, Any]]:
    snapshot = rpc._sync_profiles_list({})
    rows = snapshot.get("profiles", []) if isinstance(snapshot, Mapping) else []
    return [row for row in rows if isinstance(row, Mapping)] if isinstance(rows, list) else []


def _stranded(rpc: Any) -> List[str]:
    """Agents whose own config still names this backend while this gateway does not serve them.

    OcuClaw runs only inside the default profile's gateway, so such an agent fails delegation
    closed wherever it runs (the doctor's ``delegation_backend_stranded`` row). The phone offers
    ``handoffs.restore`` for them. Best effort: anything unreadable is left out, never guessed.
    """
    try:
        from .profile_routes import resolve_default_home

        default_home = resolve_default_home()
        if default_home is None:
            return []
        served = {row.get("name") for row in _served_rows(rpc)}
        stranded: List[str] = []
        for name, home in handoffs.profile_homes(Path(default_home)):
            if name in served:
                continue
            config_path = home / "config.yaml"
            if config_path.exists() and handoffs.switch_state(handoffs._read_raw(config_path))["enabled"]:
                stranded.append(name)
        return stranded[: handoffs.MAX_AGENTS]
    except Exception:  # noqa: BLE001 - a doctor hint never fails the read
        return []


def _candidates(rpc: Any, profile_id: str) -> List[Tuple[str, str, str]]:
    """``[(id, displayName, description)]``: served, enrolled agents other than this one."""
    rows: List[Tuple[str, str, str]] = []
    for row in _served_rows(rpc):
        if not isinstance(row, Mapping):
            continue
        name = row.get("name")
        if not isinstance(name, str) or name == profile_id:
            continue
        if handoffs._profile_name(name) is None:
            continue
        display = handoffs._clean_text(row.get("displayName"), 80) or name
        description = handoffs._clean_text(row.get("description"), handoffs.DESCRIPTION_LIMIT)
        rows.append((name, display, description))
    rows.sort(key=lambda item: item[0])
    return rows[: handoffs.MAX_AGENTS]


def _home(rpc: Any, profile_id: str) -> Path:
    _profile, home = rpc._settings_profile(profile_id)
    return Path(home)


def _view(rpc: Any, profile_id: str) -> Dict[str, Any]:
    home = _home(rpc, profile_id)
    raw = handoffs._read_raw(home / "config.yaml")
    state = handoffs.switch_state(raw)
    allowed = set(state["agents"]) if state["enabled"] else set()
    agents = [
        {"id": name, "name": display, **({"description": description} if description else {}),
         "allowed": name in allowed}
        for name, display, description in _candidates(rpc, profile_id)
    ]
    replaces = None
    if not state["enabled"] and state["backend"] != handoffs.DEFAULT_BACKEND:
        replaces = state["backend"]
    elif state["enabled"] and state["previous"] != handoffs.DEFAULT_BACKEND:
        replaces = state["previous"]
    return {
        "available": handoffs.is_registered(),
        "enabled": state["enabled"],
        "backend": state["backend"],
        "replaces": replaces,
        "agents": agents,
        "stranded": _stranded(rpc),
        "applyTiming": "new_chat",
    }


def _request(arguments: Any, operation: str) -> Optional[Dict[str, Any]]:
    if operation == "handoffs.read":
        return {} if arguments in (None, {}) else None
    if not isinstance(arguments, Mapping) or set(arguments) - {"enabled", "agents", "confirmReplace"}:
        return None
    enabled = arguments.get("enabled")
    if type(enabled) is not bool:
        return None
    agents = arguments.get("agents", [])
    if not isinstance(agents, list) or len(agents) > handoffs.MAX_AGENTS:
        return None
    names = []
    for value in agents:
        name = handoffs._profile_name(value)
        if name is None or name in names:
            return None
        names.append(name)
    if enabled and not names:
        return None
    confirm = arguments.get("confirmReplace")
    if confirm is not None and (not isinstance(confirm, str) or len(confirm) > 64):
        return None
    return {"enabled": enabled, "agents": names, "confirmReplace": confirm}


def handle_handoffs(rpc: Any, identity: Mapping[str, Any], arguments: Any) -> Dict[str, Any]:
    operation = identity.get("operation")
    profile_id = str(identity.get("profileId") or "")
    if operation == RESTORE:
        return _restore(identity, arguments)
    if not handoffs.is_registered():
        return _fail(identity, "unsupported", "unsupported")
    if identity.get("scope") != "profile":
        return _fail(identity, "invalid_request")
    request = _request(arguments, str(operation))
    if request is None:
        return _fail(identity, "invalid_request")
    try:
        if operation == "handoffs.set":
            home = _home(rpc, profile_id)
            config_path = home / "config.yaml"
            raw = handoffs._read_raw(config_path)
            if request["enabled"]:
                candidates = {name: description for name, _display, description in _candidates(rpc, profile_id)}
                if any(name not in candidates for name in request["agents"]):
                    return _fail(identity, "agent_not_enrolled")
                updated = handoffs.switched_on(
                    raw,
                    [(name, candidates[name]) for name in request["agents"]],
                    confirm_replace=request["confirmReplace"],
                )
                handoffs.write_config(config_path, updated)
            else:
                updated, changed = handoffs.switched_off(raw)
                if changed:
                    handoffs.write_config(config_path, updated)
        view = _view(rpc, profile_id)
    except handoffs.SwitchRefused as exc:
        return _fail(identity, exc.code if exc.code in ERRORS else "native_read_failed")
    except ValueError:
        # `_settings_profile` refuses a profile this gateway no longer serves.
        return _fail(identity, "profile_not_served")
    except Exception:  # noqa: BLE001 - native exceptions can carry paths
        return _fail(identity, "native_read_failed")
    return {**identity, "status": "ok", "capabilities": capabilities(), "handoffs": view}


__all__ = ["ERRORS", "OPERATIONS", "READS", "capabilities", "handle_handoffs"]
