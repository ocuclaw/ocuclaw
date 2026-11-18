const refuse = (code        , message        ) => ({ ok: false, code, message });
const unsupported = () => refuse("refresh_route_unsupported", "Standard HTTP refresh cannot use this native or incompatible model route. Configure a supported direct HTTP model route; native Codex turns are separate.");
const cancelled = () => refuse("refresh_cancelled", "Refresh preparation was cancelled; no refresh was started.");
const plain = (value     ) => value && typeof value === "object" && !Array.isArray(value);
const directRuntime = (entry     ) => {
  const id = entry?.agentRuntime?.id;
  return id === undefined || ["", "openclaw", "pi", "default"].includes(String(id).trim().toLowerCase());
};

function endpoint(base     , suffix        ) {
  if (typeof base !== "string" || !base.trim()) return null;
  try {
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;

    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}${suffix}`;
  } catch (_) { return null; }
}

function createOpenClawLiveUiAuth(api     , options      = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
  return {
    async prepare(params     )               {
      if (params.signal?.aborted) return cancelled();
      const cfg = api?.runtime?.config?.current?.() || api?.config || {};
      const raw = typeof params.modelRef === "string" ? params.modelRef.trim() : "";
      const backend = params.backend;
      if (!raw || /\s|@/.test(raw) || !["openai-compat", "anthropic-api"].includes(backend)) return unsupported();
      const split = raw.indexOf("/");
      const provider = (split < 0 ? backend === "anthropic-api" ? "anthropic" : "openai" : raw.slice(0, split)).toLowerCase();
      const id = split < 0 ? raw : raw.slice(split + 1);
      if (!id || ["codex", "openai-codex"].includes(provider)) return unsupported();
      const providers = cfg.models?.providers || {};
      const providerKeys = Object.keys(providers).filter(key => key.toLowerCase() === provider);
      if (providerKeys.length > 1) return unsupported();
      const authored = providers[providerKeys[0]];
      const row = Array.isArray(authored?.models) ? authored.models.find((m     ) => m?.id === id) : null;
      const aliases = cfg.agents?.defaults?.models;
      const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      const agentId = typeof params.sessionKey === "string" ? /^agent:([^:]+):/.exec(params.sessionKey)?.[1] : undefined;
      const agent = agentId ? agents.find((a     ) => a.id === agentId) : agents.find((a     ) => a.default === true) || agents[0];

      if (!directRuntime(cfg.agents?.defaults) || !directRuntime(agent) ||
          !directRuntime(authored) || !directRuntime(row) || !directRuntime(aliases?.[`${provider}/${id}`]) ||
          !directRuntime(agent?.models?.[`${provider}/${id}`])) return unsupported();
      if (typeof api?.runtime?.modelConfig?.resolveModelRuntimePolicy !== "function") return refuse("refresh_auth_unsupported", "This OpenClaw runtime cannot verify HTTP model ownership; no refresh was started.");
      try {
        const policy = api.runtime.modelConfig.resolveModelRuntimePolicy({ config: cfg, provider, modelId: id, ...(agentId ? { agentId } : {}), sessionKey: params.sessionKey });
        if (!plain(policy) || (policy.policy !== undefined && !plain(policy.policy))) return unsupported();
        const runtime = policy?.policy?.id;
        if (runtime && !["openclaw", "pi", "default"].includes(runtime)) return unsupported();
      } catch (_) { return unsupported(); }

      const expectedApi = backend === "anthropic-api" ? "anthropic-messages" : "openai-completions";
      const suffix = backend === "anthropic-api" ? "/v1/messages" : "/v1/chat/completions";
      const target = backend === "anthropic-api" ? "https://api.anthropic.com/v1/messages" : endpoint(params.baseUrl, suffix);

      const builtin = provider === "anthropic" || (provider === "openai" && id === "gpt-4o-mini");
      const modelApi = row?.api || authored?.api || (builtin ? expectedApi : null);
      const baseUrl = row?.baseUrl || authored?.baseUrl || (builtin ? provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1" : null);
      if (!target || modelApi !== expectedApi || endpoint(baseUrl, suffix) !== target ||
          authored?.headers || authored?.request || row?.headers || row?.request || authored?.authHeader === false) return unsupported();
      const model = { ...(plain(row) ? row : {}), id, provider, api: modelApi, baseUrl };
      const authPort = api?.runtime?.modelAuth;
      const resolve = typeof authPort?.getRuntimeAuthForModel === "function" ? authPort.getRuntimeAuthForModel : authPort?.getApiKeyForModel;
      if (typeof resolve !== "function") return refuse("refresh_auth_unsupported", "This OpenClaw runtime has no supported model-auth helper for standard HTTP refresh; no refresh was started.");

      let timer     ;
      let onAbort     ;
      const stopped = new Promise(resolve => {
        timer = setTimeout(() => resolve(refuse("refresh_auth_timeout", "Model-auth preparation timed out; no refresh was started.")), timeoutMs);
        onAbort = () => resolve(cancelled());
        params.signal?.addEventListener("abort", onAbort, { once: true });
        if (params.signal?.aborted) onAbort();
      });
      try {
        const result      = await Promise.race([
          Promise.resolve().then(() => resolve.call(authPort, { model, cfg })).then(auth => ({ auth })),
          stopped,
        ]);
        if (params.signal?.aborted) return cancelled();
        if (!Object.prototype.hasOwnProperty.call(result, "auth")) return result;
        const auth = result.auth;
        if (!plain(auth)) return refuse("refresh_auth_unsupported", "OpenClaw returned an unsupported model-auth result; no refresh was started.");
        if (auth.mode !== "api-key") return unsupported();
        if (auth.request || auth.headers || (auth.baseUrl && endpoint(auth.baseUrl, suffix) !== target)) return unsupported();
        if (Number.isFinite(auth.expiresAt) && auth.expiresAt <= Date.now()) return refuse("refresh_credentials_missing", "The direct HTTP model credential has expired; no refresh was started.");
        if (typeof auth.apiKey !== "string" || !auth.apiKey.trim()) return refuse("refresh_credentials_missing", "No usable credential is configured for this direct HTTP model route; no refresh was started.");
        if (/^oc-sent-v2\.|secretref-managed/.test(auth.apiKey) || /[\r\n]/.test(auth.apiKey)) return refuse("refresh_auth_unsupported", "This credential requires host-owned egress that the standard HTTP backend cannot provide; no refresh was started.");
        return { ok: true, apiKey: auth.apiKey, model };
      } catch (_) {

        return refuse("refresh_auth_failed", "OpenClaw could not resolve authentication for this HTTP model route; no refresh was started.");
      } finally {
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

module.exports = { createOpenClawLiveUiAuth };
