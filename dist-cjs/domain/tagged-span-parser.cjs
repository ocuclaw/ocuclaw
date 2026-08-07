const { computeCodeSpanRegions } = require("./code-span-regions.cjs");

function parseTaggedSpans(accumulatedText, families) {
  const spansByFamily = {};
  const activeOpens = new Map();
  for (const fam of families) spansByFamily[fam.name] = [];

  let holdback = 0;
  for (const fam of families) {
    const vote = fam.matchTrailingPartial(accumulatedText, 0);
    if (vote > holdback) holdback = vote;
  }
  const scanEnd = accumulatedText.length - holdback;

  const codeRegions = computeCodeSpanRegions(accumulatedText);
  let codeRegionIdx = 0;

  let cleanText = "";
  let i = 0;
  const n = scanEnd;

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
      cleanText += accumulatedText[i];
      i += 1;
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

          i += close.consumed;
          continue outer;
        }
      }
      for (const fam of families) {
        const open = fam.matchOpen(accumulatedText, i);
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
  }

  return { cleanText, spansByFamily, trailingPartialTag: holdback > 0 };
}

module.exports = { parseTaggedSpans };
