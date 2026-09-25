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

async function saveInputPredictionModelAllow(api     , ref     ) {
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
    const list = Array.isArray(llm.allowedModels) ? llm.allowedModels.slice() : [];
    if (!list.includes(ref)) list.push(ref);
    llm.allowModelOverride = true;
    llm.allowedModels = list;
  } });
  const saved = pluginLlmPolicy(mutation?.nextConfig);
  if (saved.allowModelOverride !== true || !Array.isArray(saved.allowedModels) || !saved.allowedModels.includes(ref)) return { status: "error" };

  const hot = plan.afterWrite.mode === "auto";
  return { status: "saved", activation: { required: true, mode: hot ? "hot_reload" : "manual" } };
}

module.exports = { optionalPluginConfig, saveOptionalCredential, pluginLlmPolicy, saveInputPredictionModelAllow };
