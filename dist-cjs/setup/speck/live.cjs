const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const process = require("node:process");
const { pyRstrip, stripAnsi } = require("./text.cjs");
const { CELEBRATE_SECONDS, FPS, FULL_REDRAW_SECONDS, inDashboardTerminal, INTRO_SECONDS, LINE_HOLD_SECONDS, LOOKS, MIN_STEP_SECONDS, PAIRED_HOLD_SECONDS, REWRITE, SetupModel } = require("./model.cjs");

const { isLightBackground, Palette, screenRows } = require("./canvas.cjs");

const { SpeckLook } = require("./look.cjs");

const { OPENCLAW_WORDING } = require("./openclaw-wording.cjs");
const { terminalText } = require("../terminal-text.cjs");

const STEP_START = /^\[(\d+)\/(\d+)\]\s/;

const MAX_TYPED = 200;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"]         ;

const STOP_TYPE_SECONDS = 2.2;

const PROBE_ANSWER = "\u001b[1;2R";

const CSI = /\u001b\[([0-?]*)([ -/]*)([@-~])/y;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/y;
const ESC2 = /\u001b[@-Z\\-_]/y;

const CUT_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*\u001b?)?$/;

function defaultClock()         {
  return performance.now() / 1000;
}

function defaultSleep(seconds        )                {

  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

function unref(timer     )      {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

function decodeBytes(chunk         )         {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return String(chunk);
}

const EmitterBase                    = EventEmitter;

class LookIn extends EmitterBase {
  live              ;
  isTTY         ;
  isRaw         ;

  speckLook         ;
  encoding               ;

  flowing                ;
  readable         ;

  constructor(live              ) {
    super();
    this.live = live;
    this.isTTY = true;
    this.isRaw = false;
    this.speckLook = true;
    this.encoding = null;
    this.flowing = null;
    this.readable = true;
  }

  get readableFlowing()                 {
    return this.flowing;
  }

  on(event        , listener                          )       {
    super.on(event, listener);
    this.live.syncSoon();
    return this;
  }

  addListener(event        , listener                          )       {
    return this.on(event, listener);
  }

  prependListener(event        , listener                          )       {
    super.prependListener(event, listener);
    this.live.syncSoon();
    return this;
  }

  once(event        , listener                          )       {
    super.once(event, listener);
    this.live.syncSoon();
    return this;
  }

  off(event        , listener                          )       {
    return this.removeListener(event, listener);
  }

  removeListener(event        , listener                          )       {
    super.removeListener(event, listener);
    this.live.syncSoon();
    return this;
  }

  removeAllListeners(event         )       {
    if (event === undefined) super.removeAllListeners();
    else super.removeAllListeners(event);
    this.live.syncSoon();
    return this;
  }

  setEncoding(encoding        )       {
    this.encoding = encoding;
    return this;
  }

  resume()       {
    this.flowing = true;
    this.live.syncSoon();
    return this;
  }

  pause()       {
    this.flowing = false;
    this.live.syncSoon();
    return this;
  }

  isPaused()          {
    return this.flowing === false;
  }

  setRawMode(mode         )       {
    this.isRaw = Boolean(mode);
    this.live.syncSoon();
    return this;
  }

  reading()          {
    return this.flowing !== false && this.listenerCount("data") > 0;
  }

  emitData(text        )       {
    this.emit("data", text);
  }

  read()       {
    return null;
  }

  ref()       {
    return this;
  }

  unref()       {
    return this;
  }

  destroy()       {
    this.live.endInput();
    return this;
  }
}

class LookOut extends EmitterBase {
  live              ;
  isTTY         ;
  writable         ;
  encoding        ;

  constructor(live              ) {
    super();
    this.live = live;
    this.isTTY = true;
    this.writable = true;
    this.encoding = "utf-8";
  }

  get columns()         {
    return this.live.terminalSize()[0];
  }

  get rows()         {
    return this.live.roomAbove();
  }

  write(chunk         , encoding          , callback          )          {
    this.live.feed(decodeBytes(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") queueMicrotask(() => (done                             )(null));
    return true;
  }

  end(chunk          , encoding          , callback          )       {
    if (typeof chunk === "function") {
      queueMicrotask(() => (chunk              )());
      return this;
    }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding, callback);
    else if (typeof encoding === "function") queueMicrotask(() => (encoding              )());
    return this;
  }

  flush()       {
    if (this.live.running) this.live.paint();
  }

  getColorDepth()         {
    return this.live.env.NO_COLOR !== undefined ? 1 : 24;
  }

  hasColors(count          = 16)          {
    const wanted = typeof count === "number" ? count : 16;
    return 2 ** this.getColorDepth() >= wanted;
  }

  getWindowSize()                   {
    return [this.columns, this.rows];
  }

  cursorTo(x         , y          , callback          )          {
    if (x === 0) this.live.feed("\r");
    const done = typeof y === "function" ? y : callback;
    if (typeof done === "function") queueMicrotask(() => (done              )());
    return true;
  }

  moveCursor(_dx         , _dy         , callback          )          {
    if (typeof callback === "function") queueMicrotask(() => (callback              )());
    return true;
  }

  clearLine(_dir          , callback          )          {
    this.live.feed("\r");
    if (typeof callback === "function") queueMicrotask(() => (callback              )());
    return true;
  }

  clearScreenDown(callback          )          {
    if (typeof callback === "function") queueMicrotask(() => (callback              )());
    return true;
  }

  cork()       {}

  uncork()       {}
}

class LiveTerminal {
  look      ;
  model            ;
  realIn     ;
  realOut     ;
  clock       ;
  monotonic       ;
  sleep       ;
  fps        ;
  minStepS        ;
  introS        ;
  lineHoldS        ;
  pairedHoldS        ;
  celebrateS        ;
  stopTypeS        ;
  kill      ;
  pid        ;
  env                                    ;
  signals         ;
  capture         ;
  stderrStream     ;
  stdin        ;
  stdout         ;
  typed        ;
  escape        ;
  decoder     ;
  savedRaw                ;
  running         ;
  stopped         ;
  paused         ;
  keysTaken         ;
  drawn       ;
  drawnRows        ;
  fullAt        ;
  size                         ;
  t0        ;
  tOffset        ;
  overIntro         ;
  eof         ;
  lastStepAt        ;
  lastLineAt        ;
  queue           ;
  holding         ;
  drainWaiters                   ;

  askOpen         ;

  pendingLines          ;

  answerOpen         ;

  endHeard              ;
  asidePartial        ;

  strays          ;
  outEscape        ;

  stopping                      ;
  timer     ;
  paintSoon         ;
  syncQueued         ;
  captured            ;
  out                        ;
  onKeys                         ;
  onInEnd            ;
  onResize            ;
  onExit            ;
  signalHandlers                         ;

  constructor(look      , model            , realIn     , realOut     , options              = {}) {
    this.look = look;
    this.model = model;
    this.realIn = realIn;
    this.realOut = realOut;
    this.clock = options.clock ?? defaultClock;
    this.monotonic = options.monotonic ?? defaultClock;
    this.sleep = options.sleep ?? defaultSleep;
    this.fps = options.fps ?? FPS;
    this.minStepS = options.minStepS ?? MIN_STEP_SECONDS;
    this.introS = options.introS ?? INTRO_SECONDS;
    this.lineHoldS = options.lineHoldS ?? LINE_HOLD_SECONDS;
    this.pairedHoldS = options.pairedHoldS ?? PAIRED_HOLD_SECONDS;
    this.celebrateS = options.celebrateS ?? CELEBRATE_SECONDS;
    this.stopTypeS = options.stopTypeS ?? STOP_TYPE_SECONDS;
    this.kill = options.kill ?? ((pid        , signal        ) => process.kill(pid, signal));
    this.pid = options.pid ?? process.pid;
    this.env = options.env ?? process.env;
    this.signals = options.signals !== false;
    this.capture = options.capture !== false;
    this.stderrStream = options.stderr ?? process.stderr;
    this.stdin = new LookIn(this);
    this.stdout = new LookOut(this);
    this.typed = "";
    this.escape = "";
    this.decoder = new StringDecoder("utf8");
    this.savedRaw = null;
    this.running = false;
    this.stopped = false;
    this.paused = false;
    this.keysTaken = false;
    this.drawn = [];
    this.drawnRows = 0;
    this.fullAt = 0;
    this.size = null;
    this.t0 = this.clock();

    this.tOffset = options.tOffset ?? 0;
    this.overIntro = options.tOffset !== undefined && options.tOffset !== null;
    this.eof = false;
    this.lastStepAt = this.t0;
    this.lastLineAt = this.t0;
    this.queue = [];
    this.holding = false;
    this.drainWaiters = [];
    this.askOpen = false;
    this.pendingLines = [];
    this.answerOpen = false;
    this.endHeard = new Set();
    this.asidePartial = "";
    this.strays = [];
    this.outEscape = "";
    this.stopping = null;
    this.timer = null;
    this.paintSoon = false;
    this.syncQueued = false;
    this.captured = [];

    const write = realOut.write;
    this.out = (text        ) => { write.call(realOut, text); };
    this.onKeys = (data         ) => {
      if (!this.paused && !this.stopped) this.keys(data);
    };
    this.onInEnd = () => this.endInput();
    this.onResize = () => {
      this.wake();
      this.stdout.emit("resize");
    };
    this.onExit = () => this.atExit();
    this.signalHandlers = new Map(SIGNALS.map((sig) => [sig, () => this.onSignal(sig)]));
  }

  start()       {
    if (this.running || this.stopped) return;
    this.savedRaw = this.realIn.isRaw === true;
    this.running = true;
    this.takeKeys();
    if (typeof this.realIn.on === "function") this.realIn.on("end", this.onInEnd);
    if (typeof this.realOut.on === "function") this.realOut.on("resize", this.onResize);
    if (this.signals) {
      for (const [sig, handler] of this.signalHandlers) process.on(sig, handler);
      process.on("exit", this.onExit);
    }
    if (this.capture) this.catchStrays();

    this.paint();
    this.timer = unref(setInterval(() => {
      if (this.running && !this.paused) this.paint();
    }, 1000 / Math.max(1, this.fps)));

    this.lastStepAt = this.clock() + this.introS;
  }

  stop(exitCode        )                {
    if (this.stopping === null) this.stopping = this.finishUp(exitCode);
    return this.stopping;
  }

  async finishUp(exitCode        )                {
    if (this.stopped) return;
    if (this.asidePartial) {
      this.enqueue({ kind: "aside", text: this.asidePartial });
      this.asidePartial = "";
    }
    await this.drain();
    if (this.stopped) return;
    this.model.finish(exitCode);
    const m = this.model;
    if (exitCode === 0 && m.current >= m.total && !this.paused && this.celebrateS > 0) {

      this.wake();
      await this.sleep(this.celebrateS);
      if (this.stopped) return;
    } else if (exitCode !== 0 && !this.paused && this.stopTypeS > 0) {

      this.paint();
      await this.sleep(this.stopTypeS);
      if (this.stopped) return;
    }
    this.stopped = true;
    this.running = false;
    this.stopTimers();
    this.paint(true);
    const tail = this.look.finalLines(m);
    this.write(`\u001b[0m\n${tail.map((line) => `${line}\n`).join("")}\u001b[?25h`);
    this.restore();
  }

  atExit()       {

    if (!this.stopped) {
      this.stopped = true;
      this.running = false;
      this.write("\u001b[0m\n\u001b[?25h");
    }
    this.restore();
  }

  restore()       {
    this.stopTimers();
    if (this.keysTaken) this.releaseKeys();
    if (typeof this.realIn.off === "function") this.realIn.off("end", this.onInEnd);
    if (typeof this.realOut.off === "function") this.realOut.off("resize", this.onResize);
    for (const [sig, handler] of this.signalHandlers) process.off(sig, handler);
    process.off("exit", this.onExit);
    this.releaseStrays();
  }

  onSignal(signal        )       {

    if (process.listenerCount(signal) > 1) return;
    this.write("\u001b[0m\u001b[?25h\n");
    this.stopped = true;
    this.running = false;
    this.restore();
    this.kill(this.pid, signal);
  }

  async suspended   (fn                      , lead                    = [])             {
    if (!this.running || this.paused) return await fn();
    this.paused = true;
    this.write("\u001b[0m\n\u001b[?25h");
    for (const line of lead) this.write(`${terminalText(line, "detail", this.realOut, this.env)}\n`);
    this.drawn = [];
    this.drawnRows = 0;
    this.releaseKeys();
    try {
      return await fn();
    } finally {
      if (!this.stopped) {
        try {
          this.takeKeys();
        } catch (_) {

        }
        this.write("\u001b[?25l");
      }
      this.paused = false;
      this.wake();
    }
  }

  takeKeys()       {
    if (typeof this.realIn.setRawMode === "function") this.realIn.setRawMode(true);
    this.realIn.on("data", this.onKeys);
    this.realIn.resume();
    this.keysTaken = true;
  }

  releaseKeys()       {
    this.keysTaken = false;
    if (typeof this.realIn.off === "function") this.realIn.off("data", this.onKeys);
    try {
      this.realIn.pause();
    } catch (_) {

    }
    try {
      if (typeof this.realIn.setRawMode === "function") this.realIn.setRawMode(this.savedRaw === true);
    } catch (_) {

    }
  }

  stopTimers()       {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  catchStrays()       {
    const streams = [this.stderrStream];
    if (this.realOut === process.stdout) streams.push(process.stdout);
    for (const stream of streams) {
      if (!stream || typeof stream.write !== "function") continue;
      const original = stream.write;
      const live = this;
      const wrapper = function (               chunk         , encoding          , callback          )          {
        if (live.stopped || !live.captured.some((c) => c.wrapper === wrapper)) {
          return original.call(stream, chunk, encoding, callback);
        }
        live.feedAside(decodeBytes(chunk));
        const done = typeof encoding === "function" ? encoding : callback;
        if (typeof done === "function") queueMicrotask(() => (done                             )(null));
        return true;
      };
      stream.write = wrapper;
      this.captured.push({ stream, original, wrapper });
    }
  }

  releaseStrays()       {
    for (const { stream, original, wrapper } of this.captured) {

      if (stream.write === wrapper) stream.write = original;
    }
    this.captured = [];
  }

  wake()       {
    if (!this.running || this.paused || this.paintSoon) return;
    this.paintSoon = true;
    unref(setTimeout(() => {
      this.paintSoon = false;
      if (this.running && !this.paused) this.paint();
    }, 0));
  }

  feed(text        )       {
    if (this.stopped) {
      this.write(text);
      return;
    }
    let source = this.outEscape + text;
    this.outEscape = "";
    const cut = CUT_ESCAPE.exec(source);
    if (cut) {
      this.outEscape = cut[0];
      source = source.slice(0, cut.index);
    }
    let out = "";
    const flush = () => {
      if (out) this.enqueue({ kind: "text", text: out, held: false });
      out = "";
    };
    let i = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\u001b") {
        CSI.lastIndex = i;
        const csi = CSI.exec(source);
        if (csi) {
          i += csi[0].length;
          const params = csi[1];
          const final = csi[3];
          if (final === "m") {
            out += csi[0];
          } else if (final === "n" && params === "6") {

            out = out.slice(0, Math.max(out.lastIndexOf("\r"), out.lastIndexOf("\n")) + 1);
            this.answerProbe();
          } else if (final === "A" && (params === "" || params === "1")) {
            out += REWRITE;
          }
          continue;
        }
        OSC.lastIndex = i;
        const osc = OSC.exec(source);
        if (osc) {
          i += osc[0].length;
          continue;
        }
        ESC2.lastIndex = i;
        const esc = ESC2.exec(source);
        i += esc ? esc[0].length : 1;
        continue;
      }
      if (ch < " " && ch !== "\n" && ch !== "\r" && ch !== "\t") {
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    flush();
  }

  feedAside(text        )       {
    if (this.stopped) {
      this.write(text);
      return;
    }
    const pieces = (this.asidePartial + text.replace(/\r\n/g, "\n")).split("\n");
    this.asidePartial = pieces.pop() ?? "";
    for (const piece of pieces) {
      const line = piece.slice(piece.lastIndexOf("\r") + 1);
      this.enqueue({ kind: "aside", text: line });
    }
  }

  answerProbe()       {
    if (this.stdin.listenerCount("data") === 0) return;
    setTimeout(() => {
      if (!this.stopped && this.stdin.listenerCount("data") > 0) this.stdin.emitData(PROBE_ANSWER);
    }, 0);
  }

  enqueue(item         )       {
    this.queue.push(item);
    this.pump();
  }

  pump()       {
    while (!this.holding && this.queue.length > 0) {
      const item = this.queue.shift()           ;
      if (item.kind === "text") {
        const rest = this.feedText(item.text, item.held);
        if (rest !== null) {
          this.queue.unshift({ kind: "text", text: rest.text, held: true });
          this.hold(rest.wait);
          return;
        }
      } else if (item.kind === "aside") {
        this.pushAside(item.text);
      } else if (item.kind === "ask") {
        this.model.askBegin();
        this.wake();
      } else if (item.kind === "answer") {
        this.model.askEnd(item.text);

        this.answerOpen = stripAnsi(this.model.partial).trim() !== "";
        this.wake();
      } else {
        this.unask();
      }
    }
    if (!this.holding && this.queue.length === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  hold(seconds        )       {
    this.holding = true;
    this.wake();
    const resume = () => {
      this.holding = false;
      this.pump();
    };
    this.sleep(seconds).then(resume, resume);
  }

  drain()                {
    if (!this.holding && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  feedText(text        , held         )                                        {
    if (this.answerOpen) {
      this.answerOpen = false;
      if (!text.startsWith("\n") && !text.startsWith("\r\n")) text = `\n${text}`;
    }
    let start = 0;
    let atLineStart = this.model.partial === "";
    const lines = /[^\n]*\n|[^\n]+/g;
    let line                        ;
    while ((line = lines.exec(text)) !== null) {
      if (atLineStart) {
        const header = STEP_START.exec(stripAnsi(line[0]).trimStart());
        if (header && Number(header[1]) > 0) {
          if (held && line.index === 0) {

            held = false;
          } else {
            this.feedNow(text.slice(start, line.index));
            start = line.index;
            const wait = this.stepWait();
            if (wait > 0) return { text: text.slice(start), wait };
          }
          this.lastStepAt = this.clock();
        }
      }
      atLineStart = line[0].endsWith("\n");
    }
    this.feedNow(text.slice(start));
    return null;
  }

  stepWait()         {
    const now = this.clock();
    const hold = this.model.paired() ? this.pairedHoldS : this.lineHoldS;
    return Math.max(this.minStepS - (now - this.lastStepAt), hold - (now - this.lastLineAt));
  }

  feedNow(text        )       {
    if (!text) return;
    this.model.feed(text);
    if (stripAnsi(text).trim()) this.lastLineAt = this.clock();
    this.wake();
  }

  pushAside(line        )       {
    const m = this.model;
    const plain = pyRstrip(stripAnsi(line));
    if (!plain.trim()) return;
    m.transcript.push(plain);
    m.rawTranscript.push(plain);

    this.strays.push(plain);
    m.version += 1;
    this.wake();
  }

  unask()       {
    const m = this.model;
    if (!m.asking) return;
    m.asking = false;
    m.question = null;
    m.version += 1;
    this.wake();
  }

  syncSoon()       {
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      this.syncInput();
    });
  }

  syncInput()       {
    if (this.stopped) return;
    const input = this.stdin;
    if (this.eof) {
      if (this.askOpen) {
        this.askOpen = false;
        this.enqueue({ kind: "unask" });
      }
      if (input.flowing === false) return;
      for (const listener of input.rawListeners("end")) {
        const key = (listener       ).listener ?? listener;
        if (this.endHeard.has(key)) continue;
        this.endHeard.add(key);
        (listener              ).call(input);
      }
      return;
    }
    const reading = input.reading();
    if (reading && this.pendingLines.length > 0) {
      this.deliver(this.pendingLines.shift()          );
      return;
    }
    const asking = reading && !input.isRaw;
    if (asking && !this.askOpen) {
      this.askOpen = true;
      this.enqueue({ kind: "ask" });
    } else if (!asking && this.askOpen) {
      this.askOpen = false;
      this.enqueue({ kind: "unask" });
    }
  }

  deliver(line        )       {
    const input = this.stdin;
    if (input.isRaw) {
      input.emitData(`${line}\r`);
    } else {
      if (!this.askOpen) this.enqueue({ kind: "ask" });
      this.askOpen = false;
      this.enqueue({ kind: "answer", text: `${line}\n` });
      input.emitData(`${line}\n`);
    }
    this.syncSoon();
  }

  send(line        )       {
    if (this.eof) return;
    if (this.stdin.reading()) this.deliver(line);
    else this.pendingLines.push(line);
  }

  endInput()       {
    if (this.eof) return;
    this.eof = true;
    this.pendingLines = [];
    if (this.askOpen) {
      this.askOpen = false;
      this.enqueue({ kind: "answer", text: "" });
    }
    this.syncSoon();
  }

  rawReader()          {
    return this.stdin.isRaw && this.stdin.listenerCount("data") > 0;
  }

  interrupt()       {
    if (this.rawReader()) {
      this.stdin.emitData("\u0003");
      return;
    }
    this.write("\u001b[0m\u001b[?25h\n");
    this.stopped = true;
    this.running = false;
    this.restore();
    this.kill(this.pid, "SIGINT");
  }

  keys(data         )       {
    const text = typeof data === "string" ? data : this.decoder.write(data);
    for (const ch of text) {
      if (this.escape) {
        this.escape += ch;
        if (this.escape.length === 2 && ch !== "[" && ch !== "O") this.escape = "";
        else if (this.escape.length > 2 && ch >= "@" && ch <= "~") this.escape = "";
        continue;
      }
      if (ch === "\u001b") {
        this.escape = ch;
      } else if (ch === "\r" || ch === "\n") {
        const line = this.typed;
        this.typed = "";
        this.send(line);
      } else if (ch === "\u007f" || ch === "\b") {
        this.typed = Array.from(this.typed).slice(0, -1).join("");
      } else if (ch === "\u0015") {
        this.typed = "";
      } else if (ch === "\u0017") {
        const kept = this.typed.trimEnd();
        const at = kept.lastIndexOf(" ");
        this.typed = at >= 0 ? kept.slice(0, at) : "";
      } else if (ch === "\u0003") {
        this.interrupt();
        if (this.stopped) return;
      } else if (ch === "\u0004") {
        if (this.rawReader()) this.stdin.emitData("\u0004");
        else if (!this.typed) this.endInput();
      } else if (ch >= " " && Array.from(this.typed).length < MAX_TYPED) {
        this.typed += ch;
      }
    }
    this.model.setTyped(this.typed);
    this.wake();
  }

  terminalSize()                   {
    const cols = Number(this.realOut.columns);
    const rows = Number(this.realOut.rows);
    if (cols > 0 && rows > 0) return [Math.max(20, cols), Math.max(4, rows)];
    return [88, 10];
  }

  roomAbove()         {
    const [cols, rows] = this.terminalSize();
    const block = Math.max(this.drawnRows, this.look.height(cols, rows));
    return Math.max(1, rows - block);
  }

  paint(final          = false)       {
    if (this.paused && !final) return;
    const size = this.terminalSize();
    const [cols, rows] = size;
    const t = this.clock() - this.t0 + this.tOffset;
    if (final) this.look.final = true;
    const p = this.look.p;
    const commits = [...this.strays.splice(0).map((line) => p.faint + line + p.reset), ...this.look.takeCommits(this.model, cols)];
    const frame = this.look.frame(this.model, t, cols, rows);
    this.write(this.compose(frame, commits, size));
  }

  compose(frame       , commits          , size                  )         {
    const out           = [];

    const now = this.monotonic();
    const refresh = now - this.fullAt >= FULL_REDRAW_SECONDS && !this.showsLink(frame);
    const sameSize = this.size !== null && size[0] === this.size[0] && size[1] === this.size[1];
    let sameShape =
      commits.length === 0 &&
      !refresh &&
      sameSize &&
      frame.length === this.drawn.length &&
      frame.every((row, i) => row.height === this.drawn[i].height);
    if (this.drawnRows && !sameSize) {

      out.push("\u001b[0m\u001b[H\u001b[2J");
      this.drawnRows = 0;
      this.drawn = [];
      sameShape = false;
    }
    if (sameShape && this.drawnRows) {
      let cursor = this.drawnRows - 1;
      let top = 0;
      frame.forEach((row, i) => {
        if (row.text !== this.drawn[i].text) {
          if (top < cursor) out.push(`\u001b[${cursor - top}A`);
          else if (top > cursor) out.push(`\u001b[${top - cursor}B`);
          out.push(`\r\u001b[2K${row.text}\u001b[0m`);
          cursor = top;
        }
        top += row.height;
      });
      const last = this.drawnRows - 1;
      if (cursor < last) out.push(`\u001b[${last - cursor}B`);
      out.push("\r");
    } else {

      out.push("\u001b[?25l");
      if (this.drawnRows) {
        out.push("\r");
        if (this.drawnRows > 1) out.push(`\u001b[${this.drawnRows - 1}A`);
      } else if (this.overIntro) {

        out.push("\r");
        this.overIntro = false;
      }

      const lines                          = commits.map((line) => [`${line}\u001b[0m`, screenRows(line, size[0])]);
      for (const row of frame) lines.push([`${row.text}\u001b[0m`, row.height]);
      lines.forEach(([text, height], i) => {
        if (i) out.push("\n");
        if (i === lines.length - 1) {
          out.push("\u001b[J");
        } else {

          out.push(`\u001b[2K${"\n\u001b[2K".repeat(height - 1)}`);
          if (height > 1) out.push(`\u001b[${height - 1}A\r`);
        }
        out.push(text);
      });
      if (lines.length === 0) out.push("\u001b[J");
      this.drawnRows = frame.reduce((sum, row) => sum + row.height, 0);
      this.fullAt = now;
    }
    this.drawn = frame;
    this.size = size;
    return out.join("");
  }

  showsLink(frame       )          {
    const m = this.model;
    const links = [m.reopen, m.approve]
      .filter((link)                 => typeof link === "string" && link !== "")
      .map((link) => link.slice(0, 40));
    return links.some((link) => frame.some((row) => stripAnsi(row.text).includes(link)));
  }

  write(text        )       {
    if (!text) return;
    try {
      this.out(text);
    } catch (_) {

    }
  }
}

class OpenLook {
  name        ;
  stdin        ;
  stdout         ;

  close                                     ;

  suspended                                                                       ;

  stderr         ;

  stderrWrite                        ;
  live                     ;

  theme       ;

  constructor(
    name        ,
    stdin        ,
    stdout         ,
    close                                     ,
    suspended                                                                       ,
    live                      = null,
    theme        = "dark",
  ) {
    this.name = name;
    this.stdin = stdin;
    this.stdout = stdout;
    this.close = close;
    this.suspended = suspended;
    this.stderr = stdout;
    this.live = live;
    this.theme = theme;
    this.stderrWrite = (text        ) => {
      if (live) live.feedAside(text);
    };
  }

  get io()         {
    return { input: this.stdin, output: this.stdout, error: this.stderr, suspended: this.suspended };
  }
}

function isTty(stream     )          {
  return Boolean(stream) && stream.isTTY === true;
}

const INTRO_ENV = "OCUCLAW_SPECK_INTRO";

const INTRO_PLAYER = "speck-intro.mjs";

const INTRO_FILES                    = ["cue", "pid", "idle0", "ready", "theme", INTRO_PLAYER];

function procInfo(pid        )                                         {
  try {
    const stat = String(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], ppid: Number(fields[1]) };
  } catch (_) {
    if (fs.existsSync("/proc/self/stat")) return null;
  }

  try {
    const out = String(execFileSync("ps", ["-o", "ppid=,stat=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    })).trim();
    if (!out) return null;
    const [ppid, state] = out.split(/\s+/);
    return { ppid: Number(ppid), state: state ? state[0] : "?" };
  } catch (_) {
    return null;
  }
}

function ownLine(info                                                         )           {
  const line = [process.pid, process.ppid];
  const parent = info(process.ppid);
  if (parent && parent.ppid > 1) line.push(parent.ppid);
  return line;
}

function playsIn(pid        , where        )          {
  try {
    const argv = String(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")).split("\u0000");
    return argv.some((arg) => arg.endsWith(INTRO_PLAYER)) && argv.includes(where);
  } catch (_) {
    return false;
  }
}

async function takeOverIntro(
  env                                    ,
  waitS         = 1.0,
  deps            = {},
)                         {
  const where = String(env[INTRO_ENV] || "");
  let isDir = false;
  try {
    isDir = where !== "" && fs.statSync(where).isDirectory();
  } catch (_) {
    isDir = false;
  }
  if (!isDir) return null;
  const info = deps.procInfo ?? procInfo;
  const kill = deps.kill ?? ((pid        , signal        ) => process.kill(pid, signal));
  const parents = deps.parents ?? ownLine(info);
  const sleep = deps.sleep ?? ((seconds        ) => new Promise      ((resolve) => setTimeout(resolve, seconds * 1000)));
  const now = deps.now ?? defaultClock;
  const wall = deps.wall ?? (() => Date.now() / 1000);
  let pid        ;
  let idle0        ;
  let running         ;
  try {
    pid = Number.parseInt(String(fs.readFileSync(path.join(where, "pid"), "utf8")).trim(), 10);
    idle0 = Number.parseFloat(String(fs.readFileSync(path.join(where, "idle0"), "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(idle0)) throw new Error("unreadable");
    const found = info(pid);
    if (!found || !(parents.includes(found.ppid) || playsIn(pid, where))) throw new Error("not ours");
    running = found.state !== "Z";
  } catch (_) {
    forgetIntro(where);
    return null;
  }
  const alive = () => {
    const found = info(pid);
    return found !== null && found.state !== "Z";
  };
  try {
    if (running) kill(pid, "SIGTERM");
    const deadline = now() + waitS;
    while (running && alive()) {
      if (now() > deadline) {
        kill(pid, "SIGKILL");
        const gone = now() + 1.0;
        while (alive() && now() < gone) await sleep(0.01);
        break;
      }
      await sleep(0.01);
    }
  } catch (_) {

  }
  forgetIntro(where);
  return Math.max(0, wall() - idle0);
}

function forgetIntro(where        )       {
  for (const name of INTRO_FILES) {
    try {
      fs.unlinkSync(path.join(where, name));
    } catch (_) {

    }
  }
  try {
    fs.rmdirSync(where);
  } catch (_) {

  }
}

function clearIntro(streamOut     )       {
  try {
    streamOut.write("\r\u001b[0m\u001b[J\u001b[?25h");
  } catch (_) {

  }
}

const THEME_ENV = "OCUCLAW_SETUP_THEME";

const INTRO_THEME_FILE = "theme";

const THEME_QUERY = "\u001b]11;?\u0007\u001b[6n";

const THEME_QUERY_MS = 400;

const OSC11_REPLY = /\u001b\]11;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/;
const DSR_REPLY = /\u001b\[\d+;\d+R/;

function asTheme(value         )               {
  const word = String(value ?? "").trim().toLowerCase();
  return word === "light" || word === "dark" ? word : null;
}

function introTheme(env                                    )               {
  const where = String(env[INTRO_ENV] || "");
  if (!where) return null;
  try {
    return asTheme(fs.readFileSync(path.join(where, INTRO_THEME_FILE), "utf8"));
  } catch (_) {
    return null;
  }
}

function queryTheme(input     , output     , timeoutMs         = THEME_QUERY_MS)                        {
  return new Promise((resolve) => {
    if (!input || input.isTTY !== true || !output || output.isTTY !== true || typeof input.setRawMode !== "function") {
      resolve(null);
      return;
    }
    const wasRaw = input.isRaw === true;
    const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : true;
    let reply = "";
    let done = false;
    const answer = ()               => {
      const osc = OSC11_REPLY.exec(reply);
      const light = osc ? isLightBackground(osc[1]) : null;
      return light === null ? null : light ? "light" : "dark";
    };
    const finish = (theme              ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      try { input.setRawMode(wasRaw); } catch (_) {  }
      if (wasPaused) {
        try { input.pause(); } catch (_) {  }
      }
      resolve(theme);
    };
    const onData = (chunk         ) => {
      reply += decodeBytes(chunk);

      if (reply.includes("\u0003")) {
        finish(null);
        try { process.kill(process.pid, "SIGINT"); } catch (_) {  }
        return;
      }
      if (DSR_REPLY.test(reply) || reply.length > 256) finish(answer());
    };
    const onEnd = () => finish(answer());
    const timer = setTimeout(() => finish(answer()), timeoutMs);
    try {
      input.on("data", onData);
      input.on("end", onEnd);
      input.setRawMode(true);
      input.resume();
      output.write(THEME_QUERY);
    } catch (_) {
      finish(null);
    }
  });
}

async function lookTheme(
  env                                    ,
  realIn     ,
  realOut     ,
  options                                               = {},
)                 {
  if (!inDashboardTerminal(env)) return "dark";
  const chosen = asTheme(env[THEME_ENV]) ?? options.intro ?? null;
  if (chosen) return chosen;
  return (await queryTheme(realIn, realOut, options.timeoutMs ?? THEME_QUERY_MS)) ?? "dark";
}

async function openLook(
  name        ,
  realIn     ,
  realOut     ,
  options                  = {},
)                           {
  const env = options.env ?? process.env;

  const introSaid = introTheme(env);

  const introAt = await takeOverIntro(env, options.introWaitS ?? 1.0, options.introDeps ?? {});
  const plain = !(LOOKS                     ).includes(name) || name === "plain" || options.json === true;
  if (plain || !(isTty(realIn) && isTty(realOut)) || typeof realIn.setRawMode !== "function") {
    if (introAt !== null) clearIntro(realOut);
    return null;
  }
  const clock = options.clock ?? defaultClock;
  const theme = options.theme ?? await lookTheme(env, realIn, realOut, { intro: introSaid, timeoutMs: options.themeQueryMs });
  const palette = new Palette(!env.NO_COLOR, theme === "light");
  const model = new SetupModel(clock, options.wording ?? OPENCLAW_WORDING);

  model.resumed = options.resumed === true;
  const live = new LiveTerminal(new SpeckLook(palette), model, realIn, realOut, {
    ...options,
    env,
    clock,
    tOffset: introAt,
  });
  try {
    live.start();
  } catch (_) {

    live.stopped = true;
    live.restore();
    if (introAt !== null) clearIntro(realOut);
    return null;
  }
  return new OpenLook(
    name,
    live.stdin,
    live.stdout,
    (exitCode        ) => live.stop(exitCode),
       (fn                      , lead                    ) => live.suspended(fn, lead),
    live,
    theme,
  );
}

module.exports = { STOP_TYPE_SECONDS, PROBE_ANSWER, LookIn, LookOut, LiveTerminal, OpenLook, INTRO_ENV, INTRO_PLAYER, INTRO_FILES, procInfo, takeOverIntro, forgetIntro, clearIntro, THEME_ENV, INTRO_THEME_FILE, THEME_QUERY, THEME_QUERY_MS, introTheme, queryTheme, lookTheme, openLook };
