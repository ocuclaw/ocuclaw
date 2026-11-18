const { Buffer } = require("node:buffer");
const { fileURLToPath } = require("node:url");
const { GLASSES_UI_LIMITS } = require("../glasses-ui-limits.cjs");

const PICTURE_DATA_SOURCE_MAX_CHARS         = GLASSES_UI_LIMITS.imagePayloadBase64Max;

const ASSET_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DATA_BASE64_RE = /^data:[^,]*;base64,/i;

function classifyPictureSource(src        )                     {
  if (typeof src !== "string") return { kind: "invalid" };
  const value = src.trim();
  if (!value) return { kind: "invalid" };
  if (/^https?:\/\//i.test(value)) {
    let url     ;
    try {
      url = new URL(value);
    } catch {
      return { kind: "invalid" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "invalid" };
    if (url.username || url.password || !url.hostname) return { kind: "invalid" };
    return { kind: "url", url };
  }
  if (/^file:\/\//i.test(value)) {
    try {
      const filePath = fileURLToPath(new URL(value));
      return filePath.startsWith("/") ? { kind: "file", path: filePath } : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  }
  if (value.startsWith("/") || value.startsWith("~/")) return { kind: "file", path: value };
  if (DATA_BASE64_RE.test(value)) return { kind: "bytes", dataUrl: value };
  if (ASSET_NAME_RE.test(value)) return { kind: "asset", name: value };
  return { kind: "invalid" };
}

function dataPayload(dataUrl        )                {
  if (typeof dataUrl !== "string") return null;
  const value = dataUrl.trim();
  if (!DATA_BASE64_RE.test(value)) return null;
  return value.slice(value.indexOf(",") + 1);
}

function decodePictureDataUrl(
  src        ,
)                                                            {
  const payload = dataPayload(src);
  if (payload === null) return { ok: false, code: "picture_source_refused" };
  if (payload.length > PICTURE_DATA_SOURCE_MAX_CHARS) return { ok: false, code: "picture_too_large" };
  if (
    payload.length === 0 ||
    payload.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) ||
    (payload.includes("=") && payload.length % 4 !== 0)
  ) {
    return { ok: false, code: "picture_type_unsupported" };
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) return { ok: false, code: "picture_type_unsupported" };
  return { ok: true, bytes };
}

function originOf(url     )         {
  return `${url.protocol}//${url.host}`;
}

function describePictureSource(src        )

  {
  const source = classifyPictureSource(src);
  switch (source.kind) {
    case "url":
      return { kind: "url", host: originOf(source.url) };
    case "file":
      return { kind: "file", host: "file" };
    case "bytes":
      return { kind: "bytes", host: `bytes:${(dataPayload(source.dataUrl) || "").length}` };
    case "asset":
      return { kind: "asset", host: source.name };
    default:
      return { kind: "invalid", host: null };
  }
}

const DATA_URL_IN_TEXT_RE = /(?<![A-Za-z0-9])data:[^\s"'<>,]*,[^\s"'<>]*/gi;
const HTTP_URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s"'<>]*/gi;
const PICTURE_PATH_IN_TEXT_RE =
  /(?:file:\/\/|~\/|(?<![A-Za-z0-9_.~:/-])\/)[^\s"'<>]*\.(?:png|jpe?g|gif|webp)(?![A-Za-z0-9_])/gi;

function redactHttpUrl(match        )         {
  const head = /^(https?:)\/\/([^/?#\s]*)/i.exec(match);
  if (!head) return match;
  const scheme = head[1].toLowerCase();
  const authority = head[2];
  const at = authority.lastIndexOf("@");
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const clean = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.\-_~%]+)(:\d+)?/.exec(hostPort);
  return `${scheme}//${clean ? clean[0].toLowerCase() : ""}`;
}

function redactPictureText(text        )         {
  if (typeof text !== "string" || !text) return "";
  return text
    .replace(DATA_URL_IN_TEXT_RE, (match) => `bytes:${match.length - match.indexOf(",") - 1}`)
    .replace(HTTP_URL_IN_TEXT_RE, redactHttpUrl)
    .replace(PICTURE_PATH_IN_TEXT_RE, "file");
}

module.exports = { PICTURE_DATA_SOURCE_MAX_CHARS, classifyPictureSource, decodePictureDataUrl, describePictureSource, redactPictureText };
