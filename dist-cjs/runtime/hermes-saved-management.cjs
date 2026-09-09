const SAVED_OPERATIONS = ["saved.list", "saved.read", "saved.preview", "saved.mutate", "saved.receipt", "saved.recover"];
const id = (value     ) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const revision = (value     ) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const string = (value     ) => typeof value === "string" && !value.includes("\u0000");
const kinds = ["memory", "user", "skill"];
function assert(condition     )                    { if (!condition) throw new Error("Incomplete saved-learning evidence"); }

function savedRequest(operation        , value     )      {
  const fields                           = {
    "saved.list": [], "saved.read": ["entryId"], "saved.preview": ["entryId", "action", "content"],
    "saved.mutate": ["operationId", "entryId", "action", "content", "previewRevision", "producedAtMs", "expiresAtMs"],
    "saved.receipt": ["operationId"], "saved.recover": ["operationId", "producedAtMs", "expiresAtMs"],
  };
  const keys = fields[operation];
  const row = value ?? {};
  if (!keys || !row || typeof row !== "object" || Array.isArray(row) ||
    Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) return null;
  for (const key of keys) {
    if (key === "producedAtMs" || key === "expiresAtMs") {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) return null;
    } else if (key === "content") {
      if (!string(row[key]) || new TextEncoder().encode(row[key]).length > 262144) return null;
    } else if (key === "action") {
      if (!["edit", "remove"].includes(row[key])) return null;
    } else if (!(key === "operationId" ? id(row[key]) : revision(row[key]))) return null;
  }
  if (row.action === "remove" && row.content !== "") return null;
  if (row.producedAtMs !== undefined && !(row.expiresAtMs > row.producedAtMs && row.expiresAtMs - row.producedAtMs <= 30000)) return null;
  return { ...row };
}

function files(value     )        {
  assert(Array.isArray(value));
  const result = value.map((file     ) => {
    assert(file && string(file.path) && string(file.content) && ["utf8", "base64"].includes(file.encoding));
    return { path: file.path, content: file.content, encoding: file.encoding };
  });
  assert(new Set(result.map(row => row.path)).size === result.length);
  return result;
}

function entry(value     , summary = false)      {
  assert(value && revision(value.id) && kinds.includes(value.kind) && string(value.name) &&
    revision(value.targetRevision));
  const row      = { id: value.id, kind: value.kind, name: value.name, targetRevision: value.targetRevision };
  if (summary) {
    assert(string(value.contentPreview) && Number.isSafeInteger(value.contentLength) && value.contentLength >= 0);
    row.contentPreview = value.contentPreview; row.contentLength = value.contentLength;
  } else { assert(string(value.content)); row.content = value.content; }
  if (value.kind === "skill") {
    assert(string(value.location) && ["profile", "external"].includes(value.source));
    row.location = value.location; row.source = value.source;
  }
  return row;
}

function savedResult(operation        , value     , request      )      {
  assert(value && new TextEncoder().encode(JSON.stringify(value)).length <= 524288);
  if (operation === "saved.list") {
    assert(Array.isArray(value.records) && Array.isArray(value.targets) && value.applyTiming === "future_chat" &&
      typeof value.externalProviderUnsupported === "boolean");
    const records = value.records.map((row     ) => entry(row, true));
    assert(new Set(records.map((row     ) => row.id)).size === records.length);
    const targets = value.targets.map((target     ) => {
      assert(target && ["memory", "user"].includes(target.kind) && typeof target.enabled === "boolean" &&
        ["count", "used", "limit"].every(key => Number.isSafeInteger(target[key]) && target[key] >= 0) &&
        target.count === records.filter((row     ) => row.kind === target.kind).length);
      return { kind: target.kind, enabled: target.enabled, count: target.count, used: target.used, limit: target.limit };
    });
    assert(targets.length === 2 && new Set(targets.map((row     ) => row.kind)).size === 2);
    return { records, targets, applyTiming: value.applyTiming, externalProviderUnsupported: value.externalProviderUnsupported };
  }
  if (operation === "saved.read" || operation === "saved.preview") {
    const full = operation === "saved.preview";
    const raw = full ? value.preview : value.entry;
    const row = entry(raw);
    assert(!request || row.id === request.entryId);
    assert(raw.applyTiming === "future_chat" && raw.removal === "permanent");
    row.applyTiming = raw.applyTiming; row.removal = raw.removal;
    if (!full) { row.files = files(raw.files); return { entry: row }; }
    assert(["edit", "remove"].includes(raw.action) && string(raw.proposedContent) &&
      (!request || (raw.action === request.action && raw.proposedContent === request.content)) &&
      typeof raw.valid === "boolean" && Array.isArray(raw.validationErrors) && raw.validationErrors.every(string) &&
      raw.valid === (raw.validationErrors.length === 0) && revision(raw.previewRevision));
    Object.assign(row, { action: raw.action, proposedContent: raw.proposedContent, valid: raw.valid,
      validationErrors: raw.validationErrors, previewRevision: raw.previewRevision });
    if (row.kind === "skill") {
      row.beforeFiles = files(raw.beforeFiles); row.afterFiles = files(raw.afterFiles);
      assert(row.beforeFiles.some((file     ) => file.path === "SKILL.md" && file.content === row.content));
      assert(raw.action === "remove" ? row.afterFiles.length === 0 :
        row.afterFiles.length === row.beforeFiles.length && row.beforeFiles.every((before     ) =>
          row.afterFiles.some((after     ) => after.path === before.path &&
            after.content === (before.path === "SKILL.md" ? raw.proposedContent : before.content) &&
            after.encoding === (before.path === "SKILL.md" ? "utf8" : before.encoding))));
    } else {
      assert(string(raw.beforeContent) && string(raw.afterContent) && typeof raw.normalizesStoredEntries === "boolean");
      Object.assign(row, { beforeContent: raw.beforeContent, afterContent: raw.afterContent,
        normalizesStoredEntries: raw.normalizesStoredEntries });
    }
    return { preview: row };
  }
  const raw = value.receipt;
  assert(raw && id(raw.operationId) && (!request || raw.operationId === request.operationId) &&
    ["applied", "not_applied", "not_found", "partial", "uncertain", "resolved_externally"].includes(raw.status));
  const receipt      = { operationId: raw.operationId, status: raw.status };
  if (raw.cancelledBeforeAdmission === true) receipt.cancelledBeforeAdmission = true;
  if (raw.validationRejected === true) receipt.validationRejected = true;
  for (const key of ["entryId", "previewRevision", "action"]) {
    if (raw[key] == null) { assert(operation !== "saved.mutate" || raw.cancelledBeforeAdmission === true); continue; }
    assert(key === "action" ? ["edit", "remove"].includes(raw[key]) : revision(raw[key]));
    assert(operation !== "saved.mutate" || !request || raw[key] === request[key]);
    receipt[key] = raw[key];
  }
  return { receipt };
}

const SAVED_ERRORS                         = {
  intent_expired: "This confirmation expired before native admission. Check the original receipt, then confirm again.",
  stale_review: "Saved learning or native policy changed. Reload and preview the current entry.",
  recovery_required: "A native change has an uncertain outcome. Check its original receipt before editing.",
  operation_conflict: "This operation ID is already reserved. No new change was applied.",
  validation_failed: "Native validation rejected this change. Edit it and preview again.",
  review_too_large: "The complete saved learning exceeds this connection's limit. Review it in native Hermes.",
  unsafe_path: "This saved target cannot be safely reviewed. Inspect it in native Hermes.",
};

module.exports = { SAVED_OPERATIONS, SAVED_ERRORS, savedRequest, savedResult };
