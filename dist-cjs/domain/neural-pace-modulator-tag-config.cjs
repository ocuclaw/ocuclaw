const OPEN_DWELL = "<dwell>";
const OPEN_SKIM = "<skim>";
const CLOSE_DWELL = "</dwell>";
const CLOSE_SKIM = "</skim>";
const OPEN_LITERALS = Object.freeze([OPEN_DWELL, OPEN_SKIM]);
const CLOSE_LITERALS = Object.freeze([CLOSE_DWELL, CLOSE_SKIM]);
const ALL_LITERALS = Object.freeze([...OPEN_LITERALS, ...CLOSE_LITERALS]);

const PACE_TAG_FAMILY_CONFIG = {
  name: "pace",
  closeLiterals: CLOSE_LITERALS,

  matchOpen(input, at) {
    if (input.startsWith(OPEN_DWELL, at)) {
      return { consumed: OPEN_DWELL.length, spanInit: { mode: "dwell" } };
    }
    if (input.startsWith(OPEN_SKIM, at)) {
      return { consumed: OPEN_SKIM.length, spanInit: { mode: "skim" } };
    }
    return null;
  },

  matchClose(input, at) {
    if (input.startsWith(CLOSE_DWELL, at)) {
      return { consumed: CLOSE_DWELL.length, closeKind: "dwell" };
    }
    if (input.startsWith(CLOSE_SKIM, at)) {
      return { consumed: CLOSE_SKIM.length, closeKind: "skim" };
    }
    return null;
  },

  closeMatches(activeOpen, closeKind) {
    return activeOpen.mode === closeKind;
  },

  matchTrailingPartial(input, _suffixStart) {
    const n = input.length;
    let best = 0;
    for (const lit of ALL_LITERALS) {
      for (let len = Math.min(n, lit.length - 1); len > best; len--) {
        const tail = input.slice(n - len);
        if (lit.startsWith(tail)) {
          best = len;
          break;
        }
      }
    }
    return best;
  },
};

module.exports = { PACE_TAG_FAMILY_CONFIG };
