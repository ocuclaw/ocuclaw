const { randomUUID } = require("node:crypto");
const { encodePng, outline, render, toFrame, viewFor, zoomCrop } = require("./bot-screen-aim-image.cjs");

const BOT_SCREEN_AIM_REQUEST = "ocuclaw.botscreen.aim";
const BOT_SCREEN_AIM_RESULT = "ocuclaw.botscreen.aim.result";

const BOT_SCREEN_AIM_MODEL = "jev-1.14.0";

const OPS = new Set(["arm", "disarm", "aim", "correct", "clear"]);
const ID = /^[a-zA-Z0-9_.:-]{1,100}$/;
const MAX_WORDS = 200;
const MAX_TURNS = 8;

const BOT_SCREEN_AIM_DEFAULTS = Object.freeze({

  budgetMs: 4_000,

  zoomBelow: 0.3,

  ttlMs: 120_000,
});

const MAGENTA                           = [255, 0, 255];
const CYAN                           = [0, 255, 255];

const TARGET_FIRST = "The one thing in frame that state.command names: the control or spot the user wants the pointer on. "
  + "The user is looking at this screen and will click it next. Answer with its box.";
const TARGET_CORRECTION = "The one thing in frame the user now means. state.command is what they first asked for; "
  + "state.corrections are what they said after each wrong guess, oldest first. "
  + "A magenta outline marks the last wrong guess, cyan outlines mark earlier wrong guesses. Never choose an outlined spot. "
  + "The outlines are marks added for you, not part of the screen: colour words describe the screen's own colours. "
  + "Words like \"left of it\" or \"the one below\" are relative to the magenta outline. Answer with its box.";
const PRESENT = "Is the thing the user means visible in frame and not outlined?";

function aimQuestions(aim                     , png        ) {
  const [first, ...rest] = aim.words;
  const state      = { command: first, frame: "image_screen" };
  if (rest.length) state.corrections = rest;
  return {
    state,
    assets: { image_screen: { type: "image", format: "png", data_base64: png.toString("base64") } },
    questions: {
      present: { type: "noul", instructions: PRESENT },
      target: { type: "box", instructions: rest.length ? TARGET_CORRECTION : TARGET_FIRST },
    },
  };
}

function readAimAnswer(answers     , view      ) {
  const target = answers && answers.target;
  if (!target || target.type !== "box") return null;
  const rect = toFrame(target.box, view);
  if (!rect) return null;
  const score = (v     ) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);
  return { rect, confidence: score(target.confidence), present: score(answers.present && answers.present.noul) };
}

const centre = (r      ) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });

function createBotScreenAim(opts         ) {
  const budgetMs = opts.budgetMs ?? BOT_SCREEN_AIM_DEFAULTS.budgetMs;
  const zoomBelow = opts.zoomBelow ?? BOT_SCREEN_AIM_DEFAULTS.zoomBelow;
  const ttlMs = opts.ttlMs ?? BOT_SCREEN_AIM_DEFAULTS.ttlMs;
  const now = opts.now ?? (() => Date.now());
  const armed = new Set        ();
  const aims = new Map             ();
  const inflight = new Map                                                                        ();
  let disposed = false;

  const emit = (clientId        , profileId        , body     ) => {
    if (disposed) return;
    try { opts.send(clientId, JSON.stringify({ type: BOT_SCREEN_AIM_RESULT, v: 1, profileId, ...body })); } catch {  }
  };
  const fail = (clientId        , profileId        , id        , code        , extra      = {}) =>
    emit(clientId, profileId, { id, ok: false, code, ...extra });

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [clientId, aim] of aims) if (aim.at < cutoff) aims.delete(clientId);
  }

  function cancel(clientId        , quiet         ) {
    const running = inflight.get(clientId);
    if (!running) return;
    inflight.delete(clientId);
    running.controller.abort();
    if (!quiet) fail(clientId, running.profileId, running.id, "superseded");
  }

  function disarm(clientId        ) {
    cancel(clientId, true);
    aims.delete(clientId);
    if (armed.delete(clientId)) {
      try { opts.keepColour(clientId, false); } catch {  }
    }
  }

  async function look(aim     , view      , signal             ) {
    const { rejected } = aim;
    const marked = rejected.length
      ? outline(outline(aim.frame, rejected.slice(0, -1), CYAN), rejected.slice(-1), MAGENTA)
      : aim.frame;
    const png = encodePng(render(marked, view));
    const { state, assets, questions } = aimQuestions(aim, png);
    const reply = await opts.decide (state, { questions, assets, budgetMs, signal });
    if (!reply || reply.ok !== true) return { answer: null, error: `jev_${reply && reply.reason ? reply.reason : "failed"}` };
    const answer = readAimAnswer(reply.answers, view);
    return answer ? { answer, error: "" } : { answer: null, error: "not_found" };
  }

  async function run(clientId        , profileId        , id        , aim     , zoom         , around             ) {
    const controller = new AbortController();
    inflight.set(clientId, { controller, id, profileId });
    const started = now();
    const live = () => !disposed && !controller.signal.aborted && inflight.get(clientId)?.controller === controller;
    try {
      const closer = (at      ) => viewFor(zoomCrop(aim.frame, centre(at), 2), 2);
      let found                                                                           = null;
      let zoomed = false;
      let error = "not_found";
      if (around) {
        const view = closer(around);
        if (view) {
          const near = await look(aim, view, controller.signal);
          if (!live()) return;
          found = near.answer;
          zoomed = !!found;
          error = near.error;
        }
      } else {
        const whole = viewFor({ x: 0, y: 0, w: aim.frame.w, h: aim.frame.h });
        if (!whole) { fail(clientId, profileId, id, "frame_size", { aimId: aim.id }); return; }
        const first = await look(aim, whole, controller.signal);
        if (!live()) return;
        found = first.answer;
        error = first.error;
        if (found && (zoom || found.confidence === null || found.confidence < zoomBelow)) {
          const view = closer(found.rect);
          const near = view ? await look(aim, view, controller.signal) : null;
          if (!live()) return;
          if (near && near.answer) { found = near.answer; zoomed = true; }
        }
      }
      if (!found) { fail(clientId, profileId, id, error, { aimId: aim.id }); return; }

      if (!opts.inControl(clientId)) { disarm(clientId); fail(clientId, profileId, id, "not_in_control", { aimId: aim.id }); return; }
      aim.current = found.rect;
      aim.at = now();
      const point = centre(found.rect);
      const r = found.rect;
      emit(clientId, profileId, {
        id, ok: true, aimId: aim.id, x: point.x, y: point.y,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
        width: aim.frame.w, height: aim.frame.h, confidence: found.confidence, present: found.present, zoomed,
        turns: aim.words.length, ms: Math.round(now() - started),
      });
    } catch {
      if (live()) fail(clientId, profileId, id, "failed", { aimId: aim.id });
    } finally {
      if (inflight.get(clientId)?.controller === controller) inflight.delete(clientId);
    }
  }

  function dispatch(clientId        , msg     ) {
    sweep();
    const profileId = opts.profile(clientId);
    const id = typeof msg.id === "string" && ID.test(msg.id) ? msg.id : "invalid";
    if (msg.v !== 1 || id === "invalid" || !OPS.has(msg.op)) { fail(clientId, profileId, id, "invalid_request"); return; }
    cancel(clientId, false);
    if (msg.op === "disarm") {
      disarm(clientId);
      emit(clientId, profileId, { id, ok: true, armed: false });
      return;
    }
    if (msg.op === "clear") {
      aims.delete(clientId);
      emit(clientId, profileId, { id, ok: true, cleared: true });
      return;
    }

    if (!opts.inControl(clientId)) { disarm(clientId); fail(clientId, profileId, id, "not_in_control"); return; }
    if (!opts.decide) { fail(clientId, profileId, id, "jev_off"); return; }
    if (msg.op === "arm") {
      armed.add(clientId);
      opts.keepColour(clientId, true);
      try { opts.warm?.(); } catch {  }
      emit(clientId, profileId, { id, ok: true, armed: true });
      return;
    }
    if (!armed.has(clientId)) { fail(clientId, profileId, id, "not_armed"); return; }
    const words = typeof msg.words === "string" ? msg.words.trim().replace(/\s+/g, " ") : "";
    if (!words || words.length > MAX_WORDS) { fail(clientId, profileId, id, "invalid_request"); return; }
    if (msg.op === "correct") {
      const aim = aims.get(clientId);
      if (!aim || aim.id !== msg.aimId) { fail(clientId, profileId, id, "aim_expired"); return; }

      if (msg.zoom === true) {
        void run(clientId, profileId, id, aim, true, aim.current);
        return;
      }
      if (aim.words.length >= MAX_TURNS) { fail(clientId, profileId, id, "too_many_corrections", { aimId: aim.id }); return; }
      if (aim.current) aim.rejected.push(aim.current);
      aim.current = null;
      aim.words.push(words);
      void run(clientId, profileId, id, aim, false, null);
      return;
    }
    const latest = opts.frame(clientId);
    if (!latest || !(latest.w > 0 && latest.h > 0) || latest.rgb.length !== latest.w * latest.h * 3) {
      fail(clientId, profileId, id, "no_frame"); return;
    }
    const aim      = {
      id: randomUUID(), frame: { rgb: new Uint8Array(latest.rgb), w: latest.w, h: latest.h },
      words: [words], rejected: [], current: null, at: now(),
    };
    aims.set(clientId, aim);
    void run(clientId, profileId, id, aim, msg.zoom === true, null);
  }

  return {
    handle(clientId        , msg     )          {
      if (msg?.type !== BOT_SCREEN_AIM_REQUEST) return false;
      if (!disposed) dispatch(clientId, msg);
      return true;
    },

    released(clientId        ) { disarm(clientId); },
    clientGone(clientId        ) { disarm(clientId); },

    stats: () => ({ armed: armed.size, aims: aims.size, inflight: inflight.size }),
    dispose() {
      for (const clientId of [...armed, ...inflight.keys()]) disarm(clientId);
      aims.clear();
      disposed = true;
    },
  };
}

module.exports = { BOT_SCREEN_AIM_REQUEST, BOT_SCREEN_AIM_RESULT, BOT_SCREEN_AIM_MODEL, BOT_SCREEN_AIM_DEFAULTS, aimQuestions, readAimAnswer, createBotScreenAim };
