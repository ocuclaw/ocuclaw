const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 64;

function normalizeNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(Number(value))) return fallback;
  return Math.max(0, Math.floor(Number(value)));
}

function createApprovalReplayCache(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const ttlMs = normalizeNonNegativeInteger(options.ttlMs, DEFAULT_TTL_MS);
  const maxEntries = normalizeNonNegativeInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const entries = new Map();

  function nowMs() {
    return normalizeNonNegativeInteger(now(), Date.now());
  }

  function isStale(entry, atMs) {
    if (ttlMs > 0 && atMs - entry.cachedAtMs > ttlMs) return true;
    if (entry.frameExpiresAtMs > 0 && entry.frameExpiresAtMs <= atMs) return true;
    return false;
  }

  function set(id, frame, frameExpiresAtMs) {
    if (typeof id !== "string" || !id.trim()) return;
    const key = id.trim();
    entries.delete(key);
    entries.set(key, {
      frame,
      cachedAtMs: nowMs(),
      frameExpiresAtMs: normalizeNonNegativeInteger(frameExpiresAtMs, 0),
    });
    while (maxEntries > 0 && entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function remove(id) {
    if (typeof id !== "string") return false;
    return entries.delete(id.trim());
  }

  function activeFrames() {
    const atMs = nowMs();
    const frames = [];
    for (const [key, entry] of entries) {
      if (isStale(entry, atMs)) {
        entries.delete(key);
        continue;
      }
      frames.push(entry.frame);
    }
    return frames;
  }

  function size() {
    return entries.size;
  }

  function clear() {
    entries.clear();
  }

  return { set, remove, activeFrames, size, clear };
}

module.exports = { createApprovalReplayCache };
