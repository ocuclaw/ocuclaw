const { displayOptionLabel } = require("../domain/question-option-label.cjs");

function cleanText(value         ) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueIndices(value         ) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item, index, all) => Number.isInteger(item) && all.indexOf(item) === index);
}

function createOpenClawQuestionRouter(deps      = {}) {
  const inject = typeof deps.inject === "function" ? deps.inject : () => {};
  const dismiss = typeof deps.dismiss === "function" ? deps.dismiss : () => {};
  const respond = typeof deps.respond === "function" ? deps.respond : null;
  const isCurrentSession =
    typeof deps.isCurrentSession === "function" ? deps.isCurrentSession : () => true;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const onError = typeof deps.onError === "function" ? deps.onError : () => {};
  const canPresentSecret =
    typeof deps.canPresentSecret === "function" ? deps.canPresentSecret : () => false;
  const presentSecret = typeof deps.presentSecret === "function" ? deps.presentSecret : () => {};
  const clearSecret = typeof deps.clearSecret === "function" ? deps.clearSecret : () => {};
  const resolveSecret = typeof deps.resolveSecret === "function" ? deps.resolveSecret : null;

  const byRequest = new Map();
  const bySession = new Map();
  const bySurface = new Map();

  function forget(entry     ) {
    if (byRequest.get(entry.id) === entry) byRequest.delete(entry.id);
    if (bySession.get(entry.sessionKey) === entry) bySession.delete(entry.sessionKey);
    if (entry.surfaceId && bySurface.get(entry.surfaceId) === entry) {
      bySurface.delete(entry.surfaceId);
    }
  }

  function retire(entry     , reason     , outcome = "cancelled") {
    const surfaceId = entry.surfaceId;
    forget(entry);
    if (surfaceId) dismiss({ surfaceId, sessionKey: entry.sessionKey, reason });
    if (entry.secret && entry.secret.offered) clearSecret({ id: entry.id, outcome });
  }

  function normalizeQuestion(raw     ) {
    const options = Array.isArray(raw && raw.options)
      ? raw.options
          .map((option     ) => ({
            label: cleanText(option && option.label),
            detail: cleanText(option && option.description) || null,
          }))
          .filter((option     ) => option.label)
          .slice(0, 8)
      : [];
    const questionId = cleanText(raw && (raw.questionId || raw.id));
    const question = cleanText(raw && raw.question);
    if (!questionId || !question) return null;
    return {
      questionId,
      header: cleanText(raw && raw.header),
      question,
      options,
      selectionMode: raw && raw.multiSelect === true ? "multi" : options.length ? "single" : "open",
      allowOther: raw && raw.isOther === true && options.length > 0,
      isSecret: !!(raw && (raw.isSecret === true || (raw.secretStore && typeof raw.secretStore === "object"))),
      secretStore: normalizeSecretStore(raw && raw.secretStore, raw && raw.secretStoreExisting),
    };
  }

  function normalizeSecretStore(raw     , existing     ) {
    if (!raw || typeof raw !== "object") return null;
    const name = cleanText(raw.name);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) return null;
    const allowedHosts = Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.map(cleanText).filter((host     ) => host && host.length <= 253).slice(0, 128)
      : [];
    const updatedAtMs = Number(existing && existing.updatedAtMs);
    return {
      name,
      kind: raw.kind === "env" ? "env" : "secret",
      allowedHosts,
      reason: cleanText(raw.reason).slice(0, 200) || null,
      existing: Number.isInteger(updatedAtMs) && updatedAtMs >= 0
        ? { updatedAtMs, updatedBy: cleanText(existing.updatedBy) || null }
        : null,
    };
  }

  function remainingSeconds(entry     ) {
    return Math.max(0, Math.ceil((entry.expiresAtMs - now()) / 1000));
  }

  function injectStep(entry     , index     ) {
    const question = entry.questions[index];
    const deadlineSec = remainingSeconds(entry);
    if (!question || deadlineSec <= 0) return false;
    if (entry.surfaceId && bySurface.get(entry.surfaceId) === entry) {
      bySurface.delete(entry.surfaceId);
    }
    entry.index = index;
    entry.awaitingText = false;
    entry.surfaceId = `openclaw-question:${entry.id}#q${index}`;
    bySurface.set(entry.surfaceId, entry);
    inject({
      surfaceId: entry.surfaceId,
      sessionKey: entry.sessionKey,
      kind: "question",
      title: "OpenClaw",
      question: question.question,
      deadlineSec,
      questionIndex: index,
      questionCount: entry.questions.length,
      presentation: "adaptive",
      selectionMode: question.selectionMode,
      allowOther: question.allowOther,

      options: question.options.map((option     ) => ({ ...option, label: displayOptionLabel(option.label) })),
    });
    return true;
  }

  function injectSecretStep(entry     ) {
    const deadlineSec = remainingSeconds(entry);
    if (deadlineSec <= 0) return false;
    if (entry.surfaceId && bySurface.get(entry.surfaceId) === entry) {
      bySurface.delete(entry.surfaceId);
    }
    const name = entry.secret.name || "the secret";
    entry.surfaceId = `openclaw-question:${entry.id}#secret`;
    bySurface.set(entry.surfaceId, entry);
    inject({
      surfaceId: entry.surfaceId,
      sessionKey: entry.sessionKey,
      kind: "question",
      title: "OpenClaw · API key",
      question: entry.secret.offered
        ? `Enter ${name} on your phone.`
        : `Enter ${name} in OpenClaw's Control UI. It can't be entered here.`,
      deadlineSec,
      questionIndex: 0,
      questionCount: 1,
      presentation: "adaptive",
      selectionMode: "single",
      allowOther: false,
      options: [{ label: "Skip", detail: null }],
    });
    return true;
  }

  function secretRequestFrame(entry     ) {
    const question = entry.questions[0];
    const store = entry.secret.store;
    return {
      id: entry.id,
      sessionKey: entry.sessionKey,
      agentName: entry.agentName,
      name: store.name,
      prompt: question.question,
      header: question.header || null,
      reason: store.reason,
      allowedHosts: store.allowedHosts.slice(),
      existing: store.existing ? { ...store.existing } : null,
      expiresAtMs: entry.expiresAtMs,
    };
  }

  function flush(entry     ) {
    if (entry.locked) return false;
    entry.locked = true;
    forget(entry);
    if (!respond) {
      onError({ reason: "question_responder_unavailable", id: entry.id });
      return false;
    }
    try {
      Promise.resolve(respond(entry.id, { answers: entry.answers })).catch((error) => {
        onError({ reason: "question_respond_failed", id: entry.id, error });
      });
    } catch (error) {
      onError({ reason: "question_respond_failed", id: entry.id, error });
      return false;
    }
    return true;
  }

  function advance(entry     , values     ) {
    const question = entry.questions[entry.index];
    if (!question) return false;
    entry.answers[question.questionId] = values;
    const nextIndex = entry.index + 1;
    if (nextIndex < entry.questions.length) {
      if (injectStep(entry, nextIndex)) return true;
      forget(entry);
      onError({ reason: "question_sequence_expired", id: entry.id });
      return false;
    }
    return flush(entry);
  }

  function handleRequest(raw     ) {
    const id = cleanText(raw && raw.id);
    const sessionKey = cleanText(raw && raw.sessionKey);
    const questions = Array.isArray(raw && raw.questions)
      ? raw.questions.map(normalizeQuestion).filter(Boolean).slice(0, 3)
      : [];
    const expiresAtMs = Number(raw && raw.expiresAtMs);
    if (!id || !sessionKey || questions.length === 0 || !Number.isFinite(expiresAtMs)) {
      onError({ reason: "question_unrenderable", id, sessionKey });
      return false;
    }
    if (!isCurrentSession(sessionKey)) {
      onError({ reason: "question_background_session", id, sessionKey });
      return false;
    }
    if (expiresAtMs <= now()) {
      onError({ reason: "question_expired", id, sessionKey });
      return false;
    }

    const previous = bySession.get(sessionKey);
    if (previous) {

      const refresh = previous.id === id;
      if (refresh && previous.secret) previous.secret.offered = false;
      retire(previous, refresh ? "refreshed" : "superseded");
    }

    const secretQuestion = questions.find((question     ) => question.isSecret);
    const entry      = {
      id,
      sessionKey,
      agentName: cleanText(raw && raw.agentId) || null,
      questions,
      answers: {},
      expiresAtMs,
      index: 0,
      surfaceId: "",
      awaitingText: false,
      locked: false,
      secret: null,
    };
    byRequest.set(id, entry);
    bySession.set(sessionKey, entry);
    if (secretQuestion) {
      const store = questions.length === 1 ? secretQuestion.secretStore : null;
      entry.secret = {
        store,
        name: store ? store.name : "",
        offered: !!(store && canPresentSecret()),
      };
      if (entry.secret.offered) presentSecret(secretRequestFrame(entry));
      return injectSecretStep(entry);
    }
    return injectStep(entry, 0);
  }

  function handleOutcome(raw     ) {
    const surfaceId = cleanText(raw && raw.surfaceId);
    const entry = surfaceId ? bySurface.get(surfaceId) : null;
    if (!entry || entry.locked) return false;
    if (entry.secret) return handleSecretOutcome(entry, surfaceId, raw);
    if (raw && raw.result === "dismissed") {
      forget(entry);
      return true;
    }
    if (!raw || (raw.result !== "selected" && raw.result !== "await_text")) return false;
    if (remainingSeconds(entry) <= 0) {
      forget(entry);
      return false;
    }

    const question = entry.questions[entry.index];
    if (raw.result === "await_text") {
      if (question.selectionMode !== "open" && !question.allowOther) return false;
      bySurface.delete(surfaceId);
      entry.surfaceId = "";
      entry.awaitingText = true;
      return true;
    }

    if (question.selectionMode === "multi") {
      const indices = uniqueIndices(raw.selectedIndices);
      if (
        indices.length === 0 ||
        indices.some((index) => index < 0 || index >= question.options.length)
      ) {
        onError({ reason: "question_indices_out_of_range", surfaceId });
        return false;
      }
      return advance(entry, indices.map((index) => question.options[index].label));
    }

    const index = Number(raw.selectedIndex);
    if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
      onError({ reason: "question_index_out_of_range", surfaceId });
      return false;
    }
    return advance(entry, [question.options[index].label]);
  }

  function handleText(sessionKeyValue     , textValue     ) {
    const sessionKey = cleanText(sessionKeyValue);
    const text = cleanText(textValue);
    const entry = bySession.get(sessionKey) || Array.from(bySession.values()).find(
      (candidate     ) => isCurrentSession(candidate.sessionKey) && isCurrentSession(sessionKey),
    );
    if (!entry || entry.secret || !entry.awaitingText || entry.locked || !text) return false;
    if (remainingSeconds(entry) <= 0) {
      forget(entry);
      return false;
    }
    entry.awaitingText = false;
    return advance(entry, [text]);
  }

  function handleResolved(raw     ) {
    const id = cleanText(raw && raw.id);
    const entry = id ? byRequest.get(id) : null;
    if (!entry) return false;
    const status = cleanText(raw && raw.status) || "resolved";
    retire(
      entry,
      status,
      status === "answered" ? "provided" : status === "expired" ? "timeout" : "cancelled",
    );
    return true;
  }

  function forgetAll(reason = "display_changed") {
    for (const entry of Array.from(bySession.values())) {

      if (entry.secret && entry.secret.offered && !entry.locked && remainingSeconds(entry) > 0) {
        const surfaceId = entry.surfaceId;
        if (surfaceId && bySurface.get(surfaceId) === entry) bySurface.delete(surfaceId);
        entry.surfaceId = "";
        if (surfaceId) dismiss({ surfaceId, sessionKey: entry.sessionKey, reason });
        continue;
      }
      retire(entry, reason);
    }
  }

  function handleSecretOutcome(entry     , surfaceId     , raw     ) {
    if (raw && raw.result === "dismissed") {

      bySurface.delete(surfaceId);
      entry.surfaceId = "";
      if (!entry.secret.offered) forget(entry);
      return true;
    }
    if (!raw || raw.result !== "selected" || raw.selectedIndex !== 0) return false;
    settleSecret(entry, { cancel: true }).then((result     ) => {
      if (result.status === "failed") onError({ reason: "secret_skip_failed", id: entry.id });
    });
    return true;
  }

  async function settleSecret(entry     , params     ) {
    if (!resolveSecret) return { status: "failed", reason: "unavailable" };
    entry.locked = true;
    try {
      await resolveSecret(entry.id, params);
    } catch (error) {
      entry.locked = false;
      const message = error && (error       ).message ? String((error       ).message) : "";
      return { status: "failed", reason: message.slice(0, 200) || "resolve_failed" };
    }
    retire(entry, "resolved", params.cancel ? "skipped" : "provided");
    return { status: params.cancel ? "skipped" : "stored", reason: null };
  }

  async function handleSecretAnswer(answer     ) {
    const id = cleanText(answer && answer.id);
    const entry = id ? byRequest.get(id) : null;
    if (!entry || !entry.secret) return { status: "refused", reason: "unknown_request" };
    if (entry.locked) return { status: "already_answered", reason: null };
    if (!entry.secret.offered) return { status: "refused", reason: "not_offered" };
    if (remainingSeconds(entry) <= 0) {
      retire(entry, "expired", "timeout");
      return { status: "refused", reason: "expired" };
    }
    if (answer.skip === true) return settleSecret(entry, { cancel: true });
    const value = typeof answer.value === "string" ? answer.value.trim() : "";
    if (!value || value.length > 16384) return { status: "refused", reason: "invalid_value" };
    const params      = {
      answers: { answers: { [entry.questions[0].questionId]: [value] } },
    };
    if (Array.isArray(answer.allowedHosts)) {
      const hosts = answer.allowedHosts.map(cleanText).filter((host     ) => host && host.length <= 253);
      params.secretStoreAllowedHosts = Array.from(new Set(hosts)).slice(0, 128);
    }
    return settleSecret(entry, params);
  }

  function openSecretRequests() {
    const frames = [];
    for (const entry of byRequest.values()) {
      if (entry.secret && !entry.locked && remainingSeconds(entry) > 0 && entry.secret.store) {
        frames.push(secretRequestFrame(entry));
      }
    }
    return frames;
  }

  function secretClientReady() {
    for (const entry of byRequest.values()) {
      if (!entry.secret || entry.locked || !entry.secret.store || remainingSeconds(entry) <= 0) continue;
      if (!entry.secret.offered) {
        entry.secret.offered = true;
        injectSecretStep(entry);
      }
    }
    return openSecretRequests();
  }

  function activeSurfaceId(sessionKey     ) {
    const cleaned = cleanText(sessionKey);
    const entry = bySession.get(cleaned) || Array.from(bySession.values()).find(
      (candidate     ) => isCurrentSession(candidate.sessionKey) && isCurrentSession(cleaned),
    );
    return entry?.surfaceId || "";
  }

  return {
    handleRequest,
    handleOutcome,
    handleText,
    handleResolved,
    forgetAll,
    activeSurfaceId,
    handleSecretAnswer,
    openSecretRequests,
    secretClientReady,
  };
}

module.exports = { createOpenClawQuestionRouter };
