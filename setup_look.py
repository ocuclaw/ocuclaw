"""Speck draws ``hermes ocuclaw cloudways setup`` in a terminal (``--look``).

The ladder is unchanged by a look: it writes the same lines, asks the same
questions and reads the same answers. A look sits between the ladder and the
terminal instead. It reads what the ladder writes into a small picture of
where setup is (:class:`SetupModel`) and draws that picture its own way:

``speck``
    "Code in the bubble" (Matt picked it, 2026-10-02). Speck, the glasses'
    character, says each step in a speech bubble. On the pairing screen he
    holds his phone and the bubble holds the code, big, with the countdown as
    its bottom border, over the phone's two choices. Through the agent restart
    he dozes over the link that reopens the terminal, he wakes on "Welcome
    back", your glasses answer in a bubble of their own at step 8, and the run
    ends on ALL SET! with confetti and his chequered flag.
``plain``
    Draws nothing: what the ladder writes reaches the terminal untouched,
    which is what ``--json``, pipes and the e2e driver read.

Speck is the default in the WebUI's ``/terminal`` (``HERMES_WEBUI_TERMINAL=1``)
and plain everywhere else; ``--look plain`` turns him off. A look also stands
down by itself whenever the input or the output is not a terminal.

The look redraws a block at the bottom of the terminal a dozen times a second,
never taller than the window, and only the rows that changed. Answers are
typed into that block: the terminal is put in cbreak mode, keys are read here,
and each finished line is handed to the ladder through a pipe, so a
``readline`` or a ``select`` on the ladder's input behaves as it would on the
terminal's own line discipline. Ctrl-C still reaches the ladder as SIGINT.
Each finished step is also printed above the block, once, in his words as the
bubble said them, so scrolling up never reads differently from him (Matt,
2026-10-03); a stop prints the step's own lines in full under the block, and
``--look plain`` prints setup's own words throughout.

Two rules keep the links clickable. No row at or below a link changes from
frame to frame (redrawing a row under the pointer makes the terminal forget
the link), and the restart screen's link block is its last four rows: when
the page drops, the WebUI's own two lines push the block up six rows and
exactly those four stay in view.
"""

from __future__ import annotations

import atexit
import base64
import codecs
import math
import os
import random
import re
import selectors
import signal
import threading
import time
import zlib
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

LOOKS = ("plain", "speck")
#: The look off the WebUI: plain.
DEFAULT_LOOK = "plain"
#: The look in the WebUI's /terminal panel.
WEBUI_LOOK = "speck"
#: The same choice as ``--look``, for an installer that cannot pass flags.
LOOK_ENV = "OCUCLAW_SETUP_LOOK"
#: Frames a second. The WebUI terminal keeps up with this at 88x10.
FPS = 12
#: Every step stays on screen at least this long: his landing tick, a glide and a
#: beat of the step's own move each get their moment (SpeckLook.POSE_MIN), so a
#: fast step never looks rushed or cut off mid-move.
MIN_STEP_SECONDS = 2.4
#: The welcome frame shows this long before step 1 is drawn.
INTRO_SECONDS = 2.4
#: A step's last line stays this long before the next step replaces it.
LINE_HOLD_SECONDS = 1.4
#: "Paired." stays longer, so his tick and thumbs up are seen before step 8.
PAIRED_HOLD_SECONDS = 3.4
#: A finished setup animates its ending this long before the block settles.
CELEBRATE_SECONDS = 2.5
#: The block is drawn whole at least this often, between row-by-row updates.
FULL_REDRAW_SECONDS = 2.0
STEP_COUNT = 8

#: What a step is about, in a person's words, while it runs.
FRIENDLY_TITLES = {
    0: "Now for your glasses",
    1: "Checking your server",
    2: "Your glasses settings",
    3: "Loading OcuClaw",
    4: "Tailscale",
    5: "Connecting to Tailscale",
    6: "A private route for your phone",
    7: "Pair your phone",
    8: "Say hi from your glasses",
}

#: Step 2 reads the agent's settings before it says a word, about 10 s on
#: Cloudways: what he says meanwhile, first time and back from the restart
#: (a default, 2026-10-03; Matt may reword it).
SETTINGS_WAIT = "Tuning a few settings…"
SETTINGS_RECHECK = "Checking your settings…"
#: A finished step's words, above the block, under its "✓ <title> · 1 of 8".
RECORD_INDENT = "  "

#: Setup's command, as the history and the carry-on line run it again.
RERUN_BASE = "hermes ocuclaw cloudways setup"


def default_look(env: Optional[Mapping[str, str]] = None) -> str:
    """Speck in the WebUI's /terminal, plain anywhere else (``None``: this process's env)."""
    from . import webui_terminal

    return WEBUI_LOOK if webui_terminal.active(env) else DEFAULT_LOOK


def resolve_look(flag: Optional[str], env: Optional[Mapping[str, str]] = None) -> str:
    """The look to use: the flag, else ``OCUCLAW_SETUP_LOOK``, else the default.

    An unknown name is the default, never an error: a look is decoration, and
    the ladder must run whatever an environment variable says.
    """
    env = os.environ if env is None else env
    fallback = default_look(env)
    for value in (flag, env.get(LOOK_ENV)):
        name = str(value or "").strip().lower()
        if name:
            return name if name in LOOKS else fallback
    return fallback


def rerun_command(look: Optional[str], env: Optional[Mapping[str, str]] = None) -> str:
    """The command that carries on after a restart, keeping the look."""
    if not look or look == default_look(env):
        return RERUN_BASE
    return f"{RERUN_BASE} --look {look}"


# -- text ---------------------------------------------------------------------

_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
_STEP = re.compile(r"^\[(\d+)/(\d+)\]\s+(.*)$")
_STEP_START = re.compile(r"\[(\d+)/(\d+)\]\s")
_URL = re.compile(r"https?://\S+")
#: The middle row of pairing.py's box round the four words, drawn in "│" or "|".
_WORDS_ROW = re.compile(r"^[│|]\s+(\S.*?)\s+[│|]$")
#: A numbered choice or step in the bubble: "1  ChatGPT subscription", "2. Sign in…".
_NUMBERED = re.compile(r"^(\d\.?) ")
#: A web address in words, with or without a path: ocuclaw.com/help, discord.ocuclaw.com.
_WEB_ADDRESS = re.compile(r"((?:[\w-]+\.)+(?:com|net|org|io|gg)(?:/\S*)?)")
#: The manual block's expiry line (#5485): "Expires in 4:59."
_EXPIRY_CLOCK = re.compile(r"^Expires in (\d+):(\d\d)\.?$")
_EXPIRY_NOTE = re.compile(r"expires? in \d+ (minute|second)s?\.?$")
_SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


def wrap(text: str, width: int) -> List[str]:
    """Word wrap; a word longer than the width is cut, never lost."""
    width = max(4, width)
    out: List[str] = []
    line = ""
    for word in text.split():
        while len(word) > width:
            if line:
                out.append(line)
                line = ""
            out.append(word[:width])
            word = word[width:]
        if not line:
            line = word
        elif len(line) + 1 + len(word) <= width:
            line += " " + word
        else:
            out.append(line)
            line = word
    if line:
        out.append(line)
    return out


def clip_ansi(text: str, width: int) -> str:
    """At most ``width`` visible characters; colour codes kept, never counted."""
    out: List[str] = []
    seen = 0
    at = 0
    for match in _ANSI.finditer(text):
        plain = text[at : match.start()]
        if seen + len(plain) > width:
            out.append(plain[: width - seen])
            return "".join(out) + "\x1b[0m"
        out.append(plain)
        seen += len(plain)
        out.append(match.group(0))
        at = match.end()
    plain = text[at:]
    if seen + len(plain) > width:
        return "".join(out) + plain[: width - seen] + "\x1b[0m"
    return "".join(out) + plain


def trunc(text: str, width: int) -> str:
    return text if len(text) <= width else text[: max(0, width - 1)] + "…"


def mmss(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def ease(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return 1 - (1 - x) ** 3


# -- what a line means ---------------------------------------------------------

#: Setup's own sentences, shortened for the bubble (35 columns at 88). ``None``
#: keeps a line out of the bubble and out of the steps above the block. A
#: replacement may use the pattern's groups (``\1``). Anything not listed is
#: shown as setup wrote it, so a new or an error message is never hidden.
_CONDENSED: Tuple[Tuple["re.Pattern[str]", Optional[str]], ...] = tuple(
    (re.compile(pattern), short)
    for pattern, short in (
        (r".* is a Cloudways Managed AI Agents container\.$", "Cloudways agent found."),
        (r"^Checking the model sign-in\.\.\.$", "Checking the model sign-in…"),
        # No model yet: the panel path and the command under these stay as
        # written (#6361, both ladders).
        (r"^No model is signed in yet\. Sign in to OpenAI in the Cloudways panel:$", "I need a model. In Cloudways, open:"),
        (r"^Using ChatGPT\? First turn on device code sign-in in ChatGPT: .*$", "ChatGPT? Turn on device code sign-in first, in its Security settings."),
        (r"^Your agent restarts after that\. It can take a few minutes\.$", "It restarts. Give it a few minutes."),
        (r"^When it is back, run this again:$", "When it's back, run this again:"),
        # [2/8]: one question; the other settings are applied without one.
        (r"^Not turned on\. To turn it on later, run the same setup command again\.$", "Left off. Rerun setup to add it."),
        (r"^Run setup with --details.*$", None),
        # [3/8]: the restart, in the WebUI's numbered words.
        (r"^OcuClaw is installed\. One restart of your agent loads it\.$", "One restart of your agent loads it."),
        (r"^1  This page disconnects for about a minute.*$", "1 This page drops for a minute."),
        (r"^2  Then open the link shown below and send /terminal\.$", "2 Open my link, send /terminal."),
        (r"^2  When it is back, reload the page and send /terminal\.$", "2 Then reload, send /terminal."),
        (r"^3  Setup carries on by itself\.$", "3 Setup carries on by itself."),
        (r"^3  Press the Up arrow, then Enter, to carry on\.$", "3 Then the Up arrow and Enter."),
        (r"^3  (.*)$", r"3 \1"),
        (r"^If it drops again soon after.*$", None),
        (r"^This page disconnects for about a minute.*$", "This page drops for about a minute."),
        (r"^When it is back, reload the page and send /terminal\.$", "Then reload, and send /terminal."),
        (r"^Then press the Up arrow and Enter to carry on\.$", "Press the Up arrow and Enter."),
        (r"^Restarting your agent\. This page disconnects in a few seconds\.$", "Restarting now. Back in about a minute."),
        (r"^In about a minute, open this link\..*$", None),
        (r"^Wait until /terminal shows.*$", None),
        # [5/8], in the WebUI: the link itself is drawn under the bubble (Matt's words, 2026-10-03).
        (r"^Open this link and sign in to Tailscale to approve this server:$", "Tailscale creates a private link between me and your glasses."),
        (r"^Use the Tailscale account your phone uses\.$", "Log in and approve this server."),
        (r"^No Tailscale on your phone\? Install it from the App Store or Google Play\.$",
         "No Tailscale on your phone? Install it for free from the App Store or Google Play."),
        # Those fill the bubble; the link under it already says what he waits for.
        (r"^Waiting for server approval\.$", None),
        # Said right after "Server approved." when the name got a number (both ladders).
        (r"^Tailscale added (-[0-9]+) because old devices with this name are still in your tailnet\.$",
         r"Tailscale added \1: old devices still use this name."),
        # [6/8]
        (r"^Your Tailscale account has HTTPS turned off\. Your phone's private route needs it\.$", "Your Tailscale account needs HTTPS on first."),
        (r"^Open this link, sign in to Tailscale and turn on HTTPS:$", "Open the link below, log in and turn on HTTPS."),
        (r"^Open this page, sign in to Tailscale and turn on MagicDNS and HTTPS Certificates:$",
         "Open the link below, log in and turn on MagicDNS and HTTPS."),
        # The link under him already says what he waits for.
        (r"^Waiting for HTTPS to be turned on\.$", None),
        (r"^Allow access from your tailnet only\..*$", "Only your own devices can use it."),
        (r"^Setup will add one private route so your phone can reach OcuClaw\.$", "One private route so your phone can reach OcuClaw."),
        (r"^Waiting for the certificate\..*$", "Waiting for its certificate…"),
        (r"^The private route is published and answering\.$", "Route published and answering."),
        # [7/8]
        (r"^Phone not found on your Tailscale network\.$", "Your phone isn't on Tailscale yet."),
        (r"^On your phone:$", None),
        (r"^2\. Sign in with the same account as this server\.$", "2. Sign in, same account as here."),
        (r"^Waiting for your phone\. Press Enter to skip this check\.$", "Waiting for it to join."),
        (r"^Phone check skipped\..*$", "Phone check skipped."),
        (r"^Open Even > OcuClaw on your phone and tap the Pair button\.$", "On your phone open Even › OcuClaw, tap Pair."),
        (r"^Then press Enter to show the code\.$", None),
        (r"^The next pairing code expires in .*$", None),
        # [7/8] the text-only manual block (#5485): the code panel draws it.
        (r"^Manual pairing$", None),
        (r"^In OcuClaw tap Pair with your agent > Pair manually, then type:$", None),
        (r"^Expires in .*$", None),
        (r"^Address: .*$", None),
        (r"^Pairing code: .*$", None),
        (r"^https?://\S+$", None),
        # [8/8]
        (r"^In the paired conversation on your phone, send (.+)\.$", r"Send \1 from your phone."),
        (r"^Waiting for the reply on your glasses…$", "Waiting for the reply…"),
        (r"^Your phone reported SDK acceptance of the reply\.$", "Your phone says the glasses got it."),
        (r"^This was the simulator, so setup can't check the glasses itself\.$", "Simulator: I can't check the glasses."),
        (r"^OcuClaw setup is complete for this Hermes profile\.$", "Setup is complete."),
    )
)


def condense(text: str) -> Optional[str]:
    for pattern, short in _CONDENSED:
        match = pattern.match(text)
        if match:
            return match.expand(short) if short is not None else None
    return text


#: A question longer than this is too long for the row under him (step 2's
#: Continue here question): he asks it in his bubble instead.
ASK_ROW = 40


def _in_bubble(question: str) -> bool:
    return len(question) > ASK_ROW


def split_question(prompt: str) -> Tuple[str, str]:
    """``Restart now? Type yes to continue, anything else stops: `` into the
    question and the hint under it."""
    text = prompt.strip().rstrip(":").strip()
    if "?" in text:
        question, _, hint = text.partition("?")
        hint = hint.strip()
        return question.strip() + "?", (hint[:1].upper() + hint[1:] + ".") if hint else ""
    return text, ""


@dataclass
class StepView:
    index: int
    header: str
    #: (kind, text): "line" for what setup said, "qa" for a question and its answer.
    lines: List[Tuple[str, str]] = field(default_factory=list)
    started: float = 0.0
    done: bool = False
    #: Printed above the block once it was done.
    committed: bool = False

    def said(self) -> List[str]:
        return [text for kind, text in self.lines if kind == "line"]


#: How a run carries on after the WebUI restart (cloudways_restart_step's
#: ``CARRY_ON_*``), read from the words setup prints.
CARRY_ON_ITSELF = "itself"
CARRY_ON_UP_ARROW = "up-arrow"
CARRY_ON_TYPED = "typed"


def _carry_on_way(text: str) -> Optional[str]:
    if "carries on" in text:
        return CARRY_ON_ITSELF
    if "Up arrow" in text:
        return CARRY_ON_UP_ARROW
    if re.search(r"\btype hermes ocuclaw\b", text, re.IGNORECASE):
        return CARRY_ON_TYPED
    return None


class SetupModel:
    """Where setup is, read from what it writes. Thread safe through ``lock``."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.lock = threading.RLock()
        self.clock = clock
        self.started = clock()
        self.total = STEP_COUNT
        self.steps: Dict[int, StepView] = {}
        self.current = 0
        self.steps[0] = StepView(0, "OcuClaw setup", started=self.started)
        self.partial = ""
        #: The prompt's own line once answered: the transcript keeps it, and the
        #: panel already holds the question and answer as one "qa" entry.
        self._answered: Optional[str] = None
        self.asking = False
        self.question: Optional[str] = None
        self.typed = ""
        self.exit_code: Optional[int] = None
        self.restarting = False
        self.resumed = False
        #: The address and the code of the manual block (step 7).
        self.address: Optional[str] = None
        self.code: Optional[str] = None
        self.code_at = 0.0
        self.code_seconds: Optional[float] = None
        #: The link that reopens the WebUI with /terminal typed in (step 3).
        self.reopen: Optional[str] = None
        #: Tailscale's link that approves this server, until it is approved (step 5),
        #: or that turns HTTPS on, until it is on (step 6).
        self.approve: Optional[str] = None
        #: The phone asking to pair and the four words to match with it (step 7).
        self.device: Optional[str] = None
        self.words: Optional[List[str]] = None
        self._words_next = False
        #: The phone code went to the phone ("Sent to your phone."): that path
        #: shows no pairing code, but the phone still asks to pair (step 7).
        self.sent = False
        #: How the run carries on once the page is back.
        self.carry_on = CARRY_ON_ITSELF
        self.transcript: List[str] = []
        self.version = 0

    # -- feeding ---------------------------------------------------------------

    def feed(self, text: str) -> None:
        with self.lock:
            text = text.replace("\r\n", "\n")
            pieces = text.split("\n")
            for piece in pieces[:-1]:
                self._line(self._overwrite(self.partial + piece))
                self.partial = ""
            self.partial = self._overwrite(self.partial + pieces[-1])
            self.version += 1

    @staticmethod
    def _overwrite(text: str) -> str:
        # A bare carriage return starts the line again, as on a terminal.
        return text.rsplit("\r", 1)[-1]

    def _line(self, raw: str) -> None:
        text = strip_ansi(raw).rstrip()
        self.transcript.append(text)
        body = text.strip()
        match = _STEP.match(body)
        if match:
            index = int(match.group(1))
            self.total = int(match.group(2)) or STEP_COUNT
            for view in self.steps.values():
                view.done = True
            self.steps[index] = StepView(index, match.group(3).strip(), started=self.clock())
            self.current = index
            self.restarting = False
            self.approve = None
            if self.sent:
                self.sent = False
                self.device = self.words = None
            self.version += 1
            return
        view = self.steps[self.current]
        if not body and (not view.lines or view.lines[-1][1] == ""):
            return
        if self._answered is not None and body == self._answered:
            self._answered = None
            return
        view.lines.append(("line", body))
        if body.startswith("Settings already applied") or body.startswith("OcuClaw is loaded and ready"):
            self.resumed = True
        if body.startswith("Restarting your agent"):
            self.restarting = True
        if body.startswith("The restart did not happen"):
            self.restarting = False
        url = _URL.search(body)
        if url and url.group(0).endswith("?q=/terminal"):
            self.reopen = url.group(0)
        elif url and self.current in (5, 6) and body == url.group(0):
            self.approve = url.group(0)
        if self.approve and re.search(r"approved|timed out|HTTPS is on|HTTPS is still off", body):
            self.approve = None
        if body == "Sent to your phone.":
            self.sent = True
        if (self.code or self.sent) and body.startswith("Phone: "):
            self.device = body.split(": ", 1)[1].strip()
        if body.startswith("Match these four words"):
            self._words_next = True
        box = _WORDS_ROW.match(body)
        if (self.code or self.sent) and box and self._words_next:
            self.words = box.group(1).split()
            self._words_next = False
        way = None
        if body.startswith("3  ") or body.startswith("Wait until /terminal shows") or "Instead, for 3:" in body:
            way = _carry_on_way(body)
        if way:
            self.carry_on = way
        if body.startswith("Address: "):
            self.address = body.split(": ", 1)[1].strip()
        if body.startswith("Pairing code: "):
            self.code = body.split(": ", 1)[1].strip()
            self.code_at = self.clock()
        clock = _EXPIRY_CLOCK.match(body)
        if clock:
            self.code_seconds = int(clock.group(1)) * 60 + int(clock.group(2))
        if (self.code or self.sent) and re.search(r"expired|did not finish|[Pp]aired|approved", body):
            # "Not approved." asks again for the same four words.
            if not body.startswith(("The next", "Not approved")):
                self.code = None
                self.sent = False
        if self.sent and body.startswith("Pairing "):
            # Any ending of a phone-code pairing ("Pairing cancelled.", "Pairing
            # was refused ...", "Pairing stopped ...") ends its four words.
            self.sent = False
        if not (self.code or self.sent) or body.startswith("Approved"):
            self.device = self.words = None

    # -- asking ----------------------------------------------------------------

    def ask_begin(self) -> None:
        with self.lock:
            prompt = strip_ansi(self.partial).strip()
            self.asking = True
            self.question = prompt or None
            self.version += 1

    def ask_end(self, answer: str) -> None:
        with self.lock:
            self.asking = False
            answer = answer.rstrip("\n")
            if self.question:
                # The prompt's own line goes on to hold the answer, as it does when
                # the terminal echoes it; the ladder's newline then ends it.
                self.partial = self.partial + answer
                self._answered = strip_ansi(self.partial).strip()
                view = self.steps[self.current]
                view.lines.append(("qa", f"{split_question(self.question)[0]} {answer}".strip()))
            self.question = None
            self.typed = ""
            self.version += 1

    def set_typed(self, typed: str) -> None:
        with self.lock:
            self.typed = typed
            self.version += 1

    def finish(self, exit_code: int) -> None:
        with self.lock:
            if self.partial:
                self._line(self.partial)
                self.partial = ""
            self.exit_code = exit_code
            if exit_code == 0:
                for view in self.steps.values():
                    view.done = True
            else:
                # A code shown when the run stopped is dead with it, and a run
                # that ends here was not taken down by a restart.
                self.code = None
                if self.sent:
                    self.sent = False
                    self.device = self.words = None
                self.restarting = False
            self.asking = False
            self.version += 1

    # -- reading -------------------------------------------------------------------

    def view(self) -> StepView:
        return self.steps[self.current]

    def is_done(self, index: int) -> bool:
        view = self.steps.get(index)
        return bool(view and view.done)

    def done_count(self) -> int:
        return sum(1 for i in range(1, self.total + 1) if self.is_done(i))

    def shown_done(self, index: int) -> bool:
        """Done, as the pips show it. Back from the restart, steps 1 to 3 were
        done before it, so they stay done while setup checks them again and the
        pips never start over; only a stop in those checks shows where it stopped."""
        before = self.resumed and index <= 3 and (self.exit_code is None or index < self.current)
        return self.is_done(index) or before

    def shown_done_count(self) -> int:
        return sum(1 for i in range(1, self.total + 1) if self.shown_done(i))

    def shown_step(self) -> int:
        """The step the count shows: back from the restart, never below 3."""
        if self.resumed and self.exit_code is None:
            return max(self.current, 3)
        return self.current

    def last_said(self) -> str:
        said = [text for text in self.view().said() if text]
        return said[-1] if said else ""

    def paired(self) -> bool:
        """Step 7 has just paired the phone (its code is gone)."""
        return self.current == 7 and not self.code and bool(re.match(r"(Phone paired|Paired\.)", self.last_said()))

    def reply(self) -> Optional[str]:
        """Step 8: the first line after the wait for the reply, once there is one."""
        if self.current != 8:
            return None
        said = [text for text in self.view().said() if text]
        for i, text in enumerate(said):
            if text.startswith("Waiting for the reply") or text.startswith("Waiting for your first message"):
                later = [line for line in said[i + 1 :] if not line.startswith("Waiting")]
                return later[0] if later else None
        return None

    def panel_lines(self) -> List[str]:
        """The step in hand, shortened for the bubble."""
        out = []
        for text in self.view().said():
            short = condense(text)
            # A busy line ("Checking Tailscale...") is the status line's while it
            # is the latest, and stale once a later line arrives.
            if short and not short.startswith("Stuck? Ask us") and not short.endswith(("...", "…")):
                out.append(short)
        return out

    def working(self) -> Optional[str]:
        """The last line, when it says setup is busy ("Checking Tailscale...")."""
        said = self.view().said()
        if self.exit_code is None and said and said[-1].rstrip().endswith(("...", "…")):
            return condense(said[-1]) or said[-1]
        return None

    def waiting_for_enter(self) -> bool:
        """Does the newest line ask for Enter? A closing expiry note does not count."""
        if self.exit_code is not None:
            return False
        for line in reversed([text for text in self.view().said() if text.strip()][-3:]):
            if "press enter" in line.lower():
                return True
            if not _EXPIRY_NOTE.search(line):
                return False
        return False

    def skip_offer(self) -> bool:
        """Is setup offering Enter to skip a wait (the phone check)?"""
        said = [text for text in self.view().said() if text.strip()]
        return bool(said) and "to skip" in said[-1]

    def title(self) -> str:
        if self.exit_code == 0 and self.current >= self.total:
            return "All set!"
        if self.exit_code not in (None, 0):
            return "Stopped for now"
        if self.restarting:
            return "Restarting your agent"
        if self.resumed and self.current <= 3:
            return "Welcome back"
        if self.code:
            return "Your pairing code"
        if self.paired():
            return "Phone paired"
        return FRIENDLY_TITLES.get(self.current, self.view().header)

    def code_left(self) -> Optional[float]:
        if not self.code or not self.code_seconds:
            return None
        return max(0.0, self.code_seconds - (self.clock() - self.code_at))

    def speck_state(self) -> str:
        if self.exit_code is not None:
            if self.exit_code == 0:
                return "move.finishFlag"
            return "concept.warning"
        if self.restarting:
            return "idle.nap"
        if self.paired():
            return "move.pairTick"
        if self.current == 8 and self.reply():
            return "responding"
        if self.asking and self.typed:
            return "listening.right"
        if self.asking or self.waiting_for_enter():
            return "move.question"
        if self.resumed and self.current <= 3:
            return "concept.reconnecting"
        last = self.last_said()
        return {
            0: "idle",
            1: "move.rackKnock",
            2: "move.landTick" if "applied" in last else "fs.edit",
            3: "move.landTick" if "ready" in last else "move.loadingRing",
            4: "move.landTick" if "running" in last else "move.threadLink",
            5: "move.landTick" if "approved" in last or last.startswith("Tailscale added -") else "connecting",
            6: "move.landTick" if "answering" in last else "concept.secure",
            7: "move.signalEyes" if self.code else "device.check",
            8: "move.sayHi",
        }.get(self.current, "idle")


# -- Speck -----------------------------------------------------------------------

_FRAME_CACHE: Dict[str, bytes] = {}


def _frames(size: str) -> Tuple[bytes, Tuple[int, int]]:
    from . import speck_frames

    if size not in _FRAME_CACHE:
        data = speck_frames.BIG_FRAMES if size == "big" else speck_frames.MINI_FRAMES
        _FRAME_CACHE[size] = zlib.decompress(base64.b64decode("".join(data)))
    return _FRAME_CACHE[size], (speck_frames.BIG if size == "big" else speck_frames.MINI)


def speck_frame(state: str, t: float, size: str = "big") -> Tuple[int, int, bytes, bytes]:
    """One frame: cols, rows, the braille bytes and the cells that are his prop."""
    from . import speck_frames

    raw, (cols, rows) = _frames(size)
    try:
        index = speck_frames.STATES.index(state)
    except ValueError:
        index = 0
    lengths = speck_frames.LENGTHS
    n = int(t * speck_frames.FPS)
    # A pose that plays once holds its last frame; the rest loop.
    n = min(max(n, 0), lengths[index] - 1) if state in speck_frames.ONCE else n % lengths[index]
    frame = sum(lengths[:index]) + n
    cells = cols * rows
    at = frame * cells * 2
    return cols, rows, raw[at : at + cells], raw[at + cells : at + 2 * cells]


Frame = Tuple[int, int, bytes, bytes]


def frame_dots(frame: Frame) -> Dict[Tuple[int, int], int]:
    """A frame's lit dots, as (x, y) in braille dots, each with its prop flag."""
    cols, rows, dots, props = frame
    out: Dict[Tuple[int, int], int] = {}
    for cy in range(rows):
        for cx in range(cols):
            bits = dots[cy * cols + cx]
            if bits:
                for dy in range(4):
                    for dx in range(2):
                        if bits & _BIT[dy][dx]:
                            out[(cx * 2 + dx, cy * 4 + dy)] = props[cy * cols + cx]
    return out


def dots_frame(cols: int, rows: int, lit: Sequence[Tuple[int, int, int]]) -> Frame:
    """(x, y, prop) dots back into a frame; a cell is his prop when most of its dots are."""
    dots = bytearray(cols * rows)
    prop = [0] * (cols * rows)
    for x, y, flag in lit:
        if 0 <= x < cols * 2 and 0 <= y < rows * 4:
            at = (y >> 2) * cols + (x >> 1)
            dots[at] |= _BIT[y & 3][x & 1]
            prop[at] += 1 if flag else -1
    return cols, rows, bytes(dots), bytes(1 if n > 0 else 0 for n in prop)


def pair_dots(
    src: Sequence[Tuple[int, int]], dst: Sequence[Tuple[int, int]], reach: int = 24
) -> Tuple[List[Tuple[int, int]], List[int], List[int]]:
    """Each dot that leaves to the nearest free dot that arrives, within ``reach``.

    Returns the pairs (index into src, index into dst), then the src dots and
    the dst dots that found no partner.
    """
    grid: Dict[Tuple[int, int], List[int]] = {}
    for j, (x, y) in enumerate(dst):
        grid.setdefault((x >> 2, y >> 2), []).append(j)
    free = [True] * len(dst)
    pairs: List[Tuple[int, int]] = []
    lost: List[int] = []
    for i, (x, y) in enumerate(src):
        gx, gy = x >> 2, y >> 2
        best, best_d = -1, reach * reach + 1
        for r in range(reach // 4 + 2):
            for cx in range(gx - r, gx + r + 1):
                for cy in range(gy - r, gy + r + 1):
                    if max(abs(cx - gx), abs(cy - gy)) != r:
                        continue
                    for j in grid.get((cx, cy), ()):
                        if free[j]:
                            d = (dst[j][0] - x) ** 2 + (dst[j][1] - y) ** 2
                            if d < best_d:
                                best, best_d = j, d
            # Nothing in a farther ring can be nearer than (r * 4) dots.
            if best >= 0 and best_d <= (r * 4) ** 2:
                break
        if best >= 0:
            free[best] = False
            pairs.append((i, best))
        else:
            lost.append(i)
    return pairs, lost, [j for j, ok in enumerate(free) if ok]


def body_shift(a: Mapping[Tuple[int, int], int], b: Mapping[Tuple[int, int], int]) -> Tuple[int, int]:
    """How far his body moved between two poses, in dots.

    His glasses are most of his dots, so the shift that best lines up the two
    poses' column and row counts (his body only, not what he holds) is how far
    he moved.
    """

    def best(axis: int, size: int, most: int) -> int:
        ha, hb = [0] * size, [0] * size
        for hist, dots in ((ha, a), (hb, b)):
            for xy, flag in dots.items():
                if not flag:
                    hist[xy[axis]] += 1
        score = {d: sum(ha[i] * hb[i + d] for i in range(max(0, -d), min(size, size - d))) for d in range(-most, most + 1)}
        return max(score, key=lambda d: (score[d], -abs(d)))

    return best(0, 100, 24), best(1, 32, 6)


class Glide:
    """One pose into the next, dot by dot.

    The baked frames are separate loops, so a new pose would cut. His body
    slides as one piece to where the new pose has it; a dot that does not land
    on the new pose there moves to the nearest dot the new pose still needs,
    and what is left winks out or in along the way.
    """

    #: How far a dot travels to a new place on him, in dots; farther ones wink.
    REACH = 3

    def __init__(self, old: Frame, new: Frame, seed: int = 7) -> None:
        self.cols, self.rows = new[0], new[1]
        a, b = frame_dots(old), frame_dots(new)
        self.dx, self.dy = body_shift(a, b)
        dx, dy = self.dx, self.dy
        landed = {(x + dx, y + dy) for x, y in a}
        self.stay = [((x, y), b[(x + dx, y + dy)]) for x, y in a if (x + dx, y + dy) in b]
        leave = [(x, y) for x, y in a if (x + dx, y + dy) not in b]
        arrive = [xy for xy in b if xy not in landed]
        pairs, lost, born = pair_dots([(x + dx, y + dy) for x, y in leave], arrive, reach=self.REACH)
        r = random.Random(seed + len(leave) * 31 + len(arrive))
        self.moves = [(leave[i], arrive[j], a[leave[i]], b[arrive[j]]) for i, j in pairs]
        # The old pose's details go just before halfway and the new ones come
        # just after, so no frame is a scatter of both.
        self.out = [(leave[i], a[leave[i]], 0.35 + 0.15 * r.random()) for i in lost]
        self.into = [(arrive[j], b[arrive[j]], 0.5 + 0.15 * r.random()) for j in born]

    def frame(self, f: float) -> Frame:
        e = ease(f)
        sx, sy = self.dx * e, self.dy * e
        lit = [(round(x + sx), round(y + sy), flag) for (x, y), flag in self.stay]
        for (ax, ay), (bx, by), was, now in self.moves:
            lit.append((round(ax + (bx - ax) * e), round(ay + (by - ay) * e), now if f >= 0.5 else was))
        lit.extend((round(x + sx), round(y + sy), flag) for (x, y), flag, when in self.out if f < when)
        lit.extend(
            (round(x - self.dx + sx), round(y - self.dy + sy), flag) for (x, y), flag, when in self.into if f >= when
        )
        return dots_frame(self.cols, self.rows, lit)


# -- drawing ---------------------------------------------------------------------


def _rgb(hex_: str, color: bool) -> str:
    if not color:
        return ""
    return "\x1b[38;2;{};{};{}m".format(int(hex_[0:2], 16), int(hex_[2:4], 16), int(hex_[4:6], 16))


class Palette:
    """24-bit colours, or none at all under NO_COLOR. Each is an SGR prefix."""

    def __init__(self, color: bool = True) -> None:
        self.g = _rgb("4dd58a", color)
        self.gd = _rgb("2d8a57", color)
        self.gl = _rgb("a3f2c4", color)
        self.y = _rgb("e9c46a", color)
        self.y_low = _rgb("a8893e", color)
        self.y_glint = _rgb("f6dc9a", color)
        self.c = _rgb("7cc9ee", color)
        self.r = _rgb("f08a8a", color)
        self.fg = _rgb("e3e4ee", color)
        self.dim = _rgb("8a8da6", color)
        self.faint = _rgb("5c5f78", color)
        self.bold = "\x1b[1m" if color else ""
        self.under = "\x1b[4m" if color else ""
        self.chip = "\x1b[1;38;2;11;13;10;48;2;77;213;138m" if color else ""
        self.reset = "\x1b[0m" if color else ""


Seg = Tuple[str, str]
Style = Union[str, Callable[[int, int], str]]
_BLANK = (" ", "")
_BRAILLE_BLANK = chr(0x2800)


class Canvas:
    """A grid of one-column characters, each with its own style."""

    def __init__(self, cols: int, rows: int, palette: Palette) -> None:
        self.cols = cols
        self.rows = rows
        self.p = palette
        self.cells = [[_BLANK for _ in range(cols)] for _ in range(rows)]

    def put(self, x: int, y: int, ch: str, style: str = "") -> None:
        if 0 <= x < self.cols and 0 <= y < self.rows:
            self.cells[y][x] = (ch, style)

    def get(self, x: int, y: int) -> Optional[Tuple[str, str]]:
        if 0 <= x < self.cols and 0 <= y < self.rows:
            return self.cells[y][x]
        return None

    def empty(self, x: int, y: int) -> bool:
        cell = self.get(x, y)
        return cell is not None and cell[0] == " "

    def text(self, x: int, y: int, text: str, style: str = "") -> int:
        if 0 <= y < self.rows:
            row = self.cells[y]
            for ch in text:
                if 0 <= x < self.cols:
                    row[x] = (ch, style)
                x += 1
            return x
        return x + len(text)

    def segs(self, x: int, y: int, segs: Sequence[Seg], width: Optional[int] = None) -> int:
        room = self.cols - x if width is None else width
        for text, style in segs:
            if room <= 0:
                break
            text = text[:room]
            room -= len(text)
            x = self.text(x, y, text, style)
        return x

    def tint(self, x0: int, y0: int, x1: int, y1: int, old: str, new: str) -> None:
        """Recolour what is drawn in ``old`` inside a box: a border flash."""
        for y in range(max(0, y0), min(self.rows, y1 + 1)):
            for x in range(max(0, x0), min(self.cols, x1 + 1)):
                ch, style = self.cells[y][x]
                if ch != " " and style == old:
                    self.cells[y][x] = (ch, new)

    def speck(
        self,
        x: int,
        y: int,
        state: str,
        t: float,
        size: str = "big",
        crop: Tuple[int, int] = (0, 99),
        body: Optional[str] = None,
        prop: Optional[str] = None,
        frame: Optional[Frame] = None,
    ) -> int:
        """Speck in braille; what he holds may take its own colour."""
        cols, rows, dots, props = frame or speck_frame(state, t, size)
        lo, hi = crop[0], min(cols - 1, crop[1])
        body = self.p.g if body is None else body
        prop = body if prop is None else prop
        for cy in range(rows):
            for cx in range(lo, hi + 1):
                bits = dots[cy * cols + cx]
                if bits:
                    self.put(x + cx - lo, y + cy, chr(0x2800 + bits), prop if props[cy * cols + cx] else body)
        return hi - lo + 1

    def line(self, y: int) -> str:
        cells = self.cells[y]
        end = len(cells)
        while end and cells[end - 1] == _BLANK:
            end -= 1
        out, style = [], None
        for ch, st in cells[:end]:
            if st != style:
                out.append(self.p.reset + st if style is not None or st else "")
                style = st
            out.append(ch)
        if style:
            out.append(self.p.reset)
        return "".join(out)


def seg_str(segs: Sequence[Seg], palette: "Palette") -> str:
    return "".join((style + text + palette.reset) if style else text for text, style in segs)


def wrap_segs(segs: Sequence[Seg], width: int) -> List[List[Seg]]:
    """Word wrap for styled pieces: each line keeps every letter's own style."""
    width = max(4, width)
    cells = [(ch, style) for text, style in segs for ch in text]
    lines: List[List[Tuple[str, str]]] = []
    while len(cells) > width:
        cut = max((i for i in range(1, width + 1) if cells[i][0] == " "), default=width)
        lines.append(cells[:cut])
        cells = cells[cut:]
        while cells and cells[0][0] == " ":
            cells = cells[1:]
    lines.append(cells)
    out: List[List[Seg]] = []
    for line in lines:
        joined: List[Seg] = []
        for ch, style in line:
            if joined and joined[-1][1] == style:
                joined[-1] = (joined[-1][0] + ch, style)
            else:
                joined.append((ch, style))
        out.append(joined)
    return out


def seg_len(segs: Sequence[Seg]) -> int:
    return sum(len(text) for text, _ in segs)


@dataclass
class Row:
    """One logical line of the block, and the screen rows it takes."""

    text: str
    height: int = 1


def canvas_rows(canvas: Canvas) -> List[Row]:
    return [Row(canvas.line(y)) for y in range(canvas.rows)]


def screen_rows(text: str, cols: int) -> int:
    """The screen rows a line of text takes once the terminal wraps it."""
    return max(1, math.ceil(len(strip_ansi(text)) / max(1, cols)))


def wrapped_row(text: str, style: str, cols: int, palette: Palette, indent: int = 2) -> Row:
    """A line left to the terminal to wrap, so a long link stays one link."""
    width = indent + len(text)
    return Row(" " * indent + style + text + palette.reset, max(1, math.ceil(width / max(1, cols))))


# -- big letters: a 5x7 font in braille, three cells by two rows a glyph -------------

_GLYPHS = {
    "A": ".###.|#...#|#...#|#####|#...#|#...#|#...#",
    "B": "####.|#...#|#...#|####.|#...#|#...#|####.",
    "C": ".###.|#...#|#....|#....|#....|#...#|.###.",
    "D": "###..|#..#.|#...#|#...#|#...#|#..#.|###..",
    "E": "#####|#....|#....|####.|#....|#....|#####",
    "F": "#####|#....|#....|####.|#....|#....|#....",
    "G": ".###.|#...#|#....|#.###|#...#|#...#|.####",
    "H": "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    "I": ".###.|..#..|..#..|..#..|..#..|..#..|.###.",
    "J": "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
    "K": "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
    "L": "#....|#....|#....|#....|#....|#....|#####",
    "M": "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
    "N": "#...#|#...#|##..#|#.#.#|#..##|#...#|#...#",
    "O": ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
    "P": "####.|#...#|#...#|####.|#....|#....|#....",
    "Q": ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
    "R": "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
    "S": ".####|#....|#....|.###.|....#|....#|####.",
    "T": "#####|..#..|..#..|..#..|..#..|..#..|..#..",
    "U": "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
    "V": "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
    "W": "#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.",
    "X": "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
    "Y": "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
    "Z": "#####|....#|...#.|..#..|.#...|#....|#####",
    "0": ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
    "1": "..#..|.##..|..#..|..#..|..#..|..#..|.###.",
    "2": ".###.|#...#|....#|...#.|..#..|.#...|#####",
    "3": "#####|...#.|..#..|...#.|....#|#...#|.###.",
    "4": "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.",
    "5": "#####|#....|####.|....#|....#|#...#|.###.",
    "6": "..##.|.#...|#....|####.|#...#|#...#|.###.",
    "7": "#####|....#|...#.|..#..|.#...|.#...|.#...",
    "8": ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
    "9": ".###.|#...#|#...#|.####|....#|...#.|.##..",
    "-": ".....|.....|.....|.###.|.....|.....|.....",
    "!": "..#..|..#..|..#..|..#..|..#..|.....|..#..",
    ".": ".....|.....|.....|.....|.....|.....|..#..",
    " ": ".....|.....|.....|.....|.....|.....|.....",
    # A tick that may use the spacing column: it is always last.
    "✓": ".....#|....##|...##.|#.##..|###...|.#....|......",
}
_GLYPH_ROWS = {key: value.split("|") for key, value in _GLYPHS.items()}
_BIT = ((0x01, 0x08), (0x02, 0x10), (0x04, 0x20), (0x40, 0x80))
Mask = Callable[[int, int], bool]


def big_width(text: str) -> int:
    return len(text) * 3


def _lit(rows: List[str], px: int, py: int, bold: bool) -> bool:
    def on(y: int) -> bool:
        return 0 <= y < len(rows) and px < len(rows[y]) and rows[y][px] == "#"

    return on(py) or (bold and on(py - 1))


def big_draw(
    c: Canvas,
    x: int,
    y: int,
    text: str,
    style: Style,
    *,
    mask: Optional[Mask] = None,
    bold: bool = False,
    solid: bool = False,
) -> int:
    """``text`` in big letters at x,y. ``style`` is a style or ``(glyph, cx) -> style``.

    ``mask(px, py)`` keeps a dot of the 6x8 glyph box; ``bold`` doubles each dot
    downwards; ``solid`` writes blank braille into a glyph's empty cells, so
    nothing else draws there.
    """
    for gi, ch in enumerate(text.upper()):
        rows = _GLYPH_ROWS.get(ch, _GLYPH_ROWS[" "])
        for cy in range(2):
            for cx in range(3):
                bits = 0
                for dy in range(4):
                    for dx in range(2):
                        px, py = cx * 2 + dx, cy * 4 + dy
                        if _lit(rows, px, py, bold) and (mask is None or mask(px, py)):
                            bits |= _BIT[dy][dx]
                if not bits and not solid:
                    continue
                st = style(gi, cx) if callable(style) else style
                c.put(x + gi * 3 + cx, y + cy, chr(0x2800 + bits), st)
    return x + big_width(text)


# -- the bubble: round corners and a slanted point, drawn in braille dots ------------------

#: A corner's dots from where its two edges would meet, for the top left one; the others mirror it.
_CORNER = ((0, 4), (0, 3), (0, 2), (1, 2), (1, 1), (2, 1), (2, 0), (3, 0), (4, 0))
_R = 4
#: The point: flat underneath, slanting down from the edge toward Speck (Matt's pick).
_POINT = tuple((i, i) for i in range(6)) + tuple((i, 5) for i in range(5))
#: The code's countdown in the bottom border: a thick line over the border's own dots.
_THICK, _THIN = "⠶", "⠤"


def bubble(c: Canvas, x: int, y: int, w: int, h: int, style: str, *, row: int = 1, right: bool = False) -> None:
    """A round-cornered box in braille dots whose point leaves its left (or right) edge at ``row``.

    The whole outline is dots, which is what lets the corners curve in a terminal.
    Titles sit from ``x + 3`` so a corner keeps its curve.
    """
    left, right_x, top, bottom = 2 * x + 1, 2 * (x + w - 1), 4 * y + 1, 4 * (y + h - 1) + 2
    dots = set()  # dot (x, y) in braille dots: 2 a cell across, 4 down
    for dx in range(left + _R, right_x - _R + 1):
        dots.update(((dx, top), (dx, bottom)))
    for dy in range(top + _R, bottom - _R + 1):
        dots.update(((left, dy), (right_x, dy)))
    for cx, sx in ((left, 1), (right_x, -1)):
        for cy, sy in ((top, 1), (bottom, -1)):
            dots.update((cx + sx * ox, cy + sy * oy) for ox, oy in _CORNER)
    edge, out = (right_x, 1) if right else (left, -1)
    z = 4 * (y + row) + 1
    dots.difference_update((edge, dy) for dy in range(z + 1, z + 5))
    dots.update((edge + out * ox, z + oy) for ox, oy in _POINT)
    cells: Dict[Tuple[int, int], int] = {}
    for dx, dy in dots:
        if dx >= 0 and dy >= 0:
            key = (dx >> 1, dy >> 2)
            cells[key] = cells.get(key, 0) | _BIT[dy & 3][dx & 1]
    for (cx, cy), bits in cells.items():
        # The point may reach a cell where what he holds sticks out: he stays in front.
        if x <= cx < x + w or c.empty(cx, cy):
            c.put(cx, cy, chr(0x2800 + bits), style)


# -- confetti ---------------------------------------------------------------------------

_PIECES = (((0, 0), (1, 0)), ((0, 0), (1, 1)), ((0, 0), (0, 1)), ((1, 0), (0, 1)))
_SQUARE = ((0, 0), (1, 0), (0, 1), (1, 1))


@dataclass
class _Bit:
    x: float
    y0: float
    born: float
    v: float
    sway: float
    w: float
    ph: float
    spin: int
    big: bool
    color: int


def _confetti_bits() -> List[_Bit]:
    r = random.Random(20261002)
    out = []
    for i in range(560):
        # A burst that fills the screen at once, then a shower that thins out.
        burst = i < 480
        out.append(
            _Bit(
                x=r.random(),
                y0=-4 + r.random() * 42 if burst else -2 - r.random() * 4,
                born=0.0 if burst else 1.6 * r.random() ** 2.2,
                v=10 + r.random() * 14,
                sway=0.5 + r.random() * 1.5,
                w=2 + r.random() * 4,
                ph=r.random() * 6.3,
                spin=int(r.random() * 4),
                big=r.random() < 0.25,
                color=i % 5,
            )
        )
    return out


_CONFETTI = _confetti_bits()


def confetti(c: Canvas, age: float) -> None:
    """Braille confetti into empty cells that are not next to anything drawn."""
    p = c.p
    colors = (p.g, p.gl, p.y, p.c, p.r)
    w, h = c.cols * 2, c.rows * 4

    def busy(x: int, y: int) -> bool:
        cell = c.get(x, y)
        return cell is not None and cell[0] != " "

    moat = {
        (x, y)
        for y in range(c.rows)
        for x in range(c.cols)
        if busy(x, y) or busy(x - 1, y) or busy(x + 1, y) or busy(x, y - 1) or busy(x, y + 1)
    }
    cells: Dict[Tuple[int, int], List[int]] = {}
    for bit in _CONFETTI:
        a = age - bit.born
        if a < 0:
            continue
        dy = bit.y0 + a * bit.v
        if dy < 0 or dy >= h:
            continue
        dx = bit.x * w + math.sin(a * bit.w + bit.ph) * bit.sway
        for ox, oy in _SQUARE if bit.big else _PIECES[(bit.spin + int(a * 6)) % 4]:
            px, py = int(math.floor(dx)) + ox, int(math.floor(dy)) + oy
            if not (0 <= px < w and 0 <= py < h):
                continue
            cell = cells.setdefault((px >> 1, py >> 2), [0, bit.color])
            cell[0] |= _BIT[py & 3][px & 1]
    for (x, y), (bits, color) in cells.items():
        if (x, y) not in moat:
            c.put(x, y, chr(0x2800 + bits), colors[color])


# -- the words a bubble types on --------------------------------------------------------


class Typist:
    """Lines that type on, about ``CPS`` letters a second, one after another."""

    CPS = 50.0
    #: No line takes longer than this, so a long one cannot hold up the next.
    MOST = 0.8
    #: He finishes the gesture a beat after the last letter.
    HANG = 0.2

    def __init__(self) -> None:
        self._start: Dict[str, Tuple[float, float]] = {}
        self._end = -99.0

    def fresh(self, t: float) -> None:
        """A new step: its words start now, not after the last step's."""
        self._end = min(self._end, t)

    def shown(self, lines: Sequence[str], t: float, instant: bool = False) -> List[Tuple[str, int]]:
        out = []
        for text in lines:
            if text not in self._start:
                if instant:
                    self._start[text] = (t, 0.0)
                else:
                    start = max(t, self._end)
                    if start > t + 1.2:
                        # Too far behind: start soon and go quickly.
                        start, took = t + 0.6, 0.3
                    else:
                        took = min(len(text) / self.CPS, self.MOST)
                    self._start[text] = (start, took)
                    self._end = start + took
            start, took = self._start[text]
            done = 1.0 if took <= 0 else max(0.0, min(1.0, (t - start) / took))
            out.append((text, int(done * len(text))))
        return out

    def talking(self, t: float) -> bool:
        return t < self._end + self.HANG


def bubble_lines(words: Sequence[Tuple[str, int]], width: int) -> List[Tuple[str, int, bool]]:
    """Each line wrapped whole for the bubble (no reflow while typing): text, shown, typing."""
    out = []
    for text, shown in words:
        typing = shown < len(text)
        # A bulleted line hangs its second line under its words, not under the bullet.
        bullet = "• " if text.startswith("• ") else ""
        off = len(bullet)
        for i, line in enumerate(wrap(text[len(bullet) :], width - len(bullet))):
            lead = bullet if i == 0 else " " * len(bullet)
            n = max(0, min(len(line), shown - off))
            out.append((lead + line, len(lead) + n if (n or (i == 0 and shown > 0)) else 0, typing))
            off += len(line) + 1
    return out


# -- a look ------------------------------------------------------------------------------


class Look:
    """How a look draws the model. Subclasses fill in ``draw``."""

    name = "plain"

    def __init__(self, palette: Palette) -> None:
        self.p = palette
        #: Set for the last paint, when setup has finished.
        self.final = False
        #: The said lines the last paint showed whole, every letter of each on screen.
        self.shown_whole: set[str] = set()

    def height(self, cols: int, rows: int) -> int:
        return min(rows, 10)

    def draw(self, m: SetupModel, t: float, cols: int, rows: int) -> List[Row]:
        raise NotImplementedError

    def frame(self, m: SetupModel, t: float, cols: int, rows: int) -> List[Row]:
        """What is drawn: ``draw``, every one-row line kept inside the window,
        and the bottom of it when it is taller than the window."""
        drawn = [row if row.height > 1 else Row(clip_ansi(row.text, cols)) for row in self.draw(m, t, cols, rows)]
        total = 0
        kept: List[Row] = []
        for row in reversed(drawn):
            if total + row.height > rows:
                break
            kept.append(row)
            total += row.height
        return list(reversed(kept))

    def take_commits(self, m: SetupModel, cols: Optional[int] = None) -> List[str]:
        """Each step done since the last call, for the scrollback above the block.
        With ``cols``, a step's words wrap at a word inside it, under their
        indent, rather than wherever the terminal breaks them (a phone's narrow
        window)."""
        out: List[str] = []
        for index in sorted(m.steps):
            view = m.steps[index]
            if view.done and not view.committed:
                view.committed = True
                out += self.step_record(view, m.total, cols)
        return out

    def step_record(self, view: StepView, total: int, cols: Optional[int] = None) -> List[str]:
        """A finished step: his title for it, then what he said in the bubble,
        and each question with its answer. Lines kept out of the bubble (links,
        the code, busy lines) stay out of here too."""
        p = self.p
        title = FRIENDLY_TITLES.get(view.index, view.header)
        out = [f"{p.g}✓{p.reset} {p.dim}{title} · {view.index} of {total}{p.reset}"] if view.index else []
        for kind, text in view.lines:
            said = text if kind == "qa" else condense(text)
            if said and not said.startswith("Stuck? Ask us") and not said.endswith(("...", "…")):
                lines = [said] if cols is None else wrap(said, cols - len(RECORD_INDENT) - 1)
                out.extend(f"{p.faint}{RECORD_INDENT}{line}{p.reset}" for line in lines)
        return out

    # -- shared pieces ---------------------------------------------------------

    def spin(self, t: float) -> str:
        return _SPIN[int(t * 12) % len(_SPIN)]

    def blink(self, t: float) -> bool:
        return int(t * 2.5) % 2 == 0

    #: A prompt that waits on the person shines (Matt, 2026-10-03): a band of
    #: green light sweeps across its words, then rests, so the eye finds it.
    SHINE_SWEEP = 1.2
    SHINE_REST = 1.2

    def _shine(self, segs: List[Seg], waited: float) -> List[Seg]:
        """``segs`` (the arrow, the words, the cursor) with the band across the words."""
        p = self.p
        if waited < 0 or len(segs) < 2:
            return segs
        at = waited % (self.SHINE_SWEEP + self.SHINE_REST)
        if at >= self.SHINE_SWEEP:
            return segs
        arrow, (words, style), *rest = segs
        middle = at / self.SHINE_SWEEP * (len(words) + 6) - 3
        out: List[Seg] = [arrow]
        for i, ch in enumerate(words):
            off = abs(i - middle)
            look = p.chip if off <= 1 else style + p.gl if off <= 2.5 else style
            if out[-1][1] == look and len(out) > 1:
                out[-1] = (out[-1][0] + ch, look)
            else:
                out.append((ch, look))
        return out + rest

    def status(self, m: SetupModel, t: float) -> Tuple[str, List[Seg]]:
        """The one line under a step: what to type, a wait, or nothing."""
        p = self.p
        cursor = "▌" if self.blink(t) else " "
        # "Press Enter there" while restarting is for the reopened page, not this one.
        enter = m.waiting_for_enter() and not m.restarting
        # How long a prompt has waited on the person, for its shine; typing ends it.
        waited = self._since("ask", (m.asking or enter) and not m.typed, t)
        if m.asking and m.question:
            question, hint = split_question(m.question)
            if _in_bubble(question):
                # He asks it in his bubble; this row keeps only what to type.
                question = hint.rstrip(".") or "Type your answer"
            return "ask", self._shine([("› ", p.g), (question, p.bold), (" " + m.typed + cursor, p.g)], waited)
        if m.asking or enter:
            label = "Pair screen open? Press Enter" if m.current == 7 and not m.code else "Press Enter to carry on"
            if m.skip_offer():
                label = "Press Enter to skip this check"
            elif m.current == 7 and "new code" in " ".join(m.view().said()[-3:]):
                label = "Press Enter for a new code"
            return "ask", self._shine([("› ", p.g), (label, p.bold), (" " + m.typed + cursor, p.g)], waited)
        if m.typed:
            return "ask", [("› " + m.typed + cursor, p.g)]
        busy = m.working()
        if busy:
            return "busy", [(f"{self.spin(t)} {busy}", p.y)]
        if m.restarting:
            return "busy", [(f"{self.spin(t)} Dropping now. That's expected.", p.y)]
        if m.code and m.exit_code is None:
            return "busy", [(f"{self.spin(t)} Waiting for your phone…", p.y)]
        return "", []

    def hint(self, m: SetupModel) -> str:
        if m.asking and m.question:
            question, hint = split_question(m.question)
            if _in_bubble(question):
                return "Then press Enter."
            return hint or "Type your answer and press Enter."
        if m.asking or (m.waiting_for_enter() and not m.restarting):
            return "Press Enter here when you're ready."
        return ""

    def final_lines(self, m: SetupModel) -> List[str]:
        """After a stop or a problem, the step's own words in full, to read: those
        the last paint did not already show whole (U6), so the stop words his
        bubble typed out are not said twice, and words it cut short still are."""
        if m.exit_code in (None, 0):
            return []
        p = self.p
        lines = [line for line in [line for line in m.view().said() if line][-8:] if line not in self.shown_whole]
        if not lines:
            return []
        out = [""]
        for line in lines:
            number = _NUMBERED.match(line)
            if number:
                line = f"{p.bold}{p.g}{number.group(1)}{p.reset}{line[len(number.group(1)):]}"
            out.append("  " + line)
        return out

    def body(self, m: SetupModel) -> List[str]:
        """The step in hand in a few short lines."""
        if m.current == 0 and m.resumed:
            # Not "done": a person back from the restart still has steps to go.
            return ["Picking up where you left off.", "A few more steps to go."]
        if m.exit_code == 0 and m.current >= m.total:
            return ["OcuClaw is ready on your glasses.", "Stuck later? discord.ocuclaw.com"]
        if m.restarting:
            return ["This page drops in a few seconds.", "In about a minute, open the link below and send /terminal."]
        lines = m.panel_lines()
        if m.current == 0 and not lines:
            return ["Just eight short steps.", "I'll be on your glasses before you know it!"]
        if m.current == 2 and not lines and not m.asking and m.exit_code is None:
            return [SETTINGS_RECHECK if m.resumed else SETTINGS_WAIT]
        if m.asking and m.question:
            question, _ = split_question(m.question)
            if _in_bubble(question):
                lines = lines + [question]
        return lines


# -- Speck: Code in the bubble ---------------------------------------------------------------

#: What he holds is green like him (Matt's pick, 2026-10-02), except a warning.
_PROP_COLOUR = {
    "concept.warning": "r",
}
_CHEER = ("move.landTick", "move.finishFlag")

#: The pairing screen's words: the phone's own button for manual pairing (#5485).
PAIR_LEAD: Tuple[Seg, ...] = (
    ("On your phone: ", "dim"),
    ("Even › OcuClaw › ", ""),
    ("Pair with your agent", "bold"),
    (", then:", "dim"),
)
PAIR_TYPE = ("Pair manually", "  type the code above and this address:")
#: The code in plain letters beside the big ones, under what he is doing, for
#: anyone who can't read the big ones (Matt, 2026-10-13).
PAIR_CODE_PLAIN = "Code: "
#: The phone asks to pair: the four words take the choices' rows (pairing.py
#: prints them; the 10-row WebUI terminal scrolls its copy out of view).
APPROVE_LEAD = "Match these four words with your phone, in order:"
APPROVE_REFUSE = "If any word differs, type refuse."
#: The small window's pairing lines: where to go on the phone, then what to type.
COMPACT_PAIR_LEAD = "On your phone: Even › OcuClaw › Pair with your agent."
COMPACT_PAIR_TYPE = "Type the code above and this address:"
#: Over Tailscale's links in the small window, which his words leave to the link.
COMPACT_LINK_LEAD = {
    5: "Approve this server in Tailscale:",
    6: "Turn on HTTPS in Tailscale:",
}
#: The small window's restart. The reopened page has /terminal typed in, once
#: it has loaded; a phone sends it with the Send button, since Enter in the
#: WebUI's message box makes a new line there (hermes-webui boot.js). Two rows
#: on a phone's 40 columns, as the words before it were.
RESTART_COMPACT_OPEN = "In about a minute, open this link. Wait until /terminal shows, send it:"
RESTART_COMPACT_RELOAD = "In about a minute, reload this page and send /terminal."
#: The small window's pieces, by rank. When the rows run short the highest go
#: first; rank 0 always stays: the code, the address, the four words, the
#: links and the question.
KEEP, LEAD, TITLE, WHERE, BUSY, SPARE = 0, 1, 2, 3, 4, 5
#: Hints that only say to press Enter, which the question's row already says:
#: the small window leaves them out.
PLAIN_HINTS = ("Type your answer and press Enter.", "Press Enter here when you're ready.")
#: hermes-webui never tells its shell fewer than 8 rows (api/terminal.py), but
#: a phone's panel shows 6, or 5 turned sideways, and cannot grow by touch. A
#: block drawn for the 8 scrolls itself apart, so in the WebUI 8 rows or fewer
#: is drawn as this many. Above the floor the WebUI reports what the panel
#: really shows (a panel dragged open to 13 rows is told 13).
WEBUI_ROWS_FLOOR = 8
WEBUI_PHONE_ROWS = 5
#: The restart screen's link block (wording B, Matt 2026-10-02). The reopened
#: page puts /terminal in its box a moment after it loads; sent sooner, what is
#: sent is garbage, so step 2 says to wait for it (Matt, 2026-10-13). "Send",
#: never "press Enter": on a phone it is the Send button. Each row fits 80
#: columns, but the typed way's longer command.
RESTART_LEAD: Tuple[Seg, ...] = (("In about a minute", "bold"), (", when your agent is back:", "dim"))
RESTART_OPEN = ("Open this link", "  not loaded yet? Refresh it.")
RESTART_ENTER = {
    CARRY_ON_ITSELF: ("Wait until /terminal shows in the box", "  then send it. Setup carries on."),
    CARRY_ON_UP_ARROW: ("Wait until /terminal shows in the box", "  then send it, then Up arrow and Enter."),
    CARRY_ON_TYPED: ("Wait until /terminal shows", f"  send it, then type {RERUN_BASE}."),
}
#: Without the WebUI's address there is no link: the reload, by hand.
RESTART_RELOAD = ("Reload this page", "  then send /terminal")
RESTART_BY_HAND = {
    CARRY_ON_ITSELF: ("Setup carries on by itself", ""),
    CARRY_ON_UP_ARROW: ("Press the Up arrow, then Enter", "  to carry on"),
    CARRY_ON_TYPED: (f"Type {RERUN_BASE}", "  to carry on"),
}


class SpeckLook(Look):
    """Code in the bubble. 88x10 is the WebUI's own size."""

    name = "speck"
    # Every step: Speck big on the left, the bubble to the right edge.
    SW, BX, BH, TAIL_ROW = 47, 49, 8, 2
    # The code screen and the restart: Speck small, the bubble beside him.
    CBX, CBH, RBH = 28, 4, 6
    # All set: a wide bubble beside big Speck.
    AX, AH = 46, 8
    # The code's letters flip left to right over this long, each taking GF.
    FLIP, GF = 0.55, 0.2
    #: His phone glows this long while the letters flip, as the tick lands on it.
    THUMB_AT = 0.62
    #: A step that lands: a small tick pops up by his head, wanted this long.
    LAND = 0.9
    #: Welcome back: he wakes, waves and smiles at you for this long.
    GREET = 6.4
    #: Your glasses' bubble slides in from the right.
    SLIDE = 0.35
    #: A new pose glides in over this long instead of cutting...
    GLIDE = 0.35
    #: ...once it has been wanted this long.
    POSE_HOLD = 0.15
    #: A pose he takes stays at least this long, glide included, so every glide
    #: finishes and a pose that was wanted only for a moment is skipped, not flashed.
    POSE_MIN = 1.0

    def __init__(self, palette: Palette) -> None:
        super().__init__(palette)
        self._poses: Dict[str, Dict[str, Any]] = {}
        self._at: Dict[str, float] = {}
        self._typist = Typist()
        self._step_key: Any = None
        self._done = 0
        self._landed_at = -99.0
        self._last_code = ""
        self._code_life = 1.0

    # -- time ------------------------------------------------------------------

    def _since(self, key: str, on: bool, t: float) -> float:
        """Seconds this moment has lasted, or -1 when it is not happening."""
        if not on:
            self._at.pop(key, None)
            return -1.0
        return max(0.0, t - self._at.setdefault(key, t))

    def _notice(self, m: SetupModel, t: float) -> None:
        """What changed since the last frame: a new step, a step landing, a code."""
        key = (m.current, m.restarting, bool(m.code), m.exit_code)
        if key != self._step_key:
            self._step_key = key
            self._typist.fresh(t)
        done = m.shown_done_count()
        if done > self._done:
            self._landed_at = t
        self._done = done
        if m.code:
            self._last_code = m.code.upper()
            left = m.code_left()
            if left is not None and m.code_seconds:
                self._code_life = max(0.0, min(1.0, left / m.code_seconds))
        else:
            self._at.pop("code", None)
        if m.current != 8:
            self._at.pop("say-hi", None)
        if not m.reply():
            self._at.pop("reply", None)

    def _pose(self, state: str, t: float, size: str) -> Frame:
        """His frame now: the baked loop, or a glide into it when his pose just changed."""
        held = self._poses.get(size)

        def baked(name: str, since: float) -> Frame:
            # His own moves start at their beginning; the engine's loops keep running.
            return speck_frame(name, t - since if name.startswith("move.") else t, size)

        # Drawn again after a pause (another screen, a sign-in): no glide from then.
        if held is None or not 0 <= t - held["t"] <= 0.5:
            live = baked(state, t)
            self._poses[size] = {"state": state, "t": t, "shown": live, "glide": None, "want": (state, t), "since": t}
            return live
        # A pose has to be wanted for a moment before he moves: a step's header
        # and its first words a frame apart make one glide, not two.
        if held["want"][0] != state:
            held["want"] = (state, t)
        if (
            held["state"] != state
            and t - held["want"][1] >= self.POSE_HOLD
            and t - held["since"] >= self.POSE_MIN
        ):
            held["state"], held["since"] = state, t
            held["glide"] = (Glide(held["shown"], baked(state, t)), t)
        live = baked(held["state"], held["since"])
        shown = live
        if held["glide"] is not None:
            glide, since = held["glide"]
            if t - since < self.GLIDE:
                shown = glide.frame((t - since) / self.GLIDE)
            else:
                held["glide"] = None
        held["t"], held["shown"] = t, shown
        return shown

    def _landed_age(self, m: SetupModel, t: float) -> float:
        return 99.0 if m.exit_code == 0 else t - self._landed_at

    def state(self, m: SetupModel, t: float) -> str:
        """What Speck does now."""
        if m.restarting:
            return "idle.nap"
        if m.exit_code is not None:
            return m.speck_state()
        if m.code:
            return "move.signalEyes"
        if self._since("paired", m.paired(), t) >= 0:
            return "move.pairTick"
        greet = self._since("greet", m.resumed and m.current <= 3, t)
        if 0 <= greet < self.GREET:
            return "move.wakeWave"
        if m.current != 8 and self._landed_age(m, t) < self.LAND:
            return "move.landTick"
        own = m.speck_state()
        if self._typist.talking(t) and own not in _CHEER:
            return "concept.speaking"
        return own

    def _colours(self, state: str) -> Tuple[str, str]:
        return self.p.g, getattr(self.p, _PROP_COLOUR.get(state, "g"))

    def _style(self, name: str) -> str:
        p = self.p
        return {"": "", "dim": p.dim, "bold": p.bold, "faint": p.faint}[name]

    # -- the pieces --------------------------------------------------------------

    def _pip_segs(self, m: SetupModel, t: float) -> List[Seg]:
        """The step pips and "3 of 8"."""
        p = self.p
        segs: List[Seg] = []
        done_all = m.exit_code == 0
        for n in range(1, m.total + 1):
            done = m.shown_done(n) or done_all
            cur = m.current == n and not done
            ch = "●" if done else ("◉" if self.blink(t) else "●") if cur else "○"
            segs.append((ch, p.g if done else p.gl if cur else p.faint))
            if n < m.total:
                segs.append((" ", ""))
        if done_all:
            segs.append((f"  {m.total} of {m.total} · done", p.g))
        elif m.shown_step() >= 1:
            segs.append((f"  {m.shown_step()} of {m.total}", p.dim))
        return segs

    def _pips(self, c: Canvas, m: SetupModel, t: float, x: int, w: int, y: int) -> None:
        """The pips, set into a border row near its right end."""
        segs = self._pip_segs(m, t)
        c.segs(x + w - 5 - seg_len(segs), y, [(" ", "")] + segs + [(" ", "")])

    def _typed(self, c: Canvas, x: int, y: int, text: str, shown: int, typing: bool, style: str = "") -> None:
        """Typed words: settled letters in the text colour, the newest few in mint."""
        part = text[:shown]
        head = max(0, len(part) - 3) if typing and shown < len(text) else len(part)
        c.text(x, y, part[:head], style)
        if head < len(part):
            c.text(x + head, y, part[head:], self.p.gl)

    def _flip(self, c: Canvas, x: int, y: int, old: str, new: str, age: float, old_st: str, new_st: str) -> None:
        """Glyphs that flip one by one, left to right, like a split-flap sign."""
        n = max(len(old), len(new))
        p = self.p
        for i in range(n):
            start = i * (self.FLIP - self.GF) / (n - 1) if n > 1 else 0.0
            f = (age - start) / self.GF
            a = old[i] if i < len(old) else " "
            b = new[i] if i < len(new) else " "

            def gx(ch: str, i: int = i) -> int:
                return x + i * 3 + (1 if ch == "✓" else 0)  # the tick sits a cell clear

            if f <= 0:
                big_draw(c, gx(a), y, a, old_st)
            elif f >= 1:
                big_draw(c, gx(b), y, b, p.fg if age - start - self.GF < 1 / 12 else new_st)
            else:
                band = 3.5 * abs(2 * f - 1)
                if band < 1:
                    # Edge on: one line of dots across the glyph's middle.
                    c.text(x + i * 3, y, "⣀⣀⡀", p.dim)
                    continue
                ch = a if f < 0.5 else b
                big_draw(
                    c, gx(ch), y, ch, old_st if f < 0.5 else new_st, mask=lambda px, py, band=band: abs(py - 3) <= band
                )

    def _flip_in(self, c: Canvas, x: int, y: int, word: str, age: float, style: str) -> None:
        """A big word flips in letter by letter, like the code does."""
        n = len(word)
        for i, ch in enumerate(word):
            f = (age - (i * (self.FLIP - self.GF) / (n - 1) if n > 1 else 0.0)) / self.GF
            if f <= 0.5:
                if f > 0:
                    c.text(x + i * 3, y, "⣀⣀⡀", self.p.dim)
                continue
            band = 3.5 * abs(2 * min(1.0, f) - 1)
            big_draw(c, x + i * 3, y, ch, style, mask=None if f >= 1 else (lambda px, py, band=band: abs(py - 3) <= band))

    def _countdown(self, c: Canvas, x: int, y: int, w: int, m: SetupModel, t: float) -> None:
        """The bubble's bottom border as the countdown: a thick green line draining to its dots."""
        p = self.p
        life = m.code_seconds or 300
        left = m.code_left()
        left = life if left is None else left
        urgent = left < 60
        on, low = (p.y, p.y_low) if urgent else (p.g, p.gd)
        clock = mmss(left)
        bw = self._bar_cells(w, clock)
        exact = left / life * bw
        n = max(1 if left > 0 else 0, math.ceil(exact))
        for i in range(bw):
            if i < n:
                c.put(x + 3 + i, y, _THICK, low if i == n - 1 and exact - (n - 1) < 0.5 else on)
            else:
                c.put(x + 3 + i, y, _THIN, p.faint)
        # A soft light runs the way it drains, right to left, every 2.4 s.
        at = n - 1 - int(((t % 2.4) / 2.4) * (n + 14))
        for i in range(3):
            cx = at + i
            if 0 <= cx < n - 1:
                c.put(x + 3 + cx, y, _THICK, (p.y_glint if urgent else p.gl) if i == 1 else on)
        lx = c.text(x + 3 + bw, y, " ")
        lx = c.text(lx, y, clock, p.bold + (p.y if urgent else p.fg))
        c.text(lx, y, " left ", p.y if urgent else p.dim)

    @staticmethod
    def _bar_cells(w: int, clock: str = "0:00") -> int:
        """Cells of the code's countdown: between the bubble's round corners and its label."""
        return w - 7 - len(f" {clock} left ")

    def _choices(self, c: Canvas, m: SetupModel, faint: bool) -> None:
        """Rows 4-6 of the pairing screen, the same in every frame."""
        p = self.p

        def st(name: str) -> str:
            return p.faint if faint else self._style(name)

        num = p.faint if faint else p.bold + p.g
        c.segs(0, 4, [(text, st(name)) for text, name in PAIR_LEAD])
        y = 5
        c.text(0, y, "1", num)
        x = c.text(3, y, PAIR_TYPE[0], st("bold"))
        c.text(x, y, PAIR_TYPE[1], st("dim"))
        if m.address:
            c.text(3, y + 1, m.address, st(""))

    def _link_block(self, c: Canvas, m: SetupModel, y: int) -> None:
        """The restart frame's last four rows: all that stays in view after the page drops."""
        p = self.p
        num = p.bold + p.g
        c.segs(0, y, [(text, self._style(name)) for text, name in RESTART_LEAD])
        if m.reopen:
            first, second = RESTART_OPEN, RESTART_ENTER[m.carry_on]
        else:
            first, second = RESTART_RELOAD, RESTART_BY_HAND[m.carry_on]
        c.text(0, y + 1, "1", num)
        x = c.text(3, y + 1, first[0], p.bold)
        c.text(x, y + 1, first[1], p.dim)
        if m.reopen:
            c.text(3, y + 2, m.reopen, p.c + p.under)
        c.text(0, y + 3, "2", num)
        x = c.text(3, y + 3, second[0], p.bold)
        c.text(x, y + 3, second[1], p.dim)

    def _dozing(self, c: Canvas, t: float) -> None:
        """Little z's rise from his head while he sleeps, into the gap before the tail."""
        asleep = self._since("asleep", True, t) - 0.5
        if asleep < 0:
            return
        life = 2.1
        p = self.p
        for k in range(3):
            a = asleep - k * (life / 3)
            if a < 0:
                continue
            f = (a % life) / life
            x = round(19 + f * 4 + math.sin(f * 7 + k * 2) * 0.6)
            y = round(2.4 - f * 2.6)
            if y < 0 or not c.empty(x, y):
                continue
            c.put(x, y, "z" if f < 0.45 else "Z", p.faint if f < 0.25 else p.dim if f < 0.75 else p.faint)

    def _help(self, c: Canvas, x: int, y: int, text: str, style: str) -> int:
        """A line whose web address shows in the link colour."""
        for part in _WEB_ADDRESS.split(text):
            if part:
                x = c.text(x, y, part, self.p.c if _WEB_ADDRESS.fullmatch(part) else style)
        return x

    # -- the screens ---------------------------------------------------------------

    def _main(self, c: Canvas, m: SetupModel, t: float, st: str) -> None:
        """Every step: Speck says it in his bubble; a question steps out under it."""
        p = self.p
        bx, bh = self.BX, self.BH
        bw = c.cols - bx
        tx, tw = bx + 2, bw - 4
        body, prop = self._colours(st)
        c.speck(0, 1, st, t, "big", crop=(0, self.SW - 1), body=body, prop=prop, frame=self._pose(st, t, "big"))
        border, title = (p.r, p.bold) if m.exit_code not in (None, 0) else (p.dim, p.bold)
        bubble(c, bx, 0, bw, bh, border, row=self.TAIL_ROW)
        c.text(bx + 3, 0, f" {trunc(m.title(), bw - 8)} ", title)
        self._pips(c, m, t, bx, bw, bh - 1)
        kind, status = self.status(m, t)
        busy = kind == "busy"
        said = self._typist.shown(self.body(m), t)
        lines = bubble_lines(said, tw)
        # Which rows start a line, so a choice's number takes the number colour (Matt, 2026-10-03).
        starts = [k == 0 for text, _ in said for k in range(len(bubble_lines([(text, 0)], tw)))]
        room = bh - 3 if busy else bh - 2
        if self.final:
            # The last paint: which lines it shows whole, each typed out with every row kept.
            first = len(lines) - room
            for text, shown in said:
                if first <= 0 and shown >= len(text):
                    self.shown_whole.add(text)
                first -= len(bubble_lines([(text, 0)], tw))
        lines, starts = lines[-room:], starts[-room:]
        for i, (text, shown, typing) in enumerate(lines):
            self._typed(c, tx, 1 + i, text, shown, typing)
            number = _NUMBERED.match(text)
            if number and starts[i] and shown >= len(number.group(1)):
                c.text(tx, 1 + i, number.group(1), p.bold + p.g)
        if busy:
            c.segs(tx, min(bh - 2, 1 + len(lines) + (1 if lines else 0)), status, tw)
        hint = self.hint(m)
        if kind == "ask" and not m.typed and self._typist.talking(t):
            # He says the step before he asks: the question waits for his last word.
            kind, status, hint = "", [], ""
        if kind == "ask":
            # The question steps out of the bubble: a prompt line under it, the hint under that.
            px = max(0, min(bx, c.cols - 1 - max(len(hint), seg_len(status))))
            c.segs(px, bh, status)
            if hint:
                c.text(px, bh + 1, trunc(hint, c.cols - px), p.dim)
        elif hint:
            c.text(bx, bh + 1, trunc(hint, c.cols - bx), p.dim)
        if m.approve and kind != "ask":
            # Tailscale's approval link on the last row, under his feet, the same every
            # frame: a click opens it.
            px = max(0, min(bx, c.cols - 3 - len(m.approve)))
            c.text(px, bh + 1, "› ", p.g)
            c.text(px + 2, bh + 1, m.approve, p.c + p.under)
        # A step lands: the border flashes mint for two frames.
        if 0 <= self._landed_age(m, t) < 2 / 12:
            c.tint(bx - 3, 0, c.cols - 1, bh - 1, border, p.gl)

    def _code(self, c: Canvas, m: SetupModel, t: float, st: str) -> None:
        """The code, big, in the bubble; the countdown is its bottom border."""
        p = self.p
        cbx, cbh = self.CBX, self.CBH
        cbw = c.cols - cbx
        body, prop = self._colours(st)
        c.speck(0, 0, st, t, "mini", body=body, prop=prop, frame=self._pose(st, t, "mini"))
        bubble(c, cbx, 0, cbw, cbh, p.dim, row=1)
        c.text(cbx + 3, 0, f" {trunc(m.title(), 26)} ", p.bold)
        self._pips(c, m, t, cbx, cbw, 0)
        code = (m.code or "").upper()
        # The code flips in, letter by letter, as the screen arrives.
        self._flip(c, cbx + 2, 1, " " * len(code), code, self._since("code", True, t), p.fg, p.fg)
        kind, status = self.status(m, t)
        sx = cbx + 2 + big_width(code) + 3
        room = cbx + cbw - 2 - sx
        if m.words:
            # A phone asks to pair: who it is beside the code, the four words under it.
            c.text(sx, 1, trunc(f"{m.device or 'A phone'} wants to pair.", room), p.bold)
            c.text(sx, 2, trunc("Match the words below.", room), p.dim)
        else:
            if kind:
                c.segs(sx, 1, status, room)
            # The code in plain letters too, under what he is doing: not everyone reads the big ones.
            c.segs(sx, 2, [(PAIR_CODE_PLAIN, p.dim), (code, p.bold)], room)
        self._countdown(c, cbx, cbh - 1, cbw, m, t)
        if m.words:
            self._approval(c, m, status if kind == "ask" else [])
            return
        # From here down nothing changes from frame to frame: the link stays clickable.
        self._choices(c, m, faint=False)

    def _phone_words(self, c: Canvas, m: SetupModel, t: float, st: str) -> None:
        """A phone asks to pair after a phone code: there is no pairing code to
        show, so who asks heads the bubble and the four words sit under it, as
        on the code screen."""
        p = self.p
        cbx, cbh = self.CBX, self.CBH
        cbw = c.cols - cbx
        body, prop = self._colours(st)
        c.speck(0, 0, st, t, "mini", body=body, prop=prop, frame=self._pose(st, t, "mini"))
        bubble(c, cbx, 0, cbw, cbh, p.dim, row=1)
        c.text(cbx + 3, 0, f" {trunc(m.title(), 26)} ", p.bold)
        self._pips(c, m, t, cbx, cbw, 0)
        room = cbw - 4
        c.text(cbx + 2, 1, trunc(f"{m.device or 'A phone'} wants to pair.", room), p.bold)
        c.text(cbx + 2, 2, trunc("Match the words below.", room), p.dim)
        kind, status = self.status(m, t)
        self._approval(c, m, status if kind == "ask" else [])

    def _approval(self, c: Canvas, m: SetupModel, ask: List[Seg]) -> None:
        """Rows 4-9 of the pairing screen while a phone asks to pair: the four
        words in their box, as pairing.py prints them, and the question under them."""
        p = self.p
        c.text(0, 4, APPROVE_LEAD, p.dim)
        inner = "   " + "   ".join(m.words or []) + "   "
        c.text(2, 5, "┌" + "─" * len(inner) + "┐", p.dim)
        c.text(2, 6, "│", p.dim)
        c.text(3, 6, inner, p.bold)
        c.text(3 + len(inner), 6, "│", p.dim)
        c.text(2, 7, "└" + "─" * len(inner) + "┘", p.dim)
        c.text(0, 8, APPROVE_REFUSE, p.dim)
        if ask:
            c.segs(0, 9, ask)

    def _paired(self, c: Canvas, m: SetupModel, t: float, st: str) -> None:
        """The code flips to PAIRED ✓ and the bubble goes green."""
        p = self.p
        cbx, cbh = self.CBX, self.CBH
        cbw = c.cols - cbx
        age = self._since("paired", True, t)
        # A tick lands on the phone in his hand while the letters flip; it lights as they land.
        if age < self.THUMB_AT:
            glow = p.fg if age < 1 / 12 or age > self.FLIP - 1 / 12 else p.gl
            c.speck(0, 0, st, t, "mini", body=p.g, prop=glow, frame=self._pose(st, t, "mini"))
        else:
            body, prop = self._colours(st)
            c.speck(0, 0, st, t, "mini", body=body, prop=prop, frame=self._pose(st, t, "mini"))
        bubble(c, cbx, 0, cbw, cbh, p.g, row=1)
        c.text(cbx + 3, 0, f" {m.title()} ", p.bold + p.g)
        self._pips(c, m, t, cbx, cbw, 0)
        old = self._last_code
        self._flip(c, cbx + 2, 1, old, "PAIRED✓".ljust(len(old)), age, p.fg, p.gl)
        # The countdown fills back up to a full green border as the letters flip.
        bw = cbw - 6
        n0 = max(1, math.ceil(self._code_life * self._bar_cells(cbw)))
        n = round(n0 + (bw - n0) * ease(age / self.FLIP))
        for i in range(bw):
            head = age < self.FLIP and n - 2 <= i < n
            c.put(cbx + 3 + i, cbh - 1, _THICK if i < n else _THIN, (p.gl if head else p.g) if i < n else p.faint)
        # The link and address go faint; still drawn whole, still the same every frame.
        self._choices(c, m, faint=True)

    def _restart(self, c: Canvas, m: SetupModel, t: float) -> None:
        """Speck dozes beside RESTARTING over the link that brings the terminal back."""
        p = self.p
        bx, bh = self.CBX, self.RBH
        bw = c.cols - bx
        c.speck(0, 1, "idle.nap", t, "mini", body=p.g, prop=p.g, frame=self._pose("idle.nap", t, "mini"))
        self._dozing(c, t)
        bubble(c, bx, 0, bw, bh, p.faint, row=1)
        c.text(bx + 3, 0, f" {m.title()} ", p.bold + p.dim)
        self._pips(c, m, t, bx, bw, 0)
        self._flip_in(c, bx + 3, 1, "RESTARTING", self._since("restart", True, t), p.fg)
        sx = bx + 3 + big_width("RESTARTING") + 3
        c.text(sx, 1, self.spin(t), p.g)
        c.text(sx + 2, 1, "Dropping now.")
        c.text(sx + 2, 2, "That's expected.", p.dim)
        c.text(bx + 3, 4, trunc(self.body(m)[0], bw - 6), p.dim)
        # The bottom border says how long, like the code's countdown says what is left.
        tag = " back in about a minute "
        c.text(bx + bw - 3 - len(tag), bh - 1, tag, p.dim)
        # From here down nothing changes from frame to frame.
        self._link_block(c, m, bh)

    def _say_hi(self, c: Canvas, m: SetupModel, t: float, st: str) -> None:
        """Step 8: your glasses answer in a bubble of their own."""
        p = self.p
        bx = self.BX
        bw = c.cols - bx
        tx, tw = bx + 2, bw - 4
        body, prop = self._colours(st)
        c.speck(0, 1, st, t, "big", crop=(0, self.SW - 1), body=body, prop=prop, frame=self._pose(st, t, "big"))
        kind, status = self.status(m, t)
        if m.asking and m.question:
            self._ask_hi(c, m, t, status)
            return
        bubble(c, bx, 0, bw, 4, p.dim, row=1)
        c.text(bx + 3, 0, f" {trunc(m.title(), bw - 8)} ", p.bold)
        self._pips(c, m, t, bx, bw, 3)
        y = 1
        for text, shown in self._typist.shown(self.body(m)[-1:], t):
            self._typed(c, tx, y, trunc(text, tw), min(shown, tw), shown < len(text))
            y += 1
        if kind:
            c.segs(tx, y, status, tw)
        hint = self.hint(m)
        if hint:
            c.text(bx, 9, trunc(hint, c.cols - bx), p.dim)
        right = c.cols - 4
        reply = m.reply()
        reply = (condense(reply) or reply) if reply else reply
        if reply:
            lines = wrap(reply, 24)[:2]
            w = max(len(line) for line in lines) + 6
            x = right - w + 1
            bubble(c, x, 5, w, 4, p.g, row=1, right=True)
            fresh = self._since("reply", True, t) < 1 / 12
            c.put(x + 2, 6, "✓", p.bold + p.g)
            for i, line in enumerate(lines):
                c.text(x + 4, 6 + i, line, p.fg if fresh else p.gl)
            return
        w = 14
        home = right - w + 1
        x = round(c.cols + 1 - (c.cols + 1 - home) * ease(self._since("say-hi", True, t) / self.SLIDE))
        bubble(c, x, 5, w, 4, p.faint, row=1, right=True)
        # Three round dots light in turn, like someone typing.
        slot = int(((t % 1.2) / 1.2) * 4)
        for i in range(3):
            fg = p.y if slot == i else p.dim if slot == i + 1 else p.faint
            c.text(x + 3 + i * 3, 6, "⣠⣄", fg)
            c.text(x + 3 + i * 3, 7, "⠙⠋", fg)

    def _ask_hi(self, c: Canvas, m: SetupModel, t: float, status: Sequence[Seg]) -> None:
        """Step 8 asks whether the reply reached the glasses: the question whole.

        Two rows held the reason and the question, so both were cut short in an
        87-column WebUI terminal (2026-10-11, Cloudways). The bubble now grows
        down to the hint row as it needs, the question wraps at its words, and
        only the reason above it gives way. No reply bubble: there is no
        verdict until the answer.
        """
        p = self.p
        bx = self.BX
        bw = c.cols - bx
        tx, tw = bx + 2, bw - 4
        prompt = wrap_segs(status, tw)
        lines = bubble_lines(self._typist.shown(self.body(m)[-1:], t), tw)
        room = max(0, c.rows - 3 - len(prompt))
        if len(lines) > room:
            lines = lines[:room]
            if lines:
                last, shown, typing = lines[-1]
                text = last[: tw - 1].rstrip() + "…"
                lines[-1] = (text, len(text) if shown >= len(last) else min(shown, len(text)), typing)
        bh = max(4, 2 + len(lines) + len(prompt))
        bubble(c, bx, 0, bw, bh, p.dim, row=1)
        c.text(bx + 3, 0, f" {trunc(m.title(), bw - 8)} ", p.bold)
        self._pips(c, m, t, bx, bw, bh - 1)
        y = 1
        for text, shown, typing in lines:
            self._typed(c, tx, y, text, shown, typing)
            y += 1
        for segs in prompt:
            c.segs(tx, y, segs, tw)
            y += 1
        hint = self.hint(m)
        if hint:
            c.text(bx, c.rows - 1, trunc(hint, c.cols - bx), p.dim)

    def _all_set(self, c: Canvas, m: SetupModel, t: float) -> None:
        """ALL SET! in one wide bubble, confetti outside it."""
        p = self.p
        ax, ah = self.AX, self.AH
        aw = c.cols - ax
        age = self._since("all-set", True, t)
        frame = self._pose("move.finishFlag", t, "big")
        c.speck(0, 1, "move.finishFlag", t, "big", crop=(0, ax - 4), body=p.g, prop=p.gl, frame=frame)
        bubble(c, ax, 0, aw, ah, p.g, row=2)
        self._pips(c, m, t, ax, aw, ah - 1)
        inner = aw - 2
        word = m.title().upper()
        ww = big_width(word)
        # The letters land white and a light runs across them once.
        sweep = (age / 0.6) * (ww + 6) - 3

        def shade(gi: int, cx: int) -> str:
            return p.fg if age < 1 / 12 or abs(gi * 3 + cx - sweep) < 2 else p.gl

        big_draw(c, ax + 1 + (inner - ww) // 2, 1, word, shade, solid=True, bold=True)
        for i, line in enumerate(self.body(m)[:2]):
            text = trunc(line, inner - 2)
            x = ax + 1 + (inner - len(text)) // 2
            if i == 0:
                c.text(x, 4, text, p.fg)
            else:
                self._help(c, x, 5, text, p.dim)
        # The bubble's inside counts as drawn while the confetti falls, so none
        # lands in it; then its blank braille goes back to plain spaces, so a
        # copy of the terminal reads clean.
        inside = [(x, y) for y in range(1, ah - 1) for x in range(ax + 1, ax + aw - 1)]
        for x, y in inside:
            if c.empty(x, y):
                c.put(x, y, _BRAILLE_BLANK)
        confetti(c, age)
        for x, y in inside:
            if c.get(x, y)[0] == _BRAILLE_BLANK:  # type: ignore[index]
                c.put(x, y, " ")

    def _settled(self, m: SetupModel, cols: int) -> List[Row]:
        """What stays in scrollback: calm, small Speck and the bubble with the closing lines."""
        p = self.p
        c = Canvas(cols, 4, p)
        c.speck(0, 0, "move.finishFlag", 7.99, "mini", body=p.g, prop=p.gl)
        lines = self.body(m)
        ready, help_ = lines[0], (lines[1] if len(lines) > 1 else "")
        x = self.CBX
        w = min(cols - x, max(len(ready) + 2, len(help_)) + 6)
        bubble(c, x, 0, w, 4, p.gd, row=1)
        c.text(x + 3, 0, f" {m.title()} ", p.bold + p.g)
        c.put(x + 2, 1, "✓", p.bold + p.g)
        c.text(x + 4, 1, ready, p.gl)
        if help_:
            self._help(c, x + 4, 2, help_, p.dim)
        return canvas_rows(c)

    # -- drawing ---------------------------------------------------------------------

    def draw(self, m: SetupModel, t: float, cols: int, rows: int) -> List[Row]:
        self._notice(m, t)
        self.shown_whole = set()
        if cols < 80 or rows < 10:
            return self.compact(m, t, cols, rows)
        finished = m.exit_code == 0 and m.current >= m.total
        if finished and self.final:
            return self._settled(m, cols)
        c = Canvas(cols, 10, self.p)
        st = self.state(m, t)
        if finished:
            self._all_set(c, m, t)
        elif m.restarting:
            self._restart(c, m, t)
        elif m.code:
            self._code(c, m, t, st)
        elif m.sent and m.words:
            self._phone_words(c, m, t, st)
        elif m.paired():
            self._paired(c, m, t, st)
        elif m.current == 8 and m.exit_code is None:
            self._say_hi(c, m, t, st)
        else:
            self._main(c, m, t, st)
        return self._long_links(canvas_rows(c), m, cols)

    def _long_links(self, out: List[Row], m: SetupModel, cols: int) -> List[Row]:
        """A link too long for its row is left to the terminal to wrap, still one link."""
        p = self.p
        for link in (m.reopen,):
            if not link or 3 + len(link) <= cols:
                continue
            for i, row in enumerate(out):
                if strip_ansi(row.text).startswith("   " + link[: cols - 3]):
                    out[i] = wrapped_row(link, p.c + p.under, cols, p, indent=0)
        return out

    def compact(self, m: SetupModel, t: float, cols: int, rows: int) -> List[Row]:
        """Under 80 columns or 10 rows (a phone, or a small window): a small
        Speck beside the step's title, then his words, the step's links and
        code, and last the question with what to type, next to the keyboard.
        Nothing is cut short: a phone can't scroll a row sideways, and a link or
        an address that can't be tapped or copied there has to be read whole to
        be typed."""
        p = self.p
        width = max(10, cols - 2)
        st = self.state(m, t)
        kind, status = self.status(m, t)
        # What he says, wrapped; a choice's number takes the number colour here too (Matt, 2026-10-03).
        said: List[List[Row]] = []
        words = self.body(m)
        for raw in words:
            lines: List[Row] = []
            for k, line in enumerate(wrap(raw, width)):
                number = _NUMBERED.match(line) if k == 0 else None
                if number:
                    line = f"{p.bold}{p.g}{number.group(1)}{p.reset}{line[len(number.group(1)):]}"
                lines.append(Row(" " + line))
            said.append(lines)
        # The step's links, code and words: the same from frame to frame.
        still = self._compact_still(m, cols, width)
        # The question and what to type, wrapped so what is typed shows; or
        # what he is busy with.
        ask: List[Tuple[int, List[Row]]] = []
        if kind:
            # Up to the last column, so the cursor does not wrap onto a row of its own.
            prompt = wrap_segs(status, cols - 1)
            ask.append((KEEP if kind == "ask" else BUSY, [Row(" " + seg_str(line, p)) for line in prompt]))
        if kind == "ask":
            hint = self.hint(m)
            if hint and hint not in PLAIN_HINTS:
                rank = SPARE if hint == "Then press Enter." else LEAD
                ask.append((rank, [Row(f" {p.dim}{line}{p.reset}") for line in wrap(hint, width)]))
        fixed = sum(r.height for _, rows_ in still + ask for r in rows_)
        # His picture when there is room for it, else one line with the step.
        # Room for him and every pip beside him (26 columns, then two per step).
        said_rows = sum(len(lines) for lines in said)
        step = m.shown_step()
        if cols >= 26 + 2 * m.total and 4 + fixed + min(said_rows, 2) <= rows:
            c = Canvas(cols, 4, p)
            body, prop = self._colours(st)
            c.speck(0, 0, st, t, "mini", body=body, prop=prop, frame=self._pose(st, t, "mini"))
            title = wrap(m.title(), cols - 27)
            c.text(26, 0, title[0] if title else "", p.bold)
            if len(title) > 1:
                c.text(26, 1, trunc(" ".join(title[1:]), cols - 27), p.bold)
            c.segs(26, 2, self._pip_segs(m, t)[: 2 * m.total - 1])
            if 1 <= step <= m.total:
                c.text(26, 3, f"step {step} of {m.total}", p.dim)
            head = canvas_rows(c)
        else:
            count = f" · {step} of {m.total}" if 1 <= step <= m.total else ""
            title = wrap(m.title(), width - len(count))
            head = [
                Row(f" {p.bold}{line}{p.reset}" + (f"{p.dim}{count}{p.reset}" if k == len(title) - 1 else ""))
                for k, line in enumerate(title)
            ]
        # Short of rows (a phone's WebUI panel shows 5 or 6), the title and then
        # the pieces by rank go, until the code, the address, the links and the
        # question fit; the first of equal ranks goes first.
        pieces = [(TITLE, head)] + still + ask
        while sum(r.height for _, rows_ in pieces for r in rows_) > rows:
            worst = max(rank for rank, _ in pieces)
            if worst == KEEP:
                break
            pieces.pop(next(i for i, (rank, _) in enumerate(pieces) if rank == worst))
        top = pieces.pop(0)[1] if pieces[0][1] is head else []
        rest = [row for _, rows_ in pieces for row in rows_]
        # Then his newest words, a whole line at a time, while they fit.
        room = max(0, rows - sum(r.height for r in top + rest))
        kept: List[Row] = []
        for raw, lines in zip(reversed(words), reversed(said)):
            if len(lines) > room:
                break
            kept[:0] = lines
            room -= len(lines)
            if self.final:
                self.shown_whole.add(raw)
        return top + kept + rest

    def _compact_still(self, m: SetupModel, cols: int, width: int) -> List[Tuple[int, List[Row]]]:
        """The compact look's links, code and words, wrapped to the window, never
        cut, each piece with its rank (``KEEP`` stays whatever the rows)."""
        p = self.p
        out: List[Tuple[int, List[Row]]] = []

        def say(rank: int, text: str, style: str = "") -> None:
            out.append((rank, [Row(f" {style}{line}{p.reset}" if style else f" {line}") for line in wrap(text, width)]))

        def link(url: str, style: Optional[str] = None) -> None:
            out.append((KEEP, [wrapped_row(url, p.c + p.under if style is None else style, cols, p, indent=1)]))

        def approval(words_list: List[str]) -> List[Tuple[int, List[Row]]]:
            say(TITLE, f"{m.device or 'A phone'} wants to pair.", p.bold)
            say(LEAD, APPROVE_LEAD, p.dim)
            # Spaced apart as on the big screen when they fit on one line.
            words = "   ".join(words_list)
            if len(words) <= width:
                out.append((KEEP, [Row(f" {p.bold}{p.g}{words}{p.reset}")]))
            else:
                say(KEEP, " ".join(words_list), p.bold + p.g)
            say(SPARE, APPROVE_REFUSE, p.dim)
            return out

        if m.code:
            left = m.code_left()
            expiry = f"expires in {mmss(left)}" if left is not None else "expires soon"
            # The code's letters spaced apart when the row has room, else close.
            code = " ".join(m.code.upper())
            if 4 + len(code) + len(expiry) > width:
                code = m.code.upper()
            chip = Row(" " + seg_str([(f" {code} ", p.chip), ("  " + expiry, p.dim)], p))
            if m.words:
                # The code is typed already: the four words and the question matter now.
                out.append((WHERE, [chip]))
                return approval(m.words)
            out.append((KEEP, [chip]))
            say(WHERE, COMPACT_PAIR_LEAD, p.dim)
            if m.address:
                say(LEAD, COMPACT_PAIR_TYPE)
                link(m.address, "")
            return out
        if m.sent and m.words:
            # After a phone code there is no code to show, only who asks and the words.
            return approval(m.words)
        if m.restarting:
            if m.reopen:
                say(LEAD, RESTART_COMPACT_OPEN, p.bold)
                link(m.reopen)
            else:
                say(LEAD, RESTART_COMPACT_RELOAD, p.bold)
            return out
        if m.approve:
            lead = COMPACT_LINK_LEAD.get(m.current)
            if lead:
                say(LEAD, lead, p.bold)
            link(m.approve)
        return out


# -- the live block -------------------------------------------------------------------


class _LookIn:
    """The ladder's input: whole lines from the look's own line editor."""

    def __init__(self, live: "LiveTerminal") -> None:
        self._live = live
        self.encoding = "utf-8"

    def fileno(self) -> int:
        return self._live.pipe_read

    def isatty(self) -> bool:
        return True

    def readline(self, size: int = -1) -> str:
        del size
        self._live.model.ask_begin()
        self._live.wake()
        data = bytearray()
        answer = ""
        try:
            while True:
                chunk = os.read(self._live.pipe_read, 1)
                if not chunk:
                    break
                data.extend(chunk)
                if chunk == b"\n":
                    break
            answer = data.decode("utf-8", "replace")
            return answer
        finally:
            self._live.model.ask_end(answer)
            self._live.wake()

    def read(self, size: int = -1) -> str:
        return self.readline()

    def close(self) -> None:
        pass


class _LookOut:
    """The ladder's output: into the model, drawn by the look."""

    def __init__(self, live: "LiveTerminal") -> None:
        self._live = live
        self.encoding = "utf-8"
        self.errors = "replace"

    def write(self, text: str) -> int:
        self._live.feed(str(text))
        return len(text)

    def flush(self) -> None:
        # "What it should show, it shows now": the restart step flushes before
        # the container goes, so the block is drawn before this returns.
        self._live.paint()

    def isatty(self) -> bool:
        return True

    def fileno(self) -> int:
        return self._live.out_fd

    def close(self) -> None:
        pass


def _wait_readable(fd: int, timeout: float) -> bool:
    """True once ``fd`` has input, False when ``timeout`` runs out.

    A selector, not ``select()``: ``select()`` refuses any fd numbered 1024 or
    higher (#5121). epoll refuses regular files and ``/dev/null``, which
    ``select()`` always reports readable, so they stay readable here.
    """
    with selectors.DefaultSelector() as waiting:
        try:
            waiting.register(fd, selectors.EVENT_READ)
        except PermissionError:
            return True
        return bool(waiting.select(timeout))


class LiveTerminal:
    """The block at the bottom of the terminal, and the keys typed into it."""

    def __init__(
        self,
        look: Look,
        model: SetupModel,
        real_in: Any,
        real_out: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        fps: float = FPS,
        min_step_s: Optional[float] = None,
        intro_s: Optional[float] = None,
        t_offset: Optional[float] = None,
    ) -> None:
        self.look = look
        self.model = model
        self.real_in = real_in
        self.real_out = real_out
        self.in_fd = real_in.fileno()
        self.out_fd = real_out.fileno()
        self.clock = clock
        self.sleep = sleep
        self.fps = fps
        self.min_step_s = MIN_STEP_SECONDS if min_step_s is None else min_step_s
        self.intro_s = INTRO_SECONDS if intro_s is None else intro_s
        self.pipe_read, self.pipe_write = os.pipe()
        self.stdin = _LookIn(self)
        self.stdout = _LookOut(self)
        self._typed = ""
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._escape = ""
        self._saved_tty: Any = None
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._changed = threading.Event()
        self._paint_lock = threading.RLock()
        self._threads: List[threading.Thread] = []
        self._drawn: List[Row] = []
        self._drawn_rows = 0
        self._full_at = 0.0
        self._size: Optional[Tuple[int, int]] = None
        self._t0 = clock()
        #: Taking the block over from hermes.sh's intro: its idle loop's time, so
        #: Speck carries on, and its block to draw over from the top.
        self._t_offset = t_offset or 0.0
        self._over_intro = t_offset is not None
        self._old_signals: Dict[int, Any] = {}
        self._eof = False
        self._last_step_at = self._t0
        self._last_line_at = self._t0
        from . import webui_terminal

        self._webui = webui_terminal.active()

    # -- lifecycle --------------------------------------------------------------

    def start(self) -> None:
        import termios
        import tty

        self._saved_tty = termios.tcgetattr(self.in_fd)
        tty.setcbreak(self.in_fd)
        for sig in (signal.SIGTERM, signal.SIGHUP):
            try:
                self._old_signals[sig] = signal.signal(sig, self._on_signal)
            except (ValueError, OSError):  # not the main thread: no handler
                pass
        atexit.register(self._at_exit)
        self._write("\x1b[?25l")
        self.paint()
        for target, name in ((self._input_loop, "setup-look-keys"), (self._render_loop, "setup-look-draw")):
            thread = threading.Thread(target=target, name=name, daemon=True)
            thread.start()
            self._threads.append(thread)
        if self.intro_s > 0:
            self.sleep(self.intro_s)
        self._last_step_at = self.clock()

    def stop(self, exit_code: int) -> None:
        self.model.finish(exit_code)
        model = self.model
        if exit_code == 0 and model.current >= model.total and not self._paused.is_set():
            # The ending is the reward: let it play before the block settles.
            self.wake()
            self.sleep(CELEBRATE_SECONDS)
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=1.0)
        self.paint(final=True)
        tail = self.look.final_lines(self.model)
        self._write("\x1b[0m\n" + "".join(line + "\n" for line in tail) + "\x1b[?25h")
        self._restore()
        atexit.unregister(self._at_exit)
        for fd in (self.pipe_read, self.pipe_write):
            try:
                os.close(fd)
            except OSError:
                pass

    def _at_exit(self) -> None:
        # An exception that escaped the ladder must not leave the terminal
        # without echo or a cursor.
        if not self._stop.is_set():
            self._stop.set()
            self._write("\x1b[0m\n\x1b[?25h")
        self._restore()

    def _restore(self) -> None:
        if self._saved_tty is not None:
            try:
                import termios

                termios.tcsetattr(self.in_fd, termios.TCSADRAIN, self._saved_tty)
            except Exception:  # noqa: BLE001 - nothing left to restore it with
                pass
        for sig, old in self._old_signals.items():
            try:
                signal.signal(sig, old)
            except (ValueError, OSError):
                pass
        self._old_signals = {}

    def _on_signal(self, signum: int, frame: Any) -> None:
        del frame
        self._write("\x1b[0m\x1b[?25h\n")
        self._restore()
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    @contextmanager
    def suspended(self) -> Iterator[None]:
        """Hand the real terminal to a child, such as a sign-in, then take it back."""
        with self._paint_lock:
            self._paused.set()
            self._write("\x1b[0m\n\x1b[?25h")
            self._drawn, self._drawn_rows = [], 0
            if self._saved_tty is not None:
                import termios

                termios.tcsetattr(self.in_fd, termios.TCSADRAIN, self._saved_tty)
        try:
            yield
        finally:
            import tty

            try:
                tty.setcbreak(self.in_fd)
            except Exception:  # noqa: BLE001 - a lost terminal just draws less
                pass
            self._write("\x1b[?25l")
            self._paused.clear()
            self.wake()

    def wake(self) -> None:
        self._changed.set()

    def feed(self, text: str) -> None:
        """Setup's output into the model, holding before each new step.

        The hold happens here, outside the model's lock, so the look keeps
        moving while a step that went by fast is still on screen.
        """
        start = 0
        at_line_start = self.model.partial == ""
        for line in re.finditer(r"[^\n]*\n|[^\n]+", text):
            if at_line_start:
                header = _STEP_START.match(strip_ansi(line.group(0)).lstrip())
                if header:
                    self._feed(text[start : line.start()])
                    self._before_step(int(header.group(1)))
                    start = line.start()
            at_line_start = line.group(0).endswith("\n")
        self._feed(text[start:])

    def _feed(self, text: str) -> None:
        if not text:
            return
        self.model.feed(text)
        if strip_ansi(text).strip():
            self._last_line_at = self.clock()
        self.wake()

    def _before_step(self, index: int) -> None:
        """A new step is starting: let the one before it, and its last line, be seen."""
        if index <= 0:
            return
        now = self.clock()
        hold = PAIRED_HOLD_SECONDS if self.model.paired() else LINE_HOLD_SECONDS
        wait = max(self.min_step_s - (now - self._last_step_at), hold - (now - self._last_line_at))
        if wait > 0:
            self.wake()
            self.sleep(wait)
        self._last_step_at = self.clock()

    # -- keys -----------------------------------------------------------------------

    def _input_loop(self) -> None:
        while not self._stop.is_set():
            if self._paused.is_set():
                time.sleep(0.05)
                continue
            try:
                ready = _wait_readable(self.in_fd, 0.1)
            except (OSError, ValueError):
                return
            if not ready or self._paused.is_set():
                continue
            try:
                data = os.read(self.in_fd, 1024)
            except OSError:
                return
            if not data:
                self._end_input()
                return
            self.keys(data)

    def keys(self, data: bytes) -> None:
        for ch in self._decoder.decode(data):
            if self._escape:
                self._escape += ch
                if len(self._escape) == 2 and ch not in "[O":
                    self._escape = ""
                elif len(self._escape) > 2 and ("@" <= ch <= "~"):
                    self._escape = ""
                continue
            if ch == "\x1b":
                self._escape = ch
            elif ch in "\r\n":
                self._send(self._typed + "\n")
                self._typed = ""
            elif ch in "\x7f\b":
                self._typed = self._typed[:-1]
            elif ch == "\x15":
                self._typed = ""
            elif ch == "\x17":
                self._typed = self._typed.rstrip().rpartition(" ")[0]
            elif ch == "\x04":
                if not self._typed:
                    self._end_input()
            elif ch >= " " and len(self._typed) < 200:
                self._typed += ch
        self.model.set_typed(self._typed)
        self.wake()

    def _send(self, line: str) -> None:
        if self._eof:
            return
        try:
            os.write(self.pipe_write, line.encode("utf-8"))
        except OSError:
            pass

    def _end_input(self) -> None:
        if not self._eof:
            self._eof = True
            try:
                os.close(self.pipe_write)
            except OSError:
                pass

    # -- drawing ----------------------------------------------------------------------

    def _render_loop(self) -> None:
        step = 1.0 / max(1.0, self.fps)
        while not self._stop.is_set():
            self._changed.wait(step)
            self._changed.clear()
            if self._stop.is_set():
                break
            if not self._paused.is_set():
                self.paint()

    def _terminal_size(self) -> Tuple[int, int]:
        try:
            size = os.get_terminal_size(self.out_fd)
        except OSError:
            return 88, 10
        cols, rows = max(20, size.columns), max(4, size.lines)
        if self._webui and rows <= WEBUI_ROWS_FLOOR:
            rows = WEBUI_PHONE_ROWS
        return cols, rows

    def paint(self, final: bool = False) -> None:
        with self._paint_lock:
            if self._paused.is_set() and not final:
                return
            cols, rows = self._terminal_size()
            t = self.clock() - self._t0 + self._t_offset
            with self.model.lock:
                if final:
                    self.look.final = True
                commits = self.look.take_commits(self.model, cols)
                frame = self.look.frame(self.model, t, cols, rows)
            self._write(self._compose(frame, commits, (cols, rows)))

    def _compose(self, frame: List[Row], commits: List[str], size: Tuple[int, int]) -> str:
        out: List[str] = []
        # A full redraw now and then puts the block back together if something
        # else wrote into the terminal, such as the WebUI's own "connection lost,
        # reconnecting" line. Never while a link is on screen: rewriting its rows
        # makes the terminal drop the link under the pointer, so a click misses.
        now = time.monotonic()
        refresh = now - self._full_at >= FULL_REDRAW_SECONDS and not self._shows_link(frame)
        same_shape = (
            not commits
            and not refresh
            and size == self._size
            and len(frame) == len(self._drawn)
            and all(a.height == b.height for a, b in zip(frame, self._drawn))
        )
        if self._drawn_rows and size != self._size:
            # The window changed: what was drawn may have reflowed, so start
            # this block afresh at the top of the window.
            out.append("\x1b[0m\x1b[H\x1b[2J")
            self._drawn_rows = 0
            self._drawn = []
            same_shape = False
        if same_shape and self._drawn_rows:
            cursor = self._drawn_rows - 1
            top = 0
            for new, old in zip(frame, self._drawn):
                if new.text != old.text:
                    if top < cursor:
                        out.append(f"\x1b[{cursor - top}A")
                    elif top > cursor:
                        out.append(f"\x1b[{top - cursor}B")
                    out.append("\r\x1b[2K" + new.text + "\x1b[0m")
                    cursor = top
                top += new.height
            last = self._drawn_rows - 1
            if cursor < last:
                out.append(f"\x1b[{last - cursor}B")
            out.append("\r")
        else:
            if self._drawn_rows:
                out.append("\r")
                if self._drawn_rows > 1:
                    out.append(f"\x1b[{self._drawn_rows - 1}A")
            elif self._over_intro:
                # The intro left its last frame up with the cursor at its top:
                # this frame replaces it in one write, rows that end early included.
                out.append("\r")
                self._over_intro = False
            # Each line goes over what is there, cleared just before it is written,
            # and what is left below goes with the last one. The WebUI can paint a
            # write cut in two: a cut then shows some old rows, never a blank block.
            lines = [(line + "\x1b[0m", screen_rows(line, size[0])) for line in commits]
            lines += [(row.text + "\x1b[0m", row.height) for row in frame]
            for i, (text, height) in enumerate(lines):
                if i:
                    out.append("\n")
                if i == len(lines) - 1:
                    out.append("\x1b[J")
                else:
                    # A line the terminal wraps clears the rows it wraps onto too.
                    out.append("\x1b[2K" + "\n\x1b[2K" * (height - 1))
                    if height > 1:
                        out.append(f"\x1b[{height - 1}A\r")
                out.append(text)
            if not lines:
                out.append("\x1b[J")
            self._drawn_rows = sum(row.height for row in frame)
            self._full_at = now
        self._drawn = frame
        self._size = size
        return "".join(out)

    def _shows_link(self, frame: List[Row]) -> bool:
        # The pairing address too: it is read off the screen, or copied with the
        # WebUI's Copy output, so it holds still. (A wss:// address is no link to
        # the terminal, and a phone can't select it.)
        model = self.model
        links = [link[:40] for link in (model.reopen, model.approve, model.address) if link]
        return any(link in strip_ansi(row.text) for link in links for row in frame)

    def _write(self, text: str) -> None:
        if not text:
            return
        data = text.encode("utf-8", "replace")
        try:
            while data:
                written = os.write(self.out_fd, data)
                data = data[written:]
        except OSError:
            pass


# -- opening a look ---------------------------------------------------------------------


@dataclass
class OpenLook:
    """What ``run_setup`` swaps in while a look is drawing."""

    name: str
    stdin: Any
    stdout: Any
    close: Callable[[int], None]
    suspended: Callable[[], Any]


def _is_tty(stream: Any) -> bool:
    try:
        return bool(stream.isatty()) and isinstance(stream.fileno(), int)
    except Exception:  # noqa: BLE001 - no fileno, no terminal
        return False


#: hermes.sh plays Speck's intro while OcuClaw installs (speck-intro/speck_intro.py)
#: and names the folder it talks to him through here.
INTRO_ENV = "OCUCLAW_SPECK_INTRO"
#: What hermes.sh and the intro leave in that folder; nothing else is removed.
_INTRO_FILES = ("cue", "pid", "idle0", "ready", "speck_intro.py")


def take_over_intro(env: Mapping[str, str], wait_s: float = 1.0) -> Optional[float]:
    """Stop the intro and say how far its idle loop got, in seconds.

    The intro leaves its last frame up with the cursor at the block's top, so
    setup's first frame draws over it and carries on Speck's idle loop from
    there: only the words in the bubble change. ``None`` when there was no
    intro to take over (not set, gone already, or not this process's child).
    """
    where = str(env.get(INTRO_ENV) or "")
    if not where or not os.path.isdir(where):
        return None
    try:
        with open(os.path.join(where, "pid")) as f:
            pid = int(f.read().strip())
        with open(os.path.join(where, "idle0")) as f:
            idle0 = float(f.read().strip())
        # hermes.sh started him and then became this process: he is our child.
        running = os.waitpid(pid, os.WNOHANG)[0] != pid
    except (OSError, ValueError):
        _forget_intro(where)
        return None
    try:
        if running:
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + wait_s
        while running and os.waitpid(pid, os.WNOHANG)[0] != pid:
            if time.monotonic() > deadline:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                break
            time.sleep(0.01)
    except OSError:  # gone already
        pass
    _forget_intro(where)
    return max(0.0, time.time() - idle0)


def _forget_intro(where: str) -> None:
    for name in _INTRO_FILES:
        try:
            os.unlink(os.path.join(where, name))
        except OSError:
            pass
    try:
        os.rmdir(where)
    except OSError:
        pass


def _clear_intro(stream_out: Any) -> None:
    """Setup runs plain after all: clear the intro's block and show the cursor."""
    try:
        stream_out.write("\r\x1b[0m\x1b[J\x1b[?25h")
        stream_out.flush()
    except Exception:  # noqa: BLE001 - a closed stream has nothing to clear
        pass


def open_look(
    name: str,
    stream_in: Any,
    stream_out: Any,
    *,
    env: Optional[Mapping[str, str]] = None,
    hermes_home: Any = None,
    json_output: bool = False,
    resumed: bool = False,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Optional[OpenLook]:
    """Start a look on these streams, or ``None`` to run plain.

    Plain whenever the look is plain, ``--json`` is on, or either stream is not
    a terminal: the ladder's own output is then exactly what it always was.
    """
    del hermes_home
    env = env or {}
    # hermes.sh's intro may still be drawing: it stops before anything else is written.
    intro_at = take_over_intro(env)
    plain = name not in LOOKS or name == "plain" or json_output
    if plain or not (_is_tty(stream_in) and _is_tty(stream_out)):
        if intro_at is not None:
            _clear_intro(stream_out)
        return None
    palette = Palette(color=not env.get("NO_COLOR"))
    model = SetupModel(clock=clock)
    # The run after the restart: say so from the first frame.
    model.resumed = bool(resumed)
    try:
        stream_out.flush()
    except Exception:  # noqa: BLE001 - nothing pending is fine too
        pass
    live = LiveTerminal(
        SpeckLook(palette), model, stream_in, stream_out, clock=clock, sleep=sleep, t_offset=intro_at
    )
    try:
        live.start()
    except Exception:  # noqa: BLE001 - a terminal we cannot drive runs plain
        live._restore()
        if intro_at is not None:
            _clear_intro(stream_out)
        return None
    return OpenLook(name, live.stdin, live.stdout, live.stop, live.suspended)


# -- a scripted run, to see the look without a server ------------------------------------

#: A stand-in WebUI, never a real box.
DEMO_ORIGIN = "https://hermes-1234567-8901.cloudwaysagents.com:9954"


def demo_script(part: str = "all") -> List[Tuple[str, Any]]:
    """A whole setup as the WebUI shows it, for ``python -m ... demo``.

    ``part`` is ``a`` (up to the restart), ``b`` (the run after it) or ``all``
    (both, with a ``drop`` between them where the page would go down).
    """
    a: List[Tuple[str, Any]] = [
        ("say", "[1/8] Cloudways host"),
        ("say", "  hermes-1234567-8901 is a Cloudways Managed AI Agents container."),
        ("say", "  Checking the model sign-in..."),
        ("wait", 1.0),
        ("say", ""),
        ("say", "[2/8] Settings"),
        ("ask", "Continue your Desktop and terminal chats on your glasses? Type yes or no: "),
        ("say", "  Glasses settings applied."),
        ("say", ""),
        ("say", "[3/8] OcuClaw"),
        ("say", "  OcuClaw is installed. One restart of your agent loads it."),
        ("say", "  1  This page disconnects for about a minute while your agent restarts."),
        ("say", "  2  Then open the link shown below and send /terminal."),
        ("say", "  3  Setup carries on by itself."),
        ("say", "  If it drops again soon after, open the link again."),
        ("ask", "Restart now? Type yes to continue, anything else stops: "),
        ("say", "  Restarting your agent. This page disconnects in a few seconds."),
        ("say", "  In about a minute, open this link. Not loaded yet? Refresh it."),
        ("say", f"  {DEMO_ORIGIN}/?q=/terminal"),
        ("say", "  Wait until /terminal shows in the box, then send it. Setup carries on by itself."),
        ("wait", 6.0),
    ]
    b: List[Tuple[str, Any]] = [
        ("say", "[1/8] Cloudways host"),
        ("say", "  hermes-1234567-8901 is a Cloudways Managed AI Agents container."),
        ("say", "  Checking the model sign-in..."),
        ("wait", 1.0),
        ("say", ""),
        ("say", "[2/8] Settings"),
        ("say", "  Settings already applied."),
        ("say", ""),
        ("say", "[3/8] OcuClaw"),
        ("say", "  OcuClaw is loaded and ready."),
        ("say", ""),
        ("say", "[4/8] Tailscale"),
        ("say", "  Checking Tailscale..."),
        ("wait", 1.0),
        ("say", "  Installing Tailscale..."),
        ("wait", 2.5),
        ("say", "  Tailscale 1.102.4 installed."),
        ("say", "  Tailscale is running."),
        ("say", ""),
        ("say", "[5/8] Connect to Tailscale"),
        ("say", "  This server is already approved."),
        ("say", ""),
        ("say", "[6/8] Private route for your phone"),
        ("say", "  Allow access from your tailnet only. Never public; never Tailscale Funnel."),
        ("say", "  Setup will add one private route so your phone can reach OcuClaw."),
        ("say", "  Run setup with --details to see the exact command first."),
        ("ask", "Apply route? Type the full word yes; anything else stops: "),
        ("say", "  Private route configured."),
        ("say", "  Waiting for the certificate. This usually takes a minute or two."),
        ("wait", 2.5),
        ("say", "  Certificate ready."),
        ("say", "  The private route is published and answering."),
        ("say", ""),
        ("say", "[7/8] Pair your phone"),
        ("say", "  Private route ready for pairing."),
        ("say", "  Phone found on your Tailscale network."),
        ("say", "Open Even > OcuClaw on your phone and tap the Pair button."),
        ("say", "Then press Enter to show the code."),
        ("ask", ""),
        ("say", "Manual pairing"),
        ("say", "In OcuClaw tap Pair with your agent > Pair manually, then type:"),
        ("say", "  Address:      wss://ocuclaw-hermes.your-tailnet.ts.net:8446"),
        ("say", "  Pairing code: 9N8C-JWD3"),
        ("say", "Expires in 5:00."),
        ("wait", 5.0),
        ("say", "  Paired. Your phone is connected."),
        ("say", ""),
        ("say", "[8/8] Your first message"),
        ("say", ""),
        ("say", "In the paired conversation on your phone, send hello."),
        ("say", "Waiting for the reply on your glasses…"),
        ("wait", 3.0),
        ("say", "Your phone reported SDK acceptance of the reply."),
        ("say", "Double-tap the welcome on your glasses to finish."),
        ("say", "OcuClaw setup is complete for this Hermes profile."),
    ]
    if part == "a":
        return a
    if part == "b":
        return b
    return a + [("drop", None)] + b


def run_demo(name: str, stream_in: Any, stream_out: Any, *, speed: float = 1.0, part: str = "all") -> int:
    """Play the demo script through a look, answering yes where a person would type."""
    code = 0
    opened = open_look(name, stream_in, stream_out, resumed=part == "b")
    try:
        for kind, value in demo_script(part):
            out = opened.stdout if opened else stream_out
            inp = opened.stdin if opened else stream_in
            if kind == "say":
                out.write(value + "\n")
            elif kind == "wait":
                time.sleep(float(value) / speed)
            elif kind == "ask":
                out.write(value)
                out.flush()
                inp.readline()
                out.write("\n")
            elif kind == "drop":
                # Where the page would go down: start again as the run after it.
                if opened:
                    opened.close(1)
                stream_out.write("\x1b[2J\x1b[H")
                stream_out.flush()
                opened = open_look(name, stream_in, stream_out, resumed=True)
    except KeyboardInterrupt:
        code = 130
    finally:
        if opened:
            opened.close(code)
    return code


if __name__ == "__main__":  # pragma: no cover - a person's preview
    import sys

    sys.exit(
        run_demo(
            sys.argv[2] if len(sys.argv) > 2 else "speck",
            sys.stdin,
            sys.stdout,
            part=sys.argv[3] if len(sys.argv) > 3 else "all",
        )
    )
