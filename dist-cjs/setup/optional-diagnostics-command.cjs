const { planOptionalSetupActivation } = require("./optional-activation-policy.cjs");

const FIELDS      = { access: "externalDebugToolsEnabled", handoff: "allowDebugUpload" };

function pluginConfig(document     , create = false)      {
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

function permissions(config     ) {
  const values = pluginConfig(config);
  for (const key of Object.keys(FIELDS)) {
    const field = FIELDS[key];
    if (values[field] !== undefined && typeof values[field] !== "boolean") throw new Error("ambiguous_permission");
  }
  return { access: values.externalDebugToolsEnabled === true, handoff: values.allowDebugUpload === true };
}

function createOptionalDiagnosticsCommand(api     , dependencies      = {}) {
  return async (permission      = "status", choice      = undefined) => {
    if ((permission !== "status" && !Object.prototype.hasOwnProperty.call(FIELDS, permission)) ||
        (permission === "status" ? choice !== undefined : !["allow", "deny"].includes(choice))) {
      return { exitCode: 2, status: "invalid_choice" };
    }
    const config = api?.runtime?.config;
    if (typeof config?.current !== "function" || (permission !== "status" && typeof config?.mutateConfigFile !== "function")) {
      return { exitCode: 1, status: "unsupported_host" };
    }
    try {
      const observed = config.current();
      const before = permissions(observed);
      if (permission === "status") return { exitCode: 0, status: "observed", configured: before, activation: "unknown",
        instruction: "Reconnect the phone for active relay permission readback. Phone handoff allows review; it does not send a report to OcuClaw." };
      const field = FIELDS[permission];
      const previous = permission === "access" ? before.access : before.handoff;
      const wanted = choice === "allow";
      const plan = planOptionalSetupActivation(observed, api?.runtime?.version);
      const mutation = await config.mutateConfigFile({
        afterWrite: plan.afterWrite,
        mutate(draft     ) {
          if (typeof dependencies.checkDraft === "function" && !dependencies.checkDraft(draft)) throw new Error("configuration_changed");
          if (JSON.stringify(planOptionalSetupActivation(draft, api?.runtime?.version)) !== JSON.stringify(plan)) throw new Error("activation_policy_changed");
          const current = permissions(draft);
          const target = pluginConfig(draft, true);

          if ((permission === "access" ? current.access : current.handoff) !== previous) throw new Error("configuration_changed");
          target[field] = wanted;
        },
      });
      if (pluginConfig(mutation?.nextConfig)[field] !== wanted) throw new Error("save_unconfirmed");
      return { exitCode: 0, status: "saved", permission, allowed: wanted, activation: "unknown",
        activationPolicy: plan.reason,
        instruction: `${plan.action} Reconnect the phone and read the active permissions. Capture and review a report before choosing Send to OcuClaw; this command sends nothing.` };
    } catch (_) {
      return { exitCode: 1, status: "configuration_unconfirmed",
        instruction: "The host could not confirm this configuration. Read current permissions before retrying." };
    }
  };
}

module.exports = { createOptionalDiagnosticsCommand };
