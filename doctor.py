"""The bounded active-check lane behind `hermes ocuclaw doctor` (#1318).

`status` is passive by contract: it reads local facts and cached receipts and
never touches the network (#1273 §10). `doctor` is the one surface allowed to
observe actively, and the contract draws that permission narrowly:

* it may classify the current Serve configuration, attempt a bounded
  TLS/WebSocket connection through the *configured* tailnet route, and
  authenticate through the approved transient relay-verifier site;
* it must close before sending a protocol hello;
* it never registers a client, changes phone counts, completes pairing,
  receives product data, retries, or mutates configuration;
* the whole probe is capped at five seconds, and only result codes and
  timestamps survive.

This module is the harness that enforces the bounded half of that contract —
a per-check timeout, a hard total budget, checks that run at most once, and
failures that resolve to ``unknown`` rather than to a negative claim about the
user's route — plus the one check the contract sanctions.

The lane has two independent checks. :func:`tailnet_front_door_check` proves
only that the configured TLS front door answers. The credentialed relay
verifier then performs the approved transient WebSocket authentication
handshake and closes without a protocol hello. Only that stronger result can
set ``serveApplicationReady``. Inferring it from the front door remains the
explicitly disproved #1275 path.

A third check runs on the other side of that fork. :func:`plan_cert_precheck`
fires only on a run with no route to probe and a Serve command about to be
proposed, and asks whether this tailnet can issue the TLS certificate that
command needs at all (#2672).
"""

from __future__ import annotations

import errno
import os
import queue
import shutil
import socket
import ssl
import subprocess
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, NamedTuple, Optional, Tuple

from .relay_verifier import RelayVerifyOutcome, verify_relay_credential
from .serve import phone_address, serve_port
from .snapshot import (
    OBSERVATION_ACTIVE,
    SERVE_CLASSIFICATIONS,
    TRISTATE_NO,
    TRISTATE_UNKNOWN,
    TRISTATE_YES,
)

#: The whole probe lane is capped at five seconds (#1273 §10). This is a
#: budget across all checks, not a per-check allowance.
PROBE_TOTAL_BUDGET_S = 5.0

#: No single check may sit on the budget alone.
PROBE_DEFAULT_TIMEOUT_S = 2.0

#: The checks the contract sanctions, named so their evidence is stable.
CHECK_TAILNET_REACHABILITY = "tailnet-reachability"
CHECK_RELAY_APPLICATION = "credentialed-relay-verifier"
#: The HTTPS-certificate precondition, checked only on a run that is about to
#: propose the Serve command (#2672).
CHECK_TAILNET_TLS_CERT = "tailnet-tls-cert"

RELAY_TOKEN_ENV = "OCUCLAW_RELAY_TOKEN"

# -- outcome vocabulary -------------------------------------------------------
#
# Stable, allowlisted result codes. A presenter renders these; it never invents
# health semantics from one it does not recognise (#1273 §5).

OUTCOME_REACHABLE = "reachable_yes"
OUTCOME_UNREACHABLE = "reachable_no"
OUTCOME_TIMEOUT = "probe_timeout"
OUTCOME_FAILED = "probe_failed"
OUTCOME_BUDGET_EXHAUSTED = "probe_budget_exhausted"
OUTCOME_NO_CLASSIFIED_ROUTE = "probe_skipped_no_classified_route"
OUTCOME_LANE_FAILED = "probe_lane_failed"
OUTCOME_RELAY_ACCEPTED = "relay_credential_accepted"
OUTCOME_RELAY_REJECTED = "relay_credential_rejected"
OUTCOME_RELAY_UNREACHABLE = "relay_verifier_unreachable"
OUTCOME_RELAY_TIMEOUT = "relay_verifier_timeout"
OUTCOME_RELAY_PROTOCOL_ERROR = "relay_verifier_protocol_error"
OUTCOME_RELAY_UNKNOWN = "relay_verifier_unknown"
OUTCOME_RELAY_NO_CREDENTIAL = "relay_verifier_skipped_no_credential"
#: A TLS alert, told apart from the other ways a handshake can fail to
#: complete. Something answered and refused the conversation at the TLS layer,
#: which is a fact worth a finding. A tailnet without HTTPS certificates
#: enabled produces exactly this on a route the classifier calls ready (#2672).
OUTCOME_TLS_HANDSHAKE_FAILED = "probe_tls_handshake_failed"
OUTCOME_CERT_AVAILABLE = "tls_cert_available"
OUTCOME_CERT_UNAVAILABLE = "tls_cert_unavailable"
OUTCOME_CERT_UNKNOWN = "tls_cert_unknown"

PROBE_OUTCOME_CODES = (
    OUTCOME_REACHABLE,
    OUTCOME_UNREACHABLE,
    OUTCOME_TIMEOUT,
    OUTCOME_FAILED,
    OUTCOME_TLS_HANDSHAKE_FAILED,
    OUTCOME_CERT_AVAILABLE,
    OUTCOME_CERT_UNAVAILABLE,
    OUTCOME_CERT_UNKNOWN,
    OUTCOME_BUDGET_EXHAUSTED,
    OUTCOME_NO_CLASSIFIED_ROUTE,
    OUTCOME_LANE_FAILED,
    OUTCOME_RELAY_ACCEPTED,
    OUTCOME_RELAY_REJECTED,
    OUTCOME_RELAY_UNREACHABLE,
    OUTCOME_RELAY_TIMEOUT,
    OUTCOME_RELAY_PROTOCOL_ERROR,
    OUTCOME_RELAY_UNKNOWN,
    OUTCOME_RELAY_NO_CREDENTIAL,
)

#: The only outcome that establishes a *negative* claim about the route: a
#: check that ran, inside its window, and got a definite refusal.
#:
#: Everything else — including a timeout — leaves the leg unknown. A timeout
#: is not evidence about the route; it is the absence of evidence, and this
#: harness can itself cause one by clamping a check's allowance down to the
#: budget that is left. Reading our own scheduling pressure as "your tailnet
#: route is broken" would send a user to fix a route that was never at fault.
_NEGATIVE_OUTCOMES = frozenset({OUTCOME_UNREACHABLE})

_RELAY_VERIFY_OUTCOMES = {
    "accepted": OUTCOME_RELAY_ACCEPTED,
    "rejected": OUTCOME_RELAY_REJECTED,
    "unreachable": OUTCOME_RELAY_UNREACHABLE,
    "timeout": OUTCOME_RELAY_TIMEOUT,
    "protocol_error": OUTCOME_RELAY_PROTOCOL_ERROR,
    "unknown": OUTCOME_RELAY_UNKNOWN,
}


class ProbeCheck(NamedTuple):
    """One bounded, non-mutating observation.

    ``run`` receives the seconds it is allowed to take and returns one of
    :data:`PROBE_OUTCOME_CODES`. It must honour that deadline itself (a socket
    timeout is the intended mechanism); the harness additionally refuses to
    start it at all once the total budget is gone.
    """

    name: str
    timeout_s: float
    run: Callable[[float], str]


class ProbeOutcome(NamedTuple):
    """What a check observed. Only a code and a duration survive (#1273 §10)."""

    name: str
    result_code: str
    elapsed_s: float


class ProbePlan(NamedTuple):
    """The checks doctor will run, plus outcomes decided without running one."""

    checks: List[ProbeCheck]
    skipped: List[ProbeOutcome]


#: Errnos where the network itself answered "no". Anything outside this set is
#: a local condition, and resolves to "observed nothing" rather than to a
#: negative claim about the user's route.
_NETWORK_REFUSAL_ERRNOS = frozenset(
    code
    for code in (
        getattr(errno, name, None)
        for name in ("ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
                     "EHOSTDOWN", "ENETDOWN", "ECONNABORTED")
    )
    if code is not None
)


def tailnet_front_door_check(host: str, port: int, timeout_s: float) -> str:
    """One bounded TLS handshake through the configured Serve route.

    This is the sanctioned check, and its shape is chosen as much for what it
    does *not* do as for what it does.

    **Why TLS and not a bare TCP connect.** #1275 probed eight already-
    configured routes: seven accepted a TLS connection, one TLS-terminated TCP
    route reset, and one HTTPS route answered and returned 502. A generic TCP
    connect is explicitly insufficient — it would have called the resetting
    route healthy. Completing a TLS handshake against the route's own
    certificate is protocol-specific evidence that *this node's* Serve front
    door is live, because the certificate is verified against the node's
    tailnet name.

    **Why it stops there.** The contract says the probe must close before
    sending a protocol hello, and never register a client or change phone
    counts. This check sends **zero application bytes**: it completes the
    handshake and closes. It therefore cannot be the thing that perturbs the
    presence counts another leg of the same snapshot is reporting on.

    That bounds what it can prove. A completed handshake establishes
    ``serveReachable``; it does not establish ``serveApplicationReady``, which
    needs the relay's own handshake through the approved transient
    relay-verifier site and the configured credential. That leg stays
    unknown here, deliberately, rather than being inferred from a front door
    that answered.
    """
    # The advertised bound is enforced twice over, because a socket timeout
    # alone does not deliver it.
    #
    # 1. **One deadline across phases.** Handing the same allowance to connect
    #    and then again to the TLS handshake would let a slow-but-working
    #    route take roughly twice what the harness budgeted, and the harness
    #    would then score the answer as a timeout it caused itself.
    # 2. **A wall-clock cap the socket cannot evade.** `getaddrinfo` honours
    #    no socket timeout at all, and `create_connection` spends its timeout
    #    *per resolved address*, so a stalled resolver or a handful of
    #    black-holed addresses could outlast the whole five-second doctor
    #    budget — the one failure mode this lane must not have, since it
    #    would hang the very command a user runs when their tailnet is
    #    broken. The blocking work therefore runs on a daemon worker and is
    #    abandoned at the deadline. A worker left behind cannot hold the
    #    process open, and it writes nothing.
    #
    # A plain daemon thread rather than a pool: a pool's shutdown joins its
    # workers, so a worker wedged in the resolver would block the very exit
    # this cap exists to guarantee. A daemon thread cannot.
    answer: "queue.Queue[str]" = queue.Queue(maxsize=1)

    def worker() -> None:
        try:
            answer.put(_front_door_handshake(host, port, timeout_s))
        except BaseException:  # noqa: BLE001 - the caller has already moved on
            answer.put(OUTCOME_FAILED)

    thread = threading.Thread(
        target=worker, name="ocuclaw-serve-probe", daemon=True
    )
    thread.start()
    try:
        return answer.get(timeout=timeout_s)
    except queue.Empty:
        return OUTCOME_TIMEOUT


def _front_door_handshake(host: str, port: int, timeout_s: float) -> str:
    """The blocking half of :func:`tailnet_front_door_check`."""
    deadline = time.monotonic() + timeout_s
    context = ssl.create_default_context()
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return OUTCOME_TIMEOUT
        with socket.create_connection((host, port), timeout=remaining) as raw:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return OUTCOME_TIMEOUT
            raw.settimeout(remaining)
            with context.wrap_socket(raw, server_hostname=host):
                # Handshake complete and the certificate verified for this
                # node. Close without writing a single byte.
                return OUTCOME_REACHABLE
    except socket.timeout:
        return OUTCOME_TIMEOUT
    except ConnectionRefusedError:
        # A definite refusal from the far side: the one negative claim this
        # check is allowed to make.
        return OUTCOME_UNREACHABLE
    except ConnectionResetError:
        # A reset is the failure #1275 actually observed on a configured
        # TLS-terminated TCP route, and it is as definite as a refusal.
        return OUTCOME_UNREACHABLE
    except ssl.SSLError:
        # Something answered but the TLS conversation did not complete. That
        # is still not evidence the route is down, so it makes no negative
        # claim about reachability, but it is not "observed nothing" either,
        # and reporting it as such is what left #2672 with no finding to act
        # on. It gets its own code so the deriver can say the front door
        # refused at the TLS layer, which on a ready route is very nearly
        # always this tailnet's missing HTTPS certificates.
        return OUTCOME_TLS_HANDSHAKE_FAILED
    except socket.gaierror:
        # The node name did not resolve. Tailscale DNS being unavailable is a
        # local condition, not a verdict on the route.
        return OUTCOME_FAILED
    except OSError as exc:
        # Only errors that are genuinely the network answering "no" become a
        # negative claim. Everything else — a local file-descriptor limit, a
        # permission error, an interrupted call — is this host's problem, and
        # reading it as "your tailnet route is broken" would send a user to
        # fix a route that was never at fault.
        if exc.errno in _NETWORK_REFUSAL_ERRNOS:
            return OUTCOME_UNREACHABLE
        return OUTCOME_FAILED


#: The exact refusals Tailscale returns when a tailnet cannot issue TLS certs.
#: Matched as substrings of the CLI's own message and nothing wider: any other
#: non-zero exit is a condition this build has not verified, and claiming
#: "your tailnet has HTTPS off" over it would send a user to an admin console
#: that was never the problem.
_CERT_UNAVAILABLE_SIGNATURES = (
    "does not support getting tls certs",
    "https must be enabled in the admin panel",
    "https is not enabled",
)


def _run_cert_command(args: List[str], timeout_s: float) -> Optional[Tuple[int, str]]:
    """Run one bounded certificate probe. ``None`` means "observed nothing"."""
    if shutil.which(args[0]) is None:
        return None
    try:
        completed = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return None
    return (
        int(getattr(completed, "returncode", 1)),
        f"{getattr(completed, 'stderr', '') or ''}\n"
        f"{getattr(completed, 'stdout', '') or ''}",
    )


def tailnet_tls_cert_check(
    dns_name: str,
    timeout_s: float,
    *,
    runner: Optional[Callable[[List[str], float], Optional[Tuple[int, str]]]] = None,
) -> str:
    """Can this tailnet issue a TLS certificate for this node's own name?

    `tailscale serve --tls-terminated-tcp` needs one, and a tailnet with
    HTTPS Certificates turned off in the admin console silently cannot supply
    it: the route applies, `serve status` classifies it ``ready``, and every
    connection through it then dies in a TLS alert. That is #2672, and the
    whole cost of finding it out is this one bounded call.

    The certificate is written to the null device rather than to stdout. A
    private key must never enter a captured buffer, and this check wants only
    the exit status.

    Three outcomes, and the third is the important one. Only Tailscale's own
    "this tailnet cannot issue certs" refusal produces
    :data:`OUTCOME_CERT_UNAVAILABLE`; a missing binary, a timeout, or any
    other failure resolves to :data:`OUTCOME_CERT_UNKNOWN`, which withholds
    nothing and claims nothing.
    """
    runner = _run_cert_command if runner is None else runner
    null_device = os.devnull
    try:
        answer = runner(
            [
                "tailscale",
                "cert",
                "--cert-file",
                null_device,
                "--key-file",
                null_device,
                dns_name,
            ],
            timeout_s,
        )
    except Exception:  # noqa: BLE001 - a substituted runner may raise anything
        return OUTCOME_CERT_UNKNOWN
    if answer is None:
        return OUTCOME_CERT_UNKNOWN
    returncode, message = answer
    if returncode == 0:
        return OUTCOME_CERT_AVAILABLE
    lowered = str(message or "").lower()
    if any(signature in lowered for signature in _CERT_UNAVAILABLE_SIGNATURES):
        return OUTCOME_CERT_UNAVAILABLE
    return OUTCOME_CERT_UNKNOWN


def plan_cert_precheck(facts: Mapping[str, Any]) -> Optional[ProbeCheck]:
    """The certificate precondition, planned only where it changes the output.

    Deliberately not part of :func:`plan_probes`. That function decides which
    checks may be aimed at a *route*, and its answer for anything the
    classifier did not recognise is "none", a contract this check would
    muddy, because it aims at the tailnet's certificate authority rather than
    at the route.

    It runs exactly where a wrong answer costs the user an afternoon: on the
    run that is about to print `tailscale serve --tls-terminated-tcp`, which
    is a run whose route is ``absent`` or ``wrong`` and whose route probes
    were therefore all skipped. Nothing is planned on a ``ready`` route, where
    the front-door check already reports a TLS refusal directly.
    """
    if facts.get("serveClassification") not in {"absent", "wrong"}:
        return None
    dns_name = facts.get("serveNodeDnsName")
    if not isinstance(dns_name, str) or not dns_name:
        return None
    return ProbeCheck(
        name=CHECK_TAILNET_TLS_CERT,
        timeout_s=PROBE_DEFAULT_TIMEOUT_S,
        run=lambda allowance: tailnet_tls_cert_check(dns_name, allowance),
    )


def _read_relay_credential() -> str:
    """Read the Relay Credential without putting it in facts or diagnostics."""
    try:
        from hermes_cli.config import get_env_value  # type: ignore

        value = get_env_value(RELAY_TOKEN_ENV)
        if isinstance(value, str) and value.strip():
            return value.strip()
    except Exception:  # noqa: BLE001 - supervised env is the supported fallback
        pass
    return str(os.environ.get(RELAY_TOKEN_ENV, "") or "").strip()


def credentialed_relay_check(
    address: str,
    timeout_s: float,
    *,
    credential_reader: Optional[Callable[[], str]] = None,
    verifier: Optional[Callable[..., RelayVerifyOutcome]] = None,
    clock: Callable[[], float] = time.monotonic,
) -> str:
    """Run Q12's verifier once and collapse it to a secret-free result code."""
    credential_reader = (
        _read_relay_credential if credential_reader is None else credential_reader
    )
    verifier = verify_relay_credential if verifier is None else verifier
    started = clock()
    try:
        allowance = float(timeout_s)
    except (TypeError, ValueError):
        allowance = 0.0
    if allowance <= 0:
        return OUTCOME_RELAY_TIMEOUT
    deadline = started + allowance

    # Managed-store lookup is not guaranteed to honour a timeout. Isolate only
    # that credential-free operation so a stalled reader cannot hang doctor.
    # The parent remains the sole verifier caller: once its deadline expires,
    # a late reader can neither construct nor transmit an authenticated target.
    answer: "queue.Queue[Tuple[bool, Any]]" = queue.Queue(maxsize=1)
    cancelled = threading.Event()

    def read_credential() -> None:
        try:
            item = (True, credential_reader())
        except Exception:  # noqa: BLE001 - store failure has a fixed safe outcome
            item = (False, None)
        if not cancelled.is_set():
            try:
                answer.put_nowait(item)
            except queue.Full:
                pass

    threading.Thread(
        target=read_credential,
        name="ocuclaw-relay-credential-reader",
        daemon=True,
    ).start()
    remaining = deadline - clock()
    if remaining <= 0:
        cancelled.set()
        return OUTCOME_RELAY_TIMEOUT
    try:
        read_ok, credential = answer.get(timeout=remaining)
    except queue.Empty:
        cancelled.set()
        return OUTCOME_RELAY_TIMEOUT
    if not read_ok:
        return OUTCOME_RELAY_NO_CREDENTIAL
    if not isinstance(credential, str) or not credential:
        return OUTCOME_RELAY_NO_CREDENTIAL
    remaining = deadline - clock()
    if remaining <= 0:
        return OUTCOME_RELAY_TIMEOUT
    try:
        result = verifier(
            address=address,
            credential=credential,
            timeout_s=remaining,
        )
    except Exception:  # noqa: BLE001 - no exception text crosses this boundary
        return OUTCOME_RELAY_UNKNOWN
    return _RELAY_VERIFY_OUTCOMES.get(result.outcome, OUTCOME_RELAY_UNKNOWN)


def plan_probes(facts: Mapping[str, Any]) -> ProbePlan:
    """Decide which sanctioned checks this host can actually run right now.

    A reachability probe needs a recognised route to aim at. `serve status`
    classification is authoritative for configuration shape only (#1273 §3),
    so a route is probed only once the classifier has positively recognised
    it as OcuClaw's and the collector has a node identity to aim the check at
    (#1319). Anything less is skipped with a code that says exactly that,
    rather than being reported as a failed probe — which would read as a
    broken route.
    """
    classification = facts.get("serveClassification")
    if classification not in SERVE_CLASSIFICATIONS:
        classification = TRISTATE_UNKNOWN
    host = facts.get("serveNodeDnsName")
    # The tailnet-side port comes from the one shared accessor, never from a
    # second literal: the port the classifier recognised the route on and the
    # port this check aims at must be the same number by construction.
    port = serve_port()
    address = phone_address(dns_name=host, port=port)
    if (
        classification != "ready"
        or not isinstance(host, str)
        or not host
        or not address
    ):
        return ProbePlan(
            checks=[],
            skipped=[
                ProbeOutcome(
                    CHECK_TAILNET_REACHABILITY, OUTCOME_NO_CLASSIFIED_ROUTE, 0.0
                ),
                ProbeOutcome(CHECK_RELAY_APPLICATION, OUTCOME_NO_CLASSIFIED_ROUTE, 0.0),
            ],
        )
    checks = [
        ProbeCheck(
            name=CHECK_TAILNET_REACHABILITY,
            timeout_s=PROBE_DEFAULT_TIMEOUT_S,
            run=lambda allowance: tailnet_front_door_check(
                host, int(port), allowance
            ),
        )
    ]
    skipped: List[ProbeOutcome] = []
    secrets = facts.get("secretsPresent")
    relay_token_present = (
        isinstance(secrets, Mapping) and secrets.get("relayToken") is True
    )
    if relay_token_present:
        checks.append(
            ProbeCheck(
                name=CHECK_RELAY_APPLICATION,
                timeout_s=PROBE_DEFAULT_TIMEOUT_S,
                run=lambda allowance: credentialed_relay_check(address, allowance),
            )
        )
    else:
        skipped.append(
            ProbeOutcome(
                CHECK_RELAY_APPLICATION,
                OUTCOME_RELAY_NO_CREDENTIAL,
                0.0,
            )
        )
    return ProbePlan(
        checks=checks,
        skipped=skipped,
    )


def run_probes(
    checks: List[ProbeCheck],
    *,
    budget_s: float = PROBE_TOTAL_BUDGET_S,
    clock: Callable[[], float] = time.monotonic,
) -> List[ProbeOutcome]:
    """Run each check at most once, inside a hard total budget.

    Four rules, all of them load-bearing:

    1. **At most once.** There is no retry path in this function, because the
       contract forbids one.
    2. **Bounded per check.** A check is handed the smaller of its own timeout
       and the budget that is left, so a slow first check cannot spend a later
       check's allowance.
    3. **Bounded in total.** Once the budget is gone, remaining checks are not
       started; they are recorded as budget-exhausted.
    4. **Failure is not a negative claim.** An exception or an overrun becomes
       ``probe_failed``/``probe_timeout``, which
       :func:`apply_probe_outcomes` maps to unknown, never to "your route is
       broken".
    """
    outcomes: List[ProbeOutcome] = []
    started = clock()
    for check in checks:
        elapsed_total = clock() - started
        remaining = budget_s - elapsed_total
        if remaining <= 0:
            outcomes.append(ProbeOutcome(check.name, OUTCOME_BUDGET_EXHAUSTED, 0.0))
            continue
        allowance = min(float(check.timeout_s), remaining)
        check_started = clock()
        try:
            code = check.run(allowance)
        except TimeoutError:
            code = OUTCOME_TIMEOUT
        except Exception:  # noqa: BLE001 - a probe that blew up observed nothing
            code = OUTCOME_FAILED
        check_elapsed = clock() - check_started
        if code not in PROBE_OUTCOME_CODES:
            # A check may only speak the allowlisted vocabulary. An unknown
            # code is reported as a failed observation rather than forwarded
            # under its own name (#1273 §5).
            code = OUTCOME_FAILED
        elif check_elapsed > allowance:
            # It answered, but outside the window it was given. The answer
            # describes a moment we no longer bounded, so it does not count.
            code = OUTCOME_TIMEOUT
        outcomes.append(ProbeOutcome(check.name, code, check_elapsed))
    return outcomes


def _clear_probe_facts(facts: Mapping[str, Any]) -> Dict[str, Any]:
    """Start a doctor run from "this run has observed nothing yet".

    Doctor's whole promise is that it reports what it observed *now*. Carrying
    a previous run's probe answers into this one — and then re-stamping them
    with this run's timestamp, which is what ``serveProbedAt`` does — would let
    doctor present someone else's observation as its own current evidence, and
    exit 0 on the strength of it. So every doctor run begins by dropping the
    probe-fed facts and re-earns them.

    Only the probe-fed facts are cleared. Serve *configuration* shape is
    observed during collection, carries its own stamp, and is not this lane's
    to invalidate (#1273 §4).
    """
    updated = dict(facts)
    updated["observationMode"] = OBSERVATION_ACTIVE
    updated["serveReachable"] = TRISTATE_UNKNOWN
    updated["serveApplicationReady"] = TRISTATE_UNKNOWN
    updated["serveProbedAt"] = None
    updated["serveTlsCertAvailable"] = TRISTATE_UNKNOWN
    updated["serveFrontDoorTlsError"] = False
    return updated


def lane_failed(facts: Mapping[str, Any]) -> Tuple[Dict[str, Any], List[ProbeOutcome]]:
    """The active lane could not run at all.

    An internal failure is not a clean bill of health. The run is still an
    active observation — it says so — but it observed nothing, so it inherits
    no cached probe evidence and doctor cannot pass on the strength of one.
    """
    return (
        _clear_probe_facts(facts),
        [ProbeOutcome(CHECK_TAILNET_REACHABILITY, OUTCOME_LANE_FAILED, 0.0)],
    )


def apply_probe_outcomes(
    facts: Mapping[str, Any],
    outcomes: List[ProbeOutcome],
    *,
    probed_at: Optional[str],
) -> Dict[str, Any]:
    """Fold probe outcomes back into the frozen facts dict.

    Returns a new dict; the input is not mutated. ``observationMode`` becomes
    ``active`` because doctor ran — even when every check was skipped, the
    snapshot should say which lane produced it.

    ``serveProbedAt`` is stamped only when a check actually observed
    something. Stamping it otherwise would open a 60-second freshness window
    over evidence that does not exist, and the deriver would then read "we
    never looked" as "we looked recently" (#1273 §4).
    """
    updated = _clear_probe_facts(facts)

    reachability = next(
        (o for o in outcomes if o.name == CHECK_TAILNET_REACHABILITY), None
    )
    application = next(
        (o for o in outcomes if o.name == CHECK_RELAY_APPLICATION), None
    )
    certificate = next(
        (o for o in outcomes if o.name == CHECK_TAILNET_TLS_CERT), None
    )
    observed = False

    if reachability is not None:
        if reachability.result_code == OUTCOME_REACHABLE:
            updated["serveReachable"] = TRISTATE_YES
            observed = True
        elif reachability.result_code in _NEGATIVE_OUTCOMES:
            updated["serveReachable"] = TRISTATE_NO
            observed = True
        elif reachability.result_code == OUTCOME_TLS_HANDSHAKE_FAILED:
            # Reachability stays unknown: a TLS alert says the far side
            # answered, not that the route is down. What it does establish is
            # that the front door refuses TLS, which the deriver turns into a
            # finding instead of silence.
            updated["serveFrontDoorTlsError"] = True
            observed = True

    if certificate is not None:
        if certificate.result_code == OUTCOME_CERT_AVAILABLE:
            updated["serveTlsCertAvailable"] = TRISTATE_YES
            observed = True
        elif certificate.result_code == OUTCOME_CERT_UNAVAILABLE:
            updated["serveTlsCertAvailable"] = TRISTATE_NO
            observed = True

    if application is not None:
        if application.result_code == OUTCOME_RELAY_ACCEPTED:
            # An authenticated WebSocket handshake is stronger than the TLS
            # front-door check: it proves both that the route is reachable and
            # that the OcuClaw relay behind it accepted this host's credential.
            updated["serveReachable"] = TRISTATE_YES
            updated["serveApplicationReady"] = TRISTATE_YES
            observed = True
        elif application.result_code == OUTCOME_RELAY_REJECTED:
            # The relay's 4001 response proves traffic reached an application
            # speaking the expected authentication behavior, but a rejected
            # credential cannot prove which deployment state is correct. Keep
            # readiness unknown and let the fixed diagnosis explain the result.
            updated["serveReachable"] = TRISTATE_YES
            observed = True

    if observed:
        updated["serveProbedAt"] = probed_at
    return updated


#: Why a doctor run did or did not record route ownership. Stable tokens; a
#: presenter renders these and never invents wording for one it does not know.
RECORD_WRITTEN = "route_receipt_written"
RECORD_PROPOSED = "route_proposal_recorded"
RECORD_FOREIGN_OWNER = "route_receipt_owned_by_another_gateway"
RECORD_UNREADABLE_CLAIM = "route_receipt_present_but_unreadable"
RECORD_NOT_OWNED = "route_receipt_not_written_route_not_ready"
RECORD_INCOMPLETE = "route_receipt_not_written_route_not_fully_identified"
RECORD_UNAVAILABLE = "route_receipt_unavailable"

RECORD_CODES = (
    RECORD_WRITTEN,
    RECORD_PROPOSED,
    RECORD_FOREIGN_OWNER,
    RECORD_UNREADABLE_CLAIM,
    RECORD_NOT_OWNED,
    RECORD_INCOMPLETE,
    RECORD_UNAVAILABLE,
)


def reserve_route_ownership(facts: Mapping[str, Any], *, state_dir: Any = None) -> bool:
    """Reserve this machine's Serve route for this gateway install, atomically.

    Ownership has to be settled *before* the apply command is rendered, not
    after. Two installs that both find no receipt would otherwise both print a
    command — each naming its own relay port — and the user could run the one
    belonging to the install that went on to lose the claim, repointing the
    shared port away from the winner. The output is the safety decision, so
    the decision has to be made before the output.

    The reservation records ownership and nothing else: no observed target, no
    proposal. It says "this install holds the port", which is what the command
    about to be printed depends on. Proposal evidence is finalised afterwards
    by :func:`record_route_ownership`, and only if the command was really
    shown — the two-phase order that keeps both rules true at once.

    Returns whether this install may act on the route. Never raises.
    """
    from . import receipts as receipts_mod
    from .serve import apply_command, serve_port, teardown_command

    mine = facts.get("hermesHomeFingerprint")
    if not mine:
        # Without an identity this install cannot own anything, and must not
        # displace somebody who can.
        return False
    try:
        with receipts_mod.route_receipt_lock(state_dir=state_dir) as locked:
            if not locked:
                return False
            existing, status = receipts_mod.read_managed_serve_route(
                state_dir=state_dir
            )
            known = (
                existing if status == "ok" and isinstance(existing, Mapping) else {}
            )
            if _ownership_conflict(status, known, mine) is not None:
                return False
            if status == "ok":
                return True

            relay_port = facts.get("serveRelayPort")
            body = receipts_mod.build_managed_serve_route_body(
                servePort=serve_port(),
                relay_port=None,
                node_identity_fingerprint=receipts_mod.fingerprint_node_identity(
                    facts.get("serveNodeDnsName")
                ),
                configured_profiles=(
                    [facts["profileName"]] if facts.get("profileName") else []
                ),
                owning_gateway_fingerprint=mine,
                proposed_command=(
                    apply_command(relay_port=int(relay_port))
                    if isinstance(relay_port, int)
                    else None
                ),
                teardown_command=teardown_command(),
            )
            receipts_mod.write_managed_serve_route(
                body, state_dir=state_dir, claim=True
            )
            return True
    except receipts_mod.ReceiptAlreadyClaimedError:
        # A sibling won the race between our read and our write.
        return False
    except Exception:  # noqa: BLE001 - a reservation failure withholds, never grants
        return False


def record_route_ownership(
    facts: Mapping[str, Any],
    *,
    configured_profiles: Any = (),
    state_dir: Any = None,
) -> str:
    """Write the Managed Serve Route receipt for a route doctor just saw live.

    This is the "observed" half of proposed-then-observed (#1269): the CLI
    proposes by printing the exact command, the user runs it, and the next
    bounded doctor run is what turns that into a recorded ownership claim.

    It writes only for a route the classifier called ``ready`` — that is, one
    whose port, protocol, TLS identity, and loopback target were all
    positively verified. A route we could not fully identify never becomes a
    route we claim to own, because the receipt's only job downstream is to
    justify offering to remove it.

    Never raises: an unwritable receipt degrades the teardown offer, and must
    not take the diagnostic down with it.
    """
    from . import receipts as receipts_mod
    from .serve import apply_command, serve_port, teardown_command

    classification = facts.get("serveClassification")
    relay_port = facts.get("serveRelayPort")

    if classification in ("absent", "wrong"):
        # The *proposed* half. This run is the one where the CLI prints the
        # apply command, so it is the moment a proposal exists on this host.
        # Recording it is what later lets a matching route be called one
        # OcuClaw proposed rather than one it merely recognised — the
        # difference between offering to remove our own route and offering to
        # remove a route the user had before OcuClaw arrived.
        if relay_port is None or not facts.get("hermesHomeFingerprint"):
            return RECORD_INCOMPLETE
        try:
            with receipts_mod.route_receipt_lock(state_dir=state_dir) as locked:
                if not locked:
                    return RECORD_UNAVAILABLE
                return _record_proposal(
                    facts, relay_port=int(relay_port), state_dir=state_dir
                )
        except Exception:  # noqa: BLE001 - a receipt failure is not an outage
            return RECORD_UNAVAILABLE

    if classification != "ready":
        return RECORD_NOT_OWNED

    fingerprint = receipts_mod.fingerprint_node_identity(facts.get("serveNodeDnsName"))
    if relay_port is None or fingerprint is None:
        return RECORD_INCOMPLETE
    if not facts.get("hermesHomeFingerprint"):
        # An ownerless receipt would be unusable by us and undisplaceable by
        # anyone else, so it is never written.
        return RECORD_INCOMPLETE

    try:
        with receipts_mod.route_receipt_lock(state_dir=state_dir) as locked:
            if not locked:
                # Unserialized, a concurrent writer could lose this update or
                # have its own lost by ours. Not recording is recoverable;
                # losing established evidence is not.
                return RECORD_UNAVAILABLE
            return _record_observation(
                facts,
                relay_port=int(relay_port),
                fingerprint=fingerprint,
                configured_profiles=configured_profiles,
                state_dir=state_dir,
            )
    except Exception:  # noqa: BLE001 - a receipt failure is not an outage
        return RECORD_UNAVAILABLE


def _record_observation(
    facts: Mapping[str, Any],
    *,
    relay_port: int,
    fingerprint: Optional[str],
    configured_profiles: Any,
    state_dir: Any,
) -> str:
    """The observed half, run inside the host receipt lock."""
    from . import receipts as receipts_mod
    from .serve import apply_command, serve_port, teardown_command

    try:
        existing, status = receipts_mod.read_managed_serve_route(state_dir=state_dir)
        known = existing if status == "ok" and isinstance(existing, Mapping) else {}
        conflict = _ownership_conflict(
            status, known, facts.get("hermesHomeFingerprint")
        )
        if conflict is not None:
            return conflict
        if status != "ok":
            # No claim exists, and observing a matching route is not a way to
            # acquire one: a shape match proves the node, port, and loopback
            # target agree, never which install proposed the route. Recording
            # ownership here would let a doctor run for a stopped sibling —
            # whose configured relay port happens to match — take the live
            # owner's route and turn the real owner into a foreigner.
            #
            # A pre-existing route with no claim therefore stays unowned, and
            # `observed-shape-match` already denies it teardown. Adopting such
            # routes would need an explicit adoption protocol, not a
            # first-to-look rule.
            return RECORD_NOT_OWNED
        # Observation history belongs to a route, not to a file. If the relay
        # port or the host identity has moved, the route in front of us is a
        # different one and was first observed now — inheriting the old
        # timestamp would date this route to a predecessor it has nothing to
        # do with.
        same_route = (
            known.get("servePort") == int(serve_port())
            and known.get("observedTarget") == f"127.0.0.1:{int(relay_port)}"
            and known.get("nodeIdentityFingerprint") == fingerprint
        )
        first_observed = known.get("firstObservedAt") if same_route else None

        # The route is host-global but this process can only see the profile
        # it resolved. So each profile's doctor run adds itself to the set
        # rather than replacing it — which is what makes "another profile
        # still uses this route" decidable at uninstall time (#1268). A
        # profile that is gone is never pruned here; removing one is that
        # journey's decision, not a side effect of a diagnostic.
        profiles = set(configured_profiles or ())
        recorded = known.get("configuredProfiles")
        if isinstance(recorded, list):
            profiles.update(str(name) for name in recorded if name)
        profile_name = facts.get("profileName")
        if isinstance(profile_name, str) and profile_name:
            profiles.add(profile_name)

        body = receipts_mod.build_managed_serve_route_body(
            servePort=serve_port(),
            relay_port=int(relay_port),
            node_identity_fingerprint=fingerprint,
            configured_profiles=profiles,
            owning_gateway_fingerprint=facts.get("hermesHomeFingerprint"),
            proposed_command=apply_command(relay_port=int(relay_port)),
            teardown_command=teardown_command(),
            first_observed_at=first_observed if isinstance(first_observed, str) else None,
            # Carried forward, never minted here: this run observed a route,
            # it did not propose one. A receipt with no proposal recorded
            # stays at the weaker basis however many times it is re-observed.
            #
            # And carried forward only onto the *same* route. A proposal is
            # evidence about one exact command on one exact node; if the relay
            # port or the host identity has moved since, the route in front of
            # us is a different one, and inheriting the old timestamp would
            # promote it to "we proposed this" and open the teardown gate on
            # a route nobody proposed.
            proposed_at=_carried_proposal(
                known,
                expected_command=apply_command(relay_port=int(relay_port)),
                expected_port=serve_port(),
                expected_fingerprint=fingerprint,
                expected_owner=facts.get("hermesHomeFingerprint"),
            ),
        )
        _publish(receipts_mod, body, state_dir=state_dir, first_claim=(status == "missing"))
    except receipts_mod.ReceiptAlreadyClaimedError:
        # Another gateway created the receipt between our read and our write.
        # The kernel picked them; we are not the owner.
        return RECORD_FOREIGN_OWNER
    except Exception:  # noqa: BLE001 - a receipt failure is not an outage
        return RECORD_UNAVAILABLE
    return RECORD_WRITTEN


def _publish(
    receipts_mod: Any, body: Mapping[str, Any], *, state_dir: Any, first_claim: bool
) -> None:
    """Write the host receipt, taking a first claim exclusively.

    The ownership check above is a read followed by a write, and nothing in
    between stops a sibling gateway doing the same. Where there was no receipt
    to begin with, the write is therefore an exclusive create: two installs
    that both saw "missing" cannot both succeed, and the loser is told so
    rather than silently replacing the winner's claim.
    """
    if not first_claim:
        # Re-read immediately before writing and fold in anything already
        # established, so an interleaved run of this same install cannot have
        # its proposal or first observation erased by ours.
        current, status = receipts_mod.read_managed_serve_route(state_dir=state_dir)
        body = receipts_mod.merge_managed_serve_route(
            current if status == "ok" else None, body
        )
    receipts_mod.write_managed_serve_route(
        body, state_dir=state_dir, claim=first_claim
    )


def _ownership_conflict(
    status: str, known: Mapping[str, Any], mine: Optional[str]
) -> Optional[str]:
    """Why this gateway may not write the host receipt, or ``None`` if it may.

    The host receipt is shared by every gateway install on the machine, which
    is the point of host-scoping it — and also the thing that makes writing it
    dangerous. Two installs can easily observe the *same* route as `ready`,
    because the relay port they each expect defaults to the same number. If
    the second one simply rewrote the receipt in its own name, it would
    acquire proposal evidence it never earned and be offered a command to
    remove the first install's route.

    So a receipt that is present and belongs to somebody else is never
    overwritten, and one that is present but cannot be interpreted is never
    overwritten either — an unreadable claim is still a claim, and guessing it
    is unowned is the assumption that costs another install its route.
    """
    if status == "missing":
        return None
    if status != "ok":
        return RECORD_UNREADABLE_CLAIM
    owner = known.get("owningGatewayFingerprint")
    if not owner:
        # A receipt naming no owner is not an invitation. Treating it as free
        # would let any install adopt it and then overwrite it with its own
        # fingerprint, which is the first-owner guard defeating itself. This
        # build never writes one; an existing one is somebody else's business.
        return RECORD_UNREADABLE_CLAIM
    if not mine or owner != mine:
        return RECORD_FOREIGN_OWNER
    return None


def _carried_proposal(
    known: Mapping[str, Any],
    *,
    expected_command: str,
    expected_port: int,
    expected_fingerprint: Optional[str],
    expected_owner: Optional[str] = None,
) -> Optional[str]:
    """A stored proposal timestamp, but only if it was for *this* route.

    Proposal evidence is about one exact command on one exact node. Anything
    that has moved since — the relay port inside the command, the serve port,
    the host's identity — makes the stored proposal evidence about a different
    route, and it does not transfer.
    """
    proposed_at = known.get("proposedAt")
    if not isinstance(proposed_at, str) or not proposed_at:
        return None
    if known.get("proposedCommand") != expected_command:
        return None
    if known.get("servePort") != int(expected_port):
        return None
    if expected_fingerprint is None:
        return None
    if known.get("nodeIdentityFingerprint") != expected_fingerprint:
        return None
    if known.get("owningGatewayFingerprint") != expected_owner:
        # Proposal evidence belongs to the install that made the proposal. It
        # never transfers to another gateway, whatever else still matches.
        return None
    return proposed_at


def _record_proposal(
    facts: Mapping[str, Any], *, relay_port: int, state_dir: Any = None
) -> str:
    """Record that OcuClaw proposed a route on this host, right now.

    Written when the classifier reports `absent` or `wrong` — the runs where
    the CLI prints the apply command. It records the proposal, never an
    observation: `observedTarget` stays empty, so this receipt on its own can
    never satisfy the teardown gate.
    """
    from . import receipts as receipts_mod
    from .serve import apply_command, serve_port, teardown_command

    existing, status = receipts_mod.read_managed_serve_route(state_dir=state_dir)
    known = existing if status == "ok" and isinstance(existing, Mapping) else {}
    conflict = _ownership_conflict(status, known, facts.get("hermesHomeFingerprint"))
    if conflict is not None:
        return conflict
    fingerprint = receipts_mod.fingerprint_node_identity(
        facts.get("serveNodeDnsName")
    )
    expected_command = apply_command(relay_port=relay_port)
    # Keep the original moment when this is the same proposal being repeated,
    # and start a new one when the command or the host identity has changed —
    # the old proposal was about a route this is not.
    previous = _carried_proposal(
        known,
        expected_command=expected_command,
        expected_port=serve_port(),
        expected_fingerprint=fingerprint,
        expected_owner=facts.get("hermesHomeFingerprint"),
    )

    profiles = set()
    recorded = known.get("configuredProfiles")
    if isinstance(recorded, list):
        profiles.update(str(name) for name in recorded if name)
    profile_name = facts.get("profileName")
    if isinstance(profile_name, str) and profile_name:
        profiles.add(profile_name)

    body = receipts_mod.build_managed_serve_route_body(
        servePort=serve_port(),
        # No route was observed, so there is no observed target to record —
        # and, because of that, no first-observation stamp either.
        relay_port=None,
        node_identity_fingerprint=fingerprint,
        configured_profiles=profiles,
        owning_gateway_fingerprint=facts.get("hermesHomeFingerprint"),
        proposed_command=expected_command,
        teardown_command=teardown_command(),
        first_observed_at=None,
        proposed_at=previous or receipts_mod.now_iso(),
    )
    try:
        _publish(
            receipts_mod, body, state_dir=state_dir, first_claim=(status == "missing")
        )
    except receipts_mod.ReceiptAlreadyClaimedError:
        return RECORD_FOREIGN_OWNER
    return RECORD_PROPOSED


def observe(
    facts: Mapping[str, Any],
    *,
    probed_at: Optional[str],
    budget_s: float = PROBE_TOTAL_BUDGET_S,
    planner: Callable[[Mapping[str, Any]], ProbePlan] = plan_probes,
    cert_planner: Callable[
        [Mapping[str, Any]], Optional[ProbeCheck]
    ] = plan_cert_precheck,
    clock: Callable[[], float] = time.monotonic,
) -> Tuple[Dict[str, Any], List[ProbeOutcome]]:
    """Plan, run, and fold in one bounded active observation.

    The whole of doctor's active lane, as one function a test can drive with
    a fixture planner.

    The certificate precheck shares the same five-second budget as the route
    probes rather than getting an allowance of its own, and it goes last: the
    two planners are mutually exclusive in practice, so in the run that plans
    it the whole budget is still there.
    """
    plan = planner(facts)
    precheck = cert_planner(facts)
    outcomes = list(plan.skipped)
    if precheck is None:
        outcomes.extend(run_probes(plan.checks, budget_s=budget_s, clock=clock))
    else:
        started = clock()
        outcomes.extend(run_probes(plan.checks, budget_s=budget_s, clock=clock))
        remaining = budget_s - (clock() - started)
        outcomes.extend(
            run_probes([precheck], budget_s=max(remaining, 0.0), clock=clock)
        )
    return apply_probe_outcomes(facts, outcomes, probed_at=probed_at), outcomes
