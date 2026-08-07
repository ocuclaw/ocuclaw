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

Secrets are set through ``hermes config set OCUCLAW_*`` and stored in
``~/.hermes/.env``.  The env-enablement bridge maps those values onto the
runtime keys; legacy yaml secret keys remain readable but lose to env.

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
import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit, urlunsplit

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
    lifecycle_start_activity,
    lifecycle_terminal_activity,
    message_commit_event,
    parse_ocuclaw_session_key,
    normalize_session_reset_command,
    status_activity,
    streaming_event,
    strip_stream_cursor,
    uncorrelated_message_event,
)
from .models_rpc import (
    GwRpc,
    load_profile_routing_snapshot,
    namespace_for_profile,
    profile_for_namespace,
)
from .session_rpc import (
    DEFAULT_SESSION_NAMESPACE,
    OCUCLAW_CHAT_TYPE_SEGMENT,
    OCUCLAW_PLATFORM_SEGMENT,
    ProfileSessionRpc,
    default_state_db_path,
)

logger = logging.getLogger(__name__)

PLATFORM_NAME = "ocuclaw"
PLATFORM_LABEL = "OcuClaw"
OCUCLAW_RELAY_TOKEN_ENV = "OCUCLAW_RELAY_TOKEN"
OCUCLAW_SONIOX_API_KEY_ENV = "OCUCLAW_SONIOX_API_KEY"
OCUCLAW_EVEN_AI_TOKEN_ENV = "OCUCLAW_EVEN_AI_TOKEN"
_SECRET_ENV_TO_ADAPTER_KEY = {
    OCUCLAW_RELAY_TOKEN_ENV: "relayToken",
    OCUCLAW_SONIOX_API_KEY_ENV: "sonioxApiKey",
    OCUCLAW_EVEN_AI_TOKEN_ENV: "evenAiToken",
}
# Documented plugin authorization lane (hermes developer guide "Adding a
# Platform Adapter"): the gateway consults these envs in
# _is_user_authorized for EVERY profile, so they are the multiplex-safe
# way to authorize glasses turns on secondary profiles. The adapter's
# authorization_is_upstream property still covers the default profile,
# but the gateway's profile-scoped adapter lookup deliberately fails
# closed for stamped secondary profiles (upstream
# test_multiplex_profile_authz.py), so without one of these envs every
# secondary-profile turn is dropped as unauthorized.
OCUCLAW_ALLOWED_USERS_ENV = "OCUCLAW_ALLOWED_USERS"
OCUCLAW_ALLOW_ALL_USERS_ENV = "OCUCLAW_ALLOW_ALL_USERS"
REGISTERED_HOOK_NAMES = (
    "on_session_end",
    "post_approval_response",
    "pre_tool_call",
    "post_tool_call",
    "post_api_request",
    "pre_llm_call",
)

# Supported hermes range for this bundle build. The public SessionDB surface
# this adapter consumes was verified at anchor 3ef6bbd2 (tag v2026.7.20 /
# hermes 0.19.0); minor bumps are expected to churn the plugin ABI, so the
# gate is a hard [min, max).
SUPPORTED_HERMES_MIN = (0, 19, 0)
SUPPORTED_HERMES_MAX_EXCLUSIVE = (0, 20, 0)

BUNDLE_DIR = Path(__file__).resolve().parent
DEFAULT_RUNTIME_ENTRY = BUNDLE_DIR / "dist-cjs" / "runtime" / "hermes-runtime-entry.cjs"

# History pushes + agent_end transcripts are tail-sliced server-side so a long
# session never risks the 1 MiB link frame cap (same bound as chat.history).
HISTORY_PUSH_LIMIT = 200
# Hermes 0.19 drains StreamConsumer on its own task, so on_session_end can beat
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
TOOL_ACTIVITY_SECRET_ARG_KEY_MARKERS = (
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
TOOL_ACTIVITY_URL_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s\"'<>]+")
TOOL_ACTIVITY_URL_SECRET_KEY_EXACT = {
    "auth",
    "code",
    "key",
    "otp",
    "pat",
    "pin",
    "pwd",
    "sig",
}
TOOL_ACTIVITY_URL_SECRET_KEY_MARKERS = TOOL_ACTIVITY_SECRET_ARG_KEY_MARKERS + (
    "signature",
)
THINKING_FRAME_MAX_CHARS = 8000
THINKING_FRAME_TRUNCATION_SUFFIX = "...[truncated]"
THINKING_FRAME_TRUNCATION_PREFIX = "[truncated]..."

# connect() gates on the child's explicit runtime.ready receipt (relay bound)
# whenever a relay boot is expected (relayToken set) — a bind failure must
# never publish a transiently-connected platform (Codex review W06 finding).
RUNTIME_READY_TIMEOUT_S = 30.0

FOREIGN_COPY_METHOD = "foreign.sessions.copy"
APPROVAL_RESOLVE_METHOD = "approval.resolve"
SESSION_ABORT_METHOD = "sessions.abort"
SESSION_STEER_METHOD = "sessions.steer"
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
LIVEUI_TOOLSET = "plugin_ocuclaw"
LIVEUI_DEFAULT_RENDER_TIMEOUT_MS = 30 * 60 * 1000
LIVEUI_RENDER_LINK_MARGIN_S = 60.0
LIVEUI_PROMPT_LINK_TIMEOUT_S = 2.0

# Adapter instances the module-level hermes hook handlers route into (hooks
# are registered ONCE at plugin load; adapters are constructed per platform
# boot and live for the gateway's lifetime).
_ADAPTERS: List[Any] = []
_POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = False
_PLUGIN_CONTEXT: Any = None
_LIVEUI_REGISTER_TOOL: Any = None
_LIVEUI_TOOL_REGISTERED = False
_LIVEUI_LOCK = threading.RLock()


def _hermes_home() -> Optional[Path]:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001
        return None


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


def _liveui_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    adapter = _connected_adapter()
    return adapter.handle_liveui_tool_call(args)


def _liveui_descriptor_from_hello(hello: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    liveui = hello.get("liveui") if isinstance(hello, dict) else None
    if not isinstance(liveui, dict):
        return None
    tools = liveui.get("tools")
    if isinstance(tools, list):
        for item in tools:
            if isinstance(item, dict) and item.get("name") == LIVEUI_TOOL_NAME:
                return item
    direct = liveui.get(LIVEUI_TOOL_NAME)
    return direct if isinstance(direct, dict) else None


def _register_liveui_tool_from_hello(hello: Dict[str, Any]) -> None:
    descriptor = _liveui_descriptor_from_hello(hello)
    if not descriptor:
        logger.warning("[ocuclaw] liveui descriptor missing from runtime hello")
        return
    schema = descriptor.get("schema")
    if not isinstance(schema, dict):
        logger.warning("[ocuclaw] liveui descriptor has no schema; tool not registered")
        return
    name = str(descriptor.get("name") or LIVEUI_TOOL_NAME)
    if name != LIVEUI_TOOL_NAME:
        logger.warning("[ocuclaw] unexpected liveui tool name %r; tool not registered", name)
        return
    description = str(descriptor.get("description") or schema.get("description") or "")
    toolset = str(descriptor.get("toolset") or LIVEUI_TOOLSET)
    global _LIVEUI_TOOL_REGISTERED
    with _LIVEUI_LOCK:
        if _LIVEUI_TOOL_REGISTERED:
            return
        register_tool = _LIVEUI_REGISTER_TOOL
        if not callable(register_tool):
            logger.warning("[ocuclaw] ctx.register_tool unavailable; liveui degraded")
            return
        register_tool(
            name=LIVEUI_TOOL_NAME,
            toolset=toolset,
            schema=schema,
            handler=_liveui_tool_handler,
            check_fn=check_ocuclaw_requirements,
            is_async=False,
            description=description,
        )
        _LIVEUI_TOOL_REGISTERED = True
        logger.info("[ocuclaw] liveui tool registered from runtime descriptor")


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


def _find_node() -> Optional[str]:
    try:
        from hermes_constants import find_node_executable

        return find_node_executable("node")
    except Exception:  # noqa: BLE001 — helper is hermes-version-sensitive
        import shutil

        return shutil.which("node")


def check_ocuclaw_requirements() -> bool:
    """check_fn: dependencies only (node present). Config-dependent checks
    (entry file vs runtimeCommand override) live in validate_config."""
    return _find_node() is not None


def _extra(config: Any) -> Dict[str, Any]:
    extra = getattr(config, "extra", None)
    return extra if isinstance(extra, dict) else {}


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
        "allowDebugUpload": _bool("allowDebugUpload", True),
        "debugUploadMaxZipBytes": debug_upload_max_zip_bytes,
        "debugUploadCapturePreset": _list("debugUploadCapturePreset"),
        "debugBundleSaveDir": str(extra.get("debugBundleSaveDir") or ""),
        "evenTerminalEnabled": _bool("evenTerminalEnabled", False),
        "evenAiEnabled": _bool("evenAiEnabled", False),
        "evenAiToken": str(extra.get("evenAiToken") or "").strip(),
        "evenAiSystemPrompt": str(extra.get("evenAiSystemPrompt") or "").strip(),
        "evenAiRequestTimeoutMs": _int("evenAiRequestTimeoutMs", 60_000),
        "evenAiMaxBodyBytes": _int("evenAiMaxBodyBytes", 65_536),
        "evenAiDedupWindowMs": _int("evenAiDedupWindowMs", 500),
        "evenAiRoutingMode": str(extra.get("evenAiRoutingMode") or "active").strip(),
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
        "allowDebugUpload": settings["allowDebugUpload"],
        "debugUploadMaxZipBytes": settings["debugUploadMaxZipBytes"],
        "debugUploadCapturePreset": settings["debugUploadCapturePreset"],
        "debugBundleSaveDir": settings["debugBundleSaveDir"],
        "evenTerminalEnabled": settings["evenTerminalEnabled"],
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
        logger.warning(
            "[ocuclaw] platforms.ocuclaw.extra.relayToken is required — set "
            "it to the token entered in the OcuClaw app's relay server "
            "token field",
        )
        return False
    if settings["evenAiEnabled"] and not settings["evenAiToken"]:
        logger.warning(
            "[ocuclaw] platforms.ocuclaw.extra.evenAiToken is required when "
            "evenAiEnabled is true",
        )
        return False
    _warn_if_multiplex_authorization_unconfigured()
    return True


def _warn_if_multiplex_authorization_unconfigured() -> None:
    """Loud config check: multiplex without an OcuClaw auth env drops turns.

    Under gateway.multiplex_profiles the authorization adapter lookup fails
    closed for profile-stamped events (no per-profile ocuclaw adapter exists —
    this is ONE shared adapter), so secondary-profile turns are only
    authorized via the documented env allowlist lane. Warn, don't refuse:
    the default profile keeps working via authorization_is_upstream, and
    killing the whole platform over a secondary-lane gap would be worse
    than degraded service.
    """
    try:
        enabled, homes = load_profile_routing_snapshot()
    except Exception:  # noqa: BLE001 - validation must never crash boot
        return
    if not enabled or len(homes) <= 1:
        return
    allow_all = os.environ.get(OCUCLAW_ALLOW_ALL_USERS_ENV, "").strip().lower()
    allowed = os.environ.get(OCUCLAW_ALLOWED_USERS_ENV, "").strip()
    if allow_all in {"true", "1", "yes"} or allowed:
        return
    logger.warning(
        "[ocuclaw] gateway.multiplex_profiles is ON with %d served profiles "
        "but neither %s nor %s is set — glasses turns on SECONDARY profiles "
        "will be dropped as unauthorized (the profile-scoped authorization "
        "lookup cannot see this shared adapter's upstream trust). Set "
        "%s=true (the Node relay already token-authenticates every "
        "downstream client) or list ids in %s.",
        len(homes),
        OCUCLAW_ALLOW_ALL_USERS_ENV,
        OCUCLAW_ALLOWED_USERS_ENV,
        OCUCLAW_ALLOW_ALL_USERS_ENV,
        OCUCLAW_ALLOWED_USERS_ENV,
    )


def _is_connected(config: Any) -> bool:
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


def _warn_shadowed_yaml_secrets(
    _yaml_config: Dict[str, Any], platform_config: Dict[str, Any]
) -> None:
    """Warn when Hermes will replace legacy yaml secrets with env values."""
    extra = platform_config.get("extra")
    if not isinstance(extra, dict):
        return None
    shadowed = [
        f"platforms.ocuclaw.extra.{adapter_key} ({env_name})"
        for env_name, adapter_key in _SECRET_ENV_TO_ADAPTER_KEY.items()
        if adapter_key in extra and os.environ.get(env_name, "").strip()
    ]
    if shadowed:
        logger.warning(
            "[ocuclaw] environment secret(s) override yaml config at %s; "
            "secret values were not logged. Remove the yaml key(s) and manage "
            "the secret(s) with `hermes config set <OCUCLAW_* variable> ...`.",
            ", ".join(shadowed),
        )
    return None


def _hermes_version() -> str:
    try:
        from hermes_cli import __version__

        return __version__
    except Exception:  # noqa: BLE001
        return ""


def register(ctx: Any) -> None:
    global _PLUGIN_CONTEXT, _LIVEUI_REGISTER_TOOL
    _PLUGIN_CONTEXT = ctx
    version = _hermes_version()
    if not hermes_version_supported(version):
        raise RuntimeError(
            f"ocuclaw plugin supports hermes >={'.'.join(map(str, SUPPORTED_HERMES_MIN))},"
            f"<{'.'.join(map(str, SUPPORTED_HERMES_MAX_EXCLUSIVE))} — found "
            f"{version or 'unknown'}; refusing to register (plugin ABI is "
            "version-sensitive)"
        )
    register_platform = getattr(ctx, "register_platform", None)
    if not callable(register_platform):
        raise RuntimeError(
            "ocuclaw plugin requires ctx.register_platform (hermes "
            f"{version} exposes no platform registration surface)"
        )
    register_platform(
        name=PLATFORM_NAME,
        label=PLATFORM_LABEL,
        adapter_factory=_build_adapter,
        check_fn=check_ocuclaw_requirements,
        validate_config=validate_ocuclaw_config,
        is_connected=_is_connected,
        required_env=[OCUCLAW_RELAY_TOKEN_ENV],
        allowed_users_env=OCUCLAW_ALLOWED_USERS_ENV,
        allow_all_env=OCUCLAW_ALLOW_ALL_USERS_ENV,
        install_hint=(
            "OcuClaw glasses/phone client. Set OCUCLAW_RELAY_TOKEN, enable, "
            "then pair from the OcuClaw app. Full setup: "
            "extensions/ocuclaw-hermes/README.md"
        ),
        platform_hint=(
            "Replies are shown on a 576x288 glasses display. Keep them terse "
            "and display-friendly."
        ),
        env_enablement_fn=_env_enablement,
        apply_yaml_config_fn=_warn_shadowed_yaml_secrets,
    )
    # Turn-completion spine (W06): per-turn on_session_end backs the
    # agent_end host hook, terminal activity, and the tail commit. Hooks
    # register once at plugin load; the handler fans out to live adapters.
    global _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE
    register_hook = getattr(ctx, "register_hook", None)
    register_tool = getattr(ctx, "register_tool", None)
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
        _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = True
    else:
        _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = False
        logger.warning(
            "[ocuclaw] ctx.register_hook unavailable — turn completion "
            "(agent_end/terminal activity/tail commit) is degraded to the "
            "stale-turn janitor"
        )
    logger.info("[ocuclaw] platform registered (hermes %s)", version)


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

        def __init__(self, platform_config, platform) -> None:
            # Hermes 0.19 constructs secondary-profile adapters under a
            # context-local HERMES_HOME override (run.py:9437). OcuClaw owns
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
            self._multiplex_enabled = False
            self._served_profile_homes: Dict[str, Path] = {}
            self._refresh_profile_routing()
            # Sessions-plane SessionDB glue: the default reader is preserved
            # byte-for-byte outside multiplex; secondary readers are lazy.
            self._session_rpc = ProfileSessionRpc(
                default_db_path=default_state_db_path(),
                routing_provider=self._profile_routing_snapshot,
            )
            # W07 models/status/config read plane (gw.* lanes).
            self._gw_rpc = GwRpc(
                namespace=self._namespace,
                routing_provider=self._profile_routing_snapshot,
            )
            self._loop: Optional[asyncio.AbstractEventLoop] = None
            self._janitor_task: Optional[asyncio.Task] = None
            self._message_seq = 0
            self._stream_tail_lock = threading.RLock()
            self._stream_tail_closures: Dict[Tuple[str, str], Dict[str, Any]] = {}
            self._stream_tail_tasks: Dict[Tuple[str, str], asyncio.Task] = {}
            # Set under _stream_tail_lock during disconnect: refuses new
            # closure stashes so the shutdown drain can run to empty.
            self._stream_tail_closing = False
            self._thinking_lock = threading.RLock()
            self._thinking_text_by_run: Dict[str, str] = {}
            self._background_restore_tasks: set[asyncio.Task] = set()
            self._approval_lock = threading.RLock()
            self._approval_seq = 0
            self._approvals_by_id: Dict[str, Dict[str, Any]] = {}
            self._approval_order_by_session: Dict[str, List[str]] = {}
            self._approval_timers: Dict[str, Any] = {}
            self._approval_expiry_tasks: set[asyncio.Task] = set()
            self._approval_resolve_locks: Dict[str, asyncio.Lock] = {}
            self._approval_suppressed_responses: Dict[str, List[Dict[str, Any]]] = {}
            self._approval_drain_generation: Dict[str, int] = {}
            self._approval_drained_ids: Dict[str, float] = {}
            self._mirrored_native_entry_ids: Dict[str, set[int]] = {}
            self._approval_resolution_tombstones: Dict[str, List[Dict[str, Any]]] = {}
            self._approval_response_hook_available = (
                _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE
            )
            self._error_sweep_tasks: set[asyncio.Task] = set()
            # Per-connect boot receipt (runtime.ready); _on_child_exit sets
            # it so a dead child wakes the connect() wait immediately.
            self._runtime_ready_event: Optional[asyncio.Event] = None
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
            link = LinkProcess(
                settings["argv"],
                hello_ack_payload={
                    "hermesVersion": _hermes_version(),
                    "platform": PLATFORM_NAME,
                    "config": _child_runtime_config(
                        {**settings, "stateDir": state_dir}
                    ),
                },
                handshake_timeout_s=settings["handshakeTimeoutS"],
                terminate_grace_s=settings["terminateGraceS"],
                env=default_child_env(
                    handshake_timeout_s=settings["handshakeTimeoutS"],
                    debug_stderr=settings["linkDebugStderr"],
                ),
                log=logger,
                on_exit=self._on_child_exit,
            )
            # Child-initiated RPC lanes must be live before the child can
            # speak (the bridge may issue db.*/dispatch requests right after
            # the handshake completes).
            for method, handler in self._session_rpc.handlers().items():
                link.register_request_handler(method, handler)
            for method, handler in self._gw_rpc.handlers().items():
                link.register_request_handler(method, handler)
            link.register_request_handler(
                FOREIGN_COPY_METHOD, self.handle_foreign_copy
            )
            link.register_request_handler(
                APPROVAL_RESOLVE_METHOD, self.handle_approval_resolve
            )
            link.register_request_handler(
                SESSION_ABORT_METHOD, self.handle_sessions_abort
            )
            link.register_request_handler(
                SESSION_STEER_METHOD, self.handle_sessions_steer
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
            with self._stream_tail_lock:
                self._stream_tail_closing = False
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
            link = self._link
            self._link = None
            with self._thinking_lock:
                self._thinking_text_by_run.clear()
            if link is not None:
                code = await link.terminate()
                logger.info("[ocuclaw] runtime child stopped (code=%s)", code)
            self._mark_disconnected()

        # -- outbound transport (StreamConsumer + gateway sends) -------------

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            text = strip_stream_cursor(content)
            message_id = self._next_message_id()
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
                self._emit_event("message", message_commit_event(slash_head, text))
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
            if record is None:
                # No dispatch record (cron deliver='origin', foreign-origin
                # turns): the main-lane message consumer reads runId
                # null-tolerantly.
                self._emit_event("message", uncorrelated_message_event(identity, text))
                return SendResult(success=True, message_id=message_id)
            if ended_run_commit:
                self._emit_event("message", message_commit_event(record, text))
                return SendResult(success=True, message_id=message_id)
            if uncommitted_previous is not None:
                # Defensive: a fresh send while a message is open commits the
                # previous one (segment finalize normally did this already).
                self._emit_event(
                    "message", message_commit_event(record, uncommitted_previous)
                )
            if self._ledger.take_lifecycle_start(record):
                self._emit_event("activity", lifecycle_start_activity(record))
            self._emit_event("streaming", streaming_event(record, text))
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
            version = parse_version(_hermes_version())
            if version is None or version < (0, 19, 0):
                # This guard self-retires when H2 flips Hermes to >=0.19.
                return SendResult(
                    success=False,
                    error="approval mirroring requires hermes >= 0.19",
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
            text = content if finalize else strip_stream_cursor(content)
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
                self._emit_event("message", message_commit_event(record, text))
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
                        )
                    )
            else:
                self._emit_event("streaming", streaming_event(record, text))
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
            head, merged, promoted = self._ledger.complete_head_if_run(
                session_key, run_id
            )
            if head is None:
                # on_session_end or slash completion already closed this run;
                # never let a late platform callback consume its successor.
                return
            if (
                head.current_message_id is not None
                and not head.current_committed
                and head.current_text
            ):
                head.current_committed = True
                self._emit_event(
                    "message", message_commit_event(head, head.current_text)
                )
            outcome_value = str(getattr(outcome, "value", "") or "").lower()
            completed = outcome_value == "success"
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

        # -- W09 approvals + live-session control (ADR-0008) -----------------

        def _approval_timeout_seconds(self) -> int:
            try:
                from tools.approval import _get_approval_timeout

                # Hermes owns the effective default and operator override.
                # It was 60 seconds in 0.19.0 and became 300 in 0.19.1;
                # using its accessor also preserves each host's malformed-
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

        def _turn_activity_context(
            self, kwargs: Dict[str, Any], hook_label: str
        ) -> Optional[Tuple[str, Any]]:
            platform = str(kwargs.get("platform") or "").strip()
            if platform and platform != PLATFORM_NAME:
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

        @classmethod
        def _extract_assistant_reasoning(cls, assistant_message: Any) -> Optional[str]:
            raw = cls._read_reasoning_field(assistant_message, "reasoning")
            if isinstance(raw, str):
                text = raw.strip()
            elif isinstance(raw, list):
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
                text = "\n".join(parts).strip()
            else:
                text = ""
            if not text:
                return None
            if len(text) > THINKING_FRAME_MAX_CHARS:
                return cls._truncate_thinking_delta(text)
            return text

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

        def _forget_thinking_run(self, run_id: Any) -> None:
            key = str(run_id or "").strip()
            if not key:
                return
            with self._thinking_lock:
                self._thinking_text_by_run.pop(key, None)

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
            reasoning = self._extract_assistant_reasoning(kwargs.get("assistant_message"))
            if not reasoning:
                return
            text = self._cumulative_thinking_text(record.run_id, reasoning)
            activity = {
                "state": "thinking",
                "origin": "thinking",
                "phase": "update",
                "runId": record.run_id,
                "sessionKey": record.public_key,
                "summary": reasoning,
                "thinking": reasoning,
                "thinkingSummarySource": "detail",
            }
            thinking = {
                "phase": "update",
                "runId": record.run_id,
                "sessionKey": record.public_key,
                "text": text,
                "delta": reasoning,
                "summary": reasoning,
                "thinkingSummarySource": "detail",
                "source": "hermes.post_api_request",
            }
            self._emit_event("activity", activity)
            self._emit_event("thinking", thinking)

        def _tool_activity_common(
            self,
            kwargs: Dict[str, Any],
            tool_name: str,
            record: Any,
        ) -> Dict[str, Any]:
            payload: Dict[str, Any] = {
                "state": "thinking",
                "origin": "tool",
                "phase": "start",
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
            redacted = self._redact_tool_activity_urls(redacted)
            if len(redacted) > TOOL_ACTIVITY_MAX_ARG_STRING:
                return redacted[:TOOL_ACTIVITY_MAX_ARG_STRING] + "...[truncated]"
            return redacted

        @classmethod
        def _redact_tool_activity_urls(cls, value: str) -> str:
            def replace(match: Any) -> str:
                raw = str(match.group(0) or "")
                trailing = ""
                while raw and raw[-1] in ".,);":
                    trailing = raw[-1] + trailing
                    raw = raw[:-1]
                try:
                    parts = urlsplit(raw)
                except Exception:  # noqa: BLE001
                    return raw + trailing
                netloc = parts.netloc
                if "@" in netloc:
                    netloc = "[redacted]@" + netloc.rsplit("@", 1)[1]
                path = cls._redact_tool_activity_url_path(parts.path)
                query = cls._redact_tool_activity_url_query(parts.query)
                fragment = parts.fragment
                if fragment:
                    if "=" in fragment or "&" in fragment:
                        fragment = cls._redact_tool_activity_url_query(fragment)
                    elif cls._tool_activity_url_key_is_secret(fragment):
                        fragment = "[redacted]"
                return urlunsplit(
                    (parts.scheme, netloc, path, query, fragment)
                ) + trailing

            return TOOL_ACTIVITY_URL_RE.sub(replace, value)

        @classmethod
        def _redact_tool_activity_url_query(cls, query: str) -> str:
            if not query:
                return ""
            redacted = []
            for part in query.split("&"):
                if not part:
                    redacted.append(part)
                    continue
                key, separator, value = part.partition("=")
                if cls._tool_activity_url_key_is_secret(key):
                    redacted.append(f"{key}{separator}[redacted]")
                else:
                    redacted.append(part)
            return "&".join(redacted)

        @classmethod
        def _redact_tool_activity_url_path(cls, path: str) -> str:
            if not path:
                return ""
            parts = []
            for segment in path.split("/"):
                if cls._tool_activity_url_path_segment_is_secret(segment):
                    parts.append("[redacted]")
                else:
                    parts.append(segment)
            return "/".join(parts)

        @classmethod
        def _tool_activity_url_path_segment_is_secret(cls, segment: str) -> bool:
            marker_key = "".join(
                ch for ch in str(segment or "").lower() if ch.isalnum()
            )
            if not marker_key:
                return False
            if cls._tool_activity_url_key_is_secret(marker_key):
                return True
            has_alpha = any(ch.isalpha() for ch in marker_key)
            has_digit = any(ch.isdigit() for ch in marker_key)
            if len(marker_key) >= 9 and segment[:1].isalpha() and has_digit:
                return True
            return len(marker_key) >= 16 and has_alpha and has_digit

        @staticmethod
        def _tool_activity_url_key_is_secret(key: str) -> bool:
            marker_key = "".join(ch for ch in str(key or "").lower() if ch.isalnum())
            return (
                marker_key in TOOL_ACTIVITY_URL_SECRET_KEY_EXACT
                or any(
                    marker in marker_key
                    for marker in TOOL_ACTIVITY_URL_SECRET_KEY_MARKERS
                )
            )

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

        def handle_pre_tool_call(self, kwargs: Dict[str, Any]) -> None:
            context = self._tool_activity_context(kwargs)
            if context is None:
                return
            _, tool_name, record = context
            payload = self._tool_activity_common(kwargs, tool_name, record)
            args = kwargs.get("args")
            if isinstance(args, dict):
                payload["args"] = self._sanitize_tool_activity_args(args)
            self._emit_event("activity", payload)

        def handle_post_tool_call(self, kwargs: Dict[str, Any]) -> None:
            context = self._tool_activity_context(kwargs)
            if context is None:
                return
            _, tool_name, record = context
            payload = self._tool_activity_common(kwargs, tool_name, record)
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

        def handle_liveui_tool_call(self, args: Dict[str, Any]) -> str:
            try:
                from gateway.session_context import get_session_env
            except Exception:  # noqa: BLE001
                get_session_env = lambda _name, default="": default
            session_key = str(get_session_env("HERMES_SESSION_KEY", "") or "").strip()
            if not session_key:
                return json.dumps(
                    {"error": "render_glasses_ui requires HERMES_SESSION_KEY"},
                    ensure_ascii=False,
                )
            identity = parse_ocuclaw_session_key(session_key)
            if identity is None:
                return json.dumps(
                    {"error": "render_glasses_ui requires an OcuClaw session"},
                    ensure_ascii=False,
                )
            call_id = f"liveui-{uuid.uuid4().hex}"
            try:
                result = self._request_link_threadsafe(
                    LIVEUI_RENDER_METHOD,
                    {
                        "callId": call_id,
                        "sessionKey": session_key,
                        "args": args if isinstance(args, dict) else {},
                    },
                    timeout_s=_liveui_render_link_timeout_s(self._settings),
                    abort_on_interrupt={
                        "method": LIVEUI_ABORT_METHOD,
                        "params": {
                            "callId": call_id,
                            "sessionKey": session_key,
                            "reason": "interrupted",
                        },
                    },
                )
            except InterruptedError:
                return json.dumps({"error": "render_glasses_ui interrupted"})
            except Exception as exc:  # noqa: BLE001
                return json.dumps({"error": str(exc)}, ensure_ascii=False)
            if isinstance(result, dict) and "result" in result:
                return json.dumps(result["result"], ensure_ascii=False)
            return json.dumps(result if isinstance(result, dict) else {"result": result}, ensure_ascii=False)

        def handle_pre_llm_call(self, _kwargs: Dict[str, Any]) -> Optional[str]:
            try:
                from gateway.session_context import get_session_env
            except Exception:  # noqa: BLE001
                return None
            platform = str((_kwargs or {}).get("platform") or "").strip()
            if platform and platform != PLATFORM_NAME:
                return None
            session_key = str(get_session_env("HERMES_SESSION_KEY", "") or "").strip()
            if not session_key:
                return None
            identity = parse_ocuclaw_session_key(session_key)
            if identity is None:
                return None
            try:
                result = self._request_link_threadsafe(
                    LIVEUI_PROMPT_METHOD,
                    {"sessionKey": session_key},
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

        # -- turn completion (hermes on_session_end, sync, worker thread) ----

        def handle_session_end(self, kwargs: Dict[str, Any]) -> None:
            if str(kwargs.get("platform") or "") != PLATFORM_NAME:
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
                self._emit_event(
                    "message", message_commit_event(head, head.current_text)
                )
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
            self._message_seq += 1
            return f"ocuclaw-{self._message_seq}"

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
                self._emit_event(
                    "message", message_commit_event(head, head.current_text)
                )
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
                )
            )
            return True

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
            from gateway.session import SessionSource

            source = SessionSource(
                platform=self.platform,
                chat_id=str(chat_id),
                chat_name="OcuClaw Glasses",
                chat_type=OCUCLAW_CHAT_TYPE_SEGMENT,
                user_id="ocuclaw-wearer",
                user_name="OcuClaw",
                profile=profile,
            )
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
