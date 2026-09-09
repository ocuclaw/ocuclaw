"""Gateway read-lane RPC handlers (W07 models/status/config plane).

Wire shapes are pinned in PROTOCOL.md "Gateway read lane" and
"Override lane" (identity/profile crossing). Hermes imports stay deferred so
the bundle remains importable outside a Hermes environment; handler bodies run
in a worker thread via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import inspect
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

DEFAULT_NAMESPACE = "main"
DEFAULT_PROFILE = "default"
ROUTABLE_USAGE_PROVIDERS: Tuple[str, ...] = (
    "anthropic",
    "openai-codex",
    "openrouter",
)
CODEX_SESSION_WINDOW_MAX_SECONDS = (5 * 60 * 60) + 60


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


def profile_for_namespace(ns: Any) -> str:
    """Map the W07 gw.agent.identity namespace to a Hermes profile name."""
    text = str(ns or "").strip()
    return DEFAULT_PROFILE if text in ("", DEFAULT_NAMESPACE) else text


def namespace_for_profile(profile: Any) -> str:
    """Map a Hermes profile name to the OcuClaw session namespace."""
    name = profile_for_namespace(profile)
    return DEFAULT_NAMESPACE if name == DEFAULT_PROFILE else name


def load_profile_routing_snapshot() -> Tuple[bool, Dict[str, Path]]:
    """Fail-closed snapshot of the profiles this gateway can route."""
    try:
        from gateway.config import load_gateway_config

        gateway_config = load_gateway_config()
        multiplex = bool(gateway_config.multiplex_profiles)
    except Exception:  # noqa: BLE001
        return False, {}
    if not multiplex:
        return False, {}

    try:
        from hermes_cli.profiles import profiles_to_serve

        kwargs: Dict[str, Any] = {"multiplex": True}
        if "profile_allowlist" in inspect.signature(profiles_to_serve).parameters:
            kwargs["profile_allowlist"] = getattr(
                gateway_config,
                "multiplex_profile_allowlist",
                None,
            )
        rows = profiles_to_serve(**kwargs)
        return True, {
            namespace_for_profile(name): Path(home)
            for name, home in rows
        }
    except Exception:  # noqa: BLE001
        return True, {}


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
        self._multiplex_enabled = False
        self._served_profile_homes: Dict[str, Path] = {}
        self._management_default_home: Optional[Path] = None
        try:
            from hermes_constants import get_process_hermes_home
            self._management_default_home = Path(get_process_hermes_home()).resolve()
        except (ImportError, AttributeError, OSError):
            pass
        if routing_provider is not None:
            try:
                enabled, homes = routing_provider()
                if (
                    bool(enabled)
                    and isinstance(homes, dict)
                    and DEFAULT_NAMESPACE in homes
                ):
                    self._multiplex_enabled = True
                    self._served_profile_homes = dict(homes)
            except Exception:  # noqa: BLE001 - capability discovery fails closed
                pass

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

        multiplex, served_homes = self._routing_snapshot()
        routable_profiles = {DEFAULT_PROFILE}
        if multiplex:
            routable_profiles.update(
                profile_for_namespace(namespace)
                for namespace in served_homes
            )
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

    def _routing_snapshot(self) -> Tuple[bool, Dict[str, Path]]:
        """The adapter's boot-frozen multiplex routes, or a closed gate."""
        return self._multiplex_enabled, dict(self._served_profile_homes)

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
        if not self._routing_snapshot()[0]:
            raise RuntimeError("Hermes profile creation requires gateway multiplexing")
        from hermes_cli.profiles import get_profile_dir, normalize_profile_name, validate_profile_name
        import yaml

        setup = params["setup"]
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
        receipt_path = profile_dir / ".ocuclaw-create.json"
        fingerprint = hashlib.sha256(json.dumps(setup, sort_keys=True).encode()).hexdigest()
        receipt = {"requestId": request_id, "fingerprint": fingerprint}
        if profile_dir.exists():
            try:
                old = json.loads(receipt_path.read_text())
            except (OSError, ValueError):
                raise ValueError("Profile already exists. Check the profile list before creating another.")
            if old.get("requestId") != request_id or old.get("fingerprint") != fingerprint:
                raise ValueError("Profile already exists and belongs to another creation request")
            if old.get("complete"):
                return {"status": "created", "profile": {"id": canon, "name": canon}, "restartRequired": True}
        else:
            self._create_fresh_profile({"name": raw_name})
            # Failure here leaves an existing profile, which fails closed above.
            write_private(receipt_path, json.dumps(receipt))
        result = {"status": "created", "profile": {"id": canon, "name": canon}, "restartRequired": True}
        try:
            bootstrap_profile(self._served_profile_homes[DEFAULT_NAMESPACE], profile_dir)
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
            admit_profile(self._served_profile_homes[DEFAULT_NAMESPACE], canon)
            write_private(receipt_path, json.dumps({**receipt, "complete": True}))
        except Exception:
            result.update(status="partial", errorMessage="Profile created, but setup or activation could not finish. Retry setup on this same profile before restarting.")
        return result

    def _create_fresh_profile(self, params: Any) -> Dict[str, Any]:
        """Create one native Hermes profile, pending the required restart.

        The gateway's routing snapshot is intentionally frozen at adapter boot.
        Therefore the new profile cannot leak into ``gw.profiles.list`` until
        Hermes completes its native ``/restart`` drain and reconnect cycle.
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
            "restartRequired": True,
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

        multiplex, served_homes = self._routing_snapshot()
        routable_profiles = {DEFAULT_PROFILE}
        if multiplex:
            routable_profiles.update(
                profile_for_namespace(namespace) for namespace in served_homes
            )
        if profile_id not in routable_profiles:
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

    def _settings_profile(self, profile_id: str) -> Tuple[Any, Path]:
        """Resolve one profile only when this gateway can route it."""
        from hermes_cli.profiles import list_profiles

        multiplex, served_homes = self._routing_snapshot()
        routable_profiles = {DEFAULT_PROFILE}
        if multiplex:
            routable_profiles.update(
                profile_for_namespace(namespace) for namespace in served_homes
            )
        if profile_id not in routable_profiles:
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
