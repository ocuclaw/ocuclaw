"""The model check for the Cloudways ladder, right after step 1 (#3482).

Before this, neither ladder asked whether the agent could answer at all. A
fresh Cloudways agent created with no provider would walk all eight steps and
fail at the first message, and the only hint was `hermes model` in an error.

#6361 · the Cloudways panel's own OpenAI sign-in (LLM & Channels → OAuth →
OpenAI → Connect) gives a working agent, so the step is a check and setup
never signs in itself. Each Connect restarts the container, so setup neither
starts one nor runs through one: with no model it names the panel path and
stops, and the same command run afterwards reads the model as signed in and
carries on. That is the same under ``--yes``: the restart has to come before
setup changes anything.

Two halves, and they stay apart:

* :func:`check_signed_in` answers "is a model signed in and selected?" with no
  model call. It reads Hermes's own config and credential stores in this
  process: ``model.provider`` (or Hermes's own "auto" resolution), then
  ``hermes_cli.models_detect.provider_has_credentials`` (the model switcher's
  own check: env or .env key, auth-store login, credential pool), then a
  selected model name. Only when those internals cannot be read at all does it
  fall back to a live ``hermes -z`` probe, with a short timeout. It is a fact
  about the box, apart from any printing.
* :func:`run_sign_in` turns that answer into the step's lines and outcome.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence

# -- verdicts -----------------------------------------------------------------

SIGNED_IN = "signed-in"
NOT_SIGNED_IN = "not-signed-in"
#: Signed in to a provider, but no model is selected.
NO_MODEL = "no-model"
#: Could not tell. The ladder says nothing and carries on: a wrong "not signed
#: in" would stop a working agent at a sign-in it does not need.
UNKNOWN = "unknown"

#: The live probe's bound. A signed-in model answers `hello` well inside this; a
#: probe that has not answered by then is not evidence either way.
LIVE_PROBE_TIMEOUT_S = 45.0

# -- the commands -------------------------------------------------------------

#: `hermes model` chooses the model for a provider already signed in.
MODEL_ARGS = ("model",)
LIVE_PROBE_ARGS = ("-z", "hello")

# -- the words ----------------------------------------------------------------

#: Word for word OpenClaw's MODEL_PANEL_SIGN_IN_LINES (cloudways-setup.ts),
#: which Speck reads on both ladders. The setup command goes under them.
PANEL_PATH = "LLM & Channels → OAuth → OpenAI → Connect"
#: That Connect signs in to ChatGPT with a link and a one-time code, which
#: ChatGPT refuses until the account's "Enable device code sign-in" switch is on
#: (Settings → Security and login → App security). Off, OpenAI only says so
#: after account picking and MFA loops (openai/codex#34817).
CHATGPT_DEVICE_CODE_LINE = (
    "Using ChatGPT? First turn on device code sign-in in ChatGPT: Settings → Security and login."
)
PANEL_SIGN_IN_LINES = (
    "No model is signed in yet. Sign in to OpenAI in the Cloudways panel:",
    f"  {PANEL_PATH}",
    CHATGPT_DEVICE_CODE_LINE,
    "Your agent restarts after that. It can take a few minutes.",
    "When it is back, run this again:",
)
NO_MODEL_LINE = "A model account is signed in, but no model is selected yet."
MANUAL_MODEL_LEAD = "To choose a model, run this, then run setup again:"


def command_text(args: Sequence[str]) -> str:
    """What the user is shown and would type: `hermes`, never an install path."""
    return " ".join(("hermes", *args))


def panel_sign_in_lines(command: str) -> Sequence[str]:
    """The panel lines, then ``command`` (the setup command) under them."""
    return (*PANEL_SIGN_IN_LINES, f"  {command}")


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


# -- the step -----------------------------------------------------------------

#: The step's outcomes, for the journal's closed vocabulary.
#: Nobody is signed in: the panel's sign-in comes first.
OUTCOME_PANEL = "model-sign-in-panel"
#: Signed in, but no model chosen: `hermes model` comes first.
OUTCOME_NO_MODEL = "model-sign-in-no-model"
JOURNAL_DETAILS = frozenset({OUTCOME_PANEL, OUTCOME_NO_MODEL})


@dataclass(frozen=True)
class SignInOutcome:
    #: ``None`` when nothing was needed; otherwise one of the OUTCOME_ words.
    outcome: Optional[str]
    #: True when the ladder must stop here.
    stop: bool = False


def run_sign_in(
    state: SignInState,
    *,
    say: Callable[[str], None],
    rerun_command: str,
) -> SignInOutcome:
    """Say what the check found, and whether the ladder stops.

    Signed in, or no way to tell: nothing is said and the ladder carries on.
    Otherwise the lines name what to do first, end with ``rerun_command``, and
    the ladder stops. Nothing is run here.
    """
    # A check that answers nothing usable is "could not tell".
    verdict = getattr(state, "verdict", UNKNOWN)
    if verdict not in (NOT_SIGNED_IN, NO_MODEL):
        return SignInOutcome(None)
    if verdict == NO_MODEL:
        say(f"  {NO_MODEL_LINE}")
        say(f"  {MANUAL_MODEL_LEAD}")
        say(f"    {command_text(MODEL_ARGS)}")
        return SignInOutcome(OUTCOME_NO_MODEL, stop=True)
    for line in panel_sign_in_lines(rerun_command):
        say(f"  {line}")
    return SignInOutcome(OUTCOME_PANEL, stop=True)


__all__ = [
    "JOURNAL_DETAILS",
    "NOT_SIGNED_IN",
    "NO_MODEL",
    "OUTCOME_NO_MODEL",
    "OUTCOME_PANEL",
    "PANEL_PATH",
    "PANEL_SIGN_IN_LINES",
    "SIGNED_IN",
    "UNKNOWN",
    "SignInOutcome",
    "SignInState",
    "check_in_process",
    "check_signed_in",
    "command_text",
    "panel_sign_in_lines",
    "probe_live",
    "run_sign_in",
]
