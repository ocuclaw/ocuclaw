const { bucketEventsToFiles, renderBundleReadme, isIncidentEvent } = require("./debug-bundle-format.cjs");
const { redactEvents } = require("./debug-bundle-redaction.cjs");
const { zipFiles, sha256Hex } = require("./debug-bundle-zip.cjs");
const { strToU8 } = require("fflate");
const { countLanes } = require("./debug-retention.cjs");

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
  return Object.keys(out).length > 0 ? out : null;
}

function assembleBundle(dumpResult, opts) {
  const appliedQuery = dumpResult.appliedQuery || {
    categories: dumpResult.categories,
    sinceMs: dumpResult.sinceMs,
    untilMs: dumpResult.untilMs,
  };

  let events = redactEvents(dumpResult.events, { mode: opts.redactionMode });
  let ringCapped = opts.ringCappedWindow;
  const zipOmitted = { phone: 0, relay: 0 };
  opts = { ...opts, zipOmitted };

  const dropOldest = () => {
    events.sort((a, b) => Number(isIncidentEvent(a)) - Number(isIncidentEvent(b)) || a.ts - b.ts || (a.seq || 0) - (b.seq || 0));
    const detailCount = events.filter(event => !isIncidentEvent(event)).length;
    const removed = Math.min(Math.ceil(events.length * 0.1), detailCount || events.length);
    const counts = countLanes(events.slice(0, removed));
    zipOmitted.phone += counts.phone;
    zipOmitted.relay += counts.relay;
    events = events.slice(removed);

    ringCapped = true;
  };

  let built = buildArtifacts(events, dumpResult, appliedQuery, opts, ringCapped);

  if (typeof opts.maxZipBytes === "number" && opts.maxZipBytes > 0) {
    while (built.zip.length > opts.maxZipBytes && events.length > 0) {
      dropOldest();
      built = buildArtifacts(events, dumpResult, appliedQuery, opts, ringCapped);
    }
  }

  return { zip: built.zip, bundleSha256: built.bundleSha256, metadata: built.metadata, chunks: built.chunks, files: built.files };
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
  const chunks = chunkZip(zip, opts.chunkBytes);

  return { files, summary, metadata, zip, bundleSha256, chunks };
}

function chunkZip(zip, chunkBytes) {
  const safeChunkBytes = Math.max(1, chunkBytes | 0);
  const partCount = Math.max(1, Math.ceil(zip.length / safeChunkBytes));
  const chunks = [];
  for (let i = 0; i < partCount; i++) {
    const slice = zip.subarray(i * safeChunkBytes, (i + 1) * safeChunkBytes);
    chunks.push({ partIndex: i, partCount, partBase64: Buffer.from(slice).toString("base64") });
  }
  return chunks;
}

module.exports = { assembleBundle, chunkZip, sanitizeCaptureState };
