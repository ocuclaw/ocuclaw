const { createHash } = require("node:crypto");
const { OpenClawManagementError } = require("./shared.cjs");

const OPERATIONS = ["skills.pending", "skills.review", "skills.decide", "skills.receipt"];
const PENDING_MAX = 100;
const OPERATIONS_MAX = 20;

const REVIEW_MAX_BYTES = 480 * 1024;
const RECEIPTS_MAX = 64;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

const receiptStores = new WeakMap();

function receiptsFor(ctx     ) {
  let store = receiptStores.get(ctx);
  if (!store) { store = new Map(); receiptStores.set(ctx, store); }
  return store;
}

function remember(ctx     , operationId     , receipt     ) {
  const store = receiptsFor(ctx);
  store.delete(operationId);
  store.set(operationId, receipt);
  while (store.size > RECEIPTS_MAX) store.delete(store.keys().next().value);
}

function digest(value     ) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value     ) {
  return typeof value === "string" ? value.trim() : "";
}

function timeMs(value     ) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function servedAgent(env     , request     ) {
  const agentId = request.profileId;
  if (!(await env.agents()).some((row     ) => row.id === agentId)) {
    throw new OpenClawManagementError("profile_not_served");
  }
  return agentId;
}

function headOf(row     ) {
  const name = text(row?.skillName) || text(row?.target?.skillName) || text(row?.skillKey);
  if (!name || !ID.test(text(row?.id))) return null;
  return { name, action: row.kind === "create" ? "create" : "edit" };
}

function proposalRevision(revisionHash     ) {
  return digest(["openclaw-skill-proposal", revisionHash ?? null]);
}

function summary(row     ) {
  const head = headOf(row);
  if (!head) return null;
  const out      = {
    id: row.id,
    proposalRevision: proposalRevision(row.revisionHash),
    operations: [{ action: head.action, name: head.name }],
  };
  const createdAt = timeMs(row.createdAt);
  if (createdAt !== null) out.createdAt = createdAt;
  return out;
}

async function pending(env     , request     ) {
  const agentId = await servedAgent(env, request);
  const listing      = await env.ctx.call("skills.proposals.list", { agentId });
  const rows = Array.isArray(listing?.proposals) ? listing.proposals : [];
  const records = rows.filter((row     ) => row?.status === "pending").map(summary).filter(Boolean).slice(0, PENDING_MAX);
  return { count: records.length, records };
}

async function inspect(env     , agentId     , proposalId     ) {
  try {
    return await env.ctx.call("skills.proposals.inspect", { agentId, proposalId });
  } catch (error     ) {

    if (error instanceof OpenClawManagementError && error.hostCode) throw new OpenClawManagementError("stale_review");
    throw error;
  }
}

async function currentSkill(env     , agentId     , name     ) {
  if (!env.ctx.advertises("skills.workshop.read")) return null;
  try {
    const skill      = await env.ctx.call("skills.workshop.read", { agentId, name });
    return typeof skill?.content === "string" ? skill.content : null;
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && (error.hostCode || error.code === "unsupported")) return null;
    throw error;
  }
}

async function review(env     , request     ) {
  const agentId = await servedAgent(env, request);
  const inspected      = await inspect(env, agentId, request.skills.proposalId);
  const record = inspected?.record;
  const head = headOf({ ...record, skillName: record?.target?.skillName });
  if (!head || typeof inspected.content !== "string") throw new OpenClawManagementError("stale_review");
  const supportFiles = Array.isArray(inspected.supportFiles) ? inspected.supportFiles
    .filter((file     ) => typeof file?.path === "string" && typeof file?.content === "string") : [];
  if (supportFiles.length + 1 > OPERATIONS_MAX) throw new OpenClawManagementError("review_too_large");
  const exists = head.action === "edit";
  const current = exists ? await currentSkill(env, agentId, head.name) : null;
  const files = current === null ? [] : [{ path: "SKILL.md", content: current, encoding: "utf8" }];
  const row      = {
    id: record.id,
    proposalRevision: proposalRevision(inspected.revisionHash ?? record.revisionHash),
    operations: [
      { action: head.action, name: head.name, content: inspected.content },
      ...supportFiles.map((file     ) => ({ action: "write_file", name: head.name, file_path: file.path, file_content: file.content })),
    ],
    previewKind: "complete_operations",
    targetRevision: digest(["openclaw-skill-target", head.name, exists, files]),
    targets: [{ name: head.name, exists, files }],
  };
  if (text(record.createdBy)) row.origin = text(record.createdBy);
  const createdAt = timeMs(record.createdAt);
  if (createdAt !== null) row.createdAt = createdAt;
  if (new TextEncoder().encode(JSON.stringify(row)).length > REVIEW_MAX_BYTES) throw new OpenClawManagementError("review_too_large");
  return { review: row, status: record.status, revisionHash: inspected.revisionHash ?? record.revisionHash };
}

function receiptOf(record     , status     ) {
  const applied = status === "approved";
  const unknown = status === "uncertain";
  const receipt      = {
    operationId: record.operationId,
    status,
    proposalId: record.proposalId,
    decision: record.decision,
    proposalRevision: record.proposalRevision,
    targetRevision: record.targetRevision,
    operations: record.operations.map((op     , index     ) => ({
      index,
      name: op.name,
      action: op.action,
      execution: applied ? "applied" : unknown ? "applying" : "not_attempted",
      finalState: applied ? "still_applied" : unknown ? "unknown" : "unchanged",
    })),
    rollback: [],
  };
  if (record.alreadyResolved) receipt.alreadyResolved = true;
  return receipt;
}

async function decide(env     , request     ) {
  const { ctx } = env;
  const ask = request.skills;
  const known = receiptsFor(ctx).get(ask.operationId);
  if (known) {

    if (known.proposalId !== ask.proposalId || known.decision !== ask.decision ||
        known.proposalRevision !== ask.proposalRevision || known.targetRevision !== ask.targetRevision) {
      throw new OpenClawManagementError("operation_conflict");
    }
    return { receipt: receiptOf(known, known.status) };
  }
  const agentId = await servedAgent(env, request);
  const current = await review(env, { ...request, skills: { proposalId: ask.proposalId } });
  const record      = {
    operationId: ask.operationId,
    proposalId: ask.proposalId,
    decision: ask.decision,
    proposalRevision: ask.proposalRevision,
    targetRevision: ask.targetRevision,
    operations: current.review.operations,
    status: "uncertain",
  };
  if (current.status !== "pending") {
    record.status = "already_resolved";
    record.alreadyResolved = true;
    remember(ctx, ask.operationId, record);
    return { receipt: receiptOf(record, record.status) };
  }
  if (current.review.proposalRevision !== ask.proposalRevision || current.review.targetRevision !== ask.targetRevision) {
    throw new OpenClawManagementError("stale_review");
  }
  remember(ctx, ask.operationId, record);
  const method = ask.decision === "approve" ? "skills.proposals.apply" : "skills.proposals.reject";
  try {
    await ctx.call(method, { agentId, proposalId: ask.proposalId, expectedRevisionHash: current.revisionHash });
  } catch (error     ) {
    if (error instanceof OpenClawManagementError && error.code === "config_changed") {
      receiptsFor(ctx).delete(ask.operationId);
      throw new OpenClawManagementError("stale_review");
    }

    if (error instanceof OpenClawManagementError && error.hostCode) record.status = "not_applied";
    remember(ctx, ask.operationId, record);
    return { receipt: receiptOf(record, record.status) };
  }
  record.status = ask.decision === "approve" ? "approved" : "rejected";
  remember(ctx, ask.operationId, record);
  return { receipt: receiptOf(record, record.status) };
}

const SETTLED      = { applied: "approved", rejected: "rejected", pending: "not_applied" };

async function receipt(env     , request     ) {
  const { operationId } = request.skills;
  const known = receiptsFor(env.ctx).get(operationId);
  if (!known) return { receipt: { operationId, status: "not_found", operations: [], rollback: [] } };
  if (known.status === "uncertain") {

    const agentId = await servedAgent(env, request);
    let status      = "resolved_externally";
    try {
      const inspected      = await env.ctx.call("skills.proposals.inspect", { agentId, proposalId: known.proposalId });
      const settled = SETTLED[inspected?.record?.status];
      const ours = known.decision === "approve" ? "approved" : "rejected";
      if (settled === ours || settled === "not_applied") status = settled;
    } catch (error     ) {
      if (!(error instanceof OpenClawManagementError && error.hostCode)) throw error;
    }
    known.status = status;
    remember(env.ctx, operationId, known);
  }
  return { receipt: receiptOf(known, known.status) };
}

const skillProposalsSection = {
  id: "skillProposals",
  operations: OPERATIONS.map((operation     ) => ({ operation, scope: "profile" })),
  supports(ctx     , operation     ) {
    if (!ctx.advertisesAll("skills.proposals.list", "skills.proposals.inspect")) return false;
    if (operation === "skills.decide") return ctx.advertisesAll("skills.proposals.apply", "skills.proposals.reject");
    return true;
  },
  async handle(env     , request     ) {
    if (!request.skills) throw new OpenClawManagementError("invalid_request");
    switch (request.operation) {
      case "skills.pending": return { status: "ok", skills: await pending(env, request) };
      case "skills.review": return { status: "ok", skills: { review: (await review(env, request)).review } };
      case "skills.decide": return { status: "ok", skills: await decide(env, request) };
      default: return { status: "ok", skills: await receipt(env, request) };
    }
  },
};

async function pendingProposalCount(ctx     , agentId     ) {
  if (!skillProposalsSection.supports(ctx, "skills.pending")) return null;
  try {
    const listing      = await ctx.call("skills.proposals.list", { agentId });
    const rows = Array.isArray(listing?.proposals) ? listing.proposals : [];
    return Math.min(rows.filter((row     ) => row?.status === "pending" && headOf(row)).length, PENDING_MAX);
  } catch {
    return null;
  }
}

module.exports = { skillProposalsSection, pendingProposalCount };
