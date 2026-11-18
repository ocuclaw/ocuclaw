"""Hermes's Bot Screen for the OcuClaw Node runtime (#5146).

The Node child reads the screen's RFB socket itself, watch-only
(``extensions/ocuclaw/src/tools/bot-screen/``). This module gives it the facts
only Hermes's own code knows:

- :func:`hello_config`: where the served profile's socket is, and what the probe
  of Hermes's bot-desktop modules found. It rides the hello as
  ``botScreenSocket`` and ``botScreenProbe``.
- :func:`status`: running, off, missing, sandboxed or unsupported, read from
  ``tools.bot_desktop.runtime.status()``. Child -> parent RPC ``botScreen.status``.
- :func:`snapshot`: one grey picture of a screen placed inside the terminal
  sandbox, where no socket is on this host, from Hermes's own thumbnail grab,
  plus its RGB bytes when the phone's colour view asked (``color: true``).
  Child -> parent RPC ``botScreen.snapshot``.
- :class:`ToolTargets` (#5147): where the bot's next ``computer_use`` pointer
  action lands, in screen pixels, read from its last full-screen capture.
  Parent -> child event ``botScreenTarget``, so the Follow view can cut there
  before the click lands.
- :meth:`ToolTargets.step` (#5148): what the bot is about to do, for the Bot
  Screen view's caption: the action, the element's label and the app from the
  last capture, a named key or shortcut, how many characters it types. Never
  the typed text or a set value. Parent -> child event ``botScreenStep``.
- :class:`ScreenTurns` (#5151): which turns use the screen. The first ``computer_use``
  call of a turn is a screen run: parent -> child event ``botScreenRun``, the glasses'
  Peek. A ``clarify`` raised in such a turn is a screen ask: the glasses' Needs you
  card. :data:`PROMPT_NOTE` asks the bot to raise one for a login, a code, a CAPTCHA or
  a payment, in OcuClaw chats while the screen runs.
- :class:`ApprovalViews` (#5152): what a ``computer_use`` approval is for, so
  the glasses card can show the screen with the target boxed. Hermes words that
  approval with the text a ``type`` call types; :func:`approval_command` is the
  same line without it, and the card's facts ride the approval as ``botScreen``.

- :func:`start` (#7571 follow-up): the wearer's Start button and the agent's
  ``show_bot_screen`` tool start an installed screen that is off, through Hermes's own
  ``runtime.start``. Child -> parent RPC ``botScreen.start``.

The bot-desktop modules are Hermes internals (first shipped in v2026.9.24, inside
OcuClaw's supported range). Every use sits behind a probe and never raises: a
missing or changed internal makes the screen watch-only, or "unsupported", never a
crash and never a guess. Only :func:`start` starts the screen, and only an installed
one that is off, with Hermes's own checks. Nothing here stops, installs or drives the
screen, nothing lowers Hermes's memory floor, and nothing logs a pixel.
"""

from __future__ import annotations

import ast
import base64
import importlib
import io
import json
import logging
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

STATUS_METHOD = "botScreen.status"
SNAPSHOT_METHOD = "botScreen.snapshot"
START_METHOD = "botScreen.start"
# Hermes's own start waits this long for the launcher to publish its display (its default).
START_WAIT_S = 15.0
TARGET_EVENT = "botScreenTarget"
STEP_EVENT = "botScreenStep"
ELEMENTS_EVENT = "botScreenElements"
# The head pointer (#5155) snaps to at most this many of the last capture's elements.
ELEMENTS_MAX = 100
RUN_EVENT = "botScreenRun"
# A snapshot crosses the link as one NDJSON line (LINK_MAX_LINE_BYTES is 1 MiB);
# 720x450 grey bytes are about 430 KB once base64 encoded.
SNAPSHOT_MAX = (720, 450)
# A colour snapshot carries grey and RGB bytes (4 a pixel): 512x320 is about 870 KB
# once base64 encoded, still one line. Matches BOT_SCREEN_SNAPSHOT_COLOR_MAX in Node.
SNAPSHOT_COLOR_MAX = (512, 320)
SNAPSHOT_MIN = (16, 16)

_LEASE_MODULE = "tools.bot_desktop.lease"
_RUNTIME_MODULE = "tools.bot_desktop.runtime"
_THUMBNAIL_MODULE = "tools.bot_desktop.thumbnail"
_LEASE_API = ("get", "acquire", "release", "viewer_may_send_input", "AGENT", "HUMAN", "Lease")
# The Node side reads lease.json directly, so the record must still have these fields.
_LEASE_FIELDS = ("holder", "viewer_id", "since", "reason", "epoch")
_RUNTIME_API = ("status",)
_START_API = ("status", "start")
_THUMBNAIL_API = ("thumbnail_data_url",)
_GEOMETRY = re.compile(r"^\s*(\d{2,5})\s*x\s*(\d{2,5})\s*$")
_PLACEMENT = re.compile(r"^[a-z]+(:[a-z0-9_-]{1,32})?$")


def _module(name: str, api: tuple) -> Optional[Any]:
    """The module when it imports and has every name in ``api``; else None. Never raises."""
    try:
        mod = importlib.import_module(name)
    except Exception:
        return None
    return mod if all(hasattr(mod, attr) for attr in api) else None


def _lease_module() -> Optional[Any]:
    mod = _module(_LEASE_MODULE, _LEASE_API)
    if mod is None:
        return None
    fields = getattr(getattr(mod, "Lease", None), "__dataclass_fields__", None)
    if not isinstance(fields, dict) or not all(f in fields for f in _LEASE_FIELDS):
        return None
    if getattr(mod, "AGENT", None) != "agent" or getattr(mod, "HUMAN", None) != "human":
        return None
    return mod


def probe() -> Dict[str, bool]:
    """Which bot-desktop facts this Hermes can give. All False on a Hermes without a Bot Screen.

    ``start`` (add-only): this parent answers ``botScreen.start`` and Hermes has
    ``runtime.start``, so the phone may offer its Start button. An older child ignores it.
    """
    return {
        "lease": _lease_module() is not None,
        "status": _module(_RUNTIME_MODULE, _RUNTIME_API) is not None,
        "snapshot": _module(_THUMBNAIL_MODULE, _THUMBNAIL_API) is not None,
        "start": _module(_RUNTIME_MODULE, _START_API) is not None,
    }


def hello_config(home: Optional[Path]) -> Dict[str, Any]:
    """The hello fields for the Node child, or nothing when this Hermes has no Bot Screen.

    The socket path follows Hermes's layout (tools/bot_desktop/runtime.py): one screen
    per profile under ``<HERMES_HOME>/bot-desktop/``. The path is named even while the
    screen is off; the child checks it is there before it connects.
    """
    if home is None:
        return {}
    found = probe()
    if not found["status"]:
        return {}
    return {
        "botScreenSocket": str(Path(home) / "bot-desktop" / "rfb.sock"),
        "botScreenProbe": found,
    }


def _geometry(raw: Any) -> Optional[Dict[str, int]]:
    match = _GEOMETRY.match(raw) if isinstance(raw, str) else None
    if not match:
        return None
    return {"w": int(match.group(1)), "h": int(match.group(2))}


def status() -> Dict[str, Any]:
    """The screen's state for the glasses. Never raises.

    Only the state, size and placement cross: never the display, socket, pid, install
    command or browser path Hermes's status also carries.
    """
    runtime = _module(_RUNTIME_MODULE, _RUNTIME_API)
    if runtime is None:
        return {"v": 1, "state": "unsupported", "screen": None, "placement": None}
    try:
        raw = runtime.status()
        data = raw.as_dict() if hasattr(raw, "as_dict") else dict(vars(raw))
    except Exception as exc:  # a Hermes internal changed or failed: say so, do not guess
        logger.info("ocuclaw bot screen: status unavailable (%s)", type(exc).__name__)
        return {"v": 1, "state": "unknown", "screen": None, "placement": None, "code": "status_failed"}
    placement = data.get("placement") if isinstance(data.get("placement"), str) else "gateway"
    if not _PLACEMENT.match(placement):
        placement = None
    if data.get("supported") is False:
        state = "unsupported"
    elif placement and placement.startswith("terminal"):
        # A sandbox always reads "installed" (#6019); its image's missing desktop
        # packages show only in ``missing``, once the sandbox exists.
        missing = data.get("missing")
        state = "missing" if isinstance(missing, list) and missing else "sandboxed"
    elif not data.get("installed"):
        state = "missing"
    elif data.get("running"):
        state = "running"
    else:
        state = "off"
    out = {
        "v": 1,
        "state": state,
        "screen": _geometry(data.get("geometry")),
        "placement": placement,
        "running": bool(data.get("running")),
    }
    need = _need(runtime, state, placement, data)
    if need:
        out["need"] = need
        if _cloudways_host():
            out["host"] = "cloudways"
        if need == "host":
            # #7571: add-only. `need` stays "host" so an older phone keeps its card; a newer
            # one offers OcuClaw's no-admin install ("ready") or names the bigger plan ("memory").
            rootless = _rootless_offer()
            if rootless:
                out["rootless"] = rootless
    return out


def _need(runtime: Any, state: str, placement: Optional[str], data: Dict[str, Any]) -> Optional[str]:
    """Why this host cannot have a screen at all, in a word, or None.

    ``memory``: installed and off, and Hermes would refuse to start it for want of free memory
    (on the gateway host its status ``blocker`` is only ever that). ``host``: not installed,
    and this process can never install it (unprivileged, no sudo: a managed container).
    Only the word crosses, never Hermes's own sentence. Never raises."""
    if placement != "gateway":
        return None
    if state == "off" and isinstance(data.get("blocker"), str) and data["blocker"]:
        return "memory"
    if state == "missing":
        installable = getattr(runtime, "installable", None)
        try:
            if callable(installable) and installable() is False:
                return "host"
        except Exception:
            return None
    return None


def _cloudways_host() -> bool:
    """The cached Cloudways verdict, so the phone can name Cloudways' own upgrade path. Never raises."""
    try:
        from .optional_setup_rpc import cloudways_host

        return cloudways_host()
    except Exception:
        return False


def _rootless_offer() -> Optional[str]:
    """#7571: whether OcuClaw's no-admin install could run here (``ready``), or could but Hermes's
    memory check would refuse the screen (``memory``); None otherwise. Never raises."""
    try:
        from .bot_screen_rootless import offer

        return offer()
    except Exception:
        return None


#: Why a start did not happen, in a word (the phone shows the matching card; never Hermes's sentence).
#: ``memory``: Hermes's free-memory floor refused it. ``missing``: not installed (or a sandbox image
#: without the desktop). ``unsupported``: this Hermes has no Bot Screen, or no ``runtime.start``.
#: ``sandboxed``: the screen lives in the terminal sandbox, which this never starts. ``unknown``: the
#: status could not be read. ``start_failed``: Hermes tried and it did not come up.
START_CODES = frozenset({"memory", "missing", "unsupported", "sandboxed", "unknown", "start_failed"})


def start(wait_seconds: float = START_WAIT_S) -> Dict[str, Any]:
    """Start this profile's installed screen if it is off, with Hermes's own ``runtime.start``.

    Blocking (Hermes waits up to ``wait_seconds`` for the display): call it from a worker
    thread, inside the profile's runtime scope. Never raises, never installs, never lowers
    Hermes's memory floor, and never starts a terminal sandbox. Returns
    ``{v:1, ok, state, already?, code?}``: ``ok`` with ``already:true`` when it was running
    before; else ``ok:false`` and a word from :data:`START_CODES`. ``state`` is the status
    after, as :func:`status` says it, so the phone's card can follow at once.
    """
    runtime = _module(_RUNTIME_MODULE, _START_API)
    if runtime is None:
        return {"v": 1, "ok": False, "code": "unsupported", "state": status().get("state", "unsupported")}
    before = status()
    state = before.get("state")
    if state == "running":
        return {"v": 1, "ok": True, "already": True, "state": "running"}
    refusal = _start_refusal(before)
    if refusal:
        return {"v": 1, "ok": False, "code": refusal, "state": state}
    try:
        runtime.start(wait_seconds=wait_seconds)
    except Exception as exc:  # Hermes's RuntimeError names its blocker; only a word crosses
        after = status()
        if after.get("state") == "running":  # another start won the race: it is up
            return {"v": 1, "ok": True, "already": True, "state": "running"}
        code = _start_refusal(after) or (
            "memory" if str(exc).startswith("Not enough free memory") else "start_failed")
        logger.info("ocuclaw bot screen: start refused (%s, %s)", code, type(exc).__name__)
        return {"v": 1, "ok": False, "code": code, "state": after.get("state")}
    after = status()
    if after.get("state") == "running":
        return {"v": 1, "ok": True, "state": "running"}
    return {"v": 1, "ok": False, "code": _start_refusal(after) or "start_failed", "state": after.get("state")}


def _start_refusal(st: Dict[str, Any]) -> Optional[str]:
    """Why a screen in status ``st`` must not be started here, or None for one that is off."""
    state = st.get("state")
    if state == "off":
        return "memory" if st.get("need") == "memory" else None
    return state if state in START_CODES else "unknown"


def _bounded(value: Any, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return high
    return max(low, min(high, number))


def snapshot(max_w: Any = None, max_h: Any = None, color: Any = False) -> Dict[str, Any]:
    """One grey picture of the running screen, at most ``max_w`` x ``max_h``. Never raises.

    For a screen placed inside the terminal sandbox, where there is no socket on this
    host. Hermes's own grab (``thumbnail_data_url``) reaches the screen wherever it
    runs. The picture goes to the Node child and nowhere else: not logged, not stored.

    ``color=True`` (the phone's colour view) also returns ``rgb``: the same picture as
    raw red, green, blue bytes, ``w * h * 3``, next to ``gray``. The size is then bounded
    by :data:`SNAPSHOT_COLOR_MAX` so the reply stays one link line.
    """
    color = color is True
    thumbnail = _module(_THUMBNAIL_MODULE, _THUMBNAIL_API)
    if thumbnail is None:
        return {"v": 1, "gray": None, "reason": "unsupported"}
    limit = SNAPSHOT_COLOR_MAX if color else SNAPSHOT_MAX
    w = _bounded(max_w, SNAPSHOT_MIN[0], limit[0])
    h = _bounded(max_h, SNAPSHOT_MIN[1], limit[1])
    try:
        try:
            data_url = thumbnail.thumbnail_data_url(max_size=(w, h), quality=80)
        except TypeError:
            data_url = thumbnail.thumbnail_data_url()
    except Exception as exc:
        logger.info("ocuclaw bot screen: snapshot unavailable (%s)", type(exc).__name__)
        return {"v": 1, "gray": None, "reason": "grab_failed"}
    if not isinstance(data_url, str) or "," not in data_url:
        return {"v": 1, "gray": None, "reason": "off"}
    try:
        from PIL import Image  # a Hermes dependency; the thumbnail grab already needs it

        source = Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1])))
        rgb_pixels = None
        if color:
            colour = source.convert("RGB")
            colour.thumbnail((w, h))
            rgb_pixels = colour.tobytes()
            image = colour.convert("L")
        else:
            image = source.convert("L")
            image.thumbnail((w, h))
        pixels = image.tobytes()
    except Exception as exc:
        logger.info("ocuclaw bot screen: snapshot unreadable (%s)", type(exc).__name__)
        return {"v": 1, "gray": None, "reason": "decode_failed"}
    out = {"v": 1, "w": image.width, "h": image.height, "gray": base64.b64encode(pixels).decode("ascii")}
    if rgb_pixels is not None:
        out["rgb"] = base64.b64encode(rgb_pixels).decode("ascii")
    return out


# -- tool targets (#5147) and steps (#5148) -------------------------------------

TOOL_NAME = "computer_use"
# The actions of Hermes's computer_use schema (tools/computer_use/schema.py) that put the
# pointer somewhere. `type` and `key` go to whatever has focus, so they have no target.
POINTER_ACTIONS = frozenset({"click", "double_click", "right_click", "middle_click", "drag", "scroll", "set_value"})
# Every action in that schema's enum: a step names one of these or is not sent.
STEP_ACTIONS = frozenset({
    "capture", "click", "double_click", "right_click", "middle_click", "drag", "scroll", "type", "key",
    "set_value", "wait", "list_apps", "list_windows", "focus_app",
})
STEP_LABEL_MAX = 60
STEP_APP_MAX = 40
STEP_KEYS_MAX = 32
SCROLL_DIRECTIONS = frozenset({"up", "down", "left", "right"})
# A key step names the key only when it cannot be typed text: a named key, or a shortcut
# with a modifier other than shift. A printable key, bare or with shift, types one character.
NAMED_KEYS = frozenset({
    "return", "enter", "escape", "esc", "tab", "backspace", "delete", "space", "up", "down", "left", "right",
    "home", "end", "pageup", "pagedown", "insert", "menu", *(f"f{n}" for n in range(1, 25)),
})
SHORTCUT_MODIFIERS = frozenset({"ctrl", "alt", "option", "cmd", "super", "meta", "win", "windows", "fn"})
_KEYS_SHAPE = re.compile(r"[A-Za-z0-9+_-]{1,%d}" % STEP_KEYS_MAX)
# Hermes splits a combo on "+" and "-" (tool.py _canon_key_combo).
_KEY_SEPARATORS = re.compile(r"[+\-]")
# Newlines and other control characters in a name read as one space.
_CONTROL_RUN = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]+")
# Not an app: Hermes's own words for the whole screen and the desktop surface (schema.py `app`).
_NOT_APPS = frozenset({"screen", "desktop"})
# Hermes stops an idle screen after 30 minutes: a capture older than that is of another run.
CAPTURE_MAX_AGE_S = 30 * 60
# A status read reaches into the sandbox for a sandboxed screen, on the agent's thread:
# a running size read this recently stands for the next capture.
SCREEN_TTL_S = 10.0
_CAPTURE_SESSIONS = 8
_SIDE_MAX = 16384
# Hermes's own test that element bounds share the screenshot's space (tool.py _bounds_hints).
_BOUNDS_SLACK = 1.05
# A multimodal capture carries its summary as text (tool.py _capture_summary_lines): a
# "capture mode=som 1440x900 app=<name> window=<repr>" line, then
# "  #<index> <role> <label repr> @ (x, y, w, h) [<app>]" per listed element ("@ bounds-unknown
# (click by element index)" when it has no bounds). The size, the app, each index, its label
# and its four numbers are read; never the role or the window title.
_SUMMARY_SIZE = re.compile(r"^capture mode=[a-z]+ (\d{1,5})x(\d{1,5})(?: |$)")
_SUMMARY_APP = re.compile(r"""^capture mode=[a-z]+ \d{1,5}x\d{1,5} app=(.+?)(?: window=['"].*)?$""")
_SUMMARY_ELEMENT = re.compile(
    r"""^  #(\d{1,6}) [^'"\n]*?('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*") """
    r"""@ (?:[(\[](-?\d{1,6}), (-?\d{1,6}), (\d{1,6}), (\d{1,6})[)\]]|bounds-unknown \(click by element index\))"""
    r"""(?: \[(.*)\])?$"""
)
# A capture lists its first elements only (40 lines in a summary, 100 in a text capture) and
# names a file that holds them all (tool.py _spill_elements_to_file): ``elements_file``, as
# ``{"elements": [{"index", "role", "label", "bounds", "app"}, ...]}``. A browser's own menus
# and toolbar fill the listed ones, so the page's buttons are only in that file. It is read
# for the elements the capture did not list: the same index, bounds, label and app, never a
# role or the window title. Only a file Hermes names that way is opened, and only so much.
_SPILL_NAME = re.compile(r"^elements_[0-9a-f]{32}\.json$")
_SPILL_DIR = "computer_use"
_SPILL_MAX_BYTES = 4 * 1024 * 1024
_SPILL_ELEMENTS_MAX = 2000

Rect = Tuple[int, int, int, int]
Capture = Tuple[int, int, Dict[int, Rect]]


@dataclass(frozen=True)
class _Facts:
    """One capture as this module keeps it. ``labels`` and ``apps`` are by element index."""

    w: int
    h: int
    elements: Dict[int, Rect]
    labels: Dict[int, str]
    apps: Dict[int, str]
    app: Optional[str]


def clean_name(raw: Any, limit: int) -> Optional[str]:
    """[raw] as one line of at most [limit] characters, or None when it is not text or is empty.

    Runs of newlines and control characters become one space; the ends are trimmed."""
    if not isinstance(raw, str):
        return None
    text = _CONTROL_RUN.sub(" ", raw).strip()[:limit].strip()
    return text or None


def _keep_name(into: Dict[int, str], index: int, raw: Any, limit: int) -> None:
    name = clean_name(raw, limit)
    if name is not None:
        into[index] = name


def _capture_app(named: Optional[str], apps: Dict[int, str]) -> Optional[str]:
    """The capture's own app; else the one app all its elements name, when they name one."""
    if named is not None:
        return named
    distinct = set(apps.values())
    return distinct.pop() if len(distinct) == 1 else None


def _int(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _rect(raw: Any) -> Optional[Rect]:
    """``[x, y, w, h]`` of whole numbers with a size, else None (Hermes nulls an unknown one)."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    x, y, w, h = (_int(v) for v in raw)
    if x is None or y is None or w is None or h is None or w <= 0 or h <= 0:
        return None
    return (x, y, w, h)


def _point(raw: Any) -> Optional[Tuple[int, int]]:
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        return None
    x, y = (_int(v) for v in raw)
    return None if x is None or y is None else (x, y)


def _sized(width: Any, height: Any, elements: Dict[int, Rect]) -> Optional[Tuple[int, int]]:
    w, h = _int(width), _int(height)
    if w is None or h is None or not (0 < w <= _SIDE_MAX and 0 < h <= _SIDE_MAX):
        return None
    for x, y, bw, bh in elements.values():
        if x + bw > w * _BOUNDS_SLACK or y + bh > h * _BOUNDS_SLACK:
            return None  # the bounds are in another space than the screenshot
    return w, h


def _keep_items(raw: List[Any], elements: Dict[int, Rect], labels: Dict[int, str], apps: Dict[int, str],
                listed: Optional[set] = None) -> None:
    """Each element dict's bounds, label and app by its index; one in [listed] is left as it is."""
    for item in raw:
        if not isinstance(item, dict):
            continue
        index = _int(item.get("index"))
        if index is None or index <= 0 or (listed is not None and index in listed):
            continue
        bounds = _rect(item.get("bounds"))
        if bounds is not None:
            elements[index] = bounds
        _keep_name(labels, index, item.get("label"), STEP_LABEL_MAX)
        _keep_name(apps, index, item.get("app"), STEP_APP_MAX)


def _keep_spilled(path: Any, elements: Dict[int, Rect], labels: Dict[int, str], apps: Dict[int, str]) -> None:
    """Adds the elements a capture did not list, from the file it names (:data:`_SPILL_NAME`).

    Hermes tested the listed elements' space (``bounds_scale``), so these are kept as they are:
    one below the fold is off the screen, and a target is cut to the screen when it is sent.
    Anything that does not read as that file leaves the capture as it was listed."""
    if not isinstance(path, str):
        return
    try:
        file = Path(path)
        if not _SPILL_NAME.match(file.name) or file.parent.name != _SPILL_DIR or file.is_symlink():
            return
        if not file.is_file() or file.stat().st_size > _SPILL_MAX_BYTES:
            return
        raw = json.loads(file.read_text(encoding="utf-8")).get("elements")
    except (OSError, ValueError, AttributeError, RecursionError):
        return
    if isinstance(raw, list):
        _keep_items(raw[:_SPILL_ELEMENTS_MAX], elements, labels, apps, set(elements) | set(labels) | set(apps))


def _json_capture(data: Dict[str, Any]) -> Optional[_Facts]:
    raw = data.get("elements")
    if data.get("bounds_scale") or not isinstance(raw, list):
        return None
    elements: Dict[int, Rect] = {}
    labels: Dict[int, str] = {}
    apps: Dict[int, str] = {}
    _keep_items(raw, elements, labels, apps)
    size = _sized(data.get("width"), data.get("height"), elements)
    if size is None:
        return None
    _keep_spilled(data.get("elements_file"), elements, labels, apps)
    return _Facts(size[0], size[1], elements, labels, apps, _capture_app(clean_name(data.get("app"), STEP_APP_MAX), apps))


def _summary_label(token: str) -> Optional[str]:
    """The label from its quoted repr in an element line; None when it does not read back as text."""
    try:
        value = ast.literal_eval(token)
    except (ValueError, SyntaxError, MemoryError, RecursionError):
        return None
    return clean_name(value, STEP_LABEL_MAX)


def _summary_capture(envelope: Dict[str, Any]) -> Optional[_Facts]:
    meta = envelope.get("meta") if isinstance(envelope.get("meta"), dict) else {}
    if meta.get("bounds_scale"):
        return None
    texts = [p.get("text") for p in envelope["content"] if isinstance(p, dict) and p.get("type") == "text"]
    if not texts:
        texts = [envelope.get("text_summary")]
    sizes = set()
    if "width" in meta or "height" in meta:
        sizes.add((meta.get("width"), meta.get("height")))
    named = set()
    elements: Dict[int, Rect] = {}
    labels: Dict[int, str] = {}
    apps: Dict[int, str] = {}
    for text in texts:
        for line in text.splitlines() if isinstance(text, str) else ():
            size = _SUMMARY_SIZE.match(line)
            if size:
                sizes.add((int(size.group(1)), int(size.group(2))))
                app = _SUMMARY_APP.match(line)
                named.add(clean_name(app.group(1), STEP_APP_MAX) if app else None)
                continue
            found = _SUMMARY_ELEMENT.match(line)
            if not found:
                continue
            index = int(found.group(1))
            if index <= 0:
                continue
            if found.group(3) is not None:
                x, y, w, h = (int(found.group(g)) for g in range(3, 7))
                if w > 0 and h > 0:
                    elements[index] = (x, y, w, h)
            label = _summary_label(found.group(2))
            if label is not None:
                labels[index] = label
            _keep_name(apps, index, found.group(7), STEP_APP_MAX)
    if len(sizes) != 1:
        return None
    ((width, height),) = sizes
    size = _sized(width, height, elements)
    if size is None:
        return None
    _keep_spilled(meta.get("elements_file"), elements, labels, apps)
    return _Facts(size[0], size[1], elements, labels, apps, _capture_app(named.pop() if len(named) == 1 else None, apps))


def _read_capture(result: Any) -> Optional[_Facts]:
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (ValueError, RecursionError):
            return None
    if isinstance(result, list):
        result = {"content": result}
    if not isinstance(result, dict):
        return None
    if isinstance(result.get("content"), list):
        return _summary_capture(result)
    return _json_capture(result)


def capture_facts(result: Any) -> Optional[Capture]:
    """``(width, height, {index: (x, y, w, h)})`` of a ``computer_use`` capture result, or None.

    Hermes returns a JSON text (``_text_capture_payload``) or, with a screenshot for a vision
    model, a multimodal envelope: text parts holding the capture summary, and ``meta`` with the
    size. None when the shape is not one of those, or when the capture says its bounds are in
    another space than its pixels (``bounds_scale``). :class:`ToolTargets` also keeps each
    element's label and app and the capture's app (:func:`capture_names`), in memory only,
    for the Bot Screen view's step caption; never a role, a window title or any other text.
    """
    facts = _read_capture(result)
    return None if facts is None else (facts.w, facts.h, facts.elements)


def capture_names(result: Any) -> Optional[Tuple[Optional[str], Dict[int, str], Dict[int, str]]]:
    """``(app, {index: label}, {index: app})`` of a capture :func:`capture_facts` reads, or None.

    Each name is one line, cut to :data:`STEP_LABEL_MAX` / :data:`STEP_APP_MAX` characters."""
    facts = _read_capture(result)
    return None if facts is None else (facts.app, facts.labels, facts.apps)


def _running_screen() -> Optional[Tuple[Any, Any]]:
    """The running Bot Screen's size, from :func:`status`; None when it is not running."""
    st = status()
    screen = st.get("screen")
    if st.get("state") not in ("running", "sandboxed") or not st.get("running") or not isinstance(screen, dict):
        return None
    return (screen.get("w"), screen.get("h"))


def _computer_use_call(kwargs: Any) -> Optional[Tuple[str, str, Dict[str, Any]]]:
    """(session id, action, args) of a ``computer_use`` hook call, else None."""
    if not isinstance(kwargs, dict) or kwargs.get("tool_name") != TOOL_NAME:
        return None
    args = kwargs.get("args")
    if not isinstance(args, dict) or not isinstance(args.get("action"), str):
        return None
    return str(kwargs.get("session_id") or ""), args["action"].strip().lower(), args


def _capture_session(kwargs: Any) -> Optional[str]:
    """The session id of a ``computer_use`` call that captured the screen (``action`` is
    ``capture`` or ``capture_after`` is set), else None."""
    call = _computer_use_call(kwargs)
    if call is None:
        return None
    session, action, args = call
    if action != "capture" and not args.get("capture_after"):
        return None
    return session


def _aimed(action: str, args: Dict[str, Any]) -> Tuple[Any, Optional[Tuple[int, int]]]:
    """(element, point) a pointer action names, read in the order Hermes's backend reads its
    arguments: an element before a coordinate. A drag names its destination."""
    if action == "drag":
        if args.get("from_element") is not None and args.get("to_element") is not None:
            return args.get("to_element"), None
        if args.get("from_coordinate") and args.get("to_coordinate"):
            return None, _point(args.get("to_coordinate"))
        return None, None
    return args.get("element"), (None if action == "set_value" else _point(args.get("coordinate")))


def _aimed_element(action: str, args: Dict[str, Any], facts: _Facts) -> Optional[int]:
    """The index of the element a pointer action acts on: the one it names, else the smallest
    element of the capture whose bounds hold its point. None when there is none."""
    element, point = _aimed(action, args)
    if element is not None:
        index = _int(element)
        return index if index is not None and index > 0 else None
    if point is None:
        return None
    px, py = point
    best: Optional[Tuple[int, int]] = None
    for index, (x, y, w, h) in facts.elements.items():
        if x <= px < x + w and y <= py < y + h and (best is None or (w * h, index) < best):
            best = (w * h, index)
    return None if best is None else best[1]


def _call_app(raw: Any) -> Optional[str]:
    """A call's own ``app`` argument, unless it names the whole screen or the desktop."""
    name = clean_name(raw, STEP_APP_MAX)
    return None if name is None or name.lower() in _NOT_APPS else name


def key_step(keys: Any) -> Dict[str, Any]:
    """What a ``key`` step may say about its ``keys``: ``{"keys": combo}`` for a named key or a
    shortcut with a modifier other than shift, ``{"chars": 1}`` for a printable key, bare or with
    shift (that is typing), else nothing. A combo outside ``[A-Za-z0-9+_-]{1,32}`` is not named."""
    if not isinstance(keys, str) or not keys:
        return {}
    if len(keys) == 1:
        return {"chars": 1} if keys.isprintable() else {}
    compact = "".join(keys.split())
    if not compact:
        return {}
    if len(compact) == 1:
        return {"chars": 1} if compact.isprintable() else {}
    tokens = [t for t in _KEY_SEPARATORS.split(compact) if t]
    pressed = [t for t in tokens if t.lower() not in SHORTCUT_MODIFIERS and t.lower() != "shift"]
    if compact[-1] in "+-" and compact[-2] in "+-":
        pressed.append(compact[-1])  # the "+" or "-" key itself, as in "ctrl+-"
    shortcut = any(t.lower() in SHORTCUT_MODIFIERS for t in tokens)
    if shortcut or (pressed and all(t.lower() in NAMED_KEYS for t in pressed)):
        return {"keys": compact} if _KEYS_SHAPE.fullmatch(compact) else {}
    if len(pressed) == 1 and len(pressed[0]) == 1 and pressed[0].isprintable():
        return {"chars": 1}
    return {}


def _aim(action: str, args: Dict[str, Any], elements: Dict[int, Rect]) -> Optional[Tuple[str, Rect]]:
    """(kind, rect) an action lands on (:func:`_aimed`)."""
    element, point = _aimed(action, args)
    if element is not None:
        index = _int(element)
        bounds = elements.get(index) if index is not None else None
        return ("element", bounds) if bounds is not None else None
    if point is not None:
        return ("point", (point[0], point[1], 1, 1))
    return None


def _clamp(rect: Rect, w: int, h: int) -> Optional[List[int]]:
    """[rect] cut to a w x h screen, or None when none of it is on the screen."""
    x, y, rw, rh = rect
    x0, y0, x1, y1 = max(0, x), max(0, y), min(w, x + rw), min(h, y + rh)
    if x1 <= x0 or y1 <= y0:
        return None
    return [x0, y0, x1 - x0, y1 - y0]


def _element_boxes(facts: _Facts) -> List[Dict[str, Any]]:
    """The capture's elements as ``{rect, label?}``, in index order, each cut to the screen
    (an element fully off it is dropped), at most :data:`ELEMENTS_MAX`."""
    boxes: List[Dict[str, Any]] = []
    for index in sorted(facts.elements):
        rect = _clamp(facts.elements[index], facts.w, facts.h)
        if rect is None:
            continue
        box: Dict[str, Any] = {"rect": rect}
        label = facts.labels.get(index)
        if label is not None:
            box["label"] = label
        boxes.append(box)
        if len(boxes) >= ELEMENTS_MAX:
            break
    return boxes


@dataclass(frozen=True)
class _Remembered:
    facts: _Facts
    at: float


class ToolTargets:
    """Where the bot's next pointer action lands (#5147) and what each step does (#5148), per
    Hermes session.

    :meth:`observe` reads each ``computer_use`` capture in ``post_tool_call``; :meth:`target`
    reads a pointer action and :meth:`step` any action in ``pre_tool_call``. Hermes keeps one
    computer_use backend per session, and its element indices and coordinates are relative to
    that session's last capture. A capture is kept only when its pixels are the Bot Screen's
    own: the whole running screen at its own size, in one coordinate space. Any other capture
    is forgotten, and a target that does not resolve is not sent. The elements a capture did
    not list are read from the file it names (:func:`_keep_spilled`). A kept capture holds each
    element's bounds, label and app and the capture's app (never a role or window title), in
    memory only: the labels and app names go only to the phone's Bot Screen view, in a step,
    and the labels with the element boxes in :meth:`elements` (#5155).
    No method raises.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._wall = wall
        self._lock = threading.Lock()
        self._captures: "OrderedDict[str, _Remembered]" = OrderedDict()
        self._screen: Optional[Tuple[Any, Any]] = None
        self._screen_at = float("-inf")
        self._running = False
        self._running_at = float("-inf")

    def _screen_size(self) -> Optional[Tuple[Any, Any]]:
        """The running screen's size; only a running size is kept, for :data:`SCREEN_TTL_S`."""
        now = self._clock()
        if self._screen is not None and now - self._screen_at < SCREEN_TTL_S:
            return self._screen
        self._screen, self._screen_at = _running_screen(), now
        return self._screen

    def running(self) -> bool:
        """#5151: the screen runs now. Either answer is kept for :data:`SCREEN_TTL_S`, since
        each turn asks (``pre_llm_call``) and a stopped screen's status is the slow one."""
        try:
            now = self._clock()
            if now - self._running_at >= SCREEN_TTL_S:
                self._running, self._running_at = self._screen_size() is not None, now
            return self._running
        except Exception as exc:
            logger.debug("ocuclaw bot screen: no running state (%s)", type(exc).__name__)
            return False

    def observe(self, kwargs: Dict[str, Any]) -> None:
        """post_tool_call: remember or forget the session's last capture."""
        session = _capture_session(kwargs)
        if session is None:
            return
        kept: Optional[_Remembered] = None
        try:
            facts = _read_capture(kwargs.get("result"))
            if facts is not None and (facts.w, facts.h) == self._screen_size():
                kept = _Remembered(facts, self._clock())
        except Exception as exc:  # an unexpected shape: forget, never guess
            logger.debug("ocuclaw bot screen: capture unread (%s)", type(exc).__name__)
        with self._lock:
            self._captures.pop(session, None)
            if kept is not None:
                self._captures[session] = kept
                while len(self._captures) > _CAPTURE_SESSIONS:
                    self._captures.popitem(last=False)

    def _last(self, session: str) -> Optional[_Facts]:
        """The session's last kept capture, unless it is older than :data:`CAPTURE_MAX_AGE_S`."""
        with self._lock:
            capture = self._captures.get(session)
        if capture is None or self._clock() - capture.at > CAPTURE_MAX_AGE_S:
            return None
        return capture.facts

    def elements(self, kwargs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """post_tool_call, right after :meth:`observe`: the ``botScreenElements`` payload for a
        ``computer_use`` call that captured, else None (any other call sends nothing).

        ``{v, elements: [{rect: [x, y, w, h], label?}], at}`` (#5155): the head pointer's snap
        targets. When the capture was kept: its elements in index order, each cut to the screen
        (one fully off it is dropped) with its label when it has one, at most
        :data:`ELEMENTS_MAX`; never a role, app or window title. When the capture was forgotten
        the list is empty, so the glasses drop stale targets."""
        try:
            session = _capture_session(kwargs)
            if session is None:
                return None
            facts = self._last(session)
            return {
                "v": 1,
                "elements": _element_boxes(facts) if facts is not None else [],
                "at": int(self._wall() * 1000),
            }
        except Exception as exc:
            logger.debug("ocuclaw bot screen: no elements (%s)", type(exc).__name__)
            return None

    def target(self, kwargs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """pre_tool_call: the ``botScreenTarget`` payload for a pointer action, or None."""
        try:
            call = _computer_use_call(kwargs)
            if call is None or call[1] not in POINTER_ACTIONS:
                return None
            session, action, args = call
            facts = self._last(session)
            if facts is None:
                return None
            aim = _aim(action, args, facts.elements)
            rect = _clamp(aim[1], facts.w, facts.h) if aim is not None else None
            if rect is None:
                return None
            return {"v": 1, "rect": rect, "kind": aim[0], "at": int(self._wall() * 1000)}
        except Exception as exc:
            logger.debug("ocuclaw bot screen: no target (%s)", type(exc).__name__)
            return None

    def step(self, kwargs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """pre_tool_call: the ``botScreenStep`` payload for any ``computer_use`` call, or None.

        ``{v, tool, action, label?, app?, keys?, chars?, direction?, at}``. The label is the
        element's, from the last kept capture: the one it names, or the smallest one holding its
        point. The app is the call's own, else that element's, else the capture's. A ``type``
        step counts the characters it types and a ``key`` step names only a key that cannot be
        text (:func:`key_step`); a ``set_value`` step names its element, never the value. None
        for an action outside Hermes's schema."""
        try:
            call = _computer_use_call(kwargs)
            if call is None or call[1] not in STEP_ACTIONS:
                return None
            session, action, args = call
            facts = self._last(session)
            step: Dict[str, Any] = {"v": 1, "tool": TOOL_NAME, "action": action}
            index = _aimed_element(action, args, facts) if facts is not None and action in POINTER_ACTIONS else None
            label = facts.labels.get(index) if facts is not None and index is not None else None
            if label is not None:
                step["label"] = label
            app = _call_app(args.get("app"))
            if app is None and facts is not None:
                app = (facts.apps.get(index) if index is not None else None) or facts.app
            if app is not None:
                step["app"] = app
            if action == "key":
                step.update(key_step(args.get("keys")))
            elif action == "type" and isinstance(args.get("text"), str):
                step["chars"] = len(args["text"])
            elif action == "scroll":
                # Hermes scrolls down when no direction is given (tool.py _do_scroll).
                direction = args.get("direction", "down")
                if isinstance(direction, str) and direction in SCROLL_DIRECTIONS:
                    step["direction"] = direction
            step["at"] = int(self._wall() * 1000)
            return step
        except Exception as exc:
            logger.debug("ocuclaw bot screen: no step (%s)", type(exc).__name__)
            return None


# -- screen runs and screen asks (#5151) ----------------------------------------

_TURN_SESSIONS = 32
_TURN_KEYS = 64

# Rides an OcuClaw chat's turn while the screen runs (Matt, 16 Oct): the bot asks through
# Hermes's clarify, never a new tool and never a guess from its reply.
PROMPT_NOTE = (
    "<ocuclaw_bot_screen_v1>Your Bot Screen is running, and the user can watch it from their "
    "glasses. If your screen work needs a login, a 2FA or one-time code, a CAPTCHA or a payment "
    "from them, call the clarify tool with one short question that names what you need (for "
    "example \"Sign in to Acme Portal: one-time code\") and wait for the answer. Do not end your "
    "turn with a reply that asks for it.</ocuclaw_bot_screen_v1>"
)


@dataclass
class _Turn:
    turn: str
    used: bool = False
    at: float = 0.0


class ScreenTurns:
    """#5151: which turn each Hermes session is on, and whether it used the screen.

    :meth:`tool_call` follows every ``pre_tool_call``: a new ``turn_id`` starts a new turn, and
    the first ``computer_use`` call of a turn returns the ``botScreenRun`` payload, once.
    :meth:`turn_started` starts one on ``pre_llm_call``, for a host whose tool hooks name no
    turn. :meth:`used` is true while the session's current turn has used the screen: a
    ``clarify`` it raises is a screen ask. A session key is linked to its session on its screen
    steps, for :meth:`used` by key. Ids and times only, in memory, at most
    :data:`_TURN_SESSIONS` sessions; a turn's use is forgotten after :data:`CAPTURE_MAX_AGE_S`.
    No method raises.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._wall = wall
        self._lock = threading.Lock()
        self._turns: "OrderedDict[str, _Turn]" = OrderedDict()
        self._keys: "OrderedDict[str, str]" = OrderedDict()

    def _hold(self, session: str, turn: _Turn) -> None:
        # Under the lock.
        self._turns[session] = turn
        self._turns.move_to_end(session)
        while len(self._turns) > _TURN_SESSIONS:
            self._turns.popitem(last=False)

    def turn_started(self, session_id: Any, turn_id: Any = None) -> None:
        """pre_llm_call: the session starts a turn that has not used the screen yet."""
        session = str(session_id or "").strip()
        if not session:
            return
        with self._lock:
            self._hold(session, _Turn(str(turn_id or "").strip()))

    def tool_call(self, kwargs: Any, session_key: Any = None) -> Optional[Dict[str, Any]]:
        """pre_tool_call: follow the session's turn; ``{v, at}`` on its first ``computer_use``."""
        try:
            if not isinstance(kwargs, dict):
                return None
            session = str(kwargs.get("session_id") or "").strip()
            if not session:
                return None
            turn = str(kwargs.get("turn_id") or "").strip()
            screen = _computer_use_call(kwargs) is not None
            key = str(session_key or "").strip()
            with self._lock:
                held = self._turns.get(session)
                if held is None or (turn and held.turn != turn):
                    held = _Turn(turn)
                    self._hold(session, held)
                if not screen:
                    return None
                first = not held.used
                held.used, held.at = True, self._clock()
                self._hold(session, held)
                if key:
                    self._keys[key] = session
                    self._keys.move_to_end(key)
                    while len(self._keys) > _TURN_KEYS:
                        self._keys.popitem(last=False)
            return {"v": 1, "at": int(self._wall() * 1000)} if first else None
        except Exception as exc:
            logger.debug("ocuclaw bot screen: turn unread (%s)", type(exc).__name__)
            return None

    def used(self, session_id: Any = None, session_key: Any = None) -> bool:
        """The session's current turn used the screen, by its id or its key."""
        try:
            with self._lock:
                session = str(session_id or "").strip()
                held = self._turns.get(session) if session else None
                if held is None:
                    linked = self._keys.get(str(session_key or "").strip())
                    held = self._turns.get(linked) if linked else None
                return bool(held is not None and held.used and self._clock() - held.at <= CAPTURE_MAX_AGE_S)
        except Exception as exc:
            logger.debug("ocuclaw bot screen: turn use unread (%s)", type(exc).__name__)
            return False


# -- approvals with a view (#5152) --------------------------------------------

# Hermes gates each destructive computer_use action, and raising a window, behind
# an approval (tools/computer_use/tool.py _request_approval). Its description is
# "Allow computer_use to perform `<scope>`?" and its command "computer_use:
# <summary>", where a `type` summary quotes the text it types and a `key` summary
# the keys it presses. Neither may reach a card, a list or a trace.
APPROVAL_COMMAND_PREFIX = "computer_use:"
_APPROVAL_DESCRIPTION = re.compile(r"^Allow computer_use to perform `([a-z_]{1,32})`\?$")
_APPROVAL_SUMMARY = re.compile(r"^computer_use:\s*([a-z_]{1,32})(?:\s|$)")
# Hermes's suffix for a foreground delivery (tool.py _summarize_action).
_FOREGROUND_MARK = "[FOREGROUND"
APPROVAL_SCOPES = STEP_ACTIONS | {"bring_to_front"}
# Typing and keys go to whatever has focus: the element the bot last pointed at.
FOCUS_ACTIONS = frozenset({"type", "key"})
# The gate runs inside the call it asks about, right after its pre_tool_call.
CALL_MAX_AGE_S = 60.0
# A field the bot pointed at longer ago than this may no longer have focus.
FIELD_MAX_AGE_S = 5 * 60.0
_APPROVAL_SESSIONS = 16


def approval_scope(command: Any, description: Any) -> Optional[Tuple[str, str]]:
    """``(action, mode)`` of a ``computer_use`` approval, else None.

    Read from Hermes's own description, else the first word of its command. The
    action is "" when neither names one Hermes gates; the mode is "foreground" or
    "background". Any command that starts with ``computer_use:`` is one, so its
    summary is never shown even when Hermes rewords the description."""
    text = command.strip() if isinstance(command, str) else ""
    desc = description.strip() if isinstance(description, str) else ""
    named = _APPROVAL_DESCRIPTION.match(desc)
    if named is None and not text.startswith(APPROVAL_COMMAND_PREFIX):
        return None
    summary = _APPROVAL_SUMMARY.match(text)
    action = named.group(1) if named else (summary.group(1) if summary else "")
    if action not in APPROVAL_SCOPES:
        action = ""
    return action, ("foreground" if _FOREGROUND_MARK in text else "background")


def approval_command(command: Any, description: Any, keys: Optional[str] = None) -> Optional[str]:
    """The approval's command line without what it types: ``computer_use: <action>``,
    a named key or shortcut (:func:`key_step`) on a key action, and ``[foreground]``
    for a foreground one. None for an approval that is not a ``computer_use`` one."""
    scope = approval_scope(command, description)
    if scope is None:
        return None
    action, mode = scope
    line = f"{TOOL_NAME}: {action}" if action else TOOL_NAME
    if action == "key" and keys:
        line += f" {keys}"
    if mode == "foreground":
        line += " [foreground]"
    return line


@dataclass(frozen=True)
class _Call:
    step: Dict[str, Any]
    target: Optional[Dict[str, Any]]
    at: float


@dataclass(frozen=True)
class _Field:
    rect: List[int]
    kind: str
    label: Optional[str]
    app: Optional[str]
    at: float


class ApprovalViews:
    """The facts a ``computer_use`` approval card shows (#5152), per Hermes session key.

    :meth:`remember` keeps each call's step and target from ``pre_tool_call``
    (:meth:`ToolTargets.step`, :meth:`ToolTargets.target`), and, for a pointer
    action, the element it points at: the field a later ``type`` or ``key`` goes
    to. :meth:`view` turns an approval into the card's ``botScreen`` payload and
    the command line without typed text. Only names and boxes are kept, never the
    typed text or a set value, in memory only. No method raises."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._calls: "OrderedDict[str, _Call]" = OrderedDict()
        self._fields: "OrderedDict[str, _Field]" = OrderedDict()

    @staticmethod
    def _put(table: "OrderedDict[str, Any]", key: str, value: Any) -> None:
        table[key] = value
        table.move_to_end(key)
        while len(table) > _APPROVAL_SESSIONS:
            table.popitem(last=False)

    def remember(self, session_key: str, step: Optional[Dict[str, Any]], target: Optional[Dict[str, Any]]) -> None:
        """pre_tool_call: the session's newest computer_use call, as its step and target."""
        if not session_key or not isinstance(step, dict) or not isinstance(step.get("action"), str):
            return
        now = self._clock()
        action = step["action"]
        with self._lock:
            self._put(self._calls, session_key, _Call(dict(step), dict(target) if isinstance(target, dict) else None, now))
            if action in POINTER_ACTIONS and isinstance(target, dict) and isinstance(target.get("rect"), list):
                field = _Field(list(target["rect"]), str(target.get("kind") or "point"), step.get("label"), step.get("app"), now)
                self._put(self._fields, session_key, field)
            elif action == "focus_app":
                # Another app has focus now: the old field is not where typing goes.
                self._fields.pop(session_key, None)

    def view(self, session_key: str, command: Any, description: Any) -> Optional[Tuple[str, Dict[str, Any]]]:
        """``(command line, botScreen payload)`` for a computer_use approval, else None.

        ``{v, tool, action?, mode, label?, app?, rect?, kind?, field?, keys?, direction?}``.
        The label, app and box are those of the call it asks about when that call
        came within :data:`CALL_MAX_AGE_S` and names the same action; a ``type`` or
        ``key`` call's box and label are its field's, the element the bot last
        pointed at (``field: true``), within :data:`FIELD_MAX_AGE_S`."""
        try:
            scope = approval_scope(command, description)
            if scope is None:
                return None
            action, mode = scope
            payload: Dict[str, Any] = {"v": 1, "tool": TOOL_NAME, "mode": mode}
            if action:
                payload["action"] = action
            now = self._clock()
            with self._lock:
                call = self._calls.get(session_key)
                field = self._fields.get(session_key)
            same = (
                call is not None
                and now - call.at <= CALL_MAX_AGE_S
                and action
                and (call.step.get("action") == action or action == "bring_to_front")
            )
            step = call.step if same and call is not None else {}
            target = call.target if same and call is not None else None
            for key in ("label", "app", "direction"):
                if isinstance(step.get(key), str):
                    payload[key] = step[key]
            if action == "key" and isinstance(step.get("keys"), str):
                payload["keys"] = step["keys"]
            if target is not None and isinstance(target.get("rect"), list):
                payload["rect"] = list(target["rect"])
                payload["kind"] = str(target.get("kind") or "point")
            elif action in FOCUS_ACTIONS and field is not None and now - field.at <= FIELD_MAX_AGE_S:
                payload["rect"] = list(field.rect)
                payload["kind"] = field.kind
                payload["field"] = True
                if field.label is not None:
                    payload["label"] = field.label
                if "app" not in payload and field.app is not None:
                    payload["app"] = field.app
            line = approval_command(command, description, payload.get("keys"))
            return (line or TOOL_NAME), payload
        except Exception as exc:  # an unexpected shape: no view, never a guess
            logger.debug("ocuclaw bot screen: no approval view (%s)", type(exc).__name__)
            line = approval_command(command, description)
            return None if line is None else (line, {"v": 1, "tool": TOOL_NAME})


def approval_preview(text: Any) -> Any:
    """[text] unless it is a computer_use approval's command, which comes back
    without what it types (:func:`approval_command`). For the Waiting on you list."""
    line = approval_command(text, None) if isinstance(text, str) else None
    return text if line is None else line
