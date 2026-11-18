const fs = require("node:fs");
const path = require("node:path");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { describeStateFileLoadError, quarantineStateFile, stripLeadingBom, versionQuarantineSuffix } = require("../runtime/state-file-quarantine.cjs");
const { normalizeAndValidateCustomSystemPrompt, normalizeCustomSystemPrompt } = require("../domain/custom-system-prompt-limit.cjs");

const DEFAULT_EVEN_AI_ROUTING_MODE = "active";
const SUPPORTED_EVEN_AI_ROUTING_MODES = Object.freeze([
  "active",
  "background",
  "background_new",
]);
const ACCEPTED_EVEN_AI_ROUTING_MODES = Object.freeze([
  ...SUPPORTED_EVEN_AI_ROUTING_MODES,
  "dedicated",
  "new",
  "dedicated_shadow",
  "new_shadow",
]);

const STORE_VERSION = 1;
const STORE_FILENAME = "even-ai-settings.json";
const MAX_TRACKED_THROWAWAY_KEYS = 20;

function normalizeTrimmedString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeEvenAiRoutingMode(value) {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (SUPPORTED_EVEN_AI_ROUTING_MODES.includes(normalized)) {
    return normalized;
  }
  if (normalized === "dedicated" || normalized === "dedicated_shadow") {
    return "background";
  }
  if (normalized === "new" || normalized === "new_shadow") {
    return "background_new";
  }
  return DEFAULT_EVEN_AI_ROUTING_MODE;
}

function normalizeEvenAiSystemPrompt(value) {
  return normalizeCustomSystemPrompt(value);
}

function normalizeEvenAiDefaultModel(value) {
  return normalizeTrimmedString(value);
}

function normalizeEvenAiDefaultThinking(value) {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  if ([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ].includes(normalized)) {
    return normalized;
  }
  return "";
}

function normalizeEvenAiListenEnabled(value) {
  return value === true;
}

function normalizeEvenAiDefaultAgent(value) {
  return normalizeTrimmedString(value);
}

function normalizeTrackedThrowawayKeys(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const rawKey of value) {
    const sessionKey = normalizeTrimmedString(rawKey);
    if (!sessionKey) continue;
    const dedupeKey = sessionKey.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(sessionKey);
    if (normalized.length >= MAX_TRACKED_THROWAWAY_KEYS) {
      break;
    }
  }
  return normalized;
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function isStoredSnapshotCanonical(value, snapshot) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (normalizeTrimmedString(value.routingMode) !== snapshot.routingMode) {
    return false;
  }
  if (normalizeTrimmedString(value.systemPrompt) !== snapshot.systemPrompt) {
    return false;
  }
  if (normalizeTrimmedString(value.defaultModel) !== snapshot.defaultModel) {
    return false;
  }
  if (normalizeEvenAiDefaultThinking(value.defaultThinking) !== snapshot.defaultThinking) {
    return false;
  }
  if (normalizeEvenAiListenEnabled(value.listenEnabled) !== snapshot.listenEnabled) {
    return false;
  }
  if (normalizeEvenAiDefaultFastMode(value.defaultFastMode) !== snapshot.defaultFastMode) {
    return false;
  }
  if (normalizeEvenAiDefaultAgent(value.defaultAgent) !== snapshot.defaultAgent) {
    return false;
  }
  if (!Array.isArray(value.trackedThrowawayKeys)) {
    return snapshot.trackedThrowawayKeys.length === 0;
  }
  return arraysEqual(value.trackedThrowawayKeys, snapshot.trackedThrowawayKeys);
}

function normalizeEvenAiDefaultFastMode(value) {
  return value === true;
}

function normalizeEvenAiSettingsSnapshot(value = {}) {
  return {
    routingMode: normalizeEvenAiRoutingMode(value.routingMode),
    systemPrompt: normalizeEvenAiSystemPrompt(value.systemPrompt),
    defaultModel: normalizeEvenAiDefaultModel(value.defaultModel),
    defaultThinking: normalizeEvenAiDefaultThinking(value.defaultThinking),
    listenEnabled: normalizeEvenAiListenEnabled(value.listenEnabled),
    defaultFastMode: normalizeEvenAiDefaultFastMode(value.defaultFastMode),
    defaultAgent: normalizeEvenAiDefaultAgent(value.defaultAgent),
    trackedThrowawayKeys: normalizeTrackedThrowawayKeys(value.trackedThrowawayKeys),
  };
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function createEvenAiSettingsStore(opts = {}) {
  const logger = normalizeLogger(opts.logger);
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const defaults = normalizeEvenAiSettingsSnapshot(opts.defaults || {});
  const statePath =
    typeof opts.statePath === "string" && opts.statePath.trim()
      ? opts.statePath.trim()
      : typeof opts.stateDir === "string" && opts.stateDir.trim()
        ? path.join(opts.stateDir.trim(), STORE_FILENAME)
        : null;

  function persistSnapshot(snapshot, reason) {
    if (!statePath) {
      emitDebug(
        "settings.loadsave",
        "even_ai_settings_persist_skipped",
        "debug",
        null,
        () => ({
          reason,
          routingMode: snapshot.routingMode,
          systemPromptChars: snapshot.systemPrompt.length,
          defaultModel: snapshot.defaultModel,
          defaultThinking: snapshot.defaultThinking,
          defaultFastMode: snapshot.defaultFastMode,
          listenEnabled: snapshot.listenEnabled,
          trackedThrowawayKeyCount: snapshot.trackedThrowawayKeys.length,
        }),
      );
      return;
    }

    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          {
            version: STORE_VERSION,
            updatedAtMs: now(),
            settings: snapshot,
          },
          null,
          2,
        ) + "\n",
      );
      emitDebug(
        "settings.loadsave",
        "even_ai_settings_persisted",
        "info",
        null,
        () => ({
          reason,
          statePath,
          routingMode: snapshot.routingMode,
          systemPromptChars: snapshot.systemPrompt.length,
          defaultModel: snapshot.defaultModel,
          defaultThinking: snapshot.defaultThinking,
          defaultFastMode: snapshot.defaultFastMode,
          listenEnabled: snapshot.listenEnabled,
          trackedThrowawayKeyCount: snapshot.trackedThrowawayKeys.length,
        }),
      );
    } catch (err) {
      logger.error(
        `[evenai] failed to persist Even AI settings: ${err && err.message ? err.message : err}`,
      );
      emitDebug(
        "settings.loadsave",
        "even_ai_settings_persist_failed",
        "warn",
        null,
        () => ({
          reason,
          statePath,
          message: err && err.message ? err.message : String(err),
        }),
      );
      throw err;
    }
  }

  function loadInitialSnapshot() {
    if (!statePath || !fs.existsSync(statePath)) {
      persistSnapshot(defaults, "seed_defaults");
      return { ...defaults };
    }

    let raw;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch (err) {

      const detail = describeStateFileLoadError(err);
      logger.error(
        `[evenai] could not read the Even AI settings file (${detail}); running on defaults without touching it`,
      );
      emitDebug(
        "settings.loadsave",
        "even_ai_settings_read_failed",
        "warn",
        null,
        () => ({ statePath, message: detail }),
      );
      return { ...defaults };
    }
    let parsed;
    let hadBom = false;
    try {
      const stripped = stripLeadingBom(raw);
      hadBom = stripped.hadBom;
      parsed = JSON.parse(stripped.text);
    } catch (err) {
      return setAsideUnusableFile("corrupt", "rewrite_after_load_failure", describeStateFileLoadError(err));
    }

    const isObject = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    if (isObject && parsed.version !== STORE_VERSION) {

      const suffix = versionQuarantineSuffix(parsed.version);
      return setAsideUnusableFile(
        suffix,
        "rewrite_after_version_mismatch",
        `store version ${suffix}, expected v${STORE_VERSION}`,
      );
    }
    const storedSettings =
      isObject && parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
        ? parsed.settings
        : null;
    if (!storedSettings) {
      return setAsideUnusableFile("corrupt", "rewrite_after_load_failure", "no settings object");
    }

    let loaded;
    try {
      loaded = normalizeEvenAiSettingsSnapshot(storedSettings);
    } catch (err) {
      return setAsideUnusableFile("corrupt", "rewrite_after_load_failure", describeStateFileLoadError(err));
    }
    emitDebug(
      "settings.loadsave",
      "even_ai_settings_loaded",
      "info",
      null,
      () => ({
        statePath,
        routingMode: loaded.routingMode,
        systemPromptChars: loaded.systemPrompt.length,
        defaultModel: loaded.defaultModel,
        defaultThinking: loaded.defaultThinking,
        defaultFastMode: loaded.defaultFastMode,
        listenEnabled: loaded.listenEnabled,
        trackedThrowawayKeyCount: loaded.trackedThrowawayKeys.length,
      }),
    );
    if (hadBom) {

      persistSnapshot(loaded, "strip_bom");
    } else if (!isStoredSnapshotCanonical(storedSettings, loaded)) {
      persistSnapshot(loaded, "normalize_loaded_settings");
    }
    return loaded;
  }

  function setAsideUnusableFile(suffix, reason, detail) {
    logger.warn(
      `[evenai] cannot use the Even AI settings file (${detail}); moving it aside and falling back to defaults`,
    );
    emitDebug(
      "settings.loadsave",
      "even_ai_settings_load_failed",
      "warn",
      null,
      () => ({ statePath, reason, message: detail }),
    );
    const result = quarantineStateFile(statePath, suffix, { now });
    if (result.originalGone) {
      emitDebug(
        "settings.loadsave",
        "even_ai_settings_quarantined",
        "warn",
        null,
        () => ({ statePath, quarantinePath: result.quarantinePath }),
      );
      persistSnapshot(defaults, reason);
    } else {
      logger.error(
        `[evenai] could not move the unusable Even AI settings file aside (${result.errorCode}); running on defaults without overwriting it`,
      );
      emitDebug(
        "settings.loadsave",
        "even_ai_settings_quarantine_failed",
        "warn",
        null,
        () => ({ statePath, reason, errorCode: result.errorCode }),
      );
    }
    return { ...defaults };
  }

  let snapshot = loadInitialSnapshot();

  function updateTrackedThrowawayKeys(nextKeys, reason) {
    snapshot = {
      ...snapshot,
      trackedThrowawayKeys: normalizeTrackedThrowawayKeys(nextKeys),
    };
    persistSnapshot(snapshot, reason);
    return { ...snapshot };
  }

  return {
    getStatePath() {
      return statePath;
    },

    getSnapshot() {
      return { ...snapshot };
    },

    getTrackedThrowawayKeys() {
      return [...snapshot.trackedThrowawayKeys];
    },

    recordTrackedThrowawayKey(sessionKey) {
      const normalizedKey = normalizeTrimmedString(sessionKey);
      if (!normalizedKey) {
        return { ...snapshot };
      }
      const dedupeKey = normalizedKey.toLowerCase();
      const nextKeys = [
        normalizedKey,
        ...snapshot.trackedThrowawayKeys.filter((key) => key.toLowerCase() !== dedupeKey),
      ];
      return updateTrackedThrowawayKeys(nextKeys, "record_throwaway_session");
    },

    async setSettings(patch = {}) {
      const nextSystemPrompt = hasOwn(patch, "systemPrompt")
        ? normalizeAndValidateCustomSystemPrompt(patch.systemPrompt)
        : snapshot.systemPrompt;
      const next = {
        routingMode: hasOwn(patch, "routingMode")
          ? normalizeEvenAiRoutingMode(patch.routingMode)
          : snapshot.routingMode,
        systemPrompt: nextSystemPrompt,
        defaultModel: hasOwn(patch, "defaultModel")
          ? normalizeEvenAiDefaultModel(patch.defaultModel)
          : snapshot.defaultModel,
        defaultThinking: hasOwn(patch, "defaultThinking")
          ? normalizeEvenAiDefaultThinking(patch.defaultThinking)
          : snapshot.defaultThinking,
        listenEnabled: hasOwn(patch, "listenEnabled")
          ? normalizeEvenAiListenEnabled(patch.listenEnabled)
          : snapshot.listenEnabled,
        defaultFastMode: hasOwn(patch, "defaultFastMode")
          ? normalizeEvenAiDefaultFastMode(patch.defaultFastMode)
          : snapshot.defaultFastMode,
        defaultAgent: hasOwn(patch, "defaultAgent")
          ? normalizeEvenAiDefaultAgent(patch.defaultAgent)
          : snapshot.defaultAgent,
        trackedThrowawayKeys: [...snapshot.trackedThrowawayKeys],
      };
      snapshot = next;
      persistSnapshot(snapshot, "set_settings");
      return {
        status: "accepted",
        settings: { ...snapshot },
      };
    },
  };
}

module.exports = { normalizeEvenAiRoutingMode, normalizeEvenAiSystemPrompt, normalizeEvenAiDefaultModel, normalizeEvenAiDefaultAgent, normalizeEvenAiSettingsSnapshot, createEvenAiSettingsStore };
