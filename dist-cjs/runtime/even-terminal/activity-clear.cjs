function buildEtSessionSwitchClearActivity(sessionKey) {
  return {
    state: "idle",
    sessionKey,
    tool: null,
    phase: "complete",
    origin: "et_switch_clear",
    category: "et_switch_clear",
  };
}

module.exports = { buildEtSessionSwitchClearActivity };
