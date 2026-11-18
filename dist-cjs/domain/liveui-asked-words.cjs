const LIVEUI_ASKED_RUNS_MAX = 64;

const LIVEUI_ASKED_WORDS_MAX_BYTES = 1000;

const utf8 = new TextEncoder();

function clampAskedWords(text         , max         = LIVEUI_ASKED_WORDS_MAX_BYTES)                {
  if (typeof text !== "string") return null;
  const words = text.trim();
  if (!words) return null;
  if (utf8.encode(words).length <= max) return words;
  const room = max - utf8.encode("…").length;
  let out = "";
  let used = 0;
  for (const ch of words) {
    const bytes = utf8.encode(ch).length;
    if (used + bytes > room) break;
    out += ch;
    used += bytes;
  }
  return `${out.trimEnd()}…`;
}

function createLiveUiAskedWordsStore(options                   = {})                        {
  const max = Number.isSafeInteger(options.max) && (options.max          ) > 0 ? (options.max          ) : LIVEUI_ASKED_RUNS_MAX;
  const byRun = new Map                ();
  return {
    noteRun(runId, text) {
      if (typeof runId !== "string" || !runId || byRun.has(runId)) return;
      const words = clampAskedWords(text);
      if (!words) return;
      byRun.set(runId, words);
      while (byRun.size > max) byRun.delete(byRun.keys().next().value          );
    },
    wordsFor(runId) {
      return typeof runId === "string" && runId ? byRun.get(runId) ?? null : null;
    },
    size: () => byRun.size,
  };
}

module.exports = { LIVEUI_ASKED_RUNS_MAX, LIVEUI_ASKED_WORDS_MAX_BYTES, clampAskedWords, createLiveUiAskedWordsStore };
