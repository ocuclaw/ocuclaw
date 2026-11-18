const { deflateSync } = require("node:zlib");
const { crc32 } = require("./bot-screen/png-rgb.cjs");

const FRAME_GRID_W = 288;
const FRAME_GRID_H = 131;
const FRAME_GRID_CELLS = FRAME_GRID_W * FRAME_GRID_H;
const FRAME_SCREEN_W = 576;
const FRAME_SCREEN_H = 261;
const FRAME_SCREEN_CELLS = FRAME_SCREEN_W * FRAME_SCREEN_H;
const FRAME_MAX_BYTES = 54_000;
const FRAME_TEXT_LINE = 27;
const FRAME_VIEW_MAX_W = 288;
const FRAME_VIEW_MAX_H = 144;

const FRAME_VIEW_GAP = 2;

const Buffer      = (globalThis       ).Buffer;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fmt = (b          ) => b.join(",");

class FrameRule extends Error {}

function box(name        , b     )           {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new FrameRule(`${name} must be four numbers x, y, w, h`);
  }
  const [x, y, w, h] = b.map((v        ) => Math.trunc(v))            ;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > FRAME_SCREEN_W || y + h > FRAME_SCREEN_H) {
    throw new FrameRule(`${name} ${x},${y},${w},${h} is not inside the 576x261 screen`);
  }
  return [x, y, w, h];
}

const overlap = (a          , b          ) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

function list(name        , v     , max        )        {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new FrameRule(`${name} must be a list of [x, y, w, h] boxes`);
  if (v.length > max) throw new FrameRule(`${name} has ${v.length} boxes; at most ${max}`);
  return v;
}

function chunk(type        , data            ) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function frameScreenFromGrid(grid            )             {
  const screen = new Uint8Array(FRAME_SCREEN_CELLS);
  for (let y = 0; y < FRAME_SCREEN_H; y++) {
    const src = (y >> 1) * FRAME_GRID_W, row = y * FRAME_SCREEN_W;
    for (let x = 0; x < FRAME_SCREEN_W; x++) screen[row + x] = grid[src + (x >> 1)];
  }
  return screen;
}

function frameScreenOf(screen            , view          , art            , words            )             {

  const mask = new Uint8Array(FRAME_SCREEN_CELLS);
  const paint = (b          , v        ) => {
    const x0 = Math.max(0, b[0]), x1 = Math.min(FRAME_SCREEN_W, b[0] + b[2]);
    for (let y = Math.max(0, b[1]); y < Math.min(FRAME_SCREEN_H, b[1] + b[3]); y++) {
      if (x1 > x0) mask.fill(v, y * FRAME_SCREEN_W + x0, y * FRAME_SCREEN_W + x1);
    }
  };
  art.forEach((a) => paint(a, 1));
  paint([view[0] - FRAME_VIEW_GAP, view[1] - FRAME_VIEW_GAP, view[2] + 2 * FRAME_VIEW_GAP, view[3] + 2 * FRAME_VIEW_GAP], 0);
  words.forEach((b) => paint(b, 0));
  const masked = new Uint8Array(FRAME_SCREEN_CELLS);
  for (let i = 0; i < FRAME_SCREEN_CELLS; i++) if (mask[i]) masked[i] = screen[i];
  return masked;
}

function saveProgramCardFrame(screen     , boxes                                      ,
  options                                                                = {})                            {
  const units = Math.max(1, Math.min(3, Math.trunc(options.units ?? 3)));
  try {
    if (!(screen instanceof Uint8Array) || screen.length !== FRAME_SCREEN_CELLS) {
      throw new FrameRule(`the screen must be ${FRAME_SCREEN_W}x${FRAME_SCREEN_H} greys`);
    }
    const view = box("view", boxes?.view);
    if (view[2] > FRAME_VIEW_MAX_W || view[3] > FRAME_VIEW_MAX_H) {
      throw new FrameRule(`the view is ${view[2]}x${view[3]}; it may be up to 288x144`);
    }
    const art = list("art", boxes?.art, 8).map((a) => box("art", a));
    const words = list("words", boxes?.words, 16).map((b) => box("words", b));
    for (const b of options.wordsFixed ? [] : words) {
      if (b[3] < FRAME_TEXT_LINE) {
        throw new FrameRule(`words ${fmt(b)} is ${b[3]} px high; a word box needs at least ${FRAME_TEXT_LINE}, one line of the card's text`);
      }
    }
    let budget = 0;
    for (const a of art) {
      if (a[2] <= 288 && a[3] <= 144) budget += 1;
      else if ((a[2] <= 576 && a[3] <= 144) || (options.underView && a[2] <= 288 && a[3] <= FRAME_SCREEN_H)) budget += 2;
      else throw new FrameRule(`art ${fmt(a)} is too big: each is up to 288x144, or one up to ${options.underView ? "576x144 or 288x261" : "576x144"}`);
    }
    if (art.length === 0 || budget > units) {
      throw new FrameRule(units === 1
        ? `the art needs 1 rectangle up to 288x144; it has ${budget} units`
        : `the art needs 1 to ${units} rectangles (a ${options.underView ? "576-wide or 261-tall" : "576-wide"} one counts as two); it has ${budget}`);
    }
    art.forEach((a, i) => {
      if (!options.underView && overlap(a, view)) throw new FrameRule(`art ${fmt(a)} overlaps the view`);
      for (const b of art.slice(i + 1)) if (overlap(a, b)) throw new FrameRule(`art ${fmt(a)} overlaps art ${fmt(b)}`);
    });

    const masked = frameScreenOf(screen, view, art, words);
    const used = new Uint8Array(256);
    used[0] = 1;
    for (let i = 0; i < masked.length; i++) used[masked[i]] = 1;
    const greys           = [];
    const index = new Uint8Array(256);
    for (let g = 0; g < 256; g++) if (used[g]) { index[g] = greys.length; greys.push(g); }
    const raw = Buffer.alloc((FRAME_SCREEN_W + 1) * FRAME_SCREEN_H);
    for (let y = 0; y < FRAME_SCREEN_H; y++) {
      const o = y * (FRAME_SCREEN_W + 1) + 1, s = y * FRAME_SCREEN_W;
      for (let x = 0; x < FRAME_SCREEN_W; x++) raw[o + x] = index[masked[s + x]];
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(FRAME_SCREEN_W, 0);
    ihdr.writeUInt32BE(FRAME_SCREEN_H, 4);
    ihdr[8] = 8;
    ihdr[9] = 3;
    const plte = Buffer.alloc(greys.length * 3);
    greys.forEach((g, i) => plte.fill(g, i * 3, i * 3 + 3));
    const png = Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", ihdr),
      chunk("PLTE", plte),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", new Uint8Array(0)),
    ]);
    if (png.length > FRAME_MAX_BYTES) {
      throw new FrameRule(`the PNG is ${png.length} bytes; it must be 54 KB or less (fewer tiny details)`);
    }
    const lines = [`view ${fmt(view)}`, ...art.map((a) => `art ${fmt(a)}`), ...words.map((b) => `words ${fmt(b)}`)];
    return { ok: true, png, view, art, words, lines };
  } catch (err) {
    if (err instanceof FrameRule) return { ok: false, error: err.message };
    throw err;
  }
}

module.exports = { FRAME_GRID_W, FRAME_GRID_H, FRAME_GRID_CELLS, FRAME_SCREEN_W, FRAME_SCREEN_H, FRAME_SCREEN_CELLS, FRAME_MAX_BYTES, FRAME_TEXT_LINE, FRAME_VIEW_MAX_W, FRAME_VIEW_MAX_H, FRAME_VIEW_GAP, frameScreenFromGrid, frameScreenOf, saveProgramCardFrame };
