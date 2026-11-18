"""Setup running in the Hermes WebUI's ``/terminal`` panel, as setup sees it.

On Cloudways the easiest way into an agent is its own web page: click Open
Agent, sign in, type ``/terminal``. That panel is a real terminal running as
the same user as SSH, so the setup ladder runs there unchanged. Four things are
different, and this module is what tells them apart:

* **It is small.** The panel is about 88 columns by 10 rows, and at most about
  25 rows dragged to full height. Setup keeps its lines short, and no terminal
  draws a QR (#5485): pairing prints the same text-only manual block as SSH.
  Links in the panel are clickable.
* **The page dies with the agent.** The WebUI runs inside the agent's own
  container, so the one restart setup needs takes the page down for about a
  minute and the panel ends at "terminal disconnected". The person reloads
  and opens ``/terminal`` again, and setup carries on by itself: it left one
  guarded line in ``~/.bashrc`` that runs it again. The line is there from
  the start of the run, so a run cut off at any step carries on the same
  way. Before the restart the command also goes into the shell history, so
  where that line cannot be written, the Up arrow and Enter carry on (on a
  wide terminal: a phone's keyboard has no Up arrow).
* **The terminal answers late.** The panel's replies to terminal queries
  travel back over HTTP, so a cursor-position report arrives long after a
  short probe gave up and lands in the input as text. Setup does not probe
  here: the panel is xterm.js, which always decodes UTF-8.
* **The words are different.** Nothing here is SSH, so nothing says "SSH
  drops" or "reconnect".

The WebUI marks the shell it opens with ``HERMES_WEBUI_TERMINAL=1``
(nesquena/hermes-webui ``api/terminal.py``). Nothing else sets it, and an SSH
session never has it, so SSH keeps today's behaviour exactly.
"""
from __future__ import annotations

import ipaddress
import os
import stat
import time
from pathlib import Path
from typing import Callable, Mapping, Optional
from urllib.parse import quote, urlsplit

#: Set to ``1`` by the WebUI in the shell its ``/terminal`` opens.
MARKER_ENV = "HERMES_WEBUI_TERMINAL"

#: The WebUI server's own setting for the origins its pages are served from.
#: On Cloudways it names the agent's public address, ``https://<host>:<port>``.
#: The terminal's shell does not inherit it (the WebUI passes the panel a short
#: allow-list of variables), so it is read from the server process itself.
#: It is a public address, not a secret: only this one name is taken from that
#: environment, and nothing else from it is kept (catalogue rule 11, #6402).
ALLOWED_ORIGINS_ENV = "HERMES_WEBUI_ALLOWED_ORIGINS"

#: How far up the process tree to look for the WebUI server. The panel's shell
#: is its child, setup is the shell's child, and the one-line installer puts a
#: shell in between: three in practice.
ANCESTOR_LIMIT = 8

#: The ``/terminal`` command, as the person types it.
TERMINAL_COMMAND = "/terminal"

_LOOPBACK_HOSTS = frozenset({"localhost", "0.0.0.0"})


def active(env: Optional[Mapping[str, str]] = None) -> bool:
    """Is this process running in the WebUI's ``/terminal`` panel?"""
    env = os.environ if env is None else env
    return str(env.get(MARKER_ENV, "")).strip() == "1"


# -- the WebUI's public address -----------------------------------------------


def pick_origin(value: str) -> Optional[str]:
    """The first public ``https://host[:port]`` in an allowed-origins list.

    Loopback and wildcard hosts are skipped: a link to them opens nothing on
    the person's own computer. Anything with a path, a query or credentials is
    not an origin and is skipped too.
    """
    for item in str(value or "").replace(",", " ").split():
        try:
            parts = urlsplit(item.strip())
            port = parts.port
        except ValueError:
            continue
        host = (parts.hostname or "").lower()
        if parts.scheme != "https" or not host or parts.username or parts.password:
            continue
        if parts.path not in ("", "/") or parts.query or parts.fragment:
            continue
        if host in _LOOPBACK_HOSTS or _is_loopback_ip(host):
            continue
        return f"https://{host}" + (f":{port}" if port else "")
    return None


def _is_loopback_ip(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return address.is_loopback or address.is_unspecified


def _proc_environ(pid: int, proc_root: Path) -> Optional[Mapping[str, str]]:
    try:
        raw = (proc_root / str(pid) / "environ").read_bytes()
    except OSError:
        return None
    env = {}
    for entry in raw.split(b"\0"):
        name, sep, value = entry.partition(b"=")
        if sep:
            env[name.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
    return env


def _parent_pid(pid: int, proc_root: Path) -> Optional[int]:
    try:
        stat = (proc_root / str(pid) / "stat").read_text(encoding="utf-8", errors="replace")
        # The command name is in parentheses and may hold spaces: split after it.
        fields = stat[stat.rindex(")") + 2 :].split()
        parent = int(fields[1])
    except (OSError, ValueError, IndexError):
        return None
    return parent if parent > 0 else None


def find_origin(
    *,
    hermes_home: Optional[Path] = None,
    start_pid: Optional[int] = None,
    proc_root: Path = Path("/proc"),
) -> Optional[str]:
    """The WebUI's public address, or ``None`` when it cannot be read.

    Looks up the process tree for the WebUI server's own setting first, then
    in the Hermes ``.env`` file, which some installs keep it in. ``None`` means
    no link: setup then prints what it always printed.
    """
    pid = os.getppid() if start_pid is None else start_pid
    seen = set()
    for _ in range(ANCESTOR_LIMIT):
        if pid is None or pid <= 1 or pid in seen:
            break
        seen.add(pid)
        environ = _proc_environ(pid, proc_root)
        if environ and environ.get(ALLOWED_ORIGINS_ENV):
            origin = pick_origin(environ[ALLOWED_ORIGINS_ENV])
            if origin:
                return origin
        pid = _parent_pid(pid, proc_root)
    if hermes_home is not None:
        # The profile's own store, read through Hermes (catalogue rule 11).
        from . import secret_access

        return pick_origin(secret_access.read_stored_secret(ALLOWED_ORIGINS_ENV, Path(hermes_home)) or "")
    return None



def terminal_link(origin: str) -> str:
    """The link that opens the WebUI with ``/terminal`` typed in its message box.

    The WebUI reads ``?q=`` on load (static/sessions.js): it fills the box and
    focuses it, and never sends, so the person's Enter opens the terminal.
    """
    return f"{origin}/?q={quote(TERMINAL_COMMAND, safe='/')}"


# -- the shell history --------------------------------------------------------


def history_file(env: Optional[Mapping[str, str]] = None) -> Optional[Path]:
    """The bash history the panel's next shell reads, or ``None``.

    Only for bash, the shell the WebUI starts on Cloudways. ``HISTFILE`` is a
    shell variable that is not exported, so this is bash's own default.
    """
    env = os.environ if env is None else env
    if Path(str(env.get("SHELL") or "")).name != "bash":
        return None
    home = str(env.get("HOME") or "").strip()
    if not home:
        return None
    return Path(home) / ".bash_history"


def can_add_to_history(env: Optional[Mapping[str, str]] = None) -> bool:
    path = history_file(env)
    if path is None:
        return False
    if path.exists():
        return os.access(path, os.W_OK)
    return os.access(path.parent, os.W_OK)


def add_to_history(command: str, env: Optional[Mapping[str, str]] = None) -> bool:
    """Append one command to the history, so Up and Enter run it next time.

    The running shell never saves its own history when the container stops
    under it, so the line written here is the newest one the next shell reads.
    """
    path = history_file(env)
    if path is None:
        return False
    try:
        needs_newline = False
        if path.exists() and path.stat().st_size > 0:
            with open(path, "rb") as handle:
                handle.seek(-1, os.SEEK_END)
                needs_newline = handle.read(1) != b"\n"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(("\n" if needs_newline else "") + command + "\n")
        return True
    except OSError:
        return False


# -- carrying on by itself ----------------------------------------------------
#
# The panel's shell is bash started with ``-i``, so it reads ``~/.bashrc``
# first. As a run starts, and again before the restart, setup adds one line
# there that runs it again, but only in the WebUI's terminal and only for a
# day, so after the reload and ``/terminal`` it carries on with no Up arrow
# (Matt, 2026-10-02: "yes, add the guarded ~/.bashrc line"). The line stays
# when a run is cut off (a second drop, or the WebUI ending the terminal under
# it) and goes when a run in the WebUI ends where the person sees it.

#: The end of setup's line in ``~/.bashrc``, and how setup finds it again.
CARRY_ON_TAG = "# OcuClaw setup carries on after its restart; setup removes this line"

#: How long after it is written the line still starts setup: a day, so a run
#: left at a step for hours still carries on. The deadline is the backstop for
#: a line nothing took out: it can never start setup forever. Later, the shell
#: just opens, and the command is typed as before.
CARRY_ON_WINDOW_S = 24 * 3600


def startup_file(env: Optional[Mapping[str, str]] = None) -> Optional[Path]:
    """The ``~/.bashrc`` the panel's next shell reads, or ``None`` (not bash, no home)."""
    path = history_file(env)
    return None if path is None else path.with_name(".bashrc")


def carry_on_line(command: str, deadline: int) -> str:
    """The line itself: only in the WebUI's terminal, and only until ``deadline``."""
    return (
        f'[ "${MARKER_ENV}" = 1 ] && [ "$(date +%s)" -lt {int(deadline)} ] && '
        f"{command}  {CARRY_ON_TAG}"
    )


def can_carry_on(env: Optional[Mapping[str, str]] = None) -> bool:
    """Can setup add its line? A plain file it may write, or none yet. Never a link."""
    path = startup_file(env)
    if path is None:
        return False
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return os.access(path.parent, os.W_OK)
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and os.access(path, os.W_OK)


def add_carry_on(
    command: str,
    env: Optional[Mapping[str, str]] = None,
    *,
    now_fn: Callable[[], float] = time.time,
) -> bool:
    """Put the line at the end of ``~/.bashrc``, in place of any earlier one. False on failure."""
    if not can_carry_on(env):
        return False
    line = carry_on_line(command, int(now_fn()) + CARRY_ON_WINDOW_S)
    return _rewrite_startup_file(env, add=line)


def has_carry_on(env: Optional[Mapping[str, str]] = None) -> bool:
    """Is setup's line in ``~/.bashrc``? Never read through a link: setup writes none there."""
    path = startup_file(env)
    if path is None:
        return False
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return False
        return CARRY_ON_TAG.encode() in path.read_bytes()
    except OSError:
        return False


def remove_carry_on(env: Optional[Mapping[str, str]] = None) -> bool:
    """Take the line out of ``~/.bashrc``, every other byte as it was. Never raises.

    True when no such line is left.
    """
    return _rewrite_startup_file(env, add=None)


def _rewrite_startup_file(env: Optional[Mapping[str, str]], *, add: Optional[str]) -> bool:
    """Drop every line carrying the tag and, with ``add``, end with that line instead.

    Written whole to a file beside it and moved into place, so a shell starting
    meanwhile reads the old file or the new one, never half of either. The mode
    stays as it was. A link is never written through.
    """
    path = startup_file(env)
    if path is None:
        return add is None
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            # Setup never writes through a link, so no line of its own is there.
            return add is None
        mode = stat.S_IMODE(info.st_mode)
        data = path.read_bytes()
    except FileNotFoundError:
        if add is None:
            return True
        mode, data = 0o644, b""
    except OSError:
        return False
    tag = CARRY_ON_TAG.encode()
    lines = data.splitlines(keepends=True)
    kept = [line for line in lines if tag not in line]
    if add is None and len(kept) == len(lines):
        return True
    body = b"".join(kept)
    if add is not None:
        if body and not body.endswith(b"\n"):
            body += b"\n"
        body += add.encode() + b"\n"
    temporary = path.with_name(path.name + ".ocuclaw-tmp")
    try:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
            os.fchmod(handle.fileno(), mode)
        os.replace(temporary, path)
        return True
    except OSError:
        try:
            temporary.unlink()
        except OSError:
            pass
        return False


__all__ = [
    "ALLOWED_ORIGINS_ENV",
    "CARRY_ON_TAG",
    "CARRY_ON_WINDOW_S",
    "MARKER_ENV",
    "TERMINAL_COMMAND",
    "active",
    "add_carry_on",
    "add_to_history",
    "can_add_to_history",
    "can_carry_on",
    "carry_on_line",
    "find_origin",
    "history_file",
    "pick_origin",
    "remove_carry_on",
    "startup_file",
    "terminal_link",
]
