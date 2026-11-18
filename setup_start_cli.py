"""``hermes ocuclaw setup-start`` (#7548): load a freshly installed OcuClaw with one restart.

Hermes loads a new plugin only when it restarts. An agent that installed
OcuClaw from a chat therefore has no ``ocuclaw_setup`` tool yet, and chat setup
cannot begin. This command is what the post-install card names for that
moment. It runs the step machine's ``start`` (setup_next.py): OcuClaw's
settings first, then the one restart, so that restart loads the plugin and its
settings together and ``next`` starts at step 4.

The restart starts twenty seconds after this command answers, so the caller's
reply is out first. It runs in a detached child (this command again, with
``--restart-after``): on Cloudways it takes the whole container down, the
caller included. That ends the agent's turn, so the output hands the agent the
one line to say to the person now and tells it to end its turn.

Every collaborator is injectable, so tests run the same entry function a real
host runs.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, TextIO

EXIT_OK = 0
#: Settings could not be turned on, or this host's setup state could not be read.
EXIT_STUCK = 1

#: Long enough for an agent to say its line and end its turn after the command
#: answers. A real model took about ten seconds to write that reply.
RESTART_DELAY_S = 20.0

SAY_SETTINGS_ON = "OcuClaw's settings are on."
SAY_RESTART_SOON = "The restart starts in {seconds} seconds and cuts this turn off."
#: For the agent that ran the command. The restart ends its turn, so whatever
#: it has not said by then the person never sees: one real agent slept through
#: the restart to check on it afterwards, and the chat came back with no word
#: to say continue. The lines to say come next, word for word, as `next` gives
#: its own.
SAY_RELAY_NOW = "Say this to the person now, word for word, then end your turn:"
SAY_AFTER_RESTART = (
    'Run nothing else and do not wait for the restart. When the person says continue, '
    'call the ocuclaw_setup tool with {"operation": "next"} and relay each step.'
)
SAY_DOCTOR = "Run `hermes ocuclaw doctor` to see why."


def restart_child_argv(delay_s: float, timeout_s: float) -> List[str]:
    return ["hermes", "ocuclaw", "setup-start", "--restart-after", str(delay_s), "--restart-timeout", str(timeout_s)]


def schedule_restart(timeout_s: float, delay_s: float = RESTART_DELAY_S) -> bool:
    """Start the detached child that restarts Hermes after ``delay_s``. False when it cannot start."""
    try:
        subprocess.Popen(  # noqa: S603 - fixed argv
            restart_child_argv(delay_s, timeout_s),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError:
        return False
    return True


def run_delayed_restart(
    delay_s: float,
    timeout_s: float,
    *,
    sleep: Callable[[float], None] = time.sleep,
    restart: Optional[Callable[[float], bool]] = None,
) -> int:
    """The detached child: wait, then run the one bounded restart."""
    sleep(max(0.0, delay_s))
    if restart is None:
        from . import cloudways_restart_step as restart_step

        restart = restart_step.restart_gateway
    return EXIT_OK if restart(timeout_s) else EXIT_STUCK


def live_start_deps() -> Any:
    """The step machine's live reads, with a restart that outlives this command."""
    from . import setup_next
    from .adapter import _hermes_home, _setup_next_deps

    deps = _setup_next_deps()

    def restart(how: str) -> bool:
        timeout = setup_next.gateway_restart_timeout(how, _hermes_home())
        return timeout is not None and schedule_restart(timeout)

    deps.restart = restart
    return deps


def render_start(result: Mapping[str, Any]) -> List[str]:
    """The lines for a person or an agent reading the terminal."""
    say = [line for line in result.get("say") or [] if isinstance(line, str)]
    status = result.get("status")
    if status == "restarting":
        restart = result.get("restart") if isinstance(result.get("restart"), Mapping) else {}
        if restart.get("how") == "self":
            # Nothing here can restart Hermes: the lines name the command.
            return [SAY_SETTINGS_ON, SAY_RELAY_NOW, *say, SAY_AFTER_RESTART]
        return [
            f"{SAY_SETTINGS_ON} {SAY_RESTART_SOON.format(seconds=int(RESTART_DELAY_S))}",
            SAY_RELAY_NOW,
            *say,
            SAY_AFTER_RESTART,
        ]
    if status == "stuck":
        return [*say, SAY_DOCTOR]
    return say


def run_setup_start(
    *,
    json_output: bool = False,
    deps: Any = None,
    out: Optional[TextIO] = None,
    err: Optional[TextIO] = None,
) -> int:
    """``hermes ocuclaw setup-start``. Returns the exit code."""
    from . import setup_next

    out = out or sys.stdout
    err = err or sys.stderr
    try:
        result: Dict[str, Any] = setup_next.SetupNext(deps if deps is not None else live_start_deps()).start()
    except setup_next.SetupNextError as exc:
        err.write(f"[ocuclaw] setup-start: {exc}\n")
        return EXIT_STUCK
    if json_output:
        out.write(json.dumps(result, indent=2, sort_keys=True) + "\n")
    else:
        out.write("\n".join(render_start(result)) + "\n")
    out.flush()
    return EXIT_STUCK if result.get("status") == "stuck" else EXIT_OK
