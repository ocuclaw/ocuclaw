const { createLiveuiLibrary, liveuiLibraryDigest, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");

const LIVEUI_PREFS_SCHEMA_VERSION = 1;
const LIVEUI_PREFS_FILENAME = "prefs-v1.json";

const LIVEUI_PREFS_CONTEXTS = Object.freeze(["isolated", "current_session"]);

const LIVEUI_VIDEO_SIZES                    = Object.freeze([288, 240, 192, 144, 96]);

const LIVEUI_VIDEO_SIZE_DEFAULT = 288;

const PREFS_KEYS = new Set([
  "schemaVersion",
  "enabled",
  "defaultContext",
  "defaultExecutor",

  "pauseApps",

  "titleIcons",

  "videoSpeed",

  "videoSize",

  "videoSubtitles",
  "digest",
]);

const PREFS_SAVED_SHAPE             = Object.freeze({ fields: [...PREFS_KEYS] });

const PATCH_KEYS = ["enabled", "defaultContext", "defaultExecutor", "pauseApps", "titleIcons", "videoSpeed", "videoSize", "videoSubtitles"];

function hasOnlyKeys(value     , allowed     ) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validatePrefsRecord(record     ) {
  return !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    hasOnlyKeys(record, PREFS_KEYS) &&
    record.schemaVersion === LIVEUI_PREFS_SCHEMA_VERSION &&
    typeof record.enabled === "boolean" &&
    LIVEUI_PREFS_CONTEXTS.includes(record.defaultContext) &&
    (record.defaultExecutor === null || isExecutorId(record.defaultExecutor)) &&
    typeof record.pauseApps === "boolean" &&
    (record.titleIcons === undefined || typeof record.titleIcons === "boolean") &&
    (record.videoSpeed === undefined || typeof record.videoSpeed === "boolean") &&
    (record.videoSize === undefined || LIVEUI_VIDEO_SIZES.includes(record.videoSize)) &&
    (record.videoSubtitles === undefined || typeof record.videoSubtitles === "boolean") &&
    typeof record.digest === "string" &&
    !!record.digest;
}

function isExecutorId(value     ) {
  return typeof value === "string" && !!value.trim() && value.length <= 128;
}

function defaultLiveuiPrefsInput() {
  return {
    schemaVersion: LIVEUI_PREFS_SCHEMA_VERSION,
    enabled: true,
    defaultContext: "isolated",
    defaultExecutor: null,
    pauseApps: false,
    videoSubtitles: true,
  };
}

function rejected(code     , message     ) {
  return { status: "rejected", code, message };
}

function withTitleIcons(record     ) {
  return {
    ...record,
    titleIcons: record.titleIcons !== false,
    videoSpeed: record.videoSpeed !== false,
    videoSize: LIVEUI_VIDEO_SIZES.includes(record.videoSize) ? record.videoSize : LIVEUI_VIDEO_SIZE_DEFAULT,
    videoSubtitles: record.videoSubtitles === true,
  };
}

function normalizeLiveuiPrefsPatch(patch     ) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return rejected("prefs_patch_invalid", "prefs patch must be an object");
  }
  const out      = {};
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(key)) {
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
  if (Object.prototype.hasOwnProperty.call(patch, "titleIcons")) {
    if (typeof patch.titleIcons !== "boolean") {
      return rejected("prefs_value_invalid", "titleIcons must be a boolean");
    }
    out.titleIcons = patch.titleIcons;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "videoSpeed")) {
    if (typeof patch.videoSpeed !== "boolean") {
      return rejected("prefs_value_invalid", "videoSpeed must be a boolean");
    }
    out.videoSpeed = patch.videoSpeed;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "videoSize")) {
    if (!LIVEUI_VIDEO_SIZES.includes(patch.videoSize)) {
      return rejected("prefs_value_invalid", `videoSize must be one of ${LIVEUI_VIDEO_SIZES.join(", ")}`);
    }
    out.videoSize = patch.videoSize;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "videoSubtitles")) {
    if (typeof patch.videoSubtitles !== "boolean") {
      return rejected("prefs_value_invalid", "videoSubtitles must be a boolean");
    }
    out.videoSubtitles = patch.videoSubtitles;
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

function createLiveuiPrefs(opts      = {}) {
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const library = createLiveuiLibrary({ libraryDir, ...(opts.fs ? { fs: opts.fs } : {}) });
  const documentOptions = {
    defaultDigestInput: defaultLiveuiPrefsInput(),
    validateDocument: validatePrefsRecord,
    shape: PREFS_SAVED_SHAPE,
  };

  function load() {
    const loaded      = library.loadDocument(LIVEUI_PREFS_FILENAME, documentOptions);
    if (loaded.status === "accepted") {
      return { status: "accepted", prefs: withTitleIcons(loaded.record) };
    }

    const digestInput = defaultLiveuiPrefsInput();
    return {
      status: "accepted",
      prefs: withTitleIcons({ ...digestInput, digest: liveuiLibraryDigest(digestInput) }),
      prefsInvalid: loaded.reason || "library_document_malformed",
    };
  }

  function save(patch     ) {
    const normalized      = normalizeLiveuiPrefsPatch(patch);
    if (normalized.status !== "accepted") return normalized;
    const current      = load();
    const { titleIcons, videoSpeed, videoSize, videoSubtitles, ...next } = {
      enabled: current.prefs.enabled,
      defaultContext: current.prefs.defaultContext,
      defaultExecutor: current.prefs.defaultExecutor,
      pauseApps: current.prefs.pauseApps,
      titleIcons: current.prefs.titleIcons,
      videoSpeed: current.prefs.videoSpeed,
      videoSize: current.prefs.videoSize,
      videoSubtitles: current.prefs.videoSubtitles,
      ...normalized.patch,
    };
    const digestInput = {
      schemaVersion: LIVEUI_PREFS_SCHEMA_VERSION,
      ...next,
      ...(titleIcons === false ? { titleIcons: false } : {}),
      ...(videoSpeed === false ? { videoSpeed: false } : {}),
      ...(videoSize !== LIVEUI_VIDEO_SIZE_DEFAULT ? { videoSize } : {}),
      videoSubtitles,
    };
    const saved      = library.saveDocument(LIVEUI_PREFS_FILENAME, digestInput, {
      ...documentOptions,

      ...(current.prefsInvalid ? {} : { expectedDigest: current.prefs.digest }),
    });
    if (saved.status !== "saved") return saved;
    return { status: "saved", prefs: withTitleIcons(saved.record), previous: current.prefs };
  }

  return { libraryDir, load, save };
}

const LIVEUI_DISABLED_CODE = "liveui_disabled";

const LIVEUI_DISABLED_MESSAGE =
  "LiveUI is switched off by the owner in the phone's LiveUI panel (top bar).";

function liveuiDisabledResult() {
  return {
    status: "rejected",
    code: LIVEUI_DISABLED_CODE,
    message: LIVEUI_DISABLED_MESSAGE,
  };
}

function liveuiDisabledError() {
  const err      = new Error(`${LIVEUI_DISABLED_CODE}: ${LIVEUI_DISABLED_MESSAGE}`);
  err.code = LIVEUI_DISABLED_CODE;
  return err;
}

function isLiveuiSwitchedOff(handler     ) {
  try {
    return handler.liveuiPrefs().prefs.enabled === false;
  } catch (_) {
    return false;
  }
}

module.exports = { LIVEUI_PREFS_SCHEMA_VERSION, LIVEUI_PREFS_FILENAME, LIVEUI_PREFS_CONTEXTS, LIVEUI_VIDEO_SIZES, LIVEUI_VIDEO_SIZE_DEFAULT, PREFS_SAVED_SHAPE, defaultLiveuiPrefsInput, normalizeLiveuiPrefsPatch, createLiveuiPrefs, LIVEUI_DISABLED_CODE, liveuiDisabledResult, liveuiDisabledError, isLiveuiSwitchedOff };
