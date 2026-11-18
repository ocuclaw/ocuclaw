"""The three chat setup operations and their Hermes approval hooks (#6378).

* ``apply_route {binding, answer?}`` publishes the private route after the
  host's approval card (or a fresh chat yes), through the one apply seam,
  :func:`cloudways_serve_apply.run_chat_route`. This module is that seam's
  only caller besides the Cloudways ladder.
* ``pair_with_phone_code {code}`` pairs through the phone-code flow the
  terminal ``pair`` command uses: the same loopback control endpoint and
  request helper, the same preflight.
* ``confirm_pairing {binding, answer?}`` approves (or, on a fresh chat no,
  refuses) the held exchange once the user has matched the four words.

Every result is a receipt ``{operation, status, then: "call_next", detail?}``.
No receipt carries the words, the command, the control secret or anything
about the relay's own authentication. The words reach chat only through the
step machine's ``next``.

The hooks: :func:`pre_tool_call_directive` turns an ``apply_route`` or
``confirm_pairing`` call into the host's approval card, built from the
store's own text, or blocks a binding the store does not hold.
:func:`handle_post_approval_response` cancels the held exchange when the user
denies the pairing card. :func:`record_pre_llm_call` remembers the user's own
messages for the chat yes check.

Hermes reports "Skip all this session", ``approvals.mode: off`` and YOLO as
approved with no card, so an approval that comes back faster than a person
could press one is ``unconfirmed``: nothing runs, the binding stays live and
the step machine asks again as a chat yes.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Tuple

from . import pairing
from . import setup_approval_store as store
from .cloudways_serve_apply import query_serve_enable_link as _query_serve_enable_link
from .cloudways_serve_apply import run_chat_route
from .cloudways_serve_apply import wait_chat_route_certificate as _wait_chat_route_certificate

SETUP_TOOL_NAME = "ocuclaw_setup"
CHAT_OPERATIONS = (store.OPERATION_ROUTE, store.OPERATION_PAIRING, store.OPERATION_CODE)

#: The popup surfaces keep their own pairing window (``pair_phone``).
POPUP_SURFACES = frozenset({"desktop"})

PAIR_POLL_S = 1.0
PAIR_WORDS_WAIT_S = 45.0
CONFIRM_WAIT_S = 60.0

STALE_BLOCK_MESSAGE = (
    "This approval is out of date or was already used, so nothing ran. "
    "Call ocuclaw_setup with operation next for a fresh one."
)

# Detail codes. Fixed strings, never a secret or anything the user typed.
DETAIL_COMMAND_UNAVAILABLE = "route-command-unavailable"
DETAIL_ROUTE_ERROR = "route-error"
DETAIL_PAIRING_AUTH_MISSING = "pairing-auth-missing"
DETAIL_CONTROL_UNREACHABLE = "pairing-control-unreachable"
DETAIL_CONTROL_REFUSED = "pairing-control-refused"
DETAIL_UNUSABLE_REPLY = "pairing-reply-unusable"
DETAIL_DECISION_REFUSED = "pairing-decision-refused"
DETAIL_EXCHANGE_ENDED = "pairing-exchange-ended"


# -- receipts ----------------------------------------------------------------------


def receipt(operation: str, status: str, detail: Optional[str] = None) -> Dict[str, str]:
    """``{operation, status, then: "call_next", detail?}`` from the fixed vocabulary."""
    if status not in store.RECEIPTS.get(operation, ()):
        status, detail = "failed", detail or "unknown-status"
    result = {"operation": operation, "status": status, "then": store.RECEIPT_THEN}
    if detail:
        result["detail"] = str(detail)
    return result


# -- answers and codes ---------------------------------------------------------------

#: The terminal's own approval words (pairing.py's classifier) plus the bare
#: letters.
_YES_ANSWERS = frozenset({"yes", "y"}) | pairing._APPROVE_ANSWERS
_NO_ANSWERS = frozenset({"no", "n"}) | pairing._DENY_ANSWERS
_TRAILING = ".!?,;:… \t"


def classify_chat_answer(text: Any) -> Optional[str]:
    """``"yes"``, ``"no"`` or ``None``: the whole message must be the answer.

    Trimmed, lowercased, trailing punctuation stripped. "yes please" is not a
    yes: a sentence is the agent's to interpret, and this check is the user's.
    """
    if not isinstance(text, str):
        return None
    answer = text.strip().lower().rstrip(_TRAILING).strip()
    if answer in _YES_ANSWERS:
        return "yes"
    if answer in _NO_ANSWERS:
        return "no"
    return None


_PHONE_CODE = re.compile(r"^(?:[0-9]{6}|[0-9]{3}[ -][0-9]{3})$")
_PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_PAIRING_CODE_LENGTH = 8
_MAX_RAW_CODE_LENGTH = 64
_PAIRING_CODE_ALIASES = {"O": "0", "I": "1", "L": "1", "U": "V"}


def _normalize_pairing_code(text: str) -> Optional[str]:
    """The relay's own ``normalizePairingCode`` (pairing-exchange.ts)."""
    if len(text) > _MAX_RAW_CODE_LENGTH:
        return None
    normalized = ""
    for raw in text.upper():
        if raw in "- ":
            continue
        char = _PAIRING_CODE_ALIASES.get(raw, raw)
        if char not in _PAIRING_CODE_ALPHABET:
            return None
        normalized += char
        if len(normalized) > _PAIRING_CODE_LENGTH:
            return None
    return normalized if len(normalized) == _PAIRING_CODE_LENGTH else None


def normalize_phone_code(value: Any) -> Tuple[str, Optional[str]]:
    """``("phone-code", digits)``, ``("pairing-code", code)`` or ``("invalid", None)``.

    The Hermes twin of OpenClaw's ``normalizePhoneCode`` (pairing-note.ts):
    six digits, optionally split 3+3 by one space or dash, versus the
    eight-character manual pairing code, which goes into the phone instead.
    """
    if not isinstance(value, str) or len(value) > _MAX_RAW_CODE_LENGTH:
        return "invalid", None
    trimmed = value.strip()
    if _PHONE_CODE.fullmatch(trimmed):
        return "phone-code", re.sub(r"[ -]", "", trimmed, count=1)
    manual = _normalize_pairing_code(trimmed)
    return ("invalid", None) if manual is None else ("pairing-code", manual)


# -- dependencies ----------------------------------------------------------------------


@dataclass
class ChatDeps:
    """Everything the operations touch. The adapter fills in the host's own."""

    state_dir: str
    #: The live Hermes surface (adapter ``_host_setup_surface``).
    surface: str = ""
    #: ``() -> (address | None, reason)``: the terminal pair preflight
    #: (plugin, relay, route healthy and owned, or a custom route).
    pairing_address_fn: Callable[[], Tuple[Optional[str], str]] = (
        lambda: (None, "unavailable")
    )
    #: True when a custom phone address is configured (``customRoute``).
    custom_route_fn: Callable[[], bool] = lambda: False
    credential_fn: Optional[Callable[[], str]] = None
    control_url_fn: Optional[Callable[[], str]] = None
    post_fn: Optional[Callable[..., Tuple[int, Dict[str, Any]]]] = None
    hermes_home: Any = None
    route_fn: Optional[Callable[..., Mapping[str, str]]] = None
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    #: Extra keyword arguments for ``route_fn`` (tests: fakes for the seam).
    route_kwargs: Dict[str, Any] = field(default_factory=dict)


def _credential(deps: ChatDeps) -> str:
    fn = deps.credential_fn or pairing._read_relay_credential
    return str(fn() or "")


def _control_url(deps: ChatDeps) -> str:
    fn = deps.control_url_fn or pairing._control_url
    return str(fn())


def _post(deps: ChatDeps) -> Callable[..., Tuple[int, Dict[str, Any]]]:
    return deps.post_fn or pairing._post


# -- the approval checks -------------------------------------------------------------------


def _approval_gate(
    operation: str, args: Mapping[str, Any], deps: ChatDeps
) -> Tuple[Optional[str], Optional[Dict[str, Any]], str]:
    """``(status, entry, answer)``. A status means stop with that receipt.

    1. the binding must be live in the store for this operation;
    2. without ``answer``: the hook must have returned the card for it at
       least :data:`store.FAST_APPROVAL_MS` ago, or the approval was not a
       person's (and the store remembers approvals are bypassed);
    3. with ``answer``: a user message newer than the binding must read as
       that same yes or no.
    """
    state_dir = deps.state_dir
    entry = store.lookup_approval(state_dir, args.get("binding"), operation)
    if entry is None:
        return "stale_binding", None, ""
    if "answer" not in args or args.get("answer") is None:
        returned_at = entry.get("hook_returned_at")
        if (
            returned_at is None
            or (store.monotonic_now() - float(returned_at)) * 1000.0 < store.FAST_APPROVAL_MS
        ):
            store.mark_approvals_bypassed(state_dir)
            return "unconfirmed", entry, ""
        return None, entry, "yes"
    answer = args.get("answer")
    if answer not in store.CHAT_ANSWERS:
        return "unconfirmed", entry, ""
    message = store.latest_user_message_after(
        int(entry["seq"]), session_id=entry.get("hook_session_id")
    )
    if message is None or classify_chat_answer(message.get("text")) != answer:
        return "unconfirmed", entry, ""
    return None, entry, str(answer)


# -- apply_route ---------------------------------------------------------------------------


def apply_route(args: Mapping[str, Any], deps: ChatDeps) -> Dict[str, str]:
    operation = store.OPERATION_ROUTE
    stop, entry, answer = _approval_gate(operation, args, deps)
    if stop is not None:
        return receipt(operation, stop)
    if not store.consume_approval(deps.state_dir, entry["binding"], operation):
        return receipt(operation, "stale_binding")
    if answer == "no":
        return receipt(operation, "declined")
    route = deps.route_fn or run_chat_route
    try:
        result = route(entry["shown"], hermes_home=deps.hermes_home, **deps.route_kwargs)
    except Exception:  # noqa: BLE001 - a broken seam is a failed apply, said plainly
        return receipt(operation, "failed", DETAIL_ROUTE_ERROR)
    status = str((result or {}).get("status") or "failed")
    return receipt(operation, status, (result or {}).get("detail"))


def route_command() -> str:
    """The exact route command the step machine shows and binds.

    The same three accessors the seam builds its argv from; the seam
    re-derives that argv after the approval and refuses when it no longer
    joins to this text.
    """
    from . import serve
    from .control_link import HERMES_BUNDLE_DEFAULT_WS_PORT

    return serve.apply_command(relay_port=int(HERMES_BUNDLE_DEFAULT_WS_PORT))


def https_enable_link(socket_path: Any) -> Optional[str]:
    """Tailscale's turn-HTTPS-on link for the step machine (#6377).

    This module stays the chat lane's one door to the route seam: the step
    machine (setup_next.py) reads through here and never imports the seam.
    """
    return _query_serve_enable_link(socket_path)


def wait_route_certificate(*, hermes_home: Any, budget_s: float) -> Dict[str, str]:
    """The step machine's bounded certificate wait on a route already ours.

    Read-only apart from ``tailscale cert``; it never applies or changes a
    route (the seam's own guarantee, see ``wait_chat_route_certificate``).
    """
    return _wait_chat_route_certificate(hermes_home=hermes_home, budget_s=budget_s)


# -- pair_with_phone_code -------------------------------------------------------------------


def pair_with_phone_code(args: Mapping[str, Any], deps: ChatDeps) -> Dict[str, str]:
    operation = store.OPERATION_CODE
    if str(deps.surface or "") in POPUP_SURFACES:
        return receipt(operation, "use_pair_phone")
    kind, code = normalize_phone_code(args.get("code"))
    if kind == "invalid":
        return receipt(operation, "malformed")
    if kind == "pairing-code":
        return receipt(operation, "pairing_code_typed")

    try:
        address, reason = deps.pairing_address_fn()
    except Exception:  # noqa: BLE001 - the preflight fails closed
        address, reason = None, "verification_failed"
    if not address:
        return receipt(operation, "not_ready", str(reason or "not_ready"))
    try:
        credential = _credential(deps)
        url = _control_url(deps)
    except Exception:  # noqa: BLE001 - the preflight fails closed
        credential, url = "", ""
    if not credential or not url:
        return receipt(operation, "not_ready", DETAIL_PAIRING_AUTH_MISSING)
    post = _post(deps)

    # A new code replaces whatever this store still holds.
    store.cancel_held_pairing(deps.state_dir)

    payload: Dict[str, Any] = {"v": 1, "op": "create", "address": address}
    try:
        if deps.custom_route_fn():
            payload["customRoute"] = True
    except Exception:  # noqa: BLE001 - the relay still fences the address
        pass
    payload["phoneCode"] = code
    try:
        status, reply = post(
            url,
            payload,
            credential=credential,
            timeout=pairing.PHONE_CODE_CREATE_TIMEOUT_SECONDS,
        )
    except Exception:  # noqa: BLE001 - ControlError and anything a fake raises
        return receipt(operation, "failed", DETAIL_CONTROL_UNREACHABLE)
    reply = reply if isinstance(reply, Mapping) else {}
    if status == 409:
        return receipt(operation, "busy")
    if status != 200:
        return receipt(operation, "failed", DETAIL_CONTROL_REFUSED)
    refused = reply.get("reason")
    if refused in ("no_code", "spent"):
        return receipt(operation, "no_code")
    if refused == "malformed":
        return receipt(operation, "malformed")
    if refused == "pairing_code_typed":
        return receipt(operation, "pairing_code_typed")
    secret = reply.get("controlSecret")
    if not isinstance(secret, str) or not secret:
        return receipt(operation, "failed", DETAIL_UNUSABLE_REPLY)

    def control(op: str) -> Tuple[int, Dict[str, Any]]:
        return post(url, {"v": 1, "op": op}, credential=credential, control_secret=secret)

    if reply.get("delivery") != "sent":
        # Phone codes are down. The reply holds a manual pairing code, which
        # must never go into a chat, so the exchange is cancelled unread.
        try:
            control("cancel")
        except Exception:  # noqa: BLE001 - it expires at the host anyway
            pass
        return receipt(operation, "phone_codes_unavailable")

    store.hold_pairing(
        deps.state_dir,
        exchange_id=str(reply.get("exchangeId") or ""),
        control_secret=secret,
        control=control,
    )
    deadline = deps.clock() + PAIR_WORDS_WAIT_S
    while True:
        store.ask_pairing_state(deps.state_dir)
        current = store.pairing_status(deps.state_dir)["state"]
        if current == "words_ready":
            return receipt(operation, "words_ready")
        if current in store.TERMINAL_STATUSES or store.held_pairing(deps.state_dir) is None:
            return receipt(operation, "failed", DETAIL_EXCHANGE_ENDED)
        if deps.clock() >= deadline:
            return receipt(operation, "sent")
        deps.sleep(PAIR_POLL_S)


# -- confirm_pairing ------------------------------------------------------------------------


def _ending_status(snapshot: Mapping[str, Any]) -> Optional[str]:
    """A receipt status for a terminal exchange snapshot, else ``None``."""
    state = str(snapshot.get("state") or "")
    if state == "completed":
        delivered = snapshot.get("credentialExposure") == "delivered"
        return "paired" if delivered else "approved_waiting"
    if state == "failed":
        return "expired" if store.snapshot_status(snapshot) == "expired" else "failed"
    return None


def confirm_pairing(args: Mapping[str, Any], deps: ChatDeps) -> Dict[str, str]:
    operation = store.OPERATION_PAIRING
    stop, entry, answer = _approval_gate(operation, args, deps)
    if stop is not None:
        return receipt(operation, stop)
    if not store.consume_approval(deps.state_dir, entry["binding"], operation):
        return receipt(operation, "stale_binding")
    held = store.held_pairing(deps.state_dir)
    if held is None or held.get("exchange_id") != entry.get("exchange_id"):
        return receipt(operation, "stale_binding")
    if answer == "no":
        store.deny_held_pairing(deps.state_dir)
        return receipt(operation, "declined")

    snapshot = store.ask_pairing_state(deps.state_dir)
    if snapshot is None:
        ended = store.pairing_status(deps.state_dir)["state"]
        return receipt(operation, "expired" if ended == "expired" else "stale_binding")
    if store.snapshot_status(snapshot) == "expired":
        return receipt(operation, "expired")
    if store.prompt_words(snapshot) != entry.get("words"):
        return receipt(operation, "stale_binding")

    try:
        status, decision = held["control"]("approve")
    except Exception:  # noqa: BLE001 - ControlError and anything a fake raises
        return receipt(operation, "failed", DETAIL_CONTROL_UNREACHABLE)
    decision = decision if isinstance(decision, Mapping) else {}
    if status != 200:
        return receipt(operation, "failed", DETAIL_CONTROL_REFUSED)
    if decision.get("state"):
        store.note_pairing_snapshot(deps.state_dir, decision)
    ending = _ending_status(decision)
    if ending is not None:
        return receipt(operation, ending)
    if decision.get("ok") is False:
        return receipt(operation, "failed", DETAIL_DECISION_REFUSED)

    deadline = deps.clock() + CONFIRM_WAIT_S
    while deps.clock() < deadline:
        deps.sleep(PAIR_POLL_S)
        snapshot = store.ask_pairing_state(deps.state_dir)
        if snapshot is not None:
            ending = _ending_status(snapshot)
            if ending is not None:
                return receipt(operation, ending)
            continue
        if store.held_pairing(deps.state_dir) is None:
            ended = store.pairing_status(deps.state_dir)["state"]
            if ended in ("expired", "failed"):
                return receipt(operation, ended)
            return receipt(operation, "approved_waiting")
    return receipt(operation, "approved_waiting")


# -- dispatch ------------------------------------------------------------------------------------


def run_operation(operation: str, args: Mapping[str, Any], deps: ChatDeps) -> Dict[str, str]:
    args = args if isinstance(args, Mapping) else {}
    if operation == store.OPERATION_ROUTE:
        result = apply_route(args, deps)
    elif operation == store.OPERATION_PAIRING:
        result = confirm_pairing(args, deps)
    elif operation == store.OPERATION_CODE:
        result = pair_with_phone_code(args, deps)
    else:
        raise ValueError(f"not a chat setup operation: {operation!r}")
    # ``next`` never sees receipts: it reads the last one from the store.
    store.note_setup_receipt(deps.state_dir, result)
    return result


# -- the hooks -----------------------------------------------------------------------------------


def tool_args(value: Any) -> Dict[str, Any]:
    """A ``pre_tool_call`` ``args`` value as a dict (Hermes may pass JSON text)."""
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def approval_operation(kwargs: Mapping[str, Any]) -> Optional[str]:
    """The approval operation this ``pre_tool_call`` is about, or ``None``."""
    if str(kwargs.get("tool_name") or "").strip() != SETUP_TOOL_NAME:
        return None
    operation = str(tool_args(kwargs.get("args")).get("operation") or "").strip()
    return operation if operation in store.APPROVAL_OPERATIONS else None


def pre_tool_call_directive(
    kwargs: Mapping[str, Any], *, state_dir: str
) -> Optional[Dict[str, str]]:
    """The card (``approve``) or a ``block`` for our two approval operations.

    The card is built from the store's text for the binding, never from the
    call's own arguments; its ``rule_key`` names this one request. The time
    the hook returned is recorded for the fast-approval check. With
    ``answer`` present the card is still requested: approvals on, the user
    sees it as well; off, Hermes skips it and the tool's answer check decides.
    """
    operation = approval_operation(kwargs)
    if operation is None:
        return None
    binding = tool_args(kwargs.get("args")).get("binding")
    entry = store.lookup_approval(state_dir, binding, operation)
    if entry is None:
        return {"action": "block", "message": STALE_BLOCK_MESSAGE}
    directive = {
        "action": "approve",
        "message": store.approval_card_message(operation, entry["shown"]),
        "rule_key": store.approval_rule_key(operation, entry["binding"]),
    }
    store.record_hook_returned(
        state_dir, entry["binding"], session_id=str(kwargs.get("session_id") or "")
    )
    return directive


def _strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, (list, tuple, set, frozenset)):
        for item in value:
            if isinstance(item, str):
                yield item


_DENY_CHOICES = frozenset({"deny", "timeout"})


def handle_post_approval_response(kwargs: Mapping[str, Any]) -> bool:
    """A denied (or timed-out) pairing card cancels the held exchange.

    The tool never runs after a deny, so this is what stops the exchange
    cleanly. Returns True when it cancelled one.
    """
    choice = str(kwargs.get("choice") or "").strip().lower()
    if choice not in _DENY_CHOICES:
        return False
    for value in kwargs.values():
        for text in _strings(value):
            for operation, binding in store.RULE_KEY_PATTERN.findall(text):
                if operation != store.OPERATION_PAIRING:
                    continue
                state_dir = store.find_approval_state_dir(binding)
                if state_dir is None:
                    continue
                entry = store.lookup_approval(state_dir, binding, operation)
                if entry is None:
                    continue
                store.consume_approval(state_dir, binding, operation)
                held = store.held_pairing(state_dir)
                if held and held.get("exchange_id") == entry.get("exchange_id"):
                    store.cancel_held_pairing(state_dir, status="failed")
                    return True
    return False


def _message_text(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [
            part.get("text")
            for part in value
            if isinstance(part, Mapping) and isinstance(part.get("text"), str)
        ]
        return "".join(parts) if parts else None
    return None


def record_pre_llm_call(kwargs: Mapping[str, Any]) -> None:
    """Remember the user's own message for this turn (``pre_llm_call``).

    A delegated child turn (``parent_session_id`` set) carries the parent
    agent's task text, not the user's words, and is skipped.
    """
    if str(kwargs.get("parent_session_id") or "").strip():
        return
    text = _message_text(kwargs.get("user_message"))
    if text is None:
        return
    store.record_user_message(text, session_id=str(kwargs.get("session_id") or ""))


__all__ = [
    "CHAT_OPERATIONS",
    "ChatDeps",
    "STALE_BLOCK_MESSAGE",
    "apply_route",
    "approval_operation",
    "classify_chat_answer",
    "confirm_pairing",
    "handle_post_approval_response",
    "https_enable_link",
    "normalize_phone_code",
    "pair_with_phone_code",
    "pre_tool_call_directive",
    "receipt",
    "record_pre_llm_call",
    "route_command",
    "run_operation",
    "tool_args",
    "wait_route_certificate",
]
