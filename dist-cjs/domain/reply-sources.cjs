const { marked } = require("marked");

const MAX_REPLY_SOURCES = 8;
const REPLY_SOURCE_TITLE_MAX_CHARS = 80;
const REPLY_SOURCE_DOMAIN_MAX_CHARS = 64;
const REPLY_SOURCE_URL_MAX_CHARS = 2048;

function clip(text        , max        )         {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

function parseHttpUrl(raw         )             {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > REPLY_SOURCE_URL_MAX_CHARS) return null;
  let parsed     ;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  if (parsed.href.length > REPLY_SOURCE_URL_MAX_CHARS) return null;
  return parsed;
}

function domainOf(url     )         {
  return clip(url.hostname.toLowerCase().replace(/^www\./, ""), REPLY_SOURCE_DOMAIN_MAX_CHARS);
}

function pageKey(url     )         {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.hostname.toLowerCase().replace(/^www\./, "")}${path}${url.search}`;
}

function inlineText(tokens                   )         {
  if (!Array.isArray(tokens)) return "";
  let out = "";
  for (const token of tokens) {
    if (!token || typeof token !== "object") continue;
    if (token.type === "image" || token.type === "html") continue;
    if (Array.isArray(token.tokens)) out += inlineText(token.tokens);
    else if (typeof token.text === "string") out += token.text;
  }
  return out;
}

function collectLinks(tokens                   , into             )       {
  if (!Array.isArray(tokens)) return;
  for (const token of tokens) {
    if (!token || typeof token !== "object") continue;
    if (token.type === "code" || token.type === "codespan" || token.type === "html" || token.type === "image") continue;
    if (token.type === "link") {
      into.push({ href: token.href, text: inlineText(token.tokens) || token.text || "", title: typeof token.title === "string" ? token.title : "" });
      continue;
    }
    collectLinks(token.tokens, into);
    if (Array.isArray(token.items)) collectLinks(token.items, into);
    if (Array.isArray(token.header)) for (const cell of token.header) collectLinks(cell && cell.tokens, into);
    if (Array.isArray(token.rows)) {
      for (const row of token.rows) if (Array.isArray(row)) for (const cell of row) collectLinks(cell && cell.tokens, into);
    }
  }
}

function liftReplySources(markdown         )                {
  if (typeof markdown !== "string" || !/https?:\/\//i.test(markdown)) return [];
  let tokens     ;
  try {
    tokens = marked.lexer(markdown);
  } catch {
    return [];
  }
  const candidates              = [];
  collectLinks(tokens, candidates);
  const defs = tokens && tokens.links && typeof tokens.links === "object" ? tokens.links : {};
  for (const key of Object.keys(defs)) {
    const def = defs[key];
    if (def && typeof def.href === "string") candidates.push({ href: def.href, text: typeof def.title === "string" ? def.title : "" });
  }

  const out                = [];
  const seen = new Set        ();
  for (const candidate of candidates) {
    if (out.length >= MAX_REPLY_SOURCES) break;
    const url = parseHttpUrl(candidate.href);
    if (!url) continue;
    const key = pageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const domain = domainOf(url);
    const rawText = candidate.text.trim();

    const bare = !rawText || /^\d+$/.test(rawText) || !!parseHttpUrl(rawText) || rawText === candidate.href;
    const text = bare ? (candidate.title || "").trim() || domain : rawText;
    out.push({ url: url.href, title: clip(text, REPLY_SOURCE_TITLE_MAX_CHARS), domain });
  }
  return out;
}

const SUPERSCRIPT_DIGITS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

function replySourceMark(number        )         {
  return String(number).split("").map((digit) => SUPERSCRIPT_DIGITS[Number(digit)] ?? digit).join("");
}

function replySourceMarkFor(keys          , href         )         {
  const url = parseHttpUrl(href);
  if (!url) return "";
  const key = pageKey(url);
  let index = keys.indexOf(key);
  if (index < 0) {
    if (keys.length >= MAX_REPLY_SOURCES) return "";
    keys.push(key);
    index = keys.length - 1;
  }
  return replySourceMark(index + 1);
}

module.exports = { MAX_REPLY_SOURCES, REPLY_SOURCE_TITLE_MAX_CHARS, REPLY_SOURCE_DOMAIN_MAX_CHARS, REPLY_SOURCE_URL_MAX_CHARS, liftReplySources, replySourceMark, replySourceMarkFor };
