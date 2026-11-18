const CODEX_LIVE_REASONING_OPENCLAW                = null;
const CODEX_LIVE_REASONING_NOTE_ID = "live_reasoning.codex_engine_gap";

const CODEX_ROUTE_PROVIDERS = new Set(["openai", "openai-codex", "codex"]);
const OFFICIAL_OPENAI_BASE = /^https:\/\/(api\.openai\.com|chatgpt\.com)(\/|$)/i;

function isRecord(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeIdOf(policy     ) {
  const runtime = isRecord(policy) ? policy.agentRuntime : null;
  const id = isRecord(runtime) ? runtime.id : null;
  if (typeof id !== "string") return null;
  const trimmed = id.trim().toLowerCase();
  return trimmed && trimmed !== "auto" ? trimmed : null;
}

function primaryRef(model     ) {
  if (typeof model === "string") return model.trim() || null;
  if (isRecord(model) && typeof model.primary === "string") return model.primary.trim() || null;
  return null;
}

function agentModels(config     ) {
  const agents = isRecord(config?.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const out        = [];
  const defaultRef = primaryRef(defaults.model);
  if (defaultRef) out.push({ ref: defaultRef, agent: null });
  const entries = isRecord(agents.entries) ? Object.values(agents.entries) : [];
  const list = Array.isArray(agents.list) ? agents.list : [];
  for (const agent of [...entries, ...list]) {
    if (!isRecord(agent)) continue;
    const ref = primaryRef(agent.model) ?? defaultRef;
    if (ref) out.push({ ref, agent });
  }
  return out;
}

function explicitRuntime(config     , ref        , agent     ) {
  const slash = ref.indexOf("/");
  const provider = slash > 0 ? ref.slice(0, slash).toLowerCase() : "";
  const modelId = slash > 0 ? ref.slice(slash + 1) : ref;
  const defaults = isRecord(config?.agents?.defaults) ? config.agents.defaults : {};
  const providerConfig = isRecord(config?.models?.providers?.[provider]) ? config.models.providers[provider] : {};
  const catalog = Array.isArray(providerConfig.models) ? providerConfig.models : [];
  const catalogEntry = catalog.find((entry     ) => isRecord(entry) && (entry.id === modelId || entry.id === ref));
  const candidates = [
    agent?.models?.[ref],
    defaults.models?.[ref],
    catalogEntry,
    agent?.models?.[`${provider}/*`],
    defaults.models?.[`${provider}/*`],
    providerConfig,
  ];
  for (const candidate of candidates) {
    const id = runtimeIdOf(candidate);
    if (id) return { id, provider, providerConfig };
  }
  return { id: null, provider, providerConfig };
}

function codexPluginBlocked(config     ) {
  const plugins = isRecord(config?.plugins) ? config.plugins : {};
  if (plugins.enabled === false) return true;
  if (isRecord(plugins.entries?.codex) && plugins.entries.codex.enabled === false) return true;
  if (Array.isArray(plugins.deny) && plugins.deny.includes("codex")) return true;
  return Array.isArray(plugins.allow) && plugins.allow.length > 0 && !plugins.allow.includes("codex");
}

function codexEngineState(config     ) {
  if (!isRecord(config) || codexPluginBlocked(config)) return { inUse: false, how: null };
  let how      = null;
  for (const { ref, agent } of agentModels(config)) {
    const resolved = explicitRuntime(config, ref, agent);
    if (resolved.id === "codex") return { inUse: true, how: "explicit" };
    if (resolved.id !== null || !CODEX_ROUTE_PROVIDERS.has(resolved.provider)) continue;
    const baseUrl = resolved.providerConfig.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.trim() && !OFFICIAL_OPENAI_BASE.test(baseUrl.trim())) continue;
    how = "implicit";
  }
  return { inUse: how !== null, how };
}

function calendar(value     ) {
  const match = /^(\d{4})\.(\d+)\.(\d+)/.exec(String(value ?? "").trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(version     , floor     ) {
  const left = calendar(version);
  const right = calendar(floor);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }

  return !/-/.test(String(version));
}

function codexLiveReasoningNote(config     , hostVersion     ) {
  if (!codexEngineState(config).inUse) return null;
  if (CODEX_LIVE_REASONING_OPENCLAW && atLeast(hostVersion, CODEX_LIVE_REASONING_OPENCLAW)) return null;
  return {
    id: CODEX_LIVE_REASONING_NOTE_ID,
    severity: "info",
    explanation:
      "The agent's model is set up for OpenClaw's Codex engine. No released OpenClaw passes Codex reasoning to plugins yet (upstream fix #188076), so the glasses show \"Reasoning...\" and the tool actions on that engine instead of live reasoning text.",
    evidence: typeof hostVersion === "string" && hostVersion ? `openclaw-${hostVersion}` : "openclaw-version-unknown",
  };
}

module.exports = { CODEX_LIVE_REASONING_OPENCLAW, CODEX_LIVE_REASONING_NOTE_ID, codexPluginBlocked, codexEngineState, codexLiveReasoningNote };
