function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueIndices(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item, index, all) => Number.isInteger(item) && all.indexOf(item) === index);
}

function createOpenClawQuestionRouter(deps = {}) {
  const inject = typeof deps.inject === "function" ? deps.inject : () => {};
  const dismiss = typeof deps.dismiss === "function" ? deps.dismiss : () => {};
  const respond = typeof deps.respond === "function" ? deps.respond : null;
  const isCurrentSession =
    typeof deps.isCurrentSession === "function" ? deps.isCurrentSession : () => true;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const onError = typeof deps.onError === "function" ? deps.onError : () => {};

  const byRequest = new Map();
  const bySession = new Map();
  const bySurface = new Map();

  function forget(entry) {
    if (byRequest.get(entry.id) === entry) byRequest.delete(entry.id);
    if (bySession.get(entry.sessionKey) === entry) bySession.delete(entry.sessionKey);
    if (entry.surfaceId && bySurface.get(entry.surfaceId) === entry) {
      bySurface.delete(entry.surfaceId);
    }
  }

  function retire(entry, reason) {
    const surfaceId = entry.surfaceId;
    forget(entry);
    if (surfaceId) dismiss({ surfaceId, sessionKey: entry.sessionKey, reason });
  }

  function normalizeQuestion(raw) {
    const options = Array.isArray(raw && raw.options)
      ? raw.options
          .map((option) => ({
            label: cleanText(option && option.label),
            detail: cleanText(option && option.description) || null,
          }))
          .filter((option) => option.label)
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
    };
  }

  function remainingSeconds(entry) {
    return Math.max(0, Math.ceil((entry.expiresAtMs - now()) / 1000));
  }

  function injectStep(entry, index) {
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
      options: question.options,
    });
    return true;
  }

  function flush(entry) {
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

  function advance(entry, values) {
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

  function handleRequest(raw) {
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
    if (previous) retire(previous, previous.id === id ? "refreshed" : "superseded");

    const entry = {
      id,
      sessionKey,
      questions,
      answers: {},
      expiresAtMs,
      index: 0,
      surfaceId: "",
      awaitingText: false,
      locked: false,
    };
    byRequest.set(id, entry);
    bySession.set(sessionKey, entry);
    return injectStep(entry, 0);
  }

  function handleOutcome(raw) {
    const surfaceId = cleanText(raw && raw.surfaceId);
    const entry = surfaceId ? bySurface.get(surfaceId) : null;
    if (!entry || entry.locked) return false;
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

  function handleText(sessionKeyValue, textValue) {
    const sessionKey = cleanText(sessionKeyValue);
    const text = cleanText(textValue);
    const entry = bySession.get(sessionKey) || Array.from(bySession.values()).find(
      (candidate) => isCurrentSession(candidate.sessionKey) && isCurrentSession(sessionKey),
    );
    if (!entry || !entry.awaitingText || entry.locked || !text) return false;
    if (remainingSeconds(entry) <= 0) {
      forget(entry);
      return false;
    }
    entry.awaitingText = false;
    return advance(entry, [text]);
  }

  function handleResolved(raw) {
    const id = cleanText(raw && raw.id);
    const entry = id ? byRequest.get(id) : null;
    if (!entry) return false;
    retire(entry, cleanText(raw && raw.status) || "resolved");
    return true;
  }

  function forgetAll(reason = "display_changed") {
    for (const entry of Array.from(bySession.values())) retire(entry, reason);
  }

  function activeSurfaceId(sessionKey) {
    const cleaned = cleanText(sessionKey);
    const entry = bySession.get(cleaned) || Array.from(bySession.values()).find(
      (candidate) => isCurrentSession(candidate.sessionKey) && isCurrentSession(cleaned),
    );
    return entry?.surfaceId || "";
  }

  return { handleRequest, handleOutcome, handleText, handleResolved, forgetAll, activeSurfaceId };
}

module.exports = { createOpenClawQuestionRouter };
