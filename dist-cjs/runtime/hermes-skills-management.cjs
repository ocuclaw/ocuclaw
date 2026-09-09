const { memoryRequest } = require("./hermes-memory-management.cjs");

const SKILLS_OPERATIONS = ["skills.pending", "skills.review", "skills.decide", "skills.receipt"];
const skillsRequest = (operation        , value     )      =>
  SKILLS_OPERATIONS.includes(operation) ? memoryRequest(operation.replace("skills.", "memory."), value) : null;

const actions = ["create", "edit", "patch", "delete", "write_file", "remove_file"];
const id = (value     ) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const revision = (value     ) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const string = (value     ) => typeof value === "string";
function assert(condition     )                    { if (!condition) throw new Error("Incomplete skill evidence"); }

function operation(value     )      {
  assert(value && actions.includes(value.action) && string(value.name));
  const fields = ["action", "name", "content", "category", "file_path", "file_content", "old_string", "new_string", "absorbed_into"];
  assert(Object.keys(value).every(key => fields.includes(key) || key === "replace_all"));
  const result      = {};
  for (const key of fields) if (value[key] != null) { assert(string(value[key])); result[key] = value[key]; }
  if (value.replace_all != null) { assert(typeof value.replace_all === "boolean"); result.replace_all = value.replace_all; }
  return result;
}

function proposal(value     , full = false)      {
  assert(value && id(value.id) && revision(value.proposalRevision) && Array.isArray(value.operations) &&
    value.operations.length > 0 && value.operations.length <= 20);
  const row      = { id: value.id, proposalRevision: value.proposalRevision, operations: value.operations.map(operation) };
  for (const key of ["origin", "sourceConversation"]) if (value[key] != null) { assert(string(value[key])); row[key] = value[key]; }
  if (value.createdAt != null) { assert(typeof value.createdAt === "number" && Number.isFinite(value.createdAt)); row.createdAt = value.createdAt; }
  if (full) {
    assert(value.previewKind === "complete_operations" && revision(value.targetRevision) && Array.isArray(value.targets));
    row.previewKind = value.previewKind; row.targetRevision = value.targetRevision;
    row.targets = value.targets.map((target     ) => {
      assert(target && string(target.name) && typeof target.exists === "boolean" && Array.isArray(target.files));
      return { name: target.name, exists: target.exists, files: target.files.map((file     ) => {
        assert(file && string(file.path) && string(file.content) && ["utf8", "base64"].includes(file.encoding));
        return { path: file.path, content: file.content, encoding: file.encoding };
      }) };
    });
    assert(new Set(row.targets.map((target     ) => target.name)).size === row.targets.length &&
      row.operations.every((op     ) => row.targets.some((target     ) => target.name === op.name)));
  }
  return row;
}

function skillsResult(operationName        , value     , request      )      {
  assert(value && new TextEncoder().encode(JSON.stringify(value)).length <= 524288);
  if (operationName === "skills.pending") {
    assert(Array.isArray(value.records) && Number.isSafeInteger(value.count) && value.count === value.records.length);
    return { count: value.count, records: value.records.map((row     ) => proposal(row)) };
  }
  if (operationName === "skills.review") {
    const review = proposal(value.review, true);
    assert(!request || review.id === request.proposalId);
    return { review };
  }
  const receipt = value.receipt;
  assert(receipt && id(receipt.operationId) && ["approved", "rejected", "partial", "uncertain", "not_applied", "not_found",
    "stale_review", "already_resolved", "resolved_externally"].includes(receipt.status));
  assert(!request || receipt.operationId === request.operationId);
  const result      = { operationId: receipt.operationId, status: receipt.status };
  for (const key of ["proposalId", "decision", "proposalRevision", "targetRevision"]) {
    if (receipt[key] == null) continue;
    assert(key.endsWith("Revision") ? revision(receipt[key]) : id(receipt[key]));
    assert(!request || operationName !== "skills.decide" || receipt[key] === request[key]);
    result[key] = receipt[key];
  }
  if (operationName === "skills.decide") assert(receipt.proposalId === request?.proposalId);
  if (receipt.status === "approved") assert(receipt.decision === "approve");
  if (receipt.status === "rejected") assert(receipt.decision === "reject");
  if (receipt.alreadyResolved === true) result.alreadyResolved = true;
  assert(Array.isArray(receipt.operations) && receipt.operations.length <= 20 && Array.isArray(receipt.rollback));
  result.operations = receipt.operations.map((row     , index        ) => {
    assert(row && row.index === index && string(row.name) && actions.includes(row.action) &&
      ["applying", "applied", "failed", "exception", "not_attempted"].includes(row.execution) &&
      ["unknown", "unchanged", "rolled_back", "still_applied", "subsequently_changed", "changed_after_failure"].includes(row.finalState));
    return { index, name: row.name, action: row.action, execution: row.execution, finalState: row.finalState };
  });
  result.rollback = receipt.rollback.map((row     ) => {
    assert(row && string(row.name) && ["restored", "failed"].includes(row.status));
    return { name: row.name, status: row.status };
  });
  return { receipt: result };
}

const SKILLS_ERRORS                         = {
  stale_review: "The proposal, files or native policy changed. Review the complete proposal again.",
  recovery_required: "A native decision has an uncertain outcome. Check its original receipt before another decision.",
  operation_conflict: "This operation ID is already reserved. No new change was applied.",
  review_too_large: "The complete proposal exceeds this connection's limit. Review it in native Hermes.",
  unsafe_path: "A target path cannot be safely reviewed. Inspect the proposal in native Hermes.",
  external_target: "This proposal targets a shared external skill directory. Review it in native Hermes.",
};

module.exports = { SKILLS_OPERATIONS, SKILLS_ERRORS, skillsRequest, skillsResult };
