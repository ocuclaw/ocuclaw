const HANDOFF_OPERATIONS = ["handoffs.read", "handoffs.set", "handoffs.restore"];
const HANDOFF_READS = new Set(["handoffs.read"]);

const MAX_AGENTS = 32;
const record = (value     ) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const agentName = (value     ) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const backendName = (value     ) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const safeText = (value     , max        ) =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u001f]/.test(value);

function names(value     )                  {
  if (!Array.isArray(value) || value.length > MAX_AGENTS) return null;
  if (!value.every(agentName) || new Set(value).size !== value.length) return null;
  return [...value];
}

function handoffsRequest(operation        , value     )      {
  if (!HANDOFF_OPERATIONS.includes(operation)) return null;
  const row = value ?? {};
  if (!record(row)) return null;
  if (operation === "handoffs.read") return Object.keys(row).length === 0 ? {} : null;
  if (operation === "handoffs.restore") {
    if (Object.keys(row).length !== 1) return null;
    const profiles = names(row.profiles);
    return profiles && profiles.length > 0 ? { profiles } : null;
  }
  if (Object.keys(row).some(key => !["enabled", "agents", "confirmReplace"].includes(key))) return null;
  if (typeof row.enabled !== "boolean") return null;
  const agents = names(row.agents ?? []);
  if (!agents || (row.enabled && agents.length === 0)) return null;
  const out      = { enabled: row.enabled, agents };
  if (row.confirmReplace !== undefined) {
    if (!backendName(row.confirmReplace)) return null;
    out.confirmReplace = row.confirmReplace;
  }
  return out;
}

function handoffsResult(operation        , raw     )      {
  if (!record(raw)) return null;
  if (operation === "handoffs.restore") {
    const restored = names(raw.restored);
    return restored ? { restored, applyTiming: "new_chat" } : null;
  }
  if (typeof raw.available !== "boolean" || typeof raw.enabled !== "boolean" || !backendName(raw.backend)) return null;
  if (!(raw.replaces === null || raw.replaces === undefined || backendName(raw.replaces))) return null;
  const agents        = [];
  for (const row of Array.isArray(raw.agents) ? raw.agents.slice(0, MAX_AGENTS) : []) {
    if (!record(row) || !agentName(row.id) || typeof row.allowed !== "boolean") continue;
    if (agents.some(seen => seen.id === row.id)) continue;
    const agent      = { id: row.id, name: safeText(row.name, 80) && row.name.trim() ? row.name : row.id, allowed: row.allowed };
    if (safeText(row.description, 280) && row.description.trim()) agent.description = row.description;
    agents.push(agent);
  }

  const stranded = raw.stranded === undefined ? [] : names(raw.stranded);
  if (stranded === null) return null;
  return {
    available: raw.available,
    enabled: raw.enabled,
    backend: raw.backend,
    replaces: raw.replaces ?? null,
    agents,
    stranded,
    applyTiming: "new_chat",
  };
}

const HANDOFF_ERRORS                         = {
  invalid_request: "Review the agents this agent may ask, then try again.",
  agent_not_enrolled: "One of those agents is no longer enrolled. Refresh and pick again.",
  replace_unconfirmed: "This agent uses another delegation backend. Confirm replacing it first.",
  managed: "This Hermes install is managed, so its delegation settings are read only.",
  native_read_failed: "Hermes could not read this agent's delegation settings.",
  profile_not_served: "This agent is no longer served here. Pick another one.",
};

module.exports = { HANDOFF_OPERATIONS, HANDOFF_READS, handoffsRequest, handoffsResult, HANDOFF_ERRORS };
