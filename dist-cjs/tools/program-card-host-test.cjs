const PROGRAM_CARD_HOST_TEST_PLAY_S = 45;

const PROGRAM_CARD_HOST_TEST_MAX_WAIT_S = 60;

const MAX_STEPS = 12;

const PROGRAM_CARD_PROVES_MAX = 80;

const STOP = new Set(["the", "and", "then", "that", "this", "with", "from", "into", "when", "what", "each", "every", "shows", "show",
  "card", "after", "before", "once", "over", "only", "also", "them", "they", "their", "your", "says", "said", "like", "many", "much",
  "more", "less", "same", "other", "about", "there", "here", "have", "will", "does", "for", "can", "its", "all", "one", "two", "are", "was",
  "has", "had", "you", "not", "but", "per", "any", "off", "out", "own", "new", "how", "who", "yet", "tap", "taps", "press", "button"]);

const stem = (word        ) => word.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);

const SAME                         = { resta: "reset", begin: "start", resum: "pause",
  toss: "flip", split: "peopl", perso: "peopl", party: "peopl", perce: "tip", bpm: "tempo" };
function keywords(text        )              {
  const out = new Set        ();
  for (const raw of String(text || "").split(/[^A-Za-z0-9']+/)) {
    const word = raw.toLowerCase().replace(/'s$/, "");
    if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue;
    out.add(SAME[stem(word)] ?? stem(word));
  }
  return out;
}
const shares = (a             , b             ) => { for (const k of a) if (b.has(k)) return true; return false; };

function lineForText(text        , lines          , taken             , extra                = null, exclude                = null,
  again = false, skip              = new Set())                {
  const keys = keywords(text);
  const fits = (line        ) => !skip.has(line) && !(exclude && exclude.test(line)) && (shares(keys, keywords(line)) || !!(extra && extra.test(line)));
  return lines.find((line) => !taken.has(line) && fits(line)) ?? (again ? lines.find((line) => taken.has(line) && fits(line)) ?? null : null);
}

const SHOW_LINE = /^\s*(?:always\s+)?(?:show|shows|see|display|displays)\s+(.+)$/i;
const NOT_STILL = /[;:!?]|\b(?:puls\w*|flash\w*|blink\w*|anim\w*|mov\w*|clear(?:ly)?|large|big|bold|bright\w*|smooth\w*|nice\w*|when|if|until|after|before|winner|loser|whose)\b/i;

const SHOWN_AS                                      = [

  { names: /\b(?:seconds?|secs?|countdown|remaining|left|time|timer|clock|minutes?|mins?|elapsed)\b/i,
    screen: /\b\d{1,2}:\d{2}\b|\b\d+\s?(?:s|sec|secs|seconds?|m|min|mins|minutes?)\b|(?:^|\n)\s*\d{1,3}\s*(?:\n|$)/i },

  { names: /\b(?:phase|stage|state|status|mode)\b/i, screen: /\b(?:work|rest|break|on|off|ready|go|done|finished|complete|focus|recover\w*|active)\b/i },

  { names: /\b(?:rounds?|blocks?|sets?|intervals?|cycles?|reps?|number)\b/i, screen: /\b(?:rounds?|blocks?|sets?|intervals?|cycles?|reps?)\b|\b\d+\s*(?:\/|of)\s*\d+\b/i },

  { names: /\b(?:share|person|people|each|split|per)\b/i, screen: /\b(?:each|per|person|people|split|share|pp)\b/i },
  { names: /\b(?:tempo|bpm)\b/i, screen: /\b(?:bpm|tempo)\b/i },
];

function shownThings(line        )                  {
  const m = SHOW_LINE.exec(String(line || ""));
  if (!m || NOT_STILL.test(line)) return null;
  const things = m[1].split(/,|\band\b|&|\+/i).map((t) => t.trim()).filter((t) => keywords(t).size > 0);
  return things.length ? things : null;
}
const isShowLine = (line        ) => shownThings(line) !== null;

function lineShown(line        , screen         )                 {
  const things = shownThings(line);
  if (!things) return null;
  const text = (Array.isArray(screen) ? screen : []).filter((w) => typeof w === "string").join("\n");
  if (!text.trim()) return false;
  const words = keywords(text);
  return things.every((thing) => shares(keywords(thing), words) || SHOWN_AS.some((a) => a.names.test(thing) && a.screen.test(text)));
}

const SECONDS = /(\d+)\s*(?:s|sec|secs|second|seconds)\b/gi;
const MINUTES = /(\d+)\s*(?:min|mins|minute|minutes)\b/gi;
const TIMER_WORDS = /\b(timer|countdown|stopwatch|interval|tabata|pomodoro|rounds?|clock|elapsed|seconds?|minutes?|ticks?)\b/i;
const PLAY_WORDS = /\b(fall|falls|flap|flaps|jump|jumps|dodge|scroll|scrolls|walls?|pipes?|gaps?|score|points?|lives?|hit|hits|crash|crashes|ends?|over|speed|faster|enem(?:y|ies)|ship|bird|moves?|steer)\b/i;
const RESTART_WORDS = /\b(again|restart|new game|start over|starts? a new|replay)\b/i;
const PAUSE_WORDS = /\b(pause|paused|pauses|resume|resumes|without losing)\b/i;

function timerWaits(line        )           {
  const out           = [];
  for (const m of String(line).matchAll(SECONDS)) out.push(Number(m[1]) + 1);
  for (const m of String(line).matchAll(MINUTES)) out.push(Number(m[1]) * 60 + 1);
  return out.filter((n) => Number.isFinite(n) && n > 1).map((n) => Math.min(n, PROGRAM_CARD_HOST_TEST_MAX_WAIT_S)).slice(0, 2);
}

function hostFirstTest(lines          , controls                   , opts                                                                             = {})           {
  const game = opts.game === true;
  const steps        = [];
  const proves                           = {};
  const taken = new Set        ();
  const wearerOnly = (line        ) => typeof opts.wearerOnly === "function" && opts.wearerOnly(line) === true;
  const showLines = new Set(lines.filter((line) => isShowLine(line) && !wearerOnly(line)));
  const lineFor = (text        , extra                = null, exclude                = null) =>
    lineForText(text, lines, taken, extra, exclude, true, showLines);
  const tag = (index        , line               ) => { if (line) { proves[index] = [line]; taken.add(line); } };

  const live = (Array.isArray(controls) ? controls : []).filter((c) => c && typeof c.id === "string" && c.id !== "agent" &&
    c.enabled !== false && c.args === undefined && c.role !== "command");
  const label = (c                 ) => (typeof c.label === "string" && c.label.trim() ? c.label.trim() : c.id).slice(0, 40);
  const buttons = live.filter((c) => c.role === "button" || c.role === undefined).slice(0, 3);
  const numbers = live.filter((c) => c.role === "number").slice(0, 3);
  const switches = live.filter((c) => c.role === "toggle" || c.role === "choice").slice(0, 2);
  const timed = lines.some((l) => TIMER_WORDS.test(l) || timerWaits(l).length > 0);
  steps.push({ do: "open", label: "Opening the card" });

  const played = () => steps.some((s) => typeof s.do === "string" && s.do.startsWith("play:"));
  const play = () => {
    if (!game || opts.play !== true || played() || steps.length >= MAX_STEPS - 1) return;

    steps.push({ do: `play:${PROGRAM_CARD_HOST_TEST_PLAY_S}`, label: "Playing the game", snap: "After playing" });

    const playLines = lines.filter((line) => !taken.has(line) && PLAY_WORDS.test(line) && !RESTART_WORDS.test(line));
    if (playLines.length) { proves[steps.length - 1] = playLines; for (const line of playLines) taken.add(line); }
    if (steps.length < MAX_STEPS) {

      steps.push({ do: "tap", watch: 3, label: "Tapping after the end", snap: "After a tap" });
      tag(steps.length - 1, lineFor("restart again new game", RESTART_WORDS));
    }
  };

  const deferWaits = !game && buttons.length > 0 && lines.some((l) => timerWaits(l).length > 0);
  const pressAgain = () => {
    if (!buttons.length || steps.length >= MAX_STEPS) return;
    const name = label(buttons[0]);
    steps.push({ do: "tap", control: buttons[0].id, label: `Trying ${name} again`, snap: `After ${name} again` });
    tag(steps.length - 1, lineFor("pause resume", PAUSE_WORDS));
  };
  const waitOut = () => {
    for (const line of lines) {
      const waits = timerWaits(line);
      if (taken.has(line) || !waits.length || steps.length + waits.length > MAX_STEPS) continue;
      for (const [w, seconds] of waits.entries()) {
        steps.push({ do: `wait:${seconds}`, label: `Skipping ahead ${seconds - 1} s` });
        if (w === waits.length - 1) tag(steps.length - 1, line);
      }
    }
  };
  for (const [i, button] of buttons.entries()) {
    const name = label(button);
    steps.push({ do: "tap", control: button.id, fresh: true, label: `Trying ${name}`, ...(i === 0 && timed && !deferWaits ? { watch: 5 } : {}), snap: `After ${name}` });

    tag(steps.length - 1, lineFor(name, null, game ? RESTART_WORDS : null));
    if (i > 0) continue;

    play();
    if (deferWaits) pressAgain();
    else if (steps.length < MAX_STEPS - 2) waitOut();
  }
  for (const control of numbers) {
    if (steps.length > MAX_STEPS - (deferWaits ? 5 : 3)) break;
    const name = label(control);
    steps.push({ do: "tap", control: control.id, label: `Opening ${name}` });
    steps.push({ do: "up", times: 2, label: `Raising ${name}` });
    steps.push({ do: "tap", label: `Setting ${name}`, snap: `After ${name}` });
    tag(steps.length - 1, lineFor(name));
  }
  for (const control of switches) {
    if (steps.length >= MAX_STEPS - (deferWaits ? 3 : 1)) break;
    const name = label(control);
    steps.push({ do: "tap", control: control.id, label: `Trying ${name}`, snap: `After ${name}` });
    tag(steps.length - 1, lineFor(name));
  }

  play();
  if (deferWaits && steps.length < MAX_STEPS - 1) {

    const name = label(buttons[0]);
    steps.push({ do: "tap", control: buttons[0].id, fresh: true, label: `Starting ${name} for the timer` });
    waitOut();
  }

  if (!deferWaits) pressAgain();
  const wearer = lines.filter((l) => !taken.has(l) && wearerOnly(l));
  if (wearer.length) {
    proves[0] = [...(proves[0] ?? []), ...wearer];
    for (const line of wearer) taken.add(line);
  }

  const shows                           = {};
  const shown = lines.filter((l) => !taken.has(l) && showLines.has(l));
  if (shown.length) {
    for (const [i, step] of steps.entries()) if (i === 0 || step.snap) shows[i] = [...shown];
    for (const line of shown) taken.add(line);
  }
  return { steps, proves, shows, covered: lines.filter((l) => taken.has(l)), uncovered: lines.filter((l) => !taken.has(l)) };
}

function provesVerdicts(proves                          , report     , shows                                  = null)                  {
  const steps        = Array.isArray(report?.steps) ? report.steps : [];
  const problems        = Array.isArray(report?.problems) ? report.problems : [];
  const out = new Map                       ();
  const counts = (p     ) => p?.severity === "broken" || p?.severity === "fix";
  const tooFast = problems.find((p) => p?.code === "too_fast_to_play" && counts(p));

  if (tooFast) {
    for (const [key, lines] of Object.entries(proves || {})) {
      for (const requirement of Array.isArray(lines) ? lines : []) {
        if (PLAY_WORDS.test(requirement) && !RESTART_WORDS.test(requirement)) {
          out.set(requirement, { requirement, step: Number.isInteger(tooFast.step) ? tooFast.step : Number(key), outcome: "failed" });
        }
      }
    }
  }
  for (const [key, lines] of Object.entries(proves || {})) {
    const index = Number(key);
    const step = steps.find((s) => s?.index === index);
    if (!step || step.skipped || !Array.isArray(lines)) continue;
    const bad = problems.some((p) => p?.step === index && counts(p)) ||
      (tooFast && typeof step.do === "string" && step.do.startsWith("play:"));
    let outcome                             = "passed";
    const expected = step.expectOutcome === "passed";
    if (step.expectOutcome === "failed" || bad) outcome = "failed";
    else if (!expected && ((typeof step.do === "string" && step.do.startsWith("wait:")) || step.watch !== undefined) &&
      !step.changes && step.watchResult?.changed !== true) outcome = null;
    else if (!expected && typeof step.do === "string" && step.do.startsWith("play:") &&
      !(Array.isArray(step.play?.checkpoints) && step.play.checkpoints.length > 0)) outcome = null;
    if (!outcome) continue;
    for (const requirement of lines) {
      if (out.get(requirement)?.outcome === "failed") continue;
      out.set(requirement, { requirement, step: index, outcome });
    }
  }
  const showing = Object.entries(shows || {}).map(([key, lines]) => [Number(key), lines]         ).sort((a, b) => a[0] - b[0]);
  for (const [index, lines] of showing) {
    const step = steps.find((s) => s?.index === index);
    if (!step || step.skipped || !Array.isArray(lines)) continue;
    for (const requirement of lines) {
      if (!out.has(requirement) && lineShown(requirement, step.screen) === true) out.set(requirement, { requirement, step: index, outcome: "passed" });
    }
  }
  return [...out.values()];
}

function splitProves(steps     , lines          , match                                                   )
                                                                      {
  if (!Array.isArray(steps)) return { steps, proves: {}, unknown: [] };
  const proves                           = {};
  const unknown           = [];
  const clean = steps.map((step     , i        ) => {
    if (!step || typeof step !== "object" || Array.isArray(step) || !("proves" in step)) return step;
    const { proves: named, ...rest } = step;
    const names = (Array.isArray(named) ? named : [named]).filter((n     ) => typeof n === "string" && n.trim()).map((n        ) => n.trim());
    for (const name of names) {
      const line = match(lines, name);
      if (!line) { unknown.push(name.slice(0, PROGRAM_CARD_PROVES_MAX)); continue; }
      proves[i] = [...new Set([...(proves[i] ?? []), line])];
    }
    return rest;
  });
  return { steps: clean, proves, unknown };
}

const isDirectInputSource = (source         ) => typeof source === "string" && /\binput\s*[:=]\s*["']direct["']/.test(source);

function shiftProves(proves                          , offset        )                           {
  if (!offset) return proves;
  const out                           = {};
  for (const [key, lines] of Object.entries(proves || {})) out[Number(key) + offset] = lines;
  return out;
}

module.exports = { PROGRAM_CARD_HOST_TEST_PLAY_S, PROGRAM_CARD_HOST_TEST_MAX_WAIT_S, PROGRAM_CARD_PROVES_MAX, isShowLine, lineShown, timerWaits, hostFirstTest, provesVerdicts, splitProves, isDirectInputSource, shiftProves };
