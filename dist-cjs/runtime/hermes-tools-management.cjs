const TOOLS_OPERATIONS = new Set(["tools.read", "tools.block", "tools.skillToggle", "tools.receipt", "tools.recover"]);
const record = (v     ) => v && typeof v === "object" && !Array.isArray(v);
const text = (v     , max = 160) => typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v);
const revision = (v     ) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v     ) => typeof v === "string" && /^[A-Za-z0-9_-]{12,120}$/.test(v);
function toolsRequest(op        , raw     )      {
  if (!TOOLS_OPERATIONS.has(op)) return null;
  if (op === "tools.read") return raw == null || record(raw) && !Object.keys(raw).length ? {} : null;
  if (!record(raw) || !id(raw.mutationId)) return null;
  const keys = op === "tools.receipt" ? ["mutationId"] : op === "tools.recover" ? ["mutationId", "kind", "confirmed"] : ["mutationId", "name", "revision", "value", "confirmed"];
  if (op !== "tools.receipt") keys.push("producedAtMs", "expiresAtMs");
  if (Object.keys(raw).length !== keys.length || !keys.every(k => Object.hasOwn(raw, k))) return null;
  if (op !== "tools.receipt" && raw.confirmed !== true) return null;
  if (op !== "tools.receipt" && (!Number.isSafeInteger(raw.producedAtMs) || !Number.isSafeInteger(raw.expiresAtMs) || raw.producedAtMs < 0 || raw.expiresAtMs <= raw.producedAtMs || raw.expiresAtMs - raw.producedAtMs > 30000)) return null;
  if (op === "tools.recover" && !["blocks", "skills"].includes(raw.kind)) return null;
  if (["tools.block", "tools.skillToggle"].includes(op) && (!text(raw.name) || !raw.name || !revision(raw.revision) || typeof raw.value !== "boolean" || op === "tools.block" && !["web", "files", "terminal"].includes(raw.name))) return null;
  return Object.fromEntries(keys.map(k => [k, raw[k]]));
}
function toolsSnapshot(raw     )      {
  if (!record(raw) || !text(raw.platform) || !raw.platform || !revision(raw.blocksRevision) || !revision(raw.skillsRevision) || raw.applyTiming !== "new_chat" || raw.refresh !== "reload_skills_then_new_chat") return null;
  if (!Array.isArray(raw.tools) || raw.tools.length !== 3 || !Array.isArray(raw.installedSkills) || raw.installedSkills.length > 500) return null;
  const rows        = [];
  for (const row of raw.tools) {
    if (!record(row) || !["web", "files", "terminal"].includes(row.id) || rows.some(r => r.id === row.id) || typeof row.blocked !== "boolean" || typeof row.writable !== "boolean") return null;
    if (row.state === "not_checked") {
      if (row.availableTools !== null) return null;
    } else if (!Number.isSafeInteger(row.availableTools) || row.availableTools < 0 || row.availableTools > 10000 || row.state !== (row.blocked ? "blocked" : row.availableTools > 0 ? "allowed_by_setting" : "unavailable")) return null;
    rows.push({id: row.id, blocked: row.blocked, writable: row.writable, availableTools: row.availableTools, state: row.state});
  }
  const skills        = [];
  for (const row of raw.installedSkills) {
    if (!record(row) || !text(row.name) || !row.name || skills.some(r => r.name === row.name) || !text(row.description, 240) || !text(row.reason, 512) || !["project", "profile", "external"].includes(row.origin) || !revision(row.contentRevision) || !Number.isSafeInteger(row.overrides) || row.overrides < 0 || row.overrides > 499 || !["available", "essential", "enabled", "globalBlocked", "writable"].every(k => typeof row[k] === "boolean") || row.writable && (row.essential || row.globalBlocked) || row.essential && !row.enabled || row.globalBlocked && row.enabled || row.available !== !row.reason) return null;
    skills.push(Object.fromEntries(["name", "description", "reason", "origin", "contentRevision", "overrides", "available", "essential", "enabled", "globalBlocked", "writable"].map(k => [k, row[k]])));
  }
  const result      = {platform: raw.platform, blocksRevision: raw.blocksRevision, skillsRevision: raw.skillsRevision, applyTiming: raw.applyTiming, refresh: raw.refresh, tools: rows, installedSkills: skills};
  if (raw.receipt != null) {
    const r = raw.receipt;
    if (!record(r) || !id(r.mutationId) || !["committed", "unknown", "cancelled", "reconciled_unknown"].includes(r.outcome) || !Array.isArray(r.changedFields) || r.changedFields.length > 1 || !r.changedFields.every((v     ) => ["blocks", "skills"].includes(v))) return null;
    result.receipt = {mutationId: r.mutationId, outcome: r.outcome, changedFields: [...r.changedFields]};
  }
  return result;
}
const errors                         = {
  intent_expired: "This change expired before native admission. Review current settings before another change.",
  invalid_request: "Review this change and confirmation.", unsupported: "This Hermes needs native tool management compatibility.", profile_not_served: "This profile is not served by the connected gateway.", native_read_failed: "Hermes could not read this profile's native tool catalog.", managed_setting: "This setting is inherited, essential, or managed and cannot be changed here.", config_conflict: "Settings or installed skills changed elsewhere. Refresh and review your change.", outcome_unknown: "The change outcome is unknown. Check its receipt before another edit.",
};
function toolsManagementResult(identity     , raw     )      {
  const snapshot = toolsSnapshot(raw.tools);
  const op = identity.operation;
  const mutation = !["tools.read", "tools.receipt"].includes(op);
  const kind = op === "tools.block" ? "blocks" : op === "tools.skillToggle" ? "skills" : identity.tools?.kind;
  const receipt = snapshot?.receipt;
  const readbackMatches = op === "tools.block" ? snapshot?.tools.find((row     ) => row.id === identity.tools?.name)?.blocked === identity.tools?.value : op === "tools.skillToggle" ? snapshot?.installedSkills.find((row     ) => row.name === identity.tools?.name)?.enabled === identity.tools?.value : true;
  const valid = op === "tools.read" || receipt?.mutationId === identity.tools?.mutationId && (!mutation || receipt.changedFields.length === 1 && receipt.changedFields[0] === kind && (op === "tools.recover" ? ["committed", "cancelled", "reconciled_unknown"].includes(receipt.outcome) : receipt.outcome === "committed"));
  const envelope = Object.fromEntries(["requestId", "operation", "scope", "profileId"].map(k => [k, identity[k]]));
  if (raw.status === "ok" && snapshot && valid && readbackMatches) return {...envelope, status: "ok", capabilities: [], tools: snapshot};
  const code = raw.status !== "ok" && errors[raw.errorCode] ? raw.errorCode : mutation ? "outcome_unknown" : "native_read_failed";
  return {...envelope, status: code === "unsupported" ? "unsupported" : "error", capabilities: [], errorCode: code, errorMessage: errors[code], ...(snapshot ? {tools: snapshot} : {})};
}

module.exports = { TOOLS_OPERATIONS, toolsRequest, toolsSnapshot, toolsManagementResult };
