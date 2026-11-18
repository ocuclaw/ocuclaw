const { BRAILLE_BLANK, Canvas, Glide, Palette, Row, THICK, THIN, Typist, bigDraw, bigWidth, bubble, bubbleLines, canvasRows, confetti, segLen, segStr, speckFrame, wrappedRow } = require("./canvas.cjs");

const { CARRY_ON_ITSELF, CARRY_ON_TYPED, CARRY_ON_UP_ARROW, RECORD_INDENT, RERUN_BASE, SetupModel, StepView, SETTINGS_RECHECK, SETTINGS_WAIT, inBubble, splitQuestion } = require("./model.cjs");
const { NUMBERED, SPIN, WEB_ADDRESS, clipAnsi, cpLen: len, ease, mmss, pyFullmatch, pyMatch, pyMod, pyRound, stripAnsi, trunc, wrap } = require("./text.cjs");

function pyInt(x        )         {
  return Math.trunc(x);
}

function numbered(line        )                {
  const match = pyMatch(NUMBERED, line);
  return match ? match[1] : null;
}

function lookup   (record                             , key        , fallback   )    {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : fallback;
}

class Look {
  name = "plain";
  p         ;

  final         ;

  shownWhole             ;

  static          SHINE_SWEEP = 1.2;
  static          SHINE_REST = 1.2;

  constructor(palette         ) {
    this.p = palette;
    this.final = false;
    this.shownWhole = new Set();
  }

  height(cols        , rows        )         {
    return Math.min(rows, 10);
  }

  draw(m            , t        , cols        , rows        )        {
    throw new Error(`${this.constructor.name}.draw is not implemented`);
  }

  since(key        , on         , t        )         {
    throw new Error(`${this.constructor.name}.since is not implemented`);
  }

  frame(m            , t        , cols        , rows        )        {
    const drawn = this.draw(m, t, cols, rows).map((row) => (row.height > 1 ? row : new Row(clipAnsi(row.text, cols))));
    let total = 0;
    const kept        = [];
    for (let i = drawn.length - 1; i >= 0; i--) {
      const row = drawn[i];
      if (total + row.height > rows) break;
      kept.push(row);
      total += row.height;
    }
    return kept.reverse();
  }

  takeCommits(m            , cols                = null)           {
    const out           = [];
    for (const index of [...m.steps.keys()].sort((a, b) => a - b)) {
      const view = m.steps.get(index)            ;
      if (view.done && !view.committed) {
        view.committed = true;
        out.push(...this.stepRecord(view, m, cols));
      }
    }
    return out;
  }

  stepRecord(view          , m            , cols                = null)           {
    const p = this.p;
    const title = lookup(m.wording.titles, String(view.index), view.header);
    const out = view.index ? [`${p.g}✓${p.reset} ${p.dim}${title} · ${view.index} of ${m.total}${p.reset}`] : [];
    for (const [kind, text] of view.lines) {
      const said = kind === "qa" ? text : m.condense(text);
      if (said && !said.startsWith("Stuck? Ask us") && !said.endsWith("...") && !said.endsWith("…")) {
        const lines = cols === null ? [said] : wrap(said, cols - RECORD_INDENT.length - 1);
        for (const line of lines) out.push(`${p.faint}${RECORD_INDENT}${line}${p.reset}`);
      }
    }
    return out;
  }

  spin(t        )         {
    const spin = Array.from(SPIN);
    return spin[pyMod(pyInt(t * 12), spin.length)];
  }

  blink(t        )          {
    return pyMod(pyInt(t * 2.5), 2) === 0;
  }

  shine(segs       , waited        )        {
    const p = this.p;
    const sweep = Look.SHINE_SWEEP;
    if (waited < 0 || segs.length < 2) return segs;
    const at = pyMod(waited, sweep + Look.SHINE_REST);
    if (at >= sweep) return segs;
    const [arrow, [words, style], ...rest] = segs;
    const chars = Array.from(words);
    const middle = (at / sweep) * (chars.length + 6) - 3;
    const out        = [arrow];
    chars.forEach((ch, i) => {
      const off = Math.abs(i - middle);
      const look = off <= 1 ? p.chip : off <= 2.5 ? style + p.gl : style;
      const last = out[out.length - 1];
      if (last[1] === look && out.length > 1) {
        out[out.length - 1] = [last[0] + ch, look];
      } else {
        out.push([ch, look]);
      }
    });
    return out.concat(rest);
  }

  status(m            , t        )                  {
    const p = this.p;
    const cursor = this.blink(t) ? "▌" : " ";

    const enter = m.waitingForEnter() && !m.restarting;

    const waited = this.since("ask", (m.asking || enter || Boolean(m.openPrompt())) && !m.typed, t);
    if (m.asking && m.question) {
      let [question, hint] = splitQuestion(m.question);
      if (inBubble(question)) {

        question = hint.replace(/\.+$/, "") || "Type your answer";
      }
      return [
        "ask",
        this.shine(
          [
            ["› ", p.g],
            [question, p.bold],
            [" " + m.typed + cursor, p.g],
          ],
          waited,
        ),
      ];
    }
    if (m.asking || enter) {
      let label = m.current === 7 && !m.code ? "Pair screen open? Press Enter" : "Press Enter to carry on";
      if (m.skipOffer()) {
        label = "Press Enter to skip this check";
      } else if (m.current === 7 && m.view().said().slice(-3).join(" ").includes("new code")) {
        label = "Press Enter for a new code";
      }
      return [
        "ask",
        this.shine(
          [
            ["› ", p.g],
            [label, p.bold],
            [" " + m.typed + cursor, p.g],
          ],
          waited,
        ),
      ];
    }
    const open = m.openPrompt();
    if (open) {
      return ["ask", this.shine([["› ", p.g], [open, p.bold], [" " + m.typed + cursor, p.g]], waited)];
    }
    if (m.typed) return ["ask", [["› " + m.typed + cursor, p.g]]];
    const busy = m.working();
    if (busy) return ["busy", [[`${this.spin(t)} ${busy}`, p.y]]];
    if (m.restarting) return ["busy", [[`${this.spin(t)} ${RESTART_STATUS.join(" ")}`, p.y]]];
    if (m.code && m.exitCode === null) return ["busy", [[`${this.spin(t)} Waiting for your phone…`, p.y]]];
    return ["", []];
  }

  hint(m            )         {
    if (m.asking && m.question) {
      const [question, hint] = splitQuestion(m.question);
      if (inBubble(question)) return "Then press Enter.";
      return hint || "Type your answer and press Enter.";
    }
    if (m.asking || (m.waitingForEnter() && !m.restarting)) return "Press Enter here when you're ready.";
    if (m.openPrompt()) return "Type your answer and press Enter.";
    return "";
  }

  finalLines(m            )           {
    if (m.exitCode === null || m.exitCode === 0) return [];
    const p = this.p;
    const lines = m
      .view()
      .said()
      .filter((said) => said)
      .slice(-8)
      .filter((said) => !this.shownWhole.has(said));
    if (!lines.length) return [];
    const out = [""];
    for (let line of lines) {
      const number = numbered(line);
      if (number !== null) line = `${p.bold}${p.g}${number}${p.reset}${line.slice(number.length)}`;
      out.push("  " + line);
    }
    return out;
  }

  body(m            )           {
    if (m.current === 0 && m.resumed) {

      return ["Picking up where you left off.", "A few more steps to go."];
    }
    if (m.exitCode === 0 && m.current >= m.total) {
      return ["OcuClaw is ready on your glasses.", "Stuck later? discord.ocuclaw.com"];
    }
    if (m.restarting) return [...RESTART_BODY];
    let lines = m.panelLines();
    if (m.current === 0 && !lines.length) {
      return ["Just eight short steps.", "I'll be on your glasses before you know it!"];
    }
    if (m.current === 2 && !lines.length && !m.asking && m.exitCode === null) {
      return [m.resumed ? SETTINGS_RECHECK : SETTINGS_WAIT];
    }
    if (m.asking && m.question) {
      const [question] = splitQuestion(m.question);
      if (inBubble(question)) lines = lines.concat([question]);
    }
    return lines;
  }
}

const PROP_COLOUR                                          = {
  "concept.warning": "r",
};
const CHEER                    = ["move.landTick", "move.finishFlag"];

const PAIR_LEAD                      = [
  ["On your phone: ", "dim"],
  ["Even › OcuClaw › ", ""],
  ["Pair with your agent", "bold"],
  [", then:", "dim"],
];
const PAIR_TYPE         = ["Pair manually", "  type the code above and this address:"];

const PAIR_ASKS = "wants to pair.";
const PAIR_ASKS_WHO = "A phone";
const PAIR_MATCH = "Match the words below.";

const PAIR_CODE_PLAIN = "Code: ";

const APPROVE_LEAD = "Match these four words with your phone, in order:";
const APPROVE_REFUSE = "If any word differs, type refuse.";

const RESTART_WORD = "RESTARTING";
const RESTART_STATUS                            = ["Dropping now.", "That's expected."];

const RESTART_TAG = " back in about a minute ";

const RESTART_BODY                    = [
  "This page drops in a few seconds.",
  "In about a minute, open the link below and send /terminal.",
];

const RESTART_LEAD                      = [
  ["In about a minute", "bold"],
  [", when your agent is back:", "dim"],
];
const RESTART_OPEN         = ["Open this link", "  not loaded yet? Refresh it."];
const RESTART_ENTER                                   = {
  [CARRY_ON_ITSELF]: ["Wait until /terminal shows in the box", "  then send it. Setup carries on."],
  [CARRY_ON_UP_ARROW]: ["Wait until /terminal shows in the box", "  then send it, then Up arrow and Enter."],
  [CARRY_ON_TYPED]: ["Wait until /terminal shows", `  send it, then type ${RERUN_BASE}.`],
};

const RESTART_RELOAD         = ["Reload this page", "  then send /terminal"];
const RESTART_BY_HAND                                   = {
  [CARRY_ON_ITSELF]: ["Setup carries on by itself", ""],
  [CARRY_ON_UP_ARROW]: ["Press the Up arrow, then Enter", "  to carry on"],
  [CARRY_ON_TYPED]: [`Type ${RERUN_BASE}`, "  to carry on"],
};

const RESTART_COMPACT_OPEN = "In about a minute, open this link. Wait until /terminal shows, send it:";
const RESTART_COMPACT_RELOAD = "In about a minute, reload this page and send /terminal.";

const COMPACT_PAIR_LEAD = "On your phone: Even › OcuClaw › Pair with your agent.";
const COMPACT_PAIR_TYPE = "Type the code above and this address:";

const COMPACT_LINK_LEAD                                   = {
  5: "Approve this server in Tailscale:",
  6: "Turn on HTTPS in Tailscale:",
};

const KEEP = 0;
const LEAD = 1;
const TITLE = 2;
const WHERE = 3;
const BUSY = 4;
const SPARE = 5;

const PLAIN_HINTS                    = ["Type your answer and press Enter.", "Press Enter here when you're ready."];

function wrapSegs(segs                                          , width        )          {
  const w = Math.max(4, width);
  let cells                     = [];
  for (const [text, style] of segs) for (const ch of Array.from(text)) cells.push([ch, style]);
  const lines                       = [];
  while (cells.length > w) {
    let cut = w;
    for (let i = w; i >= 1; i--) {
      if (cells[i][0] === " ") {
        cut = i;
        break;
      }
    }
    lines.push(cells.slice(0, cut));
    cells = cells.slice(cut);
    while (cells.length && cells[0][0] === " ") cells = cells.slice(1);
  }
  lines.push(cells);
  return lines.map((line) => {
    const joined        = [];
    for (const [ch, style] of line) {
      const last = joined[joined.length - 1];
      if (last && last[1] === style) joined[joined.length - 1] = [last[0] + ch, style];
      else joined.push([ch, style]);
    }
    return joined;
  });
}

function piecesHeight(pieces         )         {
  return pieces.reduce((sum, [, rows]) => sum + rows.reduce((n, r) => n + r.height, 0), 0);
}

class SpeckLook extends Look {
  name = "speck";

  static          SW = 47;
  static          BX = 49;
  static          BH = 8;
  static          TAIL_ROW = 2;

  static          CBX = 28;
  static          CBH = 4;
  static          RBH = 6;

  static          AX = 46;
  static          AH = 8;

  static          FLIP = 0.55;
  static          GF = 0.2;

  static          THUMB_AT = 0.62;

  static          LAND = 0.9;

  static          GREET = 6.4;

  static          SLIDE = 0.35;

  static          GLIDE = 0.35;

  static          POSE_HOLD = 0.15;

  static          POSE_MIN = 1.0;

  poses                       ;
  at                     ;
  typist        ;
  stepKey               ;
  done        ;
  landedAt        ;
  lastCode        ;
  codeLife        ;

  constructor(palette         ) {
    super(palette);
    this.poses = new Map();
    this.at = new Map();
    this.typist = new Typist();
    this.stepKey = null;
    this.done = 0;
    this.landedAt = -99.0;
    this.lastCode = "";
    this.codeLife = 1.0;
  }

  since(key        , on         , t        )         {
    if (!on) {
      this.at.delete(key);
      return -1.0;
    }
    if (!this.at.has(key)) this.at.set(key, t);
    return Math.max(0.0, t - (this.at.get(key)          ));
  }

  notice(m            , t        )       {
    const key = `${m.current}|${m.restarting}|${Boolean(m.code)}|${m.exitCode}`;
    if (key !== this.stepKey) {
      this.stepKey = key;
      this.typist.fresh(t);
    }
    const done = m.doneCount();
    if (done > this.done) this.landedAt = t;
    this.done = done;
    if (m.code) {
      this.lastCode = m.code.toUpperCase();
      const left = m.codeLeft();
      if (left !== null && m.codeSeconds) {
        this.codeLife = Math.max(0.0, Math.min(1.0, left / m.codeSeconds));
      }
    } else {
      this.at.delete("code");
    }
    if (m.current !== 8) this.at.delete("say-hi");
    if (!m.reply()) this.at.delete("reply");
  }

  pose(state        , t        , size                )        {
    const held = this.poses.get(size);

    const baked = (name        , since        )        => speckFrame(name, name.startsWith("move.") ? t - since : t, size);

    if (held === undefined || !(0 <= t - held.t && t - held.t <= 0.5)) {
      const live = baked(state, t);
      this.poses.set(size, { state, t, shown: live, glide: null, want: [state, t], since: t });
      return live;
    }

    if (held.want[0] !== state) held.want = [state, t];
    if (held.state !== state && t - held.want[1] >= SpeckLook.POSE_HOLD && t - held.since >= SpeckLook.POSE_MIN) {
      held.state = state;
      held.since = t;
      held.glide = [new Glide(held.shown, baked(state, t)), t];
    }
    const live = baked(held.state, held.since);
    let shown = live;
    if (held.glide !== null) {
      const [glide, since] = held.glide;
      if (t - since < SpeckLook.GLIDE) {
        shown = glide.frame((t - since) / SpeckLook.GLIDE);
      } else {
        held.glide = null;
      }
    }
    held.t = t;
    held.shown = shown;
    return shown;
  }

  landedAge(m            , t        )         {
    return m.exitCode === 0 ? 99.0 : t - this.landedAt;
  }

  state(m            , t        )         {
    if (m.restarting) return "idle.nap";
    if (m.exitCode !== null) return m.speckState();
    if (m.code) return "move.signalEyes";
    if (this.since("paired", m.paired(), t) >= 0) return "move.pairTick";
    const greet = this.since("greet", m.resumed && m.current <= 3, t);
    if (0 <= greet && greet < SpeckLook.GREET) return "move.wakeWave";
    if (m.current !== 8 && this.landedAge(m, t) < SpeckLook.LAND) return "move.landTick";
    const own = m.speckState();
    if (this.typist.talking(t) && !CHEER.includes(own)) return "concept.speaking";
    return own;
  }

  colours(state        )                   {
    return [this.p.g, this.p[lookup               (PROP_COLOUR, state, "g")]];
  }

  style(name           )         {
    const p = this.p;
    return { "": "", dim: p.dim, bold: p.bold, faint: p.faint }[name];
  }

  pipSegs(m            , t        )        {
    const p = this.p;
    const segs        = [];
    const doneAll = m.exitCode === 0;
    for (let n = 1; n <= m.total; n++) {
      const done = m.isDone(n) || doneAll;
      const cur = m.current === n && !done;
      const ch = done ? "●" : cur ? (this.blink(t) ? "◉" : "●") : "○";
      segs.push([ch, done ? p.g : cur ? p.gl : p.faint]);
      if (n < m.total) segs.push([" ", ""]);
    }
    if (doneAll) {
      segs.push([`  ${m.total} of ${m.total} · done`, p.g]);
    } else if (m.current >= 1) {
      segs.push([`  ${m.current} of ${m.total}`, p.dim]);
    }
    return segs;
  }

  pips(c        , m            , t        , x        , w        , y        )       {
    const segs = this.pipSegs(m, t);
    c.segs(x + w - 5 - segLen(segs), y, [[" ", ""], ...segs, [" ", ""]]);
  }

  typed(c        , x        , y        , text        , shown        , typing         , style = "")       {
    const chars = Array.from(text);
    const part = chars.slice(0, shown);
    const head = typing && shown < chars.length ? Math.max(0, part.length - 3) : part.length;
    c.text(x, y, part.slice(0, head).join(""), style);
    if (head < part.length) c.text(x + head, y, part.slice(head).join(""), this.p.gl);
  }

  flip(c        , x        , y        , old        , neu        , age        , oldSt        , newSt        )       {
    const was = Array.from(old);
    const now = Array.from(neu);
    const n = Math.max(was.length, now.length);
    const p = this.p;
    const { FLIP, GF } = SpeckLook;
    for (let i = 0; i < n; i++) {
      const start = n > 1 ? (i * (FLIP - GF)) / (n - 1) : 0.0;
      const f = (age - start) / GF;
      const a = i < was.length ? was[i] : " ";
      const b = i < now.length ? now[i] : " ";

      const gx = (ch        )         => x + i * 3 + (ch === "✓" ? 1 : 0);

      if (f <= 0) {
        bigDraw(c, gx(a), y, a, oldSt);
      } else if (f >= 1) {
        bigDraw(c, gx(b), y, b, age - start - GF < 1 / 12 ? p.fg : newSt);
      } else {
        const band = 3.5 * Math.abs(2 * f - 1);
        if (band < 1) {

          c.text(x + i * 3, y, "⣀⣀⡀", p.dim);
          continue;
        }
        const ch = f < 0.5 ? a : b;
        bigDraw(c, gx(ch), y, ch, f < 0.5 ? oldSt : newSt, {
          mask: (px        , py        ) => Math.abs(py - 3) <= band,
        });
      }
    }
  }

  flipIn(c        , x        , y        , word        , age        , style        )       {
    const chars = Array.from(word);
    const n = chars.length;
    const { FLIP, GF } = SpeckLook;
    chars.forEach((ch, i) => {
      const f = (age - (n > 1 ? (i * (FLIP - GF)) / (n - 1) : 0.0)) / GF;
      if (f <= 0.5) {
        if (f > 0) c.text(x + i * 3, y, "⣀⣀⡀", this.p.dim);
        return;
      }
      const band = 3.5 * Math.abs(2 * Math.min(1.0, f) - 1);
      bigDraw(c, x + i * 3, y, ch, style, {
        mask: f >= 1 ? null : (px        , py        ) => Math.abs(py - 3) <= band,
      });
    });
  }

  countdown(c        , x        , y        , w        , m            , t        )       {
    const p = this.p;
    const life = m.codeSeconds || 300;
    const codeLeft = m.codeLeft();
    const left = codeLeft === null ? life : codeLeft;
    const urgent = left < 60;
    const [on, low] = urgent ? [p.y, p.yLow] : [p.g, p.gd];
    const clock = mmss(left);
    const bw = SpeckLook.barCells(w, clock);
    const exact = (left / life) * bw;
    const n = Math.max(left > 0 ? 1 : 0, Math.ceil(exact));
    for (let i = 0; i < bw; i++) {
      if (i < n) {
        c.put(x + 3 + i, y, THICK, i === n - 1 && exact - (n - 1) < 0.5 ? low : on);
      } else {
        c.put(x + 3 + i, y, THIN, p.faint);
      }
    }

    const at = n - 1 - pyInt((pyMod(t, 2.4) / 2.4) * (n + 14));
    for (let i = 0; i < 3; i++) {
      const cx = at + i;
      if (0 <= cx && cx < n - 1) {
        c.put(x + 3 + cx, y, THICK, i === 1 ? (urgent ? p.yGlint : p.gl) : on);
      }
    }
    let lx = c.text(x + 3 + bw, y, " ");
    lx = c.text(lx, y, clock, p.bold + (urgent ? p.y : p.fg));
    c.text(lx, y, " left ", urgent ? p.y : p.dim);
  }

  static barCells(w        , clock = "0:00")         {
    return w - 7 - len(` ${clock} left `);
  }

  choices(c        , m            , faint         )       {
    const p = this.p;
    const st = (name           )         => (faint ? p.faint : this.style(name));
    const num = faint ? p.faint : p.bold + p.g;
    c.segs(
      0,
      4,
      PAIR_LEAD.map(([text, name])      => [text, st(name)]),
    );
    const y = 5;
    c.text(0, y, "1", num);
    const x = c.text(3, y, PAIR_TYPE[0], st("bold"));
    c.text(x, y, PAIR_TYPE[1], st("dim"));
    if (m.address) c.text(3, y + 1, m.address, st(""));
  }

  linkBlock(c        , m            , y        )       {
    const p = this.p;
    const num = p.bold + p.g;
    c.segs(
      0,
      y,
      RESTART_LEAD.map(([text, name])      => [text, this.style(name)]),
    );
    const [first, second] = m.reopen
      ? [RESTART_OPEN, RESTART_ENTER[m.carryOn]]
      : [RESTART_RELOAD, RESTART_BY_HAND[m.carryOn]];
    c.text(0, y + 1, "1", num);
    let x = c.text(3, y + 1, first[0], p.bold);
    c.text(x, y + 1, first[1], p.dim);
    if (m.reopen) c.text(3, y + 2, m.reopen, p.c + p.under);
    c.text(0, y + 3, "2", num);
    x = c.text(3, y + 3, second[0], p.bold);
    c.text(x, y + 3, second[1], p.dim);
  }

  dozing(c        , t        )       {
    const asleep = this.since("asleep", true, t) - 0.5;
    if (asleep < 0) return;
    const life = 2.1;
    const p = this.p;
    for (let k = 0; k < 3; k++) {
      const a = asleep - k * (life / 3);
      if (a < 0) continue;
      const f = pyMod(a, life) / life;
      const x = pyRound(19 + f * 4 + Math.sin(f * 7 + k * 2) * 0.6);
      const y = pyRound(2.4 - f * 2.6);
      if (y < 0 || !c.empty(x, y)) continue;
      c.put(x, y, f < 0.45 ? "z" : "Z", f < 0.25 ? p.faint : f < 0.75 ? p.dim : p.faint);
    }
  }

  help(c        , x        , y        , text        , style        )         {
    for (const part of text.split(WEB_ADDRESS)) {
      if (part) x = c.text(x, y, part, pyFullmatch(WEB_ADDRESS, part) ? this.p.c : style);
    }
    return x;
  }

  main(c        , m            , t        , st        )       {
    const p = this.p;
    const bx = SpeckLook.BX;
    const bh = SpeckLook.BH;
    const bw = c.cols - bx;
    const tx = bx + 2;
    const tw = bw - 4;
    const [body, prop] = this.colours(st);
    c.speck(0, 1, st, t, "big", {
      crop: [0, SpeckLook.SW - 1],
      body,
      prop,
      frame: this.pose(st, t, "big"),
    });
    const [border, title] = m.exitCode !== null && m.exitCode !== 0 ? [p.r, p.bold] : [p.dim, p.bold];
    bubble(c, bx, 0, bw, bh, border, { row: SpeckLook.TAIL_ROW });
    c.text(bx + 3, 0, ` ${trunc(m.title(), bw - 8)} `, title);
    this.pips(c, m, t, bx, bw, bh - 1);
    let [kind, status] = this.status(m, t);
    const busy = kind === "busy";
    const said = this.typist.shown(this.body(m), t);
    let lines = bubbleLines(said, tw);

    let starts = said.flatMap(([text]) => bubbleLines([[text, 0]], tw).map((_, k) => k === 0));
    const room = busy ? bh - 3 : bh - 2;
    if (this.final) {

      let first = lines.length - room;
      for (const [text, shown] of said) {
        if (first <= 0 && shown >= len(text)) this.shownWhole.add(text);
        first -= bubbleLines([[text, 0]], tw).length;
      }
    }
    lines = lines.slice(-room);
    starts = starts.slice(-room);
    lines.forEach(([text, shown, typing], i) => {
      this.typed(c, tx, 1 + i, text, shown, typing);
      const number = numbered(text);
      if (number !== null && starts[i] && shown >= number.length) c.text(tx, 1 + i, number, p.bold + p.g);
    });
    if (busy) c.segs(tx, Math.min(bh - 2, 1 + lines.length + (lines.length ? 1 : 0)), status, tw);
    let hint = this.hint(m);
    if (kind === "ask" && !m.typed && this.typist.talking(t)) {

      kind = "";
      status = [];
      hint = "";
    }
    if (kind === "ask") {

      const px = Math.max(0, Math.min(bx, c.cols - 1 - Math.max(len(hint), segLen(status))));
      c.segs(px, bh, status);
      if (hint) c.text(px, bh + 1, trunc(hint, c.cols - px), p.dim);
    } else if (hint) {
      c.text(bx, bh + 1, trunc(hint, c.cols - bx), p.dim);
    }
    if (m.approve && kind !== "ask") {

      const how = m.wording.clickHint;
      const px = Math.max(0, Math.min(bx, c.cols - 3 - len(how) - len(m.approve)));
      c.text(px, bh + 1, "› ", p.g);
      const lx = how ? c.text(px + 2, bh + 1, how, p.dim) : px + 2;
      c.text(lx, bh + 1, m.approve, p.c + p.under);
    }

    const landed = this.landedAge(m, t);
    if (0 <= landed && landed < 2 / 12) c.tint(bx - 3, 0, c.cols - 1, bh - 1, border, p.gl);
  }

  code(c        , m            , t        , st        )       {
    const p = this.p;
    const cbx = SpeckLook.CBX;
    const cbh = SpeckLook.CBH;
    const cbw = c.cols - cbx;
    const [body, prop] = this.colours(st);
    c.speck(0, 0, st, t, "mini", { body, prop, frame: this.pose(st, t, "mini") });
    bubble(c, cbx, 0, cbw, cbh, p.dim, { row: 1 });
    c.text(cbx + 3, 0, ` ${trunc(m.title(), 26)} `, p.bold);
    this.pips(c, m, t, cbx, cbw, 0);
    const code = (m.code || "").toUpperCase();

    this.flip(c, cbx + 2, 1, " ".repeat(len(code)), code, this.since("code", true, t), p.fg, p.fg);
    const [kind, status] = this.status(m, t);
    const sx = cbx + 2 + bigWidth(code) + 3;
    const room = cbx + cbw - 2 - sx;
    const words = m.words !== null && m.words.length > 0;
    if (words) {

      c.text(sx, 1, trunc(`${m.device || PAIR_ASKS_WHO} ${PAIR_ASKS}`, room), p.bold);
      c.text(sx, 2, trunc(PAIR_MATCH, room), p.dim);
    } else {
      if (kind) c.segs(sx, 1, status, room);

      c.segs(sx, 2, [[PAIR_CODE_PLAIN, p.dim], [code, p.bold]], room);
    }
    this.countdown(c, cbx, cbh - 1, cbw, m, t);
    if (words) {
      this.approval(c, m, kind === "ask" ? status : []);
      return;
    }

    this.choices(c, m, false);
  }

  approval(c        , m            , ask       )       {
    const p = this.p;
    c.text(0, 4, APPROVE_LEAD, p.dim);
    const inner = "   " + (m.words || []).join("   ") + "   ";
    const across = "─".repeat(len(inner));
    c.text(2, 5, "┌" + across + "┐", p.dim);
    c.text(2, 6, "│", p.dim);
    c.text(3, 6, inner, p.bold);
    c.text(3 + len(inner), 6, "│", p.dim);
    c.text(2, 7, "└" + across + "┘", p.dim);
    c.text(0, 8, APPROVE_REFUSE, p.dim);
    if (ask.length) c.segs(0, 9, ask);
  }

  paired(c        , m            , t        , st        )       {
    const p = this.p;
    const cbx = SpeckLook.CBX;
    const cbh = SpeckLook.CBH;
    const cbw = c.cols - cbx;
    const { FLIP } = SpeckLook;
    const age = this.since("paired", true, t);

    if (age < SpeckLook.THUMB_AT) {
      const glow = age < 1 / 12 || age > FLIP - 1 / 12 ? p.fg : p.gl;
      c.speck(0, 0, st, t, "mini", { body: p.g, prop: glow, frame: this.pose(st, t, "mini") });
    } else {
      const [body, prop] = this.colours(st);
      c.speck(0, 0, st, t, "mini", { body, prop, frame: this.pose(st, t, "mini") });
    }
    bubble(c, cbx, 0, cbw, cbh, p.g, { row: 1 });
    c.text(cbx + 3, 0, ` ${m.title()} `, p.bold + p.g);
    this.pips(c, m, t, cbx, cbw, 0);
    const old = this.lastCode;
    this.flip(c, cbx + 2, 1, old, "PAIRED✓".padEnd(len(old)), age, p.fg, p.gl);

    const bw = cbw - 6;
    const n0 = Math.max(1, Math.ceil(this.codeLife * SpeckLook.barCells(cbw)));
    const n = pyRound(n0 + (bw - n0) * ease(age / FLIP));
    for (let i = 0; i < bw; i++) {
      const head = age < FLIP && n - 2 <= i && i < n;
      c.put(cbx + 3 + i, cbh - 1, i < n ? THICK : THIN, i < n ? (head ? p.gl : p.g) : p.faint);
    }

    this.choices(c, m, true);
  }

  restart(c        , m            , t        )       {
    const p = this.p;
    const bx = SpeckLook.CBX;
    const bh = SpeckLook.RBH;
    const bw = c.cols - bx;
    c.speck(0, 1, "idle.nap", t, "mini", { body: p.g, prop: p.g, frame: this.pose("idle.nap", t, "mini") });
    this.dozing(c, t);
    bubble(c, bx, 0, bw, bh, p.faint, { row: 1 });
    c.text(bx + 3, 0, ` ${m.title()} `, p.bold + p.dim);
    this.pips(c, m, t, bx, bw, 0);
    this.flipIn(c, bx + 3, 1, RESTART_WORD, this.since("restart", true, t), p.fg);
    const sx = bx + 3 + bigWidth(RESTART_WORD) + 3;
    c.text(sx, 1, this.spin(t), p.g);
    c.text(sx + 2, 1, RESTART_STATUS[0]);
    c.text(sx + 2, 2, RESTART_STATUS[1], p.dim);
    c.text(bx + 3, 4, trunc(this.body(m)[0], bw - 6), p.dim);

    c.text(bx + bw - 3 - len(RESTART_TAG), bh - 1, RESTART_TAG, p.dim);

    this.linkBlock(c, m, bh);
  }

  sayHi(c        , m            , t        , st        )       {
    const p = this.p;
    const bx = SpeckLook.BX;
    const bw = c.cols - bx;
    const tx = bx + 2;
    const tw = bw - 4;
    const [body, prop] = this.colours(st);
    c.speck(0, 1, st, t, "big", {
      crop: [0, SpeckLook.SW - 1],
      body,
      prop,
      frame: this.pose(st, t, "big"),
    });
    const [kind, status] = this.status(m, t);
    if (m.asking && m.question) {
      this.askHi(c, m, t, status);
      return;
    }
    bubble(c, bx, 0, bw, 4, p.dim, { row: 1 });
    c.text(bx + 3, 0, ` ${trunc(m.title(), bw - 8)} `, p.bold);
    this.pips(c, m, t, bx, bw, 3);
    let y = 1;
    for (const [text, shown] of this.typist.shown(this.body(m).slice(-1), t)) {
      this.typed(c, tx, y, trunc(text, tw), Math.min(shown, tw), shown < len(text));
      y += 1;
    }
    if (kind) c.segs(tx, y, status, tw);
    const hint = this.hint(m);
    if (hint) c.text(bx, 9, trunc(hint, c.cols - bx), p.dim);
    const right = c.cols - 4;
    let reply = m.reply();

    reply = reply ? m.condense(reply) || reply : reply;
    if (reply) {
      const lines = wrap(reply, 24).slice(0, 2);
      const w = Math.max(...lines.map(len)) + 6;
      const x = right - w + 1;
      bubble(c, x, 5, w, 4, p.g, { row: 1, right: true });
      const fresh = this.since("reply", true, t) < 1 / 12;
      c.put(x + 2, 6, "✓", p.bold + p.g);
      lines.forEach((line, i) => {
        c.text(x + 4, 6 + i, line, fresh ? p.fg : p.gl);
      });
      return;
    }
    const w = 14;
    const home = right - w + 1;
    const x = pyRound(c.cols + 1 - (c.cols + 1 - home) * ease(this.since("say-hi", true, t) / SpeckLook.SLIDE));
    bubble(c, x, 5, w, 4, p.faint, { row: 1, right: true });

    const slot = pyInt((pyMod(t, 1.2) / 1.2) * 4);
    for (let i = 0; i < 3; i++) {
      const fg = slot === i ? p.y : slot === i + 1 ? p.dim : p.faint;
      c.text(x + 3 + i * 3, 6, "⣠⣄", fg);
      c.text(x + 3 + i * 3, 7, "⠙⠋", fg);
    }
  }

  askHi(c        , m            , t        , status       )       {
    const p = this.p;
    const bx = SpeckLook.BX;
    const bw = c.cols - bx;
    const tx = bx + 2;
    const tw = bw - 4;
    const prompt = wrapSegs(status, tw);
    let lines = bubbleLines(this.typist.shown(this.body(m).slice(-1), t), tw);
    const room = Math.max(0, c.rows - 3 - prompt.length);
    if (lines.length > room) {
      lines = lines.slice(0, room);
      if (lines.length) {
        const [last, shown, typing] = lines[lines.length - 1];
        const text = Array.from(last).slice(0, tw - 1).join("").trimEnd() + "…";
        lines[lines.length - 1] = [text, shown >= len(last) ? len(text) : Math.min(shown, len(text)), typing];
      }
    }
    const bh = Math.max(4, 2 + lines.length + prompt.length);
    bubble(c, bx, 0, bw, bh, p.dim, { row: 1 });
    c.text(bx + 3, 0, ` ${trunc(m.title(), bw - 8)} `, p.bold);
    this.pips(c, m, t, bx, bw, bh - 1);
    let y = 1;
    for (const [text, shown, typing] of lines) {
      this.typed(c, tx, y, text, shown, typing);
      y += 1;
    }
    for (const segs of prompt) {
      c.segs(tx, y, segs, tw);
      y += 1;
    }
    const hint = this.hint(m);
    if (hint) c.text(bx, c.rows - 1, trunc(hint, c.cols - bx), p.dim);
  }

  allSet(c        , m            , t        )       {
    const p = this.p;
    const ax = SpeckLook.AX;
    const ah = SpeckLook.AH;
    const aw = c.cols - ax;
    const age = this.since("all-set", true, t);
    const frame = this.pose("move.finishFlag", t, "big");
    c.speck(0, 1, "move.finishFlag", t, "big", { crop: [0, ax - 4], body: p.g, prop: p.gl, frame });
    bubble(c, ax, 0, aw, ah, p.g, { row: 2 });
    this.pips(c, m, t, ax, aw, ah - 1);
    const inner = aw - 2;
    const word = m.title().toUpperCase();
    const ww = bigWidth(word);

    const sweep = (age / 0.6) * (ww + 6) - 3;

    const shade = (gi        , cx        )         =>
      age < 1 / 12 || Math.abs(gi * 3 + cx - sweep) < 2 ? p.fg : p.gl;

    bigDraw(c, ax + 1 + Math.floor((inner - ww) / 2), 1, word, shade, { solid: true, bold: true });
    this.body(m)
      .slice(0, 2)
      .forEach((line, i) => {
        const text = trunc(line, inner - 2);
        const x = ax + 1 + Math.floor((inner - len(text)) / 2);
        if (i === 0) {
          c.text(x, 4, text, p.fg);
        } else {
          this.help(c, x, 5, text, p.dim);
        }
      });

    const inside                     = [];
    for (let y = 1; y < ah - 1; y++) {
      for (let x = ax + 1; x < ax + aw - 1; x++) inside.push([x, y]);
    }
    for (const [x, y] of inside) {
      if (c.empty(x, y)) c.put(x, y, BRAILLE_BLANK);
    }
    confetti(c, age);
    for (const [x, y] of inside) {
      const cell = c.get(x, y);
      if (cell !== null && cell[0] === BRAILLE_BLANK) c.put(x, y, " ");
    }
  }

  settled(m            , cols        )        {
    const p = this.p;
    const c = new Canvas(cols, 4, p);
    c.speck(0, 0, "move.finishFlag", 7.99, "mini", { body: p.g, prop: p.gl });
    const lines = this.body(m);
    const ready = lines[0];
    const help = lines.length > 1 ? lines[1] : "";
    const x = SpeckLook.CBX;
    const w = Math.min(cols - x, Math.max(len(ready) + 2, len(help)) + 6);
    bubble(c, x, 0, w, 4, p.gd, { row: 1 });
    c.text(x + 3, 0, ` ${m.title()} `, p.bold + p.g);
    c.put(x + 2, 1, "✓", p.bold + p.g);
    c.text(x + 4, 1, ready, p.gl);
    if (help) this.help(c, x + 4, 2, help, p.dim);
    return canvasRows(c);
  }

  draw(m            , t        , cols        , rows        )        {
    this.notice(m, t);
    this.shownWhole = new Set();
    if (cols < 80 || rows < 10) return this.compact(m, t, cols, rows);
    const finished = m.exitCode === 0 && m.current >= m.total;
    if (finished && this.final) return this.settled(m, cols);
    const c = new Canvas(cols, 10, this.p);
    const st = this.state(m, t);
    if (finished) {
      this.allSet(c, m, t);
    } else if (m.restarting) {
      this.restart(c, m, t);
    } else if (m.code) {
      this.code(c, m, t, st);
    } else if (m.paired()) {
      this.paired(c, m, t, st);
    } else if (m.current === 8 && m.exitCode === null) {
      this.sayHi(c, m, t, st);
    } else {
      this.main(c, m, t, st);
    }
    return this.longLinks(canvasRows(c), m, cols);
  }

  longLinks(out       , m            , cols        )        {
    const p = this.p;
    for (const link of [m.reopen]) {
      if (!link || 3 + len(link) <= cols) continue;
      const head = "   " + Array.from(link).slice(0, cols - 3).join("");
      out.forEach((row, i) => {
        if (stripAnsi(row.text).startsWith(head)) out[i] = wrappedRow(link, p.c + p.under, cols, p, 0);
      });
    }
    return out;
  }

  compact(m            , t        , cols        , rows        )        {
    const p = this.p;
    const width = Math.max(10, cols - 2);
    const st = this.state(m, t);
    const [kind, status] = this.status(m, t);

    const said          = [];
    const words = this.body(m);
    for (const raw of words) {
      const lines        = [];
      wrap(raw, width).forEach((wrapped, k) => {
        let line = wrapped;
        const number = k === 0 ? numbered(line) : null;
        if (number !== null) line = `${p.bold}${p.g}${number}${p.reset}${line.slice(number.length)}`;
        lines.push(new Row(" " + line));
      });
      said.push(lines);
    }

    const still = this.compactStill(m, t, cols, width);

    const ask          = [];
    if (kind) {

      const prompt = wrapSegs(status, cols - 1);
      ask.push([kind === "ask" ? KEEP : BUSY, prompt.map((line) => new Row(" " + segStr(line, p)))]);
    }
    if (kind === "ask") {
      const hint = this.hint(m);
      if (hint && !PLAIN_HINTS.includes(hint)) {
        const rank = hint === "Then press Enter." ? SPARE : LEAD;
        ask.push([rank, wrap(hint, width).map((line) => new Row(` ${p.dim}${line}${p.reset}`))]);
      }
    }
    const fixed = piecesHeight([...still, ...ask]);

    let head       ;

    const saidRows = said.reduce((sum, lines) => sum + lines.length, 0);
    if (cols >= 26 + 2 * m.total && 4 + fixed + Math.min(saidRows, 2) <= rows) {
      const c = new Canvas(cols, 4, p);
      const [body, prop] = this.colours(st);
      c.speck(0, 0, st, t, "mini", { body, prop, frame: this.pose(st, t, "mini") });
      const title = wrap(m.title(), cols - 27);
      c.text(26, 0, title[0] || "", p.bold);
      if (title.length > 1) c.text(26, 1, trunc(title.slice(1).join(" "), cols - 27), p.bold);
      c.segs(26, 2, this.pipSegs(m, t).slice(0, 2 * m.total - 1));
      if (1 <= m.current && m.current <= m.total) c.text(26, 3, `step ${m.current} of ${m.total}`, p.dim);
      head = canvasRows(c);
    } else {
      const step = 1 <= m.current && m.current <= m.total ? ` · ${m.current} of ${m.total}` : "";
      const title = wrap(m.title(), width - len(step));
      head = title.map((line, k) => new Row(` ${p.bold}${line}${p.reset}${k === title.length - 1 ? p.dim + step + p.reset : ""}`));
    }

    const pieces          = [[TITLE, head], ...still, ...ask];
    while (piecesHeight(pieces) > rows) {
      const worst = Math.max(...pieces.map(([rank]) => rank));
      if (worst === KEEP) break;
      pieces.splice(
        pieces.findIndex(([rank]) => rank === worst),
        1,
      );
    }
    const top = pieces[0][1] === head ? (pieces.shift()         )[1] : [];
    const rest = pieces.flatMap(([, r]) => r);

    let room = Math.max(0, rows - [...top, ...rest].reduce((sum, r) => sum + r.height, 0));
    const kept        = [];
    for (let i = said.length - 1; i >= 0 && said[i].length <= room; i--) {
      kept.unshift(...said[i]);
      room -= said[i].length;
      if (this.final) this.shownWhole.add(words[i]);
    }
    return [...top, ...kept, ...rest];
  }

  compactStill(m            , t        , cols        , width        )          {
    const p = this.p;
    const out          = [];
    const say = (rank        , text        , style         = "")       => {
      out.push([rank, wrap(text, width).map((line) => new Row(style ? ` ${style}${line}${p.reset}` : ` ${line}`))]);
    };
    const link = (url        , style         = p.c + p.under)       => {
      out.push([KEEP, [wrappedRow(url, style, cols, p, 1)]]);
    };
    if (m.code) {
      const left = m.codeLeft();
      const expiry = left !== null ? `expires in ${mmss(left)}` : "expires soon";

      let code = Array.from(m.code.toUpperCase()).join(" ");
      if (4 + len(code) + len(expiry) > width) code = m.code.toUpperCase();
      const chip = new Row(" " + segStr([[` ${code} `, p.chip], ["  " + expiry, p.dim]], p));
      if (m.words !== null && m.words.length > 0) {

        out.push([WHERE, [chip]]);
        say(TITLE, `${m.device || PAIR_ASKS_WHO} ${PAIR_ASKS}`, p.bold);
        say(LEAD, APPROVE_LEAD, p.dim);

        const words = m.words.join("   ");
        if (len(words) <= width) out.push([KEEP, [new Row(` ${p.bold}${p.g}${words}${p.reset}`)]]);
        else say(KEEP, m.words.join(" "), p.bold + p.g);
        say(SPARE, APPROVE_REFUSE, p.dim);
        return out;
      }
      out.push([KEEP, [chip]]);
      say(WHERE, COMPACT_PAIR_LEAD, p.dim);
      if (m.address) {
        say(LEAD, COMPACT_PAIR_TYPE);
        link(m.address, "");
      }
      return out;
    }
    if (m.restarting) {
      if (m.reopen) {
        say(LEAD, RESTART_COMPACT_OPEN, p.bold);
        link(m.reopen);
      } else {
        say(LEAD, RESTART_COMPACT_RELOAD, p.bold);
      }
      return out;
    }
    if (m.approve) {
      const lead = m.wording.compactLinkHint || COMPACT_LINK_LEAD[m.current];
      if (lead) say(LEAD, lead, m.wording.compactLinkHint ? p.dim : p.bold);
      link(m.approve);
    }
    return out;
  }
}

module.exports = { Look, PROP_COLOUR, CHEER, PAIR_LEAD, PAIR_TYPE, PAIR_ASKS, PAIR_ASKS_WHO, PAIR_MATCH, PAIR_CODE_PLAIN, APPROVE_LEAD, APPROVE_REFUSE, RESTART_WORD, RESTART_STATUS, RESTART_TAG, RESTART_BODY, RESTART_LEAD, RESTART_OPEN, RESTART_ENTER, RESTART_RELOAD, RESTART_BY_HAND, RESTART_COMPACT_OPEN, RESTART_COMPACT_RELOAD, COMPACT_PAIR_LEAD, COMPACT_PAIR_TYPE, COMPACT_LINK_LEAD, KEEP, LEAD, TITLE, WHERE, BUSY, SPARE, PLAIN_HINTS, wrapSegs, SpeckLook };
