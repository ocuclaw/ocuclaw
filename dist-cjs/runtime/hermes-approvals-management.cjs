const FIELDS = ["mode", "timeoutSeconds", "cronMode", "oneShotMode", "unattendedMode"];
const OPERATIONS = ["approvals.read", "approvals.update", "approvals.receipt", "approvals.recover"];
const record = (value     ) => value && typeof value === "object" && !Array.isArray(value);
const exact = (value     , keys          ) => record(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const mutationId = (value     ) => typeof value === "string" && /^[A-Za-z0-9_-]{12,120}$/.test(value);
const revision = (value     ) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isApprovalsOperation = (operation     ) => OPERATIONS.includes(operation);

function approvalsRequest(operation        , payload     )      {
  if (operation === "approvals.read") return payload === undefined || exact(payload, []) ? {} : null;
  if (operation === "approvals.receipt") return exact(payload, ["mutationId"]) && mutationId(payload.mutationId)
    ? { mutationId: payload.mutationId } : null;
  if (operation === "approvals.recover") return exact(payload, ["mutationId", "fields"]) && mutationId(payload.mutationId) &&
    Array.isArray(payload.fields) && payload.fields.length > 0 && payload.fields.length <= 5 &&
    new Set(payload.fields).size === payload.fields.length && payload.fields.every((field     ) => FIELDS.includes(field))
    ? { mutationId: payload.mutationId, fields: [...payload.fields] } : null;
  if (operation !== "approvals.update" || !exact(payload, ["mutationId", "changes", "expected", "confirmations"]) || !mutationId(payload.mutationId)) return null;
  if (!record(payload.changes) || !record(payload.expected)) return null;
  const fields = Object.keys(payload.changes);
  if (!fields.length || !fields.every(key => FIELDS.includes(key)) || !exact(payload.expected, fields) || !Object.values(payload.expected).every(revision)) return null;
  const changes      = {}, expected      = {}, risky           = [];
  for (const field of fields) {
    const value = payload.changes[field];
    if (field === "timeoutSeconds") {
      if (!Number.isInteger(value) || value < 1 || value > 31536000) return null;
    } else {
      if (!(field === "mode" ? ["manual", "smart", "off"] : ["deny", "approve"]).includes(value)) return null;
      if (value === (field === "mode" ? "off" : "approve")) risky.push(field);
    }
    changes[field] = value;
    expected[field] = payload.expected[field];
  }
  if (!Array.isArray(payload.confirmations) || payload.confirmations.length !== risky.length ||
      new Set(payload.confirmations).size !== risky.length || !payload.confirmations.every((field     ) => risky.includes(field))) return null;
  return { mutationId: payload.mutationId, changes, expected, confirmations: [...payload.confirmations] };
}

function approvalsSnapshot(raw     )      {
  if (!record(raw) || !record(raw.fields) || !Number.isInteger(raw.maxTimeoutSeconds) || raw.maxTimeoutSeconds < 1 || raw.maxTimeoutSeconds > 31536000 ||
      raw.applyTiming !== "subsequent_guard_checks" || typeof raw.processYolo !== "boolean" ||
      raw.sessionOverrides !== "not_evaluated" || raw.roomOverrides !== "not_evaluated") return null;
  const fields      = {};
  if (!Object.keys(raw.fields).length || !Object.keys(raw.fields).every(field => FIELDS.includes(field))) return null;
  for (const [name, row] of Object.entries(raw.fields)                   ) {
    if (!record(row) || typeof row.savedPresent !== "boolean" || typeof row.writable !== "boolean" ||
        !["absent", "recognized", "unrecognized"].includes(row.savedState) || !["managed", "user", "default"].includes(row.source) || !revision(row.revision)) return null;
    if (name === "timeoutSeconds") {
      if (typeof row.effectiveValue !== "string" || !/^-?[0-9]{1,12}$/.test(row.effectiveValue)) return null;
    } else if (!(name === "mode" ? ["manual", "smart", "off"] : ["deny", "approve"]).includes(row.effectiveValue)) return null;
    const saved = row.savedValue;
    if (row.savedState === "recognized") {
      if (typeof saved !== "string" || (name === "timeoutSeconds" ? !/^-?[0-9]{1,12}$/.test(saved) :
          !(name === "mode" ? ["manual", "smart", "off", "false"] : ["deny", "approve", "off", "allow", "yes", "false"]).includes(saved))) return null;
    } else if (saved != null) return null;
    if (row.savedPresent !== (row.savedState !== "absent")) return null;
    fields[name] = { savedPresent: row.savedPresent, savedState: row.savedState,
      ...(saved != null ? { savedValue: saved } : {}), effectiveValue: row.effectiveValue,
      revision: row.revision, writable: row.writable, source: row.source };
  }
  const result      = { fields, maxTimeoutSeconds: raw.maxTimeoutSeconds, applyTiming: raw.applyTiming,
    processYolo: raw.processYolo, sessionOverrides: "not_evaluated", roomOverrides: "not_evaluated" };
  if (raw.receipt != null) {
    const receipt = raw.receipt;
    if (!record(receipt) || !mutationId(receipt.mutationId) || !["committed", "unknown", "cancelled", "reconciled_unknown"].includes(receipt.outcome) ||
        !Array.isArray(receipt.changedFields) || receipt.changedFields.length > 5 ||
        new Set(receipt.changedFields).size !== receipt.changedFields.length || !receipt.changedFields.every((field     ) => FIELDS.includes(field))) return null;
    result.receipt = { mutationId: receipt.mutationId, outcome: receipt.outcome, changedFields: [...receipt.changedFields] };
  }
  return result;
}

const ERRORS                         = {
  invalid_request: "Invalid approval change. Check the fields and confirmations.",
  unsupported: "This installed Hermes needs native configuration transaction compatibility before saving approvals.",
  profile_not_served: "This profile is not served by the connected gateway.",
  native_read_failed: "Hermes could not read the approval policy. Check native configuration.",
  managed_setting: "These settings are managed by the administrator.",
  config_conflict: "A changed field was edited elsewhere. Refresh and review your draft before saving.",
  native_write_failed: "Hermes rejected the save. No successful write was confirmed.",
  outcome_unknown: "Save outcome is unknown. Check its receipt and current saved state before making another change.",
};

function approvalsManagementResult(identity     , raw     )      {
  const snapshot = raw.approvals == null ? null : approvalsSnapshot(raw.approvals);
  const expectedFields = identity.operation === "approvals.recover" ? [...(identity.approvals?.fields ?? [])].sort() : Object.keys(identity.approvals?.changes ?? {}).sort();
  const committedFieldsMatch = JSON.stringify([...(snapshot?.receipt?.changedFields ?? [])].sort()) === JSON.stringify(expectedFields);
  const validReceipt = identity.operation === "approvals.read" ||
    (snapshot?.receipt?.mutationId === identity.approvals?.mutationId &&
     (identity.operation !== "approvals.update" || (snapshot.receipt.outcome === "committed" && committedFieldsMatch)) &&
     (identity.operation !== "approvals.recover" || (["committed", "cancelled", "reconciled_unknown"].includes(snapshot.receipt.outcome) && committedFieldsMatch)));

  const envelope = { requestId: identity.requestId, operation: identity.operation, scope: identity.scope, profileId: identity.profileId };
  if (raw.status === "ok" && snapshot && validReceipt) return { ...envelope, status: "ok", capabilities: [], approvals: snapshot };
  const code = raw.status !== "ok" && ERRORS[raw.errorCode] ? raw.errorCode :
    ["approvals.update", "approvals.recover"].includes(identity.operation) ? "outcome_unknown" : "native_read_failed";
  return { ...envelope, status: code === "unsupported" ? "unsupported" : "error", capabilities: [],
    errorCode: code, errorMessage: ERRORS[code], ...(snapshot ? { approvals: snapshot } : {}) };
}

module.exports = { isApprovalsOperation, approvalsRequest, approvalsSnapshot, approvalsManagementResult };
