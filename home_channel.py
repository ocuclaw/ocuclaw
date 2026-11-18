"""Make the glasses' main chat Hermes' OcuClaw home channel at pairing (#5025).

A job made on Hermes Desktop, the dashboard or by the agent in another chat
names a platform, not a chat: ``deliver=ocuclaw``. Hermes sends it to that
platform's home channel. It reads the home from ``OCUCLAW_HOME_CHANNEL``
first, then from ``platforms.ocuclaw.home_channel`` in ``config.yaml``
(``_get_home_target_chat_id``, ``cron/scheduler_delivery.py``). With neither
set the job fails with "no delivery target resolved for deliver=ocuclaw",
and the only way to set one was to type ``/sethome`` on the glasses.

So when the owner approves a pairing, the gateway makes the wearer's main
OcuClaw chat the home, but only when no home is set yet. A home the wearer
chose with ``/sethome``, or one an operator set in the environment, is kept.

The write adds only ``platforms.ocuclaw.home_channel`` to the file as the
user wrote it (``read_user_config_raw`` + ``atomic_config_write``). It does
not go through ``persist_home_channel``, the helper ``/sethome`` uses: that
one saves the merged config, and where the file already has a ``gateway:``
section (Hermes' installer template does) it writes every gateway default
into it, ``gateway.multiplex_profiles: true`` among them. This write runs
when the gateway connects, after the gateway recorded the setup settings it
booted with, so that default read as a setting saved since boot: on a fresh
install the Desktop card's "Restart gateway" ended on "Gateway did not come
back" (run 42767883799). Unlike ``/sethome`` it also leaves ``.env`` alone:
the env mirror is legacy, Hermes reads ``config.yaml`` when the variable is
unset, and ``.env`` stays for secrets. Uninstall already removes the whole
``platforms.ocuclaw`` block, so the home goes with it.

``HomeChannel`` predates the 0.21.1 floor. A Hermes without the raw-config
helpers falls back to ``persist_home_channel`` (Hermes 0.19.0).
"""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Mapping, Optional

from .health import OCUCLAW_WEARER_USER_ID

logger = logging.getLogger(__name__)

PLATFORM = "ocuclaw"
#: The env var Hermes reads first for ``deliver=ocuclaw``. The adapter
#: registers it as the platform's ``cron_deliver_env_var``.
HOME_CHANNEL_ENV = "OCUCLAW_HOME_CHANNEL"
#: The default-lane chat the glasses open on. The relay routes a bare or
#: missing session key to it (``routeDispatchSessionKey`` in
#: ``hermes-gateway-bridge.ts``), so ``send("main", ...)`` reaches the
#: wearer's main conversation as session ``agent:main:ocuclaw:dm:main``.
HOME_CHAT_ID = "main"
#: The chat name inbound glasses messages carry (``_build_message_event``).
HOME_CHAT_NAME = "OcuClaw Glasses"

#: Outcomes, secret-free, for logs and tests.
OUTCOME_SET = "set"
OUTCOME_KEPT_ENV = "kept_env"
OUTCOME_KEPT_CONFIG = "kept_config"
OUTCOME_NOT_WRITTEN = "not_written"
OUTCOME_UNAVAILABLE = "hermes_unavailable"
OUTCOME_FAILED = "failed"


def hermes_home_api() -> Any:
    """Hermes' public home-channel helpers, resolved against ``HERMES_HOME``."""
    # Deferred: the bundle stays importable without Hermes on the path.
    from gateway.config import HomeChannel, Platform, persist_home_channel
    from hermes_cli.config import get_env_value, load_config
    from .stock_tools import profile_tool_context

    def profile_env_value(key: str) -> Any:
        # Pairing/startup run outside an agent turn. Hermes refuses an
        # unscoped read under multiplexing; bind this home, never process env
        # or a scope left by another profile, and restore the caller's scope.
        with profile_tool_context():
            return get_env_value(key)

    def write_home_channel(home: Any) -> None:
        # Only the home, into the file as written (module docstring).
        try:
            from hermes_cli.config import (
                atomic_config_write,
                get_config_path,
                is_managed,
                read_user_config_raw,
            )
        except ImportError:
            persist_home_channel(home)
            return
        if is_managed():
            # A managed install owns config.yaml; the caller reads back.
            return
        config_path = Path(get_config_path())
        raw = read_user_config_raw(config_path)
        if not isinstance(raw, dict):
            raw = {}
        slot = raw
        for key in ("platforms", PLATFORM):
            child = slot.get(key)
            if not isinstance(child, dict):
                child = {}
                slot[key] = child
            slot = child
        slot["home_channel"] = home.to_dict()
        atomic_config_write(config_path, raw)

    return SimpleNamespace(
        HomeChannel=HomeChannel,
        Platform=Platform,
        write_home_channel=write_home_channel,
        get_env_value=profile_env_value,
        load_config=load_config,
    )


#: The suite's conftest replaces this seam so no test reaches a real home.
_default_api = hermes_home_api


def configured_home_chat_id(config: Any) -> str:
    """``platforms.ocuclaw.home_channel.chat_id`` from a config mapping, or ``""``."""

    platforms = config.get("platforms") if isinstance(config, Mapping) else None
    slot = platforms.get(PLATFORM) if isinstance(platforms, Mapping) else None
    home = slot.get("home_channel") if isinstance(slot, Mapping) else None
    if not isinstance(home, Mapping):
        return ""
    return str(home.get("chat_id") or "").strip()


def set_default_home_channel(
    api_factory: Optional[Callable[[], Any]] = None,
) -> str:
    """Set the main glasses chat as the OcuClaw home when none is set.

    Never raises: a config fault must not undo a completed pairing. The
    wearer can still type ``/sethome``.
    """

    try:
        api = (api_factory or _default_api)()
    except ImportError:
        return OUTCOME_UNAVAILABLE
    except Exception:  # noqa: BLE001 - a host fault never breaks pairing
        logger.warning("[ocuclaw] Hermes home channel helpers unavailable", exc_info=True)
        return OUTCOME_UNAVAILABLE
    try:
        # Same order Hermes resolves a home in: the env var wins.
        if str(api.get_env_value(HOME_CHANNEL_ENV) or "").strip():
            return OUTCOME_KEPT_ENV
        if configured_home_chat_id(api.load_config()):
            return OUTCOME_KEPT_CONFIG
        home = api.HomeChannel(
            platform=api.Platform(PLATFORM),
            chat_id=HOME_CHAT_ID,
            name=HOME_CHAT_NAME,
            user_id=OCUCLAW_WEARER_USER_ID,
        )
        # enabled_if_new stays False: setting a home never enables the
        # platform; install owns that.
        api.write_home_channel(home)
        # A managed install refuses config writes without raising, so read
        # the value back before claiming it.
        if configured_home_chat_id(api.load_config()) == HOME_CHAT_ID:
            return OUTCOME_SET
        return OUTCOME_NOT_WRITTEN
    except Exception:  # noqa: BLE001 - a config fault never breaks pairing
        logger.warning("[ocuclaw] could not set the OcuClaw home channel", exc_info=True)
        return OUTCOME_FAILED
