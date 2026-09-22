const AGENT_OPERATIONS = ["agents.list", "agents.enrol", "agents.remove", "agents.retry"];

const AGENT_STATES = ["default", "enrolled", "available", "incomplete", "missing"];
const ENROLLMENT_STATES = ["bounded", "unset", "invalid", "unreadable"];
const AGENT_ROW_FLAGS = ["enrolled", "removable", "enrollable"];
const MAX_AGENT_ROWS = 128;

const record = (value     ) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const agentName = (value     ) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const safeText = (value     , max = 128) =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u001f]/.test(value);

function agentsRequest(operation        , value     )      {
  if (!AGENT_OPERATIONS.includes(operation)) return null;
  const keys = operation === "agents.list" ? [] : ["profile"];
  const row = value ?? {};
  if (!record(row) || Object.keys(row).length !== keys.length ||
    !keys.every(key => Object.hasOwn(row, key))) return null;
  if (keys.length && !agentName(row.profile)) return null;
  return Object.fromEntries(keys.map(key => [key, row[key]]));
}

function agentsResult(raw     )      {
  if (!record(raw)) return null;
  const agents        = [];
  for (const row of Array.isArray(raw.agents) ? raw.agents.slice(0, MAX_AGENT_ROWS) : []) {
    if (!record(row) || !agentName(row.name) || !AGENT_STATES.includes(row.state)) continue;
    if (!AGENT_ROW_FLAGS.every(key => typeof row[key] === "boolean")) continue;
    if (agents.some(seen => seen.name === row.name)) continue;
    agents.push({ name: row.name, state: row.state, enrolled: row.enrolled,
      removable: row.removable, enrollable: row.enrollable });
  }
  const enrollment = raw.enrollment;
  if (!record(enrollment) || !ENROLLMENT_STATES.includes(enrollment.state) ||
    typeof enrollment.requiresReselection !== "boolean" ||
    !(enrollment.source === null || safeText(enrollment.source))) return null;
  if (typeof raw.multiplex !== "boolean") return null;
  return {
    agents,
    enrollment: { state: enrollment.state, source: enrollment.source,
      requiresReselection: enrollment.requiresReselection },
    multiplex: raw.multiplex,
  };
}

const AGENT_ERRORS                         = {
  invalid_request: "That agent change was not accepted. Refresh the agent list and try again.",
  invalid_scope: "Agents are shared across this gateway. Reopen the agent list.",
  profile_not_served: "This agent is not served by the connected gateway. Refresh the agent list.",
  setup_incomplete: "This agent is still being set up. Retry its setup, then add it.",
  write_failed: "Hermes could not record this change. Check the native gateway.",
  native_read_failed: "Hermes could not read its agents. Check the native gateway.",

  already_complete: "This agent's setup already finished. Refresh the agent list.",
  creation_in_flight: "This agent is being set up right now. Wait a moment, then try again.",
  multiplex_required: "Hermes is not serving multiple agents right now. Restart Hermes, then try again.",
  profile_missing: "This agent no longer exists on this host. Create it again.",
  receipt_unreadable: "OcuClaw has no setup record for this agent, so it cannot finish it. Create it again under a new name.",
  receipt_foreign: "This agent's setup record belongs to another creation request. Create it again under a new name.",
  setup_unrecoverable: "This agent was started by an older OcuClaw that did not keep its setup, so it cannot be finished. Create it again under a new name.",
  setup_rejected: "This agent's saved setup is no longer valid. Create it again under a new name.",
  setup_failed: "Setup could not finish. Check that Hermes is running, then try again.",
};

module.exports = { AGENT_OPERATIONS, AGENT_ERRORS, agentsRequest, agentsResult };
