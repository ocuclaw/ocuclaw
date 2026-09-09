const SPAN_START_MARK = "\x01";
const SPAN_END_MARK = "\x02";
const EXACT_BEAT_MARKER = "<beat/>";

const BEAT_MARKER_SENTINEL = "\uE000".repeat(EXACT_BEAT_MARKER.length);

function applyMarkdownWithSpans(parsed, prefix, conversationState) {
  const { cleanText, spansByFamily } = parsed;
  const markdownInput = cleanText.replaceAll(EXACT_BEAT_MARKER, BEAT_MARKER_SENTINEL);
  const familyNames = Object.keys(spansByFamily);
  const totalSpans = familyNames.reduce(
    (sum, name) => sum + spansByFamily[name].length,
    0,
  );
  if (totalSpans === 0) {
    const { text } = conversationState._markdownToPlainText(markdownInput, {
      stripReplyTags: true,
    });
    const empty = {};
    for (const name of familyNames) empty[name] = [];
    return {
      text: `${prefix}${text.replaceAll(BEAT_MARKER_SENTINEL, EXACT_BEAT_MARKER)}`,
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

  const { text: rawPost } = conversationState._markdownToPlainText(markedText, {
    stripReplyTags: true,
  });

  const eventPostPositions = [];
  let stripped = "";
  for (let j = 0; j < rawPost.length; j++) {
    const ch = rawPost[j];
    if (ch === SPAN_START_MARK || ch === SPAN_END_MARK) {
      eventPostPositions.push(stripped.length);
    } else {
      stripped += ch;
    }
  }

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
    text: `${prefix}${stripped.replaceAll(BEAT_MARKER_SENTINEL, EXACT_BEAT_MARKER)}`,
    spansByFamily: result,
  };
}

module.exports = { applyMarkdownWithSpans };
