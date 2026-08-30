"""Persistent, inert Hermes TUI widget plus one-shot pairing activation.

The OcuClaw widget is reconciled before the TUI starts.  While inert it only
polls a fixed loopback activation port.  ``pair_phone`` temporarily owns that
port and supplies public run metadata; the already-loaded widget then opens
itself, drives the relay's QR/four-word ceremony, and returns a secret-free
outcome to the blocked setup tool.

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
CALLBACK_HEADER = "x-ocuclaw-pairing-callback"
MAX_CALLBACK_BODY_BYTES = 512
MAX_CONTROL_BODY_BYTES = 4096
PAIRING_WAIT_SECONDS = 165.0
RECEIPT_WAIT_SECONDS = 5.0
_ALLOWED_STATES = frozenset({"completed", "failed", "cancelled", "refused"})
_SAFE_CODE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
_SAFE_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")


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
    ) -> None:
        self.token = token
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
    ) -> Optional[Dict[str, Any]]:
        with self.lock:
            if self.claimed or request_surface != self.surface:
                return None
            if self.surface == "tui" and request_owner_pid != str(self.owner_tui_pid):
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
        try:
            return self.control_post(
                self.control_url,
                payload,
                credential=self.relay_credential,
                control_secret=control_secret or None,
            )
        except Exception:  # noqa: BLE001 - never expose credential/proxy internals
            return 502, {"error": "pairing_control_unavailable"}

    def accept(self, token: str, payload: Any) -> bool:
        if not hmac.compare_digest(str(token), self.token):
            return False
        if not isinstance(payload, Mapping) or set(payload) != {"v", "runId", "state", "code"}:
            return False
        if payload.get("v") != 1 or payload.get("runId") != self.run_id:
            return False
        state = str(payload.get("state") or "")
        code = str(payload.get("code") or "")
        if state not in _ALLOWED_STATES or _SAFE_CODE.fullmatch(code) is None:
            return False
        with self.lock:
            if self.result is None:
                self.result = {"state": state, "code": code}
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


def run_tui_pairing(
    address: str,
    *,
    control_url: str,
    home: Optional[Path] = None,
    wait_seconds: float = PAIRING_WAIT_SECONDS,
    receipt_wait_seconds: float = RECEIPT_WAIT_SECONDS,
    completion_reader: Callable[[], Any] = read_pairing_completion,
    owner_tui_pid: Optional[int] = None,
    credential_reader: Optional[Callable[[], str]] = None,
    control_post: Optional[Callable[..., Any]] = None,
) -> Dict[str, Any]:
    """Activate the preloaded widget and return its verified secret-free result."""

    resolved_owner_tui_pid = os.getppid() if owner_tui_pid is None else owner_tui_pid
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
            "message": "The host-managed Relay Credential is unavailable.",
        }
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
    callback_state = _ActivationState(
        token=callback_token,
        run_id=run_id,
        activation=activation,
        owner_tui_pid=resolved_owner_tui_pid,
        control_token=control_token,
        control_url=control_url,
        relay_credential=relay_credential,
        control_post=control_post or pairing._post,
        activation_signing_key=presenter_token,
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
        if not callback_state.event.wait(max(0.0, wait_seconds)):
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
    "ACTIVATION_URL",
    "CALLBACK_HEADER",
    "PRESENTER_CAPABILITY_FILENAME",
    "WIDGET_FILENAME",
    "WIDGET_MARKER",
    "reconcile_pairing_widget",
    "presenter_capability_path",
    "remove_owned_widget",
    "run_tui_pairing",
    "widget_owned",
    "widget_path",
]
