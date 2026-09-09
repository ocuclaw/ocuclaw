const { MEMORY_OPERATIONS, MEMORY_ERRORS, memoryRequest, memoryResult } = require("./hermes-memory-management.cjs");
const { HERMES_JOB_OPERATIONS, HERMES_JOB_READS, jobsRequest, jobsResult } = require("./hermes-jobs-management.cjs");
const { isApprovalsOperation, approvalsRequest, approvalsManagementResult } = require("./hermes-approvals-management.cjs");
const { SKILLS_OPERATIONS, SKILLS_ERRORS, skillsRequest, skillsResult } = require("./hermes-skills-management.cjs");
const { HERMES_AUTOMATION_OPERATIONS, HERMES_AUTOMATION_READS, automationsRequest, automationsResult } = require("./hermes-automations-management.cjs");
const { isPermissionsOperation, permissionsRequest, permissionsManagementResult } = require("./hermes-permissions-management.cjs");
const { HEALTH_OPERATIONS, HEALTH_READS, healthRequest, healthResult } = require("./hermes-health-management.cjs");
const { SAVED_OPERATIONS, SAVED_ERRORS, savedRequest, savedResult } = require("./hermes-saved-management.cjs");
const { TOOLS_OPERATIONS, toolsRequest, toolsManagementResult } = require("./hermes-tools-management.cjs");
const { CONNECTION_OPERATIONS, CONNECTION_READS, connectionsRequest, connectionsManagementResult } = require("./hermes-connections-management.cjs");
const { isLearningOperation, learningRequest, learningManagementResult } = require("./hermes-learning-management.cjs");

function managementIdentity(value) {
  const text = (v, max) => typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : "";
  return {
    requestId: text(value?.requestId, 128),
    operation: text(value?.operation, 80),
    scope: text(value?.scope, 16),
    profileId: text(value?.profileId, 128),
  };
}

function sanitizeManagementRequest(value) {
  return managementRequest(value);
}

function validManagementRequest(value) {
  if (CONNECTION_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.connections !== null && connectionsRequest(value.operation, value.connections));
  if (TOOLS_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.tools !== null && toolsRequest(value.operation, value.tools));
  if (["restart.preview", "restart.request", "restart.status"].includes(value.operation)) {
    const keys = value.operation === "restart.preview" ? [] : value.operation === "restart.status"
      ? ["operationId", "gatewayId"] : ["operationId", "gatewayId", "bootId", "scopeRevision"];
    const payload = value.payload ?? {};
    return Boolean(value.requestId && value.profileId && value.scope === "gateway" &&
      payload && typeof payload === "object" && !Array.isArray(payload) &&
      Object.keys(payload).length === keys.length && keys.every(key =>
        typeof payload[key] === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(payload[key])));
  }
  if (isApprovalsOperation(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && approvalsRequest(value.operation, value.approvals));
  if (isPermissionsOperation(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && permissionsRequest(value.operation, value.permissions));
  if (isLearningOperation(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && learningRequest(value.operation, value.learning));
  return Boolean(value.requestId && value.profileId &&
    (value.operation === "overview" || value.operation === "capabilities" ||
      (MEMORY_OPERATIONS.includes(value.operation) && value.memory !== null) ||
      (HERMES_JOB_OPERATIONS.has(value.operation) && value.jobs !== undefined && jobsRequest(value.operation, value.jobs) !== undefined) ||
      (HERMES_AUTOMATION_OPERATIONS.has(value.operation) && automationsRequest(value.operation, value.automations) !== undefined) ||
      (HEALTH_OPERATIONS.has(value.operation) && value.health !== undefined && healthRequest(value.operation, value.health) !== undefined) ||
      (SKILLS_OPERATIONS.includes(value.operation) && value.skills !== null) ||
      (SAVED_OPERATIONS.includes(value.operation) && value.saved !== null)) &&
    (value.scope === "profile" || (value.operation === "capabilities" && value.scope === "gateway")));
}

function managementRequest(value) {
  const identity = managementIdentity(value);
  if (CONNECTION_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "connections"];
    identity.connections = Object.keys(value || {}).every(key => allowed.includes(key)) ? connectionsRequest(identity.operation, value.connections) : null;
  }
  if (TOOLS_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "tools"];
    identity.tools = Object.keys(value || {}).every(key => allowed.includes(key)) ? toolsRequest(identity.operation, value.tools) : null;
  }
  if (identity.operation.startsWith("restart.")) identity.payload = value?.payload ?? {};
  if (MEMORY_OPERATIONS.includes(identity.operation)) identity.memory = memoryRequest(identity.operation, value?.memory);
  if (HERMES_JOB_OPERATIONS.has(identity.operation)) identity.jobs = jobsRequest(identity.operation, value?.jobs);
  if (HERMES_AUTOMATION_OPERATIONS.has(identity.operation)) identity.automations = automationsRequest(identity.operation, value?.automations);
  if (HEALTH_OPERATIONS.has(identity.operation)) identity.health = healthRequest(identity.operation, value?.health);
  if (isApprovalsOperation(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "approvals"];
    identity.approvals = Object.keys(value || {}).every(key => allowed.includes(key)) ? approvalsRequest(identity.operation, value.approvals) : null;
  }
  if (SKILLS_OPERATIONS.includes(identity.operation)) identity.skills = skillsRequest(identity.operation, value?.skills);
  if (isPermissionsOperation(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "permissions"];
    identity.permissions = Object.keys(value || {}).every(key => allowed.includes(key)) ? permissionsRequest(identity.operation, value.permissions) : null;
  }
  if (SAVED_OPERATIONS.includes(identity.operation)) identity.saved = savedRequest(identity.operation, value?.saved);
  if (isLearningOperation(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "learning"];
    identity.learning = Object.keys(value || {}).every(key => allowed.includes(key)) ? learningRequest(identity.operation, value.learning) : null;
  }
  return identity;
}

function managementFailure(identity, code = "management_unavailable", unsupported = false) {
  if (!unsupported && CONNECTION_OPERATIONS.has(identity.operation) && !CONNECTION_READS.has(identity.operation)) code = "outcome_unknown";
  if (!unsupported && HERMES_JOB_OPERATIONS.has(identity.operation) && !HERMES_JOB_READS.has(identity.operation)) code = "outcome_unknown";
  if (!unsupported && HERMES_AUTOMATION_OPERATIONS.has(identity.operation) && !HERMES_AUTOMATION_READS.has(identity.operation)) code = "outcome_unknown";
  if (!unsupported && HEALTH_OPERATIONS.has(identity.operation) && !HEALTH_READS.has(identity.operation)) code = "outcome_unknown";
  return { ...managementIdentity(identity), status: unsupported ? "unsupported" : "error",
    capabilities: [], errorCode: code,
    errorMessage: unsupported ? "This Hermes host does not support this operation. Update Hermes and OcuClaw to a compatible version." : code === "outcome_unknown" ? "Outcome unknown. Check the operation receipt; do not repeat this action." : "Could not read Hermes management state. Refresh when connected." };
}

function managementResult(identity, raw) {
  if (!raw || ["requestId", "operation", "scope", "profileId"].some(key => raw[key] !== identity[key])) {
    return managementFailure(identity, "response_identity_mismatch");
  }
  if (isApprovalsOperation(identity.operation)) return approvalsManagementResult(identity, raw);
  if (isPermissionsOperation(identity.operation)) return permissionsManagementResult(identity, raw);
  if (TOOLS_OPERATIONS.has(identity.operation)) return toolsManagementResult(identity, raw);
  if (CONNECTION_OPERATIONS.has(identity.operation)) return connectionsManagementResult(identity, raw);
  if (isLearningOperation(identity.operation)) return learningManagementResult(identity, raw);
  if (raw.status === "unsupported") return managementFailure(identity, "unsupported", true);
  if (raw.status !== "ok") {
    const rejected = ["invalid_request", "profile_not_served", "gateway_changed", "operation_conflict", "stale_preview", "already_draining", "receipt_store_full"];
    const failed = managementFailure(identity, identity.operation.startsWith("restart.") && rejected.includes(raw.errorCode) ? raw.errorCode : "management_unavailable");
    if (MEMORY_OPERATIONS.includes(identity.operation) && MEMORY_ERRORS[raw.errorCode]) {
      failed.errorCode = raw.errorCode;
      failed.errorMessage = MEMORY_ERRORS[raw.errorCode];
    }
    if (SKILLS_OPERATIONS.includes(identity.operation) && SKILLS_ERRORS[raw.errorCode]) {
      failed.errorCode = raw.errorCode;
      failed.errorMessage = SKILLS_ERRORS[raw.errorCode];
    }
    if (HEALTH_READS.has(identity.operation) && raw.errorCode === "permission_denied") {
      failed.errorCode = "permission_denied";
      failed.errorMessage = "Permission denied reading native health. Check the selected profile's storage permissions on the host.";
    }
    if (HERMES_AUTOMATION_READS.has(identity.operation)) {
      const messages = {
        invalid_fields: "The native scheduler rejected these fields or schedule. Check the form before saving.",
        missing_destination: "This native delivery destination is unavailable or needs its home target configured.",
        stale_edit: "This native job changed while you were editing. Reopen it before saving.",
        invalid_context: "A context job is missing or refers to this same job. Choose existing native job IDs.",
      };
      if (Object.hasOwn(messages, raw.errorCode)) {
        failed.errorCode = raw.errorCode;
        failed.errorMessage = messages[raw.errorCode];
      }
    }
    if (SAVED_OPERATIONS.includes(identity.operation) && SAVED_ERRORS[raw.errorCode]) {
      failed.errorCode = raw.errorCode;
      failed.errorMessage = SAVED_ERRORS[raw.errorCode];
    }
    return failed;
  }
  const result = { ...managementIdentity(identity), status: "ok", capabilities: [] };
  if (HERMES_JOB_OPERATIONS.has(identity.operation)) result.jobs = jobsResult(raw.jobs);
  if (HERMES_AUTOMATION_OPERATIONS.has(identity.operation)) result.automations = automationsResult(raw.automations);
  if (HEALTH_OPERATIONS.has(identity.operation)) {
    try { result.health = healthResult(raw.health); }
    catch { return managementFailure(identity, "invalid_health_result"); }
  }
  const safeText = (value) => typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f]/.test(value);

  for (const entry of Array.isArray(raw.capabilities) ? raw.capabilities.slice(0, 100) : []) {
    if (!entry || !safeText(entry.operation) || !["profile", "gateway"].includes(entry.scope) || typeof entry.supported !== "boolean") continue;
    result.capabilities.push({ operation: entry.operation, scope: entry.scope, supported: entry.supported,
      ...(["read_only", "active_now", "subsequent_guard_checks", "future_chat", "new_chat", "restart_required", "new_session_or_restart"].includes(entry.applyTiming) ? { applyTiming: entry.applyTiming } : {}) });
  }
  if (identity.operation === "overview" && raw.overview && typeof raw.overview === "object") {
    const overview = {};
    for (const key of ["profileName", "model", "provider"]) if (safeText(raw.overview[key])) overview[key] = raw.overview[key];
    if (["running", "unknown"].includes(raw.overview.gatewayState)) overview.gatewayState = raw.overview.gatewayState;
    for (const key of ["servedProfiles", "activeWork", "attentionCount"]) {
      if (Number.isSafeInteger(raw.overview[key]) && raw.overview[key] >= 0) overview[key] = raw.overview[key];
    }
    if (["profile", "gateway"].includes(raw.overview.activeWorkScope)) overview.activeWorkScope = raw.overview.activeWorkScope;
    if (raw.overview.attentionKind === "learning_proposals") overview.attentionKind = "learning_proposals";
    result.overview = overview;
  }
  if (identity.operation.startsWith("restart.") && raw.restart && typeof raw.restart === "object") {
    const row = raw.restart;
    const restart = {};
    for (const key of ["gatewayId", "bootId", "scopeRevision"]) {
      if (typeof row[key] !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(row[key])) return managementFailure(identity, "invalid_restart_result");
      restart[key] = row[key];
    }
    if (!Array.isArray(row.affectedProfiles) || row.affectedProfiles.length > 128 ||
        !row.affectedProfiles.every(safeText) || !["ready", "draining"].includes(row.phase) ||
        typeof row.supported !== "boolean") return managementFailure(identity, "invalid_restart_result");
    Object.assign(restart, { affectedProfiles: row.affectedProfiles, phase: row.phase, supported: row.supported });
    for (const key of ["activeWork", "waitSeconds", "drainSeconds"]) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) return managementFailure(identity, "invalid_restart_result");
      restart[key] = row[key];
    }
    if (row.receipt) {
      const receipt = {};
      for (const key of ["operationId", "gatewayId", "oldBootId", "scopeRevision"]) {
        if (typeof row.receipt[key] !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(row.receipt[key])) return managementFailure(identity, "invalid_restart_result");
        receipt[key] = row.receipt[key];
      }
      if (!["accepted", "rejected", "unconfirmed", "recovered"].includes(row.receipt.phase)) return managementFailure(identity, "invalid_restart_result");
      receipt.phase = row.receipt.phase;
      restart.receipt = receipt;
    }
    result.restart = restart;
  }
  if (MEMORY_OPERATIONS.includes(identity.operation)) {
    try { result.memory = memoryResult(identity.operation, raw.memory, identity.memory); }
    catch { return managementFailure(identity, "invalid_memory_response"); }
  }
  if (SKILLS_OPERATIONS.includes(identity.operation)) {
    try { result.skills = skillsResult(identity.operation, raw.skills, identity.skills); }
    catch { return managementFailure(identity, "invalid_skills_response"); }
  }
  if (SAVED_OPERATIONS.includes(identity.operation)) {
    try { result.saved = savedResult(identity.operation, raw.saved, identity.saved); }
    catch { return managementFailure(identity, "invalid_saved_response"); }
  }
  return result;
}

module.exports = { managementIdentity, managementRequest, sanitizeManagementRequest, validManagementRequest, managementFailure, managementResult };
