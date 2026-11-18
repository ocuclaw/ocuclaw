const { inflateSync } = require("node:zlib");
const { Buffer } = require("node:buffer");

const baked = require("./frames.cjs");
const { cpLen, ease, pyMod, pyRound, stripAnsi, wrap } = require("./text.cjs");

const FRAME_CACHE = new Map                    ();

function framesFor(size           )                                          {
  let raw = FRAME_CACHE.get(size === "big" ? "big" : "mini");
  if (!raw) {
    const data = size === "big" ? baked.BIG_FRAMES : baked.MINI_FRAMES;
    raw = new Uint8Array(inflateSync(Buffer.from(data, "base64")));
    FRAME_CACHE.set(size === "big" ? "big" : "mini", raw);
  }
  return [raw, size === "big" ? baked.BIG : baked.MINI];
}

function speckFrame(state        , t        , size            = "big")        {
  const [raw, [cols, rows]] = framesFor(size);
  let index = baked.STATES.indexOf(state);
  if (index < 0) index = 0;
  const lengths = baked.LENGTHS;
  let n = Math.trunc(t * baked.FPS);

  n = baked.ONCE.includes(state) ? Math.min(Math.max(n, 0), lengths[index] - 1) : pyMod(n, lengths[index]);
  let frame = n;
  for (let i = 0; i < index; i++) frame += lengths[i];
  const cells = cols * rows;
  const at = frame * cells * 2;
  return [cols, rows, raw.subarray(at, at + cells), raw.subarray(at + cells, at + 2 * cells)];
}

function dotKey(x        , y        )         {
  return `${x},${y}`;
}

function dotXY(key        )                   {
  const at = key.indexOf(",");
  return [Number(key.slice(0, at)), Number(key.slice(at + 1))];
}

function frameDots(frame       )                      {
  const [cols, rows, dots, props] = frame;
  const out = new Map                ();
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bits = dots[cy * cols + cx];
      if (bits) {
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            if (bits & BIT[dy][dx]) out.set(dotKey(cx * 2 + dx, cy * 4 + dy), props[cy * cols + cx]);
          }
        }
      }
    }
  }
  return out;
}

function dotsFrame(cols        , rows        , lit                                                  )        {
  const dots = new Uint8Array(cols * rows);
  const prop = new Array        (cols * rows).fill(0);
  for (const [x, y, flag] of lit) {
    if (x >= 0 && x < cols * 2 && y >= 0 && y < rows * 4) {
      const at = (y >> 2) * cols + (x >> 1);
      dots[at] |= BIT[y & 3][x & 1];
      prop[at] += flag ? 1 : -1;
    }
  }
  return [cols, rows, dots, Uint8Array.from(prop, (n) => (n > 0 ? 1 : 0))];
}

function pairDots(
  src                                          ,
  dst                                          ,
  reach = 24,
)                                                {
  const grid = new Map                  ();
  dst.forEach(([x, y], j) => {
    const key = dotKey(x >> 2, y >> 2);
    const list = grid.get(key);
    if (list) list.push(j);
    else grid.set(key, [j]);
  });
  const free = new Array         (dst.length).fill(true);
  const pairs                          = [];
  const lost           = [];
  src.forEach(([x, y], i) => {
    const gx = x >> 2;
    const gy = y >> 2;
    let best = -1;
    let bestD = reach * reach + 1;
    for (let r = 0; r < Math.floor(reach / 4) + 2; r++) {
      for (let cx = gx - r; cx <= gx + r; cx++) {
        for (let cy = gy - r; cy <= gy + r; cy++) {
          if (Math.max(Math.abs(cx - gx), Math.abs(cy - gy)) !== r) continue;
          for (const j of grid.get(dotKey(cx, cy)) ?? []) {
            if (free[j]) {
              const d = (dst[j][0] - x) ** 2 + (dst[j][1] - y) ** 2;
              if (d < bestD) {
                best = j;
                bestD = d;
              }
            }
          }
        }
      }

      if (best >= 0 && bestD <= (r * 4) ** 2) break;
    }
    if (best >= 0) {
      free[best] = false;
      pairs.push([i, best]);
    } else {
      lost.push(i);
    }
  });
  const born           = [];
  free.forEach((ok, j) => {
    if (ok) born.push(j);
  });
  return [pairs, lost, born];
}

function bodyShift(a                             , b                             )                   {
  function best(axis       , size        , most        )         {
    const ha = new Array        (size).fill(0);
    const hb = new Array        (size).fill(0);
    for (const [hist, dots] of [
      [ha, a],
      [hb, b],
    ]         ) {
      for (const [key, flag] of dots) {
        if (!flag) hist[dotXY(key)[axis]] += 1;
      }
    }

    let pick = -most;
    let pickScore = -Infinity;
    for (let d = -most; d <= most; d++) {
      let score = 0;
      for (let i = Math.max(0, -d); i < Math.min(size, size - d); i++) score += ha[i] * hb[i + d];
      if (score > pickScore || (score === pickScore && -Math.abs(d) > -Math.abs(pick))) {
        pick = d;
        pickScore = score;
      }
    }
    return pick;
  }
  return [best(0, 100, 24), best(1, 32, 6)];
}

function seededRandom(seed        )               {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

class Glide {

  static REACH = 3;

  cols        ;
  rows        ;
  dx        ;
  dy        ;

  stay                     ;

  moves                                 ;

  out                             ;

  into                             ;

  constructor(old       , next       , seed = 7) {
    this.cols = next[0];
    this.rows = next[1];
    const a = frameDots(old);
    const b = frameDots(next);
    [this.dx, this.dy] = bodyShift(a, b);
    const dx = this.dx;
    const dy = this.dy;
    const landed = new Set        ();
    const aXY       = [];
    for (const key of a.keys()) {
      const [x, y] = dotXY(key);
      aXY.push([x, y]);
      landed.add(dotKey(x + dx, y + dy));
    }
    this.stay = [];
    const leave       = [];
    for (const [x, y] of aXY) {
      const there = b.get(dotKey(x + dx, y + dy));
      if (there !== undefined) this.stay.push([[x, y], there]);
      else leave.push([x, y]);
    }
    const arrive       = [];
    for (const key of b.keys()) if (!landed.has(key)) arrive.push(dotXY(key));
    const [pairs, lost, born] = pairDots(
      leave.map(([x, y])     => [x + dx, y + dy]),
      arrive,
      Glide.REACH,
    );
    const r = seededRandom(seed + leave.length * 31 + arrive.length);
    const flagA = (xy    )         => a.get(dotKey(xy[0], xy[1]))          ;
    const flagB = (xy    )         => b.get(dotKey(xy[0], xy[1]))          ;
    this.moves = pairs.map(([i, j])                           => [leave[i], arrive[j], flagA(leave[i]), flagB(arrive[j])]);

    this.out = lost.map((i)                       => [leave[i], flagA(leave[i]), 0.35 + 0.15 * r()]);
    this.into = born.map((j)                       => [arrive[j], flagB(arrive[j]), 0.5 + 0.15 * r()]);
  }

  frame(f        )        {
    const e = ease(f);
    const sx = this.dx * e;
    const sy = this.dy * e;
    const lit                                  = this.stay.map(([[x, y], flag])                           => [
      pyRound(x + sx),
      pyRound(y + sy),
      flag,
    ]);
    for (const [[ax, ay], [bx, by], was, now] of this.moves) {
      lit.push([pyRound(ax + (bx - ax) * e), pyRound(ay + (by - ay) * e), f >= 0.5 ? now : was]);
    }
    for (const [[x, y], flag, when] of this.out) if (f < when) lit.push([pyRound(x + sx), pyRound(y + sy), flag]);
    for (const [[x, y], flag, when] of this.into) {
      if (f >= when) lit.push([pyRound(x - this.dx + sx), pyRound(y - this.dy + sy), flag]);
    }
    return dotsFrame(this.cols, this.rows, lit);
  }
}

function rgb(hex        , color         )         {
  if (!color) return "";
  return `\x1b[38;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}m`;
}

class Palette {
  g        ;
  gd        ;
  gl        ;
  y        ;
  yLow        ;
  yGlint        ;
  c        ;
  r        ;
  fg        ;
  dim        ;
  faint        ;
  bold        ;
  under        ;
  chip        ;
  reset        ;

  constructor(color = true, light = false) {
    const hex = light ? LIGHT_HEX : DARK_HEX;
    this.g = rgb(hex.g, color);
    this.gd = rgb(hex.gd, color);
    this.gl = rgb(hex.gl, color);
    this.y = rgb(hex.y, color);
    this.yLow = rgb(hex.yLow, color);
    this.yGlint = rgb(hex.yGlint, color);
    this.c = rgb(hex.c, color);
    this.r = rgb(hex.r, color);
    this.fg = rgb(hex.fg, color);
    this.dim = rgb(hex.dim, color);
    this.faint = rgb(hex.faint, color);
    this.bold = color ? "\x1b[1m" : "";
    this.under = color ? "\x1b[4m" : "";
    this.chip = color ? (light ? "\x1b[1;38;2;255;255;255;48;2;30;158;87m" : "\x1b[1;38;2;11;13;10;48;2;77;213;138m") : "";
    this.reset = color ? "\x1b[0m" : "";
  }
}

const DARK_HEX = {
  g: "4dd58a", gd: "2d8a57", gl: "a3f2c4", y: "e9c46a", yLow: "a8893e", yGlint: "f6dc9a",
  c: "7cc9ee", r: "f08a8a", fg: "e3e4ee", dim: "8a8da6", faint: "5c5f78",
}         ;

const LIGHT_HEX                                                    = {
  g: "1e9e57", gd: "146c3c", gl: "33c472", y: "b8860b", yLow: "8a6a1f", yGlint: "d9a520",
  c: "1f78b4", r: "c0392b", fg: "2b2925", dim: "6b6760", faint: "a29d94",
};

function isLightBackground(colour        )                 {
  const xparse = /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(colour);
  const hash = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})\b/i.exec(colour);
  const parts = xparse || hash;
  if (!parts) return null;
  const [r, g, b] = parts.slice(1, 4).map((part) => parseInt(part, 16) / (16 ** part.length - 1));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

const BLANK                = [" ", ""];
const BRAILLE_BLANK = String.fromCodePoint(0x2800);

class Canvas {
  cols        ;
  rows        ;
  p         ;
  cells         ;

  constructor(cols        , rows        , palette         ) {
    this.cols = cols;
    this.rows = rows;
    this.p = palette;
    this.cells = [];
    for (let y = 0; y < rows; y++) {
      const row        = [];
      for (let x = 0; x < cols; x++) row.push([BLANK[0], BLANK[1]]);
      this.cells.push(row);
    }
  }

  put(x        , y        , ch        , style = "")       {
    if (x >= 0 && x < this.cols && y >= 0 && y < this.rows) this.cells[y][x] = [ch, style];
  }

  get(x        , y        )             {
    if (x >= 0 && x < this.cols && y >= 0 && y < this.rows) return this.cells[y][x];
    return null;
  }

  empty(x        , y        )          {
    const cell = this.get(x, y);
    return cell !== null && cell[0] === " ";
  }

  text(x        , y        , text        , style = "")         {
    if (y >= 0 && y < this.rows) {
      const row = this.cells[y];
      for (const ch of text) {
        if (x >= 0 && x < this.cols) row[x] = [ch, style];
        x += 1;
      }
      return x;
    }
    return x + cpLen(text);
  }

  segs(x        , y        , segs                                          , width                = null)         {
    let room = width === null ? this.cols - x : width;
    for (const [whole, style] of segs) {
      if (room <= 0) break;
      const text = Array.from(whole).slice(0, room).join("");
      room -= cpLen(text);
      x = this.text(x, y, text, style);
    }
    return x;
  }

  tint(x0        , y0        , x1        , y1        , old        , next        )       {
    for (let y = Math.max(0, y0); y < Math.min(this.rows, y1 + 1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.cols, x1 + 1); x++) {
        const [ch, style] = this.cells[y][x];
        if (ch !== " " && style === old) this.cells[y][x] = [ch, next];
      }
    }
  }

  speck(
    x        ,
    y        ,
    state        ,
    t        ,
    size            = "big",
    crop                                           = [0, 99],
    body                = null,
    prop                = null,
    frame               = null,
  )         {
    if (!Array.isArray(crop)) {
      const opts = crop                ;
      crop = opts.crop ?? [0, 99];
      body = opts.body ?? null;
      prop = opts.prop ?? null;
      frame = opts.frame ?? null;
    }
    const range = crop                             ;
    const [cols, rows, dots, props] = frame ?? speckFrame(state, t, size);
    const lo = range[0];
    const hi = Math.min(cols - 1, range[1]);
    const bodyStyle = body === null ? this.p.g : body;
    const propStyle = prop === null ? bodyStyle : prop;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = lo; cx <= hi; cx++) {
        const bits = dots[cy * cols + cx];
        if (bits) this.put(x + cx - lo, y + cy, String.fromCodePoint(0x2800 + bits), props[cy * cols + cx] ? propStyle : bodyStyle);
      }
    }
    return hi - lo + 1;
  }

  line(y        )         {
    const cells = this.cells[y];
    let end = cells.length;
    while (end && cells[end - 1][0] === BLANK[0] && cells[end - 1][1] === BLANK[1]) end -= 1;
    const out           = [];
    let style                = null;
    for (let i = 0; i < end; i++) {
      const [ch, st] = cells[i];
      if (st !== style) {
        out.push(style !== null || st ? this.p.reset + st : "");
        style = st;
      }
      out.push(ch);
    }
    if (style) out.push(this.p.reset);
    return out.join("");
  }
}

function segStr(segs                                          , palette         )         {
  return segs.map(([text, style]) => (style ? style + text + palette.reset : text)).join("");
}

function segLen(segs                                          )         {
  let n = 0;
  for (const [text] of segs) n += cpLen(text);
  return n;
}

class Row {
  text        ;
  height        ;

  constructor(text        , height = 1) {
    this.text = text;
    this.height = height;
  }
}

function canvasRows(canvas        )        {
  const out        = [];
  for (let y = 0; y < canvas.rows; y++) out.push(new Row(canvas.line(y)));
  return out;
}

function screenRows(text        , cols        )         {
  return Math.max(1, Math.ceil(cpLen(stripAnsi(text)) / Math.max(1, cols)));
}

function wrappedRow(text        , style        , cols        , palette         , indent                               = 2)      {
  const lead = typeof indent === "number" ? indent : (indent.indent ?? 2);
  const width = lead + cpLen(text);
  return new Row(" ".repeat(Math.max(0, lead)) + style + text + palette.reset, Math.max(1, Math.ceil(width / Math.max(1, cols))));
}

const GLYPHS                                   = {
  A: ".###.|#...#|#...#|#####|#...#|#...#|#...#",
  B: "####.|#...#|#...#|####.|#...#|#...#|####.",
  C: ".###.|#...#|#....|#....|#....|#...#|.###.",
  D: "###..|#..#.|#...#|#...#|#...#|#..#.|###..",
  E: "#####|#....|#....|####.|#....|#....|#####",
  F: "#####|#....|#....|####.|#....|#....|#....",
  G: ".###.|#...#|#....|#.###|#...#|#...#|.####",
  H: "#...#|#...#|#...#|#####|#...#|#...#|#...#",
  I: ".###.|..#..|..#..|..#..|..#..|..#..|.###.",
  J: "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
  K: "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
  L: "#....|#....|#....|#....|#....|#....|#####",
  M: "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
  N: "#...#|#...#|##..#|#.#.#|#..##|#...#|#...#",
  O: ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
  P: "####.|#...#|#...#|####.|#....|#....|#....",
  Q: ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
  R: "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
  S: ".####|#....|#....|.###.|....#|....#|####.",
  T: "#####|..#..|..#..|..#..|..#..|..#..|..#..",
  U: "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
  V: "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
  W: "#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.",
  X: "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
  Y: "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
  Z: "#####|....#|...#.|..#..|.#...|#....|#####",
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

  "✓": ".....#|....##|...##.|#.##..|###...|.#....|......",
};
const GLYPH_ROWS                                              = Object.fromEntries(
  Object.entries(GLYPHS).map(([key, value]) => [key, value.split("|")]),
);

const BIT                                         = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

function bigWidth(text        )         {
  return cpLen(text) * 3;
}

function lit(rows                   , px        , py        , bold         )          {
  const on = (y        )          => y >= 0 && y < rows.length && px < rows[y].length && rows[y][px] === "#";
  return on(py) || (bold && on(py - 1));
}

function bigDraw(c        , x        , y        , text        , style       , opts                 = {})         {
  const mask = opts.mask ?? null;
  const bold = opts.bold ?? false;
  const solid = opts.solid ?? false;
  Array.from(text.toUpperCase()).forEach((ch, gi) => {
    const rows = GLYPH_ROWS[ch] ?? GLYPH_ROWS[" "];
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        let bits = 0;
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const px = cx * 2 + dx;
            const py = cy * 4 + dy;
            if (lit(rows, px, py, bold) && (mask === null || mask(px, py))) bits |= BIT[dy][dx];
          }
        }
        if (!bits && !solid) continue;
        const st = typeof style === "function" ? style(gi, cx) : style;
        c.put(x + gi * 3 + cx, y + cy, String.fromCodePoint(0x2800 + bits), st);
      }
    }
  });
  return x + bigWidth(text);
}

const CORNER                = [
  [0, 4],
  [0, 3],
  [0, 2],
  [1, 2],
  [1, 1],
  [2, 1],
  [2, 0],
  [3, 0],
  [4, 0],
];
const R = 4;

const POINT                = [
  ...Array.from({ length: 6 }, (_, i)     => [i, i]),
  ...Array.from({ length: 5 }, (_, i)     => [i, 5]),
];

const THICK = "⠶";
const THIN = "⠤";

function bubble(c        , x        , y        , w        , h        , style        , opts                = {})       {
  const row = opts.row ?? 1;
  const right = opts.right ?? false;
  const left = 2 * x + 1;
  const rightX = 2 * (x + w - 1);
  const top = 4 * y + 1;
  const bottom = 4 * (y + h - 1) + 2;
  const dots = new Set        ();
  for (let dx = left + R; dx <= rightX - R; dx++) {
    dots.add(dotKey(dx, top));
    dots.add(dotKey(dx, bottom));
  }
  for (let dy = top + R; dy <= bottom - R; dy++) {
    dots.add(dotKey(left, dy));
    dots.add(dotKey(rightX, dy));
  }
  for (const [cx, sx] of [
    [left, 1],
    [rightX, -1],
  ]) {
    for (const [cy, sy] of [
      [top, 1],
      [bottom, -1],
    ]) {
      for (const [ox, oy] of CORNER) dots.add(dotKey(cx + sx * ox, cy + sy * oy));
    }
  }
  const [edge, out] = right ? [rightX, 1] : [left, -1];
  const z = 4 * (y + row) + 1;
  for (let dy = z + 1; dy < z + 5; dy++) dots.delete(dotKey(edge, dy));
  for (const [ox, oy] of POINT) dots.add(dotKey(edge + out * ox, z + oy));
  const cells = new Map                ();
  for (const key of dots) {
    const [dx, dy] = dotXY(key);
    if (dx >= 0 && dy >= 0) {
      const cell = dotKey(dx >> 1, dy >> 2);
      cells.set(cell, (cells.get(cell) ?? 0) | BIT[dy & 3][dx & 1]);
    }
  }
  for (const [cell, bits] of cells) {
    const [cx, cy] = dotXY(cell);

    if ((x <= cx && cx < x + w) || c.empty(cx, cy)) c.put(cx, cy, String.fromCodePoint(0x2800 + bits), style);
  }
}

const PIECES                             = [
  [
    [0, 0],
    [1, 0],
  ],
  [
    [0, 0],
    [1, 1],
  ],
  [
    [0, 0],
    [0, 1],
  ],
  [
    [1, 0],
    [0, 1],
  ],
];
const SQUARE                = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

class Bit {
  x        ;
  y0        ;
  born        ;
  v        ;
  sway        ;
  w        ;
  ph        ;
  spin        ;
  big         ;
  color        ;

  constructor(x        , y0        , born        , v        , sway        , w        , ph        , spin        , big         , color        ) {
    this.x = x;
    this.y0 = y0;
    this.born = born;
    this.v = v;
    this.sway = sway;
    this.w = w;
    this.ph = ph;
    this.spin = spin;
    this.big = big;
    this.color = color;
  }
}

function confettiBits()        {
  const r = seededRandom(20261002);
  const out        = [];
  for (let i = 0; i < 560; i++) {

    const burst = i < 480;

    const x = r();
    const y0 = burst ? -4 + r() * 42 : -2 - r() * 4;
    const born = burst ? 0.0 : 1.6 * r() ** 2.2;
    const v = 10 + r() * 14;
    const sway = 0.5 + r() * 1.5;
    const w = 2 + r() * 4;
    const ph = r() * 6.3;
    const spin = Math.trunc(r() * 4);
    const big = r() < 0.25;
    out.push(new Bit(x, y0, born, v, sway, w, ph, spin, big, i % 5));
  }
  return out;
}

const CONFETTI                 = confettiBits();

function confetti(c        , age        )       {
  const p = c.p;
  const colors = [p.g, p.gl, p.y, p.c, p.r];
  const w = c.cols * 2;
  const h = c.rows * 4;
  const busy = (x        , y        )          => {
    const cell = c.get(x, y);
    return cell !== null && cell[0] !== " ";
  };
  const moat = new Set        ();
  for (let y = 0; y < c.rows; y++) {
    for (let x = 0; x < c.cols; x++) {
      if (busy(x, y) || busy(x - 1, y) || busy(x + 1, y) || busy(x, y - 1) || busy(x, y + 1)) moat.add(dotKey(x, y));
    }
  }
  const cells = new Map                          ();
  for (const bit of CONFETTI) {
    const a = age - bit.born;
    if (a < 0) continue;
    const dy = bit.y0 + a * bit.v;
    if (dy < 0 || dy >= h) continue;
    const dx = bit.x * w + Math.sin(a * bit.w + bit.ph) * bit.sway;
    for (const [ox, oy] of bit.big ? SQUARE : PIECES[pyMod(bit.spin + Math.trunc(a * 6), 4)]) {
      const px = Math.floor(dx) + ox;
      const py = Math.floor(dy) + oy;
      if (!(px >= 0 && px < w && py >= 0 && py < h)) continue;
      const key = dotKey(px >> 1, py >> 2);
      let cell = cells.get(key);
      if (!cell) {
        cell = [0, bit.color];
        cells.set(key, cell);
      }
      cell[0] |= BIT[py & 3][px & 1];
    }
  }
  for (const [key, [bits, color]] of cells) {
    if (!moat.has(key)) {
      const [x, y] = dotXY(key);
      c.put(x, y, String.fromCodePoint(0x2800 + bits), colors[color]);
    }
  }
}

class Typist {
  static CPS = 50.0;

  static MOST = 0.8;

  static HANG = 0.2;

  start                               ;
  end        ;

  constructor() {
    this.start = new Map();
    this.end = -99.0;
  }

  fresh(t        )       {
    this.end = Math.min(this.end, t);
  }

  shown(lines                   , t        , instant                                  = false)                          {
    const now = typeof instant === "boolean" ? instant : (instant.instant ?? false);
    const out                          = [];
    for (const text of lines) {
      if (!this.start.has(text)) {
        if (now) {
          this.start.set(text, [t, 0.0]);
        } else {
          let start = Math.max(t, this.end);
          let took        ;
          if (start > t + 1.2) {

            start = t + 0.6;
            took = 0.3;
          } else {
            took = Math.min(cpLen(text) / Typist.CPS, Typist.MOST);
          }
          this.start.set(text, [start, took]);
          this.end = start + took;
        }
      }
      const [start, took] = this.start.get(text)                    ;
      const done = took <= 0 ? 1.0 : Math.max(0.0, Math.min(1.0, (t - start) / took));
      out.push([text, Math.trunc(done * cpLen(text))]);
    }
    return out;
  }

  talking(t        )          {
    return t < this.end + Typist.HANG;
  }
}

function bubbleLines(words                                          , width        )                                   {
  const out                                   = [];
  for (const [text, shown] of words) {
    const typing = shown < cpLen(text);

    const bullet = text.startsWith("• ") ? "• " : "";
    let off = cpLen(bullet);
    wrap(Array.from(text).slice(cpLen(bullet)).join(""), width - cpLen(bullet)).forEach((line, i) => {
      const lead = i === 0 ? bullet : " ".repeat(cpLen(bullet));
      const n = Math.max(0, Math.min(cpLen(line), shown - off));
      out.push([lead + line, n || (i === 0 && shown > 0) ? cpLen(lead) + n : 0, typing]);
      off += cpLen(line) + 1;
    });
  }
  return out;
}

module.exports = { framesFor, speckFrame, dotKey, dotXY, frameDots, dotsFrame, pairDots, bodyShift, seededRandom, Glide, rgb, Palette, DARK_HEX, LIGHT_HEX, isLightBackground, BLANK, BRAILLE_BLANK, Canvas, segStr, segLen, Row, canvasRows, screenRows, wrappedRow, GLYPHS, GLYPH_ROWS, BIT, bigWidth, bigDraw, CORNER, R, POINT, THICK, THIN, bubble, PIECES, SQUARE, Bit, confettiBits, CONFETTI, confetti, Typist, bubbleLines };
