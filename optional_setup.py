"""Two optional saves, one explicit activation. No secrets in receipts or output."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any

from . import receipts, optional_diagnostics as diagnostics

PENDING = "ocuclaw.optional-pending.json"
ACTIVE = "ocuclaw.optional-active.json"
LOCK = "ocuclaw.optional-setup.lock"
FIELDS = {"soniox": "OCUCLAW_SONIOX_API_KEY", "evenAi": "OCUCLAW_EVEN_AI_TOKEN"}


def _home() -> Path:
    from hermes_constants import get_hermes_home
    from .profiles_report import default_home_for

    home = receipts.resolve_receipt_home()
    if home is None or home.resolve() != Path(get_hermes_home()).resolve():
        raise ValueError("profile_unavailable")
    if default_home_for(home) != home:
        raise ValueError("primary_runtime_required")
    return home


def _read(home: Path, name: str) -> dict:
    try:
        row = json.loads((receipts.state_dir(home) / name).read_text())
        return row if isinstance(row, dict) and row.get("v") == 1 else {}
    except (OSError, ValueError, TypeError):
        return {}


def _write(home: Path, name: str, row: dict) -> None:
    receipts.write_json_receipt(receipts.state_dir(home) / name, row, durable=True)


def begin_save(home: Path, selected: str) -> str:
    """Fence BEFORE a write; interrupted saves remain pending, never lost."""
    if selected not in FIELDS and selected not in diagnostics.CHOICES.values():
        raise ValueError("invalid_selection")
    with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
        if not locked:
            raise ValueError("busy")
        old = _read(home, PENDING)
        admitted = old.get("activationRequested")
        if admitted:
            gateway, _, live = receipts.read_gateway_state(home=home)
            if (live is not True or not isinstance(gateway, dict)
                    or (admitted.get("pid") == gateway.get("pid")
                        and admitted.get("startTime") == gateway.get("start_time"))):
                raise ValueError("activation_pending_reconnect")
        choices = dict(old.get("choices") or {})
        choices[selected] = "saving"
        revision = secrets.token_hex(16)
        choice_revisions = dict(old.get("choiceRevisions") or {})
        choice_revisions[selected] = revision
        _write(home, PENDING, {"v": 1, "revision": revision, "choices": choices,
                             "choiceRevisions": choice_revisions,
                             "activationRequested": old.get("activationRequested")})
        return revision


def finish_save(home: Path, revision: str, selected: str, *, saved: bool) -> None:
    with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
        if not locked:
            raise ValueError("busy")
        row = _read(home, PENDING)
        # A different choice may advance the shared revision. Only a newer save
        # of THIS choice supersedes this completion (Desktop and enable overlap).
        if (row.get("choiceRevisions") or {}).get(selected) != revision:
            return
        choices = dict(row.get("choices") or {})
        if choices.get(selected) == "saving":
            choices[selected] = "saved" if saved else "save_failed"
        row["choices"] = choices
        _write(home, PENDING, row)


def _disk_values() -> tuple[dict, bool]:
    from hermes_cli.config import invalidate_env_cache, load_env, read_raw_config

    invalidate_env_cache()
    env = load_env()
    cfg = read_raw_config()
    extra = ((cfg.get("platforms") or {}).get("ocuclaw") or {}).get("extra") or {}
    return {name: str(env.get(key) or "").strip() for name, key in FIELDS.items()}, extra.get("evenAiEnabled") is True


def _file_revision(home: Path) -> list:
    result = []
    for name in (".env", "config.yaml"):
        try:
            stat = (home / name).stat()
            result.append([stat.st_ino, stat.st_size, stat.st_mtime_ns])
        except FileNotFoundError:
            result.append(None)
    return result


def observe_runtime(settings: dict, *, home: Path | None = None) -> None:
    """Called only after the actual relay answers, using its loaded settings.

    Presence alone is never activation evidence. Compare the actual loaded
    values privately and retain booleans plus the gateway writer identity.
    """
    try:
        home = home or _home()
        from gateway.status import get_process_start_time
        with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
            if not locked:
                return
            before = _file_revision(home)
            values, enabled = _disk_values()
            permissions = diagnostics.configured()
            marker = _read(home, PENDING)
            if before != _file_revision(home):
                return
            matches = {
                "soniox": bool(values["soniox"]) and settings.get("sonioxApiKey") == values["soniox"],
                "evenAi": bool(values["evenAi"]) and settings.get("evenAiToken") == values["evenAi"]
                and settings.get("evenAiEnabled") is True and enabled,
            }
            loaded_permissions = {key: settings.get(field) if type(settings.get(field)) is bool else None
                                  for key, field in diagnostics.FIELDS.items()}
            matches.update({diagnostics.CHOICES[key]: loaded_permissions[key] is permissions[key]
                            for key in diagnostics.FIELDS})
            _write(home, ACTIVE, {"v": 1, "revision": marker.get("revision"),
                   "pid": os.getpid(), "startTime": get_process_start_time(os.getpid()),
                   "observedAt": time.time(), "files": before, "matches": matches,
                   # These settings belong to the relay that just answered,
                   # never the CLI's next-start/default configuration.
                   "relayPort": settings.get("wsPort"), "diagnostics": loaded_permissions})
    except Exception:
        # Optional evidence must not break the relay or reveal a writer error.
        return


def status(home: Path | None = None) -> dict:
    try:
        home = home or _home()
        from .cloudways_restart_step import _relay_is_connected_now
        gateway, _, live = receipts.read_gateway_state(home=home)
        row, active = _read(home, PENDING), _read(home, ACTIVE)
        values, _ = _disk_values()
        choices = row.get("choices") or {}
        fresh = (live is True and _relay_is_connected_now(gateway)
                 and active.get("pid") == gateway.get("pid")
                 and active.get("startTime") == gateway.get("start_time")
                 and 0 <= time.time() - active.get("observedAt", 0) <= 120)
        same_revision = active.get("revision") == row.get("revision")
        files_match = active.get("files") == _file_revision(home)
        current = fresh and same_revision and files_match
        states = {}
        for name in FIELDS:
            if choices.get(name) in {"saving", "save_failed"}:
                states[name] = "save_failed"
            elif current and active.get("matches", {}).get(name) is True:
                states[name] = "available_to_test"
            elif not values[name]:
                states[name] = "not_configured"
            elif choices.get(name) == "saved" and fresh and (not same_revision or files_match):
                states[name] = "saved_not_activated"
            else:
                states[name] = "unknown"
        permissions = diagnostics.configured()
        permission_states = {}
        for key, name in diagnostics.CHOICES.items():
            if choices.get(name) in {"saving", "save_failed"}:
                permission_states[name] = "save_failed"
            elif current and active.get("matches", {}).get(name) is True:
                permission_states[name] = "available_to_test"
            elif choices.get(name) == "saved" and fresh and (not same_revision or files_match):
                permission_states[name] = "saved_not_activated"
            else:
                permission_states[name] = "unknown"
        # Never restart underneath a credential/config writer. A later status
        # can admit the grouped activation once every in-flight save finishes.
        pending = (any(value == "saved_not_activated" for value in (*states.values(), *permission_states.values()))
                   and "saving" not in choices.values())
        admission = row.get("activationRequested") or {}
        admitted_here = (bool(admission) and isinstance(gateway, dict)
                         and admission.get("pid") == gateway.get("pid")
                         and admission.get("startTime") == gateway.get("start_time"))
        port = active.get("relayPort")
        runtime_context = ({"relayPort": port, "pid": gateway.get("pid"),
                            "startTime": gateway.get("start_time"), "revision": row.get("revision")}
                           if current and isinstance(port, int) and not isinstance(port, bool)
                           and 1 <= port <= 65535 else None)
        return {"state": "ready", "capabilities": states, "restartRequired": pending,
                "diagnostics": {"supported": True, **permissions,
                    "activeAccess": (active.get("diagnostics") or {}).get("access") if fresh else None,
                    "activeHandoff": (active.get("diagnostics") or {}).get("handoff") if fresh else None},
                "permissionStates": {name: value for name, value in permission_states.items() if name in choices},
                "activationRequested": admitted_here,
                "revision": row.get("revision"), "runtimeContext": runtime_context}
    except Exception:
        return {"state": "unavailable", "capabilities": {}, "restartRequired": False}


def activation_states(state: dict) -> dict:
    """Include explicitly saved permissions in the existing combined restart."""
    return {**state.get("capabilities", {}), **state.get("permissionStates", {})}


def _enable_even_ai(home: Path) -> None:
    from hermes_cli.config import set_config_value, read_raw_config
    revision = begin_save(home, "evenAi")
    try:
        # This supported writer honors managed config; readback catches a no-op.
        set_config_value("platforms.ocuclaw.extra.evenAiEnabled", "true")
        raw = read_raw_config()
        if raw["platforms"]["ocuclaw"]["extra"]["evenAiEnabled"] is not True:
            raise ValueError("save_failed")
        finish_save(home, revision, "evenAi", saved=True)
    except Exception:
        finish_save(home, revision, "evenAi", saved=False)
        raise ValueError("save_failed") from None


def save(selected: str, *, prompt=None, out=None) -> int:
    out = out or sys.stdout
    if selected not in FIELDS:
        return 2
    try:
        home = _home()
        if status(home).get("activationRequested"):
            out.write("Activation is already in progress. Reconnect and run hermes ocuclaw optional-setup status before saving again. Existing successful saves are kept.\n")
            return 2
        if prompt is None:
            if not sys.stdin.isatty() or not out.isatty():
                out.write("Use your own interactive terminal for private credential entry.\n")
                return 2
            from hermes_cli.cli_output import prompt
        from . import desktop_credentials
        opened = desktop_credentials.request([selected])
        if opened.get("state") != "pending":
            out.write("Private entry is unavailable or already in use. Keep existing settings and retry.\n")
            return 1
        request_id = desktop_credentials.status(direct=True).get("requestId")
        out.write("Enter privately. Blank keeps an existing value or skips; Ctrl-C cancels.\n")
        try:
            value = prompt("Soniox API key" if selected == "soniox" else "Even AI token", password=True)
        except (KeyboardInterrupt, EOFError):
            desktop_credentials.submit(request_id, cancel=True)
            out.write("Cancelled. Existing credentials were kept.\n")
            return 0
        if not str(value or "").strip() and not opened.get("present", {}).get(selected):
            desktop_credentials.submit(request_id, cancel=True)
            out.write("Skipped. Nothing changed.\n")
            return 0
        result = desktop_credentials.submit(request_id, {selected: value or ""})
        if result.get("state") != "saved":
            out.write("Save did not finish. Existing or partially saved choices are kept. If activation was requested, reconnect and run hermes ocuclaw optional-setup status before retrying this choice.\n")
            return 1
        if selected == "evenAi" and not _disk_values()[1]:
            _enable_even_ai(home)
        out.write("Saved. This does not verify voice or Even AI. Finish your optional saves, then run:\n"
                  "hermes ocuclaw optional-setup status\nhermes ocuclaw optional-setup activate\n")
        return 0
    except Exception:
        out.write("Optional save could not finish. Keep working text chat and retry this choice.\n")
        return 1


def activate(*, confirm=None, out=None) -> int:
    out = out or sys.stdout
    try:
        home = _home()
        from .cloudways_restart_step import restart_plan, restart_gateway
        current = status(home)
        if not current.get("restartRequired"):
            out.write("No verified pending activation. Check optional-setup status; unknown is not activated.\n")
            return 0 if current.get("state") == "ready" else 1
        if current.get("activationRequested"):
            out.write("Activation was already requested. Reconnect and run optional-setup status; no second restart was sent.\n")
            return 2
        plan = restart_plan()
        if plan is None:
            out.write("This host has no supported automatic restart. On Cloudways, restart the agent in its dashboard.\n"
                      "This closes SSH and Hermes. Save your reconnect command first. After reconnecting, run:\n"
                      "hermes ocuclaw optional-setup status\nSaved choices and core pairing are kept.\n")
            return 2
        out.write("Activate all saved optional choices with one gateway restart. This interrupts every profile on this gateway.\n"
                  "Keep your reconnect command. After reconnecting run hermes ocuclaw optional-setup status.\n")
        if confirm is None:
            if not sys.stdin.isatty() or not out.isatty():
                return 2
            confirm = lambda: input("Type ACTIVATE to restart, or Enter to keep the saves pending: ")
        if confirm() != "ACTIVATE":
            out.write("Saved choices remain pending; no restart sent.\n")
            return 0
        with receipts.receipt_state_lock(receipts.state_dir(home), LOCK) as locked:
            if not locked:
                return 2
            fresh = status(home)
            if (not fresh.get("restartRequired") or fresh.get("revision") != current.get("revision")
                    or fresh.get("activationRequested")):
                out.write("Optional state changed. Check status before choosing activation again.\n")
                return 2
            row = _read(home, PENDING)
            gateway, _, live = receipts.read_gateway_state(home=home)
            if live is not True or not isinstance(gateway, dict):
                return 2
            row["activationRequested"] = {"pid": gateway.get("pid"), "startTime": gateway.get("start_time")}
            _write(home, PENDING, row)
        # Fence persists before a restart that may terminate this very terminal.
        restarted = restart_gateway(getattr(plan, "timeout_s", None))
        out.write("Restart requested. Reconnect and check optional-setup status before testing.\n" if restarted
                  else "Restart could not be confirmed. Check the gateway and optional-setup status; no automatic retry.\n")
        return 0 if restarted else 1
    except (Exception, KeyboardInterrupt, EOFError):
        out.write("Activation not confirmed. Saved choices remain; reconnect and check optional-setup status.\n")
        return 1


def register_cli(subs) -> None:
    parser = subs.add_parser("optional-setup", help="Private optional saves and one explicit activation")
    commands = parser.add_subparsers(dest="optional_action", required=True)
    commands.add_parser("status", help="Read activation state; never installs or restarts")
    save_parser = commands.add_parser("save", help="Privately save one optional credential")
    save_parser.add_argument("optional_choice", choices=("soniox", "even-ai"))
    commands.add_parser("activate", help="Review and explicitly activate saved optional choices")


def dispatch(args: argparse.Namespace) -> int:
    if args.optional_action == "save":
        return save("evenAi" if args.optional_choice == "even-ai" else "soniox")
    if args.optional_action == "activate":
        return activate()
    result = status()
    print(json.dumps(result, sort_keys=True))
    return 0 if result["state"] == "ready" else 1
