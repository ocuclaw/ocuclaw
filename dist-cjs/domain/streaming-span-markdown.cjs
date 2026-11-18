const { protectSpeckMarkers, restoreSpeckMarkers } = require("./speck-marker.cjs");

const SPAN_START_MARK = "\x01";
const SPAN_END_MARK = "\x02";
const EXACT_BEAT_MARKER = "<beat/>";

const BEAT_MARKER_SENTINEL = "\uE000".repeat(EXACT_BEAT_MARKER.length);

function protectPointMarkers(text        ) {
  const beatsProtected = text.includes(EXACT_BEAT_MARKER)
    ? text.replaceAll(EXACT_BEAT_MARKER, BEAT_MARKER_SENTINEL)
    : text;
  return protectSpeckMarkers(beatsProtected);
}

const POINT_SENTINEL_RE = /[\uE000\uE100-\uE17F]/;

function restorePointMarkers(text        ) {
  if (!POINT_SENTINEL_RE.test(text)) return text;
  return restoreSpeckMarkers(text.replaceAll(BEAT_MARKER_SENTINEL, EXACT_BEAT_MARKER));
}

const SPAN_MARK_RE = /[\x01\x02]/g;

const STREAM_MARKDOWN_CACHE = {};
const STREAM_MARKDOWN_OPTIONS = { stripReplyTags: true, numberLinks: true, prefixCache: STREAM_MARKDOWN_CACHE };

function applyMarkdownWithSpans(parsed, prefix, conversationState) {
  const { cleanText, spansByFamily } = parsed;
  const markdownInput = protectPointMarkers(cleanText);
  const familyNames = Object.keys(spansByFamily);
  const totalSpans = familyNames.reduce(
    (sum, name) => sum + spansByFamily[name].length,
    0,
  );
  if (totalSpans === 0) {
    const { text } = conversationState._markdownToPlainText(
      markdownInput,
      STREAM_MARKDOWN_OPTIONS,
    );
    const empty = {};
    for (const name of familyNames) empty[name] = [];
    return {
      text: `${prefix}${restorePointMarkers(text)}`,
      spansByFamily: empty,
    };
  }

  const events = [];
  for (const family of familyNames) {
    const spans = spansByFamily[family];
    for (let i = 0; i < spans.length; i++) {
      events.push({ offset: spans[i].start, family, spanIndex: i, isEnd: false });
      events.push({ offset: spans[i].end, family, spanIndex: i, isEnd: true });
    }
  }
  events.sort((a, b) => a.offset - b.offset || (a.isEnd ? 1 : -1));

  let markedText = "";
  let cursor = 0;
  for (const ev of events) {
    markedText += markdownInput.slice(cursor, ev.offset);
    cursor = ev.offset;
    markedText += ev.isEnd ? SPAN_END_MARK : SPAN_START_MARK;
  }
  markedText += markdownInput.slice(cursor);

  const { text: rawPost } = conversationState._markdownToPlainText(
    markedText,
    STREAM_MARKDOWN_OPTIONS,
  );

  const eventPostPositions = [];
  let stripped = "";
  let from = 0;
  SPAN_MARK_RE.lastIndex = 0;
  for (let mark = SPAN_MARK_RE.exec(rawPost); mark; mark = SPAN_MARK_RE.exec(rawPost)) {
    stripped += rawPost.slice(from, mark.index);
    eventPostPositions.push(stripped.length);
    from = mark.index + 1;
  }
  stripped += rawPost.slice(from);

  const prefixLen = prefix.length;
  const result = {};
  for (const family of familyNames) {
    result[family] = spansByFamily[family].map((s) => ({ ...s }));
  }
  for (let k = 0; k < events.length; k++) {
    const ev = events[k];
    const postPos = eventPostPositions[k] != null ? eventPostPositions[k] : 0;
    const target = result[ev.family][ev.spanIndex];
    if (!target) continue;
    if (ev.isEnd) target.end = prefixLen + postPos;
    else target.start = prefixLen + postPos;
  }

  return {
    text: `${prefix}${restorePointMarkers(stripped)}`,
    spansByFamily: result,
  };
}

module.exports = { applyMarkdownWithSpans };
