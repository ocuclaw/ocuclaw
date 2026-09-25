const ABORT_SETTLE_GRACE_MS = 750;

const { INPUT_PREDICTION_LIMITS, INPUT_PREDICTION_METHODS, INPUT_PREDICTION_MODEL_CHOICE_RE, INPUT_PREDICTION_MODEL_LIST_CAP, INPUT_PREDICTION_PER_WORD_RETIRED_REASON, INPUT_PREDICTION_PROTOCOL_VERSION, INPUT_PREDICTION_PURPOSE, modelAllowResult, normalizeUsage, policyRevisionOf, predictionResult, replyModelSpeedFacts } = require("../runtime/input-prediction-shared.cjs");
const { SILENT_INPUT_OPEN_LIMITS, SILENT_INPUT_OPEN_TEST_EXAMPLE, SILENT_INPUT_OPEN_TEST_LIMITS, buildOpenReplyMessages, normalizeOpenRequest, openReplyResult, classifyOpenReplyError, openReplyFailureClass, parseOpenReplyText } = require("../runtime/silent-input-open-reply.cjs");

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

function canonicalModelRef(raw, aliases) {
  let ref = typeof raw === "string" ? raw.trim() : "";
  if (ref.includes("@")) ref = ref.slice(0, ref.lastIndexOf("@")).trim();
  if (!ref) return "";
  if (!ref.includes("/")) {
    const match = Object.entries(aliases).find(([, entry]) =>
      typeof entry?.alias === "string" && entry.alias.trim().toLowerCase() === ref.toLowerCase());
    if (!match) return "";
    ref = match[0].trim();
  }
  const slash = ref.indexOf("/");
  const provider = slash > 0 ? ref.slice(0, slash).trim().toLowerCase() : "";
  const model = slash > 0 ? ref.slice(slash + 1).trim() : "";
  const out = provider && model ? `${provider}/${model}` : "";
  return out && INPUT_PREDICTION_MODEL_CHOICE_RE.test(out) ? out : "";
}

function configuredReplyModels(config, identity = {}) {
  const agents = config && config.agents || {};
  const defaults = agents.defaults || {};
  const aliases = defaults.models && typeof defaults.models === "object" && !Array.isArray(defaults.models)
    ? defaults.models : {};
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const ref = canonicalModelRef(raw, aliases);
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  };
  const addRoute = (value) => {
    if (typeof value === "string") return add(value);
    if (!value || typeof value !== "object") return;
    add(value.primary);
    if (Array.isArray(value.fallbacks)) for (const entry of value.fallbacks) add(entry);
  };
  const list = Array.isArray(agents.list) ? agents.list : [];
  const id = typeof identity.agentId === "string" ? identity.agentId.trim().toLowerCase() : "";
  const agent = id
    ? list.find((entry) => entry && typeof entry.id === "string" && entry.id.trim().toLowerCase() === id)
    : list.find((entry) => entry && entry.default === true) || list[0];
  if (agent) addRoute(agent.model);
  addRoute(defaults.model);
  for (const key of Object.keys(aliases)) add(key);
  const providers = config && config.models && config.models.providers;
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    for (const provider of Object.keys(providers)) {
      const block = providers[provider];
      const models = block && Array.isArray(block.models) ? block.models : [];
      for (const entry of models) {
        const modelId = typeof entry === "string" ? entry : entry && typeof entry.id === "string" ? entry.id : "";
        if (modelId.trim()) add(`${provider}/${modelId.trim()}`);
      }
    }
  }

  return out;
}

function isSeparateAgentRuntime(entry) {
  const runtime = entry && typeof entry === "object" ? entry.agentRuntime : null;
  const id = runtime && typeof runtime === "object" && typeof runtime.id === "string"
    ? runtime.id.trim().toLowerCase() : "";
  return Boolean(id) && !["auto", "default", "openclaw", "pi"].includes(id);
}

function runtimeOnlyModelMatcher(config, identity = {}) {
  const agents = config && config.agents || {};
  const defaults = agents.defaults || {};
  const aliases = defaults.models && typeof defaults.models === "object" && !Array.isArray(defaults.models)
    ? defaults.models : {};
  const explicit = new Set();
  const wholeProviders = new Set();
  const add = (raw) => {
    const ref = canonicalModelRef(raw, aliases);
    if (ref) explicit.add(ref);
  };
  const fromMap = (map) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    for (const [key, entry] of Object.entries(map)) if (isSeparateAgentRuntime(entry)) add(key);
  };
  fromMap(aliases);
  const list = Array.isArray(agents.list) ? agents.list : [];
  const id = typeof identity.agentId === "string" ? identity.agentId.trim().toLowerCase() : "";
  const agent = id
    ? list.find((entry) => entry && typeof entry.id === "string" && entry.id.trim().toLowerCase() === id)
    : list.find((entry) => entry && entry.default === true) || list[0];
  if (agent) fromMap(agent.models);
  const providers = config && config.models && config.models.providers;
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    for (const provider of Object.keys(providers)) {
      const block = providers[provider];
      if (isSeparateAgentRuntime(block)) {
        wholeProviders.add(provider.trim().toLowerCase());
        continue;
      }
      const models = block && Array.isArray(block.models) ? block.models : [];
      for (const entry of models) {
        const modelId = typeof entry === "string" ? entry : entry && typeof entry.id === "string" ? entry.id : "";
        if (modelId.trim() && isSeparateAgentRuntime(entry)) add(`${provider}/${modelId.trim()}`);
      }
    }
  }
  return (raw) => {
    const ref = canonicalModelRef(raw, aliases);
    if (!ref) return false;
    return explicit.has(ref) || wholeProviders.has(ref.slice(0, ref.indexOf("/")));
  };
}

function configuredModelOutputCost(config, ref) {
  const slash = typeof ref === "string" ? ref.indexOf("/") : -1;
  if (slash <= 0) return null;
  const provider = ref.slice(0, slash).trim().toLowerCase();
  const model = ref.slice(slash + 1).trim();
  const providers = config && config.models && config.models.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
  for (const key of Object.keys(providers)) {
    if (key.trim().toLowerCase() !== provider) continue;
    const block = providers[key];
    const models = block && Array.isArray(block.models) ? block.models : [];
    for (const entry of models) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() !== model) continue;
      const out = entry.cost && typeof entry.cost === "object" ? entry.cost.output : undefined;
      if (typeof out === "number" && Number.isFinite(out) && out >= 0) return out;
    }
  }
  return null;
}

function nodeFs() {
  const runtime = globalThis;
  const proc = runtime.process;
  try {
    if (!proc || typeof proc.getBuiltinModule !== "function") return { fs: null, path: null, entry: "" };
    return { fs: proc.getBuiltinModule("node:fs"), path: proc.getBuiltinModule("node:path"), entry: Array.isArray(proc.argv) ? proc.argv[1] : "" };
  } catch {
    return { fs: null, path: null, entry: "" };
  }
}

function bundledCatalogOutputCosts(hostRoot) {
  const costs = new Map();
  const { fs, path } = nodeFs();
  const dir = fs && typeof hostRoot === "string" && hostRoot ? path.join(hostRoot, "dist", "extensions") : "";
  if (!dir) return costs;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return costs;
  }
  for (const name of names) {
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, name, "openclaw.plugin.json"), "utf8"));
    } catch {
      continue;
    }
    const providers = manifest && manifest.modelCatalog && manifest.modelCatalog.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
    for (const provider of Object.keys(providers)) {
      const models = providers[provider] && Array.isArray(providers[provider].models) ? providers[provider].models : [];
      for (const entry of models) {
        if (!entry || typeof entry.id !== "string") continue;
        const out = entry.cost && typeof entry.cost === "object" ? entry.cost.output : undefined;
        const ref = `${provider.trim().toLowerCase()}/${entry.id.trim()}`.toLowerCase();
        if (typeof out === "number" && Number.isFinite(out) && out >= 0 && !costs.has(ref)) costs.set(ref, out);
      }
    }
  }
  return costs;
}

function findOpenclawPackageRoot() {
  const { fs, path, entry } = nodeFs();
  if (!fs || typeof entry !== "string") return "";
  let dir = "";
  try {
    dir = path.dirname(fs.realpathSync(entry));
  } catch {
    return "";
  }
  for (let i = 0; i < 8 && dir; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg && pkg.name === "openclaw") return dir;
    } catch {

    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function createReplyModelPriceLookup(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  let bundled = null;
  const bundledCosts = () => {
    if (bundled) return bundled;
    const root = typeof o.hostRoot === "string" ? o.hostRoot : findOpenclawPackageRoot();
    bundled = bundledCatalogOutputCosts(root);
    return bundled;
  };
  return (ref) => {
    if (typeof ref !== "string" || !ref.includes("/")) return null;
    const config = typeof o.getConfig === "function" ? o.getConfig() : o.config;
    const own = configuredModelOutputCost(config, ref);
    if (own !== null) return own;
    const hit = bundledCosts().get(ref.trim().toLowerCase());
    return typeof hit === "number" ? hit : null;
  };
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

    anyModel: obj.allowModelOverride === true
      && (!Array.isArray(obj.allowedModels) || allowedModels.includes("*")),
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

function policyAllows(policy, ref, configured) {
  if (!policy.allowModelOverride) return false;
  if (policy.allowedModels.includes(ref)) return true;

  return policy.anyModel === true && configured.includes(ref);
}

function modelsFromPolicy(policy, configured = [], chatRef = "", isRuntimeOnly = () => false, facts = {}) {
  const usable = typeof facts.usable === "function" ? facts.usable : () => null;
  const speed = typeof facts.speed === "function" ? facts.speed : () => ({});
  const first = { id: DEFAULT_CHOICE, label: chatRef || "Chat model", provider: "", model: "", isDefault: true, allowed: true, current: true };
  if (chatRef && isRuntimeOnly(chatRef)) first.callable = false;
  if (chatRef) Object.assign(first, speed(chatRef));
  const models = [first];
  const seen = new Set([DEFAULT_CHOICE]);
  const push = (ref, listedByPolicy) => {
    if (models.length >= INPUT_PREDICTION_MODEL_LIST_CAP) return;
    if (!ref || ref === "*" || seen.has(ref) || !INPUT_PREDICTION_MODEL_CHOICE_RE.test(ref)) return;
    if (isRuntimeOnly(ref)) return;
    if (ref === chatRef && !listedByPolicy) return;
    const slash = ref.indexOf("/");
    const provider = slash > 0 ? ref.slice(0, slash) : "";
    const model = slash > 0 ? ref.slice(slash + 1) : ref;
    if (usable(ref, provider) === false) return;
    seen.add(ref);
    models.push({ id: ref, label: ref, provider, model, isDefault: false, allowed: policyAllows(policy, ref, configured), current: false, ...speed(ref) });
  };
  if (policy.allowModelOverride) for (const ref of policy.allowedModels) push(ref, true);
  for (const ref of configured) push(ref, false);
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

  function configuredModels(identity) {
    try {
      const raw = typeof o.configuredModels === "function" ? o.configuredModels(identity || {}) : o.configuredModels;
      return Array.isArray(raw) ? raw.filter((ref) => typeof ref === "string" && INPUT_PREDICTION_MODEL_CHOICE_RE.test(ref)) : [];
    } catch {
      return [];
    }
  }

  function runtimeOnlyMatcher(identity) {
    if (typeof o.runtimeOnlyModel !== "function") return () => false;
    return (ref) => {
      try {
        return o.runtimeOnlyModel(ref, identity || {}) === true;
      } catch {
        return false;
      }
    };
  }

  const authByProvider = new Map();
  const authInflight = new Map();
  const authTtlMs = Number.isFinite(o.authTtlMs) ? Number(o.authTtlMs) : 30000;
  const authTimeoutMs = Number.isFinite(o.authTimeoutMs) ? Number(o.authTimeoutMs) : 2500;

  function lookupProviderAuth(provider) {
    if (typeof o.providerAuth !== "function") return Promise.resolve(null);
    const pending = authInflight.get(provider);
    if (pending) return pending;
    const run = new Promise((resolve) => {
      const timer = setTimer(() => resolve(null), authTimeoutMs);
      Promise.resolve()
        .then(() => o.providerAuth(provider))
        .then((value) => resolve(value === true ? true : value === false ? false : null), () => resolve(null))
        .finally(() => clearTimer(timer));
    }).then((usable) => {
      authByProvider.set(provider, { usable, at: now() });
      authInflight.delete(provider);
      return usable;
    });
    authInflight.set(provider, run);
    return run;
  }

  async function refreshProviderAuth(identity) {
    if (typeof o.providerAuth !== "function") return;
    const policy = resolvePolicy(o.policy);
    const refs = [...configuredModels(identity), ...(policy.allowModelOverride ? policy.allowedModels : [])];
    const providers = new Set();
    for (const ref of refs) {
      const slash = typeof ref === "string" ? ref.indexOf("/") : -1;
      if (slash > 0) providers.add(ref.slice(0, slash).trim().toLowerCase());
    }
    const stale = [...providers].filter((provider) => {
      const hit = authByProvider.get(provider);
      return !hit || now() - hit.at >= authTtlMs;
    });
    await Promise.all(stale.map((provider) => lookupProviderAuth(provider)));
  }

  function modelFacts(identity) {
    const exempt = (ref) => {
      if (typeof o.authExemptModel !== "function") return false;
      try {
        return o.authExemptModel(ref, identity || {}) === true;
      } catch {
        return false;
      }
    };
    return {
      usable: (ref, provider) => {
        if (!provider || exempt(ref)) return null;
        const hit = authByProvider.get(String(provider).trim().toLowerCase());
        return hit ? hit.usable : null;
      },
      speed: (ref) => {
        let cost = null;
        if (typeof o.modelPrice === "function") {
          try {
            cost = o.modelPrice(ref, identity || {});
          } catch {
            cost = null;
          }
        }
        const slash = typeof ref === "string" ? ref.indexOf("/") : -1;
        return replyModelSpeedFacts(slash > 0 ? ref.slice(slash + 1) : ref, cost);
      },
    };
  }

  function chatModelRef(identity) {
    const route = configuredRoute(identity);
    if (route) return `${route.provider}/${route.model}`;
    const last = lastResolvedByIdentity.get(identityKey(identity && identity.agentId, identity && identity.profileId));
    return last && last.provider && last.model ? `${last.provider}/${last.model}` : "";
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
      models: modelsFromPolicy(policy, configuredModels(p), chatModelRef(p), runtimeOnlyMatcher(p), modelFacts(p)),
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

  function authorizeModelChoice(modelChoice, identity = {}) {
    if (!modelChoice || modelChoice === DEFAULT_CHOICE) return { ok: true, model: null };
    const policy = resolvePolicy(o.policy);
    if (!policyAllows(policy, modelChoice, policy.anyModel ? configuredModels(identity) : [])) {
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
    const authz = authorizeModelChoice(req.modelChoice, req);
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

      const log = o.logger && typeof o.logger.info === "function" ? o.logger : null;
      if (log) {
        try {
          log.info(`[ocuclaw] input prediction completion ${req.requestId || "-"}: ${classified.status} ${classified.reason} (${openReplyFailureClass(err)})`);
        } catch {

        }
      }
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

  async function capabilitiesFresh(params = null) {
    const p = params && typeof params === "object" ? params : {};
    try {
      await refreshProviderAuth(p);
    } catch {

    }
    return capabilities(params);
  }

  function handle(method, params) {
    switch (method) {
      case INPUT_PREDICTION_METHODS.capabilities:
        return capabilitiesFresh(params);
      case INPUT_PREDICTION_METHODS.request:
        return request(params);
      case INPUT_PREDICTION_METHODS.open:
        return open(params);
      case INPUT_PREDICTION_METHODS.cancel:
        return Promise.resolve(cancel(params));
      case INPUT_PREDICTION_METHODS.test:
        return test(params);
      case INPUT_PREDICTION_METHODS.modelAllow:
        return modelAllow(params);
      default:
        return null;
    }
  }

  async function modelAllow(params) {
    const p = params && typeof params === "object" ? params : {};
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    const choice = typeof p.modelChoice === "string" ? p.modelChoice.trim() : "";
    if (!choice || choice === DEFAULT_CHOICE || !INPUT_PREDICTION_MODEL_CHOICE_RE.test(choice)) {
      return modelAllowResult(requestId, "policy-denied");
    }
    const listed = (await capabilitiesFresh(p)).models.find((entry) => entry.id === choice);
    if (!listed || listed.allowed !== false) return modelAllowResult(requestId, "policy-denied");
    const log = o.logger && typeof o.logger.info === "function" ? o.logger : null;
    if (typeof o.allowModel !== "function") {
      if (log) log.info(`[ocuclaw] input prediction model allow ${choice}: no config writer`);
      return modelAllowResult(requestId, "error");
    }
    try {
      const out = await o.allowModel(choice);
      const r = out && typeof out === "object" ? out : {};
      const result = modelAllowResult(requestId, r.status, r.activation);
      if (log) log.info(`[ocuclaw] input prediction model allow ${choice}: ${result.status}`);
      return result;
    } catch {
      if (log) log.info(`[ocuclaw] input prediction model allow ${choice}: error`);
      return modelAllowResult(requestId, "error");
    }
  }

  return { handle, capabilities, capabilitiesFresh, request, open, cancel, test, modelAllow, activeCount: () => active.size, abortEvidence: () => abortEvidence };
}

function isInputPredictionMethod(method) {
  return typeof method === "string" && method.startsWith("input.prediction.");
}

module.exports = { ABORT_SETTLE_GRACE_MS, configuredOpenReplyRoute, configuredReplyModels, runtimeOnlyModelMatcher, configuredModelOutputCost, bundledCatalogOutputCosts, createReplyModelPriceLookup, probeLlmCompleteOptions, createOpenclawInputPredictionAdapter, isInputPredictionMethod };
