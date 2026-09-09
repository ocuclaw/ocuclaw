const fs = require("node:fs");
const path = require("node:path");

const DRIVER_STATES = Object.freeze({
  glassesDrive: "glasses_drive",
  desktopHold: "desktop_hold",
  desktopWorking: "desktop_working",
});

const DEFAULT_DEBOUNCE_MS = 150;
const REARM_BACKOFF_MS = 1000;
const MAX_REARM_ATTEMPTS = 5;
const DEFAULT_LIVENESS_MS = 5000;
const MAX_LIVENESS_BACKOFF_MS = 30000;

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeState(value) {
  const text = cleanString(value);
  if (
    text === DRIVER_STATES.desktopHold ||
    text === DRIVER_STATES.desktopWorking ||
    text === DRIVER_STATES.glassesDrive
  ) {
    return text;
  }

  return DRIVER_STATES.glassesDrive;
}

function buildSessionDriverSnapshot(key, result, options = {}) {
  const state = normalizeState(result && result.state);
  const takeOver = options.takeOver === true && state !== DRIVER_STATES.glassesDrive;
  const hold = result && result.hold && typeof result.hold === "object" ? result.hold : null;
  const inflight =
    result && result.inflight && typeof result.inflight === "object" ? result.inflight : null;
  const pid = hold && Number.isFinite(Number(hold.pid)) ? Number(hold.pid) : null;
  return {
    sessionKey: key,
    state,
    locked: state !== DRIVER_STATES.glassesDrive && !takeOver,
    takeOver,
    holdState: cleanString(result && result.holdState),
    holdSurface: cleanString(hold && hold.surface),
    holdPid: pid,
    holdSessionId: cleanString(hold && hold.sessionId),
    inflight: !!(inflight && inflight.active === true),
    inflightPlatform: cleanString(inflight && inflight.platform),
    sessionId: cleanString(result && result.sessionId),
    updatedAtMs: Number.isFinite(options.nowMs) ? options.nowMs : Date.now(),
  };
}

function sessionDriverSnapshotsEqual(a, b) {
  if (!a || !b) return a === b;
  return (
    a.sessionKey === b.sessionKey &&
    a.state === b.state &&
    a.locked === b.locked &&
    a.takeOver === b.takeOver &&
    a.holdState === b.holdState &&
    a.holdSurface === b.holdSurface &&
    a.holdPid === b.holdPid &&
    a.holdSessionId === b.holdSessionId &&
    a.inflight === b.inflight &&
    a.inflightPlatform === b.inflightPlatform &&
    a.sessionId === b.sessionId
  );
}

function createSessionDriverWatch(opts = {}) {
  const request = opts.request;
  const onState = typeof opts.onState === "function" ? opts.onState : () => {};
  const onDebug = typeof opts.onDebug === "function" ? opts.onDebug : () => {};
  const logger = opts.logger || console;
  const fsImpl = opts.fs || fs;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;
  const livenessMs =
    Number.isFinite(opts.livenessMs) && opts.livenessMs > 0 ? opts.livenessMs : DEFAULT_LIVENESS_MS;
  if (typeof request !== "function") {
    throw new Error("createSessionDriverWatch requires request(key)");
  }

  let armedKey = null;
  let generation = 0;
  let snapshot = null;
  let takeOver = false;
  let hermesHome = null;
  let watchSpec = null;
  let lastResult = null;

  const watches = new Map();
  let debounceTimer = null;
  let refreshInFlight = null;
  let refreshQueued = false;
  let rearmTimers = 0;

  let livenessTimer = null;
  let livenessFailures = 0;
  let livenessArmedAtMs = null;
  const counters = { events: 0, refreshes: 0, rearms: 0, livenessRefreshes: 0 };

  function debug(event, data = {}) {
    try {
      onDebug(event, { key: armedKey, ...data });
    } catch {

    }
  }

  function diagnostics() {
    return {
      armedKey,
      hermesHome,
      watches: Array.from(watches.entries()).map(([name, entry]) => ({
        name,
        dir: entry.dir,
        file: entry.file,
        live: !!entry.watcher,
        fallback: entry.fallback === true,
      })),
      watchCount: Array.from(watches.values()).filter((entry) => !!entry.watcher).length,
      timerCount: (debounceTimer ? 1 : 0) + rearmTimers + (livenessTimer ? 1 : 0),
      refreshInFlight: !!refreshInFlight,
      sqlOnIdle: 0,
      liveness: {
        active: !!livenessTimer,
        intervalMs: livenessMs,
        delayMs: livenessDelayMs(),
        failures: livenessFailures,
        armedAtMs: livenessArmedAtMs,
        refreshes: counters.livenessRefreshes,
      },
      counters: { ...counters },
      snapshot,
    };
  }

  function livenessDelayMs() {

    return Math.min(livenessMs * 2 ** Math.min(livenessFailures, 10), MAX_LIVENESS_BACKOFF_MS);
  }

  function livenessWanted() {
    return !!armedKey && !!snapshot && snapshot.state !== DRIVER_STATES.glassesDrive;
  }

  function stopLiveness(reason) {

    if (!livenessTimer && livenessArmedAtMs === null) return;
    if (livenessTimer) clearTimeout(livenessTimer);
    livenessTimer = null;
    livenessArmedAtMs = null;
    livenessFailures = 0;
    debug("liveness_stopped", { reason });
  }

  function syncLiveness(reason) {
    if (!livenessWanted()) {
      stopLiveness(reason);
      return;
    }
    if (livenessTimer) return;
    const myGeneration = generation;
    const delay = livenessDelayMs();
    if (livenessArmedAtMs === null) {
      livenessArmedAtMs = now();
      debug("liveness_armed", { reason, intervalMs: livenessMs, state: snapshot.state });
    }
    livenessTimer = setTimeout(() => {
      livenessTimer = null;
      if (myGeneration !== generation || !livenessWanted()) return;
      counters.livenessRefreshes += 1;
      refresh("liveness").catch(() => {});
    }, delay);
    if (typeof livenessTimer.unref === "function") livenessTimer.unref();
  }

  function emit(next, reason = null) {
    if (sessionDriverSnapshotsEqual(snapshot, next)) {
      snapshot = next;
      return;
    }
    const previous = snapshot;
    snapshot = next;
    debug("driver_state", {
      reason,
      from: previous ? previous.state : null,
      to: next.state,
      locked: next.locked,
      takeOver: next.takeOver,
      holdState: next.holdState,
      holdPid: next.holdPid,
      inflight: next.inflight,
    });
    try {
      onState(next);
    } catch (err) {
      logger.warn(`[session-driver] onState failed: ${err && err.message}`);
    }
  }

  function closeWatches() {
    for (const entry of watches.values()) {
      try {
        if (entry.watcher) entry.watcher.close();
      } catch {

      }
    }
    watches.clear();
  }

  function scheduleRefresh(reason) {
    if (!armedKey) return;
    counters.events += 1;
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refresh(reason).catch(() => {});
    }, debounceMs);
    if (typeof debounceTimer.unref === "function") debounceTimer.unref();
  }

  function openWatch(name, dir, file, myGeneration) {
    const existing = watches.get(name);
    if (existing && existing.watcher) return;
    const entry = existing || { attempts: 0 };
    entry.dir = dir;
    entry.file = file;
    entry.fallback = false;
    let target = dir;
    if (!fsImpl.existsSync(dir)) {

      target = path.dirname(dir);
      entry.fallback = true;
    }
    try {
      const watcher = fsImpl.watch(target, { persistent: false }, (eventType, filename) => {
        if (myGeneration !== generation) return;
        const changed = typeof filename === "string" ? filename : "";
        if (entry.fallback) {
          if (changed === path.basename(dir) && fsImpl.existsSync(dir)) {
            try {
              watcher.close();
            } catch {

            }
            entry.watcher = null;
            openWatch(name, dir, file, myGeneration);
            scheduleRefresh(`${name}_dir_appeared`);
          }
          return;
        }

        if (changed && changed !== file && !changed.startsWith(".turn-marker-") && !changed.startsWith("active_sessions")) {
          return;
        }
        scheduleRefresh(`${name}:${eventType}`);
      });
      watcher.on("error", (err) => {
        if (myGeneration !== generation) return;
        logger.warn(`[session-driver] watch ${name} errored: ${err && err.message}`);
        entry.watcher = null;
        rearm(name, dir, file, myGeneration);
      });
      watcher.on("close", () => {
        if (myGeneration !== generation) return;
        if (entry.watcher === watcher) {
          entry.watcher = null;
          rearm(name, dir, file, myGeneration);
        }
      });
      entry.watcher = watcher;
      entry.attempts = 0;
      watches.set(name, entry);
    } catch (err) {
      logger.warn(`[session-driver] watch ${name} on ${target} failed: ${err && err.message}`);
      entry.watcher = null;
      watches.set(name, entry);
      rearm(name, dir, file, myGeneration);
    }
  }

  function rearm(name, dir, file, myGeneration) {
    const entry = watches.get(name);
    if (!entry || myGeneration !== generation) return;
    if (entry.attempts >= MAX_REARM_ATTEMPTS) {
      logger.warn(`[session-driver] watch ${name} gave up after ${entry.attempts} re-arms`);
      debug("watch_gave_up", { name });
      return;
    }
    entry.attempts += 1;
    counters.rearms += 1;
    rearmTimers += 1;
    const timer = setTimeout(() => {
      rearmTimers -= 1;
      if (myGeneration !== generation) return;
      openWatch(name, dir, file, myGeneration);
      scheduleRefresh(`${name}_rearmed`);
    }, REARM_BACKOFF_MS * entry.attempts);
    if (typeof timer.unref === "function") timer.unref();
  }

  function armWatches(result, myGeneration) {
    const home = cleanString(result && result.hermesHome);
    if (!home) {
      debug("watch_unavailable", { reason: "no_hermes_home" });
      return;
    }
    const spec = result && result.watch && typeof result.watch === "object" ? result.watch : {};
    hermesHome = home;
    watchSpec = {
      markerDir: cleanString(spec.markerDir) || "desktop",
      markerFile: cleanString(spec.markerFile) || "interrupted_turns.json",
      leaseDir: cleanString(spec.leaseDir) || "runtime",
      leaseFile: cleanString(spec.leaseFile) || "active_sessions.json",
    };
    openWatch("marker", path.join(home, watchSpec.markerDir), watchSpec.markerFile, myGeneration);
    openWatch("lease", path.join(home, watchSpec.leaseDir), watchSpec.leaseFile, myGeneration);
    debug("watches_armed", { hermesHome, watches: diagnostics().watches });
  }

  async function refresh(reason = "manual") {
    if (!armedKey) return snapshot;
    if (refreshInFlight) {
      refreshQueued = true;
      return refreshInFlight;
    }
    const key = armedKey;
    const myGeneration = generation;
    counters.refreshes += 1;
    refreshInFlight = (async () => {
      let result = null;
      try {
        result = await request(key);
      } catch (err) {
        logger.warn(`[session-driver] driver read failed for ${key}: ${err && err.message}`);
        debug("driver_read_failed", { reason, error: err && err.message });
        result = null;
      }
      if (myGeneration !== generation || armedKey !== key) return snapshot;
      if (result) lastResult = result;
      if (result && watches.size === 0) armWatches(result, myGeneration);
      if (!result && snapshot) {

        livenessFailures += 1;
        syncLiveness(reason);
        return snapshot;
      }
      livenessFailures = 0;
      const next = buildSessionDriverSnapshot(key, result, { takeOver, nowMs: now() });
      if (next.state === DRIVER_STATES.glassesDrive && takeOver) {

        takeOver = false;
      }
      emit(next, reason);
      syncLiveness(reason);
      return next;
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
    if (!next) return Promise.resolve(snapshot);
    if (armedKey === next) return refresh("rearm");
    disarm();
    generation += 1;
    armedKey = next;
    takeOver = false;
    debug("armed", {});
    return refresh("arm");
  }

  function disarm() {
    if (!armedKey && watches.size === 0) return;
    generation += 1;
    const previous = armedKey;
    armedKey = null;
    takeOver = false;
    closeWatches();
    stopLiveness("disarm");
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watchSpec = null;
    hermesHome = null;
    lastResult = null;
    if (snapshot) {

      const released = {
        ...snapshot,
        state: DRIVER_STATES.glassesDrive,
        locked: false,
        takeOver: false,
        holdState: null,
        holdSurface: null,
        holdPid: null,
        holdSessionId: null,
        updatedAtMs: now(),
      };
      snapshot = null;
      debug("disarmed", { previousKey: previous });
      try {
        onState(released);
      } catch {

      }
    }
  }

  async function requestTakeOver(key) {
    const target = cleanString(key);
    if (!armedKey || (target && target !== armedKey)) {
      return { ok: false, error: "session_not_armed", snapshot };
    }
    const current = await refresh("takeover_precheck");
    if (!current || current.state === DRIVER_STATES.glassesDrive) {
      return { ok: true, snapshot: current, noop: true };
    }
    if (current.state === DRIVER_STATES.desktopWorking) {
      return { ok: false, error: "desktop_working", snapshot: current };
    }
    takeOver = true;
    debug("take_over", {});
    const next = buildSessionDriverSnapshot(armedKey, lastResult, { takeOver: true, nowMs: now() });
    emit(next);
    return { ok: true, snapshot: next };
  }

  return {
    arm,
    disarm,
    refresh,
    requestTakeOver,
    snapshot: () => snapshot,
    armedKey: () => armedKey,
    diagnostics,
  };
}

module.exports = { DRIVER_STATES, buildSessionDriverSnapshot, sessionDriverSnapshotsEqual, createSessionDriverWatch };
