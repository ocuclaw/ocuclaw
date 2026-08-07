const { bucketEventsToFiles, renderBundleReadme } = require("./debug-bundle-format.cjs");
const { redactEvents } = require("./debug-bundle-redaction.cjs");
const { zipFiles, sha256Hex } = require("./debug-bundle-zip.cjs");
const { strToU8 } = require("fflate");

const LIVEUI_LANE = ["glasses.lifecycle", "openclaw.message", "evenai"];
const SCHEMA_VERSION = 1;
const FORMAT_VERSION = 1;

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

  const dropOldest = () => {
    events.sort((a, b) => a.ts - b.ts || (a.seq || 0) - (b.seq || 0));
    events = events.slice(Math.ceil(events.length * 0.1));

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

  const { files, summary } = bucketEventsToFiles({
    events,
    ringEvents: dumpResult.ringEvents,
    ringCapacity: dumpResult.ringCapacity,
    appliedQuery,
    perCategoryBytesCap: CATEGORY_SERIALIZED_BYTES_CAP,
  });

  const lane = events
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
