"""Step 2 of the Cloudways ladder: the settings, through sanctioned doors only.

Two settings, two different doors, and the difference is not cosmetic:

* **The wearer admin allow-list** (`platforms.ocuclaw.extra.allow_admin_from`)
  is a PLATFORM setting. Hermes gives a platform plugin no API that writes
  `config.yaml`, and documents env seeding as the way to fill
  `platforms.<name>.extra`, so the ladder writes the env NAME
  ``OCUCLAW_ALLOW_ADMIN_FROM`` through Hermes's own env writer
  (`hermes_cli.config.save_env_value`, the same door `relay_credential.py`
  uses). The plugin's seeding (#3098) carries it into `extra` at gateway start.
* **Tool progress** (`display.platforms.ocuclaw.tool_progress`) is a HERMES
  CORE display key. It cannot move to env seeding, so the ladder runs the
  user's own `hermes config set` line as a subprocess — the exact line shown in
  the consent — and confirms it with `hermes config get`.

Three rules this module exists to keep:

1. **The exit code of `hermes config set` is never trusted.** On a managed
   install `set_config_value` calls `managed_error()`, which prints to stderr
   and *returns* — the process still exits 0 (`hermes_cli/config.py` at the
   0.21.1 floor, commit ``2237be355906``). A ladder gated on the exit code
   would march past a silent no-op. Only the read-back decides.
2. **Nothing writes `config.yaml` directly.** Not here, not through a helper.
   `tests/test_cloudways_settings.py` scans this file's source for the direct
   doors and fails if one ever appears.
3. **The env file is read by NAME, never dumped.** It sits beside the Relay
   Credential, which is never printed, logged or read by the ladder.

"Already correct" is judged on the EFFECTIVE value, not on where it lives: a
hand-edited `config.yaml` that already lists the wearer is correct, and the
ladder leaves it alone rather than adding an env name that would shadow it.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from . import cloudways, cloudways_restart_step, health

# -- what the settings are ----------------------------------------------------

#: The platform key as the fresh-install reference writes it, and the env name
#: #3098 seeds it from.
ALLOW_ADMIN_FROM_KEY = "platforms.ocuclaw.extra.allow_admin_from"
ALLOW_ADMIN_FROM_ENV = health.OCUCLAW_ALLOW_ADMIN_FROM_ENV
#: The one user id the adapter ever stamps on a wearer event. Continue here
#: (#2509) needs the allow-list to name it; the guide makes the user type
#: `'["ocuclaw-wearer"]'` by hand today.
WEARER_ID = health.OCUCLAW_WEARER_USER_ID

#: The Hermes core display key, and the exact value the guide's line uses.
#: `hermes config set` coerces `off` to the boolean False, which is why
#: `hermes config get` answers `false` — both spellings read back as off.
TOOL_PROGRESS_KEY = "display.platforms.ocuclaw.tool_progress"
TOOL_PROGRESS_VALUE = "off"

#: `display.interface tui` is deliberately NOT here. The ladder pairs in its
#: own terminal, so it never needs the TUI selected (evidence: #3098 / PR
#: #3118). Writing it would change a setting the user did not need changed.

_OFF_WORDS = frozenset({"false", "off", "0", "no"})
_ON_WORDS = frozenset({"true", "on", "1", "yes"})

#: `hermes config get` on a key that is not set exits non-zero after printing
#: "Config key not set"; a bounded read is plenty for a local config lookup.
CONFIG_CMD_TIMEOUT_S = 30.0


# -- journal vocabulary (mirrored into cloudways_setup.JOURNAL_DETAILS) -------

DETAIL_ALREADY_CORRECT = "already-correct"
DETAIL_WRITTEN = "written"
DETAIL_CONSENT_DECLINED = "consent-declined"
DETAIL_READ_BACK_MISMATCH = "read-back-mismatch"
DETAIL_ENV_WRITE_FAILED = "env-write-failed"
DETAIL_PENDING_MARKER_FAILED = "pending-marker-failed"

JOURNAL_DETAILS = frozenset(
    {
        DETAIL_ALREADY_CORRECT,
        DETAIL_WRITTEN,
        DETAIL_CONSENT_DECLINED,
        DETAIL_READ_BACK_MISMATCH,
        DETAIL_ENV_WRITE_FAILED,
        DETAIL_PENDING_MARKER_FAILED,
    }
)


# -- the lines the user sees --------------------------------------------------

ALREADY_CORRECT_MESSAGE = (
    "Settings already applied."
)

CONSENT_HEADER = "  These settings will change on this host, and nothing else:"

#: The default consent (#3244): what each setting DOES, in the user's words,
#: and an offer of the exact keys for anybody who wants them. `--details`
#: prints :data:`CONSENT_HEADER` and the technical block instead. Both ask the
#: same question, take the same answer and write the same two settings.
#:
#: The header counts what is actually changing. A rerun that found one setting
#: already correct must not claim two are about to change.
SHORT_CONSENT_HEADER_TWO = "  Setup will make these changes:"
SHORT_CONSENT_HEADER_ONE = "  Setup will make this change:"
SHORT_ALLOW_ADMIN_LINE = (
    '    Enable "Continue here" for your glasses wearer,\n'
    "    so you can pick up a Desktop or terminal chat on your glasses."
)
SHORT_TOOL_PROGRESS_LINE = (
    "    Keep tool-progress messages out of the conversation.\n"
    "    Tool activity will still appear in the UI."
)
SHORT_DETAILS_HINT = "  Exact settings: add --details when running setup."

ENV_DOOR_NOTE = (
    f"      written to the Hermes env file as {ALLOW_ADMIN_FROM_ENV}; the gateway "
    "reads it when it starts."
)

ENV_OVERRIDE_NOTE = (
    f"      from the next gateway start this env value overrides "
    f"{ALLOW_ADMIN_FROM_KEY} in config.yaml."
)

#: Why nothing was written when the pending marker could not be stamped. It
#: names the directory rather than the marker: the user has no reason to know
#: what the marker is, and the state directory is the thing they can fix.
PENDING_MARKER_FAILED_MESSAGE = (
    "this command could not write to the Hermes state directory, so it changed "
    "nothing. It records there that a gateway restart is owed before it changes "
    "a setting, because a setting the gateway never reloads looks exactly like "
    "one that works. Check that the Hermes state directory is writable and run "
    "the same command again."
)


def tool_progress_command_line() -> str:
    """The EXACT line the consent shows — and the argv that is executed.

    One source for both, so the promise and the action can never drift apart.
    """
    return " ".join(("hermes", *tool_progress_argv_tail()))


def tool_progress_argv_tail() -> Tuple[str, ...]:
    return ("config", "set", TOOL_PROGRESS_KEY, TOOL_PROGRESS_VALUE)


def tool_progress_read_command_line() -> str:
    """The read the step quotes, and the read it actually runs."""
    return " ".join(("hermes", "config", "get", TOOL_PROGRESS_KEY))


# -- the two doors, as seams --------------------------------------------------
# Module-level on purpose: a test replaces them so no suite can reach a real
# Hermes env file, and production gets Hermes's own writer with no indirection.


def read_env_name(name: str) -> str:
    """The value of ONE env name. Never lists or dumps the env file."""
    try:
        from hermes_cli.config import get_env_value  # type: ignore

        value = get_env_value(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    except Exception:  # noqa: BLE001 - the supervised process env is the fallback
        pass
    return str(os.environ.get(name, "") or "").strip()


def write_env_name(name: str, value: str) -> None:
    """Write one env name through Hermes's own atomic env writer.

    Raises on any failure; the caller reports it and the step exits 1. There is
    deliberately NO fallback that writes the file by hand: the sanctioned door
    is the whole point of this step.
    """
    from hermes_cli.config import save_env_value  # type: ignore

    save_env_value(name, value)


def read_platform_extra() -> Mapping[str, Any]:
    """`platforms.ocuclaw.extra` as `config.yaml` has it — a READ, never a write."""
    config, readable = health.setup_raw_config()
    if not readable:
        return {}
    platforms = config.get("platforms")
    block = platforms.get("ocuclaw") if isinstance(platforms, Mapping) else None
    extra = block.get("extra") if isinstance(block, Mapping) else None
    return extra if isinstance(extra, Mapping) else {}


# -- reading what is there now ------------------------------------------------


def _env_mapping() -> Dict[str, str]:
    """The one env name this step reads, shaped for `health.platform_env_seed`."""
    return {ALLOW_ADMIN_FROM_ENV: read_env_name(ALLOW_ADMIN_FROM_ENV)}


def env_seed_admin_ids(env: Mapping[str, str]) -> Optional[List[str]]:
    """What the env name contributes, through HERMES'S OWN parser, or None.

    `health.platform_env_seed` is the parser the gateway seed uses
    (`_parse_id_list`): it refuses a value that is not a list of plain ids —
    `["alice",true]`, `{"a":1}`, truncated JSON — warns once, and contributes
    NOTHING, so `config.yaml` keeps deciding. Anything that read such a value
    with a second, more forgiving parser would compute a different "current"
    list from the one the gate actually uses, and could drop an admin while
    writing a now-valid env line that shadows the yaml for good.
    """
    seed = health.platform_env_seed(env)
    ids = seed.get("allow_admin_from")
    return list(ids) if isinstance(ids, list) else None


def current_admin_ids() -> List[str]:
    """The EFFECTIVE allow-list, read with Hermes's own parser and precedence.

    `health.effective_platform_extra` layers the env seed over `config.yaml`
    exactly as `gateway/config_env.py` `_enable_plugin_platform` does
    (``extra.update(seed)``), and `health.admin_ids_from_extra` coerces the
    result the way `gateway.slash_access` coerces it. A blank or refused env
    name contributes nothing and the yaml value stands, which is what keeps a
    hand-edited `config.yaml` working.

    ``seed_committed=True`` on purpose. `health.env_seed_reaches_extra` answers
    "would Hermes commit the seed RIGHT NOW", and before the Relay Credential
    exists the answer is no — but the ladder's own step 3 makes the credential
    exist, so the post-setup answer is yes. Asking the present-tense question
    here would let the step call a host "already correct" on a yaml value that
    a valid-but-wrong env name is about to override, which is precisely the
    trap this read exists to avoid.
    """
    extra = health.effective_platform_extra(
        read_platform_extra(), seed_committed=True, env=_env_mapping()
    )
    return health.admin_ids_from_extra(extra)


def desired_admin_ids(current: Sequence[str]) -> List[str]:
    """The wearer, appended to whoever is already an admin.

    The guide is explicit that other ids are preserved: dropping an operator's
    own admin id to write the ruled single-entry list would be a regression
    dressed as a fix.
    """
    ids = [str(item) for item in current if str(item).strip()]
    return ids if WEARER_ID in ids else [*ids, WEARER_ID]


def admin_ids_text(ids: Sequence[str]) -> str:
    """Exactly what is shown and exactly what is written. JSON, as the guide types it."""
    return json.dumps(list(ids), separators=(",", ":"))


def _parse_off(text: str) -> Optional[bool]:
    """True when the printed value means off, False when on, None when neither."""
    for line in reversed(str(text or "").splitlines()):
        word = line.strip().lower()
        if not word:
            continue
        if word in _OFF_WORDS:
            return True
        if word in _ON_WORDS:
            return False
        return None
    return None


# -- the subprocess door ------------------------------------------------------


def _hermes(ctx: Any, *args: str) -> Tuple[Optional[int], str, str]:
    """Run one `hermes` verb through the INJECTED runner, in this CLI process.

    ``HERMES_HOME`` is pinned to the home the ladder resolved, the same way
    `cloudways._cron` pins it, so the command acts on the profile the user is
    setting up and not on whatever the ambient environment points at.
    """
    import subprocess

    runner = ctx.runner if ctx.runner is not None else subprocess.run
    env = dict(ctx.env)
    env["HERMES_HOME"] = str(ctx.layout.hermes_home)
    # The package's one answer to "which hermes"; a second answer could drift.
    argv = [cloudways.hermes_bin(), *args]
    try:
        completed = runner(
            argv,
            capture_output=True,
            text=True,
            timeout=CONFIG_CMD_TIMEOUT_S,
            check=False,
            env=env,
        )
    except Exception as exc:  # noqa: BLE001 - a command that cannot run is not a verdict
        return None, "", str(exc)
    return (
        int(getattr(completed, "returncode", 1)),
        str(getattr(completed, "stdout", "") or ""),
        str(getattr(completed, "stderr", "") or ""),
    )


def read_tool_progress_word(ctx: Any) -> Optional[str]:
    """The word `hermes config get` prints for the key, or None if it will not say.

    `hermes config set <key> off` coerces the value to the boolean False, so
    this answers `false` on a host where the guide's line wrote `off`. Both
    spellings mean off, and the step shows the one the user would see if they
    ran the read themselves.
    """
    code, out, _err = _hermes(ctx, "config", "get", TOOL_PROGRESS_KEY)
    if code != 0:
        # "Config key not set" exits 1. Unknown is not "already off".
        return None
    for line in reversed(str(out or "").splitlines()):
        word = line.strip()
        if word:
            return word
    return None


def read_tool_progress(ctx: Any) -> Optional[bool]:
    """Tri-state: True off, False on, None unknown (unset, or unreadable)."""
    word = read_tool_progress_word(ctx)
    return None if word is None else _parse_off(word)


# -- the step -----------------------------------------------------------------


@dataclass
class _Plan:
    admin_ids: Optional[List[str]] = None  # None: the allow-list is already right
    current_ids: List[str] = field(default_factory=list)
    tool_progress: bool = False  # True: the display key still needs setting

    @property
    def empty(self) -> bool:
        return self.admin_ids is None and not self.tool_progress


def _consent_lines(plan: _Plan, *, details: bool = False) -> List[str]:
    """What the user is asked to say yes to. Same question either way (#3244)."""
    if not details:
        return _short_consent_lines(plan)
    lines = [CONSENT_HEADER]
    if plan.admin_ids is not None:
        lines.append(f"    {ALLOW_ADMIN_FROM_KEY} = {admin_ids_text(plan.admin_ids)}")
        # The current list, so nobody has to guess whose admin is being kept.
        # This is a privilege key: the consent shows what it is now, not only
        # what it becomes.
        lines.append(f"      it is {admin_ids_text(plan.current_ids)} today.")
        lines.append(ENV_DOOR_NOTE)
        lines.append(ENV_OVERRIDE_NOTE)
    if plan.tool_progress:
        lines.append(f"    {TOOL_PROGRESS_KEY} = {TOOL_PROGRESS_VALUE}")
        lines.append(f"      set by running: {tool_progress_command_line()}")
    return lines


def _short_consent_lines(plan: _Plan) -> List[str]:
    """The default: what the two settings do, and where to find the keys."""
    wanted = [
        line
        for line, needed in (
            (SHORT_ALLOW_ADMIN_LINE, plan.admin_ids is not None),
            (SHORT_TOOL_PROGRESS_LINE, plan.tool_progress),
        )
        if needed
    ]
    header = SHORT_CONSENT_HEADER_TWO if len(wanted) > 1 else SHORT_CONSENT_HEADER_ONE
    lines = [header, ""]
    for line in wanted:
        lines.extend((line, ""))
    return [*lines, SHORT_DETAILS_HINT, ""]


def apply_settings(ctx: Any) -> Any:
    """Step 2. One consent, sanctioned doors, and every write read back.

    ``ctx.state["settings_changed"]`` is set on every path that reaches a
    verdict: it is this run's answer to "did anything change that the gateway
    has not picked up yet", which step 3 (#3103) reads to decide whether a
    restart is pending. It is scratch shared within ONE run and is never
    persisted — see the rerun note in the module's PR.

    The same fact is made durable by the ladder's pending marker
    (`cloudways_restart_step.mark_restart_pending`), stamped BEFORE the first
    write and left standing by every failure path after it. A Cloudways setup is
    expected to be interrupted by the very restart this step makes necessary, so
    the window between a write and its record has to be empty: a setting on disk
    that nothing says the gateway must reload is a silently dead setting, and
    #3149 is what happened when the rerun had to guess from a file's
    modification time instead. A marker that cannot be stamped stops the step
    before it writes.
    """
    # Imported here, not at module scope: this module is what `cloudways_setup`
    # calls for step 2, and importing it back at import time would be a cycle.
    from . import cloudways_setup as ladder

    current_ids = current_admin_ids()
    plan = _Plan(current_ids=current_ids)
    if WEARER_ID not in current_ids:
        plan.admin_ids = desired_admin_ids(current_ids)
    plan.tool_progress = read_tool_progress(ctx) is not True

    if plan.empty:
        ctx.say(f"  {ALREADY_CORRECT_MESSAGE}")
        if bool(getattr(ctx.options, "details", False)):
            ctx.say(f"    {ALLOW_ADMIN_FROM_KEY} = {admin_ids_text(current_ids)}")
            ctx.say(f"    {TOOL_PROGRESS_KEY} = {TOOL_PROGRESS_VALUE}")
            ctx.say("    Continue here uses wearer admin access; tool activity appears in the UI, not the conversation.")
        ctx.state["settings_changed"] = False
        return ladder.StepRecord("settings", ladder.STATUS_SKIPPED, DETAIL_ALREADY_CORRECT)

    # Two settings on the user's own host, and `y` is what a person types at a
    # prompt. Step 6 publishes a route and keeps the whole word; this does not.
    if not ctx.ask(
        _consent_lines(plan, details=bool(getattr(ctx.options, "details", False))),
        question="Apply these changes? Type yes or y; anything else stops: ",
        answers=ladder.SHORT_YES_CONSENT_ANSWERS,
    ):
        # The ladder's own resume wording, so every declined step reads alike.
        ctx.say(f"  {ladder.RESUME_MESSAGE}")
        ctx.state["settings_changed"] = False
        return ladder.StepRecord(
            "settings",
            ladder.STATUS_DECLINED,
            DETAIL_CONSENT_DECLINED,
            exit_code=ladder.SETUP_EXIT_STOPPED,
        )

    # BEFORE the first byte is written, and this order is load-bearing (#3149
    # review). Between a write and its stamp there is a window — Ctrl-C, a
    # dropped SSH session, the container bouncing — where the setting is on disk
    # and nothing records that the gateway has not read it. The rerun would then
    # find the setting already correct, step 3 would find no marker, and the
    # ladder would walk on with `allow_admin_from` never loaded. Stamping first
    # inverts the cost of every interruption into one unnecessary restart
    # instruction, which is bounded and clears itself.
    #
    # And if the stamp cannot be written, the settings are NOT written. A
    # setting whose restart can be lost is worse than no setting: the user can
    # see that nothing happened and fix the state directory, but a silently
    # dead allow-list looks exactly like a working one.
    if not cloudways_restart_step.mark_restart_pending(ctx):
        ctx.say(f"  {PENDING_MARKER_FAILED_MESSAGE}")
        ctx.state["settings_changed"] = False
        return ladder.StepRecord(
            "settings",
            ladder.STATUS_FAILED,
            DETAIL_PENDING_MARKER_FAILED,
            exit_code=ladder.SETUP_EXIT_PROBLEM,
        )

    # Every return below this line leaves the stamp standing on purpose: a write
    # that failed or did not read back may still have put bytes on disk.
    changed = False

    if plan.admin_ids is not None:
        wanted = admin_ids_text(plan.admin_ids)
        try:
            write_env_name(ALLOW_ADMIN_FROM_ENV, wanted)
        except BaseException:  # noqa: BLE001 - includes Ctrl-C in the write window
            ctx.say(
                f"  {ALLOW_ADMIN_FROM_ENV} could not be written to the Hermes env "
                "file. Settings may be incomplete. Check that the file is writable and "
                "run the same command again."
            )
            ctx.state["settings_changed"] = changed
            return ladder.StepRecord(
                "settings",
                ladder.STATUS_FAILED,
                DETAIL_ENV_WRITE_FAILED,
                exit_code=ladder.SETUP_EXIT_PROBLEM,
            )
        # Read back by NAME, through the SAME parser the gateway seed uses: a
        # value that Hermes would refuse is not a value that took effect, even
        # if the bytes landed in the file.
        if env_seed_admin_ids(_env_mapping()) != plan.admin_ids:
            ctx.say(
                f"  {ALLOW_ADMIN_FROM_KEY} did not read back as {wanted} after "
                "writing it, so it was not applied. Nothing further was done."
            )
            ctx.state["settings_changed"] = changed
            return ladder.StepRecord(
                "settings",
                ladder.STATUS_FAILED,
                DETAIL_READ_BACK_MISMATCH,
                exit_code=ladder.SETUP_EXIT_PROBLEM,
            )
        changed = True
        if bool(getattr(ctx.options, "details", False)):
            ctx.say(
                f"  {ALLOW_ADMIN_FROM_KEY} = {wanted}, written to the Hermes env file "
                f"as {ALLOW_ADMIN_FROM_ENV}."
            )

    if plan.tool_progress:
        # The exit code is NOT consulted: on a managed install this prints an
        # error and still exits 0.
        _hermes(ctx, *tool_progress_argv_tail())
        word = read_tool_progress_word(ctx)
        if _parse_off(word or "") is not True:
            ctx.say(
                f"  {TOOL_PROGRESS_KEY} still does not read back as {TOOL_PROGRESS_VALUE} "
                f"after running `{tool_progress_command_line()}`, so the setting was "
                "not applied. Nothing further was done."
            )
            ctx.state["settings_changed"] = changed
            return ladder.StepRecord(
                "settings",
                ladder.STATUS_FAILED,
                DETAIL_READ_BACK_MISMATCH,
                exit_code=ladder.SETUP_EXIT_PROBLEM,
            )
        changed = True
        # The word the key really reads back as, not the word that was written:
        # Hermes stores `off` as the boolean, so `hermes config get` answers
        # `false` and a promise of "it reads back that way" sends the user
        # looking for a value that is not there.
        if bool(getattr(ctx.options, "details", False)):
            ctx.say(
                f"  {TOOL_PROGRESS_KEY} = {TOOL_PROGRESS_VALUE}, and "
                f"`{tool_progress_read_command_line()}` reads back {word}."
            )

    ctx.state["settings_changed"] = changed
    ctx.say("  Settings applied.")
    return ladder.StepRecord("settings", ladder.STATUS_DONE, DETAIL_WRITTEN)


__all__ = [
    "ALLOW_ADMIN_FROM_ENV",
    "ALLOW_ADMIN_FROM_KEY",
    "ALREADY_CORRECT_MESSAGE",
    "ENV_OVERRIDE_NOTE",
    "DETAIL_ALREADY_CORRECT",
    "DETAIL_CONSENT_DECLINED",
    "DETAIL_ENV_WRITE_FAILED",
    "DETAIL_PENDING_MARKER_FAILED",
    "DETAIL_READ_BACK_MISMATCH",
    "DETAIL_WRITTEN",
    "JOURNAL_DETAILS",
    "PENDING_MARKER_FAILED_MESSAGE",
    "SHORT_ALLOW_ADMIN_LINE",
    "SHORT_CONSENT_HEADER_ONE",
    "SHORT_CONSENT_HEADER_TWO",
    "SHORT_DETAILS_HINT",
    "SHORT_TOOL_PROGRESS_LINE",
    "TOOL_PROGRESS_KEY",
    "TOOL_PROGRESS_VALUE",
    "WEARER_ID",
    "admin_ids_text",
    "apply_settings",
    "current_admin_ids",
    "desired_admin_ids",
    "env_seed_admin_ids",
    "read_env_name",
    "read_platform_extra",
    "read_tool_progress",
    "read_tool_progress_word",
    "tool_progress_argv_tail",
    "tool_progress_command_line",
    "tool_progress_read_command_line",
    "write_env_name",
]
