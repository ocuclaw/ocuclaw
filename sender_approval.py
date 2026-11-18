"""Approve the glasses in Hermes' own sender list when pairing completes.

OcuClaw's pairing already asks the owner, at the computer, whether these
glasses may connect: the phone scans the QR, both screens show the same four
words, and the owner approves. Hermes 0.22 asks the same owner a second
question through its own sender pairing (a code sent to the glasses, then
``hermes pairing approve``) whenever an env allowlist such as
``GATEWAY_ALLOWED_USERS`` leaves the wearer out.

SPEC #2939, as amended 2026-10-15 ("one approval"): the owner's approve in
OcuClaw's pairing answers both. When an approved exchange completes, the
gateway records the one wearer id in Hermes' pairing store, through Hermes'
own public store methods. Hermes checks that store before the env
allowlists, so the wearer is admitted even under an allowlist set before or
after pairing. The record is visible on Desktop's Messaging page and
``hermes pairing revoke ocuclaw ocuclaw-wearer`` removes it; uninstall
removes the platform's store files.

Nothing is written without that approve, and nothing reaches ``.env`` or
``config.yaml`` from here. Hermes itself mirrors the id into
``OCUCLAW_ALLOWED_USERS`` only when the owner already set that list.

``PairingStore`` and the methods used here (``is_approved``,
``list_pending``, ``approve_request``, ``generate_code``, ``approve_code``)
are unchanged from the 0.21.1 floor to 0.22.1. A Hermes without them
leaves today's behaviour in place: the in-memory wearer grant, plus doctor.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from .health import OCUCLAW_WEARER_USER_ID

logger = logging.getLogger(__name__)

PLATFORM = "ocuclaw"
#: The name Hermes shows beside the approved sender (Messaging page, CLI list).
WEARER_DISPLAY_NAME = "OcuClaw glasses"

#: Outcomes, secret-free, for logs and tests.
OUTCOME_ALREADY = "already_approved"
OUTCOME_APPROVED = "approved"
OUTCOME_UNAVAILABLE = "store_unavailable"
OUTCOME_REFUSED = "store_refused"


def _default_store() -> Any:
    # Deferred: the bundle stays importable without Hermes on the path. The
    # runner's launch store is ``PairingStore()`` too, so this resolves the
    # same directory the gateway reads for the default profile.
    from gateway.pairing import PairingStore

    return PairingStore()


def record_wearer_sender_approval(
    store_factory: Optional[Callable[[], Any]] = None,
) -> str:
    """Record the wearer as an approved sender; idempotent.

    Prefers a pending request a refused glasses message already left, so a
    code Hermes minted is consumed rather than left to expire. Otherwise it
    mints one and approves it in the same breath; the code never leaves this
    function. Never raises: a store fault must not undo a completed pairing.
    """

    try:
        store = (store_factory or _default_store)()
    except ImportError:
        return OUTCOME_UNAVAILABLE
    except Exception:  # noqa: BLE001 - a store fault never breaks pairing
        logger.warning("[ocuclaw] Hermes pairing store unavailable", exc_info=True)
        return OUTCOME_UNAVAILABLE
    try:
        if store.is_approved(PLATFORM, OCUCLAW_WEARER_USER_ID):
            return OUTCOME_ALREADY
        for row in store.list_pending(PLATFORM) or ():
            if not isinstance(row, dict):
                continue
            request_id = row.get("request_id")
            if row.get("user_id") == OCUCLAW_WEARER_USER_ID and request_id:
                if store.approve_request(PLATFORM, request_id):
                    return OUTCOME_APPROVED
        code = store.generate_code(PLATFORM, OCUCLAW_WEARER_USER_ID, WEARER_DISPLAY_NAME)
        if code and store.approve_code(PLATFORM, code):
            return OUTCOME_APPROVED
    except Exception:  # noqa: BLE001 - a store fault never breaks pairing
        logger.warning("[ocuclaw] Hermes sender approval failed", exc_info=True)
        return OUTCOME_UNAVAILABLE
    # Rate limited or locked out: Hermes refused to mint. Doctor still names
    # the allowlist, and the next pairing tries again.
    logger.warning("[ocuclaw] Hermes refused to record the glasses as a sender")
    return OUTCOME_REFUSED


#: Hermes' pairing store files for this platform, relative to HERMES_HOME,
#: in the current layout and the legacy one. The whole per-platform file is
#: OcuClaw's: no other platform writes ``ocuclaw-*.json``.
PAIRING_STORE_FILES = (
    "platforms/pairing/ocuclaw-approved.json",
    "platforms/pairing/ocuclaw-pending.json",
    "pairing/ocuclaw-approved.json",
    "pairing/ocuclaw-pending.json",
)
