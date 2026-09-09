"""Read-only projection of OcuClaw session activity and native attention.

This observer never registers a Hermes callback, changes a request, or resolves
one. The public clarify lookup remains authoritative (including answers from
another interface). Presentation receipts only retain the original deadline.
All state here is disposable; a gateway restart must not resurrect a question.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Dict


class SessionStatusObserver:
    def __init__(self, now: Callable[[], float] = time.time) -> None:
        self._now = now
        self._lock = threading.RLock()
        self._questions: OrderedDict[str, Dict[str, Any]] = OrderedDict()
        self._failures: OrderedDict[str, float] = OrderedDict()

    def observe_clarify(self, native_key: str, payload: Dict[str, Any]) -> None:
        with self._lock:
            self._questions[native_key] = dict(payload)
            self._questions.move_to_end(native_key)
            while len(self._questions) > 512:
                self._questions.popitem(last=False)

    def observe_activity(self, payload: Dict[str, Any]) -> None:
        key = payload.get("sessionKey")
        if not isinstance(key, str) or not key.startswith("hermes:"):
            return
        with self._lock:
            if payload.get("phase") == "error" and payload.get("code") not in ("cancelled", "interrupted"):
                self._failures[key] = self._now()
                self._failures.move_to_end(key)
            elif payload.get("phase") in ("start", "complete", "completed", "end", "error"):
                self._failures.pop(key, None)
            while len(self._failures) > 512:
                self._failures.popitem(last=False)

    def snapshot(
        self,
        native_key: str,
        public_key: str,
        *,
        working: bool,
        approvals: list,
        pending_lookup: Callable[..., Any],
    ) -> Dict[str, Any]:
        observed = int(self._now() * 1000)
        # No private registry access: this is Hermes' public, read-only lookup.
        pending = pending_lookup(native_key, include_choice_prompts=True)
        if pending is not None and pending.event.is_set():
            pending = None
        with self._lock:
            retained = self._questions.get(native_key)
            if pending is None:
                self._questions.pop(native_key, None)
            failure_at = self._failures.get(public_key)
            failed = failure_at is not None and self._now() - failure_at < 86400
            question = None
            if pending is not None and retained and retained.get("id") == pending.clarify_id:
                # Keep the initial absolute deadline across every refresh and
                # session switch. Never start another full timeout on replay.
                if retained.get("expiresAtMs", 0) > observed:
                    question = dict(retained)
                    question["awaitingText"] = bool(pending.awaiting_text)
        return {
            "agentStatus": {
                "working": bool(working and pending is None and not approvals),
                "needsYou": pending is not None or bool(approvals),
                "failed": bool(failed and not working),
                "observedAtMs": observed,
            },
            "attention": {
                "sessionKey": public_key,
                "runActive": bool(working),
                "clarify": question,
                "approvals": approvals,
            },
        }
