const { EXPIRY_CLOCK, EXPIRY_NOTE, STEP, URL, WORDS_ROW, cpLen, pyMatch, pyRstrip, pySearch, pySplit, pyStrip, stripAnsi } = require("./text.cjs");

const LOOKS                    = ["plain", "speck"];

const DEFAULT_LOOK = "plain";

const WEBUI_LOOK = "speck";

const LOOK_ENV = "OCUCLAW_SETUP_LOOK";

const TERMINAL_ENV = "OPENCLAW_TERMINAL";

const FPS = 12;

const MIN_STEP_SECONDS = 2.4;

const INTRO_SECONDS = 2.4;

const LINE_HOLD_SECONDS = 1.4;

const PAIRED_HOLD_SECONDS = 3.4;

const CELEBRATE_SECONDS = 2.5;

const FULL_REDRAW_SECONDS = 2.0;
const STEP_COUNT = 8;

const FRIENDLY_TITLES                                   = {
  0: "Now for your glasses",
  1: "Checking your server",
  2: "Your glasses settings",
  3: "Loading OcuClaw",
  4: "Tailscale",
  5: "Connecting to Tailscale",
  6: "A private route for your phone",
  7: "Pair your phone",
  8: "Say hi from your glasses",
};

const SETTINGS_WAIT = "Tuning a few settings…";
const SETTINGS_RECHECK = "Checking your settings…";

const RECORD_INDENT = "  ";

const RERUN_BASE = "openclaw ocuclaw cloudways setup";

function processEnv()      {
  const runtime      = globalThis;
  const env = runtime.process?.env;
  return env && typeof env === "object" ? env : {};
}

function inDashboardTerminal(env     )          {
  return env[TERMINAL_ENV] === "1";
}

function defaultLook(env      = processEnv(), inTerminal               = inDashboardTerminal)         {
  return inTerminal(env) ? WEBUI_LOOK : DEFAULT_LOOK;
}

function resolveLook(
  flag                           ,
  env      = processEnv(),
  inTerminal               = inDashboardTerminal,
)         {
  const fallback = defaultLook(env, inTerminal);
  for (const value of [flag, env[LOOK_ENV]]) {
    const name = pyStrip(String(value || "")).toLowerCase();
    if (name) return LOOKS.includes(name) ? name : fallback;
  }
  return fallback;
}

function rerunCommand(
  look                           ,
  env      = processEnv(),
  inTerminal               = inDashboardTerminal,
)         {
  if (!look || look === defaultLook(env, inTerminal)) return RERUN_BASE;
  return `${RERUN_BASE} --look ${look}`;
}

const CONDENSED                       = (
  [
    [String.raw`.* is a Cloudways Managed AI Agents container\.$`, "Cloudways agent found."],
    [String.raw`^Checking the model sign-in\.\.\.$`, "Checking the model sign-in…"],

    [String.raw`^No model is signed in yet\. Sign in to OpenAI in the Cloudways panel:$`, "I need a model. In Cloudways, open:"],
    [String.raw`^Using ChatGPT\? First turn on device code sign-in in ChatGPT: .*$`, "ChatGPT? Turn on device code sign-in first, in its Security settings."],
    [String.raw`^Your agent restarts after that\. It can take a few minutes\.$`, "It restarts. Give it a few minutes."],
    [String.raw`^When it is back, run this again:$`, "When it's back, run this again:"],

    [String.raw`^Not turned on\. To turn it on later, run the same setup command again\.$`, "Left off. Rerun setup to add it."],
    [String.raw`^Run setup with --details.*$`, null],

    [String.raw`^OcuClaw is installed\. One restart of your agent loads it\.$`, "One restart of your agent loads it."],
    [String.raw`^1  This page disconnects for about a minute.*$`, "1 This page drops for a minute."],
    [String.raw`^2  Then open the link shown below and send /terminal\.$`, "2 Open my link, send /terminal."],
    [String.raw`^2  When it is back, reload the page and send /terminal\.$`, "2 Then reload, send /terminal."],
    [String.raw`^3  Setup carries on by itself\.$`, "3 Setup carries on by itself."],
    [String.raw`^3  Press the Up arrow, then Enter, to carry on\.$`, "3 Then the Up arrow and Enter."],
    [String.raw`^3  (.*)$`, String.raw`3 \1`],
    [String.raw`^If it drops again soon after.*$`, null],
    [String.raw`^This page disconnects for about a minute.*$`, "This page drops for about a minute."],
    [String.raw`^When it is back, reload the page and send /terminal\.$`, "Then reload, and send /terminal."],
    [String.raw`^Then press the Up arrow and Enter to carry on\.$`, "Press the Up arrow and Enter."],
    [String.raw`^Restarting your agent\. This page disconnects in a few seconds\.$`, "Restarting now. Back in about a minute."],
    [String.raw`^In about a minute, open this link\..*$`, null],
    [String.raw`^Wait until /terminal shows.*$`, null],

    [String.raw`^Open this link and sign in to Tailscale to approve this server:$`, "Tailscale creates a private link between me and your glasses."],
    [String.raw`^Use the Tailscale account your phone uses\.$`, "Log in and approve this server."],
    [
      String.raw`^No Tailscale on your phone\? Install it from the App Store or Google Play\.$`,
      "No Tailscale on your phone? Install it for free from the App Store or Google Play.",
    ],

    [String.raw`^Waiting for server approval\.$`, null],

    [
      String.raw`^Tailscale added (-[0-9]+) because old devices with this name are still in your tailnet\.$`,
      String.raw`Tailscale added \1: old devices still use this name.`,
    ],

    [String.raw`^Your Tailscale account has HTTPS turned off\. Your phone's private route needs it\.$`, "Your Tailscale account needs HTTPS on first."],
    [String.raw`^Open this link, sign in to Tailscale and turn on HTTPS:$`, "Open the link below, log in and turn on HTTPS."],
    [String.raw`^Open this page, sign in to Tailscale and turn on MagicDNS and HTTPS Certificates:$`, "Open the link below, log in and turn on MagicDNS and HTTPS."],

    [String.raw`^Waiting for HTTPS to be turned on\.$`, null],
    [String.raw`^Allow access from your tailnet only\..*$`, "Only your own devices can use it."],
    [String.raw`^Setup will add one private route so your phone can reach OcuClaw\.$`, "One private route so your phone can reach OcuClaw."],
    [String.raw`^Waiting for the certificate\..*$`, "Waiting for its certificate…"],
    [String.raw`^The private route is published and answering\.$`, "Route published and answering."],

    [String.raw`^Phone not found on your Tailscale network\.$`, "Your phone isn't on Tailscale yet."],
    [String.raw`^On your phone:$`, null],
    [String.raw`^2\. Sign in with the same account as this server\.$`, "2. Sign in, same account as here."],
    [String.raw`^Waiting for your phone\. Press Enter to skip this check\.$`, "Waiting for it to join."],
    [String.raw`^Phone check skipped\..*$`, "Phone check skipped."],
    [String.raw`^Open Even > OcuClaw on your phone and tap the Pair button\.$`, "On your phone open Even › OcuClaw, tap Pair."],
    [String.raw`^Then press Enter to show the code\.$`, null],
    [String.raw`^The next pairing code expires in .*$`, null],

    [String.raw`^Manual pairing$`, null],
    [String.raw`^In OcuClaw tap Pair with your agent > Pair manually, then type:$`, null],
    [String.raw`^Expires in .*$`, null],
    [String.raw`^Address: .*$`, null],
    [String.raw`^Pairing code: .*$`, null],
    [String.raw`^https?://\S+$`, null],

    [String.raw`^In the paired conversation on your phone, send (.+)\.$`, String.raw`Send \1 from your phone.`],
    [String.raw`^Waiting for the reply on your glasses…$`, "Waiting for the reply…"],
    [String.raw`^Your phone reported SDK acceptance of the reply\.$`, "Your phone says the glasses got it."],
    [String.raw`^This was the simulator, so setup can't check the glasses itself\.$`, "Simulator: I can't check the glasses."],
    [String.raw`^OcuClaw setup is complete for this Hermes profile\.$`, "Setup is complete."],
  ]
).map(([pattern, short])            => [new RegExp(pattern), short]);

                                        

const HERMES_LANDED                                   = {
  2: /applied/,
  3: /ready/,
  4: /running/,
  5: /approved|^Tailscale added -[0-9]+ /,
  6: /answering/,
};

const HERMES_WORDING          = {
  condensed: CONDENSED,
  titles: FRIENDLY_TITLES,
  resumed: ["Settings already applied", "OcuClaw is loaded and ready"],
  landed: HERMES_LANDED,
  busyByWords: false,
  clickHint: "",
  compactLinkHint: "",
};

const REWRITE = "\u001b[1A";

function expandTemplate(match                 , template        )         {
  return template.replace(/\\(?:g<(\w+)>|(\d{1,2})|([\\ntr]))/g, (whole, named                    , num                    , esc                    ) => {
    if (esc !== undefined) return esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : "\\";
    const key = named ?? num ?? "";
    const value = /^\d+$/.test(key) ? match[Number(key)] : match.groups?.[key];
    return value ?? "";
  });
}

function condense(text        , table                       = CONDENSED)                {
  for (const [pattern, short] of table) {
    const match = pyMatch(pattern, text);
    if (match) return short !== null ? expandTemplate(match, short) : null;
  }
  return text;
}

const ASK_ROW = 40;

function inBubble(question        )          {
  return cpLen(question) > ASK_ROW;
}

function splitQuestion(prompt        )                   {
  const text = pyStrip(pyRstrip(pyStrip(prompt), ":"));
  const at = text.indexOf("?");
  if (at >= 0) {
    const question = text.slice(0, at);
    const hint = pyStrip(text.slice(at + 1));
    if (!hint) return [pyStrip(question) + "?", ""];
    const [first, ...rest] = Array.from(hint);
    return [pyStrip(question) + "?", first.toUpperCase() + rest.join("") + "."];
  }
  return [text, ""];
}

class StepView {
  index        ;
  header        ;

  lines                         ;
  started        ;
  done         ;

  committed         ;

  constructor(index        , header        , lines                          = [], started = 0.0, done = false) {
    this.index = index;
    this.header = header;
    this.lines = lines;
    this.started = started;
    this.done = done;
    this.committed = false;
  }

  said()           {
    return this.lines.filter(([kind]) => kind === "line").map(([, text]) => text);
  }
}

const CARRY_ON_ITSELF = "itself";
const CARRY_ON_UP_ARROW = "up-arrow";
const CARRY_ON_TYPED = "typed";

const TYPED_COMMAND = /(?<![\p{L}\p{N}_])type (?:hermes|openclaw) ocuclaw(?![\p{L}\p{N}_])/iu;

function carryOnWay(text        )                {
  if (text.includes("carries on")) return CARRY_ON_ITSELF;
  if (text.includes("Up arrow")) return CARRY_ON_UP_ARROW;
  if (TYPED_COMMAND.test(text)) return CARRY_ON_TYPED;
  return null;
}

function defaultClock()         {
  return performance.now() / 1000;
}

class SetupModel {
  clock              ;
  wording         ;
  started        ;
  total        ;
  steps                       ;
  current        ;
  partial        ;

  answered               ;
  asking         ;
  question               ;
  typed        ;
  exitCode               ;
  restarting         ;
  resumed         ;

  address               ;
  code               ;
  codeAt        ;
  codeSeconds               ;

  reopen               ;

  approve               ;

  device               ;
  words                 ;
  wordsNext         ;

  carryOn        ;
  transcript          ;

  rawTranscript          ;

  rewriting         ;
  version        ;

  constructor(clock               = defaultClock, wording          = HERMES_WORDING) {
    this.clock = clock;
    this.wording = wording;
    this.started = clock();
    this.total = STEP_COUNT;
    this.steps = new Map();
    this.current = 0;
    this.steps.set(0, new StepView(0, "OcuClaw setup", [], this.started));
    this.partial = "";
    this.answered = null;
    this.asking = false;
    this.question = null;
    this.typed = "";
    this.exitCode = null;
    this.restarting = false;
    this.resumed = false;
    this.address = null;
    this.code = null;
    this.codeAt = 0.0;
    this.codeSeconds = null;
    this.reopen = null;
    this.approve = null;
    this.device = null;
    this.words = null;
    this.wordsNext = false;
    this.carryOn = CARRY_ON_ITSELF;
    this.transcript = [];
    this.rawTranscript = [];
    this.rewriting = false;
    this.version = 0;
  }

  condense(text        )                {

    if (this.current === 7 && !this.code && this.view().said().includes("Sent to your phone.")) {
      const words = WORDS_ROW.exec(text);
      if (words) return pyStrip(words[1]);
      if (/^(Phone: |Check these words match|If they differ, refuse\.)/.test(text)) return text;
    }
    return condense(text, this.wording.condensed);
  }

  feed(text        )       {
    text = text.replaceAll("\r\n", "\n");
    const pieces = text.split("\n");
    for (const piece of pieces.slice(0, -1)) {
      const whole = this.partial + piece;
      this.line(SetupModel.overwrite(whole), this.rewriting || whole.startsWith(REWRITE));
      this.partial = "";
      this.rewriting = false;
    }
    const tail = this.partial + pieces[pieces.length - 1];
    if (tail.startsWith(REWRITE)) this.rewriting = true;
    this.partial = SetupModel.overwrite(tail);
    this.version += 1;
  }

  static overwrite(text        )         {
    return text.slice(text.lastIndexOf("\r") + 1);
  }

  line(raw        , rewrite = false)       {
    const text = pyRstrip(stripAnsi(raw));
    if (rewrite && this.rewrite(text)) return;
    this.transcript.push(text);
    this.rawTranscript.push(raw);
    const body = pyStrip(text);
    const step = STEP.exec(body);
    if (step) {
      const index = parseInt(step[1], 10);
      this.total = parseInt(step[2], 10) || STEP_COUNT;
      for (const view of this.steps.values()) view.done = true;
      this.steps.set(index, new StepView(index, pyStrip(step[3]), [], this.clock()));
      this.current = index;
      this.restarting = false;
      this.approve = null;
      this.version += 1;
      return;
    }
    const view = this.view();
    if (!body && (!view.lines.length || view.lines[view.lines.length - 1][1] === "")) return;
    if (this.answered !== null && body === this.answered) {
      this.answered = null;
      return;
    }
    view.lines.push(["line", body]);
    if (this.wording.resumed.some((lead) => body.startsWith(lead))) this.resumed = true;
    if (body.startsWith("Restarting your agent")) this.restarting = true;
    if (body.startsWith("The restart did not happen")) this.restarting = false;
    const url = pySearch(URL, body);
    if (url && url[0].endsWith("?q=/terminal")) this.reopen = url[0];
    else if (url && (this.current === 5 || this.current === 6) && body === url[0]) this.approve = url[0];
    if (this.approve && /approved|timed out|HTTPS is on|HTTPS is still off/.test(body)) this.approve = null;
    if (this.code && body.startsWith("Phone: ")) this.device = pyStrip(afterColon(body));
    if (body.startsWith("Match these four words") || body.startsWith("Check these words match")) this.wordsNext = true;
    const box = WORDS_ROW.exec(body);
    if (this.code && box && this.wordsNext) {
      this.words = pySplit(box[1]);
      this.wordsNext = false;
    }
    let way                = null;
    if (body.startsWith("3  ") || body.startsWith("Wait until /terminal shows") || body.includes("Instead, for 3:")) way = carryOnWay(body);
    if (way) this.carryOn = way;
    if (body.startsWith("Address: ")) this.address = pyStrip(afterColon(body));
    if (body.startsWith("Pairing code: ")) {
      this.code = pyStrip(afterColon(body));
      this.codeAt = this.clock();
    }
    const clock = pyMatch(EXPIRY_CLOCK, body);
    if (clock) this.codeSeconds = parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
    if (this.code && /expired|did not finish|[Pp]aired|approved/.test(body)) {

      if (!(body.startsWith("The next") || body.startsWith("Not approved"))) this.code = null;
    }
    if (!this.code || body.startsWith("Approved")) {
      this.device = null;
      this.words = null;
    }
  }

  rewrite(text        )          {
    const view = this.view();
    const last = view.lines.length - 1;
    if (last < 0 || view.lines[last][0] !== "line") return false;
    view.lines[last] = ["line", pyStrip(text)];
    this.version += 1;
    return true;
  }

  askBegin()       {
    const prompt = pyStrip(stripAnsi(this.partial));
    this.asking = true;
    this.question = prompt || null;
    this.version += 1;
  }

  askEnd(answer        )       {
    this.asking = false;
    answer = pyRstrip(answer, "\n");
    if (this.question) {

      this.partial = this.partial + answer;
      this.answered = pyStrip(stripAnsi(this.partial));
      this.view().lines.push(["qa", pyStrip(`${splitQuestion(this.question)[0]} ${answer}`)]);
    }
    this.question = null;
    this.typed = "";
    this.version += 1;
  }

  setTyped(typed        )       {
    this.typed = typed;
    this.version += 1;
  }

  finish(exitCode        )       {
    if (this.partial) {
      this.line(this.partial);
      this.partial = "";
    }
    this.exitCode = exitCode;
    if (exitCode === 0) {
      for (const view of this.steps.values()) view.done = true;
    } else {

      this.code = null;
      this.restarting = false;
    }
    this.asking = false;
    this.version += 1;
  }

  view()           {
    return this.steps.get(this.current)            ;
  }

  isDone(index        )          {
    const view = this.steps.get(index);
    return Boolean(view && view.done);
  }

  doneCount()         {
    let n = 0;
    for (let i = 1; i <= this.total; i++) if (this.isDone(i)) n++;
    return n;
  }

  lastSaid()         {
    const said = this.view().said().filter((text) => text);
    return said.length ? said[said.length - 1] : "";
  }

  paired()          {
    return this.current === 7 && !this.code && /^(Phone paired|Paired\.)/.test(this.lastSaid());
  }

  reply()                {
    if (this.current !== 8) return null;
    const said = this.view().said().filter((text) => text);
    for (let i = 0; i < said.length; i++) {
      const text = said[i];
      if (text.startsWith("Waiting for the reply") || text.startsWith("Waiting for your first message")) {
        const later = said.slice(i + 1).filter((line) => !line.startsWith("Waiting"));
        return later.length ? later[0] : null;
      }
    }
    return null;
  }

  panelLines()           {
    const out           = [];
    for (const text of this.view().said()) {
      const short = this.condense(text);

      if (short && !short.startsWith("Stuck? Ask us") && !short.endsWith("...") && !short.endsWith("…")) out.push(short);
    }
    return out;
  }

  working()                {
    const said = this.view().said();
    if (this.exitCode === null && said.length) {
      const last = said[said.length - 1];
      const tail = pyRstrip(last);
      if (tail.endsWith("...") || tail.endsWith("…")) return this.condense(last) || last;

      const short = this.wording.busyByWords ? this.condense(last) : null;
      if (short && short.endsWith("…")) return short;
    }
    return null;
  }

  waitingForEnter()          {
    if (this.exitCode !== null) return false;
    const recent = this.view()
      .said()
      .filter((text) => pyStrip(text))
      .slice(-3)
      .reverse();
    for (const line of recent) {
      if (line.toLowerCase().includes("press enter")) return true;
      if (!pySearch(EXPIRY_NOTE, line)) return false;
    }
    return false;
  }

  openPrompt()                {
    if (this.asking || this.exitCode !== null) return null;
    const text = pyStrip(stripAnsi(this.partial));
    if (this.current === 7 && text === ">" && this.view().said().includes("For manual pairing, type m.")) return "Phone code";
    return text.endsWith(":") ? pyStrip(text.slice(0, -1)) : null;
  }

  skipOffer()          {
    const said = this.view().said().filter((text) => pyStrip(text));
    return said.length > 0 && said[said.length - 1].includes("to skip");
  }

  title()         {
    if (this.exitCode === 0 && this.current >= this.total) return "All set!";
    if (this.exitCode !== null && this.exitCode !== 0) return "Stopped for now";
    if (this.restarting) return "Restarting your agent";
    if (this.resumed && this.current <= 3) return "Welcome back";
    if (this.code) return "Your pairing code";
    if (this.paired()) return "Phone paired";
    return this.wording.titles[this.current] ?? this.view().header;
  }

  codeLeft()                {
    if (!this.code || !this.codeSeconds) return null;
    return Math.max(0.0, this.codeSeconds - (this.clock() - this.codeAt));
  }

  landedOn(index        , last        )          {
    const rule = this.wording.landed[index];
    return rule !== undefined && rule.test(last);
  }

  speckState()         {
    if (this.exitCode !== null) return this.exitCode === 0 ? "move.finishFlag" : "concept.warning";
    if (this.restarting) return "idle.nap";
    if (this.paired()) return "move.pairTick";
    if (this.current === 8 && this.reply()) return "responding";
    if (this.asking && this.typed) return "listening.right";
    if (this.asking || this.waitingForEnter()) return "move.question";
    if (this.resumed && this.current <= 3) return "concept.reconnecting";
    const last = this.lastSaid();
    switch (this.current) {
      case 0:
        return "idle";
      case 1:
        return "move.rackKnock";
      case 2:
        return this.landedOn(2, last) ? "move.landTick" : "fs.edit";
      case 3:
        return this.landedOn(3, last) ? "move.landTick" : "move.loadingRing";
      case 4:
        return this.landedOn(4, last) ? "move.landTick" : "move.threadLink";
      case 5:
        return this.landedOn(5, last) ? "move.landTick" : "connecting";
      case 6:
        return this.landedOn(6, last) ? "move.landTick" : "concept.secure";
      case 7:
        return this.code ? "move.signalEyes" : "device.check";
      case 8:
        return "move.sayHi";
      default:
        return "idle";
    }
  }
}

function afterColon(text        )         {
  return text.slice(text.indexOf(": ") + 2);
}

module.exports = { LOOKS, DEFAULT_LOOK, WEBUI_LOOK, LOOK_ENV, TERMINAL_ENV, FPS, MIN_STEP_SECONDS, INTRO_SECONDS, LINE_HOLD_SECONDS, PAIRED_HOLD_SECONDS, CELEBRATE_SECONDS, FULL_REDRAW_SECONDS, STEP_COUNT, FRIENDLY_TITLES, SETTINGS_WAIT, SETTINGS_RECHECK, RECORD_INDENT, RERUN_BASE, processEnv, inDashboardTerminal, defaultLook, resolveLook, rerunCommand, CONDENSED, HERMES_LANDED, HERMES_WORDING, REWRITE, expandTemplate, condense, ASK_ROW, inBubble, splitQuestion, StepView, CARRY_ON_ITSELF, CARRY_ON_UP_ARROW, CARRY_ON_TYPED, carryOnWay, defaultClock, SetupModel };
