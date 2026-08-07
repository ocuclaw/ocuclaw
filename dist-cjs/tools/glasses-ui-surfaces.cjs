const TERMINAL_RESULTS = new Set(["dismissed", "timeout", "glasses_disconnected", "preempted", "recipe_failed"]);

function isTerminalOutcome(outcome) {
  return !!(outcome && typeof outcome.result === "string" && TERMINAL_RESULTS.has(outcome.result));
}

const GLASS_EVENT_ORIGINS = ["gesture", "schedule", "threshold", "system"];

function normalizeGlassesSessionKey(key) {
  return typeof key === "string" ? key.replace(/^agent:[^:]+:/, "") : key;
}

function createSurfaceStore(deps = {}) {

  const storeId =
    typeof deps.storeId === "string" && deps.storeId
      ? deps.storeId
      : `st-${Math.random().toString(36).slice(2, 8)}`;
  const emitLifecycle =
    typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};
  const pauseCron = typeof deps.pauseCron === "function" ? deps.pauseCron : () => {};
  const resumeCron = typeof deps.resumeCron === "function" ? deps.resumeCron : () => {};
  const stopCron = typeof deps.stopCron === "function" ? deps.stopCron : () => {};
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const mintSurfaceId =
    typeof deps.mintSurfaceId === "function"
      ? deps.mintSurfaceId
      : () => `ui-${Math.random().toString(36).slice(2, 10)}`;
  const mintUuid =
    typeof deps.mintUuid === "function"
      ? deps.mintUuid
      : () => `su-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;

  const bySurface = new Map();
  const stackBySession = new Map();

  const DEAD_LETTER_EVENT_CAP = 32;
  const SURFACE_EVENT_LOG_CAP = 32;
  const deadLetterBySession = new Map();
  let eventSeq = 0;

  function deadLetterFor(sessionKey) {
    let list = deadLetterBySession.get(sessionKey);
    if (!list) { list = []; deadLetterBySession.set(sessionKey, list); }
    return list;
  }

  function deadLetterEntryEvents(sessionKey, surfaceId, entry, reason) {

    if (!entry || entry.exitLatched || !entry.events || entry.events.length === 0) return;
    const eventIds = entry.events.map((e) => e.eventId);
    const list = deadLetterFor(sessionKey);
    list.push({
      surfaceUuid: entry.uuid,
      surfaceId,
      events: entry.events,
      reason,
      reapedAtMs: now(),

      staleAfterMs: Number.isFinite(entry.staleAfterMs) ? entry.staleAfterMs : null,
    });
    entry.events = [];

    emitLifecycle("dead_letter_appended", "debug", {
      sessionKey,
      surfaceId,
      surfaceUuid: entry.uuid,
      reason,
      eventIds,
      count: eventIds.length,
    });
    let total = list.reduce((n, r) => n + r.events.length, 0);
    while (total > DEAD_LETTER_EVENT_CAP && list.length) {
      const oldest = list[0];
      const overflow = total - DEAD_LETTER_EVENT_CAP;
      if (oldest.events.length <= overflow) {
        total -= oldest.events.length;
        list.shift();
      } else {
        oldest.events.splice(0, overflow);
        total -= overflow;
      }
    }
  }

  function stackFor(sessionKey) {
    let s = stackBySession.get(sessionKey);
    if (!s) { s = []; stackBySession.set(sessionKey, s); }
    return s;
  }

  function makeEntry(sessionKey, kind, prior) {
    return {
      sessionKey, kind: kind || null, pending: null, lastContent: null,
      state: "visible_pending",
      queuedEvent: prior ? prior.queuedEvent : null,
      exitLatched: prior ? !!prior.exitLatched : false,

      uuid: prior ? prior.uuid : mintUuid(),
      events: prior ? prior.events : [],
      queueMode: prior && prior.queueMode === "log" ? "log" : "latest",

      staleAfterMs: null,

      title: prior ? prior.title : null,
      awaitingAgentResponse: false,
    };
  }

  function register(rawSessionKey, surfaceId, meta) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    return new Promise((resolve) => {
      const existing = bySurface.get(surfaceId);
      if (existing) {

        existing.pending = resolve;
        if (meta && meta.kind) existing.kind = meta.kind;
        if (meta && (meta.queueMode === "log" || meta.queueMode === "latest")) {
          existing.queueMode = meta.queueMode;
        }
        existing.staleAfterMs = meta && Number.isFinite(meta.staleAfterMs) ? meta.staleAfterMs : null;
        if (meta && typeof meta.title === "string") existing.title = meta.title;
        existing.awaitingAgentResponse = false;
        existing.sessionKey = sessionKey;
        existing.state = "visible_pending";
        return;
      }
      const entry = makeEntry(sessionKey, meta && meta.kind ? meta.kind : null);
      if (meta && (meta.queueMode === "log" || meta.queueMode === "latest")) {
        entry.queueMode = meta.queueMode;
      }
      entry.staleAfterMs = meta && Number.isFinite(meta.staleAfterMs) ? meta.staleAfterMs : null;
      if (meta && typeof meta.title === "string") entry.title = meta.title;
      entry.pending = resolve;
      bySurface.set(surfaceId, entry);
    });
  }

  function decorateDelivery(entry, outcome) {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return outcome;
    if (outcome.surfaceUuid !== undefined) return outcome;
    return { ...outcome, surfaceUuid: entry.uuid };
  }

  function resolve(surfaceId, outcome) {
    const entry = bySurface.get(surfaceId);
    if (!entry || !entry.pending) return false;
    const pending = entry.pending;
    entry.pending = null;
    if (isTerminalOutcome(outcome)) {
      entry.state = "exiting";
      entry.awaitingAgentResponse = false;
    } else {
      entry.state = "visible_awaiting_agent";

      entry.awaitingAgentResponse = !!(outcome && outcome.result !== "window_expired");
    }
    pending(decorateDelivery(entry, outcome));
    return true;
  }

  function hasSurface(surfaceId) {
    return bySurface.has(surfaceId);
  }

  function isPending(surfaceId) {
    const entry = bySurface.get(surfaceId);
    return !!(entry && entry.pending);
  }

  function decorateDrainOutcome(entry, outcome) {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return outcome;
    return decorateDelivery(entry, {
      ...outcome,
      origin: typeof outcome.origin === "string" ? outcome.origin : "system",
    });
  }

  function drainSession(rawSessionKey, outcome) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    let n = 0;
    for (const [surfaceId, entry] of [...bySurface]) {
      if (entry.sessionKey !== sessionKey) continue;
      const pending = entry.pending;
      entry.pending = null;
      deadLetterEntryEvents(sessionKey, surfaceId, entry, "drain_session");
      bySurface.delete(surfaceId);
      if (pending) { pending(decorateDrainOutcome(entry, outcome)); n += 1; }
    }
    return n;
  }

  function settlePending(rawSessionKey, outcome) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    let n = 0;
    for (const [, entry] of bySurface) {
      if (entry.sessionKey !== sessionKey || !entry.pending) continue;
      const pending = entry.pending;
      entry.pending = null;

      entry.state = "visible_awaiting_agent";
      pending(decorateDrainOutcome(entry, outcome));
      n += 1;
    }
    return n;
  }

  function drainAll(outcome) {
    let n = 0;
    for (const [surfaceId, entry] of [...bySurface]) {
      const pending = entry.pending;
      entry.pending = null;
      deadLetterEntryEvents(entry.sessionKey, surfaceId, entry, "drain_all");
      bySurface.delete(surfaceId);
      if (pending) { pending(decorateDrainOutcome(entry, outcome)); n += 1; }
    }
    return n;
  }

  function stateOf(surfaceId) {
    const entry = bySurface.get(surfaceId);
    return entry ? entry.state : null;
  }

  function queueEvent(surfaceId, event, opts) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return false;
    if (isTerminalOutcome(event)) {
      entry.exitLatched = true;
      entry.queuedEvent = event;
      return { ok: true, eventId: ++eventSeq, surfaceUuid: entry.uuid, kind: "terminal_latch" };
    }
    if (entry.exitLatched) {

      const latched = entry.queuedEvent;
      const latchedOrigin = latched && typeof latched.origin === "string" ? latched.origin : "gesture";
      if (latchedOrigin === "gesture") {

        return false;
      }
      entry.exitLatched = false;
      entry.queuedEvent = null;

    }
    const record = {
      eventId: ++eventSeq,
      surfaceUuid: entry.uuid,
      origin: opts && typeof opts.origin === "string" ? opts.origin : "gesture",
      actor: opts && typeof opts.actor === "string" ? opts.actor : "wearer",
      queuedAtMs: now(),
      deliveredVia: null,
      outcome: event,
    };
    entry.events.push(record);
    if (entry.events.length > SURFACE_EVENT_LOG_CAP) {
      entry.events.splice(0, entry.events.length - SURFACE_EVENT_LOG_CAP);
    }
    entry.queuedEvent = event;
    return { ok: true, eventId: record.eventId, surfaceUuid: entry.uuid };
  }

  function titleOf(surfaceId) {
    const entry = bySurface.get(surfaceId);
    return entry ? entry.title : null;
  }

  function markerFor(surfaceId) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return null;
    if (entry.pending) return "listening";
    if ((entry.events && entry.events.length > 0) || entry.awaitingAgentResponse) return "inflight";
    return "parked";
  }

  function clearAwaitingResponse(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    for (const [, entry] of bySurface) {
      if (entry.sessionKey === sessionKey) entry.awaitingAgentResponse = false;
    }
  }

  function breadcrumbFor(rawSessionKey) {
    const s = stackBySession.get(normalizeGlassesSessionKey(rawSessionKey));
    if (!s || s.length === 0) return null;
    const titles = s
      .map((id) => { const e = bySurface.get(id); return e && typeof e.title === "string" ? e.title : null; })
      .filter((t) => typeof t === "string" && t.length > 0);
    return titles.length ? titles.join(" › ") : null;
  }

  function uuidOf(surfaceId) {
    const entry = bySurface.get(surfaceId);
    return entry ? entry.uuid : null;
  }

  function peekEvents(surfaceId) {
    const entry = bySurface.get(surfaceId);
    return entry ? [...entry.events] : [];
  }

  function reduceForDelivery(surfaceId) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return null;
    if (entry.queueMode === "log") {
      return { mode: "log", events: [...entry.events] };
    }
    const newest = entry.events.length ? entry.events[entry.events.length - 1] : null;
    return { mode: "latest", outcome: newest ? newest.outcome : null };
  }

  function peekDeadLetter(sessionKey) {
    const list = deadLetterBySession.get(normalizeGlassesSessionKey(sessionKey));
    return list ? list.map((r) => ({ ...r, events: [...r.events] })) : [];
  }

  function drainDeadLetter(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const list = deadLetterBySession.get(sessionKey) || [];
    deadLetterBySession.set(sessionKey, []);
    return list;
  }

  function isExitLatched(surfaceId) {
    const entry = bySurface.get(surfaceId);
    return !!(entry && entry.exitLatched);
  }

  function onReattached(surfaceId) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return "no_surface";
    let staleLatchDropped = false;
    if (entry.exitLatched) {

      const latched = entry.queuedEvent;
      const latchedOrigin =
        latched && typeof latched.origin === "string" ? latched.origin : "gesture";
      if (latchedOrigin !== "gesture") {
        entry.exitLatched = false;
        entry.queuedEvent = null;
        staleLatchDropped = true;
      } else {

        entry.state = "exiting";
        const terminal = entry.queuedEvent || { result: "dismissed" };
        entry.queuedEvent = null;
        entry.events = [];
        if (entry.pending) {
          const pending = entry.pending;
          entry.pending = null;
          pending(decorateDelivery(entry, terminal));
        }
        return "discarded_for_exit";
      }
    }
    entry.state = "reattached";

    const newest = entry.events.length ? entry.events[entry.events.length - 1] : null;
    let delivered = null;
    if (newest) {
      const parkedForMs = Math.max(0, now() - newest.queuedAtMs);
      delivered = {
        ...newest.outcome,
        surfaceUuid: entry.uuid,
        eventId: newest.eventId,
        origin: newest.origin,
        actor: newest.actor || "wearer",
        queuedAtMs: newest.queuedAtMs,
        parkedForMs,
      };
      if (Number.isFinite(entry.staleAfterMs) && parkedForMs > entry.staleAfterMs) {
        delivered.stale = true;
      }
    } else if (entry.queuedEvent) {
      delivered = decorateDelivery(entry, entry.queuedEvent);
    }
    entry.queuedEvent = null;
    entry.events = [];
    if (delivered && entry.pending) {
      const pending = entry.pending;
      entry.pending = null;
      entry.state = "visible_awaiting_agent";
      entry.awaitingAgentResponse = true;
      pending(delivered);
    }
    return staleLatchDropped ? "reattached_stale_latch_dropped" : "reattached";
  }

  function topSurfaceId(sessionKey) {
    const s = stackBySession.get(normalizeGlassesSessionKey(sessionKey));
    return s && s.length ? s[s.length - 1] : null;
  }

  function stackDepth(sessionKey) {
    const s = stackBySession.get(normalizeGlassesSessionKey(sessionKey));
    return s ? s.length : 0;
  }

  function sessionForSurface(surfaceId) {
    const entry = bySurface.get(surfaceId);
    return entry ? entry.sessionKey : null;
  }

  function applyRender(rawSessionKey, params) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const stack = stackFor(sessionKey);
    const top = stack[stack.length - 1] || null;

    if (!top) {
      const id = mintSurfaceId();
      stack.push(id);
      bySurface.set(id, makeEntry(sessionKey, params && params.kind));
      return { mode: "root", surfaceId: id };
    }
    const update = params && params.update === "patch" ? "patch"
      : params && params.update === "push" ? "push"
      : "replace";
    if (update === "patch") {

      const entry = bySurface.get(top);
      if (entry && params && params.kind) entry.kind = params.kind;
      if (entry) entry.state = "visible_pending";
      return { mode: "patch", surfaceId: top };
    }
    if (update === "push") {
      pauseCron(top);
      const id = mintSurfaceId();
      stack.push(id);
      bySurface.set(id, makeEntry(sessionKey, params && params.kind));
      return { mode: "push", surfaceId: id };
    }

    const priorTop = bySurface.get(top);

    stopCron(top, { silent: true });
    bySurface.set(top, makeEntry(sessionKey, params && params.kind, priorTop));
    return { mode: "replace", surfaceId: top };
  }

  function popBack(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const stack = stackFor(sessionKey);
    const child = stack.pop();
    if (child) {
      stopCron(child);
      deadLetterEntryEvents(sessionKey, child, bySurface.get(child), "pop_back");
      bySurface.delete(child);
    }
    const parent = stack[stack.length - 1] || null;
    if (parent) resumeCron(parent);
    return parent;
  }

  function exit(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const stack = stackFor(sessionKey);
    for (const id of stack) {
      stopCron(id);
      deadLetterEntryEvents(sessionKey, id, bySurface.get(id), "exit");
      bySurface.delete(id);
    }
    stackBySession.set(sessionKey, []);
    return true;
  }

  function sessionKeys() {
    return [...stackBySession.keys()];
  }

  return {
    storeId,
    register, resolve, hasSurface, isPending, drainSession, drainAll, settlePending,
    stateOf, queueEvent, isExitLatched, onReattached,
    applyRender, popBack, exit, topSurfaceId, stackDepth, sessionKeys, sessionForSurface,
    uuidOf, titleOf, markerFor, clearAwaitingResponse, breadcrumbFor,
    peekEvents, reduceForDelivery, peekDeadLetter, drainDeadLetter,
    _bySurface: bySurface,
  };
}

const createPendingRenderMap = createSurfaceStore;

module.exports = { createPendingRenderMap, createSurfaceStore, isTerminalOutcome, GLASS_EVENT_ORIGINS, normalizeGlassesSessionKey };
