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
  if (!["sonioxApiKey", "evenAiToken"].includes(field) || typeof secret !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(secret)) return false;
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

module.exports = { optionalPluginConfig, saveOptionalCredential };
