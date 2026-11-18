"""The pending setup approvals and the held pairing exchange (#6378).

Chat-first setup asks for two consents the agent must never give itself: the
private route (``apply_route``) and the four pairing words
(``confirm_pairing``). Each ask gets a **binding**, a hash of the operation, a
fresh nonce and the exact text the user is shown. The ``pre_tool_call`` hook
builds the host's approval card from the text stored here, never from what the
agent passes, and the tool refuses any binding this store did not mint or has
already used.

Everything lives in this process's memory, keyed by ``state_dir``, and is
never written to disk: a held pairing exchange carries its control secret.

The step machine (``next``) reads its step 6 and step 8 facts from here:
:func:`pending_route_approval`, :func:`pending_pairing`,
:func:`pairing_status` and :func:`approvals_bypassed`.

Pinned by ``tests/fixtures/setup-approval-contract.json`` (read by
``tests/test_setup_approval_store.py``); the OpenClaw twin is
``extensions/ocuclaw/src/setup/setup-approval-store.ts``.
"""
from __future__ import annotations

import hashlib
import itertools
import re
import secrets
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

# -- the contract --------------------------------------------------------------

CONTRACT_VERSION = 1
BINDING_PREFIX = "ocuclaw-setup-approval/1"
OPERATION_ROUTE = "apply_route"
OPERATION_PAIRING = "confirm_pairing"
OPERATION_CODE = "pair_with_phone_code"
OPERATIONS = {"route": OPERATION_ROUTE, "pairing": OPERATION_PAIRING, "code": OPERATION_CODE}
APPROVAL_OPERATIONS = (OPERATION_ROUTE, OPERATION_PAIRING)

NONCE_PATTERN = re.compile(r"^[0-9a-f]{32}$")
BINDING_PATTERN = re.compile(r"^[0-9a-f]{64}$")
RULE_KEY_FORMAT = "ocuclaw_setup:{operation}:{binding}"
RULE_KEY_PATTERN = re.compile(
    r"ocuclaw_setup:(" + "|".join(APPROVAL_OPERATIONS) + r"):([0-9a-f]{64})"
)

PAIRING_SHOWN_TEMPLATE = (
    "Check these words match your phone, in this order: {words}. "
    "Allow only if they match."
)
PAIRING_WORDS_JOIN = ", "
PAIRING_WORD_PATTERN = re.compile(r"^[a-z]+$")
PAIRING_WORD_COUNT = 4

CARDS: Dict[str, Dict[str, Any]] = {
    OPERATION_ROUTE: {
        "title": "Open a private route for your phone",
        "lines": [
            "OcuClaw will run this command on this machine:",
            "{shown}",
            "Only devices on your own tailnet can reach OcuClaw through it. It is "
            "never public and never uses Tailscale Funnel.",
            "Allow only if you want this.",
        ],
    },
    OPERATION_PAIRING: {
        "title": "Pair your phone",
        "lines": ["{shown}", "If they differ, deny."],
    },
}

CARD_TIMEOUT_SECONDS = 120
ROUTE_APPROVAL_TTL_SECONDS = 600
#: A Hermes approval that comes back faster than this was not pressed by a
#: person: "Skip all this session", ``approvals.mode: off`` or YOLO.
FAST_APPROVAL_MS = 1200
CHAT_ANSWERS = ("yes", "no")

RECEIPTS: Dict[str, Tuple[str, ...]] = {
    OPERATION_CODE: (
        "words_ready",
        "sent",
        "no_code",
        "pairing_code_typed",
        "malformed",
        "phone_codes_unavailable",
        "busy",
        "not_ready",
        "use_pair_phone",
        "failed",
    ),
    OPERATION_ROUTE: (
        "applied",
        "already",
        "declined",
        "unconfirmed",
        "stale_binding",
        "https_off",
        "foreign",
        "unreadable",
        "failed",
        "certificate_timeout",
        "certificate_refused",
    ),
    OPERATION_PAIRING: (
        "paired",
        "approved_waiting",
        "declined",
        "unconfirmed",
        "stale_binding",
        "expired",
        "failed",
    ),
}
RECEIPT_THEN = "call_next"
FORBIDDEN_IN_CARDS = ("relay credential", "relaytoken", "relay token")

PAIRING_STATUSES = (
    "none",
    "waiting_for_phone",
    "words_ready",
    "approved",
    "completed",
    "expired",
    "failed",
)

# -- pure helpers --------------------------------------------------------------


def pairing_shown_text(words: Sequence[Any]) -> str:
    """The pairing card's shown text. Exactly four lowercase words, or refused."""
    checked = _valid_words(words)
    if checked is None:
        raise ValueError("pairing words must be exactly four lowercase words")
    return PAIRING_SHOWN_TEMPLATE.format(words=PAIRING_WORDS_JOIN.join(checked))


def approval_binding(operation: str, nonce: str, shown: str) -> str:
    """``sha256_hex(prefix + "\\n" + operation + "\\n" + nonce + "\\n" + shown)``."""
    material = "\n".join((BINDING_PREFIX, str(operation), str(nonce), str(shown)))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def approval_rule_key(operation: str, binding: str) -> str:
    """The Hermes ``rule_key``: one request, so "Always allow" passes nothing later."""
    return RULE_KEY_FORMAT.format(operation=operation, binding=binding)


def approval_card(operation: str, shown: str) -> Dict[str, Any]:
    """``{title, lines}`` for the card, with ``{shown}`` substituted."""
    card = CARDS.get(operation)
    if card is None:
        raise ValueError(f"no approval card for {operation!r}")
    return {
        "title": card["title"],
        "lines": [line.replace("{shown}", str(shown)) for line in card["lines"]],
    }


def approval_card_message(operation: str, shown: str) -> str:
    """The Hermes card message: the title, then each line, joined by newlines."""
    card = approval_card(operation, shown)
    return "\n".join([card["title"], *card["lines"]])


def valid_binding(value: Any) -> bool:
    return isinstance(value, str) and BINDING_PATTERN.fullmatch(value) is not None


def _valid_words(words: Any) -> Optional[List[str]]:
    if not isinstance(words, (list, tuple)) or len(words) != PAIRING_WORD_COUNT:
        return None
    checked = []
    for word in words:
        if not isinstance(word, str) or PAIRING_WORD_PATTERN.fullmatch(word) is None:
            return None
        checked.append(word)
    return checked


def prompt_words(snapshot: Any) -> Optional[List[str]]:
    """The four safety words a pairing ``state`` reply carries, or ``None``."""
    if not isinstance(snapshot, Mapping):
        return None
    prompt = snapshot.get("prompt")
    if not isinstance(prompt, Mapping):
        return None
    return _valid_words(prompt.get("safetyPhrase"))


def snapshot_status(snapshot: Mapping[str, Any]) -> str:
    """Map one pairing ``state`` reply onto :data:`PAIRING_STATUSES`."""
    state = str(snapshot.get("state") or "")
    if state == "completed":
        return "completed"
    if state == "failed":
        failure = snapshot.get("failure")
        reason = failure.get("reason") if isinstance(failure, Mapping) else None
        return "expired" if reason == "expired" else "failed"
    if snapshot.get("approved") is True:
        return "approved"
    if prompt_words(snapshot) is not None:
        return "words_ready"
    return "waiting_for_phone"


TERMINAL_STATUSES = frozenset({"completed", "expired", "failed"})

# -- module state ----------------------------------------------------------------

#: ``control(op)`` posts ``{"v": 1, "op": op}`` for the held exchange (its
#: control secret already bound) and returns ``(http_status, body)``.
Control = Callable[[str], Tuple[int, Dict[str, Any]]]

_LOCK = threading.RLock()
_SEQ = itertools.count(1)
_MESSAGES_KEPT = 16
_MESSAGE_MAX_CHARS = 64
#: Swapped by tests; seconds, monotonic.
_monotonic: Callable[[], float] = time.monotonic


class _DirState:
    def __init__(self) -> None:
        self.approvals: Dict[str, Dict[str, Any]] = {}
        self.route_binding: Optional[str] = None
        self.pairing_binding: Optional[str] = None
        self.exchange: Optional[Dict[str, Any]] = None
        self.pairing_state = "none"
        self.bypassed = False
        self.receipts: Dict[str, Dict[str, Any]] = {}


_DIRS: Dict[str, _DirState] = {}
_MESSAGES: List[Dict[str, Any]] = []


def _dir(state_dir: Any) -> _DirState:
    key = str(state_dir or "")
    state = _DIRS.get(key)
    if state is None:
        state = _DIRS[key] = _DirState()
    return state


def _now() -> float:
    return float(_monotonic())


def monotonic_now() -> float:
    """The store's clock (seconds), the one ``hook_returned_at`` is read on."""
    return _now()


def _mint(state: _DirState, operation: str, shown: str, **extra: Any) -> Dict[str, Any]:
    nonce = secrets.token_hex(16)
    binding = approval_binding(operation, nonce, shown)
    entry = {
        "operation": operation,
        "shown": shown,
        "binding": binding,
        "minted_at": _now(),
        "seq": next(_SEQ),
        "consumed": False,
        "hook_returned_at": None,
        "hook_session_id": None,
        **extra,
    }
    state.approvals[binding] = entry
    return entry


def _drop(state: _DirState, binding: Optional[str]) -> None:
    if binding:
        state.approvals.pop(binding, None)


def _public(entry: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        key: (list(value) if isinstance(value, list) else value)
        for key, value in entry.items()
    }


# -- the route -------------------------------------------------------------------


def pending_route_approval(state_dir: Any, command: str) -> Dict[str, str]:
    """``{command, binding}`` for the route card.

    The same binding comes back while the command is unchanged, unused and
    younger than :data:`ROUTE_APPROVAL_TTL_SECONDS`; otherwise a fresh nonce
    is minted and the earlier binding stops being live.
    """
    command = str(command or "")
    if not command:
        raise ValueError("the route command is empty")
    with _LOCK:
        state = _dir(state_dir)
        entry = state.approvals.get(state.route_binding or "")
        if (
            entry is None
            or entry["consumed"]
            or entry["shown"] != command
            or _now() - entry["minted_at"] >= ROUTE_APPROVAL_TTL_SECONDS
        ):
            _drop(state, state.route_binding)
            entry = _mint(state, OPERATION_ROUTE, command)
            state.route_binding = entry["binding"]
        return {"command": command, "binding": entry["binding"]}


# -- the pairing exchange -----------------------------------------------------------


def hold_pairing(
    state_dir: Any, *, exchange_id: str, control_secret: str, control: Control
) -> None:
    """Hold a fresh exchange. The caller has already cancelled any earlier one."""
    with _LOCK:
        state = _dir(state_dir)
        _drop(state, state.pairing_binding)
        state.pairing_binding = None
        state.exchange = {
            "exchange_id": str(exchange_id or ""),
            "control_secret": str(control_secret or ""),
            "control": control,
        }
        state.pairing_state = "waiting_for_phone"


def held_pairing(state_dir: Any) -> Optional[Dict[str, Any]]:
    """The held exchange ``{exchange_id, control_secret, control}``, or ``None``."""
    with _LOCK:
        exchange = _dir(state_dir).exchange
        return dict(exchange) if exchange else None


def _release_pairing(state: _DirState, status: str) -> None:
    _drop(state, state.pairing_binding)
    state.pairing_binding = None
    state.exchange = None
    state.pairing_state = status


def cancel_held_pairing(state_dir: Any, *, status: str = "none") -> bool:
    """Cancel the held exchange at the relay (best effort) and forget it."""
    with _LOCK:
        state = _dir(state_dir)
        exchange = state.exchange
        _release_pairing(state, status)
    if not exchange:
        return False
    try:
        exchange["control"]("cancel")
    except Exception:  # noqa: BLE001 - the exchange expires at the host anyway
        pass
    return True


def deny_held_pairing(state_dir: Any) -> Optional[Tuple[int, Dict[str, Any]]]:
    """Refuse the held exchange's words at the relay, then forget it."""
    with _LOCK:
        state = _dir(state_dir)
        exchange = state.exchange
        _release_pairing(state, "failed")
    if not exchange:
        return None
    try:
        return exchange["control"]("deny")
    except Exception:  # noqa: BLE001 - the exchange expires at the host anyway
        return None


def note_pairing_snapshot(state_dir: Any, snapshot: Mapping[str, Any]) -> str:
    """Record what one ``state``/decision reply said; release a terminal one."""
    status = snapshot_status(snapshot)
    with _LOCK:
        state = _dir(state_dir)
        if status in TERMINAL_STATUSES:
            _release_pairing(state, status)
        else:
            state.pairing_state = status
    return status


def ask_pairing_state(state_dir: Any) -> Optional[Dict[str, Any]]:
    """Ask the held exchange's ``state`` once. ``None`` when nothing answers.

    A terminal reply releases the exchange. A 401 means the relay already
    retired this exchange's secret, which only happens once it ended.
    """
    exchange = held_pairing(state_dir)
    if not exchange:
        return None
    try:
        status, body = exchange["control"]("state")
    except Exception:  # noqa: BLE001 - a transient miss keeps the exchange held
        return None
    if status == 401:
        with _LOCK:
            state = _dir(state_dir)
            if state.exchange and state.exchange.get("exchange_id") == exchange["exchange_id"]:
                _release_pairing(state, "failed")
        return None
    if status != 200 or not isinstance(body, Mapping):
        return None
    note_pairing_snapshot(state_dir, body)
    return dict(body)


def pending_pairing(state_dir: Any) -> Optional[Dict[str, Any]]:
    """``{words, binding}`` once the phone's four words have arrived, else ``None``.

    Asks the held exchange's ``state`` once. The binding stays the same while
    the words and the exchange are unchanged and it is unused.
    """
    exchange = held_pairing(state_dir)
    if not exchange:
        return None
    snapshot = ask_pairing_state(state_dir)
    if snapshot is None:
        return None
    if snapshot_status(snapshot) != "words_ready":
        return None
    words = prompt_words(snapshot)
    if words is None:
        return None
    shown = pairing_shown_text(words)
    with _LOCK:
        state = _dir(state_dir)
        if not state.exchange or state.exchange.get("exchange_id") != exchange["exchange_id"]:
            return None
        entry = state.approvals.get(state.pairing_binding or "")
        if (
            entry is not None
            and entry["shown"] == shown
            and entry.get("exchange_id") == exchange["exchange_id"]
        ):
            if entry["consumed"]:
                return None
        else:
            _drop(state, state.pairing_binding)
            entry = _mint(
                state,
                OPERATION_PAIRING,
                shown,
                words=list(words),
                exchange_id=exchange["exchange_id"],
            )
            state.pairing_binding = entry["binding"]
        return {"words": list(words), "binding": entry["binding"]}


def pairing_status(state_dir: Any) -> Dict[str, str]:
    """``{state}`` from the last known exchange state. No I/O."""
    with _LOCK:
        return {"state": _dir(state_dir).pairing_state}


# -- approvals: lookup, consume, the hook's clock ------------------------------------


def lookup_approval(
    state_dir: Any, binding: Any, operation: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """The live (minted, unused) entry for ``binding``, or ``None``."""
    if not valid_binding(binding):
        return None
    with _LOCK:
        entry = _dir(state_dir).approvals.get(binding)
        if entry is None or entry["consumed"]:
            return None
        if operation is not None and entry["operation"] != operation:
            return None
        return _public(entry)


def consume_approval(state_dir: Any, binding: Any, operation: Optional[str] = None) -> bool:
    """Mark the entry used. A second consume (or a lookup) then finds nothing."""
    if not valid_binding(binding):
        return False
    with _LOCK:
        entry = _dir(state_dir).approvals.get(binding)
        if entry is None or entry["consumed"]:
            return False
        if operation is not None and entry["operation"] != operation:
            return False
        entry["consumed"] = True
        return True


def find_approval_state_dir(binding: Any) -> Optional[str]:
    """Which ``state_dir`` minted ``binding`` (bindings are unique per nonce)."""
    if not valid_binding(binding):
        return None
    with _LOCK:
        for key, state in _DIRS.items():
            if binding in state.approvals:
                return key
    return None


def record_hook_returned(
    state_dir: Any, binding: Any, *, session_id: Optional[str] = None
) -> bool:
    """Note when the ``pre_tool_call`` hook handed Hermes this binding's card."""
    if not valid_binding(binding):
        return False
    with _LOCK:
        entry = _dir(state_dir).approvals.get(binding)
        if entry is None:
            return False
        entry["hook_returned_at"] = _now()
        entry["hook_session_id"] = str(session_id or "") or None
        return True


def approvals_bypassed(state_dir: Any) -> bool:
    """True once this process saw an approval come back too fast (Hermes)."""
    with _LOCK:
        return _dir(state_dir).bypassed


def note_setup_receipt(state_dir: Any, receipt: Any) -> None:
    """Note the receipt an operation just returned, newest wins.

    ``next`` re-reads facts and never sees receipts, so this is how it tells a
    failed route or pairing from one that never ran. In memory only.
    """
    if not isinstance(receipt, Mapping) or receipt.get("operation") not in OPERATIONS.values():
        return
    detail = receipt.get("detail")
    with _LOCK:
        _dir(state_dir).receipts[str(receipt["operation"])] = {
            "status": receipt.get("status"),
            "detail": detail if isinstance(detail, str) else None,
            "at": int(time.time() * 1000),
        }


def last_setup_receipt(state_dir: Any, operation: Any) -> Optional[Dict[str, Any]]:
    """The last receipt ``operation`` returned here: ``{status, detail, at}`` or ``None``."""
    with _LOCK:
        state = _DIRS.get(str(state_dir or ""))
        last = state.receipts.get(str(operation)) if state is not None else None
        return dict(last) if last else None


def mark_approvals_bypassed(state_dir: Any) -> None:
    with _LOCK:
        _dir(state_dir).bypassed = True


# -- the user's own messages (chat yes) -------------------------------------------------


def record_user_message(text: Any, *, session_id: Optional[str] = None) -> None:
    """Remember one user turn's text, bounded, for the chat yes check."""
    if not isinstance(text, str):
        return
    stripped = text.strip()
    with _LOCK:
        _MESSAGES.append(
            {
                "seq": next(_SEQ),
                "at": _now(),
                # A message longer than any answer can never read as one.
                "text": stripped if len(stripped) <= _MESSAGE_MAX_CHARS else None,
                "session_id": str(session_id or "") or None,
            }
        )
        del _MESSAGES[:-_MESSAGES_KEPT]


def latest_user_message_after(
    seq: int, *, session_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """The newest user message recorded after ``seq``, or ``None``.

    With a ``session_id``, a message known to come from another session does
    not count.
    """
    with _LOCK:
        for message in reversed(_MESSAGES):
            if message["seq"] <= seq:
                return None
            if session_id and message["session_id"] and message["session_id"] != session_id:
                continue
            return dict(message)
    return None


def reset_for_tests() -> None:
    """Forget everything. Tests only."""
    global _monotonic
    with _LOCK:
        _DIRS.clear()
        _MESSAGES.clear()
    _monotonic = time.monotonic


__all__ = [
    "APPROVAL_OPERATIONS",
    "BINDING_PREFIX",
    "CARDS",
    "CARD_TIMEOUT_SECONDS",
    "FAST_APPROVAL_MS",
    "FORBIDDEN_IN_CARDS",
    "OPERATION_CODE",
    "OPERATION_PAIRING",
    "OPERATION_ROUTE",
    "PAIRING_STATUSES",
    "RECEIPTS",
    "RECEIPT_THEN",
    "ROUTE_APPROVAL_TTL_SECONDS",
    "approval_binding",
    "approval_card",
    "approval_card_message",
    "approval_rule_key",
    "approvals_bypassed",
    "ask_pairing_state",
    "cancel_held_pairing",
    "consume_approval",
    "deny_held_pairing",
    "find_approval_state_dir",
    "held_pairing",
    "hold_pairing",
    "latest_user_message_after",
    "lookup_approval",
    "mark_approvals_bypassed",
    "monotonic_now",
    "note_pairing_snapshot",
    "pairing_shown_text",
    "pairing_status",
    "pending_pairing",
    "pending_route_approval",
    "prompt_words",
    "record_hook_returned",
    "record_user_message",
    "reset_for_tests",
    "snapshot_status",
]
