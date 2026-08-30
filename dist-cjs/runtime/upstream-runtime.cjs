const { createHash } = require("node:crypto");
const { buildRateLimitInfoFromSnapshot, selectProviderUsageSnapshot } = require("./provider-usage-select.cjs");
const { stripAllTaggedSpans } = require("../domain/tagged-span-strip.cjs");
const { parseTaggedSpans } = require("../domain/tagged-span-parser.cjs");
const { EMOJI_TAG_FAMILY_CONFIG } = require("../domain/neural-emoji-reactor-tag-config.cjs");
const { PACE_TAG_FAMILY_CONFIG } = require("../domain/neural-pace-modulator-tag-config.cjs");
const { applyMarkdownWithSpans } = require("../domain/streaming-span-markdown.cjs");
const { createSessionContextService } = require("./session-context-service.cjs");
const { DISTILLER_SESSION_PREFIX } = require("./session-title-distiller-helpers.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");
const { reasoningCeilingForModel } = require("./capability-snapshot.cjs");
const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { relaySessionKeyFor } = require("./openclaw-session-key.cjs");

const DEFAULT_MODEL_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-opus-4-6";
const POOL_OUTCOME_FRESHNESS_MS = 10 * 60 * 1000;
const TITLE_DISTILLER_RUN_ID_PREFIX = "ocuclaw-title-";
const TITLE_DISTILLER_SESSION_MARKER = ":title-distiller:";
const THINKING_FINALIZE_RETENTION_MS = 5 * 60 * 1000;
const LEDGER_COMMIT_HISTORY_GRACE_MS = 1_000;
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

function normalizeOriginAtMs(value) {
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

function isToolProgressCommit(data) {
  const kind =
    data && typeof data.messageKind === "string"
      ? data.messageKind.trim().toLowerCase()
      : "";
  return kind === "tool_progress";
}

const STREAMING_REBROADCAST_THROTTLE_MS = 33;

function normalizeStreamingToken(raw) {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function isTitleDistillerStreamingEvent(data) {
  const runId = normalizeStreamingToken(data && data.runId);
  if (runId && runId.startsWith(TITLE_DISTILLER_RUN_ID_PREFIX)) return true;
  const sessionKey = normalizeStreamingToken(data && data.sessionKey);
  return Boolean(
    sessionKey &&
      (sessionKey.startsWith(DISTILLER_SESSION_PREFIX) ||
        sessionKey.includes(TITLE_DISTILLER_SESSION_MARKER)),
  );
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

function normalizeProviderId(rawProvider) {
  const normalized = String(rawProvider || "").trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "opencode-zen") {
    return "opencode";
  }
  if (normalized === "qwen") {
    return "qwen-portal";
  }
  if (normalized === "kimi-code") {
    return "kimi-coding";
  }
  return normalized;
}

function parseModelRef(raw, defaultProvider) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const provider = normalizeProviderId(defaultProvider);
    if (!provider) return null;
    return { provider, model: trimmed };
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
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

function resolveModelRefFromString(raw, aliasIndex) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("/")) {
    const aliasMatch = aliasIndex.get(trimmed.toLowerCase());
    if (aliasMatch) {
      return aliasMatch;
    }
  }
  return parseModelRef(trimmed, DEFAULT_MODEL_PROVIDER);
}

function resolveConfiguredDefaultModelRef(config, aliasIndex) {
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
    const parsed = resolveModelRefFromString(rawModel, aliasIndex);
    if (parsed) {
      return parsed;
    }
  }
  return { provider: DEFAULT_MODEL_PROVIDER, model: DEFAULT_MODEL_ID };
}

function resolveConfiguredModelRefs(config) {
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

  addRef(resolveConfiguredDefaultModelRef(config || {}, aliasIndex));

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
    const parsed = resolveModelRefFromString(String(raw || ""), aliasIndex);
    addRef(parsed);
  }

  const imagePrimary =
    imageModelConfig &&
    typeof imageModelConfig === "object" &&
    typeof imageModelConfig.primary === "string"
      ? imageModelConfig.primary.trim()
      : "";
  if (imagePrimary) {
    const parsed = resolveModelRefFromString(imagePrimary, aliasIndex);
    addRef(parsed);
  }

  const imageFallbacks =
    imageModelConfig &&
    typeof imageModelConfig === "object" &&
    Array.isArray(imageModelConfig.fallbacks)
      ? imageModelConfig.fallbacks
      : [];
  for (const raw of imageFallbacks) {
    const parsed = resolveModelRefFromString(String(raw || ""), aliasIndex);
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
    const parsed = parseModelRef(String(rawKey || ""), DEFAULT_MODEL_PROVIDER);
    addRef(parsed);
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

function mapConfiguredCatalogRows(modelsCatalogRows, configSnapshot) {
  const byKey = new Map();
  const providers = new Set();
  for (const row of modelsCatalogRows) {
    byKey.set(modelRefKey(row.provider, row.id), row);
    providers.add(row.provider);
  }
  const catalogUnavailable = modelsCatalogRows.length === 0;
  const config = extractConfigObject(configSnapshot);
  const configuredRefs = resolveConfiguredModelRefs(config);
  const out = [];
  for (const ref of configuredRefs) {
    const key = modelRefKey(ref.provider, ref.model);
    const row = byKey.get(key);
    if (row) {
      out.push(row);
    } else if (catalogUnavailable || providers.has(ref.provider)) {
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
    out.push({ id, name, emoji, primaryModel });
  }
  return out;
}

const WORKSPACE_IDENTITY_FILENAME = "IDENTITY.md";

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
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  function normalizeGatewaySessionEvent(data) {
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
    const normalizeField = (field) => {
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

  function onGatewayEvent(eventName, listener) {
    return gatewayBridge.on(eventName, (data) =>
      listener(normalizeGatewaySessionEvent(data)),
    );
  }
  const broadcastPages =
    typeof opts.broadcastPages === "function" ? opts.broadcastPages : () => {};
  const broadcastStatus =
    typeof opts.broadcastStatus === "function" ? opts.broadcastStatus : () => {};
  const broadcastActivity =
    typeof opts.broadcastActivity === "function"
      ? opts.broadcastActivity
      : (activity) => activity;
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

  const onQuestion = typeof opts.onQuestion === "function" ? opts.onQuestion : () => false;
  const onQuestionResolved =

    typeof opts.onQuestionResolved === "function" ? opts.onQuestionResolved : () => false;
  const observeTaskToolUse =

    typeof opts.observeTaskToolUse === "function" ? opts.observeTaskToolUse : () => false;
  const observeTaskApproval =

    typeof opts.observeTaskApproval === "function" ? opts.observeTaskApproval : () => false;
  const taskApprovalRequests = new Map();
  const TASK_APPROVAL_REQUEST_MAX = 500;

  function rememberTaskApproval(data) {
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
      : 60000;

  let openclawConnected = false;

  let agentIdentity = { name: null, emoji: null, avatarDataUri: null, avatarHash: null };

  let cachedModelsCatalog = null;
  let cachedModelsCatalogFetchedAt = 0;
  let cachedModelsCatalogStale = true;

  let inFlightModelsCatalogFetch = null;

  let cachedSkillsCatalog = null;
  let cachedSkillsCatalogFetchedAt = 0;
  let cachedSkillsCatalogStale = true;

  let inFlightSkillsCatalogFetch = null;

  let cachedCommandCatalog = null;
  let cachedCommandCatalogFetchedAt = 0;
  let cachedCommandCatalogStale = true;

  let commandCatalogUnsupported = false;

  let inFlightCommandCatalogFetch = null;

  let cachedAgentsCatalog = null;
  let cachedAgentsCatalogFetchedAt = 0;
  let cachedAgentsCatalogStale = true;

  let cachedAgentsEnvelope = { defaultId: null, mainKey: null, scope: null };

  let agentsListUnsupported = false;

  let inFlightAgentsCatalogFetch = null;
  let cachedProviderUsageSummary = null;
  let cachedProviderUsageFetchedAt = 0;
  let cachedProviderUsageObservedAt = 0;
  let cachedProviderUsageStale = true;

  let inFlightProviderUsageFetch = null;
  const providerOutcomeState = new Map();
  const cachedAuthProfileCounts = new Map();
  const upstreamRunPipeline = new Map();
  const activeThinkingRuns = new Set();
  const finalizedThinkingRuns = new Map();
  const finalizedThinkingRunTimers = new Map();
  let streamingThrottleTimer = null;
  let pendingStreaming = null;

  let activeTyping = null;
  let bootstrapRefreshTimer = null;
  let ledgerCommitFallbackTimer = 0;
  let bootstrapRefreshNonce = 0;

  const workspaceIdentityFallbackCache = new Map();

  const inFlightWorkspaceIdentityFetches = new Map();

  let lastGatewayIdentity = null;

  let connectionGeneration = 0;

  let workspaceIdentityFilesUnsupported = false;

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

  function flushLedgerCommitFallback() {
    if (!ledgerCommitFallbackTimer) return;
    clearLedgerCommitFallbackTimer();
    broadcastPages();
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
      cachedSkillsCatalogStale = true;
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

  async function refreshActiveSessionIdentity(trigger, attempt = 0) {

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

      const parsedSpans = parseTaggedSpans(queuedStreaming.rawText, [
        EMOJI_TAG_FAMILY_CONFIG,
        PACE_TAG_FAMILY_CONFIG,
      ]);
      const { text, spansByFamily } = applyMarkdownWithSpans(
        {
          cleanText: parsedSpans.cleanText,
          spansByFamily: parsedSpans.spansByFamily,
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
  }

  function modelCatalogSnapshot(nowMs) {
    const currentNow = Number.isFinite(nowMs) ? nowMs : now();
    const hasCache = Array.isArray(cachedModelsCatalog);
    const ageMs = hasCache ? currentNow - cachedModelsCatalogFetchedAt : Infinity;
    const ttlExpired = ageMs >= modelsCacheTtlMs;
    return {
      models: hasCache ? cachedModelsCatalog : [],
      fetchedAtMs: hasCache ? cachedModelsCatalogFetchedAt : currentNow,
      stale: !hasCache || cachedModelsCatalogStale || ttlExpired,
    };
  }

  function cacheModelCatalog(models, fetchedAtMs, stale) {
    cachedModelsCatalog = Array.isArray(models) ? models : [];
    cachedModelsCatalogFetchedAt = Number.isFinite(fetchedAtMs)
      ? Math.floor(fetchedAtMs)
      : now();
    cachedModelsCatalogStale = !!stale;
    return modelCatalogSnapshot(cachedModelsCatalogFetchedAt);
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

  function cacheSkillsCatalog(skills, fetchedAtMs, stale) {
    cachedSkillsCatalog = Array.isArray(skills) ? skills : [];
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

  function providerUsageCacheState(nowMs) {
    const currentNow = Number.isFinite(nowMs) ? nowMs : now();
    const hasCache =
      cachedProviderUsageSummary &&
      typeof cachedProviderUsageSummary === "object" &&
      !Array.isArray(cachedProviderUsageSummary);
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
    if (inFlightProviderUsageFetch) {
      return inFlightProviderUsageFetch;
    }
    if (!openclawConnected) {
      return snapshot;
    }

    inFlightProviderUsageFetch = (async () => {
      const [usageResult, authStatusResult] = await Promise.allSettled([
        gatewayBridge.request("usage.status", {}),
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
    if (!force && !snapshot.stale) {
      return snapshot;
    }
    if (inFlightModelsCatalogFetch) {
      return inFlightModelsCatalogFetch;
    }
    if (!openclawConnected) {
      return snapshot;
    }

    inFlightModelsCatalogFetch = gatewayBridge
      .request("models.list", {})
      .then(async (result) => {
        const allModels = normalizeModelCatalogRows(result && result.models);
        const configSnapshot = await gatewayBridge.request("config.get", {});
        const models = mapConfiguredCatalogRows(allModels, configSnapshot);
        return cacheModelCatalog(models, Date.now(), false);
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
        return cacheModelCatalog([], now(), true);
      });

    return inFlightModelsCatalogFetch.finally(() => {
      inFlightModelsCatalogFetch = null;
    });
  }

  async function refreshSkillsCatalog(force) {
    const snapshot = skillsCatalogSnapshot();
    if (!force && !snapshot.stale) {
      return snapshot;
    }
    if (inFlightSkillsCatalogFetch) {
      return inFlightSkillsCatalogFetch;
    }
    if (!openclawConnected) {
      return snapshot;
    }

    inFlightSkillsCatalogFetch = gatewayBridge
      .request("skills.status", {})
      .then((result) => {
        const skills = normalizeSkillsCatalogRows(result && result.skills);
        const changed = !skillsCatalogRowsEqual(cachedSkillsCatalog, skills);
        const snapshot = cacheSkillsCatalog(skills, Date.now(), false);
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
      .catch((err) => {
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
        if (Array.isArray(cachedSkillsCatalog)) {
          cachedSkillsCatalogStale = true;
          return skillsCatalogSnapshot();
        }
        return cacheSkillsCatalog([], now(), true);
      });

    return inFlightSkillsCatalogFetch.finally(() => {
      inFlightSkillsCatalogFetch = null;
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

  async function getModelsCatalogSnapshot() {
    const snapshot = modelCatalogSnapshot();
    if (snapshot.stale && openclawConnected) {
      return refreshModelCatalog(true);
    }
    return snapshot;
  }

  async function getSkillsCatalogSnapshot() {
    const snapshot = skillsCatalogSnapshot();
    if (snapshot.stale && openclawConnected) {
      return refreshSkillsCatalog(true);
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

  async function getAgentsCatalogSnapshot() {
    const snapshot = agentsCatalogSnapshot();
    if (snapshot.stale && !agentsListUnsupported && openclawConnected) {
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

  function handleSessionChanged(trigger) {
    if (!openclawConnected) {
      cachedSkillsCatalogStale = true;
      cachedCommandCatalogStale = true;
      return;
    }
    refreshActiveSessionIdentity(trigger).catch((err) => {
      logger.warn(`[relay] Agent identity refresh failed after ${trigger}: ${err.message}`);
    });
    refreshSkillsCatalog(true).catch((err) => {
      logger.warn(`[relay] Skills catalog refresh failed after ${trigger}: ${err.message}`);
    });
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

  let cachedRunActiveSessionKey = null;

  const sessionContextService = createSessionContextService({
    gatewayBridge,
    stateDir: opts.stateDir,
    getActiveSessionKey: () => sessionService.ensureSessionKey() || null,
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
    getRunActive: () => !!cachedRunActiveSessionKey,
    nowMs: () => Date.now(),
    broadcast: (frame) => {
      const server = getServer();
      if (server) server.broadcast(JSON.stringify(frame));
    },
  });

  onGatewayEvent("history", (data) => {
    if (!sessionService.isCurrentSession(data.sessionKey)) return;
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
    const sanitizedMessages = Array.isArray(data.messages)
      ? data.messages.map((msg) =>
          msg && msg.role === "assistant"
            ? { ...msg, content: sanitizeAssistantContentBlocks(msg.content) }
            : msg,
        )
      : data.messages;
    conversationState.hydrate(sanitizedMessages, agentIdentity.name, data.sessionKey);
    broadcastPages();
  });

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

  function sanitizeAssistantContentBlocks(content) {
    if (typeof content === "string") {
      return stripAllTaggedSpans(content);
    }
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        return { ...block, text: stripAllTaggedSpans(block.text) };
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
      broadcastPages();

      broadcastStreamClear(runId, data.sessionKey, "narration_retagged");
    }
  }

  onGatewayEvent("message.retag", handleNarrationRetag);

  onGatewayEvent("message", (data) => {
    if (!sessionService.isCurrentSession(data.sessionKey)) return;
    if (data && data.retag === true) {
      handleNarrationRetag(data);
      return;
    }
    const runId = data.runId || null;

    const turnActive = data.turnActive === true;
    const dropToolProgressPage =
      typeof data.messageKind === "string" &&
      data.messageKind.trim().toLowerCase() === "tool_progress";
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
    if (runId && turnActive) {
      clearStreamingThrottleTimer();
      flushPendingStreamingText();
    }
    if (runId && !turnActive) {

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

      broadcastActivity({
        state: "idle",
        runId,
        sessionKey: data.sessionKey || sessionService.ensureSessionKey(),
        origin: "lifecycle",
        phase: "end",
        category: "run_complete_synth",
        activityId: `run-complete-synth-${runId}`,
      });
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
        ? sanitizeAssistantContentBlocks(data.content)
        : data.content;
    const messageMetadata = {
      id: data.id ?? data.messageId,
      runId: data.runId,
      clientSendId: data.clientSendId ?? data.sendId,
      rev: data.rev,
    };
    if (dropNarrationPage) {

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
      conversationState.addMessage(data.role, sanitizedContent, null, messageMetadata);
    }
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
            .map((page) => (page && typeof page.content === "string" ? page.content : ""))
            .join("\n\n")
            .split("\n\n")
            .slice(-12)
            .map((line) => line.slice(0, 44)),
        }),
      );
    }
    const preservedLedgerLane = broadcastPages({ preserveLedgerLane: data.role === "assistant" });
    if (data.role === "assistant" && preservedLedgerLane) {
      clearLedgerCommitFallbackTimer();
      ledgerCommitFallbackTimer = setTimeout(() => {
        ledgerCommitFallbackTimer = 0;

        broadcastPages();
      }, LEDGER_COMMIT_HISTORY_GRACE_MS);
    }

    sessionContextService.refreshActiveSessionContext().catch(() => {});

    const voiceRuntime = getVoiceRuntime();
    if (voiceRuntime && typeof voiceRuntime.onAgentMessage === "function") {
      voiceRuntime.onAgentMessage();
    }
  });

  function ingestActivityFrame(data) {
    data = normalizeGatewaySessionEvent(data);
    const taskSessionKey =
      data && typeof data._activeRunSessionKey === "string" && data._activeRunSessionKey.trim()
        ? data._activeRunSessionKey
        : data && data.sessionKey;
    if (data && typeof data.tool === "string") {
      observeTaskToolUse({ sessionKey: taskSessionKey, toolName: data.tool });
    }
    if (!sessionService.isCurrentSession(data.sessionKey)) return;
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

      if (!activeProviderContext().provider) {
        sessionService.getCurrentSessionModelConfig().catch((err) => {
          logger.warn(
            `[relay] Provider re-resolve after run-end failed: ${err && err.message ? err.message : err}`,
          );
        });
      }
    }
    let activity = data;
    let shouldRefreshProviderUsageInBackground = false;
    if (isProviderRateLimitedLifecycleError(data)) {
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
    broadcastActivity(activity);
    if (shouldRefreshProviderUsageInBackground) {
      refreshProviderUsage(true).catch((err) => {
        logger.warn(`[relay] Provider usage refresh failed after rate limit activity: ${err.message}`);
      });
    }
    if (runId && data.state === "idle" && data.isError === true && phase === "error") {
      upstreamRunPipeline.delete(runId);

      if (cachedRunActiveSessionKey) {
        cachedRunActiveSessionKey = null;
        sessionContextService.broadcastRunActive(false);
        sessionContextService.refreshActiveSessionContext().catch(() => {});
      }
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
    const finalizedReason = finalizedThinkingRuns.get(normalizedRunId);
    const canHardenSoftFinalize =
      finalizedReason === "response_started" && frame.reason !== "response_started";
    if (!activeThinkingRuns.has(normalizedRunId) && !canHardenSoftFinalize) {
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
    finalizedThinkingRuns.clear();
    for (const timer of finalizedThinkingRunTimers.values()) {
      clearTimeout(timer);
    }
    finalizedThinkingRunTimers.clear();
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

    if (isToolProgressCommit(data)) {
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
        broadcastThinkingUpdate({
          runId,
          sessionKey,
          text: typeof data.text === "string" ? data.text : "",
          delta: typeof data.text === "string" ? data.text : "",
          presentation: "progress_note",
          progressNoteId:
            typeof data.messageId === "string" ? data.messageId : undefined,
          source: "hermes.narration",
        });
      }
      emitDebug(
        "openclaw.message",
        "narration_stream_withheld",
        "info",
        { sessionKey, runId },
        () => ({
          notes,
          textChars: typeof data.text === "string" ? data.text.length : 0,
        }),
      );
      return;
    }
    const prefix = `${agentIdentity.name || "Agent"}: `;

    pendingStreaming = {
      rawText: data.text,
      prefix,
      sessionKey,
      runId,
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
    const server = getServer();
    if (server) {
      server.broadcast(handler.formatApproval(data));
    }
  });

  onGatewayEvent("approvalResolved", (data) => {
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

  onGatewayEvent("clarify", (data) => {
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

  onGatewayEvent("question", (data) => {
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

  onGatewayEvent("questionResolved", (data) => {
    onQuestionResolved(data);
  });

  onGatewayEvent("error", (err) => {
    logger.error(`[relay] Upstream error: ${err.message}`);
    emitDebug(
      "relay.transport",
      "upstream_error",
      "error",
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
        reason: info && info.reason ? info.reason : null,
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
    getAgentAvatarDataUriByHash,
    getModelsCatalogSnapshot,
    getAgentsCatalogSnapshot,
    getAgentDisplayName,
    getProviderUsageSnapshot,
    getSkillsCatalogSnapshot,
    getCommandCatalogSnapshot,
    refreshCommandCatalog,
    handleCurrentSessionModelConfigChanged,
    handleCurrentSessionModelConfigCleared,
    handleSessionChanged,
    ingestActivityFrame,
    isConnected,
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
    },
    synthesizeResponseStarted,
    trackAcceptedRun,
  };

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

module.exports = { createUpstreamRuntime, STREAMING_REBROADCAST_THROTTLE_MS, normalizeAgentsCatalogRows, parseWorkspaceIdentityFallback, applyIdentityFallback, overlayRawAgentRowsWithFallback };
