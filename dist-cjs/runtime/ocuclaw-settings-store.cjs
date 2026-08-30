const fs = require("node:fs");
const path = require("node:path");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");

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
  return normalizeTrimmedString(value);
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
const OCUCLAW_AGENT_PROGRESS_NOTES_DEFAULT = "status";

function normalizeOcuClawAgentProgressNotes(value) {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  return OCUCLAW_AGENT_PROGRESS_NOTES_MODES.includes(normalized)
    ? normalized
    : OCUCLAW_AGENT_PROGRESS_NOTES_DEFAULT;
}

function normalizeOcuClawDefaultFastMode(value) {
  return value === true;
}

function normalizeOcuClawConversationToolProgress(value) {
  return value === true;
}

function normalizeOcuClawDefaultAgent(value) {
  return normalizeTrimmedString(value);
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
    normalizeOcuClawDefaultAgent(value.defaultAgent) === snapshot.defaultAgent &&
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
    agentProgressNotes: normalizeOcuClawAgentProgressNotes(value.agentProgressNotes),
    conversationToolProgress: normalizeOcuClawConversationToolProgress(
      Reflect.get(value, "conversationToolProgress"),
    ),
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
  const defaults = normalizeOcuClawSettingsSnapshot(opts.defaults || {});
  const statePath =
    typeof opts.statePath === "string" && opts.statePath.trim()
      ? opts.statePath.trim()
      : typeof opts.stateDir === "string" && opts.stateDir.trim()
        ? path.join(opts.stateDir.trim(), STORE_FILENAME)
        : null;

  let pendingWrite = null;
  let pendingWriteTimer = null;
  let writeInFlight = false;

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
    writeSnapshotToDisk(snapshot, reason).finally(() => {
      writeInFlight = false;
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
      persistSnapshot(defaults, "seed_defaults");
      return cloneOcuClawSettingsSnapshot(defaults);
    }

    try {
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      const storedSettings =
        parsed && parsed.settings && typeof parsed.settings === "object"
          ? parsed.settings
          : null;
      const loaded =
        parsed && parsed.version === STORE_VERSION && storedSettings
          ? normalizeOcuClawSettingsSnapshot(storedSettings)
          : defaults;
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
      if (
        parsed.version !== STORE_VERSION ||
        !isStoredSnapshotCanonical(storedSettings, loaded)
      ) {
        persistSnapshot(loaded, "normalize_loaded_settings");
      }
      return loaded;
    } catch (err) {
      logger.warn(
        `[ocuclaw] failed to load OcuClaw settings, falling back to defaults: ${err && err.message ? err.message : err}`,
      );
      emitDebug(
        "settings.loadsave",
        "ocuclaw_settings_load_failed",
        "warn",
        null,
        () => ({
          statePath,
          message: err && err.message ? err.message : String(err),
        }),
      );
      persistSnapshot(defaults, "rewrite_after_load_failure");
      return cloneOcuClawSettingsSnapshot(defaults);
    }
  }

  let snapshot = loadInitialSnapshot();

  return {
    getStatePath() {
      return statePath;
    },

    getSnapshot() {
      return cloneOcuClawSettingsSnapshot(snapshot);
    },

    async setSettings(patch = {}) {
      const next = {
        systemPrompt: hasOwn(patch, "systemPrompt")
          ? normalizeOcuClawSystemPrompt(patch.systemPrompt)
          : snapshot.systemPrompt,
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
        agentProgressNotes: hasOwn(patch, "agentProgressNotes")
          ? normalizeOcuClawAgentProgressNotes(patch.agentProgressNotes)
          : snapshot.agentProgressNotes,
        conversationToolProgress: hasOwn(patch, "conversationToolProgress")
          ? normalizeOcuClawConversationToolProgress(
              Reflect.get(patch, "conversationToolProgress"),
            )
          : snapshot.conversationToolProgress,
        pathways: hasOwn(patch, "pathways")
          ? mergePathwaysPatch(snapshot.pathways, patch.pathways)
          : snapshot.pathways,
        evenAi: hasOwn(patch, "evenAi")
          ? normalizeOcuClawEvenAiSection({
              ...snapshot.evenAi,
              ...(patch.evenAi || {}),
              peer: {
                ...snapshot.evenAi.peer,
                ...((patch.evenAi && patch.evenAi.peer) || {}),
              },
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

module.exports = { normalizeOcuClawDefaultModel, normalizeOcuClawDefaultThinking, normalizeOcuClawAgentProgressNotes, normalizeOcuClawConversationToolProgress, OCUCLAW_AGENT_PROGRESS_NOTES_MODES, OCUCLAW_AGENT_PROGRESS_NOTES_DEFAULT, normalizeOcuClawSystemPrompt, normalizeOcuClawDefaultAgent, normalizeOcuClawPathwayBinding, normalizeOcuClawPathways, normalizeOcuClawEvenAiPeer, normalizeOcuClawEvenAiSection, normalizeOcuClawSettingsSnapshot, createOcuClawSettingsStore };
