function cleanText(value) {
  return typeof value === "string" ? value : "";
}

function capTitle(value) {
  return cleanText(value).slice(0, 64);
}

function buildDemandFrame(params) {
  if (!params || typeof params !== "object") return null;
  const options = Array.isArray(params.options)
    ? params.options
        .filter((option) => option && cleanText(option.label))
        .map((option) => ({
          label: cleanText(option.label),
          detail: cleanText(option.detail) || null,
        }))
    : [];
  const selectionMode =
    params.selectionMode === "multi" || params.selectionMode === "open"
      ? params.selectionMode
      : "single";
  const frame = {
    type: "demand",
    surfaceId: cleanText(params.surfaceId),
    sessionKey: cleanText(params.sessionKey) || null,
    kind: params.kind === "permission" ? "permission" : "question",
    title: capTitle(params.title),
    question: cleanText(params.question),
    deadlineSec:
      Number.isFinite(params.deadlineSec) && params.deadlineSec > 0
        ? Math.floor(params.deadlineSec)
        : 60,
    questionIndex: Number.isInteger(params.questionIndex) ? params.questionIndex : 0,
    questionCount: Number.isInteger(params.questionCount) ? params.questionCount : 0,
    presentation: params.presentation === "adaptive" ? "adaptive" : "reel",
    selectionMode,
    allowOther: params.allowOther === true,
    options,
  };
  if (!frame.surfaceId || !frame.question) return null;
  if (frame.options.length === 0 && frame.selectionMode !== "open") return null;
  return frame;
}

module.exports = { buildDemandFrame };
