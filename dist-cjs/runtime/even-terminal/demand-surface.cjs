const PERMISSION_DEADLINE_SEC = 60;
const QUESTION_DEADLINE_SEC = 120;

const TITLE_MAX_CHARS = 64;

function capTitle(value) {
  const text = typeof value === "string" ? value : "";
  return text.length <= TITLE_MAX_CHARS ? text : text.slice(0, TITLE_MAX_CHARS);
}

function parseSessionKey(sessionKey) {

  const raw = typeof sessionKey === "string" ? sessionKey : "";
  const parts = raw.split(":");
  if (parts.length < 3 || parts[0] !== "et") return { provider: "", sessionId: "" };
  return { provider: parts[1] || "", sessionId: parts.slice(2).join(":") };
}

function agentLabel(provider) {
  if (!provider) return "Agent";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function effectFor(key, toolName) {
  const tool = toolName || "this tool";
  if (key === "allow") return `Run ${tool} once`;
  if (key === "allowAlways") return `Always allow ${tool} this session`;
  if (key === "deny") return `Block ${tool}`;
  return "";
}

function cleanText(value) {
  return typeof value === "string" ? value : "";
}

function buildPermission(frame, agent) {
  const raw = Array.isArray(frame.options) ? frame.options : [];
  const options = raw.filter((o) => o && (cleanText(o.text) || cleanText(o.key)));
  if (options.length === 0) return null;
  const toolName = cleanText(frame.toolName);
  return {
    options,
    payload: {
      kind: "permission",
      title: `${agent} needs permission`,
      question:
        cleanText(frame.description) ||
        cleanText(frame.detail) ||
        `Permission requested for ${toolName || "this action"}`,
      deadlineSec: PERMISSION_DEADLINE_SEC,
      options: options.map((o) => ({
        label: cleanText(o.text) || cleanText(o.key),
        detail: effectFor(cleanText(o.key), toolName),
      })),
    },
    extraMeta: {
      questionText: "",
      questionIndex: 0,
      answerableIndexes: [],
      stepIndex: 0,
      stepCount: 0,
      questionTexts: [],
    },
  };
}

function questionEntries(frame) {
  const questions = Array.isArray(frame.questions) ? frame.questions : [];
  return questions.map((question, index) => {
    const raw = question && Array.isArray(question.options) ? question.options : [];
    return {
      index,
      text: cleanText(question && question.question) || cleanText(question && question.header),
      options: raw.filter((o) => o && cleanText(o.label)),
    };
  });
}

function isAnswerable(entry) {
  return Boolean(entry.text) && entry.options.length > 0;
}

function buildQuestion(frame, agent, questionIndex) {
  const entries = questionEntries(frame);
  const answerable = entries.filter(isAnswerable);
  const entry = questionIndex === null ? answerable[0] : entries[questionIndex];
  if (!entry || !isAnswerable(entry)) return null;
  return {
    options: entry.options,
    payload: {
      kind: "question",
      title: `${agent} asks`,

      question: entry.text,
      deadlineSec: QUESTION_DEADLINE_SEC,
      options: entry.options.map((o) => ({
        label: cleanText(o.label),
        detail: [cleanText(o.description), cleanText(o.preview)].filter(Boolean).join(" · "),
      })),
    },
    extraMeta: {
      questionText: entry.text,

      questionIndex: entry.index,

      answerableIndexes: answerable.map((e) => e.index),

      stepIndex: answerable.findIndex((e) => e.index === entry.index),
      stepCount: answerable.length,

      questionTexts: entries.map((e) => e.text),
    },
  };
}

function buildDemandFrame(surface) {
  if (!surface || !surface.payload || !surface.meta) return null;
  const payload = surface.payload;
  const options = Array.isArray(payload.options) ? payload.options : [];
  return {
    type: "demand",
    surfaceId: typeof surface.surfaceId === "string" ? surface.surfaceId : "",
    sessionKey:
      typeof surface.meta.sessionKey === "string" ? surface.meta.sessionKey : null,
    kind: payload.kind,
    title: capTitle(payload.title),
    question: payload.question,
    deadlineSec: payload.deadlineSec,
    options: options.map((option) => ({
      label: cleanText(option && option.label),
      detail: cleanText(option && option.detail) || null,
    })),

    questionIndex: Number(surface.meta.stepIndex) || 0,
    questionCount: Number(surface.meta.stepCount) || 0,
  };
}

function buildDemandSurface(ev, opts) {
  const frame = ev && ev.frame;
  if (!frame || typeof frame !== "object") return null;
  const type = cleanText(frame.type);
  const { provider, sessionId } = parseSessionKey(ev.sessionKey);
  const agent = agentLabel(provider);
  const questionIndex =
    opts && Number.isInteger(opts.questionIndex) ? Math.max(0, opts.questionIndex) : null;

  let built = null;
  if (type === "permission_request") built = buildPermission(frame, agent);
  else if (type === "user_question") built = buildQuestion(frame, agent, questionIndex);
  if (!built) return null;

  const deadlineOverride = Number(opts && opts.deadlineSec);
  if (Number.isFinite(deadlineOverride) && deadlineOverride > 0) {
    built.payload.deadlineSec = Math.max(1, Math.floor(deadlineOverride));
  }

  const toolUseId = cleanText(frame.toolUseId) || "pending";

  const stepSuffix = built.extraMeta.stepCount > 1 ? `#q${built.extraMeta.questionIndex}` : "";
  return {
    surfaceId: `et-demand:${cleanText(ev.sessionKey)}:${toolUseId}${stepSuffix}`,
    payload: built.payload,
    options: built.options,
    meta: {
      kind: built.payload.kind,
      sessionKey: cleanText(ev.sessionKey),
      provider,
      sessionId,
      toolUseId,
      questionText: built.extraMeta.questionText,
      questionIndex: built.extraMeta.questionIndex,
      answerableIndexes: built.extraMeta.answerableIndexes,
      stepIndex: built.extraMeta.stepIndex,
      stepCount: built.extraMeta.stepCount,
      questionTexts: built.extraMeta.questionTexts,
    },
  };
}

function frameQuestionTexts(frame) {
  return questionEntries(frame).map((e) => e.text);
}

module.exports = { buildDemandSurface, buildDemandFrame, frameQuestionTexts, parseSessionKey, QUESTION_DEADLINE_SEC, PERMISSION_DEADLINE_SEC };
