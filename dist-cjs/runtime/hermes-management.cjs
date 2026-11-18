const { MEMORY_OPERATIONS, MEMORY_ERRORS, memoryRequest, memoryResult } = require("./hermes-memory-management.cjs");
const { HERMES_JOB_OPERATIONS, HERMES_JOB_READS, jobsRequest, jobsResult } = require("./hermes-jobs-management.cjs");
const { isApprovalsOperation, approvalsRequest, approvalsManagementResult } = require("./hermes-approvals-management.cjs");
const { SKILLS_OPERATIONS, SKILLS_ERRORS, skillsRequest, skillsResult } = require("./hermes-skills-management.cjs");
const { HERMES_AUTOMATION_OPERATIONS, HERMES_AUTOMATION_READS, automationsRequest, automationsResult } = require("./hermes-automations-management.cjs");
const { isPermissionsOperation, permissionsRequest, permissionsManagementResult } = require("./hermes-permissions-management.cjs");
const { HEALTH_OPERATIONS, HEALTH_READS, healthRequest, healthResult } = require("./hermes-health-management.cjs");
const { SAVED_OPERATIONS, SAVED_ERRORS, savedRequest, savedResult } = require("./hermes-saved-management.cjs");
const { AGENT_OPERATIONS, AGENT_ERRORS, agentsRequest, agentsResult } = require("./hermes-agents-management.cjs");
const { HANDOFF_OPERATIONS, HANDOFF_READS, HANDOFF_ERRORS, handoffsRequest, handoffsResult } = require("./hermes-handoffs-management.cjs");
const { TOOLS_OPERATIONS, toolsRequest, toolsManagementResult } = require("./hermes-tools-management.cjs");
const { MODELS_OPERATIONS, MODELS_READS, modelsRequest, modelsManagementResult } = require("./hermes-models-management.cjs");
const { CONNECTION_OPERATIONS, CONNECTION_READS, connectionsRequest, connectionsManagementResult } = require("./hermes-connections-management.cjs");
const { MAINTENANCE_OPERATIONS, maintenanceRequest, maintenanceManagementResult, maintenanceFailure } = require("./maintenance-management.cjs");
const { isLearningOperation, learningRequest, learningManagementResult } = require("./hermes-learning-management.cjs");
const { PLUGINS_OPERATIONS, PLUGINS_READS, pluginsRequest, pluginsManagementResult } = require("./plugins-management.cjs");
const { CLAWHUB_OPERATIONS, CLAWHUB_READS, clawhubRequest, clawhubManagementResult } = require("./clawhub-management.cjs");
const { BOARD_OPERATIONS, BOARD_ERRORS, BOARD_UNCERTAIN_WRITES, boardErrorMessage, boardRequest, boardResult } = require("./hermes-board-management.cjs");
const { HEARTBEAT_OPERATIONS, HEARTBEAT_READS, isHeartbeatOperation, heartbeatRequest, heartbeatManagementResult } = require("./heartbeat-management.cjs");

const BOARD_UNCERTAIN_CODES = new Set(["management_unavailable", "response_identity_mismatch", "invalid_board_result"]);

function managementIdentity(value     ) {
  const text = (v     , max     ) => typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : "";
  return {
    requestId: text(value?.requestId, 128),
    operation: text(value?.operation, 80),
    scope: text(value?.scope, 16),
    profileId: text(value?.profileId, 128),
  };
}

function sanitizeManagementRequest(value     ) {
  return managementRequest(value);
}

function validManagementRequest(value     ) {

  if (MAINTENANCE_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "gateway" && value.maintenance != null);
  if (CONNECTION_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.connections !== null && connectionsRequest(value.operation, value.connections));
  if (TOOLS_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.tools !== null && toolsRequest(value.operation, value.tools));
  if (MODELS_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.models !== null && modelsRequest(value.operation, value.models));
  if (PLUGINS_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.plugins !== null && pluginsRequest(value.operation, value.plugins));
  if (CLAWHUB_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.clawhub !== null && clawhubRequest(value.operation, value.clawhub));
  if (BOARD_OPERATIONS.has(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.board !== null);
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
  if (isHeartbeatOperation(value.operation)) return Boolean(value.requestId && value.profileId && value.scope === "profile" && value.heartbeat);

  if (AGENT_OPERATIONS.includes(value.operation)) return Boolean(value.requestId && value.profileId === "default" && value.scope === "gateway" && agentsRequest(value.operation, value.agents));

  if (HANDOFF_OPERATIONS.includes(value.operation)) {
    const restore = value.operation === "handoffs.restore";
    return Boolean(value.requestId && value.profileId && (restore ? value.profileId === "default" && value.scope === "gateway" : value.scope === "profile") &&
      value.handoffs && handoffsRequest(value.operation, value.handoffs));
  }
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

function managementRequest(value     ) {
  const identity      = managementIdentity(value);
  if (MAINTENANCE_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "maintenance"];
    identity.maintenance = Object.keys(value || {}).every(key => allowed.includes(key)) ? maintenanceRequest(identity.operation, value.maintenance) : null;
  }
  if (CONNECTION_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "connections"];
    identity.connections = Object.keys(value || {}).every(key => allowed.includes(key)) ? connectionsRequest(identity.operation, value.connections) : null;
  }
  if (TOOLS_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "tools"];
    identity.tools = Object.keys(value || {}).every(key => allowed.includes(key)) ? toolsRequest(identity.operation, value.tools) : null;
  }
  if (MODELS_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "models"];
    identity.models = Object.keys(value || {}).every(key => allowed.includes(key)) ? modelsRequest(identity.operation, value.models) : null;
  }
  if (PLUGINS_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "plugins"];
    identity.plugins = Object.keys(value || {}).every(key => allowed.includes(key)) ? pluginsRequest(identity.operation, value.plugins) : null;
  }
  if (CLAWHUB_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "clawhub"];
    identity.clawhub = Object.keys(value || {}).every(key => allowed.includes(key)) ? clawhubRequest(identity.operation, value.clawhub) : null;
  }
  if (BOARD_OPERATIONS.has(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "board"];
    identity.board = Object.keys(value || {}).every(key => allowed.includes(key)) ? boardRequest(identity.operation, value?.board) : null;
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
  if (AGENT_OPERATIONS.includes(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "agents"];
    identity.agents = Object.keys(value || {}).every(key => allowed.includes(key)) ? agentsRequest(identity.operation, value.agents) : null;
  }
  if (HANDOFF_OPERATIONS.includes(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "handoffs"];
    identity.handoffs = Object.keys(value || {}).every(key => allowed.includes(key)) ? handoffsRequest(identity.operation, value.handoffs) : null;
  }
  if (isLearningOperation(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "learning"];
    identity.learning = Object.keys(value || {}).every(key => allowed.includes(key)) ? learningRequest(identity.operation, value.learning) : null;
  }
  if (isHeartbeatOperation(identity.operation)) {
    const allowed = ["type", "requestId", "operation", "scope", "profileId", "heartbeat"];
    identity.heartbeat = Object.keys(value || {}).every(key => allowed.includes(key)) ? heartbeatRequest(identity.operation, value.heartbeat) : null;
  }
  return identity;
}

const SHARED_ERRORS      = {
  config_changed: "This setting changed on the host while you were editing. Reload it, then try again.",
  rate_limited: "Too many changes in a minute. Wait a moment, then try again.",
  profile_not_served: "This agent is no longer served here. Pick another one.",
};

function managementFailure(identity     , code = "management_unavailable", unsupported = false, backend = "Hermes") {
  if (MAINTENANCE_OPERATIONS.has(identity.operation)) return maintenanceFailure(identity, code, unsupported, backend);
  if (!unsupported && CONNECTION_OPERATIONS.has(identity.operation) && !CONNECTION_READS.has(identity.operation)) code = "outcome_unknown";
  if (!unsupported && HERMES_JOB_OPERATIONS.has(identity.operation) && !HERMES_JOB_READS.has(identity.operation)) code = "outcome_unknown";
  if (!unsupported && HERMES_AUTOMATION_OPERATIONS.has(identity.operation) && !HERMES_AUTOMATION_READS.has(identity.operation)) code = "outcome_unknown";
  if (!unsupported && HEALTH_OPERATIONS.has(identity.operation) && !HEALTH_READS.has(identity.operation)) code = "outcome_unknown";

  if (!unsupported && MODELS_OPERATIONS.has(identity.operation) && !MODELS_READS.has(identity.operation) &&
      !["invalid_request", "phone_only"].includes(code)) code = "outcome_unknown";

  if (!unsupported && PLUGINS_OPERATIONS.has(identity.operation) && !PLUGINS_READS.has(identity.operation) &&
    !["invalid_request", "phone_only"].includes(code)) code = "outcome_unknown";

  if (!unsupported && HEARTBEAT_OPERATIONS.has(identity.operation) && !HEARTBEAT_READS.has(identity.operation) &&
      code === "management_unavailable") code = "outcome_unknown";
  if (!unsupported && HANDOFF_OPERATIONS.includes(identity.operation) && !HANDOFF_READS.has(identity.operation) &&
      code === "management_unavailable") code = "outcome_unknown";
  if (!unsupported && CLAWHUB_OPERATIONS.has(identity.operation) && !CLAWHUB_READS.has(identity.operation) &&
    !["invalid_request", "phone_only"].includes(code)) code = "outcome_unknown";

  if (!unsupported && BOARD_UNCERTAIN_WRITES.has(identity.operation) && BOARD_UNCERTAIN_CODES.has(code)) code = "outcome_unknown";
  return { ...managementIdentity(identity), status: unsupported ? "unsupported" : "error",
    capabilities: [], errorCode: code,
    errorMessage: unsupported ? `This ${backend} host does not support this operation. Update ${backend} and OcuClaw to a compatible version.` : code === "outcome_unknown" ? "Outcome unknown. Check the operation receipt; do not repeat this action." : `Could not read ${backend} management state. Refresh when connected.` };
}

const SUMMARY_COUNTS = ["toolsets", "skills", "mcp", "mcpNeedsAuth", "jobs", "failedJobs7d", "savedEntries", "nextJobAtMs", "diskFreeBytes", "heartbeatMinutes", "pairingRequests"];
function overviewSummary(raw     ) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const summary      = {};

  if (["smart", "manual", "off", "deny", "allowlist", "ask", "auto", "full"].includes(raw.approvalsMode)) summary.approvalsMode = raw.approvalsMode;
  for (const key of SUMMARY_COUNTS) if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) summary[key] = raw[key];
  if (typeof raw.reviewsOn === "boolean") summary.reviewsOn = raw.reviewsOn;
  if (typeof raw.heartbeatPaused === "boolean") summary.heartbeatPaused = raw.heartbeatPaused;
  return Object.keys(summary).length > 0 ? summary : null;
}

function hostNamed(message     , backend     ) {
  return backend === "Hermes" ? message : message.replace(/native Hermes/g, backend);
}

function managementResult(identity     , raw     , backend = "Hermes") {
  if (!raw || ["requestId", "operation", "scope", "profileId"].some(key => raw[key] !== identity[key])) {
    return managementFailure(identity, "response_identity_mismatch", false, backend);
  }
  if (MAINTENANCE_OPERATIONS.has(identity.operation)) return maintenanceManagementResult(identity, raw, backend);
  if (isApprovalsOperation(identity.operation)) return approvalsManagementResult(identity, raw, backend);
  if (isPermissionsOperation(identity.operation)) return permissionsManagementResult(identity, raw, backend);
  if (TOOLS_OPERATIONS.has(identity.operation)) return toolsManagementResult(identity, raw, backend);
  if (MODELS_OPERATIONS.has(identity.operation)) return modelsManagementResult(identity, raw, SHARED_ERRORS);
  if (CONNECTION_OPERATIONS.has(identity.operation)) return connectionsManagementResult(identity, raw, backend);
  if (PLUGINS_OPERATIONS.has(identity.operation)) return pluginsManagementResult(identity, raw, backend);
  if (CLAWHUB_OPERATIONS.has(identity.operation)) return clawhubManagementResult(identity, raw, backend);
  if (isLearningOperation(identity.operation)) return learningManagementResult(identity, raw);
  if (isHeartbeatOperation(identity.operation)) return heartbeatManagementResult(identity, raw, backend);
  if (raw.status === "unsupported") return managementFailure(identity, "unsupported", true, backend);
  if (raw.status !== "ok") {
    const rejected = ["invalid_request", "profile_not_served", "gateway_changed", "operation_conflict", "stale_preview", "already_draining", "receipt_store_full"];
    const failed = managementFailure(identity, identity.operation.startsWith("restart.") && rejected.includes(raw.errorCode) ? raw.errorCode : "management_unavailable", false, backend);

    if (Object.hasOwn(SHARED_ERRORS, raw.errorCode) && ["management_unavailable", "outcome_unknown"].includes(failed.errorCode)) {
      failed.errorCode = raw.errorCode;
      failed.errorMessage = SHARED_ERRORS[raw.errorCode];
    }
    if (MEMORY_OPERATIONS.includes(identity.operation) && MEMORY_ERRORS[raw.errorCode]) {
      failed.errorCode = raw.errorCode;
      failed.errorMessage = MEMORY_ERRORS[raw.errorCode];
    }
    if (SKILLS_OPERATIONS.includes(identity.operation) && SKILLS_ERRORS[raw.errorCode]) {
      failed.errorCode = raw.errorCode;
      failed.errorMessage = hostNamed(SKILLS_ERRORS[raw.errorCode], backend);
    }
    if (HEALTH_READS.has(identity.operation) && raw.errorCode === "permission_denied") {
      failed.errorCode = "permission_denied";
      failed.errorMessage = "Permission denied reading native health. Check the selected profile's storage permissions on the host.";
    }
    if (HERMES_AUTOMATION_READS.has(identity.operation)) {
      const messages      = {
        invalid_fields: "The native scheduler rejected these fields or schedule. Check the form before saving.",
        missing_destination: "This native delivery destination is unavailable or needs its home target configured.",
        stale_edit: "This native job changed while you were editing. Reopen it before saving.",
        invalid_context: "A context job is missing or refers to this same job. Choose existing native job IDs.",
        not_editable: "This job can't be edited here. Pause, run or change it on the host.",
      };
      if (Object.hasOwn(messages, raw.errorCode)) {
        failed.errorCode = raw.errorCode;
        failed.errorMessage = messages[raw.errorCode];
      }
    }
    if (BOARD_OPERATIONS.has(identity.operation) && Object.hasOwn(BOARD_ERRORS, raw.errorCode)) {
      failed.errorCode = raw.errorCode;
      failed.errorMessage = boardErrorMessage(identity.operation, raw.errorCode);
    }
    if (HANDOFF_OPERATIONS.includes(identity.operation) && Object.hasOwn(HANDOFF_ERRORS, raw.errorCode)) {

      failed.errorCode = raw.errorCode;
      failed.errorMessage = HANDOFF_ERRORS[raw.errorCode];
    }
    if (SAVED_OPERATIONS.includes(identity.operation) && SAVED_ERRORS[raw.errorCode]) {
      failed.errorCode = raw.errorCode;
      failed.errorMessage = hostNamed(SAVED_ERRORS[raw.errorCode], backend);
    }
    if (AGENT_OPERATIONS.includes(identity.operation) && AGENT_ERRORS[raw.errorCode]) {
      failed.errorCode = raw.errorCode;

      const sent = typeof raw.errorMessage === "string" && raw.errorMessage.trim().length > 0 &&
        raw.errorMessage.length <= 256 && [...raw.errorMessage].every(ch => ch.codePointAt(0) >= 32) ? raw.errorMessage : null;
      failed.errorMessage = sent ?? AGENT_ERRORS[raw.errorCode];
    }
    return failed;
  }
  const result      = { ...managementIdentity(identity), status: "ok", capabilities: [] };
  if (HERMES_JOB_OPERATIONS.has(identity.operation)) result.jobs = jobsResult(raw.jobs);
  if (HERMES_AUTOMATION_OPERATIONS.has(identity.operation)) result.automations = automationsResult(raw.automations);
  if (HEALTH_OPERATIONS.has(identity.operation)) {
    try { result.health = healthResult(raw.health); }
    catch { return managementFailure(identity, "invalid_health_result"); }
  }
  const safeText = (value     ) => typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f]/.test(value);

  for (const entry of Array.isArray(raw.capabilities) ? raw.capabilities.slice(0, 100) : []) {
    if (!entry || !safeText(entry.operation) || !["profile", "gateway"].includes(entry.scope) || typeof entry.supported !== "boolean") continue;
    result.capabilities.push({ operation: entry.operation, scope: entry.scope, supported: entry.supported,
      ...(["read_only", "active_now", "subsequent_guard_checks", "future_chat", "new_chat", "restart_required", "new_session_or_restart"].includes(entry.applyTiming) ? { applyTiming: entry.applyTiming } : {}) });
  }
  if (identity.operation === "overview" && raw.overview && typeof raw.overview === "object") {
    const overview      = {};
    for (const key of ["profileName", "model", "provider"]) if (safeText(raw.overview[key])) overview[key] = raw.overview[key];
    if (["running", "unknown"].includes(raw.overview.gatewayState)) overview.gatewayState = raw.overview.gatewayState;
    for (const key of ["servedProfiles", "activeWork", "attentionCount"]) {
      if (Number.isSafeInteger(raw.overview[key]) && raw.overview[key] >= 0) overview[key] = raw.overview[key];
    }
    if (["profile", "gateway"].includes(raw.overview.activeWorkScope)) overview.activeWorkScope = raw.overview.activeWorkScope;
    if (raw.overview.attentionKind === "learning_proposals") overview.attentionKind = "learning_proposals";
    const summary = overviewSummary(raw.overview.summary);
    if (summary) overview.summary = summary;
    result.overview = overview;
  }
  if (identity.operation.startsWith("restart.") && raw.restart && typeof raw.restart === "object") {
    const row = raw.restart;
    const restart      = {};
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
      const receipt      = {};
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
  if (AGENT_OPERATIONS.includes(identity.operation)) result.agents = agentsResult(raw.agents);
  if (HANDOFF_OPERATIONS.includes(identity.operation)) {
    const handoffs = handoffsResult(identity.operation, raw.handoffs);
    if (!handoffs) return managementFailure(identity, "invalid_handoffs_result");
    result.handoffs = handoffs;
  }
  if (BOARD_OPERATIONS.has(identity.operation)) {
    try { result.board = boardResult(identity.operation, raw.board, identity.board); }
    catch { return managementFailure(identity, "invalid_board_result"); }
  }
  return result;
}

module.exports = { managementIdentity, sanitizeManagementRequest, validManagementRequest, managementRequest, managementFailure, managementResult };
