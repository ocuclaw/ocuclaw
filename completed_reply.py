"""Project a proven native reasoning wrapper out of a completed chat reply.

Hermes' public ``post_llm_call`` observer supplies the final response and its
current-turn history before the gateway prepends ``last_reasoning``. That
convenience field can also contain authored commentary. OcuClaw already routes
those channels separately; only an exact wrapper of this observed response may
be removed here. Unobserved, changed, or ambiguous text is preserved.

An enabled runtime footer may follow that exact response. Its supported native
renderings are checked in full and preserved byte-for-byte. Context percentages
are formatter-valid values, not proof of a particular token measurement.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple


PROOF_TTL_SECONDS = 60.0
MAX_PROOFS = 64
MAX_PROOF_CHARS = 1_000_000
_FOOTER_FIELDS = frozenset({"model", "context_pct", "cwd"})
_MAX_FOOTER_CHARS = 8192


@dataclass(frozen=True)
class _FooterContext:
    model: str
    fields: Tuple[str, ...]
    cwd: str


def _native_footer_context(model: Any) -> Optional[_FooterContext]:
    """Read the active profile and terminal scope through native public APIs.

    The observer and delivery thread must agree. Unsupported fields are refused:
    the public observer does not supply native latency or served-model metadata.
    """
    if not isinstance(model, str) or not model:
        return None
    try:
        from gateway.runtime_footer import resolve_footer_config
        from hermes_cli.config import load_config_readonly
        from tools.terminal_scope import terminal_env

        config = resolve_footer_config(load_config_readonly(), "ocuclaw")
        fields = tuple(config.get("fields") or ())
        if not config.get("enabled") or not 0 < len(fields) <= 16 or not all(
            field in _FOOTER_FIELDS for field in fields
        ):
            return None
        cwd = terminal_env("TERMINAL_CWD", "")
        return _FooterContext(model, fields, cwd) if len(model) + len(cwd) <= _MAX_FOOTER_CHARS else None
    except Exception:
        # A refused profile/terminal scope cannot borrow ambient configuration.
        return None


def _native_footer_suffixes(context: _FooterContext) -> Tuple[str, ...]:
    """Finite native formatter outputs; never infer metadata from footer prose."""
    try:
        from gateway.runtime_footer import format_runtime_footer

        suffixes = {}
        # Native omits unavailable occupancy; otherwise it clamps/rounds to 0..100.
        for percentage in (None, *range(101)):
            line = format_runtime_footer(
                model=context.model, context_tokens=percentage or 0,
                context_length=None if percentage is None else 100,
                cwd=context.cwd, fields=context.fields,
            )
            if line and len(line) <= _MAX_FOOTER_CHARS:
                suffixes["\n\n" + line] = None
        return tuple(suffixes)
    except Exception:
        return ()


def _native_prefixes(reasoning: str) -> Tuple[str, ...]:
    """The native 0.21.x/0.22.x display formats, including localized 0.22.x.

    Exact formatting is pinned against the real gateway method in the tests.
    No heading recognition or word-based stripping takes place.
    """
    lines = reasoning.strip().splitlines()
    more = f"\n_... ({len(lines) - 15} more lines)_"
    display = "\n".join(lines[:15]) + more if len(lines) > 15 else reasoning.strip()
    # 0.21.x has i18n too, but these gateway wrapper keys arrived later.
    # Keep its observed literal formats independently of catalog availability.
    prefixes = [f"💭 **Reasoning:**\n```\n{_escape_fences(display)}\n```\n\n"]
    for header, prefix, empty in (("-# 💭 Reasoning", "-# ", "-#"), ("> 💭 **Reasoning:**", "> ", ">")):
        prefixes.append(_quote_prefix(display, header, prefix, empty))
    try:
        from agent.i18n import t

        more = t("gateway.reasoning.more_lines", count=len(lines) - 15)
        display = "\n".join(lines[:15]) + more if len(lines) > 15 else reasoning.strip()
        block = t("gateway.reasoning.block", reasoning=_escape_fences(display), response="")
        if block != "gateway.reasoning.block":
            prefixes.append(block)
        for key, prefix, empty in (("gateway.reasoning.quote_label_discord", "-# ", "-#"),
                                   ("gateway.reasoning.quote_label_md", "> ", ">")):
            header = t(key)
            if header != key:
                prefixes.append(_quote_prefix(display, header, prefix, empty))
    except ImportError:
        pass
    return tuple(dict.fromkeys(prefixes))


def _escape_fences(text: str) -> str:
    return text.replace("```", "\\`\\`\\`")


def _quote_prefix(display: str, header: str, prefix: str, empty: str) -> str:
    quoted = "\n".join(f"{prefix}{line}" if line else empty for line in display.splitlines())
    return f"{header}\n{quoted}\n\n"


def _last_turn_reasoning(history: Any) -> Optional[str]:
    """Match native ``last_reasoning`` selection without decoding carriers."""
    if not isinstance(history, list):
        return None
    for row in reversed(history):
        if not isinstance(row, dict):
            return None
        if row.get("role") == "user":
            return None
        if row.get("role") == "assistant" and row.get("reasoning"):
            value = row["reasoning"]
            return value if isinstance(value, str) else None
    return None


@dataclass(frozen=True)
class _Proof:
    record: Any
    native_session_id: str
    native_turn_id: str
    response: str
    prefixes: Tuple[str, ...]
    model: Optional[str]
    footer: Optional[_FooterContext]
    expires: float


class CompletedReplies:
    """Short-lived proof bound to the exact processing record, route and run."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._lock = threading.Lock()
        self._proofs: Dict[Tuple[str, str], Optional[_Proof]] = {}

    @staticmethod
    def _key(record: Any) -> Tuple[str, str]:
        return str(record.session_key), str(record.run_id)

    def observe(self, record: Any, payload: Dict[str, Any]) -> None:
        session_id = payload.get("session_id")
        turn_id = payload.get("turn_id")
        response = payload.get("assistant_response")
        reasoning = _last_turn_reasoning(payload.get("conversation_history"))
        key = self._key(record)
        if not (
            isinstance(session_id, str) and session_id
            and isinstance(turn_id, str) and turn_id
            and isinstance(response, str) and response
            and reasoning and len(response) + len(reasoning) <= MAX_PROOF_CHARS
        ):
            with self._lock:
                self._expire()
                self._proofs[key] = None
                self._bound()
            return
        model = payload.get("model")
        model = model if isinstance(model, str) and model else None
        proof = _Proof(record, session_id, turn_id, response, _native_prefixes(reasoning),
                       model, _native_footer_context(model),
                       self._clock() + PROOF_TTL_SECONDS)
        with self._lock:
            self._expire()
            if key in self._proofs:
                prior = self._proofs[key]
                if prior is None or (
                    prior.record is not record
                    or prior.native_session_id != session_id
                    or prior.native_turn_id != turn_id
                    or prior.response != response
                    or prior.prefixes != proof.prefixes
                    or prior.model != proof.model
                    or prior.footer != proof.footer
                ):
                    # A queued chain or conflicting observer cannot lend one
                    # completion's authority to another completion.
                    self._proofs[key] = None
                return
            self._proofs[key] = proof
            self._bound()

    def project(self, record: Any, text: str) -> str:
        if record is None or getattr(record, "delivery_cancelled", False):
            return text
        with self._lock:
            self._expire()
            proof = self._proofs.get(self._key(record))
            if proof is None or proof.record is not record:
                return text
            if any(text == prefix + proof.response for prefix in proof.prefixes):
                return proof.response
            if proof.footer is not None and _native_footer_context(proof.model) == proof.footer:
                suffixes = _native_footer_suffixes(proof.footer)
                for prefix in proof.prefixes:
                    body = prefix + proof.response
                    if text.startswith(body) and text[len(body):] in suffixes:
                        return proof.response + text[len(body):]
        return text

    def forget(self, session_key: str, run_id: str) -> None:
        with self._lock:
            self._proofs.pop((session_key, run_id), None)

    def clear(self) -> None:
        with self._lock:
            self._proofs.clear()

    def _expire(self) -> None:
        now = self._clock()
        for key, proof in list(self._proofs.items()):
            if proof is not None and now >= proof.expires:
                self._proofs.pop(key)

    def _bound(self) -> None:
        while len(self._proofs) > MAX_PROOFS:
            self._proofs.pop(next(iter(self._proofs)))
