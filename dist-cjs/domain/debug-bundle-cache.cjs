function createBundleCache(opts) {
  const maxEntries = Math.max(1, opts.maxEntries | 0);
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : 5 * 60_000;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  const store = new Map();

  function isExpired(entry) {
    if (ttlMs === 0) return false;
    return now() - entry.cachedMs > ttlMs;
  }

  function dropExpired() {
    for (const [id, entry] of store) {
      if (isExpired(entry)) store.delete(id);
    }
  }

  function put(id, entry) {
    dropExpired();
    if (store.has(id)) store.delete(id);
    store.set(id, entry);
    while (store.size > maxEntries) {
      const firstKey = store.keys().next().value;
      store.delete(firstKey);
    }
  }

  function get(id) {
    const entry = store.get(id);
    if (!entry) return null;
    if (isExpired(entry)) {
      store.delete(id);
      return null;
    }
    return entry;
  }

  function del(id) {
    store.delete(id);
  }

  function size() {
    return store.size;
  }

  function sweep() {
    dropExpired();
  }

  return { put, get, delete: del, size, sweep };
}

module.exports = { createBundleCache };
