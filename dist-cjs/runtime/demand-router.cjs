function createDemandRouter(deps = {}) {
  const inject = typeof deps.inject === "function" ? deps.inject : () => {};
  const dismiss = typeof deps.dismiss === "function" ? deps.dismiss : () => {};
  const onError = typeof deps.onError === "function" ? deps.onError : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const schedule = typeof deps.schedule === "function" ? deps.schedule : setTimeout;
  const cancelScheduled =
    typeof deps.cancelScheduled === "function" ? deps.cancelScheduled : clearTimeout;
  const producers = Array.isArray(deps.producers) ? deps.producers : [];
  const bySurface = new Map();
  const bySession = new Map();

  function forget(entry) {
    if (!entry) return;
    if (bySurface.get(entry.surfaceId) === entry) bySurface.delete(entry.surfaceId);
    if (bySession.get(entry.sessionKey) === entry) bySession.delete(entry.sessionKey);
    if (entry.timer) {
      cancelScheduled(entry.timer);
      entry.timer = null;
    }
  }

  function deliver(entry, choice, reason) {
    if (!entry || typeof entry.onDecision !== "function") return;
    Promise.resolve(entry.onDecision({ choice, reason })).catch((error) => {
      onError({
        reason: "decision_failed",
        surfaceId: entry.surfaceId,
        sessionKey: entry.sessionKey,
        error,
      });
    });
  }

  function retire(entry, reason, notify) {
    if (!entry || entry.locked) return false;
    entry.locked = true;
    forget(entry);
    if (notify) dismiss({ surfaceId: entry.surfaceId, sessionKey: entry.sessionKey, reason });
    deliver(entry, "cancel", reason);
    return true;
  }

  function presentDecision(params = {}) {
    const surface = params && params.surface;
    const surfaceId = surface && typeof surface.surfaceId === "string" ? surface.surfaceId : "";
    const sessionKey = surface && typeof surface.sessionKey === "string" ? surface.sessionKey : "";
    const options = surface && Array.isArray(surface.options) ? surface.options : [];
    if (!surfaceId || !sessionKey || !surface.question || options.length === 0) return false;

    for (const entry of Array.from(bySession.values())) {
      retire(entry, "superseded", false);
    }
    const entry = {
      surfaceId,
      sessionKey,
      options,
      locked: false,
      timer: null,
      onDecision: typeof params.onDecision === "function" ? params.onDecision : null,
    };
    bySession.set(sessionKey, entry);
    bySurface.set(surfaceId, entry);
    const expiresAtMs = Number(params.expiresAtMs);
    if (Number.isFinite(expiresAtMs)) {
      entry.timer = schedule(
        () => retire(entry, "timeout", true),
        Math.max(1, expiresAtMs - now()),
      );
    }
    inject(surface);
    return true;
  }

  function handleOutcome(frame) {
    const surfaceId = frame && typeof frame.surfaceId === "string" ? frame.surfaceId : "";
    const entry = surfaceId ? bySurface.get(surfaceId) : null;
    if (entry && !entry.locked) {
      if (frame.result === "dismissed") {
        retire(entry, "dismissed", false);
        return true;
      }
      if (frame.result !== "selected") return false;
      const index = Number(frame.selectedIndex);
      if (!Number.isInteger(index) || index < 0 || index >= entry.options.length) {
        onError({ reason: "index_out_of_range", surfaceId, index });
        return false;
      }
      const choice = entry.options[index] && entry.options[index].key;
      if (typeof choice !== "string" || !choice) return false;
      entry.locked = true;
      forget(entry);
      deliver(entry, choice, "selected");
      return true;
    }

    for (const producer of producers) {
      if (!producer || typeof producer.matches !== "function" || !producer.matches(frame)) continue;
      return typeof producer.handleOutcome === "function"
        ? producer.handleOutcome(frame)
        : false;
    }
    return false;
  }

  function forgetDecisions(reason = "display_changed") {
    for (const entry of Array.from(bySession.values())) retire(entry, reason, true);
  }

  function forgetAll(reason = "display_changed") {
    forgetDecisions(reason);
    for (const producer of producers) {
      if (producer && typeof producer.forgetAll === "function") producer.forgetAll(reason);
    }
  }

  function activeSurfaceId(sessionKey) {
    const entry = bySession.get(sessionKey);
    return entry ? entry.surfaceId : "";
  }

  return { presentDecision, handleOutcome, forgetDecisions, forgetAll, activeSurfaceId };
}

module.exports = { createDemandRouter };
