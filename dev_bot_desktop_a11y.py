"""Dev switch: Bot Desktop apps publish accessibility (#5155).

On Linux, computer use reads element boxes and labels from AT-SPI, and the
glasses' head pointer snaps to them. Hermes starts its Bot Desktop with
``NO_AT_BRIDGE=1 GTK_A11Y=none`` (``tools/bot_desktop/launcher.sh``) and the
dock's Browser without ``--force-renderer-accessibility``
(``tools/bot_desktop/browser.py`` ``dock_argv``), so a capture lists only the
window. The real fix is a Hermes change; until then a developer can set
``OCUCLAW_DEV_BOT_DESKTOP_A11Y=1`` in the gateway's environment, and this
module patches the running Hermes in memory:

- ``runtime._LAUNCHER`` points at a copy of Hermes's own launcher, rebuilt
  from the current file on every gateway start, without the two settings that
  turn accessibility off (the AT-SPI bus still starts on demand over D-Bus,
  so its autostart mask can stay);
- ``browser.dock_argv`` gains the Chromium accessibility flag.

Nothing on disk that Hermes owns is edited. A Hermes whose code no longer
matches leaves that half unpatched and says why; off (the default) imports
nothing.
"""

from __future__ import annotations

import importlib
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, List, Mapping, Optional

logger = logging.getLogger(__name__)

SWITCH_ENV = "OCUCLAW_DEV_BOT_DESKTOP_A11Y"
BROWSER_A11Y_FLAG = "--force-renderer-accessibility"

_RUNTIME_MODULE = "tools.bot_desktop.runtime"
_BROWSER_MODULE = "tools.bot_desktop.browser"
# The launcher's one session-wide export carries both settings, side by side.
_A11Y_OFF = " NO_AT_BRIDGE=1 GTK_A11Y=none"
_SELF_PATH = "${BASH_SOURCE[0]}"
_PATCHED_NAME = "bot-desktop-launcher.sh"
_MARK = "_ocuclaw_dev_a11y"


def switch_on(environ: Optional[Mapping[str, str]] = None) -> bool:
    env = os.environ if environ is None else environ
    return env.get(SWITCH_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def patched_launcher_text(original: str, source: Path) -> Optional[str]:
    """Hermes's launcher with accessibility left on, or None when it no longer matches."""
    if original.count(_A11Y_OFF) != 1 or any(c in str(source) for c in '"$`\\'):
        return None
    # The copy runs from elsewhere; its own path still has to find Hermes's wallpaper.
    return original.replace(_A11Y_OFF, "").replace(_SELF_PATH, str(source))


def _private_dir(environ: Mapping[str, str]) -> Optional[Path]:
    """A directory only this user can write, or None."""
    base = environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()
    path = Path(base) / f"ocuclaw-dev-{os.getuid()}"
    path.mkdir(mode=0o700, exist_ok=True)
    st = path.lstat()
    if not path.is_dir() or path.is_symlink() or st.st_uid != os.getuid() or st.st_mode & 0o022:
        return None
    return path


def _patch_launcher(runtime: Any, environ: Mapping[str, str]) -> str:
    source = Path(getattr(runtime, _MARK, None) or runtime._LAUNCHER)
    text = patched_launcher_text(source.read_text(encoding="utf-8"), source)
    if text is None:
        return "skipped:launcher_changed"
    directory = _private_dir(environ)
    if directory is None:
        return "skipped:no_private_dir"
    target = directory / _PATCHED_NAME
    tmp = directory / f".{_PATCHED_NAME}.{os.getpid()}"
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)
    setattr(runtime, _MARK, str(source))
    runtime._LAUNCHER = target
    return "patched"


def _patch_browser(browser: Any) -> str:
    original = browser.dock_argv
    if getattr(original, _MARK, False):
        return "patched"

    def dock_argv(*args: Any, **kwargs: Any) -> List[str]:
        argv = list(original(*args, **kwargs))
        return argv if BROWSER_A11Y_FLAG in argv else [*argv, BROWSER_A11Y_FLAG]

    setattr(dock_argv, _MARK, True)
    dock_argv.__wrapped__ = original  # type: ignore[attr-defined]
    browser.dock_argv = dock_argv
    return "patched"


def _half(name: str, api: str, patch: Any, *extra: Any) -> str:
    try:
        mod = importlib.import_module(name)
    except Exception:
        return "skipped:no_bot_desktop"
    if not hasattr(mod, api):
        return "skipped:hermes_changed"
    try:
        return patch(mod, *extra)
    except Exception as exc:
        return f"skipped:error:{type(exc).__name__}"


def apply(environ: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """Patch the running Hermes when the switch is on. None when off; else what happened."""
    env = os.environ if environ is None else environ
    if not switch_on(env):
        return None
    if not sys.platform.startswith("linux"):
        return "skipped:not_linux"
    launcher = _half(_RUNTIME_MODULE, "_LAUNCHER", _patch_launcher, env)
    browser = _half(_BROWSER_MODULE, "dock_argv", _patch_browser)
    return f"launcher={launcher} browser={browser}"


def restart_screen(out: Any = None) -> int:
    """``hermes ocuclaw dev-a11y-screen``: restart this profile's Bot Desktop with accessibility on.

    For a desktop the gateway would not start itself (``bot_desktop.auto_start`` off, or a screen already
    up): built-in ``hermes computer-use screen start`` loads no plugins, so it can never be patched."""
    out = out or sys.stdout
    result = apply({**os.environ, SWITCH_ENV: "1"})
    out.write(f"ocuclaw dev Bot Desktop accessibility: {result}\n")
    if result is None or "launcher=patched" not in result:
        out.write("Not restarting: the Bot Desktop would start exactly as Hermes ships it.\n")
        return 1
    runtime = importlib.import_module(_RUNTIME_MODULE)
    try:
        runtime.stop()
        status = runtime.start()
    except Exception as exc:
        out.write(f"Bot Desktop did not start: {exc}\n")
        return 1
    out.write(f"Bot Desktop running={status.running} display={status.display} placement={status.placement}\n")
    if status.placement != "gateway":
        out.write("This screen runs in a sandbox, which this patch does not reach.\n")
    return 0 if status.running else 1
