"""The Cloudways managed-Hermes path: userspace Tailscale kept alive by cron (#2981, #2982).

Cloudways "Managed AI Agents" runs Hermes as a non-root user in a container
with no systemd, no cron binary, no TUN device, and a gateway that is PID 1's
child — `hermes gateway restart` restarts the whole container. Cloudways has
approved two things for OcuClaw there: a **userspace-networking tailscaled**
owned by the user (`~/bin`, `~/.tailscale`), and **Hermes cron** as the
supervisor that brings it back after a restart. This module is that path,
as deterministic idempotent verbs the on-box Hermes agent runs from its
terminal tool:

    hermes ocuclaw cloudways detect     which environment signals fired
    hermes ocuclaw cloudways install    binaries (pinned + checksummed), state dirs,
                                        host receipt, watchdog script, cron job
    hermes ocuclaw cloudways enroll     `tailscale up`, print the authorization URL
    hermes ocuclaw cloudways status     daemon / route / job / legacy, optional --wait
    hermes ocuclaw cloudways retry      a fresh authorization URL
    hermes ocuclaw cloudways enable     resume the job, fire it now
    hermes ocuclaw cloudways disable    pause the job, stop the daemon
    hermes ocuclaw cloudways rollback   remove job, daemon, script, and the binaries
                                        and host receipt this plugin provisioned

Design rulings this file implements (RULED.md in the arc's evidence dir):

* **Single launcher.** Only the cron watchdog ever starts tailscaled; `install`
  and `enable` ask Hermes to fire the job (`hermes cron run`), they never spawn
  the daemon themselves. One start path, one thing to get right.
* **The watchdog is pure bash and never runs `up`.** A daemon that answers is
  left alone; a missing one is started with `setsid -f` and every fd redirected
  (Hermes's `--no-agent` runner reads the script's pipes to EOF, so an inherited
  pipe hangs the run and then tree-kills the daemon). `NeedsLogin` is reported,
  never fixed: a human must open the URL.
* **Loopback SOCKS5.** In userspace mode the host has no route to its own
  tailnet name; the daemon exposes `127.0.0.1:1055` and the host receipt tells
  doctor's probes to dial through it (#2980).
* **Reuse, never duplicate.** Existing identity is adopted; existing binaries
  are adopted when they print the pinned version; the cron job is found by
  name and replaced only on drift; the 2026-09-15 disabled startup hook and the
  `~/.local/share/tailscale` supervisor are reported, never touched.
* **No exposure changes.** No Funnel, no ACL edits, no Tailscale SSH, no `up`
  flags beyond `--hostname` on a fresh identity.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from . import receipts, serve

# -- pins ---------------------------------------------------------------------

TAILSCALE_VERSION = "1.102.4"
TAILSCALE_TGZ_URL = (
    f"https://pkgs.tailscale.com/stable/tailscale_{TAILSCALE_VERSION}_amd64.tgz"
)
#: Verified against `pkgs.tailscale.com/...tgz.sha256` on 2026-09-16. The live
#: `.sha256` is fetched again at install as a second witness; both must agree.
TAILSCALE_TGZ_SHA256 = "50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9"
TAILSCALE_TGZ_MEMBER_DIR = f"tailscale_{TAILSCALE_VERSION}_amd64"

SOCKS5_LISTEN = "127.0.0.1:1055"
WATCHDOG_JOB_NAME = "ocuclaw-tailscale-watchdog"
WATCHDOG_SCRIPT_NAME = "ocuclaw-tailscale-watchdog.sh"
WATCHDOG_SCHEDULE = "* * * * *"
WATCHDOG_LOG_MAX_BYTES = 1_048_576
RECEIPT_PROVISIONER = "hermes ocuclaw cloudways"

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


@dataclass(frozen=True)
class Layout:
    """Every absolute path the verbs and the generated script agree on."""

    home: Path
    hermes_home: Path

    @property
    def bin_dir(self) -> Path:
        return self.home / "bin"

    @property
    def tailscale(self) -> Path:
        return self.bin_dir / "tailscale"

    @property
    def tailscaled(self) -> Path:
        return self.bin_dir / "tailscaled"

    @property
    def state_dir(self) -> Path:
        return self.home / ".tailscale"

    @property
    def run_dir(self) -> Path:
        return self.state_dir / "run"

    @property
    def socket_path(self) -> Path:
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
        return (
            str(self.tailscaled),
            f"--statedir={self.state_dir}",
            f"--socket={self.socket_path}",
            "--tun=userspace-networking",
            f"--socks5-server={SOCKS5_LISTEN}",
        )

    @classmethod
    def resolve(
        cls, *, home: Optional[Path] = None, hermes_home: Optional[Path] = None
    ) -> "Layout":
        resolved_home = Path(home) if home is not None else Path.home()
        if hermes_home is None:
            env_home = os.environ.get("HERMES_HOME", "").strip()
            hermes_home = Path(env_home) if env_home else resolved_home / ".hermes"
        return cls(home=resolved_home, hermes_home=Path(hermes_home))


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
    rc, out, _ = _run(("pgrep", "-af", "tailscaled|supervisor.py"), runner=runner, timeout_s=5.0)
    foreign: List[str] = []
    own_statedir = f"--statedir={layout.state_dir}"
    if rc == 0:
        for line in out.splitlines():
            parts = line.split()
            if len(parts) < 2 or not parts[0].isdigit() or int(parts[0]) == os.getpid():
                continue
            argv = parts[1:]
            executable = Path(argv[0]).name
            if executable == "tailscaled" and own_statedir not in argv:
                foreign.append(line.strip()[:200])
            elif "supervisor.py" in line and str(supervisor_dir) in line:
                foreign.append(line.strip()[:200])
    return {
        "legacySupervisorDir": str(supervisor_dir),
        "legacySupervisorPresent": (supervisor_dir / "supervisor.py").is_file(),
        "disabledTailscaleHooks": hooks,
        "foreignDaemonProcesses": foreign,
    }


# -- cron job -----------------------------------------------------------------


def _hermes_bin() -> str:
    found = shutil.which("hermes")
    if found:
        return found
    sibling = Path(sys.executable).parent / "hermes"
    return str(sibling) if sibling.exists() else "hermes"


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


def job_matches(job: Mapping[str, Any], layout: Layout) -> bool:
    script = str(job.get("script") or "")
    return (
        Path(script).name == WATCHDOG_SCRIPT_NAME
        and bool(job.get("no_agent"))
        and job_schedule_text(job) in (WATCHDOG_SCHEDULE, "every 1m")
    )


def _cron(layout: Layout, *args: str, runner: Optional[Runner] = None) -> Tuple[Optional[int], str, str]:
    env = dict(os.environ)
    env["HERMES_HOME"] = str(layout.hermes_home)
    return _run((_hermes_bin(), "cron", *args), runner=runner, timeout_s=40.0, env=env)


def ensure_watchdog_job(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    """Create the job once; replace it only when its spec drifted."""
    existing = find_watchdog_job(layout)
    if existing is not None and job_matches(existing, layout):
        return {"action": "kept", "jobId": existing.get("id"), "enabled": existing.get("enabled", True)}
    if existing is not None:
        rc, out, err = _cron(layout, "remove", str(existing.get("id")), runner=runner)
        if rc != 0:
            return {"action": "failed", "step": "remove-drifted", "error": (err or out).strip()[:300]}
    rc, out, err = _cron(
        layout,
        "create",
        WATCHDOG_SCHEDULE,
        "--name",
        WATCHDOG_JOB_NAME,
        # Hermes insists on a bare filename relative to ~/.hermes/scripts/;
        # an absolute path is refused at create time (observed 0.21.1).
        "--script",
        WATCHDOG_SCRIPT_NAME,
        "--no-agent",
        "--deliver",
        "local",
        runner=runner,
    )
    if rc != 0:
        return {"action": "failed", "step": "create", "error": (err or out).strip()[:300]}
    created = find_watchdog_job(layout)
    return {
        "action": "replaced" if existing is not None else "created",
        "jobId": created.get("id") if created else None,
        "enabled": True,
    }


#: `hermes cron run` ends a manual run with one verdict line
#: (hermes_cli/cron.py `_run_outcome`). It is the only place success is stated.
_CRON_RAN_NOW_RE = re.compile(r"Ran now:\s*(succeeded|failed)\.", re.IGNORECASE)


def fire_watchdog_now(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    job = find_watchdog_job(layout)
    if job is None:
        return {"fired": False, "error": "no watchdog job"}
    rc, out, err = _cron(layout, "run", str(job.get("id")), runner=runner)
    # The exit code says the RUN HAPPENED, not that it worked: `hermes cron run`
    # returns 0 for a job that executed and failed. Reading rc alone reported a
    # watchdog that ran and failed as fired, so parse the verdict instead.
    #
    # Three of `_run_outcome`'s four answers report no verdict at all —
    # "Running in background.", "Running in background (delegation …)." and
    # "It will run on the next scheduler tick." — so `unreported` is NEUTRAL,
    # never a failure. Only a reported failure is one; whether the daemon
    # actually came up is what `status` observes.
    match = _CRON_RAN_NOW_RE.search(f"{out}\n{err}")
    verdict = match.group(1).lower() if match else "unreported"
    return {
        "fired": rc == 0 and verdict != "failed",
        "verdict": verdict,
        "jobId": job.get("id"),
        "detail": (out or err).strip()[:200],
    }


# -- watchdog script ----------------------------------------------------------


def render_watchdog_script(layout: Layout) -> str:
    """The bash the cron job runs every minute. Generated; never hand-edited."""
    return f"""#!/usr/bin/env bash
# OcuClaw Tailscale watchdog — generated by `hermes ocuclaw cloudways install`.
# Do not edit: re-run install to regenerate. Runs from Hermes cron with
# --no-agent (no LLM). Keeps the user-owned userspace tailscaled alive and
# reports, on state change only, to the job's local delivery.
#
# Rules: the daemon is started only if its socket does not answer; it is
# detached with setsid and every fd redirected, because the cron runner reads
# this script's pipes to EOF and would otherwise hang and then kill the
# daemon; the lock fd (9) is closed for the daemon too, or the daemon would
# hold the watchdog lock for its whole life and every later tick would exit
# at flock without looking; `tailscale up` is never run here — authorization
# needs a human.
set -u
umask 077

TS_BIN={_sh(layout.tailscale)}
TSD_BIN={_sh(layout.tailscaled)}
STATE_DIR={_sh(layout.state_dir)}
RUN_DIR={_sh(layout.run_dir)}
SOCK={_sh(layout.socket_path)}
LOG_DIR={_sh(layout.log_dir)}
LOG="$LOG_DIR/tailscaled.log"
LOCK="$STATE_DIR/watchdog.lock"
STATE_FILE={_sh(layout.watchdog_state)}
NEEDS_AUTH={_sh(layout.needs_auth_marker)}
SOCKS5={_sh(SOCKS5_LISTEN)}
LOG_MAX={WATCHDOG_LOG_MAX_BYTES}

[ -x "$TS_BIN" ] && [ -x "$TSD_BIN" ] || {{ echo "ocuclaw tailscale watchdog: binaries missing under $(dirname "$TSD_BIN"); run: hermes ocuclaw cloudways install"; exit 0; }}
mkdir -p "$STATE_DIR" "$RUN_DIR" "$LOG_DIR" || exit 0
chmod 700 "$STATE_DIR" "$RUN_DIR" "$LOG_DIR" 2>/dev/null

# Duplicate prevention: one watchdog at a time, lock released by the kernel.
exec 9>"$LOCK" || exit 0
flock -n 9 || exit 0

backend_state() {{
  timeout 5 "$TS_BIN" --socket="$SOCK" status --json 2>/dev/null \\
    | grep -o '"BackendState": *"[A-Za-z]*"' | head -n1 | sed 's/.*"\\([A-Za-z]*\\)"$/\\1/'
}}

rotate_log() {{
  if [ -f "$LOG" ]; then
    size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
    if [ "$size" -gt "$LOG_MAX" ]; then mv -f "$LOG" "$LOG.1"; fi
  fi
}}

prev=$(cat "$STATE_FILE" 2>/dev/null || true)
started=0
report() {{  # report <state> <message>: print only on transition or after a start
  if [ "$1" != "$prev" ] || [ "$started" = 1 ]; then
    printf '%s\\n' "$1" > "$STATE_FILE"
    echo "ocuclaw tailscale watchdog: $2"
  fi
}}

state=$(backend_state)
if [ -z "$state" ]; then
  if pgrep -f -- "--statedir=$STATE_DIR" >/dev/null 2>&1; then
    report starting "tailscaled process exists but its socket is not answering yet"
    exit 0
  fi
  rotate_log
  setsid -f "$TSD_BIN" --statedir="$STATE_DIR" --socket="$SOCK" --tun=userspace-networking --socks5-server="$SOCKS5" </dev/null >>"$LOG" 2>&1 9>&-
  started=1
  # Wait for a settled state (up to 20s): a fresh daemon answers NoState for
  # a few seconds before it reaches Running or NeedsLogin.
  for _ in $(seq 1 40); do
    sleep 0.5
    state=$(backend_state)
    case "$state" in Running|NeedsLogin|NeedsMachineAuth|Stopped) break ;; esac
  done
  if [ -z "$state" ]; then
    report start-failed "tailscaled did not answer within 20s after start; see $LOG"
    exit 0
  fi
  chmod 600 "$SOCK" 2>/dev/null
fi

case "$state" in
  Running)
    rm -f "$NEEDS_AUTH"
    if [ "$started" = 1 ]; then report running "started tailscaled; node is running"; else report running "tailscaled running"; fi
    ;;
  NeedsLogin|NeedsMachineAuth|Stopped)
    # Enrollment recovery owns any existing contents; never truncate them.
    touch "$NEEDS_AUTH"
    report needs-authorization "tailscaled is up but the node needs authorization ($state): run hermes ocuclaw cloudways retry"
    ;;
  *)
    if [ "$started" = 1 ]; then report starting "started tailscaled; still starting ($state)"; else report starting "tailscaled still starting ($state)"; fi
    ;;
esac
exit 0
"""


def _sh(value: Any) -> str:
    import shlex

    return shlex.quote(str(value))


# -- install ------------------------------------------------------------------


Fetcher = Callable[[str, float], bytes]


def _default_fetch(url: str, timeout_s: float) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout_s) as response:  # nosec B310 - https pin
        return response.read()


def _installed_version(layout: Layout, *, runner: Optional[Runner]) -> Optional[str]:
    if not _binaries_present(layout):
        return None
    rc, out, _ = _run((str(layout.tailscale), "version"), runner=runner, timeout_s=8.0)
    if rc != 0:
        return None
    first = out.strip().splitlines()[0].strip() if out.strip() else ""
    return first or None


def _safe_extract_binaries(archive: Path, layout: Layout) -> None:
    wanted = {
        f"{TAILSCALE_TGZ_MEMBER_DIR}/tailscale": layout.tailscale,
        f"{TAILSCALE_TGZ_MEMBER_DIR}/tailscaled": layout.tailscaled,
    }
    layout.bin_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(layout.bin_dir, 0o700)
    with tarfile.open(archive, "r:gz") as tar:
        found = 0
        for member in tar.getmembers():
            target = wanted.get(member.name)
            if target is None or not member.isfile():
                continue
            source = tar.extractfile(member)
            if source is None:
                continue
            tmp = target.with_suffix(".tmp")
            with tmp.open("wb") as sink:
                shutil.copyfileobj(source, sink)
            os.chmod(tmp, 0o700)
            os.replace(tmp, target)
            found += 1
    if found != 2:
        raise RuntimeError("archive did not contain both tailscale and tailscaled")


def install_binaries(
    layout: Layout,
    *,
    fetch: Optional[Fetcher] = None,
    runner: Optional[Runner] = None,
    force_download: bool = False,
) -> Dict[str, Any]:
    """Pinned, double-checksummed, idempotent."""
    fetch = _default_fetch if fetch is None else fetch
    version = _installed_version(layout, runner=runner)
    if version == TAILSCALE_VERSION and not force_download:
        return {"binaries": "adopted", "version": version}
    payload = fetch(TAILSCALE_TGZ_URL, 120.0)
    digest = hashlib.sha256(payload).hexdigest()
    if digest != TAILSCALE_TGZ_SHA256:
        raise RuntimeError(
            f"tailscale archive sha256 {digest} does not match the pinned {TAILSCALE_TGZ_SHA256}"
        )
    live = fetch(TAILSCALE_TGZ_URL + ".sha256", 30.0).decode("utf-8", "replace").split()
    if not live or live[0].lower() != TAILSCALE_TGZ_SHA256:
        raise RuntimeError("the published .sha256 for the pinned archive does not match the pin")
    layout.state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(layout.state_dir, 0o700)
    with tempfile.NamedTemporaryFile(dir=layout.state_dir, suffix=".tgz", delete=False) as handle:
        handle.write(payload)
        archive = Path(handle.name)
    try:
        _safe_extract_binaries(archive, layout)
    finally:
        try:
            archive.unlink()
        except OSError:
            pass
    receipts.write_json_receipt(
        layout.tgz_receipt,
        {
            "schemaVersion": 1,
            "version": TAILSCALE_VERSION,
            "url": TAILSCALE_TGZ_URL,
            "sha256": TAILSCALE_TGZ_SHA256,
            "installedAt": receipts.now_iso(),
        },
    )
    return {
        "binaries": "downloaded" if version is None else "replaced",
        "previousVersion": version,
        "version": TAILSCALE_VERSION,
    }


def write_receipt(layout: Layout) -> Path:
    body = receipts.build_tailscale_cli_body(
        argv=layout.cli_argv(), socks5=SOCKS5_LISTEN, provisioner=RECEIPT_PROVISIONER
    )
    return receipts.write_tailscale_cli(body)


def write_watchdog_script(layout: Layout) -> Dict[str, Any]:
    content = render_watchdog_script(layout)
    layout.scripts_dir.mkdir(parents=True, exist_ok=True)
    before = layout.script_path.read_text(encoding="utf-8") if layout.script_path.exists() else None
    if before == content:
        os.chmod(layout.script_path, 0o700)
        return {"script": "kept", "path": str(layout.script_path)}
    tmp = layout.script_path.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.chmod(tmp, 0o700)
    os.replace(tmp, layout.script_path)
    return {"script": "written" if before is None else "updated", "path": str(layout.script_path)}


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


def install(
    layout: Layout,
    *,
    fetch: Optional[Fetcher] = None,
    runner: Optional[Runner] = None,
    force_download: bool = False,
    fire: bool = True,
) -> Dict[str, Any]:
    report: Dict[str, Any] = {"ok": False, "layout": layout_summary(layout)}
    inventory = legacy_inventory(layout, runner=runner)
    report["legacy"] = inventory
    refusal = refuse_if_foreign_supervisor(inventory)
    if refusal:
        report["error"] = refusal
        return report
    try:
        report.update(install_binaries(layout, fetch=fetch, runner=runner, force_download=force_download))
    except Exception as exc:  # noqa: BLE001 - reported, never raised at the agent
        report["error"] = f"binary install failed: {exc}"
        return report
    prepare_state_dirs(layout)
    report["receipt"] = str(write_receipt(layout))
    report.update(write_watchdog_script(layout))
    report["job"] = ensure_watchdog_job(layout, runner=runner)
    if report["job"].get("action") == "failed":
        report["error"] = f"cron job: {report['job'].get('error')}"
        return report
    if fire:
        report["fired"] = fire_watchdog_now(layout, runner=runner)
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
    qr: bool = False,
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
    interrupted observations can resume without another login. The watchdog
    clears that marker when authorized; nothing here waits for a human.
    A marker left by a daemon that has since restarted is stale: it is
    cleared and a fresh login starts (``staleEnrollmentCleared`` + ``notice``).
    """
    deadline = clock() + max(1.0, min(float(wait_s), 90.0))
    before = daemon_state(layout, runner=runner, timeout_s=min(8.0, max(0.1, deadline - clock())))
    if before.state in (STATE_ABSENT, STATE_STOPPED, STATE_UNKNOWN):
        return {
            "ok": False,
            "state": before.state,
            "error": before.detail or "tailscaled is not running; run install (the cron watchdog starts it)",
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
    if qr:
        argv.append("--qr")
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
    if qr and match:
        result["qr"] = out
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
        "stateDir": str(layout.state_dir),
        "socket": str(layout.socket_path),
        "script": str(layout.script_path),
        "receipt": str(receipts.tailscale_cli_path() or ""),
        "socks5": SOCKS5_LISTEN,
    }


def daemon_summary(*, runner: Optional[Runner] = None) -> Optional[Dict[str, Any]]:
    """The `tailscale-daemon` check for status, doctor and the setup journey.

    None unless the tailscale-cli receipt exists: on a host that runs the
    system tailscaled there is no user-owned daemon to report on, and the
    absence of the line is the signal. Bounded (one `status --json`, 8s).
    """
    if receipts.read_tailscale_cli() is None:
        return None
    layout = Layout.resolve()
    state = daemon_state(layout, runner=runner)
    return {
        "state": state.state,
        "detail": state.detail,
        "nodeName": state.node_name,
        "dnsName": state.dns_name,
        "online": state.online,
        "needsAuthorizationMarker": layout.needs_auth_marker.exists(),
        # Same distinction `status` draws: a marker on a RUNNING node is stale.
        "authorizationPending": layout.needs_auth_marker.exists()
        and state.state != STATE_RUNNING,
        "watchdogJobPresent": find_watchdog_job(layout) is not None,
    }


def status(
    layout: Layout,
    *,
    runner: Optional[Runner] = None,
    wait_s: float = 0.0,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Dict[str, Any]:
    """Daemon, route, job, receipt, legacy — with an optional bounded wait.

    ``--wait N`` returns as soon as the daemon is running or needs
    authorization, otherwise after N seconds. The agent calls it repeatedly;
    each call stays well inside its terminal tool's timeout.
    """
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
    return {
        "detect": detect().as_dict(),
        "daemon": daemon.as_dict(),
        "needsAuthorizationMarker": layout.needs_auth_marker.exists(),
        # A marker left on a RUNNING node is stale, not a problem: only the
        # watchdog clears it, and status is read-only. Advice must key off this,
        # never off the bare marker, or an authorized node is told to retry.
        "authorizationPending": layout.needs_auth_marker.exists()
        and daemon.state != STATE_RUNNING,
        "receipt": None
        if receipt is None
        else {"argv": list(receipt.argv), "socks5": receipt.socks5, "provisioner": receipt.provisioner},
        "script": {"path": str(layout.script_path), "present": layout.script_path.is_file()},
        "job": None
        if job is None
        else {
            "id": job.get("id"),
            "name": job.get("name"),
            "schedule": job_schedule_text(job),
            "enabled": job.get("enabled", True),
            "noAgent": bool(job.get("no_agent")),
            "matches": job_matches(job, layout),
            "lastRunAt": job.get("last_run_at") or job.get("last_run"),
        },
        "route": route,
        "legacy": legacy_inventory(layout, runner=runner),
        "layout": layout_summary(layout),
    }


# -- enable / disable / rollback ---------------------------------------------


def stop_daemon(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    """Ask the daemon behind OUR socket to exit; never signal by name."""
    if daemon_state(layout, runner=runner).state in (STATE_ABSENT, STATE_STOPPED):
        return {"daemon": "already-stopped"}
    rc, out, err = _run(("pgrep", "-f", "--", f"--statedir={layout.state_dir}"), runner=runner, timeout_s=5.0)
    pids = [int(p) for p in out.split() if p.strip().isdigit()] if rc == 0 else []
    for pid in pids:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
    for _ in range(20):
        if daemon_state(layout, runner=runner).state in (STATE_STOPPED, STATE_ABSENT):
            return {"daemon": "stopped", "pids": pids}
        time.sleep(0.25)
    return {"daemon": "still-running", "pids": pids}


def enable(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    inventory = legacy_inventory(layout, runner=runner)
    refusal = refuse_if_foreign_supervisor(inventory)
    if refusal:
        return {"ok": False, "error": refusal, "legacy": inventory}
    job = find_watchdog_job(layout)
    if job is None:
        return {"ok": False, "error": "no watchdog job; run install"}
    rc, out, err = _cron(layout, "resume", str(job.get("id")), runner=runner)
    fired = fire_watchdog_now(layout, runner=runner)
    # Resuming the job is what `enable` promises; the immediate fire is a nudge.
    # A run that reported no verdict (background dispatch, next scheduler tick)
    # must not fail the verb — only a reported failure does.
    return {
        "ok": rc == 0 and fired.get("verdict") != "failed",
        "resumed": rc == 0,
        "fired": fired,
    }


def disable(layout: Layout, *, runner: Optional[Runner] = None) -> Dict[str, Any]:
    job = find_watchdog_job(layout)
    paused = None
    if job is not None:
        rc, out, err = _cron(layout, "pause", str(job.get("id")), runner=runner)
        paused = rc == 0
    stopped = stop_daemon(layout, runner=runner)
    return {"ok": paused is not False and stopped.get("daemon") != "still-running", "paused": paused, **stopped}


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
    layout: Layout, *, runner: Optional[Runner] = None, purge_identity: bool = False
) -> Dict[str, Any]:
    """Undo install. Identity (`~/.tailscale` state) survives unless asked.

    The tailscale-CLI receipt is host-scoped: one per box, shared with the
    OpenClaw bundle, which reads it the same way we do. Remove it only when
    this plugin provisioned it (the OpenClaw twin makes the same check in
    `extensions/ocuclaw/src/setup/cloudways.ts`). A receipt somebody else
    wrote still describes a live install, so it survives — and so do the
    binaries it names, which on this layout are the same `~/bin` pair we
    would otherwise delete out from under that install.
    """
    report: Dict[str, Any] = {"ok": False}
    job = find_watchdog_job(layout)
    if job is not None:
        rc, out, err = _cron(layout, "remove", str(job.get("id")), runner=runner)
        report["jobRemoved"] = rc == 0
    running = daemon_state(layout, runner=runner).state == STATE_RUNNING
    if running:
        # Port-scoped `off`, never `serve reset` (the codebase's one removal form).
        rc, out, err = _run(
            layout.cli_argv() + ("serve", f"--tls-terminated-tcp={serve.serve_port()}", "off"),
            runner=runner,
            timeout_s=15.0,
        )
        report["serveRouteRemoved"] = rc == 0
    report.update(stop_daemon(layout, runner=runner))
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
    keep_binaries = keep_receipt and (receipt is None or _same_file(receipt.argv[0], layout.tailscale))
    targets: List[Path] = [layout.script_path]
    if not keep_binaries:
        # The install receipt records where these binaries came from; it stays
        # with them.
        targets += [layout.tailscale, layout.tailscaled, layout.tgz_receipt]
    removed: List[str] = []
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
    "DETECT_CLOUDWAYS",
    "DETECT_LIKELY",
    "DETECT_NO",
    "Layout",
    "SOCKS5_LISTEN",
    "STALE_ENROLLMENT_NOTICE",
    "STATE_ABSENT",
    "STATE_NEEDS_AUTH",
    "STATE_RUNNING",
    "STATE_STARTING",
    "STATE_STOPPED",
    "STATE_UNKNOWN",
    "TAILSCALE_TGZ_SHA256",
    "TAILSCALE_TGZ_URL",
    "TAILSCALE_VERSION",
    "WATCHDOG_JOB_NAME",
    "WATCHDOG_SCHEDULE",
    "WATCHDOG_SCRIPT_NAME",
    "daemon_state",
    "detect",
    "disable",
    "enable",
    "enroll",
    "enrollment_up_running",
    "ensure_watchdog_job",
    "install",
    "install_binaries",
    "legacy_inventory",
    "render_watchdog_script",
    "rollback",
    "daemon_summary",
    "status",
    "write_receipt",
    "write_watchdog_script",
]
