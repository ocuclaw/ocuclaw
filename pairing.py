"""Local terminal security actions: pairing and all-device reset.

WHAT THIS IS
------------

Q4 puts the approval of a Pairing Exchange at an interactive terminal owned by
OcuClaw, with an exact yes/no prompt that shows only a sanitized phone label and
the four-word safety phrase. This module is that terminal.

WHY IT TALKS TO THE RELAY OVER HTTP
-----------------------------------

The exchange lives inside the relay runtime — that is where the Noise suite, the
Relay Credential and the phone's endpoint are. ``hermes`` is a different process.
A command that built its own exchange host would print a QR for an exchange no
phone could reach and approve something nobody scanned. So this drives the ONE
real exchange through the relay's authenticated control path.

WHAT IT NEVER DOES
------------------

* It never displays or logs the Relay Credential. Pairing reads it only to
  authenticate itself; reset atomically replaces it without returning either
  value.
* It has no non-interactive path. Q4 says there is none, so a missing TTY is a
  refusal, not a prompt-free approval.
* It never decides on the user's behalf. An unreadable answer is re-asked and
  then treated as a refusal; EOF and interruption are refusals.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hmac
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Mapping, Optional, TextIO, Tuple

from . import relay_credential

#: Exit codes, matching the sibling `status`/`doctor` contract in cli.py.
EXIT_OK = 0
EXIT_PROBLEM = 1
EXIT_USAGE = 2

#: The control path published by the relay (pairing-endpoint-address.ts).
CONTROL_PATH = "/_ocuclaw/pair/control/v1"

#: Header names, mirroring pairing-control-service.ts.
AUTH_HEADER = "x-ocuclaw-pair-control-auth"
SECRET_HEADER = "x-ocuclaw-pair-control-secret"

#: The env key of the managed Relay Credential (adapter.OCUCLAW_RELAY_TOKEN_ENV).
RELAY_TOKEN_ENV = "OCUCLAW_RELAY_TOKEN"

#: Defaults matching config/runtime-config.ts for the Hermes bundle.
DEFAULT_WS_BIND = "127.0.0.1"
DEFAULT_WS_PORT = 47801

#: How often the terminal asks the relay what changed, and for how long.
POLL_INTERVAL_S = 1.0
#: A hair over the two-minute exchange lifetime, so an expiry is OBSERVED here
#: rather than guessed at by a timeout of our own.
POLL_DEADLINE_S = 135.0

#: How many unreadable answers to tolerate before treating the prompt as refused.
MAX_PROMPT_RETRIES = 3

PROMPT_TEXT = "Do these four words match, in this order, on the phone? [yes/no]: "

RESET_WARNING = (
    "Reset immediately invalidates ALL existing app pairings, disconnects "
    "every paired phone, requires secure QR or Manual re-pairing, and cannot "
    "restore the prior credential."
)
RESET_PROMPT_TEXT = 'Type "reset" to reset the Relay Credential for all devices: '
GATEWAY_RESTART_MIN_TIMEOUT_S = 360.0
GATEWAY_RESTART_COMMAND_HEADROOM_S = 300.0
RELAY_VERIFY_TIMEOUT_S = 2.0
RELAY_VERIFY_READY_DEADLINE_S = 15.0
RELAY_VERIFY_RETRY_INTERVAL_S = 0.25
_RELAY_CREDENTIAL_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")
_VERIFY_OUTCOMES = frozenset(
    {"accepted", "rejected", "unreachable", "timeout", "protocol_error", "unknown"}
)
PERSISTENCE_COMMITTED = relay_credential.PERSISTENCE_COMMITTED
PERSISTENCE_ROLLED_BACK = relay_credential.PERSISTENCE_ROLLED_BACK
PERSISTENCE_AMBIGUOUS = relay_credential.PERSISTENCE_AMBIGUOUS

#: Terminal states, from PairingState in pairing-exchange.ts.
_TERMINAL_STATES = frozenset({"completed", "failed"})

#: Plain-language endings, keyed by the core's secret-free failure reasons.
_FAILURE_TEXT: Dict[str, str] = {
    "expired": (
        "The pairing request expired before it finished. Nothing was sent to the "
        "phone. Run `hermes ocuclaw pair` again to start a new one."
    ),
    "approval-denied": (
        "Pairing was refused here, so nothing was sent to the phone. If the words "
        "did not match, that was the right answer — start again and compare them "
        "once more."
    ),
    "cancelled": "Pairing was cancelled. Nothing was sent to the phone.",
    "too-many-attempts": (
        "Too many attempts were made against this pairing request, so it was "
        "closed. Run `hermes ocuclaw pair` again to start a new one."
    ),
    "pairing-code-mismatch": (
        "The pairing code was entered incorrectly too many times. Start again to "
        "get a new code."
    ),
    "superseded": "Another pairing request replaced this one.",
    "secure-pairing-unavailable": (
        "This computer cannot run the encrypted pairing exchange, so pairing is "
        "unavailable here."
    ),
    "invalid-address": (
        "That address cannot be used for pairing. It must look like "
        "wss://<host>:<port>, with no path, and name the private address the "
        "phone can reach."
    ),
}

_GENERIC_FAILURE = (
    "Pairing stopped without completing, and nothing was saved on the phone. Run "
    "`hermes ocuclaw pair` again to start a new one."
)


class ControlError(Exception):
    """A control request that could not be completed. Message is user-facing."""


@dataclass(frozen=True)
class RelayCredentialResetResult:
    """Secret-free outcome of the all-device reset state machine.

    Credentials are deliberately absent: callers may render or serialize this
    object without creating a new disclosure surface.
    """

    success: bool
    code: str
    persisted: bool = False
    gateway_restarted: bool = False
    replacement_auth: str = "not_checked"
    previous_auth: str = "not_checked"


@dataclass(frozen=True)
class _GatewayRestartPlan:
    timeout_s: float


def generate_relay_credential() -> str:
    """Return a 256-bit base64url Relay Credential without padding."""
    return relay_credential.new_generation_id()


def _persist_relay_credential(credential: str, previous_credential: str) -> str:
    """Atomically persist and restore the prior value if readback is uncertain."""
    return relay_credential.persist_relay_credential(
        credential, previous_credential
    )


def _persist_relay_credential_generation(
    credential: str, previous_credential: str
) -> str:
    """Commit the replacement and its fresh secret-free marker as one gate."""
    try:
        generation_id = relay_credential.new_generation_id()
    except BaseException:  # noqa: BLE001 - no credential mutation has happened
        return PERSISTENCE_ROLLED_BACK
    persistence = _persist_relay_credential(credential, previous_credential)
    if persistence != PERSISTENCE_COMMITTED:
        return persistence

    try:
        relay_credential.write_relay_credential_marker(
            generation_id=generation_id
        )
        marker = relay_credential.read_relay_credential_marker()
        if marker is not None and hmac.compare_digest(
            str(marker.get("generationId") or ""), generation_id
        ):
            return PERSISTENCE_COMMITTED
    except BaseException:  # noqa: BLE001 - reconcile a possible published write
        marker = relay_credential.read_relay_credential_marker()
        if marker is not None and hmac.compare_digest(
            str(marker.get("generationId") or ""), generation_id
        ):
            return PERSISTENCE_COMMITTED

    # Marker publication did not land. Restore the credential that the running
    # gateway still authenticates. A failed restoration is explicitly
    # ambiguous and must never trigger restart.
    restored = _persist_relay_credential(previous_credential, credential)
    return (
        PERSISTENCE_ROLLED_BACK
        if restored == PERSISTENCE_COMMITTED
        else PERSISTENCE_AMBIGUOUS
    )


def _prepare_gateway_restart() -> Optional[_GatewayRestartPlan]:
    """Resolve restart authority and retain one bounded lifecycle plan."""
    timeout_s = _gateway_restart_timeout_s()
    if timeout_s is None:
        return None
    if sys.platform == "win32":
        # Hermes 0.20's Windows restart path is detached even when no Scheduled
        # Task is installed. Its bound must still be resolved before persistence.
        return _GatewayRestartPlan(timeout_s)
    try:
        from hermes_cli.gateway import get_gateway_runtime_snapshot  # type: ignore

        snapshot = get_gateway_runtime_snapshot()
        service_installed = bool(getattr(snapshot, "service_installed", False))
        process_mismatch = bool(
            getattr(snapshot, "has_process_service_mismatch", True)
        )
    except Exception:  # noqa: BLE001 - ambiguity must stop before persistence
        return None
    if not service_installed or process_mismatch:
        return None
    service_scope = str(getattr(snapshot, "service_scope", "") or "")
    if service_scope == "system" and os.geteuid() != 0:
        return None
    return _GatewayRestartPlan(timeout_s)


def _gateway_restart_is_bounded() -> bool:
    """Return whether a restart plan can be retained before persistence."""
    return _prepare_gateway_restart() is not None


def _gateway_restart_timeout_s() -> Optional[float]:
    """Cover Hermes's configured graceful lifecycle plus command headroom."""
    try:
        from hermes_cli.gateway import (  # type: ignore
            _get_restart_drain_timeout,
            _get_restart_exit_wait_budget,
        )

        lifecycle_budget = max(
            float(_get_restart_exit_wait_budget()),
            float(_get_restart_drain_timeout()),
        )
    except Exception:  # noqa: BLE001 - unknown bounds stop before persistence
        return None
    if not math.isfinite(lifecycle_budget) or lifecycle_budget < 0:
        return None
    return max(
        GATEWAY_RESTART_MIN_TIMEOUT_S,
        lifecycle_budget + GATEWAY_RESTART_COMMAND_HEADROOM_S,
    )


def _restart_hermes_gateway(*, timeout_s: Optional[float] = None) -> bool:
    """Run the explicit bounded restart without exposing subprocess output."""
    timeout_s = _gateway_restart_timeout_s() if timeout_s is None else timeout_s
    if timeout_s is None:
        return False
    try:
        completed = subprocess.run(
            ["hermes", "gateway", "restart"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_s,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def _relay_verify_address() -> str:
    """Return the credential-free loopback WebSocket address of this relay."""
    parts = urllib.parse.urlsplit(_control_url())
    scheme = "wss" if parts.scheme == "https" else "ws"
    return urllib.parse.urlunsplit((scheme, parts.netloc, "/", "", ""))


def _verify_relay_credential(*, address: str, credential: str, timeout_s: float):
    from .relay_verifier import verify_relay_credential

    return verify_relay_credential(
        address=address,
        credential=credential,
        timeout_s=timeout_s,
    )


def _verify_outcome_name(outcome: Any) -> str:
    name = str(getattr(outcome, "outcome", "unknown"))
    return name if name in _VERIFY_OUTCOMES else "unknown"


def _wait_for_replacement_acceptance(
    *,
    address: str,
    credential: str,
    verify_fn: Callable[..., Any],
    monotonic_fn: Callable[[], float],
    sleep_fn: Callable[[float], None],
) -> str:
    """Poll across bounded gateway startup until replacement auth is proven."""
    deadline = monotonic_fn() + RELAY_VERIFY_READY_DEADLINE_S
    last_outcome = "unknown"
    while True:
        remaining = deadline - monotonic_fn()
        if remaining <= 0:
            return last_outcome
        attempt_timeout = min(RELAY_VERIFY_TIMEOUT_S, max(0.05, remaining))
        try:
            outcome = verify_fn(
                address=address,
                credential=credential,
                timeout_s=attempt_timeout,
            )
            last_outcome = _verify_outcome_name(outcome)
        except Exception:  # noqa: BLE001 - retry stable secret-free outcome only
            last_outcome = "unknown"
        if last_outcome == "accepted":
            return last_outcome
        remaining = deadline - monotonic_fn()
        if remaining <= 0:
            return last_outcome
        sleep_fn(min(RELAY_VERIFY_RETRY_INTERVAL_S, remaining))


def reset_relay_credential(
    *,
    credential_fn: Optional[Callable[[], str]] = None,
    generate_fn: Optional[Callable[[], str]] = None,
    persist_fn: Optional[Callable[[str], Any]] = None,
    restart_ready_fn: Optional[Callable[[], bool]] = None,
    restart_fn: Optional[Callable[[], bool]] = None,
    verify_address_fn: Optional[Callable[[], str]] = None,
    verify_fn: Optional[Callable[..., Any]] = None,
    profile_established_fn: Optional[Callable[[], bool]] = None,
    managed_fn: Optional[Callable[[], bool]] = None,
    monotonic_fn: Callable[[], float] = time.monotonic,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> RelayCredentialResetResult:
    """Replace and prove the shared credential after local confirmation.

    This is the fail-closed state-machine seam. The caller owns the interactive
    terminal gate; this function owns generation, atomic persistence, explicit
    restart, and both authentication proofs. No incomplete path reports success.
    """
    credential_fn = _read_relay_credential if credential_fn is None else credential_fn
    generate_fn = generate_relay_credential if generate_fn is None else generate_fn
    use_default_persistence = persist_fn is None
    use_default_restart = restart_fn is None
    verify_address_fn = (
        _relay_verify_address if verify_address_fn is None else verify_address_fn
    )
    verify_fn = _verify_relay_credential if verify_fn is None else verify_fn
    profile_established_fn = (
        relay_credential.is_profile_established
        if profile_established_fn is None
        else profile_established_fn
    )
    managed_fn = (
        relay_credential.is_managed_profile if managed_fn is None else managed_fn
    )

    if managed_fn():
        return RelayCredentialResetResult(False, "managed_profile")

    try:
        previous = str(credential_fn() or "").strip()
    except Exception:  # noqa: BLE001 - unreadable is the same fail-closed state
        previous = ""
    if not previous and not profile_established_fn():
        return RelayCredentialResetResult(False, "credential_missing")

    try:
        replacement = str(generate_fn() or "")
    except Exception:  # noqa: BLE001 - generation failure is a stable outcome
        return RelayCredentialResetResult(False, "generation_failed")
    if (
        _RELAY_CREDENTIAL_PATTERN.fullmatch(replacement) is None
        or (bool(previous) and hmac.compare_digest(replacement, previous))
    ):
        return RelayCredentialResetResult(False, "generation_failed")

    restart_plan = None
    if use_default_restart:
        try:
            restart_plan = _prepare_gateway_restart()
        except Exception:  # noqa: BLE001 - stop before persistence on ambiguity
            restart_plan = None
        if restart_plan is None:
            return RelayCredentialResetResult(False, "restart_unsupported")
        prepared_timeout_s = restart_plan.timeout_s

        def restart_fn() -> bool:  # type: ignore[no-redef]
            return _restart_hermes_gateway(timeout_s=prepared_timeout_s)

    try:
        if restart_ready_fn is not None:
            restart_ready = bool(restart_ready_fn())
        elif use_default_restart:
            restart_ready = True
        else:
            restart_ready = _gateway_restart_is_bounded()
    except Exception:  # noqa: BLE001 - never persist across ambiguous lifecycle
        restart_ready = False
    if not restart_ready:
        return RelayCredentialResetResult(False, "restart_unsupported")

    try:
        if use_default_persistence:
            persistence = _persist_relay_credential_generation(replacement, previous)
        else:
            injected_persistence = persist_fn(replacement)
            persistence = (
                PERSISTENCE_AMBIGUOUS
                if injected_persistence == PERSISTENCE_AMBIGUOUS
                else PERSISTENCE_COMMITTED
                if bool(injected_persistence)
                else PERSISTENCE_ROLLED_BACK
            )
    except BaseException:  # noqa: BLE001 - reconcile post-confirmation interrupts
        persistence = PERSISTENCE_AMBIGUOUS
    if persistence == PERSISTENCE_AMBIGUOUS:
        return RelayCredentialResetResult(
            False,
            "persistence_rollback_ambiguous",
        )
    if persistence != PERSISTENCE_COMMITTED:
        return RelayCredentialResetResult(False, "persistence_failed")

    try:
        restarted = bool(restart_fn())
    except Exception:  # noqa: BLE001 - injected or host restart failed closed
        restarted = False
    if not restarted:
        return RelayCredentialResetResult(
            False,
            "restart_failed",
            persisted=True,
        )

    try:
        address = verify_address_fn()
        replacement_auth = _wait_for_replacement_acceptance(
            address=address,
            credential=replacement,
            verify_fn=verify_fn,
            monotonic_fn=monotonic_fn,
            sleep_fn=sleep_fn,
        )
    except Exception:  # noqa: BLE001 - verifier failure is ambiguous, never success
        replacement_auth = "unknown"
    if replacement_auth != "accepted":
        return RelayCredentialResetResult(
            False,
            "replacement_auth_failed",
            persisted=True,
            gateway_restarted=True,
            replacement_auth=replacement_auth,
        )

    if previous:
        try:
            previous_outcome = verify_fn(
                address=address,
                credential=previous,
                timeout_s=RELAY_VERIFY_TIMEOUT_S,
            )
            previous_auth = _verify_outcome_name(previous_outcome)
        except Exception:  # noqa: BLE001 - ambiguity is not rejection proof
            previous_auth = "unknown"
    else:
        previous_auth = "not_applicable"
    if previous_auth not in {"rejected", "not_applicable"}:
        return RelayCredentialResetResult(
            False,
            "previous_rejection_ambiguous",
            persisted=True,
            gateway_restarted=True,
            replacement_auth=replacement_auth,
            previous_auth=previous_auth,
        )

    return RelayCredentialResetResult(
        True,
        "reset_complete",
        persisted=True,
        gateway_restarted=True,
        replacement_auth=replacement_auth,
        previous_auth=previous_auth,
    )


def _reset_succeeded(result: RelayCredentialResetResult) -> bool:
    return bool(
        result.success
        and result.persisted
        and result.gateway_restarted
        and result.replacement_auth == "accepted"
        and result.previous_auth in {"rejected", "not_applicable"}
    )


def _render_reset_result(result: RelayCredentialResetResult) -> str:
    if _reset_succeeded(result):
        prior_proof = (
            "The prior-credential rejection proof was not applicable because "
            "the established profile had no readable prior credential."
            if result.previous_auth == "not_applicable"
            else "The prior credential was rejected."
        )
        return (
            "\n  Relay Credential reset complete. The replacement was atomically "
            "persisted and read back. The Hermes gateway explicitly restarted.\n"
            f"  The replacement was accepted. {prior_proof}\n"
            "  Every phone is disconnected. Return to /ocuclaw-setup and "
            "securely re-pair by QR or Manual pairing.\n"
            "  This was an all-device reset; per-device revocation is future work.\n"
        )
    messages = {
        "managed_profile": relay_credential.MANAGED_CREDENTIAL_REQUIRED_MESSAGE,
        "credential_missing": (
            "No established OcuClaw profile could be proved, so reset did not "
            "create a replacement. Return to /ocuclaw-setup for guided recovery."
        ),
        "generation_failed": (
            "OcuClaw could not generate a strong replacement. Nothing was changed."
        ),
        "persistence_failed": (
            "The replacement could not be atomically persisted and read back. "
            "Reset did not complete; return to /ocuclaw-setup for guided recovery."
        ),
        "persistence_rollback_ambiguous": (
            "Replacement persistence and restoration of the prior credential "
            "could not be confirmed. Do not restart the Hermes gateway. Reset "
            "did not complete; return to /ocuclaw-setup for guided recovery."
        ),
        "restart_unsupported": (
            "The Hermes gateway is not in a bounded restart lifecycle. Nothing "
            "was changed. Install and start the Hermes gateway service, then "
            "return to /ocuclaw-setup and retry."
        ),
        "restart_failed": (
            "The replacement was persisted, but the Hermes gateway restart failed. "
            "Reset did not complete; return to /ocuclaw-setup for guided recovery."
        ),
        "replacement_auth_failed": (
            "The replacement did not authenticate after restart. Reset did not "
            "complete; return to /ocuclaw-setup for guided recovery."
        ),
        "previous_rejection_ambiguous": (
            "OcuClaw could not prove that the prior credential was rejected. Reset "
            "did not complete; return to /ocuclaw-setup for guided recovery."
        ),
    }
    evidence = (
        f" Evidence: persisted={str(result.persisted).lower()}, "
        f"gatewayRestarted={str(result.gateway_restarted).lower()}, "
        f"replacementAuth={result.replacement_auth}, "
        f"previousAuth={result.previous_auth}."
    )
    message = messages.get(result.code, "Reset did not complete safely.")
    return "\n  " + message + evidence + "\n"


@contextmanager
def _defer_reset_interrupts():
    """Defer terminal Ctrl-C until the confirmed mutation has a receipt."""
    interrupted = {"value": False}
    previous_handler = None
    installed = False

    if threading.current_thread() is threading.main_thread():
        try:
            previous_handler = signal.getsignal(signal.SIGINT)

            def defer_interrupt(_signum, _frame):
                interrupted["value"] = True

            signal.signal(signal.SIGINT, defer_interrupt)
            installed = True
        except (AttributeError, OSError, ValueError):
            installed = False
    try:
        yield lambda: interrupted["value"]
    finally:
        if installed:
            signal.signal(signal.SIGINT, previous_handler)


def run_reset_relay_credential(
    *,
    stdin: Optional[TextIO] = None,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
    isatty_fn: Optional[Callable[[], bool]] = None,
    reset_fn: Optional[Callable[[], RelayCredentialResetResult]] = None,
    managed_fn: Optional[Callable[[], bool]] = None,
) -> int:
    """Run the Setup Assistant's interactive-only all-device reset action."""
    inp = sys.stdin if stdin is None else stdin
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    managed_fn = (
        relay_credential.is_managed_profile if managed_fn is None else managed_fn
    )
    if managed_fn():
        out.write("\n  " + relay_credential.MANAGED_CREDENTIAL_REQUIRED_MESSAGE + "\n")
        return EXIT_PROBLEM
    if isatty_fn is None:

        def isatty_fn() -> bool:  # type: ignore[misc]
            try:
                return bool(inp.isatty()) and bool(out.isatty())
            except Exception:  # noqa: BLE001
                return False

    if not isatty_fn():
        err.write(
            "Reset relay credential needs an interactive terminal. Run this "
            "command directly on the Hermes host; there is no --yes, --json, "
            "redirected, or chat-only confirmation path.\n"
        )
        return EXIT_USAGE

    out.write("\n  WARNING: " + RESET_WARNING + "\n\n")
    out.write(RESET_PROMPT_TEXT)
    out.flush()
    try:
        answer = inp.readline()
    except (KeyboardInterrupt, EOFError):
        answer = ""
    if answer.strip().lower() != "reset":
        out.write("\n  Reset cancelled. The Relay Credential was not changed.\n")
        return EXIT_PROBLEM

    reset_fn = reset_relay_credential if reset_fn is None else reset_fn
    with _defer_reset_interrupts() as was_interrupted:
        try:
            result = reset_fn()
        except BaseException:  # noqa: BLE001 - mutation receipt survives Ctrl-C
            result = RelayCredentialResetResult(False, "reset_failed")
        out.write(_render_reset_result(result))
        if was_interrupted():
            out.write(
                "  Interrupt deferred until credential recovery completed. "
                "Follow the result above.\n"
            )
    return EXIT_OK if _reset_succeeded(result) else EXIT_PROBLEM


def _read_relay_credential() -> str:
    """Read the managed Relay Credential this host authenticates with.

    Goes through Hermes's own ``.env`` accessor first — the canonical secret
    source per the adapter's contract — and falls back to the process
    environment, which is how a supervised run receives it.
    """
    return relay_credential.read_relay_credential()


def _control_url() -> str:
    """Build the loopback control URL from the configured relay bind and port.

    Loopback because this is the host talking to its own relay. It is NOT the
    address the phone dials — that one is the private route the operator passes
    with ``--address`` and is what gets bound into the exchange.
    """
    bind = DEFAULT_WS_BIND
    port = DEFAULT_WS_PORT
    try:
        from .adapter import _setup_raw_config  # type: ignore

        raw_config, _readable = _setup_raw_config()
        platforms = raw_config.get("platforms")
        platform = platforms.get("ocuclaw", {}) if isinstance(platforms, dict) else {}
        extra = platform.get("extra") if isinstance(platform, dict) else None
        if isinstance(extra, dict):
            if str(extra.get("wsBind") or "").strip():
                bind = str(extra["wsBind"]).strip()
            if "wsPort" in extra:
                candidate = int(extra["wsPort"])
                if 1 <= candidate <= 65535:
                    port = candidate
    except Exception:  # noqa: BLE001 - a diagnostic must not become an outage
        pass
    # A relay bound to 0.0.0.0 is still reached at loopback from this host, and
    # dialing the wildcard address is not portable.
    if bind in {"0.0.0.0", "::", ""}:
        bind = DEFAULT_WS_BIND
    host = f"[{bind}]" if ":" in bind and not bind.startswith("[") else bind
    return f"http://{host}:{port}{CONTROL_PATH}"


def _post(
    url: str,
    payload: Mapping[str, Any],
    *,
    credential: str,
    control_secret: Optional[str] = None,
    timeout: float = 10.0,
) -> Tuple[int, Dict[str, Any]]:
    """POST one control request. Returns (status, parsed-body)."""
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "content-type": "application/json",
        AUTH_HEADER: credential,
    }
    if control_secret:
        headers[SECRET_HEADER] = control_secret
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            return int(response.status), _parse(raw)
    except urllib.error.HTTPError as exc:
        raw = ""
        try:
            raw = exc.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - the status is the signal
            pass
        return int(exc.code), _parse(raw)
    except urllib.error.URLError as exc:
        raise ControlError(
            "Could not reach the OcuClaw relay on this computer. Is it running? "
            f"({exc.reason})"
        ) from exc
    except OSError as exc:
        raise ControlError(
            f"Could not reach the OcuClaw relay on this computer. ({exc})"
        ) from exc


def _parse(raw: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except Exception:  # noqa: BLE001 - a malformed body is not a crash
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _refusal_text(status: int) -> str:
    """Explain a refusal without inventing detail the surface did not give."""
    if status == 401:
        return (
            "This computer refused the pairing command's own credentials. Check "
            "the Relay Credential through /ocuclaw-setup guided recovery; never "
            "enter or reveal it, then try pairing again only after recovery."
        )
    if status == 503:
        return (
            "Pairing is unavailable on this computer: the relay could not prove "
            "it can run the encrypted exchange."
        )
    if status == 429:
        return "Too many pairing requests just now. Wait a minute and try again."
    return f"The relay refused the pairing request (status {status})."


_SAFE_LABEL = re.compile(r"[^A-Za-z0-9 ._+\-]")


def _render_prompt_block(phone_label: str, phrase: Any) -> str:
    """Render the approval question.

    Shows the two things Q4 permits and nothing else. Both arrive already
    sanitized from the exchange core; the label is filtered again here because
    this string is written straight to a terminal, and defence in depth against
    escape sequences is cheap.
    """
    label = _SAFE_LABEL.sub("", str(phone_label or ""))[:32].strip() or "unknown device"
    words = [str(word) for word in phrase] if isinstance(phrase, (list, tuple)) else []
    return (
        "\n"
        "  A phone is asking to pair.\n"
        "\n"
        f"    Phone:  {label}\n"
        f"    Words:  {' '.join(words)}\n"
        "\n"
        "  Approve only if the phone shows these four words, in this order.\n"
        "  If even one word differs, answer no.\n"
        "\n"
    )


def _ask_yes_no(
    stdin: TextIO,
    stdout: TextIO,
    *,
    prompt: str = PROMPT_TEXT,
    max_retries: int = MAX_PROMPT_RETRIES,
) -> bool:
    """Ask the exact yes/no question. Anything unreadable ends as a refusal.

    Only the whole words "yes" and "no" are accepted. A bare "y" is deliberately
    NOT enough: this is the one question standing between an unverified peer and
    the Relay Credential, and a single keystroke is too easy to fire off by
    reflex at a prompt the user has not read.
    """
    for _attempt in range(max_retries):
        stdout.write(prompt)
        stdout.flush()
        try:
            line = stdin.readline()
        except (KeyboardInterrupt, EOFError):
            return False
        if line == "":  # EOF
            return False
        answer = line.strip().lower()
        if answer == "yes":
            return True
        if answer == "no":
            return False
        stdout.write('  Please answer "yes" or "no".\n')
    stdout.write("  No clear answer, so pairing was not approved.\n")
    return False


def _outcome_text(state: str, failure: Any, credential_exposure: str) -> str:
    """The last thing printed. Never claims more than the host can know."""
    if state == "completed":
        return (
            "\n  Paired. The phone connected back and confirmed it.\n"
        )
    reason = ""
    if isinstance(failure, Mapping):
        reason = str(failure.get("reason") or "")
    if reason == "completion-window-elapsed" or (
        state == "failed" and credential_exposure == "delivered"
    ):
        # Q2's exact honest record: the credential left, the correlated hello
        # never landed. Never reported as success, and never re-delivered.
        return (
            "\n  Credential delivered; pairing unconfirmed.\n"
            "\n"
            "  The phone was sent what it needs but did not connect back in time, "
            "so this computer cannot confirm the pairing.\n"
            "  Open the app on the phone. If it does not connect, run "
            "`hermes ocuclaw pair` again.\n"
        )
    return "\n  " + _FAILURE_TEXT.get(reason, _GENERIC_FAILURE) + "\n"


def run_pair(
    address: str,
    *,
    stdin: Optional[TextIO] = None,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
    light_terminal: bool = False,
    show_payload_text: bool = False,
    credential_fn: Optional[Callable[[], str]] = None,
    control_url_fn: Optional[Callable[[], str]] = None,
    post_fn: Optional[Callable[..., Tuple[int, Dict[str, Any]]]] = None,
    isatty_fn: Optional[Callable[[], bool]] = None,
    sleep_fn: Optional[Callable[[float], None]] = None,
    monotonic_fn: Optional[Callable[[], float]] = None,
) -> int:
    """Run one interactive pairing session. Returns the process exit code.

    Every collaborator is injectable, which is what lets the whole surface —
    the TTY gate, the prompt wording, the poll loop, the outcome text — run in
    tests exactly as it runs against a real host.
    """
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    inp = sys.stdin if stdin is None else stdin
    credential_fn = _read_relay_credential if credential_fn is None else credential_fn
    control_url_fn = _control_url if control_url_fn is None else control_url_fn
    post_fn = _post if post_fn is None else post_fn
    sleep_fn = time.sleep if sleep_fn is None else sleep_fn
    monotonic_fn = time.monotonic if monotonic_fn is None else monotonic_fn
    if isatty_fn is None:

        def isatty_fn() -> bool:  # type: ignore[misc]
            # BOTH streams, not just stdin.
            #
            # The four words are the authentication gate, so the stream that
            # DISPLAYS them has to be a terminal too. `hermes ocuclaw pair | tee
            # log` keeps a terminal stdin and would happily read "yes" from the
            # operator while the phrase and the question went into the pipe —
            # letting someone approve a pairing they never actually saw.
            try:
                return bool(inp.isatty()) and bool(out.isatty())
            except Exception:  # noqa: BLE001 - an unaskable stream is not a TTY
                return False

    # THE TTY GATE (Q4). There is no non-interactive approval path, so a host
    # without an interactive terminal cannot pair — and must not be given a
    # quiet way to approve. This is a refusal, never a default-yes.
    if not isatty_fn():
        err.write(
            "hermes ocuclaw pair needs an interactive terminal.\n"
            "\n"
            "Pairing asks a human to compare four words and answer yes or no, and "
            "there is deliberately no way to answer that without a terminal.\n"
            "Both the question and the answer must go through it, so this also "
            "refuses when the output is redirected or piped.\n"
            "Run this command directly in a terminal on this computer.\n"
        )
        return EXIT_USAGE

    credential = credential_fn()
    if not credential:
        err.write(
            "No Relay Credential is readable for OcuClaw on this profile, so the "
            "pairing command cannot authenticate to the relay.\n"
            "Run /ocuclaw-setup for guided recovery. This command will not create "
            "or ask you to enter a replacement.\n"
        )
        return EXIT_PROBLEM

    url = control_url_fn()

    try:
        status, created = post_fn(
            url,
            {"v": 1, "op": "create", "address": address, "lightTerminal": light_terminal},
            credential=credential,
        )
    except ControlError as exc:
        err.write(f"{exc}\n")
        return EXIT_PROBLEM

    if status == 409:
        message = str(created.get("message") or "").strip()
        err.write(
            (message or "The relay refused to start a pairing request with that address.")
            + "\n"
        )
        return EXIT_PROBLEM
    if status != 200:
        err.write(_refusal_text(status) + "\n")
        return EXIT_PROBLEM

    control_secret = str(created.get("controlSecret") or "")
    block = str(created.get("bootstrapBlock") or "")
    if not control_secret or not block:
        err.write("The relay returned an unusable pairing request.\n")
        return EXIT_PROBLEM

    # The Q15 local-human-only view: the printed block carries the canonical
    # private address and the short-lived pairing code, and nothing secret.
    out.write(block)
    if show_payload_text:
        # The exact text the code encodes. For a terminal that cannot render
        # block characters at all — a screen reader, a pipe, a log — the QR is
        # an empty rectangle and this is the only way to hand it over. It is the
        # same four public fields the QR carries and nothing more, so printing
        # it discloses exactly what holding the code up to a camera would.
        payload_text = str(created.get("payloadText") or "")
        if payload_text:
            out.write(f"  Code contents: {payload_text}\n\n")
    out.flush()

    deadline = monotonic_fn() + POLL_DEADLINE_S
    prompt_shown = False
    decided = False

    while True:
        if monotonic_fn() >= deadline:
            out.write(
                "\n  The pairing request expired before the phone finished.\n"
                "  Run `hermes ocuclaw pair` again to start a new one.\n"
            )
            return EXIT_PROBLEM

        try:
            status, state = post_fn(
                url,
                {"v": 1, "op": "state"},
                credential=credential,
                control_secret=control_secret,
            )
        except ControlError as exc:
            err.write(f"\n{exc}\n")
            return EXIT_PROBLEM

        if status != 200:
            err.write("\n" + _refusal_text(status) + "\n")
            return EXIT_PROBLEM

        current = str(state.get("state") or "")
        if current in _TERMINAL_STATES:
            out.write(
                _outcome_text(
                    current,
                    state.get("failure"),
                    str(state.get("credentialExposure") or "none"),
                )
            )
            return EXIT_OK if current == "completed" else EXIT_PROBLEM

        prompt = state.get("prompt")
        if not decided and isinstance(prompt, Mapping) and prompt.get("safetyPhrase"):
            if not prompt_shown:
                out.write(
                    _render_prompt_block(
                        prompt.get("phoneLabel"), prompt.get("safetyPhrase")
                    )
                )
                prompt_shown = True

            approved = _ask_yes_no(inp, out)
            decided = True

            try:
                status, decision = post_fn(
                    url,
                    {"v": 1, "op": "approve" if approved else "deny"},
                    credential=credential,
                    control_secret=control_secret,
                )
            except ControlError as exc:
                err.write(f"\n{exc}\n")
                return EXIT_PROBLEM
            if status != 200:
                err.write("\n" + _refusal_text(status) + "\n")
                return EXIT_PROBLEM

            # READ THE OUTCOME OFF THIS RESPONSE, not off a fresh poll.
            #
            # A decision that ends the exchange — a refusal, most obviously —
            # also retires this session's control secret, because the secret is
            # scoped to the exchange and dies with it. Polling again afterwards
            # is therefore unauthorized, and reporting THAT would tell the user
            # their relay token is wrong at the exact moment they correctly
            # refused a pairing. The decision response already carries the
            # ending, so use it.
            decided_state = str(decision.get("state") or "")
            if decided_state in _TERMINAL_STATES:
                out.write(
                    _outcome_text(
                        decided_state,
                        decision.get("failure"),
                        str(decision.get("credentialExposure") or "none"),
                    )
                )
                return EXIT_OK if decided_state == "completed" else EXIT_PROBLEM

            if approved:
                out.write("\n  Approved. Waiting for the phone to connect back...\n")
            # Otherwise keep polling: an approval is not yet an ending, and the
            # terminal state carries the real outcome — including Q2's
            # "credential delivered; pairing unconfirmed".
            continue

        sleep_fn(POLL_INTERVAL_S)
