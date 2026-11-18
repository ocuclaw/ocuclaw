const { Buffer } = require("node:buffer");
const { scrubSecretShapes } = require("../domain/debug-bundle-redaction.cjs");
const { createHash } = require("node:crypto");
const { normalizeAgentAppearance } = require("../domain/agent-appearance.cjs");
const { buildRateLimitInfoFromSnapshot, normalizeProviderId, selectProviderUsageSnapshot } = require("./provider-usage-select.cjs");
const { stripDisplayMarkup } = require("../domain/tagged-span-strip.cjs");
const { progressNoteInActionVoice, splitBoldHeading } = require("../domain/activity-prose.cjs");
const { serverIdOf } = require("../domain/conversation-state.cjs");
const { projectOpenClawConversationHistory } = require("../domain/openclaw-conversation-history.cjs");
const { programCardPictureSurfaceId } = require("../domain/program-card-pictures.cjs");
const { modelInputKey, modelInputsFromCatalogRows } = require("../domain/model-input-kinds.cjs");
const { speckFeelings } = require("../domain/speck-marker.cjs");
const { parseTaggedSpans } = require("../domain/tagged-span-parser.cjs");
const { EMOJI_TAG_FAMILY_CONFIG } = require("../domain/neural-emoji-reactor-tag-config.cjs");
const { PACE_TAG_FAMILY_CONFIG } = require("../domain/neural-pace-modulator-tag-config.cjs");
const { applyMarkdownWithSpans } = require("../domain/streaming-span-markdown.cjs");
const { createUiRecordFamily, splitUiRecordSpans, stripNoteRecords, stripReplyMarkup } = require("../domain/ui-record-family.cjs");
const { createLiveUiSurfaceRevisions, fillLiveUiInputs, isLiveUiSurfaceOrigin } = require("../tools/liveui-compiler/surface-revisions.cjs");
const { replyPictureFallbackRecords } = require("../domain/reply-picture-fallback.cjs");
const { validateLiveUiInputs } = require("../tools/liveui-compiler/template-inputs.cjs");
const { liveUiSpecDataKeys } = require("../tools/liveui-compiler/stored-surface.cjs");
const { createLiveUiSurfaceSender } = require("../tools/liveui-compiler/surface-sender.cjs");
const { createLiveUiSurfaceState, isLiveUiParkedResult, liveUiRowNames, sanitizeLiveUiStateReport } = require("../tools/liveui-compiler/surface-state.cjs");
const { isWakeRefToken, isWakeRowRefToken } = require("../tools/glasses-ui-wake.cjs");
const { createLiveUiPictureService, createPictureResolver } = require("../tools/liveui-pictures/picture-service.cjs");
const { createPictureModels } = require("../tools/liveui-models/model-picture.cjs");
const { createLiveUiVideoService, LIVEUI_SUBTITLES_PATH } = require("../tools/liveui-video/video-service.cjs");
const { createSessionContextService } = require("./session-context-service.cjs");
const { isTitleDistillerRun } = require("./session-title-distiller-helpers.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { reasoningCeilingForModel } = require("./capability-snapshot.cjs");
const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { resolveInputPredictionIdentity } = require("./input-prediction-identity.cjs");
const { relaySessionKeyFor } = require("./openclaw-session-key.cjs");
const { parseHermesPublicKey } = require("./hermes-session-keys.cjs");
const { runtimeOnlyModelMatcher } = require("../gateway/input-prediction-openclaw.cjs");
const { sanitizeConnectReason } = require("../gateway/sanitize-connect-reason.cjs");
const { codexAppServerApprovalCommand, formatWaiting, formatWaitingExplanation, normalizeWaitingPayload, waitingExplainInput } = require("./downstream-codec-approval.cjs");
const { createRunSignalTracker } = require("./run-signals.cjs");
const { MODEL_SITES_FENCE_KIND, modelSitesGuideLine } = require("../tools/liveui-model-sites/model-sites-guide.cjs");

const DEFAULT_MODEL_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-opus-4-6";
const POOL_OUTCOME_FRESHNESS_MS = 10 * 60 * 1000;
const THINKING_FINALIZE_RETENTION_MS = 5 * 60 * 1000;
const LEDGER_COMMIT_HISTORY_GRACE_MS = 1_000;

const LEDGER_COMMIT_STALL_MS = 500;
const AGENT_PROGRESS_NOTES_DEFAULT = "conversation";

const AGENT_PROGRESS_NOTES_LEGACY_STATUS = "status";

function normalizeAgentProgressNotes(value) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "off") return "off";
  if (normalized === "conversation") return "conversation";
  if (normalized === AGENT_PROGRESS_NOTES_LEGACY_STATUS) return "conversation";
  return AGENT_PROGRESS_NOTES_DEFAULT;
}

function normalizeOriginAtMs(value     ) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function isNarrationCommit(data) {
  const kind =
    data && typeof data.messageKind === "string"
      ? data.messageKind.trim().toLowerCase()
      : "";
  return kind === "narration";
}

function isToolProgressCommit(data     ) {
  const kind =
    data && typeof data.messageKind === "string"
      ? data.messageKind.trim().toLowerCase()
      : "";
  return kind === "tool_progress";
}

const STREAMING_REBROADCAST_THROTTLE_MS = 33;

function isTerminalActivityBoundary(state, phase, origin) {
  const normalizedOrigin = typeof origin === "string" ? origin.trim().toLowerCase() : "";
  if (normalizedOrigin !== "lifecycle") {
    return false;
  }
  const normalizedState = typeof state === "string" ? state.trim().toLowerCase() : "";
  if (normalizedState === "idle" || normalizedState === "error") {
    return true;
  }
  const normalizedPhase = typeof phase === "string" ? phase.trim().toLowerCase() : "";
  return (
    normalizedPhase === "error" ||
    normalizedPhase === "end" ||
    normalizedPhase === "complete" ||
    normalizedPhase === "completed" ||
    normalizedPhase === "done" ||
    normalizedPhase === "failed" ||
    normalizedPhase === "finish" ||
    normalizedPhase === "finished"
  );
}

function classifyRunOutcomeFrame(activity     , phase     , origin     ) {
  const failoverPending = !!activity && activity.failoverPending === true;
  const normalizedPhase = typeof phase === "string" ? phase.trim().toLowerCase() : "";

  const cancelled = isCancelledRunFrame(activity);
  const errored = !failoverPending && !cancelled && !!activity && activity.isError === true && normalizedPhase === "error";
  const terminal = !failoverPending
    && (errored || isTerminalActivityBoundary(activity && activity.state, phase, origin));
  const code = errored && activity && typeof activity.code === "string" && activity.code ? activity.code : null;
  return { terminal, errored, code };
}

const CANCELLED_RUN_CODES = new Set(["interrupted", "cancelled"]);
function isCancelledRunFrame(activity     ) {
  if (!activity || typeof activity !== "object") return false;
  if (activity.aborted === true) return true;
  return typeof activity.code === "string" && CANCELLED_RUN_CODES.has(activity.code.trim().toLowerCase());
}

const CANCELLED_CLOSE_DROPPED_FIELDS = [
  "isError", "code", "label", "shortLabel", "detail", "title", "summary",
  "message", "error", "reason", "rateLimitInfo",
];

function quietCancelledRunClose(activity     ) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return activity;
  const phase = typeof activity.phase === "string" ? activity.phase.trim().toLowerCase() : "";
  if (phase !== "error" || activity.failoverPending === true || !isCancelledRunFrame(activity)) {
    return activity;
  }
  const quiet = { ...activity, state: "idle", phase: "end", aborted: true };
  for (const field of CANCELLED_CLOSE_DROPPED_FIELDS) delete quiet[field];
  return quiet;
}

function normalizeStreamingToken(raw) {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function isTitleDistillerStreamingEvent(data) {
  return isTitleDistillerRun(data && data.runId, data && data.sessionKey);
}

function fullMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function modelRefKey(provider, model) {
  return `${provider}/${model}`;
}

function parseModelRef(raw, defaultProvider, normalizeProvider = normalizeProviderId) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const provider = normalizeProvider(defaultProvider);
    if (!provider) return null;
    return { provider, model: trimmed };
  }
  const provider = normalizeProvider(trimmed.slice(0, slash));
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

function buildModelAliasIndex(config) {
  const aliasIndex = new Map();
  const modelEntries =
    config &&
    config.agents &&
    config.agents.defaults &&
    config.agents.defaults.models &&
    typeof config.agents.defaults.models === "object" &&
    !Array.isArray(config.agents.defaults.models)
      ? config.agents.defaults.models
      : {};
  for (const [rawKey, rawEntry] of Object.entries(modelEntries)) {
    const parsed = parseModelRef(String(rawKey || ""), DEFAULT_MODEL_PROVIDER);
    if (!parsed) continue;
    const alias =
      rawEntry &&
      typeof rawEntry === "object" &&
      typeof rawEntry.alias === "string"
        ? rawEntry.alias.trim()
        : "";
    if (!alias) continue;
    aliasIndex.set(alias.toLowerCase(), parsed);
  }
  return aliasIndex;
}

function resolveModelRefFromString(raw, aliasIndex, normalizeProvider = normalizeProviderId) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("/")) {
    const aliasMatch = aliasIndex.get(trimmed.toLowerCase());
    if (aliasMatch) {
      return aliasMatch;
    }
  }
  return parseModelRef(trimmed, DEFAULT_MODEL_PROVIDER, normalizeProvider);
}

function resolveConfiguredDefaultModelRef(
  config,
  aliasIndex,
  normalizeProvider = normalizeProviderId,
) {
  const modelConfig =
    config && config.agents && config.agents.defaults
      ? config.agents.defaults.model
      : undefined;
  const rawModel = (() => {
    if (typeof modelConfig === "string") return modelConfig.trim();
    if (
      modelConfig &&
      typeof modelConfig === "object" &&
      typeof modelConfig.primary === "string"
    ) {
      return modelConfig.primary.trim();
    }
    return "";
  })();
  if (rawModel) {
    if (!rawModel.includes("/")) {
      const aliasMatch = aliasIndex.get(rawModel.toLowerCase());
      if (aliasMatch) {
        return aliasMatch;
      }
      return { provider: DEFAULT_MODEL_PROVIDER, model: rawModel };
    }
    const parsed = resolveModelRefFromString(rawModel, aliasIndex, normalizeProvider);
    if (parsed) {
      return parsed;
    }
  }
  return { provider: DEFAULT_MODEL_PROVIDER, model: DEFAULT_MODEL_ID };
}

function configuredAgentRows(config) {
  const agentsConfig = config && config.agents && typeof config.agents === "object"
    ? config.agents
    : {};
  const rows = [];
  for (const agent of Array.isArray(agentsConfig.list) ? agentsConfig.list : []) {
    if (!agent || typeof agent !== "object") continue;
    rows.push({ id: typeof agent.id === "string" ? agent.id.trim() : "", agent });
  }
  const entries = agentsConfig.entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const [id, agent] of Object.entries(entries)) {
      if (!agent || typeof agent !== "object") continue;
      rows.push({ id: id.trim(), agent });
    }
  }
  return rows;
}

function agentIdsWithOwnModel(configSnapshot) {
  const ids = new Set        ();
  for (const { id, agent } of configuredAgentRows(extractConfigObject(configSnapshot))) {
    const model = agent.model;
    const primary = typeof model === "string"
      ? model
      : model && typeof model === "object" ? model.primary : "";
    if (id && typeof primary === "string" && primary.trim()) ids.add(id);
  }
  return ids;
}

function resolveConfiguredModelRefs(config, normalizeProvider = normalizeProviderId) {
  const aliasIndex = buildModelAliasIndex(config || {});
  const refs = [];
  const seen = new Set();

  function addRef(ref) {
    if (!ref || !ref.provider || !ref.model) return;
    const key = modelRefKey(ref.provider, ref.model);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  }

  addRef(resolveConfiguredDefaultModelRef(config || {}, aliasIndex, normalizeProvider));

  const modelConfig =
    config && config.agents && config.agents.defaults
      ? config.agents.defaults.model
      : undefined;
  const imageModelConfig =
    config && config.agents && config.agents.defaults
      ? config.agents.defaults.imageModel
      : undefined;

  const modelFallbacks =
    modelConfig &&
    typeof modelConfig === "object" &&
    Array.isArray(modelConfig.fallbacks)
      ? modelConfig.fallbacks
      : [];
  for (const raw of modelFallbacks) {
    const parsed = resolveModelRefFromString(String(raw || ""), aliasIndex, normalizeProvider);
    addRef(parsed);
  }

  const imagePrimary =
    imageModelConfig &&
    typeof imageModelConfig === "object" &&
    typeof imageModelConfig.primary === "string"
      ? imageModelConfig.primary.trim()
      : "";
  if (imagePrimary) {
    const parsed = resolveModelRefFromString(imagePrimary, aliasIndex, normalizeProvider);
    addRef(parsed);
  }

  const imageFallbacks =
    imageModelConfig &&
    typeof imageModelConfig === "object" &&
    Array.isArray(imageModelConfig.fallbacks)
      ? imageModelConfig.fallbacks
      : [];
  for (const raw of imageFallbacks) {
    const parsed = resolveModelRefFromString(String(raw || ""), aliasIndex, normalizeProvider);
    addRef(parsed);
  }

  const modelEntries =
    config &&
    config.agents &&
    config.agents.defaults &&
    config.agents.defaults.models &&
    typeof config.agents.defaults.models === "object" &&
    !Array.isArray(config.agents.defaults.models)
      ? config.agents.defaults.models
      : {};
  for (const rawKey of Object.keys(modelEntries)) {
    const parsed = parseModelRef(String(rawKey || ""), DEFAULT_MODEL_PROVIDER, normalizeProvider);
    addRef(parsed);
  }

  for (const { agent } of configuredAgentRows(config)) {
    const agentModel = agent && typeof agent === "object" ? agent.model : undefined;
    if (typeof agentModel === "string") {
      addRef(resolveModelRefFromString(agentModel, aliasIndex, normalizeProvider));
      continue;
    }
    if (!agentModel || typeof agentModel !== "object") continue;
    if (typeof agentModel.primary === "string") {
      addRef(resolveModelRefFromString(agentModel.primary, aliasIndex, normalizeProvider));
    }
    if (Array.isArray(agentModel.fallbacks)) {
      for (const raw of agentModel.fallbacks) {
        addRef(resolveModelRefFromString(String(raw || ""), aliasIndex, normalizeProvider));
      }
    }
  }

  return refs;
}

function extractConfigObject(configSnapshot) {
  if (
    configSnapshot &&
    typeof configSnapshot === "object" &&
    configSnapshot.config &&
    typeof configSnapshot.config === "object" &&
    !Array.isArray(configSnapshot.config)
  ) {
    return configSnapshot.config;
  }
  return {};
}

function mapConfiguredCatalogRows(
  modelsCatalogRows,
  configSnapshot,
  normalizeProvider = normalizeProviderId,
) {
  const byKey = new Map();
  const providers = new Set();
  for (const row of modelsCatalogRows) {
    byKey.set(modelRefKey(row.provider, row.id), row);
    providers.add(row.provider);
  }
  const catalogUnavailable = modelsCatalogRows.length === 0;
  const config = extractConfigObject(configSnapshot);
  const configuredRefs = resolveConfiguredModelRefs(config, normalizeProvider);
  const runtimeOnly = runtimeOnlyModelMatcher(config);
  const out = [];
  for (const ref of configuredRefs) {
    const key = modelRefKey(ref.provider, ref.model);
    const row = byKey.get(key);
    if (row) {
      out.push(row);
    } else if (!runtimeOnly(key) && (catalogUnavailable || providers.has(ref.provider))) {

      const reasoningCeiling = reasoningCeilingForModel(ref.provider, ref.model);
      const configuredRow = {
        provider: ref.provider,
        id: ref.model,
        name: ref.model,
        ...(reasoningCeiling ? { reasoningCeiling } : {}),
      };
      out.push(configuredRow);
    }
  }
  return out;
}

const hermesProviderId = (raw         ) => String(raw || "").trim();

function mapHermesConfiguredCatalogRows(rows     , configSnapshot     ) {

  const available = Array.isArray(rows) ? rows : [];
  const config      = extractConfigObject(configSnapshot);
  const model = config.agents?.defaults?.model;
  if (model?.primary) {
    const configured = mapConfiguredCatalogRows(available, configSnapshot, hermesProviderId);
    const keys = new Set(configured.map(row => modelRefKey(row.provider, row.id)));
    return [...configured, ...available.filter(row => !keys.has(modelRefKey(row.provider, row.id)))];
  }
  const fallbacks = model?.fallbacks || [];
  if (!fallbacks.length) return available;
  return mapHermesConfiguredCatalogRows(available, {
    config: {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents.defaults,
          model: { primary: fallbacks[0], fallbacks },
        },
      },
    },
  });
}

function normalizeModelCatalogRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const provider =
      typeof row.provider === "string" ? row.provider.trim() : "";
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!provider || !id) continue;
    const name =
      typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
    const model = { provider, id, name };
    if (Number.isFinite(row.contextWindow) && row.contextWindow > 0) {
      model.contextWindow = Math.floor(row.contextWindow);
    }
    if (typeof row.reasoning === "boolean") {
      Object.assign(model, { reasoning: row.reasoning });
    }
    const reasoningCeiling = reasoningCeilingForModel(provider, id);
    if (reasoningCeiling) {
      Object.assign(model, { reasoningCeiling });
    }
    out.push(model);
  }
  return out;
}

function normalizeSkillsCatalogRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.eligible !== true) continue;

    if (
      row.disabled === true ||
      row.blockedByAllowlist === true ||
      row.blockedByAgentFilter === true
    ) {
      continue;
    }
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      description:
        typeof row.description === "string" && row.description.trim()
          ? row.description.trim()
          : "",
    });
  }
  return out;
}

function skillsCatalogRowsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] || {};
    const b = right[i] || {};
    if (a.name !== b.name || a.description !== b.description) {
      return false;
    }
  }
  return true;
}

const COMMAND_CATALOG_TTL_MS = 60_000;

const COMMAND_CATALOG_MAX_ENTRIES = 300;
const COMMAND_DESCRIPTION_MAX_CHARS = 160;
const COMMAND_MAX_ALIASES = 8;
const COMMAND_ARGS_HINT_MAX_CHARS = 60;
const COMMAND_SNAPSHOT_MAX_BYTES = 256 * 1024;

const COMMAND_EXECUTES_BY_BACKEND = new Map([
  ["openclaw", "all"],
  ["hermes", "all"],
]);

const COMMAND_INTERCEPTED_EXECUTABLE = new Set(["new", "reset"]);

const COMMAND_TIER_ESSENTIAL = new Set([
  "new", "reset", "stop", "compact", "compress", "model", "think", "thinking",
  "status", "skill", "agents", "help", "commands", "usage", "queue", "background",
]);

const COMMAND_TIER_POWER = new Set([
  "bash", "exec", "config", "mcp", "plugins", "debug", "login", "crestodian",
  "allowlist", "acp", "activation", "send", "restart", "yolo", "approvals",
  "egress", "platform", "update", "rollback", "reload-mcp", "reload-skills",
  "curator", "topup", "insights", "diagnostics", "trace", "trajectory",
  "export-trajectory",
]);

const COMMAND_DESTRUCTIVE = new Set([
  "bash", "exec", "reset", "new", "compact", "compress",
  "rollback", "undo", "restart", "yolo", "update", "pause", "delete",
]);

function normalizeCommandName(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .replace(/^\/+/, "")
    .replace(/_/g, "-")
    .toLowerCase();
}

function commandTierFor(normalizedName, category) {
  if (COMMAND_TIER_POWER.has(normalizedName)) return "power";
  if (COMMAND_TIER_ESSENTIAL.has(normalizedName)) return "essential";
  if (category === "management") return "power";
  return "standard";
}

function commandExecutesFor(backendKind) {
  return COMMAND_EXECUTES_BY_BACKEND.get(backendKind) || "intercepted-only";
}

function clampCommandDescription(raw) {
  const text = String(raw == null ? "" : raw)
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
  return text.length > COMMAND_DESCRIPTION_MAX_CHARS
    ? text.slice(0, COMMAND_DESCRIPTION_MAX_CHARS)
    : text;
}

function normalizeCommandArg(arg) {
  const name = typeof arg.name === "string" ? arg.name.trim() : "";
  if (!name) return null;
  const choices = Array.isArray(arg.choices)
    ? arg.choices
        .map((choice) =>
          typeof choice === "string"
            ? choice
            : choice && typeof choice === "object" && typeof choice.value === "string"
              ? choice.value
              : "",
        )
        .filter(Boolean)
    : [];
  const out = { name, required: arg.required === true, dynamic: arg.dynamic === true };
  if (typeof arg.description === "string" && arg.description.trim()) {
    Object.assign(out, { description: arg.description.trim() });
  }
  if (typeof arg.type === "string" && arg.type) Object.assign(out, { type: arg.type });
  if (choices.length) Object.assign(out, { choices });
  return out;
}

function deriveCommandArgsHint(args) {
  if (!Array.isArray(args) || !args.length) return "";
  const parts = [];
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const name = typeof arg.name === "string" ? arg.name.trim() : "";
    if (!name) continue;
    parts.push(arg.required === true ? `<${name}>` : `[${name}]`);
  }
  return parts.join(" ");
}

function normalizeCommandCatalogRows(rows, backendKind, executes) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  const executesAll = executes === "all";
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const name = String(row.name == null ? "" : row.name)
      .trim()
      .replace(/^\/+/, "")
      .trim();
    if (!name) continue;
    const key = normalizeCommandName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const category =
      typeof row.category === "string" && row.category.trim()
        ? row.category.trim()
        : "";
    const acceptsArgs = row.acceptsArgs === true;
    const entry = {
      name,
      description: clampCommandDescription(row.description),
      source:
        row.source === "skill" || row.source === "plugin" ? row.source : "native",
      instantSend: acceptsArgs === false,
      noTrailingSpace: row.noTrailingSpace === true,
      tier: commandTierFor(key, category),
      destructive: COMMAND_DESTRUCTIVE.has(key),
      availability: row.availability === "busy-blocked" ? "busy-blocked" : "ready",
      executable: executesAll ? true : COMMAND_INTERCEPTED_EXECUTABLE.has(key),
    };
    if (category) Object.assign(entry, { category });

    const aliases = [];
    const aliasSeen = new Set([key]);
    const rawAliases = Array.isArray(row.textAliases)
      ? row.textAliases
      : Array.isArray(row.aliases)
        ? row.aliases
        : [];
    for (const rawAlias of rawAliases) {
      const alias = String(rawAlias == null ? "" : rawAlias)
        .trim()
        .replace(/^\/+/, "")
        .trim();
      if (!alias) continue;
      const aliasKey = normalizeCommandName(alias);
      if (!aliasKey || aliasSeen.has(aliasKey)) continue;
      aliasSeen.add(aliasKey);
      aliases.push(alias);
      if (aliases.length >= COMMAND_MAX_ALIASES) break;
    }
    if (aliases.length) Object.assign(entry, { aliases });

    const args = Array.isArray(row.args)
      ? row.args
          .filter((arg) => arg && typeof arg === "object")
          .map(normalizeCommandArg)
          .filter(Boolean)
      : [];
    const argsHintRaw =
      typeof row.argsHint === "string" && row.argsHint.trim()
        ? row.argsHint.trim()
        : deriveCommandArgsHint(args);
    if (argsHintRaw) {
      Object.assign(entry, {
        argsHint:
          argsHintRaw.length > COMMAND_ARGS_HINT_MAX_CHARS
            ? argsHintRaw.slice(0, COMMAND_ARGS_HINT_MAX_CHARS)
            : argsHintRaw,
      });
    }
    if (args.length) Object.assign(entry, { args });

    out.push(entry);
    if (out.length >= COMMAND_CATALOG_MAX_ENTRIES) break;
  }

  if (JSON.stringify(out).length > COMMAND_SNAPSHOT_MAX_BYTES) {
    for (const entry of out) Reflect.deleteProperty(entry, "args");
  }
  return out;
}

function commandCatalogRowsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] || {};
    const b = right[i] || {};
    if (
      a.name !== b.name ||
      a.description !== b.description ||
      a.tier !== b.tier ||
      a.instantSend !== b.instantSend ||
      a.argsHint !== b.argsHint ||
      a.executable !== b.executable
    ) {
      return false;
    }
  }
  return true;
}

function isMethodNotFoundError(err, message) {
  if (err && typeof err === "object") {
    const code = err.code ?? (err.error && err.error.code);
    if (code === -32601) return true;
  }
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return (
    text.includes("method not found") ||
    text.includes("unknown method") ||
    text.includes("no such method") ||
    text.includes("not supported")
  );
}

const AGENT_DESCRIPTION_MAX_CHARS = 500;

function normalizeAgentsCatalogRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const identity =
      row.identity && typeof row.identity === "object" ? row.identity : {};
    const identityName =
      typeof identity.name === "string" && identity.name.trim()
        ? identity.name.trim()
        : "";
    const baseName =
      typeof row.name === "string" && row.name.trim() ? row.name.trim() : "";
    const name = identityName || baseName || id;
    const emoji =
      typeof identity.emoji === "string" && identity.emoji.trim()
        ? identity.emoji.trim()
        : null;
    const model = row.model && typeof row.model === "object" ? row.model : {};
    const primaryModel =
      typeof model.primary === "string" && model.primary.trim()
        ? model.primary.trim()
        : null;

    const avatar = typeof identity.avatar === "string" &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(identity.avatar) &&
      identity.avatar.length <= 175000 ? identity.avatar : null;
    const appearance = emoji ? null : normalizeAgentAppearance(identity.appearance);

    const description = typeof row.description === "string" && row.description.trim()
      ? row.description.trim().slice(0, AGENT_DESCRIPTION_MAX_CHARS)
      : "";
    out.push({ id, name, emoji, primaryModel, ...(avatar ? { avatarDataUri: avatar } : {}),
      ...(appearance ? { appearance } : {}),
      ...(description ? { description } : {}),
      ...(description && row.descriptionAuto === true ? { descriptionAuto: true } : {}) });
  }
  return out;
}

const WORKSPACE_IDENTITY_FILENAME = "IDENTITY.md";

const AGENT_BOOTSTRAP_RUN_START_PROBE_DELAY_MS = 3000;

const UPSTREAM_DEFAULT_IDENTITY_NAME = "Assistant";

const IDENTITY_PLACEHOLDER_VALUES = new Set([
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature - pick one that feels right",
  "workspace-relative path, http(s) url, or data uri",
]);

const IDENTITY_LABELS = new Set([
  "name",
  "emoji",
  "creature",
  "vibe",
  "theme",
  "avatar",
]);

function stripIdentityMarkup(value) {
  let s = String(value == null ? "" : value).trim();
  s = s.replace(/^[*_`\s]+|[*_`\s]+$/g, "").trim();
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
  return s;
}

function normalizeIdentityLabel(raw) {
  return raw.replace(/[*_`]/g, "").trim().toLowerCase();
}

function isIdentityPlaceholder(value) {
  const normalized = String(value == null ? "" : value)
    .replace(/[*_`()]/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return IDENTITY_PLACEHOLDER_VALUES.has(normalized);
}

function looksLikeIdentityLabelLine(line) {
  const cleaned = String(line).trim().replace(/^[-*]\s*/, "");
  const colon = cleaned.indexOf(":");
  if (colon === -1) return false;
  return IDENTITY_LABELS.has(normalizeIdentityLabel(cleaned.slice(0, colon)));
}

const MAX_IDENTITY_NAME = 50;
const MAX_IDENTITY_EMOJI = 16;

function hasMeaningfulIdentityChars(value) {
  return /[A-Za-z]/.test(value) || /[^\x00-\x7F]/.test(value);
}

function normalizeFallbackEmoji(value) {
  const trimmed = stripIdentityMarkup(value);
  if (!trimmed || trimmed.length > MAX_IDENTITY_EMOJI) return null;
  if (trimmed.includes("/") || trimmed.includes("://")) return null;
  let hasNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  return hasNonAscii ? trimmed : null;
}

function parseWorkspaceIdentityFallback(content) {
  const result = {};
  if (typeof content !== "string" || !content) return result;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const cleaned = lines[i].trim().replace(/^[-*]\s*/, "");
    const colon = cleaned.indexOf(":");
    if (colon === -1) continue;
    const label = normalizeIdentityLabel(cleaned.slice(0, colon));
    if (label !== "name" && label !== "emoji") continue;
    let value = stripIdentityMarkup(cleaned.slice(colon + 1));
    if (!value) {

      for (let j = i + 1; j < lines.length; j += 1) {
        const peek = lines[j].trim();
        if (!peek) continue;
        if (peek.startsWith("#")) break;
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(peek)) break;
        if (looksLikeIdentityLabelLine(peek)) break;
        value = stripIdentityMarkup(peek);
        break;
      }
    }
    if (!value || isIdentityPlaceholder(value)) continue;
    if (label === "name") {
      if (!hasMeaningfulIdentityChars(value)) continue;
      if (!result.name) {
        result.name =
          value.length > MAX_IDENTITY_NAME ? value.slice(0, MAX_IDENTITY_NAME) : value;
      }
    } else if (label === "emoji") {
      const normalized = normalizeFallbackEmoji(value);
      if (normalized && !result.emoji) result.emoji = normalized;
    }
  }
  return result;
}

function applyIdentityFallback(identity, fallback) {
  const name = identity && identity.name ? identity.name : null;
  const emoji = identity && identity.emoji ? identity.emoji : null;
  if (!fallback || (!fallback.name && !fallback.emoji)) return { name, emoji };

  const needName = !name || (name === UPSTREAM_DEFAULT_IDENTITY_NAME && !emoji);
  const needEmoji = !emoji;
  return {
    name: needName && fallback.name ? fallback.name : name,
    emoji: needEmoji && fallback.emoji ? fallback.emoji : emoji,
  };
}

function rawRowNameUnresolved(row) {
  const identity =
    row.identity && typeof row.identity === "object" ? row.identity : null;
  const hasIdentityName =
    identity && typeof identity.name === "string" && identity.name.trim();
  const hasBaseName = typeof row.name === "string" && row.name.trim();
  return !hasIdentityName && !hasBaseName;
}

function rawRowEmojiUnresolved(row) {
  const identity =
    row.identity && typeof row.identity === "object" ? row.identity : null;
  return !(
    identity &&
    typeof identity.emoji === "string" &&
    identity.emoji.trim()
  );
}

function rawRowNeedsIdentityFallback(row) {
  if (!row || typeof row !== "object") return false;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return false;
  return rawRowNameUnresolved(row) || rawRowEmojiUnresolved(row);
}

function lookupIdentityFallback(fallbackByAgentId, id) {
  if (!fallbackByAgentId) return null;
  if (typeof fallbackByAgentId.get === "function") {
    return fallbackByAgentId.get(id) || null;
  }
  return fallbackByAgentId[id] || null;
}

function overlayRawAgentRowsWithFallback(rows, fallbackByAgentId) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) return row;
    const fallback = lookupIdentityFallback(fallbackByAgentId, id);
    if (!fallback || (!fallback.name && !fallback.emoji)) return row;
    const fillName = rawRowNameUnresolved(row) && fallback.name;
    const fillEmoji = rawRowEmojiUnresolved(row) && fallback.emoji;
    if (!fillName && !fillEmoji) return row;
    const identity =
      row.identity && typeof row.identity === "object" ? row.identity : {};
    return {
      ...row,
      identity: {
        ...identity,
        ...(fillName ? { name: fallback.name } : {}),
        ...(fillEmoji ? { emoji: fallback.emoji } : {}),
      },
    };
  });
}

function createUpstreamRuntime(opts = {}) {
  const logger = normalizeLogger(opts.logger);
  const gatewayBridge = opts.gatewayBridge;
  const conversationState = opts.conversationState;
  const sessionService = opts.sessionService;
  const handler = opts.handler;
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const operationRegistry = opts.operationRegistry || null;

  const runtimeOpts      = opts;
  const noteRunOutcomeFrame =
    typeof runtimeOpts.noteRunOutcomeFrame === "function" ? runtimeOpts.noteRunOutcomeFrame : null;

  const noteCardBuildRunSignal =
    typeof runtimeOpts.noteCardBuildRunSignal === "function" ? runtimeOpts.noteCardBuildRunSignal : null;

  const noteCardBuildReasoning =
    typeof runtimeOpts.noteCardBuildReasoning === "function" ? runtimeOpts.noteCardBuildReasoning : null;
  const noteCardBuildAgentNote =
    typeof runtimeOpts.noteCardBuildAgentNote === "function" ? runtimeOpts.noteCardBuildAgentNote : null;

  const noteCardBuildFinalReply =
    typeof runtimeOpts.noteCardBuildFinalReply === "function" ? runtimeOpts.noteCardBuildFinalReply : null;

  const noteCardBuildLateReply =
    typeof runtimeOpts.noteCardBuildLateReply === "function" ? runtimeOpts.noteCardBuildLateReply : null;

  const noteCardBuildOffSessionActivity =
    typeof runtimeOpts.noteCardBuildOffSessionActivity === "function" ? runtimeOpts.noteCardBuildOffSessionActivity : null;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  const approvalExplainer =
    runtimeOpts.approvalExplainer && typeof runtimeOpts.approvalExplainer.explain === "function"
      ? runtimeOpts.approvalExplainer
      : null;

  const approvalsAwaitingExplanation      = new Set();

  const liveUiV2Trace = (event        , data     ) =>
    emitDebug("glasses.lifecycle", event, "debug", { sessionKey: data && data.sessionKey }, () => data);

  let liveUiV2Sender      = null;

  const liveUiV2State = createLiveUiSurfaceState({
    nowMs: runtimeOpts.liveUiV2FloorClock && typeof runtimeOpts.liveUiV2FloorClock.nowMs === "function"
      ? runtimeOpts.liveUiV2FloorClock.nowMs
      : undefined,
    trace: liveUiV2Trace,

    authoredState: (sessionKey        , surfaceId        ) =>
      typeof liveUiV2Surfaces.modelState === "function" ? liveUiV2Surfaces.modelState(sessionKey, surfaceId) : null,
    onShown: (sessionKey        , surfaceId        , name        , value                 ) => {
      if (typeof liveUiV2Surfaces.noteModelShownState === "function") {
        liveUiV2Surfaces.noteModelShownState(sessionKey, surfaceId, name, value);
      }
    },

    rowRefs: (sessionKey        , surfaceId        ) => {
      const surface = typeof liveUiV2Surfaces.getSurface === "function" ? liveUiV2Surfaces.getSurface(sessionKey, surfaceId) : null;
      return surface ? liveUiRowNames(surface.spec) : null;
    },
  });

  const liveUiPictureContext      = runtimeOpts.liveUiPictureContext || null;
  const liveUiWearerRuns = new Set        ();

  const liveUiModelSiteRuns = new Map                ();
  const liveUiComposeReach = new Map                ();
  function rememberLiveUiRun(store                                   , runId        , reach         ) {
    if (store instanceof Map) store.set(runId, reach || "hosts");
    else store.add(runId);

    if (store.size > 256) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
  }

  const LIVEUI_MEDIA_CONTINUATION_TOOLS = new Set(["image_generate", "video_generate", "music_generate"]);
  const LIVEUI_MEDIA_CONTINUATION_MS = 15 * 60 * 1000;
  const liveUiMediaContinuations = new Map                ();
  function noteLiveUiMediaContinuation(data     )       {
    if (!data || typeof data.runId !== "string" || !data.runId || typeof data.sessionKey !== "string") return;
    const session = liveUiV2Key(data.sessionKey);
    if (typeof data.tool === "string" && LIVEUI_MEDIA_CONTINUATION_TOOLS.has(data.tool)) {
      if (liveUiWearerRuns.has(data.runId)) {
        liveUiMediaContinuations.set(`${session}\u0000${data.tool}`, now() + LIVEUI_MEDIA_CONTINUATION_MS);
        if (liveUiMediaContinuations.size > 64) {
          const oldest = liveUiMediaContinuations.keys().next().value;
          if (oldest !== undefined) liveUiMediaContinuations.delete(oldest);
        }
      }
      return;
    }
    if (data.origin !== "lifecycle" || data.phase !== "start" || liveUiWearerRuns.has(data.runId)) return;
    const tool = data.runId.slice(0, Math.max(0, data.runId.indexOf(":")));
    if (!LIVEUI_MEDIA_CONTINUATION_TOOLS.has(tool)) return;
    const key = `${session}\u0000${tool}`;
    const until = liveUiMediaContinuations.get(key);
    if (until === undefined) return;
    liveUiMediaContinuations.delete(key);
    if (now() <= until) rememberLiveUiRun(liveUiWearerRuns, data.runId);
  }

  function liveUiWearerRunOpen(key        )          {
    return [...upstreamRunPipeline.values()].some(
      (entry     ) => entry && entry.sessionKey && liveUiV2Key(entry.sessionKey) === key && liveUiWearerRuns.has(entry.runId),
    );
  }

  let liveUiRunlessReplyKey                = null;
  function liveUiPictureReach(runId     , sessionKey         )                     {
    const id = typeof runId === "string" ? runId : "";
    const runlessReply = !id && typeof sessionKey === "string" && sessionKey === liveUiRunlessReplyKey;
    const reach = runlessReply
      ? (liveUiWearerRunOpen(sessionKey) ? "wearer" : "hosts")
      : id && (liveUiWearerRuns.has(id) ? "wearer" : liveUiComposeReach.get(id) || "hosts");
    if (reach !== "wearer") return "hosts";
    const open = liveUiPictureContext && typeof liveUiPictureContext.wearerReachOpen === "function"
      ? liveUiPictureContext.wearerReachOpen() !== false : true;
    return open ? "wearer" : "hosts";
  }

  const liveUiVideo = liveUiPictureContext
    ? (runtimeOpts.liveUiVideoService || createLiveUiVideoService({
      trace: liveUiV2Trace,
      speed: () => typeof liveUiPictureContext.videoSpeed !== "function" || liveUiPictureContext.videoSpeed() !== false,
      size: () => (typeof liveUiPictureContext.videoSize === "function" ? liveUiPictureContext.videoSize() : null),

      onTitle: () => {
        if (typeof liveUiV2Surfaces.refreshPictureTitles === "function") liveUiV2Surfaces.refreshPictureTitles();
      },

      onMetadata: () => {
        if (liveUiPictures && typeof liveUiPictures.refreshVideoMetadata === "function") liveUiPictures.refreshVideoMetadata();
      },

      onToolsNeeded: (need) => {
        const server = getServer();
        if (server) server.broadcast(JSON.stringify({ type: "ocuclaw.liveui.video_tools", missing: need.missing, update: need.update }));
      },
    }))
    : null;
  const liveUiPictureModels = createPictureModels();

  const isProgramCardPictureKey = (key     ) => typeof key === "string" && key.startsWith("card:");
  const liveUiPictures      = liveUiPictureContext
    ? createLiveUiPictureService({
      video: liveUiVideo,
      videoHostCheck: () => (typeof liveUiPictureContext.hostCheck === "function" ? liveUiPictureContext.hostCheck() : null),
      async resolve(src        , reach     , ctx     ) {

        const scope = isProgramCardPictureKey(ctx.sessionKey)
          ? { roots: [], filesAllowed: false }
          : typeof liveUiPictureContext.fileScope === "function"
            ? await liveUiPictureContext.fileScope(ctx.sessionKey)
            : { roots: [], filesAllowed: false };
        return createPictureResolver({
          httpEnabled: () => typeof liveUiPictureContext.httpEnabled === "function" && liveUiPictureContext.httpEnabled() === true,
          hostCheck: () => (typeof liveUiPictureContext.hostCheck === "function" ? liveUiPictureContext.hostCheck() : null),
          roots: () => (scope && Array.isArray(scope.roots) ? scope.roots : []),
          filesAllowed: () => !!(scope && scope.filesAllowed),
          video: liveUiVideo,
          trace: liveUiV2Trace,

          models: liveUiPictureModels,
          modelSites: runtimeOpts.modelSites || null,

          ...(typeof runtimeOpts.liveUiPictureFetch === "function" ? { fetch: runtimeOpts.liveUiPictureFetch } : {}),
        })(src, reach, ctx);
      },
      sendToClient(clientId        , frame     ) {
        const server = getServer();
        if (server && typeof server.unicast === "function") server.unicast(clientId, JSON.stringify(frame));
      },
      dropLine(sessionKey        , text        ) {

        if (isProgramCardPictureKey(sessionKey)) return;
        if (typeof liveUiV2Surfaces.noteDropLine === "function") liveUiV2Surfaces.noteDropLine(sessionKey, text);
      },
      trace: liveUiV2Trace,

      ...(runtimeOpts.liveUiPictureClock || {}),
      ...(runtimeOpts.liveUiPictureLimits ? { limits: runtimeOpts.liveUiPictureLimits } : {}),
    })
    : null;
  function notePictureRevision(revision     ) {
    if (!liveUiPictures || !revision || typeof revision.sessionKey !== "string") return;
    const { sessionKey, surfaceId } = revision;
    if (revision.withdrawn) {
      liveUiPictures.noteSurfaceGone(sessionKey, surfaceId);
    } else {
      liveUiPictures.noteSurface(sessionKey, surfaceId, {
        reach: liveUiPictureReach(revision.runId, sessionKey),
        modelSitesAllowed: liveUiModelSiteRuns.get(revision.runId) === liveUiV2Key(sessionKey),
        sources: Array.isArray(revision.pictures) ? revision.pictures : [],
      });

      if (!revision.streaming && revision.replaces) liveUiPictures.noteSurfaceGone(sessionKey, revision.replaces);
    }

    if (revision.streaming) liveUiPictures.noteRecordActivity(sessionKey);
    else liveUiPictures.noteSettled(sessionKey);
  }

  const PROGRAM_CARD_PICTURE_SURFACES_PER_CLIENT = 8;
  const programCardPictureSurfaces = new Map

   ();
  function sendProgramCardPictureFailed(clientId        , surfaceId        , id        , code        , large = false) {
    const server = getServer();
    if (!server || typeof server.unicast !== "function") return;
    server.unicast(clientId, JSON.stringify({
      type: "liveui_picture", surfaceId, id, status: "failed", code, ...(large ? { large: true } : {}),
    }));
  }
  function closeProgramCardPictureSurface(surfaceId        , reason        ) {
    const entry = programCardPictureSurfaces.get(surfaceId);
    if (!entry) return;
    programCardPictureSurfaces.delete(surfaceId);
    if (liveUiPictures) liveUiV2Step("card_pictures_closed", entry.key, () => liveUiPictures.noteSurfaceGone(entry.key, surfaceId));
    liveUiV2Trace("program_card_pictures_closed", { sessionKey: entry.sessionKey, surfaceId, reason });
  }

  function openProgramCardPictures(clientId     , clientSession     , admitted     ) {
    if (typeof clientId !== "string" || !clientId || !admitted || admitted.op !== "open" || typeof admitted.sub !== "string") return;
    const surfaceId = programCardPictureSurfaceId(admitted.sub);
    const sessionKey = typeof clientSession === "string" && clientSession ? clientSession : "main";
    const key = `card:${liveUiV2Key(sessionKey)}`;
    const existing = programCardPictureSurfaces.get(surfaceId);
    if (existing && existing.clientId !== clientId) {
      liveUiV2Trace("program_card_pictures_ignored", { sessionKey, surfaceId, reason: "other_client" });
      return;
    }
    const accepted = (Array.isArray(admitted.pictures) ? admitted.pictures : []).filter(
      (p     ) => p && typeof p.id === "string" && typeof p.src === "string",
    );
    const refused = new Map                ();
    for (const r of Array.isArray(admitted.refused) ? admitted.refused : []) {
      if (r && typeof r.id === "string") refused.set(r.id, typeof r.code === "string" ? r.code : "picture_source_refused");
    }

    if (!liveUiPictures) for (const p of accepted) refused.set(p.id, "picture_source_refused");
    const fetched = liveUiPictures ? accepted : [];

    if (existing && existing.key !== key && liveUiPictures) {
      liveUiV2Step("card_pictures_moved", existing.key, () => liveUiPictures.noteSurfaceGone(existing.key, surfaceId));
    }
    programCardPictureSurfaces.delete(surfaceId);

    const mine = [...programCardPictureSurfaces.entries()].filter(([, entry]) => entry.clientId === clientId);
    while (mine.length >= PROGRAM_CARD_PICTURE_SURFACES_PER_CLIENT) {
      closeProgramCardPictureSurface((mine.shift()       )[0], "evicted");
    }
    const card = typeof admitted.card === "string" ? admitted.card.slice(0, 64) : "";
    programCardPictureSurfaces.set(surfaceId, { clientId, sessionKey, key, card, refused });
    if (liveUiPictures) {

      const reach = liveUiPictureContext && typeof liveUiPictureContext.wearerReachOpen === "function"
        && liveUiPictureContext.wearerReachOpen() === false ? "hosts" : "wearer";
      liveUiV2Step("card_pictures_opened", key, () => liveUiPictures.noteSurface(key, surfaceId, {
        reach,
        modelSitesAllowed: false,
        sources: fetched.map((p     ) => ({ id: p.id, src: p.src, componentId: typeof p.name === "string" ? p.name : p.id, eager: true })),
      }));
    }

    for (const [id, code] of refused) sendProgramCardPictureFailed(clientId, surfaceId, id, code);
    liveUiV2Trace("program_card_pictures_opened", {
      sessionKey, surfaceId, card, pictures: fetched.length, refused: refused.size, ...(existing ? { replaced: true } : {}),
    });
  }
  const liveUiV2Surfaces =
    runtimeOpts.liveUiV2Surfaces ||
    createLiveUiSurfaceRevisions({
      trace: liveUiV2Trace,

      decidedFrame: (sessionKey        , runId               ) =>
        runId && typeof runtimeOpts.liveUiV2DecidedFrame === "function"
          ? runtimeOpts.liveUiV2DecidedFrame(sessionKey, runId) || null
          : null,

      decidedIcon: (sessionKey        , runId               ) =>
        runId && typeof runtimeOpts.liveUiV2DecidedIcon === "function"
          ? runtimeOpts.liveUiV2DecidedIcon(sessionKey, runId) || null
          : null,

      askedWords: (sessionKey        , runId               ) =>
        runId && typeof runtimeOpts.liveUiV2AskedWords === "function"
          ? runtimeOpts.liveUiV2AskedWords(sessionKey, runId) || null
          : null,

      pictureTitle: (src        ) => (liveUiVideo ? liveUiVideo.titleFor(src) : null),

      pictureFallback: replyPictureFallbackRecords,
      onSurfaceEnded: (sessionKey        , surfaceId        ) => {
        if (liveUiPictures) liveUiV2Step("pictures_ended", sessionKey, () => liveUiPictures.noteSurfaceGone(sessionKey, surfaceId));
      },
      onRevision: (revision     ) => {
        if (typeof runtimeOpts.onLiveUiRevision === "function") runtimeOpts.onLiveUiRevision(revision);
        if (revision && typeof revision.sessionKey === "string" && typeof revision.surfaceId === "string") {
          liveUiV2State.noteSurface(revision.sessionKey, revision.surfaceId);
        }
        liveUiV2Step("pictures", revision && revision.sessionKey, () => notePictureRevision(revision));
        if (!liveUiV2Sender) return;
        try {
          liveUiV2Sender.onRevision(revision);
        } catch (err) {
          emitDebug("glasses.lifecycle", "liveui_v2_send_error", "warn", { sessionKey: revision && revision.sessionKey }, () => ({
            surfaceId: revision && revision.surfaceId,
            specRev: revision && revision.specRev,
            error: err && (err       ).message ? (err       ).message : String(err),
          }));
        }
      },
    });
  liveUiV2Sender = createLiveUiSurfaceSender({
    surfaces: liveUiV2Surfaces,
    getServer: () => getServer(),

    sessionContext:
      typeof runtimeOpts.liveUiV2SessionContext === "function" ? runtimeOpts.liveUiV2SessionContext : undefined,
    isUnderBackpressure:
      typeof runtimeOpts.isGlassesUnderBackpressure === "function" ? runtimeOpts.isGlassesUnderBackpressure : undefined,
    trace: liveUiV2Trace,

    seedFor: (surfaceId        ) => {
      const hit = liveUiV2State.cached(surfaceId);
      return hit ? { ...hit.report } : null;
    },

    ...(runtimeOpts.liveUiV2FloorClock || {}),
  });
  const liveUiV2Key = (sessionKey     ) => relaySessionKeyFor(sessionKey) || sessionKey;

  function liveUiV2Step(step        , sessionKey     , fn            ) {
    try {
      fn();
    } catch (err) {
      emitDebug("glasses.lifecycle", "liveui_v2_engine_error", "warn", { sessionKey }, () => ({
        step,
        error: err && (err       ).message ? (err       ).message : String(err),
      }));
    }
  }

  const liveUiV2CompactionCounts = new Map();

  const liveUiV2CompactionsNoted = new Set();

  let composeCallCounter = 0;
  function composeLiveUiV2Records(sessionKey     , input      = {}) {
    const key = liveUiV2Key(sessionKey);
    const text = input && typeof input.records === "string" ? input.records : "";

    const inputKeys =
      input && Array.isArray(input.inputKeys)
        ? input.inputKeys.filter((name     ) => typeof name === "string")
        : input && Array.isArray(input.inputs)
          ? input.inputs.map((entry     ) => entry && entry.key).filter((name     ) => typeof name === "string")
          : null;
    const check = inputKeys ? liveUiV2Surfaces.checkText(key, text, { inputs: inputKeys }) : liveUiV2Surfaces.checkText(key, text);

    const values = input && input.values && typeof input.values === "object" && !Array.isArray(input.values) ? input.values : null;
    const validateOnly = Boolean(input && input.validateOnly === true);
    emitDebug("glasses.lifecycle", "liveui_v2_compose_call", "debug", { sessionKey: key }, () => ({
      callId: input && typeof input.callId === "string" ? input.callId : null,
      validateOnly,
      ok: check.ok,
      mode: check.mode,
      placed: check.placed.length,
      notes: check.notes.length,
      reason: check.reason,
    }));
    if (validateOnly) return { ...check, painted: false, surfaceId: null, specRev: null };
    composeCallCounter += 1;
    const callId = input && typeof input.callId === "string" && input.callId ? input.callId : `n${composeCallCounter}`;
    const runId = `compose:${callId}`;

    rememberLiveUiRun(liveUiComposeReach, runId, liveUiWearerRunOpen(key) ? "wearer" : "hosts");
    if (!check.ok) {

      const refreshing = input && Array.isArray(input.inputs) && input.inputs.length > 0;
      if (check.mode === "text" && !refreshing && liveUiV2Engine("noteUnframed")) {
        liveUiV2Step("compose_unframed", key, () => liveUiV2Surfaces.noteUnframed(key, { runId, text }));
      }
      return { ...check, painted: false, surfaceId: null, specRev: null };
    }

    let seed      = null;
    if (check.mode === "new" && input && Array.isArray(input.inputs) && input.inputs.length > 0) {
      const valid = validateLiveUiInputs(input.inputs);
      let filled = valid.ok && values ? fillLiveUiInputs(valid.inputs, values) : null;
      if (valid.ok && (!filled || !filled.ok)) filled = fillLiveUiInputs(valid.inputs, null);
      if (valid.ok && filled && filled.ok) {
        seed = { inputs: valid.inputs, data: filled.data, loading: filled.loading, origin: "agent", passive: false };
      }
    } else if (
      check.mode === "patch" &&
      check.target &&
      input &&
      Array.isArray(input.inputs) &&
      input.inputs.length > 0
    ) {

      const meta = liveUiV2Engine("surfaceMeta") ? (liveUiV2Surfaces       ).surfaceMeta(key, check.target) : null;
      const byKey = new Map(input.inputs.map((entry     ) => [entry && entry.key, entry]));
      const held = meta && Array.isArray(meta.inputs) ? meta.inputs : [];
      const heldKeys = new Set(held.map((entry     ) => entry.key));
      const merged = [
        ...held.map((entry     ) => byKey.get(entry.key) || entry),
        ...input.inputs.filter((entry     ) => !heldKeys.has(entry && entry.key)),
      ];
      const set = setLiveUiV2Inputs(sessionKey, check.target, merged, values);
      if (values && (!set || set.ok !== true)) {

        setLiveUiV2Inputs(sessionKey, check.target, merged, null);
      }
    }
    let revision      = null;
    liveUiV2Step("compose", key, () => {

      revision = liveUiV2Surfaces.commitText(key, { runId, text, viaTool: true, ...(seed ? { seed } : {}) });
    });
    return {
      ...check,
      painted: !!(revision && !revision.withdrawn),

      surfaceId: revision ? revision.surfaceId : check.mode === "patch" ? check.target : null,
      specRev: revision ? revision.specRev : null,
    };
  }

  function liveUiV2Engine(name        )      {
    return liveUiV2Surfaces && typeof (liveUiV2Surfaces       )[name] === "function" ? liveUiV2Surfaces : null;
  }

  function prefetchLiveUiV2Picture(sessionKey     , surfaceId     , src     , componentId     ) {
    if (!liveUiPictures || typeof liveUiPictures.prefetch !== "function" || typeof surfaceId !== "string" || typeof src !== "string") {
      return Promise.resolve({ ok: true });
    }
    const key = liveUiV2Key(sessionKey);
    return liveUiPictures.prefetch(key, surfaceId, { src, componentId: typeof componentId === "string" ? componentId : "" }, "hosts");
  }

  function writeLiveUiV2Data(sessionKey     , surfaceId     , patch     ) {
    const engine = liveUiV2Engine("writeData");
    if (!engine || typeof surfaceId !== "string") return { ok: false, reason: "surface_gone" };
    let result      = { ok: false, reason: "surface_gone" };
    liveUiV2Step("write_data", sessionKey, () => {
      result = engine.writeData(liveUiV2Key(sessionKey), surfaceId, patch, { cause: "tick" });
    });
    return result;
  }

  function setLiveUiV2Inputs(sessionKey     , surfaceId     , inputs     , values     ) {
    const engine = liveUiV2Engine("setInputs");
    if (!engine || typeof surfaceId !== "string") return { ok: false, reason: "surface_gone" };
    let result      = { ok: false, reason: "surface_gone" };
    liveUiV2Step("set_inputs", sessionKey, () => {
      result = engine.setInputs(liveUiV2Key(sessionKey), surfaceId, inputs, values || undefined);
    });
    return result;
  }

  function isLiveUiV2SurfaceLive(sessionKey     , surfaceId     ) {
    const engine = liveUiV2Engine("isLive");
    return !!engine && typeof surfaceId === "string" && engine.isLive(liveUiV2Key(sessionKey), surfaceId) === true;
  }

  function liveUiV2TopSurface(sessionKey     , opts      = null) {
    const key = liveUiV2Key(sessionKey);
    const keys = opts && Array.isArray(opts.refreshKeys) ? opts.refreshKeys : null;
    const target = keys && liveUiV2Engine("refreshTarget") ? liveUiV2Surfaces.refreshTarget(key, keys) : undefined;
    const surfaceId = target === undefined ? liveUiV2Surfaces.patchTarget(key) : target ? target.surfaceId : null;
    if (!surfaceId) return null;
    const snapshot = liveUiV2Surfaces.getSurface(key, surfaceId);
    const meta = liveUiV2Engine("surfaceMeta") ? (liveUiV2Surfaces       ).surfaceMeta(key, surfaceId) : null;
    const pending = target && target.kind !== "top" ? target.kind : null;
    const spec = snapshot ? snapshot.committedSpec || (pending ? snapshot.spec : null) : null;
    if (!snapshot || (!spec && !pending)) return null;
    return {
      surfaceId,
      spec,
      ...(pending ? { pending } : {}),
      inputs: meta ? meta.inputs : null,
      data: meta ? meta.data : spec ? { ...spec.data } : {},

      pictureSources: meta && meta.pictureSources ? meta.pictureSources : {},

      reads: spec ? [...liveUiSpecDataKeys(spec)] : [],
      origin: meta ? meta.origin : "agent",
      passive: meta ? meta.passive === true : false,
    };
  }

  let openCallCounter = 0;
  function openLiveUiV2Records(sessionKey     , input      = {}) {
    const key = liveUiV2Key(sessionKey);
    const text = input && typeof input.records === "string" ? input.records : "";
    const origin = isLiveUiSurfaceOrigin(input && input.origin) ? input.origin : "agent";
    const passive = !!(input && input.passive === true);
    const refuse = (reason        , notes        = [], extra                          = {}) => {
      liveUiV2Trace("liveui_v2_open_refused", { sessionKey: key, origin, passive, reason, ...extra });
      return { ok: false, painted: false, surfaceId: null, specRev: null, notes, reason, ...extra };
    };
    const check = liveUiV2Surfaces.checkText(key, text);
    if (!check.ok) return refuse(check.reason || "nothing_placed", check.notes);
    if (check.mode !== "new") return refuse("not_new_surface", check.notes);
    let inputs      = null;
    if (input && input.inputs !== undefined && input.inputs !== null) {
      const valid = validateLiveUiInputs(input.inputs);
      if (!valid.ok) return refuse("inputs_invalid", check.notes, { code: valid.code, detail: valid.message });
      inputs = valid.inputs;
    }

    const wearer = (input && input.wearer === true) || liveUiWearerRunOpen(key);
    const values = input && input.values && typeof input.values === "object" ? input.values : null;
    const filled = fillLiveUiInputs(inputs || [], values, {}, { assets: true, files: wearer });
    if (!filled.ok) {
      const code = filled.reason === "unknown_key" ? "unknown_key" : filled.code;
      return refuse("inputs_invalid", check.notes, { code, key: filled.key });
    }

    const assets                         = {};
    if (input && input.assets && typeof input.assets === "object" && !Array.isArray(input.assets)) {
      for (const [name, bytes] of Object.entries(input.assets)) if (typeof bytes === "string") assets[name] = bytes;
    }

    const more                         = {};
    if (input && input.more && typeof input.more === "object" && !Array.isArray(input.more)) {
      for (const [k, n] of Object.entries(input.more)) {
        const declared = (inputs || []).find((entry     ) => entry.key === k);
        if (declared && declared.type === "list" && Array.isArray(filled.data[k]) && Number.isSafeInteger(n) && (n          ) > 0) {
          more[k] = n          ;
        }
      }
    }
    openCallCounter += 1;
    const runId = input && typeof input.runId === "string" && input.runId ? input.runId : `open:${openCallCounter}`;
    if (!liveUiWearerRuns.has(runId)) rememberLiveUiRun(liveUiComposeReach, runId, wearer ? "wearer" : "hosts");
    let revision      = null;
    liveUiV2Step("open", key, () => {

      revision = liveUiV2Surfaces.commitText(key, {
        runId,
        text,
        viaTool: true,
        seed: {
          inputs,
          data: filled.data,
          loading: filled.loading,
          origin,
          passive,
          ...(Object.keys(assets).length > 0 ? { assets } : {}),
          ...(Object.keys(more).length > 0 ? { more } : {}),
        },
      });
    });
    const painted = !!(revision && !revision.withdrawn);
    liveUiV2Trace("liveui_v2_open", {
      sessionKey: key,
      surfaceId: revision ? revision.surfaceId : null,
      specRev: revision ? revision.specRev : null,
      origin,
      passive,
      inputs: inputs ? inputs.map((i     ) => i.key) : [],
      loading: filled.loading,
      reach: wearer ? "wearer" : "hosts",
      assets: Object.keys(assets).length,
      more,
      painted,
    });
    return {
      ok: painted,
      painted,
      surfaceId: revision ? revision.surfaceId : null,
      specRev: revision ? revision.specRev : null,
      notes: check.notes,
      reason: painted ? null : "nothing_placed",
    };
  }

  function withdrawLiveUiV2Surface(sessionKey     , surfaceId     , reason     ) {
    const engine = liveUiV2Engine("withdraw");
    if (!engine || typeof surfaceId !== "string") return false;
    let withdrawn = false;
    liveUiV2Step("withdraw", sessionKey, () => {
      withdrawn = !!engine.withdraw(liveUiV2Key(sessionKey), surfaceId, typeof reason === "string" && reason ? reason : "withdrawn");
    });
    return withdrawn;
  }

  function noteLiveUiV2StateReport(input      = {}) {
    const raw = input && input.report && typeof input.report === "object" ? input.report : null;
    const surfaceId = raw && typeof raw.surface === "string" ? raw.surface : null;
    const clientId = input && typeof input.clientId === "string" ? input.clientId : null;
    const refuse = (reason        , extra                          = {}) => {
      liveUiV2Trace("liveui_v2_state_report_refused", {
        sessionKey: surfaceId ? liveUiV2State.sessionOf(surfaceId) : null,
        surfaceId,
        rev: raw && Number.isSafeInteger(raw.rev) ? raw.rev : null,
        clientId,
        reason,
        ...extra,
      });
      return { accepted: false, reason };
    };
    if (!input || input.authoritative !== true) {
      return refuse("not_authoritative", {
        authorityReason: typeof input?.authorityReason === "string" ? input.authorityReason : "unbound_send",
      });
    }
    const report = sanitizeLiveUiStateReport(raw);
    if (!report) return refuse("invalid");
    if (!liveUiV2Sender.owns(report.surface) && !liveUiV2State.knows(report.surface)) return refuse("unknown_surface");
    const verdict = liveUiV2State.accept(report);

    if (!verdict.accepted && input.via === "outcome" && verdict.cachedRev === report.rev) {
      return { accepted: false, reason: "same_rev" };
    }
    if (!verdict.accepted) return refuse(verdict.reason || "stale_rev", { cachedRev: verdict.cachedRev });
    liveUiV2Trace("liveui_v2_state_report_accepted", {
      sessionKey: liveUiV2State.sessionOf(report.surface),
      surfaceId: report.surface,
      rev: report.rev,
      cachedRev: verdict.cachedRev,
      clientId,
      via: input.via === "outcome" ? "outcome" : "report",

      stateKeys: Object.keys(report.state).length,
      derived: Object.keys(report.derived).length,
      timers: Object.keys(report.timers).length,
    });
    return { accepted: true, reason: null };
  }

  function liveUiV2ActionSel(surfaceId        , outcome     )                                                  {
    const row = outcome ? outcome.row : undefined;
    if (typeof row !== "string" || !isWakeRowRefToken(row)) return {};
    const check = liveUiV2Sender.checkTap(surfaceId, row);
    if (!check.known || check.removed) return {};
    return {
      row,
      selectedIndex: Number.isSafeInteger(outcome.selected_index) && outcome.selected_index >= 0 ? outcome.selected_index : null,
    };
  }

  function noteLiveUiV2Outcome(input      = {}) {
    const surfaceId = input && typeof input.surfaceId === "string" ? input.surfaceId : null;
    const outcome = input && input.outcome && typeof input.outcome === "object" ? input.outcome : {};
    const result = typeof outcome.result === "string" ? outcome.result : null;

    const ownerKey = surfaceId ? liveUiV2Sender.surfaceSessionOf(surfaceId) : null;
    const meta = ownerKey && liveUiV2Engine("surfaceMeta") ? (liveUiV2Surfaces       ).surfaceMeta(ownerKey, surfaceId) : null;
    const passive = !!(meta && meta.passive === true);
    const check = liveUiV2Sender.noteOutcome(surfaceId, outcome);
    if (!check || !surfaceId) return null;
    const body =
      outcome.report && typeof outcome.report === "object" ? sanitizeLiveUiStateReport(outcome.report, surfaceId) : null;
    if (body) {
      noteLiveUiV2StateReport({
        report: body,
        clientId: input.clientId,
        authoritative: input.reportAuthoritative === true,
        authorityReason: input.reportAuthorityReason,
        via: "outcome",
      });
    }
    const sessionKey = check.sessionKey;
    if (!sessionKey || !isLiveUiParkedResult(result)) return { parked: null, wake: false };
    const drop = (reason        ) => {
      liveUiV2Trace("liveui_v2_outcome_dropped", { sessionKey, surfaceId, result, ref: check.ref, reason });
      return { parked: null, wake: false };
    };
    if (passive) {

      if ((result === "action" || result === "selected") && !check.known) return drop(check.reason || "undeclared");
      let settled = false;
      if (result === "action" || result === "selected") {
        liveUiV2Step("library_settle", sessionKey, () => {
          settled = !!(liveUiV2Engine("withdraw") && (liveUiV2Surfaces       ).withdraw(sessionKey, surfaceId, "library_settled"));
        });
        liveUiV2Trace("liveui_v2_left_glass", { sessionKey, surfaceId, reason: "library_settled", result, ref: check.ref, settled });
      }
      liveUiV2Trace("liveui_v2_outcome_settled", { sessionKey, surfaceId, result, ref: check.ref, reason: "passive" });
      return { parked: null, wake: false, settled: true };
    }
    let refs                          = {};
    if (result === "action" || result === "selected") {

      const ref = result === "action" ? outcome.action : outcome.row;
      if (typeof ref !== "string") return drop("no_ref");
      if (!check.known) return drop(check.reason || "undeclared");
      if (!(result === "action" ? isWakeRefToken(ref) : isWakeRowRefToken(ref))) return drop("bad_ref");
      refs =
        result === "action"
          ? { action: ref, ...liveUiV2ActionSel(surfaceId, outcome) }
          : {
              row: ref,
              selectedIndex:
                Number.isSafeInteger(outcome.selected_index) && outcome.selected_index >= 0 ? outcome.selected_index : null,
            };
    }
    const entry = liveUiV2State.park({
      sessionKey,
      surface: surfaceId,
      result,
      ...refs,
      ...(check.removed ? { removed: true          } : {}),
      report: body,
    });
    const wake = result !== "dismissed";
    liveUiV2Trace("liveui_v2_outcome_parked", {
      sessionKey,
      surfaceId,
      eventId: entry.eventId,
      result,
      ref: entry.action ?? entry.row ?? null,

      ...(entry.action !== undefined && entry.row !== undefined ? { sel: entry.row } : {}),
      selectedIndex: entry.selectedIndex ?? null,
      removed: entry.removed === true,
      reportRev: body ? body.rev : null,
      wake,
    });
    return {
      wake,

      parked: {
        sessionKey,
        surfaceId,
        eventId: entry.eventId,
        result,
        ...(entry.action !== undefined ? { action: entry.action } : {}),
        ...(entry.row !== undefined ? { row: entry.row, selectedIndex: entry.selectedIndex ?? null } : {}),
        ...(entry.removed ? { removed: true } : {}),
        queuedAtMs: entry.parkedAt,
      },
    };
  }

  function liveUiV2ActiveSurface(key        )                {
    const stack = liveUiV2Surfaces.stack(key);
    return stack.length > 0 ? stack[stack.length - 1] : liveUiV2State.latestSurfaceOf(key);
  }

  function collectLiveUiV2State(sessionKey     ) {
    const key = liveUiV2Key(sessionKey);
    if (!key) return null;
    const v2 =
      isLiveUiV2Session(sessionKey) ||
      isLiveUiV2Session(key) ||
      liveUiV2Sender.surfacesOf(key).length > 0 ||
      liveUiV2State.pendingOutcomes(key) > 0 ||
      liveUiV2State.latestSurfaceOf(key) !== null;
    if (!v2) return null;
    const active = liveUiV2ActiveSurface(key);
    const read = liveUiV2State.collect(key, active, { fallback: active ? liveUiV2Sender.fallbackOnly(active) : false });
    liveUiV2Trace("liveui_v2_outcomes_collected", {
      sessionKey: key,
      surfaceId: active,
      rev: read.state && Number.isInteger(read.state.rev) ? read.state.rev : null,
      fallback: !!(read.state && read.state.fallback === true),
      outcomes: read.outcomes.length,
      eventResults: read.outcomes.map((o     ) => o.result),
    });
    return read;
  }

  const liveUiModelSitesTaught = new Map                ();
  function takeModelSitesLine(key        , out       ) {
    const service = runtimeOpts.modelSites;
    if (!key || !service || typeof service.status !== "function") return;
    const line = modelSitesGuideLine((site) => service.status(site), { sketchfabMirror: service.mirror === true });
    if (!line || liveUiModelSitesTaught.get(key) === line) return;
    out.push({ kind: MODEL_SITES_FENCE_KIND, text: line });
    liveUiModelSitesTaught.delete(key);
    liveUiModelSitesTaught.set(key, line);
    if (liveUiModelSitesTaught.size > 256) {
      const oldest = liveUiModelSitesTaught.keys().next().value;
      if (oldest !== undefined) liveUiModelSitesTaught.delete(oldest);
    }
    liveUiV2Trace("liveui_v2_model_sites_line", { sessionKey: key, bytes: line.length });
  }
  function noteLiveUiV2Compaction(v2Key        ) {
    liveUiV2Surfaces.noteCompaction(v2Key);
    liveUiModelSitesTaught.delete(v2Key);
  }

  function takeLiveUiV2FenceFragments(sessionKey     ) {
    const key = liveUiV2Key(sessionKey);
    const out        = liveUiV2Surfaces.takeFenceFragments(key);
    liveUiV2Step("model_sites_line", key, () => takeModelSitesLine(key, out));
    liveUiV2Step("state_fragment", key, () => {
      const fragment = liveUiV2State.takeFragment(key, liveUiV2ActiveSurface(key));
      if (!fragment) return;
      out.push({ kind: "liveui_state", text: fragment.text });
      liveUiV2Trace("liveui_v2_state_fragment", {
        sessionKey: key,
        bytes: fragment.bytes,
        surfaces: fragment.surfaces,
        parked: fragment.parked,
        tapLines: fragment.tapLines,
      });
    });
    return out;
  }

  function liveUiV2TapsRead(sessionKey     , runId     ) {
    const key = liveUiV2Key(sessionKey);
    const read = liveUiV2State.endTurn(key);
    if (read > 0) liveUiV2Trace("liveui_v2_taps_read", { sessionKey: key, runId: runId || null, read });
  }

  function isLiveUiV2TapOwed(sessionKey     , eventId     ) {
    const key = liveUiV2Key(sessionKey);
    if (typeof key !== "string" || !key || !Number.isSafeInteger(eventId)) return null;
    return liveUiV2State.tapOwed(key, eventId);
  }

  function normalizeGatewaySessionEvent(data     ) {
    if (getActiveBackendKind() === "hermes") return data;
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.getPrototypeOf(data) !== Object.prototype
    ) {
      return data;
    }
    let normalized = data;
    const normalizeField = (field     ) => {
      if (typeof normalized[field] !== "string") return;
      const relayKey = relaySessionKeyFor(normalized[field]);
      if (relayKey === normalized[field]) return;
      if (normalized === data) normalized = { ...data };
      normalized[field] = relayKey;
    };
    normalizeField("sessionKey");
    normalizeField("_activeRunSessionKey");
    for (const nestedField of ["request", "context"]) {
      const nested = normalized[nestedField];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
      const relayKey = relaySessionKeyFor(nested.sessionKey);
      if (!relayKey || relayKey === nested.sessionKey) continue;
      if (normalized === data) normalized = { ...data };
      normalized[nestedField] = { ...nested, sessionKey: relayKey };
    }
    return normalized;
  }

  const gatewayListenersByEvent = new Map();
  function onGatewayEvent(eventName     , listener     ) {
    if (!gatewayListenersByEvent.has(eventName)) gatewayListenersByEvent.set(eventName, []);
    gatewayListenersByEvent.get(eventName).push(listener);
    return gatewayBridge.on(eventName, (data     ) => {

      const observeSetupEvent = Reflect.get(opts, "observeSetupEvent");
      if (typeof observeSetupEvent === "function") observeSetupEvent(eventName, data);
      return listener(normalizeGatewaySessionEvent(data));
    });
  }

  function ingestSimulatedGatewayEvent(eventName = "", data = JSON.parse("null")) {
    const listeners = gatewayListenersByEvent.get(eventName) || [];
    for (const listener of listeners) listener(normalizeGatewaySessionEvent(data));
    return listeners.length > 0;
  }
  const broadcastPages =
    typeof opts.broadcastPages === "function" ? opts.broadcastPages : () => {};
  const broadcastStatus =
    typeof opts.broadcastStatus === "function" ? opts.broadcastStatus : () => {};
  const broadcastActivity =
    typeof opts.broadcastActivity === "function"
      ? opts.broadcastActivity
      : (activity) => activity;
  const noteProseListener = Reflect.get(opts, "noteActivityProse");
  const noteActivityProse =
    typeof noteProseListener === "function" ? noteProseListener : () => null;
  const liveProseListener = Reflect.get(opts, "liveProseHeadlines");
  const liveProseHeadlines =
    typeof liveProseListener === "function" ? liveProseListener : () => false;
  const broadcastProviderUsageSnapshot =
    typeof opts.broadcastProviderUsageSnapshot === "function"
      ? opts.broadcastProviderUsageSnapshot
      : () => {};
  const broadcastSkillsCatalog =
    typeof opts.broadcastSkillsCatalog === "function"
      ? opts.broadcastSkillsCatalog
      : () => {};
  const broadcastCommandCatalog =
    typeof opts.broadcastCommandCatalog === "function"
      ? opts.broadcastCommandCatalog
      : () => {};
  const broadcastAgentsCatalog =
    typeof opts.broadcastAgentsCatalog === "function"
      ? opts.broadcastAgentsCatalog
      : () => {};
  const getCurrentSessionModelConfigSnapshot =
    typeof opts.getCurrentSessionModelConfigSnapshot === "function"
      ? opts.getCurrentSessionModelConfigSnapshot
      : () => null;
  const resetActivityStatusAdapter =
    typeof opts.resetActivityStatusAdapter === "function"
      ? opts.resetActivityStatusAdapter
      : () => {};
  const getServer =
    typeof opts.getServer === "function" ? opts.getServer : () => null;
  const getVoiceRuntime =
    typeof opts.getVoiceRuntime === "function" ? opts.getVoiceRuntime : () => null;

  const getAgentProgressNotes =
    typeof opts.getAgentProgressNotes === "function"
      ? opts.getAgentProgressNotes
      : () => AGENT_PROGRESS_NOTES_DEFAULT;

  const onClarify = typeof opts.onClarify === "function" ? opts.onClarify : () => false;
  const attentionListener = Reflect.get(opts, "onSessionAttention");
  const onSessionAttention = typeof attentionListener === "function" ? attentionListener : () => {};
  const sessionsGoneListener = Reflect.get(opts, "onSessionsGone");
  const onSessionsGone = typeof sessionsGoneListener === "function" ? sessionsGoneListener : () => {};
  const displayedHermesApprovals = new Set();

  function refreshSessionAttention() {
    const key = typeof sessionService.peekSessionKey === "function" ? sessionService.peekSessionKey() : null;
    if (typeof key !== "string" || !key.startsWith("hermes:")) return;
    const server = getServer();
    if (server) {
      for (const id of displayedHermesApprovals) {
        server.broadcast(handler.formatApprovalResolved({ id, decision: null }));
      }
    }
    displayedHermesApprovals.clear();
    Promise.resolve(gatewayBridge.request("sessions.attention", { key })).catch(() => {});
  }

  const takeWaitingApproval =

    typeof opts.takeWaitingApproval === "function" ? opts.takeWaitingApproval : () => false;
  const observeWaitingApprovalResolved =

    typeof opts.observeWaitingApprovalResolved === "function" ? opts.observeWaitingApprovalResolved : () => false;

  const onQuestion = typeof opts.onQuestion === "function" ? opts.onQuestion : () => false;
  const onQuestionResolved =

    typeof opts.onQuestionResolved === "function" ? opts.onQuestionResolved : () => false;
  const observeTaskToolUse =

    typeof opts.observeTaskToolUse === "function" ? opts.observeTaskToolUse : () => false;
  const observeTaskApproval =

    typeof opts.observeTaskApproval === "function" ? opts.observeTaskApproval : () => false;
  const taskApprovalRequests = new Map();
  const TASK_APPROVAL_REQUEST_MAX = 500;

  function rememberTaskApproval(data     ) {
    const request = data && data.request && typeof data.request === "object" ? data.request : {};
    const id = data && typeof data.id === "string" ? data.id.trim() : "";
    const sessionKey = typeof request.sessionKey === "string" ? request.sessionKey.trim() : "";
    const pluginApproval =
      (data && data.approvalKind === "plugin") || id.startsWith("plugin:");
    const toolName =
      (typeof request.toolName === "string" && request.toolName.trim()) ||
      (data && typeof data.toolName === "string" && data.toolName.trim()) ||
      (pluginApproval ? "" : "exec");
    if (!id || !sessionKey || !toolName) return;
    taskApprovalRequests.delete(id);
    taskApprovalRequests.set(id, { sessionKey, toolName });
    while (taskApprovalRequests.size > TASK_APPROVAL_REQUEST_MAX) {
      const oldest = taskApprovalRequests.keys().next();
      if (oldest.done) break;
      taskApprovalRequests.delete(oldest.value);
    }
  }

  const gatewayUrl = typeof opts.gatewayUrl === "string" ? opts.gatewayUrl : null;
  const gatewayToken = typeof opts.gatewayToken === "string" ? opts.gatewayToken : null;

  const MAX_AVATAR_DATA_URI_BYTES = 4 * 1024 * 1024;

  function gatewayHttpOriginFromWsUrl(wsUrl) {
    if (typeof wsUrl !== "string") return null;
    if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice("wss://".length);
    if (wsUrl.startsWith("ws://"))  return "http://"  + wsUrl.slice("ws://".length);
    return null;
  }

  async function defaultFetchAgentAvatar(agentId, _source) {
    if (!gatewayUrl || !gatewayToken || !agentId) return null;
    const origin = gatewayHttpOriginFromWsUrl(gatewayUrl);
    if (!origin) return null;
    const url = `${origin}/avatar/${encodeURIComponent(agentId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${gatewayToken}` },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { contentType, body: buffer };
  }

  const fetchAgentAvatar =
    typeof opts.fetchAgentAvatar === "function" ? opts.fetchAgentAvatar : defaultFetchAgentAvatar;

  const avatarCache = new Map();

  const inFlightAvatarFetches = new Map();

  const avatarHashIndex = new Map();

  async function resolveAgentAvatar(agentId, avatarSource) {
    if (!agentId || typeof avatarSource !== "string" || !avatarSource) return null;

    if (avatarSource.startsWith("data:")) {
      const cacheKey = `${agentId}|${avatarSource}`;
      const cached = avatarCache.get(cacheKey);
      if (cached) return cached;
      const commaIndex = avatarSource.indexOf(",");
      if (commaIndex < 0) return null;
      if (avatarSource.length > MAX_AVATAR_DATA_URI_BYTES) {
        emitDebug(
          "relay.session",
          "agent_avatar_resolve_dropped",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            reason: "oversize",
            agentId,
            dataUriBytes: avatarSource.length,
            capBytes: MAX_AVATAR_DATA_URI_BYTES,
          }),
        );
        return null;
      }
      const base64 = avatarSource.slice(commaIndex + 1);
      const buffer = Buffer.from(base64, "base64");
      const hash = createHash("sha256").update(buffer).digest("hex");
      const entry = { dataUri: avatarSource, hash };
      avatarCache.set(cacheKey, entry);
      avatarHashIndex.set(hash, cacheKey);
      return entry;
    }

    const cacheKey = `${agentId}|${avatarSource}`;
    if (avatarCache.has(cacheKey)) return avatarCache.get(cacheKey);
    if (inFlightAvatarFetches.has(cacheKey)) return inFlightAvatarFetches.get(cacheKey);

    const promise = (async () => {
      try {
        const result = await fetchAgentAvatar(agentId, avatarSource);
        if (!result || !result.body) {
          emitDebug(
            "relay.session",
            "agent_avatar_resolve_dropped",
            "warn",
            { sessionKey: sessionService.ensureSessionKey() },
            () => ({ reason: "empty_response", agentId }),
          );
          return null;
        }
        const contentType = String(result.contentType || "").toLowerCase();
        if (!contentType.startsWith("image/")) {
          emitDebug(
            "relay.session",
            "agent_avatar_resolve_dropped",
            "warn",
            { sessionKey: sessionService.ensureSessionKey() },
            () => ({ reason: "non_image_content_type", agentId, contentType }),
          );
          return null;
        }
        const buffer = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);
        const base64 = buffer.toString("base64");
        const dataUri = `data:${contentType};base64,${base64}`;
        if (dataUri.length > MAX_AVATAR_DATA_URI_BYTES) {
          emitDebug(
            "relay.session",
            "agent_avatar_resolve_dropped",
            "warn",
            { sessionKey: sessionService.ensureSessionKey() },
            () => ({
              reason: "oversize",
              agentId,
              dataUriBytes: dataUri.length,
              capBytes: MAX_AVATAR_DATA_URI_BYTES,
            }),
          );
          return null;
        }
        const hash = createHash("sha256").update(buffer).digest("hex");
        const entry = { dataUri, hash };
        avatarCache.set(cacheKey, entry);
        avatarHashIndex.set(hash, cacheKey);
        return entry;
      } catch (err) {
        emitDebug(
          "relay.session",
          "agent_avatar_resolve_failed",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({ message: err && err.message ? err.message : String(err) }),
        );
        return null;
      } finally {
        inFlightAvatarFetches.delete(cacheKey);
      }
    })();

    inFlightAvatarFetches.set(cacheKey, promise);
    return promise;
  }

  const modelsCacheTtlMs =
    Number.isFinite(opts.modelsCacheTtlMs) && opts.modelsCacheTtlMs > 0
      ? Math.floor(opts.modelsCacheTtlMs)
      : 300000;
  const providerUsageCacheTtlMs =
    Number.isFinite(opts.providerUsageCacheTtlMs) && opts.providerUsageCacheTtlMs > 0
      ? Math.floor(opts.providerUsageCacheTtlMs)

      : 45000;

  let openclawConnected = false;

  let agentIdentity = { name: null, emoji: null, avatarDataUri: null, avatarHash: null };

  let cachedModelsCatalog = null;
  let cachedModelsCatalogFetchedAt = 0;
  let cachedModelsCatalogStale = true;

  let cachedModelsCatalogScope = "";

  let cachedModelInputs = new Map();

  let cachedAgentsWithOwnModel = null;

  let inFlightModelsCatalogFetch = null;
  let inFlightModelsCatalogScope = "";

  let cachedSkillsCatalog = null;
  let cachedSkillsCatalogFetchedAt = 0;
  let cachedSkillsCatalogStale = true;

  let cachedSkillsCatalogAgentId                = null;
  let skillsCatalogGeneration = 0;
  let inFlightSkillsCatalogFetch                                                                         = null;
  let inFlightSkillsCatalogAgentId                = null;
  let inFlightSkillsCatalogGeneration = -1;

  let cachedCommandCatalog = null;
  let cachedCommandCatalogFetchedAt = 0;
  let cachedCommandCatalogStale = true;

  let commandCatalogUnsupported = false;

  let inFlightCommandCatalogFetch = null;

  let cachedAgentsCatalog = null;
  let cachedAgentsCatalogFetchedAt = 0;
  let cachedAgentsCatalogStale = true;

  let cachedAgentsEnvelope = {
    defaultId: null,
    mainKey: null,
    scope: null,
    hermesProfileCreate: false,
    agentCreateSetup: false,
    hermesProfileEmojiSet: false,
    hermesProfileSettings: false,

    foreignSessionAdopt: false,

    sharedChats: false,

    autoRoute: false,
    hermesFleet: null,
  };

  let agentsListUnsupported = false;

  let inFlightAgentsCatalogFetch = null;
  let cachedProviderUsageSummary = null;
  let cachedProviderUsageFetchedAt = 0;
  let cachedProviderUsageObservedAt = 0;
  let cachedProviderUsageStale = true;
  let cachedProviderUsageScope = "";

  let inFlightProviderUsageFetch = null;
  let inFlightProviderUsageScope = "";
  const providerOutcomeState = new Map();
  const cachedAuthProfileCounts = new Map();
  const upstreamRunPipeline = new Map();

  const toolProgressBubbles = new Set();
  function isToolProgressBubble(data     , sessionKey     ) {
    if (isNarrationCommit(data)) return false;
    const messageId = normalizeStreamingToken(data.id ?? data.messageId);
    const runId = normalizeStreamingToken(data.runId);
    const key = messageId && runId
      ? JSON.stringify([sessionKey, runId, messageId])
      : null;
    if (isToolProgressCommit(data)) {
      if (key) {
        toolProgressBubbles.add(key);
        if (toolProgressBubbles.size > 1024) {
          toolProgressBubbles.delete(toolProgressBubbles.values().next().value);
        }
      }
      return true;
    }
    return key !== null && toolProgressBubbles.has(key);
  }

  let streamMessageIdState      = null;
  function streamMessageIndexFromId(runId     , messageId     ) {
    const id = normalizeStreamingToken(messageId);
    if (!runId || !id) return null;
    if (!streamMessageIdState || streamMessageIdState.runId !== runId) {
      streamMessageIdState = { runId, messageId: id, index: 0 };
    } else if (streamMessageIdState.messageId !== id) {
      streamMessageIdState = {
        runId,
        messageId: id,
        index: streamMessageIdState.index + 1,
      };
    }
    return streamMessageIdState.index;
  }
  const activeThinkingRuns = new Set();

  const visibleReasoningRuns = new Map();
  const finalizedThinkingRuns = new Map();
  const finalizedThinkingRunTimers = new Map();
  let streamingThrottleTimer = null;
  let pendingStreaming      = null;

  let activeTyping = null;
  let bootstrapRefreshTimer = null;
  let ledgerCommitFallbackTimer = 0;
  let bootstrapRefreshNonce = 0;

  const workspaceIdentityFallbackCache = new Map();

  const inFlightWorkspaceIdentityFetches = new Map();

  let lastGatewayIdentity = null;

  let connectionGeneration = 0;

  let workspaceIdentityFilesUnsupported = false;

  let agentBootstrapPending      = null;

  let agentBootstrapProbeAgentId      = null;

  let inFlightAgentBootstrapProbe      = null;

  function getAgentName() {
    return agentIdentity.name;
  }

  function getAgentEmoji() {
    return agentIdentity.emoji;
  }

  function getAgentAvatarDataUri() {
    return agentIdentity.avatarDataUri;
  }

  function getAgentAvatarHash() {
    return agentIdentity.avatarHash;
  }

  function getAgentBootstrapPending() {
    return agentBootstrapPending;
  }

  function getAgentAvatarDataUriByHash(hash) {
    if (typeof hash !== "string" || !hash) return null;
    const cacheKey = avatarHashIndex.get(hash);
    if (!cacheKey) return null;
    const entry = avatarCache.get(cacheKey);
    return entry ? entry.dataUri : null;
  }

  function isConnected() {
    return openclawConnected;
  }

  function clearStreamingThrottleTimer() {
    if (!streamingThrottleTimer) return;
    clearTimeout(streamingThrottleTimer);
    streamingThrottleTimer = null;
  }

  function clearBootstrapRefreshTimer() {
    if (!bootstrapRefreshTimer) return;
    clearTimeout(bootstrapRefreshTimer);
    bootstrapRefreshTimer = null;
  }

  function clearLedgerCommitFallbackTimer() {
    if (!ledgerCommitFallbackTimer) return;
    clearTimeout(ledgerCommitFallbackTimer);
    ledgerCommitFallbackTimer = 0;
  }

  function armLedgerCommitFallback(sessionKey     , runId     , stallRearms        ) {
    clearLedgerCommitFallbackTimer();
    const dueAtMs = Date.now() + LEDGER_COMMIT_HISTORY_GRACE_MS;
    ledgerCommitFallbackTimer = setTimeout(() => {
      ledgerCommitFallbackTimer = 0;
      const lateMs = Date.now() - dueAtMs;
      if (stallRearms > 0 && lateMs >= LEDGER_COMMIT_STALL_MS) {
        emitDebug(
          "openclaw.history",
          "commit_fallback_deferred_after_stall",
          "info",
          { sessionKey, runId },
          () => ({ lateMs, graceMs: LEDGER_COMMIT_HISTORY_GRACE_MS }),
        );
        armLedgerCommitFallback(sessionKey, runId, stallRearms - 1);
        return;
      }
      broadcastPages({ reason: "commit_fallback" });
    }, LEDGER_COMMIT_HISTORY_GRACE_MS);
  }

  function flushLedgerCommitFallback() {
    if (!ledgerCommitFallbackTimer) return;
    clearLedgerCommitFallbackTimer();
    broadcastPages({ reason: "commit_fallback_flush" });
  }

  function onConnectedStateEstablished(trigger) {
    refreshModelCatalog(true).then((snapshot) => {
      emitDebug(
        "relay.session",
        "models_catalog_prefetched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          count: Array.isArray(snapshot.models) ? snapshot.models.length : 0,
          stale: !!snapshot.stale,
          trigger,
        }),
      );

      sessionContextService.refreshActiveSessionContext().catch(() => {});
    });
    refreshSkillsCatalog(true).then((snapshot) => {
      emitDebug(
        "relay.session",
        "skills_catalog_prefetched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          count: Array.isArray(snapshot.skills) ? snapshot.skills.length : 0,
          stale: !!snapshot.stale,
          trigger,
        }),
      );
    });
    refreshCommandCatalog(true).then((snapshot) => {
      emitDebug(
        "relay.session",
        "command_catalog_prefetched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          count: Array.isArray(snapshot.commands) ? snapshot.commands.length : 0,
          stale: !!snapshot.stale,
          unsupported: !!snapshot.unsupported,
          backendKind: snapshot.backendKind,
          trigger,
        }),
      );
    });
    refreshProviderUsage(true).then((snapshot) => {
      emitDebug(
        "relay.session",
        "provider_usage_prefetched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          hasProvider: !!(snapshot && snapshot.provider),
          stale: !!(snapshot && snapshot.stale),
          trigger,
        }),
      );
    });
    refreshAgentsCatalog(true).then((snapshot) => {
      emitDebug(
        "relay.session",
        "agents_catalog_prefetched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          count: Array.isArray(snapshot.agents) ? snapshot.agents.length : 0,
          stale: !!snapshot.stale,
          unsupported: !!snapshot.unsupported,
          trigger,
        }),
      );
    });
    sessionService.getCurrentSessionModelConfig().then((config) => {
      emitDebug(
        "relay.session",
        "session_model_config_prefetched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          hasProvider: !!(config && config.modelProvider),
          trigger,
        }),
      );
    });
  }

  function applyConnectedStatus(connected, trigger, emitTransportEvent = true) {
    const wasConnected = openclawConnected;
    openclawConnected = !!connected;
    sessionService.handleUpstreamStatusChange(openclawConnected);
    if (!openclawConnected) {
      clearTyping("upstream_disconnected");
      clearCurrentActivityReplay();
      inFlightModelsCatalogFetch = null;
      inFlightSkillsCatalogFetch = null;
      inFlightCommandCatalogFetch = null;
      inFlightAgentsCatalogFetch = null;
      inFlightProviderUsageFetch = null;

      connectionGeneration += 1;
      lastGatewayIdentity = null;
      workspaceIdentityFilesUnsupported = false;
      workspaceIdentityFallbackCache.clear();
      inFlightWorkspaceIdentityFetches.clear();
      agentBootstrapPending = null;
      agentBootstrapProbeAgentId = null;
      inFlightAgentBootstrapProbe = null;
      cachedSkillsCatalogStale = true;
      skillsCatalogGeneration += 1;
      cachedCommandCatalogStale = true;

      commandCatalogUnsupported = false;
      cachedAgentsCatalogStale = true;

      agentsListUnsupported = false;
      cachedProviderUsageStale = true;
      resetActivityStatusAdapter();

      if (
        agentIdentity.emoji != null ||
        agentIdentity.avatarDataUri != null ||
        agentIdentity.avatarHash != null
      ) {
        agentIdentity = {
          ...agentIdentity,
          emoji: null,
          avatarDataUri: null,
          avatarHash: null,
        };
      }
    } else if (!wasConnected) {
      onConnectedStateEstablished(trigger);
    }
    if (emitTransportEvent) {
      emitDebug(
        "relay.transport",
        "upstream_status",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          status: openclawConnected ? "connected" : "disconnected",
          trigger,
        }),
      );
    }
    broadcastStatus();
  }

  async function ensureWorkspaceIdentityFallback(agentId) {
    const id = typeof agentId === "string" ? agentId.trim() : "";
    if (!id) return null;
    if (workspaceIdentityFilesUnsupported) return null;
    if (workspaceIdentityFallbackCache.has(id)) {
      return workspaceIdentityFallbackCache.get(id);
    }
    if (inFlightWorkspaceIdentityFetches.has(id)) {
      return inFlightWorkspaceIdentityFetches.get(id);
    }
    const gen = connectionGeneration;
    const promise = gatewayBridge
      .request("agents.files.get", {
        agentId: id,
        name: WORKSPACE_IDENTITY_FILENAME,
      })
      .then((result) => {
        const file = result && result.file;
        const content =
          file && typeof file.content === "string" ? file.content : "";
        const parsed = parseWorkspaceIdentityFallback(content);
        const value = parsed.name || parsed.emoji ? parsed : null;

        if (gen === connectionGeneration) {
          workspaceIdentityFallbackCache.set(id, value);
        }
        return value;
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);

        if (isMethodNotFoundError(err, message)) {
          workspaceIdentityFilesUnsupported = true;
        }

        if (gen === connectionGeneration) {
          workspaceIdentityFallbackCache.set(id, null);
        }
        emitDebug(
          "relay.session",
          "workspace_identity_fallback_failed",
          "debug",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({ agentId: id, message }),
        );
        return null;
      })
      .finally(() => {
        inFlightWorkspaceIdentityFetches.delete(id);
      });
    inFlightWorkspaceIdentityFetches.set(id, promise);
    return promise;
  }

  function refreshAgentBootstrapPending(agentId     , reason     ) {
    if (!agentId || getActiveBackendKind() === "hermes" || workspaceIdentityFilesUnsupported) {
      return Promise.resolve(agentBootstrapPending);
    }
    if (inFlightAgentBootstrapProbe) return inFlightAgentBootstrapProbe;
    const gen = connectionGeneration;
    const settle = (value     ) => {
      if (gen !== connectionGeneration || agentId !== agentBootstrapProbeAgentId || inFlightAgentBootstrapProbe !== promise) return;
      agentBootstrapProbeAgentId = agentId;
      if (value === agentBootstrapPending) return;
      agentBootstrapPending = value;
      emitDebug(
        "relay.session",
        "agent_bootstrap_pending_changed",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({ agentId, pending: value, reason }),
      );
      broadcastStatus();
    };
    const promise = gatewayBridge
      .request("agents.files.get", { agentId, name: "BOOTSTRAP.md" })
      .then((result     ) => {
        const file = result && result.file;
        if (file && file.missing === true) return settle(false);
        if (!(file && typeof file.content === "string")) return settle(null);

        return gatewayBridge
          .request("agents.files.get", { agentId, name: WORKSPACE_IDENTITY_FILENAME })
          .then((identityResult     ) => {
            const identityFile = identityResult && identityResult.file;
            const content = identityFile && typeof identityFile.content === "string" ? identityFile.content : "";
            const identity      = parseWorkspaceIdentityFallback(content);
            settle(!identity.name);
          }, () => settle(true));
      })
      .catch((err     ) => {
        if (isMethodNotFoundError(err, err && err.message ? err.message : String(err))) {
          workspaceIdentityFilesUnsupported = true;
        }
        settle(null);
      })
      .finally(() => {
        if (inFlightAgentBootstrapProbe === promise) inFlightAgentBootstrapProbe = null;
      })
      .then(() => agentBootstrapPending);
    inFlightAgentBootstrapProbe = promise;
    return promise;
  }

  function applyAgentIdentity(identity, source) {
    lastGatewayIdentity = identity || null;
    const agentId =
      identity && typeof identity.agentId === "string" && identity.agentId ? identity.agentId : null;
    const avatarSource =
      identity && typeof identity.avatar === "string" && identity.avatar ? identity.avatar : null;

    const inlineAvatarDataUri =
      avatarSource && avatarSource.startsWith("data:") ? avatarSource : null;
    let inlineAvatarHash = null;
    if (agentId && inlineAvatarDataUri) {
      const cacheKey = `${agentId}|${inlineAvatarDataUri}`;
      const cached = avatarCache.get(cacheKey);
      if (cached) {
        inlineAvatarHash = cached.hash;
      } else if (inlineAvatarDataUri.length <= MAX_AVATAR_DATA_URI_BYTES) {
        const commaIndex = inlineAvatarDataUri.indexOf(",");
        if (commaIndex >= 0) {
          const buffer = Buffer.from(inlineAvatarDataUri.slice(commaIndex + 1), "base64");
          inlineAvatarHash = createHash("sha256").update(buffer).digest("hex");
          const entry = { dataUri: inlineAvatarDataUri, hash: inlineAvatarHash };
          avatarCache.set(cacheKey, entry);
          avatarHashIndex.set(inlineAvatarHash, cacheKey);
        }
      }
    }
    const next = {
      name: identity && typeof identity.name === "string" && identity.name ? identity.name : null,
      emoji: identity && typeof identity.emoji === "string" && identity.emoji ? identity.emoji : null,
      avatarDataUri: inlineAvatarDataUri,
      avatarHash: inlineAvatarHash,
    };
    const fallback = agentId
      ? workspaceIdentityFallbackCache.get(agentId)
      : null;
    if (fallback) {
      const merged = applyIdentityFallback(
        { name: next.name, emoji: next.emoji },
        fallback,
      );
      next.name = merged.name;
      next.emoji = merged.emoji;
    }
    agentIdentity = next;
    conversationState.setAgentName(next.name || "Agent");
    if (agentId && (agentId !== agentBootstrapProbeAgentId || agentBootstrapPending === true)) {
      if (agentId !== agentBootstrapProbeAgentId) {
        agentBootstrapProbeAgentId = agentId;
        agentBootstrapPending = null;

        inFlightAgentBootstrapProbe = null;
      }
      refreshAgentBootstrapPending(agentId, source).catch(() => {});
    }
    emitDebug(
      "relay.session",
      "agent_identity_applied",
      "info",
      { sessionKey: sessionService.ensureSessionKey() },
      () => ({
        source,
        hasName: !!next.name,
        hasEmoji: !!next.emoji,
        hasAvatarSource: !!avatarSource,
        avatarInline: !!inlineAvatarDataUri,
        fallbackApplied: !!fallback,
      }),
    );
    broadcastStatus();

    if (
      agentId &&
      !workspaceIdentityFallbackCache.has(agentId) &&
      (!next.name || !next.emoji)
    ) {
      ensureWorkspaceIdentityFallback(agentId)
        .then((value) => {
          if (!value) return;

          if (!openclawConnected) return;
          if (lastGatewayIdentity !== identity) return;
          applyAgentIdentity(identity, `${source}_workspace_fallback`);
        })
        .catch(() => {});
    }

    if (!agentId || !avatarSource) return;
    const generationName = next.name;
    const generationEmoji = next.emoji;
    resolveAgentAvatar(agentId, avatarSource).then((resolved) => {

      if (
        agentIdentity.name !== generationName ||
        agentIdentity.emoji !== generationEmoji
      ) {
        return;
      }
      if (!resolved) return;
      if (
        agentIdentity.avatarDataUri === resolved.dataUri &&
        agentIdentity.avatarHash === resolved.hash
      ) {
        return;
      }
      agentIdentity = {
        ...agentIdentity,
        avatarDataUri: resolved.dataUri,
        avatarHash: resolved.hash,
      };
      broadcastStatus();
    });
  }

  async function refreshUpstreamBootstrap(trigger, attempt = 0) {
    const refreshNonce = ++bootstrapRefreshNonce;
    clearBootstrapRefreshTimer();
    const sessionKey = sessionService.ensureSessionKey();
    const [statusResult, identityResult] = await Promise.allSettled([
      gatewayBridge.request("status", {}),
      gatewayBridge.request("agent.identity.get", { sessionKey }),
    ]);
    if (refreshNonce !== bootstrapRefreshNonce) return;

    const statusOk = statusResult.status === "fulfilled";
    const identityOk = identityResult.status === "fulfilled";

    if (statusOk || identityOk) {
      applyConnectedStatus(true, `${trigger}_bootstrap`, !statusOk);
      if (identityOk) {
        applyAgentIdentity(identityResult.value, `${trigger}_bootstrap`);
      }
      return;
    }

    emitDebug(
      "relay.transport",
      "upstream_state_bootstrap_failed",
      attempt >= 4 ? "warn" : "debug",
      { sessionKey: sessionService.ensureSessionKey() },
      () => ({
        trigger,
        attempt,
        statusError:
          statusResult.status === "rejected" && statusResult.reason
            ? statusResult.reason.message || String(statusResult.reason)
            : null,
        identityError:
          identityResult.status === "rejected" && identityResult.reason
            ? identityResult.reason.message || String(identityResult.reason)
            : null,
      }),
    );
    if (attempt >= 4) return;
    const retryDelayMs = Math.min(250 * (attempt + 1), 1000);
    bootstrapRefreshTimer = setTimeout(() => {
      bootstrapRefreshTimer = null;
      refreshUpstreamBootstrap(trigger, attempt + 1).catch((err) => {
        logger.warn(`[relay] Upstream bootstrap retry failed: ${err.message}`);
      });
    }, retryDelayMs);
  }

  async function refreshActiveSessionIdentity(trigger     , attempt = 0) {

    const refreshNonce = ++bootstrapRefreshNonce;
    clearBootstrapRefreshTimer();
    const sessionKey = sessionService.ensureSessionKey();
    try {
      const identity = await gatewayBridge.request("agent.identity.get", {
        sessionKey,
      });
      if (refreshNonce !== bootstrapRefreshNonce) return;
      applyAgentIdentity(identity, `${trigger}_session_identity`);
      return;
    } catch (err) {
      if (refreshNonce !== bootstrapRefreshNonce) return;
      if (attempt >= 4) {
        logger.warn(
          `[relay] Active-session identity refresh failed after ${trigger}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    const retryDelayMs = Math.min(250 * (attempt + 1), 1000);
    bootstrapRefreshTimer = setTimeout(() => {
      bootstrapRefreshTimer = null;
      refreshActiveSessionIdentity(trigger, attempt + 1).catch((err) => {
        logger.warn(`[relay] Active-session identity retry failed: ${err.message}`);
      });
    }, retryDelayMs);
  }

  function flushPendingStreamingText() {
    if (!pendingStreaming) return;
    const queuedStreaming = pendingStreaming;
    pendingStreaming = null;
    const server = getServer();
    if (server) {
      const runId = queuedStreaming.runId || null;
      if (runId) {
        stopTypingForRun(runId, "first_visible_assistant_progress");
        broadcastThinkingFinalize(
          runId,
          queuedStreaming.sessionKey,
          "response_started",
        );
        emitDebug(
          "openclaw.message",
          "agent_first_chunk",
          "info",
          { sessionKey: queuedStreaming.sessionKey || sessionService.ensureSessionKey() },
          () => ({ runId }),
        );
      }

      const uiRecords = isLiveUiV2Session(
        queuedStreaming.sessionKey || sessionService.ensureSessionKey(),
      );
      const parsedSpans = parseTaggedSpans(
        queuedStreaming.rawText,
        uiRecords
          ? [EMOJI_TAG_FAMILY_CONFIG, PACE_TAG_FAMILY_CONFIG, createUiRecordFamily()]
          : [EMOJI_TAG_FAMILY_CONFIG, PACE_TAG_FAMILY_CONFIG],
      );
      const { text, spansByFamily } = applyMarkdownWithSpans(
        {
          cleanText: parsedSpans.cleanText,
          spansByFamily: uiRecords
            ? splitUiRecordSpans(parsedSpans.spansByFamily).spansByFamily
            : parsedSpans.spansByFamily,
          trailingPartialTag: parsedSpans.trailingPartialTag,
        },
        queuedStreaming.prefix,
        conversationState,
      );
      const emojiSpans = spansByFamily.emoji || [];
      const paceSpans = spansByFamily.pace || [];
      const runPipeline = runId ? upstreamRunPipeline.get(runId) : null;
      const streamSeq = runPipeline
        ? (runPipeline.streamingSeq = (runPipeline.streamingSeq || 0) + 1)
        : null;
      server.broadcast(
        handler.formatStreaming(text, emojiSpans, paceSpans, {
          runId,
          seq: streamSeq,
          messageIndex: queuedStreaming.messageIndex,
        }),
      );
      const now = Date.now();
      const firstRelayBroadcast = runPipeline
        ? !runPipeline.firstRelayBroadcastAt
        : queuedStreaming.flushReason === "first_immediate";
      if (runPipeline && !runPipeline.firstRelayBroadcastAt) {
        runPipeline.firstRelayBroadcastAt = now;
        runPipeline.firstRelayBroadcastChars = text.length;
      }
      emitDebug(
        "relay.protocol",
        "streaming_rebroadcast",
        "debug",
        {
          sessionKey: queuedStreaming.sessionKey || sessionService.ensureSessionKey(),
          runId,
        },
        () => ({
          reason: queuedStreaming.flushReason || "throttled_flush",
          rebroadcastChars: text.length,
          rawAssistantChars: queuedStreaming.rawAssistantChars,
          assistantDeltaChars: queuedStreaming.assistantDeltaChars,
          firstGatewayChunk:
            typeof queuedStreaming.firstGatewayChunk === "boolean"
              ? queuedStreaming.firstGatewayChunk
              : null,
          firstRelayBroadcast,
          gatewayReceivedAtMs: queuedStreaming.gatewayReceivedAtMs,
          gatewayToRebroadcastMs:
            Number.isFinite(queuedStreaming.gatewayReceivedAtMs)
              ? (now - queuedStreaming.gatewayReceivedAtMs)
              : null,
          sendToRebroadcastMs: runPipeline ? (now - runPipeline.sendStartedAt) : null,
          ackToRebroadcastMs:
            runPipeline && runPipeline.ackAt ? (now - runPipeline.ackAt) : null,
          runStartToRebroadcastMs:
            runPipeline && runPipeline.lifecycleStartAt
              ? (now - runPipeline.lifecycleStartAt)
              : null,
          firstStreamingToRebroadcastMs:
            runPipeline && runPipeline.firstStreamingAt
              ? (now - runPipeline.firstStreamingAt)
              : null,
        }),
      );
    }

    const v2SessionKey = queuedStreaming.sessionKey || sessionService.ensureSessionKey();
    if (isLiveUiV2Session(v2SessionKey)) {
      liveUiV2Step("stream", v2SessionKey, () => {
        liveUiV2Surfaces.streamText(liveUiV2Key(v2SessionKey), {
          runId: queuedStreaming.runId || null,
          messageIndex: queuedStreaming.messageIndex,
          messageId: queuedStreaming.messageId || null,
          text: queuedStreaming.rawText,
        });
      });
    }
  }

  let simulatedModelsCatalog = null;
  let simulatedModelsCatalogAt = 0;

  function setSimulatedModelCatalog(models) {
    if (models === null) {
      simulatedModelsCatalog = null;
      simulatedModelsCatalogAt = 0;

      cachedModelsCatalogStale = true;
      return modelCatalogSnapshot(now());
    }
    simulatedModelsCatalog = models;
    simulatedModelsCatalogAt = now();
    return modelCatalogSnapshot(now());
  }

  function modelCatalogSnapshot(nowMs) {
    const currentNow = Number.isFinite(nowMs) ? nowMs : now();
    if (simulatedModelsCatalog) {
      return {
        models: simulatedModelsCatalog,
        fetchedAtMs: simulatedModelsCatalogAt,
        stale: false,
      };
    }
    const hasCache = Array.isArray(cachedModelsCatalog);
    const ageMs = hasCache ? currentNow - cachedModelsCatalogFetchedAt : Infinity;
    const ttlExpired = ageMs >= modelsCacheTtlMs;

    const otherScope = cachedModelsCatalogScope !== gatewayReadScope();
    return {
      models: hasCache ? cachedModelsCatalog : [],
      fetchedAtMs: hasCache ? cachedModelsCatalogFetchedAt : currentNow,
      stale: !hasCache || cachedModelsCatalogStale || ttlExpired || otherScope,
    };
  }

  function cacheModelCatalog(models, fetchedAtMs, stale, scope = gatewayReadScope()) {
    cachedModelsCatalog = Array.isArray(models) ? models : [];
    cachedModelsCatalogFetchedAt = Number.isFinite(fetchedAtMs)
      ? Math.floor(fetchedAtMs)
      : now();
    cachedModelsCatalogStale = !!stale;
    cachedModelsCatalogScope = scope;
    return modelCatalogSnapshot(cachedModelsCatalogFetchedAt);
  }

  function gatewayReadScope() {
    if (getActiveBackendKind() !== "hermes") return "";
    const parsed = parseHermesPublicKey(sessionService.ensureSessionKey() || "");
    return parsed && parsed.namespace ? parsed.namespace : "";
  }

  function gatewayReadParams() {
    if (getActiveBackendKind() !== "hermes") return {};
    const sessionKey = sessionService.ensureSessionKey();
    return sessionKey ? { sessionKey } : {};
  }

  function skillsCatalogSnapshot(nowMs) {
    const currentNow = Number.isFinite(nowMs) ? nowMs : now();
    const hasCache = Array.isArray(cachedSkillsCatalog);
    return {
      skills: hasCache ? cachedSkillsCatalog : [],
      fetchedAtMs: hasCache ? cachedSkillsCatalogFetchedAt : currentNow,
      stale: !hasCache || cachedSkillsCatalogStale,
    };
  }

  function cacheSkillsCatalog(skills     , fetchedAtMs     , stale     , agentId         ) {
    cachedSkillsCatalog = Array.isArray(skills) ? skills : [];
    cachedSkillsCatalogAgentId = typeof agentId === "string" ? agentId : "";
    cachedSkillsCatalogFetchedAt = Number.isFinite(fetchedAtMs)
      ? Math.floor(fetchedAtMs)
      : now();
    cachedSkillsCatalogStale = !!stale;
    return skillsCatalogSnapshot(cachedSkillsCatalogFetchedAt);
  }

  function commandCatalogSnapshot(nowMs) {
    const currentNow = Number.isFinite(nowMs) ? nowMs : now();
    const hasCache = Array.isArray(cachedCommandCatalog);
    const backendKind = getActiveBackendKind();
    const expired =
      hasCache && currentNow - cachedCommandCatalogFetchedAt > COMMAND_CATALOG_TTL_MS;
    return {
      commands: hasCache ? cachedCommandCatalog : [],
      fetchedAtMs: hasCache ? cachedCommandCatalogFetchedAt : currentNow,
      stale: commandCatalogUnsupported
        ? false
        : !hasCache || cachedCommandCatalogStale || expired,
      unsupported: commandCatalogUnsupported,
      backendKind,
      executes: commandExecutesFor(backendKind),
    };
  }

  function cacheCommandCatalog(commands, fetchedAtMs, stale) {
    cachedCommandCatalog = Array.isArray(commands) ? commands : [];
    cachedCommandCatalogFetchedAt = Number.isFinite(fetchedAtMs)
      ? Math.floor(fetchedAtMs)
      : now();
    cachedCommandCatalogStale = !!stale;
    return commandCatalogSnapshot(cachedCommandCatalogFetchedAt);
  }

  function agentsCatalogSnapshot(nowMs) {
    const currentNow = Number.isFinite(nowMs) ? nowMs : now();
    const hasCache = Array.isArray(cachedAgentsCatalog);
    return {
      agents: hasCache ? cachedAgentsCatalog : [],
      defaultId: cachedAgentsEnvelope.defaultId,
      mainKey: cachedAgentsEnvelope.mainKey,
      scope: cachedAgentsEnvelope.scope,
      hermesProfileCreate: cachedAgentsEnvelope.hermesProfileCreate === true,
      agentCreateSetup: cachedAgentsEnvelope.agentCreateSetup === true,
      hermesProfileEmojiSet: cachedAgentsEnvelope.hermesProfileEmojiSet === true,
      hermesProfileSettings: cachedAgentsEnvelope.hermesProfileSettings === true,
      foreignSessionAdopt: cachedAgentsEnvelope.foreignSessionAdopt === true,
      sharedChats: cachedAgentsEnvelope.sharedChats === true,
      autoRoute: cachedAgentsEnvelope.autoRoute === true,
      hermesFleet: cachedAgentsEnvelope.hermesFleet || null,
      fetchedAtMs: hasCache ? cachedAgentsCatalogFetchedAt : currentNow,
      stale: !hasCache || cachedAgentsCatalogStale,
      unsupported: agentsListUnsupported,
    };
  }

  function cacheAgentsCatalog(agents, envelope, fetchedAtMs, stale) {
    cachedAgentsCatalog = Array.isArray(agents) ? agents : [];
    cachedAgentsEnvelope = {
      defaultId:
        envelope && typeof envelope.defaultId === "string" && envelope.defaultId
          ? envelope.defaultId
          : null,
      mainKey:
        envelope && typeof envelope.mainKey === "string" && envelope.mainKey
          ? envelope.mainKey
          : null,
      scope:
        envelope && typeof envelope.scope === "string" && envelope.scope
          ? envelope.scope
          : null,
      hermesProfileCreate: envelope && envelope.hermesProfileCreate === true,
      agentCreateSetup: envelope && envelope.agentCreateSetup === true,
      hermesProfileEmojiSet: envelope && envelope.hermesProfileEmojiSet === true,
      hermesProfileSettings: envelope && envelope.hermesProfileSettings === true,
      foreignSessionAdopt: envelope && envelope.foreignSessionAdopt === true,
      sharedChats: envelope && envelope.sharedChats === true,
      autoRoute: envelope && envelope.autoRoute === true,
      hermesFleet: envelope && envelope.hermesFleet || null,
    };
    cachedAgentsCatalogFetchedAt = Number.isFinite(fetchedAtMs)
      ? Math.floor(fetchedAtMs)
      : now();
    cachedAgentsCatalogStale = !!stale;
    const snapshot = agentsCatalogSnapshot(cachedAgentsCatalogFetchedAt);

    broadcastAgentsCatalog(snapshot);
    return snapshot;
  }

  function getAgentDisplayName(agentId) {
    if (typeof agentId !== "string" || !agentId.trim()) return null;
    const id = agentId.trim();
    if (!Array.isArray(cachedAgentsCatalog)) return null;
    const match = cachedAgentsCatalog.find((entry) => entry && entry.id === id);
    return match ? match.name : null;
  }

  function agentHasOwnModel(agentId) {
    if (typeof agentId !== "string" || !agentId.trim()) return false;
    return !!cachedAgentsWithOwnModel && cachedAgentsWithOwnModel.has(agentId.trim());
  }

  function getAgentPrimaryModel(agentId) {
    if (typeof agentId !== "string" || !agentId.trim()) return null;
    const id = agentId.trim();
    if (!Array.isArray(cachedAgentsCatalog)) return null;
    const match = cachedAgentsCatalog.find((entry) => entry && entry.id === id);
    return match && match.primaryModel ? match.primaryModel : null;
  }

  function providerUsageCacheState(nowMs) {
    const currentNow = Number.isFinite(nowMs) ? nowMs : now();

    const hasCache =
      cachedProviderUsageSummary &&
      typeof cachedProviderUsageSummary === "object" &&
      !Array.isArray(cachedProviderUsageSummary) &&
      cachedProviderUsageScope === gatewayReadScope();
    const ageMs = hasCache ? currentNow - cachedProviderUsageObservedAt : Infinity;
    const ttlExpired = ageMs >= providerUsageCacheTtlMs;
    return {
      summary: hasCache ? cachedProviderUsageSummary : null,
      fetchedAtMs: hasCache ? cachedProviderUsageFetchedAt : currentNow,
      stale: !hasCache || cachedProviderUsageStale || ttlExpired,
    };
  }

  function activeProviderContext() {
    const sessionKey = sessionService.ensureSessionKey();
    const config = getCurrentSessionModelConfigSnapshot();
    const configMatchesActiveSession =
      !!config &&
      (
        typeof sessionService.isCurrentSession === "function"
          ? sessionService.isCurrentSession(config.sessionKey)
          : config.sessionKey === sessionKey
      );
    return {
      sessionKey,
      provider: normalizeProviderId(
        configMatchesActiveSession ? config && config.modelProvider : null,
      ),
    };
  }

  function emptyProviderUsageSnapshot(nowMs, stale = true, unavailableReason = "") {
    const { sessionKey, provider } = activeProviderContext();
    const fallbackFetchedAtMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : now();
    return {
      sessionKey: sessionKey || null,
      provider: provider || null,
      displayName: null,
      limitingWindowKey: null,
      windows: [],
      fetchedAtMs: fallbackFetchedAtMs,
      stale: !!stale,
      poolStatus: computePoolStatus(provider, fallbackFetchedAtMs),
      totalProfileCount: cachedAuthProfileCounts.has(provider)
        ? cachedAuthProfileCounts.get(provider)
        : null,
      ...(typeof unavailableReason === "string" && unavailableReason.trim()
        ? { unavailableReason: unavailableReason.trim() }
        : {}),
    };
  }

  function computePoolStatus(provider, nowMs) {
    if (!provider) return "unknown";
    const entry = providerOutcomeState.get(provider);
    if (!entry) return "unknown";
    const ageMs = nowMs - entry.lastOutcomeAtMs;
    if (ageMs >= POOL_OUTCOME_FRESHNESS_MS) return "unknown";
    return entry.lastOutcome;
  }

  function projectProviderUsageSnapshot(nowMs) {
    const currentNow = Number.isFinite(nowMs) ? nowMs : now();
    const cacheState = providerUsageCacheState(currentNow);
    if (!cacheState.summary) {
      return emptyProviderUsageSnapshot(cacheState.fetchedAtMs);
    }
    const { sessionKey, provider } = activeProviderContext();
    const projected = selectProviderUsageSnapshot(cacheState.summary, {
      sessionKey,
      provider,
      stale: cacheState.stale,
    });
    if (!projected) {
      return emptyProviderUsageSnapshot(
        cacheState.fetchedAtMs,
        cacheState.stale,
        provider && !cacheState.stale
          ? "Usage limits are unavailable for this provider."
          : "",
      );
    }
    return {
      ...projected,
      poolStatus: computePoolStatus(provider, currentNow),
      totalProfileCount: cachedAuthProfileCounts.has(provider)
        ? cachedAuthProfileCounts.get(provider)
        : null,
    };
  }

  async function fetchAuthProfileCounts() {
    const result = await gatewayBridge.request("models.authStatus", {});
    const next = new Map();
    const providers = Array.isArray(result && result.providers) ? result.providers : [];
    for (const entry of providers) {
      const provider = normalizeProviderId(entry && entry.provider);
      if (!provider) continue;
      const profiles = Array.isArray(entry && entry.profiles) ? entry.profiles : [];
      let count = 0;
      for (const profile of profiles) {
        const type = typeof profile?.type === "string" ? profile.type.trim().toLowerCase() : "";
        if (type === "oauth" || type === "token") count += 1;
      }
      next.set(provider, count);
    }
    return next;
  }

  async function refreshProviderUsage(force) {
    const snapshot = projectProviderUsageSnapshot();
    if (!force && !snapshot.stale) {
      return snapshot;
    }
    const scope = gatewayReadScope();
    if (inFlightProviderUsageFetch) {
      if (inFlightProviderUsageScope === scope) {
        return inFlightProviderUsageFetch;
      }

      return inFlightProviderUsageFetch
        .catch(() => {})
        .then(() => refreshProviderUsage(true));
    }
    if (!openclawConnected) {
      return snapshot;
    }

    inFlightProviderUsageScope = scope;
    inFlightProviderUsageFetch = (async () => {
      const [usageResult, authStatusResult] = await Promise.allSettled([
        gatewayBridge.request("usage.status", gatewayReadParams()),
        fetchAuthProfileCounts(),
      ]);

      if (authStatusResult.status === "fulfilled") {
        cachedAuthProfileCounts.clear();
        for (const [provider, count] of authStatusResult.value) {
          cachedAuthProfileCounts.set(provider, count);
        }
      } else {

        emitDebug(
          "relay.session",
          "models_auth_status_refresh_failed",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            message: authStatusResult.reason && authStatusResult.reason.message
              ? authStatusResult.reason.message
              : String(authStatusResult.reason),
            hadCount: cachedAuthProfileCounts.size > 0,
          }),
        );
      }

      if (usageResult.status === "fulfilled") {
        const result = usageResult.value;
        cachedProviderUsageSummary =
          result && typeof result === "object" && !Array.isArray(result) ? result : {};
        cachedProviderUsageScope = scope;
        cachedProviderUsageObservedAt = now();
        cachedProviderUsageFetchedAt =
          Number.isFinite(result && result.updatedAt)
            ? Math.floor(result.updatedAt)
            : cachedProviderUsageObservedAt;
        cachedProviderUsageStale = false;
        const refreshedSnapshot = projectProviderUsageSnapshot(cachedProviderUsageObservedAt);
        broadcastProviderUsageSnapshot(refreshedSnapshot);
        return refreshedSnapshot;
      }

      const err = usageResult.reason;
      emitDebug(
        "relay.session",
        "provider_usage_refresh_failed",
        "warn",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          message: err && err.message ? err.message : String(err),
          hadCache: !!providerUsageCacheState().summary,
        }),
      );
      cachedProviderUsageStale = true;
      if (!providerUsageCacheState().summary) {
        cachedProviderUsageObservedAt = now();
        cachedProviderUsageFetchedAt = cachedProviderUsageObservedAt;
      }
      const refreshedSnapshot = projectProviderUsageSnapshot();
      broadcastProviderUsageSnapshot(refreshedSnapshot);
      return refreshedSnapshot;
    })();

    return inFlightProviderUsageFetch.finally(() => {
      inFlightProviderUsageFetch = null;
    });
  }

  async function refreshModelCatalog(force) {
    const snapshot = modelCatalogSnapshot();

    if (simulatedModelsCatalog) {
      return snapshot;
    }
    if (!force && !snapshot.stale) {
      return snapshot;
    }
    const scope = gatewayReadScope();
    if (inFlightModelsCatalogFetch) {
      if (inFlightModelsCatalogScope === scope) {
        return inFlightModelsCatalogFetch;
      }
      return inFlightModelsCatalogFetch
        .catch(() => {})
        .then(() => refreshModelCatalog(true));
    }
    if (!openclawConnected) {
      return snapshot;
    }

    const readParams = gatewayReadParams();
    inFlightModelsCatalogScope = scope;
    inFlightModelsCatalogFetch = gatewayBridge
      .request("models.list", readParams)
      .then(async (result) => {
        const allModels = normalizeModelCatalogRows(result && result.models);
        cachedModelInputs = modelInputsFromCatalogRows(result && result.models);
        const configSnapshot = await gatewayBridge.request("config.get", readParams);
        const hermes = getActiveBackendKind() === "hermes";
        const models = hermes
          ? mapHermesConfiguredCatalogRows(allModels, configSnapshot)
          : mapConfiguredCatalogRows(allModels, configSnapshot);
        if (!hermes) cachedAgentsWithOwnModel = agentIdsWithOwnModel(configSnapshot);
        return cacheModelCatalog(models, Date.now(), false, scope);
      })
      .catch((err) => {
        emitDebug(
          "relay.session",
          "models_catalog_refresh_failed",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            message: err && err.message ? err.message : String(err),
            hadCache: Array.isArray(cachedModelsCatalog),
          }),
        );
        if (Array.isArray(cachedModelsCatalog)) {
          cachedModelsCatalogStale = true;
          return modelCatalogSnapshot();
        }
        return cacheModelCatalog([], now(), true, scope);
      });

    return inFlightModelsCatalogFetch.finally(() => {
      inFlightModelsCatalogFetch = null;
    });
  }

  function currentSkillsCatalogAgentId() {
    if (getActiveBackendKind() === "hermes") return "";
    let identity      = null;
    try {
      identity = resolveInputPredictionIdentity({
        backendKind: "openclaw",
        clientSessionKey: sessionService.ensureSessionKey(),
        getSessionAgentId:
          typeof sessionService.getSessionAgentId === "function"
            ? (shortKey     , fullKey     ) => sessionService.getSessionAgentId(shortKey, fullKey)
            : undefined,
        extractShortKey:
          typeof sessionService.extractShortKey === "function"
            ? (key     ) => sessionService.extractShortKey(key)
            : undefined,
      });
    } catch {
      identity = null;
    }
    return (identity && identity.agentId) || "main";
  }

  async function requestSkillsStatus(agentId        ) {
    if (!agentId || agentId.toLowerCase() === "main") {
      return gatewayBridge.request("skills.status", {});
    }
    try {
      return await gatewayBridge.request("skills.status", { agentId });
    } catch (err     ) {
      if (isMethodNotFoundError(err, err && err.message ? err.message : String(err))) throw err;
      return gatewayBridge.request("skills.status", {});
    }
  }

  function invalidateSkillsCatalog(trigger     ) {
    skillsCatalogGeneration += 1;
    cachedSkillsCatalogStale = true;
    if (!openclawConnected) return;
    refreshSkillsCatalog(true).catch((err     ) => {
      logger.warn(`[relay] Skills catalog refresh failed after ${trigger}: ${err.message}`);
    });
  }

  async function refreshSkillsCatalog(force      )               {
    const agentId = currentSkillsCatalogAgentId();
    const generation = skillsCatalogGeneration;
    const snapshot = skillsCatalogSnapshot();
    if (!force && !snapshot.stale && cachedSkillsCatalogAgentId === agentId) {
      return snapshot;
    }
    if (
      inFlightSkillsCatalogFetch &&
      inFlightSkillsCatalogAgentId === agentId &&
      inFlightSkillsCatalogGeneration === generation
    ) {
      return inFlightSkillsCatalogFetch;
    }
    if (!openclawConnected) {
      return snapshot;
    }

    const superseded = () =>
      generation !== skillsCatalogGeneration || agentId !== currentSkillsCatalogAgentId();

    const fetch               = requestSkillsStatus(agentId)
      .then((result     )      => {
        if (superseded()) return refreshSkillsCatalog(false);
        const skills = normalizeSkillsCatalogRows(result && result.skills);
        const changed = !skillsCatalogRowsEqual(cachedSkillsCatalog, skills);
        const snapshot = cacheSkillsCatalog(skills, Date.now(), false, agentId);
        if (changed) {
          Promise.resolve(getSkillsCatalogSnapshot()).then(
            (freshSnapshot) => broadcastSkillsCatalog(freshSnapshot),
            (err) => {
              logger.warn(`[relay] Skills catalog broadcast snapshot failed: ${err.message}`);
            },
          );
        }
        return snapshot;
      })
      .catch((err     )      => {
        emitDebug(
          "relay.session",
          "skills_catalog_refresh_failed",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            message: err && err.message ? err.message : String(err),
            hadCache: Array.isArray(cachedSkillsCatalog),
          }),
        );
        if (superseded()) return refreshSkillsCatalog(false);

        if (Array.isArray(cachedSkillsCatalog) && cachedSkillsCatalogAgentId === agentId) {
          cachedSkillsCatalogStale = true;
          return skillsCatalogSnapshot();
        }
        return cacheSkillsCatalog([], now(), true, agentId);
      });

    inFlightSkillsCatalogFetch = fetch;
    inFlightSkillsCatalogAgentId = agentId;
    inFlightSkillsCatalogGeneration = generation;
    return fetch.finally(() => {
      if (inFlightSkillsCatalogFetch === fetch) {
        inFlightSkillsCatalogFetch = null;
      }
    });
  }

  async function refreshCommandCatalog(force) {
    const snapshot = commandCatalogSnapshot();
    if (commandCatalogUnsupported) {
      return snapshot;
    }
    if (!force && !snapshot.stale) {
      return snapshot;
    }
    if (inFlightCommandCatalogFetch) {
      return inFlightCommandCatalogFetch;
    }
    if (!openclawConnected) {
      return snapshot;
    }

    inFlightCommandCatalogFetch = gatewayBridge
      .request("commands.list", { scope: "text", includeArgs: true })
      .then((result) => {
        const rawRows =
          result && Array.isArray(result.commands) ? result.commands : [];
        const backendKind = getActiveBackendKind();
        const commands = normalizeCommandCatalogRows(
          rawRows,
          backendKind,
          commandExecutesFor(backendKind),
        );
        if (rawRows.length > COMMAND_CATALOG_MAX_ENTRIES) {
          emitDebug(
            "relay.session",
            "command_catalog_truncated",
            "warn",
            { sessionKey: sessionService.ensureSessionKey() },
            () => ({ received: rawRows.length, kept: commands.length }),
          );
        }
        const changed = !commandCatalogRowsEqual(cachedCommandCatalog, commands);
        const fresh = cacheCommandCatalog(commands, Date.now(), false);
        if (changed) {
          broadcastCommandCatalog(fresh);
        }
        return fresh;
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);

        if (isMethodNotFoundError(err, message)) {
          commandCatalogUnsupported = true;
          emitDebug(
            "relay.session",
            "command_catalog_unsupported",
            "info",
            { sessionKey: sessionService.ensureSessionKey() },
            () => ({ message, backendKind: getActiveBackendKind() }),
          );
          return cacheCommandCatalog([], now(), false);
        }
        emitDebug(
          "relay.session",
          "command_catalog_refresh_failed",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({ message, hadCache: Array.isArray(cachedCommandCatalog) }),
        );

        if (Array.isArray(cachedCommandCatalog)) {
          cachedCommandCatalogStale = true;
          return commandCatalogSnapshot();
        }
        return cacheCommandCatalog([], now(), true);
      });

    return inFlightCommandCatalogFetch.finally(() => {
      inFlightCommandCatalogFetch = null;
    });
  }

  async function refreshAgentsCatalog(force) {
    const snapshot = agentsCatalogSnapshot();
    if (agentsListUnsupported) {
      return snapshot;
    }
    if (!force && !snapshot.stale) {
      return snapshot;
    }
    if (inFlightAgentsCatalogFetch) {
      return inFlightAgentsCatalogFetch;
    }
    if (!openclawConnected) {
      return snapshot;
    }

    inFlightAgentsCatalogFetch = gatewayBridge
      .request("agents.list", {})
      .then(async (result) => {
        const rawRows =
          result && Array.isArray(result.agents) ? result.agents : [];

        const needIds = rawRows
          .filter(rawRowNeedsIdentityFallback)
          .map((r) => r.id.trim());
        if (needIds.length) {
          await Promise.all(
            needIds.map((id) => ensureWorkspaceIdentityFallback(id)),
          );
        }
        const overlaid = overlayRawAgentRowsWithFallback(
          rawRows,
          workspaceIdentityFallbackCache,
        );
        const agents = normalizeAgentsCatalogRows(overlaid);
        const envelope = {
          defaultId: result && result.defaultId,
          mainKey: result && result.mainKey,
          scope: result && result.scope,
          hermesProfileCreate: result && result.hermesProfileCreate === true,
          agentCreateSetup: result && result.agentCreateSetup === true,
          hermesProfileEmojiSet: result && result.hermesProfileEmojiSet === true,
          hermesProfileSettings: result && result.hermesProfileSettings === true,
          foreignSessionAdopt: result && result.foreignSessionAdopt === true,
          sharedChats: result && result.sharedChats === true,
          autoRoute: result && result.autoRoute === true,
          hermesFleet: result && result.hermesFleet || null,
        };
        return cacheAgentsCatalog(agents, envelope, Date.now(), false);
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);

        if (isMethodNotFoundError(err, message)) {
          agentsListUnsupported = true;
        }
        emitDebug(
          "relay.session",
          "agents_catalog_refresh_failed",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            message,
            unsupported: agentsListUnsupported,
            hadCache: Array.isArray(cachedAgentsCatalog),
          }),
        );
        if (Array.isArray(cachedAgentsCatalog)) {
          cachedAgentsCatalogStale = true;
          return agentsCatalogSnapshot();
        }
        return cacheAgentsCatalog([], cachedAgentsEnvelope, now(), true);
      });

    return inFlightAgentsCatalogFetch.finally(() => {
      inFlightAgentsCatalogFetch = null;
    });
  }

  function trackAcceptedRun(entry) {
    if (!entry || !entry.runId) return;

    rememberLiveUiRun(liveUiWearerRuns, entry.runId);
    if (entry.modelSitesAllowed === true && typeof entry.sessionKey === "string" && entry.sessionKey) {
      rememberLiveUiRun(liveUiModelSiteRuns, entry.runId, liveUiV2Key(entry.sessionKey));
    }
    else liveUiModelSiteRuns.delete(entry.runId);

    const v2RunKey = entry.sessionKey || null;
    if (v2RunKey && isLiveUiV2Session(v2RunKey) && liveUiV2Engine("endReservation")) {
      liveUiV2Step("reservation_end", v2RunKey, () => liveUiV2Surfaces.endReservation(liveUiV2Key(v2RunKey)));
    }
    upstreamRunPipeline.set(entry.runId, {
      runId: entry.runId,
      sessionKey: entry.sessionKey || null,
      messageId: entry.messageId || null,
      sendStartedAt: entry.sendStartedAt || Date.now(),
      ackAt: entry.ackAt || Date.now(),
      lifecycleStartAt: null,
      firstStreamingAt: null,
      firstGatewayReceivedAt: null,
      firstGatewayChars: null,
      firstRelayBroadcastAt: null,
      firstRelayBroadcastChars: null,
      streamingSeq: 0,
    });
  }

  function getHostModelInput(provider     , modelId     ) {
    const kinds = cachedModelInputs.get(modelInputKey(provider, modelId));
    return kinds ? kinds.slice() : null;
  }

  async function getModelsCatalogSnapshot() {
    const snapshot = modelCatalogSnapshot();
    if (snapshot.stale && openclawConnected) {
      return refreshModelCatalog(true);
    }
    return snapshot;
  }

  async function getSkillsCatalogSnapshot() {
    const snapshot = skillsCatalogSnapshot();

    const otherAgent = cachedSkillsCatalogAgentId !== currentSkillsCatalogAgentId();
    if ((snapshot.stale || otherAgent) && openclawConnected) {
      return refreshSkillsCatalog(true);
    }
    if (otherAgent) {
      return { ...snapshot, skills: [], stale: true };
    }
    return snapshot;
  }

  async function getCommandCatalogSnapshot() {
    const snapshot = commandCatalogSnapshot();
    if (snapshot.stale && !commandCatalogUnsupported && openclawConnected) {
      return refreshCommandCatalog(true);
    }
    return snapshot;
  }

  async function getAgentsCatalogSnapshot(forceRefresh = false) {
    const snapshot = agentsCatalogSnapshot();
    const fleetRefreshDue = getActiveBackendKind() === "hermes" &&
      now() - cachedAgentsCatalogFetchedAt >= 15000;
    if ((forceRefresh || snapshot.stale || fleetRefreshDue) && !agentsListUnsupported && openclawConnected) {
      return refreshAgentsCatalog(true);
    }

    broadcastAgentsCatalog(snapshot);
    return snapshot;
  }

  async function getProviderUsageSnapshot() {
    const snapshot = projectProviderUsageSnapshot();
    if (snapshot.stale && openclawConnected) {
      return refreshProviderUsage(true);
    }
    return snapshot;
  }

  async function handleCurrentSessionModelConfigChanged() {
    clearHiddenReasoning();

    sessionContextService.refreshActiveSessionContext().catch(() => {});

    const snapshot = projectProviderUsageSnapshot();
    if (snapshot.stale && openclawConnected) {
      return refreshProviderUsage(true);
    }
    broadcastProviderUsageSnapshot(snapshot);
    return snapshot;
  }

  async function handleCurrentSessionModelConfigCleared() {
    const snapshot = emptyProviderUsageSnapshot(now(), false);
    broadcastProviderUsageSnapshot(snapshot);
    return snapshot;
  }

  function refreshSessionContext() {
    if (!openclawConnected) return;
    sessionContextService.refreshActiveSessionContext().catch(() => {});
  }

  function handleSessionChanged(trigger) {
    clearActivityPlans();
    clearCurrentActivityReplay();
    visibleReasoningRuns.clear();
    refreshSessionAttention();
    if (!openclawConnected) {
      invalidateSkillsCatalog(trigger);
      cachedCommandCatalogStale = true;
      return;
    }
    refreshActiveSessionIdentity(trigger).catch((err) => {
      logger.warn(`[relay] Agent identity refresh failed after ${trigger}: ${err.message}`);
    });

    refreshSessionContext();
    invalidateSkillsCatalog(trigger);
    refreshCommandCatalog(true).catch((err) => {
      logger.warn(`[relay] Command catalog refresh failed after ${trigger}: ${err.message}`);
    });
  }

  function normalizeGatewayTimingEvent(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const category =
      source.category === "openclaw.run" || source.category === "relay.protocol"
        ? source.category
        : "relay.protocol";
    const event =
      typeof source.event === "string" && source.event.trim()
        ? source.event.trim()
        : "gateway_timing";
    const severity =
      source.severity === "debug" ||
      source.severity === "info" ||
      source.severity === "warn" ||
      source.severity === "error"
        ? source.severity
        : "debug";
    const context = source.context && typeof source.context === "object"
      ? source.context
      : {};
    const data = source.data && typeof source.data === "object"
      ? source.data
      : {};
    return {
      category,
      event,
      severity,
      context: {
        sessionKey:
          typeof context.sessionKey === "string" && context.sessionKey.trim()
            ? context.sessionKey.trim()
            : sessionService.ensureSessionKey(),
        runId:
          typeof context.runId === "string" && context.runId.trim()
            ? context.runId.trim()
            : null,
      },
      data,
    };
  }

  let cachedRunActiveSessionKey      = null;

  let cachedWaitingItems        = [];
  let cachedWaitingHost                = null;

  function getWaitingReplay() {
    if (cachedWaitingItems.length === 0) return null;
    return formatWaiting({ items: cachedWaitingItems, host: cachedWaitingHost });
  }

  const waitingExplanations                                                          = new Map();

  function getWaitingExplanationReplay()           {
    const frames           = [];
    for (const item of cachedWaitingItems) {
      const entry = waitingExplanations.get(item.requestId);
      if (!entry) continue;
      let frame                = null;
      if (entry.state === "pending") {
        frame = formatWaitingExplanation({ requestId: item.requestId, state: "pending" });
      } else if (entry.state === "done" && entry.sentence) {
        frame = formatWaitingExplanation({
          requestId: item.requestId,
          state: "done",
          sentence: entry.sentence,
        });
      }
      if (frame) frames.push(frame);
    }
    return frames;
  }

  const ACTIVITY_PLAN_CACHE_MAX = 32;
  const activityPlanFrameBySession = new Map();
  function rememberActivityPlan(data     ) {
    if (!data || typeof data !== "object") return;
    const plan = data.plan;
    const sessionKey = typeof data.sessionKey === "string" ? data.sessionKey : "";
    if (!sessionKey || !plan || typeof plan !== "object" || Array.isArray(plan)) return;
    activityPlanFrameBySession.delete(sessionKey);
    if (plan.cleared === true) return;
    activityPlanFrameBySession.set(sessionKey, data);
    while (activityPlanFrameBySession.size > ACTIVITY_PLAN_CACHE_MAX) {
      activityPlanFrameBySession.delete(activityPlanFrameBySession.keys().next().value);
    }
  }
  function clearActivityPlans() {
    activityPlanFrameBySession.clear();
  }

  function getActivityPlanReplay() {
    if (!cachedRunActiveSessionKey || !sessionService.isCurrentSession(cachedRunActiveSessionKey)) {
      return null;
    }
    return activityPlanFrameBySession.get(cachedRunActiveSessionKey) || null;
  }

  let currentActivityReplay      = null;
  let currentActivityReplayRun                                               = null;
  const closedActivityReplayRuns = new Set        ();
  function closeActivityReplayRun(runId        ) {
    closedActivityReplayRuns.delete(runId);
    closedActivityReplayRuns.add(runId);
    while (closedActivityReplayRuns.size > ACTIVITY_PLAN_CACHE_MAX) {
      const oldestRunId = closedActivityReplayRuns.values().next().value;
      if (oldestRunId === undefined) break;
      closedActivityReplayRuns.delete(oldestRunId);
    }
  }
  function clearCurrentActivityReplay() {
    currentActivityReplay = null;
    currentActivityReplayRun = null;
  }
  function rememberCurrentActivity(activity     ) {
    if (!activity || !sessionService.isCurrentSession(activity.sessionKey)) return;
    const runId = typeof activity.runId === "string" ? activity.runId.trim() : "";
    if (!runId) return;
    if (classifyRunOutcomeFrame(activity, activity.phase, activity.origin).terminal) {
      closeActivityReplayRun(runId);
      if (currentActivityReplayRun?.runId === runId) clearCurrentActivityReplay();
      return;
    }
    if (closedActivityReplayRuns.has(runId) || activity.failoverPending === true) return;
    const startsRun = activity.origin === "lifecycle" && activity.phase === "start" &&
      activity.state === "thinking";
    if (startsRun && currentActivityReplayRun?.runId !== runId) {
      if (currentActivityReplayRun) closeActivityReplayRun(currentActivityReplayRun.runId);
      currentActivityReplayRun = { runId, sessionKey: activity.sessionKey };
      currentActivityReplay = { ...activity, runId };
    } else if (currentActivityReplayRun?.runId === runId) {
      currentActivityReplay = { ...activity, runId };
    }
  }
  function getActivityReplay() {
    if (!currentActivityReplayRun || !sessionService.isCurrentSession(currentActivityReplayRun.sessionKey)) return null;
    const plan = getActivityPlanReplay();
    return plan?.runId === currentActivityReplayRun.runId ? plan : currentActivityReplay;
  }

  const sessionContextService = createSessionContextService({
    gatewayBridge,
    stateDir: opts.stateDir,
    getActiveSessionKey: () => sessionService.ensureSessionKey() || null,
    isDraftSession: (sessionKey) =>
      typeof sessionService.isDraftSession === "function" &&
      sessionService.isDraftSession(sessionKey),
    getActiveModelKey: () => {
      const config = getCurrentSessionModelConfigSnapshot();
      if (!config) return null;
      const provider = normalizeProviderId(config.modelProvider);
      const model = typeof config.model === "string" ? config.model.trim() : "";
      if (!provider || !model) return null;
      return modelRefKey(provider, model);
    },
    getActiveModelContextWindow: () => {
      const config = getCurrentSessionModelConfigSnapshot();
      const models = modelCatalogSnapshot(now()).models;
      if (!config || models.length === 0) return 0;
      const provider = normalizeProviderId(config.modelProvider);
      const model = typeof config.model === "string" ? config.model.trim() : "";
      if (!provider || !model) return 0;
      for (const candidate of models) {
        if (
          candidate &&
          normalizeProviderId(candidate.provider) === provider &&
          candidate.id === model &&
          Number.isFinite(candidate.contextWindow) &&
          candidate.contextWindow > 0
        ) {
          return Math.floor(candidate.contextWindow);
        }
      }
      return 0;
    },
    getRunActive: () => !!cachedRunActiveSessionKey && sessionService.isCurrentSession(cachedRunActiveSessionKey),
    nowMs: () => Date.now(),
    broadcast: (frame) => {
      const server = getServer();
      if (server) server.broadcast(JSON.stringify(frame));

      if (frame && frame.compactionCountKnown === true && typeof frame.sessionKey === "string") {
        const v2Key = liveUiV2Key(frame.sessionKey);
        const before = liveUiV2CompactionCounts.get(v2Key);
        liveUiV2CompactionCounts.set(v2Key, frame.compactionCount);
        const noted = liveUiV2CompactionsNoted.delete(v2Key);
        if (!noted && Number.isFinite(before) && frame.compactionCount > before && isLiveUiV2Session(frame.sessionKey)) {
          liveUiV2Step("compaction", v2Key, () => noteLiveUiV2Compaction(v2Key));
        }
      }

      emitDebug(
        "relay.session",
        "session_context_snapshot_broadcast",
        "info",
        { sessionKey: frame && frame.sessionKey ? frame.sessionKey : null },
        () => ({
          runActive: !!(frame && frame.runActive),
          contextTokensKnown: !!(frame && frame.contextTokensKnown),
          contextTokens: frame && Number.isFinite(frame.contextTokens) ? frame.contextTokens : null,
        }),
      );
    },
  });

  onGatewayEvent("history", (data) => {
    if (!sessionService.isCurrentSession(data.sessionKey)) {

      emitDebug(
        "openclaw.history",
        "history_dropped_foreign_session",
        "warn",
        { sessionKey: sessionService.peekSessionKey() },
        () => ({
          eventSessionKey: data.sessionKey ?? null,
          currentSessionKey: sessionService.peekSessionKey(),
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        }),
      );
      return;
    }
    clearLedgerCommitFallbackTimer();
    emitDebug(
      "openclaw.history",
      "history",
      "debug",
      { sessionKey: data.sessionKey || sessionService.ensureSessionKey() },
      () => ({
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
      }),
    );
    const historyMessages = getActiveBackendKind() === "openclaw" && Array.isArray(data.messages)
      ? projectOpenClawConversationHistory(data.messages)
      : data.messages;
    const sanitizedMessages = Array.isArray(historyMessages)
      ? historyMessages.map((msg     ) =>
          msg && msg.role === "assistant"
            ? { ...msg, content: sanitizeAssistantContentBlocks(msg.content, data.sessionKey) }
            : msg,
        )
      : historyMessages;

    conversationState.hydrate(sanitizedMessages, agentIdentity.name, data.sessionKey, {
      commitRunId: typeof data.commitRunId === "string" ? data.commitRunId : undefined,
      commitText: typeof data.commitText === "string" ? data.commitText : undefined,
    });

    broadcastPages({
      reason: "gateway_history",
      sourceRowCount: Array.isArray(sanitizedMessages) ? sanitizedMessages.length : null,
      sourceRunId: data.commitRunId,
    });
  });

  function ingestMirroredRows(rows     , info      = {}) {
    const sessionKey = info && info.sessionKey;
    if (!sessionService.isCurrentSession(sessionKey)) return 0;
    const author = typeof info.author === "string" && info.author.trim() ? info.author.trim() : null;
    const origin = typeof info.origin === "string" && info.origin.trim() ? info.origin.trim() : "desktop";
    const heldIds = new Set        ();
    for (const msg of conversationState.getRawMessages()) {
      const id = msg ? serverIdOf(msg) : "";
      if (id) heldIds.add(id);
    }
    let appended = 0;
    let skippedDuplicate = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || (row.role !== "user" && row.role !== "assistant")) continue;
      const metadata      = { origin };
      if (typeof row.id === "number" || typeof row.id === "string") metadata.id = row.id;
      const rowId = serverIdOf(metadata);
      if (rowId && heldIds.has(rowId)) {
        skippedDuplicate += 1;
        continue;
      }
      const content =
        row.role === "assistant" ? sanitizeAssistantContentBlocks(row.content, sessionKey) : row.content;
      if (Number.isFinite(Number(row.timestamp))) metadata.timestamp = Number(row.timestamp);
      conversationState.addMessage(row.role, content, row.role === "user" ? author : null, metadata);
      if (rowId) heldIds.add(rowId);
      appended += 1;
    }
    if (appended === 0) {
      if (skippedDuplicate > 0) {
        emitDebug(
          "openclaw.message",
          "mirrored_rows",
          "info",
          { sessionKey },
          () => ({ origin, rows: 0, skippedDuplicate }),
        );
      }
      return 0;
    }
    emitDebug(
      "openclaw.message",
      "mirrored_rows",
      "info",
      { sessionKey },
      () => ({
        origin,
        rows: appended,
        skippedDuplicate,
        ids: (Array.isArray(rows) ? rows : []).map((row     ) => (row && row.id) ?? null),
        roles: (Array.isArray(rows) ? rows : []).map((row     ) => row && row.role),
        textChars: (Array.isArray(rows) ? rows : []).reduce(
          (sum     , row     ) => sum + fullMessageText(row && row.content).length,
          0,
        ),
      }),
    );
    broadcastPages({ reason: "mirrored_rows" });
    return appended;
  }

  async function rehydrateHistory(sessionKey     , reason      = "rehydrate") {
    if (!sessionService.isCurrentSession(sessionKey)) return false;

    const fixtureHistory =
      typeof sessionService.getSimulatedSessionHistory === "function"
        ? sessionService.getSimulatedSessionHistory(sessionKey)
        : null;
    if (fixtureHistory) {
      conversationState.hydrate(fixtureHistory, agentIdentity.name, sessionKey, {});
      broadcastPages({ reason: "mirror_rehydrate", sourceRowCount: fixtureHistory.length });
      return true;
    }
    const result = await gatewayBridge.request("chat.history", { sessionKey, limit: 200 });
    if (!sessionService.isCurrentSession(sessionKey)) return false;
    const rawMessages =  (
      result && Array.isArray(result.messages) ? result.messages : []
    );
    const messages = getActiveBackendKind() === "openclaw"
      ? projectOpenClawConversationHistory(rawMessages)
      : rawMessages;
    const sanitized = messages.map((msg     ) =>
      msg && msg.role === "assistant"
        ? { ...msg, content: sanitizeAssistantContentBlocks(msg.content, sessionKey) }
        : msg,
    );
    const total = result && Number.isFinite(Number(result.total)) ? Number(result.total) : null;
    conversationState.hydrate(sanitized, agentIdentity.name, sessionKey, {
      truncatedHead: total !== null && total > sanitized.length,
    });
    emitDebug(
      "openclaw.history",
      "rehydrated",
      "info",
      { sessionKey },
      () => ({ reason, messageCount: sanitized.length, total }),
    );
    broadcastPages({ reason: "mirror_rehydrate", sourceRowCount: sanitized.length });
    return true;
  }

  onGatewayEvent("thinkingDebug", (data) => {
    if (!sessionService.isCurrentSession(data.sessionKey)) return;
    emitDebug(
      "openclaw.history",
      "thinking_payload",
      "debug",
      {
        sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
        runId: data.runId || null,
      },
      () => ({
        source: data.source || null,
        signatureId: data.signatureId || null,
        rawKeys: Array.isArray(data.rawKeys) ? data.rawKeys : [],
        rawPayload:
          data.rawPayload && typeof data.rawPayload === "object" ? data.rawPayload : null,
        summaryKey: data.summaryKey || null,
        detailKey: data.detailKey || null,
        labelKey: data.labelKey || null,
        labelRaw: data.labelRaw || null,
        labelSource: data.labelSource || null,
        thinkingSummarySource: data.thinkingSummarySource || data.labelSource || null,
        normalizedSummary: data.normalizedSummary || null,
        normalizedDetail: data.normalizedDetail || null,
        label: data.label || null,
        detail: data.detail || null,
        boldLabelCandidate: data.boldLabelCandidate || null,
        boldLabelMatchesCurrentLabel:
          typeof data.boldLabelMatchesCurrentLabel === "boolean"
            ? data.boldLabelMatchesCurrentLabel
            : null,
      }),
    );
  });

  function isLiveUiV2Session(sessionKey         ) {
    return (
      typeof sessionService.isLiveUiV2Session === "function" &&
      sessionService.isLiveUiV2Session(sessionKey) === true
    );
  }

  function sanitizeAssistantContentBlocks(content, sessionKey          ) {
    const uiRecords = isLiveUiV2Session(sessionKey);
    if (typeof content === "string") {
      return stripReplyMarkup(content, { uiRecords });
    }
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        return { ...block, text: stripReplyMarkup(block.text, { uiRecords }) };
      }
      return block;
    });
  }

  function broadcastStreamClear(runId, sessionKey, reason) {
    const server = getServer();
    if (!server || typeof server.broadcast !== "function") return;
    server.broadcast(
      handler.formatStreamClear({
        runId: runId || null,
        sessionKey: sessionKey || sessionService.ensureSessionKey(),
        reason,
      }),
    );
  }

  function handleNarrationRetag(data) {
    if (!data || typeof data !== "object") return;
    if (!sessionService.isCurrentSession(data.sessionKey)) return;
    if (!isNarrationCommit(data)) return;
    const runId = data.runId || null;
    const retagMessageId = data.id ?? data.messageId;
    const removed = conversationState.removeLastAssistantMessageMatching(
      runId,
      typeof data.text === "string" ? data.text : "",
      retagMessageId,
    );
    emitDebug(
      "openclaw.message",
      "narration_retag",
      "info",
      {
        sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
        runId,
      },
      () => ({ removed, textChars: typeof data.text === "string" ? data.text.length : 0 }),
    );
    if (removed) {
      broadcastPages({ reason: "narration_withdrawn" });

      broadcastStreamClear(runId, data.sessionKey, "narration_retagged");
    }
  }

  onGatewayEvent("message.retag", handleNarrationRetag);

  function handleMessageEdit(data     ) {
    const sessionKey = data.sessionKey || sessionService.ensureSessionKey();
    const messageId = data.id ?? data.messageId;
    const content = sanitizeAssistantContentBlocks(data.content, sessionKey);
    const replaced = conversationState.replaceAssistantMessageContent(messageId, content);
    if (!replaced) {
      conversationState.addMessage("assistant", content, null, {
        id: messageId,
        ...(data.pluginMessage === true ? { pluginMessage: true } : {}),
      });
    }
    emitDebug(
      "openclaw.message",
      "message_edited",
      "info",
      { sessionKey, runId: null },
      () => ({
        messageId: messageId ?? null,
        replaced,
        textChars: fullMessageText(content).length,
      }),
    );
    broadcastPages({ reason: "message_edited" });
  }

  onGatewayEvent("message", (data) => {
    if (!sessionService.isCurrentSession(data.sessionKey)) return;
    if (data && data.retag === true) {
      handleNarrationRetag(data);
      return;
    }
    if (data && data.edit === true) {
      handleMessageEdit(data);
      return;
    }
    const runId = data.runId || null;

    const turnActive = data.turnActive === true;
    const dropToolProgressPage = isToolProgressBubble(
      data, data.sessionKey || sessionService.ensureSessionKey(),
    );
    if (dropToolProgressPage) {

      emitDebug(
        "openclaw.message",
        "tool_progress_page_dropped",
        "info",
        {
          sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
          runId,
        },
        () => ({
          messageId: data.id ?? data.messageId ?? null,
          turnActive: data.turnActive === true,
          textChars: fullMessageText(data.content).length,
        }),
      );
      return;
    }

    const dropNarrationPage = isNarrationCommit(data);
    let committedReplyActivity = null;
    if (runId && turnActive) {
      clearStreamingThrottleTimer();
      flushPendingStreamingText();
    }
    if (runId && !turnActive) {
      closeActivityReplayRun(runId);
      if (currentActivityReplayRun?.runId === runId) clearCurrentActivityReplay();

      if (typeof sessionService.markSessionRead === "function") {
        Promise.resolve(
          sessionService.markSessionRead(
            data.sessionKey || sessionService.peekSessionKey(),
          ),
        ).catch(() => {});
      }
      stopTypingForRun(runId, "assistant_message_committed");

      clearStreamingThrottleTimer();
      flushPendingStreamingText();
      broadcastThinkingFinalize(
        runId,
        data.sessionKey,
        "assistant_message_committed",
      );

      const terminalActivity = {
        state: "idle",
        runId,
        sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
        origin: "lifecycle",
        phase: "end",
        category: "run_complete_synth",
        activityId: `run-complete-synth-${runId}`,
      };
      if (data.finalReplyCommitted === true && data.role === "assistant" &&
          typeof data.sessionKey === "string" && data.sessionKey.trim() &&
          !dropNarrationPage && !data.messageKind && normalizeOriginAtMs(data.originAtMs) === null &&
          fullMessageText(sanitizeAssistantContentBlocks(data.content, data.sessionKey)).trim()) {

        committedReplyActivity = { ...terminalActivity, finalReplyCommitted: true };
        if (noteCardBuildFinalReply) {

          noteCardBuildFinalReply({
            sessionKey: data.sessionKey,
            runId,
            text: stripDisplayMarkup(fullMessageText(sanitizeAssistantContentBlocks(data.content, data.sessionKey))),
          });
        }
      } else {
        broadcastActivity(terminalActivity, data.sessionKey ? null : "unattributed");

        if (noteCardBuildLateReply && data.role === "assistant" && typeof data.sessionKey === "string" &&
            data.sessionKey.trim() && !dropNarrationPage && !data.messageKind) {
          const text = stripDisplayMarkup(fullMessageText(sanitizeAssistantContentBlocks(data.content, data.sessionKey)));
          if (text.trim()) noteCardBuildLateReply({ sessionKey: data.sessionKey, runId, text });
        }
      }
    } else if (!runId && !turnActive && noteCardBuildFinalReply && data.role === "assistant" &&
        typeof data.sessionKey === "string" && data.sessionKey.trim() &&
        !dropNarrationPage && !data.messageKind) {

      const text = stripDisplayMarkup(fullMessageText(sanitizeAssistantContentBlocks(data.content, data.sessionKey)));
      if (text.trim()) noteCardBuildFinalReply({ sessionKey: data.sessionKey, runId: null, text });
    }

    const runPipeline = runId && !turnActive ? upstreamRunPipeline.get(runId) : null;
    if (runPipeline) {
      const completedAt = Date.now();
      if (operationRegistry && typeof operationRegistry.markRunPhase === "function") {
        operationRegistry.markRunPhase(runId, "complete");
      }
      emitDebug(
        "relay.protocol",
        "run_complete",
        "debug",
        {
          sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
          runId,
        },
        () => ({
          messageId: runPipeline.messageId,
          sendToCompleteMs: completedAt - runPipeline.sendStartedAt,
          ackToCompleteMs: runPipeline.ackAt ? (completedAt - runPipeline.ackAt) : null,
          runStartToCompleteMs: runPipeline.lifecycleStartAt
            ? (completedAt - runPipeline.lifecycleStartAt)
            : null,
          firstStreamingToCompleteMs: runPipeline.firstStreamingAt
            ? (completedAt - runPipeline.firstStreamingAt)
            : null,
        }),
      );
      upstreamRunPipeline.delete(runId);
    }
    emitDebug(
      "openclaw.run",
      "message",
      "info",
      {
        sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
        runId,
      },
      () => ({
        role: data.role || null,
        contentBlocks: Array.isArray(data.content) ? data.content.length : 0,

        messageKind:
          data && typeof data.messageKind === "string" ? data.messageKind : null,
        turnActive: data && data.turnActive === true,
        notes: normalizeAgentProgressNotes(getAgentProgressNotes()),
        pageDropped: dropNarrationPage,
      }),
    );

    const sanitizedContent =
      data.role === "assistant"
        ? sanitizeAssistantContentBlocks(
            data.content,
            data.sessionKey || sessionService.ensureSessionKey(),
          )
        : data.content;
    const messageMetadata = {
      id: data.id ?? data.messageId,
      runId: data.runId,
      clientSendId: data.clientSendId ?? data.sendId,
      rev: data.rev,
      ...(data.pluginMessage === true ? { pluginMessage: true } : {}),
    };
    if (dropNarrationPage) {

      const narrationId = data.id ?? data.messageId;
      const narrationMessageId = typeof narrationId === "string" && narrationId ? narrationId : null;
      if (
        data.role === "assistant" &&
        narrationMessageId &&
        narrationRecordMessages.delete(narrationRecordsKey(data.sessionKey || sessionService.ensureSessionKey(), runId, narrationMessageId))
      ) {
        paintProgressRecords(data.sessionKey || sessionService.ensureSessionKey(), {
          runId,
          messageId: narrationMessageId,
          text: fullMessageText(data.content),
          end: true,
        });
      }

      emitDebug(
        "openclaw.message",
        "narration_page_dropped",
        "info",
        {
          sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
          runId,
        },
        () => ({
          notes: normalizeAgentProgressNotes(getAgentProgressNotes()),
          textChars: fullMessageText(sanitizedContent).length,
        }),
      );
      broadcastStreamClear(runId, data.sessionKey, "narration_dropped");
      return;
    }

    const v2CommitKey = data.sessionKey || sessionService.ensureSessionKey();
    if (data.role === "assistant" && !isNarrationCommit(data) && isLiveUiV2Session(v2CommitKey)) {

      const runlessReply = !runId && getActiveBackendKind() === "hermes" && data.pluginMessage !== true;
      liveUiV2Step("commit", v2CommitKey, () => {
        if (runlessReply) liveUiRunlessReplyKey = liveUiV2Key(v2CommitKey);
        try {
          liveUiV2Surfaces.commitText(liveUiV2Key(v2CommitKey), {
            runId,
            messageId: typeof data.messageId === "string" ? data.messageId : null,

            text: typeof data.liveUiText === "string" ? data.liveUiText : fullMessageText(data.content),
          });
        } finally {
          liveUiRunlessReplyKey = null;
        }
      });
    }

    if (runId && !turnActive && isLiveUiV2Session(v2CommitKey) && liveUiV2Engine("endReservation")) {
      liveUiV2Step("reservation_end", v2CommitKey, () => liveUiV2Surfaces.endReservation(liveUiV2Key(v2CommitKey)));
    }

    if (runId && !turnActive && isLiveUiV2Session(v2CommitKey) && liveUiV2Engine("endNamedFrame")) {
      liveUiV2Step("named_frame_end", v2CommitKey, () => liveUiV2Surfaces.endNamedFrame(liveUiV2Key(v2CommitKey)));
    }

    const commitOriginAtMs = normalizeOriginAtMs(data.originAtMs);
    if (
      isNarrationCommit(data) ||
      (data.role === "assistant" && commitOriginAtMs !== null)
    ) {

      const reordered = conversationState.addAssistantMessageAtOrigin(
        sanitizedContent,
        commitOriginAtMs,
        null,
        messageMetadata,
      );
      emitDebug(
        "openclaw.message",
        "narration_page_ordered",
        "info",
        {
          sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
          runId,
        },
        () => ({
          originAtMs: commitOriginAtMs,
          narration: isNarrationCommit(data),
          committedAtMs: Date.now(),
          reordered,
          textChars: fullMessageText(sanitizedContent).length,
        }),
      );
    } else {

      const userAuthor =
        data.role === "user" && typeof data.author === "string" && data.author.trim()
          ? data.author.trim()
          : null;
      const origin =
        userAuthor && typeof data.origin === "string" && data.origin.trim() ? data.origin.trim() : null;
      conversationState.addMessage(
        data.role,
        sanitizedContent,
        userAuthor,
        origin ? { ...messageMetadata, origin } : messageMetadata,
      );
    }
    if (committedReplyActivity) broadcastActivity(committedReplyActivity);
    if (data.role === "assistant") {
      emitDebug(
        "openclaw.message",
        "agent_message",
        "info",
        { sessionKey: data.sessionKey || sessionService.ensureSessionKey() },
        () => ({
          text: fullMessageText(sanitizedContent),
          runId: data.runId || null,

          pageOrder: (conversationState.getPages() || [])
            .map((page     ) => (page && typeof page.content === "string" ? page.content : ""))
            .join("\n\n")
            .split("\n\n")
            .slice(-12)

            .map((line     ) => scrubSecretShapes(line.slice(0, 44 + 256)).slice(0, 44)),
        }),
      );
    }
    const preservedLedgerLane = broadcastPages({
      preserveLedgerLane: data.role === "assistant",
      reason: "message_commit",
      sourceRunId: runId,
    });
    if (data.role === "assistant" && preservedLedgerLane) {
      armLedgerCommitFallback(data.sessionKey || sessionService.ensureSessionKey(), runId, 1);
    }

    sessionContextService.refreshActiveSessionContext().catch(() => {});

    const voiceRuntime = getVoiceRuntime();
    if (voiceRuntime && typeof voiceRuntime.onAgentMessage === "function") {
      voiceRuntime.onAgentMessage();
    }
  });

  const runSignals = createRunSignalTracker();
  function broadcastRunSignals(frames       ) {
    for (const frame of frames) {
      if (noteCardBuildRunSignal) noteCardBuildRunSignal(frame);
      if (!sessionService.isCurrentSession(frame.sessionKey)) continue;
      const server = getServer();
      if (!server) continue;
      server.broadcast(handler.formatRunSignal(frame));
      emitDebug(
        "relay.protocol",
        "run_signal_sent",
        "debug",
        { sessionKey: frame.sessionKey, runId: frame.runId },
        () => ({
          signal: frame.signal,
          phase: frame.phase,
          spanId: frame.spanId,
          outcome: frame.outcome || null,
          waitMs: frame.waitMs ?? null,
        }),
      );
    }
  }
  function ingestRunSignal(data     ) {
    broadcastRunSignals(runSignals.ingest(data));
  }
  onGatewayEvent("runSignal", ingestRunSignal);

  onGatewayEvent("sessionCompacted", (data     ) => {
    const sessionKey = data && typeof data.sessionKey === "string" ? data.sessionKey : "";
    if (!sessionKey) return;
    if (isLiveUiV2Session(sessionKey)) {
      const v2Key = liveUiV2Key(sessionKey);
      liveUiV2CompactionsNoted.add(v2Key);
      liveUiV2Step("compaction", v2Key, () => noteLiveUiV2Compaction(v2Key));
    }
    emitDebug(
      "relay.session",
      "session_compacted",
      "info",
      { sessionKey },
      () => ({
        kind: typeof data.kind === "string" ? data.kind : null,
        reason: typeof data.reason === "string" ? data.reason : null,
        inPlace: data.inPlace === true,
        counted: data.counted === true,
        beforeTokens: Number.isFinite(data.beforeTokens) ? data.beforeTokens : null,
        afterTokens: Number.isFinite(data.afterTokens) ? data.afterTokens : null,
      }),
    );
    if (sessionService.isCurrentSession(sessionKey)) {
      sessionContextService.refreshActiveSessionContext().catch(() => {});
    }
  });

  function ingestActivityFrame(data, activitySource      = null) {

    data = quietCancelledRunClose(normalizeGatewaySessionEvent(data));

    if (activitySource !== "simulated" && data && data.origin === "narration" && !data.tool) {
      const armed = noteActivityProse(data);
      emitThinkingStreamDebug(
        armed ? "pre_tool_prose_armed" : "pre_tool_prose_ignored",
        "debug",
        { sessionKey: data.sessionKey || null, runId: data.runId || null },
        () => ({
          textLen: typeof data.summary === "string" ? data.summary.length : 0,
          label: armed ? armed.label : null,
          modelCallSeq: Number.isInteger(data.modelCallSeq) ? data.modelCallSeq : null,
        }),
      );
      return;
    }

    if (activitySource !== "simulated" && data && data.origin === "thinking" &&
      isReasoningHiddenForSession(data.sessionKey)) {
      clearHiddenReasoning();
      emitThinkingStreamDebug(
        "thinking_activity_dropped",
        "debug",
        { sessionKey: data.sessionKey || null, runId: data.runId || null },
        () => ({ reason: "reasoning_off" }),
      );
      return;
    }

    if (activitySource !== "simulated" && data && data.origin === "thinking" &&
      data.thinkingLive === true && !liveProseHeadlines(data)) {
      return;
    }
    if (data && data.origin === "thinking" && data.runId) {
      const finalizedReason = finalizedThinkingRuns.get(data.runId);
      if (finalizedReason && finalizedReason !== "response_started") {
        emitThinkingStreamDebug(
          "thinking_activity_dropped",
          "debug",
          { sessionKey: data.sessionKey || null, runId: data.runId },
          () => ({ reason: `finalized_${finalizedReason}` }),
        );
        return;
      }
    }
    const taskSessionKey =
      data && typeof data._activeRunSessionKey === "string" && data._activeRunSessionKey.trim()
        ? data._activeRunSessionKey
        : data && data.sessionKey;
    if (data && typeof data.tool === "string") {
      observeTaskToolUse({ sessionKey: taskSessionKey, toolName: data.tool });
    }
    noteLiveUiMediaContinuation(data);
    if (noteRunOutcomeFrame && data && data.runId) {
      noteRunOutcomeFrame(data, data.phase || null, data.origin || null);
    }

    if (data && data.runId && classifyRunOutcomeFrame(data, data.phase || null, data.origin || null).terminal) {
      broadcastRunSignals(runSignals.endRun(data.runId));
    }
    rememberActivityPlan(data);

    if (agentBootstrapPending === true && data && data.runId) {
      const bootstrapPhase = data.phase || null;
      const bootstrapRunStart = data.origin === "lifecycle" && bootstrapPhase === "start";
      if (bootstrapRunStart) {

        const timer      = setTimeout(() => {
          if (agentBootstrapPending !== true) return;
          refreshAgentBootstrapPending(agentBootstrapProbeAgentId, "run_start").catch(() => {});
        }, AGENT_BOOTSTRAP_RUN_START_PROBE_DELAY_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
      } else if (isTerminalActivityBoundary(data.state, bootstrapPhase, data.origin || null)) {
        refreshAgentBootstrapPending(agentBootstrapProbeAgentId, "run_end").catch(() => {});
      }
    }
    if (!sessionService.isCurrentSession(data.sessionKey)) {
      if (noteCardBuildOffSessionActivity && data) {
        try {
          noteCardBuildOffSessionActivity(data);
        } catch (_) {

        }
      }
      return;
    }
    const runId = data.runId || null;
    const origin = data.origin || null;
    const phase = data.phase || null;
    if (
      runId &&
      data.state === "thinking" &&
      origin === "lifecycle" &&
      phase === "start"
    ) {
      startTyping(runId, data.sessionKey, "lifecycle_start");
      const now = Date.now();
      const runPipeline = upstreamRunPipeline.get(runId);
      if (runPipeline && !runPipeline.lifecycleStartAt) {
        runPipeline.lifecycleStartAt = now;
      }
      if (operationRegistry && typeof operationRegistry.markRunPhase === "function") {
        operationRegistry.markRunPhase(runId, "lifecycle_start");
      }
      emitDebug(
        "relay.protocol",
        "run_lifecycle_start",
        "debug",
        { sessionKey: data.sessionKey || sessionService.ensureSessionKey(), runId },
        () => ({
          messageId: runPipeline ? runPipeline.messageId : null,
          sendToRunStartMs: runPipeline ? (now - runPipeline.sendStartedAt) : null,
          ackToRunStartMs: runPipeline && runPipeline.ackAt ? (now - runPipeline.ackAt) : null,
        }),
      );

      cachedRunActiveSessionKey = data.sessionKey || sessionService.ensureSessionKey();
      sessionContextService.broadcastRunActive(true);
    }
    if (runId && isTerminalActivityBoundary(data.state, phase, origin)) {
      broadcastThinkingFinalize(
        runId,
        data.sessionKey,
        phase === "error" ? "terminal_error" : "terminal_activity",
      );
      stopTypingForRun(runId, "terminal_activity_boundary");

      if (cachedRunActiveSessionKey) {
        cachedRunActiveSessionKey = null;
        sessionContextService.broadcastRunActive(false);
        sessionContextService.refreshActiveSessionContext().catch(() => {});
      }

      if (!activeProviderContext().provider || getActiveBackendKind() === "hermes") {
        sessionService.getCurrentSessionModelConfig().catch((err) => {
          logger.warn(
            `[relay] Provider re-resolve after run-end failed: ${err && err.message ? err.message : err}`,
          );
        });
      }
    }
    let activity = data;
    let shouldRefreshProviderUsageInBackground = false;

    if (isProviderRateLimitedLifecycleError(data) && !saysAccountUsageIsNotExhausted(data)) {
      if (!data.failoverPending) {
        const { provider: outcomeProvider } = activeProviderContext();
        if (outcomeProvider) {
          providerOutcomeState.set(outcomeProvider, {
            lastOutcome: "exhausted",
            lastOutcomeAtMs: now(),
          });
        }
      }
      const rateLimitInfo = buildRateLimitInfoFromSnapshot(projectProviderUsageSnapshot());
      if (rateLimitInfo) {
        activity = {
          ...data,
          rateLimitInfo,
        };
      } else {
        shouldRefreshProviderUsageInBackground = true;
      }
    }
    if (activitySource !== "simulated" && origin === "thinking" && runId) {
      visibleReasoningRuns.set(runId, data.sessionKey);
    }
    broadcastActivity(activity, activitySource);
    if (activitySource !== "simulated") rememberCurrentActivity(activity);
    if (shouldRefreshProviderUsageInBackground) {
      refreshProviderUsage(true).catch((err) => {
        logger.warn(`[relay] Provider usage refresh failed after rate limit activity: ${err.message}`);
      });
    }

    const runFailed = data.isError === true && phase === "error";
    const endedWithoutReply = runFailed || (data.aborted === true && phase === "end");
    if (runId && data.state === "idle" && endedWithoutReply) {

      const v2AbortKey = data.sessionKey || sessionService.ensureSessionKey();
      if (isLiveUiV2Session(v2AbortKey)) {
        liveUiV2Step("abort", v2AbortKey, () => {

          if (pendingStreaming && pendingStreaming.runId === runId) {
            liveUiV2Surfaces.streamText(liveUiV2Key(v2AbortKey), {
              runId,
              messageIndex: pendingStreaming.messageIndex,
              messageId: pendingStreaming.messageId || null,
              text: pendingStreaming.rawText,
            });
          }

          liveUiV2Surfaces.abortRun(liveUiV2Key(v2AbortKey), runId, runFailed ? "failed" : "cancelled");
          if (liveUiV2Engine("endReservation")) liveUiV2Surfaces.endReservation(liveUiV2Key(v2AbortKey));
        });
      }
      upstreamRunPipeline.delete(runId);

      if (cachedRunActiveSessionKey) {
        cachedRunActiveSessionKey = null;
        sessionContextService.broadcastRunActive(false);
        sessionContextService.refreshActiveSessionContext().catch(() => {});
      }
    }

    if (runId && runFailed && !data.failoverPending && getActiveBackendKind() !== "hermes" &&
        !isCancelledRunFrame(data) && activitySource !== "simulated" &&
        sessionService.isCurrentSession(data.sessionKey)) {
      const streamedText = pendingStreaming && pendingStreaming.runId === runId
        ? pendingStreaming.rawText
        : null;
      if (typeof conversationState.recordFailedTurn === "function" &&
          conversationState.recordFailedTurn({ runId, code: data.code, streamedText })) {
        emitDebug("openclaw.history", "failed_turn_recorded", "info",
          { sessionKey: data.sessionKey || sessionService.ensureSessionKey(), runId },
          () => ({ code: data.code || null, streamedChars: streamedText ? String(streamedText).length : 0 }));
        broadcastPages({ reason: "failed_turn" });
      }
    }

    if (runId && classifyRunOutcomeFrame(data, phase, origin).terminal) {
      const v2EndKey = data.sessionKey || sessionService.ensureSessionKey();
      if (isLiveUiV2Session(v2EndKey)) liveUiV2Step("taps_read", v2EndKey, () => liveUiV2TapsRead(v2EndKey, runId));
    }
  }
  gatewayBridge.on("activity", ingestActivityFrame);

  function synthesizeResponseStarted(runId = "", sessionKey = "") {
    if (typeof runId !== "string" || !runId.trim()) return false;
    const normalizedRunId = runId.trim();
    stopTypingForRun(normalizedRunId, "first_visible_assistant_progress");
    return broadcastThinkingFinalize(
      normalizedRunId,
      sessionKey,
      "response_started",
    );
  }

  function resolveThinkingFrameSessionKey(runId, explicitSessionKey) {
    if (typeof explicitSessionKey === "string" && explicitSessionKey.trim()) {
      return explicitSessionKey.trim();
    }
    if (typeof runId !== "string" || !runId.trim()) return null;
    const runPipeline = upstreamRunPipeline.get(runId.trim());
    return runPipeline &&
      typeof runPipeline.sessionKey === "string" &&
      runPipeline.sessionKey.trim()
      ? runPipeline.sessionKey.trim()
      : null;
  }

  function normalizeThinkingFrame(data, phase) {
    const source = data && typeof data === "object" ? data : {};
    const runId =
      typeof source.runId === "string" && source.runId.trim()
        ? source.runId.trim()
        : null;
    const explicitSessionKey =
      typeof source.sessionKey === "string" && source.sessionKey.trim()
        ? source.sessionKey.trim()
        : null;
    const sessionKey = resolveThinkingFrameSessionKey(runId, explicitSessionKey);
    if (!sessionKey) return null;

    const rawSeq = source.seq;
    const seq =
      typeof rawSeq === "number" && Number.isInteger(rawSeq) && rawSeq >= 0
        ? rawSeq
        : null;
    const frame = {
      phase,
      sessionKey,
      runId,
      ...(seq === null ? {} : { seq }),
    };
    if (phase === "update") {
      frame.text = typeof source.text === "string" ? source.text : "";
      if (typeof source.delta === "string") frame.delta = source.delta;
      if (typeof source.presentation === "string") {

        Object.assign(frame, { presentation: source.presentation });
      }
      if (typeof source.progressNoteId === "string" && source.progressNoteId.trim()) {
        Object.assign(frame, { progressNoteId: source.progressNoteId.trim() });
      }

      if (Array.isArray(source.speckFeelings) && source.speckFeelings.length) {
        Object.assign(frame, { speckFeelings: source.speckFeelings.slice() });
      }
      if (typeof source.summary === "string") frame.summary = source.summary;
      if (typeof source.thinkingSummarySource === "string") {
        frame.thinkingSummarySource = source.thinkingSummarySource;
      }
      if (typeof source.thinkingSignatureId === "string") {
        frame.thinkingSignatureId = source.thinkingSignatureId;
      }
      if (typeof source.source === "string") frame.source = source.source;
    } else {
      frame.reason = typeof source.reason === "string" ? source.reason : "finalize";
    }
    return frame;
  }

  const emitThinkingStreamDebug = emitDebug.bind(null, "thinking.stream");

  function broadcastThinkingUpdate(data) {
    const frame = normalizeThinkingFrame(data, "update");
    if (!frame) {
      emitDebug(
        "openclaw.run",
        "thinking_ignored",
        "debug",
        { sessionKey: null, runId: data && data.runId ? data.runId : null },
        () => ({
          reason: "unknown_sessionless_run",
          phase: "update",
          textChars: data && typeof data.text === "string" ? data.text.length : 0,
        }),
      );
      emitThinkingStreamDebug(
        "thinking_update_dropped",
        "debug",
        { sessionKey: null, runId: (data && data.runId) || null },
        () => ({
          reason: "unknown_sessionless_run",
          source: data && typeof data.source === "string" ? data.source : null,
          seq: data && Number.isInteger(data.seq) ? data.seq : null,
          textLen: data && typeof data.text === "string" ? data.text.length : 0,
        }),
      );
      return;
    }

    const streamRow = {
      source: typeof data.source === "string" ? data.source : null,
      seq: Number.isInteger(data.seq) ? data.seq : null,
      textLen: typeof data.text === "string" ? data.text.length : 0,
      deltaLen: typeof data.delta === "string" ? data.delta.length : 0,
    };
    const ctx = { sessionKey: frame.sessionKey, runId: frame.runId };
    if (!sessionService.isCurrentSession(frame.sessionKey)) {
      emitThinkingStreamDebug("thinking_update_dropped", "debug", ctx, () => ({
        reason: "not_current_session",
        ...streamRow,
      }));
      return;
    }

    const progressNote = data.presentation === "progress_note";
    const hiddenReason = progressNote
      ? normalizeAgentProgressNotes(getAgentProgressNotes()) === "off" ? "notes_off" : null
      : data.source !== "simulate" && isReasoningHiddenForSession(frame.sessionKey) ? "reasoning_off" : null;
    if (hiddenReason) {
      if (hiddenReason === "reasoning_off") clearHiddenReasoning();
      emitThinkingStreamDebug("thinking_update_dropped", "debug", ctx, () => ({
        reason: hiddenReason,
        ...streamRow,
      }));
      return;
    }

    if (data.presentation === "progress_note" && isLiveUiV2Session(frame.sessionKey)) {
      Object.assign(frame, {
        text: stripNoteRecords(data.text),
        ...(typeof data.delta === "string" ? { delta: stripNoteRecords(data.delta) } : {}),
      });
    }

    if (progressNote) {
      const note = frame                                       ;
      const sentence = (value         ) => progressNoteInActionVoice(splitBoldHeading(value).text ?? value);
      Object.assign(frame, {
        text: sentence(note.text),
        ...(typeof note.delta === "string" ? { delta: sentence(note.delta) } : {}),
      });
    }
    if (!frame.text) {
      emitThinkingStreamDebug("thinking_update_dropped", "debug", ctx, () => ({
        reason: "empty_text",
        ...streamRow,
      }));
      return;
    }
    if (frame.runId) {
      const finalizedReason = finalizedThinkingRuns.get(frame.runId);
      if (finalizedReason) {
        if (finalizedReason !== "response_started") {
          emitThinkingStreamDebug("thinking_update_dropped", "debug", ctx, () => ({
            reason: `finalized_${finalizedReason}`,
            ...streamRow,
          }));
          return;
        }
        forgetFinalizedThinkingRun(frame.runId);
      }
      activeThinkingRuns.add(frame.runId);
      if (!progressNote && data.source !== "simulate") {
        visibleReasoningRuns.set(frame.runId, frame.sessionKey);
      }
    }
    if (!progressNote && data.source !== "simulate" && noteCardBuildReasoning) {
      noteCardBuildReasoning({ sessionKey: frame.sessionKey, runId: frame.runId });
    }
    if (progressNote && noteCardBuildAgentNote) {
      noteCardBuildAgentNote({ sessionKey: frame.sessionKey, runId: frame.runId, text: Reflect.get(frame, "text") });
    }
    const server = getServer();
    if (server) {
      server.broadcast(handler.formatThinkingUpdate(frame));
    }
    emitThinkingStreamDebug("thinking_update", "debug", ctx, () => ({
      reason: server ? null : "no_client_server",
      ...streamRow,
    }));
  }

  function broadcastThinkingFinalize(runId, sessionKey, reason, seq = null) {
    if (typeof runId !== "string" || !runId.trim()) return false;
    const normalizedRunId = runId.trim();
    const frame = normalizeThinkingFrame(
      {
        runId: normalizedRunId,
        sessionKey,
        reason,
        seq,
      },
      "finalize",
    );
    if (!frame) {
      emitDebug(
        "openclaw.run",
        "thinking_ignored",
        "debug",
        { sessionKey: null, runId: normalizedRunId },
        () => ({
          reason: "unknown_sessionless_run",
          phase: "finalize",
        }),
      );
      emitThinkingStreamDebug(
        "thinking_finalize_dropped",
        "debug",
        { sessionKey: null, runId: normalizedRunId },
        () => ({
          reason: "unknown_sessionless_run",
          finalizeReason: typeof reason === "string" ? reason : null,
          seq: Number.isInteger(seq) ? seq : null,
        }),
      );
      return false;
    }

    const finalizeRow = {
      finalizeReason: typeof reason === "string" && reason ? reason : "finalize",
      seq: Number.isInteger(seq) ? seq : null,
    };
    const ctx = { sessionKey: frame.sessionKey, runId: normalizedRunId };
    if (!sessionService.isCurrentSession(frame.sessionKey)) {
      emitThinkingStreamDebug("thinking_finalize_dropped", "debug", ctx, () => ({
        reason: "not_current_session",
        ...finalizeRow,
      }));
      return false;
    }
    if (reason === "response_started" && currentActivityReplayRun?.runId === normalizedRunId) {

      currentActivityReplay = null;
    }
    if (reason !== "response_started") visibleReasoningRuns.delete(normalizedRunId);
    const finalizedReason = finalizedThinkingRuns.get(normalizedRunId);
    const canHardenSoftFinalize =
      finalizedReason === "response_started" && frame.reason !== "response_started";
    if (!activeThinkingRuns.has(normalizedRunId) && !canHardenSoftFinalize) {

      if (reason !== "response_started") rememberFinalizedThinkingRun(normalizedRunId, reason);
      emitThinkingStreamDebug("thinking_finalize_dropped", "debug", ctx, () => ({
        reason: "no_open_pane",
        ...finalizeRow,
      }));
      return false;
    }
    if (finalizedReason && !canHardenSoftFinalize) {
      emitThinkingStreamDebug("thinking_finalize_dropped", "debug", ctx, () => ({
        reason: `already_finalized_${finalizedReason}`,
        ...finalizeRow,
      }));
      return false;
    }
    const server = getServer();
    if (server) {
      server.broadcast(handler.formatThinkingFinalize(frame));
    }
    emitThinkingStreamDebug("thinking_finalize", "debug", ctx, () => ({
      reason: server ? null : "no_client_server",
      ...finalizeRow,
    }));
    rememberFinalizedThinkingRun(normalizedRunId, frame.reason);
    activeThinkingRuns.delete(normalizedRunId);
    return true;
  }

  function rememberFinalizedThinkingRun(runId, reason) {
    if (finalizedThinkingRunTimers.has(runId)) {
      clearTimeout(finalizedThinkingRunTimers.get(runId));
    }
    finalizedThinkingRuns.set(runId, reason || "finalize");
    const timer = setTimeout(() => {
      finalizedThinkingRuns.delete(runId);
      finalizedThinkingRunTimers.delete(runId);
    }, THINKING_FINALIZE_RETENTION_MS);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    finalizedThinkingRunTimers.set(runId, timer);
  }

  function forgetFinalizedThinkingRun(runId) {
    if (finalizedThinkingRunTimers.has(runId)) {
      clearTimeout(finalizedThinkingRunTimers.get(runId));
      finalizedThinkingRunTimers.delete(runId);
    }
    finalizedThinkingRuns.delete(runId);
  }

  function clearThinkingRunState() {
    activeThinkingRuns.clear();
    visibleReasoningRuns.clear();
    finalizedThinkingRuns.clear();
    for (const timer of finalizedThinkingRunTimers.values()) {
      clearTimeout(timer);
    }
    finalizedThinkingRunTimers.clear();
  }

  function isReasoningHiddenForSession(sessionKey     ) {
    if (typeof sessionService.peekSessionReasoningLevel !== "function") return false;
    const key = typeof sessionKey === "string" && sessionKey.trim()
      ? sessionKey
      : typeof sessionService.peekSessionKey === "function" ? sessionService.peekSessionKey() : null;
    return sessionService.peekSessionReasoningLevel(key) === "off";
  }

  function clearHiddenReasoning() {
    for (const [runId, sessionKey] of visibleReasoningRuns) {
      if (!sessionService.isCurrentSession(sessionKey) || !isReasoningHiddenForSession(sessionKey)) continue;
      const server = getServer();
      if (server) {
        server.broadcast(handler.formatThinkingFinalize({ runId, sessionKey, reason: "reasoning_off" }));
      }

      visibleReasoningRuns.delete(runId);
      emitThinkingStreamDebug("thinking_reasoning_cleared", "debug", { runId, sessionKey }, () => ({
        reason: "reasoning_off",
      }));
    }
  }

  onGatewayEvent("thinking", (data) => {
    const phase =
      data && typeof data.phase === "string" && data.phase.trim()
        ? data.phase.trim()
        : "update";
    if (phase === "finalize") {
      broadcastThinkingFinalize(
        data && data.runId,
        data && data.sessionKey,
        data && data.reason,
        data && data.seq,
      );
      return;
    }
    broadcastThinkingUpdate(data);
  });

  function paintProgressRecords(sessionKey     , input     ) {
    const text = input && typeof input.text === "string" ? input.text : "";
    const messageId = input && typeof input.messageId === "string" && input.messageId ? input.messageId : null;
    if (!messageId || !text.includes("<ui") || !isLiveUiV2Session(sessionKey)) return false;
    const key = liveUiV2Key(sessionKey);
    const runId = input.runId || null;
    const messageIndex = Number.isInteger(input.messageIndex) ? input.messageIndex : null;

    if (input.end !== true || messageIndex !== null) {
      liveUiV2Step("progress_stream", sessionKey, () => {
        liveUiV2Surfaces.streamText(key, { runId, messageIndex, messageId, text });
      });
    }
    if (input.end === true) {
      liveUiV2Step("progress_commit", sessionKey, () => liveUiV2Surfaces.commitText(key, { runId, messageId, text }));
    }
    return true;
  }

  const narrationRecordMessages = new Set        ();
  const narrationRecordsKey = (sessionKey     , runId     , messageId     ) =>
    JSON.stringify([liveUiV2Key(sessionKey), runId || null, messageId]);

  onGatewayEvent("streaming", (data) => {
    if (isTitleDistillerStreamingEvent(data)) {
      const runId = data && data.runId ? data.runId : null;
      const sessionKey = data && data.sessionKey ? data.sessionKey : sessionService.ensureSessionKey();
      emitDebug(
        "openclaw.run",
        "streaming_ignored",
        "debug",
        { sessionKey, runId },
        () => ({
          reason: "title_distiller",
          textChars: typeof data.text === "string" ? data.text.length : 0,
        }),
      );
      return;
    }
    const runId = data.runId || null;
    const runPipeline = runId ? upstreamRunPipeline.get(runId) : null;
    const explicitSessionKey =
      data && typeof data.sessionKey === "string" && data.sessionKey.trim()
        ? data.sessionKey.trim()
        : null;
    const pipelineSessionKey =
      runPipeline &&
      typeof runPipeline.sessionKey === "string" &&
      runPipeline.sessionKey.trim()
        ? runPipeline.sessionKey.trim()
        : null;
    const sessionKey =
      explicitSessionKey ||
      pipelineSessionKey;
    if (!sessionKey) {
      emitDebug(
        "openclaw.run",
        "streaming_ignored",
        "debug",
        { sessionKey: null, runId },
        () => ({
          reason: "unknown_sessionless_run",
          textChars: typeof data.text === "string" ? data.text.length : 0,
        }),
      );
      return;
    }
    if (!sessionService.isCurrentSession(sessionKey)) return;

    if (data.liveUiRecordsOnly === true) {
      paintProgressRecords(sessionKey, {
        runId,
        messageIndex: data.messageIndex,
        messageId: data.messageId,
        text: data.text,
        end: data.end === true,
      });
      return;
    }
    const { provider: outcomeProvider } = activeProviderContext();
    if (outcomeProvider) {
      providerOutcomeState.set(outcomeProvider, {
        lastOutcome: "ready",
        lastOutcomeAtMs: now(),
      });
    }
    const nowMs = now();
    const gatewayReceivedAtMs = Number.isFinite(data.gatewayReceivedAtMs)
      ? Math.floor(data.gatewayReceivedAtMs)
      : null;
    const rawAssistantChars = Number.isFinite(data.rawAssistantChars)
      ? Math.max(0, Math.floor(data.rawAssistantChars))
      : (typeof data.text === "string" ? data.text.length : null);
    const assistantDeltaChars = Number.isFinite(data.assistantDeltaChars)
      ? Math.max(0, Math.floor(data.assistantDeltaChars))
      : null;
    const firstGatewayChunk =
      typeof data.firstGatewayChunk === "boolean" ? data.firstGatewayChunk : null;
    if (runId) {
      if (runPipeline && !runPipeline.firstStreamingAt) {
        runPipeline.firstStreamingAt = nowMs;
        runPipeline.firstGatewayReceivedAt = gatewayReceivedAtMs;
        runPipeline.firstGatewayChars = rawAssistantChars;
        if (operationRegistry && typeof operationRegistry.markRunPhase === "function") {
          operationRegistry.markRunPhase(runId, "first_stream");
        }
        emitDebug(
          "relay.protocol",
          "run_first_streaming",
          "debug",
          { sessionKey, runId },
          () => ({
            messageId: runPipeline.messageId,
            sendToFirstStreamingMs: nowMs - runPipeline.sendStartedAt,
            ackToFirstStreamingMs: runPipeline.ackAt ? (nowMs - runPipeline.ackAt) : null,
            runStartToFirstStreamingMs: runPipeline.lifecycleStartAt
              ? (nowMs - runPipeline.lifecycleStartAt)
              : null,
            firstGatewayChars: rawAssistantChars,
            gatewayToRelayIngressMs:
              gatewayReceivedAtMs != null ? (nowMs - gatewayReceivedAtMs) : null,
          }),
        );
      }
    }

    if (isToolProgressBubble(data, sessionKey)) {
      emitDebug(
        "openclaw.message",
        "tool_progress_stream_withheld",
        "info",
        { sessionKey, runId },
        () => ({
          textChars: typeof data.text === "string" ? data.text.length : 0,
        }),
      );
      return;
    }

    if (isNarrationCommit(data)) {
      const notes = normalizeAgentProgressNotes(getAgentProgressNotes());
      if (notes === "conversation") {

        const noteText = typeof data.text === "string" ? stripDisplayMarkup(data.text) : "";
        const feelings = typeof data.text === "string" ? speckFeelings(data.text) : [];
        broadcastThinkingUpdate({
          runId,
          sessionKey,
          text: noteText,
          delta: noteText,
          ...(feelings.length ? { speckFeelings: feelings } : {}),
          presentation: "progress_note",
          progressNoteId:
            typeof data.messageId === "string" ? data.messageId : undefined,
          source: "hermes.narration",
        });
      }

      const recordsPainted = paintProgressRecords(sessionKey, { runId, messageId: data.messageId, text: data.text });
      if (recordsPainted) {
        narrationRecordMessages.add(narrationRecordsKey(sessionKey, runId, data.messageId));
        if (narrationRecordMessages.size > 256) {
          narrationRecordMessages.delete(narrationRecordMessages.values().next().value          );
        }
      }
      emitDebug(
        "openclaw.message",
        "narration_stream_withheld",
        "info",
        { sessionKey, runId },
        () => ({
          notes,
          textChars: typeof data.text === "string" ? data.text.length : 0,
          recordsPainted,
        }),
      );
      return;
    }
    const prefix = `${agentIdentity.name || "Agent"}: `;

    const messageIndex =
      Number.isInteger(data.messageIndex) && data.messageIndex >= 0
        ? data.messageIndex
        : streamMessageIndexFromId(runId, data.messageId);

    if (
      pendingStreaming &&
      messageIndex != null &&
      pendingStreaming.messageIndex != null &&
      pendingStreaming.runId === runId &&
      pendingStreaming.messageIndex < messageIndex
    ) {
      pendingStreaming.flushReason = "message_boundary";
      flushPendingStreamingText();
    }
    pendingStreaming = {
      rawText: data.text,
      prefix,
      sessionKey,
      runId,
      messageIndex,
      messageId: typeof data.messageId === "string" ? data.messageId : null,
      rawAssistantChars,
      assistantDeltaChars,
      firstGatewayChunk,
      gatewayReceivedAtMs,
      flushReason: "throttled_flush",
    };
    emitDebug(
      "openclaw.run",
      "streaming",
      "debug",
      {
        sessionKey,
        runId,
      },
      () => ({

        textChars: pendingStreaming ? pendingStreaming.rawText.length : 0,
        rawAssistantChars,
        assistantDeltaChars,
        firstGatewayChunk,
        gatewayReceivedAtMs,
        gatewayToRelayIngressMs:
          gatewayReceivedAtMs != null ? (nowMs - gatewayReceivedAtMs) : null,
      }),
    );

    if (!streamingThrottleTimer) {
      if (pendingStreaming) {
        pendingStreaming.flushReason = "first_immediate";
      }
      flushPendingStreamingText();
      streamingThrottleTimer = setTimeout(() => {
        streamingThrottleTimer = null;
        flushPendingStreamingText();
      }, STREAMING_REBROADCAST_THROTTLE_MS);
    }
  });

  onGatewayEvent("status", (statusString) => {
    if (statusString !== "connected") flushLedgerCommitFallback();
    applyConnectedStatus(statusString === "connected", "status_event");
  });

  onGatewayEvent("agentIdentity", (data) => {
    applyAgentIdentity(data, "agent_identity_event");
  });

  onGatewayEvent("connected", () => {
    refreshUpstreamBootstrap("connected_event").catch((err) => {
      logger.warn(`[relay] Upstream connected bootstrap failed: ${err.message}`);
    });

    sessionContextService.resetConnectionCapabilities();
    sessionContextService.refreshActiveSessionContext().catch(() => {});
  });

  onGatewayEvent("timing", (rawEvent) => {
    const timing = normalizeGatewayTimingEvent(rawEvent);
    emitDebug(
      timing.category,
      timing.event,
      timing.severity,
      timing.context,
      () => timing.data,
    );
  });

  onGatewayEvent("protocol", (data) => {
    emitDebug(
      "relay.protocol",
      "protocol_frame",
      "debug",
      { sessionKey: sessionService.ensureSessionKey() },
      () => ({
        direction: data.direction || null,
        frameType: data.frame && data.frame.type ? data.frame.type : null,
      }),
    );
    const server = getServer();
    if (!server) return;
    const msg = handler.formatProtocol(data.direction, data.frame);
    for (const clientId of server.getClientIds()) {
      if (handler.isProtocolSubscriber(clientId)) {
        server.unicast(clientId, msg);
      }
    }
  });

  onGatewayEvent("approval", (data) => {
    rememberTaskApproval(data);
    emitDebug(
      "approvals.timeline",
      "approval_requested",
      "info",
      { sessionKey: sessionService.ensureSessionKey() },
      () => {
        const request = data && data.request ? data.request : {};
        const approvalKind =
          data && data.approvalKind === "plugin"
            ? "plugin"
            : data && typeof data.id === "string" && data.id.startsWith("plugin:")
              ? "plugin"
              : "exec";
        const command =
          typeof request.command === "string"
            ? request.command
            : approvalKind === "plugin" && typeof request.title === "string"
              ? request.title
              : "";
        return {
          approvalId: data && data.id ? data.id : null,
          approvalKind,
          host: typeof request.host === "string" ? request.host : null,
          commandLength: command.length,
          requestCommandIsEmpty: command.length === 0,
          hasSystemRunPlan: !!(request.systemRunPlan && typeof request.systemRunPlan === "object"),
        };
      },
    );

    if (takeWaitingApproval(data)) return;
    const server = getServer();
    if (server) {
      const key = data && data.request && data.request.sessionKey;
      if (typeof key === "string" && key.startsWith("hermes:")) {
        if (!sessionService.isCurrentSession(key)) return;
        displayedHermesApprovals.add(data.id);
      }
      server.broadcast(handler.formatApproval(data));
      explainApprovalLater(data);
    }
  });

  function explainApprovalLater(data     ) {
    if (!approvalExplainer || !data || typeof data.id !== "string" || !data.id) return;
    const request = data.request && typeof data.request === "object" ? data.request : {};

    if (
      typeof request.sessionKey === "string" &&
      request.sessionKey.startsWith("hermes:") &&
      !displayedHermesApprovals.has(data.id)
    ) {
      return;
    }

    if (request.botScreen && typeof request.botScreen === "object") return;
    const codex = codexAppServerApprovalCommand(request);
    const command = codex ? codex.command : approvalExplainCommand(data, request);
    if (!command) return;
    const cwd = codex && codex.cwd ? codex.cwd : typeof request.cwd === "string" ? request.cwd : "";
    const approvalId = data.id;
    approvalsAwaitingExplanation.add(approvalId);
    const analysis = request.commandAnalysis && typeof request.commandAnalysis === "object"
      ? request.commandAnalysis
      : null;

    let pendingShown = false;
    const sendPending = (pending         ) => {
      if (typeof handler.formatApprovalExplanationPending !== "function") return;
      const frame = handler.formatApprovalExplanationPending({ id: approvalId, pending });
      const server = getServer();
      if (frame && server) server.broadcast(frame);
    };
    const settleWithout = () => {
      if (approvalsAwaitingExplanation.delete(approvalId) && pendingShown) sendPending(false);
    };
    Promise.resolve(
      approvalExplainer.explain(
        {
          id: approvalId,
          command,
          cwd,
          agentId: typeof request.agentId === "string" ? request.agentId : "",
          warningLines: analysis && Array.isArray(analysis.warningLines) ? analysis.warningLines : [],
          context: data.ocuclawApprovalContext || null,
        },
        {
          onPending: () => {
            if (!approvalsAwaitingExplanation.has(approvalId)) return;
            pendingShown = true;
            sendPending(true);
          },
        },
      ),
    )
      .then((explanation     ) => {
        if (!explanation) {
          settleWithout();
          return;
        }
        if (!approvalsAwaitingExplanation.delete(approvalId)) return;
        if (typeof handler.formatApprovalExplanation !== "function") return;
        const frame = handler.formatApprovalExplanation({ id: approvalId, explanation });
        const server = getServer();
        if (frame && server) server.broadcast(frame);
        emitDebug(
          "approvals.timeline",
          "approval_explained",
          "info",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({ approvalId, explanationLength: explanation.length }),
        );
      })
      .catch(settleWithout);
  }

  function approvalExplainCommand(data     , request     ) {
    if (typeof request.command === "string" && request.command.trim()) {
      const isPlugin =
        data.approvalKind === "plugin" || (typeof data.id === "string" && data.id.startsWith("plugin:"));
      if (!isPlugin) return request.command;
    }
    if (request.systemRunPlan && typeof request.systemRunPlan.commandText === "string") {
      return request.systemRunPlan.commandText;
    }
    if (typeof request.description === "string" && request.description.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(request.description);
        if (parsed && typeof parsed.command === "string") return parsed.command;
      } catch {

      }
    }
    return "";
  }

  onGatewayEvent("approvalResolved", (data) => {

    observeWaitingApprovalResolved(data);
    const approvalId = data && typeof data.id === "string" ? data.id.trim() : "";
    const correlated = approvalId ? taskApprovalRequests.get(approvalId) : null;
    const outcome = data && typeof data.decision === "string" ? data.decision : "";
    if (correlated && outcome) {
      observeTaskApproval({
        sessionKey: correlated.sessionKey,
        toolName: correlated.toolName,
        outcome,
      });
    }
    if (approvalId) taskApprovalRequests.delete(approvalId);
    displayedHermesApprovals.delete(approvalId);
    approvalsAwaitingExplanation.delete(approvalId);
    emitDebug(
      "approvals.timeline",
      "approval_resolved",
      "info",
      { sessionKey: sessionService.ensureSessionKey() },
      () => ({
        approvalId: data && data.id ? data.id : null,
        decision: data && data.decision ? data.decision : null,
      }),
    );
    const server = getServer();
    if (server) {
      server.broadcast(handler.formatApprovalResolved(data));
    }
  });

  onGatewayEvent("sessionAttention", (data     ) => {
    if (!data || !sessionService.isCurrentSession(data.sessionKey)) return;
    if (typeof data.runActive === "boolean") {
      cachedRunActiveSessionKey = data.runActive ? data.sessionKey : null;
      if (!data.runActive) clearCurrentActivityReplay();
      sessionContextService.broadcastRunActive(data.runActive);
    }
    onSessionAttention(data);
    const server = getServer();
    if (!server) return;
    const approvals = Array.isArray(data.approvals) ? data.approvals : [];
    const live = new Set(approvals.map((entry     ) => entry.id));
    for (const id of displayedHermesApprovals) {
      if (!live.has(id)) {

        server.broadcast(handler.formatApprovalResolved({ id, decision: null }));
        displayedHermesApprovals.delete(id);
      }
    }
    for (const entry of approvals) {
      if (entry.expiresAtMs > Date.now() && !displayedHermesApprovals.has(entry.id)) {
        server.broadcast(handler.formatApproval(entry));
        displayedHermesApprovals.add(entry.id);
      }
    }
  });

  onGatewayEvent("sessionsGone", (data     ) => {
    onSessionsGone(data);
  });

  onGatewayEvent("waiting", publishWaiting);
  function publishWaiting(data     ) {
    const normalized = normalizeWaitingPayload(data);
    if (!normalized) {
      logger.debug?.("[relay] waiting event without an items list; ignored");
      return;
    }
    cachedWaitingItems = normalized.items;
    cachedWaitingHost = normalized.host || null;
    emitDebug(
      "approvals.timeline",
      "waiting_snapshot",
      "info",
      { sessionKey: null },
      () => ({
        count: normalized.items.length,
        kinds: normalized.items.map((item     ) => item.kind),
        surfaces: normalized.items.map((item     ) => item.surface),
        cleared: normalized.cleared ? normalized.cleared.outcome : null,
      }),
    );
    const server = getServer();
    if (server) server.broadcast(formatWaiting(normalized));
    explainWaitingApprovals(data.items, normalized.items);
  }

  function explainWaitingApprovals(rawItems       , items       ) {
    const live = new Set(items.map((item     ) => item.requestId));
    for (const requestId of waitingExplanations.keys()) {
      if (!live.has(requestId)) waitingExplanations.delete(requestId);
    }
    if (!approvalExplainer) return;
    const inputs = new Map();
    for (const raw of rawItems) {
      const input = waitingExplainInput(raw);
      if (input && live.has(input.requestId) && !inputs.has(input.requestId)) {
        inputs.set(input.requestId, input);
      }
    }
    for (const item of items) {
      if (item.kind !== "approval") continue;
      const input = inputs.get(item.requestId);

      if (!input) {
        waitingExplanations.delete(item.requestId);
        continue;
      }
      if (!waitingExplanations.has(item.requestId)) explainWaitingApproval(input);
    }
  }

  function explainWaitingApproval(input     ) {
    const requestId = input.requestId;
    const entry                                             = { state: "asked", sentence: null };
    waitingExplanations.set(requestId, entry);
    const current = () => waitingExplanations.get(requestId) === entry;
    const send = (state        , sentence         ) => {
      const frame = formatWaitingExplanation({ requestId, state, sentence });
      const server = getServer();
      if (frame && server) server.broadcast(frame);
    };

    const settleWithout = () => {
      if (!current()) return;
      const pendingShown = entry.state === "pending";
      entry.state = "none";
      if (pendingShown) send("done");
    };
    Promise.resolve(
      approvalExplainer.explain(
        {
          id: `waiting:${requestId}`,
          command: input.command,
          cwd: "",
          warningLines: input.warningLines,
          context: input.context,
        },
        {
          onPending: () => {
            if (!current()) return;
            entry.state = "pending";
            send("pending");
          },
        },
      ),
    )
      .then((sentence     ) => {
        if (typeof sentence !== "string" || !sentence) {
          settleWithout();
          return;
        }
        if (!current()) return;
        entry.state = "done";
        entry.sentence = sentence;
        send("done", sentence);
        emitDebug(
          "approvals.timeline",
          "waiting_explained",
          "info",
          { sessionKey: null },
          () => ({ requestId, explanationLength: sentence.length }),
        );
      })
      .catch(settleWithout);
  }

  onGatewayEvent("clarify", (data     ) => {
    emitDebug(
      "glasses.lifecycle",
      "clarify_requested",
      "info",
      {
        sessionKey:
          data && data.sessionKey
            ? data.sessionKey
            : sessionService.ensureSessionKey(),
      },
      () => ({
        clarifyId: data && data.id ? data.id : null,
        optionCount: data && Array.isArray(data.choices) ? data.choices.length : 0,
      }),
    );
    onClarify(data);
  });

  onGatewayEvent("question", (data     ) => {
    emitDebug(
      "glasses.lifecycle",
      "question_requested",
      "info",
      {
        sessionKey:
          data && data.sessionKey
            ? data.sessionKey
            : sessionService.ensureSessionKey(),
      },
      () => ({
        questionId: data && data.id ? data.id : null,
        questionCount: data && Array.isArray(data.questions) ? data.questions.length : 0,
      }),
    );
    onQuestion(data);
  });

  onGatewayEvent("questionResolved", (data     ) => {
    onQuestionResolved(data);
  });

  onGatewayEvent("error", (err) => {

    const cancelled = !!err && err.aborted === true;
    if (cancelled) logger.info(`[relay] Upstream run cancelled: ${err.message}`);
    else logger.error(`[relay] Upstream error: ${err.message}`);
    emitDebug(
      "relay.transport",
      cancelled ? "upstream_run_cancelled" : "upstream_error",
      cancelled ? "info" : "error",
      { sessionKey: sessionService.ensureSessionKey() },
      () => ({ message: err.message || null }),
    );
  });

  onGatewayEvent("connectFailed", (info) => {

    emitDebug(
      "relay.transport",
      "connect_failed",
      "warn",
      { sessionKey: sessionService.ensureSessionKey() },
      () => ({

        reason: info && info.reason ? sanitizeConnectReason(info.reason) : null,
        minProtocol: info && info.minProtocol != null ? info.minProtocol : null,
        maxProtocol: info && info.maxProtocol != null ? info.maxProtocol : null,
      }),
    );
  });

  return {
    clearTyping,
    compactActiveSession: (sessionKey) =>
      sessionContextService.compactActiveSession(sessionKey),
    getAgentName,
    getAgentEmoji,
    getAgentAvatarDataUri,
    getAgentAvatarHash,
    getAgentBootstrapPending,
    getAgentAvatarDataUriByHash,
    getModelsCatalogSnapshot,
    getHostModelInput,
    setSimulatedModelCatalog,
    getAgentsCatalogSnapshot,
    refreshAgentsCatalog,
    getAgentDisplayName,
    getAgentPrimaryModel,
    agentHasOwnModel,
    getProviderUsageSnapshot,
    getSkillsCatalogSnapshot,
    invalidateSkillsCatalog,
    getCommandCatalogSnapshot,
    refreshCommandCatalog,
    handleCurrentSessionModelConfigChanged,
    handleCurrentSessionModelConfigCleared,
    handleSessionChanged,
    refreshSessionContext,
    refreshSessionAttention,
    getActivityReplay,
    getActivityPlanReplay,
    getWaitingReplay,
    getWaitingExplanationReplay,
    publishWaiting,
    ingestActivityFrame,
    ingestSimulatedGatewayEvent,

    ingestRunSignal: (data     ) => ingestRunSignal(normalizeGatewaySessionEvent(data)),
    ingestMirroredRows,
    rehydrateHistory,
    isConnected,
    liveUiV2Surfaces,
    liveUiV2Sender,
    liveUiV2State,
    takeLiveUiV2FenceFragments,

    noteLiveUiV2StateReport,
    noteLiveUiV2Outcome,
    collectLiveUiV2State,
    isLiveUiV2TapOwed,

    liveUiV2PatchTarget: (sessionKey     ) => liveUiV2Surfaces.patchTarget(liveUiV2Key(sessionKey)),

    noteLiveUiV2Stop(sessionKey     ) {
      if (!isLiveUiV2Session(sessionKey)) return;
      const key = liveUiV2Key(sessionKey);
      const runIds = [...upstreamRunPipeline.values()]
        .filter((entry     ) => entry && entry.runId && entry.sessionKey && liveUiV2Key(entry.sessionKey) === key)
        .map((entry     ) => entry.runId);
      liveUiV2Step("stop", key, () => liveUiV2Surfaces.noteStopped(key, runIds));
    },
    composeLiveUiV2Records,

    writeLiveUiV2Data,
    prefetchLiveUiV2Picture,
    setLiveUiV2Inputs,
    isLiveUiV2SurfaceLive,
    liveUiV2TopSurface,
    openLiveUiV2Records,
    withdrawLiveUiV2Surface,

    handleLiveUiPictureWant(clientId     , sessionKey     , msg     ) {
      if (!liveUiPictures) return;
      liveUiV2Step("picture_want", sessionKey, () => liveUiPictures.want(clientId, liveUiV2Key(sessionKey), msg));
    },

    handleLiveUiVideoWant(clientId     , sessionKey     , msg     ) {
      if (!liveUiPictures) return;
      liveUiV2Step("video_want", sessionKey, () => liveUiPictures.videoWant(clientId, liveUiV2Key(sessionKey), msg));
    },
    noteLiveUiPictureClientGone(clientId     ) {
      if (liveUiPictures) liveUiPictures.noteClientGone(clientId);
    },

    openProgramCardPictures,
    closeProgramCardPictures(clientId     , sub     ) {
      const surfaceId = typeof sub === "string" && sub ? programCardPictureSurfaceId(sub) : "";
      const entry = surfaceId ? programCardPictureSurfaces.get(surfaceId) : null;

      if (!entry || entry.clientId !== clientId) return;
      closeProgramCardPictureSurface(surfaceId, "closed");
    },

    programCardPictureSessionOf(surfaceId     , clientId     ) {
      const entry = typeof surfaceId === "string" ? programCardPictureSurfaces.get(surfaceId) : null;
      return entry && entry.clientId === clientId ? entry.sessionKey : null;
    },

    handleProgramCardPictureWant(clientId     , want     ) {
      const surfaceId = want && typeof want.surfaceId === "string" ? want.surfaceId : "";
      const entry = programCardPictureSurfaces.get(surfaceId);
      if (!entry || entry.clientId !== clientId) {
        liveUiV2Trace("program_card_picture_want_ignored", { surfaceId, reason: "unknown_surface" });
        return;
      }
      const ids           = Array.isArray(want.ids) ? want.ids.filter((id     ) => typeof id === "string") : [];
      const large = want.large === true;
      for (const id of ids) {
        const code = entry.refused.get(id);
        if (code) sendProgramCardPictureFailed(clientId, surfaceId, id, code, large);
      }
      const rest = ids.filter((id) => !entry.refused.has(id));
      if (!liveUiPictures || rest.length === 0) return;
      liveUiV2Step("card_picture_want", entry.key, () => liveUiPictures.want(clientId, entry.key, { ...want, ids: rest }));
    },

    noteProgramCardPicturesClientGone(clientId     ) {
      for (const [surfaceId, entry] of [...programCardPictureSurfaces.entries()]) {
        if (entry.clientId === clientId) closeProgramCardPictureSurface(surfaceId, "client_gone");
      }
    },
    liveUiPictureStats: () => (liveUiPictures ? liveUiPictures.stats() : null),

    replayLiveUiV2Session: (sessionKey     , reason     ) =>
      liveUiV2Sender.replaySession(liveUiV2Key(sessionKey), reason || null),
    start() {
      return refreshUpstreamBootstrap("runtime_start");
    },
    stop() {
      clearStreamingThrottleTimer();
      clearBootstrapRefreshTimer();
      clearLedgerCommitFallbackTimer();
      bootstrapRefreshNonce += 1;
      pendingStreaming = null;
      activeTyping = null;
      clearThinkingRunState();
      inFlightModelsCatalogFetch = null;
      inFlightSkillsCatalogFetch = null;
      inFlightCommandCatalogFetch = null;
      inFlightAgentsCatalogFetch = null;
      upstreamRunPipeline.clear();
      toolProgressBubbles.clear();
    },
    synthesizeResponseStarted,
    trackAcceptedRun,

    prefetchLiveUiVideo(text        ) {
      return liveUiVideo ? liveUiVideo.prefetch(text) : 0;
    },

    async serveLiveUiAudio(envelope     ) {
      if (!liveUiVideo) return { statusCode: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from("not found") };
      const url = new URL(envelope && typeof envelope.url === "string" ? envelope.url : "/", "http://127.0.0.1");
      const headers = (envelope && envelope.headers) || {};
      return liveUiVideo.audioRange(url.searchParams.get("k"), headers.range);
    },

    async serveLiveUiSubtitles(envelope     ) {
      const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "cache-control": "no-store" };
      const method = typeof envelope?.method === "string" ? envelope.method.toUpperCase() : "GET";
      if (method === "OPTIONS") return { statusCode: 204, headers, body: Buffer.alloc(0) };
      if (method !== "GET") return { statusCode: 405, headers: { ...headers, allow: "GET, OPTIONS" }, body: Buffer.from("method not allowed") };
      const url = new URL(typeof envelope?.url === "string" ? envelope.url : "/", "http://127.0.0.1");
      if (url.pathname !== LIVEUI_SUBTITLES_PATH || !liveUiVideo || typeof liveUiVideo.subtitles !== "function") {
        return { statusCode: 404, headers, body: Buffer.from("not found") };
      }
      return liveUiVideo.subtitles(url.searchParams.get("k"), url.searchParams.get("lang"), url.searchParams.get("from"), url.searchParams.get("kind"));
    },
  };

  function isProviderRateLimitedLifecycleError(activity) {
    return !!(
      activity &&
      activity.isError === true &&
      activity.code === "provider_rate_limited" &&
      typeof activity.origin === "string" &&
      activity.origin.trim().toLowerCase() === "lifecycle" &&
      typeof activity.phase === "string" &&
      activity.phase.trim().toLowerCase() === "error"
    );
  }

  function saysAccountUsageIsNotExhausted(activity                                       ) {
    return [activity.detail, activity.label].some(
      (text) => typeof text === "string" &&
        text.toLowerCase().includes("does not report an exhausted limit"),
    );
  }

  function emitTypingUpdate(state, runId, sessionKey, reason) {
    const server = getServer();
    if (
      !server ||
      !handler ||
      typeof handler.formatTyping !== "function" ||
      typeof runId !== "string" ||
      !runId.trim()
    ) {
      return false;
    }
    const resolvedSessionKey =
      typeof sessionKey === "string" && sessionKey.trim()
        ? sessionKey.trim()
        : sessionService.ensureSessionKey();
    server.broadcast(
      handler.formatTyping({
        state,
        runId: runId.trim(),
        sessionKey: resolvedSessionKey,
      }),
    );
    emitDebug(
      "app.timeline",
      "typing",
      "debug",
      { sessionKey: resolvedSessionKey, runId: runId.trim() },
      () => ({
        state,
        reason: reason || null,
      }),
    );
    return true;
  }

  function startTyping(runId, sessionKey, reason) {
    if (typeof runId !== "string" || !runId.trim()) {
      return false;
    }
    const normalizedRunId = runId.trim();
    const resolvedSessionKey =
      typeof sessionKey === "string" && sessionKey.trim()
        ? sessionKey.trim()
        : sessionService.ensureSessionKey();
    if (activeTyping && activeTyping.runId === normalizedRunId) {
      return false;
    }
    if (activeTyping) {
      clearTyping("superseded_by_new_run");
    }
    activeTyping = {
      runId: normalizedRunId,
      sessionKey: resolvedSessionKey,
    };
    return emitTypingUpdate("start", normalizedRunId, resolvedSessionKey, reason);
  }

  function stopTypingForRun(runId, reason) {
    if (
      !activeTyping ||
      typeof runId !== "string" ||
      !runId.trim() ||
      activeTyping.runId !== runId.trim()
    ) {
      return false;
    }
    const { runId: activeRunId, sessionKey } = activeTyping;
    activeTyping = null;
    return emitTypingUpdate("stop", activeRunId, sessionKey, reason);
  }

  function clearTyping(reason) {
    if (!activeTyping) {
      return false;
    }
    const { runId, sessionKey } = activeTyping;
    activeTyping = null;
    return emitTypingUpdate("stop", runId, sessionKey, reason || "clear_typing");
  }
}

module.exports = { STREAMING_REBROADCAST_THROTTLE_MS, isTerminalActivityBoundary, classifyRunOutcomeFrame, isCancelledRunFrame, quietCancelledRunClose, buildModelAliasIndex, resolveConfiguredDefaultModelRef, agentIdsWithOwnModel, mapConfiguredCatalogRows, mapHermesConfiguredCatalogRows, AGENT_DESCRIPTION_MAX_CHARS, normalizeAgentsCatalogRows, parseWorkspaceIdentityFallback, applyIdentityFallback, overlayRawAgentRowsWithFallback, createUpstreamRuntime };
