const { parseClientRetention } = require("./debug-retention.cjs");

const CLIENT_FOLD_TTL_MS = 5 * 60 * 1000;
const CLIENT_FOLD_MAX_PART_BYTES = 64_000;
const CLIENT_FOLD_MAX_BYTES = 1024 * 1024;
const CLIENT_FOLD_MAX_LINES = 5_000;
const DEFAULT_MAX_ENTRIES = 16;

function boundedId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 128
    ? value.trim()
    : null;
}

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countLines(value) {
  if (!value) return 0;
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function samePart(left, right) {
  return left.eventsJsonl === right.eventsJsonl &&
    left.clientNowMs === right.clientNowMs &&
    left.partCount === right.partCount &&
    left.ringRevision === right.ringRevision &&
    left.evicted === right.evicted &&
    left.ringCapped === right.ringCapped;
}

function createClientEventFoldCache(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const ttlMs = options.ttlMs || CLIENT_FOLD_TTL_MS;
  const maxPartBytes = options.maxPartBytes || CLIENT_FOLD_MAX_PART_BYTES;
  const maxBytes = options.maxBytes || CLIENT_FOLD_MAX_BYTES;
  const maxLines = options.maxLines || CLIENT_FOLD_MAX_LINES;
  const maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
  const maxStaleEntries = maxEntries * 4;
  const entries = new Map();
  const staleKeys = new Map();

  const keyFor = (installId, foldId) => `${installId.length}:${installId}${foldId}`;
  const markStale = (key, atMs) => {
    entries.delete(key);
    if (!staleKeys.has(key) && staleKeys.size >= maxStaleEntries) {
      const oldest = staleKeys.keys().next().value;
      if (oldest) staleKeys.delete(oldest);
    }
    staleKeys.set(key, atMs + ttlMs);
  };
  const prune = (atMs = now()) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= atMs) markStale(key, atMs);
    }
    for (const [key, expiresAtMs] of staleKeys) {
      if (expiresAtMs <= atMs) staleKeys.delete(key);
    }
  };
  const reject = (reason) => ({ accepted: false, reason, bytes: 0, complete: false });

  function accept(message = {}) {
    const atMs = now();
    prune(atMs);
    const foldId = boundedId(message.foldId);
    if (!foldId) return reject("invalid_fold_id");
    const installId = boundedId(message.installId);
    if (!installId) return reject("invalid_install_id");
    const ringRevision = nonNegativeInt(message.ringRevision);
    if (ringRevision === null) return reject("invalid_ring_revision");
    const partIndex = nonNegativeInt(message.partIndex);
    const partCount = nonNegativeInt(message.partCount);
    if (partCount === null || partCount < 1 || partCount > maxLines) return reject("invalid_part_count");
    if (partIndex === null || partIndex >= partCount) return reject("invalid_part_index");
    if (typeof message.eventsJsonl !== "string") return reject("invalid_events");
    const partBytes = new TextEncoder().encode(message.eventsJsonl).length;
    if (partBytes > maxPartBytes) return reject("part_too_large");
    const clientNowMs = Number.isFinite(message.clientNowMs) ? Math.floor(message.clientNowMs) : null;
    if (clientNowMs === null || clientNowMs < 0) return reject("invalid_client_time");
    const evicted = nonNegativeInt(message.evicted ?? 0);
    if (evicted === null) return reject("invalid_evicted");
    const boundedEvicted = Math.min(evicted, 1_000_000);
    const ringCapped = message.ringCapped === true;
    const retention = message.retentionJson == null ? null : parseClientRetention(message.retentionJson);
    if (message.retentionJson != null && !retention) return reject("invalid_retention");
    const retentionKey = JSON.stringify(retention);
    const key = keyFor(installId, foldId);
    if (staleKeys.has(key)) return reject("stale_fold");

    let entry = entries.get(key);
    if (!entry) {
      if (partIndex !== 0) {
        markStale(key, atMs);
        return reject("gap");
      }
      if (entries.size >= maxEntries) {
        const oldest = entries.entries().next().value;
        if (oldest) markStale(oldest[0], atMs);
      }
      entry = {
        foldId, installId, ringRevision, partCount, evicted: boundedEvicted, ringCapped, retention, retentionKey,
        parts: [], bytes: 0, lines: 0, createdAtMs: atMs, expiresAtMs: atMs + ttlMs,
      };
      entries.set(key, entry);
    }

    if (
      entry.ringRevision !== ringRevision || entry.partCount !== partCount ||
      entry.evicted !== boundedEvicted || entry.ringCapped !== ringCapped || entry.retentionKey !== retentionKey
    ) {
      markStale(key, atMs);
      return reject("conflicting_metadata");
    }
    if (partIndex < entry.parts.length) {
      const candidate = { eventsJsonl: message.eventsJsonl, clientNowMs, partCount, ringRevision, evicted: boundedEvicted, ringCapped };
      if (!samePart(entry.parts[partIndex], candidate)) {
        markStale(key, atMs);
        return reject("conflicting_duplicate");
      }
      return { accepted: true, duplicate: true, bytes: entry.bytes, complete: entry.parts.length === partCount };
    }
    if (partIndex !== entry.parts.length) {
      markStale(key, atMs);
      return reject("gap");
    }

    const partLines = countLines(message.eventsJsonl);
    if (entry.bytes + partBytes > maxBytes) {
      markStale(key, atMs);
      return reject("fold_too_large");
    }
    if (entry.lines + partLines > maxLines) {
      markStale(key, atMs);
      return reject("too_many_lines");
    }
    entry.parts.push({
      eventsJsonl: message.eventsJsonl, clientNowMs, receivedAtMs: atMs,
      partCount, ringRevision, evicted: boundedEvicted, ringCapped,
    });
    entry.bytes += partBytes;
    entry.lines += partLines;
    return { accepted: true, duplicate: false, bytes: entry.bytes, complete: entry.parts.length === partCount };
  }

  function get(message = {}) {
    const atMs = now();
    prune(atMs);
    const foldId = boundedId(message.foldId);
    const installId = boundedId(message.installId);
    if (!foldId || !installId) return { status: "missing", fold: null };
    const key = keyFor(installId, foldId);
    const entry = entries.get(key);
    if (!entry) return { status: staleKeys.has(key) ? "stale" : "missing", fold: null };
    if (nonNegativeInt(message.ringRevision) !== entry.ringRevision || entry.parts.length !== entry.partCount) {
      return { status: "stale", fold: null };
    }
    return { status: entry.ringCapped || entry.evicted > 0 ? "capped" : "ok", fold: entry };
  }

  return { accept, get, prune };
}

module.exports = { createClientEventFoldCache, CLIENT_FOLD_TTL_MS, CLIENT_FOLD_MAX_PART_BYTES, CLIENT_FOLD_MAX_BYTES, CLIENT_FOLD_MAX_LINES };
