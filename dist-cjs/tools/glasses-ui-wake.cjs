const GLASSES_WAKE_ENABLED_ORIGINS = ["gesture"];

const DEFAULT_WAKE_COOLDOWN_MS = 5_000;

const WAKE_OUTBOX_CAP = 64;

const DEFAULT_AGENT_TURN_BUSY_DECAY_MS = 180_000;

const SURFACE_UUID_PATTERN = /^su-[a-z0-9]{4,24}$/i;
const WAKE_RESULT_ENUM = new Set(["selected", "back"]);

function sanitizeWakeToken(value) {
  const raw = String(value == null ? "" : value);
  return SURFACE_UUID_PATTERN.test(raw) ? raw : "invalid";
}

function sanitizeWakeResult(value) {
  return WAKE_RESULT_ENUM.has(value) ? value : "event";
}

function coerceInt(value) {
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function buildWakeMessage(ref) {
  const surfaceUuid = sanitizeWakeToken(ref && ref.surfaceUuid);
  const result = sanitizeWakeResult(ref && ref.result);
  const eventId = coerceInt(ref && ref.eventId);
  const itemIndex = coerceInt(ref && ref.itemIndex);
  const queuedAtMs = coerceInt(ref && ref.queuedAtMs);
  return [
    "[ocuclaw glasses-ui wake] Plugin-generated notification - NOT the wearer speaking.",
    `The wearer tapped a parked glasses surface (origin=gesture). refs: surfaceUuid=${surfaceUuid}`,
    `eventId=${eventId} result=${result} itemIndex=${itemIndex} queuedAtMs=${queuedAtMs}.`,
    "Tapped content is not included here by design: re-render that surface",
    "(update:\"patch\") to collect the parked event(s), then respond as appropriate.",
  ].join(" ");
}

function createAgentTurnTracker(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const onChange = typeof deps.onChange === "function" ? deps.onChange : () => {};
  const busyDecayMs = Number.isFinite(deps.busyDecayMs)
    ? deps.busyDecayMs
    : DEFAULT_AGENT_TURN_BUSY_DECAY_MS;
  const lastSeenBySession = new Map();

  const runBySession = new Map();
  const runIdCap = Number.isFinite(deps.runIdCap) ? deps.runIdCap : 64;

  function normalizeKey(sessionKey) {
    return sessionKey.replace(/^agent:[^:]+:/, "");
  }

  function noteRun(sessionKey, runId) {
    if (typeof sessionKey !== "string" || !sessionKey) return;
    if (typeof runId !== "string" || !runId.trim()) return;
    const key = normalizeKey(sessionKey);
    const next = runId.trim();
    const prior = runBySession.get(key);
    const live = prior ? prior.live : new Map();

    live.set(next, now());

    const overlapLatched = (prior && prior.overlapLatched === true) || live.size > 1;
    runBySession.set(key, { runId: next, atMs: now(), live, overlapLatched });
    while (runBySession.size > runIdCap) {
      const oldest = runBySession.keys().next();
      if (oldest.done) break;
      runBySession.delete(oldest.value);
    }
  }

  function runIdFor(sessionKey) {
    if (typeof sessionKey !== "string" || !sessionKey) {
      return { runId: null, active: false, atMs: null, ambiguous: false };
    }
    const entry = runBySession.get(normalizeKey(sessionKey));
    if (!entry) return { runId: null, active: false, atMs: null, ambiguous: false };
    return {
      runId: entry.runId,
      active: isBusy(sessionKey),
      atMs: entry.atMs,

      ambiguous: entry.overlapLatched === true || entry.live.size > 1,
    };
  }

  function refreshBusy(sessionKey) {
    const key = normalizeKey(sessionKey);
    if (!isBusy(sessionKey)) {
      const entry = runBySession.get(key);
      if (entry) {

        const at = now();
        const liveEntries = Array.from(entry.live.entries());
        for (const [id, lastSeen] of liveEntries) {
          if (at - lastSeen >= busyDecayMs) entry.live.delete(id);
        }

        if (entry.live.size === 0) entry.overlapLatched = false;
      }
    }
    lastSeenBySession.set(key, now());
  }

  function markBusy(sessionKey, runId = null) {
    if (typeof sessionKey !== "string" || !sessionKey) return;
    refreshBusy(sessionKey);
    if (runId) noteRun(sessionKey, runId);
    onChange(sessionKey, true);
  }

  function onActivity(sessionKey, phase, runId = null) {
    if (typeof sessionKey !== "string" || !sessionKey) return;
    if (phase === "end") {

      const key = normalizeKey(sessionKey);
      lastSeenBySession.delete(key);
      const entry = runBySession.get(key);
      if (entry) {
        const ending = typeof runId === "string" ? runId.trim() : "";

        if (ending) entry.live.delete(ending);
        else entry.live.clear();

      }
      onChange(sessionKey, false);
      return;
    }
    refreshBusy(sessionKey);
    if (runId) noteRun(sessionKey, runId);
    onChange(sessionKey, true);
  }

  function isBusy(sessionKey) {
    if (typeof sessionKey !== "string" || !sessionKey) return false;
    const key = normalizeKey(sessionKey);
    const lastSeen = lastSeenBySession.get(key);
    if (!Number.isFinite(lastSeen)) return false;
    if (now() - lastSeen >= busyDecayMs) {
      lastSeenBySession.delete(key);
      return false;
    }
    return true;
  }

  return { markBusy, onActivity, isBusy, noteRun, runIdFor };
}

function pickHookRunId(source) {
  if (!source || typeof source !== "object") return null;
  const raw = source.runId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function readAgentRunId(relayLike, sessionKey, hookCtx, hookEvent) {
  let tracked = null;
  try {
    if (relayLike && typeof relayLike.currentAgentRunId === "function") {
      const snapshot = relayLike.currentAgentRunId(sessionKey);
      if (snapshot && typeof snapshot === "object") tracked = snapshot;
    }
  } catch (_) {

  }
  const runIdActive = !!(tracked && tracked.active === true);
  const exact = pickHookRunId(hookCtx) || pickHookRunId(hookEvent);

  if (exact) return { runId: exact, runIdSource: "host_hook", runIdActive, runIdAmbiguous: false };
  const trackedRunId =
    tracked && typeof tracked.runId === "string" && tracked.runId ? tracked.runId : null;
  if (trackedRunId) {
    return {
      runId: trackedRunId,
      runIdSource: "relay_tracker",
      runIdActive,
      runIdAmbiguous: tracked.ambiguous === true,
    };
  }
  return { runId: null, runIdSource: null, runIdActive: false, runIdAmbiguous: false };
}

function createGlassesWakeController(deps = {}) {
  const dispatchWake = typeof deps.dispatchWake === "function" ? deps.dispatchWake : null;
  const isAgentTurnBusy =
    typeof deps.isAgentTurnBusy === "function" ? deps.isAgentTurnBusy : () => false;
  const emitLifecycle =
    typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const wakeCooldownMs = Number.isFinite(deps.wakeCooldownMs)
    ? deps.wakeCooldownMs
    : DEFAULT_WAKE_COOLDOWN_MS;

  const inFlightBySession = new Map();
  const lastWakeAtBySession = new Map();
  const outbox = [];

  function pushOutbox(entry) {
    outbox.push(entry);
    if (outbox.length > WAKE_OUTBOX_CAP) {
      const evicted = outbox.splice(0, outbox.length - WAKE_OUTBOX_CAP);
      emitLifecycle("wake_outbox_evicted", "warn", { evicted: evicted.length });
    }
  }

  function refsOnly(ref) {
    return {
      sessionKey: typeof ref.sessionKey === "string" ? ref.sessionKey : null,
      surfaceUuid: sanitizeWakeToken(ref.surfaceUuid),
      eventId: coerceInt(ref.eventId),
      result: sanitizeWakeResult(ref.result),
      itemIndex: coerceInt(ref.itemIndex),

      origin: typeof ref.origin === "string" ? ref.origin : "gesture",
      queuedAtMs: coerceInt(ref.queuedAtMs),
    };
  }

  function suppress(reason, refs) {
    emitLifecycle("wake_suppressed", "debug", { reason, ...refs });
    return { dispatched: false, reason };
  }

  function onParkedGesture(ref) {
    const refs = refsOnly(ref || {});
    if (!dispatchWake) {

      if (GLASSES_WAKE_ENABLED_ORIGINS.includes(refs.origin) && refs.sessionKey) {
        if (refs.queuedAtMs === null) refs.queuedAtMs = now();
        const idempotencyKey = `glasses-wake:${refs.surfaceUuid}:${refs.eventId === null ? 0 : refs.eventId}`;
        pushOutbox({
          ...refs,
          idempotencyKey,
          failedAtMs: now(),
          error: "no_dispatch_lane",
        });
        emitLifecycle("wake_unavailable_outboxed", "debug", { ...refs, idempotencyKey });
      }
      return { dispatched: false, reason: "no_dispatch_lane" };
    }
    if (!GLASSES_WAKE_ENABLED_ORIGINS.includes(refs.origin)) {
      return suppress("origin_disabled", refs);
    }
    const sessionKey = refs.sessionKey;
    if (!sessionKey) return suppress("no_session", refs);
    if (isAgentTurnBusy(sessionKey)) {

      return suppress("absorbed_by_active_turn", refs);
    }
    if (inFlightBySession.has(sessionKey)) {
      emitLifecycle("wake_coalesced", "debug", refs);
      return { dispatched: false, reason: "coalesced_into_inflight_wake" };
    }
    const lastWakeAt = lastWakeAtBySession.get(sessionKey);
    if (Number.isFinite(lastWakeAt) && now() - lastWakeAt < wakeCooldownMs) {
      return suppress("cooldown", refs);
    }

    if (refs.queuedAtMs === null) refs.queuedAtMs = now();
    const message = buildWakeMessage(refs);
    const idempotencyKey = `glasses-wake:${refs.surfaceUuid}:${refs.eventId === null ? 0 : refs.eventId}`;
    const payload = { sessionKey, message, idempotencyKey };
    lastWakeAtBySession.set(sessionKey, now());
    const attempt = () => Promise.resolve(dispatchWake(payload));
    const flight = attempt()
      .catch(() => attempt())
      .then(() => {
        emitLifecycle("wake_dispatched", "debug", { ...refs, idempotencyKey });
      })
      .catch((err) => {

        pushOutbox({
          ...refs,
          idempotencyKey,
          failedAtMs: now(),
          error: String((err && err.message) || err),
        });
        emitLifecycle("wake_dispatch_failed", "warn", { ...refs, idempotencyKey });
      })
      .finally(() => {
        inFlightBySession.delete(sessionKey);
      });
    inFlightBySession.set(sessionKey, flight);
    return { dispatched: true, idempotencyKey };
  }

  function peekWakeOutbox() {
    return outbox.map((r) => ({ ...r }));
  }

  function drainWakeOutbox() {
    return outbox.splice(0, outbox.length);
  }

  return { onParkedGesture, peekWakeOutbox, drainWakeOutbox };
}

module.exports = { createGlassesWakeController, createAgentTurnTracker, readAgentRunId, buildWakeMessage, sanitizeWakeToken, GLASSES_WAKE_ENABLED_ORIGINS };
