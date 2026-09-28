"""The "OcuClaw is not running" gate for ``hermes ocuclaw uninstall`` (#3765).

The full uninstall used to demand a stopped gateway. On a Cloudways managed
host that can never happen: ``hermes gateway stop`` restarts the whole
container, so the gateway is live again seconds later. The gate was also
unsafe, because right after boot Hermes briefly reports the gateway as not
live while the new process has already started the OcuClaw runtime.

The question uninstall actually needs answered is narrower: is OcuClaw itself
running? This module answers it from evidence that does not depend on the
gateway being down, and owns the uninstall-pending marker that makes a
restarted gateway leave OcuClaw off:

1. ``hermes ocuclaw uninstall`` while OcuClaw runs writes the marker and asks
   for one ``hermes gateway restart``.
2. With the marker present, ``adapter.register`` registers only the
   ``hermes ocuclaw`` CLI, so the restarted gateway starts no relay, no
   runtime and no platform.
3. ``hermes ocuclaw uninstall`` again: the gate passes and removal runs.

This module stays stdlib-only at import time because ``adapter.register``
reads the marker before anything else loads.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional

MARKER_FILENAME = "ocuclaw.uninstall-pending.json"
MARKER_SCHEMA_VERSION = 1

#: Distinct from 0 (done), 1 (problem) and 2 (usage): the command did its part
#: and the operator must restart the gateway, then run it again.
EXIT_RESTART_REQUIRED = 3

RESTART_COMMAND = "hermes gateway restart"
UNINSTALL_COMMAND = "hermes ocuclaw uninstall"
CANCEL_COMMAND = "hermes ocuclaw uninstall --cancel"
FINISH_COMMANDS = (RESTART_COMMAND, UNINSTALL_COMMAND)
CANCEL_COMMANDS = (CANCEL_COMMAND, RESTART_COMMAND)

#: Mirrors ``control_link.HERMES_BUNDLE_DEFAULT_WS_PORT`` / ``_WS_BIND``; kept
#: literal so this module imports nothing from the bundle.
DEFAULT_RELAY_PORT = 47801
DEFAULT_RELAY_BIND = "127.0.0.1"
RELAY_PORT_MARKER_FILE = "ocuclaw-relay-port.json"
RUNTIME_ENTRY_NAME = "hermes-runtime-entry.cjs"
PORT_PROBE_TIMEOUT_S = 0.5


# -- the marker ---------------------------------------------------------------


def marker_path(home: Path) -> Path:
    return Path(home) / "state" / MARKER_FILENAME


def uninstall_pending(home: Optional[Path]) -> bool:
    """Whether uninstall phase 1 ran for this profile. Never raises."""
    if home is None:
        return False
    try:
        return marker_path(home).is_file()
    except OSError:
        return False


def marker_written_at(home: Path) -> Optional[float]:
    """When the marker was written, as UNIX seconds, or None when absent.

    The recorded ``requestedAt`` wins; a body that cannot be read falls back
    to the file's own modification time, which the writer set at the same
    moment.
    """
    path = marker_path(home)
    try:
        stat_result = path.stat()
    except OSError:
        return None
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        body = None
    requested = body.get("requestedAt") if isinstance(body, dict) else None
    if isinstance(requested, (int, float)) and not isinstance(requested, bool):
        return float(requested)
    return float(stat_result.st_mtime)


def write_marker(home: Path, *, clock: Callable[[], float] = time.time) -> Path:
    """Write the marker atomically with owner-only permissions."""
    path = marker_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(
        {"v": MARKER_SCHEMA_VERSION, "requestedAt": float(clock())}, sort_keys=True
    )
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(body + "\n")
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    return path


def remove_marker(home: Path) -> bool:
    """Delete the marker. True when it existed and is now gone."""
    try:
        marker_path(home).unlink()
    except FileNotFoundError:
        return False
    return True


# -- evidence -----------------------------------------------------------------


def _valid_port(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535


def relay_endpoints(
    home: Path, platform_extra: Optional[Mapping[str, Any]], runtime_dir: Path
) -> List[tuple]:
    """Every ``(host, port)`` this profile's relay could be listening on.

    The configured ``wsPort`` (bundle default 47801) plus the runtime's own
    port marker when it names a different port. A wildcard bind is probed on
    loopback.
    """
    extra = platform_extra if isinstance(platform_extra, Mapping) else {}
    ports: List[int] = []
    try:
        configured = int(extra.get("wsPort", DEFAULT_RELAY_PORT))
    except (TypeError, ValueError):
        configured = DEFAULT_RELAY_PORT
    if _valid_port(configured):
        ports.append(configured)
    try:
        marker = json.loads((runtime_dir / RELAY_PORT_MARKER_FILE).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        marker = None
    if isinstance(marker, dict) and _valid_port(marker.get("port")):
        if marker["port"] not in ports:
            ports.append(marker["port"])
    if not ports:
        ports.append(DEFAULT_RELAY_PORT)
    bind = str(extra.get("wsBind") or DEFAULT_RELAY_BIND).strip() or DEFAULT_RELAY_BIND
    if bind in {"0.0.0.0", "::", "*"}:
        bind = DEFAULT_RELAY_BIND
    return [(bind, port) for port in ports]


def port_listening(
    host: str,
    port: int,
    *,
    connect: Optional[Callable[..., Any]] = None,
    timeout_s: float = PORT_PROBE_TIMEOUT_S,
) -> bool:
    """A plain TCP connect. Portable across Linux, macOS and Windows."""
    opener = socket.create_connection if connect is None else connect
    try:
        connection = opener((host, port), timeout=timeout_s)
    except OSError:
        return False
    try:
        connection.close()
    except Exception:  # noqa: BLE001 - the answer is already known
        pass
    return True


def _proc_cmdlines(proc_root: Path) -> Optional[Iterable[tuple]]:
    try:
        entries = os.listdir(proc_root)
    except OSError:
        return None

    def generate():
        for entry in entries:
            if not entry.isdigit():
                continue
            try:
                raw = (proc_root / entry / "cmdline").read_bytes()
            except OSError:
                continue
            yield int(entry), raw.replace(b"\0", b" ").decode("utf-8", "replace")

    return generate()


def _psutil_cmdlines() -> Optional[Iterable[tuple]]:
    try:
        import psutil  # A Hermes core dependency; never required here.
    except Exception:  # noqa: BLE001
        return None

    def generate():
        for process in psutil.process_iter(["pid", "cmdline"]):
            try:
                argv = process.info.get("cmdline") or []
            except Exception:  # noqa: BLE001
                continue
            yield int(process.info.get("pid") or 0), " ".join(str(part) for part in argv)

    return generate()


def runtime_pids(
    plugin_dir: Path, *, proc_root: Path = Path("/proc")
) -> Optional[List[int]]:
    """PIDs running THIS profile's OcuClaw runtime entry, or None if unknowable.

    Linux reads ``/proc``; elsewhere psutil (a Hermes core dependency) lists
    processes when it is importable. A runtime launched from another profile
    names another plugin directory and does not match.
    """
    needles = {str(plugin_dir)}
    try:
        needles.add(str(Path(plugin_dir).resolve(strict=False)))
    except OSError:
        pass
    listing = _proc_cmdlines(proc_root) if sys.platform.startswith("linux") else None
    if listing is None:
        listing = _psutil_cmdlines()
    if listing is None:
        return None
    own = os.getpid()
    found: List[int] = []
    try:
        for pid, command in listing:
            if pid == own or RUNTIME_ENTRY_NAME not in command:
                continue
            if any(needle in command for needle in needles):
                found.append(pid)
    except Exception:  # noqa: BLE001 - a listing that dies mid-way proves nothing
        return None
    return found


def gateway_started_at(record: Optional[Mapping[str, Any]]) -> Optional[float]:
    """When the gateway named by ``gateway_state.json`` started, UNIX seconds.

    Linux converts the recorded start ticks with the boot clock (the same
    conversion ``cloudways_restart_step`` uses); other hosts ask psutil for the
    live process's creation time.
    """
    if not isinstance(record, Mapping):
        return None
    ticks = record.get("start_time")
    if isinstance(ticks, int) and not isinstance(ticks, bool):
        try:
            with open("/proc/stat", "r", encoding="utf-8") as handle:
                boot = next(
                    float(line.split()[1]) for line in handle if line.startswith("btime ")
                )
            hertz = float(os.sysconf("SC_CLK_TCK"))
            if hertz > 0:
                return boot + ticks / hertz
        except (OSError, ValueError, IndexError, StopIteration, AttributeError):
            pass
    pid = record.get("pid")
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
        try:
            import psutil

            return float(psutil.Process(pid).create_time())
        except Exception:  # noqa: BLE001
            return None
    return None


def observe(
    home: Path,
    *,
    plugin_dir: Path,
    runtime_dir: Path,
    platform_extra: Optional[Mapping[str, Any]] = None,
    connect: Optional[Callable[..., Any]] = None,
) -> Dict[str, Any]:
    """Collect the running-OcuClaw evidence. Read-only; never raises."""
    evidence: Dict[str, Any] = {
        "relayEndpoints": [],
        "relayListening": [],
        "runtimePids": None,
        "gatewayStartedAt": None,
        "adapterLoaded": False,
    }
    endpoints = relay_endpoints(home, platform_extra, runtime_dir)
    evidence["relayEndpoints"] = [f"{host}:{port}" for host, port in endpoints]
    evidence["relayListening"] = [
        f"{host}:{port}"
        for host, port in endpoints
        if port_listening(host, port, connect=connect)
    ]
    evidence["runtimePids"] = runtime_pids(plugin_dir)
    try:
        from . import receipts

        record, status, live = receipts.read_gateway_state(home=home)
    except Exception:  # noqa: BLE001
        record, status, live = None, "unreadable", None
    if status == "ok" and live is True:
        evidence["gatewayStartedAt"] = gateway_started_at(record)
        try:
            from .cloudways_restart_step import _plugin_loaded_by_this_process

            evidence["adapterLoaded"] = bool(_plugin_loaded_by_this_process(record))
        except Exception:  # noqa: BLE001
            evidence["adapterLoaded"] = False
    return evidence


def evaluate(
    evidence: Mapping[str, Any],
    *,
    gateway_live: Optional[bool],
    marker_at: Optional[float],
) -> Dict[str, Any]:
    """Pure: does the evidence prove OcuClaw is not running?

    ``gatewayStoppedOrRestarted`` is the check that makes the two-phase flow
    safe: a gateway that started AFTER the marker was written ran
    ``adapter.register`` with the marker present, so it started no OcuClaw.
    A stopped gateway (``gateway_live is False``) passes it too, which keeps
    the old one-phase path for hosts where stopping works.

    An unobservable process table (``runtimePids`` None) does not block: the
    port and platform checks still stand, and the receipt says it was unknown.
    """
    started = evidence.get("gatewayStartedAt")
    restarted_after_marker = (
        gateway_live is True
        and isinstance(started, (int, float))
        and marker_at is not None
        and float(started) > float(marker_at)
    )
    pids = evidence.get("runtimePids")
    checks = {
        "gatewayStoppedOrRestarted": gateway_live is False or restarted_after_marker,
        "relayPortClosed": not evidence.get("relayListening"),
        "noRuntimeProcess": not pids,
        "platformNotConnected": not evidence.get("adapterLoaded"),
    }
    return {
        "ok": all(checks.values()),
        "checks": checks,
        "runtimeProcessObserved": pids is not None,
    }


__all__ = [
    "CANCEL_COMMAND",
    "CANCEL_COMMANDS",
    "EXIT_RESTART_REQUIRED",
    "FINISH_COMMANDS",
    "MARKER_FILENAME",
    "evaluate",
    "marker_path",
    "marker_written_at",
    "observe",
    "remove_marker",
    "uninstall_pending",
    "write_marker",
]
