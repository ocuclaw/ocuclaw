const { parseOptionalTrimmedString, parseEnvelopeOnly } = require("./downstream-parse-optional.cjs");

const STARTUP_SPLASH_MODES = ["first-time", "returning", "first-time-setup", "phone-code", "phone-code-end", "pairing"];

function parseDebugUpload(msg     , payload                      , action        ) {
  if (action === "webui-debug-upload-open" && msg.text) {
    if (typeof msg.text !== "string" || !/^\d{1,5}$/.test(msg.text) || Number(msg.text) < 1 || Number(msg.text) > 30000) throw new Error("invalid debug upload delay");
    return { ...payload, text: msg.text };
  }
  return payload;
}

function parseDebugUploadText(msg     , payload                      ) {
  payload.text = typeof msg.text === "string" ? msg.text : "";
  return payload;
}

const SYSTEM_ACTIONS                           = {

  "webui-connection-toggle": parseEnvelopeOnly,

  "webui-connection-control"(msg, payload) {
    const value = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    if (!["manual-open", "manual-close", "connect", "reconnect", "disconnect", "pair", "setup", "discord"].includes(value || "")) {
      throw new Error("remote-control webui-connection-control requires a supported connection action");
    }
    return { ...payload, value };
  },

  "webui-context-compact"(msg, payload) {
    const value = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    if (!["arm", "confirm", "cancel"].includes(value || "")) {
      throw new Error("remote-control webui-context-compact requires arm, confirm or cancel");
    }
    return { ...payload, value };
  },

  "webui-document-visibility"(msg, payload) {
    const state = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    if (state !== "hidden" && state !== "visible") {
      throw new Error(
        "remote-control webui-document-visibility requires value hidden|visible",
      );
    }
    return { ...payload, value: state };
  },

  "webui-graphic-fault"(msg, payload) {
    const code = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    if (
      code !== "atlas_invalid" &&
      code !== "atlas_face_missing" &&
      code !== "raster_failed" &&
      code !== "slot_overflow" &&
      code !== "off"
    ) {
      throw new Error(
        "remote-control webui-graphic-fault requires value atlas_invalid|atlas_face_missing|raster_failed|slot_overflow|off",
      );
    }
    return { ...payload, value: code };
  },

  "webui-location-fake"(msg, payload) {
    const value = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    const parts = value && value !== "off" ? value.split(",").map((part) => part.trim()) : [];
    const [lat, lon] = parts.map(Number);
    if (value !== "off" && !(parts.length === 2 && parts.every((part) => part !== "") &&
        Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
      throw new Error("remote-control webui-location-fake requires value <lat>,<lon>|off");
    }
    return { ...payload, value: value === "off" ? "off" : `${lat},${lon}` };
  },

  "webui-startup-splash"(msg, payload) {
    const mode = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    if (!mode || !STARTUP_SPLASH_MODES.includes(mode)) {
      throw new Error(`remote-control webui-startup-splash requires value ${STARTUP_SPLASH_MODES.join("|")}`);
    }
    return { ...payload, value: mode };
  },

  "webui-program-card-fixture"(msg, payload) {
    const text = typeof msg.text === "string" ? msg.text : "";
    let parsed      = null;
    try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
    const fail = () => new Error("remote-control webui-program-card-fixture requires text {title, source, commands?}, {snapshot:true}, {perf:log|g2|off} or {actions:true|false} as JSON");
    if (!text || text.length > 40000 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail();
    const perf = Object.hasOwn(parsed, "perf");
    if (perf && !["log", "g2", "off"].includes(parsed.perf)) throw fail();
    if (Object.hasOwn(parsed, "snapshot") && typeof parsed.snapshot !== "boolean") throw fail();

    const actions = Object.hasOwn(parsed, "actions");
    if (actions && typeof parsed.actions !== "boolean") throw fail();
    const card = typeof parsed.title === "string" && parsed.title.trim().length > 0 &&
      typeof parsed.source === "string" && parsed.source.trim().length > 0;
    const diagnostic = (parsed.snapshot === true || perf || actions) &&
      Object.keys(parsed).every((key) => ["snapshot", "perf", "actions", "title", "source"].includes(key)) &&
      (parsed.title === undefined || typeof parsed.title === "string") &&
      (parsed.source === undefined || (typeof parsed.source === "string" && !parsed.source.trim()));
    if (!card && !diagnostic) {
      throw fail();
    }
    return { ...payload, text };
  },

  "webui-graphic-image-transport"(msg, payload) {
    const mode = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    if (mode !== "png" && mode !== "raw-lz4") {
      throw new Error("remote-control webui-graphic-image-transport requires value png|raw-lz4");
    }
    return { ...payload, value: mode };
  },

  "webui-system-appearance"(msg, payload) {
    const value = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    if (value !== "dark" && value !== "light" && value !== "reset") {
      throw new Error(
        "remote-control webui-system-appearance requires value dark|light|reset",
      );
    }
    return { ...payload, value };
  },

  "webui-device-languages"(msg, payload) {
    const raw = parseOptionalTrimmedString(msg.value);
    if (raw?.toLowerCase() === "reset") return { ...payload, value: "reset" };
    const tags = (raw ?? "").split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    if (
      tags.length === 0 ||
      tags.length > 8 ||
      !tags.every((tag) => /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(tag))
    ) {
      throw new Error(
        "remote-control webui-device-languages requires value reset or comma-separated language tags",
      );
    }
    return { ...payload, value: tags.join(",") };
  },

  "webui-overlay"(msg, payload) {
    const target = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const patterns = new Map([
      ["channel-update", /^(stable|beta|hermes)(:prompt)?$/],
      ["whats-new", /^$/],
      ["setting-help", /^[A-Z][A-Z0-9_]{1,80}$/],
      ["language-hints", /^(open|dismiss)?$/],
      ["voice-fine-tune", /^(open|dismiss)?$/],
      ["read-aloud", /^(off|voice|always|hey-even-on|hey-even-off|mute|unmute|stop|sample|keep-reading|phone|agent)$/],
      ["voice-setup", /^(open|dismiss|select-soniox)$/],
      ["voice-test", /^start$/],
      ["voice-test-hint", /^dismiss$/],
      ["top-bar-hint", /^dismiss$/],
      ["top-bar-more", /^(toggle|open|close|dismiss|Connection|Agent: [^\x00-\x1f]{1,80}|Help & guides|What's new|Submit feedback|Report a bug)$/],
      ["optional-home", /^(voice|even-ai|jev|dismiss)$/],
      ["optional-try", /^(arm|open|cancel|skip|close|send|retry)$/],

      ["bot-screen-jev-mode", /^open$/],
      ["glasses-basics", /^(tour|skip|done)$/],
      ["try-voice", /^(skip|again|done)$/],
      ["voice-activation-home", /^(activate|cancel|later|dismiss|status|fixture:(due|confirm|progress|reconnecting|ready|clear))$/],
      ["voice-helper", /^(open|fixture:(empty|saved|loaded|clear))$/],
      ["display-debug", /^(expand|collapse|diagnostics)$/],
      ["debug-upload", /^(open-diagnostics|turn-on)$/],
      ["program-cards", /^(open|access|access-close|(enabled|auto-listen|speck-mime|card-words|test-player|location|sites):(on|off)|art:[A-Za-z0-9][A-Za-z0-9._\/:-]{0,119}|detail:(low|medium|high)|(server|auto-send):[A-Za-z0-9_-]{1,64}:(on|off)|risk:[A-Za-z0-9_-]{1,64}:(normal|high)|host-(add|not-now):[A-Za-z0-9]{1,40}|host-remove:[a-z][a-z0-9_]{0,39})$/],
      ["program-card-capabilities", /^(jev|mcp|model):(on|off)$/],
      ["program-card-model", /^(?:(?:allow|deny|remove|forget):(?:app|run):[A-Za-z0-9._:#-]{1,96}|(?:settings|check):\{[^\x00-\x1f]{1,4000}\}|reset:(?:app|run):[A-Za-z0-9._:#-]{1,96}\/[a-z][A-Za-z0-9_]{0,23}\/[a-z][A-Za-z0-9_-]{0,23})$/],
      ["liveui-card-feed", /^open$/],
      ["liveui-task-revision", /^open$/],
      ["task-revision-review", /^(preview|use|back|ready|saved)$/],
      ["liveui-card-feed-edit", /^(card:(none|[a-z][a-z0-9_-]{0,31})|names:[^\x00-\x1f]{0,240}|save|dismiss)$/],
      ["liveui-review", /^(approve|reject)$/],
      ["saved-card-code", /^open$/],
      ["saved-card-start-over", /^(start|confirm|undo|dismiss)$/],
      ["saved-card-location", /^(location|site:[a-z0-9.-]{1,253}):(on|off)$/],
      ["saved-card-uses", /^((keep-off|allow):[0-9]|(read|send):[A-Za-z0-9_-]{1,40}:(on|off)|task:[^\x00-\x1f]{1,120}|agent-refresh:(on|off)|ask-agent)$/],

      ["saved-card-runs", /^task:[^\x00-\x1f]{1,120}$/],
      ["task-runs-week", /^(open|close)$/],

      ["task-usage", /^(open|close)$/],
      ["saved-card-usage", /^task:[^\x00-\x1f]{1,120}$/],
      ["program-card-studio", /^((preview-)?pad:(up|down|tap|back|double|hold|release)(@(left|right|ring))?|select:[a-z0-9:-]{1,240}|replace:[A-Za-z0-9 +]{1,40}=[A-Za-z0-9 +]{0,40}|page:(sources|code|preview|test)|preview|save|discard|cancel|confirm-discard|back|send|run|dump|close)$/],
      ["program-card-drafts", /^(expand|collapse|(code|delete):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/],
      ["things-to-try", /^(starter-[0-5]|dismiss)$/],
      ["things-to-try-fixture", /^offer$/],
      ["hermes-menu-default-fixture", /^arm$/],
      ["liveui-model-phone-fixture", /^-?\d{1,3}(\.\d{1,3})?,-?\d{1,3}(\.\d{1,3})?$/],
      ["help-guide", /^(starter-[0-5]|setup|setup-voice|setup-even-ai|setup-typesafe|walkthrough)$/],

      ["settings-root", /^(display|voice|evenai|hermes|openclaw|liveui|session|defaults)$/],
      ["settings-back", /^$/],
      ["settings-title-menu", /^(toggle|display|voice|evenai|hermes|openclaw|liveui|session|defaults|hub|agents|approvals|tools|handoffs|jobs|learning|health|models|heartbeat|maintenance|plugins|waiting|bot_screen|machines)?$/],

      ["even-ai-copy-agent-url", /^$/],

      ["settings-expander", /^[a-z0-9-]{1,40}(:(open|close|toggle))?$/],
      ["even-ai-turn-off", /^$/],
      ["even-ai-turn-off-restart", /^$/],

      ["jev-setup", /^(open|turn-on|not-now|check-again|change-key|keep-key|done|close|dismiss)$/],
      ["manual-even-ai", /^(open|dismiss|unlock-agent-configuration|store-private-secret|enable-runtime|verify-private-route|configure-even-realities-app|exercise-glasses-request)?$/],
      ["agent-filter", /^(open|dismiss)?$/],
      ["liveui", /^((review|task|history|edit|delete|card):[^\x00-\x1f]{1,200}|card-page:(home|revisions|review|jev|mcp|advanced|model|uses|runs|tasks|usage|change|frame)|card-open|side:(cards|tasks)|new-card|new-card-idea:[a-z]{1,20}|new-card-build|new-card-describe|new-card-mic|models|pause-info|dismiss)$/],

      ["saved-card-tasks", /^(part:task(_[a-z][a-z0-9_]{0,18})?|open|remove|confirm|(update|gone):task(_[a-z][a-z0-9_]{0,18})?|review|dismiss)$/],

      ["build-sheet", /^(open|fold|state|probe|review-it|save|change-again|change-keep|change-discard|frame-redraw(:(low|medium|high))?|frame-remove|frame-before|look-at-fix|look-at-keep|reply:[^\x00-\x1f]{1,300})$/],
      ["card-review", /^(start|stop|again|try|dismiss|accept|deny|look|probe|look-picture:[0-5]|(info|undo|save-anyway|not-now|retry|retry-stop|change):i[1-5]|focus:[^\x00-\x1f]{1,160})$/],

      ["card-change", /^(words:[^\x00-\x1f]{1,600}|send)$/],
      ["saved-card-frame", /^(style:(same|calmer|busier|retro|own)|own:[^\x00-\x1f]{1,200}|detail:(low|medium|high)|draw|before|remove|confirm|dismiss)$/],

      ["card-panel", /^(asks|step:[0-5]|dismiss|look)$/],
      ["card-revisions", /^(revision:\d{1,4}|current|fork|delete|confirm|save|dismiss|rename(:[^\x00-\x1f]{1,60})?)$/],
      ["liveui-models", /^(viewer|sites)$/],
      ["liveui-model-sites", /^(sketchfab|thingiverse|myminifactory)$/],
      ["settings-prompt", /^(open|dismiss)$/],

      ["auto-description", /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}|dismiss)$/],
      ["auto-description-edit", /^(text:[^\x00-\x1f]{0,280}|save)$/],
      ["auto-agent", /^(on|off)$/],
      ["auto-change", /^(open|dismiss|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/],
      ["settings-tools-view", /^(profile-open|profile-dismiss|help-open|help-dismiss|skill:[^\x00-\x1f]{1,160}|skill-dismiss)$/],
      ["settings-models-view", /^(key-open|secret-add|secret-(actions|replace):[A-Z][A-Z0-9_]{0,127}|dismiss)$/],
      ["settings-learning-saved-view", /^(editor-open|editor-dismiss|entry-dismiss)$/],
      ["settings-learning-versions", /^(before|after)$/],
      ["settings-maintenance-log-view", /^(expand|collapse):(0|[1-9][0-9]{0,2})$/],
      ["agent-settings-view", /^(skills-open|skills-dismiss)$/],

      ["settings-host-defaults", /^(open|backups|back|dismiss|(model|fallbacks|thinking|fastMode|reasoning|toolDetail)=[A-Za-z0-9._/:,-]{0,400})$/],

      ["settings-openclaw-models", /^(reload|(model|fallbacks|utility|image|pdf|voice|decision)=[A-Za-z0-9._/:,+@-]{0,400}|first:[A-Za-z0-9._:+-]{1,80}=[A-Za-z0-9._:+@-]{1,160}|confirm|cancel|refresh|key:[A-Za-z0-9._:+-]{1,80}=fixture|secret:[A-Z][A-Z0-9_]{0,127}=fixture|remove:[A-Z][A-Z0-9_]{0,127})$/],
      ["dismiss", /^$/],
    ]);
    const pattern = target ? patterns.get(target) : undefined;
    if (!pattern || !pattern.test(text)) {
      throw new Error("remote-control webui-overlay requires a supported target and argument");
    }
    return { ...payload, value: target, ...(text ? { text } : {}) };
  },

  "webui-optional-setup"(msg, payload) {
    const value = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    if (!/^(open|close|status|dismiss-home|refresh|next|back|test-voice|test-even-ai|open-even-ai-test|press-even-ai-test|cancel-even-ai-test|activation-(review|cancel|confirm)|route-(review|cancel)|save-(even_ai|jev|voice)|even-ai-(try|done|retry)|try-status|(try|skip|resume)-(saved_prompt|morning_brief|typesafe_key)|skip-(voice|even_ai)|resume-(voice|even_ai)|diagnostics-(open|back|cancel|review|access-(allow|deny)|handoff-(allow|deny))|voice-engine-(ondevice|soniox|hermes)|hermes-provider-[a-z0-9][a-z0-9_.-]{0,63})$/.test(value || "")) {
      throw new Error("remote-control webui-optional-setup requires a supported visible action");
    }

    if (value === "save-even_ai" || value === "save-jev" || value === "save-voice") {
      const text = typeof msg.text === "string" ? msg.text : "";
      if (!text.trim()) throw new Error(`remote-control webui-optional-setup ${value} requires text`);
      return { ...payload, value, text };
    }
    return { ...payload, value };
  },

  "webui-relay-offline"(msg, payload) {
    const value = parseOptionalTrimmedString(msg.value)?.toLowerCase();
    const ms = value && /^\d{4,6}$/.test(value) ? Number(value) : NaN;
    if (value !== "restore" && !(ms >= 1000 && ms <= 120000)) {
      throw new Error("remote-control webui-relay-offline requires value 1000..120000 or restore");
    }
    return { ...payload, value };
  },

  "webui-debug-upload-open": parseDebugUpload,
  "webui-debug-upload-export": parseDebugUpload,
  "webui-debug-upload-send": parseDebugUpload,
  "webui-debug-upload-dismiss": parseDebugUpload,

  "webui-debug-upload-set-note": parseDebugUploadText,
  "webui-debug-upload-set-contact": parseDebugUploadText,

  "webui-feedback"(msg, payload) {
    const op = parseOptionalTrimmedString(msg.value)?.toLowerCase() || "";
    const text = typeof msg.text === "string" ? msg.text : "";
    const pattern = FEEDBACK_ARG_PATTERNS[op];
    if (!pattern || !pattern.test(text)) {
      throw new Error("remote-control webui-feedback requires a supported step and argument");
    }
    return { ...payload, value: op, ...(text ? { text } : {}) };
  },
};

const FEEDBACK_ARG_PATTERNS                         = {
  open: /^$/,
  dismiss: /^$/,
  inbox: /^$/,
  thread: /^FB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
  back: /^$/,
  topic: /^(idea|confusing|love-it|translation-error|other)$/,
  text: /^[\s\S]{0,4000}$/,
  contact: /^[^\x00-\x1f]{0,200}$/,
  send: /^$/,
  "reply-text": /^[\s\S]{0,4000}$/,
  "reply-send": /^$/,
  "report-bug": /^$/,
  "from-bug": /^$/,
  refresh: /^$/,
  dictate: /^$/,
  endpoint: /^(default|https?:\/\/[^\s]{1,190})$/,
};

module.exports = { SYSTEM_ACTIONS };
