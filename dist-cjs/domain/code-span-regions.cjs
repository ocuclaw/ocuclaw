function computeCodeSpanRegions(text) {
  if (typeof text !== "string" || !text) return [];
  const n = text.length;
  const regions = [];

  const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  let fence = null;
  let lineStart = 0;
  while (lineStart < n) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? n : nl;
    const line = text.slice(lineStart, lineEnd);
    if (!fence) {
      const open = FENCE_OPEN_RE.exec(line);

      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = { char: open[1][0], len: open[1].length, start: lineStart };
      }
    } else {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        regions.push([fence.start, nl === -1 ? n : nl + 1]);
        fence = null;
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (fence) regions.push([fence.start, n]);

  const inFence = (pos) => {
    for (const [s, e] of regions) {
      if (pos >= s && pos < e) return true;
    }
    return false;
  };

  let i = 0;
  while (i < n) {
    if (text[i] !== "`" || inFence(i)) {
      i += 1;
      continue;
    }
    let runEnd = i;
    while (runEnd < n && text[runEnd] === "`") runEnd += 1;
    const runLen = runEnd - i;

    let close = -1;
    let k = runEnd;
    scan: while (k < n) {
      const ch = text[k];
      if (ch === "`" && !inFence(k)) {
        let ke = k;
        while (ke < n && text[ke] === "`") ke += 1;
        if (ke - k === runLen) {
          close = k;
          break;
        }
        k = ke;
        continue;
      }
      if (ch === "\n") {

        let p = k + 1;
        while (p < n && (text[p] === " " || text[p] === "\t")) p += 1;
        if (p < n && text[p] === "\n") break scan;
      }
      k += 1;
    }

    if (close === -1) {

      i = runEnd;
      continue;
    }
    regions.push([i, close + runLen]);
    i = close + runLen;
  }

  regions.sort((a, b) => a[0] - b[0]);
  return regions;
}

module.exports = { computeCodeSpanRegions };
