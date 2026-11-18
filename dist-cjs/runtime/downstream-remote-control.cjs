const { parseOptionalTrimmedString } = require("./downstream-parse-optional.cjs");
const { GLASSES_ACTIONS } = require("./downstream-remote-control-glasses.cjs");
const { SESSION_ACTIONS } = require("./downstream-remote-control-sessions.cjs");
const { SETTINGS_ACTIONS } = require("./downstream-remote-control-settings.cjs");
const { AGENT_ACTIONS } = require("./downstream-remote-control-agents.cjs");
const { HERMES_ACTIONS } = require("./downstream-remote-control-hermes.cjs");
const { SILENT_INPUT_ACTIONS } = require("./downstream-remote-control-silent-input.cjs");
const { SYSTEM_ACTIONS } = require("./downstream-remote-control-system.cjs");
const { PAIRING_ACTIONS } = require("./downstream-remote-control-pairing.cjs");

const ACTION_TABLES = [
  GLASSES_ACTIONS,
  SESSION_ACTIONS,
  SETTINGS_ACTIONS,
  AGENT_ACTIONS,
  HERMES_ACTIONS,
  SILENT_INPUT_ACTIONS,
  SYSTEM_ACTIONS,
  PAIRING_ACTIONS,
];

const ACTION_PARSERS = new Map                                   ();
for (const table of ACTION_TABLES) {
  for (const [name, parse] of Object.entries(table)) {
    if (!ACTION_PARSERS.has(name)) ACTION_PARSERS.set(name, parse);
  }
}

function parseRemoteControl(msg) {
  if (!msg || typeof msg !== "object") {
    throw new Error("remote-control payload must be an object");
  }
  const actionRaw = parseOptionalTrimmedString(msg.action);
  if (!actionRaw) {
    throw new Error("remote-control action is required");
  }

  const action = actionRaw.toLowerCase();
  const payload = {
    action,
    requestId: parseOptionalTrimmedString(msg.requestId) || null,
  };

  const parse = ACTION_PARSERS.get(action);
  if (parse) return parse(msg, payload, action);

  throw new Error(`unsupported remote-control action: ${actionRaw}`);
}

module.exports = { parseRemoteControl };
