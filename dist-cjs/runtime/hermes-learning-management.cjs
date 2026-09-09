const LEARNING_FIELDS = ["memoryApproval", "skillApproval", "reviewEnabled", "reviewModel", "notifications"];
const OPS = ["learning.read", "learning.update", "learning.receipt", "learning.recover"];
const TIMING                         = { memoryApproval: "next_guard_check", skillApproval: "next_guard_check",
  reviewEnabled: "next_automatic_review", reviewModel: "next_review_fork", notifications: "next_agent_creation" };
const record = (v     ) => v && typeof v === "object" && !Array.isArray(v);
const exact = (v     , keys          ) => record(v) && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const id = (v     ) => typeof v === "string" && /^[A-Za-z0-9_-]{12,120}$/.test(v);
const revision = (v     ) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const model = (v     ) => typeof v === "string" && (v === "inherit" || /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\|[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,199}$/.test(v));
const fields = (v     , empty = false) => Array.isArray(v) && v.length >= (empty ? 0 : 1) && v.length <= 5 && new Set(v).size === v.length && v.every(x => LEARNING_FIELDS.includes(x));
const windowValid = (p     ) => Number.isFinite(p.producedAtMs) && Number.isFinite(p.expiresAtMs) &&
  p.producedAtMs <= Date.now() + 5000 && p.producedAtMs < p.expiresAtMs && p.expiresAtMs <= p.producedAtMs + 30000 && p.expiresAtMs > Date.now();
const isLearningOperation = (operation     ) => OPS.includes(operation);

function learningRequest(operation        , raw     )      {
  if (operation === "learning.read") return raw === undefined || exact(raw, []) ? {} : null;
  if (!record(raw) || !id(raw.mutationId)) return null;
  if (operation === "learning.receipt") return exact(raw, ["mutationId"]) ? { mutationId: raw.mutationId } : null;
  if (!windowValid(raw) || raw.confirmed !== true) return null;
  const base = { mutationId: raw.mutationId, confirmed: true, producedAtMs: raw.producedAtMs, expiresAtMs: raw.expiresAtMs };
  if (operation === "learning.recover") return exact(raw, [...Object.keys(base), "fields"]) && fields(raw.fields) ? { ...base, fields: [...raw.fields] } : null;
  if (operation !== "learning.update" || !exact(raw, [...Object.keys(base), "changes", "expected"]) || !record(raw.changes)) return null;
  const names = Object.keys(raw.changes);
  if (!fields(names) || !exact(raw.expected, names) || !Object.values(raw.expected).every(revision)) return null;
  for (const name of names) {
    const value = raw.changes[name];
    if (name === "reviewModel" ? !model(value) : !(name === "notifications" ? ["off", "on", "verbose"] : ["off", "on"]).includes(value)) return null;
  }
  return { ...base, changes: { ...raw.changes }, expected: { ...raw.expected } };
}

function learningSnapshot(raw     )      {
  if (!record(raw) || !exact(raw.fields, LEARNING_FIELDS) || raw.currentWork !== "unchanged_not_observed" || raw.pendingProposals !== "preserved" ||
      typeof raw.modelsTruncated !== "boolean" || typeof raw.selectedModelAvailable !== "boolean" || typeof raw.customReviewRoute !== "boolean" ||
      !Array.isArray(raw.models) || raw.models.length < 1 || raw.models.length > 1000 || raw.models[0] !== "inherit" ||
      new Set(raw.models).size !== raw.models.length || !raw.models.every(model) || !record(raw.futureRoute) ||
      !["inherited", "resolved", "fallback", "unavailable", "unknown"].includes(raw.futureRoute.state) ||
      (raw.futureRoute.state === "unknown" && raw.futureRoute.model != null) ||
      (raw.futureRoute.model != null && (!model(raw.futureRoute.model) || raw.futureRoute.model === "inherit"))) return null;
  const rows      = {};
  for (const name of LEARNING_FIELDS) {
    const row = raw.fields[name];
    if (!record(row) || !revision(row.revision) || typeof row.writable !== "boolean" || typeof row.savedPresent !== "boolean" ||
        !["managed", "user", "default"].includes(row.source) || !["absent", "recognized", "unrecognized"].includes(row.savedState) ||
        row.savedPresent !== (row.savedState !== "absent") || row.applyTiming !== TIMING[name]) return null;
    const effective = row.effectiveValue;
    if (name === "reviewModel" ? effective !== "unrecognized" && !model(effective) :
      !(name === "notifications" ? ["off", "on", "verbose", "unrecognized"] : ["off", "on"]).includes(effective)) return null;
    if (row.savedState === "recognized") {
      if (name === "reviewModel" ? !model(row.savedValue) : !["on", "off", "true", "false", "yes", "no", "1", "0", "approve", "enabled", "verbose"].includes(row.savedValue)) return null;
    } else if (row.savedValue != null) return null;
    rows[name] = { effectiveValue: effective, revision: row.revision, writable: row.writable,
      source: row.source, savedPresent: row.savedPresent, savedState: row.savedState,
      ...(row.savedState === "recognized" ? { savedValue: row.savedValue } : {}), applyTiming: TIMING[name] };
  }
  const result      = { fields: rows, models: [...raw.models], modelsTruncated: raw.modelsTruncated,
    selectedModelAvailable: raw.selectedModelAvailable, customReviewRoute: raw.customReviewRoute,
    futureRoute: { state: raw.futureRoute.state, model: raw.futureRoute.model ?? null }, currentWork: "unchanged_not_observed", pendingProposals: "preserved" };
  if (raw.receipt != null) {
    const r = raw.receipt;
    if (!record(r) || !id(r.mutationId) || !["committed", "unknown", "cancelled", "reconciled_unknown"].includes(r.outcome) || !fields(r.changedFields, true)) return null;
    result.receipt = { mutationId: r.mutationId, outcome: r.outcome, changedFields: [...r.changedFields] };
  }
  return result;
}

const ERRORS                         = {
  invalid_request: "The learning request was invalid. Refresh and review its fields.",
  request_expired: "This request expired before admission. Check its receipt before another save.",
  unsupported: "This native installation needs verified learning and config-transaction support.",
  profile_not_served: "The connected gateway does not serve this profile.",
  model_unavailable: "This review model could not resolve through the selected profile. No model change was confirmed.",
  native_read_failed: "Native learning settings could not be read. Check profile permissions and configuration.",
  managed_setting: "These learning settings are managed by the administrator.",
  config_conflict: "A changed learning field was edited elsewhere. Read back before saving again.",
  outcome_unknown: "The save outcome is unknown. Read its receipt and reconcile explicitly; it will not be replayed.",
};

function learningManagementResult(identity     , raw     )      {
  const snapshot = raw.learning == null ? null : learningSnapshot(raw.learning);
  const expected = identity.operation === "learning.recover" ? identity.learning?.fields ?? [] : Object.keys(identity.learning?.changes ?? {});
  const receipt = snapshot?.receipt;
  const sameFields = JSON.stringify([...(receipt?.changedFields ?? [])].sort()) === JSON.stringify([...expected].sort());
  const valid = identity.operation === "learning.read" || receipt?.mutationId === identity.learning?.mutationId &&
    (identity.operation !== "learning.update" || receipt.outcome === "committed" && sameFields) &&
    (identity.operation !== "learning.recover" || ["committed", "cancelled", "reconciled_unknown"].includes(receipt.outcome) && sameFields);
  const envelope = { requestId: identity.requestId, operation: identity.operation, scope: identity.scope, profileId: identity.profileId };
  if (raw.status === "ok" && snapshot && valid) return { ...envelope, status: "ok", capabilities: [], learning: snapshot };
  const code = raw.status !== "ok" && Object.hasOwn(ERRORS, raw.errorCode) ? raw.errorCode :
    ["learning.update", "learning.recover"].includes(identity.operation) ? "outcome_unknown" : "native_read_failed";
  return { ...envelope, status: code === "unsupported" ? "unsupported" : "error", capabilities: [],
    errorCode: code, errorMessage: ERRORS[code], ...(snapshot ? { learning: snapshot } : {}) };
}

module.exports = { LEARNING_FIELDS, isLearningOperation, learningRequest, learningSnapshot, learningManagementResult };
