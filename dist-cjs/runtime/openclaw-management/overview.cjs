const { OpenClawManagementError } = require("./shared.cjs");
const { approvalsSummaryMode } = require("./approvals.cjs");
const { jobsSummary } = require("./jobs.cjs");
const { pairingSummary } = require("./plugins.cjs");
const { savedEntryCount } = require("./memory.cjs");
const { pendingProposalCount } = require("./skill-proposals.cjs");
const { dreamingOn } = require("./dreaming.cjs");
const { heartbeatSummary } = require("./heartbeat.cjs");
const { diskFreeBytes, failedJobsThisWeek, hostStatfs, openclawStatePath } = require("./health.cjs");
const { enabledSkillCount } = require("./skills.cjs");
const { mcpSummary } = require("./connections.cjs");

const FACT_BUDGET_MS = 2500;

function text(value     ) {
  return typeof value === "string" ? value.trim() : "";
}

function modelParts(raw     ) {
  const value = text(typeof raw === "string" ? raw : raw?.primary);
  const slash = value.indexOf("/");
  if (!value) return { provider: "", model: "" };
  return slash > 0 ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : { provider: "", model: value };
}

async function defaultModel(ctx     ) {
  if (!ctx.advertises("config.get")) return "";
  try {
    const { config } = await ctx.readConfig();
    return text(typeof config?.agents?.defaults?.model === "string"
      ? config.agents.defaults.model : config?.agents?.defaults?.model?.primary);
  } catch {
    return "";
  }
}

async function approvalsMode(ctx     , agentId     ) {
  if (!ctx.advertises("config.get")) return null;
  try {
    return approvalsSummaryMode((await ctx.readConfig()).config, agentId);
  } catch {
    return null;
  }
}

function bounded(read                    , ms        ) {
  let timer     ;
  const late = new Promise((resolve     ) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([read().catch(() => null), late]).finally(() => clearTimeout(timer));
}

async function skillCount(ctx     , agentId     ) {
  if (!ctx.advertises("skills.status")) return null;
  return enabledSkillCount(await ctx.call("skills.status", { agentId }));
}

async function connectionCounts(ctx     ) {
  if (!ctx.advertises("config.get")) return null;
  return mcpSummary((await ctx.readConfig()).config);
}

async function toolsAndHealth(ctx     , agentId     , opts     ) {
  const [skills, connections, failedJobs7d, diskFree] = await Promise.all([
    bounded(() => skillCount(ctx, agentId), opts.budgetMs),
    bounded(() => connectionCounts(ctx), opts.budgetMs),
    bounded(() => failedJobsThisWeek(ctx, opts.now(), agentId), opts.budgetMs),
    bounded(() => diskFreeBytes(opts.statfs, opts.statePath), opts.budgetMs),
  ]);
  const summary      = { ...(connections || {}) };
  if (skills !== null) summary.skills = skills;
  if (failedJobs7d !== null) summary.failedJobs7d = failedJobs7d;
  if (diskFree !== null) summary.diskFreeBytes = Math.trunc(diskFree          );
  return summary;
}

function createOverviewSection(sectionOpts      = {}) {
  const opts = {
    now: typeof sectionOpts.now === "function" ? sectionOpts.now : () => Date.now(),
    statfs: typeof sectionOpts.statfs === "function" ? sectionOpts.statfs : hostStatfs,
    statePath: typeof sectionOpts.statePath === "string" ? sectionOpts.statePath : openclawStatePath(),
    budgetMs: Number.isFinite(sectionOpts.budgetMs) ? sectionOpts.budgetMs : FACT_BUDGET_MS,
  };
  return {
    id: "overview",
    operations: [
      { operation: "overview", scope: "profile" },
      { operation: "capabilities", scope: "profile" },
      { operation: "capabilities", scope: "gateway" },
    ],
    supports: () => true,
    async handle(env     , request     ) {
      const { ctx } = env;
      if (!ctx.connected()) throw new OpenClawManagementError("management_unavailable");
      const capabilities = await env.capabilities();
      if (request.operation === "capabilities") return { status: "ok", capabilities };
      const agents = await env.agents();
      const agent = agents.find((row     ) => row.id === request.profileId);
      if (!agent) return { status: "error", errorCode: "profile_not_served", capabilities };

      const facts = toolsAndHealth(ctx, agent.id, opts);
      const { provider, model } = modelParts(agent.primaryModel || await defaultModel(ctx));
      const overview      = {
        profileName: text(agent.name) || agent.id,
        gatewayState: "running",
        servedProfiles: agents.length,
      };
      if (model) overview.model = model;
      if (provider) overview.provider = provider;
      const mode = await approvalsMode(ctx, agent.id);
      if (mode) overview.summary = { ...overview.summary, approvalsMode: mode };
      const jobs = await jobsSummary(ctx, agent.id);
      if (jobs) overview.summary = { ...overview.summary, ...jobs };
      const pairing = await pairingSummary(ctx);
      if (pairing) overview.summary = { ...overview.summary, ...pairing };
      const saved = await savedEntryCount(ctx, agent.id);
      if (saved !== null) overview.summary = { ...overview.summary, savedEntries: saved };
      const dreaming = await dreamingOn(ctx);
      if (dreaming !== null) overview.summary = { ...overview.summary, reviewsOn: dreaming };
      const proposals = await pendingProposalCount(ctx, agent.id);
      if (proposals !== null) Object.assign(overview, { attentionCount: proposals, attentionKind: "learning_proposals" });
      const heartbeat = await heartbeatSummary(ctx, agent.id);
      if (heartbeat) overview.summary = { ...overview.summary, ...heartbeat };
      const extra = await facts;
      if (Object.keys(extra).length > 0) overview.summary = { ...overview.summary, ...extra };
      return { status: "ok", capabilities, overview };
    },
  };
}

const overviewSection = createOverviewSection();

module.exports = { createOverviewSection, overviewSection };
