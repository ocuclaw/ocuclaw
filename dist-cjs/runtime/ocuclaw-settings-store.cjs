const fs = require("node:fs");
const path = require("node:path");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { describeStateFileLoadError, quarantineStateFile, stripLeadingBom, versionQuarantineSuffix } = require("./state-file-quarantine.cjs");
const { normalizeAndValidateCustomSystemPrompt, normalizeCustomSystemPrompt } = require("../domain/custom-system-prompt-limit.cjs");
const { activityLabChoicesEqual, normalizeActivityLabChoices } = require("../domain/activity-labs.cjs");

const STORE_VERSION = 1;
const STORE_FILENAME = "ocuclaw-settings.json";
const PERSIST_DEBOUNCE_MS = 250;
const PATHWAY_KEYS = Object.freeze(["heyEven", "app"]);
const BACKEND_KEYS = Object.freeze(["openclaw", "hermes"]);

function normalizeTrimmedString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeOcuClawSystemPrompt(value) {
  return normalizeCustomSystemPrompt(value);
}

function normalizeOcuClawDefaultModel(value) {
  return normalizeTrimmedString(value);
}

function normalizeOcuClawDefaultThinking(value) {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (
    normalized === "" ||
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max" ||
    normalized === "ultra"
  ) {
    return normalized;
  }
  return "";
}

const OCUCLAW_AGENT_PROGRESS_NOTES_MODES = Object.freeze([
  "off",
  "status",
  "conversation",
]);
const OCUCLAW_AGENT_PROGRESS_NOTES_DEFAULT = "conversation";

const OCUCLAW_AGENT_PROGRESS_NOTES_NEW_INSTALL = "conversation";

function normalizeOcuClawAgentProgressNotes(value) {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (normalized === "status") return "conversation";
  return OCUCLAW_AGENT_PROGRESS_NOTES_MODES.includes(normalized)
    ? normalized
    : OCUCLAW_AGENT_PROGRESS_NOTES_DEFAULT;
}

function normalizeOcuClawDefaultFastMode(value) {
  return value === true;
}

function normalizeOcuClawConversationToolProgress(value     ) {
  return value === true;
}

function normalizeOcuClawExplainApprovals(value     ) {
  return value !== false;
}

function normalizeOcuClawCardBuildFastMode(value     ) {
  return value !== false;
}

function normalizeOcuClawOpenClawTaskSchedules(value     ) {
  return value !== false;
}

const OCUCLAW_WAITING_SURFACE_RE = /^[a-z0-9_-]{1,32}$/;
const OCUCLAW_WAITING_SURFACES_MAX = 32;

const WAITING_NON_PLATFORM_SURFACES = new Set(["desktop", "tui", "cli", "local", "ocuclaw"]);

function normalizeOcuClawWaitingSurfaces(value     ) {
  const out      = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const keys = Object.keys(value)
    .filter((key) => OCUCLAW_WAITING_SURFACE_RE.test(key) && typeof value[key] === "boolean")
    .sort()
    .slice(0, OCUCLAW_WAITING_SURFACES_MAX);
  for (const key of keys) out[key] = value[key];
  return out;
}

function normalizeOcuClawWaitingOnYou(value     ) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    show: Reflect.get(source, "show") !== false,
    answer: Reflect.get(source, "answer") === true,
    surfaces: normalizeOcuClawWaitingSurfaces(Reflect.get(source, "surfaces")),
  };
}

function mergeWaitingOnYouPatch(current     , patch     ) {
  const base = normalizeOcuClawWaitingOnYou(current);
  const source = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const patchSurfaces = normalizeOcuClawWaitingSurfaces(Reflect.get(source, "surfaces"));
  const merged      = { ...patchSurfaces };
  for (const key of Object.keys(base.surfaces)) {
    if (Object.keys(merged).length >= OCUCLAW_WAITING_SURFACES_MAX) break;
    if (!hasOwn(merged, key)) merged[key] = base.surfaces[key];
  }
  return normalizeOcuClawWaitingOnYou({
    show: hasOwn(source, "show") ? Reflect.get(source, "show") : base.show,
    answer: hasOwn(source, "answer") ? Reflect.get(source, "answer") : base.answer,
    surfaces: merged,
  });
}

function waitingOnYouEqual(left     , right     ) {
  return JSON.stringify(normalizeOcuClawWaitingOnYou(left)) ===
    JSON.stringify(normalizeOcuClawWaitingOnYou(right));
}

function sanitizeOcuClawWaitingAvailableSurfaces(value     ) {
  if (!Array.isArray(value)) return [];
  const names = new Set        ();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (!OCUCLAW_WAITING_SURFACE_RE.test(entry)) continue;
    if (WAITING_NON_PLATFORM_SURFACES.has(entry)) continue;
    names.add(entry);
  }
  return Array.from(names).sort().slice(0, OCUCLAW_WAITING_SURFACES_MAX);
}

function normalizeOcuClawDefaultAgent(value) {
  return normalizeTrimmedString(value);
}

const OCUCLAW_AUTO_AGENT_ID = "auto";

function ocuClawDefaultAgentAsAgentId(value         )         {
  const normalized = normalizeOcuClawDefaultAgent(value);
  return normalized.toLowerCase() === OCUCLAW_AUTO_AGENT_ID ? "" : normalized;
}

function normalizeOcuClawAutoAgent(value         )          {
  return value === true;
}

function normalizeOcuClawAutoFallbackAgent(value     ) {
  return normalizeTrimmedString(value);
}

const OCUCLAW_AUTO_GRACE_DEFAULT_MS = 1000;
const OCUCLAW_AUTO_GRACE_MAX_MS = 3000;
function normalizeOcuClawAutoGraceMs(value     ) {
  if (typeof value !== "number" || !Number.isFinite(value)) return OCUCLAW_AUTO_GRACE_DEFAULT_MS;
  return Math.min(OCUCLAW_AUTO_GRACE_MAX_MS, Math.max(0, Math.round(value)));
}

function normalizeOcuClawPathwayBinding(value = {}) {
  const backend = normalizeTrimmedString(value && value.backend).toLowerCase();
  return {
    backend: BACKEND_KEYS.includes(backend) ? backend : "",
    agentRef: normalizeTrimmedString(value && value.agentRef),
  };
}

function normalizeOcuClawPathways(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const pathways = {};
  for (const key of PATHWAY_KEYS) {
    const pathway = source[key] && typeof source[key] === "object" ? source[key] : {};
    pathways[key] = {
      binding: normalizeOcuClawPathwayBinding(pathway.binding),
    };
  }
  return pathways;
}

function normalizeOcuClawEvenAiPeer(value = {}) {
  return {
    url: normalizeTrimmedString(value && value.url),
    bearerToken: normalizeTrimmedString(value && value.bearerToken),
    forwardSecret: normalizeTrimmedString(value && value.forwardSecret),
  };
}

function normalizeOcuClawEvenAiSection(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    peer: normalizeOcuClawEvenAiPeer(source.peer),
  };
}

function normalizedUrlOrigin(value     ) {
  const normalized = normalizeTrimmedString(value);
  if (!normalized) return "";
  try {
    return new URL(normalized).origin;
  } catch {
    return "";
  }
}

function mergeEvenAiPeerPatch(current      = {}, patch      = {}) {
  const currentPeer = normalizeOcuClawEvenAiPeer(current);
  const patchPeer = patch && typeof patch === "object" ? patch : {};
  const nextUrl = hasOwn(patchPeer, "url")
    ? normalizeTrimmedString(patchPeer.url)
    : currentPeer.url;
  const originChanged = hasOwn(patchPeer, "url")
    && normalizedUrlOrigin(currentPeer.url) !== normalizedUrlOrigin(nextUrl);
  return normalizeOcuClawEvenAiPeer({
    ...currentPeer,
    ...(originChanged ? { bearerToken: "", forwardSecret: "" } : {}),
    ...patchPeer,
  });
}

function pathwayBindingsEqual(left, right) {
  for (const key of PATHWAY_KEYS) {
    if (
      left[key].binding.backend !== right[key].binding.backend ||
      left[key].binding.agentRef !== right[key].binding.agentRef
    ) {
      return false;
    }
  }
  return true;
}

function mergePathwaysPatch(current, patch) {
  const source = patch && typeof patch === "object" ? patch : {};
  const merged = {};
  for (const key of PATHWAY_KEYS) {
    const currentPathway =
      current && current[key] && typeof current[key] === "object"
        ? current[key]
        : {};
    const patchPathway =
      source[key] && typeof source[key] === "object" ? source[key] : {};
    merged[key] = {
      ...currentPathway,
      ...patchPathway,
      binding: {
        ...((currentPathway && currentPathway.binding) || {}),
        ...((patchPathway && patchPathway.binding) || {}),
      },
    };
  }
  return normalizeOcuClawPathways(merged);
}

function isStoredSnapshotCanonical(value, snapshot) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const storedPathways = normalizeOcuClawPathways(value.pathways);
  const storedEvenAi = normalizeOcuClawEvenAiSection(value.evenAi);
  return (
    normalizeTrimmedString(value.systemPrompt) === snapshot.systemPrompt &&
    normalizeTrimmedString(value.defaultModel) === snapshot.defaultModel &&
    normalizeOcuClawDefaultThinking(value.defaultThinking) === snapshot.defaultThinking &&
    normalizeOcuClawDefaultFastMode(value.defaultFastMode) === snapshot.defaultFastMode &&
    normalizeOcuClawAgentProgressNotes(value.agentProgressNotes) === snapshot.agentProgressNotes &&
    normalizeOcuClawConversationToolProgress(value.conversationToolProgress) ===
      snapshot.conversationToolProgress &&
    normalizeOcuClawExplainApprovals(Reflect.get(value, "explainApprovals")) ===
      snapshot.explainApprovals &&
    normalizeOcuClawCardBuildFastMode(Reflect.get(value, "cardBuildFastMode")) ===
      snapshot.cardBuildFastMode &&

    activityLabChoicesEqual(Reflect.get(value, "activityLabs"), snapshot.activityLabs) &&
    waitingOnYouEqual(Reflect.get(value, "waitingOnYou"), snapshot.waitingOnYou) &&
    normalizeOcuClawOpenClawTaskSchedules(Reflect.get(value, "openclawTaskSchedules")) ===
      snapshot.openclawTaskSchedules &&
    normalizeOcuClawDefaultAgent(value.defaultAgent) === snapshot.defaultAgent &&
    normalizeOcuClawAutoAgent(Reflect.get(value, "autoAgent")) === snapshot.autoAgent &&
    normalizeOcuClawAutoFallbackAgent(Reflect.get(value, "autoFallbackAgent")) ===
      snapshot.autoFallbackAgent &&
    normalizeOcuClawAutoGraceMs(Reflect.get(value, "autoGraceMs")) === snapshot.autoGraceMs &&
    pathwayBindingsEqual(storedPathways, snapshot.pathways) &&
    storedEvenAi.peer.url === snapshot.evenAi.peer.url &&
    storedEvenAi.peer.bearerToken === snapshot.evenAi.peer.bearerToken &&
    storedEvenAi.peer.forwardSecret === snapshot.evenAi.peer.forwardSecret
  );
}

function normalizeOcuClawSettingsSnapshot(value = {}) {
  return {
    systemPrompt: normalizeOcuClawSystemPrompt(value.systemPrompt),
    defaultModel: normalizeOcuClawDefaultModel(value.defaultModel),
    defaultThinking: normalizeOcuClawDefaultThinking(value.defaultThinking),
    defaultFastMode: normalizeOcuClawDefaultFastMode(value.defaultFastMode),
    defaultAgent: normalizeOcuClawDefaultAgent(value.defaultAgent),
    autoAgent: normalizeOcuClawAutoAgent(Reflect.get(value, "autoAgent")),
    autoFallbackAgent: normalizeOcuClawAutoFallbackAgent(Reflect.get(value, "autoFallbackAgent")),
    autoGraceMs: normalizeOcuClawAutoGraceMs(Reflect.get(value, "autoGraceMs")),
    agentProgressNotes: normalizeOcuClawAgentProgressNotes(value.agentProgressNotes),
    conversationToolProgress: normalizeOcuClawConversationToolProgress(
      Reflect.get(value, "conversationToolProgress"),
    ),
    explainApprovals: normalizeOcuClawExplainApprovals(Reflect.get(value, "explainApprovals")),
    cardBuildFastMode: normalizeOcuClawCardBuildFastMode(Reflect.get(value, "cardBuildFastMode")),

    activityLabs: normalizeActivityLabChoices(Reflect.get(value, "activityLabs")),
    waitingOnYou: normalizeOcuClawWaitingOnYou(Reflect.get(value, "waitingOnYou")),
    openclawTaskSchedules: normalizeOcuClawOpenClawTaskSchedules(Reflect.get(value, "openclawTaskSchedules")),
    pathways: normalizeOcuClawPathways(value.pathways),
    evenAi: normalizeOcuClawEvenAiSection(value.evenAi),
  };
}

function cloneOcuClawSettingsSnapshot(value = {}) {
  return normalizeOcuClawSettingsSnapshot(value);
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function createOcuClawSettingsStore(opts = {}) {
  const logger = normalizeLogger(opts.logger);
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const givenDefaults = opts.defaults || {};
  const defaults = normalizeOcuClawSettingsSnapshot(givenDefaults);

  const newInstallDefaults = normalizeOcuClawSettingsSnapshot({
    agentProgressNotes: OCUCLAW_AGENT_PROGRESS_NOTES_NEW_INSTALL,
    ...givenDefaults,
  });
  const statePath =
    typeof opts.statePath === "string" && opts.statePath.trim()
      ? opts.statePath.trim()
      : typeof opts.stateDir === "string" && opts.stateDir.trim()
        ? path.join(opts.stateDir.trim(), STORE_FILENAME)
        : null;

  let pendingWrite = null;
  let pendingWriteTimer                                       = null;
  let writeInFlight = false;
  let inFlightWrite                       = null;

  async function writeSnapshotToDisk(snapshot, reason) {
    const payload =
      JSON.stringify(
        {
          version: STORE_VERSION,
          updatedAtMs: now(),
          settings: snapshot,
        },
        null,
        2,
      ) + "\n";
    const tmpPath = `${statePath}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
      await fs.promises.writeFile(tmpPath, payload, { mode: 0o600 });
      try {
        await fs.promises.chmod(tmpPath, 0o600);
      } catch {

      }
      await fs.promises.rename(tmpPath, statePath);
      try {
        await fs.promises.chmod(statePath, 0o600);
      } catch {

      }
      emitDebug(
        "settings.loadsave",
        "ocuclaw_settings_persisted",
        "info",
        null,
        () => ({
          reason,
          statePath,
          systemPromptChars: snapshot.systemPrompt.length,
          defaultModel: snapshot.defaultModel,
          defaultThinking: snapshot.defaultThinking,
          defaultFastMode: snapshot.defaultFastMode,
          agentProgressNotes: snapshot.agentProgressNotes,
          conversationToolProgress: snapshot.conversationToolProgress,
          pathwayBindings: Object.fromEntries(
            PATHWAY_KEYS.map((key) => [
              key,
              snapshot.pathways[key].binding.backend || "local",
            ]),
          ),
        }),
      );
    } catch (err) {
      logger.error(
        `[ocuclaw] failed to persist OcuClaw settings: ${err && err.message ? err.message : err}`,
      );
      emitDebug(
        "settings.loadsave",
        "ocuclaw_settings_persist_failed",
        "warn",
        null,
        () => ({
          reason,
          statePath,
          message: err && err.message ? err.message : String(err),
        }),
      );
    }
  }

  function flushPendingWrite() {
    if (writeInFlight || !pendingWrite) {
      return;
    }
    const { snapshot, reason } = pendingWrite;
    pendingWrite = null;
    writeInFlight = true;
    inFlightWrite = writeSnapshotToDisk(snapshot, reason).finally(() => {
      writeInFlight = false;
      inFlightWrite = null;
      if (pendingWrite) {
        flushPendingWrite();
      }
    });
  }

  function persistSnapshot(snapshot, reason) {
    const stableSnapshot = cloneOcuClawSettingsSnapshot(snapshot);
    if (!statePath) {
      emitDebug(
        "settings.loadsave",
        "ocuclaw_settings_persist_skipped",
        "debug",
        null,
        () => ({
          reason,
          systemPromptChars: stableSnapshot.systemPrompt.length,
          defaultModel: stableSnapshot.defaultModel,
          defaultThinking: stableSnapshot.defaultThinking,
          defaultFastMode: stableSnapshot.defaultFastMode,
          agentProgressNotes: stableSnapshot.agentProgressNotes,
          conversationToolProgress: stableSnapshot.conversationToolProgress,
          pathwayBindings: Object.fromEntries(
            PATHWAY_KEYS.map((key) => [
              key,
              stableSnapshot.pathways[key].binding.backend || "local",
            ]),
          ),
        }),
      );
      return;
    }

    pendingWrite = { snapshot: stableSnapshot, reason };
    if (pendingWriteTimer) {
      clearTimeout(pendingWriteTimer);
    }
    pendingWriteTimer = setTimeout(() => {
      pendingWriteTimer = null;
      flushPendingWrite();
    }, PERSIST_DEBOUNCE_MS);
  }

  function loadInitialSnapshot() {
    if (!statePath || !fs.existsSync(statePath)) {
      persistSnapshot(newInstallDefaults, "seed_defaults");
      return cloneOcuClawSettingsSnapshot(newInstallDefaults);
    }

    let raw;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch (err) {

      return runOnDefaultsWithoutWriting(describeStateFileLoadError(err));
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
      loaded = normalizeOcuClawSettingsSnapshot(storedSettings);
    } catch (err) {
      return setAsideUnusableFile("corrupt", "rewrite_after_load_failure", describeStateFileLoadError(err));
    }
    emitDebug(
      "settings.loadsave",
      "ocuclaw_settings_loaded",
      "info",
      null,
      () => ({
        statePath,
        systemPromptChars: loaded.systemPrompt.length,
        defaultModel: loaded.defaultModel,
        defaultThinking: loaded.defaultThinking,
        defaultFastMode: loaded.defaultFastMode,
        agentProgressNotes: loaded.agentProgressNotes,
        conversationToolProgress: loaded.conversationToolProgress,
        pathwayBindings: Object.fromEntries(
          PATHWAY_KEYS.map((key) => [
            key,
            loaded.pathways[key].binding.backend || "local",
          ]),
        ),
      }),
    );
    if (hadBom) {

      persistSnapshot(loaded, "strip_bom");
    } else if (!isStoredSnapshotCanonical(storedSettings, loaded)) {
      persistSnapshot(loaded, "normalize_loaded_settings");
    }
    return loaded;
  }

  function runOnDefaultsWithoutWriting(detail        ) {
    logger.error(
      `[ocuclaw] could not read the OcuClaw settings file (${detail}); running on defaults without touching it`,
    );
    emitDebug(
      "settings.loadsave",
      "ocuclaw_settings_read_failed",
      "warn",
      null,
      () => ({ statePath, message: detail }),
    );
    return cloneOcuClawSettingsSnapshot(defaults);
  }

  function setAsideUnusableFile(suffix, reason, detail) {
    logger.warn(
      `[ocuclaw] cannot use the OcuClaw settings file (${detail}); moving it aside and falling back to defaults`,
    );
    emitDebug(
      "settings.loadsave",
      "ocuclaw_settings_load_failed",
      "warn",
      null,
      () => ({ statePath, reason, message: detail }),
    );
    const result = quarantineStateFile(statePath, suffix, { now });
    if (result.originalGone) {
      emitDebug(
        "settings.loadsave",
        "ocuclaw_settings_quarantined",
        "warn",
        null,
        () => ({ statePath, quarantinePath: result.quarantinePath }),
      );
      persistSnapshot(defaults, reason);
    } else {
      logger.error(
        `[ocuclaw] could not move the unusable OcuClaw settings file aside (${result.errorCode}); running on defaults without overwriting it`,
      );
      emitDebug(
        "settings.loadsave",
        "ocuclaw_settings_quarantine_failed",
        "warn",
        null,
        () => ({ statePath, reason, errorCode: result.errorCode }),
      );
    }
    return cloneOcuClawSettingsSnapshot(defaults);
  }

  let snapshot = loadInitialSnapshot();

  return {
    getStatePath() {
      return statePath;
    },

    async flush() {
      if (pendingWriteTimer) {
        clearTimeout(pendingWriteTimer);
        pendingWriteTimer = null;
      }
      flushPendingWrite();
      while (inFlightWrite) {
        await inFlightWrite;
        flushPendingWrite();
      }
    },

    getSnapshot() {
      return cloneOcuClawSettingsSnapshot(snapshot);
    },

    async setSettings(patch = {}) {
      const nextSystemPrompt = hasOwn(patch, "systemPrompt")
        ? normalizeAndValidateCustomSystemPrompt(patch.systemPrompt)
        : snapshot.systemPrompt;
      const next = {
        systemPrompt: nextSystemPrompt,
        defaultModel: hasOwn(patch, "defaultModel")
          ? normalizeOcuClawDefaultModel(patch.defaultModel)
          : snapshot.defaultModel,
        defaultThinking: hasOwn(patch, "defaultThinking")
          ? normalizeOcuClawDefaultThinking(patch.defaultThinking)
          : snapshot.defaultThinking,
        defaultFastMode: hasOwn(patch, "defaultFastMode")
          ? normalizeOcuClawDefaultFastMode(patch.defaultFastMode)
          : snapshot.defaultFastMode,
        defaultAgent: hasOwn(patch, "defaultAgent")
          ? normalizeOcuClawDefaultAgent(patch.defaultAgent)
          : snapshot.defaultAgent,
        autoAgent: hasOwn(patch, "autoAgent")
          ? normalizeOcuClawAutoAgent(Reflect.get(patch, "autoAgent"))
          : snapshot.autoAgent,
        autoFallbackAgent: hasOwn(patch, "autoFallbackAgent")
          ? normalizeOcuClawAutoFallbackAgent(Reflect.get(patch, "autoFallbackAgent"))
          : snapshot.autoFallbackAgent,
        autoGraceMs: hasOwn(patch, "autoGraceMs")
          ? normalizeOcuClawAutoGraceMs(Reflect.get(patch, "autoGraceMs"))
          : snapshot.autoGraceMs,
        agentProgressNotes: hasOwn(patch, "agentProgressNotes")
          ? normalizeOcuClawAgentProgressNotes(patch.agentProgressNotes)
          : snapshot.agentProgressNotes,
        conversationToolProgress: hasOwn(patch, "conversationToolProgress")
          ? normalizeOcuClawConversationToolProgress(
              Reflect.get(patch, "conversationToolProgress"),
            )
          : snapshot.conversationToolProgress,
        explainApprovals: hasOwn(patch, "explainApprovals")
          ? normalizeOcuClawExplainApprovals(Reflect.get(patch, "explainApprovals"))
          : snapshot.explainApprovals,
        cardBuildFastMode: hasOwn(patch, "cardBuildFastMode")
          ? normalizeOcuClawCardBuildFastMode(Reflect.get(patch, "cardBuildFastMode"))
          : snapshot.cardBuildFastMode,
        activityLabs: hasOwn(patch, "activityLabs")
          ? normalizeActivityLabChoices(Reflect.get(patch, "activityLabs"))
          : snapshot.activityLabs,
        waitingOnYou: hasOwn(patch, "waitingOnYou")
          ? mergeWaitingOnYouPatch(snapshot.waitingOnYou, Reflect.get(patch, "waitingOnYou"))
          : snapshot.waitingOnYou,

        openclawTaskSchedules: snapshot.openclawTaskSchedules,
        pathways: hasOwn(patch, "pathways")
          ? mergePathwaysPatch(snapshot.pathways, patch.pathways)
          : snapshot.pathways,
        evenAi: hasOwn(patch, "evenAi")
          ? normalizeOcuClawEvenAiSection({
              ...snapshot.evenAi,
              ...(patch.evenAi || {}),
              peer: mergeEvenAiPeerPatch(
                snapshot.evenAi.peer,
                patch.evenAi && patch.evenAi.peer,
              ),
            })
          : snapshot.evenAi,
      };
      snapshot = cloneOcuClawSettingsSnapshot(next);
      persistSnapshot(snapshot, "set_settings");
      return {
        status: "accepted",
        settings: cloneOcuClawSettingsSnapshot(snapshot),
      };
    },
  };
}

module.exports = { normalizeOcuClawSystemPrompt, normalizeOcuClawDefaultModel, normalizeOcuClawDefaultThinking, OCUCLAW_AGENT_PROGRESS_NOTES_MODES, OCUCLAW_AGENT_PROGRESS_NOTES_DEFAULT, OCUCLAW_AGENT_PROGRESS_NOTES_NEW_INSTALL, normalizeOcuClawAgentProgressNotes, normalizeOcuClawDefaultFastMode, normalizeOcuClawConversationToolProgress, normalizeOcuClawExplainApprovals, normalizeOcuClawCardBuildFastMode, normalizeOcuClawOpenClawTaskSchedules, OCUCLAW_WAITING_SURFACE_RE, OCUCLAW_WAITING_SURFACES_MAX, normalizeOcuClawWaitingSurfaces, normalizeOcuClawWaitingOnYou, sanitizeOcuClawWaitingAvailableSurfaces, normalizeOcuClawDefaultAgent, OCUCLAW_AUTO_AGENT_ID, ocuClawDefaultAgentAsAgentId, normalizeOcuClawAutoAgent, normalizeOcuClawAutoFallbackAgent, OCUCLAW_AUTO_GRACE_DEFAULT_MS, OCUCLAW_AUTO_GRACE_MAX_MS, normalizeOcuClawAutoGraceMs, normalizeOcuClawPathwayBinding, normalizeOcuClawPathways, normalizeOcuClawEvenAiPeer, normalizeOcuClawEvenAiSection, normalizeOcuClawSettingsSnapshot, createOcuClawSettingsStore };
