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
:mod:`cloudways_pair_steps` (#3105).
"""
from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence
from .terminal_output import styled

from . import (
    cloudways,
    cloudways_restart_step,
    cloudways_serve_apply,
    cloudways_settings,
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

#: Step 2's answers. It changes two settings on the user's own host, the
#: question asks for the long spelling, and people type the short one; both mean
#: the same thing there, so both are taken. The default is still No.
SHORT_YES_CONSENT_ANSWERS = frozenset({CONSENT_ANSWER, "y"})

#: Step 6's question. It publishes a route, ADR-0026 has the user type the whole
#: word for it, and its prompt says "the word" so a bare `y` that stops is not a
#: surprise. Its answers are :data:`CONSENT_ANSWERS`, unchanged.
WHOLE_WORD_CONSENT_QUESTION = (
    f"Type the word {CONSENT_ANSWER} to continue, anything else stops: "
)

DEFAULT_ENROLL_WAIT_S = 600.0
DEFAULT_FIRST_USE_WAIT_S = 600.0
DEFAULT_POLL_S = 5.0
DEFAULT_NOTICE_S = 30.0
#: How long step 4 waits for the cron watchdog to bring the daemon up. The
#: watchdog ticks every minute, so anything under that reports a false stall.
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

RESUME_MESSAGE = (
    "Stopped. Nothing was changed by the step you declined. " + RESUME_INVITATION
)

#: Ctrl-C. Every step re-reads live state and nothing is written outside a
#: consented, read-back write, so an interrupt is an ordinary way to leave the
#: ladder, not a crash: one plain line, exit 130, and no traceback (#3146).
INTERRUPT_MESSAGE = "Stopped at your Ctrl-C. " + RESUME_INVITATION

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

    :attr:`runner` and :attr:`fetch` are the injected process runner and the
    injected archive fetch. A step that has to spawn a subprocess uses
    ``ctx.runner`` and never ``subprocess`` directly, or it stops being testable
    without a real host.
    """

    options: SetupOptions
    layout: cloudways.Layout
    say: Callable[[str], None]
    #: Both take the consent lines, and optionally ``question`` / ``answers``
    #: when a step's consent is worded or parsed differently from the default.
    ask: Callable[..., bool]
    ask_human: Callable[..., bool]
    isatty: Callable[[], bool]
    clock: Callable[[], float]
    sleep: Callable[[float], None]
    env: Mapping[str, str]
    runner: Optional[Callable[..., Any]]
    fetch: Optional[Callable[[str, float], bytes]]
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
    if not ctx.options.assume_yes and not ctx.isatty():
        ctx.say(f"  {TTY_REQUIRED_MESSAGE}")
        return StepRecord(
            "host-check", STATUS_REFUSED, "no-terminal", exit_code=SETUP_EXIT_STOPPED
        )
    ctx.say(f"  {hostname} is a Cloudways Managed AI Agents container.")
    # Only now may anything be written, the journal included.
    ctx.state["host_check_passed"] = True
    ctx.state["hostname"] = hostname
    return StepRecord("host-check", STATUS_DONE, cloudways.DETECT_CLOUDWAYS)


def _assume_cloudways(env: Mapping[str, str]) -> bool:
    return str(env.get(ASSUME_CLOUDWAYS_ENV, "")).strip() == "1"


# -- step 2 · settings --------------------------------------------------------


def step_2_settings(ctx: StepContext) -> StepRecord:
    """One consent, sanctioned doors, every write read back (`cloudways_settings`)."""
    return cloudways_settings.apply_settings(ctx)


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


def step_4_tailscale(ctx: StepContext) -> StepRecord:
    """Install the pinned binaries if needed, then gate on the OBSERVED daemon.

    The cron watchdog is what starts ``tailscaled`` here, and its fire is not
    proof: the ladder waits for the daemon to say what it is instead.
    """
    report = ctx.status_fn(wait_s=0.0)
    daemon = _daemon_of(report)
    script = report.get("script") if isinstance(report.get("script"), Mapping) else {}
    # ALL FOUR pieces, not just the binaries: the cron job is what starts
    # tailscaled on this host, so a host that kept its binaries and receipt but
    # lost the job or the script would skip the install and then wait forever
    # for a daemon nothing is bringing up. `install()` is idempotent.
    already_installed = (
        report.get("receipt") is not None
        and daemon.get("state") != cloudways.STATE_ABSENT
        and report.get("job") is not None
        and bool(script.get("present"))
    )
    if already_installed:
        ctx.say("  Tailscale and its background checks are already installed.")
    else:
        install_report = ctx.install_fn()
        if not install_report.get("ok"):
            ctx.say(f"  {install_report.get('error') or 'the Tailscale install failed'}")
            return StepRecord(
                "tailscale", STATUS_FAILED, "install-failed", exit_code=SETUP_EXIT_PROBLEM
            )
        ctx.say(f"  installed Tailscale {install_report.get('version') or cloudways.TAILSCALE_VERSION}.")
        fired = install_report.get("fired") or {}
        # Only a REPORTED failure is one. A background dispatch or a next-tick
        # run reports no verdict, and the observed daemon state below is what
        # decides either way, so an unreported run gets no scary line.
        if str(fired.get("verdict") or "unreported") == "failed":
            ctx.say("  the watchdog's immediate run failed; waiting for its next tick to start the daemon.")

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
        f"  the Tailscale daemon did not start (state {state}). The cron watchdog "
        "starts it within a minute; run the same command again."
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
STEP_5_PHONE_SIGN_IN_LINES = (
    "On your phone, sign in to Tailscale. Open this link to approve this server:",
)


def step_5_enrollment(ctx: StepContext) -> StepRecord:
    """Print the sign-in link, then poll until the node is approved."""
    if ctx.state.get("daemon_state") == cloudways.STATE_RUNNING:
        # Running and authorized: whatever marker is on disk, there is nothing
        # to retry here.
        ctx.say("  This server is already approved.")
        if ctx.state.get("stale_marker"):
            ctx.say(
                "  a stale authorization marker is on disk; the next enable or install "
                "pass clears it, and nothing needs doing."
            )
        return StepRecord("enrollment", STATUS_SKIPPED, cloudways.STATE_RUNNING)
    enrolled = ctx.enroll_fn()
    if enrolled.get("state") == cloudways.STATE_RUNNING:
        ctx.say("  This server is already approved.")
        ctx.state["daemon_state"] = cloudways.STATE_RUNNING
        return StepRecord("enrollment", STATUS_SKIPPED, cloudways.STATE_RUNNING)
    auth_url = enrolled.get("authUrl")
    if not auth_url:
        ctx.say(f"  {enrolled.get('error') or 'no authorization link appeared'}")
        return StepRecord(
            "enrollment", STATUS_FAILED, "no-authorization-link", exit_code=SETUP_EXIT_PROBLEM
        )
    for line in STEP_5_PHONE_SIGN_IN_LINES:
        ctx.say(f"  {line}")
    ctx.say(f"    {auth_url}")
    deadline = ctx.clock() + max(0.0, float(ctx.options.wait_s))
    last_notice = ctx.clock()
    approved = False
    while True:
        polled = ctx.status_fn(wait_s=0.0)
        if _daemon_of(polled).get("state") == cloudways.STATE_RUNNING:
            approved = True
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
    ctx.state["daemon_state"] = cloudways.STATE_RUNNING
    ctx.state["stale_marker"] = False
    return StepRecord("enrollment", STATUS_DONE, cloudways.STATE_RUNNING)


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
    fetch: Optional[Callable[[str, float], bytes]] = None,
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

    lines: List[str] = []
    records: List[StepRecord] = []

    def say(line: str) -> None:
        lines.append(line)
        try:
            stream_out.write(styled(line, stream_out, env) + "\n")
        except Exception:  # noqa: BLE001 - a closed stream never fails the ladder
            pass

    confirm = _default_confirm(stream_in, stream_out, env=env)

    isatty = isatty_fn or _default_isatty(stream_in, stream_out)

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
        fetch=fetch,
        detect_fn=detect_fn or (lambda: cloudways.detect()),
        status_fn=status_fn
        or (
            lambda wait_s=0.0: cloudways.status(
                layout, runner=runner, wait_s=wait_s, clock=clock, sleep=sleep
            )
        ),
        install_fn=install_fn or (lambda: cloudways.install(layout, fetch=fetch, runner=runner)),
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
    )

    exit_code = SETUP_EXIT_OK
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
    if exit_code == SETUP_EXIT_OK and any(r.status == STATUS_NOT_BUILT for r in records):
        say(HANDOFF_MESSAGE)
    if exit_code == SETUP_EXIT_OK and _restart_still_pending(layout):
        # Read from the marker on disk, not from this run's state: an earlier
        # run may have written the settings and left before any gateway
        # restarted, and that user is owed the same line.
        say(CONTINUE_HERE_PENDING_MESSAGE)

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
    return result


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
            stream_out.write(styled(question, stream_out, env, role="prompt"))
            stream_out.flush()
            answer = stream_in.readline()
            stream_out.write("\n")
        except Exception:  # noqa: BLE001 - an unanswerable prompt is a No
            return False
        return str(answer or "").strip().lower() in frozenset(answers)

    return confirm


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
    "SetupOptions",
    "SetupResult",
    "StepContext",
    "StepRecord",
    "journal_path",
    "run_setup",
    "write_journal",
]
