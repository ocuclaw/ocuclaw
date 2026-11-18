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
from collections import deque
import concurrent.futures
import contextlib
import copy
from contextvars import ContextVar, copy_context
import importlib.util
import inspect
import json
import logging
import math
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Set, Tuple
from urllib.parse import urlsplit, urlunsplit

from .cli import register_cli_commands
from . import dev_bot_desktop_a11y, uninstall_gate
from .config_writer import replace_config
from .delegation_routes import (
    DELEGATE_TOOL_NAME,
    BackgroundDelegations,
    delegation_from_args,
    delegation_from_result,
    is_helper_result_turn,
)
from .run_signals import (
    COMPACTION_AUX_TASK,
    RUN_SIGNAL_EVENT,
    RunSignalSpans,
    model_call_iteration,
    model_call_request,
)
from .card_images import CARD_IMAGE_TOOLS, CardImageError, CardImageModels, card_tool_result
from .card_notes import ASK_TOOL_NAME as CARD_ASK_TOOL_NAME, with_card_notes, with_card_tools
from .session_status import SessionStatusObserver
from .session_title_hold import SessionTitleHold, turn_user_text
from .session_writer import SharedSessionWriter, own_delete_in_progress
from .native_readers import (
    approval_reader,
    hidden_display_turn,
    pending_clarify_entry,
    viewer_turn_running,
)
from .control_link import (
    HERMES_BUNDLE_DEFAULT_WS_BIND,
    HERMES_BUNDLE_DEFAULT_WS_PORT,
    LINK_HANDSHAKE_TIMEOUT_S,
    LINK_TERMINATE_GRACE_S,
    RPC_METHOD_NOT_FOUND_CODE,
    LinkError,
    LinkOverloadedError,
    LinkProcess,
    LinkRpcError,
    default_child_env,
    resolve_runtime_argv,
)
from .completed_reply import CompletedReplies
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
    STATE_PENDING,
    DispatchLedger,
    agent_end_hook_frame,
    is_cancelling_slash,
    is_platform_update_command,
    lifecycle_start_activity,
    lifecycle_terminal_activity,
    message_commit_event,
    message_edit_event,
    message_retag_event,
    parse_ocuclaw_session_key,
    plugin_message_event,
    normalize_session_reset_command,
    status_activity,
    streaming_event,
    strip_stream_cursor,
    uncorrelated_message_event,
    validate_prompt_metadata,
    viewer_prompt_message_event,
)
from .first_run import (
    FAILED_TURN_REPLY_RUN_ERROR_CODE,
    PHONE_CANDIDATE_RUN_ERROR_CODES,
    PhoneTurnCandidateGate,
    REPLY_DELIVERY_ERRORED_RUN_REASONS,
    REPLY_DELIVERY_OBSERVE_METHOD,
    REPLY_DELIVERY_OBSERVE_TIMEOUT_SECONDS,
    REPLY_DELIVERY_REPORT_METHOD,
    REPLY_DELIVERY_UNCONFIRMED,
    REPLY_DELIVERY_UNSUPPORTED,
    REPLY_DELIVERY_WAIT_SECONDS,
    REPLY_EVIDENCE_CLIENT_SDK_RECEIPT,
    REPLY_EVIDENCE_VALUES,
    REPLY_EVIDENCE_WEARER_CONFIRMED,
    WELCOME_SURFACE,
    arm_first_run_proof_from_candidate,
    inspect_attempt,
    is_failed_turn_reply,
    phone_turn_run_error_code,
    record_phone_turn_candidate,
    record_reply_delivery,
    record_welcome_outcome,
    validate_reply_delivery_report,
    wait_for_first_run_terminal,
    wait_for_phone_origin,
    wait_for_phone_turn_candidate,
    wait_for_reply_delivery,
    welcome_surface,
)
from .models_rpc import (
    GwRpc,
    load_profile_routing_snapshot,
    namespace_for_profile,
    profile_for_namespace,
)
from .input_prediction import (
    INPUT_PREDICTION_AUXILIARY_TASK,
    InputPredictionRpc,
    hermes_reply_model_facts,
)
from .approval_explain import (
    APPROVAL_EXPLAIN_SETTING_METHOD,
    APPROVAL_LLM_COMPLETE_METHOD,
    PURPOSE_MAX_CHARS,
    ApprovalContextStore,
    ApprovalExplainSetting,
    approval_llm_complete,
    clean_line,
    make_llm_request_middleware,
    make_tool_request_middleware,
    message_text,
    user_message_context,
)
from .card_review import CARD_REVIEW_LLM_COMPLETE_METHOD, CARD_REVIEW_LLM_CANCEL_METHOD, CardReviewCalls
from .card_frame import CARD_FRAME_LLM_COMPLETE_METHOD, CARD_FRAME_LLM_CANCEL_METHOD, card_frame_llm_complete
from .card_icon import CARD_ICON_LLM_COMPLETE_METHOD, CARD_ICON_LLM_CANCEL_METHOD, card_icon_llm_complete
from .card_model import ScopedCardModels
from .card_mcp import (
    PROGRAM_CARD_MCP_ALLOW_METHOD,
    PROGRAM_CARD_MCP_CALL_METHOD,
    PROGRAM_CARD_MCP_LIST_METHOD,
    program_card_mcp_allow,
    program_card_mcp_call,
    program_card_mcp_list,
    tool_call_mcp,
)
from .task_uses_hook import ready_link_request, task_uses_block
from .task_uses_hook import unchecked_directive as task_uses_unchecked_directive
from .task_mcp_pause import TASK_MCP_PAUSE
from . import task_run_prompt
from . import board_tools
from . import hook_context
from . import task_alert_state
from . import task_page_watch
from .task_schedule_management import is_test_job
from . import human_input_waiting
from . import bot_screen
from . import bot_screen_control
from . import claude_reasoning_default
from . import task_away
from .pairing_completion import record_pairing_completion
from .sender_approval import record_wearer_sender_approval
from .home_channel import HOME_CHANNEL_ENV as OCUCLAW_HOME_CHANNEL_ENV
from .home_channel import set_default_home_channel
from .board_moments import ACK_METHOD as BOARD_MOMENT_ACK_METHOD
from .board_moments import PUSH_TIMEOUT_SECONDS as BOARD_MOMENT_PUSH_TIMEOUT_S
from .board_moments import MomentPump
from .board_moments import authority_id as board_moment_authority_id
from .task_push import PUSH_TIMEOUT_SECONDS as TASK_PUSH_TIMEOUT_S
from .task_push import TaskPushBridge
from . import task_delivery
from .starters import register_starters
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
    build_serving_body,
    fingerprint_home,
    read_app_presence,
    read_first_run_proof,
    read_gateway_state,
    resolve_receipt_home,
    write_app_presence,
    write_serving,
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
    tail_within_link_budget,
)
from .stt_rpc import (
    PRE_TRANSCRIPTION_HOOK_NAME,
    SttRpc,
    pre_transcription_hook,
)
from .tts_rpc import TtsRpc
from . import aux_tasks, aux_usage, compaction_ledger, delegation_handoffs, desktop_credentials, even_ai_route, serve
from .agent_router import AgentRouteRpc, auto_agent_requested as _auto_agent_requested
from . import optional_setup as _optional_setup
from . import secret_access
from . import health as health_collect
from .health import (
    OCUCLAW_WEARER_USER_ID,
    continue_here_configured,
    effective_platform_extra,
    env_seed_reaches_extra,
    node_install_available as _node_install_available,
    platform_env_seed,
    shared_chats_enabled as _shared_chats_enabled,
)
from .desktop_pairing import (
    THEME_REQUEST_CONFIG_KEY as DESKTOP_THEME_CONFIG_KEY,
    desktop_convergence,
    desktop_convergence_message,
    plugin_owned as desktop_plugin_owned,
    plugin_path as desktop_plugin_path,
    read_desktop_theme_request,
    reconcile_pairing_plugin,
)
from .setup_bootstrap import reconcile_setup_bundle, retire_setup_bundle
from .setup_command_skill import SKILL_RECONCILE_OK, reconcile_setup_command_skill
from .setup_hint import (
    awaiting_first_reply,
    push_hint_edge,
    read_hint_phase,
)
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
_IS_WINDOWS = os.name == "nt"

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
# #3359: the TypeSafe key the wearer pasted on the phone, or typed into
# `hermes ocuclaw optional-setup save typesafe`. It rides the same `.env`
# contract as the other optional secrets, and is NOT the deployment-time
# `TYPESAFE_API_KEY` below, which it outranks. Saving it arms nothing: LiveUI
# Jev, Jev in program cards and the Bot Screen's Jev mode each wait for their own switch.
OCUCLAW_TYPESAFE_API_KEY_ENV = "OCUCLAW_TYPESAFE_API_KEY"
_SECRET_ENV_TO_ADAPTER_KEY = {
    OCUCLAW_RELAY_TOKEN_ENV: "relayToken",
    OCUCLAW_SONIOX_API_KEY_ENV: "sonioxApiKey",
    OCUCLAW_EVEN_AI_TOKEN_ENV: "evenAiToken",
    OCUCLAW_TYPESAFE_API_KEY_ENV: "typesafeApiKey",
}
# Optional Hermes-native allowlist names declared at platform registration.
# Ordinary OcuClaw turns use the stronger relay-token gate and retain the live
# adapter as transport provenance, so these are not required for multiplexing.
OCUCLAW_ALLOWED_USERS_ENV = "OCUCLAW_ALLOWED_USERS"
OCUCLAW_ALLOW_ALL_USERS_ENV = "OCUCLAW_ALLOW_ALL_USERS"


def _with_wearer_grant(platform_config: Any) -> Any:
    """``platform_config`` with the wearer id in its in-memory ``allowed_users``.

    Hermes 0.22 admits every ordinary inbound message through durable native
    admission (``gateway/session_envelope.py`` ``_validate_native``), which
    authorizes without adapter delegation, so ``authorization_is_upstream`` no
    longer counts there and every glasses turn is ``permission_denied``. With
    no env allowlist set, Hermes falls back to the live adapter's
    ``config.extra["allowed_users"]`` (``authz_mixin``
    ``_adapter_extra_allowlist_authorizes``). Naming the one wearer id there
    keeps the relay credential the grant: only this adapter produces ocuclaw
    events, and only after the Node relay checked ``relayToken``.

    In memory only — nothing reaches ``.env`` or ``config.yaml`` (SPEC #2939),
    and the copy keeps it off the runner's own config. An operator-set list is
    left alone. On 0.21.x, 0.22.0 and 0.22.2 the delegated grant answers first
    and this list is never read; 0.22.3 native admission honours
    ``authorization_is_upstream`` again (upstream #139199), so only 0.22.1
    needs it."""
    extra = getattr(platform_config, "extra", None)
    if not isinstance(extra, dict) or extra.get("allowed_users"):
        return platform_config
    granted = copy.copy(platform_config)
    granted.extra = {**extra, "allowed_users": [OCUCLAW_WEARER_USER_ID]}
    return granted


def _sender_gate_recorder(
    home: Optional[Path], fingerprint: Optional[str]
) -> Callable[[], None]:
    """Record the sender allowlists this gateway reads, for doctor.

    An env allowlist without the wearer makes Hermes 0.22 refuse every
    glasses message. Doctor reads ``.env``, but it runs in its own process and
    cannot see a list exported where the gateway starts, so it stayed silent.
    This writes what the gateway itself reads into a profile receipt
    (``profiles_report.gateway_sender_gate``). It rides the presence cadence
    and writes only when the view changes. It only observes: who is admitted
    does not change. A failure is logged, never raised.
    """
    last: List[Any] = []

    def record() -> None:
        if home is None:
            return
        try:
            from .profiles_report import gateway_sender_gate
            from .receipts import (
                build_gateway_sender_gate_body,
                write_gateway_sender_gate,
            )

            view = gateway_sender_gate()
            if last and last[0] == view:
                return
            multiplexed, lists = view
            write_gateway_sender_gate(
                build_gateway_sender_gate_body(
                    profile_fingerprint=fingerprint,
                    multiplexed=multiplexed,
                    sender_allowlists=lists,
                ),
                home=home,
            )
            last[:] = [view]
        except Exception as exc:  # noqa: BLE001 - a diagnostic never breaks a turn
            logger.debug("[ocuclaw] sender-gate receipt write failed: %s", exc)

    return record


APPROVAL_WARNING_LINES_MAX = 5


def _approval_warning_lines(description: Any) -> List[str]:
    """Split Hermes' approval description into its risk labels.

    Hermes joins every DANGEROUS_PATTERNS / Tirith hit with "; "
    (tools/approval.py combined_desc). The glasses card maps each label to
    plain words; ``ask`` keeps the joined text for older apps. Hermes has
    already redacted secrets from this text for display.
    """
    lines: List[str] = []
    for part in str(description or "").split("; "):
        label = part.strip()
        if label:
            lines.append(label)
        if len(lines) >= APPROVAL_WARNING_LINES_MAX:
            break
    return lines


def _approval_warning_fields(description: Any) -> Dict[str, Any]:
    """Optional ``warningLines`` wire field; omitted when there is no label."""
    lines = _approval_warning_lines(description)
    return {"warningLines": lines} if lines else {}


def _approval_request_view_fields(entry: Mapping[str, Any]) -> Dict[str, Any]:
    """#5152: a computer_use approval's ``botScreen`` facts, for its card's
    picture; Hermes's description is no risk label there. Any other approval
    keeps its ``warningLines``."""
    view = entry.get("botScreen")
    if isinstance(view, dict):
        return {"botScreen": dict(view)}
    return _approval_warning_fields(entry.get("description"))


def _swallow_task_exception(task: "asyncio.Future[Any]") -> None:
    """Retrieve a fire-and-forget RPC's outcome so asyncio never logs it."""
    if not task.cancelled():
        exc = task.exception()
        if exc is not None:
            logger.debug("[ocuclaw] closing frame RPC finished with %s", exc)


def _called_from_plugin_messages() -> bool:
    """True when the adapter method that called this was called by Hermes' plugin messages.

    Call it before that method's first await: a coroutine's caller frame is the
    code that awaited it only until it first suspends.
    """
    frame = inspect.currentframe()
    # 0 = here, 1 = send(), 2 = its caller; one more step allows for a wrapper.
    for depth in range(4):
        if frame is None:
            return False
        if depth >= 2 and frame.f_globals.get("__name__") == PLUGIN_MESSAGES_MODULE:
            return True
        frame = frame.f_back
    return False


def _is_hermes_home_channel_onboarding_notice(text: str) -> bool:
    """Keep Hermes's platform setup nudge out of OcuClaw conversations."""
    normalized = str(text or "").strip()
    return (
        normalized.startswith("📬 No home channel is set for Ocuclaw.")
        and "Type /sethome to make this chat your home channel" in normalized
    )


_NONCONVERSATIONAL_METADATA_KEYS = frozenset({"non_conversational", "non_conversational_history"})
# Gateways that predate metadata["non_conversational"] send the background
# review's status line bare (Hermes's Discord adapter keeps the same bridge).
_NONCONVERSATIONAL_STATUS_PATTERNS = (
    re.compile(r"^\s*💾\s*Self-improvement review:\s+\S[\s\S]*$", re.IGNORECASE),
    re.compile(
        r"^\s*💾\s+Skill\s+['\"].+?['\"]\s+(?:created|updated|improved|patched)\.?\s*$",
        re.IGNORECASE,
    ),
)


def _is_hermes_nonconversational_status(text: str, metadata: Optional[dict] = None) -> bool:
    """A Hermes status line (the post-turn self-improvement review) is not chat.

    Hermes sends it after the turn has settled. On the single glasses
    conversation it landed in the finished reply, up to a minute later, and
    moved the page the wearer was reading (sim audit 2026-11-15).
    """
    if isinstance(metadata, dict) and any(metadata.get(key) for key in _NONCONVERSATIONAL_METADATA_KEYS):
        return True
    normalized = str(text or "")
    return any(pattern.match(normalized) for pattern in _NONCONVERSATIONAL_STATUS_PATTERNS)


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
    # H11 (#3348). A NON-RETRYABLE provider failure (a 401 is the signature
    # case) escapes before finalize_turn, so neither on_session_end nor
    # post_api_request ever runs and the D9 head is stranded until the stale
    # backstop. `api_request_error` is the only engine signal on that path,
    # and it exists in every supported engine.
    "api_request_error",
    # Observe the authoritative final before Hermes' gateway adds its
    # reasoning display wrapper. Does not transform the agent's output.
    "post_llm_call",
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
# Ties a Hermes approval to its tool call (0.21.5), so the card can carry the
# call's `purpose` (approval_explain.py). Registered only where the host's
# hook vocabulary has it.
APPROVAL_REQUEST_HOOK_NAME = "pre_approval_request"
# Run signals (`runSignal`, PROTOCOL.md): the status lens's model-call,
# subagent and compaction spans. `pre_api_request` and the subagent pair are
# in the 0.21.1 floor's vocabulary; the auxiliary pair arrived in 0.21.5
# (v2026.9.24). All are still probed, and a pair is wired whole or not at all,
# so no start is ever registered without the hook that ends it. Ends and
# retry waits for model calls ride the always-registered post_api_request and
# api_request_error.
PRE_API_REQUEST_HOOK_NAME = "pre_api_request"
SUBAGENT_HOOK_NAMES = ("subagent_start", "subagent_stop")
AUXILIARY_CALL_HOOK_NAMES = ("pre_auxiliary_call", "post_auxiliary_call")
RUN_SIGNAL_HOOK_NAMES = (
    (PRE_API_REQUEST_HOOK_NAME,) + SUBAGENT_HOOK_NAMES + AUXILIARY_CALL_HOOK_NAMES
)
# Waiting on you (#4979, human_input_waiting.py): prompts that block an agent
# on another surface. Both or neither, 0.21.6+.
HUMAN_INPUT_HOOK_NAMES = human_input_waiting.HOOK_NAMES
# Exact compaction counts (compaction_ledger.py) and the `sessionCompacted`
# push (PROTOCOL.md). 0.22.3+; 0.22.0-0.22.2 lack it.
POST_COMPACTION_HOOK_NAME = compaction_ledger.POST_COMPACTION_HOOK_NAME
SESSION_COMPACTED_EVENT_NAME = "sessionCompacted"
# Chats deleted or archived on another surface leave the glasses picker at
# once (`sessionsGone`, PROTOCOL.md). 0.22.3+; 0.22.0-0.22.2 lack it.
SESSION_DELETE_HOOK_NAME = "on_session_delete"
SESSIONS_GONE_EVENT_NAME = "sessionsGone"
CONDITIONAL_HOOK_NAMES = (
    (INTERIM_HOOK_NAME,)
    + STREAM_HOOK_NAMES
    + (PRE_TRANSCRIPTION_HOOK_NAME, APPROVAL_REQUEST_HOOK_NAME)
    + RUN_SIGNAL_HOOK_NAMES
    + HUMAN_INPUT_HOOK_NAMES
    + (POST_COMPACTION_HOOK_NAME,)
    + (SESSION_DELETE_HOOK_NAME,)
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
FEATURE_TOKEN_HUMAN_INPUT_WAITING = human_input_waiting.FEATURE_TOKEN
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
# Set once by register(): the auxiliary-call pair that carries the compaction
# run signal is wired (0.21.5+). Not a feature token either: the lens draws
# whatever `runSignal` frames arrive and never branches on what could. It is
# reported in `_setup_status()` so a compaction row that never lights up is
# explainable from one receipt.
AUXILIARY_CALL_HOOKS_AVAILABLE = False
# Set once by register(): post_compaction is wired (0.22.3+). Not a feature
# token: the count rides compactionInfo's own `live` flag, which the phone
# reads per snapshot.
POST_COMPACTION_HOOK_AVAILABLE = False
# Set once by register(): on_session_delete is wired (0.22.3+). Not a feature
# token: the client only sees the picker refresh, and never branches on it.
SESSION_DELETE_HOOK_AVAILABLE = False
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


# Silent input (#2829): set once at register() when the host accepted the
# plugin-owned auxiliary task; the prediction lane passes `task=` only then.
_INPUT_PREDICTION_TASK_REGISTERED = False


async def _approval_explainer_complete(params: Any) -> Dict[str, Any]:
    """The shared explainer's model call (`approval.llm.complete`), on the
    "OcuClaw approval explainer" task when the host registered it (#5046).
    Every approval the child explains comes through here, whichever surface
    asked for it."""
    return await approval_llm_complete(
        getattr(_PLUGIN_CONTEXT, "llm", None),
        params,
        task=aux_tasks.task_for(aux_tasks.APPROVAL_EXPLAIN_TASK),
    )


_CARD_REVIEW_CALLS = CardReviewCalls()
_TASK_PROPOSAL_CALLS = CardReviewCalls()


async def _task_proposal_complete(params: Any) -> Dict[str, Any]:
    """Inert Task setup proposal, using the host model without tools or a conversation."""
    return await _TASK_PROPOSAL_CALLS.complete(
        getattr(_PLUGIN_CONTEXT, "llm", None), params,
        task=aux_tasks.task_for(aux_tasks.TASK_PROPOSAL_TASK),
        purpose="ocuclaw.task.proposal",
    )


_AGENT_DRAFT_CALLS = CardReviewCalls()


async def _agent_draft_complete(params: Any) -> Dict[str, Any]:
    """Inert draft of a new agent's name and personality ("New agent → Describe it"),
    on the host's main model without tools, a conversation or an auxiliary task."""
    return await _AGENT_DRAFT_CALLS.complete(
        getattr(_PLUGIN_CONTEXT, "llm", None), params,
        purpose="ocuclaw.agent.draft",
    )


async def _card_review_complete(params: Any) -> Dict[str, Any]:
    """One stage of the phone's AI review of a saved card
    (`program_card.review.llm.complete`), on the "OcuClaw card review" task
    when the host registered it."""
    return await _CARD_REVIEW_CALLS.complete(
        getattr(_PLUGIN_CONTEXT, "llm", None),
        params,
        task=aux_tasks.task_for(aux_tasks.CARD_REVIEW_TASK),
    )


_CARD_FRAME_CALLS = CardReviewCalls()


async def _card_frame_complete(params: Any) -> Dict[str, Any]:
    """A program card's frame step: one art-script reply
    (`program_card.frame.llm.complete`), on the "OcuClaw card frame art" task
    for the call's effort (Quick, Balanced or Detailed) when the host
    registered it, no tools."""
    return await card_frame_llm_complete(
        _CARD_FRAME_CALLS,
        getattr(_PLUGIN_CONTEXT, "llm", None),
        params,
        task=aux_tasks.card_frame_task(params.get("reasoning") if isinstance(params, Mapping) else None),
    )


_CARD_ICON_CALLS = CardReviewCalls()


async def _card_icon_complete(params: Any) -> Dict[str, Any]:
    """A saved card's Library icon for a wearer without Jev: one word
    (`program_card.icon.llm.complete`), on the "OcuClaw card icon" task when
    the host registered it, no tools."""
    return await card_icon_llm_complete(
        _CARD_ICON_CALLS,
        getattr(_PLUGIN_CONTEXT, "llm", None),
        params,
        task=aux_tasks.task_for(aux_tasks.CARD_ICON_TASK),
    )


async def _card_mcp_call(params: Any) -> Dict[str, Any]:
    """One MCP read for a program card (`program_card.mcp.call`), through this
    plugin's documented ``ctx.call_mcp`` (card_mcp.py)."""
    return await program_card_mcp_call(_PLUGIN_CONTEXT, params)


def _input_prediction_policy() -> Dict[str, Any]:
    """``plugins.entries.ocuclaw.llm`` override trust gate as written in
    config.yaml — the SAME keys PluginLlm enforces (allow_model_override /
    allowed_models), read so capabilities can list the authorized choices.
    Enforcement stays host-side (PluginLlmTrustError → policy-denied)."""
    config, readable = _setup_raw_config()
    if not readable or not isinstance(config, dict):
        return {}
    node: Any = config
    for key in ("plugins", "entries", "ocuclaw", "llm"):
        if not isinstance(node, dict):
            return {}
        node = node.get(key)
    return node if isinstance(node, dict) else {}


def _input_prediction_allow_model(model_id: str, _ns: str, home: Any) -> Dict[str, Any]:
    """#3359 round 3: the config write behind ``input.prediction.model.allow``.
    Always the plugin's own resolved Hermes home, like the optional-setup saves
    (``optional_setup._home``); a different profile's home is refused there."""
    from .optional_setup import allow_prediction_model

    return allow_prediction_model(model_id, profile_home=home)


def _input_prediction_route_config() -> Dict[str, Any]:
    """The raw config the prediction route is derived from (#2836).

    Called inside the requested profile's runtime scope, where
    ``read_raw_config`` follows the home override to that profile's
    config.yaml; the pure ``effective_prediction_route`` does the rest."""
    config, readable = _setup_raw_config()
    return config if readable and isinstance(config, dict) else {}


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
# it on updates; fresh setup defaults an unset key on. Nothing writes at load time.
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


def _enable_stream_reasoning_deltas(*, defaults_only: bool = False) -> Dict[str, Any]:
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
        if defaults_only and "stream_reasoning_deltas" in plugins_cfg:
            return {
                "applied": False,
                "reason": "existing_choice",
                "restartRequired": False,
                "configPath": str(config_path),
                "message": "The saved live-reasoning setting was preserved.",
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


# Live reasoning as the phone app sees it (`liveReasoning` on the
# profile-options readback), so the app can offer to turn it on. The key is
# gateway-wide, so every profile on one gateway reads the same answer.
LIVE_REASONING_STATE_ON = "on"
LIVE_REASONING_STATE_RESTART = "restart"
LIVE_REASONING_STATE_OFF = "off"
LIVE_REASONING_STATE_UNSET = "unset"
LIVE_REASONING_STATE_UNAVAILABLE = "unavailable"
# The app's one option on the profile-options apply lane. It turns live
# reasoning ON and nothing else: any value but a real `true` writes nothing.
LIVE_REASONING_OPTION = "live_reasoning"
LIVE_REASONING_RESULT_UNAVAILABLE = "unavailable"
LIVE_REASONING_RESULT_IGNORED = "ignored"


def _live_reasoning_state() -> Optional[str]:
    """Where live reasoning stands in THIS gateway process, or None when the
    config cannot be read.

    * ``unavailable``: this Hermes has no reasoning-delta hooks, so the key
      would sit inert whatever it says;
    * ``on``: the key is true and this process registered the hooks at boot;
    * ``restart``: the key is true but this process started before it was
      written, so only a gateway restart reads it;
    * ``off``: somebody set the key to false, which is their choice;
    * ``unset``: nobody chose.

    The same facts the doctor's live-reasoning findings are derived from
    (snapshot.py ``_derive_live_reasoning``): the strict boolean reader, the
    hook probe taken at registration, and the registered feature tokens.
    """
    if not STREAM_HOOKS_AVAILABLE:
        return LIVE_REASONING_STATE_UNAVAILABLE
    config, readable = _setup_raw_config()
    if not readable:
        return None
    setting = health_collect.live_reasoning_setting(config)
    if setting is True:
        if FEATURE_TOKEN_STREAM_HOOKS in _hermes_feature_tokens():
            return LIVE_REASONING_STATE_ON
        return LIVE_REASONING_STATE_RESTART
    if setting is False:
        return LIVE_REASONING_STATE_OFF
    return LIVE_REASONING_STATE_UNSET


def _apply_live_reasoning_option(value: Any) -> str:
    """Turn live reasoning on for the phone app; the outcome as one word.

    ``written`` / ``already_enabled`` / ``config_unwritable`` are
    ``_enable_stream_reasoning_deltas``'s own reasons. ``unavailable`` is the
    same refusal the setup tool makes on a host without the hooks (nobody is
    left holding an inert gateway-wide key), and ``ignored`` is any value that
    is not a real ``true``: this lane can turn the key on, never off.
    """
    if value is not True:
        return LIVE_REASONING_RESULT_IGNORED
    if not STREAM_HOOKS_AVAILABLE:
        return LIVE_REASONING_RESULT_UNAVAILABLE
    result = _enable_stream_reasoning_deltas(defaults_only=False)
    return str(result.get("reason") or "config_unwritable")


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
# From 0.20.6 the Desktop plugin asks "Make Desktop feel like OcuClaw?" itself,
# once, and remembers the answer on that Desktop (#3343). That answer never
# reaches this backend, so `/ocuclaw-setup` must not ask a second time (#3911):
# the look is already the operator's choice, made in Desktop and changed in
# Settings > Appearance.
DESKTOP_THEME_OFFER_DESKTOP_CHOICE = "desktop_choice"
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
    desktop_chooser: bool = False,
) -> str:
    """What `/ocuclaw-setup` should DO about the OcuClaw look on this host."""
    if not config_readable:
        return DESKTOP_THEME_OFFER_UNKNOWN
    if requested:
        return DESKTOP_THEME_OFFER_ENABLED
    if not plugin_present:
        return DESKTOP_THEME_OFFER_UNAVAILABLE
    if desktop_chooser:
        return DESKTOP_THEME_OFFER_DESKTOP_CHOICE
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
    auto_select = _desktop_theme_autoselect_supported()
    return {
        "name": DESKTOP_THEME_NAME,
        "requestedAt": requested_at or None,
        "requested": bool(requested_at),
        "pluginPath": path,
        "pluginPresent": present,
        "autoSelectSupported": auto_select,
        # The plugin's one-time theme dialog shares requestTheme's 0.20.6 gate,
        # so the same fact says Desktop has already asked (#3911).
        "desktopChooser": auto_select,
        "offer": _desktop_theme_offer(
            requested=bool(requested_at),
            plugin_present=present,
            config_readable=config_readable,
            desktop_chooser=auto_select,
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
# an immediate recertification obligation for every first-seen 0.21.x, 0.22.x or
# 0.23.x patch. 0.22.0 through 0.22.7 sit inside the range as compatible, not
# certified.
#
# The gate itself is health.py's (`hermes_version_supported` below calls it).
# These lines restate health.py's constants for the tools that read them from
# this file; test_pin_coherence.py holds the two files together.
#
# SUPPORTED_HERMES_MIN is the hard floor. SUPPORTED_HERMES_MAX_EXCLUSIVE ends
# the tested range and blocks nothing: a Hermes at or above it starts as usual,
# and status, the dashboard and the gateway log warn that it is untested.
CERTIFIED_HERMES_VERSION = "0.23.2"
CERTIFIED_HERMES_TAG = "v0.23.2"
CERTIFIED_HERMES_COMMIT = "ae2a81ccc00e9b7c06301523e5bb09608397149c"
SUPPORTED_HERMES_MIN = (0, 21, 4)
SUPPORTED_HERMES_MAX_EXCLUSIVE = (0, 24, 0)

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
# The name a MODEL loads the setup skill by (#3829). Hermes qualifies a plugin
# skill with the plugin's name, and resolves it only that way: it is absent
# from <available_skills> and from the flat skills tree. `/ocuclaw-setup` is a
# command a PERSON types; told to "load it via /ocuclaw-setup", a model on a
# real Desktop run guessed `skill_view("ocuclaw-setup")`, got "not found", and
# carried on without the skill.
SETUP_SKILL_QUALIFIED_NAME = f"ocuclaw:{SETUP_SKILL_NAME}"
# Its index line (#3078). A Hermes plugin skill is deliberately absent from the
# prompt's <available_skills> block (agent/prompt_builder.py never consults the
# plugin-skill registry), so a registered skill nobody names is a skill nobody
# loads. This section is the only place a session learns the qualified name
# exists. Keep it byte-constant for the same reason the readability section
# is: it is re-rendered at every prompt-invalidation and compaction boundary.
OCUCLAW_SETUP_SKILL_SECTION_ID = "ocuclaw.setup-skill"
OCUCLAW_SETUP_SKILL_SYSTEM_PROMPT = (
    "Plugin skill ocuclaw:ocuclaw-assist-hermes: OcuClaw setup, phone "
    "pairing and re-pairing, updates, diagnostics and troubleshooting for the "
    "Even G2 on Hermes. Load it with "
    'skill_view("ocuclaw:ocuclaw-assist-hermes") before any OcuClaw setup, '
    "pairing or repair step, including a plain request to re-pair a phone. "
    "/ocuclaw-setup is the same skill for a person to type; you cannot run it."
)
# The Bot Screen's why line (Matt, 2026-11-11). A note the agent writes before
# a computer_use step shows on one line of the glasses, about 58 characters
# after its elbow. A longer one goes out in parts (BotScreenReasonParts), so
# this only keeps most reasons to a single glance. It never asks the agent to
# narrate: whether it does is the owner's SOUL.md. Byte-constant for the same
# reason the two sections above are.
OCUCLAW_SCREEN_NOTES_SECTION_ID = "ocuclaw.screen-notes"
OCUCLAW_SCREEN_NOTES_SYSTEM_PROMPT = (
    "When you use your computer and say what you are doing before a step, "
    "the wearer reads that note on a single line of their glasses. Write it "
    "as one short phrase of at most 55 characters that starts with the "
    'action, such as "Opening the best rated hotel.", and leave out lead-ins '
    'like "I am".'
)

SETUP_TOOL_NAME = "ocuclaw_setup"
# The setup tool gets a toolset of its own. Hermes groups plugin tools by
# toolset and offers each group as one switch; a group named `hermes-cli`
# makes that switch the whole core composite. With it on, every platform's
# saved tool list expands back to all core tools; with it off, the setup tool
# is gone. Hermes 0.21.1+ sessions take plugin toolsets from
# `_get_platform_tools`, so a dedicated key reaches CLI, TUI and Desktop.
SETUP_TOOLSET = "ocuclaw_setup"
# Hosts before 0.21.6 keep the old `hermes-cli` key. On 0.21.1-0.21.5,
# switching the plugin on from the dashboard with no saved tool lists seeds
# `platform_toolsets.cli` with the plugin's key alone, which would leave CLI
# with only the setup tool. On 0.21.1-0.21.4 the classic CLI also warns
# "Unknown toolsets" for any plugin key while discovery still runs.
LEGACY_SETUP_TOOLSET = "hermes-cli"
DEDICATED_SETUP_TOOLSET_MIN = (0, 21, 6)
SETUP_TOOL_DESCRIPTION = (
    "Start with next: it reads where setup is, does the next step it may do "
    "itself, and returns what to say and what input it needs; call it again "
    "after each answer (pass a choice the user picked as choice). "
    "Inspect OcuClaw setup, run the local human pairing ceremony, wait for the "
    "phone-origin proof turn and welcome dismissal, and load focused guidance "
    "without revealing secrets. Two operations write — "
    "enable_stream_reasoning_deltas and enable_desktop_theme — and only with "
    "confirm: true. Fresh setup enables unset live reasoning with defaultsOnly: "
    "true; changing a saved choice or applying a theme requires an explicit yes. "
    "apply_route and confirm_pairing act only after the user's own approval "
    "card or fresh chat yes; pair_with_phone_code takes the phone's code."
)
SETUP_GUIDE_VERSION = "2026-10-28 (1.3.27-hermes)"
SETUP_SKILL_LOAD_POINTER = (
    "If the OcuClaw Setup Assistant skill is not loaded in this conversation, "
    f'load it with skill_view("{SETUP_SKILL_QUALIFIED_NAME}") before mutating '
    "anything. `/ocuclaw-setup` is the same skill for a person to type; you "
    "cannot run it."
)
SETUP_REFERENCE_FILES = {
    "install_lifecycle": ("install-lifecycle.md", "Installation and lifecycle recovery"),
    "fresh_install": ("fresh-install.md", "Fresh install"),
    "cloudways": ("cloudways.md", "Cloudways managed Hermes"),
    "agent_mode": ("agent-mode.md", "Choose single or multiple agents"),
    "credential_reset": ("relay-credential-reset.md", "Reset relay credential"),
    "update": ("update.md", "Update OcuClaw"),
    "troubleshooting": ("troubleshooting.md", "Troubleshooting"),
    # #7188: one case per reason a card's live part is not working, generated from the
    # plugin's reason table (extensions/ocuclaw/scripts/generate-card-fixes.mjs).
    "card_fixes": ("card-fixes.md", "Card fixes"),
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
SETUP_REPLY_DELIVERY_OPERATION = "wait_reply_delivery"
SETUP_INTERACTIVE_OPERATIONS = (
    "request_credentials",
    "pair_phone",
    "wait_phone_origin",
    SETUP_REPLY_DELIVERY_OPERATION,
    "arm_first_run_proof",
    "welcome_round_trip",
)
# #6378: the chat approvals and the phone code (setup_chat_approvals.py).
SETUP_ROUTE_APPROVAL_OPERATION = "apply_route"
SETUP_PAIRING_APPROVAL_OPERATION = "confirm_pairing"
SETUP_PHONE_CODE_OPERATION = "pair_with_phone_code"
SETUP_CHAT_OPERATIONS = (
    SETUP_ROUTE_APPROVAL_OPERATION,
    SETUP_PAIRING_APPROVAL_OPERATION,
    SETUP_PHONE_CODE_OPERATION,
)
# #6377: the step machine. It writes (settings, Tailscale, the one announced
# restart), so it is not read-only.
SETUP_NEXT_OPERATION = "next"
SETUP_NEXT_CHOICE_MAX = 64
SETUP_OPERATIONS = (
    SETUP_NEXT_OPERATION,
    "status",
    "doctor",
    SETUP_EVEN_AI_ROUTE_OPERATION,
    *SETUP_INTERACTIVE_OPERATIONS,
    *SETUP_REFERENCE_FILES.keys(),
    *SETUP_WRITING_OPERATIONS,
    *SETUP_CHAT_OPERATIONS,
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
                    "Hermes TUI or Desktop phone-code and four-word ceremony; "
                    "wait_phone_origin blocks for a completed phone turn; "
                    f"{SETUP_REPLY_DELIVERY_OPERATION} makes one bounded check "
                    "of whether the phone app reported that the glasses SDK "
                    "accepted that turn's reply; "
                    "welcome_round_trip blocks for the managed welcome dismissal "
                    "and, once committed, returns say lines to repeat verbatim. "
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
                    f"{SETUP_DESKTOP_THEME_OPERATION}. Fresh setup may apply the "
                    "live-reasoning default with defaultsOnly: true. Otherwise ask "
                    "first — the stream key is gateway-wide, the theme "
                    "repaints their Desktop. Ignored by every read-only "
                    "operation."
                ),
            },
            "defaultsOnly": {
                "type": "boolean",
                "description": (
                    "For enable_stream_reasoning_deltas during fresh setup: "
                    "true enables only an unset key and preserves every saved "
                    "value, including false. Still requires confirm: true. "
                    "Updates and changes to saved choices require an explicit yes."
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
                    f"Pass it unchanged to {SETUP_REPLY_DELIVERY_OPERATION} and "
                    "welcome_round_trip; never show it to the user."
                ),
            },
            "replyEvidence": {
                "type": "string",
                "enum": list(REPLY_EVIDENCE_VALUES),
                "description": (
                    "Which reply evidence you hold for arming. Send "
                    "client_sdk_receipt only when wait_reply_delivery returned "
                    "status sdk_accepted for this same candidate; send "
                    "wearer_confirmed (the default) when the wearer answered "
                    "the display question. A claimed receipt without a "
                    "matching record is refused. A turn whose run errored "
                    "(replyWasProviderError) is refused on both: give its "
                    "action instead of asking the wearer."
                ),
            },
            "binding": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$",
                "description": (
                    f"For {SETUP_ROUTE_APPROVAL_OPERATION} and "
                    f"{SETUP_PAIRING_APPROVAL_OPERATION}: the binding `next` "
                    "returned for this approval, unchanged. The user approves "
                    "the card Hermes shows; you can never approve it yourself."
                ),
            },
            "answer": {
                "type": "string",
                "enum": ["yes", "no"],
                "description": (
                    "Only when `next` asked for a chat yes: the user's own "
                    "fresh reply to the exact text you showed. It counts only "
                    "if their latest message itself says yes or no."
                ),
            },
            "code": {
                "type": "string",
                "maxLength": 64,
                "description": (
                    f"For {SETUP_PHONE_CODE_OPERATION}: the 6-digit phone code "
                    "the user read off the phone's Pair screen."
                ),
            },
            "choice": {
                "type": "string",
                "minLength": 1,
                "maxLength": SETUP_NEXT_CHOICE_MAX,
                "description": (
                    f"For {SETUP_NEXT_OPERATION}: the id of the option the user "
                    "(or, where next says so, you) picked from its last choice."
                ),
            },
        },
        "required": ["operation"],
        "additionalProperties": False,
    },
}
_LAST_SETUP_BUNDLE_REPORT: Dict[str, Any] = {"status": "unknown"}

# History pushes + agent_end transcripts are tail-sliced server-side, by this
# count and by session_rpc.HISTORY_BYTE_BUDGET, so a long session never risks
# the 1 MiB link frame cap (same bounds as chat.history, #7327).
HISTORY_PUSH_LIMIT = 200
# Hermes 0.20 drains StreamConsumer on its own task, so on_session_end can beat
# the trailing cumulative finalize edit. Keep the open record addressable for a
# short bounded interval; provider-abort paths still close deterministically.
STREAM_FINALIZE_GRACE_SECONDS = 1.5
# Reply-stream slot. Hermes' StreamConsumer calls edit_message about every
# 50 ms with the CUMULATIVE text, and each call used to become its own
# fire-and-forget RPC: an 8k reply put ~800 frames and several MB on the link,
# and a stalled child let them pile up to the link's 128-request admission
# limit, where the turn's commit, terminal activity and agent_end were
# refused. The slot keeps at most one streaming RPC per run in flight, keeps
# only the newest text while one is (cumulative text makes that lossless),
# and spaces sends by this floor. The first frame of a run is never delayed.
# `platforms.ocuclaw.extra.streamFlushMs` overrides it; 0 turns the slot off.
STREAM_SLOT_FLOOR_MS = 100
# A turn's closing frames (commit, terminal activity, agent_end) are retried
# when the link refuses them as overloaded, for as long as the stream tail may
# itself be held open, then dropped with a warning.
CRITICAL_FRAME_RETRY_BUDGET_S = STREAM_FINALIZE_GRACE_SECONDS
CRITICAL_FRAME_RETRY_BASE_S = 0.025
CRITICAL_FRAME_RETRY_MAX_S = 0.4

TOOL_ACTIVITY_MAX_ARG_KEYS = 32
TOOL_ACTIVITY_MAX_ARG_ITEMS = 8
TOOL_ACTIVITY_MAX_ARG_DEPTH = 2
TOOL_ACTIVITY_MAX_ARG_STRING = 512
TOOL_ACTIVITY_MAX_ARGS_JSON_BYTES = 16 * 1024
# Hermes' native plan tool. 0.21.5 renamed `todo` to `todo_list`; the legacy
# name still resolves on older engines, so both carry the plan snapshot.
PLAN_TOOL_NAMES = ("todo_list", "todo")
PLAN_RESULT_MAX_BYTES = 64 * 1024
PLAN_MAX_ITEMS = 30
PLAN_ITEM_MAX_CHARS = 120
PLAN_ID_MAX_CHARS = 64
PLAN_STATUSES = ("pending", "in_progress", "completed", "cancelled")
# Newest plan revision per Hermes session id. Bounded; oldest entries drop.
PLAN_REVISION_CACHE_MAX = 256
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
    # web_extract and Firecrawl's batch tools name their pages in a list; each
    # item is redacted and capped like `url` (the status bar reads the first).
    "urls",
}
#: #5148: computer_use arguments that carry typed text or a set value; always omitted.
TOOL_ACTIVITY_COMPUTER_USE_MASKED_ARG_KEYS = frozenset({"text", "value"})
#: #3769: a Hermes kanban board slug, the same shape Board accepts (board_management._SLUG).
TOOL_ACTIVITY_KANBAN_BOARD_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
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
# Extra, ADD-ONLY status-bar material for the Node runtime, which owns the
# shortening, ranking and gating. A runtime that predates these keys ignores
# them: its resolver reads `summary` and the THINKING_DETAIL_KEYS only.
#   thinkingProse       - the tail of one model call's plain-prose reasoning
#                         (a `detail`-source headline frame only);
#   thinkingSummaryLong - a typed `reasoning.summary` the headline rule turned
#                         down only for being multi-line or over 80 chars.
THINKING_PROSE_KEY = "thinkingProse"
THINKING_PROSE_MAX_CHARS = 600
# A `thinkingProse` frame sent WHILE the reasoning streams, one per sentence the
# model finishes (plain-prose reasoning only). The runtime shows a headline cut
# from it under its `headline` switch and drops the frame otherwise.
THINKING_LIVE_KEY = "thinkingLive"
# The end of a finished sentence in streamed reasoning: its mark with white
# space after it, so "SOUL.md", "3.5" and a chunk's still-open tail do not count.
STREAM_SENTENCE_END_RE = re.compile(r"[.!?](?=\s)")
THINKING_SUMMARY_LONG_KEY = "thinkingSummaryLong"
THINKING_SUMMARY_LONG_MAX_CHARS = 400
# The sentence a model writes BEFORE the tools of the same model call
# ("Checking the logs first."), sent from `post_api_request` so it reaches the
# runtime ahead of that call's `pre_tool_call` frames.
PRE_TOOL_NARRATION_MAX_CHARS = 600
# Inline reasoning markup some models put in `content` (Hermes'
# agent/think_scrubber.py THINK_TAG_NAMES). Hermes strips it before it calls
# text visible; this adapter does not re-implement that scrubber, so content
# carrying any such tag is never offered as a pre-tool sentence.
PRE_TOOL_NARRATION_THINK_TAG_RE = re.compile(
    r"</?\s*(?:mm:)?(?:think|thinking|reasoning|thought|reasoning_scratchpad|"
    r"思考|反思|推理|推敲)(?:\s[^>]*)?>",
    re.I,
)
# Hermes' file search tool and the argument that carries its pattern
# (tools/file_tools.py SEARCH_FILES_SCHEMA). The Node label reads `query`.
SEARCH_FILES_TOOL_NAME = "search_files"
SEARCH_FILES_PATTERN_ARG = "pattern"

# Narration (the agent's own mid-turn sentences) routing tag.
MESSAGE_KIND_NARRATION = "narration"
MESSAGE_KIND_TOOL_PROGRESS = "tool_progress"
# How many recent commits per run stay matchable for a late retag. Narration
# lands in the first sentences of a turn; an unbounded ledger would be a leak.
NARRATION_COMMIT_MEMORY = 16
# How many failed-turn reply marks wait for their candidate. A mark is taken
# when its turn publishes; a turn that never publishes must not leak its mark.
FAILED_TURN_REPLY_MARKS_MAX = 64
# How many origin stamps stay remembered per run (#1619). One per narration
# sentence; the same bound as the commit ledger, for the same reason.
NARRATION_ORIGIN_MEMORY = 16
# Keep completed fork identities long enough to reject queued stream hooks too.
BACKGROUND_HOOK_TURN_MEMORY = 512
# Hermes' StreamConsumer marks a commentary send with this metadata key
# (0.20.5+). It is a SECOND narration signal, independent of the hook, and
# both feed the same normalized-text set.
INTERIM_SEND_METADATA_KEY = "_interim_send"
# A plugin's `ctx.post_message` / `handle.edit` (Hermes 0.22.3+) reaches
# send()/edit_message() from this module, with the same `_interim_send` marker
# as commentary and no key of its own: the calling module is the only tell.
PLUGIN_MESSAGES_MODULE = "gateway.plugin_messages"
# Plugin messages whose `handle.edit` stays matchable. A plugin holds one
# handle per long job, so a small bound covers every live one.
PLUGIN_MESSAGE_MEMORY = 64

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
# LiveUI I11: Hermes keeps a finished turn's session (`_active_sessions`) through
# its delivery tail, after `on_processing_complete` has closed the ledger run. A
# wake handed to `handle_message` in that tail is routed as a message for a busy
# session and interrupts the finished turn ("Interrupting current task"). A wake
# polls until Hermes lets the session go; past the budget it is sent as before.
WAKE_SESSION_RELEASE_TIMEOUT_S = 5.0
WAKE_SESSION_RELEASE_POLL_S = 0.02
# #4833: Stop on a turn waiting on a Hermes question. The interrupt reaches the
# agent through Hermes's 200 ms monitor; 0.22.1's waiter then withdraws the
# question itself within its 1 s slice, and the 0.21.x waiter never does. Past
# this grace Stop drops it, so a question never holds the chat for its
# hour-long timeout. Dropping it after the interrupt is safe either way; the
# grace only keeps the card's clearing inside the wearer's 5 s.
CLARIFY_STOP_GRACE_S = 1.0
CLARIFY_STOP_POLL_S = 0.05
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
# Even AI turns cannot answer a structured clarify (plugin issue #7, the
# Hermes half of the OpenClaw ask_user guard). An Even AI reply is one
# blocking HTTP request that ends with the run, and the glasses show Even
# AI's own HUD. The clarify router drops the question on the background
# lanes and paints an unreachable OcuClaw card on the active lane, while
# clarify holds the run for up to an hour and the request gives up at 60 s.
# The pre_tool_call hook vetoes clarify on Even AI turns (see
# even_ai_clarify_block); Hermes returns the message as the tool result.
EVEN_AI_CLARIFY_TOOL_NAME = "clarify"
EVEN_AI_PROMPT_OWNER = "even-ai"
EVEN_AI_CLARIFY_BLOCK_MESSAGE = (
    "The user is talking through Even AI on their glasses, which cannot show "
    "clarify questions. Ask the question in plain text in your reply instead, "
    "with any options as a short numbered list in the sentence, then end your "
    "turn. Their next Even AI message is the answer."
)
SESSION_ABORT_METHOD = "sessions.abort"
SESSION_STEER_METHOD = "sessions.steer"
SESSION_OPTIONS_APPLY_METHOD = "sessions.options.apply"
# Hermes effort names OcuClaw shows as-is; Hermes "none" arrives as enabled:False.
OCUCLAW_THINKING_LEVELS = frozenset(
    {"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
)
PROFILE_OPTIONS_GET_METHOD = "profile.options.get"
PROFILE_OPTIONS_APPLY_METHOD = "profile.options.apply"
MULTIPLEX_DISABLED_ERROR = (
    "Hermes multiplex profile routing is disabled; only the main namespace "
    "is available."
)
PROFILE_NOT_SERVED_ERROR = (
    "Hermes profile {profile!r} is not served by this gateway."
)
#: A profile that WAS served and has just left the multiplexer's set (#2942).
#: Distinct from "never served" on purpose: in-flight work on it is draining,
#: so the refusal is about starting something new, and the wearer is told the
#: agent went away rather than being answered by the default profile instead.
PROFILE_NO_LONGER_SERVED_ERROR = (
    "Hermes profile {profile!r} is no longer served by this gateway; "
    "work already running there is finishing."
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


def plan_step_glance(items: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The glasses' `Step k/n` fact for a normalized plan, or None.

    Only top-level items (no `parent`) count, and cancelled ones drop out of
    n. k is the first in_progress top-level item; with none, k is
    completed + 1 clamped to n. `content` is the in_progress child of the
    current step when there is one, else the step itself. When every counted
    item is completed the plan is done at n/n.
    """
    top = [
        item for item in items
        if not item.get("parent") and item.get("status") != "cancelled"
    ]
    total = len(top)
    if total == 0:
        return None
    completed = sum(1 for item in top if item.get("status") == "completed")
    if completed == total:
        return {"index": total, "total": total, "done": True}
    current_index = next(
        (i for i, item in enumerate(top) if item.get("status") == "in_progress"),
        None,
    )
    if current_index is None:
        current_index = min(completed, total - 1)
        current = next(
            (item for item in top if item.get("status") == "pending"),
            top[current_index],
        )
    else:
        current = top[current_index]
    content = str(current.get("content") or "")
    current_id = current.get("id")
    if current_id:
        child = next(
            (
                item for item in items
                if item.get("parent") == current_id and item.get("status") == "in_progress"
            ),
            None,
        )
        if child is not None and child.get("content"):
            content = str(child["content"])
    step: Dict[str, Any] = {"index": current_index + 1, "total": total, "done": False}
    if content:
        step["content"] = content
    return step


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


# No model tool calls `liveui.render`: V1's render_glasses_ui is retired. The
# gateway's own first-run welcome paint (_deliver_armed_first_run_welcome) is
# its one caller.
LIVEUI_RENDER_METHOD = "liveui.render"
LIVEUI_ABORT_METHOD = "liveui.abort"
LIVEUI_PROMPT_METHOD = "liveui.prompt"
LIVEUI_PROMPT_ACK_METHOD = "liveui.promptAck"
LIVEUI_LLM_AUTH_METHOD = "liveui.llmAuth"
LIVEUI_LLM_RECIPE_METHOD = "liveui.llmRecipe"
# Parent → child: one OcuClaw auxiliary attempt, for `token.aux` (#5046).
AUX_CALL_DEBUG_METHOD = "aux.call"
LIVEUI_STATE_METHOD = "liveui.uiState"
LIVEUI_STATE_TOOL_NAME = "get_glasses_ui_state"
LIVEUI_TEMPLATE_METHOD = "liveui.templates"
LIVEUI_TEMPLATE_TOOL_NAME = "manage_liveui_templates"
LIVEUI_TASK_METHOD = "liveui.tasks"
LIVEUI_TASK_TOOL_NAME = "manage_liveui_tasks"
# LiveUI V2 K6, K7: the only model render tool (V1's render_glasses_ui is
# retired). Hermes holds one schema per tool name for the whole process, so it
# registers once for every session.
LIVEUI_COMPOSE_METHOD = "liveui.compose"
LIVEUI_COMPOSE_TOOL_NAME = "compose_glasses_ui"
LIVEUI_TOOLSET = "ocuclaw"
# Phone tools over the control link (#2797 / #2800). The Node child advertises
# these as data in `hello.phoneTools`; this allow-list is what the adapter is
# willing to register. Names are allow-listed NOW so #2801/#2802/#2803 only add
# a descriptor on the Node side — nothing registers until the child sends one.
# Hello order, which is the order the adapter registers in and the order the
# manifest lists them in. The allow-list below is derived from it so the two
# can never disagree.
PHONE_TOOL_ORDER: Tuple[str, ...] = (
    "get_current_location",
    "get_evenrealities_device_info",
    "set_session_title",
    # Model-written program cards (staging). The child answers `no_client`
    # unless the phone's Staging switch is on.
    "write_glasses_card",
    # Saves the open card to the LiveUI Library, as on OpenClaw.
    "save_glasses_card",
    # The Yes/No on the glasses before any card; write_glasses_card refuses
    # until it gets a yes, as on OpenClaw.
    "ask_glasses_card",
    # Talking to the open card, as on OpenClaw: press one of its commands, or
    # change its code in place. Change by voice on the glasses relies on them.
    "glasses_card_command",
    "edit_glasses_card",
    "look_glasses_card",
    # Recovery metadata remains readable without a connected phone; launch/edit
    # still require an exact owner/client binding in the host service.
    "glasses_card_draft",
    # The wearer's grant before card code may send to an MCP tool (#6111), as
    # on OpenClaw. The child answers `off` until the phone and card_mcp.py can
    # both run writes.
    "request_card_mcp_write",
    # Host commands for cards: the owner's Add before a card may run a
    # command on this host. On by default; the child answers `off` when
    # `programCardsMcp.hostCommands` is written off.
    "request_host_command",
    # The agent's request for a card switch (#7186): the wearer taps Allow on
    # the glasses, and the switch is then saved by the phone switch's own
    # `optional.setup` path. Nothing changes without that tap.
    "request_card_setup",
    # App settings: read, then change one, when the wearer asks in chat. The
    # phone holds the list of settings an agent may touch and asks for a tap
    # on the glasses before the ones the wearer marked "with confirm".
    "get_ocuclaw_settings",
    "set_ocuclaw_setting",
    # The Bot Screen on the glasses when the wearer asks ("show your computer
    # on my glasses"): the phone opens the page and starts an installed screen
    # that is off with Hermes's own start. It never begins computer use.
    "show_bot_screen",
)
PHONE_TOOL_NAMES = frozenset(PHONE_TOOL_ORDER)
# Every tool this bundle provides, in `plugin.yaml` provides_tools order. One
# Python constant is the source of truth: the manifest pytest compares
# provides_tools against it, and the inventory below is built from it, so a
# tool cannot be added to one surface and forgotten on the other (#2804).
PROVIDED_TOOL_NAMES: Tuple[str, ...] = (
    LIVEUI_STATE_TOOL_NAME,
    LIVEUI_TEMPLATE_TOOL_NAME,
    LIVEUI_TASK_TOOL_NAME,
    LIVEUI_COMPOSE_TOOL_NAME,
) + PHONE_TOOL_ORDER + (SETUP_TOOL_NAME,)
# Applied when a descriptor omits `linkTimeoutMs`. Mirrors
# PHONE_TOOL_DEFAULT_LINK_TIMEOUT_MS in the Node bridge module.
PHONE_TOOL_DEFAULT_LINK_TIMEOUT_S = 15.0
# The child owns the wait (ADR-0006), so a declared `linkTimeoutMs` gets a
# margin on the adapter side rather than a competing deadline.
PHONE_TOOL_LINK_MARGIN_S = 5.0
HERMES_HOME_CHANNEL_NOTICE = (
    "📬 No home channel is set for Ocuclaw. A home channel is where Hermes "
    "delivers cron job results and cross-platform messages.\n\n"
    "Type /sethome to make this chat your home channel, or ignore to skip."
)
LIVEUI_DEFAULT_RENDER_TIMEOUT_MS = 30 * 60 * 1000
LIVEUI_RENDER_LINK_MARGIN_S = 60.0
LIVEUI_PROMPT_LINK_TIMEOUT_S = 2.0
FIRST_RUN_WELCOME_POLL_SECONDS = 1.0
#: #3231. The Attempt is armed on the phone's SDK receipt for a SLICE of the
#: reply, so "armed" does not mean the wearer has finished reading it. The
#: welcome waits for the reply run's terminal boundary, then for the same
#: finalize grace the stream tail already uses. The wait is bounded: a run that
#: never reaches its boundary must not silence the welcome for the whole
#: install, so after this many seconds of deferral the welcome goes anyway.
FIRST_RUN_WELCOME_REPLY_WAIT_SECONDS = 30.0

# Adapter instances the module-level hermes hook handlers route into (hooks
# are registered at plugin load; adapters are constructed per platform boot
# and live for the gateway's lifetime).
#
# The list lives OUTSIDE this plugin's module namespace (#3625). Hermes 0.21.5
# re-discovers plugins inside a running gateway whenever any plugin is
# installed, enabled or updated (`reload-plugins`, run_plugin_rewire.py): it
# purges `hermes_plugins.ocuclaw*` from sys.modules, re-imports this file and
# re-runs register(). The live adapter keeps running, but it appended itself to
# the OLD module's list, so the re-registered hooks would fan out to an empty
# one: no LiveUI prompt context, tool activity, interim lines, approval
# resolution or session-end bookkeeping until a restart. A holder keyed outside
# the purged namespace lets every import of this module share the one list.
_ADAPTER_REGISTRY_MODULE = health_collect.LIVE_ADAPTER_HOLDER_MODULE


def _live_adapter_registry() -> List[Any]:
    import sys
    import types

    holder = sys.modules.get(_ADAPTER_REGISTRY_MODULE)
    adapters = getattr(holder, "adapters", None)
    if not isinstance(adapters, list):
        holder = types.ModuleType(_ADAPTER_REGISTRY_MODULE)
        holder.adapters = adapters = []
        sys.modules[_ADAPTER_REGISTRY_MODULE] = holder
    return adapters


def _record_serving_version() -> None:
    """Pin the version this process serves to the adapter just built.

    A later reload re-imports health.py, which then reads the new plugin.yaml;
    this record keeps doctor and the snapshot naming the code still running.
    """
    import sys

    holder = sys.modules.get(_ADAPTER_REGISTRY_MODULE)
    if holder is not None:
        holder.serving_version = health_collect.loaded_ocuclaw_version()


_ADAPTERS: List[Any] = _live_adapter_registry()
_POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = False
_PLUGIN_CONTEXT: Any = None
_LIVEUI_REGISTER_TOOL: Any = None
_LIVEUI_STATE_TOOL_REGISTERED = False
_LIVEUI_TEMPLATE_TOOL_REGISTERED = False
_LIVEUI_TASK_TOOL_REGISTERED = False
_LIVEUI_COMPOSE_TOOL_REGISTERED = False
# Per-name registration state for the data-driven phone tools (#2800). A
# dict, not four flags, precisely so the next tickets add nothing here.
_PHONE_TOOL_REGISTERED: Dict[str, bool] = {}
# True once THIS process received a runtime hello: the only moment the
# hello-driven tools can register, so the only proof that a missing one is a
# defect. A constructed adapter is not proof: Hermes 0.21's bare `hermes` TUI
# runs its own gateway child, which constructs the platform (and its adapter)
# but never starts the runtime while the managed gateway owns the relay port,
# so seven tools read as "missing" on a perfectly healthy Cloudways host.
_RUNTIME_HELLO_SEEN = False


def _note_runtime_hello() -> None:
    global _RUNTIME_HELLO_SEEN
    _RUNTIME_HELLO_SEEN = True
# Set by `register()` when `ctx.register_tool` actually accepted the setup
# tool. Without it the inventory could only guess, and the one tool whose job
# is to report a broken install would report itself as present on a host where
# it never registered (#2804).
_SETUP_TOOL_REGISTERED = False
_LIVEUI_LOCK = threading.RLock()
# The last runtime hello, kept so the hello-driven tools can be put back
# after Hermes unloads them in a forced plugin rediscovery (OCU-1E6C-EEX1).
_LAST_RUNTIME_HELLO: Optional[Dict[str, Any]] = None
# Model-written program cards sit behind the phone's LiveUI > Settings >
# Staging switch. Their five tools register from the hello like every phone
# tool, but the model sees them only while the presence pull reports a
# connected app with Staging on (`programCards`).
PROGRAM_CARD_TOOL_NAMES: Tuple[str, ...] = (
    "write_glasses_card",
    "save_glasses_card",
    "ask_glasses_card",
    "glasses_card_command",
    "edit_glasses_card",
    "look_glasses_card",
    "request_card_mcp_write",
    "request_host_command",
    "request_card_setup",
)
_PROGRAM_CARDS_STAGING = False


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
    but the lock must never depend on that side effect alone.

    On Windows CPython sends ``os.kill(pid, 0)`` to GenerateConsoleCtrlEvent,
    which Ctrl+C's the holder's console group instead of probing it
    (bpo-14484), so there it asks psutil, a Hermes core dependency."""
    try:
        pid_int = int(pid)
    except (TypeError, ValueError):
        return False
    if pid_int <= 0:
        return False
    if _IS_WINDOWS:
        try:
            import psutil

            return bool(psutil.pid_exists(pid_int))
        except Exception:  # noqa: BLE001 - unknowable never holds
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
    home: Optional[Path], lineage: List[str], *, strict: bool = False
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
    ``None`` — free. Legacy adoption callers also receive None when unknown;
    the driver uses strict=True so missing/unreadable authority instead
    raises and retains the controller's last safe admission as uncertain.
    Its existing bounded liveness observer supplies recovery. Never a private
    read of ``session_turn_leases`` (RULED).
    """
    if home is None or not lineage:
        if strict:
            raise ValueError("ownership lineage unavailable")
        return None
    ids = {str(value) for value in lineage if value}
    marker_hit: Optional[Dict[str, Any]] = None
    marker = Path(home).joinpath(*DESKTOP_TURN_MARKER_RELPATH)
    try:
        with open(marker, encoding="utf-8") as handle:
            entries = json.load(handle)
        if strict and (not isinstance(entries, dict) or any(
            not isinstance(value, dict) for value in entries.values()
        )):
            raise ValueError("ownership_marker_invalid")
        if isinstance(entries, dict):
            for key, value in entries.items():
                if key in ids and isinstance(value, dict):
                    marker_hit = {"sessionId": str(key), "since": value.get("started_at")}
                    break
    except FileNotFoundError:
        pass
    except Exception:  # noqa: BLE001 - best-effort marker read
        if strict:
            raise
        logger.debug("[ocuclaw] turn marker unreadable at %s", marker, exc_info=True)
    lease = _live_desktop_lease(home, ids, strict=strict)
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
                "generation": lease.get("generation"),
                "since": marker_hit["since"],
            }
    return lease


def _live_desktop_lease(home: Path, ids: Set[str], *, strict: bool = False) -> Optional[Dict[str, Any]]:
    """The first pid-alive Desktop/TUI lease naming one of ``ids`` as a
    ``hold`` detail, or ``None`` (free or unknowable)."""
    try:
        from hermes_cli.active_sessions import active_session_registry_snapshot

        if strict and not Path(home).joinpath(*DESKTOP_LEASE_REGISTRY_RELPATH).is_file():
            raise FileNotFoundError("ownership registry unavailable")
        snapshot_options = {"registry_home": home}
        if strict:
            if "strict" not in inspect.signature(active_session_registry_snapshot).parameters:
                raise RuntimeError("ownership_observer_unsupported")
            snapshot_options["strict"] = True
        holders = []
        for entry in active_session_registry_snapshot(**snapshot_options):
            if not isinstance(entry, dict):
                continue
            surface = str(entry.get("surface") or "").strip().lower()
            session_id = str(entry.get("session_id") or "")
            if surface not in DESKTOP_HOLD_SURFACES or session_id not in ids:
                continue
            if not _pid_alive_here(entry.get("pid")):
                continue
            # Native registry generations include process birth time. Verify it
            # using psutil's public API; pid alone never carries consent forward.
            generation = None
            try:
                import psutil
                started = float(entry["process_start_time"])
                actual = psutil.Process(int(entry["pid"])).create_time()
                if abs(actual - started) >= 0.001:
                    continue
                if entry.get("lease_id"):
                    generation = f'{entry["lease_id"]}:{started}'
            except Exception:  # old engines/permissions: hold but no takeover
                pass
            holders.append({
                "state": "hold",
                "sessionId": session_id,
                "surface": surface,
                "pid": entry.get("pid"),
                "since": entry.get("started_at"),
                "generation": generation,
            })
        if holders:
            if len(holders) > 1:
                holders[0]["generation"] = None
            return holders[0]
    except Exception:  # noqa: BLE001 - unknown liveness never locks the wearer out
        if strict:
            raise
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
    """The profiles this gateway serves RIGHT NOW (#2942).

    One shared resolver behind it (``profile_routes``), TTL-cached, so calling
    this per read costs a dict copy rather than a file read. ``(False, {})``
    means "nothing proved", never "multiplex was switched off".
    """
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
    aligned when the user responds through Hermes' text fallback.

    #6378: a denied pairing card cancels the held exchange first. It needs no
    live adapter, because the setup tool runs in host processes too."""
    try:
        from . import setup_chat_approvals

        setup_chat_approvals.handle_post_approval_response(kwargs)
    except Exception:  # noqa: BLE001 - the exchange still expires at the host
        logger.exception("[ocuclaw] setup approval deny glue failed")
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_post_approval_response(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break approvals
            logger.exception("[ocuclaw] post_approval_response glue failed")


def _on_session_delete_hook(**kwargs: Any) -> None:
    """hermes ``on_session_delete`` (0.22.3+; SYNC, on the thread that
    committed the delete or archive). Process-local: it fires only for rows
    this process removed. Hermes discovers plugins lazily, so this also runs in
    a CLI or dashboard process, where no adapter is live and it does nothing."""
    if not _ADAPTERS:
        return
    gone = _sessions_gone(kwargs)
    if gone is None:
        return
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_session_delete(gone)
        except Exception:  # noqa: BLE001 — a hook raise must never fail a delete
            logger.exception("[ocuclaw] on_session_delete glue failed")


def _sessions_gone(kwargs: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The hook payload as a ``sessionsGone`` body, still without ``ns``.

    ``deleted_ids`` rides along only when more than one row went, so the
    primary ``session_id`` is always added. ``origin`` is ``ocuclaw`` while
    OcuClaw's own phone delete tells plugins (session_writer), because the
    relay already did that chat's cleanup.
    """
    raw_ids = kwargs.get("deleted_ids")
    ids = {
        sid
        for sid in (raw_ids if isinstance(raw_ids, (list, tuple, set, frozenset)) else ())
        if isinstance(sid, str) and sid
    }
    primary = kwargs.get("session_id")
    if isinstance(primary, str) and primary:
        ids.add(primary)
    if not ids:
        return None
    reason = kwargs.get("reason")
    return {
        "ids": sorted(ids),
        "reason": reason if isinstance(reason, str) and reason else "delete",
        "profile": kwargs.get("profile"),
        "origin": "ocuclaw" if own_delete_in_progress() else "hermes",
    }


def _process_profile_name() -> Optional[str]:
    """The Hermes profile this process runs under, or None if unknown."""
    try:
        from hermes_constants import get_process_hermes_home, profile_name_for_home

        return profile_name_for_home(get_process_hermes_home())
    except Exception:  # noqa: BLE001 - an unknown home matches no profile
        return None


def _setup_approval_state_dir() -> str:
    """The key this process's setup approvals live under (#6378).

    The profile's OcuClaw state directory. The store is in memory only; the
    path is a key, never written. The step machine reads the store with
    this same key.
    """
    home = _hermes_home()
    return str(home / "ocuclaw") if home is not None else ""


def _setup_approval_directive(kwargs: Mapping[str, Any]) -> Optional[Dict[str, str]]:
    """The approval card (or block) for ``apply_route`` / ``confirm_pairing``.

    Needs no live adapter: the setup tool runs in CLI, TUI and Desktop
    processes too. A call the tool will refuse as off-host gets no card. A
    failure here blocks the call rather than letting it run without one.
    """
    if str(kwargs.get("tool_name") or "").strip() != SETUP_TOOL_NAME:
        return None
    from . import setup_chat_approvals

    operation = setup_chat_approvals.approval_operation(kwargs)
    if operation is None:
        return None
    try:
        if not _host_setup_session_available():
            return None
        return setup_chat_approvals.pre_tool_call_directive(
            kwargs, state_dir=_setup_approval_state_dir()
        )
    except Exception:  # noqa: BLE001 - fail closed: no card, no run
        logger.exception("[ocuclaw] setup approval card failed")
        return {"action": "block", "message": setup_chat_approvals.STALE_BLOCK_MESSAGE}


def _on_pre_tool_call_hook(**kwargs: Any) -> Optional[Dict[str, str]]:
    """Hermes ``pre_tool_call`` hook. Emits the tool-start activity edge, and
    returns a directive for two things only: the setup approval card or block
    for ``ocuclaw_setup`` ``apply_route`` / ``confirm_pairing`` (#6378), and
    the clarify veto on an Even AI turn. They name different tools; the setup
    directive is decided first and the clarify guard only runs without one.
    The activity glue runs for every adapter either way."""
    directive: Optional[Dict[str, str]] = None
    try:
        directive = _setup_approval_directive(kwargs)
    except Exception:  # noqa: BLE001 - never break an unrelated tool call
        logger.exception("[ocuclaw] pre_tool_call setup approval failed")
    for adapter in list(_ADAPTERS):
        # A live adapter built by an older bundle import (#3625) may predate
        # the guard; it simply does not veto.
        guard = getattr(adapter, "even_ai_clarify_block", None)
        if directive is None and callable(guard):
            try:
                directive = guard(kwargs)
            except Exception:  # noqa: BLE001 — the guard fails open
                logger.exception("[ocuclaw] pre_tool_call Even AI clarify guard failed")
        try:
            adapter.handle_pre_tool_call(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break tools
            logger.exception("[ocuclaw] pre_tool_call activity glue failed")
    if directive is None:
        directive = _task_uses_directive(kwargs)
    if directive is None:
        directive = _task_mcp_pause_directive(kwargs)
    return directive


def _task_mcp_pause_directive(kwargs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """#6679: a Task run's MCP call gets its own pause, never another run's (task_mcp_pause.py).

    Last, so it sees only calls that will run: a call it lets through is the one it counts.
    """
    try:
        return TASK_MCP_PAUSE.before_call(kwargs, tool_call_mcp)
    except Exception:  # noqa: BLE001 — a hook raise must never break tools
        logger.exception("[ocuclaw] pre_tool_call task MCP pause failed")
        return None


def _link_adapter() -> Any:
    """The adapter whose control link a process-wide hook asks, or None.

    An adapter stays in ``_ADAPTERS`` after its link is gone (a reconnect or a
    newer bundle import builds another), so the newest one with a live link is
    asked; with none live, the newest that can ask. The Task check fails closed
    on an OcuClaw chat (DeepSec finding_2db4afd2955e3604), so asking a dead
    link first would hold every glasses chat's tools.
    """
    adapters = [a for a in reversed(list(_ADAPTERS))
                if callable(getattr(a, "_request_link_threadsafe", None))]
    return next((a for a in adapters if _link_ready(a)),
                next((a for a in adapters if getattr(a, "_link", None) is not None),
                     adapters[0] if adapters else None))


def _link_ready(adapter: Any) -> bool:
    """True when the adapter's child is up and has said ``runtime.ready``, which it sends only
    after it registered its link methods (hermes-runtime-entry.ts bootRelay)."""
    link = getattr(adapter, "_link", None)
    if link is None or getattr(link, "ready", False) is not True:
        return False
    event = getattr(adapter, "_runtime_ready_event", None)
    return event is None or event.is_set()


def _ready_link_requester() -> Any:
    """The link request of the newest adapter whose child is ready, or None."""
    for adapter in reversed(list(_ADAPTERS)):
        request = getattr(adapter, "_request_link_threadsafe", None)
        if callable(request) and _link_ready(adapter):
            return request
    return None


def _task_uses_request(method: str, params: Any, *, timeout_s: float) -> Any:
    """PR #7647 review: the Task check waits, inside its budget, for a ready child (one starting,
    restarting or reconnecting has not registered ``task.uses.check`` yet) rather than holding
    an in-flight turn's call at once."""
    return ready_link_request(_ready_link_requester, method, params, timeout_s=timeout_s)


def _task_uses_directive(kwargs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """#6422: hold a Task run to its "What it uses" list (task_uses_hook.py).

    Runs in any process that loaded the plugin: with no live adapter (a
    ``hermes cron run`` from a terminal) a Task's cron run is refused, not let
    through, because nothing can check its list. Never lets a call through on a
    raise: Hermes's hook runner would swallow it and run the call.
    """
    try:
        adapters = list(_ADAPTERS)
        for candidate in adapters:
            background = getattr(candidate, "_background_hook_turn", None)
            if callable(background) and background(kwargs):
                # Hermes's own background review forks share the session, not the Task's turn.
                return None
        adapter = _link_adapter()
        rpc = getattr(adapter, "_session_rpc", None) if adapter is not None else None
        return task_uses_block(
            kwargs,
            request=_task_uses_request if adapter is not None else None,
            row_by_id=getattr(rpc, "row_by_id", None) if rpc is not None else None,
            platform=PLATFORM_NAME,
            mcp_of=tool_call_mcp,
            has_adapter=bool(adapters),
        )
    except Exception:  # noqa: BLE001 — a hook raise must never break tools, nor let a Task's run
        logger.exception("[ocuclaw] pre_tool_call task uses check failed")
        return task_uses_unchecked_directive()


def _on_post_tool_call_hook(**kwargs: Any) -> None:
    """Hermes ``post_tool_call`` observer. Emits tool-result/error activity, and counts a Task
    run's own MCP failures (#6679, task_mcp_pause.py)."""
    try:
        TASK_MCP_PAUSE.after_call(kwargs)
    except Exception:  # noqa: BLE001 — a hook raise must never break tools
        logger.exception("[ocuclaw] post_tool_call task MCP pause failed")
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_post_tool_call(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break tools
            logger.exception("[ocuclaw] post_tool_call activity glue failed")


def _on_post_api_request_hook(**kwargs: Any) -> None:
    """Hermes ``post_api_request`` observer. Emits native reasoning summaries."""
    _remember_approval_agent_turn(kwargs)
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_post_api_request(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] post_api_request reasoning glue failed")


def _on_post_llm_call_hook(**kwargs: Any) -> None:
    """Observe the native final response without changing stored/model text."""
    try:
        # #6678: a Task's cron run that declared [CRON_FAILURE] keeps its evidence for the rows.
        task_run_prompt.note_agent_failure(kwargs)
    except Exception:  # noqa: BLE001 - observations never affect delivery
        logger.exception("[ocuclaw] post_llm_call task agent failure note failed")
    try:
        # #6673: an Alert run's answer tells the child what it saw; its verdict decides its delivery.
        linked = _link_adapter()
        task_alert_state.note_run_answer(
            kwargs, request=linked._request_link_threadsafe if linked is not None else None,
        )
    except Exception:  # noqa: BLE001 - observations never affect delivery
        logger.exception("[ocuclaw] post_llm_call task alert verdict failed")
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_post_llm_call(kwargs)
        except Exception:  # noqa: BLE001 - observations never affect delivery
            logger.exception("[ocuclaw] post_llm_call completed-reply glue failed")


def _emit_aux_call_debug(phase: str, data: Dict[str, Any]) -> None:
    """One auxiliary attempt for the child's `token.aux` debug category
    (#5046). Metadata only (aux_usage.attempt_fields); fire-and-forget."""
    for adapter in list(_ADAPTERS):
        try:
            adapter._emit_frame(AUX_CALL_DEBUG_METHOD, {"phase": phase, **data})
        except Exception:  # noqa: BLE001 — debug frames are best-effort
            logger.debug("[ocuclaw] aux call debug frame failed", exc_info=True)


def _on_api_request_error_hook(**kwargs: Any) -> None:
    """Hermes ``api_request_error`` observer (H11, #3348).

    Fires for every failed model-call attempt. Its terminal half covers the
    path that has no other signal: a provider failure the engine will not
    retry, which escapes before ``finalize_turn`` and therefore before
    ``on_session_end`` and ``post_api_request``. Every attempt also ends its
    ``model_call`` run signal, and may open a ``retry_wait``.
    """
    for adapter in list(_ADAPTERS):
        try:
            adapter.handle_api_request_error(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] api_request_error glue failed")


def _fan_out_run_signal(handler_name: str, kwargs: Dict[str, Any]) -> None:
    """Route one run-signal hook to every live adapter that can take it."""
    for adapter in list(_ADAPTERS):
        # A live adapter built by an older bundle import (#3625) has no
        # run-signal handler; it simply emits nothing instead of raising on
        # every model call.
        handler = getattr(adapter, handler_name, None)
        if not callable(handler):
            continue
        try:
            handler(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] %s run-signal glue failed", handler_name)


def _on_pre_api_request_hook(**kwargs: Any) -> None:
    """Hermes ``pre_api_request`` observer: the ``model_call`` start edge.

    Fires before EVERY main-loop model call on the gateway, once per physical
    attempt; the handler drops a foreign platform before any lookup.
    """
    _fan_out_run_signal("handle_pre_api_request", kwargs)


def _on_pre_auxiliary_call_hook(**kwargs: Any) -> None:
    """Hermes ``pre_auxiliary_call`` observer (0.21.5+): compaction start.

    Fires for every auxiliary provider attempt (titling, vision, MoA, ...);
    the handler returns at once unless ``aux_task`` is compression.
    """
    _fan_out_run_signal("handle_auxiliary_call_start", kwargs)
    _call_aux_usage_hook(aux_usage.PRE_AUXILIARY_CALL_HOOK_NAME, kwargs)


def _on_post_auxiliary_call_hook(**kwargs: Any) -> None:
    """Hermes ``post_auxiliary_call`` observer (0.21.5+): compaction end."""
    _fan_out_run_signal("handle_auxiliary_call_end", kwargs)
    _call_aux_usage_hook(aux_usage.POST_AUXILIARY_CALL_HOOK_NAME, kwargs)


# OcuClaw's own aux-call counters (#5046), filled by register(). They ride the
# two handlers above so each auxiliary hook has one callback; they never raise.
_AUX_USAGE_HOOKS: Dict[str, Any] = {}


def _call_aux_usage_hook(name: str, kwargs: Dict[str, Any]) -> None:
    callback = _AUX_USAGE_HOOKS.get(name)
    if callback is not None:
        callback(**kwargs)


def _on_compaction_event(event: Dict[str, Any]) -> None:
    """One committed compaction, already in the ledger (compaction_ledger's
    ``post_compaction`` observer). Runs inside Hermes' commit window with the
    session's lease held, so each adapter only starts its own worker here."""
    for adapter in list(_ADAPTERS):
        handler = getattr(adapter, "handle_post_compaction", None)
        if not callable(handler):
            continue
        try:
            handler(event)
        except Exception:  # noqa: BLE001 - a hook raise must never fail a compaction
            logger.exception("[ocuclaw] post_compaction glue failed")


def _on_subagent_start_hook(**kwargs: Any) -> None:
    """Hermes ``subagent_start`` observer: a delegated child agent opens."""
    _fan_out_run_signal("handle_subagent_start", kwargs)


def _on_subagent_stop_hook(**kwargs: Any) -> None:
    """Hermes ``subagent_stop`` observer (parent thread, once per child when
    ``delegate_task`` collects the batch): the child's span ends."""
    _fan_out_run_signal("handle_subagent_stop", kwargs)


def _run_signal_hook_plan(names: frozenset) -> Tuple[Tuple[str, Any], ...]:
    """The run-signal hooks this host's vocabulary can take, in manifest order.

    Probed like every optional hook (`register_hook` stores an unknown name
    with a warning instead of refusing it). A pair is wired whole or not at
    all, so no span can open on a host that could never end it.
    """
    plan: List[Tuple[str, Any]] = []
    if PRE_API_REQUEST_HOOK_NAME in names:
        plan.append((PRE_API_REQUEST_HOOK_NAME, _on_pre_api_request_hook))
    if all(name in names for name in SUBAGENT_HOOK_NAMES):
        plan.extend(
            zip(SUBAGENT_HOOK_NAMES, (_on_subagent_start_hook, _on_subagent_stop_hook))
        )
    if all(name in names for name in AUXILIARY_CALL_HOOK_NAMES):
        plan.extend(
            zip(
                AUXILIARY_CALL_HOOK_NAMES,
                (_on_pre_auxiliary_call_hook, _on_post_auxiliary_call_hook),
            )
        )
    return tuple(plan)


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
    _remember_approval_user_message(kwargs)
    try:
        # #6378: the user's own words, for the setup chat yes check.
        from . import setup_chat_approvals

        setup_chat_approvals.record_pre_llm_call(kwargs)
    except Exception:  # noqa: BLE001 - a missed message is an unconfirmed yes
        logger.debug("[ocuclaw] setup chat message capture failed", exc_info=True)
    # #6678: a Task's scheduled run gets this run's words (a cron turn; the adapters skip it).
    task_context = _task_run_prompt_context(kwargs)
    # Which "card" or "task" the wearer means, while the agent has the Board tools.
    words = board_tools.words_line(kwargs)
    lead = "\n\n".join(part for part in (task_context, words) if part)
    context = lead
    for adapter in list(_ADAPTERS):
        try:
            liveui = adapter.handle_pre_llm_call(kwargs)
        except Exception:  # noqa: BLE001 — a hook raise must never break turns
            logger.exception("[ocuclaw] pre_llm_call liveui glue failed")
            continue
        if liveui:
            context = f"{lead}\n\n{liveui}" if lead else liveui
            break
    # Hermes cuts any ONE hook result over its cap down to its two ends
    # (hook_context.py). A longer turn goes out as this result and the ones
    # _PRE_LLM_CALL_PIECES.callbacks return, which Hermes joins back together.
    first = _PRE_LLM_CALL_PIECES.first(kwargs, context, hook_context.spill_cap())
    return {"context": first} if first else None


_PRE_LLM_CALL_PIECES = hook_context.TurnPieces()


def _task_run_prompt_context(kwargs: Dict[str, Any]) -> Optional[str]:
    """#6678: the child's per-run words for a Task's cron run (task_run_prompt.py), or None."""
    adapter = _link_adapter()
    try:
        return task_run_prompt.task_run_prompt_context(
            kwargs, request=adapter._request_link_threadsafe if adapter is not None else None,
        )
    except Exception:  # noqa: BLE001 — a hook raise must never break turns
        logger.exception("[ocuclaw] pre_llm_call task run prompt failed")
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


# Plain-English approval cards (approval_explain.py). The hooks below run on
# the agent thread; `_handle_gateway_approval` reads the store on the loop.
_APPROVAL_CONTEXT = ApprovalContextStore()
# The wearer's "Explain commands" setting, pushed by the child over
# APPROVAL_EXPLAIN_SETTING_METHOD; on until it says otherwise.
_APPROVAL_EXPLAIN_SETTING = ApprovalExplainSetting()
_APPROVAL_PURPOSE_MIDDLEWARE_REGISTERED = False


def _is_ocuclaw_platform(platform: Any) -> bool:
    return str(platform or "").strip() == PLATFORM_NAME


def _ocuclaw_turn_session_key(kwargs: Mapping[str, Any]) -> str:
    """The native session key of an OcuClaw foreground turn, else ""."""
    if not _is_ocuclaw_platform(kwargs.get("platform")):
        return ""
    if str(kwargs.get("parent_session_id") or "").strip():
        return ""
    session_key = _current_hermes_session_key()
    if parse_ocuclaw_session_key(session_key) is None:
        return ""
    return session_key


def _remember_approval_user_message(kwargs: Mapping[str, Any]) -> None:
    try:
        session_key = _ocuclaw_turn_session_key(kwargs)
        if session_key:
            _APPROVAL_CONTEXT.record_user_message(
                session_key, kwargs.get("user_message")
            )
    except Exception:  # noqa: BLE001 - context is optional, turns are not
        logger.debug("[ocuclaw] approval user-message capture failed", exc_info=True)


def _assistant_reasoning_text(assistant_message: Any) -> str:
    for field in ("reasoning", "reasoning_content"):
        value = (
            assistant_message.get(field)
            if isinstance(assistant_message, Mapping)
            else getattr(assistant_message, field, None)
        )
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _remember_approval_agent_turn(kwargs: Mapping[str, Any]) -> None:
    try:
        session_key = _ocuclaw_turn_session_key(kwargs)
        if session_key:
            message = kwargs.get("assistant_message")
            _APPROVAL_CONTEXT.record_assistant_message(
                session_key, message, _assistant_reasoning_text(message)
            )
    except Exception:  # noqa: BLE001 - context is optional, turns are not
        logger.debug("[ocuclaw] approval agent-text capture failed", exc_info=True)


def _on_pre_approval_request_hook(**kwargs: Any) -> None:
    """Hermes ``pre_approval_request`` observer. Ties the approval the gateway
    is about to send us to its tool call, so the card can carry that call's
    ``purpose``. Fires on the agent thread right before the gateway notify."""
    try:
        session_key = str(kwargs.get("session_key") or "").strip()
        if parse_ocuclaw_session_key(session_key) is None:
            return
        _APPROVAL_CONTEXT.record_approval_request(
            session_key,
            str(kwargs.get("command") or ""),
            str(kwargs.get("tool_call_id") or ""),
        )
    except Exception:  # noqa: BLE001 - a hook raise must never break approvals
        logger.debug("[ocuclaw] pre_approval_request glue failed", exc_info=True)


def _approval_command_redactor() -> Optional[Callable[[str], str]]:
    """The gateway's own display redaction, so a raw hook command can be
    matched to the redacted command `send_exec_approval` receives."""
    try:
        from gateway.run import _redact_approval_command
    except Exception:  # noqa: BLE001 - matching falls back to the newest request
        return None
    return _redact_approval_command if callable(_redact_approval_command) else None


def _approval_purpose_middleware_supported(ctx: Any) -> bool:
    if not callable(getattr(ctx, "register_middleware", None)):
        return False
    try:
        from hermes_cli.middleware import (
            LLM_REQUEST_MIDDLEWARE,
            TOOL_REQUEST_MIDDLEWARE,
            VALID_MIDDLEWARE,
        )
    except Exception:  # noqa: BLE001 - probing must never break plugin load
        return False
    return {LLM_REQUEST_MIDDLEWARE, TOOL_REQUEST_MIDDLEWARE} <= set(VALID_MIDDLEWARE)


def _register_approval_purpose(ctx: Any, register_hook: Any) -> None:
    """Wire the purpose field and approval context where the host has the
    seams (Hermes 0.21.5: request middleware and ``pre_approval_request``)."""
    global _APPROVAL_PURPOSE_MIDDLEWARE_REGISTERED
    _APPROVAL_PURPOSE_MIDDLEWARE_REGISTERED = False
    if callable(register_hook) and APPROVAL_REQUEST_HOOK_NAME in _valid_hook_names():
        register_hook(APPROVAL_REQUEST_HOOK_NAME, _on_pre_approval_request_hook)
    if not _approval_purpose_middleware_supported(ctx):
        return
    from hermes_cli.middleware import LLM_REQUEST_MIDDLEWARE, TOOL_REQUEST_MIDDLEWARE

    # Strip first and on every platform: a `purpose` can then never reach a
    # guard, whichever surface a session's history came from.
    ctx.register_middleware(
        TOOL_REQUEST_MIDDLEWARE, make_tool_request_middleware(_APPROVAL_CONTEXT)
    )
    # The schema field only while "Explain commands" is on: no extra tokens
    # when the wearer turned it off. The strip above stays on regardless.
    ctx.register_middleware(
        LLM_REQUEST_MIDDLEWARE,
        make_llm_request_middleware(
            _is_ocuclaw_platform, _APPROVAL_EXPLAIN_SETTING.is_enabled
        ),
    )
    _APPROVAL_PURPOSE_MIDDLEWARE_REGISTERED = True


# Waiting on you (#4979). One table per process, like the hooks that feed it:
# every live adapter here serves the same Hermes home and gets the same list.
def _emit_waiting(payload: Dict[str, Any]) -> None:
    for adapter in list(_ADAPTERS):
        try:
            adapter._emit_event(human_input_waiting.WAITING_EVENT_NAME, payload)
        except Exception:  # noqa: BLE001 - one adapter must not starve the rest
            logger.debug("[ocuclaw] waiting emit failed", exc_info=True)


def _waiting_session_row(session_id: str) -> Optional[Mapping[str, Any]]:
    for adapter in list(_ADAPTERS):
        rpc = getattr(adapter, "_session_rpc", None)
        if rpc is not None:
            # #4981: with the lineage root, so the item can name its chat's public key.
            read = getattr(rpc, "waiting_row", None) or rpc.row_by_id
            return read(session_id)
    return None


def _waiting_screen_ask(session_id: str, session_key: str) -> bool:
    """#5151: the clarify's turn used the bot's screen, in any live adapter."""
    for adapter in list(_ADAPTERS):
        turns = getattr(adapter, "_bot_screen_turns", None)
        if turns is not None and turns.used(session_id=session_id, session_key=session_key):
            return True
    return False


def _waiting_user_message(session_id: str) -> Optional[str]:
    """#4985: a local chat's last user message, for the approval explainer
    only (never the app). One indexed read of the transcript's newest rows."""
    for adapter in list(_ADAPTERS):
        rpc = getattr(adapter, "_session_rpc", None)
        if rpc is not None:
            read = getattr(rpc, "last_user_message", None)
            if not callable(read):
                return None
            return user_message_context(read(session_id)) or None
    return None


_HUMAN_INPUT_WAITING = human_input_waiting.HumanInputWaiting(
    emit=_emit_waiting,
    settings=human_input_waiting.WaitingSettings(),
    is_ocuclaw_session=lambda key: parse_ocuclaw_session_key(key) is not None,
    session_row=_waiting_session_row,
    config=lambda: _setup_raw_config()[0],
    screen_ask=_waiting_screen_ask,
    # #4985: approval items carry the explainer's input only while "Explain
    # commands" is on, the same setting the native approval card follows.
    explain_on=_APPROVAL_EXPLAIN_SETTING.is_enabled,
    user_message=_waiting_user_message,
)
# Set by register(): both human-input hooks are wired on this host.
_HUMAN_INPUT_WAITING_REGISTERED = False


def _register_human_input_waiting(register_hook: Any) -> bool:
    """Wire both hooks where the host's vocabulary has both (0.21.6+)."""
    names = _valid_hook_names()
    if not callable(register_hook) or not all(
        name in names for name in HUMAN_INPUT_HOOK_NAMES
    ):
        return False
    register_hook(HUMAN_INPUT_HOOK_NAMES[0], _HUMAN_INPUT_WAITING.on_request)
    register_hook(HUMAN_INPUT_HOOK_NAMES[1], _HUMAN_INPUT_WAITING.on_resolved)
    return True


def _waiting_settings_reply(params: Any) -> Dict[str, Any]:
    """``waiting.settings`` link handler body."""
    _HUMAN_INPUT_WAITING.apply_settings(params)
    return {
        "ok": True,
        "supported": _HUMAN_INPUT_WAITING_REGISTERED,
        "availableSurfaces": human_input_waiting.available_messaging_surfaces(
            (PLATFORM_NAME,)
        ),
    }


def _waiting_answer_reply(params: Any) -> Dict[str, Any]:
    """``waiting.answer`` link handler body (#4983). Blocking Hermes reads and
    resolves: the handler runs it off the loop, like the approval resolve."""
    return _HUMAN_INPUT_WAITING.answer(params)


# "webui" (#6377): the Cloudways Hermes web UI chat, where chat-first setup runs.
_HOST_SETUP_INTERFACES = frozenset({"local", "cli", "tui", "desktop", "webui"})


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


def _host_setup_surface() -> str:
    """Name the host surface for the Desktop- and TUI-only setup steps.

    Hermes 0.22.1+ runs Desktop chat and TUI turns as gateway local routes in
    the shared gateway daemon. The turn carries ``HERMES_SESSION_PLATFORM=local``
    and no source. The route's frozen launch policy still names its surface
    (``gui`` launches as ``desktop``, ``tui`` as ``tui``). Hermes 0.22.3+ hands
    it to plugins as the documented ``ctx.session_surface()``; 0.22.1 has no
    public accessor, so there it is read from
    ``gateway.session_policy.active_policy()``, the policy of the turn running
    in this context. Only ``desktop`` and ``tui`` are taken from either. Any
    other surface (``cli``, ``acp``), a missing policy, or an engine without
    either accessor (before 0.22.1) leaves ``local``, which stays refused.
    Every other interface passes through unchanged.
    """

    interface = _current_hermes_interface()
    if interface != "local":
        return interface
    session_surface = getattr(_PLUGIN_CONTEXT, "session_surface", None)
    if callable(session_surface):
        platform = session_surface()
    else:
        try:
            from gateway.session_policy import active_policy
        except ImportError:
            return interface
        platform = getattr(active_policy(), "platform", None)
    return platform if platform in ("desktop", "tui") else interface


def _liveui_state_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    adapter = _connected_adapter()
    return adapter.handle_liveui_state_tool_call(args)


def _liveui_template_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    adapter = _connected_adapter()
    return adapter.handle_liveui_template_tool_call(args)


def _liveui_task_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    adapter = _connected_adapter()
    return adapter.handle_liveui_task_tool_call(args)


def _liveui_compose_tool_handler(args: Dict[str, Any], **_kwargs: Any) -> str:
    adapter = _connected_adapter()
    return adapter.handle_liveui_compose_tool_call(args)


def _liveui_descriptor_from_hello(
    hello: Dict[str, Any], tool_name: str
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


def provided_tool_inventory() -> Dict[str, Any]:
    """Which of this bundle's tools actually registered (#2804).

    One helper, two readers: the `ocuclaw_setup` status block and the
    `hermes ocuclaw` doctor report. Before this, both surfaces reported a
    healthy install while a tool the manifest promises had silently failed to
    register — which is exactly how OCU-K3FQ-F76X reached a wearer: the
    location tool shipped in the bundle and nothing on the Hermes side bound
    it, and no diagnostic said so.

    ``expected`` is the manifest list in manifest order. ``registered`` is what
    this process observed registering, in the same order. ``missing`` is the
    difference, so a hello that carries no ``phoneTools`` at all (an older
    child against a newer adapter) shows up as three named absences rather
    than a crash or a false green.

    ``observed`` is the honesty guard, and it is load-bearing. Registration
    state lives in module globals of the process that did the registering: the
    gateway. `hermes ocuclaw status|doctor` runs in its OWN process, where
    plugin discovery imports this module and `register()` binds the setup tool
    but no platform ever connects, so every tool but the setup tool would read
    as absent on a perfectly healthy host. A diagnostic that cries wolf is
    worse than no diagnostic, so ``observed`` is False whenever no adapter
    instance has connected in this process, and the readers report the
    inventory as unobservable rather than as a list of failures.
    """
    registrations: Dict[str, bool] = {
        LIVEUI_STATE_TOOL_NAME: _LIVEUI_STATE_TOOL_REGISTERED,
        LIVEUI_TEMPLATE_TOOL_NAME: _LIVEUI_TEMPLATE_TOOL_REGISTERED,
        LIVEUI_TASK_TOOL_NAME: _LIVEUI_TASK_TOOL_REGISTERED,
        LIVEUI_COMPOSE_TOOL_NAME: _LIVEUI_COMPOSE_TOOL_REGISTERED,
        SETUP_TOOL_NAME: _SETUP_TOOL_REGISTERED,
    }
    for name in PHONE_TOOL_ORDER:
        registrations[name] = bool(_PHONE_TOOL_REGISTERED.get(name))
    # A flag says this module registered the tool once; the registry says
    # whether Hermes still holds it. After a forced plugin rediscovery
    # (OCU-1E6C-EEX1) the hello-driven flags are stale, and the inventory must
    # not report a tool the model cannot reach. The setup tool is exempt:
    # register() re-adds it on every load, so its flag never drifts.
    for name, flagged in list(registrations.items()):
        if name == SETUP_TOOL_NAME or not flagged:
            continue
        if _registry_has_tool(name) is False:
            registrations[name] = False
    # Two independent proofs that this process is the registering one, because
    # either alone has a blind spot: a received runtime hello covers the
    # gateway whose tools ALL failed to register, and a runtime-advertised
    # registration covers the moment before the hello flag is read. The setup
    # tool is deliberately not a proof: it registers in the CLI process too.
    # Neither is a constructed adapter: the TUI's gateway child constructs one
    # and never receives a hello (see `_RUNTIME_HELLO_SEEN`).
    expected = list(PROVIDED_TOOL_NAMES)
    observed = _RUNTIME_HELLO_SEEN or any(
        registrations.get(name, False)
        for name in expected
        if name != SETUP_TOOL_NAME
    )
    registered = [name for name in expected if registrations.get(name, False)]
    missing = [name for name in expected if not registrations.get(name, False)]
    return {
        "expected": expected,
        "registered": registered,
        "missing": missing,
        "observed": observed,
    }


def missing_phone_tool_warnings(
    inventory: Optional[Mapping[str, Any]] = None,
) -> List[str]:
    """One warning line per phone tool the manifest promises and nothing bound.

    Phone tools only. The LiveUI names already have their own unregistered
    warning at hello time, and a setup tool that failed to register cannot be
    the thing printing about it.

    Silent when the inventory was not observed: a process that never registers
    tools has not witnessed a failure, it has witnessed nothing.
    """
    if inventory is None:
        inventory = provided_tool_inventory()
    if not isinstance(inventory, Mapping) or not inventory.get("observed"):
        return []
    raw_missing = inventory.get("missing") if isinstance(inventory, Mapping) else None
    missing = set(raw_missing) if isinstance(raw_missing, (list, tuple, set)) else set()
    return [
        f"[ocuclaw] phone tool {name!r} did not register"
        for name in PHONE_TOOL_ORDER
        if name in missing
    ]


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
                LIVEUI_STATE_TOOL_NAME,
                LIVEUI_TEMPLATE_TOOL_NAME,
                LIVEUI_TASK_TOOL_NAME,
                LIVEUI_COMPOSE_TOOL_NAME,
            )
            if isinstance(liveui.get(name), dict)
        ]
    registrations = {
        LIVEUI_STATE_TOOL_NAME: _LIVEUI_STATE_TOOL_REGISTERED,
        LIVEUI_TEMPLATE_TOOL_NAME: _LIVEUI_TEMPLATE_TOOL_REGISTERED,
        LIVEUI_TASK_TOOL_NAME: _LIVEUI_TASK_TOOL_REGISTERED,
        LIVEUI_COMPOSE_TOOL_NAME: _LIVEUI_COMPOSE_TOOL_REGISTERED,
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
    global _LIVEUI_STATE_TOOL_REGISTERED
    global _LIVEUI_TEMPLATE_TOOL_REGISTERED, _LIVEUI_TASK_TOOL_REGISTERED
    global _LIVEUI_COMPOSE_TOOL_REGISTERED
    with _LIVEUI_LOCK:
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
        # LiveUI V2 K6, K7: registered for the whole process like the others.
        # It is the only model render tool; V1's render_glasses_ui is retired.
        if not _LIVEUI_COMPOSE_TOOL_REGISTERED:
            _LIVEUI_COMPOSE_TOOL_REGISTERED = _register_liveui_descriptor_from_hello(
                hello,
                tool_name=LIVEUI_COMPOSE_TOOL_NAME,
                handler=_liveui_compose_tool_handler,
                log_label="liveui compose",
            )
        _warn_unregistered_liveui_descriptors(hello)


def _phone_tool_link_timeout_s(descriptor: Dict[str, Any]) -> float:
    """Link timeout for one phone-tool descriptor.

    The child owns the wait (ADR-0006): a declared ``linkTimeoutMs`` is the
    child's budget, and the adapter waits that long plus a margin so the
    child's own timeout is what the agent sees.
    """

    timeout_ms = descriptor.get("linkTimeoutMs")
    if isinstance(timeout_ms, (int, float)) and not isinstance(timeout_ms, bool):
        if timeout_ms > 0:
            return float(timeout_ms) / 1000.0 + PHONE_TOOL_LINK_MARGIN_S
    return PHONE_TOOL_DEFAULT_LINK_TIMEOUT_S


def _make_phone_tool_handler(tool_name: str, method: str, timeout_s: float) -> Any:
    """One generic forwarder per descriptor — no per-tool logic lives here."""

    def _handler(args: Dict[str, Any], **_kwargs: Any) -> str:
        adapter = _connected_adapter()
        return adapter.handle_phone_tool_call(
            args,
            tool_name=tool_name,
            method=method,
            timeout_s=timeout_s,
        )

    _handler.__name__ = f"_phone_tool_handler_{tool_name}"
    return _handler


def _register_phone_tools_from_hello(hello: Dict[str, Any]) -> None:
    """Register every allow-listed descriptor the child advertised.

    Data-driven by design (#2800): the next tickets add a descriptor on the
    Node side and a link method in the child, and nothing in this function
    changes. A hello without ``phoneTools`` is the pre-#2800 shape and boots
    exactly as before — no warnings, no extra log lines.
    """

    descriptors = hello.get("phoneTools") if isinstance(hello, dict) else None
    if not isinstance(descriptors, list):
        return
    with _LIVEUI_LOCK:
        for descriptor in descriptors:
            if not isinstance(descriptor, dict):
                logger.warning(
                    "[ocuclaw] phone tool descriptor is not an object; skipped"
                )
                continue
            name = str(descriptor.get("name") or "").strip()
            if name not in PHONE_TOOL_NAMES:
                logger.warning(
                    "[ocuclaw] phone tool descriptor unknown: name=%r; skipped",
                    name or "<missing>",
                )
                continue
            if _PHONE_TOOL_REGISTERED.get(name):
                continue
            schema = descriptor.get("schema")
            if not isinstance(schema, dict):
                logger.warning(
                    "[ocuclaw] phone tool %r has no schema; tool not registered",
                    name,
                )
                continue
            method = descriptor.get("method")
            if not isinstance(method, str) or not method.strip():
                logger.warning(
                    "[ocuclaw] phone tool %r declares no link method; "
                    "tool not registered",
                    name,
                )
                continue
            register_tool = _LIVEUI_REGISTER_TOOL
            if not callable(register_tool):
                logger.warning(
                    "[ocuclaw] ctx.register_tool unavailable; phone tool %r degraded",
                    name,
                )
                continue
            description = str(
                descriptor.get("description") or schema.get("description") or ""
            )
            register_tool(
                name=name,
                toolset=LIVEUI_TOOLSET,
                schema=schema,
                handler=_make_phone_tool_handler(
                    name,
                    method.strip(),
                    _phone_tool_link_timeout_s(descriptor),
                ),
                check_fn=(
                    _program_card_check_fn()
                    if name in PROGRAM_CARD_TOOL_NAMES
                    else check_ocuclaw_requirements
                ),
                is_async=False,
                description=description,
            )
            _PHONE_TOOL_REGISTERED[name] = True
            logger.info(
                "[ocuclaw] phone tool %r registered from runtime descriptor", name
            )


def _program_card_check_fn() -> Callable[[], bool]:
    """A fresh ``check_fn`` for the program card tools, one per registration.

    Hermes caches a ``check_fn`` verdict for 30 s by function identity, and
    keeps serving a True for 60 s after its last success. A new function per
    registration starts with neither, so a Staging flip lands at once.
    """

    def _program_cards_available() -> bool:
        return _PROGRAM_CARDS_STAGING and check_ocuclaw_requirements()

    return _program_cards_available


def _phone_only_dropped(presence: Dict[str, Any]) -> bool:
    """True when a presence pull's ``programCards: false`` only means no app is
    connected right now, while the card tools are shown.

    A phone that drops (the app in the background, a WebView reload) is not the
    Staging switch turning off. Hiding the card tools then refuses a build's
    write that the model spent minutes on, and the model gives up: the wearer
    gets no card. Kept shown, the write reaches the bridge, which answers
    ``no_client`` or keeps a draft, and a phone back in time takes the card.
    A connected app without programCardsV1 is the switch, and still hides them.
    """
    return (
        _PROGRAM_CARDS_STAGING
        and presence.get("programCards") is False
        and presence.get("authenticatedAppCount") == 0
    )


def set_program_cards_staging(enabled: bool) -> bool:
    """Show or hide the program card tools; True when the state changed.

    Hermes memoizes tool lists and keeps a built agent per session until its
    tool registry changes, so a ``check_fn`` alone would not be read again.
    Re-registering the card tools bumps the registry generation: the next turn
    rebuilds its tool list, and tool search, with the new verdict.
    """

    global _PROGRAM_CARDS_STAGING
    enabled = enabled is True
    with _LIVEUI_LOCK:
        if enabled == _PROGRAM_CARDS_STAGING:
            return False
        _PROGRAM_CARDS_STAGING = enabled
        hello = _LAST_RUNTIME_HELLO
        names = [name for name in PROGRAM_CARD_TOOL_NAMES if _PHONE_TOOL_REGISTERED.get(name)]
        if names and isinstance(hello, dict):
            for name in names:
                _PHONE_TOOL_REGISTERED.pop(name, None)
            _register_phone_tools_from_hello(hello)
        logger.info(
            "[ocuclaw] program card tools %s (Staging %s)",
            "shown" if enabled else "hidden",
            "on" if enabled else "off",
        )
        return True


def _hello_tool_names(hello: Any) -> List[str]:
    """Tool names a runtime hello can register: the LiveUI four whose
    descriptors are present, then every allow-listed ``phoneTools`` entry."""

    names: List[str] = []
    if not isinstance(hello, dict):
        return names
    for tool_name in (
        LIVEUI_STATE_TOOL_NAME,
        LIVEUI_TEMPLATE_TOOL_NAME,
        LIVEUI_TASK_TOOL_NAME,
        LIVEUI_COMPOSE_TOOL_NAME,
    ):
        if _liveui_descriptor_from_hello(hello, tool_name):
            names.append(tool_name)
    descriptors = hello.get("phoneTools")
    if isinstance(descriptors, list):
        for descriptor in descriptors:
            if not isinstance(descriptor, dict):
                continue
            name = str(descriptor.get("name") or "").strip()
            if name in PHONE_TOOL_NAMES and name not in names:
                names.append(name)
    return names


def _registry_has_tool(name: str) -> Optional[bool]:
    """Whether Hermes' tool registry holds ``name`` in this plugin's scope.

    None when there is nothing to check against: no bound ``ctx.register_tool``
    (tests, hosts where register() never ran) or an unreadable registry. The
    flags are trusted in that case, exactly as before.
    """

    ctx = getattr(_LIVEUI_REGISTER_TOOL, "__self__", None)
    manager = getattr(ctx, "_manager", None)
    if manager is None:
        return None
    try:
        from tools.registry import registry

        scope = getattr(manager, "scope_key", None)
        return registry.get_entry(name, scope=scope) is not None
    except Exception:  # noqa: BLE001 - a probe, never a failure path
        return None


def _forget_tool_registration(name: str) -> None:
    global _LIVEUI_STATE_TOOL_REGISTERED
    global _LIVEUI_TEMPLATE_TOOL_REGISTERED, _LIVEUI_TASK_TOOL_REGISTERED
    global _LIVEUI_COMPOSE_TOOL_REGISTERED
    if name == LIVEUI_STATE_TOOL_NAME:
        _LIVEUI_STATE_TOOL_REGISTERED = False
    elif name == LIVEUI_TEMPLATE_TOOL_NAME:
        _LIVEUI_TEMPLATE_TOOL_REGISTERED = False
    elif name == LIVEUI_TASK_TOOL_NAME:
        _LIVEUI_TASK_TOOL_REGISTERED = False
    elif name == LIVEUI_COMPOSE_TOOL_NAME:
        _LIVEUI_COMPOSE_TOOL_REGISTERED = False
    else:
        _PHONE_TOOL_REGISTERED.pop(name, None)


def _remember_runtime_hello(hello: Any) -> None:
    """Keep the runtime hello so a Hermes plugin reload can be healed later.

    OCU-1E6C-EEX1: Hermes 0.21.x re-runs plugin discovery with ``force=True``
    on several provider-miss paths (a ``text_to_speech`` call naming a TTS
    provider Hermes does not ship is one). That unloads every registration
    this plugin made and re-imports this module as a FRESH module object. The
    connected adapter, its hello and these one-shot flags stay behind in the
    old module, so nothing ever re-registers the hello-driven tools:
    ``tool_search`` stops listing them and glasses turns cannot render. The
    hello is the only state that can rebuild them, so it is kept here, and the
    flags are reset for any name the registry no longer holds so the hello
    registrars run again (a reconnect hello heals the same way).
    """

    global _LAST_RUNTIME_HELLO
    with _LIVEUI_LOCK:
        if isinstance(hello, dict):
            _LAST_RUNTIME_HELLO = hello
        for name in _hello_tool_names(hello):
            if _registry_has_tool(name) is False:
                _forget_tool_registration(name)


def ensure_hello_tools_registered(reason: str) -> int:
    """Re-register the hello-driven tools a Hermes plugin reload dropped.

    Cheap when nothing is wrong: one registry lookup per name under the lock.
    Runs before each inbound glasses turn, so the first turn after a reload
    already sees the tools (registering bumps the registry generation, which
    invalidates Hermes' tool-definition cache), and from the janitor so other
    surfaces heal within JANITOR_INTERVAL_SECONDS. Returns how many tools it
    put back.
    """

    with _LIVEUI_LOCK:
        hello = _LAST_RUNTIME_HELLO
        if not isinstance(hello, dict):
            return 0
        missing = [
            name
            for name in _hello_tool_names(hello)
            if _registry_has_tool(name) is False
        ]
        if not missing:
            return 0
        for name in missing:
            _forget_tool_registration(name)
        try:
            _register_liveui_tool_from_hello(hello)
            _register_phone_tools_from_hello(hello)
        except Exception:  # noqa: BLE001 - never fail the turn over a heal
            logger.exception(
                "[ocuclaw] re-registering tools after a Hermes plugin reload "
                "failed (%s)",
                reason,
            )
        still_missing = [
            name for name in missing if _registry_has_tool(name) is False
        ]
        healed = [name for name in missing if name not in still_missing]
        logger.warning(
            "[ocuclaw] re-registered %d tool(s) after a Hermes plugin reload "
            "(%s): %s%s",
            len(healed),
            reason,
            ", ".join(healed) or "none",
            "; still missing: " + ", ".join(still_missing) if still_missing else "",
        )
        return len(healed)


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
            "a LiveUI template render can wait up to %.0fs on the liveui link, "
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
            "a LiveUI template render can wait up to %.0fs on the liveui link",
            raw,
            required_s,
        )
        return
    if value > 0 and value < required_s:
        logger.warning(
            "[ocuclaw] HERMES_CONCURRENT_TOOL_TIMEOUT_S=%.0fs is below "
            "the %.0fs LiveUI template render link budget; long renders may "
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


def fast_tier_reaches_route(
    model: Optional[str], provider: Optional[str], base_url: Optional[str]
) -> Optional[bool]:
    """Whether a turn on this route would carry the Fast tier; None when unknown (#7135).

    Hermes's own gate (``resolve_fast_mode_overrides``) passes only a model
    with a Fast tier on the first-party endpoint that bills for it. A turn
    carries the tier only there on every supported Hermes; from 0.22.0
    ``/fast`` asks the same gate with the session's route and answers a
    refusal in the chat ("/fast is only available for ..."), so a route behind
    a proxy or another provider must not be offered Fast, nor switched to it
    for a card build. A provider that config.yaml leaves to Hermes ("auto" or
    unset) is not judged: only the endpoint is, when one is named. This reads
    the route as config.yaml names it, not as Hermes resolves it at run time.
    """
    model_id = str(model or "").strip()
    if not model_id:
        return None
    route_provider = str(provider or "").strip()
    if route_provider.lower() == "auto":
        route_provider = ""
    route_url = str(base_url or "").strip()
    if not route_provider and not route_url:
        return None
    try:
        from hermes_cli.models import resolve_fast_mode_overrides

        return resolve_fast_mode_overrides(
            model_id,
            provider=route_provider or None,
            base_url=route_url or None,
        ) is not None
    except Exception:  # noqa: BLE001 - Hermes-version-sensitive; unknown stays unknown
        return None


def parse_version(raw: str) -> Optional[Tuple[int, int, int]]:
    """Parse ``major.minor.patch`` (extra suffixes tolerated) or None."""
    return health_collect.parse_version(raw)


def hermes_version_supported(raw: str) -> bool:
    return health_collect.hermes_version_supported(raw)


def _supported_hermes_range() -> str:
    return health_collect.supported_hermes_range()


def _unsupported_hermes_message(version: str) -> str:
    if parse_version(version) is None:
        return (
            f"{health_collect.HERMES_VERSION_UNKNOWN_HINT}; the Backend "
            "Adapter and Node child will not start"
        )
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


def _setup_toolset() -> str:
    parsed = parse_version(_hermes_version())
    if parsed is not None and parsed < DEDICATED_SETUP_TOOLSET_MIN:
        return LEGACY_SETUP_TOOLSET
    return SETUP_TOOLSET


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


def ensure_ocuclaw_requirements() -> bool:
    """Registry ``ensure_deps_fn``: have Hermes install the Node it will run.

    From Hermes 0.21.6 the Node helper returns only Node that Hermes' package
    manager installed, so ``check_ocuclaw_requirements`` is False on a host
    where it has not installed Node yet. Hermes calls this from
    ``create_adapter()`` only then, when the gateway is about to start an
    enabled OcuClaw platform; the check itself stays passive, so a status
    display never installs anything. Lazy installs follow the operator's
    ``security.allow_lazy_installs``. Never falls back to a PATH Node:
    Hermes forbids mixing toolchains.
    """
    if not _host_version_supported():
        return False
    if _find_node() is not None:
        return True
    try:
        from pm import ensure

        ensure("node")
    except Exception as exc:  # noqa: BLE001 - refused or failed; the registry hard-blocks
        logger.warning(
            "[ocuclaw] Hermes could not install Node.js for the OcuClaw runtime: %s",
            exc,
        )
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


TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY"


def _resolve_liveui_jev(raw: Dict[str, Any], saved_key: str = "") -> Dict[str, Any]:
    """Project ``platforms.ocuclaw.extra.liveuiJev`` for the Node child.

    The flag sends the wearer's words to a third party, so only a literal
    true (or the string "true") arms it, matching the OpenClaw lane. The flag
    is the consent: the phone's LiveUI switch writes it (the optional-setup
    ``liveui_jev`` permission). Saving a key never arms LiveUI Jev by itself.

    One saved TypeSafe key serves every Jev feature. ``saved_key`` is the
    ``OCUCLAW_TYPESAFE_API_KEY`` the wearer saved from the phone or
    `hermes ocuclaw optional-setup save typesafe`, the same value
    ``_resolve_bot_screen_jev`` and ``_resolve_program_cards_jev`` get. It wins; the deployment-time
    ``TYPESAFE_API_KEY`` (Hermes-managed env store, process environment as
    the fallback) is the fallback, so removing the saved key falls back to it
    or to no key. A ``liveuiJev.apiKey`` in ``config.yaml`` is ignored, like
    every other yaml secret. It is resolved here because the child's env is
    an allowlist that never carries it, and only when the flag is armed, so a
    disabled feature never puts the secret on the pipe.

    ``budgetMs`` is forwarded only when finite (a NaN would make the handshake
    frame unparseable); the relay owns the clamp and default.
    """
    flag = raw.get("enabled")
    enabled = flag is True or flag == "true"
    budget = raw.get("budgetMs")
    finite = (
        isinstance(budget, (int, float))
        and not isinstance(budget, bool)
        and math.isfinite(budget)
    )
    return {
        "enabled": enabled,
        "apiKey": (saved_key or _typesafe_api_key()) if enabled else "",
        "budgetMs": budget if finite else None,
    }


def _typesafe_api_key() -> str:
    # Only through Hermes (catalogue rule 11): the profile scope, then the
    # process environment on a single-profile gateway.
    return secret_access.read_secret(TYPESAFE_API_KEY_ENV)


def _resolve_program_cards_jev(raw: Any, saved_key: str = "") -> Dict[str, Any]:
    """Project ``platforms.ocuclaw.extra.programCardsJev`` for the Node child.

    Jev in program cards lets a programmable card ask Jev the questions it declares,
    and each ask sends the data that card declares to a third party. On by default
    (``_program_card_switch_enabled``) until the phone's Jev in cards switch (the
    optional-setup ``program_cards_jev`` permission) writes it off. Without a key it
    cannot call, and each card still needs the wearer's yes.

    The key resolves as for LiveUI Jev: the saved ``OCUCLAW_TYPESAFE_API_KEY``
    first, then the deployment-time ``TYPESAFE_API_KEY``, and only when the flag is
    armed. A ``programCardsJev.apiKey`` in ``config.yaml`` is ignored. No budget: the
    program-card engine owns its per-ask limit.
    """
    enabled = _program_card_switch_enabled(raw)
    return {
        "enabled": enabled,
        "apiKey": (saved_key or _typesafe_api_key()) if enabled else "",
    }


def _program_card_switch_enabled(raw: Any) -> bool:
    """A card capability switch (Jev, MCP or Models in cards), Matt 2026-10-27.

    On until the owner says otherwise: no block, or no ``enabled`` in it, reads on;
    an explicit value wins, and only a literal true (or the string "true") is on.
    A hand-edited block that is not a map still reads off, as it always has. The
    switch is not the consent: each card still needs the wearer's yes for its own
    block, so a default-on switch only lets a card ask.
    """
    if raw is None:
        return True
    if not isinstance(raw, dict):
        return False
    flag = raw.get("enabled")
    if flag is None or flag == "":
        return True
    return flag is True or flag == "true"


def _resolve_program_cards_mcp(raw: Any) -> Dict[str, Any]:
    """Project ``platforms.ocuclaw.extra.programCardsMcp`` for the Node child.

    MCP in program cards lets a programmable card read the owner's MCP tools
    through this plugin's ``ctx.call_mcp`` (card_mcp.py). On by default
    (``_program_card_switch_enabled``) until the phone's MCP in cards switch (the
    optional-setup ``program_cards_mcp`` permission) writes it off. Models in cards
    (``programCardsModel``) uses the same projection. Each server still needs the
    owner's per-server switch, and each card the wearer's yes. No key and no
    budget: the program-card engine owns its limits.

    ``hostCommands`` lets cards read the owner's approved commands on this
    host as server ``host``. On by default (Matt, 2026-11-07), by the same rule
    as the switch: unset reads on, an explicit value wins and only a literal
    true (or "true") is on. Off goes to the child as ``hostCommands: False``,
    because the child reads a missing key as on. Only the MCP engine reads it.
    """
    out: Dict[str, Any] = {"enabled": _program_card_switch_enabled(raw)}
    if not _host_commands_switch_on(raw):
        out["hostCommands"] = False
    return out


def _host_commands_switch_on(raw: Any) -> bool:
    """Host commands for cards: on unless the block writes ``hostCommands`` off."""
    if raw is None:
        return True
    if not isinstance(raw, dict):
        # A block that is not a map already reads the whole switch off.
        return True
    flag = raw.get("hostCommands")
    if flag is None or flag == "":
        return True
    return flag is True or flag == "true"


def _resolve_bot_screen_jev(raw: Dict[str, Any], saved_key: str = "") -> Dict[str, Any]:
    """Project ``platforms.ocuclaw.extra.botScreenJev`` for the Node child.

    The Bot Screen's Jev mode (Matt, 2026-10-20) sends the wearer's spoken target and
    full-colour pictures of the bot's screen to TypeSafe, and only while that wearer holds
    the screen. Only a literal true (or the string "true") arms it. A saved TypeSafe key
    is never a consent, so a key saved for LiveUI or program cards never arms the Bot
    Screen (Matt, 2026-10-31). The wearer's Jev mode switch in the app is the per-use
    consent.

    The key is resolved here, and only when armed, so a disabled feature never puts the
    secret on the pipe: the saved ``OCUCLAW_TYPESAFE_API_KEY`` (``saved_key``) first,
    then the deployment-time ``TYPESAFE_API_KEY`` from the Hermes-managed env store
    (process environment as the fallback). Neither is a consent; both need the flag. A
    ``botScreenJev.apiKey`` in ``config.yaml`` is ignored, like every other yaml secret.

    ``budgetMs`` is forwarded only when finite (a NaN would make the handshake frame
    unparseable); the relay owns the clamp and default.
    """
    flag = raw.get("enabled")
    enabled = flag is True or flag == "true"
    budget = raw.get("budgetMs")
    finite = isinstance(budget, (int, float)) and not isinstance(budget, bool) and math.isfinite(
        float(budget)
    )
    return {
        "enabled": enabled,
        "apiKey": (saved_key or _typesafe_api_key()) if enabled else "",
        "budgetMs": budget if finite else None,
    }


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
        except (TypeError, ValueError, OverflowError):
            # OverflowError: YAML `.inf` / `1e400` load as float inf (#7316).
            return fallback

    def _port(key: str, fallback: int) -> int:
        # #7316: a port the relay cannot listen on falls back to the bundle
        # default, as pairing.py's advertised address does, so the relay and
        # the pairing QR agree. Bools are refused (`int(True) == 1`); numeric
        # strings and integral floats ("47900", 47900.0) still parse.
        raw = extra.get(key)
        if raw is None:
            return fallback
        port = 0 if isinstance(raw, bool) else _int(key, 0)
        if 1 <= port <= 65535:
            return port
        logger.warning(
            "[ocuclaw] %s %r is not a usable port (1-65535); using %d", key, raw, fallback
        )
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
    # Seeded onto `extra` from OCUCLAW_TYPESAFE_API_KEY by `_env_enablement()`, like
    # every other optional secret on this lane. A yaml-authored value is indistinguishable
    # at this seam, exactly as it is for the relay token and the Soniox key.
    typesafe_api_key = str(extra.get("typesafeApiKey") or "").strip()
    render_timeout_ms = _int("renderGlassesUiTimeoutMs", 0)
    debug_upload_max_zip_bytes = min(
        4_300_000,
        max(100_000, _int("debugUploadMaxZipBytes", 4_000_000)),
    )
    from . import custom_route

    return {
        "argv": argv,
        "usesDefaultArgv": not extra.get("runtimeCommand"),
        "wsPort": _port("wsPort", HERMES_BUNDLE_DEFAULT_WS_PORT),
        "wsBind": str(extra.get("wsBind") or "").strip() or HERMES_BUNDLE_DEFAULT_WS_BIND,
        "relayToken": str(extra.get("relayToken") or ""),
        "sonioxApiKey": str(extra.get("sonioxApiKey") or "").strip(),
        "typesafeApiKey": typesafe_api_key,
        "stateDir": str(extra.get("stateDir") or default_state_dir),
        # #5219: the custom phone address, so the child's pairing control
        # surface decides custom route itself. None on Tailscale.
        "phoneAddress": custom_route.configured_phone_address(extra),
        "glassesUiLive": _dict("glassesUiLive"),
        "liveuiJev": _resolve_liveui_jev(_dict("liveuiJev"), typesafe_api_key),
        # Silent input no longer uses Jev (Matt, 2026-10-31): a stale
        # `extra.silentInputJev` block is never read, never projected, and never an error.
        # The card switches take the raw block: absent reads on, a scalar reads off.
        "programCardsJev": _resolve_program_cards_jev(
            extra.get("programCardsJev"), typesafe_api_key
        ),
        "programCardsMcp": _resolve_program_cards_mcp(extra.get("programCardsMcp")),
        "programCardsModel": _resolve_program_cards_mcp(extra.get("programCardsModel")),
        "botScreenJev": _resolve_bot_screen_jev(_dict("botScreenJev"), typesafe_api_key),
        # LiveUI V2's config block (SPEC D3), passed through as glassesUiLive is;
        # the Node child's shared resolver applies the defaults.
        "liveuiV2": _dict("liveuiV2"),
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
        # Silent input (#2829): operator/bench knob for the host prediction
        # deadline; None keeps the relay-core provisional 1500 ms.
        "inputPredictionTimeoutMs": (_int("inputPredictionTimeoutMs", 0) or None),
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
        # Python-side only (never sent to the child): the reply-stream slot's
        # floor between two streaming frames of one run. 0 disables the slot.
        "streamFlushMs": max(0, _int("streamFlushMs", STREAM_SLOT_FLOOR_MS)),
    }


def _child_runtime_config(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Return the deliberately narrow Node-child config handshake."""
    return {
        "wsPort": settings["wsPort"],
        "wsBind": settings["wsBind"],
        "relayToken": settings["relayToken"],
        "sonioxApiKey": settings["sonioxApiKey"],
        # The Node entry hands its whole settings block to the shared Jev resolvers as the
        # plugin-config argument, so the saved key resolves there the same way (#3359): as
        # the key only, never as the switch.
        "typesafeApiKey": settings["typesafeApiKey"],
        "stateDir": settings["stateDir"],
        "phoneAddress": settings["phoneAddress"],
        "glassesUiLive": settings["glassesUiLive"],
        "liveuiJev": settings["liveuiJev"],
        "programCardsJev": settings["programCardsJev"],
        "programCardsMcp": settings["programCardsMcp"],
        "programCardsModel": settings["programCardsModel"],
        "botScreenJev": settings["botScreenJev"],
        "liveuiV2": settings["liveuiV2"],
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
        "inputPredictionTimeoutMs": settings["inputPredictionTimeoutMs"],
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
    if secret_access.secret_present(OCUCLAW_RELAY_TOKEN_ENV):
        return True
    extra = getattr(config, "extra", {}) if config is not None else {}
    relay_token = str((extra or {}).get("relayToken") or "").strip()
    return bool(relay_token)


def _env_enablement() -> Optional[Dict[str, Any]]:
    """The `platforms.ocuclaw.extra` values Hermes seeds from the env file.

    Hermes commits this with ``platform_config.extra.update(seed)``
    (`gateway/config_env.py` `_enable_plugin_platform`), so every key named
    here WINS over `config.yaml`. Beside the three secrets, it carries the
    non-secret platform settings the fresh-install guide otherwise makes an
    operator type by hand (#3098) — a malformed one of those is dropped with a
    warning rather than raised, so a typo can never cost this seed its Relay
    Credential.
    """
    # Read through Hermes's secret scope (catalogue rule 11), never the shared
    # process environment: under multiplexing that holds the launch profile's
    # values, not this profile's.
    seed: Dict[str, Any] = {
        adapter_key: value
        for env_name, adapter_key in _SECRET_ENV_TO_ADAPTER_KEY.items()
        if (value := secret_access.read_secret(env_name))
    }
    seed.update(platform_env_seed())
    return seed or None


def _hermes_version() -> str:
    # One resolution order for every caller (health.hermes_version documents it).
    return health_collect.hermes_version()


def setup_ocuclaw_platform() -> None:
    """Confirm host-managed relay state, then configure optional secrets."""
    optional_changed = False
    optional_failed = False
    optional_refusals: set = set()
    optional_unconfirmed = False
    optional_enable_failed = False
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
        from hermes_cli.config import get_env_value, save_env_value
    except Exception:  # noqa: BLE001 - setup must retain its recovery handoff
        optional_failed = True
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
                    # The Desktop form's writer: receipt fence, atomic .env
                    # write, read-back, receipt completion (#3357). Booleans
                    # only; the value never enters a receipt or this output.
                    try:
                        changed = _save_optional_credential(env_name, value)
                    except _OptionalSaveRefused as refused:
                        optional_refusals.add(refused.code)
                        print(f"OcuClaw {label} not saved: {refused}")
                        continue
                    except _OptionalSaveUnconfirmed:
                        optional_unconfirmed = True
                        print(
                            f"OcuClaw {label} was written, but its save "
                            "receipt could not be completed."
                        )
                        continue
                    except _OptionalEnableFailed:
                        # Saved, but a restart would not load it: no
                        # activation offer and not "nothing saved" either.
                        optional_enable_failed = True
                        print(_optional_setup.ENABLE_FAILED_MESSAGE)
                        continue
                    if changed:
                        optional_changed = True
                        print(f"OcuClaw {label} saved through Hermes's .env contract.")
                    else:
                        print(f"Existing OcuClaw {label} configuration kept.")
                elif already_present:
                    print(f"Existing OcuClaw {label} configuration kept.")
                else:
                    print(f"Optional {label} setup skipped.")
            except Exception:  # noqa: BLE001 - isolate each optional setup lane
                optional_failed = True
                print(
                    f"OcuClaw {label} setup could not be completed; continuing "
                    "with the remaining masked prompts."
                )
    if optional_changed:
        print("Resolve both optional choices before activation; keep their masked prompts separate.")
        # Never restart from here (a Cloudways restart closes this very
        # terminal); the phone or the activation CLI owns that step.
        print(OPTIONAL_SAVE_NOT_ACTIVE_MESSAGE)
        if not _core_setup_complete():
            # Only while core setup still has steps left (#3357 ride): a finished setup
            # has nothing for /ocuclaw-setup to do after the restart.
            print(OPTIONAL_SAVE_CORE_SETUP_NEXT_MESSAGE)
    if optional_failed:
        print(OPTIONAL_SAVE_FAILED_MESSAGE)
    if optional_unconfirmed:
        print(OPTIONAL_SAVE_UNCONFIRMED_MESSAGE)
    for code in sorted(optional_refusals):
        print(_OPTIONAL_SAVE_REFUSALS[code][1])
    if not (optional_changed or optional_failed or optional_refusals or optional_unconfirmed
            or optional_enable_failed):
        print("No optional credential changes; no restart is needed for these prompts.")
        print("Continue /ocuclaw-setup for any other saved changes awaiting activation.")


OPTIONAL_SAVE_NOT_ACTIVE_MESSAGE = (
    "Not active yet. Your phone will offer the restart (Home screen), "
    "or run: hermes ocuclaw optional-setup activate"
)
OPTIONAL_SAVE_CORE_SETUP_NEXT_MESSAGE = "After Hermes restarts, then run /ocuclaw-setup."


def _core_setup_complete() -> bool:
    """True only on durable proof that core setup finished; unknown counts as not finished.

    The same reader the phone's `coreComplete` uses, so the terminal and the phone agree.
    """
    try:
        from .optional_setup_rpc import OptionalSetupRpc

        return OptionalSetupRpc._core_complete(_optional_setup._home()) is True
    except Exception:  # noqa: BLE001 - no receipt home or proof: keep the hint
        return False


OPTIONAL_SAVE_FAILED_MESSAGE = (
    "The save did not complete; nothing to activate. Run the setup again."
)
OPTIONAL_SAVE_REFUSED_MESSAGE = _optional_setup.SAVE_REFUSED_MESSAGE
OPTIONAL_SAVE_BUSY_MESSAGE = (
    "Another optional save is in progress. Try again in a moment."
)
OPTIONAL_SAVE_INVALID_VALUE_MESSAGE = (
    "The value contains characters that cannot be stored; paste the key "
    "without surrounding spaces or quotes."
)
OPTIONAL_SAVE_UNCONFIRMED_MESSAGE = (
    "Run the setup again and enter the same value to confirm the save "
    "before activating."
)

_OPTIONAL_RECEIPT_NAMES = {
    OCUCLAW_SONIOX_API_KEY_ENV: "soniox",
    OCUCLAW_EVEN_AI_TOKEN_ENV: "evenAi",
}
#: receipt-fence code -> (inline reason, closing line)
_OPTIONAL_SAVE_REFUSALS = {
    "activation_pending_reconnect": (
        "a restart is already activating saved changes",
        OPTIONAL_SAVE_REFUSED_MESSAGE,
    ),
    "busy": ("another optional save is in progress", OPTIONAL_SAVE_BUSY_MESSAGE),
    "invalid_value": (
        "the value cannot be stored",
        OPTIONAL_SAVE_INVALID_VALUE_MESSAGE,
    ),
}


class _OptionalSaveRefused(Exception):
    """The save was refused before any write (nothing was written)."""

    def __init__(self, code: str) -> None:
        super().__init__(_OPTIONAL_SAVE_REFUSALS[code][0])
        self.code = code


class _OptionalSaveUnconfirmed(Exception):
    """The value was written but its save receipt could not be completed."""


class _OptionalEnableFailed(Exception):
    """The Even AI token is saved (receipt `saved`); turning Even AI on failed."""


def _save_optional_credential(env_name: str, value: str) -> bool:
    """Save one optional credential through `optional_setup.save_credential`.

    The same save as the CLI and the phone: value write plus (Even AI) route
    enable in one receipt transaction. Returns True when anything was
    written. Raises `_OptionalSaveRefused` for a refusal before any write
    (restart in flight, concurrent save, unstorable value) and
    `_OptionalSaveUnconfirmed` when the write succeeded but its receipt did
    not complete; any other error means the save did not complete. A missing
    receipt home runs the same writers without a receipt: the loaded-runtime
    observation (`optional_setup.status`) still detects that save.
    """
    optional_setup = _optional_setup

    name = _OPTIONAL_RECEIPT_NAMES[env_name]
    try:
        home = optional_setup._home()
    except Exception:  # noqa: BLE001 - no receipt home; keep the save itself
        home = None
    try:
        return optional_setup.save_credential(home, name, value)
    except ValueError as error:
        # Only refusals raised BEFORE any write map to "not saved".
        if str(error) in optional_setup.SAVE_REFUSALS:
            raise _OptionalSaveRefused(str(error)) from None
        if str(error) == "save_unconfirmed":
            raise _OptionalSaveUnconfirmed() from None
        if str(error) == optional_setup.ENABLE_FAILED:
            raise _OptionalEnableFailed() from None
        raise


def _setup_secret_present(env_name: str) -> bool:
    # Fail-soft by construction: secret_present never raises.
    return secret_access.secret_present(env_name)


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
    """Version captured when this process loaded the plugin, not a disk update."""
    return health_collect.ocuclaw_version()


def _inspect_first_run_welcome_attempt() -> Dict[str, Any]:
    """Read the attempt and its host identity together on the caller's worker."""
    return inspect_attempt(
        hermes_release=CERTIFIED_HERMES_TAG,
        hermes_package_version=_hermes_version() or None,
        ocuclaw_version=_ocuclaw_version(),
        session_key=None,
    )


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
        node_installable_fn=_node_install_available,
        ocuclaw_version_fn=_ocuclaw_version,
        profile_name_fn=_profile_name,
        resolve_home_fn=resolve_receipt_home,
        read_presence_fn=read_app_presence,
        read_proof_fn=read_first_run_proof,
        gateway_facts_fn=_collect_gateway_facts,
        serve_facts_fn=_collect_serve_facts,
        runtime_entry=DEFAULT_RUNTIME_ENTRY,
        live_reasoning_hooks_fn=_live_reasoning_hook_facts,
    )


def _live_reasoning_hook_facts() -> Tuple[Optional[bool], Optional[bool]]:
    """``(hooks available, hooks registered by this gateway)`` for the doctor.

    Registration is judged only where an OcuClaw adapter runs, which is the
    gateway: a CLI process registers from the config it read at ITS start,
    which says nothing about whether the gateway has restarted since.
    """
    available, _ = _probe_optional_hook_support()
    registered: Optional[bool] = None
    if _ADAPTERS:
        registered = FEATURE_TOKEN_STREAM_HOOKS in _hermes_feature_tokens()
    return available, registered


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
        except (TypeError, ValueError, OverflowError):  # pragma: no cover - guarded upstream
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
    resolved_facts = facts if facts is not None else _collect_health_facts()
    status = derive_legacy_setup_status(resolved_facts)
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
    # Hermes streams a platform's replies only when
    # display.platforms.<platform>.streaming is on (display.streaming is the
    # CLI's own key). Off, the glasses show "typing" for the whole reply and
    # the first words wait for the whole generation. Unset gates "verified",
    # so setup and update write it; an explicit false is the operator's choice
    # and does not.
    streaming_on = config_readable and health_collect.streaming_configured(raw_config)
    streaming_off_by_choice = config_readable and health_collect.streaming_explicitly_off(
        raw_config
    )
    gateway = raw_config.get("gateway")
    multiplex = gateway.get("multiplex_profiles") if isinstance(gateway, dict) else None
    platform_block: Any = raw_config
    for key in ("platforms", "ocuclaw"):
        platform_block = (
            platform_block.get(key) if isinstance(platform_block, dict) else None
        )
    mode_config = (
        platform_block.get("extra") if isinstance(platform_block, dict) else None
    )
    agent_mode = mode_config.get("agent_mode") if isinstance(mode_config, dict) else None
    # #3098: `.env`-seeded platform settings win over this yaml block at
    # gateway start, so the setup ladder must judge the effective value or it
    # will keep asking for a key the env file already supplies — but only where
    # Hermes would really commit that seed (no Relay Credential yet, an
    # explicitly disabled platform, or a failing deps check mean it never
    # lands), so the ladder never reports a setting the gateway refused.
    secrets_present = resolved_facts.get("secretsPresent")
    mode_config = effective_platform_extra(
        mode_config,
        seed_committed=env_seed_reaches_extra(
            platform_block,
            relay_token_present=bool(
                (secrets_present or {}).get("relayToken")
                if isinstance(secrets_present, dict)
                else False
            ),
            host_supported=bool(resolved_facts.get("hermesVersionSupported")),
            node_available=bool(resolved_facts.get("nodeAvailable")),
            node_installable=_node_install_available(),
        ),
    )
    # #3618: "single" is a recorded choice only before Hermes 0.21.4. On
    # 0.21.4+ OcuClaw never offers it, whatever the profile count, so the next
    # setup pass records "multiple" without asking.
    from .setup_profiles import (
        agent_mode_recorded,
        multiplex_opt_out_retired,
        single_agent_available,
    )

    opt_out_retired = multiplex_opt_out_retired()
    agent_mode_chosen = config_readable and agent_mode_recorded(
        agent_mode,
        multiplex,
        opt_out_retired=opt_out_retired,
    )
    # Continue here (#2509): `platforms.ocuclaw.extra.allow_admin_from` must
    # list the adapter's one wearer id, on fresh AND existing installs — the
    # setup skill writes it; every beta without it hits `admin_not_configured`.
    adopt_ok = config_readable and adopt_configured(mode_config)
    status["mandatoryConfiguration"] = {
        "state": (
            "verified"
            if tool_progress_off
            and agent_mode_chosen
            and adopt_ok
            and (streaming_on or streaming_off_by_choice)
            else "missing"
            if config_readable
            else "unknown"
        ),
        "toolProgressOff": tool_progress_off,
        "streamingOn": streaming_on,
        "streamingOffByChoice": streaming_off_by_choice,
        "agentModeChosen": agent_mode_chosen,
        "agentMode": agent_mode if agent_mode_chosen else None,
        "singleAgentAvailable": single_agent_available(
            opt_out_retired=opt_out_retired
        ),
        "adoptConfigured": adopt_ok,
        # Shared chats live with no busy mode saved: `next` re-runs the settings
        # step, which writes `display.busy_input_mode: queue`. Not part of
        # "state", which predates shared chats.
        "sharedChatsQueueOwed": config_readable
        and health_collect.shared_chats_queue_owed(
            raw_config, mode_config, _hermes_version()
        ),
    }
    plugins = raw_config.get("plugins")
    stream_reasoning_deltas_set = (
        isinstance(plugins, dict)
        and plugins.get("stream_reasoning_deltas") is True
    )
    status["hermesHooks"] = {
        "interimMessageAvailable": bool(INTERIM_HOOK_AVAILABLE),
        "streamHooksAvailable": bool(STREAM_HOOKS_AVAILABLE),
        # The compaction run signal's hook pair (0.21.5+); a lens that never
        # shows compaction on an older host is explained here.
        "auxiliaryCallHooksAvailable": bool(AUXILIARY_CALL_HOOKS_AVAILABLE),
        # post_compaction (0.22.3+). Without it the compaction count is the
        # chain's hop count, 0 on an in-place compaction, and Compact now on
        # the phone ends on its timeout.
        "postCompactionHookAvailable": bool(POST_COMPACTION_HOOK_AVAILABLE),
        # on_session_delete (0.22.3+). Without it a chat deleted on Desktop
        # stays in the glasses picker until the picker's next fetch.
        "sessionDeleteHookAvailable": bool(SESSION_DELETE_HOOK_AVAILABLE),
        "streamReasoningDeltas": stream_reasoning_deltas_set,
        "streamReasoningDeltasOffer": _stream_reasoning_deltas_offer(
            configured=stream_reasoning_deltas_set,
            hooks_available=bool(STREAM_HOOKS_AVAILABLE),
            config_readable=config_readable,
        ),
        "registered": list(_hermes_feature_tokens()),
    }
    # The tool inventory (#2804). Additive: no existing key moves or changes
    # meaning, and the block is present on every status so "the key is absent"
    # can only mean an OcuClaw older than this bundle.
    inventory = provided_tool_inventory()
    observed_tools = bool(inventory["observed"])
    # An unobservable inventory carries NO names in `missing`. The reader is a
    # model that acts on `missing` alone (live on Cloudways it refused to pair
    # over seven "missing" tools that the managed gateway had bound fine), so
    # a process that cannot see registration state must not publish absences.
    status["tools"] = {
        "expected": inventory["expected"],
        "registered": inventory["registered"] if observed_tools else [],
        "missing": inventory["missing"] if observed_tools else [],
        "count": len(inventory["registered"]) if observed_tools else None,
        "expectedCount": len(inventory["expected"]),
        "observed": observed_tools,
        "verdict": "observed" if observed_tools else "unobservable",
        "reason": None
        if observed_tools
        else (
            "registration state lives in the gateway process that received "
            "the runtime hello; this process did not, so no tool is known to "
            "be missing"
        ),
    }
    status["desktopTheme"] = _desktop_theme_status(raw_config, config_readable)
    status["desktopCredentials"] = desktop_credentials.status()
    status["sessionReadState"] = bool(session_read_state_supported())
    # Who restarts the gateway (#3520). Only `service` lets the assistant run
    # `hermes gateway restart`; with no service manager that command runs the
    # new gateway in the foreground inside the tool, so the person restarts it
    # in their own terminal instead. Additive, like the blocks around it.
    try:
        from . import gateway_supervision

        supervision = gateway_supervision.classify()
    except Exception:  # noqa: BLE001 - a diagnostic must not become an outage
        logger.exception("[ocuclaw] gateway supervision unavailable")
        supervision = {"state": "unknown", "supervisor": None}
    status["gatewaySupervision"] = supervision["state"]
    status["gatewaySupervisor"] = supervision["supervisor"]
    status["setupSurface"] = _host_setup_surface()
    status["restartToFinish"] = health_collect.restart_to_finish()
    # Which words hand the restart over (#3876): "cloudways" when a gateway
    # restart restarts this Cloudways container (no terminal to Ctrl+C there),
    # else null and the generic hand-off stands.
    try:
        from . import gateway_supervision

        status["gatewayRestartHost"] = gateway_supervision.restart_host()
    except Exception:  # noqa: BLE001 - a diagnostic must not become an outage
        logger.exception("[ocuclaw] gateway restart host unavailable")
        status["gatewayRestartHost"] = None
    # The Profiles inventory (#2944). Additive, exactly like the tool
    # inventory above: no existing key moves, so "the key is absent" can only
    # mean an OcuClaw older than this bundle. Read-only — it opens nothing,
    # writes nothing, and never carries a credential value, only presence.
    # A collection failure degrades this one block rather than the status a
    # wearer is reading precisely because something is broken.
    try:
        from . import profiles_report

        status["profiles"] = profiles_report.build_inventory()
    except Exception:  # noqa: BLE001 - a diagnostic must not become an outage
        logger.exception("[ocuclaw] profile inventory unavailable")
        status["profiles"] = {"observed": False, "faults": []}
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
    """Apply the fresh-setup default or a confirmed change to live reasoning.

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

    result = _enable_stream_reasoning_deltas(
        defaults_only=(args or {}).get("defaultsOnly") is True
    )
    receipt: Dict[str, Any] = {
        "ok": result.get("reason") in {"written", "already_enabled", "existing_choice"},
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


#: One message per `pair_phone` refusal code (#3526). Each names the real
#: cause and the next step, so a healthy route is never reported as
#: "not verified". Re-pairing never touches setup progress or proof.
PAIRING_REFUSAL_MESSAGES: Dict[str, str] = {
    "profile_unresolved": (
        "OcuClaw cannot tell which Hermes profile this is. Run "
        "`hermes ocuclaw doctor` in this profile, fix what it reports, then "
        "retry pairing."
    ),
    "setup_not_configured": (
        "OcuClaw is not configured on this Hermes profile yet. Finish the "
        "current setup checkpoint, then retry pairing."
    ),
    "gateway_not_healthy": (
        "The Hermes gateway is not running healthily, so no phone can "
        "connect yet. Get the gateway running, then retry pairing."
    ),
    "relay_not_healthy": (
        "The OcuClaw relay is not healthy, so no phone can connect yet. Run "
        "`hermes ocuclaw doctor`, fix what it reports, then retry pairing."
    ),
    "tailnet_route_not_verified": (
        "The private phone route is not fully verified yet. Run the current "
        "setup checkpoint, then retry pairing."
    ),
    "tailnet_route_not_owned": (
        "The private phone route on this machine is not owned by this OcuClaw "
        "installation. Run `hermes ocuclaw doctor` and follow its route "
        "guidance, then retry pairing."
    ),
    "phone_already_connected": (
        "Your phone is already connected. If you want to re-pair it, close "
        "OcuClaw on the phone or disconnect it there first, then retry "
        "pairing. Re-pairing does not undo any setup progress."
    ),
    "tailnet_identity_unavailable": (
        "This machine's Tailscale name is not available, so there is no "
        "private address to pair with. Make sure Tailscale is connected and "
        "signed in here, then retry pairing."
    ),
    "address_unavailable": (
        "The private phone address could not be built from this machine's "
        "Tailscale name. Run `hermes ocuclaw doctor`, then retry pairing."
    ),
    "verification_failed": (
        "Checking the private phone route failed unexpectedly. Run "
        "`hermes ocuclaw doctor`, then retry pairing."
    ),
    # Custom route mode (#5209): the user's own private network.
    "custom_route_wrong": (
        "The phone address you set did not pass OcuClaw's private route check. "
        "Run `hermes ocuclaw doctor` to see which check failed, fix it, then "
        "retry pairing."
    ),
    "custom_route_not_verified": (
        "OcuClaw could not check the phone address you set. Run "
        "`hermes ocuclaw doctor`, fix what it reports, then retry pairing."
    ),
}
PAIRING_REFUSAL_FALLBACK_MESSAGE = (
    "Pairing cannot start yet. Run `hermes ocuclaw doctor`, fix what it "
    "reports, then retry pairing."
)


def _custom_route_pairing_address(
    facts: Mapping[str, Any], route: Mapping[str, Any], phone: Mapping[str, Any]
) -> Tuple[Optional[str], str]:
    """Custom route mode (#5209): pair to the configured phone address.

    The `.ts.net` and Serve ownership checks do not apply: there is no Serve
    route to own, and the user's name is their own. `unverified` still pairs,
    because the address is bound into the safety phrase and a wrong address
    fails safely; `wrong` and an unchecked route refuse.
    """
    from . import custom_route

    classification = route.get("classification")
    if classification == "wrong" or route.get("applicationReady") == "no":
        return None, "custom_route_wrong"
    if classification not in {"ready", "unverified"}:
        return None, "custom_route_not_verified"
    if phone.get("state") == "healthy":
        return None, "phone_already_connected"
    address = custom_route.canonical_address(facts.get("customPhoneAddress"))
    return (address, "ready") if address else (None, "custom_route_wrong")


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
        if "customRoute" in legs:
            return _custom_route_pairing_address(facts, legs["customRoute"], phone)
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


def _setup_custom_route_configured() -> bool:
    """Is a custom phone address configured (the pair create's ``customRoute``)?"""
    from .custom_route import configured_phone_address

    config, _readable = _setup_raw_config()
    platforms = config.get("platforms") if isinstance(config, dict) else None
    platform = platforms.get("ocuclaw") if isinstance(platforms, dict) else None
    extra = platform.get("extra") if isinstance(platform, dict) else None
    return isinstance(extra, dict) and configured_phone_address(extra) is not None


def _setup_chat_deps() -> Any:
    """The host's own pieces for the #6378 chat operations.

    The pairing preflight is the in-session one ``pair_phone`` uses, and the
    control endpoint, request helper and credential read are the terminal
    ``pair`` command's own (setup_chat_approvals reads those from pairing.py).
    """
    from .setup_chat_approvals import ChatDeps

    return ChatDeps(
        state_dir=_setup_approval_state_dir(),
        surface=_host_setup_surface(),
        pairing_address_fn=_verified_in_session_pairing_address,
        custom_route_fn=_setup_custom_route_configured,
        hermes_home=_hermes_home(),
    )


def _setup_picked_card_tools() -> bool:
    """True once this host's chat setup saved the ``card_tools`` extra (#7189): the only
    time the setup chat may put a "during setup" request on the glasses."""
    try:
        from . import setup_next

        state_dir = _setup_approval_state_dir()
        return bool(state_dir) and setup_next.read_setup_next_answers(state_dir).get("extras") == "card_tools"
    except Exception:  # noqa: BLE001 - an unread answers file is no pick
        return False


def _read_setup_card_tools(opts: Any) -> Optional[Dict[str, Any]]:
    """Chat setup's "Tools for cards" read (#7189): the live relay's own answer, or None.

    Read only. ``program_cards.tools.facts`` carries whether a connected phone has cards
    on and the MCP-in-cards switch, and with ``servers`` each MCP server's name with
    whether it is connected and on for cards (SECURITY-RULED on #7171, change 6): no tool
    names, arguments, results, keys or tokens. No live link, an older runtime without the
    method, or no answer in time reads as None, so the extra is not offered and its state
    is unknown. Never called on the adapter's own loop, where a blocking wait cannot end.
    """
    adapter = _link_adapter()
    if adapter is None:
        return None
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None and running is getattr(adapter, "_loop", None):
        return None
    servers = isinstance(opts, dict) and opts.get("servers") is True
    answer = adapter._request_link_threadsafe(
        "program_cards.tools.facts",
        {"servers": servers},
        # The relay bounds its own server list at 5 s; the switch read is immediate.
        timeout_s=7.0 if servers else 2.0,
    )
    return answer if isinstance(answer, dict) else None


def _setup_next_deps(task_id: Optional[str] = None) -> Any:
    """The host's own pieces for the #6377 step machine (setup_next.py).

    The state folder is the one the #6378 approval store keys on; the
    mandatory-settings block is the setup status's own, from one collection.
    ``task_id`` is the tool call's chat, which step 9's wake wakes.
    """
    from . import setup_next

    def state_dir() -> str:
        path = _setup_approval_state_dir()
        if path:
            Path(path).mkdir(parents=True, exist_ok=True, mode=0o700)
        return path

    return setup_next.live_deps(
        state_dir=state_dir,
        surface=_host_setup_surface,
        hermes_home=_hermes_home,
        collect_facts=_collect_health_facts,
        derive_snapshot=_safe_snapshot,
        mandatory=lambda facts: _setup_status(facts).get("mandatoryConfiguration") or {},
        version_tags=lambda: {
            "hermes_release": CERTIFIED_HERMES_TAG,
            "hermes_package_version": _hermes_version() or None,
            "ocuclaw_version": _ocuclaw_version(),
        },
        task_id=task_id,
        read_card_tools=_read_setup_card_tools,
    )


def _run_setup_pairing_action() -> Dict[str, Any]:
    """Stage the direct-human ceremony on the live supported host surface."""
    interface = _host_setup_surface()
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
            "message": PAIRING_REFUSAL_MESSAGES.get(
                reason, PAIRING_REFUSAL_FALLBACK_MESSAGE
            ),
        }
    from .pairing import _control_url

    if interface == "desktop":
        from .desktop_pairing import run_desktop_pairing

        return run_desktop_pairing(address, control_url=_control_url())
    from .tui_pairing import resolve_owner_tui_pid, run_tui_pairing
    return run_tui_pairing(
        address,
        control_url=_control_url(),
        # Not os.getppid(): on Windows that is the venv launcher (#3375).
        owner_tui_pid=resolve_owner_tui_pid(),
    )


def _setup_journey(
    snapshot: Any,
    attempt: Any,
    mandatory_configuration: Any = None,
    tailnet_daemon: Any = None,
    *,
    serve_read_code: Any = None,
    restart_to_finish: Any = None,
) -> Dict[str, Any]:
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
    elif restart_to_finish is not None:
        checkpoint = "restart-and-relay-verification"
    elif any(
        (legs.get(name) or {}).get("state") != "healthy"
        for name in ("hermesGateway", "ocuclawRelay")
    ):
        checkpoint = "restart-and-relay-verification"
    elif "customRoute" in legs:
        # #5209. Passive status cannot reach the network, so only a config
        # failure (a bad address, a Cloudways host) stops here; the pairing
        # step runs the full active check itself before anything opens.
        custom = legs.get("customRoute") or {}
        if custom.get("classification") == "wrong" or custom.get("configured") != "yes":
            checkpoint = "custom-route"
        elif (legs.get("phoneApp") or {}).get("state") != "healthy":
            checkpoint = "secure-phone-pairing"
        else:
            checkpoint = "phone-origin-proof"
    elif (legs.get("tailnetRoute") or {}).get("classification") != "ready":
        checkpoint = "tailnet-route"
    elif (legs.get("phoneApp") or {}).get("state") != "healthy":
        checkpoint = "secure-phone-pairing"
    else:
        checkpoint = "phone-origin-proof"
    journey = {
        "owner": "host",
        "nextCheckpoint": checkpoint,
        # The phone sends the test message and returns the welcome double-tap.
        # A display answer is asked for only when the app's own SDK receipt for
        # that exact reply is missing or ineligible.
        "phoneRole": "test-message-welcome-dismissal-and-fallback-confirmation",
    }
    if checkpoint == "tailnet-route" and isinstance(tailnet_daemon, dict):
        # The Cloudways sub-check: a user-owned userspace tailscaled fronts the
        # route, so "route not ready" first means "is the daemon even up and
        # authorized". Present only when the tailscale-cli receipt exists.
        state = str(tailnet_daemon.get("state") or "unknown")
        journey["tailnetDaemon"] = {
            "state": state,
            "detail": str(tailnet_daemon.get("detail") or ""),
        }
        if state != "running":
            journey["subCheck"] = "tailnet-daemon"
    if (
        checkpoint == "tailnet-route"
        and tailnet_daemon is None
        and serve_read_code == serve.READ_CLI_ABSENT
    ):
        # #5209. No phone address and no Tailscale: today's install action
        # gains one line, and only here, so a Tailscale user sees nothing new.
        from . import custom_route

        journey["customRouteOption"] = {
            "say": CUSTOM_ROUTE_OPTION_SAY,
            "command": custom_route.SET_COMMAND,
        }
    if checkpoint == "custom-route":
        from . import custom_route

        journey["customRoute"] = {
            "setCommand": custom_route.SET_COMMAND,
            "clearCommand": custom_route.CLEAR_COMMAND,
        }
    return journey


#: The one line the Tailscale install action gains when Tailscale is missing.
CUSTOM_ROUTE_OPTION_SAY = (
    "Already have your own private network? Set your phone address instead."
)


def _tailnet_daemon_summary() -> Optional[Dict[str, Any]]:
    """The Cloudways `tailscale-daemon` check; None off that path or on any fault."""
    try:
        from . import cloudways

        return cloudways.daemon_summary()
    except Exception:  # noqa: BLE001 - a sub-check must not break the setup tool
        logger.exception("[ocuclaw] tailscale daemon summary unavailable")
        return None


#: Once per process: the cron-to-runtime handover on a plugin upgrade (#6359).
_CLOUDWAYS_ADOPTION: Dict[str, Any] = {}


def _cloudways_detect_then_adopt(detect: Callable[[], bool]) -> bool:
    """Detect, then on a Cloudways host hand an old cron watchdog to the runtime.

    A plugin upgrade runs no setup, so an old-ladder box would keep its cron
    job and the OcuClaw runtime would never take over. Runs in the detection
    worker thread, off the loop; any fault is logged, never raised.
    """
    verdict = detect()
    if verdict is not True or _CLOUDWAYS_ADOPTION:
        return verdict
    _CLOUDWAYS_ADOPTION["ran"] = True
    try:
        from . import cloudways

        result = cloudways.adopt_runtime_supervisor(cloudways.Layout.resolve())
        _CLOUDWAYS_ADOPTION["result"] = result
        if result.get("adopted"):
            logger.info(
                "[ocuclaw] cloudways: retired the cron watchdog; the OcuClaw runtime keeps "
                "tailscaled alive now (enabled=%s)",
                result.get("enabled"),
            )
        elif result.get("reason") == "watchdog-not-retired":
            logger.warning("[ocuclaw] cloudways: cron watchdog kept: %s", result.get("error"))
    except Exception:  # noqa: BLE001 - adoption must never fail or delay connect
        logger.exception("[ocuclaw] cloudways runtime adoption unavailable")
    return verdict


def _welcome_host_is_cloudways() -> bool:
    """Picks the three-way welcome lockup (#3187). Fail-soft: an unclassifiable
    host is an ordinary host, and only the decisive verdict counts."""
    try:
        from . import cloudways

        return cloudways.detect().verdict == cloudways.DETECT_CLOUDWAYS
    except Exception:  # noqa: BLE001 - a picture choice must not break first run
        logger.exception("[ocuclaw] welcome host detection unavailable")
        return False


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


def _setup_phone_candidate_id(args: Any) -> Optional[str]:
    """The opaque candidate binding, or None when it is absent or malformed."""

    candidate_id = str((args or {}).get("phoneCandidateId") or "").strip()
    if len(candidate_id) != 64 or any(
        char not in "0123456789abcdef" for char in candidate_id
    ):
        return None
    return candidate_id


def _phone_candidate_binding_error(operation: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "operation": operation,
        "error": {
            "code": "phone_candidate_binding_required",
            "message": (
                "Wait for a new phone-origin turn first, retain its opaque "
                "candidate binding, then retry this operation with that exact "
                "binding."
            ),
        },
    }


#: #3468. Appended to the terminal lane's verdict for the assistant only: the
#: wearer saw the model's error text, so their answer proves nothing.
PROVIDER_ERROR_ASSISTANT_INSTRUCTION = (
    "Do not ask whether the reply appeared on the Even G2."
)


def _provider_error_fields(
    run_error_code: Optional[str], reason: Optional[str] = None
) -> Dict[str, Any]:
    """The chain-works / model-unreachable verdict as tool-result fields.

    Reuses the terminal lane's class and wording (`first_use_cli`), so both
    Hermes paths name the same failure and the same fix.
    """

    from .first_use_cli import errored_run_verdict, provider_error_class

    return {
        "replyWasProviderError": True,
        "providerErrorClass": provider_error_class(run_error_code, reason),
        "action": (
            f"{errored_run_verdict(run_error_code, reason)} "
            f"{PROVIDER_ERROR_ASSISTANT_INSTRUCTION}"
        ),
    }


def _hold_setup_question(next_result: Mapping[str, Any], session_key: str) -> None:
    """Step 9 asks whether the reply showed on the glasses: keep that question's
    Waiting on you card off the glasses, where it would cover the reply."""

    if next_result.get("step") == "first_message" and next_result.get("status") == "waiting":
        _HUMAN_INPUT_WAITING.hold_setup_question(session_key)
    else:
        _HUMAN_INPUT_WAITING.release_setup_question()


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
    if operation == SETUP_NEXT_OPERATION:
        from . import setup_next

        try:
            task_id = _kwargs.get("task_id")
            next_result = setup_next.SetupNext(
                _setup_next_deps(task_id if isinstance(task_id, str) and task_id else None)
            ).call(args or {})
        except setup_next.SetupNextError as exc:
            return json.dumps(
                {
                    "ok": False,
                    "operation": operation,
                    "error": {"code": exc.code, "message": str(exc)},
                },
                sort_keys=True,
            )
        except Exception:  # noqa: BLE001 - an agent turn never sees a raise
            logger.exception("[ocuclaw] setup next failed")
            return json.dumps(
                {
                    "ok": False,
                    "operation": operation,
                    "error": {
                        "code": "setup_unavailable",
                        "message": "Setup could not be read just now. Call next again.",
                    },
                },
                sort_keys=True,
            )
        _hold_setup_question(next_result, session_key)
        return json.dumps(next_result, sort_keys=True)
    if operation in SETUP_CHAT_OPERATIONS:
        from . import setup_chat_approvals

        try:
            chat_receipt = setup_chat_approvals.run_operation(
                operation, args or {}, _setup_chat_deps()
            )
        except Exception:  # noqa: BLE001 - a receipt, never a raise
            logger.exception("[ocuclaw] setup chat operation %s failed", operation)
            chat_receipt = setup_chat_approvals.receipt(
                operation, "failed", "setup-unavailable"
            )
        return json.dumps(chat_receipt, sort_keys=True)
    if operation == "request_credentials":
        if set(args) - {"operation", "integrations"}:
            result = {"state": "invalid_request"}
        elif _host_setup_surface() != "desktop":
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
        # #3010: this wait IS the moment the wearer is being asked for a phone
        # message — and the ask cannot reach the host terminal while this tool
        # is running. The phone carries it instead, for exactly this wait. This
        # process is the host, not the gateway, so the ask is published as a
        # profile-scoped receipt the gateway's first-run watcher picks up.
        # #3523: a slow hello gets one quiet re-wait in this same call (two
        # 165 s waits stay under Hermes's 420 s tool limit); the hint is
        # refreshed in place so the phone row never lapses between them.
        with awaiting_first_reply() as refresh_hint:
            phone_origin_action = wait_for_phone_origin(on_rewait=refresh_hint)
        if phone_origin_action.get("runErrorCode"):
            # #3468. Say it now, so the assistant gives the verdict instead of
            # asking the wearer about the error text on their glasses.
            phone_origin_action.update(
                _provider_error_fields(phone_origin_action["runErrorCode"])
            )
    reply_delivery_action = None
    if operation == SETUP_REPLY_DELIVERY_OPERATION:
        candidate_id = _setup_phone_candidate_id(args)
        if candidate_id is None:
            return json.dumps(
                _phone_candidate_binding_error(operation), sort_keys=True
            )
        # Bounded, non-mutating, and never a restart: a timeout here reports
        # `unconfirmed` and the same candidate still arms through the wearer
        # path afterwards.
        reply_delivery_action = wait_for_reply_delivery(
            candidate_id=candidate_id,
            timeout_seconds=REPLY_DELIVERY_WAIT_SECONDS,
        )
        run_error_code = phone_turn_run_error_code(candidate_id)
        delivery_reason = reply_delivery_action.get("reason")
        if (
            run_error_code is not None
            or delivery_reason in REPLY_DELIVERY_ERRORED_RUN_REASONS
        ):
            reply_delivery_action.update(
                _provider_error_fields(run_error_code, delivery_reason)
            )
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
            candidate_id = _setup_phone_candidate_id(args)
            if candidate_id is None:
                return json.dumps(
                    _phone_candidate_binding_error(operation), sort_keys=True
                )
            reply_evidence = str(
                (args or {}).get("replyEvidence") or REPLY_EVIDENCE_WEARER_CONFIRMED
            ).strip()
            if reply_evidence not in REPLY_EVIDENCE_VALUES:
                return json.dumps(
                    {
                        "ok": False,
                        "operation": operation,
                        "error": {
                            "code": "reply_evidence_invalid",
                            "message": (
                                "replyEvidence must be wearer_confirmed or "
                                "client_sdk_receipt."
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
                reply_evidence=reply_evidence,
            )
        if first_run_action.get("state") == "reply_run_errored":
            # #3468. Refused whatever evidence was claimed; nothing written.
            fields = _provider_error_fields(
                first_run_action.get("runErrorCode"),
                first_run_action.get("reason"),
            )
            first_run_action.update(fields)
            return json.dumps(
                {
                    "ok": False,
                    "operation": operation,
                    "error": {
                        "code": "reply_run_errored",
                        "message": fields["action"],
                        "replyWasProviderError": True,
                        "providerErrorClass": fields["providerErrorClass"],
                    },
                    "firstRunProofAction": first_run_action,
                },
                sort_keys=True,
            )
        if first_run_action.get("state") == "reply_evidence_unavailable":
            return json.dumps(
                {
                    "ok": False,
                    "operation": operation,
                    "error": {
                        "code": "reply_evidence_unavailable",
                        "message": (
                            "This turn has no accepted glasses SDK receipt, so "
                            "the automatic path cannot arm it. Ask the wearer "
                            "whether the reply appeared on their Even G2 and "
                            "retry with replyEvidence: wearer_confirmed."
                        ),
                        "reason": first_run_action.get("reason"),
                    },
                },
                sort_keys=True,
            )
        if str(first_run_action.get("state") or "").startswith("phone_turn_"):
            return json.dumps(
                {
                    "ok": False,
                    "operation": operation,
                    "error": {
                        "code": "phone_turn_required",
                        "message": (
                            "Send a message from the OcuClaw phone app, run "
                            "wait_reply_delivery for that turn, and if it does "
                            "not report sdk_accepted ask the wearer whether the "
                            "reply appeared on the Even G2. Then continue setup "
                            "here on the host."
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
        SETUP_REPLY_DELIVERY_OPERATION,
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
            _tailnet_daemon_summary(),
            serve_read_code=(facts or {}).get("serveReadCode"),
            restart_to_finish=receipt["status"].get("restartToFinish"),
        )
    if first_run_action is not None:
        receipt["firstRunProofAction"] = first_run_action
    if operation == "welcome_round_trip" and operation_ok:
        # #3524: the committed round trip is the result that finishes setup,
        # so it carries the completion lines itself. The skill says them
        # verbatim; no skill file keeps a competing "canonical" sentence.
        # Read-only: journey and coreComplete stay exactly as computed above.
        from .first_use_cli import setup_complete_say_lines

        attempt = receipt.get("firstRunProofAttempt")
        reply_evidence = next(
            (
                value
                for value in (
                    (first_run_action or {}).get("welcomeDelivery", {}).get(
                        "replyEvidence"
                    ),
                    attempt.get("replyEvidence") if isinstance(attempt, dict) else None,
                    (first_run_action or {}).get("replyEvidence"),
                )
                if value
            ),
            None,
        )
        receipt["say"] = setup_complete_say_lines(reply_evidence)
        receipt["nextOperations"] = ["wrap_feedback"]
    if pairing_action is not None:
        receipt["pairingAction"] = pairing_action
    if phone_origin_action is not None:
        receipt["phoneOriginAction"] = phone_origin_action
    if reply_delivery_action is not None:
        # Machine evidence only: SDK acceptance of a slice of the committed
        # reply. It is never wearer confirmation and never a display claim.
        receipt["replyDelivery"] = reply_delivery_action
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
    from .even_ai_cli import observe
    return {**observe(), "operation": SETUP_EVEN_AI_ROUTE_OPERATION}


def _admitted_adapter_factory(config: Any):
    if not _host_version_supported():
        return None
    return _build_adapter(config)


def _admitted_is_connected(config: Any) -> bool:
    return _host_version_supported() and _is_connected(config)


# New chats start with Show reasoning on (Matt, 2026-11-01). A platform default
# only: Hermes resolves `display.platforms.ocuclaw.show_reasoning` (the wearer's
# This chat toggle saves there) and then `display.show_reasoning` first, so an
# explicit Off still wins.
#
# `tool_progress: "off"` is the same platform-default-only shape: the glasses
# show tool steps on the status bar, so Hermes' own tool-progress bubbles are
# noise there. It is the canonical value Hermes' resolver returns and the one
# the Cloudways ladder writes (cloudways_settings.TOOL_PROGRESS_VALUE); a
# written `display.platforms.ocuclaw.tool_progress` or `display.tool_progress`
# still wins (gateway/display_config.py resolve_tool_progress, v0.22.5).
#
# `streaming` is deliberately NOT here: at v0.22.5 a per-platform value "can
# only narrow the global switch, never enable streaming on its own"
# (gateway/config.py StreamingConfig.enabled_for), and with no display_tier
# the default already follows the global switch, so True would be inert.
OCUCLAW_DISPLAY_OVERRIDES: Dict[str, Any] = {
    "show_reasoning": True,
    "tool_progress": "off",
}


def _platform_entry_accepts(field_name: str) -> bool:
    """Whether this Hermes's PlatformEntry declares *field_name*.

    register_platform forwards extra kwargs to PlatformEntry and raises
    TypeError on an unknown one, so an optional field is passed only where the
    host declares it (`display_overrides`: Hermes 0.22.3+).
    """
    try:
        import dataclasses
        from gateway.platform_registry import PlatformEntry

        return any(f.name == field_name for f in dataclasses.fields(PlatformEntry))
    except Exception:
        return False


def register(ctx: Any) -> None:
    global _LAST_SETUP_BUNDLE_REPORT, _PLUGIN_CONTEXT, _LIVEUI_REGISTER_TOOL
    global _SETUP_TOOL_REGISTERED, _INPUT_PREDICTION_TASK_REGISTERED
    # Uninstall pending (#3765): `hermes ocuclaw uninstall` ran while OcuClaw
    # was up and asked for one gateway restart. Start nothing (no relay
    # credential bootstrap, platform, hooks, tools or runtime); keep only the
    # `hermes ocuclaw` CLI so the same command can finish, or be cancelled.
    if uninstall_gate.uninstall_pending(resolve_receipt_home()):
        logger.warning(
            "[ocuclaw] uninstall pending: OcuClaw not started. Run `%s` to "
            "finish, or `%s` then `%s` to keep OcuClaw",
            uninstall_gate.UNINSTALL_COMMAND,
            uninstall_gate.CANCEL_COMMAND,
            uninstall_gate.RESTART_COMMAND,
        )
        register_cli_commands(ctx, logger)
        return
    _PLUGIN_CONTEXT = ctx
    # Hermes cron runs the installed page check whether or not OcuClaw starts,
    # so bring every profile's installed copy up to this version first (DeepSec
    # finding_5c829641ac22e1ce: public addresses only). Rewrites only, never
    # installs, never raises.
    task_page_watch.refresh_all(resolve_receipt_home())
    # Plugin-owned auxiliary tasks (#2829, #5046) so operators can pin a
    # model per OcuClaw background call under `auxiliary.<key>` without
    # touching the chat model: silent input predictions, the approval
    # explainer (inherits `approval`) and live view refresh. Optional: an
    # older host without register_auxiliary_task keeps every lane on the
    # plugin's default routing, and no call sends `task=`.
    aux_tasks.register_ocuclaw_tasks(ctx)
    _INPUT_PREDICTION_TASK_REGISTERED = aux_tasks.is_registered(INPUT_PREDICTION_AUXILIARY_TASK)
    version = _hermes_version()
    if parse_version(version) is None:
        raise RuntimeError(
            f"{health_collect.HERMES_VERSION_UNKNOWN_HINT}. The ocuclaw plugin "
            "refuses to register against an unknown plugin ABI"
        )
    register_platform = getattr(ctx, "register_platform", None)
    if not callable(register_platform):
        raise RuntimeError(
            "ocuclaw plugin requires ctx.register_platform (hermes "
            f"{version} exposes no platform registration surface)"
        )
    supported = hermes_version_supported(version)
    if supported and health_collect.hermes_version_untested(version):
        # Newer than the tested range: it runs, and the gateway log says so.
        logger.warning("[ocuclaw] %s", health_collect.hermes_untested_message(version))
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
    # Dev switch (#5155): with OCUCLAW_DEV_BOT_DESKTOP_A11Y=1 the Bot Desktop's
    # apps publish accessibility, so captures carry elements for the pointer.
    # Only a desktop this process starts gets it: built-in `hermes` CLI
    # commands such as `computer-use screen start` load no plugins.
    dev_a11y = dev_bot_desktop_a11y.apply()
    if dev_a11y is not None:
        logger.warning("[ocuclaw] dev Bot Desktop accessibility: %s", dev_a11y)
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
        # Makes `ocuclaw` a cron delivery platform (#5025): Hermes accepts
        # `deliver=ocuclaw` only for a plugin that names its home-channel env
        # var, then sends to that var or `platforms.ocuclaw.home_channel`.
        # The field dates from Hermes 0.12, below the 0.21.1 floor.
        "cron_deliver_env_var": OCUCLAW_HOME_CHANNEL_ENV,
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
        # `hermes cron run` in a terminal has no live adapter (#5031): queue
        # the result for the gateway's task inbox pump.
        "standalone_sender_fn": task_delivery.standalone_send,
    }
    if supported and _node_install_available():
        # Hermes 0.21.6+ runs only Node its package manager installed and
        # leaves the install to the caller. Without `pm` (0.21.5 and older) a
        # False check stays a hard block, exactly as before.
        platform_kwargs["ensure_deps_fn"] = ensure_ocuclaw_requirements
    if supported and _platform_entry_accepts("display_overrides"):
        # Older hosts keep Hermes' own default (reasoning hidden).
        platform_kwargs["display_overrides"] = dict(OCUCLAW_DISPLAY_OVERRIDES)
    try:
        register_platform(**platform_kwargs)
    except TypeError as exc:
        if supported:
            raise
        raise RuntimeError(_unsupported_hermes_message(version)) from exc
    if supported:
        # After the platform, so `deliver=ocuclaw` names a known target
        # (#5027). Never raises; Hermes 0.21.x registers none.
        register_starters(ctx)
        # "Asks other agents" (#6797): the `ocuclaw-agents` delegation backend.
        # Registering selects nothing; only the per-agent switch writes
        # `delegation.backend`. Hermes 0.22.5+ only; never raises.
        delegation_handoffs.register(ctx)
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
        # A plugin skill never appears in <available_skills>, so without this
        # line a plain "re-pair my phone" chat never learns the setup skill's
        # qualified name (#3078, #3829).
        register_system_prompt_section(
            OCUCLAW_SETUP_SKILL_SECTION_ID,
            OCUCLAW_SETUP_SKILL_SYSTEM_PROMPT,
            position="after_memory",
            max_chars=2000,
        )
        # The length of a note before a computer step: it shows on one line
        # of the Bot Screen.
        register_system_prompt_section(
            OCUCLAW_SCREEN_NOTES_SECTION_ID,
            OCUCLAW_SCREEN_NOTES_SYSTEM_PROMPT,
            position="after_memory",
            max_chars=1000,
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
                toolset=_setup_toolset(),
                schema=SETUP_TOOL_SCHEMA,
                handler=_setup_tool_handler,
                check_fn=_host_setup_session_available,
                requires_env=None,
                is_async=False,
                description=SETUP_TOOL_DESCRIPTION,
            )
            _SETUP_TOOL_REGISTERED = True
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
        # /ocuclaw-setup is the `ocuclaw-setup` skill on every surface: Hermes
        # 0.22.1+ chats on a shared gateway (TUI, classic CLI, Desktop) never
        # expand a skill bundle, and every other surface resolves skills too.
        command_skill_ready = False
        try:
            command_skill_report = reconcile_setup_command_skill()
            command_skill_ready = (
                isinstance(command_skill_report, dict)
                and command_skill_report.get("status") in SKILL_RECONCILE_OK
            )
            if not command_skill_ready:
                logger.warning(
                    "[ocuclaw] /ocuclaw-setup skill unavailable: %s (%s)",
                    (command_skill_report or {}).get("reason")
                    or (command_skill_report or {}).get("status"),
                    (command_skill_report or {}).get("path") or "no path",
                )
        except Exception as exc:  # noqa: BLE001 - registration stays fail-soft
            logger.warning(
                "[ocuclaw] /ocuclaw-setup skill reconciliation failed: %s", exc
            )
        # Earlier builds wrote a bundle of the same name. Next to the skill it
        # lists the command twice in Hermes's slash menus, so it goes once the
        # skill is in place. When the skill cannot be (a user's own
        # `ocuclaw-setup` skill, an unsafe path), the bundle is kept as
        # before, so messaging chats and pre-0.22.1 TUIs still have the
        # command. The doctor receipt's `bundle` key reports either way.
        bundle_step = retire_setup_bundle if command_skill_ready else reconcile_setup_bundle
        try:
            bundle_report = bundle_step()
            _LAST_SETUP_BUNDLE_REPORT = (
                json.loads(json.dumps(dict(bundle_report), default=str))
                if isinstance(bundle_report, dict)
                else {"status": "error", "error": "invalid bundle receipt"}
            )
        except Exception as exc:  # noqa: BLE001 - registration must remain usable
            _LAST_SETUP_BUNDLE_REPORT = {
                "status": "error",
                "error": "bundle step raised unexpectedly",
            }
            logger.warning("[ocuclaw] /ocuclaw-setup bundle step failed: %s", exc)
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
    global PRE_TRANSCRIPTION_HOOK_AVAILABLE, AUXILIARY_CALL_HOOKS_AVAILABLE
    global POST_COMPACTION_HOOK_AVAILABLE, SESSION_DELETE_HOOK_AVAILABLE
    global _REGISTERED_OPTIONAL_FEATURES, _HUMAN_INPUT_WAITING_REGISTERED
    register_hook = getattr(ctx, "register_hook", None)
    # Probe BEFORE registering: hermes stores unknown hook names with a
    # warning instead of refusing them, so registering blind would spam the
    # log on every 0.20.0 host and advertise a feature that can never fire.
    STREAM_HOOKS_AVAILABLE, INTERIM_HOOK_AVAILABLE = _probe_optional_hook_support()
    PRE_TRANSCRIPTION_HOOK_AVAILABLE = _pre_transcription_hook_supported()
    run_signal_hooks = _run_signal_hook_plan(_valid_hook_names())
    AUXILIARY_CALL_HOOKS_AVAILABLE = False
    POST_COMPACTION_HOOK_AVAILABLE = False
    SESSION_DELETE_HOOK_AVAILABLE = False
    _REGISTERED_OPTIONAL_FEATURES = ()
    _HUMAN_INPUT_WAITING_REGISTERED = False
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
        # Straight after it, in order: the rest of a turn's context when it is
        # too long for one hook result (hook_context.py).
        for more in _PRE_LLM_CALL_PIECES.callbacks:
            register_hook(REGISTERED_HOOK_NAMES[5], more)
        # H11: the only signal a non-retryable provider error leaves behind.
        register_hook(REGISTERED_HOOK_NAMES[6], _on_api_request_error_hook)
        register_hook(REGISTERED_HOOK_NAMES[7], _on_post_llm_call_hook)
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
        # Run signals (`runSignal`). Observers only: none changes a provider
        # call, and Hermes ignores what they return. The cost is Hermes
        # building the hook payload for every model call (and every auxiliary
        # call) on this gateway; the handlers drop a foreign platform or a
        # non-compression auxiliary task before any lookup.
        for name, callback in run_signal_hooks:
            register_hook(name, callback)
        AUXILIARY_CALL_HOOKS_AVAILABLE = set(AUXILIARY_CALL_HOOK_NAMES) <= {
            name for name, _callback in run_signal_hooks
        }
        # Per-task counts for OcuClaw's own auxiliary calls (#5046): Hermes
        # counts aux usage only inside an agent turn, and the explainer, live
        # view refresh and input predictions run outside one. Probed like the
        # rest; observers only, filtered to OcuClaw's three task keys. They
        # ride the run-signal pair above, so they need it wired whole.
        _AUX_USAGE_HOOKS.clear()
        aux_usage.register_hooks(
            _AUX_USAGE_HOOKS.__setitem__,
            _valid_hook_names() if AUXILIARY_CALL_HOOKS_AVAILABLE else frozenset(),
            _emit_aux_call_debug,
        )
        # Observers only: they never answer, delay or change a prompt.
        _HUMAN_INPUT_WAITING_REGISTERED = _register_human_input_waiting(register_hook)
        if _HUMAN_INPUT_WAITING_REGISTERED:
            _REGISTERED_OPTIONAL_FEATURES += (FEATURE_TOKEN_HUMAN_INPUT_WAITING,)
        # An observer: it fires once per committed compaction and never
        # changes one. Hermes builds the payload only when a listener exists,
        # and the callback only bumps memory, so the commit window stays short.
        POST_COMPACTION_HOOK_AVAILABLE = compaction_ledger.register_hook(
            register_hook, _valid_hook_names(), _on_compaction_event
        )
        # An observer: it fires after the delete committed and never changes
        # it. Hermes builds the payload for every delete whether or not a
        # plugin listens, so wiring it costs nothing on other surfaces.
        if SESSION_DELETE_HOOK_NAME in _valid_hook_names():
            register_hook(SESSION_DELETE_HOOK_NAME, _on_session_delete_hook)
            SESSION_DELETE_HOOK_AVAILABLE = True
        _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = True
    else:
        _POST_APPROVAL_RESPONSE_HOOK_AVAILABLE = False
        logger.warning(
            "[ocuclaw] ctx.register_hook unavailable — turn completion "
            "(agent_end/terminal activity/tail commit) is degraded to the "
            "stale-turn janitor"
        )
    # Plain-English approval cards: the `purpose` field (request middleware)
    # and the approval-to-tool-call join. Both feature-detected; neither
    # changes what Hermes's own approval checks see.
    try:
        _register_approval_purpose(ctx, register_hook)
    except Exception:  # noqa: BLE001 - optional, must never break plugin load
        logger.warning("[ocuclaw] approval purpose wiring failed", exc_info=True)
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
    # The owner's approve in this pairing also answers Hermes' own sender
    # check (SPEC #2939 amendment): one approval, not a second code.
    outcome = await asyncio.to_thread(record_wearer_sender_approval)
    logger.info("[ocuclaw] Hermes sender approval: %s", outcome)
    # A job made off the glasses with delivery set to OcuClaw needs a home
    # chat (#5025). Only when none is set: a /sethome or env home stays.
    outcome = await asyncio.to_thread(set_default_home_channel)
    logger.info("[ocuclaw] Hermes home channel: %s", outcome)
    return {"ok": True}


async def _handle_reply_delivery_report(params: Any) -> Dict[str, Any]:
    """Join one validated client SDK receipt to the current phone candidate.

    Closed shape in, closed answer out. A duplicate of the same observation
    answers ``{ok: true}`` so the child's bounded retry terminates; an
    unknown or replaced candidate is refused and nothing is persisted.
    """

    normalized, error = validate_reply_delivery_report(params)
    if normalized is None:
        return {"ok": False, "error": error or "invalid_params"}
    try:
        result = await asyncio.to_thread(record_reply_delivery, **normalized)
    except Exception:  # noqa: BLE001 — a receipt fault must not kill the link
        logger.exception("[ocuclaw] reply-delivery receipt unavailable")
        return {"ok": False, "error": "receipt_unavailable"}
    if result.get("ok") is True:
        return {"ok": True}
    return {"ok": False, "error": str(result.get("error") or "receipt_unavailable")}


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

        @staticmethod
        def extract_local_files(content):
            # Hermes runs this on a final reply it sends un-streamed, and lifts
            # every bare path to an existing file (.md, .json, a picture) out
            # of the text to attach it. This adapter has no file transport, so
            # the wearer got a sentence with a hole in it and "Couldn't
            # deliver the file attachment". Lift nothing: a path in prose
            # stays as written, as it already does in a streamed reply, and a
            # LiveUI record keeps its picture paths (#5186).
            return [], content

        @classmethod
        def supports_exec_approval_buttons(cls) -> bool:
            # From 0.21.3 the runner sends approvals through send_exec_approval
            # only when this says True, and the base answers from the
            # _send_exec_approval_prompt hook. OcuClaw overrides
            # send_exec_approval itself (the glasses approval card), so without
            # this the runner sent its plain-text /approve prompt instead,
            # which the glasses never show.
            return True

        def __init__(self, platform_config, platform) -> None:
            # Hermes 0.20 constructs secondary-profile adapters under a
            # context-local HERMES_HOME override. OcuClaw owns
            # one relay listener, so a second instance must fail before it can
            # spawn the Node child; the gateway logs and skips that adapter.
            _guard_secondary_port_binding_scope()
            platform_config = _with_wearer_grant(platform_config)
            super().__init__(platform_config, platform)
            self._settings = resolve_adapter_settings(platform_config)
            # Keep the construction-time value across reconnects and plugin
            # reloads; reading config when publishing would hide pending setup.
            from .setup_activation import current_fingerprint

            self._setup_configuration_fingerprint = current_fingerprint()
            _check_liveui_tool_timeout_budget(
                _liveui_render_link_timeout_s(self._settings)
            )
            # One observation at a time (presence pump, runtime.ready and the
            # optional-setup status RPC share hermes_cli's env cache and the
            # receipt flock); always off the event loop.
            self._optional_observe_lock = asyncio.Lock()
            self._optional_observe_task: Optional["asyncio.Task[Any]"] = None
            self._cloudways_detect_task: Optional["asyncio.Task[Any]"] = None
            self._link: Optional[LinkProcess] = None
            # W06 dispatch plane (D9): runId correlation authority.
            self._namespace = DEFAULT_SESSION_NAMESPACE
            self._ledger = DispatchLedger(
                stale_turn_seconds=self._settings["staleTurnSeconds"],
            )
            self._session_status = SessionStatusObserver()
            self._phone_turn_candidate_gate = PhoneTurnCandidateGate()
            # The phone's session-name toggle over Hermes's own titler
            # (session_title_hold.py): sessions we held at llm provenance.
            self._title_hold = SessionTitleHold()
            # H11 (#3348). The provider-error mark lives HERE, not on the
            # dispatch record: `_touch_record_locked` clears the record's
            # `terminal_error_code` on every note_send, and the engine's own
            # error text is sent after the hook fires — so a record-held mark
            # is always gone by the time the commit seam reads it.
            self._provider_error_marks: Dict[Tuple[str, str], str] = {}
            self._provider_error_marks_lock = threading.RLock()
            # Phone turns whose committed reply was Hermes's own failed-turn
            # apology (`is_failed_turn_reply`). Hermes reports such a turn as
            # delivered, so only the reply's text says the run failed. Read
            # once, when the turn's candidate is published.
            self._failed_turn_reply_runs: Dict[Tuple[str, str], bool] = {}
            # Run signals (`runSignal`, PROTOCOL.md): the open model-call,
            # compaction and subagent spans, so every end pairs with the start
            # this adapter sent.
            self._run_signals = RunSignalSpans()
            self._card_image_models = CardImageModels()
            # Strong refs for the fire-and-forget reply-delivery observations,
            # so the loop cannot collect one mid-flight.
            self._reply_delivery_tasks: set = set()
            # Tier 0 in-flight signal (T2 #2510): session_id → {at, platform}
            # for EVERY platform this gateway runs (fed by pre_llm_call / tool
            # hooks BEFORE their ocuclaw platform filter, cleared by
            # on_session_end, TTL-expired as the fail-safe). Zero idle cost: no
            # timer — expiry is checked lazily on read. Declared HERE, ahead of
            # routing, because the #2942 drain release asks it whether anything
            # is still running and routing is refreshed during construction.
            self._inflight: Dict[str, Dict[str, Any]] = {}
            self._inflight_lock = threading.Lock()
            self._multiplex_enabled = False
            self._served_profile_homes: Dict[str, Path] = {}
            # #2942: namespaces that have LEFT the served set while this
            # process may still have output for them — see
            # `_note_route_departures`. Never a route for new work.
            self._draining_profile_homes: Dict[str, Path] = {}
            self._draining_profile_until: Dict[str, float] = {}
            # Routing is now read from every lane — the loop and the worker
            # threads RPC handlers run in — so the read-modify-write that moves
            # a namespace into or out of the drain set needs one owner.
            self._routing_lock = threading.RLock()
            self._native_profile_routes: List[Any] = []
            # #2940: OcuClaw's own enrollment set, installed BEFORE the first
            # route read so no resolution in this process's life is ever wider
            # than the wearer's selection. This one call migrates the retired
            # `gateway.multiplex_profile_allowlist` (when it is still there)
            # and installs the admission predicate on the shared resolver, so
            # every reader downstream of `load_profile_routing_snapshot` — the
            # agent menu, the RPC facade, dispatch, session resolution, the
            # management lane — is bounded by the same set.
            self._install_profile_enrollment()
            self._refresh_profile_routing()
            # Sessions-plane SessionDB glue: the default reader is preserved
            # byte-for-byte outside multiplex; secondary readers are lazy.
            self._session_rpc = ProfileSessionRpc(
                default_db_path=default_state_db_path(),
                routing_provider=self._profile_routing_snapshot,
                # #2940: the ambient finalizer alone may read a draining
                # profile's own DB, so a turn in an agent the wearer just
                # removed still records how it ended.
                routable_provider=self._profile_routing_routable,
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
            # W07 models/status/config read plane (gw.* lanes).
            self._gw_rpc = GwRpc(
                namespace=self._namespace,
                routing_provider=self._profile_routing_snapshot,
                adopt_supported_provider=self.adopt_configured,
                shared_chats_provider=self.shared_chats,
                auto_route_provider=self.auto_route_available,
            )
            self._gw_rpc._management_adapter = self
            # Auto agent (#6795): which enrolled agent takes a new chat.
            self._agent_route_rpc = AgentRouteRpc(
                enabled=self.auto_route_available,
                candidates=self._gw_rpc.route_candidates,
                llm=lambda: getattr(_PLUGIN_CONTEXT, "llm", None),
                task=lambda: aux_tasks.task_for(aux_tasks.AGENT_ROUTER_TASK),
            )
            # STT lane (#1938): what the connected Hermes can transcribe with.
            # Live words send `stt.stream.partial` back down the current link.
            self._stt_rpc = SttRpc(send_to_child=self._stt_send_to_child)
            # TTS lane: read replies aloud with Hermes's own configured voice.
            self._tts_rpc = TtsRpc()
            # Silent input (#2829): direct predictions from ctx.llm.
            # Late-bound lambdas: the module globals are read per call, so a
            # register()-time flag flip (and a test monkeypatch) is honoured.
            # #2836: per-profile — profileId (a Hermes profile name from the
            # authenticated session) → a namespace this gateway serves; the
            # policy/route readers run inside that profile's runtime scope.
            self._input_prediction_rpc = InputPredictionRpc(
                lambda: getattr(_PLUGIN_CONTEXT, "llm", None),
                hermes_version=lambda: _hermes_version(),
                task_registered=lambda: _INPUT_PREDICTION_TASK_REGISTERED,
                get_policy=lambda: _input_prediction_policy(),
                get_route_config=lambda: _input_prediction_route_config(),
                resolve_profile=self._input_prediction_resolve_profile,
                profile_scope=self._input_prediction_profile_scope,
                allow_model=_input_prediction_allow_model,
                # #3411: credentials filter + Fast badge from Hermes price data.
                model_facts=hermes_reply_model_facts,
            )
            self._loop: Optional[asyncio.AbstractEventLoop] = None
            self._janitor_task: Optional[asyncio.Task] = None
            self._first_run_welcome_task: Optional[asyncio.Task] = None
            self._welcome_inspection_generation = 0
            # #3010: the last setup-hint phase this adapter told its runtime
            # child about. Edge memory only — the phase itself is re-derived
            # from the host's receipt on every watcher pass.
            self._setup_hint_phase: Optional[str] = None
            self._message_seq = 0
            self._delivery_record: ContextVar[Any] = ContextVar(
                "ocuclaw_delivery_record", default=None
            )
            self._processing_deliveries: Dict[Tuple[str, str], Any] = {}
            self._completed_replies = CompletedReplies()
            # #3231. Monotonic stamp of the last phone-origin reply run to
            # reach its terminal boundary, and when the welcome first started
            # waiting on one. Both are welcome-timing only.
            self._ocuclaw_reply_settled_at: Optional[float] = None
            self._welcome_defer_since: Optional[float] = None
            # Per-process uniqueness for the minted platform message id
            # (#1691) — see `_next_message_id`.
            self._message_id_nonce = uuid.uuid4().hex[:8]
            # Plugin `post_message` ids -> their session identity, oldest
            # first, so `handle.edit` finds its message. Loop-only.
            self._plugin_messages: Dict[str, Dict[str, Any]] = {}
            self._stream_tail_lock = threading.RLock()
            self._stream_tail_closures: Dict[Tuple[str, str], Dict[str, Any]] = {}
            self._stream_tail_tasks: Dict[Tuple[str, str], asyncio.Task] = {}
            # Set under _stream_tail_lock during disconnect: refuses new
            # closure stashes so the shutdown drain can run to empty.
            self._stream_tail_closing = False
            # Reply-stream slot per runId (STREAM_SLOT_FLOOR_MS). Touched only
            # on self._loop, so it needs no lock.
            self._stream_flush_floor_s = self._settings["streamFlushMs"] / 1000.0
            self._stream_slots: Dict[str, Dict[str, Any]] = {}
            # Closing frames the link refused as overloaded, retried in order
            # by one drain task (loop-only, like the slots).
            self._critical_backlog: deque = deque()
            self._critical_drain_task: Optional["asyncio.Task[Any]"] = None
            self._link_delivery_counters: Dict[str, int] = {
                "stream_frames_sent": 0,
                "stream_frames_coalesced": 0,
                "critical_retried": 0,
                "critical_recovered": 0,
                "critical_dropped": 0,
            }
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
            # Hermes keeps ONE progress bubble open and edits every later
            # tool line into it until a content send lands, so a tool that
            # starts while a bubble is open arms nothing.
            self._pending_tool_progress_by_run: Dict[str, List[str]] = {}
            self._tool_progress_message_ids_by_run: Dict[str, set] = {}
            self._open_tool_progress_bubble_by_run: Dict[str, str] = {}
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
            # #6794: background delegate_task calls' routes, held for the turn
            # that reads their results (delegation_routes.BackgroundDelegations).
            self._background_delegations = BackgroundDelegations()
            # Newest todo_list revision seen per Hermes session id, so a late
            # post_tool_call from an older plan cannot roll the glance back.
            self._plan_revisions: Dict[str, int] = {}
            # #5147: each session's last full-screen Bot Screen capture, so a
            # pointer action can name its target before it lands.
            self._bot_screen_targets = bot_screen.ToolTargets()
            self._bot_screen_control = bot_screen_control.ControlBroker()
            # #5151: which turns used the screen, for Peek and for Needs you.
            self._bot_screen_turns = bot_screen.ScreenTurns()
            # #5152: each OcuClaw session's newest computer_use call, for the
            # approval card Hermes may raise inside it.
            self._bot_screen_approvals = bot_screen.ApprovalViews()
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
            # Live status-bar headlines per run, for the CURRENT model call
            # only: that call's streamed reasoning, the scan position after
            # its last closed `**span**`, the span count, and the last
            # headline sent. post_api_request takes it, so it never repeats
            # the headline the stream already showed.
            self._stream_headlines_by_run: Dict[str, Dict[str, Any]] = {}
            # `modelCallSeq` per run: the 1-based ordinal of each logical
            # model call (``api_request_id``; its retries share it), the
            # turn counter each call carried (the stream hooks name a call
            # only by that counter), and the call that started last. Tools
            # run between the call that requested them and the next call's
            # pre_api_request, so "current" is the requesting call for them.
            self._model_call_seq_by_run: Dict[str, Dict[str, Any]] = {}
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
            # Hermes Board moments (#3051): tail -> pending -> push -> ack.
            self._board_moments: Optional[MomentPump] = None
            # Task pop-ups (#5028): stored Task Results -> push -> app ack.
            self._task_push = TaskPushBridge(self._task_push_request)
            # Task results another process queued (#5031).
            self._task_inbox: Optional[task_delivery.InboxPump] = None
            _ADAPTERS.append(self)
            _record_serving_version()

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

        async def _apply_card_switches(self, home):
            """Apply persisted card permissions once; only an ack is active evidence."""
            from .optional_diagnostics import configured

            if not self.link_ready:
                return False
            flags = await asyncio.to_thread(configured)
            wanted = {"jev": flags["program_cards_jev"], "mcp": flags["program_cards_mcp"], "model": flags["program_cards_model"]}
            ack = await self._link.request("program_cards.switches.apply", wanted, timeout_s=2.0)
            if not isinstance(ack, dict) or any(type(ack.get(k)) is not bool or ack[k] != v for k, v in wanted.items()):
                return False
            for key, block in (("jev", "programCardsJev"), ("mcp", "programCardsMcp"), ("model", "programCardsModel")):
                self._settings[block] = {**self._settings.get(block, {}), "enabled": ack[key]}
            return await self._observe_optional_runtime(home=home) is not None

        async def _apply_liveui_jev(self, home):
            """Apply the saved Smart interfaces switch to the running relay, no restart.

            Only the boolean crosses the link: the relay already holds the saved TypeSafe
            key (`typesafeApiKey`). Active evidence is the relay's ack: `enabled` matching
            the saved switch and, when on, `keyed`. Anything else (an older runtime's
            method-not-found, no answer, a switch on with no key the relay can use) is
            False, and the switch keeps its restart path.
            """
            from .optional_diagnostics import configured

            if not self.link_ready:
                return False
            wanted = (await asyncio.to_thread(configured))["liveui_jev"]
            try:
                ack = await self._link.request("liveui.jev.apply", {"enabled": wanted}, timeout_s=2.0)
            except Exception:
                return False
            if (not isinstance(ack, dict) or ack.get("enabled") is not wanted
                    or (wanted and ack.get("keyed") is not True)):
                return False
            # What a relay respawned from these settings would load: the same group, resolved
            # by the same rule as at start, so the switch survives a child restart.
            previous = self._settings.get("liveuiJev") or {}
            self._settings["liveuiJev"] = _resolve_liveui_jev(
                {"enabled": wanted, "budgetMs": previous.get("budgetMs")},
                self._settings.get("typesafeApiKey") or "")
            return await self._observe_optional_runtime(home=home) is not None

        async def _observe_optional_runtime(self, home=None):
            """Record what the live relay loaded against the current disk.

            Serialized and threaded: the receipt lock may spin up to 5 s and
            hermes_cli's env cache is process-global, so two concurrent
            observations could read a half-written env (spurious restart offer)
            or block every RPC on the loop. Shielded: a cancelled caller (a
            pull budget, a closing RPC) must not release the lock while the
            thread is still observing. Returns the observation (receipts,
            disk and diagnostics it read and wrote) or None.
            """
            from .optional_setup import observe_runtime

            async def _observe():
                async with self._optional_observe_lock:
                    return await asyncio.to_thread(observe_runtime, self._settings, home=home)

            return await asyncio.shield(_observe())

        def _schedule_optional_observation(self, home=None) -> None:
            """Observe after a presence pull, outside the pull's 2 s budget.

            One in-flight observation at a time; the next pull re-schedules.
            """
            task = self._optional_observe_task
            if task is not None and not task.done():
                return
            task = asyncio.create_task(self._observe_optional_runtime(home=home))
            task.add_done_callback(lambda done: done.cancelled() or done.exception())
            self._optional_observe_task = task

        def _schedule_cloudways_detection(self, detect) -> None:
            """Run the once-per-process Cloudways verdict as a tracked task.

            One in flight at a time; a reconnect while it runs reuses it. The
            verdict lands in `optional_setup_rpc`'s cache from the worker
            thread, so a cancelled task (disconnect) loses nothing.
            """
            task = self._cloudways_detect_task
            if task is not None and not task.done():
                return
            task = asyncio.create_task(asyncio.to_thread(detect))
            task.add_done_callback(lambda done: done.cancelled() or done.exception())
            self._cloudways_detect_task = task

        def _build_board_moment_pump(self) -> MomentPump:
            """#3051: the moment pump pushes over ``self._link`` read at call
            time, so a link that died reads as a failed push and the moments
            stay pending for the next tick."""

            async def _request(method: str, params: Dict[str, Any]) -> Any:
                link = self._link
                if link is None or not link.ready:
                    raise LinkError("control link not ready")
                return await link.request(
                    method, params, timeout_s=BOARD_MOMENT_PUSH_TIMEOUT_S
                )

            # #3052: the relay credential this link serves is the delivery
            # authority; a new pairing reopens what the old one acked.
            return MomentPump(
                _request,
                authority=board_moment_authority_id(
                    (self._settings or {}).get("relayToken")
                ),
            )

        async def _task_push_request(self, method: str, params: Dict[str, Any]) -> Any:
            """#5028: Task Result pushes go over ``self._link`` read at call
            time; a link that is down reads as a failed push (0 sent), so the
            result stays unacked and its chat text is delivered."""
            link = self._link
            if link is None or not link.ready:
                raise LinkError("control link not ready")
            return await link.request(method, params, timeout_s=TASK_PUSH_TIMEOUT_S)

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
            record_sender_gate = _sender_gate_recorder(home, fingerprint)

            async def _pull() -> Any:
                link = self._link
                if link is None or not link.ready:
                    # Typed so the receipt records `link_down` rather than the
                    # generic `pull_failed`: "the link is gone" and "the relay's
                    # presence method failed" need different repairs.
                    raise PresenceLinkUnavailableError("control link not ready")
                result = await link.request(
                    PRESENCE_SNAPSHOT_METHOD, None, timeout_s=PULL_TIMEOUT_S
                )
                # Staging rides the same pull but stays out of the receipt:
                # unknown (null) hides the card tools like an explicit false.
                if isinstance(result, dict) and "programCards" in result:
                    if not _phone_only_dropped(result):
                        set_program_cards_staging(result.get("programCards") is True)
                # The relay answered: observe what it loaded, but not inside
                # the pump's wait_for budget (a lock wait would time the pull
                # out and lose the presence receipt for the cycle).
                self._schedule_optional_observation(home=home)
                return result

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
                try:
                    write_app_presence(body, home=home)
                finally:
                    # Same home, same cadence; never raises.
                    record_sender_gate()
                    # Pause model Tasks after 2 days away (#5037); never raises.
                    task_away.observe(body, home=home)

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
            # A fresh wearer on Claude gets reasoning effort medium (and so
            # reasoning text on the bar) when nothing chose an effort.
            runner = getattr(self, "gateway_runner", None)
            if runner is not None:
                claude_reasoning_default.install(runner, PLATFORM_NAME)
            self._refresh_profile_routing()
            await self._publish_serving_version()
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
            # The bridge supports current-session model/thinking/fast on
            # released Hermes through its session-scoped slash commands when
            # the structured API is absent. Advertise the supported controls.
            child_config["sessionOptionsSupported"] = True
            # #5146: where the served profile's Bot Screen socket is, and which
            # bot-desktop facts this Hermes can give. Nothing on a Hermes without
            # one. The child reads the socket watch-only.
            child_config.update(bot_screen.hello_config(_hermes_home()))
            child_config["botScreenProfileRouting"] = bool(child_config.get("botScreenSocket"))
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
            for method, handler in self._agent_route_rpc.handlers().items():
                link.register_request_handler(method, handler)
            from .restart_rpc import RestartRpc
            self._restart_rpc = RestartRpc(self, self._gw_rpc)
            link.register_request_handler("gw.hermes.management", self._restart_rpc.handle)
            from .optional_setup_rpc import (
                OptionalSetupRpc,
                cloudways_host,
                detect_cloudways_host,
            )
            # The status RPC arrives over this link, so the relay that loaded
            # `self._settings` is the one answering: re-observing against the
            # current disk is the same evidence the pump records (#3357).
            self._optional_setup_rpc = OptionalSetupRpc(
                self._restart_rpc, observe=self._observe_optional_runtime,
                apply_card_switches=self._apply_card_switches,
                apply_liveui_jev=self._apply_liveui_jev,
            )
            link.register_request_handler("gw.optional.setup", self._optional_setup_rpc.handle)
            link.register_request_handler("gw.optional.setup.disconnect", self._optional_setup_rpc.disconnect)
            if not cloudways_host():
                # Once per process, off the loop (`ps` subprocess, up to 5 s)
                # and after the handlers are live: connect never waits on it.
                # The snapshot reads the cached verdict, false until known.
                # A Cloudways verdict also hands an old cron watchdog to the
                # runtime (#6359), in the same worker thread.
                self._schedule_cloudways_detection(
                    lambda: _cloudways_detect_then_adopt(detect_cloudways_host)
                )
            for method, handler in self._stt_rpc.handlers().items():
                link.register_request_handler(method, handler)
            for method, handler in self._tts_rpc.handlers().items():
                link.register_request_handler(method, handler)
            link.register_request_handler(
                FOREIGN_COPY_METHOD, self.handle_foreign_copy
            )
            link.register_request_handler(
                FOREIGN_ADOPT_METHOD, self.handle_foreign_adopt_gate
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
                bot_screen.STATUS_METHOD, self.handle_bot_screen_status
            )
            link.register_request_handler(bot_screen.START_METHOD, self.handle_bot_screen_start)
            link.register_request_handler("botScreen.route", self.handle_bot_screen_route)
            link.register_request_handler(bot_screen_control.METHOD, self.handle_bot_screen_control)
            link.register_request_handler(
                bot_screen.SNAPSHOT_METHOD, self.handle_bot_screen_snapshot
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
            # Silent input (#2829): direct, agent-free word predictions from
            # the plugin's ctx.llm. Child-initiated lane; identical method
            # names on both sides of the link.
            for method, handler in self._input_prediction_rpc.handlers().items():
                link.register_request_handler(method, handler)

            # Plain-English approval cards: the shared explainer in the child
            # writes its one sentence with this plugin's ctx.llm.
            link.register_request_handler(
                APPROVAL_LLM_COMPLETE_METHOD, _approval_explainer_complete
            )

            # The phone's AI review of a saved card: the shared reviewer in
            # the child runs each stage's model call with this plugin's ctx.llm.
            link.register_request_handler(
                CARD_REVIEW_LLM_COMPLETE_METHOD, _card_review_complete
            )
            link.register_request_handler(CARD_REVIEW_LLM_CANCEL_METHOD, _CARD_REVIEW_CALLS.cancel)
            # A program card's frame step: one art-script reply, no tools.
            link.register_request_handler(CARD_FRAME_LLM_COMPLETE_METHOD, _card_frame_complete)
            link.register_request_handler(CARD_FRAME_LLM_CANCEL_METHOD, _CARD_FRAME_CALLS.cancel)
            # A saved card's Library icon without Jev: one word, no tools.
            link.register_request_handler(CARD_ICON_LLM_COMPLETE_METHOD, _card_icon_complete)
            link.register_request_handler(CARD_ICON_LLM_CANCEL_METHOD, _CARD_ICON_CALLS.cancel)
            link.register_request_handler("task.proposal.llm.complete", _task_proposal_complete)
            link.register_request_handler("task.proposal.llm.cancel", _TASK_PROPOSAL_CALLS.cancel)
            link.register_request_handler("agent.draft.llm.complete", _agent_draft_complete)
            link.register_request_handler("agent.draft.llm.cancel", _AGENT_DRAFT_CALLS.cancel)
            card_models = ScopedCardModels(
                resolve_profile=self._input_prediction_resolve_profile,
                profile_scope=self._input_prediction_profile_scope,
                models_rpc=self._gw_rpc,
                llm=lambda: getattr(_PLUGIN_CONTEXT, "llm", None),
                task=lambda: aux_tasks.task_for(aux_tasks.CARD_MODEL_TASK),
            )
            link.register_request_handler("program_card.model.complete", card_models.complete)
            link.register_request_handler("program_card.model.cancel", card_models.cancel)
            link.register_request_handler("program_card.model.models", card_models.models)
            link.register_request_handler("program_card.model.allow", card_models.allow)
            link.register_request_handler("program_card.model.permits", card_models.permits)
            link.register_request_handler("program_card.model.revoke", card_models.revoke)

            # MCP in program cards (reads only): the owner's MCP tools as
            # Hermes's own client knows them, one read through ctx.call_mcp,
            # and the owner's per-server switch (card_mcp.py).
            link.register_request_handler(
                PROGRAM_CARD_MCP_LIST_METHOD, program_card_mcp_list
            )
            link.register_request_handler(PROGRAM_CARD_MCP_CALL_METHOD, _card_mcp_call)
            link.register_request_handler(
                PROGRAM_CARD_MCP_ALLOW_METHOD, program_card_mcp_allow
            )

            # The wearer's "Explain commands" setting gates the `purpose`
            # schema field and the approval context (approval_explain.py).
            async def _on_approval_explain_setting(params: Any) -> Dict[str, Any]:
                result = _APPROVAL_EXPLAIN_SETTING.apply(params)
                # Waiting on you approvals carry the explainer input only
                # while it is on (#4985).
                _HUMAN_INPUT_WAITING.refresh()
                return result

            link.register_request_handler(
                APPROVAL_EXPLAIN_SETTING_METHOD, _on_approval_explain_setting
            )

            # Waiting on you (#4979): the wearer's per-surface switches, and
            # whether this host can report waits at all.
            async def _on_waiting_settings(params: Any) -> Dict[str, Any]:
                return _waiting_settings_reply(params)

            link.register_request_handler(
                human_input_waiting.WAITING_SETTINGS_METHOD, _on_waiting_settings
            )

            # Answer one of those waits from the glasses (#4983), by its
            # exact pending id and only while the answer switch is on.
            async def _on_waiting_answer(params: Any) -> Dict[str, Any]:
                return await asyncio.to_thread(_waiting_answer_reply, params)

            link.register_request_handler(
                human_input_waiting.WAITING_ANSWER_METHOD, _on_waiting_answer
            )
            runtime_ready: asyncio.Event = asyncio.Event()
            self._runtime_ready_event = runtime_ready

            async def _on_runtime_ready(_params: Any) -> Dict[str, Any]:
                await self._observe_optional_runtime()
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
            # Reply-delivery reports arrive shortly after a phone turn, and
            # the report may beat the host's wait either way round.
            link.register_request_handler(
                REPLY_DELIVERY_REPORT_METHOD, _handle_reply_delivery_report
            )
            # The presence lane must be live BEFORE the child can speak: a
            # phone that is already connected when the relay boots produces a
            # push during the handshake window, and a `-32601` there would
            # cost exactly the post-pairing delay this hop exists to remove.
            self._presence = self._build_presence_pump()
            link.register_request_handler(
                PRESENCE_DIRTY_METHOD, self._presence.handle_dirty
            )
            # #3051: the phone's moment acks can arrive as soon as the relay
            # boots (a phone replays its outbox on reconnect).
            self._board_moments = self._build_board_moment_pump()
            link.register_request_handler(
                BOARD_MOMENT_ACK_METHOD, self._board_moments.handle_ack
            )
            # #5028: a capable app's connect (unacked read) and its acks.
            for method, handler in self._task_push.handlers().items():
                link.register_request_handler(method, handler)
            try:
                hello = await link.start()
            except LinkError as exc:
                logger.error("[ocuclaw] runtime child failed to start: %s", exc)
                return False
            _note_runtime_hello()
            _remember_runtime_hello(hello)
            _register_liveui_tool_from_hello(hello)
            _register_phone_tools_from_hello(hello)
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
            if self._board_moments is not None:
                self._board_moments.start()
            if self._task_inbox is None:
                self._task_inbox = task_delivery.InboxPump(
                    self.send, push_result=self._task_push.deliver_stored,
                    # #6420: a Task run that started or ended rings the rows out.
                    watch_runs=self._task_push.watch_runs,
                )
            self._task_inbox.start()
            # Tasks deliver to OcuClaw, which needs a home chat (#5025).
            # Pairing sets one, but a wearer paired before that (or with no
            # pairing receipt) has none, so fill an empty slot here too. A
            # /sethome or env home stays.
            outcome = await asyncio.to_thread(set_default_home_channel)
            logger.info("[ocuclaw] Hermes home channel: %s", outcome)
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
            # A new child starts with no hint, so the edge memory must not
            # outlive this link or the first pass after a reconnect would skip
            # the push that puts a live row back on the phone (#3010).
            self._setup_hint_phase = None
            # The gateway leaves through os._exit, which skips atexit: write
            # the per-task aux counts (#5048) while teardown still runs.
            aux_usage.flush_live_tally()
            # Clean shutdown is one of the receipt's three write triggers: say
            # so now rather than leaving the last healthy reading to age out
            # over the next two minutes and read as current in between.
            presence = self._presence
            self._presence = None
            if presence is not None:
                await presence.stop()
            # No relay, no phone to run a card: hide the card tools until the
            # next connect's pull says Staging is on.
            set_program_cards_staging(False)
            moments = self._board_moments
            self._board_moments = None
            if moments is not None:
                await moments.stop()
            inbox, self._task_inbox = self._task_inbox, None
            if inbox is not None:
                await inbox.stop()
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
            # Live words end with the link: their partials have nowhere to go
            # and the relay that staged their uploads is stopping.
            stt_rpc = getattr(self, "_stt_rpc", None)
            if stt_rpc is not None:
                stt_rpc.cancel_all_streams()
            link = self._link
            self._link = None
            self._stream_slots_reset()
            with self._thinking_lock:
                self._thinking_text_by_run.clear()
                self._thinking_seq_by_run.clear()
            self._phone_turn_candidate_gate.clear()
            self._completed_replies.clear()
            if link is not None:
                code = await link.terminate()
                logger.info("[ocuclaw] runtime child stopped (code=%s)", code)
            close_sessions = getattr(self._session_rpc, "close", None)
            if callable(close_sessions):
                await asyncio.to_thread(close_sessions)
            self._remove_native_profile_routes()
            self._mark_disconnected()

        # -- outbound transport (StreamConsumer + gateway sends) -------------

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            plugin_post = _called_from_plugin_messages()
            if self._delivery_is_cancelled():
                # Acknowledge suppression so Hermes does not retry/fallback
                # with the same cancelled answer as an uncorrelated send.
                return SendResult(success=True, message_id=self._next_message_id())
            from . import task_results

            if task_results.task_job_id(metadata) is not None and is_test_job(task_results.task_job_id(metadata)):
                # #6422: a "See it work" test answers the Draft on the phone and keeps nothing.
                await self._task_push.deliver_test(strip_stream_cursor(content), metadata)
                return SendResult(success=True, message_id=self._next_message_id())
            if task_results.task_job_id(metadata) is not None:
                # A cron delivery (Hermes puts the job id in its metadata) is
                # a Task result, not chat: keep it on the host and push it to
                # the glasses (#5026, #5028). Once kept, the home chat stays
                # quiet (#5817): an app that missed it gets it on the next
                # connect. Only a store failure sends the clean text there.
                held, content = await self._task_push.deliver_send(
                    strip_stream_cursor(content), metadata
                )
                if held:
                    return SendResult(success=True, message_id=self._next_message_id())
            text = _gateway_auth_recovery_message(strip_stream_cursor(content))
            message_id = self._next_message_id()
            if plugin_post:
                return self._send_plugin_message(chat_id, text, message_id, metadata)
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
            if _is_hermes_nonconversational_status(text, metadata):
                # Not chat: acknowledge it so Hermes does not retry, and keep it
                # out of the conversation the wearer reads.
                logger.info("[ocuclaw] kept a Hermes status line out of the conversation")
                return SendResult(success=True, message_id=message_id)
            try:
                ns = self._namespace_for_outbound(metadata, chat_id=chat_id)
            except AmbiguousOutboundNamespaceError as exc:
                return SendResult(success=False, error=str(exc))
            session_key = self._session_key_for_chat(chat_id, ns=ns)
            text = self._project_completed_reply(session_key, text, metadata)
            identity = parse_ocuclaw_session_key(session_key) or {
                "ns": ns,
                "chatId": str(chat_id),
            }

            inline = self._delivery_record.get()
            if inline is not None and getattr(inline, "inline_reply", False):
                # A busy slash that Hermes answered inline, including a
                # settings command refused while the agent runs. Its reply
                # is its own message: it must not land in
                # the running turn's open message (the head), and the record
                # closes here instead of promoting to a phantom turn when the
                # head ends. Sent uncorrelated, like any message the running
                # turn did not write. A later send from this context (/btw's
                # answer) finds the record closed and is uncorrelated too.
                closed, promoted = self._ledger.complete_inline_slash(
                    inline.session_key, inline
                )
                self._emit_event(
                    "message",
                    uncorrelated_message_event(
                        identity, text, message_id=message_id
                    ),
                )
                if closed:
                    self._emit_event(
                        "activity",
                        lifecycle_terminal_activity(inline, completed=True),
                    )
                if promoted is not None:
                    self._emit_event("activity", lifecycle_start_activity(promoted))
                return SendResult(success=True, message_id=message_id)

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

        def _send_plugin_message(self, chat_id, text, message_id, metadata):
            """A plugin's `ctx.post_message`: its own message, never the turn's.

            It stays out of the ledger. It is not a slash command's reply, not
            the turn's open message and not narration, so the wearer keeps it
            in the conversation and `handle.edit` can find it by id.
            """
            try:
                ns = self._namespace_for_outbound(metadata, chat_id=chat_id)
            except AmbiguousOutboundNamespaceError as exc:
                return SendResult(success=False, error=str(exc))
            session_key = self._session_key_for_chat(chat_id, ns=ns)
            identity = parse_ocuclaw_session_key(session_key) or {
                "ns": ns,
                "chatId": str(chat_id),
            }
            self._plugin_messages[message_id] = identity
            while len(self._plugin_messages) > PLUGIN_MESSAGE_MEMORY:
                self._plugin_messages.pop(next(iter(self._plugin_messages)))
            self._emit_event(
                "message",
                plugin_message_event(identity, text, message_id=message_id),
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
            request_id: Optional[str] = None,
        ) -> SendResult:
            if not hermes_version_supported(_hermes_version()):
                return SendResult(
                    success=False,
                    error=(
                        "approval mirroring requires supported hermes "
                        f"{_supported_hermes_range()}"
                    ),
                )
            data = {
                "command": command,
                "description": description,
                "metadata": metadata,
                "allow_permanent": allow_permanent,
                "allow_session": allow_session,
                "smart_denied": smart_denied,
            }
            # From 0.23.0 the runner passes the tools.approval request id as a
            # keyword (upstream cfed2ca71f), so a signature without it raises
            # TypeError and the glasses get the plain-text fallback instead of
            # a card. With the id the card resolves exactly that request; older
            # hosts pass none and the mirror claims one from the queue (#4983).
            if request_id:
                data["request_id"] = str(request_id)
            entry, delivery = self._handle_gateway_approval(
                str(session_key), data, swallow_errors=False,
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

                pending = pending_clarify_entry(clarify_module, clean_id)
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
            # #5151: asked in a turn that used the bot's screen, so the glasses
            # show it as Needs you, with the screen as its picture.
            if self._bot_screen_turns.used(session_key=str(session_key)):
                presentation["botScreen"] = True
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
            if self._delivery_is_cancelled():
                return SendResult(success=True, message_id=str(message_id))
            plugin_identity = self._plugin_messages.get(str(message_id))
            if plugin_identity is not None:
                # A plugin's `handle.edit`: the new text replaces its message
                # where it sits on the glasses.
                self._emit_event(
                    "message",
                    message_edit_event(
                        plugin_identity,
                        _gateway_auth_recovery_message(strip_stream_cursor(content)),
                        message_id=str(message_id),
                    ),
                )
                return SendResult(success=True, message_id=str(message_id))
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
            if finalize:
                text = self._project_completed_reply(session_key, text, metadata)
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
                # ~20 cumulative edits a second; _emit_event coalesces them
                # through the run's stream slot.
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

        async def _await_wake_session_release(self, session_key: str) -> None:
            """Hold a LiveUI wake (I11), or a turn sent behind a slash, while Hermes still holds the session."""

            def held() -> bool:
                # #6496: the runner keeps its own running-turn slot, which can
                # outlast the platform guard. A turn that lands while it is
                # set is queued by the runner and drained inside the running
                # task, with no on_processing_start and so no delivery record.
                runner = getattr(self, "gateway_runner", None)
                running = getattr(runner, "_is_session_running", None)
                if callable(running):
                    try:
                        if running(session_key):
                            return True
                    except Exception:
                        logger.debug("[ocuclaw] runner session check failed", exc_info=True)
                if session_key not in getattr(self, "_active_sessions", {}):
                    return False
                # A guard whose task already exited is healed by handle_message.
                stale = getattr(self, "_session_task_is_stale", None)
                return not (callable(stale) and stale(session_key))

            if not held():
                return
            started = time.monotonic()
            while held():
                if time.monotonic() - started >= WAKE_SESSION_RELEASE_TIMEOUT_S:
                    logger.warning(
                        "[ocuclaw] wake sent while Hermes still holds the session after %.1fs",
                        WAKE_SESSION_RELEASE_TIMEOUT_S,
                    )
                    return
                await asyncio.sleep(WAKE_SESSION_RELEASE_POLL_S)
            logger.info(
                "[ocuclaw] wake waited %d ms for Hermes to release the session",
                round((time.monotonic() - started) * 1000),
            )

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
            if (
                idem
                and idem.startswith("glasses-wake:")
                and not self._ledger.is_busy(session_key)
            ):
                # Wait first, so the replay and busy checks below see the state
                # after Hermes let the last turn go.
                await self._await_wake_session_release(session_key)
            ledger_idem = f"{session_key}\x1f{idem}" if idem else None
            existing = self._ledger.find_idempotent(ledger_idem)
            if existing is not None:
                self._discard_attachment_spills(attachments)
                result = {"status": existing.status, "runId": existing.run_id}
                if existing.session_state:
                    result["sessionState"] = existing.session_state
                return result

            command_parts = message.strip().split(None, 1)
            settings_command = command_parts[0] if command_parts else ""
            settings_args = command_parts[1].strip().lower() if len(command_parts) > 1 else ""
            settings_mutation = (
                settings_command in {"/model", "/reasoning", "/fast"}
                and bool(settings_args)
                and settings_args not in {"help", "--help"}
                and not (settings_command == "/fast" and settings_args == "status")
                and not (settings_command == "/model" and settings_args == "--refresh")
            )
            if settings_mutation:
                head = self._ledger.head(session_key)
                # A settings slash is not a running agent turn. In
                # particular consecutive /reasoning show and hide commands
                # must be admitted while a prior slash delivery is closing.
                agent_busy = (
                    (head is not None and head.kind == KIND_TURN)
                    or any(key == session_key and record.kind == KIND_TURN
                           for (key, _run), record in self._processing_deliveries.items())
                    or (head is None and session_key in getattr(self, "_active_sessions", {}))
                )
                if agent_busy:
                    self._discard_attachment_spills(attachments)
                    return {
                        "status": "rejected", "runId": run_id,
                        "errorCode": "session_busy",
                        "error": "Wait for this agent to finish responding before changing its settings.",
                    }

            # A turn sent right behind a slash (the relay's /fast switch before
            # a card build) must not reach Hermes while that slash still holds
            # the session. Hermes would queue it and later run it with no
            # on_processing_start, so the turn's sends and hooks would carry
            # no delivery record: its reasoning wrapper would go unstripped
            # and its interim lines unattributed. The slash closes within
            # milliseconds, so wait for Hermes to let go first.
            # #6496: the slash's own record can close (its reply is sent)
            # while Hermes's task still holds the session, so a turn with no
            # record ahead of it waits too. The wait returns at once when
            # Hermes holds nothing.
            head = self._ledger.head(session_key)
            if (
                (head is None or head.kind == KIND_SLASH)
                and not message.lstrip().startswith("/")
            ):
                await self._await_wake_session_release(session_key)

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
                elif (
                    record.kind == KIND_SLASH
                    and record.state == STATE_PENDING
                ):
                    # Hermes may dispatch a busy slash inline (/steer),
                    # refuse it inline, or queue it. Bind ALL
                    # pending slashes to their own delivery context so a
                    # refusal cannot replace the running answer and flicker
                    # against its stream. send() closes an inline reply;
                    # on_processing_start clears the flag for queued work.
                    record.inline_reply = True
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
                setattr(event, "_ocuclaw_delivery_record", record)
                # OCU-1E6C-EEX1: a Hermes plugin reload between turns drops
                # the hello-registered tools; put them back before this turn's
                # tool list is assembled.
                ensure_hello_tools_registered("inbound dispatch")
                # An inline reply is sent within this await, in this context:
                # it carries the slash record, as a processing task's sends
                # carry theirs (on_processing_start). /btw's background
                # answer copies the same context.
                inline_token = (
                    self._delivery_record.set(record)
                    if record.inline_reply
                    else None
                )
                try:
                    await self.handle_message(event)
                finally:
                    if inline_token is not None:
                        self._delivery_record.reset(inline_token)
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

        async def on_processing_start(self, event: Any) -> None:
            # Hermes invokes this in the processing task before starting the
            # handler/StreamConsumer. Its executor copies contextvars. Child
            # tasks retain THIS record even after a successor starts; origin
            # deliveries without a dispatch reset the context to None.
            record = getattr(event, "_ocuclaw_delivery_record", None)
            if record is not None and getattr(record, "inline_reply", False):
                # #5150: hermes found the session idle by now and runs the
                # slash as a turn after all; its sends are that turn's.
                record.inline_reply = False
            self._delivery_record.set(record)
            if record is not None:
                self._processing_deliveries[(record.session_key, record.run_id)] = record
            await super().on_processing_start(event)

        def _deferred_by_startup_restore(self, event: Any) -> bool:
            """True while Hermes holds ``event`` in its startup-restore queue.

            Hermes 0.21.x queues inbound that lands before startup restore
            and turn-machinery warm-up finish (``_startup_restore_queue`` on
            the gateway runner), returns ``None`` from the message handler and
            so reports that processing pass as a success. The queue is drained
            by identity once the gate opens. A runner without that queue (older
            or newer Hermes) reads as not deferred, i.e. today's behavior.
            """
            runner = getattr(self, "gateway_runner", None)
            queue = getattr(runner, "_startup_restore_queue", None)
            if not isinstance(queue, list):
                return False
            return any(queued is event for queued in queue)

        def _delivery_is_cancelled(self) -> bool:
            record = self._delivery_record.get()
            return record is not None and record.delivery_cancelled

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
            if self._deferred_by_startup_restore(event):
                # Hermes parked this inbound until startup restore finishes and
                # will replay the SAME event object through handle_message.
                # The run has not started: keep its record active and in
                # flight so the replay's on_processing_start re-binds it and
                # the reply streams under this runId instead of ending now.
                logger.info(
                    "[ocuclaw] dispatch %s deferred by Hermes startup restore; "
                    "run stays open until the replay",
                    run_id,
                )
                return
            self._processing_deliveries.pop((session_key, run_id), None)
            self._completed_replies.forget(session_key, run_id)
            self._note_ocuclaw_reply_settled(session_key)
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
                    self._publish_phone_turn_candidate(session_key, run_id)
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
                self._publish_phone_turn_candidate(session_key, run_id)
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

        def _note_ocuclaw_reply_settled(self, session_key: str) -> None:
            """Stamp a phone-origin reply run reaching its terminal boundary."""

            if parse_ocuclaw_session_key(session_key) is None:
                return
            self._ocuclaw_reply_settled_at = time.monotonic()

        def _first_run_welcome_reply_pending(self) -> Optional[str]:
            """Name the in-flight reply the welcome must not paint over (#3231).

            The Attempt is armed on the phone's SDK receipt for a SLICE of the
            reply, so ``armed`` alone says nothing about the end of the run.
            Returns the reason to skip this welcome cycle, or None to deliver.
            """

            try:
                processing = list(self._processing_deliveries)
            except RuntimeError:  # pragma: no cover - mutated mid-iteration
                # A run is starting or ending in another thread right now,
                # which is itself the answer: something is still in flight.
                return "run_in_flight"
            for session_key, _run_id in processing:
                if parse_ocuclaw_session_key(session_key) is not None:
                    return "run_in_flight"
            with self._stream_tail_lock:
                tail_keys = list(self._stream_tail_closures)
            for session_key, _message_id in tail_keys:
                if parse_ocuclaw_session_key(session_key) is not None:
                    return "stream_tail_pending"
            settled_at = self._ocuclaw_reply_settled_at
            if (
                settled_at is not None
                and time.monotonic() - settled_at < STREAM_FINALIZE_GRACE_SECONDS
            ):
                return "finalize_grace"
            return None

        def _defer_welcome(self, reason: Optional[str]) -> Optional[Dict[str, Any]]:
            """Bookkeeping for one skipped welcome cycle, bounded (#3231).

            Returns this cycle's answer while the welcome should wait, or None
            once it should go regardless. Nothing is consumed by a skipped
            cycle: the Attempt stays armed and the 1 s watcher retries.
            """

            if reason is None:
                self._welcome_defer_since = None
                return None
            now = time.monotonic()
            if self._welcome_defer_since is None:
                self._welcome_defer_since = now
            if now - self._welcome_defer_since < FIRST_RUN_WELCOME_REPLY_WAIT_SECONDS:
                return {"state": "reply_pending", "reason": reason}
            # Bounded: a run whose terminal boundary never arrives must not
            # silence the welcome for the whole install.
            self._welcome_defer_since = None
            return None

        async def _deliver_armed_first_run_welcome(self) -> Dict[str, Any]:
            self._welcome_inspection_generation += 1
            generation = self._welcome_inspection_generation
            inspected_link = self._link
            # Hermes may serve __version__ through synchronous install-stamp
            # I/O. Evaluate the arguments on the worker too, not before it.
            attempt = await asyncio.to_thread(_inspect_first_run_welcome_attempt)
            if (
                generation != self._welcome_inspection_generation
                or inspected_link is not self._link
            ):
                # A newer inspection or reconnect owns the result now. The
                # abandoned worker only read files; it cannot render or write.
                return {"state": "inspection_superseded"}
            if attempt.get("state") != "armed":
                self._welcome_defer_since = None
                return {"state": str(attempt.get("state") or "missing")}
            deferred = self._defer_welcome(self._first_run_welcome_reply_pending())
            if deferred is not None:
                return deferred
            session_key = await asyncio.to_thread(
                self._resolve_armed_first_run_session
            )
            if session_key is None:
                return {"state": "session_unavailable"}
            # A queued or active run for this exact conversation. A mid-run
            # credential rotation (Hermes `credential_pool … rotating`, the
            # OpenClaw lane's `failoverPending`) ends one run and re-dispatches
            # the turn, which from here looks like a reply that finished. It
            # did not, so the welcome waits for the successor too.
            deferred = self._defer_welcome(
                "session_busy" if self._ledger.is_busy(session_key) else None
            )
            if deferred is not None:
                return deferred
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
                        # #3209: the gateway made this render, not an agent
                        # tool call, so the "wearer is in another chat"
                        # refusal must not apply to it.
                        "hostOriginated": True,
                        "args": welcome_surface(
                            cloudways=_welcome_host_is_cloudways()
                        ),
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
                # The phone's setup hint (#3010) rides the same first-run
                # watcher: same journey, same lifecycle, no second timer. It is
                # deliberately AFTER the welcome step and separately guarded, so
                # neither half of first use can silence the other.
                try:
                    await self._refresh_setup_hint()
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - keep the gateway watcher alive
                    logger.exception("[ocuclaw] setup hint watcher failed")
                await asyncio.sleep(FIRST_RUN_WELCOME_POLL_SECONDS)

        # -- W09 approvals + live-session control (ADR-0008) -----------------

        def _approval_timeout_seconds(self) -> int:
            try:
                approval = importlib.import_module("tools.approval")

                # Hermes 0.20 owns the effective default and operator override;
                # using its accessor also preserves the host's malformed-
                # config fallback instead of pinning either value here. From
                # 0.21.1 the accessor lives in tools.approval_context, and
                # tools.approval imports it only inside a function.
                timeout = approval_reader(approval, "_get_approval_timeout")()
                return max(0, int(timeout))
            except Exception:  # noqa: BLE001
                return 300

        def _public_key_for_native_session(self, session_key: str) -> Optional[str]:
            identity = parse_ocuclaw_session_key(session_key)
            if not identity:
                return None
            return f"hermes:{identity['ns']}:{identity['chatId']}"

        def _session_options_readback(
            self, native_key: str, default_fast: Optional[bool],
            default_model: Optional[str] = None, default_thinking: Optional[str] = None,
        ) -> Dict[str, Any]:
            """Live session thinking/fast for a session row (#3875).

            Without upstream apply_session_options the bridge sets these with
            /reasoning and /fast, which Hermes keeps as in-memory session
            overrides, never session DB columns. Unreported, every Model menu
            open rebuilt them as defaults. Read the overrides the same way the
            gateway resolves them (0.21.0-0.21.5 share this SessionState shape).
            A missing session state means no override: thinking stays the
            profile default, fast falls back to the profile's service tier.
            """
            out: Dict[str, Any] = {}
            if isinstance(default_model, str) and default_model.strip():
                provider, separator, model = default_model.strip().partition("/")
                if separator:
                    out.update(model=model, modelProvider=provider)
                else:
                    out["model"] = provider
            if isinstance(default_thinking, str) and default_thinking in OCUCLAW_THINKING_LEVELS:
                out["thinkingLevel"] = default_thinking
            runner = getattr(self, "gateway_runner", None)
            peek = getattr(runner, "_peek_session_state", None)
            conversation = None
            if callable(peek):
                try:
                    state = peek(native_key)
                    conversation = getattr(state, "conversation", None)
                except Exception:  # noqa: BLE001 - readback must never fail the list
                    conversation = None
            # /model changes the live conversation before the next model turn
            # updates SessionDB. Read only public route fields: the override
            # also contains credentials which must never enter a session row.
            model_override = getattr(conversation, "model_override", None)
            if isinstance(model_override, dict):
                model = model_override.get("model")
                provider = model_override.get("provider")
                if isinstance(model, str) and model.strip():
                    out["model"] = model.strip()
                    if isinstance(provider, str) and provider.strip():
                        out["modelProvider"] = provider.strip()
                    else:
                        out.pop("modelProvider", None)
                    # #7135: /fast is judged on the session's own model and
                    # route, so a /model pick answers for itself, not the
                    # profile default. Unknown stays absent.
                    try:
                        from hermes_cli.models import model_supports_fast_mode

                        supported = bool(model_supports_fast_mode(model.strip()))
                        if supported:
                            supported = fast_tier_reaches_route(
                                model.strip(), provider, model_override.get("base_url")
                            ) is not False
                        out["fastModeSupported"] = supported
                    except Exception:  # noqa: BLE001 - readback must never fail the list
                        pass
            reasoning = getattr(conversation, "reasoning_override", None)
            if isinstance(reasoning, dict):
                if reasoning.get("enabled", True) is False:
                    out["thinkingLevel"] = "off"
                else:
                    effort = str(reasoning.get("effort") or "").strip().lower()
                    if effort in OCUCLAW_THINKING_LEVELS:
                        out["thinkingLevel"] = effort
            missing = object()
            tier = getattr(conversation, "service_tier_override", missing)
            if tier == "priority" or tier is None:
                # "priority" or None both mark an explicit /fast override; the
                # unset sentinel is some other object and falls through.
                out["fastMode"] = tier == "priority"
            elif default_fast is not None:
                out["fastMode"] = default_fast
            return out

        async def handle_status_sessions_list(self, params: Any) -> Dict[str, Any]:
            result = await self._session_rpc.list_sessions(params)
            reasoning_by_namespace: Dict[str, Optional[str]] = {}
            default_fast_by_namespace: Dict[str, Optional[bool]] = {}
            fast_supported_by_namespace: Dict[str, Optional[bool]] = {}
            defaults_by_namespace: Dict[str, Dict[str, Any]] = {}
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
                        defaults_by_namespace[ns] = options
                        level = options.get("reasoningLevel")
                        reasoning_by_namespace[ns] = level if level in {"on", "off"} else None
                        default_fast = options.get("defaultFastMode")
                        default_fast_by_namespace[ns] = (
                            default_fast if isinstance(default_fast, bool) else None
                        )
                        supported = options.get("fastModeSupported")
                        fast_supported_by_namespace[ns] = (
                            supported if isinstance(supported, bool) else None
                        )
                    except Exception:
                        defaults_by_namespace[ns] = {}
                        reasoning_by_namespace[ns] = None
                        default_fast_by_namespace[ns] = None
                        fast_supported_by_namespace[ns] = None
                if reasoning_by_namespace[ns] is not None:
                    row["reasoningLevel"] = reasoning_by_namespace[ns]
                readback = self._session_options_readback(
                    native_key, default_fast_by_namespace[ns],
                    # A restored session can have a persisted /model route
                    # before the runner hydrates its live conversation. Keep
                    # that known DB model; defaults only fill an absent route.
                    (defaults_by_namespace[ns].get("defaultModel")
                     if not isinstance(row.get("model"), str) or not row["model"].strip()
                     else None),
                    defaults_by_namespace[ns].get("defaultThinking"),
                )
                row.update(readback)
                # A session's own /model pick answers for Fast itself (#7135);
                # the profile's answer covers every session on the default.
                if "fastModeSupported" not in readback and fast_supported_by_namespace[ns] is not None:
                    row["fastModeSupported"] = fast_supported_by_namespace[ns]
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
                                    "command": entry.get("shownCommand") or entry["command"] or entry["description"] or "approval required",
                                    "ask": entry["description"] or "approval required",
                                    "host": "hermes",
                                    "security": "high",
                                    "allowedDecisions": list(entry["allowedDecisions"]),
                                    **_approval_request_view_fields(entry),
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
                        run_id=(head.run_id if (head := self._ledger.head(native_key)) is not None
                                and head.kind == KIND_TURN else None),
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
            # #5152: a computer_use approval names the text a `type` call types.
            # Its card shows the screen and the target instead, and every copy
            # that leaves this process (the card, the session list, the
            # explainer) carries a command line without that text.
            view = self._bot_screen_approvals.view(session_key, command, description)
            shown_command = view[0] if view is not None else command
            native_request_id = str(data.get("request_id") or "")
            native_pending = (
                [] if native_request_id else self._native_pending_approvals(session_key)
            )
            with self._approval_lock:
                if not native_request_id:
                    native_request_id = self._claim_native_request_id_locked(
                        session_key, command, native_pending
                    )
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
                    # Hermes's own queue-entry id (approval_gateway_wait
                    # ``_ApprovalEntry``); the resolve targets it exactly.
                    "nativeRequestId": native_request_id,
                }
                if view is not None:
                    entry["shownCommand"] = shown_command
                    entry["botScreen"] = view[1]
                self._approvals_by_id[approval_id] = entry
                self._approval_order_by_session.setdefault(session_key, []).append(
                    approval_id
                )
            request: Dict[str, Any] = {
                "command": shown_command or description or "approval required",
                "host": "hermes",
                "agentId": identity.get("ns") or self._namespace,
                "security": "high",
                "ask": description or "approval required",
                "allowedDecisions": allowed_decisions,
                **_approval_request_view_fields(entry),
            }
            if public_key:
                request["sessionKey"] = public_key
            # Always take (it drains the store); use it only while "Explain
            # commands" is on, so an off setting sends no purpose or context.
            # A computer_use card gets no sentence: the explainer would see the
            # wearer's message and the agent's thinking about what it types.
            explain_context = _APPROVAL_CONTEXT.take(
                session_key, command, redact=_approval_command_redactor()
            )
            explain_on = _APPROVAL_EXPLAIN_SETTING.is_enabled() and view is None
            if explain_on and explain_context.purpose:
                request["purpose"] = explain_context.purpose
            event: Dict[str, Any] = {
                "id": approval_id,
                "requestId": request_id,
                "createdAtMs": created_ms,
                "expiresAtMs": expires_ms,
                "request": request,
            }
            # For the shared explainer (approval-explainer.ts); the Node
            # runtime reads it and never forwards it to clients.
            context_payload = explain_context.payload() if explain_on else None
            if context_payload:
                event["ocuclawApprovalContext"] = context_payload
            delivery = self._emit_event(
                "approval",
                event,
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

        @staticmethod
        def _native_pending_approvals(session_key: str) -> List[Dict[str, Any]]:
            # Hermes enqueues the entry before it notifies, so this prompt's
            # own entry is already listed here (approval_gateway_wait).
            try:
                return human_input_waiting.list_gateway_approvals(session_key)
            except Exception:  # noqa: BLE001 - no id means the FIFO-head resolve
                logger.debug("[ocuclaw] native approval list failed", exc_info=True)
                return []

        def _claim_native_request_id_locked(
            self,
            session_key: str,
            command: str,
            pending: List[Dict[str, Any]],
        ) -> str:
            """Hermes's entry id for the prompt being mirrored, only when it is
            unambiguous: ``send_exec_approval`` carries no id (#4983)."""
            claimed = {
                e.get("nativeRequestId")
                for e in self._approvals_by_id.values()
                if e.get("sessionKey") == session_key and e.get("nativeRequestId")
            }
            open_ids = [
                (str(p.get("request_id") or ""), str(p.get("command") or "").strip())
                for p in pending
                if isinstance(p, dict)
                and p.get("request_id")
                and str(p.get("request_id")) not in claimed
            ]
            if len(open_ids) == 1:
                return open_ids[0][0]
            # Several open: the command text decides, if exactly one matches
            # (it differs only when Hermes redacted a secret for display).
            same = [rid for rid, cmd in open_ids if cmd == command]
            return same[0] if len(same) == 1 else ""

        def _resolve_native_approval_entry(
            self,
            entry: Dict[str, Any],
            choice: str,
            reason: Optional[str] = None,
        ) -> int:
            # With Hermes's entry id (#4983) the resolve targets exactly this
            # prompt. Without one (or on a Hermes whose resolver takes no id)
            # Hermes resolves the session FIFO head, and its enqueue/notify is
            # not atomic, so concurrent same-session local order can diverge.
            # We still resolve only our locked local head; the #674 H2
            # post-flip two-concurrent-approvals test carries the ordering proof.
            from tools.approval import resolve_gateway_approval

            native_request_id = str(entry.get("nativeRequestId") or "")
            if native_request_id and human_input_waiting.resolver_takes_request_id(
                resolve_gateway_approval
            ):
                return resolve_gateway_approval(
                    entry["sessionKey"],
                    choice,
                    reason=reason,
                    request_id=native_request_id,
                )
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
            if self._delivery_is_cancelled():
                return None
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
            text = cls._assistant_reasoning_untruncated(assistant_message)
            if not text:
                return None
            if len(text) > THINKING_FRAME_MAX_CHARS:
                return cls._truncate_thinking_delta(text)
            return text

        @classmethod
        def _assistant_reasoning_untruncated(cls, assistant_message: Any) -> str:
            """One model call's whole reasoning, before the frame cap ("" when none)."""
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
            return "\n".join(parts).strip()

        @classmethod
        def _thinking_prose_candidates(cls, assistant_message: Any) -> Dict[str, str]:
            """Headline MATERIAL for a call whose reasoning has no headline.

            ``_derive_thinking_headline`` answers ``detail`` for plain prose and
            the status bar says "Thinking...". That rule stays exactly as it
            is; this only hands the Node runtime what it would need to do
            better, under keys an older runtime does not read:

            * ``thinkingProse``: the END of this call's reasoning (the newest
              thought is what the model is doing now), whitespace as written;
            * ``thinkingSummaryLong``: the first typed ``reasoning.summary``
              entry that was turned down ONLY for being multi-line or longer
              than the headline budget, from its start.
            """
            candidates: Dict[str, str] = {}
            prose = cls._assistant_reasoning_untruncated(assistant_message)
            if prose:
                candidates[THINKING_PROSE_KEY] = prose[-THINKING_PROSE_MAX_CHARS:]
            for entry in cls._reasoning_detail_entries(assistant_message):
                entry_type = str(entry.get("type") or "").strip().lower()
                if entry_type != REASONING_SUMMARY_DETAIL_TYPE:
                    continue
                raw = cls._reasoning_detail_text(entry)
                if raw and ("\n" in raw or len(raw) > THINKING_HEADLINE_MAX_CHARS):
                    candidates[THINKING_SUMMARY_LONG_KEY] = raw[
                        :THINKING_SUMMARY_LONG_MAX_CHARS
                    ].rstrip()
                    break
            return candidates

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

            Order: the LAST closed ``**bold**`` span in the reasoning text (the
            shape gpt-5.x style reasoning writes its own section headers in;
            the newest header is what the model is doing now, ADR-0007's
            last-closed-span rule), then a
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
            for bold_match in reversed(
                list(THINKING_BOLD_SPAN_RE.finditer(str(reasoning or "")))
            ):
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
                self._open_tool_progress_bubble_by_run.pop(key, None)
                self._stream_text_origin_by_run.pop(key, None)
                self._narration_origin_by_run.pop(key, None)
                self._thinking_epoch_by_run.pop(key, None)
                self._stream_appended_by_run.pop(key, None)
                self._stream_headlines_by_run.pop(key, None)
                self._model_call_seq_by_run.pop(key, None)
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
                if key in self._open_tool_progress_bubble_by_run:
                    # Hermes edits this tool's line into the open bubble.
                    return
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
                if not self._pending_tool_progress_by_run.pop(key, None):
                    # A content send: Hermes closes its progress bubble, so
                    # the next tool opens a new one.
                    self._open_tool_progress_bubble_by_run.pop(key, None)
                    return
                # One bubble carries every line queued before it was sent
                # (Hermes batches them), so this send settles every arm.
                self._tool_progress_message_ids_by_run.setdefault(key, set()).add(
                    resolved_id
                )
                self._open_tool_progress_bubble_by_run[key] = resolved_id

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
            if record.delivery_cancelled:
                return
            upgraded = self._narration_full_text_for_prefix(record.run_id, text)
            if upgraded is not None:
                # A note flushed mid-reveal: commit the sentence, not the
                # prefix that happened to be on the wire.
                text = upgraded
            if message_id is None:
                message_id = getattr(record, "current_message_id", None)
            self._note_committed_text(record.run_id, text, message_id)
            self._note_failed_turn_reply(record, text)
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
                new_call = previous is None
                headline = self._stream_headline_locked(
                    key, entry.get("iteration", 0), chunk, new_call=new_call
                )
                prose = None if headline else self._stream_prose_locked(key)
                if new_call:
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
            if headline:
                # Tier 1 rides the live stream too: the status bar names the
                # newest closed `**headline**` while the model is still
                # reasoning, instead of "Thinking..." until post_api_request.
                # The stream names its call only by the turn's counter; a
                # chunk queued behind the next pre_api_request still maps to
                # the call it was written in.
                self._emit_event(
                    "activity",
                    self._thinking_headline_activity(
                        run_id,
                        entry["sessionKey"],
                        "bold",
                        headline,
                        self._model_call_seq_of(
                            run_id, {"iteration": entry.get("iteration", 0)}
                        ),
                    ),
                )
            elif prose:
                # Plain-prose reasoning (Claude, most local models) closes no
                # headline, so the bar would say "Thinking..." for the whole
                # call. Each finished sentence goes out as headline MATERIAL,
                # on the same `detail` frame post_api_request sends at the end.
                activity = self._thinking_headline_activity(
                    run_id,
                    entry["sessionKey"],
                    "detail",
                    None,
                    self._model_call_seq_of(
                        run_id, {"iteration": entry.get("iteration", 0)}
                    ),
                )
                activity[THINKING_PROSE_KEY] = prose
                activity[THINKING_LIVE_KEY] = True
                self._emit_event("activity", activity)
            return True

        def _stream_prose_locked(self, key: str) -> Optional[str]:
            """This call's reasoning up to its newest FINISHED sentence, or None.

            Caller holds the lock. Answers once per finished sentence. A call
            that has written `**` has, or is about to have, a headline of its
            own, and offers nothing here.
            """
            state = self._stream_headlines_by_run.get(key)
            if state is None or state["ordinal"] or "**" in state["text"]:
                return None
            sent = state.get("proseEnd", 0)
            end = sent
            for match in STREAM_SENTENCE_END_RE.finditer(state["text"], max(0, sent - 1)):
                end = match.end()
            if end <= sent:
                return None
            state["proseEnd"] = end
            return state["text"][:end].strip()[-THINKING_PROSE_MAX_CHARS:] or None

        def _stream_headline_locked(
            self, key: str, iteration: int, chunk: str, *, new_call: bool
        ) -> Optional[str]:
            """The newest headline this chunk CLOSED, or None. Caller holds the lock.

            Scans only this model call's reasoning, from just after the last
            closed span, so a long stretch of reasoning is never re-scanned
            per chunk and a closed span is counted exactly once. The bar is
            keyed on (run, model call, span ordinal), never on the title text:
            two identical headlines in a row are two steps, and both show.
            """
            state = self._stream_headlines_by_run.get(key)
            if new_call or state is None or state["iteration"] != iteration:
                state = {
                    "iteration": iteration,
                    "text": "",
                    "scan": 0,
                    "ordinal": 0,
                    "emitted": None,
                    "headline": None,
                }
                self._stream_headlines_by_run[key] = state
            state["text"] += chunk
            newest: Optional[Tuple[int, str]] = None
            for match in THINKING_BOLD_SPAN_RE.finditer(state["text"], state["scan"]):
                state["scan"] = match.end()
                state["ordinal"] += 1
                headline = self._normalize_thinking_headline(match.group(1))
                if headline:
                    newest = (state["ordinal"], headline)
            if newest is None:
                return None
            emitted_key = (iteration, newest[0])
            if state["emitted"] == emitted_key:
                return None
            state["emitted"] = emitted_key
            state["headline"] = newest[1]
            return newest[1]

        def _take_streamed_headline(self, run_id: Any) -> Optional[str]:
            """The last headline the stream put on the bar for this call."""
            key = str(run_id or "").strip()
            with self._thinking_lock:
                state = self._stream_headlines_by_run.pop(key, None)
            return state.get("headline") if state else None

        # -- modelCallSeq (PROTOCOL.md activity) ----------------------------
        #
        # The glasses keep a reasoning headline on the bar through the tools
        # its own model call requested, and let a tool label take the bar
        # only once a NEW call has started. Each activity frame names its
        # call by a 1-based ordinal within the run; a frame this adapter
        # cannot place carries no ordinal at all, never a guess.

        def _begin_model_call_seq(
            self, run_id: Any, kwargs: Mapping[str, Any]
        ) -> Optional[int]:
            """pre_api_request: the ordinal of this attempt's logical call."""
            key = str(run_id or "").strip()
            request = model_call_request(kwargs)
            if not key or not request:
                return None
            iteration = model_call_iteration(kwargs)
            with self._thinking_lock:
                state = self._model_call_seq_by_run.get(key)
                if state is None:
                    state = {"requests": {}, "iterations": {}, "current": None}
                    self._model_call_seq_by_run[key] = state
                seq = state["requests"].get(request)
                if seq is None:
                    seq = len(state["requests"]) + 1
                    state["requests"][request] = seq
                if iteration is not None:
                    state["iterations"][iteration] = seq
                state["current"] = seq
            return seq

        def _model_call_seq_of(
            self, run_id: Any, kwargs: Mapping[str, Any]
        ) -> Optional[int]:
            """The ordinal of the call a call-scoped hook names, if one started."""
            key = str(run_id or "").strip()
            request = model_call_request(kwargs)
            iteration = model_call_iteration(kwargs)
            with self._thinking_lock:
                state = self._model_call_seq_by_run.get(key)
                if state is None:
                    return None
                if request and request in state["requests"]:
                    return state["requests"][request]
                if iteration is not None:
                    return state["iterations"].get(iteration)
                return None

        def _tool_model_call_seq(
            self, run_id: Any, tool_call_id: str, tool_phase: str
        ) -> Optional[int]:
            """The call that requested a tool: the call that started last in
            this run when the tool starts (the next call's pre_api_request
            comes after the tools), and the same ordinal again at its end."""
            key = str(run_id or "").strip()
            with self._thinking_lock:
                state = self._model_call_seq_by_run.get(key)
                if state is None:
                    return None
                current = state.get("current")
                if not tool_call_id:
                    return current
                tools = state.setdefault("tools", {})
                if tool_phase == "start":
                    if current is not None:
                        tools[tool_call_id] = current
                    return current
                return tools.pop(tool_call_id, current)

        @staticmethod
        def _stamp_model_call_seq(payload: Dict[str, Any], seq: Optional[int]) -> None:
            if isinstance(seq, int) and not isinstance(seq, bool) and seq > 0:
                payload["modelCallSeq"] = seq

        def _thinking_headline_activity(
            self,
            run_id: Any,
            session_key: Any,
            source: str,
            headline: Optional[str],
            model_call_seq: Optional[int] = None,
        ) -> Dict[str, Any]:
            """The status-bar frame for one reasoning headline (or none)."""
            activity: Dict[str, Any] = {
                "state": "thinking",
                "origin": "thinking",
                "category": "thinking",
                "phase": "update",
                "runId": run_id,
                "sessionKey": session_key,
                "thinkingSummarySource": source,
            }
            if headline:
                activity["summary"] = headline
            self._stamp_model_call_seq(activity, model_call_seq)
            return activity

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
            # NO status-bar frame from this hook. #1619 retired
            # `agentProgressNotes: status`: with a real model the interim is
            # committed AFTER the tool activity frame, so the narration rung
            # lost arbitration every time and `status` was indistinguishable
            # from `off` (zero `origin:"narration"` frames across 12
            # real-model dumps). This hook's only remaining jobs are tagging
            # the sentence and correcting a commit that beat it; the runtime
            # shows a tagged note as a work-panel row and drops its
            # conversation page. The sentence's status-bar frame is sent from
            # `post_api_request` (`_pre_tool_narration_activity`), which is
            # ahead of the tools.

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

        # -- H11 (#3348): the non-retryable provider-error mark --------------
        #
        # Scoped to (session_key, run_id) so it can only ever close the run it
        # was made for. A rerun of the same session mints a new run id and
        # starts clean, and a clean post_api_request for the same run drops it.

        def _mark_provider_error(
            self, session_key: str, run_id: str, code: str
        ) -> None:
            session_key = str(session_key or "").strip()
            run_id = str(run_id or "").strip()
            if not session_key or not run_id or not code:
                return
            with self._provider_error_marks_lock:
                self._provider_error_marks[(session_key, run_id)] = code

        def _take_provider_error_mark(
            self, session_key: str, run_id: str
        ) -> Optional[str]:
            session_key = str(session_key or "").strip()
            run_id = str(run_id or "").strip()
            if not session_key or not run_id:
                return None
            with self._provider_error_marks_lock:
                return self._provider_error_marks.pop((session_key, run_id), None)

        def _clear_provider_error_mark(self, session_key: str, run_id: str) -> None:
            self._take_provider_error_mark(session_key, run_id)

        def _note_failed_turn_reply(self, record: Any, text: str) -> None:
            """Remember a phone turn whose committed reply is Hermes's own
            failed-turn apology, for its candidate. Never raises: this is
            evidence for setup, never a step in the turn."""
            try:
                session_key = str(getattr(record, "session_key", "") or "")
                run_id = str(getattr(record, "run_id", "") or "")
                if (
                    not session_key
                    or not run_id
                    or getattr(record, "kind", None) != KIND_TURN
                    or parse_ocuclaw_session_key(session_key) is None
                    or not is_failed_turn_reply(text)
                ):
                    return
                with self._provider_error_marks_lock:
                    marks = self._failed_turn_reply_runs
                    marks[(session_key, run_id)] = True
                    while len(marks) > FAILED_TURN_REPLY_MARKS_MAX:
                        del marks[next(iter(marks))]
            except Exception:  # noqa: BLE001 - never break the commit
                logger.debug("[ocuclaw] failed-turn reply check failed", exc_info=True)

        def _take_failed_turn_reply(self, session_key: str, run_id: str) -> bool:
            with self._provider_error_marks_lock:
                return bool(
                    self._failed_turn_reply_runs.pop((session_key, run_id), False)
                )

        @staticmethod
        def _api_request_error_is_terminal(kwargs: Dict[str, Any]) -> bool:
            """Only a failure the engine will NOT retry ends a turn.

            `retryable` is the engine's own verdict and the only honest one:
            a 429 it intends to retry is mid-turn noise, and marking it would
            refuse a setup that is about to succeed on the next attempt.

            Hermes 0.23.1 still says `retryable: True` for a 429 or a 5xx on
            the LAST attempt and then gives up (2026-11-12, Codex usage limit
            on a pet: three attempts, all retryable, no mark, so the wearer got
            no notice). The last attempt is the one where `retry_count + 1`
            reaches `max_retries`, the rule `run_signals._retry_wait` uses for
            "no wait follows". A fallback model that then answers retires the
            mark (`handle_post_api_request`).
            """
            if kwargs.get("retryable") is False:
                return True
            retry_count = kwargs.get("retry_count")
            max_retries = kwargs.get("max_retries")
            if (
                isinstance(retry_count, bool)
                or isinstance(max_retries, bool)
                or not isinstance(retry_count, int)
                or not isinstance(max_retries, int)
                or retry_count < 0
                or max_retries < 1
            ):
                return False
            return retry_count + 1 >= max_retries

        def handle_api_request_error(self, kwargs: Dict[str, Any]) -> None:
            # Every failed attempt ends its model_call span, retried or not,
            # and a retried one may open the retry wait. A span this adapter
            # never opened (a foreign platform, a turn-less call) ends nothing.
            self._emit_run_signals(self._run_signals.model_call_failed(kwargs))
            if not self._api_request_error_is_terminal(kwargs):
                return
            status_code = self._api_request_status_code(kwargs)
            reason = str(kwargs.get("reason") or "").strip().lower()
            if not ((status_code is not None and status_code >= 400)
                    or reason in {"auth", "billing", "rate_limit"}):
                # Anything else is not evidence the provider refused the call.
                return
            context = self._turn_activity_context(kwargs, "api_request_error hook")
            if context is None:
                return
            session_key, record = context
            code = self._api_request_error_code(kwargs)
            if reason == "rate_limit" and code != "provider_quota_exhausted":
                # Retries are exhausted by construction: this handler only runs
                # when the engine itself said the call will not be retried.
                code = "provider_rate_limited"
            elif reason == "auth" or status_code == 401:
                # #3392. Engine's own classification, kept: a rejected sign-in
                # has a different fix from a model that failed, and collapsing
                # it into `provider_error` lost that before the verdict ran.
                code = "provider_auth_invalid"
            elif reason == "billing":
                code = "provider_quota_exhausted"
            elif status_code == 400 and code != "provider_quota_exhausted":
                # The provider refused the request itself (the Codex backend's
                # bare `{"detail":"Bad Request"}`). The OpenClaw lane names it
                # the same way (`format` -> provider_request_invalid), so the
                # glasses say the request was refused on either host.
                code = "provider_request_invalid"
            elif not code:
                code = "provider_error"
            self._mark_provider_error(session_key, record.run_id, code)
            marked = self._ledger.mark_error_terminal(
                session_key,
                code=code,
                stale_after_seconds=ERROR_TERMINAL_STALE_TURN_SECONDS,
            )
            if marked is not None:
                self._schedule_error_terminal_sweep(ERROR_TERMINAL_STALE_TURN_SECONDS)

        # -- Run signals (`runSignal`, PROTOCOL.md) ---------------------------
        #
        # A start routes like tool activity (`_turn_activity_context`): only
        # an OcuClaw turn in flight opens a span. An end looks up the span its
        # start opened, so it needs no routing and cannot end a span twice.

        def _emit_run_signals(self, frames: List[Dict[str, Any]]) -> None:
            for frame in frames:
                self._emit_event(RUN_SIGNAL_EVENT, frame)

        def _runless_turn_session(self, kwargs: Dict[str, Any]) -> Optional[str]:
            """The OcuClaw session key of a turn Hermes started with no run.

            Hermes injects a delegate_task completion (or a watch or process
            notice) straight into the chat, so the dispatch ledger holds no
            run for it. Only for card picture routing; never for activity.
            """
            platform = str(kwargs.get("platform") or "").strip()
            if platform and platform != PLATFORM_NAME:
                return None
            if self._background_hook_turn(kwargs):
                return None
            session_id = str(kwargs.get("session_id") or "").strip()
            if not session_id or not str(kwargs.get("turn_id") or "").strip():
                return None
            try:
                row = self._session_rpc.row_by_id(session_id)
            except Exception:  # noqa: BLE001
                return None
            session_key = str((row or {}).get("session_key") or "")
            if parse_ocuclaw_session_key(session_key) is None:
                return None
            if self._ledger.head(session_key) is not None:
                return None
            return session_key

        def handle_pre_api_request(self, kwargs: Dict[str, Any]) -> None:
            context = self._turn_activity_context(kwargs, "pre_api_request hook")
            if context is None:
                session_key = self._runless_turn_session(kwargs)
                if session_key:
                    self._card_image_models.observe_turn(
                        session_key,
                        str(kwargs.get("turn_id") or "").strip(),
                        kwargs.get("provider"),
                        kwargs.get("model"),
                    )
                return
            _session_key, record = context
            self._begin_model_call_seq(record.run_id, kwargs)
            self._card_image_models.observe(
                _session_key, record.run_id, kwargs.get("provider"), kwargs.get("model")
            )
            self._emit_run_signals(
                self._run_signals.model_call_start(
                    kwargs, session_key=record.public_key, run_id=record.run_id
                )
            )

        def handle_auxiliary_call_start(self, kwargs: Dict[str, Any]) -> None:
            # Every auxiliary attempt on the gateway lands here (titling,
            # vision, MoA, ...). Only the compressor's is a compaction, and a
            # turn-less one (no parent turn, so no session_id) has no run.
            if kwargs.get("aux_task") != COMPACTION_AUX_TASK:
                return
            if not str(kwargs.get("session_id") or "").strip():
                return
            context = self._turn_activity_context(kwargs, "pre_auxiliary_call hook")
            if context is None:
                return
            _session_key, record = context
            self._emit_run_signals(
                self._run_signals.compaction_start(
                    kwargs, session_key=record.public_key, run_id=record.run_id
                )
            )

        def handle_auxiliary_call_end(self, kwargs: Dict[str, Any]) -> None:
            if kwargs.get("aux_task") != COMPACTION_AUX_TASK:
                return
            self._emit_run_signals(self._run_signals.compaction_end(kwargs))

        # -- committed compactions (hermes post_compaction, 0.22.3+) ---------
        #
        # The hook runs inside Hermes' commit window with the session's lease
        # held, so it only starts a worker. The worker keeps the hook's
        # context: Hermes fires it in the compacted session's profile scope,
        # which is the store the row read must use.

        def handle_post_compaction(self, event: Dict[str, Any]) -> None:
            context = copy_context()
            threading.Thread(
                target=context.run,
                args=(self._publish_compaction, event),
                name="ocuclaw-compaction",
                daemon=True,
            ).start()

        def _publish_compaction(self, event: Dict[str, Any]) -> None:
            """Note the session's message count on the ledger event, then tell
            the relay about an OcuClaw chat's compaction (`sessionCompacted`).

            Every kind goes out: a trim drops surface ids from what the model
            sees just as a summary does (K17). Only ``counted`` ones add to
            the total.
            """
            session_id = event["sessionId"]
            try:
                row = self._session_rpc.row_by_id(session_id)
            except Exception as exc:  # noqa: BLE001 - an unserved profile is not ours
                logger.debug(
                    "[ocuclaw] post_compaction row lookup failed for %s: %s",
                    session_id,
                    exc,
                )
                return
            if not row:
                return
            ledger = compaction_ledger.ledger_for_home(event.get("home"))
            if ledger is not None:
                ledger.note_message_count(
                    session_id, event["atMs"], row.get("message_count")
                )
            public_key = self._public_key_for_native_session(
                str(row.get("session_key") or "")
            )
            if not public_key:
                return
            self._emit_event(
                SESSION_COMPACTED_EVENT_NAME,
                {
                    "sessionKey": public_key,
                    "sessionId": session_id,
                    "kind": event["kind"],
                    "reason": event["reason"],
                    "inPlace": event["inPlace"],
                    "counted": event["counted"],
                    "beforeTokens": event["beforeTokens"],
                    "afterTokens": event["afterTokens"],
                },
            )

        def _emit_background_delegation(self, background: Dict[str, Any]) -> None:
            """#6794: a background delegate_task child's finished route.

            A closing tool frame (``toolPhase:"end"``) of the dispatching call,
            in the dispatching run, whose ``delegation`` says ``background``:
            the results reach the chat as a turn with no OcuClaw run, so the app
            credits the chat's next reply. A call that ran inline never gets
            here (its result entries carried the routes).
            """
            run = background.get("run") or {}
            run_id = str(run.get("runId") or "").strip()
            if not run_id:
                return
            tool_call_id = str(run.get("toolCallId") or "").strip() or f"delegation:{run_id}"
            self._emit_event(
                "activity",
                {
                    "state": "thinking",
                    "origin": "tool",
                    "phase": "update",
                    "toolPhase": "end",
                    "tool": DELEGATE_TOOL_NAME,
                    "runId": run_id,
                    "sessionKey": run.get("sessionKey"),
                    "activityId": tool_call_id,
                    "toolCallId": tool_call_id,
                    "delegation": background["delegation"],
                },
            )

        def handle_subagent_start(self, kwargs: Dict[str, Any]) -> None:
            # The span belongs to the PARENT's run: route on the parent's
            # session and turn, which also drops a background-review fork's
            # delegation. subagent_start carries no platform; the session row
            # decides.
            parent = str(kwargs.get("parent_session_id") or "").strip()
            if not parent:
                return
            self._background_delegations.note_child(
                parent, kwargs.get("child_session_id"), kwargs.get("child_goal")
            )
            context = self._turn_activity_context(
                {
                    "session_id": parent,
                    "turn_id": str(kwargs.get("parent_turn_id") or "").strip(),
                },
                "subagent_start hook",
            )
            if context is None:
                return
            _session_key, record = context
            self._emit_run_signals(
                self._run_signals.subagent_start(
                    kwargs, session_key=record.public_key, run_id=record.run_id
                )
            )

        def handle_subagent_stop(self, kwargs: Dict[str, Any]) -> None:
            background = self._background_delegations.child_done(
                kwargs.get("child_session_id"), kwargs.get("child_status"), kwargs.get("duration_ms")
            )
            self._emit_run_signals(self._run_signals.subagent_end(kwargs))
            if background is not None:
                self._emit_background_delegation(background)

        def handle_post_llm_call(self, kwargs: Dict[str, Any]) -> None:
            if str(kwargs.get("platform") or "") != PLATFORM_NAME:
                return
            # The worker inherits this exact dispatch record. A route lookup
            # alone could accidentally attach a late hook to its successor.
            delivery = self._delivery_record.get()
            if delivery is None or delivery.kind != KIND_TURN or delivery.inline_reply:
                return
            context = self._turn_activity_context(kwargs, "post_llm_call hook")
            if context is None:
                return
            session_key, record = context
            if delivery is not record or delivery.session_key != session_key:
                return
            self._completed_replies.observe(record, kwargs)

        def _project_completed_reply(self, session_key: str, text: str, metadata: Any) -> str:
            record = self._delivery_record.get()
            if (
                record is None or record.session_key != session_key
                or record.kind != KIND_TURN or record.inline_reply
                or self._send_is_interim_commentary(metadata)
            ):
                return text
            return self._completed_replies.project(record, text)

        def handle_post_api_request(self, kwargs: Dict[str, Any]) -> None:
            error_code = self._api_request_error_code(kwargs)
            # The model_call span ends first: before routing, and before the
            # reasoning-only early return below. Hermes fires this hook only
            # for a response that passed its response check, and the tracker
            # hands a span out once, so api_request_error never ends it again.
            self._emit_run_signals(
                self._run_signals.model_call_end(
                    kwargs, "error" if error_code else "completed"
                )
            )
            context = self._turn_activity_context(kwargs, "post_api_request hook")
            if context is None:
                return
            session_key, record = context
            if not error_code:
                # A clean model call for this exact run retires any mark an
                # earlier, retried attempt left behind (H11, #3348).
                self._clear_provider_error_mark(session_key, record.run_id)
            if error_code:
                marked = self._ledger.mark_error_terminal(
                    session_key,
                    code=error_code,
                    stale_after_seconds=ERROR_TERMINAL_STALE_TURN_SECONDS,
                )
                if marked is not None:
                    self._schedule_error_terminal_sweep(ERROR_TERMINAL_STALE_TURN_SECONDS)
            assistant_message = kwargs.get("assistant_message")
            # The sentence the model wrote before this call's tools. Built
            # now, sent LAST: it was written after the reasoning below, and
            # either way it leaves this handler before the first of those
            # tools reaches `pre_tool_call`.
            narration = self._pre_tool_narration_activity(kwargs, record)
            reasoning = self._extract_assistant_reasoning(assistant_message)
            if not reasoning:
                if narration is not None:
                    self._emit_event("activity", narration)
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
            # What the live stream already put on the bar for THIS model call
            # (the flush above included). Taken, not read: the next call
            # starts with nothing streamed.
            streamed_headline = self._take_streamed_headline(record.run_id)
            text = self._reconcile_thinking_text(record.run_id, reasoning)
            # FRAME SPLIT (plan D1). The status-bar frame carries a HEADLINE or
            # nothing at all: when the source is `detail` it must carry neither
            # `summary` nor any THINKING_DETAIL_KEYS member, because the Node
            # resolver honours an explicit source and would otherwise select
            # the whole reasoning blob verbatim and paint a 120-char prose slab
            # at summary rank. With no key at all the resolver falls through to
            # the generic "Thinking..." label. The BODY rides the thinking
            # frame exclusively.
            activity = self._thinking_headline_activity(
                record.run_id,
                record.public_key,
                source,
                headline,
                self._model_call_seq_of(record.run_id, kwargs),
            )
            if source == "detail":
                # No headline, so the bar says "Thinking...". The frame also
                # carries what a newer Node runtime can cut a headline from
                # (`thinkingProse`, `thinkingSummaryLong`). Neither key is one
                # an older resolver reads, so the frame-split rule above holds.
                try:
                    activity.update(self._thinking_prose_candidates(assistant_message))
                except Exception:  # noqa: BLE001 - extra material, never the frame
                    logger.debug(
                        "[ocuclaw] thinking prose candidates failed", exc_info=True
                    )
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
            if not (headline and headline == streamed_headline):
                # The stream already showed this exact headline for this call;
                # repeating it would only re-stamp the bar. The pane reconcile
                # below is unaffected.
                self._emit_event("activity", activity)
            self._emit_event("thinking", thinking)
            # If the pane was live for this call, close it: what comes next
            # is the answer, not more reasoning. No-op when on_stream_end
            # already closed it, and when nothing streamed at all.
            self._finalize_thinking_pane(record.run_id, record.public_key)
            if narration is not None:
                self._emit_event("activity", narration)

        def _pre_tool_narration_activity(
            self, kwargs: Dict[str, Any], record: Any
        ) -> Optional[Dict[str, Any]]:
            """The status-bar frame for the sentence written before a call's tools.

            A model call that returns visible ``content`` together with tool
            calls has said what it is about to do ("Checking the logs
            first."). Hermes delivers that sentence as an interim message, but
            lazily: with a real model it is committed after the tool's own
            activity frame (#1619). ``post_api_request`` carries the same
            ``content`` inline and Hermes waits for this hook before it runs
            the call's tools (agent/turn_response_intake.py fires it, then
            agent/turn_tool_round.py executes them), so a frame sent from here
            is ahead of every ``pre_tool_call`` of the same model call.

            The text goes out whitespace-collapsed and capped, nothing more:
            the Node runtime owns shortening, ranking and whether the wearer
            sees it at all. None when the call asked for no tool, wrote
            nothing, or put inline reasoning markup in its content.
            """
            try:
                assistant_message = kwargs.get("assistant_message")
                tool_calls = self._read_reasoning_field(assistant_message, "tool_calls")
                if not isinstance(tool_calls, (list, tuple)) or not tool_calls:
                    return None
                content = message_text(
                    self._read_reasoning_field(assistant_message, "content")
                )
                if PRE_TOOL_NARRATION_THINK_TAG_RE.search(content):
                    return None
                summary = " ".join(content.split())[:PRE_TOOL_NARRATION_MAX_CHARS].rstrip()
                # "(empty)" is Hermes' own placeholder for a message with no
                # text; its interim delivery skips it the same way.
                if not summary or summary == "(empty)":
                    # Codex sign-in route: the same sentence is a
                    # commentary-phase message item, which Hermes folds into
                    # the reasoning field and leaves `content` empty.
                    commentary = self._codex_commentary_text(assistant_message)
                    summary = " ".join(commentary.split())[
                        :PRE_TOOL_NARRATION_MAX_CHARS
                    ].rstrip()
                if not summary or summary == "(empty)":
                    return None
                activity: Dict[str, Any] = {
                    "state": "thinking",
                    "origin": "narration",
                    "category": "narration",
                    "phase": "update",
                    "summary": summary,
                    "runId": record.run_id,
                    "sessionKey": record.public_key,
                }
                turn_id = str(kwargs.get("turn_id") or "").strip()
                if turn_id:
                    activity["turnId"] = turn_id
                self._stamp_model_call_seq(
                    activity, self._model_call_seq_of(record.run_id, kwargs)
                )
                return activity
            except Exception:  # noqa: BLE001 - extra material, never the turn
                logger.debug("[ocuclaw] pre-tool narration failed", exc_info=True)
                return None

        def _codex_commentary_text(self, assistant_message: Any) -> str:
            """The commentary a Codex model call wrote beside its tools, or "".

            The Responses API returns it as a message item with
            ``phase: "commentary"`` (the answer is ``final_answer``). Hermes
            keeps the raw items on the message as ``codex_message_items``.
            """
            items = self._read_reasoning_field(assistant_message, "codex_message_items")
            if not isinstance(items, (list, tuple)):
                return ""
            parts: List[str] = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                if item.get("type") != "message" or item.get("phase") != "commentary":
                    continue
                blocks = item.get("content")
                if not isinstance(blocks, (list, tuple)):
                    continue
                for block in blocks:
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "output_text"
                        and isinstance(block.get("text"), str)
                    ):
                        parts.append(block["text"])
            return " ".join(parts)

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
            # The call that requested this tool: tools run after it ends and
            # before the next call's pre_api_request. Start and end of one
            # tool, and its plan snapshot, share it.
            self._stamp_model_call_seq(
                payload,
                self._tool_model_call_seq(record.run_id, tool_call_id, tool_phase),
            )
            return payload

        @staticmethod
        def _tool_start_purpose(kwargs: Dict[str, Any]) -> str:
            """The model's own words for why it runs this call, or "".

            While "Explain commands" is on, the model writes a `purpose` on
            every `terminal` call (approval_explain.py); the request
            middleware strips it before any hook sees the arguments and keeps
            it by tool call id. An approval card takes it from there; most
            commands need no approval, and for those the tool's start frame is
            the only place the sentence can go. This is a read, not a take:
            the card still gets it.

            Same rule as the card: nothing while the setting is off. The text
            is the store's one cleaned line, with URL credentials redacted
            like every other string on the activity lane, capped again.
            """
            try:
                if not _APPROVAL_EXPLAIN_SETTING.is_enabled():
                    return ""
                tool_call_id = str(kwargs.get("tool_call_id") or "").strip()
                purpose = _APPROVAL_CONTEXT.peek_purpose(tool_call_id)
                if not purpose:
                    return ""
                return clean_line(redact_urls_in_text(purpose), PURPOSE_MAX_CHARS)
            except Exception:  # noqa: BLE001 - extra material, never the frame
                logger.debug("[ocuclaw] tool purpose read failed", exc_info=True)
                return ""

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

        def even_ai_clarify_block(
            self, kwargs: Dict[str, Any]
        ) -> Optional[Dict[str, str]]:
            """Veto clarify on an Even AI turn.

            A turn is Even AI when it was dispatched with promptOwner
            "even-ai", or when pre_llm_call saw liveui.prompt report the
            Even AI ownership ticket (a turn with no Even AI system prompt
            carries no rider). The dispatch ledger head is the turn the session is running now,
            so an OcuClaw turn in the same session keeps clarify. Background
            review forks share the session id but not the turn; they are not
            Even AI turns and are left alone.
            """
            if str(kwargs.get("tool_name") or "").strip() != EVEN_AI_CLARIFY_TOOL_NAME:
                return None
            platform = str(kwargs.get("platform") or "").strip()
            if platform and platform != PLATFORM_NAME:
                return None
            if self._background_hook_turn(kwargs):
                return None
            session_id = str(kwargs.get("session_id") or "").strip()
            if not session_id:
                return None
            row = self._session_rpc.row_by_id(session_id)
            session_key = str((row or {}).get("session_key") or "")
            if not session_key:
                return None
            record = self._ledger.head(session_key)
            if record is None or not (
                record.prompt_owner == EVEN_AI_PROMPT_OWNER or record.even_ai_turn
            ):
                return None
            logger.info(
                "[ocuclaw] clarify blocked on Even AI turn %s (%s)",
                record.run_id,
                session_key,
            )
            return {"action": "block", "message": EVEN_AI_CLARIFY_BLOCK_MESSAGE}

        def _bot_screen_tool_call(self, kwargs: Dict[str, Any], *, before: bool) -> None:
            """#5147: aim the Bot Screen's Follow view at the bot's next pointer
            action; #5148: say what that step does, for the view's caption;
            #5151: say when a turn starts using the screen, for the glasses'
            Peek. For any platform: the screen shows whoever drives it. A
            failure here never costs the tool its activity, and one lane never
            costs the other."""
            if not before:
                try:
                    self._bot_screen_targets.observe(kwargs)
                except Exception:  # noqa: BLE001 — a hint, never part of the tool's activity
                    logger.debug("[ocuclaw] bot screen capture read failed", exc_info=True)
                try:
                    # #5155: the capture's element boxes and labels, for the glasses' head pointer.
                    payload = self._bot_screen_targets.elements(kwargs)
                    if payload is not None:
                        self._emit_event(bot_screen.ELEMENTS_EVENT, payload)
                except Exception:  # noqa: BLE001 — a hint, never part of the tool's activity
                    logger.debug("[ocuclaw] bot screen elements failed", exc_info=True)
                return
            try:
                # A background review fork shares the session but is not its turn.
                if not self._background_hook_turn(kwargs):
                    run = self._bot_screen_turns.tool_call(kwargs, _current_hermes_session_key())
                    if run is not None:
                        self._emit_event(bot_screen.RUN_EVENT, run)
            except Exception:  # noqa: BLE001 — a hint, never part of the tool's activity
                logger.debug("[ocuclaw] bot screen run failed", exc_info=True)
            payloads: Dict[str, Any] = {}
            for name, method in ((bot_screen.TARGET_EVENT, "target"), (bot_screen.STEP_EVENT, "step")):
                try:
                    payload = getattr(self._bot_screen_targets, method)(kwargs)
                    payloads[method] = payload
                    if payload is not None:
                        self._emit_event(name, payload)
                except Exception:  # noqa: BLE001 — a hint, never part of the tool's activity
                    logger.debug("[ocuclaw] bot screen %s failed", method, exc_info=True)
            # #5152: Hermes may gate this call behind an approval; its card shows
            # the step's target. Only OcuClaw sessions get our approval cards.
            if payloads.get("step") is None:
                return
            try:
                session_id = str(kwargs.get("session_id") or "").strip()
                row = self._session_rpc.row_by_id(session_id) if session_id else None
                session_key = str((row or {}).get("session_key") or "")
                if parse_ocuclaw_session_key(session_key) is not None:
                    self._bot_screen_approvals.remember(session_key, payloads["step"], payloads.get("target"))
            except Exception:  # noqa: BLE001 — a hint, never part of the tool's activity
                logger.debug("[ocuclaw] bot screen approval facts failed", exc_info=True)

        def handle_pre_tool_call(self, kwargs: Dict[str, Any]) -> None:
            self._inflight_touch(kwargs)
            self._bot_screen_tool_call(kwargs, before=True)
            context = self._tool_activity_context(kwargs)
            if context is None:
                if str(kwargs.get("tool_name") or "").strip() in CARD_IMAGE_TOOLS:
                    session_key = self._runless_turn_session(kwargs)
                    if session_key:
                        self._card_image_models.note_tool_turn(
                            session_key, str(kwargs.get("turn_id") or "").strip()
                        )
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
                if tool_name == bot_screen.TOOL_NAME:
                    # #5148: what the bot types or sets on its screen never reaches
                    # the phone's activity lane or its traces, whatever the allow list.
                    for key in payload["args"]:
                        if key.strip().lower() in TOOL_ACTIVITY_COMPUTER_USE_MASKED_ARG_KEYS:
                            payload["args"][key] = "[omitted]"
                if tool_name.startswith("kanban_"):
                    # #3769: the board slug names where "Filing a card on <board>"
                    # lands. Only a well-formed slug passes; titles and bodies never.
                    board = args.get("board")
                    if isinstance(board, str) and TOOL_ACTIVITY_KANBAN_BOARD_SLUG.match(board):
                        payload["args"]["board"] = board
                if tool_name == SEARCH_FILES_TOOL_NAME:
                    # What is being searched for. Hermes names it `pattern`,
                    # which the allow list omits; the label reads `query`.
                    # Redacted and capped like every other argument string.
                    pattern = args.get(SEARCH_FILES_PATTERN_ARG)
                    if (
                        isinstance(pattern, str)
                        and pattern.strip()
                        and "query" not in payload["args"]
                    ):
                        payload["args"]["query"] = self._sanitize_tool_activity_text(
                            pattern
                        )
                        if (
                            self._tool_activity_args_json_bytes(payload["args"])
                            > TOOL_ACTIVITY_MAX_ARGS_JSON_BYTES
                        ):
                            payload["args"].pop("query", None)
            purpose = self._tool_start_purpose(kwargs)
            if purpose:
                payload["purpose"] = purpose
            if tool_name == DELEGATE_TOOL_NAME:
                # #6794: who each task goes to, from the backend's own task
                # parameter (agent, profile or option). Only route names pass;
                # goals and context never do.
                delegation = delegation_from_args(args)
                if delegation is not None:
                    payload["delegation"] = delegation
                self._background_delegations.note_call(
                    kwargs.get("session_id"),
                    args,
                    {
                        "runId": record.run_id,
                        "sessionKey": record.public_key,
                        "toolCallId": str(kwargs.get("tool_call_id") or "").strip(),
                    },
                )
            self._emit_event("activity", payload)

        def handle_post_tool_call(self, kwargs: Dict[str, Any]) -> None:
            self._inflight_touch(kwargs)
            self._bot_screen_tool_call(kwargs, before=False)
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
            if not is_error and status in {"", "ok", "success"} and tool_name in PLAN_TOOL_NAMES:
                plan = self._plan_snapshot_for_post_tool_call(kwargs)
                if plan is not None:
                    payload["plan"] = plan
            if tool_name == DELEGATE_TOOL_NAME:
                # #6794: each routed task's route, model and time, from the
                # result entries' `route` (Hermes 0.22.5+).
                delegation = delegation_from_result(kwargs.get("result"))
                if delegation is not None:
                    payload["delegation"] = delegation
                background = self._background_delegations.note_result(
                    kwargs.get("session_id"), kwargs.get("result")
                )
            else:
                background = None
            self._emit_event("activity", payload)
            if background is not None:
                self._emit_background_delegation(background)

        def _plan_snapshot_for_post_tool_call(
            self, kwargs: Dict[str, Any]
        ) -> Optional[Dict[str, Any]]:
            """The wire plan for a todo_list result, or None to send nothing.

            Mirrors Hermes' own `_normalize_todo_state`: an empty list at
            revision 0 is an unused store (ignored); empty at revision >= 1 is
            a real clear. Revisions only move forward per Hermes session id.
            """
            parsed = self._parse_plan_result(kwargs.get("result"))
            if parsed is None:
                return None
            revision, raw_items = parsed
            if not raw_items and revision == 0:
                return None
            session_id = str(kwargs.get("session_id") or "").strip()
            with self._thinking_lock:
                previous = self._plan_revisions.get(session_id)
                if previous is not None and revision < previous:
                    return None
                self._plan_revisions.pop(session_id, None)
                self._plan_revisions[session_id] = revision
                while len(self._plan_revisions) > PLAN_REVISION_CACHE_MAX:
                    self._plan_revisions.pop(next(iter(self._plan_revisions)))
            if not raw_items:
                return {"revision": revision, "cleared": True}
            items = [self._normalize_plan_item(item) for item in raw_items]
            summary = {"total": len(items)}
            for plan_status in PLAN_STATUSES:
                summary[plan_status] = sum(1 for item in items if item["status"] == plan_status)
            plan: Dict[str, Any] = {
                "revision": revision,
                "items": items[:PLAN_MAX_ITEMS],
                "summary": summary,
            }
            if len(items) > PLAN_MAX_ITEMS:
                plan["truncated"] = True
            step = plan_step_glance(items)
            if step is not None:
                plan["step"] = step
            return plan

        @staticmethod
        def _parse_plan_result(result: Any) -> Optional[Tuple[int, List[Any]]]:
            if isinstance(result, (bytes, bytearray)):
                if len(result) > PLAN_RESULT_MAX_BYTES:
                    return None
                try:
                    result = result.decode("utf-8")
                except UnicodeDecodeError:
                    return None
            if isinstance(result, str):
                if len(result.encode("utf-8", errors="replace")) > PLAN_RESULT_MAX_BYTES:
                    return None
                try:
                    result = json.loads(result)
                except (TypeError, ValueError):
                    return None
            if not isinstance(result, dict) or not isinstance(result.get("todos"), list):
                return None
            raw_revision = result.get("revision")
            if isinstance(raw_revision, bool):
                return None
            try:
                revision = max(0, int(raw_revision or 0))
            except (TypeError, ValueError):
                return None
            items = [item for item in result["todos"] if isinstance(item, dict)]
            return revision, items

        @staticmethod
        def _normalize_plan_item(item: Dict[str, Any]) -> Dict[str, Any]:
            content = " ".join(str(item.get("content") or "").split())
            if len(content) > PLAN_ITEM_MAX_CHARS:
                content = content[: PLAN_ITEM_MAX_CHARS - 1].rstrip() + "…"
            status = str(item.get("status") or "").strip().lower()
            if status not in PLAN_STATUSES:
                status = "pending"
            normalized: Dict[str, Any] = {"content": content, "status": status}
            item_id = str(item.get("id") or "").strip()[:PLAN_ID_MAX_CHARS]
            if item_id:
                normalized["id"] = item_id
            parent = str(item.get("parent") or "").strip()[:PLAN_ID_MAX_CHARS]
            if parent:
                normalized["parent"] = parent
            return normalized

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

        def _bot_screen_profile_call(self, params: Any, call: Any, *, scoped: bool = True) -> Dict[str, Any]:
            """Use only an admitted profile's own runtime. Never redirect to default.

            Executed on a worker: the Hermes ContextVar scope covers config,
            terminal placement and bot-desktop state without changing transport.
            Recheck admission after a potentially slow screenshot too.
            """
            from .profile_routes import resolve_default_home, sanitize_profile_name

            p = params if isinstance(params, dict) else {}
            name = sanitize_profile_name(p.get("profileId"))
            denied = {"v": 1, "state": "unknown", "gray": None, "code": "profile_unavailable"}
            if name is None:
                return denied
            ns = namespace_for_profile(name)
            if self._namespace_route_error(ns):
                return denied
            _, homes = self._profile_routing_snapshot()
            home = homes.get(ns) if ns != self._namespace else resolve_default_home()
            if home is None:
                return denied
            try:
                if scoped:
                    from gateway.run import _profile_runtime_scope

                    with _profile_runtime_scope(Path(home)):
                        result = call(Path(home))
                else:
                    # Describing/authorizing a path reads no profile runtime;
                    # do not hydrate secrets or terminal policy per egress batch.
                    result = call(Path(home))
            except Exception:  # a missing scope must not read another profile
                return {**denied, "code": "profile_scope_unavailable"}
            return denied if self._namespace_route_error(ns) else result

        async def handle_bot_screen_route(self, params: Any) -> Dict[str, Any]:
            def describe(home: Path) -> Dict[str, Any]:
                config = bot_screen.hello_config(home)
                return {"v": 1, "profileId": params.get("profileId"),
                        "socket": config.get("botScreenSocket"), "probe": config.get("botScreenProbe")}

            return await asyncio.to_thread(self._bot_screen_profile_call, params, describe, scoped=False)

        async def handle_bot_screen_status(self, params: Any) -> Dict[str, Any]:
            # #5146: Hermes's status() reads files and process tables; keep it off the loop.
            if isinstance(params, dict) and "profileId" in params:
                return await asyncio.to_thread(self._bot_screen_profile_call, params, lambda _home: bot_screen.status())
            return await asyncio.to_thread(bot_screen.status)

        async def handle_bot_screen_start(self, params: Any) -> Dict[str, Any]:
            """The wearer's Start button and the agent's show_bot_screen: start an installed, off
            screen with Hermes's own start. Only the admitted profile's; never installs anything.

            Hermes's start waits for the display (up to ``bot_screen.START_WAIT_S``), so it runs
            on a worker inside that profile's runtime scope, like the status read.
            """
            p = params if isinstance(params, dict) else {}
            if "profileId" in p:
                result = await asyncio.to_thread(self._bot_screen_profile_call, p, lambda _home: bot_screen.start())
            else:
                result = await asyncio.to_thread(bot_screen.start)
            if "ok" not in result:  # a denied route: keep the start reply's shape
                return {"v": 1, "ok": False, "code": result.get("code", "profile_unavailable"), "state": "unknown"}
            return result

        async def handle_bot_screen_control(self, params: Any) -> Dict[str, Any]:
            """Direct private input; never dispatch a tool/model/chat operation."""
            p = params if isinstance(params, dict) else {}

            def control(home: Path) -> Dict[str, Any]:
                from .profile_routes import resolve_default_home, sanitize_profile_name

                name = sanitize_profile_name(p.get("profileId"))
                ns = namespace_for_profile(name) if name is not None else None

                def admitted() -> bool:
                    if ns is None or self._namespace_route_error(ns):
                        return False
                    _, homes = self._profile_routing_snapshot()
                    current = homes.get(ns) if ns != self._namespace else resolve_default_home()
                    return current is not None and Path(current) == home

                return self._bot_screen_control.call(home, p, enrolled=admitted)

            result = await asyncio.to_thread(self._bot_screen_profile_call, p, control)
            if "available" not in result:
                # Preserve the control reply's safe shape even for a denied route.
                return {"v": 1, "id": p.get("id") if bot_screen_control._valid_id(p.get("id")) else None,
                        "available": False, "source": None, "ok": False,
                        "code": result.get("code", "profile_unavailable"),
                        "lease": {"known": False, "holder": "unknown", "mine": False,
                                  "epoch": 0, "reason": "", "since": 0}}
            return result

        async def handle_bot_screen_snapshot(self, params: Any) -> Dict[str, Any]:
            # #5146: a sandbox-placed screen's picture. Never logged or stored here.
            p = params if isinstance(params, dict) else {}
            # `color: true`: the phone's colour view is open; the reply adds `rgb`.
            extra = {"color": True} if p.get("color") is True else {}

            def grab(_home: Any = None) -> Dict[str, Any]:
                return bot_screen.snapshot(p.get("maxW"), p.get("maxH"), **extra)

            if "profileId" in p:
                return await asyncio.to_thread(self._bot_screen_profile_call, p, grab)
            return await asyncio.to_thread(grab)

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
            was_busy = self._ledger.is_busy(session_key) or any(
                key == session_key for key, _ in self._processing_deliveries
            )
            await self._close_session_records(session_key, code="cancelled")
            await self.interrupt_session_activity(session_key, chat_id)
            # Interrupt first, then release the question, so the agent
            # cannot write one more reply after Stop.
            released = await self._release_pending_clarify(session_key)
            return {"status": "accepted", "aborted": bool(was_busy or released)}

        async def _release_pending_clarify(self, session_key: str) -> int:
            """#4833: a Hermes question still waiting after Stop is dropped.

            Returns how many questions Stop had to drop itself."""
            try:
                from tools import clarify_gateway
            except Exception:  # noqa: BLE001 - no clarify support, nothing waits
                return 0
            has_pending = getattr(clarify_gateway, "has_pending", None)
            clear_session = getattr(clarify_gateway, "clear_session", None)
            if not callable(has_pending) or not callable(clear_session):
                return 0
            deadline = time.monotonic() + CLARIFY_STOP_GRACE_S
            while has_pending(session_key) and time.monotonic() < deadline:
                await asyncio.sleep(CLARIFY_STOP_POLL_S)
            if not has_pending(session_key):
                return 0
            cleared = int(clear_session(session_key) or 0)
            if cleared:
                logger.info("[ocuclaw] Stop dropped %d waiting question(s) for %s", cleared, session_key)
            return cleared

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
            """This namespace's OWN Hermes home, or None (#2942).

            Draining namespaces still resolve, so an in-flight turn keeps
            reading and writing its own profile's files. A namespace the
            multiplexer does not serve resolves to None and NEVER to the
            default profile's home: answering one agent's request out of
            another agent's files is a silent redirect, and every caller here
            already treats None as "unknown".
            """
            multiplex, homes = self._profile_routing_routable()
            if multiplex:
                routed = homes.get(ns)
                if routed is not None:
                    return Path(routed)
                if ns != self._namespace:
                    return None
            return _hermes_home()

        def _input_prediction_resolve_profile(
            self, profile_id: str
        ) -> Tuple[str, Optional[Path], Optional[str]]:
            """Silent input (#2836): the child's ``profileId`` wire form is a
            Hermes profile name ("default" = canonical); empty = this
            gateway's own namespace. Returns ``(ns, home, route_error)``."""
            name = str(profile_id or "").strip() or profile_for_namespace(self._namespace)
            ns = namespace_for_profile(name)
            error = self._namespace_route_error(ns)
            if error:
                return ns, None, error
            return ns, self._profile_home_for_options(ns), None

        def _input_prediction_profile_scope(self, ns: str, home: Optional[Path]):
            """Scope config + credentials to a secondary multiplexed profile;
            the gateway's own namespace needs no scope."""
            if not self._multiplex_enabled or ns == self._namespace or home is None:
                return contextlib.nullcontext()
            try:
                from gateway.run import _profile_runtime_scope
            except ImportError:
                return contextlib.nullcontext()
            return _profile_runtime_scope(home)

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
                from .yaml_compat import yaml

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
            # #3896: /fast refuses unless this check passes (gateway/
            # slash_commands_model.py _handle_fast_command, same helper on
            # 0.21.0-0.21.5). Ask it the same way so the wearer is never
            # offered a Fast toggle Hermes will refuse. Unknown stays absent.
            fast_options: Dict[str, bool] = {}
            try:
                from gateway.run import _resolve_gateway_model
                from hermes_cli.models import model_supports_fast_mode

                fast_model = _resolve_gateway_model(cfg)
                fast_supported = bool(model_supports_fast_mode(fast_model))
                if fast_supported:
                    # #7135: from 0.22.0 /fast also refuses a route that would
                    # not carry the tier (a proxy, another provider), and says
                    # so in the chat. The relay turns Fast on by itself for a
                    # card build, so the route is asked here too.
                    base_url = (
                        str(model_cfg.get("base_url") or "").strip()
                        if isinstance(model_cfg, dict) else ""
                    )
                    fast_supported = fast_tier_reaches_route(
                        fast_model, provider, base_url
                    ) is not False
                fast_options["fastModeSupported"] = fast_supported
            except Exception:
                pass
            # Live reasoning is one gateway-wide Hermes key, not a profile's
            # own: it is read from the config this gateway process booted on,
            # outside the profile scope above. Unknown stays absent.
            live_reasoning_options: Dict[str, str] = {}
            try:
                live_reasoning = _live_reasoning_state()
                if live_reasoning:
                    live_reasoning_options["liveReasoning"] = live_reasoning
            except Exception:
                pass
            return {
                "defaultModel": f"{provider}/{model}" if provider and model else model,
                "defaultThinking": thinking,
                "defaultFastMode": service_tier in {"fast", "priority"},
                "conversationToolProgress": tool_progress != "off",
                **reasoning_options,
                **fast_options,
                **live_reasoning_options,
            }

        def _profile_options_accepted(
            self,
            home: Path,
            *,
            live_reasoning_requested: bool,
            live_reasoning_value: Any,
        ) -> Dict[str, Any]:
            """The accepted apply result: the readback, plus the outcome of the
            app's live-reasoning request when it made one.

            The write goes to the gateway's own config, the one Hermes builds
            its hook set from, so it runs here, after the profile scope has
            closed. ``restartRequired`` is the readback's own verdict: true
            exactly when the key is saved and this process has not registered
            the hooks.
            """
            outcome: Optional[str] = None
            if live_reasoning_requested:
                outcome = _apply_live_reasoning_option(live_reasoning_value)
            result: Dict[str, Any] = {
                "status": "accepted",
                **self._read_profile_options_sync(home),
            }
            if outcome is not None:
                result["liveReasoningResult"] = outcome
                state = result.get("liveReasoning")
                result["restartRequired"] = (
                    state == LIVE_REASONING_STATE_RESTART
                    if state is not None
                    else outcome == "written"
                )
            return result

        def _apply_profile_options_sync(
            self,
            home: Path,
            options: Dict[str, Any],
        ) -> Dict[str, Any]:
            from gateway.run import _load_gateway_config, _profile_runtime_scope
            from hermes_cli.config import (
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
                "show_reasoning",
                LIVE_REASONING_OPTION,
            }
            unknown = sorted(set(options) - allowed)
            if unknown:
                return {
                    "status": "rejected",
                    "error": f"unknown profile option(s): {', '.join(unknown)}",
                }

            # Live reasoning is not this profile's setting: it is one key in
            # the gateway's own config. It is taken out of the profile patch
            # here and applied once that patch has landed.
            live_reasoning_requested = LIVE_REASONING_OPTION in options
            live_reasoning_value = options.get(LIVE_REASONING_OPTION)
            options = {
                key: value
                for key, value in options.items()
                if key != LIVE_REASONING_OPTION
            }
            if live_reasoning_requested and not options:
                # Nothing for the profile's config, so it is not rewritten.
                return self._profile_options_accepted(
                    home,
                    live_reasoning_requested=True,
                    live_reasoning_value=live_reasoning_value,
                )

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

                if "show_reasoning" in options and not isinstance(
                    options.get("show_reasoning"), bool
                ):
                    return {
                        "status": "rejected",
                        "error": "show_reasoning must be a boolean",
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

                if "tool_progress" in options or "show_reasoning" in options:
                    # Same shape hermes' own `/verbose` and `/reasoning
                    # show|hide` write and `hermes config get
                    # display.platforms.ocuclaw.<key>` reads back. Hermes
                    # re-resolves both per turn off an mtime-keyed config cache
                    # (gateway/run.py `_load_gateway_config` +
                    # `resolve_display_setting`), so the change lands with no
                    # gateway restart. Unlike the slash command, this writes no
                    # "Reasoning display" reply into the conversation.
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
                    if "tool_progress" in options:
                        platform_cfg["tool_progress"] = (
                            str(options.get("tool_progress") or "").strip().lower()
                        )
                    if "show_reasoning" in options:
                        platform_cfg["show_reasoning"] = options["show_reasoning"]

                # A model switch drops stale model keys and a cleared effort
                # drops its key, on purpose; 0.21.6+ refuses that through the
                # plain writer.
                replace_config(config_path, raw_cfg)

            return self._profile_options_accepted(
                home,
                live_reasoning_requested=live_reasoning_requested,
                live_reasoning_value=live_reasoning_value,
            )

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

        async def _refresh_setup_hint(self) -> None:
            """Carry the host's guided-setup hint to this platform's phones.

            The setup tool runs in the host conversation, which has no adapter
            and no link; it leaves a profile-scoped receipt instead. This is the
            gateway half of that hop (#3010), and it is DERIVED, never
            remembered: the phase is re-read from the receipt every pass, so a
            host that died mid-wait stops showing a row as soon as its receipt
            expires, and a restarted gateway or runtime child starts from what
            is true now. Only the edge is pushed, so an idle profile costs one
            small read per pass and no link traffic at all.
            """

            link = self._link
            if link is None:
                return
            phase = await asyncio.to_thread(read_hint_phase)
            try:
                self._setup_hint_phase = await push_hint_edge(
                    link, phase, self._setup_hint_phase
                )
            except Exception:  # noqa: BLE001 — a cosmetic row, never a gate
                # The remembered phase is left alone, so the next pass retries.
                logger.debug("[ocuclaw] setup hint push failed", exc_info=True)

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
            if not session_key:
                return json.dumps(
                    {"error": f"{tool_name} requires HERMES_SESSION_KEY"},
                    ensure_ascii=False,
                )
            if parse_ocuclaw_session_key(session_key) is None:
                return json.dumps(
                    {"error": f"{tool_name} requires an OcuClaw session"},
                    ensure_ascii=False,
                )
            call_id = f"{call_id_prefix}{uuid.uuid4().hex}"
            is_render = bool(render_request(payload))
            timeout_s = (
                _liveui_render_link_timeout_s(self._settings) if is_render else 10.0
            )
            # schedule_task waits for the existing 120-second glasses decision
            # before the model can describe its outcome (#5646).
            if method == LIVEUI_TASK_METHOD and payload.get("operation") == "schedule_task":
                timeout_s = 130.0
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
                return json.dumps({"error": f"{tool_name} interrupted"})
            except Exception as exc:  # noqa: BLE001
                return json.dumps({"error": str(exc)}, ensure_ascii=False)
            if isinstance(result, dict) and "result" in result:
                return json.dumps(result["result"], ensure_ascii=False)
            return json.dumps(
                result if isinstance(result, dict) else {"result": result},
                ensure_ascii=False,
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

        def handle_liveui_compose_tool_call(self, args: Dict[str, Any]) -> str:
            # LiveUI V2 K7: the child compiles the records and paints when the
            # call lands, then answers; nothing listens on the link after, so
            # this is not a render-length wait. Every session is V2; the child
            # refuses (`not_a_v2_session`) only a call that reaches it with no
            # session key.
            return self._handle_liveui_link_tool_call(
                args,
                tool_name=LIVEUI_COMPOSE_TOOL_NAME,
                method=LIVEUI_COMPOSE_METHOD,
                call_id_prefix="liveui-compose-",
                render_request=lambda _payload: False,
            )

        def handle_phone_tool_call(
            self,
            args: Dict[str, Any],
            *,
            tool_name: str,
            method: str,
            timeout_s: float = PHONE_TOOL_DEFAULT_LINK_TIMEOUT_S,
        ) -> Any:
            """Generic forwarder for a data-registered phone tool (#2800).

            Mirrors ``_handle_liveui_link_tool_call`` minus the render/abort
            and welcome/first-run logic: one link request carrying the caller's
            Hermes session key, the child's JSON back as the tool text. A child
            ``{error, code}`` dict is returned verbatim, never raised.
            """

            payload = args if isinstance(args, dict) else {}
            session_key = _current_hermes_session_key()
            # #7189 · chat setup's "Tools for cards" asks from the host's own chat,
            # which is no OcuClaw session: only there, only as a setup request, and
            # only for the MCP switch or one named server. No session key crosses;
            # the child shows the request and nothing turns on without the tap.
            setup_chat = (
                tool_name == "request_card_setup"
                and payload.get("during") == "setup"
                and payload.get("what") in ("mcp", "server")
                and parse_ocuclaw_session_key(session_key or "") is None
                and _host_setup_session_available()
                and _setup_picked_card_tools()
            )
            if not setup_chat:
                if not session_key:
                    return json.dumps(
                        {"error": f"{tool_name} requires HERMES_SESSION_KEY"},
                        ensure_ascii=False,
                    )
                if parse_ocuclaw_session_key(session_key) is None:
                    return json.dumps(
                        {"error": f"{tool_name} requires an OcuClaw session"},
                        ensure_ascii=False,
                    )
            request = (
                {
                    "setup": True,
                    "params": {
                        "what": payload["what"],
                        "during": "setup",
                        **({"server": payload["server"]} if isinstance(payload.get("server"), str) else {}),
                    },
                }
                if setup_chat
                else {"sessionKey": session_key, "params": payload}
            )
            images_allowed = False
            image_call = tool_name in CARD_IMAGE_TOOLS and (
                tool_name != "glasses_card_command" or payload.get("capture") is True
            )
            if image_call:
                record = self._ledger.head(session_key)
                facts = self._card_image_models.facts(
                    session_key, record.run_id if record else None
                )
                request["modelInput"] = facts["input"]
                request["model"] = "/".join(
                    v for v in (facts["provider"], facts["model"]) if v
                ) or "unknown"
                images_allowed = "image" in facts["input"]
            try:
                result = self._request_link_threadsafe(
                    method,
                    request,
                    timeout_s=timeout_s,
                )
            except InterruptedError:
                return json.dumps(
                    {"error": f"{tool_name} interrupted"}, ensure_ascii=False
                )
            except Exception as exc:  # noqa: BLE001
                return json.dumps({"error": str(exc)}, ensure_ascii=False)
            wrapped = isinstance(result, dict) and "result" in result
            if wrapped:
                result = result["result"]
            if image_call:
                try:
                    card_result = card_tool_result(result, allow_images=images_allowed)
                except CardImageError as exc:
                    return json.dumps(
                        {"error": exc.code, "next": "pictures not delivered: " + str(exc)},
                        ensure_ascii=False,
                    )
                if card_result is not None:
                    return card_result
            if tool_name == CARD_ASK_TOOL_NAME:
                # #5849: the card notes ride on the yes, so the build never
                # loads the (hidden) notes skill itself.
                result = with_card_notes(result, _hermes_home())
                # And the build tools as tool_describe gives them, so the
                # build makes no tool_describe calls.
                hello = _LAST_RUNTIME_HELLO
                result = with_card_tools(
                    result, hello.get("phoneTools") if isinstance(hello, dict) else None
                )
            return json.dumps(
                result if wrapped or isinstance(result, dict) else {"result": result},
                ensure_ascii=False,
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
            if not str((_kwargs or {}).get("parent_session_id") or "").strip():
                # #5151: any platform's turn starts without the screen.
                self._bot_screen_turns.turn_started(
                    (_kwargs or {}).get("session_id"), (_kwargs or {}).get("turn_id")
                )
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
            self._card_image_models.forget_turn(session_key)
            viewer_turn = viewer_turn_running()
            if viewer_turn:
                self._begin_viewer_turn(session_key, identity, _kwargs or {})
            else:
                self._begin_helper_result_turn(session_key, _kwargs or {})
            self._ledger.note_turn_started(session_key)
            record = None
            try:
                prompt_params = {"sessionKey": session_key}
                if viewer_turn:
                    # The relay adds the short glasses guidance a Desktop
                    # turn misses: Hermes runs it without our channel prompt.
                    prompt_params["viewerTurn"] = True
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
                return self._with_bot_screen_note(None, record)
            if (
                record is not None
                and isinstance(result, dict)
                and result.get("promptOwner") == EVEN_AI_PROMPT_OWNER
            ):
                record.even_ai_turn = True
            if isinstance(result, dict):
                self._apply_session_title_toggle(_kwargs or {}, result)
            if isinstance(result, dict) and isinstance(result.get("context"), str):
                context = result["context"].strip()
                fragments = result.get("fragments")
                # Voicemail and feedback each stay owed until acked with their
                # own token. Without the feedback ack, a render refusal rode
                # every LLM call for its whole TTL as "since your last turn".
                ack_params = {"sessionKey": session_key}
                if context and isinstance(fragments, list):
                    for fragment, result_key, param_key in (
                        ("voicemail", "voicemailAckToken", "ackToken"),
                        ("feedback", "feedbackAckToken", "feedbackAckToken"),
                    ):
                        token = result.get(result_key)
                        if fragment in fragments and isinstance(token, str) and token:
                            ack_params[param_key] = token
                if len(ack_params) > 1:
                    try:
                        self._request_link_threadsafe(
                            LIVEUI_PROMPT_ACK_METHOD,
                            ack_params,
                            timeout_s=LIVEUI_PROMPT_LINK_TIMEOUT_S,
                        )
                    except Exception:  # noqa: BLE001
                        logger.debug("[ocuclaw] liveui prompt ack unavailable", exc_info=True)
                return self._with_bot_screen_note(context or None, record)
            return self._with_bot_screen_note(None, record)

        def _begin_viewer_turn(
            self, session_key: str, identity: Dict[str, str], kwargs: Dict[str, Any]
        ) -> None:
            """Show a prompt typed in Hermes Desktop or the TUI on the glasses.

            The prompt goes out first as a user row labelled "Desktop", then
            the turn's working state. The reply's sends then stream and commit
            under this record, and on_session_end closes it like any turn.
            A hidden Desktop send (goal control, an inline-preview decision)
            gets no user row, as in Desktop itself.
            """
            try:
                message = kwargs.get("user_message")
                text = message.strip() if isinstance(message, str) else turn_user_text(kwargs)
                if text and not hidden_display_turn():
                    self._emit_event(
                        "message",
                        viewer_prompt_message_event(
                            identity, text, message_id=self._next_message_id()
                        ),
                    )
                public_key = self._public_key_for_native_session(session_key)
                if not public_key:
                    return
                record = self._ledger.begin_viewer_turn(
                    session_key=session_key,
                    run_id=f"viewer-{uuid.uuid4().hex}",
                    public_key=public_key,
                )
                if record is not None:
                    self._emit_event("activity", lifecycle_start_activity(record))
            except Exception:  # noqa: BLE001
                logger.debug("[ocuclaw] viewer turn start failed", exc_info=True)

        def _begin_helper_result_turn(self, session_key: str, kwargs: Dict[str, Any]) -> None:
            """Give the turn that hands a background helper's results back a run.

            Hermes starts that turn itself ("[ASYNC DELEGATION … COMPLETE]"),
            so no OcuClaw send opened a record for it and its reply used to
            reach the glasses whole, as an uncorrelated message. With a record
            its sends stream and commit like any turn's, the header shows it
            working, and on_session_end closes it. The prompt is Hermes's own
            internal text, so no user row goes out. Nothing opens while a turn
            already holds the chat: that turn owns the sends.
            """
            try:
                message = kwargs.get("user_message")
                if not is_helper_result_turn(
                    message if isinstance(message, str) else turn_user_text(kwargs)
                ):
                    return
                public_key = self._public_key_for_native_session(session_key)
                if not public_key:
                    return
                record = self._ledger.begin_viewer_turn(
                    session_key=session_key,
                    run_id=f"helper-{uuid.uuid4().hex}",
                    public_key=public_key,
                )
                if record is not None:
                    self._emit_event("activity", lifecycle_start_activity(record))
            except Exception:  # noqa: BLE001
                logger.debug("[ocuclaw] helper result turn start failed", exc_info=True)

        def _with_bot_screen_note(self, context: Optional[str], record: Any) -> Optional[str]:
            """#5151: while the bot's screen runs, an OcuClaw chat's turn asks
            it to raise a login, code, CAPTCHA or payment through clarify, so
            the glasses can show Needs you. Never on an Even AI turn, where
            clarify is vetoed (``even_ai_clarify_block``)."""
            try:
                if record is not None and (
                    record.prompt_owner == EVEN_AI_PROMPT_OWNER or record.even_ai_turn
                ):
                    return context
                if not self._bot_screen_targets.running():
                    return context
            except Exception:  # noqa: BLE001 — a note, never part of the turn
                logger.debug("[ocuclaw] bot screen note skipped", exc_info=True)
                return context
            return f"{context}\n\n{bot_screen.PROMPT_NOTE}" if context else bot_screen.PROMPT_NOTE

        def _apply_session_title_toggle(
            self, kwargs: Dict[str, Any], result: Dict[str, Any]
        ) -> None:
            """The phone's session-name toggle over Hermes's titler, for this
            OcuClaw session only. Runs before Hermes titles the turn; any
            failure leaves Hermes to title as usual."""
            enabled = result.get("neuralSessionNamesEnabled")
            if not isinstance(enabled, bool):
                return  # an older relay: Hermes default
            session_id = str(kwargs.get("session_id") or "").strip()
            if not session_id:
                return
            if enabled and self._title_hold.held_title(session_id) is None:
                return  # the common path: nothing held, no store access
            try:
                user_text = "" if enabled else turn_user_text(kwargs)
                writer = SharedSessionWriter(default_state_db_path())
                with writer.borrow() as db:
                    outcome = self._title_hold.apply(db, session_id, enabled, user_text)
            except Exception:  # noqa: BLE001 — fail open
                logger.debug("[ocuclaw] session title toggle skipped", exc_info=True)
                return
            if outcome:
                logger.info(
                    "[ocuclaw] session title %s for %s (phone session names %s)",
                    outcome, session_id, "on" if enabled else "off",
                )

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
            # The operator's "OcuClaw live view refresh" pick (#5046). A
            # recipe's own `model` below still wins over the task's config.
            task = aux_tasks.task_for(aux_tasks.LIVEUI_REFRESH_TASK)
            if task:
                call_kwargs["task"] = task
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

        async def _stt_send_to_child(
            self, method: str, params: Dict[str, Any]
        ) -> Any:
            """Parent → child request for the STT lane (`stt.stream.partial`).

            Reads the link per call, so a partial racing a reconnect goes to
            the current child or nowhere. SttRpc swallows every error.
            """
            link = self._link
            if link is None or not link.ready:
                return None
            return await link.request(method, params, timeout_s=5.0)

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

        def shared_chats(self) -> bool:
            """Live read: Continue here as one shared chat (Hermes 0.23+, opt-in).

            On these gateways Desktop, the TUI and `hermes chat` are viewers of
            the gateway's own session, so a chat continued on glasses has one
            queue and one history on every surface. Continue here is offered
            again and the single-driver lock stands down. Off by default.
            """
            config = getattr(self, "config", None)
            extra = getattr(config, "extra", None)
            return _shared_chats_enabled(extra if isinstance(extra, dict) else {}, _hermes_version())

        def auto_agent(self) -> bool:
            """Live read: the Auto agent host kill switch (#6795, on by default).

            `platforms.ocuclaw.extra.auto_agent: false` in the default profile's
            config turns Auto off for every wearer. Only the host sets it; the
            wearer's own switch is the OcuClaw setting `autoAgent`.
            """
            config = getattr(self, "config", None)
            extra = getattr(config, "extra", None)
            return _auto_agent_requested(extra if isinstance(extra, dict) else {})

        def auto_route_available(self) -> bool:
            """Auto is offered: the switch is on and the router's aux task registered."""
            return self.auto_agent() and aux_tasks.is_registered(aux_tasks.AGENT_ROUTER_TASK)

        async def handle_foreign_adopt_gate(self, params: Any) -> Dict[str, Any]:
            """`foreign.sessions.adopt`: shared chats adopt; otherwise copy-only refuses."""
            if self.shared_chats():
                return await self.handle_foreign_adopt(params)
            return await self.handle_shared_handoff_unavailable(params)

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

        async def handle_shared_handoff_unavailable(self, params: Any) -> Dict[str, Any]:
            """Fail closed for stale clients; copying is the supported interim."""
            return self._adopt_rejection("shared_handoff_unavailable")

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
                    self._session_rpc.resolve_adopt_source,
                    identity,
                    allow_local_route=self.shared_chats(),
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
            # Shared chats: an open Desktop window is a viewer of this same
            # gateway session, not a second agent, so it never holds the chat.
            if not take_over and not self.shared_chats():
                hold = await asyncio.to_thread(
                    desktop_hold_state, self._profile_home_for_options(ns), lineage
                )
                if hold is not None:
                    return self._adopt_rejection("desktop_busy", holdState=hold, tip=tip)

            # The native resume mutates before predecessor cleanup. Establish
            # known writer support now, never discover its absence after re-keying.
            try:
                await asyncio.to_thread(
                    self._session_rpc.ensure_adopt_writer_supported, identity
                )
            except Exception as exc:  # noqa: BLE001 - bounded pre-mutation refusal
                reason = str(exc)
                if reason not in {"session_writer_unsupported", "session_store_unavailable", "session_storage_busy"}:
                    reason = "session_mutation_unknown"
                return self._adopt_rejection(reason)
            # Another request may have reserved this tip during preflight's await.
            if tip in self._adopting_tips:
                return self._adopt_rejection("own_lane_busy", tip=tip)

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
            predecessor_ids = [row["id"] for row in outcome.get("predecessors") or []]
            cleanup = {}
            try:
                hidden = await asyncio.to_thread(
                    self._session_rpc.hide_sessions, predecessor_ids
                )
                if set(hidden) != set(predecessor_ids):
                    cleanup = {"cleanupStatus": "pending", "cleanupError": "session_mutation_unknown"}
            except Exception as exc:  # noqa: BLE001 - adoption already committed
                hidden = []
                reason = str(exc)
                if reason not in {"session_writer_unsupported", "session_store_unavailable", "session_storage_busy", "session_mutation_unknown"}:
                    reason = "session_mutation_unknown"
                cleanup = {"cleanupStatus": "pending", "cleanupError": reason}
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
                **cleanup,
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
            uncertain = False
            correlation = uuid.uuid4().hex[:12]
            if chat_id:
                session_key = self._session_key_for_chat(chat_id, ns=ns)
                try:
                    lineage = await asyncio.to_thread(
                        self._session_rpc.lineage_for_key, session_key
                    )
                except Exception:  # noqa: BLE001 - unknowable never locks
                    uncertain = True
                    logger.debug(
                        "[ocuclaw] driver reason=lineage_unavailable phase=resolve correlation=%s", correlation
                    )
                    lineage = []
                session_id = lineage[0] if lineage else None
            shared = self.shared_chats()
            if shared:
                # One gateway session, many viewers: nobody holds it.
                hold = None
            else:
                try:
                    hold = await asyncio.to_thread(desktop_hold_details, home, lineage, strict=True)
                except Exception:
                    hold = None
                    uncertain = True
                    logger.debug(
                        "[ocuclaw] driver reason=ownership_unavailable phase=observe correlation=%s", correlation
                    )
            inflight_platform = self.inflight_platform(lineage)
            return {
                "status": "ok",
                "publicKey": str(p.get("publicKey") or ""),
                "sessionId": session_id,
                "lineage": lineage,
                "state": driver_state_for(hold),
                "shared": shared,
                "uncertain": uncertain,
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

        # -- chats deleted elsewhere (hermes on_session_delete, sync) ---------

        def handle_session_delete(self, gone: Dict[str, Any]) -> None:
            """Tell the relay which native rows left a store it lists.

            Only ids go out: the rows are gone by the time the hook fires, so
            the relay maps them to chats from what it last listed. A store
            outside every profile, or a profile this gateway does not serve,
            is not this adapter's picker.
            """
            ns = self._namespace_for_deleted_profile(gone.get("profile"))
            if ns is None:
                return
            self._emit_event(
                SESSIONS_GONE_EVENT_NAME,
                {
                    "ns": ns,
                    "ids": list(gone["ids"]),
                    "reason": gone["reason"],
                    "origin": gone["origin"],
                },
            )

        def _namespace_for_deleted_profile(self, profile: Any) -> Optional[str]:
            if not isinstance(profile, str) or not profile.strip():
                return None
            if profile == _process_profile_name():
                return self._namespace
            ns = _namespace_for_profile(profile)
            # Plain reads of the rebound route tables: no config read on the
            # thread that committed the delete.
            if ns in self._served_profile_homes or ns in self._draining_profile_homes:
                return ns
            return None

        # -- turn completion (hermes on_session_end, sync, worker thread) ----

        def handle_session_end(self, kwargs: Dict[str, Any]) -> None:
            # Tier 0 (T2 #2510) clears BEFORE the platform filter.
            self._inflight_clear(kwargs)
            if self._delivery_is_cancelled():
                # A late end on the same native carrier must not drain its
                # successor or re-publish the cancelled reply via history.
                return
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
                # Count AND byte bound (#7327): the agent_end hook frame
                # crosses the link, and a frame over 1 MiB arrives as a
                # truncation marker with no messages at all.
                messages = tail_within_link_budget(
                    self._session_rpc.conversation_by_id(
                        session_id, limit=HISTORY_PUSH_LIMIT
                    )
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

        def _install_profile_enrollment(self) -> None:
            """Enforce OcuClaw's enrollment set on every route read (#2940).

            Migrates the retired ``gateway.multiplex_profile_allowlist`` when
            it is still on the host, then installs the admission predicate on
            the shared resolver.

            **A failure here must narrow, never widen.** If the enrollment
            module cannot be installed at all, the resolver would keep its
            default predicate — "every served profile is routable" — which is
            precisely the pre-#2940 behaviour this ticket exists to remove. So
            the fallback is a predicate that admits nothing but the default
            profile: the wearer keeps the agent that carries their pairing and
            is told to reselect, rather than silently getting every profile on
            the host.
            """
            try:
                from . import profile_enrollment

                enrollment = profile_enrollment.install_admission()
                logger.debug(
                    "[ocuclaw] agent enrollment installed: state=%s agents=%d",
                    enrollment.state,
                    len(enrollment.profiles),
                )
            except Exception as error:  # noqa: BLE001 - fails CLOSED
                try:
                    from .profile_routes import (
                        DEFAULT_PROFILE as _DEFAULT,
                        set_admission,
                    )

                    set_admission(
                        lambda profile, **_kwargs: str(profile) == _DEFAULT
                    )
                except Exception:  # noqa: BLE001
                    pass
                logger.warning(
                    "[ocuclaw] agent enrollment unavailable (%s); only the"
                    " default agent is reachable",
                    type(error).__name__,
                )

        async def _publish_serving_version(self) -> None:
            """Publish this gateway's code and boot settings for the Desktop card.

            The Desktop backend compares it with plugin.yaml and saved setup
            settings to tell when changes wait on a gateway restart
            (health.restart_to_finish). A missing receipt only hides that hint.
            """

            def _write() -> None:
                home = resolve_receipt_home()
                if home is None:
                    return
                write_serving(
                    build_serving_body(
                        profile_fingerprint=fingerprint_home(home),
                        version=health_collect.ocuclaw_version(),
                        setup_configuration_fingerprint=self._setup_configuration_fingerprint,
                    ),
                    home=home,
                )

            try:
                await asyncio.to_thread(_write)
            except Exception as exc:  # noqa: BLE001 - see docstring
                logger.debug("[ocuclaw] serving receipt not written: %s", exc)

        def _refresh_profile_routing(self) -> None:
            """Take the live served set, and note anything that left it.

            Hermes 0.21.3 reconciles the served profiles while the gateway
            runs, so this is a READ, not a boot snapshot. Two rules keep it
            from ever taking the wearer's agents away by accident:

            * ``gateway.multiplex_profiles`` is boot configuration — it cannot
              turn off under a running gateway (that needs a restart, which
              builds a new adapter). A later read that cannot see multiplex is
              therefore a failed read, and changes nothing.
            * a multiplex table without this adapter's own namespace is
              likewise unproven, never "every secondary went away".
            """
            enabled, homes = _load_profile_routing()
            proved = bool(enabled) and self._namespace in homes
            with self._routing_lock:
                if proved:
                    previous = dict(self._served_profile_homes)
                    self._multiplex_enabled = True
                    self._served_profile_homes = dict(homes)
                    self._note_route_departures(previous, homes)
                else:
                    # An unproven read changes no route, but the drain clock
                    # must still run: a namespace may not sit in the drain set
                    # forever just because the route source went quiet.
                    self._release_drained_namespaces(self._served_profile_homes)
                self._sync_native_profile_routes()

        def _sync_native_profile_routes(self) -> bool:
            with self._routing_lock:
                return self._sync_native_profile_routes_locked()

        def _remove_native_profile_routes(self) -> None:
            with self._routing_lock:
                config = getattr(getattr(self, "gateway_runner", None), "config", None)
                routes = getattr(config, "profile_routes", None)
                if isinstance(routes, list):
                    config.profile_routes = [route for route in routes if not any(
                        route is owned for owned in self._native_profile_routes
                    )]
                self._native_profile_routes = []

        def _sync_native_profile_routes_locked(self) -> bool:
            """Declare enrolled targets through Hermes's native route boundary.

            A source.profile assignment alone is not ingress authority on
            durable-runtime Hermes. Scope routes let its source builder and
            provenance revalidator independently select the same served home.
            These process-local routes never edit the operator's config file.
            """
            runner = getattr(self, "gateway_runner", None)
            config = getattr(runner, "config", None)
            routes = getattr(config, "profile_routes", None)
            if not isinstance(routes, list) or not getattr(config, "multiplex_profiles", False):
                return False
            try:
                from gateway.profile_routing import ProfileRoute
                from gateway import session_ingress_context
                if not all(callable(getattr(session_ingress_context, name, None)) for name in (
                    "capture_provenance", "restore_provenance", "native_callback"
                )):
                    return False
                if "bot_profile" not in inspect.signature(ProfileRoute).parameters:
                    return False
                match_params = inspect.signature(ProfileRoute.matches).parameters
                if not {"adapter_profile", "user_id"}.issubset(match_params):
                    return False
            except (ImportError, TypeError, ValueError):
                return False
            owned = self._native_profile_routes
            retained = [route for route in routes if not any(route is item for item in owned)]
            profiles = sorted(profile_for_namespace(ns) for ns in
                              (self._served_profile_homes.keys() | self._draining_profile_homes.keys()))
            # Reuse route objects when unchanged, so a refresh cannot create
            # duplicate matches or discard routes belonging to the operator.
            previous = {route.profile: route for route in owned}
            current = [previous.get(profile) or ProfileRoute(
                name=f"ocuclaw-enrolled:{profile}", platform=PLATFORM_NAME,
                profile=profile, guild_id=f"ocuclaw:profile:{profile}",
                bot_profile=getattr(self, "_owner_profile", None),
            ) for profile in profiles]
            config.profile_routes = retained + current
            self._native_profile_routes = current
            return True

        def _note_route_departures(
            self, previous: Dict[str, Path], current: Dict[str, Path]
        ) -> None:
            """Drain policy for a profile deleted mid-turn (#2942).

            A namespace that leaves the served set keeps ITS OWN home for a
            bounded window so work already in flight finishes against the
            right profile's files. It admits nothing new — that refusal is
            :data:`PROFILE_NO_LONGER_SERVED_ERROR` — and it is never rewritten
            to the default profile's home, because silently answering as
            another agent is worse than answering with an error.

            The window is ``INFLIGHT_TTL_S``, the same bound the adapter
            already uses to declare a turn dead; and a namespace is released
            early as soon as this gateway has no turn in flight at all.
            """
            now = time.monotonic()
            added_homes: Dict[str, Path] = {}
            added_until: Dict[str, float] = {}
            for ns, home in previous.items():
                if ns == self._namespace or ns in current:
                    continue
                if ns not in self._draining_profile_homes:
                    logger.info(
                        "[ocuclaw] profile namespace %s left the served set; "
                        "draining in-flight work for up to %.0fs",
                        ns,
                        INFLIGHT_TTL_S,
                    )
                    added_homes[ns] = home
                    added_until[ns] = now + INFLIGHT_TTL_S
            if added_homes:
                # Rebind, never mutate: this view is read without the lock.
                self._draining_profile_homes = {
                    **self._draining_profile_homes, **added_homes
                }
                self._draining_profile_until = {
                    **self._draining_profile_until, **added_until
                }
            self._release_drained_namespaces(current)

        def _release_drained_namespaces(self, current: Dict[str, Path]) -> None:
            """Drop draining namespaces that are served again, expired, or idle.

            Callers hold ``_routing_lock``. The published view is REBOUND, never
            mutated in place, because it is read from the loop and from every
            worker thread an RPC handler runs on.
            """
            if not self._draining_profile_homes:
                return
            now = time.monotonic()
            any_inflight = bool(self.inflight_snapshot())
            keep_homes: Dict[str, Path] = {}
            keep_until: Dict[str, float] = {}
            for ns, home in self._draining_profile_homes.items():
                if (
                    ns in current
                    or not any_inflight
                    or now >= self._draining_profile_until.get(ns, 0.0)
                ):
                    continue
                keep_homes[ns] = home
                keep_until[ns] = self._draining_profile_until[ns]
            self._draining_profile_homes = keep_homes
            self._draining_profile_until = keep_until

        def _profile_routing_snapshot(self) -> Tuple[bool, Dict[str, Path]]:
            """The ADMITTED routes: where a new turn may be dispatched."""
            self._refresh_profile_routing()
            return self._multiplex_enabled, dict(self._served_profile_homes)

        def _profile_routing_routable(self) -> Tuple[bool, Dict[str, Path]]:
            """Admitted plus draining: where existing work still resolves."""
            multiplex, homes = self._profile_routing_snapshot()
            if not self._draining_profile_homes:
                return multiplex, homes
            merged = dict(self._draining_profile_homes)
            merged.update(homes)
            return multiplex, merged

        def _namespace_route_error(self, ns: str) -> Optional[str]:
            namespace = str(ns or self._namespace)
            if namespace == self._namespace:
                return None
            multiplex, homes = self._profile_routing_snapshot()
            if not multiplex:
                return MULTIPLEX_DISABLED_ERROR
            profile = profile_for_namespace(namespace)
            if namespace in homes:
                return None
            if namespace in self._draining_profile_homes:
                # Discovery is not admission, and neither is draining: work
                # already running finishes, nothing new starts.
                return PROFILE_NO_LONGER_SERVED_ERROR.format(profile=profile)
            return PROFILE_NOT_SERVED_ERROR.format(profile=profile)

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
                # Draining namespaces are included: an outbound frame for a
                # turn that was in flight when its profile left the served set
                # must still be attributed to that profile, not to default.
                _, routable = self._profile_routing_routable()
                namespaces = dict.fromkeys((self._namespace, *routable))
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
            self._note_ocuclaw_reply_settled(session_key)
            current_task = None
            try:
                current_task = asyncio.current_task()
            except RuntimeError:
                pass
            if task is not None and task is not current_task:
                task.cancel()

            head = closure["record"]
            if head.delivery_cancelled:
                return False
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

            if record is None:
                return
            # H11 (#3348). Read the mark BEFORE anything else this commit does.
            # The order below is the whole fix: the run has to be closed as
            # errored while the candidate does not exist yet, because the
            # child's `replyDelivery.observe` reads runOutcomes the moment the
            # candidate is published. Publish first and it sees a clean run.
            errored_code = self._take_provider_error_mark(
                getattr(record, "session_key", ""), getattr(record, "run_id", "")
            )
            closing_frames: List[Any] = []
            if errored_code is not None:
                closing_frames = self._close_provider_errored_run(record, errored_code)
            if (
                record.kind != KIND_TURN
                or getattr(record, "viewer_turn", False)
                or parse_ocuclaw_session_key(record.session_key) is None
            ):
                return
            if errored_code is not None:
                # An errored run still publishes a candidate, and deliberately
                # so: the error text DID reach the glasses, and the only
                # surface that can say "the chain works, the model does not"
                # is this candidate's reply-delivery observation. The gate
                # keeps its failure tombstone, so it can never become a
                # successful candidate afterwards.
                #
                # 2026-09-22 lab e2e: the terminal frame rides the link
                # asynchronously while this publish is a synchronous file
                # write, so the child's observe ran before the relay knew the
                # run had errored and settled on a clean-run reason. Publish
                # only once every closing frame has been acknowledged.
                if self._phone_turn_candidate_gate.note_errored(
                    record.session_key, record.run_id
                ):
                    session_key, run_id = record.session_key, record.run_id
                    self._run_after_frames(
                        closing_frames,
                        # #3392. The mark's code rides on the candidate so the
                        # separate `hermes ocuclaw first-use` process can name
                        # the failure; nothing else crosses that boundary.
                        lambda: self._publish_phone_turn_candidate(
                            session_key, run_id, run_error_code=errored_code
                        ),
                    )
                return
            if self._phone_turn_candidate_gate.note_committed(
                record.session_key, record.run_id
            ):
                self._publish_phone_turn_candidate(
                    record.session_key, record.run_id
                )

        def _close_provider_errored_run(self, record: Any, code: str) -> List[Any]:
            """Close this run as errored (H11, #3348).

            Without this the head is stranded until the stale backstop, so the
            NEXT phone turn queues behind a run the engine abandoned — the D9
            symptom the #3348 e2e hit after a 401.
            """

            session_key = str(getattr(record, "session_key", "") or "")
            run_id = str(getattr(record, "run_id", "") or "")
            head, riders, promoted = self._ledger.complete_head_if_run(
                session_key, run_id
            )
            closed = [r for r in (head, *riders) if r is not None] or [record]
            # The futures of the terminal frames: the caller must not publish
            # the errored candidate until the child has acknowledged them.
            pending: List[Any] = []
            for closed_record in closed:
                future = self._emit_event(
                    "activity",
                    lifecycle_terminal_activity(
                        closed_record, completed=False, code=code
                    ),
                )
                if future is not None:
                    pending.append(future)
                self._forget_thinking_run(closed_record.run_id)
            if promoted is not None:
                self._emit_event("activity", lifecycle_start_activity(promoted))
            return pending

        @staticmethod
        def _run_after_frames(futures: List[Any], fn: Callable[[], None]) -> None:
            """Run ``fn`` once every frame future has settled (or at once when
            there is nothing to wait for). A frame that fails still releases
            ``fn``: the publish is evidence for setup, never part of the turn."""
            waiting = [f for f in futures if hasattr(f, "add_done_callback")]
            if not waiting:
                fn()
                return
            remaining = [len(waiting)]
            lock = threading.Lock()

            def _one_done(_future: Any) -> None:
                with lock:
                    remaining[0] -= 1
                    release = remaining[0] == 0
                if release:
                    try:
                        fn()
                    except Exception:  # noqa: BLE001 — never break the turn
                        logger.exception("[ocuclaw] deferred candidate publish failed")

            for future in waiting:
                future.add_done_callback(_one_done)

        def _publish_phone_turn_candidate(
            self, session_key: str, run_id: str, run_error_code: Optional[str] = None
        ) -> None:
            """Record the candidate, then ask the child to observe delivery.

            Fire-and-forget: the observation is evidence for setup, never a
            step in the turn. Nothing here blocks, retries the turn, or fails
            it, and a child without the method degrades to `unsupported`.
            """

            if self._take_failed_turn_reply(session_key, run_id) and not run_error_code:
                # The turn raised and Hermes sent its apology: the chain to
                # the glasses works, the agent did not answer. The code alone
                # refuses the proof (`_errored_run_refusal`); the run's wire
                # outcome stays as Hermes reported it.
                run_error_code = FAILED_TURN_REPLY_RUN_ERROR_CODE
            if run_error_code and run_error_code not in PHONE_CANDIDATE_RUN_ERROR_CODES:
                # The candidate's stored vocabulary is closed and read by the
                # separate first-use process; a code outside it (a refused
                # request) is still a provider error there.
                run_error_code = FAILED_TURN_REPLY_RUN_ERROR_CODE
            recorded = record_phone_turn_candidate(
                session_key=session_key,
                turn_id=run_id,
                **({"run_error_code": run_error_code} if run_error_code else {}),
            )
            candidate_id = (
                recorded.get("candidateId")
                if isinstance(recorded, Mapping)
                else None
            )
            if not candidate_id:
                return
            loop = self._loop
            if loop is None or loop.is_closed():
                return

            def _start() -> None:
                task = loop.create_task(
                    self._observe_reply_delivery(
                        str(candidate_id), session_key, run_id
                    )
                )
                self._reply_delivery_tasks.add(task)
                task.add_done_callback(self._reply_delivery_tasks.discard)

            try:
                loop.call_soon_threadsafe(_start)
            except RuntimeError:  # pragma: no cover - loop torn down mid-turn
                return

        async def _observe_reply_delivery(
            self, candidate_id: str, session_key: str, run_id: str
        ) -> None:
            # The evidence only serves first-run setup. Once the proof is
            # committed, an ordinary turn must not cost a probe and a write.
            try:
                attempt = await asyncio.to_thread(
                    inspect_attempt,
                    hermes_release=CERTIFIED_HERMES_TAG,
                    hermes_package_version=_hermes_version() or None,
                    ocuclaw_version=_ocuclaw_version(),
                    session_key=None,
                )
            except Exception:  # noqa: BLE001 — evidence only, never the turn
                attempt = {}
            if attempt.get("committed") is True:
                return
            link = self._link
            if link is None or not link.ready:
                await self._note_reply_delivery_fallback(
                    candidate_id, REPLY_DELIVERY_UNCONFIRMED, "runtime_unavailable"
                )
                return
            try:
                answer = await link.request(
                    REPLY_DELIVERY_OBSERVE_METHOD,
                    {
                        "candidateId": candidate_id,
                        "sessionKey": session_key,
                        "runId": run_id,
                    },
                    timeout_s=REPLY_DELIVERY_OBSERVE_TIMEOUT_SECONDS,
                )
                if isinstance(answer, Mapping) and answer.get("ok") is False:
                    # The child answered that it cannot observe; say so now
                    # instead of letting setup wait out its bound.
                    await self._note_reply_delivery_fallback(
                        candidate_id, REPLY_DELIVERY_UNCONFIRMED, "runtime_unavailable"
                    )
            except LinkRpcError as exc:
                if exc.code != RPC_METHOD_NOT_FOUND_CODE:
                    # Raw session and run identifiers never reach the log.
                    logger.debug("[ocuclaw] reply-delivery observe refused")
                    return
                # An older child has no reply-delivery contract at all, so the
                # honest answer is available immediately: setup falls back to
                # the wearer question instead of waiting out the bound.
                await self._note_reply_delivery_fallback(
                    candidate_id, REPLY_DELIVERY_UNSUPPORTED, "runtime_lacks_contract"
                )
            except Exception:  # noqa: BLE001 — never fail or delay the turn
                logger.debug("[ocuclaw] reply-delivery observe unavailable")

        async def _note_reply_delivery_fallback(
            self, candidate_id: str, status: str, reason: str
        ) -> None:
            try:
                await asyncio.to_thread(
                    record_reply_delivery,
                    candidate_id=candidate_id,
                    status=status,
                    reason=reason,
                )
            except Exception:  # noqa: BLE001 — evidence only, never the turn
                logger.debug("[ocuclaw] reply-delivery fallback receipt failed")

        async def _close_session_records(self, session_key: str, *, code: str) -> None:
            # Seal delivery BEFORE awaiting approval cleanup or signalling the
            # cooperative native interrupt. on_session_end can have removed
            # the ledger head while the platform is still delivering its tail.
            for (key, _), record in self._processing_deliveries.items():
                if key == session_key:
                    record.delivery_cancelled = True
            records = self._ledger.drain_session(session_key)
            for record in records:
                record.delivery_cancelled = True
            await self._drain_session_approvals(session_key)
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
                self._profile_routing_routable()[1].get(ns)
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

            selected = profile or profile_for_namespace(self._namespace)
            namespace = namespace_for_profile(selected)
            route_error = self._namespace_route_error(namespace)
            if route_error is not None:
                raise ValueError(route_error)
            native_routes = self._sync_native_profile_routes()
            scope = f"ocuclaw:profile:{selected}" if native_routes else None
            if native_routes:
                # A selected agent cannot override a configured operator
                # route, even if our scope rule would be more specific.
                owned = self._native_profile_routes
                for route in self.gateway_runner.config.profile_routes:
                    if any(route is item for item in owned):
                        continue
                    if route.matches(PLATFORM_NAME, guild_id=scope,
                                     chat_id=str(chat_id), adapter_profile=getattr(self, "_owner_profile", None),
                                     user_id=OCUCLAW_WEARER_USER_ID):
                        if route.profile != selected:
                            raise ValueError("OcuClaw agent selection conflicts with a configured Hermes profile route")

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
                **({"scope_id": scope} if scope is not None else {}),
            )
            # The profile was selected by the authenticated OcuClaw session,
            # not Hermes' optional chat-route table.
            if native_routes:
                if getattr(source, "profile_route_rejected", False) or source.profile != selected:
                    raise ValueError("Hermes did not admit the selected OcuClaw profile route")
            else:
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
            if name in {bot_screen.TARGET_EVENT, bot_screen.STEP_EVENT, bot_screen.ELEMENTS_EVENT, bot_screen.RUN_EVENT}:
                # Tool hooks on other platforms need not have an OcuClaw
                # session key. Their actual runtime home is the screen owner.
                from .profile_routes import resolve_default_home

                home = _hermes_home()
                _, homes = self._profile_routing_routable()
                ns = next((key for key, value in homes.items() if home is not None and Path(value) == home), None)
                if ns is None and home is not None and home == resolve_default_home():
                    ns = namespace_for_profile("default")
                if ns is None:
                    return None  # Unknown origin never becomes default's screen.
                payload = {**payload, "profileId": profile_for_namespace(ns)}
            if name == "activity":
                try:
                    self._session_status.observe_activity(payload)
                except Exception:  # status is observational, never part of delivery success
                    pass
            elif name == "streaming":
                try:
                    self._session_status.observe_streaming(payload)
                except Exception:  # Animation observations never affect delivery.
                    pass
            elif name == "thinking":
                try:
                    self._session_status.observe_thinking(payload)
                except Exception:  # Reasoning observations never affect delivery.
                    pass
            if name == "streaming" and self._offer_streaming(payload):
                return None
            run_id = payload.get("runId") if isinstance(payload, dict) else None
            closing = None
            if name == "message" and isinstance(run_id, str):
                # Commits (mid-turn segments included) are closing frames for
                # the message they seal: flush its stream first, keep the slot.
                closing = (run_id, False)
            elif (
                name == "activity"
                and isinstance(run_id, str)
                and payload.get("origin") == "lifecycle"
                and payload.get("phase") in ("end", "error")
            ):
                closing = (run_id, True)
            return self._emit_frame(
                BACKEND_EVENT_METHOD,
                {"name": name, "payload": payload},
                swallow_errors=swallow_errors,
                closes_stream=closing,
            )

        def _emit_hook(self, frame: Dict[str, Any]) -> None:
            closing = None
            if frame.get("name") == "agent_end":
                ctx = frame.get("ctx")
                run_id = ctx.get("runId") if isinstance(ctx, dict) else None
                closing = (run_id if isinstance(run_id, str) else "", True)
            self._emit_frame(BACKEND_HOOK_METHOD, frame, closes_stream=closing)

        def _emit_frame(
            self,
            method: str,
            params: Dict[str, Any],
            *,
            swallow_errors: bool = True,
            closes_stream: Optional[Tuple[str, bool]] = None,
        ) -> Optional[Any]:
            """Push one RPC to the child, fire-and-forget, from any thread.

            ``closes_stream=(run_id, drop)`` marks a turn's closing frame
            (commit, terminal activity, agent_end): the run's pending stream
            text goes out immediately ahead of it, the slot is dropped when
            ``drop``, and a link_overloaded refusal is retried in order
            (``_critical_backlog``) instead of lost.
            """
            link = self._link
            loop = self._loop
            if link is None or loop is None or loop.is_closed():
                return None
            critical = closes_stream is not None

            async def _push() -> None:
                if critical:
                    if self._critical_backlog:
                        # Keep closing frames in order behind an earlier refusal.
                        self._critical_enqueue(link, method, params)
                        return
                try:
                    await link.request(method, params, timeout_s=10.0)
                except LinkOverloadedError as exc:
                    if critical:
                        self._critical_enqueue(link, method, params)
                        return
                    if not swallow_errors:
                        raise
                    logger.debug("[ocuclaw] %s push failed: %s", method, exc)
                except Exception as exc:  # noqa: BLE001 — events are best-effort
                    if not swallow_errors:
                        raise
                    logger.debug("[ocuclaw] %s push failed: %s", method, exc)

            try:
                if critical:
                    run_id, drop = closes_stream
                    if run_id:
                        # The flush must start its write BEFORE this frame's
                        # task is created. A task created inside _push would
                        # queue behind closing frames already scheduled, and
                        # the phone drops a stream frame that lands after the
                        # terminal activity.
                        loop.call_soon_threadsafe(self._stream_flush_for_close, link, run_id, drop)
                # Safe from any thread (on_session_end fires on the agent's
                # worker thread); scheduling order is FIFO per thread.
                return asyncio.run_coroutine_threadsafe(_push(), loop)
            except RuntimeError:
                return None

        # -- reply-stream slot (loop-only state) -------------------------------

        def _offer_streaming(self, payload: Dict[str, Any]) -> bool:
            """Hand one cumulative stream paint to its run's slot; False
            leaves it to the plain per-frame push (slot off, no runId).

            Safe from any thread; the slot itself is only touched on the
            loop, in the same FIFO as every other emitted frame, so a closing
            frame emitted after this call always sees this text.
            """
            run_id = payload.get("runId") if isinstance(payload, dict) else None
            if self._stream_flush_floor_s <= 0 or not isinstance(run_id, str) or not run_id:
                return False
            link = self._link
            loop = self._loop
            if link is None or loop is None or loop.is_closed():
                return True
            try:
                loop.call_soon_threadsafe(self._stream_slot_offer, link, run_id, payload)
            except RuntimeError:
                pass
            return True

        def _stream_slot_offer(self, link: Any, run_id: str, payload: Dict[str, Any]) -> None:
            slot = self._stream_slots.get(run_id)
            if slot is None:
                slot = {"pending": None, "inflight": False, "sentAt": None, "timer": None}
                self._stream_slots[run_id] = slot
            pending = slot["pending"]
            if pending is not None:
                if pending.get("messageId") != payload.get("messageId"):
                    # A new message of the run: the old one's last paint is
                    # not superseded by this text, so it goes out first.
                    slot["pending"] = None
                    self._stream_slot_write(link, pending)
                else:
                    self._link_delivery_counters["stream_frames_coalesced"] += 1
            slot["pending"] = payload
            self._stream_slot_pump(link, run_id, slot)

        def _stream_slot_pump(self, link: Any, run_id: str, slot: Dict[str, Any]) -> None:
            if self._link is not link:
                # The link this slot was filled for is gone (child restart).
                if self._stream_slots.get(run_id) is slot:
                    self._stream_slots.pop(run_id, None)
                return
            if slot["inflight"] or slot["pending"] is None or slot["timer"] is not None:
                return
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            now = loop.time()
            sent_at = slot["sentAt"]
            due = now if sent_at is None else sent_at + self._stream_flush_floor_s
            if due > now:
                slot["timer"] = loop.call_later(
                    due - now, self._stream_slot_timer, link, run_id
                )
                return
            payload = slot["pending"]
            slot["pending"] = None
            slot["inflight"] = True
            slot["sentAt"] = now
            task = self._stream_slot_write(link, payload)
            if task is None:
                slot["inflight"] = False
                return
            task.add_done_callback(
                lambda _t, _link=link, _run=run_id, _slot=slot: self._stream_slot_done(
                    _link, _run, _slot
                )
            )

        def _stream_slot_timer(self, link: Any, run_id: str) -> None:
            slot = self._stream_slots.get(run_id)
            if slot is None:
                return
            slot["timer"] = None
            self._stream_slot_pump(link, run_id, slot)

        def _stream_slot_done(self, link: Any, run_id: str, slot: Dict[str, Any]) -> None:
            slot["inflight"] = False
            if self._stream_slots.get(run_id) is slot and self._link is link:
                self._stream_slot_pump(link, run_id, slot)

        def _stream_slot_take(self, run_id: str, *, drop: bool) -> Optional[Dict[str, Any]]:
            """Detach the run's pending paint (loop only) for a closing frame."""
            slot = self._stream_slots.pop(run_id, None) if drop else self._stream_slots.get(run_id)
            if slot is None:
                return None
            if slot["timer"] is not None:
                slot["timer"].cancel()
                slot["timer"] = None
            pending = slot["pending"]
            slot["pending"] = None
            return pending

        def _stream_flush_for_close(self, link: Any, run_id: str, drop: bool) -> None:
            """Send the run's pending paint ahead of a closing frame (loop only)."""
            pending = self._stream_slot_take(run_id, drop=drop)
            if pending is not None and self._link is link:
                self._stream_slot_write(link, pending)

        def _stream_slot_write(self, link: Any, payload: Dict[str, Any]) -> Optional["asyncio.Task[Any]"]:
            """Start one streaming RPC now (loop only); its write happens on
            the task's first step, ahead of anything scheduled after it."""
            self._link_delivery_counters["stream_frames_sent"] += 1

            async def _send() -> None:
                try:
                    await link.request(
                        BACKEND_EVENT_METHOD,
                        {"name": "streaming", "payload": payload},
                        timeout_s=10.0,
                    )
                except Exception as exc:  # noqa: BLE001 — paints are best-effort
                    logger.debug("[ocuclaw] streaming push failed: %s", exc)

            try:
                return asyncio.ensure_future(_send())
            except RuntimeError:
                return None

        def _stream_slots_reset(self) -> None:
            for slot in self._stream_slots.values():
                if slot["timer"] is not None:
                    slot["timer"].cancel()
            self._stream_slots.clear()
            self._critical_backlog.clear()
            task = self._critical_drain_task
            self._critical_drain_task = None
            if task is not None and not task.done():
                task.cancel()

        # -- closing-frame retry (loop-only state) ----------------------------

        def _critical_enqueue(self, link: Any, method: str, params: Dict[str, Any]) -> None:
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            self._link_delivery_counters["critical_retried"] += 1
            if not self._critical_backlog:
                logger.warning(
                    "[ocuclaw] link overloaded: retrying closing %s frame for up to %.1fs",
                    method,
                    CRITICAL_FRAME_RETRY_BUDGET_S,
                )
            self._critical_backlog.append(
                (link, method, params, loop.time() + CRITICAL_FRAME_RETRY_BUDGET_S)
            )
            if self._critical_drain_task is None or self._critical_drain_task.done():
                self._critical_drain_task = loop.create_task(self._critical_drain())

        async def _critical_drain(self) -> None:
            loop = asyncio.get_running_loop()
            delay = CRITICAL_FRAME_RETRY_BASE_S
            while self._critical_backlog:
                link, method, params, deadline = self._critical_backlog[0]
                if self._link is not link:
                    # The link this frame was for is gone; a reconnect replays
                    # state from the ledger, not from this queue.
                    self._critical_backlog.clear()
                    return
                attempt = asyncio.ensure_future(link.request(method, params, timeout_s=10.0))
                # The overload check runs before the frame is written, on the
                # attempt's first step, so one yield tells refused from sent.
                await asyncio.sleep(0)
                exc = attempt.exception() if attempt.done() else None
                if not isinstance(exc, LinkOverloadedError):
                    self._critical_backlog.popleft()
                    delay = CRITICAL_FRAME_RETRY_BASE_S
                    if exc is not None:
                        # Closed or broken link: nothing left to retry into.
                        logger.debug("[ocuclaw] closing %s retry failed: %s", method, exc)
                        continue
                    attempt.add_done_callback(_swallow_task_exception)
                    self._link_delivery_counters["critical_recovered"] += 1
                    continue
                if loop.time() >= deadline:
                    self._critical_backlog.popleft()
                    self._link_delivery_counters["critical_dropped"] += 1
                    logger.warning(
                        "[ocuclaw] link overloaded: dropped closing %s frame after %.1fs of retries",
                        method,
                        CRITICAL_FRAME_RETRY_BUDGET_S,
                    )
                    continue
                await asyncio.sleep(min(delay, max(0.0, deadline - loop.time())))
                delay = min(delay * 2, CRITICAL_FRAME_RETRY_MAX_S)

        def link_delivery_counters(self) -> Dict[str, int]:
            """Health counters for the reply stream and closing-frame retry."""
            counters = dict(self._link_delivery_counters)
            link = self._link
            link_counters = getattr(link, "counters", None) if link is not None else None
            if isinstance(link_counters, dict):
                counters["link_overloaded"] = int(link_counters.get("overloaded", 0))
            return counters

        async def _janitor_loop(self) -> None:
            # D9 backstop: escaped-exception turns bypass finalize_turn (no
            # on_session_end) — close their records so run-waiters reject.
            while True:
                await asyncio.sleep(JANITOR_INTERVAL_SECONDS)
                try:
                    self._sweep_stale_dispatch_records()
                    # OCU-1E6C-EEX1 backstop for surfaces that never pass
                    # through inbound dispatch (phone chat, cron, other
                    # platforms calling the glasses tools).
                    if self._link is not None:
                        ensure_hello_tools_registered("janitor")
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
            stt_rpc = getattr(self, "_stt_rpc", None)
            if stt_rpc is not None:
                stt_rpc.cancel_all_streams()
            self._mark_disconnected()

    return OcuClawAdapter(config, Platform(PLATFORM_NAME))
