const PROGRAM_CARD_EDIT_RESENT_MIN_CHARS = 800;
const PROGRAM_CARD_EDIT_RESENT_MIN_SHARE = 0.5;

const LCS_MAX_LINES = 800;

function sharedLineChars(a        , b        ) {
  const x = a.split("\n");
  const y = b.split("\n");
  let start = 0;
  let kept = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) kept += x[start++].length + 1;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) kept += x[--endX].length + 1;
  const midX = x.slice(start, endX);
  const midY = y.slice(start, endY);
  if (!midX.length || !midY.length || midX.length > LCS_MAX_LINES || midY.length > LCS_MAX_LINES) return Math.min(kept, a.length, b.length);

  let prev = new Array(midY.length + 1).fill(0);
  for (let i = 1; i <= midX.length; i++) {
    const row = new Array(midY.length + 1).fill(0);
    for (let j = 1; j <= midY.length; j++) {
      row[j] = midX[i - 1] === midY[j - 1] ? prev[j - 1] + midX[i - 1].length + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return Math.min(kept + prev[midY.length], a.length, b.length);
}

function programCardEditShape(payload     , currentSource                ) {
  const edits = Array.isArray(payload?.edits) ? payload.edits : null;
  const source = typeof payload?.source === "string" ? payload.source : null;
  let findChars = 0;
  let replaceChars = 0;
  let resentChars = 0;
  if (edits) {
    for (const edit of edits) {
      const find = typeof edit?.find === "string" ? edit.find : "";
      const replace = typeof edit?.replace === "string" ? edit.replace : "";
      findChars += find.length;
      replaceChars += replace.length;

      resentChars += 2 * sharedLineChars(find, replace);
    }
  } else if (source !== null && typeof currentSource === "string" && currentSource) {
    resentChars = sharedLineChars(currentSource, source);
  }
  const sourceChars = source?.length ?? 0;
  const sentChars = findChars + replaceChars + sourceChars;
  return {
    mode: edits ? "edits" : source !== null ? "source" : "verdicts",
    edits: edits?.length ?? 0,
    findChars,
    replaceChars,
    sourceChars,
    sentChars,
    resentChars,

    resentShare: sentChars ? Math.floor((resentChars / sentChars) * 100) / 100 : 0,
  };
}

function programCardEditResentNext(shape                                         ) {
  if (shape.resentChars < PROGRAM_CARD_EDIT_RESENT_MIN_CHARS || shape.resentShare < PROGRAM_CARD_EDIT_RESENT_MIN_SHARE) return "";
  const share = Math.round(shape.resentShare * 100);
  const what = shape.mode === "source" ? "This edit resent the whole card" : "This edit's find and replace repeated unchanged lines";
  return `${what}: ${share}% of the ${shape.sentChars} characters it sent were code the card already had, and every character costs model time. ` +
    "Next time send only what changes: each find is the few lines being changed, just enough to be unique, and its replace is those lines changed. Several small edits in one call beat one large one.";
}

module.exports = { PROGRAM_CARD_EDIT_RESENT_MIN_CHARS, PROGRAM_CARD_EDIT_RESENT_MIN_SHARE, sharedLineChars, programCardEditShape, programCardEditResentNext };
