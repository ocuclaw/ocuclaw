function cleanText(value         ) {
  return typeof value === "string" ? value : "";
}

function capTitle(value         ) {
  return cleanText(value).slice(0, 64);
}

function cardPlanOf(value     ) {
  if (!value || typeof value !== "object" || !Array.isArray(value.lines)) return null;
  const lines = value.lines
    .filter((item     ) => item && cleanText(item.line))
    .slice(0, 5)
    .map((item     ) => ({
      line: cleanText(item.line),
      ...(item.band === "top" || item.band === "middle" || item.band === "bottom" ? { band: item.band } : {}),
    }));
  if (lines.length === 0) return null;

  const choices = Array.isArray(value.choices)
    ? value.choices.filter((item     ) => item && cleanText(item.label)).slice(0, 3).map((item     ) => ({ label: cleanText(item.label) }))
    : [];

  const sites = Array.isArray(value.sites)
    ? value.sites.filter((host     ) => typeof host === "string" && /^[a-z0-9.-]{1,40}$/.test(host)).slice(0, 3)
    : [];
  return {
    name: cleanText(value.name) || null,
    lines,
    ...(cleanText(value.uses) ? { uses: cleanText(value.uses) } : {}),

    ...(value.change === true ? { change: true } : {}),

    ...(typeof value.icon === "string" && /^[a-z0-9-]{1,32}$/.test(value.icon) ? { icon: value.icon } : {}),

    ...(cleanText(value.fix) ? { fix: cleanText(value.fix) } : {}),
    ...(choices.length >= 2 ? { choices } : {}),
    ...(sites.length ? { sites } : {}),
  };
}

function buildDemandFrame(params     ) {
  if (!params || typeof params !== "object") return null;
  const options = Array.isArray(params.options)
    ? params.options
        .filter((option     ) => option && cleanText(option.label))
        .map((option     ) => ({
          label: cleanText(option.label),
          detail: cleanText(option.detail) || null,
        }))
    : [];
  const selectionMode =
    params.selectionMode === "multi" || params.selectionMode === "open"
      ? params.selectionMode
      : "single";
  const cardPlan = cardPlanOf(params.cardPlan);
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

    ...(params.botScreen === true ? { botScreen: true } : {}),

    ...(cardPlan ? { cardPlan } : {}),
  };
  if (!frame.surfaceId || !frame.question) return null;
  if (frame.options.length === 0 && frame.selectionMode !== "open") return null;
  return frame;
}

module.exports = { buildDemandFrame };
