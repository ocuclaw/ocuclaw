const { createHash } = require("node:crypto");
const { OpenClawManagementError } = require("./shared.cjs");

const EXEC_MODES = ["deny", "allowlist", "ask", "auto", "full"];
const FALLBACKS = ["deny", "allowlist", "full"];
const FIELDS = ["execMode", "askFallback"];

const MAX_TIMEOUT_SECONDS = 1800;
const RECEIPT_LIMIT = 50;
const LIST_LIMIT = 200;
const PATTERN_LIMIT = 512;
const RISKY      = { execMode: "full", askFallback: "full" };

const receiptStores = new WeakMap();

function receipts(ctx     ) {
  let store = receiptStores.get(ctx);
  if (!store) {
    store = new Map();
    receiptStores.set(ctx, store);
  }
  return store;
}

function remember(ctx     , mutationId     , entry     ) {
  const store = receipts(ctx);
  store.delete(mutationId);
  store.set(mutationId, entry);
  while (store.size > RECEIPT_LIMIT) store.delete(store.keys().next().value);
}

function record(value     ) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function digest(value     ) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function modeFromPolicy(security     , ask     ) {
  if (security === "deny") return "deny";
  if (security === "allowlist" && ask === "off") return "allowlist";
  if (security === "full" && ask !== "always") return "full";
  return "ask";
}

function hasPolicy(exec     ) {
  return record(exec) && (exec.mode !== undefined || exec.security !== undefined || exec.ask !== undefined);
}

function execModeField(config     , agentId     ) {
  const agentExec = config?.agents?.entries?.[agentId]?.tools?.exec;
  const globalExec = config?.tools?.exec;
  const layer = hasPolicy(agentExec) ? "agent" : hasPolicy(globalExec) ? "global" : "default";
  const exec = layer === "agent" ? agentExec : layer === "global" ? globalExec : null;
  let field     ;
  if (!exec) {
    field = { savedPresent: false, savedState: "absent", effectiveValue: "full", writable: true, source: "default" };
  } else if (EXEC_MODES.includes(exec.mode) && exec.security === undefined && exec.ask === undefined) {
    field = { savedPresent: true, savedState: "recognized", savedValue: exec.mode, effectiveValue: exec.mode, writable: true, source: "user" };
  } else {

    const effective = EXEC_MODES.includes(exec.mode) ? exec.mode : modeFromPolicy(exec.security ?? "full", exec.ask ?? "off");
    field = { savedPresent: true, savedState: "unrecognized", effectiveValue: effective, writable: false, source: "user" };
  }
  return { layer: layer === "agent" ? "agent" : "global", field };
}

function approvalsAgent(file     , agentId     ) {
  const agents = record(file?.agents) ? file.agents : {};
  return Object.hasOwn(agents, agentId) && record(agents[agentId]) ? agents[agentId] : null;
}

function askFallbackField(file     , agentId     ) {
  const agent = approvalsAgent(file, agentId);
  const layer = agent && agent.askFallback !== undefined ? "agent" : "defaults";
  const raw = layer === "agent" ? agent.askFallback : record(file?.defaults) ? file.defaults.askFallback : undefined;
  let field     ;
  if (raw === undefined) {
    field = { savedPresent: false, savedState: "absent", effectiveValue: "deny", writable: true, source: "default" };
  } else if (FALLBACKS.includes(raw)) {
    field = { savedPresent: true, savedState: "recognized", savedValue: raw, effectiveValue: raw, writable: true, source: "user" };
  } else {
    field = { savedPresent: true, savedState: "unrecognized", effectiveValue: "deny", writable: false, source: "user" };
  }
  return { layer, field };
}

function hostPolicy(payload     , agentId     ) {
  const file = payload?.file;
  const agent = approvalsAgent(file, agentId) || {};
  const defaults = record(file?.defaults) ? file.defaults : {};
  const resolved = record(payload?.resolvedDefaults) ? payload.resolvedDefaults : {};
  return {
    security: agent.security ?? defaults.security ?? resolved.security ?? "full",
    ask: agent.ask ?? defaults.ask ?? resolved.ask ?? "off",
  };
}

function bypassed(mode     , host     ) {
  return mode === "full" && host.security === "full" && host.ask === "off";
}

function withRevision(name     , layer     , field     ) {
  return { ...field, revision: digest([name, layer, field.savedState, field.savedValue ?? null, field.effectiveValue]) };
}

async function readState(ctx     , agentId     ) {
  const { config, hash: configHash } = await ctx.readConfig();
  const approvals      = await ctx.call("exec.approvals.get", {});
  const file = record(approvals?.file) ? approvals.file : {};
  const mode = execModeField(config, agentId);
  const fallback = askFallbackField(file, agentId);

  if (!ctx.advertises("config.patch")) mode.field.writable = false;
  if (!ctx.advertises("exec.approvals.set")) fallback.field.writable = false;
  return {
    config,
    configHash,
    approvals: { file, hash: typeof approvals?.hash === "string" ? approvals.hash : null },
    layers: { execMode: mode.layer, askFallback: fallback.layer },
    fields: {
      execMode: withRevision("execMode", mode.layer, mode.field),
      askFallback: withRevision("askFallback", fallback.layer, fallback.field),
    },
    processYolo: bypassed(mode.field.effectiveValue, hostPolicy(approvals, agentId)),
  };
}

function approvalsSnapshot(state     , receipt      = null) {
  const snapshot      = {
    fields: state.fields,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,

    applyTiming: "subsequent_guard_checks",
    processYolo: state.processYolo,
    sessionOverrides: "not_evaluated",
    roomOverrides: "not_evaluated",
  };
  if (receipt) snapshot.receipt = receipt;
  return snapshot;
}

function failure(code     ) {
  return { status: "error", errorCode: code };
}

function readFailure(error     ) {
  if (!(error instanceof OpenClawManagementError)) throw error;
  if (error.code === "unsupported") throw error;
  return failure("native_read_failed");
}

function writeFailureCode(error     ) {
  if (!(error instanceof OpenClawManagementError)) throw error;
  if (error.code === "config_changed") return "config_conflict";
  if (error.code === "rate_limited") return "rate_limited";
  return "outcome_unknown";
}

async function servedAgent(env     , profileId     ) {
  const agents = await env.agents();
  return agents.some((row     ) => row.id === profileId);
}

function cloneFile(file     ) {
  return JSON.parse(JSON.stringify(file || {}));
}

async function writeExecMode(ctx     , state     , agentId     , value     ) {
  const patch = state.layers.execMode === "agent"
    ? { agents: { entries: { [agentId]: { tools: { exec: { mode: value } } } } } }
    : { tools: { exec: { mode: value } } };
  await ctx.patchConfig({ patch, baseHash: state.configHash });
}

async function writeAskFallback(ctx     , state     , agentId     , value     ) {
  if (!state.approvals.hash) throw new OpenClawManagementError("config_changed");
  const file = cloneFile(state.approvals.file);
  if (state.layers.askFallback === "agent") file.agents[agentId].askFallback = value;
  else file.defaults = { ...(record(file.defaults) ? file.defaults : {}), askFallback: value };
  await ctx.call("exec.approvals.set", { file, baseHash: state.approvals.hash });
}

async function updateApprovals(env     , request     ) {
  const { ctx } = env;
  const { mutationId, changes, expected } = request.approvals;
  const fields = Object.keys(changes);
  if (!fields.every((name) => FIELDS.includes(name))) return failure("invalid_request");
  if (fields.includes("execMode") && !EXEC_MODES.includes(changes.execMode)) return failure("invalid_request");
  if (fields.includes("askFallback") && !FALLBACKS.includes(changes.askFallback)) return failure("invalid_request");
  if (fields.includes("execMode") && !ctx.advertises("config.patch")) return { status: "unsupported" };
  if (fields.includes("askFallback") && !ctx.advertises("exec.approvals.set")) return { status: "unsupported" };
  let state     ;
  try {
    state = await readState(ctx, request.profileId);
  } catch (error     ) {
    return readFailure(error);
  }
  for (const name of fields) {
    if (state.fields[name].revision !== expected[name]) return failure("config_conflict");
    if (!state.fields[name].writable) return failure("managed_setting");
  }
  remember(ctx, mutationId, { kind: "approvals", outcome: "unknown", changedFields: [...fields], changes: { ...changes } });
  let written = 0;
  try {

    for (const name of ["execMode", "askFallback"].filter((field) => fields.includes(field))) {
      if (name === "execMode") await writeExecMode(ctx, state, request.profileId, changes.execMode);
      else await writeAskFallback(ctx, state, request.profileId, changes.askFallback);
      written += 1;
    }
  } catch (error     ) {
    const code = writeFailureCode(error);

    if (written === 0 && code !== "outcome_unknown") {
      receipts(ctx).delete(mutationId);
      return failure(code);
    }
    return failure("outcome_unknown");
  }
  const receipt = { mutationId, outcome: "committed", changedFields: [...fields] };
  remember(ctx, mutationId, { kind: "approvals", ...receipt, changes: { ...changes } });
  try {
    return { status: "ok", approvals: approvalsSnapshot(await readState(ctx, request.profileId), receipt) };
  } catch {

    return failure("outcome_unknown");
  }
}

async function approvalsReceipt(env     , request     , recover     ) {
  const { ctx } = env;
  const { mutationId } = request.approvals;
  let state     ;
  try {
    state = await readState(ctx, request.profileId);
  } catch (error     ) {
    return readFailure(error);
  }
  const stored = receipts(ctx).get(mutationId);
  const known = stored && stored.kind === "approvals" ? stored : null;
  if (!recover) {
    const receipt = known
      ? { mutationId, outcome: known.outcome, changedFields: [...known.changedFields] }
      : { mutationId, outcome: "unknown", changedFields: [] };
    return { status: "ok", approvals: approvalsSnapshot(state, receipt) };
  }
  const fields = [...request.approvals.fields];
  let outcome = "reconciled_unknown";
  if (known?.outcome === "committed") outcome = "committed";
  else if (known && fields.every((name) => known.changes[name] !== undefined &&
    state.fields[name]?.effectiveValue === known.changes[name])) outcome = "committed";
  remember(ctx, mutationId, { kind: "approvals", outcome, changedFields: fields, changes: known?.changes || {} });
  return { status: "ok", approvals: approvalsSnapshot(state, { mutationId, outcome, changedFields: fields }) };
}

function sanitizedPattern(value     ) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return text.length > PATTERN_LIMIT ? `${text.slice(0, PATTERN_LIMIT - 1)}…` : text;
}

async function rememberedRows(ctx     , file     , agentId     ) {
  const rows      = [];
  const agent = approvalsAgent(file, agentId);
  const allowlist = Array.isArray(agent?.allowlist) ? agent.allowlist : [];
  allowlist.forEach((entry     , position     ) => {
    if (!record(entry) || entry.source !== "allow-always") return;
    const pattern = sanitizedPattern(entry.pattern);
    if (!pattern) return;
    rows.push({ pattern, semantics: "case_sensitive_command_glob",
      ref: { kind: "allowlist", id: typeof entry.id === "string" ? entry.id : null, pattern: entry.pattern, position } });
  });
  if (ctx.advertises("exec.approval.grants.list")) {
    const listed      = await ctx.call("exec.approval.grants.list", {});
    const now = Date.now();
    for (const grant of Array.isArray(listed?.grants) ? listed.grants : []) {
      if (!record(grant) || grant.agentId !== agentId || typeof grant.grantId !== "string") continue;
      if (grant.revokedAtMs != null || (typeof grant.expiresAtMs === "number" && grant.expiresAtMs <= now)) continue;
      const pattern = sanitizedPattern(grant.command);
      if (!pattern) continue;
      rows.push({ pattern, semantics: "exact_command", ref: { kind: "grant", grantId: grant.grantId } });
    }
  }
  return rows.slice(0, LIST_LIMIT);
}

async function readPermissions(ctx     , agentId     ) {
  const state = await readState(ctx, agentId);
  const rows = await rememberedRows(ctx, state.approvals.file, agentId);
  return { state, rows, revision: digest(rows.map((row     ) => row.ref)) };
}

function permissionsSnapshot(ctx     , read     , extra      = {}) {
  return {
    cacheEffect: "fresh_profile_each_guard",
    sessionGrantEffect: "unchanged",
    applyTiming: "subsequent_guard_checks",
    mode: read.state.fields.execMode.effectiveValue,
    processYolo: read.state.processYolo,
    remembered: {
      revision: read.revision,
      writable: ctx.advertises("exec.approvals.set"),
      source: "user",
      entries: read.rows.map((row     , index     ) => ({ index, pattern: row.pattern, semantics: row.semantics, effect: "eligible" })),
    },
    ...extra,
  };
}

function sameRef(a     , b     ) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function revokeRow(ctx     , read     , agentId     , ref     ) {
  if (ref.kind === "grant") {
    if (!ctx.advertises("exec.approval.grants.revoke")) throw new OpenClawManagementError("unsupported");
    const result      = await ctx.call("exec.approval.grants.revoke", { grantId: ref.grantId });
    if (result?.outcome !== "revoked" && result?.outcome !== "already-revoked") throw new OpenClawManagementError("config_changed");
    return;
  }
  if (!read.state.approvals.hash) throw new OpenClawManagementError("config_changed");
  const file = cloneFile(read.state.approvals.file);
  const allowlist = file.agents?.[agentId]?.allowlist;
  const entry = Array.isArray(allowlist) ? allowlist[ref.position] : null;
  const matches = record(entry) && entry.source === "allow-always" && entry.pattern === ref.pattern &&
    (ref.id === null || entry.id === ref.id);
  if (!matches) throw new OpenClawManagementError("config_changed");
  allowlist.splice(ref.position, 1);
  await ctx.call("exec.approvals.set", { file, baseHash: read.state.approvals.hash });
}

async function revokePermission(env     , request     ) {
  const { ctx } = env;
  const { mutationId, revision, index } = request.permissions;
  let read     ;
  try {
    read = await readPermissions(ctx, request.profileId);
  } catch (error     ) {
    return readFailure(error);
  }
  if (read.revision !== revision || index >= read.rows.length) return failure("config_conflict");
  const ref = read.rows[index].ref;
  remember(ctx, mutationId, { kind: "permissions", outcome: "unknown", changedFields: ["remembered"], ref });
  try {
    await revokeRow(ctx, read, request.profileId, ref);
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && error.code === "unsupported") {
      receipts(ctx).delete(mutationId);
      return { status: "unsupported" };
    }
    const code = writeFailureCode(error);
    if (code !== "outcome_unknown") receipts(ctx).delete(mutationId);
    return failure(code);
  }
  const receipt = { mutationId, outcome: "committed", changedFields: ["remembered"] };
  remember(ctx, mutationId, { kind: "permissions", ...receipt, ref });
  try {
    return { status: "ok", permissions: permissionsSnapshot(ctx, await readPermissions(ctx, request.profileId), { receipt }) };
  } catch {
    return failure("outcome_unknown");
  }
}

async function permissionsReceipt(env     , request     , recover     ) {
  const { ctx } = env;
  const { mutationId } = request.permissions;
  let read     ;
  try {
    read = await readPermissions(ctx, request.profileId);
  } catch (error     ) {
    return readFailure(error);
  }
  const stored = receipts(ctx).get(mutationId);
  const known = stored && stored.kind === "permissions" ? stored : null;
  if (!recover) {
    const receipt = known
      ? { mutationId, outcome: known.outcome, changedFields: [...known.changedFields] }
      : { mutationId, outcome: "unknown", changedFields: [] };
    return { status: "ok", permissions: permissionsSnapshot(ctx, read, { receipt }) };
  }
  const kind = request.permissions.kind;
  let outcome = "reconciled_unknown";
  if (known?.outcome === "committed") outcome = "committed";

  else if (known?.ref && !read.rows.some((row     ) => sameRef(row.ref, known.ref))) outcome = "committed";
  remember(ctx, mutationId, { kind: "permissions", outcome, changedFields: [kind], ref: known?.ref || null });
  return { status: "ok", permissions: permissionsSnapshot(ctx, read, { receipt: { mutationId, outcome, changedFields: [kind] } }) };
}

function approvalsSummaryMode(config     , agentId     ) {
  return execModeField(config, agentId).field.effectiveValue;
}

function supportsOperation(ctx     , operation     ) {
  const reads = ctx.advertisesAll("config.get", "exec.approvals.get");
  switch (operation) {
    case "approvals.read":
    case "approvals.receipt":
    case "approvals.recover":
    case "permissions.read":
    case "permissions.receipt":
    case "permissions.recover":
      return reads;
    case "approvals.update":
      return reads && (ctx.advertises("config.patch") || ctx.advertises("exec.approvals.set"));
    case "permissions.revoke":
      return reads && ctx.advertises("exec.approvals.set");
    default:
      return false;
  }
}

const approvalsSection = {
  id: "approvals",
  operations: [
    { operation: "approvals.read", scope: "profile" },
    { operation: "approvals.update", scope: "profile" },
    { operation: "approvals.receipt", scope: "profile" },
    { operation: "approvals.recover", scope: "profile" },
    { operation: "permissions.read", scope: "profile" },
    { operation: "permissions.revoke", scope: "profile" },
    { operation: "permissions.receipt", scope: "profile" },
    { operation: "permissions.recover", scope: "profile" },
    { operation: "permissions.preview", scope: "profile" },
  ],
  supports: (ctx     , operation     ) => supportsOperation(ctx, operation),
  async handle(env     , request     ) {
    if (!env.ctx.connected()) throw new OpenClawManagementError("management_unavailable");
    if (!(await servedAgent(env, request.profileId))) return failure("profile_not_served");
    switch (request.operation) {
      case "approvals.read":
        try {
          return { status: "ok", approvals: approvalsSnapshot(await readState(env.ctx, request.profileId)) };
        } catch (error     ) {
          return readFailure(error);
        }
      case "approvals.update":
        return updateApprovals(env, request);
      case "approvals.receipt":
        return approvalsReceipt(env, request, false);
      case "approvals.recover":
        return approvalsReceipt(env, request, true);
      case "permissions.read":
        try {
          return { status: "ok", permissions: permissionsSnapshot(env.ctx, await readPermissions(env.ctx, request.profileId)) };
        } catch (error     ) {
          return readFailure(error);
        }
      case "permissions.revoke":
        return revokePermission(env, request);
      case "permissions.receipt":
        return permissionsReceipt(env, request, false);
      case "permissions.recover":
        return permissionsReceipt(env, request, true);
      default:
        throw new OpenClawManagementError("unsupported");
    }
  },
};

module.exports = { approvalsSummaryMode, approvalsSection };
