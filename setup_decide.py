"""The setup step machine's decider (#6377), in Python: host facts in, one ``next`` result out.

This is a line-for-line mirror of ``extensions/ocuclaw/src/setup/setup-decide.ts``.
Pure, no I/O. The Hermes reader gathers the facts on the box and its runner
carries out the one action the decider asks for (``run``), then decides again.
Every choice lives in this one table, shared with OpenClaw, so the same facts
give the same step, words and input on every host.

``tests/fixtures/setup-next-decide.json`` pins both implementations, and every
result in it passes ``setup_next_contract.validate_next_result``. Change neither
side without the other. The decider never asks for the Relay Credential (the
plugin mints it at load) and never names it.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Tuple

from .setup_next_contract import (
    SETUP_AFTER_CORE_LABELS,
    SETUP_CODE_EXPIRES_IN_SECONDS,
    SETUP_CODE_OPERATION,
    SETUP_CORE_STEP_COUNT,
    SETUP_NEXT_CONTRACT,
    SETUP_RESTART_HOW_BY_PROFILE,
    SETUP_STEPS,
    approval_surface_for,
)

SETUP_RUNS = (
    "grant_access",
    "start_tailscale",
    "enroll",
    "issue_certificate",
    "arm_first_use",
    "await_first_message",
    "restart",
)

TAILSCALE_DOWNLOAD_URLS = {
    "macos": "https://tailscale.com/download/mac",
    "windows": "https://tailscale.com/download/windows",
    "linux": "https://tailscale.com/download/linux",
}
TAILSCALE_HTTPS_ADMIN_URL = "https://console.tailscale.com/admin/dns"
TAILSCALE_MACHINES_ADMIN_URL = "https://console.tailscale.com/admin/machines"

_LANE_NAMES = {"openclaw": "OpenClaw", "hermes": "Hermes"}
_RESTART_SECONDS = {"container": 40, "platform": 30, "desktop_card": 30}

# Said once per setup run, ahead of the first result's own lines, while the
# runner says it is ``beginning``. Never on a stuck result or on ``done``.
SAY_BEGINNING = "OcuClaw setup is beginning."
SAY_HOST_ASK = "I can't tell for sure where this agent runs. Is it a Cloudways Managed AI Agents server?"
SAY_MODEL_SIGN_IN = (
    "No model is signed in yet. Sign in to OpenAI in the Cloudways panel: LLM & Channels → OAuth → OpenAI → Connect.",
    "Using ChatGPT? First turn on device code sign-in in ChatGPT (Settings → Security and login → App security), or ChatGPT refuses the sign-in.",
    "Your agent restarts after that, which can take a few minutes. Then say done.",
)
SAY_GRANT_ACCESS = "Turning on OcuClaw's settings..."
SAY_RESTART_DESKTOP = "Press Restart gateway on the card Hermes Desktop shows; then say continue."
SAY_START_TAILSCALE = "Starting Tailscale..."
#: #6482 · said once, in the call that adopted Cloudways' own daemon.
SAY_TAILSCALE_ADOPTED = (
    "Cloudways' Tailscale is already running here, so OcuClaw uses it. "
    "If the server restarts, OcuClaw starts it again the same way."
)
SAY_TAILSCALE_CHOICE = "This server has no Tailscale running yet. Pick the route that fits it."
# The install page, never a pasted install script: the user runs Tailscale's
# own steps with their own admin rights.
SAY_TAILSCALE_SYSTEM = (
    "Install Tailscale on this server yourself, as an admin, following Tailscale's steps for Linux:",
    TAILSCALE_DOWNLOAD_URLS["linux"],
    "Say done when it's running.",
)
SAY_TAILSCALE_APP = "Install the Tailscale app on this computer, open it and switch it on:"
SAY_TAILSCALE_APP_OFF = "Open the Tailscale app on this computer and switch it on."
SAY_DONE_WHEN_ON = "Say done when it's on."
SAY_ENROLL = "Getting the approval link from Tailscale..."
SAY_APPROVE_LINK = (
    "Open this link and sign in to Tailscale to approve this server:",
    "Use the Tailscale account your phone uses.",
    "Say done when it's approved.",
)
SAY_APPROVE_MACHINE = (
    "Tailscale is signed in, but your tailnet needs an admin to approve this machine.",
    "Open this page and approve it under Machines:",
    "Say done when it's approved.",
)
SAY_HTTPS_OFF = "Your Tailscale account has HTTPS turned off. Your phone's private route needs it."
SAY_HTTPS_ENABLE_LINK = "Open this link, sign in to Tailscale and turn on HTTPS:"
SAY_HTTPS_ADMIN_PAGE = "Open this page, sign in to Tailscale and turn on MagicDNS and HTTPS Certificates:"
SAY_CERTIFICATE = "Getting a certificate for the private route. This can take a minute..."
SAY_ROUTE_INTRO = (
    "Next I open a private route so only your phone can reach OcuClaw. "
    "It stays inside your own Tailscale network and is never public."
)
SAY_ROUTE_CARD = "A card shows the exact command. Press Allow once if you agree."
SAY_ROUTE_CHAT_COMMAND = "This is the exact command:"
SAY_ROUTE_CHAT_ANSWER = "Reply yes to run it, or no to stop."
SAY_PHONE_ABSENT = (
    "Your phone isn't on your Tailscale network yet. On your phone:",
    "1. Open Tailscale.",
    "2. Sign in with the same account as this server.",
    "3. Switch Tailscale on.",
    "Say done when it's on, or skip this and pair anyway.",
)
SAY_PAIR_POPUP = "A pairing window opens now. Type the code from your phone there, then check the four words."
SAY_PAIR_CODE = (
    "Open Even > OcuClaw on your phone, tap Pair with your agent and tell me the code it shows. "
    f"The code works once and expires in {SETUP_CODE_EXPIRES_IN_SECONDS // 60} minutes."
)
SAY_PAIR_CARD = "A card shows four words. Press Allow once only if they match your phone, in the same order."
SAY_PAIR_CHAT_ANSWER = "Reply yes only if they match."
SAY_ARM_FIRST_USE = "Getting ready for your first message..."
# Step 9 asks nothing until the wearer has sent a message and the phone has had
# its chance to report the glasses' receipt for the reply. These are the same
# words on every call, so a model that calls again anyway meets Hermes's "it
# has not changed" note.
SAY_FIRST_MESSAGE_SEND = (
    "Now say something to your agent from your glasses and read the reply there.",
    "A welcome card follows. Double-tap it to finish.",
)
SAY_FIRST_MESSAGE_STILL = "Still waiting for your message from the glasses."


def say_first_message_still_left(minutes: int) -> str:
    """The still-waiting answer's second line: the minutes left in the window,
    so the wearer sees progress and no two of these answers are the same
    (Hermes folds a repeated identical tool result into "it has not changed",
    and a real model then ended its turn: run 42582562511)."""
    unit = "minute" if minutes == 1 else "minutes"
    return f"About {minutes} {unit} left to send one. I keep checking, so you don't need to type here."


# Only when no receipt came for the reply: the wearer's own word.
SAY_FIRST_MESSAGE = (
    "Your phone couldn't confirm that my reply reached your glasses.",
    "Did my reply appear on your glasses?",
)
# Byte for byte both first-use ladders' WELCOME_HANDOFF_MESSAGE.
SAY_WELCOME = "Double-tap the welcome on your glasses to finish."
SAY_DONE = "Setup is complete."

SETUP_STUCK_SAY = {
    "plugin_not_loaded": "OcuClaw isn't running in your agent yet.",
    "plugin_not_loaded_after_restart": "OcuClaw still isn't running after the restart.",
    "plugin_version_stale": "Your agent still runs an older OcuClaw than the one installed.",
    "tailscaled_missing": (
        "This server has no Tailscale yet. Restart your agent from the Cloudways panel "
        "to get the current server image, then say continue."
    ),
    "route_conflict": "Something else already uses OcuClaw's private route port on this machine.",
    "route_command_unavailable": "I couldn't work out the private route command.",
    "setup_surface_unavailable": (
        "Setup can't ask for your approval in this chat. Open your agent's own chat and set up there."
    ),
    "custom_route_wrong": "Your own phone address can't reach OcuClaw. Check it, or remove it to use Tailscale.",
    "phone_address_on_cloudways": "This Cloudways server reaches your phone only through its own Tailscale, so the phone address set in OcuClaw can't work here. Remove it, then say continue.",
    "reply_not_shown": "The reply didn't show on your glasses.",
    "model_error": "Your agent's model failed to answer that message.",
    "first_message_missing": "No message came from your glasses in time.",
    # Stops a runner reports when the one thing it ran didn't work.
    "grant_access_failed": "I couldn't turn on OcuClaw's settings.",
    "tailscale_start_failed": "Tailscale didn't start on this machine.",
    "enroll_failed": "I couldn't get the approval link from Tailscale.",
    "route_failed": "The private route command didn't work.",
    "route_declined": "You said no to the private route, so I stopped. OcuClaw needs it to reach your phone.",
    "route_unreachable": "The private route is set up, but it can't be reached yet.",
    "route_unreadable": "I couldn't read this machine's private route.",
    "certificate_refused": "Tailscale refused the certificate for the private route.",
    "pairing_unavailable": "Pairing with a phone code isn't available right now.",
    "pairing_not_ready": "OcuClaw isn't ready to pair yet.",
    "pairing_failed": "Pairing didn't finish.",
    "first_use_unavailable": "I couldn't get ready for your first message.",
    "agent_merge_needs_terminal": "Bringing your agents together needs a preview first. Run hermes gateway migrate --multiplex --dry-run in a terminal, then say continue.",
    "restart_unavailable": "I can't restart Hermes from here. Run hermes gateway restart in a terminal, then say continue.",
}

NOTE_OWN_ADDRESS = "Your own phone address is set, so Tailscale isn't needed."
NOTE_PHONE_UNKNOWN = "Couldn't check for your phone here. Pairing shows if it can't connect."
NOTE_PHONE_SKIPPED = "You skipped finding your phone. Pairing shows if it can't connect."

HOST_CHOICE_OPTIONS = ({"id": "cloudways", "label": "Yes, Cloudways"}, {"id": "other", "label": "No, somewhere else"})
TAILSCALE_CHOICE_OPTIONS = (
    {"id": "system", "label": "System Tailscale, installed by the user as an admin"},
    {"id": "plugin", "label": "Tailscale run by OcuClaw from the home folder"},
)
FIRST_MESSAGE_OPTIONS = ({"id": "yes", "label": "Yes"}, {"id": "no", "label": "No"})
# Step 7 · "done" only looks again; "skip" goes on to pairing, as Enter does in
# the terminal (Matt, 2026-11-05).
PHONE_ABSENT_OPTIONS = ({"id": "done", "label": "It's on now"}, {"id": "skip", "label": "Skip, pair anyway"})

# Setup offers no extras any more (Matt, 2026-11-14). A host whose answers file
# already holds an ``extras`` pick keeps its follow-up: ``done`` reports Jev's
# progress for ``jev``, and "Tools for cards" for ``card_tools``.
#
# #7189 · "Tools for cards", once picked: `done` lists the host's MCP servers and the user says
# which ones cards may read. `next` only reads: each server the user names goes on the glasses
# as its own request (`request_card_setup`), and nothing turns on without their tap there.
# SECURITY-RULED on #7171 (change 6): names, connected and on-for-cards only.
SETUP_CARD_TOOLS_STATES = ("unknown", "cards_off", "unavailable", "switch_off", "no_servers", "pick", "all_on")
_CARD_TOOLS_TAP = "Nothing turns on without your tap."


def _card_tools_servers(card_tools: Any) -> List[Mapping[str, Any]]:
    rows = card_tools.get("servers") if isinstance(card_tools, Mapping) else None
    return [
        row for row in (rows if isinstance(rows, (list, tuple)) else [])
        if isinstance(row, Mapping) and isinstance(row.get("name"), str) and row.get("name")
    ]


def _card_tools_state(card_tools: Any) -> Optional[str]:
    """The state the lines and the block both speak for: a list state with no server to name is ``unknown``."""
    state = card_tools.get("state") if isinstance(card_tools, Mapping) else None
    if not isinstance(state, str) or state not in SETUP_CARD_TOOLS_STATES:
        return None
    return "unknown" if state in ("pick", "all_on") and not _card_tools_servers(card_tools) else state


def card_tools_say(card_tools: Any) -> Optional[List[str]]:
    """The lines ``done`` says for where "Tools for cards" is, or None when it wasn't picked."""
    state = _card_tools_state(card_tools)
    if state is None:
        return None
    servers = _card_tools_servers(card_tools)
    if state == "cards_off":
        return [
            "Cards aren't on in your phone's OcuClaw app, so there is nothing to connect your tools to yet.",
            "Say done once cards are on.",
        ]
    if state == "unavailable":
        return [
            "MCP tools can't be used in cards on this host right now.",
            "Ask me to run the setup doctor and I'll tell you why.",
        ]
    if state == "switch_off":
        return [
            "MCP in cards is off on your host, so cards can't read any tool yet.",
            "I'll put a request on your glasses to turn it on. Tap Allow there and I'll list your servers. "
            + _CARD_TOOLS_TAP,
        ]
    if state == "no_servers":
        return [
            "Your host lists no MCP servers, so there are no tools to turn on for cards.",
            "Add an MCP server to your agent, then say done.",
        ]
    if state == "pick":
        rows = [
            f"{row['name']} ({'on for cards' if row.get('cards') is True else 'off for cards'}"
            f"{'' if row.get('connected') is True else ', not connected'})"
            for row in servers
        ]
        return [
            f"Your MCP servers: {', '.join(rows)}.",
            "Which ones should cards be able to read? For each one you name, I'll put a request on your glasses "
            "and you tap Allow there. " + _CARD_TOOLS_TAP,
        ]
    if state == "all_on":
        return [
            f"Every MCP server on your host is on for cards: {', '.join(row['name'] for row in servers)}.",
            SAY_DONE,
        ]
    return ["I couldn't read your MCP servers on your host just now.", "Say done and I'll look again."]


# What the agent does next, for the two states it can act on. It only ever asks: the user taps.
_CARD_TOOLS_NEVER = (
    "The user taps Allow on their glasses: never turn one on any other way, "
    "and never ask for a server they did not name."
)
SETUP_CARD_TOOLS_NEXT = {
    "switch_off": (
        'Call request_card_setup with what "mcp" and during "setup", wait for its answer, '
        "then call next again. " + _CARD_TOOLS_NEVER
    ),
    "pick": (
        "Ask which servers cards may read. For each one the user names, call request_card_setup with "
        'what "server", that server and during "setup", and wait for each answer before the next. '
        "Then call next again. " + _CARD_TOOLS_NEVER
    ),
}


def _card_tools_block(card_tools: Mapping[str, Any]) -> Dict[str, Any]:
    """The add-only ``cardTools`` block: the state, each server's name and two states, and the agent's next move."""
    state = _card_tools_state(card_tools)
    return {
        "state": state,
        **({"next": SETUP_CARD_TOOLS_NEXT[state]} if state in SETUP_CARD_TOOLS_NEXT else {}),
        "servers": [
            {"name": row["name"], "connected": row.get("connected") is True, "cards": row.get("cards") is True}
            for row in _card_tools_servers(card_tools)
        ],
    }


# #6942 · Once the user picks Jev, `done` reports where Jev's setup is. The key
# and the switch stay on the phone (Set up Jev); `next` only reads the host's
# optional-setup status and its last check, never the key. Each state carries
# the lines that move the user one step on.
SETUP_JEV_STATES = (
    "no_key", "key_saved", "loading", "not_checked", "working", "key_rejected", "unreachable", "unknown",
)


def _jev_host(lane: Any) -> str:
    return "Hermes" if lane == "hermes" else "OpenClaw"


def jev_say(state: Any, lane: Any) -> Optional[List[str]]:
    """The lines ``done`` says for a Jev state, or None when Jev wasn't picked."""
    host = _jev_host(lane)
    if state == "no_key":
        return [
            "You'll need a TypeSafe key. On a computer, go to console.typesafe.ai, sign in or create an account, "
            "and create an API key.",
            "Then on your phone, tap Set up Jev on Home's Optional setup card and paste the key there. "
            "I never see the key, and the phone asks you before it turns anything on.",
            "Say done when Jev is on.",
        ]
    if state == "key_saved":
        # Smart interfaces applies live on both hosts; Hermes still restarts once for a key it
        # has not loaded, and the phone's button says so.
        restart = (" If it reads Turn on & restart Hermes, Hermes needs one restart to load a new key."
                   if lane == "hermes" else "")
        return [
            "Your TypeSafe key is saved, but Smart interfaces is still off.",
            f"On your phone, tap Set up Jev, then Turn on.{restart} Say done when it's on.",
        ]
    if state == "loading":
        return [
            f"Smart interfaces is turned on, but {host} hasn't loaded it yet.",
            "Say done in a moment and I'll check again.",
        ]
    if state == "not_checked":
        return [
            f"{host} has Smart interfaces loaded, but Jev hasn't been checked yet.",
            "On your phone, open Set up Jev to run the check. Say done when it's finished.",
        ]
    if state == "working":
        return [f"{host} has it loaded and Jev passed its check, so you're set.", SAY_DONE]
    if state == "key_rejected":
        return [
            "TypeSafe didn't accept this key.",
            "On your phone, open Set up Jev and tap Change key, then paste a new key from console.typesafe.ai. "
            "Say done when it's saved.",
        ]
    if state == "unreachable":
        return [
            "Your host couldn't reach TypeSafe when it checked Jev.",
            "On your phone, open Set up Jev and tap Check again. Say done when it passes.",
        ]
    if state == "unknown":
        return ["I couldn't read Jev's setup on your host just now.", "Say done and I'll look again."]
    return None

# A step outcome is ("done", None), ("skipped", note) or ("stop", stop dict).
Outcome = Tuple[str, Any]
_DONE: Outcome = ("done", None)


def pair_words_line(words: List[Any]) -> str:
    return f"Check these words match your phone, in this order: {', '.join(str(w) for w in words)}. Allow only if they match."


def _skipped(note: str) -> Outcome:
    return ("skipped", note)


def _working(line: str, run: str) -> Outcome:
    return ("stop", {"status": "working", "say": [line], "input": {"kind": "none", "then": "call_next"}, "run": run})


def _link(say: List[str], url: Optional[str]) -> Outcome:
    return ("stop", {"status": "waiting", "say": list(say), "input": {"kind": "link", "url": url, "reply": "done"}})


def _choice(say: List[str], chooser: str, options: Any, facts: Any = None) -> Outcome:
    value: Dict[str, Any] = {
        "kind": "choice",
        "chooser": chooser,
        "param": "choice",
        "options": [dict(option) for option in options],
    }
    if isinstance(facts, dict):
        value["facts"] = dict(facts)
    return ("stop", {"status": "waiting", "say": list(say), "input": value})


def _stuck_at(code: str, say: Optional[List[str]] = None, checked: Any = (), tried: Any = ()) -> Outcome:
    if say is None:
        say = [SETUP_STUCK_SAY[code]] if code in SETUP_STUCK_SAY else []
    return (
        "stop",
        {
            "status": "stuck",
            "say": say,
            "input": {"kind": "none", "then": "troubleshoot"},
            "stuck": {"code": code, "checked": list(checked), "tried": list(tried)},
        },
    )


def _custom_route(facts: Dict[str, Any]) -> bool:
    # The user's own phone address replaces Tailscale. A wrong one still means
    # "no Tailscale"; step 6 stops on it so it gets fixed.
    return facts.get("phoneAddress") in ("ready", "unverified", "wrong")


def _non_empty_str(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _step_host_model(facts: Dict[str, Any]) -> Outcome:
    if facts.get("hostLikely") is True:
        return _choice([SAY_HOST_ASK], "user", HOST_CHOICE_OPTIONS)
    # Off Cloudways the agent answering at all shows the model works (#6397 row 3).
    if facts.get("profile") != "cloudways":
        return _DONE
    # #5209 · a Cloudways container is reached only through its own Tailscale,
    # so a phone address can't work there. Stop before anything is set up, as
    # the terminal ladder does.
    if _custom_route(facts):
        return _stuck_at("phone_address_on_cloudways", None, ["phone address", "host"])
    if facts.get("model") == "signed_out":
        return _link(list(SAY_MODEL_SIGN_IN), None)
    return _DONE


def _step_plugin_access(facts: Dict[str, Any]) -> Outcome:
    # RULED (Matt, 2026-11-04): step 2 asks nothing on either lane. Hermes
    # records "multiple" agents (every supported Hermes, 0.21.4+, only offers
    # that) and turns Continue here on, as the Hermes setup skill already does.
    return _DONE if facts.get("access") == "granted" else _working(SAY_GRANT_ACCESS, "grant_access")


def _step_loaded(facts: Dict[str, Any]) -> Outcome:
    if facts.get("loaded") == "yes":
        return _DONE
    if facts.get("loaded") == "stale":
        return _stuck_at("plugin_version_stale", None, ["running OcuClaw version", "installed OcuClaw version"])
    # At most one restart (#6374 row 6). A second "not loaded" is for the agent.
    if facts.get("restarted") is True:
        return _stuck_at("plugin_not_loaded_after_restart", None, ["plugin loaded"], ["one restart"])
    if facts.get("lane") == "openclaw" and facts.get("profile") == "cloudways":
        return _stuck_at("plugin_not_loaded", None, ["plugin loaded"])
    how = SETUP_RESTART_HOW_BY_PROFILE.get(facts.get("profile"))
    lane = _LANE_NAMES.get(facts.get("lane"))
    if how == "container":
        line = f"{lane} restarts now, about 40 seconds; then say continue."
    elif how == "desktop_card":
        line = SAY_RESTART_DESKTOP
    else:
        line = f"{lane} restarts now, about 30 seconds; then say continue."
    return (
        "stop",
        {
            "status": "restarting",
            "say": [line],
            "input": {"kind": "none", "then": "end_turn"},
            "restart": {"how": how, "approxSeconds": _RESTART_SECONDS.get(how), "resumeWord": "continue"},
            "run": "restart",
        },
    )


def _step_private_network(facts: Dict[str, Any]) -> Outcome:
    if _custom_route(facts):
        return _skipped(NOTE_OWN_ADDRESS)
    if facts.get("tailscale") == "running":
        return _DONE
    profile = facts.get("profile")
    if profile == "cloudways":
        if facts.get("tailscale") == "absent":
            return _stuck_at("tailscaled_missing", None, ["/usr/bin/tailscaled"])
        return _working(SAY_START_TAILSCALE, "start_tailscale")
    if profile in ("server", "container"):
        # OcuClaw brings no Tailscale of its own (#6405): with none installed (no
        # CLI answer and no binaries to run), whatever was picked, the user
        # installs it, and only then is there a choice.
        installed = (facts.get("tailscaleFacts") or {}).get("tailscaleInstalled")
        if facts.get("tailscale") == "absent" and installed is False:
            return _link(list(SAY_TAILSCALE_SYSTEM), TAILSCALE_DOWNLOAD_URLS["linux"])
        if facts.get("tailscaleChoice") == "plugin":
            return _working(SAY_START_TAILSCALE, "start_tailscale")
        if facts.get("tailscaleChoice") == "system":
            return _link(list(SAY_TAILSCALE_SYSTEM), TAILSCALE_DOWNLOAD_URLS["linux"])
        tailscale_facts = facts.get("tailscaleFacts")
        return _choice(
            [SAY_TAILSCALE_CHOICE],
            "agent",
            TAILSCALE_CHOICE_OPTIONS,
            tailscale_facts if tailscale_facts is not None else {},
        )
    # personal and hermes-desktop: the Tailscale app, which the user installs.
    if facts.get("tailscale") == "stopped":
        return _link([SAY_TAILSCALE_APP_OFF, SAY_DONE_WHEN_ON], None)
    url = TAILSCALE_DOWNLOAD_URLS.get(facts.get("os")) if isinstance(facts.get("os"), str) else None
    url = url or TAILSCALE_DOWNLOAD_URLS["linux"]
    return _link([SAY_TAILSCALE_APP, url, SAY_DONE_WHEN_ON], url)


def _step_approve_machine(facts: Dict[str, Any]) -> Outcome:
    if _custom_route(facts):
        return _skipped(NOTE_OWN_ADDRESS)
    if facts.get("tailnet") == "online":
        return _DONE
    # Signed in, but the tailnet approves new devices: the sign-in link again
    # would not help (falclaw lab, NeedsMachineAuth).
    if facts.get("tailnet") == "needs_approval":
        first, second, *rest = SAY_APPROVE_MACHINE
        return _link([first, second, TAILSCALE_MACHINES_ADMIN_URL, *rest], TAILSCALE_MACHINES_ADMIN_URL)
    enroll_url = facts.get("enrollUrl")
    if not _non_empty_str(enroll_url):
        return _working(SAY_ENROLL, "enroll")
    first, *rest = SAY_APPROVE_LINK
    return _link([first, enroll_url, *rest], enroll_url)


def _step_private_route(facts: Dict[str, Any]) -> Outcome:
    if facts.get("phoneAddress") == "wrong":
        return _stuck_at("custom_route_wrong", None, ["phone address check"])
    if _custom_route(facts):
        return _skipped(NOTE_OWN_ADDRESS)
    route = facts.get("route")
    if route == "ready":
        return _DONE
    if route == "conflict":
        return _stuck_at("route_conflict", None, ["tailscale serve status"])
    if facts.get("https") == "off":
        enable = facts.get("httpsEnableUrl")
        url = enable if _non_empty_str(enable) else TAILSCALE_HTTPS_ADMIN_URL
        intro = SAY_HTTPS_ADMIN_PAGE if url == TAILSCALE_HTTPS_ADMIN_URL else SAY_HTTPS_ENABLE_LINK
        return _link([SAY_HTTPS_OFF, intro, url, SAY_DONE_WHEN_ON], url)
    if route == "issuing":
        return _working(SAY_CERTIFICATE, "issue_certificate")
    interface = facts.get("interface")
    surface = approval_surface_for(
        facts.get("lane"), interface if interface is not None else "", "route", facts.get("approvals") is not False
    )
    if surface is None:
        return _stuck_at("setup_surface_unavailable", None, ["chat interface"])
    command = facts.get("routeCommand")
    binding = facts.get("routeBinding")
    if not isinstance(command, str) or not isinstance(binding, str):
        return _stuck_at("route_command_unavailable", None, ["route command"])
    if surface == "chat_yes":
        say = [SAY_ROUTE_INTRO, SAY_ROUTE_CHAT_COMMAND, command, SAY_ROUTE_CHAT_ANSWER]
    else:
        say = [SAY_ROUTE_INTRO, SAY_ROUTE_CARD]
    value: Dict[str, Any] = {"kind": "approval", "surface": surface, "operation": "apply_route", "binding": binding}
    if surface == "chat_yes":
        value["param"] = "answer"
    value["shows"] = [command]
    return ("stop", {"status": "waiting", "say": say, "input": value})


def _step_phone_on_tailnet(facts: Dict[str, Any]) -> Outcome:
    if _custom_route(facts):
        return _skipped(NOTE_OWN_ADDRESS)
    if facts.get("phone") == "present":
        return _DONE
    if facts.get("phone") == "absent":
        return _choice(list(SAY_PHONE_ABSENT), "user", PHONE_ABSENT_OPTIONS)
    if facts.get("phone") == "skipped":
        return _skipped(NOTE_PHONE_SKIPPED)
    return _skipped(NOTE_PHONE_UNKNOWN)


def _step_pair(facts: Dict[str, Any]) -> Outcome:
    if facts.get("paired") is True:
        return _DONE
    interface = facts.get("interface")
    surface = approval_surface_for(
        facts.get("lane"), interface if interface is not None else "", "pairing", facts.get("approvals") is not False
    )
    if surface is None:
        return _stuck_at("setup_surface_unavailable", None, ["chat interface"])
    if surface == "popup":
        return (
            "stop",
            {
                "status": "waiting",
                "say": [SAY_PAIR_POPUP],
                "input": {"kind": "approval", "surface": surface, "operation": "pair_phone"},
            },
        )
    words = facts.get("pairingWords")
    binding = facts.get("pairingBinding")
    if isinstance(words, list) and len(words) > 0 and isinstance(binding, str):
        line = pair_words_line(words)
        say = [line, SAY_PAIR_CHAT_ANSWER] if surface == "chat_yes" else [SAY_PAIR_CARD]
        value: Dict[str, Any] = {"kind": "approval", "surface": surface, "operation": "confirm_pairing", "binding": binding}
        if surface == "chat_yes":
            value["param"] = "answer"
        value["shows"] = [line]
        return ("stop", {"status": "waiting", "say": say, "input": value})
    return (
        "stop",
        {
            "status": "waiting",
            "say": [SAY_PAIR_CODE],
            "input": {
                "kind": "code",
                "operation": SETUP_CODE_OPERATION,
                "param": "code",
                "expiresInSeconds": SETUP_CODE_EXPIRES_IN_SECONDS,
            },
        },
    )


def _step_first_message(facts: Dict[str, Any]) -> Outcome:
    """Step 9: ask the wearer to send, then wait for the reply and the phone's
    glasses receipt. Only a reply with no receipt asks Yes/No. OpenClaw's relay
    runs the test and wakes the chat (``end_turn``), and so does Hermes's waiter
    where the chat can be woken (``firstUseWake``); elsewhere on Hermes the
    next call waits for the message (``call_next``, run ``await_first_message``).
    """
    first_use = facts.get("firstUse")
    if first_use == "confirmed":
        return _DONE
    if first_use == "answered_no":
        return _stuck_at("reply_not_shown", None, ["wearer answer"])
    if first_use == "model_error":
        return _stuck_at("model_error", None, ["first reply run"])
    if first_use == "no_message":
        return _stuck_at("first_message_missing", None, ["phone message"])
    if first_use == "waiting":
        return _choice(list(SAY_FIRST_MESSAGE), "user", FIRST_MESSAGE_OPTIONS)
    if first_use == "sending":
        if facts.get("lane") != "openclaw" and facts.get("firstUseWake") == "armed":
            # Hermes, with a waiter that wakes this chat once the message is in
            # (a real model chained silent waiting calls instead of relaying
            # these lines: runs 42582562511, 42594298253, 42602344883).
            say = [*SAY_FIRST_MESSAGE_SEND]
            return ("stop", {"status": "waiting", "say": say, "input": {"kind": "glasses", "then": "end_turn"}})
        then = "end_turn" if facts.get("lane") == "openclaw" else "call_next"
        if facts.get("firstUseWaited") is True:
            # The send lines again: a real model chained into the first wait
            # without relaying them (run 42594298253), so a wearer may be
            # reading what to do for the first time here.
            say = [SAY_FIRST_MESSAGE_STILL, *SAY_FIRST_MESSAGE_SEND]
            left = facts.get("firstUseLeftMin")
            if isinstance(left, int) and not isinstance(left, bool) and left > 0:
                say.append(say_first_message_still_left(left))
        else:
            say = [*SAY_FIRST_MESSAGE_SEND]
        value: Dict[str, Any] = {"status": "waiting", "say": say, "input": {"kind": "glasses", "then": then}}
        if then == "call_next":
            value["run"] = "await_first_message"
        return ("stop", value)
    return _working(SAY_ARM_FIRST_USE, "arm_first_use")


_STEP_RULES = (
    _step_host_model,
    _step_plugin_access,
    _step_loaded,
    _step_private_network,
    _step_approve_machine,
    _step_private_route,
    _step_phone_on_tailnet,
    _step_pair,
    _step_first_message,
)


def _reader_stuck(facts: Dict[str, Any], step_id: str) -> Optional[Outcome]:
    stuck = facts.get("stuck")
    if not isinstance(stuck, dict) or stuck.get("step") != step_id or not isinstance(stuck.get("code"), str):
        return None

    def strings(value: Any) -> List[str]:
        return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []

    lines = strings(stuck.get("say")) if isinstance(stuck.get("say"), list) else None
    return _stuck_at(stuck["code"], lines, strings(stuck.get("checked")), strings(stuck.get("tried")))


def decide_next(facts: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[str]]:
    """Decide the next result from the facts: ``(result, run)``.

    ``run`` is the one action, if any, the runner performs before deciding again.
    """

    progress_steps: List[Dict[str, Any]] = []
    stop: Optional[Dict[str, Any]] = None
    stop_at = ""
    for index, step in enumerate(SETUP_STEPS):
        entry = {"id": step["id"], "number": step["number"], "label": step["label"]}
        if stop is not None:
            progress_steps.append({**entry, "state": "todo"})
            continue
        outcome = _STEP_RULES[index](facts)
        if outcome[0] == "stop":
            outcome = _reader_stuck(facts, step["id"]) or outcome
        kind, value = outcome
        if kind == "stop":
            stop = value
            stop_at = step["id"]
            progress_steps.append({**entry, "state": "stuck" if stop["status"] == "stuck" else "current"})
        elif kind == "skipped":
            progress_steps.append({**entry, "state": "skipped", "note": value})
        else:
            progress_steps.append({**entry, "state": "done"})
    if stop is None:
        jev_lines = jev_say(facts.get("jev"), facts.get("lane")) or card_tools_say(facts.get("cardTools"))
        stop = {"status": "done", "say": jev_lines or [SAY_DONE], "input": {"kind": "none", "then": "end_turn"}}
        stop_at = "done"
    core = next((step for step in SETUP_STEPS if step["id"] == stop_at), None)
    result: Dict[str, Any] = {
        "contract": SETUP_NEXT_CONTRACT,
        "lane": facts.get("lane"),
        "profile": facts.get("profile"),
        "step": stop_at,
        "status": stop["status"],
        # #6482 · the adoption is news once, ahead of whatever comes next; a
        # stuck result keeps only its own lines.
        "say": [
            # The first result of a setup run opens with the welcome line.
            *([SAY_BEGINNING] if facts.get("beginning") is True and stop["status"] != "stuck" and stop_at != "done" else []),
            *([SAY_TAILSCALE_ADOPTED] if facts.get("tailscaleAdopted") is True and stop["status"] != "stuck" else []),
            # Step 9 is done while the welcome card still waits on the glasses.
            *([SAY_WELCOME] if facts.get("welcome") == "pending" and stop_at == "done" else []),
            *stop["say"],
        ],
        "input": stop["input"],
    }
    if stop.get("restart"):
        result["restart"] = stop["restart"]
    if stop.get("stuck"):
        result["stuck"] = stop["stuck"]
    # #6942 · add-only: present only once the user picked Jev.
    if stop_at == "done" and jev_say(facts.get("jev"), facts.get("lane")) is not None:
        result["jev"] = {"state": facts.get("jev")}
    # #7189 · add-only: present only once the user picked "Tools for cards".
    elif stop_at == "done" and card_tools_say(facts.get("cardTools")) is not None:
        result["cardTools"] = _card_tools_block(facts.get("cardTools"))
    result["progress"] = {
        "current": stop_at,
        "number": core["number"] if core else None,
        "of": SETUP_CORE_STEP_COUNT,
        "label": core["label"] if core else SETUP_AFTER_CORE_LABELS[stop_at],
        "steps": progress_steps,
    }
    return result, stop.get("run")
