const { buildDemandSurface, frameQuestionTexts, parseSessionKey, QUESTION_DEADLINE_SEC, PERMISSION_DEADLINE_SEC } = require("./demand-surface.cjs");

const UNANSWERED = "skip";

const DENIED = "deny";

const COMMIT_HORIZON_MS = 5_000;

const RESOLUTION_TYPES = [
  "permission_result",
  "question_answer",
  "result",
  "error",
  "aborted",
];

function isResolution(frame) {
  const type = frame && typeof frame.type === "string" ? frame.type : "";
  if (RESOLUTION_TYPES.indexOf(type) !== -1) return true;

  if (type === "status") {
    const state = (frame && (frame.status || frame.state)) || "";
    return state === "idle";
  }
  return false;
}

function createDemandRouter(deps) {
  const opts = deps || {};
  const inject = typeof opts.inject === "function" ? opts.inject : () => {};
  const dismiss = typeof opts.dismiss === "function" ? opts.dismiss : () => {};
  const respondPermission =
    typeof opts.respondPermission === "function" ? opts.respondPermission : null;
  const respondQuestion =
    typeof opts.respondQuestion === "function" ? opts.respondQuestion : null;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const onError = typeof opts.onError === "function" ? opts.onError : () => {};
  const onFlush = typeof opts.onFlush === "function" ? opts.onFlush : () => {};
  const schedule = typeof opts.schedule === "function" ? opts.schedule : setTimeout;
  const cancelScheduled =
    typeof opts.cancelScheduled === "function" ? opts.cancelScheduled : clearTimeout;

  const bySession = new Map();

  const bySurface = new Map();

  const owedBySession = new Map();

  function owedFor(sessionKey) {
    let owed = owedBySession.get(sessionKey);
    if (!owed) {
      owed = { question: [], permission: [] };
      owedBySession.set(sessionKey, owed);
    }
    return owed;
  }

  function oweResponse(sessionKey, frame, kind) {
    const { provider, sessionId } = parseSessionKey(sessionKey);
    const deadlineSec = kind === "permission" ? PERMISSION_DEADLINE_SEC : QUESTION_DEADLINE_SEC;
    const record = {
      kind,
      provider,
      sessionId,
      questionTexts: kind === "question" ? frameQuestionTexts(frame) : [],
      expiresAt: now() + deadlineSec * 1000,
    };
    owedFor(sessionKey)[kind].push(record);
    return record;
  }

  function pruneOwed(queue, at) {
    while (queue.length > 0 && at >= queue[0].expiresAt + COMMIT_HORIZON_MS) queue.shift();
  }

  function sendNoDecision(record, sessionKey) {
    try {
      if (record.kind === "question") {
        const map = {};
        for (const text of record.questionTexts) map[text] = UNANSWERED;
        if (respondQuestion) respondQuestion(record.provider, record.sessionId, JSON.stringify(map));
      } else if (respondPermission) {
        respondPermission(record.provider, record.sessionId, DENIED);
      }
    } catch (err) {
      onError({ reason: "drain_failed", sessionKey, kind: record.kind, error: err });
      return false;
    }
    onError({ reason: "queue_drained", sessionKey, kind: record.kind });
    return true;
  }

  function claimSlot(entry, at) {
    const kind = entry.meta.kind === "permission" ? "permission" : "question";
    const queue = owedFor(entry.sessionKey)[kind];
    pruneOwed(queue, at);
    const record = entry.owed;
    if (!record || queue.indexOf(record) === -1) {

      onError({ reason: "queue_slot_gone", sessionKey: entry.sessionKey, kind });
      return false;
    }
    while (queue[0] !== record) {
      const head = queue[0];

      if (at > head.expiresAt - COMMIT_HORIZON_MS) {
        onError({ reason: "queue_ambiguous", sessionKey: entry.sessionKey, kind });
        return false;
      }
      queue.shift();
      if (!sendNoDecision(head, entry.sessionKey)) return false;
    }
    queue.shift();
    return true;
  }

  function clearOwed(sessionKey) {
    const owed = owedBySession.get(sessionKey);
    if (!owed) return;
    owed.question.length = 0;
    owed.permission.length = 0;
  }

  function forget(entry) {
    if (!entry) return;
    for (const id of entry.surfaceIds) bySurface.delete(id);
    if (bySession.get(entry.sessionKey) === entry) bySession.delete(entry.sessionKey);
    if (entry.timer) {
      cancelScheduled(entry.timer);
      entry.timer = null;
    }
  }

  function deliverExternalDecision(entry, choice, reason) {
    if (!entry || entry.producer !== "external" || typeof entry.onDecision !== "function") {
      return;
    }
    Promise.resolve(entry.onDecision({ choice, reason })).catch((error) => {
      onError({
        reason: "external_decision_failed",
        surfaceId: entry.surfaceId,
        sessionKey: entry.sessionKey,
        error,
      });
    });
  }

  function retireEntry(
    entry,
    reason,
    notify,
    cancelExternal = true,
  ) {
    if (!entry || entry.locked) return false;
    entry.locked = true;
    forget(entry);
    if (notify) dismiss({ surfaceId: entry.surfaceId, sessionKey: entry.sessionKey, reason });
    if (cancelExternal) deliverExternalDecision(entry, "cancel", reason);
    return true;
  }

  function retireProducerConflicts(incomingProducer, sessionKey) {
    for (const entry of Array.from(bySession.values())) {
      if (
        incomingProducer === "external" ||
        entry.producer === "external" ||
        entry.sessionKey === sessionKey
      ) {

        retireEntry(entry, "superseded", false, true);
      }
    }
  }

  function presentDecision(params = {}) {
    const surface = params && params.surface;
    const surfaceId = surface && typeof surface.surfaceId === "string" ? surface.surfaceId : "";
    const sessionKey = surface && typeof surface.sessionKey === "string" ? surface.sessionKey : "";
    const options = surface && Array.isArray(surface.options) ? surface.options : [];
    if (!surfaceId || !sessionKey || !surface.question || options.length === 0) return false;

    retireProducerConflicts("external", sessionKey);
    const expiresAtMs = Number(params.expiresAtMs);
    const entry = {
      producer: "external",
      surfaceId,
      surfaceIds: [surfaceId],
      sessionKey,
      options,
      locked: false,
      timer: null,
      onDecision: typeof params.onDecision === "function" ? params.onDecision : null,
    };
    bySession.set(sessionKey, entry);
    bySurface.set(surfaceId, entry);
    if (Number.isFinite(expiresAtMs)) {
      const ttlMs = Math.max(1, expiresAtMs - now());
      entry.timer = schedule(() => {
        retireEntry(entry, "timeout", true, true);
      }, ttlMs);
    }
    inject({
      ...surface,
      payload: surface,
      meta: {
        kind: surface.kind || "permission",
        sessionKey,
        stepIndex: 0,
        stepCount: 0,
      },
      options,
    });
    return true;
  }

  function stepDeadlineSec(entry) {
    return Math.ceil((entry.expiresAt - COMMIT_HORIZON_MS - now()) / 1000);
  }

  function injectStep(entry, questionIndex) {
    const deadlineSec = stepDeadlineSec(entry);
    if (deadlineSec <= 0) return false;
    const surface = buildDemandSurface(entry.seq.ev, { questionIndex, deadlineSec });
    if (!surface) return false;
    entry.surfaceId = surface.surfaceId;
    entry.options = surface.options;
    entry.meta = surface.meta;
    entry.surfaceIds.push(surface.surfaceId);
    bySurface.set(surface.surfaceId, entry);
    inject(surface);
    return true;
  }

  function flushSequence(entry, reason) {
    if (!entry || entry.locked || !entry.seq) return false;
    const texts = entry.seq.questionTexts;
    if (texts.length === 0) {
      forget(entry);
      return false;
    }

    if (entry.expiresAt && now() >= entry.expiresAt) {
      forget(entry);
      onError({ reason: "deadline_passed", surfaceId: entry.surfaceId, flushReason: reason });
      return false;
    }

    const answers = {};
    let answered = 0;
    for (const text of texts) {
      const given = entry.seq.answers[text];
      if (given !== undefined) answered += 1;
      answers[text] = given === undefined ? UNANSWERED : given;
    }

    if (!claimSlot(entry, now())) {
      entry.locked = true;
      forget(entry);
      return false;
    }

    entry.locked = true;
    forget(entry);
    const { provider, sessionId } = entry.meta;
    try {
      if (respondQuestion) respondQuestion(provider, sessionId, JSON.stringify(answers));
    } catch (err) {
      onError({ reason: "respond_failed", surfaceId: entry.surfaceId, error: err });
      return false;
    }
    onFlush({ reason, answered, total: texts.length, sessionKey: entry.sessionKey });
    return true;
  }

  function retire(sessionKey, reason, notify) {
    const entry = bySession.get(sessionKey);
    if (!entry) return null;
    retireEntry(entry, reason, notify, true);
    return entry;
  }

  function handleClassified(ev) {
    const sessionKey = ev && typeof ev.sessionKey === "string" ? ev.sessionKey : "";
    if (!sessionKey) return null;
    const frame = ev && ev.frame;

    const surface = buildDemandSurface(ev, null);
    if (surface) {

      retireProducerConflicts("even-terminal", sessionKey);
      const deadlineMs = Number(surface.payload.deadlineSec) * 1000;

      const answerable = surface.meta.answerableIndexes;
      const seq =
        surface.meta.kind === "question"
          ? {
              ev,
              questionTexts: surface.meta.questionTexts,

              answerable,
              cursor: answerable.indexOf(surface.meta.questionIndex),
              answers: {},
            }
          : null;
      const entry = {
        producer: "even-terminal",
        surfaceId: surface.surfaceId,
        sessionKey,
        options: surface.options,
        meta: surface.meta,
        locked: false,

        expiresAt: Number.isFinite(deadlineMs) && deadlineMs > 0 ? now() + deadlineMs : 0,
        surfaceIds: [surface.surfaceId],
        seq,

        owed: oweResponse(sessionKey, frame, surface.meta.kind),
      };
      bySession.set(sessionKey, entry);
      bySurface.set(entry.surfaceId, entry);
      inject(surface);
      return surface;
    }

    if (isResolution(frame)) {
      const type = frame && typeof frame.type === "string" ? frame.type : "";

      if (type !== "permission_result" && type !== "question_answer") clearOwed(sessionKey);
      retire(sessionKey, "resolved", true);
      return null;
    }

    const frameType = frame && typeof frame.type === "string" ? frame.type : "";
    if (frameType === "permission_request" || frameType === "user_question") {

      oweResponse(sessionKey, frame, frameType === "permission_request" ? "permission" : "question");
      onError({
        reason: "demand_unrenderable",
        sessionKey,
        frameType,
        questionCount: Array.isArray(frame.questions) ? frame.questions.length : 0,
      });
    }
    return null;
  }

  function handleOutcome(result) {
    const surfaceId = result && typeof result.surfaceId === "string" ? result.surfaceId : "";
    const entry = surfaceId ? bySurface.get(surfaceId) : null;

    if (!entry || entry.locked) return false;

    if (entry.producer === "external") {
      if (result.result === "dismissed") {
        retireEntry(entry, "dismissed", false, true);
        return true;
      }
      if (result.result !== "selected" || surfaceId !== entry.surfaceId) return false;
      const index = Number(result.selectedIndex);
      if (!Number.isInteger(index) || index < 0 || index >= entry.options.length) {
        onError({ reason: "index_out_of_range", surfaceId, index });
        return false;
      }
      const choice = entry.options[index] && entry.options[index].key;
      if (typeof choice !== "string" || !choice) return false;
      entry.locked = true;
      forget(entry);
      deliverExternalDecision(entry, choice, "selected");
      return true;
    }

    if (result.result === "dismissed") {

      forget(entry);
      return false;
    }
    if (result.result !== "selected") return false;

    if (surfaceId !== entry.surfaceId) return false;

    if (entry.expiresAt && now() >= entry.expiresAt) {
      forget(entry);
      return false;
    }

    const index = Number(result.selectedIndex);
    if (!Number.isInteger(index) || index < 0 || index >= entry.options.length) {
      onError({ reason: "index_out_of_range", surfaceId, index });
      return false;
    }
    const option = entry.options[index];

    if (!entry.seq) {
      const value = typeof option.key === "string" && option.key ? option.key : null;
      if (value === null) {
        onError({ reason: "unanswerable_option", surfaceId, index });
        return false;
      }

      if (!claimSlot(entry, now())) {
        entry.locked = true;
        forget(entry);
        return false;
      }

      entry.locked = true;
      forget(entry);
      const { provider, sessionId } = entry.meta;
      try {
        if (respondPermission) respondPermission(provider, sessionId, value);
      } catch (err) {
        onError({ reason: "respond_failed", surfaceId, error: err });
        return false;
      }
      return true;
    }

    const label = typeof option.label === "string" ? option.label : "";
    if (!label) {
      onError({ reason: "unanswerable_option", surfaceId, index });
      return false;
    }

    entry.seq.answers[entry.meta.questionText] = label;
    entry.seq.cursor += 1;
    const nextIndex = entry.seq.answerable[entry.seq.cursor];
    if (nextIndex !== undefined) {

      if (injectStep(entry, nextIndex)) return true;
      forget(entry);
      onError({ reason: "sequence_unfinishable", surfaceId, remaining: entry.seq.answerable.length - entry.seq.cursor });
      return false;
    }

    return flushSequence(entry, "completed");
  }

  function forgetSession(sessionKey) {

    owedBySession.delete(sessionKey);
    retire(sessionKey, "session_gone", true);
  }

  function forgetAll(reason) {
    for (const sessionKey of Array.from(bySession.keys())) {
      retire(sessionKey, reason || "display_changed", true);
    }
  }

  function forgetExternal(reason) {
    for (const entry of Array.from(bySession.values())) {
      if (entry.producer === "external") {
        retireEntry(entry, reason || "display_changed", true, true);
      }
    }
  }

  function activeSurfaceId(sessionKey) {
    const entry = bySession.get(sessionKey);
    return entry ? entry.surfaceId : "";
  }

  return {
    handleClassified,
    handleOutcome,
    presentDecision,
    forgetSession,
    forgetAll,
    forgetExternal,
    activeSurfaceId,
  };
}

module.exports = { createDemandRouter };
