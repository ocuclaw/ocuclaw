"""The ``next`` contract of the setup step machine (#6377), in Python.

This is a line-for-line mirror of
``extensions/ocuclaw/src/setup/setup-next-contract.ts``: what one call to
``ocuclaw_setup`` ``next`` returns, on both lanes and every host. The plugin
owns the setup flow and the agent only relays it (#6374). Each ``next``
recomputes the current step from facts on the box, runs what it can, and
returns the lines the agent says word for word, the one input it needs, and the
progress for the chat and CI.

The two runtimes must agree: the assist skills (#6379) and the CI harness (#6380)
read one shape whichever lane produced it.
``tests/fixtures/setup-next-contract.json`` pins both implementations; change
neither without the other. Spec and rulings: ``docs/features/chat-first-setup.md``.

Standard library only, no I/O. ``validate_next_result`` is total: it never
raises, and the first failing check names the error, in the same order as
TypeScript.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

SETUP_NEXT_CONTRACT = 1
SETUP_NEXT_OPERATION = "next"

SETUP_LANES = ("openclaw", "hermes")
SETUP_PROFILES = ("cloudways", "server", "container", "personal", "hermes-desktop")

SETUP_STEPS = (
    {"id": "host_model", "number": 1, "label": "Check host and model"},
    {"id": "plugin_access", "number": 2, "label": "Allow OcuClaw"},
    {"id": "loaded", "number": 3, "label": "Load OcuClaw"},
    {"id": "private_network", "number": 4, "label": "Join Tailscale"},
    {"id": "approve_machine", "number": 5, "label": "Approve this machine"},
    {"id": "private_route", "number": 6, "label": "Open private route"},
    {"id": "phone_on_tailnet", "number": 7, "label": "Find your phone"},
    {"id": "pair", "number": 8, "label": "Pair your phone"},
    {"id": "first_message", "number": 9, "label": "First glasses message"},
)
SETUP_CORE_STEP_COUNT = 9
SETUP_AFTER_CORE = ("done",)
SETUP_AFTER_CORE_LABELS = {"done": "Setup complete"}

SETUP_STATUSES = ("working", "waiting", "restarting", "stuck", "done")
SETUP_STEP_STATES = ("todo", "current", "done", "skipped", "stuck")
SETUP_INPUT_KINDS = ("none", "link", "code", "approval", "choice", "glasses")
SETUP_THEN_VALUES = ("call_next", "end_turn", "troubleshoot")
SETUP_APPROVAL_SURFACES = ("card", "popup", "chat_yes")
SETUP_APPROVAL_OPERATIONS = ("apply_route", "confirm_pairing", "pair_phone")
SETUP_CODE_OPERATION = "pair_with_phone_code"
SETUP_CODE_EXPIRES_IN_SECONDS = 600
SETUP_FORBIDDEN_OPERATIONS = ("provision_relay_credential",)
SETUP_FORBIDDEN_PHRASES = ("relay credential",)
SETUP_RESTART_HOW_BY_PROFILE = {
    "cloudways": "container",
    "server": "platform",
    "container": "platform",
    "personal": "platform",
    "hermes-desktop": "desktop_card",
}
#: ``restart.how`` when nothing on the host can restart the gateway for the
#: person: a gateway run in its own terminal has no service manager, so the
#: ``say`` lines name the command and the person runs it. Any profile but
#: Hermes Desktop, which has its card and never plans a restart here. Run
#: 42559929824: with ``platform`` here the CI leg waited for a restart no one
#: was going to make.
SETUP_RESTART_HOW_SELF = "self"
# The Hermes interfaces the setup tool answers on. ``webui`` joins the four
# local ones for chat-first setup (#6376: the Cloudways web UI chat runs
# in-process with platform "webui"). Messaging, cron and phone sessions stay
# refused.
HERMES_SETUP_INTERFACES = ("local", "cli", "tui", "desktop", "webui")

_HEX64 = re.compile(r"\A[a-f0-9]{64}\Z")
_STEP_IDS = tuple(step["id"] for step in SETUP_STEPS)
_ALL_STEP_IDS = _STEP_IDS + SETUP_AFTER_CORE
_OPERATION_STEP = {
    "apply_route": "private_route",
    "confirm_pairing": "pair",
    "pair_phone": "pair",
}

Check = Dict[str, Any]
_OK: Check = {"ok": True}


def approval_surface_for(lane: Any, interface: Any, purpose: Any, approvals: bool) -> Optional[str]:
    """Which approval surface a gated step uses, or None where setup is refused.

    ``interface`` is the host's name for the chat the call came from (Hermes:
    the session platform, "" for the classic CLI). OpenClaw's plugin approval
    renders on every surface and Full Access does not skip it. ``approvals`` is
    False when Hermes approvals are off or YOLO, where a card would pass without
    a person.
    """

    if lane == "openclaw":
        return "card"
    if lane != "hermes":
        return None
    if interface != "" and interface not in HERMES_SETUP_INTERFACES:
        return None
    # Desktop pairs in its own panel. The TUI pairs like the web chat: on
    # Hermes 0.22 it runs on a shared gateway, so its pairing popup can't find
    # the owning window (Matt ruled 2026-11-05).
    if purpose == "pairing" and interface == "desktop":
        return "popup"
    return "card" if approvals else "chat_yes"


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _is_string_list(value: Any, non_empty_items: bool = False) -> bool:
    return isinstance(value, list) and all(
        isinstance(item, str) and (not non_empty_items or len(item) > 0) for item in value
    )


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _is_int(value: Any) -> bool:
    # JSON integers only: bool is an int in Python but not a number in JSON.
    return isinstance(value, int) and not isinstance(value, bool)


def _fail(error: str) -> Check:
    return {"ok": False, "error": error}


def _mentions_forbidden_phrase(lines: Any) -> bool:
    if not isinstance(lines, list):
        return False
    return any(
        isinstance(line, str) and any(phrase in line.lower() for phrase in SETUP_FORBIDDEN_PHRASES)
        for line in lines
    )


def _status_input_ok(status: str, value: Dict[str, Any]) -> bool:
    kind = value.get("kind")
    then = value.get("then")
    if status == "working":
        return kind == "none" and then == "call_next"
    if status == "waiting":
        return kind != "none"
    if status in ("restarting", "done"):
        return kind == "none" and then == "end_turn"
    return kind == "none" and then == "troubleshoot"


def _check_input(result: Dict[str, Any]) -> Optional[Check]:
    value = result["input"]
    kind = value.get("kind")
    if kind == "link":
        url = value.get("url", "<missing>")
        url_ok = url is None or (isinstance(url, str) and url.startswith("https://"))
        if not url_ok or value.get("reply") != "done":
            return _fail("bad_input")
    elif kind == "code":
        if value.get("operation") != SETUP_CODE_OPERATION or result["step"] != "pair":
            return _fail("bad_operation")
        expires = value.get("expiresInSeconds")
        if value.get("param") != "code" or not _is_int(expires) or expires != SETUP_CODE_EXPIRES_IN_SECONDS:
            return _fail("bad_input")
    elif kind == "approval":
        surface = value.get("surface")
        operation = value.get("operation")
        if surface not in SETUP_APPROVAL_SURFACES:
            return _fail("bad_surface")
        if operation not in SETUP_APPROVAL_OPERATIONS:
            return _fail("bad_operation")
        popup = surface == "popup"
        if popup != (operation == "pair_phone") or (popup and result["lane"] != "hermes"):
            return _fail("bad_surface")
        if _OPERATION_STEP[operation] != result["step"]:
            return _fail("bad_operation")
        if not popup:
            binding = value.get("binding")
            if not isinstance(binding, str) or not _HEX64.match(binding):
                return _fail("bad_binding")
            shows = value.get("shows")
            if not _is_string_list(shows, True) or len(shows) == 0:
                return _fail("approval_without_words")
            if surface == "chat_yes":
                if value.get("param") != "answer":
                    return _fail("bad_input")
                if not all(line in result["say"] for line in shows):
                    return _fail("words_not_shown")
    elif kind == "glasses":
        # Step 9 only: the wearer sends from the glasses; the agent asks
        # nothing. ``end_turn``: the relay wakes the chat (OpenClaw);
        # ``call_next``: the next call waits for the message (Hermes).
        if result["step"] != "first_message" or value.get("then") not in ("end_turn", "call_next"):
            return _fail("bad_input")
    elif kind == "choice":
        if value.get("chooser") not in ("user", "agent"):
            return _fail("bad_input")
        options = value.get("options")
        if value.get("param") != "choice" or not isinstance(options, list) or len(options) < 2:
            return _fail("bad_input")
        ids = set()
        for option in options:
            if (
                not _is_object(option)
                or not _non_empty_string(option.get("id"))
                or not _non_empty_string(option.get("label"))
                or option["id"] in ids
            ):
                return _fail("bad_input")
            ids.add(option["id"])
    return None


def _check_restart(result: Dict[str, Any]) -> Optional[Check]:
    if result["status"] != "restarting":
        return None if "restart" not in result else _fail("bad_restart")
    if result["lane"] == "openclaw" and result["profile"] == "cloudways":
        return _fail("forbidden_restart")
    restart = result.get("restart")
    own = SETUP_RESTART_HOW_BY_PROFILE[result["profile"]]
    if (
        not _is_object(restart)
        or not (restart.get("how") == own or (restart.get("how") == SETUP_RESTART_HOW_SELF and own != "desktop_card"))
        or not _is_int(restart.get("approxSeconds"))
        or restart["approxSeconds"] <= 0
        or restart.get("resumeWord") != "continue"
        or result["step"] != "loaded"
    ):
        return _fail("bad_restart")
    return None


def _check_stuck(result: Dict[str, Any]) -> Optional[Check]:
    if result["status"] != "stuck":
        return None if "stuck" not in result else _fail("bad_stuck")
    stuck = result.get("stuck")
    if (
        not _is_object(stuck)
        or not _non_empty_string(stuck.get("code"))
        or not _is_string_list(stuck.get("checked"))
        or not _is_string_list(stuck.get("tried"))
    ):
        return _fail("bad_stuck")
    return None


def _check_progress(result: Dict[str, Any]) -> Optional[Check]:
    progress = result.get("progress")
    if (
        not _is_object(progress)
        or not _is_int(progress.get("of"))
        or progress["of"] != SETUP_CORE_STEP_COUNT
        or progress.get("current") != result["step"]
    ):
        return _fail("bad_progress")
    step_id = result["step"]
    index = _STEP_IDS.index(step_id) if step_id in _STEP_IDS else -1
    core = SETUP_STEPS[index] if index != -1 else None
    label = core["label"] if core else SETUP_AFTER_CORE_LABELS[step_id]
    number = progress.get("number", "<missing>")
    if core:
        number_ok = _is_int(number) and number == core["number"]
    else:
        number_ok = number is None
    if not number_ok or progress.get("label") != label:
        return _fail("bad_progress")
    steps = progress.get("steps")
    if not isinstance(steps, list) or len(steps) != SETUP_CORE_STEP_COUNT:
        return _fail("bad_progress")
    here = "stuck" if result["status"] == "stuck" else "current"
    for i, want in enumerate(SETUP_STEPS):
        step = steps[i]
        if (
            not _is_object(step)
            or step.get("id") != want["id"]
            or not _is_int(step.get("number"))
            or step["number"] != want["number"]
            or step.get("label") != want["label"]
        ):
            return _fail("bad_progress")
        state = step.get("state")
        if index == -1 or i < index:
            state_ok = state in ("done", "skipped")
        elif i == index:
            state_ok = state == here
        else:
            state_ok = state == "todo"
        if not state_ok:
            return _fail("bad_progress")
    for step in steps:
        if step.get("state") == "skipped" and not _non_empty_string(step.get("note")):
            return _fail("skip_without_reason")
    return None


def validate_next_result(result: Any) -> Check:
    """Check one ``next`` result against the contract; first failure wins."""

    if not _is_object(result) or not _is_int(result.get("contract")) or result["contract"] != SETUP_NEXT_CONTRACT:
        return _fail("bad_contract")
    if result.get("lane") not in SETUP_LANES:
        return _fail("bad_lane")
    profile = result.get("profile")
    if profile not in SETUP_PROFILES or (profile == "hermes-desktop" and result["lane"] != "hermes"):
        return _fail("bad_profile")
    if result.get("step") not in _ALL_STEP_IDS:
        return _fail("bad_step")
    if result.get("status") not in SETUP_STATUSES:
        return _fail("bad_status")
    if (result["status"] == "done") != (result["step"] == "done"):
        return _fail("bad_step")
    if not _is_string_list(result.get("say")):
        return _fail("bad_say")
    value = result.get("input")
    if not _is_object(value) or value.get("kind") not in SETUP_INPUT_KINDS:
        return _fail("bad_input")
    if value["kind"] == "none" and value.get("then") not in SETUP_THEN_VALUES:
        return _fail("bad_input")
    if _mentions_forbidden_phrase(result["say"]) or _mentions_forbidden_phrase(value.get("shows")):
        return _fail("mentions_relay_credential")
    if value.get("operation") in SETUP_FORBIDDEN_OPERATIONS:
        return _fail("forbidden_operation")
    if not _status_input_ok(result["status"], value):
        return _fail("status_input_mismatch")
    for check in (_check_input, _check_restart, _check_stuck, _check_progress):
        failed = check(result)
        if failed is not None:
            return failed
    return dict(_OK)
