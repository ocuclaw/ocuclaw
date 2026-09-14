const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { projectSessionDriverFields } = require("./session-driver-projection.cjs");

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
  const conflicting = result?.inflight?.active === true && result.inflight.platform !== "ocuclaw";
  const state = conflicting ? DRIVER_STATES.desktopWorking : normalizeState(result && result.state);
  const takeOver = options.takeOver === true && state === DRIVER_STATES.desktopHold;
  const hold = result && result.hold && typeof result.hold === "object" ? result.hold : null;
  const inflight =
    result && result.inflight && typeof result.inflight === "object" ? result.inflight : null;
  const pid = hold && Number.isFinite(Number(hold.pid)) ? Number(hold.pid) : null;
  return {
    sessionKey: key,
    state,
    locked: state !== DRIVER_STATES.glassesDrive && !takeOver,
    takeOver,
    uncertain: options.uncertain === true,
    takeOverAllowed: state === DRIVER_STATES.desktopHold && options.uncertain !== true && !!cleanString(hold?.generation),
    holdGeneration: cleanString(hold?.generation),
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
    a.uncertain === b.uncertain &&
    a.takeOverAllowed === b.takeOverAllowed &&
    a.holdGeneration === b.holdGeneration &&
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
  let takeOver = null;
  let hermesHome = null;
  let watchSpec = null;
  let lastResult = null;
  let acceptedRead = 0;
  const observationEpoch = randomUUID();
  let observedAtMs = null;
  let receiverFingerprint = null;
  function holderScope(result) {
    const holder = cleanString(result?.hold?.generation);
    if (!holder || !result?.hermesHome || !result?.sessionId) return null;
    return JSON.stringify([armedKey, result.hermesHome, result.sessionId,
      result.lineage, result.hold.surface, result.hold.pid, result.hold.sessionId, holder]);
  }

  const watches = new Map();
  let debounceTimer = null;
  let refreshInFlight = null;
  let refreshQueued = false;
  let rearmTimers = 0;
  const rearmTimerHandles = new Set();

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

  function failure(reason, phase) {
    const correlationId = `driver-${generation}-${counters.refreshes}`;
    logger.warn(`[session-driver] ${reason} phase=${phase} correlation=${correlationId}`);
    debug(reason, { reason, phase, correlationId });
  }

  function diagnostics() {

    return {
      armedKey,
      watches: Array.from(watches.entries()).map(([name, entry]) => ({
        name,
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
    return !!armedKey && !!snapshot && (snapshot.uncertain || snapshot.state !== DRIVER_STATES.glassesDrive);
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
      failure("state_delivery_failed", "publish");
    }
  }

  function closeWatches() {
    for (const timer of rearmTimerHandles) clearTimeout(timer);
    rearmTimerHandles.clear();
    rearmTimers = 0;
    for (const entry of watches.values()) {
      try {
        const watcher = entry.watcher;
        entry.watcher = null;
        if (watcher) watcher.close();
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
        if (myGeneration !== generation || watches.get(name) !== entry) return;
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
        if (myGeneration !== generation || watches.get(name) !== entry) return;
        failure("watch_failed", "observe");
        entry.watcher = null;
        watcher.close();
        rearm(name, dir, file, myGeneration);
      });
      watcher.on("close", () => {
        if (myGeneration !== generation || watches.get(name) !== entry) return;
        if (entry.watcher === watcher) {
          entry.watcher = null;
          rearm(name, dir, file, myGeneration);
        }
      });
      entry.watcher = watcher;
      entry.attempts = 0;
      watches.set(name, entry);
    } catch (err) {
      failure("watch_open_failed", "observe");
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
      rearmTimerHandles.delete(timer);
      rearmTimers -= 1;
      if (myGeneration !== generation || watches.get(name) !== entry) return;
      openWatch(name, dir, file, myGeneration);
      scheduleRefresh(`${name}_rearmed`);
    }, REARM_BACKOFF_MS * entry.attempts);
    rearmTimerHandles.add(timer);
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
    debug("watches_armed", { watchCount: watches.size });
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
        failure("driver_read_failed", "observe");
        result = null;
      }
      if (myGeneration !== generation || armedKey !== key) return snapshot;

      if (result?.publicKey && result.publicKey !== key) {
        failure("foreign_reply_discarded", "identity");
        syncLiveness(reason);
        return snapshot;
      }
      if (result?.hermesHome && hermesHome && result.hermesHome !== hermesHome) closeWatches();
      if (result && watches.size === 0) armWatches(result, myGeneration);
      const valid = result?.status === "ok" && result.uncertain !== true &&
        (!result.publicKey || result.publicKey === key) &&
        Object.values(DRIVER_STATES).includes(result.state);
      if (!valid) {

        livenessFailures += 1;
        lastResult = null;
        const conflicting = result?.inflight?.active === true && result.inflight.platform !== "ocuclaw";
        if (conflicting) takeOver = null;
        emit(conflicting ? buildSessionDriverSnapshot(key, result, { nowMs: now(), uncertain: true }) : snapshot ? { ...snapshot, uncertain: true, takeOverAllowed: false } : {
          ...buildSessionDriverSnapshot(key, null, { nowMs: now(), uncertain: true }), locked: true,
        }, reason);
        syncLiveness(reason);
        return snapshot;
      }
      lastResult = result;
      acceptedRead += 1;
      observedAtMs = now();
      try {
        receiverFingerprint = createHash("sha256").update(fs.realpathSync(result.hermesHome)).digest("hex");
      } catch { receiverFingerprint = null; }
      livenessFailures = 0;
      const scope = holderScope(result);
      if (takeOver !== scope || result.state !== DRIVER_STATES.desktopHold ||
          (result.inflight?.active && result.inflight.platform !== "ocuclaw")) takeOver = null;
      const next = buildSessionDriverSnapshot(key, result, { takeOver: !!takeOver, nowMs: observedAtMs });
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
    takeOver = null;
    debug("armed", {});
    return refresh("arm");
  }

  function disarm() {
    if (!armedKey && watches.size === 0) return;
    generation += 1;
    const previous = armedKey;
    armedKey = null;
    takeOver = null;
    closeWatches();
    stopLiveness("disarm");
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watchSpec = null;
    hermesHome = null;
    lastResult = null;
    observedAtMs = null;
    receiverFingerprint = null;
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
    const myGeneration = generation;
    if (refreshInFlight) await refreshInFlight;
    if (myGeneration !== generation) return { ok: false, error: "session_not_armed", snapshot };
    const beforeRead = acceptedRead;
    const current = await refresh("takeover_precheck");
    if (myGeneration !== generation) return { ok: false, error: "session_not_armed", snapshot };
    if (acceptedRead === beforeRead) return { ok: false, error: "ownership_uncertain", snapshot: current };
    if (!current || current.uncertain) return { ok: false, error: "ownership_uncertain", snapshot: current };
    if (!current || current.state === DRIVER_STATES.glassesDrive) {
      return { ok: true, snapshot: current, noop: true };
    }
    if (current.state === DRIVER_STATES.desktopWorking) {
      return { ok: false, error: "desktop_working", snapshot: current };
    }
    const scope = holderScope(lastResult);
    if (!scope) return { ok: false, error: "holder_unverified", snapshot: current };
    takeOver = scope;
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
    projection(key) {
      if (!key || key !== armedKey || snapshot?.sessionKey !== key || !receiverFingerprint || observedAtMs === null) return null;

      if (watches.size !== 2 || [...watches.values()].some(entry => !entry.watcher)) return null;
      return {
        contract: "ocuclaw.session-driver-projection", contractVersion: 1,
        ...projectSessionDriverFields(snapshot),
        sessionId: snapshot.sessionId,
        receiverFingerprint,
        observationGeneration: `${observationEpoch}:${generation}:${acceptedRead}`,
        observedAtMs,
      };
    },
    snapshot: () => snapshot,
    armedKey: () => armedKey,
    diagnostics,
  };
}

module.exports = { DRIVER_STATES, buildSessionDriverSnapshot, sessionDriverSnapshotsEqual, createSessionDriverWatch };
