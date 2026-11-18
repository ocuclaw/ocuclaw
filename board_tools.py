"""Hermes Board voice tools (#3061): are Hermes' own kanban agent tools on for
OcuClaw, and the one scoped action that turns them on.

Stock only (0.21.1, 0.21.3): no native-compat package, no upstream patch, no
monkeypatch. Contract: docs/hermes-board/contract.md ("Voice tools (#3061)").

* **Status** is a read. It loads the served profile's effective config through
  Hermes' own reader (``hermes_cli.config.load_config_readonly`` under the
  profile's home) and asks Hermes' own resolver
  (``hermes_cli.tools_config._get_platform_tools``) whether ``kanban`` is in
  the ``ocuclaw`` platform's toolsets, which is what a gateway turn on this
  platform is offered. It writes nothing.
* **Enable** is the wearer's own ``hermes tools enable kanban --platform
  ocuclaw`` line, run as a subprocess with ``HERMES_HOME`` pinned to the served
  profile's home, for a request that carries the phone's explicit
  confirmation or, once per profile, as the default (below). It edits the
  user's own Hermes config. Its exit code is never trusted: the read-back decides (a managed
  install, or a platform Hermes did not discover, exits 0 without writing).
  Nothing here writes ``config.yaml`` itself.
* **Scope.** The command saves this one platform's list
  (``platform_toolsets.ocuclaw``). It never touches the profile-wide
  ``toolsets`` list and never another platform's list. One stock side effect
  could widen another platform: saving clears a toolset it just enabled from
  the cross-platform ``agent.disabled_toolsets`` block. So while ``kanban`` is
  in that block the action is unavailable (``blocked``), and after every run
  each known platform's resolved tools are compared with before.

0.21.1 has no per-platform kanban switch: ``kanban`` is not one of its
configurable toolsets (``hermes tools enable kanban`` answers "Unknown
toolset"), and its kanban tools look only at the profile-wide
``toolsets: [kanban]``. There the action is ``unsupported`` and the
profile-wide list is never changed as a substitute; the voice path stays off.

**On by default** (Matt, 2026-11-13: "turn it on by default"). The first Board
answer for a served profile runs the same scoped enable once, as if the wearer
had confirmed it (``apply_default``). OcuClaw's own store remembers that it
did, per profile home, so a wearer who later turns the tools off in Hermes is
never overridden. Only an ``available`` setup is acted on: blocked, managed,
unsupported and unreadable configs are left exactly as they are.

OcuClaw adds no task toolset. Voice card creation is an ordinary agent turn in
which Hermes' own ``kanban_create`` does the work, behind Hermes' own
eligibility checks (a dispatcher worker, a delegate child, the orchestrator
tools). Turning these tools off never touches direct Board access: browsing
and Board's own actions go through the management method, not the agent.
"""
from __future__ import annotations

import copy
import importlib.util
import os
import sqlite3
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path

#: OcuClaw's Hermes platform (``plugin.yaml`` ``name``, ``adapter.PLATFORM_NAME``).
PLATFORM = "ocuclaw"
TOOLSET = "kanban"
#: The exact line the phone shows before the wearer confirms, and the one run.
COMMAND = ("tools", "enable", TOOLSET, "--platform", PLATFORM)
COMMAND_LINE = "hermes " + " ".join(COMMAND)
#: Inside the control link's 30 s management timeout (``LINK_DB_READ_TIMEOUT_MS``),
#: with room for the read-back; the phone waits longer than the link.
ENABLE_TIMEOUT_S = 20

#: ``setup`` values, in the order the checks run.
SETUP_STATES = ("uncertified", "unsupported", "unknown", "done", "blocked", "managed", "available")
#: The payload ``board.tools.enable`` takes: the wearer confirmed it on the phone.
CONFIRMED = {"confirmed": True}

_ENABLE_LOCK = threading.Lock()

#: Whether the first Board answer for a profile turns the tools on (Matt's
#: ruling, 2026-11-13). The test suites switch it off except where they test it.
DEFAULT_ON = True
#: OcuClaw's record of the one default enable per profile home, in its Board store.
_DEFAULT_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS board_tools_default ("
    " home TEXT PRIMARY KEY, outcome TEXT NOT NULL, applied_at INTEGER NOT NULL)"
)


class ToolsError(Exception):
    """A curated refusal of the enable action; ``code`` is a contract code."""

    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code = code
        self.message = message


#: Curated refusal copy (never native output).
MESSAGES = {
    "invalid_request": "Confirm on the phone to turn on Board voice tools.",
    "uncertified": "Board voice tools aren't available on this Hermes version yet.",
    "unsupported": "This Hermes can't turn on kanban tools for OcuClaw alone.",
    "blocked": "Kanban tools are turned off for every app in your Hermes config. Turning them on here would turn them on everywhere, so Board won't.",
    "managed": "This Hermes config is managed elsewhere, so Board can't change it.",
    "unknown": "Board couldn't read your Hermes tool settings. Try again shortly.",
    "not_saved": "Hermes didn't turn the tools on. Nothing changed.",
    "widened": "Hermes changed more than OcuClaw's tools. Check them with hermes tools on the host.",
    "timeout": "Hermes didn't finish in time. Refresh to check.",
    "cannot_run": "Board couldn't run hermes on the host. Try again shortly.",
}


def per_platform_toggle() -> bool | None:
    """True when this engine has Hermes' per-platform kanban switch: ``kanban`` is
    a configurable toolset and its tools read the platform's selection. A feature
    of the installed code, never of the version label. None means the structural
    probe failed; it is not evidence that the installed feature is absent."""
    try:
        import inspect
        import hermes_cli.tools_config as tools_config
        keys = {row[0] for row in tools_config.CONFIGURABLE_TOOLSETS}
        inspect.signature(tools_config._get_platform_tools).bind({}, PLATFORM,
                                                               include_default_mcp_servers=False)
    except Exception:
        return None
    if TOOLSET not in keys:
        return False
    try:
        return importlib.util.find_spec("tools.kanban_toolset_context") is not None
    except Exception:
        return None


@contextmanager
def _served(home):
    """The served profile's home and its own secrets. A multiplexing gateway
    serves many profiles from one process, and Hermes' resolver reads
    credentials (``get_secret``), which fail closed there with no scope set."""
    import hermes_constants
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    home_token = hermes_constants.set_hermes_home_override(home)
    try:
        secret_token = set_secret_scope(build_profile_secret_scope(Path(home)))
        try:
            yield
        finally:
            reset_secret_scope(secret_token)
    finally:
        hermes_constants.reset_hermes_home_override(home_token)


def _load_config(home) -> dict:
    """The profile's effective config, read through Hermes (never written)."""
    import hermes_constants
    from hermes_cli.config import load_config_readonly
    token = hermes_constants.set_hermes_home_override(home)
    try:
        # A copy: the reader's cache must never be mutated by a resolver.
        return copy.deepcopy(load_config_readonly())
    finally:
        hermes_constants.reset_hermes_home_override(token)


def _kanban_on(config: dict, platform: str) -> bool:
    import hermes_cli.tools_config as tools_config
    return TOOLSET in tools_config._get_platform_tools(copy.deepcopy(config), platform,
                                                      include_default_mcp_servers=False)


def _names(value) -> list:
    if isinstance(value, str):
        value = [part.strip(" '\"") for part in value.strip("[]").split(",")]
    return [str(item).strip() for item in value or [] if str(item).strip()] if isinstance(value, (list, str)) else []


def _suppressed(config: dict) -> bool:
    agent = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    return TOOLSET in _names(agent.get("disabled_toolsets"))


def _profile_wide(config: dict) -> bool:
    return TOOLSET in _names(config.get("toolsets"))


def _state(config: dict, toggle: bool) -> tuple:
    """``(state, scope)`` for the ocuclaw platform. On 0.21.1 the only switch is
    the profile-wide list; on 0.21.3 Hermes' resolver decides."""
    if not toggle:
        return ("on", "profile") if _profile_wide(config) else ("off", None)
    if not _kanban_on(config, PLATFORM):
        return "off", None
    saved = (config.get("platform_toolsets") or {}).get(PLATFORM)
    explicit = isinstance(saved, list) and TOOLSET in [str(item) for item in saved]
    return "on", "platform" if explicit else "profile"


def _managed() -> bool:
    # A failed permission/configuration probe must never offer a mutation.
    from hermes_cli.config import is_managed
    return bool(is_managed())


def _view(config: dict, toggle: bool) -> dict:
    """The existing setup vocabulary keeps native absence, unreadable facts,
    a cross-platform block, managed config and a configured-off feature apart."""
    out = {"platform": PLATFORM}
    state, scope = _state(config, toggle)
    out["state"] = state
    if scope is not None:
        out["scope"] = scope
    if not toggle:
        out["setup"] = "unsupported"
    elif state == "on":
        out["setup"] = "done"
    elif _suppressed(config):
        out["setup"] = "blocked"
    elif _managed():
        out["setup"] = "managed"
    else:
        out["setup"] = "available"
        out["command"] = COMMAND_LINE
    return out


def view(home, certified: bool) -> dict:
    """The ``agentTools`` view for the served profile whose home is ``home``
    (None when it cannot be resolved)."""
    out = {"platform": PLATFORM}
    if not certified:
        return {**out, "state": "unknown", "setup": "uncertified"}
    toggle = per_platform_toggle()
    if toggle is None:
        return {**out, "state": "unknown", "setup": "unknown"}
    try:
        if home is None:
            raise ValueError("no home")
        with _served(home):
            config = _load_config(home)
            return _view(config, toggle)
    except Exception:
        return {**out, "state": "unknown", "setup": "unknown"}


def capability(tools_view) -> dict:
    """The ``agent_tools`` capability row from the view. Voice creation needs
    Hermes' per-platform switch (0.21.3) and the tools on for OcuClaw; 0.21.1 is
    ``unsupported`` even with the profile-wide list on (no scoped path)."""
    row = {"key": "agent_tools", "enabled": False}
    if tools_view is None:
        return {**row, "code": "temporarily_unavailable"}
    setup, state = tools_view.get("setup"), tools_view.get("state")
    if setup == "uncertified":
        return {**row, "code": "uncertified"}
    if setup == "unsupported":
        return {**row, "code": "unsupported"}
    if state == "on":
        return {"key": "agent_tools", "enabled": True}
    if state == "unknown":
        # The view stays unknown when no profile could be read, but an engine
        # without the switch (0.21.1) is unsupported whatever that profile says.
        if per_platform_toggle() is False:
            return {**row, "code": "unsupported"}
        return {**row, "code": "temporarily_unavailable"}
    return {**row, "code": "tools_off"}


def _platforms(config: dict) -> list:
    """Every platform whose resolved tools the enable must leave alone."""
    import hermes_cli.tools_config as tools_config
    names = {str(name) for name in getattr(tools_config, "PLATFORMS", {})}
    names |= {str(name) for name in (config.get("platform_toolsets") or {})}
    return sorted(names - {PLATFORM})


def _others(config: dict) -> dict:
    out = {}
    for platform in _platforms(config):
        try:
            out[platform] = _kanban_on(config, platform)
        except Exception:
            out[platform] = None
    return out


def _run(home) -> str:
    """Run the command once. ``ok``, ``timeout`` or ``cannot_run``; its output is
    never read or forwarded (the read-back decides)."""
    from .cloudways import hermes_bin
    env = dict(os.environ)
    env["HERMES_HOME"] = str(home)
    env.setdefault("AWS_EC2_METADATA_DISABLED", "true")
    # A kanban task's env must not make the CLI act as a dispatcher worker.
    for name in ("HERMES_KANBAN_TASK", "HERMES_KANBAN_BOARD", "HERMES_KANBAN_DB"):
        env.pop(name, None)
    try:
        subprocess.run([hermes_bin(), *COMMAND], capture_output=True, text=True, timeout=ENABLE_TIMEOUT_S,
                       check=False, env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return "timeout"
    except (OSError, ValueError):
        return "cannot_run"
    return "ok"


def enable(home, certified: bool, payload) -> dict:
    """Run the scoped enable for the served profile at ``home`` after the
    wearer's confirmation. Returns the view afterwards; raises ToolsError."""
    if payload != CONFIRMED or type(payload.get("confirmed")) is not bool:
        raise ToolsError("invalid_request", MESSAGES["invalid_request"])
    with _ENABLE_LOCK:
        before_view = view(home, certified)
        setup = before_view["setup"]
        if setup == "done":
            return before_view
        _require_setup(setup)
        try:
            with _served(home):
                before = _load_config(home)
                others_before = _others(before)
                # Re-read native support and current config at the mutation
                # boundary, after the initial offered view. Never carry a phone
                # or earlier server snapshot through an intervening withdrawal.
                from . import board_management as bm
                if not bm.board_enabled(bm.engine_identity()):
                    raise ToolsError("uncertified", MESSAGES["uncertified"])
                toggle = per_platform_toggle()
                if toggle is None or any(on is None for on in others_before.values()):
                    raise ToolsError("temporarily_unavailable", MESSAGES["unknown"])
                current = _view(before, toggle)
                if current["setup"] == "done":
                    return current
                _require_setup(current["setup"])
                ran = _run(home)
        except ToolsError:
            raise
        except Exception:
            raise ToolsError("temporarily_unavailable", MESSAGES["unknown"]) from None
        try:
            with _served(home):
                after = _load_config(home)
                others_after = _others(after)
            after_view = view(home, certified)
        except Exception:
            raise ToolsError("outcome_unknown", MESSAGES["timeout"]) from None
        if any(on is None for on in others_after.values()):
            raise ToolsError("outcome_unknown", MESSAGES["timeout"])
        widened = [name for name, on in others_after.items() if on and others_before.get(name) is False]
        if widened or _names(after.get("toolsets")) != _names(before.get("toolsets")):
            raise ToolsError("outcome_unknown", MESSAGES["widened"])
        if after_view["state"] == "on" and after_view.get("scope") == "platform":
            return after_view
        if ran == "timeout":
            raise ToolsError("outcome_unknown", MESSAGES["timeout"])
        if ran == "cannot_run":
            raise ToolsError("temporarily_unavailable", MESSAGES["cannot_run"])
        raise ToolsError("temporarily_unavailable", MESSAGES["not_saved"])


def _require_setup(setup: str) -> None:
    if setup == "uncertified":
        raise ToolsError("uncertified", MESSAGES["uncertified"])
    if setup == "unknown":
        raise ToolsError("temporarily_unavailable", MESSAGES["unknown"])
    if setup != "available":
        # The existing wire contract uses unsupported for refused setup;
        # distinct blocked/managed reasons remain in the view and curated copy.
        raise ToolsError("unsupported", MESSAGES[setup])


def _default_claim(home) -> bool:
    """Record that the default enable ran for ``home``; False when it already
    had (or the store cannot say), so the default runs at most once."""
    from . import board_watch
    key = str(Path(home).resolve())
    try:
        conn = board_watch._open(create=True)
    except Exception:
        return False
    try:
        conn.execute(_DEFAULT_SCHEMA)
        cur = conn.execute("INSERT OR IGNORE INTO board_tools_default (home, outcome, applied_at) VALUES (?, ?, ?)",
                           [key, "pending", int(time.time())])
        return cur.rowcount == 1
    except sqlite3.Error:
        return False
    finally:
        conn.close()


def _default_outcome(home, outcome: str) -> None:
    from . import board_watch
    try:
        conn = board_watch._open(create=True)
    except Exception:
        return
    try:
        conn.execute("UPDATE board_tools_default SET outcome = ? WHERE home = ?", [outcome, str(Path(home).resolve())])
    except sqlite3.Error:
        pass
    finally:
        conn.close()


def apply_default(home, certified: bool):
    """On by default: the first time a served profile's Board is read, turn its
    kanban tools on for OcuClaw with the same scoped enable the phone's Turn on
    runs. Once per profile home, ever; only from an ``available`` setup. Returns
    the view afterwards when it acted, else None. Never raises."""
    if not DEFAULT_ON or not certified or home is None:
        return None
    try:
        current = view(home, certified)
        if current.get("setup") not in ("available", "done"):
            # Unreadable, unsupported, blocked or managed: not ours to decide, and
            # an unreadable one may read again later, so nothing is recorded.
            return None
        if not _default_claim(home):
            return None
        if current.get("setup") == "done":
            # Already on: recorded, so turning it off later is the wearer's to keep.
            _default_outcome(home, "already_on")
            return None
        try:
            after = enable(home, certified, CONFIRMED)
        except ToolsError as refusal:
            _default_outcome(home, refusal.code)
            return None
        _default_outcome(home, "enabled")
        return after
    except Exception:
        return None


#: Matt, 2026-11-13: with the Board tools on, "card" and "task" each name more
#: than one thing in an OcuClaw chat, and a real-model run in the sim showed the
#: clash ("make me a card for fixing the leaky tap" offered a glasses card,
#: "add a task to fix the leaky tap" went into Hermes' hidden todo list, and
#: kanban_create was refused for a missing worker). One line per turn sorts them
#: by what the wearer wants. ``{profile}`` is the chatting profile, the worker
#: the phone's Say a card names too.
WORDS_LINE = (
    "In OcuClaw, \"card\" and \"task\" each mean more than one thing, so go by what the wearer wants, not the word. "
    "Something to get done (a chore, a job, a follow-up, \"on my board\") is a Board card, even when they say \"make me a card\" or \"add a task\": "
    "file it with kanban_create, triage true so nothing starts, assignee \"{profile}\" unless they name another worker. "
    "Something they will tap or play again and again (a game, a scorer, a timer, a quiz) is a glasses card: ask_glasses_card. "
    "\"Save this\" or \"keep this\" follows what is on the glasses now: an open glasses card is saved with save_glasses_card, "
    "a LiveUI view is saved as a LiveUI Task with manage_liveui_tasks; with neither open, ask which they mean. "
    "Never keep what the wearer asks for in todo_list: they never see it. "
    "When it could be more than one, ask one short question that names the choices, such as \"On your Board, or a card for your glasses?\""
)


def words_line(kwargs) -> str | None:
    """The line for an OcuClaw foreground turn whose agent has the kanban tools,
    else None. Reads the served config through Hermes' cached reader. Never raises."""
    try:
        if str(kwargs.get("platform") or "").strip() != PLATFORM or str(kwargs.get("parent_session_id") or "").strip():
            return None
        toggle = per_platform_toggle()
        if toggle is None:
            return None
        from hermes_cli.config import load_config_readonly
        if _state(copy.deepcopy(load_config_readonly()), toggle)[0] != "on":
            return None
        return WORDS_LINE.replace("{profile}", _turn_profile())
    except Exception:
        return None


def _turn_profile() -> str:
    """The profile this turn runs for, from the home Hermes resolves for it (a
    routed turn's served profile under the override). ``profile_name_for_home``
    is Hermes' own namer from 0.21.6; older engines name it as health does."""
    import hermes_constants
    home = Path(hermes_constants.get_hermes_home())
    namer = getattr(hermes_constants, "profile_name_for_home", None)
    if callable(namer):
        name = namer(home)
    else:
        name = home.name if home.parent.name == "profiles" else "default"
    return str(name or "default")
