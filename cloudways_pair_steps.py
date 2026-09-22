"""Steps 7 and 8 of the Cloudways ladder: the phone, then its first message (#3105).

Two steps, one terminal, no second command. Step 7 hands the existing pairing
ceremony an address the ladder derived itself; step 8 runs the existing
first-message check in the same terminal, rendering through the ladder's own
output so it keeps the ``[8/8]`` shape.

Three rules shape everything below:

* **The address is derived, never asked for.** It is produced only behind the
  same four-part gate the doctor uses before it prints one (``cli`` ·
  ``_render_phone_address``): the route is ``ready``, this install owns it, the
  Hermes gateway leg is healthy, and no bounded probe actually watched the
  route refuse a connection. An address that satisfies fewer of those is a
  doomed address — the phone cannot connect and nothing told the user why — so
  when any part fails this prints the reason instead, one plain line, and
  stops. The address itself is never printed, never journalled and never
  logged: it carries the private route authority.
* **Approval is human-owned.** ``--yes`` reaches neither of these steps'
  decisions. The pairing ceremony's own TTY gate is the door for the four
  safety words, and the wearer's "did the reply appear" answer is asked by the
  first-message check on a real terminal or not at all. Neither is routed
  through ``ctx.ask``.
* **The Relay Credential's value is never read here.** Its presence is read
  from the same secret-free collector fact the doctor's probe planner uses
  (``secretsPresent.relayToken``), and the ceremony reads the value itself,
  inside its own process, as it already does.

Every collaborator is injectable in the same shape as :func:`pairing.run_pair`
and :func:`first_use_cli.run_first_use`, so both steps run in tests through
:func:`cloudways_setup.run_setup` exactly as they run against a real host.
"""

from __future__ import annotations

import select
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from .cloudways_setup import (
    SETUP_EXIT_OK,
    SETUP_EXIT_PROBLEM,
    SETUP_EXIT_STOPPED,
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_REFUSED,
    STATUS_SKIPPED,
    STEP_7_SKIPPED_MESSAGE,
    STEP_8_SKIPPED_MESSAGE,
    StepContext,
    StepRecord,
)

# -- journal vocabulary -------------------------------------------------------
# Closed set, mirrored into `cloudways_setup.JOURNAL_DETAILS`. Every word names
# a state; none of them can carry an address, a link or a credential.

DETAIL_ALREADY_PAIRED = "already-paired"
DETAIL_GATEWAY_NOT_RUNNING = "gateway-not-running"
DETAIL_NO_RELAY_CREDENTIAL = "no-relay-credential"
DETAIL_ROUTE_NOT_READY = "route-not-ready"
DETAIL_ROUTE_NOT_OWNED = "route-not-owned"
DETAIL_ROUTE_UNCLAIMED = "route-unclaimed"
DETAIL_ROUTE_CLAIM_UNREADABLE = "route-claim-unreadable"
DETAIL_ROUTE_UNHEALTHY = "route-unhealthy"
DETAIL_ROUTE_REFUSING = "route-refusing"
DETAIL_PAIRED = "paired"
DETAIL_PAIRING_REFUSED = "pairing-refused"
DETAIL_PAIRING_FAILED = "pairing-failed"
#: The phone check that opens step 7 waited its whole bounded wait and no phone
#: ever appeared, so the ladder stopped before the ceremony (#3178). It is the
#: only outcome of that check that ends a run: found, appeared, carried on by
#: Enter, no terminal, and a status that could not be read all continue. The
#: ladder's closed set already carries this word for step 5's own wait, so the
#: phone wait adds no new vocabulary to the journal.
DETAIL_PHONE_WAIT_TIMEOUT = "timeout"

DETAIL_FIRST_USE_REFUSED = "first-use-refused"
DETAIL_FIRST_USE_FAILED = "first-use-failed"
#: Outcome and evidence discriminator in one word. SDK acceptance is never
#: blurred into wearer confirmation, in the journal either.
DETAIL_COMMITTED = "committed"
DETAIL_COMMITTED_SDK = "committed-client-sdk-receipt"
DETAIL_COMMITTED_WEARER = "committed-wearer-confirmed"
DETAIL_ARMED = "armed"
DETAIL_ARMED_SDK = "armed-client-sdk-receipt"
DETAIL_ARMED_WEARER = "armed-wearer-confirmed"

STEP_DETAILS = frozenset(
    {
        DETAIL_ALREADY_PAIRED,
        DETAIL_GATEWAY_NOT_RUNNING,
        DETAIL_NO_RELAY_CREDENTIAL,
        DETAIL_ROUTE_NOT_READY,
        DETAIL_ROUTE_NOT_OWNED,
        DETAIL_ROUTE_UNCLAIMED,
        DETAIL_ROUTE_CLAIM_UNREADABLE,
        DETAIL_ROUTE_UNHEALTHY,
        DETAIL_ROUTE_REFUSING,
        DETAIL_PAIRED,
        DETAIL_PAIRING_REFUSED,
        DETAIL_PAIRING_FAILED,
        DETAIL_PHONE_WAIT_TIMEOUT,
        DETAIL_FIRST_USE_REFUSED,
        DETAIL_FIRST_USE_FAILED,
        DETAIL_COMMITTED,
        DETAIL_COMMITTED_SDK,
        DETAIL_COMMITTED_WEARER,
        DETAIL_ARMED,
        DETAIL_ARMED_SDK,
        DETAIL_ARMED_WEARER,
    }
)


# -- step 7 copy --------------------------------------------------------------

STEP_7_ALREADY_PAIRED_MESSAGE = (
    "A phone is already paired with this Hermes profile."
)

STEP_7_GATEWAY_NOT_RUNNING_MESSAGE = (
    "Could not confirm Hermes is running.\n"
    "Check hermes gateway status. If it is stopped, start it, then run setup again."
)

#: Same rule as step 3 (#3242): the Relay Credential is an internal object
#: CONTEXT.md says users never see, so the terminal names the thing the person
#: can act on instead. The credential is minted when the plugin loads, so a
#: profile without one has an agent that has not loaded OcuClaw yet.
STEP_7_NO_RELAY_CREDENTIAL_MESSAGE = (
    "OcuClaw has not loaded yet. Pairing cannot start.\n"
    "Restart the agent as step 3 describes, then run setup again."
)

#: One line per failed part of the address gate. Each one says what is wrong
#: and what covers it, and none of them mentions an address.
STEP_7_ROUTE_NOT_READY_MESSAGE = (
    "The private route is not ready. Pairing cannot start.\n"
    "Run hermes ocuclaw doctor, fix the route, then run setup again."
)

STEP_7_ROUTE_NOT_OWNED_MESSAGE = (
    "Another OcuClaw installation owns this route. Pairing would connect to it.\n"
    "Nothing changed. Run hermes ocuclaw doctor to check route ownership."
)

STEP_7_ROUTE_UNCLAIMED_MESSAGE = (
    "Could not confirm this route belongs to this OcuClaw installation.\n"
    "Run setup again and let step 6 finish before pairing."
)

STEP_7_ROUTE_CLAIM_UNREADABLE_MESSAGE = (
    "Could not read the route's ownership. Pairing cannot start.\n"
    "Run hermes ocuclaw doctor, fix the reported problem, then run setup again."
)

STEP_7_ROUTE_UNHEALTHY_MESSAGE = (
    "The Hermes gateway behind this route is not healthy.\n"
    "Run hermes ocuclaw doctor, fix the reported problem, then run setup again."
)

STEP_7_ROUTE_REFUSING_MESSAGE = (
    "The private route refused a connection. Pairing cannot start.\n"
    "Run hermes ocuclaw doctor, fix the reported problem, then run setup again."
)

#: Said once, immediately before the ceremony starts. The address is handed to
#: the ceremony in this process and deliberately not shown: it is the private
#: route authority, and a terminal is a place things get pasted out of.
STEP_7_ADDRESS_DERIVED_MESSAGE = (
    "Private route ready for pairing."
)

STEP_7_PAIRED_MESSAGE = "Paired. Your phone is connected."

STEP_7_PAIRING_REFUSED_MESSAGE = (
    "Pairing stopped. Run the same setup command to resume."
)

STEP_7_PAIRING_FAILED_MESSAGE = (
    "Pairing did not finish. Run the same setup command to resume."
)

#: Said after a pairing code ran out with nothing ever claiming it (#3177). It
#: names the one cause a non-technical person would never think of and cannot
#: see from here: the app off, or signed in somewhere else. A refused or
#: cancelled approval is a decision, not a missing phone, and never gets it.
#:
#: ONLY when the phone check that opens step 7 did not see a phone. When it did,
#: Tailscale is demonstrably not the problem and saying so would send the user
#: to fix something that is already working.
STEP_7_NO_PHONE_CAUSE_MESSAGE = (
    "Most often this means Tailscale is switched off, or signed in to a "
    "different account, on your phone."
)

#: The same moment, on a host where a phone IS on the private network. Nothing
#: is diagnosed, because there is nothing to diagnose: the code simply was not
#: entered.
STEP_7_NOBODY_ENTERED_MESSAGE = "Nobody entered the code in time."

#: Printed once, on a real terminal, immediately before the FIRST code is
#: minted. The code lives two minutes, so a user who walks away to find their
#: phone comes back to a code that has already gone. Worded once and shared with
#: the OpenClaw ladder, which prints it exactly as written.
STEP_7_READY_LINES = (
    "Open Even > OcuClaw on your phone.",
    "The next pairing code expires in 2 minutes.",
    "Press Enter to show the code.",
)

#: What a code that ran out costs: one keypress, not the whole eight steps. The
#: ladder mints a fresh one in place, so a user who was a minute too slow does
#: not have to start the run again.
STEP_7_NEW_CODE_PROMPT = (
    "Press Enter for a new code, or type stop:"
)

#: The one word that ends the retry loop. Compared stripped and lower-cased;
#: everything else, Enter included, means "give me another code".
STEP_7_STOP_WORD = "stop"

#: How long either step 7 keypress waits before carrying on without one. A
#: terminal with nobody at it is ordinary on a managed host, so neither the
#: ready gate nor the new-code offer may hold a run open for ever. Matched by
#: the OpenClaw ladder.
STEP_7_INPUT_WAIT_S = 600.0

#: How many fresh codes step 7 will mint in place before it stops offering.
#: Three is generous for "I was a minute too slow" and short of a loop that
#: never ends. Matched by the OpenClaw ladder.
STEP_7_MAX_NEW_CODES = 3

#: The core's own word for "the code ran out with nothing claiming it".
PAIRING_EXPIRED_REASON = "expired"


# -- the phone check that opens step 7 (#3178) --------------------------------
#
# Read-only, advisory, and it can never be the reason a pairing does not
# happen: found says one line, not-found explains and waits, Enter carries on,
# a terminal-less run carries on at once, and a status that cannot be read says
# nothing at all. The one ending that stops the ladder is the bounded wait
# running out, and that is a stop the next run resumes from, not a failure.

PHONE_PRESENT_MESSAGE = "Phone found on your Tailscale network."

#: The shared walkthrough, worded once in #3177 and printed by both ladders
#: exactly as written, with no step indent added. Only the product name
#: differs between the two, so the wording cannot drift.
PHONE_WALKTHROUGH_LINES = (
    "Phone not found on your Tailscale network.",
    "",
    "On your phone:",
    "1. Open Tailscale.",
    "2. Sign in with the same account as this server.",
    "3. Switch Tailscale on.",
    "",
    "Waiting for your phone. Press Enter to skip this check.",
)

PHONE_APPEARED_MESSAGE = "Phone found on your Tailscale network."

PHONE_CARRY_ON_MESSAGE = "Carrying on without a phone on your private network."

PHONE_WAIT_TIMEOUT_MESSAGE = (
    "No phone appeared on your private network. Switch on Tailscale on your "
    "phone, then run the same command again; it picks up here."
)

#: No terminal, so nobody can press Enter and nobody is watching the wait run
#: down. The walkthrough would be printed into a log nobody reads, so the run
#: says the one honest line and goes straight on to the ceremony.
PHONE_NO_TERMINAL_MESSAGE = (
    "No phone is on your private network yet. Carrying on, because this is not "
    "an interactive terminal."
)

#: How long the wait runs, and how often it re-reads the tailnet. Both are
#: deliberately not flags: the wait is advisory and Enter already shortens it.
#: They are parameters of :func:`wait_for_a_phone`, which is what tests drive.
PHONE_WAIT_S = 600.0
PHONE_POLL_S = 3.0

#: Input that was already sitting in the terminal when the wait armed is
#: drained rather than read as a keypress, so keystrokes typed during step 5's
#: long wait cannot skip this one, and cannot leak into the approval prompt
#: below either. A sane terminal never has more than a line or two pending;
#: the bound stops a pathological stream from holding the ladder here.
ENTER_DRAIN_LIMIT = 64

#: What the wait ended as. Only :data:`PHONE_TIMEOUT` stops the ladder.
PHONE_FOUND = "found"
PHONE_APPEARED = "appeared"
PHONE_CARRIED_ON = "carried-on"
PHONE_TIMEOUT = "timeout"
PHONE_UNREADABLE = "unreadable"
PHONE_NO_TERMINAL = "no-terminal"

#: The two endings that mean a phone really is on the private network. Only
#: these rule Tailscale out as the reason a pairing code was never claimed; the
#: rest are "not seen", which includes "could not be read".
PHONE_SEEN_STATES = frozenset({PHONE_FOUND, PHONE_APPEARED})


def _default_phone_present(ctx: StepContext) -> Optional[bool]:
    """One bounded, read-only `tailscale status --json`, through the ladder's runner.

    The import is inside the guard too: this check is advisory, and a module
    that will not import is exactly as much evidence about someone's phone as a
    status that will not parse. Neither may reach the user as a traceback.
    """
    try:
        from . import cloudways_phone_check

        return cloudways_phone_check.read_phone_presence(runner=ctx.runner)
    except Exception:  # noqa: BLE001 - an unanswerable question is not an answer
        return None


def _default_enter_pressed(ctx: StepContext) -> Callable[[], bool]:
    """Arm "press Enter to carry on", and answer whether it has been pressed.

    This is the one place a step touches :attr:`StepContext.stream_in` without
    handing it to a ceremony, and it is deliberate: it is not a question and it
    cannot carry an answer. Enter means "stop waiting", the only outcome it can
    produce is the one the wait produces on its own a few minutes later, and
    there is nothing a person could type here that changes what happens next.
    `ask_human`'s gate is untouched, because nothing is being asked.

    Arming DRAINS what is already pending. Step 5 can sit waiting for an
    approval for minutes, and anything typed at the terminal in that time was
    not an answer to a question nobody had asked yet: it must not skip this
    wait, and it must not still be sitting in the buffer when the pairing
    ceremony asks for its approval a moment later.

    Never blocks: the stream is polled with a zero timeout, and a stream that
    cannot be polled at all answers no forever, which leaves the bounded wait.
    """
    stream = ctx.stream_in
    if stream is None or not ctx.isatty():
        return lambda: False

    _drain(stream)

    def pressed() -> bool:
        return _pending(stream) and _take_line(stream) is not None

    return pressed


def _pending(stream: Any) -> bool:
    """Is there input waiting right now? Never blocks, never raises."""
    try:
        ready, _, _ = select.select([stream], [], [], 0)
    except Exception:  # noqa: BLE001 - a stream with no fileno is not pollable
        return False
    return bool(ready)


def _take_line(stream: Any) -> Optional[str]:
    """One line, or None for end-of-input and for a stream that cannot be read."""
    try:
        line = stream.readline()
    except Exception:  # noqa: BLE001 - a closed stream is not a keypress
        return None
    return None if line == "" else str(line)


def _drain(stream: Any) -> None:
    """Throw away what was already pending, bounded by :data:`ENTER_DRAIN_LIMIT`."""
    drained = 0
    while drained < ENTER_DRAIN_LIMIT and _pending(stream):
        if _take_line(stream) is None:
            break
        drained += 1


def _wait_readable(stream: Any, timeout_s: float) -> Optional[bool]:
    """True input arrived, False the wait ran out, None the stream is unpollable."""
    try:
        ready, _, _ = select.select([stream], [], [], max(0.0, float(timeout_s)))
    except Exception:  # noqa: BLE001 - a stream with no fileno is not pollable
        return None
    return bool(ready)


def _default_read_line(
    ctx: StepContext, timeout_s: float = STEP_7_INPUT_WAIT_S
) -> Optional[str]:
    """Drain what was already typed, then wait, bounded, for one more line.

    The same seam as :func:`_default_enter_pressed` and for the same reason:
    what is read here is a keypress, not an answer to a question `ask_human`
    owns. Step 7 uses it twice — to hold the ladder until the person says they
    are ready, and to offer a fresh code when one has run out — and both are
    "carry on" with an optional "stop", which is what the ladder does anyway.

    Bounded because a terminal with nobody at it is ordinary on a managed host:
    an SSH session left open overnight must not hold a setup run for ever. End
    of input and a wait that ran out both answer None, so the caller finishes
    rather than loops. A stream that cannot be polled keeps the plain blocking
    read, which is what a test's own stream wants.
    """
    stream = ctx.stream_in
    if stream is None:
        return None
    _drain(stream)
    ready = _wait_readable(stream, timeout_s)
    if ready is False:
        return None
    return _take_line(stream)


def hold_until_ready(
    ctx: StepContext, *, read_line_fn: Optional[Callable[[], Optional[str]]] = None
) -> bool:
    """Say the code is short-lived, then wait for Enter, bounded.

    Returns whether it actually waited. It never waits when nobody can press
    Enter — no terminal — and never under ``--yes``, which is the promise that
    the verb stays automatable up to the ceremony's own human gate. A wait that
    runs out carries on and mints the code, because the alternative is a run
    that never ends.
    """
    if ctx.options.assume_yes or not ctx.isatty():
        return False
    for line in STEP_7_READY_LINES:
        ctx.say(line)
    (read_line_fn or (lambda: _default_read_line(ctx)))()
    return True


def ask_for_a_new_code(
    ctx: StepContext, *, read_line_fn: Optional[Callable[[], Optional[str]]] = None
) -> bool:
    """A code ran out. True to mint another one, False to finish here.

    With no terminal there is nobody to ask, so this answers False and the step
    ends exactly as it did before the loop existed. A wait that runs out is the
    same answer: nobody is there.
    """
    if not ctx.isatty():
        return False
    ctx.say(STEP_7_NEW_CODE_PROMPT)
    answer = (read_line_fn or (lambda: _default_read_line(ctx)))()
    if answer is None:
        return False
    return answer.strip().lower() != STEP_7_STOP_WORD


def wait_for_a_phone(
    ctx: StepContext,
    *,
    present_fn: Callable[[], Optional[bool]],
    enter_fn: Optional[Callable[[], bool]] = None,
    wait_s: float = PHONE_WAIT_S,
    poll_s: float = PHONE_POLL_S,
) -> str:
    """Look once; if no phone is there, explain and wait for one, bounded.

    Ctrl-C is left alone on purpose: the wait sleeps through ``ctx.sleep``, so
    an interrupt here lands on the ladder's own handler, which says one line,
    journals the step as interrupted and exits 130 (#3146).
    """
    present = present_fn()
    if present is True:
        ctx.say(f"  {PHONE_PRESENT_MESSAGE}")
        return PHONE_FOUND
    if present is None:
        # Nothing alarming, nothing at all: an unreadable status is not
        # evidence about the person's phone.
        return PHONE_UNREADABLE
    if not ctx.isatty():
        ctx.say(f"  {PHONE_NO_TERMINAL_MESSAGE}")
        return PHONE_NO_TERMINAL

    for line in PHONE_WALKTHROUGH_LINES:
        ctx.say(line)
    pressed = _default_enter_pressed(ctx) if enter_fn is None else enter_fn

    deadline = ctx.clock() + max(0.0, float(wait_s))
    while True:
        if pressed():
            ctx.say(f"  {PHONE_CARRY_ON_MESSAGE}")
            return PHONE_CARRIED_ON
        if ctx.clock() >= deadline:
            ctx.say(f"  {PHONE_WAIT_TIMEOUT_MESSAGE}")
            return PHONE_TIMEOUT
        ctx.sleep(min(poll_s, max(0.0, deadline - ctx.clock())))
        # A poll that cannot be read is transient, not an answer: the opening
        # read worked, so the wait keeps looking until the deadline or Enter.
        if present_fn() is True:
            ctx.say(f"  {PHONE_APPEARED_MESSAGE}")
            return PHONE_APPEARED


# -- the four-part address gate -----------------------------------------------
#
# `cli._render_phone_address` is the reference implementation and the only
# other place that turns these four facts into an address. This function asks
# the same four questions and gives the same answers; it returns the address
# rather than rendering it, because the ladder hands it to a ceremony instead
# of printing it. Ownership is asked first, because "someone else's route" is
# the one answer whose wording must not be softened into "not ready yet".

#: `cli`'s four claim states, restated so the gate does not import the whole
#: command surface just to name them. Asserted equal in the tests.
CLAIM_OWNED = "route_claim_owned"
CLAIM_FOREIGN = "route_claim_foreign_owner"
CLAIM_UNCLAIMED = "route_claim_unclaimed"
CLAIM_UNAVAILABLE = "route_claim_unavailable"
#: `snapshot.HEALTH_HEALTHY`, same reason, same assertion.
HEALTH_HEALTHY = "healthy"
ROUTE_READY = "ready"

#: Each claim that is not this install's own, and the word it is journalled as.
#: `cli._render_phone_address` gives these three their own sentences and so does
#: this step: "someone else owns it", "nobody claimed it" and "the claim could
#: not be read" are three different situations with three different fixes.
#: Anything unrecognised is read as unreadable, which fails closed.
CLAIM_REFUSALS: Dict[str, str] = {
    CLAIM_FOREIGN: DETAIL_ROUTE_NOT_OWNED,
    CLAIM_UNCLAIMED: DETAIL_ROUTE_UNCLAIMED,
    CLAIM_UNAVAILABLE: DETAIL_ROUTE_CLAIM_UNREADABLE,
}


def phone_address_for(evidence: Mapping[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    """The address for a ready, owned, healthy, non-refusing route, or a reason.

    Returns ``(address, None)`` or ``(None, detail)``, where ``detail`` is one
    of this module's journal words and selects the single line the user sees.
    """
    from . import serve as serve_mod

    claim = str(evidence.get("claimState") or "")
    if claim != CLAIM_OWNED:
        return None, CLAIM_REFUSALS.get(claim, DETAIL_ROUTE_CLAIM_UNREADABLE)
    if str(evidence.get("classification") or "") != ROUTE_READY:
        return None, DETAIL_ROUTE_NOT_READY
    if str(evidence.get("gatewayLegState") or "") != HEALTH_HEALTHY:
        return None, DETAIL_ROUTE_UNHEALTHY
    tailnet = evidence.get("tailnetLeg")
    tailnet = tailnet if isinstance(tailnet, Mapping) else {}
    if tailnet.get("reachable") == "no" or tailnet.get("applicationReady") == "no":
        return None, DETAIL_ROUTE_REFUSING
    address = serve_mod.phone_address(dns_name=evidence.get("nodeDnsName"))
    if not address:
        # A ready route with no readable node identity: the same withholding,
        # for the same reason. There is no address to be had.
        return None, DETAIL_ROUTE_NOT_READY
    return address, None


ROUTE_REFUSAL_LINES: Dict[str, str] = {
    DETAIL_ROUTE_NOT_OWNED: STEP_7_ROUTE_NOT_OWNED_MESSAGE,
    DETAIL_ROUTE_UNCLAIMED: STEP_7_ROUTE_UNCLAIMED_MESSAGE,
    DETAIL_ROUTE_CLAIM_UNREADABLE: STEP_7_ROUTE_CLAIM_UNREADABLE_MESSAGE,
    DETAIL_ROUTE_NOT_READY: STEP_7_ROUTE_NOT_READY_MESSAGE,
    DETAIL_ROUTE_UNHEALTHY: STEP_7_ROUTE_UNHEALTHY_MESSAGE,
    DETAIL_ROUTE_REFUSING: STEP_7_ROUTE_REFUSING_MESSAGE,
}

#: A foreign owner is the one refusal, not a problem: the route belongs to
#: another gateway install on this host, pairing through it is something this
#: ladder declines to do, and waiting will not change the answer. Every other
#: case describes this install's own route not being finished or not working
#: yet — including an unclaimed one, which on the normal path means step 6 has
#: not completed — so they exit 1, resolve and re-run, like the steps before.
ROUTE_REFUSAL_EXIT_CODES: Dict[str, int] = {
    DETAIL_ROUTE_NOT_OWNED: SETUP_EXIT_STOPPED,
    DETAIL_ROUTE_UNCLAIMED: SETUP_EXIT_PROBLEM,
    DETAIL_ROUTE_CLAIM_UNREADABLE: SETUP_EXIT_PROBLEM,
    DETAIL_ROUTE_NOT_READY: SETUP_EXIT_PROBLEM,
    DETAIL_ROUTE_UNHEALTHY: SETUP_EXIT_PROBLEM,
    DETAIL_ROUTE_REFUSING: SETUP_EXIT_PROBLEM,
}


def collect_route_evidence() -> Dict[str, Any]:
    """The doctor's own observation, reduced to what the address gate needs.

    The same three reads `hermes ocuclaw doctor` makes, in the same order:
    collect the facts, run the bounded active checks so the refusing-route
    evidence is fresh rather than cached, derive the snapshot. Ownership is
    read with the **read-only** claim reader, never the reserving one: pairing
    must never become the act that claims this host's route.
    """
    from . import cli as cli_mod
    from . import doctor as doctor_lane
    from .snapshot import (
        LEG_HERMES_GATEWAY,
        LEG_TAILNET_ROUTE,
        derive_snapshot,
        now_iso,
    )

    facts = cli_mod._default_facts()
    try:
        facts, _outcomes = doctor_lane.observe(facts, probed_at=now_iso())
    except Exception:  # noqa: BLE001 - a failed lane observed nothing
        facts, _outcomes = doctor_lane.lane_failed(facts)
    snapshot = derive_snapshot(facts)
    legs = (snapshot.get("currentHealth") or {}).get("legs") or {}
    claim_state = cli_mod._default_replacement_safe(facts)
    if isinstance(claim_state, bool):  # a substituted seam may answer plainly
        claim_state = CLAIM_OWNED if claim_state else CLAIM_FOREIGN
    secrets = facts.get("secretsPresent")
    return {
        "classification": facts.get("serveClassification"),
        "claimState": claim_state,
        "nodeDnsName": facts.get("serveNodeDnsName"),
        "gatewayLegState": (legs.get(LEG_HERMES_GATEWAY) or {}).get("state"),
        "tailnetLeg": legs.get(LEG_TAILNET_ROUTE) or {},
        # Presence, never the value: the same secret-free fact the doctor's
        # probe planner gates the credentialed relay check on.
        "relayCredentialPresent": (
            isinstance(secrets, Mapping) and secrets.get("relayToken") is True
        ),
    }


def _home_of(ctx: StepContext) -> Optional[Path]:
    return getattr(ctx.layout, "hermes_home", None)


def _already_paired(home: Optional[Path]) -> bool:
    """The durable pairing-completion receipt the first-run machinery reads."""
    from . import pairing_completion

    try:
        return pairing_completion.read_pairing_completion(home) is not None
    except Exception:  # noqa: BLE001 - an unreadable receipt is not a pairing
        return False


def _default_gateway_running(home: Optional[Path]) -> bool:
    """`first-use`'s positive-liveness read, reused verbatim: only True is yes."""
    from . import first_use_cli

    return first_use_cli.gateway_running(home)


#: The core's own reason for "the person at this terminal said no". It is the
#: difference between a refusal and a fault, and the ceremony's exit code does
#: not carry it: a denial ends the exchange as `failed`, which is exit 1.
PAIRING_DENIED_REASON = "approval-denied"


def _default_pair(
    ctx: StepContext, address: str, outcome_fn: Callable[[Mapping[str, Any]], None]
) -> int:
    """The terminal ceremony, unchanged: QR, manual code, four words, approval.

    It reads the Relay Credential itself, inside its own process, and owns its
    own TTY gate — which is why ``--yes`` can never approve a pairing from
    here. The ladder's streams are handed through so the whole command reads as
    one terminal session, and ``outcome_fn`` is the ceremony's reporting seam:
    it reports the ending, and changes nothing about it.
    """
    from .pairing import run_pair

    return int(
        run_pair(
            address,
            stdin=ctx.stream_in,
            stdout=ctx.stream_out,
            stderr=ctx.stream_out,
            light_terminal=ctx.options.light_terminal,
            outcome_fn=outcome_fn,
        )
    )


def step_7_pair(
    ctx: StepContext,
    *,
    paired_fn: Optional[Callable[[], bool]] = None,
    gateway_running_fn: Optional[Callable[[], bool]] = None,
    evidence_fn: Optional[Callable[[], Mapping[str, Any]]] = None,
    pair_fn: Optional[Callable[[str, Callable[[Mapping[str, Any]], None]], int]] = None,
    phone_present_fn: Optional[Callable[[], Optional[bool]]] = None,
    enter_pressed_fn: Optional[Callable[[], bool]] = None,
    read_line_fn: Optional[Callable[[], Optional[str]]] = None,
    phone_wait_s: float = PHONE_WAIT_S,
    phone_poll_s: float = PHONE_POLL_S,
) -> StepRecord:
    """Check for a phone, derive the address, raise the preflight, then pair."""
    if ctx.options.no_pair:
        # The first message needs a paired phone, so --no-pair ends the ladder
        # rather than walking into a step that cannot work.
        ctx.say(f"  {STEP_7_SKIPPED_MESSAGE}")
        return StepRecord("pair", STATUS_SKIPPED, "no-pair", exit_code=SETUP_EXIT_OK)

    home = _home_of(ctx)
    paired_fn = paired_fn or (lambda: _already_paired(home))
    gateway_running_fn = gateway_running_fn or (lambda: _default_gateway_running(home))
    evidence_fn = evidence_fn or collect_route_evidence
    pair_fn = pair_fn or (
        lambda address, outcome_fn: _default_pair(ctx, address, outcome_fn)
    )

    if paired_fn():
        ctx.say(f"  {STEP_7_ALREADY_PAIRED_MESSAGE}")
        # Presence, not proof that the recorded pairing still works: if the
        # phone never sends its first message, step 8 says so rather than
        # leaving the user waiting on a phone that cannot connect.
        ctx.state["pairing_skipped_as_already_paired"] = True
        return StepRecord("pair", STATUS_SKIPPED, DETAIL_ALREADY_PAIRED)

    # Preflight, cheapest first. Each failure is one plain line and a stop:
    # a ceremony started on any of these would burn the user's time and then
    # fail at the phone.
    if not gateway_running_fn():
        ctx.say(f"  {STEP_7_GATEWAY_NOT_RUNNING_MESSAGE}")
        return StepRecord(
            "pair", STATUS_FAILED, DETAIL_GATEWAY_NOT_RUNNING, exit_code=SETUP_EXIT_PROBLEM
        )

    try:
        evidence = evidence_fn()
    except Exception:  # noqa: BLE001 - an unobservable route is never paired through
        # Fail closed, and say what is actually unknown rather than inventing a
        # more specific diagnosis out of a failed observation.
        ctx.say(f"  {STEP_7_ROUTE_NOT_READY_MESSAGE}")
        return StepRecord(
            "pair", STATUS_FAILED, DETAIL_ROUTE_NOT_READY, exit_code=SETUP_EXIT_PROBLEM
        )

    if not evidence.get("relayCredentialPresent"):
        ctx.say(f"  {STEP_7_NO_RELAY_CREDENTIAL_MESSAGE}")
        return StepRecord(
            "pair", STATUS_FAILED, DETAIL_NO_RELAY_CREDENTIAL, exit_code=SETUP_EXIT_PROBLEM
        )

    address, refusal = phone_address_for(evidence)
    if address is None:
        detail = refusal or DETAIL_ROUTE_NOT_READY
        ctx.say(f"  {ROUTE_REFUSAL_LINES[detail]}")
        code = ROUTE_REFUSAL_EXIT_CODES[detail]
        status = STATUS_REFUSED if code == SETUP_EXIT_STOPPED else STATUS_FAILED
        return StepRecord("pair", status, detail, exit_code=code)

    ctx.say(f"  {STEP_7_ADDRESS_DERIVED_MESSAGE}")

    # The phone itself, last of all and immediately before the ceremony. A
    # phone that is not on the tailnet cannot claim a pairing, and the
    # ceremony's own failure never says so (#3178) — but a host with a real
    # blocker must say THAT first: waiting ten minutes for a phone and then
    # stopping with "run the same command again" would hide a stopped gateway
    # or an unready route behind a wait that never mentions either.
    phone = wait_for_a_phone(
        ctx,
        present_fn=phone_present_fn or (lambda: _default_phone_present(ctx)),
        enter_fn=enter_pressed_fn,
        wait_s=phone_wait_s,
        poll_s=phone_poll_s,
    )
    if phone == PHONE_TIMEOUT:
        return StepRecord(
            "pair",
            STATUS_REFUSED,
            DETAIL_PHONE_WAIT_TIMEOUT,
            exit_code=SETUP_EXIT_STOPPED,
        )

    # The code the ceremony mints lives two minutes. Hold here until the person
    # says they have the phone in their hand, so those two minutes start when
    # they are ready rather than while they are still looking for it.
    hold_until_ready(ctx, read_line_fn=read_line_fn)

    phone_seen = phone in PHONE_SEEN_STATES
    new_codes = 0

    while True:
        ending: Dict[str, Any] = {}

        def record_outcome(report: Mapping[str, Any]) -> None:
            ending.update(report)

        code = int(pair_fn(address, record_outcome))
        if code == SETUP_EXIT_OK:
            ctx.say(f"  {STEP_7_PAIRED_MESSAGE}")
            return StepRecord("pair", STATUS_DONE, DETAIL_PAIRED)
        # A person answering "no" to the four safety words is the user stopping,
        # which is exit 2 — but the ceremony ends that exchange as `failed`, so
        # the exit code alone would file a correct refusal as a fault. The
        # core's own reason is what separates them.
        if ending.get("reason") in (PAIRING_DENIED_REASON, "cancelled"):
            ctx.say(f"  {STEP_7_PAIRING_REFUSED_MESSAGE}")
            return StepRecord(
                "pair", STATUS_REFUSED, DETAIL_PAIRING_REFUSED, exit_code=SETUP_EXIT_STOPPED
            )
        if code == SETUP_EXIT_STOPPED:
            ctx.say(f"  {STEP_7_PAIRING_REFUSED_MESSAGE}")
            return StepRecord(
                "pair", STATUS_REFUSED, DETAIL_PAIRING_REFUSED, exit_code=SETUP_EXIT_STOPPED
            )
        if str(ending.get("reason") or "") == PAIRING_EXPIRED_REASON:
            # The code ran out with nothing claiming it. Name the cause the
            # person cannot see from this terminal, and only the cause the phone
            # check actually leaves open (#3177).
            # The ceremony reports the exchange phase. Tailnet presence cannot
            # tell whether this particular code was entered or words appeared.
            if not ending.get("phase"):
                ctx.say("  Pairing did not finish before the code expired.")
            # A code that ran out is a minute of slowness, not a broken setup,
            # so it costs one keypress and not the other seven steps. Bounded:
            # after three fresh codes something else is wrong, and a rerun
            # picks up here anyway.
            if new_codes < STEP_7_MAX_NEW_CODES and ask_for_a_new_code(
                ctx, read_line_fn=read_line_fn
            ):
                new_codes += 1
                continue
        ctx.say(f"  {STEP_7_PAIRING_FAILED_MESSAGE}")
        return StepRecord(
            "pair", STATUS_FAILED, DETAIL_PAIRING_FAILED, exit_code=SETUP_EXIT_PROBLEM
        )


# -- step 8 · the first message ----------------------------------------------
#
# Nothing is reimplemented here. `first_use_cli.run_first_use` is the whole
# step: the same receipt skip, the same typed fallback on a real terminal, the
# same line for every attempt state, the same refusal when no gateway is
# running. This wraps its lines in the ladder's indent so the step still reads
# as `[8/8]`, and carries its exit code and its evidence discriminator into the
# step record.

#: `run_first_use`'s own word for "no message ever arrived from the phone".
PHONE_TURN_TIMEOUT_STATE = "phone_turn_timeout"

#: Said whenever no message ever arrived from the phone. The private link is
#: the one thing that has to stay switched on after setup, and nothing else in
#: the run says so (#3177).
STEP_8_LEAVE_TAILSCALE_ON_MESSAGE = (
    "Tailscale on your phone has to stay switched on for the phone to reach "
    "this server."
)

#: The one thing this ladder deliberately does not decide. `hermes ocuclaw
#: doctor` reports it the moment the run finishes, and without it the phone's
#: "+" button stays grey with nothing on screen saying why. Said once, at the
#: end, and only while the choice is still open.
STEP_8_AGENT_MODE_CHOICE_MESSAGE = (
    "Optional: choose agent mode with /ocuclaw-setup in a Hermes chat. "
    'Until then the phone\'s "+" button stays grey.'
)

#: The tail deliberately does NOT name `hermes ocuclaw pair`: that verb needs
#: an `--address` the user cannot get from this terminal, so the sentence used
#: to error the moment it was copied (#3234c, the same fix `pairing.py` took for
#: its own ending). What is named instead is a diagnosis they can run and the
#: command they are already in.
STEP_8_STALE_PAIRING_MESSAGE = (
    "this run skipped pairing because a previous pairing is recorded here. If "
    "that phone is gone, or this host has been reset since it was paired, it "
    "can no longer connect: run `hermes ocuclaw doctor` to see what this host "
    "has, then run the same command again."
)

#: Outcome and evidence in one journal word, so a later reader can never mistake
#: SDK acceptance for the wearer having said anything.
DETAIL_BY_EVIDENCE: Dict[Tuple[str, Optional[str]], str] = {
    ("committed", "client_sdk_receipt"): DETAIL_COMMITTED_SDK,
    ("committed", "wearer_confirmed"): DETAIL_COMMITTED_WEARER,
    ("committed", None): DETAIL_COMMITTED,
    ("armed", "client_sdk_receipt"): DETAIL_ARMED_SDK,
    ("armed", "wearer_confirmed"): DETAIL_ARMED_WEARER,
    ("armed", None): DETAIL_ARMED,
}


def first_use_detail(record: Mapping[str, Any]) -> str:
    """One closed-vocabulary word for the journal, evidence never blurred."""
    outcome = str(record.get("outcome") or "failed")
    evidence = record.get("replyEvidence")
    evidence = str(evidence) if evidence else None
    if outcome in ("committed", "armed"):
        if evidence not in ("client_sdk_receipt", "wearer_confirmed"):
            evidence = None
        return DETAIL_BY_EVIDENCE[(outcome, evidence)]
    if outcome == "refused":
        return DETAIL_FIRST_USE_REFUSED
    return DETAIL_FIRST_USE_FAILED


def _default_first_use(ctx: StepContext) -> Mapping[str, Any]:
    """The standalone verb, in this terminal, under the ladder's indent.

    The streams, the TTY probe and the phone-turn wait come from the ladder.
    The clock deliberately does not: the ladder's is monotonic, while the
    first-run receipts are stamped in wall time and an attempt lives one hour.
    """
    from . import first_use_cli

    def line(text: str) -> None:
        ctx.say(f"  {text}" if text else "")

    def prompt(text: str) -> None:
        from .terminal_output import styled

        # The wearer types the answer ON this line, so unlike every other line
        # it must not end in a newline — which is exactly what `ctx.say` adds.
        # Written straight to the same terminal instead, indent and all, so the
        # question looks here exactly as it does in `hermes ocuclaw first-use`.
        try:
            ctx.stream_out.write(styled(f"  {text}", ctx.stream_out, ctx.env, role="prompt"))
            ctx.stream_out.flush()
        except Exception:  # noqa: BLE001 - a closed stream never fails the step
            pass

    return first_use_cli.run_first_use(
        stdin=ctx.stream_in,
        stdout=ctx.stream_out,
        stderr=ctx.stream_out,
        home=_home_of(ctx),
        wait_seconds=ctx.options.first_use_wait_s,
        isatty_fn=ctx.isatty,
        line_fn=line,
        prompt_fn=prompt,
    )


def _default_agent_mode_chosen() -> bool:
    """Has agent mode been chosen? The doctor's own rule, on one config read.

    `hermes ocuclaw doctor` calls the choice made only when the recorded
    `platforms.ocuclaw.extra.agent_mode` AGREES with `gateway.multiplex_
    profiles` (`adapter.py`, `mandatoryConfiguration`). A recorded word with no
    matching gateway switch is not a choice, so reading the word alone would
    silence this line on exactly the host that needs it.

    Deliberately without the doctor's `.env`-seed overlay: leaving it out can
    only answer "not chosen" more often, and over-naming a choice the user can
    re-make harmlessly beats staying quiet about a grey "+" button. A config
    that cannot be read answers "not chosen" for the same reason.
    """
    from . import health

    try:
        config, readable = health.setup_raw_config()
    except Exception:  # noqa: BLE001 - an unreadable config is not a choice
        return False
    if not readable or not isinstance(config, Mapping):
        return False
    gateway = config.get("gateway")
    multiplex = (
        gateway.get("multiplex_profiles") if isinstance(gateway, Mapping) else None
    )
    platforms = config.get("platforms")
    block = platforms.get("ocuclaw") if isinstance(platforms, Mapping) else None
    extra = block.get("extra") if isinstance(block, Mapping) else None
    agent_mode = extra.get("agent_mode") if isinstance(extra, Mapping) else None
    return isinstance(multiplex, bool) and (
        (agent_mode == "multiple" and multiplex is True)
        or (agent_mode == "single" and multiplex is False)
    )


def step_8_first_use(
    ctx: StepContext,
    *,
    first_use_fn: Optional[Callable[[], Mapping[str, Any]]] = None,
    agent_mode_chosen_fn: Optional[Callable[[], bool]] = None,
) -> StepRecord:
    """Run the first-message check here, in this terminal, and report it."""
    if ctx.options.no_first_use:
        ctx.say(f"  {STEP_8_SKIPPED_MESSAGE}")
        return StepRecord(
            "first-use", STATUS_SKIPPED, "no-first-use", exit_code=SETUP_EXIT_OK
        )

    first_use_fn = first_use_fn or (lambda: _default_first_use(ctx))
    agent_mode_chosen_fn = agent_mode_chosen_fn or _default_agent_mode_chosen
    result = first_use_fn() or {}
    code = int(result.get("exitCode") or SETUP_EXIT_OK)
    record = result.get("record")
    record = record if isinstance(record, Mapping) else {}
    detail = first_use_detail(record)

    if record.get("attemptState") == PHONE_TURN_TIMEOUT_STATE:
        ctx.say(f"  {STEP_8_LEAVE_TAILSCALE_ON_MESSAGE}")
        if ctx.state.get("pairing_skipped_as_already_paired"):
            # The pairing receipt says a phone was paired here once; it cannot
            # say that phone still exists, or that it still holds the current
            # Relay Credential. So when no message ever arrives after a skipped
            # pairing, name the one thing the user would otherwise never think
            # to check.
            ctx.say(f"  {STEP_8_STALE_PAIRING_MESSAGE}")

    if code == SETUP_EXIT_OK:
        # Committed or cleanly handed off to the welcome double-tap. Either way
        # the ladder is done and the exit code is the run's own.
        # Exit 0 is the whole ladder finishing, whether the proof committed
        # here or was handed to the wearer's welcome double-tap; `armed` is the
        # ordinary fresh-install outcome, so gating on `committed` would hide
        # this line on exactly the run it was written for. `outcome` and the
        # `DETAIL_*` journal words are two vocabularies; never compare them.
        if not agent_mode_chosen_fn():
            ctx.say(f"  {STEP_8_AGENT_MODE_CHOICE_MESSAGE}")
        return StepRecord("first-use", STATUS_DONE, detail)
    status = STATUS_REFUSED if code == SETUP_EXIT_STOPPED else STATUS_FAILED
    return StepRecord("first-use", status, detail, exit_code=code)


__all__ = [
    "CLAIM_FOREIGN",
    "CLAIM_OWNED",
    "CLAIM_REFUSALS",
    "CLAIM_UNAVAILABLE",
    "CLAIM_UNCLAIMED",
    "HEALTH_HEALTHY",
    "PAIRING_DENIED_REASON",
    "PAIRING_EXPIRED_REASON",
    "PHONE_APPEARED",
    "PHONE_CARRIED_ON",
    "PHONE_FOUND",
    "PHONE_NO_TERMINAL",
    "PHONE_POLL_S",
    "PHONE_SEEN_STATES",
    "PHONE_TIMEOUT",
    "PHONE_TURN_TIMEOUT_STATE",
    "PHONE_UNREADABLE",
    "PHONE_WAIT_S",
    "PHONE_WALKTHROUGH_LINES",
    "ROUTE_READY",
    "ROUTE_REFUSAL_EXIT_CODES",
    "ROUTE_REFUSAL_LINES",
    "STEP_7_INPUT_WAIT_S",
    "STEP_7_MAX_NEW_CODES",
    "STEP_7_NEW_CODE_PROMPT",
    "STEP_7_NOBODY_ENTERED_MESSAGE",
    "STEP_7_NO_PHONE_CAUSE_MESSAGE",
    "STEP_7_READY_LINES",
    "STEP_8_AGENT_MODE_CHOICE_MESSAGE",
    "STEP_DETAILS",
    "ask_for_a_new_code",
    "collect_route_evidence",
    "first_use_detail",
    "hold_until_ready",
    "phone_address_for",
    "step_7_pair",
    "step_8_first_use",
    "wait_for_a_phone",
]
