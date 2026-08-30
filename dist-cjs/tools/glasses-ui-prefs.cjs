const { createLiveuiLibrary, liveuiLibraryDigest, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");

const LIVEUI_PREFS_SCHEMA_VERSION = 1;
const LIVEUI_PREFS_FILENAME = "prefs-v1.json";

const LIVEUI_PREFS_CONTEXTS = Object.freeze(["isolated", "current_session"]);

const PREFS_KEYS = new Set([
  "schemaVersion",
  "enabled",
  "defaultContext",
  "defaultExecutor",
  "pauseApps",
  "digest",
]);

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validatePrefsRecord(record) {
  return !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    hasOnlyKeys(record, PREFS_KEYS) &&
    record.schemaVersion === LIVEUI_PREFS_SCHEMA_VERSION &&
    typeof record.enabled === "boolean" &&
    LIVEUI_PREFS_CONTEXTS.includes(record.defaultContext) &&
    (record.defaultExecutor === null || isExecutorId(record.defaultExecutor)) &&
    typeof record.pauseApps === "boolean" &&
    typeof record.digest === "string" &&
    !!record.digest;
}

function isExecutorId(value) {
  return typeof value === "string" && !!value.trim() && value.length <= 128;
}

function defaultLiveuiPrefsInput() {
  return {
    schemaVersion: LIVEUI_PREFS_SCHEMA_VERSION,
    enabled: true,
    defaultContext: "isolated",
    defaultExecutor: null,
    pauseApps: false,
  };
}

function rejected(code, message) {
  return { status: "rejected", code, message };
}

function normalizeLiveuiPrefsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return rejected("prefs_patch_invalid", "prefs patch must be an object");
  }
  const out = {};
  for (const key of Object.keys(patch)) {
    if (!["enabled", "defaultContext", "defaultExecutor", "pauseApps"].includes(key)) {
      return rejected("prefs_field_unknown", `unknown prefs field: ${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    if (typeof patch.enabled !== "boolean") {
      return rejected("prefs_value_invalid", "enabled must be a boolean");
    }
    out.enabled = patch.enabled;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "pauseApps")) {
    if (typeof patch.pauseApps !== "boolean") {
      return rejected("prefs_value_invalid", "pauseApps must be a boolean");
    }
    out.pauseApps = patch.pauseApps;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "defaultContext")) {
    if (!LIVEUI_PREFS_CONTEXTS.includes(patch.defaultContext)) {
      return rejected("prefs_value_invalid", "defaultContext must be isolated or current_session");
    }
    out.defaultContext = patch.defaultContext;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "defaultExecutor")) {
    if (patch.defaultExecutor === null) {
      out.defaultExecutor = null;
    } else if (isExecutorId(patch.defaultExecutor)) {
      out.defaultExecutor = patch.defaultExecutor.trim();
    } else {
      return rejected("prefs_value_invalid", "defaultExecutor must be an agent id or null");
    }
  }
  return { status: "accepted", patch: out };
}

function createLiveuiPrefs(opts = {}) {
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const library = createLiveuiLibrary({ libraryDir, ...(opts.fs ? { fs: opts.fs } : {}) });
  const documentOptions = {
    defaultDigestInput: defaultLiveuiPrefsInput(),
    validateDocument: validatePrefsRecord,
  };

  function load() {
    const loaded = library.loadDocument(LIVEUI_PREFS_FILENAME, documentOptions);
    if (loaded.status === "accepted") {
      return { status: "accepted", prefs: loaded.record };
    }

    const digestInput = defaultLiveuiPrefsInput();
    return {
      status: "accepted",
      prefs: { ...digestInput, digest: liveuiLibraryDigest(digestInput) },
      prefsInvalid: loaded.reason || "library_document_malformed",
    };
  }

  function save(patch) {
    const normalized = normalizeLiveuiPrefsPatch(patch);
    if (normalized.status !== "accepted") return normalized;
    const current = load();
    const digestInput = {
      schemaVersion: LIVEUI_PREFS_SCHEMA_VERSION,
      enabled: current.prefs.enabled,
      defaultContext: current.prefs.defaultContext,
      defaultExecutor: current.prefs.defaultExecutor,
      pauseApps: current.prefs.pauseApps,
      ...normalized.patch,
    };
    const saved = library.saveDocument(LIVEUI_PREFS_FILENAME, digestInput, {
      ...documentOptions,

      ...(current.prefsInvalid ? {} : { expectedDigest: current.prefs.digest }),
    });
    if (saved.status !== "saved") return saved;
    return { status: "saved", prefs: saved.record, previous: current.prefs };
  }

  return { libraryDir, load, save };
}

const LIVEUI_DISABLED_CODE = "liveui_disabled";

const LIVEUI_DISABLED_MESSAGE =
  "LiveUI is switched off by the owner in Settings -> LiveUI.";

function liveuiDisabledResult() {
  return {
    status: "rejected",
    code: LIVEUI_DISABLED_CODE,
    message: LIVEUI_DISABLED_MESSAGE,
  };
}

function liveuiDisabledError() {
  const err = new Error(`${LIVEUI_DISABLED_CODE}: ${LIVEUI_DISABLED_MESSAGE}`);
  err.code = LIVEUI_DISABLED_CODE;
  return err;
}

function isLiveuiSwitchedOff(handler) {
  try {
    return handler.liveuiPrefs().prefs.enabled === false;
  } catch (_) {
    return false;
  }
}

module.exports = { LIVEUI_PREFS_SCHEMA_VERSION, LIVEUI_PREFS_FILENAME, LIVEUI_PREFS_CONTEXTS, defaultLiveuiPrefsInput, normalizeLiveuiPrefsPatch, createLiveuiPrefs, LIVEUI_DISABLED_CODE, liveuiDisabledResult, liveuiDisabledError, isLiveuiSwitchedOff };
