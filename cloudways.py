"""The Cloudways managed-Hermes path: userspace Tailscale kept alive by the OcuClaw runtime (#2981, #6359).

Cloudways "Managed AI Agents" runs Hermes as a non-root user in a container
with no systemd, no cron binary, no TUN device, and a gateway that is PID 1's
child — `hermes gateway restart` restarts the whole container. Cloudways has
approved a **userspace-networking tailscaled** owned by the user (state in
`~/.tailscale`) for OcuClaw there. The server's own `/usr/bin/tailscaled` runs
it (#6358); we download nothing, and a server without it is told to restart
from the Cloudways panel for the current image. Boxes an earlier OcuClaw set up
on its own `~/bin` copy are moved off it (#6360). The OcuClaw Node runtime,
which the gateway starts on every gateway start, brings the daemon back after
a restart (#6359). This module is that path, as deterministic idempotent verbs
the on-box Hermes agent runs from its terminal tool:

    hermes ocuclaw cloudways detect     which environment signals fired
    hermes ocuclaw cloudways install    the server's binaries, state dirs, host
                                        receipt, runtime state, daemon start
    hermes ocuclaw cloudways enroll     `tailscale up`, print the authorization URL
    hermes ocuclaw cloudways status     daemon / route / supervisor / legacy, optional --wait
    hermes ocuclaw cloudways retry      a fresh authorization URL
    hermes ocuclaw cloudways enable     turn supervision on, start the daemon
    hermes ocuclaw cloudways disable    turn supervision off, stop the daemon
    hermes ocuclaw cloudways rollback   remove supervision, daemon, and the binaries
                                        and host receipt this plugin provisioned

Design rulings this file implements (RULED.md in the arc's evidence dir):

* **Single supervisor.** The OcuClaw runtime keeps the daemon alive, and only
  while `ocuclaw.cloudways.hermes.json` says `supervisor: runtime`. That file
  is written only once the old `ocuclaw-tailscale-watchdog` cron job is gone,
  so two supervisors never share one daemon. `install` and `enable` start the
  daemon once directly, so setup need not wait for a gateway start.
* **Started detached, never `up`.** A daemon that answers is left alone; a
  missing one is spawned in its own session with every fd redirected, so it
  outlives the command that started it. `NeedsLogin` is reported, never fixed:
  a human must open the URL.
* **Loopback SOCKS5.** In userspace mode the host has no route to its own
  tailnet name; the daemon exposes `127.0.0.1:1055` and the host receipt tells
  doctor's probes to dial through it (#2980).
* **Reuse, never duplicate.** Existing identity is adopted; the platform
  binaries are used as they are. An old-ladder box moves onto the platform binary
  with the same `~/.tailscale` state, so no new approval is needed (#6360). The
  2026-09-15 disabled startup hook and the `~/.local/share/tailscale`
  supervisor are reported, never touched. A foreign tailscaled is refused,
  never killed, with one exception: a logged-out daemon on the platform's own
  `/var/lib/tailscale` holds no identity, so `install` replaces it.
* **Adopt Cloudways' own daemon (#6482).** When the only tailscaled is the
  image's own userspace one with its state under `$HOME`, and we hold no
  identity of our own, `install` adopts it instead of refusing: a host record
  names its line, and every verb then talks to its socket. It is never killed,
  restarted or deleted; it is relaunched from its recorded line only when no
  tailscaled at all runs (Cloudways restarts nothing after a reboot).
* **No exposure changes.** No Funnel, no ACL edits, no Tailscale SSH, no `up`
  flags beyond `--hostname` on a fresh identity.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from . import receipts, serve

# -- binaries -----------------------------------------------------------------

#: What `install` says on an image without /usr/bin Tailscale. Every Cloudways
#: image seen ships it, and a panel restart brings the current image, so we
#: download nothing ourselves.
TAILSCALE_MISSING_MESSAGE = (
    "Tailscale is missing on this server. Restart your agent from the Cloudways "
    "panel to get the current server image, then run setup again."
)

#: Where a current Cloudways image puts Tailscale (1.104.4 on 2026-11-02), and
#: the state directory Cloudways' own bootstrap line gives it. That state lives
#: on the overlay root and is wiped by every container restart, so ours stays
#: in `~/.tailscale` on the persistent volume.
PLATFORM_BIN_DIR: Optional[Path] = Path("/usr/bin")
PLATFORM_STATE_DIR = "/var/lib/tailscale"
PLATFORM_SOCKET = "/var/run/tailscale/tailscaled.sock"
BINARIES_PLATFORM = "platform"
BINARIES_BUNDLED = "bundled"

SOCKS5_LISTEN = "127.0.0.1:1055"
#: The Hermes cron supervisor this bundle used before #6359. Only ever looked
#: up to be retired: two supervisors on one daemon is forbidden.
WATCHDOG_JOB_NAME = "ocuclaw-tailscale-watchdog"
WATCHDOG_SCRIPT_NAME = "ocuclaw-tailscale-watchdog.sh"
DAEMON_LOG_MAX_BYTES = 1_048_576
RECEIPT_PROVISIONER = "hermes ocuclaw cloudways"

#: The bundle's runtime state, beside the host receipt: the twin of OpenClaw's
#: `ocuclaw.cloudways.openclaw.json`. The OcuClaw runtime supervises the daemon
#: only while it says `supervisor: runtime` and is not disabled.
HERMES_STATE_FILENAME = "ocuclaw.cloudways.hermes.json"
HERMES_STATE_SCHEMA_VERSION = 1
SUPERVISOR_RUNTIME = "runtime"
SUPERVISOR_OWNER = "ocuclaw-runtime"

CLOUDWAYS_HOSTNAME_SUFFIX = ".cloudwaysagents.com"
CLOUDWAYS_VENV_BIN = "/opt/hermes/hermes-venv/bin"

DETECT_CLOUDWAYS = "cloudways"
DETECT_LIKELY = "likely"
DETECT_NO = "no"

#: Signals only a Cloudways Managed AI Agents box shows. The others (an
#: exported HERMES_HOME, an entrypoint.sh PID 1, no systemctl, no crontab) are
#: true of any plain Docker container, so they can support a "likely" but never
#: make one: a plain lab container scored four of them and read as "likely"
#: (#3348 Hermes finding 1).
CLOUDWAYS_SPECIFIC_SIGNALS = ("hermes_venv_on_path",)

STATE_ABSENT = "absent"  # no binaries installed
STATE_STOPPED = "stopped"  # binaries present, daemon not answering
STATE_STARTING = "starting"
STATE_NEEDS_AUTH = "needs-authorization"
STATE_RUNNING = "running"
STATE_UNKNOWN = "unknown"

_AUTH_URL_RE = re.compile(r"https://login\.tailscale\.com/\S+")
_CMD_TIMEOUT_S = 20.0


# -- layout -------------------------------------------------------------------

_PLATFORM_DEFAULT: Any = object()
#: `Layout.adoption` left at this reads the host adoption record on each use.
_READ_RECORD: Any = object()

@dataclass(frozen=True)
class Layout:
    """Every absolute path the verbs and the generated script agree on.

    On a box where we adopted Cloudways' own daemon (#6482) the socket, CLI
    argv, daemon argv, log and "which process is ours" all follow the host
    adoption record. Our markers stay in `~/.tailscale` either way.
    """

    home: Path
    hermes_home: Path
    # Read at construction, not import, so a test host's own /usr/bin copy can
    # be switched off module-wide. None turns the platform binaries off.
    platform_bin_dir: Optional[Path] = field(default_factory=lambda: PLATFORM_BIN_DIR)
    # Left at the default the record is read on each use, so every verb
    # follows it the moment install writes it. A test, or `pinned()`, passes
    # an `Adoption` (or None) to fix it for the rest of one verb.
    adoption: Any = field(default=_READ_RECORD, compare=False, repr=False)

    @property
    def adopted(self) -> Optional["Adoption"]:
        if self.adoption is _READ_RECORD:
            return read_adoption(self)
        return self.adoption

    def pinned(self) -> "Layout":
        """This layout with the adoption read once, so a verb that removes or
        writes the record halfway through keeps acting on one daemon."""
        return replace(self, adoption=self.adopted)

    @property
    def platform_tailscaled(self) -> Optional[Path]:
        """The image's own tailscaled, the only binary an adopted daemon may run."""
        return None if self.platform_bin_dir is None else Path(self.platform_bin_dir) / "tailscaled"

    @property
    def own_state_flag(self) -> str:
        """The argv token that marks a tailscaled process as the one we keep."""
        adopted = self.adopted
        return adopted.state_flag if adopted is not None else f"--statedir={self.state_dir}"

    @property
    def socks5_listen(self) -> Optional[str]:
        """The loopback SOCKS5 our daemon listens on; an adopted one's own, or None."""
        adopted = self.adopted
        return adopted.socks5 if adopted is not None else SOCKS5_LISTEN

    @property
    def own_log_path(self) -> Path:
        return self.log_dir / "tailscaled.log"

    @property
    def bin_dir(self) -> Path:
        return self.home / "bin"

    @property
    def bundled_tailscale(self) -> Path:
        """Our `~/bin` download, named even when the platform pair is used."""
        return self.bin_dir / "tailscale"

    @property
    def bundled_tailscaled(self) -> Path:
        return self.bin_dir / "tailscaled"

    @property
    def platform_daemon(self) -> Optional[Path]:
        """The installed tailscaled: beside the CLI on a Cloudways image, or in
        the sibling sbin (/usr/sbin) where Tailscale's installer and the Debian
        package put it."""
        base = self.platform_bin_dir
        if base is None:
            return None
        for candidate in (Path(base) / "tailscaled", Path(base).parent / "sbin" / "tailscaled"):
            if candidate.is_file():
                return candidate
        return None

    @property
    def binary_source(self) -> str:
        base = self.platform_bin_dir
        if base is not None and (base / "tailscale").is_file() and self.platform_daemon is not None:
            return BINARIES_PLATFORM
        return BINARIES_BUNDLED

    @property
    def tailscale(self) -> Path:
        # An adopted daemon is the image's, so is its CLI, even if the
        # pair is missing for a moment: never our `~/bin` copy against it.
        if self.binary_source == BINARIES_PLATFORM or (
            self.platform_bin_dir is not None and self.adopted is not None
        ):
            return Path(self.platform_bin_dir) / "tailscale"
        return self.bundled_tailscale

    @property
    def tailscaled(self) -> Path:
        if self.binary_source == BINARIES_PLATFORM or (
            self.platform_bin_dir is not None and self.adopted is not None
        ):
            return self.platform_daemon or Path(self.platform_bin_dir) / "tailscaled"
        return self.bundled_tailscaled

    @property
    def state_dir(self) -> Path:
        return self.home / ".tailscale"

    @property
    def run_dir(self) -> Path:
        return self.state_dir / "run"

    @property
    def socket_path(self) -> Path:
        adopted = self.adopted
        if adopted is not None:
            return Path(adopted.socket)
        return self.run_dir / "tailscaled.sock"

    @property
    def log_dir(self) -> Path:
        return self.state_dir / "log"

    @property
    def needs_auth_marker(self) -> Path:
        return self.state_dir / "needs-authorization"

    @property
    def enrollment_daemon(self) -> Path:
        """Which tailscaled an in-flight enrollment was started against."""
        return self.state_dir / "enrollment-daemon"

    @property
    def watchdog_state(self) -> Path:
        return self.state_dir / "watchdog.state"

    @property
    def watchdog_lock(self) -> Path:
        return self.state_dir / "watchdog.lock"

    @property
    def log_path(self) -> Path:
        adopted = self.adopted
        if adopted is not None:
            return Path(adopted.log_path)
        return self.own_log_path

    @property
    def state_path(self) -> Optional[Path]:
        """The runtime state file. Host-scoped like the receipt, so resolved
        through the same `receipts.host_state_dir()` (and patched with it)."""
        directory = receipts.host_state_dir()
        return None if directory is None else directory / HERMES_STATE_FILENAME

    @property
    def tgz_receipt(self) -> Path:
        return self.state_dir / "ocuclaw-install.json"

    @property
    def scripts_dir(self) -> Path:
        return self.hermes_home / "scripts"

    @property
    def script_path(self) -> Path:
        return self.scripts_dir / WATCHDOG_SCRIPT_NAME

    @property
    def jobs_file(self) -> Path:
        return self.hermes_home / "cron" / "jobs.json"

    @property
    def legacy_supervisor_dir(self) -> Path:
        return self.home / ".local" / "share" / "tailscale"

    @property
    def disabled_hooks_dir(self) -> Path:
        return self.hermes_home / "disabled-hooks"

    def cli_argv(self) -> Tuple[str, ...]:
        return (str(self.tailscale), f"--socket={self.socket_path}")

    def daemon_argv(self) -> Tuple[str, ...]:
        adopted = self.adopted
        if adopted is not None:
            # Exactly the line Cloudways started it with, never our flags.
            return tuple(adopted.daemon_argv)
        return (
            str(self.tailscaled),
            f"--statedir={self.state_dir}",
            f"--socket={self.socket_path}",
            "--tun=userspace-networking",
            f"--socks5-server={SOCKS5_LISTEN}",
        )

    @classmethod
    def resolve(
        cls,
        *,
        home: Optional[Path] = None,
        hermes_home: Optional[Path] = None,
        platform_bin_dir: Any = _PLATFORM_DEFAULT,
    ) -> "Layout":
        resolved_home = Path(home) if home is not None else Path.home()
        if hermes_home is None:
            env_home = os.environ.get("HERMES_HOME", "").strip()
            hermes_home = Path(env_home) if env_home else resolved_home / ".hermes"
        if platform_bin_dir is _PLATFORM_DEFAULT:
            platform_bin_dir = PLATFORM_BIN_DIR
        return cls(
            home=resolved_home,
            hermes_home=Path(hermes_home),
            platform_bin_dir=Path(platform_bin_dir) if platform_bin_dir is not None else None,
        )


# -- adopting Cloudways' own daemon (#6482) ------------------------------------
#
# A current Cloudways image may already run its own userspace tailscaled with
# state under the user's home (`~/tailscale`), signed in by the user. Refusing
# it left the user with no way forward but to kill a daemon they rely on.
# Instead, when it is the only tailscaled and its line is one we can fully
# reason about, we adopt it: talk to its socket, relaunch its exact line after
# a reboot, and never kill, restart or delete it or its state. The rule and the
# record are shared with the OpenClaw bundle through
# `tests/fixtures/tailscale-adoption-contract.json`.

ADOPTION_FILENAME = "ocuclaw.tailscale-adopted.json"
ADOPTION_SCHEMA_VERSION = 1
ADOPTION_KIND = "cloudways-platform"
#: The image's own daemon. A test layout points it elsewhere.
PLATFORM_TAILSCALED = "/usr/bin/tailscaled"
#: Every flag an adoptable line may carry. Anything else changes what the
#: daemon does in a way we have not reasoned about, so it is not adopted.
ADOPTABLE_FLAGS = frozenset({"tun", "state", "statedir", "socket", "port", "socks5-server", "verbose"})
_STATE_FLAGS = ("state", "statedir")
_DIGITS_RE = re.compile(r"[0-9]+")

REASON_NOT_PLATFORM_BINARY = "not-platform-binary"
REASON_FLAG_NOT_ALLOWED = "flag-not-allowed"
REASON_NOT_USERSPACE = "not-userspace"
REASON_NO_STATE_FLAG = "no-state-flag"
REASON_TWO_STATE_FLAGS = "two-state-flags"
REASON_OWN_STATE_DIR = "own-state-dir"
REASON_STATE_OUTSIDE_HOME = "state-outside-home"


def _flag_value_ok(name: str, value: str) -> bool:
    if not value:
        return False
    if name == "socket":
        return os.path.isabs(value)
    if name == "port":
        return bool(_DIGITS_RE.fullmatch(value)) and 0 < int(value) < 65536
    if name == "socks5-server":
        # Loopback only: the proxy has no authentication.
        return receipts.parse_socks5(value) is not None
    if name == "verbose":
        return bool(_DIGITS_RE.fullmatch(value))
    return True  # tun, state, statedir: any non-empty value


def adoptable_daemon(
    argv: Sequence[str], home: Any, *, platform_tailscaled: Any = PLATFORM_TAILSCALED
) -> Dict[str, Any]:
    """May we adopt the tailscaled running ``argv``? Pure; no I/O.

    ``{"adoptable": True, "stateFlag", "socket", "socks5"}`` or
    ``{"adoptable": False, "reason"}``. The checks run in a fixed order so
    both bundles give the same reason for the same line.
    """
    tokens = [str(token) for token in argv]
    if platform_tailscaled is None or not tokens or tokens[0] != str(platform_tailscaled):
        return {"adoptable": False, "reason": REASON_NOT_PLATFORM_BINARY}
    values: Dict[str, str] = {}
    state_flags: List[str] = []
    for token in tokens[1:]:
        # Only the one-token `--name=value` form: a two-token flag could hide
        # its value from this check.
        if not token.startswith("--") or "=" not in token:
            return {"adoptable": False, "reason": REASON_FLAG_NOT_ALLOWED}
        name, _, value = token[2:].partition("=")
        if name not in ADOPTABLE_FLAGS or not _flag_value_ok(name, value):
            return {"adoptable": False, "reason": REASON_FLAG_NOT_ALLOWED}
        if name in _STATE_FLAGS:
            state_flags.append(token)
            continue
        if name in values:
            # tailscaled keeps the last one; we would have to guess which.
            return {"adoptable": False, "reason": REASON_FLAG_NOT_ALLOWED}
        values[name] = value
    if values.get("tun") != "userspace-networking":
        return {"adoptable": False, "reason": REASON_NOT_USERSPACE}
    if not state_flags:
        return {"adoptable": False, "reason": REASON_NO_STATE_FLAG}
    if len(state_flags) > 1:
        return {"adoptable": False, "reason": REASON_TWO_STATE_FLAGS}
    state_flag = state_flags[0]
    # Lexical only: a symlink is the user's to point, and resolving it would
    # make the answer depend on the disk.
    state_path = os.path.normpath(state_flag.partition("=")[2])
    home_text = os.path.normpath(str(home))
    ours = os.path.normpath(os.path.join(home_text, ".tailscale"))
    if state_path == ours or state_path.startswith(ours + os.sep):
        return {"adoptable": False, "reason": REASON_OWN_STATE_DIR}
    # Strictly inside home: the root disk is wiped by every container
    # restart, and home itself is not a state path.
    if not state_path.startswith(home_text.rstrip(os.sep) + os.sep):
        return {"adoptable": False, "reason": REASON_STATE_OUTSIDE_HOME}
    return {
        "adoptable": True,
        "stateFlag": state_flag,
        "socket": values.get("socket", PLATFORM_SOCKET),
        "socks5": values.get("socks5-server"),
    }


@dataclass(frozen=True)
class Adoption:
    """The host adoption record, validated against the rule above."""

    daemon_argv: Tuple[str, ...]
    state_flag: str
    socket: str
    socks5: Optional[str]
    log_path: str
    adopted_by: str
    adopted_at: str

    def summary(self) -> Dict[str, Any]:
        return {
            "socket": self.socket,
            "stateFlag": self.state_flag,
            "logPath": self.log_path,
            "adoptedBy": self.adopted_by,
        }


def adoption_path() -> Optional[Path]:
    """Host-scoped like the CLI receipt: one tailscaled per box."""
    directory = receipts.host_state_dir()
    return None if directory is None else directory / ADOPTION_FILENAME


def _iso_now_ms() -> str:
    """The OpenClaw bundle's `toISOString()` form, so both write the same shape."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def adoption_log_path(layout: Layout) -> Path:
    """Cloudways' own `~/logs` when the box has one, else our log."""
    logs = layout.home / "logs"
    return logs / "tailscale.log" if logs.is_dir() else layout.own_log_path


def build_adoption_body(
    argv: Sequence[str],
    verdict: Mapping[str, Any],
    *,
    log_path: Any,
    adopted_by: str = RECEIPT_PROVISIONER,
    adopted_at: Optional[str] = None,
) -> Dict[str, Any]:
    if not verdict.get("adoptable"):
        raise ValueError(f"not adoptable: {verdict.get('reason')}")
    return {
        "schemaVersion": ADOPTION_SCHEMA_VERSION,
        "kind": ADOPTION_KIND,
        "daemonArgv": [str(token) for token in argv],
        "stateFlag": verdict["stateFlag"],
        "socket": verdict["socket"],
        "logPath": str(log_path),
        "adoptedBy": adopted_by,
        "adoptedAt": adopted_at or _iso_now_ms(),
    }


def write_adoption(body: Mapping[str, Any]) -> Path:
    path = adoption_path()
    if path is None:
        raise receipts.ReceiptUnavailableError("no host state directory")
    return receipts.write_json_receipt(path, body, durable=True)


def remove_adoption() -> bool:
    path = adoption_path()
    if path is None:
        return False
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    return True


def _raw_adoption() -> Optional[Dict[str, Any]]:
    path = adoption_path()
    if path is None:
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def read_adoption(layout: Layout) -> Optional[Adoption]:
    """The record, re-validated with today's home; anything off reads as absent.

    Absent means today's behaviour: our own daemon on `~/.tailscale`. A stale
    or forged record can therefore never point a verb at a daemon the rule
    would not adopt now.
    """
    record = _raw_adoption()
    if record is None:
        return None
    if record.get("schemaVersion") != ADOPTION_SCHEMA_VERSION or record.get("kind") != ADOPTION_KIND:
        return None
    argv = record.get("daemonArgv")
    if not isinstance(argv, list) or not argv or not all(isinstance(token, str) for token in argv):
        return None
    verdict = adoptable_daemon(argv, layout.home, platform_tailscaled=layout.platform_tailscaled)
    if not verdict["adoptable"]:
        return None
    if record.get("stateFlag") != verdict["stateFlag"] or record.get("socket") != verdict["socket"]:
        return None
    log_path = record.get("logPath")
    home_text = os.path.normpath(str(layout.home))
    if (
        not isinstance(log_path, str)
        or not os.path.isabs(log_path)
        # We append the daemon's output to it: never outside the user's home.
        or not os.path.normpath(log_path).startswith(home_text.rstrip(os.sep) + os.sep)
    ):
        return None
    adopted_by = record.get("adoptedBy")
    adopted_at = record.get("adoptedAt")
    if not isinstance(adopted_by, str) or not adopted_by or not isinstance(adopted_at, str):
        return None
    return Adoption(
        daemon_argv=tuple(argv),
        state_flag=verdict["stateFlag"],
        socket=verdict["socket"],
        socks5=verdict["socks5"],
        log_path=os.path.normpath(log_path),
        adopted_by=adopted_by,
        adopted_at=adopted_at,
    )


Runner = Callable[..., Any]


def _run(
    argv: Sequence[str],
    *,
    runner: Optional[Runner] = None,
    timeout_s: float = _CMD_TIMEOUT_S,
    env: Optional[Mapping[str, str]] = None,
    raise_spawn_error: bool = False,
) -> Tuple[Optional[int], str, str]:
    """Bounded subprocess; ``(None, "", reason)`` when it could not run."""
    runner = subprocess.run if runner is None else runner
    try:
        completed = runner(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            env=dict(env) if env is not None else None,
        )
    except subprocess.TimeoutExpired as exc:
        # CPython hands the killed child's partial output back as bytes even in
        # text mode; `tailscale up` prints its authorization URL and then blocks,
        # so dropping this would drop the URL (seen live on Cloudways).
        out = _text(exc.stdout)
        err = _text(exc.stderr)
        return None, out, err or "timeout"
    except (OSError, ValueError) as exc:
        if raise_spawn_error:
            raise
        return None, "", str(exc)
    return (
        int(getattr(completed, "returncode", 1)),
        _text(getattr(completed, "stdout", "")),
        _text(getattr(completed, "stderr", "")),
    )


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value or "")


# -- detect -------------------------------------------------------------------


@dataclass
class Detection:
    verdict: str
    signals: Dict[str, bool]
    hostname: str

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


def detect(
    *,
    hostname: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    path_exists: Optional[Callable[[str], bool]] = None,
    which: Optional[Callable[[str], Optional[str]]] = None,
    proc1_cmdline: Optional[str] = None,
) -> Detection:
    """Is this a Cloudways Managed AI Agents container?

    Measured on a real box on 2026-09-16. The hostname suffix alone is
    decisive. Without it, "likely" needs a Cloudways-specific signal (the
    Cloudways Hermes venv) plus at least three supporting signals in all; the
    Setup Assistant turns "likely" into one question to the user. Generic
    container facts alone always read "no".
    """
    env = os.environ if env is None else env
    path_exists = os.path.exists if path_exists is None else path_exists
    which = shutil.which if which is None else which
    if hostname is None:
        try:
            hostname = socket.gethostname()
        except OSError:
            hostname = ""
    if proc1_cmdline is None:
        # `ps` rather than a /proc read: same answer, and the Hermes plugin
        # guard scores a /proc path read as traversal, which would block the
        # staged bundle for every tester.
        rc, out, _ = _run(("ps", "-o", "args=", "-p", "1"), timeout_s=5.0)
        proc1_cmdline = out.strip() if rc == 0 else ""
    path_entries = env.get("PATH", "").split(os.pathsep)
    signals = {
        "hostname_cloudwaysagents": hostname.lower().endswith(CLOUDWAYS_HOSTNAME_SUFFIX),
        "hermes_venv_on_path": CLOUDWAYS_VENV_BIN in path_entries
        or path_exists(CLOUDWAYS_VENV_BIN),
        "hermes_home_exported": bool(env.get("HERMES_HOME", "").strip()),
        "pid1_entrypoint_sh": "entrypoint.sh" in proc1_cmdline,
        "no_systemctl": which("systemctl") is None,
        "no_crontab": which("crontab") is None,
    }
    if signals["hostname_cloudwaysagents"]:
        verdict = DETECT_CLOUDWAYS
    else:
        supporting = sum(1 for key, hit in signals.items() if hit and key != "hostname_cloudwaysagents")
        specific = any(signals[key] for key in CLOUDWAYS_SPECIFIC_SIGNALS)
        verdict = DETECT_LIKELY if specific and supporting >= 3 else DETECT_NO
    return Detection(verdict=verdict, signals=signals, hostname=hostname)


# -- daemon state -------------------------------------------------------------


@dataclass
class DaemonState:
    state: str
    backend: Optional[str] = None
    node_name: Optional[str] = None
    dns_name: Optional[str] = None
    online: Optional[bool] = None
    key_expiry: Optional[str] = None
    auth_url: Optional[str] = None  # set by tailscaled once `up` has started a login
    detail: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _binaries_present(layout: Layout) -> bool:
    return layout.tailscale.is_file() and layout.tailscaled.is_file()


def daemon_state(layout: Layout, *, runner: Optional[Runner] = None, timeout_s: float = 8.0) -> DaemonState:
    """What the daemon behind the receipt's socket says about itself."""
    if not _binaries_present(layout):
        return DaemonState(state=STATE_ABSENT, detail="tailscale binaries are not installed")
    rc, out, err = _run(
        layout.cli_argv() + ("status", "--json"), runner=runner, timeout_s=timeout_s
    )
    if rc is None:
        return DaemonState(state=STATE_STOPPED, detail=f"tailscale status did not answer: {err}")
    document: Any = None
    try:
        document = json.loads(out) if out.strip() else None
    except ValueError:
        document = None
    if not isinstance(document, dict):
        lowered = (out + err).lower()
        if "doesn't appear to be running" in lowered or "failed to connect" in lowered:
            return DaemonState(state=STATE_STOPPED, detail="socket is not answering")
        return DaemonState(state=STATE_UNKNOWN, detail=(err or out).strip()[:200])
    backend = document.get("BackendState")
    self_node = document.get("Self") if isinstance(document.get("Self"), Mapping) else {}
    dns_name = serve.normalize_dns_name(self_node.get("DNSName")) if self_node else None
    report = DaemonState(
        state=STATE_UNKNOWN,
        backend=backend if isinstance(backend, str) else None,
        node_name=(self_node.get("HostName") if isinstance(self_node.get("HostName"), str) else None),
        dns_name=dns_name,
        online=self_node.get("Online") if isinstance(self_node.get("Online"), bool) else None,
        key_expiry=(self_node.get("KeyExpiry") if isinstance(self_node.get("KeyExpiry"), str) else None),
        auth_url=(document.get("AuthURL") or None) if isinstance(document.get("AuthURL"), str) else None,
    )
    if backend == "Running":
        report.state = STATE_RUNNING
    elif backend in ("NeedsLogin", "NeedsMachineAuth"):
        report.state = STATE_NEEDS_AUTH
        report.detail = (
            "machine approval is pending in the tailnet admin console"
            if backend == "NeedsMachineAuth"
            else "the node must be authorized: run `hermes ocuclaw cloudways retry`"
        )
    elif backend in ("NoState", "Starting"):
        report.state = STATE_STARTING
    elif backend == "Stopped":
        report.state = STATE_NEEDS_AUTH if layout.needs_auth_marker.exists() else STATE_STOPPED
        report.detail = "tailscaled is up but `tailscale up` has not been run"
    return report


# -- legacy inventory ---------------------------------------------------------


def legacy_inventory(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    """Report the 2026-09-15 experiments so nobody activates two supervisors.

    Report-only by ruling: nothing here is deleted or started.
    """
    supervisor_dir = layout.legacy_supervisor_dir
    hooks = []
    if layout.disabled_hooks_dir.is_dir():
        hooks = sorted(
            entry.name
            for entry in layout.disabled_hooks_dir.iterdir()
            if entry.is_dir() and "tailscale" in entry.name.lower()
        )
    foreign: List[str] = []
    for _pid, argv, line in _process_lines(runner):
        if _is_foreign_tailscaled(layout, argv):
            foreign.append(line[:200])
        elif "supervisor.py" in line and str(supervisor_dir) in line:
            foreign.append(line[:200])
    return {
        "legacySupervisorDir": str(supervisor_dir),
        "legacySupervisorPresent": (supervisor_dir / "supervisor.py").is_file(),
        "disabledTailscaleHooks": hooks,
        "foreignDaemonProcesses": foreign,
    }


def _process_lines(runner: Optional[Runner]) -> List[Tuple[int, List[str], str]]:
    """``(pid, argv, line)`` for every tailscaled or supervisor process but ours."""
    rc, out, _ = _run(("pgrep", "-af", "tailscaled|supervisor.py"), runner=runner, timeout_s=5.0)
    if rc != 0:
        return []
    found: List[Tuple[int, List[str], str]] = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2 or not parts[0].isdigit() or int(parts[0]) == os.getpid():
            continue
        found.append((int(parts[0]), parts[1:], line.strip()))
    return found


def _is_foreign_tailscaled(layout: Layout, argv: Sequence[str]) -> bool:
    """A tailscaled that is not the one we keep: ours carries `own_state_flag`
    (`--statedir=~/.tailscale`, or an adopted daemon's own state flag)."""
    return Path(argv[0]).name == "tailscaled" and layout.own_state_flag not in argv


def platform_daemon_socket(argv_text: str) -> Optional[str]:
    """The socket of a daemon on the platform's own state directory, else None.

    That is Cloudways' bootstrap line (#6358); any other foreign daemon is
    somebody's install and stays refused.
    """
    tokens = str(argv_text or "").split()
    on_platform_state = any(
        token == f"--statedir={PLATFORM_STATE_DIR}"
        or token.startswith(f"--state={PLATFORM_STATE_DIR}/")
        for token in tokens
    )
    if not on_platform_state:
        return None
    for token in tokens:
        if token.startswith("--socket="):
            return token[len("--socket="):]
    return PLATFORM_SOCKET


def replace_logged_out_platform_daemons(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    kill: Optional[Callable[[int, int], None]] = None,
    sleep: Optional[Callable[[float], None]] = None,
    attempts: int = 20,
) -> Dict[str, Any]:
    """Stop each platform-started daemon nobody logged in to.

    Its state is on the overlay root, wiped by every container restart, so it
    holds no identity to lose. A logged-in one, or one that does not answer, is
    left alone, and the foreign-supervisor refusal still catches it.
    """
    kill = os.kill if kill is None else kill
    sleep = time.sleep if sleep is None else sleep
    replaced: List[int] = []
    for pid, argv, _line in _process_lines(runner):
        if not _is_foreign_tailscaled(layout, argv):
            continue
        socket_path = platform_daemon_socket(" ".join(argv))
        if socket_path is None:
            continue
        # A logged-out daemon can exit non-zero and still print its document.
        _rc, out, _err = _run(
            (str(layout.tailscale), f"--socket={socket_path}", "status", "--json"),
            runner=runner,
            timeout_s=8.0,
        )
        try:
            document = json.loads(out) if out.strip() else None
        except ValueError:
            document = None
        backend = document.get("BackendState") if isinstance(document, dict) else None
        if backend not in ("NeedsLogin", "NoState"):
            continue
        try:
            kill(pid, signal.SIGTERM)
        except OSError:
            continue
        replaced.append(pid)
    if not replaced:
        return {"replaced": []}
    for _ in range(attempts):
        alive = {pid for pid, _argv, _line in _process_lines(runner)}
        if not alive.intersection(replaced):
            return {"replaced": replaced}
        sleep(0.25)
    return {"replaced": replaced, "stillRunning": sorted(alive.intersection(replaced))}


# -- cron job -----------------------------------------------------------------


def _hermes_bin() -> str:
    found = shutil.which("hermes")
    if found:
        return found
    # A gateway started without the venv on PATH still has its own Python's
    # folder; on Windows the console script there is hermes.exe (#6377: chat
    # setup's step 2 failed on the Windows runner).
    folder = Path(sys.executable).parent
    for name in ("hermes", "hermes.exe"):
        sibling = folder / name
        if sibling.exists():
            return str(sibling)
    return "hermes"


def hermes_bin() -> str:
    """Public name for the one answer to "which hermes" (used by #3102)."""
    return _hermes_bin()


def read_jobs(layout: Layout) -> List[Dict[str, Any]]:
    try:
        raw = layout.jobs_file.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError):
        return []
    jobs = data.get("jobs") if isinstance(data, dict) else None
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    return [job for job in (jobs or []) if isinstance(job, dict)]


def find_watchdog_job(layout: Layout) -> Optional[Dict[str, Any]]:
    for job in read_jobs(layout):
        if job.get("name") == WATCHDOG_JOB_NAME:
            return job
    return None


def job_schedule_text(job: Mapping[str, Any]) -> str:
    """Hermes stores the schedule as ``{"kind","expr","display"}`` (0.21.1) or a string."""
    schedule = job.get("schedule")
    if isinstance(schedule, Mapping):
        return str(schedule.get("expr") or schedule.get("display") or "").strip()
    return str(schedule or "").strip()


def _cron(layout: Layout, *args: str, runner: Optional[Runner] = None) -> Tuple[Optional[int], str, str]:
    env = dict(os.environ)
    env["HERMES_HOME"] = str(layout.hermes_home)
    return _run((_hermes_bin(), "cron", *args), runner=runner, timeout_s=40.0, env=env)


def retire_watchdog(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    """Remove the pre-#6359 cron supervisor: its job, script, lock and state.

    Idempotent. The job goes first; when Hermes refuses to remove it, its
    script stays too, so the job still works and the caller must not hand the
    daemon to the runtime.
    """
    removed: List[str] = []
    job = find_watchdog_job(layout)
    if job is not None:
        rc, out, err = _cron(layout, "remove", str(job.get("id")), runner=runner)
        if rc != 0:
            return {"ok": False, "error": f"cron remove: {(err or out).strip()[:300]}", "removed": removed}
        removed.append(f"cron:{job.get('id')}")
    for path in (layout.script_path, layout.watchdog_lock, layout.watchdog_state):
        try:
            path.unlink()
            removed.append(str(path))
        except FileNotFoundError:
            pass
        except OSError as exc:
            return {"ok": False, "error": f"{path}: {exc}", "removed": removed}
    return {"ok": True, "removed": removed}


# -- the runtime state ----------------------------------------------------------


def read_hermes_state(layout: Layout) -> Optional[Dict[str, Any]]:
    """The runtime state file, or None when missing or unreadable."""
    path = layout.state_path
    if path is None:
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def write_hermes_state(layout: Layout, *, enabled: bool) -> Path:
    """Hand the daemon to the OcuClaw runtime. Only once the cron job is gone."""
    path = layout.state_path
    if path is None:
        raise receipts.ReceiptUnavailableError("no host state directory")
    return receipts.write_json_receipt(
        path,
        {
            "schemaVersion": HERMES_STATE_SCHEMA_VERSION,
            "enabled": bool(enabled),
            "provisioner": RECEIPT_PROVISIONER,
            "supervisor": SUPERVISOR_RUNTIME,
            "stateDir": str(layout.state_dir),
            "socket": str(layout.socket_path),
            "socks5": layout.socks5_listen,
            "updatedAt": receipts.now_iso(),
        },
        durable=True,
    )


def remove_hermes_state(layout: Layout) -> bool:
    path = layout.state_path
    if path is None:
        return False
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    return True


def supervisor_summary(layout: Layout) -> Dict[str, Any]:
    state = read_hermes_state(layout)
    present = state is not None and state.get("supervisor") == SUPERVISOR_RUNTIME
    return {
        "owner": SUPERVISOR_OWNER,
        "present": present,
        "enabled": (state.get("enabled") is not False) if present else None,
    }


def _receipt_is_ours() -> bool:
    receipt = receipts.read_tailscale_cli()
    return receipt is not None and receipt.provisioner == RECEIPT_PROVISIONER


def adopt_runtime_supervisor(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    """Plugin upgrade on an old-ladder box: cron watchdog → OcuClaw runtime.

    Acts only on our own install that still has the watchdog job. A paused job
    meant `disable`, so the state says disabled then.
    """
    if not _receipt_is_ours():
        return {"adopted": False, "reason": "no-hermes-receipt"}
    job = find_watchdog_job(layout)
    if job is None:
        return {"adopted": False, "reason": "no-watchdog-job"}
    enabled = job.get("enabled", True) is not False
    retired = retire_watchdog(layout, runner=runner)
    if not retired["ok"]:
        return {"adopted": False, "reason": "watchdog-not-retired", "error": retired.get("error")}
    write_hermes_state(layout, enabled=enabled)
    return {"adopted": True, "enabled": enabled, "removed": retired["removed"]}


# -- install ------------------------------------------------------------------


def _installed_version(layout: Layout, *, runner: Optional[Runner]) -> Optional[str]:
    if not _binaries_present(layout):
        return None
    rc, out, _ = _run((str(layout.tailscale), "version"), runner=runner, timeout_s=8.0)
    if rc != 0:
        return None
    first = out.strip().splitlines()[0].strip() if out.strip() else ""
    return first or None


def install_binaries(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    """The server's own binaries, or a refusal: nothing is ever downloaded.

    Nothing is written, so `installed` stays empty and nothing can ever name a
    root-owned /usr/bin file for removal.
    """
    if layout.binary_source != BINARIES_PLATFORM:
        return {"binaries": "missing", "error": TAILSCALE_MISSING_MESSAGE}
    version = _installed_version(layout, runner=runner)
    return {"binaries": BINARIES_PLATFORM, "version": version, "installed": []}


def receipt_body(layout: Layout, *, provisioner: str = RECEIPT_PROVISIONER) -> Dict[str, Any]:
    """The host CLI receipt for this layout.

    An adopted daemon is reached through its own loopback SOCKS5 when its line
    has one; otherwise probes dial through `tailscale nc` on its socket, since
    we never restart it to add a listener (#6482).
    """
    socks5 = layout.socks5_listen
    return receipts.build_tailscale_cli_body(
        argv=layout.cli_argv(),
        socks5=socks5,
        provisioner=provisioner,
        dial=receipts.DIAL_TAILSCALE_NC if socks5 is None else None,
    )


def write_receipt(layout: Layout) -> Path:
    return receipts.write_tailscale_cli(receipt_body(layout))


def prepare_state_dirs(layout: Layout) -> None:
    for directory in (layout.state_dir, layout.run_dir, layout.log_dir):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)


def refuse_if_foreign_supervisor(inventory: Mapping[str, Any]) -> Optional[str]:
    foreign = inventory.get("foreignDaemonProcesses") or []
    if foreign:
        return (
            "another tailscaled or the legacy supervisor is running; stop it first "
            "(never run two supervisors): " + "; ".join(str(item) for item in foreign)
        )
    return None


# -- start the daemon ------------------------------------------------------------

Spawner = Callable[[Layout], Mapping[str, Any]]
_SETTLED = (STATE_RUNNING, STATE_NEEDS_AUTH)


def _rotate_daemon_log(layout: Layout) -> None:
    if layout.log_path != layout.own_log_path:
        return  # Cloudways' own `~/logs` file: appended to, never moved
    try:
        if layout.log_path.stat().st_size > DAEMON_LOG_MAX_BYTES:
            os.replace(layout.log_path, layout.log_path.with_name(layout.log_path.name + ".1"))
    except OSError:
        pass


def _default_spawn(layout: Layout) -> Dict[str, Any]:
    """Detached in its own session, every fd redirected to the log.

    The daemon must outlive the command that started it, and an inherited pipe
    would tie it to that command's reader. An adopted daemon runs its recorded
    line exactly and appends to its recorded log.
    """
    if layout.log_path == layout.own_log_path:
        layout.log_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(layout.log_dir, 0o700)
    _rotate_daemon_log(layout)
    fd = os.open(layout.log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        child = subprocess.Popen(  # noqa: S603 - fixed argv, absolute binary
            list(layout.daemon_argv()),
            stdin=subprocess.DEVNULL,
            stdout=fd,
            stderr=fd,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        os.close(fd)
    return {"pid": child.pid}


def _our_daemon_processes(layout: Layout, runner: Optional[Runner]) -> List[Tuple[int, List[str]]]:
    own = layout.own_state_flag
    return [
        (pid, argv)
        for pid, argv, _line in _process_lines(runner)
        if Path(argv[0]).name == "tailscaled" and own in argv
    ]


def start_daemon(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    spawn: Optional[Spawner] = None,
    sleep: Optional[Callable[[float], None]] = None,
    attempts: int = 40,
) -> Dict[str, Any]:
    """Start the daemon if nothing of ours answers, then wait for it to settle.

    Never runs `up`: authorization needs a human.

    An adopted daemon (#6482) is only ever relaunched, from its recorded line,
    when no tailscaled at all is running: Cloudways restarts nothing after a
    reboot, and a second daemon beside a live one would split the identity.
    """
    layout = layout.pinned()
    adopted = layout.adopted is not None
    if not _binaries_present(layout):
        return {"action": "absent", "state": STATE_ABSENT, "detail": "tailscale binaries are not installed"}
    before = daemon_state(layout, runner=runner)
    if before.state not in (STATE_STOPPED, STATE_ABSENT):
        if before.state == STATE_RUNNING:
            layout.needs_auth_marker.unlink(missing_ok=True)
        return {"action": "kept", "state": before.state, "detail": before.detail or ""}
    refusal = refuse_if_foreign_supervisor(legacy_inventory(layout, runner=runner))
    if refusal:
        return {"action": "refused", "state": before.state, "detail": refusal}
    if _our_daemon_processes(layout, runner):
        return {
            "action": "starting",
            "state": STATE_STARTING,
            "detail": "tailscaled process exists but its socket is not answering yet",
        }
    if adopted:
        # The checks above see every tailscaled, ours or not; this one only
        # makes "none at all" explicit before we start the user's own line.
        if any(Path(argv[0]).name == "tailscaled" for _pid, argv, _line in _process_lines(runner)):
            return {
                "action": "refused",
                "state": before.state,
                "detail": "a tailscaled is already running; the adopted daemon is not started beside it",
            }
    else:
        prepare_state_dirs(layout)
    spawn = _default_spawn if spawn is None else spawn
    sleep = time.sleep if sleep is None else sleep
    try:
        spawned = spawn(layout) or {}
    except OSError as exc:
        return {"action": "start-failed", "state": STATE_STOPPED, "detail": str(exc)[:200]}
    # A fresh daemon answers NoState for a few seconds before it settles.
    state = daemon_state(layout, runner=runner)
    for _ in range(attempts):
        if state.state in _SETTLED:
            break
        sleep(0.5)
        state = daemon_state(layout, runner=runner)
    if state.state in (STATE_STOPPED, STATE_ABSENT):
        return {
            "action": "start-failed",
            "state": state.state,
            "pid": spawned.get("pid"),
            "detail": f"tailscaled did not answer after start; see {layout.log_path}",
        }
    if state.state == STATE_RUNNING:
        layout.needs_auth_marker.unlink(missing_ok=True)
    if not adopted:
        # An adopted daemon's socket is Cloudways' to set; others may use it.
        try:
            os.chmod(layout.socket_path, 0o600)
        except OSError:
            pass  # the daemon owns it
    return {"action": "started", "state": state.state, "pid": spawned.get("pid"), "detail": state.detail or ""}


# -- move an old-ladder box onto the platform binary (#6360) ---------------------


def _downloaded_by_ocuclaw(layout: Layout) -> bool:
    """Our tgz receipt in `~/.tailscale` (the Hermes one names no provisioner):
    proof the `~/bin` copy is our download."""
    try:
        record = json.loads(layout.tgz_receipt.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (
        isinstance(record, dict)
        and isinstance(record.get("url"), str)
        and record["url"].startswith("https://pkgs.tailscale.com/")
        and isinstance(record.get("sha256"), str)
    )


def bundled_binary_in_use(layout: Layout) -> bool:
    """Is this box still on our `~/bin` download while the image ships its own?

    Read-only and spawns nothing, so `status` can ask it. A `~/bin` copy that
    no install receipt of ours names is the user's, and never a pending move.
    """
    if layout.binary_source != BINARIES_PLATFORM or layout.adopted is not None:
        return False
    receipt = receipts.read_tailscale_cli()
    if receipt is not None and receipt.provisioner != RECEIPT_PROVISIONER:
        return False
    if receipt is not None and _same_file(receipt.argv[0], layout.bundled_tailscale):
        return True
    on_disk = layout.bundled_tailscale.is_file() or layout.bundled_tailscaled.is_file()
    return on_disk and _downloaded_by_ocuclaw(layout)


def move_to_platform_binary(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    kill: Optional[Callable[[int, int], None]] = None,
    sleep: Optional[Callable[[float], None]] = None,
    spawn: Optional[Spawner] = None,
) -> Dict[str, Any]:
    """Restart our daemon from the platform binary with the same `~/.tailscale`.

    The node name, its login and the serve route all carry over, so nothing
    needs approving again. Then the host receipt names the platform CLI, and the
    download goes, only when our own tgz receipt says we put it there.
    """
    if layout.binary_source != BINARIES_PLATFORM:
        return {"moved": False, "reason": "no-platform-binary"}
    if layout.adopted is not None:
        # The adopted daemon already runs the image's binary, and it is never
        # ours to restart.
        return {"moved": False, "reason": "adopted"}
    receipt = receipts.read_tailscale_cli()
    if receipt is not None and receipt.provisioner != RECEIPT_PROVISIONER:
        return {"moved": False, "reason": f"receipt-provisioned-by-{receipt.provisioner}"}
    bundled = str(layout.bundled_tailscaled)
    on_bundled = [pid for pid, argv in _our_daemon_processes(layout, runner) if argv[0] == bundled]
    if not on_bundled and not bundled_binary_in_use(layout):
        return {"moved": False, "reason": "already-on-platform"}
    report: Dict[str, Any] = {"moved": True, "restarted": False}
    if on_bundled:
        stopped = stop_daemon(layout, runner=runner, kill=kill, sleep=sleep)
        if stopped["daemon"] == "still-running":
            return {"moved": False, "reason": "old-daemon-did-not-stop", "pids": stopped.get("pids", [])}
        started = start_daemon(layout, runner=runner, spawn=spawn, sleep=sleep)
        if started["action"] not in ("started", "kept"):
            # Never leave the box offline: bring the old daemon back and keep it.
            restored = start_daemon(
                replace(layout, platform_bin_dir=None), runner=runner, spawn=spawn, sleep=sleep
            )
            return {
                "moved": False,
                "reason": "platform-daemon-did-not-start",
                "daemon": started,
                "restored": restored,
            }
        report["restarted"] = True
        report["daemon"] = started
    if receipt is not None:
        report["receipt"] = str(write_receipt(layout))
    removed: List[str] = []
    if _downloaded_by_ocuclaw(layout):
        for target in (layout.bundled_tailscale, layout.bundled_tailscaled, layout.tgz_receipt):
            try:
                target.unlink()
                removed.append(str(target))
            except OSError:
                pass  # already gone
        try:
            layout.bin_dir.rmdir()
            removed.append(str(layout.bin_dir))
        except OSError:
            pass  # holds other files
    else:
        report["bundledKept"] = "no install receipt names this download"
    report["removed"] = removed
    return report


def install(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    start: bool = True,
    kill: Optional[Callable[[int, int], None]] = None,
    sleep: Optional[Callable[[float], None]] = None,
    spawn: Optional[Spawner] = None,
) -> Dict[str, Any]:
    """Binaries, receipt, runtime state, then one daemon start.

    A box where Cloudways already runs its own signed-in userspace daemon has
    that daemon adopted instead (#6482): nothing is started, stopped or
    killed, and from then on every verb follows the adoption record. A record
    already on disk makes this the idempotent re-run of that adoption.
    """
    layout = layout.pinned()
    report: Dict[str, Any] = {"ok": False, "layout": layout_summary(layout)}
    replaced = replace_logged_out_platform_daemons(layout, runner=runner, kill=kill, sleep=sleep)
    if replaced["replaced"]:
        report["replacedPlatformDaemons"] = replaced["replaced"]
    if layout.adopted is None:
        found = find_adoptable(layout, runner=runner)
        for key in ("foreignNotAdoptable", "adoptable"):
            if key in found:
                report[key] = found[key]
        if found.get("error"):
            report["legacy"] = legacy_inventory(layout, runner=runner)
            report["error"] = found["error"]
            return report
        if found.get("adopt"):
            return _install_adopted(layout, found, report, runner=runner)
    inventory = legacy_inventory(layout, runner=runner)
    report["legacy"] = inventory
    refusal = refuse_if_foreign_supervisor(inventory)
    if refusal:
        report["error"] = refusal
        return report
    report.update(install_binaries(layout, runner=runner))
    if report.get("error"):
        # Nothing written: no receipt, no state, no `~/bin`.
        return report
    if layout.adopted is None:
        prepare_state_dirs(layout)
    report["receipt"] = str(write_receipt(layout))
    # The cron job goes before the runtime state exists: never two supervisors.
    retired = retire_watchdog(layout, runner=runner)
    report["watchdogRetired"] = retired["removed"]
    if not retired["ok"]:
        report["error"] = f"old watchdog: {retired.get('error')}"
        return report
    report["state"] = str(write_hermes_state(layout, enabled=True))
    move = move_to_platform_binary(layout, runner=runner, kill=kill, sleep=sleep, spawn=spawn)
    if move["moved"]:
        report["moved"] = move
    elif move["reason"] in ("old-daemon-did-not-stop", "platform-daemon-did-not-start"):
        report["moved"] = move
        report["error"] = f"could not move Tailscale onto {layout.tailscaled}: {move['reason']}"
        return report
    if start:
        report["daemon"] = start_daemon(layout, runner=runner, spawn=spawn, sleep=sleep)
        if report["daemon"]["action"] == "refused":
            report["error"] = report["daemon"]["detail"]
            return report
    if layout.adopted is not None:
        report["adopted"] = _adopted_report(layout)
    report["ok"] = True
    return report


def _socket_backend(layout: Layout, socket_path: str, *, runner: Optional[Runner]) -> Optional[str]:
    """The BackendState a daemon's socket reports, or None when it does not answer."""
    # A logged-out daemon can exit non-zero and still print its document.
    _rc, out, _err = _run(
        (str(layout.tailscale), f"--socket={socket_path}", "status", "--json"),
        runner=runner,
        timeout_s=8.0,
    )
    try:
        document = json.loads(out) if out.strip() else None
    except ValueError:
        return None
    backend = document.get("BackendState") if isinstance(document, dict) else None
    return backend if isinstance(backend, str) and backend else None


def find_adoptable(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    """Look at every foreign tailscaled and say whether install may adopt one.

    Read-only: one `pgrep`, at most one `status --json`. Returns
    ``{"adopt": (argv, verdict), "adoptable": …}`` when install should adopt,
    ``{"error": …}`` when there would be two tailnet identities, and otherwise
    only what it saw (``foreignNotAdoptable`` reasons), so today's refusal
    still runs with the reason attached.
    """
    foreign = [
        (pid, argv)
        for pid, argv, _line in _process_lines(runner)
        if _is_foreign_tailscaled(layout, argv)
    ]
    if not foreign:
        return {}
    found: Dict[str, Any] = {}
    candidates = []
    rejected = []
    for pid, argv in foreign:
        verdict = adoptable_daemon(argv, layout.home, platform_tailscaled=layout.platform_tailscaled)
        if verdict["adoptable"]:
            candidates.append((pid, argv, verdict))
        else:
            rejected.append({"pid": pid, "reason": verdict["reason"]})
    if rejected:
        found["foreignNotAdoptable"] = rejected
    if len(candidates) != 1 or len(foreign) != 1:
        # Two daemons at once is never ours to sort out.
        return found
    pid, argv, verdict = candidates[0]
    info: Dict[str, Any] = {
        "pid": pid,
        "stateFlag": verdict["stateFlag"],
        "socket": verdict["socket"],
        "socks5": verdict["socks5"],
    }
    found["adoptable"] = info
    own_pids = [own_pid for own_pid, _argv in _our_daemon_processes(layout, runner)]
    own_state = layout.state_dir / "tailscaled.state"
    if own_pids or own_state.exists():
        # Both are real nodes on someone's tailnet. Which one stays is the
        # user's call; we change nothing.
        info["ownIdentity"] = {"stateDir": str(layout.state_dir), "pids": own_pids}
        found["error"] = (
            "two tailnet identities on this server: Cloudways' own Tailscale "
            f"({verdict['stateFlag']}, socket {verdict['socket']}) and OcuClaw's own in "
            f"{layout.state_dir}. Nothing was changed. Decide which one to keep, "
            "remove the other yourself, then run install again."
        )
        return found
    if layout.binary_source != BINARIES_PLATFORM:
        return found
    backend = _socket_backend(layout, verdict["socket"], runner=runner)
    info["answered"] = backend is not None
    if backend is None:
        # A daemon we cannot talk to is not one we can keep alive.
        return found
    info["backend"] = backend
    found["adopt"] = (list(argv), verdict)
    return found


def _adopted_report(layout: Layout) -> Dict[str, Any]:
    adopted = layout.adopted
    socks5 = adopted.socks5 if adopted is not None else None
    return {
        **(adopted.summary() if adopted is not None else {}),
        "socks5": socks5,
        "dial": None if socks5 is not None else receipts.DIAL_TAILSCALE_NC,
    }


def _install_adopted(
    layout: Layout, found: Mapping[str, Any], report: Dict[str, Any], *, runner: Optional[Runner]
) -> Dict[str, Any]:
    """Adopt the one signed-in Cloudways daemon. Starts, stops and kills nothing."""
    argv, verdict = found["adopt"]
    report["adoption"] = str(
        write_adoption(build_adoption_body(argv, verdict, log_path=adoption_log_path(layout)))
    )
    # Every later step reads through the record, so check it reads back.
    adopted_layout = replace(layout, adoption=_READ_RECORD).pinned()
    if adopted_layout.adopted is None:
        remove_adoption()
        report["error"] = "the adoption record did not read back; nothing else was changed"
        return report
    report["layout"] = layout_summary(adopted_layout)
    report.update(install_binaries(adopted_layout, runner=runner))
    if report.get("error"):
        remove_adoption()
        return report
    report["receipt"] = str(write_receipt(adopted_layout))
    # Never two supervisors, the same as a fresh install.
    retired = retire_watchdog(adopted_layout, runner=runner)
    report["watchdogRetired"] = retired["removed"]
    if not retired["ok"]:
        report["error"] = f"old watchdog: {retired.get('error')}"
        return report
    report["state"] = str(write_hermes_state(adopted_layout, enabled=True))
    report["legacy"] = legacy_inventory(adopted_layout, runner=runner)
    report["adopted"] = {
        "socket": verdict["socket"],
        "stateFlag": verdict["stateFlag"],
        "backend": found["adoptable"].get("backend"),
        "socks5": verdict["socks5"],
        "dial": None if verdict["socks5"] is not None else receipts.DIAL_TAILSCALE_NC,
    }
    report["ok"] = True
    return report


# -- enroll / retry -----------------------------------------------------------

ENROLLMENT_STARTED = "enrollment-started\n"
STALE_ENROLLMENT_NOTICE = (
    "The last approval link stopped working when the container restarted. Starting a fresh one."
)


def _daemon_identity(layout: Layout) -> str:
    """Names this tailscaled instance: its socket's inode and creation mtime.

    tailscaled recreates the socket on every start, so a container restart
    (or any daemon restart) changes this even when the pid is reused.
    """
    try:
        info = layout.socket_path.stat()
    except OSError:
        return "none"
    return f"{info.st_ino} {info.st_mtime_ns}"


def _record_enrollment_daemon(layout: Layout) -> None:
    try:
        layout.enrollment_daemon.write_text(_daemon_identity(layout) + "\n")
    except OSError:
        pass


def _clear_enrollment(layout: Layout) -> None:
    layout.needs_auth_marker.unlink(missing_ok=True)
    layout.enrollment_daemon.unlink(missing_ok=True)


def enrollment_up_running(layout: Layout, *, proc_root: Path = Path("/proc")) -> bool:
    """True while a `tailscale up` against our socket is alive (any caller)."""
    tailscale = str(layout.tailscale)
    socket_arg = f"--socket={layout.socket_path}"
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return False
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            argv = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        words = [part.decode("utf-8", "replace") for part in argv if part]
        if words and words[0] == tailscale and socket_arg in words and "up" in words:
            return True
    return False


def _enrollment_is_stale(
    layout: Layout, before: "DaemonState", up_running: Callable[[Layout], bool]
) -> bool:
    """An "enrollment-started" marker whose login can no longer produce a link.

    After a container restart tailscaled comes back as NeedsLogin with no
    AuthURL: the login the marker points at died with the old daemon, so
    waiting on it never ends. A live `up`, a pending AuthURL, or the same
    daemon that the enrollment started against all mean the login may still
    be in flight, and a second `up` would only replace it.
    """
    if before.backend != "NeedsLogin" or before.auth_url:
        return False
    if up_running(layout):
        return False
    try:
        recorded = layout.enrollment_daemon.read_text().strip()
    except OSError:
        return True  # written before daemon identities were recorded
    return recorded != _daemon_identity(layout)


def enroll(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    hostname: Optional[str] = None,
    timeout_s: float = 25.0,
    wait_s: float = 90.0,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    progress: Optional[Callable[[str], None]] = None,
    up_running: Optional[Callable[[Layout], bool]] = None,
) -> Dict[str, Any]:
    """`tailscale up`, bounded; returns the authorization URL when one is needed.

    The total 90-second budget includes the command and daemon observations.
    The existing auth-needed marker also records an in-flight enrollment so
    interrupted observations can resume without another login. The OcuClaw
    runtime and `start_daemon` clear that marker once authorized; nothing here
    waits for a human.
    A marker left by a daemon that has since restarted is stale: it is
    cleared and a fresh login starts (``staleEnrollmentCleared`` + ``notice``).
    """
    # An adopted daemon enrolls through its own socket, like ours (#6482).
    layout = layout.pinned()
    deadline = clock() + max(1.0, min(float(wait_s), 90.0))
    before = daemon_state(layout, runner=runner, timeout_s=min(8.0, max(0.1, deadline - clock())))
    if before.state in (STATE_ABSENT, STATE_STOPPED, STATE_UNKNOWN):
        return {
            "ok": False,
            "state": before.state,
            "error": before.detail or "tailscaled is not running; run install (it starts the daemon)",
        }
    if before.state == STATE_RUNNING:
        return {"ok": True, "state": STATE_RUNNING, "nodeName": before.node_name, "dnsName": before.dns_name}
    # `up` prints the URL and then blocks until a human authorizes. `--timeout`
    # makes tailscale give up on its own (non-zero exit, URL already printed)
    # a little before our own kill deadline, so the output comes back intact.
    up_wait_s = max(5, int(timeout_s) - 5)
    argv: List[str] = list(layout.cli_argv()) + ["up", f"--timeout={up_wait_s}s"]
    if hostname:
        argv.append(f"--hostname={hostname}")
    elif before.backend == "NeedsLogin" and not before.dns_name:
        # A fresh identity has no tailnet DNS name yet. (HostName is NOT the
        # test: tailscaled reports the machine hostname before any login, so
        # the first live run enrolled as the bare container hostname.)
        argv.append(f"--hostname={default_node_name()}")
    out, err = "", ""
    command_failed = False
    try:
        enrollment_started = layout.needs_auth_marker.read_text() == ENROLLMENT_STARTED
    except OSError:
        enrollment_started = False
    stale_cleared = False
    if enrollment_started and _enrollment_is_stale(layout, before, up_running or enrollment_up_running):
        # Real box 2026-09-23: a container restart mid-approval left this
        # marker behind and every retry waited on a login that no longer exists.
        _clear_enrollment(layout)
        enrollment_started = False
        stale_cleared = True
        if progress:
            progress(STALE_ENROLLMENT_NOTICE)
    if not before.auth_url and not enrollment_started:
        # Persist before invoking up: interruption must not start another login.
        layout.needs_auth_marker.parent.mkdir(parents=True, exist_ok=True)
        layout.needs_auth_marker.write_text(ENROLLMENT_STARTED)
        _record_enrollment_daemon(layout)
        if progress:
            progress("Starting Tailscale registration; waiting up to 90 seconds for its authorization link.")
        try:
            code, out, err = _run(
                argv, runner=runner, timeout_s=min(timeout_s, max(0.1, deadline - clock())),
                raise_spawn_error=True,
            )
        except (OSError, ValueError):
            _clear_enrollment(layout)
            return {"ok": False, "state": before.state, "pending": False, "commandFailed": True,
                    "error": "Tailscale registration command could not start; check cloudways status, then retry."}
        # Tailscale's own --timeout also exits nonzero. An uncertain timeout or
        # cancellation must retain the original enrollment, unlike a rejection.
        command_failed = code not in (None, 0) and not any(
            reason in err.lower() for reason in ("deadline", "timeout", "timed out", "cancel")
        )
    combined = f"{out}\n{err}"
    match = _AUTH_URL_RE.search(combined)
    after = before
    while not match and not after.auth_url and after.state != STATE_RUNNING:
        remaining = deadline - clock()
        if remaining <= 0:
            break
        if progress:
            progress("Registration pending; checking the existing enrollment. No new login is being created.")
        after = daemon_state(layout, runner=runner, timeout_s=min(8.0, remaining))
        if after.state in (STATE_ABSENT, STATE_STOPPED, STATE_UNKNOWN):
            break
        if after.auth_url or after.state == STATE_RUNNING:
            break
        sleep(min(5.0, max(0.0, deadline - clock())))
    # Second witness: once `up` has started a login, tailscaled itself reports
    # the URL in `status --json` (AuthURL). Live on Cloudways this was the only
    # place it survived.
    auth_url = match.group(0) if match else (after.auth_url if after.state == STATE_NEEDS_AUTH else None)
    result: Dict[str, Any] = {
        "ok": after.state == STATE_RUNNING or auth_url is not None,
        "state": after.state,
        "authUrl": auth_url,
        "nodeName": after.node_name,
        "dnsName": after.dns_name,
    }
    if stale_cleared:
        # Callers without a progress sink (the setup ladder) print this line.
        result["staleEnrollmentCleared"] = True
        result["notice"] = STALE_ENROLLMENT_NOTICE
    if not result["ok"]:
        result["pending"] = after.state == STATE_NEEDS_AUTH and not command_failed
        if command_failed:
            # We still observed the daemon for the full budget before declaring
            # rejection. A corrected command may now be retried on this identity.
            _clear_enrollment(layout)
            result["commandFailed"] = True
        result["error"] = (
            "Tailscale registration command failed and no authorization link appeared; check cloudways status, then retry."
            if command_failed else
            "Registration is still pending after the bounded wait; run hermes ocuclaw cloudways retry to observe the same enrollment."
            if result["pending"] else "Tailscale daemon is unavailable; run hermes ocuclaw cloudways status before retrying."
        )
    if auth_url:
        layout.needs_auth_marker.parent.mkdir(parents=True, exist_ok=True)
        layout.needs_auth_marker.touch()
    return result


def default_node_name() -> str:
    try:
        raw = socket.gethostname().split(".")[0]
    except OSError:
        raw = "host"
    cleaned = re.sub(r"[^a-z0-9-]+", "-", raw.lower()).strip("-") or "host"
    return f"ocuclaw-{cleaned}"[:63]


# -- status -------------------------------------------------------------------


def _relay_port() -> int:
    """The loopback relay port the Serve route must forward to (bundle default)."""
    from .control_link import HERMES_BUNDLE_DEFAULT_WS_PORT

    return int(HERMES_BUNDLE_DEFAULT_WS_PORT)


def layout_summary(layout: Layout) -> Dict[str, str]:
    return {
        "binDir": str(layout.bin_dir),
        "binarySource": layout.binary_source,
        "tailscaled": str(layout.tailscaled),
        "stateDir": str(layout.state_dir),
        "socket": str(layout.socket_path),
        "state": str(layout.state_path or ""),
        "receipt": str(receipts.tailscale_cli_path() or ""),
        "socks5": layout.socks5_listen or "",
    }


def daemon_summary(*, runner: Optional[Runner] = None) -> Optional[Dict[str, Any]]:
    """The `tailscale-daemon` check for status, doctor and the setup journey.

    None unless the tailscale-cli receipt exists: on a host that runs the
    system tailscaled there is no user-owned daemon to report on, and the
    absence of the line is the signal. Bounded (one `status --json`, 8s).
    """
    if receipts.read_tailscale_cli() is None:
        return None
    layout = Layout.resolve().pinned()
    state = daemon_state(layout, runner=runner)
    summary = {
        "state": state.state,
        "detail": state.detail,
        "nodeName": state.node_name,
        "dnsName": state.dns_name,
        "online": state.online,
        "needsAuthorizationMarker": layout.needs_auth_marker.exists(),
        # Same distinction `status` draws: a marker on a RUNNING node is stale.
        "authorizationPending": layout.needs_auth_marker.exists()
        and state.state != STATE_RUNNING,
        "supervisor": supervisor_summary(layout),
        # Expected False since #6359: a leftover job is what install retires.
        "watchdogJobPresent": find_watchdog_job(layout) is not None,
    }
    if layout.adopted is not None:
        # Only when present, so readers of the old shape see the old shape.
        summary["adopted"] = layout.adopted.summary()
    return summary


def status(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    wait_s: float = 0.0,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Dict[str, Any]:
    """Daemon, route, supervisor, receipt, legacy — with an optional bounded wait.

    ``--wait N`` returns as soon as the daemon is running or needs
    authorization, otherwise after N seconds. The agent calls it repeatedly;
    each call stays well inside its terminal tool's timeout.
    """
    layout = layout.pinned()
    deadline = clock() + max(0.0, float(wait_s))
    while True:
        daemon = daemon_state(layout, runner=runner)
        if daemon.state in (STATE_RUNNING, STATE_NEEDS_AUTH, STATE_ABSENT) or clock() >= deadline:
            break
        sleep(min(2.0, max(0.1, deadline - clock())))
    receipt = receipts.read_tailscale_cli()
    job = find_watchdog_job(layout)
    route: Dict[str, Any] = {"classification": serve.CLASSIFY_UNKNOWN}
    if daemon.state == STATE_RUNNING and receipt is not None:
        try:
            observed = serve.observe(relay_port=_relay_port())
            route = {
                "classification": observed.classification,
                "reason": observed.reason,
                "readCode": observed.read_code,
                "dnsName": observed.dns_name,
            }
        except Exception as exc:  # noqa: BLE001 - status never raises
            route = {"classification": serve.CLASSIFY_UNKNOWN, "error": str(exc)[:200]}
    report = {
        "detect": detect().as_dict(),
        "daemon": daemon.as_dict(),
        "needsAuthorizationMarker": layout.needs_auth_marker.exists(),
        # A marker left on a RUNNING node is stale, not a problem: only a
        # daemon start clears it, and status is read-only. Advice must key off
        # this, never off the bare marker, or an authorized node is told to retry.
        "authorizationPending": layout.needs_auth_marker.exists()
        and daemon.state != STATE_RUNNING,
        "binaries": {
            "present": _binaries_present(layout),
            "path": str(layout.tailscaled),
            "source": layout.binary_source,
            # An old-ladder box still on the `~/bin` download: `install` moves it.
            "movePending": bundled_binary_in_use(layout),
        },
        "receipt": None
        if receipt is None
        else {
            "argv": list(receipt.argv),
            "socks5": receipt.socks5,
            "provisioner": receipt.provisioner,
            **({"dial": receipt.dial} if receipt.dial else {}),
        },
        "supervisor": supervisor_summary(layout),
        # The pre-#6359 cron supervisor, reported only so `install` can retire it.
        "job": None
        if job is None
        else {
            "id": job.get("id"),
            "name": job.get("name"),
            "schedule": job_schedule_text(job),
            "enabled": job.get("enabled", True),
        },
        "route": route,
        "legacy": legacy_inventory(layout, runner=runner),
        "layout": layout_summary(layout),
    }
    if layout.adopted is not None:
        # Cloudways' own daemon, kept, never restarted by us (#6482).
        report["adopted"] = layout.adopted.summary()
    return report


# -- enable / disable / rollback ---------------------------------------------


def stop_daemon(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    kill: Optional[Callable[[int, int], None]] = None,
    sleep: Optional[Callable[[float], None]] = None,
) -> Dict[str, Any]:
    """Ask the daemon behind OUR socket to exit; never signal by name.

    An adopted daemon (#6482) is Cloudways' and the user's: it is never
    signalled, whatever verb asked.
    """
    if layout.adopted is not None:
        return {"daemon": "left-running", "reason": "adopted"}
    if daemon_state(layout, runner=runner).state in (STATE_ABSENT, STATE_STOPPED):
        return {"daemon": "already-stopped"}
    kill = os.kill if kill is None else kill
    sleep = time.sleep if sleep is None else sleep
    rc, out, err = _run(("pgrep", "-f", "--", f"--statedir={layout.state_dir}"), runner=runner, timeout_s=5.0)
    pids = [int(p) for p in out.split() if p.strip().isdigit()] if rc == 0 else []
    for pid in pids:
        try:
            kill(pid, signal.SIGTERM)
        except OSError:
            pass
    for _ in range(20):
        if daemon_state(layout, runner=runner).state in (STATE_STOPPED, STATE_ABSENT):
            return {"daemon": "stopped", "pids": pids}
        sleep(0.25)
    return {"daemon": "still-running", "pids": pids}


def enable(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    kill: Optional[Callable[[int, int], None]] = None,
    sleep: Optional[Callable[[float], None]] = None,
    spawn: Optional[Spawner] = None,
) -> Dict[str, Any]:
    """Turn runtime supervision back on and start the daemon now."""
    layout = layout.pinned()
    replace_logged_out_platform_daemons(layout, runner=runner, kill=kill, sleep=sleep)
    inventory = legacy_inventory(layout, runner=runner)
    refusal = refuse_if_foreign_supervisor(inventory)
    if refusal:
        return {"ok": False, "error": refusal, "legacy": inventory}
    if not _receipt_is_ours():
        return {"ok": False, "error": "this plugin has not installed Tailscale here; run install"}
    retired = retire_watchdog(layout, runner=runner)
    if not retired["ok"]:
        return {"ok": False, "error": f"old watchdog: {retired.get('error')}"}
    write_hermes_state(layout, enabled=True)
    started = start_daemon(layout, runner=runner, spawn=spawn, sleep=sleep)
    return {
        "ok": started["action"] in ("started", "kept", "starting"),
        "enabled": True,
        "daemon": started,
        "watchdogRetired": retired["removed"],
    }


def disable(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    kill: Optional[Callable[[int, int], None]] = None,
    sleep: Optional[Callable[[float], None]] = None,
) -> Dict[str, Any]:
    """Turn runtime supervision off, then stop the daemon.

    The state goes first, or the runtime's next check would start it again.
    An adopted daemon only loses its keepalive; it keeps running.
    """
    layout = layout.pinned()
    retired = retire_watchdog(layout, runner=runner)
    if not retired["ok"]:
        return {"ok": False, "error": f"old watchdog: {retired.get('error')}"}
    enabled_written = False
    if _receipt_is_ours() or read_hermes_state(layout) is not None:
        write_hermes_state(layout, enabled=False)
        enabled_written = True
    stopped = stop_daemon(layout, runner=runner, kill=kill, sleep=sleep)
    return {
        "ok": stopped.get("daemon") != "still-running",
        "enabled": False if enabled_written else None,
        "watchdogRetired": retired["removed"],
        **stopped,
    }


def _raw_receipt_provisioner(path: Optional[Path]) -> Optional[str]:
    """Who wrote a receipt :func:`receipts.read_tailscale_cli` would not return.

    That reader fails soft on anything it cannot fully trust — a future
    ``schemaVersion``, an argv that no longer parses — and a receipt this
    plugin wrote is still ours to delete when it ages out that way. Only the
    one field is read, and only to answer "is this ours".
    """
    if path is None:
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    value = record.get("provisioner")
    return value if isinstance(value, str) and value.strip() else None


def _same_file(candidate: str, target: Path) -> bool:
    """Path equality through symlinks — a home can be one (`/home` → `/data/home`)."""
    try:
        return os.path.realpath(candidate) == os.path.realpath(target)
    except (OSError, ValueError):  # pragma: no cover - defensive
        return False


def rollback(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    purge_identity: bool = False,
    kill: Optional[Callable[[int, int], None]] = None,
    sleep: Optional[Callable[[float], None]] = None,
) -> Dict[str, Any]:
    """Undo install. Identity (`~/.tailscale` state) survives unless asked.

    The tailscale-CLI receipt is host-scoped: one per box, shared with the
    OpenClaw bundle, which reads it the same way we do. Remove it only when
    this plugin provisioned it (the OpenClaw twin makes the same check in
    `extensions/ocuclaw/src/setup/cloudways.ts`). A receipt somebody else
    wrote still describes a live install, so it survives — and so do the
    binaries it names, which on this layout are the same `~/bin` pair we
    would otherwise delete out from under that install. Only that `~/bin` pair
    is ever a target: the platform's /usr/bin pair is the image's, not ours.
    """
    # Read once: the record goes below, and the daemon it names must still be
    # the one this rollback leaves alone (#6482).
    layout = layout.pinned()
    adopted = layout.adopted
    report: Dict[str, Any] = {"ok": False}
    removed: List[str] = []
    # Supervision ends before the daemon stops, or it would be started again.
    state_path = layout.state_path
    if remove_hermes_state(layout):
        removed.append(str(state_path))
    had_job = find_watchdog_job(layout) is not None
    retired = retire_watchdog(layout, runner=runner)
    removed += [entry for entry in retired["removed"] if not entry.startswith("cron:")]
    if had_job:
        report["jobRemoved"] = retired["ok"]
    if not retired["ok"]:
        report.setdefault("errors", []).append(retired.get("error"))
    running = daemon_state(layout, runner=runner).state == STATE_RUNNING
    if running:
        # Port-scoped `off`, never `serve reset` (the codebase's one removal form).
        rc, out, err = _run(
            layout.cli_argv() + ("serve", f"--tls-terminated-tcp={serve.serve_port()}", "off"),
            runner=runner,
            timeout_s=15.0,
        )
        report["serveRouteRemoved"] = rc == 0
    report.update(stop_daemon(layout, runner=runner, kill=kill, sleep=sleep))
    receipt_path = receipts.tailscale_cli_path()
    receipt = receipts.read_tailscale_cli()
    # `read_tailscale_cli` fails soft (None for missing OR unreadable). A file
    # it refused may still name its writer, so ask the raw JSON before
    # concluding it is not ours; anything genuinely unreadable stays.
    receipt_on_disk = receipt_path is not None and receipt_path.exists()
    provisioner = (
        receipt.provisioner if receipt is not None else _raw_receipt_provisioner(receipt_path)
    )
    keep_receipt = receipt_on_disk and provisioner != RECEIPT_PROVISIONER
    keep_binaries = keep_receipt and (
        receipt is None
        or _same_file(receipt.argv[0], layout.tailscale)
        or _same_file(receipt.argv[0], layout.bundled_tailscale)
    )
    targets: List[Path] = []
    if not keep_binaries:
        # The install receipt records where these binaries came from; it stays
        # with them.
        targets += [layout.bundled_tailscale, layout.bundled_tailscaled, layout.tgz_receipt]
    # A successful port-scoped teardown ends the route ownership claim too.
    # Keep the claim when teardown failed or the daemon could not be reached.
    route_receipt = receipts.managed_serve_route_path()
    if report.get("serveRouteRemoved") and route_receipt is not None:
        targets.append(route_receipt)
    for path in targets:
        try:
            path.unlink()
            removed.append(str(path))
        except FileNotFoundError:
            pass
        except OSError as exc:
            report.setdefault("errors", []).append(f"{path}: {exc}")
    if keep_receipt:
        report["receiptKept"] = provisioner or "unknown"
        if keep_binaries:
            report["binariesKept"] = True
    elif receipts.remove_tailscale_cli():
        removed.append(str(receipt_path))
    # The ladder's restart-pending marker (#3149) has no keep rule to weigh: it
    # is profile-scoped, only `cloudways_settings` ever writes it, and it stands
    # for a setting change this plugin made. Undoing the install leaves nothing
    # for it to describe.
    pending_marker = receipts.restart_pending_path(layout.hermes_home)
    if receipts.remove_restart_pending(home=layout.hermes_home):
        removed.append(str(pending_marker))
    if adopted is not None:
        # The daemon, its state and its log are Cloudways' and stay. What goes
        # is ours: the record (when we wrote it) and our markers.
        report["daemonKept"] = adopted.summary()
        if adopted.adopted_by == RECEIPT_PROVISIONER:
            record_path = adoption_path()
            if remove_adoption():
                removed.append(str(record_path))
        else:
            # The other bundle adopted it and still relies on the record.
            report["adoptionKept"] = adopted.adopted_by
        for marker in (layout.needs_auth_marker, layout.enrollment_daemon):
            try:
                marker.unlink()
                removed.append(str(marker))
            except FileNotFoundError:
                pass
            except OSError as exc:
                report.setdefault("errors", []).append(f"{marker}: {exc}")
    # `~/.tailscale` holds the node key, and it is as shared as the receipt:
    # purging it while somebody else's receipt stands would de-authorize their
    # node. The identity outlives the purge in that case, and the report says so.
    if purge_identity and keep_receipt:
        report["identityPurgeSkipped"] = True
    elif purge_identity:
        shutil.rmtree(layout.state_dir, ignore_errors=True)
        removed.append(str(layout.state_dir))
    report["removed"] = removed
    report["identityKept"] = not purge_identity or keep_receipt
    report["ok"] = "errors" not in report
    return report


__all__ = [
    "ADOPTION_FILENAME",
    "Adoption",
    "adoptable_daemon",
    "adoption_path",
    "build_adoption_body",
    "find_adoptable",
    "read_adoption",
    "receipt_body",
    "remove_adoption",
    "write_adoption",
    "BINARIES_BUNDLED",
    "BINARIES_PLATFORM",
    "DETECT_CLOUDWAYS",
    "DETECT_LIKELY",
    "DETECT_NO",
    "Layout",
    "PLATFORM_BIN_DIR",
    "PLATFORM_SOCKET",
    "PLATFORM_STATE_DIR",
    "SOCKS5_LISTEN",
    "STALE_ENROLLMENT_NOTICE",
    "STATE_ABSENT",
    "STATE_NEEDS_AUTH",
    "STATE_RUNNING",
    "STATE_STARTING",
    "STATE_STOPPED",
    "STATE_UNKNOWN",
    "TAILSCALE_MISSING_MESSAGE",
    "HERMES_STATE_FILENAME",
    "SUPERVISOR_RUNTIME",
    "WATCHDOG_JOB_NAME",
    "WATCHDOG_SCRIPT_NAME",
    "adopt_runtime_supervisor",
    "bundled_binary_in_use",
    "daemon_state",
    "detect",
    "disable",
    "enable",
    "enroll",
    "enrollment_up_running",
    "install",
    "install_binaries",
    "legacy_inventory",
    "move_to_platform_binary",
    "platform_daemon_socket",
    "replace_logged_out_platform_daemons",
    "rollback",
    "daemon_summary",
    "read_hermes_state",
    "retire_watchdog",
    "start_daemon",
    "status",
    "stop_daemon",
    "write_hermes_state",
    "write_receipt",
]
