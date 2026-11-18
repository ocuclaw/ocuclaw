const { createHash } = require("node:crypto");
const { findConfiguredAgent } = require("../../gateway/openclaw-agent-roster.cjs");
const { OpenClawManagementError } = require("./shared.cjs");

const GROUPS      = {
  web: ["web_search", "web_fetch"],
  files: ["read", "write", "edit", "apply_patch"],
  terminal: ["exec", "process"],
};
const GROUP_IDS = ["web", "files", "terminal"];
const PROFILES = ["minimal", "coding", "messaging", "full"];
const SKILLS_MAX = 500;
const RECEIPTS_MAX = 64;
const WRITES = new Set(["tools.block", "tools.skillToggle", "tools.profile"]);
const KIND      = { "tools.block": "blocks", "tools.skillToggle": "skills", "tools.profile": "profile" };

const PROJECT_SOURCES = ["openclaw-workspace", "agents-skills-project"];
const PROFILE_SOURCES = ["openclaw-managed", "agents-skills-personal"];

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

function text(value     , max     ) {
  const clean = typeof value === "string" ? value.replace(/[\u0000-\u001f]+/g, " ").trim() : "";
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function blockedGroups(deny     ) {
  const denied = new Set(Array.isArray(deny) ? deny.filter((tool     ) => typeof tool === "string") : []);
  return GROUP_IDS.filter((group     ) => GROUPS[group].every((tool     ) => denied.has(tool)));
}

function profileOf(agent     ) {
  const value = typeof agent?.tools?.profile === "string" ? agent.tools.profile.trim() : "";
  return PROFILES.includes(value) ? value : "default";
}

function originOf(source     ) {
  if (PROJECT_SOURCES.includes(source)) return "project";
  if (PROFILE_SOURCES.includes(source)) return "profile";
  return "external";
}

function unavailableReason(row     ) {
  const missing = row?.missing && typeof row.missing === "object" ? row.missing : {};
  const list = (key     ) => (Array.isArray(missing[key]) ? missing[key].filter((x     ) => typeof x === "string") : []);
  const parts      = [];
  if (row?.platformIncompatible === true || list("os").length > 0) parts.push("Not supported on this computer.");
  const bins = [...list("bins"), ...list("anyBins")];
  if (bins.length > 0) parts.push(`Needs ${bins.join(", ")} installed.`);
  if (list("env").length > 0) parts.push(`Needs ${list("env").join(", ")} set.`);
  if (list("config").length > 0) parts.push(`Needs ${list("config").join(", ")} in the config.`);
  if (row?.blockedByAgentFilter === true) parts.push("This agent's skill list leaves it out.");
  return text(parts.join(" "), 512);
}

function skillRows(status     , writable     ) {
  const rows = Array.isArray(status?.skills) ? status.skills : [];
  const seen = new Set();
  const skills      = [];
  for (const row of rows) {
    const name = text(row?.skillKey || row?.name, 160);
    if (!name || seen.has(name) || skills.length >= SKILLS_MAX) continue;
    seen.add(name);
    const globalBlocked = row.blockedByAllowlist === true;
    const reason = unavailableReason(row);
    skills.push({
      name,
      description: text(row.description, 240),
      reason,
      origin: originOf(row.source),
      contentRevision: digest([name, row.source ?? null, row.filePath ?? null]),
      overrides: 0,
      available: !reason,
      essential: false,
      enabled: row.disabled !== true && !globalBlocked,
      globalBlocked,
      writable: writable && !globalBlocked,
    });
  }
  return skills;
}

function enabledSkillCount(status     ) {
  return skillRows(status, false).filter((row     ) => row.enabled).length;
}

async function readSnapshot(env     , request     ) {
  const { ctx } = env;
  const agentId = request.profileId;
  if (!(await env.agents()).some((row     ) => row.id === agentId)) {
    throw new OpenClawManagementError("profile_not_served");
  }
  const [{ config, hash }, status] = await Promise.all([
    ctx.readConfig(),
    ctx.call("skills.status", { agentId }),
  ]);
  const agent = findConfiguredAgent(config, agentId);
  const blocked = blockedGroups(agent?.tools?.deny);
  const profile = profileOf(agent);
  const canWriteTools = supportsToolWrites(ctx);
  const installedSkills = skillRows(status, ctx.advertises("skills.update"));
  return {
    hash,
    blocked,
    tools: {
      platform: "openclaw",
      blocksRevision: digest({ agentId, blocked, profile }),
      skillsRevision: digest(installedSkills.map((row     ) => [row.name, row.enabled, row.globalBlocked])),
      applyTiming: "new_chat",
      refresh: "reload_skills_then_new_chat",
      tools: GROUP_IDS.map((id     ) => ({
        id, blocked: blocked.includes(id), writable: canWriteTools, availableTools: null, state: "not_checked",
      })),
      profile: { value: profile, writable: canWriteTools },
      installedSkills,
    },
  };
}

function supportsToolWrites(ctx     ) {
  return typeof ctx.agentTools?.setAgentTools === "function" &&
    ctx.advertisesAll("config.get", "config.patch");
}

const WRITER_REFUSALS      = {
  config_changed: "config_conflict",
  invalid_settings: "invalid_request",
  invalid_agent_id: "invalid_request",
  agent_not_found: "profile_not_served",
  host_migration_needed: "host_migration_needed",
};

async function applyChange(env     , request     , current     ) {
  const { ctx } = env;
  const change = request.tools;
  if (request.operation === "tools.skillToggle") {
    const skill = current.tools.installedSkills.find((row     ) => row.name === change.name);
    if (!skill || !skill.writable) throw new OpenClawManagementError("managed_setting");
    await ctx.call("skills.update", { skillKey: change.name, enabled: change.value });
    return;
  }
  const input      = { agentId: request.profileId, baseHash: current.hash };
  if (request.operation === "tools.block") {
    const blocked = new Set(current.blocked);
    if (change.value) blocked.add(change.name); else blocked.delete(change.name);
    input.blockedTools = GROUP_IDS.filter((id     ) => blocked.has(id));
  } else {
    input.toolProfile = change.name === "default" ? "" : change.name;
  }
  try {
    await ctx.agentTools.setAgentTools(input);
  } catch (error     ) {
    throw new OpenClawManagementError(WRITER_REFUSALS[error?.code] || "outcome_unknown");
  }
}

async function write(env     , request     ) {
  const { ctx } = env;
  const change = request.tools;
  const kind = KIND[request.operation];
  const known = receiptsFor(ctx).get(change.mutationId);

  if (known) return { ...(await readSnapshot(env, request)).tools, receipt: known };
  if (ctx.now() > change.expiresAtMs) throw new OpenClawManagementError("intent_expired");
  const current = await readSnapshot(env, request);
  const revision = kind === "skills" ? current.tools.skillsRevision : current.tools.blocksRevision;
  if (revision !== change.revision) throw new OpenClawManagementError("config_conflict");
  remember(ctx, change.mutationId, { mutationId: change.mutationId, outcome: "unknown", changedFields: [kind] });
  try {
    await applyChange(env, request, current);
  } catch (error     ) {

    if (error instanceof OpenClawManagementError && error.code !== "outcome_unknown" && error.code !== "management_unavailable") {
      receiptsFor(ctx).delete(change.mutationId);
    }
    throw error;
  }
  const receipt = { mutationId: change.mutationId, outcome: "committed", changedFields: [kind] };
  remember(ctx, change.mutationId, receipt);
  const after = await readSnapshot(env, request);
  return { ...after.tools, receipt };
}

async function settle(env     , request     ) {
  const { ctx } = env;
  const { mutationId } = request.tools;
  const current = await readSnapshot(env, request);
  const known = receiptsFor(ctx).get(mutationId);
  if (request.operation === "tools.receipt") {
    return { ...current.tools, receipt: known || { mutationId, outcome: "unknown", changedFields: [] } };
  }
  const kind = request.tools.kind;
  const receipt = known?.outcome === "committed" && known.changedFields[0] === kind
    ? known : { mutationId, outcome: "reconciled_unknown", changedFields: [kind] };
  remember(ctx, mutationId, receipt);
  return { ...current.tools, receipt };
}

const skillsSection = {
  id: "skills",
  operations: [
    { operation: "tools.read", scope: "profile" },
    { operation: "tools.block", scope: "profile" },
    { operation: "tools.profile", scope: "profile" },
    { operation: "tools.skillToggle", scope: "profile" },
    { operation: "tools.receipt", scope: "profile" },
    { operation: "tools.recover", scope: "profile" },
  ],
  supports(ctx     , operation     ) {
    if (!ctx.advertisesAll("config.get", "skills.status")) return false;
    if (operation === "tools.block" || operation === "tools.profile") return supportsToolWrites(ctx);
    if (operation === "tools.skillToggle") return ctx.advertises("skills.update");
    return true;
  },
  async handle(env     , request     ) {
    if (!request.tools) throw new OpenClawManagementError("invalid_request");
    if (WRITES.has(request.operation)) return { status: "ok", tools: await write(env, request) };
    if (request.operation === "tools.read") return { status: "ok", tools: (await readSnapshot(env, request)).tools };
    return { status: "ok", tools: await settle(env, request) };
  },
};

module.exports = { enabledSkillCount, skillsSection };
