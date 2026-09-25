"""Who supervises this profile's gateway, for the setup assistant (#3520).

With no service manager, ``hermes gateway restart`` stops the gateway and then
runs a new one in the FOREGROUND inside the caller. Run from an assistant tool
that is a long hang, after which the gateway lives as a child of the TUI and
dies when the person closes it. So the assistant may restart the gateway only
when Hermes itself would hand the restart to a service manager. Otherwise the
person restarts it in the terminal it runs in.

The ladder mirrors Hermes's own restart dispatch (``hermes_cli.gateway``,
identical at the 0.21.1 floor and on 0.21.3):

1. ``service_manager.detect_service_manager() == "s6"`` - the official s6
   container image; restart goes through s6.
2. ``gateway._installed_service_kind()`` - a Hermes-installed systemd unit,
   launchd agent or Windows task for THIS profile (both helpers read the
   process home, which is the profile the setup tool runs in).
3. A running gateway that declares ``--external-supervisor`` (argv stamped
   into ``gateway_state.json``) has a supervisor Hermes did not install. The
   0.21.1 floor's restart would still start a foreground gateway there, so
   that is ``unknown``: the person restarts it through their own supervisor.
4. Nothing matched: ``unsupervised``.

Any failure to ask Hermes is ``unknown``, never a guess. There is deliberately
no tty, /proc, tmux or nohup heuristic here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Dict, Optional

SERVICE = "service"
UNSUPERVISED = "unsupervised"
UNKNOWN = "unknown"

EXTERNAL_SUPERVISOR_FLAG = "--external-supervisor"
GATEWAY_STATE_FILENAME = "gateway_state.json"


def _hermes_service_manager() -> str:
    from hermes_cli.service_manager import detect_service_manager

    return str(detect_service_manager())


def _hermes_installed_service_kind() -> Optional[str]:
    from hermes_cli.gateway import _installed_service_kind

    return _installed_service_kind()


def _live_gateway_argv(home: Optional[Path]) -> Optional[list]:
    """argv of the live gateway recorded in ``home``, or None."""
    if home is None:
        from .receipts import resolve_receipt_home

        home = resolve_receipt_home()
    if home is None:
        return None
    try:
        record = json.loads((Path(home) / GATEWAY_STATE_FILENAME).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    from .profiles_report import record_pid_is_live

    if record_pid_is_live(record) is not True:
        return None
    argv = record.get("argv")
    return argv if isinstance(argv, list) else None


def classify(
    *,
    service_manager_fn: Callable[[], str] = _hermes_service_manager,
    installed_kind_fn: Callable[[], Optional[str]] = _hermes_installed_service_kind,
    gateway_argv_fn: Callable[[], Optional[list]] = lambda: _live_gateway_argv(None),
) -> Dict[str, Any]:
    """``{"state", "supervisor"}`` for this profile's gateway.

    ``state`` is service | unsupervised | unknown. ``supervisor`` names the
    kind that supervises it (s6, systemd, launchd, windows, external) or is
    None. The callables are seams for tests; the defaults ask Hermes.
    """
    try:
        if service_manager_fn() == "s6":
            return {"state": SERVICE, "supervisor": "s6"}
        kind = installed_kind_fn()
    except Exception:  # noqa: BLE001 - Hermes could not answer: never guess
        return {"state": UNKNOWN, "supervisor": None}
    if kind in ("systemd", "launchd", "windows"):
        return {"state": SERVICE, "supervisor": kind}
    if kind is not None:
        return {"state": UNKNOWN, "supervisor": None}
    try:
        argv = gateway_argv_fn()
    except Exception:  # noqa: BLE001 - an unreadable record is not a supervisor
        argv = None
    if argv and EXTERNAL_SUPERVISOR_FLAG in [str(part) for part in argv]:
        return {"state": UNKNOWN, "supervisor": "external"}
    return {"state": UNSUPERVISED, "supervisor": None}
