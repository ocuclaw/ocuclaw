const { INPUT_PREDICTION_PURPOSE, findForbiddenKey, normalizeCandidateWord } = require("./input-prediction-shared.cjs");

const SILENT_INPUT_OPEN_PROMPT_VERSION = "sio-3";

const SILENT_INPUT_OPEN_LIMITS = Object.freeze({

  maxReplies: 5,

  maxReplyChars: 60,

  promptWords: 0,

  maxWords: 48,

  maxReplyingToChars: 512,

  timeoutMs: 6000,

  maxTimeoutMs: 10000,

  maxTokens: 256,
});

const SILENT_INPUT_OPEN_TEST_LIMITS = Object.freeze({

  maxReplies: 2,

  promptWords: 0,

  maxTokens: 96,
});

const SILENT_INPUT_OPEN_TEST_EXAMPLE = Object.freeze({
  replyingTo: "Are you free for lunch tomorrow?",
  locale: "en",
});

const REPLY_RE = /^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF0-9 ,.'!?:-]+$/;
const REPLY_LETTER_RE = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/;
const REPLY_RAW_CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/u;

const OPEN_ASK_KEYS = "exactly two keys";
const SMALL_ASK_KEYS = "exactly one key";
const OPEN_ASK_WORDS_CLAUSE =
  '"words": at most {n} distinct lower-case {english}words, letters only, that are likely to ' +
  "appear in their reply, most likely first. Single words, never phrases.\n";
const OPEN_ASK_EXAMPLE =
  '{"replies":["On my way","Give me ten minutes","Sorry, not today"],' +
  '"words":["yes","sure","sorry","later","tomorrow","meeting"]}';
const SMALL_ASK_EXAMPLE = '{"replies":["On my way","Give me ten minutes"]}';

function askShape(ask) {
  const a = ask && typeof ask === "object" ? ask : SILENT_INPUT_OPEN_LIMITS;
  const maxReplies = Number.isFinite(a.maxReplies) ? a.maxReplies : SILENT_INPUT_OPEN_LIMITS.maxReplies;
  const promptWords = Number.isFinite(a.promptWords) ? a.promptWords : SILENT_INPUT_OPEN_LIMITS.promptWords;
  return { maxReplies, promptWords };
}

function buildOpenReplyMessages(req, ask = SILENT_INPUT_OPEN_LIMITS) {
  const locale = req && typeof req.locale === "string" && req.locale ? req.locale : "en";
  const english = locale === "en" ? "English " : "";
  const { maxReplies, promptWords } = askShape(ask);
  const keys = promptWords > 0 ? OPEN_ASK_KEYS : SMALL_ASK_KEYS;
  const wordsClause = promptWords > 0
    ? OPEN_ASK_WORDS_CLAUSE.replace("{n}", String(promptWords)).replace("{english}", english)
    : "";
  const example = promptWords > 0 ? OPEN_ASK_EXAMPLE : SMALL_ASK_EXAMPLE;
  const system =
    "Someone wearing smart glasses is about to answer a short chat message. Typing is slow " +
    "for them: every word costs several gestures. Reply with ONLY a JSON object with " +
    `${keys}.\n` +
    `"replies": at most ${maxReplies} different short whole ${english}replies they might send, ` +
    "most likely first. Each is one plain sentence of at most eight words, no emoji, no " +
    "markdown, no names they have not been given.\n" +
    `${wordsClause}` +
    "No explanation, no other keys. Example answer: " +
    `${example}`;
  const replyingTo = req && typeof req.replyingTo === "string" ? req.replyingTo : "";
  const user = `The message they are answering: ${JSON.stringify(replyingTo)}\nJSON object:`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseObjectText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const attempts = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced && fenced[1]) attempts.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1));
  for (const attempt of attempts) {
    let parsed;
    try {
      parsed = JSON.parse(attempt);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return null;
}

function normalizeWholeReply(raw) {
  if (typeof raw !== "string") return null;
  if (REPLY_RAW_CONTROL_OR_FORMAT_RE.test(raw)) return null;
  const collapsed = raw.normalize("NFC").replace(/ +/g, " ").replace(/^ +| +$/g, "");
  if (!collapsed || collapsed.length > SILENT_INPUT_OPEN_LIMITS.maxReplyChars) return null;
  if (!REPLY_RE.test(collapsed)) return null;
  if (!REPLY_LETTER_RE.test(collapsed)) return null;
  return collapsed;
}

function parseOpenReplyText(text, ask = SILENT_INPUT_OPEN_LIMITS) {
  const parsed = parseObjectText(text);
  if (!parsed) return null;
  const { maxReplies } = askShape(ask);
  const replies = [];
  const seenReplies = new Set();
  let rejectedReplies = 0;
  const rawReplies = Array.isArray(parsed.replies) ? parsed.replies : [];
  for (const raw of rawReplies) {
    const reply = normalizeWholeReply(raw);
    if (!reply) { rejectedReplies += 1; continue; }
    const key = reply.toLowerCase();
    if (seenReplies.has(key)) { rejectedReplies += 1; continue; }
    seenReplies.add(key);
    replies.push(reply);
    if (replies.length >= maxReplies) break;
  }
  const words = [];
  const seenWords = new Set();
  let rejectedWords = 0;
  const rawWords = Array.isArray(parsed.words) ? parsed.words : [];
  for (const raw of rawWords) {
    const word = normalizeCandidateWord(raw);
    if (!word) { rejectedWords += 1; continue; }
    if (seenWords.has(word.key)) { rejectedWords += 1; continue; }
    seenWords.add(word.key);
    words.push(word.display);
    if (words.length >= SILENT_INPUT_OPEN_LIMITS.maxWords) break;
  }
  return {
    replies,
    words,
    rejectedReplies,
    rejectedWords,
    receivedReplies: rawReplies.length,
    receivedWords: rawWords.length,
  };
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeOpenRequest(params) {
  if (!params || typeof params !== "object") {
    return { ok: false, status: "error", reason: "invalid-request: params must be an object" };
  }
  const forbidden = findForbiddenKey(params);
  if (forbidden) {
    return { ok: false, status: "policy-denied", reason: `forbidden field: ${forbidden}` };
  }
  const replyingTo = typeof params.replyingTo === "string" ? params.replyingTo : "";
  if (replyingTo.length > SILENT_INPUT_OPEN_LIMITS.maxReplyingToChars) {
    return {
      ok: false,
      status: "error",
      reason: `invalid-request: replyingTo exceeds ${SILENT_INPUT_OPEN_LIMITS.maxReplyingToChars}`,
    };
  }
  if (!replyingTo.trim()) {

    return { ok: false, status: "error", reason: "invalid-request: replyingTo is empty" };
  }
  const locale = typeof params.locale === "string" && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(params.locale)
    ? params.locale
    : "en";
  const modelChoice = typeof params.modelChoice === "string" && params.modelChoice.trim()
    ? params.modelChoice.trim()
    : "default";
  if (!/^[A-Za-z0-9._:@/-]{1,128}$/.test(modelChoice)) {
    return { ok: false, status: "policy-denied", reason: "modelChoice is not a known choice id" };
  }
  return {
    ok: true,
    value: {
      requestId: typeof params.requestId === "string" ? params.requestId.slice(0, 128) : "",
      clientId: typeof params.clientId === "string" ? params.clientId : "",
      connectionId: typeof params.connectionId === "string" ? params.connectionId : "",
      agentId: typeof params.agentId === "string" && params.agentId.trim() ? params.agentId.trim() : "",
      profileId: typeof params.profileId === "string" && params.profileId.trim() ? params.profileId.trim() : "",
      purpose: INPUT_PREDICTION_PURPOSE,
      replyingTo,
      locale,
      modelChoice,
      timeoutMs: clampInt(
        params.timeoutMs,
        200,
        SILENT_INPUT_OPEN_LIMITS.maxTimeoutMs,
        SILENT_INPUT_OPEN_LIMITS.timeoutMs,
      ),
    },
  };
}

const OPEN_REPLY_MODEL_UNREACHABLE_REASON = "model-unreachable";

const UNREACHABLE_CLASSES = [
  ["runtime-only", /agent runtime/i],
  ["unknown-model", /\bunknown model\b|no such model|model[ _]not[ _]found|is not a valid model|model does not exist|the model `[^`]{0,120}` does not exist/i],
  ["no-model", /\bno model\b/i],
  ["auth", /\b(?:no|missing) api key\b|no credentials|auth lookup failed/i],
  ["provider", /no llm provider configured|not configured|malformed custom endpoint url/i],
  ["host-refused", /^\s*Plugin LLM completion failed:/i],
];
const MODEL_UNREACHABLE_RE = new RegExp(UNREACHABLE_CLASSES.map((entry) => `(?:${entry[1].source})`).join("|"), "i");

function openReplyFailureClass(err) {
  const message = err && typeof err.message === "string" ? err.message : String(err || "");
  if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) return "aborted";
  for (const [name, re] of UNREACHABLE_CLASSES) if (re.test(message)) return name;
  if (/denied|not allowed|not permitted|override|permission|allowed_?models|trust/i.test(message)) return "policy";
  if (/timed out|timeout/i.test(message)) return "timeout";
  return "other";
}

function classifyOpenReplyError(err) {
  const message = err && typeof err.message === "string" ? err.message : String(err || "");
  if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
    return { status: "cancelled", reason: "aborted" };
  }

  if (MODEL_UNREACHABLE_RE.test(message)) {
    return { status: "unavailable", reason: OPEN_REPLY_MODEL_UNREACHABLE_REASON };
  }

  if (/denied|not allowed|not permitted|override|permission|allowed_?models|trust/i.test(message)) {
    return { status: "policy-denied", reason: "policy-denied" };
  }
  if (/unavailable|not configured|no model|missing api key|no api key|not found/i.test(message)) {
    return { status: "unavailable", reason: "unavailable" };
  }
  if (/timed out|timeout/i.test(message)) return { status: "timeout", reason: "timeout" };
  return { status: "error", reason: "upstream-error" };
}

function openReplyResult(status, extra) {
  const base = {
    status,
    replies: [],
    words: [],
    provider: "",
    model: "",
    elapsedMs: 0,
    usage: null,
  };
  return Object.assign(base, extra && typeof extra === "object" ? extra : {});
}

function openReplyTelemetry(result, extra) {
  const out = {
    status: result && result.status,
    replyCount: result && Array.isArray(result.replies) ? result.replies.length : 0,
    wordCount: result && Array.isArray(result.words) ? result.words.length : 0,
    elapsedMs: result && Number.isFinite(result.elapsedMs) ? result.elapsedMs : null,
    provider: result && result.provider ? result.provider : null,
    model: result && result.model ? result.model : null,
    usage: result && result.usage ? result.usage : null,
  };
  return Object.assign(out, extra && typeof extra === "object" ? extra : {});
}

module.exports = { SILENT_INPUT_OPEN_PROMPT_VERSION, SILENT_INPUT_OPEN_LIMITS, SILENT_INPUT_OPEN_TEST_EXAMPLE, SILENT_INPUT_OPEN_TEST_LIMITS, buildOpenReplyMessages, normalizeWholeReply, parseOpenReplyText, normalizeOpenRequest, classifyOpenReplyError, OPEN_REPLY_MODEL_UNREACHABLE_REASON, openReplyFailureClass, openReplyResult, openReplyTelemetry };
