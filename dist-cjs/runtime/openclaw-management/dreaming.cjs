const { createHash } = require("node:crypto");
const { OpenClawManagementError } = require("./shared.cjs");

const FIELD = "reviewEnabled";
const PATH = "plugins.entries.memory-core.config.dreaming.enabled";
const RECEIPTS_MAX = 64;

const receiptStores = new WeakMap();

function receiptsFor(ctx     ) {
  let store = receiptStores.get(ctx);
  if (!store) { store = new Map(); receiptStores.set(ctx, store); }
  return store;
}

function remember(ctx     , mutationId     , receipt     ) {
  const store = receiptsFor(ctx);
  store.delete(mutationId);
  store.set(mutationId, receipt);
  while (store.size > RECEIPTS_MAX) store.delete(store.keys().next().value);
}

function digest(value     ) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dreamingState(config     ) {
  const plugins = config?.plugins && typeof config.plugins === "object" ? config.plugins : {};
  const slot = plugins.slots?.memory;
  if (typeof slot === "string" && slot && slot !== "memory-core") return null;
  const entry = plugins.entries?.["memory-core"];
  if (entry?.enabled === false) return null;
  const saved = entry?.config?.dreaming?.enabled;
  const present = typeof saved === "boolean";
  return { on: present ? saved : true, present };
}

function canWrite(ctx     ) {
  return ctx.advertisesAll("config.get", "config.patch");
}

async function readSnapshot(env     , request     ) {
  const { ctx } = env;
  if (!(await env.agents()).some((row     ) => row.id === request.profileId)) {
    throw new OpenClawManagementError("profile_not_served");
  }
  const { config, hash } = await ctx.readConfig();
  const state = dreamingState(config);
  if (!state) throw new OpenClawManagementError("unsupported");
  const value = state.on ? "on" : "off";
  const field      = {
    effectiveValue: value,
    revision: digest(["openclaw-dreaming", value, state.present]),
    writable: canWrite(ctx),
    source: state.present ? "user" : "default",
    savedPresent: state.present,
    savedState: state.present ? "recognized" : "absent",
    applyTiming: "next_automatic_review",
  };
  if (state.present) field.savedValue = state.on ? "true" : "false";
  return {
    hash,
    learning: {
      fields: { [FIELD]: field },
      models: ["inherit"],
      modelsTruncated: false,
      selectedModelAvailable: true,
      customReviewRoute: false,
      futureRoute: { state: "unknown" },
      currentWork: "unchanged_not_observed",
      pendingProposals: "preserved",
    },
  };
}

function patchFor(on     ) {
  return { plugins: { entries: { "memory-core": { config: { dreaming: { enabled: on } } } } } };
}

async function update(env     , request     ) {
  const { ctx } = env;
  const change = request.learning;
  const names = Object.keys(change.changes);
  const known = receiptsFor(ctx).get(change.mutationId);

  if (known) return { ...(await readSnapshot(env, request)).learning, receipt: known };
  if (ctx.now() > change.expiresAtMs) throw new OpenClawManagementError("request_expired");

  if (names.some((name     ) => name !== FIELD)) throw new OpenClawManagementError("invalid_request");
  const current = await readSnapshot(env, request);
  if (current.learning.fields[FIELD].revision !== change.expected[FIELD]) throw new OpenClawManagementError("config_conflict");
  if (!current.learning.fields[FIELD].writable) throw new OpenClawManagementError("managed_setting");
  remember(ctx, change.mutationId, { mutationId: change.mutationId, outcome: "unknown", changedFields: [FIELD] });
  try {
    await ctx.patchConfig({ patch: patchFor(change.changes[FIELD] === "on"), baseHash: current.hash });
  } catch (error     ) {

    if (error instanceof OpenClawManagementError && (error.code === "config_changed" || error.hostCode)) {
      receiptsFor(ctx).delete(change.mutationId);
      throw new OpenClawManagementError(error.code === "config_changed" ? "config_conflict" : "invalid_request");
    }
    return { ...current.learning, receipt: receiptsFor(ctx).get(change.mutationId) };
  }
  const receipt = { mutationId: change.mutationId, outcome: "committed", changedFields: [FIELD] };
  remember(ctx, change.mutationId, receipt);
  return { ...(await readSnapshot(env, request)).learning, receipt };
}

async function settle(env     , request     ) {
  const { ctx } = env;
  const { mutationId } = request.learning;
  const current = await readSnapshot(env, request);
  const known = receiptsFor(ctx).get(mutationId);
  if (request.operation === "learning.receipt") {
    return { ...current.learning, receipt: known || { mutationId, outcome: "unknown", changedFields: [] } };
  }
  const fields = request.learning.fields;
  const receipt = known?.outcome === "committed" ? known : { mutationId, outcome: "reconciled_unknown", changedFields: fields };
  remember(ctx, mutationId, receipt);
  return { ...current.learning, receipt };
}

async function dreamingOn(ctx     ) {
  if (!ctx.advertises("config.get")) return null;
  try {
    const state = dreamingState((await ctx.readConfig()).config);
    return state ? state.on : null;
  } catch {
    return null;
  }
}

const dreamingSection = {
  id: "dreaming",
  operations: [
    { operation: "learning.read", scope: "profile" },
    { operation: "learning.update", scope: "profile" },
    { operation: "learning.receipt", scope: "profile" },
    { operation: "learning.recover", scope: "profile" },
  ],
  supports(ctx     , operation     ) {
    if (!ctx.advertises("config.get")) return false;
    if (operation === "learning.update") return canWrite(ctx);
    return true;
  },
  applyTiming(ctx     , operation     ) {
    return operation === "learning.update" ? ctx.applyTiming(PATH) : null;
  },
  async handle(env     , request     ) {
    if (!request.learning) throw new OpenClawManagementError("invalid_request");
    if (request.operation === "learning.update") return { status: "ok", learning: await update(env, request) };
    if (request.operation === "learning.read") return { status: "ok", learning: (await readSnapshot(env, request)).learning };
    return { status: "ok", learning: await settle(env, request) };
  },
};

module.exports = { dreamingState, dreamingOn, dreamingSection };
