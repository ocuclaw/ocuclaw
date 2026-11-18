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
        self._face_phases: OrderedDict[str, Dict[str, Any]] = OrderedDict()
        self._retired_face_runs: OrderedDict[tuple[str, str], None] = OrderedDict()

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
            run_id = payload.get("runId")
            if not isinstance(run_id, str) or not run_id:
                return
            if (key, run_id) in self._retired_face_runs:
                return
            current = self._face_phases.get(key)
            phase = payload.get("phase")
            origin = payload.get("origin")
            if origin == "lifecycle":
                if phase == "start":
                    # Starting/queuing a turn is not evidence of reasoning.
                    if current is None or current["runId"] != run_id:
                        if current is not None:
                            self._retire_face_run(key, current["runId"])
                        self._remember_face_phase(key, run_id, None)
                elif phase in ("end", "complete", "completed", "error"):
                    self._retire_face_run(key, run_id)
                    if current is not None and current["runId"] == run_id:
                        current.update(phase=None, terminal=True)
                return
            if current is not None and (current["runId"] != run_id or current.get("terminal")):
                return  # A late event cannot relabel a successor turn.
            face_phase = None
            if phase in ("end", "complete", "completed", "error"):
                face_phase = None
            elif origin == "thinking" or payload.get("category") == "thinking":
                face_phase = "thinking"
            elif origin == "tool":
                face_phase = "working" if payload.get("toolPhase") == "start" else None
            else:
                return
            self._remember_face_phase(key, run_id, face_phase)

    def _retire_face_run(self, key: str, run_id: str) -> None:
        # Keep delayed lifecycle starts from replacing a successor's phase.
        # The independent bound also covers terminal events without a start.
        self._retired_face_runs[(key, run_id)] = None
        self._retired_face_runs.move_to_end((key, run_id))
        while len(self._retired_face_runs) > 2048:
            self._retired_face_runs.popitem(last=False)

    def _remember_face_phase(self, key: str, run_id: str, phase: Any) -> None:
        previous = self._face_phases.get(key)
        self._face_phases[key] = {
            "runId": run_id, "phase": phase, "observedAtMs": int(self._now() * 1000),
            **({"thinkingSeq": previous["thinkingSeq"]} if previous is not None
               and previous["runId"] == run_id and "thinkingSeq" in previous else {}),
        }
        self._face_phases.move_to_end(key)
        while len(self._face_phases) > 512:
            self._face_phases.popitem(last=False)

    def observe_thinking(self, payload: Dict[str, Any]) -> None:
        if (payload.get("source") not in ("hermes.on_stream_delta", "hermes.post_api_request")
                or payload.get("phase") != "update" or payload.get("presentation") == "progress_note"
                or not (payload.get("delta") or payload.get("text"))):
            return
        key, run_id, seq = payload.get("sessionKey"), payload.get("runId"), payload.get("seq")
        if not isinstance(key, str) or not isinstance(run_id, str):
            return
        with self._lock:
            current = self._face_phases.get(key)
            if (current is not None and current["runId"] == run_id and isinstance(seq, int)
                    and seq <= current.get("thinkingSeq", -1)):
                return
            self.observe_activity({**payload, "origin": "thinking"})
            current = self._face_phases.get(key)
            if (current is not None and current["runId"] == run_id
                    and current.get("phase") == "thinking" and isinstance(seq, int)):
                current["thinkingSeq"] = seq

    def observe_streaming(self, payload: Dict[str, Any]) -> None:
        key, run_id = payload.get("sessionKey"), payload.get("runId")
        if (not isinstance(key, str) or not key.startswith("hermes:")
                or not isinstance(run_id, str) or not run_id or not payload.get("text")):
            return
        with self._lock:
            if (key, run_id) in self._retired_face_runs:
                return
            current = self._face_phases.get(key)
            if current is None or (current["runId"] == run_id and not current.get("terminal")):
                self._remember_face_phase(key, run_id, "working")

    def snapshot(
        self,
        native_key: str,
        public_key: str,
        *,
        working: bool,
        approvals: list,
        pending_lookup: Callable[..., Any],
        run_id: Any = None,
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
            face = self._face_phases.get(public_key)
            face_status = {}
            if (working and pending is None and not approvals and face is not None
                    and run_id is not None and face["runId"] == run_id
                    and face.get("phase") in ("thinking", "working")
                    and 0 <= observed - face["observedAtMs"] <= 15000):
                face_status = {"facePhase": face["phase"], "facePhaseObservedAtMs": face["observedAtMs"]}
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
                **face_status,
            },
            "attention": {
                "sessionKey": public_key,
                "runActive": bool(working),
                "clarify": question,
                "approvals": approvals,
            },
        }
