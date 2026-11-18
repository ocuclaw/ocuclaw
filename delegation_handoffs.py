"""``ocuclaw-agents``: an enrolled agent hands one task to another (#6797).

Hermes 0.22.5 made ``delegate_task`` pluggable: a *delegation provider*
answers "which route does this task take", and Hermes keeps the whole subagent
lifecycle. A route may name a Hermes **profile**, and the child then runs as
that profile (its model, credentials, SOUL, skills and terminal policy) while
keeping the asking agent's toolset and transcript. This module is OcuClaw's
provider, plus the per-agent switch that selects it.

Envelope (SECURITY-RULED on #6786):

    an enrolled OcuClaw agent may run one delegated task as another enrolled
    agent (that agent's model, credentials, SOUL, skills and terminal policy,
    with the asking agent's tools). Never a profile outside OcuClaw's
    enrollment set. Off until the wearer turns it on for named agents; turning
    it off restores the previous delegation backend.

How each clause is held:

* **Only enrolled agents.** The ``agent`` choices come from the asking
  profile's own ``delegation.backends.ocuclaw-agents.agents``, which only
  :func:`apply_switch` writes and which accepts only enrolled, served names.
  :meth:`route_task` re-checks the live enrollment set on every task, for the
  target *and* the asker, so an agent removed from enrollment mid-chat is
  refused even though the chat's cached schema still lists it.
* **Off until turned on.** Registering the provider selects nothing. Hermes
  reads ``delegation.backend`` per profile, and only :func:`apply_switch`
  writes it, for the one profile the wearer named.
* **Off restores.** Turning on records the backend it replaced under
  ``delegation.backends.ocuclaw-agents.previous``; turning off (and uninstall,
  and the doctor's restore) puts that back.

``task_parameters`` and ``description`` are built from config alone, with the
agent descriptions stored next to the names, because Hermes caches the
``delegate_task`` schema in the prompt prefix: same config, same bytes.
"""

from __future__ import annotations

import copy
import logging
import re
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

BACKEND_NAME = "ocuclaw-agents"
BACKEND_DISPLAY_NAME = "OcuClaw agents"
BACKEND_SUMMARY = "Subagents run as another OcuClaw agent you allowed, with this agent's tools."
DEFAULT_BACKEND = "default"
AGENT_PARAMETER = "agent"

#: Settings keys under ``delegation.backends.ocuclaw-agents``.
AGENTS_KEY = "agents"
PREVIOUS_KEY = "previous"

#: Bounds. Descriptions match the Auto router's per-agent cut (#6786 spec).
MAX_AGENTS = 32
DESCRIPTION_LIMIT = 280

#: Hermes's backend-name rule (``delegation_registry._BUNDLED_NAME_RE``), used
#: to keep a recorded ``previous`` from ever being anything but a name.
_BACKEND_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

TOOL_DESCRIPTION = (
    "Set `agent` to hand a task to a teammate who is better at it. Leave it out "
    "to do the task yourself."
)

_LOCK = threading.Lock()
_REGISTERED = False
#: Set by ``register``; tests replace it.
_ENROLLMENT_FN: Optional[Callable[[], Any]] = None


# -- pure config helpers --------------------------------------------------------


def _clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in value).split())
    return text[:limit].rstrip()


def _profile_name(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    token = value.strip()
    return token if _PROFILE_NAME_RE.match(token) else None


def backend_name(value: Any) -> str:
    """A ``delegation.backend`` value normalized as Hermes reads it."""
    if isinstance(value, str) and value.strip():
        return value.strip().lower()
    return DEFAULT_BACKEND


def own_settings(delegation: Any) -> Mapping[str, Any]:
    """``delegation.backends.ocuclaw-agents`` as a mapping (empty when unset)."""
    if not isinstance(delegation, Mapping):
        return {}
    backends = delegation.get("backends")
    own = backends.get(BACKEND_NAME) if isinstance(backends, Mapping) else None
    return own if isinstance(own, Mapping) else {}


def configured_agents(settings: Mapping[str, Any]) -> List[Tuple[str, str]]:
    """``[(name, description)]`` from the settings, in their written order.

    Accepts ``{name, description}`` rows and bare names. Invalid names and
    repeats are dropped, never repaired, and the list is capped. Order is kept
    so the schema is the same bytes as long as the config is.
    """
    raw = settings.get(AGENTS_KEY) if isinstance(settings, Mapping) else None
    if not isinstance(raw, list):
        return []
    rows: List[Tuple[str, str]] = []
    seen = set()
    for entry in raw:
        if isinstance(entry, Mapping):
            name = _profile_name(entry.get("name"))
            description = _clean_text(entry.get("description"), DESCRIPTION_LIMIT)
        else:
            name = _profile_name(entry)
            description = ""
        if name is None or name in seen:
            continue
        seen.add(name)
        rows.append((name, description))
        if len(rows) >= MAX_AGENTS:
            break
    return rows


def task_parameters_for(settings: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """The ``agent`` parameter: an enum of the allowed agents, described."""
    agents = configured_agents(settings)
    if not agents:
        return {}
    lines = []
    for name, description in agents:
        lines.append(f"{name}: {description}" if description else name)
    return {
        AGENT_PARAMETER: {
            "type": "string",
            "enum": [name for name, _ in agents],
            "description": (
                "The teammate agent to run this task as. It works with its own "
                "model, skills and sign-ins, and your tools. "
                + "; ".join(lines)
                + "."
            ),
        }
    }


def description_for(settings: Mapping[str, Any]) -> str:
    return TOOL_DESCRIPTION if configured_agents(settings) else ""


def previous_backend(settings: Mapping[str, Any]) -> str:
    """The backend this one replaced; ``default`` when unrecorded or invalid."""
    value = settings.get(PREVIOUS_KEY) if isinstance(settings, Mapping) else None
    name = backend_name(value)
    if name == BACKEND_NAME or not _BACKEND_NAME_RE.match(name):
        return DEFAULT_BACKEND
    return name


def default_route(config: Mapping[str, Any]) -> Dict[str, Any]:
    """What ``delegation.backend: default`` would return for this task."""
    # Same rule as Hermes's bundled default strategy: the delegation section has
    # no speed tier, so an unknown key there never becomes one.
    return {key: value for key, value in dict(config).items() if key != "service_tier"}


class RouteRefused(ValueError):
    """``route_task`` refuses one task; the message is what the model reads."""


def route_for(
    task: Mapping[str, Any],
    config: Mapping[str, Any],
    *,
    asker: Optional[str],
    admits: Callable[[str], bool],
) -> Dict[str, Any]:
    """The route for one task, or :class:`RouteRefused`.

    No ``agent``: the default route, so a plain ``delegate_task`` behaves as it
    did before the switch. With one: a profile route, only when the target is
    one this agent may ask, both agents are enrolled now, and they differ.
    """
    raw = task.get(AGENT_PARAMETER) if isinstance(task, Mapping) else None
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default_route(config)
    target = _profile_name(raw)
    allowed = {name for name, _ in configured_agents(own_settings(config))}
    if target is None or target not in allowed:
        raise RouteRefused(
            f"'{raw}' is not an agent this agent may ask. Leave `agent` out to do the task yourself."
        )
    if asker is not None and target == asker:
        raise RouteRefused(
            f"You are {target}. Leave `agent` out to do this task yourself."
        )
    if asker is None or not admits(asker):
        raise RouteRefused(
            "This agent is not enrolled in OcuClaw, so it cannot ask other agents. "
            "Leave `agent` out to do the task yourself."
        )
    if not admits(target):
        raise RouteRefused(
            f"{target} is no longer enrolled in OcuClaw, so it cannot be asked. "
            "Leave `agent` out to do the task yourself."
        )
    return {"profile": target, "label": target}


# -- host seam ------------------------------------------------------------------


def host_has_seam(ctx: Any) -> bool:
    """Does this host take delegation providers (Hermes 0.22.5+)?"""
    return callable(getattr(ctx, "register_delegation_provider", None))


def is_registered() -> bool:
    return _REGISTERED


def reset() -> None:
    """Tests only."""
    global _REGISTERED, _ENROLLMENT_FN
    with _LOCK:
        _REGISTERED = False
        _ENROLLMENT_FN = None


def _current_enrollment() -> Any:
    fn = _ENROLLMENT_FN
    if fn is None:
        from .profile_enrollment import current_enrollment

        fn = current_enrollment
    return fn()


def _admits(name: str) -> bool:
    try:
        return bool(_current_enrollment().admits(name))
    except Exception:  # noqa: BLE001 - an unreadable set admits nobody
        return False


def _asking_profile() -> Optional[str]:
    """The profile this task runs FOR (the routed turn's bound scope)."""
    # current_profile_name honours a routed turn's bound HERMES_HOME (a multiplexed
    # gateway); the seam this backend needs (0.22.5+) always ships it.
    try:
        from hermes_cli.profiles import current_profile_name
    except Exception:  # noqa: BLE001 - no reader: the asker is unknown, so refused
        return None
    try:
        name = current_profile_name("default")
    except Exception:  # noqa: BLE001 - unknown asker is refused, never guessed
        return None
    return _profile_name(name)


def build_provider() -> Any:
    """One :class:`DelegationProvider` instance (imports Hermes lazily)."""
    from agent.delegation_provider import DelegationProvider, DelegationRouteError

    class OcuClawAgentsProvider(DelegationProvider):
        @property
        def name(self) -> str:
            return BACKEND_NAME

        @property
        def display_name(self) -> str:
            return BACKEND_DISPLAY_NAME

        @property
        def summary(self) -> str:
            return BACKEND_SUMMARY

        def is_available(self) -> bool:
            # No network, no config: loaded means it can route. An empty
            # agent list declares no parameter and routes everything default.
            return True

        def task_parameters(self, config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
            return task_parameters_for(self.settings(config))

        def description(self, config: Mapping[str, Any]) -> str:
            return description_for(self.settings(config))

        def route_task(self, task: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
            try:
                return route_for(task, config, asker=_asking_profile(), admits=_admits)
            except RouteRefused as exc:
                raise DelegationRouteError(str(exc)) from None

    return OcuClawAgentsProvider()


def register(ctx: Any) -> bool:
    """Register the provider when the host has the seam; never raises."""
    global _REGISTERED
    if not host_has_seam(ctx):
        return False
    try:
        provider = build_provider()
        ctx.register_delegation_provider(provider)
    except Exception as exc:  # noqa: BLE001 - optional feature
        logger.warning("[ocuclaw] delegation backend %s not registered: %s", BACKEND_NAME, exc)
        return False
    with _LOCK:
        _REGISTERED = True
    return True


# -- the per-agent switch ---------------------------------------------------------


class SwitchRefused(ValueError):
    """The switch cannot change as asked. ``code`` is a stable error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _read_raw(config_path: Path) -> Dict[str, Any]:
    from hermes_cli.config import read_user_config_raw

    raw = read_user_config_raw(config_path) if config_path.exists() else {}
    if not isinstance(raw, dict):
        raise SwitchRefused("native_read_failed", "This agent's configuration could not be read.")
    return copy.deepcopy(raw)


def switch_state(raw: Mapping[str, Any]) -> Dict[str, Any]:
    """``{enabled, backend, previous, agents}`` from one profile's raw config."""
    delegation = raw.get("delegation") if isinstance(raw, Mapping) else None
    delegation = delegation if isinstance(delegation, Mapping) else {}
    current = backend_name(delegation.get("backend"))
    settings = own_settings(delegation)
    enabled = current == BACKEND_NAME
    return {
        "enabled": enabled,
        "backend": current,
        "previous": previous_backend(settings) if enabled else None,
        "agents": [name for name, _ in configured_agents(settings)],
    }


def _prune(mapping: Dict[str, Any], key: str) -> None:
    child = mapping.get(key)
    if isinstance(child, dict) and not child:
        mapping.pop(key, None)


def switched_on(
    raw: Mapping[str, Any],
    agents: Sequence[Tuple[str, str]],
    *,
    confirm_replace: Optional[str] = None,
) -> Dict[str, Any]:
    """``raw`` with this backend selected and ``agents`` allowed.

    Replacing a backend other than ``default`` (``advanced-delegation``'s
    ``profile_routes``, say) needs ``confirm_replace`` naming it: the phone
    asks first, and a stale page cannot replace one it never showed.
    """
    updated = copy.deepcopy(dict(raw))
    delegation = updated.get("delegation")
    if delegation is None:
        delegation = updated["delegation"] = {}
    if not isinstance(delegation, dict):
        raise SwitchRefused("native_read_failed", "This agent's delegation settings could not be read.")
    current = backend_name(delegation.get("backend"))
    backends = delegation.get("backends")
    if backends is None:
        backends = delegation["backends"] = {}
    if not isinstance(backends, dict):
        raise SwitchRefused("native_read_failed", "This agent's delegation settings could not be read.")
    own = backends.get(BACKEND_NAME)
    own = dict(own) if isinstance(own, Mapping) else {}
    if current == BACKEND_NAME:
        previous = previous_backend(own)
    else:
        if current != DEFAULT_BACKEND and backend_name(confirm_replace) != current:
            raise SwitchRefused(
                "replace_unconfirmed",
                f"This agent uses the {current} delegation backend. Confirm replacing it first.",
            )
        previous = current if _BACKEND_NAME_RE.match(current) else DEFAULT_BACKEND
    own[AGENTS_KEY] = [
        {"name": name, **({"description": description} if description else {})}
        for name, description in agents
    ]
    own[PREVIOUS_KEY] = previous
    backends[BACKEND_NAME] = own
    delegation["backend"] = BACKEND_NAME
    return updated


def switched_off(raw: Mapping[str, Any]) -> Tuple[Dict[str, Any], bool]:
    """``raw`` with the previous backend restored and this block removed.

    Returns ``(config, changed)``. A profile on another backend keeps it; only
    this backend's own block is removed from it.
    """
    updated = copy.deepcopy(dict(raw))
    delegation = updated.get("delegation")
    if not isinstance(delegation, dict):
        return updated, False
    changed = False
    backends = delegation.get("backends")
    own = backends.get(BACKEND_NAME) if isinstance(backends, dict) else None
    if backend_name(delegation.get("backend")) == BACKEND_NAME:
        previous = previous_backend(own if isinstance(own, Mapping) else {})
        if previous == DEFAULT_BACKEND:
            delegation.pop("backend", None)
        else:
            delegation["backend"] = previous
        changed = True
    if isinstance(backends, dict) and BACKEND_NAME in backends:
        backends.pop(BACKEND_NAME, None)
        _prune(delegation, "backends")
        changed = True
    _prune(updated, "delegation")
    return updated, changed


def write_config(config_path: Path, config: Dict[str, Any]) -> None:
    """Persist a whole raw config whose dropped keys are meant to go."""
    from hermes_cli.config import is_managed

    if is_managed():
        raise SwitchRefused("managed", "This Hermes install is managed, so its delegation settings are read only.")
    from .config_writer import replace_config

    replace_config(config_path, config)


def restore_home(home: Path) -> bool:
    """Turn the switch off in one profile home. True when the file changed."""
    config_path = Path(home) / "config.yaml"
    if not config_path.exists():
        return False
    raw = _read_raw(config_path)
    updated, changed = switched_off(raw)
    if changed:
        write_config(config_path, updated)
    return changed


def profile_homes(default_home: Path) -> List[Tuple[str, Path]]:
    """``[(name, home)]``: the default profile, then every secondary on disk."""
    homes: List[Tuple[str, Path]] = [(DEFAULT_BACKEND, Path(default_home))]
    root = Path(default_home) / "profiles"
    try:
        entries = sorted(root.iterdir()) if root.is_dir() else []
    except OSError:
        entries = []
    for entry in entries:
        name = _profile_name(entry.name)
        if name is not None and name != DEFAULT_BACKEND and entry.is_dir():
            homes.append((name, entry))
    return homes


def restore_all(default_home: Path) -> Dict[str, List[str]]:
    """Uninstall: restore the previous backend in every profile.

    ``{"restored": [...], "failed": [...]}``; never raises.
    """
    restored: List[str] = []
    failed: List[str] = []
    for name, home in profile_homes(default_home):
        try:
            if restore_home(home):
                restored.append(name)
        except Exception:  # noqa: BLE001 - reported by name only
            failed.append(name)
    return {"restored": restored, "failed": failed}


__all__ = [
    "AGENT_PARAMETER",
    "BACKEND_DISPLAY_NAME",
    "BACKEND_NAME",
    "RouteRefused",
    "SwitchRefused",
    "build_provider",
    "configured_agents",
    "description_for",
    "host_has_seam",
    "is_registered",
    "own_settings",
    "previous_backend",
    "profile_homes",
    "register",
    "restore_all",
    "restore_home",
    "route_for",
    "switch_state",
    "switched_off",
    "switched_on",
    "task_parameters_for",
]
