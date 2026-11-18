"""The Hermes lane's ``next`` (#6377): read the box, decide, run one step, decide again.

The Python twin of ``extensions/ocuclaw/src/setup/setup-next.ts``. The decider
(``setup_decide.py``) is pure; this module is the two halves around it:

* the reader turns what the box says (the setup status, the health snapshot,
  Tailscale, #6378's approval store, the user's own answers) into the
  decider's facts. :func:`setup_next_facts` is the pure part of that mapping,
  so the tests can pin it without a box;
* the runner does the one thing the decider asks for (``run``), then the
  decider runs again. Each run happens at most once per call; a step that is
  still in progress comes back as ``working`` and the agent calls again.

The user's answers given through ``choice`` (where this agent runs, which
Tailscale; an older setup's extras pick) are kept in a small file in the
profile's OcuClaw state folder, with the moment of the one announced restart,
the moment the first message check began and the moment setup's welcome line
was said, so a new chat or a container restart resumes where setup
is.

Step 2 asks nothing (RULED, Matt 2026-11-04): every supported Hermes (0.21.4+)
records "multiple" agents, and Continue here is turned on, as the Hermes setup
skill already does.

Never here: the Relay Credential (the plugin minted it at load, pairing
delivers it), anything the user has to approve (approvals go through #6378's
operations and cards), and any restart but the decider's one announced
restart, which is started only after this call has answered.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from . import setup_approval_store as store
from .setup_decide import SAY_BEGINNING, SETUP_STUCK_SAY, decide_next
from .setup_next_contract import (
    SETUP_NEXT_OPERATION,
    SETUP_RESTART_HOW_BY_PROFILE,
    SETUP_RESTART_HOW_SELF,
    validate_next_result,
)

SETUP_NEXT_ANSWERS_FILENAME = "ocuclaw.setup-next.json"
SETUP_NEXT_ANSWERS_SCHEMA = 1
#: Keys the user's answers may set, and the values each takes.
SETUP_NEXT_ANSWER_KEYS: Mapping[str, Tuple[str, ...]] = {
    "host": ("cloudways", "other"),
    "tailscale": ("system", "plugin"),
    # #6942 · `jev` is add-only: an answers file written before it still reads the same.
    # #7189 · `card_tools` is add-only too. Setup no longer offers extras (Matt, 2026-11-14):
    # only a pick an older setup recorded is read, for its Jev or card-tools follow-up.
    "extras": ("voice", "even_ai", "jev", "bug_reports", "card_tools", "none"),
    # Step 7's skip (Matt, 2026-11-05): only a phone found later outranks it.
    "phone": ("skip",),
}
#: Moments the runner keeps beside the answers (epoch seconds). ``setupBegunAt``:
#: when this setup run's welcome line was said, so it is said once.
SETUP_NEXT_MOMENT_KEYS = ("restartedAt", "firstUseSince", "firstUseConfirmedAt", "setupBegunAt")
SETUP_NEXT_CHOICE_MAX = 64

# How long one call waits on a slow step before handing back ``working``. Every
# wait stays well inside Hermes's tool window.
NEXT_CERTIFICATE_WAIT_S = 45.0
#: The second, slower look at `tailscale status` after a timed-out one.
NEXT_TAILSCALE_RETRY_S = 8.0
NEXT_FIRST_USE_WAIT_S = 30.0
#: Step 9 · how long one call waits for the wearer's message, in a chat the
#: waiter (step9_wake.py) cannot wake: the agent calls again until the window
#: below ends;
#: the terminal's own wait for this message is longer still (wait_phone_origin).
NEXT_FIRST_MESSAGE_WAIT_S = 240.0
#: The first wait after step 9 asked is short: a real model chained straight
#: into the waiting call without relaying the lines that tell the wearer to
#: send (run 42582562511 and 42594298253, four silent minutes each), and it
#: did relay the answer that came back. So the second answer, which repeats
#: those lines, lands within seconds, before the long waits begin.
NEXT_FIRST_MESSAGE_FIRST_WAIT_S = 5.0
#: Then the phone's glasses receipt for that reply, as `first-use` waits for it.
NEXT_REPLY_RECEIPT_WAIT_S = 40.0
#: No message this long after step 9 asked for one is a stuck step.
FIRST_MESSAGE_WINDOW_S = 600.0
NEXT_PAIRING_WAIT_S = 20.0
NEXT_RESTART_WAIT_S = 45.0
NEXT_POLL_S = 1.0
#: A restart this recent may still be coming up: the read waits for it.
NEXT_RESTART_SETTLE_S = 180.0
#: How long a route this process saw answer counts as ready when a passive
#: read cannot tell.
NEXT_ROUTE_VERIFIED_S = 600.0
#: The restart starts this long after the call answered, so the reply is out.
NEXT_RESTART_DELAY_S = 2.0
#: Most decisions one call makes: each run at most once, plus the last read.
MAX_DECISIONS = 8

# The step a run belongs to, for a stuck report.
RUN_STEP = {
    "grant_access": "plugin_access",
    "restart": "loaded",
    "start_tailscale": "private_network",
    "enroll": "approve_machine",
    "issue_certificate": "private_route",
    "arm_first_use": "first_message",
    "await_first_message": "first_message",
}
RUN_FAILED_CODE = {
    "grant_access": "grant_access_failed",
    "restart": "restart_unavailable",
    "start_tailscale": "tailscale_start_failed",
    "enroll": "enroll_failed",
    "issue_certificate": "route_unreachable",
    "arm_first_use": "first_use_unavailable",
    "await_first_message": "first_use_unavailable",
}


# Step 3 when no service manager can restart Hermes for the person.
SAY_RESTART_YOURSELF = (
    "Now restart Hermes once so it loads OcuClaw. Open a second terminal and run hermes gateway restart.",
    "Hermes keeps running in that terminal afterwards, so leave it open.",
    "When it's back, come here and say continue.",
)

# `hermes ocuclaw setup-start` when OcuClaw and its settings are already loaded.
START_LOADED = "loaded"
SAY_START_LOADED = "OcuClaw is already loaded. Ask your agent to set it up."


class SetupNextError(Exception):
    """A refused or unanswerable ``next`` call. ``code`` is the stable identity."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def _record(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def stuck_report(
    step: str,
    code: str,
    checked: Optional[List[str]] = None,
    tried: Optional[List[str]] = None,
    detail: Any = None,
) -> Dict[str, Any]:
    line = SETUP_STUCK_SAY.get(code)
    say = [line] if line else []
    if isinstance(detail, str) and detail.strip():
        say.append(f"Details: {detail.strip()}")
    report: Dict[str, Any] = {"step": step, "code": code}
    if say:
        report["say"] = say
    report["checked"] = list(checked or [])
    report["tried"] = list(tried or [])
    return report


# -- the pure mapping ---------------------------------------------------------


def setup_next_profile(host: Mapping[str, Any], answers: Mapping[str, Any]) -> Tuple[str, bool]:
    """``(profile, hostLikely)`` from the host read and the user's own answer."""
    answered = answers.get("host") if isinstance(answers.get("host"), str) else None
    verdict = host.get("detect")
    host_likely = verdict == "likely" and answered is None
    # Cloudways first: Hermes Desktop can chat with a Cloudways box over its
    # saved SSH connection (Connect Desktop, #6370). The box is still
    # Cloudways, so it keeps Cloudways' own Tailscale and the container restart.
    if verdict == "cloudways" or answered == "cloudways":
        return "cloudways", False
    if host.get("surface") == "desktop":
        return "hermes-desktop", False
    if host.get("os") in ("darwin", "win32"):
        return "personal", host_likely
    return ("container" if host.get("container") is True else "server"), host_likely


def plugin_runs_tailscale(profile: str, answers: Mapping[str, Any]) -> bool:
    """Whether OcuClaw itself runs Tailscale here: always on Cloudways, else if the agent picked it."""
    return profile == "cloudways" or answers.get("tailscale") == "plugin"


def _download_os(os_name: Any) -> str:
    return "macos" if os_name == "darwin" else "windows" if os_name == "win32" else "linux"


def setup_next_access(mandatory: Mapping[str, Any]) -> str:
    """Step 2: OcuClaw's settings, Continue here included, read from setup status."""
    streaming = mandatory.get("streamingOn") is True or mandatory.get("streamingOffByChoice") is True
    granted = (
        mandatory.get("toolProgressOff") is True
        and mandatory.get("agentModeChosen") is True
        and mandatory.get("adoptConfigured") is True
        and streaming
        # Shared chats turned on after setup: the settings step writes queue mode.
        and mandatory.get("sharedChatsQueueOwed") is not True
    )
    return "granted" if granted else "missing"


def setup_next_loaded(loaded: Mapping[str, Any]) -> str:
    """Step 3. Saved code or settings the live gateway has not loaded need its restart."""
    if loaded.get("restartToFinish"):
        return "needs_restart"
    if loaded.get("markerSettled") is False:
        return "needs_restart"
    if loaded.get("live") is True and loaded.get("pluginLoaded") is True:
        return "yes"
    if loaded.get("live") is None:
        # This host cannot read the gateway at all: never a restart on a guess.
        return "yes"
    return "needs_restart"


def setup_next_tailscale(tailscale: Mapping[str, Any], plugin_run: bool, tailscaled_present: bool) -> Tuple[str, str]:
    """Steps 4 and 5: ``(tailscale, tailnet)``.

    The Tailscale OcuClaw runs is read from its daemon; the user's own from
    ``tailscale status``: no CLI is "absent", a node that isn't online is
    "stopped" (the user switches it on and signs in their way).
    """
    if plugin_run:
        state = tailscale.get("daemonState")
        if state == "running":
            return "running", "online"
        if state == "needs-authorization":
            # Signed in on a tailnet that approves devices: the admin approves it.
            return "running", ("needs_approval" if tailscale.get("backend") == "NeedsMachineAuth" else "needs_login")
        if state in ("starting", "stopped", "unknown"):
            return "stopped", "needs_login"
        return ("stopped" if tailscaled_present else "absent"), "needs_login"
    if tailscale.get("readCode") == "serve_cli_absent":
        return "absent", "needs_login"
    if tailscale.get("online") is True:
        return "running", "online"
    return "stopped", "needs_login"


def setup_next_phone_address(legs: Mapping[str, Any]) -> str:
    """The user's own phone address, when one is set (#5209)."""
    custom = legs.get("customRoute")
    if not isinstance(custom, Mapping):
        return "none"
    classification = custom.get("classification")
    if classification == "ready":
        return "ready"
    if classification == "wrong" or custom.get("configured") == "no":
        return "wrong"
    return "unverified"


def setup_next_route(route: Mapping[str, Any], receipts: Mapping[str, Any], verified: bool) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Step 6: ``(route, stuck)``, ``route`` one of ready, absent, issuing, conflict."""
    applied = _record(receipts.get(store.OPERATION_ROUTE))
    if applied.get("status") == "foreign":
        return "conflict", None
    classification = route.get("classification")
    if classification == "wrong":
        return "conflict", None
    if classification == "absent":
        return "absent", None
    if classification == "ready":
        reachable = route.get("reachable")
        if verified or (reachable == "yes" and route.get("applicationReady") != "no"):
            return "ready", None
        if reachable == "no" or route.get("applicationReady") == "no":
            return "absent", stuck_report("private_route", "route_unreachable", ["route reachability"])
        # Our route, set up, and nothing has answered yet: the certificate is
        # still on its way (a TLS alert says the same).
        return "issuing", None
    if applied.get("status") == "unreadable":
        return "absent", stuck_report("private_route", "route_unreadable", ["tailscale serve status"])
    return "absent", stuck_report("private_route", "route_unreadable", ["tailscale serve status"])


def setup_next_first_use(
    first_use: Mapping[str, Any],
    since: Any,
    answered_no: Optional[str],
    confirmed_at: Any = None,
    receipt_missing: Optional[str] = None,
    now: Any = None,
) -> str:
    """Step 9. An armed or committed proof is done: the welcome is not one of the nine.

    ``confirmed_at`` is when the wearer's yes (or the phone's receipt) armed the
    proof. An armed attempt expires after an hour, or when OcuClaw or Hermes is
    updated, while its welcome waits on a phone; the evidence stands, so setup
    stays done.

    Before that the wearer is ``sending``: nothing is asked until their message
    is in and the phone had its chance to report the glasses' receipt.
    ``receipt_missing`` names the turn whose receipt never came: only then is
    the wearer asked (``waiting``). No message within the window after step 9
    asked for one is ``no_message``.
    """
    if first_use.get("proven") is True or first_use.get("attemptState") in ("armed", "committed"):
        return "confirmed"
    if isinstance(confirmed_at, (int, float)) and not isinstance(confirmed_at, bool):
        return "confirmed"
    if not isinstance(since, (int, float)):
        return "not_armed"
    candidate = _record(first_use.get("candidate"))
    if candidate.get("state") == "ready":
        if candidate.get("runErrorCode"):
            return "model_error"
        if answered_no is not None and candidate.get("candidateId") == answered_no:
            return "answered_no"
        if receipt_missing is not None and candidate.get("candidateId") == receipt_missing:
            return "waiting"
        return "sending"
    if isinstance(now, (int, float)) and now - since >= FIRST_MESSAGE_WINDOW_S:
        return "no_message"
    return "sending"


def setup_next_first_use_left_min(since: Any, now: Any) -> Optional[int]:
    """Step 9: whole minutes left (rounded up) for the wearer's message, while
    the window after arming is open. None before the check began or once it
    is over. Every "still waiting" answer carries it, so no two of them are
    byte-identical: Hermes folds a repeated identical tool result into a note
    that it "has not changed", after which a real model ended its turn
    (run 42582562511)."""
    if isinstance(since, bool) or not isinstance(since, (int, float)):
        return None
    if isinstance(now, bool) or not isinstance(now, (int, float)):
        return None
    left = since + FIRST_MESSAGE_WINDOW_S - now
    if left <= 0:
        return None
    return int(math.ceil(left / 60.0))


# -- Tools for cards (#7189) ------------------------------------------------------

_CARD_TOOLS_SERVER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
SETUP_NEXT_CARD_TOOLS_MAX_SERVERS = 32


def setup_next_card_tools(answers: Any, tools: Any) -> Optional[Dict[str, Any]]:
    """Where "Tools for cards" is, once the user picked the ``card_tools`` extra; None
    otherwise. ``tools`` is the relay's read-only ``program_cards.tools.facts`` answer:
    ``{cards, mcp, known, reason, servers: [{name, connected, cards}]}``. Names and those
    two states only reach the decider (SECURITY-RULED on #7171, change 6). The host
    commands list (server ``host``) is no MCP server of the user's and is left out. What
    cannot be read is ``unknown``, never a guess. The twin of setup-next.ts's
    ``setupNextCardTools``."""
    if not isinstance(answers, Mapping) or answers.get("extras") != "card_tools":
        return None

    def none(state: str) -> Dict[str, Any]:
        return {"state": state, "servers": []}

    if not isinstance(tools, Mapping) or type(tools.get("cards")) is not bool or type(tools.get("mcp")) is not bool:
        return none("unknown")
    if not tools["cards"]:
        return none("cards_off")
    if not tools["mcp"]:
        return none("switch_off")
    if isinstance(tools.get("reason"), str) and tools["reason"]:
        return none("unavailable")
    if tools.get("known") is not True or not isinstance(tools.get("servers"), list):
        return none("unknown")
    rows = [
        {"name": row["name"], "connected": row.get("connected") is True, "cards": row.get("cards") is True}
        for row in tools["servers"]
        if isinstance(row, Mapping)
        and isinstance(row.get("name"), str)
        and _CARD_TOOLS_SERVER.fullmatch(row["name"])
        and row["name"] != "host"
    ]
    if not rows:
        return none("no_servers")
    # "Every server is on" is said of the whole list, never of the part that fits.
    return {
        "state": "all_on" if all(row["cards"] for row in rows) else "pick",
        "servers": rows[:SETUP_NEXT_CARD_TOOLS_MAX_SERVERS],
    }


# -- Jev (#6942) ----------------------------------------------------------------


def jev_setup_from_status(status: Any) -> Optional[Dict[str, Any]]:
    """The four booleans ``next`` needs from ``optional_setup.status()``, plus its
    ``jevCheck``. Presence and loaded state only, never the key. None when the
    status can't be read."""
    if not isinstance(status, Mapping) or status.get("state") != "ready":
        return None
    diagnostics = _record(status.get("diagnostics"))
    typesafe = _record(status.get("capabilities")).get("typesafe")
    key_available = diagnostics.get("liveuiJevKeyAvailable")
    active = diagnostics.get("activeLiveuiJev")
    return {
        "keyAvailable": key_available if isinstance(key_available, bool) else None,
        # A key the host env supplies (nothing saved) has no saved-versus-loaded gap.
        "keyLoaded": (
            True if typesafe == "available_to_test"
            else False if typesafe in ("saved_not_activated", "removed_not_activated")
            else None
        ),
        "switchOn": diagnostics.get("liveuiJev") is True,
        "switchLoaded": active if isinstance(active, bool) else None,
        "check": status.get("jevCheck") if isinstance(status.get("jevCheck"), str) else None,
    }


def setup_next_jev(answers: Mapping[str, Any], setup: Any, check: Any) -> Optional[str]:
    """Where Jev's setup is, once the user picked the ``jev`` extra; None otherwise.

    ``setup`` is ``jev_setup_from_status``'s shape, ``check`` the last check's
    result. A check from before the saved key loaded is stale and never counts.
    The OpenClaw lane's ``setupNextJev`` maps the same way.
    """
    if not isinstance(answers, Mapping) or answers.get("extras") != "jev":
        return None
    if not isinstance(setup, Mapping) or not isinstance(setup.get("switchOn"), bool):
        return "unknown"
    if setup.get("keyAvailable") is not True:
        return "no_key" if setup.get("keyAvailable") is False else "unknown"
    fresh = setup.get("keyLoaded") is not False
    if not setup["switchOn"]:
        return "key_rejected" if fresh and check == "key_rejected" else "key_saved"
    if not fresh or setup.get("switchLoaded") is not True:
        return "loading"
    if check in ("working", "key_rejected", "unreachable"):
        return check
    return "not_checked"


def setup_next_facts(read: Mapping[str, Any]) -> Dict[str, Any]:
    """The decider's facts, from what the reader collected. Pure.

    ``read``: ``host``, ``answers``, ``mandatory``, ``accessGranted``,
    ``loaded``, ``restarted``, ``tailscale``, ``tailscaledPresent``, ``legs``,
    ``route``, ``routeVerified``, ``receipts``, ``https``, ``httpsEnableUrl``,
    ``enrollUrl``, ``routeCommand``, ``routeBinding``, ``phone``,
    ``pairingCompleted``, ``pairing``, ``firstUse``, ``answeredNo``, ``stuck``,
    ``jevSetup``.
    """
    host = _record(read.get("host"))
    answers = _record(read.get("answers"))
    legs = _record(read.get("legs"))
    profile, host_likely = setup_next_profile(host, answers)
    plugin_run = plugin_runs_tailscale(profile, answers)
    tailscale, tailnet = setup_next_tailscale(
        _record(read.get("tailscale")), plugin_run, read.get("tailscaledPresent") is True
    )
    route, route_stuck = setup_next_route(
        _record(read.get("route")), _record(read.get("receipts")), read.get("routeVerified") is True
    )
    first_use_read = _record(read.get("firstUse"))
    first_use = setup_next_first_use(
        first_use_read,
        answers.get("firstUseSince"),
        read.get("answeredNo"),
        answers.get("firstUseConfirmedAt"),
        read.get("receiptMissing") if isinstance(read.get("receiptMissing"), str) else None,
        read.get("now"),
    )
    # An armed proof's welcome is on the glasses until the double-tap commits it.
    welcome = (
        "pending"
        if first_use_read.get("attemptState") == "armed" and first_use_read.get("proven") is not True
        else "none"
    )
    # Only a live proof shows a phone paired. The wearer's stored yes keeps
    # step 9 done, but it is a line in the answers file: it outlives an
    # unpairing, and on an older OcuClaw it outlived an uninstall, so on its
    # own it must not skip step 8.
    proven_first_use = setup_next_first_use(
        _record(read.get("firstUse")), answers.get("firstUseSince"), read.get("answeredNo")
    )
    pairing = _record(read.get("pairing"))
    # A phone app connected to the relay right now has paired and reached the route.
    phone_connected = _record(legs.get("phoneApp")).get("state") == "healthy"
    paired = (
        phone_connected
        or read.get("pairingCompleted") is True
        or pairing.get("state") == "completed"
        or proven_first_use == "confirmed"
    )
    phone_read = read.get("phone")
    seen_phone = (
        "present"
        if phone_connected or phone_read is True
        else "absent"
        if phone_read is False
        else "unknown"
    )
    phone = "skipped" if seen_phone != "present" and answers.get("phone") == "skip" else seen_phone
    https = read.get("https") if read.get("https") in ("on", "off") else "unknown"
    stuck = read.get("stuck") if isinstance(read.get("stuck"), Mapping) else route_stuck
    access = "granted" if read.get("accessGranted") is True else setup_next_access(_record(read.get("mandatory")))
    words = pairing.get("words")
    return {
        "lane": "hermes",
        "profile": profile,
        "interface": str(host.get("surface") or ""),
        "approvals": host.get("approvalsBypassed") is not True,
        "hostLikely": host_likely,
        # The agent answering at all shows the model works (#6397 row 3).
        "model": "signed_in",
        "access": access,
        "loaded": setup_next_loaded(_record(read.get("loaded"))),
        "restarted": read.get("restarted") is True,
        "phoneAddress": setup_next_phone_address(legs),
        "tailscale": tailscale,
        "tailscaleChoice": answers.get("tailscale"),
        # #6482 · true only in the call whose Tailscale start adopted Cloudways' daemon.
        "tailscaleAdopted": read.get("tailscaleAdopted") is True,
        "tailscaleFacts": {
            "os": str(host.get("os") or "unknown"),
            "container": host.get("container") is True,
            "systemd": host.get("systemd") if isinstance(host.get("systemd"), bool) else None,
            # Installed: a CLI that answers, or binaries OcuClaw can run (#6405).
            "tailscaleInstalled": tailscale != "absent" or read.get("tailscaledPresent") is True,
        },
        "os": _download_os(host.get("os")),
        "tailnet": tailnet,
        "enrollUrl": read.get("enrollUrl") if isinstance(read.get("enrollUrl"), str) and read.get("enrollUrl") else None,
        "https": https,
        "httpsEnableUrl": (
            read.get("httpsEnableUrl")
            if isinstance(read.get("httpsEnableUrl"), str) and read.get("httpsEnableUrl")
            else None
        ),
        "route": route,
        "routeCommand": read.get("routeCommand") if isinstance(read.get("routeCommand"), str) else None,
        "routeBinding": read.get("routeBinding") if isinstance(read.get("routeBinding"), str) else None,
        "phone": phone,
        "paired": paired,
        "pairingWords": list(words) if isinstance(words, (list, tuple)) else None,
        "pairingBinding": pairing.get("binding") if isinstance(pairing.get("binding"), str) else None,
        "firstUse": first_use,
        # A wait for the wearer's message already ran with nothing yet.
        "firstUseWaited": read.get("firstUseWaited") is True,
        # A waiter will wake this chat when the message is in: end the turn.
        "firstUseWake": "armed" if read.get("firstUseWake") == "armed" else None,
        "firstUseLeftMin": setup_next_first_use_left_min(answers.get("firstUseSince"), read.get("now")),
        "welcome": welcome,
        # The first result of this setup run says the welcome line; once said, it is recorded.
        "beginning": not isinstance(answers.get("setupBegunAt"), float),
        "jev": setup_next_jev(answers, read.get("jevSetup"), _record(read.get("jevSetup")).get("check")),
        "cardTools": setup_next_card_tools(answers, read.get("cardTools")),
        "stuck": dict(stuck) if isinstance(stuck, Mapping) else None,
    }


def _says_beginning(result: Mapping[str, Any]) -> bool:
    """Whether a ``next`` result opens with setup's welcome line."""
    say = result.get("say")
    return isinstance(say, list) and bool(say) and say[0] == SAY_BEGINNING


def setup_next_receipt_stuck(receipts: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """A stuck report from a receipt #6378's operations returned since the last
    ``next``, for the few endings re-asking would loop on. None otherwise."""
    route = _record(receipts.get(store.OPERATION_ROUTE))
    if route.get("status") == "failed":
        return stuck_report("private_route", "route_failed", ["tailscale serve"], ["the approved route command"], route.get("detail"))
    if route.get("status") == "certificate_refused":
        return stuck_report("private_route", "certificate_refused", ["tailscale cert"], ["the approved route command"])
    if route.get("status") == "declined":
        return stuck_report("private_route", "route_declined", ["route approval"])
    confirm = _record(receipts.get(store.OPERATION_PAIRING))
    if confirm.get("status") == "failed":
        return stuck_report("pair", "pairing_failed", ["pairing exchange"])
    code = _record(receipts.get(store.OPERATION_CODE))
    if code.get("status") == "phone_codes_unavailable":
        return stuck_report("pair", "pairing_unavailable", ["phone codes"])
    if code.get("status") == "not_ready":
        return stuck_report("pair", "pairing_not_ready", ["relay"])
    if code.get("status") == "failed":
        return stuck_report("pair", "pairing_failed", ["pairing exchange"])
    return None


# -- the answers file ---------------------------------------------------------


def read_setup_next_answers(state_dir: Any) -> Dict[str, Any]:
    if not isinstance(state_dir, str) or not state_dir:
        return {}
    try:
        document = json.loads((Path(state_dir) / SETUP_NEXT_ANSWERS_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return {}
    if (
        not isinstance(document, dict)
        or document.get("schemaVersion") != SETUP_NEXT_ANSWERS_SCHEMA
        or not isinstance(document.get("answers"), dict)
    ):
        return {}
    raw = document["answers"]
    answers: Dict[str, Any] = {}
    for key, values in SETUP_NEXT_ANSWER_KEYS.items():
        if isinstance(raw.get(key), str) and raw[key] in values:
            answers[key] = raw[key]
    for key in SETUP_NEXT_MOMENT_KEYS:
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            answers[key] = float(value)
    return answers


def write_setup_next_answers(state_dir: Any, patch: Mapping[str, Any]) -> Dict[str, Any]:
    if not isinstance(state_dir, str) or not state_dir:
        raise SetupNextError("setup_state_unavailable", "no setup state folder")
    answers = {**read_setup_next_answers(state_dir), **dict(patch)}
    answers = {key: value for key, value in answers.items() if value is not None}
    folder = Path(state_dir)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = folder / SETUP_NEXT_ANSWERS_FILENAME
    temp = folder / f"{SETUP_NEXT_ANSWERS_FILENAME}.{os.getpid()}.tmp"
    body = json.dumps({"schemaVersion": SETUP_NEXT_ANSWERS_SCHEMA, "answers": answers}, indent=2) + "\n"
    descriptor = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(body)
    os.replace(str(temp), str(target))
    return answers


# -- params -------------------------------------------------------------------


def validate_setup_next_params(params: Any) -> None:
    ok = (
        isinstance(params, Mapping)
        and params.get("operation") == SETUP_NEXT_OPERATION
        and all(key in ("operation", "choice") for key in params)
        and (
            params.get("choice") is None
            or (isinstance(params.get("choice"), str) and 0 < len(params["choice"]) <= SETUP_NEXT_CHOICE_MAX)
        )
    )
    if not ok:
        raise SetupNextError("invalid_input", "next takes only an optional choice")


# -- the runner ---------------------------------------------------------------


@dataclass
class _Memory:
    """Per state folder, in memory. What only this process knows."""

    #: The approval link Tailscale gave.
    enroll_url: Optional[str] = None
    #: When the last ``next`` answered (ms, the store's receipt clock).
    last_next_at: int = 0
    #: The phone turn the wearer said they didn't see.
    answered_no: Optional[str] = None
    #: The last answer was a stuck first message: the next call starts afresh.
    retry_first_use: bool = False
    #: A settings grant this process made, which its config read may lag.
    access_granted: bool = False
    #: When this process last saw the route answer (seconds).
    route_verified_at: float = 0.0
    #: This call's Tailscale start adopted Cloudways' own daemon (#6482).
    adopted_now: bool = False
    #: Step 9 · the phone turn whose glasses receipt never came: ask the wearer.
    receipt_missing: Optional[str] = None
    #: Step 9 · how many waits for the wearer's message ran with nothing yet.
    #: The first is short (NEXT_FIRST_MESSAGE_FIRST_WAIT_S), the rest long.
    first_use_waits: int = 0
    #: Step 9 · the background waiter that wakes this chat (step9_wake.py).
    first_use_wake: Optional[str] = None


_MEMORY: Dict[str, _Memory] = {}
_MEMORY_LOCK = threading.Lock()


def _memory_for(state_dir: Any) -> _Memory:
    key = state_dir if isinstance(state_dir, str) else ""
    with _MEMORY_LOCK:
        entry = _MEMORY.get(key)
        if entry is None:
            entry = _MEMORY[key] = _Memory()
        return entry


def reset_setup_next_memory_for_tests() -> None:
    with _MEMORY_LOCK:
        _MEMORY.clear()


def _settle(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        return fn(*args, **kwargs)
    except Exception:  # noqa: BLE001 - a failed read observed nothing
        return None


@dataclass
class SetupNextDeps:
    """Everything ``next`` reads or runs. Each read returns plain data; each may raise."""

    state_dir: Callable[[], str]
    #: ``{surface, detect, os, container, systemd, approvalsBypassed}``.
    read_host: Callable[[], Mapping[str, Any]]
    #: ``status.mandatoryConfiguration``.
    read_mandatory: Callable[[], Mapping[str, Any]]
    #: ``{restartToFinish, markerSettled, live, pluginLoaded}``.
    read_loaded: Callable[[], Mapping[str, Any]]
    #: plugin-run: ``{daemonState}``; the user's own: ``{readCode, online}``.
    read_tailscale: Callable[[bool], Mapping[str, Any]]
    tailscaled_present: Callable[[], bool]
    #: The snapshot's ``currentHealth.legs``.
    read_legs: Callable[[], Mapping[str, Any]]
    #: ``{classification, reachable, applicationReady, dnsName}``.
    read_route: Callable[[], Mapping[str, Any]]
    #: ``"on" | "off" | "unknown"`` for this node's tailnet name.
    read_https: Callable[[Optional[str]], str]
    read_https_enable_url: Callable[[bool], Optional[str]]
    route_command: Callable[[], str]
    #: True, False, or None when it cannot tell.
    read_phone: Callable[[], Optional[bool]]
    read_pairing_completed: Callable[[], bool]
    #: ``{proven, attemptState}``.
    read_first_use: Callable[[], Mapping[str, Any]]
    #: ``(since) -> {state, candidateId?, runErrorCode?}``, only turns at or after ``since``.
    read_candidate: Callable[[float], Mapping[str, Any]]
    #: ``(since, timeout_s) -> {state, received, candidateId?, runErrorCode?}``.
    wait_candidate: Callable[[float, float], Mapping[str, Any]]
    #: ``(candidate_id, evidence="wearer_confirmed") -> {state, armed?, committed?}``;
    #: evidence ``client_sdk_receipt`` when the phone reported the glasses' receipt.
    arm_from_candidate: Callable[..., Mapping[str, Any]]
    #: Settings, Continue here included. None, or a stuck code.
    grant_access: Callable[[], Optional[str]]
    #: ``(how) -> bool``: True once the restart is scheduled after this answer.
    restart: Callable[[str], bool]
    start_tailscale: Callable[[], Mapping[str, Any]]
    enroll: Callable[[], Mapping[str, Any]]
    #: ``(budget_s) -> {outcome: reachable | refused | waiting}``.
    issue_certificate: Callable[[float], Mapping[str, Any]]
    pending_route_approval: Callable[[str, str], Mapping[str, Any]] = store.pending_route_approval
    pending_pairing: Callable[[str], Optional[Mapping[str, Any]]] = store.pending_pairing
    pairing_status: Callable[[str], Mapping[str, Any]] = store.pairing_status
    last_setup_receipt: Callable[[str, str], Optional[Mapping[str, Any]]] = store.last_setup_receipt
    #: ``(candidate_id, timeout_s) -> {status, reason?}``: the phone's glasses
    #: receipt for that turn's reply (``status: sdk_accepted``). None: no receipts.
    wait_delivery: Optional[Callable[[str, float], Mapping[str, Any]]] = None
    #: #6942 · ``optional_setup.status()``, read only once the user picked Jev.
    #: None: Jev's state reads as unknown.
    read_jev_status: Optional[Callable[[], Mapping[str, Any]]] = None
    #: #7189 · ``({servers: bool}) -> {cards, mcp[, known, reason, servers]}``: the
    #: relay's read-only "Tools for cards" facts, read only once a phone is paired.
    #: None, or a None answer: the extra is not offered and its state is unknown.
    read_card_tools: Optional[Callable[[Mapping[str, Any]], Optional[Mapping[str, Any]]]] = None
    #: Step 9 · ``(since, deadline) -> process id | None``: start the waiter
    #: that wakes this chat once the wearer's message is in (step9_wake.py).
    #: None, or a None answer: the waiting ``next`` call instead.
    start_first_message_wake: Optional[Callable[[float, float], Optional[str]]] = None
    #: ``(process id) -> bool``: that waiter still runs.
    first_message_wake_running: Optional[Callable[[str], bool]] = None
    now: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep


class SetupNext:
    """``next`` for the ``ocuclaw_setup`` tool: ``SetupNext(deps).call(params) -> result``."""

    def __init__(self, deps: SetupNextDeps) -> None:
        self.d = deps

    # -- reads --

    def _read_pairing(self, state_dir: str, fresh_code: bool) -> Dict[str, Any]:
        """Wait for the phone's words after a code went in, or for an approved
        pairing to finish. Bounded; returns the last pairing read."""
        d = self.d
        deadline = d.now() + NEXT_PAIRING_WAIT_S
        while True:
            words = _settle(d.pending_pairing, state_dir)
            state = _record(_settle(d.pairing_status, state_dir)).get("state")
            if isinstance(words, Mapping) and words.get("words"):
                return {"state": state, "words": list(words["words"]), "binding": words.get("binding")}
            waiting = (state == "waiting_for_phone" and fresh_code) or state == "approved"
            if not waiting or d.now() >= deadline:
                return {"state": state}
            d.sleep(NEXT_POLL_S)

    def _read_loaded(self, answers: Mapping[str, Any]) -> Dict[str, Any]:
        """The gateway read, waiting a little for a restart this setup started."""
        d = self.d
        loaded = _record(_settle(d.read_loaded))
        restarted_at = answers.get("restartedAt")
        if setup_next_loaded(loaded) == "yes" or not isinstance(restarted_at, float):
            return loaded
        if d.now() - restarted_at > NEXT_RESTART_SETTLE_S:
            return loaded
        deadline = d.now() + NEXT_RESTART_WAIT_S
        while d.now() < deadline:
            d.sleep(NEXT_POLL_S)
            loaded = _record(_settle(d.read_loaded))
            if setup_next_loaded(loaded) == "yes":
                break
        return loaded

    def _read(self, state_dir: str, mem: _Memory, run_stuck: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        d = self.d
        answers = read_setup_next_answers(state_dir)
        host = _settle(d.read_host)
        if not isinstance(host, Mapping):
            raise SetupNextError("setup_unavailable", "the setup state could not be read; call next again")
        loaded = self._read_loaded(answers)
        if setup_next_loaded(loaded) == "yes" and "restartedAt" in answers:
            answers = write_setup_next_answers(state_dir, {"restartedAt": None})
        base: Dict[str, Any] = {
            "host": host,
            "answers": answers,
            "mandatory": _settle(d.read_mandatory),
            "accessGranted": mem.access_granted,
            "loaded": loaded,
            "restarted": "restartedAt" in answers,
            "tailscaledPresent": bool(_settle(d.tailscaled_present)),
            "legs": _settle(d.read_legs),
            "enrollUrl": mem.enroll_url,
            "answeredNo": mem.answered_no,
            "receiptMissing": mem.receipt_missing,
            "firstUseWaited": mem.first_use_waits > 0,
            "now": d.now(),
            "tailscaleAdopted": mem.adopted_now,
            "routeVerified": d.now() - mem.route_verified_at < NEXT_ROUTE_VERIFIED_S,
        }
        # #6942 · Jev's progress, read only once the user picked it.
        if answers.get("extras") == "jev" and d.read_jev_status is not None:
            base["jevSetup"] = jev_setup_from_status(_settle(d.read_jev_status))
        profile, _ = setup_next_profile(_record(host), answers)
        plugin_run = plugin_runs_tailscale(profile, answers)
        base["tailscale"] = _settle(d.read_tailscale, plugin_run)
        facts = setup_next_facts(base)
        if facts["tailnet"] == "online":
            mem.enroll_url = None
            base["enrollUrl"] = None
        receipts: Dict[str, Any] = {}
        for op in (store.OPERATION_ROUTE, store.OPERATION_PAIRING, store.OPERATION_CODE):
            last = _settle(d.last_setup_receipt, state_dir, op)
            if isinstance(last, Mapping) and float(last.get("at") or 0) > mem.last_next_at:
                receipts[op] = dict(last)
        base["receipts"] = receipts
        custom_route = facts["phoneAddress"] != "none"
        if not custom_route and facts["tailnet"] == "online":
            route = _record(_settle(d.read_route))
            base["route"] = route
            if setup_next_route(route, receipts, base["routeVerified"])[0] == "absent":
                # Step 6 facts, only while the route is still to make.
                route_receipt = _record(receipts.get(store.OPERATION_ROUTE))
                base["https"] = (
                    "off"
                    if route_receipt.get("status") == "https_off"
                    else _settle(d.read_https, route.get("dnsName"))
                )
                if base["https"] == "off":
                    base["httpsEnableUrl"] = _settle(d.read_https_enable_url, plugin_run)
                command = _settle(d.route_command)
                if isinstance(command, str) and command:
                    base["routeCommand"] = command
                    approval = _settle(d.pending_route_approval, state_dir, command)
                    base["routeBinding"] = _record(approval).get("binding")
        facts = setup_next_facts(base)
        # Step 7 and 8 facts, once the route is ready.
        if not custom_route and facts["route"] == "ready":
            base["phone"] = _settle(d.read_phone)
        base["pairingCompleted"] = bool(_settle(d.read_pairing_completed))
        facts = setup_next_facts(base)
        # #7189 · the host's servers, read once the phone is paired, for a host whose
        # user already picked "Tools for cards".
        if d.read_card_tools is not None and answers.get("extras") == "card_tools" and facts["paired"]:
            base["cardTools"] = _settle(d.read_card_tools, {"servers": True})
        if not facts["paired"] and (custom_route or facts["route"] == "ready"):
            base["pairing"] = self._read_pairing(state_dir, store.OPERATION_CODE in receipts)
        first_use = _record(_settle(d.read_first_use))
        since = answers.get("firstUseSince")
        if isinstance(since, float):
            first_use["candidate"] = _settle(d.read_candidate, since)
        base["firstUse"] = first_use
        # The waiter wakes this chat, so step 9 can end the turn: only while it
        # runs and the message is not in yet (then this call checks it).
        candidate_ready = _record(first_use.get("candidate")).get("state") == "ready"
        base["firstUseWake"] = (
            "armed"
            if mem.first_use_wake and not candidate_ready and d.first_message_wake_running is not None
            and bool(_settle(d.first_message_wake_running, mem.first_use_wake))
            else None
        )
        base["stuck"] =run_stuck if run_stuck is not None else setup_next_receipt_stuck(receipts)
        return setup_next_facts(base)

    # -- the user's answer --

    def _answer(self, state_dir: str, mem: _Memory, result: Mapping[str, Any], choice: str) -> None:
        """Record the answer to the open question; one that isn't open changes nothing."""
        d = self.d
        user_input = _record(result.get("input"))
        options = user_input.get("options")
        if user_input.get("kind") != "choice" or not isinstance(options, list):
            return
        ids = [str(_record(option).get("id")) for option in options]
        if choice not in ids:
            raise SetupNextError("invalid_input", f"choice must be one of {', '.join(ids)}")
        step = result.get("step")
        if step == "host_model":
            write_setup_next_answers(state_dir, {"host": choice})
        elif step == "private_network":
            write_setup_next_answers(state_dir, {"tailscale": choice})
        elif step == "phone_on_tailnet" and choice == "skip":
            write_setup_next_answers(state_dir, {"phone": "skip"})
        elif step == "first_message":
            since = read_setup_next_answers(state_dir).get("firstUseSince")
            if not isinstance(since, float):
                return
            # The wearer's own answer about the reply, bound to that reply.
            waited = _record(_settle(d.wait_candidate, since, NEXT_FIRST_USE_WAIT_S))
            candidate_id = waited.get("candidateId")
            if waited.get("received") is not True or not isinstance(candidate_id, str):
                return
            if choice == "no":
                mem.answered_no = candidate_id
                return
            mem.answered_no = None
            armed = _record(_settle(d.arm_from_candidate, candidate_id))
            if armed.get("armed") is True or armed.get("committed") is True:
                write_setup_next_answers(state_dir, {"firstUseConfirmedAt": d.now()})

    # -- runs --

    def _await_first_message(self, state_dir: str, mem: _Memory) -> None:
        """Step 9's wait, as `hermes ocuclaw first-use` does it: the wearer's
        message, then the phone's glasses receipt for the reply. A receipt arms
        the proof (the gateway then shows the welcome); no receipt leaves the
        wearer's Yes/No. An errored run is left for the facts to report."""
        d = self.d
        answers = read_setup_next_answers(state_dir)
        since = answers.get("firstUseSince")
        if not isinstance(since, float):
            return
        candidate = _record(_settle(d.read_candidate, since))
        if candidate.get("state") != "ready":
            left = since + FIRST_MESSAGE_WINDOW_S - d.now()
            if left <= 0:
                return
            wait_s = NEXT_FIRST_MESSAGE_FIRST_WAIT_S if mem.first_use_waits == 0 else NEXT_FIRST_MESSAGE_WAIT_S
            candidate = _record(_settle(d.wait_candidate, since, min(wait_s, left)))
            if candidate.get("received") is not True:
                mem.first_use_waits += 1
                return
        candidate_id = candidate.get("candidateId")
        if not isinstance(candidate_id, str) or candidate.get("runErrorCode"):
            return
        if mem.receipt_missing == candidate_id or mem.answered_no == candidate_id:
            return
        delivery = (
            _record(_settle(d.wait_delivery, candidate_id, NEXT_REPLY_RECEIPT_WAIT_S))
            if d.wait_delivery is not None
            else {}
        )
        if delivery.get("status") == "sdk_accepted":
            armed = _record(_settle(d.arm_from_candidate, candidate_id, "client_sdk_receipt"))
            if armed.get("armed") is True or armed.get("committed") is True:
                write_setup_next_answers(state_dir, {"firstUseConfirmedAt": d.now()})
                return
        # No receipt (none sent, simulator refused, an errored run or a stale
        # arm): the wearer's own word decides.
        mem.receipt_missing = candidate_id

    def _run(self, name: str, facts: Mapping[str, Any], state_dir: str, mem: _Memory) -> Optional[Dict[str, Any]]:
        d = self.d
        step = RUN_STEP.get(name, "plugin_access")
        try:
            if name == "grant_access":
                code = d.grant_access()
                if code:
                    return stuck_report(step, str(code), ["OcuClaw settings"], ["turn on OcuClaw's settings"])
                mem.access_granted = True
                return None
            if name == "restart":
                how = SETUP_RESTART_HOW_BY_PROFILE.get(str(facts.get("profile")))
                if how != "desktop_card" and not d.restart(str(how)):
                    return stuck_report(step, "restart_unavailable", ["gateway restart plan"])
                write_setup_next_answers(state_dir, {"restartedAt": d.now()})
                return None
            if name == "start_tailscale":
                report = _record(d.start_tailscale())
                failed = (
                    not report
                    or report.get("ok") is False
                    or bool(report.get("error"))
                    or report.get("action") in ("start-failed", "refused", "absent")
                )
                if not failed:
                    # #6482 · install adopted Cloudways' own running daemon.
                    if isinstance(report.get("adopted"), Mapping):
                        mem.adopted_now = True
                    return None
                detail = report.get("error") if isinstance(report.get("error"), str) else report.get("detail")
                return stuck_report(
                    step, "tailscale_start_failed", ["tailscaled"], ["start Tailscale"],
                    detail[:160] if isinstance(detail, str) else None,
                )
            if name == "enroll":
                report = _record(d.enroll())
                url = report.get("authUrl")
                if isinstance(url, str) and url.startswith("https://"):
                    mem.enroll_url = url
                    return None
                if report.get("ok") is True:
                    return None
                return stuck_report(step, "enroll_failed", ["tailscale up"], ["ask Tailscale for the approval link"])
            if name == "issue_certificate":
                waited = _record(d.issue_certificate(NEXT_CERTIFICATE_WAIT_S))
                if waited.get("outcome") == "refused":
                    return stuck_report(step, "certificate_refused", ["tailscale cert"], ["wait for the certificate"])
                if waited.get("outcome") == "reachable":
                    mem.route_verified_at = d.now()
                return None
            if name == "arm_first_use":
                # From now on, a phone turn counts as the first message.
                write_setup_next_answers(state_dir, {"firstUseSince": d.now()})
                mem.receipt_missing = None
                mem.first_use_waits = 0
                mem.first_use_wake = None
                if d.start_first_message_wake is not None:
                    since = read_setup_next_answers(state_dir).get("firstUseSince")
                    if isinstance(since, float):
                        started = _settle(d.start_first_message_wake, since, since + FIRST_MESSAGE_WINDOW_S)
                        mem.first_use_wake = started if isinstance(started, str) and started else None
                return None
            if name == "await_first_message":
                self._await_first_message(state_dir, mem)
                return None
        except SetupNextError:
            raise
        except Exception:  # noqa: BLE001 - a run that throws is a stuck step, said plainly
            return stuck_report(step, RUN_FAILED_CODE.get(name, "grant_access_failed"), [], [name.replace("_", " ")])
        return None

    # -- the call --

    def call(self, params: Any) -> Dict[str, Any]:
        validate_setup_next_params(params)
        d = self.d
        state_dir = d.state_dir()
        if not isinstance(state_dir, str) or not state_dir:
            raise SetupNextError("setup_unavailable", "this Hermes has no profile state folder")
        mem = _memory_for(state_dir)
        if mem.retry_first_use:
            # After a stuck first message the agent has troubleshot; this call
            # starts a fresh check, so the fix is proven with a new message.
            mem.retry_first_use = False
            mem.answered_no = None
            mem.receipt_missing = None
            mem.first_use_waits = 0
            mem.first_use_wake = None
            write_setup_next_answers(state_dir, {"firstUseSince": None})
        if params.get("choice") is not None:
            first = decide_next(self._read(state_dir, mem, None))[0]
            self._answer(state_dir, mem, first, str(params["choice"]))
        run_stuck: Optional[Dict[str, Any]] = None
        mem.adopted_now = False
        ran: set = set()
        result: Dict[str, Any] = {}
        for _ in range(MAX_DECISIONS):
            facts = self._read(state_dir, mem, run_stuck)
            result, next_run = decide_next(facts)
            if not next_run or next_run in ran or run_stuck is not None:
                break
            if next_run == "await_first_message" and "arm_first_use" in ran:
                # The call that asks for the message answers at once, so the
                # wearer reads what to do; the agent's next call waits.
                break
            ran.add(next_run)
            run_stuck = self._run(next_run, facts, state_dir, mem)
            if next_run == "restart" and run_stuck is None:
                # The restarting result is the answer: the restart starts after it.
                break
            if next_run == "restart" and _record(run_stuck).get("code") == "restart_unavailable":
                # Nothing here can restart Hermes for the person: no service
                # manager, which is the usual case for a gateway running in its
                # own terminal window. That is the expected path on such a
                # machine, not a stuck step, so it stays the one restart, with
                # the exact command, and "continue" picks setup up again. The
                # record says so too: ``how`` "self" is the person's restart,
                # where "platform" promised one this process would make (run
                # 42559929824 waited 120 s for it).
                result = {
                    **result,
                    # The welcome line stays ahead of the person's own restart.
                    "say": [*([SAY_BEGINNING] if _says_beginning(result) else []), *SAY_RESTART_YOURSELF],
                    "restart": {**_record(result.get("restart")), "how": SETUP_RESTART_HOW_SELF},
                }
                write_setup_next_answers(state_dir, {"restartedAt": d.now()})
                break
        mem.last_next_at = int(d.now() * 1000)
        # The welcome line went out: never again in this setup run.
        if _says_beginning(result):
            write_setup_next_answers(state_dir, {"setupBegunAt": d.now()})
        stuck_code = _record(result.get("stuck")).get("code")
        mem.retry_first_use = result.get("step") == "first_message" and stuck_code in (
            "reply_not_shown",
            "model_error",
            "first_message_missing",
        )
        check = validate_next_result(result)
        if not check.get("ok"):
            raise SetupNextError("setup_next_invalid", str(check.get("error")))
        return result

    # -- before Hermes has loaded the plugin --

    def start(self) -> Dict[str, Any]:
        """Steps 2 and 3 for a plugin Hermes has not loaded yet (#7548).

        An agent that installs OcuClaw from a chat has no ``ocuclaw_setup`` tool
        until Hermes restarts, so ``hermes ocuclaw setup-start`` runs this from
        the command line: OcuClaw's settings first, then the one restart, which
        loads the plugin and its settings together. ``next`` then starts at
        step 4. It asks nothing and reads nothing past step 3.

        The answer is the decider's own ``next`` result for that restart (its
        words, its ``restart`` record), a stuck settings step, or
        ``{"status": "loaded"}`` when there is nothing left to load.
        """
        d = self.d
        state_dir = d.state_dir()
        if not isinstance(state_dir, str) or not state_dir:
            raise SetupNextError("setup_unavailable", "this Hermes has no profile state folder")
        mem = _memory_for(state_dir)
        host = _settle(d.read_host)
        if not isinstance(host, Mapping):
            raise SetupNextError("setup_unavailable", "the setup state could not be read; run it again")
        profile, _ = setup_next_profile(_record(host), read_setup_next_answers(state_dir))
        if profile == "hermes-desktop":
            # Desktop's restart card belongs to the loaded plugin. Before that
            # this is an ordinary machine's restart.
            profile = "personal"
        facts: Dict[str, Any] = {"lane": "hermes", "profile": profile, "access": "granted", "loaded": "needs_restart"}
        if setup_next_access(_record(_settle(d.read_mandatory))) != "granted":
            stuck = self._run("grant_access", facts, state_dir, mem)
            if stuck is not None:
                return decide_next({**facts, "access": "missing", "stuck": stuck})[0]
        if setup_next_loaded(_record(_settle(d.read_loaded))) == "yes":
            return {"lane": "hermes", "profile": profile, "status": START_LOADED, "say": [SAY_START_LOADED]}
        result = decide_next(facts)[0]
        if self._run("restart", facts, state_dir, mem) is not None:
            # No service manager here: the person restarts Hermes, as in ``call``.
            result = {
                **result,
                "say": list(SAY_RESTART_YOURSELF),
                "restart": {**_record(result.get("restart")), "how": SETUP_RESTART_HOW_SELF},
            }
            write_setup_next_answers(state_dir, {"restartedAt": d.now()})
        return result


# -- the live box ---------------------------------------------------------------


def gateway_restart_timeout(how: str, hermes_home: Optional[Path]) -> Optional[float]:
    """The bound for the one restart ``how`` names, or None when nothing here can run it."""
    from . import cloudways_restart_step as restart_step

    if how == "container":
        return restart_step.container_restart_timeout(hermes_home)
    plan = restart_step.restart_plan()
    return getattr(plan, "timeout_s", None) if plan is not None else None


def _container_markers() -> bool:
    return any(Path(marker).exists() for marker in ("/.dockerenv", "/run/.containerenv"))


def live_deps(
    *,
    state_dir: Callable[[], str],
    surface: Callable[[], str],
    hermes_home: Callable[[], Optional[Path]],
    collect_facts: Callable[[], Dict[str, Any]],
    derive_snapshot: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]],
    mandatory: Callable[[Dict[str, Any]], Mapping[str, Any]],
    version_tags: Callable[[], Dict[str, Optional[str]]],
    task_id: Optional[str] = None,
    read_card_tools: Optional[Callable[[Mapping[str, Any]], Optional[Mapping[str, Any]]]] = None,
) -> SetupNextDeps:
    """The live host's reads and runs, for the adapter. Imports stay lazy.

    ``task_id`` is the tool call's own (the chat it runs in): step 9's waiter
    wakes that chat.
    """
    import shutil
    import sys

    from . import cloudways, serve

    cache: Dict[str, Any] = {}

    def facts() -> Dict[str, Any]:
        # One active observation per call: collection plus the bounded probes.
        if "facts" not in cache:
            from . import doctor
            from .receipts import now_iso

            passive = collect_facts()
            try:
                active, _ = doctor.observe(passive, probed_at=now_iso())
            except Exception:  # noqa: BLE001 - a failed probe lane observed nothing
                active, _ = doctor.lane_failed(passive)
            cache["facts"] = active
        return cache["facts"]

    def fresh() -> None:
        cache.clear()

    def layout() -> Any:
        return cloudways.Layout.resolve()

    def read_host() -> Dict[str, Any]:
        fresh()
        verdict = None
        try:
            verdict = cloudways.detect().verdict
        except Exception:  # noqa: BLE001 - an unclassifiable host is an ordinary one
            verdict = None
        return {
            "surface": surface(),
            "detect": verdict,
            "os": sys.platform,
            "container": _container_markers(),
            "systemd": shutil.which("systemctl") is not None,
            "approvalsBypassed": store.approvals_bypassed(state_dir()),
        }

    def read_loaded() -> Dict[str, Any]:
        from . import cloudways_restart_step as restart_step
        from . import health, receipts

        home = hermes_home()
        gateway = restart_step.read_gateway_health(home)
        written_at, status = receipts.read_restart_pending(home=home)
        return {
            "restartToFinish": health.restart_to_finish(home=home),
            "markerSettled": restart_step.marker_settled(written_at, status, gateway.started_at),
            "live": gateway.live,
            "pluginLoaded": gateway.plugin_loaded,
        }

    def read_tailscale(plugin_run: bool) -> Dict[str, Any]:
        if plugin_run:
            daemon = cloudways.daemon_state(layout())
            return {"daemonState": daemon.state, "backend": daemon.backend}
        document, code = serve.read_status_document()
        if code == serve.READ_TIMEOUT:
            # A busy machine can take longer than the 2 s read to start the
            # CLI (seen on Windows): one slower look before saying it's off.
            document, code = serve.read_status_document(timeout_s=NEXT_TAILSCALE_RETRY_S)
        backend = _record(document).get("BackendState")
        online = _record(_record(document).get("Self")).get("Online") is True
        return {"readCode": code, "online": backend == "Running" and online}

    def read_legs() -> Dict[str, Any]:
        snapshot = derive_snapshot(facts()) or {}
        return _record(_record(snapshot.get("currentHealth")).get("legs"))

    def read_route() -> Dict[str, Any]:
        current = facts()
        dns_name = None
        try:
            from .control_link import HERMES_BUNDLE_DEFAULT_WS_PORT

            port = int(HERMES_BUNDLE_DEFAULT_WS_PORT)
            dns_name = getattr(serve.observe(relay_port=port), "dns_name", None)
        except Exception:  # noqa: BLE001 - no name means the HTTPS read stays unknown
            dns_name = None
        return {
            "classification": current.get("serveClassification"),
            "reachable": current.get("serveReachable"),
            "applicationReady": current.get("serveApplicationReady"),
            "dnsName": dns_name,
        }

    def read_https(dns_name: Optional[str]) -> str:
        from . import doctor

        if not dns_name:
            return "unknown"
        outcome = doctor.tailnet_cert_domains_check(dns_name, serve.READ_TIMEOUT_S)
        if outcome == doctor.OUTCOME_CERT_AVAILABLE:
            return "on"
        if outcome == doctor.OUTCOME_CERT_UNAVAILABLE:
            return "off"
        return "unknown"

    def read_https_enable_url(plugin_run: bool) -> Optional[str]:
        if not plugin_run:
            return None
        from .setup_chat_approvals import https_enable_link

        return https_enable_link(layout().socket_path)

    def route_command() -> str:
        from .setup_chat_approvals import route_command as command

        return command()

    def read_phone() -> Optional[bool]:
        from .cloudways_phone_check import read_phone_presence

        return read_phone_presence()

    def read_pairing_completed() -> bool:
        from .pairing_completion import read_pairing_completion

        return read_pairing_completion(hermes_home()) is not None

    def read_first_use() -> Dict[str, Any]:
        from .first_run import inspect_attempt

        snapshot = derive_snapshot(facts()) or {}
        proof = _record(snapshot.get("firstRunProof"))
        attempt = inspect_attempt(**version_tags())
        return {"proven": proof.get("state") == "proven", "attemptState": attempt.get("state")}

    def read_candidate(since: float) -> Dict[str, Any]:
        from datetime import datetime

        from .first_run import _read_phone_turn_candidate

        candidate = _read_phone_turn_candidate()
        completed = candidate.get("completedAt")
        try:
            moment = datetime.fromisoformat(str(completed).replace("Z", "+00:00")).timestamp()
        except ValueError:
            return {"state": candidate.get("state") or "unavailable"}
        if candidate.get("state") != "ready" or moment < since:
            return {"state": "missing"}
        return dict(candidate)

    def wait_candidate(since: float, timeout_s: float) -> Dict[str, Any]:
        from datetime import datetime, timezone

        from .first_run import wait_for_phone_turn_candidate

        return wait_for_phone_turn_candidate(
            not_before=datetime.fromtimestamp(since, tz=timezone.utc), timeout_seconds=timeout_s
        )

    def arm_from_candidate(candidate_id: str, evidence: str = "wearer_confirmed") -> Dict[str, Any]:
        from .first_run import arm_first_run_proof_from_candidate

        return arm_first_run_proof_from_candidate(
            expected_candidate_id=candidate_id, reply_evidence=evidence, **version_tags()
        )

    def wait_delivery(candidate_id: str, timeout_s: float) -> Dict[str, Any]:
        from .first_run import wait_for_reply_delivery

        return wait_for_reply_delivery(candidate_id=candidate_id, timeout_seconds=timeout_s)

    def grant_access() -> Optional[str]:
        return grant_settings(hermes_home())

    def restart(how: str) -> bool:
        from . import cloudways_restart_step as restart_step

        timeout = gateway_restart_timeout(how, hermes_home())
        if timeout is None:
            return False
        timer = threading.Timer(NEXT_RESTART_DELAY_S, restart_step.restart_gateway, args=(timeout,))
        timer.daemon = True
        timer.start()
        return True

    def start_tailscale() -> Dict[str, Any]:
        from .cloudways_setup import tailscale_fully_installed

        current = layout()
        # The terminal ladder's own test (#6377): a host with every piece in
        # place only needs its daemon started; one that lost its state, still
        # has the old cron job or a pending move runs the idempotent install,
        # so chat migrates the same hosts the terminal does.
        if tailscale_fully_installed(_record(cloudways.status(current))):
            return cloudways.start_daemon(current)
        return cloudways.install(current)

    def enroll() -> Dict[str, Any]:
        return cloudways.enroll(layout(), wait_s=30.0, timeout_s=25.0)

    def read_jev_status() -> Mapping[str, Any]:
        # The same read `hermes ocuclaw optional-setup status` prints: presence,
        # loaded state and the last Jev check, never a key.
        from . import optional_setup

        return optional_setup.status(hermes_home())

    def issue_certificate(budget_s: float) -> Dict[str, Any]:
        from .setup_chat_approvals import wait_route_certificate

        fresh()
        return wait_route_certificate(hermes_home=hermes_home(), budget_s=budget_s)

    return SetupNextDeps(
        state_dir=state_dir,
        read_host=read_host,
        read_mandatory=lambda: mandatory(facts()),
        read_loaded=read_loaded,
        read_tailscale=read_tailscale,
        tailscaled_present=lambda: bool(cloudways._binaries_present(layout())),
        read_legs=read_legs,
        read_route=read_route,
        read_https=read_https,
        read_https_enable_url=read_https_enable_url,
        route_command=route_command,
        read_phone=read_phone,
        read_pairing_completed=read_pairing_completed,
        read_first_use=read_first_use,
        read_candidate=read_candidate,
        wait_candidate=wait_candidate,
        arm_from_candidate=arm_from_candidate,
        wait_delivery=wait_delivery,
        grant_access=grant_access,
        restart=restart,
        start_tailscale=start_tailscale,
        enroll=enroll,
        issue_certificate=issue_certificate,
        read_jev_status=read_jev_status,
        read_card_tools=read_card_tools,
        **_live_wake_deps(task_id, hermes_home),
    )


def _live_wake_deps(task_id: Optional[str], hermes_home: Callable[[], Optional[Path]]) -> Dict[str, Any]:
    """Step 9's chat wake (step9_wake.py), in a chat whose tool call names it.
    Whether that chat can be woken is Hermes's answer when the waiter starts."""
    from . import step9_wake

    if not task_id:
        return {}

    def start(since: float, deadline: float) -> Optional[str]:
        return step9_wake.start_wake(task_id, hermes_home(), since, deadline)

    def running(proc: str) -> bool:
        # Only this chat's own waiter: another chat's would wake that chat.
        return step9_wake.wake_running(proc, task_id)

    return {"start_first_message_wake": start, "first_message_wake_running": running}


# -- step 2, from chat ----------------------------------------------------------


class _ChatSettingsContext:
    """What the terminal ladder's step 2 reads, for a call with no terminal.

    The ladder's doors are answered here, never by a person typing: the
    agent-mode choice is "multiple" (every supported Hermes only offers it, and
    the ladder asks only where "single" is offered), Continue here is yes
    (RULED, Matt 2026-11-04; ``assume_yes`` so a standing restart marker is not
    read as an earlier no), and the migration preview door (``ask_human``)
    always refuses, so a merge that needs that preview stops and points to the
    terminal. Lines the step says are kept, never printed.
    """

    def __init__(self, layout: Any) -> None:
        from types import SimpleNamespace

        self.layout = layout
        self.options = SimpleNamespace(details=False, assume_yes=True)
        self.env: Dict[str, str] = dict(os.environ)
        self.runner = None
        self.state: Dict[str, Any] = {}
        self.lines: List[str] = []
        self.asked_human = False

    def say(self, line: str, **_kwargs: Any) -> None:
        self.lines.append(str(line))

    def say_prompt(self, line: str) -> None:
        self.lines.append(str(line))

    def say_progress(self, message: str) -> None:
        self.lines.append(str(message))

    def ask(self, *_args: Any, **_kwargs: Any) -> bool:
        return True

    def ask_human(self, *_args: Any, **_kwargs: Any) -> bool:
        self.asked_human = True
        return False

    def choose(self, *_args: Any, **_kwargs: Any) -> Optional[str]:
        return "1"

    def isatty(self) -> bool:
        return False

    def clock(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def columns(self) -> int:
        return 0


def grant_settings(hermes_home: Optional[Path]) -> Optional[str]:
    """Step 2 from chat, through the terminal ladder's own step. None, or a stuck code."""
    from . import cloudways, cloudways_setup

    layout = cloudways.Layout.resolve(hermes_home=hermes_home) if hermes_home is not None else cloudways.Layout.resolve()
    ctx = _ChatSettingsContext(layout)
    record = cloudways_setup.step_2_settings(ctx)
    if getattr(record, "exit_code", None) is None:
        return None
    # The step's own lines say why; keep them in the gateway log, since the
    # chat only gets the stuck code.
    logging.getLogger(__name__).warning(
        "ocuclaw setup next: step 2 failed: %s", " | ".join(line.strip() for line in ctx.lines)[:600]
    )
    return "agent_merge_needs_terminal" if ctx.asked_human else "grant_access_failed"
