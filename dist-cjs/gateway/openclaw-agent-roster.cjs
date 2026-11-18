function cleanText(value     ) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function agentRosterShape(config     ) {
  const agents = config?.agents;
  if (!isRecord(agents)) return null;
  if (Array.isArray(agents.list)) return "list";
  if (isRecord(agents.entries)) return "entries";
  return null;
}

function configuredAgentRows(config     ) {
  const shape = agentRosterShape(config);
  if (shape === "list") return config.agents.list.filter(isRecord);
  if (shape === "entries") {
    return Object.entries(config.agents.entries)
      .filter(([, entry]) => isRecord(entry))
      .map(([key, entry]     ) => ({ ...entry, id: key }));
  }
  return [];
}

function findConfiguredAgent(config     , agentId     ) {
  const id = cleanText(agentId).toLowerCase();
  if (!id) return null;
  return configuredAgentRows(config).find((row     ) => cleanText(row.id).toLowerCase() === id) || null;
}

function isLegacyAgentListRefusal(error     ) {
  return /unrecognized key:?\s*\\?"?list\\?"?/i.test(cleanText(error?.message));
}

function isAgentOwnershipRefusal(error     ) {
  return cleanText(error?.message).toLowerCase().includes("agents.ownership");
}

const AGENT_ROSTER_MIGRATION_MESSAGE =
  "OpenClaw needs a one-time config update. Run `openclaw doctor --fix` on the host, then try again.";

module.exports = { agentRosterShape, configuredAgentRows, findConfiguredAgent, isLegacyAgentListRefusal, isAgentOwnershipRefusal, AGENT_ROSTER_MIGRATION_MESSAGE };
