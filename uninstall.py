"""Ownership-safe full uninstall for the Hermes OcuClaw bundle.

Hermes 0.20 removes only the plugin checkout.  This module owns the product
operation that must run while the plugin code is still present: remove the
exact OcuClaw configuration, secrets, runtime files, and profile receipts;
preserve the shared Hermes session database and every unrecognised path; then
remove the setup bundle and plugin checkout last.

The operation is deliberately idempotent and receipt-driven.  A failed
owned-state cleanup leaves the plugin checkout in place so the same command
can be retried.  Final checkout removal first renames the tree atomically; if
deleting that tombstone fails, the receipt names an interpreter-level recovery
command independent of Hermes discovery and plugin metadata.  A verified
live Managed Serve Route is a preflight stop: the operator receives the
already-approved narrow teardown command and reruns the uninstall after
applying it.  Routes whose ownership is not proven are left alone.

Since #2084 the product also owns a second lifecycle Hermes does not manage:
the generated standalone Desktop runtime at
``<HERMES_HOME>/desktop-plugins/ocuclaw/plugin.js``.  Hermes Desktop scans that
directory itself, so generic ``hermes plugins remove ocuclaw`` removes the
Agent package and leaves that runtime loading.  This module is therefore the
only complete removal path, and it carries the recovery for the case where
generic removal already ran: :data:`ORPHAN_RECOVERY_SOURCE`, a self-contained
interpreter-level program that needs none of this package.

Since #3765 the precondition is "OcuClaw is not running" rather than "the
gateway is stopped" (see :mod:`uninstall_gate`). A host where the gateway is
stopped keeps the one-phase path. Where OcuClaw runs, the first call writes
the uninstall-pending marker and asks for one ``hermes gateway restart``; the
restarted gateway registers only the CLI, and the same command then removes
everything, including the Cloudways Tailscale pieces, and deletes the marker
last.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, Mapping, Optional, Sequence, TextIO

from . import uninstall_gate


EXIT_OK = 0
EXIT_PROBLEM = 1
EXIT_USAGE = 2
#: OcuClaw is running: the marker is written (or already was) and the
#: operator must run `hermes gateway restart`, then this command again.
EXIT_RESTART_REQUIRED = uninstall_gate.EXIT_RESTART_REQUIRED

PLUGIN_NAME = "ocuclaw"
SETUP_BUNDLE_NAME = "ocuclaw-setup"

SECRET_KEYS: Sequence[str] = (
    "OCUCLAW_RELAY_TOKEN",
    "OCUCLAW_SONIOX_API_KEY",
    "OCUCLAW_EVEN_AI_TOKEN",
    "OCUCLAW_TYPESAFE_API_KEY",
)

# Exact files written beneath the adapter's default Node runtime stateDir.
# Several names predate the Hermes lane, so the uninstall accepts only the
# dedicated <HERMES_HOME>/ocuclaw directory rather than trusting an arbitrary
# configured path as ownership proof.
RUNTIME_STATE_FILES: Sequence[str] = (
    "companion-snapshot.json",
    "debug-arm.json",
    "even-ai-settings.json",
    "even-terminal-transcript-cache.json",
    "liveui-trace.json",
    "ocuclaw-device-key.json",
    "ocuclaw-device-token.json",
    "ocuclaw-display-toggles.json",
    "ocuclaw-model-context-windows.json",
    "ocuclaw-relay-port.json",
    # Written by the Node runtime's saved-prompts store
    # (extensions/ocuclaw/src/runtime/saved-prompts-store.ts).
    "ocuclaw-saved-prompts.json",
    "ocuclaw-session-agents.json",
    "ocuclaw-session-pins.json",
    "ocuclaw-settings.json",
    "ocuclaw-stable-prompts.json",
    "session-agent-cache.json",
    "session-first-user-cache.json",
    "session-overrides.json",
    "session-title-cache.json",
)
RUNTIME_STATE_DIRS: Sequence[str] = ("internal-agent-runs",)

# Exact files written beneath <HERMES_HOME>/state by the Python adapter.
#
# Every OcuClaw writer that can land in this directory must appear here or be
# named as a documented retention in the removal contract; nothing owned may be
# left behind by accident. The list therefore includes the hidden lock sidecars
# the receipt state machines create next to their receipts
# (`relay_credential._generation_lock`, `receipts.receipt_state_lock`), which
# are OcuClaw-owned files even though no product state ever reaches them.
PROFILE_STATE_FILES: Sequence[str] = (
    ".ocuclaw.relay-credential.json.lock",
    # The Board store (board_watch.STORE_FILENAME) and the SQLite sidecars
    # that carry its name while a connection is open or was interrupted.
    "ocuclaw-board.db",
    "ocuclaw-board.db-journal",
    "ocuclaw-board.db-shm",
    "ocuclaw-board.db-wal",
    "ocuclaw.app-presence.json",
    "ocuclaw.cloudways-restart-pending.json",
    "ocuclaw.cloudways-setup.json",
    "ocuclaw.desktop-credentials.json",
    "ocuclaw.desktop-credentials.lock",
    "ocuclaw.desktop-pairing-activation.json",
    "ocuclaw.desktop-presenter-capability.json",
    "ocuclaw.first-run-phone-candidate.json",
    "ocuclaw.first-run-proof-attempt.json",
    "ocuclaw.first-run-proof.json",
    "ocuclaw.first-run-proof.lock",
    "ocuclaw.first-run-reply-delivery.json",
    # optional_setup.ACTIVE / optional_setup.LOCK.
    "ocuclaw.optional-active.json",
    "ocuclaw.optional-setup.lock",
    "ocuclaw.pairing-completion.json",
    "ocuclaw.relay-credential.json",
    "ocuclaw.tui-pairing-capability.json",
    # uninstall_gate.MARKER_FILENAME. Listed for completeness; removal skips
    # it in the bulk pass and deletes it last, once the plugin is gone, so a
    # failed run leaves OcuClaw off and the same command retryable (#3765).
    "ocuclaw.uninstall-pending.json",
)

# Exact files written directly beneath <HERMES_HOME> (not its state dir).
# restart_rpc.py keeps its restart-operation receipts there.
HOME_STATE_FILES: Sequence[str] = ("ocuclaw-restart-receipts.json",)


def _default_liveui_library_dir() -> Path:
    """Host-level LiveUI template library (glasses-ui-library.ts default root).

    It is user-authored content and the OpenClaw plugin reads the same folder,
    so uninstall preserves it and names it in the receipt.
    """

    return Path.home() / ".ocuclaw" / "liveui-library"


NARROW_ROUTE_TEARDOWN = "tailscale serve --tls-terminated-tcp=8446 off"


def _write_receipt(
    receipt: Mapping[str, Any],
    *,
    json_output: bool,
    stdout: TextIO,
) -> None:
    if json_output:
        stdout.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        return
    stdout.write(f"OcuClaw uninstall: {receipt.get('status', 'unknown')}\n")
    message = receipt.get("message")
    if isinstance(message, str) and message:
        stdout.write(f"{message}\n")
    command = receipt.get("command")
    if isinstance(command, str) and command:
        stdout.write(f"Run first: {command}\n")
    gate = receipt.get("gate")
    if isinstance(gate, Mapping):
        for key, value in (gate.get("checks") or {}).items():
            if not value:
                stdout.write(f"Still running: {key}\n")
    next_commands = [
        item for item in receipt.get("nextCommands") or () if isinstance(item, str)
    ]
    for index, item in enumerate(next_commands, start=1):
        stdout.write(f"Next {index}: {item}\n")
    cancel = [
        item for item in receipt.get("cancelCommands") or () if isinstance(item, str)
    ]
    if cancel:
        stdout.write(f"To cancel instead: {' then '.join(cancel)}\n")
    cloudways = receipt.get("cloudways")
    if isinstance(cloudways, Mapping):
        stdout.write(
            "Cloudways Tailscale: "
            f"{'removed' if cloudways.get('ok') else 'teardown failed'}\n"
        )
    route = receipt.get("route")
    if isinstance(route, Mapping):
        stdout.write(
            "Route: "
            f"{route.get('action', 'unknown')} ({route.get('reason', 'unspecified')})\n"
        )
        command = route.get("command")
        if isinstance(command, str) and command:
            stdout.write(f"Run first: {command}\n")
    for key, value in (receipt.get("finalChecks") or {}).items():
        stdout.write(f"Check {key}: {'pass' if value else 'fail'}\n")
    preserved = receipt.get("preserved")
    if isinstance(preserved, Mapping):
        for key, value in preserved.items():
            stdout.write(f"Preserved {key}: {value}\n")
    for item in receipt.get("removed") or ():
        stdout.write(f"Removed: {item}\n")
    for item in receipt.get("failures") or ():
        stdout.write(f"Failed: {item}\n")
    recovery = receipt.get("recoveryCommand")
    if isinstance(recovery, str) and recovery:
        stdout.write(f"Recovery command: {recovery}\n")
    for item in receipt.get("recoveryCommands") or ():
        stdout.write(f"Recovery command: {item}\n")
    retry = receipt.get("retryCommand")
    if isinstance(retry, str) and retry:
        stdout.write(f"Retry command: {retry}\n")


def _resolved(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def _valid_install_target(home: Path, plugin_dir: Path, module_dir: Path) -> bool:
    plugins_dir = home / "plugins"
    expected = plugins_dir / PLUGIN_NAME
    if (
        plugins_dir.is_symlink()
        or expected.is_symlink()
        or _resolved(plugins_dir) != plugins_dir.expanduser().absolute()
        or _resolved(expected) != expected.expanduser().absolute()
    ):
        return False
    return (
        plugin_dir.expanduser().absolute() == expected.expanduser().absolute()
        and _resolved(module_dir) == _resolved(expected)
    )


def _path_absent(path: Path) -> bool:
    try:
        return not path.exists()
    except OSError:
        return False


def _remove_file(path: Path, removed: list[str], failures: list[str]) -> None:
    try:
        path.unlink()
        removed.append(str(path))
    except FileNotFoundError:
        return
    except OSError:
        failures.append(str(path))


def _remove_readonly_and_retry(func: Any, path: str, error: Any) -> None:
    """Preserve mode bits, add owner-write, and retry one failed removal."""

    if isinstance(error, tuple):
        error = error[1]
    if not isinstance(error, PermissionError):
        raise error

    # Git marks content-addressed objects read-only. Windows refuses to unlink
    # those files, while POSIX usually consults the parent directory instead.
    # Preserve every existing mode bit rather than replacing the mode with a
    # fixed value, and avoid following a checkout symlink outside the owned
    # tree. The parent retry matches Hermes's own profile-removal helper.
    for candidate in (path, os.path.dirname(path)):
        if not candidate or os.path.islink(candidate):
            continue
        try:
            mode = os.stat(candidate, follow_symlinks=False).st_mode
            os.chmod(candidate, mode | stat.S_IWUSR)
        except OSError:
            pass
    func(path)


def _rmtree_owned(path: Path, *, attempts: int = 3) -> None:
    """Remove one validated owned tree with Hermes-compatible retries."""

    last_error: Optional[OSError] = None
    for attempt in range(max(1, attempts)):
        try:
            if sys.version_info >= (3, 12):
                shutil.rmtree(path, onexc=_remove_readonly_and_retry)
            else:
                shutil.rmtree(path, onerror=_remove_readonly_and_retry)
            return
        except FileNotFoundError as exc:
            if _path_absent(path):
                return
            last_error = exc
            if attempt < attempts - 1:
                time.sleep(0.3 * (attempt + 1))
        except OSError as exc:
            last_error = exc
            if _path_absent(path):
                return
            if attempt < attempts - 1:
                time.sleep(0.3 * (attempt + 1))
    if last_error is not None:
        raise last_error


def _remove_dir(path: Path, removed: list[str], failures: list[str]) -> None:
    # An already-absent directory is not a removal. `_remove_file` has always
    # said so by swallowing FileNotFoundError without recording anything; the
    # rmtree helper below treats the same condition as success, so without
    # this guard a rerun's receipt claims to have removed a directory that was
    # not there.
    if _path_absent(path):
        return
    try:
        _rmtree_owned(path)
        removed.append(str(path))
    except FileNotFoundError:
        if not _path_absent(path):
            failures.append(str(path))
    except OSError:
        failures.append(str(path))


def _desktop_runtime_path(home: Path) -> Path:
    """The one generated standalone Desktop runtime (#2084 topology)."""

    return home / "desktop-plugins" / PLUGIN_NAME / "plugin.js"


def _nested_desktop_runtime_path(home: Path) -> Path:
    """The pre-#2084 unified-half entry, still a live Hermes 0.21 door."""

    return home / "plugins" / PLUGIN_NAME / "desktop" / "plugin.js"


def _desktop_entry_owned(path: Path) -> bool:
    from .desktop_pairing import plugin_owned

    return plugin_owned(path)


def _remove_owned_desktop_runtime(
    path: Path, removed: list[str], failures: list[str]
) -> None:
    """Remove the proven-owned runtime, its own temporaries, and its folder.

    ``desktop_pairing._write_private_plugin`` renders through a private
    ``.plugin.js.<pid>.<token>.tmp`` sibling and replaces atomically, so an
    interrupted reconcile can leave one behind. Those names are written by
    this product and by nothing else, so they are owned artifacts too — and
    leaving one would also keep the generated folder alive. The folder itself
    is removed only when it ends up empty, which preserves any unrecognised
    sibling exactly as ``desktop_pairing.remove_owned_plugin`` does.
    """

    _remove_file(path, removed, failures)
    parent = path.parent
    try:
        leftovers = sorted(parent.glob(f".{path.name}.*.tmp"))
    except OSError:
        leftovers = []
    for leftover in leftovers:
        if leftover.is_symlink() or not leftover.is_file():
            continue
        _remove_file(leftover, removed, failures)
    try:
        parent.rmdir()
    except OSError:
        # A foreign sibling keeps the directory. The owned file is gone.
        return
    removed.append(str(parent))


def _owned_desktop_runtime_absent(home: Path) -> bool:
    """No OcuClaw-owned entry sits at either Hermes 0.21 Desktop loader door.

    ``apps/desktop/src/contrib/runtime-loader.ts`` ``diskRoots()`` scans exactly
    ``<home>/desktop-plugins/<folder>/plugin.js`` and
    ``<home>/plugins/<folder>/desktop/plugin.js`` and keys live plugins by entry
    file path, so those two paths are the whole loadable surface. A *foreign*
    file at either door is deliberately not a failure: uninstall preserves it,
    and the receipt reports it as preserved rather than pretending it is ours.
    """

    # One enumeration, not a third mirror: desktop_pairing owns the door walk
    # (#2085), and it also catches a marker-owned copy sitting under a foreign
    # folder name — which is still loadable, so it must still fail this check.
    from .desktop_pairing import loadable_desktop_runtimes

    for entry in loadable_desktop_runtimes(home):
        if _desktop_entry_owned(entry):
            return False
    return True


def _host_install_metadata_absent(home: Path) -> bool:
    """Fail closed if Hermes still records this plugin's install provenance."""

    path = home / "plugins" / ".install-metadata.json"
    if _path_absent(path):
        return True
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(value, Mapping) and PLUGIN_NAME not in value


def _remove_plugin_proxy_through_host(home: Path, target: Path) -> bool:
    """Ask Hermes's public plugin command to remove an empty checkout proxy."""

    sibling_name = "hermes.exe" if sys.platform == "win32" else "hermes"
    sibling = Path(sys.executable).with_name(sibling_name)
    executable = str(sibling) if sibling.is_file() else shutil.which("hermes")
    if executable is None:
        return False
    environment = dict(os.environ)
    environment["HERMES_HOME"] = str(home)
    try:
        completed = subprocess.run(
            [executable, "plugins", "remove", PLUGIN_NAME],
            cwd=str(home.parent),
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0 and _path_absent(target)


def _remove_nested(document: Dict[str, Any], *keys: str) -> bool:
    current: Any = document
    parents = []
    for key in keys[:-1]:
        if not isinstance(current, dict) or not isinstance(current.get(key), dict):
            return False
        parents.append((current, key))
        current = current[key]
    if not isinstance(current, dict) or keys[-1] not in current:
        return False
    del current[keys[-1]]
    for parent, key in reversed(parents):
        child = parent.get(key)
        if isinstance(child, dict) and not child:
            del parent[key]
    return True


def _remove_plugin_registry(document: Dict[str, Any]) -> bool:
    plugins = document.get("plugins")
    if not isinstance(plugins, dict):
        return False
    changed = False
    for key in ("enabled", "disabled"):
        values = plugins.get(key)
        if isinstance(values, list):
            filtered = [value for value in values if value != PLUGIN_NAME]
            if filtered != values:
                plugins[key] = filtered
                changed = True
    entries = plugins.get("entries")
    if isinstance(entries, dict) and PLUGIN_NAME in entries:
        del entries[PLUGIN_NAME]
        changed = True
        if not entries:
            del plugins["entries"]
    if not plugins:
        del document["plugins"]
    return changed


def _without_ocuclaw_config(
    document: Mapping[str, Any],
) -> tuple[Dict[str, Any], bool]:
    updated = copy.deepcopy(dict(document))
    changed = False
    changed |= _remove_nested(updated, "platforms", PLUGIN_NAME)
    changed |= _remove_nested(updated, "display", "platforms", PLUGIN_NAME)
    changed |= _remove_plugin_registry(updated)
    return updated, changed


def _config_absent(document: Mapping[str, Any]) -> bool:
    platforms = document.get("platforms")
    if isinstance(platforms, Mapping) and PLUGIN_NAME in platforms:
        return False
    display = document.get("display")
    if isinstance(display, Mapping):
        display_platforms = display.get("platforms")
        if isinstance(display_platforms, Mapping) and PLUGIN_NAME in display_platforms:
            return False
    plugins = document.get("plugins")
    if isinstance(plugins, Mapping):
        for key in ("enabled", "disabled"):
            values = plugins.get(key)
            if isinstance(values, list) and PLUGIN_NAME in values:
                return False
        entries = plugins.get("entries")
        if isinstance(entries, Mapping) and PLUGIN_NAME in entries:
            return False
    return True


def _runtime_state_absent(runtime_state_dir: Path) -> bool:
    return all(_path_absent(runtime_state_dir / name) for name in RUNTIME_STATE_FILES) and all(
        _path_absent(runtime_state_dir / name) for name in RUNTIME_STATE_DIRS
    )


def _profile_state_absent(home: Path) -> bool:
    """Every owned state file is gone, except the uninstall-pending marker.

    The marker is removed last, after the plugin checkout, and has its own
    final check (``uninstallMarkerAbsent``).
    """

    state = home / "state"
    return all(
        _path_absent(state / name)
        for name in PROFILE_STATE_FILES
        if name != uninstall_gate.MARKER_FILENAME
    )


def _home_state_absent(home: Path) -> bool:
    return all(_path_absent(home / name) for name in HOME_STATE_FILES)


def _default_home() -> Optional[Path]:
    from .receipts import resolve_receipt_home

    return resolve_receipt_home()


def _default_config_api() -> Any:
    from hermes_cli.config import (
        get_env_value,
        load_config,
        remove_env_value,
        save_config,
    )

    return SimpleNamespace(
        get_env_value=get_env_value,
        load_config=load_config,
        remove_env_value=remove_env_value,
        save_config=save_config,
    )


def _default_bundle_path() -> Path:
    from agent.skill_bundles import bundle_path_for

    return Path(bundle_path_for(SETUP_BUNDLE_NAME))


def _default_bundle_owned(path: Path) -> bool:
    from . import setup_bootstrap

    data, problem = setup_bootstrap._read_bundle_mapping(path)
    return bool(
        problem is None
        and isinstance(data, dict)
        and setup_bootstrap._semantic_tuple(data)
        == setup_bootstrap._semantic_tuple(setup_bootstrap.DESIRED_BUNDLE)
    )


def _default_facts() -> Mapping[str, Any]:
    from .cli import _default_facts as collect

    return collect()


def _default_teardown_permitted(facts: Mapping[str, Any]) -> bool:
    from .cli import _default_teardown_permitted as permitted

    return permitted(facts)


def _default_route_receipt(home: Path) -> tuple[Optional[Path], bool]:
    from . import receipts

    path = receipts.managed_serve_route_path()
    record, status = receipts.read_managed_serve_route()
    mine = receipts.fingerprint_home(home)
    owned = bool(
        status == "ok"
        and isinstance(record, Mapping)
        and mine
        and record.get("owningGatewayFingerprint") == mine
    )
    return path, owned


def _platform_extra(document: Mapping[str, Any]) -> Mapping[str, Any]:
    try:
        extra = document["platforms"][PLUGIN_NAME]["extra"]
    except (KeyError, TypeError):
        return {}
    return extra if isinstance(extra, Mapping) else {}


def _not_running_gate(
    evidence: Mapping[str, Any],
    observed: Mapping[str, Any],
    home: Path,
) -> Dict[str, Any]:
    """Evaluate the "OcuClaw is not running" gate for this run (#3765)."""

    marker_at = uninstall_gate.marker_written_at(home)
    gate = uninstall_gate.evaluate(
        evidence,
        gateway_live=observed.get("gatewayLive"),
        marker_at=marker_at,
    )
    gate["markerPresent"] = marker_at is not None
    gate["relayEndpoints"] = list(evidence.get("relayEndpoints") or ())
    return gate


def _restart_required_receipt(
    gate: Mapping[str, Any], *, marker: Path, marker_written: bool
) -> Dict[str, Any]:
    return {
        "status": "restart_required",
        "reason": (
            "uninstall_pending_written"
            if marker_written
            else "waiting_for_gateway_restart"
        ),
        "message": (
            "OcuClaw is running. It is now marked for removal and stays off "
            "after the next gateway restart."
            if marker_written
            else "OcuClaw is marked for removal but is still running. "
            "Restart the gateway first."
        ),
        "marker": str(marker),
        "gate": {"checks": dict(gate.get("checks") or {}), "ok": bool(gate.get("ok"))},
        "nextCommands": list(uninstall_gate.FINISH_COMMANDS),
        "cancelCommands": list(uninstall_gate.CANCEL_COMMANDS),
    }


# -- Cloudways teardown (#3765) -------------------------------------------------

#: File names the userspace tailscaled we provision writes into
#: ``~/.local/share/tailscale`` (its logtail config and rotating logs).
_TAILSCALED_LOG_PREFIX = "tailscaled.log"


def _cloudways_owned_present(layout: Any) -> bool:
    """Plugin-owned Cloudways evidence, never bare binaries.

    ``~/bin/tailscale`` on its own may be the user's; the watchdog job and
    script, this plugin's tgz install receipt, or a host CLI receipt naming
    this provisioner are ours.
    """

    from . import cloudways, receipts

    if cloudways.find_watchdog_job(layout) is not None:
        return True
    if layout.script_path.exists() or layout.tgz_receipt.exists():
        return True
    receipt = receipts.read_tailscale_cli()
    provisioner = (
        receipt.provisioner
        if receipt is not None
        else cloudways._raw_receipt_provisioner(receipts.tailscale_cli_path())
    )
    return provisioner == cloudways.RECEIPT_PROVISIONER


def _remove_empty_dir(path: Optional[Path], removed: list[str]) -> Optional[str]:
    """rmdir when empty; returns a preservation note when something stays."""

    if path is None or _path_absent(path):
        return None
    if path.is_symlink() or not path.is_dir():
        return "preserved_not_a_plain_directory"
    try:
        path.rmdir()
    except OSError:
        return "preserved_not_empty"
    removed.append(str(path))
    return None


def _remove_tailscaled_log_dir(
    path: Path, removed: list[str], *, binaries_removed: bool
) -> Optional[str]:
    """Remove ``~/.local/share/tailscale`` only when it holds nothing foreign.

    Our tailscaled writes only ``tailscaled.log*`` there. A legacy supervisor
    or any other entry means another install uses it, so it stays.
    """

    if _path_absent(path):
        return None
    if path.is_symlink() or not path.is_dir():
        return "preserved_not_a_plain_directory"
    if not binaries_removed:
        return "preserved_binaries_kept"
    try:
        entries = list(path.iterdir())
    except OSError:
        return "preserved_unreadable"
    for entry in entries:
        if (
            not entry.name.startswith(_TAILSCALED_LOG_PREFIX)
            or entry.is_symlink()
            or not entry.is_file()
        ):
            return "preserved_foreign_content"
    for entry in entries:
        try:
            entry.unlink()
        except OSError:
            return "preserved_remove_failed"
    try:
        path.rmdir()
    except OSError:
        return "preserved_remove_failed"
    removed.append(str(path))
    return None


def _cloudways_route_handled(home: Path) -> bool:
    """True when the Cloudways rollback will turn the Serve route off itself.

    On Cloudways the route lives in the userspace tailscaled, and the plain
    `tailscale serve ... off` we would print cannot reach it (no system
    tailscale, private socket). The rollback runs the port-scoped `off`
    through that install's own CLI and socket, then removes the route
    receipt, so uninstall must not stop and ask for the plain command.
    """

    try:
        from . import cloudways

        return _cloudways_owned_present(cloudways.Layout.resolve(hermes_home=home))
    except Exception:  # noqa: BLE001 - unknown means "not handled": keep the old stop
        return False


def _default_cloudways_teardown(home: Path) -> Optional[Dict[str, Any]]:
    """Undo the Cloudways install when plugin-owned pieces exist, else None.

    Runs while the gateway (and the watchdog's daemon) may still be up, so the
    rollback's port-scoped ``serve ... off`` still reaches the daemon. The
    identity under ``~/.tailscale`` is purged unless a foreign install owns
    the host receipt (the rollback's own keep rule).
    """

    from . import cloudways, receipts

    layout = cloudways.Layout.resolve(hermes_home=home)
    if not _cloudways_owned_present(layout):
        return None
    report = dict(cloudways.rollback(layout, purge_identity=True))
    removed = list(report.get("removed") or [])
    preserved: Dict[str, str] = {}
    binaries_removed = not report.get("binariesKept") and _path_absent(
        layout.tailscaled
    )
    note = _remove_tailscaled_log_dir(
        layout.legacy_supervisor_dir, removed, binaries_removed=binaries_removed
    )
    if note:
        preserved[str(layout.legacy_supervisor_dir)] = note
    note = _remove_empty_dir(layout.bin_dir, removed)
    if note:
        preserved[str(layout.bin_dir)] = note
    host_state = receipts.host_state_dir()
    note = _remove_empty_dir(host_state, removed)
    if note:
        preserved[str(host_state)] = note
    elif host_state is not None and _path_absent(host_state):
        # Its parent exists only to hold that state directory.
        _remove_empty_dir(host_state.parent, removed)
    report["removed"] = removed
    if preserved:
        report["preserved"] = preserved
    return report


def _runtime_state_dir(home: Path, document: Mapping[str, Any]) -> Path:
    try:
        configured = document["platforms"][PLUGIN_NAME]["extra"].get("stateDir")
    except (KeyError, TypeError, AttributeError):
        configured = None
    if isinstance(configured, str) and configured.strip():
        return Path(configured.strip()).expanduser()
    return home / PLUGIN_NAME


def _safe_runtime_state_dir(home: Path, plugin_dir: Path, runtime: Path) -> bool:
    """Require the dedicated default directory as runtime-state ownership proof."""

    del plugin_dir
    expected = home / PLUGIN_NAME
    return (
        runtime.expanduser().absolute() == expected.expanduser().absolute()
        and not expected.is_symlink()
        and _resolved(expected) == expected.expanduser().absolute()
    )


def _safe_profile_state_dir(home: Path) -> bool:
    expected = home / "state"
    return (
        not expected.is_symlink()
        and _resolved(expected) == expected.expanduser().absolute()
    )


def _strict_raw_config(home: Path) -> Dict[str, Any]:
    from .yaml_compat import yaml

    path = home / "config.yaml"
    if path.is_symlink() or _resolved(path) != path.expanduser().absolute():
        raise OSError("config.yaml is not a direct profile file")
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    data = yaml.safe_load(text)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise TypeError("Hermes configuration root is not a mapping")
    return data


def _profile_env_key_present(home: Path, key: str) -> Optional[bool]:
    path = home / ".env"
    if path.is_symlink() or _resolved(path) != path.expanduser().absolute():
        return None
    try:
        lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    except FileNotFoundError:
        return False
    except OSError:
        return None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        if stripped.startswith(f"{key}="):
            return True
    return False


def _try_profile_lock(home: Path) -> Any:
    digest = hashlib.sha256(str(home).encode("utf-8")).hexdigest()[:20]
    path = Path(tempfile.gettempdir()) / f"ocuclaw-uninstall-{digest}.lock"
    handle = path.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            if handle.read(1) == b"":
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError):
        handle.close()
        return None
    return handle


def _release_profile_lock(handle: Any) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def _tombstone_recovery_command(path: Path) -> str:
    if sys.platform == "win32":
        callback = "onexc" if sys.version_info >= (3, 12) else "onerror"
        code = (
            "import os, shutil, stat; "
            f"shutil.rmtree({str(path)!r}, {callback}=lambda f,p,e: "
            "(os.chmod(p, os.stat(p).st_mode | stat.S_IWUSR), f(p))[-1])"
        )
    else:
        code = f"import shutil; shutil.rmtree({str(path)!r})"
    args = [sys.executable, "-c", code]
    return (
        subprocess.list2cmdline(args) if sys.platform == "win32" else shlex.join(args)
    )


# The self-contained orphan-recovery program.
#
# Generic `hermes plugins remove ocuclaw` deletes the Agent checkout and with
# it every `hermes ocuclaw ...` verb, while the generated standalone Desktop
# runtime under `<home>/desktop-plugins/ocuclaw/` keeps loading — that door is
# default-ON and belongs to no Hermes package. Recovery therefore cannot be an
# OcuClaw command; it must be a program the user can paste with nothing but a
# Python interpreter, which is the same interpreter-level precedent as
# `_tombstone_recovery_command` below.
#
# It refuses to act while the Agent plugin is still installed (the supported
# uninstall owns that case), proves the first-line ownership marker before
# touching the runtime, refuses symlinked or redirected paths, preserves
# anything foreign, and is safe to run twice. It removes the generated runtime
# and the private presenter capability that exists only to authorize it —
# nothing else — and says so.
#
# Written with double quotes only, so `shlex.join` renders one clean
# single-quoted shell argument that the docs can carry verbatim.
ORPHAN_RECOVERY_SOURCE = r'''import json, os, pathlib, sys

MARKER = "// OCUCLAW-OWNED-DESKTOP-PAIRING-PLUGIN v1"
home = pathlib.Path(os.environ.get("HERMES_HOME") or (pathlib.Path.home() / ".hermes"))
home = home.expanduser().absolute()
runtime = home / "desktop-plugins" / "ocuclaw" / "plugin.js"
capability = home / "state" / "ocuclaw.desktop-presenter-capability.json"
checkout = home / "plugins" / "ocuclaw"
removed = []
kept = []

def direct(path, chain):
    try:
        if any(item.is_symlink() for item in chain):
            return False
        return path.absolute() == path.resolve(strict=False)
    except OSError:
        return False

def runtime_state():
    if not direct(runtime, (home, runtime.parent.parent, runtime.parent, runtime)):
        return "unsafe path"
    if not runtime.is_file():
        return "absent"
    try:
        with runtime.open("r", encoding="utf-8") as stream:
            first = stream.readline().rstrip("\n")
    except (OSError, UnicodeError):
        return "unreadable"
    return "owned" if first == MARKER else "not OcuClaw-owned"

def capability_state():
    if not direct(capability, (home, capability.parent, capability)):
        return "unsafe path"
    if not capability.is_file():
        return "absent"
    try:
        payload = json.loads(capability.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return "unreadable"
    if not isinstance(payload, dict) or set(payload) != {"v", "capability"}:
        return "not OcuClaw-owned"
    if payload.get("v") != 1 or not isinstance(payload.get("capability"), str):
        return "not OcuClaw-owned"
    return "owned"

if checkout.exists():
    sys.stdout.write("refused: the OcuClaw Agent plugin is still installed at " + str(checkout) + "\n")
    sys.stdout.write("Run `hermes ocuclaw uninstall` instead. This command only removes an orphan left behind by generic Hermes plugin removal.\n")
    raise SystemExit(2)

state = runtime_state()
if state == "owned":
    runtime.unlink()
    removed.append(str(runtime))
    for leftover in sorted(runtime.parent.glob(".plugin.js.*.tmp")):
        if leftover.is_file() and not leftover.is_symlink():
            leftover.unlink()
            removed.append(str(leftover))
    try:
        runtime.parent.rmdir()
        removed.append(str(runtime.parent))
    except OSError:
        pass
elif state != "absent":
    kept.append(str(runtime) + " (" + state + ")")

if state in ("owned", "absent"):
    state = capability_state()
    if state == "owned":
        capability.unlink()
        removed.append(str(capability))
    elif state != "absent":
        kept.append(str(capability) + " (" + state + ")")

for item in removed:
    sys.stdout.write("removed: " + item + "\n")
for item in kept:
    sys.stdout.write("preserved: " + item + "\n")
if not removed and not kept:
    sys.stdout.write("no OcuClaw-owned Hermes Desktop orphan found under " + str(home) + "\n")
sys.stdout.write("This command removes only the generated Desktop runtime and its private presenter capability. Any other OcuClaw state under " + str(home / "state") + " is removed only by `hermes ocuclaw uninstall`.\n")
raise SystemExit(1 if kept else 0)
'''


def desktop_orphan_recovery_command(interpreter: Optional[str] = None) -> str:
    """The documented, copy-pasteable orphan recovery command.

    ``interpreter`` defaults to ``python3`` so the string is identical in the
    docs on every machine; callers that must run it in *this* process's
    interpreter pass ``sys.executable``.
    """

    args = [interpreter or "python3", "-c", ORPHAN_RECOVERY_SOURCE]
    return (
        subprocess.list2cmdline(args) if sys.platform == "win32" else shlex.join(args)
    )


def desktop_removal_notice(home: Optional[Path] = None) -> Dict[str, Any]:
    """Observe the generated Desktop runtime for removal guidance. Read-only.

    Honest placement note: a genuine orphan can only exist once the Agent
    package is gone, and with it every `hermes ocuclaw ...` verb — so no
    OcuClaw command can be running to detect it. The reachable, useful half is
    therefore the *pre-removal warning*, which `doctor` prints while the
    plugin still exists. The orphan branch stays here because the same
    observation answers both questions and is worth pinning by test.
    """

    resolved = Path(home) if home is not None else _default_home()
    if resolved is None:
        return {"state": "unresolved", "agentInstalled": False, "orphaned": False}
    resolved = _resolved(resolved)
    runtime = _desktop_runtime_path(resolved)
    try:
        agent_installed = (resolved / "plugins" / PLUGIN_NAME).exists()
    except OSError:
        agent_installed = False
    if _path_absent(runtime):
        state = "absent"
    elif _desktop_entry_owned(runtime):
        state = "owned"
    else:
        state = "foreign"
    notice: Dict[str, Any] = {
        "state": state,
        "runtimePath": str(runtime),
        "agentInstalled": agent_installed,
        "orphaned": state == "owned" and not agent_installed,
    }
    if notice["orphaned"]:
        notice["recoveryCommand"] = desktop_orphan_recovery_command()
    return notice


def _mark_pending(
    home: Path,
    gate: Mapping[str, Any],
    *,
    acquire_lock: Callable[[Path], Any],
    json_output: bool,
    stdout: TextIO,
) -> int:
    """Phase 1: write the uninstall-pending marker and ask for one restart."""

    profile_lock = acquire_lock(home)
    if profile_lock is None:
        receipt = {"status": "busy", "reason": "uninstall_already_running"}
        _write_receipt(receipt, json_output=json_output, stdout=stdout)
        return EXIT_PROBLEM
    marker = uninstall_gate.marker_path(home)
    marker_written = False
    try:
        # Another run may have marked it while this one waited for consent.
        if not uninstall_gate.uninstall_pending(home):
            uninstall_gate.write_marker(home)
            marker_written = True
    except OSError:
        receipt = {"status": "refused", "reason": "marker_unwritable"}
        _write_receipt(receipt, json_output=json_output, stdout=stdout)
        return EXIT_PROBLEM
    finally:
        _release_profile_lock(profile_lock)
    _write_receipt(
        _restart_required_receipt(gate, marker=marker, marker_written=marker_written),
        json_output=json_output,
        stdout=stdout,
    )
    return EXIT_RESTART_REQUIRED


def _cancel_pending(home: Path, *, json_output: bool, stdout: TextIO) -> int:
    """``hermes ocuclaw uninstall --cancel``: clear the marker, keep OcuClaw."""

    marker = uninstall_gate.marker_path(home)
    try:
        cleared = uninstall_gate.remove_marker(home)
    except OSError:
        receipt = {
            "status": "refused",
            "reason": "marker_unremovable",
            "marker": str(marker),
        }
        _write_receipt(receipt, json_output=json_output, stdout=stdout)
        return EXIT_PROBLEM
    if not cleared:
        receipt = {
            "status": "not_pending",
            "message": "No OcuClaw uninstall is pending. Nothing changed.",
        }
        _write_receipt(receipt, json_output=json_output, stdout=stdout)
        return EXIT_OK
    receipt = {
        "status": "uninstall_cancelled",
        "message": (
            "The pending uninstall is cancelled. OcuClaw starts again after "
            "the next gateway restart."
        ),
        "removed": [str(marker)],
        "nextCommands": [uninstall_gate.RESTART_COMMAND],
    }
    _write_receipt(receipt, json_output=json_output, stdout=stdout)
    return EXIT_OK


def run_uninstall(
    *,
    assume_yes: bool = False,
    json_output: bool = False,
    home: Optional[Path] = None,
    plugin_dir: Optional[Path] = None,
    module_dir: Optional[Path] = None,
    runtime_state_dir: Optional[Path] = None,
    bundle_path: Optional[Path] = None,
    bundle_owned: Optional[bool] = None,
    host_route_receipt_path: Optional[Path] = None,
    route_receipt_owned: Optional[bool] = None,
    facts: Optional[Mapping[str, Any]] = None,
    teardown_permitted: Optional[bool] = None,
    config_api: Any = None,
    raw_config_fn: Any = None,
    profile_lock_fn: Any = None,
    facts_fn: Any = None,
    profile_secret_present_fn: Any = None,
    host_plugin_remove_fn: Optional[Callable[[Path, Path], bool]] = None,
    running_evidence_fn: Optional[
        Callable[[Path, Mapping[str, Any]], Mapping[str, Any]]
    ] = None,
    cloudways_teardown_fn: Optional[
        Callable[[Path], Optional[Mapping[str, Any]]]
    ] = None,
    liveui_library_dir: Optional[Path] = None,
    cancel: bool = False,
    input_fn: Any = input,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
) -> int:
    """Perform one full uninstall and print its complete receipt.

    While OcuClaw runs, the first call only marks it for removal and asks for
    one gateway restart (``restart_required``, exit 3); the gateway then boots
    without OcuClaw and the same command finishes (#3765). ``cancel`` clears
    that mark instead.
    """

    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    resolved_home = Path(home) if home is not None else _default_home()
    if resolved_home is None:
        receipt = {"status": "refused", "reason": "profile_unresolved"}
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_USAGE
    resolved_home = _resolved(resolved_home)
    if cancel:
        return _cancel_pending(resolved_home, json_output=json_output, stdout=out)
    target = Path(plugin_dir) if plugin_dir is not None else resolved_home / "plugins" / PLUGIN_NAME
    loaded_from = Path(module_dir) if module_dir is not None else Path(__file__).parent
    if not _valid_install_target(resolved_home, target, loaded_from):
        receipt = {
            "status": "refused",
            "reason": "installed_plugin_path_mismatch",
        }
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_USAGE

    api = config_api if config_api is not None else _default_config_api()
    try:
        original_config = api.load_config()
        if not isinstance(original_config, dict):
            raise TypeError("Hermes configuration is not a mapping")
        config = copy.deepcopy(original_config)
    except Exception as exc:  # noqa: BLE001 - refusal must leave the command intact
        err.write(f"OcuClaw uninstall could not read Hermes configuration: {exc}\n")
        receipt = {"status": "refused", "reason": "config_unreadable"}
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_PROBLEM

    runtime = Path(runtime_state_dir) if runtime_state_dir is not None else _runtime_state_dir(resolved_home, config)
    if not _safe_runtime_state_dir(resolved_home, target, runtime):
        receipt = {
            "status": "refused",
            "reason": "unsafe_runtime_state_dir",
        }
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_USAGE
    if not _safe_profile_state_dir(resolved_home):
        receipt = {
            "status": "refused",
            "reason": "unsafe_profile_state_dir",
        }
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_USAGE
    setup_bundle = Path(bundle_path) if bundle_path is not None else _default_bundle_path()
    owns_setup_bundle = (
        bool(bundle_owned)
        if bundle_owned is not None
        else _default_bundle_owned(setup_bundle)
    )
    from .tui_pairing import widget_owned, widget_path
    from .desktop_pairing import plugin_owned, plugin_path

    pairing_widget = widget_path(resolved_home)
    owns_pairing_widget = (
        not _path_absent(pairing_widget) and widget_owned(pairing_widget)
    )
    desktop_pairing_plugin = plugin_path(resolved_home)
    owns_desktop_pairing_plugin = (
        not _path_absent(desktop_pairing_plugin)
        and plugin_owned(desktop_pairing_plugin)
    )
    route_path = host_route_receipt_path
    route_owned = route_receipt_owned
    if route_owned is None:
        route_path, route_owned = _default_route_receipt(resolved_home)
    collect_facts = facts_fn if facts_fn is not None else _default_facts
    observed = dict(facts) if facts is not None else dict(collect_facts())
    can_teardown = (
        bool(teardown_permitted)
        if teardown_permitted is not None
        else _default_teardown_permitted(observed)
    )
    collect_evidence = (
        running_evidence_fn
        if running_evidence_fn is not None
        else lambda profile, document: uninstall_gate.observe(
            profile,
            plugin_dir=target,
            runtime_dir=runtime,
            platform_extra=_platform_extra(document),
        )
    )
    marker = uninstall_gate.marker_path(resolved_home)

    # The gate is "OcuClaw is not running", not "the gateway is stopped"
    # (#3765). On Cloudways `hermes gateway stop` restarts the container, so
    # a stopped gateway can never be observed there, and right after any boot
    # Hermes can report the gateway not live while OcuClaw already runs.
    gate = _not_running_gate(
        collect_evidence(resolved_home, config), observed, resolved_home
    )
    if not gate["ok"]:
        if gate["markerPresent"]:
            # Phase 1 already ran: never a second marker, only the same
            # instructions again.
            _write_receipt(
                _restart_required_receipt(gate, marker=marker, marker_written=False),
                json_output=json_output,
                stdout=out,
            )
            return EXIT_RESTART_REQUIRED
        if not assume_yes:
            try:
                err.write(
                    "Remove OcuClaw code, setup, configuration, secrets, pairing, "
                    "and first-run state while preserving Hermes sessions? "
                    "OcuClaw is running, so this takes one gateway restart. [y/N] "
                )
                err.flush()
                answer = input_fn()
            except (EOFError, KeyboardInterrupt):
                answer = ""
            if str(answer).strip().lower() not in {"y", "yes"}:
                receipt = {"status": "cancelled", "reason": "confirmation_declined"}
                _write_receipt(receipt, json_output=json_output, stdout=out)
                return EXIT_PROBLEM
        return _mark_pending(
            resolved_home,
            gate,
            acquire_lock=(
                profile_lock_fn if profile_lock_fn is not None else _try_profile_lock
            ),
            json_output=json_output,
            stdout=out,
        )
    # A present marker is the operator's recorded consent from phase 1.
    consent_recorded = bool(gate["markerPresent"])

    if (
        can_teardown
        and observed.get("serveClassification") == "ready"
        and not _cloudways_route_handled(resolved_home)
    ):
        receipt = {
            "status": "route_teardown_required",
            "route": {
                "action": "required_before_uninstall",
                "reason": "verified_owned_route_is_live",
                "command": NARROW_ROUTE_TEARDOWN,
            },
        }
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_PROBLEM

    if not assume_yes and not consent_recorded:
        try:
            err.write(
                "Remove OcuClaw code, setup, configuration, secrets, pairing, "
                "and first-run state while preserving Hermes sessions? [y/N] "
            )
            err.flush()
            answer = input_fn()
        except (EOFError, KeyboardInterrupt):
            answer = ""
        if str(answer).strip().lower() not in {"y", "yes"}:
            receipt = {"status": "cancelled", "reason": "confirmation_declined"}
            _write_receipt(receipt, json_output=json_output, stdout=out)
            return EXIT_PROBLEM

    acquire_lock = (
        profile_lock_fn if profile_lock_fn is not None else _try_profile_lock
    )
    profile_lock = acquire_lock(resolved_home)
    if profile_lock is None:
        receipt = {"status": "busy", "reason": "uninstall_already_running"}
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_PROBLEM

    read_raw = (
        raw_config_fn
        if raw_config_fn is not None
        else lambda: _strict_raw_config(resolved_home)
    )
    try:
        locked_raw_config = read_raw()
        if not isinstance(locked_raw_config, dict):
            raise TypeError("Raw Hermes configuration is not a mapping")
        locked_config = api.load_config()
        if not isinstance(locked_config, dict):
            raise TypeError("Hermes configuration is not a mapping")
        locked_runtime = _runtime_state_dir(resolved_home, locked_config)
        if not _safe_runtime_state_dir(resolved_home, target, locked_runtime):
            raise ValueError("unsafe_runtime_state_dir")
        runtime = locked_runtime
    except Exception as exc:  # noqa: BLE001 - strict refusal before mutation
        _release_profile_lock(profile_lock)
        reason = (
            "unsafe_runtime_state_dir"
            if str(exc) == "unsafe_runtime_state_dir"
            else "raw_config_unreadable"
        )
        receipt = {"status": "refused", "reason": reason}
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_PROBLEM

    # Confirmation is unbounded human time. Re-observe the process and Serve
    # safety boundary under the uninstall lock immediately before mutation.
    observed = dict(facts) if facts is not None else dict(collect_facts())
    if route_receipt_owned is None:
        route_path, route_owned = _default_route_receipt(resolved_home)
    can_teardown = (
        bool(teardown_permitted)
        if teardown_permitted is not None
        else _default_teardown_permitted(observed)
    )
    gate = _not_running_gate(
        collect_evidence(resolved_home, locked_config), observed, resolved_home
    )
    if not gate["ok"]:
        # OcuClaw started while the operator was confirming. Consent is
        # already given, so mark it now (idempotent) and ask for the restart.
        marker_written = False
        if not gate["markerPresent"]:
            try:
                uninstall_gate.write_marker(resolved_home)
                marker_written = True
            except OSError:
                _release_profile_lock(profile_lock)
                receipt = {"status": "refused", "reason": "marker_unwritable"}
                _write_receipt(receipt, json_output=json_output, stdout=out)
                return EXIT_PROBLEM
        _release_profile_lock(profile_lock)
        _write_receipt(
            _restart_required_receipt(
                gate, marker=marker, marker_written=marker_written
            ),
            json_output=json_output,
            stdout=out,
        )
        return EXIT_RESTART_REQUIRED
    if (
        can_teardown
        and observed.get("serveClassification") == "ready"
        and not _cloudways_route_handled(resolved_home)
    ):
        _release_profile_lock(profile_lock)
        receipt = {
            "status": "route_teardown_required",
            "route": {
                "action": "required_before_uninstall",
                "reason": "verified_owned_route_is_live",
                "command": NARROW_ROUTE_TEARDOWN,
            },
        }
        _write_receipt(receipt, json_output=json_output, stdout=out)
        return EXIT_PROBLEM

    removed: list[str] = []
    failures: list[str] = []
    externally_supplied_secret_keys: list[str] = []

    # Cloudways first (#3765): the watchdog job, userspace tailscaled, its
    # script, binaries, receipts and identity. The `hermes ocuclaw cloudways`
    # verbs that could undo them vanish with the plugin, and the daemon is
    # still reachable now for the port-scoped Serve teardown. A failure keeps
    # the plugin (and this command) in place for a retry.
    teardown_cloudways = (
        cloudways_teardown_fn
        if cloudways_teardown_fn is not None
        else _default_cloudways_teardown
    )
    try:
        cloudways_report = teardown_cloudways(resolved_home)
    except Exception as exc:  # noqa: BLE001 - reported, and retryable
        cloudways_report = {"ok": False, "errors": [f"{type(exc).__name__}: {exc}"]}
    if cloudways_report is not None:
        removed.extend(str(item) for item in cloudways_report.get("removed") or ())
        if not cloudways_report.get("ok"):
            failures.append("cloudways-teardown")

    for key in SECRET_KEYS:
        try:
            before = api.get_env_value(key)
            removed_from_profile = False
            if before is not None:
                removed_from_profile = bool(api.remove_env_value(key))
            if api.get_env_value(key) is not None:
                failures.append(f"secret:{key}")
            elif removed_from_profile:
                removed.append(f"secret:{key}")
            elif before is not None:
                externally_supplied_secret_keys.append(key)
        except Exception:  # noqa: BLE001 - no secret value enters the receipt
            failures.append(f"secret:{key}")

    state_root = resolved_home / "state"
    for name in PROFILE_STATE_FILES:
        if name == uninstall_gate.MARKER_FILENAME:
            continue  # removed last, once the plugin is gone
        _remove_file(state_root / name, removed, failures)
    for name in HOME_STATE_FILES:
        _remove_file(resolved_home / name, removed, failures)
    for name in RUNTIME_STATE_FILES:
        _remove_file(runtime / name, removed, failures)
    for name in RUNTIME_STATE_DIRS:
        _remove_dir(runtime / name, removed, failures)

    runtime_clean = _runtime_state_absent(runtime)
    if runtime_clean:
        # `<HERMES_HOME>/ocuclaw` is the dedicated runtime directory the safety
        # guard above already refused to proceed without. Emptied of every
        # owned file it goes too, so a complete uninstall leaves no OcuClaw
        # directory behind; an unrecognised file keeps it, exactly like the
        # generated Desktop folder.
        try:
            runtime.rmdir()
        except OSError:
            pass
        else:
            removed.append(str(runtime))
    if owns_setup_bundle:
        _remove_file(setup_bundle, removed, failures)
        _remove_file(
            setup_bundle.with_name(f".{SETUP_BUNDLE_NAME}.lock"),
            removed,
            failures,
        )
    if owns_pairing_widget:
        _remove_file(pairing_widget, removed, failures)
    if owns_desktop_pairing_plugin:
        _remove_owned_desktop_runtime(desktop_pairing_plugin, removed, failures)

    liveui_library = (
        Path(liveui_library_dir)
        if liveui_library_dir is not None
        else _default_liveui_library_dir()
    )

    route: Dict[str, Any]
    classification = observed.get("serveClassification")
    if classification == "absent" and route_owned and route_path is not None:
        owned_route_path = Path(route_path)
        _remove_file(owned_route_path, removed, failures)
        # `receipts.route_receipt_lock` serializes on a sidecar next to the
        # receipt precisely so it survives the receipt being replaced by
        # rename. That makes it an owned OcuClaw file the receipt removal would
        # otherwise strand; it holds no state, so it goes with its receipt.
        _remove_file(owned_route_path.with_suffix(".lock"), removed, failures)
        route = (
            {"action": "receipt_removed", "reason": "route_absent"}
            if _path_absent(owned_route_path)
            else {"action": "receipt_remove_failed", "reason": "filesystem_error"}
        )
    elif classification == "absent":
        route = {"action": "absent", "reason": "no_live_route"}
    else:
        route = {"action": "preserved", "reason": "ownership_not_proven"}

    profile_secret_present = (
        profile_secret_present_fn
        if profile_secret_present_fn is not None
        else lambda key: _profile_env_key_present(resolved_home, key)
    )
    profile_secrets_absent = True
    for key in SECRET_KEYS:
        try:
            profile_secrets_absent = (
                profile_secrets_absent and profile_secret_present(key) is False
            )
        except Exception:  # noqa: BLE001
            profile_secrets_absent = False

    owned_state_checks = {
        "profileSecretsAbsent": profile_secrets_absent,
        "profileStateAbsent": _profile_state_absent(resolved_home),
        "homeStateAbsent": _home_state_absent(resolved_home),
        "runtimeStateAbsent": runtime_clean,
        "setupBundleAbsent": _path_absent(setup_bundle) if owns_setup_bundle else True,
        "pairingWidgetAbsent": (
            _path_absent(pairing_widget) if owns_pairing_widget else True
        ),
        "desktopPairingPluginAbsent": (
            _path_absent(desktop_pairing_plugin)
            if owns_desktop_pairing_plugin
            else True
        ),
    }
    if not all(owned_state_checks.values()):
        failures.extend(key for key, passed in owned_state_checks.items() if not passed)

    # Removing plugin registration also removes the command on the next
    # process. Do it only after every retryable owned-state cleanup and route
    # receipt operation has succeeded.
    config_save_succeeded = False
    config_save_failed = False
    config_save_original = locked_raw_config
    if not failures:
        try:
            latest_raw_config = None
            for _attempt in range(8):
                candidate = read_raw()
                followup = read_raw()
                if not isinstance(candidate, dict) or not isinstance(followup, dict):
                    raise TypeError("Raw Hermes configuration is not a mapping")
                if candidate == followup:
                    latest_raw_config = followup
                    break
            if latest_raw_config is None:
                raise RuntimeError("Hermes configuration is changing concurrently")
            config_save_original = copy.deepcopy(latest_raw_config)
            config, config_changed = _without_ocuclaw_config(latest_raw_config)
            # This is the strict raw document, so disabling default stripping
            # cannot materialise merged schema defaults or drop explicit keys.
            if config_changed:
                api.save_config(config, strip_defaults=False)
                config_save_succeeded = True
        except Exception:  # noqa: BLE001 - receipt names the failed owner boundary
            config_save_failed = True
            failures.append("hermes-config")

    try:
        current_config = api.load_config()
    except Exception:  # noqa: BLE001
        current_config = None
    registration_absent = isinstance(current_config, Mapping) and _config_absent(
        current_config
    )
    config_restore_succeeded = False
    if config_save_failed and registration_absent:
        # Hermes's atomic writer can commit the replacement and then fail in a
        # later durability/permission step. A reported failure must leave the
        # command registered so this retained checkout remains retryable.
        try:
            api.save_config(config_save_original, strip_defaults=False)
            current_config = api.load_config()
            config_restore_succeeded = (
                isinstance(current_config, Mapping)
                and not _config_absent(current_config)
            )
            registration_absent = not config_restore_succeeded
        except Exception:  # noqa: BLE001
            config_restore_succeeded = False
        if not config_restore_succeeded:
            failures.append("config-restore")
    if config_save_succeeded and not registration_absent:
        # A failed or negative post-save check must not strand the retained
        # checkout without its command registration. Restore the pre-uninstall
        # document atomically and leave the operation retryable.
        try:
            api.save_config(
                config_save_original,
                strip_defaults=False,
            )
            restored = api.load_config()
            config_restore_succeeded = (
                isinstance(restored, Mapping) and not _config_absent(restored)
            )
        except Exception:  # noqa: BLE001
            config_restore_succeeded = False
        failures.append("config-final-check")
        if not config_restore_succeeded:
            failures.append("config-restore")
    pre_plugin_checks = {
        "configurationAbsent": isinstance(current_config, Mapping)
        and _config_absent(current_config),
        **owned_state_checks,
    }
    if not all(pre_plugin_checks.values()):
        failures.extend(key for key, passed in pre_plugin_checks.items() if not passed)

    tombstone = target.with_name(f".{PLUGIN_NAME}-uninstalling")
    plugin_renamed = False
    host_plugin_remove_accepted = False
    # A rerun over an already-removed checkout is the same
    # FileNotFoundError-as-success rule every owned-state removal above uses.
    # Without it the rename would fail, the receipt would report
    # `plugin-checkout-rename`, and the restore branch would put OcuClaw's
    # registration back into a profile that no longer has the plugin.
    checkout_already_removed = _path_absent(target) and _path_absent(tombstone)
    if not failures and not checkout_already_removed:
        if not _path_absent(tombstone):
            failures.append("plugin-tombstone-present")
        else:
            try:
                target.rename(tombstone)
                removed.append(str(target))
                plugin_renamed = True
            except OSError:
                failures.append("plugin-checkout-rename")

        if plugin_renamed:
            # Hermes 0.20.5+ owns profile-local install provenance in
            # plugins/.install-metadata.json. Its generic remove command has
            # no product cleanup hook, so OcuClaw performs every owned cleanup
            # first, atomically parks the real checkout, then gives the public
            # host command an empty proxy at the original path. Hermes can now
            # reconcile its sidecar without touching the read-only Git tree;
            # OcuClaw deletes that parked tree only after host acceptance.
            remove_through_host = (
                host_plugin_remove_fn
                if host_plugin_remove_fn is not None
                else _remove_plugin_proxy_through_host
            )
            try:
                target.mkdir()
                host_plugin_remove_accepted = bool(
                    remove_through_host(resolved_home, target)
                )
            except Exception:  # noqa: BLE001 - restore below keeps retry alive
                host_plugin_remove_accepted = False
            host_plugin_remove_accepted = (
                host_plugin_remove_accepted
                and _path_absent(target)
                and _host_install_metadata_absent(resolved_home)
            )
            if not host_plugin_remove_accepted:
                failures.append("host-plugin-remove")
                if not _path_absent(target):
                    try:
                        target.rmdir()
                    except OSError:
                        failures.append("plugin-remove-proxy")
                if _path_absent(target) and not _path_absent(tombstone):
                    try:
                        tombstone.rename(target)
                        plugin_renamed = False
                    except OSError:
                        failures.append("plugin-checkout-restore")

        if not plugin_renamed:
            # Rename is atomic: a failure leaves the complete checkout in
            # place, or the failed host handoff restored it. Restore
            # registration so the same command remains usable.
            try:
                api.save_config(
                    config_save_original,
                    strip_defaults=False,
                )
                restored = api.load_config()
                config_restore_succeeded = (
                    isinstance(restored, Mapping) and not _config_absent(restored)
                )
            except Exception:  # noqa: BLE001
                config_restore_succeeded = False
            pre_plugin_checks["configurationAbsent"] = False
            if not config_restore_succeeded:
                failures.append("config-restore")

    if plugin_renamed and host_plugin_remove_accepted:
        _remove_dir(tombstone, removed, failures)

    # The uninstall-pending marker goes last: until the plugin is gone it is
    # what keeps a restarted gateway from starting OcuClaw again.
    if not failures and _path_absent(target):
        _remove_file(marker, removed, failures)

    final_checks = {
        **pre_plugin_checks,
        "uninstallMarkerAbsent": _path_absent(marker),
        "hostPluginMetadataAbsent": _host_install_metadata_absent(resolved_home),
        # The acceptance question for #2086, asked of the loader's own two
        # doors rather than of the paths this run happens to have touched.
        # Checked last because the nested door lives inside the checkout that
        # is removed above.
        "ownedDesktopRuntimeAbsent": _owned_desktop_runtime_absent(resolved_home),
        "pluginAbsent": _path_absent(target),
        "pluginResidualAbsent": _path_absent(tombstone),
    }
    complete = not failures and all(final_checks.values())
    retry_is_available = (
        not config_save_succeeded or config_restore_succeeded
    ) and not _path_absent(target)
    tombstone_recovery = (
        _tombstone_recovery_command(tombstone)
        if not _path_absent(tombstone)
        else None
    )
    enable_then_retry = (
        config_save_succeeded
        and not config_restore_succeeded
        and not _path_absent(target)
    )
    receipt = {
        "status": "complete" if complete else "incomplete",
        "removed": sorted(set(removed)),
        "preserved": {
            "sharedHermesSessions": "preserved",
            "unrecognisedFiles": "preserved",
            "externalEnvironmentSecrets": "not_mutated_operator_owned",
            **(
                {"setupBundle": "preserved_foreign"}
                if not _path_absent(setup_bundle) and not owns_setup_bundle
                else {}
            ),
            **(
                {"pairingWidget": "preserved_foreign"}
                if not _path_absent(pairing_widget) and not owns_pairing_widget
                else {}
            ),
            **(
                {"desktopPairingPlugin": "preserved_foreign"}
                if not _path_absent(desktop_pairing_plugin)
                and not owns_desktop_pairing_plugin
                else {}
            ),
            **(
                {
                    "liveuiLibrary": (
                        f"preserved_user_content ({liveui_library}); "
                        "the OpenClaw plugin may share it"
                    )
                }
                if not _path_absent(liveui_library)
                else {}
            ),
            **{
                f"cloudways:{path}": note
                for path, note in (
                    (cloudways_report or {}).get("preserved") or {}
                ).items()
            },
        },
        **(
            {
                "cloudways": {
                    key: cloudways_report.get(key)
                    for key in (
                        "ok",
                        "jobRemoved",
                        "serveRouteRemoved",
                        "daemon",
                        "identityKept",
                        "receiptKept",
                        "binariesKept",
                        "errors",
                    )
                    if key in cloudways_report
                }
            }
            if cloudways_report is not None
            else {}
        ),
        "route": route,
        "finalChecks": final_checks,
        "failures": sorted(set(failures)),
        "externallySuppliedSecretKeys": sorted(
            set(externally_supplied_secret_keys)
        ),
        **(
            {"recoveryCommand": tombstone_recovery}
            if tombstone_recovery is not None
            else {}
        ),
        **(
            {
                "recoveryCommands": [
                    "hermes plugins enable ocuclaw --no-allow-tool-override",
                    "hermes ocuclaw uninstall",
                ]
            }
            if enable_then_retry
            else {}
        ),
        **(
            {"retryCommand": "hermes ocuclaw uninstall"}
            if retry_is_available and not complete
            else {}
        ),
    }
    _release_profile_lock(profile_lock)
    _write_receipt(receipt, json_output=json_output, stdout=out)
    return EXIT_OK if complete else EXIT_PROBLEM


__all__ = [
    "EXIT_OK",
    "EXIT_PROBLEM",
    "EXIT_RESTART_REQUIRED",
    "EXIT_USAGE",
    "HOME_STATE_FILES",
    "ORPHAN_RECOVERY_SOURCE",
    "PROFILE_STATE_FILES",
    "RUNTIME_STATE_FILES",
    "desktop_orphan_recovery_command",
    "desktop_removal_notice",
    "run_uninstall",
]
