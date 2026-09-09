function sanitizeCategoryFilename(cat        ) {
  return cat.replace(/\./g, "-") + ".jsonl";
}

const INCIDENT_EVENTS = new Set([
  "frame_attempt_started", "frame_attempt_ended", "sdk_call_started", "sdk_call_settled", "sdk_call_wait_ended",
  "frame_disposition", "screen_navigation_requested", "rebuild_error", "owned_job_uncaught",
  "screen_enter_rollback", "screen_enter_rollback_failed", "liveui_render_failed", "liveui_render_unparsed",
  "relay_socket_lifecycle", "status_timeline_transition", "stream_pipeline_first_chunk", "stream_pipeline_turn_idle",
  "voice_session_started", "voice_session_ended", "ptt_started", "ptt_stopped", "turn_started", "turn_completed",
  "ptt_capture_started", "ptt_audio_capture_started", "ptt_provider_connected", "ptt_transcribing_entered",
  "ptt_review_entered", "ptt_confirmed", "ptt_handoff_completed", "ptt_cancelled", "ptt_redo", "voice_handoff_committed",
]);
function isIncidentEvent(event     ) {
  return event.severity === "warn" || event.severity === "error" ||
    ["screen.nav", "session.timeline", "liveui.library.events"].includes(event.cat) || INCIDENT_EVENTS.has(event.event);
}

function bucketEventsToFiles(input     ) {
  const { events, ringEvents, ringCapacity, appliedQuery, perCategoryBytesCap } = input;
  const byCategory = new Map               ();
  for (const evt of events) {
    if (!byCategory.has(evt.cat)) byCategory.set(evt.cat, []);
    byCategory.get(evt.cat).push(evt);
  }
  const files = new Map();
  const categories = [];
  const retainedEvents = [];
  const omittedEvents = [];
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
    const kept = new Set();
    const cap = typeof perCategoryBytesCap === "number" && perCategoryBytesCap > 0 ? perCategoryBytesCap : Infinity;
    bytes = 0;
    const priority = list.map((event, index) => ({ event, index }))
      .sort((a, b) => Number(isIncidentEvent(b.event)) - Number(isIncidentEvent(a.event)) || b.index - a.index);
    for (const { index } of priority) {
      if (lineBytes[index] > cap - bytes) continue;
      kept.add(index);
      bytes += lineBytes[index];
    }
    const retained = list.filter((_, index) => kept.has(index));
    for (const event of retained) retainedEvents.push(event);
    for (let i = 0; i < list.length; i++) if (!kept.has(i)) omittedEvents.push(list[i]);
    const content = lines.filter((_, index) => kept.has(index)).join("");
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
      ...(kept.size < list.length ? { bytesCapped: true, droppedOldestRecords: list.length - kept.size,
        selectionPolicy: "incident_before_detail" } : {}),
    });
  }
  const summary = {
    ringEvents, ringCapacity, totalBytes,
    timeRange: overallFrom !== null && overallTo !== null
      ? { fromMs: overallFrom, toMs: overallTo, spanMs: overallTo - overallFrom } : null,
    categories, appliedQuery,
  };
  return { files, summary, retainedEvents, omittedEvents };
}

function renderBundleReadme(summary     ) {
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
  lines.push("Phone-fold rows have `source: phone` and a preserved `clientTsMs`. Their relay-corrected `ts` may interleave with live relay rows by up to one network round trip.");
  return lines.join("\n") + "\n";
}

module.exports = { sanitizeCategoryFilename, bucketEventsToFiles, renderBundleReadme, isIncidentEvent };
