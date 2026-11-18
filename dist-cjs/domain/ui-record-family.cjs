const { computeCodeSpanRegions } = require("./code-span-regions.cjs");
const { parseTaggedSpans } = require("./tagged-span-parser.cjs");
const { stripAllTaggedSpans } = require("./tagged-span-strip.cjs");
const { LIVEUI_REGISTRY } = require("../tools/liveui-registry/index.cjs");
const { uiRecordsDrawNothing } = require("../tools/liveui-compiler/record-compiler.cjs");

const TAG = LIVEUI_REGISTRY.records.tag;
const OPEN = `<${TAG}`;
const CLOSE = `</${TAG}>`;
const PARTIAL_TAILS = Object.freeze(
  [OPEN, CLOSE.slice(0, -1)].flatMap((lit) =>
    Array.from({ length: lit.length - 1 }, (_, k) => lit.slice(0, k + 1)),
  ),
);

const UI_RECORD_FAMILY_NAME = TAG;

const UI_RECORD_REPLY_MAX_CHARS = LIVEUI_REGISTRY.budgets.recordChars;

const UI_RECORD_CHAT_LINE_PREFIX = "On glasses: ";

const FRAME_NAMES = new Set(LIVEUI_REGISTRY.frames.map((frame) => frame.name));
const BODYLESS_COMPONENTS = new Set(
  LIVEUI_REGISTRY.components.filter((c) => c.body === null).map((c) => c.name),
);
const FRAME_KIND = LIVEUI_REGISTRY.records.kinds.find((k) => k.kind === "frame");
const TITLE_MAX_CHARS =
  FRAME_KIND?.props.find((p) => p.name === "title")?.maxChars ?? 64;
const KIND_MARKERS = LIVEUI_REGISTRY.records.kinds.map((k) => ({
  kind: k.kind,
  marker: k.marker,
}));

                                                 

function isOpenAt(input        , at        )          {
  if (!input.startsWith(OPEN, at)) return false;
  const next = input[at + OPEN.length];
  return next === undefined || next === ">" || next === "/" || /\s/.test(next);
}

const SMART_DOUBLE = new Set(["“", "”"]);

function closesQuote(opener        , ch        )          {
  if (opener === "\"" || opener === "'") return ch === opener;
  return SMART_DOUBLE.has(ch) || ch === "\"";
}

function scanOpenTag(input        , at        )                     {
  let quote                = null;
  let afterEquals = false;
  let lastSignificant = "";
  for (let i = at + OPEN.length; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\n" || ch === "\r") {
      return { end: i, selfClose: false, broken: "open_tag_unterminated" };
    }
    if (quote) {
      if (closesQuote(quote, ch)) quote = null;
      continue;
    }
    if (ch === ">") {
      return { end: i + 1, selfClose: lastSignificant === "/", broken: null };
    }
    if (ch === "<") {
      return { end: i, selfClose: false, broken: "open_tag_unterminated" };
    }
    if (afterEquals && (ch === "\"" || ch === "'" || SMART_DOUBLE.has(ch))) {
      quote = ch;
      afterEquals = false;
      lastSignificant = ch;
      continue;
    }
    if (ch === "=") afterEquals = true;
    else if (!/\s/.test(ch)) afterEquals = false;
    if (!/\s/.test(ch)) lastSignificant = ch;
  }
  return null;
}

const ENTITIES                         = {
  "&quot;": "\"",
  "&apos;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

function decodeEntities(value        )         {
  return value.replace(/&(?:quot|apos|#39|lt|gt|amp);/g, (m) => ENTITIES[m]);
}

function parseUiAttributes(openTag        )

  {
  const repairs           = [];
  if (!openTag.startsWith(OPEN)) return { attrs: null, repairs };
  const s = openTag.slice(OPEN.length).replace(/\/?>\s*$/, "");
  const attrs                         = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;
    if (s[i] === "/" && s.slice(i + 1).trim() === "") break;
    const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(i));
    if (!name) return { attrs: null, repairs };
    i += name[0].length;
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (s[i] !== "=") {
      attrs[name[0]] = "";
      continue;
    }
    i += 1;
    while (i < s.length && /\s/.test(s[i])) i += 1;
    const q = s[i];
    if (q === "\"" || q === "'" || SMART_DOUBLE.has(q)) {
      let j = i + 1;
      while (j < s.length && !closesQuote(q, s[j])) j += 1;
      if (j >= s.length) return { attrs: null, repairs };
      if (q !== "\"" || s[j] !== "\"") pushOnce(repairs, "quotes_repaired");
      attrs[name[0]] = decodeEntities(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const bare = /^[^\s"'>]+/.exec(s.slice(i));
      if (!bare) return { attrs: null, repairs };
      pushOnce(repairs, "quotes_repaired");
      attrs[name[0]] = decodeEntities(bare[0]);
      i += bare[0].length;
    }
  }
  return { attrs, repairs };
}

function pushOnce(list          , code        )       {
  if (!list.includes(code)) list.push(code);
}

function uiRecordKind(attrs                               )                      {
  if (!attrs) return null;
  const present = KIND_MARKERS.filter(({ marker }) => Object.hasOwn(attrs, marker));
  return present.length === 1 ? (present[0].kind                ) : null;
}

function takesNoBody(kind                     , attrs                               )          {
  if (kind === "frame" || kind === "let") return true;
  return kind === "component" && !!attrs && BODYLESS_COMPONENTS.has(attrs.c);
}

function bodyRows(body               )           {
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function nextRecordOpen(input        , from        )         {
  let at = input.indexOf(OPEN, from);
  while (at !== -1 && !isOpenAt(input, at)) at = input.indexOf(OPEN, at + 1);
  return at;
}

function scanRecord(input        , at        , final         )                       {
  const open = scanOpenTag(input, at);
  if (!open) {
    if (!final) return null;
    return record(input, at, input.length, input.slice(at), null, true, [], "open_tag_unterminated");
  }
  const openTag = input.slice(at, open.end);
  if (open.broken) {
    return record(input, at, open.end, openTag, null, true, [], open.broken);
  }
  if (open.selfClose) return record(input, at, open.end, openTag, null, true, [], null);
  const { attrs } = parseUiAttributes(openTag);
  if (takesNoBody(uiRecordKind(attrs), attrs)) {
    return record(input, at, open.end, openTag, null, true, ["close_inserted"], null);
  }
  const close = input.indexOf(CLOSE, open.end);
  const nextOpen = nextRecordOpen(input, open.end);
  if (close !== -1 && (nextOpen === -1 || close < nextOpen)) {
    return record(input, at, close + CLOSE.length, openTag, input.slice(open.end, close), true, [], null);
  }
  if (nextOpen !== -1) {

    return record(input, at, nextOpen, openTag, input.slice(open.end, nextOpen), true, ["close_inserted"], null);
  }
  if (final) {
    return record(input, at, input.length, openTag, input.slice(open.end), true, ["close_inserted"], null);
  }
  return null;
}

function record(
  input        ,
  rawStart        ,
  rawEnd        ,
  openTag        ,
  body               ,
  closed         ,
  scanRepairs          ,
  broken               ,
)                {
  const parsed = broken ? { attrs: null, repairs: [] } : parseUiAttributes(openTag);
  return {
    rawStart,
    rawEnd,
    open: openTag,
    attrs: parsed.attrs,
    kind: uiRecordKind(parsed.attrs),
    body,
    rows: bodyRows(body),
    closed,
    repairs: [...scanRepairs, ...parsed.repairs],
    broken,
  };
}

function uiRecordChatLine(rec                                              )                {
  if (rec.kind !== "frame" || rec.dropped || !rec.attrs) return null;
  if (!FRAME_NAMES.has(rec.attrs.frame)) return null;
  const title = (rec.attrs.title || "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return UI_RECORD_CHAT_LINE_PREFIX + Array.from(title).slice(0, TITLE_MAX_CHARS).join("");
}

function codePoints(text        )         {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function inCodeRegion(offset        , regions                                      )          {
  for (const [start, end] of regions) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

function createUiRecordFamily({
  final = false,
  chatLine = true,
}                                          = {}) {
  let usedChars = 0;
  let capped = false;
  let chatLineDone = false;
  let trailing                                       = null;

  function admit(scanned               , input        )           {

    const src = scanned.attrs && typeof scanned.attrs.src === "string" ? scanned.attrs.src : "";
    const dataChars = /^\s*data:/i.test(src) ? codePoints(src) : 0;
    const chars = Math.max(0, codePoints(input.slice(scanned.rawStart, scanned.rawEnd)) - dataChars);
    if (!capped && usedChars + chars > UI_RECORD_REPLY_MAX_CHARS) capped = true;
    if (!capped) usedChars += chars;
    return { ...scanned, chars, dropped: capped ? "record_chars" : null };
  }

  return {
    name: TAG,
    record: true,
    closeLiterals: [CLOSE],

    matchOpen(input        , at        ) {
      if (!isOpenAt(input, at)) return null;
      const scanned = scanRecord(input, at, final);
      if (!scanned) return null;
      const rec = admit(scanned, input);
      let replacement = "";
      if (chatLine && !chatLineDone && rec.kind === "frame") {
        const line = uiRecordChatLine(rec);
        if (line) {
          replacement = line;
          chatLineDone = true;
        }
      }
      return { consumed: rec.rawEnd - at, spanInit: rec, replacement };
    },

    matchClose(input        , at        ) {

      return input.startsWith(CLOSE, at) ? { consumed: CLOSE.length, closeKind: TAG } : null;
    },

    closeMatches: () => false,

    matchTrailingPartial(input        ) {
      trailing = null;
      if (final || !input) return 0;
      const n = input.length;
      const regions = computeCodeSpanRegions(input);
      let at = input.lastIndexOf(OPEN);
      while (at !== -1 && (!isOpenAt(input, at) || inCodeRegion(at, regions))) {
        at = at === 0 ? -1 : input.lastIndexOf(OPEN, at - 1);
      }
      if (at !== -1 && !scanRecord(input, at, false)) {
        trailing = { input, at };
        return n - at;
      }
      for (let len = Math.min(n, OPEN.length + 2); len > 0; len -= 1) {
        if (PARTIAL_TAILS.includes(input.slice(n - len))) return len;
      }
      return 0;
    },

    trailingRecord()                  {
      if (!trailing) return null;
      const { input, at } = trailing;
      const open = scanOpenTag(input, at);
      if (!open || open.broken || open.selfClose) return null;
      const typed = input.slice(open.end);
      const lastNewline = typed.lastIndexOf("\n");
      const body = lastNewline === -1 ? "" : typed.slice(0, lastNewline + 1);
      const scanned = record(input, at, open.end + body.length, input.slice(at, open.end), body, false, [], null);
      return admit(scanned, input);
    },
  };
}

function parseUiRecords(
  text        ,
  { final = false, chatLine = true }                                          = {},
)

  {
  const parsed = parseTaggedSpans(text, [createUiRecordFamily({ final, chatLine })], { final });
  const spans = parsed.spansByFamily                            ;
  return {
    cleanText: parsed.cleanText,
    records: (spans[TAG] || [])                  ,
    trailingPartialTag: parsed.trailingPartialTag,
  };
}

function splitUiRecordSpans(spansByFamily                          )

  {
  const { [TAG]: records, ...spans } = spansByFamily;
  return { records: (records || [])                  , spansByFamily: spans };
}

function stripReplyMarkup(text         , { uiRecords = false }                          = {})         {
  if (!uiRecords || typeof text !== "string" || !text) return stripAllTaggedSpans(text);
  const parsed = parseUiRecords(text, { final: true });
  const chatLineAt = parsed.records.find((rec) => rec.end > rec.start);
  if (chatLineAt && uiRecordsDrawNothing(parsed.records)) {
    return stripAllTaggedSpans(parseUiRecords(text, { final: true, chatLine: false }).cleanText);
  }
  return stripAllTaggedSpans(parsed.cleanText);
}

function stripNoteRecords(text         )         {
  if (typeof text !== "string" || !text.includes("<")) return typeof text === "string" ? text : "";
  return parseTaggedSpans(text, [createUiRecordFamily({ chatLine: false })]).cleanText.trim();
}

module.exports = { UI_RECORD_FAMILY_NAME, UI_RECORD_REPLY_MAX_CHARS, UI_RECORD_CHAT_LINE_PREFIX, parseUiAttributes, uiRecordKind, uiRecordChatLine, createUiRecordFamily, parseUiRecords, splitUiRecordSpans, stripReplyMarkup, stripNoteRecords };
