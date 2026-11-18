"""The shared prompt rules for model output shown on the glasses (#5022).

Every Task run starts with these rules, so a result fits the G2 display and
the result inbox can split its headline, body and fenced ``ocuclaw-card``
values (``task_results.py``).

#7241: the rules come in two forms. ``Say "Nothing urgent"`` was written for
briefs and reached every Task, so a history fact ended "Nothing urgent."

* ``GLASSES_PROMPT_RULES`` opens every other run.
* ``GLASSES_URGENT_PROMPT_RULES`` adds that one sentence. It opens a run that
  looks for urgent things (``asks_nothing_urgent``): OcuClaw's Morning brief
  and Day wrap-up, whose prompts start with it (``starters.py``), and a card
  with an ``urgent`` value (the Daily plan layout, My morning). It is the
  rules as they were before #7241, word for word, so a Task saved from one of
  those Blueprints still matches its Blueprint's prompt.
"""

from __future__ import annotations

_RULES_HEAD = (
    "Shown on Even G2 glasses, about 50 characters a line. Plain text only: "
    "no markdown, links, tables, greetings or emoji. Start with one headline "
    "line under 50 characters that sums up the whole result, even when a skill "
    "or the task sets its own format. Then at most 6 short lines in time order, most "
    "important first. "
)
_NOTHING_URGENT_RULE = "Say \"Nothing urgent\" rather than leave it out. "
_RULES_TAIL = (
    "If nothing is worth showing, respond with [SILENT]. After the text, add "
    "one fenced ocuclaw-card block with the card's JSON values."
)

GLASSES_PROMPT_RULES = _RULES_HEAD + _RULES_TAIL
GLASSES_URGENT_PROMPT_RULES = _RULES_HEAD + _NOTHING_URGENT_RULE + _RULES_TAIL


def asks_nothing_urgent(request, look=None):
    """#7241: True when a run looks for urgent things, so "Nothing urgent" belongs in it.

    A request that starts with the urgent form of the rules (Morning brief, Day
    wrap-up), or a card with a value named ``urgent``.
    """
    if str(request).strip().startswith(GLASSES_URGENT_PROMPT_RULES):
        return True
    inputs = look.get("inputs") if isinstance(look, dict) else None
    return any(isinstance(entry, dict) and entry.get("key") == "urgent" for entry in inputs or [])
