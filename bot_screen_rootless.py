"""``hermes ocuclaw bot-screen install|remove`` (#7571): Hermes's Bot Screen without admin rights.

Hermes counts its Bot Screen as installed when the programs its launcher runs
(``tools.bot_desktop.runtime.REQUIRED_BINARIES``) are on its PATH, and installs
them with the host's package manager as root. A Cloudways container runs Hermes as
a plain user with no way to become root, so Hermes calls the host not installable
and the card was a dead end.

This module puts the same Debian packages in the home folder instead. Proven on a
Cloudways box (Hermes 0.23.1, Debian 13, x86_64) on 2026-11-15:

1. ``apt-get update`` and ``apt-get download`` run as the plain user with their
   lists and cache in the home folder. The packages come from the host's own apt
   sources, and apt checks each one against those sources' signed index.
2. ``dpkg -x`` unpacks them under :data:`INSTALL_DIRNAME`.
3. One launcher script per missing program, linked into a home folder already on
   Hermes's PATH, sets the library and data paths for the unpacked copy.
4. Xfce and the D-Bus session read files at fixed ``/usr`` paths, and the
   container blocks user namespaces, so those launchers run through ``proot``
   (unpacked the same way) with each folder the host lacks mapped in place.
5. ``hermes computer-use screen start`` then starts Hermes's own screen.

Scope (SECURITY-RULED on #7571): only on a Cloudways host, only when the wearer
asks (the agent runs this command), only the host's own apt sources, only under
the home folder, never as root, never a system folder, never Hermes's memory floor,
and :func:`remove` (also run by ``hermes ocuclaw uninstall``) takes it all away.
Nothing here patches Hermes: putting programs on PATH is all it does.

:func:`offer` is the passive read the Bot Screen status uses: whether this host
could take the install now. Every collaborator is injectable (:class:`Deps`), so
tests run the same entry functions a real host runs.
"""

from __future__ import annotations

import importlib
import json
import os
import platform
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, TextIO, Tuple

EXIT_OK = 0
#: A step failed: the network, apt, an unpack, or Hermes's start.
EXIT_FAILED = 1
#: This host cannot take the install (not Cloudways, not Debian x86_64, too
#: little memory, no home folder on PATH), so nothing was changed.
EXIT_REFUSED = 2

#: Under the home folder: the persistent disk on Cloudways (the container root is replaced).
INSTALL_DIRNAME = Path(".local") / "share" / "bot-desktop-rootless"
#: :func:`offer`'s words, add-only beside ``need: "host"`` on the status wire.
OFFER_READY = "ready"
OFFER_MEMORY = "memory"

#: Hermes's own lists (tools/bot_desktop/runtime.py), used when a Hermes renames them.
FALLBACK_REQUIRED_BINARIES = (
    "Xvnc", "xfwm4", "xfce4-panel", "xfdesktop", "xfsettingsd", "dbus-run-session",
    "xauth", "xdpyinfo", "setxkbmap", "xprop",
)
FALLBACK_PACKAGES = (
    "tigervnc-standalone-server", "xfce4-panel", "xfwm4", "xfdesktop4", "xfce4-settings",
    "xfce4-terminal", "dbus-x11", "x11-xserver-utils", "x11-utils", "x11-xkb-utils", "xauth",
    "fonts-dejavu-core",
)
#: Maps the unpacked folders onto the fixed /usr paths Xfce reads; no root needed.
PROOT_PACKAGES = ("proot", "libtalloc2")
#: The program each required name runs, when it is not the same name.
REAL_PROGRAMS = {"Xvnc": "Xtigervnc"}
#: The programs that read fixed /usr paths, so they run through proot.
MAPPED_PROGRAMS = frozenset({"xfwm4", "xfce4-panel", "xfdesktop", "xfsettingsd", "dbus-run-session"})
#: Every top-level folder the packages ship that the host lacks is mapped in place.
BIND_TOPS = ("usr/share", "usr/lib/x86_64-linux-gnu", "usr/libexec", "usr/lib", "etc/xdg", "etc")
#: Set inside a mapped program so its children never start a second proot.
MAPPED_MARKER = "OCUCLAW_BOT_SCREEN_MAPPED"
#: Home folders often on PATH, tried first, in this order.
PREFERRED_LINK_DIRS = (Path("pipx") / "bin", Path(".local") / "bin", Path("bin"))
#: 80 packages are about 42 MB and unpack to about 191 MB; room for both, and a margin.
DISK_NEED_MB = 600

_PACKAGE_NAME = re.compile(r"^[a-z0-9][a-z0-9+.-]{0,99}$")
_PROGRAM_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$")
#: The launchers are shell scripts with these paths in them: only plain characters.
_PLAIN_PATH = re.compile(r"^/[A-Za-z0-9._/+-]+$")
_INST_LINE = re.compile(r"^Inst (\S+) ")

_UPDATE_TIMEOUT_S = 600.0
_SIMULATE_TIMEOUT_S = 180.0
_DOWNLOAD_TIMEOUT_S = 1200.0
_UNPACK_TIMEOUT_S = 180.0
_SCREEN_TIMEOUT_S = 120.0

SAY_NOT_CLOUDWAYS = "Bot Screen: this no-admin install is for Cloudways servers only. Nothing was changed."
SAY_PLATFORM = "Bot Screen: this server is not Linux on x86_64, so the no-admin install cannot run here. Nothing was changed."
SAY_ROOT = "Bot Screen: Hermes runs with admin rights here. Run `hermes computer-use screen install -y` instead."
SAY_NO_APT = "Bot Screen: this server has no apt-get or dpkg, so the no-admin install cannot run here. Nothing was changed."
SAY_NO_LINK_DIR = (
    "Bot Screen: no folder in your home is on Hermes's PATH, so Hermes could not find the screen's programs. "
    "Nothing was changed."
)
SAY_ODD_HOME = "Bot Screen: the home folder's path has characters the launchers cannot carry. Nothing was changed."
SAY_HERMES_CAN = "Bot Screen: Hermes can install the screen itself here. Run `hermes computer-use screen install -y`."
SAY_MEMORY = (
    "Bot Screen: this server has too little free memory for the screen, and Hermes will not start it. "
    "On Cloudways, computer use needs the Operator plan or higher: upgrade this agent on its page, "
    "Instance, Manage plan. Nothing was changed."
)
SAY_DISK = "Bot Screen: the install needs about {need} MB of free disk in the home folder, and {free} MB is free. Nothing was changed."
SAY_ALREADY = "Bot Screen: the desktop's programs are already on PATH."
SAY_UPDATE = "Bot Screen: reading this server's own Debian package lists."
SAY_UPDATE_FAILED = "Bot Screen: could not read this server's package lists (network or apt sources). Try again later."
SAY_PLAN_FAILED = "Bot Screen: apt could not work out the desktop packages for this server."
SAY_DOWNLOAD = "Bot Screen: downloading {count} packages (about 40 MB)."
SAY_DOWNLOAD_FAILED = "Bot Screen: the package download failed. Try again later."
SAY_UNPACK = "Bot Screen: unpacking into {path}."
SAY_UNPACK_FAILED = "Bot Screen: could not unpack {name}."
SAY_KEPT_FOREIGN = "Bot Screen: kept {path}, which is not OcuClaw's."
SAY_LINKED = "Bot Screen: linked {count} programs into {path}."
SAY_STILL_MISSING = "Bot Screen: still not found on PATH: {names}."
SAY_STARTING = "Bot Screen: starting the screen with `hermes computer-use screen start`."
SAY_START_FAILED = "Bot Screen: Hermes could not start the screen (exit {code})."
#: Last line, so the agent ends on it: Hermes's own status above it points at Hermes Desktop,
#: which a Cloudways wearer does not have (live, 2026-11-15).
SAY_READY = "Bot Screen: ready. Tell the wearer to open the Bot Screen on their glasses."
SAY_NOTHING_TO_REMOVE = "Bot Screen: no no-admin install to remove."
SAY_REMOVED = "Bot Screen: removed the no-admin install and {count} links."
SAY_REMOVE_FAILED = "Bot Screen: could not remove {path}."

_REFUSALS = {
    "not_cloudways": SAY_NOT_CLOUDWAYS,
    "platform": SAY_PLATFORM,
    "root": SAY_ROOT,
    "no_apt": SAY_NO_APT,
    "no_link_dir": SAY_NO_LINK_DIR,
    "odd_home": SAY_ODD_HOME,
}

Runner = Callable[..., Tuple[Optional[int], str]]


def _run(argv: Sequence[str], *, cwd: Optional[Path] = None, env: Optional[Mapping[str, str]] = None,
         timeout: float = 60.0) -> Tuple[Optional[int], str]:
    """One bounded child, its output merged: ``(exit code, text)``; ``(None, reason)`` when it could not run."""
    import subprocess

    try:
        done = subprocess.run(  # noqa: S603 - fixed argv, no shell
            list(argv), cwd=str(cwd) if cwd else None, env=dict(env) if env is not None else None,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError as exc:
        return None, type(exc).__name__
    return done.returncode, done.stdout or ""


def _hermes_runtime() -> Optional[Any]:
    try:
        return importlib.import_module("tools.bot_desktop.runtime")
    except Exception:
        return None


def _hermes_memory_short() -> bool:
    """Hermes's own start check (``resources.memory_blocker`` at ``min_free_mb``). Never lowered here.

    Unknown memory is not short, as in Hermes: a host it cannot read is not one it knows is small."""
    try:
        resources = importlib.import_module("tools.bot_desktop.resources")
        need = resources.min_free_mb()
        return resources.memory_blocker(resources.memory_info(), need=need) is not None
    except Exception:
        return False


def _free_disk_mb(path: Path) -> Optional[int]:
    try:
        return shutil.disk_usage(str(path)).free // (1024 * 1024)
    except OSError:
        return None


def _user_name() -> str:
    try:
        import pwd

        return pwd.getpwuid(os.geteuid()).pw_name
    except Exception:
        return os.environ.get("USER", "")


def _cloudways_cached() -> bool:
    try:
        from .optional_setup_rpc import cloudways_host

        return cloudways_host()
    except Exception:
        return False


def _cloudways_detected() -> bool:
    try:
        from .optional_setup_rpc import detect_cloudways_host

        return detect_cloudways_host()
    except Exception:
        return False


@dataclass
class Deps:
    """What the install reads and runs. :func:`live_deps` is the real host."""

    home: Path
    path_env: str
    run: Runner = _run
    machine: str = field(default_factory=platform.machine)
    system: str = sys.platform
    euid: int = field(default_factory=lambda: os.geteuid() if hasattr(os, "geteuid") else -1)
    user: str = field(default_factory=_user_name)
    cloudways: Callable[[], bool] = _cloudways_cached
    memory_short: Callable[[], bool] = _hermes_memory_short
    runtime: Callable[[], Optional[Any]] = _hermes_runtime
    free_disk_mb: Callable[[Path], Optional[int]] = _free_disk_mb
    #: Whether a path exists on the host, for the proot map.
    host_exists: Callable[[str], bool] = os.path.exists

    def which(self, name: str) -> Optional[str]:
        return shutil.which(name, path=self.path_env)


def live_deps(*, detect: bool = False) -> Deps:
    """This host. ``detect`` runs the Cloudways detection (a ``ps``) rather than read the gateway's cache."""
    return Deps(
        home=Path.home(),
        path_env=os.environ.get("PATH", ""),
        cloudways=_cloudways_detected if detect else _cloudways_cached,
    )


@dataclass(frozen=True)
class Layout:
    base: Path

    @classmethod
    def of(cls, home: Path) -> "Layout":
        return cls(Path(home) / INSTALL_DIRNAME)

    @property
    def root(self) -> Path:
        return self.base / "root"

    @property
    def bin(self) -> Path:
        return self.base / "bin"

    @property
    def debs(self) -> Path:
        return self.base / "debs"

    @property
    def apt_lists(self) -> Path:
        return self.base / "apt" / "lists"

    @property
    def apt_cache(self) -> Path:
        return self.base / "apt" / "cache"

    @property
    def binds(self) -> Path:
        return self.base / "binds.txt"

    @property
    def env_sh(self) -> Path:
        return self.base / "env.sh"

    @property
    def marker(self) -> Path:
        return self.base / "installed.json"

    @property
    def libdir(self) -> Path:
        return self.root / "usr" / "lib" / "x86_64-linux-gnu"

    def owns(self, path: Any) -> bool:
        """``path`` resolves inside this install."""
        try:
            resolved = Path(os.path.realpath(str(path)))
            base = Path(os.path.realpath(str(self.base)))
        except (OSError, ValueError):
            return False
        return resolved == base or base in resolved.parents


def _apt(lay: Layout, user: str) -> List[str]:
    """apt-get with its lists and cache in the home folder, run as this user, no lock on the host's."""
    return [
        "apt-get",
        "-o", f"Dir::State::lists={lay.apt_lists}",
        "-o", f"Dir::Cache={lay.apt_cache}",
        "-o", "Debug::NoLocking=1",
        "-o", f"APT::Sandbox::User={user}",
    ]


def _names(raw: Any, pattern: "re.Pattern[str]", fallback: Sequence[str]) -> List[str]:
    if isinstance(raw, (list, tuple)) and raw and all(isinstance(n, str) and pattern.match(n) for n in raw):
        return list(raw)
    return list(fallback)


def required_binaries(runtime: Optional[Any]) -> List[str]:
    """Hermes's ``REQUIRED_BINARIES``, else :data:`FALLBACK_REQUIRED_BINARIES`."""
    return _names(getattr(runtime, "REQUIRED_BINARIES", None), _PROGRAM_NAME, FALLBACK_REQUIRED_BINARIES)


def apt_packages(runtime: Optional[Any]) -> List[str]:
    """Hermes's apt list (``PACKAGES["apt"]``), else :data:`FALLBACK_PACKAGES`."""
    table = getattr(runtime, "PACKAGES", None)
    raw = table.get("apt") if isinstance(table, Mapping) else None
    return _names(raw, _PACKAGE_NAME, FALLBACK_PACKAGES)


def link_dir(deps: Deps) -> Optional[Path]:
    """A writable folder under the home folder that is on PATH, for the launcher links.

    :data:`PREFERRED_LINK_DIRS` first, then any other home folder in PATH order."""
    home = Path(os.path.realpath(str(deps.home)))
    lay = Layout.of(deps.home)
    entries: List[Path] = []
    for raw in deps.path_env.split(os.pathsep):
        if raw and os.path.isabs(raw):
            entries.append(Path(os.path.realpath(raw)))
    preferred = [Path(os.path.realpath(str(home / rel))) for rel in PREFERRED_LINK_DIRS]
    ordered = [p for p in preferred if p in entries] + [p for p in entries if p not in preferred]
    for entry in ordered:
        if home not in entry.parents or lay.owns(entry):
            continue
        if entry.is_dir() and os.access(str(entry), os.W_OK | os.X_OK):
            return entry
    return None


def host_problem(deps: Deps) -> Optional[str]:
    """Why the no-admin install cannot run on this host, as a word, or None. Changes nothing."""
    if not deps.cloudways():
        return "not_cloudways"
    if not deps.system.startswith("linux") or deps.machine != "x86_64":
        return "platform"
    if deps.euid == 0:
        return "root"
    if deps.which("apt-get") is None or deps.which("dpkg") is None:
        return "no_apt"
    if not _PLAIN_PATH.match(str(Layout.of(deps.home).base)):
        return "odd_home"
    if link_dir(deps) is None:
        return "no_link_dir"
    return None


def offer(deps: Optional[Deps] = None) -> Optional[str]:
    """The Bot Screen status's add-only ``rootless`` word: :data:`OFFER_READY`, :data:`OFFER_MEMORY`, or None.

    Asked only beside ``need: "host"`` (Hermes cannot install it itself). ``memory``: the
    install could run, but Hermes's own memory check would refuse to start the screen,
    so the card names the bigger plan instead. Passive and never raises."""
    try:
        deps = deps or live_deps()
        if host_problem(deps) is not None:
            return None
        return OFFER_MEMORY if deps.memory_short() else OFFER_READY
    except Exception:
        return None


# -- the install -----------------------------------------------------------------


def _say(out: TextIO, line: str) -> None:
    out.write(line + "\n")
    out.flush()


def _hermes_installable(runtime: Optional[Any]) -> bool:
    check = getattr(runtime, "installable", None)
    try:
        return callable(check) and check() is True
    except Exception:
        return False


def _child_env(**extra: str) -> Dict[str, str]:
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    env.update(extra)
    return env


def _planned(text: str) -> List[str]:
    names = []
    for line in text.splitlines():
        found = _INST_LINE.match(line)
        if found and _PACKAGE_NAME.match(found.group(1)) and found.group(1) not in names:
            names.append(found.group(1))
    return names


def _marker_matches(lay: Layout, packages: Sequence[str]) -> bool:
    try:
        data = json.loads(lay.marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("packages") == list(packages) and lay.root.is_dir()


def _fetch_and_unpack(deps: Deps, lay: Layout, packages: Sequence[str], out: TextIO) -> bool:
    for folder in (lay.apt_lists / "partial", lay.apt_cache / "archives" / "partial", lay.debs, lay.root):
        folder.mkdir(parents=True, exist_ok=True)
    apt = _apt(lay, deps.user)
    env = _child_env()
    _say(out, SAY_UPDATE)
    code, _ = deps.run([*apt, "update"], env=env, timeout=_UPDATE_TIMEOUT_S)
    if code != 0:
        _say(out, SAY_UPDATE_FAILED)
        return False
    code, text = deps.run([*apt, "-s", "install", "--no-install-recommends", *packages, PROOT_PACKAGES[0]],
                          env=env, timeout=_SIMULATE_TIMEOUT_S)
    if code != 0:
        _say(out, SAY_PLAN_FAILED)
        return False
    names = _planned(text)
    names += [name for name in PROOT_PACKAGES if name not in names]
    for stale in lay.debs.glob("*.deb"):
        stale.unlink()
    _say(out, SAY_DOWNLOAD.format(count=len(names)))
    code, _ = deps.run([*apt, "download", *names], cwd=lay.debs, env=env, timeout=_DOWNLOAD_TIMEOUT_S)
    if code != 0:
        _say(out, SAY_DOWNLOAD_FAILED)
        return False
    _say(out, SAY_UNPACK.format(path=lay.root))
    for deb in sorted(lay.debs.glob("*.deb")):
        code, _ = deps.run(["dpkg", "-x", str(deb), str(lay.root)], env=env, timeout=_UNPACK_TIMEOUT_S)
        if code != 0:
            _say(out, SAY_UNPACK_FAILED.format(name=deb.name))
            return False
    shutil.rmtree(str(lay.debs), ignore_errors=True)
    shutil.rmtree(str(lay.apt_cache / "archives"), ignore_errors=True)
    _write(lay.marker, json.dumps({"v": 1, "packages": list(packages)}, sort_keys=True) + "\n", 0o644)
    return True


def _write(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(str(tmp), mode)
    os.replace(str(tmp), str(path))


def _binds(deps: Deps, lay: Layout) -> List[str]:
    """``-b <unpacked>:<host path>`` for each folder the packages ship that the host lacks."""
    lines = []
    for top in BIND_TOPS:
        folder = lay.root / top
        if not folder.is_dir():
            continue
        for entry in sorted(folder.iterdir()):
            # The launchers word-split this file: a name with odd characters is never mapped.
            if not _PLAIN_PATH.match(str(entry)):
                continue
            if not deps.host_exists(f"/{top}/{entry.name}"):
                lines.append(f"-b {entry}:/{top}/{entry.name}")
    return lines


def _env_sh(lay: Layout) -> str:
    r, lib = lay.root, lay.libdir
    return (
        f"R={r}\n"
        f'case ":${{LD_LIBRARY_PATH:-}}:" in *":{lib}:"*) ;; *)\n'
        f'  export LD_LIBRARY_PATH="{lib}${{LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}}"\n'
        f'  export PATH="{lay.bin}:{r}/usr/bin:$PATH"\n'
        f'  export XDG_DATA_DIRS="{r}/usr/share:${{XDG_DATA_DIRS:-/usr/local/share:/usr/share}}"\n'
        f'  export XDG_CONFIG_DIRS="{r}/etc/xdg:${{XDG_CONFIG_DIRS:-/etc/xdg}}"\n'
        f"  export GTK_EXE_PREFIX={r}/usr GTK_DATA_PREFIX={r}/usr\n"
        f"  export GTK_PATH={lib}/gtk-3.0\n"
        f"  export GSETTINGS_SCHEMA_DIR={r}/usr/share/glib-2.0/schemas\n"
        f"  export GIO_EXTRA_MODULES={lib}/gio/modules\n"
        "  export NO_AT_BRIDGE=1\n"
        ";; esac\n"
    )


def _extra_args(lay: Layout, name: str) -> List[str]:
    if name == "dbus-run-session":
        return [
            f"--dbus-daemon={lay.root}/usr/bin/dbus-daemon",
            f"--config-file={lay.root}/usr/share/dbus-1/session.conf",
        ]
    return []


def launcher_text(lay: Layout, name: str) -> str:
    """The launcher for one required program: the unpacked copy's paths, through proot when it needs /usr."""
    real = lay.root / "usr" / "bin" / REAL_PROGRAMS.get(name, name)
    command = " ".join([str(real), *_extra_args(lay, name)])
    lines = ["#!/bin/sh", f". {lay.env_sh}"]
    if name in MAPPED_PROGRAMS:
        lines.append(
            f'if [ -z "${{{MAPPED_MARKER}:-}}" ]; then export {MAPPED_MARKER}=1; '
            f'exec {lay.root}/usr/bin/proot $(cat {lay.binds}) {command} "$@"; fi'
        )
    lines.append(f'exec {command} "$@"')
    return "\n".join(lines) + "\n"


def _point_dbus_services(lay: Layout) -> None:
    """D-Bus started services (xfconfd and friends) name /usr paths: point them at the unpacked copy."""
    services = lay.root / "usr" / "share" / "dbus-1" / "services"
    if not services.is_dir():
        return
    for path in sorted(services.glob("*.service")):
        if path.is_symlink() or not path.is_file():
            continue
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
        changed = [f"Exec={lay.root}/usr/{line[len('Exec=/usr/'):]}" if line.startswith("Exec=/usr/") else line
                   for line in lines]
        if changed != lines:
            _write(path, "".join(changed), 0o644)


def _compile_schemas(deps: Deps, lay: Layout) -> None:
    schemas = lay.root / "usr" / "share" / "glib-2.0" / "schemas"
    if not schemas.is_dir():
        return
    candidates = [
        deps.which("glib-compile-schemas"),
        str(lay.root / "usr" / "bin" / "glib-compile-schemas"),
        str(lay.libdir / "glib-2.0" / "glib-compile-schemas"),
        "/usr/lib/x86_64-linux-gnu/glib-2.0/glib-compile-schemas",
    ]
    for tool in candidates:
        if tool and os.path.isfile(tool) and os.access(tool, os.X_OK):
            deps.run([tool, str(schemas)], env=_child_env(LD_LIBRARY_PATH=str(lay.libdir)), timeout=60.0)
            return


def _link(lay: Layout, target: Path, link: Path, out: TextIO) -> bool:
    if os.path.lexists(str(link)) and not (link.is_symlink() and lay.owns(link)):
        _say(out, SAY_KEPT_FOREIGN.format(path=link))
        return False
    tmp = link.with_name(f".{link.name}.ocuclaw-link")
    if os.path.lexists(str(tmp)):
        tmp.unlink()
    os.symlink(str(target), str(tmp))
    os.replace(str(tmp), str(link))
    return True


def _install_launchers(deps: Deps, lay: Layout, wanted: Sequence[str], links: Path, out: TextIO) -> None:
    _write(lay.binds, "".join(line + "\n" for line in _binds(deps, lay)), 0o644)
    _write(lay.env_sh, _env_sh(lay), 0o644)
    linked = 0
    for name in wanted:
        launcher = lay.bin / name
        _write(launcher, launcher_text(lay, name), 0o755)
        if _link(lay, launcher, links / name, out):
            linked += 1
    _point_dbus_services(lay)
    _compile_schemas(deps, lay)
    _record_link_dir(lay, links)
    _say(out, SAY_LINKED.format(count=linked, path=links))


def _record_link_dir(lay: Layout, links: Path) -> None:
    """Keep the link folder in the marker, so a removal run with another PATH still finds it."""
    try:
        data = json.loads(lay.marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {"v": 1}
    if isinstance(data, dict):
        data["linkDir"] = str(links)
        _write(lay.marker, json.dumps(data, sort_keys=True) + "\n", 0o644)


def _recorded_link_dir(lay: Layout) -> Optional[str]:
    try:
        raw = json.loads(lay.marker.read_text(encoding="utf-8")).get("linkDir")
    except (OSError, ValueError, AttributeError):
        return None
    return raw if isinstance(raw, str) else None


def _screen(deps: Deps, verb: str, out: TextIO) -> Optional[int]:
    code, text = deps.run(["hermes", "computer-use", "screen", verb], env=_child_env(), timeout=_SCREEN_TIMEOUT_S)
    for line in text.splitlines()[-6:]:
        if line.strip():
            _say(out, line.rstrip())
    return code


def install(deps: Optional[Deps] = None, *, out: Optional[TextIO] = None) -> int:
    """``hermes ocuclaw bot-screen install``. Idempotent: a rerun only rewrites the launchers and starts."""
    out = out or sys.stdout
    deps = deps or live_deps(detect=True)
    problem = host_problem(deps)
    runtime = deps.runtime()
    if problem == "root" or (problem is None and _hermes_installable(runtime)):
        _say(out, SAY_HERMES_CAN if problem is None else SAY_ROOT)
        return EXIT_REFUSED
    if problem is not None:
        _say(out, _REFUSALS[problem])
        return EXIT_REFUSED
    if deps.memory_short():
        _say(out, SAY_MEMORY)
        return EXIT_REFUSED
    lay = Layout.of(deps.home)
    links = link_dir(deps)
    if links is None:  # host_problem checked it; a folder can go between the two reads
        _say(out, SAY_NO_LINK_DIR)
        return EXIT_REFUSED
    required = required_binaries(runtime)
    # A program the host already has elsewhere stays the host's; one of ours is rewritten.
    wanted = [name for name in required if deps.which(name) is None or lay.owns(deps.which(name))]
    if not wanted:
        _say(out, SAY_ALREADY)
    else:
        packages = apt_packages(runtime)
        if not _marker_matches(lay, packages):
            free = deps.free_disk_mb(deps.home)
            if free is not None and free < DISK_NEED_MB:
                _say(out, SAY_DISK.format(need=DISK_NEED_MB, free=free))
                return EXIT_REFUSED
            if not _fetch_and_unpack(deps, lay, packages, out):
                return EXIT_FAILED
        _install_launchers(deps, lay, wanted, links, out)
    still = [name for name in required if deps.which(name) is None]
    if still:
        _say(out, SAY_STILL_MISSING.format(names=", ".join(still)))
        return EXIT_FAILED
    _say(out, SAY_STARTING)
    code = _screen(deps, "start", out)
    if code != 0:
        _say(out, SAY_START_FAILED.format(code=code if code is not None else "none"))
        return EXIT_FAILED
    _screen(deps, "status", out)
    _say(out, SAY_READY)
    return EXIT_OK


# -- removal ---------------------------------------------------------------------


def _link_dirs(deps: Deps) -> List[Path]:
    """The folder the install recorded, the preferred home folders, and every home folder on PATH."""
    home = Path(os.path.realpath(str(deps.home)))
    seen: List[Path] = []
    recorded = _recorded_link_dir(Layout.of(deps.home))
    for raw in ([recorded] if recorded else []) + [str(home / rel) for rel in PREFERRED_LINK_DIRS] \
            + deps.path_env.split(os.pathsep):
        if not raw or not os.path.isabs(raw):
            continue
        entry = Path(os.path.realpath(raw))
        if home in entry.parents and entry not in seen and entry.is_dir():
            seen.append(entry)
    return seen


def _our_links(deps: Deps, lay: Layout) -> List[Path]:
    """Links in the home folders on PATH that point into this install, and only those."""
    found = []
    for folder in _link_dirs(deps):
        if lay.owns(folder):
            continue
        try:
            entries = sorted(folder.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink() and lay.owns(entry):
                found.append(entry)
    return found


def remove(deps: Optional[Deps] = None, *, out: Optional[TextIO] = None, stop: bool = True) -> Dict[str, Any]:
    """Take the no-admin install away: the launcher links (only links into it), then its folder.

    ``{"removed": [paths], "failures": [paths], "links": n}``; empty when there was nothing.
    A running screen from it is stopped first through Hermes (``stop``). Never raises."""
    out = out or sys.stdout
    report: Dict[str, Any] = {"removed": [], "failures": [], "links": 0}
    try:
        deps = deps or live_deps()
        lay = Layout.of(deps.home)
        links = _our_links(deps, lay)
        present = lay.base.is_dir() and not lay.base.is_symlink()
        if not present and not links:
            return report
        if stop and present:
            _screen(deps, "stop", out)
        for link in links:
            try:
                link.unlink()
                report["removed"].append(str(link))
                report["links"] += 1
            except OSError:
                report["failures"].append(str(link))
        if present:
            from .uninstall import _rmtree_owned

            try:
                _rmtree_owned(lay.base)
                report["removed"].append(str(lay.base))
            except OSError:
                report["failures"].append(str(lay.base))
    except Exception as exc:  # noqa: BLE001 - reported, and retryable
        report["failures"].append(f"bot-screen-rootless:{type(exc).__name__}")
    return report


def run_remove(deps: Optional[Deps] = None, *, out: Optional[TextIO] = None) -> int:
    """``hermes ocuclaw bot-screen remove``."""
    out = out or sys.stdout
    report = remove(deps, out=out)
    for path in report["failures"]:
        _say(out, SAY_REMOVE_FAILED.format(path=path))
    if report["failures"]:
        return EXIT_FAILED
    if not report["removed"]:
        _say(out, SAY_NOTHING_TO_REMOVE)
    else:
        _say(out, SAY_REMOVED.format(count=report["links"]))
    return EXIT_OK


def register_cli(subs: Any) -> None:
    """``hermes ocuclaw bot-screen install|remove``."""
    parser = subs.add_parser(
        "bot-screen",
        help="Cloudways: install Hermes's Bot Screen without admin rights",
        description=(
            "On a Cloudways server, where Hermes has no admin rights, put the Bot Screen's "
            "desktop packages in the home folder: apt-get downloads them from this server's own "
            "Debian sources (checked by apt against their signed index), dpkg unpacks them, and "
            "launchers on Hermes's PATH run them. Then Hermes's own screen starts. Safe to re-run. "
            "`remove` takes it all away; `hermes ocuclaw uninstall` does too."
        ),
    )
    verbs = parser.add_subparsers(dest="bot_screen_verb", required=True)
    verbs.add_parser("install", help="Install without admin rights, then start the screen")
    verbs.add_parser("remove", help="Remove the no-admin install and its links")


def dispatch(args: Any) -> int:
    verb = getattr(args, "bot_screen_verb", None)
    if verb == "install":
        return install()
    if verb == "remove":
        return run_remove()
    return EXIT_REFUSED
