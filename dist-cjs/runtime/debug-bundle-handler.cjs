const { assembleBundle, chunkZip, sanitizeCaptureState } = require("../domain/debug-bundle.cjs");
const { buildBundlePreview } = require("../domain/debug-bundle-preview.cjs");
const { filterUploadEvents } = require("../domain/debug-upload-preset.cjs");
const { createNoisyPolicyFilter } = require("../domain/debug-store.cjs");
const { retentionForWindow, countLanes } = require("../domain/debug-retention.cjs");
const { parseClientReportDiagnostics } = require("../domain/debug-client-diagnostics.cjs");

function deduplicateReportEvents(events       ) {
  const result        = [];
  const seen = new Map();
  const canonical = (value     )      => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  };
  for (const event of events || []) {
    const data = event.data || {};
    const id = typeof data.captureEpoch === "string" && /^-?[a-f0-9]{1,16}$/.test(data.captureEpoch) &&
      Number.isSafeInteger(data.captureSeq) && data.captureSeq > 0
      ? `${data.captureEpoch}:${data.captureSeq}` : null;
    if (!id) { result.push(event); continue; }
    const { source, clientId, ...originalData } = data;
    const signature = JSON.stringify(canonical({ cat: event.cat, event: event.event,
      severity: event.severity, screen: event.screen || null, runId: event.runId || null, data: originalData }));
    const key = `${id}:${signature}`;
    const prior = seen.get(key);
    if (prior === undefined) { seen.set(key, result.length); result.push(event); }
    else if (event.source === "phone") result[prior] = event;
  }
  return result;
}

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

function mergePhoneFold(deps     , clientId     , msg     , dumpResult     , windowMs     ) {
  const result = deps.clientEvents || { status: "missing", fold: null };
  const fold = result.fold;
  const basePhone = {
    status: result.status === "stale" ? "stale" : "missing",
    events: 0,
    bytes: 0,
    evicted: 0,
    ringCapped: false,
  };
  if (!fold || (result.status !== "ok" && result.status !== "capped")) {
    return { events: [], oldestMs: null, metadata: basePhone };
  }

  const preset = new Set(Array.isArray(deps.preset) ? deps.preset : []);
  const allowNoisy = createNoisyPolicyFilter();
  const currentSessionKey = typeof deps.currentSessionKey === "function" ? deps.currentSessionKey() : null;
  let nextSeq = 0;
  for (const event of dumpResult.events || []) {
    if (Number.isFinite(event && event.seq)) nextSeq = Math.max(nextSeq, Math.floor(event.seq));
  }
  let oldestMs = null;
  let encounter = 0;
  const candidates = [];
  const events = [];
  const excluded = { shipped: 0, preset: 0, window: 0, noisy: 0 };
  let invalidRows = 0;

  const snapshotAtMs = fold.parts.length ? fold.parts[0].receivedAtMs : dumpResult.nowMs;
  const correctionMs = fold.parts.length ? snapshotAtMs - fold.parts[0].clientNowMs : 0;
  for (const part of fold.parts) {
    const lines = part.eventsJsonl.split("\n");
    for (const line of lines) {
      if (!line) continue;
      let raw;
      try { raw = JSON.parse(line); } catch { invalidRows++; continue; }
      if (!raw) { invalidRows++; continue; }
      const parsed = typeof deps.parseClientEvent === "function" ? deps.parseClientEvent(raw) : null;
      if (!parsed) { invalidRows++; continue; }
      if (!preset.has(parsed.cat)) { excluded.preset++; continue; }
      const clientTsMs = Number.isFinite(raw.clientTsMs)
        ? Math.floor(raw.clientTsMs)
        : Number.isFinite(parsed.data && parsed.data.clientTsMs)
          ? Math.floor(parsed.data.clientTsMs)
          : null;
      if (clientTsMs === null) { invalidRows++; continue; }
      const ts = clientTsMs + correctionMs;
      if (oldestMs === null || ts < oldestMs) oldestMs = ts;
      candidates.push({
        parsed,
        clientTsMs,
        ts,
        phoneSeq: Number.isFinite(raw.seq) ? Math.floor(raw.seq) : Number.MAX_SAFE_INTEGER,
        encounter: encounter++,
      });
    }
  }
  candidates.sort((left, right) => left.ts - right.ts || left.phoneSeq - right.phoneSeq || left.encounter - right.encounter);
  for (const candidate of candidates) {
    const { parsed, clientTsMs, ts } = candidate;
    if (windowMs && ts < snapshotAtMs - windowMs) { excluded.window++; continue; }
    let serialized;
    try { serialized = JSON.stringify(parsed.data); } catch { serialized = "{}"; }
    if (!allowNoisy(parsed.cat, parsed.event, serialized, ts)) { excluded.noisy++; continue; }
    events.push({
      ts,
      cat: parsed.cat,
      event: parsed.event,
      severity: parsed.severity,
      seq: ++nextSeq,
      data: { ...parsed.data, source: "phone", clientTsMs },
      ...(typeof parsed.data?.captureSessionKey === "string" ? { sessionKey: parsed.data.captureSessionKey } : {}),
      ...(currentSessionKey ? { reportSessionKey: currentSessionKey } : {}),
      phoneSeq: candidate.phoneSeq,
      ...(parsed.runId ? { runId: parsed.runId } : {}),
      ...(parsed.screen ? { screen: parsed.screen } : {}),
      source: "phone",
      clientTsMs,
      clientId,
    });
  }
  return {
    events,
    oldestMs,
    metadata: {
      status: result.status,
      events: events.length,
      bytes: Math.min(fold.bytes, 1024 * 1024),
      evicted: Math.min(fold.evicted, 1_000_000),
      ringCapped: fold.ringCapped === true,
      excluded,
      invalidRows,
      snapshotAtMs,
      retention: retentionForWindow(fold.retention,
        correctionMs, windowMs ? snapshotAtMs - windowMs : 0, snapshotAtMs),
    },
  };
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
    windowMs
      ? { categories: deps.preset, sinceAgeMs: windowMs, includeForced: true }
      : { categories: deps.preset, includeForced: true },
  );

  if (!dumpResult || dumpResult.ok === false || !Array.isArray(dumpResult.events)) {
    deps.emit("capture_failed", { requestId: msg.requestId, reason: "dump_failed" });
    deps.send(clientId, { type: "debug-bundle-error", requestId: msg.requestId, reason: "dump_failed" });
    return;
  }
  const phone = mergePhoneFold(deps, clientId, msg, dumpResult, windowMs);
  const relayAvailableSpanMs = computeAvailableSpanMs(dumpResult);
  const phoneAvailableSpanMs = phone.oldestMs === null ? 0 : Math.max(0, dumpResult.nowMs - phone.oldestMs);
  const availableSpanMs = Math.max(relayAvailableSpanMs, phoneAvailableSpanMs);

  const filtered = filterUploadEvents([...(dumpResult.events || []), ...phone.events]);
  const uploadDump = {
    ...dumpResult,
    events: deduplicateReportEvents(filtered),
  };
  const beforeExcludes = countLanes([...(dumpResult.events || []), ...phone.events]);
  const afterExcludes = countLanes(filtered);
  const afterDedupe = countLanes(uploadDump.events || []);

  let connectionHealthDocument = null;
  if (typeof deps.getConnectionHealthDocument === "function") {
    try {
      const candidate = await deps.getConnectionHealthDocument();
      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate.contract === "ocuclaw.connection-health-snapshot" ||
          candidate.contract === "ocuclaw.connection-health-error") &&
        candidate.contractVersion === 1
      ) {
        connectionHealthDocument = candidate;
      } else {
        connectionHealthDocument = connectionHealthError();
      }
    } catch {
      connectionHealthDocument = connectionHealthError();
    }
  }

  try {
    const bundle = assembleBundle(uploadDump, {
      installId: msg.installId,
      build: deps.build,
      redactionMode: msg.redactionMode || "structural",
      ringCappedWindow: phone.metadata.ringCapped,
      maxZipBytes: deps.maxZipBytes,
      chunkBytes: deps.chunkBytes,
      note: msg.note,

      captureState: (() => {
        const st = sanitizeCaptureState(msg.stateSnapshot);
        return st ? { atMs: deps.now(), ...st } : null;
      })(),
      connectionHealthDocument,
      clientDiagnostics: parseClientReportDiagnostics(msg.clientDiagnosticsJson, { mode: msg.redactionMode }),
      lanes: {
        relay: { status: "ok", automationExcluded: beforeExcludes.relay - afterExcludes.relay,
          duplicateCopies: afterExcludes.relay - afterDedupe.relay },
        phone: { ...phone.metadata, automationExcluded: beforeExcludes.phone - afterExcludes.phone,
          duplicateCopies: afterExcludes.phone - afterDedupe.phone },
      },
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

function connectionHealthError() {
  return {
    contract: "ocuclaw.connection-health-error",
    contractVersion: 1,
    generatedAt: new Date().toISOString(),
    code: "snapshot_unavailable",
    message: "The passive Connection Health Snapshot could not be generated.",
  };
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

module.exports = { handleDebugBundleRequest, handleDebugBundleSave, handleDebugBundleFetch, deduplicateReportEvents };
