"""Hermes Desktop pairing presenter asset and setup-tool activation bridge."""

from __future__ import annotations

import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from .pairing_completion import read_pairing_completion
from .receipts import (
    ReceiptUnavailableError,
    resolve_receipt_home,
    state_dir,
    write_json_receipt,
)
from .tui_pairing import (
    ACTIVATION_HOST,
    ACTIVATION_PATH,
    ACTIVATION_PORT,
    PAIRING_WAIT_SECONDS,
    RECEIPT_WAIT_SECONDS,
    _ActivationState,
    _completion_id,
    _handler_for,
)


PLUGIN_DIRNAME = "ocuclaw"
PLUGIN_FILENAME = "plugin.js"
PLUGIN_MARKER = "// OCUCLAW-OWNED-DESKTOP-PAIRING-PLUGIN v1"
# The Desktop source template is INERT build input, deliberately parked
# outside every Hermes Desktop entry shape (#2084).
#
# Hermes 0.21 Desktop discovers runtimes at two exact paths
# (apps/desktop/src/contrib/runtime-loader.ts diskRoots :242-269):
#   <hermes home>/desktop-plugins/<folder>/plugin.js   standalone, default-ON
#   <hermes home>/plugins/<folder>/desktop/plugin.js   unified agent-half
# and its install-time probe checks `<package root>/plugin.js` first,
# `<package root>/desktop/plugin.js` second
# (apps/desktop/electron/desktop-plugin-install.ts findDesktopEntry :178-192).
# Live plugins are keyed by ENTRY FILE PATH (runtime-loader.ts :283), so while
# the template shipped at `desktop/` the one `ocuclaw` id had two live copies
# and whichever loaded last won the UI.
#
# `desktop-template/` matches none of those exact segments — the loader's
# entrySegments are compared literally, not globbed — so the published Agent
# package carries no loadable Desktop entry at all. The single runtime is
# rendered by reconcile_pairing_plugin() below, at plugin_path(), and this
# module stays its sole writer. Moving the template does NOT take it out of
# Hermes's install-time security scan: that walks the whole package tree.
DESKTOP_TEMPLATE_DIRNAME = "desktop-template"
PLUGIN_SOURCE = (
    Path(__file__).resolve().parent / DESKTOP_TEMPLATE_DIRNAME / PLUGIN_FILENAME
)
ACTIVATION_CAPABILITY_FILENAME = "ocuclaw.desktop-pairing-activation.json"
PRESENTER_CAPABILITY_FILENAME = "ocuclaw.desktop-presenter-capability.json"
PRESENTER_CAPABILITY_PLACEHOLDER = "__OCUCLAW_DESKTOP_PRESENTER_CAPABILITY__"
THEME_REQUEST_PLACEHOLDER = "__OCUCLAW_DESKTOP_THEME_REQUEST__"
THEME_REQUEST_CONFIG_KEY = "desktopThemeRequestedAt"
# A UTC stamp written by `/ocuclaw-setup` when the operator says yes to the
# OcuClaw look; rendered verbatim into a single-quoted JS string, so the
# alphabet is pinned to what an ISO-8601 stamp needs and nothing that could
# close the literal.
_THEME_REQUEST_PATTERN = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,15}Z$")
_CAPABILITY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,128}$")


def plugin_path(home: Path) -> Path:
    return Path(home) / "desktop-plugins" / PLUGIN_DIRNAME / PLUGIN_FILENAME


# Hermes 0.21 Desktop runtime discovery, mirrored here so OcuClaw can check its
# own convergence (#2085) without importing anything from the test tree.
#
# `apps/desktop/src/contrib/runtime-loader.ts` diskRoots() :242-269 returns two
# scan roots with LITERAL entry segments — no globbing — and the live-plugin
# map at :283 is keyed by ENTRY FILE PATH, "unique across both roots". Two
# entry files therefore mean two live plugins under the one `ocuclaw` id, and
# whichever loads or reloads last wins the UI. That is the whole #2080 defect.
#
# `tests/desktop_loader_candidates.py` is the test-side mirror of this tuple;
# a test pins the two against each other so neither can drift alone.
DESKTOP_DISK_ROOTS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("desktop-plugins", ("plugin.js",)),
    ("plugins", ("desktop", "plugin.js")),
)


def loadable_desktop_runtimes(home: Path) -> List[Path]:
    """Every OcuClaw Desktop entry file Hermes 0.21 would load from ``home``.

    Walks both ``diskRoots()`` doors the way upstream does — each direct child
    directory of a scan root joined with that root's literal segments — and
    keeps the entries that are OcuClaw's: the ones in a folder named
    ``ocuclaw`` (the folder name IS the plugin identity on disk, and it is what
    the Hermes install modal derives for repo ``ocuclaw/ocuclaw``) plus any
    entry carrying the OcuClaw ownership marker, which catches a released
    hybrid copy that landed under some other folder name.
    """

    resolved_home = Path(home)
    found: List[Path] = []
    for root_name, entry_segments in DESKTOP_DISK_ROOTS:
        root = resolved_home / root_name
        try:
            children = sorted(root.iterdir(), key=lambda path: path.name)
        except OSError:
            continue
        for folder in children:
            if not folder.is_dir():
                continue
            entry = folder.joinpath(*entry_segments)
            if not entry.is_file():
                continue
            if folder.name == PLUGIN_DIRNAME or plugin_owned(entry):
                found.append(entry)
    return found


def desktop_convergence(home: Optional[Path] = None) -> Dict[str, Any]:
    """How many OcuClaw Desktop runtimes this profile would actually load.

    ``converged`` is the only shipping state: exactly one entry, and it is the
    one ``reconcile_pairing_plugin()`` owns. ``duplicate`` is the pre-#2084
    hybrid layout surviving an update — the Agent package update was supposed
    to remove the nested runtime entry and did not. ``misplaced`` is the same
    failure with our own copy missing as well.
    """

    resolved_home = Path(home) if home is not None else resolve_receipt_home()
    if resolved_home is None:
        return {"status": "home_unresolved", "runtimes": [], "extra": []}
    expected = plugin_path(resolved_home)
    runtimes = [str(path) for path in loadable_desktop_runtimes(resolved_home)]
    extra = [path for path in runtimes if path != str(expected)]
    if len(runtimes) > 1:
        # Several entries, ours among them, is the surviving-hybrid duplicate.
        # Several entries, ours ABSENT, is misplaced: "keep this one" must
        # never point at a file that does not exist.
        status = "duplicate" if str(expected) in runtimes else "misplaced"
    elif not runtimes:
        status = "absent"
    elif not extra:
        status = "converged"
    else:
        status = "misplaced"
    return {
        "status": status,
        "runtimes": runtimes,
        "extra": extra,
        "expected": str(expected),
    }


def desktop_convergence_message(report: Dict[str, Any]) -> Optional[str]:
    """The operator-facing line for a convergence failure, or ``None``.

    ``absent`` stays silent on purpose: a profile with no runtime at all is
    already reported by the reconcile receipt's own presenter warning, and
    saying it twice would train operators to skim past this one.
    """

    status = report.get("status")
    if status not in {"duplicate", "misplaced"}:
        return None
    expected = report.get("expected")
    extra = [str(path) for path in report.get("extra") or []]
    removals = "\n".join(f"    rm {path}" for path in extra)
    if status == "duplicate":
        count = len(report.get("runtimes") or [])
        headline = (
            f"DUPLICATE OCUCLAW DESKTOP RUNTIME — Hermes Desktop can load "
            f"{count} copies of the 'ocuclaw' plugin from this profile at "
            "once, so the status bar position, the calm popup and the pairing "
            "presenter change depending on which copy loaded last."
        )
        keep = f"  Keep this one (OcuClaw renders it): {expected}"
        fix = (
            "  Delete the leftover copy from an older OcuClaw version, then "
            "restart the Hermes gateway:"
        )
    else:
        found = ", ".join(str(path) for path in (report.get("runtimes") or []))
        headline = (
            "MISPLACED OCUCLAW DESKTOP RUNTIME — every OcuClaw Desktop "
            f"runtime Hermes can load from this profile ({found}) is one "
            "OcuClaw does not manage, so OcuClaw cannot keep it current."
        )
        keep = f"  OcuClaw's own runtime is missing from: {expected}"
        fix = (
            "  Delete the unmanaged copy, then restart the Hermes gateway so "
            "OcuClaw renders its own:"
        )
    return "\n".join(
        [
            headline,
            keep,
            fix,
            removals,
            "  This OcuClaw update did not converge on its own.",
        ]
    )


def activation_capability_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(home)
    return None if directory is None else directory / ACTIVATION_CAPABILITY_FILENAME


def presenter_capability_path(home: Optional[Path] = None) -> Optional[Path]:
    directory = state_dir(home)
    return None if directory is None else directory / PRESENTER_CAPABILITY_FILENAME


def read_presenter_capability(home: Optional[Path] = None) -> Optional[str]:
    path = presenter_capability_path(home)
    if path is None:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    if not isinstance(payload, dict) or set(payload) != {"v", "capability"}:
        return None
    capability = payload.get("capability")
    if payload.get("v") != 1 or not isinstance(capability, str):
        return None
    return capability if _CAPABILITY_PATTERN.fullmatch(capability) else None


def read_activation_capability(home: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    path = activation_capability_path(home)
    if path is None:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    required = {
        "v",
        "surface",
        "address",
        "controlUrl",
        "callbackUrl",
        "callbackToken",
        "claimCapability",
        "runId",
        "expiresAtMs",
    }
    if not isinstance(payload, dict) or set(payload) != required:
        return None
    if payload.get("v") != 1 or payload.get("surface") != "desktop":
        return None
    if any(
        not isinstance(payload.get(key), str) or not payload.get(key)
        for key in required - {"v", "expiresAtMs"}
    ):
        return None
    if not isinstance(payload.get("expiresAtMs"), int):
        return None
    return payload


def _remove_activation_capability(path: Path, claim_capability: str) -> None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        recorded = str(payload.get("claimCapability") or "")
    except (OSError, UnicodeError, ValueError):
        return
    if not hmac.compare_digest(recorded, claim_capability):
        return
    try:
        path.unlink()
    except OSError:
        pass


def read_desktop_theme_request(config: Any) -> str:
    """The operator's OcuClaw-look stamp from a raw config mapping, or ''."""
    node: Any = config
    for key in ("platforms", "ocuclaw", "extra", THEME_REQUEST_CONFIG_KEY):
        if not isinstance(node, dict):
            return ""
        node = node.get(key)
    if not isinstance(node, str):
        return ""
    return node if _THEME_REQUEST_PATTERN.fullmatch(node) else ""


def _desktop_theme_request_from_host() -> str:
    try:
        from hermes_cli.config import read_raw_config

        return read_desktop_theme_request(read_raw_config())
    except Exception:  # noqa: BLE001 - no hermes / unreadable config renders ''
        return ""


def _safe_plugin_path(home: Path) -> Optional[Path]:
    resolved_home = Path(home).expanduser().absolute()
    root = resolved_home / "desktop-plugins"
    directory = root / PLUGIN_DIRNAME
    target = directory / PLUGIN_FILENAME
    try:
        if any(path.is_symlink() for path in (resolved_home, root, directory, target)):
            return None
        if target.resolve(strict=False) != target.absolute():
            return None
        if directory.resolve(strict=False) != directory.absolute():
            return None
    except OSError:
        return None
    return target


def _write_private_plugin(path: Path, content: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    )
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", closefd=True) as stream:
            fd = -1
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def plugin_owned(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8") as stream:
            return stream.readline().rstrip("\n") == PLUGIN_MARKER
    except (OSError, UnicodeError):
        return False


def remove_owned_plugin(path: Path) -> bool:
    if not plugin_owned(path):
        return not path.exists()
    try:
        path.unlink()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    try:
        path.parent.rmdir()
    except OSError:
        # The plugin file is the owned artifact. Preserve any unrecognised
        # siblings instead of treating their directory as our teardown.
        pass
    return True


def reconcile_pairing_plugin(
    home: Optional[Path] = None,
    *,
    theme_request: Optional[str] = None,
) -> Dict[str, Any]:
    """Install or update only the exact OcuClaw-owned Desktop runtime plugin.

    ``theme_request`` is the operator's OcuClaw-look stamp; ``None`` reads it
    from the host config, so the file re-renders the moment the setup tool
    records a yes and Hermes Desktop hot-reloads it.
    """

    resolved_home = Path(home) if home is not None else resolve_receipt_home()
    if resolved_home is None:
        return {"status": "error", "reason": "profile_unresolved"}
    target = _safe_plugin_path(resolved_home)
    if target is None:
        return {"status": "error", "reason": "unsafe_desktop_plugin_path"}
    try:
        source = PLUGIN_SOURCE.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return {"status": "error", "reason": "desktop_plugin_source_unreadable"}
    if not source.startswith(PLUGIN_MARKER + "\n"):
        return {"status": "error", "reason": "desktop_plugin_source_unowned"}
    if source.count(PRESENTER_CAPABILITY_PLACEHOLDER) != 1:
        return {"status": "error", "reason": "desktop_plugin_capability_slot_invalid"}
    if source.count(THEME_REQUEST_PLACEHOLDER) != 1:
        return {"status": "error", "reason": "desktop_plugin_theme_slot_invalid"}
    if theme_request is None:
        theme_request = _desktop_theme_request_from_host()
    elif not (theme_request == "" or _THEME_REQUEST_PATTERN.fullmatch(theme_request)):
        return {"status": "error", "reason": "desktop_plugin_theme_request_invalid"}
    if target.exists() and not plugin_owned(target):
        return {
            "status": "preserved",
            "reason": "foreign_desktop_plugin_present",
            "path": str(target),
        }
    presenter_capability = read_presenter_capability(resolved_home)
    if presenter_capability is None:
        presenter_capability = secrets.token_urlsafe(32)
        capability_path = presenter_capability_path(resolved_home)
        if capability_path is None:
            return {"status": "error", "reason": "profile_unresolved"}
        try:
            write_json_receipt(
                capability_path, {"v": 1, "capability": presenter_capability}
            )
        except ReceiptUnavailableError:
            return {
                "status": "error",
                "reason": "desktop_presenter_capability_unavailable",
            }
    rendered_source = source.replace(
        PRESENTER_CAPABILITY_PLACEHOLDER, presenter_capability
    ).replace(THEME_REQUEST_PLACEHOLDER, theme_request)
    try:
        current = target.read_text(encoding="utf-8") if target.exists() else None
        if current == rendered_source:
            return {"status": "unchanged", "path": str(target)}
        # The deep-link modal copies the shipped bytes verbatim, so a pristine
        # template — marker present, capability placeholder still unresolved —
        # is the Desktop-installed copy. Claim that copy in place by resolving
        # only its capability slot. A literal no-op would leave the placeholder
        # and the presenter could never authenticate against the loopback
        # control server; installing elsewhere would leave two live copies and
        # a "Desktop plugin 'ocuclaw' already exists" refusal on the next
        # deep link. Adopting is the one behaviour that keeps a single folder
        # AND a working presenter.
        adopted = current == source
        _write_private_plugin(target, rendered_source)
    except (OSError, UnicodeError):
        return {"status": "error", "reason": "desktop_plugin_write_failed"}
    if current is None:
        status = "created"
    elif adopted:
        status = "adopted"
    else:
        status = "updated"
    return {"status": status, "path": str(target)}


def run_desktop_pairing(
    address: str,
    *,
    control_url: str,
    home: Optional[Path] = None,
    wait_seconds: float = PAIRING_WAIT_SECONDS,
    receipt_wait_seconds: float = RECEIPT_WAIT_SECONDS,
    completion_reader: Callable[[], Any] = read_pairing_completion,
) -> Dict[str, Any]:
    """Activate the Desktop presenter and return its secret-free result."""

    resolved_home = Path(home) if home is not None else resolve_receipt_home()
    if resolved_home is None:
        return {
            "ok": False,
            "state": "refused",
            "code": "profile_unresolved",
            "message": "The active Hermes profile could not be resolved.",
        }
    report = reconcile_pairing_plugin(resolved_home)
    if report.get("status") == "preserved":
        return {
            "ok": False,
            "state": "refused",
            "code": "foreign_desktop_plugin_present",
            "message": (
                "A non-OcuClaw Desktop plugin occupies the OcuClaw pairing "
                "path and was preserved."
            ),
        }
    if report.get("status") not in {"created", "updated", "unchanged", "adopted"}:
        return {
            "ok": False,
            "state": "failed",
            "code": str(report.get("reason") or "desktop_plugin_unavailable"),
            "message": "The supported Hermes Desktop pairing presenter is unavailable.",
        }

    callback_token = secrets.token_urlsafe(32)
    claim_capability = secrets.token_urlsafe(32)
    run_id = secrets.token_urlsafe(24)
    callback_path = f"{ACTIVATION_PATH}/result/{run_id}"
    callback_url = f"http://{ACTIVATION_HOST}:{ACTIVATION_PORT}{callback_path}"
    activation = {
        "v": 1,
        "surface": "desktop",
        "address": address,
        "controlUrl": control_url,
        "callbackUrl": callback_url,
        "callbackToken": callback_token,
        "runId": run_id,
        "expiresAtMs": int((time.time() + wait_seconds) * 1000),
    }
    callback_state = _ActivationState(
        token=callback_token,
        run_id=run_id,
        activation=activation,
        owner_tui_pid=None,
        surface="desktop",
        claim_capability=claim_capability,
    )
    try:
        from http.server import ThreadingHTTPServer

        server = ThreadingHTTPServer(
            (ACTIVATION_HOST, ACTIVATION_PORT),
            _handler_for(callback_state, callback_path),
        )
    except OSError:
        return {
            "ok": False,
            "state": "failed",
            "code": "pairing_activation_port_unavailable",
            "message": (
                f"Loopback port {ACTIVATION_PORT} is unavailable, so the "
                "in-window pairing panel could not open."
            ),
        }
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    before_id = _completion_id(completion_reader())
    capability_path = activation_capability_path(resolved_home)
    if capability_path is None:
        server.server_close()
        return {
            "ok": False,
            "state": "failed",
            "code": "profile_unresolved",
            "message": "The active Hermes profile could not be resolved.",
        }
    capability = {**activation, "claimCapability": claim_capability}
    try:
        write_json_receipt(capability_path, capability)
    except ReceiptUnavailableError:
        server.server_close()
        return {
            "ok": False,
            "state": "failed",
            "code": "desktop_activation_capability_unavailable",
            "message": "The private Desktop pairing activation could not be created.",
        }
    try:
        thread.start()
        if not callback_state.event.wait(max(0.0, wait_seconds)):
            return {
                "ok": False,
                "state": "failed",
                "code": "desktop_pairing_timeout",
                "message": (
                    "Pairing timed out. Ensure OcuClaw is running on your "
                    "Even G2, then retry pairing."
                ),
            }
        result = callback_state.result or {
            "state": "failed",
            "code": "callback_missing",
        }
        if result["state"] == "completed":
            deadline = time.monotonic() + max(0.0, receipt_wait_seconds)
            while True:
                after_id = _completion_id(completion_reader())
                if after_id is not None and after_id != before_id:
                    return {
                        "ok": True,
                        "state": "completed",
                        "code": "paired",
                        "message": "Paired. The phone connected back and confirmed it.",
                    }
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.05)
            return {
                "ok": False,
                "state": "failed",
                "code": "completion_receipt_missing",
                "message": (
                    "Desktop observed completion, but the managed gateway did "
                    "not record a new pairing receipt. Pairing is not confirmed."
                ),
            }
        return {
            "ok": False,
            "state": result["state"],
            "code": result["code"],
            "message": "Pairing did not complete. The setup checkpoint remains open.",
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1.0)
        _remove_activation_capability(capability_path, claim_capability)


__all__ = [
    "ACTIVATION_CAPABILITY_FILENAME",
    "DESKTOP_TEMPLATE_DIRNAME",
    "PRESENTER_CAPABILITY_FILENAME",
    "PRESENTER_CAPABILITY_PLACEHOLDER",
    "THEME_REQUEST_CONFIG_KEY",
    "THEME_REQUEST_PLACEHOLDER",
    "PLUGIN_FILENAME",
    "PLUGIN_MARKER",
    "PLUGIN_SOURCE",
    "activation_capability_path",
    "plugin_owned",
    "plugin_path",
    "read_activation_capability",
    "read_desktop_theme_request",
    "read_presenter_capability",
    "reconcile_pairing_plugin",
    "remove_owned_plugin",
    "run_desktop_pairing",
    "presenter_capability_path",
]
