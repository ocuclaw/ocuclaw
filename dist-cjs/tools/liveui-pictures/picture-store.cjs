const PICTURE_STORE_SESSION_MAX_BYTES = 16 * 1024 * 1024;
const PICTURE_STORE_PROCESS_MAX_BYTES = 64 * 1024 * 1024;

const entryKey = (k                 )         => JSON.stringify([k.sessionKey, k.surfaceId, k.id]);
const surfaceKey = (sessionKey        , surfaceId        )         => JSON.stringify([sessionKey, surfaceId]);

function positive(value         , fallback        )         {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function createPictureByteStore(opts                          = {})                   {
  const sessionMax = positive(opts.sessionMaxBytes, PICTURE_STORE_SESSION_MAX_BYTES);
  const processMax = positive(opts.processMaxBytes, PICTURE_STORE_PROCESS_MAX_BYTES);

  const entries = new Map               ();
  const sessionBytes = new Map                ();
  const pins = new Map                     ();
  let totalBytes = 0;
  let evictions = 0;

  const isPinned = (k                 )          => {
    const set = pins.get(surfaceKey(k.sessionKey, k.surfaceId));
    return !!set && set.has(k.id);
  };

  function remove(id        )               {
    const entry = entries.get(id);
    if (!entry) return null;
    entries.delete(id);
    totalBytes -= entry.size;
    const left = (sessionBytes.get(entry.key.sessionKey) || 0) - entry.size;
    if (left > 0) sessionBytes.set(entry.key.sessionKey, left);
    else sessionBytes.delete(entry.key.sessionKey);
    return entry;
  }

  function victim(sessionKey               )                {
    let pinnedFallback                = null;
    for (const [id, entry] of entries) {
      if (sessionKey !== null && entry.key.sessionKey !== sessionKey) continue;
      if (!isPinned(entry.key)) return id;
      if (pinnedFallback === null) pinnedFallback = id;
    }
    return pinnedFallback;
  }

  function evictUntil(over               , sessionKey               , out                   )       {
    while (over()) {
      const id = victim(sessionKey);
      if (id === null) return;
      const entry = remove(id);
      if (!entry) return;
      evictions += 1;
      out.push({ ...entry.key });
    }
  }

  return {
    put(key, value) {
      const id = entryKey(key);
      remove(id);
      const size = value && value.bytes ? value.bytes.length : 0;
      const stored        = { key: { sessionKey: key.sessionKey, surfaceId: key.surfaceId, id: key.id }, value, size };
      entries.set(id, stored);
      totalBytes += size;
      sessionBytes.set(key.sessionKey, (sessionBytes.get(key.sessionKey) || 0) + size);
      const evicted                    = [];
      evictUntil(() => (sessionBytes.get(key.sessionKey) || 0) > sessionMax, key.sessionKey, evicted);
      evictUntil(() => totalBytes > processMax, null, evicted);
      if (opts.onEvict) {
        for (const k of evicted) {
          try {
            opts.onEvict(k);
          } catch {

          }
        }
      }
      return evicted;
    },
    get(key) {
      const id = entryKey(key);
      const entry = entries.get(id);
      if (!entry) return null;
      entries.delete(id);
      entries.set(id, entry);
      return entry.value;
    },
    has(key) {
      return entries.has(entryKey(key));
    },
    release(key) {
      return remove(entryKey(key)) !== null;
    },
    releaseSurface(sessionKey, surfaceId) {
      let count = 0;
      for (const [id, entry] of [...entries]) {
        if (entry.key.sessionKey === sessionKey && entry.key.surfaceId === surfaceId) {
          remove(id);
          count += 1;
        }
      }
      pins.delete(surfaceKey(sessionKey, surfaceId));
      return count;
    },
    releaseSession(sessionKey) {
      let count = 0;
      for (const [id, entry] of [...entries]) {
        if (entry.key.sessionKey === sessionKey) {
          remove(id);
          count += 1;
        }
      }
      for (const k of [...pins.keys()]) {
        if (JSON.parse(k)[0] === sessionKey) pins.delete(k);
      }
      return count;
    },
    pinOnGlass(sessionKey, surfaceId, ids) {
      const list = Array.isArray(ids) ? ids.filter((i) => typeof i === "string") : [];
      if (list.length === 0) pins.delete(surfaceKey(sessionKey, surfaceId));
      else pins.set(surfaceKey(sessionKey, surfaceId), new Set(list));
    },
    stats() {
      let pinned = 0;
      for (const entry of entries.values()) if (isPinned(entry.key)) pinned += 1;
      return {
        entries: entries.size,
        bytes: totalBytes,
        sessions: sessionBytes.size,
        pinned,
        evictions,
        sessionMaxBytes: sessionMax,
        processMaxBytes: processMax,
      };
    },
  };
}

module.exports = { PICTURE_STORE_SESSION_MAX_BYTES, PICTURE_STORE_PROCESS_MAX_BYTES, createPictureByteStore };
