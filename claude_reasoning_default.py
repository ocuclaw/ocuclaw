"""Reasoning effort medium for an OcuClaw turn on Claude when nothing chose one.

Hermes asks Claude for reasoning only when an effort is set: with
``agent.reasoning_effort`` unset, its Anthropic route sends no ``thinking``
field and the claude-subscription-directsdk plugin leaves Claude Code's own
display, so a fresh wearer's status bar gets no reasoning text at all
(measured 2026-11-12: 0 headlines in 8 API-key turns; the sign-in plugin
showed "thinking..." for 11 s). With medium, both routes ask for summarized
reasoning and the bar shows live headlines. Ruled by Matt 2026-11-12.

The default applies only where nothing was chosen: a session's own
``/reasoning``, a per-model override or ``agent.reasoning_effort`` (``none``
included) all win, since each makes the native resolver return a config. It is
never written to config, and other platforms' turns are untouched.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

DEFAULT_CLAUDE_REASONING = {"enabled": True, "effort": "medium"}

# Providers whose every model is Claude: Hermes' own Anthropic route (API key
# or sign-in) and the Claude Code plugin, whose models are short aliases.
_CLAUDE_PROVIDERS = frozenset({"anthropic", "claude-subscription-directsdk-experimental"})

_INSTALLED_MARK = "_ocuclaw_claude_reasoning_default"


def is_claude_route(model: Any, provider: Any) -> bool:
    """Whether a turn's model and provider are Claude (any route that serves it)."""
    provider_text = str(provider or "").strip().lower()
    if provider_text in _CLAUDE_PROVIDERS:
        return True
    return "claude" in str(model or "").strip().lower()


def default_reasoning(resolved: Optional[dict], model: Any, provider: Any) -> Optional[dict]:
    """The reasoning config for a turn: ``resolved`` when anything chose one, else medium on Claude."""
    if resolved is not None:
        return resolved
    if not is_claude_route(model, provider):
        return None
    return dict(DEFAULT_CLAUDE_REASONING)


def _platform_name(source: Any) -> str:
    platform = getattr(source, "platform", None)
    return str(getattr(platform, "value", platform) or "").strip()


def _configured_route(runner: Any, session_key: Optional[str], load_config: Callable[[], Any]):
    """The session's chosen ``(model, provider)``, else the profile's, as far as known."""
    if session_key:
        try:
            state = runner._peek_session_state(session_key)
        except Exception:  # noqa: BLE001 - a missing peek means no session override
            state = None
        override = getattr(getattr(state, "conversation", None), "model_override", None)
        if isinstance(override, Mapping) and override.get("model"):
            return override.get("model"), override.get("provider")
    try:
        cfg = load_config()
    except Exception:  # noqa: BLE001 - unreadable config: route unknown
        cfg = None
    model_cfg = cfg.get("model") if isinstance(cfg, Mapping) else None
    if isinstance(model_cfg, Mapping):
        return model_cfg.get("default") or model_cfg.get("model"), model_cfg.get("provider")
    return model_cfg, None


def _load_gateway_config():
    from gateway.run import _load_gateway_config as load

    return load()


def install(runner: Any, platform_name: str, *, load_config: Callable[[], Any] = _load_gateway_config) -> bool:
    """Wrap ``runner._resolve_session_reasoning_config`` once; True when it is (now) wrapped."""
    original = getattr(runner, "_resolve_session_reasoning_config", None)
    if not callable(original):
        return False
    if getattr(original, _INSTALLED_MARK, False):
        return True

    def resolve(*args: Any, **kwargs: Any):
        resolved = original(*args, **kwargs)
        if resolved is not None:
            return resolved
        try:
            if _platform_name(kwargs.get("source")) != platform_name:
                return resolved
            session_key = kwargs.get("session_key")
            if not session_key:
                # As the native resolver does: `/background` and session slash
                # commands pass only the source.
                try:
                    session_key = runner._resolve_session_key_or_none(kwargs.get("source"), None)
                except Exception:  # noqa: BLE001 - no key: the profile's route decides
                    session_key = None
            model, provider = _configured_route(runner, session_key, load_config)
            # The resolver's own model argument is the turn's effective model.
            return default_reasoning(resolved, kwargs.get("model") or model, provider)
        except Exception:  # noqa: BLE001 - never fail a turn over a default
            return resolved

    setattr(resolve, _INSTALLED_MARK, True)
    runner._resolve_session_reasoning_config = resolve
    return True
