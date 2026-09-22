const LINK_SETUP_HINT_METHOD = "setup.hint";
const SETUP_HINT_AWAITING_FIRST_REPLY = "awaiting-first-reply";

function normalizeSetupHintPhase(value) {
  return value === SETUP_HINT_AWAITING_FIRST_REPLY
    ? SETUP_HINT_AWAITING_FIRST_REPLY
    : null;
}

function createHermesSetupHint({ getRelay, logger } = {}) {
  let phase = null;

  function warn(err) {
    if (!logger || typeof logger.warn !== "function") return;
    logger.warn(
      `[hermes-setup-hint] publish failed: ${err && err.message ? err.message : err}`,
    );
  }

  function setPhase(value) {
    const next = normalizeSetupHintPhase(value);

    if (next === phase) return { phase };
    phase = next;

    try {
      const relay = typeof getRelay === "function" ? getRelay() : null;
      if (relay && typeof relay.refreshSetupHint === "function") {
        relay.refreshSetupHint();
      }
    } catch (err) {
      warn(err);
    }
    return { phase };
  }

  const methods = {};

  methods[LINK_SETUP_HINT_METHOD] = (params) =>
    setPhase(params && typeof params === "object" ? params.phase : null);

  return {
    methods,
    getPhase: () => phase,
    setPhase,
  };
}

module.exports = { createHermesSetupHint, normalizeSetupHintPhase, LINK_SETUP_HINT_METHOD, SETUP_HINT_AWAITING_FIRST_REPLY };
