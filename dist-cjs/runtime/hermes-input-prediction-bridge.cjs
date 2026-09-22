const { METHOD_NOT_FOUND_CODE } = require("../gateway/backend-contract.cjs");
const { INPUT_PREDICTION_LIMITS, INPUT_PREDICTION_METHODS, INPUT_PREDICTION_PROTOCOL_VERSION, INPUT_PREDICTION_STATUSES, normalizeCandidateWord, normalizePredictionRequest, normalizeUsage, predictionResult, validateCandidates } = require("./input-prediction-shared.cjs");
const { SILENT_INPUT_OPEN_LIMITS, normalizeOpenRequest, normalizeWholeReply, openReplyResult } = require("./silent-input-open-reply.cjs");

const LINK_INPUT_PREDICTION_METHODS = Object.freeze({
  capabilities: INPUT_PREDICTION_METHODS.capabilities,
  request: INPUT_PREDICTION_METHODS.request,
  cancel: INPUT_PREDICTION_METHODS.cancel,
  test: INPUT_PREDICTION_METHODS.test,
  open: INPUT_PREDICTION_METHODS.open,
});

const LINK_INPUT_PREDICTION_GRACE_MS = 500;

const UNSUPPORTED_REASON = "hermes parent exposes no input.prediction.* handlers";

function isMethodNotFound(err) {
  if (!err) return false;
  if (err.code === METHOD_NOT_FOUND_CODE) return true;
  const message = typeof err.message === "string" ? err.message : "";
  return /method not found|unknown method|unsupported method/i.test(message);
}

function cleanString(value) {
  return typeof value === "string" ? value : "";
}

function resolveTestTimeoutMs(value) {
  if (!Number.isFinite(value)) return INPUT_PREDICTION_LIMITS.timeoutMs;
  const ms = Math.round(value);
  if (ms < 200) return 200;
  if (ms > SILENT_INPUT_OPEN_LIMITS.maxTimeoutMs) return SILENT_INPUT_OPEN_LIMITS.maxTimeoutMs;
  return ms;
}

function normalizeLinkResult(raw, fallbackRequestId, req) {
  const r = raw && typeof raw === "object" ? raw : {};
  const status = INPUT_PREDICTION_STATUSES.includes(r.status) ? r.status : "error";

  const validated = status === "ready"
    ? validateCandidates(r.candidates, req)
    : { candidates: [], rejected: 0, received: 0 };
  const finalStatus = status === "ready" && validated.candidates.length === 0
    ? "invalid-output"
    : status;
  return predictionResult(finalStatus, {
    requestId: cleanString(r.requestId) || fallbackRequestId,
    candidates: validated.candidates,
    provider: cleanString(r.provider),
    model: cleanString(r.model),
    elapsedMs: Number.isFinite(r.elapsedMs) ? r.elapsedMs : 0,
    usage: normalizeUsage(r.usage),
    reason: finalStatus === "invalid-output" && status === "ready"
      ? "parent returned no valid candidates after re-validation"
      : (cleanString(r.reason) || undefined),
    rejectedCandidates: validated.rejected,
    ...identityEcho(req),
  });
}

function identityEcho(params) {
  const p = params && typeof params === "object" ? params : {};
  return { agentId: cleanString(p.agentId).trim(), profileId: cleanString(p.profileId).trim() };
}

function normalizeOpenReplyRoute(raw) {
  if (!raw || typeof raw !== "object") return null;
  const provider = cleanString(raw.provider).trim();
  const model = cleanString(raw.model).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

function sanitizeOpenReplies(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const reply = normalizeWholeReply(raw);
    if (!reply) continue;
    const key = reply.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reply);
  }
  return out.slice(0, SILENT_INPUT_OPEN_LIMITS.maxReplies);
}

function sanitizeOpenWords(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const word = normalizeCandidateWord(raw);
    if (!word) continue;
    if (seen.has(word.key)) continue;
    seen.add(word.key);
    out.push(word.display);
  }
  return out.slice(0, SILENT_INPUT_OPEN_LIMITS.maxWords);
}

function createHermesInputPredictionTranslators(opts) {
  const link = opts && opts.link;
  if (!link || typeof link.request !== "function") {
    throw new Error("hermes input prediction translators require a control link with request()");
  }

  async function capabilities(params) {
    const p = params && typeof params === "object" ? params : {};

    const payload = {
      clientId: cleanString(p.clientId),
      connectionId: cleanString(p.connectionId),
      profileId: cleanString(p.profileId),
    };
    try {
      const raw = await link.request(LINK_INPUT_PREDICTION_METHODS.capabilities, payload);
      const r = raw && typeof raw === "object" ? raw : {};
      return {
        protocolVersion: INPUT_PREDICTION_PROTOCOL_VERSION,
        supported: r.supported === true,
        unsupportedReason: r.supported === true ? undefined : (cleanString(r.unsupportedReason) || "hermes plugin llm unavailable"),
        structuredOutput: r.structuredOutput === true,
        abort: r.abort === true,

        openReply: r.openReply === true,

        openReplyRoute: normalizeOpenReplyRoute(r.openReplyRoute),
        policyRevision: cleanString(r.policyRevision),
        limits: { ...INPUT_PREDICTION_LIMITS, ...(r.limits && typeof r.limits === "object" ? r.limits : {}) },
        models: Array.isArray(r.models) ? r.models : [],
        connectionDefault: r.connectionDefault && typeof r.connectionDefault === "object" ? r.connectionDefault : null,
        host: {
          kind: "hermes",
          version: cleanString(r.hermesVersion || (r.host && r.host.version)),
          llmApi: cleanString(r.llmApi || (r.host && r.host.llmApi)),
          auxiliaryTask: cleanString(r.auxiliaryTask || (r.host && r.host.auxiliaryTask)),
          abortProbe: cleanString(r.abortProbe) || "unobserved",
          profileId: payload.profileId,
          effectiveRoute: r.effectiveRoute && typeof r.effectiveRoute === "object"
            ? {
                provider: cleanString(r.effectiveRoute.provider),
                model: cleanString(r.effectiveRoute.model),
                source: cleanString(r.effectiveRoute.source),
              }
            : null,
        },
        ...identityEcho(params),
      };
    } catch (err) {
      if (isMethodNotFound(err)) {
        return {
          protocolVersion: INPUT_PREDICTION_PROTOCOL_VERSION,
          supported: false,
          unsupportedReason: UNSUPPORTED_REASON,
          structuredOutput: false,
          abort: false,
          openReplyRoute: null,
          policyRevision: "",
          limits: { ...INPUT_PREDICTION_LIMITS },
          models: [],
          connectionDefault: null,
          host: { kind: "hermes", version: "", llmApi: "", auxiliaryTask: "" },
          ...identityEcho(params),
        };
      }
      throw err;
    }
  }

  async function request(params) {
    const normalized = normalizePredictionRequest(params);
    const requestId = params && typeof params.requestId === "string" ? params.requestId : "";
    if (!normalized.ok) {
      return predictionResult(normalized.status, { requestId, reason: normalized.reason });
    }
    const req = normalized.value;
    try {
      const raw = await link.request(LINK_INPUT_PREDICTION_METHODS.request, req, {
        timeoutMs: req.timeoutMs + LINK_INPUT_PREDICTION_GRACE_MS,
      });
      return normalizeLinkResult(raw, req.requestId, req);
    } catch (err) {
      if (isMethodNotFound(err)) {
        return predictionResult("unavailable", { requestId: req.requestId, reason: UNSUPPORTED_REASON, ...identityEcho(req) });
      }
      const message = err && typeof err.message === "string" ? err.message : String(err);
      if (err && err.code === "link_overloaded") {

        return predictionResult("busy", { requestId: req.requestId, reason: "hermes control link admission limit reached" });
      }
      if (/timed out|timeout/i.test(message)) {
        return predictionResult("timeout", { requestId: req.requestId, reason: message.slice(0, 200), ...identityEcho(req) });
      }
      return predictionResult("error", { requestId: req.requestId, reason: message.slice(0, 200), ...identityEcho(req) });
    }
  }

  async function open(params) {
    const normalized = normalizeOpenRequest(params);
    if (!normalized.ok) {
      return openReplyResult(normalized.status, {
        requestId: params && typeof params.requestId === "string" ? params.requestId : "",
        reason: normalized.reason,
        ...identityEcho(params),
      });
    }
    const req = normalized.value;
    try {
      const raw = await link.request(LINK_INPUT_PREDICTION_METHODS.open, req, {
        timeoutMs: req.timeoutMs + LINK_INPUT_PREDICTION_GRACE_MS,
      });
      const r = raw && typeof raw === "object" ? raw : {};
      const status = INPUT_PREDICTION_STATUSES.includes(r.status) ? r.status : "error";
      return openReplyResult(status, {
        requestId: cleanString(r.requestId) || req.requestId,

        replies: sanitizeOpenReplies(r.replies),
        words: sanitizeOpenWords(r.words),
        provider: cleanString(r.provider),
        model: cleanString(r.model),
        elapsedMs: Number.isFinite(r.elapsedMs) ? r.elapsedMs : 0,
        usage: normalizeUsage(r.usage),
        reason: cleanString(r.reason) || undefined,
        ...identityEcho(req),
      });
    } catch (err) {
      const message = err && typeof err.message === "string" ? err.message : String(err);
      if (isMethodNotFound(err)) {
        return openReplyResult("unavailable", { requestId: req.requestId, reason: UNSUPPORTED_REASON, ...identityEcho(req) });
      }
      if (err && err.code === "link_overloaded") {
        return openReplyResult("busy", { requestId: req.requestId, reason: "hermes control link admission limit reached" });
      }
      if (/timed out|timeout/i.test(message)) {
        return openReplyResult("timeout", { requestId: req.requestId, reason: message.slice(0, 200), ...identityEcho(req) });
      }
      return openReplyResult("error", { requestId: req.requestId, reason: message.slice(0, 200), ...identityEcho(req) });
    }
  }

  async function cancel(params) {
    const p = params && typeof params === "object" ? params : {};
    const payload = {
      requestId: cleanString(p.requestId),
      clientId: cleanString(p.clientId),
    };
    try {
      const raw = await link.request(LINK_INPUT_PREDICTION_METHODS.cancel, payload);
      const r = raw && typeof raw === "object" ? raw : {};
      return {
        accepted: r.accepted === true,

        abort: r.abort === true,

        abortProbe: cleanString(r.abortProbe) || "unobserved",
        reason: cleanString(r.reason) || undefined,
      };
    } catch (err) {
      if (isMethodNotFound(err)) return { accepted: false, abort: false, abortProbe: "unobserved", reason: UNSUPPORTED_REASON };
      return { accepted: false, abort: false, abortProbe: "unobserved", reason: (err && err.message) || String(err) };
    }
  }

  async function test(params) {
    const p = params && typeof params === "object" ? params : {};

    const timeoutMs = resolveTestTimeoutMs(p.timeoutMs);
    const payload = {
      clientId: cleanString(p.clientId),
      connectionId: cleanString(p.connectionId),
      profileId: cleanString(p.profileId),
      modelChoice: cleanString(p.modelChoice) || "default",
      timeoutMs,
    };

    if (cleanString(p.requestId)) payload.requestId = cleanString(p.requestId);
    try {
      const raw = await link.request(LINK_INPUT_PREDICTION_METHODS.test, payload, {
        timeoutMs: timeoutMs + LINK_INPUT_PREDICTION_GRACE_MS,
      });
      const r = raw && typeof raw === "object" ? raw : {};
      const status = INPUT_PREDICTION_STATUSES.includes(r.status) ? r.status : "error";
      return {

        requestId: cleanString(r.requestId) || payload.requestId || "",
        status,
        provider: cleanString(r.provider),
        model: cleanString(r.model),
        elapsedMs: Number.isFinite(r.elapsedMs) ? r.elapsedMs : 0,
        candidates: Array.isArray(r.candidates) ? r.candidates.filter((c) => typeof c === "string") : [],
        usage: normalizeUsage(r.usage),
        reason: cleanString(r.reason) || undefined,
        ...identityEcho(p),
      };
    } catch (err) {
      const requestId = payload.requestId || "";
      const message = err && typeof err.message === "string" ? err.message : String(err);
      const failed = (status, reason) => ({
        requestId, status, provider: "", model: "", elapsedMs: 0, candidates: [], usage: null, reason, ...identityEcho(p),
      });
      if (isMethodNotFound(err)) return failed("unavailable", UNSUPPORTED_REASON);
      if (err && err.code === "link_overloaded") {

        return failed("busy", "hermes control link admission limit reached");
      }

      if (/timed out|timeout/i.test(message)) return failed("timeout", message.slice(0, 200));
      return failed("error", message.slice(0, 200));
    }
  }

  return {
    [LINK_INPUT_PREDICTION_METHODS.capabilities]: capabilities,
    [LINK_INPUT_PREDICTION_METHODS.request]: request,
    [LINK_INPUT_PREDICTION_METHODS.cancel]: cancel,
    [LINK_INPUT_PREDICTION_METHODS.test]: test,
    [LINK_INPUT_PREDICTION_METHODS.open]: open,
  };
}

module.exports = { LINK_INPUT_PREDICTION_METHODS, LINK_INPUT_PREDICTION_GRACE_MS, resolveTestTimeoutMs, createHermesInputPredictionTranslators };
