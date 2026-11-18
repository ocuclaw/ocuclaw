const { createHash } = require("node:crypto");
const { OpenClawManagementError } = require("./shared.cjs");
const { SAVED_SEARCH_RESULTS_MAX, SAVED_SEARCH_SNIPPET_MAX } = require("../hermes-saved-management.cjs");

const FILES = [
  { kind: "memory", name: "MEMORY.md" },
  { kind: "user", name: "USER.md" },
];

const CONTENT_MAX_BYTES = 200 * 1024;
const PREVIEW_CHARS = 240;
const RECEIPTS_MAX = 64;
const OPERATIONS = ["saved.list", "saved.read", "saved.preview", "saved.mutate", "saved.receipt", "saved.recover", "saved.search"];

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
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function bytes(value     ) {
  return new TextEncoder().encode(value).length;
}

function entryId(agentId     , name     ) {
  return digest(["openclaw-saved", agentId, name]);
}

async function readFile(env     , agentId     , file     ) {
  const reply      = await env.ctx.call("agents.files.get", { agentId, name: file.name });
  const row = reply?.file;
  const content = row && row.missing !== true && typeof row.content === "string" ? row.content : null;
  return {
    ...file,
    id: entryId(agentId, file.name),
    content,

    hostHash: typeof row?.hash === "string" && row.hash ? row.hash : null,
    targetRevision: digest(content ?? ""),
  };
}

async function servedAgent(env     , request     ) {
  const agentId = request.profileId;
  if (!(await env.agents()).some((row     ) => row.id === agentId)) {
    throw new OpenClawManagementError("profile_not_served");
  }
  return agentId;
}

async function readFiles(env     , agentId     ) {
  return Promise.all(FILES.map((file     ) => readFile(env, agentId, file)));
}

function shown(file     ) {
  return typeof file.content === "string" && file.content.trim() !== "";
}

function summary(file     ) {
  return {
    id: file.id,
    kind: file.kind,
    name: file.name,
    targetRevision: file.targetRevision,
    contentPreview: file.content.slice(0, PREVIEW_CHARS),
    contentLength: file.content.length,
  };
}

async function list(env     , request     ) {
  const agentId = await servedAgent(env, request);
  const files = await readFiles(env, agentId);
  const records = files.filter(shown).map(summary);
  return {
    records,
    targets: files.map((file     ) => ({
      kind: file.kind,
      enabled: true,
      count: shown(file) ? 1 : 0,
      used: bytes(file.content ?? ""),
      limit: CONTENT_MAX_BYTES,
    })),
    applyTiming: "future_chat",
    externalProviderUnsupported: false,
  };
}

async function find(env     , request     , id     ) {
  const agentId = await servedAgent(env, request);
  const meta = FILES.find((file     ) => entryId(agentId, file.name) === id);
  if (!meta) throw new OpenClawManagementError("stale_review");
  const file = await readFile(env, agentId, meta);
  if (!shown(file)) throw new OpenClawManagementError("stale_review");
  return { agentId, file };
}

function entry(file     ) {
  return {
    id: file.id,
    kind: file.kind,
    name: file.name,
    targetRevision: file.targetRevision,
    content: file.content,
    applyTiming: "future_chat",
    removal: "permanent",
  };
}

function previewRevision(file     , action     , content     ) {
  return digest(["openclaw-saved-preview", file.id, file.targetRevision, action, content]);
}

function validationErrors(content     ) {
  return bytes(content) > CONTENT_MAX_BYTES ? [`This file is over ${CONTENT_MAX_BYTES / 1024} KB. Shorten it before saving.`] : [];
}

async function preview(env     , request     ) {
  const { action, content } = request.saved;
  const { file } = await find(env, request, request.saved.entryId);
  const after = action === "remove" ? "" : content;
  const errors = validationErrors(after);
  return {
    preview: {
      ...entry(file),
      action,
      proposedContent: content,
      valid: errors.length === 0,
      validationErrors: errors,
      previewRevision: previewRevision(file, action, content),
      beforeContent: file.content,
      afterContent: after,
      normalizesStoredEntries: false,
    },
  };
}

function receiptOf(record     , status     ) {
  return {
    operationId: record.operationId,
    status,
    entryId: record.entryId,
    previewRevision: record.previewRevision,
    action: record.action,
  };
}

async function settleFromFile(env     , request     , record     ) {
  const agentId = await servedAgent(env, request);
  const meta = FILES.find((file     ) => file.name === record.name);
  const file = await readFile(env, agentId, meta);
  const now = digest(file.content ?? "");
  if (now === record.afterRevision) return "applied";
  if (now === record.beforeRevision) return "not_applied";
  return "resolved_externally";
}

async function mutate(env     , request     ) {
  const { ctx } = env;
  const change = request.saved;
  const known = receiptsFor(ctx).get(change.operationId);
  if (known) {

    if (known.entryId !== change.entryId || known.previewRevision !== change.previewRevision || known.action !== change.action) {
      throw new OpenClawManagementError("operation_conflict");
    }
    return { receipt: receiptOf(known, known.status) };
  }
  if (ctx.now() > change.expiresAtMs) throw new OpenClawManagementError("intent_expired");
  const { agentId, file } = await find(env, request, change.entryId);
  if (previewRevision(file, change.action, change.content) !== change.previewRevision) {
    throw new OpenClawManagementError("stale_review");
  }
  const after = change.action === "remove" ? "" : change.content;
  if (validationErrors(after).length > 0) throw new OpenClawManagementError("validation_failed");
  const record      = {
    operationId: change.operationId,
    entryId: change.entryId,
    previewRevision: change.previewRevision,
    action: change.action,
    name: file.name,
    beforeRevision: file.targetRevision,
    afterRevision: digest(after),
    status: "uncertain",
  };
  remember(ctx, change.operationId, record);
  try {
    await ctx.call("agents.files.set", {
      agentId,
      name: file.name,
      content: after,
      ...(file.hostHash ? { expectedHash: file.hostHash } : {}),
    });
  } catch (error     ) {

    if (error instanceof OpenClawManagementError && (error.code === "config_changed" || error.hostCode)) {
      record.status = "not_applied";
      remember(ctx, change.operationId, record);
      if (error.code === "config_changed") throw new OpenClawManagementError("stale_review");
      return { receipt: { ...receiptOf(record, "not_applied"), validationRejected: true } };
    }
    return { receipt: receiptOf(record, "uncertain") };
  }
  record.status = "applied";
  remember(ctx, change.operationId, record);
  return { receipt: receiptOf(record, "applied") };
}

async function receipt(env     , request     ) {
  const { operationId } = request.saved;
  if (request.operation === "saved.recover" && env.ctx.now() > request.saved.expiresAtMs) {
    throw new OpenClawManagementError("intent_expired");
  }
  const known = receiptsFor(env.ctx).get(operationId);
  if (!known) return { receipt: { operationId, status: "not_found" } };
  if (known.status === "uncertain" && request.operation === "saved.recover") {
    known.status = await settleFromFile(env, request, known);
    remember(env.ctx, operationId, known);
  }
  return { receipt: receiptOf(known, known.status) };
}

async function read(env     , request     ) {
  const { file } = await find(env, request, request.saved.entryId);
  return { entry: { ...entry(file), files: [{ path: file.name, content: file.content, encoding: "utf8" }] } };
}

function excerpt(value     ) {
  const chars = Array.from(typeof value === "string" ? value.replace(/\u0000/g, "") : "");
  return chars.length > SAVED_SEARCH_SNIPPET_MAX ? chars.slice(0, SAVED_SEARCH_SNIPPET_MAX - 1).join("") + "…" : chars.join("");
}

async function search(env     , request     ) {
  const agentId = await servedAgent(env, request);
  const raw = await env.ctx.call("memory.search",
    { query: request.saved.query, agentId, maxResults: SAVED_SEARCH_RESULTS_MAX });
  if (!Array.isArray(raw?.results)) throw new OpenClawManagementError("management_unavailable");
  const results = raw.results.flatMap((row     ) => {
    const start = Number(row?.startLine);
    const end = Number(row?.endLine);
    if (typeof row?.path !== "string" || !row.path || row.path.length > 512 || !Number.isSafeInteger(start) || start < 1) return [];
    return [{ path: row.path, startLine: start, endLine: Number.isSafeInteger(end) && end >= start ? end : start,
      snippet: excerpt(row.snippet) }];
  });
  return { results: results.slice(0, SAVED_SEARCH_RESULTS_MAX) };
}

const memorySection = {
  id: "memory",
  operations: OPERATIONS.map((operation     ) => ({ operation, scope: "profile" })),
  supports(ctx     , operation     ) {
    if (operation === "saved.search") return ctx.advertises("memory.search");
    if (!ctx.advertises("agents.files.get")) return false;
    if (operation === "saved.mutate" || operation === "saved.preview") return ctx.advertises("agents.files.set");
    return true;
  },
  async handle(env     , request     ) {
    if (!request.saved) throw new OpenClawManagementError("invalid_request");
    switch (request.operation) {
      case "saved.list": return { status: "ok", saved: await list(env, request) };
      case "saved.read": return { status: "ok", saved: await read(env, request) };
      case "saved.preview": return { status: "ok", saved: await preview(env, request) };
      case "saved.mutate": return { status: "ok", saved: await mutate(env, request) };
      case "saved.search": return { status: "ok", saved: await search(env, request) };
      default: return { status: "ok", saved: await receipt(env, request) };
    }
  },
};

async function savedEntryCount(ctx     , agentId     ) {
  if (!ctx.advertises("agents.files.get")) return null;
  try {
    const files = await Promise.all(FILES.map((file     ) => readFile({ ctx }, agentId, file)));
    return files.filter(shown).length;
  } catch {
    return null;
  }
}

module.exports = { memorySection, savedEntryCount };
