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

import importlib.util
import json
import logging
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

from . import custom_route, secret_access, serve
from .control_link import HERMES_BUNDLE_DEFAULT_WS_BIND, HERMES_BUNDLE_DEFAULT_WS_PORT
from .receipts import (
    fingerprint_home,
    read_app_presence,
    read_first_run_proof,
    read_gateway_state,
    read_serving,
    resolve_receipt_home,
)
from .provenance import STATE_CERTIFIED_SOURCE, collect_hermes_source
from .snapshot import OBSERVATION_PASSIVE, TRISTATE_UNKNOWN, blank_facts
from .snapshot import now_iso as snapshot_now_iso

logger = logging.getLogger(__name__)

PLATFORM_NAME = "ocuclaw"
BUNDLE_DIR = Path(__file__).resolve().parent
DEFAULT_RUNTIME_ENTRY = BUNDLE_DIR / "dist-cjs" / "runtime" / "hermes-runtime-entry.cjs"

CERTIFIED_HERMES_VERSION = "0.23.2"
CERTIFIED_HERMES_TAG = "v0.23.2"
CERTIFIED_HERMES_COMMIT = "ae2a81ccc00e9b7c06301523e5bb09608397149c"
SUPPORTED_HERMES_MIN = (0, 21, 4)
SUPPORTED_HERMES_MAX_EXCLUSIVE = (0, 24, 0)

# The ONE user id the adapter stamps on every wearer-originated event
# (adapter.py `_build_message_event` → `build_source`). Continue here (#2509)
# needs `platforms.ocuclaw.extra.allow_admin_from` to list exactly this id.
OCUCLAW_WEARER_USER_ID = "ocuclaw-wearer"
# Shared chats (on by default, Matty RULED 2026-11-07): Continue here without the
# single-driver lock, on the first Hermes whose gateway owns every session for
# every surface. `platforms.ocuclaw.extra.sharedChats: false` turns it off.
SHARED_CHATS_EXTRA_KEY = "sharedChats"
SHARED_CHATS_MIN_HERMES = (0, 23, 0)

OCUCLAW_RELAY_TOKEN_ENV = "OCUCLAW_RELAY_TOKEN"
OCUCLAW_SONIOX_API_KEY_ENV = "OCUCLAW_SONIOX_API_KEY"
OCUCLAW_EVEN_AI_TOKEN_ENV = "OCUCLAW_EVEN_AI_TOKEN"
# The saved TypeSafe key for the Jev features (#3359); the same `.env` contract as the others.
OCUCLAW_TYPESAFE_API_KEY_ENV = "OCUCLAW_TYPESAFE_API_KEY"

_SECRET_ENV_TO_KEY = {
    OCUCLAW_RELAY_TOKEN_ENV: "relayToken",
    OCUCLAW_SONIOX_API_KEY_ENV: "sonioxApiKey",
    OCUCLAW_EVEN_AI_TOKEN_ENV: "evenAiToken",
    OCUCLAW_TYPESAFE_API_KEY_ENV: "typesafeApiKey",
}

# Non-secret platform settings that may also come from the Hermes env file
# (#3098). These are the keys `skills/ocuclaw-assist-hermes/references/
# fresh-install.md` otherwise makes an operator type into `hermes config set`
# by hand, so an unattended installer can seed them the same way it already
# seeds the three secrets above. `wsBind` is deliberately NOT here: it is the
# relay bind address, and an env name for it would be a remote way to widen
# the listener past loopback.
OCUCLAW_ALLOW_ADMIN_FROM_ENV = "OCUCLAW_ALLOW_ADMIN_FROM"
OCUCLAW_EVEN_AI_ENABLED_ENV = "OCUCLAW_EVEN_AI_ENABLED"

PLATFORM_ENV_TO_KEY = {
    OCUCLAW_ALLOW_ADMIN_FROM_ENV: "allow_admin_from",
    OCUCLAW_EVEN_AI_ENABLED_ENV: "evenAiEnabled",
}

_TRUE_WORDS = frozenset({"1", "true", "yes", "on"})
_FALSE_WORDS = frozenset({"0", "false", "no", "off"})


def _parse_id_list(raw: str) -> List[str]:
    """A user-id allow-list written as JSON (`["a","b"]`) or `a,b`.

    Hermes' own reader (`gateway.slash_access._coerce_id_list`) already takes
    either shape off `extra`, so both spellings survive the trip. Raises
    ``ValueError`` on anything that is not a list of plain ids, including an
    explicitly empty one: an allow-list with nobody in it silently disables
    the gate it was set to turn on.
    """
    text = raw.strip()
    if text.startswith("[") or text.startswith("{"):
        try:
            parsed = json.loads(text)
        except ValueError as exc:
            raise ValueError("not valid JSON") from exc
        if not isinstance(parsed, list):
            raise ValueError("JSON value is not a list")
        items: List[Any] = list(parsed)
        # `str(item)` would happily turn JSON `null`/`true`/`1.5` into the ids
        # "None"/"True"/"1.5", which is not what the operator wrote. Only a
        # string or a whole number is an id; `bool` is an `int` subclass, so it
        # is excluded by name.
        if any(
            isinstance(item, bool) or not isinstance(item, (str, int))
            for item in items
        ):
            raise ValueError("list entries must be plain ids")
    else:
        items = list(text.split(","))
    ids = [str(item).strip() for item in items]
    ids = [item for item in ids if item]
    if not ids:
        raise ValueError("no user ids")
    return ids


def _parse_bool(raw: str) -> bool:
    text = raw.strip().lower()
    if text in _TRUE_WORDS:
        return True
    if text in _FALSE_WORDS:
        return False
    raise ValueError("expected true or false")


_PLATFORM_ENV_PARSERS: Dict[str, Callable[[str], Any]] = {
    OCUCLAW_ALLOW_ADMIN_FROM_ENV: _parse_id_list,
    OCUCLAW_EVEN_AI_ENABLED_ENV: _parse_bool,
}


# Refusals are warned once per process per (env name, reason). `collect_health_facts`
# runs the seed on every status and doctor read, and an operator polling a
# broken `.env` line does not need the same complaint in the log a hundred times.
_WARNED_PLATFORM_ENV: set = set()


def reset_platform_env_warnings() -> None:
    """Forget which refusals have been warned about (test seam)."""
    _WARNED_PLATFORM_ENV.clear()


def platform_env_seed(env: Optional[Mapping[str, str]] = None) -> Dict[str, Any]:
    """The non-secret `platforms.ocuclaw.extra` values this env file supplies.

    An absent or blank env name contributes nothing, so a hand-edited
    `config.yaml` keeps working exactly as before. A value that cannot be
    parsed is refused with ONE plain warning line — once per process per
    (name, reason) — and then treated as absent: gateway start must never fall
    over because of a typo in `.env`, and the seeded Relay Credential must not
    be lost along with it.
    """
    source = os.environ if env is None else env
    seed: Dict[str, Any] = {}
    for env_name, extra_key in PLATFORM_ENV_TO_KEY.items():
        raw = str(source.get(env_name, "") or "").strip()
        if not raw:
            continue
        try:
            seed[extra_key] = _PLATFORM_ENV_PARSERS[env_name](raw)
        except ValueError as exc:
            # The reason is a fixed phrase, never the rejected value: an
            # operator's `.env` line may sit next to secrets in one paste
            # buffer, and a value in the key would also defeat the de-dupe.
            if (env_name, str(exc)) in _WARNED_PLATFORM_ENV:
                continue
            _WARNED_PLATFORM_ENV.add((env_name, str(exc)))
            logger.warning(
                "[ocuclaw] %s is not a usable %s (%s) — ignoring it and using "
                "platforms.ocuclaw.extra.%s from config.yaml",
                env_name,
                extra_key,
                exc,
                extra_key,
            )
    return seed


def env_seed_reaches_extra(
    platform_config: Any,
    *,
    relay_token_present: bool,
    host_supported: bool,
    node_available: bool,
    node_installable: bool = False,
) -> bool:
    """Whether Hermes would actually COMMIT the env seed onto this platform.

    A seed that is never committed is not an effective value, and a status read
    that reported one would be claiming something the gateway never took.
    `gateway/config_env.py` `_enable_plugin_platform` (lines 375-417 at the
    0.21.1 floor, commit ``2237be355906``; unchanged at 0.21.2/0.21.3) reaches
    its ``platform_config.extra.update(seed)`` only past three refusals:

    * line 385 — an `enabled:` key that says False (the loader's
      ``_enabled_explicit`` marker, `gateway/config_loader.py:143`) returns at
      once. An operator who switched the platform off is never overridden.
    * line 389 — when the platform is not already enabled, ``is_connected``
      must pass. OcuClaw's is `_admitted_is_connected`: a supported host plus a
      Relay Credential, from the env file or the legacy yaml `extra.relayToken`.
      **Before the credential exists there is no commit**, so a fresh install
      that has written only `OCUCLAW_ALLOW_ADMIN_FROM` is not yet configured.
    * line 405 — ``check_fn`` must pass, or the platform must register
      ``ensure_deps_fn``. OcuClaw's `check_ocuclaw_requirements` is "supported
      host and node found". OcuClaw registers `ensure_ocuclaw_requirements`
      as its ``ensure_deps_fn`` only on a supported host whose Hermes installs
      Node itself (``node_installable``, 0.21.6+); there a missing Node does
      not stop the commit, because the gateway installs it at start.
    """
    block = platform_config if isinstance(platform_config, Mapping) else {}
    enabled = block.get("enabled")
    if enabled is False:  # explicitly switched off — never re-enabled
        return False
    if enabled is not True:  # not already enabled: the is_connected gate applies
        extra = block.get("extra")
        yaml_relay_token = (
            str((extra or {}).get("relayToken") or "").strip()
            if isinstance(extra, Mapping)
            else ""
        )
        if not (host_supported and (relay_token_present or yaml_relay_token)):
            return False
    # check_fn, or the ensure_deps_fn registered beside it
    return bool(host_supported and (node_available or node_installable))


def effective_platform_extra(
    extra: Any,
    *,
    seed_committed: bool,
    env: Optional[Mapping[str, str]] = None,
) -> Dict[str, Any]:
    """`extra` as the gateway will really see it: env layered over config.yaml.

    Hermes commits the plugin's env seed with ``platform_config.extra.update``
    (`gateway/config_env.py` `_enable_plugin_platform`), so env WINS for every
    key it names — the same precedence the seeded secrets have always had.
    The passive status reads parse raw `config.yaml`, which knows nothing about
    `.env`; this is what keeps them honest about the effective value.

    ``seed_committed`` is `env_seed_reaches_extra`'s answer for this host. When
    it is False the env layer is left off entirely, because Hermes would not
    have applied it either.
    """
    block = dict(extra) if isinstance(extra, Mapping) else {}
    if seed_committed:
        block.update(platform_env_seed(env))
    return block


def admin_ids_from_extra(extra: Any) -> List[str]:
    """The platform's ``allow_admin_from`` list, coerced the way Hermes coerces it.

    Mirrors ``gateway.slash_access._coerce_id_list``: a comma-separated string
    or any sequence of ids, stripped, blanks dropped, order preserved. Public
    so a caller that has to EXTEND the allow-list (the Cloudways ladder's
    settings step, #3102) reads the same list the gate reads, instead of
    inventing a second parser that could disagree and drop an admin.
    """
    block = extra if isinstance(extra, Mapping) else {}
    raw = block.get("allow_admin_from")
    if isinstance(raw, str):
        parts: List[Any] = list(raw.split(","))
    elif isinstance(raw, (list, tuple, set)):
        parts = list(raw)
    else:
        parts = []
    ids: List[str] = []
    for part in parts:
        text = str(part).strip()
        if text and text not in ids:
            ids.append(text)
    return ids


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
    return OCUCLAW_WEARER_USER_ID in admin_ids_from_extra(block)


def shared_chats_requested(extra: Any) -> bool:
    """Whether the host wants shared chats (`platforms.ocuclaw.extra.sharedChats`).

    On unless the key turns it off: a literal false, or the string "false" a
    hand-edited YAML or an env override can leave. A missing key or block, or a
    value that is neither, keeps the default (on). `shared_chats_enabled` still
    needs Continue here and Hermes 0.23 before anything is shared.
    """
    block = extra if isinstance(extra, Mapping) else {}
    value = block.get(SHARED_CHATS_EXTRA_KEY)
    if isinstance(value, bool):
        return value
    return not (isinstance(value, str) and value.strip().lower() == "false")


def shared_chats_enabled(extra: Any, version: Any) -> bool:
    """Shared chats: Continue here without the single-driver lock.

    Hermes 0.23 runs every conversation in one gateway; Desktop, the TUI and
    `hermes chat` attach to it as viewers instead of running their own agent, so
    a Desktop window no longer answers from a private copy of the history. A
    chat continued on glasses is then one conversation with one queue on every
    surface. All three must hold: the host has not turned it off, Hermes honours the
    wearer's `/resume --all` (`continue_here_configured`), and the gateway is
    0.23.0 or newer. Any doubt reads as off.
    """
    if not shared_chats_requested(extra) or not continue_here_configured(extra):
        return False
    parsed = parse_version(str(version or ""))
    return parsed is not None and parsed >= SHARED_CHATS_MIN_HERMES


def streaming_setting(raw_config: Any) -> Optional[bool]:
    """`display.platforms.ocuclaw.streaming` as True, False, or None when unset.

    Reads the key straight from `config.yaml` — the same HERMES CORE display
    key the Cloudways ladder writes and reads back
    (`cloudways_settings.STREAMING_KEY`). `display.streaming` (no
    `platforms.ocuclaw` segment) is a DIFFERENT, CLI-only key and is never
    read here; top-level `streaming.enabled` is never read either. Strings
    follow Hermes's own coercion of the CLI's `true`/`false` spellings. None
    (missing or unreadable) is what setup still has to fix; False is an
    operator's explicit choice and stays theirs.
    """
    display = raw_config.get("display") if isinstance(raw_config, Mapping) else None
    platforms = display.get("platforms") if isinstance(display, Mapping) else None
    block = platforms.get(PLATFORM_NAME) if isinstance(platforms, Mapping) else None
    value = block.get("streaming") if isinstance(block, Mapping) else None
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip():
        return value.strip().lower() in {"true", "on", "1", "yes"}
    return None


def streaming_configured(raw_config: Any) -> bool:
    """Whether Hermes will stream OcuClaw replies to the glasses per turn.

    Hermes 0.21.5 leaves a plugin platform's streaming off unless this key is
    on, so a missing value is not configured. See :func:`streaming_setting`.
    """
    return streaming_setting(raw_config) is True


def streaming_explicitly_off(raw_config: Any) -> bool:
    """True when an operator set the streaming key to off on purpose."""
    return streaming_setting(raw_config) is False


LIVE_REASONING_KEY = "stream_reasoning_deltas"
_LIVE_REASONING_HOOK_NAMES = (
    "on_interim_message",
    "on_stream_start",
    "on_stream_delta",
    "on_stream_end",
)
_LIVE_REASONING_HOOKS_MODULE = "agent.plugin_stream_hooks"


def live_reasoning_setting(raw_config: Any) -> Optional[bool]:
    """`plugins.stream_reasoning_deltas` as True, False, or None when unset.

    Exactly as strict as the adapter's registration gate
    (`adapter._stream_reasoning_deltas_configured`): only a real boolean
    counts, so a value the gate would not act on is reported as unset rather
    than as a choice. False is an operator's choice and stays theirs.
    """
    plugins = raw_config.get("plugins") if isinstance(raw_config, Mapping) else None
    value = plugins.get(LIVE_REASONING_KEY) if isinstance(plugins, Mapping) else None
    return value if isinstance(value, bool) else None


def busy_input_mode_setting(raw_config: Any) -> Optional[str]:
    """`display.busy_input_mode` as written in config.yaml, or None when unset.

    `hermes config get` answers Hermes's default (`interrupt`) for an unset
    key, so only the raw file can tell "nobody chose" from a choice.
    """
    display = raw_config.get("display") if isinstance(raw_config, Mapping) else None
    value = display.get("busy_input_mode") if isinstance(display, Mapping) else None
    text = str(value).strip() if value is not None else ""
    return text or None


def shared_chats_queue_owed(raw_config: Any, extra: Any, version: Any) -> bool:
    """Shared chats live, and no busy mode saved (Matty RULED 2026-11-06).

    With one conversation on the glasses and Desktop, Hermes's default
    `interrupt` lets a message from one side cut the other side's reply short.
    Setup writes `queue` here; any saved mode, `interrupt` included, is a
    choice and owes nothing. Only a host where chats are actually shared
    (`shared_chats_enabled`: not turned off, Continue here on, Hermes 0.23+)
    owes it, since the key changes every chat on this Hermes.
    """
    return shared_chats_enabled(extra, version) and busy_input_mode_setting(raw_config) is None


def live_reasoning_hooks_available() -> Optional[bool]:
    """Whether this Hermes has the reasoning-delta hooks (0.20.5+).

    The same probe the adapter runs at registration, side-effect free:
    ``find_spec`` never imports the dispatcher module. None when Hermes'
    hook vocabulary cannot be read at all.
    """
    try:
        from hermes_cli.plugins import VALID_HOOKS

        names = frozenset(str(name) for name in VALID_HOOKS)
    except Exception:  # noqa: BLE001 - off-platform / broken host
        return None
    try:
        module_present = importlib.util.find_spec(_LIVE_REASONING_HOOKS_MODULE) is not None
    except Exception:  # noqa: BLE001 - a broken parent package is "absent"
        module_present = False
    return module_present and all(name in names for name in _LIVE_REASONING_HOOK_NAMES)


def live_reasoning_hook_facts() -> Tuple[Optional[bool], Optional[bool]]:
    """``(hooks available, hooks registered by this gateway)``.

    Out of the gateway process nothing registered anything, so registration
    is unknown (None) here; the adapter supplies its own answer in-process.
    """
    return live_reasoning_hooks_available(), None


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
    """The hard gate: an identified Hermes at or above ``SUPPORTED_HERMES_MIN``.

    There is no upper bound. A Hermes at or above
    ``SUPPORTED_HERMES_MAX_EXCLUSIVE`` is newer than OcuClaw has tested: it
    runs, and :func:`hermes_version_untested` makes every presenter say so.
    """
    parsed = parse_version(raw)
    return bool(parsed is not None and parsed >= SUPPORTED_HERMES_MIN)


def hermes_version_untested(raw: str) -> bool:
    """True for a Hermes newer than the tested range (a warning, never a block)."""
    parsed = parse_version(raw)
    return bool(parsed is not None and parsed >= SUPPORTED_HERMES_MAX_EXCLUSIVE)


def hermes_untested_message(version: Any) -> str:
    """The one warning sentence the CLI, the dashboard and the gateway log show."""
    return (
        f"Hermes {version or 'unknown'} is newer than OcuClaw has tested "
        f"(certified {CERTIFIED_HERMES_VERSION}). It should work; report "
        "anything odd."
    )


def supported_hermes_range() -> str:
    """The range the gate admits: the floor alone (plugin.yaml states the same)."""
    return ">=" + ".".join(map(str, SUPPORTED_HERMES_MIN))


# The date-tagged releases in the supported range (tag ``v<date>``) and their
# versions. The cross-OS e2e resolver reads this table to turn "floor" into a
# release tag. The plugin no longer reads a version from
# ``hermes_cli.__release_date__``: from 0.21.6 Hermes froze it at 2026.9.24,
# so every later release would read as 0.21.5.
HERMES_RELEASE_DATES = {
    "2026.9.21": "0.21.4",
    "2026.9.24": "0.21.5",
}

HERMES_VERSION_UNKNOWN_HINT = (
    "OcuClaw could not identify the Hermes version (no install stamp and no "
    "release tag). Update Hermes with "
    "`hermes update` or re-run the Hermes installer, then restart the gateway"
)


def _identified_version(raw: Any) -> str:
    """``raw`` as a version string, or "" for missing/placeholder values."""
    text = str(raw or "").strip()
    parsed = parse_version(text)
    if parsed is None or parsed == (0, 0, 0):
        return ""
    return text


def _version_from_attribute() -> str:
    # A literal through 0.21.x. Since 2026-09-24 main serves it lazily from
    # install-stamp.json and returns the "0.0.0" placeholder without a stamp.
    from hermes_cli import __version__

    return _identified_version(__version__)


def _version_from_version_info() -> str:
    # Hermes's canonical identity on main: install stamp, then live git (the
    # nearest release tag). "unknown" when neither exists.
    from hermes_cli.version_info import get_version_info

    return _identified_version(get_version_info().base_version)


_HERMES_VERSION_SOURCES = (
    _version_from_attribute,
    _version_from_version_info,
)


def hermes_version() -> str:
    """The running Hermes release version, or "" when nothing identifies it.

    The ONE place the plugin reads the Hermes version. First usable source wins:
    1. ``hermes_cli.__version__`` (skipping main's "0.0.0" placeholder);
    2. ``hermes_cli.version_info.get_version_info().base_version``
       (install stamp, then git release tags).
    Package metadata and pyproject are not used: main ships them as "0.0.0",
    and an editable install's metadata keeps the version it was installed at.
    Nor is ``__release_date__``: frozen at 2026.9.24 since 0.21.6, it would
    report any newer tagless checkout as 0.21.5 and let it past the gate.
    """
    for source in _HERMES_VERSION_SOURCES:
        try:
            version = source()
        except Exception:  # noqa: BLE001 - diagnostics stay available on ABI drift
            continue
        if version:
            return version
    return ""


def find_node() -> Optional[str]:
    """The Node the gateway would run, or None.

    No PATH fallback when the helper answers None: from Hermes 0.21.6 that
    None means "Hermes has not installed Node yet", and reporting a PATH
    Node here would claim a runtime the gateway refuses to use.
    """
    try:
        from hermes_constants import find_node_executable

        return find_node_executable("node")
    except Exception:  # noqa: BLE001 - helper is Hermes-version-sensitive
        return shutil.which("node")


def node_install_available() -> bool:
    """Can Hermes' package manager install Node for OcuClaw?

    Hermes 0.21.6 moved Node under its package manager (``pm``).
    ``hermes_constants.find_node_executable`` returns only Node that ``pm``
    installed and None otherwise, never the PATH copy, because mixed
    toolchains break native-addon ABIs and npm caches; callers are meant to
    ``pm.ensure`` on None. Hermes 0.21.5 and older have no ``pm``, and their
    helper still falls back to the PATH copy itself.
    """
    try:
        return importlib.util.find_spec("pm") is not None
    except (ImportError, ValueError):
        return False


def setup_secret_present(env_name: str) -> bool:
    # Presence only, never the value; read through Hermes (catalogue rule 11).
    return secret_access.secret_present(env_name)


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


def _read_loaded_version() -> Optional[str]:
    try:
        text = (BUNDLE_DIR / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"^version:\s*([^\s#]+)", text, re.MULTILINE)
    return match.group(1).strip() if match else None


# Capture at module load: replacing plugin.yaml on disk must not make a live
# gateway claim it is already running the newly installed code.
_LOADED_OCUCLAW_VERSION = _read_loaded_version()

# The holder the adapter keeps OUTSIDE the purged `hermes_plugins.ocuclaw*`
# namespace (#3625). A Hermes plugin reload re-imports this module, and Hermes
# 0.22.3+ reloads after every Desktop "Update" click, so the capture above then
# reads the NEW plugin.yaml while the adapter and Node child built before the
# reload still serve the old code until a gateway restart. The adapter records
# the version it was built from here, and that is the version this process
# serves.
LIVE_ADAPTER_HOLDER_MODULE = "_ocuclaw_hermes_live_adapters"


def loaded_ocuclaw_version() -> Optional[str]:
    """The version this copy of the module was imported from."""
    return _LOADED_OCUCLAW_VERSION


def ocuclaw_version() -> Optional[str]:
    """The version this process serves: the live adapter's, else this import's."""
    holder = sys.modules.get(LIVE_ADAPTER_HOLDER_MODULE)
    serving = getattr(holder, "serving_version", None)
    if isinstance(serving, str) and serving:
        return serving
    return _LOADED_OCUCLAW_VERSION


def installed_ocuclaw_version() -> Optional[str]:
    """The version in plugin.yaml on disk now, which an update replaces."""
    return _read_loaded_version()


_VERSION_TOKEN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")


def restart_to_finish(*, home: Optional[Path] = None) -> Optional[Dict[str, str]]:
    """Describe installed code or saved setup settings awaiting a restart.

    Read in the Desktop backend, which cannot see the gateway's memory. Only
    the gateway that is live now counts, by pid and start time: a receipt left by a stopped
    or restarted gateway says nothing about the code running.
    """
    resolved = home if home is not None else resolve_receipt_home()
    if resolved is None:
        return None
    serving, _status = read_serving(fingerprint_home(resolved), home=resolved)
    gateway, _gateway_status, live = read_gateway_state(home=resolved)
    if serving is None or gateway is None or live is not True:
        return None
    pid = serving.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid != gateway.get("pid"):
        return None
    # A recycled PID must not make an old gateway's receipt authoritative.
    if serving.get("start_time") != gateway.get("start_time"):
        return None
    serving_version = serving.get("version")
    installed = installed_ocuclaw_version()
    if not all(isinstance(v, str) and _VERSION_TOKEN.match(v) for v in (serving_version, installed)):
        return None
    if serving_version == installed:
        from .setup_activation import current_fingerprint

        loaded = serving.get("setupConfigurationFingerprint")
        saved = current_fingerprint()
        if not (isinstance(loaded, str) and re.fullmatch(r"[a-f0-9]{64}", loaded)
                and saved is not None and saved != loaded):
            return None
        return {"installedVersion": installed, "servingVersion": serving_version,
                "reason": "configuration"}
    return {"installedVersion": installed, "servingVersion": serving_version}


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


def _host_is_cloudways() -> bool:
    """The decisive Cloudways verdict only; fail-soft to an ordinary host."""
    try:
        from . import cloudways

        return cloudways.detect().verdict == cloudways.DETECT_CLOUDWAYS
    except Exception:  # noqa: BLE001 - a classification must not become an outage
        logger.exception("[ocuclaw] cloudways detection unavailable")
        return False


def collect_custom_route_facts(
    phone_address: str,
    extra: Mapping[str, Any],
    relay_port_valid: bool,
    *,
    cloudways_fn: Callable[[], bool] = _host_is_cloudways,
) -> Dict[str, Any]:
    """The config-only half of the custom route check (#5209).

    Passive: canonical form and the Cloudways refusal read only local state.
    DNS, TCP, TLS and the route probe are doctor's bounded active lane, so a
    passive collector leaves them unasked, exactly as it leaves Serve
    reachability to the probe. No `tailscale` command runs in custom mode.
    """
    relay_port: Optional[int] = None
    if relay_port_valid:
        try:
            relay_port = int(extra.get("wsPort", HERMES_BUNDLE_DEFAULT_WS_PORT))
        except (TypeError, ValueError):
            relay_port = None
    stopped = custom_route.static_result(phone_address, is_cloudways=bool(cloudways_fn()))
    return {
        "customPhoneAddress": phone_address,
        "customRouteReason": None if stopped is None else stopped.reason,
        "customRouteObservedAt": snapshot_now_iso(),
        # The loopback port the user's front door must forward to.
        "serveRelayPort": relay_port,
    }


def collect_health_facts(
    *,
    observation_mode: str = OBSERVATION_PASSIVE,
    adapters: Iterable[Any] = (),
    setup_raw_config_fn: Callable[[], Tuple[Dict[str, Any], bool]] = setup_raw_config,
    hermes_version_fn: Callable[[], str] = hermes_version,
    supported_fn: Callable[[str], bool] = hermes_version_supported,
    untested_fn: Callable[[str], bool] = hermes_version_untested,
    supported_range_fn: Callable[[], str] = supported_hermes_range,
    secret_inventory_fn: Callable[[], Dict[str, bool]] = secret_presence_inventory,
    node_fn: Callable[[], Optional[str]] = find_node,
    node_installable_fn: Callable[[], bool] = node_install_available,
    ocuclaw_version_fn: Callable[[], Optional[str]] = ocuclaw_version,
    source_fn: Callable[[str, Optional[Path]], Mapping[str, Any]] = hermes_source,
    profile_name_fn: Callable[[Optional[Path]], Optional[str]] = profile_name,
    resolve_home_fn: Callable[[], Optional[Path]] = resolve_receipt_home,
    read_presence_fn: Callable[..., Any] = read_app_presence,
    read_proof_fn: Callable[..., Any] = read_first_run_proof,
    gateway_facts_fn: Callable[[], Dict[str, Any]] = collect_gateway_facts,
    serve_facts_fn: Callable[[Mapping[str, Any], bool], Dict[str, Any]] = collect_serve_facts,
    runtime_entry: Path = DEFAULT_RUNTIME_ENTRY,
    custom_route_facts_fn: Callable[..., Dict[str, Any]] = collect_custom_route_facts,
    live_reasoning_hooks_fn: Callable[
        [], Tuple[Optional[bool], Optional[bool]]
    ] = live_reasoning_hook_facts,
) -> Dict[str, Any]:
    """Collect the frozen Snapshot v1 facts dict without adapter imports.

    Shared by adapter, CLI, dashboard, Cloudways pairing and uninstall. The
    Desktop fleet publication endpoint does not call this on-demand collector.
    """
    from .plugin_copies import collect_copy_facts
    raw_config, config_readable = setup_raw_config_fn()
    platforms = raw_config.get("platforms")
    platform_config = platforms.get(PLATFORM_NAME, {}) if isinstance(platforms, dict) else {}
    if not isinstance(platform_config, dict):
        platform_config = {}
    extra = platform_config.get("extra")
    if not isinstance(extra, dict):
        extra = {}
    # #3098: the yaml block alone is not what the gateway runs on. Layer the
    # env-seeded platform settings over it so a host configured entirely from
    # `.env` reports the values it will actually gate on — but only where
    # Hermes would really commit that seed, so the read never claims a seed the
    # gateway refused. These three reads are hoisted because the gate needs
    # them; the facts below reuse the same values.
    version = hermes_version_fn()
    secret_inventory = secret_inventory_fn()
    node = node_fn()
    extra = effective_platform_extra(
        extra,
        seed_committed=env_seed_reaches_extra(
            platform_config,
            relay_token_present=bool(secret_inventory.get("relayToken")),
            host_supported=bool(supported_fn(version)),
            node_available=node is not None,
            node_installable=bool(node_installable_fn()),
        ),
    )

    ws_bind = str(extra.get("wsBind") or HERMES_BUNDLE_DEFAULT_WS_BIND).strip()
    relay_port_valid = True
    if "wsPort" in extra:
        try:
            # #7316: a bool is not a port, and YAML `.inf` overflows int().
            relay_port_valid = not isinstance(extra["wsPort"], bool) and 1 <= int(extra["wsPort"]) <= 65535
        except (TypeError, ValueError, OverflowError):
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
    home = resolve_home_fn()
    source_receipt = source_fn(version, home)
    fingerprint = fingerprint_home(home)
    presence_record, presence_status, presence_writer_live = read_presence_fn(fingerprint, home=home)
    proof_record, proof_status = read_proof_fn(fingerprint, home=home)
    live_hooks_available, live_hooks_registered = live_reasoning_hooks_fn()

    facts = blank_facts(
        observedAt=snapshot_now_iso(),
        observationMode=observation_mode,
        profileName=profile_name_fn(home),
        hermesHomeFingerprint=fingerprint,
        profileResolved=home is not None,
        ocuclawVersion=ocuclaw_version_fn(),
        **collect_copy_facts(home, Path(__file__).parent),
        hermesRelease=(
            CERTIFIED_HERMES_TAG
            if source_receipt.get("state") == STATE_CERTIFIED_SOURCE
            else None
        ),
        hermesPackageVersion=version or None,
        hermesSource=source_receipt,
        hermesVersionSupported=supported_fn(version),
        hermesVersionUntested=untested_fn(version),
        supportedHermesRange=supported_range_fn(),
        configReadable=config_readable,
        platformExplicitlyDisabled=platform_config.get("enabled") is False,
        pluginEnabled=isinstance(enabled_plugins, list) and PLATFORM_NAME in enabled_plugins,
        relayBindSafe=ws_bind == HERMES_BUNDLE_DEFAULT_WS_BIND,
        relayPortValid=relay_port_valid,
        evenAiEnabled=bool(extra.get("evenAiEnabled")),
        continueHereConfigured=continue_here_configured(extra),
        streamingConfigured=streaming_configured(raw_config),
        streamingExplicitlyOff=streaming_explicitly_off(raw_config),
        liveReasoningSetting=(
            live_reasoning_setting(raw_config) if config_readable else None
        ),
        liveReasoningHooksAvailable=live_hooks_available,
        liveReasoningHooksRegistered=live_hooks_registered,
        sharedChatsQueueOwed=config_readable
        and shared_chats_queue_owed(raw_config, extra, version),
        multiplexProfiles=multiplex_profiles,
        agentMode=agent_mode,
        secretsPresent=secret_inventory,
        hermesCliOnPath=shutil.which("hermes") is not None,
        nodeRequired=uses_default_runtime,
        nodeAvailable=node is not None,
        runtimeAvailable=not uses_default_runtime or runtime_entry.is_file(),
        adapterLinkReady=any(bool(getattr(adapter, "link_ready", False)) for adapter in adapters),
        appPresenceRecord=presence_record,
        appPresenceStatus=presence_status,
        appPresenceWriterLive=presence_writer_live,
        firstRunProofRecord=proof_record,
        firstRunProofStatus=proof_status,
    )
    facts.update(gateway_facts_fn())
    # #5209: a configured phone address replaces the Serve route entirely.
    phone_address = custom_route.configured_phone_address(extra)
    if phone_address is None:
        facts.update(serve_facts_fn(extra, relay_port_valid))
    else:
        facts.update(custom_route_facts_fn(phone_address, extra, relay_port_valid))
    return facts


__all__ = [
    "OCUCLAW_ALLOW_ADMIN_FROM_ENV",
    "OCUCLAW_EVEN_AI_ENABLED_ENV",
    "OCUCLAW_WEARER_USER_ID",
    "PLATFORM_ENV_TO_KEY",
    "admin_ids_from_extra",
    "continue_here_configured",
    "effective_platform_extra",
    "SHARED_CHATS_EXTRA_KEY",
    "SHARED_CHATS_MIN_HERMES",
    "shared_chats_enabled",
    "shared_chats_requested",
    "env_seed_reaches_extra",
    "platform_env_seed",
    "reset_platform_env_warnings",
    "CERTIFIED_HERMES_COMMIT",
    "CERTIFIED_HERMES_TAG",
    "CERTIFIED_HERMES_VERSION",
    "collect_gateway_facts",
    "collect_custom_route_facts",
    "collect_health_facts",
    "collect_serve_facts",
    "gateway_facts_from_receipt",
]
