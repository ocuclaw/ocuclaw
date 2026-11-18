const { deflateSync } = require("node:zlib");

const JEV_IMAGE_MIN = 280;
const JEV_IMAGE_MAX = 1568;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes            , crc = 0xffffffff)         {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function chunk(type        , data            )         {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(data, crc32(head.subarray(4, 8))) ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(frame          , level = 3)         {
  const { rgb, w, h } = frame;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const out = y * (stride + 1);
    const row = y * stride;
    if (y === 0) {
      raw[out] = 0;
      raw.set(rgb.subarray(row, row + stride), out + 1);
      continue;
    }
    raw[out] = 2;
    const above = row - stride;
    for (let i = 0; i < stride; i++) raw[out + 1 + i] = (rgb[row + i] - rgb[above + i]) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const clampInt = (v        , lo        , hi        ) => Math.max(lo, Math.min(hi, Math.round(v)));

function outline(frame          , rects        , color                           = [255, 0, 0], thickness = 4)           {
  const rgb = new Uint8Array(frame.rgb);
  const { w, h } = frame;
  const paint = (x0        , y0        , x1        , y1        ) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const p = (y * w + x) * 3;
        rgb[p] = color[0]; rgb[p + 1] = color[1]; rgb[p + 2] = color[2];
      }
  };
  for (const r of rects) {
    const x0 = Math.round(r.x) - thickness, y0 = Math.round(r.y) - thickness;
    const x1 = Math.round(r.x + r.w) + thickness, y1 = Math.round(r.y + r.h) + thickness;
    paint(x0, y0, x1, y0 + thickness);
    paint(x0, y1 - thickness, x1, y1);
    paint(x0, y0, x0 + thickness, y1);
    paint(x1 - thickness, y0, x1, y1);
  }
  return { rgb, w, h };
}

function resample(frame          , crop      , outW        , outH        )           {
  const { rgb, w, h } = frame;
  const out = new Uint8Array(outW * outH * 3);
  const sx = crop.w / outW, sy = crop.h / outH;
  for (let oy = 0; oy < outH; oy++) {
    const fy = Math.min(h - 1, Math.max(0, crop.y + (oy + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let ox = 0; ox < outW; ox++) {
      const fx = Math.min(w - 1, Math.max(0, crop.x + (ox + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * w + x0) * 3, b = (y0 * w + x1) * 3, c = (y1 * w + x0) * 3, d = (y1 * w + x1) * 3;
      const o = (oy * outW + ox) * 3;
      for (let k = 0; k < 3; k++) {
        const top = rgb[a + k] + (rgb[b + k] - rgb[a + k]) * tx;
        const bottom = rgb[c + k] + (rgb[d + k] - rgb[c + k]) * tx;
        out[o + k] = Math.round(top + (bottom - top) * ty);
      }
    }
  }
  return { rgb: out, w: outW, h: outH };
}

function viewFor(crop      , maxScale = 1)              {
  if (!(crop.w > 0 && crop.h > 0)) return null;
  const scale = Math.min(maxScale, JEV_IMAGE_MAX / crop.w, JEV_IMAGE_MAX / crop.h);
  const w = Math.round(crop.w * scale), h = Math.round(crop.h * scale);
  if (w < JEV_IMAGE_MIN || h < JEV_IMAGE_MIN) return null;
  return { crop, scale, w, h };
}

function render(frame          , view      )           {
  const { crop } = view;
  if (view.scale === 1 && crop.x === 0 && crop.y === 0 && crop.w === frame.w && crop.h === frame.h) return frame;
  return resample(frame, crop, view.w, view.h);
}

function toFrame(box     , view      )              {
  const keys = ["left", "top", "right", "bottom"];
  if (!box || !keys.every(k => typeof box[k] === "number" && Number.isFinite(box[k]) && box[k] >= 0 && box[k] <= 1)) return null;
  if (!(box.left < box.right && box.top < box.bottom)) return null;
  const x0 = view.crop.x + box.left * view.crop.w, y0 = view.crop.y + box.top * view.crop.h;
  const x1 = view.crop.x + box.right * view.crop.w, y1 = view.crop.y + box.bottom * view.crop.h;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function zoomCrop(frame                          , center                          , factor = 2)       {
  const cw = Math.max(JEV_IMAGE_MIN, Math.round(frame.w / factor));
  const ch = Math.max(JEV_IMAGE_MIN, Math.round(frame.h / factor));
  const w = Math.min(frame.w, cw), h = Math.min(frame.h, ch);
  const x = clampInt(center.x - w / 2, 0, frame.w - w);
  const y = clampInt(center.y - h / 2, 0, frame.h - h);
  return { x, y, w, h };
}

module.exports = { JEV_IMAGE_MIN, JEV_IMAGE_MAX, encodePng, outline, resample, viewFor, render, toFrame, zoomCrop };
