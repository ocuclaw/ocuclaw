const { sanitizeWakeToken } = require("./glasses-ui-wake.cjs");
const { RENDER_FAILURE_CODES, normalizeGlassesSessionKey } = require("./glasses-ui-surfaces.cjs");

const DEFAULT_FEEDBACK_TTL_MS = 10 * 60_000;

const FEEDBACK_MAX_ENTRIES_PER_INJECTION = 4;

const FEEDBACK_PENDING_CAP_PER_SESSION = 16;

const FEEDBACK_QUALIFYING_CLASSES = Object.freeze([
  "render_rejected",
  "receipt_rejected",
  "render_error",
]);

const FEEDBACK_RENDER_ERROR_CODES = Object.freeze([...RENDER_FAILURE_CODES]);

const FEEDBACK_RENDER_ERROR_CAP_PER_SURFACE = 3;

const FEEDBACK_EXCLUDED_CLASSES = Object.freeze({
  input_unattributed: "not_visible_to_plugin",
  not_delivered: "not_visible_to_plugin",
  not_handled: "not_visible_to_plugin",
  no_open_surface: "not_visible_to_plugin",
  no_display_change_in_settle_window: "not_visible_to_plugin",
  ordering_ambiguous: "not_deterministic",
  nav_reconcile: "reducer_derived",
  dead_letter_appended: "owned_by_voicemail",
  surface_outcome: "not_a_refusal",
  cron_tick_emit: "not_a_refusal",
});

const FEEDBACK_RECEIPT_REASONS = Object.freeze([
  "no_send_attempt",
  "surface_uuid_mismatch",
  "stale_seq",
]);

const CLASS_ENUM = new Set(FEEDBACK_QUALIFYING_CLASSES);
const RECEIPT_REASON_ENUM = new Set(FEEDBACK_RECEIPT_REASONS);
const RENDER_ERROR_CODE_ENUM = new Set(FEEDBACK_RENDER_ERROR_CODES);
const DELIVERED_KEY_CAP = 128;

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
function sanitizeCode(value) {
  const raw = String(value == null ? "" : value);
  return CODE_PATTERN.test(raw) ? raw : "invalid";
}

function coerceInt(value) {
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function formatEntry(entry) {
  const parts = [
    `- surfaceUuid=${entry.surfaceUuid}`,
    `refusal=${entry.class}`,
    `code=${entry.code}`,
  ];
  if (entry.seq !== null) parts.push(`seq=${entry.seq}`);
  if (entry.expectedSeq !== null) parts.push(`expectedSeq=${entry.expectedSeq}`);
  parts.push(`atMs=${entry.atMs}`);
  return parts.join(" ");
}

function composeFragment(shown, omitted) {
  const lines = [
    "[ocuclaw glasses-ui feedback] Plugin-generated notification - NOT the wearer speaking.",
    "Render attempts REFUSED since your last turn (refs only; no surface content):",
    ...shown.map((entry) => formatEntry(entry)),
  ];

  if (omitted > 0) lines.push(`(+${omitted} older refusals omitted)`);
  lines.push(
    "Fix the named code and re-author. receipt_rejected means the send was " +
      "attempted and left unconfirmed — no line here is a claim about what " +
      "reached the wearer.",
  );
  return lines.join("\n");
}

const WORST_UUID_CHARS = 27;
const WORST_CODE_CHARS = 48;
const WORST_INT_CHARS = 24;

const WORST_CASE_ENTRY = Object.freeze({
  surfaceUuid: "u".repeat(WORST_UUID_CHARS),

  class: "receipt_rejected",
  code: "c".repeat(WORST_CODE_CHARS),

  seq: "9".repeat(WORST_INT_CHARS),
  expectedSeq: "9".repeat(WORST_INT_CHARS),
  atMs: "9".repeat(WORST_INT_CHARS),
});

const FEEDBACK_FRAGMENT_MIN_CHARS = composeFragment(
  [WORST_CASE_ENTRY],

  99,
).length;

const FEEDBACK_FRAGMENT_MAX_CHARS = composeFragment(
  Array.from({ length: FEEDBACK_MAX_ENTRIES_PER_INJECTION }, () => WORST_CASE_ENTRY),
  99,
).length;

function createGlassesFeedbackLedger(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : DEFAULT_FEEDBACK_TTL_MS;
  const maxEntries = Number.isFinite(deps.maxEntriesPerInjection)
    ? deps.maxEntriesPerInjection
    : FEEDBACK_MAX_ENTRIES_PER_INJECTION;
  const emitLifecycle =
    typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};

  const requestedMaxChars = Number.isFinite(deps.maxFragmentChars)
    ? deps.maxFragmentChars
    : FEEDBACK_FRAGMENT_MAX_CHARS;
  const maxChars = Math.max(requestedMaxChars, FEEDBACK_FRAGMENT_MIN_CHARS);
  if (maxChars !== requestedMaxChars) {
    emitLifecycle("feedback_cap_clamped", "debug", {
      requested: requestedMaxChars,
      clampedTo: maxChars,
      floor: FEEDBACK_FRAGMENT_MIN_CHARS,
    });
  }

  const pendingBySession = new Map();
  const deliveredKeys = new Set();
  const ackPreviews = new Map();
  let nextAckToken = 1;
  let seq = 0;

  function rememberDelivered(key) {
    deliveredKeys.add(key);
    if (deliveredKeys.size > DELIVERED_KEY_CAP) {
      const oldest = deliveredKeys.values().next().value;
      deliveredKeys.delete(oldest);
    }
  }

  function dedupeKeyOf(entry) {
    return `${entry.surfaceUuid}:${entry.class}:${entry.code}:${entry.ordinal}`;
  }

  function mintAckToken(nowMs) {
    const token = `fback:${nowMs}:${nextAckToken}`;
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

  function record(input) {
    const cls = input && CLASS_ENUM.has(input.class) ? input.class : null;
    if (!cls) return false;
    const sessionKey = normalizeGlassesSessionKey(input && input.sessionKey);
    if (typeof sessionKey !== "string" || !sessionKey) return false;

    let code;
    if (cls === "receipt_rejected") {

      if (!RECEIPT_REASON_ENUM.has(input && input.code)) return false;
      code = input.code;
    } else if (cls === "render_error") {

      if (!RENDER_ERROR_CODE_ENUM.has(input && input.code)) return false;
      code = input.code;
    } else {
      code = sanitizeCode(input && input.code);
    }

    const rawUuid = input && input.surfaceUuid;
    const surfaceUuid =
      rawUuid === null || rawUuid === undefined || rawUuid === ""
        ? "none"
        : sanitizeWakeToken(rawUuid);

    if (cls === "receipt_rejected" && surfaceUuid === "none") return false;

    if (cls === "render_error" && surfaceUuid === "none") return false;

    const nowMs = now();

    if (cls === "render_error") {
      const pending = pendingBySession.get(sessionKey) || [];
      const alreadyPending = pending.filter(
        (e) => e.class === "render_error" && e.surfaceUuid === surfaceUuid,
      ).length;
      if (alreadyPending >= FEEDBACK_RENDER_ERROR_CAP_PER_SURFACE) return false;
    }
    seq += 1;
    const entry = {
      sessionKey,
      class: cls,
      code,
      surfaceUuid,
      seq: coerceInt(input && input.seq),
      expectedSeq: coerceInt(input && input.expectedSeq),
      atMs: nowMs,
      ordinal: seq,
    };

    const list = pendingBySession.get(sessionKey) || [];
    list.push(entry);
    if (list.length > FEEDBACK_PENDING_CAP_PER_SESSION) {
      const evicted = list.splice(0, list.length - FEEDBACK_PENDING_CAP_PER_SESSION);
      emitLifecycle("feedback_evicted", "warn", { sessionKey, evicted: evicted.length });
    }
    pendingBySession.set(sessionKey, list);
    return true;
  }

  function sweepExpired(nowMs) {
    for (const [key, list] of pendingBySession) {
      const fresh = list.filter((entry) => nowMs - entry.atMs <= ttlMs);
      const dropped = list.length - fresh.length;
      if (dropped > 0) {
        emitLifecycle("feedback_expired", "debug", { sessionKey: key, dropped, ttlMs });
      }
      if (fresh.length === 0) pendingBySession.delete(key);
      else if (dropped > 0) pendingBySession.set(key, fresh);
    }
  }

  function prepareInjection(sessionKey, nowMs) {
    sweepExpired(nowMs);
    const pending = pendingBySession.get(sessionKey);
    if (!pending || pending.length === 0) {
      pendingBySession.delete(sessionKey);
      return null;
    }

    const deliverable = [];
    for (const entry of pending) {
      if (deliveredKeys.has(dedupeKeyOf(entry))) continue;
      deliverable.push(entry);
    }
    if (deliverable.length === 0) return null;

    let shown = deliverable.slice(-maxEntries);
    let omitted = deliverable.length - shown.length;
    let fragment = composeFragment(shown, omitted);

    while (fragment.length > maxChars && shown.length > 1) {
      shown = shown.slice(1);
      omitted = deliverable.length - shown.length;
      fragment = composeFragment(shown, omitted);
    }

    emitLifecycle("feedback_injected", "debug", {
      sessionKey,
      entries: shown.length,
      omitted,
      chars: fragment.length,
    });

    return { fragment, keys: deliverable.map((entry) => dedupeKeyOf(entry)) };
  }

  function consumeKeys(sessionKey, keys) {
    if (!Array.isArray(keys) || keys.length === 0) return false;
    const keySet = new Set(keys);
    const pending = pendingBySession.get(sessionKey) || [];
    const remaining = pending.filter((entry) => !keySet.has(dedupeKeyOf(entry)));
    if (remaining.length === 0) pendingBySession.delete(sessionKey);
    else if (remaining.length !== pending.length) pendingBySession.set(sessionKey, remaining);
    for (const key of keySet) rememberDelivered(key);
    return true;
  }

  function buildInjection(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (typeof sessionKey !== "string" || !sessionKey) return null;
    const prepared = prepareInjection(sessionKey, now());
    if (!prepared) return null;
    consumeKeys(sessionKey, prepared.keys);
    return prepared.fragment;
  }

  function previewInjection(rawSessionKey) {
    const sessionKey = normalizeGlassesSessionKey(rawSessionKey);
    if (typeof sessionKey !== "string" || !sessionKey) return null;
    const nowMs = now();
    pruneAckPreviews(nowMs);
    const prepared = prepareInjection(sessionKey, nowMs);
    if (!prepared) return null;
    const ackToken = mintAckToken(nowMs);
    ackPreviews.set(ackToken, { sessionKey, keys: prepared.keys, expiresAtMs: nowMs + ttlMs });
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
    return consumeKeys(sessionKey, preview.keys);
  }

  function pendingSessionCount() {
    return pendingBySession.size;
  }

  return { record, buildInjection, previewInjection, ackInjection, pendingSessionCount };
}

module.exports = { createGlassesFeedbackLedger, DEFAULT_FEEDBACK_TTL_MS, FEEDBACK_MAX_ENTRIES_PER_INJECTION, FEEDBACK_PENDING_CAP_PER_SESSION, FEEDBACK_FRAGMENT_MAX_CHARS, FEEDBACK_FRAGMENT_MIN_CHARS, FEEDBACK_QUALIFYING_CLASSES, FEEDBACK_EXCLUDED_CLASSES, FEEDBACK_RECEIPT_REASONS, FEEDBACK_RENDER_ERROR_CODES, FEEDBACK_RENDER_ERROR_CAP_PER_SURFACE };
