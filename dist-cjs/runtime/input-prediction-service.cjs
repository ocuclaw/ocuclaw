const { INPUT_PREDICTION_CANDIDATE_SCHEMAS, INPUT_PREDICTION_UNSUPPORTED_SCHEMA_REASON, INPUT_PREDICTION_LIMITS, INPUT_PREDICTION_METHODS, INPUT_PREDICTION_PER_WORD_RETIRED_REASON, INPUT_PREDICTION_PROMPT_VERSION, INPUT_PREDICTION_PROTOCOL_VERSION, INPUT_PREDICTION_PURPOSE, INPUT_PREDICTION_TEST_EXAMPLE, findForbiddenKey, isCandidateUnderSchema, modelAllowResult, normalizeCandidateSchema, normalizeJevContext, normalizePredictionRequest, normalizeUsage, predictionResult, predictionTelemetry } = require("./input-prediction-shared.cjs");
const { SILENT_INPUT_OPEN_LIMITS, SILENT_INPUT_OPEN_PROMPT_VERSION, classifyOpenReplyError, OPEN_REPLY_MODEL_UNREACHABLE_REASON, normalizeOpenRequest, openReplyResult, openReplyTelemetry } = require("./silent-input-open-reply.cjs");

const INPUT_PREDICTION_SERVICE_DEFAULTS = Object.freeze({
  maxConcurrent: 4,
  minIntervalMs: INPUT_PREDICTION_LIMITS.minIntervalMs,
  timeoutMs: INPUT_PREDICTION_LIMITS.timeoutMs,

  cacheTtlMs: 60_000,
  cacheMaxEntries: 256,
});

const INPUT_PREDICTION_DEBUG_CATEGORY = "silentInput.prediction";

const INPUT_PREDICTION_TEST_ROUND_TRIP_MARGIN_MS = 500;

const INPUT_PREDICTION_TEST_JOBS = Object.freeze(["ranking", "replies"]);

const INPUT_PREDICTION_TEST_REASON_CODES = Object.freeze([
  "ok",
  "no_key",
  "key_rejected",
  "model_unusable",

  "model_unreachable",
  "busy",
  "policy_denied",
  "cancelled",
  "no_session",
  "error",
]);

const REQUEST_ID_RE = /^[A-Za-z0-9._:@/-]{1,128}$/;

const OPEN_CALLS_PER_CLIENT = 8;

const OPEN_CALLS_MAX_TOTAL = 256;

const OPEN_CALL_TTL_MS = 10 * 60_000;

const OPEN_ACTIVE_PER_CLIENT = 1;
const OPEN_ACTIVE_TOTAL = 2;

const OPEN_MIN_INTERVAL_MS = 750;

function normalizeRoute(raw) {
  if (!raw || typeof raw !== "object") return null;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!provider || !model) return null;
  return { provider, model };
}

const KEY_SEP = String.fromCharCode(31);

function shortHash(text) {
  const s = typeof text === "string" ? text : "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function createInputPredictionService(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const bridge = o.gatewayBridge;
  if (!bridge || typeof bridge.request !== "function") {
    throw new Error("input prediction service requires a gatewayBridge with request()");
  }
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const setTimer = typeof o.setTimeoutFn === "function" ? o.setTimeoutFn : setTimeout;
  const clearTimer = typeof o.clearTimeoutFn === "function" ? o.clearTimeoutFn : clearTimeout;
  const emitDebug = typeof o.emitDebug === "function" ? o.emitDebug : () => {};
  const logger = o.logger && typeof o.logger.warn === "function" ? o.logger : { warn() {} };
  const resolveIdentity = typeof o.resolveIdentity === "function" ? o.resolveIdentity : () => ({});

  const jevAnswer = o.jevRanker && typeof o.jevRanker.answer === "function" ? o.jevRanker : null;

  const jevRoute = {
    provider: (jevAnswer && cleanString(jevAnswer.provider)) || "typesafe",
    model: (jevAnswer && cleanString(jevAnswer.model)) || "",
  };

  const typesafeKeyPresent = jevAnswer !== null || o.typesafeKeyPresent === true;
  const limits = {
    maxConcurrent: nonNegativeInt(o.maxConcurrent, INPUT_PREDICTION_SERVICE_DEFAULTS.maxConcurrent) || 1,
    minIntervalMs: nonNegativeInt(o.minIntervalMs, INPUT_PREDICTION_SERVICE_DEFAULTS.minIntervalMs),
    timeoutMs: nonNegativeInt(o.timeoutMs, INPUT_PREDICTION_SERVICE_DEFAULTS.timeoutMs) || INPUT_PREDICTION_SERVICE_DEFAULTS.timeoutMs,
    cacheTtlMs: nonNegativeInt(o.cacheTtlMs, INPUT_PREDICTION_SERVICE_DEFAULTS.cacheTtlMs),
    cacheMaxEntries: nonNegativeInt(o.cacheMaxEntries, INPUT_PREDICTION_SERVICE_DEFAULTS.cacheMaxEntries),
  };

  const clients = new Map();

  const lanes = new Map();

  const cache = new Map();

  const openCalls = new Map();

  let openActiveTotal = 0;
  const openActiveByClient = new Map();

  const openReplyByClient = new Map();

  const openReplyRouteByClient = new Map();
  let activeCount = 0;
  let policyRevision = "";
  const stats = {
    requests: 0,
    cacheHits: 0,
    rateLimited: 0,
    superseded: 0,
    timeouts: 0,
    dispatched: 0,
    openRequests: 0,
    openRepeats: 0,
    openRateLimited: 0,
  };

  const openTimeoutMs = nonNegativeInt(o.openTimeoutMs, SILENT_INPUT_OPEN_LIMITS.timeoutMs)
    || SILENT_INPUT_OPEN_LIMITS.timeoutMs;

  function laneKey(clientId, editorEpoch) {
    return `${clientId}|${editorEpoch}`;
  }

  function openPrefix(clientId) {
    return `${clientId}${KEY_SEP}`;
  }

  function openMemoKey(clientId, identity, req, editorEpoch) {
    return [
      openPrefix(clientId),
      identity.connectionId,
      identity.agentId,
      identity.profileId,
      req.modelChoice,
      policyRevision,
      SILENT_INPUT_OPEN_PROMPT_VERSION,
      String(editorEpoch),
      shortHash(req.replyingTo),
    ].join(KEY_SEP);
  }

  function openWordsMarker(clientId, editorEpoch) {
    const prefix = openPrefix(clientId);
    let rev = 0;
    let count = 0;
    for (const [key, entry] of openCalls) {
      if (!key.startsWith(prefix)) continue;
      if (entry.editorEpoch !== editorEpoch) continue;
      rev += entry.wordsRevision || 0;
      count += entry.words ? entry.words.length : 0;
    }
    return `${rev}:${count}`;
  }

  function identityFor(clientId) {
    let identity = {};
    try {
      identity = resolveIdentity(clientId) || {};
    } catch (err) {
      logger.warn(`[input-prediction] identity resolve failed: ${err && err.message ? err.message : err}`);
    }

    const reportsSession = identity && typeof identity === "object" && Object.prototype.hasOwnProperty.call(identity, "sessionKey");
    return {
      connectionId: cleanString(identity.connectionId) || `${bridge.kind || "backend"}:local`,
      agentId: cleanString(identity.agentId),
      profileId: cleanString(identity.profileId),
      sessionKey: cleanString(identity.sessionKey),

      noSession: (reportsSession && !cleanString(identity.sessionKey)) || identity.unroutable === true,
    };
  }

  function identityFields(identity) {
    return { agentId: identity.agentId || "", profileId: identity.profileId || "", sessionKey: identity.sessionKey || "" };
  }

  const NO_SESSION_REASON = "no session for this client";
  const SESSION_MISMATCH_REASON = "session_mismatch";

  const PER_WORD_RETIRED_REASON = INPUT_PREDICTION_PER_WORD_RETIRED_REASON;

  const NOTHING_TO_OFFER_REASON = "this host adds nothing to word suggestions";

  const OPEN_REPLY_UNSUPPORTED_REASON = "this host does not write whole replies";

  const NO_TYPESAFE_KEY_REASON = "this host has no TypeSafe key";

  function testReasonCode(status, reason) {
    if (status === "ready") return "ok";
    if (status === "invalid-output") return "model_unusable";
    if (status === "busy") return "busy";
    if (status === "policy-denied") return "policy_denied";
    if (status === "cancelled") return "cancelled";
    const text = typeof reason === "string" ? reason : "";

    if ((status === "unavailable" || status === "error") && text === OPEN_REPLY_MODEL_UNREACHABLE_REASON) {
      return "model_unreachable";
    }
    if (status === "unavailable") {
      if (text === NO_SESSION_REASON || text === SESSION_MISMATCH_REASON) return "no_session";
      if (text === NO_TYPESAFE_KEY_REASON) return "no_key";
      if (text === "jev:http_401" || text === "jev:http_403") return "key_rejected";
    }

    return "error";
  }

  function phoneSessionMismatch(p, identity) {
    const phoneSession = cleanString(p.sessionKey);
    return phoneSession !== "" && phoneSession !== identity.sessionKey;
  }

  function cacheKey(clientId, identity, req, payload) {

    const jev = jevAnswer ? normalizeJevContext(payload) : null;

    const editorEpoch = nonNegativeInt(payload && payload.editorEpoch, 0);

    const schema = normalizeCandidateSchema(payload);
    return [
      clientId,
      identity.connectionId,

      identity.agentId,
      identity.profileId,
      req.modelChoice,
      policyRevision,
      INPUT_PREDICTION_PROMPT_VERSION,
      req.locale,
      req.spellingMode,
      String(req.ways),
      req.contextSuffix,
      req.pattern,
      String(editorEpoch),
      openWordsMarker(clientId, editorEpoch),
    ]
      .concat(jev ? ["jev", jev.replyingTo] : [])
      .concat(schema.ok && schema.named ? ["schema", schema.schema] : []).join("\u001f");
  }

  function schemaEcho(payload) {
    const schema = normalizeCandidateSchema(payload);
    return schema.ok && schema.named ? { candidateSchema: schema.schema } : {};
  }

  function sanitizeUnderSchema(result, schema) {
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    result.candidates = candidates.filter((word) => isCandidateUnderSchema(word, schema));
    if (Array.isArray(result.rankedWords)) {
      const scores = Array.isArray(result.rankedScores) ? result.rankedScores : [];
      const words = [];
      const kept = [];
      for (let i = 0; i < result.rankedWords.length; i += 1) {
        if (!isCandidateUnderSchema(result.rankedWords[i], schema)) continue;
        words.push(result.rankedWords[i]);
        kept.push(scores[i]);
      }
      result.rankedWords = words;
      if (Array.isArray(result.rankedScores)) result.rankedScores = kept;
    }
    return result;
  }

  function noteIdentity(clientId, identity) {
    const identityKey = [identity.connectionId, identity.agentId, identity.profileId].join("\u001f");
    const state = clients.get(clientId) || { lastCallAtMs: 0 };
    const previous = state.identityKey;
    state.identityKey = identityKey;
    clients.set(clientId, state);
    if (previous === undefined || previous === identityKey) return;
    let dropped = 0;
    for (const [key, entry] of Array.from(cache.entries())) {
      if (entry.clientId === clientId) {
        cache.delete(key);
        dropped += 1;
      }
    }

    const openDropped = dropOpenCalls(clientId);
    try {
      emitDebug(INPUT_PREDICTION_DEBUG_CATEGORY, "prediction_cache_cleared", { clientId, reason: "identity_changed", dropped, openDropped });
    } catch {

    }
  }

  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= now()) {
      cache.delete(key);
      return null;
    }

    cache.delete(key);
    cache.set(key, entry);
    return entry.result;
  }

  function cacheSet(key, clientId, result) {
    if (limits.cacheMaxEntries === 0 || limits.cacheTtlMs === 0) return;
    cache.set(key, { result, expiresAtMs: now() + limits.cacheTtlMs, clientId });
    while (cache.size > limits.cacheMaxEntries) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function echoFields(payload, req) {
    return {
      requestId: req.requestId,
      editorEpoch: nonNegativeInt(payload.editorEpoch, 0),
      draftRevision: nonNegativeInt(payload.draftRevision, 0),
      settingsRevision: nonNegativeInt(payload.settingsRevision, 0),
      dictionaryRevision: nonNegativeInt(payload.dictionaryRevision, 0),
      ...schemaEcho(payload),
    };
  }

  function telemetry(event, result, extra) {
    try {
      emitDebug(INPUT_PREDICTION_DEBUG_CATEGORY, event, predictionTelemetry(result, extra));
    } catch {

    }
  }

  async function capabilities(clientId) {
    let identity = identityFor(clientId);
    let caps = await fetchCapabilities(clientId, identity);

    const now = identityFor(clientId);
    if (now.agentId !== identity.agentId || now.profileId !== identity.profileId || now.sessionKey !== identity.sessionKey) {
      identity = now;
      caps = await fetchCapabilities(clientId, identity);
    }

    return caps;
  }

  async function fetchCapabilities(clientId, identity) {
    let caps;
    try {
      caps = await bridge.request(INPUT_PREDICTION_METHODS.capabilities, {
        clientId,
        connectionId: identity.connectionId,
        agentId: identity.agentId || undefined,
        profileId: identity.profileId || undefined,
        purpose: INPUT_PREDICTION_PURPOSE,
      });
    } catch (err) {
      caps = {
        protocolVersion: INPUT_PREDICTION_PROTOCOL_VERSION,
        supported: false,
        unsupportedReason: `backend rejected capabilities: ${err && err.message ? err.message : err}`,
        structuredOutput: false,
        abort: false,
        policyRevision: "",
        limits: { ...INPUT_PREDICTION_LIMITS },
        models: [],
        connectionDefault: null,
      };
    }
    const c = caps && typeof caps === "object" ? caps : {};
    const nextRevision = cleanString(c.policyRevision);
    if (nextRevision && nextRevision !== policyRevision) {

      policyRevision = nextRevision;
      cache.clear();
      openCalls.clear();
    }

    const ranking = jevAnswer !== null;

    const writesReplies = c.openReply === true;
    const supported = ranking || writesReplies;

    openReplyByClient.set(clientId, writesReplies);
    const openRoute = normalizeRoute(c.openReplyRoute)
      || (c.connectionDefault && typeof c.connectionDefault === "object" ? normalizeRoute(c.connectionDefault) : null);
    if (openRoute) openReplyRouteByClient.set(clientId, openRoute);
    return {
      protocolVersion: INPUT_PREDICTION_PROTOCOL_VERSION,

      supported,
      unsupportedReason: supported
        ? undefined
        : (cleanString(c.unsupportedReason) || NOTHING_TO_OFFER_REASON),
      structuredOutput: c.structuredOutput === true,

      abort: ranking ? true : c.abort === true,
      policyRevision: cleanString(c.policyRevision),
      limits: {
        ...INPUT_PREDICTION_LIMITS,
        debounceMs: INPUT_PREDICTION_LIMITS.debounceMs,
        minIntervalMs: limits.minIntervalMs,
        timeoutMs: limits.timeoutMs,
      },

      jevRanker: ranking,

      typesafeKeyPresent,

      candidateSchemas: INPUT_PREDICTION_CANDIDATE_SCHEMAS.slice(),

      openReply: c.openReply === true,

      openReplyRoute: normalizeRoute(c.openReplyRoute),

      models: ranking ? [] : (Array.isArray(c.models) ? c.models : []),

      replyModels: Array.isArray(c.models) ? c.models : [],
      connectionDefault: ranking
        ? { provider: jevRoute.provider, model: jevRoute.model }
        : (c.connectionDefault && typeof c.connectionDefault === "object" ? c.connectionDefault : null),
      host: c.host && typeof c.host === "object" ? c.host : { kind: bridge.kind || "" },
      ...identityFields(identity),
    };
  }

  function makeJob(clientId, payload, req, identity, resolve, kind = "request", routeOverride = "") {
    return {
      clientId,
      payload,
      req,
      identity,
      resolve,

      kind,

      route: routeOverride === "jev" || routeOverride === "bridge" ? routeOverride : (jevAnswer ? "jev" : "bridge"),

      abort: null,
      laneKey: "",
      settled: false,
      cancelled: false,
      timer: null,
      scheduledTimer: null,
    };
  }

  function stopBackend(job) {
    if (job.route === "jev") {
      if (job.abort) {
        try {
          job.abort.abort();
        } catch (_) {

        }
      }
      return null;
    }
    return bridge.request(INPUT_PREDICTION_METHODS.cancel, { requestId: job.req.requestId, clientId: job.clientId });
  }

  function releaseLane(job) {
    const lk = job.laneKey;
    const lane = lanes.get(lk);
    if (!lane || lane.active !== job) return;
    lane.active = null;
    if (lane.pending) {
      const next = lane.pending;
      lane.pending = null;
      lane.active = next;

      const state = clients.get(job.clientId) || { lastCallAtMs: 0 };
      const wait = Math.max(0, state.lastCallAtMs + limits.minIntervalMs - now());
      if (wait > 0) schedule(next, wait);
      else dispatch(next);
    } else {
      lanes.delete(lk);
    }
  }

  function settle(job, result) {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) {
      clearTimer(job.timer);
      job.timer = null;
    }
    job.resolve(result);
  }

  async function dispatch(job) {
    const { clientId, req, identity } = job;
    const echo = echoFields(job.payload, req);
    if (job.settled) {
      releaseLane(job);
      return;
    }
    if (job.cancelled) {

      settle(job, predictionResult("cancelled", { ...echo, reason: "cancelled before dispatch" }));
      releaseLane(job);
      return;
    }
    const key = job.kind === "test" ? null : cacheKey(clientId, identity, req, job.payload);
    const cached = key ? cacheGet(key) : null;

    if (cached) {
      stats.cacheHits += 1;

      const hit = predictionResult("ready", { ...cached, ...echo, cached: true, usage: null });
      telemetry("prediction_cache_hit", hit, { clientId });
      settle(job, hit);
      releaseLane(job);
      return;
    }
    if (activeCount >= limits.maxConcurrent) {

      const busy = predictionResult("busy", { ...echo, reason: "plugin prediction concurrency exhausted" });
      telemetry("prediction_busy", busy, { clientId, activeCount });
      settle(job, busy);
      releaseLane(job);
      return;
    }
    activeCount += 1;
    stats.dispatched += 1;
    const startedAt = now();
    const clientState = clients.get(clientId) || { lastCallAtMs: 0 };
    clientState.lastCallAtMs = startedAt;
    clients.set(clientId, clientState);
    job.timer = setTimer(() => {
      stats.timeouts += 1;
      const timeout = predictionResult("timeout", {
        ...echo,
        elapsedMs: now() - startedAt,
        reason: `no result within ${req.timeoutMs} ms`,
      });
      telemetry("prediction_timeout", timeout, { clientId });
      settle(job, timeout);
      const stopped = stopBackend(job);
      if (stopped) stopped.catch(() => {});
    }, req.timeoutMs);
    try {

      const params = job.kind === "test"
        ? {
            requestId: req.requestId,
            modelChoice: req.modelChoice,
            purpose: INPUT_PREDICTION_PURPOSE,
            timeoutMs: req.timeoutMs,
          }
        : { ...req };

      if (job.route === "jev") job.abort = new AbortController();
      const raw = job.route === "jev"
        ? await jevAnswer.answer(
          req,

          job.kind === "test"
            ? {}
            : {
              ...normalizeJevContext(job.payload),
              openWords: openWordsFor(clientId, job.payload && job.payload.editorEpoch),

              candidateSchema: normalizeCandidateSchema(job.payload).schema,
            },
          { signal: job.abort.signal, perGroup: job.kind === "test" ? 1 : 0 },
        )
        : await bridge.request(job.kind === "test" ? INPUT_PREDICTION_METHODS.test : INPUT_PREDICTION_METHODS.request, {
          ...params,
          clientId,
          connectionId: identity.connectionId,
          agentId: identity.agentId || undefined,
          profileId: identity.profileId || undefined,
        });
      const r = raw && typeof raw === "object" ? raw : {};

      const result = predictionResult(r.status, { ...r, ...echo, usage: normalizeUsage(r.usage) });

      if (job.kind !== "test") sanitizeUnderSchema(result, normalizeCandidateSchema(job.payload).schema);
      if (job.cancelled && result.status === "ready") {

        result.status = "cancelled";
        result.candidates = [];

        delete result.rankedWords;
        delete result.rankedScores;
        result.reason = "cancelled before result";
      }
      if (result.status === "ready" && key) {
        cacheSet(key, clientId, {
          candidates: result.candidates.slice(),

          rankedWords: Array.isArray(result.rankedWords) ? result.rankedWords.slice() : undefined,
          rankedScores: Array.isArray(result.rankedScores) ? result.rankedScores.slice() : undefined,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          elapsedMs: result.elapsedMs,
        });
      }
      telemetry("prediction_result", result, { clientId, e2eMs: now() - startedAt });
      settle(job, result);
    } catch (err) {
      const failure = predictionResult("error", {
        ...echo,
        elapsedMs: now() - startedAt,
        reason: err && err.message ? String(err.message).slice(0, 200) : String(err),
      });
      telemetry("prediction_error", failure, { clientId });
      settle(job, failure);
    } finally {
      activeCount = Math.max(0, activeCount - 1);
      releaseLane(job);
    }
  }

  function request(clientId, payload) {
    const identity = identityFor(clientId);
    const tag = identityFields(identity);
    return requestFor(clientId, payload, identity).then((result) => ({ ...result, ...tag }));
  }

  function requestFor(clientId, payload, identity) {
    stats.requests += 1;
    const p = payload && typeof payload === "object" ? payload : {};
    const requestIdIn = cleanString(p.requestId);
    const normalized = normalizePredictionRequest({
      ...p,
      requestId: requestIdIn,
      timeoutMs: limits.timeoutMs,
    });
    const editorEpoch = nonNegativeInt(p.editorEpoch, 0);
    const baseEcho = {
      requestId: requestIdIn,
      editorEpoch,
      draftRevision: nonNegativeInt(p.draftRevision, 0),
      settingsRevision: nonNegativeInt(p.settingsRevision, 0),
      dictionaryRevision: nonNegativeInt(p.dictionaryRevision, 0),
      ...schemaEcho(p),
    };
    if (!requestIdIn) {
      return Promise.resolve(predictionResult("error", { ...baseEcho, reason: "invalid-request: requestId required" }));
    }

    const phoneForbidden = findForbiddenKey(p, { phone: true });
    if (phoneForbidden) {
      const denied = predictionResult("policy-denied", { ...baseEcho, reason: `forbidden field: ${phoneForbidden}` });
      telemetry("prediction_rejected", denied, { clientId });
      return Promise.resolve(denied);
    }
    if (!normalized.ok) {
      const rejected = predictionResult(normalized.status, { ...baseEcho, reason: normalized.reason });
      telemetry("prediction_rejected", rejected, { clientId });
      return Promise.resolve(rejected);
    }

    if (!normalizeCandidateSchema(p).ok) {
      const refused = predictionResult("error", { ...baseEcho, reason: INPUT_PREDICTION_UNSUPPORTED_SCHEMA_REASON });
      telemetry("prediction_rejected", refused, { clientId, candidateSchemaKnown: false });
      return Promise.resolve(refused);
    }
    if (identity.noSession) {
      const unavailable = predictionResult("unavailable", { ...baseEcho, reason: NO_SESSION_REASON });
      telemetry("prediction_rejected", unavailable, { clientId });
      return Promise.resolve(unavailable);
    }

    if (phoneSessionMismatch(p, identity)) {
      const refused = predictionResult("unavailable", { ...baseEcho, reason: SESSION_MISMATCH_REASON });
      telemetry("prediction_rejected", refused, { clientId });
      return Promise.resolve(refused);
    }

    if (!jevAnswer) {
      const retired = predictionResult("unavailable", { ...baseEcho, reason: PER_WORD_RETIRED_REASON });
      telemetry("prediction_retired", retired, { clientId });
      return Promise.resolve(retired);
    }
    const req = normalized.value;
    noteIdentity(clientId, identity);
    const key = cacheKey(clientId, identity, req, p);
    const cached = cacheGet(key);

    if (cached) {
      stats.cacheHits += 1;
      const hit = predictionResult("ready", { ...cached, ...baseEcho, cached: true, usage: null });
      telemetry("prediction_cache_hit", hit, { clientId });
      return Promise.resolve(hit);
    }
    return enqueue(clientId, p, req, identity, laneKey(clientId, editorEpoch), baseEcho, "request");
  }

  function enqueue(clientId, p, req, identity, lk, baseEcho, kind, routeOverride = "") {
    const clientState = clients.get(clientId) || { lastCallAtMs: 0 };
    const sinceLast = now() - clientState.lastCallAtMs;
    const lane = lanes.get(lk) || { active: null, pending: null };
    return new Promise((resolve) => {
      const job = makeJob(clientId, p, req, identity, resolve, kind, routeOverride);
      job.laneKey = lk;
      if (lane.active && lane.active.scheduledTimer) {

        const old = lane.active;
        clearTimer(old.scheduledTimer);
        old.scheduledTimer = null;
        stats.superseded += 1;
        settle(old, predictionResult("cancelled", {
          ...echoFields(old.payload, old.req),
          reason: "superseded by a newer request",
        }));
        lane.active = job;
        lanes.set(lk, lane);
        schedule(job, Math.max(0, clientState.lastCallAtMs + limits.minIntervalMs - now()));
        return;
      }
      if (lane.active) {

        if (lane.pending) {
          stats.superseded += 1;
          const old = lane.pending;
          settle(old, predictionResult("cancelled", {
            ...echoFields(old.payload, old.req),
            reason: "superseded by a newer request",
          }));
        }
        lane.pending = job;
        lanes.set(lk, lane);
        return;
      }
      lane.active = job;
      lanes.set(lk, lane);
      if (limits.minIntervalMs > 0 && clientState.lastCallAtMs > 0 && sinceLast < limits.minIntervalMs) {

        stats.rateLimited += 1;
        telemetry("prediction_deferred", predictionResult("busy", baseEcho), {
          clientId,
          deferMs: limits.minIntervalMs - sinceLast,
        });
        schedule(job, limits.minIntervalMs - sinceLast);
        return;
      }
      dispatch(job);
    });
  }

  function open(clientId, payload) {
    const identity = identityFor(clientId);
    const tag = identityFields(identity);
    return openFor(clientId, payload, identity).then((result) => ({ ...result, ...tag }));
  }

  function openFor(clientId, payload, identity) {
    stats.openRequests += 1;
    const p = payload && typeof payload === "object" ? payload : {};
    const requestIdIn = cleanString(p.requestId);
    const editorEpoch = nonNegativeInt(p.editorEpoch, 0);
    const baseEcho = {
      requestId: requestIdIn,
      editorEpoch,
      settingsRevision: nonNegativeInt(p.settingsRevision, 0),
    };
    const fail = (status, reason) => {
      const result = openReplyResult(status, { ...baseEcho, reason });
      openTelemetry("open_rejected", result, { clientId });
      return Promise.resolve(result);
    };
    if (!requestIdIn || !REQUEST_ID_RE.test(requestIdIn)) {
      return fail("error", "invalid-request: requestId required");
    }
    const phoneForbidden = findForbiddenKey(p, { phone: true });
    if (phoneForbidden) return fail("policy-denied", `forbidden field: ${phoneForbidden}`);
    if (identity.noSession) return fail("unavailable", NO_SESSION_REASON);
    if (phoneSessionMismatch(p, identity)) return fail("unavailable", SESSION_MISMATCH_REASON);

    if (openReplyByClient.get(clientId) === false) {
      const unsupported = openReplyResult("unavailable", { ...baseEcho, reason: OPEN_REPLY_UNSUPPORTED_REASON });
      openTelemetry("open_unsupported", unsupported, { clientId });
      return Promise.resolve(unsupported);
    }
    const normalized = normalizeOpenRequest({
      ...p,
      requestId: requestIdIn,
      clientId,
      connectionId: identity.connectionId,
      agentId: identity.agentId || undefined,
      profileId: identity.profileId || undefined,
      timeoutMs: openTimeoutMs,
    });
    if (!normalized.ok) return fail(normalized.status, normalized.reason);
    noteIdentity(clientId, identity);

    const key = openMemoKey(clientId, identity, normalized.value, editorEpoch);
    expireOpenCalls();
    const already = openCalls.get(key);
    if (already) {
      stats.openRepeats += 1;

      openCalls.delete(key);
      openCalls.set(key, already);
      return already.promise.then((result) => ({ ...result, ...baseEcho, repeated: true }));
    }

    const state = clients.get(clientId) || {};
    if (state.lastOpenAtMs && now() - state.lastOpenAtMs < OPEN_MIN_INTERVAL_MS) {
      stats.openRateLimited += 1;
      return fail("busy", "open-call rate limit");
    }

    if (activeCount >= limits.maxConcurrent) {
      return fail("busy", "plugin prediction concurrency exhausted");
    }
    if (openActiveTotal >= OPEN_ACTIVE_TOTAL || (openActiveByClient.get(clientId) || 0) >= OPEN_ACTIVE_PER_CLIENT) {
      return fail("busy", "open-call concurrency exhausted");
    }

    const startedAt = now();
    activeCount += 1;
    openActiveTotal += 1;
    openActiveByClient.set(clientId, (openActiveByClient.get(clientId) || 0) + 1);
    state.lastOpenAtMs = startedAt;
    clients.set(clientId, state);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeCount = Math.max(0, activeCount - 1);
      openActiveTotal = Math.max(0, openActiveTotal - 1);
      const mine = (openActiveByClient.get(clientId) || 0) - 1;
      if (mine > 0) openActiveByClient.set(clientId, mine);
      else openActiveByClient.delete(clientId);
    };
    const entry = {
      words: [],
      wordsRevision: 0,
      editorEpoch,
      createdAtMs: startedAt,
      promise: null,
    };

    const forgetIfNotReady = (result) => {
      if (result && result.status === "ready") return;
      if (openCalls.get(key) === entry) openCalls.delete(key);
    };

    let call;
    try {
      const raw = bridge.request(INPUT_PREDICTION_METHODS.open, normalized.value);
      call = raw && typeof raw.then === "function" ? raw : Promise.resolve(raw);
    } catch (err) {
      call = Promise.reject(err);
    }
    entry.promise = call
      .then((raw) => {
        const r = raw && typeof raw === "object" ? raw : {};
        const result = openReplyResult(r.status === "ready" ? "ready" : r.status || "error", {
          ...r,
          ...baseEcho,
          usage: normalizeUsage(r.usage),
        });

        entry.words = Array.isArray(result.words) ? result.words.slice() : [];
        entry.wordsRevision += 1;
        openTelemetry("open_result", result, { clientId, e2eMs: now() - startedAt });
        forgetIfNotReady(result);
        return result;
      })
      .catch((err) => {

        const classified = classifyOpenReplyError(err);
        const failure = openReplyResult(classified.status, {
          ...baseEcho,
          elapsedMs: now() - startedAt,
          reason: classified.reason,
        });
        openTelemetry("open_error", failure, { clientId });
        forgetIfNotReady(failure);
        return failure;
      })
      .then((result) => {
        release();
        return result;
      });
    openCalls.set(key, entry);

    pruneOpenCalls(clientId);
    return entry.promise;
  }

  function openTelemetry(event, result, extra) {
    try {
      emitDebug(INPUT_PREDICTION_DEBUG_CATEGORY, event, openReplyTelemetry(result, extra));
    } catch {

    }
  }

  function expireOpenCalls() {
    const cutoff = now() - OPEN_CALL_TTL_MS;
    for (const [key, entry] of Array.from(openCalls.entries())) {
      if ((entry.createdAtMs || 0) <= cutoff) openCalls.delete(key);
    }
  }

  function dropOpenCalls(clientId) {
    const prefix = openPrefix(clientId);
    let dropped = 0;
    for (const key of Array.from(openCalls.keys())) {
      if (key.startsWith(prefix)) {
        openCalls.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  function pruneOpenCalls(clientId) {
    const prefix = openPrefix(clientId);
    const mine = [];
    for (const key of openCalls.keys()) if (key.startsWith(prefix)) mine.push(key);
    while (mine.length > OPEN_CALLS_PER_CLIENT) openCalls.delete(mine.shift());
    while (openCalls.size > OPEN_CALLS_MAX_TOTAL) {
      const oldest = openCalls.keys().next().value;
      if (oldest === undefined) break;
      openCalls.delete(oldest);
    }
  }

  function openWordsFor(clientId, editorEpoch) {

    const prefix = openPrefix(clientId);
    const epoch = nonNegativeInt(editorEpoch, 0);
    let words = [];
    let newest = -1;
    for (const [key, entry] of openCalls) {
      if (!key.startsWith(prefix)) continue;
      if (entry.editorEpoch !== epoch) continue;
      if (!Array.isArray(entry.words) || entry.words.length === 0) continue;
      const at = entry.createdAtMs || 0;
      if (at >= newest) {
        newest = at;
        words = entry.words;
      }
    }
    return words;
  }

  function schedule(job, waitMs) {
    job.scheduledTimer = setTimer(() => {
      job.scheduledTimer = null;
      dispatch(job);
    }, Math.max(0, waitMs));
  }

  function cancel(clientId, payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const requestId = cleanString(p.requestId);
    if (!requestId) return Promise.resolve({ accepted: false, abort: false, reason: "requestId required" });
    for (const [key, lane] of lanes) {
      if (!key.startsWith(`${clientId}|`)) continue;
      if (lane.pending && lane.pending.req.requestId === requestId) {
        const job = lane.pending;
        lane.pending = null;
        settle(job, predictionResult("cancelled", { ...echoFields(job.payload, job.req), reason: "cancelled by client" }));
        return Promise.resolve({ accepted: true, abort: true, abortProbe: "not-dispatched", reason: "pending request dropped before dispatch" });
      }
      if (lane.active && lane.active.req.requestId === requestId) {
        lane.active.cancelled = true;
        if (lane.active.scheduledTimer) {

          const job = lane.active;
          clearTimer(job.scheduledTimer);
          job.scheduledTimer = null;
          settle(job, predictionResult("cancelled", { ...echoFields(job.payload, job.req), reason: "cancelled by client" }));
          releaseLane(job);
          return Promise.resolve({ accepted: true, abort: true, abortProbe: "not-dispatched", reason: "deferred request dropped before dispatch" });
        }
        if (lane.active.route === "jev") {

          stopBackend(lane.active);
          return Promise.resolve({ accepted: true, abort: true, abortProbe: "aborted", reason: "ranking call aborted" });
        }
        return bridge
          .request(INPUT_PREDICTION_METHODS.cancel, { requestId, clientId })
          .then((raw) => {
            const r = raw && typeof raw === "object" ? raw : {};

            return { accepted: true, abort: r.abort === true, abortProbe: cleanString(r.abortProbe) || undefined, reason: cleanString(r.reason) || undefined };
          })
          .catch((err) => ({ accepted: true, abort: false, abortProbe: "unobserved", reason: `result suppressed; upstream cancel failed: ${err && err.message ? err.message : err}` }));
      }
    }
    return Promise.resolve({ accepted: false, abort: false, reason: "no such request for this client" });
  }

  let testSeq = 0;

  async function test(clientId, payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const identity = identityFor(clientId);
    const modelChoice = cleanString(p.modelChoice) || "default";

    const clientRequestId = typeof p.requestId === "string" && REQUEST_ID_RE.test(p.requestId) ? p.requestId : "";

    const asked = cleanString(p.job);
    const job = INPUT_PREDICTION_TEST_JOBS.includes(asked) ? asked : (jevAnswer ? "ranking" : "replies");

    const jobRoute = job === "ranking" ? "jev" : "bridge";

    const knownRoute = job === "ranking" ? jevRoute : (openReplyRouteByClient.get(clientId) || null);
    const testShape = (r) => {
      const status = typeof r.status === "string" ? r.status : "error";
      const reason = cleanString(r.reason) || undefined;
      return {
        requestId: clientRequestId,
        ...identityFields(identity),

        status,
        job,

        reasonCode: testReasonCode(status, reason),
        provider: cleanString(r.provider) || (knownRoute ? knownRoute.provider : ""),
        model: cleanString(r.model) || (knownRoute ? knownRoute.model : ""),
        elapsedMs: Number.isFinite(r.elapsedMs) ? r.elapsedMs : 0,
        candidates: Array.isArray(r.candidates) ? r.candidates : [],
        usage: normalizeUsage(r.usage),
        reason,
      };
    };
    if (!REQUEST_ID_RE.test(modelChoice)) {
      return testShape({ status: "policy-denied", reason: "modelChoice is not a known choice id" });
    }
    if (identity.noSession) {
      return testShape({ status: "unavailable", reason: NO_SESSION_REASON });
    }
    if (phoneSessionMismatch(p, identity)) {
      return testShape({ status: "unavailable", reason: SESSION_MISMATCH_REASON });
    }

    if (jobRoute === "jev" && !jevAnswer) {
      return testShape({ status: "unavailable", reason: NO_TYPESAFE_KEY_REASON });
    }
    testSeq += 1;
    const requestId = `test-${testSeq}`;

    const testTimeoutMs = jobRoute === "jev"
      ? limits.timeoutMs
      : Math.max(limits.timeoutMs, openTimeoutMs + INPUT_PREDICTION_TEST_ROUND_TRIP_MARGIN_MS);
    const normalized = normalizePredictionRequest({
      ...INPUT_PREDICTION_TEST_EXAMPLE,
      requestId,
      modelChoice,
      timeoutMs: testTimeoutMs,
    });
    if (!normalized.ok) return testShape({ status: normalized.status, reason: normalized.reason });

    const testRequest = { ...normalized.value, timeoutMs: testTimeoutMs };
    const baseEcho = { requestId, editorEpoch: 0, draftRevision: 0, settingsRevision: 0, dictionaryRevision: 0 };
    try {
      const raw = await enqueue(clientId, { requestId }, testRequest, identity, `${clientId}|test`, baseEcho, "test", jobRoute);
      const result = testShape(raw && typeof raw === "object" ? raw : {});
      telemetry("prediction_test", result, { clientId });
      return result;
    } catch (err) {
      return testShape({ status: "error", reason: err && err.message ? String(err.message) : String(err) });
    }
  }

  async function modelAllow(clientId, payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const requestId = typeof p.requestId === "string" && REQUEST_ID_RE.test(p.requestId) ? p.requestId : "";
    const modelChoice = cleanString(p.modelChoice).trim();
    if (findForbiddenKey(p, { phone: true }) || !modelChoice || modelChoice === "default" || !REQUEST_ID_RE.test(modelChoice)) {
      return modelAllowResult(requestId, "policy-denied");
    }
    const identity = identityFor(clientId);
    if (identity.noSession || phoneSessionMismatch(p, identity)) return modelAllowResult(requestId, "error");
    try {
      const raw = await bridge.request(INPUT_PREDICTION_METHODS.modelAllow, {
        requestId,
        modelChoice,
        clientId,
        connectionId: identity.connectionId,
        agentId: identity.agentId || undefined,
        profileId: identity.profileId || undefined,
      });
      const r = raw && typeof raw === "object" ? raw : {};
      const result = modelAllowResult(requestId, r.status, r.activation);
      if (result.status === "saved") clearCache();
      emitDebug(INPUT_PREDICTION_DEBUG_CATEGORY, "prediction_model_allow", { clientId, modelChoice, status: result.status });
      return result;
    } catch {
      return modelAllowResult(requestId, "error");
    }
  }

  function onClientDisconnect(clientId) {
    for (const [key, lane] of Array.from(lanes.entries())) {
      if (!key.startsWith(`${clientId}|`)) continue;
      if (lane.pending) {
        settle(lane.pending, predictionResult("cancelled", { ...echoFields(lane.pending.payload, lane.pending.req), reason: "client disconnected" }));
        lane.pending = null;
      }
      if (lane.active) {
        const job = lane.active;
        job.cancelled = true;
        if (job.scheduledTimer) {
          clearTimer(job.scheduledTimer);
          job.scheduledTimer = null;
          settle(job, predictionResult("cancelled", { ...echoFields(job.payload, job.req), reason: "client disconnected" }));
        } else {
          const stopped = stopBackend(job);
          if (stopped) stopped.catch(() => {});
        }
      }
      lanes.delete(key);
    }
    for (const [key, entry] of Array.from(cache.entries())) {
      if (entry.clientId === clientId) cache.delete(key);
    }
    dropOpenCalls(clientId);
    openActiveByClient.delete(clientId);
    openReplyByClient.delete(clientId);
    clients.delete(clientId);
  }

  function clearCache() {
    cache.clear();

    openCalls.clear();
  }

  function snapshot() {
    return {
      ...stats,
      activeCount,
      openActive: openActiveTotal,
      openCalls: openCalls.size,
      cacheSize: cache.size,
      lanes: lanes.size,
      policyRevision,
      limits: { ...limits },
    };
  }

  return { capabilities, request, open, openWordsFor, cancel, test, modelAllow, onClientDisconnect, clearCache, snapshot };
}

module.exports = { INPUT_PREDICTION_SERVICE_DEFAULTS, INPUT_PREDICTION_DEBUG_CATEGORY, INPUT_PREDICTION_TEST_ROUND_TRIP_MARGIN_MS, INPUT_PREDICTION_TEST_JOBS, INPUT_PREDICTION_TEST_REASON_CODES, createInputPredictionService };
