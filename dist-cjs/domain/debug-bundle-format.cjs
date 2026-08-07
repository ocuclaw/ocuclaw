function sanitizeCategoryFilename(cat) {
  return cat.replace(/\./g, "-") + ".jsonl";
}

function bucketEventsToFiles(input) {
  const { events, ringEvents, ringCapacity, appliedQuery, perCategoryBytesCap } = input;
  const byCategory = new Map();
  for (const evt of events) {
    if (!byCategory.has(evt.cat)) byCategory.set(evt.cat, []);
    byCategory.get(evt.cat).push(evt);
  }
  const files = new Map();
  const categories = [];
  let overallFrom = null;
  let overallTo = null;
  let totalBytes = 0;
  for (const [cat, list] of byCategory) {
    list.sort((a, b) => a.ts - b.ts || (a.seq || 0) - (b.seq || 0));
    const filename = sanitizeCategoryFilename(cat);
    const lines = [];
    const lineBytes = [];
    let bytes = 0;
    for (const evt of list) {
      const line = JSON.stringify(evt) + "\n";
      const serializedBytes = Buffer.byteLength(line, "utf8");
      lines.push(line);
      lineBytes.push(serializedBytes);
      bytes += serializedBytes;
    }
    let firstRetainedIndex = 0;
    if (typeof perCategoryBytesCap === "number" && perCategoryBytesCap > 0) {
      while (bytes > perCategoryBytesCap && firstRetainedIndex < lines.length - 1) {
        bytes -= lineBytes[firstRetainedIndex];
        firstRetainedIndex += 1;
      }
    }
    const retained = list.slice(firstRetainedIndex);
    const content = lines.slice(firstRetainedIndex).join("");
    files.set(filename, content);
    totalBytes += bytes;
    const fromMs = retained[0]?.ts ?? null;
    const toMs = retained[retained.length - 1]?.ts ?? null;
    if (fromMs !== null && (overallFrom === null || fromMs < overallFrom)) overallFrom = fromMs;
    if (toMs !== null && (overallTo === null || toMs > overallTo)) overallTo = toMs;
    categories.push({
      cat,
      count: retained.length,
      bytes,
      fromMs,
      toMs,
      file: filename,
      ...(firstRetainedIndex > 0 ? { bytesCapped: true, droppedOldestRecords: firstRetainedIndex } : {}),
    });
  }
  const summary = {
    ringEvents, ringCapacity, totalBytes,
    timeRange: overallFrom !== null && overallTo !== null
      ? { fromMs: overallFrom, toMs: overallTo, spanMs: overallTo - overallFrom } : null,
    categories, appliedQuery,
  };
  return { files, summary };
}

function renderBundleReadme(summary) {
  const lines = [];
  lines.push("# Debug dump", "");
  lines.push("See `.agents/skills/ocuclaw-debug/SKILL.md` → 'Analyzing bucketed dumps' for usage guidance.", "");
  lines.push(`Ring: ${summary.ringEvents} / ${summary.ringCapacity}`);
  lines.push(`Total bytes: ${summary.totalBytes}`);
  if (summary.timeRange) lines.push(`Time range: ${summary.timeRange.fromMs} → ${summary.timeRange.toMs} (${summary.timeRange.spanMs} ms)`);
  lines.push("", "## Buckets", "");
  for (const c of summary.categories) {
    const eventStr = c.count === 1 ? "1 event" : `${c.count} events`;
    const timeRange = c.count > 0 && c.fromMs != null && c.toMs != null
      ? `${c.fromMs} → ${c.toMs}`
      : "no retained records";
    const capped = c.bytesCapped ? ` (capped, dropped ${c.droppedOldestRecords} oldest)` : "";
    lines.push(`- \`${c.file}\` — ${eventStr}, ${c.bytes} bytes, ${timeRange}${capped}`);
  }
  if (summary.categories.length === 0) lines.push("- (no events matched the query)");
  lines.push("", "## Cross-category timeline", "");
  lines.push("Per-category files are chronological WITHIN a category only. To reconstruct the global stream, merge-sort all `*.jsonl` by `(ts, seq)` — `seq` is the global monotonic tie-break that makes a same-`ts` merge deterministic.");
  return lines.join("\n") + "\n";
}

module.exports = { sanitizeCategoryFilename, bucketEventsToFiles, renderBundleReadme };
