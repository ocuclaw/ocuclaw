"""Persistent, inert Hermes TUI widget plus one-shot pairing activation.

The OcuClaw widget is reconciled before the TUI starts.  While inert it only
polls a fixed loopback activation port.  ``pair_phone`` temporarily owns that
port and supplies public run metadata; the already-loaded widget then opens
itself, drives the relay's phone-code, manual and four-word ceremony, and
returns a secret-free outcome to the blocked setup tool.

This avoids relying on filesystem hot reload, which is not portable across all
filesystems Hermes runs on. The activation server owns the Relay Credential
and proxies credentialed relay-control requests behind a per-run capability.
The TUI never reads or transmits the credential. The exchange control secret
remains only in module memory and neither secret is written, rendered, or
returned to the agent.
"""

from __future__ import annotations

import hmac
import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any, Callable, Dict, Mapping, Optional

from .pairing_completion import read_pairing_completion
from .receipts import resolve_receipt_home


WIDGET_FILENAME = "ocuclaw-pair.mjs"
PRESENTER_CAPABILITY_FILENAME = "ocuclaw.tui-pairing-capability.json"
WIDGET_MARKER = "// OCUCLAW-OWNED-TUI-PAIRING-WIDGET v1"
WIDGET_SOURCE = Path(__file__).resolve().parent / "tui-widgets" / WIDGET_FILENAME
ACTIVATION_HOST = "127.0.0.1"
ACTIVATION_PORT = 47802
ACTIVATION_PATH = "/_ocuclaw/tui-pairing/v1"
ACTIVATION_URL = f"http://{ACTIVATION_HOST}:{ACTIVATION_PORT}{ACTIVATION_PATH}"
ACTIVATION_OWNER_HEADER = "x-ocuclaw-tui-owner-pid"
ACTIVATION_SURFACE_HEADER = "x-ocuclaw-pairing-surface"
ACTIVATION_CAPABILITY_HEADER = "x-ocuclaw-pairing-capability"
ACTIVATION_CONTROL_HEADER = "x-ocuclaw-tui-control-capability"
ACTIVATION_CHALLENGE_HEADER = "x-ocuclaw-tui-activation-challenge"
ACTIVATION_SERVER_CHALLENGE_HEADER = "x-ocuclaw-tui-server-challenge"
ACTIVATION_CLAIM_PROOF_HEADER = "x-ocuclaw-tui-claim-proof"
ACTIVATION_WIDGET_PROTOCOL_HEADER = "x-ocuclaw-tui-widget-protocol"
# The activation contract the loaded widget speaks; it sends this with each
# claim. Hermes loads tui-widgets/*.mjs when the TUI starts, before the
# gateway it spawns loads this plugin and reconciles the file, so after an
# update the running TUI can still hold the old module (and on a Hermes that
# hot-reloads widgets, the old module's activation timer keeps polling next to
# the new one). Protocol 2 (#5483, #5427): the activation signs the phone-code
# answer and the relay's block has no QR. A protocol-1 widget fails both checks
# in silence, so its claim is refused and reported as a relaunch. Bump this
# with the widget's own WIDGET_PROTOCOL whenever the two must change together.
WIDGET_PROTOCOL = "2"
# How long a claim from an older widget may stand before the run says
# "relaunch": time for a current widget in the same TUI (two 750 ms polls,
# each a challenge and a claim) to claim first.
STALE_WIDGET_GRACE_SECONDS = 3.0
# How long the owning TUI has to claim before any TUI holding the token may:
# the same two polls (Hermes 0.22 shared gateway, see _ActivationState.claim).
ANY_TUI_GRACE_SECONDS = 3.0
# With no claim at all by then, no TUI window is showing the panel: say so
# now, with the terminal fallback, instead of waiting out the pairing.
UNCLAIMED_SECONDS = 20.0
CALLBACK_HEADER = "x-ocuclaw-pairing-callback"
MAX_CALLBACK_BODY_BYTES = 512
MAX_CONTROL_BODY_BYTES = 4096
PAIRING_WAIT_SECONDS = 345.0
RECEIPT_WAIT_SECONDS = 5.0
_ALLOWED_STATES = frozenset({"completed", "failed", "cancelled", "refused"})
_SAFE_CODE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
_SAFE_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
# #3521. The panel reports this when even its manual view does not fit the
# Hermes window. Only this code may carry the window size, and only as four
# small integers: the actual size and the size the panel needs.
WINDOW_TOO_SMALL_CODE = "tui_window_too_small"
_WINDOW_KEYS = ("cols", "rows", "minCols", "minRows")
_CALLBACK_KEYS = frozenset({"v", "runId", "state", "code"})
# A Python launcher between the TUI and this worker: the Windows venv
# python.exe (a uv trampoline or the stdlib venv launcher) that starts the real
# interpreter as its child. Only these are skipped when finding the TUI.
_PYTHON_LAUNCHER_NAME = re.compile(r"^pythonw?(\d+(\.\d+)*)?(\.exe)?$", re.IGNORECASE)
_MAX_LAUNCHER_HOPS = 2


def resolve_owner_tui_pid(parents: Optional[Callable[[], Any]] = None) -> int:
    """Return the pid of the Hermes TUI that owns this setup turn.

    The widget reports its own Node pid. On Linux and macOS the TUI spawns the
    gateway Python directly, so the direct parent is the TUI. On Windows the
    venv ``python.exe`` is a launcher that starts the real interpreter as a
    child, so the direct parent is that launcher and the claim never matched
    (#3375). Skip only Python launchers, then stop at the first other process:
    a farther Node process (an editor terminal, say) is never picked. With no
    psutil, or an ancestry that cannot be read, the direct parent is kept.
    """
    direct_parent = os.getppid()
    try:
        if parents is None:
            import psutil  # A Hermes core dependency, still optional here.

            parents = psutil.Process().parents
        chain = list(parents())
    except Exception:  # noqa: BLE001 - unreadable ancestry keeps the old owner
        return direct_parent
    for hop, process in enumerate(chain[: _MAX_LAUNCHER_HOPS + 1]):
        try:
            name = str(process.name())
            pid = int(process.pid)
        except Exception:  # noqa: BLE001 - a vanished or denied ancestor
            return direct_parent
        if hop == 0 and pid != direct_parent:
            return direct_parent
        if _PYTHON_LAUNCHER_NAME.fullmatch(name) is None:
            return pid
    return direct_parent


def widget_path(home: Path) -> Path:
    return Path(home) / "tui-widgets" / WIDGET_FILENAME


def presenter_capability_path(home: Path) -> Path:
    return Path(home) / "state" / PRESENTER_CAPABILITY_FILENAME


def _safe_widget_path(home: Path) -> Optional[Path]:
    resolved_home = Path(home).expanduser().absolute()
    directory = resolved_home / "tui-widgets"
    target = directory / WIDGET_FILENAME
    try:
        if resolved_home.is_symlink() or directory.is_symlink() or target.is_symlink():
            return None
        if target.resolve(strict=False) != target.absolute():
            return None
        if directory.resolve(strict=False) != directory.absolute():
            return None
    except OSError:
        return None
    return target


def _write_private_widget(path: Path, content: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
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


def widget_owned(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8") as stream:
            return stream.readline().rstrip("\n") == WIDGET_MARKER
    except (OSError, UnicodeError):
        return False


def remove_owned_widget(path: Path) -> bool:
    if not widget_owned(path):
        return not path.exists()
    try:
        path.unlink()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


def reconcile_pairing_widget(home: Optional[Path] = None) -> Dict[str, Any]:
    """Install/update only the exact OcuClaw-owned inert widget."""

    resolved_home = Path(home) if home is not None else resolve_receipt_home()
    if resolved_home is None:
        return {"status": "error", "reason": "profile_unresolved"}
    target = _safe_widget_path(resolved_home)
    if target is None:
        return {"status": "error", "reason": "unsafe_widget_path"}
    try:
        source = WIDGET_SOURCE.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return {"status": "error", "reason": "widget_source_unreadable"}
    if not source.startswith(WIDGET_MARKER + "\n"):
        return {"status": "error", "reason": "widget_source_unowned"}
    if target.exists() and not widget_owned(target):
        return {
            "status": "preserved",
            "reason": "foreign_widget_present",
            "path": str(target),
        }
    try:
        current = target.read_text(encoding="utf-8") if target.exists() else None
        if current == source:
            return {"status": "unchanged", "path": str(target)}
        _write_private_widget(target, source)
    except (OSError, UnicodeError):
        return {"status": "error", "reason": "widget_write_failed"}
    return {
        "status": "updated" if current is not None else "created",
        "path": str(target),
    }


class _ActivationState:
    def __init__(
        self,
        *,
        token: str,
        run_id: str,
        activation: Mapping[str, Any],
        owner_tui_pid: Optional[int],
        surface: str = "tui",
        claim_capability: Optional[str] = None,
        control_token: str = "",
        control_url: str = "",
        relay_credential: str = "",
        control_post: Optional[Callable[..., Any]] = None,
        activation_signing_key: str = "",
        route_flags: Optional[Mapping[str, Any]] = None,
    ) -> None:
        self.token = token
        self.route_flags = dict(route_flags or {})
        self.run_id = run_id
        self.activation = dict(activation)
        self.owner_tui_pid = owner_tui_pid
        self.surface = surface
        self.claim_capability = claim_capability
        self.control_token = control_token
        self.control_url = control_url
        self.relay_credential = relay_credential
        self.control_post = control_post
        self.activation_signing_key = activation_signing_key
        self.server_challenge = secrets.token_urlsafe(32)
        self.claimed = False
        # When an authentic claim first came from a widget on another
        # protocol (a module loaded before this plugin was updated).
        self.stale_widget_at: Optional[float] = None
        self.opened_at = time.monotonic()
        self.event = threading.Event()
        self.result: Optional[Dict[str, str]] = None
        self.lock = threading.Lock()

    def claim(
        self,
        request_owner_pid: str,
        request_surface: str = "tui",
        request_capability: str = "",
        request_challenge: str = "",
        request_server_challenge: str = "",
        request_claim_proof: str = "",
        request_widget_protocol: str = "",
    ) -> Optional[Dict[str, Any]]:
        with self.lock:
            if self.claimed or request_surface != self.surface:
                return None
            # The owning TUI is the gateway's parent when it started the
            # gateway. On Hermes 0.22 the TUI may be a client of a shared
            # gateway instead, so no widget ever matches: after a short grace
            # any widget holding the token may claim. The pid is
            # self-reported, so it only routes; the proofs below guard.
            if (
                self.surface == "tui"
                and request_owner_pid != str(self.owner_tui_pid)
                and time.monotonic() - self.opened_at < ANY_TUI_GRACE_SECONDS
            ):
                return None
            if self.surface == "tui" and (
                not self.activation_signing_key
                or _SAFE_CHALLENGE.fullmatch(request_challenge) is None
                or not hmac.compare_digest(
                    request_server_challenge, self.server_challenge
                )
            ):
                return None
            if self.surface == "tui":
                claim_fields = [
                    "claim",
                    self.server_challenge,
                    request_challenge,
                    request_owner_pid,
                    request_surface,
                ]
                expected_claim = hmac.new(
                    self.activation_signing_key.encode("utf-8"),
                    json.dumps(claim_fields, separators=(",", ":")).encode("utf-8"),
                    hashlib.sha256,
                ).hexdigest()
                if not hmac.compare_digest(request_claim_proof, expected_claim):
                    return None
            if self.claim_capability is not None and not hmac.compare_digest(
                request_capability, self.claim_capability
            ):
                return None
            if self.surface == "tui" and request_widget_protocol != WIDGET_PROTOCOL:
                # The owning TUI, proven, but running an older widget that
                # cannot verify or render this activation. Leave it unclaimed
                # so a current widget in the same TUI can still take it;
                # run_tui_pairing reports a relaunch if none does.
                if self.stale_widget_at is None:
                    self.stale_widget_at = time.monotonic()
                return None
            self.claimed = True
            result = dict(self.activation)
            if self.surface == "tui":
                proof_fields = [
                    request_challenge,
                    result.get("v"),
                    result.get("surface"),
                    result.get("address"),
                    result.get("controlUrl"),
                    result.get("controlToken"),
                    result.get("callbackUrl"),
                    result.get("callbackToken"),
                    result.get("runId"),
                    result.get("expiresAtMs"),
                ]
                # #5483. Signed only when present, so an activation without
                # a phone-code decision keeps today's proof.
                if "phoneCode" in result:
                    proof_fields.append(result["phoneCode"])
                proof = json.dumps(proof_fields, separators=(",", ":"))
                result["activationMac"] = hmac.new(
                    self.activation_signing_key.encode("utf-8"),
                    proof.encode("utf-8"),
                    hashlib.sha256,
                ).hexdigest()
            return result

    def proxy_control(
        self,
        token: str,
        control_secret: str,
        payload: Any,
    ) -> tuple[int, Dict[str, Any]]:
        if (
            not self.control_token
            or not hmac.compare_digest(str(token), self.control_token)
            or not isinstance(payload, Mapping)
            or self.control_post is None
        ):
            return 403, {"error": "pairing_control_refused"}
        extra: Dict[str, Any] = {}
        if payload.get("op") == "create" and "phoneCode" in payload:
            # #5483. As Hermes pair and Desktop: the host's own custom-route
            # answer goes with the code, and the relay gets the longer wait a
            # lookup plus a sealed delivery can take. A plain create is
            # forwarded as it came.
            from . import pairing

            payload = {**payload, **self.route_flags}
            extra["timeout"] = pairing.PHONE_CODE_CREATE_TIMEOUT_SECONDS
        try:
            return self.control_post(
                self.control_url,
                payload,
                credential=self.relay_credential,
                control_secret=control_secret or None,
                **extra,
            )
        except Exception:  # noqa: BLE001 - never expose credential/proxy internals
            return 502, {"error": "pairing_control_unavailable"}

    def accept(self, token: str, payload: Any) -> bool:
        if not hmac.compare_digest(str(token), self.token):
            return False
        if not isinstance(payload, Mapping):
            return False
        keys = set(payload)
        with_window = keys == _CALLBACK_KEYS | set(_WINDOW_KEYS)
        if keys != _CALLBACK_KEYS and not with_window:
            return False
        if payload.get("v") != 1 or payload.get("runId") != self.run_id:
            return False
        state = str(payload.get("state") or "")
        code = str(payload.get("code") or "")
        if state not in _ALLOWED_STATES or _SAFE_CODE.fullmatch(code) is None:
            return False
        result: Dict[str, Any] = {"state": state, "code": code}
        if with_window:
            window = {key: payload.get(key) for key in _WINDOW_KEYS}
            if code != WINDOW_TOO_SMALL_CODE or not all(
                type(value) is int and 0 < value < 10000 for value in window.values()
            ):
                return False
            result["window"] = window
        with self.lock:
            if self.result is None:
                self.result = result
                self.event.set()
        return True


def _send_json(handler: BaseHTTPRequestHandler, status: int, payload: Mapping[str, Any]) -> None:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.send_header("cache-control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _handler_for(
    state: _ActivationState,
    callback_path: str,
    control_path: Optional[str] = None,
):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
            if self.path != ACTIVATION_PATH:
                self.send_error(404)
                return
            if (
                state.surface == "tui"
                and not self.headers.get(ACTIVATION_CLAIM_PROOF_HEADER, "")
            ):
                _send_json(
                    self,
                    401,
                    {"serverChallenge": state.server_challenge},
                )
                return
            activation = state.claim(
                self.headers.get(ACTIVATION_OWNER_HEADER, ""),
                self.headers.get(ACTIVATION_SURFACE_HEADER, "tui"),
                self.headers.get(ACTIVATION_CAPABILITY_HEADER, ""),
                self.headers.get(ACTIVATION_CHALLENGE_HEADER, ""),
                self.headers.get(ACTIVATION_SERVER_CHALLENGE_HEADER, ""),
                self.headers.get(ACTIVATION_CLAIM_PROOF_HEADER, ""),
                self.headers.get(ACTIVATION_WIDGET_PROTOCOL_HEADER, ""),
            )
            if activation is None:
                self.send_response(204)
                self.end_headers()
                return
            _send_json(self, 200, activation)

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
            if self.path != callback_path and (
                control_path is None or self.path != control_path
            ):
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("content-length") or "0")
            except ValueError:
                length = 0
            limit = (
                MAX_CONTROL_BODY_BYTES
                if control_path is not None and self.path == control_path
                else MAX_CALLBACK_BODY_BYTES
            )
            if length <= 0 or length > limit:
                self.send_error(400)
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeError, ValueError):
                self.send_error(400)
                return
            if control_path is not None and self.path == control_path:
                status, response = state.proxy_control(
                    self.headers.get(ACTIVATION_CONTROL_HEADER, ""),
                    self.headers.get("x-ocuclaw-pair-control-secret", ""),
                    payload,
                )
                _send_json(self, status, response)
                return
            accepted = state.accept(self.headers.get(CALLBACK_HEADER, ""), payload)
            self.send_response(204 if accepted else 403)
            self.end_headers()

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


def _completion_id(record: Any) -> Optional[str]:
    return str(record.get("completionId")) if isinstance(record, Mapping) else None


#: #3829. The pairing codes that mean "the five-minute window ran out". Nothing
#: is wrong with the phone or the route, so the recovery is a fresh code in
#: the SAME panel (call ``pair_phone`` again), never the terminal fallback.
#: `completion-window-elapsed` is included for a relay older than #3829, which
#: reported a late-approval expiry under that name.
EXPIRED_CODES = frozenset({"expired", "completion-window-elapsed"})

#: The phone's own words for an expiry (``hostReasonMessage`` in
#: PhonePairingController.kt), so the computer and the phone agree.
EXPIRED_MESSAGE = (
    "Pairing took longer than the five-minute window. Nothing is wrong with "
    "the phone. Start pairing again to get a fresh code in this same window."
)


def _unfinished_result(result: Mapping[str, Any]) -> Dict[str, Any]:
    """The terminal, non-completed result the presenter reported."""

    code = str(result.get("code") or "")
    if code in EXPIRED_CODES:
        return {
            "ok": False,
            "state": str(result.get("state") or "failed"),
            "code": "expired",
            "message": EXPIRED_MESSAGE,
        }
    return {
        "ok": False,
        "state": result["state"],
        "code": code,
        "message": "Pairing did not complete. The setup checkpoint remains open.",
    }


def _window_too_small_result(result: Mapping[str, Any]) -> Dict[str, Any]:
    """#3521. Name the window as the cause, never the phone or the G2."""

    window = result.get("window")
    if isinstance(window, Mapping):
        size = (
            f"It is {window['cols']} columns × {window['rows']} rows; pairing "
            f"needs at least {window['minCols']} columns × {window['minRows']} rows. "
        )
    else:
        size = ""
    response: Dict[str, Any] = {
        "ok": False,
        "state": str(result.get("state") or "cancelled"),
        "code": WINDOW_TOO_SMALL_CODE,
        "message": (
            "The Hermes window is too small to show the pairing panel. "
            f"{size}Nothing was paired. Make the Hermes window bigger, then "
            "retry pairing."
        ),
    }
    if isinstance(window, Mapping):
        response["window"] = dict(window)
    return response


#: #5483. The activation's recorded answer to "does the relay offer a phone
#: code?" (Desktop's ``PHONE_CODE_DECISIONS``). The panel asks for the code
#: only on ``available``.
PHONE_CODE_DECISIONS = ("available", "off", "custom_route", "unavailable")


def _custom_route_flags() -> Dict[str, Any]:
    """``{"customRoute": True}`` when this host pairs over a custom route.

    The same check Hermes Desktop makes; unreadable config means none, and
    the gateway still fences the address itself.
    """
    try:
        from .desktop_pairing import _desktop_custom_route

        return {"customRoute": True} if _desktop_custom_route() else {}
    except Exception:  # noqa: BLE001 - the gateway reads its own config too
        return {}


def _phone_code_decision(
    address: str,
    control_url: str,
    *,
    credential: str,
    post: Callable[..., Any],
    route_flags: Mapping[str, Any],
) -> str:
    """The relay's phone-code answer, as one of :data:`PHONE_CODE_DECISIONS`.

    Asked before any exchange exists, like Hermes pair. A refused, failed or
    old control endpoint means off, which keeps today's panel.
    """
    from . import pairing

    try:
        status, body = post(
            control_url,
            {"v": 1, "op": "phone-code-status", "address": address, **route_flags},
            credential=credential,
            timeout=pairing.PHONE_CODE_STATUS_TIMEOUT_SECONDS,
        )
    except Exception:  # noqa: BLE001 - any failed status call means off
        return "off"
    if status != 200 or not isinstance(body, Mapping):
        return "off"
    if body.get("available") is True:
        return "available"
    reason = body.get("reason")
    return reason if reason in ("custom_route", "unavailable") else "off"


def _phone_code_wait_seconds() -> float:
    """Desktop's typing budget while a phone code is in play."""
    try:
        from .desktop_pairing import _phone_code_wait_seconds as desktop_wait

        return desktop_wait()
    except Exception:  # noqa: BLE001 - today's wait still pairs
        return PAIRING_WAIT_SECONDS


def _await_callback(state: _ActivationState, wait_seconds: float) -> str:
    """Wait for the panel's result: ``result``, ``timeout`` or ``stale_widget``.

    ``stale_widget`` once an older widget in the owning TUI has stood as the
    only claimant for the grace period: no current widget took the activation,
    so the panel would never open.
    """

    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        remaining = deadline - time.monotonic()
        if state.event.wait(max(0.0, min(remaining, 0.1))):
            return "result"
        with state.lock:
            claimed = state.claimed
            stale_at = None if claimed else state.stale_widget_at
        now = time.monotonic()
        if stale_at is not None and now - stale_at >= STALE_WIDGET_GRACE_SECONDS:
            return "stale_widget"
        if not claimed and stale_at is None and now - state.opened_at >= UNCLAIMED_SECONDS:
            return "unclaimed"
        if now >= deadline:
            return "timeout"


def run_tui_pairing(
    address: str,
    *,
    control_url: str,
    home: Optional[Path] = None,
    wait_seconds: Optional[float] = None,
    receipt_wait_seconds: float = RECEIPT_WAIT_SECONDS,
    completion_reader: Callable[[], Any] = read_pairing_completion,
    owner_tui_pid: Optional[int] = None,
    credential_reader: Optional[Callable[[], str]] = None,
    control_post: Optional[Callable[..., Any]] = None,
    phone_codes: Optional[Callable[[str, str], str]] = None,
) -> Dict[str, Any]:
    """Activate the preloaded widget and return its verified secret-free result.

    Without ``wait_seconds`` the setup tool first asks the relay whether it
    offers a phone code (#5483) and records the answer in the activation: on
    ``available`` the panel asks for the code before creating anything and
    waits Desktop's longer typing budget, otherwise it waits today's 345 s. A
    caller that names its wait records no answer, and the panel is today's.
    """

    resolved_owner_tui_pid = (
        resolve_owner_tui_pid() if owner_tui_pid is None else owner_tui_pid
    )
    if not isinstance(resolved_owner_tui_pid, int) or resolved_owner_tui_pid <= 0:
        return {
            "ok": False,
            "state": "refused",
            "code": "tui_owner_unavailable",
            "message": "The owning Hermes TUI process could not be identified safely.",
        }
    resolved_home = Path(home) if home is not None else resolve_receipt_home()
    if resolved_home is None:
        return {
            "ok": False,
            "state": "refused",
            "code": "profile_unresolved",
            "message": "The active Hermes profile could not be resolved.",
        }
    report = reconcile_pairing_widget(resolved_home)
    if report.get("status") == "preserved":
        return {
            "ok": False,
            "state": "refused",
            "code": "foreign_widget_present",
            "message": "A non-OcuClaw /ocuclaw-pair widget exists and was preserved.",
        }
    if report.get("status") in {"created", "updated"}:
        return {
            "ok": False,
            "state": "refused",
            "code": "tui_relaunch_required",
            "message": (
                "The OcuClaw pairing widget was repaired. Relaunch Hermes TUI "
                "once, then continue this setup checkpoint."
            ),
        }
    if report.get("status") != "unchanged":
        return {
            "ok": False,
            "state": "failed",
            "code": str(report.get("reason") or "tui_widget_unavailable"),
            "message": "The supported Hermes TUI pairing widget is unavailable.",
        }

    from . import pairing

    relay_credential = str(
        (credential_reader or pairing._read_relay_credential)() or ""
    ).strip()
    if not relay_credential:
        return {
            "ok": False,
            "state": "refused",
            "code": "relay_credential_missing",
            # #3242: the code keeps the internal name; the sentence a person
            # reads says what they can act on.
            "message": (
                "OcuClaw is installed but your agent has not loaded it yet, so "
                "there is nothing for a phone to pair with."
            ),
        }
    post = control_post or pairing._post
    decision: Optional[str] = None
    route_flags: Dict[str, Any] = {}
    if wait_seconds is None:
        route_flags = _custom_route_flags()
        decision = (phone_codes or (
            lambda addr, url: _phone_code_decision(
                addr, url, credential=relay_credential, post=post, route_flags=route_flags,
            )
        ))(address, control_url)
        if decision not in PHONE_CODE_DECISIONS:
            decision = "off"
        wait_seconds = (
            _phone_code_wait_seconds() if decision == "available" else PAIRING_WAIT_SECONDS
        )
    callback_token = secrets.token_urlsafe(32)
    presenter_token = secrets.token_urlsafe(32)
    control_token = secrets.token_urlsafe(32)
    run_id = secrets.token_urlsafe(24)
    callback_path = f"{ACTIVATION_PATH}/result/{run_id}"
    callback_url = f"http://{ACTIVATION_HOST}:{ACTIVATION_PORT}{callback_path}"
    control_path = f"{ACTIVATION_PATH}/control/{run_id}"
    presenter_control_url = f"http://{ACTIVATION_HOST}:{ACTIVATION_PORT}{control_path}"
    activation = {
        "v": 1,
        "surface": "tui",
        "address": address,
        "controlUrl": presenter_control_url,
        "controlToken": control_token,
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
        owner_tui_pid=resolved_owner_tui_pid,
        control_token=control_token,
        control_url=control_url,
        relay_credential=relay_credential,
        control_post=post,
        activation_signing_key=presenter_token,
        route_flags=route_flags,
    )
    try:
        server = ThreadingHTTPServer(
            (ACTIVATION_HOST, ACTIVATION_PORT),
            _handler_for(callback_state, callback_path, control_path),
        )
    except OSError:
        return {
            "ok": False,
            "state": "failed",
            "code": "tui_activation_port_unavailable",
            "message": (
                f"Loopback port {ACTIVATION_PORT} is unavailable, so the "
                "in-window pairing panel could not open."
            ),
        }
    capability_path = presenter_capability_path(resolved_home)
    try:
        from .receipts import write_json_receipt

        write_json_receipt(
            capability_path,
            {"v": 1, "runId": run_id, "token": presenter_token},
            durable=True,
        )
    except Exception:  # noqa: BLE001 - an unauthenticated widget must stay inert
        server.server_close()
        return {
            "ok": False,
            "state": "failed",
            "code": "tui_presenter_capability_unavailable",
            "message": "The private TUI pairing capability could not be created.",
        }
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    before_id = _completion_id(completion_reader())
    try:
        thread.start()
        waited = _await_callback(callback_state, wait_seconds)
        if waited == "stale_widget":
            return {
                "ok": False,
                "state": "refused",
                "code": "tui_relaunch_required",
                "message": (
                    "This Hermes TUI still runs the OcuClaw pairing panel it "
                    "loaded before OcuClaw was updated. Relaunch Hermes TUI "
                    "once, then continue this setup checkpoint."
                ),
            }
        if waited == "unclaimed":
            # Answered by the skill's "any other code" row: the terminal fallback.
            return {
                "ok": False,
                "state": "failed",
                "code": "tui_window_unclaimed",
                "message": (
                    "No Hermes TUI window opened the pairing panel, so nothing "
                    "was paired. Pair from a terminal you open yourself on this "
                    f"machine instead: hermes ocuclaw pair --address {address}"
                ),
            }
        if waited == "timeout":
            return {
                "ok": False,
                "state": "failed",
                "code": "tui_pairing_timeout",
                "message": (
                    "Pairing timed out. Ensure OcuClaw is running on your "
                    "Even G2, then retry pairing."
                ),
            }

        result = callback_state.result or {"state": "failed", "code": "callback_missing"}
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
                    "The TUI observed completion, but the managed gateway did not "
                    "record a new pairing receipt. Pairing is not confirmed."
                ),
            }
        if result["code"] == WINDOW_TOO_SMALL_CODE:
            return _window_too_small_result(result)
        return _unfinished_result(result)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1.0)
        try:
            record = json.loads(capability_path.read_text(encoding="utf-8"))
            if (
                isinstance(record, Mapping)
                and record.get("runId") == run_id
                and hmac.compare_digest(str(record.get("token") or ""), presenter_token)
            ):
                capability_path.unlink()
        except (FileNotFoundError, OSError, UnicodeError, ValueError):
            pass


__all__ = [
    "ACTIVATION_CAPABILITY_HEADER",
    "ACTIVATION_CHALLENGE_HEADER",
    "ACTIVATION_CLAIM_PROOF_HEADER",
    "ACTIVATION_CONTROL_HEADER",
    "ACTIVATION_OWNER_HEADER",
    "ACTIVATION_SERVER_CHALLENGE_HEADER",
    "ACTIVATION_SURFACE_HEADER",
    "ACTIVATION_WIDGET_PROTOCOL_HEADER",
    "ACTIVATION_URL",
    "CALLBACK_HEADER",
    "PRESENTER_CAPABILITY_FILENAME",
    "WIDGET_FILENAME",
    "WIDGET_MARKER",
    "WIDGET_PROTOCOL",
    "reconcile_pairing_widget",
    "presenter_capability_path",
    "remove_owned_widget",
    "run_tui_pairing",
    "widget_owned",
    "widget_path",
]
