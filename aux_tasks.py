"""OcuClaw's own Hermes auxiliary tasks (#5046).

Each background model call OcuClaw makes outside an agent turn runs through a
plugin-owned auxiliary task, so the operator can pick its model in Hermes'
own picker (dashboard Models page, Desktop, ``hermes model``) under
``auxiliary.<key>``:

* ``silent_input_prediction`` — next-word candidates for the glasses keyboard.
* ``ocuclaw_approval_explain`` — the one-line sentence on approval cards. It
  inherits Hermes' built-in ``approval`` task, so by default it follows the
  smart-approvals model, which already sees the command.
* ``ocuclaw_liveui_refresh`` — live view recipes re-run on their timer. No
  base: it stays on the main model until someone picks one.
* ``ocuclaw_card_review`` — the AI review of a saved glasses card's code
  (card_review.py). No base either.
* ``ocuclaw_card_model`` — model calls made by programmable cards.
* ``ocuclaw_card_frame`` — the art script a programmable card's frame step
  writes (card_frame.py). No base, like the card review. It is the wearer's
  Balanced frame detail, at medium effort unless the operator sets one.
* ``ocuclaw_card_frame_quick`` and ``ocuclaw_card_frame_detailed`` — the
  same call at the wearer's Quick (low) and Detailed (high) frame detail.
  ``ctx.llm`` takes no effort per call, so each level is its own task with
  its own ``reasoning_effort``; both inherit ``ocuclaw_card_frame``, so they
  follow its model pick. Detailed also waits longer (420 s, as on OpenClaw).
* ``ocuclaw_agent_router`` — Auto's one-word pick of which agent takes a new
  chat (agent_router.py). It inherits Hermes's ``group_router`` task, the
  model auto Group Chats route with.
* ``ocuclaw_card_icon`` — the one-word pick of a saved card's Library icon
  for wearers without Jev (card_icon.py). It inherits Hermes's
  ``title_generation`` task, so by default it follows the session-title model.

``OCUCLAW_TASKS`` lists the tasks the usage tally (aux_usage.py) counts:
all ten, the card review, the three card frame levels, Auto agent router and
card icon included.

Registration is optional. A host without ``register_auxiliary_task`` gets no
task, and callers then send no ``task=``. The flags below are set once at
``register()`` and read by the call sites and by approvals management.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Mapping, Optional

logger = logging.getLogger(__name__)

APPROVAL_EXPLAIN_TASK = "ocuclaw_approval_explain"
LIVEUI_REFRESH_TASK = "ocuclaw_liveui_refresh"
CARD_REVIEW_TASK = "ocuclaw_card_review"
TASK_PROPOSAL_TASK = "ocuclaw_task_proposal"
CARD_MODEL_TASK = "ocuclaw_card_model"
CARD_FRAME_TASK = "ocuclaw_card_frame"
CARD_FRAME_QUICK_TASK = "ocuclaw_card_frame_quick"
CARD_FRAME_DETAILED_TASK = "ocuclaw_card_frame_detailed"
# A frame call's `reasoning` (program-card-frame-lane.ts) to the task that runs at it. The idea
# and paint-world calls ask for minimal or low and take Quick's effort; anything else is Balanced.
_CARD_FRAME_TASK_FOR_REASONING = {"minimal": CARD_FRAME_QUICK_TASK, "low": CARD_FRAME_QUICK_TASK,
                                  "high": CARD_FRAME_DETAILED_TASK}
# Detailed's longer wait (FRAME_DETAIL_TIMEOUT_MS.high); card_frame.py allows the same per call.
CARD_FRAME_DETAILED_TIMEOUT_S = 420
AGENT_ROUTER_TASK = "ocuclaw_agent_router"
CARD_ICON_TASK = "ocuclaw_card_icon"
# Owned by input_prediction.py; repeated here so the telemetry filter and the
# registry need no import of that module.
INPUT_PREDICTION_TASK = "silent_input_prediction"

OCUCLAW_TASKS = (APPROVAL_EXPLAIN_TASK, LIVEUI_REFRESH_TASK, INPUT_PREDICTION_TASK, CARD_MODEL_TASK,
                 CARD_REVIEW_TASK, CARD_FRAME_TASK, CARD_FRAME_QUICK_TASK, CARD_FRAME_DETAILED_TASK,
                 AGENT_ROUTER_TASK, CARD_ICON_TASK)

_REGISTERED: Dict[str, bool] = {}


def is_registered(key: str) -> bool:
    """True when this process's ``register()`` registered ``key`` with the host."""
    return _REGISTERED.get(key, False)


def task_for(key: str) -> Optional[str]:
    """``key`` when registered, else None: the ``task=`` value for one call."""
    return key if is_registered(key) else None


def card_frame_task(reasoning: Any) -> Optional[str]:
    """The ``task=`` for a frame call at ``reasoning``: its level's task when registered, else the
    Balanced task (a host that refused the level's task still draws, at the Balanced effort)."""
    level = _CARD_FRAME_TASK_FOR_REASONING.get(reasoning) if isinstance(reasoning, str) else None
    return (task_for(level) if level else None) or task_for(CARD_FRAME_TASK)


def reset() -> None:
    _REGISTERED.clear()


def register_aux_task(
    ctx: Any,
    key: str,
    *,
    display_name: str,
    description: str,
    inherit_from: Optional[str] = None,
    defaults: Optional[Mapping[str, Any]] = None,
    plain_retry: bool = True,
) -> bool:
    """Register one plugin-owned auxiliary task; never raises.

    * No ``register_auxiliary_task`` on the host: register nothing.
    * ``TypeError`` (a host older than ``inherit_from``/``defaults``): retry
      with only the arguments every host takes, unless ``plain_retry`` is
      false (a task that means nothing without them is then left out).
    * ``ValueError`` or any other error: one warning, flag left false.
    """
    _REGISTERED[key] = False
    register = getattr(ctx, "register_auxiliary_task", None)
    if not callable(register):
        return False
    kwargs: Dict[str, Any] = {"display_name": display_name, "description": description}
    if defaults:
        kwargs["defaults"] = dict(defaults)
    if inherit_from:
        kwargs["inherit_from"] = inherit_from
    try:
        try:
            register(key, **kwargs)
        except TypeError:
            if len(kwargs) == 2 or not plain_retry:
                raise
            register(key, display_name=display_name, description=description)
    except Exception as exc:  # noqa: BLE001 - never block plugin registration
        logger.warning("[ocuclaw] %s auxiliary task not registered: %s", key, exc)
        return False
    _REGISTERED[key] = True
    return True


def register_ocuclaw_tasks(ctx: Any) -> None:
    """Register every OcuClaw auxiliary task this host supports."""
    register_aux_task(ctx, TASK_PROPOSAL_TASK, display_name="OcuClaw Task setup",
                      description="Propose a Task result from the owner's description; no tools or jobs.")
    register_aux_task(ctx, CARD_MODEL_TASK, display_name="OcuClaw card model",
                      description="Model calls made by programmable glasses cards", defaults={"timeout": 60})
    register_aux_task(
        ctx,
        INPUT_PREDICTION_TASK,
        display_name="Silent input predictions",
        description="Next-word candidates for the OcuClaw glasses keyboard (direct, no agent turn)",
    )
    register_aux_task(
        ctx,
        APPROVAL_EXPLAIN_TASK,
        display_name="OcuClaw approval explainer",
        description="One plain-English sentence on glasses approval cards",
        inherit_from="approval",
        defaults={"timeout": 20},
    )
    register_aux_task(
        ctx,
        LIVEUI_REFRESH_TASK,
        display_name="OcuClaw live view refresh",
        description="Re-runs live view prompts on the glasses on their timer",
    )
    register_aux_task(
        ctx,
        CARD_REVIEW_TASK,
        display_name="OcuClaw card review",
        description="Suggests five improvements to a saved glasses card's code (phone's AI review)",
        # Codex may finish reasoning items without emitting a recognized delta.
        # The window matches the longest stage deadline a slow route earns
        # (CARD_REVIEW_LLM_MAX_TIMEOUT_S); the native guard still clamps it to
        # each caller deadline, so a call at the fixed deadlines waits as before.
        defaults={"timeout": 180, "no_progress_timeout": 300},
    )
    register_aux_task(
        ctx,
        CARD_FRAME_TASK,
        display_name="OcuClaw card frame art",
        description="Writes the art script for a programmable glasses card's frame",
        # One long reply (5-10 KB of JS after reasoning): the window matches the
        # lane's longest deadline, and the native guard still clamps it per call.
        # Medium effort is the wearer's Balanced frame detail, as on OpenClaw;
        # the operator's own auxiliary.ocuclaw_card_frame.reasoning_effort wins.
        defaults={"timeout": 300, "no_progress_timeout": 300, "reasoning_effort": "medium"},
    )
    # Quick and Detailed: the same call on the Balanced task's model at their own effort.
    # Without inherit_from they would leave the operator's frame model, so no plain retry.
    register_aux_task(
        ctx,
        CARD_FRAME_QUICK_TASK,
        display_name="OcuClaw card frame art (Quick)",
        description="The card frame art script at Quick detail: low effort, on the card frame art model",
        inherit_from=CARD_FRAME_TASK,
        defaults={"reasoning_effort": "low"},
        plain_retry=False,
    )
    register_aux_task(
        ctx,
        CARD_FRAME_DETAILED_TASK,
        display_name="OcuClaw card frame art (Detailed)",
        description="The card frame art script at Detailed detail: high effort, on the card frame art model",
        inherit_from=CARD_FRAME_TASK,
        defaults={"reasoning_effort": "high", "timeout": CARD_FRAME_DETAILED_TIMEOUT_S,
                  "no_progress_timeout": CARD_FRAME_DETAILED_TIMEOUT_S},
        plain_retry=False,
    )
    register_aux_task(
        ctx,
        AGENT_ROUTER_TASK,
        display_name="OcuClaw Auto agent",
        description="Picks which agent takes a new glasses chat started on Auto (one word, no tools)",
        inherit_from="group_router",
        # The glasses wait at most 4 s for the pick (agent_router.ROUTE_BUDGET_S).
        defaults={"timeout": 4},
    )
    register_aux_task(
        ctx,
        CARD_ICON_TASK,
        display_name="OcuClaw card icon",
        description="Picks the Library icon for a saved glasses card (one word, no tools)",
        inherit_from="title_generation",
        # Nothing waits on the pick; the child gives it 20 s
        # (program-card-icon-model.ts CARD_ICON_MODEL_BUDGET_MS).
        defaults={"timeout": 20},
    )
