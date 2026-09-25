"""Model sign-in for the Cloudways ladder, right after step 1 (#3482).

Before this, neither ladder asked whether the agent could answer at all. A
fresh Cloudways agent created with no provider would walk all eight steps and
fail at the first message, and the only hint was `hermes model` in an error.

Two halves, and they stay apart:

* :func:`check_signed_in` answers "is a model signed in and selected?" with no
  model call. It reads Hermes's own config and credential stores in this
  process: ``model.provider`` (or Hermes's own "auto" resolution), then
  ``hermes_cli.models_detect.provider_has_credentials`` (the model switcher's
  own check: env or .env key, auth-store login, credential pool), then a
  selected model name. Only when those internals cannot be read at all does it
  fall back to a live ``hermes -z`` probe, with a short timeout.
* :func:`run_sign_in` is the chooser. It prints the engine's own commands and
  runs them with the terminal handed straight over: their output is never
  captured, logged, journalled or drawn as a QR code. The device-code link and
  code are Hermes's to print, and the user reads them where Hermes prints them.

The step never runs a sign-in under ``--yes`` or without a real terminal. It
prints what is needed and the ladder carries on: steps 2 to 7 do not need a
model, and step 8 names the model problem in its own words if it is still
there.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence, Tuple

# -- verdicts -----------------------------------------------------------------

SIGNED_IN = "signed-in"
NOT_SIGNED_IN = "not-signed-in"
#: Signed in to a provider, but no model is selected.
NO_MODEL = "no-model"
#: Could not tell. The ladder says nothing and carries on: a wrong "not signed
#: in" would send a working agent through a sign-in it does not need.
UNKNOWN = "unknown"

#: The live probe's bound. A signed-in model answers `hello` well inside this; a
#: probe that has not answered by then is not evidence either way.
LIVE_PROBE_TIMEOUT_S = 45.0

# -- the commands -------------------------------------------------------------

CODEX_SIGN_IN_ARGS = ("auth", "add", "openai-codex", "--no-browser")
NOUS_SIGN_IN_ARGS = ("auth", "add", "nous", "--no-browser")
#: `hermes model` is also the API-key door: choosing a key-based provider there
#: asks for the key, masked, and saves it.
MODEL_ARGS = ("model",)
LIVE_PROBE_ARGS = ("-z", "hello")

CHOICE_CODEX = "1"
CHOICE_NOUS = "2"
CHOICE_API_KEY = "3"
CHOICE_MYSELF = "4"

#: choice -> the label shown, and the commands run in order.
CHOICES: Tuple[Tuple[str, str, Tuple[Tuple[str, ...], ...]], ...] = (
    (CHOICE_CODEX, "ChatGPT subscription", (CODEX_SIGN_IN_ARGS, MODEL_ARGS)),
    (CHOICE_NOUS, "Nous Portal", (NOUS_SIGN_IN_ARGS, MODEL_ARGS)),
    (CHOICE_API_KEY, "An API key", (MODEL_ARGS,)),
    (CHOICE_MYSELF, "I'll set it up myself", ()),
)

# -- the words ----------------------------------------------------------------

NOT_SIGNED_IN_LINE = "No model is signed in yet."
NOT_SIGNED_IN_QUESTION = f"{NOT_SIGNED_IN_LINE} Which account will this agent use?"
CHOOSE_PROMPT = "Choose 1–4: "
NO_MODEL_LINE = "A model account is signed in, but no model is selected yet."
RUNNING_PREFIX = "Running: "
#: Printed for choice 4 (the ladder stops there).
MANUAL_LEAD = "To sign in yourself, run one of these, then run setup again:"
#: Printed under --yes and without a terminal (the ladder carries on).
SKIP_LEAD = "To sign in, run one of these in an interactive terminal:"
MANUAL_ROWS = (
    ("hermes auth add openai-codex --no-browser", "ChatGPT subscription"),
    ("hermes auth add nous --no-browser", "Nous Portal"),
    ("hermes model", "an API key, and to choose the model"),
)
MANUAL_MODEL_LEAD = "To choose a model, run this, then run setup again:"
SKIPPED_LINE = "Setup carries on without a model. Your first message needs one."
SIGNED_IN_LINE = "Model signed in."
COMMAND_FAILED_LINE = "{command} did not finish. Run it again yourself, then run setup again."
STILL_NOT_SIGNED_IN_LINE = "Still no model signed in. Run the commands above yourself, then run setup again."
INVALID_CHOICE_LINE = "Type 1, 2, 3 or 4."
#: How many unrecognised answers before the chooser gives up and stops.
MAX_CHOICE_ATTEMPTS = 3


def command_text(args: Sequence[str]) -> str:
    """What the user is shown and would type: `hermes`, never an install path."""
    return " ".join(("hermes", *args))


# -- the check ----------------------------------------------------------------


@dataclass(frozen=True)
class SignInState:
    verdict: str
    provider: Optional[str] = None
    #: Why, in the step's closed vocabulary. Never a credential or a path.
    reason: str = ""


def _process_hermes_home(env: Mapping[str, str]) -> Optional[Path]:
    """The Hermes home THIS process's `hermes_cli` reads.

    The in-process check can only speak for the home it reads. When the ladder
    was pointed at another home (a test fixture, a profile the CLI did not
    select), its answer would be about the wrong agent, so the caller compares.
    """
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - fall back to the Layout's own rule
        pass
    raw = str(env.get("HERMES_HOME", "") or "").strip()
    return Path(raw) if raw else Path.home() / ".hermes"


def _same_path(a: Optional[Path], b: Optional[Path]) -> bool:
    if a is None or b is None:
        return False
    try:
        return Path(a).expanduser().resolve() == Path(b).expanduser().resolve()
    except Exception:  # noqa: BLE001
        return False


def _selected_model(model_cfg: Any) -> str:
    if isinstance(model_cfg, str):
        return model_cfg.strip()
    if isinstance(model_cfg, Mapping):
        for key in ("default", "model", "name"):
            value = model_cfg.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def check_in_process() -> SignInState:
    """Hermes's own stores, read in this process. No network, no model call.

    ``UNKNOWN`` with reason ``unreadable`` means the Hermes internals this
    reads are missing or changed shape; the caller may fall back to the live
    probe then, and only then.
    """
    try:
        from hermes_cli.auth import resolve_provider
        from hermes_cli.config import load_config
        from hermes_cli.models_detect import provider_has_credentials
    except Exception:  # noqa: BLE001 - Hermes-version-sensitive
        return SignInState(UNKNOWN, reason="unreadable")
    try:
        config = load_config() or {}
        model_cfg = config.get("model") if isinstance(config, Mapping) else None
        configured = (
            model_cfg.get("provider") if isinstance(model_cfg, Mapping) else None
        )
        configured = configured.strip() if isinstance(configured, str) else ""
        try:
            provider = resolve_provider(configured or "auto")
        except Exception as exc:  # noqa: BLE001
            # Matched by name so the class is not one more pinned platform
            # import. Hermes raises its AuthError for "No inference provider
            # configured." (nothing in the config, the env, the pool or the
            # auth store can carry a turn) and for a config naming a provider
            # it does not know; `hermes model` fixes both.
            if type(exc).__name__ == "AuthError":
                return SignInState(NOT_SIGNED_IN, reason="no-provider")
            raise
        if not provider_has_credentials(provider):
            return SignInState(NOT_SIGNED_IN, provider=provider, reason="no-credentials")
        if not _selected_model(model_cfg):
            return SignInState(NO_MODEL, provider=provider, reason="no-model")
        return SignInState(SIGNED_IN, provider=provider, reason="configured")
    except Exception:  # noqa: BLE001 - a read that throws is not a verdict
        return SignInState(UNKNOWN, reason="unreadable")


def probe_live(
    *,
    hermes_bin: str,
    env: Mapping[str, str],
    runner: Optional[Callable[..., Any]] = None,
    timeout_s: float = LIVE_PROBE_TIMEOUT_S,
) -> SignInState:
    """The fallback: one `hermes -z hello`, bounded, output discarded.

    It costs one model turn, which is why it only runs when the offline read
    could not be done. A timeout or a spawn failure is ``UNKNOWN``, never "not
    signed in".
    """
    run = subprocess.run if runner is None else runner
    try:
        completed = run(
            [hermes_bin, *LIVE_PROBE_ARGS],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            env=dict(env),
        )
    except Exception:  # noqa: BLE001 - timeout or spawn failure: no verdict
        return SignInState(UNKNOWN, reason="probe-inconclusive")
    code = getattr(completed, "returncode", None)
    answered = bool(str(getattr(completed, "stdout", "") or "").strip())
    if code == 0 and answered:
        return SignInState(SIGNED_IN, reason="probe-answered")
    return SignInState(NOT_SIGNED_IN, reason="probe-failed")


def check_signed_in(
    hermes_home: Optional[Path],
    *,
    env: Mapping[str, str],
    hermes_bin: str,
    runner: Optional[Callable[..., Any]] = None,
    in_process: Callable[[], SignInState] = check_in_process,
) -> SignInState:
    """Is a model signed in and selected for the home the ladder is setting up?"""
    if not _same_path(_process_hermes_home(env), hermes_home):
        return SignInState(UNKNOWN, reason="other-home")
    state = in_process()
    if state.verdict == UNKNOWN and state.reason == "unreadable":
        probe_env = dict(env)
        if hermes_home is not None:
            probe_env["HERMES_HOME"] = str(hermes_home)
        return probe_live(hermes_bin=hermes_bin, env=probe_env, runner=runner)
    return state


# -- running a command with the terminal handed over --------------------------


def _fileno(stream: Any) -> Optional[int]:
    try:
        return int(stream.fileno())
    except Exception:  # noqa: BLE001 - a stream with no descriptor inherits
        return None


def run_interactive(
    argv: Sequence[str],
    *,
    env: Mapping[str, str],
    stream_in: Any = None,
    stream_out: Any = None,
) -> Optional[int]:
    """Run one command with the user's terminal, never capturing a byte.

    The ladder's own streams are passed through when they are real descriptors
    (under ``--json`` the ladder writes to stderr, and the child must too, or
    its output would land in the JSON document). Nothing is captured, so the
    sign-in link and code reach the screen and nowhere else.
    """
    kwargs: dict = {"env": dict(env), "check": False}
    in_fd = _fileno(stream_in)
    out_fd = _fileno(stream_out)
    if in_fd is not None:
        kwargs["stdin"] = in_fd
    if out_fd is not None:
        kwargs["stdout"] = out_fd
    try:
        # Our own lines first, so "Running: ..." is above the child's output.
        if stream_out is not None:
            stream_out.flush()
    except Exception:  # noqa: BLE001
        pass
    try:
        completed = subprocess.run(list(argv), **kwargs)
    except OSError:
        return None
    return int(getattr(completed, "returncode", 1))


# -- the chooser --------------------------------------------------------------

#: The step's outcomes, for the journal's closed vocabulary.
OUTCOME_SIGNED_IN = "model-signed-in"
OUTCOME_SKIPPED = "model-sign-in-skipped"
OUTCOME_MANUAL = "model-sign-in-manual"
OUTCOME_FAILED = "model-sign-in-failed"
JOURNAL_DETAILS = frozenset(
    {OUTCOME_SIGNED_IN, OUTCOME_SKIPPED, OUTCOME_MANUAL, OUTCOME_FAILED}
)


@dataclass(frozen=True)
class SignInOutcome:
    #: ``None`` when nothing was needed; otherwise one of the OUTCOME_ words.
    outcome: Optional[str]
    #: True when the ladder must stop here.
    stop: bool = False
    failed: bool = False


def _say_manual(
    say: Callable[[str], None], *, model_only: bool, lead: str = MANUAL_LEAD
) -> None:
    if model_only:
        say(f"  {MANUAL_MODEL_LEAD}")
        say(f"    {command_text(MODEL_ARGS)}")
        return
    say(f"  {lead}")
    width = max(len(command) for command, _label in MANUAL_ROWS)
    for command, label in MANUAL_ROWS:
        say(f"    {command.ljust(width)}   {label}")


def run_sign_in(
    state: SignInState,
    *,
    say: Callable[[str], None],
    choose: Optional[Callable[..., Optional[str]]],
    interactive: bool,
    run_command: Callable[[Sequence[str]], Optional[int]],
    recheck: Callable[[], SignInState],
) -> SignInOutcome:
    """Ask which account, run its commands, and check again.

    ``interactive`` is False under ``--yes`` or without a real terminal: the
    step then prints what is needed and the ladder carries on. ``run_command``
    takes the arguments after `hermes`.
    """
    if state.verdict in (SIGNED_IN, UNKNOWN):
        return SignInOutcome(None)
    model_only = state.verdict == NO_MODEL
    if not interactive or choose is None:
        say(f"  {NO_MODEL_LINE if model_only else NOT_SIGNED_IN_LINE}")
        _say_manual(say, model_only=model_only, lead=SKIP_LEAD)
        say(f"  {SKIPPED_LINE}")
        return SignInOutcome(OUTCOME_SKIPPED)

    if model_only:
        say(f"  {NO_MODEL_LINE}")
        commands: Tuple[Tuple[str, ...], ...] = (MODEL_ARGS,)
    else:
        question = [f"  {NOT_SIGNED_IN_QUESTION}"] + [
            f"    {key}  {label}" for key, label, _commands in CHOICES
        ]
        valid = [key for key, _label, _commands in CHOICES]
        picked: Optional[str] = None
        for _attempt in range(MAX_CHOICE_ATTEMPTS):
            answer = choose(question, question=f"  {CHOOSE_PROMPT}", choices=valid)
            if answer is None:
                # No answer at all (EOF, a closed terminal): nothing ran.
                break
            if answer in valid:
                picked = answer
                break
            question = [f"  {INVALID_CHOICE_LINE}"]
        if picked is None or picked == CHOICE_MYSELF:
            _say_manual(say, model_only=False)
            return SignInOutcome(OUTCOME_MANUAL, stop=True)
        commands = next(cmds for key, _label, cmds in CHOICES if key == picked)

    for args in commands:
        say(f"  {RUNNING_PREFIX}{command_text(args)}")
        code = run_command(args)
        if code != 0:
            say(f"  {COMMAND_FAILED_LINE.format(command=command_text(args))}")
            return SignInOutcome(OUTCOME_FAILED, stop=True, failed=True)

    after = recheck()
    if after.verdict in (NOT_SIGNED_IN, NO_MODEL):
        say(f"  {STILL_NOT_SIGNED_IN_LINE}")
        return SignInOutcome(OUTCOME_FAILED, stop=True, failed=True)
    say(f"  {SIGNED_IN_LINE}")
    return SignInOutcome(OUTCOME_SIGNED_IN)


__all__ = [
    "CHOICES",
    "JOURNAL_DETAILS",
    "NOT_SIGNED_IN",
    "NO_MODEL",
    "SIGNED_IN",
    "UNKNOWN",
    "SignInOutcome",
    "SignInState",
    "check_in_process",
    "check_signed_in",
    "command_text",
    "probe_live",
    "run_interactive",
    "run_sign_in",
]
