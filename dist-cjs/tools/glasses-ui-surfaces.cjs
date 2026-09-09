const TERMINAL_OUTCOME_RESULTS = Object.freeze([
  "dismissed",
  "timeout",
  "glasses_disconnected",
  "session_reset",
  "preempted",
  "recipe_failed",
  "render_failed",
]);

const TERMINAL_RESULTS = new Set(TERMINAL_OUTCOME_RESULTS);

const SETTLEMENT_OUTCOME_RESULTS = Object.freeze([
  "cancelled",
  "aborted",
]);

const SETTLEMENT_RESULTS = new Set(SETTLEMENT_OUTCOME_RESULTS);

const SURFACE_REAP_REASONS = Object.freeze([
  "drain_session",
  "drain_all",
  "pop_back",
  "exit",
]);

const SURFACE_EVICTION_REASONS = Object.freeze(["event_log_cap"]);

const DEAD_LETTER_REASONS = Object.freeze([
  ...SURFACE_REAP_REASONS,
  ...SURFACE_EVICTION_REASONS,
]);

function isTerminalOutcome(outcome) {
  return !!(outcome && typeof outcome.result === "string" && TERMINAL_RESULTS.has(outcome.result));
}

function isSettlementOutcome(outcome) {
  return !!(outcome && typeof outcome.result === "string" && SETTLEMENT_RESULTS.has(outcome.result));
}

const RECEIPT_REJECTION_REASONS = Object.freeze([
  "unknown_surface",
  "no_send_attempt",
  "surface_uuid_mismatch",
  "stale_seq",
]);

const RENDER_FAILURE_CODES = Object.freeze([
  "paint_failed",
  "unsupported_kind",
  "spec_unparseable",
]);

const MAX_TRACKED_CLIENT_FAILURES = 4;

const MAX_TRACKED_SEND_ATTEMPTS = 32;
const MAX_TRACKED_CHILD_GENERATIONS = 32;

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

  const generationBySession = new Map();
  let stageHolder = null;
  let pendingStageGrant = null;

  function generationFor(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    return generationBySession.get(sessionKey) || 1;
  }

  function advanceGeneration(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    generationBySession.set(sessionKey, generationFor(sessionKey) + 1);
  }

  function syncStageBusySince() {
    if (!stageHolder || !stageHolder.surfaceId) return;
    const marker = markerFor(stageHolder.surfaceId);
    if (marker === "parked" || marker === null) {
      stageHolder.busySinceMs = null;
    } else if (!Number.isFinite(stageHolder.busySinceMs)) {
      stageHolder.busySinceMs = now();
    }
  }

  function planStageGrant(rawSessionKey, opts = {}) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const graceMs = Number.isFinite(opts.graceMs)
      ? Math.max(0, Math.floor(opts.graceMs))
      : 0;
    if (!stageHolder) {
      return { ok: true, action: "grant", reason: "first_render", sessionKey };
    }
    if (stageHolder.sessionKey === sessionKey) {
      return { ok: true, action: "retain", reason: "same_session", sessionKey };
    }

    const incumbentSurfaceId = topSurfaceId(stageHolder.sessionKey) || stageHolder.surfaceId;
    const incumbentMarker = markerFor(incumbentSurfaceId) || "parked";
    if (incumbentMarker === "parked") {
      stageHolder.busySinceMs = null;
      return {
        ok: true,
        action: "transfer",
        reason: "lease_transfer",
        sessionKey,
        incumbentSessionKey: stageHolder.sessionKey,
        incumbentSurfaceId,
        incumbentMarker,
      };
    }

    if (!Number.isFinite(stageHolder.busySinceMs)) stageHolder.busySinceMs = now();
    const busyForMs = Math.max(0, now() - stageHolder.busySinceMs);
    if (busyForMs >= graceMs) {
      return {
        ok: true,
        action: "transfer",
        reason: "grace_expired",
        sessionKey,
        incumbentSessionKey: stageHolder.sessionKey,
        incumbentSurfaceId,
        incumbentMarker,
        busyForMs,
      };
    }

    const retryAfterMs = Math.max(1, graceMs - busyForMs);
    emitLifecycle("stage_denied", "warn", {
      surfaceId: incumbentSurfaceId,
      sessionKey,
      challengerSessionKey: sessionKey,
      incumbentSessionKey: stageHolder.sessionKey,
      incumbentSurfaceId,
      incumbentMarker,
      reason: "incumbent_busy",
      retryAfterMs,
    });
    return {
      ok: false,
      code: "stage_incumbent_busy",
      reason: "incumbent_busy",
      sessionKey,
      incumbentSessionKey: stageHolder.sessionKey,
      incumbentSurfaceId,
      incumbentMarker,
      retryAfterMs,
    };
  }

  function commitStageGrant(rawSessionKey, plan) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (!plan || plan.ok !== true) return false;
    if (stageHolder && stageHolder.sessionKey === sessionKey && plan.action === "retain") {
      return true;
    }

    const prior = stageHolder ? { ...stageHolder } : null;
    if (prior && prior.sessionKey !== sessionKey) {
      const priorSurfaceId = topSurfaceId(prior.sessionKey) || prior.surfaceId;
      if (priorSurfaceId) pauseCron(priorSurfaceId);
      emitLifecycle("stage_yielded", "info", {
        surfaceId: priorSurfaceId,
        sessionKey: prior.sessionKey,
        challengerSessionKey: sessionKey,
        reason: plan.reason === "grace_expired" ? "grace_expired" : "lease_transfer",
        generation: prior.generation,
      });
    }

    const candidateSurfaceId = topSurfaceId(sessionKey);
    if (candidateSurfaceId) resumeCron(candidateSurfaceId);
    stageHolder = {
      sessionKey,
      surfaceId: candidateSurfaceId,
      generation: generationFor(sessionKey),
      grantedAtMs: now(),
      busySinceMs: null,
    };
    syncStageBusySince();
    pendingStageGrant = {
      sessionKey,
      priorHolderSessionKey: prior && prior.sessionKey !== sessionKey ? prior.sessionKey : null,
      priorHolderSurfaceId: prior && prior.sessionKey !== sessionKey ? prior.surfaceId : null,
      reason: plan.reason === "grace_expired" ? "grace_expired" : plan.reason,
    };
    return true;
  }

  function bindStageSurface(rawSessionKey, surfaceId) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (!stageHolder || stageHolder.sessionKey !== sessionKey) return false;
    stageHolder.surfaceId = surfaceId;
    if (pendingStageGrant && pendingStageGrant.sessionKey === sessionKey) {
      emitLifecycle("stage_granted", "info", {
        surfaceId,
        sessionKey,
        priorHolderSessionKey: pendingStageGrant.priorHolderSessionKey,
        priorHolderSurfaceId: pendingStageGrant.priorHolderSurfaceId,
        reason: pendingStageGrant.reason,
        generation: stageHolder.generation,
      });
      pendingStageGrant = null;
    }
    syncStageBusySince();
    return true;
  }

  function clearStageForSession(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (!stageHolder || stageHolder.sessionKey !== sessionKey) return false;
    stageHolder = null;
    if (pendingStageGrant && pendingStageGrant.sessionKey === sessionKey) {
      pendingStageGrant = null;
    }
    return true;
  }

  function activeSessionCount() {
    let count = 0;
    for (const sessionKey of stackBySession.keys()) {
      if (stackDepth(sessionKey) > 0) count += 1;
    }
    return count;
  }

  function stageState(rawSessionKey, opts = {}) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const graceMs = Number.isFinite(opts.graceMs)
      ? Math.max(0, Math.floor(opts.graceMs))
      : 0;
    if (!stageHolder) {
      return {
        role: "vacant",
        holderSessionKey: null,
        holderSurfaceId: null,
        holderSurfaceUuid: null,
        holderMarker: null,
        generation: null,
        grantedAtMs: null,
        busySinceMs: null,
        graceRemainingMs: null,
      };
    }
    syncStageBusySince();
    const holderEntry = stageHolder.surfaceId ? bySurface.get(stageHolder.surfaceId) : null;
    const role = stageHolder.sessionKey === sessionKey
      ? "holder"
      : stackDepth(sessionKey) > 0
        ? "backstage"
        : "contender";
    const graceRemainingMs = Number.isFinite(stageHolder.busySinceMs)
      ? Math.max(0, graceMs - Math.max(0, now() - stageHolder.busySinceMs))
      : null;
    return {
      role,
      holderSessionKey: stageHolder.sessionKey,
      holderSurfaceId: stageHolder.surfaceId,
      holderSurfaceUuid: holderEntry ? holderEntry.uuid : null,
      holderMarker: markerFor(stageHolder.surfaceId),
      generation: stageHolder.generation,
      grantedAtMs: stageHolder.grantedAtMs,
      busySinceMs: stageHolder.busySinceMs,
      graceRemainingMs,
    };
  }

  const DEAD_LETTER_EVENT_CAP = 32;
  const SURFACE_EVENT_LOG_CAP = 32;
  const deadLetterBySession = new Map();
  let eventSeq = 0;

  function deadLetterFor(sessionKey) {
    let list = deadLetterBySession.get(sessionKey);
    if (!list) { list = []; deadLetterBySession.set(sessionKey, list); }
    return list;
  }

  function appendDeadLetter(sessionKey, surfaceId, entry, events, reason) {
    if (!entry || !events || events.length === 0) return;
    const eventIds = events.map((e) => e.eventId);
    const list = deadLetterFor(sessionKey);
    list.push({
      surfaceUuid: entry.uuid,
      surfaceId,
      events,
      reason,
      reapedAtMs: now(),

      staleAfterMs: Number.isFinite(entry.staleAfterMs) ? entry.staleAfterMs : null,
    });

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

  function deadLetterEntryEvents(sessionKey, surfaceId, entry, reason) {

    if (!entry || entry.exitLatched || !entry.events || entry.events.length === 0) return;
    const events = entry.events;
    entry.events = [];
    appendDeadLetter(sessionKey, surfaceId, entry, events, reason);
  }

  function stackFor(sessionKey) {
    let s = stackBySession.get(sessionKey);
    if (!s) { s = []; stackBySession.set(sessionKey, s); }
    return s;
  }

  function makeEntry(sessionKey, kind, prior) {
    return {
      sessionKey, kind: kind || null, pending: null, lastContent: null,

      wearerInitiated: false,
      agentRunEnded: false,

      recordedSpec: null,

      preloadedChildGenerations: prior ? prior.preloadedChildGenerations : [],
      state: "visible_pending",
      queuedEvent: prior ? prior.queuedEvent : null,
      exitLatched: prior ? !!prior.exitLatched : false,

      uuid: prior ? prior.uuid : mintUuid(),
      events: prior ? prior.events : [],
      queueMode: prior && prior.queueMode === "log" ? "log" : "latest",

      staleAfterMs: null,

      title: prior ? prior.title : null,
      awaitingAgentResponse: false,

      clientPushed: null,

      terminationCause: null,

      lastAttemptedSend: null,
      sendAttempts: new Map(),
      lastPaintedAt: null,
      deliveryEvidence: {
        authoredAtMs: null,
        validatedAtMs: null,
        sendAttemptedAtMs: null,
        clientReceiptAtMs: null,

        wearerInteractedAtMs: null,
      },
    };
  }

  function clearSendAndReceiptEvidence(entry) {
    entry.lastAttemptedSend = null;
    entry.sendAttempts.clear();
    entry.lastPaintedAt = null;
    entry.deliveryEvidence.sendAttemptedAtMs = null;
    entry.deliveryEvidence.clientReceiptAtMs = null;
  }

  function stampAuthoredAndValidated(entry) {
    const atMs = now();
    if (entry.deliveryEvidence.authoredAtMs === null) {
      entry.deliveryEvidence.authoredAtMs = atMs;
    }
    entry.deliveryEvidence.validatedAtMs = atMs;
  }

  function register(rawSessionKey, surfaceId, meta) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);

    if (meta?.wearerInitiated !== true) markAgentRunEnded(sessionKey, false);
    return new Promise((resolve) => {
      const existing = bySurface.get(surfaceId);
      if (existing) {

        existing.pending = resolve;
        existing.wearerInitiated = meta && meta.wearerInitiated === true;
        existing.agentRunEnded = false;
        if (meta && meta.kind) existing.kind = meta.kind;
        if (meta && (meta.queueMode === "log" || meta.queueMode === "latest")) {
          existing.queueMode = meta.queueMode;
        }
        existing.staleAfterMs = meta && Number.isFinite(meta.staleAfterMs) ? meta.staleAfterMs : null;
        if (meta && typeof meta.title === "string") existing.title = meta.title;
        existing.awaitingAgentResponse = false;
        existing.terminationCause = null;
        existing.sessionKey = sessionKey;
        existing.state = "visible_pending";

        clearSendAndReceiptEvidence(existing);
        stampAuthoredAndValidated(existing);
        syncStageBusySince();
        return;
      }
      const entry = makeEntry(sessionKey, meta && meta.kind ? meta.kind : null);
      if (meta && (meta.queueMode === "log" || meta.queueMode === "latest")) {
        entry.queueMode = meta.queueMode;
      }
      entry.staleAfterMs = meta && Number.isFinite(meta.staleAfterMs) ? meta.staleAfterMs : null;
      if (meta && typeof meta.title === "string") entry.title = meta.title;
      entry.pending = resolve;
      entry.wearerInitiated = meta && meta.wearerInitiated === true;
      stampAuthoredAndValidated(entry);
      bySurface.set(surfaceId, entry);
      syncStageBusySince();
    });
  }

  function decorateDelivery(entry, outcome) {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return outcome;
    if (outcome.surfaceUuid !== undefined) return outcome;
    return { ...outcome, surfaceUuid: entry.uuid };
  }

  function deliveryForRecord(entry, record) {
    const parkedForMs = Math.max(0, now() - record.queuedAtMs);
    const delivered = {
      ...record.outcome,
      surfaceUuid: entry.uuid,
      eventId: record.eventId,
      origin: record.origin,
      actor: record.actor || "wearer",
      queuedAtMs: record.queuedAtMs,
      parkedForMs,
    };
    if (Number.isFinite(entry.staleAfterMs) && parkedForMs > entry.staleAfterMs) {
      delivered.stale = true;
    }
    return delivered;
  }

  function resolve(surfaceId, outcome) {
    const entry = bySurface.get(surfaceId);
    if (!entry || !entry.pending) return false;
    const pending = entry.pending;
    entry.pending = null;
    if (isTerminalOutcome(outcome)) {
      entry.state = "exiting";
      entry.awaitingAgentResponse = false;
      entry.terminationCause = outcome.result;
    } else if (isSettlementOutcome(outcome)) {

      entry.state = "visible_awaiting_agent";
      entry.awaitingAgentResponse = false;
      entry.terminationCause = outcome.result;
    } else {
      entry.state = "visible_awaiting_agent";

      entry.awaitingAgentResponse = !!(outcome && outcome.result !== "window_expired");
      entry.terminationCause = null;
    }
    pending(decorateDelivery(entry, outcome));
    syncStageBusySince();
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
    clearStageForSession(sessionKey);
    if (outcome && outcome.result === "session_reset") advanceGeneration(sessionKey);
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
      entry.awaitingAgentResponse = false;
      entry.terminationCause = isSettlementOutcome(outcome) ? outcome.result : null;
      pending(decorateDrainOutcome(entry, outcome));
      n += 1;
    }
    syncStageBusySince();
    return n;
  }

  function markAgentRunEnded(rawSessionKey, ended = true) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    for (const entry of bySurface.values()) {
      if (entry.sessionKey === sessionKey) entry.agentRunEnded = ended;
    }
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
    stageHolder = null;
    pendingStageGrant = null;
    generationBySession.clear();
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
      syncStageBusySince();
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

      const evicted = entry.events.splice(0, entry.events.length - SURFACE_EVENT_LOG_CAP);
      appendDeadLetter(entry.sessionKey, surfaceId, entry, evicted, "event_log_cap");
    }
    entry.queuedEvent = event;
    syncStageBusySince();
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
    syncStageBusySince();
  }

  function breadcrumbFor(rawSessionKey, depth = undefined) {
    const s = stackBySession.get(normalizeGlassesSessionKey(rawSessionKey));
    if (!s || s.length === 0) return null;
    const levels = Number.isFinite(depth) && depth > 0 ? s.slice(0, depth) : s;
    const titles = levels
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

  function deadLetterEventCount(rawSessionKey) {
    const list = deadLetterBySession.get(normalizeGlassesSessionKey(rawSessionKey));
    if (!list) return 0;
    let total = 0;
    for (const record of list) {
      total += record && Array.isArray(record.events) ? record.events.length : 0;
    }
    return total;
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
        syncStageBusySince();
        return "discarded_for_exit";
      }
    }
    entry.state = "reattached";

    let delivered = null;
    if (entry.queueMode === "log" && entry.events.length) {
      const reduced = reduceForDelivery(surfaceId);
      const records = reduced && Array.isArray(reduced.events) ? reduced.events : [];
      delivered = {
        mode: "log",
        surfaceUuid: entry.uuid,
        events: records.map((record) => deliveryForRecord(entry, record)),
      };
    } else if (entry.events.length) {
      delivered = deliveryForRecord(entry, entry.events[entry.events.length - 1]);
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
    syncStageBusySince();
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

  function surfaceFactsFor(surfaceId) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return null;
    return {
      surfaceUuid: entry.uuid,
      kind: entry.kind,
      title: entry.title,
      state: entry.state,
      queueMode: entry.queueMode,
      staleAfterMs: entry.staleAfterMs,
      pendingRender: entry.pending !== null,
      awaitingAgentResponse: !!entry.awaitingAgentResponse,
      exitLatched: !!entry.exitLatched,
      terminationCause: entry.terminationCause,
      parkedEventCount: entry.events ? entry.events.length : 0,

      content: entry.lastContent ? JSON.parse(JSON.stringify(entry.lastContent)) : null,
    };
  }

  function recordContent(surfaceId, frame) {
    const entry = bySurface.get(surfaceId);
    if (!entry || !frame || typeof frame !== "object") return null;
    const isRender = frame.__render === true;
    const source = isRender && frame.__spec && typeof frame.__spec === "object"
      ? frame.__spec
      : frame;
    const next = isRender || !entry.lastContent
      ? { kind: source.kind || entry.kind || null }
      : { ...entry.lastContent };

    for (const key of ["title", "body", "template", "imageAsset", "imageWidth", "imageHeight"]) {
      if (Object.prototype.hasOwnProperty.call(source, key)) next[key] = source[key];
    }
    if (Object.prototype.hasOwnProperty.call(source, "items")) {
      next.items = Array.isArray(source.items)
        ? JSON.parse(JSON.stringify(source.items))
        : source.items;
    }
    entry.lastContent = next;
    return JSON.parse(JSON.stringify(next));
  }

  function recordSpec(surfaceId, normalizedSpec) {
    const entry = bySurface.get(surfaceId);
    if (!entry || !normalizedSpec || typeof normalizedSpec !== "object" ||
        Array.isArray(normalizedSpec)) return null;
    entry.recordedSpec = JSON.parse(JSON.stringify(normalizedSpec));
    return JSON.parse(JSON.stringify(entry.recordedSpec));
  }

  function currentSurfaceSpecForSession(rawSessionKey) {
    const surfaceId = topSurfaceId(rawSessionKey);
    const entry = surfaceId ? bySurface.get(surfaceId) : null;
    return entry && entry.recordedSpec
      ? JSON.parse(JSON.stringify(entry.recordedSpec))
      : null;
  }

  function recordPreloadedChildren(surfaceId, children, recordedChildren = children) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return;
    const slots = Array.isArray(children) ? children : [];

    entry.preloadedChildGenerations = entry.preloadedChildGenerations
      .map((generation) => generation.filter((child) => slots[child.itemIndex]))
      .filter((generation) => generation.length);
    const generation = slots.flatMap((child, itemIndex) =>
      child && typeof child.surfaceId === "string"
        ? [{ childId: child.surfaceId, itemIndex, spec: JSON.parse(JSON.stringify(recordedChildren[itemIndex])) }]
        : [],
    );
    if (generation.length) entry.preloadedChildGenerations.push(generation);

    while (entry.preloadedChildGenerations.length > MAX_TRACKED_CHILD_GENERATIONS) {
      entry.preloadedChildGenerations.shift();
    }
  }

  function stackSurfaceIds(rawSessionKey) {
    const s = stackBySession.get(normalizeGlassesSessionKey(rawSessionKey));
    return s ? [...s] : [];
  }

  function applyRender(rawSessionKey, params) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const stack = stackFor(sessionKey);
    const stackTop = stack[stack.length - 1] || null;

    if (!stackTop) {
      const id = mintSurfaceId();
      stack.push(id);
      bySurface.set(id, makeEntry(sessionKey, params && params.kind));
      bindStageSurface(sessionKey, id);
      return { mode: "root", surfaceId: id, depth: 1 };
    }
    const update = params && params.update === "patch" ? "patch"
      : params && params.update === "push" ? "push"
      : "replace";

    const topEntry = bySurface.get(stackTop);
    const reattachParent =
      update !== "push" && topEntry && topEntry.clientPushed && stack.length >= 2;
    const top = reattachParent ? stack[stack.length - 2] : stackTop;
    const depth = reattachParent ? stack.length - 1 : stack.length;
    if (update === "patch") {

      const entry = bySurface.get(top);
      if (entry && params && params.kind) entry.kind = params.kind;
      if (entry) entry.state = "visible_pending";
      bindStageSurface(sessionKey, top);
      return { mode: "patch", surfaceId: top, depth };
    }
    if (update === "push") {
      pauseCron(top);
      const id = mintSurfaceId();
      stack.push(id);
      bySurface.set(id, makeEntry(sessionKey, params && params.kind));
      bindStageSurface(sessionKey, id);
      return { mode: "push", surfaceId: id, depth: stack.length };
    }

    const priorTop = bySurface.get(top);

    stopCron(top, { silent: true });
    bySurface.set(top, makeEntry(sessionKey, params && params.kind, priorTop));
    bindStageSurface(sessionKey, top);
    return { mode: "replace", surfaceId: top, depth };
  }

  function adoptClientPush(rawSessionKey, childId, meta = {}) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const stack = stackFor(sessionKey);
    const top = stack[stack.length - 1] || null;
    if (typeof childId !== "string" || !childId) {
      return { ok: false, code: "child_id_invalid", top };
    }
    if (top === childId && bySurface.has(childId)) {
      return { ok: true, mode: "already_adopted", parentId: stack[stack.length - 2] || null };
    }
    if (!top || (typeof meta.parentId === "string" && meta.parentId && meta.parentId !== top)) {
      return { ok: false, code: "parent_not_top", top };
    }
    const parentEntry = bySurface.get(top);
    const itemIndex = Number.isInteger(meta.itemIndex) && meta.itemIndex >= 0 ? meta.itemIndex : null;
    const sentChild = parentEntry && parentEntry.preloadedChildGenerations
      .flat().find((child) => child.childId === childId && child.itemIndex === itemIndex);
    if (!sentChild) return { ok: false, code: "child_generation_unavailable", top };
    const childSpec = sentChild.spec;
    const kind =
      typeof meta.kind === "string" && meta.kind
        ? meta.kind
        : childSpec && typeof childSpec.kind === "string"
          ? childSpec.kind
          : null;
    pauseCron(top);
    stack.push(childId);
    const entry = makeEntry(sessionKey, kind);
    entry.clientPushed = { parentId: top, itemIndex };

    entry.state = "visible_awaiting_agent";
    if (typeof meta.title === "string") entry.title = meta.title;
    else if (childSpec && typeof childSpec.title === "string") entry.title = childSpec.title;

    bySurface.set(childId, entry);
    if (childSpec) {
      recordSpec(childId, childSpec);
      recordContent(childId, { __render: true, __spec: childSpec });
    }
    bindStageSurface(sessionKey, childId);
    return { ok: true, mode: "adopted", parentId: top, itemIndex, kind };
  }

  function adoptedChildFor(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    const stack = stackFor(sessionKey);
    const top = stack[stack.length - 1] || null;
    const entry = top ? bySurface.get(top) : null;
    if (!entry || !entry.clientPushed) return null;
    return { childId: top, parentId: entry.clientPushed.parentId, itemIndex: entry.clientPushed.itemIndex };
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
    if (parent) {

      if (!stageHolder || stageHolder.sessionKey === sessionKey) {
        resumeCron(parent);
      }
      if (stageHolder && stageHolder.sessionKey === sessionKey) {
        stageHolder.surfaceId = parent;
        syncStageBusySince();
      }
    } else {
      clearStageForSession(sessionKey);
    }
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
    clearStageForSession(sessionKey);
    return true;
  }

  function sessionKeys() {
    return [...stackBySession.keys()];
  }

  let sendSeq = 0;

  function recordSendAttempt(surfaceId, opts) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return null;
    const mode = opts && opts.mode === "update" ? "update" : "render";

    if (mode === "render") {
      clearSendAndReceiptEvidence(entry);
    } else {
      entry.lastPaintedAt = null;
      entry.deliveryEvidence.clientReceiptAtMs = null;
    }
    const atMs = now();
    const seq = ++sendSeq;
    entry.lastAttemptedSend = {
      seq,
      atMs,
      surfaceUuid: entry.uuid,
      mode,
    };
    entry.sendAttempts.set(seq, { ...entry.lastAttemptedSend, receiptAtMs: null });
    while (entry.sendAttempts.size > MAX_TRACKED_SEND_ATTEMPTS) {
      const oldestSeq = entry.sendAttempts.keys().next().value;
      entry.sendAttempts.delete(oldestSeq);
    }
    entry.deliveryEvidence.sendAttemptedAtMs = atMs;
    return { ...entry.lastAttemptedSend };
  }

  function recordClientReceipt(surfaceId, receipt) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return { ok: false, reason: "unknown_surface" };
    const latestAttempt = entry.lastAttemptedSend;
    if (!latestAttempt) {
      return { ok: false, reason: "no_send_attempt", surfaceUuid: entry.uuid };
    }
    const claimedUuid =
      receipt && typeof receipt.surfaceUuid === "string" && receipt.surfaceUuid
        ? receipt.surfaceUuid
        : null;
    if (claimedUuid && claimedUuid !== entry.uuid) {
      return {
        ok: false,
        reason: "surface_uuid_mismatch",
        surfaceUuid: entry.uuid,
        expectedSeq: latestAttempt.seq,
      };
    }
    const seq =
      receipt && Number.isFinite(receipt.seq) ? Math.floor(receipt.seq) : null;
    const attempt = seq === null ? null : entry.sendAttempts.get(seq);
    if (!attempt) {
      return {
        ok: false,
        reason: "stale_seq",
        surfaceUuid: entry.uuid,
        expectedSeq: latestAttempt.seq,
        seq,
      };
    }
    const atMs = receipt && Number.isFinite(receipt.atMs) ? receipt.atMs : now();
    attempt.receiptAtMs = atMs;
    const superseded = seq !== latestAttempt.seq;

    if (!superseded) {
      entry.deliveryEvidence.clientReceiptAtMs = atMs;
      entry.lastPaintedAt = atMs;
    }
    return { ok: true, surfaceUuid: entry.uuid, seq, atMs, superseded };
  }

  function recordClientFailureEvidence(surfaceId, report) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return { ok: false, reason: "unknown_surface" };
    const latestAttempt = entry.lastAttemptedSend;
    if (!latestAttempt) {
      return { ok: false, reason: "no_send_attempt", surfaceUuid: entry.uuid };
    }
    const code = report && typeof report.code === "string" ? report.code : "";
    if (!RENDER_FAILURE_CODES.includes(code)) {
      return { ok: false, reason: "invalid_code", surfaceUuid: entry.uuid };
    }
    const seq =
      report && Number.isFinite(report.seq) ? Math.floor(report.seq) : null;
    const attempt = seq === null ? null : entry.sendAttempts.get(seq);
    if (!attempt) {
      return {
        ok: false,
        reason: "stale_seq",
        surfaceUuid: entry.uuid,
        expectedSeq: latestAttempt.seq,
        seq,
      };
    }
    const clientId =
      report && typeof report.clientId === "string" && report.clientId
        ? report.clientId
        : "unknown";
    const atMs = now();
    if (report?.deduplicate === true && entry.clientFailures?.recent.some(
      (item) => item.clientId === clientId && item.seq === seq && item.code === code,
    )) {
      return { ok: true, surfaceUuid: entry.uuid, seq, code, clientId,
        total: entry.clientFailures.total, duplicate: true };
    }
    if (!entry.clientFailures) {
      entry.clientFailures = { total: 0, byClient: new Map(), recent: [] };
    }
    const failures = entry.clientFailures;
    failures.total += 1;
    const perClient = failures.byClient.get(clientId) || { count: 0 };
    perClient.count += 1;
    perClient.lastCode = code;
    perClient.lastSeq = seq;
    perClient.lastAtMs = atMs;
    failures.byClient.set(clientId, perClient);
    failures.recent.push({ clientId, seq, code, atMs });
    if (failures.recent.length > MAX_TRACKED_CLIENT_FAILURES) {
      failures.recent.splice(0, failures.recent.length - MAX_TRACKED_CLIENT_FAILURES);
    }
    return { ok: true, surfaceUuid: entry.uuid, seq, code, clientId, total: failures.total };
  }

  function clientFailuresOf(surfaceId) {
    const entry = bySurface.get(surfaceId);
    if (!entry || !entry.clientFailures) return null;
    const failures = entry.clientFailures;
    return {
      total: failures.total,
      clients: Array.from(failures.byClient.entries()).map(([clientId, info]) => ({
        clientId,
        count: info.count,
        lastCode: info.lastCode,
        lastSeq: info.lastSeq === undefined ? null : info.lastSeq,
        lastAtMs: info.lastAtMs === undefined ? null : info.lastAtMs,
      })),
    };
  }

  function validateClientRenderError(surfaceId, report) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return { ok: false, reason: "unknown_surface" };
    if (!RENDER_FAILURE_CODES.includes(report?.code)) return { ok: false, reason: "invalid_code" };
    if (report?.channel !== "render_error" || report?.authoritative !== true) {
      return { ok: false, reason: report?.authorityReason || "evidence_only" };
    }
    if (!Number.isSafeInteger(report.seq) || report.seq !== entry.lastAttemptedSend?.seq) {
      return { ok: false, reason: "stale_seq" };
    }
    const attempt = entry.sendAttempts.get(report.seq);
    if (!attempt) return { ok: false, reason: "no_send_attempt" };
    if (attempt.receiptAtMs !== null) return { ok: false, reason: "already_receipted" };
    return { ok: true, surfaceUuid: entry.uuid };
  }

  function hasClientReceipt(surfaceUuid, seq) {
    for (const entry of bySurface.values()) {
      if (entry.uuid !== surfaceUuid) continue;
      const attempt = entry.sendAttempts.get(seq);
      return !!attempt && attempt.receiptAtMs !== null;
    }
    return false;
  }

  function deliveryEvidenceOf(surfaceId) {
    const entry = bySurface.get(surfaceId);
    if (!entry) return null;
    return {
      surfaceUuid: entry.uuid,
      lastAttemptedSend: entry.lastAttemptedSend ? { ...entry.lastAttemptedSend } : null,
      lastPaintedAt: entry.lastPaintedAt,
      evidence: { ...entry.deliveryEvidence },
    };
  }

  return {
    storeId,
    register, resolve, hasSurface, isPending, drainSession, drainAll, settlePending,
    isWearerInitiated: (surfaceId) => bySurface.get(surfaceId)?.wearerInitiated === true,
    hasAgentRunEnded: (surfaceId) => bySurface.get(surfaceId)?.agentRunEnded === true,
    markAgentRunEnded,
    stateOf, queueEvent, isExitLatched, onReattached,
    applyRender, recordPreloadedChildren, adoptClientPush, adoptedChildFor, popBack, exit, topSurfaceId, stackDepth, stackSurfaceIds, sessionKeys, sessionForSurface,
    planStageGrant, commitStageGrant, stageState, activeSessionCount,
    uuidOf, titleOf, markerFor, clearAwaitingResponse, breadcrumbFor, surfaceFactsFor,
    peekEvents, reduceForDelivery, peekDeadLetter, deadLetterEventCount, drainDeadLetter,
    recordSendAttempt, recordClientReceipt, hasClientReceipt, deliveryEvidenceOf,
    recordClientFailureEvidence, clientFailuresOf, validateClientRenderError,
    recordContent, recordSpec, currentSurfaceSpecForSession,
    _bySurface: bySurface,
  };
}

const createPendingRenderMap = createSurfaceStore;

module.exports = { createPendingRenderMap, createSurfaceStore, isTerminalOutcome, isSettlementOutcome, GLASS_EVENT_ORIGINS, normalizeGlassesSessionKey, SETTLEMENT_OUTCOME_RESULTS, TERMINAL_OUTCOME_RESULTS, SURFACE_REAP_REASONS, SURFACE_EVICTION_REASONS, DEAD_LETTER_REASONS, RECEIPT_REJECTION_REASONS, RENDER_FAILURE_CODES };
