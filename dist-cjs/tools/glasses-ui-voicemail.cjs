const { sanitizeWakeToken } = require("./glasses-ui-wake.cjs");
const { normalizeGlassesSessionKey } = require("./glasses-ui-surfaces.cjs");

const DEFAULT_VOICEMAIL_TTL_MS = 30 * 60_000;
const VOICEMAIL_MAX_ENTRIES_PER_INJECTION = 8;

const VOICEMAIL_PENDING_CAP_PER_SESSION = 32;
const DELIVERED_KEY_CAP = 256;

const RESULT_ENUM = new Set(["selected", "back"]);

const REAP_REASON_ENUM = new Set(["drain_session", "drain_all", "exit", "pop_back"]);

const EVICTION_REASON_ENUM = new Set(["event_log_cap"]);

function coerceInt(value) {
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function sanitizeResult(value) {
  return RESULT_ENUM.has(value) ? value : "event";
}

const IDEMPOTENCY_KEY_PATTERN = /^[a-z0-9:._-]{1,80}$/i;
function sanitizeIdempotencyKey(value) {
  const raw = String(value == null ? "" : value);
  return IDEMPOTENCY_KEY_PATTERN.test(raw) ? raw : "invalid";
}

function createGlassesVoicemail(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : DEFAULT_VOICEMAIL_TTL_MS;
  const maxEntries = Number.isFinite(deps.maxEntriesPerInjection)
    ? deps.maxEntriesPerInjection
    : VOICEMAIL_MAX_ENTRIES_PER_INJECTION;
  const drainWakeOutbox =
    typeof deps.drainWakeOutbox === "function" ? deps.drainWakeOutbox : () => [];
  const drainDeadLetter =
    typeof deps.drainDeadLetter === "function" ? deps.drainDeadLetter : () => [];
  const emitLifecycle =
    typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};

  const pendingBySession = new Map();

  const deliveredKeys = new Set();
  const ackPreviews = new Map();
  let nextAckToken = 1;

  function rememberDelivered(key) {
    deliveredKeys.add(key);
    if (deliveredKeys.size > DELIVERED_KEY_CAP) {
      const oldest = deliveredKeys.values().next().value;
      deliveredKeys.delete(oldest);
    }
  }

  function dedupeKeyOf(entry) {
    return `${entry.surfaceUuid}:${entry.eventId === null ? 0 : entry.eventId}`;
  }

  function mintAckToken(nowMs) {
    const token = `vmack:${nowMs}:${nextAckToken}`;
    nextAckToken += 1;
    return token;
  }

  function pruneAckPreviews(nowMs) {
    for (const [token, preview] of ackPreviews) {
      if (!preview || !Number.isFinite(preview.expiresAtMs) || preview.expiresAtMs < nowMs) {
        ackPreviews.delete(token);
      }
    }
  }

  function ingest(entries, nowMs) {
    const bySession = new Map();
    for (const entry of entries) {
      if (!entry.sessionKey) continue;
      let batch = bySession.get(entry.sessionKey);
      if (!batch) { batch = []; bySession.set(entry.sessionKey, batch); }
      batch.push(entry);
    }
    for (const [sessionKey, batch] of bySession) {
      let expired = 0;
      const fresh = [];
      for (const entry of batch) {
        const basisMs = Number.isFinite(entry.owedSinceMs) ? entry.owedSinceMs : nowMs;
        if (nowMs - basisMs > ttlMs) { expired += 1; continue; }
        fresh.push(entry);
      }
      if (expired > 0) {
        emitLifecycle("voicemail_expired", "warn", { sessionKey, dropped: expired, ttlMs });
      }
      if (fresh.length === 0) continue;
      const list = pendingBySession.get(sessionKey) || [];
      list.push(...fresh);
      if (list.length > VOICEMAIL_PENDING_CAP_PER_SESSION) {
        const evicted = list.splice(0, list.length - VOICEMAIL_PENDING_CAP_PER_SESSION);
        emitLifecycle("voicemail_evicted", "warn", { sessionKey, evicted: evicted.length });
      }
      pendingBySession.set(sessionKey, list);
    }
  }

  function fromOutbox(record) {
    const surfaceUuid = sanitizeWakeToken(record && record.surfaceUuid);
    const eventId = coerceInt(record && record.eventId);
    return {
      sessionKey: normalizeGlassesSessionKey(record && record.sessionKey) || null,
      surfaceUuid,
      eventId,
      result: sanitizeResult(record && record.result),
      itemIndex: coerceInt(record && record.itemIndex),
      queuedAtMs: coerceInt(record && record.queuedAtMs),
      owedSinceMs: coerceInt(record && record.failedAtMs) ?? coerceInt(record && record.queuedAtMs),
      idempotencyKey: sanitizeIdempotencyKey(record && record.idempotencyKey),
      via: record && record.error === "no_dispatch_lane" ? "wake_unavailable" : "wake_failed",
      staleAfterMs: null,
      surfaceLive: true,
    };
  }

  function fromDeadLetter(sessionKey, record) {
    const surfaceUuid = sanitizeWakeToken(record && record.surfaceUuid);
    const rawReason = record && record.reason;
    const evicted = EVICTION_REASON_ENUM.has(rawReason);
    const reason = evicted
      ? `evicted:${rawReason}`
      : REAP_REASON_ENUM.has(rawReason)
        ? `reaped:${rawReason}`
        : "reaped";
    const staleAfterMs = record && Number.isFinite(record.staleAfterMs) ? record.staleAfterMs : null;
    const events = record && Array.isArray(record.events) ? record.events : [];
    return events.map((ev) => {
      const eventId = coerceInt(ev && ev.eventId);
      return {
        sessionKey,
        surfaceUuid,
        eventId,
        result: sanitizeResult(ev && ev.outcome && ev.outcome.result),
        itemIndex: coerceInt(ev && ev.outcome && ev.outcome.selected_index),
        queuedAtMs: coerceInt(ev && ev.queuedAtMs),
        owedSinceMs: coerceInt(ev && ev.queuedAtMs) ?? coerceInt(record && record.reapedAtMs),
        idempotencyKey: `glasses-voicemail:${surfaceUuid}:${eventId === null ? 0 : eventId}`,
        via: reason,
        staleAfterMs,

        surfaceLive: false,
        evicted,
      };
    });
  }

  function formatEntry(entry, nowMs) {
    const ageMs = Number.isFinite(entry.queuedAtMs) ? Math.max(0, nowMs - entry.queuedAtMs) : null;
    const stale =
      Number.isFinite(entry.staleAfterMs) && ageMs !== null && ageMs > entry.staleAfterMs;
    const parts = [
      `- surfaceUuid=${entry.surfaceUuid}`,
      `eventId=${entry.eventId}`,
      `result=${entry.result}`,
      `itemIndex=${entry.itemIndex}`,
      `queuedAtMs=${entry.queuedAtMs}`,
      `ageMs=${ageMs}`,
      `via=${entry.via}`,
      `idempotencyKey=${entry.idempotencyKey}`,
    ];
    if (stale) parts.push("stale=true");
    if (entry.evicted) {

      parts.push(
        "(surface may still be live, but these events were evicted from its event log by the per-surface cap: " +
          "this voicemail is their only delivery, so treat the refs as the wearer's parked answer; " +
          "re-confirm before acting if stale)",
      );
    } else {
      parts.push(
        entry.surfaceLive
          ? '(surface may still be live: re-render it with update:"patch" to collect)'
          : "(surface no longer live: treat the refs as the wearer's parked answer to that surface; re-confirm before acting if stale)",
      );
    }
    return parts.join(" ");
  }

  function sweepExpired(nowMs) {
    for (const [key, list] of pendingBySession) {
      const fresh = list.filter((entry) => {
        const basisMs = Number.isFinite(entry.owedSinceMs) ? entry.owedSinceMs : nowMs;
        return nowMs - basisMs <= ttlMs;
      });
      const dropped = list.length - fresh.length;
      if (dropped > 0) {
        emitLifecycle("voicemail_expired", "warn", { sessionKey: key, dropped, ttlMs });
      }
      if (fresh.length === 0) {
        pendingBySession.delete(key);
      } else if (dropped > 0) {
        pendingBySession.set(key, fresh);
      }
    }
  }

  function pendingSessionCount() {
    return pendingBySession.size;
  }

  function ingestSourcesFor(sessionKey, nowMs) {
    sweepExpired(nowMs);

    ingest(
      [
        ...drainWakeOutbox().map((record) => fromOutbox(record)),
        ...(drainDeadLetter(sessionKey) || []).flatMap((r) => fromDeadLetter(sessionKey, r)),
      ],
      nowMs,
    );
  }

  function preparePendingInjection(sessionKey, nowMs) {
    const pending = pendingBySession.get(sessionKey);
    if (!pending || pending.length === 0) {
      pendingBySession.delete(sessionKey);
      return null;
    }

    const byEvent = new Map();
    for (const entry of pending) {
      const key = dedupeKeyOf(entry);
      const existing = byEvent.get(key);
      if (!existing || (existing.surfaceLive && !entry.surfaceLive)) {
        byEvent.set(key, entry);
      }
    }

    const deliverable = [];
    let dropped = 0;
    const freshPending = [];
    for (const entry of byEvent.values()) {
      const basisMs = Number.isFinite(entry.owedSinceMs) ? entry.owedSinceMs : nowMs;
      if (nowMs - basisMs > ttlMs) { dropped += 1; continue; }
      const key = dedupeKeyOf(entry);
      if (deliveredKeys.has(key)) continue;
      deliverable.push(entry);
    }
    for (const entry of pending) {
      const basisMs = Number.isFinite(entry.owedSinceMs) ? entry.owedSinceMs : nowMs;
      const key = dedupeKeyOf(entry);
      if (nowMs - basisMs <= ttlMs && !deliveredKeys.has(key)) freshPending.push(entry);
    }
    if (freshPending.length === 0) {
      pendingBySession.delete(sessionKey);
    } else if (freshPending.length !== pending.length) {
      pendingBySession.set(sessionKey, freshPending);
    }
    if (dropped > 0) {

      emitLifecycle("voicemail_expired", "warn", { sessionKey, dropped, ttlMs });
    }
    if (deliverable.length === 0) return null;

    const shown = deliverable.slice(-maxEntries);
    const overflow = deliverable.length - shown.length;
    const lines = [
      "[ocuclaw glasses-ui voicemail] Plugin-generated notification - NOT the wearer speaking.",
      "Parked glasses events could not be delivered by a wake turn while you were away:",
      ...shown.map((entry) => formatEntry(entry, nowMs)),
    ];
    if (overflow > 0) lines.push(`(+${overflow} older parked events omitted)`);
    lines.push("Tapped content is never included here by design.");
    const fragment = lines.join("\n");
    emitLifecycle("voicemail_injected", "debug", {
      sessionKey,
      entries: shown.length,
      overflow,
      chars: fragment.length,
    });
    return { fragment, keys: shown.map((entry) => dedupeKeyOf(entry)) };
  }

  function consumePreviewKeys(sessionKey, keys) {
    if (!Array.isArray(keys) || keys.length === 0) return false;
    const keySet = new Set(keys);
    const pending = pendingBySession.get(sessionKey) || [];
    const remaining = pending.filter((entry) => !keySet.has(dedupeKeyOf(entry)));
    if (remaining.length === 0) {
      pendingBySession.delete(sessionKey);
    } else if (remaining.length !== pending.length) {
      pendingBySession.set(sessionKey, remaining);
    }
    for (const key of keySet) rememberDelivered(key);
    return keySet.size > 0;
  }

  function buildInjection(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (typeof sessionKey !== "string" || !sessionKey) return null;
    const nowMs = now();
    ingestSourcesFor(sessionKey, nowMs);
    const prepared = preparePendingInjection(sessionKey, nowMs);
    if (!prepared) return null;
    consumePreviewKeys(sessionKey, prepared.keys);
    return prepared.fragment;
  }

  function previewInjection(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (typeof sessionKey !== "string" || !sessionKey) return null;
    const nowMs = now();
    pruneAckPreviews(nowMs);
    ingestSourcesFor(sessionKey, nowMs);
    const prepared = preparePendingInjection(sessionKey, nowMs);
    if (!prepared) return null;
    const ackToken = mintAckToken(nowMs);
    ackPreviews.set(ackToken, {
      sessionKey,
      keys: prepared.keys,
      expiresAtMs: nowMs + ttlMs,
    });
    return { fragment: prepared.fragment, ackToken };
  }

  function ackInjection(rawSessionKey, ackToken) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (typeof sessionKey !== "string" || !sessionKey) return false;
    const nowMs = now();
    pruneAckPreviews(nowMs);
    const token = typeof ackToken === "string" ? ackToken : "";
    const preview = ackPreviews.get(token);
    if (!preview || preview.sessionKey !== sessionKey) return false;
    ackPreviews.delete(token);
    return consumePreviewKeys(sessionKey, preview.keys);
  }

  return { buildInjection, previewInjection, ackInjection, pendingSessionCount };
}

module.exports = { createGlassesVoicemail, DEFAULT_VOICEMAIL_TTL_MS, VOICEMAIL_MAX_ENTRIES_PER_INJECTION, VOICEMAIL_PENDING_CAP_PER_SESSION };
