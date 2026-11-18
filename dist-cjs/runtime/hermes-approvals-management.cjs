const FIELDS = ["mode", "timeoutSeconds", "cronMode", "oneShotMode", "unattendedMode", "explainerModel", "execMode", "askFallback"];
const UNATTENDED = ["deny", "approve"];
const UNATTENDED_SAVED = ["deny", "approve", "off", "allow", "yes", "false"];
const EXEC_MODES = ["deny", "allowlist", "ask", "auto", "full"];
const FALLBACKS = ["deny", "allowlist", "full"];

const VALUES                           = {
  mode: ["manual", "smart", "off"], cronMode: UNATTENDED, oneShotMode: UNATTENDED, unattendedMode: UNATTENDED,
  execMode: EXEC_MODES, askFallback: FALLBACKS,
};
const RISKY                         = {
  mode: "off", cronMode: "approve", oneShotMode: "approve", unattendedMode: "approve", execMode: "full", askFallback: "full",
};

const SAVED                           = {
  mode: ["manual", "smart", "off", "false"], cronMode: UNATTENDED_SAVED, oneShotMode: UNATTENDED_SAVED,
  unattendedMode: UNATTENDED_SAVED, execMode: EXEC_MODES, askFallback: FALLBACKS,
};
const modelKey = (value     ) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\|[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,199}$/.test(value);
const explainerValue = (value     ) => value === "inherit" || modelKey(value);
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
    Array.isArray(payload.fields) && payload.fields.length > 0 && payload.fields.length <= FIELDS.length &&
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
    } else if (field === "explainerModel") {

      if (!explainerValue(value)) return null;
      if (value !== "inherit") risky.push(field);
    } else {
      if (!VALUES[field].includes(value)) return null;
      if (value === RISKY[field]) risky.push(field);
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
    } else if (name === "explainerModel") {
      if (!(explainerValue(row.effectiveValue) || row.effectiveValue === "unrecognized")) return null;
    } else if (!VALUES[name].includes(row.effectiveValue)) return null;
    const saved = row.savedValue;
    if (row.savedState === "recognized") {
      if (typeof saved !== "string" || (name === "timeoutSeconds" ? !/^-?[0-9]{1,12}$/.test(saved) :
          name === "explainerModel" ? !explainerValue(saved) : !SAVED[name].includes(saved))) return null;
    } else if (saved != null) return null;
    if (row.savedPresent !== (row.savedState !== "absent")) return null;
    fields[name] = { savedPresent: row.savedPresent, savedState: row.savedState,
      ...(saved != null ? { savedValue: saved } : {}), effectiveValue: row.effectiveValue,
      revision: row.revision, writable: row.writable, source: row.source };
  }
  const result      = { fields, maxTimeoutSeconds: raw.maxTimeoutSeconds, applyTiming: raw.applyTiming,
    processYolo: raw.processYolo, sessionOverrides: "not_evaluated", roomOverrides: "not_evaluated" };

  if (typeof raw.explainerTaskRegistered === "boolean") result.explainerTaskRegistered = raw.explainerTaskRegistered;
  if (fields.explainerModel) {

    if (!Array.isArray(raw.explainerModels) || raw.explainerModels[0] !== "inherit" || raw.explainerModels.length > 1000 ||
        !raw.explainerModels.every(explainerValue) || typeof raw.explainerModelsTruncated !== "boolean" ||
        !(raw.approvalModel === "main" || modelKey(raw.approvalModel)) || typeof raw.customExplainerRoute !== "boolean") return null;
    Object.assign(result, { explainerModels: [...raw.explainerModels], explainerModelsTruncated: raw.explainerModelsTruncated,
      approvalModel: raw.approvalModel, customExplainerRoute: raw.customExplainerRoute });
  }
  if (raw.receipt != null) {
    const receipt = raw.receipt;
    if (!record(receipt) || !mutationId(receipt.mutationId) || !["committed", "unknown", "cancelled", "reconciled_unknown"].includes(receipt.outcome) ||
        !Array.isArray(receipt.changedFields) || receipt.changedFields.length > FIELDS.length ||
        new Set(receipt.changedFields).size !== receipt.changedFields.length || !receipt.changedFields.every((field     ) => FIELDS.includes(field))) return null;
    result.receipt = { mutationId: receipt.mutationId, outcome: receipt.outcome, changedFields: [...receipt.changedFields] };
  }
  return result;
}

const HERMES_ERRORS                         = {
  invalid_request: "Invalid approval change. Check the fields and confirmations.",
  unsupported: "This installed Hermes needs native configuration transaction compatibility before saving approvals.",
  profile_not_served: "This profile is not served by the connected gateway.",
  native_read_failed: "Hermes could not read the approval policy. Check native configuration.",
  managed_setting: "These settings are managed by the administrator.",
  config_conflict: "A changed field was edited elsewhere. Refresh and review your draft before saving.",
  native_write_failed: "Hermes rejected the save. No successful write was confirmed.",
  outcome_unknown: "Save outcome is unknown. Check its receipt and current saved state before making another change.",
  model_unavailable: "That model is no longer available. Refresh and pick another.",
  rate_limited: "Too many changes in a minute. Wait a moment, then try again.",
};

const OPENCLAW_ERRORS                         = {
  ...HERMES_ERRORS,
  unsupported: "This OpenClaw host does not support changing this approval setting. Update OpenClaw and OcuClaw to a compatible version.",
  profile_not_served: "This agent is no longer served here. Pick another one.",
  native_read_failed: "OpenClaw could not read the approval policy. Refresh when connected.",
  managed_setting: "This setting uses an older OpenClaw format. Run openclaw doctor --fix on the host to edit it here.",
  native_write_failed: "OpenClaw rejected the save. No successful write was confirmed.",
};

function approvalsManagementResult(identity     , raw     , backend = "Hermes")      {
  const ERRORS = backend === "OpenClaw" ? OPENCLAW_ERRORS : HERMES_ERRORS;
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
