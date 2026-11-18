const { Buffer } = require("node:buffer");

const VIDEO_W = 288;
const VIDEO_H = 144;
const GAMMA = 1.35;
const MAX_GAIN = 2.5;
const SHARPEN_AMOUNT = 0.6;
const SHARPEN_KERNEL = [1, 2, 1, 2, 4, 2, 1, 2, 1];
const MIN_BOX_W = 96;

const ALPHA_12 = 0.12;
const CUT_MEAN_DIFF = 40;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const PLATE                   = [VIDEO_W, VIDEO_H];

const VIDEO_LOOKS                            = {
  rows: { px: [1, 2], dither: "none", floor: 0, sharpen: SHARPEN_AMOUNT, box: PLATE, name: "rows" },
  "2x2": { px: [2, 2], dither: "none", floor: 0, sharpen: SHARPEN_AMOUNT, box: PLATE, name: "2x2" },
  "3x3": { px: [3, 3], dither: "none", floor: 0, sharpen: SHARPEN_AMOUNT, box: PLATE, name: "3x3" },
  full: { px: [1, 1], dither: "bayer4", floor: 0, sharpen: SHARPEN_AMOUNT, box: PLATE, name: "full" },
  "1x1": { px: [1, 1], dither: "none", floor: 0, sharpen: SHARPEN_AMOUNT, box: PLATE, name: "1x1" },
};

function videoLookFor(src        , width                )            {
  let fragment = "";
  try {
    fragment = new URL(src).hash.slice(1).toLowerCase();
  } catch {
    fragment = "";
  }
  const base = Object.keys(VIDEO_LOOKS).find((key) => fragment.includes(key)) || "rows";
  const look            = { ...VIDEO_LOOKS[base] };
  const linkWidth = /(?<![0-9])([0-9]{3})(?![0-9])/.exec(fragment);
  const asked = typeof width === "number" && Number.isFinite(width) ? width : linkWidth ? Number(linkWidth[1]) : null;
  if (asked !== null) {
    const w = Math.min(VIDEO_W, Math.max(MIN_BOX_W, Math.round(asked / 2) * 2));
    look.box = [w, w / 2];
    if (w < VIDEO_W) look.name = `${look.name}-${w}`;
  }
  if (look.box[0] < VIDEO_W) {
    if (fragment.includes("nofit")) look.name = `${look.name}-nofit`;
    else look.fit = true;
  }

  if (fragment.includes("nobusy")) {
    look.busy = false;
    look.name = `${look.name}-nobusy`;
  } else if (fragment.includes("busy") && canGoBusy(look)) {
    look.busy = true;
    look.name = `${look.name}-busy`;
  }
  if (fragment.includes("soft")) {
    look.sharpen = 0;
    look.name = `${look.name}-soft`;
  }
  if (fragment.includes("floor")) {
    look.floor = 1;
    look.name = `${look.name}-floor`;
  }
  if (fragment.includes("raw")) {
    look.raw = true;
    look.name = `${look.name}-raw`;
  }

  for (const flag of ["fine", "prep"]         ) {
    if (fragment.includes(`no${flag}`)) {
      look.name = `${look.name}-no${flag}`;
      continue;
    }
    look[flag] = true;
  }

  if (fragment.includes("nolz")) {
    look.name = `${look.name}-nolz`;
  } else if (look.dither === "none" || fragment.includes("lz")) {
    look.lz = true;
    if (look.dither !== "none") look.name = `${look.name}-lz`;
  }
  return look;
}

function newVideoLookState()                 {
  return { lo: null, hi: null, prev: null, lastAt: null, busy: false, busyAt: null };
}

const BUSY_HI_BYTES = 5_000;
const BUSY_LO_BYTES = 4_100;
const BUSY_HOLD_S = 1;
const BUSY_PX                   = [1, 2];

function lz4Bytes(packed            )         {
  const literals = (k        ) => 1 + k + (k >= 15 ? Math.floor((k - 15) / 255) + 1 : 0);
  const n = packed.length;
  const seen = new Map                ();
  let i = 0;
  let anchor = 0;
  let out = 0;
  while (i + 4 <= n - 5) {
    const key = ((packed[i] << 24) | (packed[i + 1] << 16) | (packed[i + 2] << 8) | packed[i + 3]) >>> 0;
    const cand = seen.get(key);
    seen.set(key, i);
    if (cand !== undefined && i - cand < 65535) {
      let m = 4;
      while (i + m < n - 5 && packed[cand + m] === packed[i + m]) m++;
      out += literals(i - anchor) + 2 + (m - 4 >= 15 ? Math.floor((m - 4 - 15) / 255) + 1 : 0);
      i += m;
      anchor = i;
    } else {
      i++;
    }
  }
  return out + literals(n - anchor);
}

function sharpness(gray            )         {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < VIDEO_H - 1; y += 2) {
    for (let x = 1; x < VIDEO_W - 1; x += 2) {
      const i = y * VIDEO_W + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - VIDEO_W] - gray[i + VIDEO_W];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  return s2 / n - (s / n) ** 2;
}

function isCut(a            , b                   )          {
  if (!b) return true;
  let s = 0;
  let n = 0;
  for (let y = 0; y < VIDEO_H; y += 8) {
    for (let x = 0; x < VIDEO_W; x += 8) {
      s += Math.abs(a[y * VIDEO_W + x] - b[y * VIDEO_W + x]);
      n++;
    }
  }
  return s / n > CUT_MEAN_DIFF;
}

function percentiles(v              )                   {
  const hist = new Uint32Array(256);
  for (let i = 0; i < v.length; i++) hist[Math.max(0, Math.min(255, Math.round(v[i])))]++;
  const loAt = v.length * 0.005;
  const hiAt = v.length * 0.995;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  let loSet = false;
  for (let k = 0; k < 256; k++) {
    acc += hist[k];
    if (!loSet && acc > loAt) {
      lo = k;
      loSet = true;
    }
    if (acc >= hiAt) {
      hi = k;
      break;
    }
  }
  return [lo, hi];
}

function shrinkToBox(gray            , bw        , bh        )               {
  const out = new Float64Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const y0 = Math.floor((y * VIDEO_H) / bh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * VIDEO_H) / bh));
    for (let x = 0; x < bw; x++) {
      const x0 = Math.floor((x * VIDEO_W) / bw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * VIDEO_W) / bw));
      let s = 0;
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) s += gray[j * VIDEO_W + i];
      out[y * bw + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function boxedPoster(gray            , look           )             {
  const [boxW, boxH] = look.box;
  if (boxW === VIDEO_W && boxH === VIDEO_H) return gray;
  const ox = Math.floor((VIDEO_W - boxW) / 2);
  const oy = Math.floor((VIDEO_H - boxH) / 2);
  const boxed = shrinkToBox(gray, boxW, boxH);
  const out = new Uint8Array(VIDEO_W * VIDEO_H);
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) out[(oy + y) * VIDEO_W + ox + x] = Math.round(boxed[y * boxW + x]);
  }
  return out;
}

function sharpened(v              , w        , h        , amount        )               {
  if (amount <= 0) return v;
  const out = new Float64Array(v.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let weights = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const weight = SHARPEN_KERNEL[(dy + 1) * 3 + dx + 1];
          sum += weight * v[yy * w + xx];
          weights += weight;
        }
      }
      const i = y * w + x;
      out[i] = Math.min(255, Math.max(0, v[i] + amount * (v[i] - sum / weights)));
    }
  }
  return out;
}

function canGoBusy(look           )          {
  return look.px[1] === 1 && look.dither === "none";
}

function videoFrameSize(look           )                   {
  return look.fit ? [look.box[0], look.box[1]] : [VIDEO_W, VIDEO_H];
}

function cellsOf(boxed              , box                  , px                  )                                            {
  const [boxW, boxH] = box;
  const [bx, by] = px;
  const w = Math.floor(boxW / bx);
  const h = Math.floor(boxH / by);
  const v = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) s += boxed[(y * by + j) * boxW + x * bx + i];
      v[y * w + x] = s / (bx * by);
    }
  }
  return { v, w, h };
}

function renderVideoFrame(gray            , at        , look           , state                )             {
  const [boxW, boxH] = look.box;
  const boxed = boxW === VIDEO_W && boxH === VIDEO_H ? Float64Array.from(gray) : shrinkToBox(gray, boxW, boxH);
  const small = cellsOf(boxed, look.box, look.px);
  const [plo, phi] = percentiles(small.v);
  const cut = state.lo === null || state.hi === null || isCut(gray, state.prev);
  if (cut || state.lo === null || state.hi === null) {
    state.lo = plo;
    state.hi = phi;
  } else {
    const dt = state.lastAt === null ? 1 / 12 : Math.max(1 / 12, at - state.lastAt);
    const alpha = 1 - Math.pow(1 - ALPHA_12, dt * 12);
    state.lo += alpha * (plo - state.lo);
    state.hi += alpha * (phi - state.hi);
  }
  state.prev = gray;
  state.lastAt = at;
  const levels = drawCells(small, look, state.lo, state.hi);
  if (!look.busy) return levels;

  const bytes = lz4Bytes(packLevels(levels));
  const want = state.busy ? bytes > BUSY_LO_BYTES : bytes > BUSY_HI_BYTES;
  const held = !cut && state.busyAt !== null && Math.abs(at - state.busyAt) < BUSY_HOLD_S;
  if (want !== state.busy && !held) {
    state.busy = want;
    state.busyAt = at;
  }
  if (!state.busy) return levels;
  const rows            = { ...look, px: BUSY_PX };
  return drawCells(cellsOf(boxed, look.box, BUSY_PX), rows, state.lo, state.hi);
}

function drawCells(small                                           , look           , lo        , hi        )             {
  const [bx, by] = look.px;
  const [boxW, boxH] = look.box;
  const ox = Math.floor((VIDEO_W - boxW) / 2);
  const oy = Math.floor((VIDEO_H - boxH) / 2);
  const [frameW, frameH] = videoFrameSize(look);
  const { w, h } = small;
  const fullGain = 255 / Math.max(1, hi - lo);
  const capped = fullGain > MAX_GAIN;
  const gain = capped ? MAX_GAIN : fullGain;
  const mid = (lo + hi) / 2;
  const toned = new Float64Array(w * h);
  for (let i = 0; i < toned.length; i++) {
    const s = capped ? (small.v[i] - mid) * gain + mid : (small.v[i] - lo) * gain;
    const v = Math.min(255, Math.max(0, s));
    toned[i] = v > 0 ? 255 * Math.pow(v / 255, GAMMA) : 0;
  }
  const sharp = sharpened(toned, w, h, look.sharpen);
  const cell = new Uint8Array(w * h);

  const exact = look.lz ? new Float64Array(w * h) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;

      const px = ox + x * bx;
      const py = oy + y * by;
      const t = look.dither === "bayer4" ? (BAYER4[(py & 3) * 4 + (px & 3)] + 0.5) / 16 - 0.5 : 0;
      const v = Math.min(15, Math.max(0, (sharp[i] / 255) * 15 + t));
      if (exact) exact[i] = v;
      let q = Math.round(v);
      if (q <= look.floor) q = 0;
      cell[i] = q;
    }
  }

  const fx = Math.floor((frameW - boxW) / 2);
  const fy = Math.floor((frameH - boxH) / 2);
  const levels = new Uint8Array(frameW * frameH);
  const truth = exact ? new Float64Array(frameW * frameH) : null;
  for (let y = 0; y < boxH; y++) {
    const cy = Math.min(h - 1, Math.floor(y / by));
    const row = (fy + y) * frameW + fx;
    for (let x = 0; x < boxW; x++) {
      const c = cy * w + Math.min(w - 1, Math.floor(x / bx));
      levels[row + x] = cell[c];
      if (truth && exact) truth[row + x] = exact[c];
    }
  }
  return truth ? lossyLz(levels, truth, look.box, [frameW, frameH]) : levels;
}

const LZ_SLACK = 0.85;
const LZ_MEAN_CAP = 0.2;
const LZ_MIN_RUN = 4;

function lzOffsets(frameW        )           {
  return [1, 2, frameW / 2, frameW, 4, (3 * frameW) / 2];
}

function lossyLz(
  levels            ,
  truth              ,
  box                  ,
  frame                   = [VIDEO_W, VIDEO_H],
)             {
  const [boxW, boxH] = box;
  const [frameW, frameH] = frame;
  const ox = Math.floor((frameW - boxW) / 2);
  const oy = Math.floor((frameH - boxH) / 2);
  const offsets = lzOffsets(frameW);
  const bytes = packLevels(levels);
  const dark = levels.map((v) => (v === 0 ? 1 : 0));
  for (let y = oy; y < oy + boxH; y++) {
    const end = Math.floor((y * frameW + ox + boxW) / 2);
    let p = Math.ceil((y * frameW + ox) / 2);
    while (p < end) {
      let best = 0;
      let bestFrom = 0;
      for (const back of offsets) {
        if (p - back < 0) continue;
        let run = 0;
        let sum = 0;
        while (p + run < end) {

          const src = bytes[p - back + (run % back)];
          const hi = src >> 4;
          const lo = src & 15;
          const x = 2 * (p + run);
          const e1 = hi - truth[x];
          const e2 = lo - truth[x + 1];
          if (Math.abs(e1) > LZ_SLACK || Math.abs(e2) > LZ_SLACK) break;
          if (Number(hi === 0) !== dark[x] || Number(lo === 0) !== dark[x + 1]) break;
          if (run + 1 >= LZ_MIN_RUN && Math.abs((sum + e1 + e2) / (2 * (run + 1))) > LZ_MEAN_CAP) break;
          sum += e1 + e2;
          run++;
        }
        if (run > best) {
          best = run;
          bestFrom = back;
        }
      }
      if (best >= LZ_MIN_RUN) {
        for (let q = 0; q < best; q++) bytes[p + q] = bytes[p + q - bestFrom];
        p += best;
      } else {
        p++;
      }
    }
  }
  const out = new Uint8Array(levels.length);
  for (let b = 0; b < bytes.length; b++) {
    out[2 * b] = bytes[b] >> 4;
    out[2 * b + 1] = bytes[b] & 15;
  }
  return out;
}

function packLevels(levels            )         {
  const out = Buffer.alloc(Math.ceil(levels.length / 2));
  for (let i = 0; i < levels.length; i += 2) out[i >> 1] = ((levels[i] & 15) << 4) | ((levels[i + 1] ?? 0) & 15);
  return out;
}

module.exports = { VIDEO_W, VIDEO_H, VIDEO_LOOKS, videoLookFor, newVideoLookState, lz4Bytes, sharpness, boxedPoster, canGoBusy, videoFrameSize, renderVideoFrame, lossyLz, packLevels };
