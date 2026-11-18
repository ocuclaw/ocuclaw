const { createHash, randomBytes } = require("node:crypto");
const PROGRAM_CARD_LOOK_DRIVE_CAPABILITY = "programCardsLookDriveV1";

const PROGRAM_CARD_LOOK_DRIVE_TIMEOUT_MS = 10_000;

const PROGRAM_CARD_LOOK_DRIVE_HOST_TIMEOUT_MS = 25_000;
const PROGRAM_CARD_LOOK_DRIVE_IDLE_MS = 2 * 60_000;
const PROGRAM_CARD_LOOK_DRIVE_MAX_CALLS = 8;
const PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES = 12;
const PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES_PER_CALL = 2;
const PROGRAM_CARD_LOOK_DRIVE_GUIDE =
  "For a stateful test, start with drive:true and 1-12 steps, then continue the same frozen private copy with copyId and more steps. Use at most 2 snap steps per call. The copy frees itself when you edit the card, start another Look, stay idle 2 minutes or end your turn, so it needs no Stop. The whole drive is one of the turn's 3 Looks.";

const COPY_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const PLAN_HASH = /^[a-f0-9]{32}$/;
const record = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const clone = (value     ) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const refused = (error        )                               => ({ ok: false, error });
const planHash = (steps       ) => createHash("sha256").update(JSON.stringify(steps), "utf8").digest("hex").slice(0, 32);

const programCardLookDriveParameterProperties = Object.freeze({
  drive: {
    type: "boolean",
    description: "true starts one stateful private copy. Continue it with the returned copyId.",
  },
  copyId: {
    type: "string",
    maxLength: 80,
    description: "The private copy returned by the first drive call.",
  },
  stop: {
    type: "boolean",
    description: "Free this private copy now. Not needed: an edit, another Look or the end of your turn frees it.",
  },
});

function isProgramCardLookDriveInput(input     ) {
  return record(input) && (input.drive === true || input.copyId !== undefined || input.stop !== undefined);
}

function validateProgramCardLookDriveFields(input     ) {
  if (!record(input)) return refused("invalid_request: input must be an object");
  if (input.drive !== undefined && input.drive !== true) return refused("invalid_request: drive must be true");
  if (input.copyId !== undefined && (typeof input.copyId !== "string" || !COPY_ID.test(input.copyId))) {
    return refused("invalid_request: copyId is invalid");
  }
  if (input.stop !== undefined && input.stop !== true) return refused("invalid_request: stop must be true");
  if (input.stop === true && !input.copyId) return refused("invalid_request: Stop needs copyId");
  if (input.drive === true && input.copyId) return refused("invalid_request: start omits copyId");
  if (input.stop === true && input.drive === true) return refused("invalid_request: Stop is not a start");
  if (input.start !== undefined && input.copyId) return refused("invalid_request: a drive copy keeps its original frozen start");
  if ((input.copyId || input.drive === true) && input.live === true) return refused("invalid_request: drive and live capture are separate modes");
  return { ok: true };
}

function words(value     ) {
  if (!Array.isArray(value) || value.length > 200 || value.some(word => typeof word !== "string" || word.length > 120)) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8192; } catch { return false; }
}

function problemText(value     ) {
  return Array.isArray(value) && value.length <= 32 &&
    value.every(problem => typeof problem === "string" && problem.length > 0 && problem.length <= 300);
}

function snapIndexes(steps       ) {
  const indexes           = [];
  for (const [index, step] of steps.entries()) {

    if (record(step) && typeof step.snap === "string" && step.snap.length > 0) indexes.push(index);
  }
  return indexes;
}

function validateProgramCardLookDriveResult(value     , expected      = {}) {
  if (!record(value)) return refused("invalid_drive_result");
  const partial = expected.partial === true;
  if (typeof value.copyId !== "string" || !COPY_ID.test(value.copyId)) return refused("invalid_drive_copy");
  if (expected.copyId && value.copyId !== expected.copyId) return refused("drive_copy_changed");
  if (!Number.isFinite(value.clockMs) || value.clockMs < 0) return refused("invalid_drive_clock");
  if (!words(value.screenWords)) return refused("invalid_drive_screen_words");
  if (typeof value.stateSummary !== "string" || (!partial && !value.stateSummary.trim()) || value.stateSummary.length > 500) {
    return refused("invalid_drive_state_summary");
  }
  if (!problemText(value.problemText)) return refused("invalid_drive_problem_text");
  if (typeof value.planHash !== "string" || !PLAN_HASH.test(value.planHash)) return refused("invalid_drive_plan_hash");
  if (expected.planHash && value.planHash !== expected.planHash) return refused("drive_plan_changed");
  if (typeof value.digest !== "string" || !PLAN_HASH.test(value.digest) || !Number.isFinite(value.t0) || value.t0 < 0) {
    return refused("invalid_drive_identity");
  }
  if (expected.digest && value.digest !== expected.digest || expected.t0 !== undefined && value.t0 !== expected.t0) {
    return refused("drive_identity_changed");
  }
  const steps = Array.isArray(expected.steps) ? expected.steps : [];
  const snaps = new Set(snapIndexes(steps));
  const pictures = value.pictures ?? [];
  if (!Array.isArray(pictures) || pictures.length > PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES_PER_CALL) {
    return refused("drive_picture_call_limit");
  }
  const seen = new Set        ();
  for (const picture of pictures) {
    if (!record(picture) || !Number.isInteger(picture.step) || !snaps.has(picture.step) || seen.has(picture.step)) {
      return refused("invalid_drive_picture_step");
    }
    seen.add(picture.step);
  }
  return { ok: true         , result: {
    ...value,
    stateSummary: value.stateSummary.trim(),
    screenWords: [...value.screenWords],
    problemText: [...value.problemText],
    pictures: [...pictures],
  } };
}

function createProgramCardLookDriveController(options      = {}) {
  const sessions = new Map             ();
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const idleMs = Number.isFinite(options.idleMs) && options.idleMs > 0 ? options.idleMs : PROGRAM_CARD_LOOK_DRIVE_IDLE_MS;
  const newCopyId = typeof options.newCopyId === "function" ? options.newCopyId
    : () => `look-${randomBytes(12).toString("hex")}`;
  let serial = 0;

  function notifyRelease(entry     , reason        ) {
    if (typeof options.onRelease !== "function") return;
    try {
      options.onRelease({
        sessionKey: entry.sessionKey,
        copyId: entry.copyId,
        reason,
        calls: entry.calls,
        pictures: entry.pictures,
        clockMs: entry.clockMs,
        replayPlan: entry.planHash ? { version: 1, ...(entry.start !== undefined ? { start: clone(entry.start) } : {}),
          steps: clone(entry.steps), planHash: entry.planHash } : null,
        stopRequest: entry.copyId ? { drive: true, copyId: entry.copyId, stop: true,
          ...(entry.cardId ? { cardId: entry.cardId } : {}) } : null,
      });
    } catch {

    }
  }

  function closeEntry(entry     , reason        ) {
    if (!entry || sessions.get(entry.sessionKey) !== entry) return null;
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
    sessions.delete(entry.sessionKey);
    notifyRelease(entry, reason);
    return {
      copyId: entry.copyId,
      reason,
      calls: entry.calls,
      pictures: entry.pictures,
      clockMs: entry.clockMs,
      cardId: entry.cardId,
      digest: entry.digest,
      t0: entry.t0,
      replayPlan: entry.planHash ? { version: 1, ...(entry.start !== undefined ? { start: clone(entry.start) } : {}),
        steps: clone(entry.steps), planHash: entry.planHash } : null,
    };
  }

  function arm(entry     ) {
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.lastActivityMs = now();
    entry.timer = setTimer(() => {
      const remaining = entry.lastActivityMs + idleMs - now();
      if (remaining > 0) {
        entry.timer = setTimer(() => closeEntry(entry, "idle"), remaining);
        return;
      }
      closeEntry(entry, "idle");
    }, idleMs);
    if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
  }

  function session(value     ) {
    return typeof value === "string" && value.trim() ? value.trim() : "main";
  }

  function reserve(sessionKey     , input     , supported = false) {
    const normalizedSession = session(sessionKey);
    if (!isProgramCardLookDriveInput(input)) return { ok: true, drive: false, payload: input };
    if (supported !== true) return refused("unsupported");
    const valid = validateProgramCardLookDriveFields(input);
    if (!valid.ok) return valid;
    const active = sessions.get(normalizedSession);
    if (input.stop === true) {
      if (!active || active.copyId !== input.copyId) return refused("drive_copy_not_found");
      const released = closeEntry(active, "stop");
      return { ok: true, drive: true, free: true, payload: { drive: true, copyId: input.copyId, stop: true,
        ...(active.cardId ? { cardId: active.cardId } : {}) }, ...released };
    }
    const starting = input.drive === true;
    if (starting && active) return refused("drive_copy_already_live");
    if (!starting && !active) return refused("drive_copy_not_found");
    if (!starting && active.copyId !== input.copyId) return refused("drive_copy_not_found");
    const steps = Array.isArray(input.steps) ? clone(input.steps) : [];
    const requestedPictures = snapIndexes(steps).length;
    if (requestedPictures > PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES_PER_CALL) return refused("drive_picture_call_limit");
    if ((active?.pictures ?? 0) + requestedPictures > PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES) return refused("drive_picture_limit");
    let reservedCopyId = active?.copyId ?? null;
    if (starting) {
      try { reservedCopyId = newCopyId(); } catch { return refused("drive_copy_id_failed"); }
      if (typeof reservedCopyId !== "string" || !COPY_ID.test(reservedCopyId)) return refused("drive_copy_id_failed");
    }
    const entry = active ?? {
      sessionKey: normalizedSession,
      copyId: reservedCopyId,
      calls: 0,
      pictures: 0,
      clockMs: null,
      cardId: typeof input.cardId === "string" ? input.cardId : null,
      digest: null,
      t0: null,
      start: clone(input.start),
      steps: [],
      planHash: null,
      lastSteps: null,
      pending: null,
      timer: null,
      lastActivityMs: now(),
    };
    if (!active) sessions.set(normalizedSession, entry);
    if (active && input.cardId && active.cardId && input.cardId !== active.cardId) return refused("drive_card_changed");
    if (entry.pending) return refused("drive_call_in_flight");
    if (entry.calls >= PROGRAM_CARD_LOOK_DRIVE_MAX_CALLS) return refused("drive_call_limit");
    const token = `drive-${++serial}`;
    entry.calls += 1;
    entry.pending = token;
    arm(entry);
    const continuation = clone(input);
    delete continuation.drive;
    delete continuation.start;
    return {
      ok: true,
      drive: true,
      timeoutMs: PROGRAM_CARD_LOOK_DRIVE_HOST_TIMEOUT_MS,
      reservation: { sessionKey: normalizedSession, token, steps },

      payload: starting ? { ...clone(input), copyId: entry.copyId } : continuation,
    };
  }

  function complete(reservation     , value     ) {
    const entry = reservation && sessions.get(reservation.sessionKey);
    if (!entry || entry.pending !== reservation.token) return refused("drive_call_expired");
    const nextSteps = [...entry.steps, ...clone(reservation.steps)];
    const checked = validateProgramCardLookDriveResult(value, { copyId: entry.copyId, steps: reservation.steps,
      planHash: planHash(nextSteps), ...(entry.digest ? { digest: entry.digest } : {}), ...(entry.t0 !== null ? { t0: entry.t0 } : {}) });
    if (!checked.ok) {
      closeEntry(entry, "invalid_response");
      return checked;
    }
    const result = checked.result;
    if (entry.clockMs !== null && reservation.steps.length === 0 && result.clockMs !== entry.clockMs) {
      closeEntry(entry, "clock_advanced_while_paused");
      return refused("drive_clock_advanced_while_paused");
    }
    if (entry.clockMs !== null && result.clockMs < entry.clockMs) {
      closeEntry(entry, "clock_rewound");
      return refused("drive_clock_rewound");
    }
    if (entry.pictures + result.pictures.length > PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES) {
      closeEntry(entry, "picture_limit");
      return refused("drive_picture_limit");
    }
    if (entry.copyId === null) entry.copyId = result.copyId;
    if (entry.digest === null) entry.digest = result.digest;
    if (entry.t0 === null) entry.t0 = result.t0;
    entry.clockMs = result.clockMs;
    entry.pictures += result.pictures.length;

    const repeated = reservation.steps.length > 0 && entry.lastSteps !== null
      && JSON.stringify(entry.lastSteps) === JSON.stringify(reservation.steps);
    entry.lastSteps = clone(reservation.steps);
    entry.steps.push(...clone(reservation.steps));
    entry.planHash = result.planHash;
    entry.pending = null;
    arm(entry);
    return {
      ok: true,
      copyId: entry.copyId,
      calls: entry.calls,
      callsLeft: PROGRAM_CARD_LOOK_DRIVE_MAX_CALLS - entry.calls,
      repeated,
      pictures: entry.pictures,
      clockMs: entry.clockMs,
      screenWords: result.screenWords,
      stateSummary: result.stateSummary,
      problemText: result.problemText,
      callPictures: result.pictures,
      replayPlan: { version: 1, ...(entry.start !== undefined ? { start: clone(entry.start) } : {}),
        steps: clone(entry.steps), planHash: entry.planHash },
      digest: entry.digest,
      t0: entry.t0,
    };
  }

  function fail(reservation     , reason = "call_failed") {
    const entry = reservation && sessions.get(reservation.sessionKey);
    if (!entry || entry.pending !== reservation.token) return null;
    return closeEntry(entry, reason);
  }

  function end(sessionKey     , reason        ) {
    return closeEntry(sessions.get(session(sessionKey)), reason);
  }

  function snapshot(sessionKey     ) {
    const entry = sessions.get(session(sessionKey));
    if (!entry) return null;
    return {
      sessionKey: entry.sessionKey,
      copyId: entry.copyId,
      calls: entry.calls,
      pictures: entry.pictures,
      clockMs: entry.clockMs,
      cardId: entry.cardId,
      digest: entry.digest,
      t0: entry.t0,
      pending: entry.pending !== null,
      replayPlan: entry.planHash ? { version: 1, ...(entry.start !== undefined ? { start: clone(entry.start) } : {}),
        steps: clone(entry.steps), planHash: entry.planHash } : null,
    };
  }

  return {
    reserve,
    complete,
    fail,
    stop(sessionKey     , copyId        , notify = true) {
      const entry = sessions.get(session(sessionKey));
      if (!entry || entry.copyId !== copyId) return refused("drive_copy_not_found");
      if (!notify && entry.timer !== null) clearTimer(entry.timer);
      if (!notify) {
        entry.timer = null;
        sessions.delete(entry.sessionKey);
        return { ok: true, drive: true, free: true, payload: { drive: true, copyId, stop: true,
          ...(entry.cardId ? { cardId: entry.cardId } : {}) }, copyId, reason: "stop", calls: entry.calls,
          pictures: entry.pictures, clockMs: entry.clockMs, replayPlan: entry.planHash ? { version: 1,
            ...(entry.start !== undefined ? { start: clone(entry.start) } : {}), steps: clone(entry.steps), planHash: entry.planHash } : null };
      }
      return reserve(sessionKey, { copyId, stop: true, ...(entry.cardId ? { cardId: entry.cardId } : {}) }, true);
    },
    endTurn: (sessionKey     ) => end(sessionKey, "turn_end"),
    edited: (sessionKey     ) => end(sessionKey, "edit"),
    disconnect: (sessionKey     ) => end(sessionKey, "disconnect"),
    snapshot,
    dispose() {
      for (const entry of [...sessions.values()]) closeEntry(entry, "disconnect");
    },
  };
}

module.exports = { PROGRAM_CARD_LOOK_DRIVE_CAPABILITY, PROGRAM_CARD_LOOK_DRIVE_TIMEOUT_MS, PROGRAM_CARD_LOOK_DRIVE_HOST_TIMEOUT_MS, PROGRAM_CARD_LOOK_DRIVE_IDLE_MS, PROGRAM_CARD_LOOK_DRIVE_MAX_CALLS, PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES, PROGRAM_CARD_LOOK_DRIVE_MAX_PICTURES_PER_CALL, PROGRAM_CARD_LOOK_DRIVE_GUIDE, programCardLookDriveParameterProperties, isProgramCardLookDriveInput, validateProgramCardLookDriveFields, validateProgramCardLookDriveResult, createProgramCardLookDriveController };
