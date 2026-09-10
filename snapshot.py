"""Connection Health Snapshot v1 — the pure derivation half (#1317).

This module is the **derive** side of the collect/derive split mandated by
#1273 P1. It holds no I/O, imports nothing from Hermes, and touches no
adapter state: it maps one frozen facts dict to one snapshot v1 document.
That makes every presenter — the Setup Assistant, `status`/`doctor` (human
and `--json`), the recovery dashboard backend, the support attachment —
testable by feeding fixture facts through :func:`derive_snapshot` and
asserting the rendered result (test seam 1).

Three rules hold this module's shape:

1. **The facts key set is frozen** (:data:`FACTS_KEYS_V1`). ``derive_snapshot``
   refuses a facts dict with a missing or unknown key, so the collector and
   the deriver cannot drift apart silently — adding a fact is a deliberate
   edit here, in the same commit as the collector change.
2. **The snapshot key set is frozen** (:data:`SNAPSHOT_KEY_SET_V1`). Every
   derived document is checked against it before it is returned, so a field
   can never be added, renamed, or dropped without the contract version
   moving with it (#1273 §12).
3. **Secret-freedom is structural, not filtered.** No fact value is ever
   copied into free text. Human-readable strings come from the static
   catalogue in this module; the only fact-derived strings that survive
   into the document are passed through an allowlist sanitizer
   (:func:`_sanitize_token`) that keeps a bounded charset. There is
   therefore no redaction step to forget: a secret has no path into the
   output even if a collector puts one in a facts slot.

Three truths stay independent (#1273 §1): durable ``setup``, point-in-time
``currentHealth`` over four legs, and durable ``firstRunProof``. A truthful
result is therefore allowed to read "configured, currently unhealthy at the
phone leg, previously proven on G2".
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

# -- contract identity --------------------------------------------------------

SNAPSHOT_CONTRACT = "ocuclaw.connection-health-snapshot"
SNAPSHOT_CONTRACT_VERSION = 1
ERROR_CONTRACT = "ocuclaw.connection-health-error"
ERROR_CONTRACT_VERSION = 1

# Setup-tool wrapper (#1273 §11). The wrapper is not the snapshot; consumers
# other than `ocuclaw_setup` read the snapshot itself.
SETUP_TOOL_RECEIPT_CONTRACT = "ocuclaw.setup-tool-receipt"
SETUP_TOOL_RECEIPT_VERSION = 1

# -- state vocabularies -------------------------------------------------------

HEALTH_HEALTHY = "healthy"
HEALTH_UNHEALTHY = "unhealthy"
HEALTH_UNKNOWN = "unknown"
HEALTH_STATES = (HEALTH_HEALTHY, HEALTH_UNHEALTHY, HEALTH_UNKNOWN)

# Precedence, highest first (#1273 §2). Several conditions may coexist; the
# rendered state is the first one that matches in this order.
SETUP_STATE_PRECEDENCE = (
    "unsupported",
    "unknown",
    "invalid",
    "unavailable",
    "incomplete",
    "configured",
)

TRISTATE_YES = "yes"
TRISTATE_NO = "no"
TRISTATE_UNKNOWN = "unknown"
TRISTATES = (TRISTATE_YES, TRISTATE_NO, TRISTATE_UNKNOWN)

SERVE_CLASSIFICATIONS = ("ready", "absent", "wrong", "unknown")

PROOF_PROVEN = "proven"
PROOF_NOT_PROVEN = "notProven"
PROOF_UNKNOWN = "unknown"
PROOF_METHOD = "phone-origin-g2-wearer-confirmed"

FRESHNESS_FRESH = "fresh"
FRESHNESS_HISTORICAL = "historical"
FRESHNESS_REJECTED = "rejected"

OBSERVATION_PASSIVE = "passive"
OBSERVATION_ACTIVE = "active"

LEG_HERMES_GATEWAY = "hermesGateway"
LEG_OCUCLAW_RELAY = "ocuclawRelay"
LEG_TAILNET_ROUTE = "tailnetRoute"
LEG_PHONE_APP = "phoneApp"
LEG_NAMES = (
    LEG_HERMES_GATEWAY,
    LEG_OCUCLAW_RELAY,
    LEG_TAILNET_ROUTE,
    LEG_PHONE_APP,
)

# -- source-specific freshness (#1273 §4) -------------------------------------

# The OcuClaw app-presence receipt writes on health-affecting transitions,
# every 30 seconds, and on clean shutdown; it expires after 120 seconds. This
# TTL applies ONLY to the OcuClaw-owned receipt (#1273 P4) — it is never
# reapplied to Hermes's own adapter transition, which does not expire while
# the gateway process that recorded it stays independently live.
APP_PRESENCE_TTL_S = 120.0
APP_PRESENCE_WRITE_INTERVAL_S = 30.0
# Doctor's bounded reachability/application evidence is fresh for 60 seconds.
ACTIVE_PROBE_TTL_S = 60.0

# -- evidence ids -------------------------------------------------------------

EVIDENCE_IN_PROCESS_LINK = "in-process-link"
EVIDENCE_GATEWAY_RECEIPT = "hermes-gateway-receipt"
EVIDENCE_APP_PRESENCE = "ocuclaw-app-presence"
EVIDENCE_TAILNET_SERVE = "tailnet-serve"
EVIDENCE_TAILNET_PROBE = "tailnet-probe"
EVIDENCE_FIRST_RUN_PROOF = "ocuclaw-first-run-proof"
EVIDENCE_HERMES_SOURCE_STATE = "hermes-source-state"
EVIDENCE_HERMES_SOURCE_CERTIFIED = "hermes-source-certified"
EVIDENCE_HERMES_SOURCE_OBSERVED = "hermes-source-observed"
EVIDENCE_HERMES_SOURCE_SHALLOW = "hermes-source-shallow"

HERMES_SOURCE_CERTIFIED = "certified-source"
HERMES_SOURCE_DRIFTED = "drifted"
HERMES_SOURCE_UNKNOWN = "unknown"
HERMES_SOURCE_STATES = (
    HERMES_SOURCE_CERTIFIED,
    HERMES_SOURCE_DRIFTED,
    HERMES_SOURCE_UNKNOWN,
)

#: The only ``observationErrorCode`` values this module will render verbatim.
#: Kept here rather than imported so the deriver stays stdlib-pure; a test
#: pins it against ``receipts.PULL_ERROR_CODES`` so the two cannot drift.
OBSERVATION_ERROR_CODES = (
    "pull_timeout",
    "pull_failed",
    "pull_unsupported",
    "link_down",
    "shutdown",
)


class FactsContractError(ValueError):
    """The facts dict does not match the frozen v1 key set."""


class SnapshotContractError(RuntimeError):
    """A derived snapshot does not match the frozen v1 key set."""


# -- the frozen facts key set -------------------------------------------------

#: The complete, frozen input contract of :func:`derive_snapshot`. Every key
#: is required on every call; no other key is accepted. Grouped by the truth
#: it feeds, and ordered as the collector gathers it.
FACTS_KEYS_V1: Tuple[str, ...] = (
    # -- collection frame -----------------------------------------------
    "observedAt",  # tz-aware ISO-8601 instant collection ran
    "observationMode",  # "passive" | "active"
    # -- exact-profile identity -----------------------------------------
    "profileName",  # resolved profile name, or None
    "hermesHomeFingerprint",  # SHA-256 of the canonical home, or None
    "profileResolved",  # bool: the exact profile resolved safely
    # -- producer identity ----------------------------------------------
    "ocuclawVersion",
    "hermesRelease",
    "hermesPackageVersion",
    "hermesSource",  # provenance receipt; producer renders its three-state label
    "hermesVersionSupported",  # True | False | None
    "supportedHermesRange",
    # -- durable Hermes Setup State --------------------------------------
    "configReadable",  # bool
    "platformExplicitlyDisabled",  # bool
    "pluginEnabled",  # bool
    "relayBindSafe",  # bool: relay still bound to loopback
    "relayPortValid",  # bool
    "evenAiEnabled",  # bool
    "continueHereConfigured",  # bool: allow_admin_from lists the wearer id (#2509)
    # -- agent choice (#2515) ---------------------------------------------
    # The raw, non-secret posture behind the phone's "+" button. Both are
    # read from config.yaml only — never from the process environment — so a
    # GATEWAY_MULTIPLEX_PROFILES override is a disagreement to name, not a
    # value to report. `None` means the key is absent or the config is
    # unreadable.
    "multiplexProfiles",  # bool | None — gateway.multiplex_profiles as written
    "agentMode",  # "multiple" | "single" | None — platforms.ocuclaw.extra.agent_mode
    "secretsPresent",  # mapping[str, bool] — presence booleans ONLY
    "hermesCliOnPath",  # bool
    "nodeRequired",  # bool
    "nodeAvailable",  # bool
    "runtimeAvailable",  # bool
    # -- leg 1: Hermes gateway -------------------------------------------
    "adapterLinkReady",  # bool: in-process link truth (authoritative)
    "gatewayLive",  # True | False | None — independently validated
    "gatewayAdapterState",  # last observed platform state, or None
    "gatewayAdapterEnabled",  # True | False | None (receipt's platform flag)
    "gatewayAdapterObservedAt",  # tz-aware ISO-8601, or None
    "gatewayReceiptUpdatedAt",  # the receipt's own updated_at, or None
    "gatewayReceiptStatus",  # see RECEIPT_STATUSES
    # -- leg 2+4: OcuClaw app-presence receipt ---------------------------
    "appPresenceRecord",  # the v2 receipt body, or None
    "appPresenceStatus",  # see RECEIPT_STATUSES
    "appPresenceWriterLive",  # True | False | None — PID/start-time guard
    # -- leg 3: tailnet route --------------------------------------------
    "serveClassification",  # ready | absent | wrong | unknown
    "serveConfigured",  # yes | no | unknown
    "serveReachable",  # yes | no | unknown
    "serveApplicationReady",  # yes | no | unknown
    # Two sources, two stamps, two TTLs (#1273 §4). Configuration shape is
    # read during collection; reachability/application readiness come from
    # doctor's bounded probe and expire in 60s. One stamp for both would
    # either expire live config or let an expired probe keep voting.
    "serveObservedAt",  # config shape, observed during collection
    "serveProbedAt",  # bounded active probe, or None when never probed
    # Route identity and diagnosis (#1319). These feed the bounded probe, the
    # exact substituted apply command, and the phone address — none of which
    # is part of the derived document.
    #
    # `serveNodeDnsName` is this host's private route authority. It lives in
    # the facts dict because the probe needs a target and the address needs a
    # host, and it reaches the derived document through no path at all: the
    # frozen snapshot key set has no address field, so a presenter that wants
    # the address must go to the facts for it, on a surface sanctioned to
    # render one. That is the structural half of the Q8 boundary.
    "serveNodeDnsName",  # normalised tailnet DNS name, or None
    "serveRelayPort",  # loopback port the route must forward to, or None
    "serveReason",  # stable classifier reason code, or None
    "serveReadCode",  # why the bounded CLI read observed what it did, or None
    # The TLS preconditions behind the route (#2672). A tailnet with HTTPS
    # Certificates turned off applies the Serve route, classifies it `ready`,
    # and then fails every connection through it in a TLS alert, so both of
    # these describe the route's certificate, not its shape, and both come
    # from doctor's active lane rather than from passive collection.
    "serveTlsCertAvailable",  # yes | no | unknown
    "serveFrontDoorTlsError",  # bool: this run's front-door probe hit a TLS alert
    # -- durable Hermes First-Run Proof ----------------------------------
    # The completion journey that WRITES this record is #1322; v1 carries the
    # key set now so the schema does not move when the writer lands.
    "firstRunProofRecord",  # the durable proof record, or None
    "firstRunProofStatus",  # see RECEIPT_STATUSES
)

FACTS_KEY_SET_V1 = frozenset(FACTS_KEYS_V1)

#: How a receipt-shaped source resolved. Only ``ok`` admits its content.
RECEIPT_STATUSES = (
    "ok",
    "missing",
    "unreadable",
    "wrong_profile",
    "unsupported_schema",
)

# -- the frozen snapshot key set ----------------------------------------------

SNAPSHOT_KEY_SET_V1 = frozenset(
    {
        "contract",
        "contractVersion",
        "generatedAt",
        "observationMode",
        "profile",
        "producer",
        "setup",
        "currentHealth",
        "firstRunProof",
        "findings",
        "evidence",
    }
)
PROFILE_KEY_SET_V1 = frozenset({"name", "hermesHomeFingerprint"})
PRODUCER_KEY_SET_V1 = frozenset(
    {"ocuclawVersion", "hermesRelease", "hermesPackageVersion", "hermesSource"}
)
SETUP_KEY_SET_V1 = frozenset(
    {
        "state",
        "hermesVersionSupported",
        "supportedHermesRange",
        "hermesCliOnPath",
        "pluginEnabled",
        "platformEnabled",
        "nodeRequired",
        "nodeAvailable",
        "runtimeAvailable",
        "secretsPresent",
    }
)
CURRENT_HEALTH_KEY_SET_V1 = frozenset({"state", "legs"})
GATEWAY_LEG_KEY_SET_V1 = frozenset(
    {"state", "observedFrom", "lastTransitionAt", "evidenceIds"}
)
RELAY_LEG_KEY_SET_V1 = frozenset({"state", "listening", "evidenceIds"})
TAILNET_LEG_KEY_SET_V1 = frozenset(
    {
        "state",
        "classification",
        "configured",
        "reachable",
        "applicationReady",
        "evidenceIds",
    }
)
PHONE_LEG_KEY_SET_V1 = frozenset(
    {
        "state",
        "authenticatedAppCount",
        "clientVersions",
        "lastTransitionAt",
        "evidenceIds",
    }
)
FIRST_RUN_PROOF_KEY_SET_V1 = frozenset(
    {
        "state",
        "provenAt",
        "method",
        "profileFingerprint",
        "hermesRelease",
        "hermesPackageVersion",
        "ocuclawVersion",
    }
)
FINDING_KEY_SET_V1 = frozenset(
    {"code", "scope", "severity", "summary", "evidenceIds", "repair"}
)
EVIDENCE_KEY_SET_V1 = frozenset(
    {"id", "source", "observedAt", "freshness", "resultCode"}
)

_LEG_KEY_SETS = {
    LEG_HERMES_GATEWAY: GATEWAY_LEG_KEY_SET_V1,
    LEG_OCUCLAW_RELAY: RELAY_LEG_KEY_SET_V1,
    LEG_TAILNET_ROUTE: TAILNET_LEG_KEY_SET_V1,
    LEG_PHONE_APP: PHONE_LEG_KEY_SET_V1,
}

# -- finding catalogue --------------------------------------------------------
#
# Summaries are static text. Nothing derived from a fact value is interpolated
# into them, which is what makes secret-freedom structural rather than filtered.

_FINDINGS: Dict[str, Tuple[str, str, str, Optional[str]]] = {
    # code: (scope, severity, summary, repair code)
    "config_unreadable": (
        "setup",
        "error",
        "Hermes configuration could not be read safely.",
        "read_hermes_config",
    ),
    "platform_disabled": (
        "setup",
        "error",
        "The OcuClaw platform is explicitly disabled.",
        "enable_ocuclaw_platform",
    ),
    "unsafe_relay_bind": (
        "setup",
        "error",
        "The OcuClaw relay must remain bound to 127.0.0.1.",
        "restore_loopback_relay_bind",
    ),
    "invalid_relay_port": (
        "setup",
        "error",
        "The configured relay port must be between 1 and 65535.",
        "set_valid_relay_port",
    ),
    "even_ai_token_missing": (
        "setup",
        "warning",
        "Even AI is enabled but its secret is not configured.",
        "configure_even_ai_secret",
    ),
    "continue_here_not_configured": (
        "setup",
        "warning",
        "Continue here (adopting a Desktop, CLI or TUI chat onto the glasses) "
        "is off: platforms.ocuclaw.extra.allow_admin_from does not list "
        "ocuclaw-wearer.",
        "configure_continue_here",
    ),
    "node_unavailable": (
        "setup",
        "error",
        "Node.js is unavailable.",
        "install_node",
    ),
    "runtime_unavailable": (
        "setup",
        "error",
        "The packaged OcuClaw runtime entry is unavailable.",
        "reinstall_ocuclaw_bundle",
    ),
    "relay_token_missing": (
        "setup",
        "error",
        "The relay secret is not configured.",
        "run_setup_assistant",
    ),
    "hermes_unsupported": (
        "setup",
        "error",
        "This Hermes host is outside the supported OcuClaw contract. "
        "Use Hermes 0.21.x (recommended release v2026.8.31 / engine 0.21.0), "
        "then restart and run hermes ocuclaw doctor --json. "
        "Do not force-load this bundle on older or 0.22+ engines.",
        "install_supported_hermes",
    ),
    "profile_unresolved": (
        "setup",
        "error",
        "The exact Hermes profile could not be resolved safely.",
        "name_target_profile",
    ),
    "gateway_not_running": (
        LEG_HERMES_GATEWAY,
        "error",
        "The Hermes gateway for this profile is not running.",
        "start_hermes_gateway",
    ),
    "gateway_adapter_disconnected": (
        LEG_HERMES_GATEWAY,
        "error",
        "The live Hermes gateway reports the OcuClaw adapter disconnected.",
        "restart_hermes_gateway",
    ),
    "relay_not_listening": (
        LEG_OCUCLAW_RELAY,
        "error",
        "The OcuClaw relay is not listening.",
        "restart_hermes_gateway",
    ),
    "tailnet_route_absent": (
        LEG_TAILNET_ROUTE,
        "error",
        "No OcuClaw Tailscale Serve route is configured for this host.",
        "apply_serve_route",
    ),
    "tailnet_route_wrong": (
        LEG_TAILNET_ROUTE,
        "error",
        "The configured Tailscale Serve route does not match OcuClaw's.",
        "apply_serve_route",
    ),
    "tailnet_route_unreachable": (
        LEG_TAILNET_ROUTE,
        "error",
        "The configured tailnet route did not answer a bounded probe.",
        "check_tailscale_route",
    ),
    "tailnet_tls_certs_unavailable": (
        LEG_TAILNET_ROUTE,
        "error",
        "This tailnet cannot issue the TLS certificate the OcuClaw Serve "
        "route needs.",
        "enable_tailnet_https_certs",
    ),
    "tailnet_route_tls_error": (
        LEG_TAILNET_ROUTE,
        "error",
        "The configured tailnet route refused the TLS handshake.",
        "enable_tailnet_https_certs",
    ),
    "phone_app_absent": (
        LEG_PHONE_APP,
        "error",
        "No authenticated phone app is connected.",
        "pair_phone_app",
    ),
    "phone_evidence_unknown": (
        LEG_PHONE_APP,
        "info",
        "Phone-app evidence is unavailable, so its state is unknown.",
        None,
    ),
    "evidence_wrong_profile": (
        "evidence",
        "warning",
        "A record belonging to another profile was rejected.",
        None,
    ),
    "evidence_unsupported_schema": (
        "evidence",
        "warning",
        "A record with an unsupported schema version was rejected.",
        None,
    ),
}

# -- small helpers ------------------------------------------------------------

_TOKEN_RE = re.compile(r"[^A-Za-z0-9._+\-]")
# A version RANGE legitimately carries comparison operators and a comma; a
# separate, still-bounded allowlist keeps ">=0.21.0,<0.22.0" readable without
# widening the charset that producer/profile identity strings pass through.
_RANGE_RE = re.compile(r"[^A-Za-z0-9._+\-<>=!~^,* ]")
_TOKEN_MAX_CHARS = 40
_CLIENT_VERSION_MAX = 8


def _sanitize_token(value: Any, *, max_chars: int = _TOKEN_MAX_CHARS) -> Optional[str]:
    """Reduce a fact-supplied string to a bounded, allowlisted token.

    Characters outside ``[A-Za-z0-9._+-]`` are dropped rather than replaced,
    and the result is length-capped. Any credential-shaped value therefore
    arrives mangled and truncated rather than rendered — this is the
    structural half of the secret-free invariant, not a redaction pass.
    """
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    cleaned = _TOKEN_RE.sub("", text).strip("._+-")
    if not cleaned:
        return None
    return cleaned[:max_chars]


def _sanitize_range(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    cleaned = _RANGE_RE.sub("", text).strip()
    return cleaned[:48] or None


def _sanitize_client_versions(value: Any) -> List[str]:
    """Bounded, sanitized, deduplicated, sorted client versions (#1273 §6)."""
    if not isinstance(value, (list, tuple)):
        return []
    seen = set()
    for item in value:
        token = _sanitize_token(item, max_chars=32)
        if token:
            seen.add(token)
    return sorted(seen)[:_CLIENT_VERSION_MAX]


def parse_timestamp(value: Any) -> Optional[datetime]:
    """Parse a **timezone-aware** ISO-8601 instant, else ``None``.

    A naive timestamp is rejected rather than assumed to be UTC: freshness is
    a claim about elapsed real time, and a timestamp with no zone cannot
    support that claim on a host whose clock is not UTC. Rejecting it renders
    ``unknown`` — never a negative claim built on a guess.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.tzinfo.utcoffset(parsed) is None:
        return None
    return parsed


def _valid_timestamp(value: Any) -> Optional[str]:
    """Echo a fact-supplied timestamp only if it really is one.

    Every timestamp in the snapshot comes from a cross-process file this
    module does not write. Admitting one because it is a `str` would let a
    malformed or hostile receipt put arbitrary text — a path, an error
    message, a token — straight into a support attachment through a field
    nobody thinks of as free-form. Parsing is the validation.
    """
    return value if parse_timestamp(value) is not None else None


def _age_s(observed_at: Any, now: Optional[datetime]) -> Optional[float]:
    parsed = parse_timestamp(observed_at)
    if parsed is None or now is None:
        return None
    return (now - parsed).total_seconds()


def _freshness(observed_at: Any, now: Optional[datetime], ttl_s: float) -> str:
    """Fresh only inside the source's own TTL; unparseable is rejected."""
    age = _age_s(observed_at, now)
    if age is None:
        return FRESHNESS_REJECTED
    # A timestamp from the future is clock skew, not freshness evidence.
    if age < -ttl_s:
        return FRESHNESS_REJECTED
    return FRESHNESS_FRESH if age <= ttl_s else FRESHNESS_HISTORICAL


def _tristate(value: Any) -> str:
    return value if value in TRISTATES else TRISTATE_UNKNOWN


def now_iso() -> str:
    """The house clock: a timezone-aware ISO-8601 instant."""
    return datetime.now(timezone.utc).isoformat()


def blank_facts(**overrides: Any) -> Dict[str, Any]:
    """A complete facts dict of neutral values, for fixtures and collectors.

    Every frozen key is present, so a caller supplies only what its scenario
    is actually about. Neutral means "nothing observed": unknown tristates,
    absent records, and False capability booleans.
    """
    facts: Dict[str, Any] = {
        "observedAt": now_iso(),
        "observationMode": OBSERVATION_PASSIVE,
        "profileName": None,
        "hermesHomeFingerprint": None,
        "profileResolved": False,
        "ocuclawVersion": None,
        "hermesRelease": None,
        "hermesPackageVersion": None,
        "hermesSource": None,
        "hermesVersionSupported": None,
        "supportedHermesRange": None,
        "configReadable": False,
        "platformExplicitlyDisabled": False,
        "pluginEnabled": False,
        "relayBindSafe": True,
        "relayPortValid": True,
        "evenAiEnabled": False,
        "continueHereConfigured": False,
        "multiplexProfiles": None,
        "agentMode": None,
        "secretsPresent": {},
        "hermesCliOnPath": False,
        "nodeRequired": True,
        "nodeAvailable": False,
        "runtimeAvailable": False,
        "adapterLinkReady": False,
        "gatewayLive": None,
        "gatewayAdapterState": None,
        "gatewayAdapterEnabled": None,
        "gatewayAdapterObservedAt": None,
        "gatewayReceiptUpdatedAt": None,
        "gatewayReceiptStatus": "missing",
        "appPresenceRecord": None,
        "appPresenceStatus": "missing",
        "appPresenceWriterLive": None,
        "serveClassification": TRISTATE_UNKNOWN,
        "serveConfigured": TRISTATE_UNKNOWN,
        "serveReachable": TRISTATE_UNKNOWN,
        "serveApplicationReady": TRISTATE_UNKNOWN,
        "serveObservedAt": None,
        "serveProbedAt": None,
        "serveNodeDnsName": None,
        "serveRelayPort": None,
        "serveReason": None,
        "serveReadCode": None,
        "serveTlsCertAvailable": TRISTATE_UNKNOWN,
        "serveFrontDoorTlsError": False,
        "firstRunProofRecord": None,
        "firstRunProofStatus": "missing",
    }
    unknown = set(overrides) - FACTS_KEY_SET_V1
    if unknown:
        raise FactsContractError(
            "unknown facts key(s) for snapshot v1: " + ", ".join(sorted(unknown))
        )
    facts.update(overrides)
    return facts


def validate_facts(facts: Mapping[str, Any]) -> None:
    """Hold the frozen facts contract. Raises :class:`FactsContractError`."""
    keys = set(facts)
    missing = FACTS_KEY_SET_V1 - keys
    unknown = keys - FACTS_KEY_SET_V1
    if missing or unknown:
        parts = []
        if missing:
            parts.append("missing: " + ", ".join(sorted(missing)))
        if unknown:
            parts.append("unknown: " + ", ".join(sorted(unknown)))
        raise FactsContractError(
            "facts dict does not match the frozen snapshot v1 key set ("
            + "; ".join(parts)
            + ")"
        )


def _check_keys(where: str, obj: Any, expected: frozenset) -> None:
    if not isinstance(obj, dict) or set(obj) != expected:
        got = sorted(obj) if isinstance(obj, dict) else type(obj).__name__
        raise SnapshotContractError(
            f"snapshot v1 key set drift at {where}: expected "
            f"{sorted(expected)}, got {got}"
        )


def validate_snapshot_key_set(snapshot: Any) -> None:
    """Hold the frozen v1 JSON key set over a derived snapshot.

    Called on every derivation. A field cannot be added, renamed, or removed
    without this failing — which is the point: #1273 §12 makes any such change
    a ``contractVersion`` move, and a frozen key set is how that rule is
    enforced rather than merely written down.
    """
    _check_keys("<root>", snapshot, SNAPSHOT_KEY_SET_V1)
    _check_keys("profile", snapshot["profile"], PROFILE_KEY_SET_V1)
    _check_keys("producer", snapshot["producer"], PRODUCER_KEY_SET_V1)
    _check_keys("setup", snapshot["setup"], SETUP_KEY_SET_V1)
    _check_keys("currentHealth", snapshot["currentHealth"], CURRENT_HEALTH_KEY_SET_V1)
    legs = snapshot["currentHealth"]["legs"]
    if not isinstance(legs, dict) or set(legs) != set(LEG_NAMES):
        raise SnapshotContractError(
            "snapshot v1 must carry exactly the four legs " f"{list(LEG_NAMES)}"
        )
    for name, key_set in _LEG_KEY_SETS.items():
        _check_keys(f"currentHealth.legs.{name}", legs[name], key_set)
    _check_keys("firstRunProof", snapshot["firstRunProof"], FIRST_RUN_PROOF_KEY_SET_V1)
    for index, finding in enumerate(snapshot["findings"]):
        _check_keys(f"findings[{index}]", finding, FINDING_KEY_SET_V1)
    for index, item in enumerate(snapshot["evidence"]):
        _check_keys(f"evidence[{index}]", item, EVIDENCE_KEY_SET_V1)


# -- derivation ---------------------------------------------------------------


class _Builder:
    """Accumulates evidence and findings while the legs are derived."""

    def __init__(self) -> None:
        self.evidence: List[Dict[str, Any]] = []
        self.findings: List[Dict[str, Any]] = []
        self._codes: set = set()

    def evidence_entry(
        self,
        evidence_id: str,
        source: str,
        observed_at: Any,
        freshness: str,
        result_code: str,
    ) -> str:
        self.evidence.append(
            {
                "id": evidence_id,
                "source": source,
                "observedAt": _valid_timestamp(observed_at),
                "freshness": freshness,
                "resultCode": result_code,
            }
        )
        return evidence_id

    def finding(
        self,
        code: str,
        evidence_ids: Optional[List[str]] = None,
        repair_parameters: Optional[Dict[str, Any]] = None,
    ) -> None:
        if code in self._codes:
            return
        scope, severity, summary, repair_code = _FINDINGS[code]
        self._codes.add(code)
        self.findings.append(
            {
                "code": code,
                "scope": scope,
                "severity": severity,
                "summary": summary,
                "evidenceIds": list(evidence_ids or []),
                "repair": (
                    None
                    if repair_code is None
                    else {
                        "code": repair_code,
                        "parameters": dict(repair_parameters or {}),
                    }
                ),
            }
        )


def _derive_setup(facts: Mapping[str, Any], out: _Builder) -> Dict[str, Any]:
    supported = facts["hermesVersionSupported"]
    secrets = facts["secretsPresent"]
    secrets_present = {
        str(key): bool(value)
        for key, value in (secrets.items() if isinstance(secrets, Mapping) else ())
    }
    relay_token_present = bool(secrets_present.get("relayToken"))
    even_ai_token_present = bool(secrets_present.get("evenAiToken"))

    node_required = bool(facts["nodeRequired"])
    node_available = bool(facts["nodeAvailable"])
    runtime_available = bool(facts["runtimeAvailable"])
    platform_disabled = bool(facts["platformExplicitlyDisabled"])

    if supported is False:
        out.finding("hermes_unsupported")
    if not facts["profileResolved"]:
        out.finding("profile_unresolved")
    if not facts["configReadable"]:
        out.finding("config_unreadable")
    if platform_disabled:
        out.finding("platform_disabled")
    if not facts["relayBindSafe"]:
        out.finding("unsafe_relay_bind")
    if not facts["relayPortValid"]:
        out.finding("invalid_relay_port")
    if facts["evenAiEnabled"] and not even_ai_token_present:
        out.finding("even_ai_token_missing")
    # A readable config that never lists the wearer id is the whole beta
    # population before the #2509 install leg ran; the unreadable case is
    # already `config_unreadable` above.
    if facts["configReadable"] and not facts["continueHereConfigured"]:
        out.finding("continue_here_not_configured")
    if node_required and not node_available:
        out.finding("node_unavailable")
    if not runtime_available:
        out.finding("runtime_unavailable")
    if not relay_token_present:
        out.finding("relay_token_missing")

    # Precedence is applied in exactly the documented order (#1273 §2).
    if supported is False:
        state = "unsupported"
    elif supported is None or not facts["profileResolved"] or not facts["configReadable"]:
        # "the exact-profile configuration cannot be read or resolved safely"
        state = "unknown"
    elif not facts["relayBindSafe"] or not facts["relayPortValid"]:
        # a value exists but is malformed or unsafe
        state = "invalid"
    elif (node_required and not node_available) or not runtime_available:
        # a required runtime dependency cannot run
        state = "unavailable"
    elif platform_disabled or not relay_token_present:
        # a required item is absent or disabled
        state = "incomplete"
    else:
        state = "configured"

    return {
        "state": state,
        "hermesVersionSupported": None if supported is None else bool(supported),
        "supportedHermesRange": _sanitize_range(facts["supportedHermesRange"]),
        "hermesCliOnPath": bool(facts["hermesCliOnPath"]),
        "pluginEnabled": bool(facts["pluginEnabled"]),
        "platformEnabled": not platform_disabled,
        "nodeRequired": node_required,
        "nodeAvailable": node_available,
        "runtimeAvailable": runtime_available,
        # Presence booleans only — never a value, length, prefix, or mask.
        "secretsPresent": secrets_present,
    }


def _derive_hermes_source(facts: Mapping[str, Any], out: _Builder) -> str:
    """Project the cached receipt into producer identity + additive evidence.

    ``hermesSource`` was reserved in the frozen facts and producer key sets by
    #1317.  Detail therefore rides the v1-additive evidence list, not a new
    top-level or producer key.  Every rendered value is selected from a fixed
    vocabulary or a validated hexadecimal short hash.
    """
    raw = facts["hermesSource"]
    receipt = raw if isinstance(raw, Mapping) else {}
    legacy_state = raw if isinstance(raw, str) else None
    state = receipt.get("state", legacy_state)
    if state not in HERMES_SOURCE_STATES:
        state = HERMES_SOURCE_UNKNOWN
    cached_at = receipt.get("cachedAt")
    observed_at = _valid_timestamp(cached_at)
    freshness = FRESHNESS_FRESH if observed_at is not None else FRESHNESS_REJECTED

    def short_hash(value: Any) -> Optional[str]:
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{7,12}", value):
            return None
        return value

    certified = short_hash(receipt.get("certifiedCommitShort"))
    observed = short_hash(receipt.get("observedCommitShort"))
    shallow = receipt.get("shallow")
    out.evidence_entry(
        EVIDENCE_HERMES_SOURCE_STATE,
        "hermes-source",
        observed_at,
        freshness,
        state,
    )
    out.evidence_entry(
        EVIDENCE_HERMES_SOURCE_CERTIFIED,
        "hermes-source",
        observed_at,
        freshness,
        f"commit_{certified}" if certified else "commit_unknown",
    )
    out.evidence_entry(
        EVIDENCE_HERMES_SOURCE_OBSERVED,
        "hermes-source",
        observed_at,
        freshness,
        f"commit_{observed}" if observed else "commit_unknown",
    )
    out.evidence_entry(
        EVIDENCE_HERMES_SOURCE_SHALLOW,
        "hermes-source",
        observed_at,
        freshness,
        "shallow_yes"
        if shallow is True
        else "shallow_no"
        if shallow is False
        else "shallow_unknown",
    )
    return state


def _reject_receipt(out: _Builder, status: str, evidence_id: str, source: str) -> None:
    if status == "wrong_profile":
        out.finding("evidence_wrong_profile", [evidence_id])
    elif status == "unsupported_schema":
        out.finding("evidence_unsupported_schema", [evidence_id])


def _derive_gateway_leg(
    facts: Mapping[str, Any], now: Optional[datetime], out: _Builder
) -> Dict[str, Any]:
    """Leg 1. The live PID/start-time/profile identity owns liveness (#1277).

    An adapter transition carries no TTL while the gateway process that
    recorded it stays independently live; a dead or reused PID makes that
    stored transition historical no matter what it says.
    """
    evidence_ids: List[str] = []
    status = facts["gatewayReceiptStatus"]
    adapter_state = _sanitize_token(facts["gatewayAdapterState"], max_chars=24)
    observed_at = facts["gatewayAdapterObservedAt"]
    live = facts["gatewayLive"]

    if facts["adapterLinkReady"]:
        # The adapter asking about itself is the most direct evidence there
        # is; no file can outrank a live in-process link.
        evidence_ids.append(
            out.evidence_entry(
                EVIDENCE_IN_PROCESS_LINK,
                "adapter",
                facts["observedAt"],
                FRESHNESS_FRESH,
                "link_ready",
            )
        )
        return {
            "state": HEALTH_HEALTHY,
            "observedFrom": "in-process",
            "lastTransitionAt": _valid_timestamp(observed_at),
            "evidenceIds": evidence_ids,
        }

    if status != "ok":
        evidence_ids.append(
            out.evidence_entry(
                EVIDENCE_GATEWAY_RECEIPT,
                "hermes-gateway",
                observed_at,
                FRESHNESS_REJECTED if status != "missing" else FRESHNESS_HISTORICAL,
                f"receipt_{status}",
            )
        )
        _reject_receipt(out, status, EVIDENCE_GATEWAY_RECEIPT, "hermes-gateway")
        return {
            "state": HEALTH_UNKNOWN,
            "observedFrom": None,
            "lastTransitionAt": None,
            "evidenceIds": evidence_ids,
        }

    if live is None:
        state, result_code, freshness = (
            HEALTH_UNKNOWN,
            "gateway_liveness_unknown",
            FRESHNESS_REJECTED,
        )
    elif live is False:
        # The receipt is historical the moment its PID stops validating.
        state, result_code, freshness = (
            HEALTH_UNHEALTHY,
            "gateway_not_running",
            FRESHNESS_HISTORICAL,
        )
    elif adapter_state == "connected":
        state, result_code, freshness = (
            HEALTH_HEALTHY,
            "adapter_connected",
            FRESHNESS_FRESH,
        )
    elif adapter_state in {"disconnected", "fatal", "error"}:
        # #1277 rule 4: a retained `disconnected` for a platform this host is
        # not configured for is history, not an active failure.
        #
        # "Configured" is a CONFIG question, and the config is what answers
        # it. Hermes's runtime-status writer does not put an `enabled` flag in
        # its platform payload at all, so keying this on the receipt alone
        # would leave the qualifier permanently unknown and silently suppress
        # every genuine adapter disconnect. The receipt's flag is honoured
        # when a future writer does emit it; otherwise the local platform
        # config decides.
        receipt_enabled = facts["gatewayAdapterEnabled"]
        configured_here = (
            receipt_enabled
            if isinstance(receipt_enabled, bool)
            else not facts["platformExplicitlyDisabled"]
        )
        if not configured_here:
            state, result_code, freshness = (
                HEALTH_UNKNOWN,
                "platform_not_configured",
                FRESHNESS_HISTORICAL,
            )
        else:
            state, result_code, freshness = (
                HEALTH_UNHEALTHY,
                "adapter_disconnected",
                FRESHNESS_FRESH,
            )
    elif adapter_state is None:
        state, result_code, freshness = (
            HEALTH_UNKNOWN,
            "platform_state_absent",
            FRESHNESS_FRESH,
        )
    else:
        # starting / connecting / anything transitional
        state, result_code, freshness = (
            HEALTH_UNKNOWN,
            "adapter_transitional",
            FRESHNESS_FRESH,
        )

    evidence_ids.append(
        out.evidence_entry(
            EVIDENCE_GATEWAY_RECEIPT,
            "hermes-gateway",
            observed_at,
            freshness,
            result_code,
        )
    )
    if state == HEALTH_UNHEALTHY:
        out.finding(
            "gateway_not_running"
            if result_code == "gateway_not_running"
            else "gateway_adapter_disconnected",
            evidence_ids,
        )
    return {
        "state": state,
        "observedFrom": "gateway-runtime-status",
        "lastTransitionAt": _valid_timestamp(observed_at),
        "evidenceIds": evidence_ids,
    }


def _app_presence_view(
    facts: Mapping[str, Any], now: Optional[datetime], out: _Builder
) -> Tuple[Optional[Mapping[str, Any]], str, List[str]]:
    """Resolve the OcuClaw app-presence receipt to (record, freshness, ids)."""
    status = facts["appPresenceStatus"]
    record = facts["appPresenceRecord"]
    if status != "ok" or not isinstance(record, Mapping):
        evidence_id = out.evidence_entry(
            EVIDENCE_APP_PRESENCE,
            "ocuclaw-relay",
            None,
            FRESHNESS_REJECTED if status != "missing" else FRESHNESS_HISTORICAL,
            f"receipt_{status}",
        )
        _reject_receipt(out, status, EVIDENCE_APP_PRESENCE, "ocuclaw-relay")
        return None, FRESHNESS_REJECTED, [evidence_id]

    updated_at = record.get("updated_at")
    freshness = _freshness(updated_at, now, APP_PRESENCE_TTL_S)
    # Result codes are a stable, allowlisted vocabulary — a character-class
    # check is not membership. The receipt is a file another process wrote,
    # so an unrecognised value is reported as exactly that rather than
    # forwarded into public evidence under its own name.
    raw_error = _sanitize_token(record.get("observationErrorCode"), max_chars=48)
    if raw_error is None:
        error_code = None
    elif raw_error in OBSERVATION_ERROR_CODES:
        error_code = raw_error
    else:
        error_code = "observation_error_unrecognized"
    if facts["appPresenceWriterLive"] is False:
        # P4's PID/start-time guard, applied to the OcuClaw-owned receipt
        # only: a record whose writer is gone (or whose PID was recycled)
        # is history the instant that becomes true, whatever its TTL says.
        freshness = FRESHNESS_HISTORICAL
        error_code = error_code or "writer_not_running"
    evidence_id = out.evidence_entry(
        EVIDENCE_APP_PRESENCE,
        "ocuclaw-relay",
        _valid_timestamp(updated_at),
        freshness,
        error_code or "presence_observed",
    )
    return record, freshness, [evidence_id]


def _derive_relay_leg(
    record: Optional[Mapping[str, Any]],
    freshness: str,
    evidence_ids: List[str],
    gateway_state: str,
    out: _Builder,
) -> Dict[str, Any]:
    """Leg 2. Relay health is only readable through a healthy gateway."""
    listening: Optional[bool] = None
    if record is not None and isinstance(record.get("relayListening"), bool):
        listening = bool(record["relayListening"])

    if gateway_state != HEALTH_HEALTHY or freshness != FRESHNESS_FRESH:
        state = HEALTH_UNKNOWN
    elif listening is True:
        state = HEALTH_HEALTHY
    elif listening is False:
        state = HEALTH_UNHEALTHY
        out.finding("relay_not_listening", evidence_ids)
    else:
        state = HEALTH_UNKNOWN

    return {
        "state": state,
        "listening": listening,
        "evidenceIds": list(evidence_ids),
    }


def _derive_phone_leg(
    record: Optional[Mapping[str, Any]],
    freshness: str,
    evidence_ids: List[str],
    gateway_state: str,
    relay_state: str,
    out: _Builder,
) -> Dict[str, Any]:
    """Leg 4. An absent heartbeat is ``unknown`` — never "no client".

    A stale receipt only proves that nobody wrote recently; it says nothing
    about whether a phone is connected right now. Reading it as zero is the
    exact 30-second post-pairing lie the relay push hop exists to kill, so
    the rule is written here as well as fixed there.
    """
    count: Optional[int] = None
    versions: List[str] = []
    last_transition: Optional[str] = None
    if record is not None:
        raw_count = record.get("authenticatedAppCount")
        if isinstance(raw_count, bool):
            raw_count = None
        if isinstance(raw_count, int) and raw_count >= 0:
            count = raw_count
        versions = _sanitize_client_versions(record.get("clientVersions"))
        raw_transition = record.get("lastTransitionAt")
        if isinstance(raw_transition, str) and parse_timestamp(raw_transition):
            last_transition = raw_transition

    fresh = freshness == FRESHNESS_FRESH
    if fresh and count is not None and count > 0:
        state = HEALTH_HEALTHY
    elif (
        fresh
        and count == 0
        and gateway_state == HEALTH_HEALTHY
        and relay_state == HEALTH_HEALTHY
    ):
        state = HEALTH_UNHEALTHY
        out.finding("phone_app_absent", evidence_ids)
    else:
        state = HEALTH_UNKNOWN
        out.finding("phone_evidence_unknown", evidence_ids)

    if state != HEALTH_HEALTHY and not fresh:
        # Stale evidence must not present a client roster as current truth.
        count = None
        versions = []

    return {
        "state": state,
        "authenticatedAppCount": count,
        "clientVersions": versions,
        "lastTransitionAt": last_transition,
        "evidenceIds": list(evidence_ids),
    }


def _derive_tailnet_leg(
    facts: Mapping[str, Any], now: Optional[datetime], out: _Builder
) -> Dict[str, Any]:
    """Leg 3. Configured is never conflated with working (#1273 §3)."""
    classification = (
        facts["serveClassification"]
        if facts["serveClassification"] in SERVE_CLASSIFICATIONS
        else TRISTATE_UNKNOWN
    )
    configured = _tristate(facts["serveConfigured"])
    reachable = _tristate(facts["serveReachable"])
    application_ready = _tristate(facts["serveApplicationReady"])
    tls_certs = _tristate(facts["serveTlsCertAvailable"])
    tls_handshake_failed = facts["serveFrontDoorTlsError"] is True

    # Configuration shape is observed during collection, so its evidence is
    # fresh when it exists at all and absent otherwise — it carries no TTL.
    observed_at = facts["serveObservedAt"]
    config_observed = isinstance(observed_at, str) and parse_timestamp(observed_at)
    if not config_observed:
        # Nothing looked at the route, so nothing may be claimed about it —
        # including that it is absent.
        classification = TRISTATE_UNKNOWN
        configured = TRISTATE_UNKNOWN

    # The bounded active probe is the part that expires (#1273 §4/§10).
    probed_at = facts["serveProbedAt"]
    probe_freshness = (
        FRESHNESS_REJECTED
        if probed_at is None
        else _freshness(probed_at, now, ACTIVE_PROBE_TTL_S)
    )
    if probe_freshness != FRESHNESS_FRESH:
        # Expired probe evidence stops supporting a claim about *now*. The
        # TLS observations come from the same lane and expire with it.
        reachable = TRISTATE_UNKNOWN
        application_ready = TRISTATE_UNKNOWN
        tls_certs = TRISTATE_UNKNOWN
        tls_handshake_failed = False

    evidence_ids = [
        out.evidence_entry(
            EVIDENCE_TAILNET_SERVE,
            "tailscale-serve",
            _valid_timestamp(observed_at),
            FRESHNESS_FRESH if config_observed else FRESHNESS_REJECTED,
            f"serve_{classification}",
        )
    ]
    if probed_at is not None:
        evidence_ids.append(
            out.evidence_entry(
                EVIDENCE_TAILNET_PROBE,
                "tailnet-probe",
                _valid_timestamp(probed_at),
                probe_freshness,
                f"reachable_{reachable}",
            )
        )

    if configured == TRISTATE_YES and reachable == TRISTATE_YES and application_ready == TRISTATE_YES:
        state = HEALTH_HEALTHY
    elif configured == TRISTATE_NO or classification == "absent":
        state = HEALTH_UNHEALTHY
        out.finding("tailnet_route_absent", evidence_ids)
    elif classification == "wrong":
        state = HEALTH_UNHEALTHY
        out.finding("tailnet_route_wrong", evidence_ids)
    elif reachable == TRISTATE_NO or application_ready == TRISTATE_NO:
        state = HEALTH_UNHEALTHY
        out.finding("tailnet_route_unreachable", evidence_ids)
    elif tls_handshake_failed:
        # A TLS alert is not a refusal, so `reachable` stays unknown, but it
        # is a definite observation that the front door does not work, and
        # leaving the leg unknown over it is what left #2672 with a `ready`
        # route, two non-verdicts, and nothing for the user to act on.
        state = HEALTH_UNHEALTHY
        out.finding("tailnet_route_tls_error", evidence_ids)
    else:
        state = HEALTH_UNKNOWN

    if tls_certs == TRISTATE_NO:
        # Independent of the state above: the route may not be configured at
        # all yet, and this is the reason applying it would not help.
        out.finding("tailnet_tls_certs_unavailable", evidence_ids)

    return {
        "state": state,
        "classification": classification,
        "configured": configured,
        "reachable": reachable,
        "applicationReady": application_ready,
        "evidenceIds": evidence_ids,
    }


def _derive_first_run_proof(
    facts: Mapping[str, Any], out: _Builder
) -> Dict[str, Any]:
    """The durable third truth. Outages never erase it (#1273 §7).

    The record's WRITER is the completion journey (#1322); v1 reads it and
    carries its key set now so the schema does not move when that lands.
    """
    empty = {
        "state": PROOF_NOT_PROVEN,
        "provenAt": None,
        "method": None,
        "profileFingerprint": None,
        "hermesRelease": None,
        "hermesPackageVersion": None,
        "ocuclawVersion": None,
    }
    status = facts["firstRunProofStatus"]
    record = facts["firstRunProofRecord"]

    if status == "missing":
        # Absence means notProven — a definite, true statement.
        return empty
    if status == "wrong_profile":
        # Another profile's proof never applies. This profile has no proof,
        # so notProven is the true claim; the foreign record is rejected as
        # evidence rather than borrowed.
        out.evidence_entry(
            EVIDENCE_FIRST_RUN_PROOF,
            "ocuclaw-first-run-proof",
            None,
            FRESHNESS_REJECTED,
            "receipt_wrong_profile",
        )
        out.finding("evidence_wrong_profile", [EVIDENCE_FIRST_RUN_PROOF])
        return empty
    if status != "ok" or not isinstance(record, Mapping):
        # Unreadable or unsupported means unknown — we cannot say either way.
        out.evidence_entry(
            EVIDENCE_FIRST_RUN_PROOF,
            "ocuclaw-first-run-proof",
            None,
            FRESHNESS_REJECTED,
            f"receipt_{status}",
        )
        if status == "unsupported_schema":
            out.finding("evidence_unsupported_schema", [EVIDENCE_FIRST_RUN_PROOF])
        return {**empty, "state": PROOF_UNKNOWN}

    proven_at = record.get("provenAt")
    if not (isinstance(proven_at, str) and parse_timestamp(proven_at)):
        out.evidence_entry(
            EVIDENCE_FIRST_RUN_PROOF,
            "ocuclaw-first-run-proof",
            None,
            FRESHNESS_REJECTED,
            "proof_timestamp_invalid",
        )
        return {**empty, "state": PROOF_UNKNOWN}

    # Proof never expires: it is recorded with the freshness it was written
    # with, and stays fresh forever by contract (#1273 §4).
    out.evidence_entry(
        EVIDENCE_FIRST_RUN_PROOF,
        "ocuclaw-first-run-proof",
        proven_at,
        FRESHNESS_FRESH,
        "proof_committed",
    )
    return {
        "state": PROOF_PROVEN,
        "provenAt": proven_at,
        "method": PROOF_METHOD,
        "profileFingerprint": _sanitize_token(
            record.get("profileFingerprint"), max_chars=64
        ),
        "hermesRelease": _sanitize_token(record.get("hermesRelease")),
        "hermesPackageVersion": _sanitize_token(record.get("hermesPackageVersion")),
        "ocuclawVersion": _sanitize_token(record.get("ocuclawVersion")),
    }


def aggregate_health(leg_states: Mapping[str, str]) -> str:
    """Mechanical aggregate (#1273 §3). There is no ``degraded``."""
    states = [leg_states[name] for name in LEG_NAMES]
    if all(state == HEALTH_HEALTHY for state in states):
        return HEALTH_HEALTHY
    if any(state == HEALTH_UNHEALTHY for state in states):
        return HEALTH_UNHEALTHY
    return HEALTH_UNKNOWN


def derive_snapshot(facts: Mapping[str, Any]) -> Dict[str, Any]:
    """Map a frozen facts dict to one Connection Health Snapshot v1.

    Pure: no clock, no filesystem, no network, no adapter state. ``facts``
    supplies everything, including ``observedAt`` — which is what makes
    freshness deterministic under test instead of a race against wall time.
    """
    validate_facts(facts)
    now = parse_timestamp(facts["observedAt"])
    out = _Builder()

    setup = _derive_setup(facts, out)
    gateway_leg = _derive_gateway_leg(facts, now, out)
    presence_record, presence_freshness, presence_ids = _app_presence_view(
        facts, now, out
    )
    relay_leg = _derive_relay_leg(
        presence_record, presence_freshness, presence_ids, gateway_leg["state"], out
    )
    tailnet_leg = _derive_tailnet_leg(facts, now, out)
    phone_leg = _derive_phone_leg(
        presence_record,
        presence_freshness,
        presence_ids,
        gateway_leg["state"],
        relay_leg["state"],
        out,
    )
    first_run_proof = _derive_first_run_proof(facts, out)
    hermes_source = _derive_hermes_source(facts, out)

    legs = {
        LEG_HERMES_GATEWAY: gateway_leg,
        LEG_OCUCLAW_RELAY: relay_leg,
        LEG_TAILNET_ROUTE: tailnet_leg,
        LEG_PHONE_APP: phone_leg,
    }
    mode = (
        facts["observationMode"]
        if facts["observationMode"] in (OBSERVATION_PASSIVE, OBSERVATION_ACTIVE)
        else OBSERVATION_PASSIVE
    )

    snapshot = {
        "contract": SNAPSHOT_CONTRACT,
        "contractVersion": SNAPSHOT_CONTRACT_VERSION,
        "generatedAt": facts["observedAt"] if now is not None else None,
        "observationMode": mode,
        "profile": {
            "name": _sanitize_token(facts["profileName"], max_chars=64),
            "hermesHomeFingerprint": _sanitize_token(
                facts["hermesHomeFingerprint"], max_chars=64
            ),
        },
        "producer": {
            "ocuclawVersion": _sanitize_token(facts["ocuclawVersion"]),
            "hermesRelease": _sanitize_token(facts["hermesRelease"]),
            "hermesPackageVersion": _sanitize_token(facts["hermesPackageVersion"]),
            "hermesSource": hermes_source,
        },
        "setup": setup,
        "currentHealth": {
            "state": aggregate_health({k: v["state"] for k, v in legs.items()}),
            "legs": legs,
        },
        "firstRunProof": first_run_proof,
        "findings": out.findings,
        "evidence": out.evidence,
    }
    validate_snapshot_key_set(snapshot)
    return snapshot


# -- transitional legacy presenter --------------------------------------------
#
# `ocuclaw_setup`'s existing `status` block predates the snapshot contract and
# still speaks the old mixed ladder (`missing | configured | connected | ...`),
# in which `connected` is a *setup* state. #1273 §2 retires that ladder and
# §11 removes these fields atomically before launch — but that removal is the
# CLI/surface work (#1318), not this PR.
#
# What this PR does change is where the block gets its facts: it is now
# derived, purely, from the same frozen facts dict the snapshot uses. One
# collector, two derivations. Keeping both in view here is deliberate — the
# contrast is the whole point of the correction below.

_LEGACY_PROBLEM_ORDER = (
    "config_unreadable",
    "platform_disabled",
    "unsafe_relay_bind",
    "invalid_relay_port",
    "even_ai_token_missing",
    "node_unavailable",
    "runtime_unavailable",
    "relay_token_missing",
)

_LEGACY_CONFIG_PROBLEM_CODES = frozenset(
    {
        "config_unreadable",
        "unsafe_relay_bind",
        "invalid_relay_port",
        "even_ai_token_missing",
        "platform_disabled",
    }
)

#: The legacy presenter's own staleness rule for Hermes's gateway receipt.
#: #1277 rule 3 says NOT to age an adapter transition while the gateway that
#: recorded it is independently live, and :func:`derive_snapshot` obeys that.
#: This constant exists only so the transitional block keeps behaving exactly
#: as it did while it lives — the two rules sit here side by side rather than
#: one quietly changing under the other.
LEGACY_GATEWAY_RECEIPT_TTL_S = 120.0


def derive_legacy_setup_status(facts: Mapping[str, Any]) -> Dict[str, Any]:
    """The pre-v1 `ocuclaw_setup` status block, derived purely from facts."""
    validate_facts(facts)
    now = parse_timestamp(facts["observedAt"])
    secrets = facts["secretsPresent"]
    secrets = secrets if isinstance(secrets, Mapping) else {}
    relay_token_present = bool(secrets.get("relayToken"))
    node_required = bool(facts["nodeRequired"])
    node_available = bool(facts["nodeAvailable"])
    runtime_available = bool(facts["runtimeAvailable"])
    platform_disabled = bool(facts["platformExplicitlyDisabled"])
    connected = bool(facts["adapterLinkReady"])

    active: List[str] = []
    if not facts["configReadable"]:
        active.append("config_unreadable")
    if platform_disabled:
        active.append("platform_disabled")
    if not facts["relayBindSafe"]:
        active.append("unsafe_relay_bind")
    if not facts["relayPortValid"]:
        active.append("invalid_relay_port")
    if facts["evenAiEnabled"] and not bool(secrets.get("evenAiToken")):
        active.append("even_ai_token_missing")
    if node_required and not node_available:
        active.append("node_unavailable")
    if not runtime_available:
        active.append("runtime_unavailable")
    if not relay_token_present:
        active.append("relay_token_missing")
    problems = [
        {"code": code, "message": _FINDINGS[code][2]}
        for code in _LEGACY_PROBLEM_ORDER
        if code in active
    ]

    # Legacy gateway projection: the receipt only speaks when it is inside
    # its own TTL *and* its PID validates.
    gateway_state: Optional[str] = None
    gateway_observed_from: Optional[str] = None
    if facts["gatewayReceiptStatus"] == "ok" and facts["gatewayLive"] is True:
        fresh = (
            _freshness(
                facts["gatewayReceiptUpdatedAt"], now, LEGACY_GATEWAY_RECEIPT_TTL_S
            )
            == FRESHNESS_FRESH
        )
        raw_state = facts["gatewayAdapterState"]
        if fresh and isinstance(raw_state, str) and raw_state.strip():
            gateway_state = raw_state.strip()
            gateway_observed_from = "gateway-runtime-status"
    if connected:
        gateway_observed_from = "in-process"

    supported = facts["hermesVersionSupported"]
    if supported is not True:
        state = "unsupported"
    elif (node_required and not node_available) or not runtime_available:
        state = "unavailable"
    elif any(code in _LEGACY_CONFIG_PROBLEM_CODES for code in active):
        state = "invalid"
    elif connected or gateway_state == "connected":
        # A guarded gateway receipt intentionally outranks this process's
        # secret visibility: the gateway may hold a process-scoped token a
        # separate CLI turn cannot observe.
        state = "connected"
    elif not relay_token_present:
        state = "missing"
    else:
        state = "configured"

    return {
        "state": state,
        "hermesVersion": facts["hermesPackageVersion"] or "unknown",
        "supportedRange": facts["supportedHermesRange"],
        "hermesCliOnPath": bool(facts["hermesCliOnPath"]),
        "pluginEnabled": bool(facts["pluginEnabled"]),
        "platformEnabled": not platform_disabled,
        "relayTokenPresent": relay_token_present,
        "sonioxApiKeyPresent": bool(secrets.get("sonioxApiKey")),
        "evenAiTokenPresent": bool(secrets.get("evenAiToken")),
        "nodeAvailable": node_available,
        "nodeRequired": node_required,
        "runtimeAvailable": runtime_available,
        "connected": connected,
        "gatewayPlatformState": gateway_state,
        "gatewayObservedFrom": gateway_observed_from,
        "problems": problems,
    }


def error_envelope(
    code: str, message: str, *, profile: Optional[Mapping[str, Any]] = None
) -> Dict[str, Any]:
    """The versioned machine-error envelope (#1273 §11).

    No stack, raw path, command output, or nested exception is exposed; the
    message is caller-supplied static text and the code is the stable
    identity a script keys off.
    """
    envelope: Dict[str, Any] = {
        "contract": ERROR_CONTRACT,
        "contractVersion": ERROR_CONTRACT_VERSION,
        "generatedAt": now_iso(),
        "code": str(code),
        "message": str(message),
    }
    if profile is not None:
        envelope["profile"] = {
            "name": _sanitize_token(profile.get("name"), max_chars=64),
            "hermesHomeFingerprint": _sanitize_token(
                profile.get("hermesHomeFingerprint"), max_chars=64
            ),
        }
    return envelope
