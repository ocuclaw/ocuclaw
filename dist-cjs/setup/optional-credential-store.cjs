const { planOptionalSetupActivation } = require("./optional-activation-policy.cjs");

function optionalPluginConfig(document     , create = false)      {
  let node = document;
  for (const key of ["plugins", "entries", "ocuclaw", "config"]) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("ambiguous_config");
    if (node[key] === undefined && create) node[key] = {};
    if (node[key] === undefined) return {};
    node = node[key];
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("ambiguous_config");
  return node;
}

async function saveOptionalCredential(api     , field     , secret     , options     ) {
  if (!["sonioxApiKey", "evenAiToken", "typesafeApiKey"].includes(field) || typeof secret !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(secret)) return false;
  const plan = options.activationPlan;
  const mutation = await api.runtime.config.mutateConfigFile({ afterWrite: plan.afterWrite, mutate(draft     ) {
    if (JSON.stringify(planOptionalSetupActivation(draft, api?.runtime?.version)) !== JSON.stringify(plan)) throw new Error("configuration_changed");
    const target = optionalPluginConfig(draft, true);
    if (target[field] !== options.previous || (typeof options.checkDraft === "function" && !options.checkDraft(draft))) throw new Error("configuration_changed");
    target[field] = secret;
    if (field === "evenAiToken" && options.enableEvenAi === true) target.evenAiEnabled = true;
  } });
  const saved = optionalPluginConfig(mutation?.nextConfig);
  return saved[field] === secret && (options.enableEvenAi !== true || saved.evenAiEnabled === true);
}

function pluginLlmPolicy(document     , create = false)      {
  let node = document;
  for (const key of ["plugins", "entries", "ocuclaw", "llm"]) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("ambiguous_config");
    if (node[key] === undefined && create) node[key] = {};
    if (node[key] === undefined) return {};
    node = node[key];
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("ambiguous_config");
  return node;
}

const LIVE_MODEL_POLICY = Symbol.for("ocuclaw.live-model-policy-apis");
const liveModelPolicyApis               = (globalThis       )[LIVE_MODEL_POLICY] ||= new WeakSet();

function registerLiveModelPolicy(api     ) {
  if (liveModelPolicyApis.has(api)) return true;
  if (typeof api?.registerReload !== "function") return false;
  api.registerReload({ noopPrefixes: [
    "plugins.entries.ocuclaw.llm.allowModelOverride", "plugins.entries.ocuclaw.llm.allowedModels",
    "plugins.entries.ocuclaw.config.programCardsJev", "plugins.entries.ocuclaw.config.programCardsMcp",
    "plugins.entries.ocuclaw.config.programCardsModel",
  ] });
  liveModelPolicyApis.add(api);
  return true;
}

async function saveInputPredictionModelAllow(api     , ref     , options      = {}) {
  const configApi = api?.runtime?.config;
  if (typeof ref !== "string" || !/^[A-Za-z0-9._:@/-]{1,128}$/.test(ref) || ref === "*") return { status: "policy-denied" };
  if (typeof configApi?.current !== "function" || typeof configApi?.mutateConfigFile !== "function") return { status: "error" };
  const plan = planOptionalSetupActivation(configApi.current(), api?.runtime?.version);
  const before = pluginLlmPolicy(configApi.current());
  if (before.allowModelOverride === true && !Array.isArray(before.allowedModels)) return { status: "policy-denied" };
  const mutation = await configApi.mutateConfigFile({ afterWrite: plan.afterWrite, mutate(draft     ) {
    if (JSON.stringify(planOptionalSetupActivation(draft, api?.runtime?.version)) !== JSON.stringify(plan)) throw new Error("configuration_changed");
    const llm = pluginLlmPolicy(draft, true);
    if (llm.allowModelOverride === true && !Array.isArray(llm.allowedModels)) throw new Error("configuration_changed");
    if (typeof options?.observe === "function") {
      options.observe({ override: llm.allowModelOverride, models: Array.isArray(llm.allowedModels) ? llm.allowedModels.slice() : null });
    }
    const list = Array.isArray(llm.allowedModels) ? llm.allowedModels.slice() : [];
    if (!list.includes(ref)) list.push(ref);
    llm.allowModelOverride = true;
    llm.allowedModels = list;
  } });
  const saved = pluginLlmPolicy(mutation?.nextConfig);
  if (saved.allowModelOverride !== true || !Array.isArray(saved.allowedModels) || !saved.allowedModels.includes(ref)) return { status: "error" };

  const hot = plan.afterWrite.mode === "auto";
  if (liveModelPolicyApis.has(api) && hot) {

    const deadline = Date.now() + 2000;
    do {
      const active = pluginLlmPolicy(configApi.current());
      if (active.allowModelOverride === true && Array.isArray(active.allowedModels) && active.allowedModels.includes(ref)) return { status: "saved", activation: { required: false, mode: "none" } };
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
  }
  return { status: "saved", activation: { required: true, mode: hot ? "hot_reload" : "manual" } };
}

const JEV_SWITCH_BLOCKS = Object.freeze(["liveuiJev", "programCardsJev", "programCardsMcp", "programCardsModel"]);

async function saveJevSwitchEnabled(api     , block     , wanted     , options      = {}) {
  const configApi = api?.runtime?.config;
  if (!JEV_SWITCH_BLOCKS.includes(block) || typeof wanted !== "boolean") return { status: "invalid_choice" };
  if (typeof configApi?.current !== "function" || typeof configApi?.mutateConfigFile !== "function") return { status: "unsupported_host" };
  const plan = options.activationPlan || planOptionalSetupActivation(configApi.current(), api?.runtime?.version);

  const mutation = await configApi.mutateConfigFile({ afterWrite: { mode: "none" }, mutate(draft     ) {
    if (typeof options.checkDraft === "function" && !options.checkDraft(draft)) throw new Error("configuration_changed");
    if (JSON.stringify(planOptionalSetupActivation(draft, api?.runtime?.version)) !== JSON.stringify(plan)) throw new Error("activation_policy_changed");
    const target = optionalPluginConfig(draft, true);
    const current = target[block];
    if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new Error("ambiguous_config");
    target[block] = { ...(current || {}), enabled: wanted };
  } });
  const saved = optionalPluginConfig(mutation?.nextConfig)?.[block];
  if (!saved || saved.enabled !== wanted) return { status: "configuration_unconfirmed" };
  return { status: "saved" };
}

async function removeOptionalCredential(api     , field     , options     ) {
  if (field !== "typesafeApiKey" && field !== "evenAiToken") return false;
  const evenAi = field === "evenAiToken";
  const plan = options.activationPlan;
  const mutation = await api.runtime.config.mutateConfigFile({ afterWrite: plan.afterWrite, mutate(draft     ) {
    if (JSON.stringify(planOptionalSetupActivation(draft, api?.runtime?.version)) !== JSON.stringify(plan)) throw new Error("configuration_changed");
    const target = optionalPluginConfig(draft, true);
    if (target[field] !== options.previous || (typeof options.checkDraft === "function" && !options.checkDraft(draft))) throw new Error("configuration_changed");
    delete target[field];
    if (evenAi) target.evenAiEnabled = false;
  } });
  const saved = optionalPluginConfig(mutation?.nextConfig);
  return saved[field] === undefined && (!evenAi || saved.evenAiEnabled === false);
}

module.exports = { optionalPluginConfig, saveOptionalCredential, pluginLlmPolicy, registerLiveModelPolicy, saveInputPredictionModelAllow, saveJevSwitchEnabled, removeOptionalCredential };
