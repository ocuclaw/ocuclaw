const { computeCodeSpanRegions } = require("./code-span-regions.cjs");
const { matchInvalidNeuralMarkupAt, matchTrailingInvalidNeuralMarkup } = require("./tagged-span-strip.cjs");

function parseTaggedSpans(accumulatedText, families, options                      = {}) {
  const spansByFamily                           = {};
  const activeOpens = new Map();
  for (const fam of families) spansByFamily[fam.name] = [];

  let holdback = 0;
  if (!options.final) {
    for (const fam of families) {
      const vote = fam.matchTrailingPartial(accumulatedText, 0);
      if (vote > holdback) holdback = vote;
    }
    const invalidNeuralVote = matchTrailingInvalidNeuralMarkup(accumulatedText);
    if (invalidNeuralVote > holdback) holdback = invalidNeuralVote;
  }
  const scanEnd = accumulatedText.length - holdback;

  const codeRegions = computeCodeSpanRegions(accumulatedText);
  let codeRegionIdx = 0;

  let cleanText = "";
  let i = 0;
  const n = scanEnd;

  const ownLineEnd = (from        ) => {
    if (cleanText.length > 0 && !cleanText.endsWith("\n")) return from;
    let j = from;
    while (j < n && (accumulatedText[j] === " " || accumulatedText[j] === "\t")) j += 1;
    if (j < n && accumulatedText[j] === "\r") j += 1;
    return j < n && accumulatedText[j] === "\n" ? j + 1 : from;
  };

  outer: while (i < n) {
    while (
      codeRegionIdx < codeRegions.length &&
      i >= codeRegions[codeRegionIdx][1]
    ) {
      codeRegionIdx += 1;
    }
    if (
      codeRegionIdx < codeRegions.length &&
      i >= codeRegions[codeRegionIdx][0] &&
      i < codeRegions[codeRegionIdx][1]
    ) {

      const regionEnd = Math.min(codeRegions[codeRegionIdx][1], n);
      cleanText += accumulatedText.slice(i, regionEnd);
      i = regionEnd;
      continue;
    }
    if (accumulatedText[i] !== "<") {

      let runEnd = accumulatedText.indexOf("<", i + 1);
      if (runEnd === -1 || runEnd > n) runEnd = n;
      if (codeRegionIdx < codeRegions.length && codeRegions[codeRegionIdx][0] < runEnd) {
        runEnd = codeRegions[codeRegionIdx][0];
      }
      cleanText += accumulatedText.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    if (accumulatedText[i] === "<") {

      for (const fam of families) {
        const close = fam.matchClose(accumulatedText, i);
        if (close) {
          const active = activeOpens.get(fam.name);
          if (active && fam.closeMatches(active.init, close.closeKind)) {
            spansByFamily[fam.name].push({
              ...active.init,
              start: active.start,
              end: cleanText.length,
            });
            activeOpens.delete(fam.name);
          }

          i = fam.record ? ownLineEnd(i + close.consumed) : i + close.consumed;
          continue outer;
        }
      }
      for (const fam of families) {
        const open = fam.matchOpen(accumulatedText, i);
        if (open && fam.record) {
          const replacement = typeof open.replacement === "string" ? open.replacement : "";
          let next = i + open.consumed;
          if (replacement) {
            if (cleanText.length > 0 && !cleanText.endsWith("\n")) cleanText += "\n";
          } else {
            next = ownLineEnd(next);
          }
          const start = cleanText.length;
          cleanText += replacement;
          spansByFamily[fam.name].push({ ...open.spanInit, start, end: cleanText.length });
          if (replacement && next < n && accumulatedText[next] !== "\n" && accumulatedText[next] !== "\r") {
            cleanText += "\n";
          }
          i = next;
          continue outer;
        }
        if (open) {

          const prior = activeOpens.get(fam.name);
          if (prior) {
            spansByFamily[fam.name].push({
              ...prior.init,
              start: prior.start,
              end: cleanText.length,
            });
            activeOpens.delete(fam.name);
          }
          const accepted = fam.validateOpen ? fam.validateOpen(open.spanInit) : true;
          if (accepted) {
            activeOpens.set(fam.name, { start: cleanText.length, init: open.spanInit });
          } else if (fam.onRejected) {
            fam.onRejected(open.spanInit);
          }
          i += open.consumed;
          continue outer;
        }
      }
      const invalidNeuralLength = matchInvalidNeuralMarkupAt(accumulatedText, i);
      if (invalidNeuralLength > 0) {
        i += invalidNeuralLength;
        continue outer;
      }
    }
    cleanText += accumulatedText[i];
    i += 1;
  }

  for (const fam of families) {
    const active = activeOpens.get(fam.name);
    if (active) {
      spansByFamily[fam.name].push({
        ...active.init,
        start: active.start,
        end: cleanText.length,
      });
      activeOpens.delete(fam.name);
    }
    if (fam.record && holdback > 0 && typeof fam.trailingRecord === "function") {
      const trailing = fam.trailingRecord();
      if (trailing) {
        spansByFamily[fam.name].push({
          ...trailing,
          start: cleanText.length,
          end: cleanText.length,
        });
      }
    }
  }

  return { cleanText, spansByFamily, trailingPartialTag: holdback > 0 };
}

module.exports = { parseTaggedSpans };
