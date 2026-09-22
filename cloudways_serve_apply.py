"""Step 6 of the Cloudways ladder: publish the private route, with consent.

**This module is the one Tailscale Serve apply seam in this bundle**, and it
exists only because of a scoped, deliberate reversal of one line of #1272.

Why there is an apply seam at all (ADR-0026)
--------------------------------------------

P15 rung 2 — "the CLI applies the Serve route" — was rejected outright in
#1272, on two grounds: the trigger was unobservable and the change had no
owner. :mod:`serve` still carries that rejection in its own header, and still
ships no mutation path of any kind.

Matty reopened exactly one path on 2026-09-18 (SPEC #3094, ticket #3104),
because on the Cloudways Managed AI Agents container both objections are
answered:

* **The trigger is observable.** Step 1 of this ladder refuses anything but a
  decisive Cloudways verdict, so the apply only ever happens on a host this
  ladder was designed for. :func:`run_private_route` re-checks that verdict
  itself rather than trusting where it sits in the ladder.
* **The change has an owner.** The user is shown the exact command, is told
  in plain words what it exposes and to whom, and types ``yes`` to it. The
  question defaults to No.

Everywhere else the plugin stays print-only. ``hermes ocuclaw doctor`` prints
the command; nothing in this bundle but this module runs it.

The rules this seam keeps
-------------------------

* **One command, resolved once.** The argv is built *before* the consent and
  the printed line is that argv, joined. Deriving each side separately would
  read the tailscale CLI receipt twice with an unbounded human pause in
  between, so a receipt that changed while the user was reading would have
  them consent to one binary and run another. ``tests/
  test_cloudways_serve_apply.py`` asserts the joined argv is byte-identical to
  :func:`serve.apply_command`, and that a receipt that changes during the
  prompt does not change what runs.
* **Loopback only.** The route forwards to :data:`serve.LOOPBACK`. No
  all-interfaces bind address appears here or anywhere in the payload.
* **Never Funnel, never public.** Nothing here can pass ``--funnel``; the
  consent says so out loud.
* **The certificate precheck is a hard gate** (#2672). A tailnet that cannot
  issue the node's TLS certificate produces a route that classifies ``ready``
  and fails every connection, so the consent is never even offered there.
* **Configured is not working** (#1275). :func:`serve.observe` decides the
  route's *shape* and nothing else. Health is the front-door TLS handshake in
  :mod:`doctor`, and it is the only thing that lets this step finish.
* **The receipt follows the observation.** Nothing at all is written before the
  user's ``yes``, nor on the way out of a refusal after it — decline, or let
  somebody else take the port while you read, and this host is bit-for-bit as
  it was. Both halves
  of the Managed Serve Route receipt are then written by the existing writer,
  :func:`doctor.record_route_ownership`, in its existing order: the *proposed*
  half at the moment the ladder proposes the command (which here is the moment
  after the user accepted it, and before the port changes, so two installs
  cannot both take the host's one route), and the *observed* half only once the
  route has actually answered. A run that applies and then times out leaves the
  proposal and no observation, which is what lets the rerun finish the claim
  for the route it really did apply.
* **A route that is not ours is diagnosed, never replaced.** A foreign or
  ambiguous route ends the step with a plain line and no change. The port is
  re-read *after* the yes and before anything is written, because the consent
  prompt is an unbounded pause and a route can appear on that port during it.
* **The test-only marker widens where this can run.**
  ``OCUCLAW_HERMES_ASSUME_CLOUDWAYS_HOST`` makes step 1 decisive on a host
  detection did not recognise, which now enables the apply and not only the
  detection. It is never to be set on a user's machine. When it is in force the
  consent says so, in its own line, before the question.
"""
from __future__ import annotations

import shlex
import subprocess
from typing import Any, Callable, Dict, Mapping, Optional, Sequence, Tuple

from . import doctor, receipts, serve

# -- bounds -------------------------------------------------------------------

#: How long the step waits for the route to start answering after the apply.
#:
#: Deliberately OUTSIDE :data:`doctor.PROBE_TOTAL_BUDGET_S`. That five-second
#: budget bounds a diagnostic somebody is watching; this one bounds a TLS
#: certificate the tailnet is still minting for a node that was authorized
#: seconds ago, which routinely takes tens of seconds. Borrowing the probe
#: budget here would report a perfectly good route as broken.
ROUTE_WAIT_S = 120.0

#: One health probe's own allowance, and the poll and notice cadence of the
#: wait around it.
ROUTE_PROBE_TIMEOUT_S = doctor.PROBE_DEFAULT_TIMEOUT_S
ROUTE_POLL_S = 5.0
ROUTE_NOTICE_S = 20.0

#: The apply itself is one short local command; it is not a wait.
APPLY_TIMEOUT_S = 20.0

# -- journal vocabulary -------------------------------------------------------

#: The closed set of words this step may put in ``StepRecord.detail``. Never a
#: link, an address, a node name or a credential — the journal is support
#: evidence, and these are the only things it learns from step 6.
DETAIL_NOT_DECISIVE = "route-not-decisive"
DETAIL_FOREIGN = "route-foreign"
DETAIL_UNREADABLE = "route-unreadable"
DETAIL_NO_TAILNET_NAME = "route-no-tailnet-name"
DETAIL_CERT_UNAVAILABLE = "route-tls-cert-unavailable"
DETAIL_DECLINED = "route-declined"
DETAIL_APPLY_FAILED = "route-apply-failed"
DETAIL_WAIT_TIMEOUT = "route-wait-timeout"
DETAIL_NOT_READY_AFTER_APPLY = "route-not-ready-after-apply"
DETAIL_PUBLISHED = "route-published"
DETAIL_PRESENT = "route-present"

ROUTE_JOURNAL_DETAILS = frozenset(
    {
        DETAIL_NOT_DECISIVE,
        DETAIL_FOREIGN,
        DETAIL_UNREADABLE,
        DETAIL_NO_TAILNET_NAME,
        DETAIL_CERT_UNAVAILABLE,
        DETAIL_DECLINED,
        DETAIL_APPLY_FAILED,
        DETAIL_WAIT_TIMEOUT,
        DETAIL_NOT_READY_AFTER_APPLY,
        DETAIL_PUBLISHED,
        DETAIL_PRESENT,
    }
)

# -- what the user reads ------------------------------------------------------

NOT_DECISIVE_MESSAGE = (
    'Cloudways host was not confirmed. No route was applied.\n'
    'Run hermes ocuclaw doctor for the manual route command.'
)

UNREADABLE_ROUTE_MESSAGE = (
    'Could not read the Tailscale route configuration. Nothing changed.\n'
    'Check tailscale serve status, then run setup again.'
)

FOREIGN_ROUTE_MESSAGE = (
    'Another service owns this port. No route was applied.\n'
    'Check tailscale serve status. Run setup again once the port is available.'
)

FOREIGN_OWNER_MESSAGE = (
    'Another OcuClaw installation owns this route. Nothing changed.\n'
    'Replacing it would disconnect that installation.'
)

NO_TAILNET_NAME_MESSAGE = (
    "Could not read this server's Tailscale name. No route was applied.\n"
    'Check that Tailscale is running, then run setup again.'
)

CERT_UNAVAILABLE_MESSAGE = (
    'Tailscale cannot issue the certificate needed for this route. Nothing changed.\n'
    'In the Tailscale admin console, open DNS and enable MagicDNS and HTTPS '
    'Certificates.\n'
    'Then run setup again.'
)

CERT_UNKNOWN_MESSAGE = (
    "Could not check this server's certificate yet.\n"
    'Setup will continue and check that the route answers.'
)

APPLY_FAILED_MESSAGE = (
    'No route was applied.\n'
    'Run setup again, or run the command above to see the full error.'
)

#: Something took the port between the consent and the apply. The user said yes
#: to publishing a route on a free port, not to replacing somebody else's.
TOOK_THE_PORT_MESSAGE = (
    'Another service took this port before setup could apply the route. Nothing was '
    'replaced.\n'
    'Check tailscale serve status, then run setup again.'
)

#: Said before the consent question whenever the test-only marker is what let
#: the ladder get this far.
OVERRIDE_CONSENT_LINE = (
    "  This host was NOT detected as a Cloudways Managed AI Agents container: "
    "the test-only marker OCUCLAW_HERMES_ASSUME_CLOUDWAYS_HOST is in force, "
    "which is what allows this apply to be offered here at all. Never set it "
    "on a real machine."
)

WAIT_TIMEOUT_MESSAGE = (
    'The route was applied but has not answered yet.\n'
    'Its certificate may still be pending. Run setup again to recheck it.'
)

UNSETTLED_OWNERSHIP_MESSAGE = (
    "Could not save this installation's route ownership. No route was applied.\n"
    'Check that the OcuClaw host state directory is writable, then run setup again.'
)

NOT_READY_AFTER_APPLY_MESSAGE = (
    'The route answered, but its configuration no longer matches this installation.\n'
    'Route ownership was not recorded. Run hermes ocuclaw doctor to check the port.'
)

TLS_WAIT_LINE = (
    "the node's TLS certificate is not ready yet. That is normal on a node "
    "this new; still waiting."
)

WAIT_LINE = "still waiting for the route to answer."


def consent_lines(
    command: str, *, override_in_force: bool = False, details: bool = False
) -> Tuple[str, ...]:
    """The exact command, what it exposes, and to whom. Default No.

    Everything a person needs to answer this is on the screen in BOTH forms,
    and ADR-0026 is why: the literal line that will run, the blast radius in
    plain words, the fact that saying nothing means no, and — when the
    test-only host marker is what got the ladder here — that this host was
    never actually recognised. ``--details`` (#3244) adds what a careful
    operator wants next: that it is one route on one port, that `doctor`
    prints the command that removes it, and that the line stays theirs to run
    by hand. It never changes the command, the question or the answer.
    """
    override = (OVERRIDE_CONSENT_LINE,) if override_in_force else ()
    if not details:
        return override + (
            "  Allow access from your tailnet only. Never public; never Tailscale Funnel.",
            "  If you say yes, setup will run:",
            f"    {command}",
            "  Answer anything but yes and nothing is changed.",
        )
    return override + (
        "  If you say yes, setup will run:",
        f"    {command}",
        "  This makes the relay reachable only from inside your own tailnet, on "
        "devices signed in to it.",
        "  It is never Tailscale Funnel and it is never public: nothing outside "
        "your tailnet can reach it.",
        "  It adds one route on one port. `hermes ocuclaw doctor` prints the one "
        "command that removes it again.",
        "  Answering anything but yes applies nothing and changes nothing; the "
        "line above stays yours to run by hand.",
    )


# -- the one apply argv -------------------------------------------------------


def serve_apply_argv(*, relay_port: int, port: Optional[int] = None) -> Tuple[str, ...]:
    """The argv this module executes — the printed command's own pieces.

    Built from :func:`serve.tailscale_argv`, :func:`serve.serve_port` and
    :data:`serve.LOOPBACK`, the same three accessors
    :func:`serve.apply_command` uses to build the string a user reads. The
    equality of the two is asserted by a test rather than assumed, because the
    whole consent rests on the user having read the command that then runs.

    Called ONCE per run, before the consent. :func:`serve.tailscale_argv`
    re-reads the host's tailscale CLI receipt on every call, and the consent is
    an unbounded human pause; calling this again afterwards could execute a
    different binary from the one the user read.
    """
    return serve.tailscale_argv() + (
        "serve",
        "--bg",
        f"--tls-terminated-tcp={serve.serve_port(port)}",
        f"tcp://{serve.LOOPBACK}:{int(relay_port)}",
    )


def relay_port() -> int:
    """The loopback port the route forwards to (the bundle's relay port).

    Imported lazily, as :mod:`cloudways` does with the same constant, so
    wiring a CLI subparser does not drag the control link in.
    """
    from .control_link import HERMES_BUNDLE_DEFAULT_WS_PORT

    return int(HERMES_BUNDLE_DEFAULT_WS_PORT)


# -- the step -----------------------------------------------------------------


def run_private_route(
    ctx: Any,
    *,
    probe_fn: Optional[Callable[[str, int, float], str]] = None,
    observe_fn: Optional[Callable[..., Any]] = None,
    cert_fn: Optional[Callable[..., str]] = None,
    record_fn: Optional[Callable[..., str]] = None,
) -> Any:
    """Publish the private route on a decisive Cloudways host, after consent.

    The seams are resolved here rather than bound as defaults so a test can
    substitute the network probe on the module and still drive the whole step
    through ``run_setup``, the way a user drives it.
    """
    setup = _setup()
    probe = probe_fn or _default_probe
    observe = observe_fn or _default_observe
    cert = cert_fn or _default_cert
    record = record_fn or doctor.record_route_ownership

    def record_for(status: str, detail: str, exit_code: Optional[int] = None) -> Any:
        return setup.StepRecord("private-route", status, detail, exit_code=exit_code)

    # The trigger, checked here and not inferred from ladder order. Step 1 sets
    # this flag only after a decisive Cloudways verdict, and it is the whole
    # reason this seam is allowed to exist; a caller that reorders or trims the
    # ladder gets a refusal, not an apply.
    if not _decisive_cloudways(ctx):
        ctx.say(f"  {NOT_DECISIVE_MESSAGE}")
        return record_for(
            setup.STATUS_REFUSED, DETAIL_NOT_DECISIVE, setup.SETUP_EXIT_STOPPED
        )

    port = relay_port()
    observation = observe(ctx, port)
    classification = getattr(observation, "classification", serve.CLASSIFY_UNKNOWN)

    if classification == serve.CLASSIFY_UNKNOWN:
        # Never read is never "absent": applying over a route we could not see
        # is exactly the replacement this lane refuses to make.
        ctx.say(f"  {UNREADABLE_ROUTE_MESSAGE}")
        return record_for(
            setup.STATUS_FAILED, DETAIL_UNREADABLE, setup.SETUP_EXIT_PROBLEM
        )

    if classification == serve.CLASSIFY_WRONG:
        ctx.say(f"  {FOREIGN_ROUTE_MESSAGE}")
        return record_for(
            setup.STATUS_REFUSED, DETAIL_FOREIGN, setup.SETUP_EXIT_STOPPED
        )

    facts = _route_facts(ctx, observation, port)

    # Whatever comes next, it is not going to be a fight with a sibling install
    # over the one host-global port.
    if _claim_conflict(facts) is not None:
        ctx.say(f"  {FOREIGN_OWNER_MESSAGE}")
        return record_for(
            setup.STATUS_REFUSED, DETAIL_FOREIGN, setup.SETUP_EXIT_STOPPED
        )

    dns_name = getattr(observation, "dns_name", None)
    if not dns_name:
        ctx.say(f"  {NO_TAILNET_NAME_MESSAGE}")
        return record_for(
            setup.STATUS_FAILED, DETAIL_NO_TAILNET_NAME, setup.SETUP_EXIT_PROBLEM
        )

    if classification == serve.CLASSIFY_READY:
        # A rerun, or a route the user applied by hand from doctor's line. The
        # apply is skipped; the health leg still has to pass, because a
        # configured route is not a working one.
        return _finish(
            ctx,
            setup,
            facts=facts,
            dns_name=dns_name,
            probe=probe,
            observe=observe,
            record=record,
            port=port,
            applied=False,
        )

    # -- absent: the apply path ----------------------------------------------

    # #2672's precheck, before the consent rather than after it: a route this
    # tailnet cannot certify would apply cleanly, classify `ready`, and fail
    # every connection, so the question is never asked there.
    verdict = cert(ctx, dns_name)
    if verdict == doctor.OUTCOME_CERT_UNAVAILABLE:
        ctx.say(f"  {CERT_UNAVAILABLE_MESSAGE}")
        return record_for(
            setup.STATUS_FAILED, DETAIL_CERT_UNAVAILABLE, setup.SETUP_EXIT_PROBLEM
        )
    if verdict != doctor.OUTCOME_CERT_AVAILABLE:
        # Unknown withholds nothing and claims nothing, exactly as it does in
        # doctor: a missing binary or a timeout is not evidence against the
        # tailnet, and the health wait below is the real gate either way.
        ctx.say(f"  {CERT_UNKNOWN_MESSAGE}")

    # Resolved once, here: this exact tuple is what is printed and what is run.
    argv = serve_apply_argv(relay_port=port)
    command = shlex.join(argv)
    # The whole word, and a prompt that asks for it. This publishes a route,
    # which ADR-0026 has the user consent to by typing `yes`; a bare `y` stops,
    # so the question says which word it wants rather than surprising anyone.
    if not ctx.ask(
        consent_lines(
            command,
            override_in_force=_assume_marker_set(ctx),
            details=bool(getattr(ctx.options, "details", False)),
        ),
        question=setup.WHOLE_WORD_CONSENT_QUESTION,
    ):
        # Nothing has been written and nothing has been run.
        ctx.say(f"  {setup.RESUME_MESSAGE}")
        return record_for(
            setup.STATUS_DECLINED, DETAIL_DECLINED, setup.SETUP_EXIT_STOPPED
        )

    # The consent is an unbounded pause, so the port is read again before
    # anything is written or run. The user agreed to publish a route on a free
    # port; if something took it meanwhile, that is a route this lane never
    # replaces, and refusing here leaves no receipt of any kind behind.
    fresh = observe(ctx, port)
    if (
        getattr(fresh, "classification", None) != serve.CLASSIFY_ABSENT
        or getattr(fresh, "dns_name", None) != dns_name
    ):
        ctx.say(f"  {TOOK_THE_PORT_MESSAGE}")
        return record_for(
            setup.STATUS_REFUSED, DETAIL_FOREIGN, setup.SETUP_EXIT_STOPPED
        )

    # The proposed half, written before the port changes and never after: two
    # installs that both found no receipt would otherwise both apply, and the
    # loser would silently repoint the winner's route. The write is an atomic
    # first claim, so exactly one of them gets past this line. It records a
    # proposal and nothing observed — this receipt on its own can never satisfy
    # the teardown gate.
    proposal = record(facts)
    if proposal != doctor.RECORD_PROPOSED:
        ctx.say(
            f"  {FOREIGN_OWNER_MESSAGE}"
            if proposal in (doctor.RECORD_FOREIGN_OWNER, doctor.RECORD_UNREADABLE_CLAIM)
            else f"  {UNSETTLED_OWNERSHIP_MESSAGE}"
        )
        return record_for(
            setup.STATUS_REFUSED, DETAIL_FOREIGN, setup.SETUP_EXIT_STOPPED
        )

    returncode, message = _apply(ctx, argv)
    if returncode != 0:
        if message:
            ctx.say(f"  {message}")
        ctx.say(f"  {APPLY_FAILED_MESSAGE}")
        return record_for(
            setup.STATUS_FAILED, DETAIL_APPLY_FAILED, setup.SETUP_EXIT_PROBLEM
        )
    ctx.say("  the route is applied. Waiting for it to answer.")

    return _finish(
        ctx,
        setup,
        facts=facts,
        dns_name=dns_name,
        probe=probe,
        observe=observe,
        record=record,
        port=port,
        applied=True,
    )


def _finish(
    ctx: Any,
    setup: Any,
    *,
    facts: Mapping[str, Any],
    dns_name: str,
    probe: Callable[[str, int, float], str],
    observe: Callable[..., Any],
    record: Callable[..., str],
    port: int,
    applied: bool,
) -> Any:
    """Wait for the route to answer, then record what was observed."""
    healthy, _last_outcome = _wait_for_route(ctx, dns_name=dns_name, probe=probe)
    if not healthy:
        # A bounded wait that ran out is a wait, not a broken route, and it
        # costs the user nothing: the next run picks up exactly here. No
        # observed receipt is written, because nothing was observed.
        ctx.say(f"  {WAIT_TIMEOUT_MESSAGE}")
        return setup.StepRecord(
            "private-route",
            setup.STATUS_FAILED,
            DETAIL_WAIT_TIMEOUT,
            exit_code=setup.SETUP_EXIT_PROBLEM,
        )

    # Re-read the shape now that the route is live: the receipt records a route
    # this host observed, so the classification that goes into it has to be one
    # taken after the apply, never the one taken before it.
    observation = observe(ctx, port)
    if getattr(observation, "classification", None) != serve.CLASSIFY_READY:
        ctx.say(f"  {NOT_READY_AFTER_APPLY_MESSAGE}")
        return setup.StepRecord(
            "private-route",
            setup.STATUS_FAILED,
            DETAIL_NOT_READY_AFTER_APPLY,
            exit_code=setup.SETUP_EXIT_PROBLEM,
        )

    ready_facts = dict(facts)
    ready_facts["serveClassification"] = serve.CLASSIFY_READY
    try:
        record(ready_facts)
    except Exception:  # noqa: BLE001 - a receipt failure is not an outage
        pass

    if applied:
        ctx.say("  the private route is published and answering.")
        return setup.StepRecord("private-route", setup.STATUS_DONE, DETAIL_PUBLISHED)
    ctx.say("  the private route is already published and answering.")
    return setup.StepRecord("private-route", setup.STATUS_SKIPPED, DETAIL_PRESENT)


def _wait_for_route(
    ctx: Any,
    *,
    dns_name: str,
    probe: Callable[[str, int, float], str],
) -> Tuple[bool, str]:
    """Bounded wait on the front-door TLS handshake. Never the classifier.

    ``serve status`` answers whether the route is *configured*, which #1275
    proved says nothing about whether it works. The only thing allowed to end
    this wait is the route itself answering a TLS handshake on its own
    certificate.
    """
    port = serve.serve_port()
    deadline = ctx.clock() + ROUTE_WAIT_S
    last_notice = ctx.clock()
    while True:
        try:
            outcome = probe(dns_name, port, ROUTE_PROBE_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - a failed probe observed nothing
            outcome = doctor.OUTCOME_FAILED
        if outcome == doctor.OUTCOME_REACHABLE:
            return True, outcome
        if ctx.clock() >= deadline:
            return False, outcome
        if ctx.clock() - last_notice >= ROUTE_NOTICE_S:
            last_notice = ctx.clock()
            ctx.say(
                f"  {TLS_WAIT_LINE}"
                if outcome == doctor.OUTCOME_TLS_HANDSHAKE_FAILED
                else f"  {WAIT_LINE}"
            )
        ctx.sleep(min(ROUTE_POLL_S, max(0.0, deadline - ctx.clock())))


# -- the pieces ---------------------------------------------------------------


def _setup() -> Any:
    """The ladder's vocabulary, imported lazily to keep the cycle unbuilt."""
    from . import cloudways_setup

    return cloudways_setup


def _decisive_cloudways(ctx: Any) -> bool:
    """Did step 1 reach the decisive Cloudways verdict in THIS run?"""
    return bool(getattr(ctx, "state", {}).get("host_check_passed"))


def _assume_marker_set(ctx: Any) -> bool:
    """Is the test-only host marker what let this run get here?

    Read from the ladder's own injected environment, and named in the consent
    when it is set: on a host detection did not recognise, this marker is what
    enables the apply, not merely the detection.
    """
    from .cloudways_setup import ASSUME_CLOUDWAYS_ENV

    return str(getattr(ctx, "env", {}).get(ASSUME_CLOUDWAYS_ENV, "")).strip() == "1"


def _route_facts(ctx: Any, observation: Any, port: int) -> Dict[str, Any]:
    """The four keys the Managed Serve Route writers read. Nothing else."""
    return {
        "serveClassification": getattr(observation, "classification", None),
        "serveRelayPort": int(port),
        "serveNodeDnsName": getattr(observation, "dns_name", None),
        "hermesHomeFingerprint": receipts.fingerprint_home(ctx.layout.hermes_home),
    }


def _claim_conflict(facts: Mapping[str, Any]) -> Optional[str]:
    """Why this install may not write the host receipt, or ``None``.

    The ownership rule has exactly one implementation, in :mod:`doctor`, and
    this asks it rather than keeping a second copy that could drift away from
    the one the rest of the lane enforces.
    """
    try:
        existing, status = receipts.read_managed_serve_route()
        known = existing if status == "ok" and isinstance(existing, Mapping) else {}
        return doctor.ownership_conflict(
            status, known, facts.get("hermesHomeFingerprint")
        )
    except Exception:  # noqa: BLE001 - an unreadable claim is still a claim
        return doctor.RECORD_UNREADABLE_CLAIM


def _default_observe(ctx: Any, port: int) -> Any:
    """Read the route's shape through the ladder's injected runner."""
    return serve.observe(
        relay_port=port,
        serve_runner=ctx.runner,
        status_runner=ctx.runner,
    )


def _default_cert(ctx: Any, dns_name: str) -> str:
    """#2672's certificate precheck, through the ladder's injected runner."""
    return doctor.tailnet_tls_cert_check(
        dns_name, ROUTE_PROBE_TIMEOUT_S, runner=_cert_runner(ctx)
    )


def _cert_runner(
    ctx: Any,
) -> Optional[Callable[[Sequence[str], float], Optional[Tuple[int, str]]]]:
    """Adapt ``ctx.runner`` to the shape doctor's cert check expects."""
    if ctx.runner is None:
        return None

    def run(args: Sequence[str], timeout_s: float) -> Optional[Tuple[int, str]]:
        try:
            completed = ctx.runner(
                list(args),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except Exception:  # noqa: BLE001 - a substituted runner may raise anything
            return None
        return (
            int(getattr(completed, "returncode", 1)),
            str(getattr(completed, "stderr", "") or getattr(completed, "stdout", "") or ""),
        )

    return run


def _default_probe(dns_name: str, port: int, timeout_s: float) -> str:
    """Doctor's front-door TLS handshake, through this host's own proxy."""
    return doctor.tailnet_front_door_check(
        dns_name, port, timeout_s, socks5=_socks5()
    )


def _socks5() -> Optional[Tuple[str, int]]:
    """The loopback SOCKS5 proxy of a userspace tailscaled, or ``None``."""
    try:
        receipt = receipts.read_tailscale_cli()
    except Exception:  # noqa: BLE001 - a broken receipt means direct dial
        return None
    return None if receipt is None else receipt.socks5


def _apply(ctx: Any, argv: Sequence[str]) -> Tuple[Optional[int], str]:
    """Run the apply. The ONE mutating subprocess in this bundle.

    It goes through ``ctx.runner`` whenever the ladder was handed one, which is
    what lets every test above drive this seam without a real tailnet.
    """
    runner = subprocess.run if ctx.runner is None else ctx.runner
    try:
        completed = runner(
            list(argv),
            capture_output=True,
            text=True,
            timeout=APPLY_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, "the apply command did not finish in time."
    except Exception as exc:  # noqa: BLE001 - a substituted runner may raise
        return None, str(exc)[:200]
    returncode = getattr(completed, "returncode", 1)
    message = str(
        getattr(completed, "stderr", "") or getattr(completed, "stdout", "") or ""
    ).strip()
    return returncode, message.splitlines()[0][:200] if message else ""


__all__ = [
    "APPLY_TIMEOUT_S",
    "ROUTE_JOURNAL_DETAILS",
    "ROUTE_NOTICE_S",
    "ROUTE_POLL_S",
    "ROUTE_PROBE_TIMEOUT_S",
    "ROUTE_WAIT_S",
    "consent_lines",
    "relay_port",
    "run_private_route",
    "serve_apply_argv",
]
