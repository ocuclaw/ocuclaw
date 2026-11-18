"""AI review of a saved glasses card: the model calls, answered with ``ctx.llm``.

The review itself (prompts, stages, checks, saving) lives in the shared Node
runtime (extensions/ocuclaw/src/runtime/program-card-review.ts), the same on
both backends. On Hermes the child asks this parent for each stage's model
call over the control link (``program_card.review.llm.complete``), the way the
approval explainer asks for its sentence.

Calls run on the plugin's own ``ocuclaw_card_review`` auxiliary task when the
host registered it (aux_tasks.py), so the operator can pick its model under
``auxiliary.ocuclaw_card_review``; with no pick it stays on the main model.
There is no model or provider override either way, so nothing crosses the
``ctx.llm`` trust gate. The model sees the card's code and the card guide.
"""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import logging
import math
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Mapping, Optional

from .card_images import (
    CARD_CONTENT_MAX_PARTS,
    CARD_IMAGE_MAX_DECODED_BYTES,
    CARD_IMAGE_MAX_PARTS,
    CardImageError,
    hermes_image_model,
    image_url_part,
)
from .native_readers import auxiliary_cancel_scope
from .review_errors import review_failure

logger = logging.getLogger(__name__)

CARD_REVIEW_LLM_COMPLETE_METHOD = "program_card.review.llm.complete"
CARD_REVIEW_LLM_CANCEL_METHOD = "program_card.review.llm.cancel"
CARD_REVIEW_LLM_PURPOSE = "ocuclaw.card.review"
CARD_REVIEW_LLM_DEFAULT_TIMEOUT_S = 120.0
# The reviewer's longest stage deadline for a slow route (program-card-review-pace.ts).
CARD_REVIEW_LLM_MAX_TIMEOUT_S = 300.0
CARD_REVIEW_LLM_MAX_TOKENS = 8000
CARD_REVIEW_LLM_MAX_MESSAGES = 4
# One message's text, in characters. The reviewer (program-card-review.ts) sends
# the card guide as the system message (about 44,400 characters) and puts the
# whole saved source (PROGRAM_CARD_LIMITS.sourceMax, 131,072) in the user
# message, with a Look report (LOOK_TEXT_MAX, 24,000) and, at the fix stage, up
# to EDITS_MAX (8) edits of EDIT_TEXT_MAX (6,000) find and replace text each.
# Its largest fix message measures about 249,300 characters.
# tests/program-card-review-hermes-cap.test.js holds the two sides together.
CARD_REVIEW_LLM_MAX_CONTENT_CHARS = 262_144
# Two reviews may each have five detail calls and an unfinished glance. Keep
# their native semaphore waiters out of asyncio's shared I/O executor, without
# reducing that existing peak concurrency or bypassing Hermes' own limits.
_NATIVE_REVIEW_WORKERS = 12
_NATIVE_EXECUTOR = None
_NATIVE_EXECUTOR_LOCK = threading.Lock()


def _native_review_executor():
    global _NATIVE_EXECUTOR
    with _NATIVE_EXECUTOR_LOCK:
        if _NATIVE_EXECUTOR is None:
            _NATIVE_EXECUTOR = ThreadPoolExecutor(
                max_workers=_NATIVE_REVIEW_WORKERS, thread_name_prefix="ocuclaw-review"
            )
        return _NATIVE_EXECUTOR


async def _complete_with_native_cancel(llm, messages, kwargs):
    """Keep Stop attached to Hermes' provider attempt, not just its awaiter.

    Hermes' async Responses client runs its sync stream in ``to_thread``.
    Cancelling that Future leaves the old stream/watchdog alive; a later
    watchdog can close the process-shared client under a retried review.
    Hosts with the native attempt-cancel scope can run the same trusted
    ``ctx.llm.complete`` on a worker with a per-call Event. Older hosts retain
    their async path. No provider/model/trust override is added.
    """
    complete = getattr(llm, "complete", None)
    aux_interrupt_protection = auxiliary_cancel_scope()
    if not callable(complete) or not callable(aux_interrupt_protection):
        return await llm.acomplete(messages, **kwargs)
    cancelled = threading.Event()
    try:
        inspect.signature(aux_interrupt_protection).bind(cancel_event=cancelled)
    except (TypeError, ValueError):
        # Older hosts expose the protection scope without attempt cancellation.
        return await llm.acomplete(messages, **kwargs)

    def invoke():
        with aux_interrupt_protection(cancel_event=cancelled):
            return complete(messages, **kwargs)

    try:
        # Unlike to_thread, run_in_executor does not copy the profile/secret
        # ContextVars. Preserve them explicitly; never resolve another profile.
        context = contextvars.copy_context()
        return await asyncio.get_running_loop().run_in_executor(
            _native_review_executor(), context.run, invoke
        )
    finally:
        # Also set on the outer timeout: the provider owns its bounded stream
        # teardown and must not mistake our abandoned call for an active one.
        cancelled.set()


class CardReviewCalls:
    """Own only review calls, so Stop never interrupts the user's chat agent."""

    def __init__(self):
        self.pending = {}

    async def complete(self, llm, params, *, task=None, purpose=CARD_REVIEW_LLM_PURPOSE,
                       max_tokens_cap=CARD_REVIEW_LLM_MAX_TOKENS, max_timeout_s=CARD_REVIEW_LLM_MAX_TIMEOUT_S):
        call_id = params.get("callId") if isinstance(params, Mapping) else None
        limits = {"task": task, "purpose": purpose, "max_tokens_cap": max_tokens_cap,
                  "max_timeout_s": max_timeout_s}
        # Old children have no call id and retain the same bounded behavior.
        if not isinstance(call_id, str) or not call_id or len(call_id) > 64:
            return await card_review_llm_complete(llm, params, **limits)
        if call_id in self.pending:
            return {"error": "duplicate_call"}
        operation = asyncio.create_task(card_review_llm_complete(llm, params, **limits))
        self.pending[call_id] = operation
        try:
            return await operation
        finally:
            self.pending.pop(call_id, None)

    async def cancel(self, params):
        call_id = params.get("callId") if isinstance(params, Mapping) else None
        operation = self.pending.get(call_id) if isinstance(call_id, str) else None
        if operation is not None:
            operation.cancel()
        return {"cancelled": operation is not None}


def _bounded_number(value: Any, default: float, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return max(low, min(high, float(value)))


def _llm_messages(raw: Any) -> Optional[List[Dict[str, Any]]]:
    if not isinstance(raw, list) or not raw or len(raw) > CARD_REVIEW_LLM_MAX_MESSAGES:
        return None
    messages: List[Dict[str, Any]] = []
    decoded = images = 0
    for item in raw:
        if not isinstance(item, Mapping):
            return None
        role, content = item.get("role"), item.get("content")
        if role not in ("system", "user"):
            return None
        if isinstance(content, str):
            if len(content) > CARD_REVIEW_LLM_MAX_CONTENT_CHARS:
                return None
        elif isinstance(content, list) and content and len(content) <= CARD_CONTENT_MAX_PARTS:
            parts, text_chars = [], 0
            for part in content:
                if (isinstance(part, Mapping) and set(part) == {"type", "text"}
                        and part.get("type") == "text" and isinstance(part["text"], str)):
                    text_chars += len(part["text"])
                    if text_chars > CARD_REVIEW_LLM_MAX_CONTENT_CHARS:
                        return None
                    parts.append({"type": "text", "text": part["text"]})
                else:
                    try:
                        normalized, size = image_url_part(part, CARD_IMAGE_MAX_DECODED_BYTES - decoded)
                    except CardImageError:
                        return None
                    decoded += size
                    images += 1
                    if images > CARD_IMAGE_MAX_PARTS:
                        return None
                    parts.append(normalized)
            content = parts
        else:
            return None
        messages.append({"role": role, "content": content})
    return messages


async def card_review_llm_complete(
    llm: Any, params: Any, *, task: Optional[str] = None, purpose: str = CARD_REVIEW_LLM_PURPOSE,
    max_tokens_cap: int = CARD_REVIEW_LLM_MAX_TOKENS, max_timeout_s: float = CARD_REVIEW_LLM_MAX_TIMEOUT_S,
) -> Dict[str, Any]:
    """Answer one stage of a card review with ``ctx.llm``.

    ``params``: ``messages`` (system/user only), optional ``maxTokens``
    (clamped to ``max_tokens_cap``: the review's 8000 unless a lane sets its
    own), ``temperature`` and ``timeoutMs`` (clamped to ``max_timeout_s``, the
    review's 300 s unless a lane sets its own). Returns ``{"text": ..., "model": ...}``
    (plus ``usage`` and ``stopReason`` when the host reports them) or
    ``{"error": ...}``; never raises (except cancellation).
    """
    if not isinstance(params, Mapping):
        return {"error": "invalid_params"}
    messages = _llm_messages(params.get("messages"))
    if messages is None:
        return {"error": "invalid_params"}
    acomplete = getattr(llm, "acomplete", None) if llm is not None else None
    if not callable(acomplete):
        return {"error": "unavailable"}
    timeout_s = _bounded_number(
        params.get("timeoutMs"),
        CARD_REVIEW_LLM_DEFAULT_TIMEOUT_S * 1000,
        1000,
        max_timeout_s * 1000,
    ) / 1000
    kwargs: Dict[str, Any] = {"timeout": timeout_s, "purpose": purpose}
    if task:
        kwargs["task"] = task
    max_tokens = params.get("maxTokens")
    if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens > 0:
        kwargs["max_tokens"] = min(max_tokens, max_tokens_cap)
    temperature = params.get("temperature")
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
        kwargs["temperature"] = _bounded_number(temperature, 0.0, 0.0, 2.0)
    try:
        result = await asyncio.wait_for(
            _complete_with_native_cancel(llm, messages, kwargs), timeout=timeout_s
        )
    except asyncio.CancelledError:
        raise
    except asyncio.TimeoutError:
        return {"error": "timeout"}
    except Exception as exc:  # noqa: BLE001 - trust gate, provider, network
        logger.debug("[ocuclaw] card review call failed: %s", exc)
        return {"error": type(exc).__name__, "failure": review_failure(exc)}
    text = getattr(result, "text", None)
    answer: Dict[str, Any] = {"text": text if isinstance(text, str) else ""}
    model = getattr(result, "model", None)
    if isinstance(model, str) and model:
        answer["model"] = model[:80]
    provider = getattr(result, "provider", None)
    if isinstance(provider, str) and provider:
        answer["provider"] = provider[:80]
        if isinstance(model, str) and model:
            answer["imageModel"] = hermes_image_model(provider, model)
    usage = _review_usage(getattr(result, "usage", None))
    if usage:
        answer["usage"] = usage
    stop_reason = _stop_reason(result)
    if stop_reason:
        answer["stopReason"] = stop_reason
    return answer


# Provider finish reasons → the shared reviewer's two words. "length" means
# the answer hit its token budget and may be cut off mid-JSON.
_STOP_REASONS = {
    "length": "length", "max_tokens": "length", "max_output_tokens": "length", "incomplete": "length",
    "stop": "stop", "end_turn": "stop", "stop_sequence": "stop", "completed": "stop",
}


def _stop_reason(result: Any) -> Optional[str]:
    """The completion's normalized stop reason, or None when it gives none.

    Hermes' ``PluginLlmCompleteResult`` documents no finish reason today, so
    this reads one only where a host adds it. With none, the Node reviewer
    infers a cut-off answer from ``usage.outputTokens`` reaching the budget.
    """
    for field in ("finish_reason", "stop_reason"):
        value = getattr(result, field, None)
        if isinstance(value, str) and value.strip().lower() in _STOP_REASONS:
            return _STOP_REASONS[value.strip().lower()]
    return None


def _review_usage(raw: Any) -> Optional[Dict[str, Any]]:
    """Token counts and cost from ``result.usage``: finite, non-negative only."""
    usage: Dict[str, Any] = {}
    for public, field in (("inputTokens", "input_tokens"), ("outputTokens", "output_tokens"), ("costUsd", "cost_usd")):
        value = getattr(raw, field, None) if raw is not None else None
        if value is None and isinstance(raw, Mapping):
            value = raw.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            usage[public] = value
    # Hermes' usage defaults to zeros, so all-zero counters mean unknown, not 0.
    return usage if (usage.get("inputTokens") or usage.get("outputTokens")) else None
