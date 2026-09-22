const ABORT_SETTLE_GRACE_MS = 750;

const { INPUT_PREDICTION_LIMITS, INPUT_PREDICTION_METHODS, INPUT_PREDICTION_PER_WORD_RETIRED_REASON, INPUT_PREDICTION_PROTOCOL_VERSION, INPUT_PREDICTION_PURPOSE, normalizeUsage, policyRevisionOf, predictionResult } = require("../runtime/input-prediction-shared.cjs");
const { SILENT_INPUT_OPEN_LIMITS, SILENT_INPUT_OPEN_TEST_EXAMPLE, SILENT_INPUT_OPEN_TEST_LIMITS, buildOpenReplyMessages, normalizeOpenRequest, openReplyResult, classifyOpenReplyError, parseOpenReplyText } = require("../runtime/silent-input-open-reply.cjs");

const DEFAULT_CHOICE = "default";

function configuredOpenReplyRoute(config, identity = {}) {
  const agents = config && config.agents || {};
  const list = Array.isArray(agents.list) ? agents.list : [];
  const id = typeof identity.agentId === "string" ? identity.agentId.trim().toLowerCase() : "";
  const agent = id
    ? list.find((entry) => typeof entry.id === "string" && entry.id.trim().toLowerCase() === id)
    : list.find((entry) => entry.default === true) || list[0];
  const primary = (value) => typeof value === "string" ? value.trim()
    : value && typeof value.primary === "string" ? value.primary.trim() : "";
  const defaults = agents.defaults || {};
  let ref = primary(agent && agent.model) || primary(defaults.model);

  if (ref.includes("@")) ref = ref.slice(0, ref.lastIndexOf("@")).trim();
  if (!ref.includes("/")) {
    const aliases = defaults.models && typeof defaults.models === "object" ? defaults.models : {};
    const match = Object.entries(aliases).find(([, entry]) =>
      typeof entry?.alias === "string" && entry.alias.trim().toLowerCase() === ref.toLowerCase());
    if (!ref || !match) return null;
    ref = match[0];
  }
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash).trim().toLowerCase();
  const model = ref.slice(slash + 1).trim();
  return slash > 0 && provider && model ? { provider, model } : null;
}

function probeLlmCompleteOptions(fn) {
  if (typeof fn !== "function") {
    return { schema: false, signal: false, timeoutMs: false, probe: "unavailable" };
  }
  let source = "";
  try {
    source = Function.prototype.toString.call(fn);
  } catch {
    source = "";
  }

  if (!source || source.length < 200) {
    return { schema: false, signal: false, timeoutMs: false, probe: "opaque-wrapper" };
  }
  return {
    schema: /params\.(schema|responseFormat|jsonSchema|outputSchema)\b/.test(source),
    signal: /params\.signal\b/.test(source),
    timeoutMs: /params\.timeoutMs\b/.test(source),
    probe: "source-scan",
  };
}

function resolvePolicy(policy) {
  const raw = typeof policy === "function" ? policy() : policy;
  const obj = raw && typeof raw === "object" ? raw : {};
  const allowedModels = Array.isArray(obj.allowedModels)
    ? obj.allowedModels.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
    : [];
  return {
    allowModelOverride: obj.allowModelOverride === true,
    allowedModels,
  };
}

function resolveOptionSupport(optionSupport, llmComplete) {
  const raw = typeof optionSupport === "function" ? optionSupport() : optionSupport;
  if (raw && typeof raw === "object") {
    return {
      schema: raw.schema === true,
      signal: raw.signal === true,
      timeoutMs: raw.timeoutMs === true,
      probe: typeof raw.probe === "string" ? raw.probe : "injected",
    };
  }
  return probeLlmCompleteOptions(llmComplete);
}

function modelsFromPolicy(policy) {
  const models = [
    { id: DEFAULT_CHOICE, label: "Connection default", provider: "", model: "", isDefault: true },
  ];
  if (!policy.allowModelOverride) return models;
  for (const ref of policy.allowedModels) {
    const slash = ref.indexOf("/");
    const provider = slash > 0 ? ref.slice(0, slash) : "";
    const model = slash > 0 ? ref.slice(slash + 1) : ref;
    models.push({ id: ref, label: ref, provider, model, isDefault: false });
  }
  return models;
}

function createOpenclawInputPredictionAdapter(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const llmComplete = typeof o.llmComplete === "function" ? o.llmComplete : null;
  const now = typeof o.now === "function" ? o.now : () => Date.now();

  const active = new Map();

  const lastResolvedByIdentity = new Map();
  const identityKey = (agentId, profileId) =>
    `${typeof agentId === "string" ? agentId.trim() : ""}\u001f${typeof profileId === "string" ? profileId.trim() : ""}`;
  const activeKey = (clientId, requestId) => `${clientId || ""}|${requestId}`;

  let abortEvidence = "unobserved";
  const abortGraceMs = Number.isFinite(o.abortSettleGraceMs) ? Number(o.abortSettleGraceMs) : ABORT_SETTLE_GRACE_MS;
  const setTimer = typeof o.setTimeoutFn === "function" ? o.setTimeoutFn : setTimeout;
  const clearTimer = typeof o.clearTimeoutFn === "function" ? o.clearTimeoutFn : clearTimeout;

  function abortSupported(support) {
    return support.signal === true || abortEvidence === "observed";
  }

  function configuredRoute(identity) {
    const raw = typeof o.completionRoute === "function" ? o.completionRoute(identity) : o.completionRoute;
    if (raw && typeof raw === "object") {
      const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
      const model = typeof raw.model === "string" ? raw.model.trim() : "";
      if (provider && model) return { provider, model };
    }
    return null;
  }

  function observeAbort(promise, controller) {
    if (abortEvidence === "observed" || !promise || typeof promise.then !== "function") return;
    let settled = false;
    const timer = setTimer(() => {
      if (!settled && abortEvidence !== "observed") abortEvidence = "ignored";
    }, abortGraceMs);
    const onResolved = () => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      if (abortEvidence !== "observed") abortEvidence = "ignored";
    };
    const onRejected = (err) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      const reason = controller && controller.signal ? controller.signal.reason : undefined;
      const isAbort = Boolean(err) && (err.name === "AbortError" || (reason !== undefined && err === reason));
      if (isAbort) abortEvidence = "observed";
    };
    promise.then(onResolved, onRejected);
  }

  function capabilities(params = null) {
    const p = params && typeof params === "object" ? params : {};
    const lastResolved = lastResolvedByIdentity.get(identityKey(p.agentId, p.profileId)) || null;
    const policy = resolvePolicy(o.policy);
    const support = resolveOptionSupport(o.optionSupport, llmComplete);
    const supported = Boolean(llmComplete);
    const out = {
      protocolVersion: INPUT_PREDICTION_PROTOCOL_VERSION,
      supported,
      structuredOutput: supported && support.schema === true,
      abort: supported && abortSupported(support),

      openReply: supported,

      openReplyRoute: supported
        ? ((lastResolved && lastResolved.provider && lastResolved.model ? { ...lastResolved } : null)
          || configuredRoute(p))
        : null,
      policyRevision: policyRevisionOf(policy),
      limits: { ...INPUT_PREDICTION_LIMITS },
      models: modelsFromPolicy(policy),
      connectionDefault: lastResolved ? { ...lastResolved } : null,
      host: {
        kind: "openclaw",
        version: typeof o.hostVersion === "string" ? o.hostVersion : "",
        optionProbe: support.probe,
        abortProbe: support.signal === true ? support.probe : abortEvidence,
        timeoutOption: support.timeoutMs === true,
      },
    };
    if (!supported) out.unsupportedReason = "host runtime.llm.complete unavailable";
    return out;
  }

  function authorizeModelChoice(modelChoice) {
    if (!modelChoice || modelChoice === DEFAULT_CHOICE) return { ok: true, model: null };
    const policy = resolvePolicy(o.policy);
    if (!policy.allowModelOverride || !policy.allowedModels.includes(modelChoice)) {
      return { ok: false, reason: `model choice not authorized by host policy: ${modelChoice}` };
    }
    return { ok: true, model: modelChoice };
  }

  async function runCompletion(req, spec) {
    const messagesOf = spec.messages;
    const maxTokens = spec.maxTokens;
    const result = spec.result;
    const readText = spec.readText;

    const classify = spec.classify;
    const started = now();
    const echo = {
      requestId: req.requestId,
      provider: "",
      model: "",
    };
    if (!llmComplete) {
      return result("unavailable", { ...echo, reason: "host runtime.llm.complete unavailable" });
    }
    const authz = authorizeModelChoice(req.modelChoice);
    if (!authz.ok) {
      return result("policy-denied", { ...echo, reason: authz.reason });
    }
    const support = resolveOptionSupport(o.optionSupport, llmComplete);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const entry = { clientId: req.clientId, requestId: req.requestId, controller, cancelled: false, completion: null };
    const entryKey = req.requestId ? activeKey(req.clientId, req.requestId) : "";
    if (entryKey) active.set(entryKey, entry);
    const params = {
      messages: messagesOf(req),
      maxTokens,
      temperature: 0,
      purpose: INPUT_PREDICTION_PURPOSE,
    };
    if (req.agentId) params.agentId = req.agentId;
    if (authz.model) params.model = authz.model;
    if (controller) params.signal = controller.signal;
    if (support.timeoutMs) params.timeoutMs = req.timeoutMs;

    let timer = null;
    let timedOut = false;
    let completion = null;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => {
        timedOut = true;
        if (controller) controller.abort();
        if (controller) observeAbort(completion, controller);
        resolve(null);
      }, req.timeoutMs);
    });
    try {
      completion = llmComplete(params);
      entry.completion = completion;
      if (completion && typeof completion.catch === "function") completion.catch(() => {});
      const res = await Promise.race([completion, timeout]);
      const elapsedMs = Math.max(0, now() - started);
      if (entry.cancelled) {
        return result("cancelled", { ...echo, elapsedMs, reason: "cancelled by client" });
      }
      if (timedOut || res === null) {
        return result("timeout", { ...echo, elapsedMs, reason: `no completion within ${req.timeoutMs} ms` });
      }
      const provider = res && typeof res.provider === "string" ? res.provider : "";
      const model = res && typeof res.model === "string" ? res.model : "";
      if (provider || model) lastResolvedByIdentity.set(identityKey(req.agentId, req.profileId), { provider, model });
      const usage = normalizeUsage(res && res.usage);
      const text = res && typeof res.text === "string" ? res.text : "";
      if (!text.trim()) {
        return result("invalid-output", { ...echo, provider, model, elapsedMs, usage, reason: "empty completion" });
      }
      return readText(text, { ...echo, provider, model, elapsedMs, usage }, req);
    } catch (err) {
      const elapsedMs = Math.max(0, now() - started);
      if (entry.cancelled) {
        return result("cancelled", { ...echo, elapsedMs, reason: "cancelled by client" });
      }
      if (timedOut) {
        return result("timeout", { ...echo, elapsedMs, reason: `no completion within ${req.timeoutMs} ms` });
      }
      const classified = classify(err);
      return result(classified.status, { ...echo, elapsedMs, reason: classified.reason });
    } finally {
      if (timer) clearTimer(timer);
      if (entryKey && active.get(entryKey) === entry) active.delete(entryKey);
    }
  }

  async function request(params) {
    const p = params && typeof params === "object" ? params : {};
    return predictionResult("unavailable", {

      requestId: typeof p.requestId === "string" ? p.requestId.slice(0, 128) : "",
      reason: INPUT_PREDICTION_PER_WORD_RETIRED_REASON,
    });
  }

  async function open(params, ask = SILENT_INPUT_OPEN_LIMITS) {
    const normalized = normalizeOpenRequest(params);
    if (!normalized.ok) {
      return openReplyResult(normalized.status, {
        requestId: params && typeof params.requestId === "string" ? params.requestId : "",
        reason: normalized.reason,
      });
    }
    return runCompletion(normalized.value, {

      messages: (req) => buildOpenReplyMessages(req, ask),
      maxTokens: ask.maxTokens,
      result: openReplyResult,
      classify: classifyOpenReplyError,
      readText(text, base) {
        const parsed = parseOpenReplyText(text, ask);
        if (!parsed) {
          return openReplyResult("invalid-output", { ...base, reason: "output is not a JSON object" });
        }
        if (parsed.replies.length === 0 && parsed.words.length === 0) {
          return openReplyResult("invalid-output", {
            ...base,
            reason: `nothing usable (replies ${parsed.receivedReplies}/${parsed.rejectedReplies} rejected, words ${parsed.receivedWords}/${parsed.rejectedWords} rejected)`,
          });
        }
        return openReplyResult("ready", {
          ...base,
          replies: parsed.replies,
          words: parsed.words,
          rejectedReplies: parsed.rejectedReplies,
          rejectedWords: parsed.rejectedWords,
        });
      },
    });
  }

  function cancel(params) {
    const requestId = params && typeof params.requestId === "string" ? params.requestId : "";
    const clientId = params && typeof params.clientId === "string" ? params.clientId : "";
    const entry = requestId ? active.get(activeKey(clientId, requestId)) : null;
    if (!entry) {

      for (const other of active.values()) {
        if (other.requestId === requestId) {
          return { accepted: false, reason: "not the requesting client", abort: false };
        }
      }
      return { accepted: false, reason: "no active request", abort: false };
    }
    entry.cancelled = true;
    const support = resolveOptionSupport(o.optionSupport, llmComplete);
    if (entry.controller) {
      entry.controller.abort();
      if (entry.completion) observeAbort(entry.completion, entry.controller);
    }
    return { accepted: true, abort: abortSupported(support) };
  }

  async function test(params) {
    const p = params && typeof params === "object" ? params : {};

    const requestId = typeof p.requestId === "string" ? p.requestId : `test-${now()}`;
    if (!llmComplete) {
      return {
        requestId,
        status: "unavailable",
        provider: "",
        model: "",
        elapsedMs: 0,
        candidates: [],
        usage: null,
        reason: "host runtime.llm.complete unavailable",
      };
    }
    const result = await open({
      ...SILENT_INPUT_OPEN_TEST_EXAMPLE,
      requestId,
      clientId: typeof p.clientId === "string" ? p.clientId : "",
      agentId: typeof p.agentId === "string" ? p.agentId : "",
      profileId: typeof p.profileId === "string" ? p.profileId : "",
      modelChoice: typeof p.modelChoice === "string" && p.modelChoice.trim() ? p.modelChoice.trim() : DEFAULT_CHOICE,

      timeoutMs: p.timeoutMs,
    }, SILENT_INPUT_OPEN_TEST_LIMITS);
    const replies = Array.isArray(result.replies) ? result.replies : [];

    const status = result.status === "ready" && replies.length === 0 ? "invalid-output" : result.status;
    return {
      requestId,
      status,
      provider: result.provider,
      model: result.model,
      elapsedMs: result.elapsedMs,
      candidates: replies,
      usage: result.usage,
      reason: status === "invalid-output" && result.status === "ready" ? "no whole replies" : result.reason,
    };
  }

  function handle(method, params) {
    switch (method) {
      case INPUT_PREDICTION_METHODS.capabilities:
        return Promise.resolve(capabilities(params));
      case INPUT_PREDICTION_METHODS.request:
        return request(params);
      case INPUT_PREDICTION_METHODS.open:
        return open(params);
      case INPUT_PREDICTION_METHODS.cancel:
        return Promise.resolve(cancel(params));
      case INPUT_PREDICTION_METHODS.test:
        return test(params);
      default:
        return null;
    }
  }

  return { handle, capabilities, request, open, cancel, test, activeCount: () => active.size, abortEvidence: () => abortEvidence };
}

function isInputPredictionMethod(method) {
  return typeof method === "string" && method.startsWith("input.prediction.");
}

module.exports = { ABORT_SETTLE_GRACE_MS, configuredOpenReplyRoute, probeLlmCompleteOptions, createOpenclawInputPredictionAdapter, isInputPredictionMethod };
