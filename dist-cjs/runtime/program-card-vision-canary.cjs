const { createHash, randomBytes, randomInt } = require("node:crypto");
const { encodePngRgb } = require("../tools/bot-screen/png-rgb.cjs");
const { programCardReviewImageIdentity, sameProgramCardReviewImageIdentity } = require("./program-card-visual-review.cjs");

const PROGRAM_CARD_VISION_CANARY_FAILURE_TTL_MS = 6 * 60 * 60 * 1000;

const PROGRAM_CARD_VISION_CANARY_ERROR_TTL_MS = 10 * 60 * 1000;

const PROGRAM_CARD_VISION_CANARY_PASS_TTL_MS = 24 * 60 * 60 * 1000;
const PROGRAM_CARD_VISION_CANARY_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 2000;
const QUESTION = "Read the number in the picture: the large timer readout. Reply with only its four digits, without the colon. If there is no picture, reply NONE.";
const SYSTEM = "You are answering a short check of a picture channel. Reply with four digits or NONE, nothing else.";

const FONT      = {
  " ": [0, 0, ""],
  "-": [0, 4, "#####"],
  "0": [0, 7, ".###.|#...#|#..##|#.#.#|##..#|#...#|.###."],
  "1": [0, 7, "..#..|.##..|..#..|..#..|..#..|..#..|#####"],
  "2": [0, 7, ".###.|#...#|....#|...#.|..#..|.#...|#####"],
  "3": [0, 7, ".###.|#...#|....#|..##.|....#|#...#|.###."],
  "4": [0, 7, ".#..#|.#..#|#...#|#####|....#|....#|....#"],
  "5": [0, 7, "#####|#....|####.|....#|....#|#...#|.###."],
  "6": [0, 7, ".###.|#....|#....|####.|#...#|#...#|.###."],
  "7": [0, 7, "#####|....#|....#|...#.|..#..|..#..|..#.."],
  "8": [0, 7, ".###.|#...#|#...#|.###.|#...#|#...#|.###."],
  "9": [0, 7, ".###.|#...#|#...#|.####|....#|#...#|.###."],
  ":": [2, 6, "#|#|.|.|#|#"],
  "P": [0, 7, "####.|#...#|#...#|####.|#....|#....|#...."],
  "R": [0, 7, "####.|#...#|#...#|####.|#...#|#...#|#...#"],
  "S": [0, 7, ".###.|#...#|#....|.###.|....#|#...#|.###."],
  "V": [0, 7, "#...#|#...#|#...#|#...#|.#.#.|.#.#.|..#.."],
  "W": [0, 7, "#...#|#...#|#...#|#...#|#.#.#|##.##|#...#"],
  "a": [0, 5, ".####|#...#|#...#|#...#|.####"],
  "b": [0, 7, "#....|#....|####.|#...#|#...#|#...#|####."],
  "c": [0, 5, ".###.|#...#|#....|#...#|.###."],
  "d": [0, 7, "....#|....#|.####|#...#|#...#|#...#|.####"],
  "e": [0, 5, ".###.|#...#|#####|#....|.###."],
  "h": [0, 7, "#....|#....|####.|#...#|#...#|#...#|#...#"],
  "i": [0, 7, "..#..|.....|.##..|..#..|..#..|..#..|#####"],
  "k": [0, 7, "#....|#....|#...#|#..#.|###..|#..#.|#...#"],
  "l": [0, 7, "##...|.#...|.#...|.#...|.#...|.#...|..###"],
  "n": [0, 5, "####.|#...#|#...#|#...#|#...#"],
  "o": [0, 5, ".###.|#...#|#...#|#...#|.###."],
  "p": [0, 5, "####.|#...#|#...#|#...#|####.|#....|#...."],
  "r": [0, 5, "#.##.|##..#|#....|#....|#...."],
  "s": [0, 5, ".####|#....|.###.|....#|####."],
  "t": [0, 7, ".#...|.#...|####.|.#...|.#...|.#...|..###"],
  "u": [0, 5, "#...#|#...#|#...#|#...#|.####"],
};
const PROGRAM_CARD_VISION_CANARY_FONT = FONT;

const FRAME_W = 576, FRAME_H = 288, CELL = 6;
const PROGRAM_CARD_VISION_CANARY_FRAME_SCALE = 2;

const PROGRAM_CARD_VISION_CANARY_PROBE = "card-frame-2x";

function mirrorGreen(level        ) {
  const g = level * 17;
  return [Math.floor(g * 2 / 5), g, Math.floor(g * 2 / 5)];
}

function renderProgramCardVisionCanaryPng(digits        )      {
  if (!/^\d{4}$/.test(digits)) throw new Error("canary: four digits only");
  const rgb = new Uint8Array(FRAME_W * FRAME_H * 3);
  const text = (words        , x        , baseline        , scale        , level        ) => {
    const ink = mirrorGreen(level);
    for (const c of words) {
      const [left, top, rows] = FONT[c];
      rows.split("|").forEach((row        , y        ) => [...row].forEach((bit, dx) => {
        if (bit !== "#") return;
        const px = x + (left + dx) * scale, py = baseline - (top - y) * scale;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) rgb.set(ink, ((py + sy) * FRAME_W + px + sx) * 3);
      }));
      x += CELL * scale;
    }
  };
  const readout = `${digits.slice(0, 2)}:${digits.slice(2)}`;
  text("Vision check", 18, 30, 2, 9);
  text(readout, Math.round((FRAME_W / 2 - (readout.length * CELL - 1) * 5) / 2), 135, 5, 15);
  text("Work", 306, 90, 3, 15);
  text("Paused", 306, 150, 3, 9);
  text("Start", 18, 205, 3, 5);
  text("Reset", 18, 235, 3, 15);
  text("tap: press - double-tap: back", 18, 278, 2, 15);

  const n = PROGRAM_CARD_VISION_CANARY_FRAME_SCALE, w = FRAME_W * n, h = FRAME_H * n;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = (Math.floor(y / n) * FRAME_W + Math.floor(x / n)) * 3;
    out.set(rgb.subarray(from, from + 3), (y * w + x) * 3);
  }
  return encodePngRgb(out, w, h);
}

const sha256 = (value     ) => createHash("sha256").update(value).digest("hex");

function createProgramCardVisionCanary(opts      = {}) {
  const host = opts.host === "hermes" ? "hermes" : "openclaw";
  const llmComplete = opts.llmComplete;
  const registry = opts.registry;
  const imageModelFor = (result     ) => { try { return opts.imageModelFor(result); } catch { return null; } };
  const hostVersion = () => {
    try {
      const value = typeof opts.hostVersion === "function" ? opts.hostVersion() : null;
      return typeof value === "string" && value ? value.slice(0, 200) : null;
    } catch { return null; }
  };
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  const oracle = typeof opts.oracle === "function" ? opts.oracle
    : () => `${randomInt(10, 60)}${String(randomInt(0, 60)).padStart(2, "0")}`;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const setTimer = typeof opts.setTimeout === "function" ? opts.setTimeout : setTimeout;
  const clearTimer = typeof opts.clearTimeout === "function" ? opts.clearTimeout : clearTimeout;
  const failures = new Map             ();
  const running = new Map                      ();

  async function ask(messages     ) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer      = null;
    const deadline = new Promise(resolve => {
      timer = setTimer(() => { controller?.abort(); resolve({ error: "timeout" }); }, PROGRAM_CARD_VISION_CANARY_TIMEOUT_MS);
    });
    try {
      const params      = { messages, maxTokens: MAX_TOKENS, temperature: 0, purpose: opts.purpose,
        timeoutMs: PROGRAM_CARD_VISION_CANARY_TIMEOUT_MS };
      if (controller) params.signal = controller.signal;
      const completion = Promise.resolve().then(() => llmComplete(params));
      completion.catch(() => {});
      return await Promise.race([completion, deadline]);
    } catch (err     ) {
      return { error: err?.code || err?.message || "model_error" };
    } finally {
      if (timer !== null) clearTimer(timer);
    }
  }

  function frame() {
    const number = oracle();
    const png = renderProgramCardVisionCanaryPng(number), data = png.toString("base64");
    const picture = host === "hermes"
      ? { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }
      : { type: "image", data, mimeType: "image/png" };
    return { number, png, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: [{ type: "text", text: QUESTION }, picture] }] };
  }

  async function probe(identity     , expected     ) {
    const version = hostVersion();
    const unreachable = (res     ) => {
      if (!res || res.error || res.failure || ["error", "aborted"].includes(res.stopReason)) {
        return { ok: false, transient: true, reason: `vision check could not reach ${identity.provider}/${identity.model}` };
      }
      if (!sameProgramCardReviewImageIdentity(host, expected, imageModelFor(res))) {
        return { ok: false, transient: true, reason: "vision check ran on a different review route" };
      }
      return null;
    };
    const textOf = (res     ) => typeof res.text === "string" ? res.text.trim() : "";
    const digitsOf = (text        ) => text.length <= 40 ? text.replace(/\D/g, "") : "";
    let shot = frame();
    const negativeMessages = [{ role: "system", content: SYSTEM }, { role: "user", content: QUESTION }];
    const [first, blind]        = await Promise.all([ask(shot.messages), ask(negativeMessages)]);
    let seen = first;
    for (const res of [seen, blind]) {
      const failed = unreachable(res);
      if (failed) return failed;
    }
    let positive = digitsOf(textOf(seen));
    if (positive !== shot.number) {

      log(`vision check read ${positive || "no number"} for ${shot.number}, trying a second frame`);
      shot = frame();
      seen = await ask(shot.messages);
      const failed = unreachable(seen);
      if (failed) return failed;
      positive = digitsOf(textOf(seen));
    }
    const number = shot.number, seenText = textOf(seen);
    const blindText = textOf(blind).replace(/\s+/g, " ").slice(0, 300);
    if (positive !== number) {
      return { ok: false, reason: `${identity.provider}/${identity.model} read ${positive || "no number"} for ${number} in the vision check picture` };
    }
    if (blindText.includes(number) || blindText.replace(/\D/g, "").includes(number)) {
      return { ok: false, reason: `${identity.provider}/${identity.model} answered the vision check without the picture` };
    }
    const result = registry.record({
      version: 1, evidence: "HOST_CANARY", scripted: false, host,
      provider: identity.provider, model: identity.model, carrier: identity.carrier, modelInput: identity.input,
      probeId: `host-${randomBytes(8).toString("hex")}`, probe: PROGRAM_CARD_VISION_CANARY_PROBE,
      imageSha256: sha256(shot.png),
      positiveRequestSha256: sha256(JSON.stringify(shot.messages)),
      negativeRequestSha256: sha256(JSON.stringify(negativeMessages)),
      transportReceiptSha256: sha256(JSON.stringify([seen.provider, seen.model, seenText, blind.provider, blind.model, blindText])),
      positive, negative: blindText, oracle: number, visualReviewEligible: true,
      ...(version ? { hostVersion: version } : {}),
      verifiedAt: new Date(now()).toISOString(),
    });
    return result.ok ? { ok: true } : { ok: false, reason: "vision check receipt was not accepted" };
  }

  function lapsed(receipt     ) {
    if (receipt?.evidence !== "HOST_CANARY") return null;
    const age = now() - Date.parse(receipt.verifiedAt);
    if (!(age >= 0 && age < PROGRAM_CARD_VISION_CANARY_PASS_TTL_MS)) return "expired";
    if ((receipt.hostVersion ?? null) !== hostVersion()) return "host version changed";
    if (receipt.probe !== PROGRAM_CARD_VISION_CANARY_PROBE) return "probe changed";
    return null;
  }

  function run(key        , identity     , expected     , recheck               ) {
    if (running.has(key)) return running.get(key);
    const route = `host=${host} provider=${identity.provider} model=${identity.model}`;
    log(`vision check started ${route}${recheck ? ` recheck=${recheck}` : ""}`);
    const outcome = probe(identity, expected).catch((err     ) => ({ ok: false, transient: true,
      reason: `vision check failed (${err?.message || err})` })).then((outcome     ) => {
      running.delete(key);
      if (outcome.ok) failures.delete(key);
      else {
        failures.set(key, { reason: outcome.reason,
          untilMs: now() + (outcome.transient ? PROGRAM_CARD_VISION_CANARY_ERROR_TTL_MS : PROGRAM_CARD_VISION_CANARY_FAILURE_TTL_MS) });

        try { registry.revoke(host, expected); } catch (err     ) { log(`vision check could not withdraw ${route}: ${err?.message || err}`); }
      }
      log(`vision check ${outcome.ok ? "passed" : "failed"} ${route}${outcome.ok ? "" : ` reason=${outcome.reason}`}`);
      return outcome;
    });
    running.set(key, outcome);
    return outcome;
  }

  return {

    async ensure(expected     , onRun      = null) {
      const identity = programCardReviewImageIdentity(host, expected);
      if (!identity || !identity.input.includes("image") || typeof llmComplete !== "function" || !registry) {
        return { ran: false, qualified: false };
      }
      const key = JSON.stringify([identity.host, identity.provider, identity.model, identity.carrier]);
      const failed = failures.get(key);
      const cooling = failed && now() < failed.untilMs;
      const current = registry.qualify(host, expected);
      if (current.qualified) {
        const recheck = lapsed(current.receipt);
        if (recheck && !cooling) run(key, identity, expected, recheck);
        return { ran: false, qualified: true };
      }
      if (cooling) return { ran: false, qualified: false, reason: failed.reason };
      if (!running.has(key) && typeof onRun === "function") onRun();
      const outcome = await run(key, identity, expected, null);
      return { ran: true, qualified: outcome.ok === true, reason: outcome.reason };
    },
  };
}

module.exports = { PROGRAM_CARD_VISION_CANARY_FAILURE_TTL_MS, PROGRAM_CARD_VISION_CANARY_ERROR_TTL_MS, PROGRAM_CARD_VISION_CANARY_PASS_TTL_MS, PROGRAM_CARD_VISION_CANARY_TIMEOUT_MS, PROGRAM_CARD_VISION_CANARY_FONT, PROGRAM_CARD_VISION_CANARY_FRAME_SCALE, PROGRAM_CARD_VISION_CANARY_PROBE, renderProgramCardVisionCanaryPng, createProgramCardVisionCanary };
