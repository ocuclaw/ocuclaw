const { computeCodeSpanRegions } = require("./code-span-regions.cjs");

const EMOJI_OPEN_RE = /<emoji:[^<>\s]+?>/g;
const EMOJI_CLOSE_RE = /<\/emoji>/g;
const PACE_OPEN_RE = /<(?:dwell|skim)>/g;
const PACE_CLOSE_RE = /<\/(?:dwell|skim)>/g;

const ALL_TAGS_RE = new RegExp(
  [
    EMOJI_OPEN_RE.source,
    EMOJI_CLOSE_RE.source,
    PACE_OPEN_RE.source,
    PACE_CLOSE_RE.source,
  ].join("|"),
  "g",
);

function stripAllTaggedSpans(text) {
  if (typeof text !== "string") return "";
  if (!text) return "";
  const codeRegions = computeCodeSpanRegions(text);
  if (codeRegions.length === 0) {
    return text.replace(ALL_TAGS_RE, "");
  }
  return text.replace(ALL_TAGS_RE, (match, offset) => {
    for (const [start, end] of codeRegions) {
      if (offset >= start && offset < end) return match;
    }
    return "";
  });
}

module.exports = { stripAllTaggedSpans };
