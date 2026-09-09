const { MESSAGE_EMOJI_ALLOWLIST_SET } = require("./message-emoji-allowlist.cjs");

const OPEN_PREFIX = "<emoji:";
const CLOSE_TAG = "</emoji>";
const CLOSE_LITERALS = Object.freeze(["</emoji>"]);

const EMOJI_TAG_FAMILY_CONFIG = {
  name: "emoji",
  closeLiterals: CLOSE_LITERALS,

  matchOpen(input, at) {
    if (!input.startsWith(OPEN_PREFIX, at)) return null;
    const closeIdx = input.indexOf(">", at + OPEN_PREFIX.length);
    if (closeIdx === -1) return null;
    const rawEmoji = input.slice(at + OPEN_PREFIX.length, closeIdx);
    return {
      consumed: closeIdx - at + 1,
      spanInit: { emoji: rawEmoji },
    };
  },

  matchClose(input, at) {
    if (!input.startsWith(CLOSE_TAG, at)) return null;
    return { consumed: CLOSE_TAG.length, closeKind: "emoji" };
  },

  closeMatches(_activeOpen, _closeKind) {
    return true;
  },

  validateOpen(spanInit) {
    return MESSAGE_EMOJI_ALLOWLIST_SET.has(spanInit.emoji);
  },

  matchTrailingPartial(input, _suffixStart) {
    const n = input.length;

    for (let len = Math.min(n, OPEN_PREFIX.length - 1); len > 0; len--) {
      const tail = input.slice(n - len);
      if (OPEN_PREFIX.startsWith(tail)) return len;
    }

    const lastOpen = input.lastIndexOf(OPEN_PREFIX);
    if (lastOpen !== -1) {
      const after = input.indexOf(">", lastOpen + OPEN_PREFIX.length);
      if (after === -1) return n - lastOpen;
    }

    for (let len = Math.min(n, CLOSE_TAG.length - 1); len > 0; len--) {
      const tail = input.slice(n - len);
      if (CLOSE_TAG.startsWith(tail)) return len;
    }
    return 0;
  },
};

module.exports = { EMOJI_TAG_FAMILY_CONFIG };
