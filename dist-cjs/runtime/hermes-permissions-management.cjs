const OPS = ["permissions.read", "permissions.revoke", "permissions.receipt", "permissions.recover", "permissions.preview", "deny.add", "deny.edit", "deny.remove"];
const record = (v     ) => v && typeof v === "object" && !Array.isArray(v);
const exact = (v     , keys          ) => record(v) && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const id = (v     ) => typeof v === "string" && /^[A-Za-z0-9_-]{12,120}$/.test(v);
const revision = (v     ) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v     ) => typeof v === "string" && v.length <= 512;
const isPermissionsOperation = (op     ) => OPS.includes(op);

function permissionsRequest(op        , p     )      {
  if (op === "permissions.read") return p === undefined || exact(p, []) ? {} : null;
  if (op === "permissions.preview") return exact(p, ["command"]) && text(p.command) && p.command.length && !p.command.includes("\0") ? { command: p.command } : null;
  const keys = ["mutationId"];
  if (op === "permissions.recover") keys.push("kind");
  else if (op !== "permissions.receipt") {
    keys.push("revision", "confirmed");
    if (op !== "deny.add") keys.push("index");
    if (["deny.add", "deny.edit"].includes(op)) keys.push("pattern");
  }
  if (!OPS.includes(op) || !exact(p, keys) || !id(p.mutationId)) return null;
  if (op === "permissions.recover" && !["remembered", "deny"].includes(p.kind)) return null;
  if (!["permissions.recover", "permissions.receipt"].includes(op)) {
    if (!revision(p.revision) || p.confirmed !== true) return null;
    if (keys.includes("index") && (!Number.isInteger(p.index) || p.index < 0 || p.index >= 200)) return null;
    if (keys.includes("pattern") && (!text(p.pattern) || !p.pattern.trim() || /[\x00-\x1f]/.test(p.pattern))) return null;
  }
  return Object.fromEntries(keys.map(key => [key, p[key]]));
}

function permissionsSnapshot(raw     )      {
  if (!record(raw) || !["fresh_profile_each_guard", "unverified_cached_policy"].includes(raw.cacheEffect) ||
      raw.sessionGrantEffect !== "unchanged" || raw.applyTiming !== "subsequent_guard_checks" ||
      !["manual", "smart", "off"].includes(raw.mode) || typeof raw.processYolo !== "boolean") return null;
  const out      = { cacheEffect: raw.cacheEffect, sessionGrantEffect: raw.sessionGrantEffect, applyTiming: raw.applyTiming, mode: raw.mode, processYolo: raw.processYolo };
  for (const kind of ["remembered", "deny"]) {
    const list = raw[kind];
    if (!record(list) || !revision(list.revision) || typeof list.writable !== "boolean" || !["managed", "user", "default"].includes(list.source) || !Array.isArray(list.entries) || list.entries.length > 200) return null;
    const entries = [];
    for (const [index, row] of list.entries.entries()) {
      if (!record(row) || row.index !== index || !text(row.pattern) || !["eligible", "ignored_empty"].includes(row.effect) ||
          !(kind === "deny" ? ["case_insensitive_native_glob"] : ["native_class_alias", "case_sensitive_command_glob", "exact_command"]).includes(row.semantics)) return null;
      entries.push({ index, pattern: row.pattern, semantics: row.semantics, effect: row.effect });
    }
    if (list.writable && raw.cacheEffect !== "fresh_profile_each_guard") return null;
    out[kind] = { revision: list.revision, writable: list.writable, source: list.source, entries };
  }
  if (raw.receipt != null) {
    const r = raw.receipt;
    if (!record(r) || !id(r.mutationId) || !["committed", "unknown", "cancelled", "reconciled_unknown"].includes(r.outcome) ||
        !Array.isArray(r.changedFields) || r.changedFields.length > 1 || !r.changedFields.every((v     ) => ["remembered", "deny"].includes(v))) return null;
    out.receipt = { mutationId: r.mutationId, outcome: r.outcome, changedFields: [...r.changedFields] };
  }
  if (raw.preview != null) {
    const p = raw.preview;
    if (!record(p) || !text(p.command) || !["allow", "ask-approval", "hardline-deny", "user-deny"].includes(p.verdict) || p.environment !== "local" || p.sessionEvaluated !== false) return null;
    out.preview = { command: p.command, verdict: p.verdict, environment: "local", sessionEvaluated: false };
  }
  return out;
}

const ERRORS                         = {
  invalid_request: "Review the selected rule and confirmation.", unsupported: "This Hermes needs native permission compatibility before editing rules or previewing commands.",
  profile_not_served: "This profile is not served by the connected gateway.", native_read_failed: "Hermes could not read supported native rule lists.",
  managed_setting: "These rules are managed or cannot be edited on this host.", config_conflict: "This rule list changed elsewhere. Refresh and review it before editing.",
  outcome_unknown: "The change outcome is unknown. Check its receipt before another edit.",
};

function permissionsManagementResult(identity     , raw     )      {
  const snapshot = raw.permissions == null ? null : permissionsSnapshot(raw.permissions);
  const op = identity.operation;
  const mutation = !["permissions.read", "permissions.preview", "permissions.receipt"].includes(op);
  const kind = op === "permissions.recover" ? identity.permissions?.kind : op === "permissions.revoke" ? "remembered" : "deny";
  const receipt = snapshot?.receipt;
  const valid = op === "permissions.read" || (op === "permissions.preview" ? snapshot?.preview?.command === identity.permissions?.command :
    receipt?.mutationId === identity.permissions?.mutationId && (!mutation ||
      receipt.changedFields.length === 1 && receipt.changedFields[0] === kind &&
      (op === "permissions.recover" ? ["committed", "cancelled", "reconciled_unknown"].includes(receipt.outcome) : receipt.outcome === "committed")));
  const envelope = { requestId: identity.requestId, operation: op, scope: identity.scope, profileId: identity.profileId };
  if (raw.status === "ok" && snapshot && valid) return { ...envelope, status: "ok", capabilities: [], permissions: snapshot };
  const code = raw.status !== "ok" && ERRORS[raw.errorCode] ? raw.errorCode : mutation ? "outcome_unknown" : "native_read_failed";
  return { ...envelope, status: code === "unsupported" ? "unsupported" : "error", capabilities: [], errorCode: code, errorMessage: ERRORS[code], ...(snapshot ? { permissions: snapshot } : {}) };
}

module.exports = { isPermissionsOperation, permissionsRequest, permissionsSnapshot, permissionsManagementResult };
