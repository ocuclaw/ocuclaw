const { classifyPictureSource } = require("../tools/liveui-pictures/picture-source.cjs");
const { GLASSES_UI_LIMITS } = require("../tools/glasses-ui-limits.cjs");

const PROGRAM_CARD_PICTURE_LIMITS = Object.freeze({
  pictures: 4,
  subChars: 128,
  urlChars: 2048,

  dataChars: GLASSES_UI_LIMITS.imagePayloadBase64Max,
});

const PROGRAM_CARD_PICTURE_SURFACE_PREFIX = "card:";
const programCardPictureSurfaceId = (sub        )         => `${PROGRAM_CARD_PICTURE_SURFACE_PREFIX}${sub}`;

const NAME_RE = /^[a-z][A-Za-z0-9_]{0,23}$/;

const TOKEN_RE = /^[^\s\p{C}]+$/u;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp|bmp);base64,/i;

const token = (value         , max        )         =>
  typeof value === "string" && value.length <= max && TOKEN_RE.test(value) ? value : "";

function sourceRefusal(src         )                                           {
  if (typeof src !== "string" || !src || src !== src.trim()) return "picture_source_refused";
  const source = classifyPictureSource(src);
  if (source.kind === "url") return src.length <= PROGRAM_CARD_PICTURE_LIMITS.urlChars ? null : "picture_source_refused";
  if (source.kind === "bytes" && DATA_IMAGE_RE.test(src)) {
    return src.length - src.indexOf(",") - 1 <= PROGRAM_CARD_PICTURE_LIMITS.dataChars ? null : "picture_too_large";
  }
  return "picture_source_refused";
}

function admitProgramCardPictures(msg         )                             {
  const raw      = msg && typeof msg === "object" && !Array.isArray(msg) ? msg : {};
  if (raw.op !== "open" && raw.op !== "close") return { ok: false, reason: "bad_op" };
  const sub = token(raw.sub, PROGRAM_CARD_PICTURE_LIMITS.subChars);
  if (!sub) return { ok: false, reason: "bad_sub" };
  if (raw.op === "close") return { ok: true, op: "close", sub };
  const card = token(raw.card, PROGRAM_CARD_PICTURE_LIMITS.subChars);
  if (!card) return { ok: false, reason: "bad_card" };
  if (!Array.isArray(raw.pictures) || raw.pictures.length === 0) return { ok: false, reason: "no_pictures" };
  if (raw.pictures.length > PROGRAM_CARD_PICTURE_LIMITS.pictures) return { ok: false, reason: "too_many_pictures" };
  const pictures                       = [];
  const refused                              = [];
  const names = new Set        ();
  raw.pictures.forEach((entry     , index        ) => {
    const id = `p${index + 1}`;
    const rawName = entry && typeof entry === "object" && typeof entry.name === "string" ? entry.name : "";
    const name = NAME_RE.test(rawName) && !names.has(rawName) ? rawName : "";
    if (name) names.add(name);
    const code = name ? sourceRefusal(entry.src) : "picture_source_refused";
    if (code) refused.push({ id, name: name || id, code });
    else pictures.push({ id, name, src: entry.src });
  });
  return { ok: true, op: "open", sub, card, pictures, refused };
}

module.exports = { PROGRAM_CARD_PICTURE_LIMITS, PROGRAM_CARD_PICTURE_SURFACE_PREFIX, programCardPictureSurfaceId, admitProgramCardPictures };
