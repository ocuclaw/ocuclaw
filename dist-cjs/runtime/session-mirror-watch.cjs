const fs = require("node:fs");
const path = require("node:path");

const MIRROR_ORIGIN = "desktop";

const MIRROR_AUTHOR = "Desktop";

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_OWN_TURN_QUIET_MS = 1500;
const DEFAULT_TAIL_LIMIT = 50;
const REARM_BACKOFF_MS = 1000;
const MAX_REARM_ATTEMPTS = 5;
const DEFAULT_OWN_PLATFORM = "ocuclaw";

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toRowId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function shapeMirrorRows(messages, afterId) {
  const rows = [];
  const floor = toRowId(afterId);
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role === "user" || msg.role === "assistant" ? msg.role : null;
    if (!role) continue;
    const id = toRowId(msg.id);
    if (id === null) continue;
    if (floor !== null && id <= floor) continue;
    const content = msg.content;
    if (typeof content === "string" ? !content : !Array.isArray(content) || content.length === 0) {
      continue;
    }
    rows.push({ ...msg, role, id });
  }
  rows.sort((a, b) => a.id - b.id);
  return rows;
}

function createSessionMirrorWatch(opts = {}) {
  const readWatermark = opts.readWatermark;
  const readTail = opts.readTail;
  const onRows = typeof opts.onRows === "function" ? opts.onRows : () => {};
  const onRehydrate = typeof opts.onRehydrate === "function" ? opts.onRehydrate : () => {};
  const isOwnTurnActive =
    typeof opts.isOwnTurnActive === "function" ? opts.isOwnTurnActive : () => false;
  const onDebug = typeof opts.onDebug === "function" ? opts.onDebug : () => {};
  const logger = opts.logger || console;
  const fsImpl = opts.fs || fs;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;
  const ownTurnQuietMs = Number.isFinite(opts.ownTurnQuietMs)
    ? opts.ownTurnQuietMs
    : DEFAULT_OWN_TURN_QUIET_MS;
  const tailLimit = Number.isFinite(opts.tailLimit) ? opts.tailLimit : DEFAULT_TAIL_LIMIT;
  const ownPlatform = cleanString(opts.ownPlatform) || DEFAULT_OWN_PLATFORM;
  if (typeof readWatermark !== "function" || typeof readTail !== "function") {
    throw new Error("createSessionMirrorWatch requires readWatermark(key) and readTail(key, afterId, limit)");
  }

  let armedKey = null;
  let generation = 0;
  let sessionId = null;
  let watermark = null;
  let dbPath = null;
  let hermesHome = null;
  let tailUnsupported = false;
  let ownQuietUntil = 0;
  let watch = null;
  let debounceTimer = null;
  let rearmTimers = 0;
  let refreshInFlight = null;
  let refreshQueued = false;
  let lastEventAtMs = null;
  let lastMirrorLatencyMs = null;
  let lastMirrorAtMs = null;
  const counters = {
    events: 0,
    reads: 0,
    tails: 0,
    rowsMirrored: 0,
    silentAdvances: 0,
    rehydrates: 0,
    rearms: 0,
  };

  function debug(event, data = {}) {
    try {
      onDebug(event, { key: armedKey, ...data });
    } catch {

    }
  }

  function diagnostics() {
    return {
      armedKey,
      sessionId,
      watermark,
      dbPath,
      hermesHome,
      watch: watch
        ? { dir: watch.dir, files: Array.from(watch.files), live: !!watch.watcher }
        : null,
      watchCount: watch && watch.watcher ? 1 : 0,
      timerCount: (debounceTimer ? 1 : 0) + rearmTimers,
      refreshInFlight: !!refreshInFlight,
      sqlOnIdle: 0,
      tailUnsupported,
      ownQuietUntil,
      lastEventAtMs,
      lastMirrorAtMs,
      lastMirrorLatencyMs,
      counters: { ...counters },
    };
  }

  function closeWatch() {
    if (watch && watch.watcher) {
      try {
        watch.watcher.close();
      } catch {

      }
    }
    watch = null;
  }

  function scheduleRefresh(reason) {
    if (!armedKey) return;
    counters.events += 1;
    lastEventAtMs = now();
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refresh(reason).catch(() => {});
    }, debounceMs);
    if (typeof debounceTimer.unref === "function") debounceTimer.unref();
  }

  function openWatch(myGeneration) {
    if (!watch || watch.watcher || myGeneration !== generation) return;
    const entry = watch;
    if (!fsImpl.existsSync(entry.dir)) {
      logger.warn(`[session-mirror] ${entry.dir} does not exist; mirror unavailable`);
      debug("watch_unavailable", { reason: "db_dir_missing", dir: entry.dir });
      return;
    }
    try {
      const watcher = fsImpl.watch(entry.dir, { persistent: false }, (eventType, filename) => {
        if (myGeneration !== generation) return;
        const changed = typeof filename === "string" ? filename : "";

        if (changed && !entry.files.has(changed)) return;
        scheduleRefresh(`db:${eventType}`);
      });
      watcher.on("error", (err) => {
        if (myGeneration !== generation) return;
        logger.warn(`[session-mirror] watch errored: ${err && err.message}`);
        entry.watcher = null;
        rearm(myGeneration);
      });
      watcher.on("close", () => {
        if (myGeneration !== generation) return;
        if (entry.watcher === watcher) {
          entry.watcher = null;
          rearm(myGeneration);
        }
      });
      entry.watcher = watcher;
      entry.attempts = 0;
    } catch (err) {
      logger.warn(`[session-mirror] watch on ${entry.dir} failed: ${err && err.message}`);
      entry.watcher = null;
      rearm(myGeneration);
    }
  }

  function rearm(myGeneration) {
    const entry = watch;
    if (!entry || myGeneration !== generation) return;
    if (entry.attempts >= MAX_REARM_ATTEMPTS) {
      logger.warn(`[session-mirror] watch gave up after ${entry.attempts} re-arms`);
      debug("watch_gave_up", {});
      return;
    }
    entry.attempts += 1;
    counters.rearms += 1;
    rearmTimers += 1;
    const timer = setTimeout(() => {
      rearmTimers -= 1;
      if (myGeneration !== generation) return;
      openWatch(myGeneration);
      scheduleRefresh("rearmed");
    }, REARM_BACKOFF_MS * entry.attempts);
    if (typeof timer.unref === "function") timer.unref();
  }

  function armWatch(result, myGeneration) {
    const file = cleanString(result && result.dbPath);
    if (!file) {
      debug("watch_unavailable", { reason: "no_db_path" });
      return;
    }
    dbPath = file;
    hermesHome = cleanString(result && result.hermesHome) || path.dirname(file);
    const base = path.basename(file);
    watch = {
      dir: path.dirname(file),
      files: new Set([base, `${base}-wal`]),
      watcher: null,
      attempts: 0,
    };
    openWatch(myGeneration);
    debug("watch_armed", { dbPath, watch: diagnostics().watch });
  }

  function ownTurnSignalled(result) {
    const inflight = result && result.inflight && typeof result.inflight === "object" ? result.inflight : null;
    if (inflight && inflight.active === true) {
      const platform = cleanString(inflight.platform);

      if (!platform || platform === ownPlatform) return "inflight";
    }
    if (now() < ownQuietUntil) return "quiet_window";
    try {
      if (isOwnTurnActive() === true) return "own_turn_hint";
    } catch {

    }
    return null;
  }

  async function refresh(reason = "manual") {
    if (!armedKey) return null;
    if (refreshInFlight) {
      refreshQueued = true;
      return refreshInFlight;
    }
    const key = armedKey;
    const myGeneration = generation;
    const eventAt = lastEventAtMs;
    counters.reads += 1;
    refreshInFlight = (async () => {
      let result = null;
      try {
        result = await readWatermark(key);
      } catch (err) {
        logger.warn(`[session-mirror] watermark read failed for ${key}: ${err && err.message}`);
        debug("watermark_read_failed", { reason, error: err && err.message });
        return null;
      }
      if (myGeneration !== generation || armedKey !== key) return null;
      if (!watch) armWatch(result, myGeneration);
      const nextSessionId = cleanString(result && result.sessionId);
      const nextWatermark = toRowId(result && result.watermark);
      if (sessionId === null) {

        sessionId = nextSessionId;
        watermark = nextWatermark;
        debug("baseline", { reason, sessionId, watermark });
        return { sessionId, watermark, mirrored: 0 };
      }
      if (nextSessionId && nextSessionId !== sessionId) {
        const previous = sessionId;
        sessionId = nextSessionId;
        watermark = nextWatermark;
        counters.rehydrates += 1;
        debug("transcript_moved", { reason, from: previous, to: sessionId, watermark });
        try {
          await onRehydrate({ sessionKey: key, sessionId, watermark, reason: "transcript_moved" });
        } catch (err) {
          logger.warn(`[session-mirror] rehydrate failed for ${key}: ${err && err.message}`);
        }
        return { sessionId, watermark, mirrored: 0, rehydrated: true };
      }
      if (nextWatermark === null || (watermark !== null && nextWatermark <= watermark)) {
        debug("unchanged", { reason, watermark });
        return { sessionId, watermark, mirrored: 0 };
      }
      const own = ownTurnSignalled(result);
      if (own || tailUnsupported) {
        const previous = watermark;
        watermark = nextWatermark;
        counters.silentAdvances += 1;
        debug("silent_advance", { reason, why: own || "tail_unsupported", from: previous, to: watermark });
        return { sessionId, watermark, mirrored: 0, silent: true };
      }
      const afterId = watermark === null ? 0 : watermark;
      let tail = null;
      counters.tails += 1;
      try {
        tail = await readTail(key, afterId, tailLimit);
      } catch (err) {
        logger.warn(`[session-mirror] tail read failed for ${key}: ${err && err.message}`);
        debug("tail_read_failed", { reason, afterId, error: err && err.message });
        return { sessionId, watermark, mirrored: 0 };
      }
      if (myGeneration !== generation || armedKey !== key) return null;
      if (tail && tail.rowIdsUnavailable === true) {
        tailUnsupported = true;
        watermark = nextWatermark;
        logger.warn(`[session-mirror] ${key}: hermes reports no row ids; Desktop rows will not mirror live`);
        debug("tail_unsupported", { reason });
        return { sessionId, watermark, mirrored: 0, silent: true };
      }
      const rows = shapeMirrorRows(tail && tail.messages, afterId);
      let highest = nextWatermark;
      for (const row of rows) if (row.id > highest) highest = row.id;
      const previous = watermark;
      watermark = highest;
      if (rows.length === 0) {
        debug("moved_without_rows", { reason, from: previous, to: watermark });
        return { sessionId, watermark, mirrored: 0 };
      }
      counters.rowsMirrored += rows.length;
      lastMirrorAtMs = now();
      lastMirrorLatencyMs = eventAt !== null ? Math.max(0, lastMirrorAtMs - eventAt) : null;
      debug("rows_mirrored", {
        reason,
        from: previous,
        to: watermark,
        rows: rows.length,
        roles: rows.map((row) => row.role),
        latencyMs: lastMirrorLatencyMs,
      });
      try {
        onRows(rows, { sessionKey: key, sessionId, watermark, reason });
      } catch (err) {
        logger.warn(`[session-mirror] onRows failed: ${err && err.message}`);
      }
      return { sessionId, watermark, mirrored: rows.length };
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
      if (refreshQueued) {
        refreshQueued = false;
        if (armedKey) refresh("coalesced").catch(() => {});
      }
    }
  }

  function arm(key) {
    const next = cleanString(key);
    if (!next) return Promise.resolve(null);
    if (armedKey === next) return Promise.resolve(diagnostics());
    disarm();
    generation += 1;
    armedKey = next;
    debug("armed", {});
    return refresh("arm");
  }

  function disarm() {
    if (!armedKey && !watch) return;
    generation += 1;
    const previous = armedKey;
    armedKey = null;
    closeWatch();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    sessionId = null;
    watermark = null;
    dbPath = null;
    hermesHome = null;
    tailUnsupported = false;
    ownQuietUntil = 0;
    lastEventAtMs = null;
    debug("disarmed", { previousKey: previous });
  }

  function noteOwnActivity(sessionKey, reason = "own_activity") {
    const key = cleanString(sessionKey);
    if (!armedKey || (key && key !== armedKey)) return false;
    ownQuietUntil = now() + ownTurnQuietMs;
    debug("own_activity", { reason, quietUntil: ownQuietUntil });
    return true;
  }

  function noteOwnTurnEnd(sessionKey, reason = "own_turn_end") {
    if (!noteOwnActivity(sessionKey, reason)) return Promise.resolve(null);
    return refresh(reason);
  }

  return {
    arm,
    disarm,
    refresh,
    noteOwnActivity,
    noteOwnTurnEnd,
    armedKey: () => armedKey,
    watermark: () => watermark,
    diagnostics,
  };
}

module.exports = { MIRROR_ORIGIN, MIRROR_AUTHOR, shapeMirrorRows, createSessionMirrorWatch };
