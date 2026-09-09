"""OcuClaw platform plugin for the hermes gateway (ADR-0001/0003, W01 slice).

``register(ctx)`` self-gates on the hermes version (the plugin ABI churns and
there is no declarative pin field), then registers the ``ocuclaw`` platform.
The adapter's ``connect()`` spawns the Node OcuClaw runtime as a child and
completes the NDJSON control-link handshake (``control_link.py``); the W01
vertical slice ends there — message dispatch (``send``) lands with the bridge
work items.

Non-secret config rides the platform block in the hermes ``config.yaml``::

    platforms:
      ocuclaw:
        enabled: true
        extra:
          wsPort: 47801           # relay WS default; Even-AI rides the same server
          wsBind: "127.0.0.1"
          runtimeCommand: []      # argv override (list or string); default is
                                  # node <bundle>/dist-cjs/runtime/hermes-runtime-entry.cjs
          handshakeTimeoutS: 10
          terminateGraceS: 5
          linkDebugStderr: false

The Relay Credential and optional user-supplied secrets are stored in the
Hermes-managed secret env file, ``$HERMES_HOME/.env`` — the served profile's
own home, never a fixed path, because profiles are isolated homes.  This
module never opens that file itself: writes go through Hermes's own
``save_env_value``; reads use the process environment and Hermes's
``get_env_value``.  Initial plugin bootstrap generates the first Relay
Credential on a provably fresh profile without displaying or returning it. A
present Relay Credential is host-managed and can be replaced only by the
locally confirmed all-device reset. The env-enablement bridge maps stored
values onto runtime keys. That env file is the only supported secret source:
no diagnostic, status, or setup surface reads a secret out of
``config.yaml``.

``linkDebugStderr`` is the general child-verbosity gate.  At ``false``, only
child warn/error output reaches stderr; handshake/boot/connect receipts are
suppressed.  At ``true``, all ``console.*`` and ``logger.info``/``logger.debug``
output reaches ``~/.hermes/logs/gateway.log``.  It defaults off because browser
console text is forwarded to the relay and would otherwise land in the durable
log.
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import importlib.util
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Set, Tuple
from urllib.parse import urlsplit, urlunsplit

from .cli import register_cli_commands
from .session_status import SessionStatusObserver
from .control_link import (
    HERMES_BUNDLE_DEFAULT_WS_BIND,
    HERMES_BUNDLE_DEFAULT_WS_PORT,
    LINK_HANDSHAKE_TIMEOUT_S,
    LINK_TERMINATE_GRACE_S,
    LinkError,
    LinkProcess,
    default_child_env,
    resolve_runtime_argv,
)
from .dispatch import (
    BACKEND_EVENT_METHOD,
    BACKEND_HOOK_METHOD,
    DEFAULT_STALE_TURN_SECONDS,
    DISPATCH_METHOD,
    ERROR_TERMINAL_STALE_TURN_SECONDS,
    JANITOR_INTERVAL_SECONDS,
    KIND_SLASH,
    KIND_TURN,
    STATE_ACTIVE,
    DispatchLedger,
    agent_end_hook_frame,
    is_cancelling_slash,
    is_platform_update_command,
    lifecycle_start_activity,
    lifecycle_terminal_activity,
    message_commit_event,
    message_retag_event,
    parse_ocuclaw_session_key,
    normalize_session_reset_command,
    status_activity,
    streaming_event,
    strip_stream_cursor,
    uncorrelated_message_event,
    validate_prompt_metadata,
)
from .first_run import (
    PhoneTurnCandidateGate,
    WELCOME_SURFACE,
    arm_first_run_proof_from_candidate,
    inspect_attempt,
    is_welcome_surface,
    record_phone_turn_candidate,
    record_welcome_outcome,
    wait_for_first_run_terminal,
    wait_for_phone_turn_candidate,
)
from .models_rpc import (
    GwRpc,
    load_profile_routing_snapshot,
    namespace_for_profile,
    profile_for_namespace,
)
from .pairing_completion import record_pairing_completion
from .presence import (
    PRESENCE_DIRTY_METHOD,
    PRESENCE_SNAPSHOT_METHOD,
    PULL_TIMEOUT_S,
    PresenceLinkUnavailableError,
    PresencePump,
)
from .relay_credential import (
    BOOTSTRAP_ESTABLISHED_MISSING,
    BOOTSTRAP_FAILED,
    BOOTSTRAP_MANAGED_MISSING,
    BOOTSTRAP_UNAVAILABLE,
    MANAGED_CREDENTIAL_REQUIRED_MESSAGE,
    bootstrap_relay_credential,
    is_managed_profile,
    is_profile_established,
)
from .receipts import (
    ReceiptUnavailableError,
    fingerprint_home,
    read_app_presence,
    read_first_run_proof,
    read_gateway_state,
    resolve_receipt_home,
    write_app_presence,
)
from .session_rpc import (
    DB_METHOD_CHAT_WATERMARK,
    DEFAULT_SESSION_NAMESPACE,
    OCUCLAW_CHAT_TYPE_SEGMENT,
    OCUCLAW_PLATFORM_SEGMENT,
    NotAdoptableError,
    ProfileSessionRpc,
    default_state_db_path,
    session_read_state_supported,
)
from .stt_rpc import (
    PRE_TRANSCRIPTION_HOOK_NAME,
    SttRpc,
    pre_transcription_hook,
)
from . import desktop_credentials, even_ai_route, serve
from . import health as health_collect
from .health import OCUCLAW_WEARER_USER_ID, continue_here_configured
from .desktop_pairing import (
    THEME_REQUEST_CONFIG_KEY as DESKTOP_THEME_CONFIG_KEY,
    desktop_convergence,
    desktop_convergence_message,
    plugin_owned as desktop_plugin_owned,
    plugin_path as desktop_plugin_path,
    read_desktop_theme_request,
    reconcile_pairing_plugin,
)
from .setup_bootstrap import reconcile_setup_bundle
from .tui_pairing import reconcile_pairing_widget
from .snapshot import (
    OBSERVATION_PASSIVE,
    TRISTATE_UNKNOWN,
    blank_facts,
    derive_legacy_setup_status,
    derive_snapshot,
    error_envelope,
)
from .snapshot import now_iso as snapshot_now_iso

logger = logging.getLogger(__name__)

PLATFORM_NAME = "ocuclaw"
PLATFORM_LABEL = "OcuClaw"
# Levels hermes' own display_config._normalise() keeps for
# display.platforms.<platform>.tool_progress. Anything else is rejected here
# rather than silently coerced to "all" downstream.
TOOL_PROGRESS_LEVELS = frozenset({"off", "new", "all", "verbose", "log"})
PAIRING_COMPLETED_METHOD = "pairing.completed"
# Every successful outcome of `reconcile_pairing_plugin()`. `adopted` is the
# deep-link-modal happy path (#1888): the modal installs the shipped bytes
# verbatim, and the next reconcile claims that pristine copy in place by
# resolving its capability slot. The presenter is fully live afterwards, so
# consumers must read it exactly like created/updated/unchanged. Keep in step
# with desktop_pairing.run_desktop_pairing's own allow-list.
DESKTOP_PLUGIN_RECONCILE_OK = frozenset(
    {"created", "updated", "unchanged", "adopted"}
)
# `reconcile_pairing_widget()` has no adoption path — it renders one owned TUI
# widget file and reports only created/updated/unchanged (plus preserved and
# error), so its allow-list stays three-wide on purpose.
TUI_WIDGET_RECONCILE_OK = frozenset({"created", "updated", "unchanged"})
OCUCLAW_RELAY_TOKEN_ENV = "OCUCLAW_RELAY_TOKEN"
OCUCLAW_SONIOX_API_KEY_ENV = "OCUCLAW_SONIOX_API_KEY"
OCUCLAW_EVEN_AI_TOKEN_ENV = "OCUCLAW_EVEN_AI_TOKEN"
_SECRET_ENV_TO_ADAPTER_KEY = {
    OCUCLAW_RELAY_TOKEN_ENV: "relayToken",
    OCUCLAW_SONIOX_API_KEY_ENV: "sonioxApiKey",
    OCUCLAW_EVEN_AI_TOKEN_ENV: "evenAiToken",
}
# Optional Hermes-native allowlist names declared at platform registration.
# Ordinary OcuClaw turns use the stronger relay-token gate and retain the live
# adapter as transport provenance, so these are not required for multiplexing.
OCUCLAW_ALLOWED_USERS_ENV = "OCUCLAW_ALLOWED_USERS"
OCUCLAW_ALLOW_ALL_USERS_ENV = "OCUCLAW_ALLOW_ALL_USERS"


def _is_hermes_home_channel_onboarding_notice(text: str) -> bool:
    """Keep Hermes's platform setup nudge out of OcuClaw conversations."""
    normalized = str(text or "").strip()
    return (
        normalized.startswith("📬 No home channel is set for Ocuclaw.")
        and "Type /sethome to make this chat your home channel" in normalized
    )


def _gateway_auth_recovery_message(text: str) -> str:
    """Give the native auth-error reply a recovery destination, without OAuth I/O."""
    normalized = str(text or "").strip()
    # Hermes sanitizes errors for plugin chat surfaces before calling send(),
    # so its canonical reply no longer identifies the failing provider. Keep
    # that attribution honest instead of guessing Codex from profile defaults.
    if normalized == (
        "⚠️ Provider authentication failed. Check the configured credentials; "
        "raw provider details are in the gateway logs."
    ):
        return (
            "Provider sign-in needs attention. Reconnect your provider in "
            "Hermes on the gateway host, then retry this message. If agents "
            "share that login, check each affected agent."
        )
    return text

# Hermes-specific config ingress totality for
# platforms.ocuclaw.extra.evenAiRoutingMode. This is the canonical set ONLY:
# the four historical aliases the already-public shared parser still accepts
# (`dedicated`, `new`, `dedicated_shadow`, `new_shadow`) are rejected here so
# an explicit Hermes value can never fall through to shared normalization and
# land the operator on a mode they did not write. Shared/client parsing is
# deliberately untouched — extensions/ocuclaw/src/even-ai/
# even-ai-settings-store.ts, composeApp .../app/AppEvenAiSettings.kt, and the
# setEvenAiSettings protocol ingress all keep the aliases and their tests.
EVEN_AI_ROUTING_MODES = ("active", "background", "background_new")
DEFAULT_EVEN_AI_ROUTING_MODE = "active"

REGISTERED_HOOK_NAMES = (
    "on_session_end",
    "post_approval_response",
    "pre_tool_call",
    "post_tool_call",
    "post_api_request",
    "pre_llm_call",
)

# Optional (post-0.20.0) hermes hooks. `register_hook` WARNS and stores an
# unknown name instead of raising (hermes_cli/plugins.py _register_hook), so
# exception-based detection is impossible: the only honest probe is the
# platform's own hook vocabulary plus the module that dispatches the stream
# hooks. None of these exist at the 0.20.0 floor (v2026.8.3
# hermes_cli/plugins.py VALID_HOOKS), all four exist at v2026.8.19.
INTERIM_HOOK_NAME = "on_interim_message"
STREAM_HOOK_NAMES = ("on_stream_start", "on_stream_delta", "on_stream_end")
STREAM_HOOKS_MODULE = "agent.plugin_stream_hooks"
# Declared in plugin.yaml, registered ONLY where the host's hook vocabulary
# has them. The manifest states what this build may use; the probe decides
# what it actually wires.
CONDITIONAL_HOOK_NAMES = (
    (INTERIM_HOOK_NAME,) + STREAM_HOOK_NAMES + (PRE_TRANSCRIPTION_HOOK_NAME,)
)
STREAM_REASONING_DELTAS_CONFIG_PATH = ("plugins", "stream_reasoning_deltas")

# Feature tokens advertised to the Node child (and from there to the client's
# capability snapshot). A token means "this adapter build actually registered
# the producing hook on THIS host" — never "the host could support it".
# A token means "this adapter build actually registered the producing hook on
# THIS host" — or, for a non-hook lane, "this adapter WILL SERVE the advertised
# lane on this host". `session_read_state` is the second kind: it registers no
# hook, it feature-detects the running hermes's sessions schema + primitives
# and then serves `db.sessions.setRead`/`setHidden` and the `unread`/`hidden`
# row keys off them.
FEATURE_TOKEN_INTERIM_HOOK = "interim_hook"
FEATURE_TOKEN_STREAM_HOOKS = "stream_hooks"
FEATURE_TOKEN_SESSION_READ_STATE = "session_read_state"
OCUCLAW_HERMES_FEATURES_ENV = "OCUCLAW_HERMES_FEATURES"

# Set once by register(); read by _setup_status() and the child env builder.
STREAM_HOOKS_AVAILABLE = False
INTERIM_HOOK_AVAILABLE = False
# Set once by register(). Deliberately NOT a feature token: the token channel
# advertises lanes the CLIENT branches on, and the phone's STT settings behave
# identically either way — with the hook the wearer's language reaches Hermes's
# eight built-in backends, without it only the command/plugin lanes honour it
# (stt_rpc `_dispatch_overlay`). Nothing on the wire changes, so nothing on the
# wire announces it; this boolean is for `hermes doctor`-grade diagnosis.
PRE_TRANSCRIPTION_HOOK_AVAILABLE = False
_REGISTERED_OPTIONAL_FEATURES: Tuple[str, ...] = ()


def _valid_hook_names() -> frozenset:
    """The hermes hook vocabulary, or an empty set off-platform."""
    try:
        from hermes_cli.plugins import VALID_HOOKS

        return frozenset(str(name) for name in VALID_HOOKS)
    except Exception:  # noqa: BLE001 - probing must never break plugin load
        return frozenset()


def _stream_hooks_module_present() -> bool:
    """True when the hermes stream-hook dispatcher module exists.

    ``find_spec`` (never ``import``) keeps the probe side-effect-free: the
    module registers process-wide state when imported.
    """
    try:
        return importlib.util.find_spec(STREAM_HOOKS_MODULE) is not None
    except Exception:  # noqa: BLE001 - a broken parent package is "absent"
        return False


def _probe_optional_hook_support() -> Tuple[bool, bool]:
    """``(stream_hooks_available, interim_hook_available)`` for this host."""
    names = _valid_hook_names()
    interim = INTERIM_HOOK_NAME in names
    stream = (
        _stream_hooks_module_present()
        and interim
        and all(name in names for name in STREAM_HOOK_NAMES)
    )
    return stream, interim


def _pre_transcription_hook_supported() -> bool:
    """True when this host's hook vocabulary carries ``pre_transcription``.

    Probed for the same reason the stream hooks are (`register_hook` warns and
    STORES an unknown name rather than refusing it, hermes_cli/plugins.py:3259)
    — registering blind would log a warning on every host older than the seam
    and wire a callback that can never fire. Arrived with the STT dispatcher's
    hook seam; absent at the 0.20.0 baseline.
    """
    return PRE_TRANSCRIPTION_HOOK_NAME in _valid_hook_names()


def _stream_reasoning_deltas_configured() -> bool:
    """``plugins.stream_reasoning_deltas`` as written in config.yaml.

    Read ONCE, at registration. Upstream's own
    ``stream_reasoning_deltas_enabled()`` re-reads config on every call, which
    is not a per-delta budget.
    """
    config, readable = _setup_raw_config()
    if not readable:
        return False
    node: Any = config
    for key in STREAM_REASONING_DELTAS_CONFIG_PATH:
        if not isinstance(node, dict):
            return False
        node = node.get(key)
    return node is True


# What `/ocuclaw-setup` should do about `plugins.stream_reasoning_deltas` on
# THIS host. The key is hermes' own and gateway-wide, so the assistant offers
# it and the operator answers; nothing here ever writes on its own.
STREAM_DELTAS_OFFER_ENABLED = "already_enabled"
STREAM_DELTAS_OFFER_AVAILABLE = "offer"
STREAM_DELTAS_OFFER_INERT = "inert"
STREAM_DELTAS_OFFER_UNKNOWN = "unknown"
STREAM_DELTAS_RESTART_NOTE = (
    "plugins.stream_reasoning_deltas: true is saved. Hermes reads it when it "
    "builds its plugin hook set, so it takes effect only after the gateway "
    "restarts."
)
STREAM_DELTAS_INERT_NOTE = (
    "This Hermes has no reasoning-delta hooks (they arrive in 0.20.5), so the "
    "key would sit inert. Reasoning still arrives, in whole pieces."
)
STREAM_DELTAS_SCOPE_NOTE = (
    "plugins.stream_reasoning_deltas is a gateway-wide Hermes key: it changes "
    "how Hermes calls the model for every surface on this gateway, not just "
    "OcuClaw."
)


def _stream_reasoning_deltas_offer(
    *,
    configured: bool,
    hooks_available: bool,
    config_readable: bool,
) -> str:
    """What `/ocuclaw-setup` should DO about the opt-in on this host.

    Three honest outcomes, and the offer is only one of them: the key is
    gateway-wide, so an inert host must be told the key would do nothing
    rather than nudged into setting it anyway.
    """
    if not config_readable:
        return STREAM_DELTAS_OFFER_UNKNOWN
    if configured:
        return STREAM_DELTAS_OFFER_ENABLED
    if not hooks_available:
        return STREAM_DELTAS_OFFER_INERT
    return STREAM_DELTAS_OFFER_AVAILABLE


def _enable_stream_reasoning_deltas() -> Dict[str, Any]:
    """Write ``plugins.stream_reasoning_deltas: true`` into config.yaml.

    Same mechanism the profile-options lane uses for
    ``display.platforms.ocuclaw.tool_progress``: hermes' own
    ``read_user_config_raw`` + ``atomic_config_write``, so an operator's
    comments and unrelated keys survive and a crashed write can never leave a
    half-config behind. UNLIKE tool_progress, hermes reads this key once when
    it builds the plugin hook set, so the write is inert until a restart.
    """
    try:
        from hermes_cli.config import (
            atomic_config_write,
            get_config_path,
            read_user_config_raw,
        )
    except Exception:  # noqa: BLE001 - off-platform / broken host
        logger.exception("[ocuclaw] hermes config writer unavailable")
        return {
            "applied": False,
            "reason": "config_unwritable",
            "restartRequired": False,
            "message": "Hermes' configuration writer is unavailable here.",
        }

    try:
        config_path = Path(get_config_path())
        raw_cfg = read_user_config_raw(config_path)
        if not isinstance(raw_cfg, dict):
            raw_cfg = {}
        plugins_cfg = raw_cfg.setdefault("plugins", {})
        if not isinstance(plugins_cfg, dict):
            plugins_cfg = {}
            raw_cfg["plugins"] = plugins_cfg
        if plugins_cfg.get("stream_reasoning_deltas") is True:
            return {
                "applied": False,
                "reason": "already_enabled",
                "restartRequired": False,
                "configPath": str(config_path),
                "message": (
                    "plugins.stream_reasoning_deltas was already true; nothing "
                    "was written."
                ),
            }
        plugins_cfg["stream_reasoning_deltas"] = True
        atomic_config_write(config_path, raw_cfg)
    except Exception:  # noqa: BLE001 - never raise through an agent turn
        logger.exception("[ocuclaw] stream_reasoning_deltas write failed")
        return {
            "applied": False,
            "reason": "config_unwritable",
            "restartRequired": False,
            "message": "Hermes' configuration could not be written safely.",
        }

    return {
        "applied": True,
        "reason": "written",
        "restartRequired": True,
        "configPath": str(config_path),
        "message": STREAM_DELTAS_RESTART_NOTE,
    }


# The OcuClaw look for Hermes Desktop. The theme itself is always contributed
# by the Desktop plugin (it lists in Settings > Appearance regardless); what
# `/ocuclaw-setup` offers is APPLYING it, and the answer is a UTC stamp under
# `platforms.ocuclaw.extra.desktopThemeRequestedAt` — inside the namespace
# uninstall already strips — that the plugin file re-renders around.
DESKTOP_THEME_NAME = "ocuclaw"
DESKTOP_THEME_OFFER_ENABLED = "already_enabled"
DESKTOP_THEME_OFFER_AVAILABLE = "offer"
DESKTOP_THEME_OFFER_UNAVAILABLE = "unavailable"
DESKTOP_THEME_OFFER_UNKNOWN = "unknown"
# requestTheme() — the door that applies a theme from outside React — arrived
# in Hermes 0.20.6. Below that the theme is listed but must be picked by hand.
DESKTOP_THEME_AUTOSELECT_MIN = (0, 20, 6)
DESKTOP_THEME_SCOPE_NOTE = (
    "The OcuClaw look changes only how Hermes Desktop paints for this profile; "
    "the built-in themes stay one click away in Settings > Appearance, and "
    "disabling or uninstalling OcuClaw returns Desktop to its default skin."
)
DESKTOP_THEME_PICK_MANUALLY_NOTE = (
    "This Hermes Desktop cannot be switched from a plugin (that arrives in "
    "0.20.6), so the OcuClaw theme is listed but not applied: pick it in "
    "Settings > Appearance > Theme."
)


def _desktop_theme_offer(
    *,
    requested: bool,
    plugin_present: bool,
    config_readable: bool,
) -> str:
    """What `/ocuclaw-setup` should DO about the OcuClaw look on this host."""
    if not config_readable:
        return DESKTOP_THEME_OFFER_UNKNOWN
    if requested:
        return DESKTOP_THEME_OFFER_ENABLED
    if not plugin_present:
        return DESKTOP_THEME_OFFER_UNAVAILABLE
    return DESKTOP_THEME_OFFER_AVAILABLE


def _desktop_theme_autoselect_supported(version: Optional[str] = None) -> bool:
    parsed = parse_version(version if version is not None else _hermes_version())
    return parsed is not None and parsed >= DESKTOP_THEME_AUTOSELECT_MIN


def _desktop_plugin_presence() -> Tuple[Optional[str], bool]:
    """(path, present) for the OcuClaw-owned Desktop plugin file."""
    try:
        home = resolve_receipt_home()
    except Exception:  # noqa: BLE001 - presence is advisory
        home = None
    if home is None:
        return None, False
    path = desktop_plugin_path(home)
    try:
        present = path.exists() and desktop_plugin_owned(path)
    except OSError:
        present = False
    return str(path), bool(present)


def _desktop_theme_status(raw_config: Dict[str, Any], config_readable: bool) -> Dict[str, Any]:
    requested_at = read_desktop_theme_request(raw_config) if config_readable else ""
    path, present = _desktop_plugin_presence()
    return {
        "name": DESKTOP_THEME_NAME,
        "requestedAt": requested_at or None,
        "requested": bool(requested_at),
        "pluginPath": path,
        "pluginPresent": present,
        "autoSelectSupported": _desktop_theme_autoselect_supported(),
        "offer": _desktop_theme_offer(
            requested=bool(requested_at),
            plugin_present=present,
            config_readable=config_readable,
        ),
    }


def _enable_desktop_theme() -> Dict[str, Any]:
    """Record the operator's yes and re-render the Desktop plugin around it.

    Two writes, both through owned doors: the stamp goes into config.yaml via
    hermes' own atomic writer (same as the stream-deltas opt-in), then the
    Desktop plugin file is reconciled with that stamp so Hermes Desktop
    hot-reloads it and applies the theme without a restart.
    """
    try:
        from hermes_cli.config import (
            atomic_config_write,
            get_config_path,
            read_user_config_raw,
        )
    except Exception:  # noqa: BLE001 - off-platform / broken host
        logger.exception("[ocuclaw] hermes config writer unavailable")
        return {
            "applied": False,
            "reason": "config_unwritable",
            "restartRequired": False,
            "message": "Hermes' configuration writer is unavailable here.",
        }

    requested_at = (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    try:
        config_path = Path(get_config_path())
        raw_cfg = read_user_config_raw(config_path)
        if not isinstance(raw_cfg, dict):
            raw_cfg = {}
        node = raw_cfg
        for key in ("platforms", "ocuclaw", "extra"):
            child = node.get(key)
            if not isinstance(child, dict):
                child = {}
                node[key] = child
            node = child
        node[DESKTOP_THEME_CONFIG_KEY] = requested_at
        atomic_config_write(config_path, raw_cfg)
    except Exception:  # noqa: BLE001 - never raise through an agent turn
        logger.exception("[ocuclaw] desktop theme request write failed")
        return {
            "applied": False,
            "reason": "config_unwritable",
            "restartRequired": False,
            "message": "Hermes' configuration could not be written safely.",
        }

    try:
        reconcile = reconcile_pairing_plugin(theme_request=requested_at)
    except Exception as exc:  # noqa: BLE001 - the stamp is saved; say what failed
        reconcile = {"status": "error", "reason": f"desktop_plugin_reconcile_failed: {exc}"}
    auto_select = _desktop_theme_autoselect_supported()
    rendered = reconcile.get("status") in DESKTOP_PLUGIN_RECONCILE_OK
    if rendered and auto_select:
        message = (
            "OcuClaw theme requested. Hermes Desktop reloads the OcuClaw plugin "
            "on its own and switches to the theme; no restart needed."
        )
    elif rendered:
        message = DESKTOP_THEME_PICK_MANUALLY_NOTE
    else:
        message = (
            "The request is saved, but the Desktop plugin file could not be "
            "re-rendered, so Hermes Desktop has not switched yet."
        )
    return {
        "applied": rendered,
        "reason": "written" if rendered else str(reconcile.get("reason") or "desktop_plugin_unavailable"),
        "requestedAt": requested_at,
        "configPath": str(config_path),
        "pluginReconcile": reconcile,
        "autoSelect": bool(rendered and auto_select),
        "restartRequired": False,
        "message": message,
    }


def _hermes_feature_tokens() -> Tuple[str, ...]:
    """Feature tokens for the child env — registration truth, not capability."""
    return _REGISTERED_OPTIONAL_FEATURES

# Supported Hermes range for this bundle build. The complete Backend Adapter
# admission and SessionDB contract is certified against this exact upstream
# release. In-minor patches remain admissible, but the release watcher creates
# an immediate recertification obligation for every first-seen 0.21.x patch.
CERTIFIED_HERMES_VERSION = "0.21.0"
CERTIFIED_HERMES_TAG = "v2026.8.31"
CERTIFIED_HERMES_COMMIT = "29112bef099274229cadff79cdff7bf7b99c4b77"
SUPPORTED_HERMES_MIN = (0, 21, 0)
SUPPORTED_HERMES_MAX_EXCLUSIVE = (0, 22, 0)

# Hermes owns these bytes for every OcuClaw-platform session. Keep the section
# constant: callbacks are re-rendered after 0.21 prompt invalidation/compaction,
# while this product contract must remain byte-identical at every lifecycle
# boundary. OpenClaw uses the matching shared-runtime constant instead.
OCUCLAW_READABILITY_SECTION_ID = "ocuclaw.readability"
OCUCLAW_READABILITY_SYSTEM_PROMPT = (
    "For small-screen readability, prefer compact paragraphs and complete "
    "sentences. Keep formatting simple; avoid tables, code fences, and long "
    "unbroken strings unless needed."
)

BUNDLE_DIR = Path(__file__).resolve().parent
DEFAULT_RUNTIME_ENTRY = BUNDLE_DIR / "dist-cjs" / "runtime" / "hermes-runtime-entry.cjs"
SETUP_SKILL_NAME = "ocuclaw-assist-hermes"
SETUP_SKILL_PATH = BUNDLE_DIR / "skills" / SETUP_SKILL_NAME / "SKILL.md"
SETUP_SKILL_DESCRIPTION = (
    "Guided OcuClaw setup, update, diagnostics, and troubleshooting for Hermes."
)
SETUP_TOOL_NAME = "ocuclaw_setup"
# Hermes 0.20.x interactive sessions resolve the `hermes-cli` composite when
# they snapshot model tools. Registering this alongside the narrower `skills`
# surface leaves it out of that snapshot even though direct registry dispatch
# still works, so the loaded setup skill cannot call its companion tool.
SETUP_TOOLSET = "hermes-cli"
SETUP_TOOL_DESCRIPTION = (
    "Inspect OcuClaw setup, run the local human pairing ceremony, wait for the "
    "phone-origin proof turn and welcome dismissal, and load focused guidance "
    "without revealing secrets. Two optional operations write — "
    "enable_stream_reasoning_deltas and enable_desktop_theme — and only with "
    "confirm: true after the operator has said yes."
)
SETUP_GUIDE_VERSION = "2026-09-05 (1.3.19-hermes)"
SETUP_SKILL_LOAD_POINTER = (
    "If the OcuClaw Setup Assistant skill is not loaded in this conversation, "
    "load it via `/ocuclaw-setup` before mutating anything."
)
SETUP_REFERENCE_FILES = {
    "install_lifecycle": ("install-lifecycle.md", "Installation and lifecycle recovery"),
    "fresh_install": ("fresh-install.md", "Fresh install"),
    "agent_mode": ("agent-mode.md", "Choose single or multiple agents"),
    "credential_reset": ("relay-credential-reset.md", "Reset relay credential"),
    "update": ("update.md", "Update OcuClaw"),
    "troubleshooting": ("troubleshooting.md", "Troubleshooting"),
    "quick_reference": ("quick-reference.md", "Quick reference"),
    "wrap_feedback": ("wrap-feedback.md", "Wrap and feedback"),
}
SETUP_STREAM_DELTAS_OPERATION = "enable_stream_reasoning_deltas"
SETUP_DESKTOP_THEME_OPERATION = "enable_desktop_theme"
SETUP_EVEN_AI_ROUTE_OPERATION = "even_ai_route"
SETUP_WRITING_OPERATIONS = (
    SETUP_STREAM_DELTAS_OPERATION,
    SETUP_DESKTOP_THEME_OPERATION,
)
SETUP_READ_ONLY_OPERATIONS = (
    "status",
    "doctor",
    SETUP_EVEN_AI_ROUTE_OPERATION,
    *SETUP_REFERENCE_FILES.keys(),
)
SETUP_INTERACTIVE_OPERATIONS = (
    "request_credentials",
    "pair_phone",
    "wait_phone_origin",
    "arm_first_run_proof",
    "welcome_round_trip",
)
SETUP_OPERATIONS = (
    "status",
    "doctor",
    SETUP_EVEN_AI_ROUTE_OPERATION,
    *SETUP_INTERACTIVE_OPERATIONS,
    *SETUP_REFERENCE_FILES.keys(),
    *SETUP_WRITING_OPERATIONS,
)
SETUP_TOOL_SCHEMA = {
    "name": SETUP_TOOL_NAME,
    "description": SETUP_TOOL_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": list(SETUP_OPERATIONS),
                "description": (
                    "Setup operation. request_credentials opens a private Desktop "
                    "form for one optional integration at a time; never supply secret values. "
                    "pair_phone opens the direct, model-bypassing "
                    "Hermes TUI or Desktop QR and four-word ceremony; "
                    "wait_phone_origin blocks for a completed phone turn; "
                    "welcome_round_trip blocks for the managed welcome dismissal. "
                    "All other operations are read-only except "
                    f"{SETUP_STREAM_DELTAS_OPERATION} and "
                    f"{SETUP_DESKTOP_THEME_OPERATION} (applies the OcuClaw "
                    "look to Hermes Desktop)."
                ),
            },
            "confirm": {
                "type": "boolean",
                "description": (
                    "Required true for "
                    f"{SETUP_STREAM_DELTAS_OPERATION} and "
                    f"{SETUP_DESKTOP_THEME_OPERATION}. Ask the operator "
                    "first — the stream key is gateway-wide, the theme "
                    "repaints their Desktop. Ignored by every read-only "
                    "operation."
                ),
            },
            "integrations": {
                "type": "array",
                "items": {"type": "string", "enum": ["soniox", "evenAi"]},
                "minItems": 1,
                "maxItems": 1,
                "uniqueItems": True,
                "description": "For request_credentials: exactly one integration the user chose at this checkpoint. Ask about Soniox and Even AI separately. No secret values.",
            },
            "phoneCandidateId": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$",
                "description": (
                    "Opaque candidate binding returned by wait_phone_origin. "
                    "Pass it unchanged to welcome_round_trip; never show it "
                    "to the user."
                ),
            },
        },
        "required": ["operation"],
        "additionalProperties": False,
    },
}
_LAST_SETUP_BUNDLE_REPORT: Dict[str, Any] = {"status": "unknown"}

# History pushes + agent_end transcripts are tail-sliced server-side so a long
# session never risks the 1 MiB link frame cap (same bound as chat.history).
HISTORY_PUSH_LIMIT = 200
# Hermes 0.20 drains StreamConsumer on its own task, so on_session_end can beat
# the trailing cumulative finalize edit. Keep the open record addressable for a
# short bounded interval; provider-abort paths still close deterministically.
STREAM_FINALIZE_GRACE_SECONDS = 1.5

TOOL_ACTIVITY_MAX_ARG_KEYS = 32
TOOL_ACTIVITY_MAX_ARG_ITEMS = 8
TOOL_ACTIVITY_MAX_ARG_DEPTH = 2
TOOL_ACTIVITY_MAX_ARG_STRING = 512
TOOL_ACTIVITY_MAX_ARGS_JSON_BYTES = 16 * 1024
TOOL_ACTIVITY_ALLOWED_ARG_KEYS = {
    "cmd",
    "command",
    "dest",
    "destination",
    "file",
    "filepath",
    "file_path",
    "href",
    "output",
    "outputpath",
    "output_path",
    "path",
    "q",
    "query",
    "search",
    "shell",
    "target",
    "term",
    "uri",
    "url",
}
TOOL_ACTIVITY_OMITTED_ARG_KEYS = {
    "blob",
    "body",
    "bytes",
    "code",
    "content",
    "contents",
    "data",
    "file_content",
    "input",
    "script",
    "source",
    "text",
}
SECRET_KEY_MARKERS = (
    "apikey",
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "password",
    "privatekey",
    "secret",
    "token",
)
TOOL_ACTIVITY_SECRET_ARG_KEY_MARKERS = SECRET_KEY_MARKERS
URL_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s\"'<>]+")
URL_SECRET_KEY_EXACT = {
    "auth",
    "code",
    "key",
    "otp",
    "pat",
    "pin",
    "pwd",
    "sig",
}
URL_SECRET_KEY_MARKERS = SECRET_KEY_MARKERS + ("signature",)
REDACTED_PLACEHOLDER = "[redacted]"
THINKING_FRAME_MAX_CHARS = 8000
THINKING_FRAME_TRUNCATION_SUFFIX = "...[truncated]"
THINKING_FRAME_TRUNCATION_PREFIX = "[truncated]..."

# Status-bar headline budget. The client caps again at 120/64 chars depending
# on verbosity; 80 is the wire ceiling so a headline is never a prose slab.
THINKING_HEADLINE_MAX_CHARS = 80
# Mirror of the Node bold extractor (activity-status-adapter.ts
# extractFirstBoldThinkingSegment): first CLOSED, non-greedy `**...**` span.
THINKING_BOLD_SPAN_RE = re.compile(r"\*\*(.+?)\*\*", re.S)
# Markdown noise a one-line headline must not carry onto the HUD.
THINKING_HEADLINE_STRIP_RE = re.compile(r"[*_`~]+")
THINKING_HEADLINE_LEADER_RE = re.compile(r"^\s*(?:[#>\-+]+|\d+[.)])\s*")
# OpenRouter's unified reasoning array (agent_runtime_helpers.py folds these
# into one reasoning blob upstream; the typed entry is the only place a
# provider-authored SUMMARY survives as its own item).
REASONING_SUMMARY_DETAIL_TYPE = "reasoning.summary"

# Narration (the agent's own mid-turn sentences) routing tag.
MESSAGE_KIND_NARRATION = "narration"
MESSAGE_KIND_TOOL_PROGRESS = "tool_progress"
# How many recent commits per run stay matchable for a late retag. Narration
# lands in the first sentences of a turn; an unbounded ledger would be a leak.
NARRATION_COMMIT_MEMORY = 16
# How many origin stamps stay remembered per run (#1619). One per narration
# sentence; the same bound as the commit ledger, for the same reason.
NARRATION_ORIGIN_MEMORY = 16
# Keep completed fork identities long enough to reject queued stream hooks too.
BACKGROUND_HOOK_TURN_MEMORY = 512
# Hermes' StreamConsumer marks a commentary send with this metadata key
# (0.20.5+). It is a SECOND narration signal, independent of the hook, and
# both feed the same normalized-text set.
INTERIM_SEND_METADATA_KEY = "_interim_send"

# Tier-2 reasoning-delta coalescer. 250 ms sits above the client's 150 ms
# status-refresh floor and the ~81 ms BT round trip; the client's own 90 ms/
# 80 ms stream coalescer absorbs the rest, so there is no second timer
# downstream. NOTE the plugin hook worker has NO timer of its own — it only
# runs when an item is dequeued — so "250 ms since the last flush" can fire no
# earlier than the NEXT delta, and the tail waits for the next delta or
# on_stream_end. That is a bounded, tested latency, not a stall.
STREAM_FLUSH_INTERVAL_S = 0.25
STREAM_FLUSH_CHARS = 200
STREAM_PARAGRAPH_BREAK = "\n\n"
STREAM_DELTA_KIND_REASONING = "reasoning"
# Content deltas. Never forwarded (the streaming transport already renders
# them) but they are the ONLY signal for when the model produced the text of
# an interim message: the first one of a model call is that message's ORIGIN
# time, which is what orders a progress note on the page (#1619). Upstream
# spells this kind literally `"text"` (run_agent.py, on_stream_delta enqueue).
STREAM_DELTA_KIND_TEXT = "text"
THINKING_SOURCE_STREAM_DELTA = "hermes.on_stream_delta"
THINKING_SOURCE_POST_API_REQUEST = "hermes.post_api_request"
# on_stream_end closes ONE model call, and a hermes turn makes many. The
# client hard-finalizes a run's thinking pane on any reason except
# "response_started" and then DROPS every later update for that run — so a
# literal "stream_end" here would black-hole the reasoning of every iteration
# after the first. "response_started" is the soft finalize the pane reopens
# from, which is exactly the per-call boundary this is. The run's hard
# finalize already happens downstream at assistant-message commit.
STREAM_END_FINALIZE_REASON = "response_started"

# connect() gates on the child's explicit runtime.ready receipt (relay bound)
# whenever a relay boot is expected (relayToken set) — a bind failure must
# never publish a transiently-connected platform (Codex review W06 finding).
RUNTIME_READY_TIMEOUT_S = 30.0

FOREIGN_COPY_METHOD = "foreign.sessions.copy"
# Continue here (#2509): adopt a Desktop/CLI/TUI transcript onto a freshly
# minted glasses lane via the PUBLIC `/resume <tip> --all` slash command.
FOREIGN_ADOPT_METHOD = "foreign.sessions.adopt"
# `OCUCLAW_WEARER_USER_ID` (health.py) is the ONE user id this adapter stamps
# on every wearer-originated event (`build_source` in `_build_message_event`).
# `allow_admin_from` must list exactly this id for `/resume --all` to be
# sanctioned; it also turns slash gating ON for the ocuclaw platform
# (slash_access.py `enabled=bool(admin_ids)`), safe only because this is the
# sole id the adapter ever sends.
ADOPT_CHAT_ID_PREFIX = "adopt-"
# Hermes answers a slash turn in well under a second; the DB is polled at
# ADOPT_POLL_S until the routing shows the tip, or the reply names a refusal,
# or this budget runs out (verdict `adopt_timeout`, no row changed).
ADOPT_TIMEOUT_S = 10.0
ADOPT_POLL_S = 0.1
# Live Desktop/TUI leases on the lineage lock the adopt (RULED: DESKTOP_HOLD =
# hard lock, Take-over only — the caller passes takeOver:true, T2 #2510).
DESKTOP_HOLD_SURFACES = frozenset({"desktop", "tui"})
DESKTOP_TURN_MARKER_RELPATH = ("desktop", "interrupted_turns.json")
DESKTOP_LEASE_REGISTRY_RELPATH = ("runtime", "active_sessions.json")
# Single-driver lock (T2 #2510). One driver at a time on an adopted chat:
# GLASSES_DRIVE — no live Desktop/TUI lease on the lineage; DESKTOP_HOLD — a
# pid-alive lease names a lineage id (Desktop ran this chat and still owns
# its runtime — its NEXT turn answers from in-memory history, so a glasses
# turn would be silently dropped from Desktop's context); DESKTOP_WORKING —
# a turn marker names a lineage id (a Desktop turn is running right now).
# LOCK in both Desktop states (RULED); unlock on lease clear or Take-over.
DRIVER_STATE_GLASSES = "glasses_drive"
DRIVER_STATE_DESKTOP_HOLD = "desktop_hold"
DRIVER_STATE_DESKTOP_WORKING = "desktop_working"
FOREIGN_DRIVER_METHOD = "foreign.sessions.driver"
# Tier 0 in-flight fail-safe: `on_session_end` skips interrupted early
# returns (run_agent.py:9158), so an in-flight mark that never sees its end
# expires on its own. Every pre_llm_call / tool hook refreshes the stamp, so
# the TTL bounds ONE silent gap (a single model call or tool run), not a turn.
INFLIGHT_TTL_S = 600.0
# Hermes's own durable-lease wait notice (run_agent.py:8839-8851). It reaches
# the app as `activity origin=status state=lifecycle` with the text in
# `detail` and no label — the status presenter drops label-less lifecycle
# notices (T0 step 8: the wearer saw nothing for 56 s). Stamping the label +
# rank here makes the wait visible on the header and the phone.
DESKTOP_LEASE_WAIT_PREFIX = "⏳"
DESKTOP_LEASE_WAIT_STATUS_KEY = "desktop_lease_wait"
DESKTOP_LEASE_WAIT_LABEL = "Waiting for Desktop"
APPROVAL_RESOLVE_METHOD = "approval.resolve"
SLASH_CONFIRM_PRESENT_METHOD = "slash.confirm.present"
SLASH_CONFIRM_RESOLVE_METHOD = "slash.confirm.resolve"
CLARIFY_RESOLVE_METHOD = "clarify.resolve"
CLARIFY_AWAIT_TEXT_METHOD = "clarify.await_text"
SESSION_ABORT_METHOD = "sessions.abort"
SESSION_STEER_METHOD = "sessions.steer"
SESSION_OPTIONS_APPLY_METHOD = "sessions.options.apply"
PROFILE_OPTIONS_GET_METHOD = "profile.options.get"
PROFILE_OPTIONS_APPLY_METHOD = "profile.options.apply"
MULTIPLEX_DISABLED_ERROR = (
    "Hermes multiplex profile routing is disabled; only the main namespace "
    "is available."
)
PROFILE_NOT_SERVED_ERROR = (
    "Hermes profile {profile!r} is not served by this gateway."
)
CROSS_PROFILE_COPY_ERROR = (
    "Cross-profile session copy is not supported; source and target must "
    "use the same profile."
)
SECONDARY_PORT_BINDING_ERROR = (
    "ocuclaw is a port-binding platform; configure it only on the default profile"
)
# Wearer-facing refusal for the platform update command (P19). Plain
# language, no jargon, and terse enough for the 576x288 glasses display: it
# says what did not happen, why, and that nothing broke. The certified
# baseline is never replaced by an unproven tree behind the wearer's back;
# the supervised upgrade contract is the only sanctioned transition.
UPDATE_COMMAND_REFUSAL = (
    "Update is turned off here. Updating Hermes from your glasses would "
    "replace the version OcuClaw is tested against, and your assistant "
    "could stop working with no way back. Nothing was changed. OcuClaw "
    "upgrades arrive through its own supervised upgrade, which checks that "
    "everything still works before it keeps the new version."
)


def _url_key_is_secret(key: Any) -> bool:
    """True when a URL query/fragment key names a credential-bearing value."""
    marker_key = "".join(ch for ch in str(key or "").lower() if ch.isalnum())
    return marker_key in URL_SECRET_KEY_EXACT or any(
        marker in marker_key for marker in URL_SECRET_KEY_MARKERS
    )


def _url_path_segment_is_secret(segment: Any) -> bool:
    """True when a URL path segment looks like an embedded credential.

    Named secret markers win outright; otherwise a long mixed alphanumeric
    segment (webhook ids, opaque tokens) is treated as secret-bearing.
    """
    raw = str(segment or "")
    marker_key = "".join(ch for ch in raw.lower() if ch.isalnum())
    if not marker_key:
        return False
    if _url_key_is_secret(marker_key):
        return True
    has_alpha = any(ch.isalpha() for ch in marker_key)
    has_digit = any(ch.isdigit() for ch in marker_key)
    if len(marker_key) >= 9 and raw[:1].isalpha() and has_digit:
        return True
    return len(marker_key) >= 16 and has_alpha and has_digit


def _redact_url_query(query: str) -> str:
    if not query:
        return ""
    redacted = []
    for part in query.split("&"):
        if not part:
            redacted.append(part)
            continue
        key, separator, _value = part.partition("=")
        if _url_key_is_secret(key):
            redacted.append(f"{key}{separator}{REDACTED_PLACEHOLDER}")
        else:
            redacted.append(part)
    return "&".join(redacted)


def _redact_url_path(path: str) -> str:
    if not path:
        return ""
    return "/".join(
        REDACTED_PLACEHOLDER if _url_path_segment_is_secret(segment) else segment
        for segment in path.split("/")
    )


def redact_urls_in_text(text: Any) -> str:
    """Redact credentials carried by any URL embedded in ``text``.

    The single shared URL redactor for every rendered OcuClaw diagnostic
    surface (tool activity, setup/doctor evidence, logs, support payloads).
    Userinfo, secret-named query/fragment parameters, and credential-shaped
    path segments become ``[redacted]``; URL structure and every non-URL
    character of the text are preserved so the reader keeps the context they
    need to diagnose. Non-string input is coerced; ``None`` becomes ``""``.
    """
    if text is None:
        return ""
    value = text if isinstance(text, str) else str(text)
    if "://" not in value:
        return value

    def replace(match: Any) -> str:
        raw = str(match.group(0) or "")
        trailing = ""
        while raw and raw[-1] in ".,);":
            trailing = raw[-1] + trailing
            raw = raw[:-1]
        try:
            parts = urlsplit(raw)
        except Exception:  # noqa: BLE001 - redaction must never raise
            return raw + trailing
        netloc = parts.netloc
        if "@" in netloc:
            netloc = REDACTED_PLACEHOLDER + "@" + netloc.rsplit("@", 1)[1]
        path = _redact_url_path(parts.path)
        query = _redact_url_query(parts.query)
        fragment = parts.fragment
        if fragment:
            if "=" in fragment or "&" in fragment:
                fragment = _redact_url_query(fragment)
            elif _url_key_is_secret(fragment):
                fragment = REDACTED_PLACEHOLDER
        return urlunsplit((parts.scheme, netloc, path, query, fragment)) + trailing

    return URL_RE.sub(replace, value)


class AmbiguousOutboundNamespaceError(RuntimeError):
    def __init__(self, chat_id: Any, namespaces: List[str]) -> None:
        candidates = ", ".join(sorted(str(ns) for ns in namespaces))
        super().__init__(
            f"Ambiguous outbound namespace for chat_id {chat_id!r}: {candidates}"
        )


LIVEUI_RENDER_METHOD = "liveui.render"
LIVEUI_ABORT_METHOD = "liveui.abort"
LIVEUI_PROMPT_METHOD = "liveui.prompt"
LIVEUI_PROMPT_ACK_METHOD = "liveui.promptAck"
LIVEUI_LLM_AUTH_METHOD = "liveui.llmAuth"
LIVEUI_LLM_RECIPE_METHOD = "liveui.llmRecipe"
LIVEUI_TOOL_NAME = "render_glasses_ui"
LIVEUI_STATE_METHOD = "liveui.uiState"
LIVEUI_STATE_TOOL_NAME = "get_glasses_ui_state"
LIVEUI_TEMPLATE_METHOD = "liveui.templates"
LIVEUI_TEMPLATE_TOOL_NAME = "manage_liveui_templates"
LIVEUI_TASK_METHOD = "liveui.tasks"
LIVEUI_TASK_TOOL_NAME = "manage_liveui_tasks"
LIVEUI_TOOLSET = "ocuclaw"
HERMES_HOME_CHANNEL_NOTICE = (
    "📬 No home channel is set for Ocuclaw. A home channel is where Hermes "
    "delivers cron job results and cross-platform messages.\n\n"
    "Type /sethome to make this chat your home channel, or ignore to skip."
)
LIVEUI_DEFAULT_RENDER_TIMEOUT_MS = 30 * 60 * 1000
LIVEUI_RENDER_LINK_MARGIN_S = 60.0
LIVEUI_PROMPT_LINK_TIMEOUT_S = 2.0
FIRST_RUN_WELCOME_POLL_SECONDS = 1.0

# Adapter instances the module-level hermes hook handlers route into (hooks
# are registered ONCE at plugin load; adapters are constructed per platform
# boot and live for the gateway's lifetime).
_ADAPTERS: List[Any] = []
_POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = False
_PLUGIN_CONTEXT: Any = None
_LIVEUI_REGISTER_TOOL: Any = None
_LIVEUI_TOOL_REGISTERED = False
_LIVEUI_STATE_TOOL_REGISTERED = False
_LIVEUI_TEMPLATE_TOOL_REGISTERED = False
_LIVEUI_TASK_TOOL_REGISTERED = False
_LIVEUI_LOCK = threading.RLock()


def _hermes_home() -> Optional[Path]:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001
        return None


# `adopt_configured(extra)` — the adapter-side name for the health lane's
# posture read (one implementation; setup status, doctor findings and the
# adopt verb must never disagree on what "configured" means).
adopt_configured = continue_here_configured


def _pid_alive_here(pid: Any) -> bool:
    """Our own liveness probe (``kill(pid, 0)``). Dead-pid leases persist on
    disk (the Mac holds pid 34644, dead); Hermes's public reader prunes them,
    but the lock must never depend on that side effect alone."""
    try:
        pid_int = int(pid)
    except (TypeError, ValueError):
        return False
    if pid_int <= 0:
        return False
    try:
        os.kill(pid_int, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def desktop_hold_details(
    home: Optional[Path], lineage: List[str]
) -> Optional[Dict[str, Any]]:
    """What Desktop/TUI currently holds on a lineage, from Hermes's own files.

    ``{"state": "working", ...}`` — a turn marker exists
    (``desktop/interrupted_turns.json``, tui_gateway/turn_marker.py: written
    at turn start, cleared at turn end, keyed by the session id Desktop
    resumed — ``session["session_key"]`` IS the DB session id there) AND a
    live Desktop/TUI lease backs it. A marker is a promise to resume, not
    proof of a process: a Desktop killed MID-turn leaves the marker on disk
    forever (real-Desktop e2e follow-up, map #2507), and nobody is driving
    then — no in-memory history exists that a glasses turn could fall out of
    (Desktop reloads the transcript from the DB on relaunch). So a marker
    with no live lease is IGNORED (free, ``None``), never ``working`` and
    never ``hold``. This is safe against turn-start ordering: Hermes acquires
    the lease when the session opens (tui_gateway/server.py
    ``_claim_active_session_slot``) and writes the marker only at turn start
    (``record_turn_start``), so a live Desktop always holds its lease before
    any marker of its own exists.
    ``{"state": "hold", ...}`` — a live (pid-alive) Desktop/TUI active-session
    lease names one of the lineage ids (``runtime/active_sessions.json`` via
    the public ``active_session_registry_snapshot`` reader, which prunes dead
    pids; ``_pid_alive_here`` re-checks with our own ``kill(pid, 0)``).
    ``None`` — free, or unknowable (an unreadable registry never locks the
    wearer out; the Node watches re-read on every file event and, while the
    lane is held, on a bounded liveness tick that re-runs this probe). Never
    a private read of ``session_turn_leases`` (RULED).
    """
    if home is None or not lineage:
        return None
    ids = {str(value) for value in lineage if value}
    marker_hit: Optional[Dict[str, Any]] = None
    marker = Path(home).joinpath(*DESKTOP_TURN_MARKER_RELPATH)
    try:
        with open(marker, encoding="utf-8") as handle:
            entries = json.load(handle)
        if isinstance(entries, dict):
            for key, value in entries.items():
                if key in ids and isinstance(value, dict):
                    marker_hit = {"sessionId": str(key), "since": value.get("started_at")}
                    break
    except FileNotFoundError:
        pass
    except Exception:  # noqa: BLE001 - best-effort marker read
        logger.debug("[ocuclaw] turn marker unreadable at %s", marker, exc_info=True)
    lease = _live_desktop_lease(home, ids)
    if marker_hit is not None:
        if lease is None:
            logger.debug(
                "[ocuclaw] turn marker for %s has no live Desktop lease — Desktop died mid-turn; ignoring it",
                marker_hit["sessionId"],
            )
        else:
            return {
                "state": "working",
                "sessionId": marker_hit["sessionId"],
                "surface": lease["surface"],
                "pid": lease.get("pid"),
                "since": marker_hit["since"],
            }
    return lease


def _live_desktop_lease(home: Path, ids: Set[str]) -> Optional[Dict[str, Any]]:
    """The first pid-alive Desktop/TUI lease naming one of ``ids`` as a
    ``hold`` detail, or ``None`` (free or unknowable)."""
    try:
        from hermes_cli.active_sessions import active_session_registry_snapshot

        for entry in active_session_registry_snapshot(registry_home=home):
            if not isinstance(entry, dict):
                continue
            surface = str(entry.get("surface") or "").strip().lower()
            session_id = str(entry.get("session_id") or "")
            if surface not in DESKTOP_HOLD_SURFACES or session_id not in ids:
                continue
            if not _pid_alive_here(entry.get("pid")):
                continue
            return {
                "state": "hold",
                "sessionId": session_id,
                "surface": surface,
                "pid": entry.get("pid"),
                "since": entry.get("started_at"),
            }
    except Exception:  # noqa: BLE001 - unknown liveness never locks the wearer out
        logger.debug("[ocuclaw] active-session registry unreadable", exc_info=True)
    return None


def desktop_hold_state(home: Optional[Path], lineage: List[str]) -> Optional[str]:
    """``"working"`` / ``"hold"`` / ``None`` — see ``desktop_hold_details``."""
    details = desktop_hold_details(home, lineage)
    return str(details["state"]) if details else None


def driver_state_for(hold: Optional[Dict[str, Any]]) -> str:
    """Hold details → wire driver state (LOCK in both Desktop states)."""
    if not hold:
        return DRIVER_STATE_GLASSES
    if hold.get("state") == "working":
        return DRIVER_STATE_DESKTOP_WORKING
    return DRIVER_STATE_DESKTOP_HOLD


def is_desktop_lease_wait_notice(status_key: Any, content: Any) -> bool:
    """Hermes's durable-lease wait notice (run_agent.py:8839-8851): the
    lifecycle status whose text opens with the hourglass."""
    return (
        str(status_key or "") == "lifecycle"
        and str(content or "").lstrip().startswith(DESKTOP_LEASE_WAIT_PREFIX)
    )


def _namespace_for_profile(profile: Any) -> str:
    return namespace_for_profile(profile)


def _load_profile_routing() -> Tuple[bool, Dict[str, Path]]:
    """Cheap fail-closed snapshot of the profiles this gateway serves."""
    return load_profile_routing_snapshot()


def _guard_secondary_port_binding_scope() -> None:
    """Refuse the secondary-profile construction done by the multiplexer."""
    try:
        from hermes_constants import (
            get_hermes_home,
            get_hermes_home_override,
            get_process_hermes_home,
        )

        override = get_hermes_home_override()
        if override and Path(get_hermes_home()) != Path(get_process_hermes_home()):
            raise RuntimeError(SECONDARY_PORT_BINDING_ERROR)
    except ImportError:
        return


def _on_session_end_hook(**kwargs: Any) -> None:
    """hermes ``on_session_end`` (turn_finalizer — end of EVERY
    run_conversation, incl. errored turns; SYNC, fires on the agent's worker
    thread). Routes into each live adapter's turn-completion glue."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_session_end(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] on_session_end glue failed")


def _on_post_approval_response_hook(**kwargs: Any) -> None:
    """hermes ``post_approval_response`` (SYNC; fires after any native
    dangerous-command approval resolution). Keeps the glasses approval mirror
    aligned when the user responds through Hermes' text fallback."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_post_approval_response(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break approvals
            logger.exception("[ocuclaw] post_approval_response glue failed")


def _on_pre_tool_call_hook(**kwargs: Any) -> None:
    """Hermes ``pre_tool_call`` observer. Emits the tool-start activity edge."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_pre_tool_call(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break tools
            logger.exception("[ocuclaw] pre_tool_call activity glue failed")


def _on_post_tool_call_hook(**kwargs: Any) -> None:
    """Hermes ``post_tool_call`` observer. Emits tool-result/error activity."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_post_tool_call(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break tools
            logger.exception("[ocuclaw] post_tool_call activity glue failed")


def _on_post_api_request_hook(**kwargs: Any) -> None:
    """Hermes ``post_api_request`` observer. Emits native reasoning summaries."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_post_api_request(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] post_api_request reasoning glue failed")


def _on_interim_message_hook(**kwargs: Any) -> None:
    """Hermes ``on_interim_message`` observer (0.20.5+). The agent's own
    mid-turn narration sentences, before the final reply."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_interim_message(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] on_interim_message narration glue failed")


def _on_stream_start_hook(**kwargs: Any) -> None:
    """Hermes ``on_stream_start`` observer (0.20.5+, opt-in)."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_stream_start(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] on_stream_start glue failed")


def _on_stream_delta_hook(**kwargs: Any) -> None:
    """Hermes ``on_stream_delta`` observer (0.20.5+, opt-in)."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_stream_delta(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] on_stream_delta glue failed")


def _on_stream_end_hook(**kwargs: Any) -> None:
    """Hermes ``on_stream_end`` observer (0.20.5+, opt-in)."""
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_stream_end(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] on_stream_end glue failed")


def _on_pre_transcription_hook(**kwargs: Any) -> Optional[Dict[str, str]]:
    """Hermes ``pre_transcription`` transform (0.20.6+). The seam that carries
    the wearer's language pick into Hermes's BUILT-IN STT backends, which
    re-resolve language from their own config load and so cannot see the
    in-memory overlay the `stt.transcribe` RPC hands the dispatcher.

    Unlike every other hook above this does NOT fan out to `_ADAPTERS`: its
    scope is one in-flight `stt.transcribe` call, not a platform instance. The
    STT lane publishes that call's picks on a contextvar around its own
    dispatch and this callback reads exactly that — so a transcription no
    OcuClaw handler started (an iMessage voice note, `hermes voice`, another
    platform's audio) finds the context unset and passes through untouched,
    with or without a live adapter. The isolation lives in `stt_rpc`, next to
    the contextvar it depends on; this is only the registration shim.
    """
    return pre_transcription_hook(**kwargs)


def _on_pre_llm_call_hook(**kwargs: Any) -> Optional[Dict[str, str]]:
    """Hermes ``pre_llm_call`` observer. Injects liveui voicemail/channel-2
    context into the current turn's USER message only."""
    for adapter in list(_ADAPTERS):
        try:
            context = adapter.handle_pre_llm_call(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] pre_llm_call liveui glue failed")
            continue
        if context:
            return {"context": context}
    return None


def _connected_adapter() -> Any:
    for adapter in reversed(list(_ADAPTERS)):
        if adapter.link_ready:
            return adapter
    raise RuntimeError("OcuClaw liveui runtime is not connected")


def _current_hermes_session_key() -> str:
    """Task-local Hermes session identity, absent outside an agent turn."""

    try:
        from gateway.session_context import get_session_env
    except Exception:  # noqa: BLE001 - setup remains available outside gateway turns
        return ""
    return str(get_session_env("HERMES_SESSION_KEY", "") or "").strip()


_HOST_SETUP_INTERFACES = frozenset({"local", "cli", "tui", "desktop"})


def _current_hermes_interface() -> str:
    """Return the live Hermes surface identity for the current agent turn."""

    session_key = _current_hermes_session_key()
    try:
        from gateway.session_context import get_session_env
    except Exception:  # noqa: BLE001 - legacy key parsing remains fail-closed
        get_session_env = None
    if callable(get_session_env):
        platform = str(
            get_session_env("HERMES_SESSION_PLATFORM", "") or ""
        ).strip().lower()
        source = str(
            get_session_env("HERMES_SESSION_SOURCE", "") or ""
        ).strip().lower()
        if platform:
            return platform
        if source:
            return source
    parts = session_key.split(":")
    return parts[2].strip().lower() if len(parts) >= 3 else ""


def _host_setup_session_available() -> bool:
    """Keep the setup tool on local Hermes interfaces only.

    A missing identity is the classic CLI/early TUI case. Any identified
    session must name one of Hermes's local interface platforms or sources;
    messaging, cron, and OcuClaw phone sessions fail closed. Native Hermes
    0.20.x host keys are opaque IDs, with their interface identity carried
    separately in ``HERMES_SESSION_SOURCE``.
    """

    session_key = _current_hermes_session_key()
    interface = _current_hermes_interface()
    if interface:
        return interface in _HOST_SETUP_INTERFACES
    return not session_key


def _liveui_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    try:
        adapter = _connected_adapter()
    except RuntimeError as exc:
        if not is_welcome_surface(args):
            raise
        session_key = _current_hermes_session_key()
        if not session_key or parse_ocuclaw_session_key(session_key) is None:
            raise
        proof = record_welcome_outcome(
            "error",
            hermes_release=CERTIFIED_HERMES_TAG,
            hermes_package_version=_hermes_version() or None,
            ocuclaw_version=_ocuclaw_version(),
            session_key=session_key,
        )
        return json.dumps(
            {"error": str(exc), "firstRunProof": proof},
            ensure_ascii=False,
        )
    return adapter.handle_liveui_tool_call(args)


def _liveui_state_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    adapter = _connected_adapter()
    return adapter.handle_liveui_state_tool_call(args)


def _liveui_template_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    adapter = _connected_adapter()
    return adapter.handle_liveui_template_tool_call(args)


def _liveui_task_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    adapter = _connected_adapter()
    return adapter.handle_liveui_task_tool_call(args)


def _liveui_descriptor_from_hello(
    hello: Dict[str, Any], tool_name: str = LIVEUI_TOOL_NAME
) -> Optional[Dict[str, Any]]:
    liveui = hello.get("liveui") if isinstance(hello, dict) else None
    if not isinstance(liveui, dict):
        return None
    tools = liveui.get("tools")
    if isinstance(tools, list):
        for item in tools:
            if isinstance(item, dict) and item.get("name") == tool_name:
                return item
    direct = liveui.get(tool_name)
    return direct if isinstance(direct, dict) else None


def _register_liveui_descriptor_from_hello(
    hello: Dict[str, Any],
    *,
    tool_name: str,
    handler: Any,
    log_label: str,
) -> bool:
    descriptor = _liveui_descriptor_from_hello(hello, tool_name)
    if not descriptor:
        logger.warning(
            "[ocuclaw] %s descriptor missing from runtime hello", log_label
        )
        return False
    schema = descriptor.get("schema")
    if not isinstance(schema, dict):
        logger.warning(
            "[ocuclaw] %s descriptor has no schema; tool not registered", log_label
        )
        return False
    name = str(descriptor.get("name") or tool_name)
    if name != tool_name:
        logger.warning(
            "[ocuclaw] unexpected %s tool name %r; tool not registered",
            log_label,
            name,
        )
        return False
    description = str(descriptor.get("description") or schema.get("description") or "")
    descriptor_toolset = str(descriptor.get("toolset") or "")
    if descriptor_toolset and descriptor_toolset != LIVEUI_TOOLSET:
        logger.warning(
            "[ocuclaw] ignoring %s descriptor toolset %r; using platform toolset %r",
            log_label,
            descriptor_toolset,
            LIVEUI_TOOLSET,
        )
    register_tool = _LIVEUI_REGISTER_TOOL
    if not callable(register_tool):
        logger.warning("[ocuclaw] ctx.register_tool unavailable; liveui degraded")
        return False
    register_tool(
        name=tool_name,
        toolset=LIVEUI_TOOLSET,
        schema=schema,
        handler=handler,
        check_fn=check_ocuclaw_requirements,
        is_async=False,
        description=description,
    )
    logger.info("[ocuclaw] %s tool registered from runtime descriptor", log_label)
    return True


def _warn_unregistered_liveui_descriptors(hello: Dict[str, Any]) -> None:
    liveui = hello.get("liveui") if isinstance(hello, dict) else None
    if not isinstance(liveui, dict):
        return
    tools = liveui.get("tools")
    descriptors = (
        [item for item in tools if isinstance(item, dict)]
        if isinstance(tools, list)
        else []
    )
    if not descriptors:
        descriptors = [
            liveui[name]
            for name in (
                LIVEUI_TOOL_NAME,
                LIVEUI_STATE_TOOL_NAME,
                LIVEUI_TEMPLATE_TOOL_NAME,
                LIVEUI_TASK_TOOL_NAME,
            )
            if isinstance(liveui.get(name), dict)
        ]
    registrations = {
        LIVEUI_TOOL_NAME: _LIVEUI_TOOL_REGISTERED,
        LIVEUI_STATE_TOOL_NAME: _LIVEUI_STATE_TOOL_REGISTERED,
        LIVEUI_TEMPLATE_TOOL_NAME: _LIVEUI_TEMPLATE_TOOL_REGISTERED,
        LIVEUI_TASK_TOOL_NAME: _LIVEUI_TASK_TOOL_REGISTERED,
    }
    for descriptor in descriptors:
        name = str(descriptor.get("name") or "").strip()
        if name and registrations.get(name, False):
            continue
        reason = (
            "registration did not complete"
            if name in registrations
            else "no Hermes adapter registration"
        )
        logger.warning(
            "[ocuclaw] liveui descriptor unregistered: name=%r reason=%s",
            name or "<missing>",
            reason if name else "descriptor name missing",
        )


def _register_liveui_tool_from_hello(hello: Dict[str, Any]) -> None:
    global _LIVEUI_TOOL_REGISTERED, _LIVEUI_STATE_TOOL_REGISTERED
    global _LIVEUI_TEMPLATE_TOOL_REGISTERED, _LIVEUI_TASK_TOOL_REGISTERED
    with _LIVEUI_LOCK:
        if not _LIVEUI_TOOL_REGISTERED:
            _LIVEUI_TOOL_REGISTERED = _register_liveui_descriptor_from_hello(
                hello,
                tool_name=LIVEUI_TOOL_NAME,
                handler=_liveui_tool_handler,
                log_label="liveui",
            )
        if not _LIVEUI_STATE_TOOL_REGISTERED:
            _LIVEUI_STATE_TOOL_REGISTERED = _register_liveui_descriptor_from_hello(
                hello,
                tool_name=LIVEUI_STATE_TOOL_NAME,
                handler=_liveui_state_tool_handler,
                log_label="liveui state",
            )
        if not _LIVEUI_TEMPLATE_TOOL_REGISTERED:
            _LIVEUI_TEMPLATE_TOOL_REGISTERED = (
                _register_liveui_descriptor_from_hello(
                    hello,
                    tool_name=LIVEUI_TEMPLATE_TOOL_NAME,
                    handler=_liveui_template_tool_handler,
                    log_label="liveui template",
                )
            )
        if not _LIVEUI_TASK_TOOL_REGISTERED:
            _LIVEUI_TASK_TOOL_REGISTERED = _register_liveui_descriptor_from_hello(
                hello,
                tool_name=LIVEUI_TASK_TOOL_NAME,
                handler=_liveui_task_tool_handler,
                log_label="liveui task",
            )
        _warn_unregistered_liveui_descriptors(hello)


def _liveui_render_link_timeout_s(settings: Dict[str, Any]) -> float:
    timeout_ms = settings.get("renderGlassesUiTimeoutMs")
    if not isinstance(timeout_ms, (int, float)) or timeout_ms <= 0:
        timeout_ms = LIVEUI_DEFAULT_RENDER_TIMEOUT_MS
    return float(timeout_ms) / 1000.0 + LIVEUI_RENDER_LINK_MARGIN_S


def _check_liveui_tool_timeout_budget(required_s: float) -> None:
    required_s = max(float(required_s), 1.0)
    raw = os.environ.get("HERMES_CONCURRENT_TOOL_TIMEOUT_S", "").strip()
    if not raw:
        logger.warning(
            "[ocuclaw] HERMES_CONCURRENT_TOOL_TIMEOUT_S is unset; "
            "render_glasses_ui can wait up to %.0fs on the liveui link, "
            "so set the Hermes tool timeout to at least that value if "
            "long renders are interrupted",
            required_s,
        )
        return
    try:
        value = float(raw)
    except ValueError:
        logger.warning(
            "[ocuclaw] HERMES_CONCURRENT_TOOL_TIMEOUT_S=%r is not numeric; "
            "render_glasses_ui can wait up to %.0fs on the liveui link",
            raw,
            required_s,
        )
        return
    if value > 0 and value < required_s:
        logger.warning(
            "[ocuclaw] HERMES_CONCURRENT_TOOL_TIMEOUT_S=%.0fs is below "
            "render_glasses_ui's %.0fs liveui link budget; long renders may "
            "be interrupted before the runtime returns",
            value,
            required_s,
        )


def _default_liveui_llm_system_prompt(max_chars: int, previous_body: str) -> str:
    return (
        "You are a tick worker producing a single short line of text for a "
        "head-mounted display surface. Reply with ONLY the new value to "
        "display, no preamble, no quotes, no JSON. Maximum "
        f"{max_chars} characters. Previous value: "
        f"{json.dumps(previous_body or '', ensure_ascii=False)}."
    )


def parse_version(raw: str) -> Optional[Tuple[int, int, int]]:
    """Parse ``major.minor.patch`` (extra suffixes tolerated) or None."""
    if not raw:
        return None
    parts = str(raw).strip().split(".")
    numbers: List[int] = []
    for part in parts[:3]:
        digits = ""
        for ch in part:
            if ch.isdigit():
                digits += ch
            else:
                break
        if not digits:
            return None
        numbers.append(int(digits))
    while len(numbers) < 3:
        numbers.append(0)
    return (numbers[0], numbers[1], numbers[2])


def hermes_version_supported(raw: str) -> bool:
    parsed = parse_version(raw)
    if parsed is None:
        return False
    return SUPPORTED_HERMES_MIN <= parsed < SUPPORTED_HERMES_MAX_EXCLUSIVE


def _supported_hermes_range() -> str:
    minimum = ".".join(map(str, SUPPORTED_HERMES_MIN))
    maximum = ".".join(map(str, SUPPORTED_HERMES_MAX_EXCLUSIVE))
    return f">={minimum},<{maximum}"


def _unsupported_hermes_message(version: str) -> str:
    return (
        f"Hermes {version or 'unknown'} is outside OcuClaw's certified "
        f"range {_supported_hermes_range()} (baseline "
        f"{CERTIFIED_HERMES_VERSION}, {CERTIFIED_HERMES_TAG}, "
        f"{CERTIFIED_HERMES_COMMIT}); the platform remains available for "
        "setup and diagnosis, but the Backend Adapter and Node child will "
        "not start"
    )


def _host_version_supported() -> bool:
    version = _hermes_version()
    return hermes_version_supported(version)


def _find_node() -> Optional[str]:
    try:
        from hermes_constants import find_node_executable

        return find_node_executable("node")
    except Exception:  # noqa: BLE001 — helper is hermes-version-sensitive
        import shutil

        return shutil.which("node")


def check_ocuclaw_requirements() -> bool:
    """Check host admission and the Node dependency.

    Config-dependent checks (entry file vs runtimeCommand override) live in
    ``validate_config``.
    """
    if not _host_version_supported():
        return False
    return _find_node() is not None


def _extra(config: Any) -> Dict[str, Any]:
    extra = getattr(config, "extra", None)
    return extra if isinstance(extra, dict) else {}


def resolve_even_ai_routing_mode(extra: Dict[str, Any]) -> str:
    """Total Hermes-ingress decision for ``extra.evenAiRoutingMode``.

    Every input lands in exactly one of two outcomes — accepted as one of
    ``EVEN_AI_ROUTING_MODES``, or rejected with ``ValueError``. Absent, null,
    and blank mean "unset" and take the code default; nothing else is
    silently rewritten, so no value reaches shared normalization by
    fall-through.
    """
    raw = extra.get("evenAiRoutingMode")
    if raw is None:
        return DEFAULT_EVEN_AI_ROUTING_MODE
    if not isinstance(raw, str):
        raise ValueError(
            "platforms.ocuclaw.extra.evenAiRoutingMode must be a string "
            f"({'|'.join(EVEN_AI_ROUTING_MODES)})"
        )
    value = raw.strip().lower()
    if not value:
        return DEFAULT_EVEN_AI_ROUTING_MODE
    if value not in EVEN_AI_ROUTING_MODES:
        raise ValueError(
            "platforms.ocuclaw.extra.evenAiRoutingMode must be one of "
            f"{', '.join(EVEN_AI_ROUTING_MODES)} (got {raw.strip()!r}); "
            "retired routing aliases are not accepted here"
        )
    return value


def resolve_adapter_settings(config: Any) -> Dict[str, Any]:
    """Resolve the adapter's settings from PlatformConfig.extra (pinned key
    paths: ``platforms.ocuclaw.extra.*``)."""
    extra = _extra(config)
    node = _find_node() or "node"
    default_argv = [node, str(DEFAULT_RUNTIME_ENTRY)]
    argv = resolve_runtime_argv(extra.get("runtimeCommand"), default_argv)

    def _float(key: str, fallback: float) -> float:
        try:
            value = float(extra.get(key))
            return value if value > 0 else fallback
        except (TypeError, ValueError):
            return fallback

    def _int(key: str, fallback: int) -> int:
        try:
            return int(extra.get(key))
        except (TypeError, ValueError):
            return fallback

    def _dict(key: str) -> Dict[str, Any]:
        value = extra.get(key)
        return value if isinstance(value, dict) else {}

    def _bool(key: str, fallback: bool) -> bool:
        value = extra.get(key)
        return value if isinstance(value, bool) else fallback

    def _list(key: str) -> Optional[List[Any]]:
        value = extra.get(key)
        return value if isinstance(value, list) else None

    home = _hermes_home()
    default_state_dir = str(home / "ocuclaw") if home is not None else ""
    render_timeout_ms = _int("renderGlassesUiTimeoutMs", 0)
    debug_upload_max_zip_bytes = min(
        4_300_000,
        max(100_000, _int("debugUploadMaxZipBytes", 4_000_000)),
    )
    return {
        "argv": argv,
        "usesDefaultArgv": not extra.get("runtimeCommand"),
        "wsPort": _int("wsPort", HERMES_BUNDLE_DEFAULT_WS_PORT),
        "wsBind": str(extra.get("wsBind") or HERMES_BUNDLE_DEFAULT_WS_BIND),
        "relayToken": str(extra.get("relayToken") or ""),
        "sonioxApiKey": str(extra.get("sonioxApiKey") or "").strip(),
        "stateDir": str(extra.get("stateDir") or default_state_dir),
        "glassesUiLive": _dict("glassesUiLive"),
        "renderGlassesUiTimeoutMs": render_timeout_ms if render_timeout_ms > 0 else None,
        # Ratified beta posture (#976/B8): Hermes explicitly enables the
        # support capture + phone handoff gates. These are chosen defaults,
        # not relay-core's historical missing-option inversion.
        "externalDebugToolsEnabled": _bool("externalDebugToolsEnabled", True),
        "debugAutoArm": _bool("debugAutoArm", False),
        "allowDebugUpload": _bool("allowDebugUpload", True),
        "debugUploadMaxZipBytes": debug_upload_max_zip_bytes,
        "debugUploadCapturePreset": _list("debugUploadCapturePreset"),
        "debugBundleSaveDir": str(extra.get("debugBundleSaveDir") or ""),
        "evenAiEnabled": _bool("evenAiEnabled", False),
        "evenAiToken": str(extra.get("evenAiToken") or "").strip(),
        "evenAiSystemPrompt": str(extra.get("evenAiSystemPrompt") or "").strip(),
        "evenAiRequestTimeoutMs": _int("evenAiRequestTimeoutMs", 60_000),
        "evenAiMaxBodyBytes": _int("evenAiMaxBodyBytes", 65_536),
        "evenAiDedupWindowMs": _int("evenAiDedupWindowMs", 500),
        "evenAiRoutingMode": resolve_even_ai_routing_mode(extra),
        "evenAiDedicatedSessionKey": str(
            extra.get("evenAiDedicatedSessionKey") or ""
        ).strip(),
        "staleTurnSeconds": _float("staleTurnSeconds", DEFAULT_STALE_TURN_SECONDS),
        "runtimeReadyTimeoutS": _float(
            "runtimeReadyTimeoutS", RUNTIME_READY_TIMEOUT_S
        ),
        "handshakeTimeoutS": _float("handshakeTimeoutS", LINK_HANDSHAKE_TIMEOUT_S),
        "terminateGraceS": _float("terminateGraceS", LINK_TERMINATE_GRACE_S),
        "linkDebugStderr": bool(extra.get("linkDebugStderr")),
    }


def _child_runtime_config(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Return the deliberately narrow Node-child config handshake."""
    return {
        "wsPort": settings["wsPort"],
        "wsBind": settings["wsBind"],
        "relayToken": settings["relayToken"],
        "sonioxApiKey": settings["sonioxApiKey"],
        "stateDir": settings["stateDir"],
        "glassesUiLive": settings["glassesUiLive"],
        "renderGlassesUiTimeoutMs": settings["renderGlassesUiTimeoutMs"],
        "externalDebugToolsEnabled": settings["externalDebugToolsEnabled"],
        "debugAutoArm": settings["debugAutoArm"],
        "allowDebugUpload": settings["allowDebugUpload"],
        "debugUploadMaxZipBytes": settings["debugUploadMaxZipBytes"],
        "debugUploadCapturePreset": settings["debugUploadCapturePreset"],
        "debugBundleSaveDir": settings["debugBundleSaveDir"],
        "evenAiEnabled": settings["evenAiEnabled"],
        "evenAiToken": settings["evenAiToken"],
        "evenAiSystemPrompt": settings["evenAiSystemPrompt"],
        "evenAiRequestTimeoutMs": settings["evenAiRequestTimeoutMs"],
        "evenAiMaxBodyBytes": settings["evenAiMaxBodyBytes"],
        "evenAiDedupWindowMs": settings["evenAiDedupWindowMs"],
        "evenAiRoutingMode": settings["evenAiRoutingMode"],
        "evenAiDedicatedSessionKey": settings["evenAiDedicatedSessionKey"],
    }


def validate_ocuclaw_config(config: Any) -> bool:
    if not _host_version_supported():
        return False
    try:
        settings = resolve_adapter_settings(config)
    except ValueError as exc:
        logger.warning("[ocuclaw] invalid config: %s", exc)
        return False
    if settings["usesDefaultArgv"] and not DEFAULT_RUNTIME_ENTRY.is_file():
        logger.warning(
            "[ocuclaw] runtime entry missing at %s (bundle packaged without "
            "dist-cjs?) — set platforms.ocuclaw.extra.runtimeCommand or "
            "reinstall the bundle",
            DEFAULT_RUNTIME_ENTRY,
        )
        return False
    if not settings["relayToken"]:
        # The relay worker transport constant-time-compares this token for
        # every downstream client; an unset token rejects everyone, so refuse
        # to boot half-configured (same required-token UX as the OpenClaw
        # bundle's plugins.entries.ocuclaw.config.relayToken).
        if is_managed_profile():
            logger.warning("[ocuclaw] %s", MANAGED_CREDENTIAL_REQUIRED_MESSAGE)
        else:
            logger.warning(
                "[ocuclaw] the host-managed Relay Credential is missing — use "
                "/ocuclaw-setup and its locally confirmed all-device reset",
            )
        return False
    if settings["evenAiEnabled"] and not settings["evenAiToken"]:
        logger.warning(
            "[ocuclaw] platforms.ocuclaw.extra.evenAiToken is required when "
            "evenAiEnabled is true",
        )
        return False
    return True


def _is_connected(config: Any) -> bool:
    # Ownership boundary (#1312): `extra["relayToken"]` is ALSO how Hermes
    # delivers the `.env` secret — `_env_enablement()` seeds exactly this key
    # onto the platform extra. At this seam an env-seeded token and a
    # yaml-authored one are indistinguishable, so dropping the extra read to
    # make this "env-only" would break the supported `.env` path outright.
    # Telling them apart means re-reading raw config.yaml and diffing it
    # against the env layering that Hermes 0.20 owns — a config-contract
    # change, not a local fix. #1312 removes yaml as a *reported* secret
    # source; the residual that a pre-existing yaml token still boots while
    # `_setup_status` reports `relay_token_missing` is tracked as follow-up.
    env_relay_token = os.environ.get(OCUCLAW_RELAY_TOKEN_ENV, "").strip()
    if env_relay_token:
        return True
    extra = getattr(config, "extra", {}) if config is not None else {}
    relay_token = str((extra or {}).get("relayToken") or "").strip()
    return bool(relay_token)


def _env_enablement() -> Optional[Dict[str, str]]:
    seed = {
        adapter_key: value
        for env_name, adapter_key in _SECRET_ENV_TO_ADAPTER_KEY.items()
        if (value := os.environ.get(env_name, "").strip())
    }
    return seed or None


def _hermes_version() -> str:
    try:
        from hermes_cli import __version__

        return __version__
    except Exception:  # noqa: BLE001
        return ""


def setup_ocuclaw_platform() -> None:
    """Confirm host-managed relay state, then configure optional secrets."""
    version = _hermes_version()
    if not hermes_version_supported(version):
        print(f"OcuClaw setup: {_unsupported_hermes_message(version)}.")
        return
    relay_present = _setup_secret_present(OCUCLAW_RELAY_TOKEN_ENV)
    if not relay_present:
        bootstrap_status = bootstrap_relay_credential()
        relay_present = _setup_secret_present(OCUCLAW_RELAY_TOKEN_ENV)
        if not relay_present:
            if bootstrap_status == BOOTSTRAP_MANAGED_MISSING:
                print(MANAGED_CREDENTIAL_REQUIRED_MESSAGE)
            elif is_profile_established():
                print(
                    "This established profile's Relay Credential is missing or "
                    "unreadable. OcuClaw stopped setup rather than silently "
                    "disconnect every paired phone. Use /ocuclaw-setup and its "
                    "locally confirmed all-device reset."
                )
            else:
                print(
                    "OcuClaw could not generate the host-managed Relay Credential. "
                    "There is no credential to enter; use /ocuclaw-setup for "
                    "guided recovery."
                )
            return
    if relay_present:
        print(
            "The Relay Credential is host-managed and was preserved. To replace it, "
            "use /ocuclaw-setup and its locally confirmed all-device reset."
        )
    try:
        from hermes_cli.cli_output import prompt
        from hermes_cli.config import save_env_value
    except Exception:  # noqa: BLE001 - setup must retain its recovery handoff
        print(
            "Optional masked credential setup could not be completed; diagnostics "
            "and Relay Credential recovery remain available."
        )
    else:
        print("Optional Soniox and Even AI credentials use Hermes's masked prompts.")
        secret_prompts = (
            (
                OCUCLAW_SONIOX_API_KEY_ENV,
                "Soniox API key",
                "Soniox API key (optional; Enter to skip)",
            ),
            (
                OCUCLAW_EVEN_AI_TOKEN_ENV,
                "Even AI token",
                "Even AI token (optional; Enter to skip)",
            ),
        )
        for env_name, label, question in secret_prompts:
            already_present = _setup_secret_present(env_name)
            try:
                if already_present:
                    print(
                        f"A configured {label} is present. Enter a replacement "
                        "or press Enter to keep it."
                    )
                else:
                    print(f"No {label} is configured; this integration is optional.")
                value = str(prompt(question, password=True) or "").strip()
                if value:
                    save_env_value(env_name, value)
                    print(f"OcuClaw {label} saved through Hermes's .env contract.")
                elif already_present:
                    print(f"Existing OcuClaw {label} configuration kept.")
                else:
                    print(f"Optional {label} setup skipped.")
            except Exception:  # noqa: BLE001 - isolate each optional setup lane
                print(
                    f"OcuClaw {label} setup could not be completed; continuing "
                    "with the remaining masked prompts."
                )
    print("Restart explicitly with: hermes gateway restart")
    print("After Hermes restarts, then run /ocuclaw-setup.")


def _setup_secret_present(env_name: str) -> bool:
    try:
        from hermes_cli.config import get_env_value

        return bool(str(get_env_value(env_name) or "").strip())
    except Exception:  # noqa: BLE001 - status must remain available fail-soft
        return bool(os.environ.get(env_name, "").strip())


def _secret_presence_inventory() -> Dict[str, bool]:
    """Presence booleans for the three OcuClaw secrets.

    The only supported store is Hermes's ``.env`` contract (the Hermes-managed
    secret env file, falling back to the process environment); a secret counts
    as present when it holds a non-empty value there. The legacy yaml
    ``platforms.ocuclaw.extra.*`` keys are deliberately not consulted — a yaml
    key never counts as a configured secret on any surface. Only the boolean
    crosses this seam — never a value, length, prefix, or mask — so every
    surface that renders the inventory is secret-free by construction.
    """
    return {
        adapter_key: _setup_secret_present(env_name)
        for env_name, adapter_key in _SECRET_ENV_TO_ADAPTER_KEY.items()
    }


def _setup_raw_config() -> Tuple[Dict[str, Any], bool]:
    try:
        from hermes_cli.config import read_raw_config

        config = read_raw_config()
        return (config if isinstance(config, dict) else {}), True
    except Exception:  # noqa: BLE001 - doctor reports unreadable config safely
        return {}, False


def _ocuclaw_version() -> Optional[str]:
    """The OcuClaw train version, read from the bundle manifest.

    Read rather than duplicated: a second copy of the version in Python is a
    second thing to forget on a release, and the manifest is the one the
    publish lane already treats as authoritative.
    """
    try:
        text = (BUNDLE_DIR / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:  # noqa: BLE001 - a missing manifest degrades, never raises
        return None
    match = re.search(r"^version:\s*([^\s#]+)", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def _collect_gateway_facts() -> Dict[str, Any]:
    """Read Hermes's own profile-scoped ``gateway_state.json``, qualified.

    Per #1277 this receipt is a **coarse last-observed adapter-state
    snapshot**, not a liveness clock. So the collector separates the two
    things the old reader conflated: what the receipt *says* (the platform
    state and when it changed) and whether the process that wrote it is
    *still the live one* (the independently validated PID/start-time guard).
    The freshness policy over those facts belongs to the deriver, which is
    the only place it can be read against the contract.
    """
    facts: Dict[str, Any] = {
        "gatewayLive": None,
        "gatewayAdapterState": None,
        "gatewayAdapterEnabled": None,
        "gatewayAdapterObservedAt": None,
        "gatewayReceiptUpdatedAt": None,
        "gatewayReceiptStatus": "missing",
    }
    record, status, live = read_gateway_state()
    facts["gatewayReceiptStatus"] = status
    if status != "ok" or not isinstance(record, dict):
        return facts

    updated_at = record.get("updated_at")
    facts["gatewayReceiptUpdatedAt"] = (
        updated_at if isinstance(updated_at, str) else None
    )
    facts["gatewayLive"] = live

    platforms = record.get("platforms")
    platform = platforms.get(PLATFORM_NAME) if isinstance(platforms, dict) else None
    if isinstance(platform, dict):
        state = platform.get("state")
        if isinstance(state, str) and state.strip():
            facts["gatewayAdapterState"] = state.strip()
        enabled = platform.get("enabled")
        facts["gatewayAdapterEnabled"] = enabled if isinstance(enabled, bool) else None
        observed = platform.get("updated_at")
        facts["gatewayAdapterObservedAt"] = (
            observed if isinstance(observed, str) else None
        )
    return facts


def _collect_health_facts(
    *, observation_mode: str = OBSERVATION_PASSIVE
) -> Dict[str, Any]:
    """The impure half of the collect/derive split (#1273 P1).

    Everything that touches config, the filesystem, the process table, or
    adapter state happens here and nowhere else; the result is a plain dict
    matching the frozen v1 facts key set. Both derivations downstream —
    the snapshot and the transitional setup block — are then pure functions
    of this dict, which is what makes them fixture-testable (test seam 1).

    Passive by construction: no probe, no network call, no mutation. An
    active observation is the caller's explicit choice (doctor), made by
    overriding the probe-fed facts after collection.
    """
    return health_collect.collect_health_facts(
        observation_mode=observation_mode,
        adapters=list(_ADAPTERS),
        setup_raw_config_fn=_setup_raw_config,
        hermes_version_fn=_hermes_version,
        supported_fn=hermes_version_supported,
        supported_range_fn=_supported_hermes_range,
        secret_inventory_fn=_secret_presence_inventory,
        node_fn=_find_node,
        ocuclaw_version_fn=_ocuclaw_version,
        profile_name_fn=_profile_name,
        resolve_home_fn=resolve_receipt_home,
        read_presence_fn=read_app_presence,
        read_proof_fn=read_first_run_proof,
        gateway_facts_fn=_collect_gateway_facts,
        serve_facts_fn=_collect_serve_facts,
        runtime_entry=DEFAULT_RUNTIME_ENTRY,
    )


def _collect_serve_facts(
    extra: Mapping[str, Any], relay_port_valid: bool
) -> Dict[str, Any]:
    """Classify this host's Tailscale Serve configuration (#1319).

    Two bounded, read-only `tailscale` reads, classified against the JSON
    contract captured from two CLI minors. Passive by the collector's
    definition: it queries the local tailscaled socket the way the rest of
    collection reads local config files, makes no network call, and cannot
    mutate Serve — :mod:`serve` builds no mutating argv at all.

    Configuration shape only. `serveReachable` and `serveApplicationReady`
    are deliberately left where :func:`blank_facts` put them, because a
    configured route is empirically not a working one (#1275): they belong to
    doctor's bounded probe, and a passive collector claiming them would be
    exactly the conflation the tailnet leg exists to prevent.
    """
    relay_port: Optional[int] = None
    if relay_port_valid:
        try:
            relay_port = int(extra.get("wsPort", HERMES_BUNDLE_DEFAULT_WS_PORT))
        except (TypeError, ValueError):  # pragma: no cover - guarded upstream
            relay_port = None

    try:
        observed = serve.observe(relay_port=relay_port)
    except Exception:  # noqa: BLE001 - diagnosis must not become an outage
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
        # Stamped only because something was actually read. A classification
        # the reader could not reach carries no observation stamp, and the
        # deriver reads an unstamped classification as "nobody looked".
        "serveObservedAt": (
            snapshot_now_iso() if observed.read_code == serve.READ_OK else None
        ),
        "serveNodeDnsName": observed.dns_name,
        "serveRelayPort": observed.relay_port,
        "serveReason": observed.reason,
        "serveReadCode": observed.read_code,
    }


def _profile_name(home: Optional[Path]) -> Optional[str]:
    """Name the exact profile this home belongs to, without disclosing a path.

    Hermes lays secondary profiles out as ``<root>/profiles/<name>``; anything
    else is the default profile. The name is rendered, the path never is.
    """
    if home is None:
        return None
    try:
        return home.name if home.parent.name == "profiles" else "default"
    except (OSError, ValueError):  # pragma: no cover - defensive
        return None


def connection_health_snapshot(
    *, observation_mode: str = OBSERVATION_PASSIVE
) -> Dict[str, Any]:
    """Compose one Connection Health Snapshot v1: collect, then derive.

    The composition entrypoint every presenter shares (#1273 P1). Callers
    that already hold facts — fixtures, the CLI collecting in-process, a
    doctor run merging probe results — call :func:`derive_snapshot` directly
    instead of coming through here.
    """
    return derive_snapshot(_collect_health_facts(observation_mode=observation_mode))


def support_connection_health_document() -> Dict[str, Any]:
    """Exact passive snapshot or its static, secret-free error document."""
    try:
        return connection_health_snapshot()
    except Exception:  # noqa: BLE001 - support capture must survive diagnosis
        logger.warning("[ocuclaw] passive support snapshot unavailable")
        return error_envelope(
            "snapshot_unavailable",
            "The passive Connection Health Snapshot could not be generated.",
        )


def _safe_snapshot(facts: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Derive for a surface that must not fail because diagnosis did.

    The setup tool's job is to be reachable when things are broken, so a
    derivation bug degrades that surface to its legacy block instead of
    turning a diagnostic into a second outage.
    """
    try:
        return derive_snapshot(facts)
    except Exception:  # noqa: BLE001 - never raise through an agent turn
        logger.exception("[ocuclaw] connection health snapshot unavailable")
        return None


def _setup_status(facts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The `ocuclaw_setup` status block — now a pure derivation of facts.

    Same output, same ladder, same field names: retiring the mixed ladder is
    #1318's atomic removal, not this PR's. What changed is that it and the
    snapshot now read one collector, so the two can no longer disagree about
    what the host looks like. ``facts`` lets a caller that already collected
    reuse them rather than observe the host twice in one turn.
    """
    status = derive_legacy_setup_status(
        facts if facts is not None else _collect_health_facts()
    )
    raw_config, config_readable = _setup_raw_config()
    # Guide readiness is independent of connection health. Read only this
    # non-secret, profile-scoped leaf; a running gateway cannot prove it.
    display: Any = raw_config
    for key in ("display", "platforms", "ocuclaw"):
        display = display.get(key) if isinstance(display, dict) else None
    tool_progress = display.get("tool_progress") if isinstance(display, dict) else None
    tool_progress_off = config_readable and (
        tool_progress is False or tool_progress == "off"
    )
    gateway = raw_config.get("gateway")
    multiplex = gateway.get("multiplex_profiles") if isinstance(gateway, dict) else None
    mode_config: Any = raw_config
    for key in ("platforms", "ocuclaw", "extra"):
        mode_config = mode_config.get(key) if isinstance(mode_config, dict) else None
    agent_mode = mode_config.get("agent_mode") if isinstance(mode_config, dict) else None
    agent_mode_chosen = config_readable and isinstance(multiplex, bool) and (
        (agent_mode == "multiple" and multiplex is True)
        or (agent_mode == "single" and multiplex is False)
    )
    # Continue here (#2509): `platforms.ocuclaw.extra.allow_admin_from` must
    # list the adapter's one wearer id, on fresh AND existing installs — the
    # setup skill writes it; every beta without it hits `admin_not_configured`.
    adopt_ok = config_readable and adopt_configured(mode_config)
    status["mandatoryConfiguration"] = {
        "state": (
            "verified"
            if tool_progress_off and agent_mode_chosen and adopt_ok
            else "missing"
            if config_readable
            else "unknown"
        ),
        "toolProgressOff": tool_progress_off,
        "agentModeChosen": agent_mode_chosen,
        "agentMode": agent_mode if agent_mode_chosen else None,
        "adoptConfigured": adopt_ok,
    }
    plugins = raw_config.get("plugins")
    stream_reasoning_deltas_set = (
        isinstance(plugins, dict)
        and plugins.get("stream_reasoning_deltas") is True
    )
    status["hermesHooks"] = {
        "interimMessageAvailable": bool(INTERIM_HOOK_AVAILABLE),
        "streamHooksAvailable": bool(STREAM_HOOKS_AVAILABLE),
        "streamReasoningDeltas": stream_reasoning_deltas_set,
        "streamReasoningDeltasOffer": _stream_reasoning_deltas_offer(
            configured=stream_reasoning_deltas_set,
            hooks_available=bool(STREAM_HOOKS_AVAILABLE),
            config_readable=config_readable,
        ),
        "registered": list(_hermes_feature_tokens()),
    }
    status["desktopTheme"] = _desktop_theme_status(raw_config, config_readable)
    status["desktopCredentials"] = desktop_credentials.status()
    status["sessionReadState"] = bool(session_read_state_supported())
    return status


def _setup_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    try:
        return _setup_tool_handler_impl(args, **_kwargs)
    except Exception:  # noqa: BLE001 - never raise through an agent turn
        operation = str((args or {}).get("operation") or "").strip()
        logger.exception("[ocuclaw] setup status unavailable")
        return json.dumps(
            {
                "ok": False,
                "operation": operation or None,
                "error": {
                    "code": "status_unavailable",
                    "message": "OcuClaw setup status could not be inspected safely.",
                },
            },
            sort_keys=True,
        )


def _stream_deltas_operation_receipt(args: Dict[str, Any]) -> Dict[str, Any]:
    """The one WRITING setup operation, gated on an explicit operator yes.

    Two gates, both structural rather than advisory: the tool refuses without
    ``confirm: true`` (so a status-shaped drive-by call can never flip a
    gateway-wide key), and it refuses on a host whose hook vocabulary has no
    reasoning-delta hooks (so nobody ends up with an inert key they will later
    have to explain).
    """
    operation = SETUP_STREAM_DELTAS_OPERATION
    if (args or {}).get("confirm") is not True:
        return {
            "ok": False,
            "operation": operation,
            "status": _setup_status(),
            "error": {
                "code": "confirmation_required",
                "message": (
                    f"{STREAM_DELTAS_SCOPE_NOTE} Ask the operator, then repeat "
                    "this call with confirm: true."
                ),
            },
        }

    before = _setup_status()
    hooks = before.get("hermesHooks")
    hooks = hooks if isinstance(hooks, dict) else {}
    if not hooks.get("streamHooksAvailable"):
        return {
            "ok": False,
            "operation": operation,
            "status": before,
            "error": {
                "code": "stream_hooks_unavailable",
                "message": STREAM_DELTAS_INERT_NOTE,
            },
        }

    result = _enable_stream_reasoning_deltas()
    receipt: Dict[str, Any] = {
        "ok": result.get("reason") in {"written", "already_enabled"},
        "operation": operation,
        "streamReasoningDeltas": result,
        "status": _setup_status(),
    }
    if not receipt["ok"]:
        receipt["error"] = {
            "code": str(result.get("reason") or "config_unwritable"),
            "message": str(result.get("message") or ""),
        }
    return receipt


def _verified_in_session_pairing_address() -> Tuple[Optional[str], str]:
    """Actively prove this profile's private route, then derive its address."""
    try:
        from . import doctor as doctor_lane
        from .cli import CLAIM_OWNED, _default_replacement_safe

        facts = _collect_health_facts()
        if facts.get("profileResolved") is not True:
            return None, "profile_unresolved"
        facts, _outcomes = doctor_lane.observe(
            facts, probed_at=snapshot_now_iso()
        )
        snapshot = derive_snapshot(facts)
        setup = snapshot.get("setup") or {}
        legs = ((snapshot.get("currentHealth") or {}).get("legs") or {})
        gateway = legs.get("hermesGateway") or {}
        relay = legs.get("ocuclawRelay") or {}
        route = legs.get("tailnetRoute") or {}
        phone = legs.get("phoneApp") or {}
        if setup.get("state") != "configured":
            return None, "setup_not_configured"
        if gateway.get("state") != "healthy":
            return None, "gateway_not_healthy"
        if relay.get("state") != "healthy":
            return None, "relay_not_healthy"
        if route.get("classification") != "ready" or not all(
            route.get(key) == "yes"
            for key in ("configured", "reachable", "applicationReady")
        ):
            return None, "tailnet_route_not_verified"
        if _default_replacement_safe(facts) != CLAIM_OWNED:
            return None, "tailnet_route_not_owned"
        if phone.get("state") == "healthy":
            return None, "phone_already_connected"
        dns_name = serve.normalize_dns_name(facts.get("serveNodeDnsName"))
        if dns_name is None or not dns_name.endswith(".ts.net"):
            return None, "tailnet_identity_unavailable"
        address = serve.phone_address(dns_name=dns_name)
        return (address, "ready") if address else (None, "address_unavailable")
    except Exception:  # noqa: BLE001 - pairing must fail closed on uncertainty
        logger.exception("[ocuclaw] in-session pairing address verification failed")
        return None, "verification_failed"


def _run_setup_pairing_action() -> Dict[str, Any]:
    """Stage the direct-human ceremony on the live supported host surface."""
    interface = _current_hermes_interface()
    if interface not in {"tui", "desktop"}:
        return {
            "ok": False,
            "state": "refused",
            "code": "tui_required",
            "message": (
                "Secure in-window pairing requires Hermes TUI or Desktop. Exit "
                "this classic window, start bare `hermes` without `--cli` or "
                "open Hermes Desktop, run `/ocuclaw-setup`, and resume this "
                "pairing checkpoint; completed setup state is preserved."
            ),
        }
    address, reason = _verified_in_session_pairing_address()
    if address is None:
        return {
            "ok": False,
            "state": "refused",
            "code": reason,
            "message": (
                "The private phone route is not fully verified yet. Run the "
                "current setup checkpoint, then retry pairing."
            ),
        }
    from .pairing import _control_url

    if interface == "desktop":
        from .desktop_pairing import run_desktop_pairing

        return run_desktop_pairing(address, control_url=_control_url())
    from .tui_pairing import run_tui_pairing
    return run_tui_pairing(
        address,
        control_url=_control_url(),
        owner_tui_pid=os.getppid(),
    )


def _setup_journey(
    snapshot: Any, attempt: Any, mandatory_configuration: Any = None
) -> Dict[str, str]:
    snap = snapshot if isinstance(snapshot, dict) else {}
    setup = snap.get("setup") if isinstance(snap.get("setup"), dict) else {}
    health = (
        snap.get("currentHealth")
        if isinstance(snap.get("currentHealth"), dict)
        else {}
    )
    legs = health.get("legs") if isinstance(health.get("legs"), dict) else {}
    proof = (
        snap.get("firstRunProof")
        if isinstance(snap.get("firstRunProof"), dict)
        else {}
    )
    attempt_state = (
        str(attempt.get("state") or "") if isinstance(attempt, dict) else ""
    )
    if proof.get("state") == "proven" or attempt_state == "committed":
        checkpoint = "optional-integrations"
    elif attempt_state == "armed":
        checkpoint = "welcome-round-trip"
    elif setup.get("state") != "configured":
        checkpoint = "prerequisites-and-configuration"
    elif not isinstance(mandatory_configuration, dict) or mandatory_configuration.get("toolProgressOff") is not True:
        checkpoint = "mandatory-configuration"
    elif mandatory_configuration.get("agentModeChosen") is False:
        checkpoint = "mandatory-configuration"
    elif mandatory_configuration.get("adoptConfigured") is False:
        checkpoint = "mandatory-configuration"
    elif any(
        (legs.get(name) or {}).get("state") != "healthy"
        for name in ("hermesGateway", "ocuclawRelay")
    ):
        checkpoint = "restart-and-relay-verification"
    elif (legs.get("tailnetRoute") or {}).get("classification") != "ready":
        checkpoint = "tailnet-route"
    elif (legs.get("phoneApp") or {}).get("state") != "healthy":
        checkpoint = "secure-phone-pairing"
    else:
        checkpoint = "phone-origin-proof"
    return {
        "owner": "host",
        "nextCheckpoint": checkpoint,
        "phoneRole": "test-message-and-wearer-confirmation-only",
    }


def _desktop_theme_operation_receipt(args: Dict[str, Any]) -> Dict[str, Any]:
    """The second WRITING setup operation: apply the OcuClaw look on Desktop.

    Same confirm gate as the stream-deltas opt-in, plus one structural refusal:
    without an OcuClaw-owned Desktop plugin file on disk there is nothing to
    render the answer into, so the tool says so instead of recording a yes that
    could never land.
    """
    operation = SETUP_DESKTOP_THEME_OPERATION
    if (args or {}).get("confirm") is not True:
        return {
            "ok": False,
            "operation": operation,
            "status": _setup_status(),
            "error": {
                "code": "confirmation_required",
                "message": (
                    f"{DESKTOP_THEME_SCOPE_NOTE} Ask the operator, then repeat "
                    "this call with confirm: true."
                ),
            },
        }

    before = _setup_status()
    theme = before.get("desktopTheme")
    theme = theme if isinstance(theme, dict) else {}
    if theme.get("offer") == DESKTOP_THEME_OFFER_UNAVAILABLE:
        return {
            "ok": False,
            "operation": operation,
            "status": before,
            "error": {
                "code": "desktop_plugin_unavailable",
                "message": (
                    "The OcuClaw Desktop plugin is not installed on this "
                    "profile, so the theme cannot be applied. Restart the "
                    "gateway (it installs the plugin) and retry."
                ),
            },
        }

    result = _enable_desktop_theme()
    receipt: Dict[str, Any] = {
        "ok": result.get("applied") is True,
        "operation": operation,
        "desktopTheme": result,
        "status": _setup_status(),
    }
    if not receipt["ok"]:
        receipt["error"] = {
            "code": str(result.get("reason") or "config_unwritable"),
            "message": str(result.get("message") or ""),
        }
    return receipt


def _setup_tool_handler_impl(args: Dict[str, Any], **_kwargs: Any) -> str:
    operation = str((args or {}).get("operation") or "").strip()
    if operation not in set(SETUP_OPERATIONS):
        return json.dumps(
            {
                "ok": False,
                "operation": operation or None,
                "error": {
                    "code": "unsupported_operation",
                    "message": "Choose one of the documented setup operations.",
                },
            },
            sort_keys=True,
        )

    session_key = _current_hermes_session_key()
    phone_session = parse_ocuclaw_session_key(session_key) is not None
    if not _host_setup_session_available():
        return json.dumps(
            {
                "ok": False,
                "operation": operation,
                "error": {
                    "code": "host_session_required",
                    "message": (
                        "OcuClaw setup stays in the host Hermes conversation. "
                        "Return there and say 'continue OcuClaw setup' (or "
                        "start `/ocuclaw-setup` there). The phone/G2 is used "
                        "only for the test message, display confirmation, and "
                        "welcome dismissal."
                    ),
                },
            },
            sort_keys=True,
        )
    if operation == SETUP_STREAM_DELTAS_OPERATION:
        return json.dumps(
            _stream_deltas_operation_receipt(args or {}), sort_keys=True
        )
    if operation == SETUP_DESKTOP_THEME_OPERATION:
        return json.dumps(
            _desktop_theme_operation_receipt(args or {}), sort_keys=True
        )
    if operation == SETUP_EVEN_AI_ROUTE_OPERATION:
        return json.dumps(_setup_even_ai_route_receipt(), sort_keys=True)
    if operation == "request_credentials":
        if set(args) - {"operation", "integrations"}:
            result = {"state": "invalid_request"}
        elif _current_hermes_interface() != "desktop":
            result = {"state": "desktop_required"}
        elif not _desktop_plugin_presence()[1]:
            result = {"state": "desktop_unavailable"}
        else:
            result = desktop_credentials.request(args.get("integrations"))
        return json.dumps({"ok": result.get("state") == "pending", "operation": operation,
                           "desktopCredentials": result}, sort_keys=True)
    attempt_session_key = session_key if phone_session else None
    pairing_action = None
    if operation == "pair_phone":
        pairing_action = _run_setup_pairing_action()
    phone_origin_action = None
    if operation == "wait_phone_origin":
        phone_origin_action = wait_for_phone_turn_candidate()
    first_run_action = None
    if operation in {"arm_first_run_proof", "welcome_round_trip"}:
        existing_attempt = (
            inspect_attempt(
                hermes_release=CERTIFIED_HERMES_TAG,
                hermes_package_version=_hermes_version() or None,
                ocuclaw_version=_ocuclaw_version(),
                session_key=attempt_session_key,
            )
            if operation == "welcome_round_trip"
            else None
        )
        if (
            existing_attempt is not None
            and existing_attempt.get("state") == "armed"
            and existing_attempt.get("resumeAllowed") is True
        ):
            first_run_action = {**existing_attempt, "armed": True}
        else:
            candidate_id = str((args or {}).get("phoneCandidateId") or "").strip()
            if (
                len(candidate_id) != 64
                or any(char not in "0123456789abcdef" for char in candidate_id)
            ):
                return json.dumps(
                    {
                        "ok": False,
                        "operation": operation,
                        "error": {
                            "code": "phone_candidate_binding_required",
                            "message": (
                                "Wait for a new phone-origin turn first, retain its "
                                "opaque candidate binding, then retry the welcome "
                                "round trip with that exact binding."
                            ),
                        },
                    },
                    sort_keys=True,
                )
            first_run_action = arm_first_run_proof_from_candidate(
                hermes_release=CERTIFIED_HERMES_TAG,
                hermes_package_version=_hermes_version() or None,
                ocuclaw_version=_ocuclaw_version(),
                expected_candidate_id=candidate_id,
            )
        if str(first_run_action.get("state") or "").startswith("phone_turn_"):
            return json.dumps(
                {
                    "ok": False,
                    "operation": operation,
                    "error": {
                        "code": "phone_turn_required",
                        "message": (
                            "Send a message from the OcuClaw phone app, confirm "
                            "its reply appeared on the Even G2, then continue "
                            "setup here on the host."
                        ),
                        "reason": first_run_action.get("state"),
                    },
                },
                sort_keys=True,
            )
        if first_run_action.get("armed") is True:
            first_run_action["welcomeDelivery"] = (
                wait_for_first_run_terminal(
                    hermes_release=CERTIFIED_HERMES_TAG,
                    hermes_package_version=_hermes_version() or None,
                    ocuclaw_version=_ocuclaw_version(),
                )
                if operation == "welcome_round_trip"
                else {"state": "queued", "owner": "managed-gateway"}
            )
        elif operation == "welcome_round_trip" and first_run_action.get("committed") is True:
            first_run_action["welcomeDelivery"] = {
                "state": "committed",
                "committed": True,
                "provenAt": first_run_action.get("provenAt"),
            }

    # One observation of the host, two renderings of it (#1273 P1). The
    # snapshot rides alongside the legacy block rather than replacing it:
    # #1318 owns retiring `ok`/`status`/`bundle` atomically, and until then
    # every consumer that wants v1 truth can already read it here.
    facts = _collect_health_facts()
    operation_ok = pairing_action.get("ok") is True if pairing_action else True
    if phone_origin_action is not None:
        operation_ok = phone_origin_action.get("received") is True
    if operation == "arm_first_run_proof" and first_run_action is not None:
        operation_ok = (
            first_run_action.get("armed") is True
            or first_run_action.get("committed") is True
        )
    if operation == "welcome_round_trip" and first_run_action is not None:
        operation_ok = first_run_action.get("welcomeDelivery", {}).get("committed") is True
    receipt: Dict[str, Any] = {
        "ok": operation_ok,
        "operation": operation,
        "status": _setup_status(facts),
    }
    snapshot_v1 = _safe_snapshot(facts)
    if snapshot_v1 is not None:
        receipt["snapshot"] = snapshot_v1
    if operation in {
        "status",
        "fresh_install",
        "pair_phone",
        "wait_phone_origin",
        "arm_first_run_proof",
        "welcome_round_trip",
    }:
        receipt["contract"] = {
            "guideVersion": SETUP_GUIDE_VERSION,
            "skillLoad": SETUP_SKILL_LOAD_POINTER,
        }
        receipt["firstRunProofAttempt"] = inspect_attempt(
            hermes_release=CERTIFIED_HERMES_TAG,
            hermes_package_version=_hermes_version() or None,
            ocuclaw_version=_ocuclaw_version(),
            session_key=attempt_session_key,
        )
        receipt["journey"] = _setup_journey(
            snapshot_v1,
            receipt["firstRunProofAttempt"],
            receipt["status"]["mandatoryConfiguration"],
        )
    if first_run_action is not None:
        receipt["firstRunProofAction"] = first_run_action
    if pairing_action is not None:
        receipt["pairingAction"] = pairing_action
    if phone_origin_action is not None:
        receipt["phoneOriginAction"] = phone_origin_action
    if operation == "doctor":
        receipt["bundle"] = dict(_LAST_SETUP_BUNDLE_REPORT)
    if operation in SETUP_REFERENCE_FILES:
        filename, heading = SETUP_REFERENCE_FILES[operation]
        try:
            content = (
                BUNDLE_DIR
                / "skills"
                / SETUP_SKILL_NAME
                / "references"
                / filename
            ).read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001 - never raise through an agent turn
            logger.exception("[ocuclaw] setup reference unavailable: %s", filename)
            return json.dumps(
                {
                    "ok": False,
                    "operation": operation,
                    "status": receipt["status"],
                    "error": {
                        "code": "guidance_unavailable",
                        "message": "The requested bundled setup guidance is unavailable; reinstall OcuClaw.",
                    },
                },
                sort_keys=True,
            )
        receipt["guidance"] = {
            "topic": operation,
            "heading": heading,
            "content": content,
        }
    return json.dumps(receipt, sort_keys=True)


def _setup_even_ai_route_receipt() -> Dict[str, Any]:
    """Expose the read-only live :8443 classifier to the setup assistant."""
    raw_config, readable = _setup_raw_config()
    if not readable:
        return {
            "ok": False,
            "operation": SETUP_EVEN_AI_ROUTE_OPERATION,
            "error": {
                "code": "config_unreadable",
                "message": "Hermes configuration could not be read; no route will be changed.",
            },
        }
    node: Any = raw_config
    for key in ("platforms", "ocuclaw", "extra"):
        if not isinstance(node, Mapping):
            node = {}
            break
        node = node.get(key, {})
    raw_port = (
        node.get("wsPort", HERMES_BUNDLE_DEFAULT_WS_PORT)
        if isinstance(node, Mapping)
        else None
    )
    if (
        not isinstance(raw_port, int)
        or isinstance(raw_port, bool)
        or not 1 <= raw_port <= 65535
    ):
        return {
            "ok": False,
            "operation": SETUP_EVEN_AI_ROUTE_OPERATION,
            "error": {
                "code": "relay_port_unknown",
                "message": "Hermes relay port is unreadable; no route will be changed.",
            },
        }
    decision = even_ai_route.plan_live(relay_port=raw_port)
    return {
        "ok": decision.state != "refused",
        "operation": SETUP_EVEN_AI_ROUTE_OPERATION,
        "route": decision._asdict(),
    }


def _admitted_adapter_factory(config: Any):
    if not _host_version_supported():
        return None
    return _build_adapter(config)


def _admitted_is_connected(config: Any) -> bool:
    return _host_version_supported() and _is_connected(config)


def register(ctx: Any) -> None:
    global _LAST_SETUP_BUNDLE_REPORT, _PLUGIN_CONTEXT, _LIVEUI_REGISTER_TOOL
    _PLUGIN_CONTEXT = ctx
    version = _hermes_version()
    if parse_version(version) is None:
        raise RuntimeError(
            "ocuclaw plugin could not read the Hermes version; refusing to "
            "register against an unknown plugin ABI"
        )
    register_platform = getattr(ctx, "register_platform", None)
    if not callable(register_platform):
        raise RuntimeError(
            "ocuclaw plugin requires ctx.register_platform (hermes "
            f"{version} exposes no platform registration surface)"
        )
    supported = hermes_version_supported(version)
    if supported:
        bootstrap_status = bootstrap_relay_credential()
        if bootstrap_status == BOOTSTRAP_ESTABLISHED_MISSING:
            logger.warning(
                "[ocuclaw] established profile Relay Credential is missing; "
                "setup must use the locally confirmed all-device reset"
            )
        elif bootstrap_status == BOOTSTRAP_MANAGED_MISSING:
            logger.warning("[ocuclaw] %s", MANAGED_CREDENTIAL_REQUIRED_MESSAGE)
        elif bootstrap_status in {BOOTSTRAP_FAILED, BOOTSTRAP_UNAVAILABLE}:
            logger.warning(
                "[ocuclaw] host-managed Relay Credential bootstrap did not "
                "complete (%s); relay admission remains closed",
                bootstrap_status,
            )
    platform_kwargs = {
        "name": PLATFORM_NAME,
        "label": PLATFORM_LABEL,
        "adapter_factory": _admitted_adapter_factory,
        "check_fn": check_ocuclaw_requirements,
        "validate_config": validate_ocuclaw_config,
        "setup_fn": setup_ocuclaw_platform,
        "is_connected": _admitted_is_connected,
        "allowed_users_env": OCUCLAW_ALLOWED_USERS_ENV,
        "allow_all_env": OCUCLAW_ALLOW_ALL_USERS_ENV,
        # Registry-level half of the P19 update refusal: hermes must never
        # treat ocuclaw as a platform its /update command may run from. The
        # adapter refuses first with wearer-readable wording; this closes the
        # gate for any path that reaches hermes without passing through
        # handle_dispatch.
        "allow_update_command": False,
        "platform_hint": (
            "This session is delivered through OcuClaw on an Even G2 576x288 "
            "display."
        ),
        "env_enablement_fn": _env_enablement,
    }
    try:
        register_platform(**platform_kwargs)
    except TypeError as exc:
        if supported:
            raise
        raise RuntimeError(_unsupported_hermes_message(version)) from exc
    if supported:
        register_system_prompt_section = getattr(
            ctx, "register_system_prompt_section", None
        )
        if not callable(register_system_prompt_section):
            raise RuntimeError(
                "ocuclaw plugin requires ctx.register_system_prompt_section "
                f"(hermes {version} exposes no registered prompt surface)"
            )
        register_system_prompt_section(
            OCUCLAW_READABILITY_SECTION_ID,
            OCUCLAW_READABILITY_SYSTEM_PROMPT,
            position="after_memory",
            max_chars=4000,
        )
    register_skill = getattr(ctx, "register_skill", None)
    setup_skill_registered = False
    if callable(register_skill):
        try:
            register_skill(
                SETUP_SKILL_NAME,
                SETUP_SKILL_PATH,
                SETUP_SKILL_DESCRIPTION,
            )
            setup_skill_registered = True
        except Exception as exc:  # noqa: BLE001 - keep other recovery surfaces
            logger.warning(
                "[ocuclaw] setup skill registration failed: %s",
                exc,
            )
    else:
        logger.warning(
            "[ocuclaw] ctx.register_skill unavailable — /ocuclaw-setup "
            "bootstrap is unavailable"
        )
    register_tool = getattr(ctx, "register_tool", None)
    if callable(register_tool):
        try:
            register_tool(
                name=SETUP_TOOL_NAME,
                toolset=SETUP_TOOLSET,
                schema=SETUP_TOOL_SCHEMA,
                handler=_setup_tool_handler,
                check_fn=_host_setup_session_available,
                requires_env=None,
                is_async=False,
                description=SETUP_TOOL_DESCRIPTION,
            )
        except Exception as exc:  # noqa: BLE001 - keep other recovery surfaces
            logger.warning("[ocuclaw] setup tool registration failed: %s", exc)
    else:
        logger.warning("[ocuclaw] ctx.register_tool unavailable — setup tool omitted")
    # The plugin-owned `hermes ocuclaw` CLI (#1318 plus full uninstall).
    # Registered on the same side of
    # the support gate as the setup tool and the recovery platform row,
    # deliberately: the command whose whole job is to tell a user their host
    # is unsupported is worthless if an unsupported host is where it stops
    # being installed. It reads local facts and derives — it registers no
    # hook, holds no ABI surface beyond `register_cli_command` itself, and
    # that call is guarded.
    register_cli_commands(ctx, logger)
    if setup_skill_registered:
        try:
            bundle_report = reconcile_setup_bundle()
            _LAST_SETUP_BUNDLE_REPORT = (
                json.loads(json.dumps(dict(bundle_report), default=str))
                if isinstance(bundle_report, dict)
                else {"status": "error", "error": "invalid reconciliation receipt"}
            )
        except Exception as exc:  # noqa: BLE001 - registration must remain usable
            _LAST_SETUP_BUNDLE_REPORT = {
                "status": "error",
                "error": "bundle reconciliation raised unexpectedly",
            }
            logger.warning(
                "[ocuclaw] /ocuclaw-setup bundle reconciliation failed: %s",
                exc,
            )
    else:
        _LAST_SETUP_BUNDLE_REPORT = {
            "status": "unavailable",
            "reason": "setup-skill-registration-failed",
        }
        logger.warning(
            "[ocuclaw] /ocuclaw-setup bundle reconciliation skipped because "
            "the qualified setup skill was not registered"
        )
    if supported:
        try:
            widget_report = reconcile_pairing_widget()
            if widget_report.get("status") not in TUI_WIDGET_RECONCILE_OK:
                logger.warning(
                    "[ocuclaw] TUI pairing widget unavailable: %s",
                    widget_report.get("reason") or widget_report.get("status"),
                )
        except Exception as exc:  # noqa: BLE001 - registration stays fail-soft
            logger.warning("[ocuclaw] TUI pairing widget reconciliation failed: %s", exc)
        try:
            desktop_report = reconcile_pairing_plugin()
            if desktop_report.get("status") not in DESKTOP_PLUGIN_RECONCILE_OK:
                logger.warning(
                    "[ocuclaw] Desktop pairing presenter unavailable: %s",
                    desktop_report.get("reason") or desktop_report.get("status"),
                )
        except Exception as exc:  # noqa: BLE001 - registration stays fail-soft
            logger.warning("[ocuclaw] Desktop pairing presenter reconciliation failed: %s", exc)
        # #2085: reconciling our own runtime says nothing about what ELSE
        # Hermes Desktop can load. An Agent update converges the 0.21 hybrid
        # layout only because the package update removes the nested
        # `plugins/ocuclaw/desktop/plugin.js` entry; if that did not happen,
        # two live plugins share the one `ocuclaw` id and last-loaded-wins
        # decides the UI. Enumerate both diskRoots() doors and say so loudly,
        # naming the exact file to delete. Registration still continues —
        # refusing to register would cost the user the whole platform over a
        # stale UI copy — but the line must be impossible to skim past.
        try:
            convergence_message = desktop_convergence_message(desktop_convergence())
            if convergence_message:
                logger.error("[ocuclaw] %s", convergence_message)
        except Exception as exc:  # noqa: BLE001 - registration stays fail-soft
            logger.warning(
                "[ocuclaw] Desktop runtime convergence check failed: %s", exc
            )
    if not supported:
        logger.warning("[ocuclaw] %s", _unsupported_hermes_message(version))
        # The recovery platform row and diagnostic setup function are the only
        # certified unsupported-host surface. Do not install turn hooks or a
        # LiveUI tool against an unverified plugin ABI.
        return
    # Turn-completion spine (W06): per-turn on_session_end backs the
    # agent_end host hook, terminal activity, and the tail commit. Hooks
    # register once at plugin load; the handler fans out to live adapters.
    global _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE
    global STREAM_HOOKS_AVAILABLE, INTERIM_HOOK_AVAILABLE
    global PRE_TRANSCRIPTION_HOOK_AVAILABLE
    global _REGISTERED_OPTIONAL_FEATURES
    register_hook = getattr(ctx, "register_hook", None)
    # Probe BEFORE registering: hermes stores unknown hook names with a
    # warning instead of refusing them, so registering blind would spam the
    # log on every 0.20.0 host and advertise a feature that can never fire.
    STREAM_HOOKS_AVAILABLE, INTERIM_HOOK_AVAILABLE = _probe_optional_hook_support()
    PRE_TRANSCRIPTION_HOOK_AVAILABLE = _pre_transcription_hook_supported()
    _REGISTERED_OPTIONAL_FEATURES = ()
    with _LIVEUI_LOCK:
        _LIVEUI_REGISTER_TOOL = register_tool if callable(register_tool) else None
    if callable(register_hook):
        register_hook(REGISTERED_HOOK_NAMES[0], _on_session_end_hook)
        # Native approval responses can arrive through typed /approve-/deny
        # fallback or interrupt-deny, outside the glasses button path.
        register_hook(REGISTERED_HOOK_NAMES[1], _on_post_approval_response_hook)
        # W10: tool activity rides Hermes native hook metadata. Args are only
        # attached to the start edge; completion/error metadata comes from post.
        register_hook(REGISTERED_HOOK_NAMES[2], _on_pre_tool_call_hook)
        register_hook(REGISTERED_HOOK_NAMES[3], _on_post_tool_call_hook)
        register_hook(REGISTERED_HOOK_NAMES[4], _on_post_api_request_hook)
        register_hook(REGISTERED_HOOK_NAMES[5], _on_pre_llm_call_hook)
        if INTERIM_HOOK_AVAILABLE:
            # Transport-neutral: `has_stream_observer_hooks` enumerates only
            # on_stream_*, so registering this one changes no provider call
            # shape for any surface on this gateway.
            register_hook(INTERIM_HOOK_NAME, _on_interim_message_hook)
            _REGISTERED_OPTIONAL_FEATURES += (FEATURE_TOKEN_INTERIM_HOOK,)
        # Registering any on_stream_* hook flips hermes's process-wide
        # `_has_stream_consumers`, which changes the provider call shape for
        # EVERY surface on this gateway. So it is gated twice: the host must
        # have the hooks AND the operator must have already opted in with
        # `plugins.stream_reasoning_deltas: true`. A user who did not opt in
        # sees no transport change.
        if STREAM_HOOKS_AVAILABLE and _stream_reasoning_deltas_configured():
            register_hook(STREAM_HOOK_NAMES[0], _on_stream_start_hook)
            register_hook(STREAM_HOOK_NAMES[1], _on_stream_delta_hook)
            register_hook(STREAM_HOOK_NAMES[2], _on_stream_end_hook)
            _REGISTERED_OPTIONAL_FEATURES += (FEATURE_TOKEN_STREAM_HOOKS,)
        if PRE_TRANSCRIPTION_HOOK_AVAILABLE:
            # Registered gateway-wide, but inert by construction: the callback
            # answers only while the `stt.transcribe` RPC has published the
            # current call's picks on its contextvar (stt_rpc
            # `_scoped_call_tweaks`), and returns None — no kwargs read, no
            # dispatch changed — for every other transcription on this host.
            # Unlike the on_stream_* family it flips no process-wide provider
            # call shape: `_apply_pre_transcription_hook` is `has_hook`-gated
            # per dispatch, so the only cost to a non-OcuClaw transcription is
            # one dict probe and one no-op call.
            register_hook(PRE_TRANSCRIPTION_HOOK_NAME, _on_pre_transcription_hook)
        _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = True
    else:
        _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = False
        logger.warning(
            "[ocuclaw] ctx.register_hook unavailable — turn completion "
            "(agent_end/terminal activity/tail commit) is degraded to the "
            "stale-turn janitor"
        )
    # NOT a hook, and deliberately outside the register_hook block: the
    # sessions db lane serves read/hidden state off the running hermes's own
    # schema + SessionDB primitives (session_rpc D1 probe), which touches no
    # DB and is valid here — registration precedes the child spawn that reads
    # `_REGISTERED_OPTIONAL_FEATURES` into OCUCLAW_HERMES_FEATURES.
    if session_read_state_supported():
        _REGISTERED_OPTIONAL_FEATURES += (FEATURE_TOKEN_SESSION_READ_STATE,)
    logger.info(
        "[ocuclaw] platform registered (hermes %s, optional hooks: %s)",
        version,
        ",".join(_hermes_feature_tokens()) or "none",
    )


async def _handle_pairing_completed(params: Any) -> Dict[str, Any]:
    """Idempotently write the Node-minted authenticated completion ID."""

    if not isinstance(params, Mapping) or set(params) != {"completionId"}:
        return {"ok": False, "error": "invalid_params"}
    try:
        await asyncio.to_thread(
            record_pairing_completion, completion_id=params["completionId"]
        )
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid_params"}
    except ReceiptUnavailableError:
        logger.warning("[ocuclaw] pairing completion receipt unavailable")
        return {"ok": False, "error": "receipt_unavailable"}
    return {"ok": True}


def _build_adapter(config: Any):
    # Deferred import: keeps this module importable (for framing tests and
    # version-gate units) outside a hermes environment.
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult

    class OcuClawAdapter(BasePlatformAdapter):
        """Platform adapter: supervises the Node runtime child and owns the
        W06 turn-dispatch/event plane (D9 correlation ledger).

        supports_async_delivery stays True (base default): the Node runtime
        holds the persistent glasses/phone connections.
        """

        # Avoid StreamConsumer oversize splits — glasses paging owns long
        # text; a 60k-char message stays far under the 1 MiB link frame cap.
        MAX_MESSAGE_LENGTH = 60000
        # Native connection controls identify the actual administrative adapter,
        # never a platform name supplied by a remote management request.
        _ocuclaw_management_path = True

        def __init__(self, platform_config, platform) -> None:
            # Hermes 0.20 constructs secondary-profile adapters under a
            # context-local HERMES_HOME override. OcuClaw owns
            # one relay listener, so a second instance must fail before it can
            # spawn the Node child; the gateway logs and skips that adapter.
            _guard_secondary_port_binding_scope()
            super().__init__(platform_config, platform)
            self._settings = resolve_adapter_settings(platform_config)
            _check_liveui_tool_timeout_budget(
                _liveui_render_link_timeout_s(self._settings)
            )
            self._link: Optional[LinkProcess] = None
            # W06 dispatch plane (D9): runId correlation authority.
            self._namespace = DEFAULT_SESSION_NAMESPACE
            self._ledger = DispatchLedger(
                stale_turn_seconds=self._settings["staleTurnSeconds"],
            )
            self._session_status = SessionStatusObserver()
            self._phone_turn_candidate_gate = PhoneTurnCandidateGate()
            self._multiplex_enabled = False
            self._served_profile_homes: Dict[str, Path] = {}
            self._refresh_profile_routing()
            # Sessions-plane SessionDB glue: the default reader is preserved
            # byte-for-byte outside multiplex; secondary readers are lazy.
            self._session_rpc = ProfileSessionRpc(
                default_db_path=default_state_db_path(),
                routing_provider=self._profile_routing_snapshot,
                # Hermes injects the public SessionStore after construction
                # and before connect. Resolve lazily so current prompt-token
                # reads use that live, persisted authority.
                session_store_provider=lambda _namespace: getattr(
                    self, "_session_store", None
                ),
            )
            # Continue here (#2509): one-shot waiters keyed by the minted adopt
            # chat id — `send()` hands the `/resume` slash reply to the waiting
            # handler instead of the wearer — and the tips being adopted right
            # now (a second tap on the same row is `own_lane_busy`).
            self._adopt_waiters: Dict[str, asyncio.Future] = {}
            self._adopting_tips: set = set()
            # Tier 0 in-flight signal (T2 #2510): session_id → {at, platform}
            # for EVERY platform this gateway runs (fed by pre_llm_call /
            # tool hooks BEFORE their ocuclaw platform filter, cleared by
            # on_session_end, TTL-expired as the fail-safe). Zero idle cost:
            # no timer — expiry is checked lazily on read.
            self._inflight: Dict[str, Dict[str, Any]] = {}
            self._inflight_lock = threading.Lock()
            # W07 models/status/config read plane (gw.* lanes).
            self._gw_rpc = GwRpc(
                namespace=self._namespace,
                routing_provider=self._profile_routing_snapshot,
                adopt_supported_provider=self.adopt_configured,
            )
            self._gw_rpc._management_adapter = self
            # STT lane (#1938): what the connected Hermes can transcribe with.
            self._stt_rpc = SttRpc()
            self._loop: Optional[asyncio.AbstractEventLoop] = None
            self._janitor_task: Optional[asyncio.Task] = None
            self._first_run_welcome_task: Optional[asyncio.Task] = None
            self._message_seq = 0
            # Per-process uniqueness for the minted platform message id
            # (#1691) — see `_next_message_id`.
            self._message_id_nonce = uuid.uuid4().hex[:8]
            self._stream_tail_lock = threading.RLock()
            self._stream_tail_closures: Dict[Tuple[str, str], Dict[str, Any]] = {}
            self._stream_tail_tasks: Dict[Tuple[str, str], asyncio.Task] = {}
            # Set under _stream_tail_lock during disconnect: refuses new
            # closure stashes so the shutdown drain can run to empty.
            self._stream_tail_closing = False
            self._thinking_lock = threading.RLock()
            self._thinking_text_by_run: Dict[str, str] = {}
            # Per-run monotonic ordering stamp for the tier-2 thinking lane.
            # It orders THINKING frames only and is deliberately never stamped
            # onto `activity` frames: `activity.seq` is already an
            # activityId-scoped staleness guard on both the Node adapter and
            # the client, and a thinking-only counter would fight it.
            self._thinking_seq_by_run: Dict[str, int] = {}
            # Narration tagging is CONTENT-based, never timing-based: the
            # on_interim_message hook runs on its own worker thread while the
            # commit is produced by the consumer's asyncio queue, so there is
            # no ordering guarantee in either direction. Both sides consult
            # the same normalized-text set under _thinking_lock.
            self._narration_texts_by_run: Dict[str, set] = {}
            # normalized narration text -> the sentence AS WRITTEN, so a commit
            # that landed a mid-reveal prefix can be upgraded to it (#1619).
            self._narration_raw_by_run: Dict[str, Dict[str, str]] = {}
            self._committed_texts_by_run: Dict[str, List[str]] = {}
            # normalized committed text -> the platform message id that commit
            # carried (#1691), so a retag can name the message outright
            # instead of asking the consumer to re-find it by text.
            self._committed_ids_by_run: Dict[str, Dict[str, str]] = {}
            # Tool progress is identified by lifecycle, never by parsing its
            # user-facing copy. pre_tool_call arms the next send while that
            # tool is live; send() binds its minted message id. The run keeps
            # one arm until claimed so even a very fast command is covered.
            self._pending_tool_progress_by_run: Dict[str, List[str]] = {}
            self._tool_progress_message_ids_by_run: Dict[str, set] = {}
            # #1619 origin time. Hermes commits an interim message LAZILY — the
            # commit rides the next send(), which on a tool turn is the tool
            # progress line, so the note reaches the page AFTER the command it
            # announces. The commit timestamp is therefore useless for
            # ordering. These two maps carry the honest one:
            #   _stream_text_origin_by_run: FIFO of "first content delta of a
            #     model call" wall-clock stamps, i.e. when the model started
            #     producing that assistant message.
            #   _narration_origin_by_run: normalized narration text → the
            #     stamp it claimed, so every carrier of the same sentence
            #     (hook, `_interim_send` send, commit, retag) reports the SAME
            #     origin.
            # Empty on a host without the stream hooks; the note then falls
            # back to the moment the adapter first learned of it, which is
            # still the streaming paint, never the lazy commit.
            self._stream_text_origin_by_run: Dict[str, List[int]] = {}
            self._narration_origin_by_run: Dict[str, Dict[str, int]] = {}
            # Reasoning-stream state, keyed (session_id, turn_id): identity is
            # resolved ONCE per stream (a SessionDB RPC per delta is not a
            # budget) and the coalescer buffer lives here too.
            self._stream_contexts: Dict[Tuple[str, str], Dict[str, Any]] = {}
            self._background_hook_turns: Dict[Tuple[str, str], None] = {}
            # Reconcile epoch per run. post_api_request is authoritative and
            # runs INLINE on the agent thread, so it can beat deltas that are
            # still sitting in the plugin hook queue; bumping the epoch fences
            # those stale deltas out instead of letting them append a fragment
            # that the authoritative text already contains.
            self._thinking_epoch_by_run: Dict[str, int] = {}
            # Exactly what the delta stream appended to the cumulative buffer
            # since the last reconcile, so post_api_request can REPLACE that
            # tail with its authoritative text instead of appending a second
            # copy of the same reasoning.
            self._stream_appended_by_run: Dict[str, str] = {}
            # Runs whose thinking pane is open (an update went out, no
            # finalize yet). Whichever of on_stream_end / post_api_request
            # arrives first closes it; the other sees an empty set and stays
            # quiet, so a call never emits two finalizes.
            self._open_pane_runs: set = set()
            self._background_restore_tasks: set[asyncio.Task] = set()
            self._approval_lock = threading.RLock()
            self._approval_seq = 0
            self._approvals_by_id: Dict[str, Dict[str, Any]] = {}
            self._approval_order_by_session: Dict[str, List[str]] = {}
            self._approval_timers: Dict[str, Any] = {}
            self._approval_expiry_tasks: set[asyncio.Task] = set()
            self._approval_resolve_locks: Dict[str, asyncio.Lock] = {}
            self._profile_options_locks: Dict[str, asyncio.Lock] = {}
            self._approval_suppressed_responses: Dict[str, List[Dict[str, Any]]] = {}
            self._approval_drain_generation: Dict[str, int] = {}
            self._approval_drained_ids: Dict[str, float] = {}
            self._mirrored_native_entry_ids: Dict[str, set[int]] = {}
            self._approval_resolution_tombstones: Dict[str, List[Dict[str, Any]]] = {}
            self._slash_confirms_by_id: Dict[str, Dict[str, str]] = {}
            self._approval_response_hook_available = (
                _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE
            )
            self._error_sweep_tasks: set[asyncio.Task] = set()
            # Per-connect boot receipt (runtime.ready); _on_child_exit sets
            # it so a dead child wakes the connect() wait immediately.
            self._runtime_ready_event: Optional[asyncio.Event] = None
            # Owns the OcuClaw app-presence receipt for this connect (#1317).
            self._presence: Optional[PresencePump] = None
            _ADAPTERS.append(self)

        @property
        def authorization_is_upstream(self) -> bool:
            # The Node relay constant-time-checks relayToken for every
            # downstream client BEFORE any event reaches this adapter — the
            # documented trusted-authenticated-upstream lane (authz_mixin),
            # so non-internal glasses turns pass the gateway sender-auth gate
            # without the DM pairing flow.
            return True

        @property
        def link_ready(self) -> bool:
            return self._link is not None and self._link.ready

        def _build_presence_pump(self) -> PresencePump:
            """Bind the pump to this connect's home, link, and epoch.

            The home is resolved once per connect rather than per write: a
            receipt that changed profile mid-run would be worse than no
            receipt, and re-resolving on every 30-second tick invites exactly
            that. Both collaborators are closures over ``self._link`` read at
            call time, so a link that dies mid-pull surfaces as a failed pull
            (and an honest null-facts receipt) instead of a stale handle.
            """
            home = resolve_receipt_home()
            fingerprint = fingerprint_home(home)

            async def _pull() -> Any:
                link = self._link
                if link is None or not link.ready:
                    # Typed so the receipt records `link_down` rather than the
                    # generic `pull_failed`: "the link is gone" and "the relay's
                    # presence method failed" need different repairs.
                    raise PresenceLinkUnavailableError("control link not ready")
                return await link.request(
                    PRESENCE_SNAPSHOT_METHOD, None, timeout_s=PULL_TIMEOUT_S
                )

            def _write(body: Dict[str, Any]) -> None:
                if home is None:
                    # Resolution failed at connect, so the fingerprint this
                    # pump stamps is None. Passing that None through would
                    # ask the writer to resolve a home *now* and publish a
                    # profile-less record into it — overwriting a valid
                    # receipt with one that every reader must then reject as
                    # wrong-profile. No home at connect, no receipt.
                    raise ReceiptUnavailableError(
                        "no profile-scoped Hermes home resolved at connect"
                    )
                write_app_presence(body, home=home)

            return PresencePump(
                pull=_pull,
                write=_write,
                profile_fingerprint=fingerprint,
                epoch=int(time.time() * 1000),
                log=logger,
            )

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            if self._link is not None and self._link.ready:
                logger.info(
                    "[ocuclaw] connect(is_reconnect=%s): link already up (pid=%s)",
                    is_reconnect,
                    self._link.pid,
                )
                return True
            if self._link is not None:
                await self._link.terminate()
                self._link = None
            self._refresh_profile_routing()
            settings = self._settings
            state_dir = settings["stateDir"]
            if state_dir:
                try:
                    Path(state_dir).mkdir(parents=True, exist_ok=True)
                except OSError as exc:
                    logger.warning(
                        "[ocuclaw] could not create stateDir %s: %s", state_dir, exc
                    )
            child_config = _child_runtime_config(
                {**settings, "stateDir": state_dir}
            )
            # The current OcuClaw client intentionally exposes Hermes model,
            # reasoning, and fast controls as profile-wide settings. Do not
            # advertise the future session API until the client also owns its
            # confirmation-required UX and has been recertified against a
            # public Hermes release containing that API.
            child_config["sessionOptionsSupported"] = False
            link = LinkProcess(
                settings["argv"],
                hello_ack_payload={
                    "hermesVersion": _hermes_version(),
                    "platform": PLATFORM_NAME,
                    "config": child_config,
                },
                handshake_timeout_s=settings["handshakeTimeoutS"],
                terminate_grace_s=settings["terminateGraceS"],
                env=default_child_env(
                    base_env=os.environ,
                    handshake_timeout_s=settings["handshakeTimeoutS"],
                    debug_stderr=settings["linkDebugStderr"],
                    # Registration truth, not host capability: the child
                    # turns these into client capability tokens, and a row
                    # that says "active" for a hook nobody registered is a
                    # lie the wearer cannot check.
                    hermes_features=",".join(_hermes_feature_tokens()),
                ),
                log=logger,
                on_exit=self._on_child_exit,
            )
            # Child-initiated RPC lanes must be live before the child can
            # speak (the bridge may issue db.*/dispatch requests right after
            # the handshake completes).
            for method, handler in self._session_rpc.handlers().items():
                link.register_request_handler(method, handler)
            # Observe the existing authorized profile fan-out; never broaden
            # its namespace or session visibility rules for status tracking.
            link.register_request_handler("db.sessions.list", self.handle_status_sessions_list)
            for method, handler in self._gw_rpc.handlers().items():
                link.register_request_handler(method, handler)
            from .restart_rpc import RestartRpc
            self._restart_rpc = RestartRpc(self, self._gw_rpc)
            link.register_request_handler("gw.hermes.management", self._restart_rpc.handle)
            for method, handler in self._stt_rpc.handlers().items():
                link.register_request_handler(method, handler)
            link.register_request_handler(
                FOREIGN_COPY_METHOD, self.handle_foreign_copy
            )
            link.register_request_handler(
                FOREIGN_ADOPT_METHOD, self.handle_foreign_adopt
            )
            link.register_request_handler(
                FOREIGN_DRIVER_METHOD, self.handle_foreign_driver
            )
            # Overrides the bare session_rpc handler: the mirror needs the
            # tier-0 in-flight verdict next to the watermark (#2513).
            link.register_request_handler(
                DB_METHOD_CHAT_WATERMARK, self.handle_chat_watermark
            )
            link.register_request_handler(
                APPROVAL_RESOLVE_METHOD, self.handle_approval_resolve
            )
            link.register_request_handler(
                SLASH_CONFIRM_RESOLVE_METHOD, self.handle_slash_confirm_resolve
            )
            link.register_request_handler(
                CLARIFY_RESOLVE_METHOD, self.handle_clarify_resolve
            )
            link.register_request_handler(
                CLARIFY_AWAIT_TEXT_METHOD, self.handle_clarify_await_text
            )
            link.register_request_handler(
                SESSION_ABORT_METHOD, self.handle_sessions_abort
            )
            link.register_request_handler(
                SESSION_STEER_METHOD, self.handle_sessions_steer
            )
            link.register_request_handler(
                SESSION_OPTIONS_APPLY_METHOD, self.handle_sessions_options_apply
            )
            link.register_request_handler(
                PROFILE_OPTIONS_GET_METHOD, self.handle_profile_options_get
            )
            link.register_request_handler(
                PROFILE_OPTIONS_APPLY_METHOD, self.handle_profile_options_apply
            )
            link.register_request_handler(DISPATCH_METHOD, self.handle_dispatch)
            link.register_request_handler(
                LIVEUI_LLM_AUTH_METHOD, self.handle_liveui_llm_auth
            )
            link.register_request_handler(
                LIVEUI_LLM_RECIPE_METHOD, self.handle_liveui_llm_recipe
            )
            runtime_ready: asyncio.Event = asyncio.Event()
            self._runtime_ready_event = runtime_ready

            async def _on_runtime_ready(_params: Any) -> Dict[str, Any]:
                runtime_ready.set()
                return {"ok": True}

            link.register_request_handler("runtime.ready", _on_runtime_ready)

            async def _on_connection_health_snapshot(_params: Any) -> Dict[str, Any]:
                """Passive support attachment; never enters doctor's probe lane."""
                return await asyncio.to_thread(support_connection_health_document)

            link.register_request_handler(
                "connectionHealth.snapshot", _on_connection_health_snapshot
            )
            # Authenticated pairing completion carries only its secret-free
            # receipt identity and must be registered before the child can emit
            # it during handshake-adjacent relay startup.
            link.register_request_handler(
                PAIRING_COMPLETED_METHOD, _handle_pairing_completed
            )
            # The presence lane must be live BEFORE the child can speak: a
            # phone that is already connected when the relay boots produces a
            # push during the handshake window, and a `-32601` there would
            # cost exactly the post-pairing delay this hop exists to remove.
            self._presence = self._build_presence_pump()
            link.register_request_handler(
                PRESENCE_DIRTY_METHOD, self._presence.handle_dirty
            )
            try:
                hello = await link.start()
            except LinkError as exc:
                logger.error("[ocuclaw] runtime child failed to start: %s", exc)
                return False
            _register_liveui_tool_from_hello(hello)
            self._link = link
            self._loop = asyncio.get_running_loop()
            try:
                echo = await link.request(
                    "link.echo", {"probe": "connect"}, timeout_s=10.0
                )
            except LinkError as exc:
                logger.error("[ocuclaw] echo probe failed after handshake: %s", exc)
                await link.terminate()
                self._link = None
                return False
            if settings["relayToken"]:
                # Production lane: the child boots the relay AFTER the
                # handshake — connect() must not publish a connected
                # platform until the child confirms the relay is bound
                # (bind failures exit 98 and must surface as a FAILED
                # connect, never a transient success — Codex review W06
                # finding). Link-only lanes (no relayToken) skip the wait.
                try:
                    await asyncio.wait_for(
                        runtime_ready.wait(),
                        timeout=settings["runtimeReadyTimeoutS"],
                    )
                except asyncio.TimeoutError:
                    logger.error(
                        "[ocuclaw] runtime child never reported runtime.ready "
                        "(relay bind failure? see child exit code / stderr)"
                    )
                    await link.terminate()
                    self._link = None
                    return False
                if not link.ready:
                    # NOTE: `ready` is the property (closed/death-aware,
                    # calls is_alive()); `link.is_alive` unparenthesized is
                    # a bound METHOD and always truthy (Codex review W06
                    # finding — the dead-child branch never fired).
                    logger.error(
                        "[ocuclaw] runtime child died during relay boot "
                        "(code=%s)", link.returncode,
                    )
                    self._link = None
                    return False
            if self._janitor_task is None or self._janitor_task.done():
                self._janitor_task = asyncio.create_task(self._janitor_loop())
            if (
                self._first_run_welcome_task is None
                or self._first_run_welcome_task.done()
            ):
                self._first_run_welcome_task = asyncio.create_task(
                    self._first_run_welcome_loop()
                )
            with self._stream_tail_lock:
                self._stream_tail_closing = False
            if self._presence is not None:
                self._presence.start()
            self._mark_connected()
            logger.info(
                "[ocuclaw] control link up (pid=%s runtime=%s echo=%s "
                "wsPort=%d is_reconnect=%s)",
                link.pid,
                hello.get("runtimeName"),
                echo,
                settings["wsPort"],
                is_reconnect,
            )
            return True

        async def disconnect(self) -> None:
            if self._janitor_task is not None:
                self._janitor_task.cancel()
                self._janitor_task = None
            if self._first_run_welcome_task is not None:
                self._first_run_welcome_task.cancel()
                self._first_run_welcome_task = None
            # Clean shutdown is one of the receipt's three write triggers: say
            # so now rather than leaving the last healthy reading to age out
            # over the next two minutes and read as current in between.
            presence = self._presence
            self._presence = None
            if presence is not None:
                await presence.stop()
            # Shutdown inside the finalize grace window: commit each retained
            # tail once and emit its terminal lifecycle while the link is
            # still up, instead of silently dropping the turn. The closing
            # flag refuses new stashes (session ends racing this drain from
            # the worker thread complete synchronously instead), so the
            # drain-until-empty loop terminates.
            with self._stream_tail_lock:
                self._stream_tail_closing = True
            while True:
                with self._stream_tail_lock:
                    key = next(iter(self._stream_tail_closures), None)
                if key is None:
                    break
                self._finish_deferred_stream_tail(*key)
            with self._stream_tail_lock:
                stream_tail_tasks = list(self._stream_tail_tasks.values())
                self._stream_tail_tasks.clear()
            for task in stream_tail_tasks:
                task.cancel()
            for task in list(self._error_sweep_tasks):
                task.cancel()
            self._error_sweep_tasks.clear()
            self._unregister_all_approval_notifiers()
            self._slash_confirms_by_id.clear()
            link = self._link
            self._link = None
            with self._thinking_lock:
                self._thinking_text_by_run.clear()
                self._thinking_seq_by_run.clear()
            self._phone_turn_candidate_gate.clear()
            if link is not None:
                code = await link.terminate()
                logger.info("[ocuclaw] runtime child stopped (code=%s)", code)
            self._mark_disconnected()

        # -- outbound transport (StreamConsumer + gateway sends) -------------

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            text = _gateway_auth_recovery_message(strip_stream_cursor(content))
            message_id = self._next_message_id()
            adopt_waiter = self._adopt_waiters.get(str(chat_id))
            if adopt_waiter is not None:
                # The `/resume` slash reply on an adopt lane belongs to the
                # adopt handler (its refusal classifier), never to the wearer:
                # the lane is not the active session yet and Hermes persists
                # no slash reply, so nothing is lost by not emitting it.
                if not adopt_waiter.done():
                    adopt_waiter.set_result(text)
                return SendResult(success=True, message_id=message_id)
            if _is_hermes_home_channel_onboarding_notice(text):
                # OcuClaw owns its session picker and cron delivery routes.
                # Hermes emits this one-time platform notice as a second
                # assistant message after the real first answer, which would
                # replace that answer on the single glasses conversation
                # surface. Acknowledge delivery without mutating the ledger.
                logger.info(
                    "[ocuclaw] suppressed Hermes home-channel onboarding notice"
                )
                return SendResult(success=True, message_id=message_id)
            try:
                ns = self._namespace_for_outbound(metadata, chat_id=chat_id)
            except AmbiguousOutboundNamespaceError as exc:
                return SendResult(success=False, error=str(exc))
            session_key = self._session_key_for_chat(chat_id, ns=ns)
            identity = parse_ocuclaw_session_key(session_key) or {
                "ns": ns,
                "chatId": str(chat_id),
            }

            # Slash records complete on their single-shot reply send (hermes
            # slash turns fire no on_session_end — D9).
            slash_head, merged, promoted = self._ledger.pop_slash_head(session_key)
            if slash_head is not None:
                # A slash reply is committed straight off THIS send and never
                # passes through `note_send`, so the record has no
                # current_message_id to fall back on — the id this send just
                # minted is the message's own (#1691).
                self._emit_message_commit(slash_head, text, message_id=message_id)
                self._emit_event(
                    "activity",
                    lifecycle_terminal_activity(slash_head, completed=True),
                )
                for rider in merged:
                    self._emit_event(
                        "activity",
                        lifecycle_terminal_activity(rider, completed=True),
                    )
                if promoted is not None:
                    self._emit_event("activity", lifecycle_start_activity(promoted))
                return SendResult(success=True, message_id=message_id)

            record, uncommitted_previous, ended_run_commit = self._ledger.note_send(
                session_key, message_id, text
            )
            if record is not None:
                self._claim_tool_progress_send(record, message_id)
            if record is not None and self._send_is_interim_commentary(metadata):
                # Second narration signal (0.20.5 streaming lane): the
                # StreamConsumer declares interim intent on the send itself.
                # Same normalized-text set as the hook, so whichever arrives
                # first wins and the other is a no-op.
                self._note_narration_text(record.run_id, text)
            if record is None:
                # No dispatch record (cron deliver='origin', foreign-origin
                # turns): the main-lane message consumer reads runId
                # null-tolerantly.
                self._emit_event(
                    "message",
                    uncorrelated_message_event(
                        identity, text, message_id=message_id
                    ),
                )
                return SendResult(success=True, message_id=message_id)
            if ended_run_commit:
                # Grace claim on a run whose on_session_end beat its final
                # send: `note_send` returned the ended record WITHOUT moving
                # current_* onto this text, so the record's id still names the
                # previous message. This send's own id is the right one
                # (#1691).
                self._emit_message_commit(record, text, message_id=message_id)
                self._note_phone_turn_message_commit(record)
                return SendResult(success=True, message_id=message_id)
            if uncommitted_previous is not None:
                # Defensive: a fresh send while a message is open commits the
                # previous one (segment finalize normally did this already).
                # The run is still open by construction here — this send IS the
                # next message of the same turn — so the commit must not read
                # as turn end.
                self._emit_message_commit(
                    record,
                    uncommitted_previous,
                    turn_active=True,
                    origin_at_ms=getattr(record, "previous_origin_ms", None),
                    # …and the previous message's IDENTITY for the same
                    # reason: `note_send` has already moved current_* on to
                    # THIS send (#1691).
                    message_id=getattr(record, "previous_message_id", None),
                )
                self._note_phone_turn_message_commit(record)
            if self._ledger.take_lifecycle_start(record):
                self._emit_event("activity", lifecycle_start_activity(record))
            # Same routing tag the commit will carry. The commit can be many
            # seconds away (hermes flushes it lazily on the next send), and the
            # overlay is on the display NOW.
            self._emit_event(
                "streaming",
                streaming_event(
                    record,
                    text,
                    message_kind=self._commit_message_kind(
                        record,
                        text,
                        message_id,
                    ),
                ),
            )
            return SendResult(success=True, message_id=message_id)

        async def send_exec_approval(
            self,
            chat_id: str,
            command: str,
            session_key: str,
            description: str = "dangerous command",
            metadata: Optional[dict] = None,
            allow_permanent: bool = True,
            allow_session: bool = True,
            smart_denied: bool = False,
        ) -> SendResult:
            if not hermes_version_supported(_hermes_version()):
                return SendResult(
                    success=False,
                    error=(
                        "approval mirroring requires supported hermes "
                        f"{_supported_hermes_range()}"
                    ),
                )
            entry, delivery = self._handle_gateway_approval(
                str(session_key),
                {
                    "command": command,
                    "description": description,
                    "metadata": metadata,
                    "allow_permanent": allow_permanent,
                    "allow_session": allow_session,
                    "smart_denied": smart_denied,
                },
                swallow_errors=False,
            )
            if delivery is None:
                self._pop_approval_entry(entry["id"])
                return SendResult(
                    success=False,
                    error="structured approval delivery is unavailable",
                )
            try:
                if isinstance(delivery, concurrent.futures.Future):
                    await asyncio.wrap_future(delivery)
                else:
                    await delivery
            except Exception as exc:  # noqa: BLE001 - preserve Hermes text fallback
                try:
                    self._emit_approval_resolved(entry, "deny")
                except Exception:  # noqa: BLE001 - fallback must still survive
                    logger.debug(
                        "[ocuclaw] approval delivery failure clear failed for %s",
                        entry.get("id"),
                        exc_info=True,
                    )
                self._pop_approval_entry(entry["id"])
                return SendResult(success=False, error=str(exc))
            return SendResult(success=True, message_id=entry["id"])

        async def send_slash_confirm(
            self,
            chat_id: str,
            title: str,
            message: str,
            session_key: str,
            confirm_id: str,
            metadata: Optional[dict] = None,
        ) -> SendResult:
            link = self._link
            if link is None or not link.ready:
                return SendResult(
                    success=False,
                    error="structured slash confirmation is unavailable",
                )
            try:
                ns = self._namespace_for_outbound(metadata, chat_id=chat_id)
                native_session_key = self._session_key_for_chat(chat_id, ns=ns)
            except AmbiguousOutboundNamespaceError as exc:
                return SendResult(success=False, error=str(exc))
            head = self._ledger.head(native_session_key)
            public_session_key = (
                head.public_key if head is not None and head.public_key else str(session_key)
            )
            try:
                from tools import slash_confirm as slash_confirm_module

                pending = slash_confirm_module.get_pending(session_key) or {}
                command = str(pending.get("command") or "")
                timeout_seconds = int(
                    getattr(slash_confirm_module, "DEFAULT_TIMEOUT_SECONDS", 300)
                )
            except Exception:
                command = ""
                timeout_seconds = 300
            pending_entry = {
                "nativeSessionKey": str(session_key),
                "ledgerSessionKey": native_session_key,
                "publicSessionKey": public_session_key,
                "chatId": str(chat_id),
                "command": command,
            }
            # Retain before awaiting presentation. A very fast wearer response
            # may arrive on the control link before request() returns.
            self._slash_confirms_by_id[str(confirm_id)] = pending_entry
            try:
                result = await link.request(
                    SLASH_CONFIRM_PRESENT_METHOD,
                    {
                        "confirmId": str(confirm_id),
                        "sessionKey": public_session_key,
                        "title": str(title),
                        "command": command,
                        "expiresAtMs": int((time.time() + max(1, timeout_seconds)) * 1000),
                    },
                    timeout_s=10.0,
                )
            except Exception as exc:  # structured failure preserves Hermes fallback
                if self._slash_confirms_by_id.get(str(confirm_id)) is pending_entry:
                    self._slash_confirms_by_id.pop(str(confirm_id), None)
                return SendResult(success=False, error=str(exc))
            if not isinstance(result, dict) or result.get("presented") is not True:
                if self._slash_confirms_by_id.get(str(confirm_id)) is pending_entry:
                    self._slash_confirms_by_id.pop(str(confirm_id), None)
                reason = result.get("reason") if isinstance(result, dict) else None
                return SendResult(
                    success=False,
                    error=str(reason or "structured slash confirmation was not presented"),
                )
            return SendResult(success=True, message_id=str(confirm_id))

        async def handle_slash_confirm_resolve(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            confirm_id = str(p.get("confirmId") or "")
            choice = str(p.get("choice") or "")
            session_key = str(p.get("sessionKey") or "")
            if choice not in ("once", "always", "cancel"):
                return {"status": "rejected", "error": "invalid slash confirmation choice"}
            entry = self._slash_confirms_by_id.get(confirm_id)
            if entry is None or entry.get("publicSessionKey") != session_key:
                return {"status": "ignored", "reason": "slash confirmation is stale"}
            # Consume before invoking Hermes. Duplicate/late callbacks therefore
            # cannot execute a destructive command twice.
            self._slash_confirms_by_id.pop(confirm_id, None)
            try:
                from tools import slash_confirm as slash_confirm_module

                result_text = await slash_confirm_module.resolve(
                    entry["nativeSessionKey"], confirm_id, choice
                )
            except Exception as exc:
                return {"status": "rejected", "error": str(exc)}

            command = entry.get("command", "")
            is_reset = command in ("new", "reset", "clear")
            if is_reset:
                head, merged, promoted = self._ledger.pop_slash_head(
                    entry["ledgerSessionKey"]
                )
                if head is not None:
                    self._emit_event(
                        "activity", lifecycle_terminal_activity(head, completed=True)
                    )
                for rider in merged:
                    self._emit_event(
                        "activity", lifecycle_terminal_activity(rider, completed=True)
                    )
                if promoted is not None:
                    self._emit_event("activity", lifecycle_start_activity(promoted))
                approved = choice in ("once", "always")
                return {
                    "status": "accepted",
                    "reset": approved,
                    "sessionKey": entry["publicSessionKey"],
                    "transientStatus": "Chat reset" if approved else "Reset cancelled",
                    # The reset receipt is deliberately consumed at this typed
                    # command boundary, even when Hermes returns an EphemeralReply
                    # object that its public resolver does not re-expose as text.
                    "temporaryReplyRemoved": bool(approved),
                }

            if result_text:
                await self.send(entry["chatId"], result_text)
            return {"status": "accepted", "reset": False}

        async def send_clarify(
            self,
            chat_id: str,
            question: str,
            choices: Optional[list],
            clarify_id: str,
            session_key: str,
            metadata: Optional[Dict[str, Any]] = None,
        ) -> SendResult:
            clean_id = str(clarify_id or "").strip()
            clean_question = str(question or "").strip()
            clean_choices = [
                str(choice).strip()
                for choice in list(choices or [])[:8]
                if str(choice).strip()
            ]
            multi_select = False
            try:
                from tools import clarify_gateway as clarify_module

                with clarify_module._lock:
                    pending = clarify_module._entries.get(clean_id)
                multi_select = bool(
                    pending and getattr(pending, "multi_select", False)
                )
            except Exception:  # noqa: BLE001 - fallback is the safe path
                multi_select = False
            if not clean_id:
                return SendResult(success=False, error="clarify delivery requires id")
            if not clean_question:
                return SendResult(success=False, error="clarify delivery requires question")
            if not hermes_version_supported(_hermes_version()):
                return SendResult(
                    success=False,
                    error=(
                        "clarify mirroring requires supported hermes "
                        f"{_supported_hermes_range()}"
                    ),
                )
            try:
                from tools.clarify_gateway import get_clarify_timeout

                deadline_s = max(1, int(get_clarify_timeout()))
            except Exception:  # noqa: BLE001 - retain a bounded glasses request
                deadline_s = 300
            public_key = self._public_key_for_native_session(str(session_key))
            if not public_key:
                return SendResult(
                    success=False,
                    error="clarify delivery requires a public session key",
                )
            presentation = {
                "id": clean_id,
                "sessionKey": public_key,
                "question": clean_question,
                "choices": clean_choices,
                "multiSelect": multi_select,
                "allowOther": bool(clean_choices),
                "deadlineSec": deadline_s,
                "expiresAtMs": int((time.time() + deadline_s) * 1000),
            }
            try:
                self._session_status.observe_clarify(str(session_key), presentation)
            except Exception:  # observation must not change native delivery
                pass
            delivery = self._emit_event(
                "clarify",
                presentation,
                swallow_errors=False,
            )
            if delivery is None:
                return SendResult(
                    success=False,
                    error="structured clarify delivery is unavailable",
                )
            try:
                if isinstance(delivery, concurrent.futures.Future):
                    await asyncio.wrap_future(delivery)
                else:
                    await delivery
            except Exception as exc:  # noqa: BLE001 - preserve Hermes text fallback
                return SendResult(success=False, error=str(exc))
            return SendResult(success=True, message_id=clean_id)

        async def edit_message(
            self, chat_id, message_id, content, *, finalize: bool = False, metadata=None
        ):
            # StreamConsumer edit transport: content is CUMULATIVE (never a
            # delta); finalize seals the message (turn end AND segment/
            # oversize breaks — one message commit per finalized message).
            try:
                ns = self._namespace_for_outbound(
                    metadata,
                    chat_id=chat_id,
                    message_id=message_id,
                )
            except AmbiguousOutboundNamespaceError as exc:
                return SendResult(success=False, error=str(exc))
            session_key = self._session_key_for_chat(chat_id, ns=ns)
            text = _gateway_auth_recovery_message(content if finalize else strip_stream_cursor(content))
            message_id = str(message_id)
            closure = None
            task = None
            if finalize:
                # Lock ordering: _stream_tail_lock is always outside the
                # ledger's internal lock; never acquire it while holding the
                # ledger lock.
                with self._stream_tail_lock:
                    closure_key = (session_key, message_id)
                    closure = self._stream_tail_closures.pop(closure_key, None)
                    task = self._stream_tail_tasks.pop(closure_key, None)
                    if closure is not None:
                        record = closure["record"]
                        record.current_text = text
                        record.current_committed = True
                    else:
                        record = self._ledger.note_edit(
                            session_key, message_id, text, finalize=True
                        )
            else:
                record = self._ledger.note_edit(
                    session_key, message_id, text, finalize=False
                )
            if record is None:
                # A true orphan has no safe upgrade path. In particular, never
                # claim a dropped finalize was delivered: Hermes interprets a
                # successful finalize edit as final_content_delivered=True and
                # suppresses its normal final send.
                logger.debug(
                    "[ocuclaw] orphan edit_message for %s (finalize=%s) dropped",
                    chat_id,
                    finalize,
                )
                return SendResult(
                    success=not finalize,
                    message_id=message_id,
                    error=(
                        "finalize edit arrived after its message record closed"
                        if finalize
                        else None
                    ),
                )
            if finalize:
                if closure is not None:
                    current_task = None
                    try:
                        current_task = asyncio.current_task()
                    except RuntimeError:
                        pass
                    if task is not None and task is not current_task:
                        task.cancel()
                # A finalize WITHOUT a stashed closure is a mid-turn segment
                # break (oversize split, StreamConsumer segment boundary): the
                # run keeps going and no terminal activity / agent_end follows.
                # A finalize WITH a closure is the run's closing commit.
                self._emit_message_commit(
                    record, text, turn_active=closure is None
                )
                self._note_phone_turn_message_commit(record)
                if closure is not None:
                    self._emit_event(
                        "activity",
                        lifecycle_terminal_activity(
                            record,
                            completed=bool(closure["completed"]),
                            interrupted=bool(closure["interrupted"]),
                        ),
                    )
                    self._forget_thinking_run(record.run_id)
                    for rider in closure["riders"]:
                        self._emit_event(
                            "activity",
                            lifecycle_terminal_activity(
                                rider,
                                completed=bool(closure["completed"]),
                                interrupted=bool(closure["interrupted"]),
                            ),
                        )
                        self._forget_thinking_run(rider.run_id)
                    self._emit_hook(
                        agent_end_hook_frame(
                            closure["identity"],
                            closure["messages"],
                            public_key=record.public_key,
                            agent_id=closure["identity"]["ns"],
                            run_id=record.run_id,
                        )
                    )
            else:
                self._emit_event(
                    "streaming",
                    streaming_event(
                        record,
                        text,
                        message_kind=self._commit_message_kind(record, text),
                    ),
                )
            return SendResult(success=True, message_id=message_id)

        async def send_or_update_status(
            self, chat_id, status_key, content, metadata=None
        ):
            # Gateway status_callback route (compression / rate-limit /
            # lifecycle notices): an activity notice, never a chat commit.
            try:
                ns = self._namespace_for_outbound(metadata, chat_id=chat_id)
            except AmbiguousOutboundNamespaceError as exc:
                return SendResult(success=False, error=str(exc))
            session_key = self._session_key_for_chat(chat_id, ns=ns)
            identity = parse_ocuclaw_session_key(session_key) or {
                "ns": ns,
                "chatId": str(chat_id),
            }
            record = self._ledger.touch(session_key)
            if record is not None and self._ledger.take_lifecycle_start(record):
                self._emit_event("activity", lifecycle_start_activity(record))
            if is_desktop_lease_wait_notice(status_key, content):
                # The durable-lease wait (another Hermes process — Desktop —
                # holds the turn lease, up to 1800 s). Labelled + ranked so
                # the wearer sees "Waiting for Desktop" instead of a bare
                # placeholder (T0 step 8; #2510 backstop).
                self._emit_event(
                    "activity",
                    status_activity(
                        identity,
                        "lifecycle",
                        str(content or ""),
                        status_key=DESKTOP_LEASE_WAIT_STATUS_KEY,
                        record=record,
                        label=DESKTOP_LEASE_WAIT_LABEL,
                        candidate_rank="narration",
                    ),
                )
                return SendResult(success=True, message_id=f"status:{DESKTOP_LEASE_WAIT_STATUS_KEY}")
            self._emit_event(
                "activity",
                status_activity(
                    identity,
                    str(status_key or "notice"),
                    str(content or ""),
                    status_key=str(status_key or ""),
                    record=record,
                ),
            )
            return SendResult(success=True, message_id=f"status:{status_key}")

        async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
            return {"id": chat_id, "platform": PLATFORM_NAME}

        # -- dispatch lane (child → parent RPC) -------------------------------

        async def handle_dispatch(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            attachments = p.get("attachments")
            run_id = str(p.get("runId") or "").strip()
            if not run_id:
                self._discard_attachment_spills(attachments)
                raise ValueError("dispatch.send requires a runId")
            target = p.get("target") if isinstance(p.get("target"), dict) else {}
            chat_id = str(target.get("chatId") or "").strip()
            ns = str(target.get("ns") or self._namespace)
            if not chat_id:
                self._discard_attachment_spills(attachments)
                raise ValueError("dispatch.send requires target.chatId")
            try:
                prompt_metadata = validate_prompt_metadata(p)
            except ValueError:
                self._discard_attachment_spills(attachments)
                raise
            message = p.get("message")
            message = message if isinstance(message, str) else ""
            has_attachments = isinstance(attachments, list) and any(
                isinstance(a, dict) and (a.get("content") or a.get("path"))
                for a in attachments
            )
            if not message.strip() and not has_attachments:
                # Attachment-only sends are VALID (the downstream relay
                # accepts media without text — Codex review W06 finding);
                # only text-less AND media-less dispatches reject. Every
                # early return discards spilled attachment files — the child
                # cleans up only on TRANSPORT failure, so an in-band
                # reject/replay that never ingests would leak the 0600 temp
                # file (Codex review W06 finding).
                self._discard_attachment_spills(attachments)
                return {
                    "status": "rejected",
                    "error": "dispatch requires a message or an attachment",
                    "runId": run_id,
                }
            route_error = self._namespace_route_error(ns)
            if route_error is not None:
                self._discard_attachment_spills(attachments)
                return {
                    "status": "rejected",
                    "error": route_error,
                    "runId": run_id,
                }
            profile = profile_for_namespace(ns)
            agent_id = str(p.get("agentId") or "").strip()
            allowed_agent_ids = {ns, profile}
            if ns == DEFAULT_SESSION_NAMESPACE:
                allowed_agent_ids.update(("main", "default"))
            if agent_id and agent_id not in allowed_agent_ids:
                # Sessions have permanent single-profile affinity. A per-turn
                # override cannot move an existing transcript across profiles.
                self._discard_attachment_spills(attachments)
                return {
                    "status": "rejected",
                    "error": (
                        f"agent override {agent_id!r} violates this session's "
                        f"permanent profile affinity ({profile!r})"
                    ),
                    "runId": run_id,
                }
            public_key = str(p.get("sessionKey") or "")
            idem = p.get("idempotencyKey")
            idem = idem if isinstance(idem, str) and idem else None

            # Idempotent replay (wake dedup): echo the ORIGINAL runId so the
            # caller correlates with the events the first dispatch produced.
            session_key = self._session_key_for_chat(chat_id, ns=ns)
            ledger_idem = f"{session_key}\x1f{idem}" if idem else None
            existing = self._ledger.find_idempotent(ledger_idem)
            if existing is not None:
                self._discard_attachment_spills(attachments)
                result = {"status": existing.status, "runId": existing.run_id}
                if existing.session_state:
                    result["sessionState"] = existing.session_state
                return result

            if (
                idem
                and idem.startswith("glasses-wake:")
                and self._ledger.is_busy(session_key)
            ):
                self._discard_attachment_spills(attachments)
                return {
                    "status": "accepted",
                    "runId": run_id,
                    "sessionState": "busy",
                }
            # Platform update is refused for sessions (P19): it would pull
            # Hermes past the certified baseline in place, unproven, with no
            # roll-back. Refuse BEFORE hermes sees the turn — its own
            # registry gate (allow_update_command=False) answers with
            # "run `hermes update` from the terminal", which is exactly the
            # destructive act being prevented. The wearer gets the refusal as
            # a normal glasses message; strict-ack consumers get it as the
            # dispatch error.
            #
            # Placement is deliberate: this sits BELOW the idempotent-replay
            # gate above, so a retry carrying the same idempotencyKey (what
            # the Node senders actually reuse when an ack is lost) is answered
            # there and never re-emits this message. Like every sibling
            # rejection in this function, a refusal is not ledger-recorded —
            # `_ledger.begin()` runs only on the accept path below. Whether
            # rejections should join the ledger is a dispatch-contract
            # question for ALL rejection paths, not something to special-case
            # here; see the P19 follow-up note rather than adding a second,
            # runId-keyed dedup rule alongside the idempotencyKey one.
            if is_platform_update_command(message):
                self._discard_attachment_spills(attachments)
                identity = parse_ocuclaw_session_key(session_key) or {
                    "ns": ns,
                    "chatId": str(chat_id),
                }
                self._emit_event(
                    "message",
                    uncorrelated_message_event(
                        identity,
                        UPDATE_COMMAND_REFUSAL,
                        # A refusal is still a conversation entry; an entry
                        # with no id costs the session ledgerV1 (#1691).
                        message_id=self._next_message_id(),
                    ),
                )
                return {
                    "status": "rejected",
                    "error": UPDATE_COMMAND_REFUSAL,
                    "runId": run_id,
                }

            session_state = self._read_session_flags(session_key)

            # Bypass-cancel policy (D9): hermes serializes /stop,/new,/reset
            # by cancelling the running turn and discarding queued follow-ups
            # — the cancelled records close here so their waiters reject.
            if is_cancelling_slash(message):
                await self._close_session_records(session_key, code="cancelled")

            # Hermes owns destructive reset confirmation. OcuClaw's appended
            # greeting must not become a second turn that can run before the
            # wearer decides, so the parent dispatches one normalized command.
            dispatch_message = normalize_session_reset_command(message)
            media_urls, media_types = self._ingest_attachments(attachments)
            records = []
            try:
                kind = (
                    KIND_SLASH
                    if dispatch_message.lstrip().startswith("/")
                    else KIND_TURN
                )
                record = self._ledger.begin(
                    session_key=session_key,
                    run_id=run_id,
                    public_key=public_key,
                    kind=kind,
                    idempotency_key=ledger_idem,
                    session_state=session_state,
                    has_media=bool(media_urls),
                    prompt_owner=prompt_metadata[0] if prompt_metadata else None,
                    prompt_lane=prompt_metadata[1] if prompt_metadata else None,
                )
                records.append(record)
                if record.state == STATE_ACTIVE:
                    # BEFORE dispatch (Codex review W06 finding): a fast
                    # slash turn can complete during the handle_message await,
                    # so a post-await start would strand stale "thinking".
                    self._emit_event("activity", lifecycle_start_activity(record))
                event = self._build_message_event(
                    chat_id,
                    dispatch_message,
                    profile=(
                        profile if ns != DEFAULT_SESSION_NAMESPACE else None
                    ),
                    channel_prompt=p.get("channelPrompt"),
                    media_urls=media_urls,
                    media_types=media_types,
                )
                if prompt_metadata is not None:
                    prompt_owner, prompt_lane = prompt_metadata
                    # Internal metadata for later prompt-lane work. Hermes's
                    # MessageEvent model input still reads only channel_prompt,
                    # so this prefactor changes no model-visible bytes.
                    setattr(event, "_ocuclaw_prompt_owner", prompt_owner)
                    setattr(event, "_ocuclaw_prompt_lane", prompt_lane)
                # BasePlatformAdapter invokes on_processing_complete with this
                # object after final delivery. Keep the D9 identity on it so
                # that boundary can close only its own record.
                setattr(event, "_ocuclaw_dispatch_run_id", record.run_id)
                setattr(event, "_ocuclaw_dispatch_session_key", session_key)
                await self.handle_message(event)
            except Exception:
                # A failed dispatch must not strand its records as a phantom
                # active turn until the janitor (Codex review W06 finding):
                # close them with a terminal error so waiters reject and the
                # typing state clears, promote whatever queued dispatch is
                # next, then let the RPC reject to the child (the bridge's
                # transport-failure surface). Only records STILL in the
                # ledger get the error terminal — a fast slash command may
                # already have completed via its reply send, and its runId must
                # not receive a contradictory second terminal.
                # Purge idempotency for the whole failed attempt: a retry must
                # re-dispatch rather than replay the failed record as accepted.
                self._ledger.purge_idempotency(records)
                removed, promoted = self._ledger.discard_records(
                    session_key, records
                )
                for record in removed:
                    self._emit_event(
                        "activity",
                        lifecycle_terminal_activity(
                            record, completed=False, code="dispatch_failed"
                        ),
                    )
                if promoted is not None:
                    self._emit_event("activity", lifecycle_start_activity(promoted))
                raise

            if session_state:
                # Distinct surfacing (spec §Error Handling): suspended forces
                # a fresh session and WINS; resume_pending auto-continues.
                detail = (
                    "Previous session was stopped and suspended — starting fresh."
                    if session_state == "suspended"
                    else "Resuming session after a gateway restart."
                )
                self._emit_event(
                    "activity",
                    status_activity(
                        {"ns": ns, "chatId": chat_id},
                        "notice",
                        detail,
                        status_key=f"session-state:{session_state}",
                        record=records[0] if records else None,
                    ),
                )
            result: Dict[str, Any] = {"status": "accepted", "runId": run_id}
            if session_state:
                result["sessionState"] = session_state
            return result

        async def on_processing_complete(self, event: Any, outcome: Any) -> None:
            """Close the exact D9 record whose Hermes platform work finished."""
            run_id = str(
                getattr(event, "_ocuclaw_dispatch_run_id", "") or ""
            ).strip()
            session_key = str(
                getattr(event, "_ocuclaw_dispatch_session_key", "") or ""
            ).strip()
            if not run_id or not session_key:
                return
            outcome_value = str(getattr(outcome, "value", "") or "").lower()
            completed = outcome_value == "success"
            head, merged, promoted = self._ledger.complete_head_if_run(
                session_key, run_id
            )
            processing_publishes_candidate = (
                parse_ocuclaw_session_key(session_key) is not None
                and self._phone_turn_candidate_gate.note_processing(
                    session_key, run_id, succeeded=completed
                )
            )
            if head is None:
                # on_session_end or slash completion already closed this run;
                # never let a late platform callback consume its successor.
                if processing_publishes_candidate:
                    record_phone_turn_candidate(
                        session_key=session_key,
                        turn_id=run_id,
                    )
                return
            if (
                head.current_message_id is not None
                and not head.current_committed
                and head.current_text
            ):
                head.current_committed = True
                self._emit_message_commit(head, head.current_text)
                self._note_phone_turn_message_commit(head)
            if processing_publishes_candidate:
                record_phone_turn_candidate(
                    session_key=session_key,
                    turn_id=run_id,
                )
            interrupted = outcome_value == "cancelled"
            code = None if completed or interrupted else "processing_failed"
            for record in [head, *merged]:
                self._emit_event(
                    "activity",
                    lifecycle_terminal_activity(
                        record,
                        completed=completed,
                        interrupted=interrupted,
                        code=code,
                    ),
                )
                self._forget_thinking_run(record.run_id)
            if promoted is not None:
                self._emit_event("activity", lifecycle_start_activity(promoted))

        def _resolve_armed_first_run_session(self) -> Optional[str]:
            candidate_keys = []
            # A gateway restart clears the in-memory completion candidate, but
            # the one-hour Attempt remains resumable. Recover its exact phone
            # session by matching the receipt's fingerprint against the
            # profile-scoped Hermes session directory; no raw session key is
            # persisted in OcuClaw state.
            try:
                rows = self._session_rpc._sync_list_sessions({"limit": 500}).get(
                    "sessions", []
                )
            except Exception:  # noqa: BLE001 - caller returns a closed failure
                rows = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                key = str(row.get("sessionKey") or "")
                if (
                    parse_ocuclaw_session_key(key) is not None
                    and key not in candidate_keys
                ):
                    candidate_keys.append(key)
            for key in candidate_keys:
                state = inspect_attempt(
                    hermes_release=CERTIFIED_HERMES_TAG,
                    hermes_package_version=_hermes_version() or None,
                    ocuclaw_version=_ocuclaw_version(),
                    session_key=key,
                )
                if state.get("state") == "armed":
                    return key
            return None

        async def _deliver_armed_first_run_welcome(self) -> Dict[str, Any]:
            attempt = inspect_attempt(
                hermes_release=CERTIFIED_HERMES_TAG,
                hermes_package_version=_hermes_version() or None,
                ocuclaw_version=_ocuclaw_version(),
                session_key=None,
            )
            if attempt.get("state") != "armed":
                return {"state": str(attempt.get("state") or "missing")}
            session_key = await asyncio.to_thread(
                self._resolve_armed_first_run_session
            )
            if session_key is None:
                return {"state": "session_unavailable"}
            link = self._link
            if link is None or not link.ready:
                return {"state": "link_unavailable"}
            call_id = f"first-run-welcome-{uuid.uuid4().hex}"
            try:
                result = await link.request(
                    LIVEUI_RENDER_METHOD,
                    {
                        "callId": call_id,
                        "sessionKey": session_key,
                        "args": dict(WELCOME_SURFACE),
                    },
                    timeout_s=(
                        float(WELCOME_SURFACE["timeoutMs"]) / 1000.0
                        + LIVEUI_RENDER_LINK_MARGIN_S
                    ),
                )
            except Exception:  # noqa: BLE001 - failure advances the retry receipt
                logger.exception("[ocuclaw] first-run welcome delivery failed")
                outcome = "error"
            else:
                outcome = result.get("result") if isinstance(result, dict) else result
                if isinstance(outcome, dict):
                    outcome = outcome.get("result")
            proof = record_welcome_outcome(
                outcome,
                hermes_release=CERTIFIED_HERMES_TAG,
                hermes_package_version=_hermes_version() or None,
                ocuclaw_version=_ocuclaw_version(),
                session_key=session_key,
            )
            return {"state": "delivered", "firstRunProof": proof}

        async def _first_run_welcome_loop(self) -> None:
            while True:
                try:
                    await self._deliver_armed_first_run_welcome()
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - keep the gateway watcher alive
                    logger.exception("[ocuclaw] first-run welcome watcher failed")
                await asyncio.sleep(FIRST_RUN_WELCOME_POLL_SECONDS)

        # -- W09 approvals + live-session control (ADR-0008) -----------------

        def _approval_timeout_seconds(self) -> int:
            try:
                from tools.approval import _get_approval_timeout

                # Hermes 0.20 owns the effective default and operator override;
                # using its accessor also preserves the host's malformed-
                # config fallback instead of pinning either value here.
                timeout = _get_approval_timeout()
                return max(0, int(timeout))
            except Exception:  # noqa: BLE001
                return 300

        def _public_key_for_native_session(self, session_key: str) -> Optional[str]:
            identity = parse_ocuclaw_session_key(session_key)
            if not identity:
                return None
            return f"hermes:{identity['ns']}:{identity['chatId']}"

        async def handle_status_sessions_list(self, params: Any) -> Dict[str, Any]:
            result = await self._session_rpc.list_sessions(params)
            reasoning_by_namespace: Dict[str, Optional[str]] = {}
            for row in result.get("sessions", []):
                native_key = str(row.get("sessionKey") or "")
                public_key = self._public_key_for_native_session(native_key)
                if not public_key:
                    continue  # foreign sessions retain their existing read-only contract
                # Native /reasoning show|hide persists a profile display setting,
                # not a session DB column. Read it fresh on every hydration (also
                # after /new), through the same namespace guard as profile options.
                identity = parse_ocuclaw_session_key(native_key)
                ns = identity["ns"]
                if ns not in reasoning_by_namespace:
                    try:
                        options = await self.handle_profile_options_get({"ns": ns})
                        level = options.get("reasoningLevel")
                        reasoning_by_namespace[ns] = level if level in {"on", "off"} else None
                    except Exception:
                        reasoning_by_namespace[ns] = None
                if reasoning_by_namespace[ns] is not None:
                    row["reasoningLevel"] = reasoning_by_namespace[ns]
                try:
                    from tools.clarify_gateway import get_pending_for_session

                    now_ms = int(time.time() * 1000)
                    with self._approval_lock:
                        approvals = [
                            {
                                "id": entry["id"],
                                "requestId": entry["requestId"],
                                "expiresAtMs": entry["expiresAtMs"],
                                "request": {
                                    "sessionKey": public_key,
                                    "command": entry["command"] or entry["description"] or "approval required",
                                    "ask": entry["description"] or "approval required",
                                    "host": "hermes",
                                    "security": "high",
                                    "allowedDecisions": list(entry["allowedDecisions"]),
                                },
                            }
                            for entry in self._approvals_by_id.values()
                            if entry["sessionKey"] == native_key and entry["expiresAtMs"] > now_ms
                        ]
                    row.update(self._session_status.snapshot(
                        native_key, public_key,
                        working=self._ledger.is_busy(native_key),
                        approvals=approvals,
                        pending_lookup=get_pending_for_session,
                    ))
                except Exception:  # observer failure must never fail the native session list
                    row["agentStatus"] = {"observedAtMs": int(time.time() * 1000), "unknown": True}
            return result

        def _unregister_all_approval_notifiers(self) -> None:
            with self._approval_lock:
                timers = list(self._approval_timers.values())
                self._approval_timers.clear()
                tasks = list(self._approval_expiry_tasks)
                self._approval_expiry_tasks.clear()
                entries = list(self._approvals_by_id.values())
                for session_key in {entry["sessionKey"] for entry in entries}:
                    self._bump_approval_drain_generation_locked(session_key)
                    self._mirrored_native_entry_ids.pop(session_key, None)
                    self._approval_resolution_tombstones.pop(session_key, None)
                self._approvals_by_id.clear()
                self._approval_order_by_session.clear()
                self._approval_resolve_locks.clear()
                self._approval_resolution_tombstones.clear()
                self._approval_suppressed_responses.clear()
                self._approval_drained_ids.clear()
            for timer in timers:
                self._cancel_approval_timer(timer)
            for task in tasks:
                task.cancel()
            for entry in entries:
                self._suppress_native_approval_response(entry, "deny")
                try:
                    resolved = self._resolve_native_approval_entry(entry, "deny")
                    if resolved <= 0:
                        self._unsuppress_native_approval_response(
                            entry["sessionKey"],
                            "deny",
                            entry=entry,
                        )
                except Exception:  # noqa: BLE001
                    self._unsuppress_native_approval_response(
                        entry["sessionKey"],
                        "deny",
                        entry=entry,
                    )
                    logger.debug(
                        "[ocuclaw] approval disconnect deny failed for %s",
                        entry.get("id"),
                        exc_info=True,
                    )
                self._emit_approval_resolved(entry, "deny")
                self._forget_mirrored_native_entry(entry)

        def _handle_gateway_approval(
            self,
            session_key: str,
            approval_data: Dict[str, Any],
            *,
            swallow_errors: bool = True,
        ) -> Tuple[Dict[str, Any], Optional[Any]]:
            data = approval_data if isinstance(approval_data, dict) else {}
            command = str(data.get("command") or "").strip()
            description = str(data.get("description") or "").strip()
            created_ms = int(time.time() * 1000)
            timeout_s = self._approval_timeout_seconds()
            expires_ms = created_ms + timeout_s * 1000
            public_key = self._public_key_for_native_session(session_key)
            identity = parse_ocuclaw_session_key(session_key) or {}
            smart_denied = bool(data.get("smart_denied"))
            allow_session = bool(data.get("allow_session", True)) and not smart_denied
            allowed_decisions = ["allow-once"]
            if allow_session:
                allowed_decisions.append("allow-session")
            allowed_decisions.append("deny")
            with self._approval_lock:
                self._approval_seq += 1
                approval_id = f"hermes-approval-{self._approval_seq}"
                request_id = f"{approval_id}:request"
                entry = {
                    "id": approval_id,
                    "requestId": request_id,
                    "sessionKey": session_key,
                    "publicKey": public_key,
                    "allowPermanent": bool(data.get("allow_permanent")),
                    "smartDenied": smart_denied,
                    "allowedDecisions": allowed_decisions,
                    "expiresAtMs": expires_ms,
                    "command": command,
                    "description": description,
                    "patternKey": str(data.get("pattern_key") or ""),
                    "nativeEntryId": data.get("native_entry_id"),
                    "nativeMirrorToken": str(data.get("native_mirror_token") or ""),
                }
                self._approvals_by_id[approval_id] = entry
                self._approval_order_by_session.setdefault(session_key, []).append(
                    approval_id
                )
            request: Dict[str, Any] = {
                "command": command or description or "approval required",
                "host": "hermes",
                "agentId": identity.get("ns") or self._namespace,
                "security": "high",
                "ask": description or "approval required",
                "allowedDecisions": allowed_decisions,
            }
            if public_key:
                request["sessionKey"] = public_key
            delivery = self._emit_event(
                "approval",
                {
                    "id": approval_id,
                    "requestId": request_id,
                    "createdAtMs": created_ms,
                    "expiresAtMs": expires_ms,
                    "request": request,
                },
                swallow_errors=swallow_errors,
            )
            self._schedule_approval_timeout(approval_id, timeout_s)
            return entry, delivery

        def _schedule_approval_timeout(self, approval_id: str, timeout_s: float) -> None:
            loop = self._loop
            if loop is None or loop.is_closed():
                return

            def _schedule() -> None:
                if approval_id not in self._approvals_by_id:
                    return
                def _fire() -> None:
                    task = loop.create_task(self._expire_approval(approval_id))
                    self._track_approval_expiry_task(task)

                handle = loop.call_later(
                    max(0, timeout_s),
                    _fire,
                )
                with self._approval_lock:
                    if approval_id in self._approvals_by_id:
                        self._approval_timers[approval_id] = handle
                    else:
                        self._cancel_approval_timer(handle)

            loop.call_soon_threadsafe(_schedule)

        def _cancel_approval_timer(self, timer: Any) -> None:
            cancel = getattr(timer, "cancel", None)
            if not callable(cancel):
                return
            loop = self._loop
            if loop is not None and not loop.is_closed():
                try:
                    loop.call_soon_threadsafe(cancel)
                    return
                except RuntimeError:
                    pass
            cancel()

        def _approval_resolve_lock(self, session_key: str) -> asyncio.Lock:
            lock = self._approval_resolve_locks.get(session_key)
            if lock is None:
                lock = asyncio.Lock()
                self._approval_resolve_locks[session_key] = lock
            return lock

        def _prune_expired_approval_tombstones_locked(
            self,
            now: Optional[float] = None,
        ) -> None:
            cutoff = time.time() if now is None else now
            self._approval_drained_ids = {
                approval_id: expires_at
                for approval_id, expires_at in self._approval_drained_ids.items()
                if expires_at > cutoff
            }
            for session_key, tombstones in list(
                self._approval_resolution_tombstones.items()
            ):
                keep = [
                    item
                    for item in tombstones
                    if float(item.get("expiresAt") or 0) > cutoff
                ]
                if keep:
                    self._approval_resolution_tombstones[session_key] = keep
                else:
                    self._approval_resolution_tombstones.pop(session_key, None)
                if not self._approval_suppressed_responses.get(session_key):
                    self._approval_suppressed_responses.pop(session_key, None)

        def _approval_session_has_pending_locked(self, session_key: str) -> bool:
            if self._approval_order_by_session.get(session_key):
                return True
            return any(
                entry.get("sessionKey") == session_key
                for entry in self._approvals_by_id.values()
            )

        def _prune_approval_session_maps(self, session_key: str) -> None:
            with self._approval_lock:
                self._prune_expired_approval_tombstones_locked()
                if self._approval_session_has_pending_locked(session_key):
                    return
                lock = self._approval_resolve_locks.get(session_key)
                if lock is not None and lock.locked():
                    return
                self._approval_resolve_locks.pop(session_key, None)
                if not self._approval_resolution_tombstones.get(session_key):
                    self._approval_resolution_tombstones.pop(session_key, None)

        def _approval_response_surface_is_mirrored(self, surface: Any) -> bool:
            value = str(surface or "").strip().lower()
            return (
                value == "gateway"
                or value == "mcp-elicitation"
                or value.startswith("mcp-elicitation/")
            )

        def _approval_response_identity(
            self,
            entry: Optional[Dict[str, Any]] = None,
            kwargs: Optional[Dict[str, Any]] = None,
        ) -> Dict[str, str]:
            data = entry if entry is not None else (kwargs if kwargs is not None else {})
            return {
                "patternKey": str(
                    (
                        data.get("patternKey")
                        if entry is not None
                        else data.get("pattern_key")
                    )
                    or ""
                ).strip(),
                "command": self._redact_native_approval_command(data.get("command")),
                "description": str(data.get("description") or "").strip(),
            }

        def _suppress_native_approval_response(
            self,
            entry: Dict[str, Any],
            choice: str,
        ) -> None:
            session_key = entry["sessionKey"]
            token = {
                "choice": str(choice or "").strip().lower(),
                "expiresAt": time.time() + 60.0,
                **self._approval_response_identity(entry=entry),
            }
            with self._approval_lock:
                self._approval_suppressed_responses.setdefault(session_key, []).append(
                    token
                )

        def _unsuppress_native_approval_response(
            self,
            session_key: str,
            choice: str,
            *,
            entry: Optional[Dict[str, Any]] = None,
            kwargs: Optional[Dict[str, Any]] = None,
        ) -> bool:
            identity = self._approval_response_identity(entry=entry, kwargs=kwargs)
            normalized_choice = str(choice or "").strip().lower()

            def _matches(token: Dict[str, str]) -> bool:
                if token.get("choice") != normalized_choice:
                    return False
                token_command = token.get("command") or ""
                if token_command or identity["command"]:
                    if token_command != identity["command"]:
                        return False
                token_description = token.get("description") or ""
                if token_description or identity["description"]:
                    if token_description != identity["description"]:
                        return False
                token_pattern = token.get("patternKey") or ""
                if token_pattern and identity["patternKey"]:
                    return token_pattern == identity["patternKey"]
                return True

            with self._approval_lock:
                tokens = self._approval_suppressed_responses.get(session_key)
                if not tokens:
                    return False
                now = time.time()
                tokens[:] = [
                    token
                    for token in tokens
                    if float(token.get("expiresAt") or 0) > now
                ]
                if not tokens:
                    self._approval_suppressed_responses.pop(session_key, None)
                    return False
                index = next(
                    (i for i, token in enumerate(tokens) if _matches(token)),
                    None,
                )
                if index is None:
                    return False
                tokens.pop(index)
                if not tokens:
                    self._approval_suppressed_responses.pop(session_key, None)
                return True

        def _bump_approval_drain_generation_locked(self, session_key: str) -> None:
            self._approval_drain_generation[session_key] = (
                self._approval_drain_generation.get(session_key, 0) + 1
            )

        def _mark_drained_approval_ids_locked(self, approval_ids: List[str]) -> None:
            expires_at = time.time() + 60.0
            self._prune_expired_approval_tombstones_locked()
            for approval_id in approval_ids:
                self._approval_drained_ids[approval_id] = expires_at

        def _claim_native_approval_snapshot(
            self,
            session_key: str,
            command: str = "",
            description: str = "",
        ) -> Optional[Dict[str, Any]]:
            return None

        def _redact_native_approval_command(self, command: Any) -> str:
            return str(command or "").strip()

        def _forget_mirrored_native_entry(self, entry: Dict[str, Any]) -> None:
            native_id = entry.get("nativeEntryId")
            if native_id is None:
                return
            session_key = entry["sessionKey"]
            with self._approval_lock:
                claimed = self._mirrored_native_entry_ids.get(session_key)
                if claimed is None:
                    return
                claimed.discard(native_id)
                if not claimed:
                    self._mirrored_native_entry_ids.pop(session_key, None)

        def _track_approval_expiry_task(self, task: asyncio.Task) -> None:
            self._approval_expiry_tasks.add(task)
            task.add_done_callback(self._approval_expiry_tasks.discard)

        def _approval_ids_for_session(self, session_key: str) -> List[str]:
            with self._approval_lock:
                ordered = list(self._approval_order_by_session.get(session_key, []))
                extras = [
                    approval_id
                    for approval_id, entry in self._approvals_by_id.items()
                    if entry.get("sessionKey") == session_key
                    and approval_id not in ordered
                ]
                return [*ordered, *extras]

        def _defer_drain_session_approvals(
            self,
            session_key: str,
            approval_ids: Optional[List[str]] = None,
        ) -> None:
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            future = asyncio.run_coroutine_threadsafe(
                self._drain_session_approvals(session_key, approval_ids=approval_ids),
                loop,
            )

            def _log_drain_error(done: Any) -> None:
                try:
                    done.result()
                except Exception:  # noqa: BLE001
                    logger.debug(
                        "[ocuclaw] approval turn-end drain failed for %s",
                        session_key,
                        exc_info=True,
                    )

            future.add_done_callback(_log_drain_error)

        def _restore_approval_entry(
            self,
            entry: Dict[str, Any],
            drain_generation: Optional[int] = None,
            min_delay_s: float = 0.0,
        ) -> bool:
            approval_id = entry["id"]
            session_key = entry["sessionKey"]
            with self._approval_lock:
                self._prune_expired_approval_tombstones_locked()
                if approval_id in self._approval_drained_ids:
                    return False
                if (
                    drain_generation is not None
                    and self._approval_drain_generation.get(session_key, 0)
                    != drain_generation
                ):
                    return False
                self._approvals_by_id[approval_id] = entry
                order = self._approval_order_by_session.setdefault(session_key, [])
                if approval_id in order:
                    order.remove(approval_id)
                order.insert(0, approval_id)
            remaining_s = max(
                min_delay_s,
                (float(entry.get("expiresAtMs") or 0) - time.time() * 1000) / 1000,
            )
            self._schedule_approval_timeout(approval_id, remaining_s)
            return True

        async def _drain_session_approvals(
            self,
            session_key: str,
            approval_ids: Optional[List[str]] = None,
        ) -> int:
            with self._approval_lock:
                if approval_ids is None:
                    self._bump_approval_drain_generation_locked(session_key)
                    self._approval_resolution_tombstones.pop(session_key, None)
                    approval_ids = self._approval_ids_for_session(session_key)
                else:
                    approval_ids = list(approval_ids)
                self._mark_drained_approval_ids_locked(approval_ids)
                entries = []
                timers = []
                for approval_id in approval_ids:
                    entry = self._approvals_by_id.pop(approval_id, None)
                    if entry is not None:
                        entries.append(entry)
                    order = self._approval_order_by_session.get(session_key)
                    if order and approval_id in order:
                        order.remove(approval_id)
                        if not order:
                            self._approval_order_by_session.pop(session_key, None)
                    timer = self._approval_timers.pop(approval_id, None)
                    if timer is not None:
                        timers.append(timer)
            for timer in timers:
                self._cancel_approval_timer(timer)
            if entries:
                async with self._approval_resolve_lock(session_key):
                    for entry in entries:
                        self._suppress_native_approval_response(entry, "deny")
                        try:
                            resolved = await asyncio.to_thread(
                                self._resolve_native_approval_entry,
                                entry,
                                "deny",
                            )
                            if resolved <= 0:
                                self._unsuppress_native_approval_response(
                                    entry["sessionKey"],
                                    "deny",
                                    entry=entry,
                                )
                        except Exception:  # noqa: BLE001
                            self._unsuppress_native_approval_response(
                                entry["sessionKey"],
                                "deny",
                                entry=entry,
                            )
                            logger.debug(
                                "[ocuclaw] approval drain deny failed for %s",
                                entry.get("id"),
                                exc_info=True,
                            )
                        self._emit_approval_resolved(entry, "deny")
                        self._forget_mirrored_native_entry(entry)
            self._prune_approval_session_maps(session_key)
            return len(entries)

        def _pop_approval_entry(
            self,
            approval_id: str,
            *,
            cancel_timer: bool = True,
        ) -> Optional[Dict[str, Any]]:
            with self._approval_lock:
                entry = self._approvals_by_id.pop(approval_id, None)
                if entry is None:
                    return None
                timer = self._approval_timers.pop(approval_id, None)
                order = self._approval_order_by_session.get(entry["sessionKey"], [])
                if approval_id in order:
                    order.remove(approval_id)
                if not order:
                    self._approval_order_by_session.pop(entry["sessionKey"], None)
            if cancel_timer and timer is not None:
                self._cancel_approval_timer(timer)
            return entry

        def _approval_is_session_head(self, entry: Dict[str, Any]) -> bool:
            with self._approval_lock:
                order = self._approval_order_by_session.get(entry["sessionKey"], [])
                return bool(order and order[0] == entry["id"])

        def _resolve_native_approval_entry(
            self,
            entry: Dict[str, Any],
            choice: str,
            reason: Optional[str] = None,
        ) -> int:
            # Hermes resolves the session FIFO head, not an id, and its
            # enqueue/notify is not atomic, so concurrent same-session local order
            # can diverge. We resolve only our locked local head; the #674 H2
            # post-flip two-concurrent-approvals test carries the ordering proof.
            from tools.approval import resolve_gateway_approval

            return resolve_gateway_approval(
                entry["sessionKey"],
                choice,
                reason=reason,
            )

        def _emit_approval_resolved(
            self,
            entry: Dict[str, Any],
            decision: str,
        ) -> None:
            self._emit_event(
                "approvalResolved",
                {
                    "id": entry["id"],
                    "requestId": entry["requestId"],
                    "decision": decision,
                },
            )

        async def _expire_approval(self, approval_id: str) -> bool:
            with self._approval_lock:
                current = self._approvals_by_id.get(approval_id)
            if current is None:
                return False
            async with self._approval_resolve_lock(current["sessionKey"]):
                with self._approval_lock:
                    current = self._approvals_by_id.get(approval_id)
                if current is None:
                    return False
                if not self._approval_is_session_head(current):
                    # Hermes' native approval resolver is session FIFO, not id-based.
                    # A non-head timeout must not deny whichever native prompt is at
                    # the head; retry after the earlier mirror entry resolves.
                    self._schedule_approval_timeout(approval_id, 1.0)
                    return False
                with self._approval_lock:
                    drain_generation = self._approval_drain_generation.get(
                        current["sessionKey"],
                        0,
                    )
                entry = self._pop_approval_entry(approval_id)
                if entry is None:
                    return False
                try:
                    self._suppress_native_approval_response(entry, "deny")
                    resolved = await asyncio.to_thread(
                        self._resolve_native_approval_entry,
                        entry,
                        "deny",
                    )
                    if resolved <= 0:
                        self._unsuppress_native_approval_response(
                            entry["sessionKey"],
                            "deny",
                            entry=entry,
                        )
                except Exception:  # noqa: BLE001
                    self._unsuppress_native_approval_response(
                        entry["sessionKey"],
                        "deny",
                        entry=entry,
                    )
                    restored = self._restore_approval_entry(
                        entry,
                        drain_generation,
                        min_delay_s=1.0,
                    )
                    if not restored:
                        self._forget_mirrored_native_entry(entry)
                        self._emit_approval_resolved(entry, "deny")
                        return True
                    logger.debug(
                        "[ocuclaw] approval timeout deny failed for %s",
                        approval_id,
                        exc_info=True,
                    )
                    return False
                if resolved <= 0:
                    if time.time() * 1000 > float(entry.get("expiresAtMs") or 0) + 30000:
                        decision = (
                            self._consume_native_resolution_tombstone(entry) or "deny"
                        )
                        self._forget_mirrored_native_entry(entry)
                        self._emit_approval_resolved(entry, decision)
                        return True
                    restored = self._restore_approval_entry(
                        entry,
                        drain_generation,
                        min_delay_s=1.0,
                    )
                    if not restored:
                        self._forget_mirrored_native_entry(entry)
                        self._emit_approval_resolved(entry, "deny")
                        return True
                    return False
            self._forget_mirrored_native_entry(entry)
            self._emit_approval_resolved(entry, "deny")
            return True

        def _native_approval_choice(
            self,
            decision: str,
            entry: Dict[str, Any],
        ) -> Tuple[str, str]:
            if decision == "allow-once":
                return "once", decision
            if decision == "allow-session":
                return "session", decision
            if decision == "deny":
                return "deny", decision
            if decision == "allow-always":
                # No entry allows this through authz; keep as defense-in-depth.
                if entry.get("allowPermanent"):
                    return "always", decision
                return "session", "allow-session"
            raise ValueError(
                "approval decision must be allow-once|allow-session|allow-always|deny"
            )

        def _public_decision_from_native_choice(
            self,
            choice: str,
            entry: Dict[str, Any],
        ) -> Optional[str]:
            if choice == "once":
                return "allow-once"
            if choice == "session":
                return "allow-session"
            if choice == "always":
                return "allow-always"
            if choice in ("deny", "timeout"):
                return "deny"
            return None

        def _native_response_matches_entry(
            self,
            entry: Dict[str, Any],
            command: str,
            description: str,
            pattern_key: str,
        ) -> bool:
            if self._redact_native_approval_command(entry.get("command")) != command:
                return False
            if str(entry.get("description") or "").strip() != description:
                return False
            entry_pattern = str(entry.get("patternKey") or "").strip()
            return not (pattern_key and entry_pattern and entry_pattern != pattern_key)

        def _record_native_resolution_tombstone(
            self,
            session_key: str,
            command: str,
            description: str,
            pattern_key: str,
            choice: str,
        ) -> None:
            now = time.time()
            tombstone = {
                "command": command,
                "description": description,
                "patternKey": pattern_key,
                "decision": self._public_decision_from_native_choice(choice, {}) or "deny",
                "expiresAt": now + 60.0,
            }
            with self._approval_lock:
                self._prune_expired_approval_tombstones_locked(now)
                tombstones = [
                    item
                    for item in self._approval_resolution_tombstones.get(
                        session_key,
                        [],
                    )
                    if float(item.get("expiresAt") or 0) > now
                ]
                tombstones.append(tombstone)
                self._approval_resolution_tombstones[session_key] = tombstones

        def _consume_native_resolution_tombstone(
            self,
            entry: Dict[str, Any],
        ) -> Optional[str]:
            session_key = entry["sessionKey"]
            command = self._redact_native_approval_command(entry.get("command"))
            description = str(entry.get("description") or "").strip()
            pattern_key = str(entry.get("patternKey") or "").strip()
            now = time.time()
            with self._approval_lock:
                self._prune_expired_approval_tombstones_locked(now)
                tombstones = self._approval_resolution_tombstones.get(session_key)
                if not tombstones:
                    return None
                keep = []
                matched = None
                for tombstone in tombstones:
                    if float(tombstone.get("expiresAt") or 0) <= now:
                        continue
                    tombstone_pattern = str(tombstone.get("patternKey") or "").strip()
                    if (
                        matched is None
                        and str(tombstone.get("command") or "").strip() == command
                        and str(tombstone.get("description") or "").strip()
                        == description
                        and not (
                            pattern_key
                            and tombstone_pattern
                            and tombstone_pattern != pattern_key
                        )
                    ):
                        matched = str(tombstone.get("decision") or "deny")
                        continue
                    keep.append(tombstone)
                if keep:
                    self._approval_resolution_tombstones[session_key] = keep
                else:
                    self._approval_resolution_tombstones.pop(session_key, None)
                return matched

        def _pop_approval_by_native_response(
            self,
            session_key: str,
            command: str,
            description: str,
            pattern_key: str,
        ) -> Optional[Dict[str, Any]]:
            command = self._redact_native_approval_command(command)
            description = description.strip()
            pattern_key = pattern_key.strip()
            with self._approval_lock:
                ordered = list(self._approval_order_by_session.get(session_key, []))
                approval_id = None
                matches = []
                for candidate_id in ordered:
                    candidate = self._approvals_by_id.get(candidate_id)
                    if candidate is None:
                        continue
                    if self._native_response_matches_entry(
                        candidate,
                        command,
                        description,
                        pattern_key,
                    ):
                        matches.append(candidate_id)
                if len(matches) == 1:
                    approval_id = matches[0]
                if approval_id is None:
                    return None
                order = self._approval_order_by_session.get(session_key, [])
                if approval_id in order:
                    order.remove(approval_id)
                if not order:
                    self._approval_order_by_session.pop(session_key, None)
                entry = self._approvals_by_id.pop(approval_id, None)
                timer = self._approval_timers.pop(approval_id, None)
            if entry is not None:
                self._forget_mirrored_native_entry(entry)
            if timer is not None:
                self._cancel_approval_timer(timer)
            self._prune_approval_session_maps(session_key)
            return entry

        def handle_post_approval_response(self, kwargs: Dict[str, Any]) -> None:
            if not self._approval_response_surface_is_mirrored(
                kwargs.get("surface"),
            ):
                return
            session_key = str(kwargs.get("session_key") or "")
            choice = str(kwargs.get("choice") or "").strip().lower()
            if not session_key or not choice:
                return
            if self._unsuppress_native_approval_response(
                session_key,
                choice,
                kwargs=kwargs,
            ):
                return
            entry = self._pop_approval_by_native_response(
                session_key,
                str(kwargs.get("command") or ""),
                str(kwargs.get("description") or ""),
                str(kwargs.get("pattern_key") or ""),
            )
            if entry is None:
                self._record_native_resolution_tombstone(
                    session_key,
                    self._redact_native_approval_command(kwargs.get("command")),
                    str(kwargs.get("description") or "").strip(),
                    str(kwargs.get("pattern_key") or "").strip(),
                    choice,
                )
                return
            decision = self._public_decision_from_native_choice(choice, entry)
            if decision is None:
                self._restore_approval_entry(entry)
                return
            self._emit_approval_resolved(entry, decision)

        def _background_hook_turn(self, kwargs: Dict[str, Any]) -> bool:
            key = (
                str(kwargs.get("session_id") or "").strip(),
                str(kwargs.get("turn_id") or "").strip(),
            )
            with self._thinking_lock:
                return key in self._background_hook_turns

        def _remember_background_hook_turn(self, kwargs: Dict[str, Any]) -> None:
            key = (
                str(kwargs.get("session_id") or "").strip(),
                str(kwargs.get("turn_id") or "").strip(),
            )
            if not all(key):
                return
            with self._thinking_lock:
                self._background_hook_turns[key] = None
                while len(self._background_hook_turns) > BACKGROUND_HOOK_TURN_MEMORY:
                    self._background_hook_turns.pop(next(iter(self._background_hook_turns)))

        def _turn_activity_context(
            self, kwargs: Dict[str, Any], hook_label: str
        ) -> Optional[Tuple[str, Any]]:
            platform = str(kwargs.get("platform") or "").strip()
            if platform and platform != PLATFORM_NAME:
                return None
            if self._background_hook_turn(kwargs):
                return None
            session_id = str(kwargs.get("session_id") or "").strip()
            if not session_id:
                return None
            try:
                row = self._session_rpc.row_by_id(session_id)
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "[ocuclaw] %s session row lookup failed for %s: %s",
                    hook_label,
                    session_id,
                    exc,
                )
                return None
            if not row:
                return None
            session_key = str(row.get("session_key") or "")
            identity = parse_ocuclaw_session_key(session_key)
            if identity is None:
                return None
            record = self._ledger.head(session_key)
            if record is None:
                record = self._ledger.touch(session_key)
                if record is None:
                    return None
                if self._ledger.take_lifecycle_start(record):
                    self._emit_event("activity", lifecycle_start_activity(record))
            if record.kind == KIND_SLASH:
                logger.debug(
                    "[ocuclaw] stale %s for %s ignored (slash head)",
                    hook_label,
                    session_key,
                )
                return None
            if self._ledger.cancel_fence_active(session_key):
                try:
                    newest = self._session_rpc.newest_carrier_id(session_key)
                except Exception:  # noqa: BLE001
                    newest = None
                if newest is not None and newest != session_id:
                    logger.debug(
                        "[ocuclaw] stale %s for %s ignored "
                        "(pre-reset carrier %s, newest %s)",
                        hook_label,
                        session_key,
                        session_id,
                        newest,
                    )
                    return None
            self._ledger.touch(session_key)
            return session_key, record

        def _tool_activity_context(
            self, kwargs: Dict[str, Any]
        ) -> Optional[Tuple[str, str, Any]]:
            tool_name = str(kwargs.get("tool_name") or "").strip()
            if not tool_name:
                return None
            context = self._turn_activity_context(kwargs, "tool hook")
            if context is None:
                return None
            session_key, record = context
            return session_key, tool_name, record

        @staticmethod
        def _read_reasoning_field(source: Any, field: str) -> Any:
            if isinstance(source, dict):
                return source.get(field)
            return getattr(source, field, None)

        @staticmethod
        def _truncate_thinking_delta(text: str) -> str:
            if len(text) <= THINKING_FRAME_MAX_CHARS:
                return text
            keep = max(
                0,
                THINKING_FRAME_MAX_CHARS - len(THINKING_FRAME_TRUNCATION_SUFFIX),
            )
            return text[:keep] + THINKING_FRAME_TRUNCATION_SUFFIX

        @staticmethod
        def _cap_cumulative_thinking_text(text: str) -> str:
            cleaned = str(text or "").strip()
            if len(cleaned) <= THINKING_FRAME_MAX_CHARS:
                return cleaned
            keep = max(
                0,
                THINKING_FRAME_MAX_CHARS - len(THINKING_FRAME_TRUNCATION_PREFIX),
            )
            return THINKING_FRAME_TRUNCATION_PREFIX + cleaned[-keep:]

        @staticmethod
        def _coerce_reasoning_value(raw: Any) -> str:
            if isinstance(raw, str):
                return raw.strip()
            if isinstance(raw, list):
                parts: List[str] = []
                for item in raw:
                    if isinstance(item, str):
                        part = item.strip()
                    elif isinstance(item, dict):
                        part = str(item.get("thinking") or item.get("text") or "").strip()
                    else:
                        part = str(
                            getattr(item, "thinking", "")
                            or getattr(item, "text", "")
                            or ""
                        ).strip()
                    if part:
                        parts.append(part)
                return "\n".join(parts).strip()
            return ""

        @classmethod
        def _reasoning_detail_entries(cls, assistant_message: Any) -> List[Dict[str, Any]]:
            """``reasoning_details`` as a list of dicts (OpenRouter unified)."""
            raw = cls._read_reasoning_field(assistant_message, "reasoning_details")
            if not isinstance(raw, list):
                return []
            entries: List[Dict[str, Any]] = []
            for item in raw:
                if isinstance(item, dict):
                    entries.append(item)
            return entries

        @staticmethod
        def _reasoning_detail_text(entry: Dict[str, Any]) -> str:
            for key in ("summary", "thinking", "content", "text"):
                value = entry.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            return ""

        @classmethod
        def _extract_assistant_reasoning(cls, assistant_message: Any) -> Optional[str]:
            """Every reasoning carrier this provider surface actually uses.

            `reasoning` alone is empty on streamed chat_completions turns —
            the text lands in `reasoning_content` (provider_data passthrough)
            or in the `reasoning_details` array — so reading one field means
            no thinking frame at all on the most common lane.
            """
            parts: List[str] = []
            for field in ("reasoning", "reasoning_content"):
                text = cls._coerce_reasoning_value(
                    cls._read_reasoning_field(assistant_message, field)
                )
                if text and text not in parts:
                    parts.append(text)
            for entry in cls._reasoning_detail_entries(assistant_message):
                detail_text = cls._reasoning_detail_text(entry)
                if detail_text and detail_text not in parts:
                    parts.append(detail_text)
            text = "\n".join(parts).strip()
            if not text:
                return None
            if len(text) > THINKING_FRAME_MAX_CHARS:
                return cls._truncate_thinking_delta(text)
            return text

        @staticmethod
        def _normalize_thinking_headline(raw: Any) -> Optional[str]:
            """One markdown-free line, ≤80 chars, or None."""
            text = str(raw or "").strip()
            if not text:
                return None
            text = THINKING_HEADLINE_LEADER_RE.sub("", text)
            text = THINKING_HEADLINE_STRIP_RE.sub("", text)
            text = " ".join(text.split())
            if not text:
                return None
            if len(text) > THINKING_HEADLINE_MAX_CHARS:
                clipped = text[:THINKING_HEADLINE_MAX_CHARS]
                boundary = clipped.rfind(" ")
                text = (clipped[:boundary] if boundary > 0 else clipped).rstrip()
            return text or None

        @classmethod
        def _derive_thinking_headline(
            cls,
            assistant_message: Any,
            reasoning: Optional[str],
            provider: Any = None,
            model: Any = None,
        ) -> Tuple[Optional[str], str]:
            """``(headline, thinkingSummarySource)`` for one model call.

            Order: a CLOSED ``**bold**` span in the reasoning text (the shape
            gpt-5.x style reasoning writes its own section headers in), then a
            typed ``reasoning.summary`` detail entry that is genuinely one
            short line. Everything else is prose and degrades to ``detail`` —
            which, by the frame split in ``handle_post_api_request``, means the
            status line says "Thinking..." instead of a truncated slab.

            ``provider``/``model`` are accepted deliberately and never
            branched on: upstream's own provider discrimination
            (agent/reasoning_summaries.py) is heuristic, so asserting
            "this provider emits summaries" would manufacture a headline out
            of prose. Degrade, never assert.
            """
            bold_match = THINKING_BOLD_SPAN_RE.search(str(reasoning or ""))
            if bold_match:
                headline = cls._normalize_thinking_headline(bold_match.group(1))
                if headline:
                    return headline, "bold"
            for entry in cls._reasoning_detail_entries(assistant_message):
                entry_type = str(entry.get("type") or "").strip().lower()
                if entry_type != REASONING_SUMMARY_DETAIL_TYPE:
                    continue
                raw = cls._reasoning_detail_text(entry)
                if not raw or "\n" in raw:
                    continue
                if len(raw) > THINKING_HEADLINE_MAX_CHARS:
                    continue
                headline = cls._normalize_thinking_headline(raw)
                if headline:
                    return headline, "summary"
            return None, "detail"

        @staticmethod
        def _append_thinking_text(previous: str, next_text: str) -> str:
            prev = str(previous or "").strip()
            nxt = str(next_text or "").strip()
            if not nxt:
                return prev
            if not prev:
                return nxt
            if nxt.startswith(prev):
                return nxt
            if nxt in prev:
                return prev
            return f"{prev}\n{nxt}"

        def _cumulative_thinking_text(self, run_id: str, reasoning: str) -> str:
            with self._thinking_lock:
                text = self._append_thinking_text(
                    self._thinking_text_by_run.get(run_id, ""),
                    reasoning,
                )
                text = self._cap_cumulative_thinking_text(text)
                self._thinking_text_by_run[run_id] = text
                return text

        def _next_thinking_seq(self, run_id: Any) -> int:
            key = str(run_id or "").strip()
            with self._thinking_lock:
                seq = self._thinking_seq_by_run.get(key, 0) + 1
                self._thinking_seq_by_run[key] = seq
                return seq

        def _extend_thinking_text(self, run_id: str, delta: str) -> str:
            """Append a raw STREAM chunk (never a cumulative snapshot).

            Deliberately not `_cumulative_thinking_text`: that one joins with a
            newline and swallows a chunk already contained in the buffer, which
            is right for whole-reasoning snapshots and wrong for token deltas —
            it would insert newlines mid-word and drop repeated fragments.
            """
            chunk = str(delta or "")
            if not chunk:
                return self._thinking_text_by_run.get(run_id, "")
            with self._thinking_lock:
                # NOT `_cap_cumulative_thinking_text`: that one strips, which
                # is right for a whole-reasoning snapshot and wrong mid-stream
                # — it would eat the trailing space of every chunk and glue
                # the next one onto the previous word.
                text = self._cap_stream_thinking_text(
                    self._thinking_text_by_run.get(run_id, "") + chunk
                )
                self._thinking_text_by_run[run_id] = text
                return text

        @staticmethod
        def _cap_stream_thinking_text(text: str) -> str:
            raw = str(text or "")
            if len(raw) <= THINKING_FRAME_MAX_CHARS:
                return raw
            keep = max(
                0,
                THINKING_FRAME_MAX_CHARS - len(THINKING_FRAME_TRUNCATION_PREFIX),
            )
            return THINKING_FRAME_TRUNCATION_PREFIX + raw[-keep:]

        @staticmethod
        def _stream_join_separator(previous: str) -> str:
            """Separator between two model calls' reasoning in one turn."""
            return (
                "\n"
                if previous and not previous.endswith(("\n", " "))
                else ""
            )

        def _reset_thinking_text(self, run_id: str, text: str) -> str:
            """Replace the cumulative buffer with an authoritative snapshot."""
            with self._thinking_lock:
                capped = self._cap_cumulative_thinking_text(text)
                self._thinking_text_by_run[run_id] = capped
                return capped

        def _reconcile_thinking_text(self, run_id: Any, reasoning: str) -> str:
            """Authoritative text for one model call.

            When deltas painted this call, REPLACE exactly what they appended
            rather than appending a second copy of the same reasoning: the
            snapshot is the same content, differently chunked, so an append
            would duplicate the tail and a blind reset would erase earlier
            iterations of the same turn.
            """
            key = str(run_id or "").strip()
            with self._thinking_lock:
                appended = self._stream_appended_by_run.pop(key, "")
                buffered = self._thinking_text_by_run.get(key, "")
                if appended and buffered.endswith(appended):
                    prefix = buffered[: len(buffered) - len(appended)]
                    return self._reset_thinking_text(
                        key,
                        prefix
                        + self._stream_join_separator(prefix)
                        + reasoning,
                    )
            return self._cumulative_thinking_text(key, reasoning)

        def _finalize_thinking_pane(self, run_id: Any, session_key: Any) -> bool:
            """Close an OPEN thinking pane exactly once per model call."""
            key = str(run_id or "").strip()
            with self._thinking_lock:
                if key not in self._open_pane_runs:
                    return False
                self._open_pane_runs.discard(key)
            self._emit_event(
                "thinking",
                {
                    "phase": "finalize",
                    "runId": run_id,
                    "sessionKey": session_key,
                    "reason": STREAM_END_FINALIZE_REASON,
                    "seq": self._next_thinking_seq(run_id),
                },
            )
            return True

        def _thinking_epoch(self, run_id: Any) -> int:
            key = str(run_id or "").strip()
            with self._thinking_lock:
                return self._thinking_epoch_by_run.get(key, 0)

        def _bump_thinking_epoch(self, run_id: Any) -> int:
            key = str(run_id or "").strip()
            with self._thinking_lock:
                epoch = self._thinking_epoch_by_run.get(key, 0) + 1
                self._thinking_epoch_by_run[key] = epoch
                return epoch

        def _forget_thinking_run(self, run_id: Any) -> None:
            key = str(run_id or "").strip()
            if not key:
                return
            with self._thinking_lock:
                self._thinking_text_by_run.pop(key, None)
                self._thinking_seq_by_run.pop(key, None)
                self._narration_texts_by_run.pop(key, None)
                self._narration_raw_by_run.pop(key, None)
                self._committed_texts_by_run.pop(key, None)
                self._committed_ids_by_run.pop(key, None)
                self._pending_tool_progress_by_run.pop(key, None)
                self._tool_progress_message_ids_by_run.pop(key, None)
                self._stream_text_origin_by_run.pop(key, None)
                self._narration_origin_by_run.pop(key, None)
                self._thinking_epoch_by_run.pop(key, None)
                self._stream_appended_by_run.pop(key, None)
                self._open_pane_runs.discard(key)
                for stream_key in [
                    stream_key
                    for stream_key, entry in self._stream_contexts.items()
                    if entry.get("runId") == key
                ]:
                    self._stream_contexts.pop(stream_key, None)

        @staticmethod
        def _send_is_interim_commentary(metadata: Any) -> bool:
            """True for a StreamConsumer commentary send.

            Gated on the narration hook actually being REGISTERED: the tag
            makes the client drop the page, and dropping it with no
            `agent_progress_notes` capability advertised would delete the
            sentence with no row to explain where it went.
            """
            if FEATURE_TOKEN_INTERIM_HOOK not in _hermes_feature_tokens():
                return False
            return (
                isinstance(metadata, dict)
                and metadata.get(INTERIM_SEND_METADATA_KEY) is True
            )

        @staticmethod
        def _normalize_narration_text(text: Any) -> str:
            """Whitespace-insensitive identity for narration matching.

            Since #1691 a commit carries a message id and a retag names it,
            but text stays the fallback (and the only key for the mid-reveal
            prefix upgrade). The carriers reflow whitespace, so the text
            identity has to survive that.
            """
            return " ".join(str(text or "").split())

        @staticmethod
        def _now_ms() -> int:
            """Wall-clock milliseconds.

            Wall clock, not monotonic, because the consumer compares this
            against its own `Date.now()` arrival stamps. Adapter and Node
            runtime share a host (and a container, on a pet), so the two
            clocks are the same clock.
            """
            return int(time.time() * 1000)

        def _note_text_stream_origin(self, entry: Dict[str, Any]) -> None:
            """Stamp the FIRST content delta of one model call (#1619).

            One stamp per (stream, iteration): `_stream_turn_context` clears
            the marker when a new iteration re-arms the entry, so a turn with
            three model calls contributes three stamps in order.
            """
            run_id = str(entry.get("runId") or "").strip()
            if not run_id:
                return
            with self._thinking_lock:
                if entry.get("textOriginStamped"):
                    return
                entry["textOriginStamped"] = True
                stamps = self._stream_text_origin_by_run.setdefault(run_id, [])
                stamps.append(self._now_ms())
                if len(stamps) > NARRATION_ORIGIN_MEMORY:
                    del stamps[:-NARRATION_ORIGIN_MEMORY]

        def _take_text_stream_origin(self, run_id: Any) -> Optional[int]:
            """Claim the oldest unclaimed model-call origin stamp for a run.

            FIFO because interim messages are produced in the same order as
            the model calls that wrote them. A stamp that no narration ever
            claims is dropped with the run.
            """
            key = str(run_id or "").strip()
            if not key:
                return None
            with self._thinking_lock:
                stamps = self._stream_text_origin_by_run.get(key)
                if not stamps:
                    return None
                return stamps.pop(0)

        def _note_narration_text(self, run_id: Any, text: Any) -> bool:
            """Record a narration sentence. False when already known.

            The first carrier of a sentence also fixes its ORIGIN time, so
            every later carrier of the same sentence (commit, retag) reports
            the identical stamp.
            """
            key = str(run_id or "").strip()
            normalized = self._normalize_narration_text(text)
            if not key or not normalized:
                return False
            # One lock span (it is an RLock, so the nested claim below is
            # fine): two carriers of the SAME sentence racing must not claim
            # two different origin stamps.
            with self._thinking_lock:
                known = self._narration_texts_by_run.setdefault(key, set())
                if normalized in known:
                    return False
                known.add(normalized)
                raws = self._narration_raw_by_run.setdefault(key, {})
                raws[normalized] = str(text)
                if len(raws) > NARRATION_ORIGIN_MEMORY:
                    for stale in list(raws)[: len(raws) - NARRATION_ORIGIN_MEMORY]:
                        raws.pop(stale, None)
                origin = self._take_text_stream_origin(key)
                if origin is None:
                    # No stream hooks on this host (or a model call that
                    # produced no content delta): the honest fallback is NOW —
                    # the moment the sentence reached the adapter, which is the
                    # moment it was painted as streaming text, not the lazy
                    # commit.
                    origin = self._now_ms()
                origins = self._narration_origin_by_run.setdefault(key, {})
                origins[normalized] = origin
                if len(origins) > NARRATION_ORIGIN_MEMORY:
                    for stale in list(origins)[: len(origins) - NARRATION_ORIGIN_MEMORY]:
                        origins.pop(stale, None)
            return True

        def _narration_origin_ms(self, run_id: Any, text: Any) -> Optional[int]:
            """The origin stamp of a known narration sentence, or None."""
            key = str(run_id or "").strip()
            normalized = self._normalize_narration_text(text)
            if not key or not normalized:
                return None
            with self._thinking_lock:
                return self._narration_origin_by_run.get(key, {}).get(normalized)

        def _is_narration_text(self, run_id: Any, text: Any) -> bool:
            key = str(run_id or "").strip()
            normalized = self._normalize_narration_text(text)
            if not key or not normalized:
                return False
            with self._thinking_lock:
                return normalized in self._narration_texts_by_run.get(key, ())

        def _note_committed_text(
            self, run_id: Any, text: Any, message_id: Any = None
        ) -> None:
            key = str(run_id or "").strip()
            normalized = self._normalize_narration_text(text)
            if not key or not normalized:
                return
            with self._thinking_lock:
                seen = self._committed_texts_by_run.setdefault(key, [])
                seen.append(normalized)
                if len(seen) > NARRATION_COMMIT_MEMORY:
                    del seen[:-NARRATION_COMMIT_MEMORY]
                ids = self._committed_ids_by_run.setdefault(key, {})
                if message_id:
                    # LAST writer wins: a text can be committed twice within a
                    # run (a flush of the open message, then the run-end tail
                    # re-committing the same words) and the retag has to name
                    # the commit the consumer is actually holding.
                    ids[normalized] = str(message_id)
                retained = set(seen)
                for stale in [k for k in ids if k not in retained]:
                    del ids[stale]

        def _committed_message_id(self, run_id: Any, text: Any) -> Optional[str]:
            """The message id of the commit a retag is correcting.

            Exact text first, then the mid-reveal prefix case: when the commit
            beat the interim hook it landed the prefix visible at that
            instant, so the sentence the retag carries is not what was
            committed — the longest committed prefix of it is. Mirrors
            `_committed_prefix_of`'s reading, and returns None when nothing
            was committed with an id (a pre-#1691 commit path), which leaves
            the consumer on its text match.
            """
            key = str(run_id or "").strip()
            normalized = self._normalize_narration_text(text)
            if not key or not normalized:
                return None
            with self._thinking_lock:
                ids = dict(self._committed_ids_by_run.get(key, {}))
            exact = ids.get(normalized)
            if exact:
                return exact
            best: Optional[str] = None
            best_len = -1
            for committed, message_id in ids.items():
                if committed == normalized or not normalized.startswith(committed):
                    continue
                if len(committed) > best_len:
                    best_len = len(committed)
                    best = message_id
            return best

        def _text_was_committed(self, run_id: Any, text: Any) -> bool:
            key = str(run_id or "").strip()
            normalized = self._normalize_narration_text(text)
            if not key or not normalized:
                return False
            with self._thinking_lock:
                return normalized in self._committed_texts_by_run.get(key, ())

        def _narration_full_text_for_prefix(self, run_id: Any, text: Any) -> Optional[str]:
            """The finished sentence a mid-reveal commit is a prefix OF.

            Hermes reveals an assistant message to the platform at reading
            speed, and a fresh send() flushes the previous still-open message.
            A note flushed mid-reveal therefore commits the prefix visible at
            that instant (`I'm about t`), and nothing downstream ever replaces
            it. The interim hook already knows the whole sentence, so the
            commit is upgraded to it here — the one choke point every
            correlated commit passes through (#1619 residual).

            Shortest candidate wins: with two narration sentences sharing a
            prefix the nearer one is the honest reading. An exact match is not
            a prefix hit and returns None.
            """
            key = str(run_id or "").strip()
            normalized = self._normalize_narration_text(text)
            if not key or not normalized:
                return None
            with self._thinking_lock:
                raws = dict(self._narration_raw_by_run.get(key, {}))
            best: Optional[str] = None
            best_key: Optional[str] = None
            for candidate, raw in raws.items():
                if candidate == normalized:
                    return None
                if not candidate.startswith(normalized):
                    continue
                if best_key is None or len(candidate) < len(best_key):
                    best_key = candidate
                    best = raw
            return best

        def _committed_prefix_of(self, run_id: Any, text: Any) -> bool:
            """True when a COMMITTED text is a strict prefix of ``text``.

            The hook's normal test is "was this exact sentence committed?".
            When the commit beat the hook AND landed mid-reveal, the page is
            holding a prefix instead, so the retag (which carries the finished
            sentence) still has to be emitted — it is the only carrier that
            can upgrade the page.
            """
            key = str(run_id or "").strip()
            normalized = self._normalize_narration_text(text)
            if not key or not normalized:
                return False
            with self._thinking_lock:
                seen = list(self._committed_texts_by_run.get(key, ()))
            return any(
                committed and committed != normalized and normalized.startswith(committed)
                for committed in seen
            )

        def _commit_message_kind(
            self,
            record: Any,
            text: Any,
            message_id: Any = None,
        ) -> Optional[str]:
            """`messageKind` for a commit that is about to be emitted."""
            if self._is_narration_text(getattr(record, "run_id", None), text):
                return MESSAGE_KIND_NARRATION
            key = str(getattr(record, "run_id", None) or "").strip()
            resolved_id = str(message_id or "").strip()
            if key and resolved_id:
                with self._thinking_lock:
                    if resolved_id in self._tool_progress_message_ids_by_run.get(key, ()):
                        return MESSAGE_KIND_TOOL_PROGRESS
            return None

        def _expect_tool_progress_send(self, record: Any, tool_call_id: Any) -> None:
            key = str(getattr(record, "run_id", None) or "").strip()
            call_id = str(tool_call_id or "").strip()
            if not key or not call_id:
                return
            with self._thinking_lock:
                pending = self._pending_tool_progress_by_run.setdefault(key, [])
                if call_id not in pending:
                    pending.append(call_id)

        def _tool_progress_enabled_for_record(self, record: Any) -> bool:
            """Mirror Hermes' per-platform gate before arming the next send."""
            identity = parse_ocuclaw_session_key(
                str(getattr(record, "public_key", None) or "")
            )
            ns = str((identity or {}).get("ns") or self._namespace)
            home = self._profile_home_for_options(ns)
            if home is None:
                return False
            try:
                return bool(
                    self._read_profile_options_sync(home).get(
                        "conversationToolProgress"
                    )
                )
            except Exception:  # noqa: BLE001 - a display hint cannot block tools
                logger.debug("[ocuclaw] tool-progress config read failed", exc_info=True)
                return False

        def _claim_tool_progress_send(self, record: Any, message_id: Any) -> None:
            key = str(getattr(record, "run_id", None) or "").strip()
            resolved_id = str(message_id or "").strip()
            if not key or not resolved_id:
                return
            with self._thinking_lock:
                pending = self._pending_tool_progress_by_run.get(key)
                if not pending:
                    return
                pending.pop(0)
                if not pending:
                    self._pending_tool_progress_by_run.pop(key, None)
                self._tool_progress_message_ids_by_run.setdefault(key, set()).add(
                    resolved_id
                )

        def _emit_message_commit(
            self,
            record: Any,
            text: str,
            *,
            turn_active: bool = False,
            origin_at_ms: Optional[int] = None,
            message_id: Optional[str] = None,
        ) -> None:
            """The single place a correlated assistant commit leaves the
            adapter, so tagging, identity and commit memory can never drift
            apart.

            ``message_id`` defaults to the record's CURRENT message — the one
            every caller but the flush path is committing. The flush path
            (a fresh send arriving while a message is still open) commits the
            PREVIOUS message and passes `record.previous_message_id`, exactly
            as it already passes `previous_origin_ms` (#1691).
            """
            upgraded = self._narration_full_text_for_prefix(record.run_id, text)
            if upgraded is not None:
                # A note flushed mid-reveal: commit the sentence, not the
                # prefix that happened to be on the wire.
                text = upgraded
            if message_id is None:
                message_id = getattr(record, "current_message_id", None)
            self._note_committed_text(record.run_id, text, message_id)
            message_kind = self._commit_message_kind(record, text, message_id)
            if message_kind == MESSAGE_KIND_NARRATION:
                # Narration knows its true origin (first content delta of the
                # model call that wrote it), which beats the send stamp.
                origin = self._narration_origin_ms(record.run_id, text)
            elif origin_at_ms is not None:
                # A message the ledger FLUSHED because a new send opened:
                # its stamp is the flushed message's own send, not this one's.
                origin = origin_at_ms
            else:
                # Every commit carries WHERE IT WAS WRITTEN — the wall clock of
                # its own first send(). Hermes commits lazily (a flush, a
                # run-end tail), so commit order is not authorship order and
                # the tool-progress line otherwise lands after the tool OUTPUT
                # it introduces (#1619). A stamp equal to commit position moves
                # nothing; it only lets a later lazy commit sort against it.
                origin = getattr(record, "current_origin_ms", None)
            self._emit_event(
                "message",
                message_commit_event(
                    record,
                    text,
                    turn_active=turn_active,
                    message_kind=message_kind,
                    # Every commit carries where it was WRITTEN, because hermes
                    # flushes messages lazily: a tool-progress line commits
                    # after the tool output it introduces.
                    origin_at_ms=origin,
                    # …and WHICH MESSAGE it is, so the consumer can give the
                    # entry a server identity instead of a positional one
                    # (#1691).
                    message_id=message_id,
                ),
            )

        # -- tier-2 reasoning stream (on_stream_*, 0.20.5+, opt-in) ----------

        def _stream_turn_context(
            self, kwargs: Dict[str, Any]
        ) -> Optional[Dict[str, Any]]:
            """Cached identity + coalescer state for one reasoning stream.

            Stream hooks spell the platform ``surface``; the shared turn-context
            filter reads ``platform``, which they never pass, so its filter is
            vacuous here and this one is load-bearing.
            """
            if str(kwargs.get("surface") or "").strip() != PLATFORM_NAME:
                return None
            session_id = str(kwargs.get("session_id") or "").strip()
            if not session_id:
                return None
            stream_key = (session_id, str(kwargs.get("turn_id") or "").strip())
            try:
                iteration = int(kwargs.get("iteration") or 0)
            except (TypeError, ValueError):
                iteration = 0
            with self._thinking_lock:
                entry = self._stream_contexts.get(stream_key)
            if entry is not None:
                if iteration > entry["iteration"]:
                    # A new model call inside the same turn. Re-arm rather than
                    # trusting on_stream_end to have arrived: the hook queue
                    # drops OLDEST under load, and a lost end would otherwise
                    # fence out the rest of the turn's reasoning forever.
                    self._flush_stream_buffer(entry)
                    entry["iteration"] = iteration
                    entry["epoch"] = self._thinking_epoch(entry["runId"])
                    entry["lastFlush"] = time.monotonic()
                    # A new model call writes a new assistant message, so it
                    # gets its own origin stamp (#1619).
                    entry["textOriginStamped"] = False
                return entry
            context = self._turn_activity_context(kwargs, "stream hook")
            if context is None:
                return None
            _, record = context
            entry = {
                "key": stream_key,
                "runId": record.run_id,
                "sessionKey": record.public_key,
                "iteration": iteration,
                "epoch": self._thinking_epoch(record.run_id),
                "buffer": "",
                "lastFlush": time.monotonic(),
                "textOriginStamped": False,
            }
            with self._thinking_lock:
                self._stream_contexts[stream_key] = entry
            return entry

        def _forget_stream_context(self, entry: Dict[str, Any]) -> None:
            with self._thinking_lock:
                self._stream_contexts.pop(entry["key"], None)

        def _flush_stream_buffer(self, entry: Dict[str, Any]) -> bool:
            now = time.monotonic()
            with self._thinking_lock:
                chunk = entry["buffer"]
                if not chunk:
                    return False
                entry["buffer"] = ""
                entry["lastFlush"] = now
            run_id = entry["runId"]
            if self._thinking_epoch(run_id) != entry["epoch"]:
                # A post_api_request reconcile already set the authoritative
                # text for this call; this chunk is behind it.
                return False
            key = str(run_id or "").strip()
            with self._thinking_lock:
                previous = self._stream_appended_by_run.get(key)
                if previous is None:
                    # First chunk of a NEW model call. Deltas concatenate raw
                    # inside a call (they are token fragments), but two calls
                    # in one turn are two separate stretches of reasoning and
                    # would otherwise run together mid-word.
                    chunk = (
                        self._stream_join_separator(
                            self._thinking_text_by_run.get(key, "")
                        )
                        + chunk
                    )
                    previous = ""
                self._stream_appended_by_run[key] = previous + chunk
                self._open_pane_runs.add(key)
            self._emit_event(
                "thinking",
                {
                    "phase": "update",
                    "runId": run_id,
                    "sessionKey": entry["sessionKey"],
                    "text": self._extend_thinking_text(run_id, chunk),
                    "delta": chunk,
                    "seq": self._next_thinking_seq(run_id),
                    "source": THINKING_SOURCE_STREAM_DELTA,
                },
            )
            return True

        def _flush_pending_streams_for_run(self, run_id: Any) -> None:
            key = str(run_id or "").strip()
            with self._thinking_lock:
                pending = [
                    entry
                    for entry in self._stream_contexts.values()
                    if entry.get("runId") == key and entry.get("buffer")
                ]
            for entry in pending:
                self._flush_stream_buffer(entry)

        def handle_stream_start(self, kwargs: Dict[str, Any]) -> None:
            # Resolving identity here is the whole point: one SessionDB read
            # per stream instead of one per delta.
            self._stream_turn_context(kwargs)

        def handle_stream_delta(self, kwargs: Dict[str, Any]) -> None:
            # FIRST line: content deltas are already rendered by the streaming
            # transport, so forwarding them here would double-render the reply.
            kind = str(kwargs.get("kind") or "").strip()
            if kind != STREAM_DELTA_KIND_REASONING:
                # …but the FIRST of them is when the model started writing
                # this assistant message, which is the only honest origin time
                # for a progress note (#1619). Stamp it and forward nothing.
                if kind == STREAM_DELTA_KIND_TEXT and str(kwargs.get("delta") or ""):
                    entry = self._stream_turn_context(kwargs)
                    if entry is not None and not entry.get("textOriginStamped"):
                        self._note_text_stream_origin(entry)
                return
            delta = str(kwargs.get("delta") or "")
            if not delta:
                return
            entry = self._stream_turn_context(kwargs)
            if entry is None:
                return
            with self._thinking_lock:
                entry["buffer"] += delta
                buffer = entry["buffer"]
                elapsed = time.monotonic() - entry["lastFlush"]
            if (
                len(buffer) >= STREAM_FLUSH_CHARS
                or STREAM_PARAGRAPH_BREAK in buffer
                or elapsed >= STREAM_FLUSH_INTERVAL_S
            ):
                self._flush_stream_buffer(entry)

        def handle_stream_end(self, kwargs: Dict[str, Any]) -> None:
            entry = self._stream_turn_context(kwargs)
            if entry is None:
                return
            # The tail always flushes here — the hook worker has no timer, so
            # without this the last chunk would wait for a delta that will
            # never come.
            self._flush_stream_buffer(entry)
            self._forget_stream_context(entry)
            # Nothing painted for this call means no pane to close, and a
            # finalize with nothing open would only fence out later updates.
            self._finalize_thinking_pane(entry["runId"], entry["sessionKey"])

        def handle_interim_message(self, kwargs: Dict[str, Any]) -> None:
            """`on_interim_message`: the agent's own mid-turn narration."""
            # Stream hooks spell the platform `surface`, NOT `platform`, so
            # _turn_activity_context's own filter is vacuous here — an
            # unfiltered pass would route another surface's narration onto the
            # glasses.
            if str(kwargs.get("surface") or "").strip() != PLATFORM_NAME:
                return
            text = str(kwargs.get("text") or "").strip()
            if not text:
                return
            context = self._turn_activity_context(kwargs, "on_interim_message hook")
            if context is None:
                return
            _, record = context
            self._note_narration_text(record.run_id, text)
            if self._text_was_committed(
                record.run_id, text
            ) or self._committed_prefix_of(record.run_id, text):
                # The commit beat the hook: the page already went downstream
                # untagged. The retag names that commit by its message id
                # (#1691) and carries the text as the fallback match — the
                # mid-reveal prefix upgrade is a text operation either way.
                # It rides the EXISTING `message` event with `retag:true`
                # rather than a new event name: the child's BRIDGE_EVENTS list
                # is frozen, and a retag is a correction to a message, not a
                # new lane.
                self._emit_event(
                    "message",
                    message_retag_event(
                        record,
                        text,
                        origin_at_ms=self._narration_origin_ms(record.run_id, text),
                        message_id=self._committed_message_id(record.run_id, text),
                    ),
                )
            # NO status-bar rung. #1619 retired `agentProgressNotes: status`:
            # with a real model the interim is committed AFTER the tool
            # activity frame, so the narration rung lost arbitration every
            # time and `status` was indistinguishable from `off` (zero
            # `origin:"narration"` frames across 12 real-model dumps). A note
            # now goes to the conversation — at its ORIGIN position — or
            # nowhere at all, so this hook's only remaining jobs are tagging
            # the sentence and correcting a commit that beat it.

        @staticmethod
        def _api_request_status_code(kwargs: Dict[str, Any]) -> Optional[int]:
            candidates = [
                kwargs.get("status_code"),
                kwargs.get("statusCode"),
                kwargs.get("http_status"),
                kwargs.get("httpStatus"),
            ]
            response = kwargs.get("response")
            if isinstance(response, dict):
                candidates.extend([response.get("status_code"), response.get("status")])
            else:
                candidates.extend(
                    [
                        getattr(response, "status_code", None),
                        getattr(response, "status", None),
                    ]
                )
            for raw in candidates:
                if isinstance(raw, bool):
                    continue
                if isinstance(raw, (int, float)):
                    return int(raw)
                if isinstance(raw, str):
                    text = raw.strip()
                    if text.isdigit():
                        return int(text)
            return None

        @staticmethod
        def _api_request_error_text(kwargs: Dict[str, Any]) -> str:
            parts: List[str] = []
            for key in (
                "error_type",
                "errorType",
                "error_message",
                "errorMessage",
                "message",
                "detail",
            ):
                value = kwargs.get(key)
                if isinstance(value, str) and value.strip():
                    parts.append(value.strip())
            for key in ("error", "exception", "exc"):
                value = kwargs.get(key)
                if isinstance(value, dict):
                    for nested_key in ("type", "code", "message", "detail"):
                        nested = value.get(nested_key)
                        if isinstance(nested, str) and nested.strip():
                            parts.append(nested.strip())
                elif value is not None:
                    text = str(value).strip()
                    if text:
                        parts.append(text)
            return " ".join(parts)

        @staticmethod
        def _api_request_has_error_value(value: Any) -> bool:
            if isinstance(value, dict):
                return any(
                    isinstance(value.get(key), str) and bool(value.get(key).strip())
                    for key in ("type", "code", "message", "detail")
                )
            if isinstance(value, str):
                return bool(value.strip())
            return bool(value)

        @staticmethod
        def _api_request_quota_exhausted(error_text: str) -> bool:
            lowered = error_text.lower()
            return "out of credits" in lowered or "credits.depleted" in lowered

        @classmethod
        def _api_request_retryable_status(cls, status_code: Optional[int], error_text: str) -> bool:
            if status_code is None or status_code < 400:
                return False
            if cls._api_request_quota_exhausted(error_text):
                return False
            return status_code in {408, 409, 425, 429} or status_code >= 500

        @classmethod
        def _api_request_terminal_status(cls, status_code: Optional[int], error_text: str) -> bool:
            if status_code is None or status_code < 400:
                return False
            if cls._api_request_quota_exhausted(error_text):
                return True
            return not cls._api_request_retryable_status(status_code, error_text)

        @classmethod
        def _api_request_error_code(cls, kwargs: Dict[str, Any]) -> Optional[str]:
            status = str(kwargs.get("status") or "").strip().lower()
            status_code = cls._api_request_status_code(kwargs)
            error_text = cls._api_request_error_text(kwargs)
            explicit_error = any(
                isinstance(kwargs.get(key), str) and str(kwargs.get(key)).strip()
                for key in ("error_type", "errorType", "error_message", "errorMessage")
            ) or any(cls._api_request_has_error_value(kwargs.get(key)) for key in ("error", "exception", "exc"))
            retryable_status = cls._api_request_retryable_status(status_code, error_text)
            has_error = (
                cls._api_request_terminal_status(status_code, error_text)
                or (
                    not retryable_status
                    and (
                        status in {"error", "failed", "failure", "blocked", "exception"}
                        or explicit_error
                    )
                )
            )
            if not has_error:
                return None
            if cls._api_request_quota_exhausted(error_text):
                return "provider_quota_exhausted"
            return "provider_error"

        def handle_post_api_request(self, kwargs: Dict[str, Any]) -> None:
            context = self._turn_activity_context(kwargs, "post_api_request hook")
            if context is None:
                return
            session_key, record = context
            error_code = self._api_request_error_code(kwargs)
            if error_code:
                marked = self._ledger.mark_error_terminal(
                    session_key,
                    code=error_code,
                    stale_after_seconds=ERROR_TERMINAL_STALE_TURN_SECONDS,
                )
                if marked is not None:
                    self._schedule_error_terminal_sweep(ERROR_TERMINAL_STALE_TURN_SECONDS)
            assistant_message = kwargs.get("assistant_message")
            reasoning = self._extract_assistant_reasoning(assistant_message)
            if not reasoning:
                return
            headline, source = self._derive_thinking_headline(
                assistant_message,
                reasoning,
                kwargs.get("provider"),
                kwargs.get("model"),
            )
            # RECONCILE. post_api_request is authoritative for this model
            # call: it runs inline on the agent thread with the complete
            # reasoning, while coalesced deltas may still be queued. Bumping
            # the epoch fences those out, and a streamed run REPLACES its
            # buffer instead of appending, so the run never double-emits the
            # same reasoning once as deltas and again as a snapshot.
            # A lost on_stream_end would otherwise strand the tail forever:
            # the hook worker has no timer, so nothing else would ever flush
            # it. Flush BEFORE bumping the epoch, or the flush fences itself.
            self._flush_pending_streams_for_run(record.run_id)
            self._bump_thinking_epoch(record.run_id)
            text = self._reconcile_thinking_text(record.run_id, reasoning)
            # FRAME SPLIT (plan D1). The status-bar frame carries a HEADLINE or
            # nothing at all: when the source is `detail` it must carry neither
            # `summary` nor any THINKING_DETAIL_KEYS member, because the Node
            # resolver honours an explicit source and would otherwise select
            # the whole reasoning blob verbatim and paint a 120-char prose slab
            # at summary rank. With no key at all the resolver falls through to
            # the generic "Thinking..." label. The BODY rides the thinking
            # frame exclusively.
            activity = {
                "state": "thinking",
                "origin": "thinking",
                "category": "thinking",
                "phase": "update",
                "runId": record.run_id,
                "sessionKey": record.public_key,
                "thinkingSummarySource": source,
            }
            if headline:
                activity["summary"] = headline
            thinking = {
                "phase": "update",
                "runId": record.run_id,
                "sessionKey": record.public_key,
                "text": text,
                "delta": reasoning,
                "seq": self._next_thinking_seq(record.run_id),
                "thinkingSummarySource": source,
                "source": THINKING_SOURCE_POST_API_REQUEST,
            }
            self._emit_event("activity", activity)
            self._emit_event("thinking", thinking)
            # If the pane was live for this call, close it: what comes next
            # is the answer, not more reasoning. No-op when on_stream_end
            # already closed it, and when nothing streamed at all.
            self._finalize_thinking_pane(record.run_id, record.public_key)

        def _tool_activity_common(
            self,
            kwargs: Dict[str, Any],
            tool_name: str,
            record: Any,
            *,
            tool_phase: str,
        ) -> Dict[str, Any]:
            # `toolPhase` is the LIVENESS edge and is deliberately separate
            # from `phase`: the client's between-tools gate needs to know that
            # a running tool finished, while `phase` keeps its existing
            # start/update/error meaning (flipping it to "end" would move
            # terminal-activity-boundary semantics in the Node runtime).
            payload: Dict[str, Any] = {
                "state": "thinking",
                "origin": "tool",
                "phase": "start",
                "toolPhase": tool_phase,
                "tool": tool_name,
                "runId": record.run_id,
                "sessionKey": record.public_key,
            }
            tool_call_id = str(kwargs.get("tool_call_id") or "").strip()
            if tool_call_id:
                payload["activityId"] = tool_call_id
                payload["toolCallId"] = tool_call_id
            turn_id = str(kwargs.get("turn_id") or "").strip()
            if turn_id:
                payload["turnId"] = turn_id
            return payload

        @staticmethod
        def _tool_error_code(error_type: str, error_message: str) -> Tuple[str, Optional[str]]:
            normalized_type = error_type.strip().lower()
            normalized_message = error_message.strip().lower()
            if (
                normalized_type in {"credits.depleted", "credits_depleted"}
                or (
                    not normalized_type
                    and (
                        normalized_message == "out of credits"
                        or normalized_message.startswith("out of credits:")
                        or normalized_message.startswith("credits.depleted")
                    )
                )
            ):
                return "provider_quota_exhausted", "Out of credits"
            code = error_type.strip() or "tool_error"
            safe = "".join(ch.lower() if ch.isalnum() else "_" for ch in code)
            while "__" in safe:
                safe = safe.replace("__", "_")
            safe = safe.strip("_") or "tool_error"
            return safe, None

        def _sanitize_tool_activity_args(self, args: Dict[str, Any]) -> Dict[str, Any]:
            sanitized: Dict[str, Any] = {}
            for index, (key, value) in enumerate(args.items()):
                if index >= TOOL_ACTIVITY_MAX_ARG_KEYS:
                    sanitized["_truncated"] = True
                    break
                clean_key = str(key or "").strip()
                if not clean_key:
                    continue
                sanitized[clean_key] = self._sanitize_tool_activity_arg_value(
                    clean_key,
                    value,
                    0,
                )
                if self._tool_activity_args_json_bytes(sanitized) > TOOL_ACTIVITY_MAX_ARGS_JSON_BYTES:
                    sanitized[clean_key] = "[omitted]"
                    sanitized["_truncated"] = True
                    if self._tool_activity_args_json_bytes(sanitized) > TOOL_ACTIVITY_MAX_ARGS_JSON_BYTES:
                        sanitized.pop(clean_key, None)
                        sanitized["_truncated"] = True
                        if self._tool_activity_args_json_bytes(sanitized) > TOOL_ACTIVITY_MAX_ARGS_JSON_BYTES:
                            return {"_truncated": True}
            return sanitized

        @staticmethod
        def _tool_activity_args_json_bytes(args: Dict[str, Any]) -> int:
            try:
                encoded = json.dumps(
                    args,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            except Exception:  # noqa: BLE001
                return TOOL_ACTIVITY_MAX_ARGS_JSON_BYTES + 1
            return len(encoded)

        def _sanitize_tool_activity_text(self, value: str) -> str:
            redacted = self._redact_native_approval_command(value)
            redacted = redact_urls_in_text(redacted)
            if len(redacted) > TOOL_ACTIVITY_MAX_ARG_STRING:
                return redacted[:TOOL_ACTIVITY_MAX_ARG_STRING] + "...[truncated]"
            return redacted

        def _sanitize_tool_activity_arg_value(
            self,
            key: str,
            value: Any,
            depth: int,
        ) -> Any:
            key_token = key.strip().lower()
            allowed_key = key_token.replace("-", "_")
            marker_key = "".join(ch for ch in key_token if ch.isalnum())
            if (
                allowed_key not in TOOL_ACTIVITY_ALLOWED_ARG_KEYS
                or key_token in TOOL_ACTIVITY_OMITTED_ARG_KEYS
                or any(
                    marker in marker_key
                    for marker in TOOL_ACTIVITY_SECRET_ARG_KEY_MARKERS
                )
            ):
                return "[omitted]"
            if value is None or isinstance(value, (bool, int, float)):
                return value
            if isinstance(value, str):
                return self._sanitize_tool_activity_text(value)
            if depth >= TOOL_ACTIVITY_MAX_ARG_DEPTH:
                return "[omitted]"
            if isinstance(value, dict):
                result: Dict[str, Any] = {}
                for index, (child_key, child_value) in enumerate(value.items()):
                    if index >= TOOL_ACTIVITY_MAX_ARG_KEYS:
                        result["_truncated"] = True
                        break
                    clean_child_key = str(child_key or "").strip()
                    if not clean_child_key:
                        continue
                    result[clean_child_key] = self._sanitize_tool_activity_arg_value(
                        clean_child_key,
                        child_value,
                        depth + 1,
                    )
                return result
            if isinstance(value, (list, tuple)):
                result = [
                    self._sanitize_tool_activity_arg_value(key, item, depth + 1)
                    for item in list(value)[:TOOL_ACTIVITY_MAX_ARG_ITEMS]
                ]
                if len(value) > TOOL_ACTIVITY_MAX_ARG_ITEMS:
                    result.append("[truncated]")
                return result
            return str(type(value).__name__)

        # -- tier 0 in-flight signal (T2 #2510) ----------------------------

        def _inflight_mark(self, kwargs: Dict[str, Any]) -> None:
            """pre_llm_call for ANY platform: the session is in flight here.
            Background forks share the parent's session_id (they carry
            parent_session_id) — never let a fork mark or clear the parent."""
            session_id = str((kwargs or {}).get("session_id") or "").strip()
            if not session_id or str((kwargs or {}).get("parent_session_id") or "").strip():
                return
            with self._inflight_lock:
                self._inflight[session_id] = {
                    "at": time.monotonic(),
                    "platform": str((kwargs or {}).get("platform") or ""),
                }

        def _inflight_touch(self, kwargs: Dict[str, Any]) -> None:
            """Tool hooks refresh the stamp so a long tool run inside a turn
            never outlives the TTL on its own."""
            session_id = str((kwargs or {}).get("session_id") or "").strip()
            if not session_id:
                return
            with self._inflight_lock:
                entry = self._inflight.get(session_id)
                if entry is not None:
                    entry["at"] = time.monotonic()

        def _inflight_clear(self, kwargs: Dict[str, Any]) -> None:
            """on_session_end for ANY platform (= the durable lease release
            for a turn that reached finalize). Fork ends are ignored."""
            session_id = str((kwargs or {}).get("session_id") or "").strip()
            if not session_id or self._background_hook_turn(kwargs):
                return
            with self._inflight_lock:
                self._inflight.pop(session_id, None)

        def inflight_snapshot(self) -> Dict[str, Dict[str, Any]]:
            """Live (non-expired) in-flight sessions; expired marks are
            dropped on read — the fail-safe for ends that never fire."""
            now = time.monotonic()
            with self._inflight_lock:
                expired = [
                    key
                    for key, entry in self._inflight.items()
                    if now - float(entry.get("at") or 0.0) > INFLIGHT_TTL_S
                ]
                for key in expired:
                    self._inflight.pop(key, None)
                return {
                    key: {"platform": entry.get("platform") or "", "ageS": now - float(entry.get("at") or now)}
                    for key, entry in self._inflight.items()
                }

        def inflight_platform(self, lineage: List[str]) -> Optional[str]:
            """The platform running a turn on any lineage id right now, or
            None. Empty string means "in flight, platform unknown"."""
            live = self.inflight_snapshot()
            for session_id in lineage or []:
                entry = live.get(str(session_id))
                if entry is not None:
                    return str(entry.get("platform") or "")
            return None

        def handle_pre_tool_call(self, kwargs: Dict[str, Any]) -> None:
            self._inflight_touch(kwargs)
            context = self._tool_activity_context(kwargs)
            if context is None:
                return
            _, tool_name, record = context
            if (
                tool_name != "clarify"
                and self._tool_progress_enabled_for_record(record)
            ):
                self._expect_tool_progress_send(record, kwargs.get("tool_call_id"))
            payload = self._tool_activity_common(
                kwargs, tool_name, record, tool_phase="start"
            )
            args = kwargs.get("args")
            if isinstance(args, dict):
                payload["args"] = self._sanitize_tool_activity_args(args)
                if tool_name == "render_glasses_ui":
                    # Preserve only bounded existing routing facts, never the
                    # interface body/items. Unknown or omitted values fail closed
                    # in the shared activity adapter.
                    routing_valid = (
                        ("validateOnly" not in args or isinstance(args["validateOnly"], bool))
                        and ("update" not in args or args["update"] in ("patch", "replace", "push"))
                    )
                    if routing_valid and args.get("kind") in (
                        "text_surface", "list_surface", "list_with_details_surface",
                        "checklist_surface", "paged_text_surface",
                    ):
                        payload["args"]["kind"] = args["kind"]
                    if isinstance(args.get("validateOnly"), bool):
                        payload["args"]["validateOnly"] = args["validateOnly"]
                    if args.get("update") in ("patch", "replace", "push"):
                        payload["args"]["update"] = args["update"]
                    if self._tool_activity_args_json_bytes(payload["args"]) > TOOL_ACTIVITY_MAX_ARGS_JSON_BYTES:
                        payload["args"] = {
                            key: payload["args"][key]
                            for key in ("kind", "validateOnly", "update")
                            if key in payload["args"]
                        }
                        payload["args"]["_truncated"] = True
            self._emit_event("activity", payload)

        def handle_post_tool_call(self, kwargs: Dict[str, Any]) -> None:
            self._inflight_touch(kwargs)
            context = self._tool_activity_context(kwargs)
            if context is None:
                return
            _, tool_name, record = context
            payload = self._tool_activity_common(
                kwargs, tool_name, record, tool_phase="end"
            )
            payload["phase"] = "update"

            status = str(kwargs.get("status") or "").strip().lower()
            error_type = str(kwargs.get("error_type") or "").strip()
            error_message = str(kwargs.get("error_message") or "").strip()
            is_error = status in {"error", "blocked"} or bool(error_type)
            if is_error:
                code, label = self._tool_error_code(error_type, error_message)
                if code == "provider_quota_exhausted":
                    payload["state"] = "idle"
                    payload["phase"] = "error"
                payload.update(
                    {
                        "isError": True,
                        "code": code,
                    }
                )
                if label:
                    payload["label"] = label
                if error_message:
                    payload["detail"] = self._sanitize_tool_activity_text(error_message)
            duration_ms = kwargs.get("duration_ms")
            if isinstance(duration_ms, (int, float)) and duration_ms >= 0:
                payload["durationMs"] = int(duration_ms)
            self._emit_event("activity", payload)

        async def handle_approval_resolve(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            approval_id = str(p.get("id") or "").strip()
            decision = str(p.get("decision") or "").strip().lower()
            reason_value = p.get("reason")
            reason = (
                str(reason_value).strip()[:500]
                if isinstance(reason_value, str) and reason_value.strip()
                else None
            )
            if not approval_id:
                raise ValueError("approval.resolve requires id")
            if not decision:
                raise ValueError("approval.resolve requires decision")
            with self._approval_lock:
                entry = self._approvals_by_id.get(approval_id)
            if entry is None:
                return {"status": "ignored", "reason": "approval not pending"}
            async with self._approval_resolve_lock(entry["sessionKey"]):
                with self._approval_lock:
                    entry = self._approvals_by_id.get(approval_id)
                if entry is None:
                    return {"status": "ignored", "reason": "approval not pending"}
                if not self._approval_is_session_head(entry):
                    return {"status": "ignored", "reason": "approval is not at queue head"}
                allowed_decisions = entry.get("allowedDecisions")
                if not isinstance(allowed_decisions, list) or decision not in allowed_decisions:
                    raise ValueError(
                        f"approval decision {decision!r} is not allowed for this approval"
                    )
                native_choice, public_decision = self._native_approval_choice(
                    decision,
                    entry,
                )
                with self._approval_lock:
                    drain_generation = self._approval_drain_generation.get(
                        entry["sessionKey"],
                        0,
                    )
                entry = self._pop_approval_entry(approval_id)
                if entry is None:
                    return {"status": "ignored", "reason": "approval not pending"}
                try:
                    self._suppress_native_approval_response(entry, native_choice)
                    resolved = await asyncio.to_thread(
                        self._resolve_native_approval_entry,
                        entry,
                        native_choice,
                        reason,
                    )
                    if resolved <= 0:
                        self._unsuppress_native_approval_response(
                            entry["sessionKey"],
                            native_choice,
                            entry=entry,
                        )
                except Exception:
                    self._unsuppress_native_approval_response(
                        entry["sessionKey"],
                        native_choice,
                        entry=entry,
                    )
                    if not self._restore_approval_entry(entry, drain_generation):
                        self._forget_mirrored_native_entry(entry)
                        self._emit_approval_resolved(entry, "deny")
                    raise
            if resolved <= 0:
                native_decision = self._consume_native_resolution_tombstone(entry)
                if native_decision is not None:
                    self._forget_mirrored_native_entry(entry)
                    self._emit_approval_resolved(entry, native_decision)
                    return {
                        "status": "ignored",
                        "reason": "approval resolved elsewhere",
                    }
                if not self._restore_approval_entry(entry, drain_generation):
                    self._forget_mirrored_native_entry(entry)
                    self._emit_approval_resolved(entry, "deny")
                    return {"status": "ignored", "reason": "approval not pending"}
                return {
                    "status": "ignored",
                    "reason": "approval native queue mismatch",
                }
            self._forget_mirrored_native_entry(entry)
            self._emit_approval_resolved(entry, public_decision)
            result: Dict[str, Any] = {"status": "accepted", "resolved": resolved}
            if decision == "allow-always":
                # No entry allows this through authz; keep as defense-in-depth.
                result["warning"] = "allow-always is phone-only"
            return result

        async def handle_clarify_resolve(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            clarify_id = str(p.get("id") or "").strip()
            response = str(p.get("response") or "").strip()
            if not clarify_id:
                raise ValueError("clarify.resolve requires id")
            if not response:
                raise ValueError("clarify.resolve requires response")
            from tools.clarify_gateway import resolve_gateway_clarify

            resolved = bool(resolve_gateway_clarify(clarify_id, response))
            if not resolved:
                return {"status": "ignored", "reason": "clarify not pending"}
            return {"status": "accepted"}

        async def handle_clarify_await_text(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            clarify_id = str(p.get("id") or "").strip()
            if not clarify_id:
                raise ValueError("clarify.await_text requires id")
            from tools.clarify_gateway import mark_awaiting_text

            if not mark_awaiting_text(clarify_id):
                return {"status": "ignored", "reason": "clarify not pending"}
            return {"status": "accepted"}

        async def handle_sessions_abort(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            ns, chat_id, error = self._target_chat(p)
            if error:
                return {"status": "rejected", "error": error}
            session_key = self._session_key_for_chat(chat_id, ns=ns)
            was_busy = self._ledger.is_busy(session_key)
            await self._close_session_records(session_key, code="cancelled")
            await self.interrupt_session_activity(session_key, chat_id)
            return {"status": "accepted", "aborted": bool(was_busy)}

        async def handle_sessions_steer(self, params: Any) -> Dict[str, Any]:
            return await self.handle_dispatch(params)

        async def handle_sessions_options_apply(self, params: Any) -> Dict[str, Any]:
            """Apply silent host-selected options to this adapter's session."""
            p = params if isinstance(params, dict) else {}
            ns, chat_id, error = self._target_chat(p)
            if error:
                return {"status": "rejected", "error": error}
            options = p.get("options")
            if not isinstance(options, dict):
                return {
                    "status": "rejected",
                    "error": "options must be an object",
                }
            runner = getattr(self, "gateway_runner", None)
            apply_options = getattr(runner, "apply_session_options", None)
            if not callable(apply_options):
                return {
                    "status": "unsupported",
                    "error": (
                        "Hermes runtime does not expose structured session options"
                    ),
                }
            event = self._build_message_event(
                chat_id,
                "",
                profile=profile_for_namespace(ns),
            )
            try:
                result = await apply_options(event.source, dict(options))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[ocuclaw] structured session options failed: %s", exc
                )
                return {"status": "rejected", "error": str(exc)}
            return result if isinstance(result, dict) else {
                "status": "rejected",
                "error": "Hermes returned an invalid session-options result",
            }

        def _profile_home_for_options(self, ns: str) -> Optional[Path]:
            if self._multiplex_enabled:
                routed = self._served_profile_homes.get(ns)
                if routed is not None:
                    return Path(routed)
            return _hermes_home()

        def _read_profile_options_sync(self, home: Path) -> Dict[str, Any]:
            from gateway.run import _load_gateway_config, _profile_runtime_scope

            with _profile_runtime_scope(home):
                cfg = _load_gateway_config(config_path=home / "config.yaml")
            model_cfg = cfg.get("model") if isinstance(cfg, dict) else None
            if isinstance(model_cfg, str):
                model = model_cfg.strip()
                provider = ""
            elif isinstance(model_cfg, dict):
                model = str(
                    model_cfg.get("default") or model_cfg.get("model") or ""
                ).strip()
                provider = str(model_cfg.get("provider") or "").strip()
            else:
                model = ""
                provider = ""
            agent_cfg = cfg.get("agent") if isinstance(cfg, dict) else None
            agent_cfg = agent_cfg if isinstance(agent_cfg, dict) else {}
            reasoning = agent_cfg.get("reasoning_effort")
            if reasoning is False or str(reasoning or "").strip().lower() in {
                "none",
                "false",
                "disabled",
            }:
                thinking = "off"
            else:
                thinking = str(reasoning or "").strip().lower()
            service_tier = str(agent_cfg.get("service_tier") or "").strip().lower()
            # Hermes resolves the tool-progress level per turn off an
            # mtime-keyed config cache (gateway/run.py `_load_gateway_config` +
            # `resolve_display_setting`), so echo the RESOLVED level rather
            # than the raw key — defaults and legacy overrides both feed it.
            try:
                from gateway.display_config import resolve_display_setting

                tool_progress = str(
                    resolve_display_setting(cfg, PLATFORM_NAME, "tool_progress")
                    or "all"
                ).strip().lower()
            except Exception:
                tool_progress = "all"
            # Use Hermes' own precedence/default rules; reasoning_style changes
            # formatting only and must never be advertised as OcuClaw on.full.
            reasoning_options: Dict[str, str] = {}
            try:
                from gateway.display_config import resolve_display_setting
                import yaml

                # The native loader intentionally returns {} on read/parse
                # failure. Verify availability before treating its default as
                # observed state; still use its resolved, managed-overlay cfg.
                raw = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
                if raw is None or isinstance(raw, dict):
                    shown = resolve_display_setting(cfg, PLATFORM_NAME, "show_reasoning")
                    if isinstance(shown, bool):
                        reasoning_options["reasoningLevel"] = "on" if shown else "off"
            except Exception:
                pass  # Unavailable readback is not evidence that reasoning is off.
            return {
                "defaultModel": f"{provider}/{model}" if provider and model else model,
                "defaultThinking": thinking,
                "defaultFastMode": service_tier in {"fast", "priority"},
                "conversationToolProgress": tool_progress != "off",
                **reasoning_options,
            }

        def _apply_profile_options_sync(
            self,
            home: Path,
            options: Dict[str, Any],
        ) -> Dict[str, Any]:
            from gateway.run import _load_gateway_config, _profile_runtime_scope
            from hermes_cli.config import (
                atomic_config_write,
                get_compatible_custom_providers,
                read_user_config_raw,
            )
            from hermes_cli.model_selection_guards import combined_selection_warning
            from hermes_cli.model_switch import switch_model
            from hermes_cli.models import resolve_fast_mode_overrides
            from hermes_constants import parse_reasoning_effort

            allowed = {
                "model",
                "provider",
                "reasoning_effort",
                "fast",
                "confirm_model_selection",
                "tool_progress",
            }
            unknown = sorted(set(options) - allowed)
            if unknown:
                return {
                    "status": "rejected",
                    "error": f"unknown profile option(s): {', '.join(unknown)}",
                }

            config_path = home / "config.yaml"
            with _profile_runtime_scope(home):
                cfg = _load_gateway_config(config_path=config_path)
                model_cfg = cfg.get("model") if isinstance(cfg, dict) else None
                if isinstance(model_cfg, str):
                    current_model = model_cfg.strip()
                    current_provider = "openrouter"
                    current_base_url = ""
                elif isinstance(model_cfg, dict):
                    current_model = str(
                        model_cfg.get("default") or model_cfg.get("model") or ""
                    ).strip()
                    current_provider = str(
                        model_cfg.get("provider") or "openrouter"
                    ).strip()
                    current_base_url = str(model_cfg.get("base_url") or "").strip()
                else:
                    current_model = ""
                    current_provider = "openrouter"
                    current_base_url = ""

                switched = None
                if "model" in options or "provider" in options:
                    requested_model = str(options.get("model") or "").strip()
                    requested_provider = str(options.get("provider") or "").strip()
                    if not requested_model:
                        return {
                            "status": "rejected",
                            "error": "model is required for a Hermes profile default",
                        }
                    switched = switch_model(
                        raw_input=requested_model,
                        current_provider=current_provider,
                        current_model=current_model,
                        current_base_url=current_base_url,
                        is_global=True,
                        explicit_provider=requested_provider,
                        user_providers=cfg.get("providers") if isinstance(cfg, dict) else None,
                        custom_providers=get_compatible_custom_providers(cfg),
                    )
                    if not switched.success:
                        return {
                            "status": "rejected",
                            "error": switched.error_message or "model selection failed",
                        }
                    warning = combined_selection_warning(
                        switched.new_model,
                        provider=switched.target_provider,
                        base_url=switched.base_url,
                        api_key=switched.api_key,
                        model_info=switched.model_info,
                    )
                    if warning is not None and not bool(
                        options.get("confirm_model_selection")
                    ):
                        return {
                            "status": "confirmation_required",
                            "confirmationTitle": warning.title,
                            "confirmationMessage": warning.message,
                        }

                if "reasoning_effort" in options:
                    raw_reasoning = str(options.get("reasoning_effort") or "").strip().lower()
                    if raw_reasoning and parse_reasoning_effort(raw_reasoning) is None:
                        return {
                            "status": "rejected",
                            "error": f"unsupported reasoning effort: {raw_reasoning}",
                        }

                if "tool_progress" in options:
                    raw_tool_progress = str(options.get("tool_progress") or "").strip().lower()
                    if raw_tool_progress not in TOOL_PROGRESS_LEVELS:
                        return {
                            "status": "rejected",
                            "error": f"unsupported tool progress level: {raw_tool_progress}",
                        }

                effective_model = switched.new_model if switched is not None else current_model
                if options.get("fast") is True:
                    if not effective_model or resolve_fast_mode_overrides(effective_model) is None:
                        return {
                            "status": "rejected",
                            "error": "fast mode is not available for this model",
                        }

                raw_cfg = read_user_config_raw(config_path)
                if switched is not None:
                    raw_model_cfg = raw_cfg.get("model")
                    if isinstance(raw_model_cfg, str) and raw_model_cfg.strip():
                        raw_model_cfg = {"default": raw_model_cfg.strip()}
                    elif not isinstance(raw_model_cfg, dict):
                        raw_model_cfg = {}
                    raw_model_cfg["default"] = switched.new_model
                    raw_model_cfg["provider"] = switched.target_provider
                    raw_model_cfg.pop("context_length", None)
                    if switched.base_url:
                        raw_model_cfg["base_url"] = switched.base_url
                    elif switched.target_provider != "custom":
                        raw_model_cfg.pop("base_url", None)
                    if switched.target_provider == "custom" and switched.api_mode:
                        raw_model_cfg["api_mode"] = switched.api_mode
                    elif switched.target_provider != "custom":
                        raw_model_cfg.pop("api_mode", None)
                    raw_cfg["model"] = raw_model_cfg

                if "reasoning_effort" in options:
                    agent_cfg = raw_cfg.setdefault("agent", {})
                    if not isinstance(agent_cfg, dict):
                        agent_cfg = {}
                        raw_cfg["agent"] = agent_cfg
                    raw_reasoning = str(options.get("reasoning_effort") or "").strip().lower()
                    if raw_reasoning:
                        agent_cfg["reasoning_effort"] = raw_reasoning
                    else:
                        agent_cfg.pop("reasoning_effort", None)

                if "fast" in options:
                    agent_cfg = raw_cfg.setdefault("agent", {})
                    if not isinstance(agent_cfg, dict):
                        agent_cfg = {}
                        raw_cfg["agent"] = agent_cfg
                    agent_cfg["service_tier"] = (
                        "fast" if options.get("fast") is True else "normal"
                    )

                if "tool_progress" in options:
                    # Same shape hermes' own `/verbose` writes and
                    # `hermes config get display.platforms.ocuclaw.tool_progress`
                    # reads back. Hermes re-resolves this per turn off an
                    # mtime-keyed config cache (gateway/run.py
                    # `_load_gateway_config` + `resolve_display_setting`), so the
                    # change lands on the NEXT turn with no gateway restart, and
                    # never disturbs a turn already in flight.
                    display = raw_cfg.setdefault("display", {})
                    if not isinstance(display, dict):
                        display = {}
                        raw_cfg["display"] = display
                    platforms = display.setdefault("platforms", {})
                    if not isinstance(platforms, dict):
                        platforms = {}
                        display["platforms"] = platforms
                    platform_cfg = platforms.setdefault(PLATFORM_NAME, {})
                    if not isinstance(platform_cfg, dict):
                        platform_cfg = {}
                        platforms[PLATFORM_NAME] = platform_cfg
                    platform_cfg["tool_progress"] = (
                        str(options.get("tool_progress") or "").strip().lower()
                    )

                atomic_config_write(config_path, raw_cfg)

            return {
                "status": "accepted",
                **self._read_profile_options_sync(home),
            }

        async def handle_profile_options_get(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            ns = str(p.get("ns") or self._namespace)
            route_error = self._namespace_route_error(ns)
            if route_error is not None:
                return {"status": "rejected", "error": route_error}
            home = self._profile_home_for_options(ns)
            if home is None:
                return {"status": "rejected", "error": "Hermes profile home is unavailable"}
            return await asyncio.to_thread(self._read_profile_options_sync, home)

        async def handle_profile_options_apply(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            ns = str(p.get("ns") or self._namespace)
            route_error = self._namespace_route_error(ns)
            if route_error is not None:
                return {"status": "rejected", "error": route_error}
            options = p.get("options")
            if not isinstance(options, dict):
                return {"status": "rejected", "error": "options must be an object"}
            home = self._profile_home_for_options(ns)
            if home is None:
                return {"status": "rejected", "error": "Hermes profile home is unavailable"}
            lock = self._profile_options_locks.setdefault(ns, asyncio.Lock())
            async with lock:
                return await asyncio.to_thread(
                    self._apply_profile_options_sync,
                    home,
                    dict(options),
                )

        # -- W12 liveui tool/prompt glue --------------------------------------

        def _request_link_threadsafe(
            self,
            method: str,
            params: Any,
            *,
            timeout_s: float,
            abort_on_interrupt: Optional[Dict[str, Any]] = None,
        ) -> Any:
            link = self._link
            loop = self._loop
            if link is None or loop is None or loop.is_closed():
                raise RuntimeError("liveui control link is unavailable")
            future = asyncio.run_coroutine_threadsafe(
                link.request(method, params, timeout_s=timeout_s),
                loop,
            )
            deadline = time.monotonic() + max(float(timeout_s or 0), 0.1)

            def _send_abort() -> None:
                if not abort_on_interrupt:
                    return
                try:
                    asyncio.run_coroutine_threadsafe(
                        link.request(
                            abort_on_interrupt["method"],
                            abort_on_interrupt.get("params"),
                            timeout_s=5.0,
                        ),
                        loop,
                    )
                except Exception:  # noqa: BLE001
                    pass

            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    future.cancel()
                    _send_abort()
                    raise TimeoutError(f"{method} timed out after {timeout_s:.1f}s")
                try:
                    return future.result(timeout=min(0.1, remaining))
                except concurrent.futures.TimeoutError:
                    try:
                        from tools.interrupt import is_interrupted

                        interrupted = is_interrupted()
                    except Exception:  # noqa: BLE001
                        interrupted = False
                    if not interrupted:
                        continue
                    future.cancel()
                    _send_abort()
                    raise InterruptedError("liveui tool interrupted") from None

        def _handle_liveui_link_tool_call(
            self,
            args: Dict[str, Any],
            *,
            tool_name: str,
            method: str,
            call_id_prefix: str,
            render_request: Any,
        ) -> str:
            payload = args if isinstance(args, dict) else {}
            session_key = _current_hermes_session_key()
            welcome_call = tool_name == LIVEUI_TOOL_NAME and is_welcome_surface(payload)
            if not session_key:
                return json.dumps(
                    {"error": f"{tool_name} requires HERMES_SESSION_KEY"},
                    ensure_ascii=False,
                )
            identity = parse_ocuclaw_session_key(session_key)
            if identity is None and welcome_call:
                resumed_session_key = self._resolve_armed_first_run_session()
                if resumed_session_key:
                    session_key = resumed_session_key
                    identity = parse_ocuclaw_session_key(session_key)
            if identity is None:
                return json.dumps(
                    {
                        "error": (
                            f"{tool_name} requires an OcuClaw session"
                            if not welcome_call
                            else "Hermes welcome requires an armed phone-origin turn"
                        )
                    },
                    ensure_ascii=False,
                )

            def _proof_outcome(outcome: Any) -> Dict[str, Any]:
                return record_welcome_outcome(
                    outcome,
                    hermes_release=CERTIFIED_HERMES_TAG,
                    hermes_package_version=_hermes_version() or None,
                    ocuclaw_version=_ocuclaw_version(),
                    session_key=session_key,
                )
            call_id = f"{call_id_prefix}{uuid.uuid4().hex}"
            is_render = bool(render_request(payload))
            timeout_s = (
                _liveui_render_link_timeout_s(self._settings) if is_render else 10.0
            )
            abort_on_interrupt = None
            if is_render:
                abort_on_interrupt = {
                    "method": LIVEUI_ABORT_METHOD,
                    "params": {
                        "callId": call_id,
                        "sessionKey": session_key,
                        "reason": "interrupted",
                    },
                }
            try:
                result = self._request_link_threadsafe(
                    method,
                    {
                        "callId": call_id,
                        "sessionKey": session_key,
                        "args": payload,
                    },
                    timeout_s=timeout_s,
                    abort_on_interrupt=abort_on_interrupt,
                )
            except InterruptedError:
                failure = {"error": f"{tool_name} interrupted"}
                if welcome_call:
                    failure["firstRunProof"] = _proof_outcome("error")
                return json.dumps(failure)
            except Exception as exc:  # noqa: BLE001
                failure = {"error": str(exc)}
                if welcome_call:
                    failure["firstRunProof"] = _proof_outcome("error")
                return json.dumps(failure, ensure_ascii=False)
            if welcome_call:
                if isinstance(result, dict) and "result" in result:
                    outcome = result["result"]
                    rendered = (
                        dict(outcome)
                        if isinstance(outcome, dict)
                        else {"result": outcome}
                    )
                    outcome_name = rendered.get("result")
                elif isinstance(result, dict):
                    rendered = dict(result)
                    outcome_name = None
                else:
                    rendered = {"result": result}
                    outcome_name = result
                rendered["firstRunProof"] = _proof_outcome(outcome_name)
                return json.dumps(rendered, ensure_ascii=False)
            if isinstance(result, dict) and "result" in result:
                return json.dumps(result["result"], ensure_ascii=False)
            return json.dumps(
                result if isinstance(result, dict) else {"result": result},
                ensure_ascii=False,
            )

        def handle_liveui_tool_call(self, args: Dict[str, Any]) -> str:
            return self._handle_liveui_link_tool_call(
                args,
                tool_name=LIVEUI_TOOL_NAME,
                method=LIVEUI_RENDER_METHOD,
                call_id_prefix="liveui-",
                render_request=lambda _payload: True,
            )

        def handle_liveui_state_tool_call(self, args: Dict[str, Any]) -> str:
            return self._handle_liveui_link_tool_call(
                args,
                tool_name=LIVEUI_STATE_TOOL_NAME,
                method=LIVEUI_STATE_METHOD,
                call_id_prefix="liveui-state-",
                render_request=lambda _payload: False,
            )

        def handle_liveui_template_tool_call(self, args: Dict[str, Any]) -> str:
            return self._handle_liveui_link_tool_call(
                args,
                tool_name=LIVEUI_TEMPLATE_TOOL_NAME,
                method=LIVEUI_TEMPLATE_METHOD,
                call_id_prefix="liveui-template-",
                render_request=lambda payload: str(payload.get("operation") or "")
                == "render",
            )

        def handle_liveui_task_tool_call(self, args: Dict[str, Any]) -> str:
            return self._handle_liveui_link_tool_call(
                args,
                tool_name=LIVEUI_TASK_TOOL_NAME,
                method=LIVEUI_TASK_METHOD,
                call_id_prefix="liveui-task-",
                render_request=lambda _payload: False,
            )

        def handle_pre_llm_call(self, _kwargs: Dict[str, Any]) -> Optional[str]:
            # Native background-review forks deliberately share the parent's
            # session_id and platform for cache warmth. pre_llm_call supplies
            # their parent_session_id; later hooks carry the distinct turn_id.
            # Never inject foreground context into a fork, or let its delayed
            # completion close the next foreground dispatch in that session.
            # Tier 0 (T2 #2510) marks BEFORE the platform filter: a Telegram
            # or Desktop-routed turn on an adopted lineage is in flight too.
            self._inflight_mark(_kwargs or {})
            platform = str((_kwargs or {}).get("platform") or "").strip()
            if platform and platform != PLATFORM_NAME:
                return None
            if str((_kwargs or {}).get("parent_session_id") or "").strip():
                self._remember_background_hook_turn(_kwargs)
                return None
            try:
                from gateway.session_context import get_session_env
            except Exception:  # noqa: BLE001
                return None
            session_key = str(get_session_env("HERMES_SESSION_KEY", "") or "").strip()
            if not session_key:
                return None
            identity = parse_ocuclaw_session_key(session_key)
            if identity is None:
                return None
            try:
                prompt_params = {"sessionKey": session_key}
                record = self._ledger.head(session_key)
                if record is not None and record.prompt_owner and record.prompt_lane:
                    prompt_params["promptOwner"] = record.prompt_owner
                    prompt_params["promptLane"] = record.prompt_lane
                result = self._request_link_threadsafe(
                    LIVEUI_PROMPT_METHOD,
                    prompt_params,
                    timeout_s=LIVEUI_PROMPT_LINK_TIMEOUT_S,
                )
            except Exception:  # noqa: BLE001
                logger.debug("[ocuclaw] liveui prompt context unavailable", exc_info=True)
                return None
            if isinstance(result, dict) and isinstance(result.get("context"), str):
                context = result["context"].strip()
                fragments = result.get("fragments")
                if context and isinstance(fragments, list) and "voicemail" in fragments:
                    ack_token = result.get("voicemailAckToken")
                    ack_params = {"sessionKey": session_key}
                    if isinstance(ack_token, str) and ack_token:
                        ack_params["ackToken"] = ack_token
                    try:
                        self._request_link_threadsafe(
                            LIVEUI_PROMPT_ACK_METHOD,
                            ack_params,
                            timeout_s=LIVEUI_PROMPT_LINK_TIMEOUT_S,
                        )
                    except Exception:  # noqa: BLE001
                        logger.debug("[ocuclaw] liveui prompt ack unavailable", exc_info=True)
                return context or None
            return None

        async def handle_liveui_llm_auth(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            model = str(p.get("model") or "").strip()
            return {
                "status": "unavailable",
                "provider": "hermes",
                "model": model,
                "apiKey": "",
                "resolvedFromBackend": False,
                "reason": "llm recipes execute through liveui.llmRecipe",
            }

        async def handle_liveui_llm_recipe(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            recipe = p.get("recipe") if isinstance(p.get("recipe"), dict) else {}
            ctx = p.get("ctx") if isinstance(p.get("ctx"), dict) else {}
            prompt = str(recipe.get("prompt") or "").strip()
            if not prompt:
                return {"error": "llm recipe missing prompt"}
            llm = getattr(_PLUGIN_CONTEXT, "llm", None)
            if llm is None:
                return {"error": "Hermes plugin LLM unavailable"}

            call_kwargs: Dict[str, Any] = {
                "purpose": "ocuclaw.liveui.refresh",
            }
            model = str(ctx.get("model") or "").strip()
            if model:
                call_kwargs["model"] = model
            max_tokens = ctx.get("maxOutputTokens")
            max_output_tokens = 200
            if isinstance(max_tokens, (int, float)) and max_tokens > 0:
                max_output_tokens = int(max_tokens)
                call_kwargs["max_tokens"] = max_output_tokens
            previous_body = (
                ctx.get("previousBody") if isinstance(ctx.get("previousBody"), str) else ""
            )
            raw_system_prompt = recipe.get("systemPrompt")
            system_prompt = (
                raw_system_prompt
                if isinstance(raw_system_prompt, str) and raw_system_prompt
                else _default_liveui_llm_system_prompt(
                    max_output_tokens * 4,
                    previous_body,
                )
            )
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ]

            try:
                acomplete = getattr(llm, "acomplete", None)
                if callable(acomplete):
                    result = await acomplete(messages, **call_kwargs)
                else:
                    complete = getattr(llm, "complete", None)
                    if not callable(complete):
                        return {"error": "Hermes plugin LLM complete unavailable"}
                    loop = asyncio.get_running_loop()
                    result = await loop.run_in_executor(
                        None,
                        lambda: complete(messages, **call_kwargs),
                    )
            except Exception as exc:  # noqa: BLE001
                return {"error": str(exc)}

            text = str(getattr(result, "text", "") or "")
            return {
                "output": text,
                "provider": str(getattr(result, "provider", "") or "hermes"),
                "model": str(getattr(result, "model", "") or model),
            }

        # -- Copy-to-glasses action -------------------------------------------

        def _target_chat(
            self, params: Dict[str, Any]
        ) -> Tuple[str, Optional[str], Optional[str]]:
            target = (
                params.get("target") if isinstance(params.get("target"), dict) else {}
            )
            ns = str(target.get("ns") or self._namespace)
            route_error = self._namespace_route_error(ns)
            if route_error is not None:
                return ns, None, route_error
            chat_id = str(target.get("chatId") or "").strip()
            if not chat_id:
                return ns, None, "target.chatId is required"
            return ns, chat_id, None

        async def handle_foreign_copy(self, params: Any) -> Dict[str, Any]:
            p = params if isinstance(params, dict) else {}
            identity = p.get("identity") if isinstance(p.get("identity"), dict) else {}
            if identity.get("chatId"):
                return {
                    "status": "rejected",
                    "error": "foreign action requires a foreign source",
                }
            source_ns = str(identity.get("ns") or self._namespace)
            source_error = self._namespace_route_error(source_ns)
            if source_error is not None:
                return {"status": "rejected", "error": source_error}
            target_ns, chat_id, error = self._target_chat(p)
            if error:
                return {"status": "rejected", "error": error}
            if source_ns != target_ns:
                return {"status": "rejected", "error": CROSS_PROFILE_COPY_ERROR}
            try:
                session = await asyncio.to_thread(
                    self._session_rpc.copy_to_ocuclaw,
                    identity,
                    chat_id=chat_id,
                    target_public_key=str(p.get("targetPublicKey") or ""),
                )
            except ValueError as exc:
                return {"status": "rejected", "error": str(exc)}
            return {
                "status": "accepted",
                "sessionId": session.get("id"),
                "session": session,
            }

        # -- Continue here (adopt) — #2509 ----------------------------------

        def adopt_configured(self) -> bool:
            """Live read of the platform's `allow_admin_from` posture."""
            config = getattr(self, "config", None)
            extra = getattr(config, "extra", None)
            return adopt_configured(extra if isinstance(extra, dict) else {})

        @staticmethod
        def _adopt_rejection(verdict: str, **extra: Any) -> Dict[str, Any]:
            out = {"status": "rejected", "error": verdict, "verdict": verdict}
            out.update({k: v for k, v in extra.items() if v is not None})
            return out

        def _adopt_reply_verdict(self, reply: str, tip: str) -> Optional[str]:
            """Map Hermes's own `/resume` reply to a verdict — by rendering the
            SAME i18n keys through Hermes's translator, never by matching
            English prose. Success is never decided here (the DB decides)."""
            text = str(reply or "").strip()
            if not text:
                return None
            try:
                from agent.i18n import t
            except Exception:  # noqa: BLE001 - no translator, no text verdict
                return None
            candidates = {
                "blocked_not_owner": ("gateway.resume.blocked_not_owner", {"name": tip}),
                "not_found": ("gateway.resume.not_found", {"name": tip}),
                "already_on": ("gateway.resume.already_on", {"name": tip}),
                "switch_failed": ("gateway.resume.switch_failed", {}),
            }
            for verdict, (key, kwargs) in candidates.items():
                try:
                    if text == str(t(key, **kwargs)).strip():
                        return verdict
                except Exception:  # noqa: BLE001
                    continue
            return None

        async def handle_foreign_adopt(self, params: Any) -> Dict[str, Any]:
            """Adopt a Desktop/CLI/TUI transcript onto a fresh glasses lane.

            Mechanism (map #2507, RULED sanctioned): mint ``adopt-<uuid>``,
            send ``/resume <tip> --all`` through this adapter's own message
            path (``_build_message_event`` + ``handle_message``) so Hermes's
            public ``switch_session`` re-keys the transcript onto the minted
            lane; then read the verdict from the DB (``adopt_outcome``) — the
            reply text only classifies refusals via Hermes's own i18n keys.

            Verdicts (``error`` == ``verdict`` on the wire, App.kt labels them):
            ``admin_not_configured`` · ``desktop_busy`` (``holdState``:
            working|hold) · ``own_lane_busy`` · ``blocked_not_owner`` ·
            ``not_found`` · ``adopt_timeout`` — plus the pre-DB refusals
            ``minted_identity_refused`` / ``adopt_requires_default_namespace``
            / ``platform_row_not_adoptable`` / ``source_not_adoptable``.
            """
            p = params if isinstance(params, dict) else {}
            identity = p.get("identity") if isinstance(p.get("identity"), dict) else {}
            take_over = p.get("takeOver") is True
            if identity.get("chatId"):
                return self._adopt_rejection("minted_identity_refused")
            ns = str(identity.get("ns") or self._namespace)
            if ns != DEFAULT_SESSION_NAMESPACE:
                return self._adopt_rejection("adopt_requires_default_namespace")
            if not self.adopt_configured():
                return self._adopt_rejection("admin_not_configured")
            try:
                source = await asyncio.to_thread(
                    self._session_rpc.resolve_adopt_source, identity
                )
            except NotAdoptableError as exc:
                return self._adopt_rejection(str(exc) or "source_not_adoptable")
            except ValueError as exc:
                return self._adopt_rejection("not_found", detail=str(exc))
            tip = str(source["tip"])
            lineage = [str(value) for value in source.get("lineage") or [tip]]
            if tip in self._adopting_tips:
                return self._adopt_rejection("own_lane_busy", tip=tip)
            inflight_platform = self.inflight_platform(lineage)
            if inflight_platform is not None:
                # Tier 0: a turn on this lineage is running inside THIS
                # gateway (any platform) — `/resume` mid-turn would re-key a
                # live agent. Retry when it ends.
                return self._adopt_rejection(
                    "own_lane_busy", tip=tip, detail=inflight_platform or None
                )
            if not take_over:
                hold = await asyncio.to_thread(
                    desktop_hold_state, self._profile_home_for_options(ns), lineage
                )
                if hold is not None:
                    return self._adopt_rejection("desktop_busy", holdState=hold, tip=tip)

            chat_id = f"{ADOPT_CHAT_ID_PREFIX}{uuid.uuid4().hex}"
            adopt_key = self._session_key_for_chat(chat_id, ns=ns)
            loop = asyncio.get_running_loop()
            waiter: asyncio.Future = loop.create_future()
            self._adopt_waiters[chat_id] = waiter
            self._adopting_tips.add(tip)
            reply_text = ""
            outcome: Dict[str, Any] = {"adopted": False, "predecessors": []}
            try:
                event = self._build_message_event(chat_id, f"/resume {tip} --all")
                await self.handle_message(event)
                deadline = loop.time() + ADOPT_TIMEOUT_S
                while True:
                    outcome = await asyncio.to_thread(
                        self._session_rpc.adopt_outcome, adopt_key, tip
                    )
                    if outcome.get("adopted"):
                        break
                    if waiter.done() and not reply_text:
                        reply_text = str(waiter.result() or "")
                        verdict = self._adopt_reply_verdict(reply_text, tip)
                        if verdict is not None:
                            return self._adopt_rejection(
                                verdict, tip=tip, detail=reply_text
                            )
                    if loop.time() >= deadline:
                        return self._adopt_rejection(
                            "adopt_timeout", tip=tip, detail=reply_text or None
                        )
                    await asyncio.sleep(ADOPT_POLL_S)
            finally:
                self._adopt_waiters.pop(chat_id, None)
                self._adopting_tips.discard(tip)
            # The fresh stub Hermes ended (`session_switch`, 0 messages) is
            # presentation noise on the same key: hide it with the public flag.
            hidden = await asyncio.to_thread(
                self._session_rpc.hide_sessions,
                [row["id"] for row in outcome.get("predecessors") or []],
            )
            session = outcome.get("session") or {}
            return {
                "status": "accepted",
                "sessionId": tip,
                "session": session,
                "adoptKey": adopt_key,
                "chatId": chat_id,
                "adoptedFrom": str(p.get("publicKey") or ""),
                "predecessors": outcome.get("predecessors") or [],
                "hiddenPredecessors": hidden,
            }

        async def handle_foreign_driver(self, params: Any) -> Dict[str, Any]:
            """Who drives a glasses lane right now (single-driver lock, #2510).

            ``{identity, publicKey}`` (a minted lane — the adopt key
            ``hermes:main:adopt-<uuid>`` or any ocuclaw chat) →
            ``{status:"ok", state, holdState, hold, inflight, lineage,
            sessionId, hermesHome, watch}``. ``state`` is
            ``glasses_drive`` / ``desktop_hold`` / ``desktop_working``
            from Hermes's own files (``desktop_hold_details``); ``inflight``
            is tier 0 (a turn running in THIS gateway on the lineage);
            ``hermesHome`` + ``watch`` name the two files Node watches
            (directory watches: the marker is unlinked/replaced, the
            registry is written via ``os.replace``). Read on demand only —
            Node calls this at arm time and per file event, never on a
            timer. An unknown key answers ``glasses_drive`` with an empty
            lineage: unknowable never locks the wearer out.
            """
            p = params if isinstance(params, dict) else {}
            identity = p.get("identity") if isinstance(p.get("identity"), dict) else {}
            ns = str(identity.get("ns") or self._namespace)
            chat_id = str(identity.get("chatId") or "").strip()
            home = self._profile_home_for_options(ns)
            lineage: List[str] = []
            session_id: Optional[str] = None
            if chat_id:
                session_key = self._session_key_for_chat(chat_id, ns=ns)
                try:
                    lineage = await asyncio.to_thread(
                        self._session_rpc.lineage_for_key, session_key
                    )
                except Exception:  # noqa: BLE001 - unknowable never locks
                    logger.debug(
                        "[ocuclaw] driver lineage unavailable for %s", session_key, exc_info=True
                    )
                    lineage = []
                session_id = lineage[0] if lineage else None
            hold = await asyncio.to_thread(desktop_hold_details, home, lineage)
            inflight_platform = self.inflight_platform(lineage)
            return {
                "status": "ok",
                "publicKey": str(p.get("publicKey") or ""),
                "sessionId": session_id,
                "lineage": lineage,
                "state": driver_state_for(hold),
                "holdState": hold.get("state") if hold else None,
                "hold": hold,
                "inflight": {
                    "active": inflight_platform is not None,
                    "platform": inflight_platform,
                },
                "hermesHome": str(home) if home is not None else None,
                "watch": {
                    "markerDir": DESKTOP_TURN_MARKER_RELPATH[0],
                    "markerFile": DESKTOP_TURN_MARKER_RELPATH[1],
                    "leaseDir": DESKTOP_LEASE_REGISTRY_RELPATH[0],
                    "leaseFile": DESKTOP_LEASE_REGISTRY_RELPATH[1],
                },
            }

        async def handle_chat_watermark(self, params: Any) -> Dict[str, Any]:
            """``db.chat.watermark`` with the tier-0 in-flight verdict (#2513).

            The Desktop→glasses mirror reads this once per debounced WAL
            event: ``watermark`` (``MAX(messages.id)`` on the lane's tip)
            says whether rows landed; ``inflight`` says whether THIS gateway
            is the one writing them (the wearer's own turn — those rows are
            already on the glasses, so the mirror advances silently instead
            of re-rendering them). Never called on a timer.
            """
            result = await self._session_rpc.chat_watermark(params)
            session_id = str(result.get("sessionId") or "")
            inflight_platform = (
                self.inflight_platform([session_id]) if session_id else None
            )
            result["inflight"] = {
                "active": inflight_platform is not None,
                "platform": inflight_platform,
            }
            return result

        # -- turn completion (hermes on_session_end, sync, worker thread) ----

        def handle_session_end(self, kwargs: Dict[str, Any]) -> None:
            # Tier 0 (T2 #2510) clears BEFORE the platform filter.
            self._inflight_clear(kwargs)
            if str(kwargs.get("platform") or "") != PLATFORM_NAME:
                return
            if self._background_hook_turn(kwargs):
                return
            session_id = str(kwargs.get("session_id") or "")
            if not session_id:
                return
            completed = bool(kwargs.get("completed"))
            interrupted = bool(kwargs.get("interrupted"))
            try:
                row = self._session_rpc.row_by_id(session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[ocuclaw] session row lookup failed for %s: %s", session_id, exc
                )
                row = None
            if not row:
                return
            session_key = str(row.get("session_key") or "")
            identity = parse_ocuclaw_session_key(session_key)
            if identity is None:
                # Not the minted DM lane.
                return
            # Stale-end guards (Codex review W06 finding): a turn whose
            # /new-cancel landed AFTER run_conversation passed the finalize
            # point still fires a LATE on_session_end — it must not complete
            # the records begun after the cancel.
            head_probe = self._ledger.head(session_key)
            if head_probe is not None and head_probe.kind == KIND_SLASH:
                # Slash turns fire NO on_session_end by design (D9) — an end
                # arriving while a slash record heads the session belongs to
                # a cancelled pre-reset turn.
                logger.debug(
                    "[ocuclaw] stale on_session_end for %s ignored (slash head)",
                    session_key,
                )
                return
            if self._ledger.cancel_fence_active(session_key):
                # Non-consuming: the fence guards EVERY end until its TTL —
                # a legit post-reset end must not disarm it ahead of a very
                # late stale end from the cancelled turn.
                try:
                    newest = self._session_rpc.newest_carrier_id(session_key)
                except Exception:  # noqa: BLE001
                    newest = None
                if newest is not None and newest != session_id:
                    # Pre-reset row: /new minted a fresh carrier for the key;
                    # this end belongs to the cancelled turn.
                    logger.debug(
                        "[ocuclaw] stale on_session_end for %s ignored "
                        "(pre-reset carrier %s, newest %s)",
                        session_key,
                        session_id,
                        newest,
                    )
                    return

            self._defer_drain_session_approvals(
                session_key,
                self._approval_ids_for_session(session_key),
            )

            try:
                messages = self._session_rpc.conversation_by_id(
                    session_id, limit=HISTORY_PUSH_LIMIT
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[ocuclaw] transcript read failed for %s: %s", session_id, exc
                )
                messages = []

            tail_closure_key = None
            # Lock ordering: _stream_tail_lock is always outside the ledger's
            # internal lock; never acquire it while holding the ledger lock.
            with self._stream_tail_lock:
                head, merged, promoted = (
                    (None, [], None)
                    if self._stream_tail_closing
                    else self._ledger.complete_stream_tail_head(session_key)
                )
                if head is not None:
                    message_id = str(head.current_message_id)
                    tail_closure_key = (session_key, message_id)
                    self._stream_tail_closures[tail_closure_key] = {
                        "record": head,
                        "riders": merged,
                        "completed": completed,
                        "interrupted": interrupted,
                        "identity": identity,
                        "messages": messages,
                    }
            if tail_closure_key is not None:
                if promoted is not None:
                    self._emit_event("activity", lifecycle_start_activity(promoted))
                if self._schedule_stream_tail_fallback(tail_closure_key):
                    return
                # A production adapter has a live gateway loop. Tests and
                # degraded pre-connect paths do not; preserve bounded
                # completion there by falling back synchronously.
                self._finish_deferred_stream_tail(*tail_closure_key)
                return

            head, merged, promoted = self._ledger.complete_session_end_head(session_key)
            public_key = head.public_key if head is not None else None
            if (
                head is not None
                and head.current_message_id is not None
                and not head.current_committed
                and head.current_text
            ):
                # Non-finalized tail (streaming off, fresh-final fallback):
                # commit the last-seen text as the assistant message.
                self._emit_message_commit(head, head.current_text)
                self._note_phone_turn_message_commit(head)
            if head is not None:
                self._emit_event(
                    "activity",
                    lifecycle_terminal_activity(
                        head, completed=completed, interrupted=interrupted
                    ),
                )
                self._forget_thinking_run(head.run_id)
            for rider in merged:
                self._emit_event(
                    "activity",
                    lifecycle_terminal_activity(
                        rider, completed=completed, interrupted=interrupted
                    ),
                )
                self._forget_thinking_run(rider.run_id)
            # agent_end host hook (census-gap row 3, ×4 consumers).
            #
            # NO per-turn history push: the message-commit lane is the
            # per-turn transcript mechanism, and a post-turn history
            # REPLACEMENT races the finalize commit across threads — when the
            # replacement lands first, the commit appends a second copy of
            # the same assistant message (duplicate caught live in the W06
            # dispatch receipt). Openclaw pushes history only on
            # load/reconnect; switch-time hydration rides the chat.history
            # REQUEST. The history event lane stays delivery-ready for
            # activation/compaction triggers (W07/W08).
            self._emit_hook(
                agent_end_hook_frame(
                    identity,
                    messages,
                    public_key=public_key,
                    agent_id=identity["ns"],
                    run_id=head.run_id if head is not None else None,
                )
            )
            if promoted is not None:
                self._emit_event("activity", lifecycle_start_activity(promoted))

        # -- helpers -----------------------------------------------------------

        def _refresh_profile_routing(self) -> None:
            enabled, homes = _load_profile_routing()
            self._multiplex_enabled = enabled
            self._served_profile_homes = dict(homes)

        def _profile_routing_snapshot(self) -> Tuple[bool, Dict[str, Path]]:
            return self._multiplex_enabled, dict(self._served_profile_homes)

        def _namespace_route_error(self, ns: str) -> Optional[str]:
            namespace = str(ns or self._namespace)
            if namespace == self._namespace:
                return None
            if not self._multiplex_enabled:
                return MULTIPLEX_DISABLED_ERROR
            profile = profile_for_namespace(namespace)
            if namespace not in self._served_profile_homes:
                return PROFILE_NOT_SERVED_ERROR.format(profile=profile)
            return None

        def _namespace_for_outbound(
            self,
            metadata: Any = None,
            *,
            chat_id: Any = None,
            message_id: Any = None,
        ) -> str:
            meta = metadata if isinstance(metadata, dict) else {}
            native_key = str(
                meta.get("session_key") or meta.get("sessionKey") or ""
            )
            identity = parse_ocuclaw_session_key(native_key)
            if identity is not None:
                return identity["ns"]
            profile = str(meta.get("profile") or "").strip()
            if profile:
                return _namespace_for_profile(profile)
            try:
                from gateway.session_context import get_session_env

                native_key = str(
                    get_session_env("HERMES_SESSION_KEY", "") or ""
                ).strip()
                identity = parse_ocuclaw_session_key(native_key)
                if identity is not None:
                    return identity["ns"]
                profile = str(
                    get_session_env("HERMES_SESSION_PROFILE", "") or ""
                ).strip()
                if profile:
                    return _namespace_for_profile(profile)
            except Exception:  # noqa: BLE001
                pass
            if chat_id is not None:
                candidates = []
                namespaces = dict.fromkeys(
                    (self._namespace, *self._served_profile_homes.keys())
                )
                for ns in namespaces:
                    session_key = self._session_key_for_chat(chat_id, ns=ns)
                    record = self._ledger.head(session_key)
                    if record is None:
                        continue
                    if (
                        message_id is not None
                        and record.current_message_id != str(message_id)
                    ):
                        continue
                    candidates.append(record)
                if len(candidates) == 1:
                    identity = parse_ocuclaw_session_key(
                        candidates[0].session_key
                    )
                    if identity is not None:
                        return identity["ns"]
                if len(candidates) > 1:
                    candidate_session_keys = [
                        record.session_key for record in candidates
                    ]
                    candidate_namespaces = [
                        identity["ns"]
                        for identity in (
                            parse_ocuclaw_session_key(session_key)
                            for session_key in candidate_session_keys
                        )
                        if identity is not None
                    ]
                    logger.error(
                        "[ocuclaw] ambiguous outbound namespace "
                        "chat_id=%r candidate_session_keys=%s",
                        chat_id,
                        candidate_session_keys,
                    )
                    raise AmbiguousOutboundNamespaceError(
                        chat_id,
                        candidate_namespaces,
                    )
            return self._namespace

        def _session_key_for_chat(
            self,
            chat_id: Any,
            *,
            ns: Optional[str] = None,
        ) -> str:
            namespace = str(ns or self._namespace)
            return (
                f"agent:{namespace}:{OCUCLAW_PLATFORM_SEGMENT}:"
                f"{OCUCLAW_CHAT_TYPE_SEGMENT}:{chat_id}"
            )

        def _next_message_id(self) -> str:
            """Mint the platform message id for one outbound message.

            Two jobs on one token. Hermes uses it to correlate edits back to
            the send that opened them (``DispatchLedger.note_edit`` binds on
            strict equality), and since #1691 it is also the LEDGER identity
            the commit carries downstream, where it becomes the display
            entry's ``srv:<id>``.

            The second job is why the process nonce is here. A bare
            ``ocuclaw-<n>`` counter restarts at 1 with the adapter, so after a
            gateway restart the ids of a still-open session's new messages
            would collide with the ids its earlier messages already claimed in
            the consumer's ``seqByAlias`` map — two different messages
            answering to one sequence number. The nonce makes every id unique
            for all time at the cost of eight characters, and nothing anywhere
            parses the shape.
            """
            self._message_seq += 1
            return f"ocuclaw-{self._message_id_nonce}-{self._message_seq}"

        def _schedule_stream_tail_fallback(
            self, closure_key: Tuple[str, str]
        ) -> bool:
            loop = self._loop
            if loop is None or loop.is_closed():
                return False

            async def _fallback() -> None:
                await asyncio.sleep(STREAM_FINALIZE_GRACE_SECONDS)
                self._finish_deferred_stream_tail(*closure_key)

            def _arm() -> None:
                with self._stream_tail_lock:
                    if closure_key not in self._stream_tail_closures:
                        return
                    task = loop.create_task(_fallback())
                    self._stream_tail_tasks[closure_key] = task

                def _forget(done: asyncio.Task) -> None:
                    with self._stream_tail_lock:
                        if self._stream_tail_tasks.get(closure_key) is done:
                            self._stream_tail_tasks.pop(closure_key, None)

                task.add_done_callback(_forget)

            try:
                loop.call_soon_threadsafe(_arm)
            except RuntimeError:
                return False
            return True

        def _finish_deferred_stream_tail(
            self, session_key: str, message_id: str
        ) -> bool:
            closure_key = (session_key, message_id)
            with self._stream_tail_lock:
                closure = self._stream_tail_closures.pop(closure_key, None)
                task = self._stream_tail_tasks.pop(closure_key, None)
            if closure is None:
                return False
            current_task = None
            try:
                current_task = asyncio.current_task()
            except RuntimeError:
                pass
            if task is not None and task is not current_task:
                task.cancel()

            head = closure["record"]
            merged = closure["riders"]
            if (
                head.current_message_id is not None
                and not head.current_committed
                and head.current_text
            ):
                # Provider abort/no trailing finalize: close the last-seen
                # cumulative text once after the bounded grace period.
                self._emit_message_commit(head, head.current_text)
                self._note_phone_turn_message_commit(head)
            self._emit_event(
                "activity",
                lifecycle_terminal_activity(
                    head,
                    completed=bool(closure["completed"]),
                    interrupted=bool(closure["interrupted"]),
                ),
            )
            self._forget_thinking_run(head.run_id)
            for rider in merged:
                self._emit_event(
                    "activity",
                    lifecycle_terminal_activity(
                        rider,
                        completed=bool(closure["completed"]),
                        interrupted=bool(closure["interrupted"]),
                    ),
                )
                self._forget_thinking_run(rider.run_id)
            self._emit_hook(
                agent_end_hook_frame(
                    closure["identity"],
                    closure["messages"],
                    public_key=head.public_key,
                    agent_id=closure["identity"]["ns"],
                    run_id=head.run_id,
                )
            )
            return True

        def _note_phone_turn_message_commit(self, record: Any) -> None:
            """Publish a candidate when this commit completes the two-signal gate."""

            if (
                record is None
                or record.kind != KIND_TURN
                or parse_ocuclaw_session_key(record.session_key) is None
            ):
                return
            if self._phone_turn_candidate_gate.note_committed(
                record.session_key, record.run_id
            ):
                record_phone_turn_candidate(
                    session_key=record.session_key,
                    turn_id=record.run_id,
                )

        async def _close_session_records(self, session_key: str, *, code: str) -> None:
            await self._drain_session_approvals(session_key)
            records = self._ledger.drain_session(session_key)
            for record in records:
                self._emit_event(
                    "activity",
                    lifecycle_terminal_activity(record, completed=False, code=code),
                )
                self._forget_thinking_run(record.run_id)
            if records:
                # The cancelled turn may still fire a LATE on_session_end (a
                # cancel landing after the finalize point) — fence it so the
                # stale end cannot complete post-cancel records.
                self._ledger.arm_cancel_fence(session_key)

        def _discard_attachment_spills(self, attachments: Any) -> None:
            """Reclaim child-spilled attachment temp files on dispatch paths
            that return WITHOUT ingesting (in-band reject, idempotent
            replay) — the child cleans up only on transport failure."""
            if not isinstance(attachments, list):
                return
            for att in attachments:
                if isinstance(att, dict) and isinstance(att.get("path"), str) and att["path"]:
                    try:
                        Path(att["path"]).unlink()
                    except OSError:
                        pass

        def _read_session_flags(self, session_key: str) -> Optional[str]:
            """resume_pending / suspended off the persisted SessionEntry
            (sessions/sessions.json — suspended WINS, spec §Error Handling)."""
            identity = parse_ocuclaw_session_key(session_key)
            ns = (
                identity.get("ns")
                if identity is not None
                else self._namespace
            )
            home = (
                self._served_profile_homes.get(ns)
                if ns != self._namespace
                else _hermes_home()
            )
            if home is None:
                return None
            try:
                data = json.loads(
                    (home / "sessions" / "sessions.json").read_text(encoding="utf-8")
                )
                entry = data.get(session_key)
                if isinstance(entry, dict):
                    if entry.get("suspended"):
                        return "suspended"
                    if entry.get("resume_pending"):
                        return "resume_pending"
            except Exception:  # noqa: BLE001 — best-effort surface, never blocks
                pass
            return None

        def _ingest_attachments(
            self, attachments: Any
        ) -> Tuple[List[str], List[str]]:
            """Link attachment descriptors → hermes media cache (LOCAL PATHS
            in media_urls + parallel media_types). Spill files are unlinked
            after ingestion; inline descriptors carry base64 content."""
            urls: List[str] = []
            types: List[str] = []
            if not isinstance(attachments, list):
                return urls, types
            try:
                from gateway.platforms.base import cache_media_bytes
            except Exception:  # noqa: BLE001
                logger.warning("[ocuclaw] media cache unavailable; dropping attachments")
                return urls, types
            for att in attachments:
                if not isinstance(att, dict):
                    continue
                spill_path = att.get("path")
                data: Optional[bytes] = None
                try:
                    if isinstance(spill_path, str) and spill_path:
                        data = Path(spill_path).read_bytes()
                    elif isinstance(att.get("content"), str) and att["content"]:
                        data = base64.b64decode(att["content"])
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[ocuclaw] attachment read failed: %s", exc)
                finally:
                    if isinstance(spill_path, str) and spill_path:
                        try:
                            Path(spill_path).unlink()
                        except OSError:
                            pass
                if not data:
                    continue
                cached = cache_media_bytes(
                    data,
                    filename=str(att.get("fileName") or ""),
                    mime_type=str(att.get("mimeType") or ""),
                )
                if cached is None:
                    continue
                urls.append(str(cached.path))
                types.append(
                    str(getattr(cached, "mime", "") or att.get("mimeType") or "")
                )
            return urls, types

        def _build_message_event(
            self,
            chat_id: str,
            text: str,
            *,
            profile: Optional[str] = None,
            channel_prompt: Any = None,
            media_urls: Optional[List[str]] = None,
            media_types: Optional[List[str]] = None,
        ):
            from gateway.platforms.base import MessageEvent, MessageType

            # Use Hermes' source builder rather than constructing SessionSource
            # directly. Since v0.20.6 the builder retains the live transport
            # adapter as non-serialized provenance. The gateway uses that
            # provenance to honor this shared adapter's upstream relay-token
            # authorization even when a multiplexed turn targets a secondary
            # profile that has no separate OcuClaw adapter instance.
            source = self.build_source(
                chat_id=str(chat_id),
                chat_name="OcuClaw Glasses",
                chat_type=OCUCLAW_CHAT_TYPE_SEGMENT,
                user_id=OCUCLAW_WEARER_USER_ID,
                user_name="OcuClaw",
            )
            # The profile was selected by the authenticated OcuClaw session,
            # not Hermes' optional chat-route table.
            source.profile = profile
            media = list(media_urls or [])
            event = MessageEvent(
                text=text,
                message_type=MessageType.PHOTO if media else MessageType.TEXT,
                source=source,
                media_urls=media,
                media_types=list(media_types or []),
                channel_prompt=(
                    channel_prompt
                    if isinstance(channel_prompt, str) and channel_prompt
                    else None
                ),
                # Non-internal by design (spec: wake is a non-internal
                # MessageEvent): the relayToken gate upstream IS the
                # authorization; internal=True would also freeze busy-input
                # handling to queue-only.
                internal=False,
            )
            return event

        # -- event emission (thread-safe, fire-and-forget) --------------------

        def _emit_event(
            self,
            name: str,
            payload: Dict[str, Any],
            *,
            swallow_errors: bool = True,
        ) -> Optional[Any]:
            if name == "activity":
                try:
                    self._session_status.observe_activity(payload)
                except Exception:  # status is observational, never part of delivery success
                    pass
            return self._emit_frame(
                BACKEND_EVENT_METHOD,
                {"name": name, "payload": payload},
                swallow_errors=swallow_errors,
            )

        def _emit_hook(self, frame: Dict[str, Any]) -> None:
            self._emit_frame(BACKEND_HOOK_METHOD, frame)

        def _emit_frame(
            self,
            method: str,
            params: Dict[str, Any],
            *,
            swallow_errors: bool = True,
        ) -> Optional[Any]:
            link = self._link
            loop = self._loop
            if link is None or loop is None or loop.is_closed():
                return None

            async def _push() -> None:
                try:
                    await link.request(method, params, timeout_s=10.0)
                except Exception as exc:  # noqa: BLE001 — events are best-effort
                    if not swallow_errors:
                        raise
                    logger.debug("[ocuclaw] %s push failed: %s", method, exc)

            try:
                # Safe from any thread (on_session_end fires on the agent's
                # worker thread); scheduling order is FIFO per thread.
                return asyncio.run_coroutine_threadsafe(_push(), loop)
            except RuntimeError:
                return None

        async def _janitor_loop(self) -> None:
            # D9 backstop: escaped-exception turns bypass finalize_turn (no
            # on_session_end) — close their records so run-waiters reject.
            while True:
                await asyncio.sleep(JANITOR_INTERVAL_SECONDS)
                try:
                    self._sweep_stale_dispatch_records()
                except Exception:  # noqa: BLE001
                    logger.exception("[ocuclaw] dispatch janitor sweep failed")

        def _sweep_stale_dispatch_records(self) -> None:
            for head, merged, promoted in self._ledger.sweep_stale():
                for record in [head, *merged]:
                    self._emit_event(
                        "activity",
                        lifecycle_terminal_activity(
                            record,
                            completed=False,
                            code=record.terminal_error_code or "stale",
                        ),
                    )
                if promoted is not None:
                    self._emit_event("activity", lifecycle_start_activity(promoted))

        def _schedule_error_terminal_sweep(self, delay_seconds: float) -> None:
            loop = self._loop
            if loop is None or loop.is_closed():
                return

            async def _delayed_sweep() -> None:
                try:
                    await asyncio.sleep(max(0.0, float(delay_seconds or 0.0)))
                    self._sweep_stale_dispatch_records()
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    logger.exception("[ocuclaw] dispatch error-terminal sweep failed")

            def _arm() -> None:
                task = loop.create_task(_delayed_sweep())
                self._error_sweep_tasks.add(task)
                task.add_done_callback(self._error_sweep_tasks.discard)

            try:
                loop.call_soon_threadsafe(_arm)
            except RuntimeError:
                return

        def _on_child_exit(self, returncode: Optional[int]) -> None:
            logger.warning(
                "[ocuclaw] runtime child exited (code=%s) — link down",
                returncode,
            )
            event = self._runtime_ready_event
            if event is not None:
                # Wake a pending connect() boot-receipt wait immediately —
                # the post-wait is_alive check turns this into a clean
                # connect failure instead of a full-timeout stall.
                event.set()
            self._mark_disconnected()

    return OcuClawAdapter(config, Platform(PLATFORM_NAME))
