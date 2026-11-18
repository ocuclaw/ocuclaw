const { planOptionalSetupActivation } = require("./optional-activation-policy.cjs");

const CONVERSATION_ACCESS_CONFIG_PATH = "plugins.entries.ocuclaw.hooks.allowConversationAccess";

const CONVERSATION_ACCESS_STATE = Object.freeze({
  GRANTED: "granted",
  MISSING: "missing",
  DENIED: "denied",
});

const CONVERSATION_ACCESS_GRANT_STATUS = Object.freeze({
  GRANTED: "granted",
  ALREADY_GRANTED: "already-granted",
  SKIPPED: "skipped",
  FAILED: "failed",
});

function isRecord(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function conversationAccessState(config     ) {
  const entry = isRecord(config) && isRecord(config.plugins) && isRecord(config.plugins.entries)
    ? config.plugins.entries.ocuclaw
    : null;
  const hooks = isRecord(entry) && isRecord(entry.hooks) ? entry.hooks : null;
  if (hooks && hooks.allowConversationAccess === true) return CONVERSATION_ACCESS_STATE.GRANTED;
  if (hooks && hooks.allowConversationAccess === false) return CONVERSATION_ACCESS_STATE.DENIED;
  return CONVERSATION_ACCESS_STATE.MISSING;
}

function conversationAccessGranted(config     ) {
  return conversationAccessState(config) === CONVERSATION_ACCESS_STATE.GRANTED;
}

function applyConversationAccessGrant(draft     , options      = {}) {
  const state = conversationAccessState(draft);
  if (state === CONVERSATION_ACCESS_STATE.GRANTED) return false;
  if (state === CONVERSATION_ACCESS_STATE.DENIED && options.keepDenied === true) return false;
  if (!isRecord(draft.plugins)) draft.plugins = {};
  if (!isRecord(draft.plugins.entries)) draft.plugins.entries = {};
  if (!isRecord(draft.plugins.entries.ocuclaw)) draft.plugins.entries.ocuclaw = {};
  if (!isRecord(draft.plugins.entries.ocuclaw.hooks)) draft.plugins.entries.ocuclaw.hooks = {};
  draft.plugins.entries.ocuclaw.hooks.allowConversationAccess = true;
  return true;
}

function conversationAccessGrantSupported(api     ) {
  const runtimeConfig = api?.runtime?.config;
  return !!runtimeConfig &&
    typeof runtimeConfig.current === "function" &&
    typeof runtimeConfig.mutateConfigFile === "function";
}

function conversationAccessOwedAtLoad(api     , bootConfig     ) {
  return conversationAccessGrantSupported(api) &&
    conversationAccessState(bootConfig) === CONVERSATION_ACCESS_STATE.MISSING;
}

const NOTHING_TO_WRITE = Object.freeze({ code: "nothing_to_write" });

function outcome(status     , fields      = {}) {
  return { status, code: null, detail: null, afterWrite: null, ...fields };
}

function createConversationAccessGrantOnLoad(api     ) {
  return async function grantConversationAccessAtLoad() {
    if (!conversationAccessGrantSupported(api)) {
      return outcome(CONVERSATION_ACCESS_GRANT_STATUS.SKIPPED, {
        code: "unsupported_host",
        detail: "this OpenClaw host does not expose the config mutation contract",
      });
    }
    let live     ;
    try {
      live = api.runtime.config.current();
    } catch (_) {
      return outcome(CONVERSATION_ACCESS_GRANT_STATUS.SKIPPED, {
        code: "config_unreadable",
        detail: "OpenClaw could not read its current configuration; nothing was written",
      });
    }
    const state = conversationAccessState(live);
    if (state === CONVERSATION_ACCESS_STATE.GRANTED) {
      return outcome(CONVERSATION_ACCESS_GRANT_STATUS.ALREADY_GRANTED, { code: "granted-since-boot" });
    }
    if (state === CONVERSATION_ACCESS_STATE.DENIED) {
      return outcome(CONVERSATION_ACCESS_GRANT_STATUS.SKIPPED, {
        code: "denied_by_operator",
        detail: `${CONVERSATION_ACCESS_CONFIG_PATH} is false; OcuClaw leaves an explicit refusal as it is`,
      });
    }
    const plan = planOptionalSetupActivation(live, api?.runtime?.version);
    const afterWrite = plan.afterWrite.mode === "auto"
      ? { mode: "auto" }
      : { mode: "none", reason: "OcuClaw conversation access granted at plugin load; applies at the next gateway start" };
    let changed = false;
    let draftState      = null;
    try {
      await api.runtime.config.mutateConfigFile({
        afterWrite,
        mutate(draft     ) {

          draftState = conversationAccessState(draft);
          changed = applyConversationAccessGrant(draft, { keepDenied: true });
          if (!changed) throw NOTHING_TO_WRITE;
          return { granted: true };
        },
      });
    } catch (err     ) {

      if (err === NOTHING_TO_WRITE || (draftState !== null && !changed)) changed = false;
      else return outcome(CONVERSATION_ACCESS_GRANT_STATUS.FAILED, {
        code: typeof err?.code === "string" ? err.code : "write_failed",
        detail: typeof err?.message === "string" ? err.message : String(err),
      });
    }
    if (!changed && draftState === CONVERSATION_ACCESS_STATE.DENIED) {
      return outcome(CONVERSATION_ACCESS_GRANT_STATUS.SKIPPED, {
        code: "denied_by_operator",
        detail: `${CONVERSATION_ACCESS_CONFIG_PATH} is false; OcuClaw leaves an explicit refusal as it is`,
      });
    }
    if (!changed) {
      return outcome(CONVERSATION_ACCESS_GRANT_STATUS.ALREADY_GRANTED, { code: "set-since-live-read" });
    }
    return outcome(CONVERSATION_ACCESS_GRANT_STATUS.GRANTED, {
      code: afterWrite.mode === "auto" ? "granted-hot-reload" : "granted-next-start",
      afterWrite: afterWrite.mode,
    });
  };
}

module.exports = { CONVERSATION_ACCESS_CONFIG_PATH, CONVERSATION_ACCESS_STATE, CONVERSATION_ACCESS_GRANT_STATUS, conversationAccessState, conversationAccessGranted, applyConversationAccessGrant, conversationAccessGrantSupported, conversationAccessOwedAtLoad, createConversationAccessGrantOnLoad };
