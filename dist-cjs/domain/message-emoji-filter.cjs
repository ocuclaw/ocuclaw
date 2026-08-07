const { MESSAGE_EMOJI_ALLOWLIST, MESSAGE_EMOJI_ALLOWLIST_SET, } = require("./message-emoji-allowlist.cjs");

const EMOJI_CLUSTER_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const NON_ASCII_RE = /[^\x00-\x7F]/;
const RGI_EMOJI_SEQUENCE_RE = createOptionalRegex("^\\p{RGI_Emoji}$", "v");
const EMOJI_CLUSTER_FALLBACK_RE =
  /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u20E3\u{E0020}-\u{E007F}])/u;
const LEFTOVER_EMOJI_CONTROL_RE =
  /[\uFE0E\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu;

function createOptionalRegex(pattern, flags) {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function isEmojiCluster(segment) {
  if (!segment) return false;
  if (RGI_EMOJI_SEQUENCE_RE && RGI_EMOJI_SEQUENCE_RE.test(segment)) {
    return true;
  }
  return EMOJI_CLUSTER_FALLBACK_RE.test(segment);
}

function isHorizontalWhitespace(segment) {
  return /^[ \t]+$/.test(segment);
}

function isNewlineSegment(segment) {
  return /^(?:\r\n|\r|\n)$/.test(segment);
}

function shouldDropGapBeforePunctuation(
  nextSegment,
  beforeRemoved,
  afterRemoved,
  removedEmojiInGap,
) {
  return (
    removedEmojiInGap &&
    beforeRemoved.length > 0 &&
    afterRemoved.length === 0 &&
    /^[.,]$/.test(nextSegment)
  );
}

function emitGapForText(
  mode,
  beforeRemoved,
  afterRemoved,
  removedEmojiInGap,
  nextSegment,
) {
  const totalWhitespace = beforeRemoved + afterRemoved;
  if (!totalWhitespace) return "";
  if (
    shouldDropGapBeforePunctuation(
      nextSegment,
      beforeRemoved,
      afterRemoved,
      removedEmojiInGap,
    )
  ) {
    return "";
  }
  if (mode === "display") {
    return " ";
  }
  if (removedEmojiInGap) {
    return " ";
  }
  return totalWhitespace;
}

function emitGapForLineEnd(mode, beforeRemoved, afterRemoved, removedEmojiInGap) {
  if (mode === "display") {
    return "";
  }
  if (removedEmojiInGap) {
    return afterRemoved.length >= 2 ? afterRemoved : "";
  }
  return beforeRemoved + afterRemoved;
}

function emitGapForTextEnd(mode, beforeRemoved, afterRemoved, removedEmojiInGap) {
  if (mode === "display") {
    return "";
  }
  if (removedEmojiInGap) {
    return "";
  }
  return beforeRemoved + afterRemoved;
}

function filterAsciiDisplayFast(text) {

  return text
    .replace(/[ \t]+(\r\n|\r|\n)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+$/g, "");
}

function filterAsciiRawFast(text) {

  return text.replace(/[ \t]+$/g, "");
}

function filterEmojiText(text, mode) {
  if (!text) return "";

  const selectedMode = mode === "display" ? "display" : "raw";

  if (!NON_ASCII_RE.test(text)) {
    return selectedMode === "display"
      ? filterAsciiDisplayFast(text)
      : filterAsciiRawFast(text);
  }
  const out = [];
  let pendingWhitespaceBeforeRemoved = "";
  let pendingWhitespaceAfterRemoved = "";
  let removedEmojiInGap = false;

  function resetGap() {
    pendingWhitespaceBeforeRemoved = "";
    pendingWhitespaceAfterRemoved = "";
    removedEmojiInGap = false;
  }

  function flushGapForText(nextSegment) {
    const gap = emitGapForText(
      selectedMode,
      pendingWhitespaceBeforeRemoved,
      pendingWhitespaceAfterRemoved,
      removedEmojiInGap,
      nextSegment,
    );
    if (gap) out.push(gap);
    resetGap();
  }

  function flushGapForLineEnd() {
    const gap = emitGapForLineEnd(
      selectedMode,
      pendingWhitespaceBeforeRemoved,
      pendingWhitespaceAfterRemoved,
      removedEmojiInGap,
    );
    if (gap) out.push(gap);
    resetGap();
  }

  function flushGapForTextEnd() {
    const gap = emitGapForTextEnd(
      selectedMode,
      pendingWhitespaceBeforeRemoved,
      pendingWhitespaceAfterRemoved,
      removedEmojiInGap,
    );
    if (gap) out.push(gap);
    resetGap();
  }

  for (const part of EMOJI_CLUSTER_SEGMENTER.segment(text)) {
    const segment = part.segment;
    if (MESSAGE_EMOJI_ALLOWLIST_SET.has(segment)) {
      flushGapForText(segment);
      out.push(segment);
      continue;
    }
    if (isEmojiCluster(segment)) {
      removedEmojiInGap = true;
      continue;
    }

    const cleaned = segment.replace(LEFTOVER_EMOJI_CONTROL_RE, "");
    if (!cleaned) {
      continue;
    }
    if (isHorizontalWhitespace(cleaned)) {
      if (removedEmojiInGap) {
        pendingWhitespaceAfterRemoved += cleaned;
      } else {
        pendingWhitespaceBeforeRemoved += cleaned;
      }
      continue;
    }
    if (isNewlineSegment(cleaned)) {
      flushGapForLineEnd();
      out.push(cleaned);
      continue;
    }

    flushGapForText(cleaned);
    out.push(cleaned);
  }

  flushGapForTextEnd();

  if (selectedMode === "raw") {
    return out.join("").replace(/[ \t]+$/g, "");
  }
  return out.join("");
}

function filterDisplayEmojiText(text) {
  return filterEmojiText(text, "display");
}

function filterRawEmojiText(text) {
  return filterEmojiText(text, "raw");
}

module.exports = { MESSAGE_EMOJI_ALLOWLIST, MESSAGE_EMOJI_ALLOWLIST_SET, filterDisplayEmojiText, filterRawEmojiText };
