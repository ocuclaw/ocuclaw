const { configuredOpenReplyRoute, configuredReplyModels } = require("../gateway/input-prediction-openclaw.cjs");
const { saveInputPredictionModelAllow, registerLiveModelPolicy, pluginLlmPolicy } = require("../setup/optional-credential-store.cjs");
const { planOptionalSetupActivation } = require("../setup/optional-activation-policy.cjs");
const identity = (s     , out     ) => out?.provider === s.provider && out?.model === s.model;

const permitted = (policy     , ref        ) => policy?.allowModelOverride === true
  && (!Array.isArray(policy.allowedModels) || policy.allowedModels.includes('*') || policy.allowedModels.includes(ref));
const sameList = (a       , b       ) => a.length === b.length && a.every((x, i) => x === b[i]);

async function revokeCardModelAllow(api     , undo     ) {
  const configApi = api?.runtime?.config;
  if (!undo || typeof undo.ref !== 'string' || typeof configApi?.current !== 'function' || typeof configApi?.mutateConfigFile !== 'function') return { status: 'error' };
  const prior           = Array.isArray(undo.models) ? undo.models : [];
  const plan = planOptionalSetupActivation(configApi.current(), api?.runtime?.version);
  await configApi.mutateConfigFile({ afterWrite: plan.afterWrite, mutate(draft     ) {
    const llm = pluginLlmPolicy(draft);
    if (!Array.isArray(llm.allowedModels)) return;
    const list = prior.includes(undo.ref) ? llm.allowedModels.slice() : llm.allowedModels.filter((x     ) => x !== undo.ref);
    if (!sameList(list, prior)) { llm.allowedModels = list; return; }
    if (Array.isArray(undo.models)) llm.allowedModels = list; else delete llm.allowedModels;
    if (undo.override === undefined) delete llm.allowModelOverride; else llm.allowModelOverride = undo.override;
  } });
  return { status: 'revoked' };
}
function withCheck(port     ) {
  port.check = async (settings     , scope     ) => {
    const controller = new AbortController();
    let timer     ;
    const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ ok: false, code: 'timeout' }); }, 10000); });
    try {
      const out      = await Promise.race([deadline, port.complete({ ...settings, scope, maxTokens: 8, system: 'Reply with pong.', messages: [{ role: 'user', content: 'ping' }], signal: controller.signal, deadlineMs: Date.now() + 10000 })]);

      return { ok: out?.ok !== false && identity(settings, out) && typeof out.text === 'string' && !!out.text.trim(), ...(identity(settings, out) ? {} : { code: out?.code || 'unavailable' }), ...(out?.usage ? { usage: out.usage } : {}) };
    } catch (_) { return { ok: false, code: 'unavailable' }; }
    finally { clearTimeout(timer); }
  };
  return port;
}
function createOpenClawProgramCardModelHost(api     ) {
  registerLiveModelPolicy(api);
  const current = () => api?.runtime?.config?.current?.() || api.config || {};
  const port      = {
    kind: 'openclaw',
    async listModels() {
      const cfg = current(), main = configuredOpenReplyRoute(cfg), rows        = [];
      for (const ref of configuredReplyModels(cfg)) {
        if (typeof ref !== 'string' || !/^[A-Za-z0-9._-]+\/[^\s/][^\s]*$/.test(ref)) continue;
        const slash = ref.indexOf('/'), provider = ref.slice(0, slash), model = ref.slice(slash + 1);
        try {
          const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({ provider, cfg });
          if (!auth?.apiKey && auth?.mode !== 'aws-sdk') continue;
        } catch (_) { continue; }
        rows.push({ ref, provider, model, label: ref, isMain: main?.provider === provider && main?.model === model });
      }
      return rows;
    },
    async complete(p     ) {
      const models = await port.listModels();
      if (!models.some((m     ) => m.provider === p.provider && m.model === p.model)) return { ok: false, code: 'unavailable' };
      const policy = await port.reasoningLevels(p.provider, p.model);
      if (p.reasoning != null && (!policy.enforceable || !policy.levels.includes(p.reasoning))) return { ok: false, code: 'unavailable' };
      const out = await api.runtime.llm.complete({ model: `${p.provider}/${p.model}`, reasoning: p.reasoning ?? undefined, systemPrompt: p.system, messages: p.messages, maxTokens: p.maxTokens, purpose: 'ocuclaw program card model', signal: p.signal });
      return out;
    },
    permits: async (ref        ) => permitted(current()?.plugins?.entries?.ocuclaw?.llm, ref),

    allowModel: async (ref        ) => {
      if (permitted(current()?.plugins?.entries?.ocuclaw?.llm, ref)) return { status: 'already_allowed' };

      let file      = null;
      const out      = await saveInputPredictionModelAllow(api, ref, { observe: (before     ) => { file = before; } });
      if (out?.status !== 'saved' || !file) return out;
      const changed = !(Array.isArray(file.models) && file.models.includes(ref)) || file.override !== true;
      return changed ? { ...out, undo: { ref, override: file.override, models: file.models } } : out;
    },
    revokeModel: (undo     ) => revokeCardModelAllow(api, undo),
    async reasoningLevels(provider        , model        ) {
      try {
        const p = await api.runtime.agent.resolveThinkingPolicy({ provider, model });
        const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra'];
        const levels = (Array.isArray(p?.levels) ? p.levels : []).filter((x     ) => allowed.includes(x));
        return { levels, defaultLevel: levels.includes(p.defaultLevel) ? p.defaultLevel : levels[0] ?? null, enforceable: levels.length > 0 };
      } catch (_) { return { levels: [], defaultLevel: null, enforceable: false }; }
    },
  };
  return withCheck(port);
}
function createHermesProgramCardModelHost(request     ) {
  let seq = 0;

  const hermesPermits = async (ref        , scope     ) => {
    try {
      const out = await request('program_card.model.permits', { ref, profileId: scope?.profileId });
      return typeof out?.permitted === 'boolean' ? out.permitted : null;
    } catch (_) { return null; }
  };
  const port      = {
    kind: 'hermes',
    listModels: (scope     ) => request('program_card.model.models', { profileId: scope?.profileId }),

    permits: async (ref        , scope     ) => (await hermesPermits(ref, scope)) === true,
    allowModel: async (ref        , scope     ) => {
      const permitted = await hermesPermits(ref, scope);
      if (permitted === null) return { status: 'unsupported' };
      if (permitted) return { status: 'already_allowed' };
      return request('program_card.model.allow', { ref, profileId: scope?.profileId });
    },

    revokeModel: async (undo     , scope     , keep      = []) => {
      try { return await request('program_card.model.revoke', { undo, keep: Array.isArray(keep) ? keep.slice(0, 64) : [], profileId: scope?.profileId }); }
      catch (_) { return { status: 'unsupported' }; }
    },
    reasoningLevels: async () => ({ levels: [], defaultLevel: null, enforceable: false }),
    async complete(p     ) {
      const callId = `model-${Date.now().toString(36)}-${++seq}`;
      const cancel = () => { void request('program_card.model.cancel', { callId, profileId: p.scope?.profileId }).catch(() => {}); };
      if (p.signal?.aborted) return { ok: false, code: 'timeout' };
      p.signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await request('program_card.model.complete', { callId, profileId: p.scope?.profileId, provider: p.provider, model: p.model, messages: [{ role: 'system', content: p.system }, ...p.messages], maxTokens: p.maxTokens, timeoutMs: Math.max(1, p.deadlineMs - Date.now()) });
      } finally { p.signal?.removeEventListener('abort', cancel); }
    },
  };
  return withCheck(port);
}

module.exports = { createOpenClawProgramCardModelHost, createHermesProgramCardModelHost };
