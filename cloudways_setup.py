"""`hermes ocuclaw cloudways setup` — the Cloudways path as ONE resumable command.

What this module is, and what it deliberately is not:

* It is a CLI orchestrator. Every process it starts runs in THIS CLI process,
  the one the user typed, never in the gateway service.
* It decides nothing on its own. It refuses before touching anything on a host
  it was not designed for, and it asks before anything is written.
* It is idempotent and resumable. Every step reads live state first and skips
  what is already done, so re-running after a decline, a timeout or a dropped
  SSH session resumes instead of redoing. Nothing is ever read as truth from a
  state file: the journal this module writes is diagnostic only.

Shape for the people building the rest of it: the ladder is a table of eight
numbered steps, each one its own function with the same signature
(``StepContext`` in, :class:`StepRecord` out). The runner prints the
``[n/8] title`` header and stops as soon as a record carries an ``exit_code``.
All eight are built. Steps 1, 4 and 5 live here (#3101), step 2 lives in
:mod:`cloudways_settings` (#3102), step 3 lives in
:mod:`cloudways_restart_step` (#3103), step 6 lives in
:mod:`cloudways_serve_apply` (#3104) and steps 7 and 8 live in
:mod:`cloudways_pair_steps` (#3105). Step 1 ends with the model sign-in check
(#3482, :mod:`cloudways_signin`), and step 5 prints its approval link as text
(#5485: no terminal draws a QR).
"""
from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass, field, replace as dataclass_replace
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence
from .terminal_output import styled

from . import (
    cloudways,
    cloudways_restart_step,
    cloudways_serve_apply,
    cloudways_settings,
    cloudways_signin,
    receipts,
    relay_credential,
)

# -- contract -----------------------------------------------------------------

SETUP_STEP_COUNT = 8

#: The Cloudways group's exit contract: 0 done or cleanly handed off, 1 a
#: problem, 2 refused or stopped by the user, 130 interrupted with Ctrl-C.
SETUP_EXIT_OK = 0
SETUP_EXIT_PROBLEM = 1
SETUP_EXIT_STOPPED = 2
#: Ctrl-C, in the shell's own vocabulary (128 + SIGINT).
SETUP_EXIT_INTERRUPTED = 130

STATUS_DONE = "done"
STATUS_SKIPPED = "skipped"
STATUS_REFUSED = "refused"
STATUS_DECLINED = "declined"
STATUS_FAILED = "failed"
#: A step whose automation is not built yet; it named the manual command instead.
STATUS_NOT_BUILT = "not-built"
#: The user pressed Ctrl-C while this step was running (#3146).
STATUS_INTERRUPTED = "interrupted"

CONSENT_ANSWER = "yes"
CONSENT_QUESTION = f"Type {CONSENT_ANSWER} to continue, anything else stops: "
#: What that question accepts, compared stripped and lower-cased. The default is
#: the whole word, and anything else stops: a consent is a No until somebody
#: types the word.
CONSENT_ANSWERS = frozenset({CONSENT_ANSWER})

#: Step 2's answers. Its one question turns on one setting on the user's own
#: host, people type the short spelling, and both mean the same thing there, so
#: both are taken. The default is still No.
SHORT_YES_CONSENT_ANSWERS = frozenset({CONSENT_ANSWER, "y"})

#: Step 6's question. It publishes a route, ADR-0026 has the user type the whole
#: word for it, and its prompt says "the full word" so a bare `y` that stops is
#: not a surprise. Its answers are :data:`CONSENT_ANSWERS`, unchanged. Word for
#: word the OpenClaw ladder's `CONSENT_QUESTION_STRICT`.
WHOLE_WORD_CONSENT_QUESTION = (
    f"Apply route? Type the full word {CONSENT_ANSWER}; anything else stops: "
)

#: Said when the answer to a consent is the setup command itself. A terminal
#: that carries on setup by itself invites pasting the one-liner again, and
#: that paste used to answer the question and decline it (2026-10-11,
#: Cloudways, the restart question). The question is asked again instead.
SETUP_COMMAND_PASTED_LINE = "  That's the setup command. Setup is already running here."
#: How many pasted setup commands one question absorbs before the paste counts
#: as the answer it always was: anything but the word stops.
SETUP_COMMAND_REASKS = 2

DEFAULT_ENROLL_WAIT_S = 600.0
DEFAULT_FIRST_USE_WAIT_S = 600.0
DEFAULT_POLL_S = 5.0
DEFAULT_NOTICE_S = 30.0
#: How long step 4 waits for the daemon to settle. `install` starts it, and the
#: OcuClaw runtime re-checks every minute, so anything under that reports a
#: false stall.
DEFAULT_DAEMON_WAIT_S = 90.0

#: Test-lane marker, in the shape of the Hermes Reply Evidence Marker
#: (:data:`first_run.SIMULATOR_REPLY_EVIDENCE_ENV`). Set to ``1`` it makes step
#: one treat host detection as the decisive Cloudways verdict, so a pet or CI
#: lane can exercise the ladder without weakening the guard for anyone else.
#:
#: NEVER set this on a user's machine. It is deliberately not a flag: a flag is
#: something a user can be talked into typing, and this one would march the
#: ladder across a host it was not designed for. The step says out loud that the
#: override is in force whenever it changes the answer.
ASSUME_CLOUDWAYS_ENV = "OCUCLAW_HERMES_ASSUME_CLOUDWAYS_HOST"

#: Diagnostic journal of the last run. Written through the hardened receipt
#: writer, behind a schema version, and NEVER read back as truth.
JOURNAL_FILENAME = "ocuclaw.cloudways-setup.json"
JOURNAL_SCHEMA_VERSION = 1
JOURNAL_KIND = "cloudways-setup-journal"

#: One run at a time per profile: a kernel lock beside the journal, taken once
#: step 1 knows the host and held to the run's end. The kernel drops it when
#: its holder exits, however it exits, so a closed tab never leaves it stuck.
#: The holder writes its process id in it, for the run that finds it taken.
LOCK_FILENAME = "ocuclaw.cloudways-setup.lock"


# -- the refusals -------------------------------------------------------------
# One plain line each, and nothing is written before any of them. Each names the
# two surfaces that do cover the host: the pairing verb and the Setup Assistant.

NOT_CLOUDWAYS_MESSAGE = (
    'This command is for Cloudways Managed AI Agents. Nothing changed.\n'
    'Ask the OcuClaw Setup Assistant to set up this machine.\n'
    'If it is already set up, pair with hermes ocuclaw pair.'
)

LIKELY_MESSAGE = (
    'Could not confirm this is a Cloudways Managed AI Agents host. Nothing changed.\n'
    'Use the OcuClaw Setup Assistant for this machine.'
)

MANAGED_MESSAGE = (
    'This Hermes installation is managed by a package manager.\n'
    'Setup cannot change its settings here. Nothing changed.\n'
    'Ask the OcuClaw Setup Assistant for the manual steps.'
)

# #5209. Cloudways stays Tailscale-only: the container's userspace Tailscale
# is its only way in, so a custom phone address cannot work here.
PHONE_ADDRESS_MESSAGE = (
    'This profile has a custom phone address set (platforms.ocuclaw.extra.phoneAddress).\n'
    'Cloudways uses its own Tailscale route, so a custom address cannot work here. Nothing changed.\n'
    "Clear it, then run setup again: hermes config set platforms.ocuclaw.extra.phoneAddress ''"
)

# The pairing ceremony's refusal, in its own words: a human answer needs a
# terminal, and a redirected or piped stream is not one.
TTY_REQUIRED_MESSAGE = (
    'Run hermes ocuclaw cloudways setup directly in an interactive terminal.\n'
    'For automation, --yes approves setup changes; it cannot approve pairing or '
    'confirm a glasses reply.'
)

OVERRIDE_ANNOUNCEMENT = (
    f"{ASSUME_CLOUDWAYS_ENV}=1 is set, so host detection is overridden for this "
    "test run. This marker must never be set on a user's machine."
)

#: `ask_human` never consults --yes: automation cannot stand in for a person.
HUMAN_ANSWER_REQUIRED_MESSAGE = (
    'This step needs your answer in an interactive terminal.\n'
    '--yes cannot answer it. Run setup again in your terminal.'
)

#: The one way this ladder says "run it again", so every stop reads alike.
RESUME_INVITATION = (
    "Run the same setup command to resume."
)

#: Said once before step 1, word for word on the OpenClaw lane
#: (`DROPPED_TERMINAL_MESSAGE`). A rerun resumes at the first unfinished step.
DROPPED_TERMINAL_MESSAGE = "If your terminal drops, run the same command again."

RESUME_MESSAGE = (
    "Stopped. Nothing was changed by the step you declined. " + RESUME_INVITATION
)

#: Ctrl-C. Every step re-reads live state and nothing is written outside a
#: consented, read-back write, so an interrupt is an ordinary way to leave the
#: ladder, not a crash: one plain line, exit 130, and no traceback (#3146).
INTERRUPT_MESSAGE = "Stopped at your Ctrl-C. " + RESUME_INVITATION

#: A second terminal, such as a new WebUI ``/terminal`` while the first still
#: runs, says this at step 1 and waits there, changing nothing, until the
#: first run lets the lock go. The WebUI ends a closed tab's terminal only
#: after 15 minutes unwatched, so turning the new one away would strand the
#: person; waiting lets it carry on the moment the old one ends.
ALREADY_RUNNING_MESSAGE = "Setup is already running in another terminal."
ALREADY_RUNNING_TEMPLATE = "Setup is already running in another terminal (process {pid})."
WAITING_FOR_RUN_MESSAGE = "This one carries on if that one stops. Ctrl-C to leave it."
#: Said once the wait ends. Every later step reads live state, as on a rerun,
#: so what the other run finished is skipped, not done again.
TAKING_OVER_MESSAGE = "That one stopped. This one carries on now."
#: How often a waiting run tries the lock again. Short enough to feel at once,
#: and each try is one non-blocking ``flock``.
RUN_LOCK_POLL_S = 2.0

#: #3808. Said the moment a step starts something slow, so a quiet terminal
#: reads as work in progress and not a hang (a real box sat silent for about
#: 20 seconds after step 1 and at step 5). Word for word the OpenClaw
#: ladder's PROGRESS_* lines where both ladders have the same wait.
PROGRESS_SIGN_IN_MESSAGE = "Checking the model sign-in..."
PROGRESS_TAILSCALE_MESSAGE = "Checking Tailscale..."
PROGRESS_TAILSCALE_INSTALL_MESSAGE = "Installing Tailscale..."
PROGRESS_ENROLL_MESSAGE = "Getting the approval link from Tailscale..."
#: An old-ladder box moving off the `~/bin` download (#6360). Word for word
#: the OpenClaw ladder's `TAILSCALE_MOVE_MESSAGE`.
TAILSCALE_MOVE_MESSAGE = (
    "Switching to the Tailscale this server ships. Same node and sign-in, nothing to approve."
)

HANDOFF_MESSAGE = (
    "Some steps are not built yet; the lines above name the command that still "
    "covers each one. Run the same command again at any time: every step re-reads "
    "live state and skips what is already done."
)

#: The last line of a finished run whose settings are still waiting for a
#: gateway restart (#3241). Step 3 no longer stops the ladder for it: the one
#: setting that needs the restart is `allow_admin_from`, which only "Continue
#: here" reads, and nothing between step 4 and step 8 touches it. So the run
#: finishes, and the thing the user has not got yet is named once, in plain
#: words, with no instruction attached — their agent restarts on its own
#: schedule and the setting is picked up then.
CONTINUE_HERE_PENDING_MESSAGE = (
    "Continue here activates at the next agent restart."
)

#: The last line of a run that stopped because something went wrong: never on
#: success, never on the planned restart stop (exit 2), never when the person
#: stopped it themselves. Said once, at the ladder's exit, never by a step.
#: Word for word the OpenClaw ladder's STUCK_HELP_MESSAGE.
STUCK_HELP_MESSAGE = "Stuck? Ask us on Discord: https://discord.ocuclaw.com"


# -- options ------------------------------------------------------------------


@dataclass(frozen=True)
class SetupOptions:
    """Every flag the verb accepts, whether or not its step is built yet."""

    assume_yes: bool = False
    #: Seconds to wait for the tailnet node to be approved (step 5).
    wait_s: float = DEFAULT_ENROLL_WAIT_S
    #: Seconds to wait for the first message (step 8, #3105).
    first_use_wait_s: float = DEFAULT_FIRST_USE_WAIT_S
    no_pair: bool = False
    no_first_use: bool = False
    light_terminal: bool = False
    #: Print the full technical consent blocks instead of the short ones
    #: (#3244). It changes what the consents SAY and nothing else: the same
    #: question is asked, the same answer is required, and the same thing is
    #: done either way.
    details: bool = False
    #: The tailnet NODE NAME, exactly as the OpenClaw twin means it. It is never
    #: a detection override; that is :data:`ASSUME_CLOUDWAYS_ENV`, and it is not
    #: a flag.
    hostname: Optional[str] = None
    json_output: bool = False
    #: ``--look`` (:mod:`setup_look`). Decoration only: the same lines are
    #: written and the same answers read whichever look draws them.
    look: Optional[str] = None

    @classmethod
    def from_namespace(cls, args: Any) -> "SetupOptions":
        return cls(
            assume_yes=bool(getattr(args, "assume_yes", False)),
            wait_s=_positive(getattr(args, "wait", None), DEFAULT_ENROLL_WAIT_S, name="--wait"),
            first_use_wait_s=_positive(
                getattr(args, "first_use_wait", None),
                DEFAULT_FIRST_USE_WAIT_S,
                name="--first-use-wait",
            ),
            no_pair=bool(getattr(args, "no_pair", False)),
            no_first_use=bool(getattr(args, "no_first_use", False)),
            light_terminal=bool(getattr(args, "light_terminal", False)),
            details=bool(getattr(args, "details", False)),
            hostname=(str(getattr(args, "hostname", "") or "").strip() or None),
            json_output=bool(getattr(args, "json_output", False)),
            look=(str(getattr(args, "look", "") or "").strip() or None),
        )


def _positive(value: Any, fallback: float, *, name: str) -> float:
    """Absent means the default; zero or negative is an error, never a rewrite.

    The CLI refuses a non-positive wait at parse time, so this is the second
    line: a programmatic caller gets a loud error rather than a silently
    substituted 600 seconds.
    """
    if value is None:
        return fallback
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number <= 0:
        raise ValueError(f"{name} must be more than 0 seconds, not {number:g}")
    return number


# -- step interface -----------------------------------------------------------


@dataclass
class StepRecord:
    """What one step did. ``exit_code`` set stops the ladder with that code."""

    id: str
    status: str
    detail: Optional[str] = None
    exit_code: Optional[int] = None
    #: Whether a stop with this record ends on :data:`STUCK_HELP_MESSAGE`.
    #: ``None`` means "if it is a problem exit"; ``False`` marks a problem exit
    #: the person chose themselves. Never part of the journal.
    ask_for_help: Optional[bool] = None

    def as_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "status": self.status, "detail": self.detail}


@dataclass
class StepContext:
    """Everything a step may touch. No step reaches around this.

    Two consent doors, and they are not interchangeable:

    * :attr:`ask` is the ordinary consent for a change to the user's own host.
      ``--yes`` answers it, which is what makes the verb automatable.
    * :attr:`ask_human` is the door ``--yes`` can never open. It ignores
      ``--yes`` entirely and refuses without a real terminal. Pairing approval,
      the reply confirmation and anything else the wearer alone owns go through
      it, so automation can never stand in for a person.

    :attr:`runner` is the injected process runner. A step that has to spawn a
    subprocess uses ``ctx.runner`` and never ``subprocess`` directly, or it
    stops being testable without a real host.
    """

    options: SetupOptions
    layout: cloudways.Layout
    #: ``say(line)`` prints and records one line. ``say(line, role="prompt")``
    #: styles it as an action prompt (yellow, as the OpenClaw ladder shows
    #: them); :meth:`say_prompt` is the spelling that also works with a
    #: one-argument stand-in.
    say: Callable[..., None]
    #: Both take the consent lines, and optionally ``question`` / ``answers``
    #: when a step's consent is worded or parsed differently from the default.
    ask: Callable[..., bool]
    ask_human: Callable[..., bool]
    isatty: Callable[[], bool]
    clock: Callable[[], float]
    sleep: Callable[[float], None]
    env: Mapping[str, str]
    runner: Optional[Callable[..., Any]]
    detect_fn: Callable[[], Any]
    status_fn: Callable[..., Mapping[str, Any]]
    install_fn: Callable[[], Mapping[str, Any]]
    enroll_fn: Callable[[], Mapping[str, Any]]
    managed_fn: Callable[[], bool]
    poll_s: float = DEFAULT_POLL_S
    notice_s: float = DEFAULT_NOTICE_S
    daemon_wait_s: float = DEFAULT_DAEMON_WAIT_S
    #: Scratch shared between steps within ONE run. Never persisted, never a
    #: substitute for re-reading live state.
    state: Dict[str, Any] = field(default_factory=dict)
    #: The terminal this ladder is running in. Steps that hand the user to an
    #: existing ceremony — step 7's pairing, step 8's first message — pass these
    #: through instead of reaching for `sys.stdin`/`sys.stdout`, so the whole
    #: command is one terminal session and still runs with no terminal at all
    #: in tests (#3105).
    #:
    #: HANDING OVER IS ALL THEY ARE FOR. A step must never read `stream_in` to
    #: ask its own question: :attr:`ask` and :attr:`ask_human` are the two
    #: doors, and a step that reads the stream directly walks around
    #: `ask_human`'s refusal to accept an answer that did not come from a
    #: person at a terminal. The ceremonies these are passed to own that gate
    #: themselves, which is the only reason they may have the streams.
    stream_in: Any = None
    stream_out: Any = None
    #: The third door, for a numbered choice (#3482). Like :attr:`ask_human`,
    #: ``--yes`` never answers it and it refuses without a real terminal; it
    #: returns the stripped answer, or ``None`` when there is none. ``None``
    #: here means the ladder was built without one, and a step treats that as
    #: no terminal.
    choose: Optional[Callable[..., Optional[str]]] = None
    #: "Is a model signed in and selected?" for this layout's home (#3482).
    #: ``None`` skips the check entirely.
    signin_check_fn: Optional[Callable[[], Any]] = None
    #: The window width a printed command wraps to (#3808); ``0`` off a
    #: terminal or when unknown. ``None`` means never wrap.
    columns_fn: Optional[Callable[[], int]] = None
    #: "Is a phone on the tailnet?" for the line after step 5's approval:
    #: True, False, or None when it cannot tell. ``None`` here reads
    #: ``tailscale status`` through :attr:`runner`, as step 7's check does.
    phone_present_fn: Optional[Callable[[], Optional[bool]]] = None
    #: Step 1 calls this once it knows the host, before the sign-in check: it
    #: takes this profile's setup lock, waiting while another run holds it,
    #: and, in the WebUI, arms the carry-on line. ``None`` here takes no lock,
    #: as for a step driven on its own.
    claim_run_fn: Optional[Callable[[], None]] = None
    #: The configured custom phone address (#5209), or ``None``. Cloudways
    #: keeps its own userspace Tailscale, so step 1 refuses a set value.
    #: ``None`` here skips the check, as for a step driven on its own.
    phone_address_fn: Optional[Callable[[], Optional[str]]] = None

    def say_prompt(self, line: str) -> None:
        """Print ``line`` as an action prompt: the "prompt" role, yellow.

        Works with the ladder's own ``say`` and with a one-argument stand-in
        (a test's ``lines.append``), which gets the plain line.
        """
        try:
            self.say(line, role="prompt")
        except TypeError:
            self.say(line)

    def say_progress(self, message: str) -> None:
        """#3808. One dim line the moment a step starts something slow.

        Like :meth:`say_prompt`, a one-argument stand-in gets the plain line.
        """
        line = f"  {message}"
        try:
            self.say(line, role="detail")
        except TypeError:
            self.say(line)

    def columns(self) -> int:
        """The width a printed command wraps to; ``0`` means one line (#3808)."""
        if self.columns_fn is None:
            return 0
        try:
            return max(0, int(self.columns_fn() or 0))
        except Exception:  # noqa: BLE001 - an unmeasurable window is unknown
            return 0


@dataclass
class SetupResult:
    exit_code: int
    lines: List[str]
    steps: List[StepRecord]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "exitCode": self.exit_code,
            "lines": list(self.lines),
            "steps": [step.as_dict() for step in self.steps],
        }


# -- step 1 · this host -------------------------------------------------------


def step_1_host_check(ctx: StepContext) -> StepRecord:
    """Refuse anything but a decisive Cloudways verdict, before any write."""
    detection = ctx.detect_fn()
    verdict = getattr(detection, "verdict", None)
    hostname = getattr(detection, "hostname", "") or "this host"
    if verdict != cloudways.DETECT_CLOUDWAYS and _assume_cloudways(ctx.env):
        ctx.say(f"  {OVERRIDE_ANNOUNCEMENT}")
        verdict = cloudways.DETECT_CLOUDWAYS
    if verdict != cloudways.DETECT_CLOUDWAYS:
        # "likely" is a refusal: the ladder only runs where it was designed to.
        message = (
            LIKELY_MESSAGE if verdict == cloudways.DETECT_LIKELY else NOT_CLOUDWAYS_MESSAGE
        )
        ctx.say(f"  {message}")
        return StepRecord(
            "host-check", STATUS_REFUSED, str(verdict), exit_code=SETUP_EXIT_STOPPED
        )
    if ctx.managed_fn():
        # `hermes config set` prints an error and still exits 0 under managed
        # mode, so a ladder gated on exit codes would march past a no-op. This
        # is a step-one check for exactly that reason.
        ctx.say(f"  {MANAGED_MESSAGE}")
        return StepRecord(
            "host-check", STATUS_REFUSED, "managed-install", exit_code=SETUP_EXIT_STOPPED
        )
    if ctx.phone_address_fn is not None and ctx.phone_address_fn():
        # #5209: the container has no inbound port and no root, so its own
        # userspace Tailscale is the only way in. Refused before any write.
        ctx.say(f"  {PHONE_ADDRESS_MESSAGE}")
        return StepRecord(
            "host-check", STATUS_REFUSED, "phone-address-set", exit_code=SETUP_EXIT_STOPPED
        )
    if not ctx.options.assume_yes and not ctx.isatty():
        ctx.say(f"  {TTY_REQUIRED_MESSAGE}")
        return StepRecord(
            "host-check", STATUS_REFUSED, "no-terminal", exit_code=SETUP_EXIT_STOPPED
        )
    ctx.say(f"  {hostname} is a Cloudways Managed AI Agents container.")
    # Only now may anything be written. The lock comes first: a run that finds
    # another one going waits here and writes nothing, the journal included,
    # until it holds the lock. Everything after this line reads live state.
    if ctx.claim_run_fn is not None:
        ctx.claim_run_fn()
    ctx.state["host_check_passed"] = True
    ctx.state["hostname"] = hostname
    stopped = _model_sign_in(ctx)
    if stopped is not None:
        return stopped
    return StepRecord("host-check", STATUS_DONE, cloudways.DETECT_CLOUDWAYS)


def _assume_cloudways(env: Mapping[str, str]) -> bool:
    return str(env.get(ASSUME_CLOUDWAYS_ENV, "")).strip() == "1"


def configured_phone_address() -> Optional[str]:
    """This profile's custom phone address (#5209), or ``None``. A READ only.

    Fail-soft: an unreadable config is not a custom address, and the rest of
    the ladder reads config through Hermes anyway.
    """
    try:
        from . import custom_route
        from .health import setup_raw_config

        raw, _readable = setup_raw_config()
        platforms = raw.get("platforms") if isinstance(raw, dict) else None
        block = platforms.get("ocuclaw") if isinstance(platforms, dict) else None
        extra = block.get("extra") if isinstance(block, dict) else None
        return custom_route.configured_phone_address(extra)
    except Exception:  # noqa: BLE001 - a read must not stop the ladder
        return None


# -- step 1, continued · model sign-in (#3482) ---------------------------------


def _model_sign_in(ctx: StepContext) -> Optional[StepRecord]:
    """Is a model signed in? If not, say where to sign in, and stop.

    Part of step 1, not a numbered step: when a model is signed in it prints
    nothing at all, and a check that cannot tell carries on too. The check
    lives in :mod:`cloudways_signin`. #6361: setup never signs in itself. With
    no model it names the Cloudways panel's OpenAI sign-in and stops, under
    ``--yes`` too: that Connect restarts the container, so it has to come
    before setup changes anything, and the same command run again carries on.
    """
    if ctx.signin_check_fn is None:
        return None
    # The check can take 20 seconds on a real box (a live model probe).
    ctx.say_progress(PROGRESS_SIGN_IN_MESSAGE)
    try:
        state = ctx.signin_check_fn()
    except Exception:  # noqa: BLE001 - a check that throws is "could not tell"
        return None
    outcome = cloudways_signin.run_sign_in(
        state, say=ctx.say, rerun_command=cloudways_restart_step.RERUN_COMMAND
    )
    ctx.state["model_sign_in"] = outcome.outcome
    if not outcome.stop:
        return None
    return StepRecord(
        "model-sign-in", STATUS_REFUSED, outcome.outcome, exit_code=SETUP_EXIT_STOPPED
    )


# -- step 2 · settings --------------------------------------------------------


def step_2_settings(ctx: StepContext) -> StepRecord:
    """Settle agent mode and glasses settings before the gateway restart."""
    from . import cloudways_agent_mode

    failure = cloudways_agent_mode.configure(ctx)
    if failure is not None:
        return failure
    agent_changed = bool(ctx.state.get("settings_changed"))
    record = cloudways_settings.apply_settings(ctx)
    ctx.state["settings_changed"] = agent_changed or bool(ctx.state.get("settings_changed"))
    if agent_changed and record.status == STATUS_SKIPPED:
        return StepRecord("settings", STATUS_DONE, cloudways_settings.DETAIL_WRITTEN)
    return record


# -- step 3 · is OcuClaw loaded, and the gateway restart ----------------------


def step_3_relay_credential(ctx: StepContext) -> StepRecord:
    """Say whether OcuClaw is loaded, then at most one announced restart (#3103).

    The credential read, the restart-pending decision and the one bounded
    restart all live in :mod:`cloudways_restart_step`. The step's record id
    stays ``relay-credential``: that is the journal's word for what is read,
    and it is deliberately not what the user is shown (#3242).
    """
    return cloudways_restart_step.run_relay_credential(ctx)


# -- step 4 · Tailscale binaries and daemon -----------------------------------


def tailscale_fully_installed(report: Mapping[str, Any]) -> bool:
    """Every piece of the plugin's Tailscale, from one ``cloudways.status`` report.

    Not just the binaries: the runtime state is what keeps tailscaled alive
    here, so a host that kept its binaries and receipt but lost the state, or
    still has the old cron job, or is still on the `~/bin` download, runs the
    install again. `install()` is idempotent. Shared with the chat step
    machine's Tailscale start (#6377), so both flows migrate the same hosts.
    """
    binaries = report.get("binaries") if isinstance(report.get("binaries"), Mapping) else {}
    supervisor = report.get("supervisor") if isinstance(report.get("supervisor"), Mapping) else {}
    return (
        bool(binaries.get("present"))
        and report.get("receipt") is not None
        and bool(supervisor.get("present"))
        and report.get("job") is None
        and not bool(binaries.get("movePending"))
    )


def step_4_tailscale(ctx: StepContext) -> StepRecord:
    """Install the binaries if needed, then gate on the OBSERVED daemon.

    `install` starts ``tailscaled`` once and the OcuClaw runtime keeps it alive
    after that, but a start is not proof: the ladder waits for the daemon to say
    what it is instead.
    """
    ctx.say_progress(PROGRESS_TAILSCALE_MESSAGE)
    report = ctx.status_fn(wait_s=0.0)
    binaries = report.get("binaries") if isinstance(report.get("binaries"), Mapping) else {}
    move_pending = bool(binaries.get("movePending"))
    already_installed = tailscale_fully_installed(report)
    if move_pending:
        ctx.say(f"  {TAILSCALE_MOVE_MESSAGE}")
    if already_installed:
        ctx.say("  Tailscale and its background checks are already installed.")
    else:
        if not move_pending:
            ctx.say_progress(PROGRESS_TAILSCALE_INSTALL_MESSAGE)
        install_report = ctx.install_fn()
        if not install_report.get("ok"):
            ctx.say(f"  {install_report.get('error') or 'The Tailscale install failed.'}")
            return StepRecord(
                "tailscale", STATUS_FAILED, "install-failed", exit_code=SETUP_EXIT_PROBLEM
            )
        # The server's own binaries: nothing was installed, so no version.
        ctx.say("  Tailscale is ready.")

    report = ctx.status_fn(wait_s=ctx.daemon_wait_s)
    daemon = _daemon_of(report)
    state = daemon.get("state")
    ctx.state["daemon_state"] = state
    # The staleness guard, carried forward for step 5: a marker left behind on a
    # running, authorized node is stale, not a reason to retry.
    ctx.state["stale_marker"] = bool(report.get("needsAuthorizationMarker")) and not bool(
        report.get("authorizationPending")
    )
    status = STATUS_SKIPPED if already_installed else STATUS_DONE
    if state == cloudways.STATE_RUNNING:
        ctx.say("  Tailscale is running.")
        return StepRecord("tailscale", status, state)
    if state == cloudways.STATE_NEEDS_AUTH:
        ctx.say("  Tailscale is running. Server approval is still needed.")
        return StepRecord("tailscale", status, state)
    ctx.say(
        f"  The Tailscale daemon did not start (state {state}). OcuClaw tries "
        "again within a minute; run the same command again."
    )
    return StepRecord("tailscale", STATUS_FAILED, str(state), exit_code=SETUP_EXIT_PROBLEM)


def _daemon_of(report: Mapping[str, Any]) -> Mapping[str, Any]:
    daemon = report.get("daemon")
    return daemon if isinstance(daemon, Mapping) else {}


# -- step 5 · tailnet enrollment ----------------------------------------------

#: Approving the node is the moment the person signs in to Tailscale, so it is
#: the moment to get the app onto the PHONE: approve from there and the phone
#: is on the same account by construction, which is what step 7 needs (#3177).
#: Shared with the OpenClaw ladder word for word (#3177); the honest clause on
#: the second line says a phone is wanted here, never required.
#:
#: #5485: no terminal draws a QR, so the link is always printed as text. These
#: stay word for word what the shared copy fixture pins.
STEP_5_PHONE_SIGN_IN_LINES = (
    "On your phone, sign in to Tailscale. Open this link to approve this server:",
)

#: #3483. First in step 5: the app has to be on the phone before the link can
#: do anything.
STEP_5_INSTALL_TAILSCALE_LINE = (
    "No Tailscale on your phone? Install it from the App Store or Google Play "
    "and sign in first."
)


#: The WebUI terminal's step 5 (Matt, 2026-10-01). Its links open with a
#: click, so the link is the whole step.
#: Approving from the computer's browser does not put the phone on the same
#: account the way scanning with the phone does (#3177), so the account is
#: named.
STEP_5_WEBUI_LINK_LINE = "Open this link and sign in to Tailscale to approve this server:"
STEP_5_WEBUI_ACCOUNT_LINES = (
    "Use the Tailscale account your phone uses.",
    "No Tailscale on your phone? Install it from the App Store or Google Play.",
)

#: Said once the server is approved and no phone is on the tailnet yet. Step 7
#: needs the phone there; asking now lets the person do it while step 6 waits
#: for its certificate, instead of at step 7 with a pairing code running.
STEP_5_PHONE_NEXT_LINES = (
    "While setup finishes the next step, get your phone ready:",
    "open Tailscale on your phone, sign in with the same account, and switch it on.",
)


def tailnet_name_suffix(daemon: Any) -> Optional[str]:
    """The ``-<n>`` Tailscale added to this node's name, or None.

    When old devices still hold the name this node asked for, Tailscale names
    it ``<name>-<n>`` instead, and that ``-<n>`` shows up in the address the
    person later sees. Asked for is ``Self.HostName`` (what ``tailscale up
    --hostname`` set); given is the first label of ``Self.DNSName``, both from
    the status poll that saw the approval. Only an exact ``<asked>-<digits>``
    counts; anything else, or an unreadable status, says nothing. Same rule as
    the OpenClaw ladder's ``tailnetNameSuffix``.
    """
    if not isinstance(daemon, Mapping):
        return None
    raw_asked = daemon.get("node_name", daemon.get("nodeName"))
    raw_dns = daemon.get("dns_name", daemon.get("dnsName"))
    asked = raw_asked.strip().lower() if isinstance(raw_asked, str) else ""
    given = (raw_dns.strip().lower() if isinstance(raw_dns, str) else "").split(".")[0]
    if not asked or not given.startswith(f"{asked}-"):
        return None
    suffix = given[len(asked):]
    digits = suffix[1:]
    return suffix if digits and all("0" <= ch <= "9" for ch in digits) else None


def tailnet_suffix_line(suffix: str) -> str:
    """Said right after "Server approved." Word for word the OpenClaw ladder."""
    return (
        f"  Tailscale added {suffix} because old devices with this name "
        "are still in your tailnet."
    )


def _show_approval_link(ctx: StepContext, auth_url: str) -> None:
    """The install line, then the link as text (#5485: no terminal draws a QR).

    In the WebUI terminal, the link alone: it is clickable there.
    """
    from . import webui_terminal

    if webui_terminal.active(ctx.env):
        ctx.say(f"  {STEP_5_WEBUI_LINK_LINE}")
        ctx.say(f"    {auth_url}")
        for line in STEP_5_WEBUI_ACCOUNT_LINES:
            ctx.say(f"  {line}")
        return
    ctx.say(f"  {STEP_5_INSTALL_TAILSCALE_LINE}")
    for line in STEP_5_PHONE_SIGN_IN_LINES:
        ctx.say(f"  {line}")
    ctx.say(f"    {auth_url}")


def step_5_enrollment(ctx: StepContext) -> StepRecord:
    """Print the sign-in link, then poll until the node is approved."""
    if ctx.state.get("daemon_state") == cloudways.STATE_RUNNING:
        # Running and authorized: whatever marker is on disk, there is nothing
        # to retry here.
        ctx.say("  This server is already approved.")
        if ctx.state.get("stale_marker"):
            ctx.say(
                "  A stale authorization marker is on disk. The next enable or install "
                "pass clears it, and nothing needs doing."
            )
        return StepRecord("enrollment", STATUS_SKIPPED, cloudways.STATE_RUNNING)
    ctx.say_progress(PROGRESS_ENROLL_MESSAGE)
    enrolled = ctx.enroll_fn()
    if enrolled.get("state") == cloudways.STATE_RUNNING:
        ctx.say("  This server is already approved.")
        ctx.state["daemon_state"] = cloudways.STATE_RUNNING
        return StepRecord("enrollment", STATUS_SKIPPED, cloudways.STATE_RUNNING)
    notice = enrolled.get("notice")
    if isinstance(notice, str) and notice.strip():
        # #3481: a restart left the last approval link dead and enroll()
        # started a fresh login (`STALE_ENROLLMENT_NOTICE`). Said once, first,
        # so the new link below is not mistaken for the old one.
        ctx.say(f"  {notice.strip()}")
    auth_url = enrolled.get("authUrl")
    if not auth_url:
        ctx.say(f"  {enrolled.get('error') or 'no authorization link appeared'}")
        return StepRecord(
            "enrollment", STATUS_FAILED, "no-authorization-link", exit_code=SETUP_EXIT_PROBLEM
        )
    _show_approval_link(ctx, str(auth_url))
    deadline =ctx.clock() + max(0.0, float(ctx.options.wait_s))
    last_notice = ctx.clock()
    approved = False
    approved_daemon: Mapping[str, Any] = {}
    while True:
        polled = ctx.status_fn(wait_s=0.0)
        if _daemon_of(polled).get("state") == cloudways.STATE_RUNNING:
            approved = True
            approved_daemon = _daemon_of(polled)
            break
        if ctx.clock() >= deadline:
            break
        if ctx.clock() - last_notice >= ctx.notice_s:
            last_notice = ctx.clock()
            ctx.say("  Waiting for server approval.")
        ctx.sleep(min(ctx.poll_s, max(0.0, deadline - ctx.clock())))
    if not approved:
        # A timeout costs the user nothing: the enrollment is still in flight
        # and the next run picks the same wait back up.
        ctx.say("  Server approval timed out. Run setup again to resume.")
        return StepRecord("enrollment", STATUS_FAILED, "timeout", exit_code=SETUP_EXIT_PROBLEM)
    ctx.say("  Server approved.")
    suffix = tailnet_name_suffix(approved_daemon)
    if suffix:
        ctx.say(tailnet_suffix_line(suffix))
    ctx.state["daemon_state"] = cloudways.STATE_RUNNING
    ctx.state["stale_marker"] = False
    _phone_next(ctx)
    return StepRecord("enrollment", STATUS_DONE, cloudways.STATE_RUNNING)


def _phone_next(ctx: StepContext) -> None:
    """No phone on the tailnet yet? Say what to do on it now. Never waits.

    Only right after this run approved the server: a rerun that finds it
    already approved goes on to step 7, which looks for the phone itself. An
    unreadable answer says nothing, like step 7's check.
    """
    if ctx.options.no_pair:
        return
    try:
        if ctx.phone_present_fn is not None:
            present = ctx.phone_present_fn()
        else:
            from . import cloudways_phone_check

            present = cloudways_phone_check.read_phone_presence(runner=ctx.runner)
    except Exception:  # noqa: BLE001 - an advisory line is never a failure
        return
    if present is False:
        for line in STEP_5_PHONE_NEXT_LINES:
            ctx.say(f"  {line}")


# -- step 6 · private route ---------------------------------------------------


def step_6_private_route(ctx: StepContext) -> StepRecord:
    """Publish the private route itself, after consent (#3104).

    The whole step, including the one Serve apply seam in this bundle and the
    scoped #1272 reversal that allows it, lives in
    :mod:`cloudways_serve_apply`.
    """
    return cloudways_serve_apply.run_private_route(ctx)


# -- step 7 · pair the phone (#3105) ------------------------------------------

STEP_7_SKIPPED_MESSAGE = (
    "stopped here with --no-pair. Nothing after this ran. Run the same command "
    "again without --no-pair when you are ready to pair your phone."
)


def step_7_pair(ctx: StepContext) -> StepRecord:
    # Imported here, not at module scope: the pairing surface and the doctor's
    # collectors stay out of every other `hermes` invocation, and the step
    # module is free to import this one back.
    from . import cloudways_pair_steps

    return cloudways_pair_steps.step_7_pair(ctx)


# -- step 8 · first message (#3105) -------------------------------------------

STEP_8_SKIPPED_MESSAGE = (
    "stopped here with --no-first-use. Run the same command again without it, or "
    "`hermes ocuclaw first-use`, when you are ready to send your first message."
)


def step_8_first_use(ctx: StepContext) -> StepRecord:
    from . import cloudways_pair_steps

    return cloudways_pair_steps.step_8_first_use(ctx)


# -- the ladder ---------------------------------------------------------------

#: index, header, function. The one place the order lives.
SETUP_STEPS = (
    (1, "Cloudways host", step_1_host_check),
    (2, "Settings", step_2_settings),
    (3, "OcuClaw", step_3_relay_credential),
    (4, "Tailscale", step_4_tailscale),
    (5, "Connect to Tailscale", step_5_enrollment),
    (6, "Private route for your phone", step_6_private_route),
    (7, "Pair your phone", step_7_pair),
    (8, "Your first message", step_8_first_use),
)


def run_setup(
    options: Optional[SetupOptions] = None,
    *,
    layout: Optional[cloudways.Layout] = None,
    runner: Optional[Callable[..., Any]] = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    input_stream: Optional[Any] = None,
    output: Optional[Any] = None,
    isatty_fn: Optional[Callable[[], bool]] = None,
    env: Optional[Mapping[str, str]] = None,
    detect_fn: Optional[Callable[[], Any]] = None,
    status_fn: Optional[Callable[..., Mapping[str, Any]]] = None,
    install_fn: Optional[Callable[[], Mapping[str, Any]]] = None,
    enroll_fn: Optional[Callable[[], Mapping[str, Any]]] = None,
    managed_fn: Optional[Callable[[], bool]] = None,
    journal_writer: Optional[Callable[[Path, Mapping[str, Any]], Any]] = None,
    steps: Optional[Sequence[Any]] = None,
    poll_s: float = DEFAULT_POLL_S,
    notice_s: float = DEFAULT_NOTICE_S,
    daemon_wait_s: float = DEFAULT_DAEMON_WAIT_S,
    signin_check_fn: Optional[Callable[[], Any]] = None,
    columns_fn: Optional[Callable[[], int]] = None,
    phone_present_fn: Optional[Callable[[], Optional[bool]]] = None,
    phone_address_fn: Optional[Callable[[], Optional[str]]] = None,
) -> SetupResult:
    """Run the ladder. Returns the exit code, every line shown, and the records.

    Nothing here reaches for a global: the process runner, the clock, the sleep,
    the input, the output and the TTY probe are all injected, which is what lets
    the whole verb be driven the way a user drives it, with no real host.
    """
    options = options or SetupOptions()
    layout = layout or cloudways.Layout.resolve()
    env = os.environ if env is None else env
    stream_in = sys.stdin if input_stream is None else input_stream
    stream_out = sys.stdout if output is None else output

    # A look draws the run its own way (#look). It stands down by itself off a
    # terminal and under --json, so only a person at a terminal ever sees one.
    from . import setup_look

    options = dataclass_replace(options, look=setup_look.resolve_look(options.look, env))
    look_wanted = options.look != "plain" and not options.json_output
    look = setup_look.open_look(
        options.look,
        stream_in,
        stream_out,
        env=env,
        hermes_home=getattr(layout, "hermes_home", None),
        json_output=options.json_output,
        resumed=look_wanted and _restart_still_pending(layout),
    )
    if look is not None:
        stream_in, stream_out = look.stdin, look.stdout

    lines: List[str] = []
    records: List[StepRecord] = []

    def say(line: str, role: Optional[str] = None) -> None:
        lines.append(line)
        try:
            stream_out.write(styled(line, stream_out, env, role=role) + "\n")
        except Exception:  # noqa: BLE001 - a closed stream never fails the ladder
            pass

    confirm = _default_confirm(stream_in, stream_out, env=env)
    read_choice = _default_choose(stream_in, stream_out, env=env)

    isatty = isatty_fn or _default_isatty(stream_in, stream_out)

    def window_columns() -> int:
        """#3808. The real window's width, only when the output is that window."""
        try:
            if not stream_out.isatty():
                return 0
        except Exception:  # noqa: BLE001 - a stream with no isatty is no terminal
            return 0
        import shutil

        try:
            return max(0, int(shutil.get_terminal_size(fallback=(0, 0)).columns))
        except Exception:  # noqa: BLE001 - unmeasurable is unknown
            return 0

    def choose(
        question_lines: Sequence[str], *, question: str, choices: Iterable[str]
    ) -> Optional[str]:
        """The numbered-choice door. --yes never answers it; no terminal, no answer."""
        if not isatty():
            for line in question_lines:
                say(line)
            say(f"  {HUMAN_ANSWER_REQUIRED_MESSAGE}")
            return None
        for line in question_lines:
            lines.append(line)
        return read_choice(question_lines, question=question)

    def check_signin() -> Any:
        return cloudways_signin.check_signed_in(
            layout.hermes_home, env=env, hermes_bin=cloudways.hermes_bin(), runner=runner
        )

    def ask(consent_lines: Sequence[str], **wording: Any) -> bool:
        if options.assume_yes:
            for line in consent_lines:
                say(line)
            say(f"  --yes was passed, so this is answered {CONSENT_ANSWER}.")
            return True
        for line in consent_lines:
            lines.append(line)
        return confirm(consent_lines, **wording) is True

    def ask_human(consent_lines: Sequence[str], **wording: Any) -> bool:
        """The door --yes cannot open. A person answers this, or nobody does."""
        if not isatty():
            for line in consent_lines:
                say(line)
            say(f"  {HUMAN_ANSWER_REQUIRED_MESSAGE}")
            return False
        for line in consent_lines:
            lines.append(line)
        return confirm(consent_lines, **wording) is True

    held: List[int] = []

    def claim_run() -> None:
        """Step 1's claim: one run per profile, and in the WebUI this run's way back.

        A run that finds another one going waits for it, trying the lock again
        every :data:`RUN_LOCK_POLL_S` through the run's own ``sleep``, so a
        Ctrl-C lands in the ladder's handler like any other wait's. Until the
        lock is this run's, the ~/.bashrc line and the journal are the other
        run's: a run that leaves while it waits touches neither.
        """
        try:
            fd = take_run_lock(layout)
        except SetupAlreadyRunning as busy:
            ctx.state["another_run"] = True
            say(
                "  "
                + (
                    ALREADY_RUNNING_TEMPLATE.format(pid=busy.pid)
                    if busy.pid
                    else ALREADY_RUNNING_MESSAGE
                )
            )
            say(f"  {WAITING_FOR_RUN_MESSAGE}")
            fd = _wait_for_run_lock(layout, ctx.sleep)
            ctx.state.pop("another_run", None)
            say(f"  {TAKING_OVER_MESSAGE}")
        if fd is not None:
            held.append(fd)
        from . import webui_terminal

        if webui_terminal.active(env):
            # Armed for the whole run, not only for step 3's restart: a run
            # the WebUI cuts off (it ends a terminal with SIGHUP) leaves the
            # line, so the next /terminal carries on. A run that ends where
            # the person sees it takes the line out again (below).
            try:
                webui_terminal.add_carry_on(setup_look.rerun_command(options.look, env), env)
            except Exception:  # noqa: BLE001 - step 3 still sets up its own way back
                pass

    ctx = StepContext(
        options=options,
        layout=layout,
        say=say,
        ask=ask,
        ask_human=ask_human,
        isatty=isatty,
        clock=clock,
        sleep=sleep,
        env=env,
        runner=runner,
        detect_fn=detect_fn or (lambda: cloudways.detect()),
        status_fn=status_fn
        or (
            lambda wait_s=0.0: cloudways.status(
                layout, runner=runner, wait_s=wait_s, clock=clock, sleep=sleep
            )
        ),
        install_fn=install_fn or (lambda: cloudways.install(layout, runner=runner)),
        enroll_fn=enroll_fn
        or (
            lambda: cloudways.enroll(
                layout, runner=runner, hostname=options.hostname, clock=clock, sleep=sleep
            )
        ),
        managed_fn=managed_fn or relay_credential.is_managed_profile,
        poll_s=poll_s,
        notice_s=notice_s,
        daemon_wait_s=daemon_wait_s,
        stream_in=stream_in,
        stream_out=stream_out,
        choose=choose,
        signin_check_fn=signin_check_fn or check_signin,
        columns_fn=columns_fn or window_columns,
        phone_present_fn=phone_present_fn,
        claim_run_fn=claim_run,
        phone_address_fn=phone_address_fn or configured_phone_address,
    )

    exit_code = SETUP_EXIT_OK
    # The lock step 1 takes is held to the very end, the ~/.bashrc line and the
    # journal included, so a run that starts as this one ends never has either
    # undone under it. A run that is killed (the WebUI ends a terminal with
    # SIGHUP) runs none of this: the kernel lets the lock go, and the line
    # stays for the next /terminal.
    say(DROPPED_TERMINAL_MESSAGE, role="detail")
    say("")
    try:
        for index, header, step in (SETUP_STEPS if steps is None else steps):
            if records:
                say("")
            say(f"[{index}/{SETUP_STEP_COUNT}] {header}")
            try:
                record = step(ctx)
            except KeyboardInterrupt:
                # Caught HERE rather than at the CLI, so the interrupt is a step
                # record like any other stop: the journal says which step the user
                # left, and `--json` still ends with one summary document instead
                # of a traceback (#3146).
                #
                # What this reaches: steps 1 to 6, and every bounded wait in the
                # ladder — they all poll through `ctx.sleep`, so a Ctrl-C there
                # arrives here. Step 7's wait for a phone to appear on the tailnet
                # (#3178) sleeps the same way and lands here too. What it does NOT
                # reach: the prompts in steps 7 and 8. Both ceremonies read their
                # own answer and catch Ctrl-C at the `readline` themselves, where
                # it counts as "no" — step 7 then POSTS a `deny` to the host,
                # deliberately, so an abandoned approval cannot linger, and step 8
                # ends as its own problem. That is their behaviour, not this
                # handler's, and it is left alone.
                say(f"  {INTERRUPT_MESSAGE}")
                record = StepRecord(
                    _step_id(index, step),
                    STATUS_INTERRUPTED,
                    STATUS_INTERRUPTED,
                    exit_code=SETUP_EXIT_INTERRUPTED,
                )
            records.append(record)
            if record.exit_code is not None:
                exit_code = record.exit_code
                break
        from . import webui_terminal

        if webui_terminal.active(ctx.env) and not ctx.state.get("another_run"):
            # This run ended where the person can see it (a finish, a no, a
            # failure, Ctrl-C): the ~/.bashrc line that would carry it on has
            # done its job. A run that left while it waited for another one
            # leaves that run's line alone.
            cloudways_restart_step.forget_way_back(ctx.env)
        if exit_code == SETUP_EXIT_OK and any(r.status == STATUS_NOT_BUILT for r in records):
            say(HANDOFF_MESSAGE)
        if (
            exit_code == SETUP_EXIT_OK
            and _restart_still_pending(layout)
            and not ctx.state.get("continue_here_declined")
        ):
            # Read from the marker on disk, not from this run's state: an earlier
            # run may have written the settings and left before any gateway
            # restarted, and that user is owed the same line. Unless this run's
            # step 2 asked about Continue here and heard no: then Continue here is
            # off, and a marker standing for the other two settings is no promise
            # that it will switch on.
            say(CONTINUE_HERE_PENDING_MESSAGE)
        if _asks_for_help(exit_code, records):
            say(f"  {STUCK_HELP_MESSAGE}")
        if look is not None:
            look.close(exit_code)

        result = SetupResult(exit_code=exit_code, lines=lines, steps=records)
        # Nothing is written on a refusal, the journal included.
        if ctx.state.get("host_check_passed"):
            try:
                write_journal(layout, result, writer=journal_writer)
            except KeyboardInterrupt:
                # A second Ctrl-C, landing in the diagnostic write. The run's
                # answer is already decided and the caller still has to print it,
                # so this costs the journal entry and nothing else. Only
                # KeyboardInterrupt is swallowed here; `write_journal` files its
                # own write failures and never raises them.
                pass
    finally:
        for fd in held:
            release_run_lock(fd)
    return result


def _asks_for_help(exit_code: int, records: Sequence[StepRecord]) -> bool:
    """Does this run end on :data:`STUCK_HELP_MESSAGE`?

    Only a problem exit does, and only when the step that stopped it did not
    mark it as the person's own choice. Success, a decline, the planned restart
    stop and Ctrl-C never do.
    """
    if exit_code != SETUP_EXIT_PROBLEM:
        return False
    last = records[-1] if records else None
    return getattr(last, "ask_for_help", None) is not False


def _restart_still_pending(layout: cloudways.Layout) -> bool:
    """Does the ladder's own restart marker still stand at the end of the run?

    The marker is step 2's record that it wrote something the gateway reads
    only at start, and step 3 removes it as soon as a gateway start has
    answered it. So a marker that is still here when the run finishes is
    exactly the case :data:`CONTINUE_HERE_PENDING_MESSAGE` is for. An
    unreadable marker is treated as standing, the same way step 3 treats it:
    saying nothing would bury a setting that may never have been read.
    """
    home = getattr(layout, "hermes_home", None)
    try:
        _written_at, status = cloudways_restart_step.read_pending_marker(home)
    except Exception:  # noqa: BLE001 - a closing line never fails the ladder
        return False
    return status != cloudways_restart_step.MARKER_MISSING


def _step_id(index: int, step: Any) -> str:
    """The id an interrupted step would have given itself.

    Every entry in :data:`SETUP_STEPS` is named ``step_<n>_<id>`` and returns
    that same id, so a step the user left names itself exactly as a finished
    one does. A stand-in that is not shaped that way falls back to its number.
    """
    parts = str(getattr(step, "__name__", "")).split("_", 2)
    if len(parts) == 3 and parts[0] == "step" and parts[2]:
        return parts[2].replace("_", "-")
    return f"step-{index}"


def _default_isatty(stream_in: Any, stream_out: Any) -> Callable[[], bool]:
    def isatty() -> bool:
        # Both halves: a question down a terminal whose answer comes from a pipe
        # is not a human answer, and neither is the reverse.
        try:
            return bool(stream_in.isatty()) and bool(stream_out.isatty())
        except Exception:  # noqa: BLE001 - an unaskable stream is not a TTY
            return False

    return isatty


def _default_confirm(stream_in: Any, stream_out: Any, *, env=None) -> Callable[..., bool]:
    def confirm(
        consent_lines: Sequence[str],
        *,
        question: str = CONSENT_QUESTION,
        answers: Iterable[str] = CONSENT_ANSWERS,
    ) -> bool:
        try:
            for line in consent_lines:
                stream_out.write(styled(line, stream_out, env) + "\n")
            for reask in range(SETUP_COMMAND_REASKS + 1):
                stream_out.write(styled(question, stream_out, env, role="prompt"))
                stream_out.flush()
                answer = stream_in.readline()
                stream_out.write("\n")
                if reask == SETUP_COMMAND_REASKS or not _is_setup_command(answer):
                    break
                stream_out.write(styled(SETUP_COMMAND_PASTED_LINE, stream_out, env) + "\n")
        except Exception:  # noqa: BLE001 - an unanswerable prompt is a No
            return False
        return str(answer or "").strip().lower() in frozenset(answers)

    return confirm


def _is_setup_command(answer: Any) -> bool:
    """The one-liner from ocuclaw.com, or this very command, typed as an answer."""
    text = " ".join(str(answer or "").lower().split())
    return "ocuclaw.com/" in text or "| bash" in text or text.startswith("hermes ocuclaw")


def _default_choose(stream_in: Any, stream_out: Any, *, env=None) -> Callable[..., Optional[str]]:
    """Print the lines, ask in the prompt role, return the stripped answer.

    ``None`` when there is no answer at all: end of input or a closed stream.
    Ctrl-C is left to the ladder, which stops with exit 130 as it does at the
    consent prompts.
    """

    def choose(question_lines: Sequence[str], *, question: str) -> Optional[str]:
        try:
            for line in question_lines:
                stream_out.write(styled(line, stream_out, env) + "\n")
            stream_out.write(styled(question, stream_out, env, role="prompt"))
            stream_out.flush()
            answer = stream_in.readline()
        except Exception:  # noqa: BLE001 - an unanswerable prompt is no answer
            return None
        if not answer:
            return None
        return str(answer).strip()

    return choose


# -- one run at a time --------------------------------------------------------


#: Another run holds this profile's setup lock; ``.pid`` is its process, when known.
SetupAlreadyRunning = receipts.StateLockHeld


def lock_path(layout: cloudways.Layout) -> Optional[Path]:
    directory = receipts.state_dir(layout.hermes_home)
    return None if directory is None else directory / LOCK_FILENAME


def take_run_lock(layout: cloudways.Layout) -> Optional[int]:
    """Take this profile's setup lock without waiting. Its descriptor, or ``None``.

    ``None`` when no lock can be taken here at all: the run then goes on
    unlocked, as every run did before the lock. Raises
    :class:`SetupAlreadyRunning` when another run holds it, so a second
    terminal is told at once. The file work lives in ``receipts``: this module
    writes no file itself (``test_cloudways_settings`` holds it to that).
    """
    return receipts.try_state_lock(receipts.state_dir(layout.hermes_home), LOCK_FILENAME)


def _wait_for_run_lock(
    layout: cloudways.Layout, sleep: Callable[[float], None]
) -> Optional[int]:
    """Try the lock every :data:`RUN_LOCK_POLL_S` until it is free: its descriptor, or ``None``.

    No deadline: the other run ends, or is ended, and the kernel lets its lock
    go either way. The person leaves with Ctrl-C, which ``sleep`` raises.
    """
    while True:
        sleep(RUN_LOCK_POLL_S)
        try:
            return take_run_lock(layout)
        except SetupAlreadyRunning:
            continue


def release_run_lock(fd: int) -> None:
    """Let the lock go, its process id first, so the file never names a run that ended."""
    receipts.release_state_lock(fd)


# -- the journal --------------------------------------------------------------


def journal_path(layout: cloudways.Layout) -> Optional[Path]:
    directory = receipts.state_dir(layout.hermes_home)
    return None if directory is None else directory / JOURNAL_FILENAME


def write_journal(
    layout: cloudways.Layout,
    result: SetupResult,
    *,
    writer: Optional[Callable[[Path, Mapping[str, Any]], Any]] = None,
) -> Optional[Path]:
    """Secret-free record of where the last run stopped. Support only.

    Deliberately NOT the lines the user saw: those carry the sign-in link and
    whatever a future step prints. Only the closed step vocabulary goes in, and
    nothing reads this file back — every step re-derives live state.
    """
    path = journal_path(layout)
    if path is None:
        return None
    body = {
        "schemaVersion": JOURNAL_SCHEMA_VERSION,
        "kind": JOURNAL_KIND,
        "stepCount": SETUP_STEP_COUNT,
        "exitCode": result.exit_code,
        "steps": [
            {"id": step.id, "status": step.status, "detail": _journal_detail(step)}
            for step in result.steps
        ],
    }
    write = writer or receipts.write_json_receipt
    try:
        write(path, body)
    except Exception:  # noqa: BLE001 - a diagnostic file never fails the ladder
        return None
    return path


#: Details that may be journalled. Anything a step invents outside this closed
#: set is recorded as ``unspecified`` rather than passed through as prose, so a
#: future step cannot leak a link, an address or a credential into the file.
JOURNAL_DETAILS = frozenset(
    {
        "manual",
        "managed-install",
        "no-terminal",
        "no-pair",
        "no-first-use",
        "install-failed",
        "no-authorization-link",
        "timeout",
        STATUS_INTERRUPTED,
        "unspecified",
        # steps 7 and 8 (#3105), spelled out here rather than imported so this
        # closed set stays readable in one place. `cloudways_pair_steps`
        # exports the same words as `STEP_DETAILS`, and a test asserts neither
        # side can drift from the other.
        "already-paired",
        "gateway-not-running",
        "no-relay-credential",
        "route-not-ready",
        "route-not-owned",
        "route-unclaimed",
        "route-claim-unreadable",
        "route-unhealthy",
        "route-refusing",
        "paired",
        "pairing-refused",
        "pairing-failed",
        "first-use-refused",
        "first-use-failed",
        "committed",
        "committed-client-sdk-receipt",
        "committed-wearer-confirmed",
        "armed",
        "armed-client-sdk-receipt",
        "armed-wearer-confirmed",
        cloudways.DETECT_CLOUDWAYS,
        cloudways.DETECT_LIKELY,
        cloudways.DETECT_NO,
        cloudways.STATE_ABSENT,
        cloudways.STATE_STOPPED,
        cloudways.STATE_STARTING,
        cloudways.STATE_NEEDS_AUTH,
        cloudways.STATE_RUNNING,
        cloudways.STATE_UNKNOWN,
        *cloudways_settings.JOURNAL_DETAILS,  # step 2
        *cloudways_restart_step.JOURNAL_DETAILS,  # step 3
        *cloudways_signin.JOURNAL_DETAILS,  # step 1's model sign-in (#3482)
    }
    # Step 6's own words, owned by the module that emits them (#3104), so the
    # vocabulary and the step that uses it cannot drift apart.
    | set(cloudways_serve_apply.ROUTE_JOURNAL_DETAILS)
)


def _journal_detail(step: StepRecord) -> Optional[str]:
    if step.detail is None:
        return None
    return step.detail if step.detail in JOURNAL_DETAILS else "unspecified"


__all__ = [
    "ASSUME_CLOUDWAYS_ENV",
    "INTERRUPT_MESSAGE",
    "JOURNAL_FILENAME",
    "JOURNAL_SCHEMA_VERSION",
    "SETUP_EXIT_INTERRUPTED",
    "SETUP_EXIT_OK",
    "SETUP_EXIT_PROBLEM",
    "SETUP_EXIT_STOPPED",
    "SETUP_STEPS",
    "SETUP_STEP_COUNT",
    "STUCK_HELP_MESSAGE",
    "SetupOptions",
    "SetupResult",
    "StepContext",
    "StepRecord",
    "journal_path",
    "run_setup",
    "write_journal",
]
