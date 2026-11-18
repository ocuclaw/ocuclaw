const { parseOptionalTrimmedString, parseEnvelopeOnly } = require("./downstream-parse-optional.cjs");

function parseAgentEnrolment(msg     , payload                      , action        ) {
  const agentId = parseOptionalTrimmedString(msg.text);
  if (!agentId || agentId.length > 160) {
    throw new Error(`remote-control ${action} requires a bounded agent id in text`);
  }
  return { ...payload, text: agentId };
}

function parseAgentTextRequired(msg     , payload                      , action        ) {
  const value = parseOptionalTrimmedString(msg.text);
  if (!value) {
    throw new Error(`remote-control ${action} requires text`);
  }
  return { ...payload, text: value };
}

const AGENT_ACTIONS                           = {
  "webui-agent-menu-open": parseEnvelopeOnly,

  "webui-agent-select"(msg, payload) {
    const agentId = parseOptionalTrimmedString(msg.text);
    if (!agentId) {
      throw new Error("remote-control webui-agent-select requires text (the agent id)");
    }
    return { ...payload, text: agentId };
  },

  "webui-agent-enrol": parseAgentEnrolment,
  "webui-agent-remove": parseAgentEnrolment,
  "webui-agent-retry": parseAgentEnrolment,

  "webui-default-agent-set"(msg, payload) {
    const surface = parseOptionalTrimmedString(msg.value);
    if (surface !== "ocuclaw" && surface !== "even-ai") {
      throw new Error("remote-control webui-default-agent-set requires value ocuclaw|even-ai");
    }
    const agentId = parseOptionalTrimmedString(msg.text) || "";
    if (agentId.length > 160) {
      throw new Error("remote-control webui-default-agent-set requires a bounded agent id in text");
    }
    return { ...payload, value: surface, text: agentId };
  },

  "webui-new-session-in-agent"(msg, payload) {
    const agentId = parseOptionalTrimmedString(msg.text);
    if (!agentId) {
      throw new Error(
        "remote-control webui-new-session-in-agent requires text (the agent id)",
      );
    }
    return { ...payload, text: agentId };
  },

  "webui-setup-help-open": parseEnvelopeOnly,
  "webui-setup-help-dismiss": parseEnvelopeOnly,
  "webui-agent-create-open": parseEnvelopeOnly,
  "webui-agent-create-tap": parseEnvelopeOnly,
  "webui-agent-create-next": parseEnvelopeOnly,
  "webui-agent-create-submit": parseEnvelopeOnly,
  "webui-agent-create-restart": parseEnvelopeOnly,
  "webui-agent-create-dismiss": parseEnvelopeOnly,

  "webui-agent-create-edit"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);
    if (!text || text.length > 8500 || !text.includes("=")) throw new Error("agent-create-edit requires key=value");
    return { ...payload, text };
  },

  "webui-agent-create-set-name"(msg, payload) {
    const name = parseOptionalTrimmedString(msg.text);
    if (!name) {
      throw new Error("remote-control webui-agent-create-set-name requires text (the name)");
    }
    return { ...payload, text: name };
  },

  "webui-agent-emoji-open": parseAgentTextRequired,
  "webui-agent-emoji-set": parseAgentTextRequired,
  "webui-agent-settings-open": parseAgentTextRequired,
  "webui-agent-settings-icon-set": parseAgentTextRequired,

  "webui-agent-actions-menu"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);
    if (!text || !["open", "settings", "dismiss"].includes(text)) throw new Error("Invalid agent actions menu action");
    return { ...payload, text };
  },

  "webui-agent-icon-picker"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);
    if (!text || !["open", "dismiss"].includes(text)) throw new Error("Invalid agent icon picker action");
    return { ...payload, text };
  },

  "webui-agent-settings-edit"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);
    if (!text || text.length > 8500 || !text.includes("=")) {
      throw new Error("agent-settings-edit requires key=value");
    }
    return { ...payload, text };
  },

  "webui-agent-emoji-submit": parseEnvelopeOnly,
  "webui-agent-emoji-retry": parseEnvelopeOnly,
  "webui-agent-emoji-clear": parseEnvelopeOnly,
  "webui-agent-emoji-dismiss": parseEnvelopeOnly,
  "webui-agent-settings-icon-clear": parseEnvelopeOnly,
  "webui-agent-settings-save": parseEnvelopeOnly,
  "webui-agent-settings-dismiss": parseEnvelopeOnly,
};

module.exports = { AGENT_ACTIONS };
