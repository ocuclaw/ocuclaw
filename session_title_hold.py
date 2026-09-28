"""The phone's session-name toggle, applied to Hermes's own titler.

Hermes titles every session itself: an instant ``derived`` title from the
first message, then a model call that upgrades it to ``llm``. The phone's
"AI session names" toggle (``neuralSessionNamesEnabled``) should switch that
model call off for OcuClaw chats only, without touching the profile config
(which would change every surface) and without an upstream change.

The lever is Hermes's title provenance (``hermes_state``: derived < llm <
user). Our ``pre_llm_call`` hook runs after Hermes creates the session row and
before it titles the turn. So:

- Toggle OFF: write Hermes's own instant title (``derive_title``) at ``llm``
  provenance. Hermes's instant write then loses on rank and its upgrade thread
  exits at ``_has_upgraded_title``: no model call. We remember the session.
- Toggle ON: for a session WE held, whose title is still exactly the one we
  wrote at ``llm``, put the provenance back to ``derived``. Hermes upgrades it
  inside its own window (turns 1-3 on 0.21.4+, turn 1 on 0.21.1-0.21.3).

A ``user`` title (a rename) is never touched. Any failure does nothing, which
is Hermes's default: it titles as usual. The ledger is in memory and small:
the unlock only matters for a few turns, and a restart that forgets a session
leaves it with the first-words title the wearer asked for.

Contract pinned per Hermes tag in tests/test_session_title_contract.py.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from typing import Any, Optional

logger = logging.getLogger(__name__)

SOURCE_DERIVED = "derived"
SOURCE_LLM = "llm"
LEDGER_LIMIT = 512

HELD = "held"
RELEASED = "released"


def turn_user_text(kwargs: dict) -> str:
    """The turn's user text, the way Hermes's titler reads it.

    Hermes titles from the last ``role="user"`` entry of the turn's messages
    (``_maybe_title_session_at_turn_start``); the hook hands those over as
    ``conversation_history``. ``user_message`` is the fallback.
    """
    from agent.message_content import flatten_message_text

    history = kwargs.get("conversation_history")
    if isinstance(history, list):
        for message in reversed(history):
            if isinstance(message, dict) and message.get("role") == "user":
                return flatten_message_text(message.get("content")).strip()
    message = kwargs.get("user_message")
    if isinstance(message, str):
        return message.strip()
    return flatten_message_text(message).strip() if message is not None else ""


class SessionTitleHold:
    """Hold or release Hermes titling for OcuClaw sessions (see module doc)."""

    def __init__(self, limit: int = LEDGER_LIMIT) -> None:
        self._limit = max(1, int(limit))
        self._lock = threading.Lock()
        # session_id -> the exact title we wrote at llm provenance.
        self._held: "OrderedDict[str, str]" = OrderedDict()

    def held_title(self, session_id: str) -> Optional[str]:
        with self._lock:
            return self._held.get(session_id)

    def _remember(self, session_id: str, title: str) -> None:
        with self._lock:
            self._held[session_id] = title
            self._held.move_to_end(session_id)
            while len(self._held) > self._limit:
                self._held.popitem(last=False)

    def _forget(self, session_id: str) -> None:
        with self._lock:
            self._held.pop(session_id, None)

    def apply(self, db: Any, session_id: str, enabled: bool, user_text: str) -> Optional[str]:
        """Apply the toggle to one session. Returns HELD, RELEASED or None.

        ``db`` is Hermes's SessionDB (the shared writer). Never raises.
        """
        if not session_id:
            return None
        try:
            if enabled:
                return self._release(db, session_id)
            return self._hold(db, session_id, user_text)
        except Exception:  # noqa: BLE001 — fail open: Hermes titles as usual
            logger.debug("[ocuclaw] session title hold skipped", exc_info=True)
            return None

    def _hold(self, db: Any, session_id: str, user_text: str) -> Optional[str]:
        title = db.get_session_title(session_id)
        source = db.get_session_title_source(session_id)
        if title is not None:
            # A derived title is Hermes's own first-words slice: keep the text,
            # lift it to llm. Anything else (llm, user, or a NULL-provenance
            # legacy row, which Hermes ranks as user) is not ours to touch.
            if source != SOURCE_DERIVED:
                return None
            candidate = title
        else:
            from agent.title_generator import derive_title, is_titleable_user_message

            if not is_titleable_user_message(user_text):
                return None  # Hermes would not title this turn either.
            candidate = derive_title(user_text)
            if not candidate:
                return None
        written = self._write_llm(db, session_id, candidate)
        if written is None:
            return None
        self._remember(session_id, written)
        return HELD

    @staticmethod
    def _write_llm(db: Any, session_id: str, title: str) -> Optional[str]:
        # set_auto_title is Hermes's compare-and-swap precedence write: it never
        # beats an equal or higher title, so a racing rename always wins.
        try:
            return title if db.set_auto_title(session_id, title, source=SOURCE_LLM) else None
        except ValueError:
            # Unique-title collision: the same "#N" rename Hermes applies.
            next_title = db.get_next_title_in_lineage(title)
            if not next_title or next_title == title:
                return None
            return next_title if db.set_auto_title(session_id, next_title, source=SOURCE_LLM) else None

    def _release(self, db: Any, session_id: str) -> Optional[str]:
        held = self.held_title(session_id)
        if held is None:
            return None
        self._forget(session_id)
        if db.get_session_title_source(session_id) != SOURCE_LLM:
            return None
        if db.get_session_title(session_id) != held:
            return None  # Hermes or the wearer changed it since; not ours.
        if not db.set_session_title_source(session_id, SOURCE_DERIVED):
            return None
        # set_session_title_source has no compare step. If a rename landed
        # between the read and the write, it now carries "derived"; put it
        # back to user so Hermes can never retitle over it.
        if db.get_session_title(session_id) != held:
            db.set_session_title_source(session_id, "user")
            return None
        return RELEASED
