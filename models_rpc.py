"""Gateway read-lane RPC handlers (W07 models/status/config plane).

Wire shapes are pinned in PROTOCOL.md "Gateway read lane" and
"Override lane" (identity/profile crossing). Hermes imports stay deferred so
the bundle remains importable outside a Hermes environment; handler bodies run
in a worker thread via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

from .overrides import parse_soul_name

GW_METHOD_MODELS_LIST = "gw.models.list"
GW_METHOD_MODELS_CONFIGURED = "gw.models.configured"
GW_METHOD_USAGE_STATUS = "gw.usage.status"
GW_METHOD_AUTH_STATUS = "gw.auth.status"
GW_METHOD_AGENT_IDENTITY = "gw.agent.identity"
GW_METHOD_PROFILES_LIST = "gw.profiles.list"
GW_METHOD_PROFILES_SOUL = "gw.profiles.soul"
GW_METHOD_SKILLS_STATUS = "gw.skills.status"

DEFAULT_NAMESPACE = "main"
DEFAULT_PROFILE = "default"
ROUTABLE_USAGE_PROVIDERS: Tuple[str, ...] = (
    "anthropic",
    "openai-codex",
    "openrouter",
)


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

        multiplex = bool(load_gateway_config().multiplex_profiles)
    except Exception:  # noqa: BLE001
        return False, {}
    if not multiplex:
        return False, {}

    try:
        from hermes_cli.profiles import profiles_to_serve

        rows = profiles_to_serve(multiplex=True)
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


class GwRpc:
    """Link RPC handlers for the W07 gateway read plane."""

    def __init__(
        self,
        namespace: str = DEFAULT_NAMESPACE,
        platform_name: str = "ocuclaw",
        routing_provider: Optional[
            Callable[[], Tuple[bool, Dict[str, Path]]]
        ] = None,
    ) -> None:
        self._namespace = namespace or DEFAULT_NAMESPACE
        self._platform_name = platform_name
        self._routing_provider = routing_provider

    def handlers(self) -> Dict[str, Callable[[Any], Any]]:
        """method -> async handler, for LinkProcess.register_request_handler."""
        return {
            GW_METHOD_MODELS_LIST: self.list_models,
            GW_METHOD_MODELS_CONFIGURED: self.configured,
            GW_METHOD_USAGE_STATUS: self.usage_status,
            GW_METHOD_AUTH_STATUS: self.auth_status,
            GW_METHOD_AGENT_IDENTITY: self.agent_identity,
            GW_METHOD_PROFILES_LIST: self.profiles_list,
            GW_METHOD_PROFILES_SOUL: self.profiles_soul,
            GW_METHOD_SKILLS_STATUS: self.skills_status,
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

    async def profiles_soul(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_soul, params)

    async def skills_status(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_skills_status, params)

    def _sync_list_models(self, _params: Any) -> Dict[str, Any]:
        try:
            from agent.models_dev import get_model_info, list_provider_models
            from hermes_cli.models import CANONICAL_PROVIDERS
        except Exception:  # noqa: BLE001
            return {"models": []}

        config = self._load_config()
        providers_cfg = config.get("providers")
        try:
            from hermes_cli.config import is_provider_enabled
        except Exception:  # noqa: BLE001 - older/absent hermes; catalog stays open
            is_provider_enabled = None

        rows: List[Dict[str, Any]] = []
        seen: Set[Tuple[str, str]] = set()
        for provider_entry in CANONICAL_PROVIDERS:
            provider = _clean_str(getattr(provider_entry, "slug", None))
            if not provider:
                continue
            if is_provider_enabled is not None:
                try:
                    block = (
                        providers_cfg.get(provider)
                        if isinstance(providers_cfg, dict)
                        else None
                    )
                    if not is_provider_enabled(block):
                        continue
                except Exception:  # noqa: BLE001 - fail open for this provider
                    pass
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
                        row["reasoning"] = bool(getattr(info, "reasoning", False))
                    provider_rows.append((key, row))
            except Exception:  # noqa: BLE001 - cold cache/offline/provider failure
                continue
            for key, row in provider_rows:
                seen.add(key)
                rows.append(row)
        return {"models": rows}

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
        from hermes_cli.config import cfg_get

        cfg = self._load_config()
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

        raw_overrides = cfg_get(
            cfg, "platforms", self._platform_name, "channel_overrides"
        )
        channel_overrides: List[Dict[str, str]] = []
        if isinstance(raw_overrides, dict):
            for entry in raw_overrides.values():
                ref = _model_ref_from_entry(entry)
                if ref is not None:
                    channel_overrides.append(ref)

        return {
            "default": default,
            "fallbacks": fallbacks,
            "channelOverrides": channel_overrides,
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
            try:
                snapshot = fetch_account_usage(provider)
            except Exception:  # noqa: BLE001
                continue
            if snapshot is None or not bool(getattr(snapshot, "available", False)):
                continue
            fetched_at = _timestamp(getattr(snapshot, "fetched_at", None))
            if fetched_at is not None:
                fetched_times.append(fetched_at)
            windows = []
            for window in getattr(snapshot, "windows", ()) or ():
                label = str(getattr(window, "label", "") or "")
                row: Dict[str, Any] = {"label": label}
                used_percent = getattr(window, "used_percent", None)
                if used_percent is not None:
                    row["usedPercent"] = float(used_percent)
                reset_at = _timestamp(getattr(window, "reset_at", None))
                if reset_at is not None:
                    row["resetAt"] = reset_at
                windows.append(row)
            provider_config = PROVIDER_REGISTRY.get(provider)
            display_name = _clean_str(getattr(provider_config, "name", None))
            providers.append(
                {
                    "provider": provider,
                    "displayName": display_name or provider.title(),
                    "windows": windows,
                }
            )
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

    def _sync_profiles_list(self, _params: Any) -> Dict[str, Any]:
        from hermes_cli.profiles import list_profiles

        multiplex = False
        served_homes: Dict[str, Path] = {}
        if self._routing_provider is not None:
            try:
                enabled, homes = self._routing_provider()
                if isinstance(homes, dict):
                    multiplex = bool(enabled)
                    served_homes = homes
            except Exception:  # noqa: BLE001
                pass
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
            model = getattr(profile, "model", None)
            if model:
                row["model"] = model
            provider = getattr(profile, "provider", None)
            if provider:
                row["provider"] = provider
            description = getattr(profile, "description", None)
            if description:
                row["description"] = description
            rows.append(row)
        return {"profiles": rows, "defaultProfile": DEFAULT_PROFILE}

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
