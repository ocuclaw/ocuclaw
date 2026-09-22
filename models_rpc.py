"""Gateway read-lane RPC handlers (W07 models/status/config plane).

Wire shapes are pinned in PROTOCOL.md "Gateway read lane" and
"Override lane" (identity/profile crossing). Hermes imports stay deferred so
the bundle remains importable outside a Hermes environment; handler bodies run
in a worker thread via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import math
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

from .overrides import parse_soul_name
from . import desktop_fleet
from .profile_lifecycle import (
    PROFILE_MUTATION_LOCK, WORKSPACE_UNSUPPORTED, admit_profile,
    bootstrap_profile, write_private,
)
# The served-route question has ONE answer for the whole bundle (#2942). The
# namespace/profile mapping and the snapshot loader live with the resolver and
# are re-exported here so every existing importer keeps working unchanged.
from .profile_routes import (  # noqa: F401 - re-exported bundle surface
    CREATE_RECEIPT_FILENAME,
    DEFAULT_NAMESPACE,
    DEFAULT_PROFILE,
    load_profile_routing_snapshot,
    namespace_for_profile,
    profile_for_namespace,
)

GW_METHOD_MODELS_LIST = "gw.models.list"
GW_METHOD_MODELS_CONFIGURED = "gw.models.configured"
GW_METHOD_USAGE_STATUS = "gw.usage.status"
GW_METHOD_AUTH_STATUS = "gw.auth.status"
GW_METHOD_AGENT_IDENTITY = "gw.agent.identity"
GW_METHOD_PROFILES_LIST = "gw.profiles.list"
GW_METHOD_PROFILES_CREATE = "gw.profiles.create"
GW_METHOD_PROFILES_EMOJI_SET = "gw.profiles.emoji.set"
GW_METHOD_PROFILES_SETTINGS_GET = "gw.profiles.settings.get"
GW_METHOD_PROFILES_SETTINGS_SET = "gw.profiles.settings.set"
GW_METHOD_PROFILES_SOUL = "gw.profiles.soul"
GW_METHOD_SKILLS_STATUS = "gw.skills.status"
GW_METHOD_COMMANDS_LIST = "gw.commands.list"

ROUTABLE_USAGE_PROVIDERS: Tuple[str, ...] = (
    "anthropic",
    "openai-codex",
    "openrouter",
)
CODEX_SESSION_WINDOW_MAX_SECONDS = (5 * 60 * 60) + 60

#: How long :meth:`retry_incomplete_setup` waits for the profile mutation lock
#: before reporting that a creation owns this receipt right now. Long enough to
#: sit behind an enrollment write (milliseconds), short of blocking the wearer
#: for a whole native create.
#:
#: It MUST stay well under the phone's agents-request expiry (``PhoneUI.kt``,
#: `delay(20_000)` on `agents.state.request`), and the margin has to cover the
#: setup run after the lock as well. The phone starts its clock when the request
#: is created -- before it leaves the device -- so a host that waited the full
#: 20s would have its `creation_in_flight` sentence arrive after the request was
#: already expired and dropped, replacing the one precise refusal this lane
#: authored with "Hermes did not answer."
RETRY_LOCK_TIMEOUT_S = 8.0

#: The setup a creation receipt replays on retry. Stored in the receipt so the
#: rerun needs nothing from the caller but the profile's name — the create
#: popup's draft is gone by the time the Agents list offers Retry (#2940).
RECEIPT_SETUP_KEY = "setup"


class IncompleteRetryRefused(Exception):
    """A retry this bundle will not run, with a typed reason for the wearer.

    Every refusal here is a *decision*, never a leaked native error: the caller
    turns ``code`` into one wearer-safe sentence and leaves the row retryable.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _validated_setup(setup: Any) -> Tuple[Dict[str, str], str, List[str]]:
    """``(fields, folder, blockedTools)`` for one agent setup, or ``ValueError``.

    Shared by the first creation and by :meth:`retry_incomplete_setup`, so a
    setup replayed from a receipt is held to exactly the rules it was accepted
    under. That matters in one direction in particular: a setup that a NEWER
    bundle would now refuse (a workspace, once ``terminal_scope`` lands and is
    later withdrawn) is refused on retry too, rather than half-applied.
    """
    if not isinstance(setup, dict) or set(setup) - {"instructions", "model", "provider", "workspace", "blockedTools"}:
        raise ValueError("Invalid agent setup")
    fields = {}
    for key, limit in (("instructions", 8000), ("model", 200), ("provider", 100), ("workspace", 500)):
        value = setup.get(key, "")
        if not isinstance(value, str) or len(value) > limit or "\0" in value:
            raise ValueError(f"Invalid {key}")
        fields[key] = value.strip()
    if bool(fields["model"]) != bool(fields["provider"]):
        raise ValueError("Choose a model and its provider")
    folder = fields["workspace"]
    # Stable 0.21 lacks terminal_scope. Do not fake profile isolation by
    # mutating os.environ; retire this guard only after the upstream gate.
    if folder:
        raise ValueError(WORKSPACE_UNSUPPORTED)
    if folder and (not (folder.startswith("/") or folder.startswith("~/")) or "\n" in folder or "\r" in folder):
        raise ValueError("Use an absolute folder path or ~/")
    blocked = setup.get("blockedTools", [])
    if not isinstance(blocked, list) or len(blocked) > 3 or any(x not in ("web", "files", "terminal") for x in blocked):
        raise ValueError("Invalid tool blocks")
    return fields, folder, list(blocked)


def _setup_fingerprint(setup: Any) -> str:
    """The receipt's fingerprint for *setup*. One definition, two callers."""
    return hashlib.sha256(json.dumps(setup, sort_keys=True).encode()).hexdigest()


def _usage_window_label(
    provider: str,
    label: str,
    *,
    fetched_at: Optional[float],
    reset_at: Optional[float],
) -> str:
    """Correct an upstream Codex label only when the reset proves it is wrong.

    Hermes currently names Codex's ``primary_window`` "Session", but the Codex
    backend can put a seven-day-only allowance in that slot. A reset more than
    five hours away cannot belong to the five-hour session window, so expose it
    as weekly. Shorter/unknown windows keep Hermes's label rather than guessing.
    """
    if (
        provider == "openai-codex"
        and label.strip().lower() in {"session", "current session"}
        and fetched_at is not None
        and reset_at is not None
        and reset_at - fetched_at > CODEX_SESSION_WINDOW_MAX_SECONDS
    ):
        return "Weekly"
    return label


def _clean_str(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _profile_home(profile: Any) -> Optional[Path]:
    """The HERMES_HOME directory of one ``ProfileInfo`` row.

    ``ProfileInfo.path`` already names it (hermes builds the row from that
    directory), so prefer it and only resolve by name when a caller hands us a
    row without one.
    """
    raw = getattr(profile, "path", None)
    if raw:
        try:
            return Path(raw)
        except Exception:  # noqa: BLE001
            return None
    name = _clean_str(getattr(profile, "name", None))
    if not name:
        return None
    try:
        from hermes_cli.profiles import get_profile_dir

        return Path(get_profile_dir(name))
    except Exception:  # noqa: BLE001
        return None


def _model_ref_from_config(raw: Any) -> Optional[Dict[str, str]]:
    if isinstance(raw, str):
        model_id = _clean_str(raw)
        return {"id": model_id} if model_id else None
    if not isinstance(raw, dict):
        return None
    model_id = (
        _clean_str(raw.get("default"))
        or _clean_str(raw.get("model"))
        or _clean_str(raw.get("name"))
    )
    if not model_id:
        return None
    row = {"id": model_id}
    provider = _clean_str(raw.get("provider"))
    if provider:
        row["provider"] = provider
    return row


def _model_ref_from_entry(entry: Any, model_key: str = "model") -> Optional[Dict[str, str]]:
    if not isinstance(entry, dict):
        return None
    model_id = _clean_str(entry.get(model_key))
    if not model_id:
        return None
    row = {"id": model_id}
    provider = _clean_str(entry.get("provider"))
    if provider:
        row["provider"] = provider
    return row


def _timestamp(value: Any) -> Optional[float]:
    try:
        return float(value.timestamp())
    except Exception:  # noqa: BLE001
        return None


# OcuClaw-lane suppressions for gw.commands.list. Both are gateway_only=True,
# so hermes_cli.commands._is_gateway_available lets them through, but neither
# is addressable from the phone composer: /start acks a platform START ping
# and /topic configures Telegram DM topic sessions. Editorial, not structural
# — keep the set tiny, and do NOT grow it into a second filter.
_LANE_HIDDEN_COMMANDS = frozenset({"start", "topic"})

# Fill these WITHOUT a trailing space (hermes's TUI picker convention, kept
# here for byte-parity). Hermes tokenizes with ``split(maxsplit=1)``, so this
# is cosmetic, not correctness. ``skin`` is deliberately absent: it is
# cli_only and never reaches this lane.
_PICKER_NO_TRAILING_SPACE = frozenset({"model", "personality"})


def _slug(raw: Any) -> str:
    """The literal wire token for a command name.

    Pre-slugified server-side so the palette's inserted text can never be
    rewritten downstream by ``translateHermesSkillSlash``.
    """
    return str(raw or "").strip().lstrip("/").replace("_", "-").lower()


class GwRpc:
    """Link RPC handlers for the W07 gateway read plane."""

    def __init__(
        self,
        namespace: str = DEFAULT_NAMESPACE,
        platform_name: str = "ocuclaw",
        routing_provider: Optional[
            Callable[[], Tuple[bool, Dict[str, Path]]]
        ] = None,
        adopt_supported_provider: Optional[Callable[[], bool]] = None,
    ) -> None:
        self._namespace = namespace or DEFAULT_NAMESPACE
        self._create_lock = PROFILE_MUTATION_LOCK
        self._platform_name = platform_name
        # Continue here (#2509): whether `/resume --all` is sanctioned on this
        # host (`allow_admin_from` lists the wearer id). Read live per list so
        # the capability snapshot tracks the config the gateway booted with.
        self._adopt_supported_provider = adopt_supported_provider
        # #2942: the routes are READ, never frozen. This reader used to copy
        # the adapter's boot snapshot here, which meant a profile created from
        # the glasses could not appear in the agent list until the gateway was
        # restarted — even after Hermes 0.21.3 started serving it within ~30 s.
        # The provider is now called per read; the construction-time answer is
        # kept only as the fallback for a read that proves nothing.
        self._routing_provider = routing_provider
        self._boot_multiplex = False
        self._boot_profile_homes: Dict[str, Path] = {}
        self._management_default_home: Optional[Path] = None
        try:
            from hermes_constants import get_process_hermes_home
            self._management_default_home = Path(get_process_hermes_home()).resolve()
        except (ImportError, AttributeError, OSError):
            pass
        enabled, homes = self._read_routing_provider()
        if enabled:
            self._boot_multiplex = True
            self._boot_profile_homes = homes

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        """method -> async handler, for LinkProcess.register_request_handler."""
        return {
            GW_METHOD_MODELS_LIST: self.list_models,
            GW_METHOD_MODELS_CONFIGURED: self.configured,
            GW_METHOD_USAGE_STATUS: self.usage_status,
            GW_METHOD_AUTH_STATUS: self.auth_status,
            GW_METHOD_AGENT_IDENTITY: self.agent_identity,
            GW_METHOD_PROFILES_LIST: self.profiles_list,
            "gw.hermes.management": self.hermes_management,
            GW_METHOD_PROFILES_CREATE: self.profiles_create,
            GW_METHOD_PROFILES_EMOJI_SET: self.profiles_emoji_set,
            GW_METHOD_PROFILES_SETTINGS_GET: self.profiles_settings_get,
            GW_METHOD_PROFILES_SETTINGS_SET: self.profiles_settings_set,
            GW_METHOD_PROFILES_SOUL: self.profiles_soul,
            GW_METHOD_SKILLS_STATUS: self.skills_status,
            GW_METHOD_COMMANDS_LIST: self.commands_list,
        }

    async def list_models(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_list_models, params)

    async def configured(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_configured, params)

    async def usage_status(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_usage_status, params)

    async def auth_status(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_auth_status, params)

    async def agent_identity(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_agent_identity, params)

    async def profiles_list(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_list, params)

    async def hermes_management(self, params: Any) -> Dict[str, Any]:
        from .management_rpc import read_management

        return await asyncio.to_thread(read_management, self, params)

    async def profiles_create(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_create, params)

    async def profiles_emoji_set(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_emoji_set, params)

    async def profiles_settings_get(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_settings_get, params)

    async def profiles_settings_set(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_settings_set, params)

    async def profiles_soul(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_soul, params)

    async def skills_status(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_skills_status, params)

    async def commands_list(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_commands_list, params)

    def _sync_list_models(self, _params: Any) -> Dict[str, Any]:
        config = self._load_config()
        configured = self._configured_from_snapshot(config)
        try:
            from agent.models_dev import get_model_info, list_provider_models
            from hermes_cli.models import CANONICAL_PROVIDERS
        except Exception:  # noqa: BLE001
            CANONICAL_PROVIDERS = ()

        rows: List[Dict[str, Any]] = []
        seen: Set[Tuple[str, str]] = set()
        for provider_entry in CANONICAL_PROVIDERS:
            provider = _clean_str(getattr(provider_entry, "slug", None))
            if not provider:
                continue
            if not self._provider_enabled(config, provider):
                continue
            provider_rows: List[Tuple[Tuple[str, str], Dict[str, Any]]] = []
            local_seen: Set[Tuple[str, str]] = set()
            try:
                for raw_mid in list_provider_models(provider):
                    model_id = _clean_str(raw_mid)
                    if not model_id:
                        continue
                    key = (provider, model_id)
                    if key in seen or key in local_seen:
                        continue
                    local_seen.add(key)
                    info = get_model_info(provider, model_id)
                    row: Dict[str, Any] = {
                        "provider": provider,
                        "id": model_id,
                        "name": model_id,
                    }
                    if info is not None:
                        row["name"] = _clean_str(getattr(info, "name", None)) or model_id
                        try:
                            context_window = int(getattr(info, "context_window", 0))
                        except (TypeError, ValueError):
                            context_window = 0
                        if context_window > 0:
                            row["contextWindow"] = context_window
                        reasoning = getattr(info, "reasoning", None)
                        if isinstance(reasoning, bool):
                            row["reasoning"] = reasoning
                    provider_rows.append((key, row))
            except Exception:  # noqa: BLE001 - cold cache/offline/provider failure
                continue
            for key, row in provider_rows:
                seen.add(key)
                rows.append(row)
        # Configured routes are authoritative even when metadata is offline or
        # only describes unrelated providers. Never infer a missing provider.
        for ref in [configured["default"], *configured["fallbacks"],
                    *configured["channelOverrides"]]:
            if not ref or not ref.get("provider"):
                continue
            key = (ref["provider"], ref["id"])
            if key not in seen:
                seen.add(key)
                rows.append({"provider": key[0], "id": key[1], "name": key[1]})
        return {"models": rows}

    @staticmethod
    def _provider_enabled(cfg: Dict[str, Any], provider: str) -> bool:
        providers = cfg.get("providers")
        block = providers.get(provider) if isinstance(providers, dict) else None
        try:
            from hermes_cli.config import is_provider_enabled

            return bool(is_provider_enabled(block))
        except Exception:  # noqa: BLE001 - older Hermes still honors explicit disable
            flag = block.get("enabled", True) if isinstance(block, dict) else True
            if isinstance(flag, str):
                return flag.strip().lower() not in {"false", "0", "no", "off"}
            return bool(flag)

    def _load_config(self) -> Dict[str, Any]:
        try:
            from hermes_cli.config import load_config

            cfg = load_config()
            return cfg if isinstance(cfg, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    def _configured_default(self, cfg: Dict[str, Any]) -> Optional[Dict[str, str]]:
        return _model_ref_from_config(cfg.get("model"))

    def _sync_configured(self, _params: Any) -> Dict[str, Any]:
        return self._configured_from_snapshot(self._load_config())

    def _configured_from_snapshot(self, cfg: Dict[str, Any]) -> Dict[str, Any]:
        default = self._configured_default(cfg)

        try:
            from hermes_cli.fallback_config import get_fallback_chain

            fallback_entries = get_fallback_chain(cfg)
        except Exception:  # noqa: BLE001
            fallback_entries = []
        fallbacks = [
            ref
            for ref in (_model_ref_from_entry(entry) for entry in fallback_entries)
            if ref is not None
        ]

        platforms = cfg.get("platforms")
        platform = platforms.get(self._platform_name) if isinstance(platforms, dict) else None
        raw_overrides = platform.get("channel_overrides") if isinstance(platform, dict) else None
        channel_overrides: List[Dict[str, str]] = []
        if isinstance(raw_overrides, dict):
            for entry in raw_overrides.values():
                ref = _model_ref_from_entry(entry)
                if ref is not None:
                    channel_overrides.append(ref)

        def enabled(ref):
            return ref is not None and (
                not ref.get("provider") or self._provider_enabled(cfg, ref["provider"])
            )

        return {
            "default": default if enabled(default) else None,
            "fallbacks": [ref for ref in fallbacks if enabled(ref)],
            "channelOverrides": [ref for ref in channel_overrides if enabled(ref)],
        }

    def _usage_candidates(self) -> List[str]:
        selected: Set[str] = set()
        default = self._configured_default(self._load_config())
        if default:
            provider = _clean_str(default.get("provider"))
            if provider:
                selected.add(provider)
        try:
            from hermes_cli.auth import read_credential_pool

            pool = read_credential_pool()
        except Exception:  # noqa: BLE001
            pool = {}
        if isinstance(pool, dict):
            for provider, entries in pool.items():
                if isinstance(entries, list) and entries:
                    text = _clean_str(provider)
                    if text:
                        selected.add(text)
        return [p for p in ROUTABLE_USAGE_PROVIDERS if p in selected]

    def _sync_usage_status(self, _params: Any) -> Dict[str, Any]:
        from agent.account_usage import fetch_account_usage
        from hermes_cli.auth import PROVIDER_REGISTRY

        providers: List[Dict[str, Any]] = []
        fetched_times: List[float] = []
        for provider in self._usage_candidates():
            provider_config = PROVIDER_REGISTRY.get(provider)
            display_name = _clean_str(getattr(provider_config, "name", None))
            provider_row: Dict[str, Any] = {
                "provider": provider,
                "displayName": display_name or provider.title(),
                "windows": [],
            }
            try:
                snapshot = fetch_account_usage(provider)
            except Exception:  # noqa: BLE001
                snapshot = None
            if snapshot is None:
                provider_row["unavailableReason"] = "Usage data is unavailable."
                providers.append(provider_row)
                continue
            fetched_at = _timestamp(getattr(snapshot, "fetched_at", None))
            if fetched_at is not None:
                fetched_times.append(fetched_at)
            windows = []
            for window in getattr(snapshot, "windows", ()) or ():
                label = str(getattr(window, "label", "") or "")
                used_percent = getattr(window, "used_percent", None)
                try:
                    numeric_percent = float(used_percent)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(numeric_percent):
                    continue
                row: Dict[str, Any] = {
                    "usedPercent": numeric_percent,
                }
                reset_at = _timestamp(getattr(window, "reset_at", None))
                row["label"] = _usage_window_label(
                    provider,
                    label,
                    fetched_at=fetched_at,
                    reset_at=reset_at,
                )
                if reset_at is not None:
                    row["resetAt"] = reset_at
                windows.append(row)
            provider_row["windows"] = windows
            unavailable_reason = _clean_str(
                getattr(snapshot, "unavailable_reason", None)
            )
            if not windows:
                provider_row["unavailableReason"] = unavailable_reason or (
                    "Percentage limits are unavailable for this account."
                )
            providers.append(provider_row)
        return {
            "updatedAt": max(fetched_times) if fetched_times else time.time(),
            "providers": providers,
        }

    def _sync_auth_status(self, _params: Any) -> Dict[str, Any]:
        from hermes_cli.auth import read_credential_pool

        try:
            pool = read_credential_pool()
        except Exception:  # noqa: BLE001
            pool = {}
        providers: List[Dict[str, Any]] = []
        if isinstance(pool, dict):
            for provider in sorted(pool):
                entries = pool.get(provider)
                if not isinstance(entries, list) or not entries:
                    continue
                profiles = []
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    # PROTOCOL.md "Gateway read lane": pooled api-key entries
                    # ARE rotation members; OcuClaw consumes pool size via
                    # oauth|token profile rows, so api_key shapes as token.
                    auth_type = str(entry.get("auth_type") or "")
                    profiles.append(
                        {"type": "oauth" if auth_type == "oauth" else "token"}
                    )
                if profiles:
                    providers.append({"provider": str(provider), "profiles": profiles})
        return {"providers": providers}

    def _sync_agent_identity(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        profile = profile_for_namespace(p.get("ns", self._namespace))
        # #2940: ``ns`` arrives off the wire, so without this gate any direct
        # RPC could name an un-enrolled profile and read back its SOUL-declared
        # display name -- and, because an unknown name echoes back as itself,
        # use the call to enumerate which profiles exist on the host. The
        # sibling reader of this same file (_sync_profiles_soul) is gated the
        # same way. This lane degrades rather than raising: the default agent's
        # own identity call must keep working on a host whose route table is
        # still resolving.
        if profile not in self._routable_profiles()[1]:
            return {"agentId": profile, "name": profile}
        soul_name: Optional[str] = None
        try:
            from hermes_cli.profiles import get_profile_dir

            soul_path = Path(get_profile_dir(profile)) / "SOUL.md"
            if soul_path.is_file():
                soul_name = parse_soul_name(soul_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            soul_name = None
        name = soul_name or ("Hermes" if profile == DEFAULT_PROFILE else profile)
        return {"agentId": profile, "name": name}

    def _profile_extra_emoji(self, profile: Any) -> Optional[str]:
        """``platforms.<platform>.extra.emoji`` from THIS profile's own config.

        Hermes has no emoji or avatar field of its own; OcuClaw owns the value
        and stores it under the profile's ``config.yaml`` (SPEC R19).

        The read MUST be per-profile. ``load_config()`` resolves the ACTIVE
        profile's home, so using it here would stamp the default profile's
        emoji onto every multiplexed row. Read the served profile's own file
        through the same raw primitive hermes uses for its multi-profile
        model/provider display read.
        """
        home = _profile_home(profile)
        if home is None:
            return None
        try:
            config_path = home / "config.yaml"
            if not config_path.is_file():
                return None
            from hermes_cli.config import cfg_get, read_user_config_raw

            cfg = read_user_config_raw(config_path)
            if not isinstance(cfg, dict):
                return None
            return _clean_str(
                cfg_get(cfg, "platforms", self._platform_name, "extra", "emoji")
            )
        except Exception:  # noqa: BLE001 - unreadable/blank config is "no emoji"
            return None

    def _sync_profiles_list(self, _params: Any) -> Dict[str, Any]:
        from hermes_cli.profiles import list_profiles

        multiplex, routable_profiles = self._routable_profiles()
        rows = []
        for profile in list_profiles():
            profile_name = str(getattr(profile, "name"))
            if profile_name not in routable_profiles:
                continue
            row = {
                "name": profile_name,
                "isDefault": bool(getattr(profile, "is_default")),
            }
            display_name = _clean_str(getattr(profile, "display_name", None))
            if display_name:
                row["displayName"] = display_name
            model = getattr(profile, "model", None)
            if model:
                row["model"] = model
            provider = getattr(profile, "provider", None)
            if provider:
                row["provider"] = provider
            description = getattr(profile, "description", None)
            if description:
                row["description"] = description
            emoji = self._profile_extra_emoji(profile)
            if emoji:
                row["emoji"] = emoji
            rows.append(row)
        adopt_supported = False
        if self._adopt_supported_provider is not None:
            try:
                adopt_supported = bool(self._adopt_supported_provider())
            except Exception:  # noqa: BLE001 - capability discovery fails closed
                adopt_supported = False
        return {
            "profiles": rows,
            "defaultProfile": DEFAULT_PROFILE,
            "createSupported": multiplex,
            "setupSupported": multiplex,
            "settingsSupported": True,
            "adoptSupported": adopt_supported,
            "desktopFleet": desktop_fleet.read(),
        }

    def _read_routing_provider(self) -> Tuple[bool, Dict[str, Path]]:
        """The provider's answer, validated. ``(False, {})`` proves nothing.

        A multiplex route table without the default namespace is not one this
        bundle can act on — the default profile owns transport — so it is
        treated as an unproven read rather than as "no secondary profiles".
        """
        provider = self._routing_provider
        if provider is None:
            return False, {}
        try:
            enabled, homes = provider()
        except Exception:  # noqa: BLE001 - capability discovery fails closed
            return False, {}
        if (
            bool(enabled)
            and isinstance(homes, dict)
            and DEFAULT_NAMESPACE in homes
        ):
            return True, dict(homes)
        return False, {}

    def _routing_snapshot(self) -> Tuple[bool, Dict[str, Path]]:
        """The multiplex routes this gateway serves RIGHT NOW (#2942)."""
        enabled, homes = self._read_routing_provider()
        if enabled:
            return True, homes
        return self._boot_multiplex, dict(self._boot_profile_homes)

    @property
    def _multiplex_enabled(self) -> bool:
        return self._routing_snapshot()[0]

    @property
    def _served_profile_homes(self) -> Dict[str, Path]:
        """Live served homes. A property so every existing reader — including
        ``restart_rpc`` and ``management_profiles`` — tracks the live set
        without each holding its own stale copy."""
        return self._routing_snapshot()[1]

    def _sync_profiles_create(self, params: Any) -> Dict[str, Any]:
        p = dict(params) if isinstance(params, dict) else {}
        if p.get("setup") is None:
            p["setup"] = {}
            p.setdefault("requestId", "legacy:" + str(p.get("name", "")).strip().lower())
        with self._create_lock:
            return self._create_profile_with_setup(p)

    def _create_profile_with_setup(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Configure only the profile owned by this creation receipt.

        Native profile creation is irreversible within this flow. A durable receipt
        lets reconnect/restart retries apply missing settings without another create.
        No process-global HERMES_HOME change and no writes to another profile.
        """
        # ONE routing read for the whole creation. The routes are live now
        # (#2942), so re-reading between the bootstrap and the activation below
        # could hand this method two different answers — including an empty one
        # from a read that proved nothing, which would be a bare KeyError in
        # the middle of an irreversible native create.
        multiplex, served_homes = self._routing_snapshot()
        default_home = served_homes.get(DEFAULT_NAMESPACE)
        if not multiplex or default_home is None:
            raise RuntimeError("Hermes profile creation requires gateway multiplexing")
        from hermes_cli.profiles import get_profile_dir, normalize_profile_name, validate_profile_name
        # Imported here, not where it is used: the setup body now runs inside a
        # try that turns failures into `status: "partial"`, and an unimportable
        # yaml must still raise BEFORE the irreversible native create, as it did
        # when this import sat at the top of this method.
        import yaml  # noqa: F401 - import-time check; the writer re-imports it

        setup = params["setup"]
        fields, folder, blocked = _validated_setup(setup)
        request_id = params.get("requestId")
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 120:
            raise ValueError("Missing or invalid setup request id")
        raw_name = _clean_str(params.get("name"))
        if not raw_name:
            raise ValueError("profile name is required")
        canon = normalize_profile_name(raw_name)
        validate_profile_name(canon)
        if canon == "default":
            raise ValueError("Choose a name other than default")
        profile_dir = Path(get_profile_dir(canon))
        receipt_path = profile_dir / CREATE_RECEIPT_FILENAME
        fingerprint = _setup_fingerprint(setup)
        # The setup rides in the receipt so a later retry needs nothing but the
        # profile's name. The wearer's create popup is gone by then (#2940's
        # Agents list is the only place the row still exists), and asking the
        # phone to resend a draft it no longer has is how the gap arose.
        #
        # It carries the wearer's instructions, so it is no more exposed than the
        # SOUL.md beside it: `write_private` lands 0600 in the profile's own
        # directory, and nothing reads the receipt back off this host.
        receipt = {"requestId": request_id, "fingerprint": fingerprint, RECEIPT_SETUP_KEY: setup}
        # Resolved once, so every exit from this call agrees about whether the
        # wearer must restart Hermes to use the agent they just made.
        restart_required = self._restart_required_to_activate()
        if profile_dir.exists():
            try:
                old = json.loads(receipt_path.read_text())
            except (OSError, ValueError):
                raise ValueError("Profile already exists. Check the profile list before creating another.")
            if old.get("requestId") != request_id or old.get("fingerprint") != fingerprint:
                raise ValueError("Profile already exists and belongs to another creation request")
            if old.get("complete"):
                return {"status": "created", "profile": {"id": canon, "name": canon}, "restartRequired": restart_required}
        else:
            self._create_fresh_profile({"name": raw_name})
            # Failure here leaves an existing profile, which fails closed above.
            write_private(receipt_path, json.dumps(receipt))
        result = {"status": "created", "profile": {"id": canon, "name": canon}, "restartRequired": restart_required}
        try:
            self._run_receipt_setup(
                default_home=default_home,
                profile_dir=profile_dir,
                canon=canon,
                receipt_path=receipt_path,
                receipt=receipt,
                fields=fields,
                folder=folder,
                blocked=blocked,
            )
        except Exception:
            result.update(status="partial", errorMessage="Profile created, but setup or activation could not finish. Retry setup on this same profile before restarting.")
        return result

    def _run_receipt_setup(
        self,
        *,
        default_home: Path,
        profile_dir: Path,
        canon: str,
        receipt_path: Path,
        receipt: Dict[str, Any],
        fields: Dict[str, str],
        folder: str,
        blocked: List[str],
    ) -> None:
        """Apply the half of creation this receipt owns, then stamp it complete.

        Idempotent by construction — every step is a whole-value write of a
        setting this receipt already declared — which is what lets
        :meth:`retry_incomplete_setup` replay it over a profile the first
        attempt left half-built. Raises on any failure; the caller decides what
        a failure means to its wearer.
        """
        import yaml

        bootstrap_profile(default_home, profile_dir)
        if fields["instructions"]:
            soul = profile_dir / "SOUL.md"
            tmp = profile_dir / ".ocuclaw-soul.tmp"
            tmp.write_text(fields["instructions"], encoding="utf-8")
            os.replace(tmp, soul)
        if fields["model"] or folder or blocked:
            config_path = profile_dir / "config.yaml"
            cfg = yaml.safe_load(config_path.read_text()) if config_path.exists() else {}
            if cfg is None:
                cfg = {}
            if not isinstance(cfg, dict):
                raise ValueError("Invalid profile config")
            if fields["model"]:
                model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
                if fields["provider"] != model_cfg.get("provider"):
                    # A different provider must not inherit the old endpoint/key.
                    model_cfg = {}
                cfg["model"] = {**model_cfg, "default": fields["model"], "provider": fields["provider"]}
            if folder:
                cfg["terminal"] = {**(cfg.get("terminal") or {}), "cwd": folder}
            if blocked:
                agent = cfg.get("agent") or {}
                groups = {"web": "web", "files": "file", "terminal": "terminal"}
                agent["disabled_toolsets"] = sorted(set(agent.get("disabled_toolsets") or []) | {groups[x] for x in blocked})
                cfg["agent"] = agent
            tmp = profile_dir / ".ocuclaw-config.tmp"
            tmp.write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")
            tmp.chmod(0o600)
            os.replace(tmp, config_path)
        # Enrolment BEFORE the completion stamp, deliberately. The stamp is
        # what makes a retry short-circuit ("if old.get('complete'): return
        # created" in the creation path), so stamping first would turn a failed
        # enrol into a permanently un-enrolled agent whose retry reports
        # success. R5's promise -- not reachable until setup completes -- is
        # kept by `creation_is_incomplete`, which gates routing independently
        # of the set, so the window this order opens is cosmetic: an enrolled
        # agent whose receipt never completed shows as "setup incomplete", and
        # agents_view keeps it removable so it is never a dead end.
        #
        # #2940 follow-up: swapping these two strands agents, and the retry
        # lane below relies on the same order -- it is the incomplete stamp
        # that keeps the row retryable when the enrol is what failed.
        admit_profile(default_home, canon)
        write_private(receipt_path, json.dumps({**receipt, "complete": True}))

    def retry_incomplete_setup(self, name: Any, *, home: Optional[Path] = None) -> Dict[str, Any]:
        """Finish a profile whose creation receipt never completed (#2940).

        The caller names a profile and nothing else. Everything the rerun needs
        — the owning request id, the fingerprint, the setup itself — is read
        back from that profile's own receipt, which is the whole point: the
        create popup that held the draft is long gone by the time the Agents
        list offers Retry, and a caller-supplied request id would be a way to
        talk over a creation that is still running.

        The existing "belongs to another creation request" guard is therefore
        untouched and, if anything, tighter here:

        * a **complete** receipt is refused outright — this lane only ever
          finishes something unfinished, it never re-applies settled setup;
        * an **in-flight** creation holds :data:`PROFILE_MUTATION_LOCK` for its
          whole irreversible body, so a retry that cannot take that lock within
          :data:`RETRY_LOCK_TIMEOUT_S` reports ``creation_in_flight`` rather
          than racing it (one process; a second gateway on the same home is out
          of this bundle's reach either way);
        * a receipt whose stored setup does not hash to its own fingerprint is
          **foreign** — a half-written or hand-edited record this bundle will
          not speak for — and is refused rather than replayed.

        Enrollment order is exactly #2940's: :func:`admit_profile` then the
        completion stamp, inside :meth:`_run_receipt_setup`. A failed retry
        leaves the receipt incomplete, so the row stays "setup incomplete" and
        stays retryable; it is never a dead end.

        Returns the same ``{status, profile, restartRequired}`` shape as a
        creation. Raises :class:`IncompleteRetryRefused` with a typed code and
        one wearer-safe sentence; no native error text ever escapes.
        """
        from hermes_cli.profiles import get_profile_dir, normalize_profile_name, validate_profile_name

        raw_name = _clean_str(name)
        if not raw_name:
            raise IncompleteRetryRefused("invalid_request", "That is not a valid agent name.")
        try:
            canon = normalize_profile_name(raw_name)
            validate_profile_name(canon)
        except Exception:  # noqa: BLE001 - a name the engine rejects is not a target
            raise IncompleteRetryRefused("invalid_request", "That is not a valid agent name.")
        if canon == DEFAULT_PROFILE:
            # The default profile carries the pairing and has no creation
            # receipt; a "retry" there could only mean rewriting the host's own
            # agent from a record that does not exist.
            raise IncompleteRetryRefused("invalid_request", "The default agent is not set up by OcuClaw.")

        if not self._create_lock.acquire(timeout=RETRY_LOCK_TIMEOUT_S):
            raise IncompleteRetryRefused(
                "creation_in_flight",
                "This agent is being set up right now. Wait a moment, then try again.",
            )
        try:
            multiplex, served_homes = self._routing_snapshot()
            default_home = served_homes.get(DEFAULT_NAMESPACE)
            if not multiplex or default_home is None:
                raise IncompleteRetryRefused(
                    "multiplex_required",
                    "Hermes is not serving multiple agents right now. Restart Hermes, then try again.",
                )
            # The home the caller read the `incomplete` flag out of, when it has
            # one. The flag comes from `creation_is_incomplete(homes[name])` where
            # `homes` is upstream's `profiles_to_serve()` answer, so reading and
            # stamping the receipt anywhere else would be a second premise in a
            # design whose whole point is "replay that profile's OWN receipt".
            profile_dir = Path(home) if home is not None else Path(get_profile_dir(canon))
            if not profile_dir.is_dir():
                raise IncompleteRetryRefused(
                    "profile_missing",
                    "This agent no longer exists on this host. Create it again.",
                )
            receipt_path = profile_dir / CREATE_RECEIPT_FILENAME
            try:
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, ValueError):
                receipt = None
            if not isinstance(receipt, dict):
                # No readable receipt means OcuClaw never owned this creation —
                # the wearer made the profile in Hermes — so there is no setup
                # to finish and nothing here may invent one.
                raise IncompleteRetryRefused(
                    "receipt_unreadable",
                    "OcuClaw has no setup record for this agent, so it cannot finish it. Create it again under a new name.",
                )
            if receipt.get("complete"):
                raise IncompleteRetryRefused(
                    "already_complete",
                    "This agent's setup already finished. Refresh the agent list.",
                )
            request_id = receipt.get("requestId")
            if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 120:
                raise IncompleteRetryRefused(
                    "receipt_foreign",
                    "This agent's setup record does not name the request that made it. Create it again under a new name.",
                )
            setup = receipt.get(RECEIPT_SETUP_KEY)
            if not isinstance(setup, dict):
                # Receipts written before this change kept only the hash of the
                # setup, which cannot be turned back into settings. Saying so is
                # better than completing the agent WITHOUT the instructions and
                # model the wearer asked for.
                raise IncompleteRetryRefused(
                    "setup_unrecoverable",
                    "This agent was started by an older OcuClaw that did not keep its setup, so it cannot be finished. Create it again under a new name.",
                )
            if _setup_fingerprint(setup) != receipt.get("fingerprint"):
                raise IncompleteRetryRefused(
                    "receipt_foreign",
                    "This agent's setup record belongs to another creation request. Create it again under a new name.",
                )
            try:
                fields, folder, blocked = _validated_setup(setup)
            except ValueError:
                # Authored here, not forwarded. `_validated_setup` speaks to the
                # create lane's own caller in its words ("Invalid tool blocks"),
                # which is not a sentence to hand a wearer looking at a row.
                raise IncompleteRetryRefused(
                    "setup_rejected",
                    "This agent's saved setup is no longer valid. Create it again under a new name.",
                )

            try:
                self._run_receipt_setup(
                    default_home=default_home,
                    profile_dir=profile_dir,
                    canon=canon,
                    receipt_path=receipt_path,
                    receipt=dict(receipt),
                    fields=fields,
                    folder=folder,
                    blocked=blocked,
                )
            except Exception:  # noqa: BLE001 - native detail never reaches the wearer
                raise IncompleteRetryRefused(
                    "setup_failed",
                    "Setup could not finish. Check that Hermes is running, then try again.",
                )
            # No `restartRequired`: this profile is already in the gateway's served
            # set -- that is how its row exists to be retried -- so there is nothing
            # for a restart to activate, on either supported engine.
            return {"status": "finished", "profile": {"id": canon, "name": canon}}
        finally:
            self._create_lock.release()

    def _create_fresh_profile(self, params: Any) -> Dict[str, Any]:
        """Create one native Hermes profile.

        A new profile still cannot leak into ``gw.profiles.list``, but since
        #2940 that is because nothing enrols a profile by creating it — the
        enrollment set does, after the receipt-owned setup completes — and not,
        as it was before #2942, because the routes were frozen at adapter boot.

        Whether the wearer must restart Hermes for it to become routable is the
        engine's business: 0.21.3 reconciles its served set live, older engines
        publish theirs once at gateway start. See
        :meth:`_restart_required_to_activate`.
        """
        if not self._routing_snapshot()[0]:
            raise RuntimeError(
                "Hermes profile creation requires gateway multiplexing"
            )
        p = params if isinstance(params, dict) else {}
        raw_name = _clean_str(p.get("name"))
        if not raw_name:
            raise ValueError("profile name is required")

        from hermes_cli.profiles import (
            check_alias_collision,
            create_profile,
            create_wrapper_script,
            normalize_profile_name,
            seed_profile_skills,
            validate_profile_name,
        )

        canon = normalize_profile_name(raw_name)
        validate_profile_name(canon)
        profile_dir = create_profile(name=canon)

        # Match `hermes profile create`: fresh profiles receive the bundled
        # skills, and a shell alias is created only when it does not collide.
        # Both helpers are best-effort in Hermes's own CLI; profile creation is
        # already complete if either returns no result.
        seed_profile_skills(profile_dir, quiet=True)
        if not check_alias_collision(canon):
            create_wrapper_script(canon)

        return {
            "status": "created",
            "profile": {"id": canon, "name": canon},
            "restartRequired": self._restart_required_to_activate(),
        }

    def _sync_profiles_emoji_set(self, params: Any) -> Dict[str, Any]:
        """Set or clear OcuClaw's emoji in one routable profile's own config."""
        p = params if isinstance(params, dict) else {}
        profile_id = _clean_str(p.get("profileId"))
        if not profile_id:
            raise ValueError("profile id is required")
        emoji_value = p.get("emoji")
        if emoji_value is not None and not isinstance(emoji_value, str):
            raise ValueError("emoji must be a string or null")
        emoji = _clean_str(emoji_value)
        if emoji is not None and len(emoji) > 16:
            raise ValueError("emoji is too long")

        from hermes_cli.profiles import list_profiles

        if profile_id not in self._routable_profiles()[1]:
            raise ValueError("profile is not served by this gateway")
        profile = next(
            (row for row in list_profiles() if str(getattr(row, "name")) == profile_id),
            None,
        )
        if profile is None:
            raise ValueError("profile does not exist")
        home = _profile_home(profile)
        if home is None:
            raise RuntimeError("profile configuration could not be resolved")

        from hermes_cli.config import atomic_config_write, read_user_config_raw

        config_path = home / "config.yaml"
        raw_cfg = read_user_config_raw(config_path) if config_path.exists() else {}
        if not isinstance(raw_cfg, dict):
            raise RuntimeError("profile configuration is not an object")
        platforms = raw_cfg.setdefault("platforms", {})
        if not isinstance(platforms, dict):
            raise RuntimeError("profile platforms configuration is not an object")
        platform_cfg = platforms.setdefault(self._platform_name, {})
        if not isinstance(platform_cfg, dict):
            raise RuntimeError("OcuClaw platform configuration is not an object")
        extra = platform_cfg.setdefault("extra", {})
        if not isinstance(extra, dict):
            raise RuntimeError("OcuClaw extra configuration is not an object")

        if emoji is None:
            extra.pop("emoji", None)
            if not extra:
                platform_cfg.pop("extra", None)
            if not platform_cfg:
                platforms.pop(self._platform_name, None)
            if not platforms:
                raw_cfg.pop("platforms", None)
        else:
            extra["emoji"] = emoji

        atomic_config_write(config_path, raw_cfg, sort_keys=False)
        return {
            "status": "updated",
            "profile": {"id": profile_id, "name": profile_id},
            "emoji": emoji,
        }

    def _restart_required_to_activate(self) -> bool:
        """Must the wearer restart Hermes before a new agent works?

        Probed, never inferred from a version string: the question is whether
        the running engine re-publishes its served set while it runs
        (``gateway.run_profile_reconcile``, #2942's ``hot_reconcile``).

        * **0.21.3** reconciles live — a profile created from the glasses
          becomes routable within about half a minute, with no restart. #2942's
          sim leg measured 15-22 s and zero restarts.
        * **0.21.0-0.21.2** write the served record once at gateway start, so
          the boot snapshot really is the answer until the gateway restarts.

        Telling a 0.21.3 wearer to restart for nothing is not a harmless extra
        step: it teaches them to restart the gateway whenever something seems
        missing, which is the opposite of what the live reconcile bought them.
        Fails CLOSED — an unprobeable engine is treated as the older one, so
        the wearer is told to restart rather than left waiting for a
        reconcile that will never come.
        """
        try:
            from .profile_routes import RESOLVER

            return not RESOLVER.capabilities().hot_reconcile
        except Exception:  # noqa: BLE001 - unprobeable means "older engine"
            return True

    def _routable_profiles(self) -> Tuple[bool, Set[str]]:
        """``(multiplex, profile names)`` this gateway may act on for the wearer.

        Since #2940 the routing snapshot is already bounded by OcuClaw's
        enrollment set, so the names are "served AND enrolled" — resolved in
        one place, so a new profile-taking RPC cannot quietly get a wider
        answer than the menu shows.
        """
        multiplex, served_homes = self._routing_snapshot()
        routable = {DEFAULT_PROFILE}
        if multiplex:
            routable.update(
                profile_for_namespace(namespace) for namespace in served_homes
            )
        return bool(multiplex), routable

    def _settings_profile(self, profile_id: str) -> Tuple[Any, Path]:
        """Resolve one profile only when this gateway can route it."""
        from hermes_cli.profiles import list_profiles

        if profile_id not in self._routable_profiles()[1]:
            raise ValueError("profile is not served by this gateway")
        profile = next(
            (row for row in list_profiles() if str(getattr(row, "name")) == profile_id),
            None,
        )
        if profile is None:
            raise ValueError("profile does not exist")
        home = _profile_home(profile)
        if home is None:
            raise RuntimeError("profile configuration could not be resolved")
        return profile, home

    def _sync_profiles_settings_get(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        profile_id = _clean_str(p.get("profileId"))
        if not profile_id:
            raise ValueError("profile id is required")
        _, home = self._settings_profile(profile_id)
        from .tools_management import settings_tools_context
        with settings_tools_context(home):
            return self._sync_profiles_settings_get_locked(params)

    def _sync_profiles_settings_get_locked(self, params: Any) -> Dict[str, Any]:
        """Read the durable settings for one served Hermes profile."""
        p = params if isinstance(params, dict) else {}
        profile_id = _clean_str(p.get("profileId"))
        if not profile_id:
            raise ValueError("profile id is required")
        profile, home = self._settings_profile(profile_id)

        from hermes_cli.config import cfg_get, read_user_config_raw

        config_path = home / "config.yaml"
        cfg = read_user_config_raw(config_path) if config_path.exists() else {}
        if not isinstance(cfg, dict):
            raise RuntimeError("profile configuration is not an object")

        soul_path = home / "SOUL.md"
        instructions = soul_path.read_text(encoding="utf-8") if soul_path.is_file() else ""
        model = _clean_str(cfg_get(cfg, "model", "default")) or ""
        provider = _clean_str(cfg_get(cfg, "model", "provider")) or ""
        workspace = _clean_str(cfg_get(cfg, "terminal", "cwd")) or ""
        disabled = cfg_get(cfg, "agent", "disabled_toolsets")
        disabled_set = {
            str(value).strip()
            for value in disabled
            if str(value).strip()
        } if isinstance(disabled, list) else set()
        groups = {"web": "web", "files": "file", "terminal": "terminal"}
        blocked = [key for key, value in groups.items() if value in disabled_set]
        from .tools_management import settings_tools_context
        with settings_tools_context(home) as tx:
            block_revision, block_writable = "", True
            if tx:
                from hermes_cli import config as native_config
                leaf = tx.read_config_leaves(["agent.disabled_toolsets"])["agent.disabled_toolsets"]
                effective = cfg_get(native_config.load_config_readonly(), "agent", "disabled_toolsets") or []
                if not isinstance(effective, list) or any(not isinstance(value, str) for value in effective):
                    raise ValueError("Unsupported native tool block list")
                blocked = [key for key, value in groups.items() if value in effective]
                block_revision = leaf["revision"]
                block_writable = not leaf["managed"] and (leaf.get("value") or []) == effective
        display_name = _clean_str(getattr(profile, "display_name", None)) or profile_id
        return {
            "status": "loaded",
            "backend": "hermes",
            "agentId": profile_id,
            "name": display_name,
            "emoji": self._profile_extra_emoji(profile),
            "setup": {
                "instructions": instructions,
                "model": model,
                "provider": provider,
                "workspace": workspace,
                "blockedTools": blocked,
                **({"blockedToolsRevision": block_revision} if block_revision else {}),
                **({"blockedToolsWritable": False} if not block_writable else {}),
            },
        }

    def _sync_profiles_settings_set(self, params: Any) -> Dict[str, Any]:
        """Reject stale tool forms before any profile file is changed."""
        p = params if isinstance(params, dict) else {}
        profile_id = _clean_str(p.get("profileId"))
        if not profile_id:
            raise ValueError("profile id is required")
        _, home = self._settings_profile(profile_id)
        from .tools_management import settings_tools_context
        with settings_tools_context(home) as tx:
            from .tools_management import validate_intent
            validate_intent(p)
            write_blocks = True
            if tx is None and isinstance(p.get("setup"), dict) and p["setup"].get("blockedToolsRevision"):
                raise ValueError("Native tool transaction support changed. Reload before saving this draft.")
            if tx:
                revision = (p.get("setup") or {}).get("blockedToolsRevision") if isinstance(p.get("setup"), dict) else None
                current = tx.read_config_leaves(["agent.disabled_toolsets"])["agent.disabled_toolsets"]
                if not isinstance(revision, str) or revision != current["revision"]:
                    raise ValueError("Tool blocks changed elsewhere. Your draft is preserved; reload and review before saving.")
                if current["managed"]:
                    from hermes_cli import config as native_config
                    if native_config.is_managed():
                        raise ValueError("Profile settings are managed. Your draft has not been saved.")
                    effective = native_config.cfg_get(native_config.load_config_readonly(), "agent", "disabled_toolsets") or []
                    groups = {"web": "web", "files": "file", "terminal": "terminal"}
                    expected_blocks = {key for key, value in groups.items() if value in effective}
                    if set((p.get("setup") or {}).get("blockedTools") or []) != expected_blocks:
                        raise ValueError("Profile tool blocks are managed. Your draft has not been saved.")
                    write_blocks = False
            return self._sync_profiles_settings_set_locked(params, write_blocks=write_blocks)

    def _sync_profiles_settings_set_locked(self, params: Any, *, write_blocks: bool = True) -> Dict[str, Any]:
        """Atomically replace OcuClaw-owned settings for one served profile."""
        p = params if isinstance(params, dict) else {}
        profile_id = _clean_str(p.get("profileId"))
        if not profile_id:
            raise ValueError("profile id is required")
        setup = p.get("setup")
        if not isinstance(setup, dict) or set(setup) - {"instructions", "model", "provider", "workspace", "blockedTools", "blockedToolsRevision", "blockedToolsWritable"}:
            raise ValueError("Invalid agent setup")
        if "blockedToolsWritable" in setup and type(setup["blockedToolsWritable"]) is not bool:
            raise ValueError("Invalid tool block metadata")
        fields: Dict[str, str] = {}
        for key, limit in (("instructions", 8000), ("model", 200), ("provider", 100), ("workspace", 500)):
            value = setup.get(key, "")
            if not isinstance(value, str) or len(value) > limit or "\0" in value:
                raise ValueError(f"Invalid {key}")
            fields[key] = value.strip()
        if bool(fields["model"]) != bool(fields["provider"]):
            raise ValueError("Choose a model and its provider")
        folder = fields["workspace"]
        if folder and (not (folder.startswith("/") or folder.startswith("~/")) or "\n" in folder or "\r" in folder):
            raise ValueError("Use an absolute folder path or ~/")
        blocked = setup.get("blockedTools", [])
        if not isinstance(blocked, list) or len(blocked) > 3 or any(x not in ("web", "files", "terminal") for x in blocked):
            raise ValueError("Invalid tool blocks")
        raw_emoji = p.get("emoji")
        if raw_emoji is not None and not isinstance(raw_emoji, str):
            raise ValueError("emoji must be a string or null")
        emoji = _clean_str(raw_emoji)
        if emoji is not None and len(emoji) > 16:
            raise ValueError("emoji is too long")

        _profile, home = self._settings_profile(profile_id)
        import yaml
        from hermes_cli.config import atomic_config_write, read_user_config_raw

        config_path = home / "config.yaml"
        cfg = read_user_config_raw(config_path) if config_path.exists() else {}
        if not isinstance(cfg, dict):
            raise RuntimeError("profile configuration is not an object")

        # The beta can preserve a host-configured folder but cannot promise
        # profile-specific execution on stable Hermes. UI keeps this read-only.
        current_terminal = cfg.get("terminal")
        current_folder = _clean_str(current_terminal.get("cwd")) if isinstance(current_terminal, dict) else None
        if folder != (current_folder or ""):
            raise ValueError(WORKSPACE_UNSUPPORTED)

        model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
        if fields["model"]:
            if fields["provider"] != model_cfg.get("provider"):
                model_cfg = {}
            model_cfg.update(default=fields["model"], provider=fields["provider"])
            cfg["model"] = model_cfg
        elif model_cfg:
            model_cfg.pop("default", None)
            model_cfg.pop("provider", None)
            if model_cfg:
                cfg["model"] = model_cfg
            else:
                cfg.pop("model", None)

        terminal_cfg = cfg.get("terminal") if isinstance(cfg.get("terminal"), dict) else {}
        if folder:
            terminal_cfg["cwd"] = folder
            cfg["terminal"] = terminal_cfg
        else:
            terminal_cfg.pop("cwd", None)
            if terminal_cfg:
                cfg["terminal"] = terminal_cfg
            else:
                cfg.pop("terminal", None)

        if write_blocks:
            agent_cfg = cfg.get("agent") if isinstance(cfg.get("agent"), dict) else {}
            old_disabled = agent_cfg.get("disabled_toolsets")
            preserved = {
                str(value) for value in old_disabled
                if str(value) not in {"web", "file", "terminal"}
            } if isinstance(old_disabled, list) else set()
            groups = {"web": "web", "files": "file", "terminal": "terminal"}
            next_disabled = sorted(preserved | {groups[key] for key in blocked})
            if next_disabled:
                agent_cfg["disabled_toolsets"] = next_disabled
                cfg["agent"] = agent_cfg
            else:
                agent_cfg.pop("disabled_toolsets", None)
                if agent_cfg:
                    cfg["agent"] = agent_cfg
                else:
                    cfg.pop("agent", None)

        platforms = cfg.setdefault("platforms", {})
        if not isinstance(platforms, dict):
            raise RuntimeError("profile platforms configuration is not an object")
        platform_cfg = platforms.setdefault(self._platform_name, {})
        if not isinstance(platform_cfg, dict):
            raise RuntimeError("OcuClaw platform configuration is not an object")
        extra = platform_cfg.setdefault("extra", {})
        if not isinstance(extra, dict):
            raise RuntimeError("OcuClaw extra configuration is not an object")
        if emoji is None:
            extra.pop("emoji", None)
            if not extra:
                platform_cfg.pop("extra", None)
            if not platform_cfg:
                platforms.pop(self._platform_name, None)
            if not platforms:
                cfg.pop("platforms", None)
        else:
            extra["emoji"] = emoji

        soul_tmp = home / ".ocuclaw-soul.tmp"
        from .tools_management import validate_intent
        validate_intent(p)
        soul_tmp.write_text(fields["instructions"], encoding="utf-8")
        os.replace(soul_tmp, home / "SOUL.md")
        try:
            atomic_config_write(config_path, cfg, sort_keys=False)
        except Exception as exc:
            raise RuntimeError(
                "Instructions were saved, but the other settings were not. Reload before trying again."
            ) from exc
        return {
            **self._sync_profiles_settings_get({"profileId": profile_id}),
            "status": "updated",
            "restartRequired": False,
        }

    def _sync_profiles_soul(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        profile = profile_for_namespace(p.get("profile", self._namespace))
        # #2940: SOUL.md is the agent's own instructions — profile content, and
        # before this gate any direct RPC could read it for a profile the
        # wearer had never enrolled, simply by naming it. Hiding the menu row
        # was never enough.
        if profile not in self._routable_profiles()[1]:
            raise ValueError("profile is not served by this gateway")
        try:
            from hermes_cli.profiles import get_profile_dir

            profile_dir = Path(get_profile_dir(profile))
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"no such profile: {profile}") from exc
        if not profile_dir.exists():
            raise ValueError(f"no such profile: {profile}")
        soul_path = profile_dir / "SOUL.md"
        if not soul_path.is_file():
            return {"content": ""}
        return {"content": soul_path.read_text(encoding="utf-8")}

    def _sync_skills_status(self, _params: Any) -> Dict[str, Any]:
        from agent.skill_commands import get_skill_commands
        from hermes_cli.config import cfg_get

        cfg = self._load_config()
        raw_disabled = cfg_get(
            cfg, "skills", "platform_disabled", self._platform_name
        )
        disabled = {
            str(name).strip().lower()
            for name in raw_disabled
            if str(name).strip()
        } if isinstance(raw_disabled, Iterable) and not isinstance(
            raw_disabled, (str, bytes, dict)
        ) else set()

        rows = []
        for slug, info in sorted(get_skill_commands().items()):
            entry = info if isinstance(info, dict) else {}
            name = _clean_str(entry.get("name")) or str(slug).lstrip("/")
            if name.lower() in disabled:
                continue
            rows.append(
                {
                    "name": name,
                    "description": str(entry.get("description") or ""),
                }
            )
        return {"skills": rows}

    def _sync_commands_list(self, _params: Any) -> Dict[str, Any]:
        """Gateway-available slash commands, pre-slugified.

        The predicate is hermes's OWN gateway lens —
        ``_is_gateway_available(cmd, _resolve_config_gates())`` — not the TUI's
        ``commands.catalog`` filter, which drops ``gateway_only`` commands
        because it serves the CLI. The phone IS a gateway surface, so
        ``gateway_only`` rows (/pause, /approve, /deny, /commands, /restart,
        /platform, /sethome) are exactly the ones we can run. ``busy_policy``
        is carried as display state and never filters: filtering on it would
        make the palette flicker as turns start and end.

        Skills are NOT included — they ride ``gw.skills.status`` and merge
        client-side.
        """
        try:
            from hermes_cli.commands import (
                COMMAND_REGISTRY,
                _is_gateway_available,
                _iter_plugin_command_entries,
                _resolve_config_gates,
            )
        except Exception:  # noqa: BLE001 - older/absent hermes => empty catalog
            return {"commands": []}

        try:
            # Hoisted once per call, never per command.
            overrides = _resolve_config_gates()
        except Exception:  # noqa: BLE001 - config read failure => gates closed
            overrides = set()

        rows: List[Dict[str, Any]] = []
        seen: Set[str] = set()

        for cmd in COMMAND_REGISTRY:
            if getattr(cmd, "name", None) in _LANE_HIDDEN_COMMANDS:
                continue
            try:
                if not _is_gateway_available(cmd, overrides):
                    continue
            except Exception:  # noqa: BLE001 - a malformed row is not a lane outage
                continue
            name = _slug(getattr(cmd, "name", None))
            if not name or name in seen:
                continue
            seen.add(name)
            args_hint = str(getattr(cmd, "args_hint", "") or "").strip()
            row: Dict[str, Any] = {
                "name": name,
                "description": str(getattr(cmd, "description", "") or ""),
                "category": str(getattr(cmd, "category", "") or ""),
                "source": "builtin",
                "instantSend": args_hint == "",
                "noTrailingSpace": name in _PICKER_NO_TRAILING_SPACE,
                "busyPolicy": str(getattr(cmd, "busy_policy", "") or "reject"),
            }
            aliases = [
                alias
                for alias in (
                    _slug(raw) for raw in (getattr(cmd, "aliases", ()) or ())
                )
                if alias and alias != name
            ]
            if aliases:
                row["aliases"] = aliases
            if args_hint:
                row["argsHint"] = args_hint
            subcommands = getattr(cmd, "subcommands", ()) or ()
            if subcommands:
                row["subcommands"] = [str(sub) for sub in subcommands]
            rows.append(row)

        try:
            plugin_entries = _iter_plugin_command_entries()
        except Exception:  # noqa: BLE001 - plugin discovery is best-effort
            plugin_entries = []
        for raw_name, description, plugin_args_hint in plugin_entries or ():
            name = _slug(raw_name)
            if not name or name in seen:
                continue
            seen.add(name)
            hint = str(plugin_args_hint or "").strip()
            plugin_row: Dict[str, Any] = {
                "name": name,
                "description": str(description or ""),
                "category": "",
                "source": "plugin",
                "instantSend": hint == "",
                "noTrailingSpace": False,
                "busyPolicy": "reject",
            }
            if hint:
                plugin_row["argsHint"] = hint
            rows.append(plugin_row)

        rows.sort(key=lambda entry: entry["name"])
        return {"commands": rows}
