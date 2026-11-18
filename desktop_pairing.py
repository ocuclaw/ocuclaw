"""Hermes Desktop pairing presenter asset and setup-tool activation bridge."""

from __future__ import annotations

import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import pairing
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
    _unfinished_result,
)


logger = logging.getLogger(__name__)

PLUGIN_DIRNAME = "ocuclaw"
PLUGIN_FILENAME = "plugin.js"
PLUGIN_MARKER = "// OCUCLAW-OWNED-DESKTOP-PAIRING-PLUGIN v1"
COMPANION_VERSION_MARKER = "// OCUCLAW-DESKTOP-COMPANION version="
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
    # The activation's phone-code decision is optional: an activation with an
    # explicit wait records none.
    if not isinstance(payload, dict) or set(payload) - {"phoneCode"} != required:
        return None
    if "phoneCode" in payload and payload["phoneCode"] not in PHONE_CODE_DECISIONS:
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
    """The one path this bundle writes, with links followed to the real home.

    Hermes Desktop resolves its home lexically and reads straight through any
    link on the way down (`backend-env.ts` `normalizeHermesHomeRoot`), so a
    linked ancestor — `/home -> /var/home` on Fedora Atomic, a dotfile-managed
    `~/.hermes`, a moved home — names the very folder Desktop loads from.
    Refusing those was a silent skip: no `plugin.js`, no error the user ever
    sees, the Desktop icon simply never updates (#3367; helper sibling #3366).
    So resolve the home once and operate on the real path.

    Two links are still refused, and now each one is logged with the path:

    * a linked `<root>/ocuclaw` plugin folder — Hermes Desktop does not load a
      symlinked plugin directory, so writing through it produces a file that
      nothing reads;
    * a linked `plugin.js` — the final component is the file being replaced,
      and following it would overwrite whatever it points at.
    """

    given = Path(home)
    try:
        resolved_home = given.expanduser().resolve()
        root = (resolved_home / "desktop-plugins").resolve()
        directory = root / PLUGIN_DIRNAME
        target = directory / PLUGIN_FILENAME
        if directory.is_symlink():
            logger.warning(
                "OcuClaw Desktop plugin not regenerated: the plugin folder %s "
                "is a symlink, and Hermes Desktop does not load a linked "
                "plugin folder. Remove the link and retry.",
                directory,
            )
            return None
        if target.is_symlink():
            logger.warning(
                "OcuClaw Desktop plugin not regenerated: %s is a symlink, and "
                "this file is replaced in place rather than followed. Remove "
                "the link and retry.",
                target,
            )
            return None
    except OSError as error:
        logger.warning(
            "OcuClaw Desktop plugin not regenerated: the plugin path under %s "
            "could not be resolved (%s).",
            given,
            error,
        )
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
        if current and COMPANION_VERSION_MARKER in current:
            companion_version = re.findall(
                r"^// OCUCLAW-DESKTOP-COMPANION version=(\d+\.\d+\.\d+)$", current, re.M
            )
            bundle_version = re.search(
                r"^version: (\d+\.\d+\.\d+)$",
                (Path(__file__).resolve().parent / "plugin.yaml").read_text(encoding="utf-8"),
                re.M,
            )
            if len(companion_version) != 1 or bundle_version is None:
                return {"status": "preserved", "reason": "desktop_companion_version_invalid"}
            if tuple(map(int, companion_version[0].split("."))) >= tuple(map(int, bundle_version[1].split("."))):
                # Local startup may supply local authority, but must not erase
                # a newer independently installed remote-status UI.
                rendered_source = current
                for slot, value in (("PRESENTER_CAPABILITY", presenter_capability),
                                    ("THEME_REQUEST", theme_request)):
                    pattern = rf"^const {slot} = '[^'\n]*';?$"
                    if len(re.findall(pattern, rendered_source, re.M)) != 1:
                        return {"status": "preserved", "reason": "desktop_companion_slot_invalid"}
                    rendered_source = re.sub(pattern, f"const {slot} = '{value}'", rendered_source, flags=re.M)
            else:
                rendered_source = rendered_source.replace(
                    PLUGIN_MARKER + "\n",
                    PLUGIN_MARKER + "\n" + COMPANION_VERSION_MARKER + bundle_version[1] + "\n", 1,
                )
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


DESKTOP_ROUTE_PROBE_TIMEOUT_SECONDS = 3.0
# The window's lines are the terminal's (#5223 keeps the one copy).
PHONE_CODE_MISSING = pairing.PHONE_CODE_MISSING
PHONE_CODE_PAIRING_TYPED = pairing.PHONE_CODE_PAIRING_TYPED
PHONE_CODE_OUTAGE = pairing.PHONE_CODE_OUTAGE
PHONE_CODE_SENT = pairing.PHONE_CODE_SENT
# What a backend answers for a route nobody mounted
# (hermes_cli/web_server_dashboard.py mount_spa). Desktop's backend is
# headless, and its catch-all names no path; the probe below only ever asks
# OcuClaw's own route, so that answer still speaks for OcuClaw's. A
# `hermes dashboard` backend names the path.
DESKTOP_UNMOUNTED_ROUTE_MARKERS = (
    "Headless backend (hermes serve)",
    "No such API endpoint: /api/plugins/ocuclaw/",
)
# The code stays desktop_relaunch_required for the SKILL's recovery table; the
# person is sent to the card, whose "Restart gateway" restarts Desktop's
# backend without closing the window. The card names the quit only when that
# restart is unavailable.
DESKTOP_RELAUNCH_REQUIRED_MESSAGE = (
    "Hermes Desktop has not loaded OcuClaw's pairing panel yet: it was "
    "already running when OcuClaw was installed. Click Restart gateway on "
    "the OcuClaw card at the top right if that button is present. Otherwise "
    "open Desktop's command palette (Ctrl+K on Linux/Windows, Cmd+K on macOS), "
    "search Restart gateway, and select it there. Wait for OcuClaw ready, "
    "then retry pairing. If the card asks you to quit and reopen Hermes "
    "Desktop instead, do that. Nothing is wrong with the glasses or the phone."
)


def _desktop_custom_route() -> bool:
    from . import custom_route, health

    config, _ = health.setup_raw_config()
    platforms = config.get("platforms")
    platform = platforms.get("ocuclaw") if isinstance(platforms, dict) else None
    extra = platform.get("extra") if isinstance(platform, dict) else None
    return custom_route.configured_phone_address(extra) is not None


# The terminal's waits (pairing.py), so both Hermes surfaces wait alike.
PHONE_CODE_STATUS_TIMEOUT_SECONDS = pairing.PHONE_CODE_STATUS_TIMEOUT_SECONDS


def phone_code_status(address: str, control_url: str, credential: str, opener: Any) -> Dict[str, Any]:
    """Ask the relay before opening an exchange; older/unreachable relays are off."""
    try:
        status, body = pairing._post(
            control_url, {"v": 1, "op": "phone-code-status", "address": address,
                          "customRoute": _desktop_custom_route()},
            credential=credential, opener=opener, timeout=PHONE_CODE_STATUS_TIMEOUT_SECONDS,
        )
    except pairing.ControlError:
        return {"available": False, "reason": "off"}
    if status != 200 or not isinstance(body, dict):
        return {"available": False, "reason": "off"}
    return body


PHONE_CODE_CREATE_TIMEOUT_SECONDS = pairing.PHONE_CODE_CREATE_TIMEOUT_SECONDS

# A phone code lives ten minutes. While one is in play the activation gives
# the person most of that to type it in and pair, instead of the five-minute
# exchange's 345 s.
PHONE_CODE_WAIT_SECONDS = 600.0
# Hermes cuts a tool call off at its tool deadline (420 s by default), and the
# activation waits inside the setup tool's call: it ends this far before.
TOOL_DEADLINE_MARGIN_SECONDS = 15.0


def _host_tool_deadline_seconds() -> Optional[float]:
    """Hermes's deadline for one tool call, in seconds; None when unbounded.

    The same resolution Hermes's tool executor uses (``timeouts.tools.*`` in
    config.yaml, then HERMES_CONCURRENT_TOOL_TIMEOUT_S, then 420 s). If it
    cannot be read, the 420 s default is assumed.
    """
    try:
        from agent.deadline import resolve_timeout

        batch = resolve_timeout("tools.concurrent_batch", default=420.0,
                                env_var="HERMES_CONCURRENT_TOOL_TIMEOUT_S")
        return resolve_timeout("tools.sequential_call", default=batch)
    except Exception:  # noqa: BLE001 - an older or absent Hermes: its default
        return 420.0


def _phone_code_wait_seconds() -> float:
    """The activation's budget while a phone code is in play."""
    wait = PHONE_CODE_WAIT_SECONDS
    deadline = _host_tool_deadline_seconds()
    if deadline is not None:
        wait = min(wait, deadline - TOOL_DEADLINE_MARGIN_SECONDS)
    return max(wait, PAIRING_WAIT_SECONDS)


#: The activation's recorded answer to "does the relay offer a phone code?",
#: which the window's claim reuses instead of asking again.
PHONE_CODE_DECISIONS = ("available", "off", "custom_route", "unavailable")


def _phone_code_decision(address: str, control_url: str) -> str:
    """The relay's phone-code answer for this pairing, as one of
    :data:`PHONE_CODE_DECISIONS`. Off when unsure."""
    try:
        credential = pairing._read_relay_credential()
        if not credential:
            return "off"
        status = phone_code_status(address, control_url, credential, None)
    except Exception:  # noqa: BLE001 - unsure means today's window
        return "off"
    if status.get("available") is True:
        return "available"
    reason = status.get("reason")
    return reason if reason in ("custom_route", "unavailable") else "off"


def create_desktop_exchange(activation: Dict[str, Any], credential: str, opener: Any,
                            phone_code: Optional[str] = None) -> Tuple[int, Dict[str, Any]]:
    """Open the exchange: with ``phone_code`` the relay seals it to that phone.

    Without a code it opens manual pairing. The window draws no QR (#5486), so
    the request asks for no QR colours.
    """
    body: Dict[str, Any] = {"v": 1, "op": "create", "address": activation["address"]}
    if phone_code is None:
        return pairing._post(str(activation["controlUrl"]), body, credential=credential, opener=opener)
    if _desktop_custom_route():
        body["customRoute"] = True
    body["phoneCode"] = phone_code
    return pairing._post(str(activation["controlUrl"]), body, credential=credential, opener=opener,
                         timeout=PHONE_CODE_CREATE_TIMEOUT_SECONDS)


def desktop_routes_missing(
    timeout: float = DESKTOP_ROUTE_PROBE_TIMEOUT_SECONDS,
) -> bool:
    """True only when the running Desktop backend has not mounted OcuClaw's routes (#4047).

    Hermes mounts plugin API routes once, when ``hermes serve`` starts, and a
    Desktop install activates the plugin in that backend without restarting
    it. Until that backend restarts, OcuClaw's own route falls through to the
    backend's catch-all, a 404 carrying one of
    ``DESKTOP_UNMOUNTED_ROUTE_MARKERS``. The pairing panel claims its ceremony through those routes, so waiting for
    it would only time out. The backend is found through its host record, the
    way Hermes's own ``notify_serve_backend`` finds it. Anything else (no
    record, a Hermes without host records, another status, a timeout) is
    False: this check never blocks a host it cannot read.
    """

    try:
        import urllib.error
        import urllib.request

        from gateway import host_rendezvous as hr
    except Exception:  # noqa: BLE001 - Hermes before 0.21.5 has no host records
        return False
    try:
        record = None
        for role in (hr.ROLE_SERVE, getattr(hr, "ROLE_DESKTOP_SERVE", None)):
            if role is None:
                continue
            candidate = hr.read_record(role)
            if (
                candidate is not None
                and candidate.port
                and hr.record_token_is_consistent(candidate)
            ):
                record = candidate
                break
        if record is None:
            return False
        request = urllib.request.Request(
            f"http://{hr.dial_host(record)}:{record.port}/api/plugins/ocuclaw/setup-card",
            headers={"X-Hermes-Session-Token": hr.read_token(record.role)},
        )
        # Loopback only: never route this through an HTTP(S)_PROXY.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=timeout):  # noqa: S310 - loopback http
            return False
    except urllib.error.HTTPError as error:
        if error.code != 404:
            return False
        try:
            body = error.read(4096).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - an unreadable body is not the catch-all
            return False
        missing = any(marker in body for marker in DESKTOP_UNMOUNTED_ROUTE_MARKERS)
        if missing:
            logger.info("[ocuclaw] Desktop backend has not mounted OcuClaw's routes")
        else:
            logger.debug("[ocuclaw] Desktop route probe: 404 that is not the catch-all: %.200s", body)
        return missing
    except Exception:  # noqa: BLE001 - unreachable or unknown: fail open
        logger.debug("[ocuclaw] Desktop route probe failed", exc_info=True)
        return False


def run_desktop_pairing(
    address: str,
    *,
    control_url: str,
    home: Optional[Path] = None,
    wait_seconds: Optional[float] = None,
    receipt_wait_seconds: float = RECEIPT_WAIT_SECONDS,
    completion_reader: Callable[[], Any] = read_pairing_completion,
    routes_missing: Callable[[], bool] = desktop_routes_missing,
    phone_codes: Callable[[str, str], str] = _phone_code_decision,
) -> Dict[str, Any]:
    """Activate the Desktop presenter and return its secret-free result.

    Without ``wait_seconds`` the activation waits today's 345 s, or, when the
    relay offers a phone code, a longer typing budget (:data:`PHONE_CODE_WAIT_SECONDS`
    within Hermes's tool deadline).
    """

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
    if routes_missing():
        return {
            "ok": False,
            "state": "refused",
            "code": "desktop_relaunch_required",
            "message": DESKTOP_RELAUNCH_REQUIRED_MESSAGE,
        }
    # The decision is recorded in the activation so the window's claim follows
    # the same answer. A caller that names its wait records none, and its
    # claim asks the relay itself, as before.
    decision: Optional[str] = None
    if wait_seconds is None:
        decision = phone_codes(address, control_url)
        if decision not in PHONE_CODE_DECISIONS:
            decision = "off"
        wait_seconds = _phone_code_wait_seconds() if decision == "available" else PAIRING_WAIT_SECONDS

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
    if decision is not None:
        activation["phoneCode"] = decision
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
        return _unfinished_result(result)
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
