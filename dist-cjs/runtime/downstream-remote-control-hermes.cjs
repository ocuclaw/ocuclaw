const { parseOptionalTrimmedString, parseEnvelopeOnly } = require("./downstream-parse-optional.cjs");

function parseMachineIdentity(msg     , payload                      , action        ) {
  const identity = parseOptionalTrimmedString(msg.text);
  if (!identity || identity.length > 160) {
    throw new Error(`remote-control ${action} requires a bounded inventory id in text`);
  }
  return { ...payload, text: identity };
}

function parseNativeMemoryReview(msg     , payload                      ) {
  const text = parseOptionalTrimmedString(msg.text);
  if (!text || !/^(pending|receipt|approve|reject|review:[A-Za-z0-9_-]{1,128})$/.test(text)) {
    throw new Error("Invalid native memory phone action");
  }
  return { ...payload, text };
}

const HERMES_ACTIONS                           = {
  "webui-machine-browse": parseMachineIdentity,
  "webui-machine-profile": parseMachineIdentity,

  "webui-machine-settings"(msg, payload) {
    const operation = parseOptionalTrimmedString(msg.value);
    if (!["open", "select", "refresh", "favourite"].includes(operation)) {
      throw new Error("remote-control webui-machine-settings requires open|select|refresh|favourite");
    }
    const text = parseOptionalTrimmedString(msg.text);
    if ((operation === "select" && (!text || text.length > 160)) ||
        (operation === "favourite" && text !== "true" && text !== "false")) {
      throw new Error("remote-control webui-machine-settings requires a valid selection or preference");
    }
    return { ...payload, value: operation, ...(text ? { text } : {}) };
  },

  "webui-hermes-jobs"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);

    if (!text || !/^(refresh|history|toggle|run|confirm|dismiss|receipt|cancel|acknowledge|tasks|task-open|task-sync|task-run-now|task-pause|task-resume|task-delete|task-delete-confirm|task-delete-dismiss|task-review|task-approve|task-keep|task-page-edit|task-page-save|task-page-cancel|task-close|task-use-mark|task-card-open|task-card-test|task-card-build|task-card-save|task-card-fold|task-card-part|task-card-part-save|task-card-part-cancel|task-card-add|task-card-fix|task-card-undo|make-task)(:[A-Za-z0-9._-]{1,128})?$/.test(text)) throw new Error("Invalid Hermes jobs action");
    return { ...payload, text };
  },

  "webui-hermes-automations"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);
    if (!text || text.length > 16500 || !["refresh", "blank", "edit", "template", "field", "slot", "preview", "delete", "confirm", "dismiss", "close", "receipt", "cancel", "acknowledge",

      "start-from", "starter", "write-own", "close-start-from", "new-task",

      "task-when", "task-day", "task-time", "task-every", "task-popup", "task-look", "task-name", "task-prompt",
      "task-slot", "task-description", "task-setup", "task-goal", "task-save", "task-send", "task-menu", "task-temple", "task-close",

      "task-monitor", "task-page-url", "task-quiet",

      "task-word", "task-create", "task-done",

      "task-card-undo",

      "card-offer-yes"].includes(text.split(":", 1)[0])) throw new Error("Invalid Hermes automation action");
    return { ...payload, text };
  },

  "webui-hermes-health"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);
    if (!text || !/^(refresh|result|cancel|acknowledge|open-fix|period:(7|30|90)|start:(doctor|security))$/.test(text)) throw new Error("Invalid Hermes health action");
    return { ...payload, text };
  },

  "webui-hermes-approvals-edit"(msg, payload) {
    const text = parseOptionalTrimmedString(msg.text);

    if (!text || !(/^(mode|timeoutSeconds|cronMode|oneShotMode|unattendedMode|execMode|askFallback)=[^=]{0,12}$/.test(text) ||
        /^explainerModel=(inherit|[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\|[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,199})$/.test(text))) {
      throw new Error("Approval edit requires an allowed field=value");
    }
    return { ...payload, text };
  },

  "webui-hermes-permissions"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:(?:revoke|deny-edit|deny-remove):[0-9]{1,3}|deny-add|confirm|cancel|preview|refresh|recover|(?:pattern|command):[^\x00]{0,512})$/.test(text)) {
      throw new Error("Invalid Hermes permission action");
    }
    return { ...payload, text };
  },

  "webui-hermes-tools"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:block:(?:web|files|terminal)|skill:[^\x00-\x1f]{1,160}|profile:(?:default|minimal|coding|messaging|full)|confirm|cancel|refresh|recover)$/.test(text)) throw new Error("Invalid Hermes tool action");
    return { ...payload, text };
  },

  "webui-hermes-connections"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:(?:mcp-enabled|test|reauth|channel-enabled|pause|resume):[^\x00-\x1f]{1,160}|confirm|cancel|refresh|cancel-auth|review-unknown|authorize)$/.test(text)) throw new Error("Invalid Hermes connection action");
    return { ...payload, text };
  },

  "webui-hermes-handoffs"(msg, payload) {

    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:refresh|on|off|confirm|cancel|restore|agent:[a-z0-9][a-z0-9_-]{0,63}:(?:on|off))$/.test(text)) throw new Error("Invalid Hermes handoffs action");
    return { ...payload, text };
  },

  "webui-openclaw-maintenance"(msg, payload) {

    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:refresh|logs:(?:problems|all)|update|cleanup|archive|confirm|cancel)$/.test(text)) throw new Error("Invalid OpenClaw maintenance action");
    return { ...payload, text };
  },

  "webui-hermes-plugins"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:(?:toggle|reload|uninstall|approve|reject|remove):[^\x00-\x1f]{1,200}|confirm|cancel|refresh)$/.test(text)) throw new Error("Invalid OpenClaw plugins action");
    return { ...payload, text };
  },

  "webui-hermes-clawhub"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:open:(?:plugin|skill)|search:[^\x00-\x1f]{1,80}|pick:[A-Za-z0-9@._:/+=-]{1,200}|confirm|cancel|close)$/.test(text)) throw new Error("Invalid ClawHub action");
    return { ...payload, text };
  },

  "webui-hermes-disclosure"(msg, payload) {

    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^[a-z][a-z0-9-]{0,39}(?::(?:open|close|toggle))?$/.test(text)) throw new Error("Invalid Hermes disclosure action");
    return { ...payload, text };
  },

  "webui-hermes-needs-you"(msg, payload) {

    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^[a-z][a-z_-]{0,31}$/.test(text)) throw new Error("Invalid Hermes needs-you action");
    return { ...payload, text };
  },

  "webui-hermes-try-again": parseEnvelopeOnly,

  "webui-hermes-board"(msg, payload) {
    const editText = typeof msg.text === "string" ? msg.text : "";
    if (/^(?:acknowledge|card-action:edit|card-edit-(?:title|brief):[A-Za-z0-9 .,'!?-]{0,80}|card-edit-priority:-?(?:10|[0-9]))$/.test(editText)) return { ...payload, text: editText };

    const text = typeof msg.text === "string" ? msg.text : "";

    if (!/^(?:settings|open-board|default:[a-z0-9][a-z0-9_-]{0,63}|lane:[a-z][a-z_]{0,31}=(?:on|off)|initial:[a-z][a-z_]{0,31}|watch:(?:off|notify|notify_wake)|watch-(?:bell|cancel)|new-card|create-(?:save|check|retry|close|more|worker-menu|open|done|voice)|create-title:[A-Za-z0-9][A-Za-z0-9 .,'!?-]{0,79}|create-lane:(?:triage|ready)|create-watch:(?:off|notify)|create-priority:[0-2]|create-worker:(?:[a-z0-9][a-z0-9_-]{0,63})?|verdict:(?:approve|request_changes)|verdict-(?:send|cancel|check)|verdict-reason:[A-Za-z0-9][A-Za-z0-9 .,'!?-]{0,79}|moment|moment-dismiss|moments:(?:on|off)|done:(?:on|off)|quiet:(?:off|(?:[01][0-9]|2[0-3]):[0-5][0-9]-(?:[01][0-9]|2[0-3]):[0-5][0-9])|quiet-zone:phone|rule:(?:[a-z0-9][a-z0-9_-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9_.-]{0,63}:(?:off|notify|failures|notify_failures)|board:[a-z0-9][a-z0-9_-]{0,63}|filter:[a-z][a-z_]{0,31}|list-more|refresh|card:[A-Za-z0-9_.:-]{1,64}|home|stat:(?:needs_you|running|failed|total)|queue:[A-Za-z0-9_.:-]{1,64}|say-card|picker|comment|comment-(?:send|cancel|check)|comment-text:[A-Za-z0-9][A-Za-z0-9 .,'!?-]{0,79}|answer|tools-enable|tools-confirm|tools-cancel|reason-lab|more|card-action:(?:make_ready|reassign|set_model|retry|split|archive)|card-worker:(?:[a-z0-9][a-z0-9_-]{0,63})?|card-model:(?:[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63})?|card-(?:confirm|cancel|check)|create-parent:[A-Za-z0-9_.:-]{1,64}|create-split|create-split-check|maint|maint-(?:refresh|export|confirm|cancel|check)|maint-reclaim:[A-Za-z0-9_.:-]{1,64}|maint-attachments:(?:on|off)|maint-logs:(?:on|off)|artifact:[0-9]{1,15}|artifact-(?:save|close|source|scripts(?:-(?:run|cancel|stop))?))$/.test(text)) throw new Error("Invalid Hermes board action");
    return { ...payload, text };
  },

  "webui-hermes-learning"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:refresh|save|confirm|cancel|recover|section:(?:pending|saved|behaviour)|edit:(?:memoryApproval|skillApproval|reviewEnabled|reviewModel|notifications)=[A-Za-z0-9_./:+@|=-]{1,281})$/.test(text)) throw new Error("Invalid Hermes learning action");
    return { ...payload, text };
  },

  "webui-openclaw-heartbeat"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!/^(?:refresh|pause|resume|(?:every|activeHours|target):[A-Za-z0-9_:-]{1,16}|(?:lightContext|isolatedSession):(?:on|off))$/.test(text)) throw new Error("Invalid OpenClaw heartbeat action");
    return { ...payload, text };
  },

  "webui-hermes-approvals-confirm": parseEnvelopeOnly,
  "webui-hermes-approvals-cancel": parseEnvelopeOnly,
  "webui-hermes-approvals-save": parseEnvelopeOnly,
  "webui-hermes-approvals-refresh": parseEnvelopeOnly,
  "webui-hermes-approvals-recover": parseEnvelopeOnly,

  "webui-hermes-saved"(msg, payload) {
    const text = msg.text;
    if (typeof text !== "string" || text.length > 262150 || text.includes("\u0000") ||
        !(/^(show|list|receipt|preview|remove|save|recover|confirm|cancel)$/.test(text) ||
          /^open:[a-f0-9]{64}$/.test(text) || /^search:[^\u0000-\u001f]{1,200}$/.test(text) || text.startsWith("edit:"))) {
      throw new Error("Invalid saved learning phone action");
    }
    return { ...payload, text };
  },

  "webui-hermes-memory": parseNativeMemoryReview,
  "webui-hermes-skills": parseNativeMemoryReview,
};

module.exports = { HERMES_ACTIONS };
