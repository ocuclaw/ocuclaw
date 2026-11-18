"""Program-card frame step: the art script's model call, answered with ``ctx.llm``.

The frame step itself (prompt, code-block extraction, checks) lives in the
shared Node runtime. On Hermes the child asks this parent for one text
completion over the control link (``program_card.frame.llm.complete``): a
system and a user message in, one reply (a ```js code block) out, no tools.

It is the card review's transport (card_review.py) with its own method names,
purpose, auxiliary task and limits. The art script is 5-10 KB of JS and
reasoning models spend 2-5k tokens before it, so this lane allows 16000
tokens where the review keeps 8000, and 420 s for a Detailed frame where the
review keeps 300 s. Calls run on the plugin's own ``ocuclaw_card_frame``
auxiliary task when the host registered it (aux_tasks.py), or on its Quick or
Detailed sibling for the call's ``reasoning`` (the wearer's frame detail);
with no pick it stays on the main model. No model or
provider override is sent, so nothing crosses the ``ctx.llm`` trust gate.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

from . import aux_tasks
from .card_review import CARD_REVIEW_LLM_MAX_MESSAGES, CardReviewCalls

CARD_FRAME_LLM_COMPLETE_METHOD = "program_card.frame.llm.complete"
CARD_FRAME_LLM_CANCEL_METHOD = "program_card.frame.llm.cancel"
CARD_FRAME_LLM_PURPOSE = "ocuclaw.card.frame"
# A larger maxTokens is clamped to this, never refused.
CARD_FRAME_LLM_MAX_TOKENS = 16000
# A Detailed frame's deadline (FRAME_DETAIL_TIMEOUT_MS.high, 420 s); the
# other levels ask for 240 s. A longer timeoutMs is clamped to this.
CARD_FRAME_LLM_MAX_TIMEOUT_S = float(aux_tasks.CARD_FRAME_DETAILED_TIMEOUT_S)
# The frame prompt and the card's context, across every message.
CARD_FRAME_LLM_MAX_TOTAL_CHARS = 40_000


def _frame_text_chars(raw: Any) -> Optional[int]:
    """Total text of a text-only system/user message list, or None when bad.

    The shared check in card_review.py still runs after this one; this adds
    the lane's own bounds: text only (no images) and one total cap.
    """
    if not isinstance(raw, list) or not raw or len(raw) > CARD_REVIEW_LLM_MAX_MESSAGES:
        return None
    total = 0
    for item in raw:
        if not isinstance(item, Mapping) or item.get("role") not in ("system", "user"):
            return None
        content = item.get("content")
        if isinstance(content, str):
            total += len(content)
        elif isinstance(content, list) and content:
            for part in content:
                if not (isinstance(part, Mapping) and set(part) == {"type", "text"}
                        and part.get("type") == "text" and isinstance(part.get("text"), str)):
                    return None
                total += len(part["text"])
        else:
            return None
        if total > CARD_FRAME_LLM_MAX_TOTAL_CHARS:
            return None
    return total


async def card_frame_llm_complete(
    calls: CardReviewCalls, llm: Any, params: Any, *, task: Optional[str] = None
) -> Dict[str, Any]:
    """Answer one frame-step call: ``{text,model?,provider?,usage?,stopReason?}``
    or ``{error[,failure]}``, the review lane's shapes. Cancel through
    ``calls.cancel`` (``program_card.frame.llm.cancel``)."""
    if not isinstance(params, Mapping) or _frame_text_chars(params.get("messages")) is None:
        return {"error": "invalid_params"}
    return await calls.complete(
        llm, params, task=task, purpose=CARD_FRAME_LLM_PURPOSE, max_tokens_cap=CARD_FRAME_LLM_MAX_TOKENS,
        max_timeout_s=CARD_FRAME_LLM_MAX_TIMEOUT_S,
    )
