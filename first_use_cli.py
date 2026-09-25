"""`hermes ocuclaw first-use` — the first message check, from a terminal (#3099).

A thin wrapper over the Hermes First-Run Proof machinery in :mod:`first_run`.
It owns no state of its own and adds no gateway RPC: the gateway already writes
the phone-turn candidate, the reply-delivery observation and the attempt as
durable, profile-scoped receipts, and this verb reads them.

Two things this module must never blur, both inherited from
``CONTEXT.md → Hermes First-Run Proof``:

* The evidence discriminator. The originating phone reporting that the glasses
  SDK accepted the exact committed reply is **machine** evidence. It arms the
  attempt with ``client_sdk_receipt`` and nothing here words it, records it, or
  counts it as the wearer having seen anything.
* The welcome. Arming is not completion. Only the gateway's Hermes Welcome
  Round Trip commits Hermes First-Run Proof, so this verb hands the wearer off
  to the double-tap and reports, it never claims the commit itself.

Every collaborator is injectable in the same shape as :func:`pairing.run_pair`,
so the whole surface — the TTY gate, the wording, the waits, the exit code —
runs in tests exactly as it runs against a real host, and so the Cloudways
ladder (#3105) can drive this same entry function as its step 8.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, TextIO

from . import setup_hint
from .terminal_output import styled
from .first_run import (
    FIRST_RUN_WAIT_POLL_SECONDS,
    PHONE_ORIGIN_WAIT_SECONDS,
    REPLY_DELIVERY_ERRORED_RUN_REASONS,
    REPLY_DELIVERY_SDK_ACCEPTED,
    REPLY_DELIVERY_WAIT_SECONDS,
    REPLY_EVIDENCE_CLIENT_SDK_RECEIPT,
    REPLY_EVIDENCE_WEARER_CONFIRMED,
    WELCOME_ROUND_TRIP_WAIT_SECONDS,
    arm_first_run_proof_from_candidate,
    inspect_attempt,
    wait_for_first_run_terminal,
    wait_for_phone_turn_candidate,
    wait_for_reply_delivery,
)
from .receipts import read_gateway_state

# -- exit codes, shared with `pair` (#1273 §10) -------------------------------

EXIT_OK = 0
EXIT_PROBLEM = 1
EXIT_USAGE = 2

#: The exact text the wearer is asked to send. One word, so a phone keyboard
#: cannot turn it into a different turn by autocorrect.
FIRST_USE_SEND_TEXT = "hello"

PROMPT_TEXT = "Did the reply appear on your Even G2? [yes/no]: "

#: The hand-off to the wearer's double-tap. Shared with the OpenClaw ladder and
#: printed byte for byte there, so the two never drift.
WELCOME_HANDOFF_MESSAGE = (
    "Double-tap the welcome on your glasses to finish."
)

#: Said once setup is complete. Three lines, one sentence each, so none wraps
#: mid-word in a 100-column terminal. Byte for byte the OpenClaw first-use
#: verb's OPTIONAL_SETUP_HANDOFF_LINES.
OPTIONAL_SETUP_HANDOFF_LINES = (
    "Optional: on your phone, the Optional setup card on Home offers voice and Even AI.",
    "You can also reach them later under Settings > Voice and Settings > Defaults > Even AI.",
    "Choose what you want, or leave it for later.",
)

#: The one fixed "setup complete" line (#3524). The terminal verb prints it and
#: the host setup tool returns it as the first `say` line of a committed
#: Welcome Round Trip, so no skill text carries a competing version.
SETUP_COMPLETE_LINE = "OcuClaw setup is complete for this Hermes profile."

#: One sentence per reply-evidence kind. An SDK receipt is never worded as the
#: wearer seeing the reply.
REPLY_EVIDENCE_SAY_LINES: Dict[str, str] = {
    REPLY_EVIDENCE_WEARER_CONFIRMED: (
        "You confirmed the reply appeared on your glasses, and your welcome "
        "double-tap came back."
    ),
    REPLY_EVIDENCE_CLIENT_SDK_RECEIPT: (
        "Your phone reported SDK acceptance of the reply, and your welcome "
        "double-tap came back."
    ),
}


def setup_complete_say_lines(reply_evidence: Optional[str] = None) -> List[str]:
    """The lines a committed setup says, in order (#3524).

    The fixed complete line, one evidence sentence when the evidence kind is
    known, then the shared optional-setup handoff. Byte for byte the same
    handoff the OpenClaw first-use result carries.
    """
    lines = [SETUP_COMPLETE_LINE]
    evidence = REPLY_EVIDENCE_SAY_LINES.get(str(reply_evidence or ""))
    if evidence:
        lines.append(evidence)
    lines.extend(OPTIONAL_SETUP_HANDOFF_LINES)
    return lines

# -- one line per attempt state -----------------------------------------------
#
# Total by construction: `_attempt_line` falls back to a state-naming line, so
# a state this build has never seen still gets one plain sentence instead of
# silence. `committed` names Hermes Core Setup Completion, because that is the
# milestone the user has actually reached.

ATTEMPT_STATE_LINES: Dict[str, str] = {
    "committed": (
        SETUP_COMPLETE_LINE + "\n"
        "First message and welcome double-tap confirmed."
    ),
    "armed": (
        "First message recorded for this profile.\n"
        "Double-tap the welcome on your glasses to finish."
    ),
    "missing": "No first message is recorded for this Hermes profile yet.",
    "expired": (
        "The last first-message attempt expired after its hour, so this starts "
        "a new one."
    ),
    "bundle_changed": (
        "OcuClaw or Hermes changed since the last first-message attempt, so "
        "this starts a new one."
    ),
    # No `session_changed` line. `inspect_attempt` only compares the session
    # when it is handed the paired phone's session key, and that key lives in
    # the gateway process (session_status.py holds it in memory); no durable
    # receipt carries it — the phone-turn candidate stores a fingerprint, not
    # the key. So this verb passes None, the comparison is skipped, and the
    # state is unreachable from here. It stays the gateway's to observe, and
    # `_attempt_line` still renders one plain sentence if it ever arrives.
    # #3242: the credential is an internal object users never see, so this says
    # what actually happened to them — every phone was disconnected.
    "credential_generation_changed": (
        "Every phone was disconnected from this server since the last "
        "first-message attempt, so this starts a new one."
    ),
    "pairing_completion_changed": (
        "This phone was paired again since the last first-message attempt, so "
        "this starts a new one."
    ),
    "failed": (
        "The welcome double-tap failed twice on the last attempt, so this "
        "starts a new one."
    ),
    "wrong_profile": (
        "The saved first-message attempt belongs to a different Hermes "
        "profile, so this starts a new one."
    ),
    "malformed": (
        "The saved first-message attempt could not be read, so this starts a "
        "new one."
    ),
    "unreadable": (
        "The saved first-message attempt could not be read, so this starts a "
        "new one."
    ),
    "timeout": "The welcome double-tap has not arrived yet.",
    "unavailable": (
        "This Hermes profile could not be resolved, so the first message "
        "cannot be recorded."
    ),
    "proof_unavailable": (
        "Could not read the saved first-message check for this Hermes profile.\n"
        "The new first message was not recorded."
    ),
    "bundle_unavailable": (
        "The OcuClaw and Hermes versions could not be read, so a first-message "
        "attempt cannot be started."
    ),
}

#: States that end the run. Everything else that is neither `committed` nor
#: `armed` describes a checkpoint a newly confirmed phone turn simply replaces,
#: which is exactly what `arm_first_run_proof_from_candidate` does under the
#: state lock — so those say their line and carry on.
BLOCKING_ATTEMPT_STATES = frozenset(
    {"unavailable", "proof_unavailable", "bundle_unavailable"}
)

#: Why the phone reported no usable glasses SDK receipt. One line each, so the
#: wearer is never asked a question without being told why it is being asked.
REPLY_DELIVERY_REASON_LINES: Dict[str, str] = {
    "simulator_lane_not_eligible": (
        "That reply was accepted on the simulator lane, which never evidences "
        "a real installation."
    ),
    # #3242: same rule — name the phone, not the credential behind it.
    "binding_changed": (
        "This phone's connection to this server changed while that reply was "
        "in flight, so its receipt no longer describes this installation."
    ),
    "wait_timeout": (
        "The phone did not report a glasses SDK receipt for that reply in time."
    ),
}

#: #3232. The agent's run errored, so what reached the glasses was the model's
#: error text, not a reply. Nothing here is a glasses problem, an OcuClaw
#: problem or something a wearer can confirm, so the attempt is neither armed
#: nor completed: the user fixes the model and runs the same command again.
#: F21 (#3348). The verdict, and it is a verdict about TWO things at once.
#: Everything OcuClaw installs was proven by this attempt — the phone reached
#: the agent and the agent's text reached the glasses — and the one thing that
#: failed is the model. Saying only "your model errored" left the #3348 run
#: unable to tell whether the install had worked at all.
ERRORED_RUN_VERDICT = (
    "Your message reached your agent and its reply reached your glasses, but "
    "the model returned an error instead of an answer. OcuClaw is installed; "
    "setup is not complete."
)

#: #3392. The verdict names WHICH failure it was and its fix, in one line after
#: the lead above. The same lines as the OpenClaw lane (first-use-wait.ts),
#: with this engine's own commands. The login command is provider-neutral:
#: nothing here knows which provider the model config names.
ERRORED_RUN_RETRY_COMMAND = "hermes ocuclaw first-use"
MODEL_LOGIN_COMMAND = "hermes model"
MODEL_CHECK_COMMAND = "hermes -z hello"

#: A closed vocabulary, shared with the OpenClaw lane and the phone's labels.
PROVIDER_ERROR_CLASSES = ("auth", "quota", "rate_limit", "overloaded", "model_error")
_PROVIDER_ERROR_CODE_CLASSES: Dict[str, str] = {
    "provider_auth_invalid": "auth",
    "provider_quota_exhausted": "quota",
    "provider_rate_limited": "rate_limit",
    "provider_unavailable": "overloaded",
    "provider_overloaded": "overloaded",
    "provider_timeout": "overloaded",
    # The narrowed delivery reason, for a candidate that carries no code.
    "reply_run_rate_limited": "rate_limit",
}


def provider_error_class(code: Optional[str], reason: Optional[str] = None) -> str:
    """The failure class from the run's code, else the delivery reason."""

    for value in (code, reason):
        known = _PROVIDER_ERROR_CODE_CLASSES.get(str(value or ""))
        if known is not None:
            return known
    return "model_error"


def provider_error_class_line(error_class: str) -> str:
    retry = ERRORED_RUN_RETRY_COMMAND
    if error_class == "auth":
        return (
            "The model provider rejected the sign-in. Sign in to the model "
            f"again (`{MODEL_LOGIN_COMMAND}`), then run {retry} and send a "
            "fresh message."
        )
    if error_class == "quota":
        return (
            "The model account is out of quota or has a billing problem. "
            "Check the plan or billing for this model, then run "
            f"{retry} and send a fresh message."
        )
    if error_class == "rate_limit":
        return (
            "The model is rate limiting this account. Wait for the limit to "
            f"reset or choose another model, then run {retry} and send a "
            "fresh message."
        )
    return (
        "The model provider failed or is busy. Try again in a minute, or "
        f"check the model itself (`{MODEL_CHECK_COMMAND}`), then run {retry}."
    )


def errored_run_verdict(code: Optional[str], reason: Optional[str] = None) -> str:
    """The lead plus the one class line: printed as one line."""

    line = provider_error_class_line(provider_error_class(code, reason))
    return f"{ERRORED_RUN_VERDICT} {line}"

GATEWAY_NOT_RUNNING_LINES = (
    "No running Hermes gateway could be confirmed for this profile, so nothing "
    "can record your first message.",
    "Check it with `hermes gateway status`, start it, then run `hermes ocuclaw "
    "first-use` again.",
)

# THE TTY GATE, exactly as `pair` states it. Wearer confirmation is a human
# answer about a physical display; there is deliberately no non-interactive way
# to give it, and a pipe must not be handed a quiet default-yes.
NO_TERMINAL_LINES = (
    "hermes ocuclaw first-use needs an interactive terminal to ask whether the "
    "reply appeared on your Even G2.",
    "",
    "The phone reported no glasses SDK receipt for that reply, so the only "
    "remaining evidence is a human answer, and there is deliberately no way to "
    "answer that without a terminal.",
    "Both the question and the answer must go through it, so this also refuses "
    "when the output is redirected or piped.",
    "Run this command directly in a terminal on this computer.",
)


def _attempt_line(state: str) -> str:
    known = ATTEMPT_STATE_LINES.get(state)
    if known is not None:
        return known
    return f"The first-message attempt is in an unexpected state ({state})."


def _gateway_running(home: Optional[Path]) -> bool:
    """Whether a live gateway process owns this profile's receipt.

    Positive evidence only: the receipt is readable AND its recorded PID still
    validates. A missing receipt means no gateway has ever started on this
    profile. Unknown liveness is refused too, which is the opposite of the
    `gatewayLive is not False` reading `uninstall` uses — deliberately, because
    the two verbs are asking opposite questions. `uninstall` must not delete
    state under a gateway that might be alive; this verb must not spend three
    minutes waiting for receipts that only a live gateway writes.

    Unknown is a broken environment, not the normal case: `read_gateway_state`
    only reports it when `gateway.status.runtime_status_pid_is_live` cannot be
    imported, and that module ships in the Hermes package the CLI itself runs
    inside (`gateway/status.py:865` at the 0.21.1 floor), so a healthy host
    always answers True or False.
    """

    record, status, live = read_gateway_state(home=home)
    if status != "ok" or record is None:
        return False
    return live is True


def gateway_running(home: Optional[Path] = None) -> bool:
    """The positive-liveness read above, under a name other modules may use.

    The Cloudways ladder's step 7 asks the same question before it starts a
    pairing ceremony, and must get the same answer for the same reason: only a
    running gateway completes a pairing, and only ``live is True`` counts.
    """

    return _gateway_running(home)


def _default_versions() -> Dict[str, Optional[str]]:
    # Imported here so wiring the subparser does not drag the health collector
    # into every `hermes` invocation.
    from .health import CERTIFIED_HERMES_TAG, hermes_version, ocuclaw_version

    return {
        "hermes_release": CERTIFIED_HERMES_TAG,
        "hermes_package_version": hermes_version() or None,
        "ocuclaw_version": ocuclaw_version(),
    }


def _read_yes(stdin: TextIO) -> bool:
    """Read the wearer's one answer. Anything but a whole "yes" records nothing.

    Asked once, deliberately: this question is the wearer's own observation,
    and re-asking it until it produces a "yes" is how a nudge becomes an
    answer. Only the whole word counts, for the reason `pair` gives — a single
    keystroke is too easy to fire off at a prompt nobody read.
    """

    try:
        line = stdin.readline()
    except (KeyboardInterrupt, EOFError):
        return False
    return line.strip().lower() == "yes"


def run_first_use(
    *,
    stdin: Optional[TextIO] = None,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
    home: Optional[Path] = None,
    wait_seconds: float = PHONE_ORIGIN_WAIT_SECONDS,
    reply_wait_seconds: float = REPLY_DELIVERY_WAIT_SECONDS,
    welcome_wait_seconds: float = WELCOME_ROUND_TRIP_WAIT_SECONDS,
    poll_seconds: float = FIRST_RUN_WAIT_POLL_SECONDS,
    isatty_fn: Optional[Callable[[], bool]] = None,
    now_fn: Optional[Callable[[], datetime]] = None,
    versions_fn: Optional[Callable[[], Mapping[str, Optional[str]]]] = None,
    gateway_running_fn: Optional[Callable[[], bool]] = None,
    line_fn: Optional[Callable[[str], None]] = None,
    prompt_fn: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """Run one first-message check. Returns exit code, lines and the record.

    The dict is the contract the Cloudways ladder (#3105) consumes as its step
    8: ``exitCode`` is the process exit code, ``lines`` is everything shown in
    order, and ``record`` names the outcome and — the part that must never be
    guessed by a later reader — which evidence armed the attempt.
    """

    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    inp = sys.stdin if stdin is None else stdin
    now_fn = (lambda: datetime.now(timezone.utc)) if now_fn is None else now_fn
    versions_fn = _default_versions if versions_fn is None else versions_fn
    if gateway_running_fn is None:

        def gateway_running_fn() -> bool:  # type: ignore[misc]
            return _gateway_running(home)

    if isatty_fn is None:

        def isatty_fn() -> bool:  # type: ignore[misc]
            # BOTH streams, for `pair`'s reason: the question has to reach a
            # human on the same terminal that carries the answer back.
            try:
                return bool(inp.isatty()) and bool(out.isatty())
            except Exception:  # noqa: BLE001 - an unaskable stream is not a TTY
                return False

    lines: List[str] = []
    record: Dict[str, Any] = {
        "outcome": "failed",
        "attemptState": None,
        "replyEvidence": None,
        "replyDelivery": None,
        "wearerAsked": False,
        # F21 (#3348). Always present, so a reader never has to tell "no
        # provider error" apart from "this build does not report one".
        "replyWasProviderError": False,
        # #3392. One of PROVIDER_ERROR_CLASSES when the model failed, else None.
        "providerErrorClass": None,
    }

    def say(text: str = "") -> None:
        lines.append(text)
        if line_fn is not None:
            line_fn(text)
        else:
            out.write(text + "\n")
            out.flush()

    def ask(text: str) -> None:
        # The one line with no newline of its own: the answer is typed on it.
        # A caller that renders the other lines itself must say how to render
        # THIS one too, or the question loses the thing that makes it a
        # question; `prompt_fn` is that seam, and `line_fn` alone behaves as
        # it always has.
        lines.append(text)
        hook = prompt_fn if prompt_fn is not None else line_fn
        if hook is not None:
            hook(text)
        else:
            out.write(styled(text, out, role="prompt"))
            out.flush()

    def problem(*texts: str, outcome: str = "failed", code: int = EXIT_PROBLEM):
        for text in texts:
            lines.append(text)
            if line_fn is not None:
                line_fn(text)
            else:
                err.write(text + "\n")
                err.flush()
        record["outcome"] = outcome
        return {"exitCode": code, "lines": lines, "record": record}

    def done(code: int, outcome: str) -> Dict[str, Any]:
        if code == EXIT_OK and outcome == "committed":
            for line in OPTIONAL_SETUP_HANDOFF_LINES:
                say(line)
        record["outcome"] = outcome
        return {"exitCode": code, "lines": lines, "record": record}

    # 1. The gateway, first and cheaply. Only the gateway writes the receipts
    # every later step reads, so without one this is a long wait for nothing.
    if not gateway_running_fn():
        record["attemptState"] = "gateway_not_running"
        return problem(*GATEWAY_NOT_RUNNING_LINES, outcome="refused")

    versions = dict(versions_fn())

    # 2. The resumable checkpoint, read without mutating it.
    attempt = inspect_attempt(home=home, now=now_fn(), session_key=None, **versions)
    state = str(attempt.get("state") or "unavailable")
    record["attemptState"] = state
    if state != "missing":
        say(_attempt_line(state))
    if attempt.get("committed") is True:
        record["replyEvidence"] = attempt.get("replyEvidence")
        return done(EXIT_OK, "committed")
    if state in BLOCKING_ATTEMPT_STATES:
        return done(EXIT_PROBLEM, "refused")

    if state == "armed":
        # A rerun inside the hour picks the same attempt up: nothing is rearmed
        # and no second message is asked for.
        record["replyEvidence"] = attempt.get("replyEvidence")
        return _await_welcome(
            home=home,
            versions=versions,
            welcome_wait_seconds=welcome_wait_seconds,
            poll_seconds=poll_seconds,
            say=say,
            done=done,
            record=record,
            announce_handoff=True,
        )

    # 3. Ask for the message, and hold the phone's hint for exactly this wait.
    say("")
    # #3348 H9 turned out to be a stale busy flag on the phone (fixed in the
    # relay and app), not the conversation choice, so the plain OpenClaw wording
    # stands: asking for a new conversation only confused people.
    say(f"In the paired conversation on your phone, send {FIRST_USE_SEND_TEXT}.")
    say("Waiting for the reply on your glasses…")

    started_at = now_fn()
    with setup_hint.awaiting_first_reply(home=home):
        candidate = wait_for_phone_turn_candidate(
            home=home,
            not_before=started_at,
            timeout_seconds=wait_seconds,
            poll_seconds=poll_seconds,
        )
    if candidate.get("received") is not True:
        candidate_state = str(candidate.get("state") or "unavailable")
        record["attemptState"] = f"phone_turn_{candidate_state}"
        if candidate_state == "timeout":
            return problem(
                "No message arrived from the phone within "
                f"{int(wait_seconds)} seconds.",
                "Send it, then run `hermes ocuclaw first-use` again.",
            )
        return problem(
            "The phone-turn receipt could not be read "
            f"({candidate_state}), so the first message cannot be confirmed.",
        )

    candidate_id = str(candidate.get("candidateId") or "")

    # 4. The machine evidence, if the phone reported any for THIS turn.
    delivery = wait_for_reply_delivery(
        home=home,
        candidate_id=candidate_id,
        timeout_seconds=reply_wait_seconds,
        poll_seconds=poll_seconds,
    )
    record["replyDelivery"] = {
        "status": delivery.get("status"),
        "reason": delivery.get("reason"),
        "lane": delivery.get("lane"),
    }
    delivery_reason = str(delivery.get("reason") or "")
    # #3468. The adapter's code on the candidate is enough on its own: the
    # arm refuses it anyway, so asking the wearer first would be a lie.
    if delivery_reason in REPLY_DELIVERY_ERRORED_RUN_REASONS or candidate.get(
        "runErrorCode"
    ):
        # Checked BEFORE the accepted branch on purpose: an errored run still
        # paints its error text, so a receipt for it must never read as the
        # first message going through. Nothing is armed and nothing is
        # recorded, so a later rerun is a clean first message.
        record["attemptState"] = "reply_run_errored"
        # F21 (#3348). The chain is proven; the model is not. Derived here
        # rather than stored, exactly like the OpenClaw lane's field.
        record["replyWasProviderError"] = True
        # #3392. The adapter's code for this run rides on the candidate; the
        # delivery reason is the fallback when it does not.
        run_error_code = candidate.get("runErrorCode")
        record["providerErrorClass"] = provider_error_class(
            run_error_code, delivery_reason
        )
        return problem(
            errored_run_verdict(run_error_code, delivery_reason),
            outcome="refused",
        )
    if delivery.get("status") == REPLY_DELIVERY_SDK_ACCEPTED:
        # Machine evidence. Worded as what it is and nothing more: the phone's
        # SDK accepted the reply. Not "you saw it", not "the wearer confirmed".
        say(
            "Your phone reported SDK acceptance of the reply."
        )
        reply_evidence = REPLY_EVIDENCE_CLIENT_SDK_RECEIPT
    else:
        say(
            REPLY_DELIVERY_REASON_LINES.get(
                delivery_reason,
                "The phone reported no glasses SDK receipt for that reply.",
            )
        )
        if not isatty_fn():
            record["attemptState"] = "wearer_confirmation_required"
            return problem(*NO_TERMINAL_LINES, outcome="refused", code=EXIT_USAGE)
        record["wearerAsked"] = True
        ask(PROMPT_TEXT)
        if not _read_yes(inp):
            return problem(
                "Nothing was recorded, because the reply was not confirmed on "
                "your Even G2.",
                "Run `hermes ocuclaw doctor` if the reply never appears.",
            )
        reply_evidence = REPLY_EVIDENCE_WEARER_CONFIRMED

    # 5. Arm the attempt with the evidence that was actually produced.
    armed = arm_first_run_proof_from_candidate(
        home=home,
        now=now_fn(),
        expected_candidate_id=candidate_id,
        reply_evidence=reply_evidence,
        **versions,
    )
    armed_state = str(armed.get("state") or "unavailable")
    if armed.get("committed") is True:
        record["attemptState"] = "committed"
        record["replyEvidence"] = armed.get("replyEvidence") or reply_evidence
        say(_attempt_line("committed"))
        return done(EXIT_OK, "committed")
    if armed.get("armed") is not True:
        record["attemptState"] = armed_state
        if armed_state == "reply_run_errored":
            # #3468. The arm's own guard: the delivery reason landed after the
            # wait above ended. Same verdict, nothing recorded.
            record["replyWasProviderError"] = True
            record["providerErrorClass"] = provider_error_class(
                armed.get("runErrorCode"), armed.get("reason")
            )
            return problem(
                errored_run_verdict(armed.get("runErrorCode"), armed.get("reason")),
                outcome="refused",
            )
        if armed_state == "reply_evidence_unavailable":
            return problem(
                "The glasses SDK receipt for that reply is no longer usable, "
                "so the first message was not recorded.",
                "Send another message, then run `hermes ocuclaw first-use` "
                "again.",
            )
        if armed_state.startswith("phone_turn_"):
            return problem(
                "The phone sent another message while this was waiting, so "
                "that turn can no longer be recorded.",
                "Run `hermes ocuclaw first-use` again and send one message.",
            )
        if armed_state == "lock_unavailable":
            return problem(
                "Another OcuClaw process is writing this profile's first-run "
                "state. Run `hermes ocuclaw first-use` again in a moment.",
            )
        return problem(
            f"The first message was not recorded ({armed_state}).",
            "Run `hermes ocuclaw doctor` for the full diagnosis.",
        )

    record["attemptState"] = "armed"
    record["replyEvidence"] = armed.get("replyEvidence") or reply_evidence
    return _await_welcome(
        home=home,
        versions=versions,
        welcome_wait_seconds=welcome_wait_seconds,
        poll_seconds=poll_seconds,
        say=say,
        done=done,
        record=record,
        announce_handoff=True,
    )


def _await_welcome(
    *,
    home: Optional[Path],
    versions: Mapping[str, Optional[str]],
    welcome_wait_seconds: float,
    poll_seconds: float,
    say: Callable[..., None],
    done: Callable[[int, str], Dict[str, Any]],
    record: Dict[str, Any],
    announce_handoff: bool,
) -> Dict[str, Any]:
    """Hand the wearer off to the double-tap and report what the gateway did.

    Only the gateway commits Hermes First-Run Proof, so this waits and reports;
    a wait that runs out is an armed attempt handed off, not a failure, and the
    attempt stays resumable for the rest of its hour.
    """

    if announce_handoff:
        say("")
        # Byte-identical on the OpenClaw ladder: one sentence for what is about
        # to happen and one for what the double-tap does, because "dismiss the
        # welcome" never said where the wearer lands.
        say(WELCOME_HANDOFF_MESSAGE)

    terminal = wait_for_first_run_terminal(
        home=home,
        timeout_seconds=welcome_wait_seconds,
        poll_seconds=poll_seconds,
        **versions,
    )
    state = str(terminal.get("state") or "unavailable")
    record["attemptState"] = state
    if terminal.get("committed") is True:
        record["attemptState"] = "committed"
        record["replyEvidence"] = terminal.get("replyEvidence") or record.get(
            "replyEvidence"
        )
        say(SETUP_COMPLETE_LINE)
        return done(EXIT_OK, "committed")
    if state == "timeout":
        say(_attempt_line("timeout"))
        say(
            "The attempt stays armed for the rest of its hour: double-tap on "
            "your glasses, then run `hermes ocuclaw first-use` again."
        )
        return done(EXIT_OK, "armed")
    say(_attempt_line(state))
    say("Run `hermes ocuclaw first-use` again to start a new attempt.")
    return done(EXIT_PROBLEM, "failed")


__all__ = [
    "ATTEMPT_STATE_LINES",
    "EXIT_OK",
    "EXIT_PROBLEM",
    "EXIT_USAGE",
    "FIRST_USE_SEND_TEXT",
    "OPTIONAL_SETUP_HANDOFF_LINES",
    "PROMPT_TEXT",
    "REPLY_EVIDENCE_SAY_LINES",
    "SETUP_COMPLETE_LINE",
    "gateway_running",
    "run_first_use",
    "setup_complete_say_lines",
]
