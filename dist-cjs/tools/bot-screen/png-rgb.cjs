const { deflateSync } = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable                     = null;

function table()              {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

function crc32(bytes            , start = 0, end = bytes.length)         {
  const t = table();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type        , data            )         {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function encodePngRgb(rgb            , w        , h        )         {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || rgb.length !== w * h * 3) {
    throw new Error("png: bad size");
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    const s = y * stride;
    raw[o] = 1;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (rgb[s + i] - (i >= 3 ? rgb[s + i - 3] : 0)) & 0xff;
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 4 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

module.exports = { crc32, encodePngRgb };
