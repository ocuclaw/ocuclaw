const { assembleBundle, chunkZip, sanitizeCaptureState } = require("../domain/debug-bundle.cjs");
const { buildBundlePreview } = require("../domain/debug-bundle-preview.cjs");
const { filterUploadEvents } = require("../domain/debug-upload-preset.cjs");

function computeAvailableSpanMs(dumpResult) {
  const now = dumpResult && typeof dumpResult.nowMs === "number" ? dumpResult.nowMs : 0;
  if (dumpResult && typeof dumpResult.oldestMatchedMs === "number") {
    return Math.max(0, now - dumpResult.oldestMatchedMs);
  }
  const events = dumpResult && dumpResult.events;
  if (!Array.isArray(events) || events.length === 0) return 0;
  let min = Infinity;
  for (const e of events) {
    const ts = e && typeof e.ts === "number" ? e.ts : null;
    if (ts !== null && ts < min) min = ts;
  }
  if (!Number.isFinite(min)) return 0;
  return Math.max(0, now - min);
}

async function handleDebugBundleRequest(deps, clientId, msg) {
  if (!deps.gatesOn()) {
    deps.emit("capture_refused", { requestId: msg.requestId, reason: "gates_off" });

    deps.send(clientId, {
      type: "debug-bundle-error",
      requestId: msg.requestId,
      reason: "upload_not_allowed",
    });
    return;
  }
  deps.emit("capture_requested", {
    requestId: msg.requestId,
    redactionMode: msg.redactionMode,
  });

  const windowMs =
    typeof msg.windowMs === "number" && Number.isFinite(msg.windowMs) && msg.windowMs > 0
      ? Math.floor(msg.windowMs)
      : null;
  const dumpResult = deps.dump(
    windowMs ? { categories: deps.preset, sinceAgeMs: windowMs } : { categories: deps.preset },
  );

  if (!dumpResult || dumpResult.ok === false) {
    deps.emit("capture_failed", { requestId: msg.requestId, reason: "dump_failed" });
    deps.send(clientId, { type: "debug-bundle-error", requestId: msg.requestId, reason: "dump_failed" });
    return;
  }
  const availableSpanMs = computeAvailableSpanMs(dumpResult);

  const uploadDump = { ...dumpResult, events: filterUploadEvents(dumpResult.events) };

  try {
    const bundle = assembleBundle(uploadDump, {
      installId: msg.installId,
      build: deps.build,
      redactionMode: msg.redactionMode || "structural",
      ringCappedWindow: false,
      maxZipBytes: deps.maxZipBytes,
      chunkBytes: deps.chunkBytes,
      note: msg.note,

      captureState: (() => {
        const st = sanitizeCaptureState(msg.stateSnapshot);
        return st ? { atMs: deps.now(), ...st } : null;
      })(),
    });
    deps.emit("bundle_assembled", {
      requestId: msg.requestId,
      categories: bundle.metadata.categories.length,
      totalBytes: bundle.metadata.totalBytes,
      ringCappedWindow: bundle.metadata.window.ringCappedWindow,
    });
    const bundleId = deps.newBundleId();
    deps.cachePut(bundleId, {
      zip: bundle.zip,
      metadataJson: JSON.stringify(bundle.metadata),
      bundleSha256: bundle.bundleSha256,
      cachedMs: deps.now(),
    });

    const frameMetadataJson = JSON.stringify({
      ...bundle.metadata,
      zipBytes: bundle.zip.length,
      availableSpanMs,
    });
    deps.send(clientId, {
      type: "debug-bundle-meta",
      requestId: msg.requestId,
      bundleId,
      metadataJson: frameMetadataJson,
    });

    deps.send(clientId, {
      type: "debug-bundle-preview",
      requestId: msg.requestId,
      bundleId,
      sampleJson: JSON.stringify(buildBundlePreview(bundle.files, { maxEvents: 15, maxCharsPerEvent: 80 })),
    });
    deps.emit("bundle_cached", {
      requestId: msg.requestId,
      bundleId,
      parts: bundle.chunks.length,
    });
  } catch (err) {

    if (deps.logError) {
      deps.logError(`bundle assembly failed: ${err && err.message ? err.message : err}`);
    }
    deps.emit("upload_failed", { requestId: msg.requestId, reason: "assembly_failed" });
    deps.send(clientId, { type: "debug-bundle-error", requestId: msg.requestId, reason: "assembly_failed" });
    return;
  }
}

async function handleDebugBundleSave(deps, clientId, msg) {
  if (!deps.gatesOn()) {
    deps.emit("save_refused", { requestId: msg.requestId, reason: "upload_not_allowed" });
    deps.send(clientId, { type: "debug-bundle-error", requestId: msg.requestId, reason: "upload_not_allowed" });
    return;
  }
  const entry = deps.cacheGet(msg.bundleId);
  if (!entry) {
    deps.emit("save_expired", { requestId: msg.requestId, bundleId: msg.bundleId });
    deps.send(clientId, { type: "debug-bundle-error", requestId: msg.requestId, reason: "bundle_expired" });
    return;
  }

  const reporterNote = typeof msg.note === "string" ? msg.note : "";
  let sidecarMetadataJson;
  try {
    sidecarMetadataJson = JSON.stringify(
      { ...JSON.parse(entry.metadataJson), reporterNote, reporterRedactionMode: "off" },
      null,
      2,
    );
  } catch {
    sidecarMetadataJson = entry.metadataJson;
  }
  try {
    const { savedPath, fileSize } = deps.saveBundle({ bundleId: msg.bundleId, savedMs: deps.now(), zip: entry.zip, metadataJson: sidecarMetadataJson });
    deps.emit("bundle_written", { requestId: msg.requestId, bundleId: msg.bundleId, fileSize });
    deps.send(clientId, { type: "debug-bundle-saved", requestId: msg.requestId, bundleId: msg.bundleId, savedPath, fileSize });
  } catch (err) {

    if (deps.logError) {
      deps.logError(`bundle save failed: ${err && err.message ? err.message : err}`);
    }
    deps.emit("save_failed", { requestId: msg.requestId, reason: "save_failed" });
    deps.send(clientId, { type: "debug-bundle-error", requestId: msg.requestId, reason: "save_failed" });
  }

}

async function handleDebugBundleFetch(deps, clientId, msg) {
  if (!deps.gatesOn()) {
    deps.emit("fetch_refused", { requestId: msg.requestId, reason: "upload_not_allowed" });
    deps.send(clientId, { type: "debug-bundle-error", requestId: msg.requestId, reason: "upload_not_allowed" });
    return;
  }
  const entry = deps.cacheGet(msg.bundleId);
  if (!entry) {
    deps.emit("fetch_expired", { requestId: msg.requestId, bundleId: msg.bundleId });
    deps.send(clientId, { type: "debug-bundle-error", requestId: msg.requestId, reason: "bundle_expired" });
    return;
  }
  const chunks = chunkZip(entry.zip, deps.chunkBytes);
  for (const chunk of chunks) {
    deps.send(clientId, { type: "debug-bundle", requestId: msg.requestId, bundleId: msg.bundleId, partIndex: chunk.partIndex, partCount: chunk.partCount, partBase64: chunk.partBase64, bundleSha256: entry.bundleSha256 });
  }
  deps.emit("handoff_complete", { requestId: msg.requestId, bundleId: msg.bundleId, parts: chunks.length });
}

module.exports = { handleDebugBundleRequest, handleDebugBundleSave, handleDebugBundleFetch };
