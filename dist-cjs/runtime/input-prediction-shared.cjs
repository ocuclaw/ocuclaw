const INPUT_PREDICTION_PROTOCOL_VERSION = 1;
const INPUT_PREDICTION_PURPOSE = "silent-input-prediction";

const INPUT_PREDICTION_PER_WORD_RETIRED_REASON =
  "this host does not write next words; suggestions come from the phone";

const INPUT_PREDICTION_PROMPT_VERSION = "sip-2";

const INPUT_PREDICTION_METHODS = Object.freeze({
  capabilities: "input.prediction.capabilities",
  request: "input.prediction.request",
  cancel: "input.prediction.cancel",
  test: "input.prediction.test",

  open: "input.prediction.open",

  modelAllow: "input.prediction.model.allow",
});

const INPUT_PREDICTION_MODEL_LIST_CAP = 20;

const INPUT_PREDICTION_MODEL_CHOICE_RE = /^[A-Za-z0-9._:@/-]{1,128}$/;

const REPLY_MODEL_FAST_OUTPUT_COST_MAX = 6;

const REPLY_MODEL_PRIORITY_TIER_RE = /-fast(?=$|[-_.:@/])/i;

function replyModelSpeedFacts(modelId, costOutPerM = null, recommended = false) {
  const out = {};
  const id = typeof modelId === "string" ? modelId : "";
  const cost = typeof costOutPerM === "number" && Number.isFinite(costOutPerM) && costOutPerM >= 0 ? costOutPerM : null;
  if (cost !== null) out.costOutPerM = Math.round(cost * 1000) / 1000;
  if (REPLY_MODEL_PRIORITY_TIER_RE.test(id)) {
    out.fast = false;
  } else if (recommended === true) {
    out.fast = true;
  } else if (cost !== null && cost > 0) {
    out.fast = cost <= REPLY_MODEL_FAST_OUTPUT_COST_MAX;
  }
  return out;
}

const INPUT_PREDICTION_MODEL_ALLOW_STATUSES = Object.freeze(["saved", "policy-denied", "error"]);

const INPUT_PREDICTION_MODEL_ALLOW_MODES = Object.freeze(["none", "hot_reload", "restart", "manual"]);

function modelAllowResult(requestId, status, activation = null) {
  const s = INPUT_PREDICTION_MODEL_ALLOW_STATUSES.includes(status) ? status : "error";
  const a = activation && typeof activation === "object" ? activation : {};
  const mode = INPUT_PREDICTION_MODEL_ALLOW_MODES.includes(a.mode) ? a.mode : (s === "saved" ? "manual" : "none");
  return {
    requestId: typeof requestId === "string" && INPUT_PREDICTION_MODEL_CHOICE_RE.test(requestId) ? requestId : "",
    status: s,
    activation: { required: s === "saved" ? a.required !== false : false, mode: s === "saved" ? mode : "none" },
  };
}

const INPUT_PREDICTION_LIMITS = Object.freeze({
  maxContextChars: 512,
  maxPatternLength: 31,
  maxCandidates: 20,
  maxVisible: 8,
  debounceMs: 250,
  minIntervalMs: 1000,
  timeoutMs: 5000,
});

const INPUT_PREDICTION_STATUSES = Object.freeze([
  "ready",
  "unavailable",
  "busy",
  "timeout",
  "invalid-output",
  "policy-denied",
  "cancelled",
  "error",
]);

const INPUT_PREDICTION_SPELLING_MODES = Object.freeze(["predictive", "exact"]);

const INPUT_PREDICTION_TEST_EXAMPLE = Object.freeze({
  contextSuffix: "Let's meet at the",
  pattern: "1",
  spellingMode: "predictive",
  ways: 2,
  locale: "en",
  maxCandidates: 8,
});

const INPUT_PREDICTION_FORBIDDEN_KEYS = Object.freeze([
  "url",
  "baseurl",
  "apibase",
  "endpoint",
  "apikey",
  "api_key",
  "token",
  "authorization",
  "credentials",
  "headers",
  "prompt",
  "systemprompt",
  "system",
  "messages",
  "instructions",
  "provider",
  "model",
  "temperature",
  "maxtokens",

  "profile",
  "task",
  "auxiliary",
  "agent_id",
]);

const INPUT_PREDICTION_PHONE_FORBIDDEN_KEYS = Object.freeze([
  ...INPUT_PREDICTION_FORBIDDEN_KEYS,
  "agentid",
  "profileid",
  "clientid",
  "connectionid",
  "purpose",
  "timeoutms",
  "hiddenkeys",
]);

const LETTER_RE = /^[A-Za-z]{1,31}$/;

const INPUT_PREDICTION_CANDIDATE_SCHEMA_ALPHA = "alpha-v1";
const INPUT_PREDICTION_CANDIDATE_SCHEMA_APOSTROPHE = "local-apostrophe-v1";
const INPUT_PREDICTION_CANDIDATE_SCHEMAS = Object.freeze([
  INPUT_PREDICTION_CANDIDATE_SCHEMA_ALPHA,
  INPUT_PREDICTION_CANDIDATE_SCHEMA_APOSTROPHE,
]);

const INPUT_PREDICTION_UNSUPPORTED_SCHEMA_REASON = "invalid-request: unsupported candidateSchema";

const APOSTROPHE_CANDIDATE_RE = /^[A-Za-z]+(?:'[A-Za-z]+)*$/;

function normalizeCandidateSchema(params) {
  const p = params && typeof params === "object" ? params : {};
  if (p.candidateSchema === undefined || p.candidateSchema === null) {
    return { ok: true, schema: INPUT_PREDICTION_CANDIDATE_SCHEMA_ALPHA, named: false };
  }
  const raw = p.candidateSchema;
  if (typeof raw !== "string" || !INPUT_PREDICTION_CANDIDATE_SCHEMAS.includes(raw)) {
    return { ok: false, schema: "", named: true };
  }
  return { ok: true, schema: raw, named: true };
}

function isCandidateUnderSchema(text, schema) {
  if (typeof text !== "string" || text.length < 1 || text.length > INPUT_PREDICTION_LIMITS.maxPatternLength) return false;
  if (schema === INPUT_PREDICTION_CANDIDATE_SCHEMA_ALPHA) return LETTER_RE.test(text);
  if (schema === INPUT_PREDICTION_CANDIDATE_SCHEMA_APOSTROPHE) return APOSTROPHE_CANDIDATE_RE.test(text);
  return false;
}

function candidateMatchKey(text) {
  return String(text || "").toLowerCase().replace(/'/g, "");
}

function letterGroup(ch, ways) {
  const code = String(ch || "").toLowerCase().charCodeAt(0);
  if (!(code >= 97 && code <= 122)) return -1;
  const index = code - 97;
  if (ways === 3) {
    if (index <= 8) return 0;
    if (index <= 17) return 1;
    return 2;
  }
  return index <= 12 ? 0 : 1;
}

function normalizeWays(raw) {
  const n = Math.trunc(Number(raw));
  return n === 3 ? 3 : 2;
}

function isPatternDigits(pattern, ways) {
  if (typeof pattern !== "string") return false;
  const maxDigit = normalizeWays(ways) === 3 ? "2" : "1";
  for (const ch of pattern) {
    if (ch < "0" || ch > maxDigit) return false;
  }
  return true;
}

function patternCompatible(word, pattern, ways) {
  const w = String(word || "");
  const p = String(pattern || "");
  if (p.length > w.length) return false;
  for (let i = 0; i < p.length; i += 1) {
    if (letterGroup(w[i], ways) !== Number(p[i])) return false;
  }
  return true;
}

function normalizeCandidateWord(raw, schema = INPUT_PREDICTION_CANDIDATE_SCHEMA_ALPHA) {
  if (typeof raw !== "string") return null;
  const display = raw.trim();
  if (!isCandidateUnderSchema(display, schema)) return null;
  return { display, key: display.toLowerCase(), matchKey: candidateMatchKey(display) };
}

function validateCandidates(list, opts) {
  const pattern = opts && typeof opts.pattern === "string" ? opts.pattern : "";
  const ways = normalizeWays(opts && opts.ways);
  const schema = opts && typeof opts.candidateSchema === "string"
    ? opts.candidateSchema
    : INPUT_PREDICTION_CANDIDATE_SCHEMA_ALPHA;
  const cap = clampInt(opts && opts.maxCandidates, 1, INPUT_PREDICTION_LIMITS.maxCandidates, INPUT_PREDICTION_LIMITS.maxCandidates);
  const hidden = new Set(
    Array.isArray(opts && opts.hiddenKeys) ? opts.hiddenKeys.map((k) => String(k).toLowerCase()) : [],
  );
  const seen = new Set();
  const candidates = [];
  let rejected = 0;
  const source = Array.isArray(list) ? list : [];
  for (const raw of source) {
    const word = normalizeCandidateWord(raw, schema);
    if (!word) { rejected += 1; continue; }
    if (seen.has(word.key)) { rejected += 1; continue; }
    if (hidden.has(word.key)) { rejected += 1; continue; }
    if (!patternCompatible(word.matchKey, pattern, ways)) { rejected += 1; continue; }
    seen.add(word.key);
    candidates.push(word.display);
    if (candidates.length >= cap) break;
  }
  return { candidates, rejected, received: source.length };
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function findForbiddenKey(params, opts = null) {
  if (!params || typeof params !== "object") return null;
  const list = opts && opts.phone === true
    ? INPUT_PREDICTION_PHONE_FORBIDDEN_KEYS
    : INPUT_PREDICTION_FORBIDDEN_KEYS;
  for (const key of Object.keys(params)) {
    const folded = key.toLowerCase();
    if (list.includes(folded)) return key;
  }
  return null;
}

function normalizePredictionRequest(params) {
  if (!params || typeof params !== "object") {
    return { ok: false, status: "error", reason: "invalid-request: params must be an object" };
  }
  const forbidden = findForbiddenKey(params);
  if (forbidden) {
    return { ok: false, status: "policy-denied", reason: `forbidden field: ${forbidden}` };
  }
  const contextSuffix = typeof params.contextSuffix === "string" ? params.contextSuffix : "";
  if (contextSuffix.length > INPUT_PREDICTION_LIMITS.maxContextChars) {
    return { ok: false, status: "error", reason: `invalid-request: contextSuffix exceeds ${INPUT_PREDICTION_LIMITS.maxContextChars}` };
  }
  const ways = normalizeWays(params.ways);
  const pattern = typeof params.pattern === "string" ? params.pattern : "";
  if (pattern.length > INPUT_PREDICTION_LIMITS.maxPatternLength || !isPatternDigits(pattern, ways)) {
    return { ok: false, status: "error", reason: "invalid-request: pattern must be group digits, at most 31" };
  }
  const spellingMode = INPUT_PREDICTION_SPELLING_MODES.includes(params.spellingMode)
    ? params.spellingMode
    : "predictive";
  const locale = typeof params.locale === "string" && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(params.locale)
    ? params.locale
    : "en";
  const maxCandidates = clampInt(params.maxCandidates, 1, INPUT_PREDICTION_LIMITS.maxCandidates, INPUT_PREDICTION_LIMITS.maxCandidates);
  const modelChoice = typeof params.modelChoice === "string" && params.modelChoice.trim()
    ? params.modelChoice.trim()
    : "default";
  if (!/^[A-Za-z0-9._:@/-]{1,128}$/.test(modelChoice)) {
    return { ok: false, status: "policy-denied", reason: "modelChoice is not a known choice id" };
  }
  const timeoutMs = clampInt(params.timeoutMs, 200, 10_000, INPUT_PREDICTION_LIMITS.timeoutMs);
  return {
    ok: true,
    value: {
      requestId: typeof params.requestId === "string" ? params.requestId.slice(0, 128) : "",
      clientId: typeof params.clientId === "string" ? params.clientId : "",
      connectionId: typeof params.connectionId === "string" ? params.connectionId : "",
      agentId: typeof params.agentId === "string" && params.agentId.trim() ? params.agentId.trim() : "",
      profileId: typeof params.profileId === "string" && params.profileId.trim() ? params.profileId.trim() : "",
      purpose: INPUT_PREDICTION_PURPOSE,
      contextSuffix,
      pattern,
      spellingMode,
      ways,
      locale,
      maxCandidates,
      modelChoice,
      timeoutMs,
      hiddenKeys: Array.isArray(params.hiddenKeys)
        ? params.hiddenKeys.filter((k) => typeof k === "string").slice(0, 64)
        : [],
    },
  };
}

const INPUT_PREDICTION_JEV_LIMITS = Object.freeze({
  maxReplyingToChars: 512,
});

function normalizeJevContext(params) {
  const p = params && typeof params === "object" ? params : {};
  const replyingTo = typeof p.replyingTo === "string"
    ? p.replyingTo.slice(0, INPUT_PREDICTION_JEV_LIMITS.maxReplyingToChars)
    : "";
  return { replyingTo };
}

function predictionResult(status, extra) {
  const base = {
    status: INPUT_PREDICTION_STATUSES.includes(status) ? status : "error",
    candidates: [],
    provider: "",
    model: "",
    elapsedMs: 0,
    usage: null,
  };
  return Object.assign(base, extra && typeof extra === "object" ? extra : {});
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = pickNumber([raw.inputTokens, raw.input_tokens, raw.input, raw.promptTokens, raw.prompt_tokens]);
  const output = pickNumber([raw.outputTokens, raw.output_tokens, raw.output, raw.completionTokens, raw.completion_tokens]);
  if (input === null && output === null) return null;

  if (!input && !output) return null;
  return { inputTokens: input, outputTokens: output };
}

function pickNumber(values) {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function predictionTelemetry(result, extra) {
  const out = {
    status: result && result.status,
    candidateCount: result && Array.isArray(result.candidates) ? result.candidates.length : 0,
    elapsedMs: result && Number.isFinite(result.elapsedMs) ? result.elapsedMs : null,
    provider: result && result.provider ? result.provider : null,
    model: result && result.model ? result.model : null,
    usage: result && result.usage ? result.usage : null,
  };
  return Object.assign(out, extra && typeof extra === "object" ? extra : {});
}

function policyRevisionOf(policy) {
  const text = JSON.stringify(policy || {});
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `p${h.toString(16)}`;
}

module.exports = { INPUT_PREDICTION_PROTOCOL_VERSION, INPUT_PREDICTION_PURPOSE, INPUT_PREDICTION_PER_WORD_RETIRED_REASON, INPUT_PREDICTION_PROMPT_VERSION, INPUT_PREDICTION_METHODS, INPUT_PREDICTION_LIMITS, INPUT_PREDICTION_STATUSES, INPUT_PREDICTION_SPELLING_MODES, INPUT_PREDICTION_TEST_EXAMPLE, INPUT_PREDICTION_FORBIDDEN_KEYS, INPUT_PREDICTION_PHONE_FORBIDDEN_KEYS, letterGroup, normalizeWays, isPatternDigits, patternCompatible, normalizeCandidateWord, validateCandidates, findForbiddenKey, normalizePredictionRequest, predictionResult, normalizeUsage, predictionTelemetry, policyRevisionOf, INPUT_PREDICTION_JEV_LIMITS, normalizeJevContext, INPUT_PREDICTION_MODEL_LIST_CAP, INPUT_PREDICTION_MODEL_CHOICE_RE, INPUT_PREDICTION_MODEL_ALLOW_STATUSES, INPUT_PREDICTION_MODEL_ALLOW_MODES, modelAllowResult, REPLY_MODEL_FAST_OUTPUT_COST_MAX, replyModelSpeedFacts, INPUT_PREDICTION_CANDIDATE_SCHEMA_ALPHA, INPUT_PREDICTION_CANDIDATE_SCHEMA_APOSTROPHE, INPUT_PREDICTION_CANDIDATE_SCHEMAS, INPUT_PREDICTION_UNSUPPORTED_SCHEMA_REASON, normalizeCandidateSchema, isCandidateUnderSchema, candidateMatchKey };
