const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { assembleBundle, dedupeReportEvents } = require("../domain/debug-bundle.cjs");
const { buildBundlePreview } = require("../domain/debug-bundle-preview.cjs");
const { filterUploadEvents } = require("../domain/debug-upload-preset.cjs");
const { countLanes } = require("../domain/debug-retention.cjs");

const WORKER_MARKER = "ocuclawDebugBundleWorker";
const DEBUG_BUNDLE_SLICE_EVENTS = 2500;

function buildReportBundle(input) {
  const relayEvents = input.relayEvents || [];
  const phoneEvents = input.phoneEvents || [];
  const opts = input.assemble || {};
  const selected = relayEvents.concat(phoneEvents);

  const filtered = filterUploadEvents(selected);
  const events = dedupeReportEvents(filtered);
  const beforeExcludes = countLanes(selected);
  const afterExcludes = countLanes(filtered);
  const afterDedupe = countLanes(events);
  const phoneMetadata = input.phoneMetadata || {};
  const bundle = assembleBundle({ ...input.dump, events }, {
    installId: opts.installId,
    build: opts.build,
    redactionMode: opts.redactionMode || "structural",
    ringCappedWindow: phoneMetadata.ringCapped,
    maxZipBytes: opts.maxZipBytes,
    chunkBytes: opts.chunkBytes,
    note: opts.note,
    captureState: opts.captureState,
    connectionHealthDocument: opts.connectionHealthDocument,
    clientDiagnostics: opts.clientDiagnostics,
    lanes: {
      relay: { status: "ok", automationExcluded: beforeExcludes.relay - afterExcludes.relay,
        duplicateCopies: afterExcludes.relay - afterDedupe.relay },
      phone: { ...phoneMetadata, automationExcluded: beforeExcludes.phone - afterExcludes.phone,
        duplicateCopies: afterExcludes.phone - afterDedupe.phone },
    },
  });
  return {
    zip: bundle.zip,
    bundleSha256: bundle.bundleSha256,
    metadata: bundle.metadata,
    partCount: bundle.partCount,
    sampleJson: JSON.stringify(buildBundlePreview(bundle.files, { maxEvents: 15, maxCharsPerEvent: 80 })),
  };
}

function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function postSlice(worker, kind, rows) {
  try {
    worker.postMessage({ kind, rows });
  } catch {
    worker.postMessage({ kind, rows: rows.map((row) => JSON.parse(JSON.stringify(row))) });
  }
}

function defaultWorkerFactory() {
  return new Worker(new URL("./debug-bundle-worker.cjs", `file://${__filename}`), {
    workerData: { [WORKER_MARKER]: true },
  });
}

async function runReportAssembly(input, options = {}) {
  const sliceEvents = Math.max(1, Math.floor(options.sliceEvents || DEBUG_BUNDLE_SLICE_EVENTS));
  const factory = options.workerFactory || defaultWorkerFactory;
  const inline = (reason) => {
    if (options.logError) options.logError(`debug bundle worker unavailable (${reason}); assembling inline`);
    return { ...buildReportBundle(input), mode: "inline" };
  };
  let worker;
  try {
    worker = factory();
  } catch (err) {
    return inline(err && err.message ? err.message : "spawn_failed");
  }
  let ready = false;
  let settled = false;
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  const outcome = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      resolveReady(false);
      fn(value);
    };
    worker.on("message", (message) => {
      if (!message) return;
      if (message.kind === "ready") { ready = true; resolveReady(true); return; }
      if (message.kind === "result") {
        const result = message.result;
        result.zip = new Uint8Array(result.zipBuffer, result.zipOffset, result.zipLength);
        delete result.zipBuffer; delete result.zipOffset; delete result.zipLength;
        finish(resolve, { ...result, mode: "worker" });
        return;
      }
      if (message.kind === "error") finish(reject, new Error(message.message || "worker_failed"));
    });
    worker.on("error", (err) => finish(reject, err));
    worker.on("exit", (code) => finish(reject, new Error(`debug bundle worker exited (${code})`)));
  });

  outcome.catch(() => {});
  try {
    if (!(await readyPromise) || !ready) {
      try { await outcome; } catch (err) { return inline(err && err.message ? err.message : "load_failed"); }
    }
    const { relayEvents, phoneEvents, ...header } = input;
    worker.postMessage({ kind: "begin", header });
    for (const [kind, rows] of [["relay", relayEvents || []], ["phone", phoneEvents || []]]) {
      for (let start = 0; start < rows.length; start += sliceEvents) {
        if (settled) break;
        postSlice(worker, kind, rows.slice(start, start + sliceEvents));
        await yieldToLoop();
      }
    }
    worker.postMessage({ kind: "assemble" });
    return await outcome;
  } finally {
    settled = true;
    worker.terminate().catch(() => {});
  }
}

if (!isMainThread && parentPort && workerData && workerData[WORKER_MARKER] === true) {
  const port = parentPort;
  let header = null;
  const relayEvents = [];
  const phoneEvents = [];
  port.on("message", (message) => {
    try {
      if (!message) return;
      if (message.kind === "begin") { header = message.header; return; }
      if (message.kind === "relay") { for (const row of message.rows) relayEvents.push(row); return; }
      if (message.kind === "phone") { for (const row of message.rows) phoneEvents.push(row); return; }
      if (message.kind === "assemble") {
        const result = buildReportBundle({ ...header, relayEvents, phoneEvents });
        const zip = result.zip;
        const { zip: _zip, ...rest } = result;
        port.postMessage({
          kind: "result",
          result: { ...rest, zipBuffer: zip.buffer, zipOffset: zip.byteOffset, zipLength: zip.byteLength },
        }, [zip.buffer]);
      }
    } catch (err) {
      port.postMessage({ kind: "error", message: err && err.message ? err.message : String(err) });
    }
  });
  port.postMessage({ kind: "ready" });
}

module.exports = { buildReportBundle, runReportAssembly, DEBUG_BUNDLE_SLICE_EVENTS };
