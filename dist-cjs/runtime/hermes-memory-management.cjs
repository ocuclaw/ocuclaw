const MEMORY_OPERATIONS = ["memory.pending", "memory.review", "memory.decide", "memory.receipt"];
const fields                           = {
  "memory.pending": [], "memory.review": ["proposalId"], "memory.receipt": ["operationId"],
  "memory.decide": ["operationId", "proposalId", "decision", "proposalRevision", "targetRevision"],
};

function memoryRequest(operation        , value     )      {
  const required = fields[operation];
  if (!required) return null;
  const input = value ?? {};
  if (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== required.length) return null;
  const result      = {};
  for (const key of required) {
    const pattern = key.endsWith("Revision") ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9_-]{1,128}$/;
    if (typeof input[key] !== "string" || !pattern.test(input[key])) return null;
    result[key] = input[key];
  }
  if (operation === "memory.decide" && !["approve", "reject"].includes(result.decision)) return null;
  return result;
}

function payload(value     )      {
  if (!value || !["memory", "user"].includes(value.target ?? "memory")) throw new Error("Invalid target");
  const operation = (op     )      => {
    if (!op || !["add", "replace", "remove"].includes(op.action)) throw new Error("Invalid operation");
    const item      = { action: op.action };
    for (const key of ["content", "old_text", "new_text"]) {
      if (op[key] != null) {
        if (typeof op[key] !== "string") throw new Error("Invalid operation text");
        item[key] = op[key];
      }
    }
    return item;
  };
  if (value.action === "batch") {
    if (!Array.isArray(value.operations)) throw new Error("Invalid batch");
    return { action: "batch", target: value.target ?? "memory", operations: value.operations.map(operation) };
  }
  return { ...operation(value), target: value.target ?? "memory" };
}

function record(value     , review = false)      {
  if (!value || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
      typeof value.proposalRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.proposalRevision)) throw new Error("Invalid proposal");
  const result      = { id: value.id, proposalRevision: value.proposalRevision, payload: payload(value.payload) };
  if (typeof value.origin === "string") result.origin = value.origin;
  if (typeof value.createdAt === "number" && Number.isFinite(value.createdAt)) result.createdAt = value.createdAt;
  if (review) {
    if (typeof value.before !== "string" || typeof value.after !== "string" ||
        typeof value.valid !== "boolean" || !/^[a-f0-9]{64}$/.test(value.targetRevision)) throw new Error("Incomplete review");
    Object.assign(result, { before: value.before, after: value.after, valid: value.valid, targetRevision: value.targetRevision });
    if (typeof value.sourceConversation === "string") result.sourceConversation = value.sourceConversation;
  }
  return result;
}

function memoryResult(operation        , value     , request      )      {
  if (!value || JSON.stringify(value).length > 524288) throw new Error("Memory evidence too large");
  if (operation === "memory.pending") {
    if (!Array.isArray(value.records) || !Number.isSafeInteger(value.count) || value.count !== value.records.length) throw new Error("Incomplete pending list");
    return { count: value.count, records: value.records.map((row     ) => record(row)) };
  }
  if (operation === "memory.review") {
    const review = record(value.review, true);
    if (request && review.id !== request.proposalId) throw new Error("Review identity mismatch");
    return { review };
  }
  const receipt = value.receipt;
  if (!receipt || typeof receipt.operationId !== "string" ||
      !["approved", "rejected", "uncertain", "not_applied", "not_found", "stale_review", "validation_failed", "already_resolved", "resolved_externally"].includes(receipt.status)) throw new Error("Invalid receipt");
  if (request && (receipt.operationId !== request.operationId ||
      (operation === "memory.decide" && receipt.proposalId !== request.proposalId))) throw new Error("Receipt identity mismatch");
  if (!receipt.alreadyResolved && ["approved", "rejected"].includes(receipt.status)) {
    const decision = receipt.status === "approved" ? "approve" : "reject";
    if ((receipt.decision != null && receipt.decision !== decision) ||
        (operation === "memory.decide" && request && request.decision !== decision)) throw new Error("Receipt decision mismatch");
  }
  const result      = { operationId: receipt.operationId, status: receipt.status };
  for (const key of ["proposalId", "decision", "proposalRevision", "targetRevision", "beforeRevision", "afterRevision"]) {
    if (receipt[key] == null) continue;
    const pattern = key.endsWith("Revision") ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9_-]{1,128}$/;
    if (typeof receipt[key] !== "string" || !pattern.test(receipt[key])) throw new Error("Invalid receipt field");
    if (key === "decision" && !["approve", "reject"].includes(receipt[key])) throw new Error("Invalid receipt decision");
    if (request && operation === "memory.decide" && !receipt.alreadyResolved &&
        ["decision", "proposalRevision", "targetRevision"].includes(key) && receipt[key] !== request[key]) throw new Error("Receipt evidence mismatch");
    result[key] = receipt[key];
  }
  if (typeof receipt.createdAt === "number" && Number.isFinite(receipt.createdAt)) result.createdAt = receipt.createdAt;
  if (receipt.alreadyResolved === true) result.alreadyResolved = true;
  return { receipt: result };
}

const MEMORY_ERRORS                         = {
  stale_review: "The proposal or target changed. Open it again and review the current content.",
  already_resolved: "This proposal is already resolved. Refresh Pending.",
  validation_failed: "The proposal could not apply. Check its operations and memory capacity in Hermes.",
  recovery_required: "A native decision has an uncertain outcome. Check its durable receipt before another decision.",
  operation_conflict: "This operation ID belongs to another decision. No new change was applied.",
  review_too_large: "The complete review is too large for this connection. Review it in native Hermes.",
};

module.exports = { MEMORY_OPERATIONS, MEMORY_ERRORS, memoryRequest, memoryResult };
