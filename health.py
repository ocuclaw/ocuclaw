"""Passive Connection Health Snapshot fact collection shared by presenters.

This is the impure half of the existing collect/derive seam.  It lives outside
``adapter.py`` so the optional dashboard can collect the same passive facts
without importing the runtime adapter or coupling its web process to adapter
state.  Collection reads local configuration and the two OcuClaw receipts,
qualifies Hermes's ``gateway_state.json`` through :mod:`receipts`, and performs
only the existing read-only Tailscale configuration classification.  It opens
no network connection and mutates nothing.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Tuple

from . import serve
from .control_link import HERMES_BUNDLE_DEFAULT_WS_BIND, HERMES_BUNDLE_DEFAULT_WS_PORT
from .receipts import (
    fingerprint_home,
    read_app_presence,
    read_first_run_proof,
    read_gateway_state,
    resolve_receipt_home,
)
from .provenance import STATE_CERTIFIED_SOURCE, collect_hermes_source
from .snapshot import OBSERVATION_PASSIVE, TRISTATE_UNKNOWN, blank_facts
from .snapshot import now_iso as snapshot_now_iso

logger = logging.getLogger(__name__)

PLATFORM_NAME = "ocuclaw"
BUNDLE_DIR = Path(__file__).resolve().parent
DEFAULT_RUNTIME_ENTRY = BUNDLE_DIR / "dist-cjs" / "runtime" / "hermes-runtime-entry.cjs"

CERTIFIED_HERMES_VERSION = "0.21.0"
CERTIFIED_HERMES_TAG = "v2026.8.31"
CERTIFIED_HERMES_COMMIT = "29112bef099274229cadff79cdff7bf7b99c4b77"
SUPPORTED_HERMES_MIN = (0, 21, 0)
SUPPORTED_HERMES_MAX_EXCLUSIVE = (0, 22, 0)

# The ONE user id the adapter stamps on every wearer-originated event
# (adapter.py `_build_message_event` → `build_source`). Continue here (#2509)
# needs `platforms.ocuclaw.extra.allow_admin_from` to list exactly this id.
OCUCLAW_WEARER_USER_ID = "ocuclaw-wearer"

OCUCLAW_RELAY_TOKEN_ENV = "OCUCLAW_RELAY_TOKEN"
OCUCLAW_SONIOX_API_KEY_ENV = "OCUCLAW_SONIOX_API_KEY"
OCUCLAW_EVEN_AI_TOKEN_ENV = "OCUCLAW_EVEN_AI_TOKEN"

_SECRET_ENV_TO_KEY = {
    OCUCLAW_RELAY_TOKEN_ENV: "relayToken",
    OCUCLAW_SONIOX_API_KEY_ENV: "sonioxApiKey",
    OCUCLAW_EVEN_AI_TOKEN_ENV: "evenAiToken",
}


def continue_here_configured(extra: Any) -> bool:
    """Whether Hermes will honour the wearer's `/resume <tip> --all` (#2509).

    Reads the platform's ``extra`` block the way Hermes does
    (``gateway.slash_access.policy_from_extra`` — DM scope, the shape every
    wearer event carries): gating must be ENABLED (a non-empty
    ``allow_admin_from``) and the adapter's one fixed user id must be an
    admin. Turning gating on is platform-wide for ocuclaw and safe only
    because that single id is the only one the adapter ever sends. The pure
    fallback mirrors ``_coerce_id_list`` for reads outside a Hermes process
    (setup-status and doctor runs before the gateway imports resolve).
    """
    block = extra if isinstance(extra, Mapping) else {}
    try:
        from gateway.slash_access import policy_from_extra

        policy = policy_from_extra(dict(block), "dm")
        return bool(policy.enabled and policy.is_admin(OCUCLAW_WEARER_USER_ID))
    except Exception:  # noqa: BLE001 - pure fallback below
        pass
    raw = block.get("allow_admin_from")
    if isinstance(raw, str):
        ids = [part.strip() for part in raw.split(",")]
    elif isinstance(raw, (list, tuple, set)):
        ids = [str(part).strip() for part in raw]
    else:
        ids = []
    return OCUCLAW_WEARER_USER_ID in {part for part in ids if part}


def parse_version(raw: str) -> Optional[Tuple[int, int, int]]:
    if not raw:
        return None
    numbers = []
    for part in str(raw).strip().split(".")[:3]:
        digits = ""
        for character in part:
            if not character.isdigit():
                break
            digits += character
        if not digits:
            return None
        numbers.append(int(digits))
    while len(numbers) < 3:
        numbers.append(0)
    return numbers[0], numbers[1], numbers[2]


def hermes_version_supported(raw: str) -> bool:
    parsed = parse_version(raw)
    return bool(parsed is not None and SUPPORTED_HERMES_MIN <= parsed < SUPPORTED_HERMES_MAX_EXCLUSIVE)


def supported_hermes_range() -> str:
    minimum = ".".join(map(str, SUPPORTED_HERMES_MIN))
    maximum = ".".join(map(str, SUPPORTED_HERMES_MAX_EXCLUSIVE))
    return f">={minimum},<{maximum}"


def hermes_version() -> str:
    try:
        from hermes_cli import __version__

        return str(__version__ or "")
    except Exception:  # noqa: BLE001 - diagnostics stay available on ABI drift
        return ""


def find_node() -> Optional[str]:
    try:
        from hermes_constants import find_node_executable

        return find_node_executable("node")
    except Exception:  # noqa: BLE001 - helper is Hermes-version-sensitive
        return shutil.which("node")


def setup_secret_present(env_name: str) -> bool:
    try:
        from hermes_cli.config import get_env_value

        return bool(str(get_env_value(env_name) or "").strip())
    except Exception:  # noqa: BLE001 - presence only, never the value
        return bool(os.environ.get(env_name, "").strip())


def secret_presence_inventory() -> Dict[str, bool]:
    return {
        public_name: setup_secret_present(env_name)
        for env_name, public_name in _SECRET_ENV_TO_KEY.items()
    }


def setup_raw_config() -> Tuple[Dict[str, Any], bool]:
    try:
        from hermes_cli.config import read_raw_config

        config = read_raw_config()
        return (config if isinstance(config, dict) else {}), True
    except Exception:  # noqa: BLE001 - unreadable becomes setup unknown
        return {}, False


def ocuclaw_version() -> Optional[str]:
    try:
        text = (BUNDLE_DIR / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"^version:\s*([^\s#]+)", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def profile_name(home: Optional[Path]) -> Optional[str]:
    if home is None:
        return None
    try:
        return home.name if home.parent.name == "profiles" else "default"
    except (OSError, ValueError):
        return None


def hermes_source(version: str, home: Optional[Path]) -> Dict[str, Any]:
    """Collect the shared advisory provenance receipt for every presenter."""
    return collect_hermes_source(
        version,
        certified_version=CERTIFIED_HERMES_VERSION,
        certified_commit=CERTIFIED_HERMES_COMMIT,
        profile_home=home,
    )


def gateway_facts_from_receipt(
    record: Optional[Mapping[str, Any]], status: str, live: Optional[bool]
) -> Dict[str, Any]:
    facts: Dict[str, Any] = {
        "gatewayLive": None,
        "gatewayAdapterState": None,
        "gatewayAdapterEnabled": None,
        "gatewayAdapterObservedAt": None,
        "gatewayReceiptUpdatedAt": None,
        "gatewayReceiptStatus": "missing",
    }
    facts["gatewayReceiptStatus"] = status
    if status != "ok" or not isinstance(record, Mapping):
        return facts
    updated_at = record.get("updated_at")
    facts["gatewayReceiptUpdatedAt"] = updated_at if isinstance(updated_at, str) else None
    facts["gatewayLive"] = live
    platforms = record.get("platforms")
    platform = platforms.get(PLATFORM_NAME) if isinstance(platforms, Mapping) else None
    if isinstance(platform, Mapping):
        state = platform.get("state")
        if isinstance(state, str) and state.strip():
            facts["gatewayAdapterState"] = state.strip()
        enabled = platform.get("enabled")
        facts["gatewayAdapterEnabled"] = enabled if isinstance(enabled, bool) else None
        observed = platform.get("updated_at")
        facts["gatewayAdapterObservedAt"] = observed if isinstance(observed, str) else None
    return facts


def collect_gateway_facts() -> Dict[str, Any]:
    record, status, live = read_gateway_state()
    return gateway_facts_from_receipt(record, status, live)


def collect_serve_facts(extra: Mapping[str, Any], relay_port_valid: bool) -> Dict[str, Any]:
    relay_port: Optional[int] = None
    if relay_port_valid:
        try:
            relay_port = int(extra.get("wsPort", HERMES_BUNDLE_DEFAULT_WS_PORT))
        except (TypeError, ValueError):
            relay_port = None
    try:
        observed = serve.observe(relay_port=relay_port)
    except Exception:  # noqa: BLE001 - passive diagnosis must stay available
        logger.exception("[ocuclaw] serve classification unavailable")
        return {
            "serveClassification": TRISTATE_UNKNOWN,
            "serveConfigured": TRISTATE_UNKNOWN,
            "serveObservedAt": None,
            "serveNodeDnsName": None,
            "serveRelayPort": relay_port,
            "serveReason": serve.REASON_NOT_READ,
            "serveReadCode": serve.READ_FAILED,
        }
    return {
        "serveClassification": observed.classification,
        "serveConfigured": observed.configured,
        "serveObservedAt": snapshot_now_iso() if observed.read_code == serve.READ_OK else None,
        "serveNodeDnsName": observed.dns_name,
        "serveRelayPort": observed.relay_port,
        "serveReason": observed.reason,
        "serveReadCode": observed.read_code,
    }


def collect_health_facts(
    *,
    observation_mode: str = OBSERVATION_PASSIVE,
    adapters: Iterable[Any] = (),
    setup_raw_config_fn: Callable[[], Tuple[Dict[str, Any], bool]] = setup_raw_config,
    hermes_version_fn: Callable[[], str] = hermes_version,
    supported_fn: Callable[[str], bool] = hermes_version_supported,
    supported_range_fn: Callable[[], str] = supported_hermes_range,
    secret_inventory_fn: Callable[[], Dict[str, bool]] = secret_presence_inventory,
    node_fn: Callable[[], Optional[str]] = find_node,
    ocuclaw_version_fn: Callable[[], Optional[str]] = ocuclaw_version,
    source_fn: Callable[[str, Optional[Path]], Mapping[str, Any]] = hermes_source,
    profile_name_fn: Callable[[Optional[Path]], Optional[str]] = profile_name,
    resolve_home_fn: Callable[[], Optional[Path]] = resolve_receipt_home,
    read_presence_fn: Callable[..., Any] = read_app_presence,
    read_proof_fn: Callable[..., Any] = read_first_run_proof,
    gateway_facts_fn: Callable[[], Dict[str, Any]] = collect_gateway_facts,
    serve_facts_fn: Callable[[Mapping[str, Any], bool], Dict[str, Any]] = collect_serve_facts,
    runtime_entry: Path = DEFAULT_RUNTIME_ENTRY,
) -> Dict[str, Any]:
    """Collect the frozen Snapshot v1 facts dict without adapter imports."""
    raw_config, config_readable = setup_raw_config_fn()
    platforms = raw_config.get("platforms")
    platform_config = platforms.get(PLATFORM_NAME, {}) if isinstance(platforms, dict) else {}
    if not isinstance(platform_config, dict):
        platform_config = {}
    extra = platform_config.get("extra")
    if not isinstance(extra, dict):
        extra = {}

    ws_bind = str(extra.get("wsBind") or HERMES_BUNDLE_DEFAULT_WS_BIND).strip()
    relay_port_valid = True
    if "wsPort" in extra:
        try:
            relay_port_valid = 1 <= int(extra["wsPort"]) <= 65535
        except (TypeError, ValueError):
            relay_port_valid = False

    # Agent choice (#2515): the same two leaves `_setup_status` judges, carried
    # raw so `hermes ocuclaw status` can say WHY the phone's "+" is grey on an
    # install that predates the question. Non-bool / non-string values are
    # reported as absent rather than guessed at.
    gateway_config = raw_config.get("gateway")
    multiplex_raw = gateway_config.get("multiplex_profiles") if isinstance(gateway_config, dict) else None
    multiplex_profiles = multiplex_raw if isinstance(multiplex_raw, bool) else None
    agent_mode_raw = extra.get("agent_mode")
    agent_mode = agent_mode_raw if agent_mode_raw in ("multiple", "single") else None

    plugins = raw_config.get("plugins")
    enabled_plugins = plugins.get("enabled", []) if isinstance(plugins, dict) else []
    uses_default_runtime = not bool(extra.get("runtimeCommand"))
    version = hermes_version_fn()
    home = resolve_home_fn()
    source_receipt = source_fn(version, home)
    fingerprint = fingerprint_home(home)
    presence_record, presence_status, presence_writer_live = read_presence_fn(fingerprint, home=home)
    proof_record, proof_status = read_proof_fn(fingerprint, home=home)

    facts = blank_facts(
        observedAt=snapshot_now_iso(),
        observationMode=observation_mode,
        profileName=profile_name_fn(home),
        hermesHomeFingerprint=fingerprint,
        profileResolved=home is not None,
        ocuclawVersion=ocuclaw_version_fn(),
        hermesRelease=(
            CERTIFIED_HERMES_TAG
            if source_receipt.get("state") == STATE_CERTIFIED_SOURCE
            else None
        ),
        hermesPackageVersion=version or None,
        hermesSource=source_receipt,
        hermesVersionSupported=supported_fn(version),
        supportedHermesRange=supported_range_fn(),
        configReadable=config_readable,
        platformExplicitlyDisabled=platform_config.get("enabled") is False,
        pluginEnabled=isinstance(enabled_plugins, list) and PLATFORM_NAME in enabled_plugins,
        relayBindSafe=ws_bind == HERMES_BUNDLE_DEFAULT_WS_BIND,
        relayPortValid=relay_port_valid,
        evenAiEnabled=bool(extra.get("evenAiEnabled")),
        continueHereConfigured=continue_here_configured(extra),
        multiplexProfiles=multiplex_profiles,
        agentMode=agent_mode,
        secretsPresent=secret_inventory_fn(),
        hermesCliOnPath=shutil.which("hermes") is not None,
        nodeRequired=uses_default_runtime,
        nodeAvailable=node_fn() is not None,
        runtimeAvailable=not uses_default_runtime or runtime_entry.is_file(),
        adapterLinkReady=any(bool(getattr(adapter, "link_ready", False)) for adapter in adapters),
        appPresenceRecord=presence_record,
        appPresenceStatus=presence_status,
        appPresenceWriterLive=presence_writer_live,
        firstRunProofRecord=proof_record,
        firstRunProofStatus=proof_status,
    )
    facts.update(gateway_facts_fn())
    facts.update(serve_facts_fn(extra, relay_port_valid))
    return facts


__all__ = [
    "OCUCLAW_WEARER_USER_ID",
    "continue_here_configured",
    "CERTIFIED_HERMES_COMMIT",
    "CERTIFIED_HERMES_TAG",
    "CERTIFIED_HERMES_VERSION",
    "collect_gateway_facts",
    "collect_health_facts",
    "collect_serve_facts",
    "gateway_facts_from_receipt",
]
