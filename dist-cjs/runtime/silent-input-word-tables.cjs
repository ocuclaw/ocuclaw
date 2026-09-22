const { SILENT_INPUT_PACKED_PAIRS, SILENT_INPUT_PACKED_SCORES, SILENT_INPUT_PAIR_STEPS, SILENT_INPUT_SCORE_STEPS, SILENT_INPUT_TABLES_VERSION, SILENT_INPUT_WORDS_RAW } = require("./silent-input-word-tables.generated.cjs");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const VALUE_OF = buildValueTable();

function buildValueTable() {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
}

function valueOfLevel(level, steps) {
  return Math.pow(2, level / steps);
}

function createReader(text) {
  const stream = String(text || "");
  let at = 0;
  function skipBreaks() {
    while (at < stream.length && VALUE_OF[stream.charCodeAt(at)] === -1) at += 1;
  }
  return {
    get done() {
      skipBreaks();
      return at >= stream.length;
    },

    number() {
      let value = 0;
      let scale = 1;
      for (;;) {
        skipBreaks();
        const bits = VALUE_OF[stream.charCodeAt(at)];
        at += 1;
        if (bits === undefined || bits === -1) throw new Error(`silent-input tables: bad character at ${at - 1}`);
        value += (bits & 31) * scale;
        if (!(bits & 32)) return value;
        scale *= 32;
      }
    },

    level() {
      skipBreaks();
      const level = VALUE_OF[stream.charCodeAt(at)];
      at += 1;
      if (level === undefined || level === -1) throw new Error(`silent-input tables: bad level at ${at - 1}`);
      return level;
    },
  };
}

function decodePairs(packed, wordCount) {
  const reader = createReader(packed);
  const prevIds = [];
  const rowStarts = [];
  const followerWords = [];
  const probabilities = [];
  let prevId = 0;
  while (!reader.done) {
    prevId += reader.number();
    const count = reader.number();
    prevIds.push(prevId);
    rowStarts.push(followerWords.length);
    let wordIndex = -1;
    for (let i = 0; i < count; i += 1) {
      wordIndex += reader.number();
      const ppm = valueOfLevel(reader.level(), SILENT_INPUT_PAIR_STEPS);
      if (wordIndex < 0 || wordIndex >= wordCount) throw new Error("silent-input tables: follower outside the word list");
      followerWords.push(wordIndex);

      probabilities.push(ppm / 1e6);
    }
  }
  rowStarts.push(followerWords.length);
  return {
    prevIds: Int32Array.from(prevIds),
    rowStarts: Int32Array.from(rowStarts),
    followerWords: Int32Array.from(followerWords),
    probabilities: Float64Array.from(probabilities),
  };
}

function decodeScores(packed) {
  const reader = createReader(packed);
  const out = [];
  while (!reader.done) {

    out.push(valueOfLevel(reader.level(), SILENT_INPUT_SCORE_STEPS) / 1e9);
  }
  return Float64Array.from(out);
}

function decodeSilentInputTables(sources) {
  const s = sources && typeof sources === "object" ? sources : {};
  const words = String(s.wordsRaw || "").split(/\s+/).filter((w) => w.length > 0);
  const keys = words.map((w) => w.toLowerCase());
  const indexOfKey = new Map();

  for (let i = 0; i < keys.length; i += 1) if (!indexOfKey.has(keys[i])) indexOfKey.set(keys[i], i);
  const scores = decodeScores(s.packedScores || "");
  const pairs = decodePairs(s.packedPairs || "", words.length);
  return {
    version: String(s.version || ""),
    words,
    keys,
    indexOfKey,
    scores,
    pairs,

    rowOf(prevId) {
      const ids = pairs.prevIds;
      let low = 0;
      let high = ids.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (ids[mid] === prevId) return mid;
        if (ids[mid] < prevId) low = mid + 1;
        else high = mid - 1;
      }
      return -1;
    },

    prevIdOfKey(key) {
      const index = indexOfKey.get(String(key || "").toLowerCase());
      return index === undefined ? -1 : index + 1;
    },
  };
}

let cached = null;

function silentInputTables() {
  if (!cached) {
    cached = decodeSilentInputTables({
      version: SILENT_INPUT_TABLES_VERSION,
      wordsRaw: SILENT_INPUT_WORDS_RAW,
      packedScores: SILENT_INPUT_PACKED_SCORES,
      packedPairs: SILENT_INPUT_PACKED_PAIRS,
    });
  }
  return cached;
}

module.exports = { decodeSilentInputTables, silentInputTables };
