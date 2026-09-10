"""The plugin-owned ``hermes ocuclaw`` command surface.

The first local surface a beta user can point at a host to ask "what is
actually wrong". Both commands render the same Connection Health Snapshot v1
document — the one produced by ``snapshot.derive_snapshot`` — so a presenter
here can never disagree with the Setup Assistant, the recovery dashboard, or
the support attachment about what the host looks like.

Two commands, one contract, one difference (#1273 §10):

``status``
    **Passive.** Local facts and cached receipts only. It never opens a
    socket, never mutates anything, and always exits ``0`` when it produced a
    valid snapshot — including when everything it found is broken. Rendering a
    diagnosis is not the same as passing one, and an exit code that flips on
    observation would make the command unusable in a shell pipeline that just
    wants the truth printed.

``doctor``
    **Bounded active.** It may additionally run the sanctioned checks in
    :mod:`doctor` — each with a timeout, all inside one five-second budget,
    none of them mutating — and exits non-zero when the host is not both
    configured and healthy on all four legs.

Three rules shape every line of copy below:

1. **The three truths stay visually separate.** Hermes Setup State, Current
   Connection Health, and Hermes First-Run Proof are independent (#1273 §1),
   so they are three headed blocks and never one summary line. "configured,
   currently unhealthy at the phone leg, previously proven on G2" has to be
   readable as the single truthful sentence it is.
2. **``unknown`` is never dressed as a negative claim.** A missing receipt is
   "no fresh evidence", never "no phone connected". This is the same rule the
   deriver enforces structurally; here it is enforced in the wording, because
   the wording is what the user actually acts on.
3. **Freshness is rendered per source.** There is no global snapshot TTL
   (#1273 §4), so every evidence line prints the rule that governs *that*
   source next to the age it actually has.

Testability: the presenters are pure functions of a snapshot document, and
:func:`run` takes the fact collector as an argument, so the whole surface is
driven from fixture facts through the same derive seam every other presenter
uses (test seam 1). Nothing in this module observes the host directly.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, TextIO

from . import doctor as doctor_lane
from .snapshot import (
    EVIDENCE_APP_PRESENCE,
    EVIDENCE_FIRST_RUN_PROOF,
    EVIDENCE_GATEWAY_RECEIPT,
    EVIDENCE_HERMES_SOURCE_CERTIFIED,
    EVIDENCE_HERMES_SOURCE_OBSERVED,
    EVIDENCE_HERMES_SOURCE_SHALLOW,
    EVIDENCE_HERMES_SOURCE_STATE,
    EVIDENCE_IN_PROCESS_LINK,
    EVIDENCE_TAILNET_PROBE,
    EVIDENCE_TAILNET_SERVE,
    HEALTH_HEALTHY,
    HEALTH_UNHEALTHY,
    HEALTH_UNKNOWN,
    LEG_HERMES_GATEWAY,
    LEG_OCUCLAW_RELAY,
    LEG_PHONE_APP,
    LEG_TAILNET_ROUTE,
    PROOF_NOT_PROVEN,
    PROOF_PROVEN,
    SNAPSHOT_CONTRACT,
    SNAPSHOT_CONTRACT_VERSION,
    TRISTATE_UNKNOWN,
    derive_snapshot,
    error_envelope,
    now_iso,
    parse_timestamp,
)

COMMAND_NAME = "ocuclaw"
COMMAND_HELP = "Inspect, pair, reset, or fully uninstall OcuClaw"
COMMAND_DESCRIPTION = (
    "Inspect or set up OcuClaw for this Hermes profile.\n"
    "\n"
    "  status   passive: local facts and cached receipts only; always exits 0\n"
    "  doctor   bounded active checks; exits non-zero on problems or bad state\n"
    "  pair     pair a phone, approving it at this terminal; needs a real TTY\n"
    "  reset-relay-credential  locally confirm an all-device credential reset\n"
    "  uninstall  remove OcuClaw while preserving shared Hermes sessions\n"
)

# -- exit codes (#1273 §10) ---------------------------------------------------

#: A valid snapshot was produced, and (for doctor) the host is configured and
#: healthy on all four legs.
EXIT_OK = 0
#: doctor only: a valid snapshot was produced and it reports a problem or a
#: setup state other than `configured`. status never returns this.
EXIT_PROBLEM = 1
#: Invalid invocation, an unresolved or unsafe target profile, an unsupported
#: contract version, or a snapshot that could not be generated at all. Both
#: commands can return this, and no snapshot is rendered when they do.
EXIT_USAGE = 2

# -- machine-error codes ------------------------------------------------------

ERROR_PROFILE_UNRESOLVED = "profile_unresolved"
ERROR_COLLECTION_FAILED = "collection_failed"
ERROR_SNAPSHOT_FAILED = "snapshot_failed"
ERROR_UNSUPPORTED_CONTRACT = "unsupported_contract_version"
ERROR_UNKNOWN_SUBCOMMAND = "unknown_subcommand"

_ERROR_MESSAGES = {
    ERROR_PROFILE_UNRESOLVED: (
        "The exact Hermes profile could not be resolved safely, so no "
        "profile-scoped snapshot was generated."
    ),
    ERROR_COLLECTION_FAILED: (
        "OcuClaw connection health facts could not be collected safely."
    ),
    ERROR_SNAPSHOT_FAILED: (
        "The Connection Health Snapshot could not be generated from the "
        "collected facts."
    ),
    ERROR_UNSUPPORTED_CONTRACT: (
        "This build does not understand the generated snapshot's contract "
        "version, so it refuses to interpret it partially."
    ),
    ERROR_UNKNOWN_SUBCOMMAND: (
        "Unknown subcommand. Use `status` for a passive report or `doctor` "
        "for bounded active checks."
    ),
}

#: Why this install may or may not act on the host's Serve route.
#:
#: `CLAIM_UNCLAIMED` is the one that is easy to collapse into `CLAIM_OWNED`
#: and must not be: no receipt means this install may *claim* the route, not
#: that it owns one already there. Since observing a matching route
#: deliberately does not acquire ownership, a `ready` route with no receipt is
#: genuinely ambiguous — two installs sharing the default relay port would
#: both see it as theirs — so it permits proposing and withholds the address.
#:
#: And "somebody else owns this" is kept apart from "we could not write our
#: own state", because telling the second user to delete an ownership receipt
#: that may not exist is worse than saying nothing.
CLAIM_OWNED = "route_claim_owned"
CLAIM_UNCLAIMED = "route_claim_unclaimed"
CLAIM_FOREIGN = "route_claim_foreign_owner"
CLAIM_UNAVAILABLE = "route_claim_unavailable"


# -- stable repair copy (#1273 §5) --------------------------------------------
#
# The deriver emits a stable repair *code*; the wording lives with the
# presenter. These strings are a contract in their own right — a user follows
# them and support quotes them — so they change with a deliberate edit here,
# never as a side effect of touching the deriver.
#
# Nothing derived from a fact value is interpolated into any of them. That is
# what keeps the rendered output secret-free by construction rather than by a
# redaction pass someone can forget to run.

REPAIR_TEXT: Dict[str, str] = {
    "read_hermes_config": (
        "Check that this profile's Hermes configuration exists and is readable, "
        "then run this command again."
    ),
    "enable_ocuclaw_platform": (
        "Enable the OcuClaw platform for this profile, then restart the Hermes "
        "gateway."
    ),
    "restore_loopback_relay_bind": (
        "Set the OcuClaw relay bind address back to 127.0.0.1, then restart the "
        "Hermes gateway. The relay is reached over the tailnet route, never by "
        "binding it to a public interface."
    ),
    "set_valid_relay_port": (
        "Set the OcuClaw relay port to a number between 1 and 65535, then "
        "restart the Hermes gateway."
    ),
    "configure_even_ai_secret": (
        "Configure the Even AI secret, or turn Even AI off, then restart the "
        "Hermes gateway."
    ),
    "configure_continue_here": (
        "Run: hermes config set platforms.ocuclaw.extra.allow_admin_from "
        "'[\"ocuclaw-wearer\"]' — then restart the Hermes gateway. This lets the "
        "glasses continue a Desktop, CLI or TUI chat (it turns slash-command "
        "gating on for the OcuClaw platform; the wearer id is its only admin)."
    ),
    "install_node": (
        "Install Node.js on this host, or point the OcuClaw runtime command at "
        "an existing Node.js, then restart the Hermes gateway."
    ),
    "reinstall_ocuclaw_bundle": (
        "Reinstall the OcuClaw plugin bundle for this profile, then restart the "
        "Hermes gateway."
    ),
    "run_setup_assistant": (
        "Run /ocuclaw-setup for Relay Credential recovery. The host-managed "
        "credential is never entered or printed; an established profile with "
        "a missing credential stops instead of silently replacing it."
    ),
    "install_supported_hermes": (
        "Install a Hermes release inside OcuClaw's supported range, then "
        "restart the Hermes gateway."
    ),
    "name_target_profile": (
        "Name the target Hermes profile explicitly. OcuClaw never falls back to "
        "the default profile when the requested one cannot be resolved."
    ),
    "start_hermes_gateway": (
        "Start the Hermes gateway for this profile, then run this command again."
    ),
    "restart_hermes_gateway": (
        "Restart the Hermes gateway for this profile, then run this command "
        "again."
    ),
    "apply_serve_route": (
        "Apply the OcuClaw Tailscale Serve route for this host, then run "
        "`hermes ocuclaw doctor` again."
    ),
    "check_tailscale_route": (
        "Check that Tailscale is running and this host is reachable on the "
        "tailnet, then run `hermes ocuclaw doctor` again."
    ),
    "enable_tailnet_https_certs": (
        "Turn on MagicDNS and HTTPS Certificates for this tailnet in the "
        "Tailscale admin console, under DNS, then run "
        "`hermes ocuclaw doctor` again. OcuClaw's route terminates TLS with "
        "this node's own certificate, and a tailnet that cannot issue one "
        "accepts the route and then fails every connection through it."
    ),
    "pair_phone_app": (
        "Pair the OcuClaw phone app with this host from the Setup Assistant."
    ),
}

#: Rendered for a repair code this build does not know. New codes may be added
#: inside contract v1 (#1273 §12), so a presenter must degrade to something
#: generic instead of dropping the repair or inventing wording for it.
REPAIR_TEXT_UNKNOWN = (
    "This build has no printed instructions for that repair. Quote the repair "
    "code above when you ask for help."
)

# -- source-specific freshness rules (#1273 §4) -------------------------------
#
# There is no global snapshot TTL, so an age alone is meaningless: 90 seconds
# is stale for the app-presence receipt, fresh for a doctor probe, and
# irrelevant for a gateway transition whose process is still live. Each
# evidence line therefore prints the rule that governs its own source.

_FRESHNESS_RULES: Dict[str, str] = {
    EVIDENCE_IN_PROCESS_LINK: "live in-process link, re-checked on every snapshot",
    EVIDENCE_GATEWAY_RECEIPT: (
        "no expiry while this profile's gateway process stays live"
    ),
    EVIDENCE_APP_PRESENCE: "written every 30s, expires after 120s",
    EVIDENCE_TAILNET_SERVE: "observed during collection, carries no expiry",
    EVIDENCE_TAILNET_PROBE: "bounded active probe, expires after 60s",
    EVIDENCE_FIRST_RUN_PROOF: "never expires",
    EVIDENCE_HERMES_SOURCE_STATE: "cached for at most 5m; source changes invalidate it",
    EVIDENCE_HERMES_SOURCE_CERTIFIED: "certified release identity; changes only on recertification",
    EVIDENCE_HERMES_SOURCE_OBSERVED: "cached for at most 5m; source changes invalidate it",
    EVIDENCE_HERMES_SOURCE_SHALLOW: "cached for at most 5m; shallow is always unknown provenance",
}
_FRESHNESS_RULE_UNKNOWN = "freshness rule not known to this build"

_LEG_LABELS = (
    (LEG_HERMES_GATEWAY, "Hermes gateway"),
    (LEG_OCUCLAW_RELAY, "OcuClaw relay"),
    (LEG_TAILNET_ROUTE, "Tailnet route"),
    (LEG_PHONE_APP, "Phone app"),
)

_SETUP_STATE_GLOSS = {
    "configured": "every durable prerequisite is satisfied",
    "incomplete": "a required item is absent or disabled",
    "invalid": "a configured value is malformed or unsafe",
    "unavailable": "a required runtime dependency cannot run",
    "unsupported": "this Hermes host is outside the supported contract",
    "unknown": "this profile's configuration could not be read or resolved safely",
}

_PROBE_OUTCOME_GLOSS = {
    doctor_lane.OUTCOME_REACHABLE: "the configured route answered",
    doctor_lane.OUTCOME_UNREACHABLE: "the configured route did not answer",
    doctor_lane.OUTCOME_TIMEOUT: "the check ran out of its allotted time",
    doctor_lane.OUTCOME_FAILED: "the check could not complete, so it observed nothing",
    doctor_lane.OUTCOME_TLS_HANDSHAKE_FAILED: (
        "the route answered but refused the TLS handshake, which is what a "
        "tailnet without HTTPS Certificates does"
    ),
    doctor_lane.OUTCOME_CERT_AVAILABLE: (
        "this tailnet can issue the TLS certificate the Serve route needs"
    ),
    doctor_lane.OUTCOME_CERT_UNAVAILABLE: (
        "this tailnet cannot issue a TLS certificate for this node, so the "
        "Serve route would accept and then fail"
    ),
    doctor_lane.OUTCOME_CERT_UNKNOWN: (
        "the certificate precondition could not be determined, so nothing is "
        "claimed about it"
    ),
    doctor_lane.OUTCOME_BUDGET_EXHAUSTED: (
        "the five-second probe budget was gone before this check could start"
    ),
    doctor_lane.OUTCOME_NO_CLASSIFIED_ROUTE: (
        "no Tailscale Serve route has been classified for this host, so there "
        "is nothing to probe"
    ),
    doctor_lane.OUTCOME_LANE_FAILED: (
        "the bounded check lane could not run, so this run observed nothing "
        "about the route"
    ),
    doctor_lane.OUTCOME_RELAY_ACCEPTED: (
        "the application behind the route accepted the configured credential"
    ),
    doctor_lane.OUTCOME_RELAY_REJECTED: (
        "credential rejected by the application behind the route"
    ),
    doctor_lane.OUTCOME_RELAY_UNREACHABLE: (
        "the authenticated application check could not reach the route"
    ),
    doctor_lane.OUTCOME_RELAY_TIMEOUT: (
        "the authenticated application check ran out of its allotted time"
    ),
    doctor_lane.OUTCOME_RELAY_PROTOCOL_ERROR: (
        "the route did not answer with the expected OcuClaw relay handshake"
    ),
    doctor_lane.OUTCOME_RELAY_UNKNOWN: (
        "the authenticated application check could not determine an outcome"
    ),
    doctor_lane.OUTCOME_RELAY_NO_CREDENTIAL: (
        "the Relay Credential is not available from the managed configuration store"
    ),
}

_SAFE_TOKEN_RE = re.compile(r"[^A-Za-z0-9._+\-]")
# A timestamp legitimately carries colons; a separate, still-bounded allowlist
# keeps "2026-08-16T12:00:00+00:00" readable without widening the charset that
# profile and producer identity strings pass through.
_SAFE_TIMESTAMP_RE = re.compile(r"[^A-Za-z0-9:._+\-]")
_TOKEN_MAX = 64


def _safe(value: Any, *, fallback: str = "unknown") -> str:
    """Render an identifier through the same bounded allowlist the deriver uses.

    The snapshot is already secret-free by construction, so this is belt and
    braces rather than the barrier — but a presenter that prints straight from
    a dict is one collector bug away from printing whatever landed in it.
    """
    if value is None:
        return fallback
    text = _SAFE_TOKEN_RE.sub("", str(value))[:_TOKEN_MAX]
    return text or fallback


def _safe_ts(value: Any, *, fallback: str = "unknown") -> str:
    """Render an ISO-8601 instant through a bounded allowlist that keeps colons."""
    if value is None:
        return fallback
    text = _SAFE_TIMESTAMP_RE.sub("", str(value))[:_TOKEN_MAX]
    return text or fallback


def _yes_no(value: Any, *, unknown: str = "unknown") -> str:
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return unknown


def _age_text(observed_at: Any, generated_at: Any) -> str:
    """Age of one observation relative to the snapshot's own generation time.

    Deliberately measured against ``generatedAt`` rather than the wall clock:
    ``generatedAt`` never substitutes for a source's ``observedAt`` (#1273 §4),
    but it is the instant the whole document describes, and using it keeps the
    rendered age deterministic under test.
    """
    observed = parse_timestamp(observed_at)
    generated = parse_timestamp(generated_at)
    if observed is None:
        return "not observed"
    if generated is None:
        return f"observed {_safe_ts(observed_at)}"
    delta = (generated - observed).total_seconds()
    if delta < 0:
        return f"observed {_safe_ts(observed_at)} (ahead of this snapshot)"
    if delta < 90:
        return f"observed {int(delta)}s ago"
    if delta < 5400:
        return f"observed {int(delta // 60)}m ago"
    if delta < 172800:
        return f"observed {int(delta // 3600)}h ago"
    return f"observed {int(delta // 86400)}d ago"


# -- leg wording --------------------------------------------------------------
#
# Each of these answers "what does this state mean, here, without claiming
# more than the evidence supports".


def _gateway_detail(leg: Mapping[str, Any]) -> str:
    state = leg.get("state")
    observed_from = leg.get("observedFrom")
    if state == HEALTH_HEALTHY:
        if observed_from == "in-process":
            return "the OcuClaw adapter link is live in this gateway process"
        return "this profile's gateway is live and its OcuClaw adapter is connected"
    if state == HEALTH_UNHEALTHY:
        return (
            "this profile's gateway is stopped, or a live gateway reports the "
            "OcuClaw adapter disconnected"
        )
    if observed_from is None:
        return (
            "unknown from this process: no gateway evidence for this profile "
            "could be read here. This is not a claim that the gateway is down"
        )
    return (
        "gateway evidence is transitional or could not be attributed to this "
        "profile safely"
    )


def _relay_detail(leg: Mapping[str, Any], gateway_state: str) -> str:
    state = leg.get("state")
    if state == HEALTH_HEALTHY:
        return "the Node relay is listening"
    if state == HEALTH_UNHEALTHY:
        return "fresh evidence reports the Node relay is not listening"
    if gateway_state != HEALTH_HEALTHY:
        return (
            f"relay health is only readable through a healthy gateway, and the "
            f"gateway leg is {_safe(gateway_state)}"
        )
    return (
        "the OcuClaw app-presence receipt is missing, stale, or rejected, so "
        "the relay's current state is unobserved"
    )


def _tailnet_detail(leg: Mapping[str, Any]) -> str:
    state = leg.get("state")
    if state == HEALTH_HEALTHY:
        return "configured, reachable, and answering as the OcuClaw application"
    if state == HEALTH_UNHEALTHY:
        if leg.get("classification") == "absent" or leg.get("configured") == "no":
            return "no OcuClaw Tailscale Serve route is configured for this host"
        if leg.get("classification") == "wrong":
            return "the configured Serve route does not match OcuClaw's"
        return "the configured route did not answer a bounded probe"
    return (
        "nothing has classified this host's Serve route, so its configuration "
        "and reachability are unobserved. This is not a claim that the route "
        "is missing"
    )


def _phone_detail(leg: Mapping[str, Any]) -> str:
    state = leg.get("state")
    count = leg.get("authenticatedAppCount")
    if state == HEALTH_HEALTHY:
        noun = "client" if count == 1 else "clients"
        return f"{count} authenticated phone-app {noun} connected"
    if state == HEALTH_UNHEALTHY:
        return (
            "fresh evidence reports zero authenticated phone-app clients while "
            "the gateway and relay are healthy"
        )
    return (
        "no fresh phone-app evidence is available, so this leg is unobserved. "
        "This is not a claim that no phone is connected"
    )


def _leg_extra(name: str, leg: Mapping[str, Any]) -> List[str]:
    """The leg's own preserved detail fields, which never collapse into state."""
    if name == LEG_OCUCLAW_RELAY:
        return [f"listening: {_yes_no(leg.get('listening'))}"]
    if name == LEG_TAILNET_ROUTE:
        return [
            f"classification: {_safe(leg.get('classification'), fallback=TRISTATE_UNKNOWN)}",
            f"configured: {_safe(leg.get('configured'), fallback=TRISTATE_UNKNOWN)}",
            f"reachable: {_safe(leg.get('reachable'), fallback=TRISTATE_UNKNOWN)}",
            "application ready: "
            f"{_safe(leg.get('applicationReady'), fallback=TRISTATE_UNKNOWN)}",
        ]
    if name == LEG_PHONE_APP:
        count = leg.get("authenticatedAppCount")
        versions = leg.get("clientVersions") or []
        rows = [
            "authenticated app clients: "
            + ("unknown" if count is None else str(count))
        ]
        if versions:
            rows.append(
                "client versions: " + ", ".join(_safe(v) for v in versions)
            )
        if leg.get("lastTransitionAt"):
            rows.append(f"last transition: {_safe_ts(leg.get('lastTransitionAt'))}")
        return rows
    if name == LEG_HERMES_GATEWAY:
        observed_from = leg.get("observedFrom")
        rows = [
            f"observed from: {_safe(observed_from)}"
            if observed_from
            else "observed from: nothing readable in this process"
        ]
        if leg.get("lastTransitionAt"):
            rows.append(f"last transition: {_safe_ts(leg.get('lastTransitionAt'))}")
        return rows
    return []


# -- rendering ----------------------------------------------------------------


def _evidence_index(snapshot: Mapping[str, Any]) -> Dict[str, List[Mapping[str, Any]]]:
    index: Dict[str, List[Mapping[str, Any]]] = {}
    for entry in snapshot.get("evidence") or []:
        if isinstance(entry, Mapping):
            index.setdefault(str(entry.get("id")), []).append(entry)
    return index


def _evidence_lines(
    entry: Mapping[str, Any], generated_at: Any, indent: str
) -> List[str]:
    evidence_id = _safe(entry.get("id"))
    rule = _FRESHNESS_RULES.get(evidence_id, _FRESHNESS_RULE_UNKNOWN)
    return [
        f"{indent}evidence  {evidence_id}  [{_safe(entry.get('freshness'))}]  "
        f"{_safe(entry.get('resultCode'))}",
        f"{indent}          {_age_text(entry.get('observedAt'), generated_at)}"
        f"  ·  {rule}",
    ]


def _render_header(snapshot: Mapping[str, Any]) -> List[str]:
    profile = snapshot.get("profile") or {}
    producer = snapshot.get("producer") or {}
    mode = _safe(snapshot.get("observationMode"), fallback="passive")
    lines = [
        "OcuClaw Connection Health Snapshot "
        f"v{snapshot.get('contractVersion')}  ({mode} observation)",
        f"  profile      {_safe(profile.get('name'), fallback='unresolved')}",
        f"  fingerprint  {_safe(profile.get('hermesHomeFingerprint'))}",
        f"  generated    {_safe_ts(snapshot.get('generatedAt'))}",
        f"  producer     ocuclaw {_safe(producer.get('ocuclawVersion'))}"
        f"  ·  hermes {_safe(producer.get('hermesPackageVersion'))}"
        f"  ·  source {_safe(producer.get('hermesSource'))}",
    ]
    return lines


def _render_provenance(snapshot: Mapping[str, Any]) -> List[str]:
    index = _evidence_index(snapshot)
    lines = ["", "Hermes source provenance (advisory only)"]
    for evidence_id in (
        EVIDENCE_HERMES_SOURCE_STATE,
        EVIDENCE_HERMES_SOURCE_CERTIFIED,
        EVIDENCE_HERMES_SOURCE_OBSERVED,
        EVIDENCE_HERMES_SOURCE_SHALLOW,
    ):
        for entry in index.get(evidence_id, []):
            lines.extend(_evidence_lines(entry, snapshot.get("generatedAt"), "  "))
    return lines


AGENT_CHOICE_UNCHOSEN = "unchosen"
AGENT_CHOICE_MULTIPLE = "multiple"
AGENT_CHOICE_SINGLE = "single"
AGENT_CHOICE_MISMATCH = "mismatch"
AGENT_CHOICE_UNKNOWN = "unknown"

# Same wording the phone shows when the grey "+" is tapped (#2515), so a
# tester reading either surface recognises the other.
AGENT_CHOICE_SETUP_HINT = "run /ocuclaw-setup in a Hermes chat to choose"


def agent_choice_state(facts: Mapping[str, Any]) -> str:
    """Classify the agent choice from the raw config leaves (#2515).

    Mirrors `_setup_status`'s `agentModeChosen` rule — a choice counts only
    when the recorded answer and the switch agree — but keeps the reason,
    because the report's job is to say WHY the phone's "+" is grey:

    - ``unchosen``  the switch is off (or absent) and nothing was recorded —
                    an install that predates the agent question.
    - ``multiple``  switch on, answer ``multiple``: "+" creates agents.
    - ``single``    switch off, answer ``single``: "+" is grey by choice.
    - ``mismatch``  answer and switch disagree — an interrupted write or a
                    hand edit; the choice must be re-run, not guessed.
    - ``unknown``   the config could not be read.
    """
    if not facts.get("configReadable"):
        return AGENT_CHOICE_UNKNOWN
    multiplex = facts.get("multiplexProfiles")
    mode = facts.get("agentMode")
    if mode is None:
        # An unrecorded answer is "unchosen" even with the switch flipped on
        # by hand: the recorded choice is what the skill and the phone trust.
        return AGENT_CHOICE_UNCHOSEN
    if mode == "multiple" and multiplex is True:
        return AGENT_CHOICE_MULTIPLE
    if mode == "single" and multiplex is not True:
        return AGENT_CHOICE_SINGLE
    return AGENT_CHOICE_MISMATCH


def _render_agent_choice(facts: Mapping[str, Any], *, prescribe: bool) -> List[str]:
    """The `multiple agents` row of the Setup section (#2515).

    `status` names the state; only `doctor` (``prescribe``) adds the arrow line
    that offers the choice, matching the passive/prescribing split the Serve
    section already draws (#1273 §10).
    """
    state = agent_choice_state(facts)
    multiplex = facts.get("multiplexProfiles")
    switch = "on" if multiplex is True else "off"
    if state == AGENT_CHOICE_UNKNOWN:
        text = "unknown (configuration could not be read)"
    elif state == AGENT_CHOICE_MULTIPLE:
        text = "on  (agent mode: multiple — the phone's \"+\" creates agents)"
    elif state == AGENT_CHOICE_SINGLE:
        text = "off  (agent mode: single, chosen — the phone's \"+\" stays grey)"
    elif state == AGENT_CHOICE_MISMATCH:
        text = (
            f"{switch}  but agent mode is recorded as {facts.get('agentMode')!r} — "
            "the choice and the switch disagree"
        )
    else:
        text = f"{switch}  · agent mode not chosen yet — the phone's \"+\" is grey"
    lines = [f"  multiple agents           {text}"]
    if prescribe and state in (AGENT_CHOICE_UNCHOSEN, AGENT_CHOICE_MISMATCH):
        lines.append(f"    → {AGENT_CHOICE_SETUP_HINT} (multiple agents is recommended)")
    return lines


def _render_setup(
    snapshot: Mapping[str, Any],
    facts: Optional[Mapping[str, Any]] = None,
    *,
    prescribe: bool = False,
) -> List[str]:
    setup = snapshot.get("setup") or {}
    state = _safe(setup.get("state"))
    gloss = _SETUP_STATE_GLOSS.get(state, "state not known to this build")
    supported = setup.get("hermesVersionSupported")
    supported_text = _yes_no(supported, unknown="unknown")
    hermes_range = setup.get("supportedHermesRange")
    if hermes_range:
        supported_text += f" (supported range {hermes_range})"
    node_text = (
        f"required · {'available' if setup.get('nodeAvailable') else 'not available'}"
        if setup.get("nodeRequired")
        else "not required by this configuration"
    )
    secrets = setup.get("secretsPresent") or {}
    if secrets:
        # Presence booleans only. No value, length, prefix, or mask (#1273 §6).
        secret_text = "  ·  ".join(
            f"{_safe(name)}: {_yes_no(bool(present))}"
            for name, present in sorted(secrets.items())
        )
    else:
        secret_text = "no secret slots reported"

    lines = [
        "",
        "Hermes Setup State — durable installation and configuration",
        f"  state                     {state}  ({gloss})",
        f"  hermes version supported  {supported_text}",
        f"  hermes CLI on PATH        {_yes_no(setup.get('hermesCliOnPath'))}",
        f"  plugin enabled            {_yes_no(setup.get('pluginEnabled'))}",
        f"  platform enabled          {_yes_no(setup.get('platformEnabled'))}",
    ]
    if facts is not None:
        lines.extend(_render_agent_choice(facts, prescribe=prescribe))
    lines.extend(
        [
            f"  Node.js                   {node_text}",
            f"  OcuClaw runtime           "
            f"{'available' if setup.get('runtimeAvailable') else 'not available'}",
            f"  secrets configured        {secret_text}",
        ]
    )
    return lines


def _render_health(snapshot: Mapping[str, Any]) -> List[str]:
    health = snapshot.get("currentHealth") or {}
    legs = health.get("legs") or {}
    generated_at = snapshot.get("generatedAt")
    index = _evidence_index(snapshot)
    gateway_state = str((legs.get(LEG_HERMES_GATEWAY) or {}).get("state"))

    aggregate = _safe(health.get("state"))
    aggregate_gloss = {
        HEALTH_HEALTHY: "all four legs are healthy",
        HEALTH_UNHEALTHY: "at least one leg has authoritative unhealthy evidence",
        HEALTH_UNKNOWN: "no leg is unhealthy, and at least one is unobserved",
    }.get(aggregate, "state not known to this build")

    lines = [
        "",
        "Current Connection Health — point in time, four independent legs",
        f"  aggregate  {aggregate}  ({aggregate_gloss})",
    ]
    for name, label in _LEG_LABELS:
        leg = legs.get(name) or {}
        state = _safe(leg.get("state"))
        if name == LEG_HERMES_GATEWAY:
            detail = _gateway_detail(leg)
        elif name == LEG_OCUCLAW_RELAY:
            detail = _relay_detail(leg, gateway_state)
        elif name == LEG_TAILNET_ROUTE:
            detail = _tailnet_detail(leg)
        else:
            detail = _phone_detail(leg)
        lines.append("")
        lines.append(f"  {label}  —  {state}")
        lines.append(f"      {detail}")
        for extra in _leg_extra(name, leg):
            lines.append(f"      {extra}")
        seen = set()
        for evidence_id in leg.get("evidenceIds") or []:
            for entry in index.get(str(evidence_id), []):
                key = id(entry)
                if key in seen:
                    continue
                seen.add(key)
                lines.extend(_evidence_lines(entry, generated_at, "      "))
    return lines


def _render_proof(snapshot: Mapping[str, Any]) -> List[str]:
    proof = snapshot.get("firstRunProof") or {}
    state = _safe(proof.get("state"))
    index = _evidence_index(snapshot)
    if state == PROOF_PROVEN:
        setup_state = _safe((snapshot.get("setup") or {}).get("state"))
        health_state = _safe((snapshot.get("currentHealth") or {}).get("state"))
        if setup_state == "configured" and health_state == HEALTH_UNHEALTHY:
            detail = (
                "configured, currently unhealthy, previously completed on G2; "
                "later outages never erase this"
            )
        else:
            detail = (
                "a phone-origin turn was confirmed on G2 for this profile; later "
                "outages never erase this"
            )
    elif state == PROOF_NOT_PROVEN:
        detail = "no phone-origin turn has been confirmed on G2 for this profile"
    else:
        detail = (
            "the proof record could not be read, so proof can be neither "
            "claimed nor ruled out"
        )
    lines = [
        "",
        "Hermes First-Run Proof — durable, never expires",
        f"  state  {state}",
        f"      {detail}",
    ]
    if state == PROOF_PROVEN:
        lines.append(f"      proven at: {_safe_ts(proof.get('provenAt'))}")
        lines.append(f"      method:    {_safe(proof.get('method'))}")
        lines.append(
            f"      recorded against: ocuclaw {_safe(proof.get('ocuclawVersion'))}"
            f"  ·  hermes {_safe(proof.get('hermesPackageVersion'))}"
        )
    for entry in index.get(EVIDENCE_FIRST_RUN_PROOF, []):
        lines.extend(_evidence_lines(entry, snapshot.get("generatedAt"), "      "))
    return lines


def _render_findings(snapshot: Mapping[str, Any]) -> List[str]:
    findings = [f for f in (snapshot.get("findings") or []) if isinstance(f, Mapping)]
    if not findings:
        return ["", "Findings — none"]
    order = {"error": 0, "warning": 1, "info": 2}
    findings = sorted(
        findings,
        key=lambda f: (order.get(str(f.get("severity")), 3), str(f.get("code"))),
    )
    lines = ["", f"Findings — {len(findings)}"]
    for finding in findings:
        severity = _safe(finding.get("severity"))
        lines.append("")
        lines.append(
            f"  [{severity}]  {_safe(finding.get('code'))}"
            f"  ({_safe(finding.get('scope'))})"
        )
        summary = finding.get("summary")
        if isinstance(summary, str) and summary.strip():
            lines.append(f"      {summary.strip()}")
        evidence_ids = [
            _safe(e) for e in (finding.get("evidenceIds") or []) if e is not None
        ]
        if evidence_ids:
            lines.append(f"      evidence: {', '.join(evidence_ids)}")
        repair = finding.get("repair")
        if isinstance(repair, Mapping):
            code = _safe(repair.get("code"))
            lines.append(f"      repair [{code}]: {REPAIR_TEXT.get(code, REPAIR_TEXT_UNKNOWN)}")
            parameters = repair.get("parameters")
            if isinstance(parameters, Mapping) and parameters:
                rendered = "  ·  ".join(
                    f"{_safe(key)}={_safe(value)}"
                    for key, value in sorted(parameters.items())
                )
                lines.append(f"      repair details: {rendered}")
    return lines


def _render_probes(outcomes: Sequence[doctor_lane.ProbeOutcome]) -> List[str]:
    lines = [
        "",
        "Bounded active checks — doctor only, "
        f"{doctor_lane.PROBE_TOTAL_BUDGET_S:.0f}s total budget, no mutations",
    ]
    if not outcomes:
        lines.append("  none were planned for this host")
        return lines
    for outcome in outcomes:
        gloss = _PROBE_OUTCOME_GLOSS.get(
            outcome.result_code, "outcome not known to this build"
        )
        lines.append(
            f"  {_safe(outcome.name)}  —  {_safe(outcome.result_code)}  ({gloss})"
        )
    return lines


# -- the Serve section (#1319) ------------------------------------------------
#
# This is the one part of the human report built from *facts* rather than from
# the derived document, and the reason is the boundary it sits on.
#
# The exact apply command has to name this host's relay port, and the phone
# address has to name this host's tailnet node. Neither value may enter the
# snapshot: #1273 §1 excludes phone addresses and tailnet/node names from the
# document alongside secrets, and the frozen key set gives them nowhere to go
# even if someone tried. So the values live in the facts dict, and only the
# surfaces sanctioned to show a local human their own address read them —
# this rendering, and the Setup Assistant.
#
# `--json` therefore never carries them: it serialises the snapshot and
# nothing else. The support attachment, the dashboard backend, and every
# agent-facing consumer read that same document, so none of them can leak an
# address they are structurally unable to see.

_SERVE_REASON_GLOSS: Dict[str, str] = {
    "route_matches": "port, protocol, TLS identity, and loopback target all match",
    "no_route_at_port": "nothing is configured on OcuClaw's tailnet port",
    "https_route_not_tls_terminated_tcp": (
        "that port serves HTTPS web content, not the TLS-terminated TCP "
        "forwarder the relay needs"
    ),
    "http_route_not_tls_terminated_tcp": (
        "that port serves plain HTTP web content, not the TLS-terminated TCP "
        "forwarder the relay needs"
    ),
    "raw_tcp_route_without_tls_termination": (
        "that port forwards raw TCP without terminating TLS, so the phone's "
        "encrypted connection would reach the relay unreadable"
    ),
    "route_uses_proxy_protocol": (
        "that route prefixes each connection with a PROXY header the relay "
        "does not parse, so it is configured but unusable"
    ),
    "forwards_to_a_different_target": (
        "the route exists but forwards to a different local port than this "
        "profile's relay"
    ),
    "terminates_tls_for_another_node": (
        "the route terminates TLS for a different tailnet node"
    ),
    "web_handler_occupies_the_port": "a web handler already occupies that port",
    "route_is_exposed_by_funnel": (
        "Funnel publishes that port beyond the tailnet, which is not the "
        "private route OcuClaw proposes"
    ),
    "foreground_serve_session_active": (
        "a foreground `tailscale serve` session is holding that port, and its "
        "handlers take precedence over the background route. End that session "
        "— the terminal running it — then run this command again"
    ),
    "unrecognised_serve_document": (
        "Tailscale reported a Serve configuration in a shape this build has "
        "not verified, so nothing is claimed about it"
    ),
    "unrecognised_route_entry": (
        "the entry on that port carries a field this build has not verified, "
        "so nothing is claimed about it"
    ),
    "node_dns_identity_unknown": "this host's own tailnet name could not be read",
    "relay_port_unknown": "this profile's relay port could not be read",
    "serve_status_not_read": "the Tailscale CLI did not answer, so nobody looked",
}

_SERVE_READ_GLOSS: Dict[str, str] = {
    "serve_cli_absent": "the tailscale command is not on this host's PATH",
    "serve_read_timeout": "the tailscale command did not answer in time",
    "serve_read_failed": "the tailscale command exited with an error",
    "serve_read_unparsable": "the tailscale command returned output this build could not parse",
}


def _render_serve(
    snapshot: Mapping[str, Any],
    facts: Mapping[str, Any],
    *,
    teardown_permitted: bool,
    replacement_safe: bool = True,
    claim_state: str = CLAIM_OWNED,
    prescribe: bool = True,
) -> List[str]:
    """The Serve route section: what is there, what to run, what to remove."""
    from . import serve as serve_mod

    classification = _safe(facts.get("serveClassification"))
    reason = str(facts.get("serveReason") or "")
    relay_port = facts.get("serveRelayPort")

    lines = ["", f"Tailnet Serve route — {classification}"]
    gloss = _SERVE_REASON_GLOSS.get(reason)
    if gloss:
        lines.append(f"  {gloss}")
    read_code = str(facts.get("serveReadCode") or "")
    read_gloss = _SERVE_READ_GLOSS.get(read_code)
    if read_gloss:
        lines.append(f"  {read_gloss}")

    # The exact substituted command, printed for the user to run. OcuClaw
    # never runs it: P15 rungs 2 and 3 were rejected, and there is no code
    # path in this bundle that could.
    if classification in {"absent", "wrong"}:
        if claim_state == CLAIM_FOREIGN:
            lines.append("")
            lines.append(
                "  Another OcuClaw gateway install on this host owns this "
                "route, so no command is printed here. Applying one would "
                "repoint the shared port at this install and disconnect the "
                "other."
            )
            lines.append(
                "  If that install is gone, remove its ownership receipt from "
                "the OcuClaw host state directory, then run "
                "`hermes ocuclaw doctor` again."
            )
        elif not replacement_safe:
            lines.append("")
            lines.append(
                "  OcuClaw could not record which install owns this host's "
                "route, so it is not printing a command that would change it."
            )
            lines.append(
                "  Check that the OcuClaw host state directory is writable, "
                "then run `hermes ocuclaw doctor` again."
            )
        elif reason in serve_mod.WEB_OCCUPIED_REASONS:
            lines.append("")
            lines.append(
                "  That port is already serving web content, and Tailscale "
                "will not put a TCP forwarder on a port that is. The existing "
                "route has to be removed by whoever set it up before OcuClaw's "
                "can be applied."
            )
            lines.append(
                "  OcuClaw does not print a command to remove it: it is not "
                "OcuClaw's route. Run `tailscale serve status` to see what is "
                "there, then run `hermes ocuclaw doctor` again once the port "
                "is free."
            )
        elif not facts.get("serveNodeDnsName"):
            lines.append("")
            lines.append(
                "  This host's own tailnet name could not be read, so no "
                "command is printed for it yet. Check that Tailscale is "
                "running, then run `hermes ocuclaw doctor` again."
            )
        elif facts.get("serveTlsCertAvailable") == "no":
            # The command would apply cleanly and then not work: `serve
            # status` would classify the route `ready` while every connection
            # through it died in a TLS alert. Printing it with a warning
            # attached would still hand the user a line to paste, and a
            # pasted line is what they act on. So it is withheld, and the two
            # clicks that make it work are printed instead (#2672).
            lines.append("")
            lines.append(
                "  This tailnet cannot issue the TLS certificate the route "
                "needs, so no command is printed yet. Applying it would look "
                "like it worked and then fail every connection."
            )
            lines.append(
                "  Turn on MagicDNS and HTTPS Certificates for this tailnet "
                "in the Tailscale admin console, under DNS, then run "
                "`hermes ocuclaw doctor` again for the exact command."
            )
        elif not prescribe:
            lines.append("")
            lines.append(
                "  Run `hermes ocuclaw doctor` for the exact command to fix "
                "this. It is printed there, where OcuClaw can record having "
                "proposed it."
            )
        elif isinstance(relay_port, int):
            lines.append("")
            lines.append("  Apply OcuClaw's route by running this on this host:")
            lines.append(
                f"    {serve_mod.apply_command(relay_port=relay_port)}"
            )
            if classification == "wrong":
                lines.append(
                    "  Something else is already on that port. Check what it "
                    "belongs to before replacing it."
                )
        else:
            lines.append(
                "  This profile's relay port could not be read, so no command "
                "can be printed for it yet."
            )

    # Teardown is offered only while the ownership receipt and the live route
    # still agree — never as a global reset, and never for a route OcuClaw
    # cannot still prove it owns.
    if teardown_permitted:
        lines.append("")
        lines.append("  To remove the route OcuClaw recorded on this host:")
        lines.append(f"    {serve_mod.teardown_command()}")
        lines.append(
            "  This removes only that one route. Never run `tailscale serve "
            "reset` — it would remove every Serve route on this host, "
            "including ones OcuClaw does not own."
        )
        lines.append(
            "  The route is host-wide, not per-profile: removing it "
            "disconnects every Hermes profile on this host that uses it."
        )

    lines.extend(_render_phone_address(snapshot, facts, claim_state=claim_state))
    return lines


def _render_phone_address(
    snapshot: Mapping[str, Any],
    facts: Mapping[str, Any],
    *,
    claim_state: str = CLAIM_OWNED,
) -> List[str]:
    """The phone address, or the diagnosis that replaces it (P17).

    Two gates, and the second is the one that matters. The route being
    `ready` says the front door is configured correctly; the gateway leg
    being healthy says something is actually behind it. An address that
    satisfies only the first is a doomed address — the user pastes it into
    their phone, the phone cannot connect, and nothing on this surface told
    them why. So when either gate fails, this prints the reason instead of
    the address.

    The third gate is negative evidence: if a bounded probe actually observed
    the route refusing a connection, the address is withheld even though the
    configuration is right, because at that moment it demonstrably will not
    work (#1274).
    """
    from . import serve as serve_mod

    legs = ((snapshot.get("currentHealth") or {}).get("legs") or {})
    gateway = legs.get(LEG_HERMES_GATEWAY) or {}
    tailnet = legs.get(LEG_TAILNET_ROUTE) or {}
    gateway_state = str(gateway.get("state"))
    classification = str(facts.get("serveClassification"))

    # A `ready` route owned by another install fronts *its* loopback backend,
    # so this address would connect the phone to the wrong gateway. Ownership
    # gates the address exactly as it gates the commands.
    route_ready = classification == "ready" and claim_state == CLAIM_OWNED
    gateway_running = gateway_state == HEALTH_HEALTHY
    proven_dead = tailnet.get("reachable") == "no" or (
        tailnet.get("applicationReady") == "no"
    )

    if route_ready and gateway_running and not proven_dead:
        address = serve_mod.phone_address(dns_name=facts.get("serveNodeDnsName"))
        if address is not None:
            return [
                "",
                "  Phone address (this host only — never paste it into a bug "
                "report or a shared document):",
                f"    {address}",
            ]

    reasons: List[str] = []
    if claim_state == CLAIM_FOREIGN:
        reasons.append(
            "another OcuClaw gateway install on this host owns this route, so "
            "its address would not reach this install"
        )
    elif claim_state == CLAIM_UNCLAIMED:
        reasons.append(
            "this route was not established through OcuClaw on this install, "
            "so it cannot confirm the address reaches this install rather "
            "than another gateway on this host"
        )
    elif claim_state == CLAIM_UNAVAILABLE:
        # Without this the classification branch below would render the
        # contradiction "the tailnet route is ready, not ready", and never
        # name receipt access as the actual blocker.
        reasons.append(
            "OcuClaw could not read which install owns this host's route, so "
            "it cannot tell whether this address reaches this install"
        )
    elif not route_ready:
        reasons.append(
            f"the tailnet route is {_safe(classification)}, not ready"
        )
    if not gateway_running:
        reasons.append("the Hermes gateway for this profile is not running")
    if proven_dead:
        reasons.append("a bounded check found the configured route not answering")
    if route_ready and gateway_running and not proven_dead:
        reasons.append("this host's tailnet name could not be read")

    lines = [
        "",
        "  Phone address — withheld, because " + "; and ".join(reasons) + ".",
    ]
    if claim_state == CLAIM_UNCLAIMED:
        lines.append(
            "  Remove that route and run `hermes ocuclaw doctor` again: "
            "OcuClaw will print the command to recreate it, and will then own "
            "what it proposed."
        )
    else:
        lines.append(
            "  An address printed now would not connect. Fix the above, then "
            "run `hermes ocuclaw doctor` again."
        )
    return lines


def render_snapshot_text(
    snapshot: Mapping[str, Any],
    *,
    probe_outcomes: Optional[Sequence[doctor_lane.ProbeOutcome]] = None,
    facts: Optional[Mapping[str, Any]] = None,
    teardown_permitted: bool = False,
    replacement_safe: bool = True,
    claim_state: str = CLAIM_OWNED,
    prescribe: bool = True,
) -> str:
    """Render one snapshot as the human report. Pure; no clock, no host access."""
    lines: List[str] = []
    lines.extend(_render_header(snapshot))
    lines.extend(_render_provenance(snapshot))
    lines.extend(_render_setup(snapshot, facts, prescribe=prescribe))
    lines.extend(_render_health(snapshot))
    if facts is not None:
        lines.extend(
            _render_serve(
                snapshot,
                facts,
                teardown_permitted=teardown_permitted,
                replacement_safe=replacement_safe,
                claim_state=claim_state,
                prescribe=prescribe,
            )
        )
    lines.extend(_render_proof(snapshot))
    if probe_outcomes is not None:
        lines.extend(_render_probes(probe_outcomes))
    lines.extend(_render_findings(snapshot))
    return "\n".join(lines) + "\n"


def render_removal_notice(notice: Mapping[str, Any]) -> List[str]:
    """Doctor's removal advisory for the generated Desktop runtime (#2086).

    Pure. Silent unless there is something true and actionable to say, so the
    ordinary report is unchanged for a profile with no generated runtime.

    Two cases, and only two:

    * the Agent plugin and its owned runtime are both present — warn that
      generic `hermes plugins remove ocuclaw` is not complete removal, because
      it deletes the Agent package while `<home>/desktop-plugins/ocuclaw/` is
      not part of any Hermes package and keeps loading;
    * the runtime is owned and the Agent package is already gone — print the
      self-contained recovery command. This branch is close to unreachable in
      practice, because generic removal takes the very command printing it;
      it exists so the observation has one honest answer in both directions.

    A foreign file at that path is not OcuClaw's to discuss, and says nothing.
    """

    state = notice.get("state")
    path = notice.get("runtimePath")
    if state != "owned" or not isinstance(path, str):
        return []
    if notice.get("orphaned"):
        command = notice.get("recoveryCommand")
        lines = [
            "",
            "Removal — an OcuClaw-owned Hermes Desktop runtime is orphaned",
            "",
            "  The OcuClaw Agent plugin is gone, but this generated Desktop "
            "runtime remains and still loads:",
            f"    {path}",
        ]
        if isinstance(command, str) and command:
            lines.append("")
            lines.append(
                "  Remove only that orphan — it checks OcuClaw's ownership "
                "marker first and preserves anything else:"
            )
            lines.append("")
            lines.extend(f"    {line}" for line in command.splitlines())
        return lines
    return [
        "",
        "Removal — use `hermes ocuclaw uninstall`, not generic plugin removal",
        "",
        "  OcuClaw generates and owns this Hermes Desktop runtime:",
        f"    {path}",
        "",
        "  It is not part of the Agent package, so `hermes plugins remove "
        "ocuclaw` leaves it behind and Hermes Desktop keeps loading it.",
        "  `hermes ocuclaw uninstall` removes the Agent package, this runtime, "
        "and OcuClaw's own profile state together.",
    ]


def render_error_text(envelope: Mapping[str, Any]) -> str:
    """Render the machine-error envelope for a human. Never exposes a path."""
    return (
        f"OcuClaw connection health unavailable [{_safe(envelope.get('code'))}]\n"
        f"  {envelope.get('message')}\n"
    )


# -- exit codes ---------------------------------------------------------------


def status_exit_code(snapshot: Mapping[str, Any]) -> int:
    """``status`` exits 0 whenever it produced a valid snapshot (#1273 §10).

    Its job is to report, not to judge. A user piping status into a script
    wants the document; a shell that treats "the phone is not connected" as a
    command failure makes the passive surface unusable for exactly the case it
    exists to describe.
    """
    return EXIT_OK


def doctor_exit_code(snapshot: Mapping[str, Any]) -> int:
    """``doctor`` exits 0 only for a configured host healthy on all four legs.

    Warnings alone never change it, and First-Run Proof never changes it: proof
    is a durable historical fact, not a statement about the host right now.
    """
    setup_state = (snapshot.get("setup") or {}).get("state")
    health = (snapshot.get("currentHealth") or {}).get("state")
    if setup_state == "configured" and health == HEALTH_HEALTHY:
        return EXIT_OK
    return EXIT_PROBLEM


# -- command surface ----------------------------------------------------------


def _default_facts() -> Dict[str, Any]:
    """Collect facts in this process, after plugin discovery (#1273 P8).

    Imported lazily so wiring the argparse subparser does not drag the whole
    adapter — and its Hermes-facing imports — into every `hermes` invocation.
    """
    from .adapter import _collect_health_facts

    return _collect_health_facts()


def prescription_eligible(
    facts: Mapping[str, Any], *, json_output: bool, command: str = "doctor"
) -> bool:
    """Whether this invocation would print an apply command, ownership aside.

    Deliberately separate from :func:`apply_command_emitted`, and deliberately
    free of any ownership question, because ownership is *reserved* on the
    strength of this answer. Reserving first and asking later would plant a
    durable claim on invocations that never propose anything — a `--json` run,
    an `unknown` classification, a web-occupied port — and a later gateway
    would then be refused commands and an address by a receipt nobody could
    see being written.
    """
    if command != "doctor":
        return False
    if json_output:
        # `--json` emits the snapshot document and nothing else.
        return False
    if facts.get("serveClassification") not in {"absent", "wrong"}:
        return False
    if not isinstance(facts.get("serveRelayPort"), int):
        return False
    if not facts.get("serveNodeDnsName"):
        # Without the host's own tailnet identity a proposal cannot be tied to
        # the route that later appears, so applying this command could never
        # earn the teardown offer.
        return False
    if facts.get("serveReason") in _serve_mod().WEB_OCCUPIED_REASONS:
        # Tailscale would refuse the command, so it is not printed.
        return False
    if facts.get("serveTlsCertAvailable") == "no":
        # Tailscale would ACCEPT the command and the route would still not
        # carry a byte, because `--tls-terminated-tcp` needs a certificate
        # this tailnet cannot issue. Withholding it here also keeps the
        # ownership receipt from recording a proposal for a command nobody
        # was shown (#2672).
        return False
    return True


def apply_command_emitted(
    facts: Mapping[str, Any],
    *,
    json_output: bool,
    replacement_safe: bool,
    command: str = "doctor",
) -> bool:
    """Whether this invocation actually shows a human the apply command.

    The single source of truth for that question, because two things depend
    on it and they must not disagree: the Serve section prints the command
    when it is true, and the ownership receipt records a *proposal* only when
    it is true.

    That second use is the load-bearing one. Proposal evidence is what later
    permits teardown guidance, so recording it on a run that printed no
    command — a `--json` invocation, or one where the replacement was
    withheld because another profile may own the route — would manufacture
    the evidence that opens a destructive suggestion for a route OcuClaw
    never proposed.

    Which is also why only `doctor` prints it. `status` is passive by
    contract (#1273 §10) and may not write a receipt, so a command printed
    there could never be recorded as proposed — the user would apply it and
    then find the narrow teardown permanently unavailable, because nothing
    was allowed to witness the proposal. `status` diagnoses and names the
    command that prescribes; `doctor` prescribes.
    """
    if not prescription_eligible(facts, json_output=json_output, command=command):
        return False
    if not replacement_safe:
        # Whoever owns the host receipt owns the port. Applying a route while
        # another gateway holds the claim repoints the shared port at this
        # install's relay — and this install then cannot record ownership,
        # because the claim guard correctly preserves the owner's. That leaves
        # live configuration and recorded ownership permanently disagreeing.
        # An `absent` route is not an exception: nobody is disconnected at
        # that instant, but applying it still takes a port that is spoken for.
        return False
    return True


def _serve_mod():
    from . import serve as serve_mod

    return serve_mod


def _default_route_reservation(facts: Mapping[str, Any]) -> str:
    """Doctor's gate: settle ownership now, before anything is printed."""
    from . import doctor as doctor_mod
    from . import receipts as receipts_mod

    try:
        if doctor_mod.reserve_route_ownership(facts):
            return CLAIM_OWNED
        record, status = receipts_mod.read_managed_serve_route()
        owner = record.get("owningGatewayFingerprint") if status == "ok" else None
        if owner:
            # Two doctor runs of the *same* install can race the exclusive
            # create; the loser is still the owner, and telling it another
            # gateway holds the route would withhold its own output.
            mine = facts.get("hermesHomeFingerprint")
            return CLAIM_OWNED if mine and owner == mine else CLAIM_FOREIGN
        return CLAIM_UNAVAILABLE
    except Exception:  # noqa: BLE001 - fail closed, withhold the command
        return CLAIM_UNAVAILABLE


def _default_replacement_safe(facts: Mapping[str, Any]) -> bool:
    """Whether a replacement command would trample another gateway's route.

    The route is host-wide and fronts exactly one gateway install, so the one
    collision that matters is a *second gateway* on this machine: first
    install owns the route, and a sibling gets honest diagnosis rather than a
    command that would silently disconnect the owner (owner ruling 2, #1373).

    Sibling **profiles** are explicitly not that case. Hermes profiles
    multiplex inside the owning gateway behind this single route, so their
    existence is never a reason to withhold anything — and this function
    deliberately asks the host receipt who owns the route rather than
    inspecting the profile layout, which would encode exactly the
    "one route implies one profile" invariant the ruling forbids.
    """
    try:
        from . import receipts as receipts_mod

        record, status = receipts_mod.read_managed_serve_route()
        if status == "missing":
            # Nobody has claimed the route on this host. That permits a claim;
            # it is not itself one.
            return CLAIM_UNCLAIMED
        if status != "ok":
            # A receipt exists and cannot be interpreted. An unreadable claim
            # is still a claim: treating it as unclaimed would hand a sibling
            # install a command that disconnects the real owner.
            return CLAIM_UNAVAILABLE
        owner = record.get("owningGatewayFingerprint")
        mine = facts.get("hermesHomeFingerprint")
        if not owner:
            return CLAIM_UNAVAILABLE
        if not mine:
            return CLAIM_UNAVAILABLE
        return CLAIM_OWNED if owner == mine else CLAIM_FOREIGN
    except Exception:  # noqa: BLE001 - fail closed, withhold the command
        return CLAIM_UNAVAILABLE


def _default_teardown_permitted(facts: Mapping[str, Any]) -> bool:
    """Whether the Managed Serve Route receipt still matches the live route.

    The gate on printing teardown guidance (#1268/#1269). Imported lazily and
    failing closed on anything at all: if OcuClaw cannot currently prove it
    owns the route in front of it, it does not offer to remove it. A wrong
    answer here is the one that has a user delete somebody else's route.

    Four conditions, and the first is the one that is easy to miss. The
    receipt records what OcuClaw observed *then*; the facts describe what this
    profile *wants*. Neither is a statement about the route on the host right
    now. So the live classification has to say `ready` as well — otherwise a
    port that has since been taken over by an HTTPS route, a Funnel, or a
    forwarder to somewhere else would still satisfy a stale receipt, and
    OcuClaw would print `off` for a route it can no longer prove is its own.
    """
    try:
        from . import receipts as receipts_mod
        from .serve import serve_port

        # 1. The live route is still, right now, the one OcuClaw recognises.
        if facts.get("serveClassification") != "ready":
            return False

        record, status = receipts_mod.read_managed_serve_route()
        if status != "ok":
            return False

        # 1b. OcuClaw actually proposed this route, rather than having found
        # one that happened to match. Recognising a route by shape cannot
        # tell those apart, and offering to delete a route the user built
        # themselves is the failure this whole gate exists to prevent.
        if (
            record.get("ownershipBasis")
            != receipts_mod.OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED
        ):
            return False

        # 2. The receipt still describes that same route.
        if not receipts_mod.route_receipt_agrees(
            record,
            servePort=serve_port(),
            relay_port=facts.get("serveRelayPort"),
            node_identity_fingerprint=receipts_mod.fingerprint_node_identity(
                facts.get("serveNodeDnsName")
            ),
        ):
            return False

        # 3. This gateway is the one that owns the route. A sibling install
        # may read the same host receipt, and it must not be handed a removal
        # command for somebody else's route.
        owner = record.get("owningGatewayFingerprint")
        mine = facts.get("hermesHomeFingerprint")
        if not owner or not mine or owner != mine:
            return False

        # Deliberately NOT gated on `configuredProfiles`. Hermes profiles
        # multiplex inside this gateway behind the one route, so several
        # entries there is ordinary rather than a conflict, and refusing on
        # that basis would encode the invariant owner ruling 2 forbids. The
        # printed guidance still says the route is host-wide, because removing
        # it does affect every profile behind it — that is a thing to tell the
        # user, not a reason to hide the command from its owner.
        return True
    except Exception:  # noqa: BLE001 - fail closed, never offer a teardown
        return False


def _default_removal_notice() -> Mapping[str, Any]:
    """Doctor's read-only look at the generated Desktop runtime (#2086)."""

    from . import uninstall as uninstall_mod

    return uninstall_mod.desktop_removal_notice()


def _emit_error(
    code: str,
    *,
    json_output: bool,
    stdout: TextIO,
    stderr: TextIO,
    profile: Optional[Mapping[str, Any]] = None,
) -> int:
    envelope = error_envelope(code, _ERROR_MESSAGES[code], profile=profile)
    if json_output:
        stdout.write(json.dumps(envelope, indent=2, sort_keys=True) + "\n")
    else:
        stderr.write(render_error_text(envelope))
    return EXIT_USAGE


def run(
    command: str,
    *,
    json_output: bool = False,
    facts_fn: Optional[Callable[[], Dict[str, Any]]] = None,
    observe_fn: Optional[Callable[..., Any]] = None,
    record_fn: Optional[Callable[..., Any]] = None,
    teardown_fn: Optional[Callable[[Mapping[str, Any]], bool]] = None,
    replacement_fn: Optional[Callable[[Mapping[str, Any]], bool]] = None,
    removal_notice_fn: Optional[Callable[[], Mapping[str, Any]]] = None,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
) -> int:
    """Run one command end to end and return its exit code.

    The single seam every test drives: swap ``facts_fn`` for a fixture facts
    dict and the whole surface — derivation, rendering, exit code — runs
    exactly as it does against a real host, because the fixture goes through
    the same :func:`derive_snapshot` every other presenter uses.
    """
    # Resolved here rather than as bound defaults so a test can substitute the
    # collector on the module without reaching past an already-bound default.
    facts_fn = _default_facts if facts_fn is None else facts_fn
    observe_fn = doctor_lane.observe if observe_fn is None else observe_fn
    record_fn = doctor_lane.record_route_ownership if record_fn is None else record_fn
    teardown_fn = _default_teardown_permitted if teardown_fn is None else teardown_fn
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr

    if command not in {"status", "doctor"}:
        return _emit_error(
            ERROR_UNKNOWN_SUBCOMMAND, json_output=json_output, stdout=out, stderr=err
        )

    try:
        facts = facts_fn()
    except Exception:  # noqa: BLE001 - a diagnostic must not become an outage
        return _emit_error(
            ERROR_COLLECTION_FAILED, json_output=json_output, stdout=out, stderr=err
        )

    if not facts.get("profileResolved"):
        # An unresolved or ambiguous target profile produces no snapshot at all
        # (#1273 §11) — silently reporting on the default profile instead is
        # exactly the substitution that rule exists to forbid.
        return _emit_error(
            ERROR_PROFILE_UNRESOLVED, json_output=json_output, stdout=out, stderr=err
        )

    probe_outcomes: Optional[List[doctor_lane.ProbeOutcome]] = None
    if command == "doctor":
        try:
            facts, outcomes = observe_fn(facts, probed_at=now_iso())
            probe_outcomes = list(outcomes)
        except Exception:  # noqa: BLE001 - a failed lane observed nothing
            # Falling back to the passive facts here would be a false green:
            # doctor would inherit cached probe evidence, label the document
            # an active observation it never made, and could exit 0 on the
            # strength of a run whose checks all crashed.
            facts, outcomes = doctor_lane.lane_failed(facts)
            probe_outcomes = list(outcomes)
    if command == "doctor" and facts.get("serveClassification") == "ready":
        # The *observed* half, recorded before rendering because the render
        # asks whether teardown may be offered, and that question is answered
        # from this receipt. Recorded afterwards — as it briefly was — the
        # first run that actually qualifies would read its own pre-update
        # receipt, withhold the teardown, and only offer it on a second
        # invocation nothing documents. This half depends on nothing that has
        # been printed, so it is safe to persist here; the *proposed* half is
        # not, and stays below.
        try:
            record_fn(facts)
        except Exception:  # noqa: BLE001 - a receipt failure is not an outage
            pass

    try:
        snapshot = derive_snapshot(facts)
    except Exception:  # noqa: BLE001 - report the failure, never a partial truth
        return _emit_error(
            ERROR_SNAPSHOT_FAILED, json_output=json_output, stdout=out, stderr=err
        )

    if (
        snapshot.get("contract") != SNAPSHOT_CONTRACT
        or snapshot.get("contractVersion") != SNAPSHOT_CONTRACT_VERSION
    ):
        # Unknown contract versions are never partially interpreted (#1273 §12).
        return _emit_error(
            ERROR_UNSUPPORTED_CONTRACT,
            json_output=json_output,
            stdout=out,
            stderr=err,
            profile=snapshot.get("profile"),
        )

    if replacement_fn is None:
        # Resolved here, not with the other seams, because the choice depends
        # on the facts this run collected. Ownership is *reserved* only by an
        # invocation that is about to prescribe a route; every other run —
        # `status`, `--json`, a ready or unrecognised route — answers the same
        # question read-only. A claim must never be a side effect of looking.
        replacement_fn = (
            _default_route_reservation
            if prescription_eligible(facts, json_output=json_output, command=command)
            else _default_replacement_safe
        )

    claim_state = replacement_fn(facts)
    if isinstance(claim_state, bool):
        # A substituted seam may still answer with a plain boolean.
        claim_state = CLAIM_OWNED if claim_state else CLAIM_FOREIGN
    # Proposing needs only that nobody else holds the route; the reservation
    # that runs first turns an unclaimed host into an owned one.
    replacement_safe = claim_state in (CLAIM_OWNED, CLAIM_UNCLAIMED)

    if json_output:
        # Only the snapshot on stdout; human diagnostics go to stderr (#1273 §10).
        out.write(json.dumps(snapshot, indent=2, sort_keys=True) + "\n")
    else:
        out.write(
            render_snapshot_text(
                snapshot,
                probe_outcomes=probe_outcomes,
                facts=facts,
                teardown_permitted=bool(teardown_fn(facts)),
                replacement_safe=replacement_safe,
                claim_state=claim_state,
                prescribe=(command == "doctor"),
            )
        )
        if command == "doctor":
            # `doctor` prescribes; `status` is passive by contract (#1273 §10)
            # and never prints a command. A failed observation is not an
            # outage — the report stands without the advisory.
            try:
                notice = (
                    _default_removal_notice()
                    if removal_notice_fn is None
                    else removal_notice_fn()
                )
                lines = render_removal_notice(notice)
            except Exception:  # noqa: BLE001 - advisory only, never fatal
                lines = []
            if lines:
                out.write("\n".join(lines) + "\n")

    if command == "doctor":
        # The *proposed* half, recorded only after the command that justifies
        # it actually reached the user. It needs the apply command to have
        # genuinely been printed — not merely to have been printable —
        # because that evidence is what later opens the teardown gate.
        # Recording it before rendering, as this used to, meant a `--json`
        # run or a withheld replacement still minted a proposal nobody was
        # ever shown.
        try:
            if apply_command_emitted(
                facts,
                json_output=json_output,
                replacement_safe=replacement_safe,
                command=command,
            ):
                record_fn(facts)
        except Exception:  # noqa: BLE001 - a receipt failure is not an outage
            pass

    return status_exit_code(snapshot) if command == "status" else doctor_exit_code(
        snapshot
    )


def register_cli(parser: argparse.ArgumentParser) -> None:
    """Wire `hermes ocuclaw ...`. Called by Hermes with the plugin's subparser."""
    parser.set_defaults(func=dispatch)
    subs = parser.add_subparsers(dest="ocuclaw_command", required=False)

    status_parser = subs.add_parser(
        "status",
        help="Passive connection health for this profile; always exits 0",
        description=(
            "Render the Connection Health Snapshot from local facts and cached "
            "receipts. Runs no active check, mutates nothing, and always exits "
            "0 when it produced a valid snapshot."
        ),
    )
    status_parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Emit the snapshot v1 JSON document on stdout instead of the report",
    )

    doctor_parser = subs.add_parser(
        "doctor",
        help="Bounded active checks; exits non-zero on problems or bad state",
        description=(
            "Everything status does, plus the sanctioned bounded checks: each "
            "has a timeout, all share a five-second budget, none of them "
            "mutate anything. Exits 0 only when setup is configured and all "
            "four connection legs are healthy."
        ),
    )
    doctor_parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Emit the snapshot v1 JSON document on stdout instead of the report",
    )

    # `pair` deliberately has NO --json and no non-interactive mode. #1270's Q4
    # puts the approval at an interactive terminal with an exact yes/no prompt
    # and states that no non-interactive or dashboard approval path exists, so
    # offering a machine-readable variant here would be offering the one thing
    # the decision forbids.
    pair_parser = subs.add_parser(
        "pair",
        help="Pair a phone with this computer, approving it here",
        description=(
            "Start one pairing request and approve it at this terminal. Prints a "
            "QR code and, for a phone that cannot scan it, the address and a "
            "short-lived pairing code. The phone then shows four words; approve "
            "only if they match the four printed here. Requires an interactive "
            "terminal, and never displays or asks for any secret."
        ),
    )
    pair_parser.add_argument(
        "--address",
        required=True,
        metavar="wss://HOST:PORT",
        help=(
            "The private address this phone should reach, e.g. "
            "wss://my-host.tail-scale.ts.net:8443. Required: this computer "
            "cannot discover its own private route yet, and guessing one would "
            "bind an address the phone cannot dial."
        ),
    )

    # Like pairing approval, reset has no machine-readable or non-interactive
    # variant. The Setup Assistant owns the guided journey; this host-terminal
    # action is its locally confirmed mutation checkpoint.
    subs.add_parser(
        "reset-relay-credential",
        help="Reset the shared Relay Credential and disconnect every phone",
        description=(
            "Interactively confirm an all-device Relay Credential reset. The "
            "credential is generated and persisted on this host, never shown, "
            "then the Hermes gateway is restarted and both old rejection and "
            "replacement acceptance are proved before success is reported."
        ),
    )
    uninstall_parser = subs.add_parser(
        "uninstall",
        help="Fully remove OcuClaw while preserving shared Hermes sessions",
        description=(
            "Remove OcuClaw code, setup, exact configuration and secret keys, "
            "pairing state, and first-run state. Shared Hermes sessions and "
            "unrecognised files are preserved. A verified live Managed Serve "
            "Route must be removed with the printed narrow command first."
        ),
    )
    uninstall_parser.add_argument(
        "--yes",
        action="store_true",
        dest="assume_yes",
        help="Confirm the deliberate full uninstall without an interactive prompt",
    )
    uninstall_parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Emit the uninstall receipt as JSON",
    )
    pair_parser.add_argument(
        "--light-terminal",
        action="store_true",
        help="Render the QR for a light-background terminal instead of a dark one",
    )
    pair_parser.add_argument(
        "--show-payload-text",
        action="store_true",
        help=(
            "Also print the exact text the code encodes, for a terminal that "
            "cannot render block characters (a screen reader, a pipe, a log). "
            "It carries the same public fields as the code itself."
        ),
    )


def dispatch(args: argparse.Namespace) -> int:
    """Hermes calls this with the parsed namespace; the return value is the rc."""
    command = getattr(args, "ocuclaw_command", None) or "status"
    if command == "pair":
        # Imported lazily, like `_default_facts`, so wiring the subparser does
        # not drag the pairing surface into every `hermes` invocation.
        from .pairing import run_pair

        return run_pair(
            str(getattr(args, "address", "") or ""),
            light_terminal=bool(getattr(args, "light_terminal", False)),
            show_payload_text=bool(getattr(args, "show_payload_text", False)),
        )
    if command == "reset-relay-credential":
        from .pairing import run_reset_relay_credential

        return run_reset_relay_credential()
    if command == "uninstall":
        from .uninstall import run_uninstall

        return run_uninstall(
            assume_yes=bool(getattr(args, "assume_yes", False)),
            json_output=bool(getattr(args, "json_output", False)),
        )
    return run(command, json_output=bool(getattr(args, "json_output", False)))


def register_cli_commands(ctx: Any, logger: Any) -> bool:
    """Attach the plugin-owned `hermes ocuclaw` CLI to Hermes.

    Tolerant by design, like the skill and tool registrations beside it: a
    Hermes host without the CLI surface still gets a working platform, and the
    warning says which recovery surface went missing rather than failing the
    whole plugin load.
    """
    register = getattr(ctx, "register_cli_command", None)
    if not callable(register):
        logger.warning(
            "[ocuclaw] ctx.register_cli_command unavailable — "
            "`hermes ocuclaw` is unavailable on this host"
        )
        return False
    try:
        register(
            name=COMMAND_NAME,
            help=COMMAND_HELP,
            setup_fn=register_cli,
            handler_fn=dispatch,
            description=COMMAND_DESCRIPTION,
        )
    except Exception as exc:  # noqa: BLE001 - keep other recovery surfaces
        logger.warning("[ocuclaw] CLI command registration failed: %s", exc)
        return False
    return True
