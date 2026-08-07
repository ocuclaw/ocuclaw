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
  const busyDecayMs = Number.isFinite(deps.busyDecayMs)
    ? deps.busyDecayMs
    : DEFAULT_AGENT_TURN_BUSY_DECAY_MS;
  const lastSeenBySession = new Map();

  function normalizeKey(sessionKey) {
    return sessionKey.replace(/^agent:[^:]+:/, "");
  }

  function markBusy(sessionKey) {
    if (typeof sessionKey !== "string" || !sessionKey) return;
    lastSeenBySession.set(normalizeKey(sessionKey), now());
  }

  function onActivity(sessionKey, phase) {
    if (typeof sessionKey !== "string" || !sessionKey) return;
    if (phase === "end") {
      lastSeenBySession.delete(normalizeKey(sessionKey));
      return;
    }
    lastSeenBySession.set(normalizeKey(sessionKey), now());
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

  return { markBusy, onActivity, isBusy };
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

module.exports = { createGlassesWakeController, createAgentTurnTracker, buildWakeMessage, sanitizeWakeToken, GLASSES_WAKE_ENABLED_ORIGINS };
