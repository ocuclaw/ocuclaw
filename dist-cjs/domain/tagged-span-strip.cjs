const { computeCodeSpanRegions } = require("./code-span-regions.cjs");

const COMPLETE_NEURAL_TAG_SOURCE =
  String.raw`<\/?neural(?:(?::|\s)[^<>\r\n]*)?\s*\/?>`;
const PARTIAL_NEURAL_TAG_SOURCE =
  String.raw`<\/?neural(?=$|[:\s\/])[^<>\r\n]*(?=\r?\n|$)`;
const NEURAL_TAG_AT_RE = new RegExp(
  `^(?:${COMPLETE_NEURAL_TAG_SOURCE}|${PARTIAL_NEURAL_TAG_SOURCE})`,
  "iu",
);
const ALL_NEURAL_TAGS_RE = new RegExp(
  `${COMPLETE_NEURAL_TAG_SOURCE}|${PARTIAL_NEURAL_TAG_SOURCE}`,
  "giu",
);
const PARTIAL_PREFIXES = Object.freeze(["<neural", "</neural"]);

function offsetInsideCodeRegion(offset, codeRegions) {
  for (const [start, end] of codeRegions) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

function matchInvalidNeuralMarkupAt(input, at) {
  if (typeof input !== "string" || input[at] !== "<") return 0;
  const match = NEURAL_TAG_AT_RE.exec(input.slice(at));
  return match ? match[0].length : 0;
}

function matchTrailingInvalidNeuralMarkup(input) {
  if (typeof input !== "string" || !input) return 0;
  const lower = input.toLowerCase();
  let best = 0;

  for (const prefix of PARTIAL_PREFIXES) {
    for (let len = Math.min(input.length, prefix.length - 1); len > best; len -= 1) {
      if (prefix.startsWith(lower.slice(lower.length - len))) {
        best = len;
        break;
      }
    }
  }

  const lastOpen = input.lastIndexOf("<");
  if (lastOpen !== -1) {
    const tail = input.slice(lastOpen);
    if (
      !/[>\r\n]/.test(tail) &&
      /^<\/?neural(?=$|[:\s\/])/iu.test(tail)
    ) {
      best = Math.max(best, input.length - lastOpen);
    }
  }
  return best;
}

function stripInvalidNeuralMarkup(text) {
  if (typeof text !== "string") return "";
  if (!text) return "";
  const codeRegions = computeCodeSpanRegions(text);
  if (codeRegions.length === 0) {
    return text.replace(ALL_NEURAL_TAGS_RE, "");
  }
  return text.replace(ALL_NEURAL_TAGS_RE, (match, offset) =>
    offsetInsideCodeRegion(offset, codeRegions) ? match : "",
  );
}

const EMOJI_OPEN_RE = /<emoji(?::[^<>]*?)?>/gi;
const EMOJI_CLOSE_RE = /<\/emoji(?::[^<>]*)?(?:\s[^<>]*)?>/gi;
const PACE_OPEN_RE = /<(?:dwell|skim)(?:\s[^<>]*)?>/gi;
const PACE_CLOSE_RE = /<\/(?:dwell|skim)(?:\s[^<>]*)?>/gi;

const ALL_TAGS_RE = new RegExp(
  [
    EMOJI_OPEN_RE.source,
    EMOJI_CLOSE_RE.source,
    PACE_OPEN_RE.source,
    PACE_CLOSE_RE.source,
  ].join("|"),
  "gi",
);

function stripAllTaggedSpans(text) {
  if (typeof text !== "string") return "";
  if (!text) return "";
  const withoutInvalidNeural = stripInvalidNeuralMarkup(text);
  const codeRegions = computeCodeSpanRegions(withoutInvalidNeural);
  if (codeRegions.length === 0) {
    return withoutInvalidNeural.replace(ALL_TAGS_RE, "");
  }
  return withoutInvalidNeural.replace(ALL_TAGS_RE, (match, offset) => {
    for (const [start, end] of codeRegions) {
      if (offset >= start && offset < end) return match;
    }
    return "";
  });
}

module.exports = { matchInvalidNeuralMarkupAt, matchTrailingInvalidNeuralMarkup, stripInvalidNeuralMarkup, stripAllTaggedSpans };
