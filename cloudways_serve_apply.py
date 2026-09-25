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
  The precheck only reads ``tailscale status --json`` (#3648). The one
  ``tailscale cert`` call starts after the yes and the apply: an issued
  certificate publishes the node's tailnet name in public Certificate
  Transparency logs, so a "no" must never have started one.
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

import os
import shlex
import shutil
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
#: Five minutes, matched by the OpenClaw ladder (DEFAULT_CERTIFICATE_WAIT_MS):
#: two minutes sent people back to rerun setup several times.
ROUTE_WAIT_S = 300.0

#: One health probe's own allowance, and the poll and notice cadence of the
#: wait around it. One progress line about every 30 seconds, never one per
#: poll.
ROUTE_PROBE_TIMEOUT_S = doctor.PROBE_DEFAULT_TIMEOUT_S
ROUTE_POLL_S = 5.0
ROUTE_NOTICE_S = 30.0

#: The apply itself is one short local command; it is not a wait.
APPLY_TIMEOUT_S = 20.0

#: How long ONE ``tailscale cert`` call may run (#3593). It covers the whole
#: certificate wait, because killing the call cancels the issuance Tailscale
#: started for it: a real box whose ``set-dns`` call took over 30 seconds never
#: got its certificate while each call was killed after 2 seconds, and one call
#: left alone got it in 37 seconds.
CERT_ISSUE_BUDGET_S = ROUTE_WAIT_S

#: A call that ended without the certificate is started again, one at a time,
#: and never sooner than this after the last start.
CERT_RETRY_S = ROUTE_NOTICE_S

#: How long a fresh call is watched for a quick answer before the ladder moves
#: on and lets it run: a certificate Tailscale already holds comes back at
#: once, and so does a tailnet that cannot issue certificates at all.
CERT_GLANCE_S = ROUTE_PROBE_TIMEOUT_S
CERT_GLANCE_POLL_S = 0.25

#: At most this many calls in one wait. The precheck makes none (#3648). A call that
#: ends without the certificate is usually a failed ACME order, and Let's
#: Encrypt allows only five failed validations per host name per hour. After
#: the last one the wait goes on with the route probe alone.
CERT_MAX_CALLS = 3

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

#: Said once the route is applied, word for word the OpenClaw ladder's own
#: cold-certificate line, and then its "ready" line once the route answers.
COLD_CERTIFICATE_MESSAGE = (
    'Waiting for the certificate. This usually takes a minute or two.'
)
CERTIFICATE_READY_MESSAGE = 'Certificate ready.'

#: The step's own reading of a certificate check that ran out of time. On a
#: node authorized minutes ago that is the certificate still being issued, not
#: a check that could not run, so it is waited on rather than apologised for.
#: Never written to the journal; doctor's three outcomes are untouched.
CERT_PENDING = 'tls_cert_pending'

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

#: The certificate wait ran out. Everything before it is kept, so a rerun picks
#: up at this step. Word for word the OpenClaw ladder's
#: CERTIFICATE_TIMEOUT_MESSAGE.
CERTIFICATE_TIMEOUT_MESSAGE = (
    'The certificate is not ready yet. Run the same command again; setup picks up here.'
)

#: A route that was already published, and never failed on its certificate,
#: still did not answer by the end of the wait.
ROUTE_TIMEOUT_MESSAGE = (
    'The private route has not answered yet. Run the same command again; setup picks up '
    'here.'
)

UNSETTLED_OWNERSHIP_MESSAGE = (
    "Could not save this installation's route ownership. No route was applied.\n"
    'Check that the OcuClaw host state directory is writable, then run setup again.'
)

NOT_READY_AFTER_APPLY_MESSAGE = (
    'The route answered, but its configuration no longer matches this installation.\n'
    'Route ownership was not recorded. Run hermes ocuclaw doctor to check the port.'
)

def waited_for(elapsed_s: float) -> str:
    """``30 seconds``, ``1 minute``, ``1 minute 30 seconds``, ``2 minutes``...

    Word for word the OpenClaw ladder's ``waitedFor``.
    """
    total = max(0, int(elapsed_s))
    minutes, seconds = divmod(total, 60)
    parts = []
    if minutes > 0:
        parts.append(f"{minutes} {'minute' if minutes == 1 else 'minutes'}")
    if seconds > 0 or minutes == 0:
        parts.append(f"{seconds} seconds")
    return " ".join(parts)


def certificate_progress_message(elapsed_s: float) -> str:
    """Said about every 30 seconds while the certificate wait goes on.

    Word for word the OpenClaw ladder's ``certificateProgressMessage``.
    """
    return f"Still waiting for the certificate ({waited_for(elapsed_s)} so far)."


def route_progress_message(elapsed_s: float) -> str:
    """The same cadence, for a published route that is not failing on TLS."""
    return f"Still waiting for the route to answer ({waited_for(elapsed_s)} so far)."


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
            "  Anything but yes leaves this route unchanged.",
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
    issue_fn: Optional[Callable[..., Any]] = None,
    record_fn: Optional[Callable[..., str]] = None,
) -> Any:
    """Publish the private route on a decisive Cloudways host, after consent.

    The seams are resolved here rather than bound as defaults so a test can
    substitute the network probe on the module and still drive the whole step
    through ``run_setup``, the way a user drives it.

    ``issue_fn(ctx, dns_name, budget_s)`` starts one ``tailscale cert`` call
    and returns its handle (see :class:`_ProcessIssuance`).
    """
    setup = _setup()
    probe = probe_fn or _default_probe
    observe = observe_fn or _default_observe
    issue = issue_fn or _default_issue
    record = record_fn or doctor.record_route_ownership

    def record_for(status: str, detail: str, exit_code: Optional[int] = None) -> Any:
        return setup.StepRecord("private-route", status, detail, exit_code=exit_code)

    # The trigger, checked here and not inferred from ladder order. Step 1 sets
    # this flag only after a decisive Cloudways verdict, and it is the whole
    # reason this seam is allowed to exist; a caller that reorders or trims the
    # ladder gets a refusal, not an apply.
    if not _decisive_cloudways(ctx):
        _say_block(ctx, NOT_DECISIVE_MESSAGE)
        return record_for(
            setup.STATUS_REFUSED, DETAIL_NOT_DECISIVE, setup.SETUP_EXIT_STOPPED
        )

    port = relay_port()
    observation = observe(ctx, port)
    classification = getattr(observation, "classification", serve.CLASSIFY_UNKNOWN)

    if classification == serve.CLASSIFY_UNKNOWN:
        # Never read is never "absent": applying over a route we could not see
        # is exactly the replacement this lane refuses to make.
        _say_block(ctx, UNREADABLE_ROUTE_MESSAGE)
        return record_for(
            setup.STATUS_FAILED, DETAIL_UNREADABLE, setup.SETUP_EXIT_PROBLEM
        )

    if classification == serve.CLASSIFY_WRONG:
        _say_block(ctx, FOREIGN_ROUTE_MESSAGE)
        return record_for(
            setup.STATUS_REFUSED, DETAIL_FOREIGN, setup.SETUP_EXIT_STOPPED
        )

    facts = _route_facts(ctx, observation, port)

    # Whatever comes next, it is not going to be a fight with a sibling install
    # over the one host-global port.
    if _claim_conflict(facts) is not None:
        _say_block(ctx, FOREIGN_OWNER_MESSAGE)
        return record_for(
            setup.STATUS_REFUSED, DETAIL_FOREIGN, setup.SETUP_EXIT_STOPPED
        )

    dns_name = getattr(observation, "dns_name", None)
    if not dns_name:
        _say_block(ctx, NO_TAILNET_NAME_MESSAGE)
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
            issue=issue,
        )

    # -- absent: the apply path ----------------------------------------------

    # #2672's precheck, before the consent rather than after it: a route this
    # tailnet cannot certify would apply cleanly, classify `ready`, and fail
    # every connection, so the question is never asked there.
    #
    # It only READS (#3648): `tailscale status --json`, whose CertDomains is
    # empty on a tailnet with HTTPS Certificates off. It never runs
    # `tailscale cert`, because an issued certificate puts this node's tailnet
    # name in the public Certificate Transparency logs, and a person who then
    # answers no must have published nothing. The ONE issuance call (#3593)
    # starts only after the yes and the apply, in the certificate wait.
    verdict = _cert_precheck(ctx, dns_name)
    if verdict == doctor.OUTCOME_CERT_UNAVAILABLE:
        _say_block(ctx, CERT_UNAVAILABLE_MESSAGE)
        return record_for(
            setup.STATUS_FAILED, DETAIL_CERT_UNAVAILABLE, setup.SETUP_EXIT_PROBLEM
        )
    if verdict == doctor.OUTCOME_CERT_UNKNOWN:
        # The status could not be read, or does not say (an older Tailscale).
        # Unknown withholds nothing and claims nothing, exactly as it does in
        # doctor; the certificate wait after the apply is the real gate
        # either way.
        _say_block(ctx, CERT_UNKNOWN_MESSAGE)
    return _consent_and_apply(
        ctx,
        setup,
        record_for=record_for,
        facts=facts,
        dns_name=dns_name,
        port=port,
        probe=probe,
        observe=observe,
        record=record,
        issue=issue,
    )


def _consent_and_apply(
    ctx: Any,
    setup: Any,
    *,
    record_for: Callable[..., Any],
    facts: Mapping[str, Any],
    dns_name: str,
    port: int,
    probe: Callable[[str, int, float], str],
    observe: Callable[..., Any],
    record: Callable[..., str],
    issue: Optional[Callable[..., Any]],
) -> Any:
    """The consent, the apply and the wait, once the precheck let it ask.

    Nothing before the typed yes runs anything but reads. The certificate is
    first asked for by the wait in :func:`_finish`, after the apply.
    """
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
        _say_block(ctx, TOOK_THE_PORT_MESSAGE)
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
        _say_block(
            ctx,
            FOREIGN_OWNER_MESSAGE
            if proposal in (doctor.RECORD_FOREIGN_OWNER, doctor.RECORD_UNREADABLE_CLAIM)
            else UNSETTLED_OWNERSHIP_MESSAGE,
        )
        return record_for(
            setup.STATUS_REFUSED, DETAIL_FOREIGN, setup.SETUP_EXIT_STOPPED
        )

    returncode, message = _apply(ctx, argv)
    if returncode != 0:
        if message:
            ctx.say(f"  {message}")
        _say_block(ctx, APPLY_FAILED_MESSAGE)
        return record_for(
            setup.STATUS_FAILED, DETAIL_APPLY_FAILED, setup.SETUP_EXIT_PROBLEM
        )
    ctx.say("  Private route configured.")
    # The cold-certificate window, said the way the OpenClaw ladder says it:
    # everything is in place and the one missing piece is the certificate
    # Tailscale issues for this node's name. A phone that dials before it
    # exists stalls on its first connection, so the ladder waits here.
    ctx.say(f"  {COLD_CERTIFICATE_MESSAGE}")

    # The wait starts the ONE `tailscale cert` call now, after the yes and
    # the apply (#3593, #3648), and stops it when the step ends.
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
        issue=issue,
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
    issue: Optional[Callable[..., Any]] = None,
) -> Any:
    """Wait for the route to answer, then record what was observed."""
    healthy, _last_outcome, waited_on_cert = _wait_for_route(
        ctx,
        dns_name=dns_name,
        probe=probe,
        issue=issue,
        announced=applied,
    )
    if healthy and waited_on_cert:
        # The handshake that ended the wait verified this node's certificate
        # against its own name, so this is observed, not assumed.
        ctx.say(f"  {CERTIFICATE_READY_MESSAGE}")
    if not healthy:
        # A bounded wait that ran out is a wait, not a broken route, and it
        # costs the user nothing: the next run picks up exactly here. No
        # observed receipt is written, because nothing was observed.
        _say_block(
            ctx, CERTIFICATE_TIMEOUT_MESSAGE if waited_on_cert else ROUTE_TIMEOUT_MESSAGE
        )
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
        _say_block(ctx, NOT_READY_AFTER_APPLY_MESSAGE)
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
        ctx.say("  The private route is published and answering.")
        return setup.StepRecord("private-route", setup.STATUS_DONE, DETAIL_PUBLISHED)
    ctx.say("  The private route is already published and answering.")
    return setup.StepRecord("private-route", setup.STATUS_SKIPPED, DETAIL_PRESENT)


def _wait_for_route(
    ctx: Any,
    *,
    dns_name: str,
    probe: Callable[[str, int, float], str],
    issue: Optional[Callable[..., Any]] = None,
    announced: bool = False,
) -> Tuple[bool, str, bool]:
    """Bounded wait on the front-door TLS handshake. Never the classifier.

    Returns whether the route answered, the last probe outcome, and whether
    this wait was about the certificate. ``announced`` says the caller already
    printed :data:`COLD_CERTIFICATE_MESSAGE` (right after an apply). A rerun on
    a route that is published but whose certificate is still being issued says
    it here, once, so the rerun reads as the same certificate wait it picks up.

    Read-only, and quiet between notices: one progress line about every
    :data:`ROUTE_NOTICE_S`, never one per poll.

    ``serve status`` answers whether the route is *configured*, which #1275
    proved says nothing about whether it works. The only thing allowed to end
    this wait is the route itself answering a TLS handshake on its own
    certificate.

    The certificate comes first (#3593). It is asked for with ONE
    ``tailscale cert`` call at a time, left to finish: ``issue`` starts the
    first one as the wait begins, which is always after the typed yes
    (#3648), and another only when none is running and the certificate is
    not issued yet, no sooner than :data:`CERT_RETRY_S` after the last start
    and at most :data:`CERT_MAX_CALLS` in all. ``issue`` is ``None`` when the
    certificate cannot be asked for. The route is not probed until the
    certificate is issued or cannot be asked for: a handshake on a route with
    no certificate makes Tailscale start a competing issuance with a short
    deadline of its own, and on a real box those left ACME orders ``invalid``.
    """
    port = serve.serve_port()
    started = ctx.clock()
    deadline = started + ROUTE_WAIT_S
    next_notice = started + ROUTE_NOTICE_S
    issuance: Optional[Any] = None
    issued = False
    calls = 0
    last_start: Optional[float] = None
    outcome = doctor.OUTCOME_FAILED
    try:
        while True:
            if issuance is not None:
                try:
                    finished = issuance.poll()
                except Exception:  # noqa: BLE001 - a failed call observed nothing
                    finished = doctor.OUTCOME_CERT_UNKNOWN
                if finished is not None:
                    issuance.close()
                    issuance = None
                    if finished == doctor.OUTCOME_CERT_AVAILABLE:
                        issued = True
                    elif finished == doctor.OUTCOME_CERT_UNAVAILABLE:
                        issue = None
            if (
                not issued
                and issue is not None
                and issuance is None
                and calls >= CERT_MAX_CALLS
            ):
                # Out of calls: the probe alone decides from here.
                issue = None
            if (
                not issued
                and issue is not None
                and issuance is None
                and (last_start is None or ctx.clock() - last_start >= CERT_RETRY_S)
            ):
                last_start = ctx.clock()
                calls += 1
                budget = min(CERT_ISSUE_BUDGET_S, max(CERT_GLANCE_S, deadline - last_start))
                finished, issuance = _begin_certificate(ctx, dns_name, issue, budget)
                if finished == doctor.OUTCOME_CERT_AVAILABLE:
                    issued = True
                elif finished in (doctor.OUTCOME_CERT_UNAVAILABLE, doctor.OUTCOME_CERT_UNKNOWN):
                    # Refused, or could not run: the probe alone decides.
                    issue = None
                if issuance is not None and not announced:
                    # Still being issued: this is the certificate wait, and
                    # it says so in the same words as the first run.
                    ctx.say(f"  {COLD_CERTIFICATE_MESSAGE}")
                    announced = True
            if issued or issue is None:
                try:
                    outcome = probe(dns_name, port, ROUTE_PROBE_TIMEOUT_S)
                except Exception:  # noqa: BLE001 - a failed probe observed nothing
                    outcome = doctor.OUTCOME_FAILED
                if outcome == doctor.OUTCOME_REACHABLE:
                    return True, outcome, announced
                if not announced and outcome == doctor.OUTCOME_TLS_HANDSHAKE_FAILED:
                    ctx.say(f"  {COLD_CERTIFICATE_MESSAGE}")
                    announced = True
            now = ctx.clock()
            if now >= deadline:
                return False, outcome, announced
            if now >= next_notice:
                periods = int((now - started) // ROUTE_NOTICE_S)
                elapsed = periods * ROUTE_NOTICE_S
                ctx.say(
                    f"  {certificate_progress_message(elapsed)}"
                    if announced
                    else f"  {route_progress_message(elapsed)}"
                )
                next_notice = started + (periods + 1) * ROUTE_NOTICE_S
            ctx.sleep(min(ROUTE_POLL_S, max(0.0, deadline - ctx.clock())))
    finally:
        if issuance is not None:
            issuance.close()


# -- the pieces ---------------------------------------------------------------


def _say_block(ctx: Any, message: str) -> None:
    """Say a message of one or more lines, every line under the step's indent."""
    for line in message.split("\n"):
        ctx.say(f"  {line}")


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


def _cert_precheck(ctx: Any, dns_name: str) -> str:
    """#2672's precheck, read-only: can this tailnet certify this node?

    One bounded ``tailscale status --json`` through the ladder's runner, read
    by :func:`doctor.tailnet_cert_domains_check`. It never runs
    ``tailscale cert`` (#3648), so it is safe before the consent.
    """
    return doctor.tailnet_cert_domains_check(
        dns_name, serve.READ_TIMEOUT_S, runner=ctx.runner
    )


def _begin_certificate(
    ctx: Any,
    dns_name: str,
    issue: Optional[Callable[..., Any]],
    budget_s: float,
) -> Tuple[str, Optional[Any]]:
    """Start one ``tailscale cert`` call and give it a short look.

    Only ever called from the certificate wait, after the typed yes (#3648).
    Returns doctor's verdict and ``None`` when the call answered within
    :data:`CERT_GLANCE_S`, or :data:`CERT_PENDING` and the still-running call,
    which the caller owns and must :meth:`close`. A call that could not start
    at all is :data:`doctor.OUTCOME_CERT_UNKNOWN`.
    """
    if issue is None:
        return doctor.OUTCOME_CERT_UNKNOWN, None
    try:
        issuance = issue(ctx, dns_name, budget_s)
    except Exception:  # noqa: BLE001 - a call that never started observed nothing
        return doctor.OUTCOME_CERT_UNKNOWN, None
    look_until = ctx.clock() + CERT_GLANCE_S
    while True:
        try:
            finished = issuance.poll()
        except Exception:  # noqa: BLE001 - a failed call observed nothing
            finished = doctor.OUTCOME_CERT_UNKNOWN
        if finished is not None:
            issuance.close()
            return finished, None
        if ctx.clock() >= look_until:
            return CERT_PENDING, issuance
        ctx.sleep(CERT_GLANCE_POLL_S)


def _default_issue(ctx: Any, dns_name: str, budget_s: float) -> Any:
    """Start the one ``tailscale cert`` call for this node.

    A real run starts the CLI in the background. An exercise that injected a
    process runner gets that runner, called once with the whole budget.
    """
    if ctx.runner is not None:
        return _RunnerIssuance(ctx, dns_name, budget_s)
    return _ProcessIssuance(dns_name, budget_s, ctx.clock)


class _ProcessIssuance:
    """ONE ``tailscale cert`` for this node, left running until it answers.

    Never killed round by round (#3593): stopping the CLI cancels the issuance
    Tailscale started for it, and on a tailnet whose ``set-dns`` call is slow
    that cancelled every attempt. It writes into a private temporary
    directory, because Tailscale 1.102.x refuses the null device, and
    :meth:`close` deletes that directory with the key in it. The CLI's own
    output goes to a file there too, so nothing ever waits on a full pipe.

    :meth:`poll` is ``None`` while the call runs, then one of doctor's three
    certificate outcomes, or :data:`CERT_PENDING` when the call ran out of
    ``budget_s`` or was stopped.
    """

    def __init__(self, dns_name: str, budget_s: float, clock: Callable[[], float]):
        self._clock = clock
        self._deadline = clock() + max(0.0, float(budget_s))
        self._outcome: Optional[str] = None
        self._proc: Optional[subprocess.Popen] = None
        self._output: Any = None
        self._dir: Optional[str] = doctor.private_cert_dir()
        try:
            argv = doctor.cert_command(dns_name, self._dir)
            if shutil.which(argv[0]) is None:
                raise FileNotFoundError(argv[0])
            self._output = open(
                os.path.join(self._dir, "output.txt"), "w+", encoding="utf-8"
            )
            self._proc = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=self._output,
                stderr=subprocess.STDOUT,
            )
        except BaseException:
            self.close()
            raise

    def poll(self) -> Optional[str]:
        if self._outcome is not None:
            return self._outcome
        if self._proc is None:
            self._outcome = CERT_PENDING
            return self._outcome
        returncode = self._proc.poll()
        if returncode is None:
            if self._clock() < self._deadline:
                return None
            self._outcome = CERT_PENDING
        else:
            self._outcome = doctor.cert_outcome(returncode, self._read_output())
        self.close()
        return self._outcome

    def _read_output(self) -> str:
        try:
            self._output.flush()
            self._output.seek(0)
            return str(self._output.read(4096))
        except Exception:  # noqa: BLE001 - unreadable output reads as unknown
            return ""

    def close(self) -> None:
        """Stop the call if it is still running and delete its files. Idempotent."""
        proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        output, self._output = self._output, None
        if output is not None:
            try:
                output.close()
            except OSError:
                pass
        cert_dir, self._dir = self._dir, None
        doctor.remove_cert_dir(cert_dir)


class _RunnerIssuance:
    """The same call through an injected process runner, answered at once.

    The runner is given the whole budget as its timeout. A runner that runs
    out of time is a certificate still being issued (:data:`CERT_PENDING`).
    """

    def __init__(self, ctx: Any, dns_name: str, budget_s: float):
        timed_out: list = []
        verdict = doctor.tailnet_tls_cert_check(
            dns_name, budget_s, runner=_cert_runner(ctx, timed_out)
        )
        if verdict == doctor.OUTCOME_CERT_UNKNOWN and timed_out:
            verdict = CERT_PENDING
        self._outcome = verdict

    def poll(self) -> Optional[str]:
        return self._outcome

    def close(self) -> None:
        return None


def _cert_runner(
    ctx: Any, timed_out: list
) -> Callable[[Sequence[str], float], Optional[Tuple[int, str]]]:
    """Adapt ``ctx.runner`` (or a plain subprocess) to doctor's cert check.

    Notes a timeout in ``timed_out``; every other failure observed nothing.
    """

    def run(args: Sequence[str], timeout_s: float) -> Optional[Tuple[int, str]]:
        try:
            if ctx.runner is None:
                if shutil.which(args[0]) is None:
                    return None
                completed = subprocess.run(
                    list(args),
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    check=False,
                )
            else:
                completed = ctx.runner(
                    list(args),
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    check=False,
                )
        except subprocess.TimeoutExpired:
            timed_out.append(True)
            return None
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
    "certificate_progress_message",
    "consent_lines",
    "relay_port",
    "run_private_route",
    "serve_apply_argv",
]
