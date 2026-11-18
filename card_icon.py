"""Saved-card icon pick: the host model's one-word answer, with ``ctx.llm``.

Wearers without Jev get a model-picked Library icon for each saved card
(program-card-icon-model.ts in the shared Node runtime). On Hermes the child
asks this parent for one text completion over the control link
(``program_card.icon.llm.complete``): a system message with the icon list and
a user message with the card's name and description, one icon id (or
``none``) out, no tools.

It is the card review's transport (card_review.py) with its own method names,
purpose, auxiliary task and limits. The prompt is about 8 KB and the answer
one word, so the lane caps a call at 1000 output tokens (room for a reasoning
model's thinking) and 12 000 characters in. Calls run on the plugin's own
``ocuclaw_card_icon`` auxiliary task when the host registered it
(aux_tasks.py); it inherits Hermes' ``title_generation`` model, so by default
it follows whatever the operator picked for session titles. No model or
provider override is sent, so nothing crosses the ``ctx.llm`` trust gate.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

from .card_review import CardReviewCalls

CARD_ICON_LLM_COMPLETE_METHOD = "program_card.icon.llm.complete"
CARD_ICON_LLM_CANCEL_METHOD = "program_card.icon.llm.cancel"
CARD_ICON_LLM_PURPOSE = "ocuclaw.card.icon"
# A larger maxTokens is clamped to this, never refused.
CARD_ICON_LLM_MAX_TOKENS = 1000
# The icon list and the card's text, across both messages.
CARD_ICON_LLM_MAX_TOTAL_CHARS = 12_000


def _icon_text_chars(raw: Any) -> Optional[int]:
    """Total text of a system-then-user text pair, or None when bad.

    The shared check in card_review.py still runs after this one; this adds
    the lane's own bounds: two text messages and one total cap.
    """
    if not isinstance(raw, list) or len(raw) != 2:
        return None
    total = 0
    for item, role in zip(raw, ("system", "user")):
        if not isinstance(item, Mapping) or item.get("role") != role:
            return None
        content = item.get("content")
        if not isinstance(content, str) or not content:
            return None
        total += len(content)
    return total if total <= CARD_ICON_LLM_MAX_TOTAL_CHARS else None


async def card_icon_llm_complete(
    calls: CardReviewCalls, llm: Any, params: Any, *, task: Optional[str] = None
) -> Dict[str, Any]:
    """Answer one icon pick: ``{text,model?,provider?,usage?,stopReason?}`` or
    ``{error[,failure]}``, the review lane's shapes. Cancel through
    ``calls.cancel`` (``program_card.icon.llm.cancel``)."""
    if not isinstance(params, Mapping) or _icon_text_chars(params.get("messages")) is None:
        return {"error": "invalid_params"}
    return await calls.complete(
        llm, params, task=task, purpose=CARD_ICON_LLM_PURPOSE, max_tokens_cap=CARD_ICON_LLM_MAX_TOKENS
    )
