"""The guided-setup hint the phone shows on the Hermes lane (#3010; row #3007).

**The problem this exists to kill.** Guided setup asks the wearer to send one
message from the phone and then look at the glasses. The host terminal cannot
print that ask while the setup tool is still running — assistant text that
precedes a tool call is re-tagged commentary and withheld from the chat
channel — so the wearer sat in front of a spinner with no instruction while
``wait_for_phone_turn_candidate()`` blocked for up to 165 seconds.

**Why this is a receipt and not a direct call.** The setup tool runs in the
*host* conversation: a CLI, TUI or Desktop process, never the gateway. Only the
gateway owns the OcuClaw platform adapter, its control link and the relay the
phone is connected to — in the host process ``_ADAPTERS`` is empty and there is
nothing to push to. That split is the same one the First-Run Proof journey
already lives with, and it already answers it the same way: the phone-origin
turn is handed from gateway to host as a small receipt on disk. This is that
hop in the other direction. The host writes one receipt when the wait opens and
removes it when the wait closes; the gateway's adapter watches it on the
first-run loop it already runs and pushes the phase over the control link,
where relay-core turns it into the SAME backend-agnostic ``setupHint`` status
field the OpenClaw lane fills from its durable first-use record.

**Only the phase reaches the phone.** The receipt is profile-scoped so a second
profile's hint can never be read as this one's, but what crosses the link and
the wire is one closed-vocabulary phase string: no session key, no binding, no
attempt id, no fingerprint. The phone needs a sentence, not an identity.

**No stale row can survive.** Three independent guards, because the host
process holding the wait can die without running anything:

* the wait's own ``finally`` removes the receipt on every ending — received,
  timeout, unreadable receipt, or an exception straight through it;
* the receipt carries an ``expiresAt`` just past the wait's own deadline, so a
  host that is killed mid-wait leaves something that reads as no hint within
  seconds of when the wait would have ended anyway;
* the watcher derives the phase from that live read every time, so a restarted
  gateway, adapter or runtime child starts from what is true now, never from a
  remembered phase.
"""

from __future__ import annotations

import contextlib
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, Mapping, Optional

from .receipts import (
    ReceiptUnavailableError,
    fingerprint_home,
    resolve_receipt_home,
    state_dir,
    write_json_receipt,
)

logger = logging.getLogger(__name__)

#: Host → gateway → child. Params ``{"phase": <phase or None>}``. The child
#: answers with the phase it now holds; that answer is a receipt, not a fact
#: anyone stores.
SETUP_HINT_METHOD = "setup.hint"

#: The one phase this lane carries. Anything else clears the hint, so a future
#: caller cannot widen the wearer-facing vocabulary by writing to this seam.
SETUP_HINT_AWAITING_FIRST_REPLY = "awaiting-first-reply"

#: The control-link push is bounded hard. A wedged link must not be what keeps
#: the gateway's first-run watcher from coming round again.
SETUP_HINT_TIMEOUT_S = 5.0

SETUP_HINT_FILENAME = "ocuclaw.setup-hint.json"
SETUP_HINT_SCHEMA_VERSION = 1

#: Comfortably past ``PHONE_ORIGIN_WAIT_SECONDS`` (165 s), so an ordinary wait
#: never expires under its own hint, and a host killed mid-wait leaves one that
#: reads as absent within seconds of when that wait would have ended.
SETUP_HINT_TTL_SECONDS = 180.0

_HINT_KEYS = frozenset({"schemaVersion", "phase", "profileFingerprint", "expiresAt"})


def _resolved_home(home: Optional[Path]) -> Optional[Path]:
    """This profile's home, or ``None``.

    Resolve ONCE and carry the answer. Handing ``None`` down to the receipt
    helpers would let them resolve again, so a caller (or a test) that means
    "there is no profile here" would still get a real path back.
    """

    return home if home is not None else resolve_receipt_home()


def setup_hint_path(home: Optional[Path] = None) -> Optional[Path]:
    resolved = _resolved_home(home)
    directory = None if resolved is None else state_dir(resolved)
    return None if directory is None else directory / SETUP_HINT_FILENAME


def setup_hint_params(phase: Optional[str]) -> Dict[str, Any]:
    """The exact, identifier-free frame body for ``phase``.

    Normalising here rather than at the call site means the only value that can
    ever reach a phone is the one phase the wearer-facing copy is written for.
    """

    return {
        "phase": (
            SETUP_HINT_AWAITING_FIRST_REPLY
            if phase == SETUP_HINT_AWAITING_FIRST_REPLY
            else None
        )
    }


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def open_hint(
    *, home: Optional[Path] = None, now: Optional[datetime] = None
) -> bool:
    """Publish "the wearer owes us a phone message" for this profile."""

    resolved = _resolved_home(home)
    path = None if resolved is None else setup_hint_path(resolved)
    fingerprint = fingerprint_home(resolved)
    if path is None or fingerprint is None:
        return False
    expires_at = (now or _utc_now()) + timedelta(seconds=SETUP_HINT_TTL_SECONDS)
    try:
        write_json_receipt(
            path,
            {
                "schemaVersion": SETUP_HINT_SCHEMA_VERSION,
                "phase": SETUP_HINT_AWAITING_FIRST_REPLY,
                "profileFingerprint": fingerprint,
                "expiresAt": expires_at.isoformat(),
            },
        )
    except (ReceiptUnavailableError, OSError):
        return False
    return True


def close_hint(*, home: Optional[Path] = None) -> bool:
    """Take the row away. Absent is the same success as removed."""

    resolved = _resolved_home(home)
    path = None if resolved is None else setup_hint_path(resolved)
    if path is None:
        return False
    try:
        path.unlink()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


def read_hint_phase(
    *, home: Optional[Path] = None, now: Optional[datetime] = None
) -> Optional[str]:
    """The phase this profile is owed right now, or ``None``.

    Every disagreement reads as "no hint": a missing, unreadable, malformed,
    expired or foreign-profile receipt is never a row on somebody's phone.
    """

    resolved = _resolved_home(home)
    path = None if resolved is None else setup_hint_path(resolved)
    fingerprint = fingerprint_home(resolved)
    if path is None or fingerprint is None:
        return None
    try:
        record: Any = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, ValueError):
        return None
    if not isinstance(record, Mapping) or set(record) != _HINT_KEYS:
        return None
    if record.get("schemaVersion") != SETUP_HINT_SCHEMA_VERSION:
        return None
    if record.get("profileFingerprint") != fingerprint:
        return None
    expires_at = _parse_time(record.get("expiresAt"))
    if expires_at is None or (now or _utc_now()) >= expires_at:
        return None
    return (
        SETUP_HINT_AWAITING_FIRST_REPLY
        if record.get("phase") == SETUP_HINT_AWAITING_FIRST_REPLY
        else None
    )


async def push_hint_edge(
    link: Any,
    phase: Optional[str],
    last_phase: Optional[str],
    *,
    timeout_s: float = SETUP_HINT_TIMEOUT_S,
) -> Optional[str]:
    """Tell a runtime child about a CHANGE of phase, and nothing else.

    Returns the phase the child now holds, which the caller keeps as its edge
    memory. A raise means the child was not told: the caller keeps the older
    memory so the next pass retries rather than treating a dropped frame as
    delivered.
    """

    if link is None or phase == last_phase:
        return last_phase
    await link.request(SETUP_HINT_METHOD, setup_hint_params(phase), timeout_s=timeout_s)
    return phase


@contextlib.contextmanager
def awaiting_first_reply(
    *, home: Optional[Path] = None, now: Optional[datetime] = None
) -> Iterator[Callable[[], None]]:
    """Hold the phone hint for exactly the duration of the phone-turn wait.

    ``finally`` is the whole point: a timeout, an unreadable receipt or an
    exception inside the wait all leave the wearer with nothing left to do, so
    all three must take the row away.

    Yields a refresh callable (#3523): the hint's TTL covers one wait, so the
    quiet re-wait re-publishes it, in place, before it starts.
    """

    _quietly(lambda: open_hint(home=home, now=now))
    try:
        yield lambda: _quietly(lambda: open_hint(home=home))
    finally:
        _quietly(lambda: close_hint(home=home))


def _quietly(action: Any) -> None:
    """Run one hint side effect; a cosmetic row must never break setup."""

    try:
        action()
    except Exception:  # noqa: BLE001 — a hint must never fail the setup turn
        logger.debug("[ocuclaw] setup hint update failed", exc_info=True)


__all__ = [
    "SETUP_HINT_AWAITING_FIRST_REPLY",
    "SETUP_HINT_FILENAME",
    "SETUP_HINT_METHOD",
    "SETUP_HINT_SCHEMA_VERSION",
    "SETUP_HINT_TIMEOUT_S",
    "SETUP_HINT_TTL_SECONDS",
    "awaiting_first_reply",
    "close_hint",
    "open_hint",
    "push_hint_edge",
    "read_hint_phase",
    "setup_hint_params",
    "setup_hint_path",
]
