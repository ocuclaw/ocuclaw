function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveSeconds(value, fallback = 300) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function createHermesClarifyRouter(deps = {}) {
  const inject = typeof deps.inject === "function" ? deps.inject : () => {};
  const dismiss = typeof deps.dismiss === "function" ? deps.dismiss : () => {};
  const respond = typeof deps.respond === "function" ? deps.respond : null;
  const awaitText = typeof deps.awaitText === "function" ? deps.awaitText : null;
  const isCurrentSession =
    typeof deps.isCurrentSession === "function" ? deps.isCurrentSession : () => true;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const onError = typeof deps.onError === "function" ? deps.onError : () => {};

  const bySurface = new Map();
  const bySession = new Map();
  const suppressed = new Set();

  function forget(entry) {
    if (bySurface.get(entry.surfaceId) === entry) bySurface.delete(entry.surfaceId);
    if (bySession.get(entry.sessionKey) === entry) bySession.delete(entry.sessionKey);
  }

  function retire(entry, reason) {
    forget(entry);
    dismiss({ surfaceId: entry.surfaceId, sessionKey: entry.sessionKey, reason });
  }

  function handleRequest(raw) {
    const id = cleanText(raw && raw.id);
    const sessionKey = cleanText(raw && raw.sessionKey);
    const question = cleanText(raw && raw.question);
    const choices = Array.isArray(raw && raw.choices)
      ? raw.choices.map(cleanText).filter(Boolean).slice(0, 8)
      : [];
    const selectionMode = raw && raw.multiSelect === true
      ? "multi"
      : choices.length === 0
        ? "open"
        : "single";
    if (!id || !sessionKey || !question) {
      onError({ reason: "clarify_unrenderable", id, sessionKey });
      return false;
    }

    if (!isCurrentSession(sessionKey)) return true;
    const previous = bySession.get(sessionKey);
    if (previous && previous.id === id && previous.expiresAtMs > now()) return true;
    if (suppressed.has(id)) return true;
    suppressed.clear();
    if (previous) retire(previous, "superseded");

    const deadlineSec = positiveSeconds(raw && raw.deadlineSec);
    const entry = {
      id,
      surfaceId: `hermes-clarify:${id}`,
      sessionKey,
      question,
      options: choices.map((label) => ({ label, detail: null })),
      selectionMode,
      allowOther: raw && raw.allowOther === true && choices.length > 0,
      deadlineSec,
      expiresAtMs: Number.isFinite(raw.expiresAtMs)
        ? raw.expiresAtMs : now() + deadlineSec * 1000,
      locked: false,
    };
    if (entry.expiresAtMs <= now()) return false;
    bySurface.set(entry.surfaceId, entry);
    bySession.set(entry.sessionKey, entry);
    inject({
      surfaceId: entry.surfaceId,
      sessionKey: entry.sessionKey,
      kind: "question",
      title: "Hermes",
      question: entry.question,
      deadlineSec: Math.max(1, Math.ceil((entry.expiresAtMs - now()) / 1000)),
      questionIndex: 0,
      questionCount: 0,
      presentation: "adaptive",
      selectionMode: entry.selectionMode,
      allowOther: entry.allowOther,
      options: entry.options,
    });
    return true;
  }

  function handleOutcome(raw) {
    const surfaceId = cleanText(raw && raw.surfaceId);
    const entry = surfaceId ? bySurface.get(surfaceId) : null;
    if (!entry || entry.locked) return false;

    if (raw && raw.result === "dismissed") {

      forget(entry);
      suppressed.add(entry.id);
      return true;
    }
    if (!raw || (raw.result !== "selected" && raw.result !== "await_text")) return false;
    if (now() >= entry.expiresAtMs) {
      forget(entry);
      return false;
    }
    if (raw.result === "await_text") {
      if (entry.selectionMode !== "open" && !entry.allowOther) return false;
      entry.locked = true;
      forget(entry);
      suppressed.add(entry.id);
      if (!awaitText) {
        onError({ reason: "clarify_text_responder_unavailable", surfaceId });
        return false;
      }
      try {
        Promise.resolve(awaitText(entry.id)).catch((error) => {
          suppressed.delete(entry.id);
          onError({ reason: "clarify_await_text_failed", surfaceId, error });
        });
      } catch (error) {
        suppressed.delete(entry.id);
        onError({ reason: "clarify_await_text_failed", surfaceId, error });
        return false;
      }
      return true;
    }
    let response = "";
    if (entry.selectionMode === "multi") {
      const selectedIndices = Array.isArray(raw.selectedIndices) ? raw.selectedIndices : [];
      const unique = selectedIndices
        .map((value) => Number(value))
        .filter((value, index, all) => all.indexOf(value) === index);
      if (
        unique.length === 0 ||
        unique.some((index) =>
          !Number.isInteger(index) || index < 0 || index >= entry.options.length
        )
      ) {
        onError({ reason: "clarify_indices_out_of_range", surfaceId, selectedIndices });
        return false;
      }
      response = JSON.stringify(unique.map((index) => entry.options[index].label));
    } else {
      const selectedIndex = Number(raw.selectedIndex);
      if (
        !Number.isInteger(selectedIndex) ||
        selectedIndex < 0 ||
        selectedIndex >= entry.options.length
      ) {
        onError({ reason: "clarify_index_out_of_range", surfaceId, selectedIndex });
        return false;
      }
      response = entry.options[selectedIndex].label;
    }
    entry.locked = true;
    forget(entry);
    suppressed.add(entry.id);
    if (!respond) {
      onError({ reason: "clarify_responder_unavailable", surfaceId });
      return false;
    }
    try {
      Promise.resolve(respond(entry.id, response)).catch((error) => {
        suppressed.delete(entry.id);
        onError({ reason: "clarify_respond_failed", surfaceId, error });
      });
    } catch (error) {
      suppressed.delete(entry.id);
      onError({ reason: "clarify_respond_failed", surfaceId, error });
      return false;
    }
    return true;
  }

  function forgetAll(reason = "display_changed") {
    for (const entry of Array.from(bySession.values())) retire(entry, reason);
    suppressed.clear();
  }

  function reconcile(snapshot) {
    const sessionKey = cleanText(snapshot && snapshot.sessionKey);
    if (!sessionKey || !isCurrentSession(sessionKey)) return false;
    const request = snapshot.clarify;
    const previous = bySession.get(sessionKey);
    if (!request) {
      if (previous) retire(previous, "resolved");
      suppressed.clear();
      return true;
    }

    if (request.awaitingText && Array.isArray(request.choices) && request.choices.length > 0) {
      if (previous) retire(previous, "await_text");
      return true;
    }
    return handleRequest(request);
  }

  function activeSurfaceId(sessionKey) {
    return bySession.get(sessionKey)?.surfaceId || "";
  }

  return { handleRequest, handleOutcome, forgetAll, activeSurfaceId, reconcile };
}

module.exports = { createHermesClarifyRouter };
