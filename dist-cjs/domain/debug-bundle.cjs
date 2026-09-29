const { bucketEventsToFiles, renderBundleReadme, isIncidentEvent } = require("./debug-bundle-format.cjs");
const { redactEvents } = require("./debug-bundle-redaction.cjs");
const { zipFiles, sha256Hex } = require("./debug-bundle-zip.cjs");
const { strToU8 } = require("fflate");
const { countLanes } = require("./debug-retention.cjs");
const { sanitizeVersionMismatch } = require("./debug-version-verdict.cjs");
const { snapshotHealthSummary } = require("./debug-health-summary.cjs");

const LIVEUI_LANE = ["glasses.lifecycle", "openclaw.message", "evenai"];
const SCHEMA_VERSION = 1;
const FORMAT_VERSION = 2;

const CATEGORY_SERIALIZED_BYTES_CAP = 4_194_304;

function sanitizeCaptureState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  const str = (k, max) => {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) out[k] = v.slice(0, max);
  };
  const bool = (k) => {
    if (typeof raw[k] === "boolean") out[k] = raw[k];
  };
  const num = (k) => {
    if (typeof raw[k] === "number" && Number.isFinite(raw[k])) out[k] = raw[k];
  };
  str("screenId", 120);
  bool("screenSettled");
  bool("streamActive");
  bool("upstreamActive");
  bool("displayDrainComplete");
  num("menuDepth");
  num("readSpeedWpm");
  str("streamPageAdvanceMode", 40);
  const mismatch = sanitizeVersionMismatch(raw.versionMismatch);
  if (mismatch) out.versionMismatch = mismatch;
  return Object.keys(out).length > 0 ? out : null;
}

function dedupeReportEvents(events) {
  const result = [];
  const seen = new Map();
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  };
  const signatureOf = (event) => {
    const { source, clientId, ...originalData } = event.data || {};
    return JSON.stringify(canonical({ cat: event.cat, event: event.event,
      severity: event.severity, screen: event.screen || null, runId: event.runId || null, data: originalData }));
  };
  for (const event of events || []) {
    const data = event.data || {};
    const id = typeof data.captureEpoch === "string" && /^-?[a-f0-9]{1,16}$/.test(data.captureEpoch) &&
      Number.isSafeInteger(data.captureSeq) && data.captureSeq > 0
      ? `${data.captureEpoch}:${data.captureSeq}` : null;
    if (!id) { result.push(event); continue; }

    const copies = seen.get(id);
    if (copies === undefined) { seen.set(id, [{ signature: null, index: result.length }]); result.push(event); continue; }
    const signature = signatureOf(event);
    let prior = -1;
    for (const copy of copies) {
      if (copy.signature === null) copy.signature = signatureOf(result[copy.index]);
      if (copy.signature === signature) { prior = copy.index; break; }
    }
    if (prior === -1) { copies.push({ signature, index: result.length }); result.push(event); }
    else if (event.source === "phone") result[prior] = event;
  }
  return result;
}

const incidentFirstOrder = (a, b) =>
  Number(isIncidentEvent(a)) - Number(isIncidentEvent(b)) || a.ts - b.ts || (a.seq || 0) - (b.seq || 0);

function trimCuts(total, detailTotal) {
  const cuts = [];
  let left = total;
  let detail = detailTotal;
  let cut = 0;
  while (left > 0) {
    const removed = Math.min(Math.ceil(left * 0.1), detail || left);
    cut += removed;
    left -= removed;
    detail = Math.max(0, detail - removed);
    cuts.push(cut);
  }
  return cuts;
}

function assembleBundle(dumpResult, opts) {
  const appliedQuery = dumpResult.appliedQuery || {
    categories: dumpResult.categories,
    sinceMs: dumpResult.sinceMs,
    untilMs: dumpResult.untilMs,
  };

  const events = redactEvents(dumpResult.events, { mode: opts.redactionMode });

  const full = buildArtifacts(events, dumpResult, appliedQuery,
    { ...opts, zipOmitted: { phone: 0, relay: 0 } }, opts.ringCappedWindow);
  const done = (built) => ({ zip: built.zip, bundleSha256: built.bundleSha256, metadata: built.metadata,
    partCount: partCountFor(built.zip, opts.chunkBytes), files: built.files });

  const maxZipBytes = opts.maxZipBytes;
  if (!(typeof maxZipBytes === "number" && maxZipBytes > 0) || full.zip.length <= maxZipBytes || events.length === 0) {
    return done(full);
  }
  const ordered = events.slice().sort(incidentFirstOrder);
  let detailTotal = 0;
  for (const event of ordered) if (!isIncidentEvent(event)) detailTotal += 1;
  const cuts = trimCuts(ordered.length, detailTotal);
  const steps = cuts.length;

  const zipBytes = new Map();
  let best = null;
  const buildStep = (step) => {
    const cut = cuts[step - 1];

    return buildArtifacts(ordered.slice(cut), dumpResult, appliedQuery,
      { ...opts, zipOmitted: countLanes(ordered.slice(0, cut)) }, true);
  };
  const fits = (step) => {
    if (!zipBytes.has(step)) {
      const built = buildStep(step);
      zipBytes.set(step, built.zip.length);
      if (built.zip.length <= maxZipBytes && (!best || step < best.step)) best = { step, built };
    }
    return zipBytes.get(step) <= maxZipBytes;
  };

  const target = (maxZipBytes / full.zip.length) * ordered.length;
  let guess = steps;
  for (let step = 1; step <= steps; step++) {
    if (ordered.length - cuts[step - 1] <= target) { guess = step; break; }
  }

  let low;
  let high;
  if (fits(guess)) {
    high = guess;
    let stride = 1;
    low = guess - stride;
    while (low >= 1 && fits(low)) { high = low; stride *= 2; low = high - stride; }
    low = Math.max(low, 0);
  } else {
    low = guess;
    let stride = 1;
    high = guess + stride;
    while (high <= steps && !fits(high)) { low = high; stride *= 2; high = low + stride; }
    if (high > steps) {
      high = steps;

      if (!fits(high)) return done(buildStep(steps));
    }
  }
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (fits(mid)) high = mid; else low = mid;
  }
  return done(best && best.step === high ? best.built : buildStep(high));
}

function partCountFor(zip, chunkBytes) {
  const safeChunkBytes = Math.max(1, chunkBytes | 0);
  return Math.max(1, Math.ceil(zip.length / safeChunkBytes));
}

function buildArtifacts(events, dumpResult, appliedQuery, opts, ringCapped) {

  const { files, summary, retainedEvents, omittedEvents } = bucketEventsToFiles({
    events,
    ringEvents: dumpResult.ringEvents,
    ringCapacity: dumpResult.ringCapacity,
    appliedQuery,
    perCategoryBytesCap: CATEGORY_SERIALIZED_BYTES_CAP,
  });
  const finalCounts = countLanes(retainedEvents);
  const categoryOmitted = countLanes(omittedEvents);
  const inputCounts = countLanes(dumpResult.events || []);
  const lanes = {};
  for (const name of ["relay", "phone"]) {
    const source = opts.lanes?.[name] || { status: name === "phone" ? "missing" : "ok" };
    const laneRows = retainedEvents.filter((event) => (event.source === "phone" ? "phone" : "relay") === name);
    let fromMs = null; let toMs = null;
    for (const event of laneRows) {
      if (Number.isFinite(event.ts)) {
        fromMs = fromMs === null ? event.ts : Math.min(fromMs, event.ts);
        toMs = toMs === null ? event.ts : Math.max(toMs, event.ts);
      }
    }
    lanes[name] = { ...source, events: finalCounts[name], selectedEvents: inputCounts[name],
      categoryOmitted: categoryOmitted[name], zipOmitted: opts.zipOmitted[name], fromMs, toMs,
      detailUnavailableEvents: laneRows.filter(event => event.data?.detailUnavailable === true).length };
  }

  const lane = retainedEvents
    .filter((e) => LIVEUI_LANE.includes(e.cat))
    .sort((a, b) => a.ts - b.ts || (a.seq || 0) - (b.seq || 0));
  if (lane.length) {
    const laneLines = [];
    const laneLineBytes = [];
    let laneBytes = 0;
    for (const event of lane) {
      const line = JSON.stringify(event) + "\n";
      const serializedBytes = strToU8(line).length;
      laneLines.push(line);
      laneLineBytes.push(serializedBytes);
      laneBytes += serializedBytes;
    }
    let firstRetainedIndex = 0;
    while (laneBytes > CATEGORY_SERIALIZED_BYTES_CAP && firstRetainedIndex < laneLines.length - 1) {
      laneBytes -= laneLineBytes[firstRetainedIndex];
      firstRetainedIndex += 1;
    }
    const retainedLane = lane.slice(firstRetainedIndex);
    files.set("correlation-liveui.jsonl", laneLines.slice(firstRetainedIndex).join(""));
    summary.totalBytes += laneBytes;
    summary.categories.push({
      cat: "correlation.liveui",
      count: retainedLane.length,
      bytes: laneBytes,
      fromMs: retainedLane[0]?.ts ?? null,
      toMs: retainedLane[retainedLane.length - 1]?.ts ?? null,
      file: "correlation-liveui.jsonl",
      ...(firstRetainedIndex > 0 ? { bytesCapped: true, droppedOldestRecords: firstRetainedIndex } : {}),
    });
  }

  files.set("README.md", renderBundleReadme(summary));

  if (
    opts.connectionHealthDocument &&
    typeof opts.connectionHealthDocument === "object" &&
    !Array.isArray(opts.connectionHealthDocument)
  ) {
    files.set(
      "connection-health.json",
      JSON.stringify(opts.connectionHealthDocument, null, 2) + "\n",
    );
  }

  for (const [name, content] of opts.clientDiagnostics?.files || []) {
    files.set(name, content);
    summary.totalBytes += strToU8(content).length;
  }
  const contentNames = [...files.keys()].filter((n) => n !== "metadata.json").sort();
  const concat = contentNames.map((n) => files.get(n)).join("");
  const contentSha256 = sha256Hex(strToU8(concat));

  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    formatVersion: FORMAT_VERSION,
    kind: "ocuclaw-debug-bundle",
    capturedAtMs: dumpResult.nowMs,
    window: {
      fromMs: summary.timeRange ? summary.timeRange.fromMs : null,
      toMs: summary.timeRange ? summary.timeRange.toMs : null,
      spanMs: summary.timeRange ? summary.timeRange.spanMs : null,
      ringCappedWindow: ringCapped,
    },
    ring: { events: dumpResult.ringEvents, capacity: dumpResult.ringCapacity },
    lanes,
    retentionAccountingVersion: 1,
    phoneDiagnostics: opts.clientDiagnostics?.metadata || { status: "missing" },
    totalBytes: summary.totalBytes,
    contentSha256,
    build: opts.build,
    ...(opts.connectionHealthDocument ? snapshotHealthSummary(opts.connectionHealthDocument) : {}),
    installId: opts.installId,
    redactionMode: opts.redactionMode,
    secretsStripped: true,
    categories: summary.categories,
    appliedQuery,
    timeRange: summary.timeRange,
    notes: { byteCountsArePostRedaction: true, appliedQueryIsPreExpansion: true, crossCategoryMergeKey: ["ts", "seq"] },
    ticket: { id: null, reporter: null, note: opts.note || null, deviceModel: "G2" },

    ...(opts.captureState ? { stateAtReportTime: opts.captureState } : {}),
  };
  files.set("metadata.json", JSON.stringify(metadata, null, 2) + "\n");

  const zip = zipFiles(files);
  const bundleSha256 = sha256Hex(zip);

  return { files, summary, metadata, zip, bundleSha256 };
}

function chunkZip(zip, chunkBytes) {
  return chunkZipRange(zip, chunkBytes, 0, Infinity);
}

function chunkZipRange(zip, chunkBytes, fromIndex, count) {
  const safeChunkBytes = Math.max(1, chunkBytes | 0);
  const partCount = partCountFor(zip, safeChunkBytes);
  const first = Math.max(0, Math.floor(fromIndex) || 0);
  const end = Math.min(partCount, first + Math.max(0, count));
  const chunks = [];
  for (let i = first; i < end; i++) {
    const slice = zip.subarray(i * safeChunkBytes, (i + 1) * safeChunkBytes);
    chunks.push({ partIndex: i, partCount, partBase64: Buffer.from(slice).toString("base64") });
  }
  return chunks;
}

module.exports = { assembleBundle, chunkZip, chunkZipRange, dedupeReportEvents, sanitizeCaptureState };
