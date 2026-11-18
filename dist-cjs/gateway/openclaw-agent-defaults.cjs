const OPENCLAW_AGENT_DEFAULTS_CAPABILITY = "openclawAgentDefaults";

const FIELD_KEYS      = {
  model: "model",
  fallbacks: "model",
  thinking: "thinkingDefault",
  fastMode: "fastModeDefault",
  reasoning: "reasoningDefault",
  toolDetail: "verboseDefault",
};

const AGENT_DEFAULTS_FIELDS      = Object.freeze(Object.keys(FIELD_KEYS));

const FALLBACK_OPTIONS      = {
  thinking: ["off", "minimal", "low", "medium", "high", "xhigh"],
  fastMode: ["off", "on"],
  reasoning: ["off", "on", "stream"],
  toolDetail: ["off", "on", "full"],
};

function cleanText(value     ) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanList(value     ) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out      = [];
  for (const item of value) {
    const text = cleanText(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function modelPrimary(raw     ) {
  if (typeof raw === "string") return cleanText(raw);
  return isPlainObject(raw) ? cleanText(raw.primary) : "";
}

function modelFallbacks(raw     ) {
  return isPlainObject(raw) ? cleanList(raw.fallbacks) : [];
}

function fastModeWire(value     ) {
  if (value === true) return "on";
  if (value === false) return "off";
  return value === "auto" ? "auto" : "";
}

function readAgentDefaults(config     ) {
  const defaults = isPlainObject(config?.agents?.defaults) ? config.agents.defaults : {};
  return {
    model: modelPrimary(defaults.model),
    fallbacks: modelFallbacks(defaults.model),
    thinking: cleanText(defaults.thinkingDefault),
    fastMode: fastModeWire(defaults.fastModeDefault),
    reasoning: cleanText(defaults.reasoningDefault),
    toolDetail: cleanText(defaults.verboseDefault),
  };
}

class OpenClawAgentDefaultsError extends Error {
  code     ;
  retryable     ;

  constructor(code     , message     , retryable = false) {
    super(message);
    this.name = "OpenClawAgentDefaultsError";
    this.code = code;
    this.retryable = retryable;
  }
}

function normalizeError(error     ) {
  if (error instanceof OpenClawAgentDefaultsError) return error;
  const message = cleanText(error?.message) || "OpenClaw rejected the defaults change";
  const lower = message.toLowerCase();
  if (lower.includes("base hash") || lower.includes("basehash") || lower.includes("config changed")) {
    return new OpenClawAgentDefaultsError(
      "config_changed",
      "OpenClaw settings changed somewhere else. Reload and try again.",
      true,
    );
  }
  if (lower.includes("not connected") || lower.includes("handshake") || lower.includes("timeout")) {
    return new OpenClawAgentDefaultsError(
      "backend_unavailable",
      "OpenClaw is not ready. Try again when it reconnects.",
      true,
    );
  }
  if (lower.includes("scope") || lower.includes("forbidden") || lower.includes("not authorized")) {
    return new OpenClawAgentDefaultsError(
      "not_permitted",
      "OpenClaw did not allow this change from the glasses app.",
    );
  }
  return new OpenClawAgentDefaultsError("defaults_failed", message, true);
}

function enumValues(schema     )      {
  if (!isPlainObject(schema)) return [];
  if (Array.isArray(schema.enum)) return schema.enum;
  if (schema.const !== undefined) return [schema.const];
  const out      = [];
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) {
      for (const variant of schema[key]) out.push(...enumValues(variant));
    }
  }
  return out;
}

function stringOptions(schema     ) {
  return enumValues(schema).filter((value     ) => typeof value === "string" && value.trim());
}

function fastModeOptions(schema     ) {
  if (!isPlainObject(schema)) return [];
  const values = enumValues(schema);
  return values.includes("auto") ? ["off", "on", "auto"] : ["off", "on"];
}

function agentDefaultsPatch(current     , changes     ) {
  const prior = isPlainObject(current) ? current : {};
  const patch      = {};
  const replacePaths      = [];
  const has = (field     ) => Object.prototype.hasOwnProperty.call(changes, field);

  if (has("model") || has("fallbacks")) {
    const priorModel = prior.model;
    const primary = has("model")
      ? (changes.model === null ? "" : cleanText(changes.model))
      : modelPrimary(priorModel);
    const fallbacks = has("fallbacks")
      ? (changes.fallbacks === null ? [] : cleanList(changes.fallbacks))
      : modelFallbacks(priorModel);
    if (!primary && fallbacks.length === 0) {
      if (priorModel !== undefined) patch.model = null;
    } else if (fallbacks.length === 0 && !isPlainObject(priorModel)) {

      patch.model = primary;
    } else {
      const next      = { primary: primary || null };
      if (fallbacks.length > 0) next.fallbacks = fallbacks;
      else if (isPlainObject(priorModel) && priorModel.fallbacks !== undefined) next.fallbacks = null;
      if (!primary && !isPlainObject(priorModel)) delete next.primary;
      patch.model = next;
    }

    if (
      patch.model !== undefined &&
      isPlainObject(priorModel) &&
      Array.isArray(priorModel.fallbacks) &&
      priorModel.fallbacks.length > 0
    ) {
      replacePaths.push("agents.defaults.model.fallbacks");
    }
  }

  const scalar = (field     , key     , value     ) => {
    if (!has(field)) return;
    if (value === undefined) {
      if (prior[key] !== undefined) patch[key] = null;
    } else {
      patch[key] = value;
    }
  };
  if (has("thinking")) scalar("thinking", "thinkingDefault", cleanText(changes.thinking) || undefined);
  if (has("fastMode")) {
    const raw = cleanText(changes.fastMode).toLowerCase();
    scalar("fastMode", "fastModeDefault", raw === "on" ? true : raw === "off" ? false : raw === "auto" ? "auto" : undefined);
  }
  if (has("reasoning")) scalar("reasoning", "reasoningDefault", cleanText(changes.reasoning) || undefined);
  if (has("toolDetail")) scalar("toolDetail", "verboseDefault", cleanText(changes.toolDetail) || undefined);
  return { patch, replacePaths };
}

function validateChanges(changes     , options     ) {
  if (!isPlainObject(changes)) {
    throw new OpenClawAgentDefaultsError("invalid_defaults", "Nothing to change.");
  }
  const fields = Object.keys(changes);
  if (fields.length === 0) throw new OpenClawAgentDefaultsError("invalid_defaults", "Nothing to change.");
  for (const field of fields) {
    if (!AGENT_DEFAULTS_FIELDS.includes(field)) {
      throw new OpenClawAgentDefaultsError("invalid_defaults", `Unknown default: ${field}.`);
    }
    const value = changes[field];
    if (value === null) continue;
    if (field === "fallbacks") {
      if (!Array.isArray(value) || value.some((item     ) => typeof item !== "string")) {
        throw new OpenClawAgentDefaultsError("invalid_defaults", "Backup models must be a list.");
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new OpenClawAgentDefaultsError("invalid_defaults", `Choose a value for ${field}.`);
    }
    const allowed = options?.[field];
    const text = cleanText(value);
    if (text && Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(text)) {
      throw new OpenClawAgentDefaultsError("invalid_defaults", `OpenClaw does not offer "${text}" here.`);
    }
  }
}

function createOpenClawAgentDefaults(deps      = {}) {
  const gatewayBridge = deps.gatewayBridge;
  let schemaCache      = null;

  function isAvailable() {
    return (
      cleanText(typeof deps.backendKind === "function" ? deps.backendKind() : deps.backendKind)
        .toLowerCase() === "openclaw" &&
      !!gatewayBridge &&
      typeof gatewayBridge.request === "function" &&
      (typeof deps.isConnected !== "function" || deps.isConnected() === true)
    );
  }

  function requireAvailable() {
    if (!isAvailable()) {
      throw new OpenClawAgentDefaultsError(
        "backend_unavailable",
        "OpenClaw is not ready. Try again when it reconnects.",
        true,
      );
    }
  }

  async function describeSchema() {
    if (schemaCache) return schemaCache;
    const options      = { ...FALLBACK_OPTIONS };
    let supported      = AGENT_DEFAULTS_FIELDS.slice();
    const restart      = [];
    let described = false;
    try {
      const lookup = await gatewayBridge.request("config.schema.lookup", { path: "agents.defaults" });
      const children = Array.isArray(lookup?.children) ? lookup.children : null;
      if (children) {
        described = true;
        const byKey      = new Map(children.map((child     ) => [cleanText(child?.key), child]));
        supported = AGENT_DEFAULTS_FIELDS.filter((field     ) => byKey.has(FIELD_KEYS[field]));
        for (const field of supported) {
          if (cleanText(byKey.get(FIELD_KEYS[field])?.reloadKind).toLowerCase() === "restart") {
            restart.push(field);
          }
        }

        const enumFields = ["thinking", "fastMode", "reasoning", "toolDetail"]
          .filter((field     ) => supported.includes(field));
        const leaves = await Promise.all(enumFields.map((field     ) =>
          gatewayBridge.request("config.schema.lookup", {
            path: `agents.defaults.${FIELD_KEYS[field]}`,
          }).catch(() => null)));
        enumFields.forEach((field     , index     ) => {
          const schema = leaves[index]?.schema;
          const values = field === "fastMode" ? fastModeOptions(schema) : stringOptions(schema);
          if (values.length > 0) options[field] = values;
        });
      }
    } catch {

    }
    schemaCache = { supported, options, restart, described };
    return schemaCache;
  }

  async function readSnapshot() {
    requireAvailable();
    const snapshot = await gatewayBridge.request("config.get", {});
    const hash = cleanText(snapshot?.hash);
    return { snapshot, hash, defaults: snapshot?.config?.agents?.defaults };
  }

  function loadedResult(status     , hash     , config     , schema     , extra      = {}) {
    return {
      status,
      backend: "openclaw",
      hash,
      defaults: readAgentDefaults(config),
      supported: schema.supported,
      options: schema.options,
      restartFields: schema.restart,
      ...extra,
    };
  }

  async function getDefaults() {
    try {
      const { snapshot, hash } = await readSnapshot();

      schemaCache = null;
      const schema = await describeSchema();
      return loadedResult("loaded", hash, snapshot?.config, schema);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async function patchAgentDefaults(input      = {}) {
    const patch = isPlainObject(input.patch) ? input.patch : null;
    if (!patch || Object.keys(patch).length === 0) {
      throw new OpenClawAgentDefaultsError("invalid_defaults", "Nothing to change.");
    }
    requireAvailable();
    const expectedHash = cleanText(input.baseHash);
    const baseHash = expectedHash || (await readSnapshot()).hash;
    if (!baseHash) {
      throw new OpenClawAgentDefaultsError(
        "config_snapshot_unavailable",
        "OpenClaw did not provide a writable settings snapshot.",
        true,
      );
    }
    const replacePaths = cleanList(input.replacePaths);
    const result = await gatewayBridge.request("config.patch", {
      baseHash,
      raw: JSON.stringify({ agents: { defaults: patch } }),
      ...(replacePaths.length > 0 ? { replacePaths } : {}),
    });
    if (result?.ok !== true) {
      throw new OpenClawAgentDefaultsError(
        "defaults_not_saved",
        "OpenClaw did not confirm the change.",
        true,
      );
    }
    return result;
  }

  async function setDefaults(input      = {}) {
    try {
      requireAvailable();
      const schema = await describeSchema();
      const changes = input.changes;
      validateChanges(changes, schema.options);
      for (const field of Object.keys(changes)) {
        if (!schema.supported.includes(field)) {
          throw new OpenClawAgentDefaultsError(
            "unsupported_field",
            "This OpenClaw version does not offer that setting.",
          );
        }
      }
      const { snapshot, hash } = await readSnapshot();
      const baseHash = cleanText(input.baseHash);
      if (baseHash && hash && baseHash !== hash) {
        throw new OpenClawAgentDefaultsError(
          "config_changed",
          "OpenClaw settings changed somewhere else. Reload and try again.",
          true,
        );
      }
      const { patch, replacePaths } = agentDefaultsPatch(snapshot?.config?.agents?.defaults, changes);
      const fields = Object.keys(changes);
      const restartRequired = fields.some((field     ) => schema.restart.includes(field));
      if (Object.keys(patch).length === 0) {
        return loadedResult("updated", hash, snapshot?.config, schema, { restartRequired: false });
      }
      const result = await patchAgentDefaults({ patch, replacePaths, baseHash: hash });
      const after = await readSnapshot();
      return loadedResult("updated", after.hash, after.snapshot?.config, schema, {
        restartRequired: restartRequired || result?.restart === true,
      });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  return {
    isAvailable,
    getDefaults,
    setDefaults,
    patchAgentDefaults,
  };
}

module.exports = { OPENCLAW_AGENT_DEFAULTS_CAPABILITY, AGENT_DEFAULTS_FIELDS, readAgentDefaults, OpenClawAgentDefaultsError, agentDefaultsPatch, createOpenClawAgentDefaults };
