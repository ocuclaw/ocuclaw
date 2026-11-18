const { agentDefaultsPatch } = require("../../gateway/openclaw-agent-defaults.cjs");
const { OpenClawManagementError, isRateLimited, isScopeRefusal, isStaleWrite } = require("./shared.cjs");

const FIELD_KEYS      = {
  model: "model",
  fallbacks: "model",
  utility: "utilityModel",
  image: "imageModel",
  pdf: "pdfModel",
  voice: "voiceModel",
  decision: "decisionModel",
};
const FIELD_IDS = Object.keys(FIELD_KEYS);

const FLOOR_FIELDS = ["model", "fallbacks", "utility", "image", "pdf", "voice"];

const STRING_FIELDS = ["utility", "decision"];
const STATUSES = ["ok", "expiring", "expired", "missing", "static"];
const PROFILE_TYPES = ["oauth", "token", "api_key"];
const PROVIDERS_MAX = 32;
const PROFILES_MAX = 16;
const FALLBACKS_MAX = 16;
const KEY_PROVIDERS_MAX = 64;
const SECRETS_MAX = 128;

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

const schemaCache = new WeakMap();

function text(value     , max     ) {
  const clean = typeof value === "string" ? value.replace(/[\u0000-\u001f]+/g, " ").trim() : "";
  return clean.length > max ? "" : clean;
}

function isRecord(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function primaryOf(raw     ) {
  if (typeof raw === "string") return text(raw, 200);
  return isRecord(raw) ? text(raw.primary, 200) : "";
}

function fallbacksOf(raw     ) {
  if (!isRecord(raw) || !Array.isArray(raw.fallbacks)) return [];
  const out      = [];
  for (const item of raw.fallbacks) {
    const ref = text(item, 200);
    if (ref && !out.includes(ref) && out.length < FALLBACKS_MAX) out.push(ref);
  }
  return out;
}

async function describeSchema(ctx     ) {
  const key = ctx.bootId() || "unknown";
  const cached = schemaCache.get(ctx);
  if (cached && cached.key === key) return cached.schema;
  let schema      = { fields: FLOOR_FIELDS, restart: [] };
  if (ctx.advertises("config.schema.lookup")) {
    try {
      const lookup      = await ctx.call("config.schema.lookup", { path: "agents.defaults" });
      const children = Array.isArray(lookup?.children) ? lookup.children : null;
      if (children) {
        const byKey = new Map(children.map((child     ) => [text(child?.key, 80), child]));
        const fields = FIELD_IDS.filter((id     ) => byKey.has(FIELD_KEYS[id]));
        const restart = fields.filter((id     ) => (byKey.get(FIELD_KEYS[id])       )?.reloadKind === "restart");
        schema = { fields, restart };
      }
    } catch {

    }
  }
  schemaCache.set(ctx, { key, schema });
  return schema;
}

function fieldRows(defaults     , schema     ) {
  return schema.fields.map((id     ) => {
    const raw = defaults[FIELD_KEYS[id]];
    const row      = { id, value: "", restart: schema.restart.includes(id) };
    if (id === "fallbacks") return row;
    row.value = STRING_FIELDS.includes(id) ? text(raw, 200) : primaryOf(raw);
    if (id === "utility") row.off = raw === "";
    return row;
  });
}

function expiryMs(raw     ) {
  const at = raw?.expiresAt ?? raw?.at;
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

function providerRows(status     , orderWritable     ) {
  const rows = Array.isArray(status?.providers) ? status.providers : [];
  const providers      = [];
  for (const row of rows) {
    const provider = text(row?.provider, 80);
    if (!provider || providers.some((p     ) => p.provider === provider) || providers.length >= PROVIDERS_MAX) continue;
    const listed = (Array.isArray(row.profiles) ? row.profiles : [])
      .map((profile     ) => ({
        id: text(profile?.profileId, 160),
        type: PROFILE_TYPES.includes(profile?.type) ? profile.type : "unknown",
        status: STATUSES.includes(profile?.status) ? profile.status : "unknown",
      }))
      .filter((profile     , index     , all     ) => profile.id && all.findIndex((p     ) => p.id === profile.id) === index);
    const order = Array.isArray(row.profileOrder) ? row.profileOrder.map((id     ) => text(id, 160)) : [];
    const rank = (id     ) => (order.includes(id) ? order.indexOf(id) : order.length);
    const profiles = listed
      .map((profile     , index     ) => ({ profile, index }))
      .sort((a     , b     ) => rank(a.profile.id) - rank(b.profile.id) || a.index - b.index)
      .map((entry     ) => entry.profile)
      .slice(0, PROFILES_MAX);
    const out      = {
      provider,
      name: text(row.displayName, 80) || provider,
      status: STATUSES.includes(row.status) ? row.status : "unknown",
      orderEditable: orderWritable(row) && profiles.length >= 2 && listed.length <= PROFILES_MAX,
      profiles,
    };
    const expires = expiryMs(row.expiry);
    if (expires) out.expiresAtMs = expires;
    providers.push(out);
  }
  return providers;
}

function writesModels(ctx     ) {
  return typeof ctx.agentDefaults?.patchAgentDefaults === "function" && ctx.advertisesAll("config.get", "config.patch");
}

function orderWriter(ctx     , row     ) {
  if (row?.profileOrderLocked === "provider-config") return null;
  if (row?.profileOrderLocked === "auth-config") return ctx.advertisesAll("config.get", "config.patch") ? "config" : null;
  return ctx.advertises("models.authOrderSet") ? "store" : null;
}

async function readAuthStatus(ctx     , agentId     ) {
  if (!ctx.advertises("models.authStatus")) return null;
  try {
    return await ctx.call("models.authStatus", { agentId });
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && error.code === "management_unavailable" && !ctx.connected()) throw error;

    return null;
  }
}

async function readSnapshot(env     , request     ) {
  const { ctx } = env;
  const agentId = request.profileId;
  if (!(await env.agents()).some((row     ) => row.id === agentId)) {
    throw new OpenClawManagementError("profile_not_served");
  }
  const [{ config, hash }, schema, status, secretEntries] = await Promise.all([
    ctx.readConfig(),
    describeSchema(ctx),
    readAuthStatus(ctx, agentId),
    readSecrets(ctx),
  ]);
  if (!hash) throw new OpenClawManagementError("management_unavailable");
  const defaults = isRecord(config?.agents?.defaults) ? config.agents.defaults : {};
  const providers = providerRows(status, (row     ) => orderWriter(ctx, row) !== null);
  const keysWritable = ctx.advertises("models.authSetApiKey") && status !== null;
  return {
    config,
    status,
    secretEntries,
    models: {
      revision: hash,
      writable: writesModels(ctx),
      orderWritable: supportsOrderWrites(ctx),
      fields: fieldRows(defaults, schema),
      fallbacks: schema.fields.includes("fallbacks") ? fallbacksOf(defaults.model) : [],
      providers,
      keysWritable,
      keyProviders: keysWritable ? keyProviderRows(status) : [],
      refreshable: ctx.advertises("models.authRefresh"),
      secretsReadable: secretEntries !== null,
      secretsWritable: secretEntries !== null && ctx.advertisesAll("secrets.store.set", "secrets.store.delete"),
      secrets: secretEntries === null ? [] : secretRows(secretEntries),
    },
  };
}

function keyProviderRows(status     ) {
  const names = new Map((Array.isArray(status?.providers) ? status.providers : [])
    .map((row     ) => [text(row?.provider, 80), text(row?.displayName, 80)]));
  const out      = [];
  for (const row of Array.isArray(status?.providerCapabilities) ? status.providerCapabilities : []) {
    const provider = text(row?.provider, 80);
    if (!provider || row.apiKeySupported !== true || out.some((p     ) => p.provider === provider) || out.length >= KEY_PROVIDERS_MAX) continue;
    out.push({ provider, name: names.get(provider) || provider });
  }
  return out;
}

async function readSecrets(ctx     ) {
  if (!ctx.advertises("secrets.store.list")) return null;
  try {
    const result      = await ctx.call("secrets.store.list", {});
    return Array.isArray(result?.entries) ? result.entries : null;
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && error.code === "management_unavailable" && !ctx.connected()) throw error;
    return null;
  }
}

function secretRows(entries     ) {
  const out      = [];
  for (const entry of entries) {
    const name = typeof entry?.name === "string" && SECRET_NAME.test(entry.name) ? entry.name : "";
    if (!name || !["secret", "env"].includes(entry.kind) || out.some((row     ) => row.name === name) || out.length >= SECRETS_MAX) continue;
    out.push({
      name,
      kind: entry.kind,
      updatedAtMs: Number.isSafeInteger(entry.updatedAtMs) && entry.updatedAtMs >= 0 ? entry.updatedAtMs : 0,
      restricted: Array.isArray(entry.allowedHosts) && entry.allowedHosts.length > 0,
    });
  }
  return out;
}

function supportsOrderWrites(ctx     ) {
  return ctx.advertises("models.authStatus") &&
    (ctx.advertises("models.authOrderSet") || ctx.advertisesAll("config.get", "config.patch"));
}

function modelsPatch(defaults     , changes     ) {
  const prior = isRecord(defaults) ? defaults : {};
  const patch      = {};
  const replacePaths      = [];
  const has = (field     ) => Object.hasOwn(changes, field);
  if (has("model") || has("fallbacks")) {
    const wire      = {};
    if (has("model")) wire.model = changes.model;
    if (has("fallbacks")) wire.fallbacks = changes.fallbacks;
    const main = agentDefaultsPatch(prior, wire);
    Object.assign(patch, main.patch);
    replacePaths.push(...main.replacePaths);
  }
  for (const field of ["utility", "image", "pdf", "voice", "decision"]) {
    if (!has(field)) continue;
    const key = FIELD_KEYS[field];
    const value = changes[field];
    const before = prior[key];
    if (STRING_FIELDS.includes(field)) {

      if (value === null || (field === "decision" && value === "")) {
        if (before !== undefined) patch[key] = null;
      } else {
        patch[key] = value;
      }
      continue;
    }
    if (value === null) {
      if (before === undefined) continue;
      patch[key] = null;

      if (isRecord(before) && Array.isArray(before.fallbacks) && before.fallbacks.length > 0) {
        replacePaths.push(`agents.defaults.${key}.fallbacks`);
      }
    } else {

      patch[key] = isRecord(before) ? { primary: value } : value;
    }
  }
  return { patch, replacePaths };
}

function writerError(error     ) {
  if (error instanceof OpenClawManagementError) {

    if (error.code !== "management_unavailable" || !Object.hasOwn(error, "hostCode")) return error;
    return new OpenClawManagementError((error       ).hostCode === "INVALID_REQUEST" ? "invalid_request" : "outcome_unknown");
  }
  if (error?.code === "config_changed" || isStaleWrite(error)) return new OpenClawManagementError("config_changed");
  if (error?.code === "invalid_defaults") return new OpenClawManagementError("invalid_request");
  if (error?.code === "backend_unavailable") return new OpenClawManagementError("management_unavailable");
  if (isRateLimited(error)) return new OpenClawManagementError("rate_limited");
  if (isScopeRefusal(error)) return new OpenClawManagementError("unsupported");
  if (/^INVALID_REQUEST$/.test(error?.code || "")) return new OpenClawManagementError("invalid_request");
  return new OpenClawManagementError("outcome_unknown");
}

async function update(env     , request     ) {
  const { ctx } = env;
  if (!writesModels(ctx)) throw new OpenClawManagementError("unsupported");
  const { revision, changes } = request.models;
  const current = await readSnapshot(env, request);
  if (current.models.revision !== revision) throw new OpenClawManagementError("config_changed");
  const fields = current.models.fields.map((row     ) => row.id);
  if (Object.keys(changes).some((field     ) => !fields.includes(field))) throw new OpenClawManagementError("invalid_request");
  const { patch, replacePaths } = modelsPatch(current.config?.agents?.defaults, changes);
  if (Object.keys(patch).length > 0) {
    try {
      await ctx.agentDefaults.patchAgentDefaults({ patch, replacePaths, baseHash: revision });
    } catch (error     ) {
      throw writerError(error);
    }
  }
  return (await readSnapshot(env, request)).models;
}

function configOrderKey(config     , provider     , authProvider     ) {
  const order = isRecord(config?.auth?.order) ? config.auth.order : {};
  const wanted = [provider, authProvider].filter(Boolean).map((id     ) => id.toLowerCase());
  return Object.keys(order).find((key     ) => wanted.includes(key.toLowerCase())) || authProvider || provider;
}

async function authOrder(env     , request     ) {
  const { ctx } = env;
  const { revision, provider, profileIds } = request.models;
  const current = await readSnapshot(env, request);
  if (current.models.revision !== revision) throw new OpenClawManagementError("config_changed");
  const shown = current.models.providers.find((row     ) => row.provider === provider);
  const native = (Array.isArray(current.status?.providers) ? current.status.providers : [])
    .find((row     ) => text(row?.provider, 80) === provider);
  if (!shown || !native || !shown.orderEditable) throw new OpenClawManagementError("invalid_request");
  const known = shown.profiles.map((profile     ) => profile.id);
  if (profileIds.length !== known.length || !known.every((id     ) => profileIds.includes(id))) {
    throw new OpenClawManagementError("invalid_request");
  }
  try {
    if (orderWriter(ctx, native) === "config") {
      const key = configOrderKey(current.config, provider, text(native.authProvider, 80));
      const before = current.config?.auth?.order?.[key];
      await ctx.patchConfig({
        patch: { auth: { order: { [key]: profileIds } } },
        baseHash: revision,
        replacePaths: Array.isArray(before) && before.length > 0 ? [`auth.order.${key}`] : [],
      });
    } else {
      await ctx.call("models.authOrderSet", { provider, profileIds, agentId: request.profileId });
    }
  } catch (error     ) {
    throw writerError(error);
  }
  return (await readSnapshot(env, request)).models;
}

function expired(ctx     , change     ) {
  if (ctx.now() > change.expiresAtMs) throw new OpenClawManagementError("intent_expired");
}

async function setApiKey(env     , request     ) {
  const { ctx } = env;
  const { provider, apiKey } = request.models;
  const current = await readSnapshot(env, request);
  if (!current.models.keysWritable || !current.models.keyProviders.some((row     ) => row.provider === provider)) {
    throw new OpenClawManagementError("invalid_request");
  }
  expired(ctx, request.models);
  try {
    await ctx.call("models.authSetApiKey", { provider, apiKey, agentId: request.profileId });
  } catch (error     ) {
    throw writerError(error);
  }
  return (await readSnapshot(env, request)).models;
}

async function refreshSignIns(env     , request     ) {
  try {
    await env.ctx.call("models.authRefresh", { operation: "update", agentId: request.profileId });
  } catch (error     ) {
    throw writerError(error);
  }
  return (await readSnapshot(env, request)).models;
}

async function setSecret(env     , request     ) {
  const { ctx } = env;
  const { name, value } = request.models;
  const current = await readSnapshot(env, request);
  if (!current.models.secretsWritable) throw new OpenClawManagementError("unsupported");

  const before = current.secretEntries.find((entry     ) => entry?.name === name);
  const params      = { name, value, kind: before && ["secret", "env"].includes(before.kind) ? before.kind : "secret" };
  if (Array.isArray(before?.allowedHosts) && before.allowedHosts.length > 0) params.allowedHosts = [...before.allowedHosts];
  expired(ctx, request.models);
  try {
    await ctx.call("secrets.store.set", params);
  } catch (error     ) {
    throw writerError(error);
  }
  return (await readSnapshot(env, request)).models;
}

async function deleteSecret(env     , request     ) {
  const { ctx } = env;
  const { name } = request.models;
  const current = await readSnapshot(env, request);
  if (!current.models.secretsWritable) throw new OpenClawManagementError("unsupported");

  if (!current.secretEntries.some((entry     ) => entry?.name === name)) return current.models;
  expired(ctx, request.models);
  try {
    await ctx.call("secrets.store.delete", { name });
  } catch (error     ) {
    throw writerError(error);
  }
  return (await readSnapshot(env, request)).models;
}

const WRITERS      = {
  "models.update": update,
  "models.authOrder": authOrder,
  "models.apiKey": setApiKey,
  "models.signInRefresh": refreshSignIns,
  "models.secretSet": setSecret,
  "models.secretDelete": deleteSecret,
};

const modelsSection = {
  id: "models",
  operations: [
    { operation: "models.read", scope: "profile" },
    { operation: "models.update", scope: "profile" },
    { operation: "models.authOrder", scope: "profile" },
    { operation: "models.apiKey", scope: "profile" },
    { operation: "models.signInRefresh", scope: "profile" },
    { operation: "models.secretSet", scope: "profile" },
    { operation: "models.secretDelete", scope: "profile" },
  ],
  supports(ctx     , operation     ) {
    if (!ctx.advertises("config.get")) return false;
    if (operation === "models.update") return writesModels(ctx);
    if (operation === "models.authOrder") return supportsOrderWrites(ctx);
    if (operation === "models.apiKey") return ctx.advertisesAll("models.authStatus", "models.authSetApiKey");
    if (operation === "models.signInRefresh") return ctx.advertises("models.authRefresh");
    if (operation === "models.secretSet") return ctx.advertisesAll("secrets.store.list", "secrets.store.set");
    if (operation === "models.secretDelete") return ctx.advertisesAll("secrets.store.list", "secrets.store.delete");
    return true;
  },
  async applyTiming(ctx     , operation     ) {
    return operation === "models.update" ? ctx.applyTiming("agents.defaults.model") : null;
  },
  async handle(env     , request     ) {
    if (!request.models) throw new OpenClawManagementError("invalid_request");
    const writer = WRITERS[request.operation];
    if (writer) return { status: "ok", models: await writer(env, request) };
    return { status: "ok", models: (await readSnapshot(env, request)).models };
  },
};

module.exports = { modelsPatch, modelsSection };
