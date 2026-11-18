"""OcuClaw's starters as Hermes Automation Blueprints (#5027).

Hermes 0.22 lists blueprints in its gallery (Desktop and ``/blueprint``). A
plugin adds its own with ``ctx.register_automation_blueprint(key, ...)``, and
Hermes stores each as ``<plugin name>:<key>``, so the keys here are bare:
``ocuclaw:glasses-brief``, ``ocuclaw:day-wrap`` and ``ocuclaw:glance-reminder``.

* Keys never reuse a Hermes built-in name (``cron/blueprint_catalog.py``).
* Each job delivers to the glasses (``deliver_default="ocuclaw"``). Desktop
  rewrites an ``origin`` default to ``local``, so ``origin`` would never reach
  the glasses. There is no deliver slot: these starters exist for the glasses.
* ``{minute}``/``{hour}`` come from the slot named ``time`` and ``{dow}`` from
  the one named ``recurrence``; Hermes derives them itself.
* Tags carry the kind (``kind:brief``, ``kind:reminder``) for the phone's
  Start from gallery (#5034).

Registration never breaks plugin load. Hermes 0.21.x has the blueprint
catalog but no registration method, so nothing registers there. Hermes logs
and ignores most bad input, but one raised error inside ``register()`` would
unload the whole plugin, so each starter registers in its own try.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, Tuple

from .glasses_prompt import GLASSES_URGENT_PROMPT_RULES

logger = logging.getLogger(__name__)

DELIVER_TO = "ocuclaw"

# Hermes' named weekday recurrences (cron/blueprint_catalog.py WEEKDAY_PRESETS).
_RECURRENCES = ("everyday", "weekdays", "weekends")


def _time(default: str) -> Dict[str, Any]:
    return {
        "name": "time",
        "type": "time",
        "label": "What time?",
        "default": default,
        "help": "24h local time, e.g. 07:15",
    }


def _days(default: str) -> Dict[str, Any]:
    return {
        "name": "recurrence",
        "type": "weekdays",
        # "Repeat" is not a wearer-facing word for Tasks (#5022).
        "label": "Which days?",
        "default": default,
        "options": _RECURRENCES,
    }


def _model_prompt(task: str) -> str:
    # #7241: both briefs look for urgent things, so they open with the urgent
    # form of the rules. It is the rules as they were, so these prompts and
    # every Task saved from them are unchanged.
    return f"{GLASSES_URGENT_PROMPT_RULES}\n\n{task}"


STARTERS: Tuple[Mapping[str, Any], ...] = (
    {
        "key": "glasses-brief",
        "title": "Morning brief",
        "description": (
            "A short morning brief on your glasses: today's calendar, the "
            "weather and anything urgent."
        ),
        "category": "daily",
        "schedule_template": "{minute} {hour} * * {dow}",
        "prompt_template": _model_prompt(
            "Give the user a morning brief for today: calendar events in "
            "time order, the local weather, and anything urgent waiting on "
            "them. Use connected calendar and mail when they are set up. If "
            "none are, give the date and the weather."
        ),
        "slots": (_time("07:15"), _days("weekdays")),
        "tags": ("glasses", "kind:brief", "daily"),
    },
    {
        "key": "day-wrap",
        "title": "Day wrap-up",
        "description": (
            "An end-of-day wrap-up on your glasses: what is still open and "
            "what tomorrow starts with."
        ),
        "category": "daily",
        "schedule_template": "{minute} {hour} * * {dow}",
        "prompt_template": _model_prompt(
            "Give the user a short wrap-up of their day: anything still open "
            "from today, tomorrow's first commitments in time order, and "
            "anything to prepare tonight. Use connected calendar and mail "
            "when they are set up."
        ),
        "slots": (_time("17:30"), _days("weekdays")),
        "tags": ("glasses", "kind:brief", "evening"),
    },
    {
        "key": "glance-reminder",
        "title": "Reminder",
        "description": "A reminder in your own words, shown on your glasses on your schedule.",
        "category": "general",
        "schedule_template": "{minute} {hour} * * {dow}",
        # Fixed text, so a later no-model run (#5036) can print it as is.
        "prompt_template": (
            "Output this reminder text exactly as written, on one line, with "
            "nothing before or after it:\n{text}"
        ),
        "slots": (
            {
                "name": "text",
                "type": "text",
                "label": "Reminder text",
                "default": "Stand up and stretch",
            },
            _time("09:00"),
            _days("weekdays"),
        ),
        "tags": ("glasses", "kind:reminder"),
    },
)

STARTER_KEYS = tuple(starter["key"] for starter in STARTERS)


def register_starters(ctx: Any) -> List[str]:
    """Register each OcuClaw starter the host accepts; never raises.

    Returns the bare keys Hermes accepted. A host without
    ``register_automation_blueprint`` (Hermes 0.21.x) gets none.
    """
    register = getattr(ctx, "register_automation_blueprint", None)
    if not callable(register):
        logger.info(
            "[ocuclaw] host has no automation blueprints; starters not registered"
        )
        return []
    registered: List[str] = []
    for starter in STARTERS:
        key = starter["key"]
        fields = {name: value for name, value in starter.items() if name != "key"}
        fields["slots"] = [dict(slot) for slot in starter["slots"]]
        try:
            # Hermes returns None when it logs and ignores bad input.
            accepted = register(key, deliver_default=DELIVER_TO, **fields)
        except Exception as exc:  # noqa: BLE001 - one starter never blocks plugin load
            logger.warning("[ocuclaw] starter %s not registered: %s", key, exc)
            continue
        if accepted is None:
            logger.warning("[ocuclaw] starter %s refused by the host", key)
            continue
        registered.append(key)
    return registered
