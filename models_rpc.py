"""Gateway read-lane RPC handlers (W07 models/status/config plane).

Wire shapes are pinned in PROTOCOL.md "Gateway read lane" and
"Override lane" (identity/profile crossing). Hermes imports stay deferred so
the bundle remains importable outside a Hermes environment; handler bodies run
in a worker thread via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import math
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Set, Tuple

from .overrides import parse_soul_name
from . import desktop_fleet
from .config_writer import replace_config
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
# #6798: what each agent is for (profile.yaml), the text Auto picks by.
GW_METHOD_PROFILES_DESCRIPTION_SET = "gw.profiles.description.set"
GW_METHOD_PROFILES_DESCRIPTION_AUTO = "gw.profiles.description.auto"
# Hermes trims a drafted description to 280; a written one is held to the same.
PROFILE_DESCRIPTION_MAX_CHARS = 280
# One batch runs its drafts side by side and answers well inside the relay's 60 s
# link timeout: up to 4 agents, 25 s each. The phone sends the missing agents 4 at a time.
PROFILE_DESCRIBE_TIMEOUT_S = 25
PROFILE_DESCRIBE_MAX_PROFILES = 4

# #6798: a wearer's description write and a draft's landing never interleave. Hermes's
# ``describe_profile`` checks authorship only before its model call, then writes the
# draft; a wearer who saved words meanwhile bumps the profile's generation, and the
# draft's check-after (under this lock) puts the wearer's words back.
_DESCRIPTION_LOCK = threading.Lock()
_DESCRIPTION_GENERATION: Dict[str, int] = {}
_DESCRIPTION_WEARER: Dict[str, str] = {}
_DESCRIPTION_DRAFTING: Set[str] = set()
GW_METHOD_PROFILES_SETTINGS_GET = "gw.profiles.settings.get"
GW_METHOD_PROFILES_SETTINGS_SET = "gw.profiles.settings.set"
GW_METHOD_PROFILES_SOUL = "gw.profiles.soul"
GW_METHOD_SKILLS_STATUS = "gw.skills.status"
GW_METHOD_COMMANDS_LIST = "gw.commands.list"
GW_METHOD_STARMAP_GRAPH = "gw.starmap.graph"
GW_METHOD_STARMAP_FORGET = "gw.starmap.forget"

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


class ProfileCreateRefused(ValueError):
    """A ``gw.profiles.create`` refusal with a stable, wire-visible code.

    ``error_code`` rides the link error frame as ``error.errorCode``
    (PROTOCOL.md, additive) and the message is one wearer-safe sentence. Still
    a ``ValueError`` so callers that caught the old untyped refusals keep
    working.
    """

    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code


#: Longest display name the creation receipt keeps for a profile.
DISPLAY_NAME_MAX = 80


def _receipt_display_name(home: Optional[Path]) -> Optional[str]:
    """The name the wearer typed when OcuClaw created this profile, if any.

    The profile id is a normalized slug ("Scout" -> "scout"); the creation
    receipt keeps the typed name. Profiles made before this field existed, or
    made outside OcuClaw, have none and callers fall back to the id.
    """
    if home is None:
        return None
    try:
        raw = json.loads((Path(home) / CREATE_RECEIPT_FILENAME).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    name = _clean_str(raw.get("displayName"))
    return name[:DISPLAY_NAME_MAX] if name else None


def _validated_profile_id(
    raw_name: str,
    normalize: Callable[[str], str],
    validate: Callable[[str], Any],
) -> str:
    """Normalize *raw_name* to a native profile id, or refuse with a code.

    ``default`` is the pairing profile and never a new agent:
    ``reserved_agent_id``. Anything the native validator rejects, or that
    normalizes to nothing, is ``invalid_name``. The native message is not
    forwarded: it names CLI rules, not something a wearer can act on.
    """
    try:
        canon = normalize(raw_name)
    except (ValueError, TypeError):
        canon = ""
    canon = canon if isinstance(canon, str) else ""
    if canon == "default":
        raise ProfileCreateRefused(
            "reserved_agent_id", "This profile name is reserved. Choose another name."
        )
    if not canon:
        raise ProfileCreateRefused(
            "invalid_name", "That name can't be used for an agent. Try letters and numbers."
        )
    try:
        validate(canon)
    except ValueError:
        raise ProfileCreateRefused(
            "invalid_name", "That name can't be used for an agent. Try letters and numbers."
        )
    return canon


class ProfileRefused(ValueError):
    """A profile this gateway will not read for the wearer.

    Still a ``ValueError`` with the old message, so readers that let it raise
    keep their behaviour; ``code`` is the wire-safe slug for readers that
    answer with a status instead.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


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


def _read_profile_meta(home: Path) -> Dict[str, Any]:
    """``profile.yaml``'s description fields; an unreadable file reads as none (#6798)."""
    try:
        from .yaml_compat import yaml

        data = yaml.safe_load((home / "profile.yaml").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - missing or broken profile.yaml is "no description"
        return {}
    if not isinstance(data, dict):
        return {}
    description = data.get("description")
    return {
        "description": description.strip() if isinstance(description, str) else "",
        "description_auto": data.get("description_auto") is True,
    }


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


def _profile_avatar(home: Optional[Path]) -> Optional[str]:
    """Hermes Desktop's canonical avatar, including its backfilled bot faces.

    Match profiles.get_asset's format order and magic checks. Bound each read;
    a missing/large asset must never fail the roster or read outside its home.
    """
    if home is None:
        return None
    for ext, mime, checks in (
        ("png", "image/png", ((0, b"\x89PNG\r\n\x1a\n"),)),
        ("jpg", "image/jpeg", ((0, b"\xff\xd8\xff"),)),
        ("webp", "image/webp", ((0, b"RIFF"), (8, b"WEBP"))),
    ):
        try:
            target = home / "assets" / f"avatar.{ext}"
            if not target.resolve().is_relative_to(home.resolve()):
                continue
            with target.open("rb") as asset:
                raw = asset.read(128 * 1024 + 1)
            if len(raw) > 128 * 1024 or not all(raw[start:start + len(magic)] == magic for start, magic in checks):
                continue
            return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
        except (OSError, RuntimeError):
            continue
    return None


_CLASSIC_FACE_SHAPES = ("circle", "squircle", "pill", "triangle", "hexagon", "cloud", "drop")
_LEGACY_FACE_SHAPES = ("blob", "tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron", "pebble", "teardrop", "wedge", "hex")
_BLOB_FACE_KINDS = ("round", "organic", "boxy", "capsule", "nub", "cloud", "droplet", "hexagon", "sun", "triangle")


def _face_shape(value: Any) -> Optional[str]:
    if not isinstance(value, str) or len(value) > 96:
        return None
    if value in _CLASSIC_FACE_SHAPES + _LEGACY_FACE_SHAPES or re.fullmatch(r"sigil-[0-9]{1,4}", value):
        return value
    if value == "blobatar":
        return value
    parts = value.split(":")
    if (len(parts) in (2, 3) and parts[0] == "blobatar" and
            re.fullmatch(r"[a-zA-Z0-9_-]{0,64}", parts[1]) and
            (len(parts) == 2 or parts[2] in _BLOB_FACE_KINDS)):
        return value
    return None


def _face_color(value: Any) -> Optional[str]:
    if not isinstance(value, str) or len(value) > 64:
        return None
    if re.fullmatch(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})", value):
        return value
    if re.fullmatch(r"hsl\([0-9]{1,3}(?:\.[0-9]+)? [0-9]{1,3}(?:\.[0-9]+)?% [0-9]{1,3}(?:\.[0-9]+)?%\)", value):
        return value
    return None


def _profile_appearance(home: Optional[Path], name: str, avatar: Optional[str]) -> Optional[Dict[str, str]]:
    """Allowlisted native BotFace appearance, never arbitrary profile UI data.

    Desktop's 160px PNGs are backfilled vector faces, not chosen photos.
    Match that upstream discriminator, respecting its explicit photo/pet flags.
    Keep the raster alongside appearance for clients that cannot draw the face.
    """
    meta: Dict[str, Any] = {}
    if home is not None:
        try:
            from .yaml_compat import yaml
            path = home / "profile.yaml"
            if not path.resolve().is_relative_to(home.resolve()):
                return None
            with path.open("rb") as source:
                raw = source.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                return None
            document = yaml.safe_load(raw.decode("utf-8"))
            ui_meta = document.get("ui_meta") if isinstance(document, dict) else None
            bots = ui_meta.get("hermes-bots") if isinstance(ui_meta, dict) else None
            if isinstance(bots, dict):
                meta = bots
        except FileNotFoundError:
            pass
        except Exception:  # noqa: BLE001 - broken metadata preserves the static fallback
            return None
    if meta.get("imageKind") == "photo" or meta.get("pet"):
        return None
    if avatar is None and home is not None:
        try:
            # An existing image that failed the bounded raster read might be
            # a chosen photo. Do not turn it into an unrelated generated face.
            if any((home / "assets" / f"avatar.{ext}").exists() for ext in ("png", "jpg", "webp")):
                return None
        except (OSError, RuntimeError):
            return None
    if avatar:
        is_face = False
        if avatar.startswith("data:image/png;base64,"):
            try:
                header = base64.b64decode(avatar.split(",", 1)[1][:48])
                is_face = len(header) >= 24 and header[16:24] == (160).to_bytes(4, "big") * 2
            except (ValueError, TypeError):
                pass
        if not is_face:
            return None
    # Hermes profile names are ASCII slugs, so both native JS hashes agree.
    hashed = 0
    for char in name:
        hashed = (hashed * 31 + ord(char)) & 0xFFFFFFFF
    if name.strip().lower() == "default" and not meta.get("custom"):
        return {"shape": "squircle", "color": "#8b5cf6", "name": name}
    return {
        "shape": _face_shape(meta.get("shape")) or _CLASSIC_FACE_SHAPES[hashed % len(_CLASSIC_FACE_SHAPES)],
        "color": _face_color(meta.get("color")) or (f"hsl({hashed % 360} 68% 58%)" if name != "default" else "#8b5cf6"),
        "name": name,
    }


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
        shared_chats_provider: Optional[Callable[[], bool]] = None,
        auto_route_provider: Optional[Callable[[], bool]] = None,
    ) -> None:
        self._namespace = namespace or DEFAULT_NAMESPACE
        self._create_lock = PROFILE_MUTATION_LOCK
        self._platform_name = platform_name
        # Continue here (#2509): whether `/resume --all` is sanctioned on this
        # host (`allow_admin_from` lists the wearer id). Read live per list so
        # the capability snapshot tracks the config the gateway booted with.
        self._adopt_supported_provider = adopt_supported_provider
        # Shared chats (Hermes 0.23+, on by default): Continue here without the
        # single-driver lock. Read live per list, like the adopt posture.
        self._shared_chats_provider = shared_chats_provider
        # Auto agent (#6795, opt-in): the host switch is on and the router's
        # auxiliary task registered. Read live per list.
        self._auto_route_provider = auto_route_provider
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
            GW_METHOD_PROFILES_DESCRIPTION_SET: self.profiles_description_set,
            GW_METHOD_PROFILES_DESCRIPTION_AUTO: self.profiles_description_auto,
            GW_METHOD_PROFILES_SETTINGS_GET: self.profiles_settings_get,
            GW_METHOD_PROFILES_SETTINGS_SET: self.profiles_settings_set,
            GW_METHOD_PROFILES_SOUL: self.profiles_soul,
            GW_METHOD_SKILLS_STATUS: self.skills_status,
            GW_METHOD_COMMANDS_LIST: self.commands_list,
            GW_METHOD_STARMAP_GRAPH: self.starmap_graph,
            GW_METHOD_STARMAP_FORGET: self.starmap_forget,
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

    async def profiles_description_set(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_description_set, params)

    async def profiles_description_auto(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_profiles_description_auto, params)

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

    async def starmap_graph(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_starmap_graph, params)

    async def starmap_forget(self, params: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._sync_starmap_forget, params)

    @contextlib.contextmanager
    def _profile_home_scope(self, params: Any) -> Iterator[None]:
        """Run a read against the served profile ``params["ns"]`` names.

        ``load_config()``, the credential pool and the usage fetchers resolve
        the gateway's own Hermes home. A multiplexed profile keeps its models,
        defaults and accounts in its own home, so the read is scoped with
        hermes' context-local home override. No ``ns``, the default namespace,
        a profile this gateway does not serve, or a Hermes without the
        override keep the gateway-home read.
        """
        p = params if isinstance(params, dict) else {}
        ns = _clean_str(p.get("ns"))
        reset = None
        token = None
        if ns and ns != DEFAULT_NAMESPACE:
            multiplex, served_homes = self._routing_snapshot()
            home = served_homes.get(ns) if multiplex else None
            if home is not None:
                try:
                    from hermes_constants import (
                        reset_hermes_home_override,
                        set_hermes_home_override,
                    )

                    token = set_hermes_home_override(home)
                    reset = reset_hermes_home_override
                except Exception:  # noqa: BLE001 - older Hermes: gateway-home read
                    reset = None
        try:
            yield
        finally:
            if reset is not None:
                reset(token)

    def _sync_list_models(self, params: Any) -> Dict[str, Any]:
        with self._profile_home_scope(params):
            return self._list_models_in_scope()

    def _list_models_in_scope(self) -> Dict[str, Any]:
        config = self._load_config()
        configured = self._configured_from_snapshot(config)
        try:
            from agent.models_dev import get_model_info
        except Exception:  # noqa: BLE001
            get_model_info = lambda *_: None

        rows: List[Dict[str, Any]] = []
        seen: Set[Tuple[str, str]] = set()
        for provider_entry in self._model_provider_catalog(config):
            provider = _clean_str(provider_entry.get("slug"))
            if not provider:
                continue
            if not self._provider_enabled(config, provider):
                continue
            provider_rows: List[Tuple[Tuple[str, str], Dict[str, Any]]] = []
            local_seen: Set[Tuple[str, str]] = set()
            try:
                for raw_mid in provider_entry.get("models", []):
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
    def _model_provider_catalog(config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Use Hermes's own authenticated picker, including OAuth-only catalogs.

        models.dev is metadata, not account availability: notably Nous and
        Codex can have a catalog without any matching models.dev provider.
        Let Hermes own credential lookup, exclusions, aliases and caching.
        """
        try:
            from hermes_cli.model_switch import list_authenticated_providers
        except ImportError:
            list_authenticated_providers = None
        if callable(list_authenticated_providers):
            import inspect

            model = config.get("model")
            model = model if isinstance(model, dict) else {}
            options = {
                "current_provider": _clean_str(model.get("provider")) or "",
                "current_model": _clean_str(model.get("default")) or "",
                "current_base_url": _clean_str(model.get("base_url")) or "",
                "user_providers": config.get("providers"),
                "custom_providers": config.get("custom_providers"),
                "excluded_providers": config.get("excluded_providers"),
                "max_models": None,
                "probe_custom_providers": False,
                "non_blocking_catalogs": True,
            }
            try:
                # Older supported releases predate the cache-only flag.
                parameters = inspect.signature(list_authenticated_providers).parameters
                result = list_authenticated_providers(**{
                    key: value for key, value in options.items() if key in parameters
                })
                return [row for row in result if isinstance(row, dict)]
            except Exception:  # noqa: BLE001 - keep configured routes on auth/catalog failure
                return []
        # Compatibility with hosts that predate the authenticated picker.
        try:
            from agent.models_dev import list_provider_models
            from hermes_cli.models import CANONICAL_PROVIDERS

            rows = []
            for entry in CANONICAL_PROVIDERS:
                provider = _clean_str(getattr(entry, "slug", None))
                if provider:
                    try:
                        rows.append({"slug": provider, "models": list_provider_models(provider)})
                    except Exception:  # noqa: BLE001
                        continue
            return rows
        except Exception:  # noqa: BLE001
            return []

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

    def _sync_configured(self, params: Any) -> Dict[str, Any]:
        with self._profile_home_scope(params):
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
        default_provider: Optional[str] = None
        default = self._configured_default(self._load_config())
        if default:
            default_provider = _clean_str(default.get("provider"))
            if default_provider:
                selected.add(default_provider)
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
        candidates = [p for p in ROUTABLE_USAGE_PROVIDERS if p in selected]
        # The profile's own provider always gets a row: a provider plugin may
        # report usage, and otherwise its unavailableReason lets the phone say
        # "usage not reported" instead of silently dropping the card.
        if default_provider and default_provider not in candidates:
            candidates.append(default_provider)
        return candidates

    def _sync_usage_status(self, params: Any) -> Dict[str, Any]:
        with self._profile_home_scope(params):
            return self._usage_status_in_scope()

    def _usage_status_in_scope(self) -> Dict[str, Any]:
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
        receipt_name: Optional[str] = None
        try:
            from hermes_cli.profiles import get_profile_dir

            soul_path = Path(get_profile_dir(profile)) / "SOUL.md"
            if soul_path.is_file():
                soul_name = parse_soul_name(soul_path.read_text(encoding="utf-8"))
            receipt_name = _receipt_display_name(Path(get_profile_dir(profile)))
        except Exception:  # noqa: BLE001
            soul_name = None
        name = soul_name or receipt_name or ("Hermes" if profile == DEFAULT_PROFILE else profile)
        result = {"agentId": profile, "name": name}
        try:
            home = Path(get_profile_dir(profile))
            # OcuClaw's explicit icon choice overrides the synced default.
            # Pass the same profile home used by the catalog's config reader.
            from types import SimpleNamespace
            emoji = self._profile_extra_emoji(SimpleNamespace(name=profile, path=home))
            if emoji:
                result["emoji"] = emoji
            else:
                avatar = _profile_avatar(home)
                if avatar:
                    result["avatar"] = avatar
                appearance = _profile_appearance(home, profile, avatar)
                if appearance:
                    result["appearance"] = appearance
        except Exception:  # noqa: BLE001 - older Hermes keeps its name/glyph fallback
            pass
        return result

    def _profile_extra_emoji(self, profile: Any) -> Optional[str]:
        """``platforms.<platform>.extra.emoji`` from THIS profile's own config.

        OcuClaw owns this explicit glyph override and stores it under the
        profile's ``config.yaml`` (SPEC R19). Native Hermes avatars remain
        available as the default when this override is cleared.

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
        # The control-link frame limit is 1 MiB. Keep room for the roster's
        # other fields even on a host with many customized bot images.
        avatar_budget = 512 * 1024
        for profile in list_profiles():
            profile_name = str(getattr(profile, "name"))
            if profile_name not in routable_profiles:
                continue
            row = {
                "name": profile_name,
                "isDefault": bool(getattr(profile, "is_default")),
            }
            display_name = _clean_str(getattr(profile, "display_name", None))
            if not display_name:
                # The name typed at creation ("Scout" for id "scout"). A
                # receipt that only repeats the id adds nothing to the row.
                typed = _receipt_display_name(_profile_home(profile))
                display_name = typed if typed != profile_name else None
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
                # #6798: one Hermes drafted; the phone offers to redo only these.
                if getattr(profile, "description_auto", False) is True:
                    row["descriptionAuto"] = True
            emoji = self._profile_extra_emoji(profile)
            if emoji:
                row["emoji"] = emoji
            avatar = None if emoji else _profile_avatar(_profile_home(profile))
            if avatar and len(avatar) <= avatar_budget:
                row["avatar"] = avatar
                avatar_budget -= len(avatar)
            if not emoji:
                appearance = _profile_appearance(_profile_home(profile), profile_name, avatar)
                if appearance:
                    row["appearance"] = appearance
            rows.append(row)
        adopt_supported = False
        if self._adopt_supported_provider is not None:
            try:
                adopt_supported = bool(self._adopt_supported_provider())
            except Exception:  # noqa: BLE001 - capability discovery fails closed
                adopt_supported = False
        shared_chats = False
        if self._shared_chats_provider is not None:
            try:
                shared_chats = bool(self._shared_chats_provider())
            except Exception:  # noqa: BLE001 - capability discovery fails closed
                shared_chats = False
        auto_route = False
        if self._auto_route_provider is not None:
            try:
                auto_route = bool(self._auto_route_provider())
            except Exception:  # noqa: BLE001 - capability discovery fails closed
                auto_route = False
        # A one-profile Hermes 0.23 host boots standalone and switches itself
        # to multiple agents when a second profile appears, so "+" works there
        # too (no setup, no restart). Any other standalone host still needs
        # setup, and keeps the phone's "run /ocuclaw-setup" explainer.
        can_create = bool(multiplex) or self._in_place_default_home() is not None
        return {
            "profiles": rows,
            "defaultProfile": DEFAULT_PROFILE,
            "createSupported": can_create,
            "setupSupported": can_create,
            "settingsSupported": True,
            "adoptSupported": adopt_supported,
            "sharedChats": shared_chats,
            "autoRoute": auto_route,
            "desktopFleet": desktop_fleet.read(),
        }

    def route_candidates(self) -> List[Any]:
        """Auto's roster (#6795): the agents this gateway serves for the wearer.

        The same served-and-enrolled set the Agent wheel lists, with what the
        router reads about each one (display name, previous names and the
        ``profile.yaml`` description).
        """
        from hermes_cli.profiles import list_profiles

        from .agent_router import candidates_from_profiles

        return candidates_from_profiles(list_profiles(), sorted(self._routable_profiles()[1]))

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
        default_home = served_homes.get(DEFAULT_NAMESPACE) if multiplex else self._in_place_default_home()
        if default_home is None:
            raise RuntimeError("Hermes profile creation requires gateway multiplexing")
        from hermes_cli.profiles import get_profile_dir, normalize_profile_name, validate_profile_name
        # Imported here, not where it is used: the setup body now runs inside a
        # try that turns failures into `status: "partial"`, and an unimportable
        # yaml must still raise BEFORE the irreversible native create, as it did
        # when this import sat at the top of this method.
        from .yaml_compat import yaml  # noqa: F401 - import-time check; the writer re-imports it

        setup = params["setup"]
        fields, folder, blocked = _validated_setup(setup)
        request_id = params.get("requestId")
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 120:
            raise ValueError("Missing or invalid setup request id")
        raw_name = _clean_str(params.get("name"))
        if not raw_name:
            raise ProfileCreateRefused("invalid_name", "Enter a name for the agent.")
        canon = _validated_profile_id(raw_name, normalize_profile_name, validate_profile_name)
        display_name = raw_name[:DISPLAY_NAME_MAX]
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
        # `displayName` keeps the name as typed; the id is its normalized slug.
        # Not part of the fingerprint: it never changes what setup applies.
        receipt = {
            "requestId": request_id,
            "fingerprint": fingerprint,
            "displayName": display_name,
            RECEIPT_SETUP_KEY: setup,
        }
        # Resolved once, so every exit from this call agrees about whether the
        # wearer must restart Hermes to use the agent they just made.
        restart_required = self._restart_required_to_activate()
        already_exists = ProfileCreateRefused(
            "agent_already_exists", f"A profile named {display_name} already exists."
        )
        if profile_dir.exists():
            try:
                old = json.loads(receipt_path.read_text())
            except (OSError, ValueError):
                raise already_exists
            if not isinstance(old, dict):
                raise already_exists
            if old.get("requestId") != request_id or old.get("fingerprint") != fingerprint:
                # Only a replay of this very request may resume; anything else
                # is the plain "that name is taken" the wearer can act on.
                raise already_exists
            # A receipt from before `displayName` existed resumes under the
            # name this replay carries; the setup below then records it.
            display_name = _clean_str(old.get("displayName")) or display_name
            receipt["displayName"] = display_name
            if old.get("complete"):
                return {"status": "created", "profile": {"id": canon, "name": display_name}, "restartRequired": restart_required}
        else:
            self._create_fresh_profile({"name": raw_name}, may_create=True)
            # Failure here leaves an existing profile, which fails closed above.
            write_private(receipt_path, json.dumps(receipt))
        result = {"status": "created", "profile": {"id": canon, "name": display_name}, "restartRequired": restart_required}
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
        from .yaml_compat import yaml

        not_carried = bootstrap_profile(default_home, profile_dir)
        if not_carried:
            # Names only, never values.
            import logging

            logging.getLogger(__name__).warning(
                "ocuclaw: new agent setup could not copy %s", ", ".join(not_carried)
            )
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
            return {"status": "finished", "profile": {
                "id": canon, "name": _clean_str(receipt.get("displayName")) or canon,
            }}
        finally:
            self._create_lock.release()

    def _in_place_default_home(self) -> Optional[Path]:
        """The default home, when creating a profile switches this standalone
        gateway to multiple agents in place; else None.

        See :func:`.profile_routes.create_switches_on_in_place`. Fails closed.
        """
        try:
            from .profile_routes import create_switches_on_in_place, resolve_default_home

            home = resolve_default_home()
            if home is None or not create_switches_on_in_place(home):
                return None
            return Path(home).resolve()
        except Exception:  # noqa: BLE001 - capability discovery fails closed
            return None

    def _create_fresh_profile(self, params: Any, *, may_create: bool = False) -> Dict[str, Any]:
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
        # `may_create`: the caller already settled this, on the same reads,
        # including the one-profile in-place case.
        if not may_create and not self._routing_snapshot()[0]:
            raise RuntimeError(
                "Hermes profile creation requires gateway multiplexing"
            )
        p = params if isinstance(params, dict) else {}
        raw_name = _clean_str(p.get("name"))
        if not raw_name:
            raise ProfileCreateRefused("invalid_name", "Enter a name for the agent.")

        from hermes_cli.profiles import (
            check_alias_collision,
            create_profile,
            create_wrapper_script,
            normalize_profile_name,
            seed_profile_skills,
            validate_profile_name,
        )

        canon = _validated_profile_id(raw_name, normalize_profile_name, validate_profile_name)
        try:
            profile_dir = create_profile(name=canon)
        except FileExistsError:
            raise ProfileCreateRefused(
                "agent_already_exists", f"A profile named {raw_name[:DISPLAY_NAME_MAX]} already exists."
            )

        # Match `hermes profile create`: fresh profiles receive the bundled
        # skills, and a shell alias is created only when it does not collide.
        # Both helpers are best-effort in Hermes's own CLI; profile creation is
        # already complete if either returns no result.
        seed_profile_skills(profile_dir, quiet=True)
        if not check_alias_collision(canon):
            create_wrapper_script(canon)

        return {
            "status": "created",
            "profile": {"id": canon, "name": raw_name[:DISPLAY_NAME_MAX]},
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

        from hermes_cli.config import read_user_config_raw

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

        # Clearing drops keys on purpose; 0.21.6+ refuses that through the
        # plain writer.
        replace_config(config_path, raw_cfg)
        return {
            "status": "updated",
            "profile": {"id": profile_id, "name": profile_id},
            "emoji": emoji,
        }

    def _served_profile_home(self, profile_id: str) -> Path:
        """The home of one profile this gateway serves; raises like the emoji write."""
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
        if home is None or not home.is_dir():
            raise RuntimeError("profile directory could not be resolved")
        return home

    def _sync_profiles_description_set(self, params: Any) -> Dict[str, Any]:
        """#6798: the wearer's own description, stored as user-authored.

        Hermes's ``write_profile_meta`` with ``description_auto=False`` marks it the
        wearer's, so "Write missing ones for me" never replaces it. A blank one
        clears it; Auto then reads the agent as undescribed.
        """
        p = params if isinstance(params, dict) else {}
        profile_id = _clean_str(p.get("profileId"))
        if not profile_id:
            raise ValueError("profile id is required")
        raw = p.get("description")
        if not isinstance(raw, str):
            raise ValueError("description must be a string")
        description = raw.strip()
        if len(description) > PROFILE_DESCRIPTION_MAX_CHARS or "\x00" in description:
            raise ValueError("description is too long")
        home = self._served_profile_home(profile_id)
        from hermes_cli.profiles import write_profile_meta

        with _DESCRIPTION_LOCK:
            write_profile_meta(home, description=description, description_auto=False)
            _DESCRIPTION_GENERATION[profile_id] = _DESCRIPTION_GENERATION.get(profile_id, 0) + 1
            _DESCRIPTION_WEARER[profile_id] = description
        return {
            "status": "updated",
            "profile": {"id": profile_id, "name": profile_id},
            "description": description,
            "descriptionAuto": False,
        }

    def _sync_profiles_description_auto(self, params: Any) -> Dict[str, Any]:
        """#6798: Hermes drafts a description for each named agent that has none.

        A description the wearer wrote is never sent to Hermes at all, and Hermes's
        ``describe_profile`` refuses to overwrite one too (``overwrite=False``). Each
        draft is stored with ``description_auto: true``. The drafts run side by side,
        each bounded, and one failure never stops the rest.
        """
        p = params if isinstance(params, dict) else {}
        raw_ids = p.get("profileIds")
        if not isinstance(raw_ids, list):
            raise ValueError("profile ids are required")
        profile_ids: List[str] = []
        for value in raw_ids:
            profile_id = _clean_str(value) if isinstance(value, str) else None
            if profile_id and profile_id not in profile_ids:
                profile_ids.append(profile_id)
        if not profile_ids or len(profile_ids) > PROFILE_DESCRIBE_MAX_PROFILES:
            raise ValueError("profile ids are required")
        from hermes_cli.profile_describer import describe_profile
        from hermes_cli.profiles import write_profile_meta

        def one(profile_id: str) -> Dict[str, Any]:
            try:
                home = self._served_profile_home(profile_id)
            except (ValueError, RuntimeError):
                return {"profileId": profile_id, "ok": False, "reason": "not_served"}
            with _DESCRIPTION_LOCK:
                meta = _read_profile_meta(home)
                if meta.get("description") and not meta.get("description_auto"):
                    return {"profileId": profile_id, "ok": False, "reason": "user_authored"}
                # One draft per agent at a time: a second batch never races the first.
                if profile_id in _DESCRIPTION_DRAFTING:
                    return {"profileId": profile_id, "ok": False, "reason": "busy"}
                _DESCRIPTION_DRAFTING.add(profile_id)
                generation = _DESCRIPTION_GENERATION.get(profile_id, 0)
            try:
                try:
                    outcome = describe_profile(profile_id, overwrite=False, timeout=PROFILE_DESCRIBE_TIMEOUT_S)
                except Exception:  # noqa: BLE001 - one draft failing never stops the rest
                    return {"profileId": profile_id, "ok": False, "reason": "failed"}
                with _DESCRIPTION_LOCK:
                    if _DESCRIPTION_GENERATION.get(profile_id, 0) != generation:
                        # The wearer saved words while the draft ran: theirs stand.
                        wearer = _DESCRIPTION_WEARER.get(profile_id, "")
                        try:
                            write_profile_meta(home, description=wearer, description_auto=False)
                        except Exception:  # noqa: BLE001 - reported as not drafted
                            pass
                        return {"profileId": profile_id, "ok": False, "reason": "user_authored"}
            finally:
                with _DESCRIPTION_LOCK:
                    _DESCRIPTION_DRAFTING.discard(profile_id)
            description = _clean_str(getattr(outcome, "description", None))
            if getattr(outcome, "ok", False) and description:
                return {"profileId": profile_id, "ok": True, "description": description}
            reason = str(getattr(outcome, "reason", "") or "")
            return {
                "profileId": profile_id,
                "ok": False,
                "reason": "user_authored" if "user-authored" in reason else "failed",
            }

        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=min(4, len(profile_ids))) as pool:
            results = list(pool.map(one, profile_ids))
        return {"status": "ok", "results": results}

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
        # LiveUI V2 A6: a non-local terminal backend runs the agent's tools
        # elsewhere, so its paths are not this host's and picture files refuse.
        terminal_backend = _clean_str(cfg_get(cfg, "terminal", "backend")) or ""
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
        display_name = (
            _clean_str(getattr(profile, "display_name", None))
            or _receipt_display_name(home)
            or profile_id
        )
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
            **({"terminalBackend": terminal_backend} if terminal_backend else {}),
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
        from .yaml_compat import yaml
        from hermes_cli.config import read_user_config_raw

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
            # Cleared fields drop keys on purpose (see replace_config).
            replace_config(config_path, cfg)
        except Exception as exc:
            raise RuntimeError(
                "Instructions were saved, but the other settings were not. Reload before trying again."
            ) from exc
        return {
            **self._sync_profiles_settings_get({"profileId": profile_id}),
            "status": "updated",
            "restartRequired": False,
        }

    def _served_profile_dir(self, requested: Any) -> Path:
        """The home of one served AND enrolled profile, or :class:`ProfileRefused`.

        ``requested`` is a namespace or profile name; ``""``/``main`` is the
        default profile. #2940: profile content (SOUL.md, the Star Map's skills
        and memories) is the agent's own, and before this gate any direct RPC
        could read it for a profile the wearer had never enrolled, simply by
        naming it. Hiding the menu row was never enough.
        """
        profile = profile_for_namespace(requested)
        if profile not in self._routable_profiles()[1]:
            raise ProfileRefused(
                "profile_not_served", "profile is not served by this gateway"
            )
        try:
            from hermes_cli.profiles import get_profile_dir

            profile_dir = Path(get_profile_dir(profile))
        except Exception as exc:  # noqa: BLE001
            raise ProfileRefused(
                "profile_not_found", f"no such profile: {profile}"
            ) from exc
        if not profile_dir.exists():
            raise ProfileRefused("profile_not_found", f"no such profile: {profile}")
        return profile_dir

    def _sync_profiles_soul(self, params: Any) -> Dict[str, Any]:
        p = params if isinstance(params, dict) else {}
        profile_dir = self._served_profile_dir(p.get("profile", self._namespace))
        soul_path = profile_dir / "SOUL.md"
        if not soul_path.is_file():
            return {"content": ""}
        return {"content": soul_path.read_text(encoding="utf-8")}

    def _sync_starmap_graph(self, params: Any) -> Dict[str, Any]:
        """The Star Map sky for one served profile (PROTOCOL.md "Gateway read lane").

        Never raises: a thrown error crosses the link as a bare -32000 and the
        bridge could no longer tell "this profile" from "this host". Refusals
        and failures come back as ``status:"error"`` with a short ``errorCode``.
        """
        from .star_map_rpc import empty, read_star_map

        p = params if isinstance(params, dict) else {}
        try:
            home = self._served_profile_dir(p.get("profile", self._namespace))
        except ProfileRefused as exc:
            return empty("error", exc.code)
        except Exception:  # noqa: BLE001
            return empty("error", "starmap_failed")
        try:
            return read_star_map(home)
        except Exception:  # noqa: BLE001 - read_star_map already never raises
            return empty("error", "starmap_failed")

    def _sync_starmap_forget(self, params: Any) -> Dict[str, Any]:
        """Forget one star of one served profile (PROTOCOL.md ``gw.starmap.forget``).

        Same served-AND-enrolled gate as ``gw.starmap.graph``, and it never
        raises for the same reason: a refusal keeps its ``errorCode``.
        """
        from .star_map_rpc import forget_star

        p = params if isinstance(params, dict) else {}
        try:
            home = self._served_profile_dir(p.get("profile", self._namespace))
        except ProfileRefused as exc:
            return {"status": "error", "errorCode": exc.code}
        except Exception:  # noqa: BLE001
            return {"status": "error", "errorCode": "forget_failed"}
        try:
            return forget_star(home, p.get("id"), p.get("kind"), p.get("text"))
        except Exception:  # noqa: BLE001 - forget_star already never raises
            return {"status": "error", "errorCode": "forget_failed"}

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
