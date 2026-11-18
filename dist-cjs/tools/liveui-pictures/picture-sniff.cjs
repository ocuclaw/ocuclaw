const PICTURE_MAX_PIXELS = 16_000_000;

const UNSUPPORTED = { ok: false, code: "picture_type_unsupported" }         ;

function u16be(b            , i        )         {
  return (b[i] << 8) | b[i + 1];
}
function u16le(b            , i        )         {
  return b[i] | (b[i + 1] << 8);
}
function u32le(b            , i        )         {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}
function i32le(b            , i        )         {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
}
function u24le(b            , i        )         {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
}
function u32be(b            , i        )         {
  return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
}
function ascii(b            , i        , text        )          {
  if (i + text.length > b.length) return false;
  for (let k = 0; k < text.length; k++) {
    if (b[i + k] !== text.charCodeAt(k)) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngDims(b            )                   {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return undefined;

  if (b.length < 24 || !ascii(b, 12, "IHDR")) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegDims(b            )                   {
  if (b.length < 3 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return undefined;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;

    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i];
    i++;

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;

    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
    if (i + 2 > b.length) return null;
    const length = u16be(b, i);
    if (length < 2) return null;

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {

      if (length < 7 || i + 7 > b.length) return null;
      return { width: u16be(b, i + 5), height: u16be(b, i + 3) };
    }
    i += length;
  }
  return null;
}

function gifTableBytes(packed        )         {
  return packed & 0x80 ? 3 << ((packed & 0x07) + 1) : 0;
}

function skipSubBlocks(b            , i        )         {
  while (i < b.length && b[i] !== 0) i += b[i] + 1;
  return i + 1;
}

function gifDims(b            )                   {
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) return undefined;
  if (b.length < 13) return null;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  let frames = 0;
  let i = 13 + gifTableBytes(b[10]);
  while (i < b.length) {
    if (b[i] === 0x21) {

      i = skipSubBlocks(b, i + 2);
    } else if (b[i] === 0x2c && i + 10 <= b.length) {

      width = Math.max(width, u16le(b, i + 1) + u16le(b, i + 5));
      height = Math.max(height, u16le(b, i + 3) + u16le(b, i + 7));
      frames++;
      i = skipSubBlocks(b, i + 10 + gifTableBytes(b[i + 9]) + 1);
    } else {
      break;
    }
  }
  return frames > 0 ? { width, height } : null;
}

function webpDims(b            )                   {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return undefined;
  if (ascii(b, 12, "VP8 ")) {

    if (b.length < 30) return null;
    if ((b[20] & 0x01) !== 0) return null;
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {

    if (b.length < 25 || b[20] !== 0x2f) return null;
    const b0 = b[21];
    const b1 = b[22];
    const b2 = b[23];
    const b3 = b[24];
    return {
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }
  if (ascii(b, 12, "VP8X")) {

    if (b.length < 30) return null;
    return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return null;
}

const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

function bmpDims(b            )                   {
  if (!ascii(b, 0, "BM") || b.length < 18 || !BMP_HEADER_SIZES.has(u32le(b, 14))) return undefined;
  if (u32le(b, 14) === 12) return b.length < 26 ? null : { width: u16le(b, 18), height: u16le(b, 20) };

  if (b.length < 30 || u16le(b, 26) !== 1) return null;
  return { width: i32le(b, 18), height: Math.abs(i32le(b, 22)) };
}

const SNIFFERS                                                                                        = [
  { type: "png", mime: "image/png", dims: pngDims },
  { type: "jpeg", mime: "image/jpeg", dims: jpegDims },
  { type: "gif", mime: "image/gif", dims: gifDims },
  { type: "webp", mime: "image/webp", dims: webpDims },
  { type: "bmp", mime: "image/bmp", dims: bmpDims },
];

const PICTURE_SEEN = [
  "png",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "heic",
  "bmp",
  "tiff",
  "ico",
  "jxl",
  "video",
  "pdf",
  "html",
  "text",
  "unknown",
]         ;

function isPictureSeen(value         )                       {
  return typeof value === "string" && (PICTURE_SEEN                     ).includes(value);
}

const FTYP_MAX_BRANDS = 64;

function ftypBrands(b            )                  {
  if (b.length < 16 || !ascii(b, 4, "ftyp")) return null;
  const end = Math.min(b.length, Math.max(16, u32be(b, 0)), 16 + 4 * FTYP_MAX_BRANDS);
  const brands = [String.fromCharCode(b[8], b[9], b[10], b[11])];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]));
  return brands;
}

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "heif", "mif1", "msf1"]);

function startsWithBytes(b            , bytes          )          {
  return b.length >= bytes.length && bytes.every((v, i) => b[i] === v);
}

function markupRootName(head        )                {
  let i = 0;
  while (i < head.length) {
    if (/\s/.test(head[i])) {
      i++;
    } else if (head.startsWith("<?", i)) {
      const close = head.indexOf("?>", i + 2);
      if (close < 0) return null;
      i = close + 2;
    } else if (head.startsWith("<!--", i)) {
      const close = head.indexOf("-->", i + 4);
      if (close < 0) return null;
      i = close + 3;
    } else if (head.slice(i, i + 9).toLowerCase() === "<!doctype") {

      const stop = /[[>]/g;
      stop.lastIndex = i + 9;
      const hit = stop.exec(head);
      if (!hit) return null;
      if (hit[0] === ">") {
        i = hit.index + 1;
      } else {
        const subsetEnd = /\]\s*>/g;
        subsetEnd.lastIndex = hit.index + 1;
        const end = subsetEnd.exec(head);
        if (!end) return null;
        i = end.index + end[0].length;
      }
    } else {
      break;
    }
  }
  const name = /<([a-z][\w:-]*)/iy;
  name.lastIndex = i;
  const root = name.exec(head);
  return root ? root[1] : null;
}

function pictureLooksLike(bytes            )              {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return "unknown";
  const b = bytes;
  for (const sniffer of SNIFFERS) {
    if (sniffer.dims(b) !== undefined) return sniffer.type;
  }
  const brands = ftypBrands(b);
  if (brands) {
    if (brands.includes("avif") || brands.includes("avis")) return "avif";
    if (brands.some((brand) => HEIF_BRANDS.has(brand))) return "heic";
    return "video";
  }
  if (startsWithBytes(b, [0x1a, 0x45, 0xdf, 0xa3])) return "video";
  if (startsWithBytes(b, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(b, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (startsWithBytes(b, [0xff, 0x0a]) || startsWithBytes(b, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return "jxl";
  if (startsWithBytes(b, [0, 0, 1, 0]) || startsWithBytes(b, [0, 0, 2, 0])) return "ico";
  if (ascii(b, 0, "BM") && b.length >= 26) return "bmp";
  if (ascii(b, 0, "%PDF")) return "pdf";

  const start = startsWithBytes(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  const head = String.fromCharCode(...b.subarray(start, Math.min(b.length, start + 4096)));
  const root = markupRootName(head);
  if (root && /^(\w+:)?svg$/i.test(root)) return "svg";
  if (root && /^(html|head|body)$/i.test(root)) return "html";
  const sample = b.subarray(0, Math.min(b.length, 512));
  if (sample.every((v) => v >= 0x20 || v === 0x09 || v === 0x0a || v === 0x0d)) return "text";
  return "unknown";
}

function sniffPicture(bytes            )                     {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return UNSUPPORTED;
  for (const sniffer of SNIFFERS) {
    const dims = sniffer.dims(bytes);
    if (dims === undefined) continue;
    if (!dims || !(dims.width > 0) || !(dims.height > 0)) return UNSUPPORTED;
    if (dims.width * dims.height > PICTURE_MAX_PIXELS) return { ok: false, code: "picture_too_large" };
    return { ok: true, type: sniffer.type, mime: sniffer.mime, width: dims.width, height: dims.height };
  }
  return UNSUPPORTED;
}

module.exports = { PICTURE_MAX_PIXELS, PICTURE_SEEN, isPictureSeen, pictureLooksLike, sniffPicture };
